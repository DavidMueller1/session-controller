#!/bin/bash
# pnpm dev:live — hot-reload development against the INSTALLED app's data.
#
# Runs the backend in watch mode (:4317) + the Vite dev server (:5173, HMR) from THIS
# checkout, pointed at the managed app's database — so you see edits instantly while
# sharing the same notes / landings / history the real app uses. Frees :4317 from the
# managed app on start and hands it back (relaunches the app) on exit (Ctrl-C).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
APP="/Applications/Session Controller.app"
export DB_PATH="$HOME/Library/Application Support/Session Controller/data/traffic-controller.db"
mkdir -p "$(dirname "$DB_PATH")"

# Node from .nvmrc, like the rest of the toolchain
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 && { nvm use >/dev/null 2>&1 || true; }

free_port() { local p; p="$(lsof -ti tcp:"$1" -sTCP:LISTEN 2>/dev/null)"; [ -n "$p" ] && kill $p 2>/dev/null || true; }

echo "▸ Freeing :4317 (stopping the managed app's server)…"
[ -d "$APP" ] && osascript -e 'tell application "Session Controller" to quit' >/dev/null 2>&1 || true
sleep 1
free_port 4317   # in case a bare `pnpm serve` still holds it

BACK_PID=""; UI_PID=""; cleaned=0
cleanup() {
  [ "$cleaned" = 1 ] && return; cleaned=1
  echo; echo "▸ Stopping dev servers…"
  # kill the pnpm wrappers AND their node children, then make sure the ports are clear
  for pid in "$BACK_PID" "$UI_PID"; do [ -n "$pid" ] && { pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; }; done
  free_port 4317; free_port 5173
  if [ -d "$APP" ]; then echo "▸ Handing :4317 back to the app…"; open "$APP"; fi
}
# `wait` (below) is interruptible, so these run immediately — not deferred behind a
# foreground process (which was the earlier bug: the app never got :4317 back).
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
