// Presenter's phone (/speaker, opened from a QR on the live panel): the shared stage timer, big and simple.
// Public like /timer: it only ever receives the stage and the timer, never any score.
import "./styles.css";
import { fmtClock, type TimerView } from "../../shared/timer";
import type { StagePayload, TimerState } from "../../shared/types";
import { api } from "./lib/api";
import { $, brandHtml, esc } from "./lib/dom";
import { live } from "./lib/socket";
import { PHASE_LABEL, StageStrip } from "./lib/stage";

const strip = new StageStrip(null);
const el = { team: $("#team"), phase: $("#phase"), time: $("#time"), arc: $<SVGCircleElement>("#arc"), next: $("#next"), brand: $("#brand"), conn: $("#conn") };
const C = 2 * Math.PI * 88;
el.arc.style.strokeDasharray = String(C);
let lastKind = "", lastLeft = -1;

function buzz(pattern: number[]) { try { navigator.vibrate?.(pattern); } catch { /* unsupported */ } }

function render(v: TimerView, s: StagePayload) {
  el.brand.innerHTML = brandHtml(s.eventName);
  el.team.innerHTML = s.team ? `<span>#${s.team.index}</span> ${esc(s.team.name)}` : "Səhnədə komanda yoxdur";
  const warn = v.kind !== "done" && v.kind !== "idle" && !v.ready && v.remaining <= 30;
  document.body.className = `sp phase-${v.kind}${warn ? " warn" : ""}${v.running ? "" : " paused"}`;
  if (v.kind === "idle") {
    el.phase.textContent = "Gözləmədə";
    el.time.textContent = fmtClock(s.timer.pitchSec);
    el.arc.style.strokeDashoffset = "0";
    el.next.textContent = `Təqdimat ${fmtClock(s.timer.pitchSec)} · sual-cavab ${fmtClock(s.timer.qaSec)}`;
  } else {
    el.phase.textContent = v.ready ? "Hazır · başlamağı gözləyin" : `${PHASE_LABEL[v.kind]}${!v.running && v.kind !== "done" ? " · fasilə" : ""}`;
    el.time.textContent = v.kind === "done" ? "0:00" : fmtClock(v.remaining);
    el.arc.style.strokeDashoffset = String(C * (1 - Math.max(0, Math.min(1, v.remainingExact / v.phaseTotal))));
    el.next.textContent = v.kind === "pitch" ? `Sonra: sual-cavab ${fmtClock(s.timer.qaSec)}` : v.kind === "qa" ? "Sonra: vaxt bitir" : "Vaxt bitdi, təşəkkürlər!";
  }
  // Gentle haptics: 30 s left, phase change, time over.
  if (v.running && v.kind !== "idle") {
    if (lastLeft > 30 && v.remaining <= 30 && v.kind !== "done") buzz([120]);
    if (lastKind && lastKind !== v.kind) buzz(v.kind === "done" ? [300, 120, 300, 120, 300] : [200, 100, 200]);
  }
  lastKind = v.kind;
  lastLeft = v.remaining;
}
strip.onTick(render);

async function load() { try { strip.set(await api<StagePayload>("/api/stage")); } catch { /* offline: keep last state */ } }
live({
  on: {
    "stage:changed": (s: StagePayload) => strip.set(s),
    "timer:changed": (p: { timer: TimerState; serverNow: number }) => strip.setTimer(p.timer, p.serverNow),
    "config:changed": load,
  },
  resync: load,
  status: online => { el.conn.textContent = online ? "Canlı" : "Oflayn"; el.conn.className = `sp-conn ${online ? "on" : "off"}`; },
});
async function wake() {
  try {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } }).wakeLock;
    if (wl && document.visibilityState === "visible") await wl.request("screen");
  } catch { /* unsupported */ }
}
document.addEventListener("visibilitychange", wake);
wake();
load();
