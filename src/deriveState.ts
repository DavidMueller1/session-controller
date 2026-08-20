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
  // a tool that waits on the user (AskUserQuestion / ExitPlanMode) is unambiguously
  // "needs you" — no grace, and it takes priority even over the age window.
  if (f.tailKind === "assistant-ask") return ["needs-input", f.tailSummary];
  // an ESC interrupt is unambiguously "waiting on you" — no grace, priority over the window
  if (f.tailKind === "interrupt") return ["needs-input", f.tailSummary];
  if (f.tailKind === "assistant-text") {
    return [age > CONFIG.needsInputGraceMs ? "needs-input" : "working", f.tailSummary];
  }
  // assistant-tool | tool-result | human => work in motion. A tool ERROR is NOT terminal:
  // Claude almost always retries or finds another way, so we keep it "working" and never
  // auto-flip to go-around. Stays flying through normal gaps; goes "idle" (MIA) only after
  // a long radar silence, and never leaves the in-flight lane until dormant (Cold).
  return [age > CONFIG.miaAfterMs ? "idle" : "working", f.tailSummary];
}

function deriveDesktop(f: SessionFacts, now: number): [ActivityState, string] {
  if (f.archived) return ["suspected-done", "archived (system thinks it wrapped up)"];
  if (f.lastActivityAt == null) return ["unknown", "no activity timestamp"];
  const age = now - f.lastActivityAt;
  if (age > CONFIG.dormantMs) return ["dormant", "cold — no recent activity"];
  if (age > CONFIG.miaAfterMs) return ["idle", "no recent activity"];
  return ["working", "active"];
}

/** context tokens as a fraction of the window (auto-bumps to 1M past the default) */
function contextPctOf(tokens: number | null): number | null {
  if (tokens == null) return null;
  const base = CONFIG.contextWindow;
  const window = tokens > base ? 1_000_000 : base;
  return Math.min(1, tokens / window);
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
    contextTokens: f.contextTokens,
    contextPct: contextPctOf(f.contextTokens),
    continuedFrom: f.continuedFrom ?? null,
  };
}
