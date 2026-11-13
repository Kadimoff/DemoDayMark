// v4: programs from backup files. Backups written by every earlier release (schema v7 … v11, frozen writers in
// test/fixtures/legacy-*) are listed with a summary (root only), and one program of a backup is imported into an
// organisation as a new ARCHIVED program: the ranking is the same as in the backup, nothing of the active program changes,
// the same program is never imported twice, a failure rolls back everything, imported jurors cannot sign in, and
// IMPORT_ARCHIVE_MATCH does the same once at start. A v11 live database opens as v12 (one new table) with a pre-v12 copy.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autoImport, importArchive, scanBackups } from "../server/archive.js";
import { buildApp, type App } from "../server/app.js";
import { loadConfig, type Config } from "../server/config.js";
import { openDb, SCHEMA_VERSION } from "../server/db.js";
import type { Repo } from "../server/repo.js";
import { adminResults } from "../server/views.js";
import { ensureBaseline as baseline8 } from "./fixtures/legacy-acf187a/baseline.js";
import { Repo as Repo8 } from "./fixtures/legacy-acf187a/repo.js";
import { TeamRepo as TeamRepo8 } from "./fixtures/legacy-acf187a/teamrepo.js";
import { ensureBaseline as baseline9, seedOrgEvent as seedOrg9 } from "./fixtures/legacy-537b462/baseline.js";
import { Repo as Repo9 } from "./fixtures/legacy-537b462/repo.js";
import { TeamRepo as TeamRepo9 } from "./fixtures/legacy-537b462/teamrepo.js";
import { ensureBaseline as baseline10 } from "./fixtures/legacy-468f2a0/baseline.js";
import { Repo as Repo10 } from "./fixtures/legacy-468f2a0/repo.js";
import { TeamRepo as TeamRepo10 } from "./fixtures/legacy-468f2a0/teamrepo.js";
import { ensureBaseline as baseline11 } from "./fixtures/legacy-e5464a2/baseline.js";
import { Repo as Repo11 } from "./fixtures/legacy-e5464a2/repo.js";
import { TeamRepo as TeamRepo11 } from "./fixtures/legacy-e5464a2/teamrepo.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-archive-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const cfgFor = (dataDir: string, extra: Partial<Config> = {}) => loadConfig({
  dataDir, dbFile: path.join(dataDir, "ignite.db"), backupDir: path.join(dataDir, "backups"), uploadsDir: path.join(dataDir, "uploads"),
  adminUsername: "admin", adminPassword: "admin-pass-123", origins: [], sessionSecret: "s", webDir: "/nonexistent", soffice: "", backupIntervalMs: 0, ...extra,
});

type AnyRepo = { db: Database.Database; teams(): Array<{ id: number }>; criteria(): Array<{ key: string; maxScore: number }>;
  createUser(role: "admin" | "juror", u: string, d: string, h: string): { id: number }; createInvite(id: number, h: string, ttl: number): unknown;
  upsertScore(j: number, t: number, v: Record<string, number>, total: null, note: string, tags: string[]): unknown;
  recordScore(k: "submit", j: number, t: number, v: Record<string, number>, total: null, note: string, tags: string[]): unknown;
  audit(a: number | null, action: string, p?: unknown): void };
type Ranking = Array<[string, number | null, number | null]>;
const rankOf = (repo: unknown, cfg: Config): Ranking => adminResults(repo as Repo, cfg).results.ranking.map(r => [r.team.name, r.rank, r.score]);

/** The "Ignite" program as a release wrote it: 4 named teams with entry scores, 3 jurors with QR invites and scores. */
function fill(repo: AnyRepo, tag: string, opts: { jurors?: number; files?: (teamId: number, i: number) => void } = {}) {
  const db = repo.db;
  const teams = repo.teams();
  const names = [`Pycore ${tag}`, `Tusi Lab ${tag}`, `Əkinçi AI ${tag}`, `Qala ${tag}`];
  names.forEach((n, i) => db.prepare("UPDATE teams SET name=?, project=?, entry_score=? WHERE id=?").run(n, `Layihə ${i + 1}`, 40 - i * 3, teams[i].id));
  const crit = repo.criteria();
  const jurors = Array.from({ length: opts.jurors ?? 3 }, (_, i) => repo.createUser("juror", `${tag}-j${i}`, `Münsif ${tag} ${i + 1}`, "x"));
  jurors.forEach(j => repo.createInvite(j.id, `hash-${tag}-${j.id}`, 3600_000));
  let k = 0;
  for (const j of jurors) for (const t of teams.slice(0, 4)) {
    k++;
    const values = Object.fromEntries(crit.map((c, ci) => [c.key, Math.max(1, Math.min(c.maxScore, ((k * 7 + ci * 3) % c.maxScore) + 1))]));
    repo.upsertScore(j.id, t.id, values, null, `qeyd ${k}`, ["Güclü komanda"]);
    repo.recordScore("submit", j.id, t.id, values, null, `qeyd ${k}`, ["Güclü komanda"]);
    repo.audit(j.id, "score.submit", { teamId: t.id, values });
  }
  opts.files?.(teams[0].id, 0);
  opts.files?.(teams[1].id, 1);
  return { teams: names, jurors: jurors.length, scores: k };
}

/** Writes a backup file with the frozen writer of the release that had schema `v`; returns the source ranking. */
async function writeBackup(v: 7 | 8 | 9 | 10 | 11, file: string, tag = `v${v}`, jurors = 3): Promise<{ ranking: Ranking; teams: string[]; scores: number; uploads: string[] }> {
  const dir = fs.mkdtempSync(path.join(tmp, "src-"));
  const cfg = cfgFor(dir);
  const db = openDb(path.join(dir, "ignite.db"), { upTo: v });
  expect(db.pragma("user_version", { simple: true })).toBe(v);
  const uploads: string[] = [];
  const addFiles = (trepo: { addFile: (f: any) => unknown }) => (teamId: number, i: number) => {
    const stored = `pres-${tag}-${i}`.padEnd(37, "0") + ".pdf";
    trepo.addFile({ teamId, kind: "presentation", stored, origName: `${tag}-${i}.pdf`, ext: "pdf", size: 10, pages: 2, conv: null, by: "team" });
    if (i === 0) uploads.push(stored); // the first one exists in uploads, the second one does not
  };
  let ranking: Ranking, out: ReturnType<typeof fill>;
  if (v <= 8) {
    const repo = new Repo8(db);
    await baseline8(repo, cfg);
    out = fill(repo as unknown as AnyRepo, tag, { jurors, files: v === 8 ? addFiles(new TeamRepo8(db, "s")) : undefined });
    db.prepare("UPDATE event SET name='Ignite', product='DemoDay', include_entry=1 WHERE id=1").run();
    ranking = rankOf(repo, cfg);
  } else if (v === 9) {
    const repo = new Repo9(db, 1, "root");
    await baseline9(repo, cfg);
    out = fill(repo as unknown as AnyRepo, tag, { jurors, files: addFiles(new TeamRepo9(db, "s", 1)) });
    db.prepare("UPDATE event SET name='Ignite', product='DemoDay', include_entry=1 WHERE org_id=1").run();
    ranking = rankOf(repo, cfg);
    // a second organisation with its own program
    db.prepare("INSERT INTO orgs (id, slug, name, created_at) VALUES (2, 'beta', 'Beta', 1700000000000)").run();
    const beta = new Repo9(db, 2, "beta");
    seedOrg9(beta, cfg, "Beta");
    ["A", "B", "C", "D"].forEach(n => beta.addTeam(n, ""));
    fill(beta as unknown as AnyRepo, "beta");
  } else {
    const Repo = v === 10 ? Repo10 : Repo11, TeamRepo = v === 10 ? TeamRepo10 : TeamRepo11;
    await (v === 10 ? baseline10 : baseline11)(db, cfg);
    const repo = new Repo(db, 1, "root");
    out = fill(repo as unknown as AnyRepo, tag, { jurors, files: addFiles(new TeamRepo(db, "s", 1, repo.eventId)) });
    db.prepare("UPDATE event SET name='Ignite', product='DemoDay', include_entry=1 WHERE org_id=1").run();
    ranking = rankOf(new Repo(db, 1, "root"), cfg);
    if (v === 11) {
      // the owner's story: Ignite was archived and the same database now runs "TechConnect"
      const now = Date.now();
      const row = db.prepare("SELECT * FROM event WHERE org_id = 1").get();
      db.prepare("UPDATE events SET status='archived', archived_at=?, settings_json=?, stats_json='{}', name='Ignite DemoDay' WHERE id=?").run(now, JSON.stringify(row), repo.eventId);
      db.prepare("INSERT INTO events (org_id, name, status, created_at) VALUES (1, 'TechConnect Hakaton', 'active', ?)").run(now);
      db.prepare("UPDATE event SET name='TechConnect', product='Hakaton', current_team_id=NULL WHERE org_id=1").run();
      const tc = new Repo11(db, 1, "root");
      tc.addCriterion({ key: "tc", name: "TC", description: "", maxScore: 10 });
      tc.addTeam("TC Komanda", "");
      expect(rankOf(new Repo11(db, 1, "root", repo.eventId), cfg)).toEqual(ranking);
    }
  }
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // a standalone file, like the nightly / pre-migration copies
  const d = new Database(path.join(dir, "ignite.db"));
  d.pragma("journal_mode = DELETE");
  d.close();
  fs.copyFileSync(path.join(dir, "ignite.db"), file);
  return { ranking, teams: out.teams, scores: out.scores, uploads };
}

const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];

describe("backups → archived programs (root)", () => {
  let A: App, base: string, cfg: Config, root: string, coord: string, other: string;
  const src: Record<number, Awaited<ReturnType<typeof writeBackup>>> = {};
  const post = (p: string, c?: string) => { const r = request(base).post(p).set("Origin", base); return c ? r.set("Cookie", c) : r; };
  const get = (p: string, c?: string) => (c ? request(base).get(p).set("Cookie", c) : request(base).get(p));
  const snapshot = () => Object.fromEntries(["events", "teams", "users", "criteria", "scores", "score_history", "juror_invites", "team_files", "audit_log", "archive_imports"]
    .map(t => [t, A.ctx.orgs.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));

  beforeAll(async () => {
    const dir = path.join(tmp, "live");
    cfg = cfgFor(dir);
    for (const v of [7, 8, 9, 10, 11] as const) src[v] = await writeBackup(v, path.join(cfg.backupDir, `demoday-v${v}.db`));
    fs.mkdirSync(cfg.uploadsDir, { recursive: true });
    for (const v of [8, 9, 10, 11]) for (const u of src[v].uploads) fs.writeFileSync(path.join(cfg.uploadsDir, u), "%PDF-1.4");
    fs.writeFileSync(path.join(cfg.backupDir, "broken.db"), "not a database");
    A = await buildApp(cfg);
    await A.app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(A.app.server.address() as { port: number }).port}`;
    root = cookieOf(await post("/api/auth/login").send({ username: "admin", password: "admin-pass-123" }));
    for (const slug of ["acme", "zeta"]) {
      const r = await post("/api/root/orgs", root).send({ slug, name: slug.toUpperCase(), coordinator: { username: `${slug}-coord`, password: "coord-pass-123" } });
      expect(r.status, r.body.error).toBe(200);
    }
    coord = cookieOf(await post("/api/auth/login").send({ username: "acme-coord", password: "coord-pass-123" }));
    other = cookieOf(await post("/api/auth/login").send({ username: "zeta-coord", password: "coord-pass-123" }));
  }, 120_000); // five migrated backups + argon2 logins: ~3 s here, but the Docker build host can be busy (load 6+ on 6 CPUs)
  afterAll(async () => { await A?.close(); });

  it("lists every backup with schema and program summary; root only, no scores or names of jurors", async () => {
    expect((await get("/api/root/backups")).status).toBe(401);
    expect((await get("/api/root/backups", coord)).status).toBe(403);
    const r = await get("/api/root/backups", root);
    expect(r.status).toBe(200);
    const files = r.body.files as Array<{ file: string; schema: number; ok: boolean; events: Array<Record<string, unknown>> }>;
    for (const v of [7, 8, 9, 10, 11]) {
      const f = files.find(x => x.file === `demoday-v${v}.db`)!;
      expect(f, `v${v}`).toBeTruthy();
      expect(f.ok, `v${v}`).toBe(true);
      expect(f.schema).toBe(v);
      const ig = f.events.find(e => e.name === "Ignite DemoDay")!;
      expect(ig, `v${v}`).toMatchObject({ brand: expect.stringMatching(/^Ignite/), teams: 8, jurors: 3, scores: 12, history: 12, status: v === 11 ? "archived" : "active", imported: false });
      expect(ig.lastScoreAt).toEqual(expect.any(Number));
    }
    expect(files.find(x => x.file === "demoday-v11.db")!.events.map(e => e.name)).toEqual(["Ignite DemoDay", "TechConnect Hakaton"]);
    expect(files.find(x => x.file === "demoday-v9.db")!.events.map(e => e.orgSlug)).toEqual(["root", "beta"]);
    expect(files.find(x => x.file === "broken.db")).toMatchObject({ ok: false, events: [] });
    expect(JSON.stringify(r.body)).not.toMatch(/Münsif v\d|values_json|password/);
    // the backup files themselves were not touched (read through temp copies)
    for (const v of [7, 8, 9, 10, 11]) {
      expect(fs.existsSync(path.join(cfg.backupDir, `demoday-v${v}.db-wal`))).toBe(false);
      const d = new Database(path.join(cfg.backupDir, `demoday-v${v}.db`), { readonly: true });
      expect(d.pragma("user_version", { simple: true })).toBe(v);
      d.close();
    }
  });

  it("refuses names outside the backup directory", async () => {
    for (const file of ["../ignite.db", "..%2Fignite.db", "/etc/passwd", "sub/x.db", ".hidden.db", "nope.db", "ignite.db-wal"]) {
      const r = await post("/api/root/backups/import", root).send({ file, sourceOrgId: 1, sourceEventId: 1, targetOrgId: 1 });
      expect(r.status, file).toBe(400);
    }
    expect((await post("/api/root/backups/import", coord).send({ file: "demoday-v7.db", sourceOrgId: 1, sourceEventId: 1, targetOrgId: 2 })).status).toBe(403);
  });

  it("imports the program of each schema (v7…v11) as an archived program with the same ranking; the active program is untouched", async () => {
    const acme = A.ctx.orgs.bySlug("acme")!;
    const activeBefore = A.ctx.orgs.activeEventId(acme.id);
    const acmeActive = () => ({ teams: A.ctx.orgs.scope(acme.id).repo.teams(), criteria: A.ctx.orgs.scope(acme.id).repo.criteria(), scores: A.ctx.orgs.scope(acme.id).repo.scores() });
    const before = acmeActive();
    const summary = (await get("/api/root/backups", root)).body.files as Array<{ file: string; events: Array<{ name: string; orgId: number; eventId: number }> }>;
    for (const v of [7, 8, 9, 10, 11]) {
      const ev = summary.find(f => f.file === `demoday-v${v}.db`)!.events.find(e => e.name === "Ignite DemoDay")!;
      const r = await post("/api/root/backups/import", root).send({ file: `demoday-v${v}.db`, sourceOrgId: ev.orgId, sourceEventId: ev.eventId, targetOrgId: acme.id, audit: true });
      expect(r.status, `v${v}: ${r.body.error}`).toBe(200);
      expect(r.body).toMatchObject({ name: "Ignite DemoDay", teams: 8, jurors: 3, scores: 12, history: 12, invites: 3, files: v >= 8 ? 2 : 0, filesMissing: v >= 8 ? 1 : 0 });
      expect(r.body.audit).toBeGreaterThanOrEqual(12);
      const res = await get(`/api/admin/events/${r.body.eventId}/results`, coord);
      expect(res.status).toBe(200);
      expect(res.body.meta).toMatchObject({ status: "archived", name: "Ignite DemoDay" });
      expect(res.body.results.ranking.map((x: any) => [x.team.name, x.rank, x.score]), `v${v}`).toEqual(src[v].ranking);
      expect(res.body.results.ranking.filter((x: any) => x.score != null).length).toBe(4);
      // the other organisation cannot read it
      expect((await get(`/api/admin/events/${r.body.eventId}/results`, other)).status).toBe(404);
    }
    expect(A.ctx.orgs.activeEventId(acme.id)).toBe(activeBefore);
    expect(acmeActive()).toEqual(before);
    const list = (await get("/api/admin/events", coord)).body as Array<{ status: string; name: string }>;
    expect(list.filter(e => e.status === "archived" && e.name === "Ignite DemoDay").length).toBe(5);
    expect(list.filter(e => e.status === "active").length).toBe(1);
    expect((await get("/api/root/backups", root)).body.imports.length).toBe(5);
  });

  it("imported jurors cannot sign in; their invites are revoked", async () => {
    const db = A.ctx.orgs.db;
    const jurors = db.prepare("SELECT u.* FROM users u JOIN events e ON e.id = u.event_id WHERE e.status = 'archived' AND u.role = 'juror'").all() as Array<{ id: number; username: string; password_hash: string }>;
    expect(jurors.length).toBe(15);
    for (const j of jurors.slice(0, 3)) {
      expect(j.password_hash).toBe("!archived");
      expect((await post("/api/auth/login").send({ username: j.username, password: "x" })).status).toBe(401);
    }
    const usable = db.prepare("SELECT COUNT(*) n FROM juror_invites i JOIN users u ON u.id = i.user_id JOIN events e ON e.id = u.event_id WHERE e.status = 'archived' AND i.revoked_at IS NULL").get() as { n: number };
    expect(usable.n).toBe(0);
    // no invite token of the backup matches any more (token hashes are replaced)
    expect((db.prepare("SELECT COUNT(*) n FROM juror_invites WHERE token_hash LIKE 'hash-%'").get() as { n: number }).n).toBe(0);
  });

  it("is idempotent: the same file + program again, or the same program from another file, is refused (409) and changes nothing", async () => {
    const acme = A.ctx.orgs.bySlug("acme")!;
    const before = snapshot();
    const ev = (await get("/api/root/backups", root)).body.files.find((f: any) => f.file === "demoday-v10.db").events[0];
    const again = await post("/api/root/backups/import", root).send({ file: "demoday-v10.db", sourceOrgId: ev.orgId, sourceEventId: ev.eventId, targetOrgId: acme.id });
    expect(again.status).toBe(409);
    expect(again.body.eventId).toEqual(expect.any(Number));
    fs.copyFileSync(path.join(cfg.backupDir, "demoday-v10.db"), path.join(cfg.backupDir, "copy-of-v10.db"));
    const copy = await post("/api/root/backups/import", root).send({ file: "copy-of-v10.db", sourceOrgId: ev.orgId, sourceEventId: ev.eventId, targetOrgId: acme.id });
    expect(copy.status).toBe(409);
    expect(snapshot()).toEqual(before);
    // the same program into another organisation is allowed (each organisation decides for itself)
    const zeta = A.ctx.orgs.bySlug("zeta")!;
    const z = await post("/api/root/backups/import", root).send({ file: "demoday-v10.db", sourceOrgId: ev.orgId, sourceEventId: ev.eventId, targetOrgId: zeta.id });
    expect(z.status, z.body.error).toBe(200);
    // a backup that already holds an imported program never offers it again
    fs.rmSync(path.join(cfg.backupDir, "copy-of-v10.db"));
  });

  it("a failure anywhere rolls the whole import back", async () => {
    const acme = A.ctx.orgs.bySlug("acme")!;
    const before = snapshot();
    const ev = (await get("/api/root/backups", root)).body.files.find((f: any) => f.file === "demoday-v9.db").events.find((e: any) => e.orgSlug === "beta");
    expect(() => importArchive(A.ctx.orgs.db, cfg, { file: "demoday-v9.db", sourceOrgId: ev.orgId, sourceEventId: ev.eventId, targetOrgId: acme.id, audit: true,
      beforeCommit: () => { throw new Error("boom"); } })).toThrow("boom");
    expect(snapshot()).toEqual(before);
    // and the same import works afterwards
    const ok = await post("/api/root/backups/import", root).send({ file: "demoday-v9.db", sourceOrgId: ev.orgId, sourceEventId: ev.eventId, targetOrgId: acme.id });
    expect(ok.status, ok.body.error).toBe(200);
    expect(ok.body.name).toBe("Beta Hakaton");
    expect(A.ctx.orgs.db.pragma("foreign_key_check")).toEqual([]);
    expect(A.ctx.orgs.db.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("a backup that contains an imported program does not offer it as a new one", async () => {
    const f = path.join(cfg.backupDir, "after-import.db");
    await A.ctx.orgs.db.backup(f);
    const files = scanBackups(cfg.backupDir);
    const evs = files.find(x => x.file === "after-import.db")!.events.filter(e => e.name === "Ignite DemoDay");
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.every(e => e.imported)).toBe(true);
    fs.rmSync(f);
  });
});

describe("IMPORT_ARCHIVE_MATCH", () => {
  it("imports the matching program with the most scores once at start; a restart does nothing; health reports it", async () => {
    const dir = path.join(tmp, "auto");
    const cfg = cfgFor(dir, { importArchiveMatch: "ignite" });
    // the live database: written by the previous release (v11), its program is TechConnect
    const live = openDb(cfg.dbFile, { upTo: 11 });
    await baseline11(live, cfg);
    live.prepare("UPDATE event SET name='TechConnect', product='Hakaton' WHERE org_id=1").run();
    const liveRepo = new Repo11(live, 1, "root");
    live.close();
    void liveRepo;
    const small = await writeBackup(8, path.join(cfg.backupDir, "pre-v9-2026-11-08.db"), "small", 2);
    const big = await writeBackup(9, path.join(cfg.backupDir, "demoday-2026-11-09.db"), "big", 3);
    fs.writeFileSync(path.join(cfg.backupDir, "junk.db"), "x");
    const A = await buildApp(cfg);
    try {
      // v11 → current: a pre-migration copy of the live database is kept
      expect(SCHEMA_VERSION).toBe(16);
      const pre = fs.readdirSync(cfg.backupDir).filter(n => n.startsWith(`pre-v${SCHEMA_VERSION}-`));
      expect(pre.length).toBe(1);
      const copy = new Database(path.join(cfg.backupDir, pre[0]), { readonly: true });
      expect(copy.pragma("user_version", { simple: true })).toBe(11);
      copy.close();
      const h = JSON.parse((await A.app.inject({ url: "/api/health" })).body);
      expect(fs.readdirSync(cfg.backupDir).some(n => n.startsWith("pre-import-")), JSON.stringify(h.archiveImport)).toBe(true);
      expect(h.archiveImport).toMatchObject({ match: "ignite", org: "root", status: "imported", event: "Ignite DemoDay", file: "demoday-2026-11-09.db", teams: 8, jurors: 3, scores: 12 });
      expect(h.warnings).toEqual([]);
      const ev = A.ctx.orgs.db.prepare("SELECT * FROM events WHERE org_id = 1 ORDER BY id").all() as Array<{ id: number; name: string; status: string }>;
      expect(ev.map(e => e.status)).toEqual(["active", "archived"]);
      expect(ev[1].name).toBe("Ignite DemoDay");
      const repo = A.ctx.orgs.eventRepo(1, ev[1].id)!;
      expect(rankOf(repo, cfg)).toEqual(big.ranking);
      expect(A.ctx.orgs.root.repo.getEvent().displayName).toBe("TechConnect Hakaton");
      void small;
    } finally { await A.close(); }
    const B = await buildApp(cfg);
    try {
      const h = JSON.parse((await B.app.inject({ url: "/api/health" })).body);
      expect(h.archiveImport).toMatchObject({ status: "already", event: "Ignite DemoDay" });
      expect((B.ctx.orgs.db.prepare("SELECT COUNT(*) n FROM events WHERE org_id = 1").get() as { n: number }).n).toBe(2);
    } finally { await B.close(); }
    // the log lines name what was scanned / imported
    const lines: string[] = [];
    const db = openDb(cfg.dbFile);
    const st = await autoImport(db, cfg, "ignite", "root", m => lines.push(m));
    expect(st.status).toBe("already");
    expect(lines.join("\n")).toMatch(/already imported into root/);
    db.close();
  });

  it("nothing matching: imports nothing, logs a summary of every scanned file, health warns", async () => {
    const dir = path.join(tmp, "auto2");
    const cfg = cfgFor(dir, { importArchiveMatch: "Nothing Like This" });
    await writeBackup(10, path.join(cfg.backupDir, "demoday.db"), "x");
    const lines: string[] = [];
    const db = openDb(cfg.dbFile);
    const st = await autoImport(db, cfg, cfg.importArchiveMatch, "root", m => lines.push(m));
    db.close();
    expect(st).toMatchObject({ status: "not-found", scanned: 1 });
    expect(lines[0]).toMatch(/no program matching "Nothing Like This" in 1 backup file/);
    expect(lines[1]).toMatch(/demoday\.db .*schema 10.*root\/#1 "Ignite DemoDay" teams=8 jurors=3 scores=12/);
    const A = await buildApp(cfg);
    try {
      const h = JSON.parse((await A.app.inject({ url: "/api/health" })).body);
      expect(h.archiveImport.status).toBe("not-found");
      expect(h.warnings).toContain("archive-import-not-found");
      expect((A.ctx.orgs.db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n).toBe(1);
    } finally { await A.close(); }
  });

  it("is off unless the env is set (and test/setup-env removes it from the deploy env)", async () => {
    expect(process.env.IMPORT_ARCHIVE_MATCH).toBeUndefined();
    expect(loadConfig().importArchiveMatch).toBe("");
  });
});
