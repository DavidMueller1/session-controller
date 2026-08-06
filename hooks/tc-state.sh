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
# Some tools fire PreToolUse (which we treat as "working") but then block waiting on the
# user — AskUserQuestion, plan approval. The session is actually waiting on you, not
# in-flight, so flip those to needs-input.
tool = p.get("tool_name") or p.get("toolName") or ""
if state == "working" and tool in ("AskUserQuestion", "ExitPlanMode"):
    state = "needs-input"
path = os.path.join(dirp, str(sid) + ".json")
if state == "clear":
    # Session ended: persist a terminal "ended" marker rather than deleting. Deleting
    # would drop the board back to transcript inference, which reads a just-exited
    # session (last turn = the user saying bye) as still "working" → stuck in-flight.
    state = "ended"
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump({"state": state, "ts": int(time.time() * 1000), "event": p.get("hook_event_name", "")}, f)
os.replace(tmp, path)
' "$STATE" "$DIR" 2>/dev/null
exit 0
