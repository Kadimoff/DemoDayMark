// Data access. Every function returns plain shared/types objects; no route touches SQL directly.
import type { DB } from "./db.js";
import { asProduct, brandName, DEFAULT_FEEDBACK_TAGS, type Product } from "../shared/brand.js";
import { normalizeSnapshot, type RevealSnapshot } from "../shared/reveal.js";
import type { AdminTeam, Criterion, HistoryPage, HistoryRow, Juror, ScoreRow, StagePayload, TimerState } from "../shared/types.js";

interface EventRow {
  name: string;
  date: string;
  current_team_id: number | null;
  timer_visible: number;
  timer_running: number;
  timer_offset_sec: number;
  timer_anchor_at: number | null;
  pitch_sec: number;
  qa_sec: number;
  locked: number;
  show_juror_total: number;
  include_entry: number;
  entry_max: number;
  feedback_tags_json: string | null;
  reveal_top: number;
  product: string;
  final_order_json: string | null;
  reveal_hide_scores: number;
  reveal_batch: number;
}

export interface EventState {
  /** Brand prefix only ("Ignite"); the display name is displayName → "Ignite Hakaton". */
  name: string;
  /** Event type shown after the prefix. */
  product: Product;
  /** brandName(name, product), e.g. "Ignite Hakaton". */
  displayName: string;
  date: string;
  currentTeamId: number | null;
  timer: TimerState;
  locked: boolean;
  showJurorTotal: boolean;
  /** Final score = entry score + Demo Day score when true; Demo Day score alone when false. */
  includeEntry: boolean;
  /** Scale of entry scores (e.g. 50). */
  entryMax: number;
  /** Quick feedback chips jurors can tick. */
  feedbackTags: string[];
  /** Places 1..revealTop get a suspense step in the results reveal. */
  revealTop: number;
  /** Lower places revealed this many per click. */
  revealBatch: number;
  /** The reveal screen shows places and names only. */
  revealHideScores: boolean;
  /** Jurors' final decision: team ids best first, or null = score order. */
  finalOrder: number[] | null;
}

export interface UserRow {
  id: number;
  role: "admin" | "juror";
  username: string;
  display_name: string;
  password_hash: string;
  active: number;
  created_at: number;
}

export class Repo {
  constructor(readonly db: DB) {}

  // ---------- event ----------
  getEvent(): EventState {
    const r = this.db.prepare("SELECT * FROM event WHERE id = 1").get() as EventRow;
    const product = asProduct(r.product);
    return {
      name: r.name,
      product,
      displayName: brandName(r.name, product),
      date: r.date,
      currentTeamId: r.current_team_id,
      timer: {
        visible: !!r.timer_visible,
        running: !!r.timer_running,
        offsetSec: r.timer_offset_sec,
        anchorAt: r.timer_anchor_at,
        pitchSec: r.pitch_sec,
        qaSec: r.qa_sec,
      },
      locked: !!r.locked,
      showJurorTotal: !!r.show_juror_total,
      includeEntry: !!r.include_entry,
      entryMax: r.entry_max,
      feedbackTags: parseTags(r.feedback_tags_json) ?? DEFAULT_FEEDBACK_TAGS,
      revealTop: r.reveal_top,
      revealBatch: r.reveal_batch,
      revealHideScores: !!r.reveal_hide_scores,
      finalOrder: parseIds(r.final_order_json),
    };
  }

  updateEvent(p: Partial<EventState>) {
    const cur = this.getEvent();
    const n = { ...cur, ...p, timer: { ...cur.timer, ...(p.timer ?? {}) } };
    this.db.prepare(`UPDATE event SET name=?, date=?, current_team_id=?, timer_visible=?, timer_running=?,
      timer_offset_sec=?, timer_anchor_at=?, pitch_sec=?, qa_sec=?, locked=?, show_juror_total=?, include_entry=?, entry_max=?,
      feedback_tags_json=?, reveal_top=?, product=?, final_order_json=?, reveal_hide_scores=?, reveal_batch=? WHERE id = 1`)
      .run(n.name, n.date, n.currentTeamId, +n.timer.visible, +n.timer.running, n.timer.offsetSec,
        n.timer.anchorAt, n.timer.pitchSec, n.timer.qaSec, +n.locked, +n.showJurorTotal, +n.includeEntry, n.entryMax,
        JSON.stringify(n.feedbackTags), n.revealTop, n.product, n.finalOrder ? JSON.stringify(n.finalOrder) : null,
        +n.revealHideScores, n.revealBatch);
    return this.getEvent();
  }

  getReveal(): { enabled: boolean; step: number; snapshot: RevealSnapshot | null } {
    const r = this.db.prepare("SELECT reveal_enabled, reveal_step, reveal_snapshot FROM event WHERE id = 1").get() as
      { reveal_enabled: number; reveal_step: number; reveal_snapshot: string | null };
    return { enabled: !!r.reveal_enabled, step: r.reveal_step, snapshot: r.reveal_snapshot ? normalizeSnapshot(JSON.parse(r.reveal_snapshot)) : null };
  }
  setReveal(p: { enabled?: boolean; step?: number; snapshot?: RevealSnapshot | null }) {
    const cur = this.getReveal();
    const n = { ...cur, ...p };
    this.db.prepare("UPDATE event SET reveal_enabled=?, reveal_step=?, reveal_snapshot=? WHERE id = 1")
      .run(+n.enabled, n.step, n.snapshot ? JSON.stringify(n.snapshot) : null);
    return this.getReveal();
  }

  stage(now = Date.now()): StagePayload {
    const ev = this.getEvent();
    const teams = this.teams().filter(t => t.active);
    const i = teams.findIndex(t => t.id === ev.currentTeamId);
    const t = i >= 0 ? teams[i] : null;
    return {
      eventName: ev.displayName,
      eventDate: ev.date,
      team: t ? { id: t.id, name: t.name, project: t.project, index: i + 1, total: teams.length } : null,
      timer: ev.timer,
      serverNow: now,
    };
  }

  // ---------- teams ----------
  /** Includes entry scores (shown to the admin and to jurors). */
  teams(): AdminTeam[] {
    return (this.db.prepare("SELECT * FROM teams ORDER BY order_index, id").all() as any[]).map(r => ({
      id: r.id, name: r.name, project: r.project, orderIndex: r.order_index, active: !!r.active,
      entryScore: r.entry_score ?? null,
    }));
  }
  team(id: number) { return this.teams().find(t => t.id === id) ?? null; }
  addTeam(name: string, project: string) {
    const max = (this.db.prepare("SELECT COALESCE(MAX(order_index), -1) m FROM teams").get() as any).m;
    const r = this.db.prepare("INSERT INTO teams (order_index, name, project) VALUES (?, ?, ?)").run(max + 1, name, project);
    return this.team(Number(r.lastInsertRowid))!;
  }
  updateTeam(id: number, p: Partial<Pick<AdminTeam, "name" | "project" | "active" | "entryScore">>) {
    const t = this.team(id);
    if (!t) return null;
    const n = { ...t, ...p };
    this.db.prepare("UPDATE teams SET name=?, project=?, active=?, entry_score=? WHERE id=?").run(n.name, n.project, +n.active, n.entryScore, id);
    return this.team(id);
  }
  deleteTeam(id: number) { return this.db.prepare("DELETE FROM teams WHERE id=?").run(id).changes > 0; }
  reorder(table: "teams" | "criteria", ids: number[]) {
    const st = this.db.prepare(`UPDATE ${table} SET order_index=? WHERE id=?`);
    this.db.transaction(() => ids.forEach((id, i) => st.run(i, id)))();
  }

  // ---------- criteria ----------
  criteria(): Criterion[] {
    return (this.db.prepare("SELECT * FROM criteria ORDER BY order_index, id").all() as any[]).map(r => ({
      id: r.id, key: r.key, name: r.name, description: r.description, maxScore: r.max_score, orderIndex: r.order_index,
    }));
  }
  criterion(id: number) { return this.criteria().find(c => c.id === id) ?? null; }
  // The legacy `weight` column (pre-v3 weighted model) is kept equal to max_score.
  addCriterion(c: { key: string; name: string; description: string; maxScore: number }) {
    const max = (this.db.prepare("SELECT COALESCE(MAX(order_index), -1) m FROM criteria").get() as any).m;
    const r = this.db.prepare("INSERT INTO criteria (order_index, key, name, description, weight, max_score) VALUES (?, ?, ?, ?, ?, ?)")
      .run(max + 1, c.key, c.name, c.description, c.maxScore, c.maxScore);
    return this.criterion(Number(r.lastInsertRowid))!;
  }
  updateCriterion(id: number, p: Partial<Pick<Criterion, "name" | "description" | "maxScore">>) {
    const c = this.criterion(id);
    if (!c) return null;
    const n = { ...c, ...p };
    this.db.prepare("UPDATE criteria SET name=?, description=?, weight=?, max_score=? WHERE id=?").run(n.name, n.description, n.maxScore, n.maxScore, id);
    return this.criterion(id);
  }
  deleteCriterion(id: number) { return this.db.prepare("DELETE FROM criteria WHERE id=?").run(id).changes > 0; }

  // ---------- users ----------
  userById(id: number) { return (this.db.prepare("SELECT * FROM users WHERE id=?").get(id) as UserRow | undefined) ?? null; }
  userByUsername(u: string) { return (this.db.prepare("SELECT * FROM users WHERE username=?").get(u) as UserRow | undefined) ?? null; }
  jurors(): Juror[] {
    return (this.db.prepare("SELECT * FROM users WHERE role='juror' ORDER BY id").all() as UserRow[]).map(r => ({
      id: r.id, username: r.username, displayName: r.display_name, active: !!r.active,
    }));
  }
  createUser(role: "admin" | "juror", username: string, displayName: string, hash: string) {
    const r = this.db.prepare("INSERT INTO users (role, username, display_name, password_hash, active, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .run(role, username, displayName, hash, Date.now());
    return this.userById(Number(r.lastInsertRowid))!;
  }
  updateUser(id: number, p: { username?: string; displayName?: string; active?: boolean; passwordHash?: string }) {
    const u = this.userById(id);
    if (!u) return null;
    this.db.prepare("UPDATE users SET username=?, display_name=?, active=?, password_hash=? WHERE id=?").run(
      p.username ?? u.username, p.displayName ?? u.display_name,
      p.active == null ? u.active : +p.active, p.passwordHash ?? u.password_hash, id);
    return this.userById(id);
  }
  deleteUser(id: number) { return this.db.prepare("DELETE FROM users WHERE id=? AND role='juror'").run(id).changes > 0; }

  // ---------- juror QR invites ----------
  /** Issues a new invite for the juror and revokes every earlier unused one. */
  createInvite(userId: number, tokenHash: string, ttlMs: number) {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE juror_invites SET revoked_at=? WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL").run(now, userId);
      this.db.prepare("INSERT INTO juror_invites (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run(userId, tokenHash, now, now + ttlMs);
    })();
    return { expiresAt: now + ttlMs };
  }
  invite(tokenHash: string) {
    return (this.db.prepare("SELECT * FROM juror_invites WHERE token_hash=?").get(tokenHash) as
      { id: number; user_id: number; created_at: number; expires_at: number; used_at: number | null; revoked_at: number | null } | undefined) ?? null;
  }
  /** Marks the invite used if it still is usable; false when someone else got there first. */
  useInvite(id: number) {
    return this.db.prepare("UPDATE juror_invites SET used_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
      .run(Date.now(), id, Date.now()).changes > 0;
  }
  /** Juror ids that have scanned at least one QR (i.e. a person has claimed the account). */
  claimedJurors(): Set<number> {
    return new Set((this.db.prepare("SELECT DISTINCT user_id FROM juror_invites WHERE used_at IS NOT NULL").all() as any[]).map(r => r.user_id));
  }

  // ---------- sessions ----------
  createSession(id: string, userId: number, ua: string, ip: string) {
    const now = Date.now();
    this.db.prepare("INSERT INTO sessions (id, user_id, created_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, userId, now, now, ua.slice(0, 300), ip);
  }
  session(id: string) {
    return (this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as
      { id: string; user_id: number; created_at: number; last_seen_at: number; user_agent: string; ip: string } | undefined) ?? null;
  }
  touchSession(id: string) { this.db.prepare("UPDATE sessions SET last_seen_at=? WHERE id=?").run(Date.now(), id); }
  deleteSession(id: string) { this.db.prepare("DELETE FROM sessions WHERE id=?").run(id); }
  deleteUserSessions(userId: number) { return this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId).changes; }
  purgeSessions(olderThan: number) { this.db.prepare("DELETE FROM sessions WHERE last_seen_at < ?").run(olderThan); }
  sessions() {
    return this.db.prepare(`SELECT s.id, s.user_id userId, u.display_name displayName, u.role, s.created_at createdAt,
      s.last_seen_at lastSeenAt, s.user_agent userAgent, s.ip FROM sessions s JOIN users u ON u.id = s.user_id
      ORDER BY s.last_seen_at DESC`).all() as Array<{ id: string; userId: number; displayName: string; role: string;
        createdAt: number; lastSeenAt: number; userAgent: string; ip: string }>;
  }

  // ---------- scores ----------
  private mapScore = (r: any): ScoreRow => ({
    jurorId: r.juror_id, teamId: r.team_id, values: JSON.parse(r.values_json), note: r.note,
    tags: parseTags(r.tags_json) ?? [],
    createdAt: r.created_at, updatedAt: r.updated_at,
  });
  scores(): ScoreRow[] { return (this.db.prepare("SELECT * FROM scores ORDER BY id").all() as any[]).map(this.mapScore); }
  scoresOf(jurorId: number): ScoreRow[] {
    return (this.db.prepare("SELECT * FROM scores WHERE juror_id=? ORDER BY id").all(jurorId) as any[]).map(this.mapScore);
  }
  scoreCountForTeam(teamId: number) { return (this.db.prepare("SELECT COUNT(*) n FROM scores WHERE team_id=?").get(teamId) as any).n as number; }
  scoreCount() { return (this.db.prepare("SELECT COUNT(*) n FROM scores").get() as any).n as number; }
  upsertScore(jurorId: number, teamId: number, values: Record<string, number>, total: number | null, note: string, tags: string[] = []) {
    const now = Date.now();
    const prev = this.db.prepare("SELECT id FROM scores WHERE juror_id=? AND team_id=?").get(jurorId, teamId);
    this.db.prepare(`INSERT INTO scores (juror_id, team_id, values_json, total, note, tags_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (juror_id, team_id) DO UPDATE SET values_json=excluded.values_json, total=excluded.total,
        note=excluded.note, tags_json=excluded.tags_json, updated_at=excluded.updated_at`)
      .run(jurorId, teamId, JSON.stringify(values), total, note, JSON.stringify(tags), now, now);
    const row = this.db.prepare("SELECT * FROM scores WHERE juror_id=? AND team_id=?").get(jurorId, teamId);
    return { score: this.mapScore(row), created: !prev };
  }
  wipeScores() { return this.db.prepare("DELETE FROM scores").run().changes; }

  // ---------- scoring history (never wiped) ----------
  /** Snapshot of one saved score; called right after upsertScore. */
  recordScore(kind: "submit" | "update", jurorId: number, teamId: number, values: Record<string, number>, total: number | null, note: string, tags: string[]) {
    const juror = this.userById(jurorId)?.display_name ?? `Münsif #${jurorId}`;
    const team = this.team(teamId)?.name ?? `Komanda #${teamId}`;
    const snap = this.criteria().filter(c => values[c.key] != null).map(c => ({ key: c.key, name: c.name, max: c.maxScore, v: values[c.key] }));
    this.db.prepare(`INSERT INTO score_history (kind, juror_id, juror_name, team_id, team_name, values_json, total, note, tags_json, actor_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(kind, jurorId, juror, teamId, team, JSON.stringify(snap), total, note, JSON.stringify(tags), juror, Date.now());
  }
  /** Marker for scores removed in bulk (wipe) or with a team / juror. */
  recordRemoval(kind: "wipe" | "team.delete" | "juror.delete", actorId: number | null, count: number, who?: { jurorId?: number; jurorName?: string; teamId?: number; teamName?: string }) {
    const actor = actorId != null ? this.userById(actorId)?.display_name ?? "" : "";
    this.db.prepare(`INSERT INTO score_history (kind, juror_id, juror_name, team_id, team_name, actor_name, count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(kind, who?.jurorId ?? null, who?.jurorName ?? "", who?.teamId ?? null, who?.teamName ?? "", actor, count, Date.now());
  }
  /** Newest first. Filters by juror / team; markers (wipes) show only when no filter is set. */
  history(q: { jurorId?: number; teamId?: number; before?: number; limit?: number } = {}): HistoryPage {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const where: string[] = [], args: unknown[] = [];
    if (q.jurorId) { where.push("juror_id = ?"); args.push(q.jurorId); }
    if (q.teamId) { where.push("team_id = ?"); args.push(q.teamId); }
    const filt = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const page = q.before ? `${filt ? `${filt} AND` : "WHERE"} id < ?` : filt;
    // prev_* come from the same juror's previous save for the same team (wipe markers sit outside that chain).
    const rows = this.db.prepare(`WITH h AS (
        SELECT *, CASE WHEN kind IN ('submit','update') THEN LAG(values_json) OVER w END prev_values,
          CASE WHEN kind IN ('submit','update') THEN LAG(total) OVER w END prev_total,
          CASE WHEN kind IN ('submit','update') THEN LAG(note) OVER w END prev_note
        FROM score_history WINDOW w AS (PARTITION BY kind IN ('submit','update'), juror_id, team_id ORDER BY id))
      SELECT * FROM h ${page} ORDER BY id DESC LIMIT ?`).all(...args, ...(q.before ? [q.before] : []), limit + 1) as any[];
    const more = rows.length > limit;
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM score_history ${filt}`).get(...args) as any).n as number;
    const jurors = this.db.prepare(`SELECT juror_id id, juror_name name FROM score_history WHERE juror_id IS NOT NULL AND kind IN ('submit','update')
      AND id IN (SELECT MAX(id) FROM score_history WHERE juror_id IS NOT NULL AND kind IN ('submit','update') GROUP BY juror_id) ORDER BY name COLLATE NOCASE`).all() as HistoryPage["jurors"];
    const teams = this.db.prepare(`SELECT team_id id, team_name name FROM score_history WHERE team_id IS NOT NULL AND kind IN ('submit','update')
      AND id IN (SELECT MAX(id) FROM score_history WHERE team_id IS NOT NULL AND kind IN ('submit','update') GROUP BY team_id) ORDER BY name COLLATE NOCASE`).all() as HistoryPage["teams"];
    return { rows: rows.slice(0, limit).map(mapHistory), more, total, jurors, teams };
  }

  // ---------- audit ----------
  audit(actorId: number | null, action: string, payload: unknown = {}) {
    this.db.prepare("INSERT INTO audit_log (actor_id, action, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run(actorId, action, JSON.stringify(payload), Date.now());
  }
  auditLog(limit = 500) {
    return (this.db.prepare(`SELECT a.id, a.actor_id actorId, u.display_name actorName, a.action, a.payload_json payload,
      a.created_at createdAt FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ?`)
      .all(limit) as any[]).map(r => ({ ...r, payload: JSON.parse(r.payload) }));
  }
}

function parseJson<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

function mapHistory(r: any): HistoryRow {
  // Diffs only for changes; a first submit after a wipe is a fresh score, not a change.
  const prev = r.kind === "update" && r.prev_values != null
    ? new Map(parseJson<Array<{ key: string; v: number }>>(r.prev_values, []).map(x => [x.key, x.v])) : null;
  const values = parseJson<HistoryRow["values"]>(r.values_json, []).map(x => {
    const p = prev?.get(x.key);
    return p != null && p !== x.v ? { ...x, prev: p } : x;
  });
  return {
    id: r.id, kind: r.kind, at: r.created_at,
    jurorId: r.juror_id, jurorName: r.juror_name, teamId: r.team_id, teamName: r.team_name,
    values, total: r.total, prevTotal: prev ? r.prev_total : null,
    note: r.note, prevNote: prev && r.prev_note !== r.note ? r.prev_note : null,
    tags: parseTags(r.tags_json) ?? [], actorName: r.actor_name, count: r.count,
  };
}

function parseTags(json: string | null | undefined): string[] | null {
  if (json == null) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch { return null; }
}

function parseIds(json: string | null | undefined): number[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.length ? v.filter((x): x is number => Number.isInteger(x)) : null;
  } catch { return null; }
}
