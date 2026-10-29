import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { LoginLimiter } from "./auth.js";
import type { Config } from "./config.js";
import type { Realtime } from "./realtime.js";
import type { Repo } from "./repo.js";

export interface Ctx {
  repo: Repo;
  cfg: Config;
  rt: Realtime;
  limiter: LoginLimiter;
}

const FIELD_AZ: Record<string, string> = {
  username: "İstifadəçi adı", password: "Şifrə", displayName: "Görünən ad", name: "Ad", project: "Layihə",
  description: "İzah", note: "Şərh", values: "Ballar", date: "Tarix", ids: "Sıra",
  pitchSec: "Pitch müddəti", qaSec: "Sual-cavab müddəti", currentTeamId: "Komanda", token: "Təsdiq kodu",
  maxScore: "Maksimum bal", entryScore: "Giriş balı", entryMax: "Giriş balının maksimumu", includeEntry: "Giriş balı",
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
