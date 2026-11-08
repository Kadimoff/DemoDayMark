// v3: the platform owner's own panel (/root), completely apart from any event panel. Every organisation (the owner's
// own event, org 1, is just one of them) with its live state; "Proyektoruna bax" (read-only projector preview) and
// "Müdaxilə et" (enter that organisation's coordinator panel). Coordinators never reach it: the server redirects them
// and /api/root/* answers 403.
import "./styles.css";
import { fmtClock, timerView } from "../../shared/timer";
import type { StagePayload } from "../../shared/types";
import { api, ApiError } from "./lib/api";
import { now, syncClock } from "./lib/clock";
import { $, esc, icon, toast } from "./lib/dom";
import { live } from "./lib/socket";
import { topbar } from "./lib/topbar";
import { sysCardHtml, type SystemStatus } from "./lib/syscard";

interface Coord { id: number; username: string; displayName: string; active: boolean; root: boolean }
interface OrgLive {
  id: number; slug: string; name: string; active: boolean; root: boolean; createdAt: number; eventName: string; events: number;
  teams: number; jurors: number; scores: number; jurorsOnline: number; progress: { done: number; need: number };
  coordinators: Coord[]; links: { stage: string; reveal: string; team: string }; stage: StagePayload;
}

const bar = topbar({ role: "admin", nav: [{ href: "/root", label: "Platforma", icon: "db", current: true }], wide: true });
bar.setEventName("Platforma");
const main = $("#main");
let orgs: OrgLive[] = [];
let open: string | null = null;
let confirmOff: number | null = null;
let newOpen = false;
let sys: SystemStatus | null = null;
let sysErr: string | null = null;

/** v11: "Sistem vəziyyəti" card (its own request: a slow / failing status never blocks the organisations list). */
async function loadSys() {
  try { sys = await api<SystemStatus>("/api/root/system"); sysErr = null; }
  catch (e) { sysErr = (e as Error).message; }
  const box = document.getElementById("sys");
  if (box) { box.outerHTML = sysCardHtml(sys, sysErr); bindSys(); }
}
function bindSys() {
  document.getElementById("sysBackup")?.addEventListener("click", async e => {
    const b = e.currentTarget as HTMLButtonElement;
    b.disabled = true;
    try { await api("/api/root/backup", { method: "POST", body: {} }); toast("Yedək alındı"); await loadSys(); }
    catch (ex) { toast((ex as ApiError).message, "err"); b.disabled = false; }
  });
}

async function load() {
  void loadSys();
  try { orgs = await api<OrgLive[]>("/api/root/overview"); }
  catch (e) { main.innerHTML = `<div class="banner err">${esc((e as Error).message)}</div>`; return; }
  for (const o of orgs) syncClock(o.stage.serverNow);
  render();
}

function liveLine(o: OrgLive) {
  const st = o.stage;
  const v = timerView(st.timer, now());
  const scene = st.show.scene === "event" && st.show.eventPres ? `${icon("doc")}<b>${esc(st.show.eventPres.title)}</b><small>tədbirin prezentasiyası</small>`
    : st.team ? `<span class="mono acc-t">#${st.team.index}</span><b>${esc(st.team.name)}</b><small>${st.team.index}/${st.team.total}</small>` : `<span class="faint">Səhnə boşdur</span>`;
  const timer = v.kind === "idle" ? `<span class="pill">Taymer gizli</span>`
    : `<span class="pill ${v.kind === "done" ? "danger" : v.running ? "live" : "warn"}">${v.kind === "pitch" ? "Təqdimat" : v.kind === "qa" ? "Sual-cavab" : "Vaxt bitdi"}${v.kind !== "done" ? ` · <span class="mono">${fmtClock(v.remaining)}</span>` : ""}${!v.running && v.kind !== "done" ? " · fasilə" : ""}</span>`;
  return `<div class="rl-scene">${scene}</div><div class="rl-timer" data-timer="${o.id}">${timer}</div>`;
}

function card(o: OrgLive) {
  const coords = o.coordinators.map(c => `<div class="coord">
      <div><b>${esc(c.displayName)}</b> <span class="u">@${esc(c.username)}</span></div>
      ${c.root ? `<span class="pill hot">Root</span>` : c.active ? `<span class="pill ok">Aktiv</span>` : `<span class="pill warn">Deaktiv</span>`}
      <span class="spacer"></span>
      ${c.root ? "" : `<button class="btn sm" data-reset="${c.id}">${icon("key")}Şifrə</button>
        <button class="btn sm ghost" data-uactive="${c.id}:${c.active ? 0 : 1}">${c.active ? "Deaktiv et" : "Aktiv et"}</button>`}
      ${open === `reset:${c.id}` ? `<form class="inline-form" data-reset-form="${c.id}" style="width:100%" novalidate>
        <div><label class="f" for="rp${c.id}">Yeni şifrə (min. 8)</label><input type="password" id="rp${c.id}" autocomplete="new-password" minlength="8" required></div>
        <button class="btn primary sm" type="submit">Saxla</button><button class="btn sm" type="button" data-cancel>Ləğv et</button></form>` : ""}
    </div>`).join("") || `<p class="sub" style="margin:0">Koordinator hesabı yoxdur.</p>`;
  const pct = o.progress.need ? Math.round((o.progress.done / o.progress.need) * 100) : 0;
  return `<section class="card pad-lg rcard${o.active ? "" : " off"}" data-org="${o.id}">
    <div class="oh"><div style="min-width:0"><h3>${esc(o.name)}</h3><div class="slug">/${esc(o.slug)} · ${esc(o.eventName)}${o.events > 1 ? ` · ${o.events} tədbir` : ""}</div></div>
      <div class="row" style="gap:6px">${o.root ? `<span class="pill hot">Sizin</span>` : ""}${o.active ? "" : `<span class="pill warn">Deaktiv</span>`}</div></div>
    <div class="rlive" data-live="${o.id}">${liveLine(o)}</div>
    <div class="nums"><div><b>${o.teams}</b><span>komanda</span></div><div><b>${o.jurorsOnline}/${o.jurors}</b><span>münsif onlayn</span></div><div><b>${pct}%</b><span>səs (${o.progress.done}/${o.progress.need})</span></div></div>
    <div class="row">
      <button class="btn sm" data-peek="${o.id}" ${o.active ? "" : "disabled"}>${icon("expand")}Səhnə ekranına bax</button>
      <button class="btn sm primary" data-enter="${o.id}">${icon("ext")}Müdaxilə et</button>
      <details class="more"><summary class="btn sm ghost">⋯ Daha çox</summary><div class="menu">
        <a class="btn sm ghost" href="/api/root/orgs/${o.id}/history.xlsx" download>${icon("sheet")}Qiymət tarixçəsi (Excel)</a>
        <a class="btn sm ghost" href="${esc(o.links.stage)}" target="_blank" rel="noopener" data-raw>${icon("ext")}Səhnə ekranının linki</a>
        <a class="btn sm ghost" href="${esc(o.links.reveal)}" target="_blank" rel="noopener" data-raw>${icon("medal")}Nəticə ekranı</a>
        ${o.root ? "" : `<button class="btn sm ghost" data-active="${o.id}:${o.active ? 0 : 1}">${icon("power")}${o.active ? "Təşkilatı deaktiv et" : "Aktiv et"}</button>`}
      </div></details>
    </div>
    <details class="fold inner"${open === `coord:${o.id}` || open?.startsWith("reset:") && o.coordinators.some(c => open === `reset:${c.id}`) ? " open" : ""}><summary>${icon("users")}Koordinatorlar (${o.coordinators.length})</summary>
      <div class="stack" style="gap:8px">${coords}
        ${o.root ? "" : open === `coord:${o.id}` ? `<form class="inline-form" data-coord-form="${o.id}" novalidate>
          <div><label class="f" for="cu${o.id}">İstifadəçi adı</label><input type="text" id="cu${o.id}" autocapitalize="none" spellcheck="false" autocomplete="off" required></div>
          <div><label class="f" for="cp${o.id}">Şifrə (min. 8)</label><input type="password" id="cp${o.id}" autocomplete="new-password" minlength="8" required></div>
          <button class="btn primary sm" type="submit">Yarat</button><button class="btn sm" type="button" data-cancel>Ləğv et</button></form>`
          : `<button class="btn sm" data-addcoord="${o.id}" style="justify-self:start">${icon("plus")}Koordinator əlavə et</button>`}
      </div></details>
    ${confirmOff === o.id ? `<div class="confirm"><span><b>${esc(o.name)}</b> deaktiv edilsin? Koordinator, münsif və komandaların sessiyaları bağlanacaq, ictimai ekranları açılmayacaq. Data silinmir.</span>
      <button class="btn sm danger solid" data-off-yes="${o.id}">Bəli, deaktiv et</button><button class="btn sm" data-cancel>Ləğv et</button></div>` : ""}
  </section>`;
}

function render() {
  const liveN = orgs.filter(o => o.active && (o.stage.team || o.stage.show.scene === "event") && o.stage.timer.visible).length;
  main.innerHTML = `
    <section class="rhead"><div><h1>${icon("db")} Platforma</h1>
      <p class="sub">${orgs.length} təşkilat · ${liveN} canlı səhnə. Hər təşkilatın koordinatoru yalnız öz tədbirini görür; buradan hamısına baxa və müdaxilə edə bilərsiniz.</p></div>
      <button class="btn primary" id="newToggle">${icon("plus")}Yeni təşkilat</button></section>
    ${newOpen ? `<section class="card pad-lg stack section-gap" aria-labelledby="h-new">
      <h2 id="h-new">${icon("plus")}Yeni təşkilat</h2>
      <form class="inline-form" id="newOrg" novalidate>
        <div><label class="f" for="nName">Ad (tədbir brendi)</label><input type="text" id="nName" maxlength="40" placeholder="məs. Demo" required></div>
        <div><label class="f" for="nSlug">Qısa ad (linklər üçün)</label><input type="text" id="nSlug" maxlength="32" placeholder="demo" autocapitalize="none" spellcheck="false" required></div>
        <div><label class="f" for="nUser">Koordinator istifadəçi adı</label><input type="text" id="nUser" maxlength="64" autocapitalize="none" spellcheck="false" autocomplete="off"></div>
        <div><label class="f" for="nPass">Koordinator şifrəsi (min. 8)</label><input type="password" id="nPass" autocomplete="new-password"></div>
        <button class="btn primary" type="submit" id="nGo">${icon("plus")}Yarat</button>
      </form>
      <p class="sub" style="margin:0">Yeni təşkilat boş tədbirlə başlayır: standart meyarlar, təqdimat 3:00 + sual-cavab 2:00. Səhnə ekranının linki <span class="mono">/o/&lt;qısa ad&gt;/stage</span>.</p>
      <p class="err-t" id="nErr" role="alert"></p>
    </section>` : ""}
    <div class="rgrid section-gap">${orgs.map(card).join("")}</div>
    ${bkHtml()}
    ${sysCardHtml(sys, sysErr)}`;
  bind();
  bindSys();
}

// ---------- projector preview (read-only) ----------
let peekDlg: HTMLDialogElement | null = null;
function peek(o: OrgLive, what: "stage" | "reveal" = "stage") {
  if (!peekDlg) {
    peekDlg = document.createElement("dialog");
    peekDlg.className = "peek";
    document.body.appendChild(peekDlg);
    peekDlg.addEventListener("click", e => { if (e.target === peekDlg || (e.target as HTMLElement).closest("[data-close]")) peekDlg!.close(); });
    peekDlg.addEventListener("close", () => { peekDlg!.querySelector("iframe")?.remove(); });
    addEventListener("resize", () => fitPeek());
  }
  const src = `${what === "stage" ? o.links.stage : o.links.reveal}?preview=1`;
  peekDlg.innerHTML = `<div class="peek-top"><div><span class="caps">Səhnə ekranı · yalnız baxış</span><h2>${esc(o.name)}</h2></div>
      <div class="seg" role="group"><button data-peekwhat="stage" aria-pressed="${what === "stage"}">Səhnə</button><button data-peekwhat="reveal" aria-pressed="${what === "reveal"}">Nəticə ekranı</button></div>
      <button class="btn sm primary" data-enter="${o.id}">${icon("ext")}Müdaxilə et</button>
      <button class="icon-btn" data-close aria-label="Bağla">${icon("close")}</button></div>
    <div class="peek-box"><iframe title="Səhnə ekranı: ${esc(o.name)}" src="${esc(src)}" tabindex="-1"></iframe></div>`;
  peekDlg.querySelectorAll<HTMLElement>("[data-peekwhat]").forEach(b => b.addEventListener("click", () => peek(o, b.dataset.peekwhat as "stage" | "reveal")));
  peekDlg.querySelector<HTMLElement>("[data-enter]")!.addEventListener("click", () => enter(o.id));
  if (!peekDlg.open) peekDlg.showModal();
  fitPeek();
}
/** The projector page renders at 1280×720 and is scaled to the dialog, so the preview looks like the real screen. */
function fitPeek() {
  const box = peekDlg?.querySelector<HTMLElement>(".peek-box");
  const f = box?.querySelector<HTMLIFrameElement>("iframe");
  if (!box || !f) return;
  const k = Math.min(box.clientWidth / 1280, (box.clientHeight || 720) / 720);
  f.style.transform = `scale(${k})`;
  box.style.setProperty("--h", `${720 * k}px`);
}

async function enter(id: number) {
  try { const r = await api<{ redirect: string }>("/api/root/impersonate", { method: "POST", body: { orgId: id } }); location.href = r.redirect; }
  catch (ex) { toast((ex as ApiError).message, "err"); }
}

function bind() {
  $("#newToggle").addEventListener("click", () => { newOpen = !newOpen; render(); if (newOpen) $<HTMLInputElement>("#nName").focus(); });
  const nSlug = document.querySelector<HTMLInputElement>("#nSlug"), nName = document.querySelector<HTMLInputElement>("#nName");
  if (nSlug && nName) {
    nName.addEventListener("input", () => {
      if (nSlug.dataset.touched) return;
      nSlug.value = nName.value.toLowerCase().replace(/ə/g, "e").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ş/g, "s").replace(/ç/g, "c").replace(/ğ/g, "g")
        .normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
    });
    nSlug.addEventListener("input", () => { nSlug.dataset.touched = "1"; });
    $<HTMLFormElement>("#newOrg").addEventListener("submit", async e => {
      e.preventDefault();
      const err = $("#nErr");
      const username = $<HTMLInputElement>("#nUser").value.trim(), password = $<HTMLInputElement>("#nPass").value;
      if ((username && !password) || (!username && password)) { err.textContent = "Koordinator üçün həm istifadəçi adı, həm şifrə yazın (və ya ikisini də boş saxlayın)."; return; }
      const go = $<HTMLButtonElement>("#nGo");
      go.disabled = true;
      try {
        await api("/api/root/orgs", { method: "POST", body: { slug: nSlug.value.trim(), name: nName.value.trim(), ...(username ? { coordinator: { username, password } } : {}) } });
        toast("Təşkilat yaradıldı");
        newOpen = false;
        await load();
      } catch (ex) { err.textContent = ex instanceof ApiError ? ex.message : "Xəta baş verdi."; go.disabled = false; }
    });
  }
  main.querySelectorAll<HTMLElement>("[data-cancel]").forEach(b => b.addEventListener("click", () => { open = null; confirmOff = null; render(); }));
  main.querySelectorAll<HTMLElement>("[data-addcoord]").forEach(b => b.addEventListener("click", () => { open = `coord:${b.dataset.addcoord}`; render(); $<HTMLInputElement>(`#cu${b.dataset.addcoord}`).focus(); }));
  main.querySelectorAll<HTMLElement>("[data-reset]").forEach(b => b.addEventListener("click", () => { open = `reset:${b.dataset.reset}`; render(); $<HTMLInputElement>(`#rp${b.dataset.reset}`).focus(); }));
  main.querySelectorAll<HTMLFormElement>("[data-coord-form]").forEach(f => f.addEventListener("submit", async e => {
    e.preventDefault();
    const id = f.dataset.coordForm!;
    await act(`/api/root/orgs/${id}/coordinators`, "POST", { username: $<HTMLInputElement>(`#cu${id}`).value.trim(), password: $<HTMLInputElement>(`#cp${id}`).value }, "Koordinator yaradıldı");
  }));
  main.querySelectorAll<HTMLFormElement>("[data-reset-form]").forEach(f => f.addEventListener("submit", async e => {
    e.preventDefault();
    const id = f.dataset.resetForm!;
    await act(`/api/root/users/${id}/password`, "POST", { password: $<HTMLInputElement>(`#rp${id}`).value }, "Şifrə sıfırlandı, köhnə sessiyalar bağlandı");
  }));
  main.querySelectorAll<HTMLElement>("[data-uactive]").forEach(b => b.addEventListener("click", () => {
    const [id, on] = b.dataset.uactive!.split(":");
    void act(`/api/root/users/${id}`, "PATCH", { active: on === "1" }, on === "1" ? "Koordinator aktiv edildi" : "Koordinator deaktiv edildi");
  }));
  main.querySelectorAll<HTMLElement>("[data-active]").forEach(b => b.addEventListener("click", () => {
    const [id, on] = b.dataset.active!.split(":");
    if (on === "0") { confirmOff = Number(id); render(); return; }
    void act(`/api/root/orgs/${id}`, "PATCH", { active: true }, "Təşkilat aktiv edildi");
  }));
  main.querySelectorAll<HTMLElement>("[data-off-yes]").forEach(b => b.addEventListener("click", () => {
    void act(`/api/root/orgs/${b.dataset.offYes}`, "PATCH", { active: false }, "Təşkilat deaktiv edildi");
  }));
  main.querySelectorAll<HTMLElement>("[data-enter]").forEach(b => b.addEventListener("click", () => enter(Number(b.dataset.enter))));
  main.querySelectorAll<HTMLButtonElement>("[data-peek]").forEach(b => b.addEventListener("click", () => { const o = orgs.find(x => x.id === Number(b.dataset.peek)); if (o) peek(o); }));
}

// ---------- v4: "Yedəkdən import" (an old program from a backup file → a new archived program of an organisation) ----------
interface BkEvent { orgId: number; orgSlug: string; orgName: string; eventId: number; name: string; brand: string; product: string; date: string; status: string;
  teams: number; jurors: number; scores: number; history: number; files: number; firstScoreAt: number | null; lastScoreAt: number | null; imported: boolean }
interface BkFile { file: string; bytes: number; mtime: number; schema: number | null; ok: boolean; error?: string; events: BkEvent[] }
interface BkImport { id: number; orgSlug: string; orgName: string; eventId: number; eventName: string; file: string; schema: number; auto: string | null; at: number; stats: Record<string, number> }
let bkOpen = false;
let bk: { files: BkFile[]; imports: BkImport[] } | null = null;
let bkErr: string | null = null;
let bkBusy = false;
let bkPick: string | null = null; // "<file>|<orgId>|<eventId>"
const p2 = (n: number) => String(n).padStart(2, "0");
const dt = (ms: number | null) => { if (!ms) return ""; const x = new Date(ms); return `${p2(x.getDate())}.${p2(x.getMonth() + 1)}.${x.getFullYear()} ${p2(x.getHours())}:${p2(x.getMinutes())}`; };
const kb = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
async function loadBk() {
  bkBusy = true; rerenderBk();
  try { bk = await api("/api/root/backups"); bkErr = null; } catch (e) { bkErr = (e as Error).message; }
  bkBusy = false; rerenderBk();
}
function rerenderBk() { const box = document.getElementById("bk"); if (box) box.outerHTML = bkHtml(); }
function bkHtml() {
  const rows = (f: BkFile) => f.events.filter(e => e.teams || e.scores).map(e => {
    const key = `${f.file}|${e.orgId}|${e.eventId}`;
    return `<div class="bk-ev">
      <div class="bk-nm"><b>${esc(e.name)}</b><small>${esc(e.orgName)} (/${esc(e.orgSlug)}) · ${e.status === "archived" ? "arxivdə" : "aktiv idi"}${e.date ? ` · ${esc(e.date)}` : ""}</small>
        <small>${e.teams} komanda · ${e.jurors} münsif · ${e.scores} qiymət${e.lastScoreAt ? ` · son bal ${dt(e.lastScoreAt)}` : ""}</small></div>
      ${e.imported ? `<span class="pill">import edilmiş</span>` : `<button class="btn sm" data-bk-pick="${esc(key)}">${icon("download")}Import et</button>`}
      ${bkPick === key ? `<form class="inline-form bk-form" data-bk-form="${esc(key)}" novalidate>
        <div><label class="f" for="bkOrg">Hansı təşkilata</label><select id="bkOrg">${orgs.map(o => `<option value="${o.id}"${o.root ? " selected" : ""}>${esc(o.name)} (/${esc(o.slug)})</option>`).join("")}</select></div>
        <label class="check"><input type="checkbox" id="bkAudit" checked> Ballarla bağlı jurnal qeydlərini də köçür</label>
        <p class="sub" style="margin:0">Proqram arxivə yeni proqram kimi düşür. Aktiv proqrama heç nə yazılmır, münsif hesabları giriş edə bilməz.</p>
        <button class="btn primary sm" type="submit">${icon("download")}Arxiv proqram kimi import et</button><button class="btn sm" type="button" data-bk-cancel>Ləğv et</button></form>` : ""}
    </div>`;
  }).join("");
  const body = bkBusy && !bk ? `<p class="sub">Yedəklər oxunur…</p>` : bkErr ? `<div class="banner err">${esc(bkErr)}</div>` : !bk ? "" : `
    ${bk.imports.length ? `<div class="stack" style="gap:6px"><h4>Import edilənlər</h4>${bk.imports.map(i => `<div class="bk-imp">${icon("check")}<span><b>${esc(i.eventName)}</b> → ${esc(i.orgName)} · ${esc(i.file)} (v${i.schema}) · ${i.stats.teams ?? 0} komanda, ${i.stats.scores ?? 0} qiymət · ${dt(i.at)}${i.auto ? " · avtomatik" : ""}</span></div>`).join("")}</div>` : ""}
    ${bk.files.length ? bk.files.map(f => `<div class="bk-file"><div class="bk-fh"><b class="mono">${esc(f.file)}</b><small>${dt(f.mtime)} · ${kb(f.bytes)}${f.schema != null ? ` · sxem v${f.schema}` : ""}</small></div>
      ${f.ok ? rows(f) || `<p class="sub" style="margin:0">Bu faylda komandası olan proqram yoxdur.</p>` : `<p class="sub" style="margin:0">Oxunmadı: ${esc(f.error ?? "")}</p>`}</div>`).join("") : `<p class="sub">Yedək qovluğunda fayl yoxdur.</p>`}`;
  return `<section class="card pad-lg stack section-gap" id="bk" aria-labelledby="h-bk">
    <details class="fold inner" id="bkFold"${bkOpen ? " open" : ""}><summary id="h-bk">${icon("db")}Yedəkdən import</summary>
      <div class="stack">
        <p class="sub" style="margin:0">Serverdəki yedək faylları (gecəlik, yeniləmədən əvvəlki, avtomatik). Fayllar yalnız oxunur. Seçdiyiniz köhnə proqram təşkilatın tarixçəsinə arxiv proqram kimi əlavə olunur, reytinqi yedəkdəki ilə eyni qalır.</p>
        <div class="row"><button class="btn sm" type="button" id="bkReload"${bkBusy ? " disabled" : ""}>${icon("retry")}Yenidən oxu</button></div>
        ${body}
      </div></details></section>`;
}
main.addEventListener("toggle", e => {
  const d = e.target as HTMLDetailsElement;
  if (d.id !== "bkFold") return;
  bkOpen = d.open;
  if (bkOpen && !bk && !bkBusy) void loadBk();
}, true);
main.addEventListener("click", e => {
  const t = e.target as HTMLElement;
  if (t.closest("#bkReload")) { void loadBk(); return; }
  const pick = t.closest<HTMLElement>("[data-bk-pick]");
  if (pick) { bkPick = pick.dataset.bkPick!; rerenderBk(); return; }
  if (t.closest("[data-bk-cancel]")) { bkPick = null; rerenderBk(); }
});
main.addEventListener("submit", async e => {
  const f = (e.target as HTMLElement).closest<HTMLFormElement>("[data-bk-form]");
  if (!f) return;
  e.preventDefault();
  const [file, orgId, eventId] = f.dataset.bkForm!.split("|");
  const btn = f.querySelector<HTMLButtonElement>("button[type=submit]")!;
  btn.disabled = true;
  try {
    const r = await api<{ name: string; teams: number; scores: number; filesMissing: number }>("/api/root/backups/import", { method: "POST", body: {
      file, sourceOrgId: Number(orgId), sourceEventId: Number(eventId), targetOrgId: Number($<HTMLSelectElement>("#bkOrg").value), audit: $<HTMLInputElement>("#bkAudit").checked } });
    toast(`${r.name}: ${r.teams} komanda, ${r.scores} qiymət import edildi${r.filesMissing ? ` (${r.filesMissing} fayl serverdə yoxdur)` : ""}`);
    bkPick = null;
    await loadBk();
    void load();
  } catch (ex) { toast((ex as ApiError).message, "err"); btn.disabled = false; }
});

async function act(path: string, method: string, body: unknown, ok: string) {
  try {
    await api(path, { method, body });
    open = null; confirmOff = null;
    toast(ok);
    await load();
  } catch (ex) { toast(ex instanceof ApiError ? ex.message : "Xəta baş verdi.", "err"); }
}

// live: every organisation's stage changes arrive here; the timer cells tick locally from the server clock
setInterval(() => {
  for (const o of orgs) {
    const cell = document.querySelector<HTMLElement>(`[data-live="${o.id}"]`);
    if (cell && o.stage.timer.visible) cell.innerHTML = liveLine(o);
  }
}, 500);
live({
  role: "admin",
  auth: { watch: "root" },
  on: {
    "org:stage": (p: { orgId: number; stage: StagePayload }) => {
      syncClock(p.stage.serverNow);
      const o = orgs.find(x => x.id === p.orgId);
      if (!o) { void load(); return; }
      o.stage = p.stage;
      const cell = document.querySelector<HTMLElement>(`[data-live="${o.id}"]`);
      if (cell) cell.innerHTML = liveLine(o);
    },
  },
  resync: load,
  status: online => bar.setOnline(online),
});
// counts (jurors online, votes) refresh every 15 s
setInterval(() => { if (!document.hidden && !document.querySelector("form:focus-within") && !bkPick && !peekDlg?.open) void load(); }, 15_000);
void load();
