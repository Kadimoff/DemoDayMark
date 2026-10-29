// Projector results screen. It only ever receives places the admin has already revealed
// (server: shared/reveal.ts), so nothing can leak ahead of the ceremony.
import "./styles.css";
import { ordinal, type RevealPublic, type RevealedEntry } from "../../shared/reveal";
import { api, ApiError } from "./lib/api";
import { $, esc, icon, reducedMotion } from "./lib/dom";
import { FX, rgb } from "./lib/fx";
import { live } from "./lib/socket";

interface AdminReveal { enabled: boolean; step: number; stepsTotal: number; next: { kind: "suspense" | "reveal"; entry: { rank: number } } | null }

const main = $("#main");
const overlay = $("#overlay");
const el = {
  ev: $("#ev"), title: $("#title"), ovPlace: $("#ovPlace"), ovName: $("#ovName"), ovProj: $("#ovProj"), ovScore: $("#ovScore"),
  ovHint: $("#ovHint"), btns: $("#btns"), keys: $("#keys"), toast: $("#toast"), dock: $("#dock"),
};
const calm = reducedMotion();

let state: RevealPublic | null = null;
let boardTotal = -1;
let isAdmin = false;
let ceremony = 0; // bumps on every state change so stale timeouts never touch a newer screen

// ---------- sound (Web Audio; unlocked by the first click/key on the projector) ----------
let audio: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let muted = false;
const ctx = () => {
  if (!audio) {
    audio = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    // One bus through a compressor so stacked fanfare + booms never clip the projector speakers.
    const comp = audio.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.25;
    master = audio.createGain();
    master.gain.value = 0.9;
    master.connect(comp).connect(audio.destination);
    noiseBuf = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  }
  if (audio.state === "suspended") audio.resume();
  return audio;
};
["click", "keydown", "touchstart"].forEach(e => document.addEventListener(e, () => { try { ctx(); hint(); } catch { /* no audio */ } }, { once: true }));
function tone(freq: number, at: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
  if (muted) return;
  try {
    const a = ctx();
    if (a.state !== "running") return;
    const t = a.currentTime + at, o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master!);
    o.start(t);
    o.stop(t + dur + 0.03);
  } catch { /* audio unavailable */ }
}
/** Filtered white noise: risers, booms, firework crackle. */
function noise(at: number, dur: number, vol: number, type: BiquadFilterType, from: number, to = from, peak = 0.02) {
  if (muted) return;
  try {
    const a = ctx();
    if (a.state !== "running" || !noiseBuf) return;
    const t = a.currentTime + at, src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = noiseBuf;
    f.type = type;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.max(0.005, peak));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master!);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  } catch { /* audio unavailable */ }
}
/** Brass-like chord: detuned saws through an opening low-pass filter. */
function brass(freqs: number[], at: number, dur: number, vol: number) {
  if (muted) return;
  try {
    const a = ctx();
    if (a.state !== "running") return;
    const t = a.currentTime + at;
    for (const f0 of freqs) for (const det of [-6, 6]) {
      const o = a.createOscillator(), lp = a.createBiquadFilter(), g = a.createGain();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(f0, t);
      o.detune.setValueAtTime(det, t);
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(500, t);
      lp.frequency.exponentialRampToValueAtTime(3200, t + 0.08);
      lp.frequency.exponentialRampToValueAtTime(1400, t + Math.min(dur, 0.6));
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol / freqs.length, t + 0.04);
      g.gain.setValueAtTime(vol / freqs.length * 0.8, t + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(lp).connect(g).connect(master!);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  } catch { /* audio unavailable */ }
}
const sound = {
  // "lub-dub": two low thumps
  beat: () => { tone(62, 0, 0.2, "sine", 0.9, 38); tone(55, 0.19, 0.18, "sine", 0.6, 34); },
  reveal: () => { tone(523.25, 0, 0.18, "triangle", 0.25); tone(783.99, 0.1, 0.35, "triangle", 0.22); },
  podium: () => [523.25, 659.25, 783.99].forEach((f, i) => tone(f, i * 0.12, 0.9, "triangle", 0.28)),
  /** Tension before the ignition. */
  riser: () => { noise(0, 0.95, 0.28, "bandpass", 300, 5000, 0.9); tone(160, 0, 0.95, "sine", 0.12, 880); },
  boom: () => {
    tone(72, 0, 1.6, "sine", 1, 26);
    tone(144, 0, 0.3, "triangle", 0.35, 60);
    noise(0, 0.7, 0.55, "lowpass", 1400, 90, 0.005);
  },
  shimmer: () => [1567.98, 2093, 2637.02, 3135.96].forEach((f, i) => tone(f, 0.05 + i * 0.05, 2.2, "sine", 0.05)),
  fanfare: () => {
    const C = [261.63, 329.63, 392, 523.25], F = [349.23, 440, 523.25, 698.46], G = [392, 493.88, 587.33, 783.99];
    brass(C, 0, 0.42, 0.5); brass(C, 0.46, 0.16, 0.45); brass(F, 0.66, 0.42, 0.5); brass(G, 1.12, 0.42, 0.52);
    brass([...C, 659.25], 1.6, 2.8, 0.6);
    [0, 0.66, 1.12, 1.6, 1.72].forEach((t, i) => tone(i < 3 ? 98 : 65.41, t, 0.6, "sine", 0.65, 50));
  },
  crackle: () => {
    tone(115, 0, 0.35, "sine", 0.45, 38);
    noise(0, 0.6, 0.3, "highpass", 1800, 4500, 0.005);
    for (let i = 0; i < 9; i++) noise(0.25 + Math.random() * 0.9, 0.035, 0.18, "highpass", 4000);
  },
};

// ---------- heartbeat: accelerates the longer the room waits ----------
let beatTimer = 0, beatStart = 0;
function startBeats() {
  stopBeats();
  beatStart = performance.now();
  const loop = () => {
    const t = (performance.now() - beatStart) / 1000;
    overlay.classList.remove("beat");
    void overlay.offsetWidth;
    overlay.classList.add("beat");
    sound.beat();
    beatTimer = window.setTimeout(loop, Math.max(560, 1050 - t * 28));
  };
  loop();
}
function stopBeats() { clearTimeout(beatTimer); overlay.classList.remove("beat"); }

// ---------- helpers ----------
const medal = (rank: number) => (rank === 1 ? "gold" : rank === 2 ? "silver" : rank === 3 ? "bronze" : "");
function countUp(node: HTMLElement, to: number, ms: number) {
  if (calm) { node.textContent = to.toFixed(1); return; }
  const t0 = performance.now(), my = ceremony;
  const step = (t: number) => {
    if (my !== ceremony) { node.textContent = to.toFixed(1); return; }
    const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
    node.textContent = (to * e).toFixed(1);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
/** Shrinks a heading until its longest word fits its box (never breaks inside a word). */
function fit(node: HTMLElement, min = 14) {
  node.style.fontSize = "";
  let size = parseFloat(getComputedStyle(node).fontSize);
  while (node.scrollWidth > node.clientWidth + 1 && size > min) {
    size -= 2;
    node.style.fontSize = `${size}px`;
  }
}
const fitAll = () => main.querySelectorAll<HTMLElement>(".rv-pod.on .nm").forEach(n => fit(n));
addEventListener("resize", () => { fitAll(); if (!overlay.hidden) fit(el.ovName, 24); });

let toastT = 0;
function toast(t: string) {
  el.toast.textContent = t;
  el.toast.hidden = false;
  clearTimeout(toastT);
  toastT = window.setTimeout(() => { el.toast.hidden = true; }, 2800);
}
function hint() {
  const needs = !!state?.enabled && (!audio || audio.state !== "running") && !muted;
  if (needs) toast("Səs üçün ekrana bir dəfə toxunun");
}

// ---------- board ----------
function waiting() {
  boardTotal = -1;
  stopBeats();
  overlay.hidden = true;
  el.title.textContent = "Nəticələr";
  main.innerHTML = `<div class="rv-wait"><div class="rv-wait-ring"></div><h1>Nəticələr</h1><p>Münsiflərin qərarı tezliklə açıqlanacaq</p></div>`;
}

function buildBoard(total: number) {
  boardTotal = total;
  const pod = [1, 0, 2].filter(i => i < total);
  const rest = Array.from({ length: Math.max(0, total - 3) }, (_, k) => k + 3);
  main.innerHTML = `<div class="rv-board${rest.length ? "" : " solo"}">
    ${rest.length ? `<section class="rv-list" aria-label="${ordinal(4)}–${ordinal(total)} yerlər">${rest.map(i => `
      <div class="rv-row" data-slot="${i}"><span class="rk">${i + 1}</span>
        <div class="nm"><b>?</b><small></small><div class="bar"><i></i></div></div><span class="sc mono"></span></div>`).join("")}
    </section>` : ""}
    <section class="rv-podium" aria-label="İlk üçlük">${pod.map(i => `
      <div class="rv-pod p${i}" data-slot="${i}">
        <div class="rv-card"><span class="medal">${ordinal(i + 1)} yer</span><b class="nm">?</b><small class="pj"></small><span class="sc mono"></span></div>
        <div class="rv-pillar"><span>${i + 1}</span></div>
      </div>`).join("")}
    </section></div>`;
}

function fillSlot(e: RevealedEntry, animate: boolean) {
  const slot = main.querySelector<HTMLElement>(`[data-slot="${e.index}"]`);
  if (!slot) return;
  slot.classList.add("on");
  slot.classList.remove("gold", "silver", "bronze");
  if (medal(e.rank)) slot.classList.add(medal(e.rank));
  const sc = slot.querySelector<HTMLElement>(".sc")!;
  if (slot.classList.contains("rv-row")) {
    slot.querySelector(".rk")!.textContent = String(e.rank);
    slot.querySelector(".nm b")!.textContent = e.name;
    slot.querySelector(".nm small")!.textContent = e.project;
    slot.querySelector<HTMLElement>(".bar i")!.style.width = `${e.avg}%`;
  } else {
    slot.querySelector(".medal")!.textContent = `${ordinal(e.rank)} yer`;
    slot.querySelector(".nm")!.textContent = e.name;
    slot.querySelector(".pj")!.textContent = e.project;
    fit(slot.querySelector<HTMLElement>(".nm")!);
  }
  if (animate && !calm) {
    slot.classList.remove("enter");
    void slot.offsetWidth;
    slot.classList.add("enter");
    countUp(sc, e.avg, 1300);
  } else sc.textContent = e.avg.toFixed(1);
}

function clearSlot(index: number) {
  const slot = main.querySelector<HTMLElement>(`[data-slot="${index}"]`);
  if (!slot || !slot.classList.contains("on")) return;
  slot.classList.remove("on", "enter", "gold", "silver", "bronze");
  slot.querySelectorAll<HTMLElement>(".nm b, b.nm").forEach(n => { n.textContent = "?"; n.style.fontSize = ""; });
  slot.querySelectorAll("small").forEach(n => { n.textContent = ""; });
  slot.querySelector<HTMLElement>(".sc")!.textContent = "";
  const bar = slot.querySelector<HTMLElement>(".bar i");
  if (bar) bar.style.width = "0";
  const rk = slot.querySelector(".rk");
  if (rk) rk.textContent = String(index + 1);
}

// ---------- overlay ----------
function showSuspense(rank: number) {
  overlay.hidden = false;
  overlay.className = "rv-overlay suspense";
  el.ovPlace.textContent = `${ordinal(rank)} yer`;
  el.ovName.textContent = "";
  el.ovProj.textContent = "";
  el.ovScore.textContent = "";
  el.ovHint.textContent = rank === 1 ? "Qalib kimdir?" : "Kim olacaq?";
  if (!calm) startBeats();
}

function ceremonyReveal(e: RevealedEntry) {
  if (e.rank === 1 && e.index === 0) { winnerScene(e); return; }
  const my = ceremony;
  stopBeats();
  overlay.hidden = false;
  overlay.className = `rv-overlay revealed ${medal(e.rank)}`;
  el.ovPlace.textContent = `${ordinal(e.rank)} yer`;
  el.ovName.textContent = e.name;
  el.ovProj.textContent = e.project;
  el.ovScore.textContent = "0.0";
  el.ovHint.textContent = e.rank === 1 ? "Təbriklər!" : "";
  fit(el.ovName, 24);
  countUp(el.ovScore, e.avg, 1600);
  sound.podium();
  // Hand the stage back to the podium after the moment has landed.
  window.setTimeout(() => {
    if (my !== ceremony) return;
    overlay.classList.add("leaving");
    window.setTimeout(() => {
      if (my !== ceremony) return;
      overlay.hidden = true;
      fillSlot(e, true);
    }, calm ? 0 : 700);
  }, 4500);
}

// ---------- apply server state ----------
let lastSig = "";
function apply(next: RevealPublic) {
  // The same state can arrive twice (API response + socket echo); re-applying would cut a running scene.
  const sig = JSON.stringify([next.enabled, next.eventName, next.step, next.total, next.stepsTotal, next.revealed.map(r => r.teamId)]);
  if (sig === lastSig) return;
  lastSig = sig;
  const prev = state;
  state = next;
  ceremony++;
  stopWinner();
  fxFront.embers(0, []);
  el.ev.textContent = next.eventName || "Demo Day";
  if (!next.enabled) { waiting(); renderButtons(); return; }
  if (boardTotal !== next.total) buildBoard(next.total);
  el.title.textContent = next.done ? "Qaliblər" : "Nəticələr";

  const live = !!prev?.enabled && next.step === prev.step + 1 && !!next.last;
  const fresh = live && next.last!.kind === "reveal" ? next.last!.index : -1;
  // A top-three reveal arrives right after its suspense step.
  const special = fresh >= 0 && prev!.suspense?.index === fresh;
  const shown = new Set(next.revealed.map(e => e.index));
  for (let i = 0; i < next.total; i++) if (!shown.has(i)) clearSlot(i);
  for (const e of next.revealed) {
    if (e.index === fresh && special) continue; // filled when the ceremony hands over
    fillSlot(e, e.index === fresh);
  }
  if (fresh >= 0 && !special) sound.reveal();

  if (next.suspense) {
    if (!(prev?.suspense && prev.suspense.index === next.suspense.index && !overlay.hidden)) showSuspense(next.suspense.rank);
  } else if (special) {
    ceremonyReveal(next.revealed.find(e => e.index === fresh)!);
  } else {
    stopBeats();
    overlay.hidden = true;
  }
  main.querySelectorAll(".rv-pod.p0").forEach(p => p.classList.toggle("champion", next.done));
  ambient();
  renderButtons();
}

// ---------- particles ----------
const tok = (v: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fb;
const C = { gold: rgb(tok("--rv-gold", "#F1C24D")), ember: rgb(tok("--rv-ember", "#FF6F36")), ink: rgb(tok("--rv-ink", "#F3F4F8")), silver: rgb(tok("--rv-silver", "#D3DAE6")), bronze: rgb(tok("--rv-bronze", "#E0955F")) };
const fxFront = new FX($<HTMLCanvasElement>("#fx"));
const winFx = new FX($<HTMLCanvasElement>("#winFx"));
fxFront.hot = winFx.hot = C.ink;
winFx.onBurst = () => sound.crackle();

// ---------- winner scene: hold → ignition → name forge → fireworks → podium ----------
const win = $("#win");
const winName = $("#winName");
let winTimers: number[] = [];
let winEntry: RevealedEntry | null = null;
const later = (ms: number, fn: () => void) => {
  const my = ceremony;
  winTimers.push(window.setTimeout(() => { if (my === ceremony) fn(); }, ms));
};
function stopWinner() {
  winTimers.forEach(clearTimeout);
  winTimers = [];
  winEntry = null;
  win.hidden = true;
  win.className = "rv-win";
  winFx.clear();
  overlay.classList.remove("hold");
}
function setWinnerName(name: string) {
  let i = 0;
  winName.querySelector(".chars")!.innerHTML = name.split(" ").map(word =>
    `<span class="w">${Array.from(word).map(ch => `<span class="c" style="--i:${i++}">${esc(ch)}</span>`).join("")}</span>`).join(" ");
  winName.querySelector(".shine")!.textContent = name;
  fit(winName, 40);
  return i;
}
function winnerScene(e: RevealedEntry) {
  stopBeats();
  winEntry = e;
  $("#winLabel").textContent = `${ordinal(1)} yer · Qalib`;
  $("#winProj").textContent = e.project;
  $("#winScore").textContent = "0.0";
  const letters = setWinnerName(e.name);
  if (calm) {
    overlay.hidden = true;
    win.hidden = false;
    win.className = "rv-win label name score congrats";
    $("#winScore").textContent = e.avg.toFixed(1);
    later(9000, () => finishWinner());
    return;
  }
  overlay.classList.add("hold");            // the heart stops; the room holds its breath
  sound.riser();
  later(900, () => {                         // ignition
    overlay.hidden = true;
    overlay.classList.remove("hold");
    win.hidden = false;
    win.className = "rv-win ignite";
    winFx.resize();
    sound.boom();
    sound.shimmer();
    winFx.burst(0.5, 0.45, [C.gold, C.ink, C.ember], 280, 1.5);
    winFx.embers(40, [C.gold, C.ember]);
  });
  later(1250, () => win.classList.add("label"));
  later(1550, () => { win.classList.add("name"); sound.fanfare(); });
  const named = 1550 + letters * 60 + 1000;
  later(named, () => { win.classList.add("score"); countUp($("#winScore"), e.avg, 2200); });
  later(named + 500, () => win.classList.add("shine"));
  for (let i = 0; i < 14; i++) later(named + 300 + i * 480, () => winFx.rocket(0.1 + Math.random() * 0.8, [C.gold, C.gold, C.ember, C.silver]));
  later(named + 600, () => fxFront.confetti(180, [C.gold, C.ember, C.ink, C.silver, C.bronze]));
  later(named + 1400, () => win.classList.add("congrats"));
  later(named + 9500, () => finishWinner());
}
/** Hands over to the podium (also when the admin presses next/Space during the scene). */
function finishWinner() {
  const e = winEntry;
  if (!e) return;
  winEntry = null;
  winTimers.forEach(clearTimeout);
  winTimers = [];
  winFx.embers(0, []);
  win.classList.add("leaving");
  const my = ceremony;
  window.setTimeout(() => {
    if (my !== ceremony || winEntry) return; // the admin moved on meanwhile
    win.hidden = true;
    win.className = "rv-win";
    winFx.clear();
    fillSlot(e, true);
    ambient();
  }, calm ? 0 : 1400);
}
/** Slow golden embers behind the final podium. */
function ambient() { fxFront.embers(state?.done && !calm && !winEntry ? 12 : 0, [C.gold, C.ember]); }

// ---------- admin controls on the projector (optional; the admin panel has the same buttons) ----------
let adminView: AdminReveal | null = null;
function nextLabel() {
  const n = adminView?.next;
  if (!adminView?.enabled) return "Açıqlamaya icazə verilməyib";
  if (!n) return "Hamısı açıqlandı";
  if (n.kind === "suspense") return `${ordinal(n.entry.rank)} yer — intizar`;
  return n.entry.rank <= 3 ? `${ordinal(n.entry.rank)} yeri açıqla` : `Sıradakı: ${ordinal(n.entry.rank)} yer`;
}
function renderButtons() {
  const common = `<button class="tp-btn" data-act="mute" title="Səs (M)">${icon("sound")}<span>${muted ? "Səs sönük" : "Səs"}</span></button>
    <button class="tp-btn" data-act="full" title="Tam ekran (F)" aria-label="Tam ekran">${icon("full")}</button>`;
  if (!isAdmin) { el.btns.innerHTML = common; return; }
  const canNext = !!adminView?.enabled && !!adminView.next;
  el.btns.innerHTML = `
    <button class="tp-btn" data-act="back" ${adminView?.step ? "" : "disabled"} title="Geri (←)">${icon("reset")}<span>Geri</span></button>
    <button class="tp-btn go" data-act="next" ${canNext ? "" : "disabled"} title="Növbəti (→ / Space)">${icon("next")}<span>${esc(nextLabel())}</span></button>
    ${common}`;
}
async function refreshAdmin() {
  if (!isAdmin) return;
  try { adminView = await api<AdminReveal>("/api/admin/reveal"); } catch { /* lost admin session */ }
  renderButtons();
}
async function act(a: string) {
  if (a === "full") {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => toast("Tam ekran mümkün olmadı"));
    else document.exitFullscreen();
    return;
  }
  if (a === "mute") { muted = !muted; toast(muted ? "Səs söndürüldü" : "Səs açıldı"); renderButtons(); return; }
  if (!isAdmin) return;
  try {
    adminView = await api<AdminReveal & { public: RevealPublic }>("/api/admin/reveal", { method: "POST", body: { action: a } });
    apply((adminView as AdminReveal & { public: RevealPublic }).public);
  } catch (e) { toast((e as ApiError).message); }
}
el.btns.addEventListener("click", e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
  if (b && !b.disabled) act(b.dataset.act!);
});
document.addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "f") act("full");
  else if (k === "m") act("mute");
  else if (winEntry && (e.code === "Space" || k === "arrowright" || k === "enter" || k === "escape")) { e.preventDefault(); finishWinner(); }
  else if (isAdmin && (e.code === "Space" || k === "arrowright" || k === "enter")) { e.preventDefault(); if (adminView?.next && adminView.enabled) act("next"); }
  else if (isAdmin && k === "arrowleft") act("back");
});
let idleT = 0;
const wakeDock = () => { el.dock.classList.remove("idle"); clearTimeout(idleT); idleT = window.setTimeout(() => el.dock.classList.add("idle"), 3500); };
["mousemove", "touchstart", "keydown"].forEach(e => document.addEventListener(e, wakeDock, { passive: true }));
wakeDock();

// ---------- data ----------
async function load() {
  try { apply(await api<RevealPublic>("/api/reveal")); } catch { toast("Serverə qoşulmaq mümkün olmadı"); }
  refreshAdmin();
}
live({
  role: "admin", // admin controls when this browser has an admin session; otherwise public only
  on: {
    "reveal:changed": (p: RevealPublic) => { apply(p); refreshAdmin(); },
    "config:changed": load,
  },
  resync: load,
  status: online => { if (!online) toast("Bağlantı kəsildi — yenidən qoşulur…"); },
});
api<{ role: string }>("/api/auth/me?role=admin").then(me => {
  isAdmin = me.role === "admin";
  el.keys.hidden = !isAdmin;
  refreshAdmin();
}).catch(() => renderButtons());
load();
