// orgs: organisations (tenants). Org 1 ("root") is the platform owner's own event and holds every row that existed
// before multi-tenancy. Each organisation has exactly one event row, its own criteria, teams, jurors, scores, files,
// notifications and audit log. A Scope bundles the data access and the realtime rooms of one organisation; routes
// get theirs from the session (admin / juror / team) or, on public screens, from ?org=<slug>.
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import type { Converter } from "./files.js";
import type { OrgRealtime, Realtime } from "./realtime.js";
import { Repo } from "./repo.js";
import { TeamRepo } from "./teamrepo.js";
import { TeamService } from "./teams.js";
import { seedOrgEvent } from "./baseline.js";

export const ROOT_ORG_ID = 1;
export const ROOT_SLUG = "root";
/** Lowercase letters, digits and inner dashes, 2–32 chars (it is part of public URLs: /o/<slug>/timer). */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** Never usable as an organisation slug (URL segments, the default org). */
export const RESERVED_SLUGS = new Set(["root", "admin", "api", "o", "t", "j", "login", "stage", "timer", "reveal", "speaker", "team", "juror", "www", "en", "static", "assets"]);

export interface OrgRow { id: number; slug: string; name: string; created_at: number; active: number }
export interface Org { id: number; slug: string; name: string; createdAt: number; active: boolean; root: boolean }
export const orgOut = (o: OrgRow): Org => ({ id: o.id, slug: o.slug, name: o.name, createdAt: o.created_at, active: !!o.active, root: o.id === ROOT_ORG_ID });

export interface Scope {
  orgId: number;
  slug: string;
  /** v3 events: the organisation's active event. */
  eventId: number;
  repo: Repo;
  trepo: TeamRepo;
  rt: OrgRealtime;
  teams: TeamService;
}

export class Orgs {
  private cache = new Map<number, Scope>();
  constructor(readonly db: DB, private cfg: Config, private deps: { rt: Realtime; converter: Converter }) {}

  list(): OrgRow[] { return this.db.prepare("SELECT * FROM orgs ORDER BY id").all() as OrgRow[]; }
  byId(id: number) { return (this.db.prepare("SELECT * FROM orgs WHERE id = ?").get(id) as OrgRow | undefined) ?? null; }
  bySlug(slug: string) { return (this.db.prepare("SELECT * FROM orgs WHERE slug = ?").get(String(slug).toLowerCase()) as OrgRow | undefined) ?? null; }

  /** New organisation with an empty event (default rubric and durations, brand = the organisation's name). */
  create(slug: string, name: string): OrgRow {
    const s = slug.trim().toLowerCase();
    if (!SLUG_RE.test(s) || RESERVED_SLUGS.has(s)) throw new Error(`invalid slug: ${slug}`);
    return this.db.transaction(() => {
      const r = this.db.prepare("INSERT INTO orgs (slug, name, created_at, active) VALUES (?, ?, ?, 1)").run(s, name.trim(), Date.now());
      const org = this.byId(Number(r.lastInsertRowid))!;
      seedOrgEvent(this.db, org.id, org.slug, this.cfg, org.name);
      this.cache.delete(org.id);
      return org;
    })();
  }
  update(id: number, p: { name?: string; active?: boolean }) {
    const o = this.byId(id);
    if (!o) return null;
    this.db.prepare("UPDATE orgs SET name = ?, active = ? WHERE id = ?").run(p.name?.trim() ?? o.name, p.active == null ? o.active : +p.active, id);
    return this.byId(id);
  }

  /** Data access + realtime of one organisation. Throws for an unknown id (callers resolve ids from sessions / slugs). */
  scope(id: number): Scope {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const org = this.byId(id);
    if (!org) throw new Error(`unknown organisation ${id}`);
    const repo = new Repo(this.db, org.id, org.slug);
    const trepo = new TeamRepo(this.db, this.cfg.sessionSecret, org.id, repo.eventId);
    const rt = this.deps.rt.org(org.id);
    const teams = new TeamService(trepo, repo, this.cfg, rt, this.deps.converter);
    const sc: Scope = { orgId: org.id, slug: org.slug, eventId: repo.eventId, repo, trepo, rt, teams };
    // A scope is cached only once its event exists (a brand-new database seeds it right after).
    if (repo.eventId) this.cache.set(id, sc);
    return sc;
  }
  get root() { return this.scope(ROOT_ORG_ID); }
  /** v3 events: drop the cached scope (its active event changed). */
  invalidate(id: number) { this.cache.delete(id); }
  /** v3 events: the organisation's active event id (0 = none yet). */
  activeEventId(orgId: number) {
    return (this.db.prepare("SELECT id FROM events WHERE org_id = ? AND status = 'active'").get(orgId) as { id: number } | undefined)?.id ?? 0;
  }
  /** v3 events: read-only data access to any event of the organisation (archived ones included). */
  eventRepo(orgId: number, eventId: number) {
    const org = this.byId(orgId);
    if (!org) return null;
    const ok = this.db.prepare("SELECT 1 FROM events WHERE id = ? AND org_id = ?").get(eventId, orgId);
    return ok ? new Repo(this.db, org.id, org.slug, eventId) : null;
  }

  /** Counts for the platform owner's list (no scores or names leave the organisation). */
  stats(id: number) {
    const ev = this.activeEventId(id);
    const n = (sql: string) => (this.db.prepare(sql).get(id, ev) as { n: number }).n;
    return {
      teams: n("SELECT COUNT(*) n FROM teams WHERE org_id = ? AND event_id = ? AND active = 1"),
      jurors: n("SELECT COUNT(*) n FROM users WHERE org_id = ? AND event_id = ? AND role = 'juror' AND active = 1"),
      scores: n("SELECT COUNT(*) n FROM scores WHERE org_id = ? AND event_id = ?"),
      events: (this.db.prepare("SELECT COUNT(*) n FROM events WHERE org_id = ?").get(id) as { n: number }).n,
      coordinators: this.db.prepare("SELECT id, username, display_name displayName, active, is_root isRoot FROM users WHERE org_id = ? AND role = 'admin' ORDER BY id").all(id) as
        Array<{ id: number; username: string; displayName: string; active: number; isRoot: number }>,
    };
  }
}
