// v13: the organiser types the event's whole name ("IDDA Hakaton 2026"); no brand prefix + "Hakaton"/"DemoDay" type.
// Existing rows keep the name they showed; setup and "Yeni proqram" store the name exactly as typed.
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
import { Repo } from "../server/repo.js";
import { brandName } from "../shared/brand.js";

describe("brandName", () => {
  it("free name is shown as typed; older prefix + type rows still read the same", () => {
    expect(brandName("IDDA Hakaton 2026", "")).toBe("IDDA Hakaton 2026");
    expect(brandName("  ", "")).toBe("Tədbir");
    expect(brandName("IDDA", "DemoDay")).toBe("IDDA DemoDay");
    expect(brandName("", "Hakaton")).toBe("Hakaton");
  });
});

describe("v13 migration", () => {
  it("turns prefix + type into the full name it showed, product ''", () => {
    const file = path.join(os.tmpdir(), `ij-v13-${process.pid}-${Date.now()}.db`);
    openDb(file, { upTo: 12 }).close();
    const raw = new Database(file);
    raw.exec(`INSERT OR IGNORE INTO orgs (id, slug, name, created_at) VALUES (1, 'root', 'Root', 1);
      INSERT INTO orgs (id, slug, name, created_at) VALUES (2, 'idda', 'IDDA', 1), (3, 'x', 'X', 1);
      DELETE FROM event WHERE org_id IN (1, 2, 3);
      INSERT INTO event (org_id, name, date, product) VALUES (1, 'TechConnect', '07.11.2026', 'Hakaton'), (2, 'IDDA', '08.11.2026', 'DemoDay'), (3, '', '08.11.2026', 'DemoDay');`);
    raw.close();
    const db = openDb(file);
    const rows = db.prepare("SELECT org_id, name, product FROM event ORDER BY org_id").all();
    expect(rows).toEqual([
      { org_id: 1, name: "TechConnect Hakaton", product: "" },
      { org_id: 2, name: "IDDA DemoDay", product: "" },
      { org_id: 3, name: "DemoDay", product: "" },
    ]);
    expect(new Repo(db, 2, "idda").getEvent().displayName).toBe("IDDA DemoDay");
    db.close();
    fs.rmSync(file, { force: true });
  });
});

describe("setup and new program use the typed name", () => {
  let A: App;
  let base: string;
  let admin: string;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ddm-evname-"));
  const webDir = path.join(tmp, "web");
  const post = (p: string) => request(base).post(p).set("Origin", base).set("Cookie", admin);
  const patch = (p: string) => request(base).patch(p).set("Origin", base).set("Cookie", admin);

  beforeAll(async () => {
    fs.mkdirSync(webDir, { recursive: true });
    for (const f of ["login", "admin", "juror", "timer", "reveal", "setup", "join", "team", "pult", "speaker", "root", "orgs", "programs", "qr"]) fs.writeFileSync(path.join(webDir, `${f}.html`), `<html>${f}</html>`);
    A = await buildApp(loadConfig({
      dataDir: tmp, dbFile: ":memory:", uploadsDir: path.join(tmp, "uploads"), backupDir: path.join(tmp, "backups"), webDir,
      adminUsername: "admin", adminPassword: "test-admin-123", origins: [], sessionSecret: "test-secret", soffice: "",
    }));
    await A.app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(A.app.server.address() as AddressInfo).port}`;
    const r = await request(base).post("/api/auth/login").set("Origin", base).send({ username: "admin", password: "test-admin-123" });
    expect(r.status, r.body.error).toBe(200);
    admin = (r.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
  });
  afterAll(async () => { await A.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it("PATCH name + product '' → every screen gets exactly that name", async () => {
    const r = await patch("/api/admin/event").send({ name: "IDDA Hakaton 2026", product: "" });
    expect(r.status, r.body.error).toBe(200);
    expect(r.body.stage.eventName).toBe("IDDA Hakaton 2026");
    expect((await request(base).get("/api/stage")).body.eventName).toBe("IDDA Hakaton 2026");
    expect((await patch("/api/admin/event").send({ name: "x".repeat(61), product: "" })).status).toBe(400);
    const list = (await request(base).get("/api/admin/events").set("Cookie", admin)).body;
    expect(list[0]).toMatchObject({ status: "active", name: "IDDA Hakaton 2026" });
  });

  it("the list shows the active program's current name even if its events row is stale", async () => {
    A.ctx.orgs.db.prepare("UPDATE events SET name = 'Köhnə ad' WHERE status = 'active'").run();
    const list = (await request(base).get("/api/admin/events").set("Cookie", admin)).body;
    expect(list[0]).toMatchObject({ status: "active", name: "IDDA Hakaton 2026" });
  });

  it("Yeni proqram: the typed name, nothing appended", async () => {
    const r = await post("/api/admin/events").send({ name: "Startap Həftəsi", product: "", confirm: true });
    expect(r.status, r.body.error).toBe(200);
    const list = (await request(base).get("/api/admin/events").set("Cookie", admin)).body;
    expect(list[0]).toMatchObject({ status: "active", name: "Startap Həftəsi" });
    expect(list[1]).toMatchObject({ status: "archived", name: "IDDA Hakaton 2026" });
    expect((await request(base).get("/api/stage")).body.eventName).toBe("Startap Həftəsi");
  });
});
