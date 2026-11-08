import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

// Plain SQL migrations, applied in order and tracked with PRAGMA user_version.
const MIGRATIONS: Array<string | ((db: DB) => void)> = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    role          TEXT NOT NULL CHECK (role IN ('admin','juror')),
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,            -- sha256 of the cookie token
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent   TEXT,
    ip           TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE event (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    name              TEXT NOT NULL,
    date              TEXT NOT NULL,
    current_team_id   INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    -- shared pitch timer (see shared/timer.ts)
    timer_visible     INTEGER NOT NULL DEFAULT 0,
    timer_running     INTEGER NOT NULL DEFAULT 0,
    timer_offset_sec  REAL NOT NULL DEFAULT 0,
    timer_anchor_at   INTEGER,
    pitch_sec         INTEGER NOT NULL DEFAULT 180,
    qa_sec            INTEGER NOT NULL DEFAULT 120,
    locked            INTEGER NOT NULL DEFAULT 0,
    show_juror_total  INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE teams (
    id          INTEGER PRIMARY KEY,
    order_index INTEGER NOT NULL,
    name        TEXT NOT NULL,
    project     TEXT NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE criteria (
    id          INTEGER PRIMARY KEY,
    order_index INTEGER NOT NULL,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    weight      INTEGER NOT NULL
  );
  CREATE TABLE scores (
    id          INTEGER PRIMARY KEY,
    juror_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    values_json TEXT NOT NULL,
    total       REAL,
    note        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (juror_id, team_id)
  );
  CREATE TABLE audit_log (
    id           INTEGER PRIMARY KEY,
    actor_id     INTEGER,
    action       TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX audit_created ON audit_log(created_at);
  `,
  // v2: results reveal (admin-paced, survives restarts and deploys)
  `
  ALTER TABLE event ADD COLUMN reveal_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE event ADD COLUMN reveal_step INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE event ADD COLUMN reveal_snapshot TEXT;
  `,
  // v3: points rubric (per-criterion maximum) and pre-Demo-Day entry scores
  `
  ALTER TABLE criteria ADD COLUMN max_score INTEGER NOT NULL DEFAULT 10;
  ALTER TABLE teams ADD COLUMN entry_score REAL;
  ALTER TABLE event ADD COLUMN include_entry INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE event ADD COLUMN entry_max REAL NOT NULL DEFAULT 50;
  UPDATE event SET reveal_enabled = 0, reveal_step = 0, reveal_snapshot = NULL;
  `,
  // v4: QR invites for jurors, quick feedback tags; event.name now holds only the brand prefix
  // ("Ignite" → shown as "Ignite DemoDay").
  `
  CREATE TABLE juror_invites (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,         -- sha256 of the token in the QR link
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER,
    revoked_at  INTEGER
  );
  CREATE INDEX juror_invites_user ON juror_invites(user_id);
  ALTER TABLE scores ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE event ADD COLUMN feedback_tags_json TEXT;
  UPDATE event SET name = trim(substr(name, 1, length(name) - 8)) WHERE lower(name) LIKE '%demo day';
  UPDATE event SET name = trim(substr(name, 1, length(name) - 7)) WHERE lower(name) LIKE '%demoday';
  `,
  // v5: how many top places get a suspense step in the results reveal
  `
  ALTER TABLE event ADD COLUMN reveal_top INTEGER NOT NULL DEFAULT 3;
  `,
  // v6: event type (Hakaton / DemoDay), jurors' final order for the reveal, reveal display options
  `
  ALTER TABLE event ADD COLUMN product TEXT NOT NULL DEFAULT 'Hakaton';
  ALTER TABLE event ADD COLUMN final_order_json TEXT;
  ALTER TABLE event ADD COLUMN reveal_hide_scores INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE event ADD COLUMN reveal_batch INTEGER NOT NULL DEFAULT 1;
  `,
  // v7: permanent scoring history. One row per submit/update, plus markers for wipes and deletions that
  // removed scores. Names and criteria are copied in, so the history survives deleted teams, jurors and criteria.
  db => {
    db.exec(`
    CREATE TABLE score_history (
      id          INTEGER PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('submit','update','wipe','team.delete','juror.delete')),
      juror_id    INTEGER,
      juror_name  TEXT NOT NULL DEFAULT '',
      team_id     INTEGER,
      team_name   TEXT NOT NULL DEFAULT '',
      values_json TEXT NOT NULL DEFAULT '[]',   -- [{key, name, max, v}]
      total       REAL,
      note        TEXT NOT NULL DEFAULT '',
      tags_json   TEXT NOT NULL DEFAULT '[]',
      actor_name  TEXT NOT NULL DEFAULT '',
      count       INTEGER,                      -- scores removed (wipe / delete markers)
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX score_history_pair ON score_history(juror_id, team_id, id);
    CREATE INDEX score_history_team ON score_history(team_id, id);
    `);
    // Backfill from the audit log, which has carried every submit since v1.
    const crit = new Map((db.prepare("SELECT key, name, max_score max FROM criteria").all() as Array<{ key: string; name: string; max: number }>).map(c => [c.key, c]));
    const users = new Map((db.prepare("SELECT id, display_name n FROM users").all() as Array<{ id: number; n: string }>).map(u => [u.id, u.n]));
    const teams = new Map((db.prepare("SELECT id, name n FROM teams").all() as Array<{ id: number; n: string }>).map(t => [t.id, t.n]));
    const ins = db.prepare(`INSERT INTO score_history (kind, juror_id, juror_name, team_id, team_name, values_json, total, note, tags_json, actor_name, count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const rows = db.prepare(`SELECT actor_id, action, payload_json, created_at FROM audit_log
      WHERE action IN ('score.submit','score.update','scores.wipe','team.delete','juror.delete') ORDER BY id`).all() as Array<{ actor_id: number | null; action: string; payload_json: string; created_at: number }>;
    for (const r of rows) {
      let p: any; try { p = JSON.parse(r.payload_json); } catch { continue; }
      const actor = r.actor_id != null ? users.get(r.actor_id) ?? "" : "";
      if (r.action === "scores.wipe") { ins.run("wipe", null, "", null, "", "[]", null, "", "[]", actor, p.deleted ?? null, r.created_at); continue; }
      if (r.action === "team.delete" || r.action === "juror.delete") {
        if (!p.scoresDeleted) continue;
        const isTeam = r.action === "team.delete";
        ins.run(r.action, isTeam ? null : p.id, isTeam ? "" : users.get(p.id) ?? `Münsif #${p.id}`, isTeam ? p.id : null, isTeam ? teams.get(p.id) ?? `Komanda #${p.id}` : "",
          "[]", null, "", "[]", actor, p.scoresDeleted, r.created_at);
        continue;
      }
      const values = Object.entries((p.values ?? {}) as Record<string, number>).map(([key, v]) => {
        const c = crit.get(key);
        return { key, name: c?.name ?? key, max: c?.max ?? null, v };
      });
      ins.run(r.action === "score.submit" ? "submit" : "update", r.actor_id, actor || `Münsif #${r.actor_id}`, p.teamId ?? null,
        teams.get(p.teamId) ?? `Komanda #${p.teamId}`, JSON.stringify(values), p.total ?? null, p.note ?? "", JSON.stringify(p.tags ?? []), actor, null, r.created_at);
    }
  },
  // v8 (munsif): team sign-in links, team materials (presentation / logo / links), notifications and the
  // presentation stage (slide, view mode, intro). Additive only: new tables, and new columns with defaults.
  `
  ALTER TABLE teams ADD COLUMN approval TEXT NOT NULL DEFAULT 'approved';   -- 'pending' for self-registered teams
  ALTER TABLE teams ADD COLUMN members_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE teams ADD COLUMN site_url TEXT NOT NULL DEFAULT '';
  ALTER TABLE teams ADD COLUMN video_url TEXT NOT NULL DEFAULT '';
  ALTER TABLE teams ADD COLUMN site_embeddable INTEGER;
  ALTER TABLE teams ADD COLUMN extend_until INTEGER;
  ALTER TABLE teams ADD COLUMN review TEXT NOT NULL DEFAULT 'none';        -- none | submitted | accepted | returned
  ALTER TABLE teams ADD COLUMN review_note TEXT NOT NULL DEFAULT '';
  ALTER TABLE teams ADD COLUMN reviewed_at INTEGER;
  ALTER TABLE teams ADD COLUMN submitted_at INTEGER;
  CREATE TABLE team_links (
    id          INTEGER PRIMARY KEY,
    team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,         -- sha256 of the code in /t/<code>
    token_enc   TEXT NOT NULL DEFAULT '',     -- the code, encrypted with SESSION_SECRET (so the admin can show it again)
    created_at  INTEGER NOT NULL,
    revoked_at  INTEGER
  );
  CREATE INDEX team_links_team ON team_links(team_id);
  CREATE TABLE team_sessions (
    id           TEXT PRIMARY KEY,            -- sha256 of the cookie token
    team_id      INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent   TEXT,
    ip           TEXT
  );
  CREATE INDEX team_sessions_team ON team_sessions(team_id);
  CREATE TABLE team_files (
    id          INTEGER PRIMARY KEY,
    team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('presentation','logo')),
    stored      TEXT NOT NULL,                -- random file name inside DATA_DIR/uploads
    pdf_stored  TEXT,                         -- PPTX converted to PDF
    orig_name   TEXT NOT NULL,
    ext         TEXT NOT NULL,
    size        INTEGER NOT NULL,
    pages       INTEGER,
    conv        TEXT,                         -- PPTX: pending | running | done | failed | unavailable
    active      INTEGER NOT NULL DEFAULT 1,
    uploaded_by TEXT NOT NULL DEFAULT 'team', -- team | admin
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX team_files_team ON team_files(team_id, kind, active);
  CREATE TABLE notifications (
    id          INTEGER PRIMARY KEY,
    target      TEXT NOT NULL CHECK (target IN ('admin','team')),
    team_id     INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    read_at     INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX notifications_target ON notifications(target, team_id, id);
  ALTER TABLE event ADD COLUMN team_registration INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE event ADD COLUMN team_can_rename INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE event ADD COLUMN upload_deadline INTEGER;
  ALTER TABLE event ADD COLUMN jurors_see_materials INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE event ADD COLUMN stage_mode TEXT NOT NULL DEFAULT 'auto';    -- auto | timer | site
  ALTER TABLE event ADD COLUMN stage_slide INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE event ADD COLUMN stage_intro_at INTEGER;
  `,
];

/** Schema version this build migrates a database to. */
export const SCHEMA_VERSION = MIGRATIONS.length;
/** How many pre-migration copies are kept in DATA_DIR/backups. */
export const PRE_MIGRATION_KEEP = 10;

export function openDb(file: string, opts: { upTo?: number } = {}): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, opts.upTo);
  return db;
}

/**
 * Before a schema upgrade touches an existing database, keep a consistent copy of it
 * (better-sqlite3 online backup API) as <backupDir>/pre-v<target>-<timestamp>.db; only the newest
 * PRE_MIGRATION_KEEP copies are kept. Does nothing for a new or already current database.
 */
export async function backupBeforeMigrate(file: string, backupDir: string, log: (m: string) => void = () => {}): Promise<string | null> {
  if (file === ":memory:" || !fs.existsSync(file)) return null;
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    const current = db.pragma("user_version", { simple: true }) as number;
    if (current === 0 || current >= SCHEMA_VERSION) return null;
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 23);
    const target = path.join(backupDir, `pre-v${SCHEMA_VERSION}-${stamp}.db`);
    await db.backup(target);
    log(`pre-migration backup (schema v${current} → v${SCHEMA_VERSION}): ${target}`);
    const old = fs.readdirSync(backupDir).filter(n => /^pre-v\d+-.*\.db$/.test(n))
      .map(n => ({ n, t: fs.statSync(path.join(backupDir, n)).mtimeMs })).sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1));
    for (const o of old.slice(PRE_MIGRATION_KEEP)) fs.rmSync(path.join(backupDir, o.n), { force: true });
    return target;
  } finally {
    db.close();
  }
}

function migrate(db: DB, upTo = MIGRATIONS.length) {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < Math.min(upTo, MIGRATIONS.length); v++) {
    db.transaction(() => {
      const m = MIGRATIONS[v];
      if (typeof m === "string") db.exec(m); else m(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
