import "./styles.css";
import { ordinal, type RevealEntry } from "../../shared/reveal";
import type { Results } from "../../shared/scoring";
import { fmtClock, type TimerView } from "../../shared/timer";
import type { Criterion, Juror, PresenceEntry, ScoreRow, StagePayload, Team, TimerAction, TimerState } from "../../shared/types";
import { api, ApiError } from "./lib/api";
import { $, esc, flip, fmt1, hhmm, icon, toast } from "./lib/dom";
import { live } from "./lib/socket";
import { PHASE_LABEL, StageStrip } from "./lib/stage";
import { topbar } from "./lib/topbar";

interface EventState { name: string; date: string; currentTeamId: number | null; timer: TimerState; locked: boolean; showJurorTotal: boolean }
interface AdminData {
  results: Results;
  teams: Team[];
  jurors: Juror[];
  criteria: Criterion[];
  scores: Array<ScoreRow & { total: number | null }>;
  minJurorsForRank: number;
}
interface AdminState extends AdminData { event: EventState; stage: StagePayload; presence: PresenceEntry[] }
interface AdminReveal {
  enabled: boolean; step: number; stepsTotal: number; snapshotAt: number | null; entries: RevealEntry[];
  next: { kind: "suspense" | "reveal"; index: number; entry: RevealEntry } | null;
  stale: boolean; unscored: number; progress: { done: number; need: number }; locked: boolean;
}

const bar = topbar({
  role: "admin",
  nav: [
    { href: "/admin", label: "Canlı panel", current: true },
    { href: "/admin/setup", label: "Quraşdırma" },
    { href: "/timer", label: "Taymer", external: true },
    { href: "/reveal", label: "Açıqlama", external: true },
  ],
  wide: true,
});
const strip = new StageStrip($("#stage"), true);
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

async function load() {
  try {
    S = await api<AdminState>("/api/admin/state");
  } catch (e) {
    if (!S) main.innerHTML = `<div class="banner err">${esc((e as Error).message)}</div>`;
    return;
  }
  bar.setEventName(S.event.name);
  strip.set(S.stage);
  renderAll();
}

async function patchEvent(body: Record<string, unknown>) {
  try {
    const r = await api<{ event: EventState; stage: StagePayload }>("/api/admin/event", { method: "PATCH", body });
    if (S) { S.event = r.event; S.stage = r.stage; }
    strip.set(r.stage);
    renderStage();
    renderStatus();
  } catch (e) { toast((e as ApiError).message, "err"); }
}

// ---------- layout ----------
function build() {
  main.innerHTML = `
    <div class="cgrid">
      <div class="card pad stack" id="stageCard"></div>
      <div class="stack">
        <div class="card pad stack" id="juryCard"></div>
        <div class="card pad" id="statusCard"></div>
        <div class="card pad stack" id="revealCard"></div>
      </div>
    </div>
    <div class="grid2 section-gap">
      <div>
        <div class="row between" style="margin-bottom:12px;align-items:flex-end">
          <div><h2>Reytinq</h2><p class="sub">Bal = münsiflərin çəkili ballarının orta qiyməti (100 üzərindən). Bərabərlikdə ən yüksək çəkili kriteriya həlledicidir.</p></div>
        </div>
        <div class="card" style="overflow:hidden" id="lbCard"></div>
      </div>
      <div class="card" id="matrixCard"></div>
    </div>
    <div class="card section-gap" id="heatCard"></div>
    <div class="card pad stack section-gap" id="dangerCard"></div>`;
  built = true;
}

function renderAll() {
  if (!S) return;
  if (!built) build();
  renderStage();
  renderJury();
  renderStatus();
  renderRanking();
  renderMatrix();
  renderHeat();
  renderDanger();
  loadReveal();
}

// ---------- stage + timer control ----------
function renderStage() {
  if (!S) return;
  const card = $("#stageCard");
  const teams = activeTeams();
  const cur = teams.find(t => t.id === S!.event.currentTeamId) ?? null;
  const nJ = activeJurors().length;
  const doneFor = (teamId: number) => S!.results.ranking.find(r => r.team.id === teamId)?.n ?? 0;
  const tgrid = `<div class="tgrid">${teams.map((t, i) => `<button data-cur="${t.id}" aria-pressed="${t.id === cur?.id}"><small>#${i + 1} · ${doneFor(t.id)}/${nJ}</small><span>${esc(t.name)}</span></button>`).join("")}</div>`;
  if (editing != null && editing !== cur?.id) editing = null;
  if (editing != null && card.querySelector("#renameForm")) {
    // Keep the half-typed rename form; only refresh the counters.
    card.querySelector(".tgrid")!.outerHTML = tgrid;
    renderTimerCtl();
    return;
  }
  const onstage = `
    <div class="onstage" id="onstage">
      ${cur ? `<div class="nm"><small class="mono">#${teams.indexOf(cur) + 1} / ${teams.length}</small><b>${esc(cur.name)}</b><small>${esc(cur.project || "Layihə adı yoxdur")}</small></div>
        <button class="btn sm" id="rename">${icon("pencil")}Adı dəyiş</button>`
      : `<div class="nm"><b>Səhnə boşdur</b><small>Aşağıdan komanda seçin.</small></div>`}
    </div>`;
  card.innerHTML = `
    <div class="row between"><h3>Səhnə idarəsi</h3><span class="pill ${cur ? "hot" : ""}">${cur ? "Canlı" : "Gözləmədə"}</span></div>
    ${onstage}
    ${tgrid}
    <div class="row">
      <button class="btn dark" id="nextTeam">Növbəti komanda ${icon("next")}</button>
      <button class="btn ghost" id="clearStage" ${cur ? "" : "disabled"}>Səhnəni boşalt</button>
    </div>
    <div class="tctl" id="tctl"></div>`;
  renderTimerCtl();
}

function renderTimerCtl(v?: TimerView) {
  const box = document.getElementById("tctl");
  if (!box || !S) return;
  const t = S.stage.timer;
  const view = v ?? null;
  const kind = view?.kind ?? (t.visible ? "pitch" : "idle");
  const running = view?.running ?? t.running;
  const hasTeam = !!S.event.currentTeamId;
  const sig = `${kind}|${running}|${hasTeam}|${t.pitchSec}|${t.qaSec}|${view?.ready}`;
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = `
      <div class="clock" id="ctlClock"><b>—</b><small>Taymer</small></div>
      <button class="btn ${kind === "pitch" && running ? "on" : ""}" data-timer="pitch" ${hasTeam ? "" : "disabled"}>${icon("play")}Pitch · ${fmtClock(t.pitchSec)}</button>
      <button class="btn ${kind === "qa" && running ? "on" : ""}" data-timer="qa" ${hasTeam ? "" : "disabled"}>${icon("skip")}Sual-cavab · ${fmtClock(t.qaSec)}</button>
      <button class="btn" data-timer="toggle" ${kind === "idle" ? "disabled" : ""}>${running ? `${icon("pause")}Fasilə` : `${icon("play")}${view?.ready ? "Başlat" : "Davam"}`}</button>
      <button class="btn ghost" data-timer="reset" ${kind === "idle" ? "disabled" : ""}>${icon("reset")}Sıfırla</button>
      <button class="btn ghost" data-timer="stop" ${kind === "idle" ? "disabled" : ""}>${icon("stop")}Dayandır</button>
      <a class="btn ghost" href="/timer" target="_blank" rel="noopener">${icon("ext")}Proyektor taymeri</a>`;
  }
  const clock = $("#ctlClock");
  if (view && view.kind !== "idle") {
    clock.querySelector("b")!.textContent = fmtClock(view.remaining);
    clock.querySelector("small")!.textContent = view.ready ? "Hazır" : `${PHASE_LABEL[view.kind]}${!view.running && view.kind !== "done" ? " · fasilə" : ""}`;
    clock.classList.toggle("warn", view.kind !== "done" && view.remaining <= 30 && !view.ready);
    clock.classList.toggle("over", view.kind === "done");
  } else {
    clock.querySelector("b")!.textContent = "—";
    clock.querySelector("small")!.textContent = "Taymer";
    clock.classList.remove("warn", "over");
  }
}
strip.onTick(v => renderTimerCtl(v));

// ---------- jury status for the team on stage ----------
function renderJury() {
  if (!S) return;
  const card = $("#juryCard");
  const cur = activeTeams().find(t => t.id === S!.event.currentTeamId);
  const jurors = activeJurors();
  const pres = new Map(S.presence.map(p => [p.jurorId, p]));
  if (!jurors.length) {
    card.innerHTML = `<h3>Münsiflər</h3><p class="note">Hələ münsif hesabı yoxdur. <a href="/admin/setup">Quraşdırma</a> bölməsindən əlavə edin.</p>`;
    return;
  }
  const sent = cur ? jurors.filter(j => S!.results.matrix[cur.id]?.[j.id] != null).length : 0;
  card.innerHTML = `
    <div class="row between"><h3>${cur ? `${esc(cur.name)} · münsif statusu` : "Münsiflər"}</h3>${cur ? `<span class="pill ${sent === jurors.length ? "ok" : "warn"} mono">${sent}/${jurors.length} göndərib</span>` : ""}</div>
    <div class="jgrid">${jurors.map(j => {
      const p = pres.get(j.id);
      const done = cur ? S!.results.matrix[cur.id]?.[j.id] != null : false;
      return `<div class="jcard ${done ? "sent" : ""}">
        <div class="nm"><span class="dot ${p?.online ? "on" : ""}" title="${p?.online ? "Onlayn" : p?.lastSeen ? `Son görülmə ${hhmm(p.lastSeen)}` : "Oflayn"}"></span><span>${esc(j.displayName)}</span></div>
        ${cur ? (done ? `<span class="pill ok">${icon("check")}Göndərib</span>` : `<span class="pill warn">Gözləyir</span>`) : `<small class="sub" style="margin:0">${p?.online ? "Onlayn" : "Oflayn"}</small>`}
      </div>`;
    }).join("")}</div>`;
}

// ---------- status: lock, progress, exports ----------
function renderStatus() {
  if (!S) return;
  const { done, need } = S.results;
  const pct = need ? Math.round((done / need) * 100) : 0;
  $("#statusCard").innerHTML = `
    <div class="toggle"><div><b>Qiymətləndirməni bağla</b><small>Bağlı olanda münsiflər bal göndərə və dəyişə bilməz.</small></div>
      <button class="sw" role="switch" aria-checked="${S.event.locked}" id="lockSw" aria-label="Qiymətləndirməni bağla"></button></div>
    <div class="toggle" style="display:block">
      <div class="row between"><b>İrəliləyiş</b><span class="mono">${done}/${need} qiymət · ${pct}%</span></div>
      <div class="progress" style="margin-top:8px"><i style="width:${pct}%"></i></div>
    </div>
    <div class="toggle"><div><b>Nəticələri yüklə</b><small>Excel cədvəli və imza üçün PDF protokol.</small></div>
      <div class="row"><a class="btn sm" href="/api/admin/export.xlsx" download>${icon("download")}Excel</a><a class="btn sm" href="/api/admin/export.pdf" download>${icon("download")}PDF</a></div></div>`;
}

// ---------- results reveal ----------
async function loadReveal() {
  try { rv = await api<AdminReveal>("/api/admin/reveal"); } catch { return; }
  renderReveal();
}
async function revealAction(action: string) {
  try { rv = await api<AdminReveal>("/api/admin/reveal", { method: "POST", body: { action } }); }
  catch (ex) { toast((ex as ApiError).message, "err"); }
  rvConfirm = null;
  renderReveal();
}
function renderReveal() {
  const card = document.getElementById("revealCard");
  if (!card || !rv) return;
  const n = rv.next;
  const done = rv.enabled && !n && rv.stepsTotal > 0;
  const label = !rv.enabled ? "Sıradakını açıqla"
    : done ? "Bütün yerlər açıqlandı"
    : n!.kind === "suspense" ? `${ordinal(n!.entry.rank)} yer — intizarı başlat`
    : n!.entry.rank <= 3 ? `${ordinal(n!.entry.rank)} yeri açıqla`
    : `Sıradakını açıqla (${ordinal(n!.entry.rank)} yer)`;
  const pill = !rv.enabled ? `<span class="pill">Gözləmədə</span>`
    : done ? `<span class="pill ok">Bitdi</span>`
    : `<span class="pill hot mono">${rv.step}/${rv.stepsTotal}</span>`;
  const { done: d, need } = rv.progress;
  card.innerHTML = `
    <div class="row between"><h3>Nəticə açıqlaması</h3>${pill}</div>
    <button class="rv-allow${rv.enabled ? " on" : ""}" id="rvAllow" aria-pressed="${rv.enabled}">
      <span class="box">${rv.enabled ? icon("check") : ""}</span>
      <span><b>${rv.enabled ? "Açıqlamaya icazə verilib" : "Açıqlamaya icazə ver"}</b>
      <small>${rv.enabled ? "Ekran aktivdir. Söndürsəniz ekran gözləmə rejiminə keçir, irəliləyiş saxlanılır." : "Qiymətləndirmə bağlanacaq və cari reytinq qeydə alınacaq."}</small></span>
    </button>
    ${rvConfirm === "enable" ? `<div class="confirm"><span>Qiymətləndirmə bağlanacaq. Daxil olan qiymətlər: <b class="mono">${d}/${need}</b>${d < need ? " — hamısı daxil olmayıb!" : ""}${rv.unscored ? ` · ${rv.unscored} komanda qiymətləndirilməyib və açıqlamaya düşməyəcək.` : ""}</span>
      <button class="btn sm primary" id="rvYes">Bəli, icazə ver</button><button class="btn sm" id="rvNo">Ləğv et</button></div>` : ""}
    ${rvConfirm === "reset" ? `<div class="confirm"><span>Açıqlama əvvələ qayıdacaq və reytinq yenidən qeydə alınacaq.</span>
      <button class="btn sm danger solid" id="rvResetYes">Bəli, sıfırla</button><button class="btn sm" id="rvNo">Ləğv et</button></div>` : ""}
    ${rv.stale ? `<p class="banner lock" style="margin:0">${icon("lock")}<span>Reytinq qeydə alınandan sonra ballar dəyişib. Yeni vəziyyəti göstərmək üçün “Sıfırla” basın.</span></p>` : ""}
    <button class="btn primary" id="rvNext" style="min-height:56px;font-size:16px" ${rv.enabled && n ? "" : "disabled"}>${esc(label)} ${rv.enabled && n ? icon("next") : ""}</button>
    ${rv.enabled && n ? `<p class="sub" style="margin:-6px 0 0">Növbəti (yalnız siz görürsünüz): <b>${esc(n.entry.name)}</b> · <span class="mono">${n.entry.avg.toFixed(1)}</span></p>` : ""}
    <div class="row">
      <button class="btn sm" id="rvBack" ${rv.enabled && rv.step > 0 ? "" : "disabled"}>${icon("reset")}Geri</button>
      <button class="btn sm ghost" id="rvReset" ${rv.snapshotAt ? "" : "disabled"}>Sıfırla</button>
      <a class="btn sm ghost" href="/reveal" target="_blank" rel="noopener">${icon("ext")}Açıqlama ekranı</a>
    </div>`;
}

// ---------- ranking ----------
function renderRanking() {
  if (!S) return;
  const card = $("#lbCard");
  const after = flip(card);
  const nJ = activeJurors().length;
  const rows = S.results.ranking;
  card.innerHTML = rows.length ? `<ol class="lb">${rows.map(x => `
    <li data-flip="${x.team.id}" class="${x.rank ? (x.rank <= 3 ? "r" + x.rank : "") : "none"}">
      <span class="rk">${x.rank ?? "—"}</span>
      <div class="nm"><b>${esc(x.team.name)} ${x.incomplete && x.n ? `<span class="pill warn" title="${S!.minJurorsForRank}-dən az münsif qiymətləndirib">eksik</span>` : ""}</b>
        <small>${esc(x.team.project || "—")}</small>
        <div class="track"><i style="width:${x.avg ?? 0}%"></i></div></div>
      <div class="sc"><b>${fmt1(x.avg)}</b><small>${x.n}/${nJ} münsif${x.n > 1 ? ` · ${fmt1(x.min)}–${fmt1(x.max)}` : ""}</small></div>
    </li>`).join("")}</ol>` : `<p class="empty">Aktiv komanda yoxdur.</p>`;
  after();
}

// ---------- juror × team matrix ----------
function renderMatrix() {
  if (!S) return;
  const jurors = S.jurors.filter(j => j.active || S!.scores.some(s => s.jurorId === j.id));
  const teams = activeTeams();
  $("#matrixCard").innerHTML = `
    <div class="pad" style="padding-bottom:8px"><h3>Münsif matrisi</h3><p class="sub">Xanaya toxunun: kriteriya balları və şərh.</p></div>
    <div class="tbl"><table>
      <thead><tr><th>Komanda</th>${jurors.map((j, i) => `<th class="num" title="${esc(j.displayName)}">M${i + 1}</th>`).join("")}<th class="num">Orta</th></tr></thead>
      <tbody>${teams.map(t => {
        const avg = S!.results.ranking.find(r => r.team.id === t.id)?.avg ?? null;
        return `<tr><td>${esc(t.name)}</td>${jurors.map(j => {
          const v = S!.results.matrix[t.id]?.[j.id];
          const has = !!scoreOf(j.id, t.id);
          const k = `${j.id}:${t.id}`;
          return has ? `<td class="cell${flashKey === k ? " flash" : ""}"><button data-cell="${k}" aria-label="${esc(j.displayName)} — ${esc(t.name)}">${v != null ? v.toFixed(1) : "…"}</button></td>`
            : `<td class="num miss">—</td>`;
        }).join("")}<td class="num"><b>${fmt1(avg)}</b></td></tr>`;
      }).join("")}</tbody>
    </table></div>
    <div class="pad" style="padding-top:10px"><p class="sub" style="margin:0">${jurors.map((j, i) => `M${i + 1} — ${esc(j.displayName)}`).join(" · ") || "Münsif yoxdur"}</p></div>`;
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
      <div class="vals">${S.criteria.map(c => `<span>${esc(c.name)} <span class="sub mono" style="font-size:12px">${c.weight}%</span></span><b>${s.values[c.key] ?? "—"}</b>`).join("")}
        <span style="border-top:1px solid var(--line);padding-top:6px"><b style="font-family:var(--f-body);text-align:left">Yekun</b></span><b style="border-top:1px solid var(--line);padding-top:6px">${fmt1(s.total)}</b></div>
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
  $("#heatCard").innerHTML = `
    <div class="pad" style="padding-bottom:8px"><h3>Kriteriyalar üzrə orta bal (1–10)</h3></div>
    <div class="tbl"><table>
      <thead><tr><th>Yer</th><th>Komanda</th>${crit.map(c => `<th class="num" title="${esc(c.description)}">${esc(c.name)}<br><span style="font-weight:500">${c.weight}%</span></th>`).join("")}<th class="num">Yekun</th></tr></thead>
      <tbody>${S.results.ranking.map(x => `<tr><td class="mono">${x.rank ?? "—"}</td><td>${esc(x.team.name)}</td>${crit.map(c => {
        const v = x.perCriterion[c.key];
        return v == null ? `<td class="num miss">—</td>` : `<td class="num heat" style="--h:${Math.round(Math.max(0, v - 4) * 6)}">${v.toFixed(1)}</td>`;
      }).join("")}<td class="num"><b>${fmt1(x.avg)}</b></td></tr>`).join("")}</tbody>
    </table></div>`;
}

// ---------- danger zone ----------
function renderDanger() {
  if (!S) return;
  const n = S.scores.length;
  $("#dangerCard").innerHTML = `<h3>Təhlükəli zona</h3>
    ${wipeToken
      ? `<div class="confirm"><span>Bütün <b>${wipeToken.count}</b> qiymət birdəfəlik silinəcək. Əminsiniz?</span>
          <button class="btn danger solid sm" id="wipeYes">Bəli, sil</button><button class="btn sm" id="wipeNo">Ləğv et</button></div>`
      : `<div class="row"><button class="btn danger" id="wipe" ${n ? "" : "disabled"}>${icon("trash")}Bütün qiymətləri sil</button><span class="sub" style="margin:0">Prova və sınaq qiymətlərini təmizləmək üçün. Silməzdən əvvəl yedək alın.</span></div>`}`;
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
  if (t.closest("#nextTeam")) {
    editing = null;
    try {
      const r = await api<{ event: EventState; stage: StagePayload }>("/api/admin/event/next", { method: "POST" });
      S.event = r.event; S.stage = r.stage; strip.set(r.stage); renderStage(); renderJury();
    } catch (ex) { toast((ex as ApiError).message, "err"); }
    return;
  }
  if (t.closest("#clearStage")) { editing = null; patchEvent({ currentTeamId: null }); return; }
  if (t.closest("#rename")) {
    const team = S.teams.find(x => x.id === S!.event.currentTeamId);
    if (!team) return;
    editing = team.id;
    $("#onstage").innerHTML = `<form id="renameForm">
      <input type="text" id="rnName" value="${esc(team.name)}" aria-label="Komanda adı" maxlength="120" required>
      <input type="text" id="rnProj" value="${esc(team.project)}" aria-label="Layihə" placeholder="Layihə / məhsul" maxlength="160">
      <button class="btn primary sm" type="submit">Saxla</button><button class="btn sm" type="button" id="rnCancel">Ləğv et</button></form>`;
    $<HTMLInputElement>("#rnName").select();
    return;
  }
  if (t.closest("#rnCancel")) { editing = null; renderStage(); return; }
  if (t.closest("#lockSw")) { patchEvent({ locked: !S.event.locked }); return; }
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
      renderStage();
      renderJury();
    },
    "timer:changed": (p: { timer: TimerState; serverNow: number }) => {
      strip.setTimer(p.timer, p.serverNow);
      if (S) { S.stage = { ...S.stage, timer: p.timer }; S.event.timer = p.timer; }
    },
    "score:upserted": (s: ScoreRow) => { flashKey = `${s.jurorId}:${s.teamId}`; },
    "results:changed": (d: AdminData) => {
      if (!S) return;
      Object.assign(S, d);
      renderStage();
      renderJury();
      renderStatus();
      renderRanking();
      renderMatrix();
      renderHeat();
      renderDanger();
      loadReveal();
    },
    "presence:changed": (p: PresenceEntry[]) => { if (S) { S.presence = p; renderJury(); } },
    "event:locked": (p: { locked: boolean }) => { if (S) { S.event.locked = p.locked; renderStatus(); } },
    "reveal:changed": () => loadReveal(),
    "config:changed": () => load(),
  },
  resync: load,
  status: online => bar.setOnline(online),
});

load();
