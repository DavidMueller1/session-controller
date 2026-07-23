import path from "node:path";
import type { ActivityState, DiscoveredSession } from "./types.js";
import { formatAge, truncate } from "./util.js";

// minimal ANSI helpers (no dependency)
const useColor = process.stdout.isTTY;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  dim: wrap("2"),
  bold: wrap("1"),
  green: wrap("32"),
  yellow: wrap("93"),
  cyan: wrap("36"),
  gray: wrap("90"),
  magenta: wrap("35"),
  red: wrap("31"),
};

interface StateStyle {
  dot: string;
  label: string;
  paint: (s: string) => string;
  /** sort weight — lower floats to the top (most actionable first) */
  rank: number;
}

const STATE: Record<ActivityState, StateStyle> = {
  "needs-input": { dot: "◆", label: "HOLDING", paint: c.yellow, rank: 0 },
  error: { dot: "✖", label: "GO-AROUND", paint: c.red, rank: 1 },
  working: { dot: "●", label: "IN-FLIGHT", paint: c.green, rank: 2 },
  idle: { dot: "◌", label: "MIA", paint: c.cyan, rank: 3 },
  "suspected-done": { dot: "🛬", label: "APPROACH?", paint: c.magenta, rank: 4 },
  dormant: { dot: "○", label: "COLD", paint: c.gray, rank: 5 },
  unknown: { dot: "?", label: "UNKNOWN", paint: c.dim, rank: 6 },
};

function projectName(p: string | null): string {
  if (!p) return "—";
  // trim to the meaningful repo folder
  return path.basename(p) || p;
}

function row(s: DiscoveredSession, now: number): string {
  const st = STATE[s.state];
  const dot = st.paint(st.dot);
  const label = st.paint(st.label.padEnd(10));
  const surfaces = s.surfaces ?? [s.source];
  const srcLabel = surfaces.includes("cli") && surfaces.includes("desktop")
    ? "TERM+DT"
    : surfaces.includes("desktop")
      ? "DESKTOP"
      : "TERM   ";
  const src = c.dim(srcLabel);
  const proj = truncate(projectName(s.project), 22).padEnd(22);
  const branch = truncate(s.branch ?? "", 22).padEnd(22);
  const age = (s.lastActivityAt != null ? formatAge(now - s.lastActivityAt) : "—").padStart(5);
  const title = truncate(s.title ?? s.id, 34).padEnd(34);
  const summary = c.dim(truncate(s.lastEventSummary, 44));
  return ` ${dot} ${label} ${src}  ${c.bold(proj)} ${c.dim(branch)} ${age}  ${title} ${summary}`;
}

export function render(sessions: DiscoveredSession[], now: number, clear: boolean): void {
  const sorted = [...sessions].sort((a, b) => {
    const r = STATE[a.state].rank - STATE[b.state].rank;
    if (r !== 0) return r;
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  });

  const counts = sessions.reduce<Record<string, number>>((acc, s) => {
    acc[s.state] = (acc[s.state] ?? 0) + 1;
    return acc;
  }, {});
  const summaryLine = (Object.keys(STATE) as ActivityState[])
    .filter((k) => counts[k])
    .map((k) => STATE[k].paint(`${STATE[k].label} ${counts[k]}`))
    .join(c.dim(" · "));

  const lines: string[] = [];
  lines.push("");
  lines.push(c.bold("  ✈  TRAFFIC CONTROLLER") + c.dim("  — live session board"));
  lines.push(c.dim(`  ${sessions.length} aircraft tracked   ${new Date(now).toLocaleTimeString()}`));
  lines.push("  " + (summaryLine || c.dim("no sessions found")));
  lines.push("");
  lines.push(
    c.dim("   STATE      SOURCE   PROJECT                BRANCH                  AGE   TITLE                              CURRENT ACTIVITY"),
  );
  lines.push(c.dim("  " + "─".repeat(150)));
  for (const s of sorted) lines.push(row(s, now));
  lines.push("");
  lines.push(c.dim("  Ctrl-C to stop. Landing is a human decision — nothing here is terminal."));
  lines.push("");

  if (clear) process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(lines.join("\n") + "\n");
}
