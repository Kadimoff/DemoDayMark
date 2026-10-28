import "./styles.css";
import { isComplete, jurorTotal } from "../../shared/scoring";
import type { JurorStatePayload, MyScore, ScoreValues, StagePayload, TimerState } from "../../shared/types";
import { api, ApiError } from "./lib/api";
import { $, esc, hhmm, icon, toast } from "./lib/dom";
import { live } from "./lib/socket";
import { StageStrip } from "./lib/stage";
import { topbar } from "./lib/topbar";

interface Draft { values: ScoreValues; note: string; dirty: boolean; base: number; pending?: boolean }

const bar = topbar({ role: "juror" });
const strip = new StageStrip($("#stage"));
const main = $("#main");
const dock = $("#dock");

let S: JurorStatePayload | null = null;
const mine = new Map<number, MyScore>();
const drafts = new Map<number, Draft>();
let selTeam: number | null = null;
let lastStageTeam: number | null | undefined;
let formKey = "";
let sending = false;
let justSent: number | null = null;
let failure: { teamId: number; msg: string; network: boolean } | null = null;

// ---------- drafts survive reloads and Wi-Fi drops ----------
const lsKey = (teamId: number) => `ij.draft.${S?.me.id}.${teamId}`;
function persist(teamId: number) {
  const d = drafts.get(teamId);
  try {
    if (d?.dirty) localStorage.setItem(lsKey(teamId), JSON.stringify({ values: d.values, note: d.note, base: d.base, pending: !!d.pending }));
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
      drafts.set(t.id, { values: d.values ?? {}, note: d.note ?? "", base: d.base ?? 0, dirty: true, pending: d.pending });
    } catch { /* corrupt entry */ }
  }
}
function draftFor(teamId: number): Draft {
  const saved = mine.get(teamId);
  let d = drafts.get(teamId);
  if (!d || (!d.dirty && (saved?.updatedAt ?? 0) !== d.base)) {
    d = { values: { ...(saved?.values ?? {}) }, note: saved?.note ?? "", dirty: false, base: saved?.updatedAt ?? 0 };
    drafts.set(teamId, d);
  }
  return d;
}

// ---------- data ----------
async function load() {
  try {
    S = await api<JurorStatePayload>("/api/juror/state");
  } catch (e) {
    if (!S) main.innerHTML = `<div class="banner err">${esc((e as Error).message)}</div>`;
    return;
  }
  mine.clear();
  S.myScores.forEach(s => mine.set(s.teamId, s));
  bar.setEventName(S.stage.eventName);
  restoreDrafts();
  onStage(S.stage);
  formKey = "";
  render();
}

function onStage(stage: StagePayload) {
  strip.set(stage);
  if (!S) return;
  S.stage = stage;
  bar.setEventName(stage.eventName);
  const cur = stage.team?.id ?? null;
  if (cur !== lastStageTeam) {
    const first = lastStageTeam === undefined;
    lastStageTeam = cur;
    if (cur != null && cur !== selTeam) {
      // Follow the stage, unless the juror is in the middle of an unsent edit.
      if (selTeam != null && drafts.get(selTeam)?.dirty) {
        if (!first) toast(`Səhnədə: ${stage.team!.name}. Göndərilməmiş dəyişikliyiniz saxlanılıb.`);
      } else {
        selTeam = cur;
        failure = null;
        formKey = "";
      }
    }
  }
  render();
}

// ---------- render ----------
function render() {
  if (!S) return;
  if (!S.teams.length) { main.innerHTML = `<p class="empty">Komanda siyahısı hələ boşdur.</p>`; dock.hidden = true; return; }
  if (selTeam == null || !S.teams.some(t => t.id === selTeam)) selTeam = S.stage.team?.id ?? S.teams[0].id;
  const team = S.teams.find(t => t.id === selTeam)!;
  const idx = S.teams.indexOf(team) + 1;
  const d = draftFor(team.id);
  const locked = S.locked;

  const chips = S.teams.map((t, i) => {
    const saved = mine.get(t.id);
    const done = !!saved && isComplete(saved.values, S!.criteria);
    const dirty = drafts.get(t.id)?.dirty;
    return `<button class="chip" data-team="${t.id}" aria-pressed="${t.id === team.id}">
      <span class="n">${i + 1}</span>${esc(t.name)}
      ${t.id === S!.stage.team?.id ? `<span class="live">Səhnədə</span>` : ""}
      ${dirty ? `<span class="draft" title="Göndərilməmiş dəyişiklik"></span>` : done ? `<span class="done" aria-label="göndərilib">${icon("check")}</span>` : ""}
    </button>`;
  }).join("");

  const critSig = S.criteria.map(c => `${c.key}:${c.weight}:${c.name}:${c.description}`).join("|");
  const key = [team.id, team.name, team.project, critSig, d.base, locked, S.me.displayName].join("§");
  if (key !== formKey) {
    formKey = key;
    main.innerHTML = `
      <div class="row between" style="margin-bottom:12px">
        <div class="row" style="gap:8px"><h3>Münsif</h3><b>${esc(S.me.displayName)}</b></div>
        <span class="sub" style="margin:0">Şkala: 1–3 zəif · 4–6 orta · 7–8 güclü · 9–10 əla</span>
      </div>
      <div class="chips" id="chips" role="group" aria-label="Komandalar">${chips}</div>
      ${locked ? `<div class="banner lock" style="margin-top:12px">${icon("lock")}<span>Qiymətləndirmə koordinator tərəfindən bağlanıb. Ballarınıza yalnız baxa bilərsiniz.</span></div>` : ""}
      <div class="card fade" style="margin-top:12px">
        <div class="pad teamhead">
          <div style="min-width:0">
            <h3>Komanda ${idx} / ${S.teams.length}</h3>
            <h2>${esc(team.name)}</h2>
            ${team.project ? `<p class="sub">${esc(team.project)}</p>` : ""}
          </div>
          <div id="fstat"></div>
        </div>
        <div>${S.criteria.map(c => `
          <div class="crit">
            <div class="ch"><b id="cl-${esc(c.key)}">${esc(c.name)}</b><span class="w">çəki ${c.weight}%</span></div>
            ${c.description ? `<p>${esc(c.description)}</p>` : ""}
            <div class="scale" role="group" aria-labelledby="cl-${esc(c.key)}">${Array.from({ length: 10 }, (_, k) =>
              `<button type="button" data-c="${esc(c.key)}" data-v="${k + 1}" aria-pressed="${d.values[c.key] === k + 1}" aria-label="${esc(c.name)}: ${k + 1}" ${locked ? "disabled" : ""}>${k + 1}</button>`).join("")}</div>
            <div class="bands" aria-hidden="true"><span>zəif</span><span>orta</span><span>güclü</span><span>əla</span></div>
          </div>`).join("")}
          <div class="crit">
            <div class="ch"><b><label for="note">Şərh</label></b><span class="w">istəyə bağlı</span></div>
            <textarea id="note" maxlength="2000" placeholder="Komandaya rəy, güclü tərəflər, risklər…" ${locked ? "disabled" : ""}>${esc(d.note)}</textarea>
          </div>
        </div>
      </div>`;
  } else {
    $("#chips").innerHTML = chips;
  }
  renderDock();
}

function renderDock() {
  if (!S || selTeam == null) { dock.hidden = true; return; }
  const d = draftFor(selTeam);
  const saved = mine.get(selTeam);
  const all = S.criteria.length;
  const filled = S.criteria.filter(c => d.values[c.key] >= 1).length;
  const complete = filled === all;
  let st: string, pill: string;
  if (S.locked) { st = "Qiymətləndirmə bağlanıb."; pill = `<span class="pill warn">Bağlıdır</span>`; }
  else if (failure && failure.teamId === selTeam) {
    st = failure.network ? "Göndərilmədi. Qaralama bu cihazda saxlanılıb." : esc(failure.msg);
    pill = `<span class="pill danger">Göndərilmədi</span>`;
  }
  else if (d.dirty) { st = `${filled}/${all} kriteriya · yadda saxlanmayıb`; pill = `<span class="pill hot">Dəyişiklik var</span>`; }
  else if (saved) { st = `Göndərilib · ${hhmm(saved.updatedAt)}. Dəyişmək üçün balı yenidən seçin.`; pill = `<span class="pill ok">Göndərilib</span>`; }
  else { st = `${filled}/${all} kriteriya doldurulub`; pill = `<span class="pill">Qiymətləndirilməyib</span>`; }
  const fs = document.getElementById("fstat");
  if (fs) fs.innerHTML = pill;

  const total = S.showJurorTotal ? jurorTotal(d.values, S.criteria) : null;
  const left = S.showJurorTotal
    ? `<b>${total != null ? total.toFixed(1) : "—"}</b><span>/ 100</span>`
    : `<b>${filled}/${all}</b><span>kriteriya</span>`;
  const can = !S.locked && !sending && complete && (d.dirty || !!(failure && failure.teamId === selTeam));
  let label = saved ? "Yenilə" : "Göndər";
  let cls = "btn primary";
  if (sending) label = "Göndərilir…";
  else if (justSent === selTeam) { label = `Göndərildi ${icon("check")}`; cls += " sent"; }
  else if (failure && failure.teamId === selTeam && failure.network) label = `${icon("retry")} Yenidən cəhd et`;
  dock.hidden = false;
  dock.innerHTML = `<div class="wrap">
    <div class="tot">${left}</div>
    <div class="st" role="status">${st}</div>
    <div class="acts"><button class="${cls}" id="submit" ${can ? "" : "disabled"}>${label}</button></div>
  </div>`;
}

// ---------- submit ----------
async function submit(teamId: number, quiet = false) {
  if (!S || sending) return;
  const d = draftFor(teamId);
  if (!isComplete(d.values, S.criteria)) { toast("Bütün kriteriyalara bal verin.", "err"); return; }
  const values: ScoreValues = {};
  S.criteria.forEach(c => { values[c.key] = d.values[c.key]; });
  sending = true;
  failure = null;
  renderDock();
  try {
    const saved = await api<MyScore>(`/api/juror/scores/${teamId}`, { method: "PUT", body: { values, note: d.note.slice(0, 2000) } });
    mine.set(teamId, saved);
    drafts.set(teamId, { values: { ...saved.values }, note: saved.note, dirty: false, base: saved.updatedAt });
    persist(teamId);
    justSent = teamId;
    setTimeout(() => { if (justSent === teamId) { justSent = null; renderDock(); } }, 1800);
    if (!quiet) toast("Qiymət göndərildi");
    formKey = "";
  } catch (e) {
    const err = e as ApiError;
    if (err.status === 423) { S.locked = true; toast(err.message, "err"); formKey = ""; }
    else {
      failure = { teamId, msg: err.message, network: err.network };
      d.pending = err.network;
      persist(teamId);
      if (!quiet) toast(err.network ? "Bağlantı yoxdur. Qaralama saxlanıldı — yenidən cəhd edin." : err.message, "err");
    }
  } finally {
    sending = false;
    render();
  }
}

async function retryPending() {
  if (!S || S.locked) return;
  for (const [teamId, d] of drafts) {
    if (d.dirty && d.pending && isComplete(d.values, S.criteria)) {
      await submit(teamId, true);
      if (!drafts.get(teamId)?.dirty) toast("Saxlanılmış qaralama göndərildi");
    }
  }
}

// ---------- events ----------
main.addEventListener("click", e => {
  const t = e.target as HTMLElement;
  const chip = t.closest<HTMLElement>(".chip");
  if (chip) {
    selTeam = Number(chip.dataset.team);
    formKey = "";
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  const b = t.closest<HTMLButtonElement>(".scale button");
  if (b && !b.disabled && selTeam != null) {
    const d = draftFor(selTeam);
    d.values[b.dataset.c!] = Number(b.dataset.v);
    d.dirty = true;
    b.parentElement!.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    if (failure?.teamId === selTeam) failure = null;
    persist(selTeam);
    render();
  }
});
main.addEventListener("input", e => {
  const el = e.target as HTMLTextAreaElement;
  if (el.id !== "note" || selTeam == null) return;
  const d = draftFor(selTeam);
  d.note = el.value;
  d.dirty = true;
  persist(selTeam);
  renderDock();
});
dock.addEventListener("click", e => {
  if ((e.target as HTMLElement).closest("#submit") && selTeam != null) submit(selTeam);
});
window.addEventListener("online", () => retryPending());

live({
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
      if (!p.locked) retryPending();
    },
    "my-score:saved": (s: MyScore) => {
      mine.set(s.teamId, s);
      const d = drafts.get(s.teamId);
      if (d && !d.dirty) drafts.delete(s.teamId);
      render();
    },
    "config:changed": () => load(),
  },
  resync: async () => { await load(); retryPending(); },
  status: online => bar.setOnline(online),
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

load().then(retryPending);
