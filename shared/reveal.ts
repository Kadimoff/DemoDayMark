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
}

/** Reads snapshots saved by older versions (which stored `avg` on a 0–100 scale). */
export function normalizeSnapshot(raw: unknown): RevealSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as { createdAt?: number; entries?: Array<Record<string, unknown>>; maxTotal?: number };
  if (!Array.isArray(s.entries)) return null;
  return {
    createdAt: Number(s.createdAt ?? 0),
    maxTotal: Number(s.maxTotal ?? 100),
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

/** One admin click. Top-3 places take two clicks: suspense first, then the reveal. */
export interface RevealStep {
  kind: "suspense" | "reveal";
  /** Index into snapshot.entries (0 = winner). */
  index: number;
}

export const SPECIAL_RANKS = 3;

export function revealSteps(entries: RevealEntry[]): RevealStep[] {
  const steps: RevealStep[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].rank <= SPECIAL_RANKS) steps.push({ kind: "suspense", index: i });
    steps.push({ kind: "reveal", index: i });
  }
  return steps;
}

export interface RevealedEntry extends RevealEntry { index: number }

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
}

export function revealPublic(snapshot: RevealSnapshot | null, step: number, enabled: boolean, eventName: string): RevealPublic {
  if (!enabled || !snapshot) {
    return { enabled: false, eventName, total: 0, maxTotal: 0, step: 0, stepsTotal: 0, revealed: [], suspense: null, last: null, done: false };
  }
  const steps = revealSteps(snapshot.entries);
  const s = Math.max(0, Math.min(step, steps.length));
  const done = steps.slice(0, s);
  const revealed = done
    .filter(x => x.kind === "reveal")
    .map(x => ({ ...snapshot.entries[x.index], index: x.index }));
  const last = done[done.length - 1] ?? null;
  return {
    enabled: true,
    eventName,
    total: snapshot.entries.length,
    maxTotal: snapshot.maxTotal,
    step: s,
    stepsTotal: steps.length,
    revealed,
    suspense: last?.kind === "suspense" ? { index: last.index, rank: snapshot.entries[last.index].rank } : null,
    last,
    done: s === steps.length && steps.length > 0,
  };
}

/** "1-ci", "3-cü", "6-cı", "10-cu": Azerbaijani ordinal suffix by vowel harmony of the spoken number. */
export function ordinal(n: number): string {
  const d = n % 10, t = Math.floor(n / 10) % 10;
  const byDigit = ["", "ci", "ci", "cü", "cü", "ci", "cı", "ci", "ci", "cu"]; // bir iki üç dörd beş altı yeddi səkkiz doqquz
  const byTens = ["cü", "cu", "ci", "cu", "cı", "ci", "cı", "ci", "ci", "cı"]; // yüz on iyirmi otuz qırx əlli altmış yetmiş səksən doxsan
  return `${n}-${d ? byDigit[d] : byTens[t]}`;
}
