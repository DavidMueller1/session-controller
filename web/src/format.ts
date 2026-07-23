import type { Aircraft, ActivityState, Lane } from "./types";

interface StateMeta {
  lane: Lane;
  color: string;
  label: string;
}

/** state → lane + control-tower color + badge label */
export const STATE: Record<ActivityState, StateMeta> = {
  working: { lane: "inflight", color: "#3fb950", label: "In-flight" },
  "needs-input": { lane: "holding", color: "#e0a92e", label: "Needs you" },
  error: { lane: "holding", color: "#f85149", label: "Go-around" },
  // archived desktop sessions are done-ish; the Approach lane is now driven by the
  // server's `approach` flag (merged PR), not by this state.
  "suspected-done": { lane: "cold", color: "#58a6ff", label: "Wrapped up" },
  // idle stays in the in-flight lane — a mid-work session that's gone quiet is still
  // flying, just "lost contact" (rendered with a soft MIA badge).
  idle: { lane: "inflight", color: "#6b7688", label: "MIA" },
  dormant: { lane: "cold", color: "#4d5560", label: "Cold" },
  unknown: { lane: "cold", color: "#4d5560", label: "Unknown" },
};

export function isMia(a: Aircraft): boolean {
  return a.state === "idle" && !a.landed;
}

export const LANDED_COLOR = "#2f6f4f";

export function laneOf(a: Aircraft): Lane {
  if (a.landed) return "landed"; // human decision overrides everything
  if (a.approach) return "approach"; // merged PR (not go-around'd) → ready to land
  return STATE[a.state]?.lane ?? "cold";
}

/** a needs-input aircraft with a note is "parked" (steady, triaged) rather than flashing */
export function isParked(a: Aircraft): boolean {
  return a.state === "needs-input" && !!a.note;
}

export function isFlashing(a: Aircraft): boolean {
  return (a.state === "needs-input" || a.state === "error") && !a.note;
}

export function formatAge(ms: number | null): string {
  if (ms == null || !isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function projectName(p: string | null): string {
  if (!p) return "—";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}
