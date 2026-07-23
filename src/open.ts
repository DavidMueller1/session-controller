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

/**
 * Walk a process's ancestry to find which app hosts a CLI session (macOS `ps`).
 * `comm` is the full executable path, e.g. .../PhpStorm.app/Contents/MacOS/phpstorm.
 */
async function detectHost(pid: number): Promise<string> {
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
    if (/phpstorm|webstorm|intellij|pycharm|goland|rubymine|clion|rider|datagrip/i.test(comm)) return "phpstorm";
    if (/iterm/i.test(comm)) return "iterm";
    if (/warp/i.test(comm)) return "warp";
    if (/Terminal/i.test(comm)) return "terminal";
    p = Number(m[1]);
    if (!p || p === 1) break;
  }
  return "unknown";
}

/** macOS `open -a <app> [path]` */
async function openApp(app: string, path?: string): Promise<void> {
  await exec("open", path ? ["-a", app, path] : ["-a", app]);
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

  // CLI session → detect the host from the live pid (default to PhpStorm)
  const host = t.pid ? await detectHost(t.pid) : "phpstorm";

  if (host === "iterm" || host === "terminal" || host === "warp") {
    await openApp(host === "iterm" ? "iTerm" : host === "warp" ? "Warp" : "Terminal");
    return { ok: true, action: `focus-${host}` };
  }

  // phpstorm / other jetbrains / unknown → focus the project window at cwd
  if (t.cwd) {
    try {
      await openApp("PhpStorm", t.cwd);
      return { ok: true, action: "focus-phpstorm", detail: t.cwd };
    } catch {
      await exec("open", [t.cwd]);
      return { ok: true, action: "open-folder", detail: t.cwd };
    }
  }
  return { ok: false, action: "no-target" };
}
