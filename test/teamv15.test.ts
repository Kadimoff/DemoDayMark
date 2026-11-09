// v15: (1) the coordinator limits how many times a signed-in team renames itself; (2) a teammate who joins with the
// team's link / the shared QR / a typed code writes a name and lands in the member list; (3) "Bütün QR-ları ləğv et"
// stops every team link, the shared link and unused juror QRs, while people already signed in stay signed in.
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../server/app.js";
import { loadConfig } from "../server/config.js";

let A: App;
let base: string;
let admin: string;
let teamId = 0;
let teamCookie = "";
let code = "";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-v15-"));
const webDir = path.join(tmp, "web");

const post = (p: string, cookie?: string) => { const r = request(base).post(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const patch = (p: string, cookie?: string) => { const r = request(base).patch(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const get = (p: string, cookie?: string) => (cookie ? request(base).get(p).set("Cookie", cookie) : request(base).get(p));
const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
const state = async (c = teamCookie) => (await get("/api/team/state", c)).body;

beforeAll(async () => {
  fs.mkdirSync(webDir, { recursive: true });
  for (const f of ["login", "admin", "juror", "timer", "reveal", "setup", "join", "team", "pult", "speaker", "root", "orgs", "programs", "qr"]) fs.writeFileSync(path.join(webDir, `${f}.html`), `<html>${f}</html>`);
  A = await buildApp(loadConfig({
    dataDir: tmp, dbFile: ":memory:", uploadsDir: path.join(tmp, "uploads"), backupDir: path.join(tmp, "backups"), webDir,
    adminUsername: "admin", adminPassword: "test-admin-123", origins: [], sessionSecret: "test-secret", soffice: "",
  }));
  await A.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(A.app.server.address() as AddressInfo).port}`;
  admin = cookieOf(await post("/api/auth/login").send({ username: "admin", password: "test-admin-123" }));
  teamId = (await post("/api/admin/teams", admin).send({ name: "Alfa", project: "Alfa layihə" })).body.id;
  const l = await post(`/api/admin/teams/${teamId}/link`, admin).send({});
  code = l.body.path.replace("/t/", "");
  const r = await post(`/api/auth/team/${code}`).send({ memberName: "Aysel Məmmədova" });
  expect(r.status, r.body.error).toBe(200);
  teamCookie = cookieOf(r);
});
afterAll(async () => { await A.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("members join with their name", () => {
  it("own link: the name lands in the member list once", async () => {
    expect((await state()).materials.members).toEqual(["Aysel Məmmədova"]);
    const r = await post(`/api/auth/team/${code}`).send({ memberName: "Rəşad  Quliyev" });
    expect(r.status).toBe(200);
    expect((await post(`/api/auth/team/${code}`).send({ memberName: "aysel məmmədova" })).status).toBe(200); // same person again
    expect((await state()).materials.members).toEqual(["Aysel Məmmədova", "Rəşad Quliyev"]);
    expect((await post(`/api/auth/team/${code}`).send({ memberName: "x".repeat(81) })).status).toBe(400);
  });
  it("typed code and the shared QR add the name too", async () => {
    expect((await post("/api/auth/team-code").send({ code, memberName: "Nigar Əliyeva" })).status).toBe(200);
    const b = (await post("/api/admin/teams", admin).send({ name: "Bəta", project: "" })).body.id;
    const shared = (await post("/api/admin/team-pick", admin).send({})).body.path.replace("/t/", "");
    const r = await post(`/api/auth/team/${shared}`).send({ teamId: b, memberName: "Elvin Həsənov" });
    expect(r.status, r.body.error).toBe(200);
    expect((await state(cookieOf(r))).materials.members).toEqual(["Elvin Həsənov"]);
    expect((await state()).materials.members).toContain("Nigar Əliyeva");
  });
});

describe("rename limit", () => {
  it("off: only the coordinator renames", async () => {
    expect((await patch("/api/team/profile", teamCookie).send({ name: "Alfa 2" })).status).toBe(403);
  });
  it("limit 1: one rename, then refused; the project still changes; null = no limit", async () => {
    const s = await patch("/api/admin/settings/teams", admin).send({ teamCanRename: true, teamRenameLimit: 1 });
    expect(s.status, s.body.error).toBe(200);
    expect(s.body.teamRenameLimit).toBe(1);
    expect((await state()).event.renamesLeft).toBe(1);
    const r1 = await patch("/api/team/profile", teamCookie).send({ name: "Alfa Pro" });
    expect(r1.status, r1.body.error).toBe(200);
    expect(r1.body.event.renamesLeft).toBe(0);
    const r2 = await patch("/api/team/profile", teamCookie).send({ name: "Alfa Max" });
    expect(r2.status).toBe(403);
    expect(r2.body.error).toMatch(/limit/);
    expect((await patch("/api/team/profile", teamCookie).send({ project: "Yeni layihə" })).status).toBe(200);
    expect((await patch("/api/team/profile", teamCookie).send({ name: "Alfa Pro", project: "Yeni layihə" })).status).toBe(200); // unchanged name is not a rename
    expect((await patch("/api/admin/settings/teams", admin).send({ teamRenameLimit: null })).status).toBe(200);
    expect((await state()).event.renamesLeft).toBeNull();
    expect((await patch("/api/team/profile", teamCookie).send({ name: "Alfa Max" })).status).toBe(200);
    expect((await patch("/api/admin/settings/teams", admin).send({ teamRenameLimit: 0 })).status).toBe(400);
  });
});

describe("revoke every QR", () => {
  it("team links, the shared link and unused juror QRs stop; signed-in people stay", async () => {
    const shared = (await post("/api/admin/team-pick", admin).send({})).body.path.replace("/t/", "");
    const j = await post("/api/admin/jurors", admin).send({});
    const inv = j.body.invite.path.replace("/j/", "");
    expect((await get(`/api/auth/invite/${inv}`)).body.valid).toBe(true);
    expect((await post("/api/admin/qr/revoke-all").send({})).status).toBe(401);
    const r = await post("/api/admin/qr/revoke-all", admin).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ shared: true });
    expect(r.body.teams).toBeGreaterThanOrEqual(1);
    expect(r.body.jurors).toBeGreaterThanOrEqual(1);
    expect((await get(`/api/auth/team/${code}`)).status).toBe(410);
    expect((await get(`/api/auth/team/${shared}`)).status).toBe(410);
    const iv = await get(`/api/auth/invite/${inv}`);
    expect(iv.status === 410 || iv.body.valid === false).toBe(true);
    expect((await get("/api/team/state", teamCookie)).status).toBe(200);
    expect((await get("/api/admin/materials", admin)).body.pick).toBeNull();
  });
});
