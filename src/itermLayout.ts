import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { asLiteral, launch, resumeCommand } from "./open.js";

const exec = promisify(execFile);

/** one pane of an iTerm tab: a Claude session to resume, or a plain shell to reopen in its folder */
export type LayoutPane =
  | { kind: "claude"; sessionId: string; cwd: string; account: string | null }
  | { kind: "shell"; cwd: string };

export interface LayoutWindow {
  /** AppleScript bounds: left, top, right, bottom */
  bounds: [number, number, number, number];
  /** tabs in order, each with its panes in order */
  tabs: LayoutPane[][];
}

export interface ItermLayout {
  at: number;
  /** when the iTerm instance we scanned started — tells a snapshot from a previous run */
  itermStartedAt: number;
  windows: LayoutWindow[];
}

/** what a live Claude process is running, as far as the board knows */
export type ResolvePane = (pid: number, command: string) => { sessionId: string; cwd: string | null; account: string | null } | null;

/** `ps -o etime` ([[dd-]hh:]mm:ss) in seconds */
export function parseEtime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/** when the running iTerm2 started (ms), or null when it isn't running */
export async function itermStartedAt(): Promise<number | null> {
  try {
    const { stdout } = await exec("pgrep", ["-x", "iTerm2"]);
    const pid = stdout.trim().split("\n")[0];
    if (!pid) return null;
    const secs = parseEtime((await exec("ps", ["-o", "etime=", "-p", pid])).stdout);
    return secs == null ? null : Date.now() - secs * 1000;
  } catch {
    return null; // pgrep exits 1 when nothing matches
  }
}

// "|" separators: `tab` is an iTerm class inside the tell block. The running check keeps a scan
// from ever launching iTerm.
const SCAN_SCRIPT = `if application id "com.googlecode.iterm2" is not running then return ""
tell application id "com.googlecode.iterm2"
  set out to ""
  repeat with w in windows
    set b to bounds of w
    set out to out & "W|" & (item 1 of b) & "," & (item 2 of b) & "," & (item 3 of b) & "," & (item 4 of b) & linefeed
    repeat with t in tabs of w
      set out to out & "T" & linefeed
      repeat with s in sessions of t
        set out to out & "S|" & (tty of s) & linefeed
      end repeat
    end repeat
  end repeat
  return out
end tell`;

export interface RawWindow {
  bounds: [number, number, number, number];
  tabs: string[][];
}

/** the scan script's output → windows of tabs of pane ttys */
export function parseScan(out: string): RawWindow[] {
  const windows: RawWindow[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("W|")) {
      const b = line.slice(2).split(",").map(Number);
      if (b.length === 4 && b.every(Number.isFinite)) windows.push({ bounds: b as RawWindow["bounds"], tabs: [] });
    } else if (line === "T") windows.at(-1)?.tabs.push([]);
    else if (line.startsWith("S|")) windows.at(-1)?.tabs.at(-1)?.push(line.slice(2).trim());
  }
  return windows;
}

const CLAUDE_CMD = /^(?:\S*\/)?claude(?:\s|$)|\/claude\/versions\/[\d.]+(?:\s|$)/;
const SHELL_CMD = /^-?(?:\S*\/)?(?:zsh|bash|fish|sh)(?:\s|$)/;

interface Proc {
  pid: number;
  command: string;
}

async function procsByTty(): Promise<Map<string, Proc[]>> {
  const { stdout } = await exec("ps", ["-axo", "pid=,tty=,command="], { maxBuffer: 8 << 20 });
  const m = new Map<string, Proc[]>();
  for (const line of stdout.split("\n")) {
    const p = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!p || p[2] === "??") continue;
    const tty = `/dev/${p[2]}`;
    const list = m.get(tty) ?? [];
    list.push({ pid: Number(p[1]), command: p[3] });
    m.set(tty, list);
  }
  for (const list of m.values()) list.sort((a, b) => a.pid - b.pid);
  return m;
}

async function cwdsOf(pids: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  if (!pids.length) return m;
  let stdout = "";
  try {
    ({ stdout } = await exec("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], { maxBuffer: 4 << 20 }));
  } catch (e) {
    stdout = (e as { stdout?: string }).stdout ?? ""; // lsof exits 1 if any pid is gone
  }
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) m.set(pid, line.slice(1));
  }
  return m;
}

/** the open iTerm windows as a layout, or null when iTerm doesn't answer */
export async function scanIterm(resolve: ResolvePane, startedAt: number): Promise<ItermLayout | null> {
  let raw: RawWindow[];
  try {
    raw = parseScan((await launch("osascript", ["-e", SCAN_SCRIPT])).stdout);
  } catch {
    return null;
  }
  const procs = await procsByTty();
  const picks = raw.map((w) =>
    w.tabs.map((tab) =>
      tab.map((tty) => {
        const list = procs.get(tty) ?? [];
        const claude = list.find((p) => CLAUDE_CMD.test(p.command) && !p.command.includes("--chrome-native-host"));
        return { claude, shell: list.find((p) => SHELL_CMD.test(p.command)) };
      }),
    ),
  );
  const cwds = await cwdsOf(picks.flat(2).flatMap((p) => [p.claude?.pid, p.shell?.pid]).filter((x): x is number => !!x));
  const windows: LayoutWindow[] = [];
  raw.forEach((w, wi) => {
    const tabs: LayoutPane[][] = [];
    for (const tab of picks[wi]) {
      const panes: LayoutPane[] = [];
      for (const { claude, shell } of tab) {
        if (claude) {
          const s = resolve(claude.pid, claude.command);
          const cwd = s?.cwd ?? cwds.get(claude.pid);
          if (s && cwd) {
            panes.push({ kind: "claude", sessionId: s.sessionId, cwd, account: s.account });
            continue;
          }
        }
        const cwd = (shell && cwds.get(shell.pid)) || (claude && cwds.get(claude.pid));
        if (cwd) panes.push({ kind: "shell", cwd });
      }
      if (panes.length) tabs.push(panes);
    }
    if (tabs.length) windows.push({ bounds: w.bounds, tabs });
  });
  return { at: Date.now(), itermStartedAt: startedAt, windows };
}

/** AppleScript that reopens the windows: same bounds, tabs in order, extra panes split vertically */
export function restoreScript(windows: LayoutWindow[], configDirOf: (account: string | null) => string | null): string {
  const cmd = (p: LayoutPane) =>
    asLiteral(p.kind === "claude" ? resumeCommand(p.cwd, p.sessionId, configDirOf(p.account)) : `cd ${JSON.stringify(p.cwd)}`);
  const lines = ['tell application id "com.googlecode.iterm2"', "activate"];
  for (const w of windows) {
    lines.push("set w to (create window with default profile)", `set bounds of w to {${w.bounds.join(", ")}}`);
    w.tabs.forEach((panes, ti) => {
      lines.push(ti === 0 ? "set s to current session of w" : "tell w to set t to (create tab with default profile)", ...(ti === 0 ? [] : ["set s to current session of t"]));
      panes.forEach((p, pi) => {
        if (pi > 0) lines.push("tell s to set s to (split vertically with default profile)");
        lines.push(`tell s to write text "${cmd(p)}"`);
      });
    });
  }
  lines.push("end tell", 'return "ok"');
  return lines.join("\n");
}

/** true if iTerm ran the restore script */
export async function restoreIterm(windows: LayoutWindow[], configDirOf: (account: string | null) => string | null): Promise<boolean> {
  try {
    const { stdout } = await launch("osascript", ["-e", restoreScript(windows, configDirOf)]);
    return stdout.trim() === "ok";
  } catch {
    return false;
  }
}

export const claudeIds = (l: ItermLayout): string[] =>
  l.windows.flatMap((w) => w.tabs.flat()).flatMap((p) => (p.kind === "claude" ? [p.sessionId] : []));
