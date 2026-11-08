// munsif: coordinator API for team links, materials review, team settings, notifications and the presentation stage.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import { idParam, parseBody, scopeOf, type Ctx } from "../context.js";
import type { Repo } from "../repo.js";
import { prettyCode } from "../teamrepo.js";
import { checkEmbeddable } from "../teams.js";
import { handleUpload, rawUploadParser } from "./team.js";
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
});

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
      if (b.action === "accept") teams.notifyTeam(tid, "review.accepted", "Prezentasiyanız qəbul edildi", "Təşkilatçı materiallarınızı təsdiqlədi. Uğurlar!");
      else teams.notifyTeam(tid, "review.returned", "Prezentasiya geri qaytarıldı", b.note);
      repo.audit(req.user!.id, `team.review.${b.action}`, { teamId: tid, note: b.note });
      teams.changed(tid);
      return teams.adminList().find(t => t.teamId === tid);
    });
    r.post("/api/admin/teams/:id/approve", async (req, reply) => {
      const { repo, trepo, teams, rt } = scopeOf(ctx, req);
      const tid = id(repo, req.params, reply); if (!tid) return;
      trepo.setApproval(tid, "approved");
      teams.notifyTeam(tid, "approved", "Komandanız təsdiqləndi", "Siz çıxış sırasına əlavə olundunuz.");
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
      const { repo, trepo, teams, rt } = scopeOf(ctx, req);
      const b = parseBody(stageBody, req.body, reply); if (!b) return;
      const ev = repo.getEvent();
      const show = repo.stage().show;
      const pages = show.pres?.pages ?? null;
      let slide = ev.stageSlide;
      if (b.slide !== undefined) slide = b.slide;
      if (b.delta !== undefined) slide += b.delta;
      slide = Math.max(1, pages ? Math.min(pages, slide) : slide);
      repo.updateEvent({
        stageSlide: slide,
        stageMode: (b.mode as typeof ev.stageMode | undefined) ?? ev.stageMode,
        stageIntroAt: b.intro === true ? Date.now() : b.intro === false ? null : ev.stageIntroAt,
      });
      if (b.mode !== undefined || b.intro !== undefined) repo.audit(req.user!.id, "stage.show", { mode: b.mode, intro: b.intro });
      rt.emitStage();
      return { stage: repo.stage() };
    });
  });
}
