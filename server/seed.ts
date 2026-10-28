// npm run seed — creates the admin account, default criteria and "Komanda 1–8" placeholders.
// Safe to run repeatedly: existing data is left untouched.
import { ensureBaseline } from "./baseline.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { Repo } from "./repo.js";

const cfg = loadConfig();
const db = openDb(cfg.dbFile);
await ensureBaseline(new Repo(db), cfg, m => console.log("·", m));
const count = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
console.log(`Baza: ${cfg.dbFile}`);
console.log(`Komandalar: ${count("teams")} · Kriteriyalar: ${count("criteria")} · Münsiflər: ${count("users") - 1}`);
db.close();
