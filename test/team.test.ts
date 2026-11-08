// munsif: team sign-in links, team panel isolation, uploads (limits, magic bytes, permissions), review notifications,
// open registration, queue reminders, the public stage file and slide sync across stage screens.
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { io as ioc, type Socket } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { fakePptx, makePdf } from "./helpers/pdf.js";

let A: App;
let base: string;
let admin: string;
let juror: string;
let teamIds: number[] = [];
const sockets: Socket[] = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-team-"));

const post = (p: string, cookie?: string) => { const r = request(base).post(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const patch = (p: string, cookie?: string) => { const r = request(base).patch(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const get = (p: string, cookie?: string) => (cookie ? request(base).get(p).set("Cookie", cookie) : request(base).get(p));
const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
const upload = (p: string, cookie: string, name: string, body: Buffer, kind = "presentation") =>
  post(`${p}?kind=${kind}`, cookie).set("Content-Type", "application/octet-stream").set("X-File-Name", encodeURIComponent(name)).send(body);

function socket(cookie: string | undefined, role?: string) {
  const s = ioc(base, { transports: ["websocket"], extraHeaders: { origin: base, ...(cookie ? { cookie } : {}) }, auth: role ? { role } : {}, forceNew: true });
  sockets.push(s);
  return new Promise<Socket>((res, rej) => { s.on("connect", () => res(s)); s.on("connect_error", rej); });
}
const waitFor = <T = any>(s: Socket, ev: string, pred: (p: T) => boolean = () => true, ms = 1500) => new Promise<T>((res, rej) => {
  const t = setTimeout(() => rej(new Error(`no ${ev} within ${ms} ms`)), ms);
  const h = (p: T) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); res(p); } };
  s.on(ev, h);
});
const collect = (s: Socket, ev: string) => { const got: any[] = []; s.on(ev, p => got.push(p)); return got; };

async function teamLogin(teamId: number) {
  const l = await post(`/api/admin/teams/${teamId}/link`, admin).send({});
  expect(l.status).toBe(200);
  expect(l.body.path).toMatch(/^\/t\/[A-Z2-9]{12}$/);
  const r = await post(`/api/auth/team${l.body.path.slice(2)}`).send({});
  expect(r.status).toBe(200);
  expect(r.body.redirect).toBe("/team");
  return { cookie: cookieOf(r), code: l.body.code as string, path: l.body.path as string };
}
let teamA: { cookie: string; code: string; path: string };
let teamB: { cookie: string; code: string; path: string };

beforeAll(async () => {
  const web = path.join(tmp, "web");
  fs.mkdirSync(path.join(web, "landing", "en"), { recursive: true });
  fs.writeFileSync(path.join(web, "login.html"), "<!doctype html><title>login</title>");
  fs.writeFileSync(path.join(web, "team.html"), "<!doctype html><title>team</title>");
  fs.writeFileSync(path.join(web, "landing", "index.html"), "<!doctype html><html lang=\"az\"><title>munsif</title>Təqdimatlarınız münsifim ilə qiymətləndirilir.");
  fs.writeFileSync(path.join(web, "landing", "en", "index.html"), "<!doctype html><html lang=\"en\"><title>munsif</title>");
  A = await buildApp(loadConfig({
    dataDir: tmp, dbFile: ":memory:", uploadsDir: path.join(tmp, "uploads"), backupDir: path.join(tmp, "backups"), webDir: web,
    adminUsername: "admin", adminPassword: "admin-pass-123", origins: [], sessionSecret: "test-secret", soffice: "", maxUploadBytes: 64 * 1024,
  }));
  await A.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(A.app.server.address() as AddressInfo).port}`;
  admin = cookieOf(await post("/api/auth/login").send({ username: "admin", password: "admin-pass-123" }));
  const j = await post("/api/admin/jurors", admin).send({});
  juror = cookieOf(await post(`/api/auth/invite/${j.body.invite.path.replace("/j/", "")}`).send({ displayName: "Əli Məmmədov" }));
  teamIds = (await get("/api/admin/teams", admin)).body.map((t: { id: number }) => t.id);
  teamA = await teamLogin(teamIds[0]);
  teamB = await teamLogin(teamIds[1]);
});
afterAll(async () => {
  sockets.forEach(s => s.close());
  await A.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("landing and sessions", () => {
  it("serves the munsif landing at / (AZ) and /en/ (EN) to everybody", async () => {
    const az = await get("/");
    expect(az.status).toBe(200);
    expect(az.text).toContain("münsifim ilə");
    expect((await get("/en/")).text).toContain('lang="en"');
    expect((await get("/", admin)).status).toBe(200);
  });
  it("/api/auth/session never answers 401 and names the right panel", async () => {
    expect((await get("/api/auth/session")).body).toEqual({ admin: false, juror: false, team: false, panel: null, adminOrg: null, root: false });
    expect((await get("/api/auth/session", admin)).body.panel).toBe("/root"); // v3: the platform owner's own panel
    expect((await get("/api/auth/session", juror)).body.panel).toBe("/juror");
    expect((await get("/api/auth/session", teamA.cookie)).body.panel).toBe("/team");
  });
});

describe("team sign-in links", () => {
  it("accepts the code as a link, typed with dashes or in lower case; a new link replaces the old one", async () => {
    expect((await get(`/api/auth/team/${teamA.path.slice(3)}`)).body).toMatchObject({ valid: true, teamName: "Komanda 1" });
    const typed = await post("/api/auth/team-code").send({ code: teamA.code.toLowerCase() });
    expect(typed.status).toBe(200);
    expect((await post("/api/auth/team-code").send({ code: `${base}${teamA.path}` })).status).toBe(200);
    const again = await post(`/api/admin/teams/${teamIds[0]}/link`, admin).send({});
    expect((await post(`/api/auth/team${teamA.path.slice(2)}`).send({})).status).toBe(410);
    teamA = { ...teamA, code: again.body.code, path: again.body.path };
    // Sessions opened before survive a new link; the admin sees the current code again.
    expect((await get("/api/team/state", teamA.cookie)).status).toBe(200);
    expect((await get(`/api/admin/teams/${teamIds[0]}/link`, admin)).body.code).toBe(again.body.code);
  });
  it("revoking the link ends the team's sessions", async () => {
    const c = await teamLogin(teamIds[3]);
    expect((await get("/api/team/state", c.cookie)).status).toBe(200);
    expect((await request(base).delete(`/api/admin/teams/${teamIds[3]}/link`).set("Origin", base).set("Cookie", admin)).body.sessions).toBe(1);
    expect((await get("/api/team/state", c.cookie)).status).toBe(401);
  });
  it("rate-limits wrong codes per IP", async () => {
    for (let i = 0; i < 5; i++) expect((await post("/api/auth/team-code").send({ code: "AAAA-BBBB-CCCC" })).status).toBe(410);
    expect((await post("/api/auth/team-code").send({ code: teamB.code })).status).toBe(429);
    A.ctx.limiter.success(A.ctx.limiter.key("127.0.0.1", "team-code"));
  });
});

describe("team isolation (privacy)", () => {
  it("a team session gets only its own team, never scores, results or other teams", async () => {
    const st = await get("/api/team/state", teamA.cookie);
    expect(st.status).toBe(200);
    expect(st.body.team.id).toBe(teamIds[0]);
    const txt = JSON.stringify(st.body);
    for (const k of ["ranking", "results", "scores", "values", "entryScore", "Komanda 2"]) expect(txt, k).not.toContain(k);
    for (const p of ["/api/admin/state", "/api/admin/results", "/api/admin/materials", "/api/admin/export.xlsx", "/api/admin/history", "/api/juror/state"]) {
      expect([401, 403], p).toContain((await get(p, teamA.cookie)).status);
    }
    expect((await patch("/api/admin/stage", teamA.cookie).send({ delta: 1 })).status).toBe(401);
  });
  it("other roles cannot use the team API", async () => {
    expect((await get("/api/team/state")).status).toBe(401);
    expect((await get("/api/team/state", admin)).status).toBe(401);
    expect((await get("/api/team/state", juror)).status).toBe(401);
  });
  it("a team socket never receives score events", async () => {
    const ts = await socket(teamA.cookie, "team");
    const got = collect(ts, "score:upserted");
    const crit = (await get("/api/juror/state", juror)).body.criteria as Array<{ key: string; maxScore: number }>;
    const r = await request(base).put(`/api/juror/scores/${teamIds[0]}`).set("Origin", base).set("Cookie", juror)
      .send({ values: Object.fromEntries(crit.map(c => [c.key, Math.min(4, c.maxScore)])), note: "" });
    expect(r.status).toBe(200);
    await new Promise(r2 => setTimeout(r2, 300));
    expect(got).toEqual([]);
  });
});

describe("uploads", () => {
  let fileA = 0;
  it("accepts a PDF, counts its slides and notifies the admin in real time", async () => {
    const as = await socket(admin, "admin");
    const note = waitFor<{ title: string; teamId: number }>(as, "notice", n => n.teamId === teamIds[0]);
    const r = await upload("/api/team/files", teamA.cookie, "Pitch dek ə.pdf", makePdf(3));
    expect(r.status).toBe(200);
    expect(r.body.file).toMatchObject({ kind: "presentation", ext: "pdf", pages: 3, viewable: true, name: "Pitch dek ə.pdf" });
    expect(r.body.state.materials.review).toBe("submitted");
    fileA = r.body.file.id;
    expect((await note).title).toBe("Komanda 1 prezentasiya yüklədi");
    const stored = fs.readdirSync(path.join(tmp, "uploads")).filter(n => n.endsWith(".pdf"));
    expect(stored.length).toBe(1);
    expect(stored[0]).toMatch(/^pres-[a-f0-9]{32}\.pdf$/);
    expect(fs.statSync(path.join(tmp, "uploads", stored[0])).mode & 0o777).toBe(0o600);
  });
  it("rejects wrong content, wrong extensions and files over the limit", async () => {
    expect((await upload("/api/team/files", teamA.cookie, "fake.pdf", Buffer.from("MZ not a pdf at all, really"))).status).toBe(415);
    expect((await upload("/api/team/files", teamA.cookie, "virus.exe", makePdf(1))).status).toBe(415);
    expect((await upload("/api/team/files", teamA.cookie, "big.pdf", Buffer.concat([makePdf(1), Buffer.alloc(70 * 1024, 32)]))).status).toBe(413);
    expect((await upload("/api/team/files", teamA.cookie, "logo.png", makePdf(1), "logo")).status).toBe(415);
    expect(fs.readdirSync(path.join(tmp, "uploads", "tmp")).filter(n => n.endsWith(".part"))).toEqual([]);
  });
  it("keeps versions; PPTX without LibreOffice is kept and flagged", async () => {
    const r = await upload("/api/team/files", teamB.cookie, "deck.pptx", fakePptx());
    expect(r.status).toBe(200);
    expect(r.body.file).toMatchObject({ ext: "pptx", conv: "unavailable", viewable: false });
    expect(r.body.state.soffice).toBe(false);
    const v2 = await upload("/api/team/files", teamB.cookie, "deck-v2.pdf", makePdf(2));
    expect(v2.body.state.history.map((f: { name: string; active: boolean }) => [f.name, f.active])).toEqual([["deck-v2.pdf", true], ["deck.pptx", false]]);
  });
  it("files: own team and admin only; jurors when allowed; others 403, anonymous 401", async () => {
    expect((await get(`/api/files/${fileA}`, teamA.cookie)).status).toBe(200);
    expect((await get(`/api/files/${fileA}`, teamA.cookie)).headers["content-type"]).toBe("application/pdf");
    expect((await get(`/api/files/${fileA}`, teamB.cookie)).status).toBe(403);
    expect((await get(`/api/files/${fileA}`)).status).toBe(401);
    expect((await get(`/api/files/${fileA}`, admin)).status).toBe(200);
    expect((await get(`/api/files/${fileA}`, juror)).status).toBe(200);
    const js = await get("/api/juror/state", juror);
    expect(js.body.materials.find((m: { teamId: number }) => m.teamId === teamIds[0]).presentation.url).toBe(`/api/files/${fileA}`);
    await patch("/api/admin/settings/teams", admin).send({ jurorsSeeMaterials: false });
    expect((await get(`/api/files/${fileA}`, juror)).status).toBe(403);
    expect((await get("/api/juror/state", juror)).body.materials).toBeNull();
    await patch("/api/admin/settings/teams", admin).send({ jurorsSeeMaterials: true });
  });
  it("closes uploads after the deadline unless the team got an extension", async () => {
    await patch("/api/admin/settings/teams", admin).send({ uploadDeadline: Date.now() - 1000 });
    expect((await upload("/api/team/files", teamA.cookie, "late.pdf", makePdf(1))).status).toBe(403);
    expect((await patch("/api/team/profile", teamA.cookie).send({ siteUrl: "https://example.org" })).status).toBe(403);
    await patch(`/api/admin/teams/${teamIds[0]}/materials`, admin).send({ extendUntil: Date.now() + 60_000 });
    expect((await upload("/api/team/files", teamA.cookie, "late.pdf", makePdf(2))).status).toBe(200);
    await patch("/api/admin/settings/teams", admin).send({ uploadDeadline: null });
  });
});

describe("review and notifications", () => {
  it("accept / return (with a reason) reach the team's socket", async () => {
    const ts = await socket(teamA.cookie, "team");
    const others = collect(await socket(teamB.cookie, "team"), "notice");
    expect((await post(`/api/admin/teams/${teamIds[0]}/review`, admin).send({ action: "return" })).status).toBe(400);
    const back = waitFor<{ title: string; body: string }>(ts, "notice", n => n.title.includes("geri"));
    expect((await post(`/api/admin/teams/${teamIds[0]}/review`, admin).send({ action: "return", note: "Son slayd boşdur" })).body.review).toBe("returned");
    expect((await back).body).toBe("Son slayd boşdur");
    const ok = waitFor<{ title: string }>(ts, "notice", n => n.title === "Prezentasiyanız qəbul edildi");
    expect((await post(`/api/admin/teams/${teamIds[0]}/review`, admin).send({ action: "accept" })).body.review).toBe("accepted");
    await ok;
    const st = await get("/api/team/state", teamA.cookie);
    expect(st.body.notices[0].title).toBe("Prezentasiyanız qəbul edildi");
    await new Promise(r => setTimeout(r, 150));
    expect(others.filter(n => n.teamId === teamIds[0])).toEqual([]);
  });
  it("names and links: renaming needs the coordinator's permission", async () => {
    expect((await patch("/api/team/profile", teamA.cookie).send({ name: "Yeni ad" })).status).toBe(403);
    const r = await patch("/api/team/profile", teamA.cookie).send({ members: ["Aysel", "Rəşad"], siteUrl: "https://example.org", videoUrl: "" });
    expect(r.status).toBe(200);
    expect(r.body.materials.members).toEqual(["Aysel", "Rəşad"]);
    expect((await patch("/api/team/profile", teamA.cookie).send({ siteUrl: "javascript:alert(1)" })).status).toBe(400);
    await patch("/api/admin/settings/teams", admin).send({ teamCanRename: true });
    expect((await patch("/api/team/profile", teamA.cookie).send({ name: "Komanda Bir", project: "Layihə" })).body.team.name).toBe("Komanda Bir");
    await patch("/api/admin/settings/teams", admin).send({ teamCanRename: false });
  });
  it("tells teams on stage changes: invited, next, and 'sıranız yaxınlaşır' with two teams ahead", async () => {
    const c = await teamLogin(teamIds[2]);
    const s3 = await socket(c.cookie, "team");
    const soon = waitFor<{ title: string }>(s3, "notice", n => n.title === "Sıranız yaxınlaşır");
    const ts = await socket(teamA.cookie, "team");
    const invite = waitFor<{ title: string }>(ts, "notice", n => n.title === "Səhnəyə dəvət olunursunuz");
    await patch("/api/admin/event", admin).send({ currentTeamId: teamIds[0] });
    await soon; await invite;
  });
});

describe("open registration", () => {
  it("is off by default; when on, a team registers and waits for approval outside every list", async () => {
    expect((await post("/api/team/register").send({ name: "Startap X" })).status).toBe(403);
    await patch("/api/admin/settings/teams", admin).send({ teamRegistration: true });
    const as = await socket(admin, "admin");
    const note = waitFor<{ title: string }>(as, "notice", n => n.title === "Yeni komanda: Startap X");
    const r = await post("/api/team/register").send({ name: "Startap X", project: "AI" });
    expect(r.status).toBe(200);
    await note;
    const cookie = cookieOf(r);
    const st = await get("/api/team/state", cookie);
    expect(st.body.materials.approval).toBe("pending");
    expect(st.body.team.active).toBe(false);
    expect((await get("/api/juror/state", juror)).body.teams.map((t: { name: string }) => t.name)).not.toContain("Startap X");
    expect((await post("/api/team/register").send({ name: "startap x" })).status).toBe(409);
    expect((await post(`/api/admin/teams/${r.body.teamId}/approve`, admin).send({})).status).toBe(200);
    expect((await get("/api/juror/state", juror)).body.teams.map((t: { name: string }) => t.name)).toContain("Startap X");
    await patch("/api/admin/settings/teams", admin).send({ teamRegistration: false });
  });
});

describe("presentation stage", () => {
  it("the public stage file is only the presentation of the team on stage", async () => {
    await patch("/api/admin/event", admin).send({ currentTeamId: teamIds[1] });
    const st = (await get("/api/stage")).body;
    expect(st.show.pres).toMatchObject({ pages: 2 });
    const pdf = await get(st.show.pres.url);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    const b = await get(`/api/files/${st.show.pres.fileId}`, teamA.cookie);
    expect(b.status).toBe(403); // team A cannot fetch team B's file by id, even while B is on stage
    await patch("/api/admin/event", admin).send({ currentTeamId: teamIds[4] });
    expect((await get("/api/stage")).body.show.pres).toBeNull();
    expect((await get("/api/stage/presentation")).status).toBe(404);
  });
  it("slide changes reach every stage screen, are clamped to the deck, and reset with a new team", async () => {
    await patch("/api/admin/event", admin).send({ currentTeamId: teamIds[0] });
    const s1 = await socket(undefined), s2 = await socket(undefined);
    const p1 = waitFor<any>(s1, "stage:changed", s => s.show.slide === 2);
    const p2 = waitFor<any>(s2, "stage:changed", s => s.show.slide === 2);
    const r = await patch("/api/admin/stage", admin).send({ delta: 1 });
    expect(r.body.stage.show.slide).toBe(2);
    await Promise.all([p1, p2]);
    expect((await patch("/api/admin/stage", admin).send({ slide: 99 })).body.stage.show.slide).toBe(2); // 2-page deck
    expect((await patch("/api/admin/stage", admin).send({ delta: -5 })).body.stage.show.slide).toBe(1);
    await patch("/api/admin/stage", admin).send({ slide: 2, mode: "site", intro: true });
    const st = (await get("/api/stage")).body.show;
    expect(st).toMatchObject({ slide: 2, mode: "site", site: { url: "https://example.org" } });
    expect(st.introAt).toBeGreaterThan(Date.now() - 5000);
    expect((await patch("/api/admin/stage", juror).send({ delta: 1 })).status).toBe(403);
    expect((await patch("/api/admin/stage").send({ delta: 1 })).status).toBe(401);
    expect((await patch("/api/admin/stage", admin).send({ mode: "party" })).status).toBe(400);
    await post("/api/admin/event/next", admin).send({});
    expect((await get("/api/stage")).body.show).toMatchObject({ slide: 1, mode: "auto", introAt: null });
  });
});
