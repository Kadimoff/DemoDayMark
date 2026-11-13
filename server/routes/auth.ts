import { verify } from "@node-rs/argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { activeEventOf, COOKIES, LEGACY_COOKIE, newToken, orgActive, requireRole, resolveUser, tokenId, type Role } from "../auth.js";
import { hashPassword } from "../baseline.js";
import { parseBody, type Ctx } from "../context.js";
import type { UserRow } from "../repo.js";
import { isPlaceholderName } from "../../shared/brand.js";
import { normalizeTeamCode, orgByJurorPickCode } from "../teamrepo.js";
import type { Scope } from "../orgs.js";

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

export const PASSWORD_MIN = 8;
const passwordBody = z.object({
  current: z.string().min(1, "Hazırkı şifrəni daxil edin.").max(200),
  next: z.string().min(PASSWORD_MIN, `Yeni şifrə ən azı ${PASSWORD_MIN} simvol olmalıdır.`).max(200, "Şifrə çox uzundur."),
});

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const { cfg, limiter, orgs } = ctx;
  // Sign-in and sessions are global (usernames, tokens); everything an account then does runs in its organisation.
  const repo = orgs.root.repo;
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
    if (!orgActive(repo, user.org_id)) return { inv, user: null, error: "Bu proqramın təşkilatı deaktiv edilib." };
    if (user.event_id !== activeEventOf(repo, user.org_id)) return { inv, user: null, error: "Bu proqram artıq bitib (arxivdədir)." };
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
    const sc = orgs.scope(user!.org_id);
    const ev = sc.repo.getEvent();
    return { valid: true, currentName: isPlaceholderName(user!.display_name) ? "" : user!.display_name, eventName: sc.repo.stage().eventName, date: ev.date };
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
    const sc = orgs.scope(user.org_id);
    const u = sc.repo.updateUser(user.id, { displayName: body.displayName })!;
    startSession(req, reply, u);
    sc.repo.audit(u.id, "juror.claim", { ip: req.ip, displayName: u.display_name });
    sc.rt.emitJurorJoined(u.id, u.display_name);
    sc.rt.emitConfig();
    return { role: u.role, displayName: u.display_name, redirect: "/juror" };
  });

  // ---------- v16: shared juror link (/jp/<code>) — one QR for every juror ----------
  const jurorPickScope = (raw: string): Scope | null => {
    const code = normalizeTeamCode(raw);
    const org = code ? orgByJurorPickCode(repo.db, code) : null;
    return org && orgActive(repo, org) ? orgs.scope(org) : null;
  };
  /** Juror seats the coordinator created that nobody has signed in to yet, oldest first. */
  const freeSeats = (sc: Scope) => {
    const claimed = sc.repo.claimedJurors();
    return sc.repo.jurors().filter(j => j.active && !claimed.has(j.id));
  };
  /** The juror this browser already is in that program: scanning the shared QR again must not take a second seat. */
  const ownJuror = (req: FastifyRequest, sc: Scope) => {
    const u = resolveUser(repo, cfg, req.cookies, v => req.unsignCookie(v), "juror");
    const row = u && u.orgId === sc.orgId ? repo.userById(u.id) : null;
    return row && row.event_id === sc.eventId && row.active ? row : null;
  };
  const PICK_GONE = "Bu QR kod artıq işləmir. Koordinatordan yenisini istəyin.";

  app.get<{ Params: { code: string } }>("/api/auth/juror-pick/:code", async (req, reply) => {
    const sc = jurorPickScope(req.params.code);
    if (!sc) return reply.code(410).send({ error: PICK_GONE });
    const me = ownJuror(req, sc);
    return { valid: true, eventName: sc.repo.stage().eventName, date: sc.repo.getEvent().date, free: freeSeats(sc).length, signedInAs: me?.display_name ?? null };
  });

  app.post<{ Params: { code: string } }>("/api/auth/juror-pick/:code", async (req, reply) => {
    const key = limiter.key(req.ip, "juror-pick");
    const wait = limiter.retryAfter(key);
    if (wait) {
      reply.header("Retry-After", String(wait));
      return reply.code(429).send({ error: `Çox sayda uğursuz cəhd. ${Math.ceil(wait / 60)} dəqiqə sonra yenidən yoxlayın.` });
    }
    const body = parseBody(claimBody, req.body, reply);
    if (!body) return;
    const sc = jurorPickScope(req.params.code);
    if (!sc) { limiter.fail(key); return reply.code(410).send({ error: PICK_GONE }); }
    const me = ownJuror(req, sc);
    if (me) return { role: "juror", displayName: me.display_name, redirect: "/juror" };
    // No await from here to the session: two jurors scanning at the same moment cannot take the same seat.
    const seat = freeSeats(sc)[0];
    if (!seat) return reply.code(409).send({ error: "Bütün münsif yerləri doludur. Koordinatordan yeni münsif yeri əlavə etməsini istəyin." });
    const token = newToken();
    sc.repo.createInvite(seat.id, tokenId(token), 60_000);
    const inv = sc.repo.invite(tokenId(token));
    if (!inv || !sc.repo.useInvite(inv.id)) return reply.code(409).send({ error: "Yer artıq tutulub, yenidən cəhd edin." });
    const u = sc.repo.updateUser(seat.id, { displayName: body.displayName })!;
    startSession(req, reply, u);
    sc.repo.audit(u.id, "juror.claim", { ip: req.ip, displayName: u.display_name, via: "shared" });
    sc.rt.emitJurorJoined(u.id, u.display_name);
    sc.rt.emitConfig();
    sc.rt.to("admin").emit("materials:changed", {});
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
    if (!u.is_root && !orgActive(repo, u.org_id)) return reply.code(403).send({ error: "Təşkilatınızın hesabı deaktiv edilib. munsif.im ilə əlaqə saxlayın." });
    startSession(req, reply, u);
    // The platform owner starts every sign-in in its own organisation (no leftover "viewing another organisation").
    if (u.is_root) reply.clearCookie("ij_org", { path: "/" });
    orgs.scope(u.org_id).repo.audit(u.id, "login", { ip: req.ip });
    // v3: the platform owner lands on the platform panel, a coordinator on its event panel.
    return { role: u.role, displayName: u.display_name, redirect: u.is_root ? "/root" : u.role === "admin" ? "/admin" : "/juror" };
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
      if (user.role === "admin") reply.clearCookie("ij_org", { path: "/" });
    }
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "Daxil olmamısınız." });
    const { id, role, username, displayName, isRoot, orgId, homeOrgId } = req.user;
    const unsign = (v: string) => req.unsignCookie(v);
    const sessions = (["admin", "juror"] as const)
      .map(r => resolveUser(repo, cfg, req.cookies, unsign, r))
      .filter(u => u != null)
      .map(u => ({ role: u.role, displayName: u.displayName }));
    const o = orgs.byId(orgId);
    // orgs: the organisation this session acts in; `impersonating` = the platform owner is looking at another one.
    return { id, role, username, displayName, sessions, isRoot,
      org: o ? { id: o.id, slug: o.slug, name: o.name, root: o.id === 1 } : null, impersonating: isRoot && orgId !== homeOrgId };
  });

  // orgs: every coordinator (and the platform owner) changes their own password. Other sessions of the account end.
  app.register(async r => {
    r.addHook("preHandler", requireRole("admin"));
    r.post("/api/auth/password", async (req, reply) => {
      const b = parseBody(passwordBody, req.body, reply); if (!b) return;
      const key = limiter.key(req.ip, `pw:${req.user!.username}`);
      const wait = limiter.retryAfter(key);
      if (wait) { reply.header("Retry-After", String(wait)); return reply.code(429).send({ error: `Çox sayda uğursuz cəhd. ${Math.ceil(wait / 60)} dəqiqə sonra yenidən yoxlayın.` }); }
      const u = repo.userById(req.user!.id)!;
      if (!(await verify(u.password_hash, b.current).catch(() => false))) { limiter.fail(key); return reply.code(400).send({ error: "Hazırkı şifrə yanlışdır." }); }
      if (b.current === b.next) return reply.code(400).send({ error: "Yeni şifrə köhnəsindən fərqli olmalıdır." });
      limiter.success(key);
      repo.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword(b.next), u.id);
      const closed = repo.db.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").run(u.id, req.user!.sessionId).changes;
      orgs.scope(u.org_id).repo.audit(u.id, "password.change", { otherSessionsClosed: closed });
      return { ok: true, otherSessionsClosed: closed };
    });
  });
}
