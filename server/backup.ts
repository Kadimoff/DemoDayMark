// Manual backup — consistent, timestamped copy of the SQLite database (safe while the server runs):
//   npm run backup            (dev, tsx)
//   node dist-server/server/backup.js   (production image / container shell)
import Database from "better-sqlite3";
import fs from "node:fs";
import { onlineBackup } from "./backups.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
if (!fs.existsSync(cfg.dbFile)) {
  console.error(`Baza tapılmadı: ${cfg.dbFile}`);
  process.exit(1);
}
const db = new Database(cfg.dbFile, { readonly: true });
db.pragma("busy_timeout = 5000");
const r = await onlineBackup(db, cfg.backupDir, "manual");
db.close();
console.log(`Yedək yaradıldı: ${r.file} (${Math.round(r.bytes / 1024)} KB, yoxlanıldı)`);
