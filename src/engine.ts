import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { CONFIG } from "./config.js";
import { correlate } from "./correlate.js";
import { resolve } from "./deriveState.js";
import { parseCliTranscript } from "./parseCli.js";
import { isDesktopSessionFile, parseDesktopSession } from "./parseDesktop.js";
import type { DiscoveredSession, SessionFacts } from "./types.js";

function isCliTranscript(p: string): boolean {
  return p.endsWith(".jsonl");
}

/**
 * What's on the board, as a string. Includes everything a consumer renders, so the
 * engine only emits `update` when something observably changed — not on every tick.
 */
function signature(list: DiscoveredSession[]): string {
  return list
    .map((a) => `${a.id}:${a.state}:${a.lastActivityAt ?? 0}:${a.title ?? ""}:${a.lastEventSummary}`)
    .sort()
    .join("|");
}

/**
 * Watches the CLI + desktop session sources, keeps a cache of parsed facts, and emits
 * `update(aircraft)` whenever the deduped, state-derived board changes. Time-based
 * transitions (working→holding) surface via a cheap fast tick that re-derives state
 * from cached facts with no disk I/O.
 */
export class Engine extends EventEmitter {
  private facts = new Map<string, SessionFacts>();
  private current: DiscoveredSession[] = [];
  private lastSig = "";
  private watcher?: FSWatcher;
  private debounce?: NodeJS.Timeout;
  private intervals: NodeJS.Timeout[] = [];

  aircraft(): DiscoveredSession[] {
    return this.current;
  }

  private async parseFile(p: string): Promise<SessionFacts | null> {
    if (isCliTranscript(p)) return parseCliTranscript(p);
    if (isDesktopSessionFile(p)) return parseDesktopSession(p);
    return null;
  }

  private async upsert(p: string): Promise<void> {
    const f = await this.parseFile(p);
    if (f) this.facts.set(p, f);
  }

  private recompute(force = false): void {
    const now = Date.now();
    const list = correlate([...this.facts.values()].map((f) => resolve(f, now)));
    const sig = signature(list);
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    this.current = list;
    this.emit("update", list);
  }

  private scheduleRecompute(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.recompute(), CONFIG.renderDebounceMs);
  }

  private async scanDir(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir, { recursive: true } as any);
    } catch {
      return; // dir may not exist (e.g. desktop app never used)
    }
    const targets = entries
      .map((e) => path.join(dir, e))
      .filter((p) => isCliTranscript(p) || isDesktopSessionFile(p));
    await Promise.all(targets.map((p) => this.upsert(p)));
  }

  /** one-shot: full scan + derive, no watchers or timers (used by `once`) */
  async scan(): Promise<void> {
    const roots = [CONFIG.cliProjectsDir, ...CONFIG.desktopSessionDirs];
    await Promise.all(roots.map((r) => this.scanDir(r)));
    this.recompute(true);
  }

  /** long-running: scan, then watch + tick for live updates */
  async start(): Promise<void> {
    await this.scan();

    const roots = [CONFIG.cliProjectsDir, ...CONFIG.desktopSessionDirs];
    this.watcher = chokidar.watch(roots, {
      ignoreInitial: true,
      persistent: true,
      depth: 8,
      // chokidar v4 dropped glob support — filter files by shape here instead
      ignored: (p: string, stats?: { isFile(): boolean }) =>
        stats?.isFile() === true && !isCliTranscript(p) && !isDesktopSessionFile(p),
    });
    this.watcher
      .on("add", (p) => this.upsert(p).then(() => this.scheduleRecompute()))
      .on("change", (p) => this.upsert(p).then(() => this.scheduleRecompute()))
      .on("unlink", (p) => {
        this.facts.delete(p);
        this.scheduleRecompute();
      });

    // fast tick: re-derive time-based state without disk I/O
    this.intervals.push(setInterval(() => this.recompute(), CONFIG.fastTickMs));
    // safety net: occasionally re-read all files in case an fs event was missed
    this.intervals.push(
      setInterval(() => {
        Promise.all([...this.facts.keys()].map((p) => this.upsert(p))).then(() => this.recompute());
      }, CONFIG.reconcileMs),
    );
  }

  async stop(): Promise<void> {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    if (this.debounce) clearTimeout(this.debounce);
    await this.watcher?.close();
  }
}
