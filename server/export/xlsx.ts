import ExcelJS from "exceljs";
import type { Config } from "../config.js";
import type { Repo } from "../repo.js";
import { adminResults } from "../views.js";

export function exportFileName(date: string, suffix: string) {
  const d = date.trim().replace(/[^0-9A-Za-z.-]+/g, "-").replace(/^-|-$/g, "") || new Date().toISOString().slice(0, 10);
  return `Ignite_DemoDay_${d}_${suffix}`;
}

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function styleSheet(ws: ExcelJS.Worksheet, headerRow: number, widths: number[]) {
  ws.views = [{ state: "frozen", ySplit: headerRow }];
  const h = ws.getRow(headerRow);
  h.font = { bold: true };
  h.alignment = { vertical: "middle", wrapText: true };
  h.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F3F7" } };
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

export async function buildXlsx(repo: Repo, cfg: Config): Promise<Buffer> {
  const ev = repo.getEvent();
  const { results, jurors, criteria, teams, scores } = adminResults(repo, cfg);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ignite Demo Day";
  wb.created = new Date();
  const num = "0.00";

  // 1. Reytinq
  const s1 = wb.addWorksheet("Reytinq");
  s1.addRow(["Yer", "Komanda", "Layihə", "Orta bal (100)", "Münsif sayı", "Min", "Max", ...criteria.map(c => `${c.name} (${c.weight}%)`), "Qeyd"]);
  for (const x of results.ranking) {
    s1.addRow([x.rank ?? "—", x.team.name, x.team.project, x.avg, x.n, x.min, x.max,
      ...criteria.map(c => x.perCriterion[c.key]), x.incomplete ? `eksik (<${cfg.minJurorsForRank} münsif)` : ""]);
  }
  styleSheet(s1, 1, [6, 26, 30, 14, 12, 9, 9, ...criteria.map(() => 16), 20]);
  [4, 6, 7, ...criteria.map((_, i) => 8 + i)].forEach(c => { s1.getColumn(c).numFmt = num; });

  // 2. Münsif matrisi
  const s2 = wb.addWorksheet("Münsif matrisi");
  s2.addRow(["Komanda", ...jurors.map(j => j.displayName), "Orta"]);
  for (const x of results.ranking.slice().sort((a, b) => a.team.orderIndex - b.team.orderIndex)) {
    s2.addRow([x.team.name, ...jurors.map(j => results.matrix[x.team.id]?.[j.id] ?? null), x.avg]);
  }
  styleSheet(s2, 1, [26, ...jurors.map(() => 16), 10]);
  for (let c = 2; c <= jurors.length + 2; c++) s2.getColumn(c).numFmt = num;

  // 3. Bütün qiymətlər
  const s3 = wb.addWorksheet("Bütün qiymətlər");
  s3.addRow(["Münsif", "Komanda", ...criteria.map(c => c.name), "Yekun (100)", "Şərh", "Vaxt"]);
  const teamName = new Map(teams.map(t => [t.id, t.name]));
  const jurorName = new Map(jurors.map(j => [j.id, j.displayName]));
  for (const s of scores) {
    s3.addRow([jurorName.get(s.jurorId) ?? "?", teamName.get(s.teamId) ?? "?", ...criteria.map(c => s.values[c.key] ?? null),
      s.total, s.note, fmtTime(s.updatedAt)]);
  }
  styleSheet(s3, 1, [22, 24, ...criteria.map(() => 12), 12, 60, 18]);
  s3.getColumn(criteria.length + 3).numFmt = num;
  s3.getColumn(criteria.length + 4).alignment = { wrapText: true, vertical: "top" };

  // 4. Kriteriyalar
  const s4 = wb.addWorksheet("Kriteriyalar");
  s4.addRow(["Kriteriya", "İzah", "Çəki %"]);
  for (const c of criteria) s4.addRow([c.name, c.description, c.weight]);
  s4.addRow([]);
  s4.addRow(["Formula", "Hər kriteriya 1–10. Münsifin yekun balı = Σ(bal × çəki) / Σ çəki × 10 (100 üzərindən)."]);
  s4.addRow(["", "Komandanın balı = komandanı tam qiymətləndirmiş münsiflərin yekun ballarının orta qiyməti."]);
  s4.addRow(["", `Bərabərlikdə ən yüksək çəkili kriteriyanın orta balı həlledicidir (${results.tieBreakKeys.map(k => criteria.find(c => c.key === k)?.name).join(" → ")}).`]);
  s4.addRow([]);
  s4.addRow(["Tədbir", `${ev.name} · ${ev.date}`]);
  styleSheet(s4, 1, [28, 90, 9]);
  s4.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
