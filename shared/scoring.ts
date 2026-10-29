// Pure scoring math. Every number shown in the admin panel, Excel, PDF and the reveal comes from here.
//
// Points model:
//   juror total (Demo Day)  = Σ points over all criteria          (max = Σ maxScore, e.g. 50)
//   team Demo Day score     = mean of complete juror totals
//   team final score        = entry score + Demo Day score         (when entry is included, max e.g. 50 + 50)
import type { AdminTeam, Criterion, Juror, ScoreRow, ScoreValues } from "./types.js";

export const MIN_POINTS = 1;
export const round2 = (n: number) => Math.round(n * 100) / 100;

export const demoMax = (criteria: Criterion[]) => criteria.reduce((a, c) => a + c.maxScore, 0);

/** Scores are shown with the same 2 decimals the ranking uses. */
export const fmt2 = (n: number | null | undefined) => (n == null ? "—" : round2(n).toFixed(2));

/**
 * Entry + Demo Day as displayed next to a final score: the Demo Day part is derived from the rounded total
 * and the rounded entry, so "41.67 + 43.33 = 85.00" always adds up on screen and on paper.
 */
export function displayParts(score: number, entry: number | null) {
  const s = round2(score), e = round2(entry ?? 0);
  return { score: s.toFixed(2), entry: e.toFixed(2), demo: round2(s - e).toFixed(2) };
}

export function isComplete(values: ScoreValues | null | undefined, criteria: Criterion[]): boolean {
  if (!values || !criteria.length) return false;
  return criteria.every(c => {
    const v = values[c.key];
    return Number.isInteger(v) && v >= MIN_POINTS && v <= c.maxScore;
  });
}

/** Σ points. Null when any criterion is missing or out of its 1..maxScore range. */
export function jurorTotal(values: ScoreValues | null | undefined, criteria: Criterion[]): number | null {
  if (!isComplete(values, criteria)) return null;
  return criteria.reduce((a, c) => a + values![c.key], 0);
}

export interface RankedTeam {
  team: AdminTeam;
  rank: number | null;
  /** Ranking value: entry + demo (or demo alone when entry is not included). */
  score: number | null;
  /** Mean of complete juror totals. */
  demo: number | null;
  /** Entry score as stored (null = not set; counted as 0 when included). */
  entry: number | null;
  n: number;
  /** Lowest / highest single juror total. */
  min: number | null;
  max: number | null;
  perCriterion: Record<string, number | null>;
  /** Fewer complete juror scores than MIN_JURORS_FOR_RANK. */
  incomplete: boolean;
}

export interface Results {
  ranking: RankedTeam[];
  /** teamId → jurorId → juror total (null when missing or incomplete) */
  matrix: Record<number, Record<number, number | null>>;
  done: number;
  need: number;
  tieBreakKeys: string[];
  /** Max of a juror total / team Demo Day score. */
  demoMax: number;
  /** Max of the final score. */
  maxTotal: number;
  includeEntry: boolean;
  entryMax: number;
}

export interface ResultsInput {
  teams: AdminTeam[];
  jurors: Juror[];
  criteria: Criterion[];
  scores: ScoreRow[];
  minJurorsForRank: number;
  includeEntry: boolean;
  entryMax: number;
}

export function computeResults({ teams, jurors, criteria, scores, minJurorsForRank, includeEntry, entryMax }: ResultsInput): Results {
  const activeTeams = teams.filter(t => t.active).sort((a, b) => a.orderIndex - b.orderIndex);
  const jurorIds = new Set(jurors.map(j => j.id));
  // Tie-break after the Demo Day score: highest max-points criterion first; equal maxima keep display order.
  const tieBreakKeys = [...criteria]
    .sort((a, b) => b.maxScore - a.maxScore || a.orderIndex - b.orderIndex)
    .map(c => c.key);

  const byTeam = new Map<number, ScoreRow[]>();
  for (const s of scores) {
    if (!jurorIds.has(s.jurorId)) continue;
    const list = byTeam.get(s.teamId) ?? [];
    list.push(s);
    byTeam.set(s.teamId, list);
  }

  const matrix: Results["matrix"] = {};
  let done = 0;
  const rows = activeTeams.map((team, i) => {
    matrix[team.id] = {};
    for (const j of jurors) matrix[team.id][j.id] = null;
    const complete = (byTeam.get(team.id) ?? []).filter(s => isComplete(s.values, criteria));
    const totals = complete.map(s => {
      const t = jurorTotal(s.values, criteria)!;
      matrix[team.id][s.jurorId] = t;
      return t;
    });
    const n = totals.length;
    done += n;
    const perCriterion: Record<string, number | null> = {};
    for (const c of criteria) {
      perCriterion[c.key] = n ? round2(complete.reduce((a, s) => a + s.values[c.key], 0) / n) : null;
    }
    const demoExact = n ? totals.reduce((a, b) => a + b, 0) / n : null;
    const entry = team.entryScore ?? null;
    return {
      team,
      order: i,
      rank: null as number | null,
      // Sum before rounding so 41.666… + 43.2 rounds once, not twice.
      score: demoExact == null ? null : round2(demoExact + (includeEntry ? entry ?? 0 : 0)),
      demo: demoExact == null ? null : round2(demoExact),
      entry,
      n,
      min: n ? Math.min(...totals) : null,
      max: n ? Math.max(...totals) : null,
      perCriterion,
      incomplete: n < minJurorsForRank,
    };
  });

  const cmp = (a: (typeof rows)[number], b: (typeof rows)[number]) => {
    if (a.score == null || b.score == null) return 0;
    if (b.score !== a.score) return b.score - a.score;
    if ((b.demo ?? 0) !== (a.demo ?? 0)) return (b.demo ?? 0) - (a.demo ?? 0);
    for (const k of tieBreakKeys) {
      const d = (b.perCriterion[k] ?? 0) - (a.perCriterion[k] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  const sorted = [...rows].sort((a, b) => {
    if (a.score == null && b.score == null) return a.order - b.order;
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    return cmp(a, b) || a.order - b.order;
  });
  // Teams tied on score, Demo Day score and every tie-break criterion share a rank (1, 2, 2, 4).
  sorted.forEach((x, k) => {
    if (x.score == null) return;
    const prev = sorted[k - 1];
    x.rank = prev && prev.rank != null && cmp(prev, x) === 0 ? prev.rank : k + 1;
  });

  const dMax = demoMax(criteria);
  return {
    ranking: sorted.map(({ order: _order, ...r }) => r),
    matrix,
    done,
    need: activeTeams.length * jurors.filter(j => j.active).length,
    tieBreakKeys,
    demoMax: dMax,
    maxTotal: dMax + (includeEntry ? entryMax : 0),
    includeEntry,
    entryMax,
  };
}

/** Score bands for a 1..max scale (zəif / orta / güclü / əla), proportional to the 1–10 original. */
export function band(v: number, max: number): 0 | 1 | 2 | 3 {
  const r = v / max;
  return r <= 0.3 ? 0 : r <= 0.6 ? 1 : r <= 0.8 ? 2 : 3;
}
