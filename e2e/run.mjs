// munsif.im end-to-end browser test (puppeteer-core + a local Chromium). Not part of `npm test` / the Docker build.
//
//   npm run build && npm run test:e2e
//   env: CHROME_PATH (default ~/.hermes/tools/chromium-1208/chrome-linux64/chrome), CHROME_LIBS_FILE (a file whose content
//        is the LD_LIBRARY_PATH Chromium needs; default ~/.hermes/tools/chrome-libs/libpath.txt, ignored when missing),
//        E2E_PORT (default 3077), E2E_OUT (screenshots; default $TMPDIR/ddm-e2e), E2E_HEADFUL=1
//
// Flows: coordinator sign-in (login form) → team + juror created → juror QR sign-in on a phone viewport → scoring
// (online, then 2 scores while the phone is offline: queued, then sent by themselves) → team on stage on the projector →
// timer → last 5 seconds takeover → server killed and restarted (projector and phone reconnect, state unchanged, a score
// sent while the server was down arrives) → reveal on the results screen. Every score is checked in the database API.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();
const CHROME = process.env.CHROME_PATH || path.join(HOME, ".hermes/tools/chromium-1208/chrome-linux64/chrome");
const LIBS_FILE = process.env.CHROME_LIBS_FILE || path.join(HOME, ".hermes/tools/chrome-libs/libpath.txt");
const PORT = Number(process.env.E2E_PORT || 3077);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = process.env.E2E_OUT || path.join(process.env.TMPDIR || os.tmpdir(), "ddm-e2e");
const PW = randomBytes(10).toString("hex");
const SECRET = randomBytes(24).toString("hex");
const dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "ddm-e2e-data-"));
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = m => { passed++; console.log(`  ✓ ${m}`); };
const t0 = Date.now();

if (!fs.existsSync(path.join(root, "dist-server/server/index.js")) || !fs.existsSync(path.join(root, "dist/web/login.html"))) { console.error("Build first: npm run build"); process.exit(2); }
if (!fs.existsSync(CHROME)) { console.error(`Chromium not found: ${CHROME} (set CHROME_PATH)`); process.exit(2); }

// ---------- server ----------
let server = null;
function startServer() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BOOTSTRAP_|ADMIN_|DATA_DIR|ORIGIN|SESSION_SECRET|BACKUP_)/.test(k)));
  server = spawn(process.execPath, ["dist-server/server/index.js"], { cwd: root, stdio: ["ignore", "ignore", "inherit"],
    env: { ...env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR: dataDir, ADMIN_USERNAME: "admin", ADMIN_PASSWORD: PW, SESSION_SECRET: SECRET,
      ORIGIN: BASE, WEB_DIR: path.join(root, "dist/web"), SOFFICE: "", LOG_LEVEL: "warn" } });
}
async function healthy(ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* starting */ } await sleep(150); }
  throw new Error("server not healthy");
}
async function killServer() { const s = server; s.kill("SIGKILL"); await new Promise(r => s.once("exit", r)); }

// ---------- browser ----------
const libs = fs.existsSync(LIBS_FILE) ? fs.readFileSync(LIBS_FILE, "utf8").trim() : "";
const errors = [];
async function main() {
  startServer();
  await healthy();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: process.env.E2E_HEADFUL ? false : true, protocolTimeout: 60000,
    args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"], env: { ...process.env, ...(libs ? { LD_LIBRARY_PATH: libs } : {}) } });
  const page = async (label, w, h, mobile = false) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    p.setDefaultTimeout(20000);
    p.on("pageerror", e => errors.push(`[${label}] ${e.message}`));
    p.on("dialog", d => d.dismiss().catch(() => {}));
    return p;
  };
  const shot = (p, name) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
  try {
    // 1. coordinator signs in
    console.log("coordinator");
    const admin = await page("admin", 1280, 860);
    await admin.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
    await admin.type("#u", "admin");
    await admin.type("#p", PW);
    await Promise.all([admin.waitForNavigation({ waitUntil: "networkidle0" }), admin.click("#go")]);
    if (!/\/(root|admin)/.test(admin.url())) throw new Error(`login landed on ${admin.url()}`);
    ok(`login form → ${new URL(admin.url()).pathname}`);
    const api = (p, method = "GET", body) => admin.evaluate(async (p, method, body) => {
      const r = await fetch(p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, p, method, body);
    await admin.goto(`${BASE}/admin`, { waitUntil: "networkidle0" });
    await shot(admin, "01-admin");

    // 2. team + juror
    const team = await api("/api/admin/teams", "POST", { name: "E2E Komanda", project: "Brauzer testi" });
    if (team.status !== 200) throw new Error(`team ${team.status}`);
    const teams = (await api("/api/admin/teams")).body.filter(t => t.active);
    const juror = await api("/api/admin/jurors", "POST", {});
    if (juror.status !== 200) throw new Error(`juror ${juror.status}`);
    ok(`team and juror created (${teams.length} teams)`);

    // 3. juror QR sign-in on a phone
    console.log("juror (phone)");
    const phone = await page("juror", 390, 844, true);
    await phone.goto(`${BASE}${juror.body.invite.path}`, { waitUntil: "networkidle0" });
    await phone.waitForSelector("#nm");
    await phone.type("#nm", "Test Münsif");
    await Promise.all([phone.waitForNavigation({ waitUntil: "networkidle0" }), phone.click("#go")]);
    await phone.waitForSelector("#submit");
    ok(`QR link → name → ${new URL(phone.url()).pathname}`);
    await phone.waitForFunction(() => document.querySelector("#conn")?.classList.contains("online"));

    const scoreTeam = async (teamId, v) => {
      await phone.evaluate(id => document.querySelector(`.chip[data-team="${id}"]`)?.click(), teamId);
      await phone.waitForFunction(id => document.querySelector(`.chip[data-team="${id}"]`)?.getAttribute("aria-pressed") === "true", {}, teamId);
      await phone.evaluate(v => {
        for (const g of document.querySelectorAll(".scale")) {
          const bs = [...g.querySelectorAll("button[data-v]")];
          (bs.find(b => Number(b.dataset.v) === Math.min(v, bs.length)) ?? bs[bs.length - 1]).click();
        }
      }, v);
      await phone.waitForFunction(() => !document.querySelector("#submit")?.disabled);
      await phone.click("#submit");
    };
    // network on/off through CDP directly (works across Chromium / puppeteer versions)
    const cdp = await phone.createCDPSession();
    await cdp.send("Network.enable");
    const offline = on => cdp.send("Network.emulateNetworkConditions", { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const myScores = async () => (await api("/api/admin/results")).body;
    const scoreCount = async () => (await api("/api/admin/teams")).body.reduce((n, t) => n + (t.scoreCount ?? 0), 0);

    await scoreTeam(teams[0].id, 4);
    await phone.waitForFunction(() => document.querySelector(".st[data-op]")?.dataset.op === "saved");
    if (await scoreCount() !== 1) throw new Error("online score not in the database");
    ok("online score: saved (dock state 'saved', 1 score on the server)");
    await shot(phone, "02-juror-saved");

    // 4. offline: two scores queue on the phone and go out by themselves when the network is back
    await offline(true);
    await phone.waitForFunction(() => document.querySelector("#conn")?.classList.contains("offline"), { timeout: 30000 });
    await scoreTeam(teams[1].id, 3);
    await scoreTeam(teams[2].id, 2);
    await phone.waitForFunction(() => ["queued", "sending"].includes(document.querySelector(".st[data-op]")?.dataset.op ?? ""));
    const queued = await phone.evaluate(() => { const k = Object.keys(localStorage).find(x => x.startsWith("ij.outbox.")); return k ? JSON.parse(localStorage.getItem(k)).ops.length : -1; });
    if (queued !== 2) throw new Error(`expected 2 queued ops in localStorage, got ${queued}`);
    if (await scoreCount() !== 1) throw new Error("offline score reached the server?");
    ok("offline: 2 scores queued in localStorage (dock 'növbədə'), none on the server");
    await shot(phone, "03-juror-offline-queued");
    await offline(false);
    await phone.waitForFunction(() => { const k = Object.keys(localStorage).find(x => x.startsWith("ij.outbox.")); return k && JSON.parse(localStorage.getItem(k)).ops.length === 0; }, { timeout: 30000 });
    if (await scoreCount() !== 3) throw new Error("queued scores did not arrive");
    ok("back online: both queued scores sent by themselves (3 scores on the server, each once)");

    // 5. stage + timer + last 5 seconds on the projector
    console.log("projector");
    const proj = await page("projector", 1280, 720);
    await proj.goto(`${BASE}/stage`, { waitUntil: "networkidle0" });
    await api("/api/admin/event", "PATCH", { currentTeamId: teams[0].id, pitchSec: 10, qaSec: 10 });
    await proj.waitForFunction(name => document.querySelector("#nameTeam")?.textContent?.includes(name), {}, teams[0].name);
    ok(`team on stage shows on the projector (${teams[0].name})`);
    // v4: no control buttons and no key hints on the projector, neither anonymous nor with the coordinator's session;
    // the page itself is never served from a day-old cache (that is how the removed dock came back on a phone)
    const controls = p => p.evaluate(() => ({
      buttons: [...document.querySelectorAll("button, a")].filter(b => b.checkVisibility?.() && b.getBoundingClientRect().width > 0)
        .map(b => b.dataset.act || b.dataset.nav || b.textContent.trim()).filter(x => !["sound", "full", "-1", "1"].includes(x)),
      keys: !!document.querySelector("#keys") || /başlat\/fasilə|R sıfırla|N növbəti/.test(document.body.innerText),
    }));
    const adminProj = await page("projector-admin", 1280, 720);
    for (const c of await admin.cookies()) await adminProj.setCookie(c);
    await adminProj.goto(`${BASE}/stage`, { waitUntil: "networkidle0" });
    await adminProj.mouse.move(400, 300);
    for (const [who, p] of [["anonymous", proj], ["coordinator session", adminProj]]) {
      const c = await controls(p);
      if (c.buttons.length || c.keys) throw new Error(`${who} projector shows controls: ${JSON.stringify(c)}`);
    }
    const cc = (await fetch(`${BASE}/stage`)).headers.get("cache-control");
    if (cc !== "no-cache") throw new Error(`/stage Cache-Control: ${cc}`);
    ok("projector: no control buttons or key hints (anonymous and coordinator session); /stage is revalidated (no-cache)");
    await adminProj.browserContext().close();
    await api("/api/admin/event", "PATCH", { timer: "pitch" });
    await proj.waitForFunction(() => /00:0\d|00:1\d/.test(document.querySelector("#digits")?.textContent ?? ""));
    ok("timer started on the projector");
    await proj.waitForSelector(".st-fx-num", { timeout: 15000 });
    ok("last 5 seconds: the takeover countdown appears");
    await shot(proj, "04-projector-last5");
    await api("/api/admin/event", "PATCH", { timer: "reset" });
    await api("/api/admin/event", "PATCH", { pitchSec: 180, qaSec: 120 });
    await api("/api/admin/event", "PATCH", { timer: "pitch" });
    await sleep(1500);
    const before = (await api("/api/stage")).body;

    // 6. server restart: the state is the same, screens and the phone reconnect by themselves, nothing is lost
    console.log("server restart");
    await killServer();
    await phone.waitForFunction(() => document.querySelector("#conn")?.classList.contains("offline"), { timeout: 30000 });
    await scoreTeam(teams[3].id, 5); // sent while the server is down
    await sleep(1000);
    startServer();
    await healthy();
    const after = (await fetch(`${BASE}/api/stage`).then(r => r.json()));
    if (JSON.stringify({ ...before, serverNow: 0 }) !== JSON.stringify({ ...after, serverNow: 0 })) throw new Error("stage differs after the restart");
    ok("after SIGKILL + restart: stage and running timer identical");
    await phone.waitForFunction(() => document.querySelector("#conn")?.classList.contains("online"), { timeout: 30000 });
    await phone.waitForFunction(() => { const k = Object.keys(localStorage).find(x => x.startsWith("ij.outbox.")); return k && JSON.parse(localStorage.getItem(k)).ops.length === 0; }, { timeout: 30000 });
    if (await scoreCount() !== 4) throw new Error("score sent during the restart did not arrive");
    ok("phone reconnected; the score sent while the server was down arrived (4 scores)");
    await api("/api/admin/stage", "PATCH", { mode: "timer" });
    await api("/api/admin/event", "PATCH", { currentTeamId: teams[1].id });
    await proj.waitForFunction(name => document.querySelector("#nameTeam")?.textContent?.includes(name), { timeout: 30000 }, teams[1].name);
    ok("projector reconnected by itself and follows the next team");

    // 7. reveal
    console.log("reveal");
    const rv = await page("reveal", 1280, 720);
    await rv.goto(`${BASE}/reveal`, { waitUntil: "networkidle0" });
    const en = await api("/api/admin/reveal", "POST", { action: "enable" });
    if (en.status !== 200) throw new Error(`reveal enable ${en.status} ${JSON.stringify(en.body)}`);
    await api("/api/admin/reveal", "POST", { action: "next" });
    await rv.waitForFunction(() => Number(document.querySelector("#progN")?.textContent ?? 0) >= 1, { timeout: 20000 });
    ok("reveal: first place shown on the results screen (scoring locked)");
    await shot(rv, "05-reveal");
    // scoring is closed now: a late score is refused with a clear message and kept on the phone
    await scoreTeam(teams[4].id, 3).catch(() => {});
    const st = await phone.evaluate(() => { const k = Object.keys(localStorage).find(x => x.startsWith("ij.outbox.")); return k ? JSON.parse(localStorage.getItem(k)) : null; });
    if (st && st.log.some(o => o.status === "rejected")) ok("late score after the reveal: refused with a message, kept in the phone's log");
    else if (await phone.$eval("#submit", b => b.disabled).catch(() => true)) ok("late score after the reveal: the phone shows scoring closed (button disabled)");
    else throw new Error("late score neither refused nor blocked");
    if ((await myScores()).results?.ranking?.length < 1) throw new Error("no ranking");
    if (errors.length) console.log(`page errors:\n  ${errors.join("\n  ")}`);
    console.log(`\nE2E PASSED: ${passed} checks in ${Math.round((Date.now() - t0) / 1000)} s · screenshots: ${OUT}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().then(() => { server?.kill("SIGTERM"); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); },
  e => { console.error(`\nE2E FAILED after ${passed} checks: ${e.stack || e}`); if (errors.length) console.error(errors.join("\n")); server?.kill("SIGKILL"); process.exit(1); });
