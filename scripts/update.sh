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

# Toolchain, matching launch.sh / install.sh (skipped in tests). This runs spawned by the
# menu-bar app, which has a MINIMAL GUI PATH — no shell profile — so neither Node nor a
# user-installed pnpm is on PATH by default. Resolve both here, or the build fails with
# "pnpm: command not found" and rolls back forever.
if [ "${TC_SKIP_NVM:-0}" != "1" ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
    nvm use >/dev/null 2>&1 || nvm install >/dev/null 2>&1
  fi
  # pnpm is often a standalone install only on the user's shell PATH (e.g. ~/Library/pnpm);
  # surface it, then fall back to corepack (bundled with Node) exactly like install.sh.
  for d in "$HOME/Library/pnpm" "$HOME/.local/share/pnpm"; do
    [ -x "$d/pnpm" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH"; export PATH ;; esac
  done
  if ! command -v pnpm >/dev/null 2>&1; then
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
  fi
  # If the toolchain still isn't usable, bail BEFORE fetch/reset so we never roll into a
  # stale loop — a later run (or a re-install) can then recover cleanly.
  if ! command -v pnpm >/dev/null 2>&1; then
    log "pnpm unavailable in update environment; aborting (PATH=$PATH)"; exit 1
  fi
fi

# Default build phase; a test hook may redefine apply_build below.
# apply_build <newline-separated changed paths>  -> non-zero on failure
apply_build() {
  local changed="$1"
  if printf '%s\n' "$changed" | grep -qE '^(pnpm-lock\.yaml|package\.json|pnpm-workspace\.yaml|web/)'; then
    # CI=true makes pnpm fully non-interactive: it won't stop to confirm removing an
    # incompatible node_modules (which aborts as ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
    # when spawned by the app with no TTY, then the whole update rolls back).
    # --no-frozen-lockfile keeps it from failing on minor lockfile drift.
    log "pnpm install"; CI=true pnpm install --no-frozen-lockfile >>"$LOG" 2>&1 || return 1
  fi
  if printf '%s\n' "$changed" | grep -qE '^web/'; then
    log "pnpm ui:build"; pnpm ui:build >>"$LOG" 2>&1 || return 1
  fi
  if printf '%s\n' "$changed" | grep -qE '^hooks/'; then
    log "pnpm run doctor"; pnpm run doctor >>"$LOG" 2>&1 || return 1
  fi
  if printf '%s\n' "$changed" | grep -qE '^menubar/'; then
    log "rebuild .app"; bash menubar/build.sh >>"$LOG" 2>&1 || return 1
    # Do NOT quit the app here. It's the process orchestrating this update and must stay
    # alive to receive exit 20 and relaunch itself — quitting it mid-run orphaned the update
    # and left the app down. Replacing a running .app bundle in place is safe on macOS: the
    # live process keeps its already-open executable, and it quits itself on relaunch.
    log "install .app to /Applications"
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
