import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DevPort, DevServerInfo, DiscoveredSession } from "./types.js";

const exec = promisify(execFile);

// Bound concurrent `git` spawns. A board with 50+ strips would otherwise fire 50+ git
// processes at once (per scan AND per /api/repos), saturating the machine so most calls
// hit their timeout and fail — the "only 3 of 52 repos resolved" bug. A small pool keeps
// every call fast enough to finish. All git in this module goes through here.
const GIT_LIMIT = 6;
let gitActive = 0;
const gitQueue: (() => void)[] = [];
async function gitExec(args: string[], timeout = 5_000): Promise<string> {
  if (gitActive >= GIT_LIMIT) await new Promise<void>((r) => gitQueue.push(r));
  gitActive++;
  try {
    const { stdout } = await exec("git", args, { timeout });
    return stdout;
  } finally {
    gitActive--;
    gitQueue.shift()?.();
  }
}

/** a single listening TCP socket owned by one of the user's processes */
interface Listener {
  pid: number;
  port: number;
  /** bind interface as lsof reports it: "127.0.0.1" | "::1" | "*" */
  addr: string;
  cwd: string | null;
  /** owning process's command line (for framework labelling) */
  cmd: string;
}

/** well-known ports that are infrastructure, not the app you'd open in a browser */
const KNOWN: Record<number, { role: DevPort["role"]; label: string }> = {
  24678: { role: "hmr", label: "Vite HMR" },
  6006: { role: "storybook", label: "Storybook" },
  6007: { role: "storybook", label: "Storybook" },
};

/** ports people habitually run web dev servers on — a mild tie-breaker, never decisive */
const COMMON_APP_PORTS = new Set([3000, 3001, 4000, 4200, 4321, 5173, 5174, 8000, 8080, 1420, 5000]);

/** framework tokens in a process command line → a friendly label; presence flags a frontend */
const FRAMEWORKS: { re: RegExp; label: string }[] = [
  { re: /\bvite\b/i, label: "Vite" },
  { re: /\bnext\b/i, label: "Next.js" },
  { re: /\bnuxt\b/i, label: "Nuxt" },
  { re: /\bastro\b/i, label: "Astro" },
  { re: /\bremix\b/i, label: "Remix" },
  { re: /\b(webpack|webpack-dev-server)\b/i, label: "webpack" },
  { re: /\b(ng|angular)\b/i, label: "Angular" },
  { re: /\bvue-cli-service\b/i, label: "Vue CLI" },
  { re: /\bsvelte(kit)?\b/i, label: "SvelteKit" },
];

/** backend tokens — still a dev server, but not the port you'd open first */
const BACKENDS: { re: RegExp; label: string }[] = [
  { re: /\bnest\b/i, label: "NestJS" },
  { re: /\b(bff|bff-service)\b/i, label: "BFF" },
  { re: /\bexpress\b/i, label: "Express" },
  { re: /\bfastify\b/i, label: "Fastify" },
];

/**
 * Detects dev servers by observation, not configuration: it lists the user's own
 * listening TCP sockets (`lsof`), resolves each owner process's working directory, and
 * attributes ports to a strip when that cwd sits inside the strip's git root. A server
 * you started by hand in a terminal lights up on its strip automatically — no per-project
 * setup needed for detection.
 *
 * Picking WHICH port is "the app" can't be done from the number alone (real apps often
 * bind random high ports). So we group ports by owning process, label each, and score a
 * best guess — the strongest signal being the HMR-sibling rule: the non-HMR port sharing
 * a process with a known HMR port (e.g. Vite's 24678) is the app. Every candidate is
 * carried through so the UI can offer the rest in a list.
 *
 * Read-only and macOS-oriented (`lsof`, `ps`, `git`). If `lsof` isn't present the scan
 * returns nothing, so the feature degrades to "no dev servers detected".
 */
export class DevServerScanner {
  /** cwd → git top-level (worktree root), or null when it isn't a repo. Cached because a
   *  session's folder is stable, so we resolve each root at most once. */
  private rootCache = new Map<string, string | null>();
  /** cwd → repo identity (shared git dir + friendly name), cached like rootCache */
  private repoCache = new Map<string, { key: string; name: string }>();

  /** Run one scan and attribute detected ports to the given aircraft, keyed by id. */
  async scan(aircraft: DiscoveredSession[]): Promise<Map<string, DevServerInfo>> {
    const listeners = await this.listListeners();
    const out = new Map<string, DevServerInfo>();
    if (listeners.length === 0) return out;

    // processes that own a known HMR port — their OTHER ports are strong app candidates
    const hmrPids = new Set(listeners.filter((l) => KNOWN[l.port]?.role === "hmr").map((l) => l.pid));

    // resolve every distinct project's git root up front, in parallel — sequential awaits
    // over 100+ strips would let `git` calls time out under startup load (and a timed-out
    // root must NOT be cached as "not a repo", or that folder never recovers)
    const projects = [...new Set(aircraft.map((a) => a.project).filter((p): p is string => !!p))];
    const roots = new Map<string, string | null>();
    await Promise.all(projects.map(async (p) => roots.set(p, await this.rootOf(p))));

    for (const a of aircraft) {
      if (!a.project) continue;
      const root = roots.get(a.project);
      if (!root) continue;
      const mine = listeners.filter((l) => l.cwd && isInside(l.cwd, root));
      if (mine.length === 0) continue;

      const candidates = mine
        .map((l) => describe(l, hmrPids.has(l.pid)))
        .sort((x, y) => y.score - x.score || x.port - y.port);
      const best = candidates[0];
      const repo = await this.resolveRepo(a.project);
      out.set(a.id, {
        port: best.port,
        pid: best.pid,
        managed: false,
        candidates: candidates.map(strip),
        repoKey: repo?.key ?? "",
        repoName: repo?.name ?? "",
        urlTemplate: null, // filled by the server from project_config
      });
    }
    return out;
  }

  /** the user's own listening TCP sockets, each with its owner's cwd + command resolved */
  private async listListeners(): Promise<Listener[]> {
    const args = ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-FpPn"];
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid != null) args.push("-u", String(uid));

    let stdout: string;
    try {
      ({ stdout } = await exec("lsof", args, { timeout: 4_000, maxBuffer: 4 << 20 }));
    } catch {
      return []; // lsof missing / nothing listening (non-zero exit on empty set)
    }

    // -F output: a `p<pid>` line begins a process block; `n<addr>` lines carry the socket
    // address. Parse statefully so it's robust to field ordering across lsof versions.
    const byPid = new Map<number, { addr: string; port: number }[]>();
    let pid = 0;
    for (const line of stdout.split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1)) || 0;
      else if (line[0] === "n" && pid) {
        const hit = parseAddr(line.slice(1));
        if (hit) (byPid.get(pid) ?? byPid.set(pid, []).get(pid)!).push(hit);
      }
    }
    if (byPid.size === 0) return [];

    const pids = [...byPid.keys()];
    const [cwds, cmds] = await Promise.all([this.cwdsOf(pids), cmdsOf(pids)]);
    const listeners: Listener[] = [];
    for (const [p, socks] of byPid) {
      // one process can list the same port on several fds (IPv4 + IPv6) — dedupe by port
      const seen = new Set<number>();
      for (const s of socks) {
        if (seen.has(s.port)) continue;
        seen.add(s.port);
        listeners.push({ pid: p, port: s.port, addr: s.addr, cwd: cwds.get(p) ?? null, cmd: cmds.get(p) ?? "" });
      }
    }
    return listeners;
  }

  /** pid → working directory, via one batched `lsof -d cwd` call */
  private async cwdsOf(pids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    let stdout: string;
    try {
      ({ stdout } = await exec("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], {
        timeout: 4_000,
        maxBuffer: 4 << 20,
      }));
    } catch {
      return out;
    }
    let pid = 0;
    for (const line of stdout.split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1)) || 0;
      else if (line[0] === "n" && pid) out.set(pid, line.slice(1));
    }
    return out;
  }

  /**
   * A folder's REPO identity, shared by every worktree of the same clone: keyed by the
   * common git dir (`--git-common-dir` resolves to `<main>/.git` from any worktree). So a
   * per-repo setting is configured once and applies to all its worktrees. Public because
   * the settings endpoint resolves repos for strips too. Null failures aren't cached, so a
   * transient git timeout self-heals on the next call.
   */
  async resolveRepo(cwd: string): Promise<{ key: string; name: string } | null> {
    const cached = this.repoCache.get(cwd);
    if (cached) return cached;
    if (!existsSync(cwd)) return null; // deleted worktree (offline session) — skip, don't spawn git
    try {
      let dir = (await gitExec(["-C", cwd, "rev-parse", "--git-common-dir"])).trim();
      if (!dir) return null;
      if (!path.isAbsolute(dir)) dir = path.resolve(cwd, dir); // git prints ".git" from the main worktree
      try {
        dir = await realpath(dir);
      } catch {
        /* keep the unresolved path */
      }
      const root = path.basename(dir) === ".git" ? path.dirname(dir) : dir;
      const repo = { key: dir, name: path.basename(root) };
      this.repoCache.set(cwd, repo);
      return repo;
    } catch {
      return null;
    }
  }

  /** public accessor for a folder's worktree root (git top-level), cached. Used by the
   *  server to know where to launch/attribute a managed dev server. */
  async resolveRoot(cwd: string): Promise<string | null> {
    return this.rootOf(cwd);
  }

  private async rootOf(cwd: string): Promise<string | null> {
    const cached = this.rootCache.get(cwd);
    if (cached) return cached;
    if (!existsSync(cwd)) return null; // deleted worktree — no point spawning git
    try {
      const root = (await gitExec(["-C", cwd, "rev-parse", "--show-toplevel"])).trim() || null;
      // Only cache a real answer. A failure here is usually a transient timeout under load,
      // not proof the folder isn't a repo — caching null would strand it forever, so we let
      // the next scan retry instead.
      if (root) this.rootCache.set(cwd, root);
      return root;
    } catch {
      return null;
    }
  }
}

/** pid → command line, via one batched `ps` call */
async function cmdsOf(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  let stdout: string;
  try {
    ({ stdout } = await exec("ps", ["-p", pids.join(","), "-o", "pid=,command="], { timeout: 3_000, maxBuffer: 4 << 20 }));
  } catch {
    return out;
  }
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

/** a candidate port with its computed label + ranking score (score is internal) */
type Scored = DevPort & { score: number };

/** classify + score one listener as a dev-server candidate for its strip */
function describe(l: Listener, ownerHasHmr: boolean): Scored {
  const known = KNOWN[l.port];
  const fw = FRAMEWORKS.find((f) => f.re.test(l.cmd));
  const be = BACKENDS.find((b) => b.re.test(l.cmd));

  let role: DevPort["role"] = "unknown";
  let label: string;
  if (known) {
    role = known.role;
    label = known.label;
  } else if (fw) {
    role = "app";
    label = `${fw.label} dev server`;
  } else if (be) {
    role = "api";
    label = `${be.label} (API)`;
  } else {
    role = ownerHasHmr ? "app" : "unknown";
    label = ownerHasHmr ? "dev server" : "server";
  }

  let score = 0;
  if (role === "hmr") score -= 100; // an HMR socket is never the page you open
  if (role === "storybook") score -= 30;
  if (role === "api") score -= 20;
  if (ownerHasHmr && role !== "hmr") score += 50; // HMR-sibling: this is the app it serves
  if (fw) score += 20;
  if (COMMON_APP_PORTS.has(l.port)) score += 10;

  return { port: l.port, pid: l.pid, addr: l.addr, proc: procLabel(l.cmd, fw?.label ?? be?.label), role, label, score };
}

/** drop the internal score before the candidate crosses the wire */
function strip(s: Scored): DevPort {
  const { score, ...rest } = s;
  return rest;
}

/** a short human label for a process, e.g. "Vite", "node", "php" */
function procLabel(cmd: string, framework?: string): string {
  if (framework) return framework;
  const bin = cmd.trim().split(/\s+/)[0] ?? "";
  const base = path.basename(bin);
  return base || "process";
}

/** parse an lsof network address into { addr, port }: `127.0.0.1:5173`, `[::1]:5173`, `*:5173` */
function parseAddr(raw: string): { addr: string; port: number } | null {
  const i = raw.lastIndexOf(":");
  if (i < 0) return null;
  const port = Number(raw.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  let addr = raw.slice(0, i);
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1); // unwrap [::1]
  return { addr, port };
}

/** is `child` the same as, or nested under, `root`? */
function isInside(child: string, root: string): boolean {
  if (child === root) return true;
  return child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
