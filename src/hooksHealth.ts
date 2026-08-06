import fs from "node:fs";
import { CONFIG } from "./config.js";
import type { DiscoveredSession, HooksHealth } from "./types.js";

/** the hook events our state tracking depends on; missing any of these degrades accuracy */
const REQUIRED_EVENTS = ["UserPromptSubmit", "PreToolUse", "Stop", "SessionEnd"];

/** what the settings files say about our hook install (read, not watched) */
export interface HookSettings {
  settingsFound: boolean;
  installedEvents: string[];
  missingRequired: string[];
}

/** events in one settings JSON whose hook command references our tc-state script */
function eventsInSettings(file: string): string[] {
  let o: unknown;
  try {
    o = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return []; // missing or unparseable
  }
  const hooks = (o as { hooks?: Record<string, unknown> })?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const found: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    const arr = Array.isArray(groups) ? groups : [];
    const hit = arr.some(
      (g) =>
        Array.isArray((g as { hooks?: unknown[] })?.hooks) &&
        (g as { hooks: unknown[] }).hooks.some(
          (h) => typeof (h as { command?: unknown })?.command === "string" && (h as { command: string }).command.includes("tc-state.sh"),
        ),
    );
    if (hit) found.push(event);
  }
  return found;
}

/** Inspect the user-level settings files for our wired hooks. Cheap but does sync I/O,
 *  so callers cache this and refresh it on a slow timer rather than per board update. */
export function readHookSettings(): HookSettings {
  const files = CONFIG.claudeSettingsFiles;
  const settingsFound = files.some((f) => fs.existsSync(f));
  const installedEvents = [...new Set(files.flatMap(eventsInSettings))];
  const missingRequired = REQUIRED_EVENTS.filter((e) => !installedEvents.includes(e));
  return { settingsFound, installedEvents, missingRequired };
}

const isCli = (a: DiscoveredSession): boolean => a.source === "cli" || (a.surfaces?.includes("cli") ?? false);

/**
 * Combine the (cached) settings check with the live write-freshness + fallback counts
 * into a single verdict. Conservative on purpose — it only cries "degraded" when the
 * settings are actually incomplete, or hooks are installed yet demonstrably silent while
 * CLI sessions are active. A lone desktop/just-started session on the inferred path is
 * reported as context, not an alarm.
 */
export function assembleHealth(
  s: HookSettings,
  aircraft: DiscoveredSession[],
  writes: { fresh: number; lastAt: number | null },
  now = Date.now(),
): HooksHealth {
  const active = aircraft.filter((a) => a.state === "working" || a.state === "needs-input");
  const activeCli = active.filter(isCli).length;
  const onFallback = active.filter((a) => a.stateSource === "inferred").length;

  let status: HooksHealth["status"];
  let detail: string;
  if (!s.settingsFound || s.installedEvents.length === 0) {
    status = "down";
    detail = "Session-tracking hooks aren't installed — states fall back to transcript inference (~8s lag, exits can stick). Run `pnpm run doctor` to install.";
  } else if (s.missingRequired.length > 0) {
    status = "degraded";
    detail = `Session-tracking hooks partially installed — missing ${s.missingRequired.join(", ")}. Run \`pnpm run doctor\` to repair.`;
  } else if (activeCli > 0 && writes.fresh === 0) {
    status = "degraded";
    detail = "Session-tracking hooks are installed but not firing — no recent state writes from any active session.";
  } else {
    status = "healthy";
    detail =
      onFallback > 0
        ? `Hooks healthy · ${onFallback} active session(s) on the inferred fallback (restart them for the live path).`
        : "Hooks healthy.";
  }

  return {
    status,
    settingsFound: s.settingsFound,
    installedEvents: s.installedEvents,
    missingRequired: s.missingRequired,
    freshWrites: writes.fresh,
    lastWriteAt: writes.lastAt,
    activeSessions: active.length,
    activeCli,
    onFallback,
    detail,
    checkedAt: now,
  };
}
