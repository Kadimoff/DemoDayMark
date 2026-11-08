// v11: "Sistem vəziyyəti" card of the platform panel (/root): database, backups, connections, event loop, version.
import { esc, hhmm, icon } from "./dom";

export interface SystemStatus {
  ok: boolean; version: string; commit: string; schema: number; uptimeSec: number; node: string;
  db: { ok: boolean; integrity: string; pingMs: number };
  backup: { enabled: boolean; lastAt: number | null; ageSec: number | null; ok: boolean };
  backupDetail: { intervalMin: number; keep: number; count: number; lastError: string | null };
  sockets: number; eventLoopLagMs: { p50: number; p99: number; max: number };
  memoryMb: { rss: number; heapUsed: number }; dbBytes: number; walBytes: number; warnings: string[];
  orgs?: Array<{ id: number; name: string; screens: number; jurors: number; admins: number; ops: { applied: number; rejected: number; retries: number } }>;
}

const WARN: Record<string, string> = {
  "db-integrity": "Baza yoxlamasında xəta var — runbook-a baxın",
  "backup-failed": "Son yedək alınmadı",
  "backup-old": "Yedək köhnədir",
  "event-loop-lag": "Server gecikir",
};
const dur = (s: number) => (s < 90 ? `${s} san` : s < 5400 ? `${Math.round(s / 60)} dəq` : `${Math.round(s / 3600)} saat`);
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

export function sysCardHtml(s: SystemStatus | null, err: string | null): string {
  if (!s) return `<section class="card pad-lg section-gap sys" id="sys"><h2>${icon("db")}Sistem vəziyyəti</h2><p class="sub">${esc(err ?? "Yüklənir…")}</p></section>`;
  const good = s.ok && !s.warnings.length;
  const cell = (k: string, v: string, bad = false) => `<div${bad ? ` class="bad"` : ""}><span>${k}</span><b>${v}</b></div>`;
  return `<section class="card pad-lg section-gap sys" id="sys" aria-labelledby="h-sys">
    <div class="oh"><h2 id="h-sys">${icon("db")}Sistem vəziyyəti</h2>
      <div class="row" style="gap:6px"><span class="pill ${good ? "ok" : "warn"}">${good ? "Qaydasındadır" : "Diqqət"}</span>
      <button class="btn sm" id="sysBackup">${icon("db")}İndi yedəklə</button></div></div>
    ${s.warnings.length ? `<p class="err-t" role="alert">${s.warnings.map(w => esc(WARN[w] ?? w)).join(" · ")}</p>` : ""}
    <div class="sysgrid">
      ${cell("Baza", s.db.ok ? (s.db.integrity === "ok" ? "OK" : "Xəta") : "Əlçatmaz", !s.db.ok || s.db.integrity !== "ok")}
      ${cell("Son yedək", s.backup.lastAt ? `${hhmm(s.backup.lastAt)} · ${dur(s.backup.ageSec ?? 0)} əvvəl` : s.backup.enabled ? "hələ yoxdur" : "söndürülüb", !s.backup.ok)}
      ${cell("Yedəklər", `${s.backupDetail.count} / ${s.backupDetail.keep} · hər ${s.backupDetail.intervalMin} dəq`)}
      ${cell("Bağlantılar", String(s.sockets))}
      ${cell("Gecikmə (p99)", `${s.eventLoopLagMs.p99} ms`, s.eventLoopLagMs.p99 > 200)}
      ${cell("İşləyir", dur(s.uptimeSec))}
      ${cell("Yaddaş", `${s.memoryMb.rss} MB`)}
      ${cell("Baza ölçüsü", `${mb(s.dbBytes)}${s.walBytes ? ` + WAL ${mb(s.walBytes)}` : ""}`)}
      ${cell("Versiya", `${esc(s.version)} · ${esc(s.commit)} · v${s.schema}`)}
    </div>
    ${s.orgs?.length ? `<table class="systab"><thead><tr><th>Təşkilat</th><th>Ekran</th><th>Münsif</th><th>Bal: saxlanıldı / rədd / təkrar</th></tr></thead>
      <tbody>${s.orgs.map(o => `<tr><td>${esc(o.name)}</td><td>${o.screens}</td><td>${o.jurors}</td><td class="mono">${o.ops.applied} / ${o.ops.rejected} / ${o.ops.retries}</td></tr>`).join("")}</tbody></table>` : ""}
  </section>`;
}
