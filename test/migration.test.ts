// The production DB is upgraded in place; this replays the v2 → v3 step on a v2-shaped database.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDb } from "../server/db.js";
import { Repo } from "../server/repo.js";

describe("migration v3 (points rubric + entry scores)", () => {
  it("keeps data, gives old criteria a 10-point maximum and drops an old-model reveal snapshot", () => {
    const file = `/tmp/ij-mig-${process.pid}-${Date.now()}.db`;
    // Start from a current DB, then put the three tables v3 touches back into their v2 shape.
    openDb(file).close();
    const raw = new Database(file);
    raw.exec("DROP TABLE IF EXISTS criteria; DROP TABLE IF EXISTS teams; DROP TABLE IF EXISTS event;");
    raw.exec(`
      CREATE TABLE teams (id INTEGER PRIMARY KEY, order_index INTEGER NOT NULL, name TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE criteria (id INTEGER PRIMARY KEY, order_index INTEGER NOT NULL, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', weight INTEGER NOT NULL);
      CREATE TABLE event (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, date TEXT NOT NULL, current_team_id INTEGER,
        timer_visible INTEGER NOT NULL DEFAULT 0, timer_running INTEGER NOT NULL DEFAULT 0, timer_offset_sec REAL NOT NULL DEFAULT 0,
        timer_anchor_at INTEGER, pitch_sec INTEGER NOT NULL DEFAULT 180, qa_sec INTEGER NOT NULL DEFAULT 120, locked INTEGER NOT NULL DEFAULT 0,
        show_juror_total INTEGER NOT NULL DEFAULT 0, reveal_enabled INTEGER NOT NULL DEFAULT 0, reveal_step INTEGER NOT NULL DEFAULT 0, reveal_snapshot TEXT);
      INSERT INTO teams (order_index, name) VALUES (0, 'Pycore'), (1, 'Tusi');
      INSERT INTO criteria (order_index, key, name, weight) VALUES (0, 'mvp', 'MVP / Demo', 20);
      INSERT INTO event (id, name, date, reveal_enabled, reveal_step, reveal_snapshot)
        VALUES (1, 'Ignite Demo Day', '29.10.2026', 1, 3, '{"createdAt":1,"entries":[{"teamId":1,"name":"Pycore","project":"","rank":1,"avg":88,"n":5}]}');
    `);
    raw.pragma("user_version = 2");
    raw.close();

    const db = openDb(file);
    const repo = new Repo(db);
    expect(db.pragma("user_version", { simple: true })).toBe(3);
    expect(repo.teams().map(t => [t.name, t.entryScore])).toEqual([["Pycore", null], ["Tusi", null]]);
    expect(repo.criteria().map(c => [c.key, c.maxScore])).toEqual([["mvp", 10]]);
    expect(repo.getEvent()).toMatchObject({ name: "Ignite Demo Day", includeEntry: true, entryMax: 50 });
    expect(repo.getReveal()).toEqual({ enabled: false, step: 0, snapshot: null });
    db.close();
  });
});
