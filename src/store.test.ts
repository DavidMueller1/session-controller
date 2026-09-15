import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "./store.js";

function tmpStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-store-"));
  return new Store(path.join(dir, "test.db"));
}

// The ledger is keyed by transcript path, so a row defaults to its session's own file.
const row = (o: Partial<Parameters<Store["recordCost"]>[0][number]> = {}) => ({
  id: o.id ?? "s1",
  path: o.path ?? `/t/${o.id ?? "s1"}.jsonl`,
  costUsd: 1,
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  model: "claude-opus-5",
  unpriced: false,
  lastActivityAt: Date.now(),
  byDay: { "2026-09-15": 1 },
  fileSize: 100,
  ...o,
});

test("sums the running month's turns into the month figure", () => {
  const s = tmpStore();
  s.recordCost([
    row({ id: "s1", byDay: { "2026-09-01": 1.5, "2026-09-15": 2.25 } }),
    row({ id: "s2", byDay: { "2026-08-31": 100 } }),
  ]);
  assert.equal(s.costSummary("2026-09-15").month, 3.75);
});

test("replaces a session's cost rather than adding to it when the same session is recorded again", () => {
  // A live session is re-recorded on every tick with its new running total.
  const s = tmpStore();
  s.recordCost([row({ id: "s1", byDay: { "2026-09-15": 1 } })]);
  s.recordCost([row({ id: "s1", byDay: { "2026-09-15": 4 } })]);
  assert.equal(s.costSummary("2026-09-15").month, 4);
});

test("counts only the given day's turns towards today's spend, not a session's whole history", () => {
  // A session that started yesterday and got one message today must contribute only
  // today's turns — the rest belongs to the days it was actually spent on.
  const s = tmpStore();
  s.recordCost([
    row({ id: "spanning", costUsd: 13, byDay: { "2026-09-14": 11.5, "2026-09-15": 1.5 } }),
    row({ id: "older", costUsd: 10, byDay: { "2026-08-10": 10 } }),
  ]);
  const sum = s.costSummary("2026-09-15");
  assert.equal(sum.today, 1.5);
  assert.equal(sum.month, 13);
});

test("replaces a day's figure rather than adding to it when a live session is re-recorded", () => {
  // The engine re-records a running session every tick with its cumulative per-day totals.
  const s = tmpStore();
  s.recordCost([row({ id: "s1", costUsd: 2, byDay: { "2026-09-15": 2 } })]);
  s.recordCost([row({ id: "s1", costUsd: 5, byDay: { "2026-09-15": 5 } })]);
  assert.equal(s.costSummary("2026-09-15").today, 5);
});

test("reports how many sessions ran on an unpriced model", () => {
  const s = tmpStore();
  s.recordCost([row({ id: "s1", unpriced: true }), row({ id: "s2", unpriced: false })]);
  assert.equal(s.costSummary("2026-09-15").unpricedSessions, 1);
});

test("remembers each scanned transcript's size so an unchanged file is never re-read", () => {
  const s = tmpStore();
  s.recordCost([row({ id: "s1", path: "/t/s1.jsonl", fileSize: 4096 })]);
  assert.equal(s.scannedSizes().get("/t/s1.jsonl"), 4096);
});

test("keeps a session's cost after the session is pruned from the live board", () => {
  // The sessions table mirrors what's live; the cost ledger is the durable record and
  // must survive a session ageing off the board.
  const s = tmpStore();
  s.recordCost([row({ id: "s1", byDay: { "2026-09-15": 7 } })]);
  s.syncSessions([]);
  assert.equal(s.costSummary("2026-09-15").month, 7);
});

test("keeps a previously scanned file size when a later record omits it", () => {
  // The live engine records a running cost without knowing the file's current size;
  // nulling the stored size would make the hourly backfill re-read the whole transcript
  // of every active session — the exact AV-scan cost the size check exists to avoid.
  const s = tmpStore();
  s.recordCost([row({ id: "s1", fileSize: 4096 })]);
  s.recordCost([row({ id: "s1", fileSize: null })]);
  assert.equal(s.scannedSizes().get("/t/s1.jsonl"), 4096);
});

test("re-reads a transcript that has no per-day breakdown yet", () => {
  // Upgrade path: a ledger written before per-day attribution existed has a file size but
  // no day rows. Reporting that size would make the backfill skip the file forever, so
  // today's figure would stay empty. Withholding it lets the next scan heal the row.
  const s = tmpStore();
  s.recordCost([row({ id: "s1", path: "/t/s1.jsonl", fileSize: 4096, byDay: {} })]);
  assert.equal(s.scannedSizes().has("/t/s1.jsonl"), false);

  s.recordCost([row({ id: "s1", path: "/t/s1.jsonl", fileSize: 4096, byDay: { "2026-09-15": 1 } })]);
  assert.equal(s.scannedSizes().get("/t/s1.jsonl"), 4096);
});

test("sums every transcript of a session, subagent files included, into one session total", () => {
  // Claude Code writes subagent transcripts to <project>/<sessionId>/subagents/agent-*.jsonl
  // and stamps them with the PARENT's sessionId. Keying the ledger by session id would let
  // those files overwrite each other; each transcript is its own row, summed per session.
  const s = tmpStore();
  s.recordCost([
    row({ id: "s1", path: "/t/s1.jsonl", costUsd: 10, byDay: { "2026-09-15": 10 } }),
    row({ id: "s1", path: "/t/s1/subagents/agent-a.jsonl", costUsd: 3, byDay: { "2026-09-15": 3 } }),
    row({ id: "s1", path: "/t/s1/subagents/agent-b.jsonl", costUsd: 2, byDay: { "2026-09-15": 2 } }),
  ]);
  assert.equal(s.costSummary("2026-09-15").month, 15);
  assert.equal(s.costSummary("2026-09-15").today, 15);
  assert.equal(s.costById().get("s1")!.costUsd, 15);
});

test("re-recording one transcript leaves its sibling transcripts untouched", () => {
  const s = tmpStore();
  s.recordCost([
    row({ id: "s1", path: "/t/s1.jsonl", costUsd: 10, byDay: { "2026-09-15": 10 } }),
    row({ id: "s1", path: "/t/s1/subagents/agent-a.jsonl", costUsd: 3, byDay: { "2026-09-15": 3 } }),
  ]);
  // the live session grows; its subagent file is not re-read
  s.recordCost([row({ id: "s1", path: "/t/s1.jsonl", costUsd: 12, byDay: { "2026-09-15": 12 } })]);
  assert.equal(s.costSummary("2026-09-15").month, 15);
  assert.equal(s.costSummary("2026-09-15").today, 15);
});
