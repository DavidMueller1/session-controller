import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** the user's Claude plan as Claude Code reports it (same numbers as `/usage`) */
export interface PlanUsage {
  /** a subscription with plan limits applies — false means usage is billed per token (API key, 3P) */
  hasPlan: boolean;
  /** "pro" | "max" | "team" | "enterprise", or null without a plan */
  subscription: string | null;
  /** share of the weekly limit used, 0–100 */
  weekPct: number | null;
  /** when the weekly window resets (epoch ms), if reported */
  weekResetsAt: number | null;
  /** the server's own rating of the weekly limit ("normal", …) */
  weekSeverity: string | null;
  /** paid extra-usage credits that cover you past the plan limits */
  credits: { enabled: boolean; used: number; limit: number | null; currency: string } | null;
  /** when we asked */
  asOf: number;
}

type Money = { amount_minor?: number; exponent?: number; currency?: string } | null | undefined;
const money = (m: Money): number | null => (m && typeof m.amount_minor === "number" ? m.amount_minor / 10 ** (m.exponent ?? 2) : null);

function parse(body: any): PlanUsage {
  const rl = body?.rate_limits ?? {};
  const subscription = typeof body?.subscription_type === "string" ? body.subscription_type : null;
  const week = rl.seven_day;
  const pct = Number(week?.utilization);
  const reset = typeof week?.resets_at === "string" ? Date.parse(week.resets_at) : NaN;
  const weekly = Array.isArray(rl.limits) ? rl.limits.find((l: any) => l?.kind === "weekly_all") : null;
  const spend = rl.spend;
  const extra = rl.extra_usage;
  const credits =
    spend || extra
      ? {
          enabled: !!(spend?.enabled ?? extra?.is_enabled),
          used: money(spend?.used) ?? 0,
          limit: money(spend?.limit),
          currency: spend?.used?.currency ?? extra?.currency ?? "USD",
        }
      : null;
  return {
    hasPlan: !!subscription && body?.rate_limits_available !== false,
    subscription,
    weekPct: isFinite(pct) && week ? pct : null,
    weekResetsAt: isNaN(reset) ? null : reset,
    weekSeverity: typeof weekly?.severity === "string" ? weekly.severity : null,
    credits,
    asOf: Date.now(),
  };
}

// The menu-bar app runs with a minimal GUI PATH, so look in the usual install spots too.
function findClaude(): string | null {
  const home = os.homedir();
  const dirs = [...(process.env.PATH ?? "").split(":"), path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) {
    const p = path.join(d, "claude");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * Ask Claude Code for the plan's rate limits via its `get_usage` control request (the interface
 * the Agent SDK / IDE integrations use). Claude Code does the login and the network call itself,
 * so we never touch a token. The child makes no model call and, with hooks off and no session
 * persistence, never shows up on the board. null only when the ask failed (no claude, timeout) —
 * "no plan" is a real answer (`hasPlan: false`). `configDir` asks for another login's plan.
 */
export function fetchPlanUsage(configDir?: string, timeoutMs = 20_000): Promise<PlanUsage | null> {
  const bin = findClaude();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--settings", '{"disableAllHooks":true}', "--strict-mcp-config", "--no-session-persistence"],
      { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "ignore"], env: configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env },
    );
    let done = false;
    let buf = "";
    const finish = (v: PlanUsage | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // close stdin so it exits on its own (a kill can leave its session file behind)
      child.stdin.end();
      setTimeout(() => child.exitCode === null && child.kill(), 5_000).unref();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.stdin.on("error", () => {}); // EPIPE if it exits early — `exit` already resolved
    child.on("exit", () => finish(null));
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m?.type !== "control_response" || m.response?.request_id !== "usage") continue;
        // an error reply is a failed ask, not "no plan"
        finish(m.response?.subtype === "success" && m.response.response ? parse(m.response.response) : null);
      }
    });
    const send = (request_id: string, request: object) => child.stdin.write(JSON.stringify({ type: "control_request", request_id, request }) + "\n");
    send("init", { subtype: "initialize" });
    send("usage", { subtype: "get_usage", skip_behaviors: true });
  });
}
