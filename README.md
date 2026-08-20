<div align="center">
  <img src="web/public/logo.svg" width="84" alt="Session Controller" />
  <h1>Session Controller</h1>
  <p><em>An air-traffic-control board for the Claude Code sessions you run in parallel.</em></p>
  <p>
    <img alt="macOS" src="https://img.shields.io/badge/macOS-06090d?style=for-the-badge&logo=apple&logoColor=white" />
    <img alt="self-updating" src="https://img.shields.io/badge/self--updating-3fb950?style=for-the-badge&labelColor=0d1117&color=3fb950" />
    <img alt="read-only" src="https://img.shields.io/badge/read--only-7d8590?style=for-the-badge&labelColor=0d1117&color=7d8590" />
  </p>
</div>

Each feature is an **aircraft**; every session working on it — in a terminal (Claude Code
CLI) or the Claude desktop app — is tracked automatically and shown as a live flight strip.
It never writes to Claude's files. See [CONCEPT.md](CONCEPT.md) for the full design.

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
| ![In-flight](https://img.shields.io/badge/In--flight-3fb950?style=flat-square&labelColor=3fb950&color=3fb950) | working now |
| ![Holding](https://img.shields.io/badge/Holding-e0a92e?style=flat-square&labelColor=e0a92e&color=e0a92e) | waiting on you — turn ended, or it called `AskUserQuestion` / `ExitPlanMode` (flashes) |
| ![Parked](https://img.shields.io/badge/Parked-e0823c?style=flat-square&labelColor=e0823c&color=e0823c) | a "needs you" strip you triaged by adding a note |
| ![MIA](https://img.shields.io/badge/MIA-7d8590?style=flat-square&labelColor=7d8590&color=7d8590) | lost contact — quiet 5+ min, or wrapped up |
| ![Landed](https://img.shields.io/badge/Landed-4cc38a?style=flat-square&labelColor=4cc38a&color=4cc38a) | you marked it done |

- Sessions idle **> 5 days drop off** the board — unless they have a note.
- **Click a strip** for details; **click its title** to focus the session's window (terminal / PhpStorm / Claude desktop).
- ![PR](https://img.shields.io/badge/PR-58a6ff?style=flat-square&labelColor=58a6ff&color=58a6ff) pill per branch (via `gh`), coloured by review state; a merged PR flags ![Approach](https://img.shields.io/badge/Approach-a371f7?style=flat-square&labelColor=a371f7&color=a371f7) (cleared to land). Landing is a manual click.
- **dev ▾** — detect, start/stop a dev server in the strip's folder and tail its logs; set the command per repo in **Settings**.
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
