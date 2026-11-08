// v11: the juror phone's outbox (web/src/lib/outbox.ts) — pure logic with a fake transport and fake timers.
import { describe, expect, it } from "vitest";
import { Outbox, type ScoreOp, type SendResult } from "../web/src/lib/outbox.js";

class MemStorage { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const body = (v: number) => ({ values: { a: v, b: v }, note: "", tags: [] });

/** A server that applies each op id once and remembers what it applied. */
function fakeServer() {
  const applied = new Map<string, ScoreOp>();
  const calls: string[] = [];
  let online = false;
  let locked = false;
  return {
    applied, calls,
    set online(v: boolean) { online = v; },
    set locked(v: boolean) { locked = v; },
    send: async (op: ScoreOp): Promise<SendResult<{ teamId: number }>> => {
      calls.push(op.opId);
      if (!online) return { ok: false, kind: "network", error: "offline" };
      if (locked) return { ok: false, kind: "rejected", status: 423, error: "Qiymətləndirmə bağlanıb." };
      if (!applied.has(op.opId)) applied.set(op.opId, JSON.parse(JSON.stringify(op)));
      return { ok: true, score: { teamId: op.teamId } };
    },
  };
}
function fakeTimers() {
  const q: Array<{ fn: () => void; ms: number }> = [];
  return { q, setTimer: (fn: () => void, ms: number) => { const t = { fn, ms }; q.push(t); return t; }, clearTimer: (t: unknown) => { const i = q.indexOf(t as never); if (i >= 0) q.splice(i, 1); },
    fire: () => { const t = q.shift(); t?.fn(); } };
}

describe("juror outbox", () => {
  it("3 scores entered offline are queued, survive a reload and are each sent exactly once when the network is back", async () => {
    const st = new MemStorage(), srv = fakeServer(), tm = fakeTimers();
    const ob = new Outbox({ storage: st, key: "k", send: srv.send, ...tm });
    ob.enqueue(1, body(1)); await flush();
    ob.enqueue(2, body(2)); await flush();
    ob.enqueue(3, body(3)); await flush();
    expect(ob.size).toBe(3);
    expect(ob.ops.every(o => o.status === "queued")).toBe(true);
    expect(srv.applied.size).toBe(0);
    // the page is reloaded while still offline: the queue comes back from storage
    ob.close();
    const ob2 = new Outbox({ storage: st, key: "k", send: srv.send, ...tm });
    expect(ob2.ops.map(o => o.teamId)).toEqual([1, 2, 3]);
    srv.online = true;
    ob2.resume(); await flush();
    expect(ob2.size).toBe(0);
    expect([...srv.applied.values()].map(o => o.teamId).sort()).toEqual([1, 2, 3]);
    expect(ob2.log.map(o => o.status)).toEqual(["saved", "saved", "saved"]);
    expect(new Set(ob2.log.map(o => o.opId)).size).toBe(3);
  });

  it("retries with backoff while offline; a newer version of the same team replaces the queued one", async () => {
    const srv = fakeServer(), tm = fakeTimers();
    const ob = new Outbox({ storage: null, key: "k", send: srv.send, ...tm, minDelay: 1000, maxDelay: 8000 });
    ob.enqueue(7, body(3)); await flush();
    expect(tm.q.length).toBe(1);
    const first = tm.q[0].ms;
    tm.fire(); await flush();
    expect(tm.q[0].ms).toBeGreaterThan(first); // backoff grows
    ob.enqueue(7, body(5)); await flush();
    expect(ob.size).toBe(1);
    expect(ob.ops[0].body.values.a).toBe(5);
    srv.online = true;
    tm.fire(); await flush();
    expect(ob.size).toBe(0);
    expect([...srv.applied.values()].map(o => o.body.values.a)).toEqual([5]);
  });

  it("a refused op (scoring closed) is kept in the log with its values and does not block the queue", async () => {
    const srv = fakeServer(); srv.online = true; srv.locked = true;
    const rejected: ScoreOp[] = [];
    const ob = new Outbox({ storage: null, key: "k", send: srv.send, onRejected: o => rejected.push(o) });
    ob.enqueue(1, body(4)); await flush();
    expect(ob.size).toBe(0);
    expect(rejected.length).toBe(1);
    expect(ob.lastFor(1)).toMatchObject({ status: "rejected", httpStatus: 423, body: { values: { a: 4 } } });
    srv.locked = false;
    ob.enqueue(2, body(2)); await flush();
    expect(ob.lastFor(2)?.status).toBe("saved");
  });

  it("an op that was in flight when the page died is sent again with the same id (the server dedupes it)", async () => {
    const st = new MemStorage();
    let release: (r: SendResult) => void = () => {};
    const ob = new Outbox({ storage: st, key: "k", send: () => new Promise<SendResult>(r => { release = r; }) });
    const op = ob.enqueue(1, body(9)); await flush();
    expect(JSON.parse(st.getItem("k")!).ops[0]).toMatchObject({ opId: op.opId, status: "sending" });
    ob.close(); void release;
    const srv = fakeServer(); srv.online = true;
    const ob2 = new Outbox({ storage: st, key: "k", send: srv.send });
    ob2.resume(); await flush();
    expect(srv.calls).toEqual([op.opId]);
    expect(ob2.size).toBe(0);
  });

  it("401 pauses the queue (the op is kept) until resume()", async () => {
    let auth = false;
    const sent: string[] = [];
    const ob = new Outbox({ storage: null, key: "k", send: async (op: ScoreOp): Promise<SendResult> => {
      if (!auth) return { ok: false, kind: "auth" };
      sent.push(op.opId); return { ok: true, score: {} };
    } });
    ob.enqueue(1, body(1)); await flush();
    expect(ob.isPaused).toBe(true);
    expect(ob.size).toBe(1);
    auth = true;
    ob.resume(); await flush();
    expect(sent.length).toBe(1);
    expect(ob.size).toBe(0);
  });
});
