import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth.js";
import type { Ctx } from "../context.js";
import { submitScore } from "../scores.js";
import { jurorState } from "../views.js";

export function jurorRoutes(app: FastifyInstance, { repo, rt }: Ctx) {
  app.register(async r => {
    r.addHook("preHandler", requireRole("juror"));

    r.get("/api/juror/state", async req => jurorState(repo, req.user!.id));

    // Fallback path; the juror panel normally submits over its socket (see Realtime "score:submit").
    r.put<{ Params: { teamId: string } }>("/api/juror/scores/:teamId", async (req, reply) => {
      const res = submitScore(repo, rt, req.user!.id, req.params.teamId, req.body);
      if (!res.ok) return reply.code(res.status).send({ error: res.error });
      return res.body;
    });
  });
}
