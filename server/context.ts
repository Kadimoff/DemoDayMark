import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { LoginLimiter } from "./auth.js";
import type { Config } from "./config.js";
import type { Converter } from "./files.js";
import { ROOT_ORG_ID, type Orgs, type Scope } from "./orgs.js";
import type { Realtime } from "./realtime.js";
import type { HealthDeps } from "./health.js";

export interface Ctx {
  cfg: Config;
  /** Socket.IO server; per-organisation broadcasts go through scope.rt. */
  rt: Realtime;
  limiter: LoginLimiter;
  /** orgs: organisations and their data scopes. */
  orgs: Orgs;
  converter: Converter;
  /** v11: health / system status sources (database, backups, sockets, event loop). */
  sys: HealthDeps;
}

/** orgs: the organisation of the signed-in admin / juror (or the team session). Route guards ran before this. */
/**
 * The address people outside reach (first configured origin, else this request's host). Links and QR codes are built
 * from it everywhere, so a coordinator who opened the panel on another host still hands out working links.
 */
export function publicOrigin(cfg: Pick<Config, "origins">, req: FastifyRequest) {
  return (cfg.origins[0] ?? `${req.protocol}://${(req.headers["x-forwarded-host"] as string) || req.headers.host}`).replace(/\/$/, "");
}

export function scopeOf(ctx: Ctx, req: FastifyRequest): Scope {
  const id = req.user?.orgId ?? req.team?.orgId;
  if (id == null) throw new Error("scopeOf: no session");
  return ctx.orgs.scope(id);
}

/**
 * orgs: public screens (/timer, /stage, /reveal, team registration): ?org=<slug>, else the default organisation
 * (so the old projector links keep showing what they always showed). Unknown or deactivated slug → null (404).
 */
export function publicScope(ctx: Ctx, req: FastifyRequest): Scope | null {
  const slug = (req.query as Record<string, unknown> | undefined)?.org;
  if (typeof slug !== "string" || !slug) return ctx.orgs.scope(ROOT_ORG_ID);
  const o = ctx.orgs.bySlug(slug);
  return o && o.active ? ctx.orgs.scope(o.id) : null;
}

const FIELD_AZ: Record<string, string> = {
  username: "İstifadəçi adı", password: "Şifrə", displayName: "Görünən ad", name: "Ad", project: "Layihə",
  description: "İzah", note: "Şərh", values: "Ballar", date: "Tarix", ids: "Sıra",
  pitchSec: "Təqdimat müddəti", qaSec: "Sual-cavab müddəti", currentTeamId: "Komanda", token: "Təsdiq kodu",
  maxScore: "Maksimum bal", entryScore: "Giriş balı", entryMax: "Giriş balının maksimumu", includeEntry: "Giriş balı",
  members: "Üzvlər", siteUrl: "Sayt linki", videoUrl: "Video linki", code: "Kod", slide: "Slayd", mode: "Rejim", uploadDeadline: "Deadline",
};

/** Validates with zod; on failure replies 400 with a readable Azerbaijani message and returns null. */
export function parseBody<T extends z.ZodType>(schema: T, data: unknown, reply: FastifyReply): z.infer<T> | null {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const field = String(issue?.path?.[0] ?? "");
  const label = FIELD_AZ[field] ?? field;
  const custom = issue?.message && !/^(Invalid|Too|Expected|Unrecognized)/i.test(issue.message) ? issue.message : null;
  reply.code(400).send({ error: custom ?? (label ? `“${label}” sahəsi düzgün doldurulmayıb.` : "Göndərilən məlumat düzgün deyil.") });
  return null;
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });
