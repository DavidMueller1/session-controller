import fs from "node:fs";
import path from "node:path";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { CONFIG } from "./config.js";
import { Engine } from "./engine.js";
import { openAircraft } from "./open.js";
import { Store } from "./store.js";
import type { DiscoveredSession } from "./types.js";

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
  let cleared = store.getClearedPrs();
  const decorate = (list: DiscoveredSession[]): DiscoveredSession[] =>
    list.map((a) => {
      const isLanded = landed.has(a.id);
      // Approach = a merged PR the user hasn't go-around'd. Purely PR-driven; go-around
      // clears the merge so a same-session follow-up doesn't get flagged. Landed wins.
      const approach = !isLanded && a.pr?.state === "MERGED" && !cleared.has(`${a.id}:${a.pr.number}`);
      return { ...a, note: notes[a.id] ?? null, landed: isLanded, approach };
    });

  const clients = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const c of clients) {
      if (c.readyState === 1) c.send(data);
    }
  };
  const pushUpdate = () => broadcast({ type: "update", ts: Date.now(), aircraft: decorate(engine.aircraft()) });

  // engine → persist sessions + push decorated update
  engine.on("update", (list: DiscoveredSession[]) => {
    store.syncSessions(list);
    broadcast({ type: "update", ts: Date.now(), aircraft: decorate(list) });
    const summary = Object.entries(counts(list))
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ");
    process.stdout.write(`[${new Date().toLocaleTimeString()}] ${list.length} aircraft · ${summary} → ${clients.size} client(s)\n`);
  });

  // REST
  app.get("/api/health", async () => ({
    ok: true,
    aircraft: engine.aircraft().length,
    clients: clients.size,
    uptimeSec: Math.round(process.uptime()),
  }));

  app.get("/api/aircraft", async () => decorate(engine.aircraft()));

  app.get<{ Params: { id: string } }>("/api/aircraft/:id", async (req, reply) => {
    const hit = decorate(engine.aircraft()).find((a) => a.id === req.params.id);
    if (!hit) return reply.code(404).send({ error: "not found" });
    return hit;
  });

  app.get("/api/summary", async () => {
    const list = engine.aircraft();
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

  // go-around: ignore this session's currently-merged PR for Approach (a follow-up is
  // coming in the same session). The next different merged PR re-flags Approach.
  app.post<{ Params: { id: string } }>("/api/aircraft/:id/go-around", async (req, reply) => {
    const a = engine.aircraft().find((x) => x.id === req.params.id);
    if (!a?.pr || a.pr.state !== "MERGED") return reply.code(400).send({ error: "no merged PR to clear" });
    store.clearPr(a.id, a.pr.number);
    cleared = store.getClearedPrs();
    pushUpdate();
    return { ok: true, id: a.id, clearedPr: a.pr.number };
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
    socket.send(JSON.stringify({ type: "snapshot", ts: Date.now(), aircraft: decorate(engine.aircraft()) }));
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
