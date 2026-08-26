import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface OpenResult {
  ok: boolean;
  action: string;
  detail?: string;
}

export interface OpenTarget {
  entrypoint?: string | null;
  pid?: number | null;
  cwd?: string | null;
  /** aircraft was seen only on the desktop surface (no CLI transcript) */
  desktopOnly?: boolean;
  /** host remembered from an earlier click, while the session was still alive */
  knownHost?: { kind: string; bin?: string | null } | null;
}

export type HostKind =
  | "jetbrains"
  | "iterm"
  | "terminal"
  | "warp"
  | "ghostty"
  | "kitty"
  | "wezterm"
  | "alacritty"
  | "unknown";

interface Host {
  kind: HostKind;
  /** the host app's executable path, captured from the process tree */
  bin?: string;
  /** the session's controlling terminal, e.g. /dev/ttys002 — only known while it lives */
  tty?: string | null;
}

/** the app name to hand to `open -a` per host kind */
const APP_NAME: Partial<Record<HostKind, string>> = {
  iterm: "iTerm",
  terminal: "Terminal",
  warp: "Warp",
  ghostty: "Ghostty",
  kitty: "kitty",
  wezterm: "WezTerm",
  alacritty: "Alacritty",
};

/** map a `ps comm` path to a host kind — first match while walking up the tree wins */
function kindOf(comm: string): HostKind | null {
  if (/phpstorm|webstorm|intellij|pycharm|goland|rubymine|clion|rider|datagrip/i.test(comm)) return "jetbrains";
  if (/iterm/i.test(comm)) return "iterm";
  if (/warp/i.test(comm)) return "warp";
  if (/ghostty/i.test(comm)) return "ghostty";
  if (/kitty/i.test(comm)) return "kitty";
  if (/wezterm/i.test(comm)) return "wezterm";
  if (/alacritty/i.test(comm)) return "alacritty";
  if (/Terminal/i.test(comm)) return "terminal";
  return null;
}

/** the session's controlling tty as an absolute device path, or null if it has none */
async function ttyOf(pid: number): Promise<string | null> {
  try {
    const { stdout } = await exec("ps", ["-o", "tty=", "-p", String(pid)]);
    const t = stdout.trim();
    if (!t || t === "??" || t === "-") return null;
    return t.startsWith("/dev/") ? t : `/dev/${t}`;
  } catch {
    return null;
  }
}

/**
 * Walk a CLI session's process ancestry (macOS `ps`) to find its host app. `comm` is the
 * full executable path, e.g. .../PhpStorm.app/Contents/MacOS/phpstorm — which we keep so
 * we can drive that exact IDE's launcher, no matter where it's installed. The tty comes
 * from the session process itself, so it is only ever a live session's tty.
 */
async function detectHost(pid: number): Promise<Host> {
  const tty = await ttyOf(pid);
  let p = pid;
  for (let i = 0; i < 8; i++) {
    let line: string;
    try {
      const { stdout } = await exec("ps", ["-o", "ppid=,comm=", "-p", String(p)]);
      line = stdout.trim();
    } catch {
      break;
    }
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) break;
    const comm = m[2];
    const kind = kindOf(comm);
    if (kind) return { kind, bin: comm, tty };
    p = Number(m[1]);
    if (!p || p === 1) break;
  }
  return { kind: "unknown", tty };
}

/** macOS `open -a <app> [path]` */
async function openApp(app: string, path?: string): Promise<void> {
  await exec("open", path ? ["-a", app, path] : ["-a", app]);
}

/**
 * The session's cwd is often a monorepo subfolder (e.g. .../shops/kartenliebe), but the
 * IDE has the repo/worktree *root* open. Resolve to the git top-level so we focus the
 * existing project window instead of opening the subfolder as a new one.
 */
async function projectRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    return stdout.trim() || cwd;
  } catch {
    return cwd;
  }
}

/**
 * Focus the JetBrains window whose project is `cwd`, by invoking the IDE binary with the
 * project path as an arg — the same thing the `phpstorm` CLI launcher does. A running IDE
 * routes this to the matching open frame, so the correct window comes forward even with
 * several projects/worktrees open. No Accessibility permission, no built-in-server token.
 */
async function focusJetBrainsProject(bin: string, cwd: string): Promise<void> {
  await exec("open", ["-na", bin, "--args", cwd]);
}

/** escape a string for embedding in an AppleScript literal */
function asLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * iTerm2 and Terminal.app both expose a session's tty over AppleScript, so we can select
 * the *exact* tab the session runs in — not just bring the app forward. Needs the
 * Automation (AppleEvents) permission for whoever runs the server; without it osascript
 * fails and the caller falls back to app-level focus.
 */
function tabScript(kind: HostKind, tty: string): string | null {
  const t = asLiteral(tty);
  if (kind === "iterm") {
    return `tell application "iTerm2"
      repeat with w in windows
        repeat with tb in tabs of w
          repeat with s in sessions of tb
            if tty of s is "${t}" then
              select w
              select tb
              select s
              activate
              return "ok"
            end if
          end repeat
        end repeat
      end repeat
    end tell
    return "miss"`;
  }
  if (kind === "terminal") {
    return `tell application "Terminal"
      repeat with w in windows
        repeat with tb in tabs of w
          if tty of tb is "${t}" then
            set selected tab of w to tb
            set frontmost of w to true
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end tell
    return "miss"`;
  }
  return null;
}

/** true if we actually selected the session's tab */
async function focusTerminalTab(kind: HostKind, tty: string): Promise<boolean> {
  const script = tabScript(kind, tty);
  if (!script) return false;
  try {
    const { stdout } = await exec("osascript", ["-e", script]);
    return stdout.trim() === "ok";
  } catch {
    return false;
  }
}

/** bring a terminal host forward — the session's tab if we can find it, else just the app */
async function focusTerminal(host: Host): Promise<OpenResult> {
  const app = APP_NAME[host.kind];
  if (host.tty && (await focusTerminalTab(host.kind, host.tty))) {
    return { ok: true, action: `focus-${host.kind}-tab`, detail: host.tty };
  }
  if (!app) return { ok: false, action: "unknown-host" };
  await openApp(app);
  return { ok: true, action: `focus-${host.kind}` };
}

/**
 * Bring the session's host to the front: the exact terminal tab where we can resolve it,
 * the matching IDE project window for JetBrains, otherwise the app. macOS-only.
 */
export async function openAircraft(t: OpenTarget): Promise<OpenResult & { host?: { kind: string; bin?: string } }> {
  // desktop session → focus the Claude app
  if (t.entrypoint === "claude-desktop" || (t.desktopOnly && !t.pid)) {
    await openApp("Claude");
    return { ok: true, action: "focus-claude" };
  }

  const host = t.pid ? await detectHost(t.pid) : { kind: "unknown" as HostKind };
  const detected = host.kind !== "unknown" ? { kind: host.kind, bin: host.bin } : undefined;
  const root = t.cwd ? await projectRoot(t.cwd) : null;

  if (host.kind !== "unknown" && host.kind !== "jetbrains") {
    return { ...(await focusTerminal(host)), host: detected };
  }

  // JetBrains: drive the exact IDE to focus the project window matching root
  if (host.kind === "jetbrains" && host.bin && root) {
    try {
      await focusJetBrainsProject(host.bin, root);
      return { ok: true, action: "focus-project", detail: root, host: detected };
    } catch {
      // fall through to the remembered host / give up
    }
  }

  // The session is gone (no pid, or its process tree told us nothing), so fall back to the
  // host we recorded the last time it *was* alive. App-level only: a recorded tty would be
  // recycled by now and could focus a stranger's tab.
  const known = t.knownHost?.kind as HostKind | undefined;
  if (known === "jetbrains" && t.knownHost?.bin && root) {
    try {
      await focusJetBrainsProject(t.knownHost.bin, root);
      return { ok: true, action: "focus-project", detail: root };
    } catch {
      // fall through
    }
  }
  if (known && APP_NAME[known]) {
    await openApp(APP_NAME[known] as string);
    return { ok: true, action: `focus-${known}` };
  }

  // Nothing known — do NOT guess an app. A surprise window is worse than no jump.
  return { ok: false, action: "unknown-host", detail: root ?? undefined };
}
