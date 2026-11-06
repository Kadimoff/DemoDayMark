import { verify } from "@node-rs/argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { COOKIES, LEGACY_COOKIE, newToken, resolveUser, tokenId, type Role } from "../auth.js";
import { hashPassword } from "../baseline.js";
import { parseBody, type Ctx } from "../context.js";
import type { UserRow } from "../repo.js";
import { isPlaceholderName } from "../../shared/brand.js";

// Verified against on unknown usernames so response time does not reveal which accounts exist.
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= hashPassword(newToken()));

const loginBody = z.object({
  username: z.string().trim().min(1, "İstifadəçi adını daxil edin.").max(64),
  password: z.string().min(1, "Şifrəni daxil edin.").max(200),
});

const claimBody = z.object({
  displayName: z.string().trim().min(2, "Adınızı və soyadınızı yazın.").max(80, "Ad 80 simvoldan uzun ola bilməz."),
});
const tokenOk = (t: string) => /^[A-Za-z0-9_-]{20,100}$/.test(t);

export function authRoutes(app: FastifyInstance, { repo, cfg, limiter, rt }: Ctx) {
  /** Opens a session for the user and sets that role's cookie. */
  function startSession(req: FastifyRequest, reply: FastifyReply, u: UserRow) {
    const token = newToken();
    repo.createSession(tokenId(token), u.id, String(req.headers["user-agent"] ?? ""), req.ip);
    // Lax (not Strict): a juror opening the link from Telegram/WhatsApp must still arrive logged in.
    // Cross-site POSTs still carry no cookie, and every write is Origin-checked as well.
    reply.setCookie(COOKIES[u.role], token, {
      httpOnly: true, secure: cfg.cookieSecure, sameSite: "lax", path: "/", signed: true,
      maxAge: Math.floor(cfg.sessionTtlMs / 1000),
    });
    const legacy = resolveUser(repo, cfg, req.cookies, v => req.unsignCookie(v), u.role);
    if (legacy && req.cookies[LEGACY_COOKIE] && !req.cookies[COOKIES[u.role]]) reply.clearCookie(LEGACY_COOKIE, { path: "/" });
  }

  /** Why an invite cannot be used, or null when it can. */
  function inviteProblem(token: string) {
    if (!tokenOk(token)) return { inv: null, user: null, error: "QR kod yanlışdır." };
    const inv = repo.invite(tokenId(token));
    if (!inv) return { inv: null, user: null, error: "QR kod tanınmadı. Koordinatordan yenisini istəyin." };
    const user = repo.userById(inv.user_id);
    if (!user || user.role !== "juror") return { inv, user: null, error: "Bu münsif hesabı silinib." };
    if (inv.used_at) return { inv, user, error: "Bu QR kod artıq istifadə olunub. Koordinatordan yenisini istəyin." };
    if (inv.revoked_at) return { inv, user, error: "Bu QR kodun yerinə yenisi yaradılıb. Koordinatordan sonuncu QR-ı istəyin." };
    if (inv.expires_at <= Date.now()) return { inv, user, error: "Bu QR kodun vaxtı bitib. Koordinatordan yenisini istəyin." };
    if (!user.active) return { inv, user, error: "Bu münsif hesabı deaktiv edilib. Koordinatora müraciət edin." };
    return { inv, user, error: null };
  }

  // Public: what the QR landing page needs (only the juror's own placeholder/current name).
  app.get<{ Params: { token: string } }>("/api/auth/invite/:token", async (req, reply) => {
    const { user, error } = inviteProblem(req.params.token);
    if (error) return reply.code(410).send({ error });
    const ev = repo.getEvent();
    return { valid: true, currentName: isPlaceholderName(user!.display_name) ? "" : user!.display_name, eventName: repo.stage().eventName, date: ev.date };
  });

  // The juror types their name: the invite is spent, the name is saved and a juror session starts.
  app.post<{ Params: { token: string } }>("/api/auth/invite/:token", async (req, reply) => {
    const key = limiter.key(req.ip, "qr-invite");
    const wait = limiter.retryAfter(key);
    if (wait) {
      reply.header("Retry-After", String(wait));
      return reply.code(429).send({ error: `Çox sayda uğursuz cəhd. ${Math.ceil(wait / 60)} dəqiqə sonra yenidən yoxlayın.` });
    }
    const body = parseBody(claimBody, req.body, reply);
    if (!body) return;
    const { inv, user, error } = inviteProblem(req.params.token);
    if (error || !inv || !user) {
      if (!inv) limiter.fail(key);
      return reply.code(410).send({ error });
    }
    if (!repo.useInvite(inv.id)) return reply.code(410).send({ error: "Bu QR kod artıq istifadə olunub. Koordinatordan yenisini istəyin." });
    const u = repo.updateUser(user.id, { displayName: body.displayName })!;
    startSession(req, reply, u);
    repo.audit(u.id, "juror.claim", { ip: req.ip, displayName: u.display_name });
    rt.emitJurorJoined(u.id, u.display_name);
    rt.emitConfig();
    return { role: u.role, displayName: u.display_name, redirect: "/juror" };
  });

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
    // Jurors sign in only by scanning the QR the coordinator shows them.
    if (u.role === "juror") return reply.code(403).send({ error: "Münsiflər QR kodla daxil olur. Koordinatordan QR kodu istəyin." });
    startSession(req, reply, u);
    repo.audit(u.id, "login", { ip: req.ip });
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
