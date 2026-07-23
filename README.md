# Traffic Controller

An air-traffic-control style tracker for the features you build in parallel with Claude.
Each feature is an "aircraft"; each Claude session working on it is tracked automatically —
whether it runs in the **PHPStorm terminal (Claude Code CLI)** or the **Claude Desktop app
(Cowork / local agent mode)**.

See [CONCEPT.md](CONCEPT.md) for the full design and the locked decisions.

## Status

- **Phase 1 — watcher spike ✅** — discovers every live session from both sources, derives
  status, dedupes into one aircraft each. Console board.
- **Phase 2 — store + API ✅** — a shared `Engine` feeds a SQLite store and a Fastify REST +
  WebSocket server that pushes live updates.

### What's tracked

- **CLI sessions** — read from `~/.claude/projects/**/*.jsonl` (branch + cwd come straight
  from the transcript).
- **Desktop sessions** — read from
  `~/Library/Application Support/Claude/{local-agent-mode,claude-code}-sessions/**/local_*.json`.
- Read-only: the app never writes to Claude's files.
- Activity state (Layer A of the concept) is derived per session and is **never terminal** —
  a stale session goes `COLD`, never "finished". Landing stays a human decision (Phase 6).
- **Deduped into one aircraft each**: a desktop session and its underlying CLI transcript
  (linked by `cliSessionId`) merge into one `TERM+DT` aircraft, and `agent-*.jsonl` subagent
  sidechains collapse into their parent session. See [src/correlate.ts](src/correlate.ts).

### API (Phase 2)

Runs on `http://127.0.0.1:4317` (override with `PORT` / `HOST`).

| Endpoint | Description |
|---|---|
| `GET /api/health` | liveness + aircraft/client counts |
| `GET /api/aircraft` | full aircraft list (live, deduped) |
| `GET /api/aircraft/:id` | one aircraft (404 if unknown) |
| `GET /api/summary` | totals grouped by state |
| `WS /ws` | `snapshot` on connect, then `update` messages on every change |

State is persisted to SQLite at `data/traffic-controller.db` (gitignored) on every change.

### States

| Board label | Meaning |
|---|---|
| `IN-FLIGHT` | working now |
| `HOLDING` | recently ended a turn — likely waiting on you (refined by hooks in Phase 5) |
| `TAXIING` | idle (recent but paused) |
| `COLD` | dormant — no activity for a while (overnight-safe, **not** finished) |
| `APPROACH?` | system suspects it wrapped up (desktop archived) — awaiting your confirmation |
| `GO-AROUND` | last event was an error |

## Run

```bash
nvm use          # Node 22
pnpm install

pnpm serve       # start the REST + WebSocket API (also: pnpm start / pnpm dev)
pnpm board       # live console board (Ctrl-C to stop)
pnpm once        # one-shot console scan + print, then exit
pnpm typecheck
```

## Layout

```
src/
  config.ts       source paths, timing thresholds, API port, db path
  types.ts        SessionFacts, DiscoveredSession, ActivityState
  parseCli.ts     JSONL transcript → SessionFacts
  parseDesktop.ts desktop metadata json → SessionFacts
  deriveState.ts  facts + now → resolved state (pure, no I/O)
  correlate.ts    dedupe/merge sessions into one aircraft each
  engine.ts       watch + scan + fast tick; emits `update(aircraft)`
  store.ts        SQLite persistence (better-sqlite3)
  server.ts       Fastify REST + WebSocket API  ← entry
  console-app.ts  live console board            ← entry
  render.ts       console board rendering (ANSI, no deps)
  util.ts         small formatting helpers
```

## Next (Phase 3)

Vue web UI (flight-strip board) consuming the WebSocket. See CONCEPT.md §10.
