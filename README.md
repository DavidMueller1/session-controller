# Session Controller

An air-traffic-control board for the Claude Code sessions you run in parallel. Each feature
is an "aircraft"; every session working on it — in a terminal (Claude Code CLI) or the
Claude desktop app — is tracked automatically and shown as a live flight strip. It's
read-only and never writes to Claude's files.

macOS. See [CONCEPT.md](CONCEPT.md) for the full design.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/DavidMueller1/session-controller/main/install.sh | bash
```

Clones into `~/Library/Application Support/Session Controller/repo`, builds an on-device
menu-bar app, wires the tracking hooks, and adds a Login Item. Because it's built locally
there's no Gatekeeper prompt. Dashboard: <http://127.0.0.1:4317>.

## Auto-update

The app keeps itself current: it checks `main` shortly after launch and every 30 min (or
via the menu's *Check for Updates Now*), then silently pulls, rebuilds only what changed,
and restarts — relaunching itself if the app bundle changed. **Pushing to `main` ships to
everyone.** Board state (`…/Session Controller/data`) is never touched by an update.

## The board

Strips move between lanes as each session's state changes:

| Lane | Meaning |
|---|---|
| **In-flight** | working now |
| **Holding** | waiting on you — turn ended, or it called `AskUserQuestion` / `ExitPlanMode` (flashes) |
| **Parked** | a "needs you" strip you triaged by adding a note |
| **MIA** | lost contact — quiet 5+ min, or wrapped up |
| **Landed** | you marked it done |

- Sessions idle **> 5 days drop off** the board — unless they have a note.
- **Click a strip** for details; **click its title** to focus the session's window (terminal / PhpStorm / Claude desktop).
- **PR pill** per branch (via `gh`), coloured by review state; a merged PR flags **Approach** (cleared to land). Landing is a manual click.
- **dev ▾** — detect, start/stop a dev server in the strip's folder and tail its logs; configure the command per repo in **Settings**.
- A **context-usage ring**, header **bell** for holding notifications, and a **?** help panel cover the rest.

## Tracking hooks

Live state comes from a few Claude Code hooks that write `~/.claude/tc-state/*.json`.
`install.sh` wires them idempotently (via `pnpm run doctor`). If a Claude update ever
rewrites `~/.claude/settings.json` and drops them, a banner appears at the top of the
board — the app re-wires them on its next update, or run `pnpm run doctor`.

## Develop

```bash
nvm use                # Node 22 (from .nvmrc)
pnpm run setup         # deps + build UI + wire hooks   (NB: `run setup`, not `pnpm setup`)
pnpm serve             # server + built UI on :4317
pnpm ui                # Vite dev server on :5173 (HMR), proxies to :4317
pnpm typecheck
```

`gh` (GitHub CLI) is optional — only for the PR pills.
