import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrInfo } from "./types.js";

const exec = promisify(execFile);

/**
 * Look up the PR for a session's current branch via `gh`, run in the session's cwd
 * (works from a monorepo subfolder — gh walks up to the repo). Returns the most recent
 * PR whose head is `branch`, or null if there's none / gh is unavailable / offline.
 */
export async function fetchPr(cwd: string, branch: string): Promise<PrInfo | null> {
  if (!branch || branch === "HEAD" || branch === "main" || branch === "master") return null;
  try {
    const { stdout } = await exec(
      "gh",
      ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,state,isDraft,reviewDecision,url,title"],
      { cwd, timeout: 12_000 },
    );
    const arr = JSON.parse(stdout) as any[];
    if (!arr.length) return null;
    const p = arr[0];
    return {
      number: p.number,
      state: p.state, // OPEN | MERGED | CLOSED
      isDraft: !!p.isDraft,
      reviewDecision: p.reviewDecision || null, // APPROVED | REVIEW_REQUIRED | CHANGES_REQUESTED | ""
      url: p.url,
      title: p.title ?? null,
    };
  } catch {
    return null;
  }
}
