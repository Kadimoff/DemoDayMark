import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { applyTimerAction } from "../../shared/timer.js";
import { newToken, requireRole, tokenId } from "../auth.js";
import { hashPassword } from "../baseline.js";
import { idParam, parseBody, scopeOf, type Ctx } from "../context.js";
import type { Repo } from "../repo.js";
import type { OrgRealtime } from "../realtime.js";
import { buildPdf } from "../export/pdf.js";
import { buildXlsx, exportFileName } from "../export/xlsx.js";
import { adminResults, revealAdminView, revealSnapshot } from "../views.js";
import { revealSteps } from "../../shared/reveal.js";
import { PRODUCTS } from "../../shared/brand.js";
import { adjustTimer } from "../../shared/timer.js";
import { isPlaceholderName, placeholderName } from "../../shared/brand.js";
import { buildHistoryXlsx } from "../export/history.js";
import { createEvent, listEvents } from "../events.js";

/** A juror QR is valid this long, or until it is scanned / replaced. */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

const name = (max = 120) => z.string().trim().min(1, "Ad boş ola bilməz.").max(max);

const eventBody = z.object({
  name: z.string().trim().max(40, "Brend adı 40 simvoldan uzun ola bilməz.").optional(),
  feedbackTags: z.array(z.string().trim().min(1).max(60, "Rəy etiketi 60 simvoldan uzun ola bilməz.")).max(20, "Ən çox 20 rəy etiketi ola bilər.").optional(),
  date: z.string().trim().max(40).optional(),
  currentTeamId: z.number().int().positive().nullable().optional(),
  locked: z.boolean().optional(),
  showJurorTotal: z.boolean().optional(),
  pitchSec: z.number().int().min(10).max(3600).optional(),
  qaSec: z.number().int().min(10).max(3600).optional(),
  timer: z.enum(["pitch", "qa", "toggle", "pause", "resume", "reset", "stop"]).optional(),
  includeEntry: z.boolean().optional(),
  entryMax: z.number().min(1, "Giriş balının maksimumu ən azı 1 olmalıdır.").max(1000).optional(),
  revealTop: z.number().int().min(0, "İki addımla açılan yerlərin sayı 0–10 arası olmalıdır.").max(10, "İki addımla açılan yerlərin sayı 0–10 arası olmalıdır.").optional(),
  revealBatch: z.number().int().min(1, "Birlikdə açılan yerlərin sayı 1–10 arası olmalıdır.").max(10, "Birlikdə açılan yerlərin sayı 1–10 arası olmalıdır.").optional(),
  revealHideScores: z.boolean().optional(),
  product: z.enum(PRODUCTS).optional(),
  timerAdd: z.number().int().min(-3600).max(3600).optional(),
  timerSet: z.number().int().min(0).max(3600).optional(),
});
const finalOrderBody = z.object({ ids: z.array(z.number().int().positive()).max(500).nullable() });
const entryScore = z.number().min(0, "Giriş balı mənfi ola bilməz.").max(1000).nullable();
const teamBody = z.object({ name: name(), project: z.string().trim().max(160).default(""), entryScore: entryScore.optional() });
const teamPatch = z.object({ name: name().optional(), project: z.string().trim().max(160).optional(), active: z.boolean().optional(), entryScore: entryScore.optional() });
const jurorBody = z.object({ displayName: name(80).optional() });
const jurorPatch = z.object({ displayName: name(80).optional(), active: z.boolean().optional() });
const maxScore = z.number().int("Maksimum bal tam ədəd olmalıdır.").min(1, "Maksimum bal ən azı 1 olmalıdır.").max(100);
const critBody = z.object({ name: name(), description: z.string().trim().max(400).default(""), maxScore });
const critPatch = z.object({ name: name().optional(), description: z.string().trim().max(400).optional(), maxScore: maxScore.optional() });
const reorderBody = z.object({ ids: z.array(z.number().int().positive()).min(1) });
const wipeBody = z.object({ token: z.string().min(1) });
const newEventBody = z.object({
  name: z.string().trim().min(2, "Tədbirin adını yazın.").max(40, "Ad 40 simvoldan uzun ola bilməz."),
  product: z.enum(PRODUCTS).optional(),
  date: z.string().trim().max(40).optional(),
  pitchSec: z.number().int().min(10).max(3600).optional(),
  qaSec: z.number().int().min(10).max(3600).optional(),
  uploadDeadline: z.number().int().positive().nullable().optional(),
  copyCriteria: z.boolean().optional(),
  copyTeams: z.boolean().optional(),
  confirm: z.literal(true, { message: "Köhnə tədbirin arxivə köçürülməsini təsdiqləyin." }),
});
const revealBody = z.object({ action: z.enum(["enable", "disable", "next", "back", "reset"]) });

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export function attach(reply: FastifyReply, file: string, type: string, buf: Buffer) {
  reply.header("Content-Type", type);
  reply.header("Content-Disposition", `attachment; filename="${file.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file)}`);
  return reply.send(buf);
}
export const sendHistory = async (reply: FastifyReply, repo: Repo) =>
  attach(reply, exportFileName(repo.getEvent().displayName, repo.getEvent().date, "tarixce.xlsx"), XLSX, await buildHistoryXlsx(repo));

export function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const { cfg } = ctx;
  const sendResultsXlsx = async (reply: FastifyReply, repo: Repo) =>
    attach(reply, exportFileName(repo.getEvent().displayName, repo.getEvent().date, "netice.xlsx"), XLSX, await buildXlsx(repo, cfg));
  const sendResultsPdf = async (reply: FastifyReply, repo: Repo) =>
    attach(reply, exportFileName(repo.getEvent().displayName, repo.getEvent().date, "protokol.pdf"), "application/pdf", await buildPdf(repo, cfg));
  /** Pending "wipe all scores" confirmation, per organisation. */
  const wipes = new Map<number, { token: string; until: number }>();

  const id = (params: unknown, reply: FastifyReply) => {
    const r = idParam.safeParse(params);
    if (!r.success) { reply.code(400).send({ error: "Yanlış identifikator." }); return null; }
    return r.data.id;
  };
  const changed = (rt: OrgRealtime) => { rt.emitConfig(); rt.emitStage(); rt.emitResults(); };

  app.register(async r => {
    r.addHook("preHandler", requireRole("admin"));

    r.get("/api/admin/state", async req => {
      const { repo, rt, orgId } = scopeOf(ctx, req);
      const o = ctx.orgs.byId(orgId)!;
      return {
        event: repo.getEvent(),
        stage: repo.stage(),
        presence: rt.presence(),
        progress: rt.progress(),
        sessions: repo.sessions().map(s => ({ ...s, id: s.id.slice(0, 16) })),
        // orgs: whose panel this is (header, projector links)
        org: { id: o.id, slug: o.slug, name: o.name, root: o.id === 1 },
        // v3 events: the active event of the organisation
        eventMeta: repo.meta(),
        ...adminResults(repo, cfg),
      };
    });
    r.get("/api/admin/results", async req => adminResults(scopeOf(ctx, req).repo, cfg));

    // ---------- event / stage / timer ----------
    r.patch("/api/admin/event", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const b = parseBody(eventBody, req.body, reply);
      if (!b) return;
      const actor = req.user!.id;
      const cur = repo.getEvent();
      const now = Date.now();
      if (b.entryMax !== undefined) {
        const top = Math.max(0, ...repo.teams().map(t => t.entryScore ?? 0));
        if (b.entryMax < top) return reply.code(400).send({ error: `Giriş balının maksimumu mövcud giriş ballarından (${Math.round(top * 100) / 100}) az ola bilməz.` });
      }
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
      if (b.timerAdd !== undefined) timer = adjustTimer(timer, now, { addSec: b.timerAdd });
      if (b.timerSet !== undefined) timer = adjustTimer(timer, now, { setRemaining: b.timerSet });
      if (b.timerAdd !== undefined || b.timerSet !== undefined) repo.audit(actor, "timer.adjust", { add: b.timerAdd, set: b.timerSet });
      const timerChanged = JSON.stringify(timer) !== JSON.stringify(cur.timer);
      const ev = repo.updateEvent({
        name: b.name ?? cur.name,
        date: b.date ?? cur.date,
        currentTeamId: b.currentTeamId !== undefined ? b.currentTeamId : cur.currentTeamId,
        locked: b.locked ?? cur.locked,
        showJurorTotal: b.showJurorTotal ?? cur.showJurorTotal,
        includeEntry: b.includeEntry ?? cur.includeEntry,
        entryMax: b.entryMax ?? cur.entryMax,
        feedbackTags: b.feedbackTags ? [...new Set(b.feedbackTags)] : cur.feedbackTags,
        revealTop: b.revealTop ?? cur.revealTop,
        revealBatch: b.revealBatch ?? cur.revealBatch,
        revealHideScores: b.revealHideScores ?? cur.revealHideScores,
        product: b.product ?? cur.product,
        timer,
        // munsif: a new team on stage starts on its first slide, in the default view.
        // v3: putting a team on stage brings the projector back from the event's own presentation.
      ...(stageChanged && b.currentTeamId !== undefined && b.currentTeamId !== cur.currentTeamId ? { stageSlide: 1, stageMode: "auto" as const, stageIntroAt: null, ...(b.currentTeamId != null ? { stageScene: "team" as const } : {}) } : {}),
      });
      if (b.locked !== undefined && b.locked !== cur.locked) {
        repo.audit(actor, b.locked ? "event.lock" : "event.unlock");
        rt.emitLocked(ev.locked);
      }
      // Durations change what every screen shows ("Pitch 3:00", the projector rim): push the full stage.
      if (b.pitchSec !== undefined || b.qaSec !== undefined) stageChanged = true;
      if (b.name !== undefined || b.date !== undefined || b.showJurorTotal !== undefined || b.feedbackTags !== undefined || b.product !== undefined) {
        repo.audit(actor, "event.settings", { name: b.name, date: b.date, showJurorTotal: b.showJurorTotal, feedbackTags: b.feedbackTags, product: b.product });
        rt.emitConfig();
        stageChanged = true;
      }
      if ((b.includeEntry !== undefined && b.includeEntry !== cur.includeEntry) || (b.entryMax !== undefined && b.entryMax !== cur.entryMax)) {
        repo.audit(actor, "event.scoring", { includeEntry: b.includeEntry, entryMax: b.entryMax });
        rt.emitResults();
        rt.emitConfig(); // jurors show or hide entry scores
      }
      if ((b.revealTop !== undefined && b.revealTop !== cur.revealTop) || (b.revealBatch !== undefined && b.revealBatch !== cur.revealBatch)) {
        repo.audit(actor, "event.revealSteps", { revealTop: b.revealTop, revealBatch: b.revealBatch });
        rt.emitReveal();
      }
      if (b.revealHideScores !== undefined && b.revealHideScores !== cur.revealHideScores) {
        repo.audit(actor, "reveal.hideScores", { hide: b.revealHideScores });
        rt.emitReveal(); // applies at once: the public view is built per request
      }
      if (stageChanged) rt.emitStage();
      else if (timerChanged) rt.emitTimer();
      return { event: ev, stage: repo.stage() };
    });

    r.post("/api/admin/event/next", async req => {
      const { repo, rt } = scopeOf(ctx, req);
      const teams = repo.teams().filter(t => t.active);
      const cur = repo.getEvent();
      const i = teams.findIndex(t => t.id === cur.currentTeamId);
      const next = teams[(i + 1) % Math.max(1, teams.length)] ?? null;
      const ev = repo.updateEvent({
        currentTeamId: next?.id ?? null,
        timer: applyTimerAction(cur.timer, next ? "reset" : "stop", Date.now()),
        stageSlide: 1, stageMode: "auto", stageIntroAt: null, ...(next ? { stageScene: "team" as const } : {}),
      });
      repo.audit(req.user!.id, "stage.change", { teamId: ev.currentTeamId });
      rt.emitStage();
      return { event: ev, stage: repo.stage() };
    });

    // ---------- teams ----------
    r.get("/api/admin/teams", async req => { const { repo } = scopeOf(ctx, req); return repo.teams().map(t => ({ ...t, scoreCount: repo.scoreCountForTeam(t.id) })); });
    r.post("/api/admin/teams", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const b = parseBody(teamBody, req.body, reply);
      if (!b) return;
      if (b.entryScore != null && b.entryScore > repo.getEvent().entryMax) {
        return reply.code(400).send({ error: `Giriş balı 0–${repo.getEvent().entryMax} arası olmalıdır.` });
      }
      let t = repo.addTeam(b.name, b.project);
      if (b.entryScore != null) t = repo.updateTeam(t.id, { entryScore: b.entryScore })!;
      repo.audit(req.user!.id, "team.create", t);
      changed(rt);
      return t;
    });
    r.patch("/api/admin/teams/:id", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const tid = id(req.params, reply); if (!tid) return;
      const b = parseBody(teamPatch, req.body, reply); if (!b) return;
      if (b.entryScore != null && b.entryScore > repo.getEvent().entryMax) {
        return reply.code(400).send({ error: `Giriş balı 0–${repo.getEvent().entryMax} arası olmalıdır.` });
      }
      const t = repo.updateTeam(tid, b);
      if (!t) return reply.code(404).send({ error: "Komanda tapılmadı." });
      if (b.active === false && repo.getEvent().currentTeamId === tid) {
        repo.updateEvent({ currentTeamId: null, timer: applyTimerAction(repo.getEvent().timer, "stop", Date.now()) });
      }
      repo.audit(req.user!.id, "team.update", { id: tid, ...b });
      changed(rt);
      return t;
    });
    r.delete<{ Querystring: { force?: string } }>("/api/admin/teams/:id", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const tid = id(req.params, reply); if (!tid) return;
      const n = repo.scoreCountForTeam(tid);
      if (n && req.query.force !== "1") {
        return reply.code(409).send({ error: `Bu komandanın ${n} qiyməti var. Silinsə, qiymətlər də silinəcək.`, scoreCount: n });
      }
      const tname = repo.team(tid)?.name ?? "";
      if (!repo.deleteTeam(tid)) return reply.code(404).send({ error: "Komanda tapılmadı." });
      if (n) repo.recordRemoval("team.delete", req.user!.id, n, { teamId: tid, teamName: tname });
      repo.audit(req.user!.id, "team.delete", { id: tid, scoresDeleted: n });
      changed(rt);
      return { ok: true };
    });
    r.post("/api/admin/teams/reorder", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const b = parseBody(reorderBody, req.body, reply); if (!b) return;
      repo.reorder("teams", b.ids);
      changed(rt);
      return repo.teams();
    });

    // ---------- jurors (QR sign-in) ----------
    const jurorView = (repo: Repo, id: number) => {
      const u = repo.member(id)!;
      const claimed = repo.claimedJurors();
      const sessions = repo.sessions();
      return { id: u.id, username: u.username, displayName: u.display_name, active: !!u.active,
        claimed: claimed.has(u.id) || !isPlaceholderName(u.display_name), sessionCount: sessions.filter(s => s.userId === u.id).length };
    };
    /** New single-use QR token for the juror; every earlier unused one stops working. */
    const issueInvite = (repo: Repo, jurorId: number, actor: number) => {
      const token = newToken();
      const { expiresAt } = repo.createInvite(jurorId, tokenId(token), INVITE_TTL_MS);
      repo.audit(actor, "juror.invite", { id: jurorId });
      return { path: `/j/${token}`, expiresAt };
    };

    r.get("/api/admin/jurors", async req => { const { repo } = scopeOf(ctx, req); return repo.jurors().map(j => jurorView(repo, j.id)); });
    r.post("/api/admin/jurors", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const b = parseBody(jurorBody, req.body, reply); if (!b) return;
      const used = new Set(repo.jurors().map(j => j.displayName));
      let n = repo.jurors().length + 1;
      while (used.has(placeholderName(n))) n++;
      // Nobody signs in with these: the username is internal and the password hash is of a discarded random token.
      const u = repo.createUser("juror", `juror-${randomBytes(5).toString("hex")}`, b.displayName ?? placeholderName(n), await hashPassword(newToken()));
      repo.audit(req.user!.id, "juror.create", { id: u.id });
      const invite = issueInvite(repo, u.id, req.user!.id);
      changed(rt);
      rt.emitPresence();
      return { juror: jurorView(repo, u.id), invite };
    });
    r.post("/api/admin/jurors/:id/invite", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const jid = id(req.params, reply); if (!jid) return;
      const u = repo.member(jid);
      if (!u || u.role !== "juror") return reply.code(404).send({ error: "Münsif tapılmadı." });
      if (!u.active) return reply.code(409).send({ error: "Münsif deaktivdir. Əvvəlcə aktiv edin." });
      return { juror: jurorView(repo, jid), invite: issueInvite(repo, jid, req.user!.id) };
    });
    r.patch("/api/admin/jurors/:id", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const jid = id(req.params, reply); if (!jid) return;
      const b = parseBody(jurorPatch, req.body, reply); if (!b) return;
      const u = repo.member(jid);
      if (!u || u.role !== "juror") return reply.code(404).send({ error: "Münsif tapılmadı." });
      repo.updateUser(jid, { displayName: b.displayName, active: b.active });
      // Deactivation ends every open session of that juror.
      if (b.active === false) { repo.deleteUserSessions(jid); rt.kickUser(jid); rt.clearProgress(jid); }
      repo.audit(req.user!.id, "juror.update", { id: jid, displayName: b.displayName, active: b.active });
      changed(rt);
      rt.emitPresence();
      return jurorView(repo, jid);
    });
    // Reminds jurors who have not scored the team on stage yet.
    r.post("/api/admin/nudge", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const ev = repo.getEvent();
      const team = ev.currentTeamId ? repo.team(ev.currentTeamId) : null;
      if (!team) return reply.code(409).send({ error: "Səhnədə komanda yoxdur." });
      if (ev.locked) return reply.code(409).send({ error: "Qiymətləndirmə bağlıdır." });
      const done = new Set(repo.scores().filter(s => s.teamId === team.id).map(s => s.jurorId));
      const ids = repo.jurors().filter(j => j.active && !done.has(j.id)).map(j => j.id);
      const stage = repo.stage();
      rt.nudge(ids, { teamId: team.id, teamName: team.name, index: stage.team?.index ?? 0 });
      repo.audit(req.user!.id, "juror.nudge", { teamId: team.id, jurors: ids });
      return { nudged: ids.length };
    });
    r.delete<{ Querystring: { force?: string } }>("/api/admin/jurors/:id", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const jid = id(req.params, reply); if (!jid) return;
      const n = repo.scoresOf(jid).length;
      if (n && req.query.force !== "1") {
        return reply.code(409).send({ error: `Bu münsifin ${n} qiyməti var. Silinsə, qiymətlər də silinəcək. Bunun əvəzinə deaktiv edə bilərsiniz.`, scoreCount: n });
      }
      rt.kickUser(jid);
      const jname = repo.member(jid)?.display_name ?? "";
      if (!repo.deleteUser(jid)) return reply.code(404).send({ error: "Münsif tapılmadı." });
      if (n) repo.recordRemoval("juror.delete", req.user!.id, n, { jurorId: jid, jurorName: jname });
      repo.audit(req.user!.id, "juror.delete", { id: jid, scoresDeleted: n });
      changed(rt);
      rt.emitPresence();
      return { ok: true };
    });
    r.post("/api/admin/jurors/:id/logout", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const jid = id(req.params, reply); if (!jid) return;
      const n = repo.deleteUserSessions(jid);
      rt.kickUser(jid);
      repo.audit(req.user!.id, "juror.logout", { id: jid, sessions: n });
      return { closed: n };
    });

    // ---------- sessions ----------
    r.get("/api/admin/sessions", async req => scopeOf(ctx, req).repo.sessions().map(s => ({ ...s, id: s.id.slice(0, 16) })));

    // ---------- criteria ----------
    r.get("/api/admin/criteria", async req => scopeOf(ctx, req).repo.criteria());
    r.post("/api/admin/criteria", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const b = parseBody(critBody, req.body, reply); if (!b) return;
      const c = repo.addCriterion({ ...b, key: "c" + randomBytes(4).toString("hex") });
      repo.audit(req.user!.id, "criterion.create", c);
      changed(rt);
      return c;
    });
    r.patch<{ Querystring: { force?: string } }>("/api/admin/criteria/:id", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const cid = id(req.params, reply); if (!cid) return;
      const b = parseBody(critPatch, req.body, reply); if (!b) return;
      const before = repo.criterion(cid);
      if (!before) return reply.code(404).send({ error: "Meyar tapılmadı." });
      // Lowering a maximum below points already given would silently drop those scores from the results.
      if (b.maxScore !== undefined && b.maxScore < before.maxScore && req.query.force !== "1") {
        const n = repo.scores().filter(s => Number(s.values[before.key]) > b.maxScore!).length;
        if (n) return reply.code(409).send({ error: `${n} qiymətdə bu meyar üzrə ${b.maxScore}-dən yüksək bal var. Maksimum azaldılsa, həmin qiymətlər nəticəyə düşməyəcək.`, scoreCount: n });
      }
      const c = repo.updateCriterion(cid, b);
      if (!c) return reply.code(404).send({ error: "Meyar tapılmadı." });
      repo.audit(req.user!.id, "criterion.update", { id: cid, ...b });
      changed(rt);
      return c;
    });
    r.delete<{ Querystring: { force?: string } }>("/api/admin/criteria/:id", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const cid = id(req.params, reply); if (!cid) return;
      const n = repo.scoreCount();
      if (n && req.query.force !== "1") {
        return reply.code(409).send({ error: `Artıq ${n} qiymət var. Meyar silinsə, yekun ballar yenidən hesablanacaq.`, scoreCount: n });
      }
      if (repo.criteria().length <= 1) return reply.code(400).send({ error: "Ən azı bir meyar qalmalıdır." });
      if (!repo.deleteCriterion(cid)) return reply.code(404).send({ error: "Meyar tapılmadı." });
      repo.audit(req.user!.id, "criterion.delete", { id: cid });
      changed(rt);
      return { ok: true };
    });
    r.post("/api/admin/criteria/reorder", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const b = parseBody(reorderBody, req.body, reply); if (!b) return;
      repo.reorder("criteria", b.ids);
      changed(rt);
      return repo.criteria();
    });

    // ---------- scores ----------
    r.post("/api/admin/scores/wipe-token", async req => {
      const { repo, rt } = scopeOf(ctx, req);
      const wipe = { token: randomBytes(6).toString("hex"), until: Date.now() + 60_000 };
      wipes.set(repo.orgId, wipe);
      return { token: wipe.token, count: repo.scoreCount(), expiresInSec: 60 };
    });
    r.delete("/api/admin/scores", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const b = parseBody(wipeBody, req.body, reply); if (!b) return;
      const wipe = wipes.get(repo.orgId);
      if (!wipe || wipe.token !== b.token || wipe.until < Date.now()) {
        return reply.code(400).send({ error: "Təsdiq kodu etibarsızdır və ya vaxtı keçib. Yenidən cəhd edin." });
      }
      wipes.delete(repo.orgId);
      const n = repo.wipeScores();
      if (n) repo.recordRemoval("wipe", req.user!.id, n);
      repo.setReveal({ enabled: false, step: 0, snapshot: null });
      repo.audit(req.user!.id, "scores.wipe", { deleted: n });
      rt.emitReveal();
      rt.emitConfig();
      rt.emitResults();
      return { deleted: n };
    });

    // ---------- jurors' final decision (order used by the reveal) ----------
    r.put("/api/admin/final-order", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const b = parseBody(finalOrderBody, req.body, reply); if (!b) return;
      if (b.ids) {
        const known = new Set(repo.teams().map(t => t.id));
        if (b.ids.some(id => !known.has(id)) || new Set(b.ids).size !== b.ids.length) return reply.code(400).send({ error: "Sıra yanlışdır." });
      }
      repo.updateEvent({ finalOrder: b.ids?.length ? b.ids : null });
      repo.audit(req.user!.id, b.ids ? "results.finalOrder" : "results.finalOrder.clear", { ids: b.ids });
      rt.emitResults();
      return { finalOrder: repo.getEvent().finalOrder };
    });

    // ---------- results reveal ----------
    r.get("/api/admin/reveal", async req => revealAdminView(scopeOf(ctx, req).repo, cfg));
    r.post("/api/admin/reveal", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
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
          if (cur.step >= revealSteps(cur.snapshot.entries, cur.snapshot.top, cur.snapshot.batch).length) return reply.code(409).send({ error: "Bütün yerlər artıq açıqlanıb." });
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
    r.get("/api/admin/export.xlsx", async (req, reply) => sendResultsXlsx(reply, scopeOf(ctx, req).repo));
    r.get("/api/admin/export.pdf", async (req, reply) => sendResultsPdf(reply, scopeOf(ctx, req).repo));
    r.get("/api/admin/audit", async req => scopeOf(ctx, req).repo.auditLog());
    // v3: scoring history as Excel (who, when, which team, criterion, old → new) — this organisation only.
    r.get("/api/admin/history.xlsx", async (req, reply) => sendHistory(reply, scopeOf(ctx, req).repo));

    // ---------- v3 events: archive + new event ----------
    r.get("/api/admin/events", async req => listEvents(ctx.orgs, scopeOf(ctx, req).orgId, cfg));
    r.post("/api/admin/events", async (req, reply) => {
      const sc = scopeOf(ctx, req);
      const b = parseBody(newEventBody, req.body, reply); if (!b) return;
      const r0 = createEvent(ctx.orgs, sc, cfg, req.user!.id, b);
      return { ...r0, events: listEvents(ctx.orgs, sc.orgId, cfg) };
    });
    const archived = (req: { params: unknown }, reply: FastifyReply, orgId: number) => {
      const p = idParam.safeParse(req.params);
      const repo = p.success ? ctx.orgs.eventRepo(orgId, p.data.id) : null;
      if (!repo) { reply.code(404).send({ error: "Tədbir tapılmadı." }); return null; }
      return repo;
    };
    r.get("/api/admin/events/:id/results", async (req, reply) => {
      const repo = archived(req, reply, scopeOf(ctx, req).orgId); if (!repo) return;
      return { event: repo.getEvent(), meta: repo.meta(), ...adminResults(repo, cfg) };
    });
    r.get("/api/admin/events/:id/export.xlsx", async (req, reply) => { const repo = archived(req, reply, scopeOf(ctx, req).orgId); if (repo) return sendResultsXlsx(reply, repo); });
    r.get("/api/admin/events/:id/export.pdf", async (req, reply) => { const repo = archived(req, reply, scopeOf(ctx, req).orgId); if (repo) return sendResultsPdf(reply, repo); });
    r.get("/api/admin/events/:id/history.xlsx", async (req, reply) => { const repo = archived(req, reply, scopeOf(ctx, req).orgId); if (repo) return sendHistory(reply, repo); });
    // Scoring history: every submit and change, kept even after a wipe. ?juror=&team=&before=<id>&limit=
    r.get<{ Querystring: Record<string, string | undefined> }>("/api/admin/history", async req => {
      const { repo, rt } = scopeOf(ctx, req);
      const n = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
      return repo.history({ jurorId: n(req.query.juror), teamId: n(req.query.team), before: n(req.query.before), limit: n(req.query.limit) });
    });
  });
}
