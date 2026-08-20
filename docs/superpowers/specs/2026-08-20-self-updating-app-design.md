# Self-updating Session Controller app — design

**Date:** 2026-08-20
**Status:** approved design, pre-implementation
**Author:** David Müller (with Claude)

## Goal

Let colleagues install Session Controller once and never think about updates
again: the menu-bar app keeps itself current with `main` automatically. No app
store, no manual re-download, no `git pull` by hand.

## Locked constraints (decided during brainstorming)

1. **No Apple code signing / notarization.** An Apple Developer ID is
   unavailable. This rules out a *downloaded* prebuilt binary as the
   distribution unit: on macOS Sequoia a downloaded, unsigned app is quarantined
   and Gatekeeper blocks it (on every update, since each update is a fresh
   download). The escape hatch is that **an app built locally on the user's own
   machine is never quarantined** — which is why the current `install.sh` app
   launches with no Gatekeeper prompt. We lean into that.
2. **Distribution + update model: locally-built + git self-update.** The app is
   built on-device from a git clone, and updates itself by syncing that clone
   and rebuilding. No Gatekeeper wall, ever.
3. **Rollout: track `main` automatically.** Every push to `main` becomes an
   update for everyone; applied silently in the background (pull → rebuild →
   relaunch). `main` is protected (PR + David's CODEOWNERS review required), so
   that review is the supply-chain trust boundary.
4. **Install location: a dedicated, app-owned clone**, separate from any dev
   checkout, so a hard sync can never clobber uncommitted work.

## Layout

```
~/Library/Application Support/Session Controller/     ← $SUPPORT
  repo/            git clone of session-controller (app-owned, auto-synced)
  data/            SQLite DB + dev-server logs  (DB_PATH points here)
  update.log       append-only log of every update run
  update.lock      flock guard against overlapping update runs
/Applications/Session Controller.app                  ← built from $SUPPORT/repo, Login Item
```

Data lives **outside** `repo/` so `git reset --hard` (which never removes
ignored/untracked files anyway) can't affect board state. The user's
`~/development/…` dev checkout is a *different* clone and is never touched.

## Components

The design keeps the moving parts as small, independently testable units. The
Swift app only *orchestrates*; the actual work is a plain shell script.

### 1. `install.sh` (revised) — one-time bootstrap

Today it builds from whatever checkout it runs in. It changes to **clone into
`$SUPPORT/repo` and build there**, decoupling the running app from any dev
checkout. Because the repo is public, this also enables a no-clone install:

```bash
curl -fsSL https://raw.githubusercontent.com/DavidMueller1/session-controller/main/install.sh | bash
```

Steps (all idempotent, safe to re-run):
1. Platform + Xcode CLT check (as today).
2. Toolchain: Node via nvm from `.nvmrc`, pnpm via corepack (as today).
3. `$SUPPORT/repo`: `git clone` if absent, else `git fetch && git reset --hard origin/main`.
4. `mkdir -p $SUPPORT/data`.
5. Build: `pnpm run setup` (deps + `web` build + hooks doctor), run in `$SUPPORT/repo`.
6. Build the `.app` via `menubar/build.sh`; install to `/Applications` (quit any running instance first).
7. Register the Login Item; launch.

**Behavioral change to note:** if `install.sh` is run from inside an existing
checkout, it still creates/uses the managed `$SUPPORT/repo` clone rather than
adopting that checkout. The dev checkout and the installed app are always
separate.

### 2. `scripts/update.sh` (new) — the update engine

A standalone shell script, run with `$SUPPORT/repo` as cwd, using the same
nvm-from-`.nvmrc` prelude as `launch.sh`. It is the single source of update
logic and is testable in isolation (see Testing).

```
1. Acquire update.lock (flock). If held, exit 0 (another run in progress).
2. git fetch origin
3. OLD=$(git rev-parse HEAD); NEW=$(git rev-parse origin/main)
   If OLD == NEW → exit 0 (up to date, no-op).
4. git reset --hard origin/main
5. CHANGED=$(git diff --name-only "$OLD" "$NEW")
   - pnpm-lock.yaml / package.json / web/**   → pnpm install
   - web/**                                    → pnpm ui:build   (cheap; run whenever web changed)
   - hooks/**                                  → pnpm run doctor  (re-wire, idempotent)
   - menubar/**                                → menubar/build.sh + copy .app to /Applications
6. On success, choose exit code:
   - menubar/** changed → exit 20  (app rebuilt: relaunch whole app)
   - else               → exit 10  (restart server only)
7. On ANY build failure after step 4:
   git reset --hard "$OLD"; rebuild old; log failure; exit 1  (stay on old version)
```

Exit-code contract consumed by the app:

| Code | Meaning | App action |
|---|---|---|
| 0  | up to date / lock held | nothing |
| 10 | updated (JS/web/hooks) | stop + start the server |
| 20 | updated + `.app` rebuilt | relaunch the whole app |
| 1  | error (rolled back / fetch failed) | nothing; show "update failed, staying on vX" |

All steps append to `$SUPPORT/update.log` with timestamps and old→new SHAs.

`build.sh`'s generated `launch.sh` also gains `export DB_PATH="$(dirname
"$ROOT")/data/traffic-controller.db"` (with `mkdir -p`), so the DB resolves to
`$SUPPORT/data` regardless of cwd. `CONFIG.dbPath` already honors `DB_PATH`; the
`DevRunner` logs directory (`path.dirname(dbPath)`) follows it automatically.

### 3. `menubar/main.swift` (extended) — the orchestrator

Adds an update scheduler and menu status; it never contains update *logic*, only
scheduling and reaction.

- **Schedule:** run a check on launch (after the initial server start settles)
  and every ~30 min via a timer. A manual **"Check for updates now"** menu item
  triggers the same path.
- **Run:** execute `scripts/update.sh` on a background queue (so the UI stays
  responsive); menu header reflects `up to date · vX (sha)` / `updating…` /
  `updated to vX` / `update failed — staying on vX`.
- **React to exit code:**
  - `10` → `stop()` then `start()` the server; it re-execs `pnpm start` and
    loads the new code. Dashboard WebSocket clients auto-reconnect (already
    handled by the board).
  - `20` → self-relaunch (below).
- **Version display:** `git -C $SUPPORT/repo describe --tags --always` (or short
  HEAD) shown in the menu header.

### 4. Exit-20 self-relaunch (the one tricky bit)

Because the app bundle keeps the same path and identifier, a naive
`open "…/Session Controller.app"` just reactivates the running instance instead
of starting the rebuilt one. Use the standard wait-for-exit relaunch:

1. `update.sh` has already rebuilt and copied the new `.app` to `/Applications`.
2. The app spawns a **detached** helper before terminating:
   ```
   /bin/sh -c 'while kill -0 <PID> 2>/dev/null; do sleep 0.2; done; \
               open "/Applications/Session Controller.app"'
   ```
3. The app then `stop()`s its server and `NSApp.terminate(nil)`.
4. When the old PID is gone (and its port freed), the helper launches a fresh
   instance, which auto-starts the server (existing launch behavior) against the
   now-free port.

This guarantees a single instance owns the server/port at any moment — no
two-instance race.

## Data flow (update tick)

```
timer/launch ─▶ app runs scripts/update.sh (bg queue)
                    │
        ┌───────────┴───────────┐
     exit 0                exit 10 ─▶ app: stop() → start() server ─▶ WS reconnects
     (nothing)            exit 20 ─▶ app: spawn wait-then-open helper → terminate → fresh app starts server
                          exit 1  ─▶ app: menu shows "update failed — staying on vX"
```

## Error handling & edge cases

- **Rebuild failure:** rolled back to old HEAD and old build; server never
  restarts onto a broken tree. Logged; surfaced in the menu.
- **Offline / fetch failure:** treated as no-op; retried next cycle.
- **Overlapping checks:** `flock` on `update.lock`; a second run exits 0.
- **First install still needs the toolchain** (git, Node via nvm, pnpm) —
  `install.sh` provides it. The self-update path reuses the same toolchain, so a
  machine that installed successfully can always update.
- **Node/ABI drift** (the bug PR #1 fixed): `update.sh` resolves Node from
  `.nvmrc` exactly like `launch.sh`, and runs `pnpm install` when the lockfile
  changed, so `better-sqlite3` is always compiled for the runtime Node.

## Testing strategy

- **`update.sh` (primary coverage):** drive it against a throwaway managed clone
  whose `origin` is a local bare repo. Cases: (a) no new commits → exit 0;
  (b) a `web/` commit → exit 10, `web/dist` rebuilt; (c) a `menubar/` commit →
  exit 20, `/Applications` app refreshed; (d) a commit that breaks the build →
  exit 1, working tree back on old HEAD. Assert exit codes, `update.log`
  contents, and resulting HEAD.
- **`install.sh`:** run against a temp `$SUPPORT` (override via env) and assert
  the clone, build artifacts, hooks wiring, and `/Applications` bundle.
- **Swift orchestration:** manual verification — build, force `origin/main`
  ahead, confirm exit-10 restart and exit-20 relaunch each leave exactly one
  server on `:4317` and a healthy `/api/health`.

## Out of scope (YAGNI)

- Code signing / notarization; downloadable prebuilt binary; Homebrew cask.
- Windows / Linux.
- Release channels (beta/stable), version pinning, manual rollback UI.
- Delta/partial updates — a rebuild from a fresh checkout is fast enough.

## Open dependency

None blocking. The approach needs only the public repo (available) and the
existing toolchain that `install.sh` already provisions.
