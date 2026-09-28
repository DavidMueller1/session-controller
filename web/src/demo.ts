import type { Aircraft, CostSummary, DevServerInfo, PrInfo } from "./types";

// `?demo` swaps the live backend for made-up sessions, for screenshots in public docs.
// Nothing real is read or written: board data, notes/landings and every /api call stay in
// memory. `?demo=tour` additionally loops a scripted sequence of lane changes (for a GIF).
const params = new URLSearchParams(location.search);
export const isDemo = params.has("demo");
export const isDemoTour = params.get("demo") === "tour";

const MIN = 60_000;

function pr(repo: string, number: number, state: PrInfo["state"], title: string, extra: Partial<PrInfo> = {}): PrInfo {
  return { number, state, isDraft: false, reviewDecision: null, url: `https://github.com/example/${repo}/pull/${number}`, title, ...extra };
}

function dev(repo: string, port: number): DevServerInfo {
  return {
    port,
    pid: 40000 + port,
    candidates: [{ port, pid: 40000 + port, addr: "127.0.0.1", proc: "node", role: "app", label: "app" }],
    managed: false,
    repoKey: repo,
    repoName: repo,
    urlTemplate: null,
  };
}

type Seed = Partial<Aircraft> & Pick<Aircraft, "id" | "title" | "branch" | "state" | "lastEventSummary"> & { repo: string; ageMin: number };

function build(seed: Seed, t0: number): Aircraft {
  const { repo, ageMin, ...rest } = seed;
  const since = t0 - ageMin * MIN;
  const ctx = rest.contextPct ?? 0.2;
  return {
    source: "cli",
    path: `/Users/you/.claude/projects/-Users-you-code-${repo}/${seed.id}.jsonl`,
    project: `/Users/you/code/${repo}`,
    model: "claude-opus-5",
    firstSeenAt: since - 25 * MIN,
    lastActivityAt: since,
    stateSource: "hook",
    stateSince: since,
    linkedCliSessionId: null,
    note: null,
    landed: false,
    contextTokens: Math.round(ctx * 1_000_000),
    contextPct: ctx,
    costTokens: { input: 18_400, output: 96_000, cacheRead: 4_800_000, cacheWrite: 310_000 },
    devCommand: "pnpm dev",
    ...rest,
  };
}

const SEEDS: Seed[] = [
  // in-flight
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b01", repo: "orbit-api", title: "Add per-token rate limiting to the public API", branch: "feat/rate-limits", state: "working", lastEventSummary: "Edit src/middleware/rateLimit.ts", ageMin: 4, contextPct: 0.38, costUsd: 4.12, pr: pr("orbit-api", 412, "OPEN", "Per-token rate limiting", { isDraft: true }), devServer: dev("orbit-api", 3000) },
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b02", repo: "checkout-web", title: "Fix rounding in cart totals for mixed currencies", branch: "fix/cart-totals", state: "working", lastEventSummary: "Bash pnpm test --filter cart", ageMin: 11, contextPct: 0.22, costUsd: 1.87, devServer: dev("checkout-web", 5173) },
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b03", repo: "atlas-docs", title: "Write the search indexing guide", branch: "docs/search-guide", state: "working", lastEventSummary: "Read docs/search/overview.md", ageMin: 2, contextPct: 0.11, costUsd: 0.64 },
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b04", repo: "pulse-mobile", title: "Offline sync queue for the mobile app", branch: "feat/offline-sync", state: "working", lastEventSummary: "Grep \"syncQueue\" in src/", ageMin: 27, contextPct: 0.57, costUsd: 6.3, pr: pr("pulse-mobile", 88, "OPEN", "Offline sync queue") },
  // holding — waiting on you
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b05", repo: "billing-service", title: "Generate invoice PDFs with line-item tax", branch: "feat/invoice-pdf", state: "needs-input", lastEventSummary: "Asked: should credit notes reuse the invoice template?", ageMin: 6, contextPct: 0.44, costUsd: 3.05, pr: pr("billing-service", 231, "OPEN", "Invoice PDFs", { reviewDecision: "APPROVED" }) },
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b06", repo: "design-tokens", title: "Migrate color tokens to OKLCH", branch: "chore/oklch-scale", state: "needs-input", lastEventSummary: "Asked: keep the legacy hex aliases for one release?", ageMin: 14, contextPct: 0.19, costUsd: 0.92 },
  // parked — triaged with a note
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b07", repo: "search-indexer", title: "Batch writes to cut indexing time", branch: "perf/batch-writes", state: "needs-input", note: "Waiting on the DB migration review", lastEventSummary: "Asked: run the backfill during the maintenance window?", ageMin: 52, contextPct: 0.31, costUsd: 2.4, pr: pr("search-indexer", 57, "OPEN", "Batch index writes") },
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b08", repo: "checkout-web", title: "Apple Pay on the checkout page", branch: "feat/apple-pay", state: "needs-input", note: "Ask Sam for the merchant ID", lastEventSummary: "Needs the merchant identifier to continue", ageMin: 95, contextPct: 0.27, costUsd: 1.58 },
  // landed
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b09", repo: "orbit-api", title: "Retry upstream timeouts with backoff", branch: "fix/timeout-retries", state: "suspected-done", landed: true, lastEventSummary: "All tests pass — PR merged", ageMin: 180, contextPct: 0.29, costUsd: 2.11, pr: pr("orbit-api", 405, "MERGED", "Retry upstream timeouts"), approach: true },
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b10", repo: "atlas-docs", title: "Publish the 2026 changelog page", branch: "docs/changelog-2026", state: "suspected-done", landed: true, lastEventSummary: "Page published", ageMin: 320, contextPct: 0.08, costUsd: 0.33, pr: pr("atlas-docs", 129, "MERGED", "2026 changelog") },
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b11", repo: "pulse-mobile", title: "Fix the unread badge on push notifications", branch: "fix/push-badge", state: "suspected-done", landed: true, lastEventSummary: "Badge count verified on iOS and Android", ageMin: 610, contextPct: 0.16, costUsd: 0.97 },
  // MIA — quiet
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b12", repo: "notes-app", title: "Spike: CRDT-based collaborative editing", branch: "spike/crdt", state: "idle", lastEventSummary: "Read src/editor/doc.ts", ageMin: 8, contextPct: 0.35, costUsd: 1.21 },
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b13", repo: "legacy-portal", title: "Upgrade the portal to Node 22", branch: "chore/node-22", state: "dormant", lastEventSummary: "Updated .nvmrc and CI images", ageMin: 1900, contextPct: 0.12, costUsd: 0.55 },
  { id: "8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b14", repo: "analytics-etl", title: "Daily rollup job for event counts", branch: "feat/daily-rollup", state: "suspected-done", lastEventSummary: "Rollup job scheduled at 02:00", ageMin: 140, contextPct: 0.21, costUsd: 1.44 },
];

export const demoCost: CostSummary = { today: 38.42, month: 612.75, unpricedSessions: 0, scanned: true };

/** the in-memory demo board: seeded sessions plus the note/land edits made while clicking around */
export function createDemo() {
  const t0 = Date.now();
  const byId = new Map(SEEDS.map((s) => [s.id, build(s, t0)] as const));
  const patch = (id: string, p: Partial<Aircraft>) => {
    const a = byId.get(id);
    if (a) byId.set(id, { ...a, ...p, stateSince: p.state && p.state !== a.state ? Date.now() : a.stateSince });
  };

  // a loop of lane changes that ends where it started, so a recording repeats seamlessly
  const tour: (() => void)[] = [
    () => patch("8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b03", { state: "needs-input", lastEventSummary: "Asked: document the legacy query syntax too?" }),
    () => patch("8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b06", { state: "working", lastEventSummary: "Edit tokens/color.json" }),
    () => patch("8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b05", { note: "Check with finance first" }),
    () => patch("8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b05", { note: null }),
    () => patch("8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b06", { state: "needs-input", lastEventSummary: "Asked: keep the legacy hex aliases for one release?" }),
    () => patch("8c2e41d0-5b7a-4e0f-9a31-2d6f0c1e7b03", { state: "working", lastEventSummary: "Read docs/search/overview.md" }),
  ];
  let step = 0;

  return {
    list: () => [...byId.values()],
    setNote: (id: string, note: string) => patch(id, { note }),
    removeNote: (id: string) => patch(id, { note: null }),
    land: (id: string) => patch(id, { landed: true }),
    unland: (id: string) => patch(id, { landed: false }),
    tourStep: () => { tour[step % tour.length](); step++; },
  };
}

const DEMO_REPOS = {
  global: { urlTemplate: "", command: "", install: "", env: "" },
  repos: ["orbit-api", "checkout-web", "billing-service", "pulse-mobile"].map((name) => ({ key: name, name, urlTemplate: "", command: "pnpm dev", install: "pnpm install", env: "" })),
};

/** answer every /api call locally (except the public changelog) and make EventSource inert */
export function installDemoNetwork(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (path.startsWith("/api/changelog")) return realFetch(input, init);
    if (!path.startsWith("/api/")) return realFetch(input, init);
    let body: unknown = { ok: true };
    if (path.startsWith("/api/repos")) body = DEMO_REPOS;
    else if (path.startsWith("/api/app/state")) body = { overlayShown: false };
    else if (path.startsWith("/api/check")) body = { available: false };
    else if (path.includes("/dev/logs")) body = { log: "> pnpm dev\n\n  VITE ready in 412 ms\n\n  ➜  Local:   http://localhost:5173/" };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  window.EventSource = class {
    onmessage = null;
    onerror = null;
    close() {}
    addEventListener() {}
  } as unknown as typeof EventSource;
}
