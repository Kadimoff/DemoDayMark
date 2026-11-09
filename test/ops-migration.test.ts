// v11 upgrade safety: a database written by the live release (468f2a0, schema v10, events) opens with the reliability code
// (v11: score_ops) without losing or changing anything; a pre-migration copy is kept; the old rows read exactly as before
// and a juror can keep scoring with op ids right away.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { EVENT_TABLES_V11, openDb, SCHEMA_VERSION } from "../server/db.js";
import type { Repo } from "../server/repo.js";
import { submitScore } from "../server/scores.js";
import { adminResults, revealPublicView } from "../server/views.js";
import { ensureBaseline as legacyBaseline } from "./fixtures/legacy-468f2a0/baseline.js";
import { Repo as LegacyRepo } from "./fixtures/legacy-468f2a0/repo.js";
import { TeamRepo as LegacyTeamRepo } from "./fixtures/legacy-468f2a0/teamrepo.js";
import { asV13 } from "./helpers/v13.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-opsmig-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const cfgFor = (dataDir: string) => loadConfig({
  dataDir, dbFile: path.join(dataDir, "ignite.db"), backupDir: path.join(dataDir, "backups"), uploadsDir: path.join(dataDir, "uploads"),
  adminUsername: "admin", adminPassword: "admin-pass-123", origins: [], sessionSecret: "s", webDir: "/nonexistent", soffice: "", backupIntervalMs: 0,
});
const TABLES = ["orgs", "events", "users", "sessions", "event", "teams", "criteria", "scores", "score_history", "audit_log", "juror_invites",
  "team_links", "team_sessions", "team_files", "notifications", "event_files"];

async function v10Database(dataDir: string) {
  const cfg = cfgFor(dataDir);
  const db = openDb(cfg.dbFile, { upTo: 10 });
  expect(db.pragma("user_version", { simple: true })).toBe(10);
  await legacyBaseline(db, cfg);
  const repo = new LegacyRepo(db, 1, "root");
  const trepo = new LegacyTeamRepo(db, cfg.sessionSecret, 1, repo.eventId);
  const teams = repo.teams();
  const crit = repo.criteria();
  const jurors = [1, 2, 3].map(i => repo.createUser("juror", `j${i}`, `Münsif ${i}`, "x"));
  repo.createSession("sess-1", jurors[0].id, "ua", "127.0.0.1");
  let k = 0;
  for (const j of jurors) for (const t of teams.slice(0, 4)) {
    k++;
    const values = Object.fromEntries(crit.map((c, ci) => [c.key, Math.max(1, Math.min(c.maxScore, ((k * 3 + ci) % c.maxScore) + 1))]));
    repo.upsertScore(j.id, t.id, values, null, `qeyd ${k}`, []);
    repo.recordScore("submit", j.id, t.id, values, null, `qeyd ${k}`, []);
    repo.audit(j.id, "score.submit", { teamId: t.id });
  }
  trepo.issueLink(teams[0].id);
  trepo.addEventFile({ stored: "pres-0123456789abcdef0123456789abcdef.pdf", origName: "Açılış.pdf", ext: "pdf", size: 1000, pages: 4, conv: null, title: "Açılış" });
  repo.updateEvent({ currentTeamId: teams[1].id, stageSlide: 3, timer: { ...repo.getEvent().timer, visible: true, running: true, offsetSec: 12, anchorAt: Date.now() - 5000 } });
  const ranking = adminResults(repo as unknown as Repo, cfg).results.ranking.map(r => [r.team.id, r.rank, r.score, r.n]);
  const reveal = revealPublicView(repo as unknown as Repo);
  const stage = repo.stage(1_700_000_000_000);
  const snapshot = Object.fromEntries(TABLES.map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  db.close();
  return { cfg, snapshot, ranking, reveal, stage, jurors, teams, crit };
}

describe("upgrading the live 468f2a0 (v10) database to score ops (v11)", () => {
  it("keeps every row, the results, the stage and the running timer; a pre-v11 copy is kept", async () => {
    const { cfg, snapshot, ranking, reveal, stage } = await v10Database(path.join(tmp, "a"));
    const A = await buildApp(cfg);
    try {
      expect(SCHEMA_VERSION).toBe(15);
      const backups = fs.readdirSync(cfg.backupDir).filter(n => n.startsWith(`pre-v${SCHEMA_VERSION}-`));
      expect(backups.length).toBe(1);
      const copy = new Database(path.join(cfg.backupDir, backups[0]), { readonly: true });
      expect(copy.pragma("user_version", { simple: true })).toBe(10);
      expect(copy.prepare("SELECT * FROM scores ORDER BY rowid").all()).toEqual(snapshot.scores);
      copy.close();
      const db = A.ctx.orgs.db;
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(db.pragma("foreign_key_check")).toEqual([]);
      // the same rows and the same values in every old column (later versions only add columns: v14 team_pick_*, claimed_at)
      for (const t of TABLES) {
        const old = asV13(t, snapshot[t] as Array<Record<string, unknown>>);
        const now = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
        expect(now.map(r => (old[0] ? Object.fromEntries(Object.keys(old[0]).map(k => [k, r[k]])) : r)), t).toEqual(old);
      }
      for (const t of EVENT_TABLES_V11) expect(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get(), t).toEqual({ n: 0 });
      const repo = A.ctx.orgs.root.repo;
      expect(adminResults(repo, cfg).results.ranking.map(r => [r.team.id, r.rank, r.score, r.n])).toEqual(ranking);
      expect(revealPublicView(repo)).toEqual(reveal);
      expect(repo.stage(1_700_000_000_000)).toEqual(stage);
    } finally { await A.close(); }
  });

  it("an old juror session scores with op ids right after the upgrade (applied once)", async () => {
    const { cfg, jurors, teams, crit } = await v10Database(path.join(tmp, "b"));
    const A = await buildApp(cfg);
    try {
      const sc = A.ctx.orgs.root;
      const values = Object.fromEntries(crit.map(c => [c.key, 1]));
      const r1 = submitScore(sc.repo, sc.rt, jurors[0].id, teams[5].id, { values, opId: "upgrade-op-0001" });
      const r2 = submitScore(sc.repo, sc.rt, jurors[0].id, teams[5].id, { values, opId: "upgrade-op-0001" });
      expect(r1.ok && r2.ok).toBe(true);
      expect(r2.ok && r2.body.duplicate).toBe(true);
      expect(sc.repo.history({ jurorId: jurors[0].id, teamId: teams[5].id }).total).toBe(1);
    } finally { await A.close(); }
  });
});
