import fs from "node:fs/promises";
import path from "node:path";
import type { SessionFacts } from "./types.js";

/**
 * Desktop (Cowork / local agent mode) sessions are tracked from their metadata JSON
 * (§2b). The file itself is just metadata — the real transcript lives under
 * ~/.claude/projects keyed by `cliSessionId`, which we keep for later correlation.
 * `isArchived: true` is the one clean "suspected done" signal available here.
 */
export function isDesktopSessionFile(filePath: string): boolean {
  return /^local_[^/]*\.json$/.test(path.basename(filePath));
}

export async function parseDesktopSession(filePath: string): Promise<SessionFacts | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let o: any;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o.sessionId !== "string") return null; // skip caches / non-session json

  return {
    id: o.sessionId,
    source: "desktop",
    path: filePath,
    project: typeof o.cwd === "string" ? o.cwd : null,
    branch: null,
    title: typeof o.title === "string" ? o.title : o.sessionId,
    model: typeof o.model === "string" ? o.model : null,
    firstSeenAt: typeof o.createdAt === "number" ? o.createdAt : null,
    lastActivityAt: typeof o.lastActivityAt === "number" ? o.lastActivityAt : null,
    linkedCliSessionId: typeof o.cliSessionId === "string" ? o.cliSessionId : null,
    tailKind: "none",
    tailIsError: false,
    tailSummary: "",
    archived: o.isArchived === true,
  };
}
