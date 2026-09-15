import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { parseCliIncremental } from "./parseCli.js";
import type { Store } from "./store.js";

/**
 * One-off backfill of the lifetime cost ledger.
 *
 * The engine only parses transcripts inside its staleness window, so everything older
 * would never be priced. This walks the whole projects tree once at startup (and on a
 * slow repeat) and fills in the rest.
 *
 * Reading these files is the expensive part — ~/.claude is usually not excluded from
 * on-access AV scanning — so a transcript whose size matches what we already priced is
 * never opened. After the first run that skips essentially everything.
 */

/** the audit log Cowork drops beside every desktop session — not a Claude Code transcript */
const NOT_A_TRANSCRIPT = new Set(["audit.jsonl"]);

async function transcripts(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true, recursive: true });
  } catch {
    return []; // no projects dir yet — nothing to backfill
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl") && !NOT_A_TRANSCRIPT.has(e.name))
    .map((e) => path.join(e.parentPath ?? root, e.name));
}

export interface ScanResult {
  /** transcripts read and written to the ledger */
  priced: number;
  /** transcripts left alone because their size was unchanged since the last scan */
  skipped: number;
}

/** how many transcripts to parse at once — enough to hide I/O latency, few enough not
 *  to thrash the AV scanner on a first run over a large history */
const CONCURRENCY = 4;

export async function scanCosts(store: Store, root: string = CONFIG.cliProjectsDir): Promise<ScanResult> {
  const files = await transcripts(root);
  const known = store.scannedSizes();
  const result: ScanResult = { priced: 0, skipped: 0 };

  const queue = [...files];
  const batch: Parameters<Store["recordCost"]>[0] = [];

  async function worker(): Promise<void> {
    for (;;) {
      const file = queue.pop();
      if (!file) return;

      let size: number;
      try {
        size = (await fs.stat(file)).size;
      } catch {
        continue; // deleted between listing and stat
      }
      if (known.get(file) === size) {
        result.skipped++;
        continue;
      }

      const parsed = await parseCliIncremental(file, null);
      if (!parsed) continue;
      const f = parsed.facts;
      batch.push({
        id: f.id,
        path: file,
        costUsd: f.costUsd,
        tokens: f.costTokens,
        model: f.model,
        unpriced: f.costUnpriced,
        lastActivityAt: f.lastActivityAt,
        byDay: f.costByDay,
        fileSize: size,
      });
      result.priced++;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  store.recordCost(batch);
  return result;
}
