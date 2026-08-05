#!/bin/bash
# Claude Code hook → records this session's live state for the Session Controller board.
# Usage: tc-state.sh <working|needs-input|clear>
# The hook JSON payload arrives on stdin; we read session_id from it and write
# ~/.claude/tc-state/<session_id>.json = {"state","ts","event"} (atomically).
STATE="${1:-working}"
DIR="$HOME/.claude/tc-state"
mkdir -p "$DIR"
/usr/bin/python3 -c '
import sys, json, time, os
state, dirp = sys.argv[1], sys.argv[2]
try:
    p = json.load(sys.stdin)
except Exception:
    p = {}
sid = p.get("session_id") or p.get("sessionId")
if not sid:
    sys.exit(0)
path = os.path.join(dirp, str(sid) + ".json")
if state == "clear":
    try: os.remove(path)
    except OSError: pass
    sys.exit(0)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump({"state": state, "ts": int(time.time() * 1000), "event": p.get("hook_event_name", "")}, f)
os.replace(tmp, path)
' "$STATE" "$DIR" 2>/dev/null
exit 0
