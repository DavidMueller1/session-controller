import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A Claude Code config dir, i.e. one login. `~/.claude` is the default; a `~/.claude-<name>` is
 * another account run via `CLAUDE_CONFIG_DIR` (e.g. a private one in its own iTerm profile). Each
 * has its own transcripts, registry and settings.
 */
export interface Account {
  /** "default" for ~/.claude, else the dir suffix ("privat" for ~/.claude-privat) */
  id: string;
  dir: string;
  projectsDir: string;
  sessionsDir: string;
  settingsFiles: string[];
}

export const DEFAULT_ACCOUNT = "default";

function account(id: string, dir: string): Account {
  return {
    id,
    dir,
    projectsDir: path.join(dir, "projects"),
    sessionsDir: path.join(dir, "sessions"),
    settingsFiles: [path.join(dir, "settings.json"), path.join(dir, "settings.local.json")],
  };
}

export function discoverAccounts(home = os.homedir()): Account[] {
  const found = [account(DEFAULT_ACCOUNT, path.join(home, ".claude"))];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const m = e.isDirectory() ? /^\.claude-([A-Za-z0-9_-]+)$/.exec(e.name) : null;
    if (!m || m[1].toLowerCase() === DEFAULT_ACCOUNT) continue;
    const dir = path.join(home, e.name);
    // A real CLAUDE_CONFIG_DIR keeps its own .claude.json; a copy of ~/.claude (a backup) has none,
    // since the default one lives in ~ — so a backup never turns into a ghost account.
    if (fs.existsSync(path.join(dir, "projects")) && fs.existsSync(path.join(dir, ".claude.json"))) found.push(account(m[1].toLowerCase(), dir));
  }
  return found;
}

/** resolved once at startup — a new account dir is picked up on the next restart */
export const ACCOUNTS = discoverAccounts();

const byId = new Map(ACCOUNTS.map((a) => [a.id, a]));
export const accountById = (id: string | null | undefined): Account | undefined => byId.get(id ?? DEFAULT_ACCOUNT);

/** the account a transcript/registry path belongs to; anything outside one (desktop app files) is the default */
export function accountOfPath(p: string | null | undefined): string {
  if (p) for (const a of ACCOUNTS) if (a.id !== DEFAULT_ACCOUNT && p.startsWith(a.dir + path.sep)) return a.id;
  return DEFAULT_ACCOUNT;
}
