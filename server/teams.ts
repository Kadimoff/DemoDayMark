// munsif: team sign-in (cookie ij_team, separate from admin/juror sessions), notifications, queue reminders.
import dns from "node:dns/promises";
import net from "node:net";
import type { Config } from "./config.js";
import type { Converter } from "./files.js";
import type { OrgRealtime } from "./realtime.js";
import type { Repo } from "./repo.js";
import { materials, TeamRepo, prettyCode, teamRow } from "./teamrepo.js";
import { activeEventOf, orgActive } from "./auth.js";
import { tokenId } from "./auth.js";
import type { AdminTeamMaterials, Notice, TeamQueue, TeamStatePayload } from "../shared/types.js";

export const TEAM_COOKIE = "ij_team";

export interface TeamAuth { teamId: number; sessionId: string; /** orgs */ orgId: number }

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
  const t = teamRow(trepo.db, s.team_id);
  if (!t) return null;
  // orgs: a deactivated organisation signs its teams out as well
  if (!orgActive(trepo, t.org_id)) return null;
  // v3 events: teams of an archived event are signed out
  if (t.event_id !== activeEventOf(trepo, t.org_id)) return null;
  return { teamId: t.id, sessionId: sid, orgId: t.org_id };
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

/** One organisation's team features (orgs: one instance per Scope; the PPTX converter is shared). */
export class TeamService {
  /** stage reminders already sent: "<kind>:<teamId>:<stage team id>" */
  private sentStage = new Set<string>();

  constructor(readonly trepo: TeamRepo, private repo: Repo, private cfg: Config, private rt: OrgRealtime, readonly converter: Converter) {
    rt.afterStage = () => this.stageReminders();
  }

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
        renamesLeft: ev.teamRenameLimit == null ? null : Math.max(0, ev.teamRenameLimit - (t.renames ?? 0)),
        pitchSec: ev.timer.pitchSec, qaSec: ev.timer.qaSec, extendedUntil: t.extend_until && (!ev.uploadDeadline || t.extend_until > ev.uploadDeadline) ? t.extend_until : null },
      slideControl: this.slidePermission(teamId),
      queue: this.queue(teamId),
      notices: this.trepo.notices("team", teamId, 30),
      stage: this.repo.stage(),
      soffice: this.converter.available,
      maxUploadMb: Math.round(this.cfg.maxUploadBytes / 1048576),
      code: (() => { const c = this.trepo.link(teamId)?.code; return c ? prettyCode(c) : null; })(),
    };
  }

  /**
   * v3: may this team turn the slides on the projector now? Only while its own presentation is on stage (team scene,
   * slides view) and the coordinator has not switched the right off. Checked on every request by the server.
   */
  slidePermission(teamId: number): TeamStatePayload["slideControl"] {
    const ev = this.repo.getEvent();
    const st = this.repo.stage();
    const pages = st.show.pres?.pages ?? null;
    const no = (reason: string) => ({ allowed: false, reason, slide: ev.stageSlide, pages });
    if (ev.currentTeamId !== teamId) return no("Növbəniz çatıb səhnəyə çıxanda slaydları buradan çevirə biləcəksiniz.");
    if (ev.stageScene !== "team") return no("İndi səhnə ekranında proqramın öz prezentasiyası göstərilir.");
    if (!ev.teamSlideControl) return no("Slaydları koordinator çevirir.");
    if (!st.show.pres) return no(st.show.presPending ? "Prezentasiyanız hələ hazırlanır (PDF-ə çevrilir)." : "Səhnədə prezentasiyanız yoxdur.");
    if (ev.stageMode !== "auto") return no("İndi səhnə ekranında taymer və ya sayt göstərilir.");
    return { allowed: true, reason: null, slide: ev.stageSlide, pages };
  }

  adminList(): AdminTeamMaterials[] {
    return this.repo.teams().map(t => {
      const row = this.trepo.row(t.id)!;
      const link = this.trepo.link(t.id);
      return {
        ...materials(this.trepo.db, row), teamId: t.id, name: t.name, project: t.project, active: t.active, orderIndex: t.orderIndex,
        link: link ? { code: link.code ? prettyCode(link.code) : null, createdAt: link.createdAt } : null,
        sessions: this.trepo.sessionCount(t.id),
        claimedAt: row.claimed_at ?? null,
      };
    });
  }

  // ---------- notifications ----------
  notifyAdmin(kind: string, title: string, body = "", teamId: number | null = null): Notice {
    const n = this.trepo.addNotice("admin", teamId, kind, title, body);
    this.rt.to("admin").emit("notice", n);
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
    this.rt.to("admin").emit("materials:changed", { teamId });
  }

  /** Called after the team on stage changed: "Sıra sizdədir" / "Növbəti sizsiniz" / "Sıranız yaxınlaşır". */
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
    send(0, "stage.invite", "Sıra sizdədir", `${list[ci].name}, səhnəyə buyurun.`);
    send(1, "stage.next", "Növbəti sizsiniz", "Sizdən əvvəl 1 komanda qalıb. Hazır olun.");
    send(2, "stage.soon", "Sıranız yaxınlaşır", "Sizdən əvvəl 2 komanda var. Səhnəyə yaxınlaşın.");
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
      this.notifyTeam(t.id, "deadline", "Son tarix yaxınlaşır", `Prezentasiyanı yükləmək üçün ${min} dəqiqə qalıb.`);
    }
  }
}
