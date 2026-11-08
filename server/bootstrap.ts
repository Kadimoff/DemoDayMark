// orgs: one-time, idempotent creation of a customer organisation and its coordinator from the environment, so the
// platform owner can hand out an account on a deploy without touching the database:
//   BOOTSTRAP_ORG_SLUG=demo  BOOTSTRAP_ORG_NAME=Demo  BOOTSTRAP_COORD_USERNAME=demo
//   BOOTSTRAP_COORD_HASH_B64=<base64 of the argon2id hash>   (scripts/hash-password.mjs makes it; no plain password in env)
// On every start: the organisation is created if missing; the user is created if missing. An existing user is never
// touched (no password overwrite). A username that belongs to the platform owner, a juror or another organisation
// makes the whole bootstrap do nothing but log a warning.
import type { Config } from "./config.js";
import { RESERVED_SLUGS, SLUG_RE, type Orgs } from "./orgs.js";

export interface BootstrapEnv { slug: string; name: string; username: string; hashB64: string }

export function bootstrapEnv(env: NodeJS.ProcessEnv = process.env): BootstrapEnv | null {
  const slug = (env.BOOTSTRAP_ORG_SLUG ?? "").trim().toLowerCase();
  const name = (env.BOOTSTRAP_ORG_NAME ?? "").trim();
  const username = (env.BOOTSTRAP_COORD_USERNAME ?? "").trim();
  const hashB64 = (env.BOOTSTRAP_COORD_HASH_B64 ?? "").trim();
  if (!slug && !username && !hashB64) return null;
  return { slug, name: name || slug, username, hashB64 };
}

export type BootstrapResult = "off" | "invalid" | "conflict" | "created" | "org-created" | "user-created" | "unchanged";

export function bootstrapOrg(orgs: Orgs, _cfg: Config, warn: (m: string) => void = () => {}, env: BootstrapEnv | null = bootstrapEnv()): BootstrapResult {
  if (!env) return "off";
  const { slug, name, username } = env;
  if (!slug || !username || !env.hashB64) { warn("bootstrap: BOOTSTRAP_ORG_SLUG, BOOTSTRAP_COORD_USERNAME and BOOTSTRAP_COORD_HASH_B64 are all required — skipped"); return "invalid"; }
  if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) { warn(`bootstrap: "${slug}" is not a usable organisation slug — skipped`); return "invalid"; }
  if (!/^[\p{L}\p{N}._-]{2,64}$/u.test(username)) { warn("bootstrap: BOOTSTRAP_COORD_USERNAME is not a valid username — skipped"); return "invalid"; }
  let hash = "";
  try { hash = Buffer.from(env.hashB64, "base64").toString("utf8").trim(); } catch { /* checked below */ }
  if (!/^\$argon2(id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.test(hash)) {
    warn("bootstrap: BOOTSTRAP_COORD_HASH_B64 is not a base64 argon2 hash (use scripts/hash-password.mjs) — skipped");
    return "invalid";
  }
  const root = orgs.root.repo;
  const existingOrg = orgs.bySlug(slug);
  const user = root.userByUsername(username);
  if (user && (user.is_root || user.role !== "admin" || !existingOrg || user.org_id !== existingOrg.id)) {
    warn(`bootstrap: username "${username}" already belongs to another account — nothing changed`);
    return "conflict";
  }
  if (existingOrg && user) return "unchanged";
  return orgs.db.transaction((): BootstrapResult => {
    const org = existingOrg ?? orgs.create(slug, name);
    const sc = orgs.scope(org.id);
    if (!existingOrg) sc.repo.audit(null, "org.create", { slug: org.slug, name: org.name, by: "bootstrap" });
    const u = sc.repo.createUser("admin", username, name || username, hash);
    sc.repo.audit(null, "coordinator.create", { id: u.id, username: u.username, by: "bootstrap" });
    warn(`bootstrap: ${existingOrg ? "" : `organisation "${org.slug}" and `}coordinator "${u.username}" created`);
    return existingOrg ? "user-created" : "created";
  })();
}
