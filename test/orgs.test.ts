// orgs (multi-tenant): an organisation's coordinator, jurors and teams never see or touch another organisation's
// event — REST, sockets, files, exports, QR / team links — the platform owner's API is root-only, the default
// organisation keeps the pre-orgs data, timers run independently, and the env bootstrap is idempotent.
import { verify } from "@node-rs/argon2";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { io as ioc, type Socket } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../server/app.js";
import { ARGON, hashPassword } from "../server/baseline.js";
import { bootstrapOrg } from "../server/bootstrap.js";
import { loadConfig } from "../server/config.js";
import { makePdf } from "./helpers/pdf.js";

let A: App;
let base: string;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-orgs-"));
const sockets: Socket[] = [];

const post = (p: string, cookie?: string) => { const r = request(base).post(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const patch = (p: string, cookie?: string) => { const r = request(base).patch(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const put = (p: string, cookie?: string) => { const r = request(base).put(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const del = (p: string, cookie?: string) => { const r = request(base).delete(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const get = (p: string, cookie?: string) => (cookie ? request(base).get(p).set("Cookie", cookie) : request(base).get(p));
const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
const upload = (p: string, cookie: string, name: string, body: Buffer) =>
  post(`${p}?kind=presentation`, cookie).set("Content-Type", "application/octet-stream").set("X-File-Name", encodeURIComponent(name)).send(body);

function socket(cookie: string | undefined, auth: Record<string, string> = {}) {
  const s = ioc(base, { transports: ["websocket"], extraHeaders: { origin: base, ...(cookie ? { cookie } : {}) }, auth, forceNew: true });
  sockets.push(s);
  return new Promise<Socket>((res, rej) => { s.on("connect", () => res(s)); s.on("connect_error", rej); });
}
const collect = (s: Socket, ev: string) => { const got: any[] = []; s.on(ev, p => got.push(p)); return got; };
const waitFor = <T = any>(s: Socket, ev: string, pred: (p: T) => boolean = () => true, ms = 1500) => new Promise<T>((res, rej) => {
  const t = setTimeout(() => rej(new Error(`no ${ev} within ${ms} ms`)), ms);
  const h = (p: T) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); res(p); } };
  s.on(ev, h);
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function login(username: string, password: string) {
  const r = await post("/api/auth/login").send({ username, password });
  expect(r.status, r.body.error).toBe(200);
  return cookieOf(r);
}
async function newJuror(adminCookie: string, name: string) {
  const r = await post("/api/admin/jurors", adminCookie).send({});
  expect(r.status).toBe(200);
  const c = await post(`/api/auth/invite/${r.body.invite.path.replace("/j/", "")}`).send({ displayName: name });
  expect(c.status).toBe(200);
  return { id: r.body.juror.id as number, cookie: cookieOf(c) };
}
async function teamSignIn(adminCookie: string, teamId: number) {
  const l = await post(`/api/admin/teams/${teamId}/link`, adminCookie).send({});
  expect(l.status).toBe(200);
  const r = await post(`/api/auth/team${l.body.path.slice(2)}`).send({});
  expect(r.status).toBe(200);
  return cookieOf(r);
}
const full = (crit: Array<{ key: string; maxScore: number }>, v: number) => ({ values: Object.fromEntries(crit.map(c => [c.key, Math.min(v, c.maxScore)])), note: "" });

// org 1 = root (platform owner's own event, placeholder teams), org "beta" = a customer
let root: string;
let beta: string;
let betaId: number;
let rootTeams: number[] = [];
let betaTeams: number[] = [];
let rootJuror: { id: number; cookie: string };
let betaJuror: { id: number; cookie: string };
let rootCrit: Array<{ id: number; key: string; maxScore: number }> = [];
let betaCrit: Array<{ id: number; key: string; maxScore: number }> = [];
let rootFile: number;
let betaFile: number;
let rootTeamCookie: string;
let betaTeamCookie: string;

beforeAll(async () => {
  A = await buildApp(loadConfig({
    dataDir: tmp, dbFile: ":memory:", uploadsDir: path.join(tmp, "uploads"), backupDir: path.join(tmp, "backups"), webDir: "/nonexistent",
    adminUsername: "admin", adminPassword: "admin-pass-123", origins: [], sessionSecret: "test-secret", soffice: "",
  }));
  await A.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(A.app.server.address() as AddressInfo).port}`;
  root = await login("admin", "admin-pass-123");
  const o = await post("/api/root/orgs", root).send({ slug: "beta", name: "Beta MMC", coordinator: { username: "beta", password: "beta-pass-123" } });
  expect(o.status, o.body.error).toBe(200);
  betaId = o.body.id;
  beta = await login("beta", "beta-pass-123");

  rootTeams = (await get("/api/admin/teams", root)).body.map((t: { id: number }) => t.id);
  for (const n of ["Beta Bir", "Beta İki"]) betaTeams.push((await post("/api/admin/teams", beta).send({ name: n })).body.id);
  rootJuror = await newJuror(root, "Kök Münsif");
  betaJuror = await newJuror(beta, "Beta Münsif");
  rootCrit = (await get("/api/admin/criteria", root)).body;
  betaCrit = (await get("/api/admin/criteria", beta)).body;
  rootTeamCookie = await teamSignIn(root, rootTeams[0]);
  betaTeamCookie = await teamSignIn(beta, betaTeams[0]);
  rootFile = (await upload("/api/team/files", rootTeamCookie, "kok.pdf", makePdf(2, "root"))).body.file.id;
  betaFile = (await upload("/api/team/files", betaTeamCookie, "beta.pdf", makePdf(3, "beta"))).body.file.id;
  expect((await put(`/api/juror/scores/${rootTeams[0]}`, rootJuror.cookie).send(full(rootCrit, 4))).status).toBe(200);
  expect((await put(`/api/juror/scores/${betaTeams[0]}`, betaJuror.cookie).send(full(betaCrit, 3))).status).toBe(200);
});
afterAll(async () => {
  sockets.forEach(s => s.close());
  await A.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a new organisation", () => {
  it("starts with an empty event: no teams, no jurors, the default rubric and durations, brand = its name", async () => {
    const r = await post("/api/root/orgs", root).send({ slug: "gamma", name: "Gamma" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ slug: "gamma", name: "Gamma", active: true, teams: 0, jurors: 0, scores: 0, coordinators: [],
      links: { stage: "/o/gamma/stage", reveal: "/o/gamma/reveal" } });
    const ev = A.ctx.orgs.scope(r.body.id).repo.getEvent();
    const def = A.ctx.orgs.root.repo;
    expect(ev).toMatchObject({ name: "Gamma", locked: false, currentTeamId: null });
    expect(ev.timer).toMatchObject({ pitchSec: 180, qaSec: 120, running: false });
    expect(A.ctx.orgs.scope(r.body.id).repo.criteria().map(c => [c.key, c.maxScore])).toEqual(
      (await import("../server/baseline.js")).DEFAULT_CRITERIA.map(c => [c.key, c.maxScore]));
    expect(def.criteria().length).toBeGreaterThan(0);
  });
  it("rejects reserved / duplicate slugs and taken usernames", async () => {
    expect((await post("/api/root/orgs", root).send({ slug: "root", name: "Xyz" })).status).toBe(400);
    expect((await post("/api/root/orgs", root).send({ slug: "Beta Ltd", name: "Xyz" })).status).toBe(400);
    expect((await post("/api/root/orgs", root).send({ slug: "beta", name: "Xyz" })).status).toBe(409);
    expect((await post("/api/root/orgs", root).send({ slug: "delta", name: "Delta", coordinator: { username: "ADMIN", password: "whatever-123" } })).status).toBe(409);
    expect(A.ctx.orgs.bySlug("delta")).toBeNull();
  });
  it("the coordinator signs in on the same /login and lands on its own /admin", async () => {
    const r = await post("/api/auth/login").send({ username: "beta", password: "beta-pass-123" });
    expect(r.body).toMatchObject({ role: "admin", redirect: "/admin" });
    const me = await get("/api/auth/me", beta);
    expect(me.body).toMatchObject({ isRoot: false, impersonating: false, org: { slug: "beta", name: "Beta MMC", root: false } });
    const st = await get("/api/admin/state", beta);
    expect(st.body.org).toMatchObject({ slug: "beta", name: "Beta MMC" });
    expect(st.body.teams.map((t: { name: string }) => t.name)).toEqual(["Beta Bir", "Beta İki"]);
    expect(st.body.jurors.map((j: { displayName: string }) => j.displayName)).toEqual(["Beta Münsif"]);
    expect((await get("/api/auth/session", beta)).body).toMatchObject({ admin: true, adminOrg: "beta", root: false });
  });
});

describe("isolation between organisations (coordinator of beta vs the default organisation)", () => {
  it("state, results, teams, jurors, criteria, sessions, history, audit and notices hold only its own rows", async () => {
    const st = (await get("/api/admin/state", beta)).body;
    expect(st.teams.every((t: { id: number }) => betaTeams.includes(t.id))).toBe(true);
    expect(st.scores.map((s: { teamId: number }) => s.teamId)).toEqual([betaTeams[0]]);
    expect(st.results.ranking.map((r: { team: { id: number } }) => r.team.id).sort()).toEqual([...betaTeams].sort());
    expect(st.sessions.every((s: { displayName: string }) => s.displayName !== "Kök Münsif" && s.displayName !== "Koordinator")).toBe(true);
    expect((await get("/api/admin/results", beta)).body.teams.length).toBe(2);
    expect((await get("/api/admin/jurors", beta)).body.map((j: { id: number }) => j.id)).toEqual([betaJuror.id]);
    expect((await get("/api/admin/criteria", beta)).body.map((c: { id: number }) => c.id).some((id: number) => rootCrit.some(c => c.id === id))).toBe(false);
    const h = (await get("/api/admin/history", beta)).body;
    expect(h.rows.map((r: { teamId: number }) => r.teamId)).toEqual([betaTeams[0]]);
    expect(h.jurors.map((j: { id: number }) => j.id)).toEqual([betaJuror.id]);
    const audit = (await get("/api/admin/audit", beta)).body as Array<{ payload: { teamId?: number } }>;
    expect(audit.some(a => a.payload?.teamId != null && rootTeams.includes(a.payload.teamId))).toBe(false);
    expect((await get("/api/admin/notices", beta)).body.map((n: { teamId: number }) => n.teamId)).toEqual([betaTeams[0]]);
    expect((await get("/api/admin/notices", root)).body.map((n: { teamId: number }) => n.teamId)).toEqual([rootTeams[0]]);
    expect((await get("/api/admin/materials", beta)).body.teams.map((t: { teamId: number }) => t.teamId).sort()).toEqual([...betaTeams].sort());
    // and the default organisation does not see beta either
    const rs = (await get("/api/admin/state", root)).body;
    expect(rs.teams.some((t: { id: number }) => betaTeams.includes(t.id))).toBe(false);
    expect(rs.jurors.some((j: { id: number }) => j.id === betaJuror.id)).toBe(false);
  });

  it("cannot change, delete, link, review or upload for another organisation's team", async () => {
    const t = rootTeams[1];
    expect((await patch(`/api/admin/teams/${t}`, beta).send({ name: "HACK" })).status).toBe(404);
    expect((await del(`/api/admin/teams/${t}?force=1`, beta)).status).toBe(404);
    expect((await post(`/api/admin/teams/${t}/link`, beta).send({})).status).toBe(404);
    expect((await get(`/api/admin/teams/${t}/link`, beta)).status).toBe(404);
    expect((await del(`/api/admin/teams/${t}/link`, beta)).status).toBe(404);
    expect((await post(`/api/admin/teams/${rootTeams[0]}/review`, beta).send({ action: "accept" })).status).toBe(404);
    expect((await post(`/api/admin/teams/${t}/approve`, beta).send({})).status).toBe(404);
    expect((await patch(`/api/admin/teams/${t}/materials`, beta).send({ members: ["x"] })).status).toBe(404);
    expect((await upload(`/api/admin/teams/${t}/files`, beta, "x.pdf", makePdf(1))).status).toBe(404);
    await post("/api/admin/teams/reorder", beta).send({ ids: [rootTeams[1], rootTeams[0], ...betaTeams] });
    expect(A.ctx.orgs.root.repo.team(rootTeams[1])).toMatchObject({ orderIndex: 1, name: expect.not.stringMatching("HACK") });
    expect((await put("/api/admin/final-order", beta).send({ ids: [rootTeams[0]] })).status).toBe(400);
    expect((await patch("/api/admin/event", beta).send({ currentTeamId: rootTeams[0] })).status).toBe(404);
  });

  it("cannot touch another organisation's jurors or criteria, and wiping its scores leaves the others", async () => {
    const j = rootJuror.id;
    expect((await post(`/api/admin/jurors/${j}/invite`, beta).send({})).status).toBe(404);
    expect((await patch(`/api/admin/jurors/${j}`, beta).send({ active: false })).status).toBe(404);
    expect((await del(`/api/admin/jurors/${j}?force=1`, beta)).status).toBe(404);
    expect((await post(`/api/admin/jurors/${j}/logout`, beta).send({})).body.closed).toBe(0);
    expect((await get("/api/juror/state", rootJuror.cookie)).status).toBe(200); // still signed in
    expect((await patch(`/api/admin/criteria/${rootCrit[0].id}`, beta).send({ name: "HACK" })).status).toBe(404);
    expect((await del(`/api/admin/criteria/${rootCrit[0].id}?force=1`, beta)).status).toBe(404);
    expect(A.ctx.orgs.root.repo.criteria()[0].name).not.toBe("HACK");
    // a throw-away organisation wipes its own scores only
    const o = await post("/api/root/orgs", root).send({ slug: "wipe", name: "Wipe", coordinator: { username: "wiper", password: "wipe-pass-123" } });
    const w = await login("wiper", "wipe-pass-123");
    const before = [A.ctx.orgs.root.repo.scoreCount(), A.ctx.orgs.scope(betaId).repo.scoreCount()];
    const tok = (await post("/api/admin/scores/wipe-token", w).send({})).body.token;
    expect((await del("/api/admin/scores", w).send({ token: tok })).body.deleted).toBe(0);
    expect([A.ctx.orgs.root.repo.scoreCount(), A.ctx.orgs.scope(betaId).repo.scoreCount()]).toEqual(before);
    expect(before.every(n => n > 0)).toBe(true);
    // another organisation's wipe token is not valid here
    const tok2 = (await post("/api/admin/scores/wipe-token", w).send({})).body.token;
    expect((await del("/api/admin/scores", beta).send({ token: tok2 })).status).toBe(400);
    expect(o.status).toBe(200);
  });

  it("exports (Excel / PDF) contain only the organisation's own teams and jurors", async () => {
    const x = await get("/api/admin/export.xlsx", beta).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on("data", c => b.push(c)); res.on("end", () => cb(null, Buffer.concat(b))); });
    expect(x.status).toBe(200);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body);
    const cells: string[] = [];
    wb.eachSheet(ws => ws.eachRow(r => r.eachCell(c => cells.push(String(c.value ?? "")))));
    const text = cells.join("|");
    expect(text).toContain("Beta Bir");
    expect(text).toContain("Beta Münsif");
    expect(text).not.toContain("Kök Münsif");
    expect(text).not.toMatch(/Komanda 1\b/);
    const pdf = await get("/api/admin/export.pdf", beta);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-disposition"]).toContain("Beta");
  });

  it("files: each organisation's admin, team and juror reach only that organisation's files", async () => {
    expect((await get(`/api/files/${betaFile}`, beta)).status).toBe(200);
    expect((await get(`/api/files/${rootFile}`, beta)).status).toBe(403);
    expect((await get(`/api/files/${betaFile}`, root)).status).toBe(403);
    expect((await get(`/api/files/${rootFile}`, root)).status).toBe(200);
    expect((await get(`/api/files/${rootFile}`, betaTeamCookie)).status).toBe(403);
    expect((await get(`/api/files/${rootFile}`, betaJuror.cookie)).status).toBe(403);
    expect((await get(`/api/files/${betaFile}`, betaJuror.cookie)).status).toBe(200);
    expect((await get(`/api/files/${betaFile}`, rootJuror.cookie)).status).toBe(403);
  });

  it("the platform owner's API answers 403 to a coordinator", async () => {
    const calls = [
      get("/api/root/orgs", beta), post("/api/root/orgs", beta).send({ slug: "evil", name: "Evil" }),
      patch(`/api/root/orgs/${betaId}`, beta).send({ name: "x" }), patch("/api/root/orgs/1", beta).send({ active: false }),
      post(`/api/root/orgs/${betaId}/coordinators`, beta).send({ username: "evil2", password: "evil-pass-123" }),
      post("/api/root/users/1/password", beta).send({ password: "evil-pass-123" }),
      patch("/api/root/users/1", beta).send({ active: false }),
      post("/api/root/impersonate", beta).send({ orgId: 1 }),
    ];
    for (const c of calls) expect((await c).status).toBe(403);
    expect((await get("/api/root/orgs", betaJuror.cookie)).status).toBe(403);
    expect((await get("/api/root/orgs")).status).toBe(401);
    expect(A.ctx.orgs.bySlug("evil")).toBeNull();
    // and the coordinator's session cannot pick another organisation with the impersonation cookie either
    const forged = `${beta}; ij_org=${encodeURIComponent(A.app.signCookie("1"))}`;
    expect((await get("/api/admin/state", forged)).body.org.slug).toBe("beta");
  });
});

describe("juror QR and team links work only inside their organisation", () => {
  it("a juror sees and scores only its organisation's teams", async () => {
    const st = (await get("/api/juror/state", betaJuror.cookie)).body;
    expect(st.teams.map((t: { id: number }) => t.id).sort()).toEqual([...betaTeams].sort());
    expect(st.criteria.map((c: { id: number }) => c.id)).toEqual(betaCrit.map(c => c.id));
    expect(st.myScores.map((s: { teamId: number }) => s.teamId)).toEqual([betaTeams[0]]);
    expect((await put(`/api/juror/scores/${rootTeams[1]}`, betaJuror.cookie).send(full(betaCrit, 2))).status).toBe(404);
    expect((await put(`/api/juror/scores/${betaTeams[1]}`, rootJuror.cookie).send(full(rootCrit, 2))).status).toBe(404);
    const s = await socket(betaJuror.cookie, { role: "juror" });
    const r: any = await s.timeout(3000).emitWithAck("score:submit", { teamId: rootTeams[1], ...full(betaCrit, 2) });
    expect([r.ok, r.status]).toEqual([false, 404]);
    expect(A.ctx.orgs.root.repo.scoresOf(betaJuror.id)).toEqual([]);
  });
  it("the QR landing names the juror's own event; a team link signs into its own organisation", async () => {
    const inv = await post(`/api/admin/jurors/${betaJuror.id}/invite`, beta).send({});
    expect((await get(`/api/auth/invite/${inv.body.invite.path.replace("/j/", "")}`)).body.eventName).toBe("Beta MMC Hakaton");
    const l = await post(`/api/admin/teams/${betaTeams[1]}/link`, beta).send({});
    expect((await get(`/api/auth/team${l.body.path.slice(2)}`)).body).toMatchObject({ teamName: "Beta İki", eventName: "Beta MMC Hakaton" });
    const tc = cookieOf(await post(`/api/auth/team${l.body.path.slice(2)}`).send({}));
    const ts = (await get("/api/team/state", tc)).body;
    expect(ts.team.name).toBe("Beta İki");
    expect(ts.event.displayName).toBe("Beta MMC Hakaton");
    expect(ts.queue.total).toBe(2);
  });
  it("open registration goes to the organisation named in the URL", async () => {
    await patch("/api/admin/settings/teams", beta).send({ teamRegistration: true });
    expect((await get("/api/team/registration?org=beta")).body).toMatchObject({ open: true, eventName: "Beta MMC Hakaton" });
    expect((await get("/api/team/registration")).body.open).toBe(false); // default organisation: still closed
    expect((await post("/api/team/register").send({ name: "Sızan" })).status).toBe(403);
    const r = await post("/api/team/register?org=beta").send({ name: "Beta Üç" });
    expect(r.status).toBe(200);
    expect(A.ctx.orgs.scope(betaId).repo.team(r.body.teamId)?.approval).toBe("pending");
    expect(A.ctx.orgs.root.repo.team(r.body.teamId)).toBeNull();
    expect((await get("/api/team/registration?org=nope")).status).toBe(404);
  });
});

describe("realtime: rooms per organisation", () => {
  it("admin and public sockets get only their organisation's events", async () => {
    const rootAdmin = await socket(root, { role: "admin" });
    const betaAdmin = await socket(beta, { role: "admin" });
    const betaPublic = await socket(undefined, { org: "beta" });
    const rootPublic = await socket(undefined);
    const betaGot = { score: collect(betaAdmin, "score:upserted"), results: collect(betaAdmin, "results:changed"), presence: collect(betaAdmin, "presence:changed"), notice: collect(betaAdmin, "notice") };
    const betaStage = collect(betaPublic, "stage:changed");
    const betaTimer = collect(betaPublic, "timer:changed");
    // the default organisation's juror scores, a team uploads, the stage changes
    const got = waitFor(rootAdmin, "score:upserted");
    expect((await put(`/api/juror/scores/${rootTeams[2]}`, rootJuror.cookie).send(full(rootCrit, 5))).status).toBe(200);
    await got;
    await upload("/api/team/files", rootTeamCookie, "yeni.pdf", makePdf(1));
    const st = waitFor(rootPublic, "stage:changed");
    await patch("/api/admin/event", root).send({ currentTeamId: rootTeams[2] });
    await st;
    const tm = waitFor(rootPublic, "timer:changed");
    await patch("/api/admin/event", root).send({ timer: "pitch" });
    await tm;
    await sleep(150);
    expect(betaGot.score).toEqual([]);
    expect(betaGot.results).toEqual([]);
    expect(betaGot.notice).toEqual([]);
    expect(betaStage).toEqual([]);
    expect(betaTimer).toEqual([]);
    expect(betaGot.presence.flat().every((p: { jurorId: number }) => p.jurorId === betaJuror.id)).toBe(true);
    // and the other way round
    const rootGot = collect(rootAdmin, "score:upserted");
    const rootStage = collect(rootPublic, "stage:changed");
    const bs = waitFor(betaPublic, "stage:changed");
    await patch("/api/admin/event", beta).send({ currentTeamId: betaTeams[1] });
    const s0 = await bs;
    expect(s0.team.name).toBe("Beta İki");
    const bsc = waitFor(betaAdmin, "score:upserted");
    await put(`/api/juror/scores/${betaTeams[1]}`, betaJuror.cookie).send(full(betaCrit, 2));
    await bsc;
    await sleep(150);
    expect(rootGot).toEqual([]);
    expect(rootStage).toEqual([]);
  });
  it("an admin on another organisation's projector page joins only that page's public room", async () => {
    const s = await socket(root, { role: "admin", org: "beta" });
    const adminFeed = collect(s, "score:upserted");
    const stage = collect(s, "stage:changed");
    await put(`/api/juror/scores/${rootTeams[3]}`, rootJuror.cookie).send(full(rootCrit, 3));
    const bs = waitFor(s, "stage:changed");
    await patch("/api/admin/event", beta).send({ timer: "reset" });
    await patch("/api/admin/stage", beta).send({ slide: 2 });
    await bs;
    await sleep(100);
    expect(adminFeed).toEqual([]);
    expect(stage.every(p => p.eventName === "Beta MMC Hakaton")).toBe(true);
  });
});

describe("timer and stage of two organisations run at the same time, independently", () => {
  it("starting, pausing and adjusting one timer leaves the other as it was", async () => {
    await patch("/api/admin/event", root).send({ currentTeamId: rootTeams[0] });
    await patch("/api/admin/event", root).send({ timer: "pitch" });
    await patch("/api/admin/event", beta).send({ currentTeamId: betaTeams[0] });
    const r0 = (await get("/api/stage")).body;
    const b0 = (await get("/api/stage?org=beta")).body;
    expect(r0.timer.running).toBe(true);
    expect(b0.timer.running).toBe(false);
    expect([r0.team.id, b0.team.id]).toEqual([rootTeams[0], betaTeams[0]]);
    await patch("/api/admin/event", root).send({ timer: "pause" });
    const rPaused = (await get("/api/stage")).body;
    await patch("/api/admin/event", beta).send({ timer: "pitch" });
    await patch("/api/admin/event", beta).send({ timerAdd: 60 });
    const r1 = (await get("/api/stage")).body;
    const b1 = (await get("/api/stage?org=beta")).body;
    expect(r1.timer.running).toBe(false);
    expect(b1.timer.running).toBe(true);
    expect(r1.timer).toEqual(rPaused.timer); // beta's start and +60 s did not move root's clock
    expect(b1.timer.anchorAt).not.toBeNull();
    expect(b1.timer.offsetSec).not.toBe(r1.timer.offsetSec);
    expect(b1.eventName).toBe("Beta MMC Hakaton");
    expect((await get("/api/stage?org=nope")).status).toBe(404);
    // the public stage file is the one of the organisation's team on stage
    expect(b1.show.pres.url).toContain("org=beta");
    const pdf = await get(b1.show.pres.url);
    expect(pdf.status).toBe(200);
    expect(Number(pdf.headers["content-length"] ?? pdf.body.length)).toBe(makePdf(3, "beta").length);
    expect((await get(r1.show.pres.url)).status).toBe(200);
    // reveal state is per organisation too
    expect((await get("/api/reveal?org=beta")).body.eventName).toBe("Beta MMC Hakaton");
  });
});

describe("platform owner: impersonation, deactivation, passwords", () => {
  it("root can act in another organisation's panel and switch back", async () => {
    const r = await post("/api/root/impersonate", root).send({ orgId: betaId });
    expect(r.status).toBe(200);
    const org = (r.headers["set-cookie"] as unknown as string[]).find(c => c.startsWith("ij_org="))!.split(";")[0];
    const both = `${root}; ${org}`;
    expect((await get("/api/admin/state", both)).body.org.slug).toBe("beta");
    expect((await get("/api/auth/me", both)).body).toMatchObject({ impersonating: true, org: { slug: "beta" } });
    expect((await get("/api/auth/session", both)).body.adminOrg).toBe("beta");
    expect((await get("/api/admin/state", root)).body.org.slug).toBe("root");
    const back = await post("/api/root/impersonate", both).send({ orgId: null });
    expect((back.headers["set-cookie"] as unknown as string[]).some(c => c.startsWith("ij_org=;"))).toBe(true);
  });
  it("deactivating an organisation signs out its people and closes its public screens; reactivating restores", async () => {
    const o = await post("/api/root/orgs", root).send({ slug: "off", name: "Off", coordinator: { username: "offc", password: "off-pass-123" } });
    const c = await login("offc", "off-pass-123");
    expect((await patch("/api/root/orgs/1", root).send({ active: false })).status).toBe(400);
    expect((await patch(`/api/root/orgs/${o.body.id}`, root).send({ active: false })).body.active).toBe(false);
    expect((await get("/api/admin/state", c)).status).toBe(401);
    expect((await post("/api/auth/login").send({ username: "offc", password: "off-pass-123" })).status).toBe(403);
    expect((await get("/api/stage?org=off")).status).toBe(404);
    await patch(`/api/root/orgs/${o.body.id}`, root).send({ active: true });
    expect((await post("/api/auth/login").send({ username: "offc", password: "off-pass-123" })).status).toBe(200);
  });
  it("root resets a coordinator's password (sessions end); everyone changes their own", async () => {
    const o = (await get("/api/root/orgs", root)).body.find((x: { slug: string }) => x.slug === "beta");
    const id = o.coordinators[0].id;
    const old = await login("beta", "beta-pass-123");
    expect((await post(`/api/root/users/${id}/password`, root).send({ password: "short" })).status).toBe(400);
    expect((await post("/api/root/users/1/password", root).send({ password: "root-reset-123" })).status).toBe(404); // not for root itself
    expect((await post(`/api/root/users/${id}/password`, root).send({ password: "beta-new-pass-1" })).status).toBe(200);
    expect((await get("/api/admin/state", old)).status).toBe(401);
    beta = await login("beta", "beta-new-pass-1");
    expect((await post("/api/auth/password", beta).send({ current: "wrong-pass-1", next: "beta-own-pass-1" })).status).toBe(400);
    expect((await post("/api/auth/password", beta).send({ current: "beta-new-pass-1", next: "beta-own-pass-1" })).status).toBe(200);
    expect((await get("/api/admin/state", beta)).status).toBe(200); // the current session stays
    beta = await login("beta", "beta-own-pass-1");
    const r2 = await login("admin", "admin-pass-123");
    expect((await post("/api/auth/password", r2).send({ current: "admin-pass-123", next: "admin-pass-456" })).status).toBe(200);
    expect((await post("/api/auth/login").send({ username: "admin", password: "admin-pass-123" })).status).toBe(401);
    expect((await post("/api/auth/password", betaJuror.cookie).send({ current: "x", next: "yyyyyyyyy" })).status).toBe(403);
  });
});

describe("BOOTSTRAP_* env", () => {
  const env = async (over: Partial<{ slug: string; name: string; username: string; hashB64: string }> = {}) =>
    ({ slug: "demo", name: "Demo", username: "demo", hashB64: Buffer.from(await hashPassword("demo-pass-123")).toString("base64"), ...over });
  it("creates the organisation and its coordinator once; later starts change nothing (no password overwrite)", async () => {
    const e = await env();
    expect(bootstrapOrg(A.ctx.orgs, A.ctx.cfg, () => {}, e)).toBe("created");
    const org = A.ctx.orgs.bySlug("demo")!;
    expect(org.name).toBe("Demo");
    const u = A.ctx.orgs.root.repo.userByUsername("demo")!;
    expect([u.role, u.org_id, u.is_root]).toEqual(["admin", org.id, 0]);
    expect(await verify(u.password_hash, "demo-pass-123")).toBe(true);
    const audit = A.ctx.orgs.scope(org.id).repo.auditLog().map(a => a.action);
    expect(audit).toEqual(expect.arrayContaining(["org.create", "coordinator.create"]));
    // the coordinator changes the password; the next start (even with another hash in env) leaves it alone
    const c = await login("demo", "demo-pass-123");
    expect((await post("/api/auth/password", c).send({ current: "demo-pass-123", next: "demo-mine-123" })).status).toBe(200);
    const before = A.ctx.orgs.root.repo.userByUsername("demo")!.password_hash;
    expect(bootstrapOrg(A.ctx.orgs, A.ctx.cfg, () => {}, await env({ hashB64: Buffer.from(await hashPassword("other-pass-123")).toString("base64") }))).toBe("unchanged");
    expect(A.ctx.orgs.root.repo.userByUsername("demo")!.password_hash).toBe(before);
    expect(A.ctx.orgs.list().filter(o => o.slug === "demo").length).toBe(1);
    expect((await get("/api/admin/state", await login("demo", "demo-mine-123"))).body.org.slug).toBe("demo");
  });
  it("never takes over the platform owner's or another organisation's username", async () => {
    const warns: string[] = [];
    const rootHash = A.ctx.orgs.root.repo.userByUsername("admin")!.password_hash;
    expect(bootstrapOrg(A.ctx.orgs, A.ctx.cfg, m => warns.push(m), await env({ slug: "rootish", username: "admin" }))).toBe("conflict");
    expect(bootstrapOrg(A.ctx.orgs, A.ctx.cfg, m => warns.push(m), await env({ slug: "other", username: "beta" }))).toBe("conflict");
    expect(A.ctx.orgs.bySlug("rootish")).toBeNull();
    expect(A.ctx.orgs.bySlug("other")).toBeNull();
    expect(A.ctx.orgs.root.repo.userByUsername("admin")!).toMatchObject({ password_hash: rootHash, is_root: 1, org_id: 1 });
    expect(warns.length).toBe(2);
    expect(warns.join(" ")).not.toMatch(/\$argon2/);
  });
  it("ignores incomplete or invalid settings", async () => {
    expect(bootstrapOrg(A.ctx.orgs, A.ctx.cfg, () => {}, null)).toBe("off");
    expect(bootstrapOrg(A.ctx.orgs, A.ctx.cfg, () => {}, await env({ slug: "x1", username: "x1", hashB64: Buffer.from("plain-password").toString("base64") }))).toBe("invalid");
    expect(bootstrapOrg(A.ctx.orgs, A.ctx.cfg, () => {}, await env({ slug: "root", username: "x2" }))).toBe("invalid");
    expect(bootstrapOrg(A.ctx.orgs, A.ctx.cfg, () => {}, await env({ username: "" }))).toBe("invalid");
    expect(A.ctx.orgs.bySlug("x1")).toBeNull();
  });
  it("scripts/hash-password.mjs reads the password from stdin and uses the server's argon2 parameters", async () => {
    const out = execFileSync(process.execPath, [path.resolve("scripts/hash-password.mjs")], { input: "Demo-Parol-2026\n", env: { PATH: process.env.PATH ?? "" } }).toString().trim();
    const h = Buffer.from(out, "base64").toString("utf8");
    expect(h).toMatch(new RegExp(`^\\$argon2id\\$v=19\\$m=${ARGON.memoryCost},t=${ARGON.timeCost},p=${ARGON.parallelism}\\$`));
    expect(await verify(h, "Demo-Parol-2026")).toBe(true);
    expect(out).not.toContain("Demo-Parol");
    expect(() => execFileSync(process.execPath, [path.resolve("scripts/hash-password.mjs")], { input: "short", stdio: "pipe" })).toThrow();
  });
});
