// munsif: team uploads. Files go to DATA_DIR/uploads (persistent volume) under random names, mode 0600,
// after a size limit, an extension allow-list and a magic-byte check. PDFs are parsed (page count) with pdf.js;
// PPTX is converted to PDF by LibreOffice when the server has it (one at a time, 90 s timeout).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

export type UploadKind = "presentation" | "logo";
export const KINDS: Record<UploadKind, { exts: string[]; label: string; maxMb?: number }> = {
  presentation: { exts: ["pdf", "pptx"], label: "Prezentasiya" },
  logo: { exts: ["png", "jpg", "jpeg", "webp"], label: "Loqo", maxMb: 5 },
};
export const MIME: Record<string, string> = {
  pdf: "application/pdf", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
};

export class UploadError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** Does the start of the file match its extension? */
export function sniff(head: Buffer, ext: string): boolean {
  const h = head.subarray(0, 16);
  if (ext === "pdf") return head.subarray(0, 1024).toString("latin1").includes("%PDF-");
  if (ext === "png") return h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === "jpg" || ext === "jpeg") return h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff;
  if (ext === "webp") return h.subarray(0, 4).toString("latin1") === "RIFF" && h.subarray(8, 12).toString("latin1") === "WEBP";
  if (ext === "pptx") return h[0] === 0x50 && h[1] === 0x4b && h[2] === 0x03 && h[3] === 0x04;
  return false;
}

/** Stored names are ours only: kind prefix + 32 random hex chars. Anything else is never opened. */
export const STORED_RE = /^(pres|logo)-[a-f0-9]{32}\.(pdf|pptx|png|jpg|webp)$/;
export const storedPath = (dir: string, name: string) => {
  if (!STORED_RE.test(name)) throw new UploadError(404, "Fayl tapılmadı.");
  return path.join(dir, name);
};

let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs") | null = null;

// v3 reliability: parsing a big PDF with pdf.js takes the CPU for a while; done on the main thread it would hold up every
// socket (timer, slides) meanwhile. It runs in one worker thread instead (falls back to the main thread if that fails).
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
let lib = null;
parentPort.on("message", async ({ id, file }) => {
  try {
    lib = lib || await import(workerData.pdfjs);
    const data = new Uint8Array(await fs.promises.readFile(file));
    const task = lib.getDocument({ data, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    const doc = await task.promise;
    const n = doc.numPages;
    await task.destroy().catch(() => {});
    parentPort.postMessage({ id, n });
  } catch (e) { parentPort.postMessage({ id, n: null }); }
});`;
let worker: Worker | null = null;
let workerBroken = false;
const pending = new Map<number, { done: (n: number | null) => void; file: string; timer: NodeJS.Timeout }>();
let seq = 0;
function pdfWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    const pdfjsUrl = pathToFileURL(createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.mjs")).href;
    const w = new Worker(WORKER_SRC, { eval: true, workerData: { pdfjs: pdfjsUrl } });
    worker = w;
    w.unref();
    w.on("message", (m: { id: number; n: number | null }) => { pending.get(m.id)?.done(m.n); pending.delete(m.id); });
    w.on("error", () => { workerBroken = true; worker = null; for (const p of pending.values()) p.done(undefined as unknown as null); pending.clear(); });
    // a worker terminated after a timeout exits later: it must not drop the fresh one that replaced it
    w.on("exit", () => { if (worker === w) worker = null; });
    return w;
  } catch { workerBroken = true; return null; }
}

/** Page count, or null when pdf.js cannot open the file (parsed off the main thread). */
export async function pdfPages(file: string): Promise<number | null> {
  const w = pdfWorker();
  if (w) {
    const id = ++seq;
    const n = await new Promise<number | null | undefined>(res => {
      // A PDF that keeps the worker busy for a minute is treated as unreadable. Falling back to the main thread here
      // used to parse that same file with no time limit there, freezing every socket (scores, stage) meanwhile.
      const t = setTimeout(() => {
        pending.delete(id);
        console.warn("munsif.im: PDF page count took over 60 s — file rejected, worker restarted");
        if (worker === w) worker = null;
        // files queued behind the stuck one go to a fresh worker instead of being lost with this one
        const queued = [...pending.values()];
        pending.clear();
        void w.terminate();
        for (const q of queued) { clearTimeout(q.timer); void pdfPages(q.file).then(q.done); }
        res(null);
      }, 60_000);
      t.unref();
      pending.set(id, { done: v => { clearTimeout(t); res(v); }, file, timer: t });
      w.postMessage({ id, file });
    });
    if (n !== undefined) return n;
  }
  return pdfPagesHere(file);
}

async function pdfPagesHere(file: string): Promise<number | null> {
  try {
    pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(await fs.promises.readFile(file));
    const task = pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    const doc = await task.promise;
    const n = doc.numPages;
    await task.destroy().catch(() => {});
    return n;
  } catch { return null; }
}

/** Streams the request body to the uploads folder with a hard size limit and validates it. */
export async function receiveUpload(stream: Readable, opts: { dir: string; kind: UploadKind; origName: string; maxBytes: number; declared?: number }) {
  const spec = KINDS[opts.kind];
  if (!spec) throw new UploadError(400, "Yanlış fayl növü.");
  const ext = (path.extname(opts.origName).slice(1) || "").toLowerCase();
  if (!spec.exts.includes(ext)) throw new UploadError(415, `${spec.label}: yalnız ${spec.exts.filter(e => e !== "jpeg").map(e => e.toUpperCase()).join(", ")} faylı yükləyin.`);
  const max = Math.min(opts.maxBytes, (spec.maxMb ?? Infinity) * 1024 * 1024);
  const mb = Math.round(max / 1048576);
  if (opts.declared && opts.declared > max) { stream.resume(); throw new UploadError(413, `Fayl ${mb} MB-dan böyük ola bilməz.`); }
  fs.mkdirSync(path.join(opts.dir, "tmp"), { recursive: true, mode: 0o700 });
  const stored = `${opts.kind === "presentation" ? "pres" : "logo"}-${randomBytes(16).toString("hex")}.${ext === "jpeg" ? "jpg" : ext}`;
  const tmp = path.join(opts.dir, "tmp", `${stored}.part`);
  const fd = await fs.promises.open(tmp, "w", 0o600);
  let size = 0;
  let head = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      const c = chunk as Buffer;
      size += c.length;
      if (size > max) throw new UploadError(413, `Fayl ${mb} MB-dan böyük ola bilməz.`);
      if (head.length < 4096) head = Buffer.concat([head, c]).subarray(0, 4096);
      await fd.write(c);
    }
  } catch (e) {
    await fd.close();
    fs.rmSync(tmp, { force: true });
    stream.resume();
    throw e instanceof UploadError ? e : new UploadError(400, "Fayl tam göndərilmədi. Yenidən cəhd edin.");
  }
  await fd.close();
  const fail = (status: number, msg: string) => { fs.rmSync(tmp, { force: true }); return new UploadError(status, msg); };
  if (size < 8) throw fail(400, "Fayl boşdur.");
  if (!sniff(head, ext)) throw fail(415, "Faylın məzmunu uzantısına uyğun deyil.");
  if (ext === "pptx") {
    const all = await fs.promises.readFile(tmp);
    if (!all.includes("ppt/", 0, "latin1")) throw fail(415, "Bu PPTX faylı deyil (PowerPoint prezentasiyası gözlənilirdi).");
  }
  let pages: number | null = null;
  if (ext === "pdf") {
    pages = await pdfPages(tmp);
    if (!pages) throw fail(415, "PDF faylı oxunmadı (zədələnmiş ola bilər).");
  }
  const final = path.join(opts.dir, stored);
  fs.renameSync(tmp, final);
  fs.chmodSync(final, 0o600);
  return { stored, ext: ext === "jpeg" ? "jpg" : ext, size, pages };
}

/** PPTX → PDF with LibreOffice, one conversion at a time. */
export class Converter {
  private chain: Promise<void> = Promise.resolve();
  constructor(private soffice: string, private dir: string, private profileDir: string, private timeoutMs: number) {}
  get available() { return !!this.soffice; }
  convert(stored: string): Promise<{ pdfStored: string; pages: number | null } | null> {
    const job = this.chain.then(() => this.run(stored));
    this.chain = job.then(() => {}, () => {});
    return job;
  }
  private run(stored: string): Promise<{ pdfStored: string; pages: number | null } | null> {
    if (!this.soffice) return Promise.resolve(null);
    const out = path.join(this.dir, "tmp", `conv-${randomBytes(6).toString("hex")}`);
    const args = [`-env:UserInstallation=file://${this.profileDir}`, "--headless", "--norestore", "--nolockcheck", "--convert-to", "pdf", "--outdir", out, path.join(this.dir, stored)];
    const env = { ...process.env, HOME: this.profileDir };
    // `soffice` is a wrapper that starts soffice.bin as its child. Killing only the wrapper on a timeout left
    // soffice.bin running and holding the shared profile, so every later conversion handed its job to that
    // orphan and failed. The process gets its own group and the whole group is killed.
    const once = () => new Promise<void>(res => {
      let killed = false;
      let errText = "";
      const child = spawn(this.soffice, args, { env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
      child.stderr?.on("data", (d: Buffer) => { if (errText.length < 2000) errText += d.toString(); });
      const t = setTimeout(() => {
        killed = true;
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
      }, this.timeoutMs);
      child.on("error", e => { clearTimeout(t); console.warn(`munsif.im: soffice could not start: ${e.message}`); res(); });
      child.on("close", code => {
        clearTimeout(t);
        if (killed) console.warn(`munsif.im: soffice stopped after ${this.timeoutMs / 1000} s`);
        else if (code) console.warn(`munsif.im: soffice exited with ${code}: ${errText.trim().slice(0, 300) || "no output"}`);
        res();
      });
    });
    return (async () => {
      const t0 = Date.now();
      try {
        fs.mkdirSync(out, { recursive: true, mode: 0o700 });
        await once();
        // A fresh LibreOffice profile sometimes exits right after creating itself: one retry.
        if (!fs.readdirSync(out).some(n => n.endsWith(".pdf"))) await once();
        const pdf = fs.readdirSync(out).find(n => n.endsWith(".pdf"));
        if (!pdf) return null;
        const name = `pres-${randomBytes(16).toString("hex")}.pdf`;
        fs.renameSync(path.join(out, pdf), path.join(this.dir, name));
        fs.chmodSync(path.join(this.dir, name), 0o600);
        const pages = await pdfPages(path.join(this.dir, name));
        if (!pages) { fs.rmSync(path.join(this.dir, name), { force: true }); return null; }
        if (Date.now() - t0 > 20_000) console.warn(`munsif.im: PPTX → PDF took ${Math.round((Date.now() - t0) / 1000)} s`);
        return { pdfStored: name, pages };
      } catch { return null; } finally {
        fs.rmSync(out, { recursive: true, force: true });
      }
    })();
  }
}
