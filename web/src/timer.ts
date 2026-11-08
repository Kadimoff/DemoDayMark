// Projector screen (/timer, /stage, /stage/demo): the shared server timer, and — munsif.im — the team's
// presentation (pdf.js) with the timer floating above it as a bubble, the last-5-seconds takeover,
// the "Növbəti çıxış" intro and the website mode. Anyone can watch; only a logged-in admin gets the
// control dock and keyboard shortcuts (slides: ← → PageUp PageDown).
import "./styles.css";
import QRCode from "qrcode";
import { adjustTimer, applyTimerAction, fmtClock, timerView, type PhaseKind, type TimerView } from "../../shared/timer";
import type { StagePayload, StageShow, TimerAction, TimerState } from "../../shared/types";
import { api, ApiError } from "./lib/api";
import { now as serverNow, syncClock } from "./lib/clock";
import { $, esc, icon, reducedMotion } from "./lib/dom";
import { Finale, FINALE_HTML, Sfx } from "./lib/finale";
import { Deck } from "./lib/pdfdeck";
import { live } from "./lib/socket";

const qs = new URLSearchParams(location.search);
const DEMO = location.pathname.replace(/\/$/, "") === "/stage/demo";
// ?slow=N (demo only): time runs N× slower — for exact screenshots of the effect
const SLOW = DEMO ? Math.max(1, Math.min(20, Number(qs.get("slow")) || 1)) : 1;
const T0 = Date.now();
const now = () => (DEMO ? T0 + (Date.now() - T0) / SLOW : serverNow());
const reduced = reducedMotion() || qs.get("reduced") === "1";

const CIRC = 2 * Math.PI * 176;
const BCIRC = 2 * Math.PI * 52;
const body = document.body;
const el = {
  event: $("#event"), name: $("#name"), nameTeam: $("#nameTeam"), nameProj: $("#nameProj"), banner: $("#banner"), rim: $("#rimText"), badge: $("#badge"),
  digits: $("#digits"), sub: $("#subtext"), ring: $("#ring"), barP: $("#barPitch"), barQ: $("#barQa"),
  pillP: $("#pillPitch"), pillQ: $("#pillQa"), btns: $("#btns"), toast: $("#tpToast"), keys: $("#keys"), dock: $("#dock"),
  view: $("#stView"), slides: $("#stSlides"), site: $("#stSite"), frame: $<HTMLIFrameElement>("#stFrame"), qr: $("#stQr"), qrImg: $<HTMLImageElement>("#stQrImg"),
  qrTeam: $("#stQrTeam"), qrUrl: $("#stQrUrl"), corner: $("#stCorner"), qrSmall: $<HTMLImageElement>("#stQrSmall"), host: $("#stHost"),
  hud: $("#stHud"), hudTeam: $("#hudTeam"), hudInfo: $("#hudInfo"), slidePill: $("#slidePill"),
  bubble: $("#bubble"), bBar: $<SVGCircleElement>("#bubbleBar"), bLabel: $("#bLabel"), bTime: $("#bTime"), bTeam: $("#bTeam"), bPause: $("#bPause"),
  intro: $("#intro"), introLogo: $("#introLogo"), introName: $("#introName"), introProject: $("#introProject"), introMembers: $("#introMembers"), introCount: $("#introCount"),
  finale: $("#finale"), demo: $("#demoBar"),
};

let stage: StagePayload | null = null;
let isAdmin = false;
let lastKind: PhaseKind | null = null;
let lastRemaining = -1;
let lastVisual = "";
let lastTeamKey = "";

const mmss = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
const minutes = (sec: number) => (sec % 60 === 0 ? `${sec / 60} DƏQİQƏ` : mmss(sec));
const minShort = (sec: number) => (sec % 60 === 0 ? `${sec / 60} dəq` : mmss(sec));

let toastT = 0;
function toast(text: string) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastT);
  toastT = window.setTimeout(() => { el.toast.hidden = true; }, 2600);
}

// ---------- sound (Web Audio, unlocked on first interaction) ----------
let audio: AudioContext | null = null;
let muted = false;
try { muted = localStorage.getItem("munsif-sound") === "0"; } catch { /* private mode */ }
function ensureAudio() {
  if (!audio) audio = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  if (audio.state === "suspended") void audio.resume();
  return audio;
}
["click", "touchstart", "keydown"].forEach(ev => document.addEventListener(ev, () => { try { ensureAudio(); } catch { /* no audio */ } }, { once: true }));
const sfx = new Sfx(() => audio);
sfx.muted = muted;
function notes(list: Array<{ f: number; d: number; t: number; type?: OscillatorType; v?: number }>) {
  try {
    if (muted) return;
    const ctx = ensureAudio();
    if (ctx.state !== "running") return;
    const t0 = ctx.currentTime;
    for (const n of list) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = n.type ?? "sine";
      o.frequency.setValueAtTime(n.f, t0 + n.t);
      g.gain.setValueAtTime(0.001, t0 + n.t);
      g.gain.exponentialRampToValueAtTime(n.v ?? 0.35, t0 + n.t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.t + n.d);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + n.t);
      o.stop(t0 + n.t + n.d + 0.02);
    }
  } catch { /* audio unavailable */ }
}
const sToQa = () => notes([{ f: 587.33, d: 0.25, t: 0, type: "triangle", v: 0.45 }, { f: 880, d: 0.35, t: 0.28, type: "triangle", v: 0.5 }, { f: 1174.66, d: 0.55, t: 0.66, v: 0.5 }]);
const sTick = () => notes([{ f: 1046.5, d: 0.06, t: 0, v: 0.2 }]);
const sAlarm = () => notes([0, 0.23, 0.46].map((t, i) => ({ f: i === 1 ? 783.99 : 987.77, d: 0.2, t, type: "sawtooth" as const, v: 0.38 })).concat([{ f: 1318.51, d: 0.55, t: 0.7, type: "sawtooth", v: 0.48 }]));
const sTest = () => notes([{ f: 523.25, d: 0.14, t: 0, v: 0.3 }, { f: 659.25, d: 0.14, t: 0.16, v: 0.3 }, { f: 783.99, d: 0.25, t: 0.32, v: 0.35 }]);
let alarmLoop = 0;
/** Three alarms; with the takeover the boom is the first one, so only two follow. */
function finalAlarm(firstAlready = false) {
  let n = firstAlready ? 1 : 0;
  if (!firstAlready) sAlarm();
  clearInterval(alarmLoop);
  alarmLoop = window.setInterval(() => { if (++n >= 3) clearInterval(alarmLoop); sAlarm(); }, 1500);
}
function toggleMute() {
  muted = !muted; sfx.muted = muted;
  try { localStorage.setItem("munsif-sound", muted ? "0" : "1"); } catch { /* private mode */ }
  toast(muted ? "Səs söndürüldü" : "Səs açıqdır");
  btnSig = "";
}

// ---------- presentation stage ----------
const forcedFx = qs.get("fx") === "lite" ? "lite" : qs.get("fx") === "full" ? "full" : null;
el.finale.innerHTML = FINALE_HTML;
const finale = new Finale({ root: el.finale, bubble: el.bubble, reduced, slow: SLOW, sfx }, forcedFx);
const deck = new Deck(el.slides, reduced, msg => { toast(msg); presFailed = deck.current; applyView(); });
let presFailed: string | null = null;
type View = "dial" | "pres" | "site";
let view: View = "dial";

const show = (): StageShow | null => stage?.show ?? null;
function wantedView(): View {
  const s = show();
  if (!stage?.team || !s) return "dial";
  if (s.mode === "site" && s.site) return "site";
  if (s.mode === "auto" && s.pres && s.pres.url !== presFailed) return "pres";
  return "dial";
}

function applyView() {
  const v = wantedView();
  const s = show();
  view = v;
  body.classList.toggle("st-pres", v === "pres");
  body.classList.toggle("st-sitemode", v === "site");
  el.view.hidden = v === "dial";
  el.slides.hidden = v !== "pres";
  el.site.hidden = v !== "site";
  el.hud.hidden = v === "dial";
  if (v === "pres" && s?.pres) {
    if (deck.current !== s.pres.url) {
      void deck.load(s.pres.url).then(ok => { if (ok) { void deck.show(show()?.slide ?? 1, 0, true); paintHud(); } });
    } else if (deck.ready && s.slide !== deck.shown) {
      void deck.show(s.slide, deck.shown ? Math.sign(s.slide - deck.shown) : 0).then(paintHud);
    }
  } else if (!s?.pres && deck.current) {
    deck.unload();
  }
  if (v === "site" && s?.site && stage?.team) void showSite(s.site.url, s.site.embeddable, stage.team.name);
  else if (el.frame.dataset.src) { el.frame.removeAttribute("src"); el.frame.dataset.src = ""; }
  paintHud();
}

async function showSite(url: string, embeddable: boolean | null, team: string) {
  let qr = "";
  try { qr = await QRCode.toDataURL(url, { margin: 1, width: 512, color: { dark: "#0B0B14", light: "#FFFFFF" } }); } catch { /* bad url */ }
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  if (embeddable) {
    if (el.frame.dataset.src !== url) { el.frame.src = url; el.frame.dataset.src = url; }
    el.frame.hidden = false; el.qr.hidden = true; el.corner.hidden = false; el.qrSmall.src = qr; el.host.textContent = host;
  } else {
    el.frame.hidden = true; el.frame.removeAttribute("src"); el.frame.dataset.src = "";
    el.qr.hidden = false; el.corner.hidden = true; el.qrImg.src = qr; el.qrTeam.textContent = team; el.qrUrl.textContent = url;
  }
}

function paintHud() {
  const t = stage?.team;
  el.hudTeam.textContent = t ? t.name : stage?.eventName ?? "munsif.im";
  el.hudInfo.textContent = t ? `#${t.index} · ${t.index}/${t.total}${t.project ? ` · ${t.project}` : ""}` : "";
  const pages = deck.pages || show()?.pres?.pages || 0;
  el.slidePill.hidden = !(view === "pres" && pages);
  el.slidePill.textContent = `${deck.shown || show()?.slide || 1} / ${pages}`;
  el.bTeam.textContent = t?.name ?? "";
}

// bubble: draggable to any corner (double click puts it back); position remembered on this screen
function placeBubble() {
  try {
    const p = JSON.parse(localStorage.getItem("munsif-bubble") || "null") as { x: number; y: number } | null;
    if (!p) return;
    const w = el.bubble.offsetWidth;
    el.bubble.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, p.x * innerWidth))}px`;
    el.bubble.style.top = `${Math.max(8, Math.min(innerHeight - w - 8, p.y * innerHeight))}px`;
  } catch { /* ignore */ }
}
placeBubble();
addEventListener("resize", placeBubble);
{
  let drag: { dx: number; dy: number } | null = null;
  el.bubble.addEventListener("pointerdown", e => { e.stopPropagation(); const r = el.bubble.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; el.bubble.setPointerCapture(e.pointerId); el.bubble.classList.add("dragging"); });
  el.bubble.addEventListener("pointermove", e => {
    if (!drag) return; const w = el.bubble.offsetWidth;
    el.bubble.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, e.clientX - drag.dx))}px`;
    el.bubble.style.top = `${Math.max(8, Math.min(innerHeight - w - 8, e.clientY - drag.dy))}px`;
  });
  const end = () => {
    if (!drag) return; drag = null; el.bubble.classList.remove("dragging");
    const r = el.bubble.getBoundingClientRect();
    try { localStorage.setItem("munsif-bubble", JSON.stringify({ x: r.left / innerWidth, y: r.top / innerHeight })); } catch { /* ignore */ }
  };
  el.bubble.addEventListener("pointerup", end); el.bubble.addEventListener("pointercancel", end);
  el.bubble.addEventListener("dblclick", () => { try { localStorage.removeItem("munsif-bubble"); } catch { /* ignore */ } el.bubble.style.left = ""; el.bubble.style.top = ""; });
}

let lastSoft = -1;
function bubbleFrame(v: TimerView) {
  const on = view !== "dial" && v.kind !== "idle" && !introOn;
  el.bubble.classList.toggle("hidden-b", !on);
  if (!on) return;
  const frac = v.kind === "done" ? 0 : v.remainingExact / v.phaseTotal;
  el.bBar.style.strokeDashoffset = String(BCIRC * (1 - frac));
  const sec = v.kind === "done" ? 0 : v.remaining;
  el.bTime.textContent = fmtClock(sec);
  el.bLabel.textContent = v.kind === "qa" ? "SUAL-CAVAB" : v.kind === "done" ? "VAXT BİTDİ" : "TƏQDİMAT";
  const live = v.running && !v.ready;
  const cl = el.bubble.classList;
  cl.toggle("qa", v.kind === "qa");
  cl.toggle("warn", live && v.remaining <= 30 && v.remaining > 10);
  cl.toggle("danger", live && v.remaining <= 10 && v.remaining > 0);
  cl.toggle("over", v.kind === "done");
  cl.toggle("paused", !v.running);
  el.bPause.hidden = v.running || v.kind === "done" || v.ready;
  // soft ticks 10..6; 5..1 belong to the takeover
  if (live && v.remaining <= 10 && v.remaining > 5 && v.remaining !== lastSoft) { lastSoft = v.remaining; sfx.soft(); }
}

// ---------- intro ("Növbəti çıxış" + 3·2·1) ----------
let introShown: number | null = null;
let introCountN: number | null = null;
let introOn = false;
function introFrame() {
  const at = show()?.introAt ?? null;
  const t = stage?.team;
  const age = at != null ? now() - at : Infinity;
  const on = !!t && at != null && age >= 0 && age < 7000;
  if (on && introShown !== at) {
    introShown = at; introCountN = null;
    el.introLogo.innerHTML = show()?.logo ? `<img src="${esc(show()!.logo!)}" alt="">` : esc((t!.name.trim()[0] ?? "m").toLocaleUpperCase("az"));
    el.introName.innerHTML = [...t!.name].map((ch, i) => `<span style="animation-delay:${0.7 + i * 0.045}s">${ch === " " ? "&nbsp;" : esc(ch)}</span>`).join("");
    el.introProject.textContent = t!.project || "";
    el.introMembers.textContent = (show()?.members ?? []).join(" · ");
    el.introCount.innerHTML = ""; el.intro.classList.remove("counting");
    el.intro.hidden = false;
    for (const a of el.intro.querySelectorAll<HTMLElement>("*")) { a.style.animation = "none"; void a.offsetWidth; a.style.animation = ""; }
    if (age < 1500) sfx.whoosh();
  }
  if (!on) { if (!el.intro.hidden) el.intro.hidden = true; introOn = false; return; }
  introOn = true;
  const n = age < 3200 ? null : age < 4100 ? 3 : age < 5000 ? 2 : age < 5900 ? 1 : 0;
  if (n !== introCountN) {
    introCountN = n;
    if (n === null) return;
    el.intro.classList.add("counting");
    const b = document.createElement("b");
    b.textContent = n === 0 ? "BAŞLA!" : String(n);
    if (n === 0) b.className = "go";
    el.introCount.replaceChildren(b);
    if (n === 0) sfx.go(); else sfx.tick(n + 2);
  }
}

// ---------- dial rendering ----------
function setTeam() {
  const t = stage?.team;
  el.event.innerHTML = `${esc(stage?.eventName || "munsif.im")}${t ? `<span class="ix">${t.index}/${t.total}</span>` : ""}`;
  const next = show()?.next;
  const key = t ? `${t.id}|${t.name}|${t.project}|${t.index}` : `none|${next?.name ?? ""}`;
  if (key === lastTeamKey) return;
  el.nameTeam.innerHTML = t ? `<span class="ix">#${t.index}</span>${esc(t.name)}` : "Komanda seçilməyib";
  el.nameTeam.classList.toggle("empty", !t);
  el.nameProj.textContent = t?.project ?? (next ? `Növbəti: ${next.name}` : "");
  if (lastTeamKey || t) {
    el.name.classList.remove("swap");
    void el.name.offsetWidth;
    el.name.classList.add("swap");
  }
  lastTeamKey = key;
  document.title = t ? `${t.name} · Səhnə · munsif.im` : `Səhnə · ${stage?.eventName || "munsif.im"}`;
}

function visuals(kind: PhaseKind, timer: TimerState, ready: boolean) {
  const brand = (stage?.eventName || "munsif.im").toLocaleUpperCase("az");
  const sig = `${kind}|${timer.pitchSec}|${timer.qaSec}|${ready}|${brand}`;
  if (sig === lastVisual) return;
  lastVisual = sig;
  const P = timer.pitchSec, Q = timer.qaSec;
  el.pillP.textContent = `${minShort(P)} çıxış`;
  el.pillQ.textContent = `+${minShort(Q)} sual`;
  body.classList.remove("phase-pitch", "phase-qa", "phase-done");
  const phase = kind === "idle" ? "pitch" : kind;
  body.classList.add(`phase-${phase}`);
  el.pillP.className = phase === "pitch" ? "on" : "past";
  el.pillQ.className = phase === "qa" ? "on" : phase === "done" ? "past" : "";
  if (kind === "idle" || (kind === "pitch" && ready)) {
    el.banner.textContent = kind === "idle" ? `GÖZLƏMƏDƏ • ${brand}` : `HAZIR • TƏQDİMAT ${minutes(P)}`;
    el.rim.textContent = ` • ${brand} • ${minutes(P)} TƏQDİMAT + ${minutes(Q)} SUAL-CAVAB • ${brand} • UĞURLAR! `;
    el.badge.textContent = kind === "idle" ? "Gözləmədə" : "Hazır • Təqdimat";
    el.sub.textContent = `Sonra: +${minShort(Q)} sual-cavab`;
  } else if (kind === "pitch") {
    el.banner.textContent = `TƏQDİMAT DAVAM EDİR • ${minutes(P)}`;
    el.rim.textContent = ` • TƏQDİMAT VAXTI (${minutes(P)}) • UĞURLAR! • TƏQDİMAT VAXTI (${minutes(P)}) • ÇIXIŞ DAVAM EDİR `;
    el.badge.textContent = "Mərhələ 1 • Təqdimat";
    el.sub.textContent = `Sonra: +${minShort(Q)} sual-cavab`;
  } else if (kind === "qa") {
    el.banner.textContent = `TƏQDİMAT BİTDİ! • SUAL-CAVAB (${minShort(Q).toUpperCase()})`;
    el.rim.textContent = ` • TƏQDİMAT BİTDİ! • SUAL-CAVAB MƏRHƏLƏSİ (+${minutes(Q)}) • TƏQDİMAT BİTDİ! • SUAL-CAVAB `;
    el.badge.textContent = "Təqdimat bitdi • Sual-cavab";
    el.sub.textContent = `Münsiflərin sual-cavab vaxtı (${minShort(Q)})`;
  } else {
    el.banner.textContent = "VAXT BİTDİ! • ÇIXIŞ YEKUNLAŞDI";
    el.rim.textContent = " • VAXT BİTDİ! • TƏQDİMAT VƏ SUAL-CAVAB TAMAMLANDI • VAXT BİTDİ! • TƏŞƏKKÜRLƏR! ";
    el.badge.textContent = "Vaxt tamamlandı!";
    el.sub.textContent = "Təşəkkür edirik! Növbəti komandaya keçid edin.";
  }
}

let tuKey = "";
function tick() {
  if (!stage) return;
  const t = stage.timer;
  const v = timerView(t, now());
  visuals(v.kind, t, v.ready);
  body.classList.toggle("paused", !v.running);
  const shown = v.kind === "idle" ? t.pitchSec : v.remaining;
  el.digits.textContent = mmss(shown);
  const frac = v.kind === "idle" ? 1 : v.kind === "done" ? 0 : v.remainingExact / v.phaseTotal;
  el.ring.style.strokeDashoffset = String(CIRC * (1 - frac));
  el.barP.style.width = v.kind === "pitch" || v.kind === "idle" ? `${frac * 100}%` : "0%";
  el.barQ.style.width = v.kind === "qa" ? `${frac * 100}%` : v.kind === "done" ? "0%" : "100%";

  introFrame();
  bubbleFrame(v);

  // Last 5 seconds of the pitch and of Q&A: the takeover (in every view, as long as a team is on stage).
  const fx = !!stage.team && !introOn;
  const inLast = fx && v.running && (v.kind === "pitch" || v.kind === "qa") && v.remainingExact > 0 && v.remainingExact <= 5;
  if (inLast) {
    if (!finale.active || finale.tu) finale.enter();
    const n = Math.ceil(v.remainingExact - 1e-6);
    if (n !== finale.n) finale.beat(n);
    finale.setBar(v.remainingExact / 5);
  }

  // Sounds fire only on live transitions, never on page load or when a paused timer is shown.
  if (lastKind !== null) {
    const key = `${stage.team?.id}|${t.anchorAt}|${v.kind}`;
    if (lastKind === "pitch" && v.kind === "qa" && tuKey !== key) {
      tuKey = key;
      if (fx) { finale.timesUp("VAXT BİTDİ", "Sual-cavab başlayır", 3600); window.setTimeout(sToQa, 1300); } else sToQa();
    } else if (lastKind === "qa" && v.kind === "done" && tuKey !== key) {
      tuKey = key;
      if (fx) { finale.timesUp("SUAL-CAVAB BİTDİ", `Təşəkkürlər, ${stage.team?.name ?? "komanda"}!`, 7000); finalAlarm(true); } else finalAlarm();
    } else if (!fx && v.running && v.remaining !== lastRemaining && v.remaining > 0 && v.remaining <= 5) sTick();
  }
  if (finale.active && !finale.tu && !inLast) finale.exit();
  if (finale.shouldLeave || (finale.tu && (v.kind === "idle" || v.ready))) finale.exit();
  if (v.kind !== "done") clearInterval(alarmLoop);
  lastKind = v.kind;
  lastRemaining = v.remaining;
  renderButtons(v.running, v.kind, v.ready);
}

// ---------- admin control dock ----------
let btnSig = "";
function renderButtons(running: boolean, kind: PhaseKind, ready: boolean) {
  const hasTeam = !!stage?.team;
  const s = show();
  const sig = `${isAdmin}|${running}|${kind}|${ready}|${hasTeam}|${view}|${!!s?.pres}|${!!s?.site}|${muted}|${DEMO}`;
  if (sig === btnSig) return;
  btnSig = sig;
  const common = `
    <button class="tp-btn" data-act="sound" title="Səs (M)">${icon("sound")}<span>${muted ? "Səssiz" : "Səs"}</span></button>
    <button class="tp-btn" data-act="full" title="Tam ekran (F)" aria-label="Tam ekran">${icon("full")}</button>`;
  if (!isAdmin || DEMO) { el.btns.innerHTML = common; return; }
  const slideBtns = view === "pres" ? `
    <button class="tp-btn" data-act="prev" title="Əvvəlki slayd (←)" aria-label="Əvvəlki slayd">${icon("back")}</button>
    <button class="tp-btn" data-act="nextSlide" title="Növbəti slayd (→)" aria-label="Növbəti slayd">${icon("next")}</button>` : "";
  const modeBtn = hasTeam && (s?.pres || s?.site) ? `<button class="tp-btn" data-act="mode" title="Görünüş: prezentasiya / sayt / taymer">${icon("expand")}<span>${view === "pres" ? (s?.site ? "Sayt" : "Taymer") : view === "site" ? "Taymer" : s?.pres ? "Slaydlar" : "Sayt"}</span></button>` : "";
  el.btns.innerHTML = `
    <button class="tp-btn ${running ? "hold" : "go"}" data-act="toggle" ${kind === "idle" && !hasTeam ? "disabled" : ""} title="Başlat / fasilə (Space)">
      ${running ? `${icon("pause")}<span>Fasilə</span>` : `${icon("play")}<span>${ready || kind === "idle" || kind === "done" ? "Başlat" : "Davam"}</span>`}</button>
    <button class="tp-btn qa" data-act="qa" ${hasTeam ? "" : "disabled"} title="Dərhal sual-cavab mərhələsinə keç (S)">${icon("skip")}<span>Sual-cavab</span></button>
    <button class="tp-btn" data-act="reset" ${kind === "idle" ? "disabled" : ""} title="Sıfırla (R)">${icon("reset")}<span>Sıfırla</span></button>
    <button class="tp-btn" data-act="next" title="Növbəti komanda (N)">${icon("next")}<span>Növbəti</span></button>
    ${slideBtns}${modeBtn}
    <button class="tp-btn" data-act="intro" ${hasTeam ? "" : "disabled"} title="Komandanın intro ekranı">${icon("sparkle")}<span>Intro</span></button>
    ${common}`;
}

async function stagePatch(b: Record<string, unknown>) {
  const r = await api<{ stage: StagePayload }>("/api/admin/stage", { method: "PATCH", body: b });
  onStage(r.stage);
}

async function act(a: string) {
  if (a === "sound") { ensureAudio(); if (muted) toggleMute(); else { sTest(); toast("Səs siqnalı aktivdir"); } return; }
  if (a === "full") { toggleFull(); return; }
  if (DEMO) return;
  if (!isAdmin) return;
  ensureAudio();
  try {
    if (a === "prev" || a === "nextSlide") { slideBy(a === "prev" ? -1 : 1); return; }
    if (a === "intro") { await stagePatch({ intro: true }); return; }
    if (a === "mode") {
      const s = show();
      const next = view === "pres" ? (s?.site ? "site" : "timer") : view === "site" ? "timer" : s?.pres ? "auto" : "site";
      await stagePatch({ mode: next });
      return;
    }
    if (a === "next") {
      const r = await api<{ stage: StagePayload }>("/api/admin/event/next", { method: "POST" });
      onStage(r.stage);
      toast(r.stage.team ? `Yeni: ${r.stage.team.name}` : "Səhnə boşdur");
      return;
    }
    if (a === "plus" || a === "minus") {
      const r = await api<{ stage: StagePayload }>("/api/admin/event", { method: "PATCH", body: { timerAdd: a === "plus" ? 30 : -30 } });
      onStage(r.stage);
      toast(a === "plus" ? "+30 saniyə" : "−30 saniyə");
      return;
    }
    let action = a as TimerAction;
    // Starting from "idle" (hidden timer) begins the pitch.
    if (a === "toggle" && stage && !stage.timer.visible) action = "pitch";
    const r = await api<{ stage: StagePayload }>("/api/admin/event", { method: "PATCH", body: { timer: action } });
    onStage(r.stage);
  } catch (e) { toast((e as ApiError).message); }
}

/** Optimistic: this screen turns the page at once; the server then moves every other stage screen. */
function slideBy(d: number) {
  const s = show();
  if (!stage || !s || view !== "pres" || !deck.ready) return;
  const n = Math.max(1, Math.min(deck.pages, (deck.shown || s.slide) + d));
  if (n === deck.shown) return;
  s.slide = n;
  void deck.show(n, d).then(paintHud);
  if (DEMO) return;
  if (isAdmin) stagePatch({ slide: n }).catch(e => toast((e as ApiError).message));
}

function toggleFull() {
  try {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => toast("Tam ekran rejimi məhdudlaşdırılıb"));
    else void document.exitFullscreen();
  } catch { toast("Tam ekran dəstəklənmir"); }
}

el.btns.addEventListener("click", e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
  if (b && !b.disabled) void act(b.dataset.act!);
});
document.addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "f") { toggleFull(); return; }
  if (k === "m") { ensureAudio(); toggleMute(); return; }
  // slides: arrows and presentation clickers (PageUp / PageDown)
  if (["arrowright", "pagedown", "arrowdown"].includes(k)) { if (isAdmin || DEMO) { e.preventDefault(); slideBy(1); } return; }
  if (["arrowleft", "pageup", "arrowup"].includes(k)) { if (isAdmin || DEMO) { e.preventDefault(); slideBy(-1); } return; }
  if (DEMO) { if (e.code === "Space") { e.preventDefault(); demoCmd("toggle"); } return; }
  if (!isAdmin) return;
  if (e.code === "Space") { e.preventDefault(); void act("toggle"); }
  else if (k === "s" || k === "q") void act("qa");
  else if (k === "r") void act("reset");
  else if (k === "n") void act("next");
  else if (k === "+" || k === "=") void act("plus");
  else if (k === "-" || k === "_") void act("minus");
});
// swipe on touch screens
{
  let sx: number | null = null, sy = 0;
  el.view.addEventListener("pointerdown", e => { sx = e.clientX; sy = e.clientY; });
  el.view.addEventListener("pointerup", e => {
    if (sx == null) return; const dx = e.clientX - sx, dy = e.clientY - sy; sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) && (isAdmin || DEMO)) slideBy(dx < 0 ? 1 : -1);
  });
}

// Hide the dock and the HUD after a few idle seconds so the projector shows only the stage.
let idleT = 0;
function wakeDock() {
  el.dock.classList.remove("idle");
  body.classList.remove("idle-ui");
  clearTimeout(idleT);
  idleT = window.setTimeout(() => { el.dock.classList.add("idle"); body.classList.add("idle-ui"); }, 4000);
}
["mousemove", "touchstart", "keydown"].forEach(ev => document.addEventListener(ev, wakeDock, { passive: true }));
wakeDock();

// ---------- dial motion: tilt towards the cursor; spin on its own while the cursor is over it ----------
const core = $("#core");
const dial = $("#dial");
const motion = { tx: 0, ty: 0, x: 0, y: 0, inside: false, hover: 0, phase: 0, spin: 0, vel: 0, last: 0 };
if (!reduced) {
  window.addEventListener("mousemove", e => {
    const r = dial.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    motion.tx = (cx - e.clientX) / 28;
    motion.ty = (e.clientY - cy) / 28;
    motion.inside = view === "dial" && Math.hypot(e.clientX - cx, e.clientY - cy) < r.width / 2;
  });
  document.addEventListener("mouseleave", () => { motion.inside = false; motion.tx = motion.ty = 0; });
}
function dialMotion(t: number) {
  const m = motion;
  const dt = m.last ? Math.min(0.1, (t - m.last) / 1000) : 0;
  m.last = t;
  m.hover += ((m.inside ? 1 : 0) - m.hover) * Math.min(1, dt * 3);
  m.phase += dt * 1.2 * m.hover;
  if (m.inside) {
    m.vel += (70 - m.vel) * Math.min(1, dt * 1.5);
    m.spin += m.vel * dt;
  } else {
    m.vel = 0;
    const target = Math.ceil(m.spin / 360 - 1e-3) * 360;
    m.spin += (target - m.spin) * Math.min(1, dt * 2.5);
    if (Math.abs(target - m.spin) < 0.05) m.spin = 0;
  }
  m.x += (m.tx - m.x) * Math.min(1, dt * 8);
  m.y += (m.ty - m.y) * Math.min(1, dt * 8);
  const ry = m.x * (1 - m.hover) + Math.sin(m.phase) * 18 * m.hover;
  const rx = m.y * (1 - m.hover) + Math.cos(m.phase * 0.8) * 12 * m.hover;
  core.style.transform = `rotateY(${ry.toFixed(2)}deg) rotateX(${rx.toFixed(2)}deg) rotateZ(${m.spin.toFixed(2)}deg)`;
  body.classList.toggle("spinning", m.hover > 0.5);
}
const canvas = $<HTMLCanvasElement>("#warp");
const ctx = canvas.getContext("2d")!;
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rgb = (hex: string) => { const h = hex.replace("#", ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(", "); };
const PITCH_RGB = rgb(cssVar("--tp-pitch") || "#8B6DFF");
const QA_RGB = rgb(cssVar("--tp-qa") || "#2EE59D");
let W = 0, H = 0;
const resize = () => { W = canvas.width = innerWidth; H = canvas.height = innerHeight; };
addEventListener("resize", resize);
resize();
const parts = Array.from({ length: 130 }, () => ({ x: (Math.random() - 0.5) * 1600, y: (Math.random() - 0.5) * 1600, z: Math.random() * 1000 + 1, s: Math.random() * 2 + 0.8 }));
function warp() {
  if (view !== "dial") return;
  ctx.clearRect(0, 0, W, H);
  const kind = lastKind ?? "idle";
  const running = body.classList.contains("paused") ? 0.25 : 1;
  const speed = (kind === "done" ? 14 : kind === "qa" ? 7.5 : 2.4) * running;
  const color = kind === "pitch" || kind === "idle" ? PITCH_RGB : QA_RGB;
  const cx = W / 2, cy = H / 2;
  for (const p of parts) {
    p.z -= speed;
    if (p.z <= 2) { p.x = (Math.random() - 0.5) * 1600; p.y = (Math.random() - 0.5) * 1600; p.z = 1000; }
    const sc = 520 / p.z, ps = 520 / (p.z + speed * 3.5);
    ctx.beginPath();
    ctx.moveTo(cx + p.x * ps, cy + p.y * ps);
    ctx.lineTo(cx + p.x * sc, cy + p.y * sc);
    ctx.strokeStyle = `rgba(${color}, ${Math.min(1, (1000 - p.z) / 600) * 0.65})`;
    ctx.lineWidth = p.s * sc * 0.45;
    ctx.lineCap = "round";
    ctx.stroke();
  }
}

// one animation loop for everything
let lastT = performance.now();
function frame(t: number) {
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;
  if (DEMO) demoStep();
  tick();
  if (!reduced) { dialMotion(t); warp(); }
  finale.step(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(() => { if (document.hidden) tick(); }, 500);

// ---------- data ----------
function onStage(s: StagePayload) {
  if (!DEMO) syncClock(s.serverNow);
  const prevTeam = stage?.team?.id;
  stage = s;
  if (prevTeam !== s.team?.id) presFailed = null;
  setTeam();
  applyView();
  tick();
}

async function load() {
  try { onStage(await api<StagePayload>("/api/stage")); } catch { toast("Serverə qoşulmaq mümkün olmadı"); }
}

// ---------- demo (/stage/demo): a local timer and the sample deck, no login ----------
const DEMO_SEC = Math.max(6, Math.min(600, Number(qs.get("t")) || 15));
function demoCmd(a: string) {
  if (!stage) return;
  const t = now();
  const s = stage.show;
  let timer = stage.timer;
  const v = timerView(timer, t);
  switch (a) {
    case "toggle": timer = applyTimerAction(timer, !timer.visible ? "pitch" : v.kind === "done" ? "pitch" : "toggle", t); if (s.mode === "timer") s.mode = "auto"; break;
    case "reset": timer = applyTimerAction(timer, "reset", t); break;
    case "last": {
      if (!timer.visible || v.kind === "done") timer = applyTimerAction(timer, "pitch", t);
      timer = adjustTimer(timer, t, { setRemaining: 7 });
      if (!timer.running) timer = applyTimerAction(timer, "resume", t);
      break;
    }
    case "prev": slideBy(-1); return;
    case "next": slideBy(1); return;
    case "intro": s.introAt = t; break;
    case "site": s.mode = "site"; break;
    case "pdf": s.mode = "auto"; break;
    case "timer": s.mode = "timer"; break;
  }
  onStage({ ...stage, timer, show: { ...s }, serverNow: Date.now() });
  syncDemoBar();
}
function demoStep() { syncDemoBar(); }
let demoSig = "";
function syncDemoBar() {
  if (!stage) return;
  const v = timerView(stage.timer, now());
  const label = v.running ? "Fasilə" : v.kind === "done" ? "Yenidən" : !stage.timer.visible || v.ready ? "Başla" : "Davam";
  if (label === demoSig) return;
  demoSig = label;
  const b = el.demo.querySelector<HTMLButtonElement>("[data-d=toggle]");
  if (b) b.textContent = label;
}

if (DEMO) {
  document.title = "Səhnə demosu · munsif.im";
  el.demo.hidden = false;
  el.demo.addEventListener("click", e => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-d]"); if (b) { ensureAudio(); demoCmd(b.dataset.d!); } });
  onStage({
    eventName: "munsif.im Demo Day", eventDate: "",
    team: { id: 1, name: "Komanda Nümunə", project: "munsif.im — səhnə taymeri demosu", index: 1, total: 3 },
    timer: { visible: true, running: false, offsetSec: 0, anchorAt: null, pitchSec: DEMO_SEC, qaSec: Math.max(6, Math.round(DEMO_SEC * 2 / 3)) },
    serverNow: Date.now(),
    show: {
      mode: "auto", slide: 1, introAt: null, pres: { fileId: 0, url: "/demo/munsif-demo.pdf", pages: null }, presPending: null,
      site: { url: "https://munsif.im", embeddable: false }, logo: null, members: ["Aysel M.", "Rəşad Q.", "Nigar H."], next: { name: "Növbəti komanda", project: "" },
    },
  });
  (window as unknown as { __munsif: unknown }).__munsif = { demo: demoCmd, beat: () => finale.n, particles: () => finale.particles, lite: () => finale.lite, view: () => view, slide: () => deck.shown };
} else {
  live({
    role: "admin", // falls back to the public room when this browser has no admin session
    on: {
      "stage:changed": onStage,
      "timer:changed": (p: { timer: TimerState; serverNow: number }) => {
        if (!stage) return;
        syncClock(p.serverNow);
        stage = { ...stage, timer: p.timer };
        tick();
      },
      "config:changed": load,
    },
    resync: load,
    status: online => { if (!online) toast("Bağlantı kəsildi — yenidən qoşulur…"); },
  });
  api<{ admin: boolean }>("/api/auth/session").then(me => {
    isAdmin = me.admin;
    el.keys.hidden = !isAdmin;
    btnSig = "";
    tick();
  }).catch(() => { /* anonymous viewer */ });
  load();
  (window as unknown as { __munsif: unknown }).__munsif = { beat: () => finale.n, particles: () => finale.particles, view: () => view, slide: () => deck.shown, stage: () => stage };
}
renderButtons(false, "idle", false);
