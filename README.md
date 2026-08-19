# Traffic Controller

An air-traffic-control style tracker for the features you build in parallel with Claude.
Each feature is an "aircraft"; each Claude session working on it is tracked automatically —
whether it runs in the **PHPStorm terminal (Claude Code CLI)** or the **Claude Desktop app
(Cowork / local agent mode)**.

See [CONCEPT.md](CONCEPT.md) for the full design and the locked decisions, and
**[SETUP.md](SETUP.md)** to get it running — one command: `./install.sh`.

## Status

- **Phase 1 — watcher spike ✅** — discovers every live session from both sources, derives
  status, dedupes into one aircraft each. Console board.
- **Phase 2 — store + API ✅** — a shared `Engine` feeds a SQLite store and a Fastify REST +
  WebSocket server that pushes live updates.
- **Phase 3 — Vue board UI ✅** — a dark control-tower flight-strip board (`web/`) over the
  WebSocket: an In-flight band across the top, Holding / Approach lanes below, a collapsed
  Cold footer. Holding flashes at 1 Hz; add a note and a strip settles to steady **Parked**.
  Strips FLIP-animate between lanes (honors `prefers-reduced-motion`).
- **Phase 5 — registry status ✅** — for live CLI sessions the state comes from Claude Code's
  own `status` (busy → In-flight, idle → Holding), read from `~/.claude/sessions` — authoritative,
  no transcript guesswork, and crucially **zero per-machine setup** (the reason this is
  shareable). Desktop-run sessions fall back to inference. _(Newer Claude builds dropped the
  registry `status` field, which is why hooks were added later — see Phase 7.)_
- **Phase 6 — PR integration ✅** — each strip shows its branch's GitHub PR (via `gh`, polled
  ~60s for non-cold sessions): a clickable pill coloured by state (draft / open / review /
  merged / closed). A **merged** PR moves the strip to **Approach** (ready to land). **Landing**
  stays a manual click (Landed badge has an **×** to undo). **Go-around** ignores the current
  merged PR so a same-session follow-up isn't flagged — the next *different* merged PR re-flags
  Approach.
- **Phase 7 — hooks + health ✅** — optional Claude Code hooks give near-instant, exact state
  for CLI *and* desktop sessions (working / needs-input / wrapped-up on exit). `pnpm run doctor`
  installs them idempotently, and a top-of-board banner flags if they ever go missing or stop
  firing. See **[SETUP.md](SETUP.md)**.

### What's tracked

- **CLI sessions** — read from `~/.claude/projects/**/*.jsonl` (branch + cwd come straight
  from the transcript). The strip **callsign is the session's `/rename`** value, read live
  from `~/.claude/sessions/<pid>.json` (falls back to the auto title for unnamed sessions).
- **Desktop sessions** — read from
  `~/Library/Application Support/Claude/{local-agent-mode,claude-code}-sessions/**/local_*.json`
  (uses the session's own title).
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
| `PUT /api/aircraft/:id/note` | set a note (turns a "needs you" strip into "parked") |
| `DELETE /api/aircraft/:id/note` | remove the note |
| `POST /api/aircraft/:id/open` | focus the session's host window (macOS) |
| `WS /ws` | `snapshot` on connect, then `update` messages on every change |

State is persisted to SQLite at `data/traffic-controller.db` (gitignored) on every change.

### Open a session (macOS)

Click a strip's title (or its **open** button) to bring the session's host to the front. The
backend resolves the host from the live registry `pid` (walking the process tree):

- **Terminal in a JetBrains IDE** → drives that exact IDE binary (`open -na <ide> --args <root>`,
  same as the `phpstorm` launcher) to focus the matching project window — correct even with
  several projects/worktrees open. The `cwd` is first resolved to its **git repo/worktree root**
  (sessions often run in a monorepo subfolder like `…/shops/kartenliebe`, but the IDE has the
  root open).
- **Claude desktop** → focuses the Claude app.
- **Bare iTerm / Terminal / Warp** → focuses that terminal app.

Limits: it focuses the *window*, not the exact terminal tab, and can't deep-link a specific
Claude conversation. macOS-only.

### Context-usage ring

Each strip shows a small ring for how full the session's context is, from the latest turn's
`message.usage` (`input + cache_read + cache_creation`). Muted below 75%, amber ≥75%, red ≥90%;
hover for exact `% + tokens`. The window defaults to **1M** (auto-bumps beyond a lower
`CONTEXT_WINDOW` if a session exceeds it) — set `CONTEXT_WINDOW=200000` if you run Claude in
standard 200k mode.

### Holding notifications

Toggle the header **bell** to get a browser notification when a session enters holding
(needs you). It uses the Web Notifications API (no OS dependency, works cross-platform) and
only fires after the strip has stayed in holding for ~20s — so the session you're actively
replying to (you answer within that window) never pings; only genuinely-waiting ones do.
Clicking a notification focuses that session's host window. Baselined on enable, so existing
holding sessions don't ping; each session pings again only after it leaves and re-enters
holding.

### States

| Board label | Meaning |
|---|---|
| `IN-FLIGHT` | working now (incl. right after a tool error — Claude just retries, so that's not terminal) |
| `MIA` | mid-work but silent for 5+ min — still in the In-flight band, dimmed |
| `HOLDING` | waiting on you: turn ended, or it called `AskUserQuestion` / `ExitPlanMode` |
| `APPROACH?` | system suspects it wrapped up (desktop archived) — awaiting your confirmation |
| `COLD` | dormant — no activity for a while (overnight-safe, **not** finished) |

(There's no automatic "error" state — a tool error isn't terminal. "Go-around" is the manual
action to send a *landed* aircraft back into the pattern.)

## Run

```bash
nvm use                     # Node 22

# first run: deps + build UI + install tracking hooks (see SETUP.md)
pnpm run setup              # NB: `pnpm run setup`, not `pnpm setup` (a pnpm builtin)

# production-ish: the server serves the built UI at http://127.0.0.1:4317/
pnpm serve

# dev: backend + Vite dev server (HMR) in two terminals
pnpm serve                  # backend API on :4317
pnpm ui                     # Vite on :5173, proxies /api and /ws to :4317

pnpm board                  # live console board (no browser)
pnpm once                   # one-shot console scan
pnpm typecheck
```

## Layout

```
src/
  config.ts       source paths, timing thresholds, API port, db path
  types.ts        SessionFacts, DiscoveredSession, ActivityState
  parseCli.ts     JSONL transcript → SessionFacts
  parseDesktop.ts desktop metadata json → SessionFacts
  registry.ts     ~/.claude/sessions/*.json → live session name (rename) + status + pid
  open.ts         focus a session's host window (macOS `open`, pid ancestry detect)
  pr.ts           GitHub PR lookup for a branch via `gh`
  deriveState.ts  facts + now → resolved state (pure, no I/O)
  correlate.ts    dedupe/merge sessions into one aircraft each
  engine.ts       watch + scan + fast tick; emits `update(aircraft)`
  store.ts        SQLite persistence (better-sqlite3)
  server.ts       Fastify REST + WebSocket API + serves web/dist  ← entry
  console-app.ts  live console board            ← entry
  render.ts       console board rendering (ANSI, no deps)
  util.ts         small formatting helpers

web/              Vue 3 + Vite flight-strip board
  src/
    App.vue         board layout + cross-lane FLIP animation
    components/Strip.vue   one flight strip (badges, chips, notes)
    useBoard.ts     WebSocket client + note actions
    format.ts       state → lane/color/label, age formatting
    style.css       dark control-tower theme + flash/strip animations
    types.ts
```

## Next

Phase 4 (manual assignment) was **dropped** — session naming via `/rename` makes it
unnecessary; this is a session tracker. Next up: **Phase 5** (CLI hooks + the registry
`status` field to make working/MIA/needs-input exact) and **Phase 6** (PR integration,
git icons, landed-on-merge). See CONCEPT.md §10.
