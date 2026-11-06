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
let criteriaMax: Record<string, number> = {};
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

const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];

/** Scans a juror QR: the invite path's token is claimed with a typed name. */
async function claim(path: string, displayName: string) {
  const res = await post(`/api/auth/invite/${path.replace(/^\/j\//, "")}`).send({ displayName });
  expect(res.status).toBe(200);
  return cookieOf(res);
}
async function newQr(id: number) {
  const r = await post(`/api/admin/jurors/${id}/invite`, adminCookie).send({});
  expect(r.status).toBe(200);
  return r.body.invite.path as string;
}

function socket(cookie?: string) {
  const role = cookie?.startsWith("ij_admin=") ? "admin" : cookie?.startsWith("ij_juror=") ? "juror" : undefined;
  const s = ioc(base, { transports: ["websocket"], extraHeaders: { origin: origin(), ...(cookie ? { cookie } : {}) }, auth: role ? { role } : {}, forceNew: true });
  sockets.push(s);
  return new Promise<Socket>((res, rej) => { s.on("connect", () => res(s)); s.on("connect_error", rej); });
}

/** v on every criterion, capped at that criterion's maximum (the rubric mixes 5- and 10-point criteria). */
const fullScore = (v: number) => ({ values: Object.fromEntries(criteriaKeys.map(k => [k, Math.min(v, criteriaMax[k])])), note: `şərh ${v}` });

beforeAll(async () => {
  A = await buildApp(loadConfig({ dbFile: ":memory:", adminUsername: "admin", adminPassword: "admin-pass-123", origins: [], sessionSecret: "test-secret", webDir: "/nonexistent" }));
  await A.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(A.app.server.address() as AddressInfo).port}`;
  adminCookie = await login("admin", "admin-pass-123");
  for (const name of ["ali", "aysel"]) {
    const r = await post("/api/admin/jurors", adminCookie).send({});
    expect(r.status).toBe(200);
    expect(r.body.juror.displayName).toMatch(/^Münsif \d+$/);
    jurorId[name] = r.body.juror.id;
    jurorCookie[name] = await claim(r.body.invite.path, name === "ali" ? "Əli Məmmədov" : "Aysel Quliyeva");
  }
  const st = await get("/api/juror/state", jurorCookie.ali);
  criteriaKeys = st.body.criteria.map((c: { key: string }) => c.key);
  criteriaMax = Object.fromEntries(st.body.criteria.map((c: { key: string; maxScore: number }) => [c.key, c.maxScore]));
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
    for (const k of ["results", "ranking", "matrix", "avg", "\"total\"", "jurors", "demo", "score\""]) expect(json).not.toContain(k);
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
    expect(payload).toMatchObject({ jurorId: jurorId.ali, teamId: teamIds[1], total: 38 });

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
    const five = criteriaKeys.find(k => criteriaMax[k] === 5)!;
    const tooHigh = await put({ values: { ...fullScore(5).values, [five]: 6 } });
    expect(tooHigh.status).toBe(400);
    expect(tooHigh.body.error).toMatch(/1–5/);
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
    // team 0: aysel 9 → 5+9+9+9+9+5 = 46, ali 8 → 42; Demo Day 44; no entry score yet → final 44
    expect(r.body.results.ranking[0].score).toBe(44);
    expect(r.body.results.ranking[0].demo).toBe(44);
    expect([r.body.results.demoMax, r.body.results.maxTotal]).toEqual([50, 50]); // hackathon default: no entry score
    expect(r.body.scores.some((s: any) => s.note === "şərh 9")).toBe(true);
  });

  it("adds the entry score to the final score; jurors see entry scores but no results", async () => {
    const patch = (body: object) => request(base).patch(`/api/admin/teams/${teamIds[0]}`).set("Origin", origin()).set("Cookie", adminCookie).send(body);
    expect((await get("/api/juror/state", jurorCookie.ali)).body.includeEntry).toBe(false);
    expect((await request(base).patch("/api/admin/event").set("Origin", origin()).set("Cookie", adminCookie).send({ includeEntry: true })).status).toBe(200);
    expect((await patch({ entryScore: 125 / 3 })).status).toBe(200);
    let r = (await get("/api/admin/results", adminCookie)).body.results;
    let t0 = r.ranking.find((x: any) => x.team.id === teamIds[0]);
    expect([t0.entry, t0.demo, t0.score]).toEqual([125 / 3, 44, 85.67]);
    expect((await patch({ entryScore: 51 })).status).toBe(400); // above the 50-point entry maximum
    expect((await patch({ entryScore: -1 })).status).toBe(400);

    const st = (await get("/api/juror/state", jurorCookie.ali)).body;
    expect(st.teams.find((t: any) => t.id === teamIds[0]).entryScore).toBe(125 / 3);
    expect(st.entryMax).toBe(50);
    const js = JSON.stringify(st);
    for (const k of ["results", "ranking", "matrix", "demo", "85.67"]) expect(js).not.toContain(k);

    const toggle = (includeEntry: boolean) => request(base).patch("/api/admin/event").set("Origin", origin()).set("Cookie", adminCookie).send({ includeEntry });
    expect((await toggle(false)).status).toBe(200);
    r = (await get("/api/admin/results", adminCookie)).body.results;
    t0 = r.ranking.find((x: any) => x.team.id === teamIds[0]);
    expect([t0.score, r.maxTotal]).toEqual([44, 50]);
    expect((await patch({ entryScore: null })).status).toBe(200);
  });

  it("validates criterion maxima", async () => {
    const add = (body: object) => post("/api/admin/criteria", adminCookie).send(body);
    expect((await add({ name: "X", description: "", maxScore: 0 })).status).toBe(400);
    expect((await add({ name: "X", description: "", maxScore: 2.5 })).status).toBe(400);
  });

  it("refuses changes that would silently break stored data", async () => {
    // entry maximum below an entry score already given
    expect((await request(base).patch(`/api/admin/teams/${teamIds[1]}`).set("Origin", origin()).set("Cookie", adminCookie).send({ entryScore: 45 })).status).toBe(200);
    const lower = await request(base).patch("/api/admin/event").set("Origin", origin()).set("Cookie", adminCookie).send({ entryMax: 40 });
    expect(lower.status).toBe(400);
    expect((await get("/api/admin/state", adminCookie)).body.event.entryMax).toBe(50);
    expect((await request(base).patch(`/api/admin/teams/${teamIds[1]}`).set("Origin", origin()).set("Cookie", adminCookie).send({ entryScore: null })).status).toBe(200);

    // criterion maximum below points jurors already gave (aysel gave 9 on 10-point criteria)
    const crit = (await get("/api/admin/criteria", adminCookie)).body.find((c: any) => c.maxScore === 10);
    const patchMax = (q = "") => request(base).patch(`/api/admin/criteria/${crit.id}${q}`).set("Origin", origin()).set("Cookie", adminCookie).send({ maxScore: 8 });
    expect((await patchMax()).status).toBe(409);
    expect((await patchMax("?force=1")).status).toBe(200);
    expect((await request(base).patch(`/api/admin/criteria/${crit.id}`).set("Origin", origin()).set("Cookie", adminCookie).send({ maxScore: 10 })).status).toBe(200);
  });

  it("exports xlsx and pdf with Azerbaijani file names", async () => {
    const x = await get("/api/admin/export.xlsx", adminCookie).buffer(true).parse((res, cb) => {
      const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c)));
    });
    expect(x.status).toBe(200);
    expect(x.headers["content-disposition"]).toMatch(/Hakaton_.*_netice\.xlsx/);
    expect((x.body as Buffer).subarray(0, 2).toString()).toBe("PK");
    const p = await get("/api/admin/export.pdf", adminCookie).buffer(true).parse((res, cb) => {
      const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c)));
    });
    expect(p.status).toBe(200);
    expect((p.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("QR sign-in", () => {
  it("names the juror from the QR page and shows that name to the juror and the admin", async () => {
    const st = await get("/api/juror/state", jurorCookie.ali);
    expect(st.body.me.displayName).toBe("Əli Məmmədov");
    const list = await get("/api/admin/jurors", adminCookie);
    expect(list.body.find((j: any) => j.id === jurorId.ali)).toMatchObject({ displayName: "Əli Məmmədov", claimed: true });
  });

  it("tells the admin's socket the moment a juror joins", async () => {
    const admin = await socket(adminCookie);
    const r = await post("/api/admin/jurors", adminCookie).send({});
    const got = new Promise<any>(res => admin.once("juror:joined", res));
    await claim(r.body.invite.path, "Nigar Rzayeva");
    expect(await got).toEqual({ jurorId: r.body.juror.id, displayName: "Nigar Rzayeva" });
    expect((await request(base).delete(`/api/admin/jurors/${r.body.juror.id}`).set("Origin", origin()).set("Cookie", adminCookie)).status).toBe(200);
  });

  it("uses each QR only once", async () => {
    const path = await newQr(jurorId.aysel);
    const first = await post(`/api/auth/invite/${path.slice(3)}`).send({ displayName: "Aysel Quliyeva" });
    expect(first.status).toBe(200);
    jurorCookie.aysel = cookieOf(first);
    const again = await post(`/api/auth/invite/${path.slice(3)}`).send({ displayName: "Başqa Adam" });
    expect(again.status).toBe(410);
    expect(again.body.error).toMatch(/artıq istifadə/);
    expect((await get(`/api/auth/invite/${path.slice(3)}`)).status).toBe(410);
    expect((await get("/api/juror/state", jurorCookie.aysel)).body.me.displayName).toBe("Aysel Quliyeva");
  });

  it("a new QR for the same juror replaces the unused old one and keeps the juror's scores", async () => {
    const old = await newQr(jurorId.ali);
    const fresh = await newQr(jurorId.ali);
    expect((await get(`/api/auth/invite/${old.slice(3)}`)).status).toBe(410);
    const info = await get(`/api/auth/invite/${fresh.slice(3)}`);
    expect(info.body).toMatchObject({ valid: true, currentName: "Əli Məmmədov" });
    const c = await claim(fresh, "Əli Məmmədov");
    const st = await get("/api/juror/state", c);
    expect(st.body.me.id).toBe(jurorId.ali);
    expect(st.body.myScores.length).toBeGreaterThan(0);
  });

  it("rejects unknown, expired and deactivated-juror QRs", async () => {
    expect((await post("/api/auth/invite/not-a-real-token-but-long-enough").send({ displayName: "X Y" })).status).toBe(410);
    const path = await newQr(jurorId.aysel);
    A.ctx.repo.db.prepare("UPDATE juror_invites SET expires_at = 1 WHERE used_at IS NULL AND revoked_at IS NULL").run();
    const expired = await post(`/api/auth/invite/${path.slice(3)}`).send({ displayName: "Aysel Quliyeva" });
    expect([expired.status, expired.body.error]).toEqual([410, expect.stringMatching(/vaxtı bitib/)]);

    const path2 = await newQr(jurorId.aysel);
    const off = (active: boolean) => request(base).patch(`/api/admin/jurors/${jurorId.aysel}`).set("Origin", origin()).set("Cookie", adminCookie).send({ active });
    expect((await off(false)).status).toBe(200);
    expect((await get("/api/juror/state", jurorCookie.aysel)).status).toBe(401); // sessions ended
    expect((await post(`/api/auth/invite/${path2.slice(3)}`).send({ displayName: "Aysel Quliyeva" })).status).toBe(410);
    expect((await off(true)).status).toBe(200);
    jurorCookie.aysel = await claim(await newQr(jurorId.aysel), "Aysel Quliyeva");
  });

  it("refuses password sign-in for jurors", async () => {
    const u = A.ctx.repo.userById(jurorId.ali)!;
    const { hashPassword } = await import("../server/baseline.js");
    A.ctx.repo.updateUser(u.id, { passwordHash: await hashPassword("legacy-pass-1") }); // a juror from before QR sign-in
    const r = await post("/api/auth/login").send({ username: u.username, password: "legacy-pass-1" });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/QR/);
  });
});

describe("live progress, tags and nudges", () => {
  it("sends the admin only the count of filled criteria, never the points", async () => {
    const admin = await socket(adminCookie);
    const ali = await socket(jurorCookie.ali);
    const aysel = await socket(jurorCookie.aysel);
    const ayselEvents: string[] = [];
    aysel.onAny(e => ayselEvents.push(e));
    const got = new Promise<any>(res => admin.on("progress:changed", (p: any[]) => { if (p.some(x => x.teamId === teamIds[4])) res(p); }));
    ali.emit("draft:progress", { teamId: teamIds[4], filled: 3, values: { secret: 9 } });
    const p = await got;
    expect(p.find((x: any) => x.teamId === teamIds[4])).toMatchObject({ jurorId: jurorId.ali, filled: 3 });
    expect(JSON.stringify(p)).not.toContain("secret");
    await new Promise(r => setTimeout(r, 200));
    expect(ayselEvents).not.toContain("progress:changed");
  });

  it("stores only listed feedback tags, privately", async () => {
    const tags = (await get("/api/juror/state", jurorCookie.ali)).body.feedbackTags as string[];
    expect(tags.length).toBeGreaterThan(2);
    const r = await request(base).put(`/api/juror/scores/${teamIds[2]}`).set("Origin", origin()).set("Cookie", jurorCookie.ali)
      .send({ ...fullScore(6), tags: [tags[1], "uydurma etiket", tags[0]] });
    expect(r.status).toBe(200);
    expect(r.body.tags).toEqual([tags[0], tags[1]]);
    const other = (await get("/api/juror/state", jurorCookie.aysel)).body;
    expect(JSON.stringify(other.myScores)).not.toContain(tags[1]);
    const admin = (await get("/api/admin/results", adminCookie)).body;
    expect(admin.scores.find((s: any) => s.teamId === teamIds[2] && s.jurorId === jurorId.ali).tags).toEqual([tags[0], tags[1]]);
  });

  it("nudges only jurors who have not scored the team on stage", async () => {
    const setStage = (id: number | null) => request(base).patch("/api/admin/event").set("Origin", origin()).set("Cookie", adminCookie).send({ currentTeamId: id });
    expect((await setStage(teamIds[2])).status).toBe(200);
    const ali = await socket(jurorCookie.ali);
    const aysel = await socket(jurorCookie.aysel);
    let aliGot = false;
    ali.on("nudge", () => { aliGot = true; });
    const got = new Promise<any>(res => aysel.once("nudge", res));
    const r = await post("/api/admin/nudge", adminCookie).send({});
    expect(r.status).toBe(200);
    expect(r.body.nudged).toBe(1);
    expect(await got).toMatchObject({ teamId: teamIds[2] });
    await new Promise(r => setTimeout(r, 200));
    expect(aliGot).toBe(false);
    expect((await post("/api/admin/nudge", jurorCookie.ali).send({})).status).toBe(403);
    await setStage(null);
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

    const extra = await claim(await newQr(jurorId.ali), "Əli Məmmədov");
    const out = await post("/api/auth/logout", `${adminCookie}; ${extra}`).send({ role: "juror" });
    expect(out.status).toBe(200);
    expect((await get("/api/juror/state", extra)).status).toBe(401);
    expect((await get("/api/admin/state", adminCookie)).status).toBe(200);
  });

  it("sets SameSite=Lax so links opened from messengers keep the session", async () => {
    const r = await post(`/api/auth/invite/${(await newQr(jurorId.ali)).slice(3)}`).send({ displayName: "Əli Məmmədov" });
    const res = r;
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

describe("hackathon results controls", () => {
  const adminPatch = (body: object) => request(base).patch("/api/admin/event").set("Origin", origin()).set("Cookie", adminCookie).send(body);
  it("hides scores on the public reveal when the admin says so", async () => {
    expect((await post("/api/admin/reveal", adminCookie).send({ action: "enable" })).status).toBe(200);
    await post("/api/admin/reveal", adminCookie).send({ action: "reset" });
    await post("/api/admin/reveal", adminCookie).send({ action: "next" });
    await post("/api/admin/reveal", adminCookie).send({ action: "next" });
    await post("/api/admin/reveal", adminCookie).send({ action: "next" });
    expect((await get("/api/reveal")).body.revealed[0].score).toEqual(expect.any(Number));
    expect((await adminPatch({ revealHideScores: true })).status).toBe(200);
    const pub = (await get("/api/reveal")).body;
    expect(pub.hideScores).toBe(true);
    expect(pub.revealed.length).toBeGreaterThan(0);
    expect(pub.revealed.every((e: any) => e.score === null && e.demo === null)).toBe(true);
    expect((await adminPatch({ revealHideScores: false })).status).toBe(200);
    expect((await adminPatch({ revealHideScores: true })).status).toBe(200);
    expect((await adminPatch({ revealHideScores: true }).set("Cookie", jurorCookie.ali)).status).toBe(403);
    await adminPatch({ revealHideScores: false });
  });

  it("uses the jurors' final order for the reveal", async () => {
    const before = (await get("/api/admin/reveal", adminCookie)).body.entries.map((e: any) => e.teamId);
    const flipped = [...before].reverse();
    expect((await request(base).put("/api/admin/final-order").set("Origin", origin()).set("Cookie", adminCookie).send({ ids: flipped })).status).toBe(200);
    expect((await request(base).put("/api/admin/final-order").set("Origin", origin()).set("Cookie", jurorCookie.ali).send({ ids: flipped })).status).toBe(403);
    expect((await request(base).put("/api/admin/final-order").set("Origin", origin()).set("Cookie", adminCookie).send({ ids: [99999] })).status).toBe(400);
    const r = (await post("/api/admin/reveal", adminCookie).send({ action: "reset" })).body;
    expect(r.entries.map((e: any) => e.teamId)).toEqual(flipped);
    expect(r.entries.map((e: any) => e.rank)).toEqual(flipped.map((_: number, i: number) => i + 1));
    expect(r.manual).toBe(true);
    await request(base).put("/api/admin/final-order").set("Origin", origin()).set("Cookie", adminCookie).send({ ids: null });
    expect((await post("/api/admin/reveal", adminCookie).send({ action: "reset" })).body.entries.map((e: any) => e.teamId)).toEqual(before);
    await post("/api/admin/reveal", adminCookie).send({ action: "disable" });
  });

  it("changes the event type and pushes timer corrections and new durations to every screen", async () => {
    expect((await adminPatch({ product: "DemoDay" })).body.stage.eventName).toBe("DemoDay");
    expect((await adminPatch({ product: "Hakaton" })).body.stage.eventName).toBe("Hakaton");
    expect((await adminPatch({ product: "Konfrans" })).status).toBe(400);
    const anon = await socket();
    const got = new Promise<any>(res => anon.once("stage:changed", res));
    await adminPatch({ pitchSec: 240 });
    expect((await got).timer.pitchSec).toBe(240);
    await adminPatch({ currentTeamId: teamIds[0] });
    await adminPatch({ timer: "pitch" });
    const t = (await adminPatch({ timerSet: 30 })).body.stage.timer;
    expect(t.pitchSec - t.offsetSec).toBeGreaterThan(29);
    expect(t.pitchSec - t.offsetSec).toBeLessThanOrEqual(30);
    await adminPatch({ pitchSec: 180, currentTeamId: null });
  });
});

describe("login rate limit", () => {
  it("locks a username+IP after 5 failed attempts, even for the right password", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post("/api/auth/login").send({ username: "admin", password: "wrong" })).status).toBe(401);
    }
    const r = await post("/api/auth/login").send({ username: "admin", password: "admin-pass-123" });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/dəqiqə/);
  });
});
