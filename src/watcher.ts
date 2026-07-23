import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import { CONFIG } from "./config.js";
import { correlate } from "./correlate.js";
import { resolve } from "./deriveState.js";
import { parseCliTranscript } from "./parseCli.js";
import { isDesktopSessionFile, parseDesktopSession } from "./parseDesktop.js";
import { render } from "./render.js";
import type { DiscoveredSession, SessionFacts } from "./types.js";

const ONCE = process.argv.includes("--once");

/** cached raw facts, keyed by file path. State is derived from these on every render. */
const facts = new Map<string, SessionFacts>();

function isCliTranscript(p: string): boolean {
  return p.endsWith(".jsonl");
}

async function parseFile(filePath: string): Promise<SessionFacts | null> {
  if (isCliTranscript(filePath)) return parseCliTranscript(filePath);
  if (isDesktopSessionFile(filePath)) return parseDesktopSession(filePath);
  return null;
}

async function upsert(filePath: string): Promise<void> {
  const parsed = await parseFile(filePath);
  if (parsed) facts.set(filePath, parsed);
}

/** current aircraft: derive state from cached facts (cheap, no disk I/O) + dedupe */
function aircraftNow(): DiscoveredSession[] {
  const now = Date.now();
  return correlate([...facts.values()].map((f) => resolve(f, now)));
}

/** compact signature of what's on the board, to skip no-op re-renders */
function signature(list: DiscoveredSession[]): string {
  return list
    .map((a) => `${a.id}:${a.state}`)
    .sort()
    .join("|");
}

let lastSig = "";
function renderIfChanged(): void {
  const list = aircraftNow();
  const sig = signature(list);
  if (sig === lastSig) return;
  lastSig = sig;
  render(list, Date.now(), true);
}

let renderTimer: NodeJS.Timeout | null = null;
function scheduleRender(): void {
  if (ONCE) return;
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    // file changed: content (title/activity) may differ even at the same state, so
    // render unconditionally and refresh the signature.
    const list = aircraftNow();
    lastSig = signature(list);
    render(list, Date.now(), true);
  }, CONFIG.renderDebounceMs);
}

async function scanDir(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir, { recursive: true } as any);
  } catch {
    return; // dir may not exist (e.g. desktop app never used)
  }
  const targets = entries
    .map((e) => path.join(dir, e))
    .filter((p) => isCliTranscript(p) || isDesktopSessionFile(p));
  await Promise.all(targets.map((p) => upsert(p)));
}

async function main(): Promise<void> {
  const roots = [CONFIG.cliProjectsDir, ...CONFIG.desktopSessionDirs];
  await Promise.all(roots.map(scanDir));

  if (ONCE) {
    render(aircraftNow(), Date.now(), false);
    return;
  }

  lastSig = signature(aircraftNow());
  render(aircraftNow(), Date.now(), true);

  const watcher = chokidar.watch(roots, {
    ignoreInitial: true,
    persistent: true,
    depth: 8,
    // chokidar v4 dropped glob support — filter files by shape here instead
    ignored: (p: string, stats?: { isFile(): boolean }) =>
      stats?.isFile() === true && !isCliTranscript(p) && !isDesktopSessionFile(p),
  });

  watcher
    .on("add", (p) => upsert(p).then(scheduleRender))
    .on("change", (p) => upsert(p).then(scheduleRender))
    .on("unlink", (p) => {
      facts.delete(p);
      scheduleRender();
    });

  // fast tick: re-derive time-based state without touching disk. This is what makes
  // working→holding / working→idle appear within ~1s instead of on a file event.
  setInterval(renderIfChanged, CONFIG.fastTickMs);

  // safety net: occasionally re-read every file in case an fs event was missed.
  setInterval(() => {
    Promise.all([...facts.keys()].map((p) => upsert(p))).then(scheduleRender);
  }, CONFIG.reconcileMs);

  process.on("SIGINT", () => {
    watcher.close();
    process.stdout.write("\n  ✈  cleared for landing. bye.\n\n");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("watcher failed:", err);
  process.exit(1);
});
