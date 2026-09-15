import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseCliIncremental } from "./parseCli.js";

/** a transcript assistant line, as Claude Code writes it */
function assistantLine(o: { requestId: string; model?: string; usage?: Record<string, unknown>; text?: string }) {
  return JSON.stringify({
    type: "assistant",
    requestId: o.requestId,
    sessionId: "s1",
    cwd: "/tmp/repo",
    timestamp: "2026-09-14T10:00:00.000Z",
    message: {
      id: "msg_" + o.requestId,
      model: o.model ?? "claude-opus-5",
      content: [{ type: "text", text: o.text ?? "hi" }],
      usage: o.usage ?? { input_tokens: 1_000_000, output_tokens: 0 },
    },
  });
}

async function fixture(lines: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tc-parse-"));
  const file = path.join(dir, "s1.jsonl");
  await fs.writeFile(file, lines.join("\n") + "\n");
  return file;
}

test("sums the cost of every API request in the transcript", async () => {
  const file = await fixture([
    assistantLine({ requestId: "req_a" }),
    assistantLine({ requestId: "req_b" }),
  ]);
  const res = await parseCliIncremental(file, null);
  assert.equal(res!.facts.costUsd, 10); // 2 × 1M input tokens on Opus 5 @ $5/MTok
});

test("counts one API request once even when the transcript splits it across several assistant lines", async () => {
  // Claude Code writes one line per content block, all carrying the SAME requestId and
  // the SAME usage — summing them naively nearly doubles the bill.
  const file = await fixture([
    assistantLine({ requestId: "req_a", text: "thinking" }),
    assistantLine({ requestId: "req_a", text: "answer" }),
  ]);
  const res = await parseCliIncremental(file, null);
  assert.equal(res!.facts.costUsd, 5);
});

test("keeps accumulating cost when only appended bytes are re-read", async () => {
  const file = await fixture([assistantLine({ requestId: "req_a" })]);
  const first = await parseCliIncremental(file, null);
  assert.equal(first!.facts.costUsd, 5);

  await fs.appendFile(file, assistantLine({ requestId: "req_b" }) + "\n");
  const second = await parseCliIncremental(file, first!.cursor);
  assert.equal(second!.facts.costUsd, 10);
});

test("reports the model the session actually ran on", async () => {
  const file = await fixture([assistantLine({ requestId: "req_a", model: "claude-sonnet-5" })]);
  const res = await parseCliIncremental(file, null);
  assert.equal(res!.facts.model, "claude-sonnet-5");
});

test("flags a session whose model has no price instead of counting it as free", async () => {
  const file = await fixture([assistantLine({ requestId: "req_a", model: "claude-unreleased-9" })]);
  const res = await parseCliIncremental(file, null);
  assert.equal(res!.facts.costUnpriced, true);
  assert.equal(res!.facts.costUsd, 0);
});

test("breaks the token total out by kind", async () => {
  const file = await fixture([
    assistantLine({
      requestId: "req_a",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
        cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 },
      },
    }),
  ]);
  const res = await parseCliIncremental(file, null);
  assert.deepEqual(res!.facts.costTokens, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
});

test("attributes each turn's cost to the local day that turn happened on", async () => {
  // A session spanning midnight must not dump its whole spend onto whichever day it was
  // last active — "today" is a property of the turn, not of the session.
  const line = (requestId: string, ts: string) =>
    JSON.stringify({
      type: "assistant",
      requestId,
      sessionId: "s1",
      cwd: "/tmp/repo",
      timestamp: ts,
      message: {
        model: "claude-opus-5",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
    });

  // Pick two instants that are certainly on different local days.
  const dayOne = new Date(2026, 8, 14, 12, 0, 0);
  const dayTwo = new Date(2026, 8, 15, 12, 0, 0);
  const file = await fixture([
    line("req_a", dayOne.toISOString()),
    line("req_b", dayTwo.toISOString()),
    line("req_c", dayTwo.toISOString()),
  ]);

  const res = await parseCliIncremental(file, null);
  assert.equal(res!.facts.costUsd, 15);
  assert.deepEqual(res!.facts.costByDay, { "2026-09-14": 5, "2026-09-15": 10 });
});
