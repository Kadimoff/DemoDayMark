// A4 protocol in the layout of the reference prototype, drawn with pdfkit and embedded TTFs.
// Manrope has no capital "Ə" (U+018F), so text is split into runs and any glyph a font lacks
// is drawn with Noto Sans of a matching weight.
import * as fontkit from "fontkit";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { Config } from "../config.js";
import type { Repo } from "../repo.js";
import { adminResults } from "../views.js";
import { displayParts, fmt2 } from "../../shared/scoring.js";

type FontName = "b400" | "b500" | "b600" | "b700" | "d500" | "d700" | "m500" | "m700";
const FONT_FILES: Record<FontName, [file: string, fallback: string]> = {
  b400: ["Manrope-400.ttf", "NotoSans-400.ttf"],
  b500: ["Manrope-500.ttf", "NotoSans-400.ttf"],
  b600: ["Manrope-600.ttf", "NotoSans-600.ttf"],
  b700: ["Manrope-700.ttf", "NotoSans-700.ttf"],
  d500: ["Unbounded-500.ttf", "NotoSans-600.ttf"],
  d700: ["Unbounded-700.ttf", "NotoSans-700.ttf"],
  m500: ["JetBrainsMono-500.ttf", "NotoSans-400.ttf"],
  m700: ["JetBrainsMono-700.ttf", "NotoSans-700.ttf"],
};
const C = { ink: "#141722", mute: "#5D6376", line: "#DADEE8", head: "#F2F3F7", acc: "#DD4F18", accText: "#B23C0C", gold: "#B07F06", soft: "#FBE4D9" };
const W = 595.28, H = 841.89, M = 46, CW = W - 2 * M, BOTTOM = H - M - 18;

const coverage = new Map<string, fontkit.Font>();
function glyphFont(dir: string, file: string) {
  let f = coverage.get(file);
  if (!f) { f = fontkit.openSync(path.join(dir, file)); coverage.set(file, f); }
  return f;
}

const fmt1 = (n: number | null | undefined) => (n == null ? "—" : n.toFixed(1));

interface TextOpts { font: FontName; size: number; color?: string; width?: number; align?: "left" | "right" | "center" }

export async function buildPdf(repo: Repo, cfg: Config): Promise<Buffer> {
  const ev = repo.getEvent();
  const { results, jurors, criteria, scores, teams } = adminResults(repo, cfg);
  const fontDir = path.join(cfg.assetsDir, "fonts");

  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true, info: { Title: `${ev.name} — protokol`, Author: "Ignite Demo Day" } });
  for (const [name, [file, fb]] of Object.entries(FONT_FILES)) {
    doc.registerFont(name, path.join(fontDir, file));
    doc.registerFont(name + "_fb", path.join(fontDir, fb));
  }
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>(res => doc.on("end", () => res(Buffer.concat(chunks))));

  // ---------- text primitives ----------
  const runs = (text: string, font: FontName) => {
    const main = glyphFont(fontDir, FONT_FILES[font][0]);
    const out: Array<{ t: string; f: string }> = [];
    for (const ch of text) {
      const f = main.hasGlyphForCodePoint(ch.codePointAt(0)!) || ch === " " ? font : font + "_fb";
      const last = out[out.length - 1];
      if (last && last.f === f) last.t += ch; else out.push({ t: ch, f });
    }
    return out;
  };
  const measure = (text: string, font: FontName, size: number) =>
    runs(text, font).reduce((a, r) => a + doc.font(r.f).fontSize(size).widthOfString(r.t), 0);
  const fit = (text: string, font: FontName, size: number, width: number) => {
    if (measure(text, font, size) <= width) return text;
    let t = text;
    while (t.length && measure(t + "…", font, size) > width) t = t.slice(0, -1);
    return t + "…";
  };
  const text = (s: string | number, x: number, y: number, o: TextOpts) => {
    let str = String(s ?? "");
    if (o.width) str = fit(str, o.font, o.size, o.width);
    const w = measure(str, o.font, o.size);
    let cx = o.align === "right" && o.width ? x + o.width - w : o.align === "center" && o.width ? x + (o.width - w) / 2 : x;
    for (const r of runs(str, o.font)) {
      doc.font(r.f).fontSize(o.size).fillColor(o.color ?? C.ink).text(r.t, cx, y, { lineBreak: false });
      cx += doc.widthOfString(r.t);
    }
  };
  const wrap = (s: string, font: FontName, size: number, width: number) => {
    const lines: string[] = [];
    for (const para of String(s ?? "").split(/\n+/)) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? line + " " + word : word;
        if (!line || measure(next, font, size) <= width) line = next;
        else { lines.push(line); line = word; }
      }
      if (line) lines.push(line);
    }
    return lines;
  };
  const rect = (x: number, y: number, w: number, h: number, color: string) => doc.rect(x, y, w, h).fill(color);

  // ---------- layout ----------
  let y = M;
  const page = () => { doc.addPage({ size: "A4", margin: 0 }); rect(0, 0, W, 5, C.acc); y = M; };
  const need = (h: number) => { if (y + h > BOTTOM) page(); };
  const title = (t: string, sub?: string) => {
    need(sub ? 70 : 50);
    text(t, M, y, { font: "d500", size: 14 });
    if (sub) { text(sub, M, y + 20, { font: "b400", size: 8.5, color: C.mute, width: CW }); y += 38; } else y += 26;
  };
  interface Col { t: string; w: number; a?: "r"; f?: FontName; size?: number; color?: (v: string, i: number) => string | undefined }
  const table = (cols: Col[], rows: string[][], o: { rh?: number; hl?: (i: number) => boolean } = {}) => {
    const rh = o.rh ?? 22, pad = 5;
    const hLines = cols.map(c => wrap(c.t.toLocaleUpperCase("az"), "b700", 6.8, c.w - 2 * pad));
    const hh = Math.max(...hLines.map(l => l.length)) * 9 + 10;
    const head = () => {
      rect(M, y, CW, hh, C.head);
      let x = M;
      cols.forEach((c, i) => {
        hLines[i].forEach((ln, k) => text(ln, x + pad, y + 6 + k * 9, { font: "b700", size: 6.8, color: C.mute, width: c.w - 2 * pad, align: c.a === "r" ? "right" : "left" }));
        x += c.w;
      });
      y += hh;
    };
    need(hh + rh * 2);
    head();
    rows.forEach((r, ri) => {
      if (y + rh > BOTTOM) { page(); head(); }
      if (o.hl?.(ri)) rect(M, y, CW, rh, C.soft);
      let x = M;
      cols.forEach((c, i) => {
        const v = r[i] ?? "";
        const size = c.size ?? 8.6;
        text(v, x + pad, y + (rh - size * 1.25) / 2 + 1, { font: c.f ?? "b500", size, color: c.color?.(v, ri) ?? C.ink, width: c.w - 2 * pad, align: c.a === "r" ? "right" : "left" });
        x += c.w;
      });
      rect(M, y + rh - 0.5, CW, 0.5, C.line);
      y += rh;
    });
    y += 18;
  };

  // ---------- header ----------
  rect(0, 0, W, 5, C.acc);
  text("IGNITE · DEMO DAY PROTOKOLU", M, y, { font: "b700", size: 7.5, color: C.mute });
  text(ev.name, M, y + 14, { font: "d700", size: 21, width: CW });
  text(`${ev.date}  ·  ${teams.filter(t => t.active).length} komanda  ·  ${jurors.filter(j => j.active).length} münsif  ·  ${results.done}/${results.need} qiymət`,
    M, y + 46, { font: "b400", size: 9.5, color: C.mute, width: CW });
  y += 78;

  const D = results.demoMax, E = results.entryMax, T = results.maxTotal, withEntry = results.includeEntry;
  const winner = results.ranking.find(x => x.rank === 1);
  if (winner && winner.score != null) {
    rect(M, y, CW, 58, C.soft);
    rect(M, y, 4, 58, C.acc);
    text("1-Cİ YER", M + 16, y + 12, { font: "b700", size: 7.5, color: C.mute });
    text(winner.team.name, M + 16, y + 26, { font: "d700", size: 15, width: CW - 170 });
    const wp = displayParts(winner.score, withEntry ? winner.entry : null);
    text(wp.score, M, y + 11, { font: "m700", size: 25, width: CW - 16, align: "right" });
    if (withEntry) text(`Giriş ${wp.entry} + Demo Day ${wp.demo}`, M, y + 41, { font: "b500", size: 7.5, color: C.mute, width: CW - 16, align: "right" });
    y += 76;
  }

  title("Yekun reytinq", withEntry
    ? `Yekun = giriş balı (maks. ${E}) + Demo Day balı — münsiflərin orta balı (maks. ${D}); cəmi maks. ${T}`
    : `Yekun = Demo Day balı — münsiflərin orta balı (maks. ${D})`);
  table([
    { t: "Yer", w: 30, f: "d700", size: 10, color: v => (v === "1" ? C.gold : undefined) },
    { t: "Komanda", w: 122, f: "b700" },
    { t: "Layihə", w: 103, color: () => C.mute },
    { t: `Giriş (${E})`, w: 52, a: "r", f: "m500", color: () => (withEntry ? undefined : C.mute) },
    { t: `Demo Day (${D})`, w: 60, a: "r", f: "m500" },
    { t: `Yekun (${T})`, w: 56, a: "r", f: "m700", size: 9.5 },
    { t: "Münsif", w: 38, a: "r", f: "m500" },
    { t: "Min–Max", w: CW - 461, a: "r", f: "m500", size: 7.6, color: () => C.mute },
  ], results.ranking.map(x => [
    x.rank == null ? "–" : String(x.rank),
    x.team.name + (x.incomplete && x.n ? " *" : ""),
    x.team.project || "—",
    ...(x.score == null ? [fmt2(x.entry), "—", "—"]
      : withEntry ? (p => [p.entry, p.demo, p.score])(displayParts(x.score, x.entry))
      : [fmt2(x.entry), fmt2(x.demo), fmt2(x.score)]),
    `${x.n}/${jurors.filter(j => j.active).length}`,
    x.n ? `${x.min}–${x.max}` : "—", // juror totals are whole points
  ]), { rh: 25, hl: i => i === 0 && results.ranking[0]?.rank === 1 });
  if (results.ranking.some(x => x.incomplete && x.n)) {
    text(`* ${cfg.minJurorsForRank}-dən az münsif tərəfindən qiymətləndirilib`, M, y - 12, { font: "b400", size: 7.5, color: C.mute });
    y += 4;
  }

  const byOrder = results.ranking.slice().sort((a, b) => a.team.orderIndex - b.team.orderIndex);
  const jw = Math.floor((CW - 140 - 50) / Math.max(1, jurors.length));
  title("Münsif matrisi", `Hər xana münsifin Demo Day-də verdiyi balların cəmi (maks. ${D})`);
  table([
    { t: "Komanda", w: 140, f: "b600" },
    ...jurors.map(j => ({ t: j.displayName, w: jw, a: "r" as const, f: "m500" as FontName })),
    { t: "Orta", w: CW - 140 - jw * jurors.length, a: "r", f: "m700" },
  ], byOrder.map(x => [x.team.name, ...jurors.map(j => String(results.matrix[x.team.id]?.[j.id] ?? "—")), fmt2(x.demo)]));

  const cw = Math.floor((CW - 120 - 52) / Math.max(1, criteria.length));
  title("Meyarlar üzrə orta bal", "Sütun başlığında meyarın maksimum balı; K1–K" + criteria.length + " kodları cədvəlin altında açıqlanır");
  table([
    { t: "Komanda", w: 120, f: "b600", size: 8.2 },
    ...criteria.map((c, i) => ({ t: `K${i + 1}\nmaks. ${c.maxScore}`, w: cw, a: "r" as const, f: "m500" as FontName, size: 8 })),
    { t: `Demo Day\nmaks. ${D}`, w: CW - 120 - cw * criteria.length, a: "r", f: "m700", size: 8.2 },
  ], results.ranking.map(x => [x.team.name, ...criteria.map(c => fmt1(x.perCriterion[c.key])), fmt2(x.demo)]), { rh: 21 });
  const legend = wrap(criteria.map((c, i) => `K${i + 1} — ${c.name} (maks. ${c.maxScore})`).join("  ·  "), "b400", 7.8, CW);
  y -= 8;
  for (const l of legend) { need(11); text(l, M, y, { font: "b400", size: 7.8, color: C.mute }); y += 11; }
  y += 16;

  // ---------- comments ----------
  const jurorName = new Map(jurors.map(j => [j.id, j.displayName]));
  const notes = byOrder.flatMap(x => scores
    .filter(s => s.teamId === x.team.id && s.note.trim())
    .sort((a, b) => a.jurorId - b.jurorId)
    .map(s => ({ team: x.team.name, juror: jurorName.get(s.jurorId) ?? "?", note: s.note.trim() })));
  if (notes.length) {
    title("Münsiflərin şərhləri");
    let lastTeam = "";
    for (const n of notes) {
      const lines = wrap(n.note, "b400", 8.6, CW - 14);
      need(Math.min(lines.length, 4) * 12.5 + (n.team !== lastTeam ? 40 : 22));
      if (n.team !== lastTeam) { text(n.team, M, y, { font: "b700", size: 10 }); y += 17; lastTeam = n.team; }
      text(n.juror.toLocaleUpperCase("az"), M + 10, y, { font: "b700", size: 6.8, color: C.accText });
      y += 11;
      for (const l of lines) { need(12.5); text(l, M + 10, y, { font: "b400", size: 8.6 }); y += 12.5; }
      y += 7;
    }
    y += 10;
  }

  // ---------- signatures ----------
  const signers = jurors.filter(j => j.active);
  need(40 + Math.ceil(signers.length / 2) * 44);
  title("Münsiflərin imzası");
  signers.forEach((j, i) => {
    const x = M + (i % 2) * (CW / 2 + 10), yy = y + Math.floor(i / 2) * 44;
    rect(x, yy + 20, CW / 2 - 20, 1, C.line);
    text(j.displayName, x, yy + 26, { font: "b600", size: 8.6 });
  });

  // ---------- footer on every page ----------
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    text(`${ev.name} · ${ev.date}`, M, H - 30, { font: "b500", size: 7, color: C.mute, width: CW - 60 });
    text(`${i + 1}/${range.count}`, M, H - 30, { font: "b500", size: 7, color: C.mute, width: CW, align: "right" });
  }
  doc.end();
  return done;
}
