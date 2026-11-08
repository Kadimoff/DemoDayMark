import "./styles.css";
import { brandName, isPlaceholderName, PRODUCTS } from "../../shared/brand";
import { sortable } from "./lib/sortable";
import { fmtClock } from "../../shared/timer";
import type { AdminTeam, Criterion, Juror, ScoreRow, StagePayload, TimerState } from "../../shared/types";
import { api, ApiError } from "./lib/api";
import { $, esc, icon, initials, toast } from "./lib/dom";
import { createJuror, jurorJoined, onQrChange, reissue } from "./lib/qr";
import { live } from "./lib/socket";
import { brandHtml, topbar } from "./lib/topbar";
import { bindTeamAccess, teamAccessHtml, type MaterialsData } from "./lib/materials";
import { noticeBell } from "./lib/notices";
import type { EventFile, Notice } from "../../shared/types";
import { openViewer } from "./lib/viewer";
import { presLine } from "./lib/materials";

interface EventState {
  name: string; date: string; currentTeamId: number | null; timer: TimerState; locked: boolean; showJurorTotal: boolean;
  includeEntry: boolean; entryMax: number; feedbackTags: string[]; revealTop: number; product: string;
  last5Fx: boolean; stageSound: boolean; teamSlideControl: boolean;
}
interface EventItem { id: number; name: string; status: "active" | "archived"; createdAt: number; archivedAt: number | null; teams: number; jurors: number; scores: number;
  top: Array<{ rank: number | null; name: string; score: number | null }> }
interface SetupState { event: EventState; stage: StagePayload; teams: AdminTeam[]; criteria: Criterion[]; scores: ScoreRow[] }

/** 41.666… → "41.67"; null → "" (input value). */
const entryValue = (v: number | null) => (v == null ? "" : String(Math.round(v * 100) / 100));
type JurorRow = Juror & { sessionCount: number; claimed: boolean };

const bar = topbar({
  role: "admin",
  nav: [
    { href: "/admin", label: "Canlı panel", short: "Panel", icon: "users" },
    { href: "/admin/setup", label: "Quraşdırma", icon: "pencil", current: true },
    { href: "/admin/pult", label: "Pult", icon: "timer" },
    { href: "/stage", label: "Səhnə", icon: "expand", external: true },
    { href: "/reveal", label: "Nəticə açıqlaması", short: "Nəticə", icon: "medal", external: true },
  ],
  wide: true,
});
const bell = noticeBell($("#bellSlot"), { list: "/api/admin/notices", read: "/api/admin/notices/read" });
void bell.refresh();
let MAT: MaterialsData | null = null;
let EVENTS: EventItem[] = [];
let EF: EventFile[] = [];
let EFM = { soffice: false, maxUploadMb: 50 };
const typing = () => { const a = document.activeElement as HTMLElement | null; return !!a && main.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
async function loadAccess() {
  try { MAT = await api<MaterialsData>("/api/admin/materials"); } catch { /* shown on next load */ }
  if (S && !typing()) { render(); return; }
  const box = document.getElementById("teamAccess");
  if (box) box.innerHTML = teamAccessHtml(MAT);
}
async function loadEventFiles() {
  try { const r = await api<{ files: EventFile[]; soffice: boolean; maxUploadMb: number }>("/api/admin/event-files"); EF = r.files; EFM = { soffice: r.soffice, maxUploadMb: r.maxUploadMb }; } catch { /* next time */ }
  if (S && !typing()) render();
}
const main = $("#main");

let S: SetupState | null = null;
let jumped = false;
let jurors: JurorRow[] = [];
/** Pending destructive confirmation, shown inline under the row it belongs to. */
let confirm: { kind: "teams" | "jurors" | "criteria"; id: number; msg: string } | null = null;

async function load() {
  try {
    const [st, js, evs, mat, ef] = await Promise.all([api<SetupState>("/api/admin/state"), api<JurorRow[]>("/api/admin/jurors"), api<EventItem[]>("/api/admin/events"),
      api<MaterialsData>("/api/admin/materials").catch(() => MAT), api<{ files: EventFile[]; soffice: boolean; maxUploadMb: number }>("/api/admin/event-files").catch(() => null)]);
    S = st;
    jurors = js;
    EVENTS = evs;
    MAT = mat;
    if (ef) { EF = ef.files; EFM = { soffice: ef.soffice, maxUploadMb: ef.maxUploadMb }; }
    bar.setEventName(st.stage.eventName);
    render();
    if (location.hash && !jumped) { jumped = true; document.getElementById(location.hash.slice(1))?.scrollIntoView(); }
  } catch (e) {
    main.innerHTML = `<div class="banner err">${esc((e as Error).message)}</div>`;
  }
}

const parseClock = (v: string) => {
  const m = v.trim().match(/^(\d{1,2})(?::([0-5]\d))?$/);
  if (!m) return null;
  return m[2] != null ? Number(m[1]) * 60 + Number(m[2]) : Number(m[1]) * 60;
};

const scoreCount = (teamId: number) => S?.scores.filter(s => s.teamId === teamId).length ?? 0;
const confirmRow = (kind: string, id: number) =>
  confirm && confirm.kind === kind && confirm.id === id
    ? `<div class="confirm" style="grid-column:1/-1"><span>${esc(confirm.msg)}</span>
        <button class="btn danger solid sm" data-force="${kind}:${id}">Bəli, sil</button><button class="btn sm" data-cancel>Ləğv et</button></div>`
    : "";

// ---------- render ----------
const dtLocal = (ms: number | null) => {
  if (!ms) return "";
  const d = new Date(ms); const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const dtShow = (ms: number) => new Date(ms).toLocaleString("az-AZ", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtMb = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
/** v3: open accordion rows survive re-renders. */
const openTeams = new Set<number>();
let newEventOpen = false;

function eventSection(ev: EventState) {
  const cur = EVENTS.find(e => e.status === "active");
  const arch = EVENTS.filter(e => e.status === "archived");
  return `<section class="card pad stack" aria-labelledby="h-ev">
    <div class="row between"><h3 id="h-ev">${icon("medal")}Tədbir</h3><span class="saved" id="evSaved"></span></div>
    <form id="evForm" class="stack" novalidate>
      <div class="row" style="align-items:flex-start">
        <div style="flex:2 1 320px"><label class="f" for="evName">Tədbirin adı (brend / prefiks) və növü</label>
          <div class="row brandrow" style="flex-wrap:nowrap;gap:8px"><input type="text" id="evName" value="${esc(ev.name)}" maxlength="40" placeholder="məs. Ignite" autocomplete="off">
          <select id="evProduct" aria-label="Tədbir növü" style="width:auto;flex:0 0 auto">${PRODUCTS.map(p => `<option${p === ev.product ? " selected" : ""}>${p}</option>`).join("")}</select>
          <span class="brandprev" aria-live="polite"><span class="flame" style="width:9px;height:9px;border-radius:50%;background:var(--accent)"></span><b id="evPrev">${brandHtml(brandName(ev.name, ev.product))}</b></span></div></div>
        <div style="flex:1 1 140px"><label class="f" for="evDate">Tarix</label><input type="text" id="evDate" value="${esc(ev.date)}" maxlength="40" placeholder="29.10.2026"></div>
      </div>
      <p class="err" id="evErr" role="alert" style="color:var(--danger);margin:0;font-size:13px;font-weight:600"></p>
      <div class="toggle" style="border-top:1px solid var(--line)"><div><b>Münsif öz yekun balını görsün</b><small>Bağlı olanda münsif yalnız meyar ballarını görür (tövsiyə olunur).</small></div>
        <button type="button" class="sw" role="switch" id="evTotal" aria-checked="${ev.showJurorTotal}" aria-label="Münsif öz yekun balını görsün"></button></div>
    </form>
    <details class="fold inner" id="newEv"${newEventOpen ? " open" : ""}><summary>${icon("plus")}Yeni tədbir yarat</summary>
      <form id="newEvForm" class="stack" novalidate>
        <p class="sub" style="margin:0">Hazırkı tədbir (<b>${esc(cur?.name ?? ev.name)}</b>) <b>arxivə keçir</b>: nəticələri, tarixçəsi və Excel/PDF ixracı oxuma rejimində qalır, heç nə silinmir.
          Yeni tədbir boş başlayır: komanda, münsif və bal yoxdur. Arxivdəki münsiflərin və komandaların sessiyaları bağlanır.</p>
        <div class="row" style="align-items:flex-start">
          <div style="flex:2 1 240px"><label class="f" for="neName">Yeni tədbirin adı</label><input id="neName" maxlength="40" placeholder="məs. Ignite 2027" required></div>
          <div style="flex:0 0 auto"><label class="f" for="neProduct">Növü</label><select id="neProduct">${PRODUCTS.map(p => `<option${p === ev.product ? " selected" : ""}>${p}</option>`).join("")}</select></div>
          <div style="flex:1 1 130px"><label class="f" for="neDate">Tarix</label><input id="neDate" maxlength="40" placeholder="${esc(ev.date)}"></div>
        </div>
        <div class="row" style="align-items:flex-start">
          <div style="flex:1 1 110px"><label class="f" for="nePitch">Təqdimat (dəq:san)</label><input id="nePitch" class="mono" inputmode="numeric" value="${fmtClock(ev.timer.pitchSec)}"></div>
          <div style="flex:1 1 110px"><label class="f" for="neQa">Sual-cavab (dəq:san)</label><input id="neQa" class="mono" inputmode="numeric" value="${fmtClock(ev.timer.qaSec)}"></div>
          <div style="flex:2 1 220px"><label class="f" for="neDeadline">Yükləmə üçün son tarix (istəyə bağlı)</label><input id="neDeadline" type="datetime-local"></div>
        </div>
        <label class="check"><input type="checkbox" id="neCrit" checked> Meyarları köçür (${S!.criteria.length} meyar)</label>
        <label class="check"><input type="checkbox" id="neTeams"> Komandaların adlarını köçür (fayl, link və ballar köçmür)</label>
        <label class="check"><input type="checkbox" id="neConfirm"> Hazırkı tədbirin arxivə keçməsini təsdiqləyirəm</label>
        <p class="err-t" id="neErr" role="alert"></p>
        <div class="row"><button class="btn primary" type="submit" id="neGo">${icon("plus")}Yeni tədbiri yarat</button></div>
      </form>
    </details>
    ${arch.length ? `<details class="fold inner"><summary>${icon("db")}Arxiv (${arch.length} tədbir)</summary><div class="arch">${arch.map(e => `
      <div class="arch-row"><div><b>${esc(e.name)}</b><small>${dtShow(e.createdAt)}${e.archivedAt ? ` → ${dtShow(e.archivedAt)}` : ""} · ${e.teams} komanda · ${e.jurors} münsif · ${e.scores} qiymət</small>
        ${e.top.length ? `<small>${e.top.map(t => `${t.rank ?? "—"}. ${esc(t.name)}${t.score != null ? ` (${t.score.toFixed(2)})` : ""}`).join(" · ")}</small>` : ""}</div>
        <div class="row" style="gap:6px"><button class="btn sm" type="button" data-arch="${e.id}">${icon("medal")}Nəticələr</button>
          <a class="btn sm ghost" href="/api/admin/events/${e.id}/export.xlsx" download>${icon("sheet")}Excel</a>
          <a class="btn sm ghost" href="/api/admin/events/${e.id}/export.pdf" download>${icon("doc")}PDF</a>
          <a class="btn sm ghost" href="/api/admin/events/${e.id}/history.xlsx" download>${icon("list")}Tarixçə</a></div></div>`).join("")}</div></details>` : ""}
  </section>`;
}

function stageTimerSection(ev: EventState) {
  const sw = (id: string, on: boolean, label: string, hint: string) => `<div class="toggle"><div><b>${label}</b><small>${hint}</small></div>
    <button type="button" class="sw" role="switch" data-sset="${id}" aria-checked="${on}" aria-label="${label}"></button></div>`;
  return `<section class="card pad stack" aria-labelledby="h-st">
    <div class="row between"><h3 id="h-st">${icon("timer")}Səhnə taymeri</h3><span class="saved" id="stSaved"></span></div>
    <div class="row" style="align-items:flex-start">
      <div style="flex:1 1 140px"><label class="f" for="evPitch">Təqdimat müddəti (dəq:san)</label><input type="text" id="evPitch" class="mono" inputmode="numeric" value="${fmtClock(ev.timer.pitchSec)}"></div>
      <div style="flex:1 1 140px"><label class="f" for="evQa">Sual-cavab müddəti (dəq:san)</label><input type="text" id="evQa" class="mono" inputmode="numeric" value="${fmtClock(ev.timer.qaSec)}"></div>
    </div>
    ${sw("last5Fx", ev.last5Fx, "Son 5 saniyə effekti", "Təqdimatın və sual-cavabın son 5 saniyəsində taymer səhnə ekranının ortasına keçir.")}
    ${sw("stageSound", ev.stageSound, "Səs siqnalları", "Səhnə ekranında tik səsi, keçid melodiyası və “vaxt bitdi” siqnalı.")}
    ${sw("teamSlideControl", ev.teamSlideControl, "Komanda öz slaydlarını çevirə bilsin", "Səhnədəki komanda öz prezentasiyasını telefondan (/team) çevirir. Səhnədən düşəndə bu imkan bağlanır.")}
  </section>`;
}

function deadlineSection() {
  const dl = MAT?.settings.uploadDeadline ?? null;
  const ext = (MAT?.teams ?? []).filter(t => t.extendUntil && (!dl || t.extendUntil > dl));
  return `<section class="card pad stack" aria-labelledby="h-dl">
    <div class="row between"><h3 id="h-dl">${icon("lock")}Yükləmə üçün son tarix</h3><span class="saved" id="taSaved"></span></div>
    <div class="toggle" style="border-top:0;padding-top:0"><div><b>Son tarix</b><small>Bu vaxtdan sonra komandalar prezentasiyanı, sayt və video linkini dəyişə bilmir. Bir saat qalmış prezentasiyası olmayan komandalara xatırlatma gedir. Boş qalsa, son tarix yoxdur.</small></div>
      <div class="row dlrow"><input type="datetime-local" id="taDeadline" value="${dtLocal(dl)}">
      ${dl ? `<button class="btn sm ghost" type="button" data-tset-clear>Sil</button>` : ""}</div></div>
    <p class="sub" style="margin:0">${dl ? `Komandalar /team səhifəsində geri sayımı görür. ${Date.now() > dl ? `<b class="danger-t">Son tarix keçib.</b>` : ""}` : "Son tarix qoyulmayıb."}
      Bir komandaya əlavə vaxt vermək üçün aşağıda komandanı açın → “Son tarixi uzat”.${ext.length ? ` Uzadılıb: ${ext.map(t => `<b>${esc(t.name)}</b> (${dtShow(t.extendUntil!)})`).join(", ")}.` : ""}</p>
  </section>`;
}

function teamsSection(ev: EventState) {
  const nScores = S!.scores.length;
  const mat = new Map((MAT?.teams ?? []).map(t => [t.teamId, t]));
  const dl = MAT?.settings.uploadDeadline ?? null;
  return `<section class="card pad stack" aria-labelledby="h-teams">
    <div class="row between"><h3 id="h-teams">${icon("list")}Komandalar (${S!.teams.length})</h3>
      <div class="row" style="gap:6px"><button class="btn sm ghost" type="button" id="accAll">${openTeams.size ? "Hamısını bağla" : "Hamısını aç"}</button>
      <button class="btn sm" data-add="teams">${icon("plus")}Komanda əlavə et</button></div></div>
    ${nScores ? `<p class="note">Artıq <b>${nScores}</b> qiymət var. Qiyməti olan komandanı silsəniz, qiymətləri də silinəcək. Bunun əvəzinə komandanı deaktiv edə bilərsiniz.</p>` : ""}
    <p class="sub" style="margin:0">Sıranı dəyişmək üçün <b>⋮⋮</b> tutub sürüşdürün. Komandanı açın: ad, layihə, giriş linki (QR), materiallar.</p>
    <div class="accs" role="list">${S!.teams.map((t, i) => {
      const m = mat.get(t.id);
      const p = m?.presentation ?? null;
      const badges = [
        t.active ? "" : `<span class="pill">Deaktiv</span>`,
        m?.approval === "pending" ? `<span class="pill warn">Təsdiq gözləyir</span>` : "",
        p ? `<span class="pill ok" title="${esc(p.name)}">${icon("doc")}${p.pages ? `${p.pages} sl.` : "PDF"}</span>` : `<span class="pill faint-p" title="Prezentasiya yoxdur">${icon("doc")}—</span>`,
        m?.link ? `<span class="pill" title="Giriş linki var">${icon("qr")}</span>` : "",
        scoreCount(t.id) ? `<span class="pill" title="Qiymətlər">${scoreCount(t.id)} bal</span>` : "",
      ].join("");
      return `<details class="acc ${t.active ? "" : "off"}" role="listitem" data-row="teams:${t.id}" data-id="${t.id}"${openTeams.has(t.id) ? " open" : ""}>
        <summary><span class="grip" title="Sürüşdürüb yerini dəyiş" aria-hidden="true">⋮⋮</span><span class="ix mono">${i + 1}</span>
          <span class="acc-n"><b>${esc(t.name)}</b><small>${esc(t.project || "Layihə yazılmayıb")}</small></span><span class="acc-b">${badges}</span><span class="chev" aria-hidden="true">${icon("down")}</span></summary>
        <div class="acc-body">
          <div class="tgrid">
            <div><label class="f">Komanda adı</label><input type="text" data-k="name" value="${esc(t.name)}" maxlength="120" aria-label="Komanda ${i + 1} adı"></div>
            <div><label class="f">Layihə / məhsul</label><input type="text" data-k="project" value="${esc(t.project)}" maxlength="160" placeholder="məs. Ağıllı parkinq" aria-label="Komanda ${i + 1} layihəsi"></div>
            ${ev.includeEntry ? `<div><label class="f">Giriş balı (maks. ${ev.entryMax})</label><input type="text" class="mono" data-k="entryScore" value="${entryValue(t.entryScore)}" inputmode="decimal" autocomplete="off" aria-label="Komanda ${i + 1} giriş balı"></div>` : ""}
          </div>
          <div class="row acc-tools">
            <span class="row" style="gap:6px"><span class="f" style="margin:0">Aktiv</span><button type="button" class="sw" role="switch" data-active aria-checked="${t.active}" aria-label="Komanda ${i + 1} aktivdir"></button></span>
            ${m?.approval === "pending" ? `<button class="btn sm primary" type="button" data-approve="${t.id}">${icon("check")}Təsdiqlə</button>` : ""}
            <button class="btn sm ${m?.link ? "" : "primary"}" type="button" data-tlink="${t.id}">${icon("qr")}${m?.link ? "Giriş linki / QR" : "Giriş linki yarat"}</button>
            <span class="mv"><button type="button" class="x" data-move="up" ${i ? "" : "disabled"} aria-label="Yuxarı">${icon("up")}</button><button type="button" class="x" data-move="down" ${i < S!.teams.length - 1 ? "" : "disabled"} aria-label="Aşağı">${icon("down")}</button></span>
            <span class="spacer"></span>
            <button type="button" class="btn sm ghost danger" data-del aria-label="Komanda ${i + 1}-i sil">${icon("trash")}Sil</button>
          </div>
          <div class="acc-mat">
            <div><span class="f">Prezentasiya</span>${m ? presLine(m) : `<span class="faint">—</span>`}
              ${p?.viewable ? `<button class="btn sm" type="button" data-view="${t.id}" style="margin-top:6px">${icon("expand")}Bax</button>` : ""}</div>
            <div><span class="f">Sayt / video</span>${m?.siteUrl ? `<a href="${esc(m.siteUrl)}" target="_blank" rel="noopener noreferrer">${esc(m.siteUrl)}</a>` : `<span class="faint">Sayt yoxdur</span>`}
              ${m?.videoUrl ? `<br><a href="${esc(m.videoUrl)}" target="_blank" rel="noopener noreferrer">Demo video</a>` : ""}</div>
            <div><span class="f">Son tarixi uzat (yalnız bu komanda)</span><div class="row dlrow"><input type="datetime-local" data-ext="${t.id}" value="${dtLocal(m?.extendUntil ?? null)}">
              ${m?.extendUntil ? `<button class="btn sm ghost" type="button" data-ext-clear="${t.id}">Sil</button>` : ""}</div>
              <small class="sub">${m?.extendUntil && (!dl || m.extendUntil > dl) ? `Bu komanda ${dtShow(m.extendUntil)}-dək yükləyə bilər.` : dl ? `Ümumi son tarix: ${dtShow(dl)}` : "Ümumi son tarix yoxdur."}</small></div>
          </div>
          ${confirmRow("teams", t.id)}
        </div>
      </details>`;
    }).join("")}</div>
  </section>`;
}

function eventFilesSection() {
  return `<section class="card pad stack" aria-labelledby="h-evfiles">
    <div class="row between"><h3 id="h-evfiles">${icon("doc")}Tədbirin prezentasiyası</h3><span class="saved" id="efSaved"></span></div>
    <p class="sub" style="margin:0">Açılış, fasilə, sponsorlar və qaydalar üçün, komandaların prezentasiyasından ayrıdır. Canlı paneldə (Səhnə) və ya pultda “Ekrana çıxar” ilə göstərilir;
      slaydları ← →, pult və ya kliker çevirir. PDF${EFM.soffice ? " və ya PPTX (avtomatik PDF-ə çevrilir)" : ""}, maks. ${EFM.maxUploadMb} MB.</p>
    ${EF.length ? `<div class="efl">${EF.map((f, i) => `<div class="efl-row" data-ef="${f.id}">
        <span class="ix mono">${i + 1}</span>
        <input type="text" data-ef-title="${f.id}" value="${esc(f.title)}" maxlength="80" aria-label="Prezentasiyanın adı">
        <small>${f.ext.toUpperCase()}${f.pages ? ` · ${f.pages} slayd` : ""} · ${fmtMb(f.size)}${f.viewable ? "" : f.conv === "running" || f.conv === "pending" ? " · PDF-ə çevrilir…" : " · PDF lazımdır"}</small>
        <span class="row" style="gap:4px;flex-wrap:nowrap">
          <button class="btn sm" type="button" data-ef-view="${f.id}" ${f.viewable ? "" : "disabled"}>${icon("expand")}Bax</button>
          <button type="button" class="x" data-ef-move="${f.id}:-1" ${i ? "" : "disabled"} aria-label="Yuxarı">${icon("up")}</button>
          <button type="button" class="x" data-ef-move="${f.id}:1" ${i < EF.length - 1 ? "" : "disabled"} aria-label="Aşağı">${icon("down")}</button>
          <button type="button" class="x del" data-ef-del="${f.id}" aria-label="Sil">${icon("trash")}</button></span>
      </div>`).join("")}</div>` : ""}
    <label class="drop" id="efDrop">
      <input type="file" id="efFile" accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" hidden>
      <span class="dicon">${icon("cloud")}</span><b>Prezentasiya əlavə et</b><small>Faylı bura atın və ya seçin</small>
      <div class="upbar" hidden><i></i></div>
    </label>
  </section>`;
}

function render() {
  if (!S) return;
  const ev = S.event;
  const nScores = S.scores.length;
  const msum = S.criteria.reduce((a, c) => a + c.maxScore, 0);
  main.innerHTML = `
    <div class="stack">
      <div><h1>Quraşdırma</h1><p class="sub">Hər sahə xanadan çıxanda yadda saxlanılır və bütün ekranlarda dərhal yenilənir.</p>
        <nav class="jump">${[["h-ev", "Tədbir"], ["h-teams", "Komandalar"], ["h-dl", "Son tarix"], ["h-st", "Səhnə taymeri"], ["h-evfiles", "Tədbirin prezentasiyası"], ["h-jur", "Münsiflər"], ["h-cr", "Meyarlar"], ["h-sc", "Nəticə"], ["h-tacc", "Komanda girişi"]].map(([id, l]) => `<a href="#${id}">${l}</a>`).join("")}</nav></div>
      ${eventSection(ev)}
      ${teamsSection(ev)}
      ${deadlineSection()}
      ${stageTimerSection(ev)}
      ${eventFilesSection()}

      <section class="card pad stack" aria-labelledby="h-jur">
        <div class="row between"><h3 id="h-jur">${icon("users")}Münsiflər (${jurors.length})</h3>
          <button class="btn sm primary" id="addJuror">${icon("qr")}Münsif əlavə et (QR)</button></div>
        <p class="sub" style="margin:0">Hər münsif üçün QR kod yaradın və ekranı münsifə yaxınlaşdırın. Münsif telefonla skan edib adını yazır, adı dərhal burada görünür.
          QR bir dəfə işləyir. Telefon dəyişsə və ya əlaqə itsə, “Yeni QR” eyni hesab üçün yeni kod verir: ballar qorunur.</p>
        <div class="jlist">
          ${jurors.map(j => {
            const waiting = !j.claimed;
            return `
          <div class="jrow2 ${j.active ? "" : "off"}" data-row="jurors:${j.id}">
            <span class="ini ${waiting ? "wait" : ""}">${esc(initials(j.displayName))}</span>
            <div class="mid">
              <input type="text" data-k="displayName" value="${esc(j.displayName)}" maxlength="80" aria-label="Münsifin adı">
              <small>${waiting ? `<span class="warn-t">QR gözləyir</span>` : `<span class="ok-t">Qoşulub</span>`}
                <span>${j.sessionCount ? `${j.sessionCount} açıq sessiya` : "Açıq sessiya yoxdur"}</span><span class="saved" data-saved></span></small>
            </div>
            <div class="acts">
              <button type="button" class="btn sm ${waiting ? "outline-acc" : ""}" data-qr>${icon("qr")}${waiting ? "QR göstər" : "Yeni QR"}</button>
              ${j.sessionCount ? `<button type="button" class="btn ghost sm" data-logout>Cihazlardan çıxart</button>` : ""}
              <span class="f" style="margin:0">Aktiv</span><button type="button" class="sw" role="switch" data-active aria-checked="${j.active}" aria-label="${esc(j.displayName)} aktivdir"></button>
              <button type="button" class="x del" data-del aria-label="${esc(j.displayName)} sil">${icon("trash")}</button>
            </div>
            ${confirmRow("jurors", j.id)}
          </div>`;
          }).join("") || `<p class="note">Hələ münsif yoxdur. “Münsif əlavə et (QR)” düyməsi ilə başlayın.</p>`}
        </div>
      </section>

      <section class="card pad stack" aria-labelledby="h-cr">
        <div class="row between"><h3 id="h-cr">Qiymətləndirmə meyarları</h3><span class="sum" role="status">Maksimum cəmi: ${msum} bal</span></div>
        ${nScores ? `<p class="note">Artıq <b>${nScores}</b> qiymət var. Meyar əlavə etsəniz və ya maksimumu azaltsanız, uyğun gəlməyən köhnə qiymətlər natamam sayılacaq.</p>` : ""}
        <div class="ed cr">
          <div class="er sub" aria-hidden="true" style="font-size:12px;font-weight:700"><span>Meyar</span><span class="cd">Münsif üçün izah</span><span>Maks. bal</span><span></span><span></span></div>
          ${S.criteria.map((c, i) => `
          <div class="er" data-row="criteria:${c.id}">
            <input type="text" data-k="name" value="${esc(c.name)}" maxlength="120" aria-label="Meyar ${i + 1} adı">
            <textarea class="cd" data-k="description" rows="3" maxlength="400" aria-label="Meyar ${i + 1} izahı">${esc(c.description)}</textarea>
            <input type="number" class="mono" data-k="maxScore" value="${c.maxScore}" min="1" max="100" inputmode="numeric" aria-label="Meyar ${i + 1} maksimum balı">
            <div class="mv"><button type="button" class="x" data-move="up" ${i ? "" : "disabled"} aria-label="Yuxarı">${icon("up")}</button><button type="button" class="x" data-move="down" ${i < S!.criteria.length - 1 ? "" : "disabled"} aria-label="Aşağı">${icon("down")}</button></div>
            <button type="button" class="x del" data-del aria-label="Meyar ${i + 1}-i sil">${icon("trash")}</button>
            ${confirmRow("criteria", c.id)}
          </div>`).join("")}
        </div>
        <div class="row"><button class="btn sm" data-add="criteria">${icon("plus")}Meyar əlavə et</button></div>
      </section>

      <section class="card pad stack" aria-labelledby="h-sc">
        <div class="row between"><h3 id="h-sc">Nəticə və açıqlama</h3><span class="saved" id="scSaved"></span></div>
        <div class="toggle" style="border-top:0;padding-top:0"><div><b>Giriş balı (seçim mərhələsi)</b>
          <small>Hakatonda söndürün: yekun bal yalnız münsiflərin orta balıdır. Yandırsanız, yekun = giriş balı + münsiflərin orta balı.</small></div>
          <button type="button" class="sw" role="switch" id="scEntry" aria-checked="${ev.includeEntry}" aria-label="Giriş balı yekun bala əlavə olunsun"></button></div>
        ${ev.includeEntry ? `<div class="row" style="align-items:flex-end">
          <div style="flex:0 1 200px"><label class="f" for="scEntryMax">Giriş balının maksimumu</label>
            <input type="number" id="scEntryMax" class="mono" min="1" max="1000" step="any" value="${ev.entryMax}"></div>
        </div>` : ""}
        <p class="sub" id="scFormula" style="margin:0">${formula()}</p>
        <div class="toggle"><div><b>İki addımla açılan yerlər</b>
          <small>Açıqlamada ilk neçə yer iki basışla açılsın: əvvəl böyük yer nömrəsi, sonra komandanın adı. 0 = hamısı bir basışla. Dəyişiklik növbəti “Sıfırla”/icazədən sonra tətbiq olunur.</small></div>
          <input type="number" id="scTop" class="mono" min="0" max="10" step="1" value="${ev.revealTop}" style="width:84px;flex:0 0 auto" aria-label="İki addımla açılan yerlərin sayı"></div>
      </section>

      <section class="card pad stack" aria-labelledby="h-tags">
        <div class="row between"><h3 id="h-tags">Sürətli rəy etiketləri</h3><span class="saved" id="tagSaved"></span></div>
        <p class="sub" style="margin:0">Münsiflər bu etiketləri bir toxunuşla seçir. Seçilənlər münsifin şəxsi qeydi kimi saxlanılır və Excel/PDF hesabatlarına düşür.</p>
        <div class="tagsed">${ev.feedbackTags.map((t, i) => `<span class="qchip">${esc(t)}<button type="button" data-tagdel="${i}" aria-label="${esc(t)} sil">${icon("close")}</button></span>`).join("") || `<span class="sub">Etiket yoxdur: münsif panelində bu bölmə gizlənəcək.</span>`}</div>
        <form class="row" id="tagForm" novalidate style="flex-wrap:nowrap"><input type="text" id="tagNew" maxlength="60" placeholder="Yeni etiket, məs. Güclü MVP" style="max-width:360px">
          <button class="btn sm" type="submit">${icon("plus")}Əlavə et</button></form>
      </section>

      <section class="card pad stack" id="teamAccess" aria-labelledby="h-tacc">${teamAccessHtml(MAT)}</section>
    </div>`;
}

// ---------- helpers ----------
function formula() {
  if (!S) return "";
  const D = S.criteria.reduce((a, c) => a + c.maxScore, 0);
  return S.event.includeEntry
    ? `Yekun = giriş balı (maks. ${S.event.entryMax}) + Demo Day balı (maks. ${D}) = maks. ${S.event.entryMax + D}`
    : `Yekun = münsiflərin orta balı (maks. ${D})`;
}
async function patchScoring(body: { includeEntry?: boolean; entryMax?: number; revealTop?: number }) {
  try {
    const r = await api<{ event: EventState }>("/api/admin/event", { method: "PATCH", body });
    const rerender = body.includeEntry !== undefined && body.includeEntry !== S!.event.includeEntry;
    S!.event.includeEntry = r.event.includeEntry;
    S!.event.entryMax = r.event.entryMax;
    S!.event.revealTop = r.event.revealTop;
    if (rerender) { render(); flashSc(); return true; }
    $("#scFormula").textContent = formula();
    flashSc();
    return true;
  } catch (e) {
    toast((e as ApiError).message, "err");
    const em = document.querySelector<HTMLInputElement>("#scEntryMax");
    if (em) em.value = String(S!.event.entryMax);
    $<HTMLInputElement>("#scTop").value = String(S!.event.revealTop);
    return false;
  }
}
function flashSc() { const s = document.getElementById("scSaved"); if (s) { s.textContent = "Saxlanıldı"; setTimeout(() => { s.textContent = ""; }, 1800); } }
const rowOf = (el: HTMLElement) => {
  const r = el.closest<HTMLElement>("[data-row]");
  if (!r) return null;
  const [kind, id] = r.dataset.row!.split(":");
  return { el: r, kind: kind as "teams" | "jurors" | "criteria", id: Number(id) };
};
function flashSaved(row: HTMLElement | null, text = "Saxlanıldı") {
  const s = row?.querySelector<HTMLElement>("[data-saved]");
  if (s) { s.textContent = text; setTimeout(() => { s.textContent = ""; }, 1800); }
  else toast(text);
}

async function patchRow(kind: string, id: number, body: Record<string, unknown>, row: HTMLElement | null, rerender = false) {
  try {
    await api(`/api/admin/${kind}/${id}`, { method: "PATCH", body });
    if (rerender) await load();
    else {
      // Update the local copy without re-rendering so focus stays where the user tabbed to.
      const list = kind === "teams" ? S!.teams : kind === "criteria" ? S!.criteria : jurors;
      const item = (list as Array<{ id: number }>).find(x => x.id === id);
      if (item) Object.assign(item, body);
      if (kind === "criteria" && "maxScore" in body) {
        main.querySelector<HTMLElement>(".sum")!.textContent = `Maksimum cəmi: ${S!.criteria.reduce((a, c) => a + c.maxScore, 0)} bal`;
        $("#scFormula").textContent = formula();
      }
      flashSaved(row);
    }
    return true;
  } catch (e) {
    toast((e as ApiError).message, "err");
    return false;
  }
}

// ---------- events ----------
main.addEventListener("change", async e => {
  const el = e.target as HTMLInputElement;
  if (el.id === "scTop") {
    const v = Number(el.value);
    if (!Number.isInteger(v) || v < 0 || v > 10) { toast("İki addımla açılan yerlərin sayı 0–10 arası tam ədəd olmalıdır.", "err"); el.value = String(S!.event.revealTop); return; }
    await patchScoring({ revealTop: v });
    return;
  }
  if (el.id === "scEntryMax") {
    const v = Number(el.value);
    if (!(v >= 1 && v <= 1000)) { toast("Giriş balının maksimumu 1–1000 arası olmalıdır.", "err"); el.value = String(S!.event.entryMax); return; }
    await patchScoring({ entryMax: v });
    return;
  }
  const k = el.dataset.k;
  if (!k) return;
  const r = rowOf(el);
  if (!r) return;
  let v: string | number | null = el.value.trim();
  if (k === "maxScore") {
    const cur = S!.criteria.find(c => c.id === r.id)!.maxScore;
    const n = Number(el.value);
    if (el.value.trim() === "" || el.validity.badInput || !Number.isInteger(n) || n < 1 || n > 100) {
      toast("Maksimum bal 1–100 arası tam ədəd olmalıdır.", "err");
      el.value = String(cur);
      return;
    }
    v = n;
    if (!(await patchRow(r.kind, r.id, { maxScore: n }, r.el))) el.value = String(cur); // e.g. 409: scores above the new maximum
    return;
  } else if (k === "entryScore") {
    if (v === "") v = null;
    else {
      const n = Number(String(v).replace(",", "."));
      if (!Number.isFinite(n) || n < 0 || n > S!.event.entryMax) {
        toast(`Giriş balı 0–${S!.event.entryMax} arası olmalıdır.`, "err");
        el.value = entryValue(S!.teams.find(t => t.id === r.id)?.entryScore ?? null);
        return;
      }
      v = n;
    }
  } else if (k === "name" || k === "displayName") {
    if (!v) {
      toast("Bu sahə boş ola bilməz.", "err");
      const list = r.kind === "teams" ? S!.teams : r.kind === "criteria" ? S!.criteria : jurors;
      el.value = String((list as unknown as Array<Record<string, unknown>>).find(x => x.id === r.id)?.[k] ?? "");
      return;
    }
  }
  el.setAttribute("aria-invalid", "false");
  const ok = await patchRow(r.kind, r.id, { [k]: v }, r.el);
  if (!ok) { el.setAttribute("aria-invalid", "true"); el.focus(); }
});

main.addEventListener("click", async e => {
  const t = e.target as HTMLElement;
  if (!S) return;

  const add = t.closest<HTMLElement>("[data-add]");
  if (add) {
    try {
      if (add.dataset.add === "teams") await api("/api/admin/teams", { method: "POST", body: { name: `Komanda ${S.teams.length + 1}`, project: "" } });
      else await api("/api/admin/criteria", { method: "POST", body: { name: "Yeni meyar", description: "", maxScore: 10 } });
      await load();
      const rows = main.querySelectorAll<HTMLElement>(`[data-row^="${add.dataset.add}:"]`);
      rows[rows.length - 1]?.querySelector<HTMLInputElement>("input")?.select();
    } catch (ex) { toast((ex as ApiError).message, "err"); }
    return;
  }

  if (t.closest("#addJuror")) { createJuror(); return; }
  const tagDel = t.closest<HTMLElement>("[data-tagdel]");
  if (tagDel) {
    const tags = S.event.feedbackTags.filter((_, i) => i !== Number(tagDel.dataset.tagdel));
    await saveTags(tags);
    return;
  }
  if (t.closest("#evTotal")) {
    const sw = t.closest<HTMLElement>("#evTotal")!;
    sw.setAttribute("aria-checked", String(sw.getAttribute("aria-checked") !== "true"));
    return;
  }
  if (t.closest("#scEntry")) {
    const sw = t.closest<HTMLElement>("#scEntry")!;
    const next = sw.getAttribute("aria-checked") !== "true";
    await patchScoring({ includeEntry: next });
    return;
  }
  if (t.closest("[data-cancel]")) { confirm = null; render(); return; }

  const force = t.closest<HTMLElement>("[data-force]");
  if (force) {
    const [kind, id] = force.dataset.force!.split(":");
    try { await api(`/api/admin/${kind}/${id}?force=1`, { method: "DELETE" }); toast("Silindi"); }
    catch (ex) { toast((ex as ApiError).message, "err"); }
    confirm = null;
    await load();
    return;
  }

  const r = rowOf(t);
  if (!r) return;

  if (t.closest("[data-active]")) {
    const sw = t.closest<HTMLElement>("[data-active]")!;
    const next = sw.getAttribute("aria-checked") !== "true";
    await patchRow(r.kind, r.id, { active: next }, r.el, true);
    if (r.kind === "jurors" && !next) toast("Münsif deaktiv edildi və cihazlardan çıxarıldı");
    return;
  }
  const mv = t.closest<HTMLElement>("[data-move]");
  if (mv && (r.kind === "teams" || r.kind === "criteria")) {
    const ids = (r.kind === "teams" ? S.teams : S.criteria).map(x => x.id);
    const i = ids.indexOf(r.id), j = mv.dataset.move === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api(`/api/admin/${r.kind}/reorder`, { method: "POST", body: { ids } }); await load(); }
    catch (ex) { toast((ex as ApiError).message, "err"); }
    main.querySelector<HTMLElement>(`[data-row="${r.kind}:${r.id}"] [data-move="${mv.dataset.move}"]`)?.focus();
    return;
  }
  if (t.closest("[data-del]")) {
    try {
      await api(`/api/admin/${r.kind}/${r.id}`, { method: "DELETE" });
      toast("Silindi");
      await load();
    } catch (ex) {
      const err = ex as ApiError;
      if (err.status === 409) { confirm = { kind: r.kind, id: r.id, msg: err.message }; render(); }
      else toast(err.message, "err");
    }
    return;
  }
  if (t.closest("[data-qr]")) {
    const j = jurors.find(x => x.id === r.id);
    if (j) reissue(j);
    return;
  }
  if (t.closest("[data-logout]")) {
    try {
      const res = await api<{ closed: number }>(`/api/admin/jurors/${r.id}/logout`, { method: "POST" });
      toast(`${res.closed} cihazdan çıxarıldı`);
      await load();
    } catch (ex) { toast((ex as ApiError).message, "err"); }
  }
});

// ---------- v3: accordion, new event, archive, stage timer settings, deadline extension, event presentations ----------
main.addEventListener("toggle", e => {
  const d = e.target as HTMLElement;
  if (d instanceof HTMLDetailsElement && d.classList.contains("acc")) {
    const id = Number(d.dataset.id);
    if (d.open) openTeams.add(id); else openTeams.delete(id);
    const b = document.getElementById("accAll"); if (b) b.textContent = openTeams.size ? "Hamısını bağla" : "Hamısını aç";
  }
  if (d instanceof HTMLDetailsElement && d.id === "newEv") newEventOpen = d.open;
}, true);
const flash = (id: string, text = "Saxlanıldı") => { const s = document.getElementById(id); if (s) { s.textContent = text; setTimeout(() => { s.textContent = ""; }, 1800); } };
main.addEventListener("click", async e => {
  const t = e.target as HTMLElement;
  if (!S) return;
  if (t.closest("#accAll")) {
    const open = openTeams.size === 0;
    main.querySelectorAll<HTMLDetailsElement>("details.acc").forEach(d => { d.open = open; });
    return;
  }
  const ss = t.closest<HTMLElement>("[data-sset]");
  if (ss) {
    const key = ss.dataset.sset!;
    const next = ss.getAttribute("aria-checked") !== "true";
    try {
      await api("/api/admin/settings/stage", { method: "PATCH", body: { [key]: next } });
      ss.setAttribute("aria-checked", String(next));
      (S.event as unknown as Record<string, unknown>)[key] = next;
      flash("stSaved", "Saxlanıldı · səhnə ekranında dərhal tətbiq olunur");
    } catch (ex) { toast((ex as ApiError).message, "err"); }
    return;
  }
  const ap = t.closest<HTMLElement>("[data-approve]");
  if (ap) { try { await api(`/api/admin/teams/${ap.dataset.approve}/approve`, { method: "POST", body: {} }); toast("Komanda təsdiqləndi"); await load(); } catch (ex) { toast((ex as ApiError).message, "err"); } return; }
  const vw = t.closest<HTMLElement>("[data-view]");
  if (vw) {
    const m = MAT?.teams.find(x => x.teamId === Number(vw.dataset.view));
    if (m?.presentation?.viewable) openViewer({ url: m.presentation.url, title: m.name, subtitle: m.presentation.name, siteUrl: m.siteUrl || null });
    return;
  }
  const xc = t.closest<HTMLElement>("[data-ext-clear]");
  if (xc) { await saveExtension(Number(xc.dataset.extClear), null); return; }
  const efv = t.closest<HTMLButtonElement>("[data-ef-view]");
  if (efv && !efv.disabled) { const f = EF.find(x => x.id === Number(efv.dataset.efView)); if (f) openViewer({ url: f.url, title: f.title, subtitle: "Tədbirin prezentasiyası" }); return; }
  const efm = t.closest<HTMLButtonElement>("[data-ef-move]");
  if (efm && !efm.disabled) {
    const [id, d] = efm.dataset.efMove!.split(":").map(Number);
    const ids = EF.map(f => f.id); const i = ids.indexOf(id), j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { EF = (await api<{ files: EventFile[] }>("/api/admin/event-files/reorder", { method: "POST", body: { ids } })).files; render(); } catch (ex) { toast((ex as ApiError).message, "err"); }
    return;
  }
  const efd = t.closest<HTMLElement>("[data-ef-del]");
  if (efd) {
    const f = EF.find(x => x.id === Number(efd.dataset.efDel));
    if (!f || !window.confirm(`“${f.title}” silinsin? Səhnə ekranında göstərilirsə, ekran komandaya qayıdacaq.`)) return;
    try { EF = (await api<{ files: EventFile[] }>(`/api/admin/event-files/${f.id}`, { method: "DELETE" })).files; toast("Silindi"); render(); } catch (ex) { toast((ex as ApiError).message, "err"); }
    return;
  }
  const ar = t.closest<HTMLElement>("[data-arch]");
  if (ar) { void showArchive(Number(ar.dataset.arch)); return; }
});
async function saveExtension(teamId: number, ms: number | null) {
  try { await api(`/api/admin/teams/${teamId}/materials`, { method: "PATCH", body: { extendUntil: ms } }); toast(ms ? "Son tarix bu komanda üçün uzadıldı" : "Uzadılma silindi"); await load(); }
  catch (ex) { toast((ex as ApiError).message, "err"); }
}
main.addEventListener("change", async e => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.ext) { const ms = el.value ? new Date(el.value).getTime() : null; await saveExtension(Number(el.dataset.ext), ms && Number.isFinite(ms) ? ms : null); return; }
  if (el.dataset.efTitle) {
    const v = el.value.trim();
    if (!v) { el.value = EF.find(f => f.id === Number(el.dataset.efTitle))?.title ?? ""; return; }
    try { EF = (await api<{ files: EventFile[] }>(`/api/admin/event-files/${el.dataset.efTitle}`, { method: "PATCH", body: { title: v } })).files; flash("efSaved"); } catch (ex) { toast((ex as ApiError).message, "err"); }
    return;
  }
  if (el.id === "efFile" && el.files?.[0]) uploadEventFile(el.files[0]);
});
main.addEventListener("dragover", e => { const d = (e.target as HTMLElement).closest("#efDrop"); if (d) { e.preventDefault(); d.classList.add("over"); } });
main.addEventListener("dragleave", e => { (e.target as HTMLElement).closest("#efDrop")?.classList.remove("over"); });
main.addEventListener("drop", e => {
  const d = (e.target as HTMLElement).closest("#efDrop");
  if (!d) return;
  e.preventDefault(); d.classList.remove("over");
  const f = e.dataTransfer?.files?.[0];
  if (f) uploadEventFile(f);
});
let efBusy = false;
function uploadEventFile(file: File) {
  if (efBusy) return;
  if (file.size > EFM.maxUploadMb * 1048576) { toast(`Fayl ${EFM.maxUploadMb} MB-dan böyük ola bilməz`, "err"); return; }
  efBusy = true;
  const box = document.querySelector<HTMLElement>("#efDrop .upbar");
  const bar = box?.querySelector("i");
  if (box) box.hidden = false;
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/admin/event-files");
  xhr.setRequestHeader("Content-Type", "application/octet-stream");
  xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
  xhr.upload.onprogress = ev => { if (bar && ev.lengthComputable) bar.style.width = `${(ev.loaded / ev.total) * 100}%`; };
  xhr.onload = () => {
    efBusy = false;
    let data: { error?: string; files?: EventFile[] } = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
    if (xhr.status >= 200 && xhr.status < 300 && data.files) { EF = data.files; toast("Tədbirin prezentasiyası yükləndi"); render(); }
    else { toast(data.error ?? `Yükləmə alınmadı (${xhr.status})`, "err"); if (box) box.hidden = true; }
  };
  xhr.onerror = () => { efBusy = false; toast("Bağlantı kəsildi. Yenidən cəhd edin.", "err"); if (box) box.hidden = true; };
  xhr.send(file);
}

async function createEvent() {
  const err = $("#neErr");
  const name = cleanPrefix($<HTMLInputElement>("#neName").value);
  const pitchSec = parseClock($<HTMLInputElement>("#nePitch").value);
  const qaSec = parseClock($<HTMLInputElement>("#neQa").value);
  const dlv = $<HTMLInputElement>("#neDeadline").value;
  if (name.length < 2) { err.textContent = "Yeni tədbirin adını yazın."; $("#neName").focus(); return; }
  if (!pitchSec || pitchSec < 10 || !qaSec || qaSec < 10) { err.textContent = "Müddətləri dəq:san formatında yazın, məs. 3:00 və 2:00."; return; }
  if (!$<HTMLInputElement>("#neConfirm").checked) { err.textContent = "Hazırkı tədbirin arxivə keçməsini təsdiqləyin."; return; }
  err.textContent = "";
  const go = $<HTMLButtonElement>("#neGo");
  go.disabled = true;
  try {
    await api("/api/admin/events", { method: "POST", body: {
      name, product: $<HTMLSelectElement>("#neProduct").value, date: $<HTMLInputElement>("#neDate").value.trim() || undefined, pitchSec, qaSec,
      uploadDeadline: dlv ? new Date(dlv).getTime() : null, copyCriteria: $<HTMLInputElement>("#neCrit").checked, copyTeams: $<HTMLInputElement>("#neTeams").checked, confirm: true,
    } });
    newEventOpen = false;
    openTeams.clear();
    toast("Yeni tədbir yaradıldı, köhnəsi arxivə keçdi");
    await load();
    document.getElementById("h-ev")?.scrollIntoView({ behavior: "smooth" });
  } catch (ex) { err.textContent = (ex as ApiError).message; go.disabled = false; }
}

let archDlg: HTMLDialogElement | null = null;
async function showArchive(id: number) {
  let r: { meta: { name: string; createdAt: number; archivedAt: number | null }; results: { ranking: Array<{ rank: number | null; team: { name: string; project: string }; score: number | null; n: number }>; maxTotal: number } };
  try { r = await api(`/api/admin/events/${id}/results`); } catch (ex) { toast((ex as ApiError).message, "err"); return; }
  if (!archDlg) {
    archDlg = document.createElement("dialog");
    document.body.appendChild(archDlg);
    archDlg.addEventListener("click", e => { if (e.target === archDlg || (e.target as HTMLElement).closest("[data-close]")) archDlg!.close(); });
  }
  archDlg.innerHTML = `<div class="dh"><div><h3>Arxiv · oxuma rejimi</h3><h2 style="font-size:19px;margin-top:4px">${esc(r.meta.name)}</h2>
      <p class="sub">${dtShow(r.meta.createdAt)}${r.meta.archivedAt ? ` → ${dtShow(r.meta.archivedAt)}` : ""}</p></div><button class="icon-btn" data-close aria-label="Bağla">${icon("close")}</button></div>
    <div class="db"><ol class="lb">${r.results.ranking.map(x => `<li class="${x.rank && x.rank <= 3 ? "r" + x.rank : ""}"><span class="rk">${x.rank ?? "—"}</span>
      <div class="nm"><b>${esc(x.team.name)}</b><small>${esc(x.team.project)}</small></div><div class="sc"><b>${x.score == null ? "—" : x.score.toFixed(2)}</b><small>${x.n} münsif</small></div></li>`).join("") || "<p class=\"sub\">Qiymət yoxdur.</p>"}</ol>
      <div class="row" style="margin-top:12px"><a class="btn sm" href="/api/admin/events/${id}/export.xlsx" download>${icon("sheet")}Excel</a><a class="btn sm" href="/api/admin/events/${id}/export.pdf" download>${icon("doc")}PDF</a>
      <a class="btn sm ghost" href="/api/admin/events/${id}/history.xlsx" download>${icon("list")}Tarixçə</a></div></div>`;
  archDlg.showModal();
}

main.addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  if (form.id === "evForm") { await saveEvent(); return; }
  if (form.id === "newEvForm") { await createEvent(); return; }
  if (form.id === "tagForm") {
    const input = $<HTMLInputElement>("#tagNew");
    const v = input.value.trim().replace(/\s+/g, " ");
    if (!v) { input.focus(); return; }
    if (S!.event.feedbackTags.some(x => x.toLocaleLowerCase("az") === v.toLocaleLowerCase("az"))) { toast("Bu etiket artıq var", "err"); return; }
    if (await saveTags([...S!.event.feedbackTags, v])) $<HTMLInputElement>("#tagNew").focus();
  }
});

async function saveTags(tags: string[]) {
  try {
    const r = await api<{ event: EventState }>("/api/admin/event", { method: "PATCH", body: { feedbackTags: tags } });
    S!.event.feedbackTags = r.event.feedbackTags;
    render();
    const el = document.getElementById("tagSaved");
    if (el) { el.textContent = "Saxlanıldı"; setTimeout(() => { el.textContent = ""; }, 1800); }
    return true;
  } catch (ex) { toast((ex as ApiError).message, "err"); return false; }
}

const cleanPrefix = (v: string) => v.trim().replace(/\s*(demo\s*day|hakaton|hackathon)\s*$/i, "");
main.addEventListener("input", e => {
  const el = e.target as HTMLInputElement;
  if (el.id === "evName" || el.id === "evProduct") $("#evPrev").innerHTML = brandHtml(brandName(cleanPrefix($<HTMLInputElement>("#evName").value), $<HTMLSelectElement>("#evProduct").value));
});
// Event fields save on change too (the page promises "saved when you leave the field"): durations reach every screen at once.
main.addEventListener("change", e => {
  const id = (e.target as HTMLElement).id;
  if (["evName", "evProduct", "evDate", "evPitch", "evQa"].includes(id)) saveEvent();
});

async function saveEvent() {
  const err = $("#evErr");
  const pitchSec = parseClock($<HTMLInputElement>("#evPitch").value);
  const qaSec = parseClock($<HTMLInputElement>("#evQa").value);
  const name = cleanPrefix($<HTMLInputElement>("#evName").value);
  const product = $<HTMLSelectElement>("#evProduct").value;
  if (!pitchSec || pitchSec < 10) { err.textContent = "Təqdimat müddətini dəq:san formatında yazın, məs. 3:00."; $("#evPitch").focus(); return; }
  if (!qaSec || qaSec < 10) { err.textContent = "Sual-cavab müddətini dəq:san formatında yazın, məs. 2:00."; $("#evQa").focus(); return; }
  err.textContent = "";
  try {
    const r = await api<{ stage: { eventName: string } }>("/api/admin/event", { method: "PATCH", body: {
      name, product, date: $<HTMLInputElement>("#evDate").value.trim(), pitchSec, qaSec,
      showJurorTotal: $("#evTotal").getAttribute("aria-checked") === "true",
    } });
    bar.setEventName(r.stage.eventName);
    $<HTMLInputElement>("#evName").value = name;
    $<HTMLInputElement>("#evPitch").value = fmtClock(pitchSec);
    $<HTMLInputElement>("#evQa").value = fmtClock(qaSec);
    if (S) { S.event.name = name; S.event.product = product; S.event.timer.pitchSec = pitchSec; S.event.timer.qaSec = qaSec; }
    const s = $("#evSaved"); s.textContent = "Saxlanıldı · bütün ekranlarda yeniləndi"; setTimeout(() => { s.textContent = ""; }, 2200);
  } catch (ex) { err.textContent = (ex as ApiError).message; }
}

// Drag teams by ⋮⋮ to change the running order (the ↑/↓ buttons stay for keyboards).
let teamSort: ReturnType<typeof sortable> | null = null;
function bindTeamSort() {
  if (teamSort) return;
  teamSort = sortable(main, {
    item: ".accs [data-id]", handle: ".grip",
    onDrop: async ids => {
      try { await api("/api/admin/teams/reorder", { method: "POST", body: { ids } }); toast("Komandaların sırası yeniləndi"); }
      catch (ex) { toast((ex as ApiError).message, "err"); }
      await load();
    },
  });
}
bindTeamSort();

onQrChange(() => load());
live({
  role: "admin",
  on: {
    "juror:joined": (p: { jurorId: number; displayName: string }) => { jurorJoined(p); load(); },
    "presence:changed": () => { /* session counts refresh on the next load */ },
    notice: (n: Notice) => { bell.push(n); void loadAccess(); },
    "materials:changed": () => void loadAccess(),
    "eventfiles:changed": () => void loadEventFiles(),
  },
  resync: load,
  status: online => bar.setOnline(online),
});

bindTeamAccess(main, () => MAT, loadAccess);
load();
