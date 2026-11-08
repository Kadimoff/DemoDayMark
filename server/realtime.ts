// Socket.IO rooms (orgs: every event room is per organisation, prefixed "o<orgId>:"):
//   o<org>:public    stage + timer only (anonymous projector screens join this too; ?org=<slug> picks the organisation)
//   o<org>:jurors    lock state broadcast to every juror of the organisation
//   juror:<id>       that juror's own saved scores
//   o<org>:admin     everything of that organisation (its coordinator, or the platform owner looking at it)
//   team:<id>        munsif: that team's own notifications and panel refreshes (never scores)
//   user:<id>, session:<sid>  used only to force-disconnect
// Juror, team and user ids are global, so the rooms keyed by them need no prefix.
import type { FastifyInstance } from "fastify";
import { Server, type Socket } from "socket.io";
import type { PresenceEntry, ProgressEntry, ScoreRow } from "../shared/types.js";
import { originAllowed, resolveUser, type AuthUser } from "./auth.js";
import type { Config } from "./config.js";
import type { Orgs } from "./orgs.js";
import type { Repo } from "./repo.js";
import { submitScore } from "./scores.js";
import { adminResults, revealPublicView } from "./views.js";
import { resolveTeam, type TeamAuth } from "./teams.js";

const SCOPED = new Set(["public", "admin", "jurors"]);

export class Realtime {
  readonly io: Server;
  private online = new Map<number, Set<string>>();
  private lastSeen = new Map<number, number>();
  /** "<jurorId>:<teamId>" → draft progress (count of filled criteria only). In memory: it is live telemetry. */
  readonly drafts = new Map<string, ProgressEntry & { orgId: number }>();
  private views = new Map<number, OrgRealtime>();
  /** Set right after construction (Orgs needs this object, this needs Orgs). */
  orgs!: Orgs;

  private log: FastifyInstance["log"];
  constructor(app: FastifyInstance, private cfg: Config) {
    this.log = app.log;
    this.io = new Server(app.server, {
      path: "/socket.io",
      serveClient: false,
      // v3 reliability: WebSocket first (Traefik/Coolify pass the upgrade), long-polling as the fallback. A ping every
      // 15 s keeps idle proxies and NAT boxes from dropping the connection and finds a dead one within ~25 s; clients
      // then reconnect with backoff and refetch their full state.
      transports: ["websocket", "polling"],
      pingInterval: 15_000,
      pingTimeout: 10_000,
      perMessageDeflate: false,
      maxHttpBufferSize: 1e6,
      allowRequest: (req, cb) => {
        const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
        cb(null, originAllowed(cfg, req.headers.origin, host));
      },
    });

    // The client says which role it connects as (admin page, juror page, projector) and, on public screens,
    // which organisation (?org=<slug>); without a role it only joins that organisation's public room.
    this.io.use((socket, next) => {
      const auth = (socket.handshake.auth ?? {}) as { role?: string; org?: string; watch?: string };
      const cookies = app.parseCookie(socket.request.headers.cookie ?? "");
      const repo = this.orgs.root.repo;
      socket.data.user = auth.role === "admin" || auth.role === "juror"
        ? resolveUser(repo, cfg, cookies, v => app.unsignCookie(v), auth.role)
        : null;
      socket.data.team = auth.role === "team" ? resolveTeam(this.orgs.root.trepo, cfg, cookies, v => app.unsignCookie(v)) : null;
      const o = typeof auth.org === "string" && auth.org ? this.orgs.bySlug(auth.org) : null;
      socket.data.pageOrg = o && o.active ? o.id : null;
      socket.data.watch = auth.watch === "root";
      next();
    });

    this.io.on("connection", socket => this.onConnect(socket));
  }

  /** The rooms and broadcasts of one organisation. */
  org(orgId: number): OrgRealtime {
    let v = this.views.get(orgId);
    if (!v) { v = new OrgRealtime(this, orgId, this.cfg); this.views.set(orgId, v); }
    return v;
  }
  isOnline(jurorId: number) { return (this.online.get(jurorId)?.size ?? 0) > 0; }
  /** v11: sockets in one room (system card: screens / jurors / admins per organisation). */
  roomSize(room: string) { return this.io.sockets.adapter.rooms.get(room)?.size ?? 0; }
  lastSeenOf(jurorId: number) { return this.lastSeen.get(jurorId) ?? null; }

  private onConnect(socket: Socket) {
    const user = socket.data.user as AuthUser | null;
    const team = socket.data.team as TeamAuth | null;
    const pageOrg = socket.data.pageOrg as number | null;
    const home = user?.orgId ?? team?.orgId ?? 1;
    socket.join(`o${pageOrg ?? home}:public`);
    if (team) socket.join([`team:${team.teamId}`, `tsession:${team.sessionId}`]);
    if (!user) return;
    socket.join([`user:${user.id}`, `session:${user.sessionId}`]);
    const ort = this.org(user.orgId);
    if (user.role === "admin") {
      // v3: the platform owner's /root page gets a compact live feed of every organisation's stage (public data only).
      if (socket.data.watch && user.isRoot) { socket.join("rootwatch"); return; }
      // A projector page of another organisation never gets this organisation's admin feed.
      if (pageOrg != null && pageOrg !== user.orgId) return;
      socket.join(`o${user.orgId}:admin`);
      socket.emit("presence:changed", ort.presence());
      return;
    }
    socket.join([`o${user.orgId}:jurors`, `juror:${user.id}`]);
    const set = this.online.get(user.id) ?? new Set();
    set.add(socket.id);
    this.online.set(user.id, set);
    this.lastSeen.set(user.id, Date.now());
    ort.emitPresence();
    const repo = () => this.orgs.scope(user.orgId).repo;
    // Live draft progress: only "how many criteria are filled" ever reaches the admin, never the points.
    socket.on("draft:progress", (p: unknown) => {
      const { teamId, filled } = (p ?? {}) as { teamId?: unknown; filled?: unknown };
      if (!Number.isInteger(teamId) || !Number.isInteger(filled)) return;
      const max = repo().criteria().length;
      const f = Math.max(0, Math.min(max, filled as number));
      const k = `${user.id}:${teamId}`;
      const prev = this.drafts.get(k);
      if (prev && prev.filled === f) return;
      if (!repo().team(teamId as number)) return;
      this.drafts.set(k, { jurorId: user.id, teamId: teamId as number, filled: f, at: Date.now(), orgId: user.orgId });
      ort.emitProgress();
    });
    // Score submit over the already-open socket, acknowledged. A long-idle HTTP connection can be dropped
    // silently by NAT/Wi-Fi gear on the way; the socket is kept alive by pings and reconnects by itself.
    socket.on("score:submit", (p: unknown, ack?: (r: unknown) => void) => {
      if (typeof ack !== "function") return;
      // The session may have been ended (juror deactivated / logged out) since the socket connected.
      const r0 = repo();
      const s = r0.session(user.sessionId);
      const u = s ? r0.member(user.id) : null;
      if (!s || !u || !u.active || u.role !== "juror") { ack({ ok: false, status: 401, error: "Sessiya bitib. Koordinatordan yeni QR istəyin." }); return; }
      const { teamId, ...body } = (p ?? {}) as { teamId?: unknown };
      try {
        const r = submitScore(r0, ort, user.id, teamId, body);
        ack(r.ok ? { ok: true, score: r.body } : { ok: false, status: r.status, error: r.error });
      } catch (err) {
        this.log.error({ err, jurorId: user.id, orgId: user.orgId, teamId, opId: (body as { opId?: unknown }).opId ?? null }, "score:submit failed");
        // 500: the phone keeps the op in its queue and tries again (same op id, so it is applied at most once)
        ack({ ok: false, status: 500, error: "Serverdə xəta baş verdi." });
      }
    });
    socket.on("disconnect", () => {
      set.delete(socket.id);
      this.lastSeen.set(user.id, Date.now());
      try { repo().touchSession(user.sessionId); } catch { /* session may be gone */ }
      ort.emitPresence();
    });
  }

  close() { return new Promise<void>(r => this.io.close(() => r())); }
}

/** One organisation's view of the realtime layer: same method names as before multi-tenancy. */
export class OrgRealtime {
  /** munsif: runs after every stage change (queue reminders to teams). */
  afterStage: (() => void) | null = null;
  /** v3: broadcasts that can come in bursts (30 jurors scoring at once) go out at most once per window, the last state always. */
  private gates = new Map<string, { timer: NodeJS.Timeout; dirty: boolean }>();
  static THROTTLE_MS = 250;

  constructor(private rt: Realtime, readonly orgId: number, private cfg: Config) {}

  /** Leading + trailing coalescing: the first call goes out at once; calls within the window collapse into one at its end. */
  private coalesce(key: string, fn: () => void) {
    const g = this.gates.get(key);
    if (g) { g.dirty = true; return; }
    fn();
    const open = () => {
      const cur = this.gates.get(key);
      if (cur?.dirty) { cur.dirty = false; try { fn(); } catch { /* closed */ } cur.timer = setTimeout(open, OrgRealtime.THROTTLE_MS); cur.timer.unref?.(); }
      else this.gates.delete(key);
    };
    const timer = setTimeout(open, OrgRealtime.THROTTLE_MS);
    timer.unref?.();
    this.gates.set(key, { timer, dirty: false });
  }

  get io() { return this.rt.io; }
  private get repo(): Repo { return this.rt.orgs.scope(this.orgId).repo; }
  /** "public" / "admin" / "jurors" → this organisation's room; anything else (team:<id>, juror:<id>…) as is. */
  room(name: string) { return SCOPED.has(name) ? `o${this.orgId}:${name}` : name; }
  to(...names: string[]) { return this.io.to(names.map(n => this.room(n))); }

  presence(): PresenceEntry[] {
    return this.repo.jurors().map(j => ({ jurorId: j.id, online: this.rt.isOnline(j.id), lastSeen: this.rt.lastSeenOf(j.id) }));
  }
  emitPresence() { this.coalesce("presence", () => this.to("admin").emit("presence:changed", this.presence())); }

  progress(): ProgressEntry[] {
    return [...this.rt.drafts.values()].filter(d => d.orgId === this.orgId).map(({ orgId: _o, ...d }) => d);
  }
  emitProgress() { this.coalesce("progress", () => this.to("admin").emit("progress:changed", this.progress())); }
  /** v3 events: a new event starts without any live draft progress. */
  clearOrgProgress() {
    for (const [k, v] of this.rt.drafts) if (v.orgId === this.orgId) this.rt.drafts.delete(k);
    this.emitProgress();
  }
  clearProgress(jurorId: number, teamId?: number) {
    for (const [k, v] of this.rt.drafts) if (v.orgId === this.orgId && v.jurorId === jurorId && (teamId == null || v.teamId === teamId)) this.rt.drafts.delete(k);
    this.emitProgress();
  }

  /** A juror scanned their QR and typed their name: the admin's open QR dialog closes with that name. */
  emitJurorJoined(jurorId: number, displayName: string) {
    this.to("admin").emit("juror:joined", { jurorId, displayName });
    this.emitPresence();
  }

  /** Coordinator's reminder, delivered only to the given jurors' own rooms. */
  nudge(jurorIds: number[], payload: { teamId: number; teamName: string; index: number }) {
    for (const id of jurorIds) this.io.to(`juror:${id}`).emit("nudge", payload);
  }

  emitStage() {
    const s = this.repo.stage();
    this.to("public").emit("stage:changed", s);
    this.io.to("rootwatch").emit("org:stage", { orgId: this.orgId, stage: s });
    try { this.afterStage?.(); } catch { /* reminders are best effort */ }
  }

  emitTimer() {
    const s = this.repo.stage();
    this.to("public").emit("timer:changed", { timer: s.timer, serverNow: s.serverNow });
    this.io.to("rootwatch").emit("org:stage", { orgId: this.orgId, stage: s });
  }

  emitLocked(locked: boolean) {
    this.to("jurors", "admin").emit("event:locked", { locked });
  }

  /** Teams/criteria/event settings changed: every client refetches its own view. */
  emitConfig() { this.to("public").emit("config:changed"); }

  emitScore(score: ScoreRow, total: number | null, showJurorTotal: boolean) {
    this.to("admin").emit("score:upserted", { ...score, total });
    this.clearProgress(score.jurorId, score.teamId);
    this.io.to(`juror:${score.jurorId}`).emit("my-score:saved", {
      teamId: score.teamId, values: score.values, note: score.note, tags: score.tags, updatedAt: score.updatedAt,
      ...(showJurorTotal && total != null ? { total } : {}),
    });
  }

  /** Public: only revealed places (see shared/reveal.ts). Admin screens refetch their full view. */
  emitReveal() { this.to("public").emit("reveal:changed", revealPublicView(this.repo)); }

  emitResults() { this.coalesce("results", () => this.to("admin").emit("results:changed", adminResults(this.repo, this.cfg))); }

  kickUser(userId: number) { this.io.in(`user:${userId}`).disconnectSockets(true); }
  kickSession(sessionId: string) { this.io.in(`session:${sessionId}`).disconnectSockets(true); }
}
