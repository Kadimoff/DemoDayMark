// munsif.im phone remote (/admin/pult): timer, slides, stage view and the next team — with the admin session.
// v3: also the event's own presentation (opening, break, sponsors) and the results reveal, since the projector
// itself has no control buttons any more.
import "./styles.css";
import { fmtClock, type TimerView } from "../../shared/timer";
import type { AdminTeam, Notice, StagePayload, TimerAction, TimerState } from "../../shared/types";
import { api, ApiError } from "./lib/api";
import { $, esc, icon, toast } from "./lib/dom";
import { bindShowCtl, eventCtlHtml, showCtlHtml } from "./lib/materials";
import type { EventFile } from "../../shared/types";
import { ordinal } from "../../shared/reveal";
import { noticeBell } from "./lib/notices";
import { live } from "./lib/socket";
import { PHASE_LABEL, StageStrip } from "./lib/stage";
import { topbar } from "./lib/topbar";
import { adminNav } from "./lib/adminnav";

const bar = topbar({
  role: "admin",
  nav: adminNav("pult"),
});
const bell = noticeBell($("#bellSlot"), { list: "/api/admin/notices", read: "/api/admin/notices/read" });
void bell.refresh();
const strip = new StageStrip(null);
const main = $("#main");
let stage: StagePayload | null = null;
let teams: AdminTeam[] = [];

function build() {
  main.innerHTML = `
    <section class="pl-clock card" id="plClock">
      <div class="pl-team" id="plTeam">-</div>
      <div class="pl-phase" id="plPhase"></div>
      <div class="pl-time mono" id="plTime" role="timer" aria-live="off">0:00</div>
      <div class="pl-bar"><i id="plBar"></i></div>
    </section>
    <div class="pl-main">
      <button class="pl-big go" data-t="toggle" id="plToggle">${icon("play")}<span>Başlat</span></button>
      <div class="pl-row3">
        <button class="pl-btn" data-adj="-30">−30</button>
        <button class="pl-btn" data-t="qa">${icon("skip")}Sual-cavab</button>
        <button class="pl-btn" data-adj="30">+30</button>
      </div>
      <div class="pl-slides">
        <button class="pl-slide" data-slide="-1" aria-label="Əvvəlki slayd">${icon("back")}</button>
        <div class="pl-sn"><small>Slayd</small><b class="mono" id="plSlide">-</b></div>
        <button class="pl-slide" data-slide="1" aria-label="Növbəti slayd">${icon("next")}</button>
      </div>
      <div id="plShow"></div>
      <div class="pl-row2">
        <button class="pl-btn" data-t="reset">${icon("reset")}Sıfırla</button>
        <button class="pl-btn" id="plNext">${icon("next")}Növbəti komanda</button>
      </div>
    </div>
    <section class="card pad stack section-gap"><h3>Komandanı səhnəyə çıxar</h3><div class="pl-teams" id="plTeams"></div></section>
    <section class="card pad stack section-gap" id="plEvent"></section>
    <section class="card pad stack section-gap" id="plReveal"></section>`;
}

function renderStatic() {
  if (!stage) return;
  $("#plTeam").innerHTML = stage.team ? `<span class="acc-t mono">#${stage.team.index}</span> ${esc(stage.team.name)}` : `<span class="faint">Səhnə boşdur</span>`;
  const sh = stage.show;
  const ev = sh.scene === "event";
  const deck = ev ? sh.eventPres : sh.pres;
  const slide = ev ? sh.eventSlide : sh.slide;
  $("#plSlide").textContent = deck ? `${slide} / ${deck.pages ?? "?"}` : "-";
  $("#plShow").innerHTML = showCtlHtml(stage, true);
  $("#plEvent").innerHTML = eventCtlHtml(stage, files, true);
  main.querySelectorAll<HTMLButtonElement>("[data-slide]").forEach(b => {
    const d = Number(b.dataset.slide);
    b.disabled = !deck || (d < 0 ? slide <= 1 : !!deck.pages && slide >= deck.pages);
  });
  $("#plTeams").innerHTML = teams.filter(t => t.active).map((t, i) => `<button class="pl-tm ${stage!.team?.id === t.id ? "on" : ""}" data-cur="${t.id}">
    <span class="mono">#${i + 1}</span><b>${esc(t.name)}</b>${stage!.team?.id === t.id ? `<span class="pill fill">Səhnədə</span>` : ""}</button>`).join("");
}

function onTick(v: TimerView) {
  const t = $("#plTime"), ph = $("#plPhase"), b = $<HTMLElement>("#plBar"), tg = $("#plToggle");
  const clock = $("#plClock");
  if (v.kind === "idle") { t.textContent = fmtClock(stage?.timer.pitchSec ?? 0); ph.textContent = "Taymer gizlidir"; b.style.width = "100%"; }
  else {
    t.textContent = fmtClock(v.remaining);
    ph.textContent = v.ready ? "Hazır" : `${PHASE_LABEL[v.kind]}${!v.running && v.kind !== "done" ? " · fasilə" : ""}`;
    b.style.width = `${v.kind === "done" ? 0 : (v.remainingExact / v.phaseTotal) * 100}%`;
  }
  clock.className = `pl-clock card ${v.kind}${v.running && v.remaining <= 10 && v.kind !== "done" ? " danger" : v.running && v.remaining <= 30 && v.kind !== "done" ? " warn" : ""}`;
  const sig = `${v.running}|${v.kind}|${v.ready}|${!!stage?.team}`;
  if (tg.dataset.sig !== sig) {
    tg.dataset.sig = sig;
    tg.className = `pl-big ${v.running ? "hold" : "go"}`;
    tg.innerHTML = v.running ? `${icon("pause")}<span>Fasilə</span>` : `${icon("play")}<span>${v.kind === "idle" || v.ready || v.kind === "done" ? "Başlat" : "Davam"}</span>`;
    (tg as HTMLButtonElement).disabled = !stage?.team;
  }
}
strip.onTick(onTick);

function setStage(s: StagePayload) { stage = s; strip.set(s); bar.setEventName(s.eventName); renderStatic(); }

let files: EventFile[] = [];
async function loadFiles() {
  try { files = (await api<{ files: EventFile[] }>("/api/admin/event-files")).files; } catch { /* next time */ }
  renderStatic();
}

// ---------- v3: results reveal from the phone ----------
interface RevealCtl { enabled: boolean; step: number; stepsTotal: number; next: { kind: "suspense" | "reveal"; entry: { rank: number; name: string }; entries: Array<{ rank: number }> } | null }
let rv: RevealCtl | null = null;
async function loadReveal() {
  try { rv = await api<RevealCtl>("/api/admin/reveal"); } catch { return; }
  renderReveal();
}
function renderReveal() {
  const box = document.getElementById("plReveal");
  if (!box || !rv) return;
  const n = rv.next;
  const label = !rv.enabled ? "Açıqlamaya icazə verilməyib" : !n ? "Bütün yerlər açıqlandı"
    : n.kind === "suspense" ? `${ordinal(n.entry.rank)} yerin nömrəsini göstər`
    : n.entries?.length > 1 ? `${Math.max(...n.entries.map(e => e.rank))}-${ordinal(Math.min(...n.entries.map(e => e.rank)))} yerlər`
    : `${ordinal(n.entry.rank)} yeri açıqla`;
  box.innerHTML = `<div class="row between"><h3>${icon("medal")}Nəticə açıqlaması</h3><span class="pill ${rv.enabled ? "ok" : ""}">${rv.enabled ? `${rv.step}/${rv.stepsTotal}` : "Gözləmədə"}</span></div>
    ${rv.enabled ? `<div class="pl-row2"><button class="pl-btn" data-rv="back" ${rv.step > 0 ? "" : "disabled"}>${icon("back")}Geri</button>
      <button class="pl-btn go" data-rv="next" ${n ? "" : "disabled"}>${icon("next")}${esc(label)}</button></div>
      ${n && n.kind === "reveal" && n.entries?.length <= 1 ? `<p class="sub" style="margin:0">Növbəti: <b>${esc(n.entry.name)}</b> <span class="faint">(yalnız siz görürsünüz)</span></p>` : ""}`
    : `<p class="sub" style="margin:0">İcazəni Canlı paneldə, Nəticələr bölməsində verin. Bu zaman qiymətləndirmə bağlanır və reytinq qeydə alınır.</p><a class="btn sm" href="/admin#results">${icon("medal")}Canlı panel → Nəticələr</a>`}`;
}

async function load() {
  try {
    const st = await api<{ stage: StagePayload; teams: AdminTeam[] }>("/api/admin/state");
    teams = st.teams;
    setStage(st.stage);
  } catch (e) { toast((e as ApiError).message, "err"); }
  void loadFiles();
  void loadReveal();
}

async function patchEvent(body: Record<string, unknown>) {
  try { const r = await api<{ stage: StagePayload }>("/api/admin/event", { method: "PATCH", body }); setStage(r.stage); navigator.vibrate?.(30); }
  catch (e) { toast((e as ApiError).message, "err"); }
}

main.addEventListener("click", async e => {
  const t = e.target as HTMLElement;
  const tb = t.closest<HTMLButtonElement>("[data-t]");
  if (tb && !tb.disabled) {
    let a = tb.dataset.t as TimerAction;
    if (a === "toggle" && stage && !stage.timer.visible) a = "pitch";
    await patchEvent({ timer: a }); return;
  }
  const adj = t.closest<HTMLButtonElement>("[data-adj]");
  if (adj) { await patchEvent({ timerAdd: Number(adj.dataset.adj) }); return; }
  if (t.closest("#plNext")) {
    try { const r = await api<{ stage: StagePayload }>("/api/admin/event/next", { method: "POST" }); setStage(r.stage); toast(r.stage.team ? `Səhnədə: ${r.stage.team.name}` : "Səhnə boşdur"); }
    catch (ex) { toast((ex as ApiError).message, "err"); }
    return;
  }
  const cur = t.closest<HTMLElement>("[data-cur]");
  if (cur) { await patchEvent({ currentTeamId: Number(cur.dataset.cur) }); return; }
  const r = t.closest<HTMLButtonElement>("[data-rv]");
  if (r && !r.disabled) {
    try { rv = await api<RevealCtl>("/api/admin/reveal", { method: "POST", body: { action: r.dataset.rv } }); renderReveal(); navigator.vibrate?.(30); }
    catch (ex) { toast((ex as ApiError).message, "err"); }
  }
});
// slide buttons + view mode + intro (shared with the live panel)
bindShowCtl(main, () => stage, s => { setStage(s); navigator.vibrate?.(20); });

build();
live({
  role: "admin",
  on: {
    "stage:changed": (s: StagePayload) => setStage(s),
    "timer:changed": (p: { timer: TimerState; serverNow: number }) => { strip.setTimer(p.timer, p.serverNow); if (stage) stage = { ...stage, timer: p.timer }; },
    "config:changed": load,
    notice: (n: Notice) => bell.push(n),
    "reveal:changed": () => void loadReveal(),
    "eventfiles:changed": () => void loadFiles(),
  },
  resync: load,
  status: online => bar.setOnline(online),
});
async function wake() {
  try { const wl = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } }).wakeLock; if (wl && document.visibilityState === "visible") await wl.request("screen"); } catch { /* unsupported */ }
}
document.addEventListener("visibilitychange", wake);
void wake();
void load();
