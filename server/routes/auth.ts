import { verify } from "@node-rs/argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COOKIES, LEGACY_COOKIE, newToken, resolveUser, tokenId, type Role } from "../auth.js";
import { hashPassword } from "../baseline.js";
import { parseBody, type Ctx } from "../context.js";

// Verified against on unknown usernames so response time does not reveal which accounts exist.
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= hashPassword(newToken()));

const loginBody = z.object({
  username: z.string().trim().min(1, "İstifadəçi adını daxil edin.").max(64),
  password: z.string().min(1, "Şifrəni daxil edin.").max(200),
});

export function authRoutes(app: FastifyInstance, { repo, cfg, limiter }: Ctx) {
  app.post("/api/auth/login", async (req, reply) => {
    const body = parseBody(loginBody, req.body, reply);
    if (!body) return;
    const key = limiter.key(req.ip, body.username);
    const wait = limiter.retryAfter(key);
    if (wait) {
      reply.header("Retry-After", String(wait));
      return reply.code(429).send({ error: `Çox sayda uğursuz cəhd. ${Math.ceil(wait / 60)} dəqiqə sonra yenidən yoxlayın.` });
    }
    const u = repo.userByUsername(body.username);
    const ok = u ? await verify(u.password_hash, body.password).catch(() => false)
      : (await verify(await dummy(), body.password).catch(() => false), false);
    if (!u || !ok || !u.active) {
      limiter.fail(key);
      return reply.code(401).send({ error: u && ok && !u.active ? "Bu hesab deaktiv edilib. Koordinatora müraciət edin." : "İstifadəçi adı və ya şifrə yanlışdır." });
    }
    limiter.success(key);
    const token = newToken();
    repo.createSession(tokenId(token), u.id, String(req.headers["user-agent"] ?? ""), req.ip);
    repo.audit(u.id, "login", { ip: req.ip });
    // Lax (not Strict): a juror opening the link from Telegram/WhatsApp must still arrive logged in.
    // Cross-site POSTs still carry no cookie, and every write is Origin-checked as well.
    reply.setCookie(COOKIES[u.role], token, {
      httpOnly: true, secure: cfg.cookieSecure, sameSite: "lax", path: "/", signed: true,
      maxAge: Math.floor(cfg.sessionTtlMs / 1000),
    });
    const legacy = resolveUser(repo, cfg, req.cookies, v => req.unsignCookie(v), u.role);
    if (legacy && req.cookies[LEGACY_COOKIE] && !req.cookies[COOKIES[u.role]]) reply.clearCookie(LEGACY_COOKIE, { path: "/" });
    return { role: u.role, displayName: u.display_name, redirect: u.role === "admin" ? "/admin" : "/juror" };
  });

  // Ends only the session of the given role (the page the button was on).
  app.post("/api/auth/logout", async (req, reply) => {
    const role = (req.body as { role?: string } | undefined)?.role;
    const want: Role | null = role === "admin" || role === "juror" ? role : null;
    const user = resolveUser(repo, cfg, req.cookies, v => req.unsignCookie(v), want);
    if (user) {
      repo.deleteSession(user.sessionId);
      reply.clearCookie(COOKIES[user.role], { path: "/" });
      if (req.cookies[LEGACY_COOKIE] && !req.cookies[COOKIES[user.role]]) reply.clearCookie(LEGACY_COOKIE, { path: "/" });
    }
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "Daxil olmamısınız." });
    const { id, role, username, displayName } = req.user;
    const unsign = (v: string) => req.unsignCookie(v);
    const sessions = (["admin", "juror"] as const)
      .map(r => resolveUser(repo, cfg, req.cookies, unsign, r))
      .filter(u => u != null)
      .map(u => ({ role: u.role, displayName: u.displayName }));
    return { id, role, username, displayName, sessions };
  });
}
