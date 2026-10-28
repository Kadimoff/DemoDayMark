// Pure timer math shared by the server (state transitions) and every screen (rendering).
import type { TimerAction, TimerState } from "./types.js";

export type PhaseKind = "idle" | "pitch" | "qa" | "done";

export interface TimerView {
  kind: PhaseKind;
  running: boolean;
  /** Whole seconds left in the current phase (ceil). */
  remaining: number;
  /** Exact seconds left, for progress bars. */
  remainingExact: number;
  phaseTotal: number;
  /** Position in the pitch+qa timeline, seconds. */
  position: number;
  /** True while the timer sits at the very start of the pitch and has not been started. */
  ready: boolean;
}

export const DEFAULT_TIMER: TimerState = {
  visible: false,
  running: false,
  offsetSec: 0,
  anchorAt: null,
  pitchSec: 180,
  qaSec: 120,
};

export function timerPosition(t: TimerState, now: number): number {
  const live = t.running && t.anchorAt != null ? (now - t.anchorAt) / 1000 : 0;
  return Math.max(0, t.offsetSec + live);
}

export function timerView(t: TimerState, now: number): TimerView {
  const position = timerPosition(t, now);
  const end = t.pitchSec + t.qaSec;
  if (!t.visible) {
    return { kind: "idle", running: false, remaining: t.pitchSec, remainingExact: t.pitchSec, phaseTotal: t.pitchSec, position: 0, ready: false };
  }
  let kind: PhaseKind, left: number, total: number;
  if (position < t.pitchSec) { kind = "pitch"; left = t.pitchSec - position; total = t.pitchSec; }
  else if (position < end) { kind = "qa"; left = end - position; total = t.qaSec; }
  else { kind = "done"; left = 0; total = t.qaSec; }
  return {
    kind,
    running: t.running && kind !== "done",
    remaining: Math.max(0, Math.ceil(left - 1e-6)),
    remainingExact: Math.max(0, left),
    phaseTotal: total,
    position,
    ready: !t.running && position === 0,
  };
}

export const fmtClock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

/** Applies an admin control action. Returns the new state; input is not mutated. */
export function applyTimerAction(t: TimerState, action: TimerAction, now: number): TimerState {
  const end = t.pitchSec + t.qaSec;
  const pos = Math.min(timerPosition(t, now), end);
  switch (action) {
    case "pitch":
      return { ...t, visible: true, running: true, offsetSec: 0, anchorAt: now };
    case "qa":
      return { ...t, visible: true, running: true, offsetSec: t.pitchSec, anchorAt: now };
    case "pause":
      return { ...t, running: false, offsetSec: pos, anchorAt: null };
    case "resume":
      // Resuming a finished timer starts the next run from the top.
      return { ...t, visible: true, running: true, offsetSec: pos >= end ? 0 : pos, anchorAt: now };
    case "toggle":
      return applyTimerAction(t, t.running && pos < end ? "pause" : "resume", now);
    case "reset":
      return { ...t, visible: true, running: false, offsetSec: 0, anchorAt: null };
    case "stop":
      return { ...t, visible: false, running: false, offsetSec: 0, anchorAt: null };
  }
}
