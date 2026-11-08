// orgs: platform owner ("root") API — organisations and their coordinator accounts. Coordinators get 403 here.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ORG_COOKIE, requireRoot } from "../auth.js";
import { hashPassword } from "../baseline.js";
import { idParam, parseBody, type Ctx } from "../context.js";
import { orgOut, RESERVED_SLUGS, ROOT_ORG_ID, SLUG_RE } from "../orgs.js";
import { PASSWORD_MIN } from "./auth.js";
import { adminResults } from "../views.js";
import { listEvents } from "../events.js";
import { sendHistory } from "./admin.js";
import { systemStatus } from "../health.js";
import { importArchive, ImportError, importLedger, scanBackups } from "../archive.js";
import { onlineBackup } from "../backups.js";

const slug = z.string().trim().toLowerCase()
  .refine(v => SLUG_RE.test(v), "Qısa ad (slug) yalnız kiçik latın hərfləri, rəqəmlər və tire ola bilər (2–32 simvol).")
  .refine(v => !RESERVED_SLUGS.has(v), "Bu qısa ad sistem üçün ayrılıb, başqasını seçin.");
const orgName = z.string().trim().min(2, "Təşkilatın adını yazın.").max(40, "Ad 40 simvoldan uzun ola bilməz.");
const username = z.string().trim().min(2, "İstifadəçi adı ən azı 2 simvol olmalıdır.").max(64)
  .refine(v => /^[\p{L}\p{N}._-]+$/u.test(v), "İstifadəçi adında yalnız hərf, rəqəm, nöqtə, tire və alt xətt ola bilər.");
const password = z.string().min(PASSWORD_MIN, `Şifrə ən azı ${PASSWORD_MIN} simvol olmalıdır.`).max(200);
const coordBody = z.object({ username, password, displayName: z.string().trim().min(1).max(80).optional() });
const createBody = z.object({ slug, name: orgName, coordinator: coordBody.optional() });
const patchBody = z.object({ name: orgName.optional(), active: z.boolean().optional() });
const resetBody = z.object({ password });
const userPatch = z.object({ active: z.boolean() });
const impersonateBody = z.object({ orgId: z.number().int().positive().nullable() });
const importBody = z.object({
  file: z.string().min(1).max(220), sourceOrgId: z.number().int().positive(), sourceEventId: z.number().int().positive(),
  targetOrgId: z.number().int().positive(), audit: z.boolean().optional(),
});

export function rootRoutes(app: FastifyInstance, ctx: Ctx) {
  const { orgs, cfg, rt } = ctx;
  const root = orgs.root.repo;

  const view = (id: number) => {
    const o = orgs.byId(id)!;
    const st = orgs.stats(id);
    const ev = orgs.scope(id).repo.getEvent();
    return { ...orgOut(o), eventName: ev.displayName, teams: st.teams, jurors: st.jurors, scores: st.scores,
      coordinators: st.coordinators.map(c => ({ id: c.id, username: c.username, displayName: c.displayName, active: !!c.active, root: !!c.isRoot })),
      links: o.id === ROOT_ORG_ID ? { stage: "/stage", reveal: "/reveal", team: "/team" } : { stage: `/o/${o.slug}/stage`, reveal: `/o/${o.slug}/reveal`, team: `/o/${o.slug}/team` } };
  };
  /** Ends every session and socket of the organisation's coordinators, jurors and teams. */
  const signOutOrg = (id: number) => {
    const users = root.db.prepare("SELECT id FROM users WHERE org_id = ? AND is_root = 0").all(id) as Array<{ id: number }>;
    for (const u of users) { root.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id); rt.io.in(`user:${u.id}`).disconnectSockets(true); }
    const teams = root.db.prepare("SELECT id FROM teams WHERE org_id = ?").all(id) as Array<{ id: number }>;
    root.db.prepare("DELETE FROM team_sessions WHERE org_id = ?").run(id);
    for (const t of teams) rt.io.in(`team:${t.id}`).disconnectSockets(true);
  };
  const coordinator = (id: number) => {
    const u = root.userById(id);
    return u && u.role === "admin" && !u.is_root ? u : null;
  };

  app.register(async r => {
    r.addHook("preHandler", requireRoot);

    r.get("/api/root/orgs", async () => orgs.list().map(o => view(o.id)));

    // v11: "Sistem vəziyyəti" — health of the platform (database, backups, sockets, event loop) and, per organisation,
    // live connections and how many score ops were applied / refused / retried. No names or scores.
    r.get("/api/root/system", async () => systemStatus(ctx.sys, {
      orgs: orgs.list().filter(o => o.active).map(o => {
        const sc = orgs.scope(o.id);
        return { id: o.id, slug: o.slug, name: o.name, screens: rt.roomSize(`o${o.id}:public`), jurors: rt.roomSize(`o${o.id}:jurors`), admins: rt.roomSize(`o${o.id}:admin`),
          ops: sc.repo.scoreOpStats() };
      }),
    }));
    // v11: run a backup now (before a risky change, before the reveal).
    r.post("/api/root/backup", async (req, reply) => {
      const f = await ctx.sys.backups.run(true);
      if (!f) return reply.code(500).send({ error: ctx.sys.backups.status().lastError ?? "Yedək alınmadı." });
      root.audit(req.user!.id, "system.backup", { file: f.split(/[\\/]/).pop() });
      return systemStatus(ctx.sys);
    });

    // v4: "Yedəkdən import" — every backup file with a summary of its programs (names and counts only; the files are
    // copied to a temp file and read there, the backups themselves are never opened in place).
    r.get("/api/root/backups", async () => ({
      files: scanBackups(cfg.backupDir),
      imports: importLedger(orgs.db),
      auto: ctx.sys.archiveImport ?? null,
    }));
    // Imports one program of a backup into an organisation as a new ARCHIVED program (never into the active one).
    r.post("/api/root/backups/import", async (req, reply) => {
      const b = parseBody(importBody, req.body, reply); if (!b) return;
      if (!orgs.byId(b.targetOrgId)) return reply.code(404).send({ error: "Təşkilat tapılmadı." });
      try {
        // a consistent copy of the live database first (pre-import-*.db), then the import in one transaction
        await onlineBackup(orgs.db, cfg.backupDir, "pre-import");
        const res = importArchive(orgs.db, cfg, { ...b, actorId: req.user!.id });
        orgs.scope(b.targetOrgId).rt.to("admin").emit("events:changed", {});
        return res;
      } catch (e) {
        if (e instanceof ImportError) return reply.code(e.status).send({ error: e.message, ...e.extra });
        throw e;
      }
    });

    // v3: the platform panel (/root) — every organisation with its live state (stage team, timer, counts). Public stage
    // data plus counts only: no scores, names of jurors or files leave an organisation here.
    r.get("/api/root/overview", async () => orgs.list().map(o => {
      const sc = orgs.scope(o.id);
      const st = orgs.stats(o.id);
      const stage = sc.repo.stage();
      const ids = new Set(sc.repo.jurors().filter(j => j.active).map(j => j.id));
      return {
        ...view(o.id), events: st.events, eventId: sc.eventId, stage,
        jurorsOnline: [...ids].filter(id => rt.isOnline(id)).length,
        progress: (() => { const r0 = adminResults(sc.repo, cfg).results; return { done: r0.done, need: r0.need }; })(),
      };
    }));
    // "Proyektoruna bax": the organisation's stage as its projector sees it (read-only).
    r.get("/api/root/orgs/:id/stage", async (req, reply) => {
      const p = idParam.safeParse(req.params); if (!p.success) return reply.code(400).send({ error: "Yanlış identifikator." });
      if (!orgs.byId(p.data.id)) return reply.code(404).send({ error: "Təşkilat tapılmadı." });
      return orgs.scope(p.data.id).repo.stage();
    });
    // Score history / events of any organisation (root only).
    r.get("/api/root/orgs/:id/events", async (req, reply) => {
      const p = idParam.safeParse(req.params); if (!p.success) return reply.code(400).send({ error: "Yanlış identifikator." });
      if (!orgs.byId(p.data.id)) return reply.code(404).send({ error: "Təşkilat tapılmadı." });
      return listEvents(orgs, p.data.id, cfg);
    });
    r.get<{ Querystring: { event?: string } }>("/api/root/orgs/:id/history.xlsx", async (req, reply) => {
      const p = idParam.safeParse(req.params); if (!p.success) return reply.code(400).send({ error: "Yanlış identifikator." });
      if (!orgs.byId(p.data.id)) return reply.code(404).send({ error: "Təşkilat tapılmadı." });
      const ev = req.query.event && /^\d+$/.test(req.query.event) ? Number(req.query.event) : orgs.activeEventId(p.data.id);
      const repo = orgs.eventRepo(p.data.id, ev);
      if (!repo) return reply.code(404).send({ error: "Proqram tapılmadı." });
      return sendHistory(reply, repo);
    });

    r.post("/api/root/orgs", async (req, reply) => {
      const b = parseBody(createBody, req.body, reply); if (!b) return;
      if (orgs.bySlug(b.slug)) return reply.code(409).send({ error: "Bu qısa adla təşkilat artıq var." });
      if (b.coordinator && root.userByUsername(b.coordinator.username)) return reply.code(409).send({ error: "Bu istifadəçi adı artıq istifadə olunur." });
      const hash = b.coordinator ? await hashPassword(b.coordinator.password) : null;
      const org = orgs.db.transaction(() => {
        const o = orgs.create(b.slug, b.name);
        const sc = orgs.scope(o.id);
        sc.repo.audit(req.user!.id, "org.create", { slug: o.slug, name: o.name, by: "root" });
        if (b.coordinator && hash) {
          const u = sc.repo.createUser("admin", b.coordinator.username, b.coordinator.displayName ?? b.name, hash);
          sc.repo.audit(req.user!.id, "coordinator.create", { id: u.id, username: u.username });
        }
        return o;
      })();
      return view(org.id);
    });

    r.patch("/api/root/orgs/:id", async (req, reply) => {
      const p = idParam.safeParse(req.params); if (!p.success) return reply.code(400).send({ error: "Yanlış identifikator." });
      const b = parseBody(patchBody, req.body, reply); if (!b) return;
      const o = orgs.byId(p.data.id);
      if (!o) return reply.code(404).send({ error: "Təşkilat tapılmadı." });
      if (o.id === ROOT_ORG_ID && b.active === false) return reply.code(400).send({ error: "Əsas təşkilatı deaktiv etmək olmaz." });
      orgs.update(o.id, b);
      if (b.active === false && o.active) signOutOrg(o.id);
      orgs.scope(o.id).repo.audit(req.user!.id, "org.update", b);
      return view(o.id);
    });

    r.post("/api/root/orgs/:id/coordinators", async (req, reply) => {
      const p = idParam.safeParse(req.params); if (!p.success) return reply.code(400).send({ error: "Yanlış identifikator." });
      const b = parseBody(coordBody, req.body, reply); if (!b) return;
      const o = orgs.byId(p.data.id);
      if (!o) return reply.code(404).send({ error: "Təşkilat tapılmadı." });
      if (root.userByUsername(b.username)) return reply.code(409).send({ error: "Bu istifadəçi adı artıq istifadə olunur." });
      const sc = orgs.scope(o.id);
      const u = sc.repo.createUser("admin", b.username, b.displayName ?? o.name, await hashPassword(b.password));
      sc.repo.audit(req.user!.id, "coordinator.create", { id: u.id, username: u.username });
      return view(o.id);
    });

    r.post("/api/root/users/:id/password", async (req, reply) => {
      const p = idParam.safeParse(req.params); if (!p.success) return reply.code(400).send({ error: "Yanlış identifikator." });
      const b = parseBody(resetBody, req.body, reply); if (!b) return;
      const u = coordinator(p.data.id);
      if (!u) return reply.code(404).send({ error: "Koordinator tapılmadı." });
      root.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(b.password), u.id);
      const closed = root.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id).changes;
      rt.io.in(`user:${u.id}`).disconnectSockets(true);
      orgs.scope(u.org_id).repo.audit(req.user!.id, "coordinator.password.reset", { id: u.id, sessionsClosed: closed });
      return view(u.org_id);
    });

    r.patch("/api/root/users/:id", async (req, reply) => {
      const p = idParam.safeParse(req.params); if (!p.success) return reply.code(400).send({ error: "Yanlış identifikator." });
      const b = parseBody(userPatch, req.body, reply); if (!b) return;
      const u = coordinator(p.data.id);
      if (!u) return reply.code(404).send({ error: "Koordinator tapılmadı." });
      root.db.prepare("UPDATE users SET active = ? WHERE id = ?").run(+b.active, u.id);
      if (!b.active) { root.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id); rt.io.in(`user:${u.id}`).disconnectSockets(true); }
      orgs.scope(u.org_id).repo.audit(req.user!.id, "coordinator.update", { id: u.id, active: b.active });
      return view(u.org_id);
    });

    // "Panelinə keç": the platform owner's admin session acts in that organisation until it switches back.
    r.post("/api/root/impersonate", async (req, reply) => {
      const b = parseBody(impersonateBody, req.body, reply); if (!b) return;
      if (b.orgId == null || b.orgId === req.user!.homeOrgId) {
        reply.clearCookie(ORG_COOKIE, { path: "/" });
        if (b.orgId != null) orgs.scope(b.orgId).repo.audit(req.user!.id, "org.impersonate", { by: req.user!.username, own: true });
        return { ok: true, redirect: "/admin" };
      }
      const o = orgs.byId(b.orgId);
      if (!o) return reply.code(404).send({ error: "Təşkilat tapılmadı." });
      reply.setCookie(ORG_COOKIE, String(o.id), { httpOnly: true, secure: cfg.cookieSecure, sameSite: "lax", path: "/", signed: true, maxAge: Math.floor(cfg.sessionTtlMs / 1000) });
      orgs.scope(o.id).repo.audit(req.user!.id, "org.impersonate", { by: req.user!.username });
      return { ok: true, redirect: "/admin" };
    });
  });
}
