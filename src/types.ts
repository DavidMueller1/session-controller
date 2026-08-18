export type SessionSource = "cli" | "desktop";

/**
 * Where an aircraft's live `state` actually came from, in priority order:
 * - "hook"     → our Claude Code hooks (most reliable, near-instant)
 * - "registry" → Claude Code's own live busy/idle signal
 * - "inferred" → transcript-timing inference (the ~8s-grace fallback path)
 * Surfaced so the UI can flag which sessions are on the slow inferred path.
 */
export type StateSource = "hook" | "registry" | "inferred";

/** Anthropic/Claude service status, from the public Statuspage API (status.claude.com) */
export interface AnthropicStatus {
  /** overall: none | minor | major | critical */
  indicator: string;
  description: string;
  /** only components that are NOT operational */
  components: { name: string; status: string }[];
  incidents: { name: string; impact: string; status: string; url: string }[];
  url: string;
  updatedAt: string;
  fetchedAt: number;
}

/** Health of the Claude Code hook pipeline that feeds live state to the board. */
export type HooksHealthStatus = "healthy" | "degraded" | "down";
export interface HooksHealth {
  status: HooksHealthStatus;
  /** at least one user-level settings file was found & parsed */
  settingsFound: boolean;
  /** our hook events actually wired in settings (reference tc-state.sh) */
  installedEvents: string[];
  /** required events NOT wired (drives "partially installed") */
  missingRequired: string[];
  /** tc-state files written within the stale window — proof the hooks are firing */
  freshWrites: number;
  lastWriteAt: number | null;
  /** active (working/needs-input) sessions, and of those the CLI ones (hook-capable) */
  activeSessions: number;
  activeCli: number;
  /** active sessions whose state came from transcript inference, not hook/registry */
  onFallback: number;
  /** human-readable one-liner for the banner */
  detail: string;
  checkedAt: number;
}

/** one listening port attributed to a strip's folder, with a best-effort description */
export interface DevPort {
  port: number;
  /** owning process pid */
  pid: number;
  /** bind interface as lsof reports it: "127.0.0.1" | "::1" | "*" */
  addr: string;
  /** short process label, e.g. "Vite", "node", "php" */
  proc: string;
  /** coarse role guess used for ranking + the list description */
  role: "app" | "api" | "hmr" | "storybook" | "unknown";
  /** human-readable one-liner, e.g. "Vite dev server", "Vite HMR", "NestJS (API)" */
  label: string;
}

/**
 * A dev server detected running in an aircraft's folder. Phase 1 is detection-only:
 * we find listening TCP ports owned by processes whose working directory is inside the
 * strip's git root — so a server you started by hand in a terminal shows up here
 * automatically. The port number alone can't tell us which is "the app" (real apps often
 * bind random high ports), so we carry every candidate + a scored best guess. (Phase 2
 * will add app-managed start/stop, which is why `managed` exists now.)
 */
export interface DevServerInfo {
  /** best-guess app port — drives the pill + its URL */
  port: number;
  /** pid owning the best-guess port */
  pid: number;
  /** every listening port in the folder, best-guess first, each described */
  candidates: DevPort[];
  /** true once the tower started it itself (Phase 2). Detection-only = false. */
  managed: boolean;
  /** the strip's repo identity (shared git dir), used to look up per-repo config */
  repoKey: string;
  /** friendly repo name (basename), for the settings list */
  repoName: string;
  /** per-repo dev URL template with a {port} placeholder; null = default localhost.
   *  Set by the server from project_config, not by the scanner. */
  urlTemplate: string | null;
}

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
  /** where `state` came from (hook / registry / inferred) — drives the signal-source tint */
  stateSource?: StateSource;
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
  /** merged-PR overlay (added by the server's decorate). Drives the Approach lane. */
  approach?: boolean;
  /** dev server detected running in this strip's folder (added by the server's decorate) */
  devServer?: DevServerInfo | null;
  /** the repo's configured dev command (null = not set) — enables the Start button */
  devCommand?: string | null;
  /** a tower-managed dev server running for this strip's folder — enables Stop + logs */
  devManaged?: { pid: number; startedAt: number } | null;
  /** a tower-managed server that recently exited unexpectedly (crash) — shows in the UI
   *  with its logs, instead of the Start button silently doing nothing */
  devExit?: { code: number | null; at: number } | null;
  /** install status for the strip's repo (null = not a git repo). Drives the Install
   *  button: running while `pnpm install` runs, `code` is the last exit (0 = ok). */
  devInstall?: { running: boolean; code: number | null; at: number } | null;
  /** shown from the persisted store because it has no live file right now */
  offline?: boolean;
}
