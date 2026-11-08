// v11 reliability: online backups of the live SQLite database and restoring one of them.
//
// - Periodic: while the server runs, a consistent copy (better-sqlite3 online backup API — safe while jurors write) goes to
//   DATA_DIR/backups/auto-<time>.db every BACKUP_INTERVAL_MIN minutes (default 10), only when something changed since the
//   last copy. Only the newest BACKUP_KEEP (default 48 ≈ 8 hours of an event) auto copies are kept; pre-migration copies
//   (pre-v*), manual ones (manual-*, ignite-*) and pre-restore copies are never touched by that rotation.
// - Each copy is written to a .part file, checked with PRAGMA quick_check and only then renamed into place, so a crash
//   mid-backup never leaves a half file that looks like a backup.
// - Restore: `node dist-server/server/restore.js <backup>` writes DATA_DIR/restore-request.json; on its next start the
//   server (before opening the database) verifies the backup, moves the current database to backups/pre-restore-*.db and
//   puts the backup in its place. `--now` does the same immediately (the server must be stopped).
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db.js";

export const RESTORE_REQUEST = "restore-request.json";
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 23);

/** Consistent copy of `db` into `dir` as <prefix>-<time>.db (verified before it gets its final name). */
export async function onlineBackup(db: DB, dir: string, prefix = "auto"): Promise<{ file: string; bytes: number; ms: number }> {
  const t0 = Date.now();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${prefix}-${stamp()}.db`);
  const part = `${file}.part`;
  try {
    await db.backup(part);
    // a standalone single file (no -wal / -shm next to it), checked before it gets its final name
    const d = new Database(part);
    try {
      d.pragma("journal_mode = DELETE");
      const bad = (d.pragma("quick_check") as Array<{ quick_check: string }>).map(r => r.quick_check).filter(v => v !== "ok");
      if (bad.length) throw new Error(`backup copy failed its check: ${bad.slice(0, 3).join("; ")}`);
    } finally { d.close(); }
    fs.renameSync(part, file);
  } catch (e) {
    for (const x of ["", "-wal", "-shm", "-journal"]) fs.rmSync(part + x, { force: true });
    throw e;
  }
  return { file, bytes: fs.statSync(file).size, ms: Date.now() - t0 };
}

/** Opens a database file read-only and runs quick_check; also reports its schema version. */
export function verifyDbFile(file: string): { ok: boolean; error?: string; version?: number } {
  let d: Database.Database | null = null;
  try {
    d = new Database(file, { readonly: true, fileMustExist: true });
    const rows = d.pragma("quick_check") as Array<{ quick_check: string }>;
    const bad = rows.map(r => r.quick_check).filter(v => v !== "ok");
    const version = d.pragma("user_version", { simple: true }) as number;
    if (bad.length) return { ok: false, error: bad.slice(0, 3).join("; "), version };
    if (!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'scores'").get()) return { ok: false, error: "not a munsif.im database (no scores table)", version };
    return { ok: true, version };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally { d?.close(); }
}

/** Newest first. */
export function listBackups(dir: string, re = /\.db$/) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => re.test(n)).map(n => {
    const st = fs.statSync(path.join(dir, n));
    return { name: n, bytes: st.size, at: st.mtimeMs };
  }).sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
}

export interface BackupStatus {
  enabled: boolean;
  intervalMs: number;
  keep: number;
  lastAt: number | null;
  lastFile: string | null;
  lastBytes: number | null;
  lastMs: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  count: number;
  running: boolean;
}

/** Periodic online backup while the server runs. */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastChanges = -1;
  private st: BackupStatus;
  constructor(private db: DB, private dir: string, opts: { intervalMs: number; keep: number }, private log: (level: "info" | "error", m: string) => void = () => {}) {
    this.st = { enabled: opts.intervalMs > 0, intervalMs: opts.intervalMs, keep: Math.max(1, opts.keep), lastAt: null, lastFile: null, lastBytes: null, lastMs: null,
      lastError: null, lastErrorAt: null, count: 0, running: false };
    // a crash in the middle of an earlier copy can leave a .part file behind
    try { for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (/\.db\.part(-wal|-shm|-journal)?$/.test(n)) fs.rmSync(path.join(dir, n), { force: true }); } catch { /* ignore */ }
    const last = listBackups(dir, /^auto-.*\.db$/)[0];
    if (last) { this.st.lastAt = last.at; this.st.lastFile = last.name; this.st.lastBytes = last.bytes; }
    this.st.count = listBackups(dir, /^auto-.*\.db$/).length;
  }
  start() {
    if (!this.st.enabled || this.timer) return;
    this.timer = setInterval(() => { void this.run(); }, this.st.intervalMs);
    this.timer.unref();
    // first copy soon after start (the database may just have been migrated or restored)
    const first = setTimeout(() => { void this.run(); }, Math.min(15_000, this.st.intervalMs));
    first.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  status(): BackupStatus { return { ...this.st }; }

  /** One backup now (skipped when nothing changed since the last one, unless forced). */
  async run(force = false): Promise<string | null> {
    if (this.st.running) return null;
    let changes = 0;
    try { changes = (this.db.prepare("SELECT total_changes() n").get() as { n: number }).n; } catch { return null; /* closed */ }
    if (!force && changes === this.lastChanges && this.st.lastAt) return null;
    this.st.running = true;
    try {
      const r = await onlineBackup(this.db, this.dir, "auto");
      this.lastChanges = changes;
      Object.assign(this.st, { lastAt: Date.now(), lastFile: path.basename(r.file), lastBytes: r.bytes, lastMs: r.ms, lastError: null });
      const all = listBackups(this.dir, /^auto-.*\.db$/);
      for (const o of all.slice(this.st.keep)) for (const x of ["", "-wal", "-shm"]) fs.rmSync(path.join(this.dir, o.name + x), { force: true });
      this.st.count = Math.min(all.length, this.st.keep);
      this.log("info", `backup ${path.basename(r.file)} (${Math.round(r.bytes / 1024)} KB, ${r.ms} ms)`);
      return r.file;
    } catch (e) {
      this.st.lastError = (e as Error).message;
      this.st.lastErrorAt = Date.now();
      this.log("error", `backup failed: ${(e as Error).message}`);
      return null;
    } finally { this.st.running = false; }
  }
}

/** Puts `backupFile` in place of `dbFile` (the server must not have the database open). Returns the copy of the old one. */
export function restoreNow(dbFile: string, backupFile: string, backupDir: string): { previous: string | null; version: number | undefined } {
  const src = path.resolve(backupFile);
  if (!fs.existsSync(src)) throw new Error(`backup not found: ${src}`);
  const check = verifyDbFile(src);
  if (!check.ok) throw new Error(`backup is not usable: ${check.error}`);
  fs.mkdirSync(backupDir, { recursive: true });
  let previous: string | null = null;
  if (fs.existsSync(dbFile)) {
    // fold the WAL into the old file first, so the pre-restore copy is complete on its own
    try { const d = new Database(dbFile); d.pragma("wal_checkpoint(TRUNCATE)"); d.close(); } catch { /* copy what is there */ }
    previous = path.join(backupDir, `pre-restore-${stamp()}.db`);
    fs.copyFileSync(dbFile, previous);
    for (const ext of ["-wal", "-shm"]) if (fs.existsSync(dbFile + ext)) fs.copyFileSync(dbFile + ext, previous + ext);
  }
  const tmp = `${dbFile}.restore-part`;
  fs.copyFileSync(src, tmp);
  for (const ext of ["-wal", "-shm"]) fs.rmSync(dbFile + ext, { force: true });
  fs.renameSync(tmp, dbFile);
  return { previous, version: check.version };
}

/** At start, before the database is opened: carries out a restore requested with `restore.js <file>`. */
export function applyRestoreRequest(dataDir: string, dbFile: string, backupDir: string, log: (m: string) => void = () => {}): string | null {
  const req = path.join(dataDir, RESTORE_REQUEST);
  if (!fs.existsSync(req)) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  let file = "";
  try { file = String((JSON.parse(fs.readFileSync(req, "utf8")) as { file?: string }).file ?? ""); } catch { /* bad file */ }
  const abs = file && !path.isAbsolute(file) ? path.join(backupDir, file) : file;
  try {
    if (!abs) throw new Error("restore request without a file");
    const r = restoreNow(dbFile, abs, backupDir);
    log(`restored database from ${path.basename(abs)} (schema v${r.version}); previous database kept as ${r.previous ? path.basename(r.previous) : "—"}`);
    fs.renameSync(req, path.join(backupDir, `restore-done-${stamp()}.json`));
    return abs;
  } catch (e) {
    log(`restore request NOT applied: ${(e as Error).message}`);
    fs.renameSync(req, path.join(backupDir, `restore-failed-${stamp()}.json`));
    return null;
  }
}
