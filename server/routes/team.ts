// munsif: team sign-in by link (/t/<code>), the team panel API, uploads, and file access.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import { z } from "zod";
import { newToken, resolveUser, tokenId } from "../auth.js";
import { parseBody, publicScope, scopeOf, type Ctx } from "../context.js";
import type { Scope } from "../orgs.js";
import { KINDS, MIME, receiveUpload, storedPath, UploadError, type UploadKind } from "../files.js";
import { fileRow, normalizeTeamCode, orgByPickCode, prettyCode, type FileRow } from "../teamrepo.js";
import { activeEventOf, orgActive } from "../auth.js";
import { checkEmbeddable, TEAM_COOKIE } from "../teams.js";
import { moveSlide } from "../stagectl.js";

const url = z.string().trim().max(500).refine(v => v === "" || /^https?:\/\/[^\s]+$/i.test(v), "Link http:// və ya https:// ilə başlamalıdır.");
const profileBody = z.object({
  name: z.string().trim().min(1, "Komanda adı boş ola bilməz.").max(120).optional(),
  project: z.string().trim().max(160).optional(),
  members: z.array(z.string().trim().min(1).max(80)).max(12, "Ən çox 12 üzv yazıla bilər.").optional(),
  siteUrl: url.optional(),
  videoUrl: url.optional(),
});
const registerBody = z.object({
  name: z.string().trim().min(2, "Komandanın adını yazın.").max(120),
  project: z.string().trim().max(160).default(""),
});
const slideBody = z.object({ slide: z.number().int().min(1).max(5000).optional(), delta: z.number().int().min(-50).max(50).optional() });
const memberName = z.string().trim().max(80, "Ad 80 simvoldan uzun ola bilməz.").optional();
const codeBody = z.object({ code: z.string().trim().min(4, "Kodu yazın.").max(200), memberName });

/** Uploads come as a raw body (application/octet-stream) and are streamed to disk, never buffered. */
export function rawUploadParser(app: FastifyInstance) {
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
}

export async function handleUpload(ctx: Ctx, sc: Scope, req: FastifyRequest, reply: FastifyReply, teamId: number, by: "team" | "admin") {
  const { teams, trepo } = sc;
  const { cfg } = ctx;
  const kind = String((req.query as Record<string, string>).kind ?? "presentation") as UploadKind;
  if (!KINDS[kind]) return reply.code(400).send({ error: "Yanlış fayl növü." });
  const rawName = String(req.headers["x-file-name"] ?? "");
  let origName = "";
  try { origName = decodeURIComponent(rawName).replace(/[\\/\0]/g, "_").slice(0, 180); } catch { origName = ""; }
  if (!origName) return reply.code(400).send({ error: "Fayl adı göndərilməyib." });
  if (!req.headers["content-type"]?.startsWith("application/octet-stream")) return reply.code(415).send({ error: "Fayl düzgün göndərilməyib." });
  try {
    const up = await receiveUpload(req.body as NodeJS.ReadableStream as any, {
      dir: cfg.uploadsDir, kind, origName, maxBytes: cfg.maxUploadBytes, declared: Number(req.headers["content-length"] ?? 0) || undefined,
    });
    const isPptx = up.ext === "pptx";
    const f = trepo.addFile({ teamId, kind, stored: up.stored, origName, ext: up.ext, size: up.size, pages: up.pages,
      conv: isPptx ? (teams.converter.available ? "pending" : "unavailable") : null, by });
    const team = trepo.row(teamId)!;
    if (kind === "presentation") {
      trepo.setReview(teamId, "submitted");
      if (by === "team") teams.notifyAdmin("upload", `${team.name} prezentasiya yüklədi`, `${origName}${up.pages ? ` · ${up.pages} slayd` : ""}`, teamId);
      if (isPptx && teams.converter.available) {
        trepo.setConversion(f.id, { conv: "running" });
        void teams.converter.convert(up.stored).then(r => {
          try {
            trepo.setConversion(f.id, r ? { conv: "done", pdfStored: r.pdfStored, pages: r.pages } : { conv: "failed" });
            if (!r) teams.notifyTeam(teamId, "convert.failed", "PPTX PDF-ə çevrilmədi", "Prezentasiyanı PDF kimi yükləyin.");
            teams.changed(teamId);
            if (sc.repo.getEvent().currentTeamId === teamId) sc.rt.emitStage();
          } catch { /* app closed meanwhile */ }
        });
      }
    } else if (by === "team") {
      teams.notifyAdmin("logo", `${team.name} loqo yüklədi`, origName, teamId);
    }
    sc.repo.audit(null, "team.upload", { teamId, kind, fileId: f.id, by, size: up.size, ext: up.ext });
    teams.changed(teamId);
    if (sc.repo.getEvent().currentTeamId === teamId) sc.rt.emitStage();
    return { file: trepo.history(teamId)[0], state: by === "team" ? teams.state(teamId) : undefined };
  } catch (e) {
    if (e instanceof UploadError) return reply.code(e.status).send({ error: e.message });
    throw e;
  }
}

/** Streams a stored upload. `asPdf`: a converted PPTX is served as its PDF. */
export function sendStored(ctx: Ctx, reply: FastifyReply, f: Pick<FileRow, "ext" | "pdf_stored" | "stored" | "orig_name">, opts: { asPdf?: boolean; download?: boolean } = {}) {
  const usePdf = opts.asPdf !== false && f.ext === "pptx" && !!f.pdf_stored;
  const name = usePdf ? f.pdf_stored! : f.stored;
  const ext = usePdf ? "pdf" : f.ext;
  let file: string;
  try { file = storedPath(ctx.cfg.uploadsDir, name); } catch { return reply.code(404).send({ error: "Fayl tapılmadı." }); }
  if (!fs.existsSync(file)) return reply.code(404).send({ error: "Fayl tapılmadı." });
  const base = f.orig_name.replace(/\.[^.]+$/, "") || "fayl";
  const dl = `${base}.${ext}`;
  reply.header("Content-Type", MIME[ext] ?? "application/octet-stream");
  reply.header("Content-Disposition", `${opts.download ? "attachment" : "inline"}; filename="${dl.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(dl)}`);
  reply.header("Cache-Control", "private, no-cache");
  return reply.send(fs.createReadStream(file));
}

export function teamRoutes(app: FastifyInstance, ctx: Ctx) {
  const { cfg, limiter, orgs } = ctx;
  // Team codes and team sessions are global (the code says which team, so which organisation).
  const { repo, trepo } = orgs.root;
  /** The organisation of a team found by its code, if that organisation is active. */
  const teamScope = (t: { org_id: number; event_id: number }) => (orgActive(repo, t.org_id) && t.event_id === activeEventOf(repo, t.org_id) ? orgs.scope(t.org_id) : null);

  function startTeamSession(req: FastifyRequest, reply: FastifyReply, teamId: number) {
    const token = newToken();
    trepo.createSession(tokenId(token), teamId, String(req.headers["user-agent"] ?? ""), req.ip);
    reply.setCookie(TEAM_COOKIE, token, {
      httpOnly: true, secure: cfg.cookieSecure, sameSite: "lax", path: "/", signed: true, maxAge: Math.floor(cfg.teamSessionTtlMs / 1000),
    });
  }
  const throttled = (req: FastifyRequest, reply: FastifyReply, key: string) => {
    const wait = limiter.retryAfter(key);
    if (!wait) return false;
    reply.header("Retry-After", String(wait));
    reply.code(429).send({ error: `Çox sayda uğursuz cəhd. ${Math.ceil(wait / 60)} dəqiqə sonra yenidən yoxlayın.` });
    return true;
  };

  // v14: the shared team link of an organisation (every team picks its own name), or null.
  const pickScope = (code: string | null) => {
    const org = code ? orgByPickCode(trepo.db, code) : null;
    return org && orgActive(repo, org) ? orgs.scope(org) : null;
  };
  /** Teams offered on the shared link: the program's active teams; a claimed one is shown but cannot be picked. */
  const pickList = (sc: Scope) => sc.repo.teams().filter(t => t.active).map(t => ({ id: t.id, name: t.name, project: t.project, taken: !!sc.trepo.row(t.id)?.claimed_at }));

  // Public: what the /t/<code> page shows before signing in (a team's own link, or the shared link with the team list).
  app.get<{ Params: { code: string } }>("/api/auth/team/:code", async (req, reply) => {
    const key = limiter.key(req.ip, "team-code");
    if (throttled(req, reply, key)) return;
    const code = normalizeTeamCode(req.params.code);
    const t = code ? trepo.teamByCode(code) : null;
    const sc = t ? teamScope(t) : null;
    if (t && sc) return { valid: true, teamName: t.name, project: t.project, eventName: sc.repo.stage().eventName };
    const ps = pickScope(code);
    if (ps) return { valid: true, pick: true, eventName: ps.repo.stage().eventName, teams: pickList(ps) };
    limiter.fail(key);
    return reply.code(410).send({ error: "Bu komanda linki artıq işləmir. Koordinatordan yenisini istəyin." });
  });
  const signIn = async (req: FastifyRequest, reply: FastifyReply, raw: string, pickId?: number, member?: string) => {
    const key = limiter.key(req.ip, "team-code");
    if (throttled(req, reply, key)) return;
    const code = normalizeTeamCode(raw);
    const t = code ? trepo.teamByCode(code) : null;
    const sc = t ? teamScope(t) : null;
    if (t && sc) {
      limiter.success(key);
      startTeamSession(req, reply, t.id);
      sc.trepo.markClaimed(t.id);
      if (member) { sc.trepo.addMember(t.id, member); sc.teams.changed(t.id); }
      sc.repo.audit(null, "team.login", { teamId: t.id, ip: req.ip });
      sc.rt.to("admin").emit("materials:changed", { teamId: t.id });
      return { teamId: t.id, name: t.name, redirect: "/team" };
    }
    // v14: shared link: without a team id the page shows the list; with one, the first pick of that team signs in
    const ps = pickScope(code);
    if (!ps) { limiter.fail(key); return reply.code(410).send({ error: "Kod tapılmadı. Koordinatorun göndərdiyi linki və ya kodu yoxlayın." }); }
    if (pickId == null) return { pick: true, path: `/t/${code}` };
    const team = ps.repo.teams().find(x => x.id === pickId && x.active);
    if (!team) return reply.code(404).send({ error: "Komanda tapılmadı. Siyahını yeniləyin." });
    if (!ps.trepo.claim(team.id)) {
      return reply.code(409).send({ error: "Bu komanda artıq daxil olub. Komanda yoldaşınızdan komanda kodunu alın və ya koordinatora yazın." });
    }
    limiter.success(key);
    if (!ps.trepo.link(team.id)?.code) ps.trepo.issueLink(team.id); // the panel shows this code to the teammates
    startTeamSession(req, reply, team.id);
    if (member) ps.trepo.addMember(team.id, member);
    ps.repo.audit(null, "team.pick", { teamId: team.id, ip: req.ip });
    ps.teams.notifyAdmin("pick", `${team.name} daxil oldu`, "Ümumi komanda linki ilə öz adını seçdi.", team.id);
    ps.rt.to("admin").emit("materials:changed", { teamId: team.id });
    return { teamId: team.id, name: team.name, redirect: "/team" };
  };
  const pickBody = z.object({ teamId: z.number().int().positive().optional(), memberName }).default({});
  app.post<{ Params: { code: string } }>("/api/auth/team/:code", async (req, reply) => {
    const b = parseBody(pickBody, req.body ?? {}, reply); if (!b) return;
    return signIn(req, reply, req.params.code, b.teamId, b.memberName);
  });
  app.post("/api/auth/team-code", async (req, reply) => {
    const b = parseBody(codeBody, req.body, reply); if (!b) return;
    return signIn(req, reply, b.code, undefined, b.memberName);
  });

  // Open registration (off by default): the team waits as "pending" until the coordinator approves it.
  // orgs: /o/<slug>/team → ?org=<slug>; the default organisation without it.
  app.get("/api/team/registration", async (req, reply) => {
    const sc = publicScope(ctx, req);
    if (!sc) return reply.code(404).send({ error: "Təşkilat tapılmadı." });
    return { open: sc.repo.getEvent().teamRegistration, eventName: sc.repo.stage().eventName };
  });
  app.post("/api/team/register", async (req, reply) => {
    const sc = publicScope(ctx, req);
    if (!sc) return reply.code(404).send({ error: "Təşkilat tapılmadı." });
    const { repo, trepo, teams } = sc;
    if (!repo.getEvent().teamRegistration) return reply.code(403).send({ error: "Qeydiyyat bağlıdır. Komanda linkini koordinatordan istəyin." });
    const key = limiter.key(req.ip, "team-register");
    if (throttled(req, reply, key)) return;
    const b = parseBody(registerBody, req.body, reply); if (!b) return;
    if (repo.teams().some(t => t.name.toLocaleLowerCase("az") === b.name.toLocaleLowerCase("az"))) return reply.code(409).send({ error: "Bu adda komanda artıq var." });
    limiter.fail(key); // counts registrations too: 5 per IP per lock window
    const id = trepo.register(b.name, b.project);
    const { code } = trepo.issueLink(id);
    startTeamSession(req, reply, id);
    trepo.markClaimed(id);
    repo.audit(null, "team.register", { teamId: id, name: b.name, ip: req.ip });
    teams.notifyAdmin("register", `Yeni komanda: ${b.name}`, "Qeydiyyatdan keçdi və təsdiqinizi gözləyir.", id);
    sc.rt.emitConfig();
    return { teamId: id, code: prettyCode(code), path: `/t/${code}`, redirect: "/team" };
  });

  app.post("/api/team/logout", async (req, reply) => {
    if (req.team) trepo.deleteSession(req.team.sessionId);
    reply.clearCookie(TEAM_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.register(async r => {
    r.addHook("preHandler", async (req, reply) => {
      if (!req.team) return reply.code(401).send({ error: "Daxil olmamısınız. Komanda linki ilə daxil olun." });
    });
    rawUploadParser(r);

    r.get("/api/team/state", async req => scopeOf(ctx, req).teams.state(req.team!.teamId));

    r.patch("/api/team/profile", async (req, reply) => {
      const b = parseBody(profileBody, req.body, reply); if (!b) return;
      const { repo, trepo, teams, rt } = scopeOf(ctx, req);
      const id = req.team!.teamId;
      const ev = repo.getEvent();
      const t = trepo.row(id)!;
      const nameChange = b.name !== undefined && b.name !== t.name;
      if (nameChange || (b.project !== undefined && b.project !== t.project)) {
        if (!ev.teamCanRename && t.approval !== "pending") return reply.code(403).send({ error: "Komanda və layihə adını yalnız koordinator dəyişə bilər." });
      }
      // v15: the coordinator may limit how many times a team renames itself (a pending, self-registered team is free)
      const counted = nameChange && t.approval !== "pending";
      if (counted && ev.teamRenameLimit != null && (t.renames ?? 0) >= ev.teamRenameLimit) {
        return reply.code(403).send({ error: `Komanda adını ${ev.teamRenameLimit} dəfə dəyişmək olardı, limit dolub. Koordinatora yazın.` });
      }
      const linksChange = (b.siteUrl !== undefined && b.siteUrl !== t.site_url) || (b.videoUrl !== undefined && b.videoUrl !== t.video_url);
      if (linksChange && !teams.uploadsOpen(id)) return reply.code(403).send({ error: "Son tarix keçib, linkləri dəyişmək olmur. Koordinatora yazın." });
      trepo.updateProfile(id, b);
      if (counted) trepo.countRename(id);
      repo.audit(null, "team.profile", { teamId: id, ...b });
      if (b.siteUrl && b.siteUrl !== t.site_url) {
        void checkEmbeddable(b.siteUrl).then(ok => { try { trepo.updateProfile(id, { siteEmbeddable: ok }); teams.changed(id); if (repo.getEvent().currentTeamId === id) rt.emitStage(); } catch { /* closed */ } });
      }
      if (linksChange) teams.notifyAdmin("links", `${trepo.row(id)!.name} linkləri yenilədi`, [b.siteUrl, b.videoUrl].filter(Boolean).join(" · "), id);
      rt.emitConfig();
      rt.emitStage();
      teams.changed(id);
      return teams.state(id);
    });

    r.post("/api/team/files", async (req, reply) => {
      const sc = scopeOf(ctx, req);
      const id = req.team!.teamId;
      if (!sc.teams.uploadsOpen(id)) { (req.body as NodeJS.ReadableStream)?.resume?.(); return reply.code(403).send({ error: "Son tarix keçib, yükləmə bağlıdır. Koordinatora yazın." }); }
      return handleUpload(ctx, sc, req, reply, id, "team");
    });

    // v3: the team on stage turns its own slides (only its own presentation, only while it is on stage, only when allowed).
    r.post("/api/team/slide", async (req, reply) => {
      const b = parseBody(slideBody, req.body, reply); if (!b) return;
      const sc = scopeOf(ctx, req);
      const id = req.team!.teamId;
      const perm = sc.teams.slidePermission(id);
      if (!perm.allowed) return reply.code(403).send({ error: perm.reason ?? "Slaydları indi çevirmək olmur." });
      if (moveSlide(sc.repo, b)) { sc.rt.emitStage(); sc.repo.audit(null, "team.slide", { teamId: id, slide: sc.repo.getEvent().stageSlide }); }
      return { slideControl: sc.teams.slidePermission(id), stage: sc.repo.stage() };
    });

    r.get("/api/team/notices", async req => scopeOf(ctx, req).trepo.notices("team", req.team!.teamId, 50));
    r.post("/api/team/notices/read", async req => { scopeOf(ctx, req).trepo.markRead("team", req.team!.teamId); return { ok: true }; });
  });

  // ---------- file access ----------
  // admin: every file; team: its own files; juror: active presentations of active teams when the coordinator allows it.
  app.get<{ Params: { id: string }; Querystring: { download?: string; orig?: string } }>("/api/files/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "Yanlış identifikator." });
    const f = fileRow(repo.db, id);
    const unsign = (v: string) => req.unsignCookie(v);
    const admin = resolveUser(repo, cfg, req.cookies, unsign, "admin");
    const juror = resolveUser(repo, cfg, req.cookies, unsign, "juror");
    if (!admin && !juror && !req.team) return reply.code(401).send({ error: "Daxil olmamısınız." });
    if (!f) return reply.code(404).send({ error: "Fayl tapılmadı." });
    // orgs: the admin sees every file of its own organisation only; a team its own files; a juror the active
    // presentations of its organisation's active teams when the coordinator allows it.
    let ok = !!admin && admin.orgId === f.org_id;
    if (!ok && req.team && req.team.teamId === f.team_id && req.team.orgId === f.org_id) ok = true;
    if (!ok && juror && juror.orgId === f.org_id) {
      const jr = orgs.scope(juror.orgId).repo;
      const team = jr.team(f.team_id);
      ok = jr.getEvent().jurorsSeeMaterials && !!team?.active && !!f.active;
    }
    if (!ok) return reply.code(403).send({ error: "Bu fayla giriş icazəniz yoxdur." });
    return sendStored(ctx, reply, f, { asPdf: req.query.orig !== "1", download: req.query.download === "1" });
  });

  // Public, like /api/stage: only the presentation / logo of the team that is on stage right now.
  const stageFile = (kind: "presentation" | "logo") => async (req: FastifyRequest, reply: FastifyReply) => {
    const sc = publicScope(ctx, req);
    if (!sc) return reply.code(404).send({ error: "Təşkilat tapılmadı." });
    const cur = sc.repo.getEvent().currentTeamId;
    const team = cur ? sc.repo.team(cur) : null;
    const f = team?.active ? sc.trepo.activeFile(team.id, kind) : null;
    if (!f || (kind === "presentation" && f.ext !== "pdf" && !f.pdf_stored)) return reply.code(404).send({ error: "Səhnədəki komandanın faylı yoxdur." });
    return sendStored(ctx, reply, f, { asPdf: true });
  };
  app.get("/api/stage/presentation", stageFile("presentation"));
  // v3: the event's own presentation, only while it is the one on stage (scene "event").
  app.get("/api/stage/event-presentation", async (req, reply) => {
    const sc = publicScope(ctx, req);
    if (!sc) return reply.code(404).send({ error: "Təşkilat tapılmadı." });
    const ev = sc.repo.getEvent();
    const f = ev.stageScene === "event" && ev.stageEventFile != null ? sc.trepo.eventFile(ev.stageEventFile) : null;
    if (!f || (f.ext !== "pdf" && !f.pdf_stored)) return reply.code(404).send({ error: "Səhnədə proqramın prezentasiyası yoxdur." });
    return sendStored(ctx, reply, f, { asPdf: true });
  });
  app.get("/api/stage/logo", stageFile("logo"));
}
