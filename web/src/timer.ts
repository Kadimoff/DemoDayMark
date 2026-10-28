// Projector screen: the 4D Pitch Deck timer, now a view of the server's shared timer.
// Anyone can watch it; only a logged-in admin gets the control dock and keyboard shortcuts.
import "./styles.css";
import { timerView, type PhaseKind } from "../../shared/timer";
import type { StagePayload, TimerAction, TimerState } from "../../shared/types";
import { api, ApiError } from "./lib/api";
import { now, syncClock } from "./lib/clock";
import { $, esc, icon, reducedMotion } from "./lib/dom";
import { live } from "./lib/socket";

const CIRC = 2 * Math.PI * 176;
const body = document.body;
const el = {
  event: $("#event"), name: $("#name"), nameTeam: $("#nameTeam"), nameProj: $("#nameProj"), banner: $("#banner"), rim: $("#rimText"), badge: $("#badge"),
  digits: $("#digits"), sub: $("#subtext"), ring: $("#ring"), barP: $("#barPitch"), barQ: $("#barQa"),
  pillP: $("#pillPitch"), pillQ: $("#pillQa"), btns: $("#btns"), toast: $("#tpToast"), keys: $("#keys"), dock: $("#dock"),
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
function ensureAudio() {
  if (!audio) audio = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  if (audio.state === "suspended") audio.resume();
  return audio;
}
["click", "touchstart", "keydown"].forEach(ev => document.addEventListener(ev, () => { try { ensureAudio(); } catch { /* no audio */ } }, { once: true }));
function notes(list: Array<{ f: number; d: number; t: number; type?: OscillatorType; v?: number }>) {
  try {
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
function finalAlarm() {
  sAlarm();
  let n = 0;
  clearInterval(alarmLoop);
  alarmLoop = window.setInterval(() => { if (++n >= 3) clearInterval(alarmLoop); else sAlarm(); }, 1500);
}

// ---------- rendering ----------
function setTeam() {
  const t = stage?.team;
  el.event.innerHTML = `${esc(stage?.eventName || "Ignite Demo Day")}${t ? `<span class="ix">${t.index}/${t.total}</span>` : ""}`;
  const key = t ? `${t.id}|${t.name}|${t.project}|${t.index}` : "";
  if (key === lastTeamKey) return;
  el.nameTeam.innerHTML = t ? `<span class="ix">#${t.index}</span>${esc(t.name)}` : "Komanda seçilməyib";
  el.nameTeam.classList.toggle("empty", !t);
  el.nameProj.textContent = t?.project ?? "";
  if (lastTeamKey || t) {
    el.name.classList.remove("swap");
    void el.name.offsetWidth;
    el.name.classList.add("swap");
  }
  lastTeamKey = key;
  document.title = t ? `${t.name} · Pitch taymeri` : "Pitch taymeri · Ignite Demo Day";
}

function visuals(kind: PhaseKind, timer: TimerState, ready: boolean) {
  const sig = `${kind}|${timer.pitchSec}|${timer.qaSec}|${ready}`;
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
    el.banner.textContent = kind === "idle" ? "GÖZLƏMƏDƏ • IGNITE DEMO DAY" : `HAZIR • TƏQDİMAT ${minutes(P)}`;
    el.rim.textContent = ` • IGNITE DEMO DAY • ${minutes(P)} TƏQDİMAT + ${minutes(Q)} SUAL-CAVAB • IGNITE DEMO DAY • UĞURLAR! `;
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

  // Sounds fire only on live transitions, never on page load or when a paused timer is shown.
  if (lastKind !== null) {
    if (lastKind === "pitch" && v.kind === "qa") sToQa();
    else if (lastKind === "qa" && v.kind === "done") finalAlarm();
    else if (v.running && v.remaining !== lastRemaining && v.remaining > 0 && v.remaining <= 5) sTick();
  }
  if (v.kind !== "done") clearInterval(alarmLoop);
  lastKind = v.kind;
  lastRemaining = v.remaining;
  renderButtons(v.running, v.kind, v.ready);
}

// ---------- admin control dock ----------
let btnSig = "";
function renderButtons(running: boolean, kind: PhaseKind, ready: boolean) {
  const hasTeam = !!stage?.team;
  const sig = `${isAdmin}|${running}|${kind}|${ready}|${hasTeam}`;
  if (sig === btnSig) return;
  btnSig = sig;
  const common = `
    <button class="tp-btn" data-act="sound" title="Səs siqnalını yoxla">${icon("sound")}<span>Səs</span></button>
    <button class="tp-btn" data-act="full" title="Tam ekran (F)" aria-label="Tam ekran">${icon("full")}</button>`;
  if (!isAdmin) { el.btns.innerHTML = common; return; }
  el.btns.innerHTML = `
    <button class="tp-btn ${running ? "hold" : "go"}" data-act="toggle" ${kind === "idle" && !hasTeam ? "disabled" : ""} title="Başlat / fasilə (Space)">
      ${running ? `${icon("pause")}<span>Fasilə</span>` : `${icon("play")}<span>${ready || kind === "idle" || kind === "done" ? "Başlat" : "Davam"}</span>`}</button>
    <button class="tp-btn qa" data-act="qa" ${hasTeam ? "" : "disabled"} title="Dərhal sual-cavab mərhələsinə keç (S)">${icon("skip")}<span>Sual-cavab</span></button>
    <button class="tp-btn" data-act="reset" ${kind === "idle" ? "disabled" : ""} title="Sıfırla (R)">${icon("reset")}<span>Sıfırla</span></button>
    <button class="tp-btn" data-act="next" title="Növbəti komanda (N)">${icon("next")}<span>Növbəti</span></button>
    ${common}`;
}

async function act(a: string) {
  if (a === "sound") { ensureAudio(); sTest(); toast("Səs siqnalı aktivdir"); return; }
  if (a === "full") { toggleFull(); return; }
  if (!isAdmin) return;
  ensureAudio();
  try {
    if (a === "next") {
      const r = await api<{ stage: StagePayload }>("/api/admin/event/next", { method: "POST" });
      onStage(r.stage);
      toast(r.stage.team ? `Yeni: ${r.stage.team.name}` : "Səhnə boşdur");
      return;
    }
    let action = a as TimerAction;
    // Starting from "idle" (hidden timer) begins the pitch.
    if (a === "toggle" && stage && !stage.timer.visible) action = "pitch";
    const r = await api<{ stage: StagePayload }>("/api/admin/event", { method: "PATCH", body: { timer: action } });
    onStage(r.stage);
  } catch (e) { toast((e as ApiError).message); }
}

function toggleFull() {
  try {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => toast("Tam ekran rejimi məhdudlaşdırılıb"));
    else document.exitFullscreen();
  } catch { toast("Tam ekran dəstəklənmir"); }
}

el.btns.addEventListener("click", e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
  if (b && !b.disabled) act(b.dataset.act!);
});
document.addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "f") { toggleFull(); return; }
  if (!isAdmin) return;
  if (e.code === "Space") { e.preventDefault(); act("toggle"); }
  else if (k === "s" || k === "q") act("qa");
  else if (k === "r") act("reset");
  else if (k === "n") act("next");
});

// Hide the dock after a few idle seconds so the projector shows only the timer.
let idleT = 0;
function wakeDock() {
  el.dock.classList.remove("idle");
  clearTimeout(idleT);
  idleT = window.setTimeout(() => el.dock.classList.add("idle"), 4000);
}
["mousemove", "touchstart", "keydown"].forEach(ev => document.addEventListener(ev, wakeDock, { passive: true }));
wakeDock();

// ---------- dial motion: tilt towards the cursor; spin on its own while the cursor is over it ----------
const core = $("#core");
const dial = $("#dial");
const motion = { tx: 0, ty: 0, x: 0, y: 0, inside: false, hover: 0, phase: 0, spin: 0, vel: 0, last: 0 };
if (!reducedMotion()) {
  window.addEventListener("mousemove", e => {
    const r = dial.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    motion.tx = (cx - e.clientX) / 28;
    motion.ty = (e.clientY - cy) / 28;
    // Hit-test against the circle, not the rotating element, so the spin never flickers on/off.
    motion.inside = Math.hypot(e.clientX - cx, e.clientY - cy) < r.width / 2;
  });
  document.addEventListener("mouseleave", () => { motion.inside = false; motion.tx = motion.ty = 0; });
  const step = (t: number) => {
    const m = motion;
    const dt = m.last ? Math.min(0.1, (t - m.last) / 1000) : 0;
    m.last = t;
    m.hover += ((m.inside ? 1 : 0) - m.hover) * Math.min(1, dt * 3);
    m.phase += dt * 1.2 * m.hover;
    if (m.inside) {
      m.vel += (70 - m.vel) * Math.min(1, dt * 1.5); // ease up to 70°/s
      m.spin += m.vel * dt;
    } else {
      // Glide forward to the next full turn and stop there, never spinning backwards.
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
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const canvas = $<HTMLCanvasElement>("#warp");
const ctx = canvas.getContext("2d")!;
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const rgb = (hex: string) => { const h = hex.replace("#", ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(", "); };
const PITCH_RGB = rgb(cssVar("--tp-pitch") || "#22D3EE");
const QA_RGB = rgb(cssVar("--tp-qa-soft") || "#FCA5A5");
let W = 0, H = 0;
const resize = () => { W = canvas.width = innerWidth; H = canvas.height = innerHeight; };
addEventListener("resize", resize);
resize();
const parts = Array.from({ length: 130 }, () => ({ x: (Math.random() - 0.5) * 1600, y: (Math.random() - 0.5) * 1600, z: Math.random() * 1000 + 1, s: Math.random() * 2 + 0.8 }));
function frame() {
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
  requestAnimationFrame(frame);
}
if (!reducedMotion()) frame();

// ---------- data ----------
function onStage(s: StagePayload) {
  syncClock(s.serverNow);
  stage = s;
  setTeam();
  tick();
}

async function load() {
  try { onStage(await api<StagePayload>("/api/stage")); } catch { toast("Serverə qoşulmaq mümkün olmadı"); }
}

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

api<{ role: string }>("/api/auth/me?role=admin").then(me => {
  isAdmin = me.role === "admin";
  el.keys.hidden = !isAdmin;
  btnSig = "";
  tick();
}).catch(() => { /* anonymous viewer */ });

setInterval(tick, 200);
renderButtons(false, "idle", false);
load();
