// v4: (1) the projector bug: HTML pages are revalidated on every load (no day-long cache that kept the old control dock
// after a deploy) and the stage page has no control buttons or key hints in its markup; (2) "QR kodlar": team and juror QR
// cards of the active program, one organisation only, bulk links / invites, printable PDF cards; (3) "Proqramlar":
// a new program from any earlier program (rubric, teams, jurors), the history list and a full read-only view of an
// archived program.
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { makePdf } from "./helpers/pdf.js";

let A: App;
let base: string;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-v4-"));
const webDir = path.join(tmp, "web");

const post = (p: string, cookie?: string) => { const r = request(base).post(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const patch = (p: string, cookie?: string) => { const r = request(base).patch(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const put = (p: string, cookie?: string) => { const r = request(base).put(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const get = (p: string, cookie?: string) => (cookie ? request(base).get(p).set("Cookie", cookie) : request(base).get(p));
const binary = (r: request.Test) => r.buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on("data", (c: Buffer) => b.push(c)); res.on("end", () => cb(null, Buffer.concat(b))); });
const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
const upload = (p: string, cookie: string, name: string, body: Buffer) =>
  post(p, cookie).set("Content-Type", "application/octet-stream").set("X-File-Name", encodeURIComponent(name)).send(body);
async function login(username: string, password: string) {
  const r = await post("/api/auth/login").send({ username, password });
  expect(r.status, r.body.error).toBe(200);
  return cookieOf(r);
}
async function newJuror(admin: string, name: string) {
  const r = await post("/api/admin/jurors", admin).send({});
  const c = await post(`/api/auth/invite/${r.body.invite.path.replace("/j/", "")}`).send({ displayName: name });
  expect(c.status, c.body.error).toBe(200);
  return { id: r.body.juror.id as number, cookie: cookieOf(c) };
}
const full = (crit: Array<{ key: string; maxScore: number }>, v: number) => ({ values: Object.fromEntries(crit.map(c => [c.key, Math.min(v, c.maxScore)])), note: "" });

let root: string, acme: string, zeta: string;
beforeAll(async () => {
  // a tiny built web dir: the real HTML pages are served from it (the cache headers come from the static plugin)
  fs.mkdirSync(path.join(webDir, "assets"), { recursive: true });
  for (const f of ["login.html", "timer.html", "admin.html", "team.html", "join.html", "reveal.html", "setup.html", "pult.html", "root.html", "juror.html", "speaker.html", "orgs.html", "qr.html", "programs.html"]) {
    fs.writeFileSync(path.join(webDir, f), `<!doctype html><title>${f}</title>`);
  }
  fs.writeFileSync(path.join(webDir, "assets", "timer-abc123.js"), "console.log(1)");
  A = await buildApp(loadConfig({
    dataDir: tmp, dbFile: ":memory:", uploadsDir: path.join(tmp, "uploads"), backupDir: path.join(tmp, "backups"), webDir,
    adminUsername: "admin", adminPassword: "admin-pass-123", origins: [], sessionSecret: "test-secret", soffice: "",
  }));
  await A.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(A.app.server.address() as AddressInfo).port}`;
  root = await login("admin", "admin-pass-123");
  for (const slug of ["acme", "zeta"]) {
    const o = await post("/api/root/orgs", root).send({ slug, name: slug.toUpperCase(), coordinator: { username: slug, password: `${slug}-pass-123` } });
    expect(o.status, o.body.error).toBe(200);
  }
  acme = await login("acme", "acme-pass-123");
  zeta = await login("zeta", "zeta-pass-123");
  for (const n of ["Alfa", "Bəta", "Qamma"]) expect((await post("/api/admin/teams", acme).send({ name: n, project: `${n} layihə` })).status).toBe(200);
  expect((await post("/api/admin/teams", zeta).send({ name: "Zeta Bir", project: "" })).status).toBe(200);
});
afterAll(async () => { await A.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("projector pages are never served from a stale cache", () => {
  it("every HTML page is revalidated (no-cache); sign-in pages are not stored; hashed assets stay immutable", async () => {
    for (const p of ["/stage", "/timer", "/stage/demo", "/reveal", "/login", "/o/acme/stage", "/o/acme/timer", "/o/acme/reveal", "/team"]) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(r.headers["cache-control"], p).toBe("no-cache");
    }
    for (const c of [root, acme]) {
      const r = await get("/admin", c);
      expect(r.status).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-cache");
      // a coordinator opening /stage gets their organisation's screen (redirect), served the same way
      const s = await get("/stage", c);
      if (s.status === 302) expect(s.headers.location).toBe("/o/acme/stage");
      else expect(s.headers["cache-control"]).toBe("no-cache");
    }
    for (const p of ["/t/ABCDEFGHJKMN", "/j/sometoken"]) expect((await get(p)).headers["cache-control"], p).toBe("no-store");
    expect((await get("/assets/timer-abc123.js")).headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await get("/admin/qr", acme)).status).toBe(200);
    expect((await get("/admin/programs", acme)).status).toBe(200);
    expect((await get("/admin/qr")).status).toBe(302);
  });

  it("the stage page source has no control dock, no key hints and says Anons (not Intro)", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "web", "timer.html"), "utf8");
    const ts = fs.readFileSync(path.join(__dirname, "..", "web", "src", "timer.ts"), "utf8");
    expect(html).not.toMatch(/id="keys"|tp-keys|>Intro<|başlat\/fasilə/);
    expect(html).toMatch(/data-d="intro">Anons</);
    for (const s of ["başlat/fasilə", "sual-cavab · R", "+/- 30", 'data-act="pitch"', 'data-act="qa"', 'data-act="reset"', 'data-act="next"', 'data-act="intro"', "<span>Intro</span>"]) {
      expect(ts.includes(s), s).toBe(false);
    }
  });
});

describe("QR kodlar (one organisation, active program)", () => {
  it("lists the organisation's teams and jurors only; creates missing team links; codes stay the same afterwards", async () => {
    expect((await get("/api/admin/qr")).status).toBe(401);
    const r0 = await get("/api/admin/qr", acme);
    expect(r0.status).toBe(200);
    expect(r0.body.teams.map((t: any) => t.name)).toEqual(["Alfa", "Bəta", "Qamma"]);
    expect(r0.body.teams.every((t: any) => t.code === null)).toBe(true);
    const made = await post("/api/admin/qr/teams", acme).send({});
    expect(made.body.made).toBe(3);
    const codes = made.body.teams.map((t: any) => t.code);
    expect(codes.every((c: string) => /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c))).toBe(true);
    expect(made.body.teams[0].path).toMatch(/^\/t\/[A-Z0-9]{12}$/);
    const again = await post("/api/admin/qr/teams", acme).send({});
    expect(again.body.made).toBe(0);
    expect(again.body.teams.map((t: any) => t.code)).toEqual(codes);
    // the team link signs the team in
    const s = await post(`/api/auth/team${made.body.teams[0].path.slice(2)}`).send({});
    expect(s.status).toBe(200);
    // zeta sees only its own team, without acme's codes
    const z = await get("/api/admin/qr", zeta);
    expect(z.body.teams.map((t: any) => t.name)).toEqual(["Zeta Bir"]);
    expect(JSON.stringify(z.body)).not.toMatch(new RegExp(codes[0]));
  });

  it("bulk juror QRs: new single-use invites for jurors who have not signed in; never for another organisation's jurors", async () => {
    for (let i = 0; i < 3; i++) expect((await post("/api/admin/jurors", acme).send({})).status).toBe(200);
    const zj = (await post("/api/admin/jurors", zeta).send({})).body.juror.id;
    const list = (await get("/api/admin/qr", acme)).body.jurors;
    expect(list.length).toBe(3);
    expect(list.every((j: any) => j.openInviteUntil > Date.now() && !j.claimed)).toBe(true);
    const r = await post("/api/admin/qr/jurors", acme).send({ ttlHours: 72 });
    expect(r.body.invites.length).toBe(3);
    expect(r.body.invites[0].path).toMatch(/^\/j\//);
    expect(r.body.invites[0].expiresAt).toBeGreaterThan(Date.now() + 71 * 3600_000);
    // the first claim works, the old (replaced) invite does not
    const c = await post(`/api/auth/invite/${r.body.invites[0].path.slice(3)}`).send({ displayName: "Aynur Əliyeva" });
    expect(c.status).toBe(200);
    expect((await post(`/api/auth/invite/${r.body.invites[0].path.slice(3)}`).send({ displayName: "Xəyal" })).status).toBe(410);
    const r2 = await post("/api/admin/qr/jurors", acme).send({});
    expect(r2.body.invites.map((i: any) => i.id).sort()).toEqual(r.body.invites.slice(1).map((i: any) => i.id).sort());
    // asking for another organisation's juror does nothing
    const r3 = await post("/api/admin/qr/jurors", acme).send({ ids: [zj] });
    expect(r3.body.invites).toEqual([]);
    expect((await post("/api/admin/qr/jurors", acme).send({ ttlHours: 5 })).status).toBe(400);
  });

  it("printable PDF cards for teams and jurors", async () => {
    const t = await binary(get("/api/admin/qr/teams.pdf", acme));
    expect(t.status).toBe(200);
    expect(t.headers["content-type"]).toBe("application/pdf");
    expect((t.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    const j = await binary(post("/api/admin/qr/jurors.pdf", acme).send({}));
    expect(j.status).toBe(200);
    expect((j.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await get("/api/admin/qr/teams.pdf")).status).toBe(401);
  });
});

describe("Proqramlar: new program from an earlier one, history and full read-only view", () => {
  let firstId: number;
  it("archives the active program and copies rubric, teams and jurors from a chosen program", async () => {
    // acme program 1: one presentation, one juror with scores
    const teams = (await get("/api/admin/teams", acme)).body;
    const link = await post(`/api/admin/teams/${teams[0].id}/link`, acme).send({});
    const tc = cookieOf(await post(`/api/auth/team${link.body.path.slice(2)}`).send({}));
    expect((await upload("/api/team/files?kind=presentation", tc, "alfa.pdf", makePdf(3, "alfa"))).status).toBe(200);
    await post("/api/admin/criteria", acme).send({ name: "Dizayn", description: "", maxScore: 7 });
    const crit = (await get("/api/admin/criteria", acme)).body;
    const j = await newJuror(acme, "Rəşad Q.");
    for (const [i, t] of teams.entries()) expect((await put(`/api/juror/scores/${t.id}`, j.cookie).send(full(crit, 3 + i))).status).toBe(200);
    expect((await put(`/api/juror/scores/${teams[0].id}`, j.cookie).send(full(crit, 6))).status).toBe(200);
    const evs0 = (await get("/api/admin/events", acme)).body;
    firstId = evs0[0].id;
    // program 2: plain new one
    const r2 = await post("/api/admin/events", acme).send({ name: "Acme 2", copyCriteria: false, confirm: true });
    expect(r2.status, r2.body.error).toBe(200);
    expect((await get("/api/admin/criteria", acme)).body.length).toBeLessThan(crit.length + 1);
    // program 3: from program 1 (archived): rubric + teams + jurors
    const bad = await post("/api/admin/events", zeta).send({ name: "Steal", copyFrom: firstId, confirm: true });
    expect(bad.status).toBe(404);
    const r3 = await post("/api/admin/events", acme).send({ name: "Acme 3", copyFrom: firstId, copyTeams: true, copyJurors: true, confirm: true });
    expect(r3.status, r3.body.error).toBe(200);
    expect((await get("/api/admin/criteria", acme)).body.map((c: any) => c.name)).toEqual(crit.map((c: any) => c.name));
    expect((await get("/api/admin/teams", acme)).body.map((t: any) => t.name)).toEqual(["Alfa", "Bəta", "Qamma"]);
    const js = (await get("/api/admin/jurors", acme)).body;
    expect(js.map((x: any) => x.displayName).sort()).toEqual(["Aynur Əliyeva", "Münsif 2", "Münsif 3", "Rəşad Q."].sort());
    expect((await get("/api/admin/state", acme)).body.scores.length).toBe(0);
    // the old juror session belongs to an archived program now
    expect((await get("/api/juror/state", j.cookie)).status).toBe(401);
    const list = (await get("/api/admin/events", acme)).body;
    expect(list.map((e: any) => e.status)).toEqual(["active", "archived", "archived"]);
    expect(list[0]).toMatchObject({ name: "Acme 3 Hakaton", date: expect.any(String), imported: null });
  });

  it("full read-only view of an archived program: ranking, teams with materials, jurors, every score, history", async () => {
    const d = await get(`/api/admin/events/${firstId}/detail`, acme);
    expect(d.status).toBe(200);
    expect(d.body.readOnly).toBe(true);
    expect(d.body.meta).toMatchObject({ id: firstId, status: "archived" });
    expect(d.body.results.ranking.map((x: any) => x.team.name)).toEqual(["Alfa", "Qamma", "Bəta"]);
    expect(d.body.teams[0]).toMatchObject({ name: "Alfa", presentation: { name: "alfa.pdf", pages: 3, missing: false }, scores: 1 });
    expect(d.body.jurors.map((x: any) => x.displayName)).toContain("Rəşad Q.");
    expect(d.body.scores.length).toBe(3);
    expect(d.body.historyTotal).toBe(4);
    const h = await get(`/api/admin/events/${firstId}/history?limit=2`, acme);
    expect(h.body.rows.length).toBe(2);
    expect(h.body.more).toBe(true);
    expect(h.body.rows[0]).toMatchObject({ kind: "update", teamName: "Alfa", jurorName: "Rəşad Q." });
    // the archived program's file is still readable for the coordinator
    const f = await get(d.body.teams[0].presentation.url, acme);
    expect(f.status).toBe(200);
    // other organisation: nothing
    for (const p of ["detail", "history", "results", "export.xlsx", "export.pdf"]) expect((await get(`/api/admin/events/${firstId}/${p}`, zeta)).status, p).toBe(404);
    // exports of the archived program
    expect((await binary(get(`/api/admin/events/${firstId}/export.xlsx`, acme))).status).toBe(200);
    expect((await binary(get(`/api/admin/events/${firstId}/export.pdf`, acme))).status).toBe(200);
  });

  it("an archived program cannot be changed through the live panel", async () => {
    const before = (await get(`/api/admin/events/${firstId}/detail`, acme)).body;
    await patch("/api/admin/event", acme).send({ name: "Dəyişdi" });
    const after = (await get(`/api/admin/events/${firstId}/detail`, acme)).body;
    expect(after.event).toEqual(before.event);
    expect(after.results).toEqual(before.results);
  });
});
