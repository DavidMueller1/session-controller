export type SessionSource = "cli" | "desktop";

/** where an aircraft's live `state` came from (hook = best, inferred = slow fallback) */
export type StateSource = "hook" | "registry" | "inferred";

export interface PrInfo {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  reviewDecision: string | null;
  url: string;
  title: string | null;
}

/** one listening port attributed to a strip's folder, with a best-effort description */
export interface DevPort {
  port: number;
  pid: number;
  addr: string;
  proc: string;
  role: "app" | "api" | "hmr" | "storybook" | "unknown";
  label: string;
}

/** dev servers detected listening in this strip's folder (Phase 1: detection-only) */
export interface DevServerInfo {
  /** best-guess app port — drives the pill + its URL */
  port: number;
  pid: number;
  /** every listening port in the folder, best-guess first, each described */
  candidates: DevPort[];
  managed: boolean;
  repoKey: string;
  repoName: string;
  /** per-repo dev URL template with a {port} placeholder; null = default localhost */
  urlTemplate: string | null;
}

export type ActivityState =
  | "working"
  | "needs-input"
  | "idle"
  | "dormant"
  | "suspected-done"
  | "error"
  | "unknown";

export interface Aircraft {
  id: string;
  source: SessionSource;
  surfaces?: SessionSource[];
  path: string;
  project: string | null;
  branch: string | null;
  title: string | null;
  model: string | null;
  firstSeenAt: number | null;
  lastActivityAt: number | null;
  state: ActivityState;
  stateSource?: StateSource;
  stateSince?: number | null;
  lastEventSummary: string;
  linkedCliSessionId: string | null;
  note?: string | null;
  landed?: boolean;
  contextTokens?: number | null;
  contextPct?: number | null;
  pr?: PrInfo | null;
  approach?: boolean;
  devServer?: DevServerInfo | null;
  /** the repo's configured dev command (null = not set) — enables the Start button */
  devCommand?: string | null;
  /** a tower-managed dev server running for this strip's folder — enables Stop + logs */
  devManaged?: { pid: number; startedAt: number } | null;
  /** a tower-managed server that recently crashed — shows an "exited" affordance + logs */
  devExit?: { code: number | null; at: number } | null;
  /** install status for the strip's repo (null = not a git repo) — drives the Install button */
  devInstall?: { running: boolean; code: number | null; at: number } | null;
  offline?: boolean;
}

export type Lane = "inflight" | "mia" | "holding" | "parked" | "cold" | "landed";

export interface AnthropicStatus {
  indicator: string;
  description: string;
  components: { name: string; status: string }[];
  incidents: { name: string; impact: string; status: string; url: string }[];
  url: string;
  updatedAt: string;
  fetchedAt: number;
}

export type HooksHealthStatus = "healthy" | "degraded" | "down";
export interface HooksHealth {
  status: HooksHealthStatus;
  settingsFound: boolean;
  installedEvents: string[];
  missingRequired: string[];
  freshWrites: number;
  lastWriteAt: number | null;
  activeSessions: number;
  activeCli: number;
  onFallback: number;
  detail: string;
  checkedAt: number;
}

export type WsMessage =
  | { type: "snapshot" | "update"; ts: number; aircraft: Aircraft[] }
  | { type: "status"; ts: number; status: AnthropicStatus | null }
  | { type: "health"; ts: number; health: HooksHealth | null }
  | {
      type: "version";
      ts: number;
      current: { build: number | null; sha: string; pretty: string };
      updateAvailable: boolean;
      latest: { build: number | null; sha: string; pretty: string } | null;
    };
