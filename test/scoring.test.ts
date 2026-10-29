import { describe, expect, it } from "vitest";
import { band, computeResults, demoMax, displayParts, isComplete, jurorTotal } from "../shared/scoring.js";
import { applyTimerAction, DEFAULT_TIMER, timerView } from "../shared/timer.js";
import type { AdminTeam, Criterion, Juror, ScoreRow } from "../shared/types.js";

const crit = (key: string, maxScore: number, orderIndex: number): Criterion =>
  ({ id: orderIndex + 1, key, name: key, description: "", maxScore, orderIndex });
// The Ignite Demo Day rubric: 5 + 10 + 10 + 10 + 10 + 5 = 50
const CRITERIA = [crit("teqdimat", 5, 0), crit("komanda", 10, 1), crit("biznes", 10, 2), crit("mehsul_bazar", 10, 3),
  crit("bazar", 10, 4), crit("tesir", 5, 5)];
const team = (id: number, entryScore: number | null = null): AdminTeam =>
  ({ id, name: `Komanda ${id}`, project: "", orderIndex: id, active: true, entryScore });
const juror = (id: number): Juror => ({ id, username: `j${id}`, displayName: `Münsif ${id}`, active: true });
/** Same share v/10 on every criterion: v on 10-point criteria, v/2 (rounded up) on 5-point ones. */
const at = (v: number) => Object.fromEntries(CRITERIA.map(c => [c.key, c.maxScore === 10 ? v : Math.ceil(v / 2)]));
const score = (jurorId: number, teamId: number, values: Record<string, number>): ScoreRow =>
  ({ jurorId, teamId, values, note: "", createdAt: 0, updatedAt: 0 });
const results = (teams: AdminTeam[], scores: ScoreRow[], opts: Partial<{ includeEntry: boolean; minJurorsForRank: number; jurors: Juror[] }> = {}) =>
  computeResults({
    teams, criteria: CRITERIA, scores, jurors: opts.jurors ?? [juror(1), juror(2), juror(3)],
    minJurorsForRank: opts.minJurorsForRank ?? 1, includeEntry: opts.includeEntry ?? true, entryMax: 50,
  });

describe("jurorTotal (points)", () => {
  it("is the plain sum of points; the rubric maximum is 50", () => {
    expect(demoMax(CRITERIA)).toBe(50);
    expect(jurorTotal(at(10), CRITERIA)).toBe(50);
    expect(jurorTotal({ teqdimat: 1, komanda: 1, biznes: 1, mehsul_bazar: 1, bazar: 1, tesir: 1 }, CRITERIA)).toBe(6);
    expect(jurorTotal({ teqdimat: 4, komanda: 8, biznes: 7, mehsul_bazar: 9, bazar: 6, tesir: 3 }, CRITERIA)).toBe(37);
  });

  it("rejects missing criteria and anything outside 1..max of that criterion", () => {
    const { tesir: _t, ...missing } = at(8);
    expect(jurorTotal(missing, CRITERIA)).toBeNull();
    expect(isComplete({ ...at(8), teqdimat: 6 }, CRITERIA)).toBe(false); // 5-point criterion
    expect(isComplete({ ...at(8), komanda: 11 }, CRITERIA)).toBe(false);
    expect(isComplete({ ...at(8), komanda: 0 }, CRITERIA)).toBe(false);
    expect(isComplete({ ...at(8), komanda: 7.5 }, CRITERIA)).toBe(false);
    expect(isComplete({ ...at(8), teqdimat: 5, tesir: 5 }, CRITERIA)).toBe(true);
  });
});

describe("computeResults", () => {
  it("Demo Day score = mean juror total; final = entry + Demo Day", () => {
    const r = results([team(1, 40), team(2, 50), team(3)], [
      score(1, 1, at(6)), score(2, 1, at(8)),   // 30 and 40 → demo 35, final 75
      score(1, 2, at(4)),                       // 20 → final 70
      score(1, 3, at(10)),                      // 50, no entry → 50
    ]);
    expect(r.ranking.map(x => [x.team.id, x.rank, x.score, x.demo, x.entry])).toEqual([
      [1, 1, 75, 35, 40], [2, 2, 70, 20, 50], [3, 3, 50, 50, null],
    ]);
    const t1 = r.ranking[0];
    expect([t1.n, t1.min, t1.max]).toEqual([2, 30, 40]);
    expect(r.matrix[1]).toEqual({ 1: 30, 2: 40, 3: null });
    expect([r.demoMax, r.maxTotal, r.done, r.need]).toEqual([50, 100, 4, 9]);
  });

  it("can rank by the Demo Day score alone", () => {
    const r = results([team(1, 50), team(2, 0)], [score(1, 1, at(4)), score(1, 2, at(8))], { includeEntry: false });
    expect(r.ranking.map(x => [x.team.id, x.score])).toEqual([[2, 40], [1, 20]]);
    expect(r.maxTotal).toBe(50);
    expect(r.ranking[1].entry).toBe(50); // still reported, just not added
  });

  it("adds an unrounded entry score once (41.666… + 40.666… = 82.33, not 82.34)", () => {
    const plus1 = { ...at(8), bazar: 9 }; // at(8) = 4 + 8 + 8 + 8 + 8 + 4 = 40, so this is 41
    const r = results([team(1, 125 / 3)], [score(1, 1, plus1), score(2, 1, plus1), score(3, 1, at(8))]);
    expect(r.ranking[0].demo).toBe(40.67);
    expect(r.ranking[0].score).toBe(82.33); // rounding entry and demo separately would give 41.67 + 40.67 = 82.34
  });

  it("breaks a tie on the final score by the Demo Day score", () => {
    // A: 50 + 30 = 80; B: 40 + 40 = 80 → B ranks first (better on the day)
    const r = results([team(1, 50), team(2, 40)], [score(1, 1, at(6)), score(1, 2, at(8))]);
    expect(r.ranking.map(x => [x.team.id, x.rank, x.score])).toEqual([[2, 1, 80], [1, 2, 80]]);
  });

  it("then by the highest-maximum criteria in display order", () => {
    const a = { teqdimat: 3, komanda: 9, biznes: 6, mehsul_bazar: 6, bazar: 6, tesir: 3 }; // komanda higher
    const b = { teqdimat: 3, komanda: 6, biznes: 9, mehsul_bazar: 6, bazar: 6, tesir: 3 };
    expect(jurorTotal(a, CRITERIA)).toBe(jurorTotal(b, CRITERIA));
    const r = results([team(1, 40), team(2, 40)], [score(1, 1, b), score(1, 2, a)]);
    expect(r.ranking[0].team.id).toBe(2);
    expect(r.tieBreakKeys).toEqual(["komanda", "biznes", "mehsul_bazar", "bazar", "teqdimat", "tesir"]);
  });

  it("gives a shared rank to a full tie", () => {
    const r = results([team(1, 40), team(2, 40), team(3, 40), team(4)], [score(1, 1, at(7)), score(1, 2, at(7)), score(1, 3, at(5))]);
    expect(r.ranking.map(x => x.rank)).toEqual([1, 1, 3, null]);
  });

  it("ignores incomplete scores, flags thin coverage and puts unscored teams last", () => {
    const { bazar: _b, ...partial } = at(10);
    const r = results([team(1, 50), team(2), team(3)], [score(1, 1, at(9)), score(2, 1, partial), score(1, 2, at(5)), score(2, 2, at(5))],
      { minJurorsForRank: 2 });
    const t1 = r.ranking.find(x => x.team.id === 1)!;
    expect([t1.n, t1.incomplete]).toEqual([1, true]);
    expect(r.ranking.find(x => x.team.id === 2)!.incomplete).toBe(false);
    const last = r.ranking[r.ranking.length - 1];
    expect([last.team.id, last.score, last.rank]).toEqual([3, null, null]);
  });

  it("an entry score alone does not rank a team nobody scored", () => {
    const r = results([team(1, 50)], []);
    expect([r.ranking[0].score, r.ranking[0].rank]).toEqual([null, null]);
  });

  it("skips inactive teams and scores from unknown jurors", () => {
    const r = results([team(1), { ...team(2), active: false }], [score(99, 1, at(10)), score(1, 2, at(10))]);
    expect(r.ranking.map(x => x.team.id)).toEqual([1]);
    expect(r.ranking[0].score).toBeNull();
  });
});

describe("displayParts", () => {
  it("shows parts that add up to the shown total", () => {
    // 46.666… + 43.666… = 90.333… → shown 90.33 = 46.67 + 43.66 (not 43.67, which would add to 90.34)
    expect(displayParts(Math.round((140 / 3 + 131 / 3) * 100) / 100, 140 / 3)).toEqual({ score: "90.33", entry: "46.67", demo: "43.66" });
    expect(displayParts(85, 125 / 3)).toEqual({ score: "85.00", entry: "41.67", demo: "43.33" });
    expect(displayParts(44, null)).toEqual({ score: "44.00", entry: "0.00", demo: "44.00" });
  });
});

describe("band", () => {
  it("matches the original 1–10 bands and scales to 1–5", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => band(v, 10))).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 3, 3]);
    expect([1, 2, 3, 4, 5].map(v => band(v, 5))).toEqual([0, 1, 1, 2, 3]);
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
