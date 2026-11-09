// munsif.im (coordinator): team materials review, team sign-in links (QR) and the stage view controls.
import QRCode from "qrcode";
import { bindShare, shareHtml } from "./share";
import type { AdminTeamMaterials, EventFile, StagePayload, TeamReview } from "../../../shared/types";
import { openViewer } from "./viewer";
import { api, ApiError } from "./api";
import { ago, esc, icon, toast } from "./dom";
import { showLinkQr } from "./qr";

export interface MaterialsData {
  teams: AdminTeamMaterials[];
  settings: { teamRegistration: boolean; teamCanRename: boolean; jurorsSeeMaterials: boolean; uploadDeadline: number | null };
  /** v14: the shared team link (every team picks its name), or null. */
  pick: { code: string; path: string } | null;
  soffice: boolean;
  maxUploadMb: number;
}

export const REVIEW_LABEL: Record<TeamReview, string> = { none: "Yükləməyib", submitted: "Yeni yükləmə", accepted: "Qəbul edildi", returned: "Geri qaytarıldı" };
const reviewPill = (t: AdminTeamMaterials) =>
  t.approval === "pending" ? `<span class="pill warn">Təsdiq gözləyir</span>`
  : t.review === "accepted" ? `<span class="pill ok">${icon("check")}Qəbul edildi</span>`
  : t.review === "submitted" ? `<span class="pill hot">Yeni yükləmə</span>`
  : t.review === "returned" ? `<span class="pill danger">Geri qaytarıldı</span>`
  : `<span class="pill">Yükləməyib</span>`;
const fmtSize = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
export const presLine = (t: AdminTeamMaterials) => {
  const p = t.presentation;
  if (!p) return `<span class="faint">Prezentasiya yoxdur</span>`;
  const conv = p.ext === "pptx" ? (p.conv === "done" ? "PPTX → PDF" : p.conv === "running" || p.conv === "pending" ? "PPTX çevrilir…" : "PPTX (PDF-ə çevrilmədi)") : "PDF";
  return `<a class="mat-file" href="${p.url}" target="_blank" rel="noopener">${icon("doc")}<span>${esc(p.name)}</span></a>
    <small>${conv}${p.pages ? ` · ${p.pages} slayd` : ""} · ${fmtSize(p.size)} · ${ago(p.createdAt)}${p.uploadedBy === "admin" ? " · admin" : ""}</small>`;
};
const linkHost = (u: string) => { try { return new URL(u).host; } catch { return u; } };

export interface MaterialsOpts {
  /** v3: the team on stage (its row shows "Səhnədədir" instead of "Səhnəyə çıxar"). */
  currentTeam?: () => number | null;
  putOnStage?: (teamId: number) => Promise<void> | void;
}

/**
 * The "Komandalar" tab of the live panel (v3): one row per team — open its presentation full screen with one click,
 * open its website, put it on stage. Accepting / returning a presentation is optional and sits under "⋯".
 */
export function mountMaterials(card: HTMLElement, onChange: () => void = () => {}, opts: MaterialsOpts = {}) {
  let D: MaterialsData | null = null;
  let returning: number | null = null;
  async function reload() {
    try { D = await api<MaterialsData>("/api/admin/materials"); render(); } catch (e) { card.innerHTML = `<div class="banner err">${esc((e as Error).message)}</div>`; }
  }
  function render() {
    if (!D) return;
    const waiting = D.teams.filter(t => t.review === "submitted").length;
    const pending = D.teams.filter(t => t.approval === "pending").length;
    const cur = opts.currentTeam?.() ?? null;
    const withPres = D.teams.filter(t => t.active && t.presentation).length;
    card.innerHTML = `
      <div class="head"><div><h2 id="h-mat">${icon("list")}Komandalar</h2>
        <p class="sub">Prezentasiyaya bir kliklə tam ekranda baxın (slaydlar arası ← →). Səhnəyə çıxarmaq üçün “qəbul et” lazım deyil.</p></div>
        <div class="row">${waiting ? `<span class="pill hot">${waiting} yeni yükləmə</span>` : ""}${pending ? `<span class="pill warn">${pending} təsdiq gözləyir</span>` : ""}
          <span class="pill">${withPres}/${D.teams.filter(t => t.active).length} prezentasiya</span>
          <a class="btn sm" href="/admin/qr#teams">${icon("qr")}Bütün QR kodlar</a>
          <a class="btn sm ghost" href="/admin/setup#h-teams">${icon("pencil")}Redaktə</a></div></div>
      <div class="tl">${D.teams.map(t => {
        const p = t.presentation;
        const onStage = cur === t.teamId;
        return `
        <div class="tl-row ${t.active ? "" : "off"} ${onStage ? "on" : ""} ${t.review === "submitted" ? "fresh" : ""}" data-mat="${t.teamId}">
          <span class="tl-ix mono">${t.orderIndex + 1}</span>
          <div class="tl-name"><b>${esc(t.name)}</b><small>${esc(t.project)}</small></div>
          <div class="tl-st">${reviewPill(t)}${p ? `<small>${p.ext.toUpperCase()}${p.pages ? ` · ${p.pages} slayd` : ""}${p.ext === "pptx" && p.conv !== "done" ? (p.conv === "running" || p.conv === "pending" ? " · çevrilir…" : " · PDF lazımdır") : ""}</small>` : ""}</div>
          <div class="tl-act">
            <button class="btn sm ${p?.viewable ? "primary" : ""}" data-mat-view="${t.teamId}" ${p?.viewable ? "" : "disabled"} title="${p ? esc(p.name) : "Prezentasiya yoxdur"}">${icon("expand")}Bax</button>
            ${t.siteUrl ? `<a class="btn sm" href="${esc(t.siteUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(t.siteUrl)}">${icon("ext")}Sayt</a>` : `<span class="btn sm ghost" aria-disabled="true" title="Sayt linki yoxdur">${icon("ext")}Sayt</span>`}
            ${t.active ? (onStage ? `<span class="pill fill">Səhnədədir</span>` : `<button class="btn sm" data-mat-stage="${t.teamId}">${icon("play")}Səhnəyə</button>`) : ""}
            <button class="btn sm" data-mat-link="${t.teamId}" title="Giriş linki və QR" aria-label="${esc(t.name)}: giriş linki və QR">${icon("qr")}QR</button>
            <details class="more"><summary class="btn sm ghost" aria-label="Daha çox">⋯</summary><div class="menu">
              ${t.approval === "pending" ? `<button class="btn sm primary" data-mat-approve="${t.teamId}">${icon("check")}Təsdiqlə</button>` : ""}
              ${p && t.review !== "accepted" ? `<button class="btn sm" data-mat-accept="${t.teamId}">${icon("check")}Qəbul et</button>` : ""}
              ${p && t.review !== "returned" ? `<button class="btn sm" data-mat-return="${t.teamId}">${icon("undo")}Geri qaytar</button>` : ""}
              ${p ? `<a class="btn sm ghost" href="${p.url}?orig=1&download=1">${icon("download")}Faylı endir</a>` : ""}
              ${t.videoUrl ? `<a class="btn sm ghost" href="${esc(t.videoUrl)}" target="_blank" rel="noopener noreferrer">${icon("play")}Demo video</a>` : ""}
            </div></details>
          </div>
          ${t.reviewNote && t.review === "returned" ? `<small class="tl-note danger-t">Səbəb: ${esc(t.reviewNote)}</small>` : ""}
          ${returning === t.teamId ? `<form class="mat-return" data-mat-form="${t.teamId}"><input name="note" maxlength="500" placeholder="Səbəb (komanda görəcək), məs. Son slayd boşdur" required>
            <button class="btn sm danger solid" type="submit">Geri qaytar</button><button class="btn sm" type="button" data-mat-cancel>Ləğv</button></form>` : ""}
        </div>`;
      }).join("") || `<p class="note">Komanda yoxdur. Quraşdırmada komanda əlavə edin.</p>`}</div>`;
    const f = card.querySelector<HTMLInputElement>(".mat-return input");
    f?.focus();
  }
  card.addEventListener("click", async e => {
    const t = e.target as HTMLElement;
    const id = (a: string) => Number(t.closest<HTMLElement>(`[${a}]`)?.getAttribute(a));
    try {
      if (t.closest("[data-mat-view]")) {
        const tm = D?.teams.find(x => x.teamId === id("data-mat-view"));
        if (tm?.presentation?.viewable) {
          openViewer({ url: tm.presentation.url, title: tm.name, subtitle: [tm.project, tm.presentation.name].filter(Boolean).join(" · "), siteUrl: tm.siteUrl || null,
            actions: tm.active && opts.putOnStage && opts.currentTeam?.() !== tm.teamId ? `<button class="btn sm primary" data-pv-act="stage">${icon("play")}Səhnəyə çıxar</button>` : "",
            onAction: async a => { if (a === "stage") { await opts.putOnStage?.(tm.teamId); render(); } } });
        }
      }
      else if (t.closest("[data-mat-stage]")) { await opts.putOnStage?.(id("data-mat-stage")); render(); }
      else if (t.closest("[data-mat-accept]")) { await api(`/api/admin/teams/${id("data-mat-accept")}/review`, { method: "POST", body: { action: "accept" } }); toast("Qəbul edildi, komandaya bildiriş getdi"); await reload(); onChange(); }
      else if (t.closest("[data-mat-return]")) { returning = id("data-mat-return"); render(); }
      else if (t.closest("[data-mat-cancel]")) { returning = null; render(); }
      else if (t.closest("[data-mat-approve]")) { await api(`/api/admin/teams/${id("data-mat-approve")}/approve`, { method: "POST", body: {} }); toast("Komanda təsdiqləndi"); await reload(); onChange(); }
      else if (t.closest("[data-mat-link]")) { const tid = id("data-mat-link"); await openTeamLink(tid, D?.teams.find(x => x.teamId === tid)?.name ?? ""); await reload(); }
    } catch (ex) { toast((ex as ApiError).message, "err"); }
  });
  card.addEventListener("submit", async e => {
    const f = (e.target as HTMLElement).closest<HTMLFormElement>("[data-mat-form]");
    if (!f) return;
    e.preventDefault();
    const note = (f.elements.namedItem("note") as HTMLInputElement).value.trim();
    try {
      await api(`/api/admin/teams/${f.dataset.matForm}/review`, { method: "POST", body: { action: "return", note } });
      returning = null; toast("Geri qaytarıldı, səbəb komandaya göndərildi"); await reload(); onChange();
    } catch (ex) { toast((ex as ApiError).message, "err"); }
  });
  return { reload, render, get data() { return D; } };
}

// ---------- team sign-in link dialog (/t/<code>) ----------
let dlg: HTMLDialogElement | null = null;
export async function openTeamLink(teamId: number, teamName: string, fresh = false) {
  let link: { code: string | null; path: string | null } | null = null;
  try {
    if (!fresh) link = await api<{ code: string | null; path: string | null }>(`/api/admin/teams/${teamId}/link`);
    if (fresh || !link?.code) link = await api<{ code: string; path: string }>(`/api/admin/teams/${teamId}/link`, { method: "POST", body: {} });
  } catch (e) { toast((e as ApiError).message, "err"); return; }
  const url = `${location.origin}${link!.path}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 640, color: { dark: "#0B0B14", light: "#FFFFFF" } });
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "qrdlg tlink";
    document.body.appendChild(dlg);
    dlg.addEventListener("click", e => { if (e.target === dlg || (e.target as HTMLElement).closest("[data-tl-close]")) dlg!.close(); });
    bindShare(dlg);
  }
  const local = /^(localhost|127\.|\[?::1\]?$)/.test(location.hostname);
  dlg.innerHTML = `<div class="qrwrap">
    <div class="row between" style="width:100%"><div><span class="caps">Komanda girişi</span><h2 style="margin-top:4px">${esc(teamName)}</h2></div>
      <button class="icon-btn" data-tl-close aria-label="Bağla">${icon("close")}</button></div>
    <div class="qrbox"><img src="${qr}" alt="Komanda giriş QR kodu" width="320" height="320"></div>
    <div class="tl-code mono">${esc(link!.code)}</div>
    <div class="tl-url mono">${esc(url)}</div>
    ${shareHtml(url, `${teamName}: komanda giriş linki`)}
    <p class="sub" style="margin:0;text-align:center">Linki komandaya göndərin. Komanda üzvlərinin hamısı eyni linklə daxil ola bilər.
      Kodu <b>munsif.im/team</b> səhifəsində əl ilə də yazmaq olar.</p>
    ${local ? `<p class="note warn-t">Panel localhost ünvanında açılıb, komandalar bu linkə çata bilməz. Paneli server ünvanı ilə açın.</p>` : ""}
    <div class="row" style="justify-content:center">
      <button class="btn" data-tl-new>${icon("retry")}Yeni link</button>
      <button class="btn ghost danger" data-tl-revoke>Ləğv et</button>
    </div></div>`;
  dlg.querySelector("[data-tl-new]")!.addEventListener("click", async () => {
    if (!confirm("Yeni link yaradılsın? Köhnə link işləməyəcək (artıq daxil olmuş komanda üzvləri çıxmır).")) return;
    dlg!.close(); await openTeamLink(teamId, teamName, true);
  });
  dlg.querySelector("[data-tl-revoke]")!.addEventListener("click", async () => {
    if (!confirm("Link ləğv edilsin və komandanın bütün sessiyaları bağlansın?")) return;
    try { await api(`/api/admin/teams/${teamId}/link`, { method: "DELETE" }); toast("Link ləğv edildi"); dlg!.close(); } catch (e) { toast((e as ApiError).message, "err"); }
  });
  if (!dlg.open) dlg.showModal();
}

// ---------- stage view controls (live panel + phone remote) ----------
export function showCtlHtml(s: StagePayload | null, compact = false) {
  if (!s) return "";
  const sh = s.show;
  const ev = sh.scene === "event";
  const has = !!s.team;
  const pages = ev ? sh.eventPres?.pages ?? 0 : sh.pres?.pages ?? 0;
  const slide = ev ? sh.eventSlide : sh.slide;
  const deck = ev ? !!sh.eventPres : !!sh.pres;
  const status = ev ? `Proqramın prezentasiyası: ${sh.eventPres?.title ?? ""}`
    : !has ? "Səhnədə komanda yoxdur"
    : sh.pres ? `Prezentasiya: PDF${pages ? ` · ${pages} slayd` : ""}`
    : sh.presPending ? (sh.presPending === "running" || sh.presPending === "pending" ? "PPTX PDF-ə çevrilir…" : "PPTX açılmadı, PDF lazımdır")
    : "Prezentasiya yoxdur, səhnə ekranında böyük taymer görünür";
  const mode = sh.mode;
  return `<div class="showctl${compact ? " compact" : ""}${ev ? " evscene" : ""}">
    <div class="row between" style="gap:8px"><span class="caps">${icon("expand")}Səhnə ekranında</span><span class="sub" style="margin:0">${esc(status)}</span></div>
    <div class="row" style="gap:8px">
      ${ev ? `<button class="btn sm primary" type="button" data-ev-back>${icon("back")}Komandaya qayıt</button>` : `<div class="seg" role="group" aria-label="Səhnə görünüşü">
        <button type="button" data-show-mode="auto" aria-pressed="${mode === "auto"}" ${has ? "" : "disabled"}>${sh.pres ? "Slaydlar" : "Avto"}</button>
        <button type="button" data-show-mode="timer" aria-pressed="${mode === "timer"}" ${has ? "" : "disabled"}>Taymer</button>
        <button type="button" data-show-mode="site" aria-pressed="${mode === "site"}" ${has && sh.site ? "" : "disabled"} title="${sh.site ? esc(sh.site.url) : "Sayt linki yoxdur"}">Sayt</button>
      </div>`}
      <div class="stepper slides" role="group" aria-label="Slayd">
        <button type="button" data-slide="-1" ${deck && slide > 1 ? "" : "disabled"} aria-label="Əvvəlki slayd">${icon("back")}</button>
        <span class="mono">${deck ? `${slide} / ${pages || "?"}` : "-"}</span>
        <button type="button" data-slide="1" ${deck && (!pages || slide < pages) ? "" : "disabled"} aria-label="Növbəti slayd">${icon("next")}</button>
      </div>
      ${ev ? "" : `<button class="btn sm" type="button" data-show-intro ${has ? "" : "disabled"}>${icon("sparkle")}Anons</button>`}
      ${compact ? "" : `<a class="btn sm ghost" href="/stage" target="_blank" rel="noopener">${icon("ext")}Səhnə ekranı</a>`}
    </div></div>`;
}

/** v3: the event's own presentations — put one on the projector (no team, timer bubble optional), back to the team. */
export function eventCtlHtml(s: StagePayload | null, files: EventFile[], compact = false) {
  if (!s) return "";
  const sh = s.show;
  const on = sh.scene === "event" ? sh.eventPres?.fileId ?? null : null;
  return `<div class="head"><div><h2 id="h-scene">${icon("doc")}Proqramın prezentasiyası</h2>
      ${compact ? "" : `<p class="sub">Açılış, fasilə, sponsorlar və qaydalar üçün. Səhnə ekranında komandasız göstərilir, slaydları ← →, pult və ya klikerlə çevirirsiniz.</p>`}</div>
      ${compact ? "" : `<a class="btn sm ghost" href="/admin/setup#h-evfiles">${icon("plus")}Yüklə / idarə et</a>`}</div>
    ${files.length ? `<div class="evf">${files.map(f => `<div class="evf-row ${on === f.id ? "on" : ""}">
        <span class="evf-t"><b>${esc(f.title)}</b><small>${f.ext.toUpperCase()}${f.pages ? ` · ${f.pages} slayd` : ""}${f.viewable ? "" : f.conv === "running" || f.conv === "pending" ? " · PDF-ə çevrilir…" : " · açılmadı (PDF yükləyin)"}</small></span>
        ${compact ? "" : `<button class="btn sm ghost" type="button" data-ev-preview="${f.id}" ${f.viewable ? "" : "disabled"}>${icon("expand")}Bax</button>`}
        ${on === f.id ? `<span class="pill live">Ekranda</span>` : `<button class="btn sm ${on ? "" : "primary"}" type="button" data-ev-show="${f.id}" ${f.viewable ? "" : "disabled"}>${icon("play")}Ekrana çıxar</button>`}
      </div>`).join("")}</div>
      <div class="toggle" style="border-top:0;padding:0"><div><b>Taymer dairəsini göstər</b><small>Proqramın prezentasiyası üstündə taymer (adətən lazım olmur)</small></div>
        <button type="button" class="sw" role="switch" data-ev-bubble aria-checked="${sh.bubble}" aria-label="Taymer dairəsini göstər"></button></div>
      ${on ? `<div class="row"><button class="btn sm" type="button" data-ev-back>${icon("back")}Komandaya qayıt</button></div>` : ""}`
    : `<p class="note">Hələ proqramın prezentasiyası yoxdur. <a href="/admin/setup#h-evfiles">Quraşdırma → Proqramın prezentasiyası</a> bölməsindən PDF / PPTX yükləyin.</p>`}`;
}

/** Click handling for showCtlHtml / eventCtlHtml; `get` returns the current stage, `set` applies the server's answer. */
export function bindShowCtl(root: HTMLElement, get: () => StagePayload | null, set: (s: StagePayload) => void, extra: { preview?: (fileId: number) => void } = {}) {
  root.addEventListener("click", async e => {
    const t = e.target as HTMLElement;
    const m = t.closest<HTMLButtonElement>("[data-show-mode]");
    const sl = t.closest<HTMLButtonElement>("[data-slide]");
    const intro = t.closest<HTMLButtonElement>("[data-show-intro]");
    const evShow = t.closest<HTMLButtonElement>("[data-ev-show]");
    const evBack = t.closest<HTMLButtonElement>("[data-ev-back]");
    const evBubble = t.closest<HTMLButtonElement>("[data-ev-bubble]");
    const evPrev = t.closest<HTMLButtonElement>("[data-ev-preview]");
    if (evPrev && !evPrev.disabled) { extra.preview?.(Number(evPrev.dataset.evPreview)); return; }
    const btn = m ?? sl ?? intro ?? evShow ?? evBack ?? evBubble;
    if (!btn || btn.disabled) return;
    const s = get();
    const body = m ? { mode: m.dataset.showMode } : sl ? { delta: Number(sl.dataset.slide) } : evShow ? { eventFile: Number(evShow.dataset.evShow), scene: "event" }
      : evBack ? { scene: "team" } : evBubble ? { bubble: !(s?.show.bubble ?? false) } : { intro: true };
    try {
      const r = await api<{ stage: StagePayload }>("/api/admin/stage", { method: "PATCH", body });
      set(r.stage);
      if (intro) toast("Anons səhnə ekranında göstərilir");
      if (evShow) toast("Proqramın prezentasiyası səhnə ekranında");
      if (evBack) toast("Səhnə ekranı komandaya qayıtdı");
    } catch (ex) { toast((ex as ApiError).message, "err"); }
  });
}

// ---------- Setup: team access (links, open registration, permissions, deadline) ----------
const dtLocal = (ms: number | null) => {
  if (!ms) return "";
  const d = new Date(ms); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export function teamAccessHtml(D: MaterialsData | null) {
  if (!D) return `<p class="sub">Yüklənir…</p>`;
  const s = D.settings;
  const sw = (id: string, on: boolean, label: string, hint: string) => `<div class="toggle"><div><b>${label}</b><small>${hint}</small></div>
    <button type="button" class="sw" role="switch" data-tset="${id}" aria-checked="${on}" aria-label="${label}"></button></div>`;
  return `
    <div class="row between"><h3 id="h-tacc">Komanda girişi</h3></div>
    <p class="sub" style="margin:0">Hər komandaya giriş linki (QR) verin: komanda <b>/t/kod</b> linki ilə daxil olur, prezentasiyasını (PDF${D.soffice ? " və ya PPTX" : ""}, maks. ${D.maxUploadMb} MB), sayt və video linkini yükləyir.
      Bal və reytinq komandalara heç vaxt göstərilmir.${D.soffice ? "" : " <b>Serverdə LibreOffice yoxdur</b>, komandalardan PDF istəyin."}</p>
    ${pickHtml(D)}
    ${sw("teamRegistration", s.teamRegistration, "Açıq qeydiyyat", "Komandalar özləri qeydiyyatdan keçə bilər (munsif.im/team). Yeni komanda “təsdiq gözləyir” statusunda yaranır və siz təsdiqləyənə qədər sıraya düşmür.")}
    ${sw("teamCanRename", s.teamCanRename, "Komanda adını özü dəyişə bilsin", "Bağlı olanda komanda və layihə adını yalnız siz dəyişirsiniz.")}
    ${sw("jurorsSeeMaterials", s.jurorsSeeMaterials, "Münsiflər materialları görsün", "Münsif panelində komandanın prezentasiyası və saytı üçün baxış linki görünür.")}
    <p class="sub" style="margin:0">Hər komandanın giriş linki (QR) yuxarıda, “Komandalar” bölməsində komandanı açanda görünür. Son tarix “Yükləmə üçün son tarix” bölməsindədir.</p>`;
}
/** v14: one link / QR for every team: the team scans it and picks its own name from the list. */
function pickHtml(D: MaterialsData) {
  const teams = D.teams.filter(t => t.active);
  const done = teams.filter(t => t.claimedAt);
  const url = D.pick ? `${location.origin}${D.pick.path}` : "";
  return `<div class="pickbox">
    <div><b>Ümumi komanda linki (bir QR hamı üçün)</b>
      <p class="sub" style="margin:2px 0 0">Bir QR kodu ekrana çıxarın və ya linki qrupa göndərin: hər komanda skan edib siyahıdan öz adını seçir.
        Seçilən komanda bağlanır, başqası onun adından daxil ola bilməz. Komandanın digər üzvləri paneldə görünən komanda kodu ilə daxil olur.</p></div>
    ${D.pick ? `<div class="row" style="gap:8px;align-items:center"><span class="pb-code">${esc(D.pick.code)}</span><span class="tl-url mono" style="font-size:12.5px;color:var(--muted);overflow-wrap:anywhere">${esc(url)}</span></div>
      <div class="row" style="gap:8px">
        <button type="button" class="btn sm primary" data-pick-qr>${icon("qr")}QR göstər</button>
        <button type="button" class="btn sm" data-pick-copy>${icon("doc")}Linki kopyala</button>
        <button type="button" class="btn sm ghost" data-pick-new>${icon("retry")}Yeni link</button>
        <button type="button" class="btn sm ghost danger" data-pick-off>Söndür</button>
      </div>
      <div><span class="caps">Daxil olub: ${done.length} / ${teams.length}</span>
        <div class="pb-teams" style="margin-top:6px">${teams.map(t => t.claimedAt
          ? `<span class="pb-t">${icon("check")}${esc(t.name)}<button type="button" data-unclaim="${t.teamId}" title="Səhv seçilibsə: komanda ümumi linkdə yenidən seçilə bilsin">Sıfırla</button></span>`
          : `<span class="pb-t off">${esc(t.name)}</span>`).join("") || `<span class="sub">Hələ komanda yoxdur.</span>`}</div></div>`
    : `<div><button type="button" class="btn sm primary" data-pick-new>${icon("qr")}Ümumi link yarat</button></div>`}
  </div>`;
}

export function bindTeamAccess(root: HTMLElement, getData: () => MaterialsData | null, reload: () => Promise<void>) {
  const flash = () => { const s = document.getElementById("taSaved"); if (s) { s.textContent = "Saxlanıldı"; setTimeout(() => { s.textContent = ""; }, 1800); } };
  const save = async (body: Record<string, unknown>) => {
    try { await api("/api/admin/settings/teams", { method: "PATCH", body }); await reload(); flash(); } catch (e) { toast((e as ApiError).message, "err"); }
  };
  root.addEventListener("click", async e => {
    const t = e.target as HTMLElement;
    const sw = t.closest<HTMLElement>("[data-tset]");
    if (sw) { await save({ [sw.dataset.tset!]: sw.getAttribute("aria-checked") !== "true" }); return; }
    if (t.closest("[data-tset-clear]")) { await save({ uploadDeadline: null }); return; }
    // v14: shared team link
    const D = getData();
    if (t.closest("#teamAccess [data-pick-new]")) {
      if (D?.pick && !confirm("Yeni ümumi link yaradılsın? Köhnə link və QR işləməyəcək (daxil olmuş komandalar çıxmır).")) return;
      try { await api("/api/admin/team-pick", { method: "POST", body: {} }); toast("Ümumi komanda linki hazırdır"); await reload(); } catch (ex) { toast((ex as ApiError).message, "err"); }
      return;
    }
    if (t.closest("#teamAccess [data-pick-off]")) {
      if (!confirm("Ümumi link söndürülsün? Link və QR işləməyəcək. Komandaların öz linkləri işləməyə davam edir.")) return;
      try { await api("/api/admin/team-pick", { method: "DELETE" }); toast("Ümumi link söndürüldü"); await reload(); } catch (ex) { toast((ex as ApiError).message, "err"); }
      return;
    }
    if (t.closest("#teamAccess [data-pick-qr]") && D?.pick) {
      await showLinkQr({ title: "Komanda girişi", heading: "Komandanızı seçib daxil olun", path: D.pick.path,
        note: "Telefonun kamerası ilə skan edin və siyahıdan öz komandanızı seçin. Komandanın digər üzvləri paneldəki komanda kodu ilə daxil olur." });
      return;
    }
    if (t.closest("#teamAccess [data-pick-copy]") && D?.pick) {
      try { await navigator.clipboard.writeText(`${location.origin}${D.pick.path}`); toast("Link kopyalandı"); } catch { toast("Kopyalamaq alınmadı, linki əl ilə seçin", "err"); }
      return;
    }
    const uc = t.closest<HTMLElement>("#teamAccess [data-unclaim]");
    if (uc) {
      const name = D?.teams.find(x => x.teamId === Number(uc.dataset.unclaim))?.name ?? "";
      if (!confirm(`“${name}” ümumi linkdə yenidən seçilə bilsin? (Səhv komanda seçilibsə.) Açıq sessiyalar qalır, onları komandanın linkindən bağlaya bilərsiniz.`)) return;
      try { await api(`/api/admin/teams/${uc.dataset.unclaim}/unclaim`, { method: "POST", body: {} }); await reload(); } catch (ex) { toast((ex as ApiError).message, "err"); }
      return;
    }
    const l = t.closest<HTMLElement>("[data-tlink]");
    if (l) { const id = Number(l.dataset.tlink); await openTeamLink(id, getData()?.teams.find(x => x.teamId === id)?.name ?? ""); await reload(); return; }
    const ap = t.closest<HTMLElement>("#teamAccess [data-mat-approve]");
    if (ap) { try { await api(`/api/admin/teams/${ap.dataset.matApprove}/approve`, { method: "POST", body: {} }); toast("Komanda təsdiqləndi"); await reload(); } catch (ex) { toast((ex as ApiError).message, "err"); } }
  });
  root.addEventListener("change", async e => {
    const i = e.target as HTMLInputElement;
    if (i.id !== "taDeadline") return;
    const ms = i.value ? new Date(i.value).getTime() : null;
    await save({ uploadDeadline: ms && Number.isFinite(ms) ? ms : null });
  });
}
