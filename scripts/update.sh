#!/bin/bash
# scripts/update.sh — self-update engine for Session Controller.
# Syncs the managed clone to origin/<branch> and rebuilds only what changed.
# Exit codes (contract with the menu-bar app):
#   0  = up to date, or another run holds the lock (no-op)
#   10 = updated; caller should restart the server
#   20 = updated and the .app was rebuilt; caller should relaunch the app
#   1  = error (fetch failed, or build failed and we rolled back)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1
SUPPORT="${TC_SUPPORT:-$(dirname "$REPO")}"
BRANCH="${TC_BRANCH:-main}"
LOG="$SUPPORT/update.log"
LOCKDIR="$SUPPORT/update.lock"
APP_DST="/Applications/Session Controller.app"

mkdir -p "$SUPPORT"
log() { printf '%s  %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$LOG"; }

# single-run lock (mkdir is atomic; flock isn't available on macOS)
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  log "skip: another update run holds the lock"; exit 0
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

# Node from .nvmrc, exactly like launch.sh (skipped in tests)
if [ "${TC_SKIP_NVM:-0}" != "1" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
    nvm use >/dev/null 2>&1 || nvm install >/dev/null 2>&1
  fi
fi

# Default build phase; a test hook may redefine apply_build below.
# apply_build <newline-separated changed paths>  -> non-zero on failure
apply_build() {
  local changed="$1"
  if printf '%s\n' "$changed" | grep -qE '^(pnpm-lock\.yaml|package\.json|pnpm-workspace\.yaml|web/)'; then
    log "pnpm install"; pnpm install >>"$LOG" 2>&1 || return 1
  fi
  if printf '%s\n' "$changed" | grep -qE '^web/'; then
    log "pnpm ui:build"; pnpm ui:build >>"$LOG" 2>&1 || return 1
  fi
  if printf '%s\n' "$changed" | grep -qE '^hooks/'; then
    log "pnpm run doctor"; pnpm run doctor >>"$LOG" 2>&1 || return 1
  fi
  if printf '%s\n' "$changed" | grep -qE '^menubar/'; then
    log "rebuild .app"; bash menubar/build.sh >>"$LOG" 2>&1 || return 1
    log "install .app to /Applications"
    osascript -e 'tell application "Session Controller" to quit' >/dev/null 2>&1 || true
    rm -rf "$APP_DST"
    cp -R "$REPO/menubar/build/Session Controller.app" "$APP_DST" || return 1
  fi
  return 0
}
[ -n "${TC_UPDATE_HOOK:-}" ] && . "$TC_UPDATE_HOOK"

# fetch + compare
if ! git fetch origin >/dev/null 2>&1; then
  log "fetch failed (offline?)"; exit 1
fi
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "origin/$BRANCH")"
if [ "$OLD" = "$NEW" ]; then
  log "up to date at ${OLD:0:9}"; exit 0
fi

log "updating ${OLD:0:9} -> ${NEW:0:9}"
git reset --hard "origin/$BRANCH" >/dev/null 2>&1
CHANGED="$(git diff --name-only "$OLD" "$NEW")"

if apply_build "$CHANGED"; then
  if printf '%s\n' "$CHANGED" | grep -qE '^menubar/'; then
    log "updated to ${NEW:0:9} (app rebuilt)"; exit 20
  fi
  log "updated to ${NEW:0:9}"; exit 10
fi

# rollback on build failure
log "build failed; rolling back to ${OLD:0:9}"
git reset --hard "$OLD" >/dev/null 2>&1
apply_build "$(git diff --name-only "$NEW" "$OLD")" >/dev/null 2>&1 || true
log "rolled back to ${OLD:0:9}"
exit 1
