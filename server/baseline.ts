// Idempotent first-run setup: event row, admin (root) account, default criteria, placeholder teams.
// Never creates juror accounts — the coordinator adds those from /admin/setup.
import { hash, type Options } from "@node-rs/argon2";
import type { Config } from "./config.js";
import { brandName } from "../shared/brand.js";
import type { DB } from "./db.js";
import { Repo } from "./repo.js";

// Default hackathon rubric: points per criterion, 50 in total. Entry scores are off by default.
export const DEFAULT_CRITERIA = [
  { key: "teqdimat", name: "Təqdimat qabiliyyəti", maxScore: 5,
    description: "1. Təqdimatçının layihəni, görülən və görüləcək işləri təqdim etmə bacarığı\n2. Verilən suallara dolğun cavab vermə" },
  { key: "komanda", name: "Komandanın qabiliyyəti", maxScore: 10,
    description: "Komanda bu layihəni davamlı inkişaf etdirmək üçün müvafiq bacarıqları göstərir.\nKomandanın gördüyü işlər gələcəkdə görəcəyi işlərə istinad verir" },
  { key: "ai", name: "Süni intellektdən istifadə", maxScore: 10,
    description: "Komanda süni intellektdən məhsulda və ya iş prosesində məqsədəuyğun və yaradıcı istifadə edir.\nAI həllin dəyərini artırır, sadəcə bəzək deyil" },
  { key: "mehsul_bazar", name: "Məhsul-Bazar uyğunluğu", maxScore: 10,
    description: "Layihə yerli və ya qlobal bazarda olan kritik bir problemi həll edir" },
  { key: "bazar", name: "Bazar", maxScore: 10,
    description: "Layihənin çıxış etdiyi bazar yerli və/və ya qlobal arenada böyük potensiala və həcmə malikdir.\nLayihə xarici ölkələrə də açıla bilər" },
  { key: "tesir", name: "Təsir qabiliyyəti", maxScore: 5,
    description: "Layihə yerli və qlobal bazarda iz qoyma və inkişaf imkanına malikdir" },
];

// argon2id, OWASP-recommended parameters.
// Algorithm 2 = Argon2id (the package exports it as a const enum).
export const ARGON: Options = { algorithm: 2 as Options["algorithm"], memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashPassword = (pw: string) => hash(pw, ARGON);

export function todayDate() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

/**
 * orgs: the event row (brand prefix `name`), the active event (v3 `events`) and the default rubric of an organisation,
 * if missing. Idempotent. Returns the organisation's repo bound to its active event.
 */
export function seedOrgEvent(db: DB, orgId: number, orgSlug: string, cfg: Config, name: string, log: (m: string) => void = () => {}): Repo {
  if (!db.prepare("SELECT 1 FROM event WHERE org_id = ?").get(orgId)) {
    // org 1 keeps the historical event id 1; other organisations get the next free id
    db.prepare("INSERT INTO event (id, org_id, name, date, show_juror_total, include_entry) VALUES (?, ?, ?, ?, ?, 0)")
      .run(orgId === 1 ? 1 : null, orgId, name, todayDate(), +cfg.showJurorTotal);
    log(`event row created (org ${orgId})`);
  }
  if (!db.prepare("SELECT 1 FROM events WHERE org_id = ? AND status = 'active'").get(orgId)) {
    const ev = db.prepare("SELECT id, name, product FROM event WHERE org_id = ?").get(orgId) as { id: number; name: string; product: string };
    const free = !db.prepare("SELECT 1 FROM events WHERE id = ?").get(ev.id);
    db.prepare("INSERT INTO events (id, org_id, name, status, created_at) VALUES (?, ?, ?, 'active', ?)").run(free ? ev.id : null, orgId, brandName(ev.name, ev.product), Date.now());
    log(`active event created (org ${orgId})`);
  }
  const repo = new Repo(db, orgId, orgSlug);
  if (!repo.criteria().length) {
    for (const c of DEFAULT_CRITERIA) repo.addCriterion(c);
    log(`default criteria seeded (org ${orgId})`);
  }
  return repo;
}

/** Default organisation (org 1, the platform owner's): event row, root account, rubric, placeholder teams. */
export async function ensureBaseline(db: DB, cfg: Config, log: (m: string) => void = () => {}) {
  const repo = seedOrgEvent(db, 1, "root", cfg, "", log); // brand prefix, filled in from Setup
  if (!db.prepare("SELECT 1 FROM users WHERE is_root = 1").get()) {
    if (!cfg.adminPassword) throw new Error("ADMIN_PASSWORD must be set to create the admin account");
    if (repo.userByUsername(cfg.adminUsername)) throw new Error(`ADMIN_USERNAME "${cfg.adminUsername}" is already used by another account`);
    repo.createUser("admin", cfg.adminUsername, "Koordinator", await hashPassword(cfg.adminPassword), { isRoot: true });
    log(`admin account "${cfg.adminUsername}" created`);
  }
  // Placeholders only for a brand-new database (never into a later, deliberately empty event).
  if (!db.prepare("SELECT 1 FROM teams WHERE org_id = 1").get() && (db.prepare("SELECT COUNT(*) n FROM events WHERE org_id = 1").get() as { n: number }).n === 1) {
    for (let i = 1; i <= 8; i++) repo.addTeam(`Komanda ${i}`, "");
    log("placeholder teams seeded");
  }
}
