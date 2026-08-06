# Setup

Getting Session Controller running on a new machine (macOS).

## Prerequisites

- **Node 22** (via [nvm](https://github.com/nvm-sh/nvm)) — required for `better-sqlite3`.
- **pnpm**.
- **`gh`** (GitHub CLI), optional — only for the PR pills on strips.

## One command

```bash
nvm use            # Node 22
pnpm run setup
```

`pnpm run setup` does the whole first run in order:

1. `pnpm install` — backend deps
2. `pnpm --dir web install` — frontend deps
3. `pnpm ui:build` — build the Vue board into `web/dist` (served by the backend)
4. `pnpm doctor` — install the session-tracking hooks (see below)

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

`pnpm doctor` wires them into `~/.claude/settings.json` idempotently:

```bash
pnpm doctor          # (re)install the hooks — safe to run anytime
pnpm doctor --check  # report what's wired; exit 1 if anything is missing
```

It **backs up** your existing settings first, **preserves** every other hook you have
(e.g. a `terminal-notifier` notification hook), and **re-resolves the script path** so it
still works if you move the repo. Running it twice never duplicates anything.

### Health banner

The board watches its own tracking pipeline. If the hooks ever go missing or stop firing
(a Claude update can rewrite `settings.json`), a banner appears at the top of the board
telling you what's wrong and to run `pnpm doctor`. No banner = healthy.

You can also check from the terminal:

```bash
curl -s http://127.0.0.1:4317/api/hooks-health | python3 -m json.tool
```

## Menu-bar app (optional)

A macOS status-bar app shows the Session Controller logo with a badge = the number of
sessions holding for you. Build and install it with:

```bash
menubar/build.sh
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Red/amber banner at the top of the board | `pnpm doctor` |
| `better-sqlite3` / `NODE_MODULE_VERSION` error | `nvm use` (Node 22), then `pnpm install` |
| Board loads but is empty | you have no live Claude sessions yet — start one |
| A session lags ~8s or is stuck In-flight after exit | its hooks aren't active — `pnpm doctor`, then restart that session |
