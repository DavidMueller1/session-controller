#!/bin/bash
# Build "Session Controller.app" — a macOS menu bar controller for the dashboard.
# Run from a shell where `nvm use 22` has selected the Node version to bake in.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BUILD="$HERE/build"
APP="$BUILD/Session Controller.app"
LOGO="$ROOT/web/public/logo.svg"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "node not found on PATH. Run 'nvm use 22' first." >&2; exit 1; fi
NODE_BIN="$(dirname "$NODE")"
PNPM="$(command -v pnpm || true)"
if [ -z "$PNPM" ]; then echo "pnpm not found on PATH." >&2; exit 1; fi
echo "Using node: $NODE"
echo "Using pnpm: $PNPM"

rm -rf "$BUILD"
mkdir -p "$BUILD"

# --- Render icons from our logo.svg (QuickLook keeps the transparent background) ---
echo "Rendering icon…"
qlmanage -t -s 1024 -o "$BUILD" "$LOGO" >/dev/null 2>&1
BASE="$BUILD/logo.svg.png"
[ -f "$BASE" ] || { echo "icon render failed ($BASE missing)" >&2; exit 1; }

# app icon (.icns)
ICONSET="$BUILD/AppIcon.iconset"
mkdir -p "$ICONSET"
mk() { sips -z "$1" "$1" "$BASE" --out "$ICONSET/$2" >/dev/null; }
mk 16   icon_16x16.png
mk 32   icon_16x16@2x.png
mk 32   icon_32x32.png
mk 64   icon_32x32@2x.png
mk 128  icon_128x128.png
mk 256  icon_128x128@2x.png
mk 256  icon_256x256.png
mk 512  icon_256x256@2x.png
mk 512  icon_512x512.png
mk 1024 icon_512x512@2x.png
iconutil -c icns "$ICONSET" -o "$BUILD/AppIcon.icns"

# --- Compile the Swift menu bar binary ---
echo "Compiling…"
swiftc -O -o "$BUILD/SessionControllerBar" "$HERE/main.swift"

# --- Assemble the .app bundle ---
echo "Assembling bundle…"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/SessionControllerBar" "$APP/Contents/MacOS/SessionControllerBar"
cp "$BUILD/AppIcon.icns"        "$APP/Contents/Resources/AppIcon.icns"
# menu bar image: the SVG itself — NSImage renders it as a crisp, transparent vector
cp "$LOGO"                      "$APP/Contents/Resources/statusicon.svg"

# Launch script with absolute project + node/pnpm paths baked in (GUI apps don't
# inherit your shell PATH/nvm).
cat > "$APP/Contents/Resources/launch.sh" <<EOF
#!/bin/bash
# The Node version comes from the project's .nvmrc — never from whatever shell
# built this app. A mismatch silently breaks native modules (better-sqlite3's
# .node is compiled per ABI), and the server dies on the first DB open.
cd "$ROOT" || exit 1
# Board state lives beside the managed clone, never inside it, so a git sync
# can't touch it. Baked at build time from the repo's parent directory.
export DB_PATH="$(dirname "$ROOT")/data/traffic-controller.db"
mkdir -p "$(dirname "$ROOT")/data"
export NVM_DIR="\$HOME/.nvm"
if [ -s "\$NVM_DIR/nvm.sh" ]; then
  . "\$NVM_DIR/nvm.sh" >/dev/null 2>&1
  nvm use >/dev/null 2>&1 || nvm install >/dev/null 2>&1
fi
# Fallback for machines without nvm: the node/pnpm this bundle was built with.
command -v node >/dev/null 2>&1 || export PATH="$NODE_BIN:\$PATH"
PNPM="\$(command -v pnpm || echo "$PNPM")"
[ -d node_modules ] || "\$PNPM" install || exit 1
[ -d web/dist ] || "\$PNPM" ui:build || exit 1
exec "\$PNPM" start
EOF
chmod +x "$APP/Contents/Resources/launch.sh"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>               <string>Session Controller</string>
  <key>CFBundleDisplayName</key>        <string>Session Controller</string>
  <key>CFBundleIdentifier</key>         <string>de.kartenliebe.sessioncontroller</string>
  <key>CFBundleExecutable</key>         <string>SessionControllerBar</string>
  <key>CFBundleIconFile</key>           <string>AppIcon</string>
  <key>CFBundlePackageType</key>        <string>APPL</string>
  <key>CFBundleShortVersionString</key> <string>1.0</string>
  <key>CFBundleVersion</key>            <string>1</string>
  <key>LSMinimumSystemVersion</key>     <string>12.0</string>
  <key>LSUIElement</key>                <true/>
</dict>
</plist>
EOF

# Ad-hoc sign so macOS runs it without "damaged app" complaints.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo
echo "Built: $APP"
echo "Try it:   open \"$APP\""
echo "Install:  mv \"$APP\" /Applications/   (then add to System Settings → General → Login Items)"
