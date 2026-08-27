#!/bin/bash
# pnpm dev:solo — full-stack dev (BACKEND + frontend) on the app's real database.
#
# For working on src/*.ts. The installed app is quit so this can be the ONE backend and the
# ONLY DB writer on :4317 (two writers on one SQLite DB crash — see dev-live.sh). Runs the
# backend in watch mode (:4317) + Vite (:5173, HMR), both on the app's DB, so you see the
# real notes / landings / sessions. Hands :4317 back to the app (relaunches it) on exit.
#
# Just tweaking the UI? Use `pnpm dev:live` — it leaves the live app running and only serves
# the dev frontend against it.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
APP="/Applications/Session Controller.app"
export DB_PATH="$HOME/Library/Application Support/Session Controller/data/traffic-controller.db"
mkdir -p "$(dirname "$DB_PATH")"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 && { nvm use >/dev/null 2>&1 || true; }

free_port() { local p; p="$(lsof -ti tcp:"$1" -sTCP:LISTEN 2>/dev/null)"; [ -n "$p" ] && kill $p 2>/dev/null || true; }

echo "▸ Freeing :4317 (stopping the managed app's server)…"
[ -d "$APP" ] && osascript -e 'tell application "Session Controller" to quit' >/dev/null 2>&1 || true
sleep 1
free_port 4317

BACK_PID=""; UI_PID=""; cleaned=0
cleanup() {
  [ "$cleaned" = 1 ] && return; cleaned=1
  echo; echo "▸ Stopping dev servers…"
  for pid in "$BACK_PID" "$UI_PID"; do [ -n "$pid" ] && { pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; }; done
  free_port 4317; free_port 5173
  if [ -d "$APP" ]; then echo "▸ Handing :4317 back to the app…"; open "$APP"; fi
}
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

echo "▸ Backend (watch) on :4317 — sharing DB: $DB_PATH"
pnpm dev &
BACK_PID=$!
for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:4317/api/health" >/dev/null 2>&1 && break; sleep 0.5; done

echo "▸ Vite (HMR) on :5173"
pnpm ui &
UI_PID=$!
( sleep 3 && open "http://localhost:5173" >/dev/null 2>&1 || true ) &
echo "▸ Open  http://localhost:5173   —   Ctrl-C to stop and hand :4317 back to the app"
wait "$BACK_PID" "$UI_PID"
