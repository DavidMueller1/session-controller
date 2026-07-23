import os from "node:os";
import path from "node:path";

const home = os.homedir();

/**
 * Source locations verified on this machine (§2 of CONCEPT.md) and the timing
 * thresholds from the locked decisions (§9). Thresholds are VISUAL ONLY — none of
 * them ever mark a feature landed.
 */
export const CONFIG = {
  /** CLI transcripts: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl */
  cliProjectsDir: path.join(home, ".claude", "projects"),

  /** Claude Desktop (Cowork / local agent mode) session metadata */
  desktopSessionDirs: [
    path.join(home, "Library", "Application Support", "Claude", "local-agent-mode-sessions"),
    path.join(home, "Library", "Application Support", "Claude", "claude-code-sessions"),
  ],

  /** a mid-work session stays "working" until this long of silence, then goes MIA
   *  (still flying, just a soft "lost contact" badge — not a separate lane) */
  miaAfterMs: 5 * 60_000,
  /** assistant turn ended; wait this short grace before calling it needs-input (HOLDING) */
  needsInputGraceMs: 8_000,
  /** no activity for this long => "cold" (dormant). NOT landed. Overnight-safe. */
  dormantMs: 2 * 60 * 60_000,

  /** coalesce filesystem bursts before re-rendering */
  renderDebounceMs: 150,
  /** re-derive time-based state (no disk I/O) this often — the key to snappy transitions */
  fastTickMs: 1_000,
  /** safety-net full re-read of all files, in case a filesystem event was missed */
  reconcileMs: 60_000,

  /** API server (Phase 2) */
  apiPort: Number(process.env.PORT ?? 4317),
  apiHost: process.env.HOST ?? "127.0.0.1",
  /** SQLite database file */
  dbPath: path.join(process.cwd(), "data", "traffic-controller.db"),
};
