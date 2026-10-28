import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { LoginLimiter, originAllowed, resolveUser, roleForUrl } from "./auth.js";
import { ensureBaseline } from "./baseline.js";
import type { Config } from "./config.js";
import type { Ctx } from "./context.js";
import { openDb } from "./db.js";
import { Realtime } from "./realtime.js";
import { Repo } from "./repo.js";
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
  "/timer": { file: "timer.html" },
};

export async function buildApp(cfg: Config, opts: { logger?: boolean } = {}): Promise<App> {
  // Request logs are noisy during the event; LOG_LEVEL=info brings them back.
  const app = Fastify({ logger: opts.logger ? { level: process.env.LOG_LEVEL ?? "warn" } : false, trustProxy: cfg.trustProxy, bodyLimit: 256 * 1024 });
  const db = openDb(cfg.dbFile);
  const repo = new Repo(db);
  await ensureBaseline(repo, cfg, m => app.log.info(m));
  repo.purgeSessions(Date.now() - cfg.sessionTtlMs);

  await app.register(fastifyCookie, { secret: cfg.sessionSecret });
  const rt = new Realtime(app, repo, cfg);
  const ctx: Ctx = { repo, cfg, rt, limiter: new LoginLimiter(cfg.loginMaxFails, cfg.loginLockMs) };

  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req, reply) => {
    // Prefer the session of the role this URL needs. If the browser only has the other role,
    // keep that user so role guards answer 403 (not 401) and pages redirect to the right panel.
    const want = roleForUrl(req.url);
    const unsign = (v: string) => req.unsignCookie(v);
    req.user = resolveUser(repo, cfg, req.cookies, unsign, want) ?? (want ? resolveUser(repo, cfg, req.cookies, unsign, null) : null);
    if (req.user && Math.random() < 0.2) repo.touchSession(req.user.sessionId);

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
    reply.header("X-Frame-Options", "DENY");
  });

  app.get("/api/health", async () => ({ ok: true, time: Date.now() }));
  // Public: only what the projector timer shows.
  app.get("/api/stage", async () => repo.stage());

  authRoutes(app, ctx);
  jurorRoutes(app, ctx);
  adminRoutes(app, ctx);

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
        res.header("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "public, max-age=86400");
      },
    });
  }
  app.get("/", async (req, reply) => reply.redirect(req.user ? (req.user.role === "admin" ? "/admin" : "/juror") : "/login"));
  for (const [url, page] of Object.entries(PAGES)) {
    app.get(url, async (req, reply) => {
      if (page.role && req.user?.role !== page.role) {
        return reply.redirect(req.user ? (req.user.role === "admin" ? "/admin" : "/juror") : "/login");
      }
      if (!hasWeb) return reply.code(503).type("text/plain; charset=utf-8").send("Frontend qurulmayıb: npm run build");
      reply.header("Cache-Control", "no-cache");
      return reply.sendFile(page.file);
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Tapılmadı." });
    return reply.code(404).type("text/plain; charset=utf-8").send("404 · Səhifə tapılmadı");
  });

  return {
    app,
    ctx,
    close: async () => { await rt.close(); await app.close(); db.close(); },
  };
}
