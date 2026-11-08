import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { brandName } from "../shared/brand.js";

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
  // v9 (orgs): organisations (multi-tenant). Every existing row belongs to the default organisation (id 1, slug
  // 'root'): new org_id columns default to 1. Additive except for two tables whose constraints assumed one event —
  // `event` (CHECK id = 1 → one row per org) and `criteria` (key unique per org) — which are rebuilt here by copying
  // every row inside this transaction; the copy is compared with the original before the old table is dropped.
  db => migrateOrgs(db),
  // v10 (events): an organisation can run several events. Additive only: a new `events` table (one active event per
  // organisation; the existing event of every organisation becomes its active event, with the same id as its `event`
  // row), an `event_id` column on every per-event table (filled with that active event), the event's own presentations
  // (`event_files`) and the new stage / timer settings on `event` (all with defaults). Nothing is copied or dropped.
  db => migrateEvents(db),
];

/** Tables whose rows belong to one event of an organisation (v10). */
export const EVENT_TABLES = ["users", "teams", "criteria", "scores", "score_history", "juror_invites", "team_links", "team_sessions", "team_files", "notifications"] as const;

function migrateEvents(db: DB) {
  db.exec(`
  CREATE TABLE events (
    id            INTEGER PRIMARY KEY,
    org_id        INTEGER NOT NULL REFERENCES orgs(id),
    name          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    created_at    INTEGER NOT NULL,
    archived_at   INTEGER,
    settings_json TEXT,                        -- archived: the event row (settings, reveal) as it was when archived
    stats_json    TEXT                         -- archived: counts and the ranking at that moment (for the list)
  );
  CREATE UNIQUE INDEX events_one_active ON events(org_id) WHERE status = 'active';
  CREATE INDEX events_org ON events(org_id, id);
  CREATE TABLE event_files (
    id          INTEGER PRIMARY KEY,
    org_id      INTEGER NOT NULL REFERENCES orgs(id),
    event_id    INTEGER NOT NULL REFERENCES events(id),
    title       TEXT NOT NULL DEFAULT '',
    stored      TEXT NOT NULL,
    pdf_stored  TEXT,
    orig_name   TEXT NOT NULL,
    ext         TEXT NOT NULL,
    size        INTEGER NOT NULL,
    pages       INTEGER,
    conv        TEXT,
    order_index INTEGER NOT NULL DEFAULT 0,
    deleted_at  INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX event_files_event ON event_files(org_id, event_id, deleted_at, order_index);
  ALTER TABLE event ADD COLUMN stage_scene TEXT NOT NULL DEFAULT 'team';        -- team | event (the event's own presentation)
  ALTER TABLE event ADD COLUMN stage_event_file INTEGER;
  ALTER TABLE event ADD COLUMN event_slide INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE event ADD COLUMN event_bubble INTEGER NOT NULL DEFAULT 0;         -- timer bubble over the event presentation
  ALTER TABLE event ADD COLUMN team_slide_control INTEGER NOT NULL DEFAULT 1;   -- the team on stage may turn its own slides
  ALTER TABLE event ADD COLUMN last5_fx INTEGER NOT NULL DEFAULT 1;             -- last-5-seconds effect on the projector
  ALTER TABLE event ADD COLUMN stage_sound INTEGER NOT NULL DEFAULT 1;          -- projector sounds
  `);
  const rows = db.prepare("SELECT e.id, e.org_id, e.name, e.product, o.created_at FROM event e JOIN orgs o ON o.id = e.org_id ORDER BY e.id").all() as
    Array<{ id: number; org_id: number; name: string; product: string; created_at: number }>;
  const ins = db.prepare("INSERT INTO events (id, org_id, name, status, created_at) VALUES (?, ?, ?, 'active', ?)");
  for (const r of rows) ins.run(r.id, r.org_id, brandName(r.name, r.product), r.created_at || Date.now());
  // An organisation without an event row (a database that never finished its first start) still gets its event.
  db.prepare(`INSERT INTO events (org_id, name, status, created_at) SELECT o.id, o.name, 'active', o.created_at FROM orgs o
    WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.org_id = o.id)`).run();
  for (const t of EVENT_TABLES) {
    const before = (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
    db.exec(`ALTER TABLE ${t} ADD COLUMN event_id INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE ${t} SET event_id = COALESCE((SELECT ev.id FROM events ev WHERE ev.org_id = ${t}.org_id AND ev.status = 'active'), 0)`);
    const after = (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
    const orphan = (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE event_id = 0`).get() as { n: number }).n;
    if (after !== before || orphan) throw new Error(`v10: ${t} — ${orphan} rows without an event (${before} → ${after}) — migration aborted`);
    db.exec(`CREATE INDEX ${t}_event ON ${t}(org_id, event_id)`);
  }
  const broken = db.prepare("PRAGMA foreign_key_check").all();
  if (broken.length) throw new Error(`v10: foreign key check failed (${broken.length} rows) — migration aborted`);
}

/** Rebuilds `table` with the same columns (+ extra column defs / table constraints), copying and verifying every row. */
function rebuildTable(db: DB, table: string, extra: { columns: string[]; constraints: string[] }) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;
  const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ from: string; table: string; to: string; on_delete: string }>;
  const defs = cols.map(c => {
    if (c.pk) return `${c.name} INTEGER PRIMARY KEY`;
    const fk = fks.find(f => f.from === c.name);
    return [c.name, c.type, c.notnull ? "NOT NULL" : "", c.dflt_value != null ? `DEFAULT ${c.dflt_value}` : "",
      fk ? `REFERENCES ${fk.table}(${fk.to})${fk.on_delete && fk.on_delete !== "NO ACTION" ? ` ON DELETE ${fk.on_delete}` : ""}` : ""].filter(Boolean).join(" ");
  });
  const names = cols.map(c => c.name).join(", ");
  const tmp = `${table}__v9`;
  const dump = (t: string) => JSON.stringify(db.prepare(`SELECT ${names} FROM ${t} ORDER BY rowid`).raw().all());
  const before = dump(table);
  db.exec(`CREATE TABLE ${tmp} (\n  ${[...defs, ...extra.columns, ...extra.constraints].join(",\n  ")}\n)`);
  db.exec(`INSERT INTO ${tmp} (${names}) SELECT ${names} FROM ${table} ORDER BY rowid`);
  if (dump(tmp) !== before) throw new Error(`v9: copy of ${table} differs from the original — migration aborted`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
}

function migrateOrgs(db: DB) {
  db.exec(`
  CREATE TABLE orgs (
    id         INTEGER PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1
  );`);
  const ev = db.prepare("SELECT name, product FROM event WHERE id = 1").get() as { name: string; product: string } | undefined;
  db.prepare("INSERT INTO orgs (id, slug, name, created_at, active) VALUES (1, 'root', ?, ?, 1)")
    .run(ev ? brandName(ev.name, ev.product) : "munsif.im", Date.now());
  rebuildTable(db, "event", { columns: ["org_id INTEGER NOT NULL DEFAULT 1 REFERENCES orgs(id)"], constraints: ["UNIQUE (org_id)"] });
  rebuildTable(db, "criteria", { columns: ["org_id INTEGER NOT NULL DEFAULT 1 REFERENCES orgs(id)"], constraints: ["UNIQUE (org_id, key)"] });
  db.exec(`
  ALTER TABLE users ADD COLUMN org_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE users ADD COLUMN is_root INTEGER NOT NULL DEFAULT 0;      -- platform owner (the env admin); role stays 'admin'
  UPDATE users SET is_root = 1 WHERE role = 'admin';
  ALTER TABLE teams ADD COLUMN org_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE scores ADD COLUMN org_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE score_history ADD COLUMN org_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE audit_log ADD COLUMN org_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE juror_invites ADD COLUMN org_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE team_links ADD COLUMN org_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE team_sessions ADD COLUMN org_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE team_files ADD COLUMN org_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE notifications ADD COLUMN org_id INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX users_org ON users(org_id, role);
  CREATE INDEX teams_org ON teams(org_id, order_index);
  CREATE INDEX scores_org ON scores(org_id);
  CREATE INDEX score_history_org ON score_history(org_id, id);
  CREATE INDEX audit_org ON audit_log(org_id, id);
  CREATE INDEX team_files_org ON team_files(org_id);
  CREATE INDEX notifications_org ON notifications(org_id, target, team_id, id);
  `);
  const broken = db.prepare("PRAGMA foreign_key_check").all();
  if (broken.length) throw new Error(`v9: foreign key check failed (${broken.length} rows) — migration aborted`);
}

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
