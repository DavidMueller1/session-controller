import fs from "node:fs/promises";
import path from "node:path";
import type { SessionFacts, TailKind } from "./types.js";
import { firstLine, truncate } from "./util.js";

/**
 * A transcript line normalised to the one thing we care about for status: what kind
 * of turn it was, when, and whether it errored. Note that `user` lines carrying a
 * tool_result block are NOT human input — they are tool output routed under the user
 * role, so they must classify as "tool-result", not "human".
 */
interface NormEvent {
  kind: "human" | "assistant-text" | "assistant-tool" | "assistant-ask" | "tool-result" | "system" | "meta";
  ts: number | null;
  summary: string;
  isError: boolean;
}

/** tools that block waiting on the user — their call means "needs you", not "working" */
const ASK_TOOLS: Record<string, string> = {
  AskUserQuestion: "asked you a question",
  ExitPlanMode: "waiting for plan approval",
};

function classify(o: any): NormEvent {
  const type = o?.type;
  const ts = typeof o?.timestamp === "string" ? Date.parse(o.timestamp) : null;
  const content = o?.message?.content;
  const blocks: any[] = Array.isArray(content) ? content : [];
  const blockTypes = new Set(blocks.map((b) => b?.type));

  if (type === "assistant") {
    if (blockTypes.has("tool_use")) {
      const names = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => b.name)
        .filter(Boolean) as string[];
      // a tool that waits on the user (AskUserQuestion / ExitPlanMode) = "needs you"
      const ask = names.find((n) => ASK_TOOLS[n]);
      if (ask) return { kind: "assistant-ask", ts, summary: ASK_TOOLS[ask], isError: false };
      return { kind: "assistant-tool", ts, summary: `running tool: ${names.join(", ") || "?"}`, isError: false };
    }
    const text = blocks.find((b) => b.type === "text")?.text ?? (typeof content === "string" ? content : "");
    return { kind: "assistant-text", ts, summary: truncate(firstLine(text), 70) || "assistant responded", isError: false };
  }

  if (type === "user") {
    if (blockTypes.has("tool_result")) {
      const isError = blocks.some((b) => b.type === "tool_result" && b.is_error === true);
      return { kind: "tool-result", ts, summary: isError ? "tool error" : "tool result received", isError };
    }
    const text = typeof content === "string" ? content : blocks.find((b) => b.type === "text")?.text ?? "";
    return { kind: "human", ts, summary: `you: ${truncate(cleanUserText(text), 60)}`, isError: false };
  }

  if (type === "system") {
    const isError = Array.isArray(o.hookErrors) && o.hookErrors.length > 0;
    return { kind: "system", ts, summary: String(o.subtype ?? "system"), isError };
  }

  // queue-operation, ai-title, last-prompt, attachment, ...
  return { kind: "meta", ts, summary: "", isError: false };
}

const CONVERSATIONAL = new Set<NormEvent["kind"]>(["human", "assistant-text", "assistant-tool", "assistant-ask", "tool-result"]);

/**
 * Strip harness noise from a user message so it reads as a title: XML-ish wrappers
 * (`<command-message>`, `<command-name>`, `<local-command-…>`, `<task-notification>`),
 * caveat preambles, and collapsed whitespace.
 */
function cleanUserText(s: string): string {
  const oneLine = firstLine(s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
  return oneLine.replace(/^Caveat:.*?\.\s*/i, "").trim();
}

export async function parseCliTranscript(filePath: string): Promise<SessionFacts | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const events: NormEvent[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let aiTitle: string | null = null;
  let firstUserText: string | null = null;
  let firstTs: number | null = null;

  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: any;
    try {
      o = JSON.parse(s);
    } catch {
      continue; // defensive: never crash on a malformed/partial line
    }
    if (o.sessionId && !sessionId) sessionId = o.sessionId;
    if (typeof o.cwd === "string" && o.cwd) cwd = o.cwd;
    if (typeof o.gitBranch === "string" && o.gitBranch) branch = o.gitBranch;
    if (o.type === "ai-title" && o.aiTitle) aiTitle = String(o.aiTitle);

    const ev = classify(o);
    if (ev.ts != null && firstTs == null) firstTs = ev.ts;
    if (ev.kind === "human" && !firstUserText) firstUserText = ev.summary.replace(/^you:\s*/, "");
    events.push(ev);
  }

  if (!sessionId) sessionId = path.basename(filePath).replace(/\.jsonl$/, "");
  const title = aiTitle ?? (firstUserText ? truncate(firstUserText, 60) : sessionId);

  const timed = events.filter((e) => e.ts != null);
  const lastActivityAt = timed.length ? timed[timed.length - 1].ts! : null;
  const tail = events.filter((e) => CONVERSATIONAL.has(e.kind)).at(-1);
  const tailKind: TailKind = (tail?.kind as TailKind) ?? "none";

  return {
    id: sessionId,
    source: "cli",
    path: filePath,
    project: cwd,
    branch,
    title,
    model: null,
    firstSeenAt: firstTs,
    lastActivityAt,
    linkedCliSessionId: null,
    tailKind,
    tailIsError: tail?.isError ?? false,
    tailSummary: tail?.summary || "no conversation yet",
  };
}
