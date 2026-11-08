// v3: the platform panel is root-only (overview, projector preview, history of any organisation); the team on stage turns
// its own slides and nobody else's; the event's own presentation; a new event archives the old one without losing data;
// the upload deadline + per-team extension; score history Excel per organisation; the projector page has no controls;
// sockets resync after a reconnect; 30 jurors + 5 screens get a slide change fast.
import ExcelJS from "exceljs";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { io as ioc, type Socket } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { makePdf } from "./helpers/pdf.js";

let A: App;
let base: string;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-v3-"));
const sockets: Socket[] = [];

const post = (p: string, cookie?: string) => { const r = request(base).post(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const patch = (p: string, cookie?: string) => { const r = request(base).patch(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const put = (p: string, cookie?: string) => { const r = request(base).put(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const get = (p: string, cookie?: string) => (cookie ? request(base).get(p).set("Cookie", cookie) : request(base).get(p));
const binary = (p: string, cookie: string) => get(p, cookie).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on("data", (c: Buffer) => b.push(c)); res.on("end", () => cb(null, Buffer.concat(b))); });
const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
const upload = (p: string, cookie: string, name: string, body: Buffer) =>
  post(p, cookie).set("Content-Type", "application/octet-stream").set("X-File-Name", encodeURIComponent(name)).send(body);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function socket(cookie: string | undefined, auth: Record<string, string> = {}, opts: Record<string, unknown> = {}) {
  const s = ioc(base, { transports: ["websocket"], extraHeaders: { origin: base, ...(cookie ? { cookie } : {}) }, auth, forceNew: true, ...opts });
  sockets.push(s);
  return new Promise<Socket>((res, rej) => { s.once("connect", () => res(s)); s.once("connect_error", rej); });
}
const waitFor = <T = any>(s: Socket, ev: string, pred: (p: T) => boolean = () => true, ms = 1500) => new Promise<T>((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`no ${ev} within ${ms} ms`)); }, ms);
  const h = (p: T) => { if (pred(p)) { clearTimeout(t); s.off(ev, h); res(p); } };
  s.on(ev, h);
});

async function login(username: string, password: string) {
  const r = await post("/api/auth/login").send({ username, password });
  expect(r.status, r.body.error).toBe(200);
  return { cookie: cookieOf(r), body: r.body };
}
async function newJuror(adminCookie: string, name: string) {
  const r = await post("/api/admin/jurors", adminCookie).send({});
  const c = await post(`/api/auth/invite/${r.body.invite.path.replace("/j/", "")}`).send({ displayName: name });
  expect(c.status, c.body.error).toBe(200);
  return { id: r.body.juror.id as number, cookie: cookieOf(c) };
}
async function teamSignIn(adminCookie: string, teamId: number) {
  const l = await post(`/api/admin/teams/${teamId}/link`, adminCookie).send({});
  const r = await post(`/api/auth/team${l.body.path.slice(2)}`).send({});
  expect(r.status, r.body.error).toBe(200);
  return cookieOf(r);
}
const full = (crit: Array<{ key: string; maxScore: number }>, v: number) => ({ values: Object.fromEntries(crit.map(c => [c.key, Math.min(v, c.maxScore)])), note: "" });
async function xlsxRows(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const out: string[][] = [];
  wb.worksheets[0].eachRow(r => out.push((r.values as unknown[]).slice(1).map(v => String(v ?? ""))));
  return out;
}

let root: string;
let beta: string;
let betaId: number;
let rootTeams: number[] = [];
let betaTeams: number[] = [];
let betaTeamCookies: string[] = [];
let rootTeamCookie: string;
let betaJuror: { id: number; cookie: string };
let rootJuror: { id: number; cookie: string };

beforeAll(async () => {
  A = await buildApp(loadConfig({
    dataDir: tmp, dbFile: ":memory:", uploadsDir: path.join(tmp, "uploads"), backupDir: path.join(tmp, "backups"), webDir: "/nonexistent",
    adminUsername: "admin", adminPassword: "admin-pass-123", origins: [], sessionSecret: "test-secret", soffice: "",
  }));
  await A.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(A.app.server.address() as AddressInfo).port}`;
  const r = await login("admin", "admin-pass-123");
  root = r.cookie;
  expect(r.body.redirect).toBe("/root");
  const o = await post("/api/root/orgs", root).send({ slug: "beta", name: "Beta MMC", coordinator: { username: "beta", password: "beta-pass-123" } });
  betaId = o.body.id;
  beta = (await login("beta", "beta-pass-123")).cookie;
  rootTeams = (await get("/api/admin/teams", root)).body.map((t: { id: number }) => t.id);
  for (const n of ["Beta Bir", "Beta İki", "Beta Üç"]) betaTeams.push((await post("/api/admin/teams", beta).send({ name: n, project: `${n} layihə` })).body.id);
  for (const t of betaTeams.slice(0, 2)) betaTeamCookies.push(await teamSignIn(beta, t));
  rootTeamCookie = await teamSignIn(root, rootTeams[0]);
  for (const [i, c] of betaTeamCookies.entries()) expect((await upload("/api/team/files?kind=presentation", c, `b${i}.pdf`, makePdf(4, `beta${i}`))).status).toBe(200);
  expect((await upload("/api/team/files?kind=presentation", rootTeamCookie, "root.pdf", makePdf(3, "root"))).status).toBe(200);
  betaJuror = await newJuror(beta, "Beta Münsif");
  rootJuror = await newJuror(root, "Kök Münsif");
  const bc = (await get("/api/admin/criteria", beta)).body;
  expect((await put(`/api/juror/scores/${betaTeams[0]}`, betaJuror.cookie).send(full(bc, 4))).status).toBe(200);
  expect((await put(`/api/juror/scores/${betaTeams[0]}`, betaJuror.cookie).send(full(bc, 6))).status).toBe(200);
  expect((await put(`/api/juror/scores/${betaTeams[1]}`, betaJuror.cookie).send(full(bc, 5))).status).toBe(200);
  const rc = (await get("/api/admin/criteria", root)).body;
  expect((await put(`/api/juror/scores/${rootTeams[0]}`, rootJuror.cookie).send(full(rc, 3))).status).toBe(200);
});
afterAll(async () => {
  sockets.forEach(s => s.close());
  await A.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("platform panel (/root) is the platform owner's only", () => {
  it("lists every organisation with its live stage and counts — no scores, juror names or files", async () => {
    await patch("/api/admin/event", beta).send({ currentTeamId: betaTeams[0] });
    const r = await get("/api/root/overview", root);
    expect(r.status).toBe(200);
    const b = r.body.find((o: { id: number }) => o.id === betaId);
    const me = r.body.find((o: { root: boolean }) => o.root);
    expect(me).toBeTruthy();
    expect(b).toMatchObject({ name: "Beta MMC", teams: 3, jurors: 1, events: 1, progress: { done: 2 } });
    expect(b.stage.team.name).toBe("Beta Bir");
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("Beta Münsif");
    expect(text).not.toMatch(/"values"|"scores":\[/);
    // the read-only projector preview
    const st = await get(`/api/root/orgs/${betaId}/stage`, root);
    expect(st.status).toBe(200);
    expect(st.body.team.name).toBe("Beta Bir");
  });
  it("coordinators get 403 on every platform route, and /root sends them to /admin", async () => {
    for (const p of ["/api/root/overview", `/api/root/orgs/${betaId}/stage`, `/api/root/orgs/1/stage`, `/api/root/orgs/1/history.xlsx`, "/api/root/orgs"]) {
      expect((await get(p, beta)).status, p).toBe(403);
    }
    expect((await post("/api/root/impersonate", beta).send({ orgId: 1 })).status).toBe(403);
    const page = await get("/root", beta);
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe("/admin");
  });
  it("a coordinator asking the socket for the root watch gets only its own feed", async () => {
    const s = await socket(beta, { role: "admin", watch: "root" });
    const got: unknown[] = [];
    s.on("org:stage", p => got.push(p));
    const own = waitFor(s, "progress:changed", () => true, 1500).catch(() => null);
    await patch("/api/admin/event", root).send({ currentTeamId: rootTeams[1] });
    await sleep(300);
    expect(got).toEqual([]);
    void own;
    s.close();
  });
  it("root's watch socket gets every organisation's stage", async () => {
    const s = await socket(root, { role: "admin", watch: "root" });
    const p = waitFor<{ orgId: number; stage: { team: { name: string } } }>(s, "org:stage", x => x.orgId === betaId);
    await patch("/api/admin/event", beta).send({ currentTeamId: betaTeams[1] });
    expect((await p).stage.team.name).toBe("Beta İki");
    s.close();
  });
  it("the projector page may be framed by the same origin (root preview); other pages may not", async () => {
    const pages = await Promise.all(["/stage", "/o/beta/stage", "/o/beta/reveal", "/admin", "/root"].map(p => get(p, root)));
    expect(pages.map(p => p.headers["x-frame-options"])).toEqual(["SAMEORIGIN", "SAMEORIGIN", "SAMEORIGIN", "DENY", "DENY"]);
  });
});

describe("the team on stage turns its own slides", () => {
  it("a team not on stage cannot", async () => {
    await patch("/api/admin/event", beta).send({ currentTeamId: betaTeams[0] });
    const r = await post("/api/team/slide", betaTeamCookies[1]).send({ delta: 1 });
    expect(r.status).toBe(403);
    expect((await get("/api/team/state", betaTeamCookies[1])).body.slideControl.allowed).toBe(false);
  });
  it("the team on stage can, the projector follows, other organisations are untouched", async () => {
    const before = (await get("/api/stage?org=beta")).body.show.slide;
    const rootBefore = (await get("/api/stage")).body;
    const scr = await socket(undefined, { org: "beta" });
    const t0 = Date.now();
    const p = waitFor<{ show: { slide: number } }>(scr, "stage:changed", s => s.show.slide === before + 1);
    const r = await post("/api/team/slide", betaTeamCookies[0]).send({ delta: 1 });
    expect(r.status, r.body.error).toBe(200);
    expect(r.body.slideControl).toMatchObject({ allowed: true, slide: before + 1, pages: 4 });
    await p;
    expect(Date.now() - t0).toBeLessThan(1000); // generous: Docker build host is busy (real latency ~10–25 ms)
    expect((await get("/api/stage")).body.show.slide).toBe(rootBefore.show.slide);
    expect((await get("/api/stage")).body.team?.id).toBe(rootBefore.team?.id);
    // beyond the last slide it stays on the last one
    for (let i = 0; i < 6; i++) await post("/api/team/slide", betaTeamCookies[0]).send({ delta: 1 });
    expect((await get("/api/stage?org=beta")).body.show.slide).toBe(4);
    scr.close();
  });
  it("a team of another organisation with the same id range never moves this stage", async () => {
    const r = await post("/api/team/slide", rootTeamCookie).send({ delta: -1 });
    expect(r.status).toBe(403);
    expect((await get("/api/stage?org=beta")).body.show.slide).toBe(4);
  });
  it("the coordinator can switch the right off; off the stage the right is gone", async () => {
    expect((await patch("/api/admin/settings/stage", beta).send({ teamSlideControl: false })).status).toBe(200);
    expect((await post("/api/team/slide", betaTeamCookies[0]).send({ delta: -1 })).status).toBe(403);
    expect((await patch("/api/admin/settings/stage", beta).send({ teamSlideControl: true })).status).toBe(200);
    expect((await post("/api/team/slide", betaTeamCookies[0]).send({ delta: -1 })).status).toBe(200);
    await patch("/api/admin/event", beta).send({ currentTeamId: betaTeams[1] });
    const r = await post("/api/team/slide", betaTeamCookies[0]).send({ delta: -1 });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Növbəniz/);
  });
});

describe("the event's own presentation", () => {
  let fileId: number;
  it("uploads, lists only in its organisation, shows on the projector without a team and turns slides", async () => {
    const r = await upload("/api/admin/event-files", beta, "Açılış.pdf", makePdf(5, "opening"));
    expect(r.status, r.body.error).toBe(200);
    fileId = r.body.file.id;
    expect(r.body.file).toMatchObject({ title: "Açılış", pages: 5, viewable: true });
    expect((await get("/api/admin/event-files", root)).body.files.map((f: { id: number }) => f.id)).not.toContain(fileId);
    // not on stage yet: the public URL answers 404
    expect((await get("/api/stage/event-presentation?org=beta")).status).toBe(404);
    const s = await patch("/api/admin/stage", beta).send({ eventFile: fileId, scene: "event" });
    expect(s.status, s.body.error).toBe(200);
    expect(s.body.stage.show).toMatchObject({ scene: "event", eventSlide: 1, bubble: false, eventPres: { fileId, pages: 5, title: "Açılış" } });
    const f = await get("/api/stage/event-presentation?org=beta");
    expect(f.status).toBe(200);
    expect(f.headers["content-type"]).toContain("application/pdf");
    // another organisation's projector does not get it
    expect((await get("/api/stage/event-presentation")).status).toBe(404);
    expect((await patch("/api/admin/stage", beta).send({ delta: 1 })).body.stage.show.eventSlide).toBe(2);
    // the team on stage cannot turn the event's slides
    await patch("/api/admin/event", beta).send({ currentTeamId: betaTeams[0] });
    expect((await patch("/api/admin/stage", beta).send({ scene: "event" })).body.stage.show.eventSlide).toBe(2);
    expect((await post("/api/team/slide", betaTeamCookies[0]).send({ delta: 1 })).status).toBe(403);
    expect((await get("/api/stage?org=beta")).body.show.eventSlide).toBe(2);
  });
  it("another organisation cannot show or delete it", async () => {
    expect((await patch("/api/admin/stage", root).send({ eventFile: fileId, scene: "event" })).status).toBe(404);
    expect((await request(base).delete(`/api/admin/event-files/${fileId}`).set("Origin", base).set("Cookie", root)).status).toBe(404);
    expect((await get(`/api/admin/event-files/${fileId}/file`, root)).status).toBe(404);
  });
  it("back to the team; putting a team on stage also leaves the event scene", async () => {
    expect((await patch("/api/admin/stage", beta).send({ scene: "event" })).body.stage.show.scene).toBe("event");
    await patch("/api/admin/event", beta).send({ currentTeamId: betaTeams[1] });
    expect((await get("/api/stage?org=beta")).body.show.scene).toBe("team");
    expect((await get("/api/stage/event-presentation?org=beta")).status).toBe(404);
  });
});

describe("upload deadline", () => {
  it("closes uploads after the deadline; an extension reopens them for one team only", async () => {
    const past = Date.now() - 60_000;
    expect((await patch("/api/admin/settings/teams", beta).send({ uploadDeadline: past })).status).toBe(200);
    const st = (await get("/api/team/state", betaTeamCookies[0])).body;
    expect(st.event).toMatchObject({ deadline: past, uploadsOpen: false });
    expect((await upload("/api/team/files?kind=presentation", betaTeamCookies[0], "late.pdf", makePdf(2))).status).toBe(403);
    const until = Date.now() + 3600_000;
    expect((await patch(`/api/admin/teams/${betaTeams[0]}/materials`, beta).send({ extendUntil: until })).status).toBe(200);
    expect((await get("/api/team/state", betaTeamCookies[0])).body.event).toMatchObject({ uploadsOpen: true, extendedUntil: until });
    expect((await upload("/api/team/files?kind=presentation", betaTeamCookies[0], "late.pdf", makePdf(2))).status).toBe(200);
    expect((await upload("/api/team/files?kind=presentation", betaTeamCookies[1], "late.pdf", makePdf(2))).status).toBe(403);
    expect((await patch("/api/admin/settings/teams", beta).send({ uploadDeadline: null })).status).toBe(200);
  });
  it("one hour before the deadline, teams without a presentation get one reminder", async () => {
    const dl = Date.now() + 40 * 60_000;
    await patch("/api/admin/settings/teams", beta).send({ uploadDeadline: dl });
    const sc = A.ctx.orgs.scope(betaId);
    sc.teams.deadlineReminders();
    sc.teams.deadlineReminders();
    const team3 = await teamSignIn(beta, betaTeams[2]);
    const notices = (await get("/api/team/notices", team3)).body as Array<{ kind: string }>;
    expect(notices.filter(n => n.kind === "deadline").length).toBe(1);
    const has = (await get("/api/team/notices", betaTeamCookies[1])).body as Array<{ kind: string }>;
    expect(has.some(n => n.kind === "deadline")).toBe(false);
    await patch("/api/admin/settings/teams", beta).send({ uploadDeadline: null });
  });
});

describe("score history Excel", () => {
  it("the coordinator gets its own organisation's history (who, when, team, criterion, old → new)", async () => {
    const r = await binary("/api/admin/history.xlsx", beta);
    expect(r.status).toBe(200);
    const rows = await xlsxRows(r.body as Buffer);
    const text = rows.map(r => r.join("|")).join("\n");
    expect(text).toContain("Beta Münsif");
    expect(text).toContain("Beta Bir");
    expect(text).toContain("Dəyişdirildi");
    expect(text).not.toContain("Kök Münsif");
    // one changed criterion row shows old → new
    expect(rows.some(r => r.includes("4") && r.includes("6"))).toBe(true);
  });
  it("root downloads any organisation's history; coordinators cannot reach another's", async () => {
    const r = await binary(`/api/root/orgs/${betaId}/history.xlsx`, root);
    expect(r.status).toBe(200);
    const text = (await xlsxRows(r.body as Buffer)).map(r => r.join("|")).join("\n");
    expect(text).toContain("Beta Münsif");
    expect(text).not.toContain("Kök Münsif");
    expect((await get("/api/root/orgs/1/history.xlsx", beta)).status).toBe(403);
    const own = (await xlsxRows((await binary("/api/admin/history.xlsx", root)).body as Buffer)).map(r => r.join("|")).join("\n");
    expect(own).toContain("Kök Münsif");
    expect(own).not.toContain("Beta Münsif");
  });
});

describe("the projector has no controls", () => {
  it("timer and reveal pages render no control buttons; the only admin request is the clicker's slide (← →)", () => {
    const timer = fs.readFileSync(path.join(__dirname, "../web/src/timer.ts"), "utf8");
    const reveal = fs.readFileSync(path.join(__dirname, "../web/src/reveal.ts"), "utf8");
    for (const src of [timer, reveal]) {
      expect(src).not.toMatch(/["`']\/api\/admin\/(event|reveal|event\/next)["`']/);
      expect(src).not.toMatch(/data-act=\\?"(start|toggle|reset|qa|next|prev|pause|plus|minus)\\?"/);
      const adminCalls = src.match(/["`']\/api\/admin\/[^"`']*["`'][^;]*/g) ?? [];
      expect(adminCalls.every(c => /\/api\/admin\/stage["`'].*body: \{ slide: n \}/.test(c)), adminCalls.join("\n")).toBe(true);
    }
    // (the landing page's ?demo bar is a separate, demo-only block)
    const html = fs.readFileSync(path.join(__dirname, "../web/timer.html"), "utf8").replace(/<div class="st-demo"[\s\S]*?<\/div>/, "");
    expect(html).not.toMatch(/<button[^>]*>(Başla|Sıfırla|Sual-cavab)/);
  });
});

describe("realtime reliability", () => {
  it("after a dropped connection the client resyncs: everything it missed is in the next /api/stage", async () => {
    const s = await socket(undefined, { org: "beta" }, { reconnection: true, reconnectionDelay: 50, reconnectionDelayMax: 100 });
    // Listen before dropping: with a 50 ms reconnect delay the socket can be back before the PATCHes return.
    const reconnected = new Promise<void>(res => s.io.once("reconnect", () => res()));
    s.io.engine.close(); // simulate a network drop
    await patch("/api/admin/event", beta).send({ currentTeamId: betaTeams[2] });
    await patch("/api/admin/event", beta).send({ timer: "pitch" });
    await reconnected;
    if (!s.connected) await new Promise<void>(res => s.once("connect", () => res()));
    const st = (await get("/api/stage?org=beta")).body;
    expect(st.team.name).toBe("Beta Üç");
    expect(typeof st.serverNow).toBe("number");
    // and the live feed works again on the same socket
    const p = waitFor<{ team: { name: string } }>(s, "stage:changed", x => x.team?.name === "Beta Bir");
    await patch("/api/admin/event", beta).send({ currentTeamId: betaTeams[0] });
    await p;
    s.close();
  });
  it("30 jurors + 5 screens: a slide change reaches every screen fast", async () => {
    const jur = await Promise.all(Array.from({ length: 30 }, (_, i) => newJuror(beta, `Yük münsif ${i + 1}`)));
    const js = await Promise.all(jur.map(j => socket(j.cookie, { role: "juror" })));
    const screens = await Promise.all(Array.from({ length: 5 }, () => socket(undefined, { org: "beta" })));
    await patch("/api/admin/event", beta).send({ currentTeamId: betaTeams[0] });
    await patch("/api/admin/stage", beta).send({ mode: "auto" });
    const lat: number[] = [];
    for (let k = 0; k < 6; k++) {
      const d = k % 2 ? -1 : 1;
      const t0 = performance.now();
      const all = screens.map(s => waitFor(s, "stage:changed", () => true, 1500).then(() => performance.now() - t0));
      const r = await patch("/api/admin/stage", beta).send({ delta: d });
      expect(r.status).toBe(200);
      lat.push(...(await Promise.all(all)));
    }
    lat.sort((a, b) => a - b);
    const p95 = lat[Math.floor(lat.length * 0.95)];
    console.log(`[load] 30 jurors + 5 screens: slide change p50 ${lat[Math.floor(lat.length / 2)].toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${lat[lat.length - 1].toFixed(1)} ms`);
    // generous bound: the Docker build runs tests on a shared, busy host
    expect(p95).toBeLessThan(1000);
    js.forEach(s => s.close());
    screens.forEach(s => s.close());
  }, 30_000);
  it("the timer is not broadcast every second: the client counts from serverNow", async () => {
    const s = await socket(undefined, { org: "beta" });
    let n = 0;
    s.on("timer:changed", () => n++);
    await patch("/api/admin/event", beta).send({ timer: "pitch" });
    await sleep(2200);
    expect(n).toBeLessThanOrEqual(2);
    s.close();
  });
});

describe("a new event archives the old one; nothing is lost", () => {
  let oldResults: Array<[string, number | null]>;
  let archivedId: number;
  it("creates the new event, the old one goes to the archive with its results, history and exports", async () => {
    const st0 = (await get("/api/admin/state", beta)).body;
    oldResults = st0.results.ranking.map((r: { team: { name: string }; score: number | null }) => [r.team.name, r.score]);
    const evs0 = (await get("/api/admin/events", beta)).body;
    expect(evs0.length).toBe(1);
    expect((await post("/api/admin/events", beta).send({ name: "Beta 2027" })).status).toBe(400); // confirm required
    const r = await post("/api/admin/events", beta).send({ name: "Beta 2027", pitchSec: 240, qaSec: 60, uploadDeadline: Date.now() + 86400_000, copyTeams: true, confirm: true });
    expect(r.status, r.body.error).toBe(200);
    archivedId = r.body.archived.id;
    expect(r.body.events.map((e: { status: string }) => e.status)).toEqual(["active", "archived"]);
    // new event: same team names, no scores, no jurors, new durations
    const st = (await get("/api/admin/state", beta)).body;
    expect(st.teams.map((t: { name: string }) => t.name)).toEqual(["Beta Bir", "Beta İki", "Beta Üç"]);
    expect(st.teams.some((t: { id: number }) => betaTeams.includes(t.id))).toBe(false);
    expect(st.scores).toEqual([]);
    expect(st.jurors).toEqual([]);
    expect(st.event.timer).toMatchObject({ pitchSec: 240, qaSec: 60 });
    expect(st.stage.team).toBeNull();
    // archived: read-only results identical to before
    const a = (await get(`/api/admin/events/${archivedId}/results`, beta)).body;
    expect(a.results.ranking.map((x: { team: { name: string }; score: number | null }) => [x.team.name, x.score])).toEqual(oldResults);
    expect((await binary(`/api/admin/events/${archivedId}/export.xlsx`, beta)).status).toBe(200);
    expect((await binary(`/api/admin/events/${archivedId}/export.pdf`, beta)).status).toBe(200);
    const h = (await xlsxRows((await binary(`/api/admin/events/${archivedId}/history.xlsx`, beta)).body as Buffer)).map(r => r.join("|")).join("\n");
    expect(h).toContain("Beta Münsif");
    // another organisation cannot open it
    expect((await get(`/api/admin/events/${archivedId}/results`, root)).status).toBe(404);
    // the root event is untouched
    expect((await get("/api/admin/events", root)).body.length).toBe(1);
    expect((await get("/api/admin/state", root)).body.scores.length).toBe(1);
  });
  it("the archived event's juror and team sessions no longer work", async () => {
    expect((await get("/api/juror/state", betaJuror.cookie)).status).toBe(401);
    expect((await get("/api/team/state", betaTeamCookies[0])).status).toBe(401);
  });
  it("the archived rows are all still in the database", () => {
    const db = A.ctx.orgs.db;
    const n = (sql: string) => (db.prepare(sql).get(betaId, archivedId) as { n: number }).n;
    expect(n("SELECT COUNT(*) n FROM teams WHERE org_id=? AND event_id=?")).toBe(3);
    expect(n("SELECT COUNT(*) n FROM scores WHERE org_id=? AND event_id=?")).toBe(2);
    expect(n("SELECT COUNT(*) n FROM score_history WHERE org_id=? AND event_id=?")).toBeGreaterThanOrEqual(3);
    expect(n("SELECT COUNT(*) n FROM team_files WHERE org_id=? AND event_id=?")).toBeGreaterThanOrEqual(3);
  });
});
