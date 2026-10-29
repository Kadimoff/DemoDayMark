// Response builders. The juror view is the privacy boundary: it is assembled from the
// juror's own rows only and never touches computeResults().
import { revealPublic, revealSteps, type RevealSnapshot } from "../shared/reveal.js";
import { computeResults, jurorTotal } from "../shared/scoring.js";
import type { JurorStatePayload } from "../shared/types.js";
import type { Config } from "./config.js";
import type { Repo } from "./repo.js";

export function jurorState(repo: Repo, jurorId: number): JurorStatePayload {
  const me = repo.userById(jurorId)!;
  const ev = repo.getEvent();
  const criteria = repo.criteria();
  return {
    me: { id: me.id, displayName: me.display_name, username: me.username },
    locked: ev.locked,
    showJurorTotal: ev.showJurorTotal,
    stage: repo.stage(),
    // Entry scores are public to jurors (organisers' decision); other jurors' scores and results are not.
    teams: repo.teams().filter(t => t.active),
    entryMax: ev.entryMax,
    criteria,
    myScores: repo.scoresOf(jurorId).map(s => ({
      teamId: s.teamId,
      values: s.values,
      note: s.note,
      updatedAt: s.updatedAt,
      ...(ev.showJurorTotal ? { total: jurorTotal(s.values, criteria) ?? undefined } : {}),
    })),
  };
}

export function adminResults(repo: Repo, cfg: Config) {
  const teams = repo.teams();
  const jurors = repo.jurors();
  const criteria = repo.criteria();
  const scores = repo.scores();
  const ev = repo.getEvent();
  const results = computeResults({
    teams, jurors, criteria, scores, minJurorsForRank: cfg.minJurorsForRank, includeEntry: ev.includeEntry, entryMax: ev.entryMax,
  });
  return {
    results,
    teams,
    jurors,
    criteria,
    scores: scores.map(s => ({ ...s, total: jurorTotal(s.values, criteria) })),
    minJurorsForRank: cfg.minJurorsForRank,
  };
}

export type AdminResults = ReturnType<typeof adminResults>;

/** Freezes the current ranking: the reveal walks this list, whatever happens to scores later. */
export function revealSnapshot(repo: Repo, cfg: Config): RevealSnapshot {
  const { results } = adminResults(repo, cfg);
  return {
    createdAt: Date.now(),
    maxTotal: results.maxTotal,
    entries: results.ranking
      .filter(r => r.score != null && r.rank != null)
      .map(r => ({
        teamId: r.team.id, name: r.team.name, project: r.team.project, rank: r.rank!,
        score: r.score!, demo: r.demo!, entry: results.includeEntry ? r.entry : null, n: r.n,
      })),
  };
}

export const revealPublicView = (repo: Repo) => {
  const r = repo.getReveal();
  return revealPublic(r.snapshot, r.step, r.enabled, repo.getEvent().name);
};

export function revealAdminView(repo: Repo, cfg: Config) {
  const r = repo.getReveal();
  const steps = r.snapshot ? revealSteps(r.snapshot.entries) : [];
  const nextStep = steps[r.step] ?? null;
  const fresh = revealSnapshot(repo, cfg);
  // Has anything that would change the order or the numbers happened since the snapshot?
  const sig = (s: RevealSnapshot | null) => JSON.stringify(s?.entries.map(e => [e.teamId, e.rank, e.score, e.n]) ?? []);
  const { results, teams } = adminResults(repo, cfg);
  return {
    enabled: r.enabled,
    step: r.step,
    stepsTotal: steps.length,
    snapshotAt: r.snapshot?.createdAt ?? null,
    entries: r.snapshot?.entries ?? [],
    next: nextStep ? { ...nextStep, entry: r.snapshot!.entries[nextStep.index] } : null,
    stale: !!r.snapshot && sig(r.snapshot) !== sig(fresh),
    unscored: teams.filter(t => t.active).length - fresh.entries.length,
    progress: { done: results.done, need: results.need },
    locked: repo.getEvent().locked,
    public: revealPublicView(repo),
  };
}
