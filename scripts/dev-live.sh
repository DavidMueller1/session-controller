#!/bin/bash
# pnpm dev:live — frontend hot-reload dev ALONGSIDE the installed app, on its real data.
#
# The installed app keeps running on :4317 as the ONE backend and the ONLY writer of the
# shared SQLite DB. This starts just the Vite dev server on :5173, proxying /api + /ws to
# that live app — so you develop new UI with instant reload while it renders the real, live
# sessions, and the live app is never touched.
#
# Why no second backend here: two backends writing the one SQLite DB hit SQLITE_BUSY_SNAPSHOT
# (a read-then-write conflict that busy_timeout does NOT retry) and can crash a server — and
# that server can be the live app's. So exactly one writer: the installed app.
#
# Working on the BACKEND (src/*.ts)? Use `pnpm dev:solo` instead — it quits the app and runs
# a single full dev backend on :4317 (watch) + Vite, on the app's DB. One writer again, but
# the live app steps aside for the duration.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
APP="/Applications/Session Controller.app"

# Node from .nvmrc, like the rest of the toolchain
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 && { nvm use >/dev/null 2>&1 || true; }

free_port() { local p; p="$(lsof -ti tcp:"$1" -sTCP:LISTEN 2>/dev/null)"; [ -n "$p" ] && kill $p 2>/dev/null || true; }

# the live app is the data source — make sure it's up (no-op if already running)
if ! curl -fsS "http://127.0.0.1:4317/api/health" >/dev/null 2>&1; then
  echo "▸ Live app not responding on :4317 — launching it…"
  [ -d "$APP" ] && open "$APP" >/dev/null 2>&1 || echo "  (app not installed at $APP — start your backend on :4317 yourself)"
  for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:4317/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
fi
free_port 5173

UI_PID=""; cleaned=0
cleanup() {
  [ "$cleaned" = 1 ] && return; cleaned=1
  echo; echo "▸ Stopping the dev UI (the live app keeps running)…"
  [ -n "$UI_PID" ] && { pkill -P "$UI_PID" 2>/dev/null; kill "$UI_PID" 2>/dev/null; }
  free_port 5173
}
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

echo "▸ Live app on :4317 (backend + data)   ·   Vite (HMR) on :5173 proxying to it"
pnpm ui &   # vite.config proxies /api + /ws → :4317 by default
UI_PID=$!
( sleep 3 && open "http://localhost:5173" >/dev/null 2>&1 || true ) &
echo "▸ Open  http://localhost:5173  (dev UI, live data)   ·   live app: http://localhost:4317   —   Ctrl-C to stop"
wait "$UI_PID"
