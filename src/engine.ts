import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { CONFIG } from "./config.js";
import { correlate } from "./correlate.js";
import { resolve } from "./deriveState.js";
import { parseCliTranscript } from "./parseCli.js";
import { isDesktopSessionFile, parseDesktopSession } from "./parseDesktop.js";
import { fetchPr } from "./pr.js";
import { type HookState, isHookStateFile, parseHookStateFile } from "./hookState.js";
import { type RegistryEntry, isRegistryFile, parseRegistryFile } from "./registry.js";
import type { DiscoveredSession, PrInfo, SessionFacts } from "./types.js";

function isCliTranscript(p: string): boolean {
  return p.endsWith(".jsonl");
}

/**
 * Is a process still running? Used to detect a hard-killed session: Claude Code names its
 * registry file `<pid>.json` and removes it on a clean exit, but a SIGKILL / force-close
 * leaves the file orphaned with a dead pid. `kill(pid, 0)` sends no signal — it just
 * probes: no error or EPERM => alive, ESRCH => gone. Never wrongly reports a live session
 * as dead (a running process always has a live pid), so retiring on `false` is safe.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * What's on the board, as a string. Includes everything a consumer renders, so the
 * engine only emits `update` when something observably changed — not on every tick.
 */
function signature(list: DiscoveredSession[]): string {
  return list
    .map((a) => `${a.id}:${a.state}:${a.stateSource ?? ""}:${a.lastActivityAt ?? 0}:${a.title ?? ""}:${a.lastEventSummary}:${a.pr?.state ?? ""}:${a.pr?.number ?? ""}:${a.pr?.isDraft ? 1 : 0}:${a.pr?.reviewDecision ?? ""}`)
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
  /** live per-session state from our Claude Code hooks, keyed by sessionId */
  private hookState = new Map<string, HookState>();
  /** per-aircraft: current state + when it was entered (drives the displayed timer) */
  private stateSince = new Map<string, { state: string; since: number }>();
  /** last real user rename seen per session — kept so the title survives the session
   *  exiting (Claude Code removes the registry entry on exit, which would otherwise
   *  revert the title to the raw transcript-derived name) */
  private lastCallsign = new Map<string, string>();
  /** PR status per aircraft id (via gh), refreshed on a slow poll */
  private prById = new Map<string, PrInfo | null>();
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

  /** freshness of our hook-state writes — proof the hooks are actually firing */
  hookStats(now = Date.now()): { fresh: number; lastAt: number | null } {
    let fresh = 0;
    let lastAt: number | null = null;
    for (const h of this.hookState.values()) {
      if (now - h.ts < CONFIG.hookStaleMs) fresh++;
      if (lastAt === null || h.ts > lastAt) lastAt = h.ts;
    }
    return { fresh, lastAt };
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
    if (isHookStateFile(p)) {
      const h = await parseHookStateFile(p);
      if (h) this.hookState.set(h.sessionId, h);
      return;
    }
    const f = await this.parseFile(p);
    if (f) this.facts.set(p, f);
  }

  private forget(p: string): void {
    this.facts.delete(p);
    this.registry.delete(p);
    if (isHookStateFile(p)) this.hookState.delete(path.basename(p, ".json"));
  }

  /** sessionId → registry entry (rebuilt cheaply; only a handful of live sessions) */
  private registryBySession(): Map<string, RegistryEntry> {
    const m = new Map<string, RegistryEntry>();
    for (const e of this.registry.values()) m.set(e.sessionId, e);
    return m;
  }

  private recompute(force = false): void {
    const now = Date.now();
    const reg = this.registryBySession();
    const seen = new Set<string>();
    const list = correlate([...this.facts.values()].map((f) => resolve(f, now))).map((a0) => {
      const entry = reg.get(a0.id);
      // A registry entry whose process is gone = a hard-killed / force-closed session
      // (SessionEnd never fired). We must not trust its live signals below.
      const pidDead = !!entry && entry.pid != null && !isPidAlive(entry.pid);
      // Use the registry callsign only when it's a real rename. Newer desktop builds
      // auto-derive names (nameSource:"derived", e.g. "feat-traffic-controller-af") —
      // ignore those and keep the correlated ai-title / desktop title, which is far more
      // meaningful. A user rename (nameSource "user", or older builds where it's absent)
      // still wins.
      const liveCallsign = entry?.name && entry.nameSource !== "derived" ? entry.name : undefined;
      if (liveCallsign) this.lastCallsign.set(a0.id, liveCallsign);
      // Fall back to the last callsign we saw so an exited session (whose registry entry
      // Claude Code has since removed) keeps its user-given name instead of reverting.
      const callsign = liveCallsign ?? this.lastCallsign.get(a0.id);
      let a = callsign ? { ...a0, title: callsign } : a0;

      // Track which signal actually decided `state`, in ascending priority. Starts as
      // the transcript-timing inference (the ~8s-grace fallback), then upgrades as a
      // more authoritative source overrides it below.
      let stateSource: "hook" | "registry" | "inferred" = "inferred";

      // Registry `status` is Claude Code's own live signal — authoritative for CLI
      // sessions, so we trust it over transcript-timing inference: busy => working,
      // idle => waiting on you. Desktop-run sessions report null status; those fall
      // back to the inferred state. This is what makes states exact without hooks.
      if (!pidDead && entry?.status === "busy") {
        a = { ...a, state: "working", lastEventSummary: a.lastEventSummary || "active" };
        stateSource = "registry";
      } else if (!pidDead && entry?.status === "idle") {
        a = { ...a, state: "needs-input" };
        stateSource = "registry";
      }

      // Hooks are the most reliable live signal — they fire on Stop / UserPromptSubmit /
      // tool use regardless of desktop-vs-terminal or build (newer desktop builds no
      // longer publish registry `status`). A fresh hook state wins over both.
      const hs = this.hookState.get(a.id);
      if (hs?.state === "ended") {
        // The session exited (SessionEnd hook). Terminal and authoritative regardless of
        // age: drop it out of the active lanes ("wrapped up") rather than letting
        // transcript inference keep a just-exited session in-flight.
        a = { ...a, state: "suspected-done" };
        stateSource = "hook";
      } else if (hs && now - hs.ts < CONFIG.hookStaleMs) {
        if (hs.state === "working") {
          a = { ...a, state: "working", lastEventSummary: a.lastEventSummary || "active" };
          stateSource = "hook";
        } else if (hs.state === "needs-input") {
          a = { ...a, state: "needs-input" };
          stateSource = "hook";
        }
      }

      // Hard-kill safety net: the process is gone but it still looks active (a stale
      // `working` hook, or a transcript that ends mid-tool, would otherwise pin it
      // In-flight for up to hookStaleMs). Retire it straight to MIA — "lost contact".
      if (pidDead && (a.state === "working" || a.state === "needs-input")) {
        a = { ...a, state: "idle" };
        stateSource = "registry";
      }

      // stateSince: the moment this aircraft entered its current state. It drives the
      // displayed timer + ordering, so tool calls / thinking don't reset the clock or
      // reshuffle the board — only a real state change does. lastActivityAt still drives
      // the MIA/dormant thresholds internally.
      seen.add(a.id);
      const prev = this.stateSince.get(a.id);
      const since = prev && prev.state === a.state ? prev.since : prev ? now : a.lastActivityAt ?? now;
      this.stateSince.set(a.id, { state: a.state, since });
      return { ...a, stateSource, stateSince: since, pr: this.prById.get(a.id) ?? null };
    });
    for (const id of [...this.stateSince.keys()]) if (!seen.has(id)) this.stateSince.delete(id);
    for (const id of [...this.lastCallsign.keys()]) if (!seen.has(id)) this.lastCallsign.delete(id);

    const sig = signature(list);
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    this.current = list;
    this.emit("update", list);
  }

  /** refresh PR status for non-cold sessions that have a branch (bounded `gh` calls) */
  private async pollPrs(): Promise<void> {
    const targets = this.current.filter((a) => a.project && a.branch && a.state !== "dormant" && a.state !== "unknown");
    await Promise.all(
      targets.map(async (a) => {
        this.prById.set(a.id, await fetchPr(a.project!, a.branch!));
      }),
    );
    const ids = new Set(this.current.map((a) => a.id));
    for (const id of [...this.prById.keys()]) if (!ids.has(id)) this.prById.delete(id);
    this.recompute(true);
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
      .filter((p) => isCliTranscript(p) || isDesktopSessionFile(p) || isRegistryFile(p) || isHookStateFile(p));
    await Promise.all(targets.map((p) => this.upsert(p)));
  }

  /** Prune our own tc-state files once they're older than hookStateGcMs, so terminal
   *  `ended` markers and stale hook writes don't pile up. Only touches OUR directory —
   *  never Claude's registry/transcript files (the app stays read-only to those). */
  private async gcHookState(): Promise<void> {
    const now = Date.now();
    let entries: string[];
    try {
      entries = await fs.readdir(CONFIG.hookStateDir);
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((e) => e.endsWith(".json") && !e.endsWith(".tmp"))
        .map(async (e) => {
          const p = path.join(CONFIG.hookStateDir, e);
          try {
            const o = JSON.parse(await fs.readFile(p, "utf8"));
            if (typeof o?.ts === "number" && now - o.ts > CONFIG.hookStateGcMs) {
              await fs.unlink(p);
              this.hookState.delete(path.basename(e, ".json"));
            }
          } catch {
            /* unparseable — leave it; a live session may be mid-write */
          }
        }),
    );
  }

  /** one-shot: full scan + derive, no watchers or timers (used by `once`) */
  async scan(): Promise<void> {
    const roots = [CONFIG.cliProjectsDir, CONFIG.sessionsDir, CONFIG.hookStateDir, ...CONFIG.desktopSessionDirs];
    await Promise.all(roots.map((r) => this.scanDir(r)));
    this.recompute(true);
  }

  /** long-running: scan, then watch + tick for live updates */
  async start(): Promise<void> {
    // make sure the hook-state dir exists so chokidar watches it from the start
    await fs.mkdir(CONFIG.hookStateDir, { recursive: true }).catch(() => {});
    await this.scan();

    const roots = [CONFIG.cliProjectsDir, CONFIG.sessionsDir, CONFIG.hookStateDir, ...CONFIG.desktopSessionDirs];
    this.watcher = chokidar.watch(roots, {
      ignoreInitial: true,
      persistent: true,
      depth: 8,
      // chokidar v4 dropped glob support — filter files by shape here instead
      ignored: (p: string, stats?: { isFile(): boolean }) =>
        stats?.isFile() === true && !isCliTranscript(p) && !isDesktopSessionFile(p) && !isRegistryFile(p) && !isHookStateFile(p),
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

    // PR status: initial poll + slow refresh
    this.pollPrs();
    this.intervals.push(setInterval(() => this.pollPrs(), CONFIG.prPollMs));

    // prune stale tc-state files: once now, then on a slow timer
    void this.gcHookState();
    this.intervals.push(setInterval(() => void this.gcHookState(), CONFIG.hookGcMs));
  }

  async stop(): Promise<void> {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    if (this.debounce) clearTimeout(this.debounce);
    await this.watcher?.close();
  }
}
