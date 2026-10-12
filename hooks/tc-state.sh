#!/bin/bash
# Claude Code hook → records this session's live state for the Session Controller board.
# Usage: tc-state.sh <working|needs-input|started|clear|subagent-start|subagent-stop>
# The hook JSON payload arrives on stdin; we read session_id from it and write
# ~/.claude/tc-state/<session_id>.json = {"state","ts","event"[,"reason","askTool","askId"]}
# (atomically). `reason` records why a session waits on you — "asking" (a question or
# permission prompt, with the tool that asked) or "done" (its turn ended) — so a later tool
# event only clears the question when the tool that asked is the one finishing.
# Running subagents get one marker file each in ~/.claude/tc-state/agents/<session_id>/, so a
# turn that ends while background subagents still work reads as working, not "Needs you".
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
# one marker per running subagent; a marker nobody touched for this long is a leftover
# (a SubagentStop that never fired) and no longer counts
agents_dir = os.path.join(dirp, "agents", str(sid))
AGENT_STALE_S = 30 * 60

def running_agents():
    try:
        names = os.listdir(agents_dir)
    except Exception:
        return 0
    n, now = 0, time.time()
    for name in names:
        f = os.path.join(agents_dir, name)
        try:
            if now - os.path.getmtime(f) < AGENT_STALE_S:
                n += 1
            else:
                os.remove(f)
        except Exception:
            pass
    return n

if subagent:
    marker = os.path.join(agents_dir, re.sub(r"[^A-Za-z0-9_-]", "_", str(p.get("agent_id"))))
    try:
        if state == "subagent-start":
            os.makedirs(agents_dir, exist_ok=True)
            open(marker, "a").close()
        elif state == "subagent-stop":
            os.remove(marker)
        elif os.path.exists(marker):
            os.utime(marker)  # the subagent is still busy: keep its marker fresh
    except Exception:
        pass

def previous():
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}

reason = ask_tool = ask_id = None
if state in ("subagent-start", "subagent-stop"):
    # A subagent began or finished. Never hide a question; otherwise the session works on
    # (after the last subagent, Claude picks up its result in a new turn and Stop follows).
    prev = previous()
    if prev.get("state") == "needs-input" and prev.get("reason") == "asking":
        sys.exit(0)
    state = "working"
elif state == "needs-input" and event in ("Stop", "SubagentStop") and subagent:
    sys.exit(0)  # a subagent ending is not the session ending its turn
elif state == "needs-input" and event == "Stop" and running_agents():
    # The turn ended, but background subagents still work: Claude is not waiting on you.
    state = "working"
elif state == "started":
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
    import shutil
    shutil.rmtree(agents_dir, ignore_errors=True)
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
agents = running_agents() if state == "working" else 0
if agents:
    out["agents"] = agents
# per-process temp file: parallel tool calls fire their hooks concurrently
tmp = "%s.%d.tmp" % (path, os.getpid())
with open(tmp, "w") as f:
    json.dump(out, f)
os.replace(tmp, path)
' "$STATE" "$DIR" 2>/dev/null
exit 0
