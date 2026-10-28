import "dotenv/config";
import { randomBytes } from "node:crypto";
import path from "node:path";

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
    ...overrides,
  };
}
