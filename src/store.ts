import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ActivityState, CostSummary, CostTokens, DiscoveredSession, SessionSource } from "./types.js";

interface SessionRow {
  id: string;
  source: string;
  surfaces: string;
  path: string | null;
  project: string | null;
  branch: string | null;
  title: string | null;
  model: string | null;
  first_seen_at: number | null;
  last_activity_at: number | null;
  state: string;
  last_event_summary: string | null;
  linked_cli_session_id: string | null;
  updated_at: number;
}

function rowToSession(r: SessionRow): DiscoveredSession {
  return {
    id: r.id,
    source: r.source as SessionSource,
    path: r.path ?? "",
    project: r.project,
    branch: r.branch,
    title: r.title,
    model: r.model,
    firstSeenAt: r.first_seen_at,
    lastActivityAt: r.last_activity_at,
    state: r.state as ActivityState,
    lastEventSummary: r.last_event_summary ?? "",
    linkedCliSessionId: r.linked_cli_session_id,
    surfaces: JSON.parse(r.surfaces) as SessionSource[],
  };
}

/**
 * SQLite persistence (decision §9, better-sqlite3). Phase 2 persists the discovered
 * sessions; the `aircraft` table (user-owned cards) and assignments arrive in Phase 4.
 * The store mirrors the live set: sessions absent from an update are pruned, but
 * `first_seen_at` is preserved across updates.
 */
export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    // let a live app and a dev instance share one DB: WAL gives concurrent readers + one
    // writer, and busy_timeout makes a blocked writer wait for the lock instead of throwing
    // SQLITE_BUSY (both tick ~every 2s, so waits are milliseconds).
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    // The cost ledger changed shape (keyed by transcript path, not session id). It is a
    // derived cache — a full rebuild from the transcripts takes seconds — so an old-shaped
    // table is dropped here, BEFORE the creates below, and refilled by the next scan.
    this.dropIfKeyedById("session_cost");
    this.dropIfKeyedById("session_cost_day");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                    TEXT PRIMARY KEY,
        source                TEXT NOT NULL,
        surfaces              TEXT NOT NULL,
        path                  TEXT,
        project               TEXT,
        branch                TEXT,
        title                 TEXT,
        model                 TEXT,
        first_seen_at         INTEGER,
        last_activity_at      INTEGER,
        state                 TEXT NOT NULL,
        last_event_summary    TEXT,
        linked_cli_session_id TEXT,
        updated_at            INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notes (
        id         TEXT PRIMARY KEY,
        note       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS landed (
        id        TEXT PRIMARY KEY,
        landed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_config (
        repo_key         TEXT PRIMARY KEY,
        repo_name        TEXT,
        dev_url_template TEXT,
        dev_command      TEXT,
        install_command  TEXT,
        env_vars         TEXT,
        updated_at       INTEGER NOT NULL
      );
      /* Lifetime cost ledger, one row PER TRANSCRIPT FILE. Keyed by path, not by session
         id: Claude Code writes subagent transcripts to <project>/<id>/subagents/agent-*.jsonl
         and stamps them with the PARENT's session id, so one session is many files. Keying
         by id would let those files overwrite one another (and lose the subagents' very
         real cost). Per-session figures are summed at read time via the id index.

         Unlike the sessions table -- which mirrors the live board and is pruned -- this is
         append-and-update only, so spend survives a session ageing off the board. file_size
         lets the backfill skip a transcript it has already priced. */
      CREATE TABLE IF NOT EXISTS session_cost (
        path              TEXT PRIMARY KEY,
        id                TEXT NOT NULL,
        cost_usd          REAL NOT NULL,
        input_tokens      INTEGER NOT NULL DEFAULT 0,
        output_tokens     INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        model             TEXT,
        unpriced          INTEGER NOT NULL DEFAULT 0,
        last_activity_at  INTEGER,
        file_size         INTEGER,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_cost_id ON session_cost(id);
      /* Cost attributed to the LOCAL day each turn happened on. Sessions routinely span
         midnight, so a per-session total cannot answer "what did today cost" -- it would
         credit a whole multi-day session to whichever day it was last active on. */
      CREATE TABLE IF NOT EXISTS session_cost_day (
        path       TEXT NOT NULL,
        day        TEXT NOT NULL,
        cost_usd   REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (path, day)
      );
      CREATE INDEX IF NOT EXISTS session_cost_day_day ON session_cost_day(day);
      CREATE TABLE IF NOT EXISTS dev_servers (
        root       TEXT PRIMARY KEY,
        pid        INTEGER NOT NULL,
        command    TEXT NOT NULL,
        log_file   TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
    `);
    // additive migrations for DBs created before these columns existed
    this.addColumn("project_config", "dev_command", "TEXT");
    this.addColumn("project_config", "install_command", "TEXT");
    this.addColumn("project_config", "env_vars", "TEXT");
    // host of the session's terminal/IDE, remembered while it was alive (see src/open.ts)
    this.addColumn("sessions", "host_kind", "TEXT");
    this.addColumn("sessions", "host_bin", "TEXT");
  }

  /** drop a cost table still carrying the old id-keyed primary key (see migrate) */
  private dropIfKeyedById(table: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
    if (cols.some((c) => c.name === "id" && c.pk > 0)) this.db.exec(`DROP TABLE ${table}`);
  }

  /** add a column if it isn't already present (SQLite has no IF NOT EXISTS for columns) */
  private addColumn(table: string, col: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }

  /** per-repo config, keyed by the shared git dir (so it's set once for all worktrees) */
  getProjectConfigs(): Record<string, { name: string | null; urlTemplate: string; command: string; install: string; env: string }> {
    const rows = this.db
      .prepare(`SELECT repo_key, repo_name, dev_url_template, dev_command, install_command, env_vars FROM project_config`)
      .all() as {
      repo_key: string;
      repo_name: string | null;
      dev_url_template: string | null;
      dev_command: string | null;
      install_command: string | null;
      env_vars: string | null;
    }[];
    return Object.fromEntries(
      rows.map((r) => [
        r.repo_key,
        {
          name: r.repo_name,
          urlTemplate: r.dev_url_template ?? "",
          command: r.dev_command ?? "",
          install: r.install_command ?? "",
          env: r.env_vars ?? "",
        },
      ]),
    );
  }

  setProjectConfig(key: string, name: string | null, urlTemplate: string, command: string, install: string, env: string): void {
    this.db
      .prepare(
        `INSERT INTO project_config (repo_key, repo_name, dev_url_template, dev_command, install_command, env_vars, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_key) DO UPDATE SET repo_name = excluded.repo_name, dev_url_template = excluded.dev_url_template,
           dev_command = excluded.dev_command, install_command = excluded.install_command, env_vars = excluded.env_vars,
           updated_at = excluded.updated_at`,
      )
      .run(key, name, urlTemplate, command, install, env, Date.now());
  }

  deleteProjectConfig(key: string): void {
    this.db.prepare(`DELETE FROM project_config WHERE repo_key = ?`).run(key);
  }

  /** tower-managed dev servers, persisted so they can be re-adopted across a restart */
  getDevServers(): { root: string; pid: number; command: string; logFile: string; startedAt: number }[] {
    const rows = this.db.prepare(`SELECT root, pid, command, log_file, started_at FROM dev_servers`).all() as {
      root: string;
      pid: number;
      command: string;
      log_file: string;
      started_at: number;
    }[];
    return rows.map((r) => ({ root: r.root, pid: r.pid, command: r.command, logFile: r.log_file, startedAt: r.started_at }));
  }

  setDevServer(s: { root: string; pid: number; command: string; logFile: string; startedAt: number }): void {
    this.db
      .prepare(
        `INSERT INTO dev_servers (root, pid, command, log_file, started_at) VALUES (@root, @pid, @command, @logFile, @startedAt)
         ON CONFLICT(root) DO UPDATE SET pid = excluded.pid, command = excluded.command, log_file = excluded.log_file, started_at = excluded.started_at`,
      )
      .run(s);
  }

  deleteDevServer(root: string): void {
    this.db.prepare(`DELETE FROM dev_servers WHERE root = ?`).run(root);
  }

  /** ids the user has marked landed (kept, not pruned with sessions) */
  getLanded(): string[] {
    return (this.db.prepare(`SELECT id FROM landed`).all() as { id: string }[]).map((r) => r.id);
  }

  setLanded(id: string): void {
    this.db.prepare(`INSERT INTO landed (id, landed_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`).run(id, Date.now());
  }

  unsetLanded(id: string): void {
    this.db.prepare(`DELETE FROM landed WHERE id = ?`).run(id);
  }

  /** the host we last saw a session running in, or null if we never resolved one */
  getHost(id: string): { kind: string; bin: string | null } | null {
    const row = this.db.prepare(`SELECT host_kind, host_bin FROM sessions WHERE id = ?`).get(id) as
      | { host_kind: string | null; host_bin: string | null }
      | undefined;
    if (!row?.host_kind) return null;
    return { kind: row.host_kind, bin: row.host_bin };
  }

  /** record the host of a live session, so a later click still lands in the right app */
  setHost(id: string, kind: string, bin: string | null): void {
    this.db.prepare(`UPDATE sessions SET host_kind = ?, host_bin = ? WHERE id = ?`).run(kind, bin, id);
    this.sessionsCache = null;
  }

  /** all notes as { aircraftId: note } — notes outlive sessions (kept, not pruned) */
  getNotes(): Record<string, string> {
    const rows = this.db.prepare(`SELECT id, note FROM notes`).all() as { id: string; note: string }[];
    return Object.fromEntries(rows.map((r) => [r.id, r.note]));
  }

  setNote(id: string, note: string): void {
    this.db
      .prepare(
        `INSERT INTO notes (id, note, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run(id, note, Date.now());
  }

  deleteNote(id: string): void {
    this.db.prepare(`DELETE FROM notes WHERE id = ?`).run(id);
  }

  /** upsert the current live set. Sessions are NEVER pruned — once tracked, a session
   *  persists (so it survives restarts / vanished files and can still be shown). */
  syncSessions(list: DiscoveredSession[]): void {
    const now = Date.now();
    const upsert = this.db.prepare(`
      INSERT INTO sessions (id, source, surfaces, path, project, branch, title, model,
        first_seen_at, last_activity_at, state, last_event_summary, linked_cli_session_id, updated_at)
      VALUES (@id, @source, @surfaces, @path, @project, @branch, @title, @model,
        @first_seen_at, @last_activity_at, @state, @last_event_summary, @linked_cli_session_id, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        source                = excluded.source,
        surfaces              = excluded.surfaces,
        path                  = excluded.path,
        project               = excluded.project,
        branch                = excluded.branch,
        title                 = excluded.title,
        model                 = excluded.model,
        first_seen_at         = COALESCE(sessions.first_seen_at, excluded.first_seen_at),
        last_activity_at      = excluded.last_activity_at,
        state                 = excluded.state,
        last_event_summary    = excluded.last_event_summary,
        linked_cli_session_id = excluded.linked_cli_session_id,
        updated_at            = excluded.updated_at
    `);

    const tx = this.db.transaction((rows: DiscoveredSession[]) => {
      for (const s of rows) {
        upsert.run({
          id: s.id,
          source: s.source,
          surfaces: JSON.stringify(s.surfaces ?? [s.source]),
          path: s.path,
          project: s.project,
          branch: s.branch,
          title: s.title,
          model: s.model,
          first_seen_at: s.firstSeenAt,
          last_activity_at: s.lastActivityAt,
          state: s.state,
          last_event_summary: s.lastEventSummary,
          linked_cli_session_id: s.linkedCliSessionId,
          updated_at: now,
        });
      }
    });
    tx(list);
    this.sessionsCache = null;
  }

  /** Cache of the mapped session rows. The 1 Hz badge poll (and several calls per engine
   *  tick: update handler + health + summary + badge) all read this; without the cache each
   *  re-ran `SELECT *` + a JSON.parse per row. Invalidated by every writer to the sessions
   *  table (syncSessions / setHost / reassign). Callers must treat the result as read-only. */
  private sessionsCache: DiscoveredSession[] | null = null;
  getSessions(): DiscoveredSession[] {
    if (this.sessionsCache) return this.sessionsCache;
    const rows = this.db.prepare(`SELECT * FROM sessions`).all() as SessionRow[];
    return (this.sessionsCache = rows.map(rowToSession));
  }

  /**
   * Fold a superseded predecessor onto its continuation (a `/compact` chain). Moves the
   * note + landed flag to the successor if it doesn't already have them, then retires the
   * predecessor's note, landed, and persisted session row (so it can't resurface as an
   * offline strip). Idempotent — a no-op once the predecessor is gone. Returns true iff
   * anything changed, so the caller can refresh its cached maps.
   */
  reassign(fromId: string, toId: string): boolean {
    if (!fromId || fromId === toId) return false;
    const tx = this.db.transaction((): boolean => {
      let changed = false;

      const fromNote = this.db.prepare(`SELECT note FROM notes WHERE id = ?`).get(fromId) as { note: string } | undefined;
      if (fromNote) {
        const hasTo = this.db.prepare(`SELECT 1 FROM notes WHERE id = ?`).get(toId);
        if (!hasTo) this.db.prepare(`INSERT INTO notes (id, note, updated_at) VALUES (?, ?, ?)`).run(toId, fromNote.note, Date.now());
        this.db.prepare(`DELETE FROM notes WHERE id = ?`).run(fromId);
        changed = true;
      }

      const fromLanded = this.db.prepare(`SELECT landed_at FROM landed WHERE id = ?`).get(fromId) as { landed_at: number } | undefined;
      if (fromLanded) {
        this.db.prepare(`INSERT INTO landed (id, landed_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`).run(toId, fromLanded.landed_at);
        this.db.prepare(`DELETE FROM landed WHERE id = ?`).run(fromId);
        changed = true;
      }

      if (this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(fromId).changes > 0) changed = true;
      return changed;
    });
    const changed = tx();
    if (changed) this.sessionsCache = null;
    return changed;
  }

  /**
   * Record (or replace) what each session has cost so far. Called with the live sessions'
   * running totals on every engine update, and with whole batches by the backfill scan —
   * both are full replacements per id, never increments, so a re-record is idempotent.
   */
  recordCost(
    rows: {
      id: string;
      /** the transcript file — the ledger's key, so subagent files sit beside their parent */
      path: string;
      costUsd: number;
      tokens: CostTokens;
      model: string | null;
      unpriced: boolean;
      lastActivityAt: number | null;
      /** cost per local calendar day (YYYY-MM-DD), cumulative for the session so far */
      byDay: Record<string, number>;
      fileSize: number | null;
    }[],
  ): void {
    if (!rows.length) return;
    const now = Date.now();
    const up = this.db.prepare(`
      INSERT INTO session_cost (path, id, cost_usd, input_tokens, output_tokens, cache_read_tokens,
                                cache_write_tokens, model, unpriced, last_activity_at, file_size, updated_at)
      VALUES (@path, @id, @cost, @in, @out, @cr, @cw, @model, @unpriced, @last, @size, @now)
      ON CONFLICT(path) DO UPDATE SET
        id = excluded.id, cost_usd = excluded.cost_usd,
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
        model = excluded.model, unpriced = excluded.unpriced,
        last_activity_at = excluded.last_activity_at,
        /* the live engine records a running cost without a size; keep the last scanned
           one so the backfill can still skip an unchanged transcript */
        file_size = COALESCE(excluded.file_size, session_cost.file_size),
        updated_at = excluded.updated_at
    `);
    const upDay = this.db.prepare(`
      INSERT INTO session_cost_day (path, day, cost_usd, updated_at)
      VALUES (@path, @day, @cost, @now)
      ON CONFLICT(path, day) DO UPDATE SET cost_usd = excluded.cost_usd, updated_at = excluded.updated_at
    `);
    // A re-record carries the session's cumulative per-day totals, so replacing each day's
    // row is correct. Days the session no longer reports are dropped: a re-parse from
    // scratch is authoritative about which days it actually spans.
    const clearDays = this.db.prepare(`DELETE FROM session_cost_day WHERE path = ?`);
    this.db.transaction(() => {
      for (const r of rows) {
        const days = Object.entries(r.byDay);
        if (days.length) {
          clearDays.run(r.path);
          for (const [day, cost] of days) upDay.run({ path: r.path, day, cost, now });
        }
        up.run({
          id: r.id,
          path: r.path,
          cost: r.costUsd,
          in: r.tokens.input,
          out: r.tokens.output,
          cr: r.tokens.cacheRead,
          cw: r.tokens.cacheWrite,
          model: r.model,
          unpriced: r.unpriced ? 1 : 0,
          last: r.lastActivityAt,
          size: r.fileSize,
          now,
        });
      }
    })();
  }

  /**
   * Spend on one local calendar day and across the month containing it, plus how many
   * sessions ran on an unpriced model. `day` is YYYY-MM-DD in local time.
   *
   * Both figures come from the per-day table, never from whole sessions, so a session
   * spanning midnight (or a month boundary) contributes only the turns it actually made
   * in the period. There is deliberately no lifetime total: it is bounded by which
   * transcripts Claude Code has not yet cleaned up, which makes it a number without a
   * meaning anyone can state.
   */
  costSummary(day: string): Omit<CostSummary, "scanned"> {
    const unpriced = this.db
      .prepare(`SELECT COUNT(DISTINCT id) AS n FROM session_cost WHERE unpriced = 1`)
      .get() as { n: number };
    const sums = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN day = @day THEN cost_usd END), 0) AS today,
                COALESCE(SUM(CASE WHEN day LIKE @month THEN cost_usd END), 0) AS month
         FROM session_cost_day`,
      )
      .get({ day, month: day.slice(0, 7) + "%" }) as { today: number; month: number };
    return { today: sums.today, month: sums.month, unpricedSessions: unpriced.n };
  }

  /**
   * Transcript path → the file size we last priced it at, so the backfill can skip it.
   *
   * Only rows that already carry a per-day breakdown are reported. A row priced before
   * per-day attribution existed (or one whose day rows were lost) would otherwise be
   * skipped forever on size alone, leaving today's figure permanently short — withholding
   * its size makes the next scan re-read it, so the ledger heals itself with no migration.
   */
  scannedSizes(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT c.path AS path, c.file_size AS file_size
         FROM session_cost c
         WHERE c.path IS NOT NULL AND c.file_size IS NOT NULL
           AND EXISTS (SELECT 1 FROM session_cost_day d WHERE d.path = c.path)`,
      )
      .all() as { path: string; file_size: number }[];
    return new Map(rows.map((r) => [r.path, r.file_size]));
  }

  /** per-session cost, for decorating the board */
  costById(): Map<string, { costUsd: number; tokens: CostTokens; unpriced: boolean }> {
    const rows = this.db
      .prepare(
        `SELECT id,
                SUM(cost_usd)           AS cost_usd,
                SUM(input_tokens)       AS input_tokens,
                SUM(output_tokens)      AS output_tokens,
                SUM(cache_read_tokens)  AS cache_read_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                MAX(unpriced)           AS unpriced
         FROM session_cost GROUP BY id`,
      )
      .all() as {
      id: string;
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      unpriced: number;
    }[];
    return new Map(
      rows.map((r) => [
        r.id,
        {
          costUsd: r.cost_usd,
          tokens: {
            input: r.input_tokens,
            output: r.output_tokens,
            cacheRead: r.cache_read_tokens,
            cacheWrite: r.cache_write_tokens,
          },
          unpriced: r.unpriced === 1,
        },
      ]),
    );
  }

  close(): void {
    this.db.close();
  }
}
