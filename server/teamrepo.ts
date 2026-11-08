// munsif: data access for team sign-in links, team sessions, team materials (files, links) and notifications.
// Kept apart from Repo so the scoring core stays as it was; both work on the same SQLite handle.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";
import type { DB } from "./db.js";
import type { EventState } from "./repo.js";
import type { AdminTeam, Notice, StageShow, TeamApproval, TeamFile, TeamMaterials, TeamReview } from "../shared/types.js";

export interface TeamRow {
  id: number; order_index: number; name: string; project: string; active: number; entry_score: number | null;
  approval: string; members_json: string; site_url: string; video_url: string; site_embeddable: number | null;
  extend_until: number | null; review: string; review_note: string; reviewed_at: number | null; submitted_at: number | null;
  org_id: number;
}
export interface FileRow {
  id: number; team_id: number; kind: "presentation" | "logo"; stored: string; pdf_stored: string | null; orig_name: string;
  ext: string; size: number; pages: number | null; conv: string | null; active: number; uploaded_by: string; created_at: number;
  org_id: number;
}

// Team codes are typed by hand sometimes: no 0/O, 1/I/L. 12 characters ≈ 59 bits; guessing is also rate limited.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const newTeamCode = () => Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
/** "k7q2-m9xd ab3f", a pasted link or a bare code → canonical code, or null. */
export function normalizeTeamCode(input: string): string | null {
  const m = String(input ?? "").trim().match(/(?:\/t\/)?([A-Za-z0-9][A-Za-z0-9 -]{10,30})\/?$/);
  if (!m) return null;
  const c = m[1].replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z0-9]{12}$/.test(c) ? c : null;
}
export const prettyCode = (c: string) => c.replace(/(.{4})(?=.)/g, "$1-");
export const codeHash = (code: string) => createHash("sha256").update(`team:${code}`).digest("hex");

function keyFrom(secret: string) { return createHash("sha256").update(`munsif-team-link:${secret}`).digest(); }
export function sealCode(code: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const enc = Buffer.concat([c.update(code, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString("base64url")).join(".");
}
export function openCode(sealed: string, secret: string): string | null {
  try {
    const [iv, tag, enc] = sealed.split(".").map(s => Buffer.from(s, "base64url"));
    const d = createDecipheriv("aes-256-gcm", keyFrom(secret), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch { return null; }
}

const parseList = (json: string | null | undefined): string[] => {
  try { const v = JSON.parse(json ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
};

export function fileOut(f: FileRow | undefined | null): TeamFile | null {
  if (!f) return null;
  return {
    id: f.id, kind: f.kind, name: f.orig_name, ext: f.ext, size: f.size, pages: f.pages, conv: f.conv,
    viewable: f.ext === "pdf" || !!f.pdf_stored, active: !!f.active, uploadedBy: f.uploaded_by === "admin" ? "admin" : "team",
    createdAt: f.created_at, url: `/api/files/${f.id}`,
  };
}

export const teamRow = (db: DB, id: number) => (db.prepare("SELECT * FROM teams WHERE id = ?").get(id) as TeamRow | undefined) ?? null;
export const activeFile = (db: DB, teamId: number, kind: "presentation" | "logo") =>
  (db.prepare("SELECT * FROM team_files WHERE team_id = ? AND kind = ? AND active = 1 ORDER BY id DESC LIMIT 1").get(teamId, kind) as FileRow | undefined) ?? null;
export const fileRow = (db: DB, id: number) => (db.prepare("SELECT * FROM team_files WHERE id = ?").get(id) as FileRow | undefined) ?? null;

export function materials(db: DB, t: TeamRow): TeamMaterials {
  return {
    members: parseList(t.members_json),
    siteUrl: t.site_url, videoUrl: t.video_url,
    siteEmbeddable: t.site_embeddable == null ? null : !!t.site_embeddable,
    approval: (t.approval === "pending" ? "pending" : "approved") as TeamApproval,
    review: (["submitted", "accepted", "returned"].includes(t.review) ? t.review : "none") as TeamReview,
    reviewNote: t.review_note, submittedAt: t.submitted_at, reviewedAt: t.reviewed_at, extendUntil: t.extend_until,
    presentation: fileOut(activeFile(db, t.id, "presentation")),
    logo: fileOut(activeFile(db, t.id, "logo")),
  };
}

/** Public stage extras: only ever about the team on stage. File URLs point at /api/stage/* which serve only that team. */
export function stageShow(db: DB, ev: EventState, teamId: number | null, next: AdminTeam | null, orgSlug = "root"): StageShow {
  // orgs: the public file URLs name the organisation (old clients without ?org= get the default one).
  const o = `&org=${encodeURIComponent(orgSlug)}`;
  const t = teamId != null ? teamRow(db, teamId) : null;
  const pres = t ? activeFile(db, t.id, "presentation") : null;
  const logo = t ? activeFile(db, t.id, "logo") : null;
  const pdfReady = !!pres && (pres.ext === "pdf" || !!pres.pdf_stored);
  return {
    mode: ev.stageMode,
    slide: ev.stageSlide,
    introAt: ev.stageIntroAt,
    pres: pres && pdfReady ? { fileId: pres.id, url: `/api/stage/presentation?v=${pres.id}${o}`, pages: pres.pages } : null,
    presPending: pres && !pdfReady ? pres.conv ?? "pending" : null,
    site: t?.site_url ? { url: t.site_url, embeddable: t.site_embeddable == null ? null : !!t.site_embeddable } : null,
    logo: logo ? `/api/stage/logo?v=${logo.id}${o}` : null,
    members: t ? parseList(t.members_json) : [],
    next: next && next.id !== teamId ? { name: next.name, project: next.project } : null,
  };
}

/** orgs: team links, sessions, files and notifications of ONE organisation (see Repo). */
export class TeamRepo {
  constructor(readonly db: DB, private secret: string, readonly orgId = 1) {}

  /** The team, only if it belongs to this organisation. */
  row(id: number) { const t = teamRow(this.db, id); return t && t.org_id === this.orgId ? t : null; }
  materials(id: number) { const t = this.row(id); return t ? materials(this.db, t) : null; }

  updateProfile(id: number, p: { name?: string; project?: string; members?: string[]; siteUrl?: string; videoUrl?: string; siteEmbeddable?: boolean | null }) {
    const t = this.row(id);
    if (!t) return null;
    const embeddable = p.siteUrl !== undefined && p.siteUrl !== t.site_url ? (p.siteEmbeddable ?? null) : p.siteEmbeddable !== undefined ? p.siteEmbeddable : t.site_embeddable;
    this.db.prepare("UPDATE teams SET name=?, project=?, members_json=?, site_url=?, video_url=?, site_embeddable=? WHERE id=? AND org_id=?").run(
      p.name ?? t.name, p.project ?? t.project, p.members ? JSON.stringify(p.members) : t.members_json,
      p.siteUrl ?? t.site_url, p.videoUrl ?? t.video_url, embeddable == null ? null : +embeddable, id, this.orgId);
    return this.row(id);
  }
  setReview(id: number, review: TeamReview, note = "") {
    const now = Date.now();
    if (review === "submitted") this.db.prepare("UPDATE teams SET review='submitted', review_note='', submitted_at=? WHERE id=? AND org_id=?").run(now, id, this.orgId);
    else this.db.prepare("UPDATE teams SET review=?, review_note=?, reviewed_at=? WHERE id=? AND org_id=?").run(review, note, now, id, this.orgId);
  }
  setApproval(id: number, approval: TeamApproval) {
    this.db.prepare("UPDATE teams SET approval=?, active=? WHERE id=? AND org_id=?").run(approval, approval === "approved" ? 1 : 0, id, this.orgId);
  }
  setExtend(id: number, until: number | null) { this.db.prepare("UPDATE teams SET extend_until=? WHERE id=? AND org_id=?").run(until, id, this.orgId); }
  /** Self-registration: the team waits (inactive) until the coordinator approves it. */
  register(name: string, project: string) {
    const max = (this.db.prepare("SELECT COALESCE(MAX(order_index), -1) m FROM teams WHERE org_id=?").get(this.orgId) as { m: number }).m;
    const r = this.db.prepare("INSERT INTO teams (order_index, name, project, active, approval, org_id) VALUES (?, ?, ?, 0, 'pending', ?)").run(max + 1, name, project, this.orgId);
    return Number(r.lastInsertRowid);
  }

  // ---------- sign-in links (/t/<code>) ----------
  /** New code for the team; earlier codes stop working. Returns the plain code (shown to the admin). */
  issueLink(teamId: number) {
    const code = newTeamCode();
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE team_links SET revoked_at=? WHERE team_id=? AND revoked_at IS NULL").run(now, teamId);
      this.db.prepare("INSERT INTO team_links (team_id, token_hash, token_enc, created_at, org_id) VALUES (?, ?, ?, ?, ?)").run(teamId, codeHash(code), sealCode(code, this.secret), now, this.orgId);
    })();
    return { code, createdAt: now };
  }
  /** The current link of the team (code decrypted for the admin), or null. */
  link(teamId: number) {
    const r = this.db.prepare("SELECT token_enc, created_at FROM team_links WHERE team_id=? AND org_id=? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1").get(teamId, this.orgId) as
      { token_enc: string; created_at: number } | undefined;
    return r ? { code: openCode(r.token_enc, this.secret), createdAt: r.created_at } : null;
  }
  revokeLinks(teamId: number) { return this.db.prepare("UPDATE team_links SET revoked_at=? WHERE team_id=? AND org_id=? AND revoked_at IS NULL").run(Date.now(), teamId, this.orgId).changes; }
  /** Global on purpose: the code alone says which team (and so which organisation) signs in. */
  teamByCode(code: string) {
    const r = this.db.prepare("SELECT team_id FROM team_links WHERE token_hash=? AND revoked_at IS NULL").get(codeHash(code)) as { team_id: number } | undefined;
    return r ? teamRow(this.db, r.team_id) : null;
  }

  // ---------- sessions ----------
  createSession(id: string, teamId: number, ua: string, ip: string) {
    const now = Date.now();
    const org = teamRow(this.db, teamId)?.org_id ?? this.orgId;
    this.db.prepare("INSERT INTO team_sessions (id, team_id, created_at, last_seen_at, user_agent, ip, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, teamId, now, now, ua.slice(0, 300), ip, org);
  }
  session(id: string) {
    return (this.db.prepare("SELECT * FROM team_sessions WHERE id=?").get(id) as { id: string; team_id: number; last_seen_at: number } | undefined) ?? null;
  }
  touchSession(id: string) { this.db.prepare("UPDATE team_sessions SET last_seen_at=? WHERE id=?").run(Date.now(), id); }
  deleteSession(id: string) { this.db.prepare("DELETE FROM team_sessions WHERE id=?").run(id); }
  deleteTeamSessions(teamId: number) { return this.db.prepare("DELETE FROM team_sessions WHERE team_id=? AND org_id=?").run(teamId, this.orgId).changes; }
  sessionCount(teamId: number) { return (this.db.prepare("SELECT COUNT(*) n FROM team_sessions WHERE team_id=? AND org_id=?").get(teamId, this.orgId) as { n: number }).n; }
  purgeSessions(olderThan: number) { this.db.prepare("DELETE FROM team_sessions WHERE last_seen_at < ?").run(olderThan); }

  // ---------- files ----------
  addFile(f: { teamId: number; kind: "presentation" | "logo"; stored: string; origName: string; ext: string; size: number; pages: number | null; conv: string | null; by: "team" | "admin" }) {
    return this.db.transaction(() => {
      if (!this.row(f.teamId)) throw new Error("team outside the organisation");
      this.db.prepare("UPDATE team_files SET active=0 WHERE team_id=? AND kind=? AND org_id=?").run(f.teamId, f.kind, this.orgId);
      const r = this.db.prepare(`INSERT INTO team_files (team_id, kind, stored, orig_name, ext, size, pages, conv, active, uploaded_by, created_at, org_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(f.teamId, f.kind, f.stored, f.origName, f.ext, f.size, f.pages, f.conv, f.by, Date.now(), this.orgId);
      return fileRow(this.db, Number(r.lastInsertRowid))!;
    })();
  }
  setConversion(fileId: number, p: { conv: string; pdfStored?: string | null; pages?: number | null }) {
    this.db.prepare("UPDATE team_files SET conv=?, pdf_stored=COALESCE(?, pdf_stored), pages=COALESCE(?, pages) WHERE id=? AND org_id=?").run(p.conv, p.pdfStored ?? null, p.pages ?? null, fileId, this.orgId);
  }
  history(teamId: number) {
    return (this.db.prepare("SELECT * FROM team_files WHERE team_id=? AND org_id=? ORDER BY id DESC LIMIT 30").all(teamId, this.orgId) as FileRow[]).map(f => fileOut(f)!);
  }
  /** The file, only if it belongs to this organisation. */
  file(id: number) { const f = fileRow(this.db, id); return f && f.org_id === this.orgId ? f : null; }
  activeFile(teamId: number, kind: "presentation" | "logo") { return this.row(teamId) ? activeFile(this.db, teamId, kind) : null; }

  // ---------- notifications ----------
  addNotice(target: "admin" | "team", teamId: number | null, kind: string, title: string, body = ""): Notice {
    const r = this.db.prepare("INSERT INTO notifications (target, team_id, kind, title, body, created_at, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(target, teamId, kind, title, body, Date.now(), this.orgId);
    return this.notice(Number(r.lastInsertRowid))!;
  }
  notice(id: number) {
    const r = this.db.prepare("SELECT * FROM notifications WHERE id=? AND org_id=?").get(id, this.orgId) as any;
    return r ? mapNotice(r) : null;
  }
  notices(target: "admin" | "team", teamId: number | null, limit = 50): Notice[] {
    const rows = target === "admin"
      ? this.db.prepare("SELECT * FROM notifications WHERE target='admin' AND org_id=? ORDER BY id DESC LIMIT ?").all(this.orgId, limit)
      : this.db.prepare("SELECT * FROM notifications WHERE target='team' AND team_id=? AND org_id=? ORDER BY id DESC LIMIT ?").all(teamId, this.orgId, limit);
    return (rows as any[]).map(mapNotice);
  }
  markRead(target: "admin" | "team", teamId: number | null) {
    if (target === "admin") this.db.prepare("UPDATE notifications SET read_at=? WHERE target='admin' AND org_id=? AND read_at IS NULL").run(Date.now(), this.orgId);
    else this.db.prepare("UPDATE notifications SET read_at=? WHERE target='team' AND team_id=? AND org_id=? AND read_at IS NULL").run(Date.now(), teamId, this.orgId);
  }
  /** Was a notice of this kind sent to the team after `since`? (de-duplicates reminders) */
  sentSince(teamId: number, kind: string, since: number) {
    return !!this.db.prepare("SELECT 1 FROM notifications WHERE target='team' AND team_id=? AND org_id=? AND kind=? AND created_at >= ?").get(teamId, this.orgId, kind, since);
  }
}

const mapNotice = (r: any): Notice => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, teamId: r.team_id, at: r.created_at, read: r.read_at != null });
