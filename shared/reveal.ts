// Results reveal: the order of steps and what the public screen may see at each step.
// Pure functions, shared by the server (which decides what to send) and the screens.

export interface RevealEntry {
  teamId: number;
  name: string;
  project: string;
  rank: number;
  /** Final score (entry + Demo Day when entry is included). */
  score: number;
  /** Demo Day score (mean juror total). */
  demo: number;
  /** Entry score, null when not set or not part of the final score. */
  entry: number | null;
  n: number;
}

export interface RevealSnapshot {
  createdAt: number;
  /** Best first; only teams that have a score. */
  entries: RevealEntry[];
  /** Scale of `score` (e.g. 100), for bars. */
  maxTotal: number;
  /** Places 1..top get a suspense step before their reveal (frozen with the ranking). */
  top: number;
  /** Places below the top are revealed this many per click (1 = one by one). */
  batch: number;
  /** True when the jurors' final decision (admin's order) replaced the score order. */
  manual: boolean;
}

/** Reads snapshots saved by older versions (which stored `avg` on a 0–100 scale). */
export function normalizeSnapshot(raw: unknown): RevealSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as { createdAt?: number; entries?: Array<Record<string, unknown>>; maxTotal?: number };
  if (!Array.isArray(s.entries)) return null;
  return {
    createdAt: Number(s.createdAt ?? 0),
    maxTotal: Number(s.maxTotal ?? 100),
    top: clampTop((s as { top?: unknown }).top ?? SPECIAL_RANKS),
    batch: clampBatch((s as { batch?: unknown }).batch ?? 1),
    manual: !!(s as { manual?: unknown }).manual,
    entries: s.entries.map(e => ({
      teamId: Number(e.teamId),
      name: String(e.name ?? ""),
      project: String(e.project ?? ""),
      rank: Number(e.rank),
      score: Number(e.score ?? e.avg ?? 0),
      demo: Number(e.demo ?? e.avg ?? 0),
      entry: e.entry == null ? null : Number(e.entry),
      n: Number(e.n ?? 0),
    })),
  };
}

/**
 * One admin click. The top places (3 by default) take two clicks: suspense first, then the reveal.
 * Lower places may be revealed several at once (`indices`, worst place first).
 */
export interface RevealStep {
  kind: "suspense" | "reveal";
  /** Index into snapshot.entries (0 = winner); for a group, its best-placed entry. */
  index: number;
  /** Every entry this step reveals (a single [index] unless batched). */
  indices: number[];
}

export const SPECIAL_RANKS = 3;
export const MAX_TOP = 10;
export const MAX_BATCH = 10;
export const clampTop = (v: unknown) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_TOP, n)) : SPECIAL_RANKS;
};
export const clampBatch = (v: unknown) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_BATCH, n)) : 1;
};

export function revealSteps(entries: RevealEntry[], top = SPECIAL_RANKS, batch = 1): RevealStep[] {
  const steps: RevealStep[] = [];
  let group: number[] = [];
  const flush = () => { if (group.length) steps.push({ kind: "reveal", index: group[group.length - 1], indices: group }); group = []; };
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].rank <= top) {
      flush();
      steps.push({ kind: "suspense", index: i, indices: [i] });
      steps.push({ kind: "reveal", index: i, indices: [i] });
      continue;
    }
    group.push(i);
    if (group.length >= batch) flush();
  }
  flush();
  return steps;
}

/** A revealed place as the public screen sees it. Scores are null when the admin hides them. */
export interface RevealedEntry extends Omit<RevealEntry, "score" | "demo" | "entry"> {
  index: number;
  score: number | null;
  demo: number | null;
  entry: number | null;
}

/** Everything the public /reveal screen receives. Unrevealed teams never appear here. */
export interface RevealPublic {
  enabled: boolean;
  eventName: string;
  /** Number of places (slots) — 0 until the admin enables the reveal. */
  total: number;
  /** Scale of the scores, for bars (0 while disabled). */
  maxTotal: number;
  step: number;
  stepsTotal: number;
  revealed: RevealedEntry[];
  /** Place currently in suspense: its slot and rank only, never the team. */
  suspense: { index: number; rank: number } | null;
  /** The step that produced this state, so screens can animate just that change. */
  last: RevealStep | null;
  done: boolean;
  /** Scores were removed by the server (admin's "hide scores" switch). */
  hideScores: boolean;
  /** Places 1..top get the suspense ceremony. */
  top: number;
  /** The order is the jurors' final decision rather than the score order. */
  manual: boolean;
}

export function revealPublic(snapshot: RevealSnapshot | null, step: number, enabled: boolean, eventName: string, hideScores = false): RevealPublic {
  if (!enabled || !snapshot) {
    return { enabled: false, eventName, total: 0, maxTotal: 0, step: 0, stepsTotal: 0, revealed: [], suspense: null, last: null, done: false,
      hideScores, top: 0, manual: false };
  }
  const steps = revealSteps(snapshot.entries, snapshot.top, snapshot.batch);
  const s = Math.max(0, Math.min(step, steps.length));
  const done = steps.slice(0, s);
  const revealed: RevealedEntry[] = done
    .filter(x => x.kind === "reveal")
    .flatMap(x => x.indices)
    .map(i => {
      const e = snapshot.entries[i];
      return hideScores ? { ...e, index: i, score: null, demo: null, entry: null } : { ...e, index: i };
    });
  const last = done[done.length - 1] ?? null;
  return {
    enabled: true,
    eventName,
    total: snapshot.entries.length,
    maxTotal: hideScores ? 0 : snapshot.maxTotal,
    step: s,
    stepsTotal: steps.length,
    revealed,
    suspense: last?.kind === "suspense" ? { index: last.index, rank: snapshot.entries[last.index].rank } : null,
    last,
    done: s === steps.length && steps.length > 0,
    hideScores,
    top: snapshot.top,
    manual: snapshot.manual,
  };
}

/**
 * Applies the jurors' final decision: the admin's team order replaces the score order (rank = position).
 * Teams missing from `order` keep their score order after the listed ones.
 */
export function applyFinalOrder(entries: RevealEntry[], order: number[] | null): { entries: RevealEntry[]; manual: boolean } {
  if (!order?.length) return { entries, manual: false };
  const pos = new Map(order.map((id, i) => [id, i]));
  const sorted = [...entries].sort((a, b) => (pos.get(a.teamId) ?? 1e6 + a.rank) - (pos.get(b.teamId) ?? 1e6 + b.rank));
  const changed = sorted.some((e, i) => e.teamId !== entries[i]?.teamId);
  return { entries: sorted.map((e, i) => ({ ...e, rank: i + 1 })), manual: changed };
}

/** "1-ci", "3-cü", "6-cı", "10-cu": Azerbaijani ordinal suffix by vowel harmony of the spoken number. */
export function ordinal(n: number): string {
  const d = n % 10, t = Math.floor(n / 10) % 10;
  const byDigit = ["", "ci", "ci", "cü", "cü", "ci", "cı", "ci", "ci", "cu"]; // bir iki üç dörd beş altı yeddi səkkiz doqquz
  const byTens = ["cü", "cu", "ci", "cu", "cı", "ci", "cı", "ci", "ci", "cı"]; // yüz on iyirmi otuz qırx əlli altmış yetmiş səksən doxsan
  return `${n}-${d ? byDigit[d] : byTens[t]}`;
}
