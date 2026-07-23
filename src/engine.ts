import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { CONFIG } from "./config.js";
import { correlate } from "./correlate.js";
import { resolve } from "./deriveState.js";
import { parseCliTranscript } from "./parseCli.js";
import { isDesktopSessionFile, parseDesktopSession } from "./parseDesktop.js";
import { type RegistryEntry, isRegistryFile, parseRegistryFile } from "./registry.js";
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
  /** live session registry, keyed by file path (a few running sessions) */
  private registry = new Map<string, RegistryEntry>();
  /** per-aircraft: current state + when it was entered (drives the displayed timer) */
  private stateSince = new Map<string, { state: string; since: number }>();
  private current: DiscoveredSession[] = [];
  private lastSig = "";
  private watcher?: FSWatcher;
  private debounce?: NodeJS.Timeout;
  private intervals: NodeJS.Timeout[] = [];

  aircraft(): DiscoveredSession[] {
    return this.current;
  }

  /** live registry entry (pid / entrypoint / cwd) for an aircraft id, if it's running */
  registryEntry(id: string): RegistryEntry | undefined {
    return this.registryBySession().get(id);
  }

  private async parseFile(p: string): Promise<SessionFacts | null> {
    if (isCliTranscript(p)) return parseCliTranscript(p);
    if (isDesktopSessionFile(p)) return parseDesktopSession(p);
    return null;
  }

  private async upsert(p: string): Promise<void> {
    if (isRegistryFile(p)) {
      const entry = await parseRegistryFile(p);
      if (entry) this.registry.set(p, entry);
      return;
    }
    const f = await this.parseFile(p);
    if (f) this.facts.set(p, f);
  }

  private forget(p: string): void {
    this.facts.delete(p);
    this.registry.delete(p);
  }

  /** sessionId → registry entry (rebuilt cheaply; only a handful of live sessions) */
  private registryBySession(): Map<string, RegistryEntry> {
    const m = new Map<string, RegistryEntry>();
    for (const e of this.registry.values()) m.set(e.sessionId, e);
    return m;
  }

  private recompute(force = false): void {
    const now = Date.now();
    const names = this.registryBySession();
    const seen = new Set<string>();
    const list = correlate([...this.facts.values()].map((f) => resolve(f, now))).map((a) => {
      // a terminal session's rename (registry `name`) is its callsign; desktop titles
      // are left as-is (their metadata title is already good).
      const name = names.get(a.id)?.name;
      const titled = name ? { ...a, title: name } : a;

      // stateSince: the moment this aircraft entered its current state. It drives the
      // displayed timer + ordering, so tool calls / thinking don't reset the clock or
      // reshuffle the board — only a real state change does. lastActivityAt still drives
      // the MIA/dormant thresholds internally.
      seen.add(titled.id);
      const prev = this.stateSince.get(titled.id);
      const since = prev && prev.state === titled.state ? prev.since : prev ? now : titled.lastActivityAt ?? now;
      this.stateSince.set(titled.id, { state: titled.state, since });
      return { ...titled, stateSince: since };
    });
    for (const id of [...this.stateSince.keys()]) if (!seen.has(id)) this.stateSince.delete(id);

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
      .filter((p) => isCliTranscript(p) || isDesktopSessionFile(p) || isRegistryFile(p));
    await Promise.all(targets.map((p) => this.upsert(p)));
  }

  /** one-shot: full scan + derive, no watchers or timers (used by `once`) */
  async scan(): Promise<void> {
    const roots = [CONFIG.cliProjectsDir, CONFIG.sessionsDir, ...CONFIG.desktopSessionDirs];
    await Promise.all(roots.map((r) => this.scanDir(r)));
    this.recompute(true);
  }

  /** long-running: scan, then watch + tick for live updates */
  async start(): Promise<void> {
    await this.scan();

    const roots = [CONFIG.cliProjectsDir, CONFIG.sessionsDir, ...CONFIG.desktopSessionDirs];
    this.watcher = chokidar.watch(roots, {
      ignoreInitial: true,
      persistent: true,
      depth: 8,
      // chokidar v4 dropped glob support — filter files by shape here instead
      ignored: (p: string, stats?: { isFile(): boolean }) =>
        stats?.isFile() === true && !isCliTranscript(p) && !isDesktopSessionFile(p) && !isRegistryFile(p),
    });
    this.watcher
      .on("add", (p) => this.upsert(p).then(() => this.scheduleRecompute()))
      .on("change", (p) => this.upsert(p).then(() => this.scheduleRecompute()))
      .on("unlink", (p) => {
        this.forget(p);
        this.scheduleRecompute();
      });

    // fast tick: re-derive time-based state without disk I/O
    this.intervals.push(setInterval(() => this.recompute(), CONFIG.fastTickMs));
    // safety net: occasionally re-read all files in case an fs event was missed
    this.intervals.push(
      setInterval(() => {
        Promise.all([...this.facts.keys(), ...this.registry.keys()].map((p) => this.upsert(p))).then(() => this.recompute());
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
