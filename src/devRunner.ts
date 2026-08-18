import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Store } from "./store.js";

/** is a pid still alive? EPERM = alive (someone else's), ESRCH = gone. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Shell prelude: load nvm and `nvm use` (reads the repo's .nvmrc) so a command runs on the
 * project's Node, exactly like a terminal would — the tower's own Node otherwise trips
 * engines checks (the "Expected 24.13.0, got 22" class of failure). Guards make it a no-op
 * when nvm or .nvmrc aren't present.
 */
const NVM_PRELUDE =
  'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; ' +
  '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; ' +
  "[ -f .nvmrc ] && nvm use >/dev/null 2>&1; ";

/** stable, filesystem-safe log filename for a worktree root */
function logNameFor(root: string): string {
  let h = 5381;
  for (let i = 0; i < root.length; i++) h = ((h << 5) + h + root.charCodeAt(i)) >>> 0;
  return `${path.basename(root) || "root"}-${h.toString(36)}.log`;
}

interface Managed {
  root: string;
  pid: number;
  command: string;
  logFile: string;
  startedAt: number;
  /** present only for servers we spawned in THIS tower instance (lost after re-adopt) */
  child?: ChildProcess;
}

/**
 * Starts, stops and tails app-managed dev servers. A server is spawned detached, in a new
 * process group, through the user's login shell (so nvm/PATH resolve), with stdout+stderr
 * redirected to a per-root log FILE — not an in-process pipe — so logs and liveness survive
 * a tower restart. Keyed by worktree root, matching how detection attributes ports.
 */
export class DevRunner {
  private managed = new Map<string, Managed>();
  /** last unexpected exit per root (not set for intentional Stop) — drives the UI's
   *  "exited" state so a crash isn't silent. Cleared on the next successful start. */
  private lastExit = new Map<string, { code: number | null; at: number }>();
  /** roots we're intentionally stopping, so their exit isn't reported as a crash */
  private stopping = new Set<string>();
  /** one-shot install runs per root (e.g. `pnpm install`), tracked for the UI + its log */
  private installs = new Map<string, { running: boolean; code: number | null; at: number; child?: ChildProcess }>();
  private logDir: string;

  constructor(
    private store: Store,
    dataDir: string,
  ) {
    this.logDir = path.join(dataDir, "dev-logs");
    mkdirSync(this.logDir, { recursive: true });
  }

  /** re-adopt persisted servers whose process is still alive; prune the dead ones */
  adopt(): void {
    for (const s of this.store.getDevServers()) {
      if (isPidAlive(s.pid)) this.managed.set(s.root, { ...s });
      else this.store.deleteDevServer(s.root);
    }
  }

  managedFor(root: string): { pid: number; startedAt: number; command: string } | null {
    const m = this.managed.get(root);
    return m ? { pid: m.pid, startedAt: m.startedAt, command: m.command } : null;
  }

  /** drop any managed server whose process has exited on its own (called on the scan tick).
   *  Catches re-adopted servers that die out-of-band (no child 'exit' listener). */
  reconcile(): void {
    for (const [root, m] of this.managed)
      if (!isPidAlive(m.pid)) {
        this.lastExit.set(root, { code: null, at: Date.now() });
        this.clear(root);
      }
  }

  /** last unexpected exit for a root (crash), or null */
  exitFor(root: string): { code: number | null; at: number } | null {
    return this.lastExit.get(root) ?? null;
  }

  private clear(root: string): void {
    this.managed.delete(root);
    this.store.deleteDevServer(root);
  }

  /** start (or return the already-running) managed server for a worktree root */
  async start(root: string, command: string): Promise<{ pid: number } | { error: string }> {
    const existing = this.managed.get(root);
    if (existing && isPidAlive(existing.pid)) return { pid: existing.pid };
    if (!command.trim()) return { error: "no dev command configured for this repo" };
    if (!existsSync(root)) return { error: "worktree folder no longer exists" };

    const logFile = this.logPath(root);
    // fresh log per run
    await fs.writeFile(logFile, `=== ${new Date().toISOString()} · started: ${command} · cwd: ${root} ===\n`);

    const shell = process.env.SHELL || "/bin/zsh";
    // Match a terminal so the command "just works": a login shell resolves PATH, plus the
    // nvm prelude activates the repo's Node. Detached → own process group; the whole group
    // redirects to the log so output outlives this parent.
    const child = spawn(shell, ["-lc", `{ ${NVM_PRELUDE}${command} ; } >> "${logFile}" 2>&1`], {
      cwd: root,
      detached: true,
      stdio: "ignore",
    });
    if (child.pid == null) return { error: "failed to spawn" };
    child.unref();

    const m: Managed = { root, pid: child.pid, command, logFile, startedAt: Date.now(), child };
    this.lastExit.delete(root); // a fresh start clears any prior crash marker
    child.on("exit", (code) => {
      // record a crash unless we asked it to stop; fires while this tower instance lives
      if (!this.stopping.has(root)) this.lastExit.set(root, { code: code ?? null, at: Date.now() });
      this.stopping.delete(root);
      this.clear(root);
    });
    this.managed.set(root, m);
    this.store.setDevServer({ root, pid: m.pid, command, logFile, startedAt: m.startedAt });
    return { pid: m.pid };
  }

  /** stop a managed server: SIGTERM the whole group, then SIGKILL after a grace period */
  async stop(root: string): Promise<{ ok: boolean }> {
    const m = this.managed.get(root);
    if (!m) return { ok: false };
    this.stopping.add(root); // so the imminent exit isn't logged as a crash
    this.lastExit.delete(root);
    this.signal(m.pid, "SIGTERM");
    this.clear(root);
    setTimeout(() => {
      if (isPidAlive(m.pid)) this.signal(m.pid, "SIGKILL");
    }, 3_000);
    return { ok: true };
  }

  /** run a one-shot install (e.g. `pnpm install`) in the worktree, streaming to its own log.
   *  Detached so a tower restart doesn't abort a half-done install. Returns immediately; the
   *  UI watches progress via the install log + the state from installStateFor(). */
  async install(root: string, command: string): Promise<{ ok: true } | { error: string }> {
    if (!existsSync(root)) return { error: "worktree folder no longer exists" };
    if (this.installs.get(root)?.running) return { ok: true }; // already installing
    const logFile = this.logPath(root, "install");
    await fs.writeFile(logFile, `=== ${new Date().toISOString()} · ${command} · cwd: ${root} ===\n`);
    const shell = process.env.SHELL || "/bin/zsh";
    const child = spawn(shell, ["-lc", `{ ${NVM_PRELUDE}${command} ; } >> "${logFile}" 2>&1`], {
      cwd: root,
      detached: true,
      stdio: "ignore",
    });
    if (child.pid == null) return { error: "failed to spawn" };
    child.unref();
    const rec = { running: true, code: null as number | null, at: 0, child };
    this.installs.set(root, rec);
    child.on("exit", (code) => {
      rec.running = false;
      rec.code = code ?? null;
      rec.at = Date.now();
    });
    return { ok: true };
  }

  /** install status for a root: running, and the last exit code (0 = ok). null = never run */
  installStateFor(root: string): { running: boolean; code: number | null; at: number } | null {
    const r = this.installs.get(root);
    return r ? { running: r.running, code: r.code, at: r.at } : null;
  }

  /** signal the process GROUP (negative pid) — a detached child is its own group leader,
   *  so this reaches pnpm→vite→esbuild children too */
  private signal(pid: number, sig: NodeJS.Signals): void {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  }

  /** deterministic log path for a root. The file persists after the process exits, so
   *  logs (and crash output) stay readable even once the server is no longer managed.
   *  `kind` separates the dev-server log from the one-shot install log. */
  logPath(root: string, kind: "server" | "install" = "server"): string {
    const name = logNameFor(root);
    return path.join(this.logDir, kind === "install" ? name.replace(/\.log$/, "-install.log") : name);
  }

  /** the tail of a log (recent output), for the initial panel load / crash report */
  async backlog(root: string, maxBytes = 64 * 1024, kind: "server" | "install" = "server"): Promise<string> {
    const file = this.logPath(root, kind);
    try {
      const { size } = await fs.stat(file);
      const start = Math.max(0, size - maxBytes);
      const fh = await fs.open(file, "r");
      try {
        const buf = Buffer.allocUnsafe(size - start);
        await fh.read(buf, 0, buf.length, start);
        let s = buf.toString("utf8");
        if (start > 0) s = s.slice(s.indexOf("\n") + 1); // drop the partial first line
        return s;
      } finally {
        await fh.close();
      }
    } catch {
      return "";
    }
  }

  /** current byte length of a log — the stream starts from here */
  async logSize(root: string, kind: "server" | "install" = "server"): Promise<number> {
    try {
      return (await fs.stat(this.logPath(root, kind))).size;
    } catch {
      return 0;
    }
  }

  /**
   * Tail the log file from `fromOffset`, invoking `onChunk` with appended text. Polls one
   * file (cheap — unlike watching the transcript tree). Returns a stop function.
   */
  stream(root: string, fromOffset: number, onChunk: (text: string) => void, kind: "server" | "install" = "server"): () => void {
    const logFile = this.logPath(root, kind);
    let offset = fromOffset;
    let closed = false;
    const tick = async (): Promise<void> => {
      if (closed) return;
      try {
        const { size } = await fs.stat(logFile);
        if (size > offset) {
          const fh = await fs.open(logFile, "r");
          try {
            const buf = Buffer.allocUnsafe(size - offset);
            const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
            offset += bytesRead;
            onChunk(buf.toString("utf8", 0, bytesRead));
          } finally {
            await fh.close();
          }
        }
      } catch {
        /* file may be mid-rotation; try again next tick */
      }
    };
    const timer = setInterval(() => void tick(), 500);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }

  /** SIGTERM every managed server (used on tower shutdown is NOT wanted — servers should
   *  outlive the tower; this is only for tests/explicit teardown) */
  stopAll(): void {
    for (const root of [...this.managed.keys()]) void this.stop(root);
  }
}
