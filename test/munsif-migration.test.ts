// munsif upgrade safety: a database written by the previous release (schema v7, main) opens with the new code
// without losing anything, and a consistent copy is kept before the upgrade touches it.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { backupBeforeMigrate, openDb, PRE_MIGRATION_KEEP, SCHEMA_VERSION } from "../server/db.js";
import { Repo } from "../server/repo.js";
// The previous release's data layer (acf187a), frozen: the old database is written by the old code.
import { ensureBaseline as legacyBaseline } from "./fixtures/legacy-acf187a/baseline.js";
import { Repo as LegacyRepo } from "./fixtures/legacy-acf187a/repo.js";
import { adminResults } from "../server/views.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-mig-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const cfgFor = (dataDir: string) => loadConfig({
  dataDir, dbFile: path.join(dataDir, "ignite.db"), backupDir: path.join(dataDir, "backups"), uploadsDir: path.join(dataDir, "uploads"),
  adminUsername: "admin", adminPassword: "admin-pass-123", origins: [], sessionSecret: "s", webDir: "/nonexistent", soffice: "",
});

/** An event as the previous release left it: seeded rubric, renamed teams, three jurors with scores, a team on stage. */
async function oldDatabase(dataDir: string) {
  const cfg = cfgFor(dataDir);
  const db = openDb(cfg.dbFile, { upTo: 7 });
  expect(db.pragma("user_version", { simple: true })).toBe(7);
  const repo = new LegacyRepo(db);
  await legacyBaseline(repo, cfg);
  const teams = repo.teams();
  ["Pycore", "Tusi Lab", "Əkinçi AI"].forEach((n, i) => db.prepare("UPDATE teams SET name=?, project=?, entry_score=? WHERE id=?").run(n, `Layihə ${i + 1}`, 40 - i, teams[i].id));
  const crit = repo.criteria();
  const jurors = ["Əli Məmmədov", "Aysel Quliyeva", "Rəşad Həsənov"].map((n, i) => repo.createUser("juror", `juror-${i}`, n, "x"));
  let k = 0;
  for (const j of jurors) for (const t of teams.slice(0, 3)) {
    k++;
    const values = Object.fromEntries(crit.map((c, ci) => [c.key, Math.max(1, Math.min(c.maxScore, ((k + ci) % c.maxScore) + 1))]));
    repo.upsertScore(j.id, t.id, values, null, `qeyd ${k} ə Ə`, ["Güclü komanda"]);
    repo.recordScore("submit", j.id, t.id, values, null, `qeyd ${k} ə Ə`, ["Güclü komanda"]);
  }
  db.prepare("UPDATE event SET name='Ignite', product='DemoDay', current_team_id=?, include_entry=1, locked=1 WHERE id=1").run(teams[1].id);
  const snapshot = {
    tables: Object.fromEntries(["users", "teams", "criteria", "scores", "score_history", "audit_log", "juror_invites"].map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()])),
    ranking: adminResults(repo as unknown as Repo, cfg).results.ranking.map(r => [r.team.id, r.rank, r.score, r.demo, r.n]),
  };
  db.close();
  return { cfg, snapshot };
}

describe("upgrading a v7 (main) database", () => {
  it("keeps every team, juror, score, history row and the ranking; new columns get their defaults", async () => {
    const { cfg, snapshot } = await oldDatabase(path.join(tmp, "a"));
    const db = openDb(cfg.dbFile);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const repo = new Repo(db);
    for (const [t, rows] of Object.entries(snapshot.tables)) {
      const now = db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all() as Array<Record<string, unknown>>;
      // Old columns keep their values; added columns only appear next to them.
      expect(now.map(r => Object.fromEntries(Object.keys((rows as any[])[0] ?? {}).map(k => [k, r[k]]))), t).toEqual(rows);
    }
    expect(adminResults(repo, cfg).results.ranking.map(r => [r.team.id, r.rank, r.score, r.demo, r.n])).toEqual(snapshot.ranking);
    expect(repo.teams().every(t => t.approval === "approved")).toBe(true);
    expect(repo.getEvent()).toMatchObject({ name: "Ignite", product: "DemoDay", locked: true, teamRegistration: false, teamCanRename: false,
      jurorsSeeMaterials: true, uploadDeadline: null, stageMode: "auto", stageSlide: 1, stageIntroAt: null });
    expect(repo.stage().show).toMatchObject({ mode: "auto", slide: 1, pres: null, site: null, members: [] });
    db.close();
  });

  it("copies the database before migrating (online backup API) and keeps the newest copies only", async () => {
    const { cfg, snapshot } = await oldDatabase(path.join(tmp, "b"));
    for (let i = 0; i < PRE_MIGRATION_KEEP + 2; i++) {
      const f = path.join(cfg.backupDir, `pre-v${SCHEMA_VERSION}-2020-01-01_00-00-${String(i).padStart(2, "0")}-000.db`);
      fs.mkdirSync(cfg.backupDir, { recursive: true });
      fs.writeFileSync(f, "old");
      fs.utimesSync(f, new Date(2020, 0, 1, 0, 0, i), new Date(2020, 0, 1, 0, 0, i));
    }
    fs.writeFileSync(path.join(cfg.backupDir, "ignite-2026-01-01.db"), "manual backup"); // npm run backup copies are never pruned
    const target = await backupBeforeMigrate(cfg.dbFile, cfg.backupDir);
    expect(target).toMatch(new RegExp(`pre-v${SCHEMA_VERSION}-\\d{4}-\\d\\d-\\d\\d_[\\d-]+\\.db$`));
    const copy = new Database(target!, { readonly: true });
    expect(copy.pragma("user_version", { simple: true })).toBe(7);
    expect(copy.prepare("SELECT * FROM scores ORDER BY 1").all()).toEqual(snapshot.tables.scores);
    copy.close();
    const left = fs.readdirSync(cfg.backupDir);
    expect(left.filter(n => /^pre-.*\.db$/.test(n)).length).toBe(PRE_MIGRATION_KEEP);
    expect(left).toContain(path.basename(target!));
    expect(left).toContain("ignite-2026-01-01.db");
    // Already current, or brand new: nothing to copy.
    openDb(cfg.dbFile).close();
    expect(await backupBeforeMigrate(cfg.dbFile, cfg.backupDir)).toBeNull();
    expect(await backupBeforeMigrate(path.join(tmp, "nope.db"), cfg.backupDir)).toBeNull();
  });

  it("the server start makes the copy itself, then serves the old data", async () => {
    const { cfg, snapshot } = await oldDatabase(path.join(tmp, "c"));
    const A = await buildApp(cfg);
    try {
      const backups = fs.readdirSync(cfg.backupDir).filter(n => n.startsWith(`pre-v${SCHEMA_VERSION}-`));
      expect(backups.length).toBe(1);
      expect(A.ctx.orgs.root.repo.scores().length).toBe((snapshot.tables.scores as unknown[]).length);
      expect(A.ctx.orgs.root.repo.stage().team?.name).toBe("Tusi Lab");
    } finally { await A.close(); }
    // A restart of the upgraded database makes no further copies.
    const B = await buildApp(cfg);
    await B.close();
    expect(fs.readdirSync(cfg.backupDir).filter(n => n.startsWith("pre-")).length).toBe(1);
  });
});
