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
