// Restore the database from a backup.
//   node dist-server/server/restore.js --list               backups, newest first
//   node dist-server/server/restore.js <file>               restore on the next server start (safe while it runs; then restart)
//   node dist-server/server/restore.js <file> --now         restore right away (the server must be stopped)
// <file> is a path or a name inside DATA_DIR/backups. The current database is always kept as backups/pre-restore-*.db.
import fs from "node:fs";
import path from "node:path";
import { listBackups, RESTORE_REQUEST, restoreNow, verifyDbFile } from "./backups.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig();
const args = process.argv.slice(2);
if (!args.length || args.includes("--list")) {
  const all = listBackups(cfg.backupDir);
  if (!all.length) console.log(`Yedək yoxdur: ${cfg.backupDir}`);
  for (const b of all) console.log(`${new Date(b.at).toISOString()}  ${String(Math.round(b.bytes / 1024)).padStart(7)} KB  ${b.name}`);
  if (!args.length) console.log("\nİstifadə: restore.js <fayl> [--now]");
  process.exit(0);
}
const name = args.find(a => !a.startsWith("--"))!;
const file = fs.existsSync(name) ? path.resolve(name) : path.join(cfg.backupDir, name);
const check = verifyDbFile(file);
if (!check.ok) { console.error(`Yedək yararsızdır: ${check.error}`); process.exit(1); }
if (args.includes("--now")) {
  const r = restoreNow(cfg.dbFile, file, cfg.backupDir);
  console.log(`Bərpa olundu: ${path.basename(file)} → ${cfg.dbFile} (sxem v${r.version}). Əvvəlki baza: ${r.previous ?? "—"}`);
} else {
  fs.writeFileSync(path.join(cfg.dataDir, RESTORE_REQUEST), JSON.stringify({ file, requestedAt: Date.now() }));
  console.log(`Bərpa sorğusu yazıldı: ${path.basename(file)} (sxem v${check.version}). Serveri yenidən başladın — start zamanı tətbiq olunacaq.`);
}
