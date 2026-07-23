import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { CONFIG } from "./config.js";
import { Engine } from "./engine.js";
import { Store } from "./store.js";
import type { ActivityState, DiscoveredSession } from "./types.js";

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

  const clients = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const c of clients) {
      if (c.readyState === 1) c.send(data);
    }
  };

  // engine → persist + push
  engine.on("update", (list: DiscoveredSession[]) => {
    store.syncSessions(list);
    broadcast({ type: "update", ts: Date.now(), aircraft: list });
    const c = counts(list);
    const summary = Object.entries(c)
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ");
    const time = new Date().toLocaleTimeString();
    process.stdout.write(`[${time}] ${list.length} aircraft · ${summary} → ${clients.size} client(s)\n`);
  });

  // REST
  app.get("/api/health", async () => ({
    ok: true,
    aircraft: engine.aircraft().length,
    clients: clients.size,
    uptimeSec: Math.round(process.uptime()),
  }));

  app.get("/api/aircraft", async () => engine.aircraft());

  app.get<{ Params: { id: string } }>("/api/aircraft/:id", async (req, reply) => {
    const hit = engine.aircraft().find((a) => a.id === req.params.id);
    if (!hit) return reply.code(404).send({ error: "not found" });
    return hit;
  });

  app.get<{ Querystring: { state?: ActivityState } }>("/api/summary", async (req) => {
    const list = engine.aircraft();
    return { total: list.length, byState: counts(list), ts: Date.now() };
  });

  // WebSocket: snapshot on connect, then live updates
  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ type: "snapshot", ts: Date.now(), aircraft: engine.aircraft() }));
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  await engine.start();
  await app.listen({ port: CONFIG.apiPort, host: CONFIG.apiHost });
  process.stdout.write(
    `\n  ✈  Traffic Controller API on http://${CONFIG.apiHost}:${CONFIG.apiPort}\n` +
      `     REST  /api/health  /api/aircraft  /api/aircraft/:id  /api/summary\n` +
      `     WS    /ws  (snapshot + live updates)\n\n`,
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
