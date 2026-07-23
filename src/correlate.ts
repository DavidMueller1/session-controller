import path from "node:path";
import type { DiscoveredSession } from "./types.js";

function newest(group: DiscoveredSession[]): DiscoveredSession {
  return [...group].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
}

/**
 * Collapse a session's transcripts (its main `<id>.jsonl` plus any `agent-*.jsonl`
 * subagent sidechains, which share the same internal sessionId) into one aircraft.
 * Identity (title/branch/project) comes from the MAIN transcript; liveness
 * (state/summary/lastActivity) from whichever file is most recent — so a churning
 * subagent still reads as the flight working, but the row keeps its real title.
 */
function collapseCli(group: DiscoveredSession[]): DiscoveredSession {
  const main = group.find((s) => path.basename(s.path) === `${s.id}.jsonl`) ?? newest(group);
  const live = newest(group);
  return {
    ...main,
    lastActivityAt: Math.max(...group.map((s) => s.lastActivityAt ?? 0)) || null,
    state: live.state,
    lastEventSummary: live.lastEventSummary,
  };
}

/**
 * Merge a desktop session into its underlying CLI transcript (§2b). The CLI transcript
 * is the richer record — it has the live event stream — so it's the base. We enrich it
 * with the desktop title/model and, importantly, let the desktop's `suspected-done`
 * (archived) signal surface when the CLI side is only stale, not actively running.
 */
function merge(cli: DiscoveredSession, desktop: DiscoveredSession): DiscoveredSession {
  const lastActivityAt = Math.max(cli.lastActivityAt ?? 0, desktop.lastActivityAt ?? 0) || null;

  // Trust the CLI transcript for state — it's the only source that can tell
  // "waiting on you" (needs-input) from "working". The desktop metadata is time-only
  // and would collapse a waiting session into a false MIA. We use the desktop side
  // only for (a) rescuing a lagging CLI transcript and (b) the archived signal.
  let state = cli.state;
  let lastEventSummary = cli.lastEventSummary;

  // CLI transcripts for desktop-run sessions can lag; a fresher desktop "working"
  // heartbeat means it's genuinely active even if the CLI tail looks stale.
  const desktopFresher = (desktop.lastActivityAt ?? 0) > (cli.lastActivityAt ?? 0);
  if (desktopFresher && desktop.state === "working" && (state === "idle" || state === "dormant" || state === "unknown")) {
    state = "working";
    lastEventSummary = cli.lastEventSummary || "active";
  }

  // archived is a real "done" signal — surface it unless the CLI shows clear activity
  if (desktop.state === "suspected-done" && state !== "working" && state !== "needs-input") {
    state = "suspected-done";
    lastEventSummary = desktop.lastEventSummary;
  }

  return {
    ...cli,
    surfaces: ["cli", "desktop"],
    title: desktop.title ?? cli.title,
    model: cli.model ?? desktop.model,
    project: cli.project ?? desktop.project,
    lastActivityAt,
    state,
    lastEventSummary,
    linkedCliSessionId: desktop.linkedCliSessionId,
  };
}

/**
 * Collapse duplicates into one aircraft each:
 *  - a desktop session linked (via cliSessionId) to a CLI transcript → merged
 *  - the same CLI session id appearing in multiple files → newest wins
 *  - standalone desktop sessions (e.g. Cowork /outputs runs) → kept as-is
 */
export function correlate(all: DiscoveredSession[]): DiscoveredSession[] {
  const cliById = new Map<string, DiscoveredSession[]>();
  for (const s of all) {
    if (s.source !== "cli") continue;
    const list = cliById.get(s.id) ?? [];
    list.push(s);
    cliById.set(s.id, list);
  }

  const out: DiscoveredSession[] = [];
  const consumedCliIds = new Set<string>();

  for (const s of all) {
    if (s.source !== "desktop") continue;
    const link = s.linkedCliSessionId;
    if (link && cliById.has(link)) {
      out.push(merge(collapseCli(cliById.get(link)!), s));
      consumedCliIds.add(link);
    } else {
      out.push({ ...s, surfaces: ["desktop"] });
    }
  }

  for (const [id, group] of cliById) {
    if (consumedCliIds.has(id)) continue;
    out.push({ ...collapseCli(group), surfaces: ["cli"] });
  }

  return out;
}
