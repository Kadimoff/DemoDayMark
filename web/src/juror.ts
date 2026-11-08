import "./styles.css";
import { demoMax, isComplete, jurorTotal, MIN_POINTS } from "../../shared/scoring";
import { fmtClock, type TimerView } from "../../shared/timer";
import type { AdminTeam, Criterion, JurorStatePayload, MyScore, ScoreValues, StagePayload, TimerState } from "../../shared/types";
import { api, ApiError } from "./lib/api";
import { $, esc, hhmm, icon, initials, toast } from "./lib/dom";
import { live } from "./lib/socket";
import { PHASE_LABEL, StageStrip } from "./lib/stage";
import { initTheme, themeToggleHtml, toggleTheme } from "./lib/theme";
import { blinkTitle, canNotify, chime, enableNotifications, notifyPermission, systemNotify } from "./lib/alert";
import { Outbox, type ScoreOp, type SendResult } from "./lib/outbox";

initTheme();

/** pending: queued in the outbox; opId: the op that carries exactly this draft (cleared by the next edit). */
interface Draft { values: ScoreValues; note: string; tags: string[]; dirty: boolean; base: number; pending?: boolean; opId?: string }
interface Nudge { teamId: number; teamName: string; index: number }

const NOTE_MAX = 1000;
const head = $("#jhead");
const main = $("#main");
const dock = $("#dock");
const strip = new StageStrip(null);

let S: JurorStatePayload | null = null;
const mine = new Map<number, MyScore>();
const drafts = new Map<number, Draft>();
let selTeam: number | null = null;
let lastStageTeam: number | null | undefined;
let formKey = "";
/** v11: every score goes through the outbox (localStorage queue, op ids, retries) — see lib/outbox.ts. */
let outbox: Outbox<MyScore> | null = null;
let justSent: number | null = null;
let failure: { teamId: number; msg: string; network: boolean } | null = null;
let online = false;
let nudge: Nudge | null = null;

// ---------- drafts survive reloads and Wi-Fi drops ----------
const lsKey = (teamId: number) => `ij.draft.${S?.me.id}.${teamId}`;
function persist(teamId: number) {
  const d = drafts.get(teamId);
  try {
    if (d?.dirty) localStorage.setItem(lsKey(teamId), JSON.stringify({ values: d.values, note: d.note, tags: d.tags, base: d.base, pending: !!d.pending, opId: d.opId }));
    else localStorage.removeItem(lsKey(teamId));
  } catch { /* storage unavailable */ }
}
function restoreDrafts() {
  if (!S) return;
  for (const t of S.teams) {
    if (drafts.get(t.id)?.dirty) continue;
    try {
      const raw = localStorage.getItem(lsKey(t.id));
      if (!raw) continue;
      const d = JSON.parse(raw) as Draft;
      const saved = mine.get(t.id);
      // A newer server copy (e.g. sent from another device) wins over an old local draft.
      if (saved && saved.updatedAt > d.base) { localStorage.removeItem(lsKey(t.id)); continue; }
      drafts.set(t.id, { values: d.values ?? {}, note: d.note ?? "", tags: d.tags ?? [], base: d.base ?? 0, dirty: true, pending: d.pending, opId: d.opId });
    } catch { /* corrupt entry */ }
  }
}
function draftFor(teamId: number): Draft {
  const saved = mine.get(teamId);
  let d = drafts.get(teamId);
  if (!d || (!d.dirty && (saved?.updatedAt ?? 0) !== d.base)) {
    d = { values: { ...(saved?.values ?? {}) }, note: saved?.note ?? "", tags: [...(saved?.tags ?? [])], dirty: false, base: saved?.updatedAt ?? 0 };
    drafts.set(teamId, d);
  }
  return d;
}
const validValue = (c: Criterion, v: number | undefined) => Number.isInteger(v) && v! >= MIN_POINTS && v! <= c.maxScore;
const filledCount = (d: Draft) => S ? S.criteria.filter(c => validValue(c, d.values[c.key])).length : 0;

// ---------- live draft progress for the coordinator (count only, never the points) ----------
let progressTimer = 0;
function reportProgress(teamId: number) {
  clearTimeout(progressTimer);
  progressTimer = window.setTimeout(() => {
    const d = drafts.get(teamId);
    if (d) sock.emit("draft:progress", { teamId, filled: filledCount(d) });
  }, 250);
}

// ---------- data ----------
declare global { interface Window { __jstate?: Promise<JurorStatePayload | null> } }

async function load() {
  try {
    // First load: reuse the request the page's <head> already started.
    const early = window.__jstate ? await window.__jstate : null;
    window.__jstate = undefined;
    S = early ?? await api<JurorStatePayload>("/api/juror/state");
  } catch (e) {
    if (!S) main.innerHTML = `<div class="banner err">${esc((e as Error).message)}</div>`;
    return;
  }
  mine.clear();
  S.myScores.forEach(s => mine.set(s.teamId, s));
  document.title = `Münsif paneli · ${S.stage.eventName}`;
  restoreDrafts();
  startOutbox();
  onStage(S.stage);
  formKey = "";
  render();
}

function onStage(stage: StagePayload) {
  strip.set(stage);
  if (!S) return;
  S.stage = stage;
  const cur = stage.team?.id ?? null;
  if (cur !== lastStageTeam) {
    const first = lastStageTeam === undefined;
    lastStageTeam = cur;
    if (cur != null && cur !== selTeam) {
      // Follow the stage, unless the juror is in the middle of an unsent edit.
      if (selTeam != null && drafts.get(selTeam)?.dirty) {
        if (!first) toast(`Səhnədə: ${stage.team!.name}. Göndərilməmiş dəyişikliyiniz saxlanılıb.`);
      } else {
        select(cur, false);
      }
    }
  }
  formKey = "";
  render();
}

function select(teamId: number, scroll = true) {
  selTeam = teamId;
  failure = null;
  formKey = "";
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- header ----------
function renderHead() {
  if (!S) return;
  const onStage = S.stage.team;
  const chips = S.teams.map((t, i) => {
    const saved = mine.get(t.id);
    const done = !!saved && isComplete(saved.values, S!.criteria);
    const dirty = drafts.get(t.id)?.dirty;
    const isStage = t.id === onStage?.id;
    return `<button class="chip" data-team="${t.id}" aria-pressed="${t.id === selTeam}" aria-label="${esc(t.name)}${isStage ? ", səhnədə" : ""}${done ? ", göndərilib" : ""}">
      ${isStage ? `<span class="livedot" aria-hidden="true"></span>` : ""}#${String(i + 1).padStart(2, "0")} <b>${esc(t.name)}</b>
      ${dirty ? `<span class="draft" title="Göndərilməmiş dəyişiklik"></span>` : done ? `<span class="done">${icon("check")}</span>` : ""}
    </button>`;
  }).join("");
  const sig = `${S.me.displayName}|${onStage?.id}|${online}`;
  if (head.dataset.sig !== sig) {
    head.dataset.sig = sig;
    head.innerHTML = `<div class="wrap narrow">
      <div class="r1">
        <a class="jmark" href="/" title="munsif.im"><img src="/brand/munsif-mark-flat.svg" alt="munsif.im" width="34" height="34"></a>
        <div class="ttl">
          <div class="t"><b>Canlı qiymətləndirmə</b>${onStage ? `<span class="pill live">Səhnədə</span>` : ""}</div>
          <small>Münsif: ${esc(S.me.displayName)}</small>
        </div>
        <div class="tools">
          <span class="conn ${online ? "online" : "offline"}" id="conn">${online ? "Canlı" : "Oflayn"}</span>
          ${themeToggleHtml()}
          <span class="avatar" title="${esc(S.me.displayName)}" aria-hidden="true">${esc(initials(S.me.displayName))}</span>
        </div>
      </div>
      <div class="chips" id="chips" role="group" aria-label="Komandalar"></div>
    </div>`;
  }
  const box = $("#chips");
  box.innerHTML = chips;
  box.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ---------- main ----------
/** munsif.im: links to the team's presentation and website (when the coordinator allows it). */
function materialsHtml(teamId: number) {
  const m = S?.materials?.find(x => x.teamId === teamId);
  if (!m || (!m.presentation && !m.siteUrl && !m.videoUrl)) return "";
  return `<div class="jmat">
    ${m.presentation ? `<a class="btn sm" href="${esc(m.presentation.url)}" target="_blank" rel="noopener">${icon("doc")}Prezentasiya${m.presentation.pages ? ` · ${m.presentation.pages} slayd` : ""}</a>` : ""}
    ${m.siteUrl ? `<a class="btn sm" href="${esc(m.siteUrl)}" target="_blank" rel="noopener noreferrer">${icon("ext")}Sayt</a>` : ""}
    ${m.videoUrl ? `<a class="btn sm ghost" href="${esc(m.videoUrl)}" target="_blank" rel="noopener noreferrer">${icon("play")}Video</a>` : ""}
  </div>`;
}
function teamOf(id: number | null): AdminTeam | null { return S?.teams.find(t => t.id === id) ?? null; }
const fmtEntry = (v: number) => (Math.round(v * 100) / 100).toFixed(1);

function render() {
  if (!S) return;
  renderHead();
  if (!S.teams.length) { main.innerHTML = `<p class="empty">Komanda siyahısı hələ boşdur.</p>`; dock.hidden = true; return; }
  if (selTeam == null || !S.teams.some(t => t.id === selTeam)) selTeam = S.stage.team?.id ?? S.teams[0].id;
  const team = teamOf(selTeam)!;
  const idx = S.teams.indexOf(team);
  const d = draftFor(team.id);
  const locked = S.locked;
  const onStage = S.stage.team?.id === team.id;

  const critSig = S.criteria.map(c => `${c.key}:${c.maxScore}:${c.name}:${c.description}`).join("|");
  const key = [team.id, team.name, team.project, team.entryScore, S.entryMax, critSig, d.base, locked, S.feedbackTags.join("|"),
    S.stage.team?.id, S.stage.team?.name, S.showJurorTotal, S.includeEntry, materialsHtml(team.id)].join("§");
  if (key !== formKey) {
    formKey = key;
    const other = S.stage.team && !onStage ? S.stage.team : null;
    main.innerHTML = `
      <div id="nudgeBox"></div>
      ${locked ? `<div class="banner lock">${icon("lock")}<span>Qiymətləndirmə koordinator tərəfindən bağlanıb. Ballarınıza yalnız baxa bilərsiniz.</span></div>` : ""}
      <section class="bento fade" aria-label="Komanda">
        <div class="top-r">
          ${onStage ? `<span class="pill live">Səhnədə · Canlı</span>`
            : other ? `<button class="pill" data-team="${other.id}" style="cursor:pointer">Səhnədə: #${other.index} ${esc(other.name)} ${icon("next")}</button>`
            : `<span class="pill">Səhnə boşdur</span>`}
          <span class="pill">${icon("users")}${idx + 1} / ${S.teams.length} komanda</span>
        </div>
        <div class="id">
          <div class="nm">
            <div class="t"><span class="tagno">#${String(idx + 1).padStart(2, "0")}</span><h1>${esc(team.name)}</h1></div>
            ${team.project ? `<p>${esc(team.project)}</p>` : ""}
          </div>
          <span class="teamicon" aria-hidden="true">${esc(initials(team.name))}</span>
        </div>
        <div class="minis"${S.includeEntry ? "" : ` style="grid-template-columns:minmax(0,1fr)"`}>
          <div class="mini" id="tmini"></div>
          ${S.includeEntry ? `<div class="mini">
            <div class="lb"><span>Giriş balı</span>${icon("medal")}</div>
            <div class="v"><b>${team.entryScore != null ? fmtEntry(team.entryScore) : "—"}</b><span>/ ${fmtEntry(S.entryMax)}</span></div>
            <small>${team.entryScore != null ? `${icon("check")}Münsif üçün açıq` : "Yazılmayıb"}</small>
          </div>` : ""}
        </div>
        ${materialsHtml(team.id)}
        <div class="privacy"><span>${icon("shield")}Digər münsiflərin balları gizlidir</span><span id="syncln" class="${online ? "ok-t" : "warn-t"}">● ${online ? "Sinxron aktiv" : "Oflayn"}</span></div>
      </section>
      <section class="totalcard" id="total" aria-live="polite"></section>
      ${S.criteria.map((c, i) => `
      <section class="crit${validValue(c, d.values[c.key]) ? " done" : ""}" data-crit="${esc(c.key)}">
        <div class="ch">
          <div class="t"><span class="num">${i + 1}</span><b id="cl-${esc(c.key)}">${esc(c.name)}</b></div>
          <span class="w"><span>Maks:</span> ${c.maxScore}</span>
        </div>
        ${c.description ? `<p>${esc(c.description)}</p>` : ""}
        ${c.maxScore > BUTTONS_MAX ? bigScale(c, d.values[c.key], locked) : `<div class="scale" role="group" aria-labelledby="cl-${esc(c.key)}">${Array.from({ length: c.maxScore - MIN_POINTS + 1 }, (_, k) => k + MIN_POINTS).map(v =>
          `<button type="button" data-c="${esc(c.key)}" data-v="${v}" aria-pressed="${d.values[c.key] === v}" aria-label="${esc(c.name)}: ${v} / ${c.maxScore}" ${locked ? "disabled" : ""}>${v}</button>`).join("")}</div>`}
      </section>`).join("")}
      ${S.feedbackTags.length ? `
      <section class="qchips" aria-labelledby="qcl">
        <span class="caps" id="qcl">Sürətli rəyləriniz (çoxseçimli)</span>
        <div class="list" id="qlist"></div>
      </section>` : ""}
      <section class="notes">
        <div class="ch"><label for="note">${icon("lock")}<span>Münsif qeydləri (yalnız sizin üçündür)</span></label><span class="opt">Könüllü</span></div>
        <textarea id="note" maxlength="${NOTE_MAX}" placeholder="Komandanın təqdimatı və ya sual-cavab mərhələsi haqqında şəxsi mülahizələriniz…" ${locked ? "disabled" : ""}>${esc(d.note)}</textarea>
        <div class="foot"><span>${icon("check")}Bu cihazda avtomatik saxlanılır</span><span id="ncount">${d.note.length} / ${NOTE_MAX} simvol</span></div>
      </section>
      <div class="jacts">
        <button class="btn" id="reset" ${locked ? "disabled" : ""}>${icon("undo")}Sıfırla</button>
        <button class="btn" id="prev" ${idx > 0 ? "" : "disabled"}>${icon("back")}Əvvəlki komanda</button>
      </div>
      <p class="openline${locked ? " lock" : ""}">${locked ? "Qiymətləndirmə bağlıdır" : "Səsvermə açıqdır · dəyişiklik edilə bilər"}</p>`;
    strip.tick();
    // v11: the send log (outbox) under the form
    main.insertAdjacentHTML("beforeend", `<details class="oplog" id="oplog" hidden></details>`);
  }
  renderNudge();
  renderTags();
  renderTotal();
  renderDock();
  renderOpLog();
}

/** Up to 10 points: one button per point. Above that (20, 30…) a phone can't fit the buttons: big value, −/+, slider, quick picks. */
const BUTTONS_MAX = 10;
function quickPicks(max: number) { return [0.2, 0.4, 0.6, 0.8, 1].map(f => Math.max(MIN_POINTS, Math.round(max * f))); }
function bigScale(c: Criterion, v: number | undefined, locked: boolean) {
  const has = validValue(c, v);
  return `<div class="bigscale" data-big="${esc(c.key)}" role="group" aria-labelledby="cl-${esc(c.key)}">
    <div class="bs-row">
      <button type="button" class="bs-step" data-step="-1" aria-label="${esc(c.name)}: bir bal az" ${locked ? "disabled" : ""}>−</button>
      <output class="bs-val mono${has ? "" : " empty"}" aria-live="polite"><b>${has ? v : "—"}</b><span>/ ${c.maxScore}</span></output>
      <button type="button" class="bs-step" data-step="1" aria-label="${esc(c.name)}: bir bal çox" ${locked ? "disabled" : ""}>+</button>
    </div>
    <input type="range" class="bs-range" min="${MIN_POINTS}" max="${c.maxScore}" step="1" value="${has ? v : Math.round(c.maxScore / 2)}" aria-label="${esc(c.name)} balı" ${locked ? "disabled" : ""}${has ? "" : ` data-untouched="1"`}>
    <div class="bs-quick">${quickPicks(c.maxScore).map(q => `<button type="button" data-q="${q}" aria-pressed="${v === q}" ${locked ? "disabled" : ""}>${q}</button>`).join("")}</div>
  </div>`;
}
function setBig(key: string, value: number) {
  if (!S || selTeam == null) return;
  const c = S.criteria.find(x => x.key === key);
  if (!c) return;
  const v = Math.max(MIN_POINTS, Math.min(c.maxScore, Math.round(value)));
  draftFor(selTeam).values[key] = v;
  const box = main.querySelector<HTMLElement>(`[data-big="${CSS.escape(key)}"]`);
  if (box) {
    const out = box.querySelector<HTMLElement>(".bs-val")!;
    out.classList.remove("empty");
    out.querySelector("b")!.textContent = String(v);
    const r = box.querySelector<HTMLInputElement>(".bs-range")!;
    r.value = String(v);
    r.removeAttribute("data-untouched");
    box.querySelectorAll<HTMLElement>("[data-q]").forEach(q => q.setAttribute("aria-pressed", String(Number(q.dataset.q) === v)));
  }
  touched(selTeam);
  renderHead();
  renderTotal();
  renderDock();
}

function renderTimer(v: TimerView, s: StagePayload) {
  const box = document.getElementById("tmini");
  if (!box || !S) return;
  const onStage = s.team && s.team.id === selTeam;
  if (!onStage || v.kind === "idle") {
    const sig = `off|${onStage}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = `<div class="lb"><span>${onStage ? "Taymer" : "Səhnə"}</span>${icon("timer")}</div>
      <div class="v idle"><b>${onStage ? "Hazırlanır" : "Növbədə deyil"}</b></div>
      <small style="color:var(--muted)">${onStage ? "Taymer başlamayıb" : "Bu komanda səhnədə deyil"}</small>`;
    return;
  }
  if (box.dataset.sig !== "on") {
    box.dataset.sig = "on";
    box.innerHTML = `<div class="lb"><span id="tk"></span>${icon("timer")}</div>
      <div class="v" id="tv"><b id="tt"></b><span id="tq"></span></div>
      <div class="progress"><i id="tb"></i></div>`;
  }
  const paused = !v.running && v.kind !== "done";
  $("#tk").textContent = v.ready ? "Hazır" : `${PHASE_LABEL[v.kind]}${paused ? " · fasilə" : ""}`;
  $("#tt").textContent = fmtClock(v.remaining);
  $("#tq").textContent = v.kind === "done" ? "" : "qalıb";
  $("#tv").className = `v${v.kind === "done" ? " over" : v.remaining <= 30 && !v.ready ? " warn" : ""}`;
  $("#tb").style.width = `${Math.max(0, Math.min(100, (v.remainingExact / v.phaseTotal) * 100))}%`;
}
strip.onTick(renderTimer);

function renderTotal() {
  const box = document.getElementById("total");
  if (!box || !S || selTeam == null) return;
  const d = draftFor(selTeam);
  const all = S.criteria.length;
  const filled = filledCount(d);
  if (S.showJurorTotal) {
    const t = jurorTotal(d.values, S.criteria);
    box.innerHTML = `<div class="k"><b>Cari münsif xalı</b><small>${all} meyarın cəmi</small></div>
      <div class="v"><b>${t ?? S.criteria.reduce((a, c) => a + (validValue(c, d.values[c.key]) ? d.values[c.key] : 0), 0)}</b><span>/ ${demoMax(S.criteria)} bal</span></div>`;
  } else {
    box.innerHTML = `<div class="k"><b>Doldurulub</b><small>Bütün meyarlara bal verin</small></div>
      <div class="v"><b>${filled}</b><span>/ ${all} meyar</span></div>`;
  }
  main.querySelectorAll<HTMLElement>("[data-crit]").forEach(el => {
    const c = S!.criteria.find(x => x.key === el.dataset.crit);
    el.classList.toggle("done", !!c && validValue(c, d.values[c.key]));
  });
}

function renderTags() {
  const box = document.getElementById("qlist");
  if (!box || !S || selTeam == null) return;
  const d = draftFor(selTeam);
  box.innerHTML = S.feedbackTags.map(t => {
    const on = d.tags.includes(t);
    return `<button type="button" class="qchip" data-tag="${esc(t)}" aria-pressed="${on}" ${S!.locked ? "disabled" : ""}>${icon(on ? "check" : "plus")}${esc(t)}</button>`;
  }).join("");
}

function renderNudge() {
  const box = document.getElementById("nudgeBox");
  if (!box) return;
  if (!nudge || mine.has(nudge.teamId)) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="nudge" role="alert">${icon("bell")}<div><b>Koordinator xatırladır</b>#${nudge.index} ${esc(nudge.teamName)} üçün qiymətinizi göndərin.</div>
    <button type="button" id="nudgeX" aria-label="Bağla">${icon("close")}</button></div>
    ${canNotify() && notifyPermission() === "default" ? `<button type="button" class="btn sm" id="notifyOn" style="margin-top:8px">${icon("bell")}Telefon bildirişlərini aç</button>` : ""}`;
}

function renderDock() {
  if (!S || selTeam == null) { dock.hidden = true; return; }
  const d = draftFor(selTeam);
  const saved = mine.get(selTeam);
  const all = S.criteria.length;
  const filled = filledCount(d);
  const complete = filled === all;
  // v11: the outbox state of this team's score (queued / sending / refused)
  const op = outbox?.pendingFor(selTeam) ?? null;
  const last = outbox?.lastFor(selTeam) ?? null;
  const inFlight = !!op && !!d.opId && op.opId === d.opId;
  let cls: string, title: string, line: string;
  if (inFlight && op!.status === "sending" && op!.tries <= 1) { cls = "warn"; title = `${icon("cloud")}Göndərilir…`; line = "Bal bu cihazda saxlanılıb."; }
  else if (inFlight) {
    cls = "warn"; title = `${icon("cloud")}${online ? "Növbədə" : "Oflayn — növbədə"}`;
    line = `Bal bu cihazda saxlanılıb, şəbəkə qayıdanda özü göndəriləcək${op!.tries > 1 ? ` (${op!.tries} cəhd)` : ""}.`;
  }
  else if (S.locked) { cls = "warn"; title = `${icon("lock")}Bağlıdır`; line = d.dirty && last?.status === "rejected" ? "Göndərilmədi — ballarınız bu cihazda saxlanılıb." : "Ballara yalnız baxa bilərsiniz."; }
  else if (failure && failure.teamId === selTeam) { cls = "err"; title = `${icon("warn")}Rədd edildi`; line = `${esc(failure.msg)} Ballar bu cihazda saxlanılıb.`; }
  else if (d.dirty) { cls = "warn"; title = `${icon("cloud")}Qaralama saxlanıldı`; line = `${filled}/${all} meyar · hələ göndərilməyib`; }
  else if (saved && isComplete(saved.values, S.criteria)) { cls = "ok"; title = `${icon("check")}Saxlanıldı`; line = `Son sinx: ${hhmm(saved.updatedAt)}`; }
  else if (saved) { cls = "warn"; title = `${icon("warn")}Yenidən qiymətləndirin`; line = "Meyarlar dəyişib, bütün meyarlara yenidən bal verin."; }
  else { cls = "mute"; title = "Qiymətləndirilməyib"; line = `${filled}/${all} meyar doldurulub`; }

  const can = !S.locked && !inFlight && complete && (d.dirty || !!(failure && failure.teamId === selTeam));
  let label = `${saved ? "Yenilə və göndər" : "Təsdiqlə və göndər"} ${icon("send")}`;
  let bcls = "btn primary";
  if (inFlight) label = op!.status === "sending" ? "Göndərilir…" : "Növbədədir";
  else if (justSent === selTeam) { label = `Göndərildi ${icon("check")}`; bcls += " sent"; }
  else if (saved && !d.dirty && isComplete(saved.values, S.criteria)) label = `Göndərilib ${icon("check")}`;
  dock.hidden = false;
  dock.innerHTML = `<div class="wrap narrow">
    <div class="st ${cls}" role="status" data-op="${inFlight ? op!.status : last?.status ?? ""}"><b>${title}</b><small>${line}</small></div>
    <button class="${bcls}" id="submit" ${can ? "" : "disabled"}>${label}</button>
  </div>`;
}

// ---------- submit (v11: through the outbox) ----------
function submit(teamId: number) {
  if (!S || !outbox) return;
  const d = draftFor(teamId);
  if (!isComplete(d.values, S.criteria)) { toast("Bütün meyarlara bal verin.", "err"); return; }
  const values: ScoreValues = {};
  S.criteria.forEach(c => { values[c.key] = d.values[c.key]; });
  failure = null;
  const op = outbox.enqueue(teamId, { values, note: d.note.slice(0, 2000), tags: d.tags });
  d.pending = true;
  d.opId = op.opId;
  persist(teamId);
  render();
}

function startOutbox() {
  if (!S || outbox) return;
  outbox = new Outbox<MyScore>({
    storage: (() => { try { return localStorage; } catch { return null; } })(),
    key: `ij.outbox.${S.me.id}`,
    send: sendOp,
    onChange: () => { renderHead(); renderDock(); renderOpLog(); },
    onSaved: (op, saved) => {
      mine.set(op.teamId, saved);
      const d = drafts.get(op.teamId);
      // the draft is done only if it was not edited after this op was queued
      if (!d || d.opId === op.opId || !d.dirty) {
        drafts.set(op.teamId, { values: { ...saved.values }, note: saved.note, tags: [...(saved.tags ?? [])], dirty: false, base: saved.updatedAt });
        persist(op.teamId);
      }
      justSent = op.teamId;
      setTimeout(() => { if (justSent === op.teamId) { justSent = null; renderDock(); } }, 1800);
      toast(op.tries > 1 ? `${teamOf(op.teamId)?.name ?? "Komanda"}: növbədəki bal göndərildi` : "Qiymət göndərildi");
      if (nudge?.teamId === op.teamId) nudge = null;
      formKey = "";
      render();
    },
    onRejected: op => {
      const d = drafts.get(op.teamId);
      if (d && d.opId === op.opId) { d.pending = false; persist(op.teamId); }
      if (op.httpStatus === 423 && S) S.locked = true;
      failure = { teamId: op.teamId, msg: op.error ?? "Göndərilmədi.", network: false };
      toast(`${op.error ?? "Göndərilmədi."} Ballarınız bu cihazda saxlanılıb.`, "err");
      formKey = "";
      render();
    },
  });
  // drafts an older version of this page marked "pending" (sent while offline) go through the outbox now
  for (const [teamId, d] of drafts) {
    if (d.dirty && d.pending && !outbox.pendingFor(teamId) && isComplete(d.values, S.criteria)) {
      const op = outbox.enqueue(teamId, { values: { ...d.values }, note: d.note.slice(0, 2000), tags: d.tags });
      d.opId = op.opId;
      persist(teamId);
    }
  }
  outbox.resume();
}

/**
 * One try of one op. Socket first: it is already open and kept alive by pings, so a score never goes into an HTTP
 * connection that the venue Wi-Fi dropped while the juror was filling the form; HTTP as the fallback. The same op id goes
 * with both, so a score that arrived but whose answer got lost is not applied twice.
 */
async function sendOp(op: ScoreOp): Promise<SendResult<MyScore>> {
  const payload = { ...op.body, opId: op.opId, clientAt: op.createdAt };
  const verdict = (status: number, error: string): SendResult<MyScore> =>
    status === 401 ? { ok: false, kind: "auth", error } : status >= 500 || status === 0 || status === 429 ? { ok: false, kind: "network", error } : { ok: false, kind: "rejected", status, error };
  if (sock.connected) {
    try {
      const r = await sock.timeout(7000).emitWithAck("score:submit", { teamId: op.teamId, ...payload }) as
        { ok: true; score: MyScore } | { ok: false; status: number; error: string };
      if (r.ok) return { ok: true, score: r.score };
      return verdict(r.status, r.error);
    } catch { /* no ack in time: try HTTP */ }
  }
  try {
    return { ok: true, score: await api<MyScore>(`/api/juror/scores/${op.teamId}`, { method: "PUT", body: payload, timeoutMs: 10000 }) };
  } catch (e) {
    const err = e as ApiError;
    return verdict(err.network ? 0 : err.status, err.message);
  }
}

/** Scores refused while scoring was closed go again once the coordinator opens it (if the juror has not changed them). */
function resendAfterUnlock() {
  if (!S || !outbox || S.locked) return;
  for (const [teamId, d] of drafts) {
    const last = outbox.lastFor(teamId);
    if (d.dirty && d.opId && last?.opId === d.opId && last.status === "rejected" && last.httpStatus === 423 && isComplete(d.values, S.criteria)) submit(teamId);
  }
}

const OP_LABEL: Record<ScoreOp["status"], string> = { queued: "növbədə", sending: "göndərilir", saved: "saxlanıldı", rejected: "rədd edildi" };
/** v11: the juror's send log (this device): what is queued, what got in, what was refused. */
function renderOpLog() {
  const box = document.getElementById("oplog");
  if (!box || !outbox) return;
  const rows = [...outbox.ops.slice().reverse(), ...outbox.log].slice(0, 12);
  if (!rows.length) { box.hidden = true; return; }
  box.hidden = false;
  const offline = !online && outbox.size > 0;
  box.innerHTML = `<summary>${outbox.size ? `${outbox.size} bal ${offline ? "növbədə (oflayn)" : "göndərilir"}` : "Göndərmə tarixçəsi"}</summary>
    <ul>${rows.map(o => `<li class="op-${o.status}"><b>${esc(teamOf(o.teamId)?.name ?? `#${o.teamId}`)}</b><span>${hhmm(o.doneAt ?? o.createdAt)}</span>
      <span class="st">${OP_LABEL[o.status]}${o.status === "queued" && o.tries > 0 ? ` · ${o.tries} cəhd` : ""}</span>${o.status === "rejected" && o.error ? `<small>${esc(o.error)}</small>` : ""}</li>`).join("")}</ul>`;
}

// ---------- reminder modal ----------
function showNudgeModal(p: Nudge) {
  closeNudgeModal();
  const m = document.createElement("div");
  m.className = "nudge-modal";
  m.id = "nudgeModal";
  m.setAttribute("role", "alertdialog");
  m.setAttribute("aria-labelledby", "nmT");
  m.innerHTML = `<div class="nm-card">${icon("bell")}<b id="nmT">Koordinator xatırladır</b>
    <p>#${p.index} <strong>${esc(p.teamName)}</strong> üçün qiymətinizi göndərin.</p>
    <button type="button" class="btn primary lg" id="nudgeGo">Qiymətləndirməyə keç</button></div>`;
  m.addEventListener("click", e => { if ((e.target as HTMLElement).closest("#nudgeGo") || e.target === m) { closeNudgeModal(); window.scrollTo({ top: 0, behavior: "smooth" }); } });
  document.body.appendChild(m);
  m.querySelector<HTMLButtonElement>("#nudgeGo")?.focus();
}
function closeNudgeModal() { document.getElementById("nudgeModal")?.remove(); }

function touched(teamId: number) {
  const d = draftFor(teamId);
  d.dirty = true;
  // an edit after "send": this draft is newer than the queued op (it goes with the next send)
  d.pending = false;
  d.opId = undefined;
  if (failure?.teamId === teamId) failure = null;
  persist(teamId);
  reportProgress(teamId);
}

// ---------- events ----------
function onClick(e: Event) {
  const t = e.target as HTMLElement;
  if (!S) return;
  const chip = t.closest<HTMLElement>("[data-team]");
  if (chip) { select(Number(chip.dataset.team)); render(); return; }
  if (selTeam == null) return;
  const b = t.closest<HTMLButtonElement>(".scale button");
  if (b && !b.disabled) {
    const d = draftFor(selTeam);
    d.values[b.dataset.c!] = Number(b.dataset.v);
    b.parentElement!.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    touched(selTeam);
    renderHead();
    renderTotal();
    renderDock();
    return;
  }
  const big = t.closest<HTMLElement>("[data-big]");
  if (big) {
    const key = big.dataset.big!;
    const step = t.closest<HTMLButtonElement>("[data-step]");
    const quick = t.closest<HTMLButtonElement>("[data-q]");
    if (step && !step.disabled) {
      const cur = draftFor(selTeam).values[key];
      const c = S.criteria.find(x => x.key === key)!;
      setBig(key, validValue(c, cur) ? cur + Number(step.dataset.step) : Math.round(c.maxScore / 2));
    } else if (quick && !quick.disabled) setBig(key, Number(quick.dataset.q));
    return;
  }
  const q = t.closest<HTMLButtonElement>(".qchip");
  if (q && !q.disabled) {
    const d = draftFor(selTeam);
    const tag = q.dataset.tag!;
    d.tags = d.tags.includes(tag) ? d.tags.filter(x => x !== tag) : [...d.tags, tag];
    touched(selTeam);
    renderTags();
    renderHead();
    renderDock();
    return;
  }
  if (t.closest("#reset")) {
    const d = drafts.get(selTeam);
    if (!d?.dirty) { toast("Dəyişiklik yoxdur"); return; }
    drafts.delete(selTeam);
    persist(selTeam);
    if (failure?.teamId === selTeam) failure = null;
    formKey = "";
    render();
    reportProgress(selTeam);
    toast(mine.has(selTeam) ? "Göndərilmiş ballara qaytarıldı" : "Ballar təmizləndi");
    return;
  }
  if (t.closest("#prev")) {
    const i = S.teams.findIndex(x => x.id === selTeam);
    if (i > 0) { select(S.teams[i - 1].id); render(); }
    return;
  }
  if (t.closest("#nudgeX")) { nudge = null; renderNudge(); return; }
  if (t.closest("#nudgeGo")) { closeNudgeModal(); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  if (t.closest("#notifyOn")) {
    enableNotifications().then(p => { toast(p === "granted" ? "Bildirişlər açıldı" : "Bildirişə icazə verilmədi", p === "granted" ? "ok" : "err"); renderNudge(); });
    return;
  }
  if (t.closest("[data-theme-toggle]")) { toggleTheme(); head.dataset.sig = ""; renderHead(); }
}
main.addEventListener("click", onClick);
head.addEventListener("click", onClick);
main.addEventListener("input", e => {
  const range = (e.target as HTMLElement).closest<HTMLInputElement>(".bs-range");
  if (range) { const box = range.closest<HTMLElement>("[data-big]"); if (box) setBig(box.dataset.big!, Number(range.value)); return; }
  const el = e.target as HTMLTextAreaElement;
  if (el.id !== "note" || selTeam == null) return;
  const d = draftFor(selTeam);
  d.note = el.value;
  touched(selTeam);
  $("#ncount").textContent = `${el.value.length} / ${NOTE_MAX} simvol`;
  renderDock();
});
dock.addEventListener("click", e => {
  if ((e.target as HTMLElement).closest("#submit") && selTeam != null) submit(selTeam);
});
window.addEventListener("online", () => outbox?.resume());

const sock = live({
  role: "juror",
  on: {
    "stage:changed": (s: StagePayload) => onStage(s),
    "timer:changed": (p: { timer: TimerState; serverNow: number }) => strip.setTimer(p.timer, p.serverNow),
    "event:locked": (p: { locked: boolean }) => {
      if (!S) return;
      S.locked = p.locked;
      toast(p.locked ? "Qiymətləndirmə bağlandı" : "Qiymətləndirmə açıldı");
      formKey = "";
      render();
      if (!p.locked) { outbox?.resume(); resendAfterUnlock(); }
    },
    "my-score:saved": (s: MyScore) => {
      mine.set(s.teamId, s);
      const d = drafts.get(s.teamId);
      if (d && !d.dirty) drafts.delete(s.teamId);
      render();
    },
    nudge: (p: Nudge) => {
      nudge = p;
      const text = `#${p.index} ${p.teamName} üçün qiymətinizi göndərin.`;
      try { navigator.vibrate?.([220, 120, 220, 120, 400]); } catch { /* unsupported */ }
      chime();
      blinkTitle("Koordinator xatırladır");
      // Screen off or another app in front: a system notification (HTTPS only); the page modal waits for the juror.
      if (document.visibilityState !== "visible" || !document.hasFocus()) void systemNotify("Koordinator xatırladır", text);
      if (selTeam !== p.teamId && !(selTeam != null && drafts.get(selTeam)?.dirty)) select(p.teamId);
      render();
      showNudgeModal(p);
    },
    "config:changed": () => load(),
  },
  resync: async () => { outbox?.resume(); await load(); outbox?.resume(); },
  status: o => {
    online = o;
    if (o) outbox?.resume();
    if (!S) return;
    renderDock();
    renderOpLog();
    renderHead();
    const ln = document.getElementById("syncln");
    if (ln) { ln.className = o ? "ok-t" : "warn-t"; ln.textContent = `● ${o ? "Sinxron aktiv" : "Oflayn"}`; }
  },
});

// ---------- keep the screen awake while scoring ----------
async function wake() {
  try {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } }).wakeLock;
    if (wl && document.visibilityState === "visible") await wl.request("screen");
  } catch { /* unsupported or denied */ }
}
document.addEventListener("visibilitychange", wake);
wake();

void load();
