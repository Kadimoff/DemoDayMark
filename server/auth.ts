import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import type { Repo, UserRow } from "./repo.js";

export type Role = "admin" | "juror";

// One cookie per role, so a coordinator can keep an admin tab and a juror tab open in the same
// browser: logging in or out as a juror never touches the admin session, and vice versa.
export const COOKIES: Record<Role, string> = { admin: "ij_admin", juror: "ij_juror" };
/** Pre-split cookie name; still honoured so existing sessions survive the upgrade. */
export const LEGACY_COOKIE = "ij_sid";

export interface AuthUser {
  id: number;
  role: "admin" | "juror";
  username: string;
  displayName: string;
  sessionId: string;
  /** orgs: the organisation this session acts in (root: the one picked on "Təşkilatlar", else its home org). */
  orgId: number;
  /** orgs: the organisation the account belongs to. */
  homeOrgId: number;
  /** orgs: platform owner. */
  isRoot: boolean;
}

/** orgs: signed cookie with the organisation the platform owner is looking at ("impersonation"); ignored for anyone else. */
export const ORG_COOKIE = "ij_org";

declare module "fastify" {
  interface FastifyRequest { user: AuthUser | null }
}

export const newToken = () => randomBytes(32).toString("base64url");
export const tokenId = (token: string) => createHash("sha256").update(token).digest("hex");

/** Resolves a raw (already unsigned) cookie token to its user, or null. */
export function userFromToken(repo: Repo, cfg: Config, token: string | null | undefined): AuthUser | null {
  if (!token) return null;
  const sid = tokenId(token);
  const s = repo.session(sid);
  if (!s) return null;
  if (Date.now() - s.last_seen_at > cfg.sessionTtlMs) { repo.deleteSession(sid); return null; }
  const u = repo.userById(s.user_id);
  if (!u || !u.active) return null;
  // A deactivated organisation signs its coordinators and jurors out (the platform owner is never affected).
  if (!u.is_root && !orgActive(repo, u.org_id)) return null;
  return toAuthUser(u, sid);
}

export const orgActive = (r: { db: DB }, orgId: number) =>
  !!(r.db.prepare("SELECT active FROM orgs WHERE id = ?").get(orgId) as { active: number } | undefined)?.active;

type Unsign = (v: string) => { valid: boolean; value: string | null };

/**
 * Picks the session for the role a page or endpoint needs. With no preference the admin
 * session wins, then the juror one.
 */
export function resolveUser(repo: Repo, cfg: Config, cookies: Record<string, string | undefined>, unsign: Unsign, want: Role | null): AuthUser | null {
  const read = (name: string) => {
    const raw = cookies[name];
    if (!raw) return null;
    const u = unsign(raw);
    return u.valid ? userFromToken(repo, cfg, u.value) : null;
  };
  const acting = (u: AuthUser) => {
    if (!u.isRoot) return u;
    const raw = cookies[ORG_COOKIE];
    const v = raw ? unsign(raw) : null;
    const id = v?.valid && v.value && /^\d+$/.test(v.value) ? Number(v.value) : null;
    return id && repo.db.prepare("SELECT 1 FROM orgs WHERE id = ?").get(id) ? { ...u, orgId: id } : u;
  };
  for (const role of want ? [want] : (["admin", "juror"] as const)) {
    const u = read(COOKIES[role]);
    if (u && u.role === role) return acting(u);
  }
  const legacy = read(LEGACY_COOKIE);
  return legacy && (!want || legacy.role === want) ? acting(legacy) : null;
}

/** Which role's session a URL runs under; null = no preference. */
export function roleForUrl(url: string): Role | null {
  const [path, query = ""] = url.split("?");
  if (path === "/admin" || path.startsWith("/admin/") || path.startsWith("/api/admin/") || path.startsWith("/api/root/")) return "admin";
  if (path === "/juror" || path.startsWith("/api/juror/")) return "juror";
  if (path.startsWith("/api/auth/")) {
    const r = new URLSearchParams(query).get("role");
    return r === "admin" || r === "juror" ? r : null;
  }
  return null;
}

export const toAuthUser = (u: UserRow, sessionId: string): AuthUser => ({
  id: u.id, role: u.role, username: u.username, displayName: u.display_name, sessionId,
  orgId: u.org_id, homeOrgId: u.org_id, isRoot: u.role === "admin" && !!u.is_root,
});

/** In-memory login throttle keyed by IP + username: N failures → locked for a while. */
export class LoginLimiter {
  private m = new Map<string, { fails: number; until: number }>();
  constructor(private max: number, private lockMs: number) {}
  key(ip: string, username: string) { return `${ip}|${username.trim().toLowerCase()}`; }
  retryAfter(key: string): number {
    const e = this.m.get(key);
    if (!e || e.until <= Date.now()) return 0;
    return Math.ceil((e.until - Date.now()) / 1000);
  }
  fail(key: string) {
    const e = this.m.get(key) ?? { fails: 0, until: 0 };
    if (e.until && e.until <= Date.now()) { e.fails = 0; e.until = 0; }
    e.fails++;
    if (e.fails >= this.max) e.until = Date.now() + this.lockMs;
    this.m.set(key, e);
  }
  success(key: string) { this.m.delete(key); }
}

export function requireRole(role: Role) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: "Sessiya bitib. Yenidən daxil olun." });
    if (req.user.role !== role) return reply.code(403).send({ error: "Bu bölməyə giriş icazəniz yoxdur." });
  };
}

/** orgs: platform-owner-only APIs (/api/root/*). Coordinators get 403. */
export async function requireRoot(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: "Sessiya bitib. Yenidən daxil olun." });
  if (req.user.role !== "admin" || !req.user.isRoot) return reply.code(403).send({ error: "Bu bölməyə giriş icazəniz yoxdur." });
}

/** Origin allow-list check shared by REST (state-changing requests) and the socket handshake. */
export function originAllowed(cfg: Config, origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;
  const o = origin.replace(/\/$/, "");
  if (cfg.origins.length) return cfg.origins.includes(o);
  // No ORIGIN configured: accept same-host requests (dev, LAN).
  try { return !!host && new URL(o).host === host; } catch { return false; }
}
