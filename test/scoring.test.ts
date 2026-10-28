import { describe, expect, it } from "vitest";
import { computeResults, isComplete, jurorTotal } from "../shared/scoring.js";
import { applyTimerAction, DEFAULT_TIMER, timerView } from "../shared/timer.js";
import type { Criterion, Juror, ScoreRow, Team } from "../shared/types.js";

const crit = (key: string, weight: number, orderIndex: number): Criterion =>
  ({ id: orderIndex + 1, key, name: key, description: "", weight, orderIndex });
const CRITERIA = [crit("problem", 15, 0), crit("solution", 15, 1), crit("mvp", 20, 2), crit("market", 10, 3),
  crit("biz", 10, 4), crit("traction", 10, 5), crit("team", 10, 6), crit("pitch", 10, 7)];
const team = (id: number): Team => ({ id, name: `Komanda ${id}`, project: "", orderIndex: id, active: true });
const juror = (id: number): Juror => ({ id, username: `j${id}`, displayName: `Münsif ${id}`, active: true });
const all = (v: number) => Object.fromEntries(CRITERIA.map(c => [c.key, v]));
const score = (jurorId: number, teamId: number, values: Record<string, number>): ScoreRow =>
  ({ jurorId, teamId, values, note: "", createdAt: 0, updatedAt: 0 });

describe("jurorTotal", () => {
  it("is Σ(score × weight) / Σ weight × 10", () => {
    expect(jurorTotal(all(10), CRITERIA)).toBe(100);
    expect(jurorTotal(all(1), CRITERIA)).toBe(10);
    // only MVP (20%) gets 10, the rest 5 → (20*10 + 80*5) / 100 * 10 = 60
    expect(jurorTotal({ ...all(5), mvp: 10 }, CRITERIA)).toBe(60);
  });
  it("rounds to two decimals", () => {
    const c = [crit("a", 1, 0), crit("b", 2, 1)];
    expect(jurorTotal({ a: 1, b: 2 }, c)).toBe(16.67);
  });
  it("returns null for incomplete or out-of-range values", () => {
    const { pitch: _p, ...missing } = all(7);
    expect(jurorTotal(missing, CRITERIA)).toBeNull();
    expect(isComplete({ ...all(7), mvp: 11 }, CRITERIA)).toBe(false);
    expect(isComplete({ ...all(7), mvp: 0 }, CRITERIA)).toBe(false);
    expect(isComplete({ ...all(7), mvp: 7.5 }, CRITERIA)).toBe(false);
  });
});

describe("computeResults", () => {
  const teams = [team(1), team(2), team(3), team(4)];
  const jurors = [juror(1), juror(2), juror(3)];

  it("averages complete juror totals and ranks descending", () => {
    const r = computeResults({
      teams, jurors, criteria: CRITERIA, minJurorsForRank: 1,
      scores: [score(1, 1, all(6)), score(2, 1, all(8)), score(1, 2, all(9)), score(1, 3, all(5))],
    });
    expect(r.ranking.map(x => [x.team.id, x.rank, x.avg])).toEqual([[2, 1, 90], [1, 2, 70], [3, 3, 50], [4, null, null]]);
    const t1 = r.ranking.find(x => x.team.id === 1)!;
    expect([t1.n, t1.min, t1.max]).toEqual([2, 60, 80]);
    expect(r.matrix[1]).toEqual({ 1: 60, 2: 80, 3: null });
    expect(r.done).toBe(4);
    expect(r.need).toBe(12);
  });

  it("ignores incomplete scores entirely", () => {
    const { mvp: _m, ...partial } = all(10);
    const r = computeResults({ teams, jurors, criteria: CRITERIA, minJurorsForRank: 1, scores: [score(1, 1, all(5)), score(2, 1, partial)] });
    const t1 = r.ranking.find(x => x.team.id === 1)!;
    expect([t1.n, t1.avg]).toEqual([1, 50]);
  });

  it("breaks ties by the highest-weight criterion average (MVP), then the next", () => {
    // Same total 60 for both; team 2 has the higher MVP average.
    const a = { ...all(6) };                                  // 60
    const b = { ...all(6), mvp: 9, problem: 4, solution: 4 }; // (20*9 + 15*4*2 + 50*6)/100*10 = 60
    expect(jurorTotal(b, CRITERIA)).toBe(60);
    const r = computeResults({ teams: [team(1), team(2)], jurors, criteria: CRITERIA, minJurorsForRank: 1, scores: [score(1, 1, a), score(1, 2, b)] });
    expect(r.ranking.map(x => [x.team.id, x.rank])).toEqual([[2, 1], [1, 2]]);
    expect(r.tieBreakKeys.slice(0, 3)).toEqual(["mvp", "problem", "solution"]);
  });

  it("falls through to the next criterion when MVP also ties", () => {
    const a = { ...all(6), problem: 8, solution: 4 }; // problem higher
    const b = { ...all(6), problem: 4, solution: 8 };
    const r = computeResults({ teams: [team(1), team(2)], jurors, criteria: CRITERIA, minJurorsForRank: 1, scores: [score(1, 1, b), score(1, 2, a)] });
    expect(r.ranking[0].team.id).toBe(2);
  });

  it("gives a shared rank to a full tie", () => {
    const r = computeResults({ teams, jurors, criteria: CRITERIA, minJurorsForRank: 1,
      scores: [score(1, 1, all(7)), score(1, 2, all(7)), score(1, 3, all(5))] });
    expect(r.ranking.map(x => x.rank)).toEqual([1, 1, 3, null]);
  });

  it("flags teams below MIN_JURORS_FOR_RANK and puts unscored teams last", () => {
    const r = computeResults({ teams, jurors, criteria: CRITERIA, minJurorsForRank: 2,
      scores: [score(1, 1, all(9)), score(1, 2, all(5)), score(2, 2, all(5))] });
    const t1 = r.ranking.find(x => x.team.id === 1)!;
    const t2 = r.ranking.find(x => x.team.id === 2)!;
    expect(t1.incomplete).toBe(true);
    expect(t2.incomplete).toBe(false);
    expect(r.ranking.slice(-2).every(x => x.avg == null)).toBe(true);
  });

  it("skips inactive teams and scores from unknown jurors", () => {
    const r = computeResults({ teams: [team(1), { ...team(2), active: false }], jurors, criteria: CRITERIA, minJurorsForRank: 1,
      scores: [score(99, 1, all(10)), score(1, 2, all(10))] });
    expect(r.ranking.map(x => x.team.id)).toEqual([1]);
    expect(r.ranking[0].avg).toBeNull();
  });
});

describe("shared timer", () => {
  const t0 = 1_000_000;
  it("runs pitch, rolls into Q&A, then done", () => {
    const t = applyTimerAction(DEFAULT_TIMER, "pitch", t0);
    expect(timerView(t, t0).kind).toBe("pitch");
    expect(timerView(t, t0 + 1000).remaining).toBe(179);
    expect(timerView(t, t0 + 181_000)).toMatchObject({ kind: "qa", remaining: 119 });
    expect(timerView(t, t0 + 301_000)).toMatchObject({ kind: "done", remaining: 0, running: false });
  });
  it("pauses and resumes without losing time", () => {
    let t = applyTimerAction(DEFAULT_TIMER, "pitch", t0);
    t = applyTimerAction(t, "pause", t0 + 30_000);
    expect(timerView(t, t0 + 999_000).remaining).toBe(150);
    t = applyTimerAction(t, "resume", t0 + 999_000);
    expect(timerView(t, t0 + 1_009_000).remaining).toBe(140);
  });
  it("skips to Q&A and hides on stop", () => {
    const t = applyTimerAction(DEFAULT_TIMER, "qa", t0);
    expect(timerView(t, t0)).toMatchObject({ kind: "qa", remaining: 120 });
    expect(timerView(applyTimerAction(t, "stop", t0), t0).kind).toBe("idle");
  });
});
