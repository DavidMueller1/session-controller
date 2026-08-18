import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ActivityState, DiscoveredSession, SessionSource } from "./types.js";

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
    this.migrate();
  }

  private migrate(): void {
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
        updated_at       INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dev_servers (
        root       TEXT PRIMARY KEY,
        pid        INTEGER NOT NULL,
        command    TEXT NOT NULL,
        log_file   TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
    `);
    // additive migration for DBs created before dev_command existed
    this.addColumn("project_config", "dev_command", "TEXT");
  }

  /** add a column if it isn't already present (SQLite has no IF NOT EXISTS for columns) */
  private addColumn(table: string, col: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }

  /** per-repo config, keyed by the shared git dir (so it's set once for all worktrees) */
  getProjectConfigs(): Record<string, { name: string | null; urlTemplate: string; command: string }> {
    const rows = this.db.prepare(`SELECT repo_key, repo_name, dev_url_template, dev_command FROM project_config`).all() as {
      repo_key: string;
      repo_name: string | null;
      dev_url_template: string | null;
      dev_command: string | null;
    }[];
    return Object.fromEntries(
      rows.map((r) => [r.repo_key, { name: r.repo_name, urlTemplate: r.dev_url_template ?? "", command: r.dev_command ?? "" }]),
    );
  }

  setProjectConfig(key: string, name: string | null, urlTemplate: string, command: string): void {
    this.db
      .prepare(
        `INSERT INTO project_config (repo_key, repo_name, dev_url_template, dev_command, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo_key) DO UPDATE SET repo_name = excluded.repo_name, dev_url_template = excluded.dev_url_template,
           dev_command = excluded.dev_command, updated_at = excluded.updated_at`,
      )
      .run(key, name, urlTemplate, command, Date.now());
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
  }

  getSessions(): DiscoveredSession[] {
    const rows = this.db.prepare(`SELECT * FROM sessions`).all() as SessionRow[];
    return rows.map(rowToSession);
  }

  close(): void {
    this.db.close();
  }
}
