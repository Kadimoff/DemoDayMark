// The production DB is upgraded in place; this replays v2 → v3 → v4 on a v2-shaped database.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb, SCHEMA_VERSION } from "../server/db.js";
import { Repo } from "../server/repo.js";
import { DEFAULT_FEEDBACK_TAGS } from "../shared/brand.js";

describe("migrations v3 (points rubric + entry scores) and v4 (QR invites, tags, brand prefix)", () => {
  it("keeps data, gives old criteria a 10-point maximum and drops an old-model reveal snapshot", () => {
    const file = `/tmp/ij-mig-${process.pid}-${Date.now()}.db`;
    // Start from a v2 DB, then put the three tables v3 touches back into their exact v2 shape.
    openDb(file, { upTo: 2 }).close();
    const raw = new Database(file);
    raw.exec("DROP TABLE IF EXISTS notifications; DROP TABLE IF EXISTS team_files; DROP TABLE IF EXISTS team_sessions; DROP TABLE IF EXISTS team_links; DROP TABLE IF EXISTS score_history; DROP TABLE IF EXISTS juror_invites; DROP TABLE IF EXISTS scores; DROP TABLE IF EXISTS criteria; DROP TABLE IF EXISTS teams; DROP TABLE IF EXISTS event;");
    raw.exec(`
      CREATE TABLE teams (id INTEGER PRIMARY KEY, order_index INTEGER NOT NULL, name TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE criteria (id INTEGER PRIMARY KEY, order_index INTEGER NOT NULL, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', weight INTEGER NOT NULL);
      CREATE TABLE event (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, date TEXT NOT NULL, current_team_id INTEGER,
        timer_visible INTEGER NOT NULL DEFAULT 0, timer_running INTEGER NOT NULL DEFAULT 0, timer_offset_sec REAL NOT NULL DEFAULT 0,
        timer_anchor_at INTEGER, pitch_sec INTEGER NOT NULL DEFAULT 180, qa_sec INTEGER NOT NULL DEFAULT 120, locked INTEGER NOT NULL DEFAULT 0,
        show_juror_total INTEGER NOT NULL DEFAULT 0, reveal_enabled INTEGER NOT NULL DEFAULT 0, reveal_step INTEGER NOT NULL DEFAULT 0, reveal_snapshot TEXT);
      CREATE TABLE scores (id INTEGER PRIMARY KEY, juror_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, values_json TEXT NOT NULL, total REAL,
        note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (juror_id, team_id));
      INSERT INTO teams (order_index, name) VALUES (0, 'Pycore'), (1, 'Tusi');
      INSERT INTO users (id, role, username, display_name, password_hash, created_at) VALUES (7, 'juror', 'ali', 'Əli', 'x', 1);
      INSERT INTO scores (juror_id, team_id, values_json, total, note, created_at, updated_at) VALUES (7, 1, '{"mvp":8}', 8, 'yaxşı', 1, 2);
      INSERT INTO criteria (order_index, key, name, weight) VALUES (0, 'mvp', 'MVP / Demo', 20);
      INSERT INTO event (id, name, date, reveal_enabled, reveal_step, reveal_snapshot)
        VALUES (1, 'Ignite Demo Day', '29.10.2026', 1, 3, '{"createdAt":1,"entries":[{"teamId":1,"name":"Pycore","project":"","rank":1,"avg":88,"n":5}]}');
    `);
    raw.pragma("user_version = 2");
    raw.close();

    const db = openDb(file);
    const repo = new Repo(db);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(repo.teams().map(t => [t.name, t.entryScore])).toEqual([["Pycore", null], ["Tusi", null]]);
    expect(repo.criteria().map(c => [c.key, c.maxScore])).toEqual([["mvp", 10]]);
    expect(repo.getEvent()).toMatchObject({ name: "Ignite", includeEntry: true, entryMax: 50, feedbackTags: DEFAULT_FEEDBACK_TAGS, revealTop: 3, product: "Hakaton", revealBatch: 1, revealHideScores: false, finalOrder: null });
    expect(repo.stage().eventName).toBe("Ignite Hakaton"); // v6: the event type defaults to Hakaton
    expect(repo.scores()).toMatchObject([{ jurorId: 7, teamId: 1, values: { mvp: 8 }, note: "yaxşı", tags: [] }]);
    expect(repo.getReveal()).toEqual({ enabled: false, step: 0, snapshot: null });
    db.close();
  });
});
