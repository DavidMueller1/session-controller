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
}

type HostKind = "jetbrains" | "iterm" | "terminal" | "warp" | "unknown";
interface Host {
  kind: HostKind;
  /** the host app's executable path, captured from the process tree */
  bin?: string;
}

/**
 * Walk a CLI session's process ancestry (macOS `ps`) to find its host app. `comm` is the
 * full executable path, e.g. .../PhpStorm.app/Contents/MacOS/phpstorm — which we keep so
 * we can drive that exact IDE's launcher, no matter where it's installed.
 */
async function detectHost(pid: number): Promise<Host> {
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
    if (/phpstorm|webstorm|intellij|pycharm|goland|rubymine|clion|rider|datagrip/i.test(comm)) return { kind: "jetbrains", bin: comm };
    if (/iterm/i.test(comm)) return { kind: "iterm", bin: comm };
    if (/warp/i.test(comm)) return { kind: "warp" };
    if (/Terminal/i.test(comm)) return { kind: "terminal" };
    p = Number(m[1]);
    if (!p || p === 1) break;
  }
  return { kind: "unknown" };
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

/**
 * Bring the session's host to the front. Window/app precision only — not the exact
 * terminal tab or desktop conversation (see CONCEPT.md). macOS-only.
 */
export async function openAircraft(t: OpenTarget): Promise<OpenResult> {
  // desktop session → focus the Claude app
  if (t.entrypoint === "claude-desktop" || (t.desktopOnly && !t.pid)) {
    await openApp("Claude");
    return { ok: true, action: "focus-claude" };
  }

  const host = t.pid ? await detectHost(t.pid) : { kind: "unknown" as HostKind };

  if (host.kind === "iterm" || host.kind === "terminal" || host.kind === "warp") {
    await openApp(host.kind === "iterm" ? "iTerm" : host.kind === "warp" ? "Warp" : "Terminal");
    return { ok: true, action: `focus-${host.kind}` };
  }

  if (!t.cwd) return { ok: false, action: "no-target" };

  // focus the project ROOT (the IDE has the repo root open, not the cwd subfolder)
  const root = await projectRoot(t.cwd);

  // JetBrains: drive the exact IDE to focus the project window matching root
  if (host.kind === "jetbrains" && host.bin) {
    try {
      await focusJetBrainsProject(host.bin, root);
      return { ok: true, action: "focus-project", detail: root };
    } catch {
      // fall through to the generic fallback
    }
  }

  // fallback (no pid / detection failed): just bring PhpStorm forward at root
  try {
    await openApp("PhpStorm", root);
    return { ok: true, action: "focus-phpstorm", detail: root };
  } catch {
    await exec("open", [root]);
    return { ok: true, action: "open-folder", detail: root };
  }
}
