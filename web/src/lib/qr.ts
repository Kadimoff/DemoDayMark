// Juror QR invite dialog (live panel and Setup). The coordinator holds the screen up to the juror;
// the juror scans it, types their name, and the dialog flips to "✓ <name> qoşuldu" over the socket.
import QRCode from "qrcode";
import { isPlaceholderName } from "../../../shared/brand";
import { api, ApiError } from "./api";
import { esc, icon, toast } from "./dom";

export interface InviteJuror { id: number; displayName: string }
export interface Invite { path: string; expiresAt: number }
interface InviteResponse { juror: InviteJuror; invite: Invite }

let dlg: HTMLDialogElement | null = null;
let current: { juror: InviteJuror; invite: Invite; claimedAs: string | null } | null = null;
let timer = 0;
let onChange: () => void = () => {};

const localHost = () => /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/.test(location.hostname);

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.className = "qrdlg";
  dlg.setAttribute("aria-labelledby", "qrTitle");
  document.body.appendChild(dlg);
  dlg.addEventListener("click", async e => {
    const t = e.target as HTMLElement;
    if (t === dlg || t.closest("[data-qr-close]")) { close(); return; }
    if (t.closest("[data-qr-big]")) { dlg!.classList.toggle("big"); return; }
    if (t.closest("[data-qr-next]")) { await createJuror(); return; }
    if (t.closest("[data-qr-renew]") && current) { await reissue(current.juror); return; }
    if (t.closest("[data-qr-copy]") && current) {
      try { await navigator.clipboard.writeText(location.origin + current.invite.path); toast("Link kopyalandı"); } catch { toast("Kopyalamaq alınmadı", "err"); }
    }
  });
  dlg.addEventListener("close", () => { clearInterval(timer); current = null; dlg!.classList.remove("big"); onChange(); });
  return dlg;
}

function close() { dlg?.close(); }

function left(ms: number) {
  const s = Math.max(0, Math.floor((ms - Date.now()) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
}

async function render() {
  if (!dlg || !current) return;
  const { juror, invite, claimedAs } = current;
  const url = location.origin + invite.path;
  const svg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#0B0F19", light: "#FFFFFF" } });
  const known = !isPlaceholderName(juror.displayName);
  dlg.innerHTML = `
    <div class="dh">
      <div><h3>${known ? "Yeni QR · eyni hesab" : "Münsif QR kodu"}</h3><h2 id="qrTitle" style="margin-top:4px">${claimedAs ? "Qoşuldu" : "Telefonun kamerası ilə skan edin"}</h2></div>
      <div class="row" style="gap:6px;flex-wrap:nowrap">
        <button class="icon-btn" data-qr-big title="Tam ekran" aria-label="Tam ekran">${icon("expand")}</button>
        <button class="icon-btn" data-qr-close aria-label="Bağla">${icon("close")}</button>
      </div>
    </div>
    <div class="db">
      ${localHost() ? `<div class="banner lock" style="text-align:left">${icon("warn")}<span>Panel <b>${esc(location.host)}</b> ünvanında açılıb. Münsif telefonları bu ünvana çata bilməz. Paneli server ünvanı ilə açın.</span></div>` : ""}
      <div class="qrbox${claimedAs ? " claimed" : ""}">${svg}${claimedAs ? `<div class="okover">${icon("check")}<span>${esc(claimedAs)}</span></div>` : ""}</div>
      <div class="who">${esc(claimedAs ?? juror.displayName)}</div>
      ${claimedAs
        ? `<p class="sub" style="margin:0">Münsif panelə daxil oldu. Adı bütün ekranlarda görünür.</p>`
        : `<span class="wait">Skan gözlənilir · <span id="qrLeft">${left(invite.expiresAt)}</span></span>
           <p class="sub" style="margin:0;max-width:42ch">QR bir dəfə işləyir. Münsif skan edib adını yazan kimi bu pəncərə yenilənəcək.${known ? " Köhnə QR artıq etibarsızdır, münsifin balları qorunur." : ""}</p>
           <span class="link">${esc(url)}</span>`}
      <div class="acts">
        ${claimedAs ? "" : `<button class="btn sm" data-qr-copy>${icon("doc")}Linki kopyala</button><button class="btn sm" data-qr-renew>${icon("retry")}Yenilə</button>`}
        <button class="btn sm ${claimedAs ? "primary" : ""}" data-qr-next>${icon("plus")}Növbəti münsif</button>
        <button class="btn sm ghost" data-qr-close>Bağla</button>
      </div>
    </div>`;
}

function show(r: InviteResponse) {
  const d = ensureDialog();
  current = { juror: r.juror, invite: r.invite, claimedAs: null };
  void render();
  if (!d.open) d.showModal();
  clearInterval(timer);
  timer = window.setInterval(() => {
    const el = document.getElementById("qrLeft");
    if (el && current) el.textContent = left(current.invite.expiresAt);
  }, 1000);
}

/** Creates a juror account and shows its first QR. */
export async function createJuror() {
  try {
    const r = await api<InviteResponse>("/api/admin/jurors", { method: "POST", body: {} });
    show(r);
    onChange();
  } catch (e) { toast((e as ApiError).message, "err"); }
}

/** New QR for an existing juror (lost phone, cleared browser): the old QR stops working, scores stay. */
export async function reissue(juror: InviteJuror) {
  try {
    const r = await api<InviteResponse>(`/api/admin/jurors/${juror.id}/invite`, { method: "POST", body: {} });
    show(r);
  } catch (e) { toast((e as ApiError).message, "err"); }
}

/** Socket "juror:joined" handler. */
export function jurorJoined(p: { jurorId: number; displayName: string }) {
  if (current && current.juror.id === p.jurorId) {
    current.claimedAs = p.displayName;
    clearInterval(timer);
    void render();
  }
  toast(`${p.displayName} qoşuldu`);
}

/** Called whenever the dialog opens a new juror or closes, so the page can refresh its list. */
export function onQrChange(fn: () => void) { onChange = fn; }

/** A plain "scan to open" QR (e.g. the presenter's timer). Same look as the juror dialog, no state. */
export async function showLinkQr(o: { title: string; heading: string; path: string; note: string }) {
  const d = document.createElement("dialog");
  d.className = "qrdlg";
  const url = location.origin + o.path;
  const svg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#0B0F19", light: "#FFFFFF" } });
  d.innerHTML = `
    <div class="dh"><div><h3>${esc(o.title)}</h3><h2 style="margin-top:4px">${esc(o.heading)}</h2></div>
      <div class="row" style="gap:6px;flex-wrap:nowrap"><button class="icon-btn" data-big title="Tam ekran" aria-label="Tam ekran">${icon("expand")}</button>
      <button class="icon-btn" data-close aria-label="Bağla">${icon("close")}</button></div></div>
    <div class="db">
      ${localHost() ? `<div class="banner lock" style="text-align:left">${icon("warn")}<span>Panel <b>${esc(location.host)}</b> ünvanında açılıb. Telefonlar bu ünvana çata bilməz. Paneli server ünvanı ilə açın.</span></div>` : ""}
      <div class="qrbox">${svg}</div>
      <p class="sub" style="margin:0;max-width:44ch">${esc(o.note)}</p>
      <span class="link">${esc(url)}</span>
      <div class="acts"><a class="btn sm" href="${esc(o.path)}" target="_blank" rel="noopener">${icon("ext")}Aç</a><button class="btn sm ghost" data-close>Bağla</button></div>
    </div>`;
  document.body.appendChild(d);
  d.addEventListener("click", e => {
    const t = e.target as HTMLElement;
    if (t === d || t.closest("[data-close]")) d.close();
    else if (t.closest("[data-big]")) d.classList.toggle("big");
  });
  d.addEventListener("close", () => d.remove());
  d.showModal();
}
