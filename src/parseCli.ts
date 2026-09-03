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
  kind: "human" | "assistant-text" | "assistant-tool" | "assistant-ask" | "tool-result" | "interrupt" | "system" | "meta";
  ts: number | null;
  summary: string;
  isError: boolean;
}

/** Claude Code injects this user turn when you hit ESC — the session is now waiting on you,
 *  not working, even though the last hook/tool event said "working". */
const INTERRUPT_RE = /\[Request interrupted by user/;

/** all text a user turn carries — plain string content, `text` blocks, and the string body
 *  of a `tool_result` block — so we can spot the interrupt marker wherever it lands. */
function userText(o: any): string {
  const c = o?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (typeof b?.text === "string" ? b.text : typeof b?.content === "string" ? b.content : ""))
      .join(" ");
  }
  return "";
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
    // An ESC interrupt fires no Stop hook, so this transcript turn is the authoritative
    // "you took back control" signal — flag it distinctly so state derivation reads it as
    // needs-input, not as work-in-motion (which a plain human/tool-result tail implies).
    if (INTERRUPT_RE.test(userText(o))) return { kind: "interrupt", ts, summary: "interrupted — waiting on you", isError: false };
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

const CONVERSATIONAL = new Set<NormEvent["kind"]>(["human", "assistant-text", "assistant-tool", "assistant-ask", "tool-result", "interrupt"]);

/** The `/compact` continuation preamble Claude Code injects as the first user turn of a
 *  session that resumed a context-exhausted one. It names the parent transcript path,
 *  whose basename is the predecessor session id we link to. */
const CONTINUATION_RE = /continued from a previous conversation/i;
const PARENT_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/i;

/** full text of a user turn (string content, or the joined `text` blocks) — unlike the
 *  classifier's summary this isn't truncated, so we can scan it for the parent path. */
function humanText(o: any): string {
  const content = o?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === "text").map((b) => b?.text ?? "").join(" ");
  return "";
}

/**
 * Strip harness noise from a user message so it reads as a title: XML-ish wrappers
 * (`<command-message>`, `<command-name>`, `<local-command-…>`, `<task-notification>`),
 * caveat preambles, and collapsed whitespace.
 */
function cleanUserText(s: string): string {
  const oneLine = firstLine(s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
  return oneLine.replace(/^Caveat:.*?\.\s*/i, "").trim();
}

/**
 * Incremental parse state for one transcript. Transcripts are append-only JSONL, and the
 * derived facts depend only on first-seen fields + the running tail — so we keep a byte
 * cursor and, on each update, read ONLY the appended bytes instead of the whole file.
 * That matters a lot when the file (and the AV scan it triggers on every read) is tens of
 * MB and an active session appends constantly. `carry` holds a not-yet-terminated trailing
 * line, kept in memory so we never re-read it from disk.
 */
export interface CliCursor {
  /** byte position just past the last fully-consumed (newline-terminated) line */
  offset: number;
  /** decoded partial line after `offset` (no trailing newline yet) */
  carry: string;
  sessionId: string | null;
  cwd: string | null;
  branch: string | null;
  aiTitle: string | null;
  firstUserText: string | null;
  /** predecessor session id, if this transcript opens with the `/compact` continuation
   *  preamble ("This session is being continued…"), else null */
  continuedFrom: string | null;
  firstTs: number | null;
  contextTokens: number | null;
  lastActivityAt: number | null;
  tail: NormEvent | null;
}

function emptyCursor(): CliCursor {
  return {
    offset: 0,
    carry: "",
    sessionId: null,
    cwd: null,
    branch: null,
    aiTitle: null,
    firstUserText: null,
    continuedFrom: null,
    firstTs: null,
    contextTokens: null,
    lastActivityAt: null,
    tail: null,
  };
}

/** fold one transcript line into the running cursor (first-wins ids, last-wins tail) */
function ingestLine(c: CliCursor, s: string): void {
  let o: any;
  try {
    o = JSON.parse(s);
  } catch {
    return; // defensive: never crash on a malformed/partial line
  }
  if (o.sessionId && !c.sessionId) c.sessionId = o.sessionId;
  if (typeof o.cwd === "string" && o.cwd) c.cwd = o.cwd;
  if (typeof o.gitBranch === "string" && o.gitBranch) c.branch = o.gitBranch;
  if (o.type === "ai-title" && o.aiTitle) c.aiTitle = String(o.aiTitle);

  // context = prompt tokens of the most recent assistant turn (last one wins)
  const u = o.type === "assistant" ? o.message?.usage : null;
  if (u) c.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

  const ev = classify(o);
  if (ev.ts != null) {
    if (c.firstTs == null) c.firstTs = ev.ts;
    c.lastActivityAt = ev.ts; // last timed event wins
  }
  if (ev.kind === "human" && !c.firstUserText) {
    const raw = humanText(o);
    if (CONTINUATION_RE.test(raw)) {
      // A compaction continuation opens with the preamble naming its parent transcript;
      // capture that predecessor id so the board can fold both into one flight. Don't let
      // the boilerplate preamble become the title — wait for the first real prompt (the
      // folded flight inherits the predecessor's title until then).
      if (c.continuedFrom == null) {
        const m = raw.match(PARENT_ID_RE);
        if (m && m[1] !== c.sessionId) c.continuedFrom = m[1];
      }
    } else {
      c.firstUserText = ev.summary.replace(/^you:\s*/, "");
    }
  }
  if (CONVERSATIONAL.has(ev.kind)) c.tail = ev; // last conversational event wins
}

function cursorToFacts(filePath: string, c: CliCursor): SessionFacts {
  const sessionId = c.sessionId ?? path.basename(filePath).replace(/\.jsonl$/, "");
  const title = c.aiTitle ?? (c.firstUserText ? truncate(c.firstUserText, 60) : sessionId);
  const tailKind: TailKind = (c.tail?.kind as TailKind) ?? "none";
  return {
    id: sessionId,
    source: "cli",
    path: filePath,
    project: c.cwd,
    branch: c.branch,
    title,
    model: null,
    firstSeenAt: c.firstTs,
    lastActivityAt: c.lastActivityAt,
    linkedCliSessionId: null,
    tailKind,
    tailIsError: c.tail?.isError ?? false,
    tailSummary: c.tail?.summary || "no conversation yet",
    contextTokens: c.contextTokens,
    continuedFrom: c.continuedFrom,
  };
}

/**
 * Parse a transcript incrementally: given the cursor from the previous parse, read only
 * the bytes appended since, and return the updated facts + a new cursor. Pass `prev = null`
 * for a full read (first time). Resets to a full read if the file shrank (truncated /
 * rotated). Reads nothing when there are no new bytes.
 */
export async function parseCliIncremental(
  filePath: string,
  prev: CliCursor | null,
): Promise<{ facts: SessionFacts; cursor: CliCursor } | null> {
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await fh.stat();
    // fresh parse, or reset when the file got smaller than we'd already consumed
    let cursor = prev && size >= prev.offset ? { ...prev } : emptyCursor();
    const readFrom = cursor.offset + Buffer.byteLength(cursor.carry, "utf8");

    if (size > readFrom) {
      const len = size - readFrom;
      const buf = Buffer.allocUnsafe(len);
      let read = 0;
      while (read < len) {
        const { bytesRead } = await fh.read(buf, read, len - read, readFrom + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      const text = cursor.carry + buf.toString("utf8", 0, read);
      const parts = text.split("\n");
      const newCarry = parts.pop() ?? "";
      for (const line of parts) {
        const s = line.trim();
        if (s) ingestLine(cursor, s);
      }
      cursor.offset = cursor.offset + Buffer.byteLength(cursor.carry, "utf8") + read - Buffer.byteLength(newCarry, "utf8");
      cursor.carry = newCarry;
    }

    return { facts: cursorToFacts(filePath, cursor), cursor };
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}
