// Load and chaos test for the live scoring path (not part of `npm test`: it needs a build and takes ~1–2 minutes).
//
//   npm run build && npm run test:load                 100 jurors · 10 screens · 30 teams
//   npm run build && npm run test:chaos                + 20% of jurors drop every 10 s + server SIGKILL/restart mid-run
//   options: --jurors N --screens N --teams N --port P --speed X (delay multiplier) --chaos --no-restart --json out.json
//
// It starts the built server (dist-server) on a fresh DATA_DIR, signs in N jurors through real QR invites and drives each
// juror with the real phone outbox (web/src/lib/outbox.ts: op ids, queue, retries; socket first, HTTP fallback). Every
// juror scores every team (some twice) with random pauses; the coordinator moves the timer and slides every 2 s; screens
// listen. Measured: score → admin socket latency, score ack latency, screen event latency, server CPU / RSS. At the end the
// database is read directly and compared with the last version every juror sent: lost or wrong scores must be 0, and every
// op must be applied exactly once.
import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io as ioc, type Socket } from "socket.io-client";
import { Outbox, type ScoreOp, type SendResult } from "../../web/src/lib/outbox.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const opt = (name: string, def: number) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? Number(argv[i + 1]) : def; };
const flag = (name: string) => argv.includes(`--${name}`);
const JURORS = opt("jurors", 100), SCREENS = opt("screens", 10), TEAMS = opt("teams", 30), PORT = opt("port", 3078), SPEED = opt("speed", 1);
const CHAOS = flag("chaos"), RESTART = CHAOS && !flag("no-restart");
const jsonOut = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : null;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); };
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.round(Math.max(...xs)) : null });
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${m}`);

if (!fs.existsSync(path.join(root, "dist-server/server/index.js"))) { console.error("Build first: npm run build"); process.exit(2); }

// ---------- server process ----------
const dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "ddm-load-"));
const adminPw = randomBytes(12).toString("hex");
// fixed for the whole run, like SESSION_SECRET in production (a new secret would end every session at the restart)
const sessionSecret = randomBytes(24).toString("hex");
let child: ChildProcess | null = null;
const cpu = { samples: [] as Array<{ t: number; cpu: number; rss: number }>, last: null as null | { t: number; ticks: number; pid: number } };
function spawnServer() {
  const prof = argv.includes("--prof") ? ["--cpu-prof", `--cpu-prof-dir=${argv[argv.indexOf("--prof") + 1]}`] : [];
  child = spawn(process.execPath, [...prof, "dist-server/server/index.js"], {
    cwd: root, stdio: ["ignore", "ignore", "pipe"],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BOOTSTRAP_|ADMIN_|DATA_DIR|ORIGIN|SESSION_SECRET|BACKUP_)/.test(k))), PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dataDir, ADMIN_USERNAME: "admin", ADMIN_PASSWORD: adminPw,
      SESSION_SECRET: sessionSecret, ORIGIN: BASE, LOG_LEVEL: "warn", BACKUP_INTERVAL_MIN: "0.25", NODE_ENV: "production",
      SOFFICE: "" },
  });
  child.stderr!.on("data", d => { const s = String(d); if (/error|fatal/i.test(s)) process.stderr.write(`[server] ${s.slice(0, 400)}`); });
}
async function waitHealthy(ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await req("GET", "/api/health"); if (r.status === 200) return; } catch { /* starting */ } await sleep(100); }
  throw new Error("server did not become healthy");
}
function sampleCpu() {
  const pid = child?.pid;
  if (!pid) return;
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    const ticks = Number(st[11]) + Number(st[12]);
    const rss = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) / 1024;
    const t = Date.now();
    if (cpu.last && cpu.last.pid === pid) cpu.samples.push({ t, cpu: ((ticks - cpu.last.ticks) / 100) / ((t - cpu.last.t) / 1000) * 100, rss });
    cpu.last = { t, ticks, pid };
  } catch { /* process gone (restart) */ }
}

// ---------- HTTP helper (Origin + cookie, like the browser) ----------
function req(method: string, p: string, body?: unknown, cookie?: string): Promise<{ status: number; body: any; cookie?: string }> {
  return new Promise((res, rej) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const r = http.request(`${BASE}${p}`, { method, timeout: 10000, agent: false, headers: { Origin: BASE, ...(cookie ? { Cookie: cookie } : {}),
      ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) } }, resp => {
      const chunks: Buffer[] = [];
      resp.on("data", c => chunks.push(c));
      resp.on("end", () => {
        let b: any = {}; try { b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* not json */ }
        const sc = resp.headers["set-cookie"]?.[0]?.split(";")[0];
        res({ status: resp.statusCode ?? 0, body: b, cookie: sc });
      });
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", rej);
    if (data) r.write(data);
    r.end();
  });
}

// ---------- run ----------
interface Juror { id: number; cookie: string; sock: Socket; ob: Outbox<unknown>; offline: boolean; expected: Map<number, Record<string, number>>; done: boolean }
const firstSend = new Map<string, number>();          // opId → first attempt time
const opKey = new Map<string, string>();              // opId → juror:team:values
const adminSeen = new Map<string, number>();          // juror:team:values → first time seen on the admin socket
const ackLat: number[] = [];
const savedOps = new Set<string>();
const rejectedOps: Array<{ opId: string; status?: number; error?: string }> = [];
let sentAttempts = 0, httpFallbacks = 0, drops = 0, offlineSpells = 0;
const screenLat: number[] = [];
let restartAt: number | null = null, restartDowntime: number | null = null;
let restartWindow: [number, number] | null = null;
let dupAnswers = 0;

async function main() {
  log(`munsif.im load test: ${JURORS} jurors · ${SCREENS} screens · ${TEAMS} teams${CHAOS ? " · CHAOS (20% drops / 10 s" + (RESTART ? ", server restart" : "") + ")" : ""} · port ${PORT}`);
  spawnServer();
  await waitHealthy();
  const cpuTimer = setInterval(sampleCpu, 1000);
  const login = await req("POST", "/api/auth/login", { username: "admin", password: adminPw });
  if (login.status !== 200) throw new Error(`admin login ${login.status}`);
  const admin = login.cookie!;
  // teams: the 8 placeholders + more up to TEAMS
  let teams = (await req("GET", "/api/admin/teams", undefined, admin)).body as Array<{ id: number }>;
  for (let i = teams.length; i < TEAMS; i++) await req("POST", "/api/admin/teams", { name: `Komanda ${i + 1}`, project: "" }, admin);
  teams = ((await req("GET", "/api/admin/teams", undefined, admin)).body as Array<{ id: number }>).slice(0, TEAMS);
  const crit = (await req("GET", "/api/admin/criteria", undefined, admin)).body as Array<{ key: string; maxScore: number }>;
  await req("PATCH", "/api/admin/event", { currentTeamId: teams[0].id }, admin);
  log(`setup: ${teams.length} teams, ${crit.length} criteria`);

  // admin feed
  const adminSock = ioc(BASE, { transports: ["websocket"], extraHeaders: { origin: BASE, cookie: admin }, auth: { role: "admin" }, forceNew: true, reconnectionDelay: 300, reconnectionDelayMax: 2000 });
  adminSock.on("score:upserted", (s: { jurorId: number; teamId: number; values: Record<string, number> }) => {
    const k = `${s.jurorId}:${s.teamId}:${JSON.stringify(s.values)}`;
    if (!adminSeen.has(k)) adminSeen.set(k, Date.now());
  });
  // screens (anonymous projector pages): last timer / stage they know; resync over HTTP after a reconnect, like the browser
  const sentStageAt = new Map<string, number>();
  const receipts: Array<{ key: string; t: number }> = [];
  let actionSeq = 0;
  const screens = Array.from({ length: SCREENS }, () => {
    const s = ioc(BASE, { transports: ["websocket"], extraHeaders: { origin: BASE }, forceNew: true, reconnectionDelay: 300, reconnectionDelayMax: 2000, randomizationFactor: 0.5 });
    const st = { sock: s, timer: null as any, slide: 0, events: 0, connects: 0 };
    s.on("connect", async () => {
      st.connects++;
      if (st.connects > 1) { const r = await req("GET", "/api/stage").catch(() => null); if (r?.status === 200) { st.timer = r.body.timer; st.slide = r.body.show?.slide ?? st.slide; } }
    });
    s.on("timer:changed", (p: { timer: any }) => { st.events++; st.timer = p.timer; receipts.push({ key: `t:${p.timer.anchorAt}:${p.timer.offsetSec}:${p.timer.running}`, t: Date.now() }); });
    s.on("stage:changed", (p: any) => { st.events++; st.timer = p.timer; st.slide = p.show?.slide ?? st.slide; receipts.push({ key: `s:${p.show?.slide}:${actionSeq}`, t: Date.now() }); });
    return st;
  });

  // jurors through real QR invites
  const jurors: Juror[] = [];
  for (let i = 0; i < JURORS; i++) {
    const r = await req("POST", "/api/admin/jurors", {}, admin);
    const c = await req("POST", `/api/auth/invite/${r.body.invite.path.replace("/j/", "")}`, { displayName: `Münsif ${i + 1}` });
    if (c.status !== 200) throw new Error(`juror claim ${c.status} ${c.body.error}`);
    const sock = ioc(BASE, { transports: ["websocket", "polling"], extraHeaders: { origin: BASE, cookie: c.cookie! }, auth: { role: "juror" }, forceNew: true,
      reconnectionDelay: 500, reconnectionDelayMax: 5000, randomizationFactor: 0.5, timeout: 10000 });
    const j: Juror = { id: r.body.juror.id, cookie: c.cookie!, sock, offline: false, expected: new Map(), done: false, ob: null as unknown as Outbox };
    const send = async (op: ScoreOp): Promise<SendResult> => {
      sentAttempts++;
      if (!firstSend.has(op.opId)) firstSend.set(op.opId, Date.now());
      const t0 = Date.now();
      if (j.offline) return { ok: false, kind: "network", error: "offline" };
      const payload = { ...op.body, opId: op.opId, clientAt: op.createdAt };
      const verdict = (status: number, error: string): SendResult => status === 401 ? { ok: false, kind: "auth", error } : status >= 500 || status === 0 || status === 429 ? { ok: false, kind: "network", error } : { ok: false, kind: "rejected", status, error };
      if (sock.connected) {
        try {
          const a = await sock.timeout(5000).emitWithAck("score:submit", { teamId: op.teamId, ...payload });
          if (a.ok) { ackLat.push(Date.now() - t0); if (a.score?.duplicate) dupAnswers++; return { ok: true, score: a.score }; }
          return verdict(a.status, a.error);
        } catch { /* no ack: HTTP */ }
      }
      httpFallbacks++;
      try {
        const h = await req("PUT", `/api/juror/scores/${op.teamId}`, payload, j.cookie);
        if (h.status === 200) { ackLat.push(Date.now() - t0); if (h.body?.duplicate) dupAnswers++; return { ok: true, score: h.body }; }
        return verdict(h.status, h.body.error ?? "");
      } catch (e) { return { ok: false, kind: "network", error: (e as Error).message }; }
    };
    j.ob = new Outbox({ storage: null, key: `j${j.id}`, send, minDelay: 500, maxDelay: 5000,
      onSaved: op => { savedOps.add(op.opId); }, onRejected: op => { rejectedOps.push({ opId: op.opId, status: op.httpStatus, error: op.error }); } });
    sock.on("connect", () => j.ob.resume());
    jurors.push(j);
  }
  await Promise.all(jurors.map(j => j.sock.connected ? null : new Promise<void>(r => { j.sock.once("connect", () => r()); })));
  log(`${JURORS} jurors signed in and connected; ${SCREENS} screens connected`);

  const t0 = Date.now();
  let stopFlags = false;
  // server event-loop lag over time (the server's window restarts every 60 s; the max shows when a stall happened)
  const lagTrace: Array<{ t: number; p99: number; max: number }> = [];
  const lagPoll = setInterval(async () => {
    try { const h = await req("GET", "/api/health"); if (h.status === 200) lagTrace.push({ t: Math.round((Date.now() - t0) / 1000), p99: h.body.eventLoopLagMs.p99, max: h.body.eventLoopLagMs.max }); } catch { /* restarting */ }
  }, 2000);
  // coordinator: timer + slides every 2 s
  const coord = (async () => {
    let k = 0;
    while (!stopFlags) {
      await sleep(2000);
      k++;
      try {
        const at = Date.now();
        if (k % 2) {
          const r = await req("PATCH", "/api/admin/event", { timer: k % 4 === 1 ? "pitch" : "pause" }, admin);
          if (r.status === 200) { const t = r.body.stage.timer; sentStageAt.set(`t:${t.anchorAt}:${t.offsetSec}:${t.running}`, at); }
        } else {
          actionSeq = k;
          const r = await req("PATCH", "/api/admin/stage", { slide: 1 + (k % 7) }, admin);
          if (r.status === 200) sentStageAt.set(`s:${r.body.stage.show?.slide}:${k}`, at);
        }
      } catch { /* server restarting */ }
    }
  })();
  // jurors at work
  const valuesFor = () => Object.fromEntries(crit.map(c => [c.key, Math.max(1, Math.round(rnd(1, c.maxScore)))]));
  const work = jurors.map(async j => {
    await sleep(rnd(0, 1500) * SPEED);
    const order = [...teams].sort(() => Math.random() - 0.5);
    for (const t of order) {
      await sleep(rnd(150, 1500) * SPEED);
      const v = valuesFor();
      j.expected.set(t.id, v);
      const op = j.ob.enqueue(t.id, { values: v, note: "", tags: [] });
      opKey.set(op.opId, `${j.id}:${t.id}:${JSON.stringify(v)}`);
      if (Math.random() < 0.2) { // the juror changes their mind
        await sleep(rnd(100, 900) * SPEED);
        const v2 = valuesFor();
        j.expected.set(t.id, v2);
        const op2 = j.ob.enqueue(t.id, { values: v2, note: "düzəliş", tags: [] });
        opKey.set(op2.opId, `${j.id}:${t.id}:${JSON.stringify(v2)}`);
      }
    }
    j.done = true;
  });
  // chaos: every 10 s, 20% of the jurors lose their connection (half abruptly, half go offline for 1–4 s)
  const chaos = CHAOS ? (async () => {
    while (!stopFlags) {
      await sleep(10_000);
      if (stopFlags) break;
      const pick = [...jurors].sort(() => Math.random() - 0.5).slice(0, Math.round(jurors.length * 0.2));
      pick.forEach((j, i) => {
        drops++;
        if (i % 2) { (j.sock.io as unknown as { engine?: { close(): void } }).engine?.close(); }
        else {
          offlineSpells++;
          j.offline = true;
          j.sock.disconnect();
          setTimeout(() => { j.offline = false; j.sock.connect(); j.ob.resume(); }, rnd(1000, 4000));
        }
      });
      log(`chaos: dropped ${pick.length} jurors`);
    }
  })() : null;
  // the server dies mid-run (SIGKILL: no clean shutdown) and comes back
  const restart = RESTART ? (async () => {
    const total = JURORS * TEAMS;
    while (savedOps.size < total * 0.4) await sleep(200);
    restartAt = Date.now() - t0;
    log(`SIGKILL server (pid ${child?.pid}) with ${savedOps.size} ops saved, ${jurors.reduce((n, j) => n + j.ob.size, 0)} queued`);
    const down = Date.now();
    child?.kill("SIGKILL");
    await new Promise(r => child?.once("exit", r));
    await sleep(1500);
    spawnServer();
    await waitHealthy();
    restartDowntime = Date.now() - down;
    restartWindow = [down, Date.now() + 5000];
    log(`server back after ${restartDowntime} ms`);
  })() : null;

  await Promise.all(work);
  if (restart) await restart;
  log("all jurors entered every score; waiting for the queues to drain…");
  const drainEnd = Date.now() + 120_000;
  while (jurors.some(j => j.ob.size > 0 || j.offline) && Date.now() < drainEnd) { jurors.forEach(j => { if (!j.offline && j.ob.size) j.ob.resume(); }); await sleep(500); }
  const elapsed = Date.now() - t0;
  stopFlags = true;
  await coord; if (chaos) await chaos.catch(() => {});
  await sleep(1500); // last screen events
  const finalStage = (await req("GET", "/api/stage")).body;
  const health = (await req("GET", "/api/health")).body;
  clearInterval(cpuTimer);
  clearInterval(lagPoll);
  if (flag("lag-trace")) log(`lag trace: ${lagTrace.map(l => `${l.t}s:${l.p99}/${l.max}`).join(" ")}`);
  const queued = jurors.reduce((n, j) => n + j.ob.size, 0);
  if (queued) for (const j of jurors.filter(x => x.ob.size).slice(0, 5)) log(`stuck: juror ${j.id} paused=${j.ob.isPaused} connected=${j.sock.connected} ops=${JSON.stringify(j.ob.ops.map(o => ({ s: o.status, tries: o.tries, e: o.error })))}`);

  // clean shutdown, then read the database itself
  for (const j of jurors) { j.ob.close(); j.sock.close(); }
  for (const s of screens) s.sock.close();
  adminSock.close();
  child?.kill("SIGTERM");
  await new Promise(r => child?.once("exit", r));
  const db = new Database(path.join(dataDir, "ignite.db"), { readonly: true });
  let lost = 0, wrong = 0, expectedN = 0;
  for (const j of jurors) {
    for (const [teamId, v] of j.expected) {
      expectedN++;
      const row = db.prepare("SELECT values_json FROM scores WHERE juror_id = ? AND team_id = ?").get(j.id, teamId) as { values_json: string } | undefined;
      if (!row) lost++;
      else if (JSON.stringify(JSON.parse(row.values_json)) !== JSON.stringify(v)) wrong++;
    }
  }
  const dbScores = (db.prepare("SELECT COUNT(*) n FROM scores").get() as { n: number }).n;
  const applied = new Set((db.prepare("SELECT op_id FROM score_ops WHERE status = 'applied'").all() as Array<{ op_id: string }>).map(r => r.op_id));
  const historyRows = (db.prepare("SELECT COUNT(*) n FROM score_history WHERE kind IN ('submit','update')").get() as { n: number }).n;
  const retriesServer = (db.prepare("SELECT COALESCE(SUM(tries - 1), 0) n FROM score_ops").get() as { n: number }).n;
  const backups = (fs.existsSync(path.join(dataDir, "backups")) ? fs.readdirSync(path.join(dataDir, "backups")) : []).filter(n => /^auto-.*\.db$/.test(n)).length;
  db.close();
  const appliedNotAcked = [...applied].filter(o => !savedOps.has(o)).length;
  const ackedNotApplied = [...savedOps].filter(o => !applied.has(o)).length;
  const lat: number[] = [], latOutside: number[] = [];
  for (const [opId, k] of opKey) {
    const a = adminSeen.get(k), s = firstSend.get(opId);
    if (a == null || s == null || !savedOps.has(opId)) continue;
    lat.push(Math.max(0, a - s));
    if (!restartWindow || s < restartWindow[0] - 1000 || s > restartWindow[1]) latOutside.push(Math.max(0, a - s));
  }
  for (const r of receipts) { const a = sentStageAt.get(r.key); if (a != null) screenLat.push(r.t - a); }
  const inSync = screens.filter(s => s.timer && JSON.stringify(s.timer) === JSON.stringify(finalStage.timer) && s.slide === (finalStage.show?.slide ?? s.slide)).length;
  const cpuVals = cpu.samples.map(s => s.cpu), rssVals = cpu.samples.map(s => s.rss);
  const out = {
    mode: CHAOS ? (RESTART ? "chaos+restart" : "chaos") : "load", jurors: JURORS, screens: SCREENS, teams: TEAMS, criteria: crit.length,
    elapsedSec: Math.round(elapsed / 100) / 10,
    ops: { enqueuedVersions: opKey.size, sentAndSaved: savedOps.size, sendAttempts: sentAttempts, httpFallbacks, rejected: rejectedOps.length, stillQueued: queued, duplicateAnswers: dupAnswers, refusedRetries: retriesServer },
    result: { expectedScores: expectedN, dbScores, lost, wrong, appliedOps: applied.size, historyRows, appliedNotAcked, ackedNotApplied, duplicateApplications: historyRows - applied.size },
    latencyMs: { scoreToAdmin: stats(lat), ...(restartWindow ? { scoreToAdminOutsideRestart: stats(latOutside) } : {}), scoreAck: stats(ackLat), screenEvent: stats(screenLat) },
    screenSync: { inSyncAtEnd: `${inSync}/${SCREENS}`, avgEvents: Math.round(screens.reduce((n, s) => n + s.events, 0) / Math.max(1, SCREENS)) },
    chaos: CHAOS ? { drops, offlineSpells, restartAtSec: restartAt != null ? Math.round(restartAt / 100) / 10 : null, restartDowntimeMs: restartDowntime } : null,
    server: { cpuPct: { avg: cpuVals.length ? Math.round(cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length) : null, p95: pct(cpuVals, 95), max: cpuVals.length ? Math.round(Math.max(...cpuVals)) : null },
      rssMb: { max: rssVals.length ? Math.round(Math.max(...rssVals)) : null }, eventLoopLagMs: health.eventLoopLagMs, autoBackups: backups },
    dbSynchronous: process.env.DB_SYNCHRONOUS === "NORMAL" ? "NORMAL" : "FULL",
    host: { cpus: os.cpus().length, load1: Math.round(os.loadavg()[0] * 10) / 10, node: process.version },
  };
  console.log(JSON.stringify(out, null, 2));
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2));
  fs.rmSync(dataDir, { recursive: true, force: true });
  const fail = lost || wrong || queued || ackedNotApplied || out.result.duplicateApplications || inSync !== SCREENS;
  log(fail ? "FAIL" : `PASS — lost scores: 0, duplicates: 0, screens in sync: ${inSync}/${SCREENS}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); try { child?.kill("SIGKILL"); } catch { /* gone */ } process.exit(1); });
