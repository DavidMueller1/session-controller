/**
 * Token → dollar pricing for Claude models.
 *
 * Transcripts carry `message.usage` but no cost, so we price the tokens ourselves. Only
 * the two base rates (input / output, USD per million tokens) are listed per model —
 * every cache rate is a fixed multiple of the input rate, so there's one pair per model
 * to keep correct instead of five numbers.
 *
 * On a Max/Pro subscription these are not amounts you were billed; they're the
 * API-equivalent value of the tokens. The UI labels them as such.
 */

/** USD per million tokens: [input, output] */
const RATES: Record<string, [number, number]> = {
  // current generation
  "claude-fable-5-1": [10, 50],
  "claude-mythos-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-mythos-5": [10, 50],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
  // Older models, kept because the lifetime backfill walks transcripts going back months.
  // Historical list prices — good enough for a running total, and far better than dropping
  // those sessions to "unknown".
  "claude-opus-4-5": [5, 25],
  "claude-opus-4-1": [15, 75],
  "claude-opus-4-0": [15, 75],
  "claude-3-opus-20240229": [15, 75],
  "claude-sonnet-4-5": [3, 15],
  "claude-sonnet-4-0": [3, 15],
  "claude-3-7-sonnet-20250219": [3, 15],
  "claude-3-5-sonnet-20241022": [3, 15],
  "claude-3-5-sonnet-20240620": [3, 15],
  "claude-3-5-haiku-20241022": [0.8, 4],
  "claude-3-haiku-20240307": [0.25, 1.25],
};

/**
 * Bare aliases Claude Code writes into some transcript turns instead of a full model id.
 * They mean "whatever the current generation of that tier is".
 */
const ALIASES: Record<string, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

/** Claude Code's marker for a turn it generated locally (interrupt notices and the like).
 *  No API call happened, so it is genuinely free — not a model we failed to price. */
const SYNTHETIC = "<synthetic>";

/** Fast mode runs the same model at a premium; the turn's `usage.speed` tells us it ran. */
const FAST_RATES: Record<string, [number, number]> = {
  "claude-opus-5": [10, 50],
  "claude-opus-4-8": [10, 50],
};

/** Cache rates as multiples of the model's input rate (uniform across models). */
const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

/** the `usage` object of an assistant turn, as it appears in a transcript line */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  /** flat cache-write total; superseded by `cache_creation` when that's present */
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  /** "standard" | "fast" — fast mode is billed at a premium */
  speed?: string;
}

/**
 * Strip the decorations a model id picks up in transcripts and on other platforms —
 * a `[1m]` context-mode suffix, a `us.`/`eu.` region prefix, an `anthropic.` platform
 * prefix, a Vertex `@version` — so one table entry prices every spelling of a model.
 */
export function normalizeModel(model: string): string {
  const id = model
    .trim()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(?:[a-z]{2}\.)?anthropic\./, "")
    .replace(/@\d{8}$/, "");
  return ALIASES[id] ?? id;
}

function ratesFor(model: string | null | undefined): [number, number] | null {
  if (!model) return null;
  const id = normalizeModel(model);
  // Exact id first: for pre-4.x models the trailing date IS the canonical id
  // (claude-3-5-haiku-20241022), so the snapshot fallback below must not shadow it.
  return RATES[id] ?? RATES[id.replace(/-\d{8}$/, "")] ?? null;
}

/** Is this model priced at all? Lets callers flag "unknown" without computing a cost. */
export function isPriced(model: string | null | undefined): boolean {
  return model?.trim() === SYNTHETIC || ratesFor(model) != null;
}

/**
 * Cost in USD of one assistant turn, or null when the model isn't in the table — callers
 * must surface that as "unknown", never as zero, or unpriced turns silently vanish from
 * the total.
 */
export function costOf(usage: Usage, model: string | null | undefined): number | null {
  if (model?.trim() === SYNTHETIC) return 0;
  const base = ratesFor(model);
  if (!base) return null;
  const id = normalizeModel(model!);
  const [inRate, outRate] = (usage.speed === "fast" && FAST_RATES[id]) || base;

  // The TTL split is authoritative when present — a transcript carries BOTH it and the
  // flat total, and adding them would bill every cache write twice.
  const split = usage.cache_creation;
  const write5m = split ? split.ephemeral_5m_input_tokens ?? 0 : usage.cache_creation_input_tokens ?? 0;
  const write1h = split ? split.ephemeral_1h_input_tokens ?? 0 : 0;

  const inputUsd =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) * CACHE_READ +
    write5m * CACHE_WRITE_5M +
    write1h * CACHE_WRITE_1H;

  return (inputUsd * inRate + (usage.output_tokens ?? 0) * outRate) / 1_000_000;
}
