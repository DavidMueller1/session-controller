import { execFileSync } from "node:child_process";

/**
 * Build identity derived from git, so "did my update land?" is answerable at a glance —
 * even for two updates on the same day. `build` is the commit count: a monotonic number
 * that ticks up every push (104 → 105 …), the easiest signal to eyeball. Time is included
 * so same-day builds still differ; the short sha is there for support.
 */
export interface VersionInfo {
  build: number | null;
  sha: string;
  committedAt: string | null; // ISO
  label: string; // "v104"  (or the sha if the count is unavailable)
  pretty: string; // "v104 · Aug 24, 15:10"
  full: string; // "v104 · 273083b · Aug 24, 2026 15:10"
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function getVersion(): VersionInfo {
  const countStr = git(["rev-list", "--count", "HEAD"]);
  const build = countStr ? Number(countStr) : null;
  const sha = git(["rev-parse", "--short", "HEAD"]) || "unknown";
  const committedAt = git(["log", "-1", "--format=%cI"]) || null;
  const dtShort = git(["log", "-1", "--format=%cd", "--date=format:%b %d, %H:%M"]);
  const dtFull = git(["log", "-1", "--format=%cd", "--date=format:%b %d, %Y %H:%M"]);
  const label = build != null ? `v${build}` : sha;
  const pretty = [label, dtShort].filter(Boolean).join(" · ");
  const full = [label, sha, dtFull].filter(Boolean).join(" · ");
  return { build, sha, committedAt, label, pretty, full };
}
