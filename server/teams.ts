// munsif: team sign-in (cookie ij_team, separate from admin/juror sessions), notifications, queue reminders.
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import type { Config } from "./config.js";
import { Converter } from "./files.js";
import type { Realtime } from "./realtime.js";
import type { Repo } from "./repo.js";
import { materials, TeamRepo, prettyCode } from "./teamrepo.js";
import { tokenId } from "./auth.js";
import type { AdminTeamMaterials, Notice, TeamQueue, TeamStatePayload } from "../shared/types.js";

export const TEAM_COOKIE = "ij_team";

export interface TeamAuth { teamId: number; sessionId: string }

declare module "fastify" {
  interface FastifyRequest { team: TeamAuth | null }
}

type Unsign = (v: string) => { valid: boolean; value: string | null };

export function resolveTeam(trepo: TeamRepo, cfg: Config, cookies: Record<string, string | undefined>, unsign: Unsign): TeamAuth | null {
  const raw = cookies[TEAM_COOKIE];
  if (!raw) return null;
  const u = unsign(raw);
  if (!u.valid || !u.value) return null;
  const sid = tokenId(u.value);
  const s = trepo.session(sid);
  if (!s) return null;
  if (Date.now() - s.last_seen_at > cfg.teamSessionTtlMs) { trepo.deleteSession(sid); return null; }
  const t = trepo.row(s.team_id);
  if (!t) return null;
  return { teamId: t.id, sessionId: sid };
}

/** Private / loopback / link-local addresses: the embed check never fetches those (SSRF). */
export function isPrivateIp(a: string) {
  if (net.isIPv6(a)) {
    const s = a.toLowerCase();
    if (s.startsWith("::ffff:")) return isPrivateIp(s.slice(7));
    return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80");
  }
  const [x, y] = a.split(".").map(Number);
  return x === 10 || x === 127 || x === 0 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || x >= 224;
}

/** Can the site be shown in an iframe on the stage? (X-Frame-Options / CSP frame-ancestors) */
export async function checkEmbeddable(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) return false;
    const r = await fetch(u, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(6000), headers: { "User-Agent": "munsif-frame-check/1.0" } });
    try { await r.body?.cancel(); } catch { /* ignore */ }
    if (r.status >= 300 && r.status < 400) return true; // redirect: let the browser try; the stage falls back to the QR card on error
    const xfo = (r.headers.get("x-frame-options") ?? "").toLowerCase();
    const csp = (r.headers.get("content-security-policy") ?? "").toLowerCase();
    if (xfo.includes("deny") || xfo.includes("sameorigin")) return false;
    const fa = /frame-ancestors([^;]*)/.exec(csp);
    if (fa && !/\*(\s|$)/.test(fa[1])) return false;
    return r.status < 400;
  } catch { return false; }
}

export class TeamService {
  readonly converter: Converter;
  /** stage reminders already sent: "<kind>:<teamId>:<stage team id>" */
  private sentStage = new Set<string>();
  private deadlineTimer: NodeJS.Timeout | null = null;

  constructor(readonly trepo: TeamRepo, private repo: Repo, private cfg: Config, private rt: Realtime) {
    this.converter = new Converter(cfg.soffice, cfg.uploadsDir, path.join(cfg.dataDir, "lo-profile"), cfg.sofficeTimeoutMs);
    this.deadlineTimer = setInterval(() => { try { this.deadlineReminders(); } catch { /* db closed */ } }, 60_000);
    this.deadlineTimer.unref();
  }
  close() { if (this.deadlineTimer) clearInterval(this.deadlineTimer); }

  uploadsOpen(teamId: number) {
    const dl = this.repo.getEvent().uploadDeadline;
    if (!dl) return true;
    const t = this.trepo.row(teamId);
    return Date.now() <= Math.max(dl, t?.extend_until ?? 0);
  }

  queue(teamId: number): TeamQueue {
    const list = this.repo.teams().filter(t => t.active);
    const idx = list.findIndex(t => t.id === teamId);
    const cur = this.repo.getEvent().currentTeamId;
    const ci = cur ? list.findIndex(t => t.id === cur) : -1;
    return { position: idx + 1, total: list.length, current: ci + 1, ahead: ci >= 0 && idx > ci ? idx - ci : null, onStage: cur === teamId };
  }

  state(teamId: number): TeamStatePayload {
    const t = this.trepo.row(teamId)!;
    const ev = this.repo.getEvent();
    return {
      team: { id: t.id, name: t.name, project: t.project, active: !!t.active },
      materials: materials(this.trepo.db, t),
      history: this.trepo.history(teamId),
      event: { displayName: ev.displayName, date: ev.date, deadline: ev.uploadDeadline, uploadsOpen: this.uploadsOpen(teamId), canRename: ev.teamCanRename,
        pitchSec: ev.timer.pitchSec, qaSec: ev.timer.qaSec },
      queue: this.queue(teamId),
      notices: this.trepo.notices("team", teamId, 30),
      stage: this.repo.stage(),
      soffice: this.converter.available,
      maxUploadMb: Math.round(this.cfg.maxUploadBytes / 1048576),
    };
  }

  adminList(): AdminTeamMaterials[] {
    return this.repo.teams().map(t => {
      const row = this.trepo.row(t.id)!;
      const link = this.trepo.link(t.id);
      return {
        ...materials(this.trepo.db, row), teamId: t.id, name: t.name, project: t.project, active: t.active, orderIndex: t.orderIndex,
        link: link ? { code: link.code ? prettyCode(link.code) : null, createdAt: link.createdAt } : null,
        sessions: this.trepo.sessionCount(t.id),
      };
    });
  }

  // ---------- notifications ----------
  notifyAdmin(kind: string, title: string, body = "", teamId: number | null = null): Notice {
    const n = this.trepo.addNotice("admin", teamId, kind, title, body);
    this.rt.io.to("admin").emit("notice", n);
    return n;
  }
  notifyTeam(teamId: number, kind: string, title: string, body = ""): Notice {
    const n = this.trepo.addNotice("team", teamId, kind, title, body);
    this.rt.io.to(`team:${teamId}`).emit("notice", n);
    return n;
  }
  /** Team data changed: the team's own panel and the admin lists refetch. */
  changed(teamId: number) {
    this.rt.io.to(`team:${teamId}`).emit("team:changed");
    this.rt.io.to("admin").emit("materials:changed", { teamId });
  }

  /** Called after the team on stage changed: "Səhnəyə dəvət olunursunuz" / "Növbəti sizsiniz" / "Sıranız yaxınlaşır". */
  stageReminders() {
    const list = this.repo.teams().filter(t => t.active);
    const cur = this.repo.getEvent().currentTeamId;
    const ci = cur ? list.findIndex(t => t.id === cur) : -1;
    if (ci < 0) return;
    const send = (offset: number, kind: string, title: string, body: string) => {
      const t = list[ci + offset];
      if (!t) return;
      const key = `${kind}:${t.id}:${cur}`;
      if (this.sentStage.has(key)) return;
      this.sentStage.add(key);
      // moving the stage back and forth (or a restart) must not repeat the same reminder within 30 minutes
      if (this.trepo.sentSince(t.id, kind, Date.now() - 30 * 60_000)) return;
      this.notifyTeam(t.id, kind, title, body);
    };
    send(0, "stage.invite", "Səhnəyə dəvət olunursunuz", `${list[ci].name}, sıra sizdədir — səhnəyə buyurun!`);
    send(1, "stage.next", "Növbəti sizsiniz", "Sizdən əvvəl 1 komanda qalıb. Hazır olun.");
    send(2, "stage.soon", "Sıranız yaxınlaşır", "Sizdən əvvəl 2 komanda qalıb. Səhnə arxasına yaxınlaşın.");
    for (const t of list) this.rt.io.to(`team:${t.id}`).emit("team:changed");
  }

  /** One reminder an hour before the upload deadline to teams without a presentation. */
  deadlineReminders(now = Date.now()) {
    const dl = this.repo.getEvent().uploadDeadline;
    if (!dl || now > dl || dl - now > 3600_000) return;
    for (const t of this.repo.teams()) {
      if (this.trepo.activeFile(t.id, "presentation")) continue;
      if (this.trepo.sentSince(t.id, "deadline", dl - 2 * 3600_000)) continue;
      const min = Math.max(1, Math.round((dl - now) / 60000));
      this.notifyTeam(t.id, "deadline", "Deadline yaxınlaşır", `Prezentasiya yükləməyə ${min} dəqiqə qalıb.`);
    }
  }
}
