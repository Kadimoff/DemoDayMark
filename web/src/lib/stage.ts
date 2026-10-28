// "Səhnədə" strip: team on stage + the shared pitch timer. Used by juror and admin panels.
import { fmtClock, timerView, type TimerView } from "../../../shared/timer";
import type { StagePayload, TimerState } from "../../../shared/types";
import { now, syncClock } from "./clock";
import { esc } from "./dom";

export const PHASE_LABEL: Record<string, string> = { pitch: "Pitch", qa: "Sual-cavab", done: "Vaxt bitdi", idle: "" };

export class StageStrip {
  private stage: StagePayload | null = null;
  private lastTeamKey = "";
  private lastKind = "";
  private listeners: Array<(v: TimerView, s: StagePayload) => void> = [];
  private els: { who: HTMLElement; timer: HTMLElement; k: HTMLElement; t: HTMLElement; bar: HTMLElement; sr: HTMLElement };

  constructor(root: HTMLElement, wide = false) {
    root.className = "stage";
    root.innerHTML = `<div class="wrap${wide ? " wide" : ""}">
      <div style="min-width:0">
        <div class="lbl">Səhnədə</div>
        <div class="who" aria-live="polite">Komanda seçilməyib</div>
      </div>
      <div class="timer" hidden>
        <span class="k"></span>
        <span class="bar"><i style="width:100%"></i></span>
        <span class="t mono">3:00</span>
      </div>
      <span class="sr-only" aria-live="assertive"></span>
    </div>`;
    this.els = {
      who: root.querySelector(".who")!, timer: root.querySelector(".timer")!, k: root.querySelector(".k")!,
      t: root.querySelector(".t")!, bar: root.querySelector(".bar i")!, sr: root.querySelector(".sr-only")!,
    };
    setInterval(() => this.tick(), 250);
  }

  onTick(fn: (v: TimerView, s: StagePayload) => void) { this.listeners.push(fn); }
  get current() { return this.stage; }

  set(stage: StagePayload) {
    syncClock(stage.serverNow);
    this.stage = stage;
    const t = stage.team;
    const key = t ? `${t.id}|${t.name}|${t.project}|${t.index}` : "";
    if (key !== this.lastTeamKey) {
      this.els.who.innerHTML = t
        ? `<span class="ix">#${t.index}</span>${esc(t.name)}${t.project ? `<small>${esc(t.project)}</small>` : ""}`
        : "Komanda seçilməyib";
      if (this.lastTeamKey) {
        this.els.who.classList.remove("swap");
        void this.els.who.offsetWidth;
        this.els.who.classList.add("swap");
      }
      this.lastTeamKey = key;
    }
    this.tick();
  }

  setTimer(timer: TimerState, serverNow: number) {
    if (!this.stage) return;
    syncClock(serverNow);
    this.stage = { ...this.stage, timer };
    this.tick();
  }

  tick() {
    const s = this.stage;
    if (!s) return;
    const v = timerView(s.timer, now());
    const box = this.els.timer;
    box.hidden = v.kind === "idle";
    if (v.kind !== "idle") {
      const paused = !v.running && v.kind !== "done";
      this.els.t.textContent = fmtClock(v.remaining);
      this.els.k.textContent = v.ready ? "Hazır" : paused ? `${PHASE_LABEL[v.kind]} · fasilə` : PHASE_LABEL[v.kind];
      this.els.k.className = `k${v.kind === "qa" ? " qa" : ""}${paused ? " hold" : ""}`;
      this.els.bar.style.width = `${Math.max(0, Math.min(100, (v.remainingExact / v.phaseTotal) * 100))}%`;
      box.classList.toggle("warn", v.kind !== "done" && v.remaining <= 30 && !v.ready);
      box.classList.toggle("over", v.kind === "done");
    }
    if (v.kind !== this.lastKind) {
      // Announce phase changes once for screen readers instead of every second.
      if (this.lastKind) this.els.sr.textContent = v.kind === "idle" ? "" : `${PHASE_LABEL[v.kind]} ${v.kind === "done" ? "" : fmtClock(v.remaining)}`;
      this.lastKind = v.kind;
    }
    for (const fn of this.listeners) fn(v, s);
  }
}
