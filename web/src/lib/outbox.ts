// v11 reliability: the juror phone's outbox. Every score the juror sends becomes an op with a client-generated id, written
// to localStorage BEFORE anything goes on the wire, and resent (same id) until the server answers. The server applies an op
// at most once, so resending is always safe. Ops survive reloads, Wi-Fi drops, a phone going to sleep and server restarts.
//
// States of an op: queued (waiting / will retry) → sending → saved | rejected.
//   - network error, timeout, server error (5xx): back to queued, retried with backoff (1 s → 15 s) and at once when the
//     network / socket comes back;
//   - 401 (session ended): paused until the page has a session again (the op stays queued);
//   - refused (423 scoring closed, 400 invalid, 404 team gone): rejected — kept in the log with its values, never dropped.
// A newer op for the same team replaces an older one that has not left the phone yet (only the last version matters).
// Ops go out one at a time, in order, so the server always ends with the juror's last version.
// No DOM here: storage, transport and timers are injected (unit-tested in node, used by web/src/juror.ts).

export type OpStatus = "queued" | "sending" | "saved" | "rejected";
export interface OpBody { values: Record<string, number>; note: string; tags: string[] }
export interface ScoreOp {
  opId: string;
  teamId: number;
  body: OpBody;
  createdAt: number;
  status: OpStatus;
  tries: number;
  /** last failure (network / refusal), for the UI */
  error?: string;
  httpStatus?: number;
  doneAt?: number;
}
export type SendResult<S = unknown> =
  | { ok: true; score: S }
  | { ok: false; kind: "network"; error?: string }
  | { ok: false; kind: "auth"; error?: string }
  | { ok: false; kind: "rejected"; status: number; error: string };

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export interface OutboxDeps<S = unknown> {
  storage: StorageLike | null;
  key: string;
  send: (op: ScoreOp) => Promise<SendResult<S>>;
  onChange?: () => void;
  onSaved?: (op: ScoreOp, score: S) => void;
  onRejected?: (op: ScoreOp) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** backoff bounds, ms */
  minDelay?: number;
  maxDelay?: number;
  /** how many finished ops (saved / rejected) the log keeps */
  logSize?: number;
}

export function newOpId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  const a = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(a); else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a, b => b.toString(16).padStart(2, "0")).join("");
}

export class Outbox<S = unknown> {
  /** not yet confirmed, in send order */
  ops: ScoreOp[] = [];
  /** finished ops, newest first */
  log: ScoreOp[] = [];
  private busy = false;
  private paused = false;
  private timer: unknown = null;
  private failures = 0;
  private closed = false;
  private now: () => number;

  constructor(private d: OutboxDeps<S>) {
    this.now = d.now ?? Date.now;
    this.load();
  }

  private load() {
    try {
      const raw = this.d.storage?.getItem(this.d.key);
      if (!raw) return;
      const v = JSON.parse(raw) as { ops?: ScoreOp[]; log?: ScoreOp[] };
      // an op that was "sending" when the page closed may or may not have arrived: send it again (same id = safe)
      this.ops = (v.ops ?? []).filter(o => o && typeof o.opId === "string").map(o => ({ ...o, status: "queued" as const }));
      this.log = (v.log ?? []).filter(o => o && typeof o.opId === "string").slice(0, this.d.logSize ?? 30);
    } catch { /* corrupt entry: start empty (drafts are kept separately) */ }
  }
  private save() {
    try { this.d.storage?.setItem(this.d.key, JSON.stringify({ ops: this.ops, log: this.log })); } catch { /* storage full / unavailable */ }
    try { this.d.onChange?.(); } catch { /* UI */ }
  }

  /** Queues the juror's score for a team and starts sending. Returns the op. */
  enqueue(teamId: number, body: OpBody): ScoreOp {
    const op: ScoreOp = { opId: newOpId(), teamId, body: { values: { ...body.values }, note: body.note, tags: [...body.tags] }, createdAt: this.now(), status: "queued", tries: 0 };
    // an older version of this team's score that has not left the phone yet is replaced (an op in flight is not touched)
    this.ops = this.ops.filter(o => !(o.teamId === teamId && o.status === "queued"));
    this.ops.push(op);
    this.save();
    this.kick();
    return op;
  }

  /** The newest unconfirmed op of a team, if any. */
  pendingFor(teamId: number): ScoreOp | null {
    for (let i = this.ops.length - 1; i >= 0; i--) if (this.ops[i].teamId === teamId) return this.ops[i];
    return null;
  }
  /** The newest finished op of a team, if any. */
  lastFor(teamId: number): ScoreOp | null { return this.log.find(o => o.teamId === teamId) ?? null; }
  get size() { return this.ops.length; }
  get isPaused() { return this.paused; }
  get failing() { return this.failures > 0; }

  /** Network / socket is back, the tab is visible again, the session is back: send now. */
  resume() {
    this.paused = false;
    this.failures = 0;
    this.clearRetry();
    this.kick();
  }
  close() { this.closed = true; this.clearRetry(); }

  private clearRetry() {
    if (this.timer != null) { (this.d.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer); this.timer = null; }
  }
  private retryLater() {
    this.clearRetry();
    const min = this.d.minDelay ?? 1000, max = this.d.maxDelay ?? 15000;
    const base = Math.min(max, min * 2 ** Math.min(10, this.failures - 1));
    const ms = Math.round(base * (0.75 + Math.random() * 0.5));
    this.timer = (this.d.setTimer ?? ((fn: () => void, t: number) => setTimeout(fn, t)))(() => { this.timer = null; this.kick(); }, ms);
  }

  /** Sends queued ops one by one until the queue is empty or the network fails. */
  kick() {
    if (this.busy || this.paused || this.closed) return;
    const op = this.ops.find(o => o.status === "queued");
    if (!op) return;
    if (this.timer != null && this.failures > 0) return; // a retry is already scheduled
    this.busy = true;
    op.status = "sending";
    op.tries++;
    this.save();
    void this.d.send(op).then(r => r, (e: unknown) => ({ ok: false as const, kind: "network" as const, error: String((e as Error)?.message ?? e) })).then(r => {
      this.busy = false;
      if (this.closed) return;
      if (r.ok) {
        this.failures = 0;
        this.finish(op, "saved");
        try { this.d.onSaved?.(op, r.score); } catch { /* UI */ }
      } else if (r.kind === "rejected") {
        this.failures = 0;
        op.error = r.error;
        op.httpStatus = r.status;
        this.finish(op, "rejected");
        try { this.d.onRejected?.(op); } catch { /* UI */ }
      } else {
        op.status = "queued";
        op.error = r.error;
        if (r.kind === "auth") this.paused = true;
        else { this.failures++; this.retryLater(); }
        this.save();
        return;
      }
      this.kick();
    });
  }

  private finish(op: ScoreOp, status: "saved" | "rejected") {
    op.status = status;
    op.doneAt = this.now();
    this.ops = this.ops.filter(o => o !== op);
    this.log = [op, ...this.log.filter(o => o.opId !== op.opId)].slice(0, this.d.logSize ?? 30);
    this.save();
  }
}
