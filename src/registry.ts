import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";

/**
 * An entry from the live CLI session registry (~/.claude/sessions/<pid>.json). Only
 * currently-running sessions appear here. `name` is the user's rename (the strip
 * callsign for terminal sessions); `status` is Claude Code's own busy/idle signal.
 */
export interface RegistryEntry {
  sessionId: string;
  name: string | null;
  /** how `name` was set: "user" (a real rename) vs "derived" (auto folder slug, newer
   *  desktop builds). Absent on older builds, where `name` was always a user rename. */
  nameSource: string | null;
  status: string | null;
  entrypoint: string | null;
  pid: number | null;
  cwd: string | null;
}

export function isRegistryFile(p: string): boolean {
  return p.startsWith(CONFIG.sessionsDir + path.sep) && p.endsWith(".json");
}

export async function parseRegistryFile(filePath: string): Promise<RegistryEntry | null> {
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
  if (!o || typeof o.sessionId !== "string") return null;
  return {
    sessionId: o.sessionId,
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : null,
    nameSource: typeof o.nameSource === "string" ? o.nameSource : null,
    status: typeof o.status === "string" ? o.status : null,
    entrypoint: typeof o.entrypoint === "string" ? o.entrypoint : null,
    pid: typeof o.pid === "number" ? o.pid : null,
    cwd: typeof o.cwd === "string" ? o.cwd : null,
  };
}
