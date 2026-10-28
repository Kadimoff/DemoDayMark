// Response builders. The juror view is the privacy boundary: it is assembled from the
// juror's own rows only and never touches computeResults().
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
    teams: repo.teams().filter(t => t.active),
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
  const results = computeResults({ teams, jurors, criteria, scores, minJurorsForRank: cfg.minJurorsForRank });
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
