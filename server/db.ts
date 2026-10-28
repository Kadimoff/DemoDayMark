import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

// Plain SQL migrations, applied in order and tracked with PRAGMA user_version.
const MIGRATIONS: string[] = [
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
];

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
