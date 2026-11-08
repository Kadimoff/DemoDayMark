import "dotenv/config";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** `which soffice` / `which libreoffice` without spawning a shell. */
export function findSoffice(): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of ["soffice", "libreoffice"]) {
      const p = path.join(dir, name);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
    }
  }
  return "";
}

const bool = (v: string | undefined, def: boolean) =>
  v == null || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase());

const origins = (process.env.ORIGIN ?? "")
  .split(",")
  .map(s => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  assetsDir: string;
  webDir: string;
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  sessionTtlMs: number;
  origins: string[];
  cookieSecure: boolean;
  trustProxy: boolean;
  showJurorTotal: boolean;
  minJurorsForRank: number;
  loginMaxFails: number;
  loginLockMs: number;
  isProd: boolean;
  /** Team uploads (presentations, logos): inside DATA_DIR so they live on the persistent volume. */
  uploadsDir: string;
  /** Pre-migration copies of the database. */
  backupDir: string;
  /** Largest accepted presentation, bytes. */
  maxUploadBytes: number;
  /** LibreOffice binary for PPTX → PDF ("" = not available: teams are asked to upload a PDF). */
  soffice: string;
  sofficeTimeoutMs: number;
  teamSessionTtlMs: number;
  /** v11: periodic online backup into backupDir (0 = off). */
  backupIntervalMs: number;
  /** v11: how many periodic (auto-*) backups are kept. */
  backupKeep: number;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const isProd = process.env.NODE_ENV === "production";
  const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
  let sessionSecret = process.env.SESSION_SECRET ?? "";
  if (!sessionSecret) {
    if (isProd) throw new Error("SESSION_SECRET is required in production");
    sessionSecret = randomBytes(32).toString("hex");
  }
  return {
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? "0.0.0.0",
    dataDir,
    dbFile: process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, "ignite.db"),
    assetsDir: path.resolve(process.env.ASSETS_DIR ?? "./assets"),
    webDir: path.resolve(process.env.WEB_DIR ?? "./dist/web"),
    adminUsername: process.env.ADMIN_USERNAME ?? "admin",
    adminPassword: process.env.ADMIN_PASSWORD ?? "",
    sessionSecret,
    sessionTtlMs: 7 * 24 * 3600 * 1000,
    origins,
    // Secure cookies need HTTPS; default on whenever the public origin is https.
    cookieSecure: bool(process.env.COOKIE_SECURE, origins.some(o => o.startsWith("https://"))),
    trustProxy: bool(process.env.TRUST_PROXY, true),
    showJurorTotal: bool(process.env.SHOW_JUROR_TOTAL, false),
    minJurorsForRank: Number(process.env.MIN_JURORS_FOR_RANK ?? 3),
    loginMaxFails: 5,
    loginLockMs: 5 * 60 * 1000,
    isProd,
    uploadsDir: path.join(dataDir, "uploads"),
    backupDir: path.join(dataDir, "backups"),
    maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 50) * 1024 * 1024,
    soffice: process.env.SOFFICE ?? findSoffice(),
    sofficeTimeoutMs: 90_000,
    teamSessionTtlMs: 30 * 24 * 3600 * 1000,
    backupIntervalMs: Math.max(0, Number(process.env.BACKUP_INTERVAL_MIN ?? 10)) * 60_000,
    backupKeep: Math.max(1, Number(process.env.BACKUP_KEEP ?? 48)),
    ...overrides,
  };
}
