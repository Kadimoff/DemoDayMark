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
      seedOrgEvent(new Repo(this.db, org.id, org.slug), this.cfg, org.name);
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
    const trepo = new TeamRepo(this.db, this.cfg.sessionSecret, org.id);
    const rt = this.deps.rt.org(org.id);
    const teams = new TeamService(trepo, repo, this.cfg, rt, this.deps.converter);
    const sc: Scope = { orgId: org.id, slug: org.slug, repo, trepo, rt, teams };
    this.cache.set(id, sc);
    return sc;
  }
  get root() { return this.scope(ROOT_ORG_ID); }

  /** Counts for the platform owner's list (no scores or names leave the organisation). */
  stats(id: number) {
    const n = (sql: string) => (this.db.prepare(sql).get(id) as { n: number }).n;
    return {
      teams: n("SELECT COUNT(*) n FROM teams WHERE org_id = ?"),
      jurors: n("SELECT COUNT(*) n FROM users WHERE org_id = ? AND role = 'juror'"),
      scores: n("SELECT COUNT(*) n FROM scores WHERE org_id = ?"),
      coordinators: this.db.prepare("SELECT id, username, display_name displayName, active, is_root isRoot FROM users WHERE org_id = ? AND role = 'admin' ORDER BY id").all(id) as
        Array<{ id: number; username: string; displayName: string; active: number; isRoot: number }>,
    };
  }
}
