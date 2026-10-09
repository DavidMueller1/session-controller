import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNTS, type Account, DEFAULT_ACCOUNT } from "./accounts.js";
import { readAccountHooks } from "./hooksHealth.js";

/**
 * `tc doctor` — idempotently (re)install the Session Controller hook block into the
 * user's Claude Code settings, or (with --check) just report what's there.
 *
 * The hooks are what give the board accurate, near-instant state. They're a hand-edit in
 * ~/.claude/settings.json, which a Claude update can silently overwrite — this command is
 * the one-shot repair for when the health banner goes red, and the one-command setup for
 * a new machine / teammate.
 */

/** absolute path to our hook script, resolved from THIS file so cwd doesn't matter */
const SCRIPT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "hooks", "tc-state.sh");

const hookCmd = (arg: string): string => `bash "${SCRIPT}" ${arg}`;

/** the hook groups we own, one per event. `matcher` only where Claude Code expects it. */
const DESIRED: { event: string; arg: string; matcher?: string }[] = [
  { event: "UserPromptSubmit", arg: "working" },
  { event: "PreToolUse", arg: "working", matcher: "" },
  // after a tool finishes — flips an answered permission prompt back to working right away
  { event: "PostToolUse", arg: "working", matcher: "" },
  // a failed tool / an auto-mode denial: Claude carries on, same as a finished tool
  { event: "PostToolUseFailure", arg: "working", matcher: "" },
  { event: "PermissionDenied", arg: "working", matcher: "" },
  { event: "Stop", arg: "needs-input" },
  // the turn died from an API error (rate limit, overload, …) — no Stop fires, so without
  // this the strip would sit In-flight until the staleness cutoff
  { event: "StopFailure", arg: "needs-input" },
  { event: "Notification", arg: "needs-input" },
  { event: "PermissionRequest", arg: "needs-input" },
  // a (re)started session replaces a leftover "ended" marker, e.g. after `claude --resume`
  { event: "SessionStart", arg: "started" },
  { event: "SessionEnd", arg: "clear" },
];

// A hung hook would otherwise hold Claude for the 10-min default; ours finishes in ~0.1s.
const HOOK_TIMEOUT_S = 5;

type HookEntry = { type: string; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

const isOurs = (h: HookEntry): boolean => typeof h?.command === "string" && h.command.includes("tc-state.sh");

/** Merge our groups in, stripping any prior tc-state.sh entries (stale paths / dupes) but
 *  preserving every other hook — notably a user's terminal-notifier Notification hook. */
function mergeHooks(settings: Settings): { settings: Settings; touched: string[] } {
  const hooks = settings.hooks ?? {};
  const touched: string[] = [];
  for (const d of DESIRED) {
    const arr = Array.isArray(hooks[d.event]) ? hooks[d.event] : [];
    const cleaned = arr
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => (g.hooks ?? []).length > 0);
    const group: HookGroup = { ...(d.matcher !== undefined ? { matcher: d.matcher } : {}), hooks: [{ type: "command", command: hookCmd(d.arg), timeout: HOOK_TIMEOUT_S }] };
    hooks[d.event] = [...cleaned, group];
    touched.push(d.event);
  }
  return { settings: { ...settings, hooks }, touched };
}

function readSettingsRaw(file: string): { settings: Settings; existed: boolean } | { error: string } {
  if (!fs.existsSync(file)) return { settings: {}, existed: false };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { error: `cannot read ${file}: ${String(e)}` };
  }
  try {
    return { settings: JSON.parse(raw) as Settings, existed: true };
  } catch {
    return { error: `malformed JSON in ${file} — fix or move it aside, then re-run` };
  }
}

const settingsOf = (a: Account): string => a.settingsFiles[0]; // <dir>/settings.json (the primary one)
const nameOf = (a: Account): string => (a.id === DEFAULT_ACCOUNT ? "" : ` (${a.id})`);

function verify(a: Account): string[] {
  const s = readAccountHooks(a);
  console.log("");
  console.log(`  settings:  ${s.settingsFound ? settingsOf(a) : `not found (${settingsOf(a)})`}${nameOf(a)}`);
  console.log(`  wired:     ${s.installedEvents.length ? s.installedEvents.join(", ") : "none"}`);
  if (s.missingRequired.length) console.log(`  MISSING:   ${s.missingRequired.join(", ")}`);
  return s.missingRequired;
}

/** wire our hooks into one account's settings.json; false if it couldn't be read */
function install(a: Account): boolean {
  const file = settingsOf(a);
  const read = readSettingsRaw(file);
  if ("error" in read) {
    console.error(`  ✗ ${read.error}`);
    return false;
  }
  // back up an existing file before touching it
  if (read.existed) {
    const bak = `${file}.bak-tc-doctor-${Date.now()}`;
    fs.copyFileSync(file, bak);
    console.log(`  • backed up existing settings → ${bak}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    console.log(`  • no settings file yet — creating ${file}`);
  }
  const { settings, touched } = mergeHooks(read.settings);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  • wired hooks${nameOf(a)}: ${touched.join(", ")}`);
  return true;
}

function main(): void {
  const check = process.argv.includes("--check") || process.argv.includes("--dry-run");

  console.log(`\n  ✈  Session Controller — hooks doctor${check ? " (check only)" : ""}\n`);

  if (!fs.existsSync(SCRIPT)) {
    console.error(`  ✗ hook script missing: ${SCRIPT}\n    (are you running from the repo?)\n`);
    process.exit(1);
  }

  if (check) {
    const missing = ACCOUNTS.flatMap(verify);
    console.log(`  script:    ${SCRIPT}`);
    console.log(missing.length ? "\n  → run `pnpm doctor` to install the missing hooks.\n" : "\n  ✓ all required hooks are wired.\n");
    process.exit(missing.length ? 1 : 0);
  }

  // every account (~/.claude and any ~/.claude-<name>), so a second login is tracked too
  const ok = ACCOUNTS.map(install).every(Boolean);

  // make sure the script is executable (the hook runs it via bash, but be tidy)
  try {
    fs.chmodSync(SCRIPT, 0o755);
    console.log("  • ensured tc-state.sh is executable");
  } catch {
    /* non-fatal — the hook invokes it via `bash` anyway */
  }

  const missing = ACCOUNTS.flatMap(verify);
  console.log(`  script:    ${SCRIPT}`);
  if (!ok || missing.length) {
    console.error(`\n  ✗ still missing after install: ${[...new Set(missing)].join(", ") || "see errors above"}\n`);
    process.exit(1);
  }
  console.log("\n  ✓ hooks installed. New sessions pick them up immediately; restart any running session to switch it off the inferred fallback.\n");
}

main();
