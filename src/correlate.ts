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

  // Trust the CLI transcript ALONE for state — it's the only source that grows on real
  // turns. The desktop metadata's `lastActivityAt` also bumps when you merely focus/open
  // the session, which used to "rescue" a stale session into a false `working` (making it
  // flash into In-flight on a click). So we no longer derive state from desktop activity;
  // we only borrow the `archived` = done signal.
  let state = cli.state;
  let lastEventSummary = cli.lastEventSummary;

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

  return supersedeContinuations(out);
}

/**
 * A session that `/compact`ed opens a brand-new transcript (new session id) that continues
 * the exhausted one — so the old and new both show up as aircraft. Fold each such chain into
 * a single flight: the live continuation survives, its predecessor(s) are dropped, and the
 * survivor carries `supersedes` (the retired ids, so the server can move their note/landed
 * across). Only links where BOTH ends are present are collapsed; a continuation whose parent
 * has aged out of the set stands on its own.
 */
function supersedeContinuations(out: DiscoveredSession[]): DiscoveredSession[] {
  const byId = new Map(out.map((s) => [s.id, s]));
  // child → parent, restricted to links whose parent is also present right now
  const parentOf = new Map<string, string>();
  for (const s of out) if (s.continuedFrom && byId.has(s.continuedFrom)) parentOf.set(s.id, s.continuedFrom);
  if (parentOf.size === 0) return out;

  // a title is "real" only if it isn't just the session id (no ai-title / first prompt yet)
  const named = (s: DiscoveredSession): boolean => !!s.title && s.title !== s.id;
  const superseded = new Set(parentOf.values()); // any id that some present child continued from
  return out
    .filter((s) => !superseded.has(s.id))
    .map((s) => {
      // walk the chain of predecessors this survivor transitively continues from
      const chain: string[] = [];
      const guard = new Set<string>();
      for (let p = parentOf.get(s.id); p && !guard.has(p); p = parentOf.get(p)) {
        guard.add(p);
        chain.push(p);
      }
      if (!chain.length) return s;
      // A compaction continues the SAME task, so keep the flight's established identity:
      // inherit the nearest named predecessor's title (its ai-title / first real prompt)
      // rather than the continuation's, whose opening turns are compaction/command noise.
      // A live `/rename` still overrides this later in the engine (callsign wins).
      const inherited = chain.map((id) => byId.get(id)).find((p) => p && named(p))?.title;
      return { ...s, title: inherited ?? s.title, supersedes: chain };
    });
}
