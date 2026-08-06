import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";

/** live state for a session, written by our Claude Code hooks (see hooks/tc-state.sh) */
export interface HookState {
  sessionId: string;
  /** "working" | "needs-input" | "ended" (terminal — the SessionEnd hook fired) */
  state: string;
  /** epoch ms the hook fired — used to ignore stale files (dead sessions) */
  ts: number;
}

export function isHookStateFile(p: string): boolean {
  return p.startsWith(CONFIG.hookStateDir + path.sep) && p.endsWith(".json") && !p.endsWith(".tmp");
}

export async function parseHookStateFile(filePath: string): Promise<HookState | null> {
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
  if (!o || typeof o.state !== "string" || typeof o.ts !== "number") return null;
  return { sessionId: path.basename(filePath, ".json"), state: o.state, ts: o.ts };
}
