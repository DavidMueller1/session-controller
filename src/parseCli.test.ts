import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolve } from "./deriveState.js";
import { parseCliIncremental, shellAwaited } from "./parseCli.js";

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

test("a reminder Claude Code injects after a finished turn doesn't read as a new prompt", async () => {
  const file = await fixture([
    assistantLine({ requestId: "req_a", text: "Done." }),
    JSON.stringify({
      type: "user",
      isMeta: true,
      sessionId: "s1",
      timestamp: "2026-09-14T10:00:01.000Z",
      message: { role: "user", content: '<system-reminder>\nThe user named this session "SETUP STUFF".\n</system-reminder>' },
    }),
  ]);
  const res = await parseCliIncremental(file, null);
  assert.equal(res!.facts.tailKind, "assistant-text");
});

test("keeps a /rename title once the session has exited", async () => {
  const file = await fixture([
    assistantLine({ requestId: "req_a" }),
    JSON.stringify({ type: "custom-title", customTitle: "SEARCH", sessionId: "s1" }),
    JSON.stringify({ type: "ai-title", aiTitle: "Analyze intelligent search implementation plan", sessionId: "s1" }),
  ]);
  const res = await parseCliIncremental(file, null);
  assert.equal(res!.facts.title, "SEARCH");
});

test("a /branch fork is its own session, not a continuation of the one it was branched from", async () => {
  const forkedFrom = { sessionId: "parent-0000", messageUuid: "m1" };
  const file = await fixture([
    JSON.stringify({
      type: "user",
      sessionId: "s1",
      forkedFrom,
      timestamp: "2026-09-14T10:00:00.000Z",
      message: { role: "user", content: "This session is being continued from a previous conversation. Read /p/0b1c2d3e-0000-4000-8000-000000000001.jsonl" },
    }),
    assistantLine({ requestId: "req_a" }),
  ]);
  const res = await parseCliIncremental(file, null);
  assert.equal(res!.facts.continuedFrom, null);
});

test("a turn that ends while a background task runs is still working, until the task reports back", async () => {
  const ts = new Date().toISOString();
  const toolResult = (text: string) =>
    JSON.stringify({ type: "user", sessionId: "s1", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text }] }] } });
  const said = (text: string) =>
    JSON.stringify({ type: "assistant", sessionId: "s1", timestamp: ts, message: { id: "m_" + text, content: [{ type: "text", text }] } });
  const file = await fixture([
    toolResult('MCP tool "Atlassian/search" is still running after 120s. It was moved to the background as task k5slmxt4c and keeps running.'),
    said("I wait for the search."),
  ]);
  const res = await parseCliIncremental(file, null);
  assert.equal(res!.facts.pendingTasks!.length, 1);

  const later = Date.now() + 60_000; // past the needs-input grace
  assert.equal(resolve(res!.facts, later).state, "working");

  await fs.appendFile(
    file,
    JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: ts, content: "<task-notification>\n<task-id>k5slmxt4c</task-id>\n<status>failed</status>\n</task-notification>" }) + "\n",
  );
  const done = await parseCliIncremental(file, res!.cursor);
  assert.equal(done!.facts.pendingTasks!.length, 0);
  assert.equal(resolve(done!.facts, later).state, "needs-input");
});

test("a background shell keeps the turn working only while Claude waits on it, not for a dev server", async () => {
  const ts = new Date().toISOString();
  const bash = (id: string, command: string) =>
    JSON.stringify({ type: "assistant", sessionId: "s1", timestamp: ts, message: { id: "m_" + id, content: [{ type: "tool_use", id, name: "Bash", input: { command, run_in_background: true } }] } });
  const launched = (id: string, task: string) =>
    JSON.stringify({ type: "user", sessionId: "s1", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Command running in background with ID: ${task}. Output is being written to: /tmp/${task}.output` }] } });
  const said = JSON.stringify({ type: "assistant", sessionId: "s1", timestamp: ts, message: { id: "m_said", content: [{ type: "text", text: "Waiting for CI." }] } });
  const file = await fixture([
    bash("t1", "source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use >/dev/null; pnpm kl:bff 2>&1"),
    launched("t1", "server1"),
    bash("t2", "for i in $(seq 1 60); do s=$(gh pr checks 5849 --json name,bucket 2>/dev/null || echo '[]'); sleep 30; done"),
    launched("t2", "poll1"),
    said,
  ]);
  const res = await parseCliIncremental(file, null);
  assert.equal(res!.facts.pendingTasks!.length, 1);
  assert.equal(resolve(res!.facts, Date.now() + 60_000).state, "working");
  // a shell Claude waits on that never reports back stops counting after an hour
  assert.equal(resolve(res!.facts, Date.now() + 61 * 60_000).state, "needs-input");
});

test("tells a background shell Claude waits on from a server or watcher", () => {
  for (const c of [
    "gh pr checks 646 --watch --interval 30 2>&1 | tail -20",
    "gh run watch 39224853872 --exit-status --interval 60 > /dev/null 2>&1",
    "sleep 90; until ! gh pr checks 5685 2>/dev/null | grep -qE pending; do sleep 60; done",
    "for i in $(seq 1 90); do code=$(curl -s -o /dev/null -w '%{http_code}' https://x.test); sleep 20; done",
    "source ~/.nvm/nvm.sh && nvm use >/dev/null && pnpm vitest run src/a.test.ts",
  ])
    assert.equal(shellAwaited(c), true, c);
  for (const c of [
    "source ~/.nvm/nvm.sh >/dev/null 2>&1; pnpm dev:live",
    "nvm use && pnpm kl:bff",
    "cd packages/collage-designer && VITE_CHANNEL=kartenliebe pnpm run dev 2>&1",
    "pnpm exec nuxt dev --port 3002",
    "pnpm vitest --watch",
    "tail -f /tmp/app.log",
  ])
    assert.equal(shellAwaited(c), false, c);
});

test("a background task Claude stops itself no longer keeps the turn working", async () => {
  const ts = new Date().toISOString();
  const file = await fixture([
    JSON.stringify({ type: "assistant", sessionId: "s1", timestamp: ts, message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "until gh pr checks 1 | grep -q pass; do sleep 30; done", run_in_background: true } }] } }),
    JSON.stringify({ type: "user", sessionId: "s1", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Command running in background with ID: poll1. Output is being written to: /tmp/poll1.output" }] } }),
    JSON.stringify({ type: "assistant", sessionId: "s1", timestamp: ts, message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "TaskStop", input: { task_id: "poll1" } }] } }),
    JSON.stringify({ type: "assistant", sessionId: "s1", timestamp: ts, message: { id: "m3", content: [{ type: "text", text: "CI is green." }] } }),
  ]);
  const res = await parseCliIncremental(file, null);
  assert.equal(res!.facts.pendingTasks!.length, 0);
  assert.equal(resolve(res!.facts, Date.now() + 60_000).state, "needs-input");
});
