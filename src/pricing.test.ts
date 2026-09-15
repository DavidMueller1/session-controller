import assert from "node:assert/strict";
import { test } from "node:test";
import { costOf, isPriced } from "./pricing.js";

test("prices a plain input/output turn at the model's per-MTok rate", () => {
  // Opus 5: $5 / MTok in, $25 / MTok out
  const usd = costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, "claude-opus-5");
  assert.equal(usd, 30);
});

test("charges cache reads at a tenth of the input rate", () => {
  const usd = costOf({ cache_read_input_tokens: 1_000_000 }, "claude-opus-5");
  assert.equal(usd, 0.5);
});

test("charges cache writes by TTL — 1.25x input for 5m, 2x for 1h", () => {
  const usd = costOf(
    { cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 } },
    "claude-opus-5",
  );
  assert.equal(usd, 5 * 1.25 + 5 * 2);
});

test("falls back to the flat cache_creation_input_tokens at the 5m rate when no TTL split is given", () => {
  const usd = costOf({ cache_creation_input_tokens: 1_000_000 }, "claude-opus-5");
  assert.equal(usd, 6.25);
});

test("does not double-count cache creation when both the flat total and the TTL split are present", () => {
  // Real transcripts carry both; the split is authoritative.
  const usd = costOf(
    {
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
    },
    "claude-opus-5",
  );
  assert.equal(usd, 10);
});

test("prices a model id carrying a context-mode suffix or a platform prefix", () => {
  const plain = costOf({ output_tokens: 1_000_000 }, "claude-opus-5");
  assert.equal(costOf({ output_tokens: 1_000_000 }, "claude-opus-5[1m]"), plain);
  assert.equal(costOf({ output_tokens: 1_000_000 }, "us.anthropic.claude-opus-5"), plain);
});

test("prices a fast-mode turn at the fast-mode premium", () => {
  // Opus 5 fast mode is billed at $10 / $50 per MTok.
  const usd = costOf({ input_tokens: 1_000_000, output_tokens: 1_000_000, speed: "fast" }, "claude-opus-5");
  assert.equal(usd, 60);
});

test("returns null for an unpriced model rather than a misleading zero", () => {
  assert.equal(costOf({ input_tokens: 1_000_000 }, "claude-something-unreleased"), null);
  assert.equal(costOf({ input_tokens: 1_000_000 }, null), null);
});

test("prices a bare alias at the current generation's rate", () => {
  // Claude Code writes "opus" / "sonnet" / "haiku" into some transcript turns.
  assert.equal(costOf({ output_tokens: 1_000_000 }, "opus"), costOf({ output_tokens: 1_000_000 }, "claude-opus-5"));
  assert.equal(costOf({ output_tokens: 1_000_000 }, "sonnet"), costOf({ output_tokens: 1_000_000 }, "claude-sonnet-5"));
  assert.equal(costOf({ output_tokens: 1_000_000 }, "haiku"), costOf({ output_tokens: 1_000_000 }, "claude-haiku-4-5"));
});

test("treats a synthetic turn as free rather than as an unpriced model", () => {
  // Claude Code stamps locally-generated turns (interrupt notices and the like) with
  // "<synthetic>". No API call happened, so it costs nothing — and flagging it as an
  // unpriced model would put a bogus asterisk on almost every total.
  assert.equal(costOf({ input_tokens: 1_000 }, "<synthetic>"), 0);
  assert.equal(isPriced("<synthetic>"), true);
});

test("prices a dated model snapshot at its base model's rate", () => {
  assert.equal(
    costOf({ output_tokens: 1_000_000 }, "claude-haiku-4-5-20251001"),
    costOf({ output_tokens: 1_000_000 }, "claude-haiku-4-5"),
  );
});

test("still prices a legacy model whose canonical id ends in a date", () => {
  // For pre-4.x models the date IS the id — stripping it would leave an unknown model.
  assert.equal(costOf({ output_tokens: 1_000_000 }, "claude-3-5-haiku-20241022"), 4);
});
