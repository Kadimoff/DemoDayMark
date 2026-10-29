// Idempotent first-run setup: event row, admin account, default criteria, placeholder teams.
// Never creates juror accounts — the coordinator adds those from /admin/setup.
import { hash, type Options } from "@node-rs/argon2";
import type { Config } from "./config.js";
import type { Repo } from "./repo.js";

// Ignite Demo Day rubric: points per criterion, 50 in total (entry scores add another 50).
export const DEFAULT_CRITERIA = [
  { key: "teqdimat", name: "Təqdimat qabiliyyəti", maxScore: 5,
    description: "1. Təqdimatçının layihəni, görülən və görüləcək işləri təqdim etmə bacarığı\n2. Verilən suallara dolğun cavab vermə" },
  { key: "komanda", name: "Komandanın qabiliyyəti", maxScore: 10,
    description: "Komanda bu layihəni davamlı inkişaf etdirmək üçün müvafiq bacarıqları göstərir.\nKomandanın gördüyü işlər gələcəkdə görəcəyi işlərə istinad verir" },
  { key: "biznes", name: "Biznes Model", maxScore: 10,
    description: "Layihə dayanıqlı biznes modelə sahibdir, bu onun fəaliyyətinə və investisiya cəlbinə şərait yarada bilər" },
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

export async function ensureBaseline(repo: Repo, cfg: Config, log: (m: string) => void = () => {}) {
  const db = repo.db;
  if (!db.prepare("SELECT 1 FROM event WHERE id = 1").get()) {
    const d = new Date();
    const date = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
    db.prepare("INSERT INTO event (id, name, date, show_juror_total) VALUES (1, ?, ?, ?)")
      .run("Ignite Demo Day", date, +cfg.showJurorTotal);
    log("event row created");
  }
  if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
    if (!cfg.adminPassword) throw new Error("ADMIN_PASSWORD must be set to create the admin account");
    repo.createUser("admin", cfg.adminUsername, "Koordinator", await hashPassword(cfg.adminPassword));
    log(`admin account "${cfg.adminUsername}" created`);
  }
  if (!repo.criteria().length) {
    for (const c of DEFAULT_CRITERIA) repo.addCriterion(c);
    log("default criteria seeded");
  }
  if (!repo.teams().length) {
    for (let i = 1; i <= 8; i++) repo.addTeam(`Komanda ${i}`, "");
    log("placeholder teams seeded");
  }
}
