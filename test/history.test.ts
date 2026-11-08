// Scoring history: every submit and change lands in score_history and stays there after wipes and deletions.
import Database from "better-sqlite3";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { openDb, SCHEMA_VERSION } from "../server/db.js";
import { Repo } from "../server/repo.js";
import type { HistoryPage } from "../shared/types.js";

let A: App;
let base: string;
let admin: string;
let juror: string;
let jurorId: number;
let crit: Array<{ key: string; maxScore: number; name: string }>;
let teams: number[];

const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
const post = (p: string, c: string) => request(base).post(p).set("Origin", base).set("Cookie", c);
const put = (team: number, v: number, note = "") =>
  request(base).put(`/api/juror/scores/${team}`).set("Origin", base).set("Cookie", juror)
    .send({ values: Object.fromEntries(crit.map(c => [c.key, Math.min(v, c.maxScore)])), note });
const hist = async (q = "") => (await request(base).get(`/api/admin/history${q}`).set("Cookie", admin)).body as HistoryPage;

beforeAll(async () => {
  A = await buildApp(loadConfig({ dbFile: ":memory:", adminUsername: "admin", adminPassword: "admin-pass-123", origins: [], sessionSecret: "test-secret", webDir: "/nonexistent" }));
  await A.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(A.app.server.address() as AddressInfo).port}`;
  admin = cookieOf(await request(base).post("/api/auth/login").set("Origin", base).send({ username: "admin", password: "admin-pass-123" }));
  const r = await post("/api/admin/jurors", admin).send({});
  jurorId = r.body.juror.id;
  juror = cookieOf(await request(base).post(`/api/auth/invite/${r.body.invite.path.replace(/^\/j\//, "")}`).set("Origin", base).send({ displayName: "Rəşad Əliyev" }));
  const st = await request(base).get("/api/juror/state").set("Cookie", juror);
  crit = st.body.criteria; teams = st.body.teams.map((t: { id: number }) => t.id);
});
afterAll(async () => { await A.close(); });

describe("scoring history", () => {
  it("keeps the first submit and each change with the previous values", async () => {
    expect((await put(teams[0], 3)).status).toBe(200);
    expect((await put(teams[0], 5, "daha yaxşı")).status).toBe(200);
    const h = await hist();
    expect(h.total).toBe(2);
    const [upd, sub] = h.rows;
    expect(sub).toMatchObject({ kind: "submit", jurorName: "Rəşad Əliyev", jurorId, teamId: teams[0], prevTotal: null });
    expect(sub.values.every(v => v.prev === undefined)).toBe(true);
    expect(upd.kind).toBe("update");
    expect(upd.values.map(v => [v.v, v.prev])).toEqual(crit.map(c => [Math.min(5, c.maxScore), Math.min(3, c.maxScore)]));
    expect(upd.prevTotal).toBe(sub.total);
    expect(upd.note).toBe("daha yaxşı");
    expect(upd.prevNote).toBe("");
    expect(upd.values[0].name).toBe(crit[0].name);
  });

  it("filters by juror and team, pages with ?before", async () => {
    await put(teams[1], 4);
    expect((await hist(`?team=${teams[1]}`)).rows.map(r => r.teamId)).toEqual([teams[1]]);
    expect((await hist(`?juror=${jurorId}`)).total).toBe(3);
    const p1 = await hist("?limit=2");
    expect(p1.more).toBe(true);
    const p2 = await hist(`?limit=2&before=${p1.rows[1].id}`);
    expect(p2.rows).toHaveLength(1);
    expect(p2.more).toBe(false);
    expect(p1.teams.map(t => t.id).sort()).toEqual([teams[0], teams[1]].sort());
  });

  it("survives a wipe: old rows stay, a marker is added, the next submit is not a diff", async () => {
    const tok = (await post("/api/admin/scores/wipe-token", admin).send({})).body.token;
    expect((await request(base).delete("/api/admin/scores").set("Origin", base).set("Cookie", admin).send({ token: tok })).status).toBe(200);
    let h = await hist();
    expect(h.rows[0]).toMatchObject({ kind: "wipe", count: 2, actorName: "Koordinator" });
    expect(h.total).toBe(4);
    await put(teams[0], 2);
    h = await hist(`?team=${teams[0]}`);
    expect(h.rows[0]).toMatchObject({ kind: "submit", prevTotal: null });
    expect(h.rows).toHaveLength(3);
  });

  it("keeps a deleted team's history under its old name", async () => {
    const r = await post("/api/admin/teams", admin).send({ name: "Silinəcək", project: "" });
    await put(r.body.id, 3);
    expect((await request(base).delete(`/api/admin/teams/${r.body.id}?force=1`).set("Origin", base).set("Cookie", admin)).status).toBe(200);
    const h = await hist();
    expect(h.rows[0]).toMatchObject({ kind: "team.delete", teamName: "Silinəcək", count: 1 });
    expect(h.rows[1]).toMatchObject({ kind: "submit", teamName: "Silinəcək" });
  });

  it("is in the Excel export", async () => {
    const r = await request(base).get("/api/admin/export.xlsx").set("Cookie", admin).buffer(true).parse((res, cb) => {
      const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c)));
    });
    expect(r.status).toBe(200);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body);
    const ws = wb.getWorksheet("Tarixçə")!;
    expect(ws.rowCount).toBeGreaterThan(5);
    expect(ws.getRow(2).getCell(2).value).toBe("Göndərildi");
  });
});

describe("migration v7 backfill", () => {
  it("copies old submits, changes and wipes from the audit log", () => {
    const file = `/tmp/ij-hist-${process.pid}-${Date.now()}.db`;
    openDb(file, { upTo: 7 }).close(); // schema as of v7; later versions are replayed below
    const raw = new Database(file);
    raw.exec("DROP TABLE score_history");
    raw.exec(`INSERT INTO users (id, role, username, display_name, password_hash, created_at) VALUES (9, 'juror', 'j9', 'Leyla', 'x', 1);
      INSERT INTO teams (id, order_index, name) VALUES (4, 0, 'Pycore');
      INSERT INTO criteria (order_index, key, name, weight, max_score) VALUES (0, 'mvp', 'MVP', 0, 30);
      INSERT INTO audit_log (actor_id, action, payload_json, created_at) VALUES
        (9, 'score.submit', '{"teamId":4,"values":{"mvp":20},"total":20,"note":"","tags":[]}', 10),
        (9, 'score.update', '{"teamId":4,"values":{"mvp":25},"total":25,"note":"ok","tags":["Güclü komanda"]}', 20),
        (77, 'score.submit', '{"teamId":99,"values":{"old":3},"total":3,"note":"","tags":[]}', 25),
        (null, 'scores.wipe', '{"deleted":2}', 30);`);
    raw.pragma("user_version = 6");
    raw.close();
    const db = openDb(file);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const h = new Repo(db).history();
    expect(h.rows.map(r => r.kind)).toEqual(["wipe", "submit", "update", "submit"]);
    expect(h.rows[2]).toMatchObject({ jurorName: "Leyla", teamName: "Pycore", total: 25, prevTotal: 20, tags: ["Güclü komanda"] });
    expect(h.rows[2].values).toEqual([{ key: "mvp", name: "MVP", max: 30, v: 25, prev: 20 }]);
    expect(h.rows[1]).toMatchObject({ jurorName: "Münsif #77", teamName: "Komanda #99" });
    db.close();
  });
});
