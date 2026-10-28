// npm run backup — consistent, timestamped copy of the SQLite database (safe while the server runs).
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
if (!fs.existsSync(cfg.dbFile)) {
  console.error(`Baza tapılmadı: ${cfg.dbFile}`);
  process.exit(1);
}
const dir = path.join(cfg.dataDir, "backups");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const target = path.join(dir, `ignite-${stamp}.db`);
const db = new Database(cfg.dbFile, { readonly: true });
await db.backup(target);
db.close();
console.log(`Yedək yaradıldı: ${target}`);
