import fs from "node:fs";
import path from "node:path";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { CONFIG } from "./config.js";
import { DevRunner } from "./devRunner.js";
import { DevServerScanner } from "./devServers.js";
import { Engine } from "./engine.js";
import { type HookSettings, assembleHealth, readHookSettings } from "./hooksHealth.js";
import { openAircraft } from "./open.js";
import { startStatusPolling } from "./status.js";
import { Store } from "./store.js";
import type { ActivityState, AnthropicStatus, DevServerInfo, DiscoveredSession, HooksHealth } from "./types.js";

/** the ws socket type, sourced from @fastify/websocket to avoid importing ws directly */
type WebSocket = import("@fastify/websocket").WebSocket;

function counts(list: DiscoveredSession[]): Record<string, number> {
  return list.reduce<Record<string, number>>((acc, s) => {
    acc[s.state] = (acc[s.state] ?? 0) + 1;
    return acc;
  }, {});
}

async function main(): Promise<void> {
  const engine = new Engine();
  const store = new Store(CONFIG.dbPath);
  const app = Fastify({ logger: false });
  await app.register(websocket);

  let notes = store.getNotes();
  let landed = new Set(store.getLanded());
  // per-repo config (keyed by shared git dir) — dev URL template + start command
  let projectConfig = store.getProjectConfigs();
  // dev servers detected running in each strip's folder (id → info), refreshed on a timer
  let devByAircraft = new Map<string, DevServerInfo>();
  // per-strip worktree root + repo key, resolved on the dev-scan tick (for managed servers)
  let rootByAircraft = new Map<string, string>();
  let repoKeyByAircraft = new Map<string, string>();

  // manages tower-started dev servers (keyed by worktree root); re-adopt any still alive
  const devRunner = new DevRunner(store, path.dirname(CONFIG.dbPath));
  devRunner.adopt();

  const decorate = (list: DiscoveredSession[]): DiscoveredSession[] =>
    list.map((a) => {
      const isLanded = landed.has(a.id);
      // Approach = a merged PR, unless landed. A working session wins the lane on the
      // client (working → In-flight), so a merged-but-active session shows In-flight.
      const approach = !isLanded && a.pr?.state === "MERGED";
      const root = rootByAircraft.get(a.id) ?? null;
      const managed = root ? devRunner.managedFor(root) : null;
      // attach the detected dev server, resolving its per-repo URL template + managed flag
      const ds = devByAircraft.get(a.id);
      const devServer = ds ? { ...ds, urlTemplate: projectConfig[ds.repoKey]?.urlTemplate || null, managed: !!managed } : null;
      const repoKey = repoKeyByAircraft.get(a.id);
      const devCommand = repoKey ? projectConfig[repoKey]?.command || null : null;
      const devManaged = managed ? { pid: managed.pid, startedAt: managed.startedAt } : null;
      // a recent crash (within 10 min), only while not currently running
      const exit = root ? devRunner.exitFor(root) : null;
      const devExit = !managed && exit && Date.now() - exit.at < 10 * 60_000 ? exit : null;
      // install affordance for any repo strip; carries running + last-exit state
      const devInstall = root ? (devRunner.installStateFor(root) ?? { running: false, code: null, at: 0 }) : null;
      return { ...a, note: notes[a.id] ?? null, landed: isLanded, approach, devServer, devCommand, devManaged, devExit, devInstall };
    });

  // Persistence: a tracked session with no live file right now is still shown from the
  // store, floored to MIA (idle) so nothing you tracked disappears across restarts /
  // vanished files.
  const floorOffline = (s: ActivityState): ActivityState =>
    s === "working" || s === "needs-input" || s === "unknown" ? "idle" : s;
  function offlineSessions(): DiscoveredSession[] {
    const live = new Set(engine.aircraft().map((a) => a.id));
    return store
      .getSessions()
      .filter((s) => !live.has(s.id))
      .map((s) => ({ ...s, state: floorOffline(s.state), offline: true }));
  }
  const baseList = (): DiscoveredSession[] => [...engine.aircraft(), ...offlineSessions()];
  const fullList = (): DiscoveredSession[] => decorate(baseList());

  const clients = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const c of clients) {
      if (c.readyState === 1) c.send(data);
    }
  };
  const pushUpdate = () => broadcast({ type: "update", ts: Date.now(), aircraft: fullList() });

  // Claude/Anthropic service status → top banner
  let anthropicStatus: AnthropicStatus | null = null;
  const stopStatus = startStatusPolling((s) => {
    anthropicStatus = s;
    broadcast({ type: "status", ts: Date.now(), status: s });
  });

  // Hooks-health → second top banner. Settings integrity is read on a slow timer (a
  // Claude update can rewrite settings.json and silently uninstall our hooks); the live
  // write-freshness / fallback counts are recomputed on every board update.
  let hookSettings: HookSettings = readHookSettings();
  let hooksHealth: HooksHealth = assembleHealth(hookSettings, engine.aircraft(), engine.hookStats());
  let hooksHealthSig = "";
  const refreshHealth = (): void => {
    hooksHealth = assembleHealth(hookSettings, engine.aircraft(), engine.hookStats());
    const sig = `${hooksHealth.status}|${hooksHealth.detail}`;
    if (sig === hooksHealthSig) return;
    hooksHealthSig = sig;
    broadcast({ type: "health", ts: Date.now(), health: hooksHealth });
  };
  const healthTimer = setInterval(() => {
    hookSettings = readHookSettings(); // catch settings.json being rewritten
    refreshHealth();
  }, 30_000);

  // Dev-server detection: scan the user's listening ports on a timer, attribute each to
  // the strip whose folder owns it, and push an update only when the mapping changes.
  const devScanner = new DevServerScanner();
  let devSig = "";
  let devScanning = false;
  const refreshDevServers = async (): Promise<void> => {
    if (devScanning) return; // a scan can outlast the 3s tick — don't pile them up
    devScanning = true;
    try {
      const list = baseList();
      const map = await devScanner.scan(list);
      // resolve each strip's worktree root + repo key (both cached) so decorate can attach
      // managed-server state and the configured command
      const rootMap = new Map<string, string>();
      const repoMap = new Map<string, string>();
      await Promise.all(
        list.map(async (a) => {
          if (!a.project) return;
          const [root, repo] = await Promise.all([devScanner.resolveRoot(a.project), devScanner.resolveRepo(a.project)]);
          if (root) rootMap.set(a.id, root);
          if (repo) repoMap.set(a.id, repo.key);
        }),
      );
      devRunner.reconcile(); // drop managed servers that exited on their own
      devByAircraft = map;
      rootByAircraft = rootMap;
      repoKeyByAircraft = repoMap;
      // push only when the observable dev state changed (detected ports OR managed pids)
      const detSig = [...map.entries()].map(([id, d]) => `${id}:${d.port}:${d.candidates.map((c) => c.port).join(",")}`).sort();
      const mgSig = [...rootMap.entries()]
        .map(([id, r]) => {
          const inst = devRunner.installStateFor(r);
          return `${id}:${devRunner.managedFor(r)?.pid ?? ""}:${devRunner.exitFor(r)?.at ?? ""}:${inst?.running ? 1 : 0}:${inst?.at ?? ""}`;
        })
        .sort();
      const sig = `${detSig.join("|")}||${mgSig.join("|")}`;
      if (sig !== devSig) {
        devSig = sig;
        pushUpdate();
      }
    } catch {
      /* lsof/git hiccup — keep the last known mapping */
    } finally {
      devScanning = false;
    }
  };
  void refreshDevServers();
  const devTimer = setInterval(() => void refreshDevServers(), CONFIG.devScanMs);

  // landed auto-clears when a session works again — it "starts back up" on its own.
  function autoUnlandOnWork(list: DiscoveredSession[]): void {
    let changed = false;
    for (const a of list) {
      if (a.state === "working" && landed.has(a.id)) {
        store.unsetLanded(a.id);
        changed = true;
      }
    }
    if (changed) landed = new Set(store.getLanded());
  }

  // engine → persist sessions + push decorated update
  engine.on("update", (list: DiscoveredSession[]) => {
    store.syncSessions(list);
    autoUnlandOnWork(list);
    broadcast({ type: "update", ts: Date.now(), aircraft: fullList() });
    refreshHealth();
    const summary = Object.entries(counts(list))
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ");
    process.stdout.write(`[${new Date().toLocaleTimeString()}] ${list.length} live · ${summary} → ${clients.size} client(s)\n`);
  });

  // REST
  app.get("/api/health", async () => ({
    ok: true,
    aircraft: fullList().length,
    clients: clients.size,
    uptimeSec: Math.round(process.uptime()),
  }));

  app.get("/api/aircraft", async () => fullList());

  app.get("/api/status", async () => anthropicStatus);

  app.get("/api/hooks-health", async () => hooksHealth);

  // compact count for the macOS menu-bar app: strips in Holding that are NOT parked
  // (needs-input/error, not landed/approach, no note) — i.e. the ones flashing for you.
  app.get("/api/badge", async () => {
    const holding = fullList().filter(
      (a) => (a.state === "needs-input" || a.state === "error") && !a.landed && !a.approach && !a.note,
    ).length;
    return { holding, ts: Date.now() };
  });

  app.get<{ Params: { id: string } }>("/api/aircraft/:id", async (req, reply) => {
    const hit = fullList().find((a) => a.id === req.params.id);
    if (!hit) return reply.code(404).send({ error: "not found" });
    return hit;
  });

  app.get("/api/summary", async () => {
    const list = fullList();
    return { total: list.length, byState: counts(list), ts: Date.now() };
  });

  // notes (user data) — add turns a "needs you" strip into "parked"
  app.put<{ Params: { id: string }; Body: { note?: string } }>("/api/aircraft/:id/note", async (req, reply) => {
    const note = (req.body?.note ?? "").trim();
    if (!note) return reply.code(400).send({ error: "note required" });
    store.setNote(req.params.id, note);
    notes = store.getNotes();
    pushUpdate();
    return { ok: true, id: req.params.id, note };
  });

  app.delete<{ Params: { id: string } }>("/api/aircraft/:id/note", async (req) => {
    store.deleteNote(req.params.id);
    notes = store.getNotes();
    pushUpdate();
    return { ok: true, id: req.params.id };
  });

  // landing (a human decision) — mark done / send back into the pattern (go-around)
  app.post<{ Params: { id: string } }>("/api/aircraft/:id/landed", async (req) => {
    store.setLanded(req.params.id);
    landed = new Set(store.getLanded());
    pushUpdate();
    return { ok: true, id: req.params.id, landed: true };
  });

  app.delete<{ Params: { id: string } }>("/api/aircraft/:id/landed", async (req) => {
    store.unsetLanded(req.params.id);
    landed = new Set(store.getLanded());
    pushUpdate();
    return { ok: true, id: req.params.id, landed: false };
  });

  // repos the tower has strips for, with their per-repo config — drives the Settings modal
  app.get("/api/repos", async () => {
    const projects = [...new Set(fullList().map((a) => a.project).filter((p): p is string => !!p))];
    const repos = new Map<string, { key: string; name: string; urlTemplate: string; command: string }>();
    await Promise.all(
      projects.map(async (p) => {
        const r = await devScanner.resolveRepo(p);
        if (r && !repos.has(r.key))
          repos.set(r.key, {
            key: r.key,
            name: r.name,
            urlTemplate: projectConfig[r.key]?.urlTemplate ?? "",
            command: projectConfig[r.key]?.command ?? "",
          });
      }),
    );
    return [...repos.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  // set (or clear) a repo's dev URL template + start command; refreshes live via pushUpdate
  app.put<{ Body: { key?: string; name?: string; urlTemplate?: string; command?: string } }>("/api/repos", async (req, reply) => {
    const key = (req.body?.key ?? "").trim();
    if (!key) return reply.code(400).send({ error: "key required" });
    const tmpl = (req.body?.urlTemplate ?? "").trim();
    const command = (req.body?.command ?? "").trim();
    if (tmpl || command) store.setProjectConfig(key, req.body?.name ?? null, tmpl, command);
    else store.deleteProjectConfig(key);
    projectConfig = store.getProjectConfigs();
    void refreshDevServers(); // command availability may have changed
    pushUpdate();
    return { ok: true, key, urlTemplate: tmpl, command };
  });

  // resolve a strip → its worktree root (where a managed server runs) + repo key
  const rootForAircraft = async (id: string): Promise<{ root: string; repoKey: string } | null> => {
    const a = baseList().find((x) => x.id === id);
    if (!a?.project) return null;
    const [root, repo] = await Promise.all([devScanner.resolveRoot(a.project), devScanner.resolveRepo(a.project)]);
    return root ? { root, repoKey: repo?.key ?? "" } : null;
  };

  // start the repo's configured dev server for this strip's worktree
  app.post<{ Params: { id: string } }>("/api/aircraft/:id/dev/start", async (req, reply) => {
    const info = await rootForAircraft(req.params.id);
    if (!info) return reply.code(404).send({ error: "not found or not a git repo" });
    const command = projectConfig[info.repoKey]?.command ?? "";
    if (!command.trim()) return reply.code(400).send({ error: "no dev command configured — set one in Settings" });
    const res = await devRunner.start(info.root, command);
    if ("error" in res) return reply.code(500).send(res);
    // A bad command (missing deps, wrong Node, typo) exits within a moment — its child
    // 'exit' clears it from the runner. Catch that here and return the log tail so the UI
    // can show WHY, instead of the start silently vanishing.
    await new Promise((r) => setTimeout(r, 1200));
    if (!devRunner.managedFor(info.root)) {
      const log = await devRunner.backlog(info.root, 8192);
      return reply.code(422).send({ error: "dev server exited on startup", log });
    }
    void refreshDevServers();
    return { ok: true, pid: res.pid };
  });

  // install dependencies for this strip's worktree (pnpm install, via the nvm-aware shell)
  app.post<{ Params: { id: string } }>("/api/aircraft/:id/dev/install", async (req, reply) => {
    const info = await rootForAircraft(req.params.id);
    if (!info) return reply.code(404).send({ error: "not found or not a git repo" });
    const res = await devRunner.install(info.root, "pnpm install");
    if ("error" in res) return reply.code(500).send(res);
    void refreshDevServers();
    return { ok: true };
  });

  // stop the tower-managed dev server for this strip's worktree
  app.post<{ Params: { id: string } }>("/api/aircraft/:id/dev/stop", async (req, reply) => {
    const info = await rootForAircraft(req.params.id);
    if (!info) return reply.code(404).send({ error: "not found" });
    const res = await devRunner.stop(info.root);
    void refreshDevServers();
    pushUpdate();
    return { ok: res.ok };
  });

  // recent log output (tail) for the panel's initial load. ?kind=install for install logs.
  app.get<{ Params: { id: string }; Querystring: { kind?: string } }>("/api/aircraft/:id/dev/logs", async (req, reply) => {
    const info = await rootForAircraft(req.params.id);
    if (!info) return reply.code(404).send({ error: "not found" });
    const kind = req.query.kind === "install" ? "install" : "server";
    return { log: await devRunner.backlog(info.root, 64 * 1024, kind) };
  });

  // live log stream (SSE) — appended lines only; the panel loads backlog via the GET above
  app.get<{ Params: { id: string }; Querystring: { kind?: string } }>("/api/aircraft/:id/dev/logs/stream", async (req, reply) => {
    const info = await rootForAircraft(req.params.id);
    if (!info) return reply.code(404).send({ error: "not found" });
    const kind = req.query.kind === "install" ? "install" : "server";
    const from = await devRunner.logSize(info.root, kind);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.write("retry: 2000\n\n");
    const stop = devRunner.stream(
      info.root,
      from,
      (text) => {
        for (const line of text.split("\n")) if (line.length) raw.write(`data: ${line.replace(/\r$/, "")}\n\n`);
      },
      kind,
    );
    const keepalive = setInterval(() => raw.write(": ping\n\n"), 20_000);
    req.raw.on("close", () => {
      clearInterval(keepalive);
      stop();
      try {
        raw.end();
      } catch {
        /* already closed */
      }
    });
  });

  // open/focus the session's host (PhpStorm project window, Claude app, or terminal)
  app.post<{ Params: { id: string } }>("/api/aircraft/:id/open", async (req, reply) => {
    const a = engine.aircraft().find((x) => x.id === req.params.id);
    if (!a) return reply.code(404).send({ error: "not found" });
    const reg = engine.registryEntry(a.id);
    const surfaces = a.surfaces ?? [a.source];
    try {
      const result = await openAircraft({
        entrypoint: reg?.entrypoint,
        pid: reg?.pid,
        cwd: a.project ?? reg?.cwd ?? null,
        desktopOnly: surfaces.includes("desktop") && !surfaces.includes("cli"),
      });
      return result;
    } catch (err) {
      return reply.code(500).send({ ok: false, error: String(err) });
    }
  });

  // WebSocket: snapshot on connect, then live updates
  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: "snapshot", ts: Date.now(), aircraft: fullList() }));
    socket.send(JSON.stringify({ type: "status", ts: Date.now(), status: anthropicStatus }));
    socket.send(JSON.stringify({ type: "health", ts: Date.now(), health: hooksHealth }));
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  // serve the built Vue app (if present) with SPA fallback
  const webDist = path.join(process.cwd(), "web", "dist");
  if (fs.existsSync(webDist)) {
    await app.register(staticPlugin, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  await engine.start();
  await app.listen({ port: CONFIG.apiPort, host: CONFIG.apiHost });
  const ui = fs.existsSync(webDist) ? `  UI    http://${CONFIG.apiHost}:${CONFIG.apiPort}/\n` : "  UI    run `pnpm --dir web dev` for the Vue board\n";
  process.stdout.write(
    `\n  ✈  Feature Controller on http://${CONFIG.apiHost}:${CONFIG.apiPort}\n` +
      ui +
      `  REST  /api/health  /api/aircraft  /api/aircraft/:id  /api/summary\n` +
      `  WS    /ws  (snapshot + live updates)\n\n`,
  );

  const shutdown = async () => {
    stopStatus();
    clearInterval(healthTimer);
    clearInterval(devTimer);
    await engine.stop();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("server failed:", err);
  process.exit(1);
});
