// munsif.im (coordinator): team materials review, team sign-in links (QR) and the stage view controls.
import QRCode from "qrcode";
import type { AdminTeamMaterials, StagePayload, TeamReview } from "../../../shared/types";
import { api, ApiError } from "./api";
import { ago, esc, icon, toast } from "./dom";

export interface MaterialsData {
  teams: AdminTeamMaterials[];
  settings: { teamRegistration: boolean; teamCanRename: boolean; jurorsSeeMaterials: boolean; uploadDeadline: number | null };
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

/** The "Komandaların materialları" card on the live panel. */
export function mountMaterials(card: HTMLElement, onChange: () => void = () => {}) {
  let D: MaterialsData | null = null;
  let returning: number | null = null;
  async function reload() {
    try { D = await api<MaterialsData>("/api/admin/materials"); render(); } catch (e) { card.innerHTML = `<div class="banner err">${esc((e as Error).message)}</div>`; }
  }
  function render() {
    if (!D) return;
    const waiting = D.teams.filter(t => t.review === "submitted").length;
    const pending = D.teams.filter(t => t.approval === "pending").length;
    card.innerHTML = `
      <div class="head"><div><h2 id="h-mat">${icon("doc")}Komandaların materialları</h2>
        <p class="sub">Prezentasiya və sayt linkləri. Yeni yükləmədə zəng və bildiriş gəlir. Qəbul edəndə və ya geri qaytaranda komanda dərhal xəbər tutur.</p></div>
        <div class="row">${waiting ? `<span class="pill hot">${waiting} yeni yükləmə</span>` : ""}${pending ? `<span class="pill warn">${pending} komanda təsdiq gözləyir</span>` : ""}
          <a class="btn sm" href="/admin/setup#h-teams">${icon("pencil")}Linklər və ayarlar</a></div></div>
      <div class="mat-list">${D.teams.map(t => `
        <div class="mat ${t.active ? "" : "off"} ${t.review === "submitted" ? "fresh" : ""}" data-mat="${t.teamId}">
          <div class="mat-team"><b>${esc(t.name)}</b><small>${esc(t.project || "—")}</small></div>
          <div class="mat-st">${reviewPill(t)}${t.reviewNote && t.review === "returned" ? `<small class="danger-t">${esc(t.reviewNote)}</small>` : ""}</div>
          <div class="mat-pres">${presLine(t)}</div>
          <div class="mat-links">${t.siteUrl ? `<a href="${esc(t.siteUrl)}" target="_blank" rel="noopener noreferrer">${icon("ext")}${esc(linkHost(t.siteUrl))}</a>` : `<span class="faint">Sayt yoxdur</span>`}
            ${t.videoUrl ? `<a href="${esc(t.videoUrl)}" target="_blank" rel="noopener noreferrer">${icon("play")}Video</a>` : ""}</div>
          <div class="mat-act">
            ${t.approval === "pending" ? `<button class="btn sm primary" data-mat-approve="${t.teamId}">${icon("check")}Təsdiqlə</button>` : ""}
            ${t.presentation && t.review !== "accepted" ? `<button class="btn sm primary" data-mat-accept="${t.teamId}">${icon("check")}Qəbul et</button>` : ""}
            ${t.presentation && t.review !== "returned" ? `<button class="btn sm" data-mat-return="${t.teamId}">${icon("undo")}Geri qaytar</button>` : ""}
            <button class="btn sm ghost" data-mat-link="${t.teamId}" title="Komanda giriş linki və QR">${icon("qr")}Link</button>
          </div>
          ${returning === t.teamId ? `<form class="mat-return" data-mat-form="${t.teamId}"><input name="note" maxlength="500" placeholder="Səbəb (komanda görəcək), məs. Son slayd boşdur" required>
            <button class="btn sm danger solid" type="submit">Geri qaytar</button><button class="btn sm" type="button" data-mat-cancel>Ləğv</button></form>` : ""}
        </div>`).join("") || `<p class="note">Komanda yoxdur.</p>`}</div>`;
    const f = card.querySelector<HTMLInputElement>(".mat-return input");
    f?.focus();
  }
  card.addEventListener("click", async e => {
    const t = e.target as HTMLElement;
    const id = (a: string) => Number(t.closest<HTMLElement>(`[${a}]`)?.getAttribute(a));
    try {
      if (t.closest("[data-mat-accept]")) { await api(`/api/admin/teams/${id("data-mat-accept")}/review`, { method: "POST", body: { action: "accept" } }); toast("Qəbul edildi — komandaya bildiriş getdi"); await reload(); onChange(); }
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
      returning = null; toast("Geri qaytarıldı — komandaya səbəb göndərildi"); await reload(); onChange();
    } catch (ex) { toast((ex as ApiError).message, "err"); }
  });
  return { reload, get data() { return D; } };
}

// ---------- team sign-in link dialog (/t/<code>) ----------
let dlg: HTMLDialogElement | null = null;
export async function openTeamLink(teamId: number, teamName: string, fresh = false) {
  let link: { code: string; path: string } | null = null;
  try {
    link = fresh ? await api(`/api/admin/teams/${teamId}/link`, { method: "POST", body: {} })
      : await api<{ code: string; path: string }>(`/api/admin/teams/${teamId}/link`).catch(async e => {
        if ((e as ApiError).status === 404) return api<{ code: string; path: string }>(`/api/admin/teams/${teamId}/link`, { method: "POST", body: {} });
        throw e;
      });
  } catch (e) { toast((e as ApiError).message, "err"); return; }
  const url = `${location.origin}${link!.path}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 640, color: { dark: "#0B0B14", light: "#FFFFFF" } });
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.className = "qrdlg tlink";
    document.body.appendChild(dlg);
    dlg.addEventListener("click", e => { if (e.target === dlg || (e.target as HTMLElement).closest("[data-tl-close]")) dlg!.close(); });
  }
  const local = /^(localhost|127\.|\[?::1\]?$)/.test(location.hostname);
  dlg.innerHTML = `<div class="qrwrap">
    <div class="row between" style="width:100%"><div><span class="caps">Komanda girişi</span><h2 style="margin-top:4px">${esc(teamName)}</h2></div>
      <button class="icon-btn" data-tl-close aria-label="Bağla">${icon("close")}</button></div>
    <div class="qrbox"><img src="${qr}" alt="Komanda giriş QR kodu" width="320" height="320"></div>
    <div class="tl-code mono">${esc(link!.code)}</div>
    <div class="tl-url mono">${esc(url)}</div>
    <p class="sub" style="margin:0;text-align:center">Linki komandaya göndərin (Telegram, WhatsApp, e-poçt). Komanda üzvlərinin hamısı eyni linklə daxil ola bilər.
      Kodu <b>munsif.im/team</b> səhifəsində əl ilə də yazmaq olar.</p>
    ${local ? `<p class="note warn-t">Panel localhost ünvanında açılıb — komandalar bu linkə çata bilməz. Paneli server ünvanı ilə açın.</p>` : ""}
    <div class="row" style="justify-content:center">
      <button class="btn primary" data-tl-copy>${icon("doc")}Linki kopyala</button>
      <button class="btn" data-tl-new>${icon("retry")}Yeni link</button>
      <button class="btn ghost danger" data-tl-revoke>Ləğv et</button>
    </div></div>`;
  dlg.querySelector("[data-tl-copy]")!.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(url); toast("Link kopyalandı"); } catch { toast("Kopyalamaq alınmadı — linki seçib kopyalayın", "err"); }
  });
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
  const has = !!s.team;
  const pages = sh.pres?.pages ?? 0;
  const status = !has ? "Səhnədə komanda yoxdur"
    : sh.pres ? `Prezentasiya: PDF${pages ? ` · ${pages} slayd` : ""}`
    : sh.presPending ? (sh.presPending === "running" || sh.presPending === "pending" ? "PPTX PDF-ə çevrilir…" : "PPTX göstərilə bilmir — PDF lazımdır")
    : "Prezentasiya yoxdur — səhnədə böyük taymer";
  const mode = sh.mode;
  return `<div class="showctl${compact ? " compact" : ""}">
    <div class="row between" style="gap:8px"><span class="caps">${icon("expand")}Səhnə ekranı</span><span class="sub" style="margin:0">${esc(status)}</span></div>
    <div class="row" style="gap:8px">
      <div class="seg" role="group" aria-label="Səhnə görünüşü">
        <button type="button" data-show-mode="auto" aria-pressed="${mode === "auto"}" ${has ? "" : "disabled"}>${sh.pres ? "Slaydlar" : "Avto"}</button>
        <button type="button" data-show-mode="timer" aria-pressed="${mode === "timer"}" ${has ? "" : "disabled"}>Taymer</button>
        <button type="button" data-show-mode="site" aria-pressed="${mode === "site"}" ${has && sh.site ? "" : "disabled"} title="${sh.site ? esc(sh.site.url) : "Sayt linki yoxdur"}">Sayt</button>
      </div>
      <div class="stepper slides" role="group" aria-label="Slayd">
        <button type="button" data-slide="-1" ${sh.pres && sh.slide > 1 ? "" : "disabled"} aria-label="Əvvəlki slayd">${icon("back")}</button>
        <span class="mono">${sh.pres ? `${sh.slide} / ${pages || "?"}` : "—"}</span>
        <button type="button" data-slide="1" ${sh.pres && (!pages || sh.slide < pages) ? "" : "disabled"} aria-label="Növbəti slayd">${icon("next")}</button>
      </div>
      <button class="btn sm" type="button" data-show-intro ${has ? "" : "disabled"}>${icon("sparkle")}Intro</button>
      ${compact ? "" : `<a class="btn sm ghost" href="/stage" target="_blank" rel="noopener">${icon("ext")}Səhnə ekranı</a>`}
    </div></div>`;
}

/** Click handling for showCtlHtml; `get` returns the current stage, `set` applies the server's answer. */
export function bindShowCtl(root: HTMLElement, get: () => StagePayload | null, set: (s: StagePayload) => void) {
  root.addEventListener("click", async e => {
    const t = e.target as HTMLElement;
    const m = t.closest<HTMLButtonElement>("[data-show-mode]");
    const sl = t.closest<HTMLButtonElement>("[data-slide]");
    const intro = t.closest<HTMLButtonElement>("[data-show-intro]");
    if ((!m && !sl && !intro) || (m ?? sl ?? intro)!.disabled) return;
    const s = get();
    const body = m ? { mode: m.dataset.showMode } : sl ? { slide: Math.max(1, (s?.show.slide ?? 1) + Number(sl.dataset.slide)) } : { intro: true };
    try {
      const r = await api<{ stage: StagePayload }>("/api/admin/stage", { method: "PATCH", body });
      set(r.stage);
      if (intro) toast("Intro səhnədə göstərilir");
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
    <div class="row between"><h3 id="h-tacc">Komanda girişi və materiallar</h3><span class="saved" id="taSaved"></span></div>
    <p class="sub" style="margin:0">Hər komandaya giriş linki (QR) verin: komanda <b>/t/kod</b> linki ilə daxil olur, prezentasiyasını (PDF${D.soffice ? " və ya PPTX" : ""}, maks. ${D.maxUploadMb} MB), sayt və video linkini yükləyir.
      Bal və reytinq komandalara heç vaxt göstərilmir.${D.soffice ? "" : " <b>Serverdə LibreOffice yoxdur</b> — komandalardan PDF istəyin."}</p>
    ${sw("teamRegistration", s.teamRegistration, "Açıq qeydiyyat", "Komandalar özləri qeydiyyatdan keçə bilər (munsif.im/team). Yeni komanda “təsdiq gözləyir” statusunda yaranır və siz təsdiqləyənə qədər sıraya düşmür.")}
    ${sw("teamCanRename", s.teamCanRename, "Komanda adını özü dəyişə bilsin", "Bağlı olanda komanda və layihə adını yalnız siz dəyişirsiniz.")}
    ${sw("jurorsSeeMaterials", s.jurorsSeeMaterials, "Münsiflər materialları görsün", "Münsif panelində komandanın prezentasiyası və saytı üçün baxış linki görünür.")}
    <div class="toggle"><div><b>Yükləmə deadline-ı</b><small>Bu vaxtdan sonra komandalar fayl və link dəyişə bilmir (bir saat qalmış xatırlatma gedir). Boş = deadline yoxdur.</small></div>
      <div class="row" style="flex-wrap:nowrap;gap:6px"><input type="datetime-local" id="taDeadline" value="${dtLocal(s.uploadDeadline)}" style="width:auto">
      ${s.uploadDeadline ? `<button class="btn sm ghost" type="button" data-tset-clear>Sil</button>` : ""}</div></div>
    <div class="tacc">${D.teams.map((t, i) => `
      <div class="tacc-row ${t.active ? "" : "off"}">
        <span class="ix mono">${i + 1}</span>
        <div class="mid"><b>${esc(t.name)}</b><small>${t.approval === "pending" ? `<span class="warn-t">Təsdiq gözləyir</span> · ` : ""}${t.link ? `Link: <span class="mono">${esc(t.link.code ?? "••••")}</span> · ${t.sessions} sessiya` : "Link yaradılmayıb"} · ${REVIEW_LABEL[t.review]}</small></div>
        ${t.approval === "pending" ? `<button class="btn sm primary" type="button" data-mat-approve="${t.teamId}">${icon("check")}Təsdiqlə</button>` : ""}
        <button class="btn sm ${t.link ? "" : "primary"}" type="button" data-tlink="${t.teamId}">${icon("qr")}${t.link ? "Link / QR" : "Link yarat"}</button>
      </div>`).join("")}</div>`;
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
