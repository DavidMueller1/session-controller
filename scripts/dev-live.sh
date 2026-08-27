#!/bin/bash
# pnpm dev:live — hot-reload development ALONGSIDE the installed app, on the same database.
#
# The installed app keeps running on :4317 (its menu-bar icon, notifications, and the real
# board stay live). This runs a SECOND backend from THIS checkout on :4417 + the Vite dev
# server (:5173, HMR), both pointed at the app's database — so you develop new features with
# instant reload while still watching the live app, and both see the same notes / landings /
# sessions. SQLite WAL + busy_timeout (see store.ts) lets the two processes share the DB.
#
# Nothing is taken from the app and nothing is relaunched on exit — Ctrl-C just stops the
# dev servers (:4417, :5173) and leaves the installed app exactly as it was.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
APP="/Applications/Session Controller.app"
DEV_PORT=4417
export DB_PATH="$HOME/Library/Application Support/Session Controller/data/traffic-controller.db"
mkdir -p "$(dirname "$DB_PATH")"

# Node from .nvmrc, like the rest of the toolchain
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 && { nvm use >/dev/null 2>&1 || true; }

free_port() { local p; p="$(lsof -ti tcp:"$1" -sTCP:LISTEN 2>/dev/null)"; [ -n "$p" ] && kill $p 2>/dev/null || true; }

# make sure the live app is actually up, so there's a live version to watch (no-op if running)
[ -d "$APP" ] && open -g "$APP" >/dev/null 2>&1 || true
free_port "$DEV_PORT"   # clear a leftover dev backend from a previous run

BACK_PID=""; UI_PID=""; cleaned=0
cleanup() {
  [ "$cleaned" = 1 ] && return; cleaned=1
  echo; echo "▸ Stopping dev servers (leaving the app running)…"
  for pid in "$BACK_PID" "$UI_PID"; do [ -n "$pid" ] && { pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; }; done
  free_port "$DEV_PORT"; free_port 5173
}
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

echo "▸ Live app stays on :4317 — dev backend (watch) on :$DEV_PORT, shared DB: $DB_PATH"
PORT="$DEV_PORT" pnpm dev &
BACK_PID=$!
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$DEV_PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done

echo "▸ Vite (HMR) on :5173 → proxying to the dev backend on :$DEV_PORT"
TC_API="http://127.0.0.1:$DEV_PORT" pnpm ui &
UI_PID=$!
( sleep 3 && open "http://localhost:5173" >/dev/null 2>&1 || true ) &
echo "▸ Open  http://localhost:5173  (dev)   ·   the live app is on http://localhost:4317   —   Ctrl-C to stop dev"
wait "$BACK_PID" "$UI_PID"
