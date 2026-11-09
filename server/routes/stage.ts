// munsif: coordinator API for team links, materials review, team settings, notifications and the presentation stage.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import { idParam, parseBody, scopeOf, type Ctx } from "../context.js";
import type { Repo } from "../repo.js";
import { prettyCode } from "../teamrepo.js";
import { checkEmbeddable } from "../teams.js";
import { handleUpload, rawUploadParser, sendStored } from "./team.js";
import { moveSlide } from "../stagectl.js";
import { eventFileOut } from "../teamrepo.js";
import { receiveUpload, UploadError } from "../files.js";
import type { Scope } from "../orgs.js";
import { STAGE_MODES } from "../../shared/types.js";

const reviewBody = z.object({
  action: z.enum(["accept", "return"]),
  note: z.string().trim().max(500, "Səbəb 500 simvoldan uzun ola bilməz.").default(""),
});
const url = z.string().trim().max(500).refine(v => v === "" || /^https?:\/\/[^\s]+$/i.test(v), "Link http:// və ya https:// ilə başlamalıdır.");
const materialsBody = z.object({
  members: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  siteUrl: url.optional(),
  videoUrl: url.optional(),
  extendUntil: z.number().int().positive().nullable().optional(),
});
const settingsBody = z.object({
  teamSlideControl: z.boolean().optional(),
  teamRegistration: z.boolean().optional(),
  teamCanRename: z.boolean().optional(),
  jurorsSeeMaterials: z.boolean().optional(),
  uploadDeadline: z.number().int().positive().nullable().optional(),
});
const stageBody = z.object({
  slide: z.number().int().min(1).max(5000).optional(),
  delta: z.number().int().min(-50).max(50).optional(),
  mode: z.enum(STAGE_MODES as [string, ...string[]]).optional(),
  intro: z.boolean().optional(),
  // v3: the event's own presentation on stage
  scene: z.enum(["team", "event"]).optional(),
  eventFile: z.number().int().positive().nullable().optional(),
  bubble: z.boolean().optional(),
});
/** v3: "Səhnə taymeri" settings (Setup). */
const stageSettingsBody = z.object({
  last5Fx: z.boolean().optional(),
  stageSound: z.boolean().optional(),
  teamSlideControl: z.boolean().optional(),
  eventBubble: z.boolean().optional(),
});
const eventFilePatch = z.object({ title: z.string().trim().max(80, "Ad 80 simvoldan uzun ola bilməz.").optional() });
const eventFileOrder = z.object({ ids: z.array(z.number().int().positive()).max(200) });

export function stageRoutes(app: FastifyInstance, ctx: Ctx) {
  const id = (repo: Repo, params: unknown, reply: FastifyReply) => {
    const r = idParam.safeParse(params);
    if (!r.success) { reply.code(400).send({ error: "Yanlış identifikator." }); return null; }
    if (!repo.team(r.data.id)) { reply.code(404).send({ error: "Komanda tapılmadı." }); return null; }
    return r.data.id;
  };

  app.register(async r => {
    r.addHook("preHandler", requireRole("admin"));
    rawUploadParser(r);

    r.get("/api/admin/materials", async req => {
      const { repo, trepo, teams, rt } = scopeOf(ctx, req);
      const ev = repo.getEvent();
      return {
        teams: teams.adminList(),
        settings: { teamRegistration: ev.teamRegistration, teamCanRename: ev.teamCanRename, jurorsSeeMaterials: ev.jurorsSeeMaterials, uploadDeadline: ev.uploadDeadline },
        pick: (() => { const c = trepo.pickCode(); return c ? { code: prettyCode(c), path: `/t/${c}` } : null; })(),
        soffice: teams.converter.available,
        maxUploadMb: Math.round(ctx.cfg.maxUploadBytes / 1048576),
      };
    });

    r.patch("/api/admin/settings/teams", async (req, reply) => {
      const { repo, trepo, teams, rt } = scopeOf(ctx, req);
      const b = parseBody(settingsBody, req.body, reply); if (!b) return;
      const ev = repo.updateEvent(Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)));
      repo.audit(req.user!.id, "teams.settings", b);
      rt.emitConfig();
      rt.to("admin").emit("materials:changed", {});
      return { teamRegistration: ev.teamRegistration, teamCanRename: ev.teamCanRename, jurorsSeeMaterials: ev.jurorsSeeMaterials, uploadDeadline: ev.uploadDeadline };
    });

    // ---------- v14: one shared link for every team (the team picks its name) ----------
    r.post("/api/admin/team-pick", async req => {
      const { repo, trepo, rt } = scopeOf(ctx, req);
      const code = trepo.issuePick();
      repo.audit(req.user!.id, "team.pick-link", {});
      rt.to("admin").emit("materials:changed", {});
      return { code: prettyCode(code), path: `/t/${code}` };
    });
    r.delete("/api/admin/team-pick", async req => {
      const { repo, trepo, rt } = scopeOf(ctx, req);
      trepo.revokePick();
      repo.audit(req.user!.id, "team.pick-link.revoke", {});
      rt.to("admin").emit("materials:changed", {});
      return { ok: true };
    });
    r.post("/api/admin/teams/:id/unclaim", async (req, reply) => {
      const { repo, trepo, rt } = scopeOf(ctx, req);
      const tid = id(repo, req.params, reply); if (!tid) return;
      trepo.unclaim(tid);
      repo.audit(req.user!.id, "team.unclaim", { teamId: tid });
      rt.to("admin").emit("materials:changed", { teamId: tid });
      return { ok: true };
    });

    // ---------- team sign-in links ----------
    r.post("/api/admin/teams/:id/link", async (req, reply) => {
      const { repo, trepo, teams, rt } = scopeOf(ctx, req);
      const tid = id(repo, req.params, reply); if (!tid) return;
      const { code, createdAt } = trepo.issueLink(tid);
      repo.audit(req.user!.id, "team.link", { teamId: tid });
      rt.to("admin").emit("materials:changed", { teamId: tid });
      return { code: prettyCode(code), path: `/t/${code}`, createdAt };
    });
    r.get("/api/admin/teams/:id/link", async (req, reply) => {
      const { repo, trepo, teams, rt } = scopeOf(ctx, req);
      const tid = id(repo, req.params, reply); if (!tid) return;
      const l = trepo.link(tid);
      if (!l?.code) return { code: null, path: null, createdAt: null }; // none yet (200: no console noise)
      return { code: prettyCode(l.code), path: `/t/${l.code}`, createdAt: l.createdAt };
    });
    r.delete("/api/admin/teams/:id/link", async (req, reply) => {
      const { repo, trepo, teams, rt } = scopeOf(ctx, req);
      const tid = id(repo, req.params, reply); if (!tid) return;
      const links = trepo.revokeLinks(tid);
      const sessions = trepo.deleteTeamSessions(tid);
      rt.io.in(`team:${tid}`).disconnectSockets(true);
      repo.audit(req.user!.id, "team.link.revoke", { teamId: tid, links, sessions });
      rt.to("admin").emit("materials:changed", { teamId: tid });
      return { links, sessions };
    });

    // ---------- review / approval / materials ----------
    r.post("/api/admin/teams/:id/review", async (req, reply) => {
      const { repo, trepo, teams, rt } = scopeOf(ctx, req);
      const tid = id(repo, req.params, reply); if (!tid) return;
      const b = parseBody(reviewBody, req.body, reply); if (!b) return;
      if (!trepo.activeFile(tid, "presentation")) return reply.code(409).send({ error: "Komanda hələ prezentasiya yükləməyib." });
      if (b.action === "return" && !b.note) return reply.code(400).send({ error: "Geri qaytarmağın səbəbini yazın." });
      trepo.setReview(tid, b.action === "accept" ? "accepted" : "returned", b.action === "return" ? b.note : "");
      if (b.action === "accept") teams.notifyTeam(tid, "review.accepted", "Prezentasiyanız qəbul edildi", "Koordinator materiallarınızı qəbul etdi. Uğurlar!");
      else teams.notifyTeam(tid, "review.returned", "Prezentasiya geri qaytarıldı", b.note);
      repo.audit(req.user!.id, `team.review.${b.action}`, { teamId: tid, note: b.note });
      teams.changed(tid);
      return teams.adminList().find(t => t.teamId === tid);
    });
    r.post("/api/admin/teams/:id/approve", async (req, reply) => {
      const { repo, trepo, teams, rt } = scopeOf(ctx, req);
      const tid = id(repo, req.params, reply); if (!tid) return;
      trepo.setApproval(tid, "approved");
      teams.notifyTeam(tid, "approved", "Komandanız təsdiqləndi", "Çıxış sırasına əlavə olundunuz.");
      repo.audit(req.user!.id, "team.approve", { teamId: tid });
      rt.emitConfig(); rt.emitStage(); rt.emitResults();
      teams.changed(tid);
      return { ok: true };
    });
    r.patch("/api/admin/teams/:id/materials", async (req, reply) => {
      const { repo, trepo, teams, rt } = scopeOf(ctx, req);
      const tid = id(repo, req.params, reply); if (!tid) return;
      const b = parseBody(materialsBody, req.body, reply); if (!b) return;
      const before = trepo.row(tid)!;
      trepo.updateProfile(tid, { members: b.members, siteUrl: b.siteUrl, videoUrl: b.videoUrl });
      if (b.extendUntil !== undefined) trepo.setExtend(tid, b.extendUntil);
      if (b.siteUrl && b.siteUrl !== before.site_url) {
        void checkEmbeddable(b.siteUrl).then(ok => { try { trepo.updateProfile(tid, { siteEmbeddable: ok }); teams.changed(tid); rt.emitStage(); } catch { /* closed */ } });
      }
      repo.audit(req.user!.id, "team.materials", { teamId: tid, ...b });
      teams.changed(tid);
      rt.emitStage();
      return teams.adminList().find(t => t.teamId === tid);
    });
    r.post("/api/admin/teams/:id/files", async (req, reply) => {
      const { repo, trepo, teams, rt } = scopeOf(ctx, req);
      const tid = id(repo, req.params, reply); if (!tid) return;
      return handleUpload(ctx, scopeOf(ctx, req), req, reply, tid, "admin");
    });

    // ---------- notifications ----------
    r.get("/api/admin/notices", async req => scopeOf(ctx, req).trepo.notices("admin", null, 60));
    r.post("/api/admin/notices/read", async req => { scopeOf(ctx, req).trepo.markRead("admin", null); return { ok: true }; });

    // ---------- presentation stage: slide, view mode, intro ----------
    r.patch("/api/admin/stage", async (req, reply) => {
      const { repo, trepo, rt } = scopeOf(ctx, req);
      const b = parseBody(stageBody, req.body, reply); if (!b) return;
      const ev = repo.getEvent();
      // v3: pick the event presentation (and switch to it), or go back to the team on stage
      let eventFile = ev.stageEventFile, eventSlide = ev.eventSlide;
      if (b.eventFile !== undefined) {
        if (b.eventFile != null && !trepo.eventFile(b.eventFile)) return reply.code(404).send({ error: "Prezentasiya tapılmadı." });
        if (b.eventFile !== ev.stageEventFile) eventSlide = 1;
        eventFile = b.eventFile;
      }
      let scene = b.scene ?? (b.eventFile != null ? "event" : ev.stageScene);
      if (scene === "event" && eventFile == null) eventFile = trepo.eventFiles()[0]?.id ?? null;
      if (scene === "event" && eventFile == null) return reply.code(409).send({ error: "Əvvəlcə proqramın prezentasiyasını yükləyin (Quraşdırma → Proqramın prezentasiyası)." });
      repo.updateEvent({
        stageMode: (b.mode as typeof ev.stageMode | undefined) ?? ev.stageMode,
        stageIntroAt: b.intro === true ? Date.now() : b.intro === false ? null : ev.stageIntroAt,
        stageScene: scene, stageEventFile: eventFile, eventSlide, eventBubble: b.bubble ?? ev.eventBubble,
      });
      moveSlide(repo, b);
      if (b.mode !== undefined || b.intro !== undefined || b.scene !== undefined || b.eventFile !== undefined || b.bubble !== undefined) {
        repo.audit(req.user!.id, "stage.show", { mode: b.mode, intro: b.intro, scene: b.scene, eventFile: b.eventFile, bubble: b.bubble });
      }
      rt.emitStage();
      return { stage: repo.stage() };
    });

    // ---------- v3: stage timer settings (Setup → Səhnə taymeri) ----------
    r.patch("/api/admin/settings/stage", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const b = parseBody(stageSettingsBody, req.body, reply); if (!b) return;
      const ev = repo.updateEvent(Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)));
      repo.audit(req.user!.id, "stage.settings", b);
      rt.emitStage();
      return { last5Fx: ev.last5Fx, stageSound: ev.stageSound, teamSlideControl: ev.teamSlideControl, eventBubble: ev.eventBubble };
    });

    // ---------- v3: the event's own presentations (opening, break, sponsors, rules) ----------
    const efList = (trepo: Scope["trepo"]) => trepo.eventFiles().map(eventFileOut);
    r.get("/api/admin/event-files", async req => {
      const { trepo, teams } = scopeOf(ctx, req);
      return { files: efList(trepo), soffice: teams.converter.available, maxUploadMb: Math.round(ctx.cfg.maxUploadBytes / 1048576) };
    });
    r.post("/api/admin/event-files", async (req, reply) => {
      const sc = scopeOf(ctx, req);
      const { trepo, teams, repo, rt } = sc;
      const rawName = String(req.headers["x-file-name"] ?? "");
      let origName = "";
      try { origName = decodeURIComponent(rawName).replace(/[\\/\0]/g, "_").slice(0, 180); } catch { origName = ""; }
      if (!origName) return reply.code(400).send({ error: "Fayl adı göndərilməyib." });
      if (!req.headers["content-type"]?.startsWith("application/octet-stream")) return reply.code(415).send({ error: "Fayl düzgün göndərilməyib." });
      try {
        const up = await receiveUpload(req.body as any, { dir: ctx.cfg.uploadsDir, kind: "presentation", origName, maxBytes: ctx.cfg.maxUploadBytes,
          declared: Number(req.headers["content-length"] ?? 0) || undefined });
        const isPptx = up.ext === "pptx";
        const f = trepo.addEventFile({ stored: up.stored, origName, ext: up.ext, size: up.size, pages: up.pages, title: origName.replace(/\.[^.]+$/, "").slice(0, 80),
          conv: isPptx ? (teams.converter.available ? "running" : "unavailable") : null });
        if (isPptx && teams.converter.available) {
          void teams.converter.convert(up.stored).then(res => {
            try {
              trepo.setEventFileConversion(f.id, res ? { conv: "done", pdfStored: res.pdfStored, pages: res.pages } : { conv: "failed" });
              rt.to("admin").emit("eventfiles:changed", {});
              if (repo.getEvent().stageEventFile === f.id) rt.emitStage();
            } catch { /* closed meanwhile */ }
          });
        }
        repo.audit(req.user!.id, "event.file.upload", { fileId: f.id, size: up.size, ext: up.ext });
        rt.to("admin").emit("eventfiles:changed", {});
        return { file: eventFileOut(f), files: efList(trepo) };
      } catch (e) {
        if (e instanceof UploadError) return reply.code(e.status).send({ error: e.message });
        throw e;
      }
    });
    r.patch("/api/admin/event-files/:id", async (req, reply) => {
      const { trepo, repo, rt } = scopeOf(ctx, req);
      const p = idParam.safeParse(req.params); if (!p.success) return reply.code(400).send({ error: "Yanlış identifikator." });
      const b = parseBody(eventFilePatch, req.body, reply); if (!b) return;
      if (!trepo.eventFile(p.data.id)) return reply.code(404).send({ error: "Prezentasiya tapılmadı." });
      if (b.title !== undefined) trepo.renameEventFile(p.data.id, b.title);
      rt.to("admin").emit("eventfiles:changed", {});
      if (repo.getEvent().stageEventFile === p.data.id) rt.emitStage();
      return { files: efList(trepo) };
    });
    r.post("/api/admin/event-files/reorder", async (req, reply) => {
      const { trepo, rt } = scopeOf(ctx, req);
      const b = parseBody(eventFileOrder, req.body, reply); if (!b) return;
      trepo.reorderEventFiles(b.ids);
      rt.to("admin").emit("eventfiles:changed", {});
      return { files: efList(trepo) };
    });
    r.delete("/api/admin/event-files/:id", async (req, reply) => {
      const { trepo, repo, rt } = scopeOf(ctx, req);
      const p = idParam.safeParse(req.params); if (!p.success) return reply.code(400).send({ error: "Yanlış identifikator." });
      if (!trepo.removeEventFile(p.data.id)) return reply.code(404).send({ error: "Prezentasiya tapılmadı." });
      const ev = repo.getEvent();
      if (ev.stageEventFile === p.data.id) repo.updateEvent({ stageEventFile: null, stageScene: "team", eventSlide: 1 });
      repo.audit(req.user!.id, "event.file.delete", { fileId: p.data.id });
      rt.to("admin").emit("eventfiles:changed", {});
      rt.emitStage();
      return { files: efList(trepo) };
    });
    r.get<{ Querystring: { download?: string } }>("/api/admin/event-files/:id/file", async (req, reply) => {
      const { trepo } = scopeOf(ctx, req);
      const p = idParam.safeParse(req.params); if (!p.success) return reply.code(400).send({ error: "Yanlış identifikator." });
      const f = trepo.eventFile(p.data.id);
      if (!f) return reply.code(404).send({ error: "Prezentasiya tapılmadı." });
      return sendStored(ctx, reply, f, { asPdf: true, download: req.query.download === "1" });
    });
  });
}
