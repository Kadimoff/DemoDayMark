// Projector results screen. It only ever receives places the admin has already revealed
// (server: shared/reveal.ts), so nothing can leak ahead of the ceremony.
import "./styles.css";
import { ordinal, type RevealPublic, type RevealedEntry } from "../../shared/reveal";
import { api, ApiError } from "./lib/api";
import { $, esc, icon, reducedMotion } from "./lib/dom";
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
let muted = false;
const ctx = () => {
  if (!audio) audio = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
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
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  } catch { /* audio unavailable */ }
}
const sound = {
  // "lub-dub": two low thumps
  beat: () => { tone(62, 0, 0.2, "sine", 0.9, 38); tone(55, 0.19, 0.18, "sine", 0.6, 34); },
  reveal: () => { tone(523.25, 0, 0.18, "triangle", 0.25); tone(783.99, 0.1, 0.35, "triangle", 0.22); },
  podium: () => [523.25, 659.25, 783.99].forEach((f, i) => tone(f, i * 0.12, 0.9, "triangle", 0.28)),
  winner: () => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.14, 0.5, "triangle", 0.3));
    [523.25, 659.25, 783.99, 1046.5].forEach(f => tone(f, 0.62, 1.8, "sine", 0.18));
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
  if (e.rank === 1) { sound.winner(); confetti(); } else sound.podium();
  // Hand the stage back to the podium after the moment has landed.
  window.setTimeout(() => {
    if (my !== ceremony) return;
    overlay.classList.add("leaving");
    window.setTimeout(() => {
      if (my !== ceremony) return;
      overlay.hidden = true;
      fillSlot(e, true);
    }, calm ? 0 : 700);
  }, e.rank === 1 ? 7000 : 4500);
}

// ---------- apply server state ----------
function apply(next: RevealPublic) {
  const prev = state;
  state = next;
  ceremony++;
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
  renderButtons();
}

// ---------- confetti (one measured burst for the winner) ----------
const fx = $<HTMLCanvasElement>("#fx");
const g = fx.getContext("2d")!;
const resize = () => { fx.width = innerWidth * devicePixelRatio; fx.height = innerHeight * devicePixelRatio; };
addEventListener("resize", resize);
resize();
function confetti() {
  if (calm) return;
  const css = getComputedStyle(document.documentElement);
  const colors = ["--rv-gold", "--rv-ember", "--rv-ink", "--rv-silver"].map(v => css.getPropertyValue(v).trim() || "#F1C24D");
  const W = fx.width, H = fx.height, dpr = devicePixelRatio;
  const parts = Array.from({ length: 220 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.2, y: H * 0.35,
    vx: (Math.random() - 0.5) * 22 * dpr, vy: (-Math.random() * 18 - 6) * dpr,
    r: (Math.random() * 6 + 4) * dpr, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  const frame = (t: number) => {
    const age = (t - t0) / 1000;
    g.clearRect(0, 0, W, H);
    if (age > 4.5) return;
    g.globalAlpha = Math.max(0, 1 - Math.max(0, age - 3.2) / 1.3);
    for (const p of parts) {
      p.vy += 0.55 * dpr; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.c; g.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); g.restore();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

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
