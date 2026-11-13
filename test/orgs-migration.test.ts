// orgs upgrade safety: a database written by the previous release (acf187a, schema v8) with a live event in it opens
// with the multi-tenant code (v9) without losing or changing anything. Every row lands in the default organisation,
// results are identical, a pre-migration copy is kept, and the two rebuilt tables keep their constraints.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { openDb, SCHEMA_VERSION } from "../server/db.js";
import { Repo } from "../server/repo.js";
import { adminResults, revealPublicView } from "../server/views.js";
import { ensureBaseline as legacyBaseline } from "./fixtures/legacy-acf187a/baseline.js";
import { Repo as LegacyRepo } from "./fixtures/legacy-acf187a/repo.js";
import { TeamRepo as LegacyTeamRepo } from "./fixtures/legacy-acf187a/teamrepo.js";
import { asV13 } from "./helpers/v13.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-orgmig-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const cfgFor = (dataDir: string) => loadConfig({
  dataDir, dbFile: path.join(dataDir, "ignite.db"), backupDir: path.join(dataDir, "backups"), uploadsDir: path.join(dataDir, "uploads"),
  adminUsername: "admin", adminPassword: "admin-pass-123", origins: [], sessionSecret: "s", webDir: "/nonexistent", soffice: "",
});
const TABLES = ["users", "sessions", "event", "teams", "criteria", "scores", "score_history", "audit_log", "juror_invites",
  "team_links", "team_sessions", "team_files", "notifications"];
const ORG_TABLES = ["users", "event", "teams", "criteria", "scores", "score_history", "audit_log", "juror_invites", "team_links", "team_sessions", "team_files", "notifications"];

/** The live event as acf187a left it: renamed teams, jurors with scores, a file, a link, notices, the reveal open. */
async function v8Database(dataDir: string) {
  const cfg = cfgFor(dataDir);
  const db = openDb(cfg.dbFile, { upTo: 8 });
  expect(db.pragma("user_version", { simple: true })).toBe(8);
  const repo = new LegacyRepo(db);
  const trepo = new LegacyTeamRepo(db, cfg.sessionSecret);
  await legacyBaseline(repo, cfg);
  const teams = repo.teams();
  ["Pycore", "Tusi Lab", "Əkinçi AI", "Sumqayıt"].forEach((n, i) => db.prepare("UPDATE teams SET name=?, project=?, entry_score=? WHERE id=?").run(n, `Layihə ${i + 1}`, 40 - i, teams[i].id));
  const crit = repo.criteria();
  const jurors = ["Əli Məmmədov", "Aysel Quliyeva", "Rəşad Həsənov"].map((n, i) => repo.createUser("juror", `juror-${i}`, n, "x"));
  jurors.forEach(j => repo.createInvite(j.id, `hash-${j.id}`, 3600_000));
  repo.createSession("sess-juror-0", jurors[0].id, "ua", "127.0.0.1");
  let k = 0;
  for (const j of jurors) for (const t of teams.slice(0, 4)) {
    k++;
    const values = Object.fromEntries(crit.map((c, ci) => [c.key, Math.max(1, Math.min(c.maxScore, ((k * 3 + ci) % c.maxScore) + 1))]));
    repo.upsertScore(j.id, t.id, values, null, `qeyd ${k} ə Ə`, ["Güclü komanda"]);
    repo.recordScore("submit", j.id, t.id, values, null, `qeyd ${k} ə Ə`, ["Güclü komanda"]);
    repo.audit(j.id, "score.submit", { teamId: t.id, values });
  }
  trepo.issueLink(teams[0].id);
  trepo.createSession("tsess-0", teams[0].id, "ua", "127.0.0.1");
  trepo.addFile({ teamId: teams[0].id, kind: "presentation", stored: "pres-0123456789abcdef0123456789abcdef.pdf", origName: "pitch.pdf", ext: "pdf", size: 1000, pages: 3, conv: null, by: "team" });
  trepo.addNotice("admin", teams[0].id, "upload", "Pycore prezentasiya yüklədi");
  trepo.addNotice("team", teams[0].id, "review.accepted", "Prezentasiyanız qəbul edildi");
  db.prepare("UPDATE event SET name='TechConnect', product='Hakaton', current_team_id=?, include_entry=1, timer_running=1, timer_anchor_at=?, stage_slide=2 WHERE id=1").run(teams[1].id, Date.now());
  const ranking = adminResults(repo as unknown as Repo, cfg).results.ranking.map(r => [r.team.id, r.rank, r.score, r.demo, r.n]);
  db.prepare("UPDATE event SET reveal_enabled=1, reveal_step=1, reveal_snapshot=?, locked=1 WHERE id=1").run(JSON.stringify({
    createdAt: 1, maxTotal: 100, top: 3, batch: 1, manual: false,
    entries: ranking.map(([teamId, rank, score, demo, n]) => ({ teamId, name: teams.find(t => t.id === teamId)!.name, project: "", rank, score, demo, entry: null, n })),
  }));
  const snapshot = Object.fromEntries(TABLES.map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  const reveal = revealPublicView(repo as unknown as Repo);
  db.close();
  return { cfg, snapshot, ranking, reveal };
}

describe("upgrading the live acf187a (v8) database to organisations (v9)", () => {
  it("keeps every row and value, puts all of it in the default organisation and keeps the results", async () => {
    const { cfg, snapshot, ranking, reveal } = await v8Database(path.join(tmp, "a"));
    const A = await buildApp(cfg);
    try {
      // a consistent copy of the v8 file was made first
      const backups = fs.readdirSync(cfg.backupDir).filter(n => n.startsWith(`pre-v${SCHEMA_VERSION}-`));
      expect(SCHEMA_VERSION).toBe(16); // v8 → … → v14 (shared team link) → v15 (rename limit) → v16 (shared juror link) in one start
      expect(backups.length).toBe(1);
      const copy = new Database(path.join(cfg.backupDir, backups[0]), { readonly: true });
      expect(copy.pragma("user_version", { simple: true })).toBe(8);
      expect(copy.prepare("SELECT * FROM scores ORDER BY rowid").all()).toEqual(snapshot.scores);
      copy.close();

      const db = A.ctx.orgs.db;
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      for (const t of TABLES) {
        const now = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
        const old = asV13(t, snapshot[t] as Array<Record<string, unknown>>);
        expect(old.length, t).toBeGreaterThan(0);
        // the same rows, the same values in every old column (added columns only appear next to them)
        expect(now.map(r => Object.fromEntries(Object.keys(old[0]).map(k => [k, r[k]]))), t).toEqual(old);
      }
      for (const t of ORG_TABLES) expect(db.prepare(`SELECT DISTINCT org_id FROM ${t}`).all(), t).toEqual([{ org_id: 1 }]);
      expect(A.ctx.orgs.list()).toMatchObject([{ id: 1, slug: "root", name: "TechConnect Hakaton", active: 1 }]);
      expect(db.prepare("SELECT username, role, is_root, org_id FROM users WHERE role='admin'").all()).toEqual([{ username: "admin", role: "admin", is_root: 1, org_id: 1 }]);
      expect(db.prepare("SELECT COUNT(*) n FROM users WHERE is_root=1").get()).toEqual({ n: 1 });

      const repo = A.ctx.orgs.root.repo;
      expect(adminResults(repo, cfg).results.ranking.map(r => [r.team.id, r.rank, r.score, r.demo, r.n])).toEqual(ranking);
      expect(revealPublicView(repo)).toEqual(reveal);
      expect(repo.stage()).toMatchObject({ eventName: "TechConnect Hakaton", team: { name: "Tusi Lab" }, show: { slide: 2 } });
      expect(repo.getEvent()).toMatchObject({ locked: true, includeEntry: true, timer: { running: true } });
      expect(A.ctx.orgs.root.teams.adminList()[0]).toMatchObject({ name: "Pycore", sessions: 1, link: { code: expect.any(String) }, presentation: { name: "pitch.pdf" } });
      expect(A.ctx.orgs.root.trepo.notices("admin", null).length).toBe(1);
      expect(repo.history().total).toBe((snapshot.score_history as unknown[]).length);
    } finally { await A.close(); }
  });

  it("the rebuilt event and criteria tables keep their keys and foreign keys, and allow a second organisation", async () => {
    const { cfg } = await v8Database(path.join(tmp, "b"));
    const db = openDb(cfg.dbFile);
    try {
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      // event: one row per organisation; still nulls the team on stage when that team is deleted
      const ev = db.prepare("SELECT id, org_id, current_team_id FROM event").all() as Array<{ id: number; org_id: number; current_team_id: number }>;
      expect(ev).toMatchObject([{ id: 1, org_id: 1 }]);
      db.prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES (2, 'demo', 'Demo', 0)").run();
      db.prepare("INSERT INTO event (org_id, name, date) VALUES (2, 'Demo', '01.01.2027')").run();
      expect(() => db.prepare("INSERT INTO event (org_id, name, date) VALUES (2, 'Again', '01.01.2027')").run()).toThrow(/UNIQUE/);
      expect(() => db.prepare("INSERT INTO event (org_id, name, date) VALUES (99, 'Ghost', '01.01.2027')").run()).toThrow(/FOREIGN KEY/);
      db.prepare("DELETE FROM teams WHERE id = ?").run(ev[0].current_team_id);
      expect(db.prepare("SELECT current_team_id FROM event WHERE org_id = 1").get()).toEqual({ current_team_id: null });
      // criteria: the same key may exist once per organisation
      const key = (db.prepare("SELECT key FROM criteria WHERE org_id = 1 LIMIT 1").get() as { key: string }).key;
      db.prepare("INSERT INTO criteria (order_index, key, name, weight, max_score, org_id) VALUES (0, ?, 'x', 5, 5, 2)").run(key);
      expect(() => db.prepare("INSERT INTO criteria (order_index, key, name, weight, max_score, org_id) VALUES (1, ?, 'y', 5, 5, 2)").run(key)).toThrow(/UNIQUE/);
      expect(new Repo(db, 2, "demo").criteria().map(c => c.key)).toEqual([key]);
      // scores still cascade with their team
      const n = (db.prepare("SELECT COUNT(*) n FROM scores").get() as { n: number }).n;
      expect(n).toBe(9); // the team on stage (3 scores) is gone
    } finally { db.close(); }
  });

  it("a failed copy rolls the whole upgrade back (the v8 database stays as it was)", async () => {
    const { cfg, snapshot } = await v8Database(path.join(tmp, "c"));
    // sabotage: a table named like the rebuild's scratch table makes v9 fail half-way
    const raw = new Database(cfg.dbFile);
    raw.exec("CREATE TABLE criteria__v9 (x INTEGER)");
    raw.close();
    expect(() => openDb(cfg.dbFile)).toThrow();
    const db = new Database(cfg.dbFile, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(8);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'orgs'").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM event ORDER BY rowid").all()).toEqual(snapshot.event);
    expect(db.prepare("SELECT * FROM criteria ORDER BY rowid").all()).toEqual(snapshot.criteria);
    db.close();
  });
});
