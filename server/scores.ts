// Saving one juror's score for one team. Shared by the REST route and the juror socket ("score:submit"),
// so both paths validate, audit and broadcast exactly the same way.
//
// v11 reliability — idempotent ops: the juror's phone queues every score with a client-generated `opId` and resends it
// until the server answers (socket ack or HTTP). An op is applied at most once: a resend of an applied op (its answer was
// lost on the way, the server restarted after committing…) returns the stored result and changes nothing. Refused ops
// (scoring closed, invalid input) are kept in score_ops with their values, so nothing a juror entered is ever lost.
import { z } from "zod";
import { jurorTotal, MIN_POINTS } from "../shared/scoring.js";
import type { OrgRealtime } from "./realtime.js";
import type { Repo } from "./repo.js";

export const scoreBody = z.object({
  values: z.record(z.string(), z.number().int("Ballar tam ədəd olmalıdır.").min(MIN_POINTS, `Bal ən azı ${MIN_POINTS} olmalıdır.`).max(100)),
  note: z.string().max(2000, "Şərh 2000 simvoldan uzun ola bilməz.").optional().default(""),
  tags: z.array(z.string().max(80)).max(30).optional().default([]),
});

/** Client op ids: random, URL-safe (crypto.randomUUID() or a fallback), never trusted beyond "same juror, same string". */
export const OP_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type ScoreBody = { teamId: number; values: Record<string, number>; note: string; tags: string[]; updatedAt: number; total?: number | null; opId?: string; duplicate?: boolean };
export type SubmitResult =
  | { ok: true; status: 200; body: ScoreBody }
  | { ok: false; status: number; error: string };

function opOf(raw: unknown): { opId: string | null; clientAt: number | null } {
  const r = (raw ?? {}) as { opId?: unknown; clientAt?: unknown };
  const opId = typeof r.opId === "string" && OP_ID_RE.test(r.opId) ? r.opId : null;
  const clientAt = typeof r.clientAt === "number" && Number.isFinite(r.clientAt) ? Math.round(r.clientAt) : null;
  return { opId, clientAt };
}

export function submitScore(repo: Repo, rt: OrgRealtime, jurorId: number, teamIdRaw: unknown, raw: unknown): SubmitResult {
  const { opId, clientAt } = opOf(raw);
  if (opId) {
    const prev = repo.scoreOp(jurorId, opId);
    if (prev?.status === "applied" && prev.result_json) {
      return { ok: true, status: 200, body: { ...(JSON.parse(prev.result_json) as ScoreBody), opId, duplicate: true } };
    }
  }
  const r = (raw ?? {}) as { values?: unknown; note?: unknown; tags?: unknown };
  const refuse = (status: number, error: string, teamId: number | null): SubmitResult => {
    if (opId) {
      try {
        repo.recordScoreOp({ opId, jurorId, teamId, status: "rejected", httpStatus: status, error, values: r.values, note: typeof r.note === "string" ? r.note : "", tags: r.tags, clientAt });
        repo.audit(jurorId, "score.rejected", { opId, teamId, status, error });
      } catch { /* the refusal itself is what the juror gets back */ }
    }
    return { ok: false, status, error };
  };
  const ev = repo.getEvent();
  const teamId = Number(teamIdRaw);
  if (ev.locked) return refuse(423, "Qiymətləndirmə koordinator tərəfindən bağlanıb.", Number.isInteger(teamId) ? teamId : null);
  const team = Number.isInteger(teamId) ? repo.team(teamId) : null;
  if (!team || !team.active) return refuse(404, "Komanda tapılmadı.", Number.isInteger(teamId) ? teamId : null);
  const parsed = scoreBody.safeParse(raw ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message;
    return refuse(400, msg && !/^(Invalid|Too|Expected|Unrecognized)/i.test(msg) ? msg : "Göndərilən məlumat düzgün deyil.", team.id);
  }
  const body = parsed.data;
  const criteria = repo.criteria();
  const values: Record<string, number> = {};
  for (const c of criteria) {
    const v = body.values[c.key];
    if (v == null) return refuse(400, `“${c.name}” meyarına bal verilməyib.`, team.id);
    if (v > c.maxScore) return refuse(400, `“${c.name}” üçün bal ${MIN_POINTS}–${c.maxScore} arası olmalıdır.`, team.id);
    values[c.key] = v;
  }
  // Only chips from the current list; kept in the list's order.
  const tags = ev.feedbackTags.filter(t => body.tags.includes(t));
  const total = jurorTotal(values, criteria);
  const note = body.note.trim();
  // One transaction: the score, its history row, the audit line and the op record are all there or none of them is.
  const { score, out } = repo.db.transaction(() => {
    const { score, created } = repo.upsertScore(jurorId, team.id, values, total, note, tags);
    repo.recordScore(created ? "submit" : "update", jurorId, team.id, values, total, note, tags);
    repo.audit(jurorId, created ? "score.submit" : "score.update", { teamId: team.id, values, total, note, tags, ...(opId ? { opId } : {}) });
    const out: ScoreBody = { teamId: score.teamId, values: score.values, note: score.note, tags: score.tags, updatedAt: score.updatedAt, ...(ev.showJurorTotal ? { total } : {}) };
    if (opId) repo.recordScoreOp({ opId, jurorId, teamId: team.id, status: "applied", httpStatus: 200, values, note, tags, result: out, clientAt });
    return { score, out };
  })();
  rt.emitScore(score, total, ev.showJurorTotal);
  rt.emitResults();
  return { ok: true, status: 200, body: opId ? { ...out, opId } : out };
}
