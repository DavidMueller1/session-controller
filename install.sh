#!/bin/bash
# Session Controller — one-command, hands-off install (macOS).
#
#   ./install.sh                 (from a checkout)
#   curl -fsSL https://raw.githubusercontent.com/DavidMueller1/session-controller/main/install.sh | bash
#
# Clones the app into a managed directory, builds it on-device (so it's never
# quarantined), wires the tracking hooks, installs the menu-bar app to
# /Applications, registers it as a Login Item, and launches it. The app then
# keeps itself up to date automatically. Safe to re-run.
set -eo pipefail

bold=$(tput bold 2>/dev/null || true); dim=$(tput dim 2>/dev/null || true)
grn=$(tput setaf 2 2>/dev/null || true); red=$(tput setaf 1 2>/dev/null || true)
rst=$(tput sgr0 2>/dev/null || true)
step() { echo; echo "${bold}▸ $*${rst}"; }
ok()   { echo "  ${grn}✓${rst} $*"; }
info() { echo "  ${dim}$*${rst}"; }
die()  { echo; echo "  ${red}✗ $*${rst}"; echo; exit 1; }

SUPPORT="${TC_SUPPORT:-$HOME/Library/Application Support/Session Controller}"
REPO="$SUPPORT/repo"
DATA="$SUPPORT/data"
REPO_URL="${TC_REPO_URL:-https://github.com/DavidMueller1/session-controller.git}"
APP_DST="/Applications/Session Controller.app"

echo "${bold}✈  Session Controller — installer${rst}"
info "$SUPPORT"

[ "$(uname)" = "Darwin" ] || die "This installer is macOS-only."

step "Checking Xcode command-line tools"
if ! xcode-select -p >/dev/null 2>&1; then
  info "Not found — launching the installer (a system dialog will open)…"
  xcode-select --install >/dev/null 2>&1 || true
  die "Finish the Command Line Tools install, then run ./install.sh again."
fi
ok "present"

step "Preparing the managed clone"
mkdir -p "$DATA"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" fetch origin >/dev/null 2>&1 || die "git fetch failed."
  git -C "$REPO" reset --hard origin/main >/dev/null 2>&1 || die "git reset failed."
  ok "updated existing clone"
else
  rm -rf "$REPO"
  git clone "$REPO_URL" "$REPO" >/dev/null 2>&1 || die "git clone failed ($REPO_URL)."
  ok "cloned into $REPO"
fi

# Test seam: stop here so the clone logic can be checked without a full build.
if [ "${TC_INSTALL_CLONE_ONLY:-0}" = "1" ]; then
  ok "clone-only mode — done"
  exit 0
fi

cd "$REPO"

step "Ensuring Node (from .nvmrc) + pnpm"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  info "nvm not found — installing…"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# Sourcing nvm.sh runs nvm's "auto use": it picks up the .nvmrc here in $REPO and tries to
# activate that version. Right after the bootstrap above there is no such version yet, so the
# source fails with 3 — and under `set -e` that kills the installer silently, one line before
# the `nvm install` that would have provided it. Every first-time install on an nvm-less
# machine died here, leaving a bare clone and no error message.
# `. nvm.sh || true` does NOT fix it: on the bash 3.2 that macOS still ships — the shell a
# `curl | bash` install actually runs under — errexit fires for the failure inside the
# sourced file before the `|| true` applies. Drop errexit around the source itself.
set +e
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
set -e
nvm install >/dev/null || die "nvm install failed (Node version from .nvmrc)."
nvm use >/dev/null || die "nvm use failed."
ok "node $(node -v)"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@latest --activate >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1
fi
command -v pnpm >/dev/null 2>&1 || die "Could not install pnpm."
ok "pnpm $(pnpm -v)"

# A piped install (curl | bash) and the app's auto-updater both run pnpm with no TTY. If an
# existing node_modules is incompatible, pnpm wants to purge it and otherwise aborts asking
# for confirmation (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) — which is exactly what
# strands a re-run meant to recover a stuck install. CI=true makes pnpm non-interactive;
# frozen_lockfile=false keeps it from failing on minor lockfile drift.
export CI=true
export npm_config_frozen_lockfile=false

step "Building the dashboard + wiring hooks"
pnpm run setup
ok "built + hooks wired into ~/.claude/settings.json"

step "Building the menu-bar app"
bash menubar/build.sh >/dev/null
APP_SRC="$REPO/menubar/build/Session Controller.app"
[ -d "$APP_SRC" ] || die "menu-bar build did not produce the app bundle."
ok "built"

step "Installing to /Applications"
osascript -e 'tell application "Session Controller" to quit' >/dev/null 2>&1 || true
rm -rf "$APP_DST"
cp -R "$APP_SRC" "$APP_DST"
ok "$APP_DST"

step "Registering as a Login Item (autostart at login)"
info "macOS may ask to allow controlling System Events — click OK."
osascript -e 'tell application "System Events" to delete (every login item whose name is "Session Controller")' >/dev/null 2>&1 || true
osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$APP_DST\", hidden:false}" >/dev/null 2>&1 \
  && ok "added" \
  || info "couldn't add automatically — add it in System Settings → General → Login Items."

step "Launching"
open "$APP_DST"
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:4317/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
open "http://127.0.0.1:4317" >/dev/null 2>&1 || true

echo
echo "${grn}${bold}Done.${rst} Session Controller is running in your menu bar, will"
echo "autostart at login, and will keep itself up to date automatically."
echo "Dashboard: ${bold}http://127.0.0.1:4317${rst}"
echo
