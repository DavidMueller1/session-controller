export type SessionSource = "cli" | "desktop";

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
  lastEventSummary: string;
  linkedCliSessionId: string | null;
  note?: string | null;
}

export type Lane = "inflight" | "holding" | "approach" | "taxiing" | "cold";

export interface WsMessage {
  type: "snapshot" | "update";
  ts: number;
  aircraft: Aircraft[];
}
