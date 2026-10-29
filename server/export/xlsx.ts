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

  const D = results.demoMax, E = results.entryMax, T = results.maxTotal;
  const withEntry = results.includeEntry;
  const critHead = (c: { name: string; maxScore: number }) => `${c.name} (maks. ${c.maxScore})`;

  // 1. Reytinq
  const s1 = wb.addWorksheet("Reytinq");
  s1.addRow(["Yer", "Komanda", "Layihə", `Yekun (${T})`, `Giriş balı (${E})`, `Demo Day (${D})`, "Münsif sayı", "Min (Demo)", "Max (Demo)",
    ...criteria.map(critHead), "Qeyd"]);
  for (const x of results.ranking) {
    s1.addRow([x.rank ?? "—", x.team.name, x.team.project, x.score, x.entry, x.demo, x.n, x.min, x.max,
      ...criteria.map(c => x.perCriterion[c.key]),
      [x.incomplete ? `eksik (<${cfg.minJurorsForRank} münsif)` : "", withEntry && x.entry == null ? "giriş balı yoxdur (0 sayılır)" : ""].filter(Boolean).join("; ")]);
  }
  styleSheet(s1, 1, [6, 26, 30, 12, 14, 14, 12, 11, 11, ...criteria.map(() => 18), 26]);
  [4, 5, 6, 8, 9, ...criteria.map((_, i) => 10 + i)].forEach(c => { s1.getColumn(c).numFmt = num; });

  // 2. Münsif matrisi (Demo Day: each juror's total)
  const s2 = wb.addWorksheet("Münsif matrisi");
  s2.addRow(["Komanda", ...jurors.map(j => `${j.displayName} (${D})`), `Demo Day orta (${D})`]);
  for (const x of results.ranking.slice().sort((a, b) => a.team.orderIndex - b.team.orderIndex)) {
    s2.addRow([x.team.name, ...jurors.map(j => results.matrix[x.team.id]?.[j.id] ?? null), x.demo]);
  }
  styleSheet(s2, 1, [26, ...jurors.map(() => 16), 16]);
  for (let c = 2; c <= jurors.length + 2; c++) s2.getColumn(c).numFmt = num;

  // 3. Bütün qiymətlər
  const s3 = wb.addWorksheet("Bütün qiymətlər");
  s3.addRow(["Münsif", "Komanda", ...criteria.map(critHead), `Cəmi (${D})`, "Şərh", "Vaxt"]);
  const teamName = new Map(teams.map(t => [t.id, t.name]));
  const jurorName = new Map(jurors.map(j => [j.id, j.displayName]));
  for (const s of scores) {
    s3.addRow([jurorName.get(s.jurorId) ?? "?", teamName.get(s.teamId) ?? "?", ...criteria.map(c => s.values[c.key] ?? null),
      s.total, s.note, fmtTime(s.updatedAt)]);
  }
  styleSheet(s3, 1, [22, 24, ...criteria.map(() => 14), 12, 60, 18]);
  s3.getColumn(criteria.length + 4).alignment = { wrapText: true, vertical: "top" };

  // 4. Meyarlar və formula
  const s4 = wb.addWorksheet("Meyarlar");
  s4.addRow(["Meyar", "İzah", "Maksimum bal"]);
  for (const c of criteria) s4.addRow([c.name, c.description, c.maxScore]);
  s4.addRow(["Cəmi", "", D]);
  s4.addRow([]);
  s4.addRow(["Formula", `Münsifin balı = meyarlar üzrə verdiyi balların cəmi (hər meyar 1-dən maksimuma qədər, cəmi maks. ${D}).`]);
  s4.addRow(["", `Demo Day balı = komandanı tam qiymətləndirmiş münsiflərin ballarının orta qiyməti (maks. ${D}).`]);
  s4.addRow(["", withEntry
    ? `Yekun bal = Giriş balı (maks. ${E}) + Demo Day balı (maks. ${D}) = maks. ${T}.`
    : `Yekun bal = Demo Day balı (giriş balı yekuna daxil edilmir).`]);
  s4.addRow(["", `Bərabərlikdə əvvəlcə Demo Day balı, sonra meyarların orta balı həlledicidir (${results.tieBreakKeys.map(k => criteria.find(c => c.key === k)?.name).join(" → ")}).`]);
  s4.addRow([]);
  s4.addRow(["Tədbir", `${ev.name} · ${ev.date}`]);
  styleSheet(s4, 1, [28, 90, 14]);
  s4.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
