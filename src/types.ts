export type SessionSource = "cli" | "desktop";

/** GitHub PR for a session's branch (via `gh`), attached by branch */
export interface PrInfo {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  reviewDecision: string | null;
  url: string;
  title: string | null;
}

/**
 * Layer-A activity state (§5 of CONCEPT.md). This is derived automatically and is
 * NEVER terminal — nothing here marks a feature "landed". `suspected-done` is a soft
 * hint only. Precise `needs-input` / `suspected-done` for CLI arrives in Phase 5 (hooks);
 * in Phase 1 they are inferred from transcript shape and desktop `isArchived`.
 */
export type ActivityState =
  | "working"
  | "needs-input"
  | "idle"
  | "dormant"
  | "suspected-done"
  | "error"
  | "unknown";

/** shape of the most recent conversational turn — the input to state derivation */
export type TailKind = "human" | "assistant-text" | "assistant-tool" | "assistant-ask" | "tool-result" | "none";

/**
 * The raw facts parsed from a session file, WITHOUT any time-dependent state. These
 * change only when the underlying file changes, so they can be cached and the state
 * re-derived cheaply (no disk I/O) on a fast tick — that's what makes working→holding
 * update near-instantly. See resolve() in deriveState.ts.
 */
export interface SessionFacts {
  id: string;
  source: SessionSource;
  path: string;
  project: string | null;
  branch: string | null;
  title: string | null;
  model: string | null;
  firstSeenAt: number | null;
  lastActivityAt: number | null;
  linkedCliSessionId: string | null;
  /** CLI: shape of the last conversational turn */
  tailKind: TailKind;
  tailIsError: boolean;
  tailSummary: string;
  /** context tokens in the most recent turn (input + cache_read + cache_creation) */
  contextTokens: number | null;
  /** desktop: session archived by the app (a "suspected done" signal) */
  archived?: boolean;
}

export interface DiscoveredSession {
  /** sessionId (or filename stem as fallback) */
  id: string;
  source: SessionSource;
  /** absolute path to the transcript (cli) or metadata json (desktop) */
  path: string;
  /** working directory / repo folder the session runs in */
  project: string | null;
  /** git branch, when the transcript reports one */
  branch: string | null;
  /** ai-title, session title, or first user line as a fallback label */
  title: string | null;
  model: string | null;
  firstSeenAt: number | null;
  /** timestamp of the last transcript event — used INTERNALLY for MIA/dormant timing, not shown */
  lastActivityAt: number | null;
  state: ActivityState;
  /** when the aircraft entered its current state — drives the displayed timer + ordering
   *  (so tool calls / thinking don't reset the clock or reshuffle the board) */
  stateSince?: number | null;
  /** one-line description of the most recent event */
  lastEventSummary: string;
  /** desktop→cli correlation key (§2b), when present */
  linkedCliSessionId: string | null;
  /**
   * Which surfaces this aircraft was seen on. A desktop session whose `cliSessionId`
   * matches a CLI transcript is the SAME work and gets merged into one aircraft with
   * `["cli", "desktop"]`. Absent = just its own `source`.
   */
  surfaces?: SessionSource[];
  /**
   * User-supplied note. NOT derived from files — populated by the server from the
   * notes store. A note on a `needs-input` aircraft turns it from flashing "Needs you"
   * into a steady "Parked" strip in the UI.
   */
  note?: string | null;
  /**
   * User marked this feature landed (done). NOT derived — a human decision (§5 of
   * CONCEPT.md). Overrides the activity lane so the aircraft sits in the Landed row.
   */
  landed?: boolean;
  /** context tokens used in the latest turn, and that as a fraction of the window */
  contextTokens?: number | null;
  contextPct?: number | null;
  /** PR for the branch (via gh), attached by branch. null = none/unknown */
  pr?: PrInfo | null;
  /** shown from the persisted store because it has no live file right now */
  offline?: boolean;
}
