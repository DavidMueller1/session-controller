export function firstLine(s: string | null | undefined): string {
  if (!s) return "";
  const line = s.replace(/\s+/g, " ").trim();
  return line;
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** human-friendly age, e.g. 12s / 3m / 2h / 1d */
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
