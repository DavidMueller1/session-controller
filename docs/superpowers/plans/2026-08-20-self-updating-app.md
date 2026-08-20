# Self-updating App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Session Controller menu-bar app keep itself up to date automatically by syncing a managed git clone to `main` and rebuilding only what changed.

**Architecture:** A dedicated app-owned clone at `~/Library/Application Support/Session Controller/repo` is the runtime. A standalone shell script (`scripts/update.sh`) is the update engine — it fetches, compares against `origin/main`, hard-syncs, rebuilds only the changed parts, and signals its outcome via exit code. The Swift menu-bar app is the orchestrator: it runs the engine on a timer and, based on the exit code, restarts the server or relaunches itself. `install.sh` becomes a bootstrap that creates the managed clone.

**Tech Stack:** Bash, git, Node 22 (tsx/Fastify/better-sqlite3), pnpm (workspace), Swift/Cocoa (menu-bar app), macOS.

**Spec:** `docs/superpowers/specs/2026-08-20-self-updating-app-design.md`

## Global Constraints

- **macOS only.** No code signing / notarization — the app is built on-device, so it is never quarantined. Do not add any download-a-prebuilt-binary path.
- **Node comes from `.nvmrc` (= `22`)** everywhere Node runs (launch, install, update), resolved via `nvm use`. Never bake a fixed Node path as the primary source.
- **pnpm is pinned** via `package.json` `packageManager: pnpm@11.22.0`; native builds are allow-listed in `pnpm-workspace.yaml` (`allowBuilds: better-sqlite3, esbuild`). Do not reintroduce `pnpm.onlyBuiltDependencies`.
- **Managed paths (exact):**
  - Support dir: `~/Library/Application Support/Session Controller`
  - Repo clone: `~/Library/Application Support/Session Controller/repo`
  - Data (DB + logs): `~/Library/Application Support/Session Controller/data`
  - App bundle: `/Applications/Session Controller.app`
  - Repo URL: `https://github.com/DavidMueller1/session-controller.git`
- **Tracked branch: `main`.** Every push to `main` is an update for all installs.
- **The auto-updater only ever touches the managed clone** — never a developer checkout.
- **Exit-code contract** between `update.sh` and the app: `0` = no-op, `10` = updated → restart server, `20` = updated + `.app` rebuilt → relaunch app, `1` = error (rolled back / offline).

---

## File Structure

- **Create** `scripts/update.sh` — the update engine (git sync + conditional rebuild + exit-code signalling). One responsibility: turn "origin moved" into "local rebuilt & signalled."
- **Create** `scripts/test-update.sh` — bash test harness for `update.sh` using throwaway git repos and a stubbed build phase (no network, no pnpm/swiftc).
- **Modify** `menubar/build.sh` — the generated `launch.sh` also exports `DB_PATH` into `<support>/data`, so board state lives outside the repo.
- **Modify** `install.sh` — clone into the managed dir and build there (instead of adopting the current checkout); add test seams (`TC_SUPPORT`, `TC_REPO_URL`, `TC_INSTALL_CLONE_ONLY`).
- **Modify** `menubar/main.swift` — schedule update checks, run the engine, react to exit codes (restart server / self-relaunch), show version + a manual "Check for Updates Now".

Task order: **1 → 2 → 3 → 4.** Task 1 (engine) is pure and fully tested first; Task 2 relocates data (needed before the managed model makes sense); Task 3 wires the bootstrap; Task 4 drives it from the app.

---

## Task 1: `scripts/update.sh` — the update engine

**Files:**
- Create: `scripts/update.sh`
- Test: `scripts/test-update.sh`

**Interfaces:**
- Consumes: nothing from other tasks. Reads its own repo (resolved from `BASH_SOURCE`), `origin/main`, and env seams.
- Produces: the executable `scripts/update.sh` with the exit-code contract (`0/10/20/1`). Task 4 invokes it as `/bin/bash "<managed-repo>/scripts/update.sh"` and switches on the exit status. Env seams it honors: `TC_SUPPORT` (override support dir), `TC_BRANCH` (default `main`), `TC_SKIP_NVM=1` (skip Node resolution), `TC_UPDATE_HOOK` (path to a file sourced after the defaults, used to override `apply_build` in tests).

- [ ] **Step 1: Write the failing test**

Create `scripts/test-update.sh`:

```bash
#!/bin/bash
# Exercises scripts/update.sh against throwaway git repos. No network, no
# pnpm/swiftc: the build phase is stubbed via TC_UPDATE_HOOK.
set -uo pipefail

fail=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # the real scripts/ dir

pass() { echo "  ok:   $1"; }
bad()  { echo "  FAIL: $1"; fail=1; }

# fake build hook: records the changed-set it was handed; can be forced to fail
HOOK="$WORK/hook.sh"
cat > "$HOOK" <<'EOF'
apply_build() {
  printf '%s\n' "$1" >> "$TC_TEST_CALLS"
  [ "${TC_TEST_FAIL:-0}" = "1" ] && return 1
  return 0
}
EOF

git_c() { git -C "$1" -c user.email=t@t -c user.name=t "${@:2}"; }

# seed an upstream repo that contains the real update.sh
UP="$WORK/upstream"
mkdir -p "$UP/scripts" "$UP/web" "$UP/menubar" "$UP/src"
cp "$SELF_DIR/update.sh" "$UP/scripts/update.sh"
echo lock > "$UP/pnpm-lock.yaml"; echo app > "$UP/web/app.ts"
echo swift > "$UP/menubar/main.swift"; echo srv > "$UP/src/server.ts"
git -C "$UP" init -b main -q
git_c "$UP" add -A; git_c "$UP" commit -qm init

# managed clone + isolated support dir
MAN="$WORK/managed"; git clone -q "$UP" "$MAN"
SUP="$WORK/support"; mkdir -p "$SUP"

run_update() {  # $1 = TC_TEST_FAIL (default 0)
  TC_SKIP_NVM=1 TC_SUPPORT="$SUP" TC_BRANCH=main \
  TC_UPDATE_HOOK="$HOOK" TC_TEST_CALLS="$WORK/calls" TC_TEST_FAIL="${1:-0}" \
  bash "$MAN/scripts/update.sh"
}
commit_upstream() {  # $1 = path, $2 = message
  echo "change $(git -C "$UP" rev-list --count HEAD)" >> "$UP/$1"
  git_c "$UP" add -A; git_c "$UP" commit -qm "$2"
}

# Case 1: no new commits -> 0
: > "$WORK/calls"; run_update; rc=$?
[ $rc -eq 0 ] && pass "no-op exits 0" || bad "no-op expected 0, got $rc"

# Case 2: web/ change -> 10, synced, build saw it
commit_upstream web/app.ts "web change"; : > "$WORK/calls"; run_update; rc=$?
[ $rc -eq 10 ] && pass "web change exits 10" || bad "web expected 10, got $rc"
[ "$(git -C "$MAN" rev-parse HEAD)" = "$(git -C "$UP" rev-parse HEAD)" ] \
  && pass "managed synced to upstream" || bad "managed HEAD not synced"
grep -q "web/app.ts" "$WORK/calls" && pass "build saw web change" || bad "build missing web change"

# Case 3: menubar/ change -> 20
commit_upstream menubar/main.swift "menubar change"; run_update; rc=$?
[ $rc -eq 20 ] && pass "menubar change exits 20" || bad "menubar expected 20, got $rc"

# Case 4: build failure -> 1 and rollback
BEFORE="$(git -C "$MAN" rev-parse HEAD)"
commit_upstream src/server.ts "src change (build will fail)"
run_update 1; rc=$?
[ $rc -eq 1 ] && pass "build failure exits 1" || bad "failure expected 1, got $rc"
[ "$(git -C "$MAN" rev-parse HEAD)" = "$BEFORE" ] \
  && pass "rolled back to pre-update HEAD" || bad "did not roll back"

echo; [ $fail -eq 0 ] && echo "ALL PASS" || echo "FAILURES"; exit $fail
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash scripts/test-update.sh`
Expected: FAIL — `update.sh` does not exist yet, so the copy in the harness is empty/missing and every case errors (non-zero, "ALL PASS" not printed).

- [ ] **Step 3: Write the engine**

Create `scripts/update.sh`:

```bash
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
```

- [ ] **Step 4: Make both scripts executable**

Run: `chmod +x scripts/update.sh scripts/test-update.sh`

- [ ] **Step 5: Run the test to verify it passes**

Run: `bash scripts/test-update.sh`
Expected: PASS — every case prints `ok:` and the final line is `ALL PASS` (exit 0).

- [ ] **Step 6: Commit**

```bash
git add scripts/update.sh scripts/test-update.sh
git commit -m "Add self-update engine (scripts/update.sh) with a git-based test harness"
```

---

## Task 2: `menubar/build.sh` — relocate board data to the support dir

The generated `launch.sh` must point `DB_PATH` at `<support>/data` so a hard `git` sync never risks the SQLite DB. `<support>` is the parent of the repo root (`$ROOT`), computed at build time.

**Files:**
- Modify: `menubar/build.sh` (the `launch.sh` heredoc, around lines 59-68)

**Interfaces:**
- Consumes: `$ROOT` (already defined in `build.sh` as the repo root) and `$NODE_BIN` / `$PNPM` (already defined).
- Produces: a `launch.sh` inside the bundle that exports `DB_PATH="<dirname $ROOT>/data/traffic-controller.db"` before starting the server. `CONFIG.dbPath` in `src/config.ts` already honors `DB_PATH`; `DevRunner` derives its log dir from `path.dirname(dbPath)`, so both DB and dev-server logs follow.

- [ ] **Step 1: Add the DB_PATH export to the generated launch.sh**

In `menubar/build.sh`, the `launch.sh` heredoc currently begins:

```bash
cat > "$APP/Contents/Resources/launch.sh" <<EOF
#!/bin/bash
# The Node version comes from the project's .nvmrc — never from whatever shell
# built this app. A mismatch silently breaks native modules (better-sqlite3's
# .node is compiled per ABI), and the server dies on the first DB open.
cd "$ROOT" || exit 1
export NVM_DIR="\$HOME/.nvm"
```

Insert two lines immediately after the `cd "$ROOT" || exit 1` line (note: `$(dirname "$ROOT")` is intentionally **unescaped** so it expands at build time to the literal support/data path and gets baked into the file):

```bash
cd "$ROOT" || exit 1
# Board state lives beside the managed clone, never inside it, so a git sync
# can't touch it. Baked at build time from the repo's parent directory.
export DB_PATH="$(dirname "$ROOT")/data/traffic-controller.db"
mkdir -p "$(dirname "$ROOT")/data"
export NVM_DIR="\$HOME/.nvm"
```

- [ ] **Step 2: Rebuild the app and inspect the generated launch.sh**

Run:
```bash
nvm use && bash menubar/build.sh >/dev/null && \
grep -n 'DB_PATH' "menubar/build/Session Controller.app/Contents/Resources/launch.sh"
```
Expected: one line `export DB_PATH="<parent-of-repo>/data/traffic-controller.db"` where `<parent-of-repo>` is the directory containing this checkout (during a dev build) — i.e. the path is `$(dirname "$ROOT")/data/...`, an absolute path, not the literal string `$(dirname ...)`.

- [ ] **Step 3: Commit**

```bash
git add menubar/build.sh
git commit -m "Menubar app: store the DB + logs beside the managed clone (DB_PATH in launch.sh)"
```

---

## Task 3: `install.sh` — bootstrap into a managed clone

`install.sh` stops adopting the checkout it runs in and instead clones into the managed dir and builds there. This also enables `curl … | bash` installs (no manual clone). Test seams let the clone logic be exercised against a local upstream without touching `/Applications` or the network.

**Files:**
- Modify: `install.sh` (whole-file restructure; keep the pretty-output helpers)

**Interfaces:**
- Consumes: `menubar/build.sh` (Task 2) from inside the managed clone; `scripts/update.sh` (Task 1) ships in the clone for Task 4 to run.
- Produces: a populated `~/Library/Application Support/Session Controller/{repo,data}`, a built `/Applications/Session Controller.app`, wired hooks, and a Login Item. Env seams: `TC_SUPPORT` (override support dir), `TC_REPO_URL` (clone source — a local path in tests), `TC_INSTALL_CLONE_ONLY=1` (exit right after clone+data dir, before toolchain/build/app).

- [ ] **Step 1: Replace install.sh with the managed-clone bootstrap**

Replace the entire body of `install.sh` (keep the shebang) with:

```bash
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
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install >/dev/null   # reads .nvmrc
nvm use >/dev/null
ok "node $(node -v)"
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@latest --activate >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1
fi
command -v pnpm >/dev/null 2>&1 || die "Could not install pnpm."
ok "pnpm $(pnpm -v)"

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
```

- [ ] **Step 2: Verify the managed-clone logic against a local upstream (no network, no /Applications)**

Run:
```bash
TMP="$(mktemp -d)"; UP="$TMP/upstream"
git init -b main -q "$UP" && (cd "$UP" && echo x > f && \
  git -c user.email=t@t -c user.name=t add -A && \
  git -c user.email=t@t -c user.name=t commit -qm init)
TC_SUPPORT="$TMP/support" TC_REPO_URL="$UP" TC_INSTALL_CLONE_ONLY=1 bash install.sh
echo "--- checks ---"
[ -d "$TMP/support/repo/.git" ] && echo "repo cloned OK" || echo "MISSING repo"
[ -d "$TMP/support/data" ] && echo "data dir OK" || echo "MISSING data"
# idempotent second run takes the fetch+reset branch
TC_SUPPORT="$TMP/support" TC_REPO_URL="$UP" TC_INSTALL_CLONE_ONLY=1 bash install.sh >/dev/null && echo "re-run OK"
rm -rf "$TMP"
```
Expected: `repo cloned OK`, `data dir OK`, `re-run OK`.

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "install.sh: bootstrap into a managed clone (enables auto-update + curl install)"
```

---

## Task 4: `menubar/main.swift` — schedule + orchestrate updates

The app runs `update.sh` on launch and every 30 minutes (and on demand), then acts on the exit code. It only ever targets the fixed managed clone, so it can never auto-sync a developer checkout.

**Files:**
- Modify: `menubar/main.swift`

**Interfaces:**
- Consumes: `scripts/update.sh` (Task 1) at the fixed path `~/Library/Application Support/Session Controller/repo/scripts/update.sh`, and its exit-code contract (`0/10/20/1`).
- Produces: no code consumed by other tasks (leaf).

- [ ] **Step 1: Add update constants**

In `menubar/main.swift`, after the existing `let kBase = "http://localhost:\(kPort)"` line, add:

```swift
// The auto-updater targets ONLY the managed clone — never a dev checkout.
let kRepo = ("~/Library/Application Support/Session Controller/repo" as NSString).expandingTildeInPath
let kUpdateScript = kRepo + "/scripts/update.sh"
let kUpdateInterval: TimeInterval = 30 * 60   // 30 minutes
```

- [ ] **Step 2: Add update state + menu items**

In `AppDelegate`, alongside the existing `var pollTimer: Timer?` etc., add:

```swift
var updateTimer: Timer?
var checkingUpdate = false
let versionItem = NSMenuItem(title: "Checking…", action: nil, keyEquivalent: "")
let checkUpdateItem = NSMenuItem(title: "Check for Updates Now", action: #selector(checkForUpdatesClicked), keyEquivalent: "u")
```

- [ ] **Step 3: Wire the new menu items and schedule checks in `applicationDidFinishLaunching`**

In the menu-building block, after `menu.addItem(openItem)` (and before `startItem`), add the version line; and register `checkUpdateItem`'s target. Locate:

```swift
        for item in [openItem, startItem, stopItem] { item.target = self }
        menu.addItem(headerItem)
        menu.addItem(.separator())
        menu.addItem(openItem)
        menu.addItem(startItem)
        menu.addItem(stopItem)
```

Replace with:

```swift
        for item in [openItem, startItem, stopItem, checkUpdateItem] { item.target = self }
        versionItem.isEnabled = false
        menu.addItem(headerItem)
        menu.addItem(.separator())
        menu.addItem(openItem)
        menu.addItem(startItem)
        menu.addItem(stopItem)
        menu.addItem(.separator())
        menu.addItem(versionItem)
        menu.addItem(checkUpdateItem)
```

Then, at the end of `applicationDidFinishLaunching` (after the existing auto-start `if !isPortOpen() { start() }`), add:

```swift
        refreshVersion()
        // First check shortly after launch, then on an interval.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.runUpdateCheck() }
        updateTimer = Timer.scheduledTimer(withTimeInterval: kUpdateInterval, repeats: true) { [weak self] _ in self?.runUpdateCheck() }
```

- [ ] **Step 4: Add the update orchestration methods**

Add these methods to `AppDelegate` (e.g. after `openDashboard`):

```swift
    @objc func checkForUpdatesClicked() { runUpdateCheck() }

    func runUpdateCheck() {
        guard !checkingUpdate else { return }
        guard FileManager.default.fileExists(atPath: kUpdateScript) else { return }
        checkingUpdate = true
        versionItem.title = "Updating…"
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let code = self?.runCode("/bin/bash", [kUpdateScript]) ?? -1
            DispatchQueue.main.async {
                self?.checkingUpdate = false
                switch code {
                case 10: self?.restartServer()
                case 20: self?.relaunchApp(); return   // process is terminating
                case 1:  self?.versionItem.title = "Update failed — staying put"
                default: break
                }
                self?.refreshVersion()
            }
        }
    }

    func restartServer() {
        killPort(force: true)
        serverProcess?.terminate(); serverProcess = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.start() }
    }

    func relaunchApp() {
        // Wait for THIS process to exit (freeing the port), then open the freshly
        // installed bundle — avoids two instances fighting over :4317.
        let pid = ProcessInfo.processInfo.processIdentifier
        let helper = "while kill -0 \(pid) 2>/dev/null; do sleep 0.2; done; sleep 0.5; open \"/Applications/Session Controller.app\""
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", helper]
        try? p.run()
        killPort(force: true)
        NSApp.terminate(nil)
    }

    func refreshVersion() {
        let v = run("/usr/bin/git", ["-C", kRepo, "describe", "--tags", "--always"])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        versionItem.title = v.isEmpty ? "Session Controller" : "Version \(v)"
    }

    // Like run(), but returns the process exit code instead of stdout.
    @discardableResult
    func runCode(_ launchPath: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: launchPath)
        p.arguments = args
        p.standardOutput = Pipe(); p.standardError = Pipe()
        do { try p.run() } catch { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
    }
```

- [ ] **Step 5: Compile-check the Swift source**

Run: `swiftc -O -o /tmp/sc-swiftcheck menubar/main.swift && echo OK && rm -f /tmp/sc-swiftcheck`
Expected: `OK` (no compile errors).

- [ ] **Step 6: Manual live verification**

There is no XCTest harness in this repo; verify against a real managed install.

1. Ensure an installed managed clone exists: `bash install.sh` (or confirm `~/Library/Application Support/Session Controller/repo` is present and the app is running).
2. **Exit-10 path (server restart):** in the managed clone, move it one commit behind so a fetch sees an update, then trigger a check:
   ```bash
   git -C ~/Library/Application\ Support/Session\ Controller/repo reset --hard HEAD~1
   ```
   Menu → **Check for Updates Now**. Then:
   ```bash
   tail -5 ~/Library/Application\ Support/Session\ Controller/update.log
   curl -fsS http://127.0.0.1:4317/api/health
   lsof -ti tcp:4317 -sTCP:LISTEN | wc -l   # expect exactly 1
   ```
   Expected: log shows `updating … -> …` then `updated to …`; `/api/health` returns `{"ok":true,…}`; exactly one listener on `:4317`; the menu's Version line updates.
3. **Exit-20 path (self-relaunch):** repeat with a HEAD that is behind a commit touching `menubar/`, trigger a check, and confirm the app quits and a fresh instance comes back with exactly one `:4317` listener and a healthy `/api/health`.

- [ ] **Step 7: Commit**

```bash
git add menubar/main.swift
git commit -m "Menubar app: auto-update from the managed clone (restart on JS changes, relaunch on app changes)"
```

---

## Self-Review

**Spec coverage:**
- Layout (managed `repo`/`data`, DB outside repo) → Task 2 (DB_PATH) + Task 3 (creates dirs). ✓
- `install.sh` bootstrap + curl install → Task 3. ✓
- `update.sh` engine (fetch/compare/reset/classify/rebuild/rollback/lock) → Task 1. ✓
- Exit-code contract `0/10/20/1` → Task 1 defines, Task 4 consumes. ✓
- Menu-bar orchestration (schedule, restart on 10, relaunch on 20, version, manual check) → Task 4. ✓
- Exit-20 wait-for-exit self-relaunch → Task 4 Step 4 (`relaunchApp`). ✓
- Track `main` automatically → `update.sh` compares `origin/main`; Task 4 timer. ✓
- Node-from-`.nvmrc` in update path (ABI safety) → Task 1 nvm prelude + conditional `pnpm install`. ✓
- Failure handling (rollback, offline no-op, lock) → Task 1 (tested cases 1 & 4). ✓
- Trust boundary = CODEOWNERS review on `main` → already enforced (branch protection); no code task needed.

**Placeholder scan:** No TBD/TODO; every code step contains full content; the one manual-verification task (Task 4 Step 6) lists exact commands and expected output rather than "test it."

**Type/name consistency:** `apply_build` (Task 1) is the sole name the test hook overrides (Task 1 harness). Exit codes `0/10/20/1` are identical in Task 1's contract and Task 4's `switch`. `runCode`/`run`/`killPort`/`start`/`serverProcess`/`isPortOpen` in Task 4 match the existing `main.swift` symbols. `DB_PATH` (Task 2) matches `CONFIG.dbPath`'s env read in `src/config.ts`. `TC_SUPPORT`/`TC_BRANCH`/`TC_SKIP_NVM`/`TC_UPDATE_HOOK` are consistent between `update.sh` and its harness; `TC_SUPPORT`/`TC_REPO_URL`/`TC_INSTALL_CLONE_ONLY` between `install.sh` and its verification.
