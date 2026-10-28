import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { applyTimerAction } from "../../shared/timer.js";
import { requireRole } from "../auth.js";
import { hashPassword } from "../baseline.js";
import { idParam, parseBody, type Ctx } from "../context.js";
import { buildPdf } from "../export/pdf.js";
import { buildXlsx, exportFileName } from "../export/xlsx.js";
import { adminResults, revealAdminView, revealSnapshot } from "../views.js";
import { revealSteps } from "../../shared/reveal.js";

const name = (max = 120) => z.string().trim().min(1, "Ad boş ola bilməz.").max(max);
const password = z.string().min(6, "Şifrə ən azı 6 simvol olmalıdır.").max(200);
const username = z.string().trim().min(3, "İstifadəçi adı ən azı 3 simvol olmalıdır.").max(40)
  .regex(/^[a-zA-Z0-9._-]+$/, "İstifadəçi adında yalnız latın hərfləri, rəqəmlər, nöqtə, tire və alt xətt ola bilər.");

const eventBody = z.object({
  name: name().optional(),
  date: z.string().trim().max(40).optional(),
  currentTeamId: z.number().int().positive().nullable().optional(),
  locked: z.boolean().optional(),
  showJurorTotal: z.boolean().optional(),
  pitchSec: z.number().int().min(10).max(3600).optional(),
  qaSec: z.number().int().min(10).max(3600).optional(),
  timer: z.enum(["pitch", "qa", "toggle", "pause", "resume", "reset", "stop"]).optional(),
});
const teamBody = z.object({ name: name(), project: z.string().trim().max(160).default("") });
const teamPatch = z.object({ name: name().optional(), project: z.string().trim().max(160).optional(), active: z.boolean().optional() });
const jurorBody = z.object({ displayName: name(80), username, password });
const jurorPatch = z.object({ displayName: name(80).optional(), username: username.optional(), active: z.boolean().optional(), password: password.optional() });
const critBody = z.object({ name: name(), description: z.string().trim().max(400).default(""), weight: z.number().int().min(0).max(100) });
const critPatch = z.object({ name: name().optional(), description: z.string().trim().max(400).optional(), weight: z.number().int().min(0).max(100).optional() });
const reorderBody = z.object({ ids: z.array(z.number().int().positive()).min(1) });
const wipeBody = z.object({ token: z.string().min(1) });
const revealBody = z.object({ action: z.enum(["enable", "disable", "next", "back", "reset"]) });

export function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const { repo, cfg, rt } = ctx;
  let wipe: { token: string; until: number } | null = null;

  const id = (params: unknown, reply: FastifyReply) => {
    const r = idParam.safeParse(params);
    if (!r.success) { reply.code(400).send({ error: "Yanlış identifikator." }); return null; }
    return r.data.id;
  };
  const configChanged = () => { rt.emitConfig(); rt.emitStage(); rt.emitResults(); };

  app.register(async r => {
    r.addHook("preHandler", requireRole("admin"));

    r.get("/api/admin/state", async () => ({
      event: repo.getEvent(),
      stage: repo.stage(),
      presence: rt.presence(),
      sessions: repo.sessions().map(s => ({ ...s, id: s.id.slice(0, 16) })),
      ...adminResults(repo, cfg),
    }));
    r.get("/api/admin/results", async () => adminResults(repo, cfg));

    // ---------- event / stage / timer ----------
    r.patch("/api/admin/event", async (req, reply) => {
      const b = parseBody(eventBody, req.body, reply);
      if (!b) return;
      const actor = req.user!.id;
      const cur = repo.getEvent();
      const now = Date.now();
      let timer = { ...cur.timer };
      if (b.pitchSec) timer.pitchSec = b.pitchSec;
      if (b.qaSec) timer.qaSec = b.qaSec;
      let stageChanged = false;
      if (b.currentTeamId !== undefined && b.currentTeamId !== cur.currentTeamId) {
        if (b.currentTeamId != null && !repo.team(b.currentTeamId)?.active) return reply.code(404).send({ error: "Komanda tapılmadı." });
        // A new team on stage starts with a fresh timer, ready at full pitch time.
        timer = applyTimerAction(timer, b.currentTeamId == null ? "stop" : "reset", now);
        stageChanged = true;
        repo.audit(actor, "stage.change", { teamId: b.currentTeamId });
      }
      if (b.timer) timer = applyTimerAction(timer, b.timer, now);
      const timerChanged = JSON.stringify(timer) !== JSON.stringify(cur.timer);
      const ev = repo.updateEvent({
        name: b.name ?? cur.name,
        date: b.date ?? cur.date,
        currentTeamId: b.currentTeamId !== undefined ? b.currentTeamId : cur.currentTeamId,
        locked: b.locked ?? cur.locked,
        showJurorTotal: b.showJurorTotal ?? cur.showJurorTotal,
        timer,
      });
      if (b.locked !== undefined && b.locked !== cur.locked) {
        repo.audit(actor, b.locked ? "event.lock" : "event.unlock");
        rt.emitLocked(ev.locked);
      }
      if (b.name !== undefined || b.date !== undefined || b.showJurorTotal !== undefined) {
        repo.audit(actor, "event.settings", { name: b.name, date: b.date, showJurorTotal: b.showJurorTotal });
        rt.emitConfig();
        stageChanged = true;
      }
      if (stageChanged) rt.emitStage();
      else if (timerChanged) rt.emitTimer();
      return { event: ev, stage: repo.stage() };
    });

    r.post("/api/admin/event/next", async req => {
      const teams = repo.teams().filter(t => t.active);
      const cur = repo.getEvent();
      const i = teams.findIndex(t => t.id === cur.currentTeamId);
      const next = teams[(i + 1) % Math.max(1, teams.length)] ?? null;
      const ev = repo.updateEvent({
        currentTeamId: next?.id ?? null,
        timer: applyTimerAction(cur.timer, next ? "reset" : "stop", Date.now()),
      });
      repo.audit(req.user!.id, "stage.change", { teamId: ev.currentTeamId });
      rt.emitStage();
      return { event: ev, stage: repo.stage() };
    });

    // ---------- teams ----------
    r.get("/api/admin/teams", async () => repo.teams().map(t => ({ ...t, scoreCount: repo.scoreCountForTeam(t.id) })));
    r.post("/api/admin/teams", async (req, reply) => {
      const b = parseBody(teamBody, req.body, reply);
      if (!b) return;
      const t = repo.addTeam(b.name, b.project);
      repo.audit(req.user!.id, "team.create", t);
      configChanged();
      return t;
    });
    r.patch("/api/admin/teams/:id", async (req, reply) => {
      const tid = id(req.params, reply); if (!tid) return;
      const b = parseBody(teamPatch, req.body, reply); if (!b) return;
      const t = repo.updateTeam(tid, b);
      if (!t) return reply.code(404).send({ error: "Komanda tapılmadı." });
      if (b.active === false && repo.getEvent().currentTeamId === tid) {
        repo.updateEvent({ currentTeamId: null, timer: applyTimerAction(repo.getEvent().timer, "stop", Date.now()) });
      }
      repo.audit(req.user!.id, "team.update", { id: tid, ...b });
      configChanged();
      return t;
    });
    r.delete<{ Querystring: { force?: string } }>("/api/admin/teams/:id", async (req, reply) => {
      const tid = id(req.params, reply); if (!tid) return;
      const n = repo.scoreCountForTeam(tid);
      if (n && req.query.force !== "1") {
        return reply.code(409).send({ error: `Bu komandanın ${n} qiyməti var. Silinsə, qiymətlər də silinəcək.`, scoreCount: n });
      }
      if (!repo.deleteTeam(tid)) return reply.code(404).send({ error: "Komanda tapılmadı." });
      repo.audit(req.user!.id, "team.delete", { id: tid, scoresDeleted: n });
      configChanged();
      return { ok: true };
    });
    r.post("/api/admin/teams/reorder", async (req, reply) => {
      const b = parseBody(reorderBody, req.body, reply); if (!b) return;
      repo.reorder("teams", b.ids);
      configChanged();
      return repo.teams();
    });

    // ---------- jurors ----------
    r.get("/api/admin/jurors", async () => {
      const sessions = repo.sessions();
      return repo.jurors().map(j => ({ ...j, sessionCount: sessions.filter(s => s.userId === j.id).length }));
    });
    r.post("/api/admin/jurors", async (req, reply) => {
      const b = parseBody(jurorBody, req.body, reply); if (!b) return;
      if (repo.userByUsername(b.username)) return reply.code(409).send({ error: "Bu istifadəçi adı artıq mövcuddur." });
      const u = repo.createUser("juror", b.username, b.displayName, await hashPassword(b.password));
      repo.audit(req.user!.id, "juror.create", { id: u.id, username: u.username });
      configChanged();
      rt.emitPresence();
      return { id: u.id, username: u.username, displayName: u.display_name, active: true, sessionCount: 0 };
    });
    r.patch("/api/admin/jurors/:id", async (req, reply) => {
      const jid = id(req.params, reply); if (!jid) return;
      const b = parseBody(jurorPatch, req.body, reply); if (!b) return;
      const u = repo.userById(jid);
      if (!u || u.role !== "juror") return reply.code(404).send({ error: "Münsif tapılmadı." });
      if (b.username && b.username.toLowerCase() !== u.username.toLowerCase() && repo.userByUsername(b.username)) {
        return reply.code(409).send({ error: "Bu istifadəçi adı artıq mövcuddur." });
      }
      const n = repo.updateUser(jid, {
        username: b.username, displayName: b.displayName, active: b.active,
        passwordHash: b.password ? await hashPassword(b.password) : undefined,
      })!;
      // A new password or deactivation ends every open session of that juror.
      if (b.password || b.active === false) { repo.deleteUserSessions(jid); rt.kickUser(jid); }
      if (b.password) repo.audit(req.user!.id, "juror.password", { id: jid });
      repo.audit(req.user!.id, "juror.update", { id: jid, username: b.username, displayName: b.displayName, active: b.active });
      configChanged();
      rt.emitPresence();
      return { id: n.id, username: n.username, displayName: n.display_name, active: !!n.active };
    });
    r.delete<{ Querystring: { force?: string } }>("/api/admin/jurors/:id", async (req, reply) => {
      const jid = id(req.params, reply); if (!jid) return;
      const n = repo.scoresOf(jid).length;
      if (n && req.query.force !== "1") {
        return reply.code(409).send({ error: `Bu münsifin ${n} qiyməti var. Silinsə, qiymətlər də silinəcək. Bunun əvəzinə deaktiv edə bilərsiniz.`, scoreCount: n });
      }
      rt.kickUser(jid);
      if (!repo.deleteUser(jid)) return reply.code(404).send({ error: "Münsif tapılmadı." });
      repo.audit(req.user!.id, "juror.delete", { id: jid, scoresDeleted: n });
      configChanged();
      rt.emitPresence();
      return { ok: true };
    });
    r.post("/api/admin/jurors/:id/logout", async (req, reply) => {
      const jid = id(req.params, reply); if (!jid) return;
      const n = repo.deleteUserSessions(jid);
      rt.kickUser(jid);
      repo.audit(req.user!.id, "juror.logout", { id: jid, sessions: n });
      return { closed: n };
    });

    // ---------- sessions ----------
    r.get("/api/admin/sessions", async () => repo.sessions().map(s => ({ ...s, id: s.id.slice(0, 16) })));

    // ---------- criteria ----------
    r.get("/api/admin/criteria", async () => repo.criteria());
    r.post("/api/admin/criteria", async (req, reply) => {
      const b = parseBody(critBody, req.body, reply); if (!b) return;
      const c = repo.addCriterion({ ...b, key: "c" + randomBytes(4).toString("hex") });
      repo.audit(req.user!.id, "criterion.create", c);
      configChanged();
      return c;
    });
    r.patch("/api/admin/criteria/:id", async (req, reply) => {
      const cid = id(req.params, reply); if (!cid) return;
      const b = parseBody(critPatch, req.body, reply); if (!b) return;
      const c = repo.updateCriterion(cid, b);
      if (!c) return reply.code(404).send({ error: "Kriteriya tapılmadı." });
      repo.audit(req.user!.id, "criterion.update", { id: cid, ...b });
      configChanged();
      return c;
    });
    r.delete<{ Querystring: { force?: string } }>("/api/admin/criteria/:id", async (req, reply) => {
      const cid = id(req.params, reply); if (!cid) return;
      const n = repo.scoreCount();
      if (n && req.query.force !== "1") {
        return reply.code(409).send({ error: `Artıq ${n} qiymət var. Kriteriya silinsə, yekun ballar yenidən hesablanacaq.`, scoreCount: n });
      }
      if (repo.criteria().length <= 1) return reply.code(400).send({ error: "Ən azı bir kriteriya qalmalıdır." });
      if (!repo.deleteCriterion(cid)) return reply.code(404).send({ error: "Kriteriya tapılmadı." });
      repo.audit(req.user!.id, "criterion.delete", { id: cid });
      configChanged();
      return { ok: true };
    });
    r.post("/api/admin/criteria/reorder", async (req, reply) => {
      const b = parseBody(reorderBody, req.body, reply); if (!b) return;
      repo.reorder("criteria", b.ids);
      configChanged();
      return repo.criteria();
    });

    // ---------- scores ----------
    r.post("/api/admin/scores/wipe-token", async () => {
      wipe = { token: randomBytes(6).toString("hex"), until: Date.now() + 60_000 };
      return { token: wipe.token, count: repo.scoreCount(), expiresInSec: 60 };
    });
    r.delete("/api/admin/scores", async (req, reply) => {
      const b = parseBody(wipeBody, req.body, reply); if (!b) return;
      if (!wipe || wipe.token !== b.token || wipe.until < Date.now()) {
        return reply.code(400).send({ error: "Təsdiq kodu etibarsızdır və ya vaxtı keçib. Yenidən cəhd edin." });
      }
      wipe = null;
      const n = repo.wipeScores();
      repo.setReveal({ enabled: false, step: 0, snapshot: null });
      repo.audit(req.user!.id, "scores.wipe", { deleted: n });
      rt.emitReveal();
      rt.emitConfig();
      rt.emitResults();
      return { deleted: n };
    });

    // ---------- results reveal ----------
    r.get("/api/admin/reveal", async () => revealAdminView(repo, cfg));
    r.post("/api/admin/reveal", async (req, reply) => {
      const b = parseBody(revealBody, req.body, reply); if (!b) return;
      const actor = req.user!.id;
      const cur = repo.getReveal();
      // Enabling or re-snapshotting freezes the ranking and locks scoring so nothing can move mid-ceremony.
      const freeze = () => {
        const snap = revealSnapshot(repo, cfg);
        if (!snap.entries.length) return null;
        if (!repo.getEvent().locked) {
          repo.updateEvent({ locked: true });
          repo.audit(actor, "event.lock", { reason: "reveal" });
          rt.emitLocked(true);
        }
        return snap;
      };
      switch (b.action) {
        case "enable": {
          const snapshot = cur.snapshot ?? freeze();
          if (!snapshot) return reply.code(409).send({ error: "Hələ heç bir komanda tam qiymətləndirilməyib." });
          repo.setReveal({ enabled: true, snapshot });
          break;
        }
        case "disable":
          repo.setReveal({ enabled: false });
          break;
        case "reset": {
          const snapshot = freeze();
          if (!snapshot) return reply.code(409).send({ error: "Hələ heç bir komanda tam qiymətləndirilməyib." });
          repo.setReveal({ step: 0, snapshot });
          break;
        }
        case "next": {
          if (!cur.enabled || !cur.snapshot) return reply.code(409).send({ error: "Əvvəlcə açıqlamaya icazə verin." });
          if (cur.step >= revealSteps(cur.snapshot.entries).length) return reply.code(409).send({ error: "Bütün yerlər artıq açıqlanıb." });
          repo.setReveal({ step: cur.step + 1 });
          break;
        }
        case "back":
          if (cur.step > 0) repo.setReveal({ step: cur.step - 1 });
          break;
      }
      repo.audit(actor, `reveal.${b.action}`, { step: repo.getReveal().step });
      rt.emitReveal();
      return revealAdminView(repo, cfg);
    });

    // ---------- exports / audit ----------
    r.get("/api/admin/export.xlsx", async (_req, reply) => {
      const buf = await buildXlsx(repo, cfg);
      const file = exportFileName(repo.getEvent().date, "netice.xlsx");
      reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      reply.header("Content-Disposition", `attachment; filename="${file}"; filename*=UTF-8''${encodeURIComponent(file)}`);
      return reply.send(buf);
    });
    r.get("/api/admin/export.pdf", async (_req, reply) => {
      const buf = await buildPdf(repo, cfg);
      const file = exportFileName(repo.getEvent().date, "protokol.pdf");
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `attachment; filename="${file}"; filename*=UTF-8''${encodeURIComponent(file)}`);
      return reply.send(buf);
    });
    r.get("/api/admin/audit", async () => repo.auditLog());
  });
}
