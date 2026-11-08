// v3 events: an organisation runs several events. Exactly one is active; the others are archived — read-only, with their
// results, history and exports still available. "Yeni tədbir yarat" archives the active event and starts a new one.
// Nothing is copied out or deleted: every row keeps its event_id, so the archived event reads exactly as it was.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { Orgs, Scope } from "./orgs.js";
import { eventMeta, type EventMeta, type EventsRow } from "./repo.js";
import { adminResults } from "./views.js";
import { DEFAULT_CRITERIA, todayDate } from "./baseline.js";
import { applyTimerAction } from "../shared/timer.js";
import { activeFile, materials, teamRow } from "./teamrepo.js";
import { asProduct, brandName } from "../shared/brand.js";

export interface NewEventInput {
  name: string;
  product?: string;
  date?: string;
  pitchSec?: number;
  qaSec?: number;
  uploadDeadline?: number | null;
  /** Copy the rubric of the current event (default) — otherwise the default rubric. */
  copyCriteria?: boolean;
  /** Copy team names / projects (no files, links or scores). */
  copyTeams?: boolean;
  /** v4: which program the rubric / teams / jurors come from (default: the active one). Same organisation only. */
  copyFrom?: number | null;
  /** v4: new juror accounts with the same names (each gets a new QR; no scores). */
  copyJurors?: boolean;
}

export interface EventListItem extends EventMeta {
  teams: number; jurors: number; scores: number;
  /** Winner(s) when archived (from the ranking at that moment). */
  top: Array<{ rank: number | null; name: string; score: number | null }>;
  /** v4: the program's own date text and type. */
  date: string; product: string;
  /** v4: imported from a backup file (root panel "Yedəkdən import"). */
  imported: { file: string; at: number } | null;
}

export function listEvents(orgs: Orgs, orgId: number, cfg: Config): EventListItem[] {
  const rows = orgs.db.prepare("SELECT * FROM events WHERE org_id = ? ORDER BY id DESC").all(orgId) as EventsRow[];
  const imports = new Map((orgs.db.prepare("SELECT event_id, source_file, created_at FROM archive_imports WHERE org_id = ?").all(orgId) as Array<{ event_id: number; source_file: string; created_at: number }>)
    .map(r => [r.event_id, { file: r.source_file, at: r.created_at }]));
  const items = rows.map(r => {
    const n = (sql: string) => (orgs.db.prepare(sql).get(orgId, r.id) as { n: number }).n;
    let top: EventListItem["top"] = [];
    try { top = r.stats_json ? (JSON.parse(r.stats_json).top ?? []) : []; } catch { /* old row */ }
    if (r.status === "active") {
      const repo = orgs.scope(orgId).repo;
      top = adminResults(repo, cfg).results.ranking.filter(x => x.score != null).slice(0, 3).map(x => ({ rank: x.rank, name: x.team.name, score: x.score }));
    }
    return {
      ...eventMeta(r),
      teams: n("SELECT COUNT(*) n FROM teams WHERE org_id = ? AND event_id = ? AND active = 1"),
      jurors: n("SELECT COUNT(*) n FROM users WHERE org_id = ? AND event_id = ? AND role = 'juror'"),
      scores: n("SELECT COUNT(*) n FROM scores WHERE org_id = ? AND event_id = ?"),
      top,
      // the active program always shows its current name (rows created before v13 may hold an older one)
      ...(() => { const e = orgs.eventRepo(orgId, r.id)?.getEvent(); return { date: e?.date ?? "", product: e?.product ?? "", ...(r.status === "active" && e ? { name: e.displayName } : {}) }; })(),
      imported: imports.get(r.id) ?? null,
    };
  });
  // active first, then the history by when the program ran (an imported old program sorts by its own dates)
  const when = (e: EventListItem) => e.archivedAt ?? e.createdAt;
  return items.sort((a, b) => (a.status === "active" ? -1 : b.status === "active" ? 1 : when(b) - when(a) || b.id - a.id));
}

/**
 * v4 "Proqramlar → Tarixçə": everything about one program of the organisation, read-only — ranking, teams with their
 * materials (a file that is no longer in uploads says so), jurors, every juror's scores and the import origin.
 */
export function eventDetail(orgs: Orgs, orgId: number, eventId: number, cfg: Config) {
  const repo = orgs.eventRepo(orgId, eventId);
  if (!repo) return null;
  const db = orgs.db;
  const ev = repo.getEvent();
  const ar = adminResults(repo, cfg);
  const exists = (stored: string | null | undefined) => !!stored && fs.existsSync(path.join(cfg.uploadsDir, path.basename(stored)));
  const teams = ar.teams.map(t => {
    const row = teamRow(db, t.id)!;
    const m = materials(db, row);
    const pres = activeFile(db, t.id, "presentation");
    const logo = activeFile(db, t.id, "logo");
    return {
      ...t, members: m.members, siteUrl: m.siteUrl, videoUrl: m.videoUrl, review: m.review,
      presentation: m.presentation ? { ...m.presentation, missing: !exists(pres?.pdf_stored ?? pres?.stored) && !exists(pres?.stored) } : null,
      logo: m.logo ? { ...m.logo, missing: !exists(logo?.stored) } : null,
      scores: ar.scores.filter(s => s.teamId === t.id).length,
    };
  });
  const imp = db.prepare("SELECT source_file, source_schema, created_at FROM archive_imports WHERE org_id = ? AND event_id = ?").get(orgId, eventId) as
    { source_file: string; source_schema: number; created_at: number } | undefined;
  return {
    meta: repo.meta()!,
    event: { name: ev.name, product: ev.product, displayName: ev.displayName, date: ev.date, pitchSec: ev.timer.pitchSec, qaSec: ev.timer.qaSec,
      includeEntry: ev.includeEntry, entryMax: ev.entryMax, locked: ev.locked, finalOrder: ev.finalOrder },
    readOnly: repo.meta()?.status === "archived",
    ...ar,
    teams,
    historyTotal: repo.history({ limit: 1 }).total,
    imported: imp ? { file: imp.source_file, schema: imp.source_schema, at: imp.created_at } : null,
  };
}

/**
 * Archives the active event of the organisation and makes a new, empty one active (one transaction).
 * The live `event` row (settings, timer, stage, reveal) is copied into the archived event first, then reset for the
 * new one. Jurors and teams of the archived event are signed out; their data stays.
 */
export function createEvent(orgs: Orgs, sc: Scope, cfg: Config, actorId: number, input: NewEventInput, jurorHash = "!"): { archived: EventMeta; created: EventMeta } {
  const db = orgs.db;
  const orgId = sc.orgId;
  const old = sc.repo;
  // v4: the rubric / teams / jurors may come from any program of this organisation (an archived one included)
  const from = input.copyFrom ? orgs.eventRepo(orgId, input.copyFrom) : old;
  if (!from) throw new Error("copyFrom: program not found");
  const kick = db.transaction(() => {
    const cur = db.prepare("SELECT * FROM events WHERE org_id = ? AND status = 'active'").get(orgId) as EventsRow | undefined;
    if (!cur) throw new Error("no active event");
    const row = db.prepare("SELECT * FROM event WHERE org_id = ?").get(orgId) as Record<string, unknown>;
    const { results } = adminResults(old, cfg);
    const stats = {
      teams: old.teams().filter(t => t.active).length, jurors: old.jurors().length, scores: old.scoreCount(),
      top: results.ranking.filter(x => x.score != null).slice(0, 3).map(x => ({ rank: x.rank, name: x.team.name, score: x.score })),
    };
    const now = Date.now();
    const ev = old.getEvent();
    db.prepare("UPDATE events SET status = 'archived', archived_at = ?, settings_json = ?, stats_json = ?, name = ? WHERE id = ?")
      .run(now, JSON.stringify(row), JSON.stringify(stats), ev.displayName || cur.name, cur.id);
    // sign out the archived event's jurors and teams (rows stay; their event is no longer the active one)
    const jurors = db.prepare("SELECT id FROM users WHERE org_id = ? AND event_id = ? AND role = 'juror'").all(orgId, cur.id) as Array<{ id: number }>;
    for (const j of jurors) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(j.id);
    db.prepare("UPDATE juror_invites SET revoked_at = ? WHERE org_id = ? AND event_id = ? AND used_at IS NULL AND revoked_at IS NULL").run(now, orgId, cur.id);
    const teams = db.prepare("SELECT id FROM teams WHERE org_id = ? AND event_id = ?").all(orgId, cur.id) as Array<{ id: number }>;
    db.prepare("DELETE FROM team_sessions WHERE org_id = ? AND event_id = ?").run(orgId, cur.id);

    const product = input.product !== undefined ? asProduct(input.product) : ev.product;
    const created = db.prepare("INSERT INTO events (org_id, name, status, created_at) VALUES (?, ?, 'active', ?)").run(orgId, brandName(input.name, product), now);
    const newId = Number(created.lastInsertRowid);
    const timer = applyTimerAction({ ...ev.timer, pitchSec: input.pitchSec ?? ev.timer.pitchSec, qaSec: input.qaSec ?? ev.timer.qaSec }, "stop", now);
    db.prepare(`UPDATE event SET name = ?, product = ?, date = ?, current_team_id = NULL, timer_visible = 0, timer_running = 0, timer_offset_sec = 0,
      timer_anchor_at = NULL, pitch_sec = ?, qa_sec = ?, locked = 0, final_order_json = NULL, reveal_enabled = 0, reveal_step = 0, reveal_snapshot = NULL,
      upload_deadline = ?, stage_mode = 'auto', stage_slide = 1, stage_intro_at = NULL, stage_scene = 'team', stage_event_file = NULL, event_slide = 1
      WHERE org_id = ?`).run(input.name, product, input.date?.trim() || todayDate(), timer.pitchSec, timer.qaSec, input.uploadDeadline ?? null, orgId);

    orgs.invalidate(orgId);
    const next = orgs.scope(orgId);
    if (next.eventId !== newId) throw new Error("new event did not become active");
    const crit = input.copyCriteria === false ? null : from.criteria();
    if (crit?.length) for (const c of crit) next.repo.addCriterion({ key: c.key, name: c.name, description: c.description, maxScore: c.maxScore });
    if (input.copyTeams) for (const t of from.teams().filter(x => x.active)) next.repo.addTeam(t.name, t.project);
    // jurors: new accounts with the same names; nobody signs in with them until the coordinator shows each one a new QR
    if (input.copyJurors) for (const j of from.jurors().filter(x => x.active)) next.repo.createUser("juror", `juror-${randomBytes(5).toString("hex")}`, j.displayName, jurorHash);
    if (!next.repo.criteria().length) {
      // default rubric (same as a new organisation)
      for (const c of DEFAULT_CRITERIA) next.repo.addCriterion(c);
    }
    next.repo.audit(actorId, "event.create", { archived: cur.id, created: newId, name: input.name, copyCriteria: input.copyCriteria !== false, copyTeams: !!input.copyTeams,
      copyJurors: !!input.copyJurors, copyFrom: input.copyFrom ?? cur.id });
    return { archivedId: cur.id, newId, jurors: jurors.map(j => j.id), teams: teams.map(t => t.id) };
  })();
  // realtime: drop the archived event's live sockets and refresh every screen of the organisation
  const sc2 = orgs.scope(orgId);
  for (const id of kick.jurors) sc2.rt.kickUser(id);
  for (const id of kick.teams) sc2.rt.io.in(`team:${id}`).disconnectSockets(true);
  sc2.rt.clearOrgProgress();
  sc2.rt.emitConfig();
  sc2.rt.emitStage();
  sc2.rt.emitResults();
  sc2.rt.emitReveal();
  sc2.rt.emitLocked(false);
  const meta = (id: number) => eventMeta(db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventsRow);
  return { archived: meta(kick.archivedId), created: meta(kick.newId) };
}

