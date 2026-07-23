import { CONFIG } from "./config.js";
import type { ActivityState, DiscoveredSession, SessionFacts } from "./types.js";

/**
 * Pure, time-dependent state derivation (Layer A, §5). Depends only on cached facts +
 * `now`, so it can run on a fast tick with no disk reads — this is what makes state
 * transitions (working→holding, working→idle) show up near-instantly instead of
 * waiting for the next file re-read.
 *
 * Rules: staleness wins first (anything past the dormant threshold is COLD — non-terminal,
 * overnight-safe). Within the recent window a finished assistant turn = awaiting you
 * (HOLDING) after a short grace; work-in-motion ages working → idle.
 */
function deriveCli(f: SessionFacts, now: number): [ActivityState, string] {
  const age = f.lastActivityAt != null ? now - f.lastActivityAt : Infinity;
  if (age > CONFIG.dormantMs) return ["dormant", f.tailSummary];
  if (f.tailKind === "none") return ["unknown", f.tailSummary];
  if (f.tailIsError) return ["error", f.tailSummary];
  if (f.tailKind === "assistant-text") {
    return [age > CONFIG.needsInputGraceMs ? "needs-input" : "working", f.tailSummary];
  }
  // assistant-tool | tool-result | human => work in motion
  return [age > CONFIG.workingWindowMs ? "idle" : "working", f.tailSummary];
}

function deriveDesktop(f: SessionFacts, now: number): [ActivityState, string] {
  if (f.archived) return ["suspected-done", "archived (system thinks it wrapped up)"];
  if (f.lastActivityAt == null) return ["unknown", "no activity timestamp"];
  const age = now - f.lastActivityAt;
  if (age > CONFIG.dormantMs) return ["dormant", "cold — no recent activity"];
  if (age > CONFIG.workingWindowMs) return ["idle", "idle"];
  return ["working", "active"];
}

/** facts + current time -> a fully resolved session (state included) */
export function resolve(f: SessionFacts, now: number): DiscoveredSession {
  const [state, lastEventSummary] = f.source === "cli" ? deriveCli(f, now) : deriveDesktop(f, now);
  return {
    id: f.id,
    source: f.source,
    path: f.path,
    project: f.project,
    branch: f.branch,
    title: f.title,
    model: f.model,
    firstSeenAt: f.firstSeenAt,
    lastActivityAt: f.lastActivityAt,
    state,
    lastEventSummary,
    linkedCliSessionId: f.linkedCliSessionId,
  };
}
