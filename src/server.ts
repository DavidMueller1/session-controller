import fs from "node:fs";
import path from "node:path";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { CONFIG } from "./config.js";
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
  // per-repo config (keyed by shared git dir) — currently just the dev URL template
  let projectConfig = store.getProjectConfigs();
  // dev servers detected running in each strip's folder (id → info), refreshed on a timer
  let devByAircraft = new Map<string, DevServerInfo>();

  const decorate = (list: DiscoveredSession[]): DiscoveredSession[] =>
    list.map((a) => {
      const isLanded = landed.has(a.id);
      // Approach = a merged PR, unless landed. A working session wins the lane on the
      // client (working → In-flight), so a merged-but-active session shows In-flight.
      const approach = !isLanded && a.pr?.state === "MERGED";
      // attach the detected dev server, resolving its per-repo URL template from config
      const ds = devByAircraft.get(a.id);
      const devServer = ds ? { ...ds, urlTemplate: projectConfig[ds.repoKey]?.urlTemplate || null } : null;
      return { ...a, note: notes[a.id] ?? null, landed: isLanded, approach, devServer };
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
    let map: Map<string, DevServerInfo>;
    try {
      map = await devScanner.scan(baseList());
    } catch {
      return; // lsof/git hiccup — keep the last known mapping
    } finally {
      devScanning = false;
    }
    const sig = [...map.entries()]
      .map(([id, d]) => `${id}:${d.port}:${d.candidates.map((c) => c.port).join(",")}`)
      .sort()
      .join("|");
    if (sig === devSig) return;
    devSig = sig;
    devByAircraft = map;
    pushUpdate();
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
    const repos = new Map<string, { key: string; name: string; urlTemplate: string }>();
    await Promise.all(
      projects.map(async (p) => {
        const r = await devScanner.resolveRepo(p);
        if (r && !repos.has(r.key)) repos.set(r.key, { key: r.key, name: r.name, urlTemplate: projectConfig[r.key]?.urlTemplate ?? "" });
      }),
    );
    return [...repos.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  // set (or clear) a repo's dev URL template; links refresh live via pushUpdate
  app.put<{ Body: { key?: string; name?: string; urlTemplate?: string } }>("/api/repos", async (req, reply) => {
    const key = (req.body?.key ?? "").trim();
    if (!key) return reply.code(400).send({ error: "key required" });
    const tmpl = (req.body?.urlTemplate ?? "").trim();
    if (tmpl) store.setProjectConfig(key, req.body?.name ?? null, tmpl);
    else store.deleteProjectConfig(key);
    projectConfig = store.getProjectConfigs();
    pushUpdate();
    return { ok: true, key, urlTemplate: tmpl };
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
