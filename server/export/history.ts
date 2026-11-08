// v3: scoring history as Excel — who changed what and when: one row per criterion of every submit / change
// (old → new), plus markers for wipes and deletions. Built from score_history of ONE event of ONE organisation.
import ExcelJS from "exceljs";
import type { Repo } from "../repo.js";
import type { HistoryRow } from "../../shared/types.js";

const KIND: Record<string, string> = { submit: "Göndərildi", update: "Dəyişdirildi", wipe: "Bütün ballar silindi", "team.delete": "Komanda silindi", "juror.delete": "Münsif silindi" };
const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Every history row of the repo's event, oldest first. */
export function allHistory(repo: Repo): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (let before: number | undefined, more = true; more;) {
    const pg = repo.history({ before, limit: 500 });
    rows.push(...pg.rows); more = pg.more; before = pg.rows.at(-1)?.id;
  }
  return rows.reverse();
}

export async function buildHistoryXlsx(repo: Repo): Promise<Buffer> {
  const ev = repo.getEvent();
  const wb = new ExcelJS.Workbook();
  wb.creator = ev.displayName;
  wb.created = new Date();
  const ws = wb.addWorksheet("Qiymətləndirmə tarixçəsi");
  ws.addRow(["Vaxt", "Münsif", "Komanda", "Hadisə", "Meyar", "Köhnə bal", "Yeni bal", "Maks.", "Köhnə cəmi", "Yeni cəmi", "Şərh", "Sürətli rəylər"]);
  for (const h of allHistory(repo)) {
    const base = [fmtTime(h.at), h.jurorName, h.teamName, KIND[h.kind] ?? h.kind];
    if (h.kind !== "submit" && h.kind !== "update") {
      ws.addRow([...base, `${h.count ?? 0} qiymət silindi${h.actorName ? ` (${h.actorName})` : ""}`, null, null, null, null, null, "", ""]);
      continue;
    }
    // A change lists only the criteria that changed; a first submit lists every criterion (old = empty).
    const vals = h.kind === "update" ? h.values.filter(v => v.prev != null) : h.values;
    const list = vals.length ? vals : [{ key: "", name: h.kind === "update" ? "(ballar dəyişməyib — şərh / rəy)" : "", max: null, v: null as unknown as number }];
    list.forEach((v, i) => {
      ws.addRow([...base, v.name, v.prev ?? null, v.v ?? null, v.max ?? null,
        i === 0 ? h.prevTotal : null, i === 0 ? h.total : null,
        i === 0 ? (h.prevNote != null ? `${h.prevNote} → ${h.note}` : h.note) : "", i === 0 ? h.tags.join(", ") : ""]);
    });
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F3F7" } };
  [20, 22, 22, 16, 30, 11, 10, 8, 12, 11, 50, 30].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.getColumn(11).alignment = { wrapText: true, vertical: "top" };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 12 } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
