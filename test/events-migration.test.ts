// v3 events upgrade safety: a database written by the live release (537b462, schema v9, organisations) opens with the
// multi-event code (v10) without losing or changing anything. Every row of every organisation lands in that
// organisation's (one, active) event; results, reveal, stage, files and sessions are as they were; a pre-migration copy
// is kept; a failed upgrade rolls back completely.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { openDb, SCHEMA_VERSION } from "../server/db.js";
import { adminResults, revealPublicView } from "../server/views.js";
import type { Repo } from "../server/repo.js";
import { ensureBaseline as legacyBaseline, seedOrgEvent as legacySeedOrg } from "./fixtures/legacy-537b462/baseline.js";
import { Repo as LegacyRepo } from "./fixtures/legacy-537b462/repo.js";
import { TeamRepo as LegacyTeamRepo } from "./fixtures/legacy-537b462/teamrepo.js";
import { asV13 } from "./helpers/v13.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-evmig-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const cfgFor = (dataDir: string) => loadConfig({
  dataDir, dbFile: path.join(dataDir, "ignite.db"), backupDir: path.join(dataDir, "backups"), uploadsDir: path.join(dataDir, "uploads"),
  adminUsername: "admin", adminPassword: "admin-pass-123", origins: [], sessionSecret: "s", webDir: "/nonexistent", soffice: "",
});
const TABLES = ["orgs", "users", "sessions", "event", "teams", "criteria", "scores", "score_history", "audit_log", "juror_invites",
  "team_links", "team_sessions", "team_files", "notifications"];
const EVENT_TABLES = ["users", "teams", "criteria", "scores", "score_history", "juror_invites", "team_links", "team_sessions", "team_files", "notifications"];

/** The live database as 537b462 leaves it: the root event "TechConnect Hakaton" + a "demo" organisation, both with data. */
async function v9Database(dataDir: string) {
  const cfg = cfgFor(dataDir);
  const db = openDb(cfg.dbFile, { upTo: 9 });
  expect(db.pragma("user_version", { simple: true })).toBe(9);
  const orgsOut: Record<number, { ranking: unknown; reveal: unknown }> = {};
  const fill = (repo: LegacyRepo, trepo: LegacyTeamRepo, names: string[], tag: string) => {
    const teams = repo.teams();
    names.forEach((n, i) => db.prepare("UPDATE teams SET name=?, project=? WHERE id=?").run(n, `Layihə ${tag}${i + 1}`, teams[i].id));
    const crit = repo.criteria();
    const jurors = [1, 2].map(i => repo.createUser("juror", `${tag}-juror-${i}`, `${tag} Münsif ${i}`, "x"));
    jurors.forEach(j => repo.createInvite(j.id, `hash-${tag}-${j.id}`, 3600_000));
    repo.createSession(`sess-${tag}`, jurors[0].id, "ua", "127.0.0.1");
    let k = 0;
    for (const j of jurors) for (const t of teams.slice(0, names.length)) {
      k++;
      const values = Object.fromEntries(crit.map((c, ci) => [c.key, Math.max(1, Math.min(c.maxScore, ((k * 3 + ci) % c.maxScore) + 1))]));
      repo.upsertScore(j.id, t.id, values, null, `qeyd ${k}`, ["Güclü komanda"]);
      repo.recordScore("submit", j.id, t.id, values, null, `qeyd ${k}`, ["Güclü komanda"]);
      repo.audit(j.id, "score.submit", { teamId: t.id });
    }
    trepo.issueLink(teams[0].id);
    trepo.createSession(`tsess-${tag}`, teams[0].id, "ua", "127.0.0.1");
    trepo.addFile({ teamId: teams[0].id, kind: "presentation", stored: `pres-${tag}0123456789abcdef0123456789abcd.pdf`.slice(0, 41) + ".pdf", origName: `${tag}.pdf`, ext: "pdf", size: 1000, pages: 3, conv: null, by: "team" });
    trepo.addNotice("admin", teams[0].id, "upload", `${names[0]} prezentasiya yüklədi`);
    db.prepare("UPDATE event SET current_team_id=?, stage_slide=2 WHERE org_id=?").run(teams[1].id, repo.orgId);
    orgsOut[repo.orgId] = { ranking: adminResults(repo as unknown as Repo, cfg).results.ranking.map(r => [r.team.id, r.rank, r.score, r.n]), reveal: revealPublicView(repo as unknown as Repo) };
  };
  const root = new LegacyRepo(db, 1, "root");
  await legacyBaseline(root, cfg);
  db.prepare("UPDATE event SET name='TechConnect', product='Hakaton' WHERE org_id=1").run();
  fill(root, new LegacyTeamRepo(db, cfg.sessionSecret, 1), ["Pycore", "Tusi Lab", "Əkinçi AI"], "r");
  db.prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES (2, 'demo', 'Demo', 1700000000000)").run();
  const demo = new LegacyRepo(db, 2, "demo");
  legacySeedOrg(demo, cfg, "Demo");
  ["Alfa", "Beta"].forEach(n => demo.addTeam(n, ""));
  fill(demo, new LegacyTeamRepo(db, cfg.sessionSecret, 2), ["Alfa", "Beta"], "d");
  const snapshot = Object.fromEntries(TABLES.map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  db.close();
  return { cfg, snapshot, orgsOut };
}

describe("upgrading the live 537b462 (v9) database to events (v10)", () => {
  it("keeps every row and value; each organisation's rows land in its one active event; results identical", async () => {
    const { cfg, snapshot, orgsOut } = await v9Database(path.join(tmp, "a"));
    const A = await buildApp(cfg);
    try {
      expect(SCHEMA_VERSION).toBe(13);
      const backups = fs.readdirSync(cfg.backupDir).filter(n => n.startsWith(`pre-v${SCHEMA_VERSION}-`));
      expect(backups.length).toBe(1);
      const copy = new Database(path.join(cfg.backupDir, backups[0]), { readonly: true });
      expect(copy.pragma("user_version", { simple: true })).toBe(9);
      expect(copy.prepare("SELECT * FROM scores ORDER BY rowid").all()).toEqual(snapshot.scores);
      copy.close();

      const db = A.ctx.orgs.db;
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      for (const t of TABLES) {
        const now = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
        const old = asV13(t, snapshot[t] as Array<Record<string, unknown>>);
        expect(old.length, t).toBeGreaterThan(0);
        expect(now.map(r => Object.fromEntries(Object.keys(old[0]).map(k => [k, r[k]]))), t).toEqual(old);
      }
      const events = db.prepare("SELECT id, org_id, name, status FROM events ORDER BY id").all() as Array<{ id: number; org_id: number; name: string; status: string }>;
      expect(events).toEqual([{ id: 1, org_id: 1, name: "TechConnect Hakaton", status: "active" }, { id: expect.any(Number), org_id: 2, name: "Demo Hakaton", status: "active" }]);
      // the event id equals the old event row id, so nothing points anywhere new
      const evRow = db.prepare("SELECT id, org_id FROM event ORDER BY id").all();
      expect(events.map(e => ({ id: e.id, org_id: e.org_id }))).toEqual(evRow);
      for (const t of EVENT_TABLES) {
        const bad = db.prepare(`SELECT COUNT(*) n FROM ${t} x JOIN events e ON e.org_id = x.org_id WHERE x.event_id <> e.id`).get() as { n: number };
        expect(bad.n, t).toBe(0);
        expect((db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE event_id = 0`).get() as { n: number }).n, t).toBe(0);
      }
      for (const o of [1, 2]) {
        const repo = A.ctx.orgs.scope(o).repo;
        expect(adminResults(repo, cfg).results.ranking.map(r => [r.team.id, r.rank, r.score, r.n]), `org ${o}`).toEqual(orgsOut[o].ranking);
        expect(revealPublicView(repo)).toEqual(orgsOut[o].reveal);
        expect(repo.stage().show).toMatchObject({ slide: 2, scene: "team", eventPres: null });
        expect(repo.history().total).toBe((snapshot.score_history as Array<{ org_id: number }>).filter(r => r.org_id === o).length);
        expect(A.ctx.orgs.scope(o).teams.adminList()[0]).toMatchObject({ sessions: 1, link: { code: expect.any(String) }, presentation: { pages: 3 } });
      }
      expect(A.ctx.orgs.root.repo.stage()).toMatchObject({ eventName: "TechConnect Hakaton", team: { name: "Tusi Lab" } });
      // no placeholder teams were added to an existing database
      expect((db.prepare("SELECT COUNT(*) n FROM teams WHERE org_id=1").get() as { n: number }).n).toBe((snapshot.teams as Array<{ org_id: number }>).filter(t => t.org_id === 1).length);
    } finally { await A.close(); }
  });

  it("jurors' and teams' sessions from v9 still work after the upgrade", async () => {
    const { cfg } = await v9Database(path.join(tmp, "b"));
    const A = await buildApp(cfg);
    try {
      // a juror session is valid only for a juror of the organisation's active event: every v9 juror is one
      const db = A.ctx.orgs.db;
      for (const [sid, org] of [["sess-r", 1], ["sess-d", 2]] as const) {
        const s = db.prepare("SELECT u.event_id, u.org_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?").get(sid);
        expect(s).toEqual({ event_id: A.ctx.orgs.activeEventId(org), org_id: org });
      }
      const ts = db.prepare("SELECT ts.event_id, t.event_id AS team_event FROM team_sessions ts JOIN teams t ON t.id = ts.team_id").all() as Array<{ event_id: number; team_event: number }>;
      expect(ts.length).toBe(2);
      for (const r of ts) expect(r.event_id).toBe(r.team_event);
      expect(A.ctx.orgs.scope(2).trepo.sessionCount(A.ctx.orgs.scope(2).repo.teams()[0].id)).toBe(1);
    } finally { await A.close(); }
  });

  it("a failed upgrade rolls back completely (the v9 database stays as it was) and opens again later", async () => {
    const { cfg, snapshot } = await v9Database(path.join(tmp, "c"));
    const raw = new Database(cfg.dbFile);
    raw.exec("CREATE TABLE event_files (x INTEGER)"); // sabotage: v10 cannot create its table
    raw.close();
    expect(() => openDb(cfg.dbFile)).toThrow();
    const db = new Database(cfg.dbFile);
    expect(db.pragma("user_version", { simple: true })).toBe(9);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'events'").get()).toBeUndefined();
    for (const t of TABLES) expect(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(), t).toEqual(snapshot[t]);
    db.exec("DROP TABLE event_files");
    db.close();
    const ok = openDb(cfg.dbFile);
    expect(ok.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    ok.close();
  });
});
