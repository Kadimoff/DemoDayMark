// v11 reliability: what /api/health and the platform panel's "Sistem vəziyyəti" card report.
// The public health answer carries no secrets, paths, names or counts of anyone's data — only liveness numbers.
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { AutoImportStatus } from "./archive.js";
import type { BackupScheduler } from "./backups.js";
import type { DB } from "./db.js";
import { SCHEMA_VERSION } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
function readVersion(): string {
  for (const p of [path.join(here, "..", "package.json"), path.join(here, "..", "..", "package.json")]) {
    try { return String((JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string }).version ?? "0"); } catch { /* next */ }
  }
  return "0";
}
const VERSION = readVersion();
/** Coolify passes SOURCE_COMMIT (when "include source commit" is on); the Dockerfile keeps it as an env var. */
const COMMIT = (process.env.SOURCE_COMMIT || process.env.GIT_COMMIT || process.env.COMMIT_SHA || "").slice(0, 12) || "unknown";

/** Event loop delay, measured continuously; the window restarts every minute so a spike does not stick forever. */
export class LoopMonitor {
  private h: ReturnType<typeof monitorEventLoopDelay>;
  private t: NodeJS.Timeout;
  private last = { p50: 0, p99: 0, max: 0 };
  constructor() {
    this.h = monitorEventLoopDelay({ resolution: 20 });
    this.h.enable();
    this.t = setInterval(() => { this.last = this.read(); this.h.reset(); }, 60_000);
    this.t.unref();
  }
  private read() {
    const ms = (n: number) => Math.round((n / 1e6) * 10) / 10;
    // the histogram includes the sampling interval itself
    return { p50: Math.max(0, ms(this.h.percentile(50)) - 20), p99: Math.max(0, ms(this.h.percentile(99)) - 20), max: Math.max(0, ms(this.h.max) - 20) };
  }
  /** Current window if it has samples, else the previous full minute. */
  lag() { return this.h.count > 10 ? this.read() : this.last; }
  stop() { clearInterval(this.t); this.h.disable(); }
}

export interface HealthDeps {
  db: DB;
  dbFile: string;
  integrity: { ok: boolean; errors: string[]; ms: number };
  backups: BackupScheduler;
  sockets: () => number;
  loop: LoopMonitor;
  startedAt: number;
  /** v4: result of the IMPORT_ARCHIVE_MATCH start-up import (null when the env is not set). */
  archiveImport?: AutoImportStatus | null;
}

function dbPing(db: DB): { ok: boolean; ms: number; error?: string } {
  const t0 = process.hrtime.bigint();
  try {
    const ok = !!db.prepare("SELECT 1 AS ok").get();
    return { ok, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  } catch (e) { return { ok: false, ms: 0, error: (e as Error).message }; }
}

/** Public: liveness numbers only. `ok` is false only when the database cannot be read (the container check fails then). */
export function publicHealth(d: HealthDeps) {
  const now = Date.now();
  const ping = dbPing(d.db);
  const b = d.backups.status();
  const backupAge = b.lastAt ? Math.round((now - b.lastAt) / 1000) : null;
  const warnings: string[] = [];
  if (!d.integrity.ok) warnings.push("db-integrity");
  if (b.enabled && b.lastError && (!b.lastAt || (b.lastErrorAt ?? 0) > b.lastAt)) warnings.push("backup-failed");
  if (b.enabled && backupAge != null && backupAge > (3 * b.intervalMs) / 1000 + 60) warnings.push("backup-old");
  const lag = d.loop.lag();
  if (lag.p99 > 200) warnings.push("event-loop-lag");
  const ai = d.archiveImport;
  if (ai?.status === "error") warnings.push("archive-import-failed");
  if (ai?.status === "not-found") warnings.push("archive-import-not-found");
  return {
    ok: ping.ok,
    time: now,
    version: VERSION,
    commit: COMMIT,
    schema: SCHEMA_VERSION,
    uptimeSec: Math.round((now - d.startedAt) / 1000),
    db: { ok: ping.ok, integrity: d.integrity.ok ? "ok" : "error", pingMs: Math.round(ping.ms * 100) / 100 },
    backup: { enabled: b.enabled, lastAt: b.lastAt, ageSec: backupAge, ok: !warnings.includes("backup-failed") },
    sockets: d.sockets(),
    eventLoopLagMs: lag,
    warnings,
    // v4: counts and the program name only (no team, juror or score data)
    ...(ai ? { archiveImport: { match: ai.match, org: ai.org, status: ai.status, at: ai.at, event: ai.event ?? null, file: ai.file ?? null,
      teams: ai.teams ?? null, jurors: ai.jurors ?? null, scores: ai.scores ?? null, scanned: ai.scanned ?? null } } : {}),
  };
}

/** Root only: the same plus sizes, memory and backup details (still no data of any organisation). */
export function systemStatus(d: HealthDeps, extra: Record<string, unknown> = {}) {
  const size = (f: string) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const m = process.memoryUsage();
  const b = d.backups.status();
  return {
    ...publicHealth(d),
    node: process.version,
    pid: process.pid,
    memoryMb: { rss: Math.round(m.rss / 1048576), heapUsed: Math.round(m.heapUsed / 1048576) },
    dbBytes: size(d.dbFile),
    walBytes: size(`${d.dbFile}-wal`),
    integrityErrors: d.integrity.errors,
    integrityMs: d.integrity.ms,
    backupDetail: { intervalMin: Math.round(b.intervalMs / 60000), keep: b.keep, count: b.count, lastFile: b.lastFile, lastBytes: b.lastBytes, lastMs: b.lastMs,
      lastError: b.lastError, lastErrorAt: b.lastErrorAt },
    ...extra,
  };
}
