// Data access. Every function returns plain shared/types objects; no route touches SQL directly.
import type { DB } from "./db.js";
import { asProduct, brandName, DEFAULT_FEEDBACK_TAGS, type Product } from "../shared/brand.js";
import { normalizeSnapshot, type RevealSnapshot } from "../shared/reveal.js";
import { STAGE_MODES, type StageScene, type AdminTeam, type Criterion, type HistoryPage, type HistoryRow, type Juror, type ScoreRow, type StageMode, type StagePayload, type TimerState } from "../shared/types.js";
import { stageShow } from "./teamrepo.js";

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
  team_registration: number;
  team_can_rename: number;
  upload_deadline: number | null;
  jurors_see_materials: number;
  stage_mode: string;
  stage_slide: number;
  stage_intro_at: number | null;
  stage_scene: string;
  stage_event_file: number | null;
  event_slide: number;
  event_bubble: number;
  team_slide_control: number;
  last5_fx: number;
  stage_sound: number;
  reveal_enabled?: number;
  reveal_step?: number;
  reveal_snapshot?: string | null;
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
  /** munsif: teams may register themselves (they wait for the coordinator's approval). */
  teamRegistration: boolean;
  /** munsif: teams may change their team and project name. */
  teamCanRename: boolean;
  /** munsif: uploads close at this time (ms), null = no deadline. */
  uploadDeadline: number | null;
  /** munsif: jurors see links to each team's presentation and website. */
  jurorsSeeMaterials: boolean;
  /** munsif: presentation stage. */
  stageMode: StageMode;
  stageSlide: number;
  stageIntroAt: number | null;
  /** v3: what the projector shows — the team on stage, or the event's own presentation. */
  stageScene: StageScene;
  /** v3: which event presentation is on stage in the "event" scene. */
  stageEventFile: number | null;
  /** v3: slide of the event presentation (the team's deck keeps its own stageSlide). */
  eventSlide: number;
  /** v3: show the timer bubble over the event presentation. */
  eventBubble: boolean;
  /** v3: the team on stage may turn its own slides from /team. */
  teamSlideControl: boolean;
  /** v3: the last-5-seconds effect on the projector. */
  last5Fx: boolean;
  /** v3: projector sounds. */
  stageSound: boolean;
}

/** v3 (events): one event of an organisation. */
export interface EventMeta { id: number; orgId: number; name: string; status: "active" | "archived"; createdAt: number; archivedAt: number | null }
export interface EventsRow { id: number; org_id: number; name: string; status: string; created_at: number; archived_at: number | null; settings_json: string | null; stats_json: string | null }
export const eventMeta = (r: EventsRow): EventMeta => ({ id: r.id, orgId: r.org_id, name: r.name, status: r.status === "archived" ? "archived" : "active", createdAt: r.created_at, archivedAt: r.archived_at });

export interface UserRow {
  id: number;
  role: "admin" | "juror";
  username: string;
  display_name: string;
  password_hash: string;
  active: number;
  created_at: number;
  /** orgs: the organisation the account belongs to (jurors, coordinators; root's home is org 1). */
  org_id: number;
  /** orgs: platform owner (the env admin). */
  is_root: number;
  /** v3 events: the event a juror belongs to (meaningless for coordinators). */
  event_id: number;
}

/**
 * Data access for ONE event of ONE organisation (orgs, v3 events). Every query is filtered by (or inserts) this.orgId; ids handed in from
 * requests are only ever resolved inside the organisation, so another organisation's rows read as "not found".
 * Session lookups and userById/userByUsername are global on purpose: they are keyed by secrets / used by sign-in.
 */
export class Repo {
  /** v3 events: the event this repo reads and writes; resolved from the organisation's active event when not given. */
  readonly eventId: number;
  /** v3 events: an archived event is read-only; its settings come from the copy taken when it was archived. */
  readonly archived: EventRow | null;
  constructor(readonly db: DB, readonly orgId = 1, readonly orgSlug = "root", eventId?: number) {
    let ev = eventId != null ? (db.prepare("SELECT * FROM events WHERE id = ? AND org_id = ?").get(eventId, orgId) as EventsRow | undefined) : undefined;
    if (!ev) ev = db.prepare("SELECT * FROM events WHERE org_id = ? AND status = 'active'").get(orgId) as EventsRow | undefined;
    this.eventId = ev?.id ?? 0;
    this.archived = ev && ev.status === "archived" && ev.settings_json ? (JSON.parse(ev.settings_json) as EventRow) : null;
  }
  private readOnly() { if (this.archived) throw new Error("archived event is read-only"); }
  /** v3 events: this event's row in `events`. */
  meta(): EventMeta | null {
    const r = this.db.prepare("SELECT * FROM events WHERE id = ?").get(this.eventId) as EventsRow | undefined;
    return r ? eventMeta(r) : null;
  }

  // ---------- event ----------
  private eventRow(): EventRow {
    return this.archived ?? (this.db.prepare("SELECT * FROM event WHERE org_id = ?").get(this.orgId) as EventRow);
  }
  getEvent(): EventState {
    const r = this.eventRow();
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
      teamRegistration: !!r.team_registration,
      teamCanRename: !!r.team_can_rename,
      uploadDeadline: r.upload_deadline ?? null,
      jurorsSeeMaterials: !!r.jurors_see_materials,
      stageMode: (STAGE_MODES as readonly string[]).includes(r.stage_mode) ? (r.stage_mode as StageMode) : "auto",
      stageSlide: Math.max(1, r.stage_slide || 1),
      stageIntroAt: r.stage_intro_at ?? null,
      stageScene: r.stage_scene === "event" ? "event" : "team",
      stageEventFile: r.stage_event_file ?? null,
      eventSlide: Math.max(1, r.event_slide || 1),
      eventBubble: !!r.event_bubble,
      teamSlideControl: r.team_slide_control == null ? true : !!r.team_slide_control,
      last5Fx: r.last5_fx == null ? true : !!r.last5_fx,
      stageSound: r.stage_sound == null ? true : !!r.stage_sound,
    };
  }

  updateEvent(p: Partial<EventState>) {
    this.readOnly();
    const cur = this.getEvent();
    const n = { ...cur, ...p, timer: { ...cur.timer, ...(p.timer ?? {}) } };
    this.db.prepare(`UPDATE event SET name=?, date=?, current_team_id=?, timer_visible=?, timer_running=?,
      timer_offset_sec=?, timer_anchor_at=?, pitch_sec=?, qa_sec=?, locked=?, show_juror_total=?, include_entry=?, entry_max=?,
      feedback_tags_json=?, reveal_top=?, product=?, final_order_json=?, reveal_hide_scores=?, reveal_batch=?,
      team_registration=?, team_can_rename=?, upload_deadline=?, jurors_see_materials=?, stage_mode=?, stage_slide=?, stage_intro_at=?,
      stage_scene=?, stage_event_file=?, event_slide=?, event_bubble=?, team_slide_control=?, last5_fx=?, stage_sound=? WHERE org_id = ?`)
      .run(n.name, n.date, n.currentTeamId, +n.timer.visible, +n.timer.running, n.timer.offsetSec,
        n.timer.anchorAt, n.timer.pitchSec, n.timer.qaSec, +n.locked, +n.showJurorTotal, +n.includeEntry, n.entryMax,
        JSON.stringify(n.feedbackTags), n.revealTop, n.product, n.finalOrder ? JSON.stringify(n.finalOrder) : null,
        +n.revealHideScores, n.revealBatch,
        +n.teamRegistration, +n.teamCanRename, n.uploadDeadline, +n.jurorsSeeMaterials, n.stageMode, n.stageSlide, n.stageIntroAt,
        n.stageScene, n.stageEventFile, n.eventSlide, +n.eventBubble, +n.teamSlideControl, +n.last5Fx, +n.stageSound, this.orgId);
    return this.getEvent();
  }

  getReveal(): { enabled: boolean; step: number; snapshot: RevealSnapshot | null } {
    const r = (this.archived ?? this.db.prepare("SELECT reveal_enabled, reveal_step, reveal_snapshot FROM event WHERE org_id = ?").get(this.orgId)) as
      { reveal_enabled: number; reveal_step: number; reveal_snapshot: string | null };
    return { enabled: !!r.reveal_enabled, step: r.reveal_step ?? 0, snapshot: r.reveal_snapshot ? normalizeSnapshot(JSON.parse(r.reveal_snapshot)) : null };
  }
  setReveal(p: { enabled?: boolean; step?: number; snapshot?: RevealSnapshot | null }) {
    this.readOnly();
    const cur = this.getReveal();
    const n = { ...cur, ...p };
    this.db.prepare("UPDATE event SET reveal_enabled=?, reveal_step=?, reveal_snapshot=? WHERE org_id = ?")
      .run(+n.enabled, n.step, n.snapshot ? JSON.stringify(n.snapshot) : null, this.orgId);
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
      show: stageShow(this.db, ev, t ? t.id : null, (i >= 0 ? teams[i + 1] : teams[0]) ?? null, this.orgSlug, this.eventId),
    };
  }

  // ---------- teams ----------
  /** Includes entry scores (shown to the admin and to jurors). */
  teams(): AdminTeam[] {
    return (this.db.prepare("SELECT * FROM teams WHERE org_id = ? AND event_id = ? ORDER BY order_index, id").all(this.orgId, this.eventId) as any[]).map(r => ({
      id: r.id, name: r.name, project: r.project, orderIndex: r.order_index, active: !!r.active,
      entryScore: r.entry_score ?? null, approval: r.approval === "pending" ? "pending" : "approved",
    }));
  }
  team(id: number) { return this.teams().find(t => t.id === id) ?? null; }
  addTeam(name: string, project: string) {
    this.readOnly();
    const max = (this.db.prepare("SELECT COALESCE(MAX(order_index), -1) m FROM teams WHERE org_id = ? AND event_id = ?").get(this.orgId, this.eventId) as any).m;
    const r = this.db.prepare("INSERT INTO teams (order_index, name, project, org_id, event_id) VALUES (?, ?, ?, ?, ?)").run(max + 1, name, project, this.orgId, this.eventId);
    return this.team(Number(r.lastInsertRowid))!;
  }
  updateTeam(id: number, p: Partial<Pick<AdminTeam, "name" | "project" | "active" | "entryScore">>) {
    this.readOnly();
    const t = this.team(id);
    if (!t) return null;
    const n = { ...t, ...p };
    this.db.prepare("UPDATE teams SET name=?, project=?, active=?, entry_score=? WHERE id=? AND org_id=?").run(n.name, n.project, +n.active, n.entryScore, id, this.orgId);
    // Switching a self-registered team on is the coordinator's approval.
    if (p.active === true) this.db.prepare("UPDATE teams SET approval='approved' WHERE id=? AND org_id=?").run(id, this.orgId);
    return this.team(id);
  }
  deleteTeam(id: number) { this.readOnly(); return this.db.prepare("DELETE FROM teams WHERE id=? AND org_id=? AND event_id=?").run(id, this.orgId, this.eventId).changes > 0; }
  reorder(table: "teams" | "criteria", ids: number[]) {
    this.readOnly();
    const st = this.db.prepare(`UPDATE ${table} SET order_index=? WHERE id=? AND org_id=? AND event_id=?`);
    this.db.transaction(() => ids.forEach((id, i) => st.run(i, id, this.orgId, this.eventId)))();
  }

  // ---------- criteria ----------
  criteria(): Criterion[] {
    return (this.db.prepare("SELECT * FROM criteria WHERE org_id = ? AND event_id = ? ORDER BY order_index, id").all(this.orgId, this.eventId) as any[]).map(r => ({
      id: r.id, key: r.key, name: r.name, description: r.description, maxScore: r.max_score, orderIndex: r.order_index,
    }));
  }
  criterion(id: number) { return this.criteria().find(c => c.id === id) ?? null; }
  // The legacy `weight` column (pre-v3 weighted model) is kept equal to max_score.
  addCriterion(c: { key: string; name: string; description: string; maxScore: number }) {
    this.readOnly();
    const max = (this.db.prepare("SELECT COALESCE(MAX(order_index), -1) m FROM criteria WHERE org_id = ? AND event_id = ?").get(this.orgId, this.eventId) as any).m;
    // Keys are unique per organisation (UNIQUE (org_id, key)); a later event gets the same rubric under suffixed keys.
    let key = c.key;
    for (let i = 2; this.db.prepare("SELECT 1 FROM criteria WHERE org_id = ? AND key = ?").get(this.orgId, key); i++) key = `${c.key}_${i}`;
    const r = this.db.prepare("INSERT INTO criteria (order_index, key, name, description, weight, max_score, org_id, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(max + 1, key, c.name, c.description, c.maxScore, c.maxScore, this.orgId, this.eventId);
    return this.criterion(Number(r.lastInsertRowid))!;
  }
  updateCriterion(id: number, p: Partial<Pick<Criterion, "name" | "description" | "maxScore">>) {
    this.readOnly();
    const c = this.criterion(id);
    if (!c) return null;
    const n = { ...c, ...p };
    this.db.prepare("UPDATE criteria SET name=?, description=?, weight=?, max_score=? WHERE id=? AND org_id=?").run(n.name, n.description, n.maxScore, n.maxScore, id, this.orgId);
    return this.criterion(id);
  }
  deleteCriterion(id: number) { this.readOnly(); return this.db.prepare("DELETE FROM criteria WHERE id=? AND org_id=? AND event_id=?").run(id, this.orgId, this.eventId).changes > 0; }

  // ---------- users ----------
  /** Global (sign-in, sessions). Routes acting on a user given by id use member(). */
  userById(id: number) { return (this.db.prepare("SELECT * FROM users WHERE id=?").get(id) as UserRow | undefined) ?? null; }
  /** The user, only if it belongs to this organisation (a juror: to this event). */
  member(id: number) { return (this.db.prepare("SELECT * FROM users WHERE id=? AND org_id=? AND (role='admin' OR event_id=?)").get(id, this.orgId, this.eventId) as UserRow | undefined) ?? null; }
  userByUsername(u: string) { return (this.db.prepare("SELECT * FROM users WHERE username=?").get(u) as UserRow | undefined) ?? null; }
  jurors(): Juror[] {
    return (this.db.prepare("SELECT * FROM users WHERE role='juror' AND org_id=? AND event_id=? ORDER BY id").all(this.orgId, this.eventId) as UserRow[]).map(r => ({
      id: r.id, username: r.username, displayName: r.display_name, active: !!r.active,
    }));
  }
  createUser(role: "admin" | "juror", username: string, displayName: string, hash: string, opts: { isRoot?: boolean } = {}) {
    const r = this.db.prepare("INSERT INTO users (role, username, display_name, password_hash, active, created_at, org_id, is_root, event_id) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)")
      .run(role, username, displayName, hash, Date.now(), this.orgId, opts.isRoot ? 1 : 0, this.eventId);
    return this.userById(Number(r.lastInsertRowid))!;
  }
  updateUser(id: number, p: { username?: string; displayName?: string; active?: boolean; passwordHash?: string }) {
    const u = this.member(id);
    if (!u) return null;
    this.db.prepare("UPDATE users SET username=?, display_name=?, active=?, password_hash=? WHERE id=? AND org_id=?").run(
      p.username ?? u.username, p.displayName ?? u.display_name,
      p.active == null ? u.active : +p.active, p.passwordHash ?? u.password_hash, id, this.orgId);
    return this.member(id);
  }
  deleteUser(id: number) { this.readOnly(); return this.db.prepare("DELETE FROM users WHERE id=? AND role='juror' AND org_id=? AND event_id=?").run(id, this.orgId, this.eventId).changes > 0; }

  // ---------- juror QR invites ----------
  /** Issues a new invite for the juror and revokes every earlier unused one. */
  createInvite(userId: number, tokenHash: string, ttlMs: number) {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare("UPDATE juror_invites SET revoked_at=? WHERE user_id=? AND used_at IS NULL AND revoked_at IS NULL").run(now, userId);
      this.db.prepare("INSERT INTO juror_invites (user_id, token_hash, created_at, expires_at, org_id, event_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(userId, tokenHash, now, now + ttlMs, this.orgId, this.eventId);
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
    return new Set((this.db.prepare("SELECT DISTINCT user_id FROM juror_invites WHERE used_at IS NOT NULL AND org_id=? AND event_id=?").all(this.orgId, this.eventId) as any[]).map(r => r.user_id));
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
  deleteUserSessions(userId: number) { return this.db.prepare("DELETE FROM sessions WHERE user_id=? AND user_id IN (SELECT id FROM users WHERE org_id=?)").run(userId, this.orgId).changes; }
  purgeSessions(olderThan: number) { this.db.prepare("DELETE FROM sessions WHERE last_seen_at < ?").run(olderThan); }
  sessions() {
    return this.db.prepare(`SELECT s.id, s.user_id userId, u.display_name displayName, u.role, s.created_at createdAt,
      s.last_seen_at lastSeenAt, s.user_agent userAgent, s.ip FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE u.org_id = ? AND (u.role = 'admin' OR u.event_id = ?) ORDER BY s.last_seen_at DESC`).all(this.orgId, this.eventId) as Array<{ id: string; userId: number; displayName: string; role: string;
        createdAt: number; lastSeenAt: number; userAgent: string; ip: string }>;
  }

  // ---------- scores ----------
  private mapScore = (r: any): ScoreRow => ({
    jurorId: r.juror_id, teamId: r.team_id, values: JSON.parse(r.values_json), note: r.note,
    tags: parseTags(r.tags_json) ?? [],
    createdAt: r.created_at, updatedAt: r.updated_at,
  });
  scores(): ScoreRow[] { return (this.db.prepare("SELECT * FROM scores WHERE org_id=? AND event_id=? ORDER BY id").all(this.orgId, this.eventId) as any[]).map(this.mapScore); }
  scoresOf(jurorId: number): ScoreRow[] {
    return (this.db.prepare("SELECT * FROM scores WHERE juror_id=? AND org_id=? AND event_id=? ORDER BY id").all(jurorId, this.orgId, this.eventId) as any[]).map(this.mapScore);
  }
  scoreCountForTeam(teamId: number) { return (this.db.prepare("SELECT COUNT(*) n FROM scores WHERE team_id=? AND org_id=? AND event_id=?").get(teamId, this.orgId, this.eventId) as any).n as number; }
  scoreCount() { return (this.db.prepare("SELECT COUNT(*) n FROM scores WHERE org_id=? AND event_id=?").get(this.orgId, this.eventId) as any).n as number; }
  upsertScore(jurorId: number, teamId: number, values: Record<string, number>, total: number | null, note: string, tags: string[] = []) {
    this.readOnly();
    const now = Date.now();
    const prev = this.db.prepare("SELECT id FROM scores WHERE juror_id=? AND team_id=?").get(jurorId, teamId);
    this.db.prepare(`INSERT INTO scores (juror_id, team_id, values_json, total, note, tags_json, created_at, updated_at, org_id, event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (juror_id, team_id) DO UPDATE SET values_json=excluded.values_json, total=excluded.total,
        note=excluded.note, tags_json=excluded.tags_json, updated_at=excluded.updated_at`)
      .run(jurorId, teamId, JSON.stringify(values), total, note, JSON.stringify(tags), now, now, this.orgId, this.eventId);
    const row = this.db.prepare("SELECT * FROM scores WHERE juror_id=? AND team_id=?").get(jurorId, teamId);
    return { score: this.mapScore(row), created: !prev };
  }
  wipeScores() { this.readOnly(); return this.db.prepare("DELETE FROM scores WHERE org_id=? AND event_id=?").run(this.orgId, this.eventId).changes; }

  // ---------- scoring history (never wiped) ----------
  /** Snapshot of one saved score; called right after upsertScore. */
  recordScore(kind: "submit" | "update", jurorId: number, teamId: number, values: Record<string, number>, total: number | null, note: string, tags: string[]) {
    const juror = this.userById(jurorId)?.display_name ?? `Münsif #${jurorId}`;
    const team = this.team(teamId)?.name ?? `Komanda #${teamId}`;
    const snap = this.criteria().filter(c => values[c.key] != null).map(c => ({ key: c.key, name: c.name, max: c.maxScore, v: values[c.key] }));
    this.db.prepare(`INSERT INTO score_history (kind, juror_id, juror_name, team_id, team_name, values_json, total, note, tags_json, actor_name, created_at, org_id, event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(kind, jurorId, juror, teamId, team, JSON.stringify(snap), total, note, JSON.stringify(tags), juror, Date.now(), this.orgId, this.eventId);
  }
  /** Marker for scores removed in bulk (wipe) or with a team / juror. */
  recordRemoval(kind: "wipe" | "team.delete" | "juror.delete", actorId: number | null, count: number, who?: { jurorId?: number; jurorName?: string; teamId?: number; teamName?: string }) {
    const actor = actorId != null ? this.userById(actorId)?.display_name ?? "" : "";
    this.db.prepare(`INSERT INTO score_history (kind, juror_id, juror_name, team_id, team_name, actor_name, count, created_at, org_id, event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(kind, who?.jurorId ?? null, who?.jurorName ?? "", who?.teamId ?? null, who?.teamName ?? "", actor, count, Date.now(), this.orgId, this.eventId);
  }
  /** Newest first. Filters by juror / team; markers (wipes) show only when no filter is set. */
  history(q: { jurorId?: number; teamId?: number; before?: number; limit?: number } = {}): HistoryPage {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const where: string[] = ["org_id = ?", "event_id = ?"], args: unknown[] = [this.orgId, this.eventId];
    if (q.jurorId) { where.push("juror_id = ?"); args.push(q.jurorId); }
    if (q.teamId) { where.push("team_id = ?"); args.push(q.teamId); }
    const filt = `WHERE ${where.join(" AND ")}`;
    const page = q.before ? `${filt} AND id < ?` : filt;
    // prev_* come from the same juror's previous save for the same team (wipe markers sit outside that chain).
    const rows = this.db.prepare(`WITH h AS (
        SELECT *, CASE WHEN kind IN ('submit','update') THEN LAG(values_json) OVER w END prev_values,
          CASE WHEN kind IN ('submit','update') THEN LAG(total) OVER w END prev_total,
          CASE WHEN kind IN ('submit','update') THEN LAG(note) OVER w END prev_note
        FROM score_history WHERE org_id = ? AND event_id = ? WINDOW w AS (PARTITION BY kind IN ('submit','update'), juror_id, team_id ORDER BY id))
      SELECT * FROM h ${page} ORDER BY id DESC LIMIT ?`).all(this.orgId, this.eventId, ...args, ...(q.before ? [q.before] : []), limit + 1) as any[];
    const more = rows.length > limit;
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM score_history ${filt}`).get(...args) as any).n as number;
    const E = [this.orgId, this.eventId];
    const jurors = this.db.prepare(`SELECT juror_id id, juror_name name FROM score_history WHERE org_id = ? AND event_id = ? AND juror_id IS NOT NULL AND kind IN ('submit','update')
      AND id IN (SELECT MAX(id) FROM score_history WHERE org_id = ? AND event_id = ? AND juror_id IS NOT NULL AND kind IN ('submit','update') GROUP BY juror_id) ORDER BY name COLLATE NOCASE`).all(...E, ...E) as HistoryPage["jurors"];
    const teams = this.db.prepare(`SELECT team_id id, team_name name FROM score_history WHERE org_id = ? AND event_id = ? AND team_id IS NOT NULL AND kind IN ('submit','update')
      AND id IN (SELECT MAX(id) FROM score_history WHERE org_id = ? AND event_id = ? AND team_id IS NOT NULL AND kind IN ('submit','update') GROUP BY team_id) ORDER BY name COLLATE NOCASE`).all(...E, ...E) as HistoryPage["teams"];
    return { rows: rows.slice(0, limit).map(mapHistory), more, total, jurors, teams };
  }

  // ---------- audit ----------
  audit(actorId: number | null, action: string, payload: unknown = {}) {
    this.db.prepare("INSERT INTO audit_log (actor_id, action, payload_json, created_at, org_id) VALUES (?, ?, ?, ?, ?)")
      .run(actorId, action, JSON.stringify(payload), Date.now(), this.orgId);
  }
  auditLog(limit = 500) {
    return (this.db.prepare(`SELECT a.id, a.actor_id actorId, u.display_name actorName, a.action, a.payload_json payload,
      a.created_at createdAt FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.org_id = ? ORDER BY a.id DESC LIMIT ?`)
      .all(this.orgId, limit) as any[]).map(r => ({ ...r, payload: JSON.parse(r.payload) }));
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
