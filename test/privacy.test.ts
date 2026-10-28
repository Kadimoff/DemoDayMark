// Server-side privacy guarantees: jurors never see other jurors' data, totals or rankings.
import type { AddressInfo } from "node:net";
import { io as ioc, type Socket } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../server/app.js";
import { loadConfig } from "../server/config.js";

let A: App;
let base: string;
let adminCookie: string;
const jurorCookie: Record<string, string> = {};
const jurorId: Record<string, number> = {};
let criteriaKeys: string[] = [];
let teamIds: number[] = [];
const sockets: Socket[] = [];

const origin = () => base;
const post = (path: string, cookie?: string) => {
  const r = request(base).post(path).set("Origin", origin());
  return cookie ? r.set("Cookie", cookie) : r;
};
const get = (path: string, cookie?: string) => (cookie ? request(base).get(path).set("Cookie", cookie) : request(base).get(path));

async function login(username: string, password: string) {
  const res = await post("/api/auth/login").send({ username, password });
  expect(res.status).toBe(200);
  return (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
}

function socket(cookie?: string) {
  const role = cookie?.startsWith("ij_admin=") ? "admin" : cookie?.startsWith("ij_juror=") ? "juror" : undefined;
  const s = ioc(base, { transports: ["websocket"], extraHeaders: { origin: origin(), ...(cookie ? { cookie } : {}) }, auth: role ? { role } : {}, forceNew: true });
  sockets.push(s);
  return new Promise<Socket>((res, rej) => { s.on("connect", () => res(s)); s.on("connect_error", rej); });
}

const fullScore = (v: number) => ({ values: Object.fromEntries(criteriaKeys.map(k => [k, v])), note: `şərh ${v}` });

beforeAll(async () => {
  A = await buildApp(loadConfig({ dbFile: ":memory:", adminUsername: "admin", adminPassword: "admin-pass-123", origins: [], sessionSecret: "test-secret", webDir: "/nonexistent" }));
  await A.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(A.app.server.address() as AddressInfo).port}`;
  adminCookie = await login("admin", "admin-pass-123");
  for (const name of ["ali", "aysel"]) {
    const r = await post("/api/admin/jurors", adminCookie).send({ displayName: name === "ali" ? "Əli Məmmədov" : "Aysel Quliyeva", username: name, password: "parol-123" });
    expect(r.status).toBe(200);
    jurorId[name] = r.body.id;
    jurorCookie[name] = await login(name, "parol-123");
  }
  const st = await get("/api/juror/state", jurorCookie.ali);
  criteriaKeys = st.body.criteria.map((c: { key: string }) => c.key);
  teamIds = st.body.teams.map((t: { id: number }) => t.id);
});

afterAll(async () => {
  sockets.forEach(s => s.close());
  await A.close();
});

describe("role guards", () => {
  const adminGets = ["/api/admin/state", "/api/admin/results", "/api/admin/teams", "/api/admin/jurors", "/api/admin/criteria",
    "/api/admin/sessions", "/api/admin/audit", "/api/admin/export.xlsx", "/api/admin/export.pdf"];

  it("returns 403 for every admin endpoint called with a juror session", async () => {
    for (const p of adminGets) expect((await get(p, jurorCookie.ali)).status, p).toBe(403);
    expect((await request(base).patch("/api/admin/event").set("Origin", origin()).set("Cookie", jurorCookie.ali).send({ locked: true })).status).toBe(403);
    expect((await post("/api/admin/event/next", jurorCookie.ali)).status).toBe(403);
    expect((await request(base).delete("/api/admin/scores").set("Origin", origin()).set("Cookie", jurorCookie.ali).send({ token: "x" })).status).toBe(403);
  });

  it("returns 401 without a session", async () => {
    expect((await get("/api/juror/state")).status).toBe(401);
    expect((await get("/api/admin/results")).status).toBe(401);
  });

  it("does not let the admin act as a juror", async () => {
    expect((await get("/api/juror/state", adminCookie)).status).toBe(403);
  });

  it("ignores a juror cookie presented under the admin cookie name", async () => {
    const forged = jurorCookie.ali.replace(/^ij_juror=/, "ij_admin=");
    expect((await get("/api/admin/results", forged)).status).toBe(401);
  });

  it("rejects state-changing requests from a foreign origin", async () => {
    const r = await request(base).put(`/api/juror/scores/${teamIds[0]}`).set("Origin", "https://evil.example").set("Cookie", jurorCookie.ali).send(fullScore(5));
    expect(r.status).toBe(403);
    const r2 = await request(base).put(`/api/juror/scores/${teamIds[0]}`).set("Cookie", jurorCookie.ali).send(fullScore(5));
    expect(r2.status).toBe(403);
  });
});

describe("juror isolation", () => {
  it("never returns another juror's scores, totals or rankings", async () => {
    expect((await request(base).put(`/api/juror/scores/${teamIds[0]}`).set("Origin", origin()).set("Cookie", jurorCookie.aysel).send(fullScore(9))).status).toBe(200);
    const mine = await request(base).put(`/api/juror/scores/${teamIds[0]}`).set("Origin", origin()).set("Cookie", jurorCookie.ali).send(fullScore(4));
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBeUndefined(); // SHOW_JUROR_TOTAL defaults to false

    const st = await get("/api/juror/state", jurorCookie.ali);
    expect(st.status).toBe(200);
    const json = JSON.stringify(st.body);
    expect(st.body.myScores).toHaveLength(1);
    expect(st.body.myScores[0].values[criteriaKeys[0]]).toBe(4);
    expect(json).not.toContain("şərh 9");
    expect(json).not.toContain("Aysel");
    for (const k of ["results", "ranking", "matrix", "avg", "\"total\"", "jurors"]) expect(json).not.toContain(k);
  });

  it("delivers score events to the admin socket in under a second and to nobody else", async () => {
    const admin = await socket(adminCookie);
    const aysel = await socket(jurorCookie.aysel);
    const anon = await socket();
    const ayselEvents: Array<[string, unknown]> = [];
    const anonEvents: Array<[string, unknown]> = [];
    aysel.onAny((e, p) => ayselEvents.push([e, p]));
    anon.onAny((e, p) => anonEvents.push([e, p]));

    const got = new Promise<{ ms: number; payload: any }>(res => {
      const t0 = Date.now();
      admin.once("score:upserted", payload => res({ ms: Date.now() - t0, payload }));
    });
    const r = await request(base).put(`/api/juror/scores/${teamIds[1]}`).set("Origin", origin()).set("Cookie", jurorCookie.ali).send(fullScore(7));
    expect(r.status).toBe(200);
    const { ms, payload } = await got;
    expect(ms).toBeLessThan(1000);
    expect(payload).toMatchObject({ jurorId: jurorId.ali, teamId: teamIds[1], total: 70 });

    await new Promise(r => setTimeout(r, 300));
    const leaked = [...ayselEvents, ...anonEvents].filter(([e]) => ["score:upserted", "results:changed", "my-score:saved", "presence:changed"].includes(e));
    expect(leaked).toEqual([]);
    expect(JSON.stringify(ayselEvents)).not.toContain("şərh 7");
  });

  it("sends my-score:saved only to the juror who saved", async () => {
    const ali = await socket(jurorCookie.ali);
    const aysel = await socket(jurorCookie.aysel);
    let ayselGot = false;
    aysel.on("my-score:saved", () => { ayselGot = true; });
    const got = new Promise<any>(res => ali.once("my-score:saved", res));
    await request(base).put(`/api/juror/scores/${teamIds[2]}`).set("Origin", origin()).set("Cookie", jurorCookie.ali).send(fullScore(6));
    expect((await got).teamId).toBe(teamIds[2]);
    await new Promise(r => setTimeout(r, 200));
    expect(ayselGot).toBe(false);
  });

  it("validates scores: every criterion, integers 1–10", async () => {
    const put = (body: unknown) => request(base).put(`/api/juror/scores/${teamIds[3]}`).set("Origin", origin()).set("Cookie", jurorCookie.ali).send(body as object);
    const { [criteriaKeys[0]]: _skip, ...partial } = fullScore(5).values;
    expect((await put({ values: partial })).status).toBe(400);
    expect((await put({ values: { ...fullScore(5).values, [criteriaKeys[0]]: 11 } })).status).toBe(400);
    expect((await put({ values: { ...fullScore(5).values, [criteriaKeys[0]]: 2.5 } })).status).toBe(400);
    expect((await request(base).put("/api/juror/scores/99999").set("Origin", origin()).set("Cookie", jurorCookie.ali).send(fullScore(5))).status).toBe(404);
  });
});

describe("lock", () => {
  it("rejects juror writes while locked (423) and accepts them after unlocking", async () => {
    const patch = (locked: boolean) => request(base).patch("/api/admin/event").set("Origin", origin()).set("Cookie", adminCookie).send({ locked });
    expect((await patch(true)).status).toBe(200);
    const r = await request(base).put(`/api/juror/scores/${teamIds[0]}`).set("Origin", origin()).set("Cookie", jurorCookie.ali).send(fullScore(8));
    expect(r.status).toBe(423);
    expect((await patch(false)).status).toBe(200);
    expect((await request(base).put(`/api/juror/scores/${teamIds[0]}`).set("Origin", origin()).set("Cookie", jurorCookie.ali).send(fullScore(8))).status).toBe(200);
  });
});

describe("admin view", () => {
  it("sees every score, the ranking and the matrix", async () => {
    const r = await get("/api/admin/results", adminCookie);
    expect(r.status).toBe(200);
    expect(r.body.results.ranking[0].team.id).toBe(teamIds[0]); // (90 + 80) / 2 = 85
    expect(r.body.results.ranking[0].avg).toBe(85);
    expect(r.body.scores.some((s: any) => s.note === "şərh 9")).toBe(true);
  });

  it("exports xlsx and pdf with Azerbaijani file names", async () => {
    const x = await get("/api/admin/export.xlsx", adminCookie).buffer(true).parse((res, cb) => {
      const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c)));
    });
    expect(x.status).toBe(200);
    expect(x.headers["content-disposition"]).toMatch(/Ignite_DemoDay_.*_netice\.xlsx/);
    expect((x.body as Buffer).subarray(0, 2).toString()).toBe("PK");
    const p = await get("/api/admin/export.pdf", adminCookie).buffer(true).parse((res, cb) => {
      const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c)));
    });
    expect(p.status).toBe(200);
    expect((p.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("sessions", () => {
  it("ends a juror's sessions when the admin resets the password", async () => {
    const c = await login("aysel", "parol-123");
    const r = await request(base).patch(`/api/admin/jurors/${jurorId.aysel}`).set("Origin", origin()).set("Cookie", adminCookie).send({ password: "yeni-parol-1" });
    expect(r.status).toBe(200);
    expect((await get("/api/juror/state", c)).status).toBe(401);
    expect((await get("/api/juror/state", jurorCookie.aysel)).status).toBe(401);
    jurorCookie.aysel = await login("aysel", "yeni-parol-1");
  });
});

describe("admin and juror in one browser", () => {
  it("keeps both sessions; a refresh or a juror logout never drops the admin", async () => {
    const both = `${adminCookie}; ${jurorCookie.ali}`;
    expect((await get("/api/admin/state", both)).status).toBe(200);
    expect((await get("/api/juror/state", both)).status).toBe(200);
    const page = await get("/admin", both);
    expect(page.headers.location ?? "").not.toMatch(/login|juror/);
    const me = await get("/api/auth/me", both);
    expect(me.body.sessions.map((s: { role: string }) => s.role).sort()).toEqual(["admin", "juror"]);

    const extra = await login("ali", "parol-123");
    const out = await post("/api/auth/logout", `${adminCookie}; ${extra}`).send({ role: "juror" });
    expect(out.status).toBe(200);
    expect((await get("/api/juror/state", extra)).status).toBe(401);
    expect((await get("/api/admin/state", adminCookie)).status).toBe(200);
  });

  it("sets SameSite=Lax so links opened from messengers keep the session", async () => {
    const res = await post("/api/auth/login").send({ username: "ali", password: "parol-123" });
    expect(res.headers["set-cookie"][0]).toMatch(/^ij_juror=.*SameSite=Lax/i);
    expect(res.headers["set-cookie"][0]).toMatch(/HttpOnly/i);
  });
});

describe("results reveal", () => {
  const reveal = (action: string, cookie = adminCookie) => post("/api/admin/reveal", cookie).send({ action });

  it("is admin-only and shows no results before the admin allows it", async () => {
    expect((await reveal("enable", jurorCookie.ali)).status).toBe(403);
    expect((await request(base).post("/api/admin/reveal").set("Origin", origin()).send({ action: "enable" })).status).toBe(401);
    const pub = await get("/api/reveal");
    expect(pub.body).toMatchObject({ enabled: false, total: 0, revealed: [] });
    expect(JSON.stringify(pub.body)).not.toMatch(/Komanda \d/);
  });

  it("enabling freezes the ranking and locks scoring", async () => {
    const r = await reveal("enable");
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.locked).toBe(true);
    expect((await request(base).put(`/api/juror/scores/${teamIds[3]}`).set("Origin", origin()).set("Cookie", jurorCookie.ali).send(fullScore(5))).status).toBe(423);
  });

  it("each step publishes exactly one more place, lowest first; unrevealed names never leave the server", async () => {
    const adminView = (await get("/api/admin/reveal", adminCookie)).body;
    const names: string[] = adminView.entries.map((e: { name: string }) => e.name);
    expect(names.length).toBe(3); // three teams have complete scores in this test run
    let pub = (await get("/api/reveal")).body;
    expect(pub.revealed).toEqual([]);
    for (const n of names) expect(JSON.stringify(pub)).not.toContain(n);

    // Three scored teams are all "top three": suspense, then reveal, for 3rd, 2nd, 1st.
    expect((await reveal("next")).status).toBe(200);
    pub = (await get("/api/reveal")).body;
    expect(pub.suspense).toMatchObject({ index: 2, rank: 3 });
    for (const n of names) expect(JSON.stringify(pub)).not.toContain(n);

    await reveal("next");
    pub = (await get("/api/reveal")).body;
    expect(pub.revealed.map((e: { name: string }) => e.name)).toEqual([names[2]]);
    expect(JSON.stringify(pub)).not.toContain(names[0]);
    expect(JSON.stringify(pub)).not.toContain(names[1]);

    await reveal("back");
    expect((await get("/api/reveal")).body.revealed).toEqual([]);
  });

  it("pushes reveal:changed to anonymous screens", async () => {
    const anon = await socket();
    const got = new Promise<any>(res => anon.once("reveal:changed", res));
    await reveal("next");
    const p = await got;
    expect(p.revealed.length).toBe(1);
    await reveal("disable");
    expect((await get("/api/reveal")).body.enabled).toBe(false);
  });
});

describe("login rate limit", () => {
  it("locks a username+IP after 5 failed attempts, even for the right password", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post("/api/auth/login").send({ username: "ali", password: "wrong" })).status).toBe(401);
    }
    const r = await post("/api/auth/login").send({ username: "ali", password: "parol-123" });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/dəqiqə/);
  });
});
