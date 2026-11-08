// v4: printable QR cards (A4, 6 per page, cut lines) for team sign-in links and juror QR invites.
// Noto Sans covers every Azerbaijani letter (Ə ə Ğ ğ İ ı Ö ö Ş ş Ü ü Ç ç); the QR is drawn as vector squares.
import path from "node:path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";

export interface QrCard { title: string; subtitle?: string; url: string; code?: string; note?: string }

const W = 595.28, H = 841.89, M = 28;
const COLS = 2, ROWS = 3;
const CW = (W - 2 * M) / COLS, CH = (H - 2 * M - 30) / ROWS;

export async function buildQrCardsPdf(cards: QrCard[], opts: { heading: string; fontDir: string }): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: opts.heading, Author: "munsif.im" } });
  doc.registerFont("r", path.join(opts.fontDir, "NotoSans-400.ttf"));
  doc.registerFont("b", path.join(opts.fontDir, "NotoSans-700.ttf"));
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>(res => doc.on("end", () => res(Buffer.concat(chunks))));
  const perPage = COLS * ROWS;
  const pages = Math.max(1, Math.ceil(cards.length / perPage));
  for (let p = 0; p < pages; p++) {
    if (p) doc.addPage({ size: "A4", margin: 0 });
    doc.font("b").fontSize(11).fillColor("#141722").text(opts.heading, M, M - 4, { width: W - 2 * M - 80, lineBreak: false, ellipsis: true });
    doc.font("r").fontSize(9).fillColor("#5D6376").text(`${p + 1} / ${pages}`, W - M - 80, M - 2, { width: 80, align: "right" });
    const top = M + 22;
    // cut lines
    doc.save().lineWidth(0.6).dash(4, { space: 4 }).strokeColor("#B8BDCB");
    for (let c = 1; c < COLS; c++) doc.moveTo(M + c * CW, top).lineTo(M + c * CW, top + ROWS * CH).stroke();
    for (let r = 0; r <= ROWS; r++) doc.moveTo(M, top + r * CH).lineTo(W - M, top + r * CH).stroke();
    doc.restore().undash();
    cards.slice(p * perPage, (p + 1) * perPage).forEach((card, i) => {
      const x = M + (i % COLS) * CW, y = top + Math.floor(i / COLS) * CH;
      const pad = 14, w = CW - 2 * pad;
      doc.font("b").fontSize(15).fillColor("#141722").text(card.title, x + pad, y + pad, { width: w, align: "center", lineBreak: false, ellipsis: true });
      if (card.subtitle) doc.font("r").fontSize(9).fillColor("#5D6376").text(card.subtitle, x + pad, y + pad + 20, { width: w, align: "center", lineBreak: false, ellipsis: true });
      const qr = QRCode.create(card.url, { errorCorrectionLevel: "M" });
      const n = qr.modules.size;
      const size = Math.min(150, CH - 112);
      const cell = size / (n + 2);
      const qx = x + (CW - size) / 2, qy = y + pad + 38;
      doc.rect(qx, qy, size, size).fill("#FFFFFF");
      doc.fillColor("#0B0F19");
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) doc.rect(qx + (c + 1) * cell, qy + (r + 1) * cell, cell + 0.15, cell + 0.15).fill();
      let ty = qy + size + 8;
      const short = card.url.replace(/^https?:\/\//, "");
      doc.font("r").fontSize(8.5).fillColor("#141722").text(short, x + pad, ty, { width: w, align: "center" });
      ty = doc.y + 3;
      if (card.code) { doc.font("b").fontSize(12).fillColor("#B23C0C").text(card.code, x + pad, ty, { width: w, align: "center", characterSpacing: 1 }); ty = doc.y + 2; }
      if (card.note) doc.font("r").fontSize(8).fillColor("#5D6376").text(card.note, x + pad, ty, { width: w, align: "center" });
    });
  }
  doc.end();
  return done;
}
