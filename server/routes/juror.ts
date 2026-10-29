import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { jurorTotal, MIN_POINTS } from "../../shared/scoring.js";
import { requireRole } from "../auth.js";
import { parseBody, type Ctx } from "../context.js";
import { jurorState } from "../views.js";

const scoreBody = z.object({
  values: z.record(z.string(), z.number().int("Ballar tam ədəd olmalıdır.").min(MIN_POINTS, `Bal ən azı ${MIN_POINTS} olmalıdır.`).max(100)),
  note: z.string().max(2000, "Şərh 2000 simvoldan uzun ola bilməz.").optional().default(""),
});

export function jurorRoutes(app: FastifyInstance, { repo, rt }: Ctx) {
  app.register(async r => {
    r.addHook("preHandler", requireRole("juror"));

    r.get("/api/juror/state", async req => jurorState(repo, req.user!.id));

    r.put<{ Params: { teamId: string } }>("/api/juror/scores/:teamId", async (req, reply) => {
      const ev = repo.getEvent();
      if (ev.locked) return reply.code(423).send({ error: "Qiymətləndirmə koordinator tərəfindən bağlanıb." });
      const teamId = Number(req.params.teamId);
      const team = Number.isInteger(teamId) ? repo.team(teamId) : null;
      if (!team || !team.active) return reply.code(404).send({ error: "Komanda tapılmadı." });
      const body = parseBody(scoreBody, req.body, reply);
      if (!body) return;
      const criteria = repo.criteria();
      const values: Record<string, number> = {};
      for (const c of criteria) {
        const v = body.values[c.key];
        if (v == null) return reply.code(400).send({ error: `“${c.name}” meyarına bal verilməyib.` });
        if (v > c.maxScore) return reply.code(400).send({ error: `“${c.name}” üçün bal ${MIN_POINTS}–${c.maxScore} arası olmalıdır.` });
        values[c.key] = v;
      }
      const total = jurorTotal(values, criteria);
      const note = body.note.trim();
      const { score, created } = repo.upsertScore(req.user!.id, team.id, values, total, note);
      repo.audit(req.user!.id, created ? "score.submit" : "score.update", { teamId: team.id, values, total, note });
      rt.emitScore(score, total, ev.showJurorTotal);
      rt.emitResults();
      return {
        teamId: score.teamId, values: score.values, note: score.note, updatedAt: score.updatedAt,
        ...(ev.showJurorTotal ? { total } : {}),
      };
    });
  });
}
