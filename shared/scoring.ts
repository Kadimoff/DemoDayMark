// Pure scoring math. Every number shown in the admin panel, Excel and PDF comes from here.
import type { Criterion, Juror, ScoreRow, ScoreValues, Team } from "./types.js";

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function isComplete(values: ScoreValues | null | undefined, criteria: Criterion[]): boolean {
  if (!values || !criteria.length) return false;
  return criteria.every(c => {
    const v = values[c.key];
    return Number.isInteger(v) && v >= 1 && v <= 10;
  });
}

/** Σ(score × weight) / Σ weight × 10 → 0..100. Null when any criterion is missing. */
export function jurorTotal(values: ScoreValues | null | undefined, criteria: Criterion[]): number | null {
  if (!isComplete(values, criteria)) return null;
  const sw = criteria.reduce((a, c) => a + c.weight, 0);
  if (sw <= 0) return null;
  const sum = criteria.reduce((a, c) => a + values![c.key] * c.weight, 0);
  return round2((sum / sw) * 10);
}

export interface RankedTeam {
  team: Team;
  rank: number | null;
  avg: number | null;
  n: number;
  min: number | null;
  max: number | null;
  perCriterion: Record<string, number | null>;
  /** Fewer complete juror scores than MIN_JURORS_FOR_RANK. */
  incomplete: boolean;
}

export interface Results {
  ranking: RankedTeam[];
  /** teamId → jurorId → total (null when missing or incomplete) */
  matrix: Record<number, Record<number, number | null>>;
  done: number;
  need: number;
  tieBreakKeys: string[];
}

export interface ResultsInput {
  teams: Team[];
  jurors: Juror[];
  criteria: Criterion[];
  scores: ScoreRow[];
  minJurorsForRank: number;
}

export function computeResults({ teams, jurors, criteria, scores, minJurorsForRank }: ResultsInput): Results {
  const activeTeams = teams.filter(t => t.active).sort((a, b) => a.orderIndex - b.orderIndex);
  const jurorIds = new Set(jurors.map(j => j.id));
  // Highest weight first; equal weights keep their display order.
  const tieBreakKeys = [...criteria]
    .sort((a, b) => b.weight - a.weight || a.orderIndex - b.orderIndex)
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
    return {
      team,
      order: i,
      rank: null as number | null,
      avg: n ? round2(totals.reduce((a, b) => a + b, 0) / n) : null,
      n,
      min: n ? Math.min(...totals) : null,
      max: n ? Math.max(...totals) : null,
      perCriterion,
      incomplete: n < minJurorsForRank,
    };
  });

  const cmp = (a: (typeof rows)[number], b: (typeof rows)[number]) => {
    if (a.avg == null || b.avg == null) return 0;
    if (b.avg !== a.avg) return b.avg - a.avg;
    for (const k of tieBreakKeys) {
      const d = (b.perCriterion[k] ?? 0) - (a.perCriterion[k] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  const sorted = [...rows].sort((a, b) => {
    if (a.avg == null && b.avg == null) return a.order - b.order;
    if (a.avg == null) return 1;
    if (b.avg == null) return -1;
    return cmp(a, b) || a.order - b.order;
  });
  // Teams that tie on the average and on every tie-break criterion share a rank (1, 2, 2, 4).
  sorted.forEach((x, k) => {
    if (x.avg == null) return;
    const prev = sorted[k - 1];
    x.rank = prev && prev.rank != null && cmp(prev, x) === 0 ? prev.rank : k + 1;
  });

  return {
    ranking: sorted.map(({ order: _order, ...r }) => r),
    matrix,
    done,
    need: activeTeams.length * jurors.filter(j => j.active).length,
    tieBreakKeys,
  };
}
