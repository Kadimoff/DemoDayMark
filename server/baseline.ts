// Idempotent first-run setup: event row, admin account, default criteria, placeholder teams.
// Never creates juror accounts — the coordinator adds those from /admin/setup.
import { hash, type Options } from "@node-rs/argon2";
import type { Config } from "./config.js";
import type { Repo } from "./repo.js";

export const DEFAULT_CRITERIA = [
  { key: "problem", name: "Problem", weight: 15, description: "Problem real və aktualdırmı? Kimin problemidir və nə qədər ağrılıdır?" },
  { key: "solution", name: "Həll və dəyər təklifi", weight: 15, description: "Həll problemi birbaşa aradan qaldırırmı? Alternativlərdən nə ilə fərqlənir?" },
  { key: "mvp", name: "MVP / Demo", weight: 20, description: "Məhsul işləyirmi? Demo inandırıcıdırmı, texniki icra hansı səviyyədədir?" },
  { key: "market", name: "Bazar və rəqabət", weight: 10, description: "Hədəf seqment və bazar həcmi aydındırmı? Rəqiblər bilinirmi?" },
  { key: "biz", name: "Biznes model", weight: 10, description: "Necə gəlir əldə edəcək? Qiymət, satış kanalları məntiqlidirmi?" },
  { key: "traction", name: "Validasiya və traction", weight: 10, description: "İstifadəçi, pilot, müştəri müsahibəsi, niyyət məktubu — sübut varmı?" },
  { key: "team", name: "Komanda", weight: 10, description: "Komanda bu işi həyata keçirə bilərmi? Bacarıqlar tamamlayırmı?" },
  { key: "pitch", name: "Təqdimat və sual-cavab", weight: 10, description: "Vaxta sığdımı, aydın idimi? Suallara dəqiq və inamlı cavab verdimi?" },
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
