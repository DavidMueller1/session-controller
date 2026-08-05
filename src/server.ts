import fs from "node:fs";
import path from "node:path";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { CONFIG } from "./config.js";
import { Engine } from "./engine.js";
import { openAircraft } from "./open.js";
import { startStatusPolling } from "./status.js";
import { Store } from "./store.js";
import type { ActivityState, AnthropicStatus, DiscoveredSession } from "./types.js";

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

  const decorate = (list: DiscoveredSession[]): DiscoveredSession[] =>
    list.map((a) => {
      const isLanded = landed.has(a.id);
      // Approach = a merged PR, unless landed. A working session wins the lane on the
      // client (working → In-flight), so a merged-but-active session shows In-flight.
      const approach = !isLanded && a.pr?.state === "MERGED";
      return { ...a, note: notes[a.id] ?? null, landed: isLanded, approach };
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
  const fullList = (): DiscoveredSession[] => decorate([...engine.aircraft(), ...offlineSessions()]);

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
