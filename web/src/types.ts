export type SessionSource = "cli" | "desktop";

export interface PrInfo {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  reviewDecision: string | null;
  url: string;
  title: string | null;
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
  stateSince?: number | null;
  lastEventSummary: string;
  linkedCliSessionId: string | null;
  note?: string | null;
  landed?: boolean;
  contextTokens?: number | null;
  contextPct?: number | null;
  pr?: PrInfo | null;
  approach?: boolean;
  offline?: boolean;
}

export type Lane = "inflight" | "mia" | "holding" | "approach" | "cold" | "landed";

export interface AnthropicStatus {
  indicator: string;
  description: string;
  components: { name: string; status: string }[];
  incidents: { name: string; impact: string; status: string; url: string }[];
  url: string;
  updatedAt: string;
  fetchedAt: number;
}

export type WsMessage =
  | { type: "snapshot" | "update"; ts: number; aircraft: Aircraft[] }
  | { type: "status"; ts: number; status: AnthropicStatus | null };
