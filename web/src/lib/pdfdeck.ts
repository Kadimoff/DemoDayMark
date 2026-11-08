// pdf.js presentation renderer (munsif stage): two stacked canvases cross-fade between slides,
// rendered pages are cached and the neighbours are pre-rendered while the browser is idle.
import type { PDFDocumentProxy } from "pdfjs-dist";

// legacy build: polyfills newer JS (e.g. Math.sumPrecise) that older projector laptops and Chrome < 147 lack —
// without them some pages never finish rendering.
type PdfJs = typeof import("pdfjs-dist");
let lib: Promise<PdfJs> | null = null;
export function pdfjs(): Promise<PdfJs> {
  lib ??= (async () => {
    const [m, worker] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<PdfJs>, import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]);
    m.GlobalWorkerOptions.workerSrc = worker.default;
    return m;
  })();
  return lib;
}

export async function openPdf(url: string): Promise<PDFDocumentProxy> {
  const m = await pdfjs();
  return m.getDocument({
    url, withCredentials: true, cMapUrl: "/vendor/pdfjs/cmaps/", cMapPacked: true,
    standardFontDataUrl: "/vendor/pdfjs/standard_fonts/", wasmUrl: "/vendor/pdfjs/wasm/", iccUrl: "/vendor/pdfjs/iccs/",
  } as Parameters<PdfJs["getDocument"]>[0]).promise;
}

/** Renders page n to fit a w×h box; returns an offscreen canvas and its CSS size. */
export async function renderPage(doc: PDFDocumentProxy, n: number, w: number, h: number, dprMax = 2) {
  const page = await doc.getPage(n);
  const v1 = page.getViewport({ scale: 1 });
  const s = Math.min(w / v1.width, h / v1.height);
  const dpr = Math.min(window.devicePixelRatio || 1, dprMax);
  const vp = page.getViewport({ scale: s * dpr });
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(vp.width));
  c.height = Math.max(1, Math.round(vp.height));
  await page.render({ canvas: c, canvasContext: c.getContext("2d", { alpha: false })!, viewport: vp } as Parameters<typeof page.render>[0]).promise;
  return { c, w: v1.width * s, h: v1.height * s };
}

export class Deck {
  private doc: PDFDocumentProxy | null = null;
  private url: string | null = null;
  private loading: Promise<boolean> | null = null;
  private cache = new Map<string, Promise<{ c: HTMLCanvasElement; w: number; h: number }>>();
  private front: HTMLCanvasElement;
  private back: HTMLCanvasElement;
  private tok = 0;
  private queue: Promise<void> = Promise.resolve();
  shown = 0;
  pages = 0;

  constructor(private box: HTMLElement, private reduced: boolean, private onError: (msg: string) => void = () => {}) {
    this.front = document.createElement("canvas");
    this.back = document.createElement("canvas");
    for (const c of [this.front, this.back]) { c.className = "st-slide"; box.appendChild(c); }
    let t = 0;
    addEventListener("resize", () => { clearTimeout(t); t = window.setTimeout(() => { this.cache.clear(); if (this.doc && this.shown) void this.show(this.shown, 0, true); }, 180); });
  }

  get ready() { return !!this.doc; }
  get current() { return this.url; }

  /** Loads the document (once per URL). Resolves false when it cannot be opened. */
  load(url: string): Promise<boolean> {
    if (this.url === url && this.loading) return this.loading;
    this.url = url;
    this.cache.clear();
    this.shown = 0;
    this.front.classList.remove("on");
    this.back.classList.remove("on");
    this.box.classList.add("busy");
    const prev = this.doc;
    this.doc = null;
    void prev?.loadingTask.destroy().catch(() => {});
    this.loading = openPdf(url).then(d => {
      if (this.url !== url) { void d.loadingTask.destroy(); return false; }
      this.doc = d;
      this.pages = d.numPages;
      this.box.classList.remove("busy");
      return true;
    }).catch(() => {
      if (this.url === url) { this.url = null; this.loading = null; this.box.classList.remove("busy"); this.onError("Prezentasiya açılmadı"); }
      return false;
    });
    return this.loading;
  }

  unload() {
    this.url = null;
    this.loading = null;
    void this.doc?.loadingTask.destroy().catch(() => {});
    this.doc = null;
    this.shown = 0;
    this.pages = 0;
    this.cache.clear();
    this.front.classList.remove("on");
    this.back.classList.remove("on");
  }

  private page(n: number) {
    const w = this.box.clientWidth || innerWidth, h = this.box.clientHeight || innerHeight;
    const key = `${this.url}|${n}|${w}x${h}`;
    let p = this.cache.get(key);
    if (!p) {
      // one render at a time: neighbours are pre-rendered behind the visible slide, not in parallel with it
      // (pdf.js continues a render on animation frames, so a hidden tab finishes its renders when it is shown again)
      const doc = this.doc!;
      p = this.queue.then(() => renderPage(doc, n, w, h));
      this.queue = p.then(() => {}, () => {});
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
      if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  /** Shows slide n (clamped); dir > 0 slides in from the right, < 0 from the left. */
  async show(n: number, dir = 0, force = false) {
    if (!this.doc) return;
    n = Math.max(1, Math.min(this.pages, n));
    if (n === this.shown && !force) return;
    const tok = ++this.tok;
    let r: { c: HTMLCanvasElement; w: number; h: number };
    try { r = await this.page(n); } catch { return; }
    if (tok !== this.tok) return;
    const inc = this.back, out = this.front;
    inc.width = r.c.width; inc.height = r.c.height;
    inc.style.width = `${r.w}px`; inc.style.height = `${r.h}px`;
    inc.getContext("2d")!.drawImage(r.c, 0, 0);
    const anim = !this.reduced && dir !== 0;
    inc.className = `st-slide${anim ? (dir > 0 ? " from-r" : " from-l") : ""}`;
    void inc.offsetWidth;
    inc.className = "st-slide on";
    out.className = `st-slide${anim ? (dir > 0 ? " to-l" : " to-r") : ""}`;
    this.front = inc; this.back = out; this.shown = n;
    const idle = (window as Window & { requestIdleCallback?: (f: () => void) => void }).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 120));
    idle(() => { for (const m of [n + 1, n - 1, n + 2]) if (this.doc && m >= 1 && m <= this.pages) void this.page(m).catch(() => {}); });
  }
}
