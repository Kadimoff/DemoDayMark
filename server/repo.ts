// Data access. Every function returns plain shared/types objects; no route touches SQL directly.
import type { DB } from "./db.js";
import { normalizeSnapshot, type RevealSnapshot } from "../shared/reveal.js";
import type { AdminTeam, Criterion, Juror, ScoreRow, StagePayload, TimerState } from "../shared/types.js";

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
}

export interface EventState {
  name: string;
  date: string;
  currentTeamId: number | null;
  timer: TimerState;
  locked: boolean;
  showJurorTotal: boolean;
  /** Final score = entry score + Demo Day score when true; Demo Day score alone when false. */
  includeEntry: boolean;
  /** Scale of entry scores (e.g. 50). */
  entryMax: number;
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
    return {
      name: r.name,
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
    };
  }

  updateEvent(p: Partial<EventState>) {
    const cur = this.getEvent();
    const n = { ...cur, ...p, timer: { ...cur.timer, ...(p.timer ?? {}) } };
    this.db.prepare(`UPDATE event SET name=?, date=?, current_team_id=?, timer_visible=?, timer_running=?,
      timer_offset_sec=?, timer_anchor_at=?, pitch_sec=?, qa_sec=?, locked=?, show_juror_total=?, include_entry=?, entry_max=?
      WHERE id = 1`)
      .run(n.name, n.date, n.currentTeamId, +n.timer.visible, +n.timer.running, n.timer.offsetSec,
        n.timer.anchorAt, n.timer.pitchSec, n.timer.qaSec, +n.locked, +n.showJurorTotal, +n.includeEntry, n.entryMax);
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
      eventName: ev.name,
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
    createdAt: r.created_at, updatedAt: r.updated_at,
  });
  scores(): ScoreRow[] { return (this.db.prepare("SELECT * FROM scores ORDER BY id").all() as any[]).map(this.mapScore); }
  scoresOf(jurorId: number): ScoreRow[] {
    return (this.db.prepare("SELECT * FROM scores WHERE juror_id=? ORDER BY id").all(jurorId) as any[]).map(this.mapScore);
  }
  scoreCountForTeam(teamId: number) { return (this.db.prepare("SELECT COUNT(*) n FROM scores WHERE team_id=?").get(teamId) as any).n as number; }
  scoreCount() { return (this.db.prepare("SELECT COUNT(*) n FROM scores").get() as any).n as number; }
  upsertScore(jurorId: number, teamId: number, values: Record<string, number>, total: number | null, note: string) {
    const now = Date.now();
    const prev = this.db.prepare("SELECT id FROM scores WHERE juror_id=? AND team_id=?").get(jurorId, teamId);
    this.db.prepare(`INSERT INTO scores (juror_id, team_id, values_json, total, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (juror_id, team_id) DO UPDATE SET values_json=excluded.values_json, total=excluded.total,
        note=excluded.note, updated_at=excluded.updated_at`)
      .run(jurorId, teamId, JSON.stringify(values), total, note, now, now);
    const row = this.db.prepare("SELECT * FROM scores WHERE juror_id=? AND team_id=?").get(jurorId, teamId);
    return { score: this.mapScore(row), created: !prev };
  }
  wipeScores() { return this.db.prepare("DELETE FROM scores").run().changes; }

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
