import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import { readHookSettings } from "./hooksHealth.js";

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
const SETTINGS = CONFIG.claudeSettingsFiles[0]; // ~/.claude/settings.json (the primary one)

const hookCmd = (arg: string): string => `bash "${SCRIPT}" ${arg}`;

/** the hook groups we own, one per event. `matcher` only where Claude Code expects it. */
const DESIRED: { event: string; arg: string; matcher?: string }[] = [
  { event: "UserPromptSubmit", arg: "working" },
  { event: "PreToolUse", arg: "working", matcher: "" },
  { event: "Stop", arg: "needs-input" },
  { event: "Notification", arg: "needs-input" },
  { event: "SessionEnd", arg: "clear" },
];

type HookEntry = { type: string; command: string };
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
    const group: HookGroup = { ...(d.matcher !== undefined ? { matcher: d.matcher } : {}), hooks: [{ type: "command", command: hookCmd(d.arg) }] };
    hooks[d.event] = [...cleaned, group];
    touched.push(d.event);
  }
  return { settings: { ...settings, hooks }, touched };
}

function readSettingsRaw(): { settings: Settings; existed: boolean } | { error: string } {
  if (!fs.existsSync(SETTINGS)) return { settings: {}, existed: false };
  let raw: string;
  try {
    raw = fs.readFileSync(SETTINGS, "utf8");
  } catch (e) {
    return { error: `cannot read ${SETTINGS}: ${String(e)}` };
  }
  try {
    return { settings: JSON.parse(raw) as Settings, existed: true };
  } catch {
    return { error: `malformed JSON in ${SETTINGS} — fix or move it aside, then re-run` };
  }
}

function verify(): void {
  const s = readHookSettings();
  console.log("");
  console.log(`  settings:  ${s.settingsFound ? SETTINGS : "not found"}`);
  console.log(`  wired:     ${s.installedEvents.length ? s.installedEvents.join(", ") : "none"}`);
  if (s.missingRequired.length) console.log(`  MISSING:   ${s.missingRequired.join(", ")}`);
  console.log(`  script:    ${SCRIPT}${fs.existsSync(SCRIPT) ? "" : "  (!! not found)"}`);
}

function main(): void {
  const check = process.argv.includes("--check") || process.argv.includes("--dry-run");

  console.log(`\n  ✈  Session Controller — hooks doctor${check ? " (check only)" : ""}\n`);

  if (!fs.existsSync(SCRIPT)) {
    console.error(`  ✗ hook script missing: ${SCRIPT}\n    (are you running from the repo?)\n`);
    process.exit(1);
  }

  if (check) {
    verify();
    const { missingRequired } = readHookSettings();
    console.log(missingRequired.length ? "\n  → run `pnpm doctor` to install the missing hooks.\n" : "\n  ✓ all required hooks are wired.\n");
    process.exit(missingRequired.length ? 1 : 0);
  }

  const read = readSettingsRaw();
  if ("error" in read) {
    console.error(`  ✗ ${read.error}\n`);
    process.exit(1);
  }

  // back up an existing file before touching it
  if (read.existed) {
    const bak = `${SETTINGS}.bak-tc-doctor-${Date.now()}`;
    fs.copyFileSync(SETTINGS, bak);
    console.log(`  • backed up existing settings → ${bak}`);
  } else {
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
    console.log(`  • no settings file yet — creating ${SETTINGS}`);
  }

  const { settings, touched } = mergeHooks(read.settings);
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  console.log(`  • wired hooks: ${touched.join(", ")}`);

  // make sure the script is executable (the hook runs it via bash, but be tidy)
  try {
    fs.chmodSync(SCRIPT, 0o755);
    console.log("  • ensured tc-state.sh is executable");
  } catch {
    /* non-fatal — the hook invokes it via `bash` anyway */
  }

  verify();
  const { missingRequired } = readHookSettings();
  if (missingRequired.length) {
    console.error(`\n  ✗ still missing after install: ${missingRequired.join(", ")}\n`);
    process.exit(1);
  }
  console.log("\n  ✓ hooks installed. New sessions pick them up immediately; restart any running session to switch it off the inferred fallback.\n");
}

main();
