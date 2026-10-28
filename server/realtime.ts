// Socket.IO rooms:
//   public          stage + timer only (anonymous projector screens join this too)
//   jurors          lock state broadcast to every juror
//   juror:<id>      that juror's own saved scores
//   admin           everything
//   user:<id>, session:<sid>  used only to force-disconnect
import type { FastifyInstance } from "fastify";
import { Server, type Socket } from "socket.io";
import type { PresenceEntry, ScoreRow } from "../shared/types.js";
import { originAllowed, resolveUser, type AuthUser } from "./auth.js";
import type { Config } from "./config.js";
import type { Repo } from "./repo.js";
import { adminResults, revealPublicView } from "./views.js";

export class Realtime {
  readonly io: Server;
  private online = new Map<number, Set<string>>();
  private lastSeen = new Map<number, number>();

  constructor(app: FastifyInstance, private repo: Repo, private cfg: Config) {
    this.io = new Server(app.server, {
      path: "/socket.io",
      serveClient: false,
      allowRequest: (req, cb) => {
        const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
        cb(null, originAllowed(cfg, req.headers.origin, host));
      },
    });

    // The client says which role it connects as (admin page, juror page, projector);
    // without that it only joins the public room.
    this.io.use((socket, next) => {
      const role = (socket.handshake.auth as { role?: string } | undefined)?.role;
      const cookies = app.parseCookie(socket.request.headers.cookie ?? "");
      socket.data.user = role === "admin" || role === "juror"
        ? resolveUser(repo, cfg, cookies, v => app.unsignCookie(v), role)
        : null;
      next();
    });

    this.io.on("connection", socket => this.onConnect(socket));
  }

  private onConnect(socket: Socket) {
    const user = socket.data.user as AuthUser | null;
    socket.join("public");
    if (!user) return;
    socket.join([`user:${user.id}`, `session:${user.sessionId}`]);
    if (user.role === "admin") {
      socket.join("admin");
      socket.emit("presence:changed", this.presence());
      return;
    }
    socket.join(["jurors", `juror:${user.id}`]);
    const set = this.online.get(user.id) ?? new Set();
    set.add(socket.id);
    this.online.set(user.id, set);
    this.lastSeen.set(user.id, Date.now());
    this.emitPresence();
    socket.on("disconnect", () => {
      set.delete(socket.id);
      this.lastSeen.set(user.id, Date.now());
      try { this.repo.touchSession(user.sessionId); } catch { /* session may be gone */ }
      this.emitPresence();
    });
  }

  presence(): PresenceEntry[] {
    return this.repo.jurors().map(j => ({
      jurorId: j.id,
      online: (this.online.get(j.id)?.size ?? 0) > 0,
      lastSeen: this.lastSeen.get(j.id) ?? null,
    }));
  }

  emitPresence() { this.io.to("admin").emit("presence:changed", this.presence()); }

  emitStage() { this.io.to("public").emit("stage:changed", this.repo.stage()); }

  emitTimer() {
    const s = this.repo.stage();
    this.io.to("public").emit("timer:changed", { timer: s.timer, serverNow: s.serverNow });
  }

  emitLocked(locked: boolean) {
    this.io.to(["jurors", "admin"]).emit("event:locked", { locked });
  }

  /** Teams/criteria/event settings changed: every client refetches its own view. */
  emitConfig() { this.io.to("public").emit("config:changed"); }

  emitScore(score: ScoreRow, total: number | null, showJurorTotal: boolean) {
    this.io.to("admin").emit("score:upserted", { ...score, total });
    this.io.to(`juror:${score.jurorId}`).emit("my-score:saved", {
      teamId: score.teamId, values: score.values, note: score.note, updatedAt: score.updatedAt,
      ...(showJurorTotal && total != null ? { total } : {}),
    });
  }

  /** Public: only revealed places (see shared/reveal.ts). Admin screens refetch their full view. */
  emitReveal() { this.io.to("public").emit("reveal:changed", revealPublicView(this.repo)); }

  emitResults() { this.io.to("admin").emit("results:changed", adminResults(this.repo, this.cfg)); }

  kickUser(userId: number) { this.io.in(`user:${userId}`).disconnectSockets(true); }
  kickSession(sessionId: string) { this.io.in(`session:${sessionId}`).disconnectSockets(true); }

  close() { return new Promise<void>(r => this.io.close(() => r())); }
}
