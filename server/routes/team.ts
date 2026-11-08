// munsif: team sign-in by link (/t/<code>), the team panel API, uploads, and file access.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fs from "node:fs";
import { z } from "zod";
import { newToken, resolveUser, tokenId } from "../auth.js";
import { parseBody, type Ctx } from "../context.js";
import { KINDS, MIME, receiveUpload, storedPath, UploadError, type UploadKind } from "../files.js";
import { normalizeTeamCode, prettyCode, type FileRow } from "../teamrepo.js";
import { checkEmbeddable, TEAM_COOKIE } from "../teams.js";

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
const codeBody = z.object({ code: z.string().trim().min(4, "Kodu yazın.").max(200) });

/** Uploads come as a raw body (application/octet-stream) and are streamed to disk, never buffered. */
export function rawUploadParser(app: FastifyInstance) {
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
}

export async function handleUpload(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, teamId: number, by: "team" | "admin") {
  const { teams, trepo, cfg } = ctx;
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
            if (!r) teams.notifyTeam(teamId, "convert.failed", "PPTX PDF-ə çevrilmədi", "Zəhmət olmasa prezentasiyanı PDF kimi yükləyin.");
            teams.changed(teamId);
            if (ctx.repo.getEvent().currentTeamId === teamId) ctx.rt.emitStage();
          } catch { /* app closed meanwhile */ }
        });
      }
    } else if (by === "team") {
      teams.notifyAdmin("logo", `${team.name} loqo yüklədi`, origName, teamId);
    }
    ctx.repo.audit(null, "team.upload", { teamId, kind, fileId: f.id, by, size: up.size, ext: up.ext });
    teams.changed(teamId);
    if (ctx.repo.getEvent().currentTeamId === teamId) ctx.rt.emitStage();
    return { file: trepo.history(teamId)[0], state: by === "team" ? teams.state(teamId) : undefined };
  } catch (e) {
    if (e instanceof UploadError) return reply.code(e.status).send({ error: e.message });
    throw e;
  }
}

/** Streams a stored upload. `asPdf`: a converted PPTX is served as its PDF. */
export function sendStored(ctx: Ctx, reply: FastifyReply, f: FileRow, opts: { asPdf?: boolean; download?: boolean } = {}) {
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
  const { repo, cfg, trepo, teams, limiter } = ctx;

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

  // Public: what the /t/<code> page shows before signing in.
  app.get<{ Params: { code: string } }>("/api/auth/team/:code", async (req, reply) => {
    const key = limiter.key(req.ip, "team-code");
    if (throttled(req, reply, key)) return;
    const code = normalizeTeamCode(req.params.code);
    const t = code ? trepo.teamByCode(code) : null;
    if (!t) { limiter.fail(key); return reply.code(410).send({ error: "Komanda linki etibarsızdır. Təşkilatçıdan yeni link istəyin." }); }
    return { valid: true, teamName: t.name, project: t.project, eventName: repo.stage().eventName };
  });
  const signIn = async (req: FastifyRequest, reply: FastifyReply, raw: string) => {
    const key = limiter.key(req.ip, "team-code");
    if (throttled(req, reply, key)) return;
    const code = normalizeTeamCode(raw);
    const t = code ? trepo.teamByCode(code) : null;
    if (!t) { limiter.fail(key); return reply.code(410).send({ error: "Kod tanınmadı. Təşkilatçının göndərdiyi linki və ya kodu yoxlayın." }); }
    limiter.success(key);
    startTeamSession(req, reply, t.id);
    repo.audit(null, "team.login", { teamId: t.id, ip: req.ip });
    return { teamId: t.id, name: t.name, redirect: "/team" };
  };
  app.post<{ Params: { code: string } }>("/api/auth/team/:code", async (req, reply) => signIn(req, reply, req.params.code));
  app.post("/api/auth/team-code", async (req, reply) => {
    const b = parseBody(codeBody, req.body, reply); if (!b) return;
    return signIn(req, reply, b.code);
  });

  // Open registration (off by default): the team waits as "pending" until the coordinator approves it.
  app.get("/api/team/registration", async () => ({ open: repo.getEvent().teamRegistration, eventName: repo.stage().eventName }));
  app.post("/api/team/register", async (req, reply) => {
    if (!repo.getEvent().teamRegistration) return reply.code(403).send({ error: "Qeydiyyat bağlıdır. Təşkilatçıdan komanda linki istəyin." });
    const key = limiter.key(req.ip, "team-register");
    if (throttled(req, reply, key)) return;
    const b = parseBody(registerBody, req.body, reply); if (!b) return;
    if (repo.teams().some(t => t.name.toLocaleLowerCase("az") === b.name.toLocaleLowerCase("az"))) return reply.code(409).send({ error: "Bu adda komanda artıq var." });
    limiter.fail(key); // counts registrations too: 5 per IP per lock window
    const id = trepo.register(b.name, b.project);
    const { code } = trepo.issueLink(id);
    startTeamSession(req, reply, id);
    repo.audit(null, "team.register", { teamId: id, name: b.name, ip: req.ip });
    teams.notifyAdmin("register", `Yeni komanda: ${b.name}`, "Qeydiyyatdan keçdi və təsdiqinizi gözləyir.", id);
    ctx.rt.emitConfig();
    return { teamId: id, code: prettyCode(code), path: `/t/${code}`, redirect: "/team" };
  });

  app.post("/api/team/logout", async (req, reply) => {
    if (req.team) trepo.deleteSession(req.team.sessionId);
    reply.clearCookie(TEAM_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.register(async r => {
    r.addHook("preHandler", async (req, reply) => {
      if (!req.team) return reply.code(401).send({ error: "Komanda sessiyası yoxdur. Komanda linki ilə daxil olun." });
    });
    rawUploadParser(r);

    r.get("/api/team/state", async req => teams.state(req.team!.teamId));

    r.patch("/api/team/profile", async (req, reply) => {
      const b = parseBody(profileBody, req.body, reply); if (!b) return;
      const id = req.team!.teamId;
      const ev = repo.getEvent();
      const t = trepo.row(id)!;
      if ((b.name !== undefined && b.name !== t.name) || (b.project !== undefined && b.project !== t.project)) {
        if (!ev.teamCanRename && t.approval !== "pending") return reply.code(403).send({ error: "Komanda və layihə adını yalnız təşkilatçı dəyişə bilər." });
      }
      const linksChange = (b.siteUrl !== undefined && b.siteUrl !== t.site_url) || (b.videoUrl !== undefined && b.videoUrl !== t.video_url);
      if (linksChange && !teams.uploadsOpen(id)) return reply.code(403).send({ error: "Deadline keçib — linkləri dəyişmək olmur. Təşkilatçıya müraciət edin." });
      trepo.updateProfile(id, b);
      repo.audit(null, "team.profile", { teamId: id, ...b });
      if (b.siteUrl && b.siteUrl !== t.site_url) {
        void checkEmbeddable(b.siteUrl).then(ok => { try { trepo.updateProfile(id, { siteEmbeddable: ok }); teams.changed(id); if (repo.getEvent().currentTeamId === id) ctx.rt.emitStage(); } catch { /* closed */ } });
      }
      if (linksChange) teams.notifyAdmin("links", `${trepo.row(id)!.name} linkləri yenilədi`, [b.siteUrl, b.videoUrl].filter(Boolean).join(" · "), id);
      ctx.rt.emitConfig();
      ctx.rt.emitStage();
      teams.changed(id);
      return teams.state(id);
    });

    r.post("/api/team/files", async (req, reply) => {
      const id = req.team!.teamId;
      if (!teams.uploadsOpen(id)) { (req.body as NodeJS.ReadableStream)?.resume?.(); return reply.code(403).send({ error: "Deadline keçib — yükləmə bağlıdır. Təşkilatçıya müraciət edin." }); }
      return handleUpload(ctx, req, reply, id, "team");
    });

    r.post("/api/team/notices/read", async req => { trepo.markRead("team", req.team!.teamId); return { ok: true }; });
  });

  // ---------- file access ----------
  // admin: every file; team: its own files; juror: active presentations of active teams when the coordinator allows it.
  app.get<{ Params: { id: string }; Querystring: { download?: string; orig?: string } }>("/api/files/:id", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "Yanlış identifikator." });
    const f = trepo.file(id);
    const unsign = (v: string) => req.unsignCookie(v);
    const admin = resolveUser(repo, cfg, req.cookies, unsign, "admin");
    const juror = admin ? null : resolveUser(repo, cfg, req.cookies, unsign, "juror");
    if (!admin && !juror && !req.team) return reply.code(401).send({ error: "Daxil olmamısınız." });
    if (!f) return reply.code(404).send({ error: "Fayl tapılmadı." });
    let ok = !!admin;
    if (!ok && req.team && req.team.teamId === f.team_id) ok = true;
    if (!ok && juror) {
      const team = repo.team(f.team_id);
      ok = repo.getEvent().jurorsSeeMaterials && !!team?.active && !!f.active;
    }
    if (!ok) return reply.code(403).send({ error: "Bu fayla giriş icazəniz yoxdur." });
    return sendStored(ctx, reply, f, { asPdf: req.query.orig !== "1", download: req.query.download === "1" });
  });

  // Public, like /api/stage: only the presentation / logo of the team that is on stage right now.
  const stageFile = (kind: "presentation" | "logo") => async (_req: FastifyRequest, reply: FastifyReply) => {
    const cur = repo.getEvent().currentTeamId;
    const team = cur ? repo.team(cur) : null;
    const f = team?.active ? trepo.activeFile(team.id, kind) : null;
    if (!f || (kind === "presentation" && f.ext !== "pdf" && !f.pdf_stored)) return reply.code(404).send({ error: "Səhnədəki komandanın faylı yoxdur." });
    return sendStored(ctx, reply, f, { asPdf: true });
  };
  app.get("/api/stage/presentation", stageFile("presentation"));
  app.get("/api/stage/logo", stageFile("logo"));
}
