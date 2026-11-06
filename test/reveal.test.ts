import { describe, expect, it } from "vitest";
import { applyFinalOrder, normalizeSnapshot, ordinal, revealPublic, revealSteps, type RevealEntry, type RevealSnapshot } from "../shared/reveal.js";
import { adjustTimer, timerView } from "../shared/timer.js";

const entry = (teamId: number, rank: number, score: number): RevealEntry =>
  ({ teamId, name: `Team ${teamId}`, project: "", rank, score, demo: score - 40, entry: 40, n: 5 });
// Best first, as stored in the snapshot.
const EIGHT = [entry(1, 1, 90), entry(2, 2, 85), entry(3, 3, 80), entry(4, 4, 70), entry(5, 5, 65), entry(6, 6, 60), entry(7, 7, 55), entry(8, 8, 50)];
const snap: RevealSnapshot = { createdAt: 0, entries: EIGHT, maxTotal: 100, top: 3, batch: 1, manual: false };

describe("revealSteps", () => {
  it("goes from last place up; top three get a suspense step before their reveal", () => {
    const steps = revealSteps(EIGHT);
    expect(steps).toHaveLength(5 + 3 * 2);
    expect(steps.slice(0, 5).map(s => [s.kind, s.index])).toEqual([["reveal", 7], ["reveal", 6], ["reveal", 5], ["reveal", 4], ["reveal", 3]]);
    expect(steps.slice(5).map(s => [s.kind, s.index])).toEqual([
      ["suspense", 2], ["reveal", 2], ["suspense", 1], ["reveal", 1], ["suspense", 0], ["reveal", 0],
    ]);
  });

  it("uses the configured number of suspense places (0 = none, 5 = top five)", () => {
    expect(revealSteps(EIGHT, 0).every(s => s.kind === "reveal")).toBe(true);
    expect(revealSteps(EIGHT, 0)).toHaveLength(8);
    expect(revealSteps(EIGHT, 5).filter(s => s.kind === "suspense").map(s => s.index)).toEqual([4, 3, 2, 1, 0]);
    const v = revealPublic({ ...snap, top: 1 }, 7, true, "Demo");
    expect(v.stepsTotal).toBe(9);
    expect(v.revealed.map(e => e.teamId)).toEqual([8, 7, 6, 5, 4, 3, 2]);
  });

  it("treats every team sharing rank 3 as a top-three place", () => {
    const tied = [entry(1, 1, 90), entry(2, 2, 85), entry(3, 3, 80), entry(4, 3, 80), entry(5, 5, 60)];
    expect(revealSteps(tied).filter(s => s.kind === "suspense").map(s => s.index)).toEqual([3, 2, 1, 0]);
  });
});

describe("revealPublic", () => {
  it("shows nothing while the admin has not enabled the reveal", () => {
    const v = revealPublic(snap, 5, false, "Demo");
    expect(v).toMatchObject({ enabled: false, total: 0, revealed: [], suspense: null });
    expect(JSON.stringify(v)).not.toContain("Team");
  });

  it("contains only places revealed so far", () => {
    const v = revealPublic(snap, 2, true, "Demo");
    expect(v.revealed.map(e => e.teamId)).toEqual([8, 7]);
    expect(JSON.stringify(v)).not.toMatch(/Team [1-6]\b/);
    expect(v.last).toEqual({ kind: "reveal", index: 6, indices: [6] });
  });

  it("during suspense exposes the place but not the team", () => {
    const v = revealPublic(snap, 6, true, "Demo");
    expect(v.suspense).toEqual({ index: 2, rank: 3 });
    expect(v.revealed.map(e => e.teamId)).toEqual([8, 7, 6, 5, 4]);
    expect(JSON.stringify(v)).not.toMatch(/"Team 3"|"teamId":3\b|"score":80/);
  });

  it("is done after the winner, and clamps out-of-range steps", () => {
    const v = revealPublic(snap, 99, true, "Demo");
    expect(v.done).toBe(true);
    expect(v.step).toBe(11);
    expect(v.revealed[v.revealed.length - 1].teamId).toBe(1);
  });
});

describe("normalizeSnapshot", () => {
  it("reads snapshots stored before the points model (avg on 0–100)", () => {
    const legacy = { createdAt: 5, entries: [{ teamId: 1, name: "A", project: "", rank: 1, avg: 88.5, n: 4 }] };
    expect(normalizeSnapshot(legacy)).toEqual({
      createdAt: 5, maxTotal: 100, top: 3, batch: 1, manual: false, entries: [{ teamId: 1, name: "A", project: "", rank: 1, score: 88.5, demo: 88.5, entry: null, n: 4 }],
    });
    expect(normalizeSnapshot(null)).toBeNull();
    expect(normalizeSnapshot({ entries: "x" })).toBeNull();
  });

  it("publishes the score scale with the public view", () => {
    expect(revealPublic(snap, 1, true, "Demo").maxTotal).toBe(100);
    expect(revealPublic(snap, 1, false, "Demo").maxTotal).toBe(0);
  });
});

describe("ordinal", () => {
  it("uses Azerbaijani vowel harmony", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 20, 30, 40, 100].map(ordinal)).toEqual(
      ["1-ci", "2-ci", "3-cü", "4-cü", "5-ci", "6-cı", "7-ci", "8-ci", "9-cu", "10-cu", "11-ci", "20-ci", "30-cu", "40-cı", "100-cü"]);
  });
});

describe("large events (20–30 teams)", () => {
  const THIRTY = Array.from({ length: 30 }, (_, i) => entry(i + 1, i + 1, 90 - i));
  const big: RevealSnapshot = { createdAt: 0, entries: THIRTY, maxTotal: 100, top: 3, batch: 5, manual: false };

  it("reveals lower places in groups, worst first, and keeps the top three as two-step ceremonies", () => {
    const steps = revealSteps(THIRTY, 3, 5);
    expect(steps).toHaveLength(Math.ceil(27 / 5) + 6);
    expect(steps[0].indices).toEqual([29, 28, 27, 26, 25]);
    expect(steps[5].indices).toEqual([4, 3]); // last, short group
    expect(steps.slice(6).map(s => [s.kind, s.index])).toEqual([["suspense", 2], ["reveal", 2], ["suspense", 1], ["reveal", 1], ["suspense", 0], ["reveal", 0]]);
  });

  it("publishes every place of a group at once", () => {
    const v = revealPublic(big, 2, true, "Demo");
    expect(v.revealed.map(e => e.rank)).toEqual([30, 29, 28, 27, 26, 25, 24, 23, 22, 21]);
    expect(v.last?.indices).toHaveLength(5);
  });

  it("can hide scores: the public view carries places and names only", () => {
    const v = revealPublic(big, 3, true, "Demo", true);
    expect(v.hideScores).toBe(true);
    expect(v.maxTotal).toBe(0);
    expect(v.revealed.every(e => e.score === null && e.demo === null && e.entry === null)).toBe(true);
    expect(JSON.stringify(v)).not.toMatch(/"score":\d/);
  });
});

describe("jurors' final decision", () => {
  it("re-ranks by the admin's order; unlisted teams follow in score order", () => {
    const { entries, manual } = applyFinalOrder(EIGHT, [3, 1, 2]);
    expect(manual).toBe(true);
    expect(entries.map(e => [e.teamId, e.rank])).toEqual([[3, 1], [1, 2], [2, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8]]);
    expect(entries[0].score).toBe(80); // scores stay as given
    expect(applyFinalOrder(EIGHT, null).manual).toBe(false);
    expect(applyFinalOrder(EIGHT, EIGHT.map(e => e.teamId)).manual).toBe(false);
  });
});

describe("manual timer correction", () => {
  const T0 = 1_000_000;
  const running = { visible: true, running: true, offsetSec: 0, anchorAt: T0, pitchSec: 180, qaSec: 120 };

  it("adds and removes time within the current phase, everywhere at once", () => {
    const at = T0 + 100_000; // 80 s left of the pitch
    const plus = adjustTimer(running, at, { addSec: 30 });
    expect(timerView(plus, at).remaining).toBe(110);
    expect(plus.running).toBe(true);
    const minus = adjustTimer(running, at, { addSec: -200 });
    expect(timerView(minus, at)).toMatchObject({ kind: "qa", remaining: 120 }); // pitch over: Q&A starts, never cut short
  });

  it("sets the time left and keeps a paused timer paused", () => {
    const paused = { ...running, running: false, offsetSec: 30, anchorAt: null };
    const t = adjustTimer(paused, T0, { setRemaining: 45 });
    expect(timerView(t, T0 + 60_000)).toMatchObject({ kind: "pitch", remaining: 45, running: false });
    const qa = adjustTimer({ ...paused, offsetSec: 200 }, T0, { setRemaining: 90 });
    expect(timerView(qa, T0)).toMatchObject({ kind: "qa", remaining: 90 });
  });

  it("reopens Q&A when time is added after the end", () => {
    const done = { ...running, running: false, offsetSec: 300, anchorAt: null };
    expect(timerView(adjustTimer(done, T0, { addSec: 30 }), T0)).toMatchObject({ kind: "qa", remaining: 30 });
  });
});
