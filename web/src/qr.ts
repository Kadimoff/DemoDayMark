// v4 "QR kodlar": every sign-in QR of the active program on one page, mobile first.
// - Komandalar: each team's sign-in link (/t/<code>) as a card: QR, short link, code, copy / WhatsApp / Telegram / share.
//   Print all (A4, 2 per row) or download a PDF. Team links are reusable, so they are never put on the big screen.
// - Münsiflər: single-use juror QRs, made for the jurors who have not signed in yet. Print, PDF, share, or "Səhnə
//   ekranında göstər": one juror's QR at a time, full screen, on the coordinator's own laptop that drives the projector
//   (never through the public stage feed, which anyone with the link can open). It moves on to the next juror as soon as
//   one signs in.
import "./styles.css";
import QRCode from "qrcode";
import { api, ApiError } from "./lib/api";
import { adminNav } from "./lib/adminnav";
import { $, esc, icon, toast } from "./lib/dom";
import { bindShare, shareHtml } from "./lib/share";
import { live } from "./lib/socket";
import { topbar } from "./lib/topbar";
import { showLinkQr } from "./lib/qr";

interface TeamCard { id: number; name: string; project: string; code: string | null; path: string | null }
interface JurorCard { id: number; displayName: string; active: boolean; placeholder: boolean; claimed: boolean; openInviteUntil: number | null }
interface QrData { eventName: string; origin: string; teams: TeamCard[]; jurors: JurorCard[];
  /** v14: the shared team link (every team picks its name). */
  pick: { code: string; path: string; claimed: number; total: number } | null }
interface Invite { id: number; displayName: string; path: string; expiresAt: number }

const bar = topbar({ role: "admin", nav: adminNav("qr"), wide: true });
const main = $("#main");
let D: QrData | null = null;
let tab: "teams" | "jurors" = location.hash === "#jurors" ? "jurors" : "teams";
const invites = new Map<number, Invite>();
let ttl = 24;
let busy = false;
const svgCache = new Map<string, string>();

const origin = () => (D?.origin || location.origin).replace(/\/$/, "");
const localHost = () => /^(localhost|127\.|\[?::1\]?$|0\.0\.0\.0)/.test(location.hostname);
async function qrSvg(url: string) {
  let s = svgCache.get(url);
  if (!s) { s = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#0B0F19", light: "#FFFFFF" } }); svgCache.set(url, s); }
  return s;
}
const p2 = (n: number) => String(n).padStart(2, "0");
const until = (ms: number) => { const x = new Date(ms); return `${p2(x.getDate())}.${p2(x.getMonth() + 1)} ${p2(x.getHours())}:${p2(x.getMinutes())}`; };

async function load() {
  try { D = await api<QrData>("/api/admin/qr"); }
  catch (e) { main.innerHTML = `<div class="banner err">${esc((e as Error).message)}</div>`; return; }
  bar.setEventName(D.eventName);
  // a juror who signed in meanwhile has no usable QR on this page any more
  for (const j of D.jurors) if (j.claimed && invites.has(j.id) && !j.openInviteUntil) invites.delete(j.id);
  await render();
}

async function teamCardHtml(t: TeamCard) {
  if (!t.path) return `<article class="qr-card empty"><div class="qc-h"><b>${esc(t.name)}</b><small>${esc(t.project)}</small></div><p class="sub">Linki hələ yaradılmayıb.</p></article>`;
  const url = origin() + t.path;
  return `<article class="qr-card"><div class="qc-h"><b>${esc(t.name)}</b>${t.project ? `<small>${esc(t.project)}</small>` : ""}</div>
    <div class="qc-qr">${await qrSvg(url)}</div>
    <div class="qc-link mono">${esc(url.replace(/^https?:\/\//, ""))}</div>
    <div class="qc-code mono">${esc(t.code ?? "")}</div>
    <p class="qc-note">Komanda üzvlərinin hamısı bu linklə daxil olur.</p>
    ${shareHtml(url, `${D!.eventName}: ${t.name} komandasının giriş linki`)}</article>`;
}
/** v14: one QR for every team (shown on the projector or sent to the group): each team picks its own name. */
async function pickCardHtml() {
  const p = D!.pick;
  if (!p) return `<article class="qr-card qr-pick empty"><div class="qc-h"><b>Ümumi komanda QR-ı</b><small>Bir QR hamı üçün</small></div>
    <p class="sub" style="max-width:46ch">Bir QR kodu ekrana çıxarın və ya linki qrupa göndərin: hər komanda skan edib siyahıdan öz adını seçir. Seçilən komanda bağlanır.</p>
    <button class="btn primary" id="mkPick">${icon("qr")}Ümumi link yarat</button></article>`;
  const url = origin() + p.path;
  return `<article class="qr-card qr-pick"><div class="qc-h"><b>Ümumi komanda QR-ı</b><small>Daxil olub: ${p.claimed} / ${p.total}</small></div>
    <div class="qc-qr">${await qrSvg(url)}</div>
    <div class="qc-link mono">${esc(url.replace(/^https?:\/\//, ""))}</div>
    <div class="qc-code mono">${esc(p.code)}</div>
    <p class="qc-note">Hər komanda skan edib siyahıdan öz adını seçir. Seçilən komanda bağlanır, başqası onun adından daxil ola bilməz.</p>
    ${shareHtml(url, `${D!.eventName}: komanda girişi (komandanızı seçin)`)}
    <div class="row noprint" style="justify-content:center;gap:8px"><button class="btn sm" id="bigPick">${icon("expand")}Böyük göstər</button>
      <button class="btn sm ghost" id="newPick">${icon("retry")}Yeni link</button></div></article>`;
}
async function jurorCardHtml(j: JurorCard) {
  const inv = invites.get(j.id);
  if (!inv) return "";
  const url = origin() + inv.path;
  return `<article class="qr-card" data-jcard="${j.id}"><div class="qc-h"><b>${esc(j.displayName)}</b><small>Münsif</small></div>
    <div class="qc-qr">${await qrSvg(url)}</div>
    <div class="qc-link mono">${esc(url.replace(/^https?:\/\//, "").replace(/(\/j\/.{8}).+/, "$1…"))}</div>
    <p class="qc-note">QR bir dəfə işləyir. ${until(inv.expiresAt)} tarixinədək etibarlıdır.</p>
    ${shareHtml(url, `${D!.eventName}: münsif girişi (${j.displayName})`)}</article>`;
}

async function render() {
  if (!D) return;
  const missing = D.teams.filter(t => !t.path).length;
  const jActive = D.jurors.filter(j => j.active);
  const waiting = jActive.filter(j => !j.claimed);
  const shown = jActive.filter(j => invites.has(j.id));
  const teamsPane = `
    <div class="qr-bar row">
      ${missing ? `<button class="btn primary" id="mkLinks"${busy ? " disabled" : ""}>${icon("plus")}Link yarat (${missing} komanda)</button>` : ""}
      <button class="btn" id="printAll"${D.teams.length - missing ? "" : " disabled"}>${icon("doc")}Hamısını çap et</button>
      <a class="btn" href="/api/admin/qr/teams.pdf" download${D.teams.length - missing ? "" : ' aria-disabled="true"'}>${icon("download")}PDF yüklə</a>
    </div>
    <div class="qr-grid qr-pickrow">${await pickCardHtml()}</div>
    <p class="note">Ümumi QR-ı səhnə ekranında göstərmək olar. Hər komandanın <b>öz</b> linki isə çoxdəfəlikdir: komandanın bütün üzvləri eyni linklə daxil olur. Ona görə öz linki yalnız həmin komandaya göndərin, səhnə ekranında göstərməyin.</p>
    ${D.teams.length ? `<div class="qr-grid">${(await Promise.all(D.teams.map(teamCardHtml))).join("")}</div>` : `<p class="note">Aktiv komanda yoxdur. Quraşdırmada komanda əlavə edin.</p>`}`;
  const jurorsPane = `
    <div class="qr-bar row">
      <label class="f" for="ttl" style="margin:0">Etibarlılıq</label>
      <select id="ttl" style="width:auto"><option value="24"${ttl === 24 ? " selected" : ""}>24 saat</option><option value="72"${ttl === 72 ? " selected" : ""}>3 gün</option></select>
      <button class="btn primary" id="mkInv"${busy || !waiting.length ? " disabled" : ""}>${icon("qr")}QR yarat (${waiting.length} münsif)</button>
      <button class="btn" id="printAll"${shown.length ? "" : " disabled"}>${icon("doc")}Hamısını çap et</button>
      <button class="btn" id="jPdf"${shown.length ? "" : " disabled"}>${icon("download")}PDF yüklə</button>
      <button class="btn" id="showBig"${shown.length ? "" : " disabled"}>${icon("expand")}Səhnə ekranında göstər</button>
      <button class="btn ghost" id="addJ">${icon("plus")}Münsif əlavə et</button>
    </div>
    <p class="note">Münsif QR-ı bir dəfə işləyir: münsif skan edib adını yazan kimi QR bağlanır. QR yalnız hələ qoşulmamış münsiflər üçün yaradılır. Yeni QR yaradanda əvvəl çap olunmuş QR-lar işləmir.
      “Səhnə ekranında göstər” QR-ları proyektora qoşulmuş öz kompüterinizdə bir-bir, böyük göstərir.</p>
    <ul class="qr-jlist">${jActive.map(j => `<li><b>${esc(j.displayName)}</b>${j.claimed ? `<span class="pill ok">${icon("check")}Qoşulub</span>` : invites.has(j.id) ? `<span class="pill warn">QR hazırdır</span>`
      : j.openInviteUntil ? `<span class="pill">QR verilib, ${until(j.openInviteUntil)}</span>` : `<span class="pill">QR yoxdur</span>`}</li>`).join("") || `<li class="sub">Hələ münsif yoxdur. “Münsif əlavə et” ilə başlayın.</li>`}</ul>
    ${shown.length ? `<div class="qr-grid">${(await Promise.all(shown.map(jurorCardHtml))).join("")}</div>` : ""}`;
  main.innerHTML = `
    <section class="qr-head"><div><h1>${icon("qr")} QR kodlar</h1>
      <p class="sub"><b>${esc(D.eventName)}</b>: komanda və münsif girişləri. Çap edin, PDF yükləyin və ya linki WhatsApp, Telegram ilə göndərin.</p></div>
      <button class="btn ghost danger" id="revokeAll">${icon("trash")}Bütün QR-ları ləğv et</button></section>
    ${localHost() ? `<div class="banner lock">${icon("warn")}<span>Panel <b>${esc(location.host)}</b> ünvanında açılıb. Telefonlar bu ünvana çata bilməz. Paneli server ünvanı ilə açın.</span></div>` : ""}
    <div class="seg qr-tabs" role="tablist" aria-label="QR növü">
      <button role="tab" data-qtab="teams" aria-selected="${tab === "teams"}" aria-pressed="${tab === "teams"}">${icon("list")}Komandalar <b>${D.teams.length}</b></button>
      <button role="tab" data-qtab="jurors" aria-selected="${tab === "jurors"}" aria-pressed="${tab === "jurors"}">${icon("users")}Münsiflər <b>${jActive.length}</b></button>
    </div>
    <div class="qr-pane" data-pane="teams"${tab === "teams" ? "" : " hidden"}>${teamsPane}</div>
    <div class="qr-pane" data-pane="jurors"${tab === "jurors" ? "" : " hidden"}>${jurorsPane}</div>`;
  if (show) void paintShow();
}

async function makeLinks() {
  busy = true; void render();
  try { const r = await api<{ made: number; teams: TeamCard[] }>("/api/admin/qr/teams", { method: "POST", body: {} }); D!.teams = r.teams; toast(`${r.made} komandaya link yaradıldı`); }
  catch (e) { toast((e as ApiError).message, "err"); }
  busy = false; await render();
}
async function revokeAll() {
  if (!confirm("Bütün QR-lar və linklər ləğv edilsin?\n\n• hər komandanın öz linki\n• ümumi komanda QR-ı\n• istifadə olunmamış münsif QR-ları\n\nÇap olunmuş və göndərilmiş QR-lar işləməyəcək. Artıq daxil olmuş komandalar və münsiflər çıxmır. Sonra yenilərini yarada bilərsiniz.")) return;
  try {
    const r = await api<{ teams: number; jurors: number; shared: boolean }>("/api/admin/qr/revoke-all", { method: "POST", body: {} });
    invites.clear(); svgCache.clear();
    toast(`Ləğv edildi: ${r.teams} komanda linki${r.shared ? ", ümumi QR" : ""}, ${r.jurors} münsif QR-ı`);
    await load();
  } catch (e) { toast((e as ApiError).message, "err"); }
}
async function makePick(again: boolean) {
  if (again && !confirm("Yeni ümumi link yaradılsın? Köhnə link və QR işləməyəcək (daxil olmuş komandalar çıxmır).")) return;
  try { await api("/api/admin/team-pick", { method: "POST", body: {} }); toast("Ümumi komanda linki hazırdır"); await load(); }
  catch (e) { toast((e as ApiError).message, "err"); }
}
async function makeInvites() {
  const n = D!.jurors.filter(j => j.active && !j.claimed && j.openInviteUntil).length;
  if (n && !confirm("Bəzi münsiflərin hələ istifadə olunmamış QR-ı var. Yeni QR yaradılsın? Köhnə QR-lar işləməyəcək.")) return;
  busy = true; void render();
  try {
    const r = await api<{ invites: Invite[] }>("/api/admin/qr/jurors", { method: "POST", body: { ttlHours: ttl } });
    for (const i of r.invites) invites.set(i.id, i);
    toast(`${r.invites.length} münsif üçün QR hazırdır`);
    await load();
  } catch (e) { toast((e as ApiError).message, "err"); }
  busy = false; await render();
}
async function jurorsPdf() {
  try {
    const res = await fetch("/api/admin/qr/jurors.pdf", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invites: [...invites.values()].map(i => ({ id: i.id, path: i.path })) }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `PDF alınmadı (${res.status})`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (/filename\*=UTF-8''([^;]+)/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "munsif-qr.pdf").replace(/%[0-9A-F]{2}/gi, decodeURIComponent);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast((e as Error).message, "err"); }
}
async function addJuror() {
  try {
    const r = await api<{ juror: { id: number; displayName: string }; invite: { path: string; expiresAt: number } }>("/api/admin/jurors", { method: "POST", body: {} });
    invites.set(r.juror.id, { id: r.juror.id, displayName: r.juror.displayName, ...r.invite });
    await load();
  } catch (e) { toast((e as ApiError).message, "err"); }
}

// ---------- one juror QR at a time, full screen ----------
let show: { i: number } | null = null;
let showEl: HTMLElement | null = null;
const showList = () => (D?.jurors ?? []).filter(j => j.active && invites.has(j.id) && !j.claimed);
async function paintShow() {
  if (!show || !showEl) return;
  const list = showList();
  if (!list.length) {
    showEl.innerHTML = `<div class="qs-in"><div class="qs-done">${icon("check")}<h2>Bütün münsiflər qoşuldu</h2><p>Bu ekranı bağlaya bilərsiniz.</p></div><button class="btn" data-qs="close">Bağla</button></div>`;
    return;
  }
  show.i = Math.max(0, Math.min(list.length - 1, show.i));
  const j = list[show.i];
  const url = origin() + invites.get(j.id)!.path;
  showEl.innerHTML = `<div class="qs-in">
    <div class="qs-top"><span class="caps">${esc(D!.eventName)} · münsif girişi</span><span class="mono">${show.i + 1} / ${list.length}</span></div>
    <div class="qs-qr">${await qrSvg(url)}</div>
    <h2 class="qs-name">${esc(j.displayName)}</h2>
    <p class="qs-hint">Telefonun kamerası ilə skan edin və adınızı yazın. QR bir dəfə işləyir.</p>
    <div class="qs-nav"><button class="btn" data-qs="prev" aria-label="Əvvəlki münsif"${show.i ? "" : " disabled"}>‹</button>
      <button class="btn" data-qs="close">Bağla</button>
      <button class="btn" data-qs="next" aria-label="Növbəti münsif"${show.i < list.length - 1 ? "" : " disabled"}>›</button></div></div>`;
}
function openShow() {
  show = { i: 0 };
  showEl = document.createElement("div");
  showEl.className = "qr-show";
  showEl.setAttribute("role", "dialog");
  showEl.setAttribute("aria-label", "Münsif QR kodları");
  document.body.appendChild(showEl);
  showEl.addEventListener("click", e => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-qs]")?.dataset.qs;
    if (a === "close") closeShow(); else if (a === "next" && show) { show.i++; void paintShow(); } else if (a === "prev" && show) { show.i--; void paintShow(); }
  });
  void paintShow();
  showEl.requestFullscreen?.().catch(() => { /* a normal overlay then */ });
}
function closeShow() {
  show = null;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  showEl?.remove(); showEl = null;
}
document.addEventListener("keydown", e => {
  if (!show) return;
  if (e.key === "Escape") closeShow();
  else if (["ArrowRight", "PageDown", " "].includes(e.key)) { e.preventDefault(); show.i++; void paintShow(); }
  else if (["ArrowLeft", "PageUp"].includes(e.key)) { e.preventDefault(); show.i--; void paintShow(); }
});
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && show && showEl) showEl.classList.add("nofs"); });

// ---------- events ----------
main.addEventListener("click", e => {
  const t = e.target as HTMLElement;
  const tb = t.closest<HTMLElement>("[data-qtab]");
  if (tb) { tab = tb.dataset.qtab as typeof tab; history.replaceState(null, "", `#${tab}`); void render(); return; }
  if (t.closest("#mkLinks")) { void makeLinks(); return; }
  if (t.closest("#revokeAll")) { void revokeAll(); return; }
  if (t.closest("#mkPick") || t.closest("#newPick")) { void makePick(!!t.closest("#newPick")); return; }
  if (t.closest("#bigPick") && D?.pick) {
    void showLinkQr({ title: "Komanda girişi", heading: "Komandanızı seçib daxil olun", path: D.pick.path,
      note: "Telefonun kamerası ilə skan edin və siyahıdan öz komandanızı seçin. Komandanın digər üzvləri paneldəki komanda kodu ilə daxil olur." });
    return;
  }
  if (t.closest("#mkInv")) { void makeInvites(); return; }
  if (t.closest("#printAll")) { document.body.dataset.print = tab; window.print(); return; }
  if (t.closest("#jPdf")) { void jurorsPdf(); return; }
  if (t.closest("#showBig")) { openShow(); return; }
  if (t.closest("#addJ")) { void addJuror(); return; }
});
main.addEventListener("change", e => { const t = e.target as HTMLSelectElement; if (t.id === "ttl") ttl = Number(t.value) === 72 ? 72 : 24; });
bindShare(main);
addEventListener("hashchange", () => { const h = location.hash === "#jurors" ? "jurors" : "teams"; if (h !== tab) { tab = h; void render(); } });

live({
  role: "admin",
  on: {
    "juror:joined": (p: { jurorId: number; displayName: string }) => {
      toast(`${p.displayName} qoşuldu`);
      const j = D?.jurors.find(x => x.id === p.jurorId);
      if (j) { j.claimed = true; j.displayName = p.displayName; j.openInviteUntil = null; }
      invites.delete(p.jurorId);
      void render();
    },
    "config:changed": () => void load(),
    "materials:changed": () => void load(),
  },
  resync: () => void load(),
  status: online => bar.setOnline(online),
});
void load();
