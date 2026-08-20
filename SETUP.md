# Setup

Getting Session Controller running on a new machine (macOS).

## One command (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/DavidMueller1/session-controller/main/install.sh | bash
```

(Or `./install.sh` from a checkout.) Hands-off, idempotent. It:

1. Ensures the toolchain — **Node 22** (installs [nvm](https://github.com/nvm-sh/nvm) if missing) and **pnpm** (via corepack)
2. Clones into `~/Library/Application Support/Session Controller/repo` and builds the dashboard there
3. Wires the session-tracking hooks into `~/.claude/settings.json` (see below)
4. Builds the menu-bar app, installs it to `/Applications`, registers it as a **Login Item**, and launches it

After this the app **autostarts at login** and **keeps itself up to date automatically** — it tracks `main` (checks shortly after launch, every 30 min, or via the menu's *Check for Updates Now*) and silently pulls, rebuilds only what changed, and restarts/relaunches. Board state in `…/Session Controller/data` is never touched by an update.

macOS may ask once to allow controlling System Events (for the Login Item) — click OK. Because the app is built on your machine, there's no Gatekeeper prompt. **`gh`** (GitHub CLI) is optional — only for the PR pills on strips.

> The installed app is a **separate managed clone** — developing in your own checkout never affects it, and it never auto-updates your working tree.

## Manual (what `install.sh` automates)

```bash
nvm use            # Node 22
pnpm run setup
```

`pnpm run setup` does the build in order:

1. `pnpm install` — backend deps
2. `pnpm --dir web install` — frontend deps
3. `pnpm ui:build` — build the Vue board into `web/dist` (served by the backend)
4. `pnpm run doctor` — install the session-tracking hooks (see below)

> Use `pnpm run setup`, not `pnpm setup` — the latter is pnpm's own built-in command.

Then start it:

```bash
pnpm serve         # http://127.0.0.1:4317
```

## The tracking hooks

The board's live state (In-flight / Holding / Wrapped-up) is driven by a small set of
Claude Code hooks that write `~/.claude/tc-state/<session>.json` as each session works,
waits, or exits. They give **near-instant, exact** state for both terminal and desktop
sessions. Without them the board falls back to transcript inference — roughly an 8-second
lag, and an exited session can briefly stick "In-flight".

`pnpm run doctor` wires them into `~/.claude/settings.json` idempotently:

```bash
pnpm run doctor          # (re)install the hooks — safe to run anytime
pnpm run doctor --check  # report what's wired; exit 1 if anything is missing
```

It **backs up** your existing settings first, **preserves** every other hook you have
(e.g. a `terminal-notifier` notification hook), and **re-resolves the script path** so it
still works if you move the repo. Running it twice never duplicates anything.

### Health banner

The board watches its own tracking pipeline. If the hooks ever go missing or stop firing
(a Claude update can rewrite `settings.json`), a banner appears at the top of the board
telling you what's wrong and to run `pnpm run doctor`. No banner = healthy.

You can also check from the terminal:

```bash
curl -s http://127.0.0.1:4317/api/hooks-health | python3 -m json.tool
```

## Menu-bar app

`install.sh` builds and installs this — a macOS status-bar app showing the logo with a
badge = the number of sessions holding for you. It runs the server, autostarts at login,
and drives the auto-update. To rebuild the bundle by hand: `menubar/build.sh`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Red/amber banner at the top of the board | `pnpm run doctor` |
| `better-sqlite3` / `NODE_MODULE_VERSION` error | `nvm use` (Node 22), then `pnpm install` |
| Board loads but is empty | you have no live Claude sessions yet — start one |
| A session lags ~8s or is stuck In-flight after exit | its hooks aren't active — `pnpm run doctor`, then restart that session |
