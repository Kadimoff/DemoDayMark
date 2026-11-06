import "./styles.css";
import { isPlaceholderName } from "../../shared/brand";
import { ordinal, type RevealEntry } from "../../shared/reveal";
import { displayParts, fmt2, type Results } from "../../shared/scoring";
import { fmtClock, type TimerView } from "../../shared/timer";
import type { AdminTeam, Criterion, Juror, PresenceEntry, ProgressEntry, ScoreRow, StagePayload, TimerAction, TimerState } from "../../shared/types";
import { api, ApiError } from "./lib/api";
import { now } from "./lib/clock";
import { $, ago, esc, flip, hhmm, icon, initials, toast } from "./lib/dom";
import { createJuror, jurorJoined, onQrChange, reissue } from "./lib/qr";
import { live } from "./lib/socket";
import { PHASE_LABEL, StageStrip } from "./lib/stage";
import { topbar } from "./lib/topbar";

interface EventState { name: string; date: string; currentTeamId: number | null; timer: TimerState; locked: boolean; showJurorTotal: boolean }
interface AdminData {
  results: Results;
  teams: AdminTeam[];
  jurors: Juror[];
  criteria: Criterion[];
  scores: Array<ScoreRow & { total: number | null }>;
  minJurorsForRank: number;
}
interface AdminState extends AdminData { event: EventState; stage: StagePayload; presence: PresenceEntry[]; progress: ProgressEntry[]; sessions: Array<{ userId: number }> }
interface AdminReveal {
  enabled: boolean; step: number; stepsTotal: number; snapshotAt: number | null; entries: RevealEntry[];
  next: { kind: "suspense" | "reveal"; index: number; entry: RevealEntry } | null;
  stale: boolean; unscored: number; progress: { done: number; need: number }; locked: boolean;
  public: { revealed: RevealEntry[]; suspense: { index: number; rank: number } | null; total: number };
}

const bar = topbar({
  role: "admin",
  nav: [
    { href: "/admin", label: "Canlı panel", current: true },
    { href: "/admin/setup", label: "Quraşdırma" },
    { href: "/timer", label: "Taymer", external: true },
    { href: "/reveal", label: "Nəticə açıqlaması", external: true },
  ],
  wide: true,
});
const strip = new StageStrip(null);
const main = $("#main");
const dlg = $<HTMLDialogElement>("#cellDlg");

let S: AdminState | null = null;
let editing: number | null = null; // id of the team being renamed inline
let wipeToken: { token: string; count: number } | null = null;
let flashKey = "";
let rv: AdminReveal | null = null;
let rvConfirm: "enable" | "reset" | null = null;
let built = false;

const activeTeams = () => (S ? S.teams.filter(t => t.active) : []);
const activeJurors = () => (S ? S.jurors.filter(j => j.active) : []);
const scoreOf = (jurorId: number, teamId: number) => S?.scores.find(s => s.jurorId === jurorId && s.teamId === teamId) ?? null;
const fmtE = (v: number) => (Math.round(v * 100) / 100).toFixed(1);

async function load() {
  try {
    S = await api<AdminState>("/api/admin/state");
  } catch (e) {
    if (!S) main.innerHTML = `<div class="banner err">${esc((e as Error).message)}</div>`;
    return;
  }
  bar.setEventName(S.stage.eventName);
  strip.set(S.stage);
  renderAll();
}

async function patchEvent(body: Record<string, unknown>) {
  try {
    const r = await api<{ event: EventState; stage: StagePayload }>("/api/admin/event", { method: "PATCH", body });
    if (S) { S.event = r.event; S.stage = r.stage; }
    strip.set(r.stage);
    renderStage();
    renderOrder();
    renderKpis();
  } catch (e) { toast((e as ApiError).message, "err"); }
}

async function nextTeam() {
  editing = null;
  try {
    const r = await api<{ event: EventState; stage: StagePayload }>("/api/admin/event/next", { method: "POST" });
    if (!S) return;
    S.event = r.event; S.stage = r.stage; strip.set(r.stage);
    renderStage(); renderOrder(); renderJury(); renderKpis();
  } catch (ex) { toast((ex as ApiError).message, "err"); }
}

// ---------- layout ----------
function build() {
  main.innerHTML = `
    <section class="card hero" id="hero"></section>
    <div class="kpis section-gap" id="kpis"></div>
    <div class="cgrid section-gap">
      <section class="card pad-lg stagebox" id="stageCard" aria-label="Səhnə idarəsi"></section>
      <section class="card pad-lg stack" id="orderCard" aria-labelledby="h-order"></section>
    </div>
    <section class="card pad-lg stack section-gap" id="juryCard" aria-labelledby="h-jury"></section>
    <section class="card pad-lg stack section-gap" id="revealCard" aria-labelledby="h-rv"></section>
    <div class="grid2 section-gap">
      <section>
        <div class="head" style="margin-bottom:12px"><div><h2>${icon("medal")}Reytinq</h2><p class="sub" id="lbFormula"></p></div></div>
        <div class="card" style="overflow:hidden" id="lbCard"></div>
      </section>
      <section class="card" id="matrixCard"></section>
    </div>
    <section class="card section-gap" id="heatCard"></section>
    <div class="grid2 section-gap">
      <section class="card pad-lg stack" id="exportCard"></section>
      <section class="card pad-lg stack" id="dangerCard"></section>
    </div>
    <div class="footbar"><span id="footBrand"></span><span>Avto-sinxronizasiya: açıq</span></div>`;
  built = true;
}

function renderAll() {
  if (!S) return;
  if (!built) build();
  renderHero();
  renderKpis();
  renderStage();
  renderOrder();
  renderJury();
  renderRanking();
  renderMatrix();
  renderHeat();
  renderExports();
  renderDanger();
  loadReveal();
}

function renderHero() {
  if (!S) return;
  $("#hero").innerHTML = `
    <div class="t"><span class="flame" aria-hidden="true"></span>
      <div><h1>Canlı səhnə idarəetməsi <span class="pill hot">${esc(S.stage.eventName)}${S.event.date ? ` / ${esc(S.event.date)}` : ""}</span></h1>
      <p class="sub">Səhnə tempi, real vaxtda münsif sinxronizasiyası və nəticə açıqlaması</p></div></div>
    <div class="row">
      <a class="btn sm" href="/timer" target="_blank" rel="noopener">${icon("timer")}Proyektor taymeri</a>
      <button class="btn sm primary" id="heroQr">${icon("qr")}Münsif QR yarat</button>
    </div>`;
  $("#footBrand").textContent = `${S.stage.eventName} · Tədbir idarəetmə sistemi`;
}

// ---------- KPI row ----------
function renderKpis(v?: TimerView) {
  if (!S) return;
  const box = document.getElementById("kpis");
  if (!box) return;
  const teams = activeTeams();
  const jurors = activeJurors();
  const cur = teams.find(t => t.id === S!.event.currentTeamId) ?? null;
  const pres = new Map(S.presence.map(p => [p.jurorId, p]));
  const onlineN = jurors.filter(j => pres.get(j.id)?.online).length;
  const pending = jurors.filter(j => isPlaceholderName(j.displayName)).length;
  const { done, need } = S.results;
  const pct = need ? Math.round((done / need) * 1000) / 10 : 0;
  const sig = JSON.stringify([cur?.id, cur?.name, done, need, onlineN, jurors.length, pending, S.event.locked, rv?.enabled, rv?.step, rv?.stepsTotal, jurors.map(j => !!pres.get(j.id)?.online)]);
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = `
      <div class="kpi">
        <div class="top-r"><h3>Cari səhnədə</h3><span class="pill hot" id="kpiPhase">—</span></div>
        <div class="big">${cur ? `<span class="mono acc-t">#${String(teams.indexOf(cur) + 1).padStart(2, "0")}</span> ${esc(cur.name)}` : `<span class="faint">Səhnə boşdur</span>`}</div>
        <div class="ln" id="kpiTime">${cur ? "" : "Aşağıdan komanda seçin"}</div>
      </div>
      <div class="kpi">
        <div class="top-r"><h3>Səsvermə irəliləyişi</h3><span class="pill ok">${pct}% tamam</span></div>
        <div class="big mono">${done}<small>/ ${need} səs qəbul edildi</small></div>
        <div class="ln">${teams.length} komanda × ${jurors.length} münsif</div>
        <div class="progress"><i style="width:${pct}%"></i></div>
      </div>
      <div class="kpi">
        <div class="top-r"><h3>Münsif qoşulması</h3><span class="dots">${jurors.map(j => `<i class="dot ${pres.get(j.id)?.online ? "on" : ""}"></i>`).join("")}</span></div>
        <div class="big ${onlineN === jurors.length && jurors.length ? "ok-t" : ""}">${onlineN} / ${jurors.length} <small>onlayn</small></div>
        <div class="ln">${pending ? `<span class="warn-t">${pending} münsif QR gözləyir</span>` : jurors.length ? "Bütün münsiflər qoşulub" : "Münsif yoxdur"}</div>
      </div>
      <div class="kpi">
        <div class="top-r"><h3>Sistem vəziyyəti</h3><span class="pill ${S.event.locked ? "warn" : "ok"}">${S.event.locked ? "Bağlı" : "Açıq"}</span></div>
        <div class="row between" style="flex-wrap:nowrap"><div class="big" style="font-size:18px">${S.event.locked ? "Səsvermə bağlıdır" : "Səsvermə açıqdır"}</div>
          <button class="sw" role="switch" aria-checked="${S.event.locked}" id="lockSw" aria-label="Qiymətləndirməni bağla"></button></div>
        <div class="ln">Açıqlama: ${rv?.enabled ? `<span class="acc-t mono">${rv.step}/${rv.stepsTotal} addım</span>` : "gözləmədə"}</div>
      </div>`;
  }
  // live part
  const kp = document.getElementById("kpiPhase");
  const kt = document.getElementById("kpiTime");
  const view = v ?? null;
  if (kp) kp.textContent = !cur ? "—" : !view || view.kind === "idle" ? "Hazırlıq" : view.ready ? "Hazır" : `Faza: ${PHASE_LABEL[view.kind]}`;
  if (kt && cur) kt.innerHTML = !view || view.kind === "idle" ? `<span class="dot"></span>Taymer başlamayıb`
    : `<span class="dot ${view.kind === "done" ? "off" : view.running ? "on" : "busy"}"></span>${PHASE_LABEL[view.kind]} · <span class="mono">${fmtClock(view.remaining)}</span> qalıb${!view.running && view.kind !== "done" ? " · fasilə" : ""}`;
}

// ---------- stage + timer control ----------
function renderStage() {
  if (!S) return;
  const card = $("#stageCard");
  const teams = activeTeams();
  const cur = teams.find(t => t.id === S!.event.currentTeamId) ?? null;
  if (editing != null && editing !== cur?.id) editing = null;
  if (editing != null && card.querySelector("#renameForm")) { renderTimerCtl(); return; }
  const E = S.results.entryMax;
  card.innerHTML = `
    <div class="bar1">
      <div class="row">
        ${cur ? `<span class="pill live">Səhnədə aktivdir</span>` : `<span class="pill">Səhnə boşdur</span>`}
        ${cur ? `<span class="caps">Giriş balı: <span class="mono" style="color:var(--fg)">${cur.entryScore != null ? fmtE(cur.entryScore) : "—"} / ${fmtE(E)}</span></span>` : ""}
      </div>
      ${cur ? `<button class="btn sm" id="rename">${icon("pencil")}Adı dəyiş</button>` : ""}
    </div>
    <div id="onstage">
      ${cur ? `<span class="caps acc-t">Komanda #${String(teams.indexOf(cur) + 1).padStart(2, "0")} · ${teams.indexOf(cur) + 1} / ${teams.length}</span>
        <div class="row between" style="align-items:flex-end;margin-top:4px">
          <div style="min-width:0;flex:1 1 280px"><div class="tname">${esc(cur.name)}</div><p class="tproj">${esc(cur.project || "Layihə adı yoxdur")}</p></div>
          <div class="phases" id="phases"><span data-ph="pitch">Pitch (${fmtClock(S.stage.timer.pitchSec)})</span><span data-ph="qa">Sual-cavab (${fmtClock(S.stage.timer.qaSec)})</span><span data-ph="done">Vaxt bitdi</span></div>
        </div>`
      : `<div class="tname faint">Səhnədə komanda yoxdur</div><p class="tproj">Sağdakı siyahıdan komandanı seçin və ya “Növbəti” düyməsini basın.</p>`}
    </div>
    <div class="clockbox" id="clockbox"><div class="lbl">Qalan müddət</div><b id="clockT">—</b><div class="sync"><span id="clockSrv"></span><span class="live-t">· Canlı geri sayım</span></div></div>
    <div class="tbtns" id="tbtns"></div>
    <div class="tmore" id="tmore"></div>`;
  renderTimerCtl();
}

function renderTimerCtl(v?: TimerView) {
  const box = document.getElementById("tbtns");
  if (!box || !S) return;
  const t = S.stage.timer;
  const view = v ?? null;
  const kind = view?.kind ?? (t.visible ? "pitch" : "idle");
  const running = view?.running ?? t.running;
  const hasTeam = !!S.event.currentTeamId;
  const sig = `${kind}|${running}|${hasTeam}|${t.pitchSec}|${t.qaSec}|${view?.ready}`;
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    const toggleLbl = running ? `${icon("pause")}Fasilə` : `${icon("play")}${kind === "idle" || view?.ready ? "Başlat" : "Davam"}`;
    box.innerHTML = `
      <button class="btn stackd ${running ? "" : "primary"}" data-timer="toggle" ${hasTeam ? "" : "disabled"}><span>${toggleLbl}</span><span class="kbd">[Space]</span></button>
      <button class="btn stackd ${kind === "qa" && running ? "on" : ""}" data-timer="qa" ${hasTeam ? "" : "disabled"}><span>${icon("skip")}Sual-cavab</span><span class="kbd">[Q / S] · ${fmtClock(t.qaSec)}</span></button>
      <button class="btn stackd" data-timer="reset" ${kind === "idle" ? "disabled" : ""}><span>${icon("reset")}Sıfırla</span><span class="kbd">[R] Hazır</span></button>
      <button class="btn stackd" id="nextTeam"><span>${icon("next")}Növbəti</span><span class="kbd">[N] Çıxar</span></button>`;
    $("#tmore").innerHTML = `
      <button class="btn sm ${kind === "pitch" && running ? "on" : ""}" data-timer="pitch" ${hasTeam ? "" : "disabled"}>${icon("play")}Pitch-i başdan · ${fmtClock(t.pitchSec)}</button>
      <button class="btn sm ghost" data-timer="stop" ${kind === "idle" ? "disabled" : ""}>${icon("stop")}Taymeri gizlət</button>
      <button class="btn sm ghost" id="clearStage" ${hasTeam ? "" : "disabled"}>Səhnəni boşalt</button>
      <a class="btn sm ghost" href="/timer" target="_blank" rel="noopener">${icon("ext")}Proyektor taymeri</a>`;
  }
  const cb = document.getElementById("clockbox");
  if (!cb) return;
  const T = $("#clockT");
  if (view && view.kind !== "idle") {
    T.textContent = fmtClock(view.remaining);
    cb.className = `clockbox${view.kind === "done" ? " over" : view.remaining <= 30 && !view.ready && view.running ? " warn" : ""}`;
  } else {
    T.textContent = fmtClock(t.pitchSec);
    cb.className = "clockbox idle";
  }
  const d = new Date(now());
  $("#clockSrv").textContent = `● Server saatı: ${hhmm(d.getTime())}:${String(d.getSeconds()).padStart(2, "0")}`;
  document.querySelectorAll<HTMLElement>("#phases [data-ph]").forEach(el => {
    const on = !!view && view.kind !== "idle" && el.dataset.ph === view.kind;
    el.className = on ? `on ${view!.kind}` : "";
  });
}
strip.onTick(v => { renderTimerCtl(v); renderKpis(v); });

// ---------- running order ----------
function renderOrder() {
  if (!S) return;
  const teams = activeTeams();
  const cur = S.event.currentTeamId;
  const ci = teams.findIndex(t => t.id === cur);
  const nJ = activeJurors().length;
  const doneFor = (teamId: number) => S!.results.ranking.find(r => r.team.id === teamId)?.n ?? 0;
  $("#orderCard").innerHTML = `
    <div class="head"><h2 id="h-order">${icon("list")}Püşk ardıcıllığı</h2><span class="caps">${teams.length} komanda</span></div>
    <div class="order">${teams.map((t, i) => {
      const n = doneFor(t.id);
      const st = t.id === cur ? `<span class="pill fill">Səhnədə</span>`
        : nJ && n >= nJ ? `<span class="pill ok">${icon("check")}${n}/${nJ}</span>`
        : ci >= 0 && i === ci + 1 ? `<span class="st acc-t">Növbədə</span>`
        : n ? `<span class="st">${n}/${nJ} səs</span>` : `<span class="st">Gözləyir</span>`;
      return `<button data-cur="${t.id}" aria-pressed="${t.id === cur}"><span class="ix">#${String(i + 1).padStart(2, "0")}</span>
        <span class="nm"><b>${esc(t.name)}</b><small>${esc(t.project || "—")}</small></span>${st}</button>`;
    }).join("") || `<p class="note">Aktiv komanda yoxdur.</p>`}</div>
    <a class="btn sm ghost" href="/admin/setup" style="margin-top:auto">${icon("list")}Ardıcıllığı yenidən nizamla</a>`;
}

// ---------- jurors: live voting state ----------
function renderJury() {
  if (!S) return;
  const card = $("#juryCard");
  const cur = activeTeams().find(t => t.id === S!.event.currentTeamId) ?? null;
  const jurors = activeJurors();
  const pres = new Map(S.presence.map(p => [p.jurorId, p]));
  const sessions = new Set(S.sessions?.map(s => s.userId) ?? []);
  const nCrit = S.criteria.length;
  const D = S.results.demoMax;
  const waiting = cur ? jurors.filter(j => !scoreOf(j.id, cur.id)).length : 0;
  card.innerHTML = `
    <div class="head">
      <div><h2 id="h-jury">${icon("users")}Münsiflərin canlı səsvermə vəziyyəti ${cur ? `<span class="pill">#${String(activeTeams().indexOf(cur) + 1).padStart(2, "0")} ${esc(cur.name)} üzrə</span>` : ""}</h2>
        <p class="sub">Hər münsifin telefonundan gələn bal və doldurma gedişatı (bal dəyərləri yalnız göndəriləndən sonra görünür)</p></div>
      <div class="row">
        <button class="btn sm primary" id="nudge" ${cur && waiting && !S.event.locked ? "" : "disabled"}>${icon("bell")}Səs verməyənləri xəbərdar et${cur && waiting ? ` (${waiting})` : ""}</button>
        <button class="btn sm" id="lockBtn">${icon("lock")}${S.event.locked ? "Kilidi aç" : "Səsverməni bağla"}</button>
      </div>
    </div>
    <div class="jgrid">${jurors.map(j => {
      const p = pres.get(j.id);
      const pendingQr = isPlaceholderName(j.displayName) && !sessions.has(j.id);
      const sc = cur ? scoreOf(j.id, cur.id) : null;
      const prog = cur ? S!.progress.find(x => x.jurorId === j.id && x.teamId === cur.id) : null;
      let cls = "", k = "", v = "", tag = "";
      if (pendingQr) { cls = "pending"; k = "QR gözləyir"; v = `<span>Hələ skan edilməyib</span>`; tag = ""; }
      else if (!cur) { k = p?.online ? "Onlayn" : "Oflayn"; v = `<span>${S!.scores.filter(s => s.jurorId === j.id).length} komanda qiymətləndirib</span>`; }
      else if (sc) { cls = "sent"; k = "Səs verdi"; v = `${sc.total ?? "…"} <span>/ ${D}</span>`; tag = `<span class="ago">${ago(sc.updatedAt)}</span>`; }
      else if (prog && prog.filled > 0) { cls = "busy"; k = "Doldurur…"; v = `${prog.filled} <span>/ ${nCrit} meyar</span>`; tag = `<span class="ago">Yazır…</span>`; }
      else { k = "Gözləyir"; v = `-- <span>/ ${D}</span>`; tag = `<span class="ago" style="color:var(--muted);background:var(--surface-3)">${p?.online ? "Onlayn" : "Oflayn"}</span>`; }
      const dot = pendingQr ? "" : cls === "busy" ? "busy" : p?.online ? "on" : "off";
      return `<div class="jcard ${cls}">
        <div class="tr"><span class="ini">${esc(initials(j.displayName))}</span><span class="dot ${dot}" title="${p?.online ? "Onlayn" : p?.lastSeen ? `Son görülmə ${hhmm(p.lastSeen)}` : "Oflayn"}"></span></div>
        <button class="qr-btn" data-qr="${j.id}" title="Yeni QR (əlaqə itibsə)" aria-label="${esc(j.displayName)} üçün yeni QR">${icon("qr")}</button>
        <div class="nm"><b>${esc(j.displayName)}</b><small>${pendingQr ? "QR ilə qoşulmayıb" : p?.online ? "Onlayn" : p?.lastSeen ? `Son görülmə ${hhmm(p.lastSeen)}` : "Oflayn"}</small></div>
        <div class="box"><div><div class="k">${k}</div><div class="v">${v}</div></div>${tag}</div>
        ${pendingQr ? `<button class="btn sm outline-acc" data-qr="${j.id}">${icon("qr")}QR göstər</button>` : ""}
      </div>`;
    }).join("")}
      <button class="addj" id="addJuror">${icon("plus")}<span>Münsif əlavə et<br><small class="faint">QR kod yaradılır</small></span></button>
    </div>`;
}

// ---------- results reveal ----------
async function loadReveal() {
  try { rv = await api<AdminReveal>("/api/admin/reveal"); } catch { return; }
  renderReveal();
  renderKpis();
}
async function revealAction(action: string) {
  try { rv = await api<AdminReveal>("/api/admin/reveal", { method: "POST", body: { action } }); }
  catch (ex) { toast((ex as ApiError).message, "err"); }
  rvConfirm = null;
  renderReveal();
  renderKpis();
}
function renderReveal() {
  const card = document.getElementById("revealCard");
  if (!card || !rv) return;
  const n = rv.next;
  const done = rv.enabled && !n && rv.stepsTotal > 0;
  const label = !rv.enabled ? "Sıradakını açıqla"
    : done ? "Bütün yerlər açıqlandı"
    : n!.kind === "suspense" ? `${ordinal(n!.entry.rank)} yer: intizarı başlat`
    : n!.entry.rank <= 3 ? `${ordinal(n!.entry.rank)} yeri açıqla`
    : `Sıradakını açıqla (${ordinal(n!.entry.rank)} yer)`;
  const total = rv.entries.length;
  const revealedN = rv.public?.revealed?.length ?? 0;
  const susp = rv.public?.suspense;
  const headline = !rv.enabled ? (rv.snapshotAt ? "Gözləmə rejimi" : "Açıqlama başlamayıb")
    : done ? "Qalib elan olundu"
    : susp ? `${ordinal(susp.rank)} yer intizardadır`
    : revealedN ? `${ordinal(rv.entries[total - revealedN]?.rank ?? 0)} yer açıqlandı` : "Ekran hazırdır";
  const subline = !rv.enabled ? "Proyektorda yalnız “Nəticələr tezliklə açıqlanacaq” yazısı görünür."
    : susp ? "Səhnə monitorunda ürək döyüntüsü gedir. Komandanın adı və yekun balı hələ örtülüdür."
    : done ? "Bütün yerlər açıqlanıb." : "Növbəti addım üçün düyməni basın.";
  const { done: d, need } = rv.progress;
  card.innerHTML = `
    <div class="head">
      <div><h2 id="h-rv">${icon("medal")}Nəticə açıqlaması <span class="pill ${rv.enabled ? "ok" : ""}">${rv.enabled ? "İcazə verilib" : "Gözləmədə"}</span></h2>
        <p class="sub">Səhnə monitorunda qalib təqdimatı üçün addım-addım intizar və server tərəfindən idarə olunan açıqlama</p></div>
      <div class="allow"><span>Açıqlamaya icazə ver</span><button class="sw" role="switch" aria-checked="${rv.enabled}" id="rvAllow" aria-label="Açıqlamaya icazə ver"></button></div>
    </div>
    ${rvConfirm === "enable" ? `<div class="confirm"><span>Qiymətləndirmə bağlanacaq və cari reytinq qeydə alınacaq. Daxil olan qiymətlər: <b class="mono">${d}/${need}</b>${d < need ? " (hamısı daxil olmayıb!)" : ""}${rv.unscored ? ` · ${rv.unscored} komanda qiymətləndirilməyib və açıqlamaya düşməyəcək.` : ""}</span>
      <button class="btn sm primary" id="rvYes">Bəli, icazə ver</button><button class="btn sm" id="rvNo">Ləğv et</button></div>` : ""}
    ${rvConfirm === "reset" ? `<div class="confirm"><span>Açıqlama əvvələ qayıdacaq və reytinq yenidən qeydə alınacaq.</span>
      <button class="btn sm danger solid" id="rvResetYes">Bəli, sıfırla</button><button class="btn sm" id="rvNo">Ləğv et</button></div>` : ""}
    ${rv.stale ? `<p class="banner lock" style="margin:0">${icon("warn")}<span>Reytinq qeydə alınandan sonra ballar dəyişib. Yeni vəziyyəti göstərmək üçün “Açıqlamanı sıfırla” basın.</span></p>` : ""}
    <div class="rvbox">
      <div class="rvstat">
        <div class="row between"><h3>Hazırkı elan vəziyyəti</h3><span class="pill hot mono">${revealedN} / ${total} komanda açıqlanıb</span></div>
        <div class="headline">${icon(susp ? "lock" : done ? "medal" : "sparkle")}${esc(headline)}</div>
        <p class="sub" style="margin:0">${subline}</p>
        <div class="segs">${Array.from({ length: Math.max(total, 1) }, (_, i) => `<i class="${i < revealedN ? "done" : i === revealedN && susp ? "cur" : ""}"></i>`).join("")}</div>
      </div>
      <div class="rvacts">
        <button class="btn" id="rvBack" ${rv.enabled && rv.step > 0 ? "" : "disabled"}>${icon("back")}Geri</button>
        <button class="btn primary" id="rvNext" ${rv.enabled && n ? "" : "disabled"}>${icon("play")}${esc(label)}</button>
        <button class="btn sm ghost" id="rvReset" ${rv.snapshotAt ? "" : "disabled"}>${icon("reset")}Açıqlamanı sıfırla</button>
        <a class="btn sm ghost" href="/reveal" target="_blank" rel="noopener">${icon("ext")}Açıqlama ekranı</a>
        ${rv.enabled && n ? `<p class="sub" style="grid-column:1/-1;margin:0">Növbəti (yalnız siz görürsünüz): <b style="color:var(--fg)">${esc(n.entry.name)}</b> · <span class="mono">${fmt2(n.entry.score)}</span></p>` : ""}
      </div>
    </div>
    <div class="isolation">${icon("shield")}<span><b>Server tərəfində izolyasiya:</b> reytinq dondurulub. İntizar addımında heç bir münsif və ya tamaşaçı yekun balı şəbəkə üzərindən qabaqcadan görə bilməz.</span></div>`;
}

// ---------- ranking ----------
function renderRanking() {
  if (!S) return;
  const card = $("#lbCard");
  const after = flip(card);
  const nJ = activeJurors().length;
  const rows = S.results.ranking;
  const { demoMax: D, entryMax: E, maxTotal: T, includeEntry } = S.results;
  document.getElementById("lbFormula")!.textContent = includeEntry
    ? `Yekun = giriş balı (maks. ${E}) + Demo Day balı, münsiflərin orta balı (maks. ${D}); cəmi ${T}. Bərabərlikdə Demo Day balı, sonra ən yüksək maksimumlu meyarlar həlledicidir.`
    : `Yekun = Demo Day balı, münsiflərin orta balı (maks. ${D}). Giriş balı yekuna daxil edilmir.`;
  card.innerHTML = rows.length ? `<ol class="lb">${rows.map(x => `
    <li data-flip="${x.team.id}" class="${x.rank ? (x.rank <= 3 ? "r" + x.rank : "") : "none"}">
      <span class="rk">${x.rank ?? "—"}</span>
      <div class="nm"><b>${esc(x.team.name)} ${x.incomplete && x.n ? `<span class="pill warn" title="${S!.minJurorsForRank}-dən az münsif qiymətləndirib">eksik</span>` : ""}${includeEntry && x.entry == null ? `<span class="pill" title="Quraşdırmada giriş balını yazın">giriş balı yoxdur</span>` : ""}</b>
        <small>${!includeEntry ? esc(x.team.project || "—")
          : x.score == null ? `Giriş <span class="v">${fmt2(x.entry)}</span> · Demo Day —`
          : (p => `Giriş <span class="v">${p.entry}</span> + Demo Day <span class="v">${p.demo}</span>`)(displayParts(x.score, x.entry))}</small>
        <div class="track"><i style="width:${x.score != null && T ? Math.min(100, Math.max(0, (x.score / T) * 100)) : 0}%"></i></div></div>
      <div class="sc"><b>${fmt2(x.score)}</b><small>${x.n}/${nJ} münsif${x.n > 1 ? ` · ${x.min}–${x.max}` : ""}</small></div>
    </li>`).join("")}</ol>` : `<p class="empty">Aktiv komanda yoxdur.</p>`;
  after();
}

// ---------- juror × team matrix ----------
function renderMatrix() {
  if (!S) return;
  const jurors = S.jurors.filter(j => j.active || S!.scores.some(s => s.jurorId === j.id));
  const teams = activeTeams();
  $("#matrixCard").innerHTML = `
    <div class="pad" style="padding-bottom:8px"><h2>${icon("sheet")}Münsif matrisi</h2><p class="sub">Hər xana münsifin Demo Day cəmidir (maks. ${S.results.demoMax}). Toxunun: meyar balları, rəylər və şərh.</p></div>
    <div class="tbl"><table>
      <thead><tr><th>Komanda</th>${jurors.map((j, i) => `<th class="num" title="${esc(j.displayName)}">M${i + 1}</th>`).join("")}<th class="num" title="Demo Day orta balı">Demo</th></tr></thead>
      <tbody>${teams.map(t => {
        const avg = S!.results.ranking.find(r => r.team.id === t.id)?.demo ?? null;
        return `<tr><td>${esc(t.name)}</td>${jurors.map(j => {
          const v = S!.results.matrix[t.id]?.[j.id];
          const has = !!scoreOf(j.id, t.id);
          const k = `${j.id}:${t.id}`;
          return has ? `<td class="cell${flashKey === k ? " flash" : ""}"><button data-cell="${k}" aria-label="${esc(j.displayName)}: ${esc(t.name)}">${v != null ? v : "…"}</button></td>`
            : `<td class="num miss">—</td>`;
        }).join("")}<td class="num"><b>${fmt2(avg)}</b></td></tr>`;
      }).join("")}</tbody>
    </table></div>
    <div class="pad" style="padding-top:10px"><p class="sub" style="margin:0">${jurors.map((j, i) => `M${i + 1}: ${esc(j.displayName)}`).join(" · ") || "Münsif yoxdur"}</p></div>`;
  flashKey = "";
}

function openCell(jurorId: number, teamId: number) {
  if (!S) return;
  const s = scoreOf(jurorId, teamId);
  const j = S.jurors.find(x => x.id === jurorId);
  const t = S.teams.find(x => x.id === teamId);
  if (!s || !j || !t) return;
  dlg.innerHTML = `
    <div class="dh"><div><h3>${esc(j.displayName)}</h3><h2 id="cellTitle" style="font-size:19px;margin-top:4px">${esc(t.name)}</h2></div>
      <button class="icon-btn" id="dlgClose" aria-label="Bağla">${icon("close")}</button></div>
    <div class="db">
      <div class="vals">${S.criteria.map(c => `<span>${esc(c.name)}</span><b>${s.values[c.key] ?? "—"} <span class="sub" style="font-size:12px">/ ${c.maxScore}</span></b>`).join("")}
        <span style="border-top:1px solid var(--line);padding-top:6px"><b style="font-family:var(--f-body);text-align:left">Cəmi (Demo Day)</b></span><b style="border-top:1px solid var(--line);padding-top:6px">${s.total ?? "—"} <span class="sub" style="font-size:12px">/ ${S.results.demoMax}</span></b></div>
      ${s.tags?.length ? `<div class="tagrow">${s.tags.map(x => `<span>${esc(x)}</span>`).join("")}</div>` : ""}
      ${s.note ? `<blockquote>${esc(s.note)}</blockquote>` : `<p class="sub">Şərh yazılmayıb.</p>`}
      <p class="sub" style="margin-top:12px">Son dəyişiklik: ${hhmm(s.updatedAt)}</p>
    </div>`;
  dlg.showModal();
}
dlg.addEventListener("click", e => {
  if ((e.target as HTMLElement).closest("#dlgClose") || e.target === dlg) dlg.close();
});

// ---------- criteria heat map ----------
function renderHeat() {
  if (!S) return;
  const crit = S.criteria;
  const { demoMax: D, entryMax: E, maxTotal: T, includeEntry } = S.results;
  $("#heatCard").innerHTML = `
    <div class="pad" style="padding-bottom:8px"><h2>Meyarlar üzrə orta bal</h2></div>
    <div class="tbl"><table>
      <thead><tr><th>Yer</th><th>Komanda</th>${crit.map(c => `<th class="num" title="${esc(c.description)}">${esc(c.name)}<br><span style="font-weight:500">maks. ${c.maxScore}</span></th>`).join("")}
        <th class="num">Demo Day<br><span style="font-weight:500">maks. ${D}</span></th>
        <th class="num">Giriş<br><span style="font-weight:500">${includeEntry ? `maks. ${E}` : "daxil deyil"}</span></th>
        <th class="num">Yekun<br><span style="font-weight:500">maks. ${T}</span></th></tr></thead>
      <tbody>${S.results.ranking.map(x => `<tr><td class="mono">${x.rank ?? "—"}</td><td>${esc(x.team.name)}</td>${crit.map(c => {
        const v = x.perCriterion[c.key];
        // Colour by share of the criterion's maximum, so 4/5 and 8/10 look alike.
        return v == null ? `<td class="num miss">—</td>` : `<td class="num heat" style="--h:${Math.round(Math.max(0, (v / c.maxScore) * 10 - 4) * 6)}">${v.toFixed(1)}</td>`;
      }).join("")}${(p => `<td class="num">${p.demo}</td><td class="num${includeEntry ? "" : " miss"}">${p.entry}</td><td class="num"><b>${p.score}</b></td>`)(
        x.score != null && includeEntry ? displayParts(x.score, x.entry) : { demo: fmt2(x.demo), entry: fmt2(x.entry), score: fmt2(x.score) })}</tr>`).join("")}</tbody>
    </table></div>`;
}

// ---------- exports & danger zone ----------
function renderExports() {
  $("#exportCard").innerHTML = `
    <div class="head"><div><h2>${icon("download")}Hesabatlar və protokollar</h2><p class="sub">Münsiflərin yekun ballar cədvəli, meyar bölgüsü, sürətli rəylər və şərhlər</p></div><span class="caps acc-t">Canlı generasiya</span></div>
    <div class="exports">
      <a class="tile" href="/api/admin/export.xlsx" download><span class="ti x">${icon("sheet")}</span><span><b>Excel yüklə (.xlsx)</b><small>Tam matris və şərhlər</small></span></a>
      <a class="tile" href="/api/admin/export.pdf" download><span class="ti p">${icon("doc")}</span><span><b>Rəsmi PDF protokol</b><small>İmza üçün protokol</small></span></a>
    </div>`;
}
function renderDanger() {
  if (!S) return;
  const n = S.scores.length;
  $("#dangerCard").innerHTML = `
    <div class="head"><h2 style="color:#FCA5A5">${icon("warn")}Təhlükəli zona</h2><span class="dz-pill">Danger zone</span></div>
    <p class="sub" style="margin:0">Bu əməliyyat canlı sessiyanın məlumatlarını geri dönməz şəkildə dəyişir. Silməzdən əvvəl yedək alın.</p>
    ${wipeToken
      ? `<div class="confirm"><span>Bütün <b>${wipeToken.count}</b> qiymət birdəfəlik silinəcək. Əminsiniz?</span>
          <button class="btn danger solid sm" id="wipeYes">Bəli, sil</button><button class="btn sm" id="wipeNo">Ləğv et</button></div>`
      : `<button class="btn danger" id="wipe" ${n ? "" : "disabled"}>${icon("trash")}Bütün qiymətləri sıfırla / sil</button>`}`;
}

// ---------- interactions ----------
main.addEventListener("click", async e => {
  const t = e.target as HTMLElement;
  if (!S) return;
  const cur = t.closest<HTMLElement>("[data-cur]");
  if (cur) {
    const id = Number(cur.dataset.cur);
    if (id !== S.event.currentTeamId) { editing = null; patchEvent({ currentTeamId: id }); }
    return;
  }
  const tm = t.closest<HTMLButtonElement>("[data-timer]");
  if (tm && !tm.disabled) { patchEvent({ timer: tm.dataset.timer as TimerAction }); return; }
  if (t.closest("#nextTeam")) { nextTeam(); return; }
  if (t.closest("#clearStage")) { editing = null; patchEvent({ currentTeamId: null }); return; }
  if (t.closest("#rename")) {
    const team = S.teams.find(x => x.id === S!.event.currentTeamId);
    if (!team) return;
    editing = team.id;
    $("#onstage").innerHTML = `<form id="renameForm" class="onstage"><div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto auto;gap:8px">
      <input type="text" id="rnName" value="${esc(team.name)}" aria-label="Komanda adı" maxlength="120" required>
      <input type="text" id="rnProj" value="${esc(team.project)}" aria-label="Layihə" placeholder="Layihə / məhsul" maxlength="160">
      <button class="btn primary sm" type="submit">Saxla</button><button class="btn sm" type="button" id="rnCancel">Ləğv et</button></div></form>`;
    $<HTMLInputElement>("#rnName").select();
    return;
  }
  if (t.closest("#rnCancel")) { editing = null; renderStage(); return; }
  if (t.closest("#lockSw") || t.closest("#lockBtn")) { await patchEvent({ locked: !S.event.locked }); renderJury(); return; }
  if (t.closest("#heroQr") || t.closest("#addJuror")) { createJuror(); return; }
  const qr = t.closest<HTMLElement>("[data-qr]");
  if (qr) {
    const j = S.jurors.find(x => x.id === Number(qr.dataset.qr));
    if (j) reissue(j);
    return;
  }
  if (t.closest("#nudge")) {
    try {
      const r = await api<{ nudged: number }>("/api/admin/nudge", { method: "POST", body: {} });
      toast(r.nudged ? `Xəbərdar edildi: ${r.nudged} münsif` : "Hamı artıq səs verib");
    } catch (ex) { toast((ex as ApiError).message, "err"); }
    return;
  }
  if (t.closest("#rvAllow") && rv) {
    if (rv.enabled) revealAction("disable");
    else { rvConfirm = "enable"; renderReveal(); }
    return;
  }
  if (t.closest("#rvYes")) { revealAction("enable"); return; }
  if (t.closest("#rvNo")) { rvConfirm = null; renderReveal(); return; }
  if (t.closest("#rvNext")) { revealAction("next"); return; }
  if (t.closest("#rvBack")) { revealAction("back"); return; }
  if (t.closest("#rvReset")) { rvConfirm = "reset"; renderReveal(); return; }
  if (t.closest("#rvResetYes")) { revealAction("reset"); return; }
  const cell = t.closest<HTMLElement>("[data-cell]");
  if (cell) { const [j, tm2] = cell.dataset.cell!.split(":").map(Number); openCell(j, tm2); return; }
  if (t.closest("#wipe")) {
    try { wipeToken = await api<{ token: string; count: number }>("/api/admin/scores/wipe-token", { method: "POST" }); renderDanger(); }
    catch (ex) { toast((ex as ApiError).message, "err"); }
    return;
  }
  if (t.closest("#wipeNo")) { wipeToken = null; renderDanger(); return; }
  if (t.closest("#wipeYes") && wipeToken) {
    try {
      const r = await api<{ deleted: number }>("/api/admin/scores", { method: "DELETE", body: { token: wipeToken.token } });
      toast(`${r.deleted} qiymət silindi`);
    } catch (ex) { toast((ex as ApiError).message, "err"); }
    wipeToken = null;
    renderDanger();
  }
});
main.addEventListener("submit", async e => {
  if ((e.target as HTMLElement).id !== "renameForm" || !S) return;
  e.preventDefault();
  const id = editing;
  const name = $<HTMLInputElement>("#rnName").value.trim();
  const project = $<HTMLInputElement>("#rnProj").value.trim();
  if (!id || !name) { toast("Komanda adı boş ola bilməz.", "err"); return; }
  try {
    await api(`/api/admin/teams/${id}`, { method: "PATCH", body: { name, project } });
    editing = null;
    toast("Komanda adı yeniləndi");
    await load();
  } catch (ex) { toast((ex as ApiError).message, "err"); }
});

// Same shortcuts as the projector timer, while no field or dialog has focus.
document.addEventListener("keydown", e => {
  if (!S || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const el = e.target as HTMLElement;
  if (el.closest("input, textarea, select, dialog[open]") || document.querySelector("dialog[open]")) return;
  const k = e.key.toLowerCase();
  const has = !!S.event.currentTeamId;
  if (e.code === "Space" && has) { e.preventDefault(); patchEvent({ timer: "toggle" }); }
  else if ((k === "q" || k === "s") && has) patchEvent({ timer: "qa" });
  else if (k === "r" && has) patchEvent({ timer: "reset" });
  else if (k === "n") nextTeam();
});

onQrChange(() => load());

live({
  role: "admin",
  on: {
    "stage:changed": (s: StagePayload) => {
      strip.set(s);
      if (!S) return;
      S.stage = s;
      S.event.currentTeamId = s.team?.id ?? null;
      S.event.timer = s.timer;
      bar.setEventName(s.eventName);
      renderHero();
      renderStage();
      renderOrder();
      renderJury();
      renderKpis();
    },
    "timer:changed": (p: { timer: TimerState; serverNow: number }) => {
      strip.setTimer(p.timer, p.serverNow);
      if (S) { S.stage = { ...S.stage, timer: p.timer }; S.event.timer = p.timer; }
    },
    "score:upserted": (s: ScoreRow) => { flashKey = `${s.jurorId}:${s.teamId}`; },
    "results:changed": (d: AdminData) => {
      if (!S) return;
      Object.assign(S, d);
      renderKpis();
      renderStage();
      renderOrder();
      renderJury();
      renderRanking();
      renderMatrix();
      renderHeat();
      renderDanger();
      loadReveal();
    },
    "presence:changed": (p: PresenceEntry[]) => { if (S) { S.presence = p; renderJury(); renderKpis(); } },
    "progress:changed": (p: ProgressEntry[]) => { if (S) { S.progress = p; renderJury(); } },
    "juror:joined": (p: { jurorId: number; displayName: string }) => { jurorJoined(p); load(); },
    "event:locked": (p: { locked: boolean }) => { if (S) { S.event.locked = p.locked; renderKpis(); renderJury(); } },
    "reveal:changed": () => loadReveal(),
    "config:changed": () => load(),
  },
  resync: load,
  status: online => bar.setOnline(online),
});

// Refresh "45 san əvvəl" labels.
setInterval(() => { if (S && !document.querySelector("dialog[open]")) renderJury(); }, 15000);

load();
