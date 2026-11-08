// v11 reliability: nothing a juror sends is lost or applied twice, and the live state survives a server restart.
//  - op ids: the same op 5 times (socket and HTTP) → applied once, one history row;
//  - scoring closed → the op is refused with a clear message and kept (with its values) in score_ops; later it can go in;
//  - restart: stage, scene, slides, timer (running, by the server clock) and reveal step come back the same; screens'
//    sockets reconnect by themselves; a score whose answer was lost in the restart is not applied twice;
//  - the phone outbox against the real server: 3 scores while offline → online → each written exactly once;
//  - periodic online backup + restore on the next start; health answer; quick_check at start.
import Database from "better-sqlite3";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { io as ioc, type Socket } from "socket.io-client";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../server/app.js";
import { BackupScheduler, listBackups, RESTORE_REQUEST, verifyDbFile } from "../server/backups.js";
import { loadConfig, type Config } from "../server/config.js";
import { openDb, quickCheck } from "../server/db.js";
import { timerPosition } from "../shared/timer.js";
import { Outbox, type ScoreOp, type SendResult } from "../web/src/lib/outbox.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-rel-"));
const sockets: Socket[] = [];
const apps: App[] = [];
afterAll(async () => {
  for (const s of sockets) s.close();
  for (const a of apps) await a.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise<number>(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
const cfgFor = (dir: string, extra: Partial<Config> = {}) => loadConfig({
  dataDir: dir, dbFile: path.join(dir, "ignite.db"), backupDir: path.join(dir, "backups"), uploadsDir: path.join(dir, "uploads"),
  adminUsername: "admin", adminPassword: "admin-pass-123", origins: [], sessionSecret: "rel-secret", webDir: "/nonexistent", soffice: "",
  backupIntervalMs: 0, ...extra,
});
async function start(dir: string, port = 0, extra: Partial<Config> = {}) {
  const A = await buildApp(cfgFor(dir, extra));
  apps.push(A);
  await A.app.listen({ port, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(A.app.server.address() as AddressInfo).port}`;
  return { A, base };
}
async function stop(A: App) { await A.close(); apps.splice(apps.indexOf(A), 1); }

const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
function client(base: string) {
  const post = (p: string, c?: string) => { const r = request(base).post(p).set("Origin", base); return c ? r.set("Cookie", c) : r; };
  const put = (p: string, c?: string) => { const r = request(base).put(p).set("Origin", base); return c ? r.set("Cookie", c) : r; };
  const patch = (p: string, c?: string) => { const r = request(base).patch(p).set("Origin", base); return c ? r.set("Cookie", c) : r; };
  const get = (p: string, c?: string) => (c ? request(base).get(p).set("Cookie", c) : request(base).get(p));
  return { post, put, patch, get };
}
async function adminCookie(base: string) {
  const r = await client(base).post("/api/auth/login").send({ username: "admin", password: "admin-pass-123" });
  expect(r.status, r.body.error).toBe(200);
  return cookieOf(r);
}
async function newJuror(base: string, admin: string, name: string) {
  const c = client(base);
  const r = await c.post("/api/admin/jurors", admin).send({});
  const j = await c.post(`/api/auth/invite/${r.body.invite.path.replace("/j/", "")}`).send({ displayName: name });
  expect(j.status, j.body.error).toBe(200);
  return { id: r.body.juror.id as number, cookie: cookieOf(j) };
}
function sock(base: string, cookie?: string, auth: Record<string, string> = {}, opts: Record<string, unknown> = {}) {
  const s = ioc(base, { transports: ["websocket"], extraHeaders: { origin: base, ...(cookie ? { cookie } : {}) }, auth, forceNew: true, ...opts });
  sockets.push(s);
  return new Promise<Socket>((res, rej) => { s.once("connect", () => res(s)); s.once("connect_error", rej); });
}
const fullValues = (crit: Array<{ key: string; maxScore: number }>, v: number) => Object.fromEntries(crit.map(c => [c.key, Math.min(v, c.maxScore)]));

describe("idempotent score ops", () => {
  it("the same op 5 times (socket + HTTP) is applied once: one score, one history row, one op record", async () => {
    const { A, base } = await start(path.join(tmp, "idem"));
    const c = client(base);
    const admin = await adminCookie(base);
    const j = await newJuror(base, admin, "Aysel");
    const crit = (await c.get("/api/admin/criteria", admin)).body as Array<{ key: string; maxScore: number }>;
    const team = (await c.get("/api/admin/teams", admin)).body[0].id as number;
    const s = await sock(base, j.cookie, { role: "juror" });
    const body = { values: fullValues(crit, 4), note: "yaxşı", tags: [], opId: "op-idem-000001", clientAt: Date.now() };
    const acks: any[] = [];
    for (let i = 0; i < 3; i++) acks.push(await s.timeout(5000).emitWithAck("score:submit", { teamId: team, ...body }));
    for (let i = 0; i < 2; i++) { const r = await c.put(`/api/juror/scores/${team}`, j.cookie).send(body); expect(r.status).toBe(200); acks.push({ ok: true, score: r.body }); }
    expect(acks.every(a => a.ok)).toBe(true);
    expect(acks[0].score.duplicate).toBeUndefined();
    expect(acks.slice(1).every(a => a.score.duplicate === true)).toBe(true);
    expect(new Set(acks.map(a => a.score.updatedAt)).size).toBe(1);
    const db = A.ctx.orgs.db;
    expect(db.prepare("SELECT COUNT(*) n FROM score_history WHERE juror_id = ? AND team_id = ?").get(j.id, team)).toEqual({ n: 1 });
    expect(db.prepare("SELECT status, tries FROM score_ops WHERE juror_id = ?").all(j.id)).toEqual([{ status: "applied", tries: 1 }]);
    expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action IN ('score.submit','score.update') AND actor_id = ?").get(j.id)).toEqual({ n: 1 });
    // a new op for the same team is a real update
    const r2 = await s.timeout(5000).emitWithAck("score:submit", { teamId: team, ...body, values: fullValues(crit, 5), opId: "op-idem-000002" });
    expect(r2.ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM score_history WHERE juror_id = ?").get(j.id)).toEqual({ n: 2 });
    // an old client without op ids still works (no dedupe, plain upsert)
    const r3 = await c.put(`/api/juror/scores/${team}`, j.cookie).send({ values: fullValues(crit, 3), note: "" });
    expect(r3.status).toBe(200);
    await stop(A);
  });

  it("scoring closed: the op is refused with a clear message, kept with its values, and goes in once scoring reopens", async () => {
    const { A, base } = await start(path.join(tmp, "lock"));
    const c = client(base);
    const admin = await adminCookie(base);
    const j = await newJuror(base, admin, "Kamran");
    const crit = (await c.get("/api/admin/criteria", admin)).body as Array<{ key: string; maxScore: number }>;
    const team = (await c.get("/api/admin/teams", admin)).body[1].id as number;
    expect((await c.patch("/api/admin/event", admin).send({ locked: true })).status).toBe(200);
    const body = { values: fullValues(crit, 2), note: "bağlı ikən", tags: [], opId: "op-locked-00001" };
    const r = await c.put(`/api/juror/scores/${team}`, j.cookie).send(body);
    expect(r.status).toBe(423);
    expect(r.body.error).toMatch(/bağla/);
    const db = A.ctx.orgs.db;
    const row = db.prepare("SELECT status, http_status, values_json, note FROM score_ops WHERE op_id = ?").get("op-locked-00001") as any;
    expect(row).toMatchObject({ status: "rejected", http_status: 423, note: "bağlı ikən" });
    expect(JSON.parse(row.values_json)).toEqual(body.values);
    expect(A.ctx.orgs.root.repo.rejectedOps()[0]).toMatchObject({ opId: "op-locked-00001", jurorName: "Kamran", values: body.values });
    expect(db.prepare("SELECT COUNT(*) n FROM scores WHERE juror_id = ?").get(j.id)).toEqual({ n: 0 });
    await c.patch("/api/admin/event", admin).send({ locked: false });
    const again = await c.put(`/api/juror/scores/${team}`, j.cookie).send(body);
    expect(again.status).toBe(200);
    expect(db.prepare("SELECT status, tries FROM score_ops WHERE op_id = ?").get("op-locked-00001")).toEqual({ status: "applied", tries: 2 });
    await stop(A);
  });
});

describe("group commit (ScoreWriter)", () => {
  it("parallel submits share one transaction; a failing submit does not take the others down", async () => {
    const { A, base } = await start(path.join(tmp, "batch"));
    const admin = await adminCookie(base);
    const jurors = await Promise.all([1, 2, 3, 4, 5].map(i => newJuror(base, admin, `Paralel ${i}`)));
    const sc = A.ctx.orgs.root;
    const crit = sc.repo.criteria();
    const teams = sc.repo.teams().slice(0, 6);
    const writer = A.ctx.rt.writer;
    const broken = Object.create(sc.repo) as typeof sc.repo;
    broken.upsertScore = () => { throw new Error("disk says no"); };
    const jobs: Array<Promise<unknown>> = [];
    for (const j of jurors) for (const t of teams) jobs.push(writer.submit(sc.repo, sc.rt, j.id, t.id, { values: fullValues(crit, 3), opId: `batch-${j.id}-${t.id}` }));
    const bad = writer.submit(broken, sc.rt, jurors[0].id, teams[0].id, { values: fullValues(crit, 9), opId: "batch-broken-01" });
    const res = await Promise.all(jobs) as Array<{ ok: boolean }>;
    await expect(bad).rejects.toThrow("disk says no");
    expect(res.every(r => r.ok)).toBe(true);
    const db = A.ctx.orgs.db;
    expect(db.prepare("SELECT COUNT(*) n FROM scores").get()).toEqual({ n: 30 });
    expect(db.prepare("SELECT COUNT(*) n FROM score_history").get()).toEqual({ n: 30 });
    expect(db.prepare("SELECT COUNT(*) n FROM score_ops WHERE op_id = 'batch-broken-01'").get()).toEqual({ n: 0 });
    // the broken submit's values never reached the table (its savepoint was rolled back)
    expect(db.prepare("SELECT values_json FROM scores WHERE juror_id = ? AND team_id = ?").get(jurors[0].id, teams[0].id)).toEqual({ values_json: JSON.stringify(fullValues(crit, 3)) });
    await stop(A);
  });
});

describe("server restart", () => {
  it("stage, scene, slides, the running timer and the reveal step are the same after a restart; screens reconnect by themselves", async () => {
    const dir = path.join(tmp, "restart");
    const port = await freePort();
    let { A, base } = await start(dir, port);
    let c = client(base);
    let admin = await adminCookie(base);
    const teams = (await c.get("/api/admin/teams", admin)).body as Array<{ id: number }>;
    await c.patch("/api/admin/event", admin).send({ currentTeamId: teams[2].id });
    await c.patch("/api/admin/event", admin).send({ timer: "pitch", timerAdd: -20 });
    await c.patch("/api/admin/stage", admin).send({ mode: "timer", slide: 4 });
    const before = (await c.get("/api/stage")).body;
    expect(before.timer.running).toBe(true);
    const reveal = A.ctx.orgs.root.repo.getReveal();
    // projector screen, reconnecting the way the browser does (backoff ≤ 1 s here)
    const screen = await sock(base, undefined, {}, { reconnectionDelay: 100, reconnectionDelayMax: 500 });
    let reconnects = 0;
    screen.on("connect", () => { reconnects++; });
    await stop(A);
    await sleep(300);
    ({ A, base } = await start(dir, port));
    c = client(base);
    const after = (await c.get("/api/stage")).body;
    expect({ ...after, serverNow: 0 }).toEqual({ ...before, serverNow: 0 });
    // the timer kept running by the server clock while the server was down
    expect(timerPosition(after.timer, after.serverNow)).toBeGreaterThan(timerPosition(before.timer, before.serverNow));
    expect(A.ctx.orgs.root.repo.getReveal()).toEqual(reveal);
    // the screen is back without anyone touching it and gets the next timer change
    const deadline = Date.now() + 8000;
    while (!reconnects && Date.now() < deadline) await sleep(50);
    expect(reconnects).toBe(1);
    admin = await adminCookie(base);
    const got = new Promise<any>(res => screen.once("timer:changed", res));
    await c.patch("/api/admin/event", admin).send({ timer: "pause" });
    expect((await got).timer.running).toBe(false);
    await stop(A);
  });

  it("a score whose answer was lost in a restart is sent again (same op id) and not applied twice", async () => {
    const dir = path.join(tmp, "restart-op");
    let { A, base } = await start(dir);
    let c = client(base);
    const admin = await adminCookie(base);
    const j = await newJuror(base, admin, "Leyla");
    const crit = (await c.get("/api/admin/criteria", admin)).body as Array<{ key: string; maxScore: number }>;
    const team = (await c.get("/api/admin/teams", admin)).body[0].id as number;
    const body = { values: fullValues(crit, 3), note: "", tags: [], opId: "op-restart-0001" };
    expect((await c.put(`/api/juror/scores/${team}`, j.cookie).send(body)).status).toBe(200);
    // the server dies right after committing; the phone never saw the answer
    await stop(A);
    ({ A, base } = await start(dir));
    c = client(base);
    const r = await c.put(`/api/juror/scores/${team}`, j.cookie).send(body);
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(true);
    expect(A.ctx.orgs.db.prepare("SELECT COUNT(*) n FROM score_history WHERE juror_id = ?").get(j.id)).toEqual({ n: 1 });
    await stop(A);
  });
});

describe("phone outbox against the real server", () => {
  it("3 scores entered offline go in exactly once each when the connection is back", async () => {
    const { A, base } = await start(path.join(tmp, "outbox"));
    const c = client(base);
    const admin = await adminCookie(base);
    const j = await newJuror(base, admin, "Nigar");
    const crit = (await c.get("/api/admin/criteria", admin)).body as Array<{ key: string; maxScore: number }>;
    const teams = ((await c.get("/api/admin/teams", admin)).body as Array<{ id: number }>).slice(0, 3);
    const s = ioc(base, { transports: ["websocket"], extraHeaders: { origin: base, cookie: j.cookie }, auth: { role: "juror" }, forceNew: true, autoConnect: false });
    sockets.push(s);
    const send = async (op: ScoreOp): Promise<SendResult> => {
      if (!s.connected) return { ok: false, kind: "network" };
      try {
        const r = await s.timeout(5000).emitWithAck("score:submit", { teamId: op.teamId, ...op.body, opId: op.opId });
        return r.ok ? { ok: true, score: r.score } : r.status >= 500 ? { ok: false, kind: "network" } : { ok: false, kind: "rejected", status: r.status, error: r.error };
      } catch { return { ok: false, kind: "network" }; }
    };
    const ob = new Outbox({ storage: null, key: "k", send, minDelay: 50, maxDelay: 200 });
    teams.forEach((t, i) => ob.enqueue(t.id, { values: fullValues(crit, i + 2), note: "", tags: [] }));
    await sleep(150);
    expect(ob.size).toBe(3);
    expect(A.ctx.orgs.db.prepare("SELECT COUNT(*) n FROM scores WHERE juror_id = ?").get(j.id)).toEqual({ n: 0 });
    await new Promise<void>(res => { s.once("connect", () => res()); s.connect(); });
    ob.resume();
    const deadline = Date.now() + 8000;
    while (ob.size && Date.now() < deadline) await sleep(30);
    expect(ob.size).toBe(0);
    const db = A.ctx.orgs.db;
    expect(db.prepare("SELECT COUNT(*) n FROM scores WHERE juror_id = ?").get(j.id)).toEqual({ n: 3 });
    expect(db.prepare("SELECT COUNT(*) n FROM score_history WHERE juror_id = ?").get(j.id)).toEqual({ n: 3 });
    expect(db.prepare("SELECT COUNT(*) n FROM score_ops WHERE juror_id = ? AND status = 'applied'").get(j.id)).toEqual({ n: 3 });
    ob.close();
    await stop(A);
  });
});

describe("backups, restore, health, integrity", () => {
  it("periodic online backups are verified, skipped when nothing changed and rotated to the newest N", async () => {
    const dir = path.join(tmp, "bk");
    const db = openDb(path.join(dir, "ignite.db"));
    db.exec("CREATE TABLE IF NOT EXISTS t (x)");
    const bs = new BackupScheduler(db, path.join(dir, "backups"), { intervalMs: 60_000, keep: 2 });
    const f1 = await bs.run();
    expect(f1 && verifyDbFile(f1).ok).toBe(true);
    expect(await bs.run()).toBeNull(); // nothing changed
    for (let i = 0; i < 3; i++) { db.prepare("INSERT INTO t VALUES (?)").run(i); await sleep(5); expect(await bs.run()).not.toBeNull(); }
    const auto = listBackups(path.join(dir, "backups"), /^auto-/);
    expect(auto.length).toBe(2); // standalone files: no -wal / -shm next to them
    expect(bs.status()).toMatchObject({ count: 2, lastError: null });
    expect(fs.readdirSync(path.join(dir, "backups")).some(n => n.endsWith(".part"))).toBe(false);
    db.close();
  });

  it("restore on the next start: the database comes back as it was in the backup; the replaced one is kept", async () => {
    const dir = path.join(tmp, "restore");
    let { A, base } = await start(dir);
    let c = client(base);
    let admin = await adminCookie(base);
    await c.post("/api/admin/teams", admin).send({ name: "Qalan komanda", project: "" });
    const f = await A.ctx.sys.backups.run(true);
    expect(f).toBeTruthy();
    await c.post("/api/admin/teams", admin).send({ name: "Səhv əlavə", project: "" });
    await stop(A);
    fs.writeFileSync(path.join(dir, RESTORE_REQUEST), JSON.stringify({ file: path.basename(f!) }));
    ({ A, base } = await start(dir));
    c = client(base);
    admin = await adminCookie(base);
    const names = ((await c.get("/api/admin/teams", admin)).body as Array<{ name: string }>).map(t => t.name);
    expect(names).toContain("Qalan komanda");
    expect(names).not.toContain("Səhv əlavə");
    expect(fs.existsSync(path.join(dir, RESTORE_REQUEST))).toBe(false);
    const pre = listBackups(path.join(dir, "backups"), /^pre-restore-/);
    expect(pre.length).toBe(1);
    const old = new Database(path.join(dir, "backups", pre[0].name), { readonly: true });
    expect(old.prepare("SELECT COUNT(*) n FROM teams WHERE name = 'Səhv əlavə'").get()).toEqual({ n: 1 });
    old.close();
    await stop(A);
  });

  it("/api/health: liveness numbers only (no paths or secrets); /api/root/system for the platform owner", async () => {
    const { A, base } = await start(path.join(tmp, "health"), 0, { backupIntervalMs: 60_000 });
    const c = client(base);
    const s = await sock(base);
    const h = await c.get("/api/health");
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ ok: true, schema: 13, db: { ok: true, integrity: "ok" }, backup: { enabled: true }, warnings: [] });
    expect(h.body.sockets).toBeGreaterThanOrEqual(1);
    expect(typeof h.body.uptimeSec).toBe("number");
    expect(h.body.eventLoopLagMs).toHaveProperty("p99");
    const txt = JSON.stringify(h.body);
    expect(txt).not.toMatch(/ddm-rel|backups|ignite\.db|rel-secret|admin/);
    expect((await c.get("/api/root/system")).status).toBe(401);
    const admin = await adminCookie(base);
    const sys = await c.get("/api/root/system", admin);
    expect(sys.status).toBe(200);
    expect(sys.body).toMatchObject({ memoryMb: { rss: expect.any(Number) }, orgs: [{ id: 1, ops: { applied: 0, rejected: 0 } }] });
    const b = await c.post("/api/root/backup", admin).send({});
    expect(b.status).toBe(200);
    expect(b.body.backup.lastAt).toBeGreaterThan(0);
    s.close();
    await stop(A);
  });

  it("quick_check at start reports a damaged database in health (the server still starts)", async () => {
    const dir = path.join(tmp, "corrupt");
    const cfg = cfgFor(dir);
    // a database with a table + index big enough to have its own pages
    const db = openDb(cfg.dbFile);
    db.exec("CREATE TABLE junk (id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX junk_v ON junk(v);");
    const ins = db.prepare("INSERT INTO junk (v) VALUES (?)");
    db.transaction(() => { for (let i = 0; i < 3000; i++) ins.run(`value-${i}-${"x".repeat(40)}`); })();
    const idxRoot = (db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'junk_v'").get() as { rootpage: number }).rootpage;
    const pageSize = db.pragma("page_size", { simple: true }) as number;
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    // scribble over the index's root page (data pages stay readable, the structure check fails)
    const fd = fs.openSync(cfg.dbFile, "r+");
    fs.writeSync(fd, Buffer.alloc(pageSize - 200, 0x5a), 0, pageSize - 200, (idxRoot - 1) * pageSize + 100);
    fs.closeSync(fd);
    const raw = new Database(cfg.dbFile);
    expect(quickCheck(raw).ok).toBe(false);
    raw.close();
    const { A, base } = await start(dir);
    const h = await client(base).get("/api/health");
    expect(h.body.db.integrity).toBe("error");
    expect(h.body.warnings).toContain("db-integrity");
    await stop(A);
  });
});
