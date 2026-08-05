import { CONFIG } from "./config.js";
import type { AnthropicStatus } from "./types.js";

/** raw shape of the Statuspage v2 summary.json (only the bits we use) */
interface RawSummary {
  page?: { updated_at?: string; url?: string };
  status?: { indicator?: string; description?: string };
  components?: { name: string; status: string; group?: boolean }[];
  incidents?: { name: string; impact: string; status: string; shortlink?: string }[];
}

function map(raw: RawSummary): AnthropicStatus {
  const pageUrl = raw.page?.url ?? CONFIG.statusPageUrl;
  const components = (raw.components ?? [])
    .filter((c) => !c.group && c.status && c.status !== "operational")
    .map((c) => ({ name: c.name, status: c.status }));
  const incidents = (raw.incidents ?? []).map((i) => ({
    name: i.name,
    impact: i.impact,
    status: i.status,
    url: i.shortlink ?? pageUrl,
  }));
  return {
    indicator: raw.status?.indicator ?? "none",
    description: raw.status?.description ?? "",
    components,
    incidents,
    url: pageUrl,
    updatedAt: raw.page?.updated_at ?? new Date().toISOString(),
    fetchedAt: Date.now(),
  };
}

/**
 * Poll the public Claude Statuspage and hand each fresh snapshot to `onUpdate`.
 * Network errors are swallowed (the banner just keeps the last good value); returns a
 * stop function.
 */
export function startStatusPolling(onUpdate: (s: AnthropicStatus) => void): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      const res = await fetch(CONFIG.statusSummaryUrl, { signal: ctrl.signal, redirect: "follow" });
      clearTimeout(timer);
      if (res.ok) onUpdate(map((await res.json()) as RawSummary));
    } catch {
      /* transient — ignore, try again next tick */
    }
  };
  void tick();
  const iv = setInterval(() => void tick(), CONFIG.statusPollMs);
  return () => {
    stopped = true;
    clearInterval(iv);
  };
}
