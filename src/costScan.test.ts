import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fss from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scanCosts } from "./costScan.js";
import { Store } from "./store.js";

function tmpStore(): Store {
  const dir = fss.mkdtempSync(path.join(os.tmpdir(), "tc-scan-db-"));
  return new Store(path.join(dir, "test.db"));
}

function turn(requestId: string, inputTokens: number) {
  return JSON.stringify({
    type: "assistant",
    requestId,
    sessionId: path.basename(requestId),
    cwd: "/tmp/repo",
    timestamp: "2026-09-14T10:00:00.000Z",
    message: {
      model: "claude-opus-5",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
}

async function tmpProjects(files: Record<string, string[]>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tc-projects-"));
  for (const [rel, lines] of Object.entries(files)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, lines.join("\n") + "\n");
  }
  return root;
}

test("prices every transcript under the projects root into the ledger", async () => {
  const root = await tmpProjects({
    "-repo-a/s1.jsonl": [turn("req_1", 1_000_000)],
    "-repo-b/s2.jsonl": [turn("req_2", 2_000_000)],
  });
  const store = tmpStore();
  await scanCosts(store, root);
  assert.equal(store.costSummary("2026-09-14").month, 15); // (1M + 2M) × $5/MTok
});

test("skips a transcript whose size has not changed since the last scan", async () => {
  const root = await tmpProjects({ "-repo-a/s1.jsonl": [turn("req_1", 1_000_000)] });
  const store = tmpStore();
  const first = await scanCosts(store, root);
  assert.equal(first.priced, 1);

  const second = await scanCosts(store, root);
  assert.equal(second.priced, 0);
  assert.equal(second.skipped, 1);
  assert.equal(store.costSummary("2026-09-14").month, 5);
});

test("re-prices a transcript that has grown since the last scan", async () => {
  const root = await tmpProjects({ "-repo-a/s1.jsonl": [turn("req_1", 1_000_000)] });
  const store = tmpStore();
  await scanCosts(store, root);

  await fs.appendFile(path.join(root, "-repo-a/s1.jsonl"), turn("req_2", 1_000_000) + "\n");
  await scanCosts(store, root);
  assert.equal(store.costSummary("2026-09-14").month, 10);
});

test("ignores the audit log that sits beside desktop transcripts", async () => {
  const root = await tmpProjects({
    "-repo-a/s1.jsonl": [turn("req_1", 1_000_000)],
    "-repo-a/audit.jsonl": [turn("req_2", 9_000_000)],
  });
  const store = tmpStore();
  await scanCosts(store, root);
  assert.equal(store.costSummary("2026-09-14").month, 5);
});

test("returns cleanly when the projects root does not exist", async () => {
  const store = tmpStore();
  const res = await scanCosts(store, path.join(os.tmpdir(), "tc-does-not-exist-" + Date.now()));
  assert.equal(res.priced, 0);
});

test("counts a subagent transcript's cost towards its parent session", async () => {
  // Claude Code nests subagent transcripts under <project>/<sessionId>/subagents/ and
  // stamps them with the PARENT session id. Their turns are real API calls — they must
  // add to the session's cost, not replace it.
  const parent = "s1";
  const line = (requestId: string) =>
    JSON.stringify({
      type: "assistant",
      requestId,
      sessionId: parent,
      cwd: "/tmp/repo",
      timestamp: "2026-09-14T10:00:00.000Z",
      message: {
        model: "claude-opus-5",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
    });

  const root = await tmpProjects({
    [`-repo-a/${parent}.jsonl`]: [line("req_main")],
    [`-repo-a/${parent}/subagents/agent-aaa.jsonl`]: [line("req_sub_a")],
    [`-repo-a/${parent}/subagents/agent-bbb.jsonl`]: [line("req_sub_b")],
  });
  const store = tmpStore();
  await scanCosts(store, root);

  assert.equal(store.costSummary("2026-09-14").month, 15);
  assert.equal(store.costById().get(parent)!.costUsd, 15);
});

test("prices the same transcript identically however many times it is scanned", async () => {
  // Guards the bug that made the total wander between runs: several files sharing
  // one session id used to overwrite each other, so the result depended on scan order.
  const root = await tmpProjects({
    "-repo-a/s1.jsonl": [turn("req_1", 1_000_000)],
    "-repo-a/s1/subagents/agent-a.jsonl": [turn("req_2", 1_000_000)],
  });
  const store = tmpStore();
  await scanCosts(store, root);
  const first = store.costSummary("2026-09-14").month;
  await scanCosts(store, root);
  assert.equal(store.costSummary("2026-09-14").month, first);
});
