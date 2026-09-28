#!/bin/bash
# Claude Code hook → records this session's live state for the Session Controller board.
# Usage: tc-state.sh <working|needs-input|started|clear>
# The hook JSON payload arrives on stdin; we read session_id from it and write
# ~/.claude/tc-state/<session_id>.json = {"state","ts","event"[,"reason","askTool","askId"]}
# (atomically). `reason` records why a session waits on you — "asking" (a question or
# permission prompt, with the tool that asked) or "done" (its turn ended) — so a later tool
# event only clears the question when the tool that asked is the one finishing.
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
# tool events from a subagent carry the PARENT session_id, plus an agent_id
subagent = bool(p.get("agent_id"))
# the Notification types that mean a person has to act; everything else (idle nudge, login
# success, quota and auto-resume notices, a subagent finishing, …) must not raise "Needs you"
ASKING_NOTIFICATIONS = ("permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input")
TOOL_DONE_EVENTS = ("PostToolUse", "PostToolUseFailure", "PermissionDenied")

def previous():
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}

reason = ask_tool = ask_id = None
if state == "started":
    # A compaction restarts the session mid-turn: whatever it was doing, it still is.
    if p.get("source") == "compact":
        sys.exit(0)
elif state == "working" and event == "PreToolUse" and tool in ("AskUserQuestion", "ExitPlanMode"):
    # These tools fire PreToolUse but then block waiting on the user: a question, not work.
    state, reason, ask_tool, ask_id = "needs-input", "asking", tool, tool_id
elif state == "needs-input" and event in ("Stop", "StopFailure"):
    # StopFailure = the turn died from an API error (rate limit, overload, …); either way
    # it is your move now
    reason = "done"
elif state == "needs-input":
    msg = str(p.get("message") or "")
    if event == "Notification":
        ntype = p.get("notification_type")
        if ntype:
            if ntype not in ASKING_NOTIFICATIONS:
                sys.exit(0)
        elif "waiting for your input" in msg.lower():
            sys.exit(0)  # older Claude Code without notification_type: the idle nudge
    reason = "asking"
    m = re.search(r"permission to use (\S+)", msg)
    ask_tool = tool or (m.group(1) if m else None)
    ask_id = tool_id or None
elif state == "working":
    prev = previous()
    if prev.get("state") == "needs-input" and prev.get("reason") == "asking":
        if event in TOOL_DONE_EVENTS:
            # Parallel tools: another tool can finish while one waits on your permission.
            # Only the tool that asked may clear the question.
            if prev.get("askId") and tool_id:
                same = prev.get("askId") == tool_id
            else:
                same = bool(prev.get("askTool")) and prev.get("askTool") == tool
            if not same:
                sys.exit(0)
        elif subagent:
            # a (background) subagent starting another tool must not hide the question
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
# per-process temp file: parallel tool calls fire their hooks concurrently
tmp = "%s.%d.tmp" % (path, os.getpid())
with open(tmp, "w") as f:
    json.dump(out, f)
os.replace(tmp, path)
' "$STATE" "$DIR" 2>/dev/null
exit 0
