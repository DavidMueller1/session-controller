# Traffic Controller

An air-traffic-control style tracker for the features you build in parallel with Claude.
Each feature is an "aircraft"; each Claude session working on it is tracked automatically —
whether it runs in the **PHPStorm terminal (Claude Code CLI)** or the **Claude Desktop app
(Cowork / local agent mode)**.

See [CONCEPT.md](CONCEPT.md) for the full design and the locked decisions.

## Status: Phase 1 — watcher spike ✅

Proves the tracking works end-to-end, with zero UI. It discovers every live session from both
sources and prints a live status board to the console.

- **CLI sessions** — read from `~/.claude/projects/**/*.jsonl` (branch + cwd come straight
  from the transcript).
- **Desktop sessions** — read from
  `~/Library/Application Support/Claude/{local-agent-mode,claude-code}-sessions/**/local_*.json`.
- Read-only: the app never writes to Claude's files.
- Activity state (Layer A of the concept) is derived per session and is **never terminal** —
  a stale session goes `COLD`, never "finished". Landing stays a human decision (Phase 6).
- **Deduped into one aircraft each** (pulled forward from Phase 2): a desktop session and
  its underlying CLI transcript (linked by `cliSessionId`) merge into one `TERM+DT` row, and
  `agent-*.jsonl` subagent sidechains collapse into their parent session. See
  [src/correlate.ts](src/correlate.ts).

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

pnpm once        # one-shot scan + print, then exit
pnpm start       # live board, updates as sessions change (Ctrl-C to stop)
pnpm dev         # same, auto-restart on source edits
pnpm typecheck
```

## Layout

```
src/
  config.ts       source paths + timing thresholds (§9)
  types.ts        DiscoveredSession, ActivityState
  parseCli.ts     JSONL transcript → session + Layer-A state machine
  parseDesktop.ts desktop metadata json → session
  correlate.ts    dedupe/merge sessions into one aircraft each
  render.ts       console board (ANSI, no deps)
  watcher.ts      chokidar watch + initial scan + periodic reconcile
  util.ts         small formatting helpers
```

## Next (Phase 2)

Persist to SQLite and expose a REST + WebSocket API. See CONCEPT.md §10.
