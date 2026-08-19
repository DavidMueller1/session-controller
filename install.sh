#!/bin/bash
# Session Controller — one-command, hands-off install (macOS).
#
# Run this once from a checkout of the repo:
#
#     ./install.sh
#
# It ensures the toolchain (Node 22 + pnpm), builds the dashboard, wires the tracking
# hooks into ~/.claude/settings.json, builds the menu-bar app, installs it to
# /Applications, registers it as a Login Item, and launches it. After this the server
# autostarts on every login — no terminal to keep open.
#
# Safe to re-run: every step is idempotent.
set -eo pipefail

# --- pretty output -----------------------------------------------------------
bold=$(tput bold 2>/dev/null || true); dim=$(tput dim 2>/dev/null || true)
grn=$(tput setaf 2 2>/dev/null || true); red=$(tput setaf 1 2>/dev/null || true)
rst=$(tput sgr0 2>/dev/null || true)
step() { echo; echo "${bold}▸ $*${rst}"; }
ok()   { echo "  ${grn}✓${rst} $*"; }
info() { echo "  ${dim}$*${rst}"; }
die()  { echo; echo "  ${red}✗ $*${rst}"; echo; exit 1; }

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "${bold}✈  Session Controller — installer${rst}"
info "$ROOT"

# --- 0. platform + Xcode command-line tools (git, swiftc) --------------------
[ "$(uname)" = "Darwin" ] || die "This installer is macOS-only."

step "Checking Xcode command-line tools"
if ! xcode-select -p >/dev/null 2>&1; then
  info "Not found — launching the installer (a system dialog will open)…"
  xcode-select --install >/dev/null 2>&1 || true
  die "Finish the Command Line Tools install, then run ./install.sh again."
fi
ok "present"

# --- 1. Node 22 via nvm -------------------------------------------------------
step "Ensuring Node 22 (via nvm)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  info "nvm not found — installing…"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 22 >/dev/null
nvm use 22 >/dev/null
ok "node $(node -v)"

# --- 2. pnpm (via corepack, bundled with Node) -------------------------------
step "Ensuring pnpm"
if ! command -v pnpm >/dev/null 2>&1; then
  info "Enabling corepack…"
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@latest --activate >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1
fi
command -v pnpm >/dev/null 2>&1 || die "Could not install pnpm."
ok "pnpm $(pnpm -v)"

# --- 3. deps + build UI + install tracking hooks -----------------------------
step "Installing dependencies, building the dashboard, wiring hooks"
info "(pnpm install → web install → ui build → doctor)"
pnpm run setup
ok "dashboard built + hooks wired into ~/.claude/settings.json"

# --- 4. build the menu-bar app -----------------------------------------------
step "Building the menu-bar app"
bash menubar/build.sh >/dev/null
APP_SRC="$ROOT/menubar/build/Session Controller.app"
[ -d "$APP_SRC" ] || die "menu-bar build did not produce the app bundle."
ok "built"

# --- 5. install to /Applications ---------------------------------------------
step "Installing to /Applications"
APP_DST="/Applications/Session Controller.app"
# Quit a running instance so we can replace it cleanly.
osascript -e 'tell application "Session Controller" to quit' >/dev/null 2>&1 || true
rm -rf "$APP_DST"
cp -R "$APP_SRC" "$APP_DST"
ok "$APP_DST"

# --- 6. register as a Login Item ---------------------------------------------
step "Registering as a Login Item (autostart at login)"
info "macOS may ask to allow controlling System Events — click OK."
osascript -e 'tell application "System Events" to delete (every login item whose name is "Session Controller")' >/dev/null 2>&1 || true
osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$APP_DST\", hidden:false}" >/dev/null 2>&1 \
  && ok "added" \
  || info "couldn't add automatically — add it in System Settings → General → Login Items."

# --- 7. launch ----------------------------------------------------------------
step "Launching"
open "$APP_DST"
# Give the app a moment to start the server, then open the dashboard.
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:4317/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
open "http://127.0.0.1:4317" >/dev/null 2>&1 || true

echo
echo "${grn}${bold}Done.${rst} Session Controller is running in your menu bar and will"
echo "autostart every time you log in. Dashboard: ${bold}http://127.0.0.1:4317${rst}"
echo
