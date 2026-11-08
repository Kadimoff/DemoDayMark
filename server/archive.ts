// v4: programs (events) from backup files. A backup in DATA_DIR/backups (nightly copy, pre-migration copy, auto-* copy) can
// hold a program that no longer exists in the live database (the owner's first event "Ignite" was later reconfigured into
// another one in the same database). The platform owner sees a summary of every backup and imports one program from it into
// an organisation as a NEW ARCHIVED program: teams, rubric, jurors, scores, scoring history, juror QR invites (revoked) and
// team file metadata.
//
// Safety:
// - The backup file is never opened in place: it is copied into a temp file first, and only the copy is migrated to the
//   current schema (any schema the app ever wrote, v1..current, reads the same way afterwards) and read.
// - The import only ever INSERTS rows of a new archived event. It never writes into the active program of an organisation.
// - One transaction: the ranking of the imported program is computed again and compared with the ranking computed from the
//   backup before the commit; any difference (or any error) rolls everything back.
// - Imported jurors cannot sign in: their event is archived (sessions of archived events are invalid), their password hash
//   is not a hash, their invites are revoked and their invite token hashes are replaced.
// - Idempotent: a ledger (archive_imports) remembers the source file hash + event and the program's content key.
import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.js";
import { onlineBackup } from "./backups.js";
import { openDb, SCHEMA_VERSION, type DB } from "./db.js";
import { Repo, type EventsRow } from "./repo.js";
import { adminResults } from "./views.js";

/** Backup file names the import accepts (no paths, no hidden files). */
export const BACKUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.db$/;
const MAX_BYTES = 1024 * 1024 * 1024;

export interface BackupEvent {
  orgId: number; orgSlug: string; orgName: string;
  eventId: number; name: string; brand: string; product: string; date: string;
  status: "active" | "archived";
  teams: number; jurors: number; scores: number; history: number; files: number;
  firstScoreAt: number | null; lastScoreAt: number | null;
  /** This event is itself an import inside the backup (never offered for import again). */
  imported: boolean;
  contentKey: string;
}
export interface BackupSummary {
  file: string; bytes: number; mtime: number;
  /** Schema version of the file itself (before the temp copy was migrated). */
  schema: number | null;
  ok: boolean; error?: string;
  events: BackupEvent[];
}

export class ImportError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

/** Resolves a backup file name inside `dir`; null for anything that is not a plain backup name in that directory. */
export function backupPath(dir: string, name: string): string | null {
  if (typeof name !== "string" || !BACKUP_NAME_RE.test(name) || name.includes("..")) return null;
  const base = path.resolve(dir);
  const p = path.resolve(base, name);
  if (path.dirname(p) !== base) return null;
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) return null;
  } catch { return null; }
  return p;
}

export function listBackupFiles(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => BACKUP_NAME_RE.test(n)).flatMap(n => {
    const p = backupPath(dir, n);
    if (!p) return [];
    const st = fs.statSync(p);
    return [{ name: n, path: p, bytes: st.size, mtime: st.mtimeMs }];
  }).sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
}

/** A migrated temp copy of a backup file. `close()` deletes the copy. */
export interface Opened { db: DB; schema: number; sha256: string; close: () => void }

export function openBackupCopy(file: string): Opened {
  const st = fs.statSync(file);
  if (st.size > MAX_BYTES) throw new ImportError(400, "Fayl çox böyükdür.");
  const tmp = path.join(os.tmpdir(), `munsif-archive-${process.pid}-${randomBytes(6).toString("hex")}.db`);
  const clean = () => { for (const x of ["", "-wal", "-shm", "-journal"]) fs.rmSync(tmp + x, { force: true }); };
  try {
    fs.copyFileSync(file, tmp);
    // a backup with its own WAL next to it (copied by hand from a live volume): take it along, it holds the last commits
    if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, `${tmp}-wal`);
    const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const raw = new Database(tmp);
    let schema = 0;
    try {
      schema = raw.pragma("user_version", { simple: true }) as number;
      const bad = (raw.pragma("quick_check") as Array<{ quick_check: string }>).map(r => r.quick_check).filter(v => v !== "ok");
      if (bad.length) throw new ImportError(400, `Fayl zədəlidir: ${bad.slice(0, 2).join("; ")}`);
      if (!raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'scores'").get()) throw new ImportError(400, "Bu fayl munsif.im bazası deyil.");
      if (schema > SCHEMA_VERSION) throw new ImportError(400, `Faylın sxemi (v${schema}) bu versiyadan yenidir (v${SCHEMA_VERSION}).`);
    } finally { raw.close(); }
    const db = openDb(tmp);
    return { db, schema, sha256, close: () => { try { db.close(); } catch { /* closed */ } clean(); } };
  } catch (e) {
    clean();
    if (e instanceof ImportError) throw e;
    throw new ImportError(400, `Faylı oxumaq alınmadı: ${(e as Error).message}`);
  }
}

const n = (db: DB, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number | null }).n ?? 0;

/** Same program, whatever file it comes from: team and juror names + the first moments of scoring. */
export function contentKey(db: DB, orgId: number, eventId: number) {
  const names = (sql: string) => (db.prepare(sql).all(orgId, eventId) as Array<{ v: string }>).map(r => r.v).sort();
  const first = (sql: string) => (db.prepare(sql).get(orgId, eventId) as { v: number | null }).v ?? 0;
  const k = {
    teams: names("SELECT name v FROM teams WHERE org_id = ? AND event_id = ?"),
    jurors: names("SELECT display_name v FROM users WHERE org_id = ? AND event_id = ? AND role = 'juror'"),
    firstHistory: first("SELECT MIN(created_at) v FROM score_history WHERE org_id = ? AND event_id = ?"),
    firstScore: first("SELECT MIN(created_at) v FROM scores WHERE org_id = ? AND event_id = ?"),
  };
  return createHash("sha256").update(JSON.stringify(k)).digest("hex").slice(0, 32);
}

function hasTable(db: DB, t: string) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t); }

/** Summary of the programs in an opened (migrated) database. Counts and names only. */
export function summarize(db: DB): BackupEvent[] {
  const orgs = db.prepare("SELECT id, slug, name FROM orgs ORDER BY id").all() as Array<{ id: number; slug: string; name: string }>;
  const imported = new Set(hasTable(db, "archive_imports")
    ? (db.prepare("SELECT org_id, event_id FROM archive_imports").all() as Array<{ org_id: number; event_id: number }>).map(r => `${r.org_id}:${r.event_id}`) : []);
  const out: BackupEvent[] = [];
  for (const o of orgs) {
    const events = db.prepare("SELECT * FROM events WHERE org_id = ? ORDER BY id").all(o.id) as EventsRow[];
    for (const e of events) {
      const repo = new Repo(db, o.id, o.slug, e.id);
      const ev = repo.getEvent();
      const q = (sql: string) => n(db, sql, o.id, e.id);
      out.push({
        orgId: o.id, orgSlug: o.slug, orgName: o.name, eventId: e.id,
        name: e.status === "active" ? ev.displayName : e.name || ev.displayName, brand: ev.name, product: ev.product, date: ev.date,
        status: e.status === "archived" ? "archived" : "active",
        teams: q("SELECT COUNT(*) n FROM teams WHERE org_id = ? AND event_id = ?"),
        jurors: q("SELECT COUNT(*) n FROM users WHERE org_id = ? AND event_id = ? AND role = 'juror'"),
        scores: q("SELECT COUNT(*) n FROM scores WHERE org_id = ? AND event_id = ?"),
        history: q("SELECT COUNT(*) n FROM score_history WHERE org_id = ? AND event_id = ?"),
        files: q("SELECT COUNT(*) n FROM team_files WHERE org_id = ? AND event_id = ?"),
        firstScoreAt: q("SELECT MIN(created_at) n FROM scores WHERE org_id = ? AND event_id = ?") || null,
        lastScoreAt: q("SELECT MAX(updated_at) n FROM scores WHERE org_id = ? AND event_id = ?") || null,
        imported: imported.has(`${o.id}:${e.id}`),
        contentKey: contentKey(db, o.id, e.id),
      });
    }
  }
  return out;
}

// Summaries are cached by file name + size + mtime: scanning means copying and migrating every file.
const cache = new Map<string, BackupSummary>();
export function scanBackup(dir: string, name: string): BackupSummary {
  const p = backupPath(dir, name);
  if (!p) return { file: name, bytes: 0, mtime: 0, schema: null, ok: false, error: "Fayl tapılmadı.", events: [] };
  const st = fs.statSync(p);
  const key = `${p}|${st.size}|${st.mtimeMs}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let s: BackupSummary;
  try {
    const o = openBackupCopy(p);
    try { s = { file: name, bytes: st.size, mtime: st.mtimeMs, schema: o.schema, ok: true, events: summarize(o.db) }; } finally { o.close(); }
  } catch (e) {
    s = { file: name, bytes: st.size, mtime: st.mtimeMs, schema: null, ok: false, error: (e as Error).message, events: [] };
  }
  cache.set(key, s);
  if (cache.size > 300) cache.delete(cache.keys().next().value as string);
  return s;
}
export function scanBackups(dir: string): BackupSummary[] {
  return listBackupFiles(dir).map(f => scanBackup(dir, f.name));
}

export interface ImportOptions {
  file: string;
  sourceOrgId: number;
  sourceEventId: number;
  targetOrgId: number;
  /** Copy score-related audit log rows too. */
  audit?: boolean;
  actorId?: number | null;
  /** Set by the IMPORT_ARCHIVE_MATCH start-up import. */
  autoMatch?: string | null;
  /** Tests only: runs inside the transaction right before the commit. */
  beforeCommit?: () => void;
}
export interface ImportResult {
  eventId: number; orgId: number; name: string; file: string;
  teams: number; jurors: number; scores: number; history: number; invites: number; files: number; filesMissing: number; audit: number;
  ranking: Array<{ rank: number | null; name: string; score: number | null }>;
}

type Row = Record<string, unknown>;

/** Imports one program of a backup file into `targetOrgId` as a new archived program. */
export function importArchive(db: DB, cfg: Config, opts: ImportOptions): ImportResult {
  const file = backupPath(cfg.backupDir, opts.file);
  if (!file) throw new ImportError(400, "Yedək faylı tapılmadı.");
  const org = db.prepare("SELECT id, slug FROM orgs WHERE id = ?").get(opts.targetOrgId) as { id: number; slug: string } | undefined;
  if (!org) throw new ImportError(404, "Təşkilat tapılmadı.");
  const src = openBackupCopy(file);
  try {
    const s = src.db;
    const sOrg = s.prepare("SELECT id, slug FROM orgs WHERE id = ?").get(opts.sourceOrgId) as { id: number; slug: string } | undefined;
    const sEv = sOrg ? (s.prepare("SELECT * FROM events WHERE id = ? AND org_id = ?").get(opts.sourceEventId, sOrg.id) as EventsRow | undefined) : undefined;
    if (!sOrg || !sEv) throw new ImportError(404, "Bu faylda belə proqram yoxdur.");
    const srcRepo = new Repo(s, sOrg.id, sOrg.slug, sEv.id);
    const key = contentKey(s, sOrg.id, sEv.id);
    const name = sEv.status === "active" ? srcRepo.getEvent().displayName : sEv.name || srcRepo.getEvent().displayName;

    const same = db.prepare(`SELECT a.event_id, a.source_file FROM archive_imports a WHERE a.org_id = ?
      AND ((a.source_sha256 = ? AND a.source_org_id = ? AND a.source_event_id = ?) OR a.content_key = ?) LIMIT 1`)
      .get(org.id, src.sha256, sOrg.id, sEv.id, key) as { event_id: number; source_file: string } | undefined;
    if (same) throw new ImportError(409, `Bu proqram artıq import olunub (${same.source_file}).`, { eventId: same.event_id });
    // the same program may also still live in this database (archived the normal way)
    for (const e of db.prepare("SELECT id FROM events WHERE org_id = ?").all(org.id) as Array<{ id: number }>) {
      if (n(db, "SELECT COUNT(*) n FROM teams WHERE org_id = ? AND event_id = ?", org.id, e.id) && contentKey(db, org.id, e.id) === key) {
        throw new ImportError(409, "Bu proqram bu təşkilatda artıq var.", { eventId: e.id });
      }
    }

    const sel = (t: string) => s.prepare(`SELECT * FROM ${t} WHERE org_id = ? AND event_id = ? ORDER BY id`).all(sOrg.id, sEv.id) as Row[];
    const cols = new Map<string, string[]>();
    const colsOf = (t: string) => {
      let c = cols.get(t);
      if (!c) { c = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(x => x.name).filter(x => x !== "id"); cols.set(t, c); }
      return c;
    };
    const insert = (t: string, r: Row, over: Row) => {
      const c = colsOf(t);
      const v = c.map(k => (k in over ? over[k] : r[k] ?? null));
      return Number(db.prepare(`INSERT INTO ${t} (${c.join(", ")}) VALUES (${c.map(() => "?").join(", ")})`).run(...v).lastInsertRowid);
    };
    const srcRanking = rankingOf(srcRepo, cfg);
    const now = Date.now();
    const uploads = cfg.uploadsDir;

    const result = db.transaction((): ImportResult => {
      const times = [sEv.created_at, n(s, "SELECT MIN(created_at) n FROM score_history WHERE org_id = ? AND event_id = ?", sOrg.id, sEv.id),
        n(s, "SELECT MIN(created_at) n FROM scores WHERE org_id = ? AND event_id = ?", sOrg.id, sEv.id)].filter(x => x > 0);
      const last = Math.max(sEv.archived_at ?? 0, n(s, "SELECT MAX(updated_at) n FROM scores WHERE org_id = ? AND event_id = ?", sOrg.id, sEv.id),
        n(s, "SELECT MAX(created_at) n FROM score_history WHERE org_id = ? AND event_id = ?", sOrg.id, sEv.id));
      const createdAt = Math.min(...times, now);
      const evId = Number(db.prepare("INSERT INTO events (org_id, name, status, created_at, archived_at, settings_json, stats_json) VALUES (?, ?, 'archived', ?, ?, '{}', '{}')")
        .run(org.id, name, createdAt, last || createdAt).lastInsertRowid);

      // rubric: keys are unique per organisation, so they may get a suffix; score values are re-keyed with the map
      const keyMap = new Map<string, string>();
      for (const c of sel("criteria")) {
        let k = String(c.key);
        for (let i = 2; db.prepare("SELECT 1 FROM criteria WHERE org_id = ? AND key = ?").get(org.id, k); i++) k = `${c.key}_${i}`;
        keyMap.set(String(c.key), k);
        insert("criteria", c, { key: k, org_id: org.id, event_id: evId });
      }
      const teamMap = new Map<number, number>();
      for (const t of sel("teams")) teamMap.set(Number(t.id), insert("teams", t, { org_id: org.id, event_id: evId }));
      const jurorMap = new Map<number, number>();
      for (const u of sel("users").filter(u => u.role === "juror")) {
        let un = `arxiv${evId}-${u.id}`;
        while (db.prepare("SELECT 1 FROM users WHERE username = ?").get(un)) un = `arxiv${evId}-${u.id}-${randomBytes(3).toString("hex")}`;
        jurorMap.set(Number(u.id), insert("users", u, { username: un, password_hash: "!archived", is_root: 0, org_id: org.id, event_id: evId }));
      }
      const reKey = (json: unknown) => {
        try {
          const v = JSON.parse(String(json ?? "{}")) as Record<string, number>;
          return JSON.stringify(Object.fromEntries(Object.entries(v).map(([k, x]) => [keyMap.get(k) ?? k, x])));
        } catch { return String(json ?? "{}"); }
      };
      const reKeyList = (json: unknown) => {
        try {
          const v = JSON.parse(String(json ?? "[]")) as Array<{ key: string }>;
          return JSON.stringify(Array.isArray(v) ? v.map(x => ({ ...x, key: keyMap.get(x.key) ?? x.key })) : []);
        } catch { return String(json ?? "[]"); }
      };
      let scores = 0;
      for (const r of sel("scores")) {
        const j = jurorMap.get(Number(r.juror_id)), t = teamMap.get(Number(r.team_id));
        if (!j || !t) continue;
        insert("scores", r, { juror_id: j, team_id: t, values_json: reKey(r.values_json), org_id: org.id, event_id: evId });
        scores++;
      }
      let history = 0;
      for (const r of sel("score_history")) {
        insert("score_history", r, {
          juror_id: r.juror_id == null ? null : jurorMap.get(Number(r.juror_id)) ?? null,
          team_id: r.team_id == null ? null : teamMap.get(Number(r.team_id)) ?? null,
          values_json: reKeyList(r.values_json), org_id: org.id, event_id: evId,
        });
        history++;
      }
      let invites = 0;
      for (const r of sel("juror_invites")) {
        const j = jurorMap.get(Number(r.user_id));
        if (!j) continue;
        insert("juror_invites", r, { user_id: j, token_hash: `archived:${evId}:${r.id}`, revoked_at: r.revoked_at ?? now, org_id: org.id, event_id: evId });
        invites++;
      }
      let files = 0, filesMissing = 0;
      for (const r of sel("team_files")) {
        const t = teamMap.get(Number(r.team_id));
        if (!t) continue;
        insert("team_files", r, { team_id: t, org_id: org.id, event_id: evId });
        files++;
        if (!fs.existsSync(path.join(uploads, path.basename(String(r.stored))))) filesMissing++;
      }
      let audit = 0;
      if (opts.audit) {
        const from = createdAt - 60_000, to = (last || now) + 60_000;
        const rows = s.prepare(`SELECT * FROM audit_log WHERE org_id = ? AND created_at BETWEEN ? AND ?
          AND (action LIKE 'score%' OR action LIKE 'reveal.%' OR action LIKE 'results.%' OR action IN ('juror.claim','juror.create','juror.delete','event.lock','event.unlock'))
          ORDER BY id`).all(sOrg.id, from, to) as Row[];
        for (const r of rows) {
          let p: unknown = {};
          try { p = JSON.parse(String(r.payload_json)); } catch { /* keep {} */ }
          insert("audit_log", r, {
            actor_id: r.actor_id == null ? null : jurorMap.get(Number(r.actor_id)) ?? null,
            payload_json: JSON.stringify({ ...(p as object), imported: { eventId: evId, file: path.basename(file) } }), org_id: org.id,
          });
          audit++;
        }
      }

      // the program's settings as they were (archived events read them from settings_json), team ids re-mapped
      const settings = { ...(sEv.status === "archived" && sEv.settings_json ? JSON.parse(sEv.settings_json) as Row
        : s.prepare("SELECT * FROM event WHERE org_id = ?").get(sOrg.id) as Row) };
      const mapId = (v: unknown) => (v == null ? null : teamMap.get(Number(v)) ?? null);
      settings.org_id = org.id;
      settings.current_team_id = mapId(settings.current_team_id);
      settings.timer_running = 0;
      settings.stage_event_file = null;
      settings.stage_scene = "team";
      try {
        const fo = settings.final_order_json ? (JSON.parse(String(settings.final_order_json)) as number[]) : null;
        settings.final_order_json = fo ? JSON.stringify(fo.map(mapId).filter((x): x is number => x != null)) : null;
      } catch { settings.final_order_json = null; }
      try {
        const snap = settings.reveal_snapshot ? (JSON.parse(String(settings.reveal_snapshot)) as { entries?: Array<{ teamId: number }> }) : null;
        if (snap?.entries) snap.entries = snap.entries.map(e => ({ ...e, teamId: mapId(e.teamId) ?? 0 }));
        settings.reveal_snapshot = snap ? JSON.stringify(snap) : null;
      } catch { settings.reveal_snapshot = null; }
      db.prepare("UPDATE events SET settings_json = ? WHERE id = ?").run(JSON.stringify(settings), evId);

      // the check that matters: the imported program ranks exactly like the backup
      const repo = new Repo(db, org.id, org.slug, evId);
      const ranking = rankingOf(repo, cfg);
      if (JSON.stringify(ranking) !== JSON.stringify(srcRanking)) throw new ImportError(500, "Import yoxlaması alınmadı: reytinq mənbə ilə eyni deyil. Heç nə dəyişmədi.");
      const { results } = adminResults(repo, cfg);
      const top = results.ranking.filter(x => x.score != null).slice(0, 3).map(x => ({ rank: x.rank, name: x.team.name, score: x.score }));
      const stats = { teams: repo.teams().filter(t => t.active).length, jurors: repo.jurors().length, scores: repo.scoreCount(), top, imported: true };
      db.prepare("UPDATE events SET stats_json = ? WHERE id = ?").run(JSON.stringify(stats), evId);
      const res: ImportResult = { eventId: evId, orgId: org.id, name, file: path.basename(file), teams: teamMap.size, jurors: jurorMap.size, scores, history, invites, files, filesMissing, audit, ranking: top };
      db.prepare(`INSERT INTO archive_imports (org_id, event_id, source_file, source_sha256, source_schema, source_org_id, source_event_id, source_name, content_key,
        auto_match, stats_json, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(org.id, evId, path.basename(file), src.sha256, src.schema, sOrg.id, sEv.id, name, key, opts.autoMatch ?? null,
          JSON.stringify({ teams: res.teams, jurors: res.jurors, scores, history, files, filesMissing, audit }), opts.actorId ?? null, now);
      new Repo(db, org.id, org.slug).audit(opts.actorId ?? null, "event.import", { eventId: evId, file: path.basename(file), sourceEvent: sEv.id, teams: res.teams, scores, auto: opts.autoMatch ?? null });
      opts.beforeCommit?.();
      return res;
    })();
    return result;
  } finally { src.close(); }
}

function rankingOf(repo: Repo, cfg: Config) {
  return adminResults(repo, cfg).results.ranking.map(r => ({ name: r.team.name, rank: r.rank, score: r.score, demo: r.demo, n: r.n, entry: r.entry }));
}

/** Programs imported into an organisation (or all), newest first. */
export function importLedger(db: DB, orgId?: number) {
  const rows = db.prepare(`SELECT a.*, o.slug, o.name org_name, e.name event_name FROM archive_imports a JOIN orgs o ON o.id = a.org_id
    LEFT JOIN events e ON e.id = a.event_id ${orgId ? "WHERE a.org_id = ?" : ""} ORDER BY a.id DESC`).all(...(orgId ? [orgId] : [])) as Array<Row>;
  return rows.map(r => ({
    id: r.id as number, orgId: r.org_id as number, orgSlug: r.slug as string, orgName: r.org_name as string, eventId: r.event_id as number,
    eventName: (r.event_name as string) ?? (r.source_name as string), file: r.source_file as string, schema: r.source_schema as number,
    auto: (r.auto_match as string | null) ?? null, at: r.created_at as number, stats: JSON.parse(String(r.stats_json || "{}")) as Record<string, number>,
  }));
}

/** Case-insensitive match that treats I / İ / ı / i alike ("ignite" finds "Ignite" in either locale). */
const fold = (s: string) => s.replace(/[Iİı]/g, "i").toLowerCase();

export interface AutoImportStatus {
  match: string; org: string;
  status: "imported" | "already" | "not-found" | "error";
  at: number;
  event?: string; file?: string; teams?: number; jurors?: number; scores?: number;
  error?: string;
  scanned?: number;
}

/**
 * IMPORT_ARCHIVE_MATCH=<text> (+ IMPORT_ARCHIVE_ORG=<slug>, default root): at start, finds the program whose name or brand
 * contains the text in the backups (most scores wins; on a tie the newest file) and imports it once. Logs what it scanned.
 */
export async function autoImport(db: DB, cfg: Config, match: string, orgSlug: string, log: (m: string) => void): Promise<AutoImportStatus> {
  const m = match.trim();
  const slug = (orgSlug || "root").trim().toLowerCase();
  const base: AutoImportStatus = { match: m, org: slug, status: "not-found", at: Date.now() };
  try {
    const org = db.prepare("SELECT id FROM orgs WHERE slug = ?").get(slug) as { id: number } | undefined;
    if (!org) { log(`archive import: organisation "${slug}" not found, nothing imported`); return { ...base, status: "error", error: "organisation not found" }; }
    const done = db.prepare("SELECT a.*, e.name event_name FROM archive_imports a LEFT JOIN events e ON e.id = a.event_id WHERE a.org_id = ? AND a.auto_match = ? COLLATE NOCASE ORDER BY a.id LIMIT 1").get(org.id, m) as Row | undefined;
    if (done) {
      log(`archive import: "${m}" was already imported into ${slug} (event #${done.event_id} "${done.event_name}" from ${done.source_file}); nothing to do`);
      return { ...base, status: "already", event: String(done.event_name ?? done.source_name), file: String(done.source_file) };
    }
    const files = scanBackups(cfg.backupDir);
    const want = fold(m);
    const hits = files.flatMap(f => f.events.filter(e => !e.imported && [e.name, e.brand, `${e.brand} ${e.product}`].some(x => fold(x).includes(want)))
      .map(e => ({ f, e })));
    if (!hits.length) {
      log(`archive import: no program matching "${m}" in ${files.length} backup file(s) of ${cfg.backupDir}`);
      for (const f of files) {
        log(`  ${f.file} (${Math.round(f.bytes / 1024)} KB, schema ${f.schema ?? "?"}${f.ok ? "" : `, unreadable: ${f.error}`}): ${f.events.map(e => `${e.orgSlug}/#${e.eventId} "${e.name}" teams=${e.teams} jurors=${e.jurors} scores=${e.scores}${e.imported ? " (imported)" : ""}`).join("; ") || "no programs"}`);
      }
      return { ...base, scanned: files.length };
    }
    hits.sort((a, b) => b.e.scores - a.e.scores || b.f.mtime - a.f.mtime || (a.f.file < b.f.file ? 1 : -1));
    const best = hits[0];
    log(`archive import: "${m}" → ${best.f.file} ${best.e.orgSlug}/#${best.e.eventId} "${best.e.name}" (teams=${best.e.teams} jurors=${best.e.jurors} scores=${best.e.scores}; ${hits.length} candidate(s) in ${files.length} file(s))`);
    try {
      // one more consistent copy of the live database right before anything is written (pre-import-*.db)
      const pre = await onlineBackup(db, cfg.backupDir, "pre-import");
      log(`archive import: live database copied to ${path.basename(pre.file)} first`);
      const r = importArchive(db, cfg, { file: best.f.file, sourceOrgId: best.e.orgId, sourceEventId: best.e.eventId, targetOrgId: org.id, autoMatch: m, audit: true });
      log(`archive import: imported "${r.name}" into ${slug} as archived event #${r.eventId}: teams=${r.teams} jurors=${r.jurors} scores=${r.scores} history=${r.history} files=${r.files} (missing ${r.filesMissing}); ranking matches the backup`);
      return { ...base, status: "imported", event: r.name, file: r.file, teams: r.teams, jurors: r.jurors, scores: r.scores, scanned: files.length };
    } catch (e) {
      if (e instanceof ImportError && e.status === 409) {
        log(`archive import: "${best.e.name}" is already in ${slug} (${e.message}); nothing to do`);
        return { ...base, status: "already", event: best.e.name, file: best.f.file };
      }
      throw e;
    }
  } catch (e) {
    log(`archive import FAILED (nothing changed): ${(e as Error).message}`);
    return { ...base, status: "error", error: (e as Error).message };
  }
}
