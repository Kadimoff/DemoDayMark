// Projector results screen. It only ever receives places the admin has already revealed
// (server: shared/reveal.ts), so nothing can leak ahead of the ceremony.
// v3: calm and simple — the top places open in two clicks: first the big place number, then the name (soft
// animation); the winner gets a restrained confetti. No suspense texts, heartbeat or fireworks, and no control
// buttons on the projector: the coordinator panel and the phone remote run the reveal.
import "./styles.css";
import { ordinal, type RevealPublic, type RevealedEntry } from "../../shared/reveal";
import { displayParts } from "../../shared/scoring";
import { pageOrg } from "./lib/org";
import { api, ApiError } from "./lib/api";
import { $, brandHtml, esc, icon, reducedMotion } from "./lib/dom";
import { FX, rgb } from "./lib/fx";
import { live } from "./lib/socket";

interface AdminReveal { enabled: boolean; step: number; stepsTotal: number; next: { kind: "suspense" | "reveal"; indices: number[]; entry: { rank: number }; entries: Array<{ rank: number }> } | null }

const main = $("#main");
const overlay = $("#overlay");
const spot = $("#spot");
const vid = { bg: $<HTMLVideoElement>("#bgv") };
const play = (v: HTMLVideoElement, fromStart = false) => { if (fromStart) v.currentTime = 0; v.play().catch(() => { /* autoplay blocked or file missing: CSS backdrop stays */ }); };
play(vid.bg);
const el = {
  ev: $("#ev"), title: $("#title"), ovNum: $("#ovNum"), ovPlace: $("#ovPlace"), ovName: $("#ovName"), ovProj: $("#ovProj"), ovScore: $("#ovScore"), ovBreak: $("#ovBreak"),
  btns: $("#btns"), toast: $("#toast"), dock: $("#dock"),
  prog: $("#prog"), progN: $("#progN"), progT: $("#progT"), progBar: $("#progBar"), manual: $("#manual"),
};
const calm = reducedMotion();

let state: RevealPublic | null = null;
let boardTotal = -1;
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
// v3: soft, short cues only (no heartbeat, risers, booms or fanfare).
const sound = {
  place: () => { tone(392, 0, 0.5, "sine", 0.12); tone(587.33, 0.05, 0.6, "sine", 0.08); },
  reveal: () => { tone(523.25, 0, 0.18, "triangle", 0.2); tone(783.99, 0.1, 0.35, "triangle", 0.18); },
  podium: () => [523.25, 659.25, 783.99].forEach((f, i) => tone(f, i * 0.12, 0.9, "triangle", 0.22)),
  winner: () => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.14, 1.4, "triangle", 0.2));
    [1567.98, 2093].forEach((f, i) => tone(f, 0.6 + i * 0.08, 1.6, "sine", 0.04));
    noise(0.55, 0.5, 0.05, "highpass", 3000, 6000, 0.01);
  },
};
void brass; // kept for the sound bus API
// ---------- helpers ----------
const medal = (rank: number) => (rank === 1 ? "gold" : rank === 2 ? "silver" : rank === 3 ? "bronze" : "");
function countUp(node: HTMLElement, to: number | null, ms: number) {
  if (to == null) { node.textContent = ""; return; }
  if (calm) { node.textContent = to.toFixed(2); return; }
  const t0 = performance.now(), my = ceremony;
  const step = (t: number) => {
    if (my !== ceremony) { node.textContent = to.toFixed(2); return; }
    const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
    node.textContent = (to * e).toFixed(2);
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
  overlay.hidden = true;
  el.title.textContent = "Nəticələr";
  document.body.classList.add("waiting");
  el.prog.hidden = true;
  main.innerHTML = `<div class="rv-wait"><div class="rv-wait-art" aria-hidden="true"></div><div class="rv-wait-ring"></div><h1>Nəticələr</h1><p>Münsiflərin qərarı tezliklə açıqlanacaq</p></div>`;
}

/** Wall layout for places 4..N: 1 column up to 8 teams, then 2, 3 or 4 columns so 20–40 teams still fit one screen. */
function wallCols(n: number) { return n <= 8 ? 1 : n <= 18 ? 2 : n <= 33 ? 3 : 4; }
function buildBoard(total: number) {
  boardTotal = total;
  document.body.classList.remove("waiting");
  const pod = [1, 0, 2].filter(i => i < total);
  const rest = Array.from({ length: Math.max(0, total - 3) }, (_, k) => k + 3);
  const cols = wallCols(rest.length), rows = Math.max(1, Math.ceil(rest.length / cols));
  main.innerHTML = `<div class="rv-board${rest.length ? "" : " solo"}${cols > 1 ? " wall" : ""}" style="--cols:${cols};--rows:${rows}">
    ${rest.length ? `<section class="rv-list" aria-label="${ordinal(4)}-${ordinal(total)} yerlər">${rest.map(i => `
      <div class="rv-row" data-slot="${i}"><span class="rk">${i + 1}</span>
        <div class="nm"><b>?</b><small></small><div class="bar"><i></i></div></div><span class="sc mono"></span></div>`).join("")}
    </section>` : ""}
    <section class="rv-podium" aria-label="İlk üçlük">${pod.map(i => `
      <div class="rv-pod p${i}" data-slot="${i}">
        <div class="rv-card"><span class="medal">${ordinal(i + 1)} yer</span><b class="nm">?</b><small class="pj"></small><span class="sc mono"></span><small class="bd"></small></div>
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
    slot.querySelector(".nm small")!.textContent = [e.project, breakdown(e)].filter(Boolean).join(" · ");
    slot.querySelector<HTMLElement>(".bar i")!.style.width = `${e.score == null ? 0 : pct(e.score)}%`;
  } else {
    slot.querySelector(".medal")!.textContent = `${ordinal(e.rank)} yer`;
    slot.querySelector(".nm")!.textContent = e.name;
    slot.querySelector(".pj")!.textContent = e.project;
    slot.querySelector(".bd")!.textContent = breakdown(e);
    fit(slot.querySelector<HTMLElement>(".nm")!);
  }
  if (animate && !calm) {
    slot.classList.remove("enter");
    void slot.offsetWidth;
    slot.classList.add("enter");
    countUp(sc, e.score, 1300);
  } else sc.textContent = e.score == null ? "" : e.score.toFixed(2);
}

// ---------- spotlight: lower places are shown big first, then fly into their tiles ----------
function spotlight(list: RevealedEntry[]) {
  const my = ceremony;
  spot.hidden = false;
  spot.className = `rv-spot n${Math.min(list.length, 10)}${list.length > 1 ? " many" : ""}`;
  // Worst place first, the way the room reads it.
  const order = [...list].sort((a, b) => b.rank - a.rank);
  spot.innerHTML = `<div class="rv-spot-in">${order.map((e, k) => `
    <div class="rv-sc" style="--k:${k}" data-i="${e.index}">
      <span class="rk">${ordinal(e.rank)} yer</span>
      <b class="nm">${esc(e.name)}</b>
      ${e.project ? `<small>${esc(e.project)}</small>` : ""}
      ${e.score != null ? `<span class="sc mono">0.00</span>` : ""}
    </div>`).join("")}</div>`;
  spot.querySelectorAll<HTMLElement>(".rv-sc").forEach((card, k) => {
    const e = order[k];
    const sc = card.querySelector<HTMLElement>(".sc");
    if (sc) window.setTimeout(() => { if (my === ceremony) countUp(sc, e.score, 900); }, k * 220 + 250);
    if (order.length === 1) fit(card.querySelector<HTMLElement>(".nm")!, 28);
  });
  sound.reveal();
  const hold = calm ? 300 : 1500 + order.length * 220;
  window.setTimeout(() => {
    if (my !== ceremony) return;
    const cards = [...spot.querySelectorAll<HTMLElement>(".rv-sc")];
    cards.forEach((card, k) => {
      const e = order[k];
      const slot = main.querySelector<HTMLElement>(`[data-slot="${e.index}"]`);
      const done = () => { if (my === ceremony) fillSlot(e, true); };
      if (!slot || calm) { done(); return; }
      const a = card.getBoundingClientRect(), b = slot.getBoundingClientRect();
      const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
      const k2 = Math.min(1, b.height / a.height);
      card.animate([{ transform: "none", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(${k2})`, opacity: 0.15 }],
        { duration: 650, delay: k * 70, easing: "cubic-bezier(.6,0,.3,1)", fill: "forwards" }).finished.then(done, done);
    });
    window.setTimeout(() => { if (my === ceremony) { spot.hidden = true; spot.innerHTML = ""; } }, 650 + cards.length * 70 + 60);
  }, hold);
}
/** "Giriş 41.7 + Demo Day 43.2" when the final score includes an entry score. */
const breakdown = (e: RevealedEntry) => {
  if (e.entry == null || e.score == null) return "";
  const p = displayParts(e.score, e.entry);
  return `Giriş ${p.entry} + Demo Day ${p.demo}`;
};
const pct = (score: number) => (state?.maxTotal ? Math.max(0, Math.min(100, (score / state.maxTotal) * 100)) : 0);

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

// ---------- overlay: big place number → name ----------
function showPlace(rank: number) {
  overlay.hidden = false;
  overlay.className = `rv-overlay place ${medal(rank)}`;
  el.ovNum.textContent = String(rank);
  el.ovPlace.textContent = `${ordinal(rank)} yer`;
  el.ovName.textContent = "";
  el.ovProj.textContent = "";
  el.ovScore.textContent = "";
  el.ovBreak.textContent = "";
  sound.place();
}

function ceremonyReveal(e: RevealedEntry) {
  const my = ceremony;
  const winner = e.rank === 1 && e.index === 0;
  overlay.hidden = false;
  overlay.className = `rv-overlay revealed ${medal(e.rank)}${winner ? " winner" : ""}`;
  el.ovNum.textContent = String(e.rank);
  el.ovPlace.textContent = winner ? `${ordinal(1)} yer · Qalib` : `${ordinal(e.rank)} yer`;
  el.ovName.textContent = e.name;
  el.ovProj.textContent = e.project;
  el.ovScore.textContent = e.score == null ? "" : "0.00";
  el.ovBreak.textContent = breakdown(e);
  fit(el.ovName, 24);
  countUp(el.ovScore, e.score, 1400);
  if (winner) {
    sound.winner();
    // restrained confetti: one soft fall, in the brand's warm tones
    if (!calm) window.setTimeout(() => { if (my === ceremony) fxFront.confetti(110, [C.gold, C.ink, C.ember]); }, 450);
  } else sound.podium();
  // Hand the stage back to the podium after the moment has landed (the winner stays a little longer).
  window.setTimeout(() => {
    if (my !== ceremony) return;
    overlay.classList.add("leaving");
    window.setTimeout(() => {
      if (my !== ceremony) return;
      overlay.hidden = true;
      fillSlot(e, true);
      ambient();
    }, calm ? 0 : 700);
  }, winner ? 7000 : 4500);
}

// ---------- apply server state ----------
let lastSig = "";
function apply(next: RevealPublic) {
  // The same state can arrive twice (API response + socket echo); re-applying would cut a running scene.
  const sig = JSON.stringify([next.enabled, next.eventName, next.step, next.total, next.stepsTotal, next.hideScores, next.manual, next.revealed.map(r => r.teamId)]);
  if (sig === lastSig) return;
  lastSig = sig;
  const prev = state;
  state = next;
  ceremony++;
  spot.hidden = true;
  spot.innerHTML = "";
  fxFront.embers(0, []);
  el.ev.innerHTML = brandHtml(next.eventName);
  document.body.classList.toggle("noscores", next.hideScores);
  if (!next.enabled) { waiting(); return; }
  if (boardTotal !== next.total) buildBoard(next.total);
  el.title.textContent = next.done ? "Qaliblər" : "Nəticələr";
  el.prog.hidden = false;
  el.progN.textContent = String(next.revealed.length);
  el.progT.textContent = String(next.total);
  el.progBar.style.width = `${next.total ? (next.revealed.length / next.total) * 100 : 0}%`;
  el.manual.hidden = !next.manual;

  const live = !!prev?.enabled && next.step === prev.step + 1 && !!next.last && prev.hideScores === next.hideScores;
  const freshSet = new Set(live && next.last!.kind === "reveal" ? next.last!.indices : []);
  const fresh = freshSet.size === 1 ? [...freshSet][0] : -1;
  // A top-place reveal arrives right after its suspense step.
  const special = fresh >= 0 && prev!.suspense?.index === fresh;
  const shown = new Set(next.revealed.map(e => e.index));
  for (let i = 0; i < next.total; i++) if (!shown.has(i)) clearSlot(i);
  for (const e of next.revealed) {
    if (freshSet.has(e.index)) continue; // filled when its ceremony or spotlight hands over
    fillSlot(e, false);
  }
  if (freshSet.size && !special) spotlight(next.revealed.filter(e => freshSet.has(e.index)));

  if (next.suspense) {
    // first click on a top place: only its number (the name is not even on this screen yet — see shared/reveal.ts)
    if (!(prev?.suspense && prev.suspense.index === next.suspense.index && !overlay.hidden)) showPlace(next.suspense.rank);
  } else if (special) {
    ceremonyReveal(next.revealed.find(e => e.index === fresh)!);
  } else {
    overlay.hidden = true;
  }
  main.querySelectorAll(".rv-pod.p0").forEach(p => p.classList.toggle("champion", next.done));
  ambient();
}

// ---------- particles ----------
const tok = (v: string, fb: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || fb;
const C = { gold: rgb(tok("--rv-gold", "#F1C24D")), ember: rgb(tok("--rv-ember", "#FF6F36")), ink: rgb(tok("--rv-ink", "#F3F4F8")), silver: rgb(tok("--rv-silver", "#D3DAE6")), bronze: rgb(tok("--rv-bronze", "#E0955F")) };
const fxFront = new FX($<HTMLCanvasElement>("#fx"));
fxFront.hot = C.ink;

/** Slow golden embers behind the final podium. */
function ambient() { fxFront.embers(state?.done && !calm && overlay.hidden ? 10 : 0, [C.gold, C.ember]); }

// ---------- v3: no control buttons on the projector — only small sound / fullscreen icons (and F / M keys) ----------
function renderButtons() {
  el.btns.innerHTML = `<button class="tp-btn ico" data-act="mute" title="Səs (M)" aria-label="${muted ? "Səsi aç" : "Səsi söndür"}">${icon("sound")}${muted ? `<span class="x">×</span>` : ""}</button>
    <button class="tp-btn ico" data-act="full" title="Tam ekran (F)" aria-label="Tam ekran">${icon("full")}</button>`;
}
function act(a: string) {
  if (a === "full") {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => toast("Tam ekran mümkün olmadı"));
    else void document.exitFullscreen();
    return;
  }
  if (a === "mute") { muted = !muted; toast(muted ? "Səs söndürüldü" : "Səs açıldı"); renderButtons(); }
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
});
renderButtons();
let idleT = 0;
const wakeDock = () => { el.dock.classList.remove("idle"); clearTimeout(idleT); idleT = window.setTimeout(() => el.dock.classList.add("idle"), 3500); };
["mousemove", "touchstart", "keydown"].forEach(e => document.addEventListener(e, wakeDock, { passive: true }));
wakeDock();

// ---------- data ----------
async function load() {
  try { apply(await api<RevealPublic>("/api/reveal")); } catch { toast("Serverə qoşulmaq mümkün olmadı"); }
}
live({
  // v3: anonymous — the public reveal feed only
  on: {
    "reveal:changed": (p: RevealPublic) => apply(p),
    "config:changed": load,
  },
  resync: load,
});
load();
