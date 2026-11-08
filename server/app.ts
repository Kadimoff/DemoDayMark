import fastifyCompress from "@fastify/compress";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { LoginLimiter, originAllowed, resolveUser, roleForUrl } from "./auth.js";
import { bootstrapOrg } from "./bootstrap.js";
import { publicScope } from "./context.js";
import { Converter } from "./files.js";
import { Orgs, ROOT_ORG_ID } from "./orgs.js";
import { rootRoutes } from "./routes/root.js";
import { ensureBaseline } from "./baseline.js";
import type { Config } from "./config.js";
import type { Ctx } from "./context.js";
import { backupBeforeMigrate, openDb, quickCheck, type DB } from "./db.js";
import { applyRestoreRequest, BackupScheduler } from "./backups.js";
import { LoopMonitor, publicHealth, type HealthDeps } from "./health.js";
import { createRequire } from "node:module";
import { resolveTeam } from "./teams.js";
import { stageRoutes } from "./routes/stage.js";
import { teamRoutes } from "./routes/team.js";
import { Realtime } from "./realtime.js";
import { revealPublicView } from "./views.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { jurorRoutes } from "./routes/juror.js";

export interface App { app: FastifyInstance; ctx: Ctx; close: () => Promise<void> }

// Clean URLs → built HTML pages. `role` gates the page itself (data is gated by the API anyway).
const PAGES: Record<string, { file: string; role?: "admin" | "juror" }> = {
  "/login": { file: "login.html" },
  "/juror": { file: "juror.html", role: "juror" },
  "/admin": { file: "admin.html", role: "admin" },
  "/admin/setup": { file: "setup.html", role: "admin" },
  "/admin/pult": { file: "pult.html", role: "admin" },
  // orgs: platform owner only (coordinators are sent back to /admin)
  "/admin/orgs": { file: "orgs.html", role: "admin" },
  // v3: the platform owner's own panel (organisations, live state, projector preview, intervention)
  "/root": { file: "root.html", role: "admin" },
  "/timer": { file: "timer.html" },
  // munsif: the presentation stage is the projector timer page (same server timer); /stage/demo needs no login.
  "/stage": { file: "timer.html" },
  "/stage/demo": { file: "timer.html" },
  "/reveal": { file: "reveal.html" },
  "/speaker": { file: "speaker.html" },
  // munsif: team panel (team session or the "Komanda girişi" form) — guarded by the team API, not by role.
  "/team": { file: "team.html" },
};

/** v3: pages the platform panel shows in its projector preview (same origin only). */
const FRAMEABLE = new Set(["timer.html", "reveal.html"]);

const PDFJS_DIR = (() => {
  try { return path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")); } catch { return ""; }
})();

export async function buildApp(cfg: Config, opts: { logger?: boolean } = {}): Promise<App> {
  // Request logs are noisy during the event; LOG_LEVEL=info brings them back.
  // keepAliveTimeout 4 s: an idle HTTP connection is closed by us (with a FIN the phone sees) before Wi-Fi/NAT gear drops it
  // silently; otherwise a juror who spent two minutes on the form could send their score into a dead connection.
  const app = Fastify({ logger: opts.logger ? { level: process.env.LOG_LEVEL ?? "warn" } : false, trustProxy: cfg.trustProxy, bodyLimit: 256 * 1024,
    keepAliveTimeout: 4000 });
  const startedAt = Date.now();
  // v11: a restore requested with `restore.js <backup>` happens here, before anything opens the database.
  applyRestoreRequest(cfg.dataDir, cfg.dbFile, cfg.backupDir, m => app.log.warn(m));
  // Keep a copy of an existing database before any schema upgrade touches it.
  await backupBeforeMigrate(cfg.dbFile, cfg.backupDir, m => (opts.logger ? console.log(m) : undefined));
  const db = openDb(cfg.dbFile);
  // v11: fast structural check at every start; a problem is logged and shown in /api/health (the server still starts:
  // refusing to start during an event would be worse than serving from a database with e.g. one broken index).
  const integrity = quickCheck(db);
  if (!integrity.ok) app.log.error({ errors: integrity.errors }, "database quick_check FAILED — take a backup and see docs/runbook.md");
  const backups = new BackupScheduler(db, cfg.backupDir, { intervalMs: cfg.backupIntervalMs, keep: cfg.backupKeep },
    (level, m) => (level === "error" ? app.log.error(m) : app.log.info(m)));
  const loop = new LoopMonitor();
  const rt = new Realtime(app, cfg);
  const converter = new Converter(cfg.soffice, cfg.uploadsDir, path.join(cfg.dataDir, "lo-profile"), cfg.sofficeTimeoutMs);
  const orgs = new Orgs(db, cfg, { rt, converter });
  rt.orgs = orgs;
  await ensureBaseline(db, cfg, m => app.log.info(m));
  orgs.invalidate(ROOT_ORG_ID);
  // Session lookups and sign-in are global; org 1's repo serves them (see Repo).
  const { repo, trepo } = orgs.root;
  // orgs: one-time, idempotent coordinator account from BOOTSTRAP_* env (never overwrites an existing user)
  bootstrapOrg(orgs, cfg, m => (opts.logger ? console.warn(m) : undefined));
  repo.purgeSessions(Date.now() - cfg.sessionTtlMs);
  trepo.purgeSessions(Date.now() - cfg.teamSessionTtlMs);
  // Upload deadline reminders, every organisation.
  const deadlineTimer = setInterval(() => {
    try { for (const o of orgs.list()) if (o.active) orgs.scope(o.id).teams.deadlineReminders(); } catch { /* db closed */ }
  }, 60_000);
  deadlineTimer.unref();

  await app.register(fastifyCookie, { secret: cfg.sessionSecret });
  // Phones on the venue Wi-Fi / mobile data: every KB counts (CSS 80 KB → ~14 KB, JS ~3×).
  // Fonts are already WOFF2 and stay uncompressed (the plugin skips non-compressible types).
  await app.register(fastifyCompress, {
    global: true, threshold: 1024, encodings: ["br", "gzip"],
    brotliOptions: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
  });
  const sys: HealthDeps = { db, dbFile: cfg.dbFile, integrity, backups, sockets: () => rt.io.engine?.clientsCount ?? 0, loop, startedAt };
  const ctx: Ctx = { cfg, rt, limiter: new LoginLimiter(cfg.loginMaxFails, cfg.loginLockMs), orgs, converter, sys };
  backups.start();
  resumeConversions(db, converter, m => app.log.warn(m));

  app.decorateRequest("user", null);
  app.decorateRequest("team", null);
  app.addHook("onRequest", async (req, reply) => {
    // Prefer the session of the role this URL needs. If the browser only has the other role,
    // keep that user so role guards answer 403 (not 401) and pages redirect to the right panel.
    const want = roleForUrl(req.url);
    const unsign = (v: string) => req.unsignCookie(v);
    req.user = resolveUser(repo, cfg, req.cookies, unsign, want) ?? (want ? resolveUser(repo, cfg, req.cookies, unsign, null) : null);
    if (req.user && Math.random() < 0.2) repo.touchSession(req.user.sessionId);
    // munsif: team session (own cookie, never an admin/juror user)
    req.team = req.cookies.ij_team ? resolveTeam(trepo, cfg, req.cookies, unsign) : null;
    if (req.team && Math.random() < 0.2) trepo.touchSession(req.team.sessionId);

    // CSRF: every state-changing API call must come from an allowed origin.
    if (req.url.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
      if (!originAllowed(cfg, req.headers.origin, host)) {
        return reply.code(403).send({ error: "Sorğu mənbəyi təsdiqlənmədi (Origin)." });
      }
    }
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    // v3: projector pages may be framed by our own pages (the platform panel's projector preview); everything else: never.
    if (!reply.getHeader("X-Frame-Options")) reply.header("X-Frame-Options", "DENY");
  });

  // v11: errors get their context in the log (route, method, who) — the answer itself stays as Fastify sends it.
  app.addHook("onError", async (req, _reply, err) => {
    const code = (err as { statusCode?: number }).statusCode ?? 500;
    if (code < 500) return;
    req.log.error({ err, method: req.method, url: req.url.split("?")[0], userId: req.user?.id ?? null, orgId: req.user?.orgId ?? req.team?.orgId ?? null,
      teamId: req.team?.teamId ?? null }, "request failed");
  });

  // Touches the database so the container healthcheck fails if SQLite is unreadable (503 then).
  // v11: plus liveness numbers (uptime, version, last backup, open sockets, event loop lag) — nothing secret.
  app.get("/api/health", async (_req, reply) => {
    const h = publicHealth(sys);
    reply.header("Cache-Control", "no-store");
    return h.ok ? h : reply.code(503).send(h);
  });
  // Public: only what the projector timer shows (orgs: ?org=<slug>, default organisation without it).
  app.get("/api/stage", async (req, reply) => {
    const sc = publicScope(ctx, req);
    return sc ? sc.repo.stage() : reply.code(404).send({ error: "Təşkilat tapılmadı." });
  });
  // Public: only places the admin has already revealed.
  app.get("/api/reveal", async (req, reply) => {
    const sc = publicScope(ctx, req);
    return sc ? revealPublicView(sc.repo) : reply.code(404).send({ error: "Təşkilat tapılmadı." });
  });

  // Which sessions this browser has (never 401: the landing page and the login form ask anonymously).
  app.get("/api/auth/session", async req => {
    const unsign = (v: string) => req.unsignCookie(v);
    const admin = resolveUser(repo, cfg, req.cookies, unsign, "admin");
    const juror = resolveUser(repo, cfg, req.cookies, unsign, "juror");
    const panel = admin ? (admin.isRoot && admin.orgId === admin.homeOrgId ? "/root" : "/admin") : juror ? "/juror" : req.team ? "/team" : null;
    // orgs: which organisation the admin session acts in — projector pages show their controls only for their own one.
    const adminOrg = admin ? orgs.byId(admin.orgId)?.slug ?? null : null;
    return { admin: !!admin, juror: !!juror, team: !!req.team, panel, adminOrg, root: !!admin?.isRoot };
  });

  authRoutes(app, ctx);
  jurorRoutes(app, ctx);
  adminRoutes(app, ctx);
  teamRoutes(app, ctx);
  stageRoutes(app, ctx);
  rootRoutes(app, ctx);

  // pdf.js data files (fonts, character maps, decoders) for the stage, the speaker screen and the team preview.
  app.get<{ Params: { dir: string; file: string } }>("/vendor/pdfjs/:dir/:file", async (req, reply) => {
    const { dir, file } = req.params;
    if (!PDFJS_DIR || !["cmaps", "standard_fonts", "wasm", "iccs"].includes(dir) || !/^[\w.\-]+$/.test(file)) return reply.code(404).send({ error: "Tapılmadı." });
    const f = path.join(PDFJS_DIR, dir, file);
    if (!fs.existsSync(f)) return reply.code(404).send({ error: "Tapılmadı." });
    reply.header("Cache-Control", "public, max-age=2592000");
    reply.type(file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
    return reply.send(fs.createReadStream(f));
  });

  // ---------- web app ----------
  const hasWeb = fs.existsSync(path.join(cfg.webDir, "login.html"));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: cfg.webDir,
      index: false,
      wildcard: false,
      cacheControl: false,
      // HTML pages are only reachable through the guarded clean URLs below.
      allowedPath: (_p, _root, req) => !req.url.split("?")[0].endsWith(".html"),
      setHeaders: (res, file) => {
        res.header("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable"
          : file.includes(`${path.sep}fonts${path.sep}`) ? "public, max-age=2592000" : "public, max-age=86400");
      },
    });
  }
  // munsif.im landing (AZ at /, EN at /en/). Signed-in visitors see it too, with a "Panel" button.
  const landing = (file: string) => async (_req: unknown, reply: import("fastify").FastifyReply) => {
    const f = path.join(cfg.webDir, "landing", file);
    if (!fs.existsSync(f)) return reply.code(503).type("text/plain; charset=utf-8").send("Frontend qurulmayıb: npm run build");
    reply.header("Cache-Control", "no-cache");
    reply.header("X-Frame-Options", "DENY");
    return reply.type("text/html; charset=utf-8").send(fs.createReadStream(f));
  };
  app.get("/", landing("index.html"));
  app.get("/en", async (_req, reply) => reply.redirect("/en/"));
  app.get("/en/", landing("en/index.html"));
  app.get("/stage/control", async (_req, reply) => reply.redirect("/admin/pult"));
  // orgs: projector / speaker / team-registration pages of one organisation: /o/<slug>/timer etc.
  const ORG_PAGES = new Set(["/timer", "/stage", "/reveal", "/speaker", "/team"]);
  for (const [url, page] of Object.entries(PAGES)) {
    app.get(url, async (req, reply) => {
      if (page.role && req.user?.role !== page.role) {
        return reply.redirect(req.user ? (req.user.role === "admin" ? "/admin" : "/juror") : "/login");
      }
      if ((url === "/admin/orgs" || url === "/root") && !req.user?.isRoot) return reply.redirect("/admin");
      if (url === "/admin/orgs") return reply.redirect("/root");
      // A coordinator opening a bare projector link gets their own organisation's screen.
      const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      if (ORG_PAGES.has(url) && url !== "/team" && req.user?.role === "admin" && req.user.orgId !== ROOT_ORG_ID && !/[?&]org=/.test(q)) {
        const o = orgs.byId(req.user.orgId);
        if (o) return reply.redirect(`/o/${o.slug}${url}${q}`);
      }
      if (FRAMEABLE.has(page.file)) reply.header("X-Frame-Options", "SAMEORIGIN");
      if (!hasWeb) return reply.code(503).type("text/plain; charset=utf-8").send("Frontend qurulmayıb: npm run build");
      reply.header("Cache-Control", "no-cache");
      return reply.sendFile(page.file);
    });
  }
  app.get<{ Params: { slug: string; page: string } }>("/o/:slug/:page", async (req, reply) => {
    const url = `/${req.params.page}`;
    const o = orgs.bySlug(req.params.slug);
    if (!ORG_PAGES.has(url) || !o || !o.active) return reply.code(404).type("text/plain; charset=utf-8").send("404 · Səhifə tapılmadı");
    if (FRAMEABLE.has(PAGES[url].file)) reply.header("X-Frame-Options", "SAMEORIGIN");
    if (!hasWeb) return reply.code(503).type("text/plain; charset=utf-8").send("Frontend qurulmayıb: npm run build");
    reply.header("Cache-Control", "no-cache");
    return reply.sendFile(PAGES[url].file);
  });
  // Team sign-in link: public page; the code itself is checked by /api/auth/team/:code.
  app.get("/t/:code", async (_req, reply) => {
    if (!hasWeb) return reply.code(503).type("text/plain; charset=utf-8").send("Frontend qurulmayıb: npm run build");
    reply.header("Cache-Control", "no-store");
    return reply.sendFile("team.html");
  });
  // QR landing page: public; the token itself is checked by /api/auth/invite/:token.
  app.get("/j/:token", async (_req, reply) => {
    if (!hasWeb) return reply.code(503).type("text/plain; charset=utf-8").send("Frontend qurulmayıb: npm run build");
    reply.header("Cache-Control", "no-store");
    return reply.sendFile("join.html");
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Tapılmadı." });
    return reply.code(404).type("text/plain; charset=utf-8").send("404 · Səhifə tapılmadı");
  });

  return {
    app,
    ctx,
    close: async () => {
      clearInterval(deadlineTimer);
      backups.stop();
      loop.stop();
      await rt.close();
      await app.close();
      try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* still closes */ }
      db.close();
    },
  };
}

/**
 * v11: a PPTX conversion that was running when the server stopped stays "running" forever otherwise: start it again.
 * Files whose original is gone are marked failed.
 */
function resumeConversions(db: DB, converter: Converter, log: (m: string) => void) {
  const tables = [
    { t: "team_files", where: "active = 1 AND kind = 'presentation'" },
    { t: "event_files", where: "deleted_at IS NULL" },
  ];
  for (const { t, where } of tables) {
    const rows = db.prepare(`SELECT id, stored FROM ${t} WHERE ${where} AND conv IN ('running','pending') AND ext = 'pptx'`).all() as Array<{ id: number; stored: string }>;
    for (const r of rows) {
      if (!converter.available) { db.prepare(`UPDATE ${t} SET conv = 'unavailable' WHERE id = ?`).run(r.id); continue; }
      log(`resuming PPTX conversion (${t} #${r.id}) after a restart`);
      db.prepare(`UPDATE ${t} SET conv = 'running' WHERE id = ?`).run(r.id);
      void converter.convert(r.stored).then(res => {
        try {
          db.prepare(`UPDATE ${t} SET conv = ?, pdf_stored = COALESCE(?, pdf_stored), pages = COALESCE(?, pages) WHERE id = ?`)
            .run(res ? "done" : "failed", res?.pdfStored ?? null, res?.pages ?? null, r.id);
        } catch { /* database closed meanwhile */ }
      });
    }
  }
}
