import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ChangelogEntry {
  build: number | null;
  date: string;
  items: string[];
}

// CHANGELOG.md lives at the repo root, one level up from this source file — resolve it that
// way (not from cwd) so it's found whether launched from the managed clone or a dev checkout.
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");

/** Parse CHANGELOG.md: sections `## Build <N> — <date>` each followed by `- ` bullet lines. */
export function readChangelog(): ChangelogEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(FILE, "utf8");
  } catch {
    return [];
  }
  const entries: ChangelogEntry[] = [];
  let cur: ChangelogEntry | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const h = line.match(/^##\s+Build\s+(\d+)\s*[—-]\s*(.+?)\s*$/i);
    if (h) {
      cur = { build: Number(h[1]), date: h[2].trim(), items: [] };
      entries.push(cur);
      continue;
    }
    const b = line.match(/^-\s+(.*\S)\s*$/);
    if (b && cur) cur.items.push(b[1]);
  }
  return entries;
}
