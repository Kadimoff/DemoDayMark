// v3: full-screen presentation preview for the coordinator (any team's deck, or the event's own presentation):
// pdf.js, slide by slide (buttons, ← →, swipe), with a link to the team's website. Looking does not need "accept".
import { Deck } from "./pdfdeck";
import { esc, icon, reducedMotion, toast } from "./dom";

export interface ViewerOpts {
  url: string;
  title: string;
  subtitle?: string;
  siteUrl?: string | null;
  /** Extra buttons (HTML) in the header, e.g. "Səhnəyə çıxar"; clicks reach onAction(data-pv-act). */
  actions?: string;
  onAction?: (act: string) => void | Promise<void>;
}

let dlg: HTMLDialogElement | null = null;
let deck: Deck | null = null;
let current: ViewerOpts | null = null;

function paint() {
  if (!dlg || !deck) return;
  dlg.querySelector<HTMLElement>(".pv-n")!.textContent = deck.pages ? `${deck.shown || 1} / ${deck.pages}` : "…";
  dlg.querySelector<HTMLButtonElement>("[data-pv=prev]")!.disabled = !deck.ready || deck.shown <= 1;
  dlg.querySelector<HTMLButtonElement>("[data-pv=next]")!.disabled = !deck.ready || deck.shown >= deck.pages;
}
function go(d: number) {
  if (!deck?.ready) return;
  const n = Math.max(1, Math.min(deck.pages, (deck.shown || 1) + d));
  if (n !== deck.shown) void deck.show(n, d).then(paint);
}

function build() {
  dlg = document.createElement("dialog");
  dlg.className = "pv";
  dlg.setAttribute("aria-label", "Prezentasiyaya baxış");
  dlg.innerHTML = `<div class="pv-top">
      <div class="pv-t"><b class="pv-title"></b><small class="pv-sub"></small></div>
      <span class="pv-n mono">…</span>
      <span class="pv-acts"></span>
      <button class="icon-btn pv-x" data-pv="close" aria-label="Bağla" title="Bağla (Esc)">${icon("close")}</button>
    </div>
    <div class="pv-stage"><div class="pv-deck st-slides"></div>
      <button class="pv-nav l" data-pv="prev" aria-label="Əvvəlki slayd">${icon("back")}</button>
      <button class="pv-nav r" data-pv="next" aria-label="Növbəti slayd">${icon("next")}</button></div>`;
  document.body.appendChild(dlg);
  deck = new Deck(dlg.querySelector(".pv-deck")!, reducedMotion(), msg => toast(msg, "err"));
  dlg.addEventListener("click", async e => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>("[data-pv]");
    if (b?.dataset.pv === "close") { dlg!.close(); return; }
    if (b?.dataset.pv === "prev") { go(-1); return; }
    if (b?.dataset.pv === "next") { go(1); return; }
    const a = t.closest<HTMLElement>("[data-pv-act]");
    if (a && current?.onAction) await current.onAction(a.dataset.pvAct!);
  });
  dlg.addEventListener("keydown", e => {
    const k = e.key.toLowerCase();
    if (["arrowright", "pagedown", "arrowdown", " "].includes(k)) { e.preventDefault(); go(1); }
    else if (["arrowleft", "pageup", "arrowup"].includes(k)) { e.preventDefault(); go(-1); }
  });
  dlg.addEventListener("close", () => { deck?.unload(); current = null; });
  let sx: number | null = null, sy = 0;
  const st = dlg.querySelector<HTMLElement>(".pv-stage")!;
  st.addEventListener("pointerdown", e => { sx = e.clientX; sy = e.clientY; });
  st.addEventListener("pointerup", e => {
    if (sx == null) return; const dx = e.clientX - sx, dy = e.clientY - sy; sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
  });
}

export function openViewer(o: ViewerOpts) {
  if (!dlg) build();
  current = o;
  dlg!.querySelector(".pv-title")!.textContent = o.title;
  dlg!.querySelector(".pv-sub")!.textContent = o.subtitle ?? "";
  dlg!.querySelector(".pv-acts")!.innerHTML = `${o.siteUrl ? `<a class="btn sm" href="${esc(o.siteUrl)}" target="_blank" rel="noopener noreferrer">${icon("ext")}Sayt</a>` : ""}${o.actions ?? ""}`;
  if (!dlg!.open) dlg!.showModal();
  dlg!.focus();
  paint();
  void deck!.load(o.url).then(ok => { if (ok && current === o) void deck!.show(1, 0, true).then(paint); });
}
export const viewerOpen = () => !!dlg?.open;
