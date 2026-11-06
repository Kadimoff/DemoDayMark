// Saving one juror's score for one team. Shared by the REST route and the juror socket ("score:submit"),
// so both paths validate, audit and broadcast exactly the same way.
import { z } from "zod";
import { jurorTotal, MIN_POINTS } from "../shared/scoring.js";
import type { Realtime } from "./realtime.js";
import type { Repo } from "./repo.js";

export const scoreBody = z.object({
  values: z.record(z.string(), z.number().int("Ballar tam ədəd olmalıdır.").min(MIN_POINTS, `Bal ən azı ${MIN_POINTS} olmalıdır.`).max(100)),
  note: z.string().max(2000, "Şərh 2000 simvoldan uzun ola bilməz.").optional().default(""),
  tags: z.array(z.string().max(80)).max(30).optional().default([]),
});

export type SubmitResult =
  | { ok: true; status: 200; body: { teamId: number; values: Record<string, number>; note: string; tags: string[]; updatedAt: number; total?: number | null } }
  | { ok: false; status: number; error: string };

export function submitScore(repo: Repo, rt: Realtime, jurorId: number, teamIdRaw: unknown, raw: unknown): SubmitResult {
  const ev = repo.getEvent();
  if (ev.locked) return { ok: false, status: 423, error: "Qiymətləndirmə koordinator tərəfindən bağlanıb." };
  const teamId = Number(teamIdRaw);
  const team = Number.isInteger(teamId) ? repo.team(teamId) : null;
  if (!team || !team.active) return { ok: false, status: 404, error: "Komanda tapılmadı." };
  const parsed = scoreBody.safeParse(raw ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message;
    return { ok: false, status: 400, error: msg && !/^(Invalid|Too|Expected|Unrecognized)/i.test(msg) ? msg : "Göndərilən məlumat düzgün deyil." };
  }
  const body = parsed.data;
  const criteria = repo.criteria();
  const values: Record<string, number> = {};
  for (const c of criteria) {
    const v = body.values[c.key];
    if (v == null) return { ok: false, status: 400, error: `“${c.name}” meyarına bal verilməyib.` };
    if (v > c.maxScore) return { ok: false, status: 400, error: `“${c.name}” üçün bal ${MIN_POINTS}–${c.maxScore} arası olmalıdır.` };
    values[c.key] = v;
  }
  // Only chips from the current list; kept in the list's order.
  const tags = ev.feedbackTags.filter(t => body.tags.includes(t));
  const total = jurorTotal(values, criteria);
  const note = body.note.trim();
  const { score, created } = repo.upsertScore(jurorId, team.id, values, total, note, tags);
  repo.audit(jurorId, created ? "score.submit" : "score.update", { teamId: team.id, values, total, note, tags });
  rt.emitScore(score, total, ev.showJurorTotal);
  rt.emitResults();
  return {
    ok: true, status: 200,
    body: { teamId: score.teamId, values: score.values, note: score.note, tags: score.tags, updatedAt: score.updatedAt, ...(ev.showJurorTotal ? { total } : {}) },
  };
}
