// v14: one shared link / QR for every team of the program. A team opens /t/<shared code>, picks its own name from the
// list and signs in; a picked (claimed) team cannot be picked again, the coordinator can reset a wrong pick, and a new
// shared link or switching it off stops the old one. The team's own code is on its panel for the teammates.
import Database from "better-sqlite3";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { openDb } from "../server/db.js";

let A: App;
let base: string;
let admin: string;
let ids: number[] = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-pick-"));
const webDir = path.join(tmp, "web");

const post = (p: string, cookie?: string) => { const r = request(base).post(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const del = (p: string, cookie?: string) => { const r = request(base).delete(p).set("Origin", base); return cookie ? r.set("Cookie", cookie) : r; };
const get = (p: string, cookie?: string) => (cookie ? request(base).get(p).set("Cookie", cookie) : request(base).get(p));
const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
const codeOf = (p: string) => p.replace("/t/", "");

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
  for (const n of ["Alfa", "Bəta", "Qamma"]) ids.push((await post("/api/admin/teams", admin).send({ name: n, project: `${n} layihə` })).body.id);
});
afterAll(async () => { await A.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe("shared team link", () => {
  let shared = "";

  it("admin only; creates a link that lists the active teams", async () => {
    expect((await post("/api/admin/team-pick").send({})).status).toBe(401);
    const r = await post("/api/admin/team-pick", admin).send({});
    expect(r.status, r.body.error).toBe(200);
    expect(r.body.path).toMatch(/^\/t\/[A-Z2-9]{12}$/);
    shared = codeOf(r.body.path);
    expect((await get("/api/admin/materials", admin)).body.pick).toEqual({ code: r.body.code, path: r.body.path });
    const info = await get(`/api/auth/team/${shared}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ valid: true, pick: true });
    expect(info.body.teams.filter((t: any) => ids.includes(t.id)).map((t: any) => [t.name, t.taken])).toEqual([["Alfa", false], ["Bəta", false], ["Qamma", false]]);
    // nothing private on the public list
    expect(Object.keys(info.body.teams[0]).sort()).toEqual(["id", "name", "project", "taken"]);
  });

  it("a team picks its name once; the second pick of the same team is refused", async () => {
    const r = await post(`/api/auth/team/${shared}`).send({ teamId: ids[0] });
    expect(r.status, r.body.error).toBe(200);
    expect(r.body).toMatchObject({ teamId: ids[0], redirect: "/team" });
    const st = await get("/api/team/state", cookieOf(r));
    expect(st.status).toBe(200);
    expect(st.body.team.name).toBe("Alfa");
    expect(st.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/); // teammates sign in with it
    expect((await post(`/api/auth/team-code`).send({ code: st.body.code })).status).toBe(200);

    const again = await post(`/api/auth/team/${shared}`).send({ teamId: ids[0] });
    expect(again.status).toBe(409);
    expect(again.headers["set-cookie"]).toBeUndefined();
    expect((await get(`/api/auth/team/${shared}`)).body.teams.find((t: any) => t.id === ids[0]).taken).toBe(true);
    // a team of another program / unknown id
    expect((await post(`/api/auth/team/${shared}`).send({ teamId: 999999 })).status).toBe(404);
    // without a team id: the page is told to show the list (also when the shared code is typed on /team)
    expect((await post(`/api/auth/team/${shared}`).send({})).body).toEqual({ pick: true, path: `/t/${shared}` });
    expect((await post(`/api/auth/team-code`).send({ code: shared })).body).toEqual({ pick: true, path: `/t/${shared}` });
  });

  it("signing in with the team's own link claims it too", async () => {
    const l = await post(`/api/admin/teams/${ids[1]}/link`, admin).send({});
    expect((await post(`/api/auth/team/${codeOf(l.body.path)}`).send({})).status).toBe(200);
    expect((await post(`/api/auth/team/${shared}`).send({ teamId: ids[1] })).status).toBe(409);
    const m = (await get("/api/admin/materials", admin)).body.teams;
    expect(m.filter((t: any) => t.claimedAt).map((t: any) => t.name).sort()).toEqual(["Alfa", "Bəta"]);
  });

  it("the coordinator resets a wrong pick", async () => {
    expect((await post(`/api/admin/teams/${ids[0]}/unclaim`).send({})).status).toBe(401);
    expect((await post(`/api/admin/teams/${ids[0]}/unclaim`, admin).send({})).status).toBe(200);
    expect((await post(`/api/auth/team/${shared}`).send({ teamId: ids[0] })).status).toBe(200);
  });

  it("a new link stops the old one; switching it off stops it", async () => {
    const r = await post("/api/admin/team-pick", admin).send({});
    const fresh = codeOf(r.body.path);
    expect(fresh).not.toBe(shared);
    expect((await get(`/api/auth/team/${shared}`)).status).toBe(410);
    expect((await post(`/api/auth/team/${shared}`).send({ teamId: ids[2] })).status).toBe(410);
    expect((await get(`/api/auth/team/${fresh}`)).status).toBe(200);
    expect((await del("/api/admin/team-pick", admin)).status).toBe(200);
    expect((await get(`/api/auth/team/${fresh}`)).status).toBe(410);
    expect((await get("/api/admin/materials", admin)).body.pick).toBeNull();
  });

  it("a new program switches the shared link off", async () => {
    const r = await post("/api/admin/team-pick", admin).send({});
    expect((await post("/api/admin/events", admin).send({ name: "Növbəti proqram", product: "", confirm: true })).status).toBe(200);
    expect((await get(`/api/auth/team/${codeOf(r.body.path)}`)).status).toBe(410);
  });
});

describe("v14 migration", () => {
  it("teams that signed in before count as claimed", () => {
    const file = path.join(os.tmpdir(), `ij-v14-${process.pid}-${Date.now()}.db`);
    openDb(file, { upTo: 13 }).close();
    const raw = new Database(file);
    raw.exec(`INSERT OR IGNORE INTO orgs (id, slug, name, created_at) VALUES (1, 'root', 'Root', 1);
      INSERT INTO teams (id, order_index, name, org_id, event_id) VALUES (1, 0, 'A', 1, 1), (2, 1, 'B', 1, 1);
      INSERT INTO team_sessions (id, team_id, created_at, last_seen_at, org_id, event_id) VALUES ('s1', 1, 500, 600, 1, 1), ('s2', 1, 400, 600, 1, 1);`);
    raw.close();
    const db = openDb(file);
    expect(db.prepare("SELECT id, claimed_at FROM teams ORDER BY id").all()).toEqual([{ id: 1, claimed_at: 400 }, { id: 2, claimed_at: null }]);
    expect(db.prepare("SELECT team_pick_hash, team_pick_enc FROM event").all().every((r: any) => r.team_pick_hash === null && r.team_pick_enc === null)).toBe(true);
    db.close();
    fs.rmSync(file, { force: true });
  });
});
