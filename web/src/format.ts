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
  // lives in the MIA rail → wears the muted MIA gray like its dormant/unknown neighbors
  "suspected-done": { lane: "mia", color: "#6b7688", label: "Wrapped up" },
  // idle = mid-work but gone quiet → the MIA rail ("lost contact").
  idle: { lane: "mia", color: "#6b7688", label: "MIA" },
  // Cold is no longer a state — it's the Landed overflow (see App.vue). Everything that
  // isn't actively in a lane and isn't landed lives in the MIA rail so nothing vanishes.
  dormant: { lane: "mia", color: "#6b7688", label: "Dormant" },
  unknown: { lane: "mia", color: "#6b7688", label: "Unknown" },
};

export function isMia(a: Aircraft): boolean {
  return a.state === "idle" && !a.landed;
}

export const LANDED_COLOR = "#2f6f4f";

export function laneOf(a: Aircraft): Lane {
  if (a.state === "working") return "inflight"; // a thinking session is ALWAYS in-flight
  if (a.landed) return "landed"; // human decision (App splits Landed→Cold by what fits on screen)
  if (a.approach) return "approach"; // merged PR → ready to land
  return STATE[a.state]?.lane ?? "mia"; // needs-input→holding · everything else quiet→MIA rail
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
