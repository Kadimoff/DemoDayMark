import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth.js";
import { scopeOf, type Ctx } from "../context.js";
import { jurorState } from "../views.js";

export function jurorRoutes(app: FastifyInstance, ctx: Ctx) {
  app.register(async r => {
    r.addHook("preHandler", requireRole("juror"));

    r.get("/api/juror/state", async req => jurorState(scopeOf(ctx, req).repo, req.user!.id));

    // Fallback path; the juror panel normally submits over its socket (see Realtime "score:submit").
    r.put<{ Params: { teamId: string } }>("/api/juror/scores/:teamId", async (req, reply) => {
      const { repo, rt } = scopeOf(ctx, req);
      const res = await ctx.rt.writer.submit(repo, rt, req.user!.id, req.params.teamId, req.body);
      if (!res.ok) return reply.code(res.status).send({ error: res.error });
      return res.body;
    });
  });
}
