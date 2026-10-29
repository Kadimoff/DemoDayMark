import { describe, expect, it } from "vitest";
import { normalizeSnapshot, ordinal, revealPublic, revealSteps, type RevealEntry, type RevealSnapshot } from "../shared/reveal.js";

const entry = (teamId: number, rank: number, score: number): RevealEntry =>
  ({ teamId, name: `Team ${teamId}`, project: "", rank, score, demo: score - 40, entry: 40, n: 5 });
// Best first, as stored in the snapshot.
const EIGHT = [entry(1, 1, 90), entry(2, 2, 85), entry(3, 3, 80), entry(4, 4, 70), entry(5, 5, 65), entry(6, 6, 60), entry(7, 7, 55), entry(8, 8, 50)];
const snap: RevealSnapshot = { createdAt: 0, entries: EIGHT, maxTotal: 100 };

describe("revealSteps", () => {
  it("goes from last place up; top three get a suspense step before their reveal", () => {
    const steps = revealSteps(EIGHT);
    expect(steps).toHaveLength(5 + 3 * 2);
    expect(steps.slice(0, 5).map(s => [s.kind, s.index])).toEqual([["reveal", 7], ["reveal", 6], ["reveal", 5], ["reveal", 4], ["reveal", 3]]);
    expect(steps.slice(5).map(s => [s.kind, s.index])).toEqual([
      ["suspense", 2], ["reveal", 2], ["suspense", 1], ["reveal", 1], ["suspense", 0], ["reveal", 0],
    ]);
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
    expect(v.last).toEqual({ kind: "reveal", index: 6 });
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
      createdAt: 5, maxTotal: 100, entries: [{ teamId: 1, name: "A", project: "", rank: 1, score: 88.5, demo: 88.5, entry: null, n: 4 }],
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
