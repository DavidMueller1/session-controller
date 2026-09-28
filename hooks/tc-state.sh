#!/bin/bash
# Claude Code hook → records this session's live state for the Session Controller board.
# Usage: tc-state.sh <working|needs-input|clear>
# The hook JSON payload arrives on stdin; we read session_id from it and write
# ~/.claude/tc-state/<session_id>.json = {"state","ts","event"[,"reason","askTool","askId"]}
# (atomically). `reason` records why a session waits on you — "asking" (a question or
# permission prompt, with the tool that asked) or "done" (its turn ended) — so a later
# PostToolUse only clears the question when the tool that asked is the one finishing.
STATE="${1:-working}"
DIR="$HOME/.claude/tc-state"
mkdir -p "$DIR"
/usr/bin/python3 -c '
import sys, json, time, os, re
state, dirp = sys.argv[1], sys.argv[2]
try:
    p = json.load(sys.stdin)
except Exception:
    p = {}
sid = p.get("session_id") or p.get("sessionId")
if not sid:
    sys.exit(0)
path = os.path.join(dirp, str(sid) + ".json")
event = p.get("hook_event_name", "")
tool = p.get("tool_name") or p.get("toolName") or ""
tool_id = p.get("tool_use_id") or ""

def previous():
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}

reason = ask_tool = ask_id = None
if state == "working" and event == "PreToolUse" and tool in ("AskUserQuestion", "ExitPlanMode"):
    # These tools fire PreToolUse but then block waiting on the user: a question, not work.
    state, reason, ask_tool, ask_id = "needs-input", "asking", tool, tool_id
elif state == "needs-input" and event == "Stop":
    reason = "done"
elif state == "needs-input":
    msg = str(p.get("message") or "")
    # Claude Code nudges with a Notification after about a minute at the prompt. That is no
    # question: keep whatever we recorded (usually the turn that just ended).
    if event == "Notification" and "waiting for your input" in msg.lower():
        sys.exit(0)
    reason = "asking"
    m = re.search(r"permission to use (\S+)", msg)
    ask_tool = tool or (m.group(1) if m else None)
    ask_id = tool_id or None
elif state == "working" and event == "PostToolUse":
    # Parallel tools: a pre-approved tool can finish while another one waits on your
    # permission. Only the tool that asked may clear the question.
    prev = previous()
    if prev.get("state") == "needs-input" and prev.get("reason") == "asking":
        if prev.get("askId") and tool_id:
            same = prev.get("askId") == tool_id
        else:
            same = bool(prev.get("askTool")) and prev.get("askTool") == tool
        if not same:
            sys.exit(0)

if state == "clear":
    # Session ended: persist a terminal "ended" marker rather than deleting. Deleting
    # would drop the board back to transcript inference, which reads a just-exited
    # session (last turn = the user saying bye) as still "working" → stuck in-flight.
    state = "ended"
out = {"state": state, "ts": int(time.time() * 1000), "event": event}
if reason:
    out["reason"] = reason
if ask_tool:
    out["askTool"] = ask_tool
if ask_id:
    out["askId"] = ask_id
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(out, f)
os.replace(tmp, path)
' "$STATE" "$DIR" 2>/dev/null
exit 0
