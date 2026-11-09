// v15: a small live stage timer for every signed-in screen ("Səhnədə: AgriSense · 2:58 · Təqdimat").
// Phones: a pill fixed above the bottom tab bar; wider screens: bottom-right. Hidden while the timer is not shown on
// the projector (no team / timer hidden). Fed by the page (socket events) or, for pages without stage data, by a
// light poll of the public /api/stage of the organisation.
import type { StagePayload, TimerState } from "../../../shared/types";
import { fmtClock, timerView } from "../../../shared/timer";
import { now, syncClock } from "./clock";
import { esc } from "./dom";
import { PHASE_LABEL } from "./stage";

export interface LiveBarOpts {
  /** Where a tap goes (e.g. the phone remote). */
  href?: string;
  onClick?: () => void;
  /** Only on phones (pages that already show a big timer on desktop). */
  mobileOnly?: boolean;
  /** Return true to hide it for now (e.g. the team's own Pult tab shows the timer already). */
  hidden?: () => boolean;
}

export class LiveBar {
  private el: HTMLElement;
  private stage: StagePayload | null = null;
  private sig = "";
  private poll = 0;

  constructor(private opts: LiveBarOpts = {}) {
    this.el = document.createElement(opts.href ? "a" : "div");
    this.el.className = `livebar${opts.mobileOnly ? " mobile-only" : ""}`;
    this.el.hidden = true;
    this.el.setAttribute("role", "timer");
    this.el.setAttribute("aria-live", "off");
    if (opts.href) (this.el as HTMLAnchorElement).href = opts.href;
    if (opts.onClick) this.el.addEventListener("click", e => { e.preventDefault(); opts.onClick!(); });
    document.body.appendChild(this.el);
    setInterval(() => this.tick(), 250);
  }

  set(stage: StagePayload) { syncClock(stage.serverNow); this.stage = stage; this.tick(); }
  setTimer(timer: TimerState, serverNow: number) {
    syncClock(serverNow);
    if (this.stage) this.stage = { ...this.stage, timer };
    this.tick();
  }

  /** Pages without their own stage data: poll the organisation's public stage (small JSON, every few seconds). */
  follow(url: string, everyMs = 5000) {
    clearInterval(this.poll);
    const get = async () => {
      if (document.hidden) return;
      try { const r = await fetch(url, { credentials: "same-origin", cache: "no-store" }); if (r.ok) this.set(await r.json()); } catch { /* offline: keep the last one */ }
    };
    void get();
    this.poll = window.setInterval(get, everyMs);
  }

  tick() {
    const s = this.stage;
    const v = s ? timerView(s.timer, now()) : null;
    const show = !!s && !!s.team && !!v && v.kind !== "idle" && !this.opts.hidden?.();
    document.body.classList.toggle("has-livebar", show);
    if (!show) { if (!this.el.hidden) this.el.hidden = true; return; }
    const cls = v!.kind === "done" ? "done" : v!.running && v!.remaining <= 10 ? "danger" : v!.running && v!.remaining <= 30 ? "warn" : v!.running ? "run" : "pause";
    const phase = v!.ready ? "Hazır" : `${PHASE_LABEL[v!.kind]}${!v!.running && v!.kind !== "done" ? " · fasilə" : ""}`;
    const sig = `${cls}|${s!.team!.name}|${v!.remaining}|${phase}`;
    if (sig === this.sig && !this.el.hidden) return;
    this.sig = sig;
    this.el.hidden = false;
    this.el.dataset.state = cls;
    this.el.innerHTML = `<i class="lb-dot" aria-hidden="true"></i><span class="lb-team">${esc(s!.team!.name)}</span>
      <b class="lb-time mono">${fmtClock(v!.remaining)}</b><span class="lb-phase">${esc(phase)}</span>`;
    this.el.setAttribute("aria-label", `Səhnədə ${s!.team!.name}: ${fmtClock(v!.remaining)}, ${phase}`);
  }
}
