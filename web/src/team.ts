// munsif.im team panel (/team, /t/<code>): sign in with the organiser's link or code (or register when the
// organiser opened registration), then upload the presentation (PDF / PPTX), logo, site and video links,
// follow the review and the running order, and get notifications. A team never sees any score.
import "./styles.css";
import type { Notice, StagePayload, TeamFile, TeamStatePayload } from "../../shared/types";
import { api, ApiError } from "./lib/api";
import QRCode from "qrcode";
import { fmtClock, timerView } from "../../shared/timer";
import { now, syncClock } from "./lib/clock";
import { $, ago, esc, guarded, icon, toast } from "./lib/dom";
import { bindShare, shareHtml } from "./lib/share";
import { PHASE_LABEL } from "./lib/stage";
import { askNotifications, noticeBell, type NoticeBell } from "./lib/notices";
import { renderPage, openPdf } from "./lib/pdfdeck";
import { live } from "./lib/socket";
import { themeToggleHtml, toggleTheme } from "./lib/theme";

const main = $("#main");
const head = $("#thead");
let S: TeamStatePayload | null = null;
let bell: NoticeBell | null = null;
let busy = false;

const fmtSize = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const dt = (ms: number) => new Date(ms).toLocaleString("az-AZ", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function header(signedIn: boolean, title = "Komanda girişi") {
  head.className = "thead";
  head.innerHTML = `<div class="wrap narrow">
    <a class="brand" href="/" title="munsif.im"><img class="mlogo" src="/brand/munsif-logo.svg" alt="munsif.im" width="111" height="32"><img class="mmark" src="/brand/munsif-mark-flat.svg" alt="munsif.im" width="30" height="30"></a>
    <span class="spacer"></span>
    ${signedIn ? `<span id="bellSlot"></span>` : ""}
    <span class="th1" id="themeOne">${themeToggleHtml()}</span>
    ${signedIn ? `<button class="icon-btn" id="logout" title="Hesabdan çıx" aria-label="Hesabdan çıx">${icon("logout")}</button>` : ""}
  </div>
  <div class="wrap narrow tsub"><b>${esc(title)}</b></div>`;
  $("#themeOne").addEventListener("click", () => { toggleTheme(); $("#themeOne").innerHTML = themeToggleHtml(); });
  head.querySelector("#logout")?.addEventListener("click", () => void logout());
  if (signedIn) {
    bell = noticeBell($("#bellSlot"), { list: "/api/team/notices", read: "/api/team/notices/read" });
    if (S) bell.set(S.notices);
  }
}

// ---------- signed out: link, code, registration ----------
async function signedOut(err = "") {
  header(false);
  headerFor = "out";
  let reg = { open: false, eventName: "" };
  try { reg = await api("/api/team/registration"); } catch { /* offline */ }
  main.innerHTML = `
    <section class="tcard hero-card fade">
      <span class="kicker">${esc(reg.eventName || "munsif.im")}</span>
      <h1 class="tgrad">Komanda girişi</h1>
      <p class="sub">Koordinatorun göndərdiyi <b>komanda linkini</b> açın və ya linkdəki kodu bura yazın. Komandanın bütün üzvləri eyni linklə daxil olur.</p>
      <form id="codeForm" class="stack" novalidate>
        <div><label class="f" for="code">Komanda kodu və ya link</label>
          <input id="code" name="code" class="mono" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH-JKMN" required></div>
        <div><label class="f" for="cName">Adınız və soyadınız</label>
          <input id="cName" maxlength="80" autocomplete="name" placeholder="məs. Aysel Məmmədova"></div>
        <p class="err-t" id="err" role="alert">${esc(err)}</p>
        <button class="btn primary lg" type="submit">Daxil ol</button>
      </form>
    </section>
    ${reg.open ? `<section class="tcard fade">
      <h2>Qeydiyyat</h2>
      <p class="sub">Komandanız siyahıda yoxdursa, burada qeydiyyatdan keçin. Koordinator təsdiqləyəndən sonra çıxış sırasına düşəcəksiniz.</p>
      <form id="regForm" class="stack" novalidate>
        <div><label class="f" for="rName">Komandanın adı</label><input id="rName" name="name" maxlength="120" required autocomplete="organization"></div>
        <div><label class="f" for="rProj">Layihə</label><input id="rProj" name="project" maxlength="160" placeholder="məs. Ağıllı parkinq"></div>
        <p class="err-t" id="rErr" role="alert"></p>
        <button class="btn lg" type="submit">${icon("plus")}Qeydiyyatdan keç</button>
      </form></section>` : ""}
    <p class="tfoot">Koordinatorsunuz? <a href="/login">Daxil olun</a> · Münsiflər koordinatorun göstərdiyi QR kodla daxil olur.</p>`;
  $("#codeForm").addEventListener("submit", async e => {
    e.preventDefault();
    const code = $<HTMLInputElement>("#code").value.trim();
    if (!code) { $("#err").textContent = "Kodu yazın."; return; }
    const memberName = $<HTMLInputElement>("#cName").value.trim().replace(/\s+/g, " ");
    if (memberName.length < 2) { $("#err").textContent = "Adınızı yazın, komanda üzvlər siyahısına düşəcək."; $("#cName").focus(); return; }
    try {
      const r = await api<{ pick?: boolean; path?: string }>("/api/auth/team-code", { method: "POST", body: { code, memberName } });
      if (r.pick && r.path) history.replaceState(null, "", r.path);
      await boot();
    }
    catch (ex) { $("#err").textContent = (ex as ApiError).message; }
  });
  document.getElementById("regForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const name = $<HTMLInputElement>("#rName").value.trim(), project = $<HTMLInputElement>("#rProj").value.trim();
    try {
      const r = await api<{ code: string; path: string }>("/api/team/register", { method: "POST", body: { name, project } });
      toast(`Komanda kodunuz: ${r.code}. Onu yadda saxlayın.`);
      sessionStorage.setItem("munsif-newcode", r.code);
      await boot();
    } catch (ex) { $("#rErr").textContent = (ex as ApiError).message; }
  });
}

// ---------- v14: shared team link: pick your team from the list ----------
interface PickInfo { pick: true; eventName: string; teams: Array<{ id: number; name: string; project: string; taken: boolean }> }
async function pickScreen(code: string, info: PickInfo, err = "") {
  header(false);
  headerFor = "out";
  const free = info.teams.filter(t => !t.taken);
  main.innerHTML = `
    <section class="tcard hero-card fade">
      <span class="kicker">${esc(info.eventName || "munsif.im")}</span>
      <h1 class="tgrad">Komandanızı seçin</h1>
      <p class="sub">Siyahıdan öz komandanızı seçib daxil olun. Seçilən komanda siyahıda bağlanır: başqası onun adından daxil ola bilməz.</p>
      ${info.teams.length ? `<form id="pickForm" class="stack" novalidate>
        <div class="pick-list" role="radiogroup" aria-label="Komandalar">${info.teams.map(t => `
          <label class="pick${t.taken ? " taken" : ""}"><input type="radio" name="team" value="${t.id}" ${t.taken ? "disabled" : ""}>
            <span class="pk-nm"><b>${esc(t.name)}</b>${t.project ? `<small>${esc(t.project)}</small>` : ""}</span>
            ${t.taken ? `<span class="pill">daxil olub</span>` : ""}</label>`).join("")}</div>
        <div><label class="f" for="mName">Adınız və soyadınız</label><input id="mName" maxlength="80" autocomplete="name" placeholder="məs. Aysel Məmmədova" required>
          <small class="sub">Komandanın üzvlər siyahısına əlavə olunur.</small></div>
        <p class="err-t" id="err" role="alert">${esc(err)}</p>
        <button class="btn primary lg" type="submit" ${free.length ? "" : "disabled"}>Daxil ol</button>
      </form>` : `<p class="note">Siyahıda hələ komanda yoxdur. Koordinatora yazın.</p>`}
      <p class="sub" style="margin:0">Komandanız artıq daxil olubsa, komanda yoldaşınızdan dəvət QR-ını istəyin (paneldə “Komanda” bölməsi).</p>
    </section>
    <p class="row" style="justify-content:center"><a class="btn ghost" href="/team">${icon("back")}Geri</a></p>`;
  document.getElementById("pickForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const sel = main.querySelector<HTMLInputElement>("input[name=team]:checked");
    if (!sel) { $("#err").textContent = "Komandanızı seçin."; return; }
    const memberName = $<HTMLInputElement>("#mName").value.trim().replace(/\s+/g, " ");
    if (memberName.length < 2) { $("#err").textContent = "Adınızı yazın."; $("#mName").focus(); return; }
    const name = info.teams.find(t => t.id === Number(sel.value))?.name ?? "";
    if (!confirm(`“${name}” komandası kimi daxil olursunuz. Düzdür?`)) return;
    try {
      await api(`/api/auth/team/${encodeURIComponent(code)}`, { method: "POST", body: { teamId: Number(sel.value), memberName } });
      history.replaceState(null, "", "/team");
      await boot();
    } catch (ex) {
      // somebody may have picked it a moment ago: show the fresh list
      const fresh = await api<PickInfo>(`/api/auth/team/${encodeURIComponent(code)}`).catch(() => info);
      await pickScreen(code, fresh, (ex as ApiError).message);
    }
  });
}

// ---------- v15: a teammate opens the team's own link (invite QR): writes the name and joins the team ----------
interface JoinInfo { teamName: string; project: string; eventName: string }
async function joinScreen(code: string, info: JoinInfo, err = "") {
  header(false);
  headerFor = "out";
  main.innerHTML = `
    <section class="tcard hero-card fade">
      <span class="kicker">${esc(info.eventName || "munsif.im")}</span>
      <h1 class="tgrad">Komandaya qoşulun</h1>
      <div class="pick" style="cursor:default"><span class="tlogo" style="width:40px;height:40px;font-size:18px">${esc((info.teamName.trim()[0] ?? "m").toLocaleUpperCase("az"))}</span>
        <span class="pk-nm"><b>${esc(info.teamName)}</b>${info.project ? `<small>${esc(info.project)}</small>` : ""}</span></div>
      <form id="joinForm" class="stack" novalidate>
        <div><label class="f" for="mName">Adınız və soyadınız</label><input id="mName" maxlength="80" autocomplete="name" placeholder="məs. Aysel Məmmədova" required>
          <small class="sub">Komandanın üzvlər siyahısına əlavə olunur.</small></div>
        <p class="err-t" id="err" role="alert">${esc(err)}</p>
        <button class="btn primary lg" type="submit">Qoşul</button>
      </form>
    </section>
    <p class="row" style="justify-content:center"><a class="btn ghost" href="/team">${icon("back")}Geri</a></p>`;
  $<HTMLInputElement>("#mName").focus();
  $("#joinForm").addEventListener("submit", async e => {
    e.preventDefault();
    const memberName = $<HTMLInputElement>("#mName").value.trim().replace(/\s+/g, " ");
    if (memberName.length < 2) { $("#err").textContent = "Adınızı yazın."; return; }
    try {
      await api(`/api/auth/team/${encodeURIComponent(code)}`, { method: "POST", body: { memberName } });
      history.replaceState(null, "", "/team");
      try { sessionStorage.setItem("munsif-team-tab", "panel"); } catch { /* */ }
      tab = "panel";
      await boot();
    } catch (ex) { $("#err").textContent = (ex as ApiError).message; }
  });
}

// ---------- signed in (v3: one simple page) ----------
const deadlineOf = () => (S ? S.event.extendedUntil ?? S.event.deadline : null);
function left(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return d ? `${d} gün ${p(h)}:${p(m)}:${p(sec)}` : `${p(h)}:${p(m)}:${p(sec)}`;
}
function deadlineHtml() {
  const dl = deadlineOf();
  if (!dl || !S) return "";
  const open = S.event.uploadsOpen;
  const ms = dl - Date.now();
  const cls = !open ? "danger" : ms < 3600_000 ? "warn" : "";
  return `<div class="tdl ${cls}" id="tdl">${icon("timer")}<span><b>${open ? `Yükləməyə <span class="mono" id="tdlLeft">${left(ms)}</span> qalıb` : "Son tarix keçib, yükləmə bağlıdır"}</b>
    <small>Son tarix: ${dt(dl)}${S.event.extendedUntil ? " (sizin üçün uzadılıb)" : ""}${open ? "" : " · koordinatora yazın"}</small></span></div>`;
}

function stageHtml() {
  const s = S!;
  if (!s.queue.onStage) return "";
  const sc = s.slideControl;
  return `<section class="tcard onstage-card fade" id="onStage">
    <div class="os-head"><span class="os-dot"></span><b>Səhnədəsiniz!</b><span class="sub" style="margin:0">${esc(s.event.displayName)}</span></div>
    ${sc.allowed ? `<p class="sub" style="margin:0">Slaydları buradan çevirin, səhnə ekranında dərhal dəyişir.</p>
      <div class="os-thumb" id="osThumb"></div>
      <div class="os-ctl">
        <button class="os-btn" data-slide="-1" ${sc.slide <= 1 ? "disabled" : ""} aria-label="Əvvəlki slayd">${icon("back")}</button>
        <div class="os-n"><small>Slayd</small><b class="mono" id="osN">${sc.slide}${sc.pages ? ` / ${sc.pages}` : ""}</b></div>
        <button class="os-btn go" data-slide="1" ${sc.pages && sc.slide >= sc.pages ? "disabled" : ""} aria-label="Növbəti slayd">${icon("next")}</button>
      </div>` : `<p class="note" style="margin:0">${esc(sc.reason ?? "Slaydları koordinator çevirir.")}</p>`}
  </section>`;
}

// ---------- v15: three tabs (Panel · Pult · Komanda); on phones a tab bar at the bottom ----------
type Tab = "panel" | "pult" | "team";
const TABS: Array<{ id: Tab; label: string; ic: string }> = [
  { id: "panel", label: "Panel", ic: "doc" }, { id: "pult", label: "Pult", ic: "timer" }, { id: "team", label: "Komanda", ic: "users" },
];
let tab: Tab = (() => { try { const v = sessionStorage.getItem("munsif-team-tab"); return v === "pult" || v === "team" ? v : "panel"; } catch { return "panel"; } })();
let wasOnStage = false;
function setTab(t: Tab) {
  tab = t;
  try { sessionStorage.setItem("munsif-team-tab", t); } catch { /* private mode */ }
  render(true);
  scrollTo({ top: 0 });
}
function tabsHtml(kind: "top" | "bar") {
  const live = !!S?.queue.onStage;
  const items = TABS.map(x => `<a href="#${x.id}" data-tab="${x.id}" ${tab === x.id ? 'aria-current="page"' : ""}>
    <span class="ni">${icon(x.ic)}</span><span class="ns">${x.label}${x.id === "pult" && live ? ' <i class="tlive" aria-label="səhnədəsiniz"></i>' : ""}</span></a>`).join("");
  return kind === "top" ? `<nav class="ttabs" aria-label="Bölmələr">${items}</nav>` : items;
}
function paintTabbar() {
  let bar = document.querySelector<HTMLElement>("nav.tabbar.team-tabbar");
  if (!S) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement("nav");
    bar.className = "tabbar team-tabbar";
    bar.setAttribute("aria-label", "Bölmələr");
    bar.addEventListener("click", e => { const a = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]"); if (a) { e.preventDefault(); setTab(a.dataset.tab as Tab); } });
    document.body.appendChild(bar);
  }
  bar.innerHTML = tabsHtml("bar");
}

function statusHtml() {
  const s = S!;
  const m = s.materials;
  const q = s.queue;
  const st = m.approval === "pending" ? { cls: "warn", t: "Təsdiq gözləyir", d: "Koordinator təsdiqləyəndən sonra çıxış sırasına düşəcəksiniz. Faylları indidən yükləyə bilərsiniz." }
    : !m.presentation ? { cls: "", t: "Prezentasiya yüklənməyib", d: "Prezentasiyanızı aşağıda yükləyin (PDF və ya PPTX)." }
    : m.review === "returned" ? { cls: "danger", t: "Düzəliş lazımdır", d: m.reviewNote || "Koordinator düzəliş istəyir." }
    : m.review === "accepted" ? { cls: "ok", t: "Hazırdır", d: "Koordinator prezentasiyanızı qəbul edib." }
    : { cls: "ok", t: "Prezentasiya yüklənib", d: "Koordinator ona baxa bilər. Dəyişmək üçün yeni versiyanı yükləyin." };
  return `<section class="tcard status-card ${st.cls}">
    <div class="row between" style="align-items:flex-start;gap:12px;flex-wrap:nowrap">
      <div style="min-width:0"><span class="kicker">${esc(s.event.displayName)}${s.event.date ? ` · ${esc(s.event.date)}` : ""}</span>
        <h1 class="tname">${esc(s.team.name)}</h1><p class="sub" style="margin:2px 0 0">${esc(s.team.project || "Layihə adı yazılmayıb")}</p></div>
      <span class="tlogo">${m.logo ? `<img src="${m.logo.url}" alt="">` : esc((s.team.name.trim()[0] ?? "m").toLocaleUpperCase("az"))}</span>
    </div>
    <div class="tstep ${st.cls}"><b>${st.t}</b><span>${esc(st.d)}</span></div>
    ${deadlineHtml()}
    <div class="tmeta"><span>${icon("list")}${queueText()}</span><span>${icon("timer")}Təqdimat ${fmtClock(s.event.pitchSec)} + sual-cavab ${fmtClock(s.event.qaSec)}</span></div>
    ${"Notification" in window && Notification.permission === "default" ? `<button class="btn sm" id="allowNotif" style="margin-top:12px">${icon("bell")}Bildirişlərə icazə ver</button>` : ""}
  </section>`;
}
function queueText() {
  const s = S!, q = s.queue;
  return !s.team.active ? "Sırada deyilsiniz"
    : q.onStage ? `<b class="ok-t">Səhnədəsiniz</b>`
    : q.ahead != null ? `Sıranız <b>${q.position}</b> / ${q.total} · qabaqda <b>${q.ahead}</b> komanda`
    : `Sıranız <b>${q.position}</b> / ${q.total}${q.current ? "" : " · çıxışlar başlamayıb"}`;
}

// Pult: who is on stage and the stage timer (live), our slides while we are on stage
function pultHtml() {
  const s = S!;
  const st = s.stage;
  const mine = s.queue.onStage;
  return `${stageHtml()}
    <section class="tcard tclock-card${mine ? " mine" : ""}" id="tClockCard">
      <span class="kicker">${st.team ? (mine ? "Səhnədəsiniz" : "Səhnədə") : "Səhnə"}</span>
      <h2 class="tclock-team">${st.team ? esc(st.team.name) : "Səhnə boşdur"}</h2>
      <div class="tclock"><b class="mono" id="tTime">-</b><span id="tPhase"></span></div>
      <div class="tbar"><i id="tBar"></i></div>
      <p class="sub" style="margin:10px 0 0">${icon("list")} ${queueText()}</p>
      ${mine ? "" : `<p class="sub" style="margin:6px 0 0">Səhnəyə çıxanda slaydlarınızı buradan çevirəcəksiniz (koordinator icazə veribsə). Çıxışınız bitəndə bu imkan bağlanır.</p>`}
    </section>`;
}
function tickClock() {
  const el = document.getElementById("tTime");
  if (!el || !S) return;
  const v = timerView(S.stage.timer, now());
  const ph = document.getElementById("tPhase"), bar = document.getElementById("tBar");
  if (v.kind === "idle") { el.textContent = fmtClock(S.stage.timer.pitchSec); if (ph) ph.textContent = "Taymer başlamayıb"; if (bar) bar.style.width = "100%"; }
  else {
    el.textContent = fmtClock(v.remaining);
    if (ph) ph.textContent = v.ready ? "Hazır" : `${PHASE_LABEL[v.kind]}${!v.running && v.kind !== "done" ? " · fasilə" : ""}`;
    if (bar) bar.style.width = `${v.kind === "done" ? 0 : (v.remainingExact / v.phaseTotal) * 100}%`;
  }
  document.getElementById("tClockCard")?.classList.toggle("warn", v.running && v.remaining <= 30 && v.remaining > 10);
  document.getElementById("tClockCard")?.classList.toggle("danger", v.running && v.remaining <= 10 && v.kind !== "done");
}
setInterval(tickClock, 250);

// Komanda: name / project (rename limit), members (add, remove), invite teammates with a QR
function teamHtml() {
  const s = S!;
  const m = s.materials;
  const pending = m.approval === "pending";
  const canProject = s.event.canRename || pending;
  const left = s.event.renamesLeft;
  const canName = canProject && (pending || left == null || left > 0);
  const nameNote = !canProject ? "Adı dəyişmək üçün koordinatora yazın."
    : pending || left == null ? "" : left > 0 ? `Komanda adını daha <b>${left}</b> dəfə dəyişə bilərsiniz.` : "Ad dəyişmə limiti dolub. Koordinatora yazın.";
  const code = s.code;
  return `<section class="tcard tform">
      <h2>${icon("pencil")}Komanda</h2>
      <form id="teamForm" class="stack" novalidate>
        <div class="tgrid">
          <div><label class="f" for="pName">Komanda adı</label><input id="pName" maxlength="120" value="${esc(s.team.name)}" ${canName ? "" : "disabled"}></div>
          <div><label class="f" for="pProj">Layihə</label><input id="pProj" maxlength="160" value="${esc(s.team.project)}" ${canProject ? "" : "disabled"}></div>
        </div>
        ${nameNote ? `<p class="sub" style="margin:-8px 0 0">${nameNote}</p>` : ""}
        <p class="err-t" id="tErr" role="alert"></p>
        ${canProject ? `<button class="btn primary" type="submit">Yadda saxla</button>` : ""}
      </form>
    </section>
    <section class="tcard">
      <h2>${icon("users")}Üzvlər <span class="pill">${m.members.length}</span></h2>
      ${m.members.length ? `<ul class="tmembers">${m.members.map((x, i) => `<li><span class="ini">${esc(initialsOf(x))}</span><b>${esc(x)}</b>
        <button type="button" class="x" data-mdel="${i}" aria-label="${esc(x)} siyahıdan sil" title="Siyahıdan sil">${icon("trash")}</button></li>`).join("")}</ul>`
        : `<p class="sub" style="margin:0 0 10px">Hələ üzv yazılmayıb.</p>`}
      <form id="memberForm" class="row" style="gap:8px;flex-wrap:nowrap" novalidate>
        <input id="mNew" maxlength="80" placeholder="Ad və soyad" autocomplete="name" aria-label="Yeni üzvün adı" style="flex:1;min-width:0">
        <button class="btn" type="submit">${icon("plus")}Əlavə et</button>
      </form>
    </section>
    ${code ? `<section class="tcard tinvite">
      <h2>${icon("qr")}Komanda yoldaşlarını dəvət et</h2>
      <p class="sub" style="margin:0">Yoldaşınız QR-ı telefonu ilə skan edir, adını yazır və komandaya qoşulur. Adı üzvlər siyahısına özü düşür.</p>
      <div class="qrbox" id="inviteQr"></div>
      <div class="tl-code mono">${esc(code)}</div>
      <div id="inviteShare"></div>
      <p class="sub" style="margin:0">QR açılmırsa: <b>${esc(location.host)}/team</b> səhifəsində bu kodu yazın.</p>
    </section>` : ""}
    <p class="row" style="justify-content:center;margin-top:4px"><button class="btn ghost danger" type="button" id="tLogout">${icon("logout")}Bu telefondan çıx</button></p>`;
}
const initialsOf = (n: string) => n.trim().split(/\s+/).slice(0, 2).map(w => w[0] ?? "").join("").toLocaleUpperCase("az");
async function paintInvite() {
  const box = document.getElementById("inviteQr");
  if (!box || !S?.code) return;
  const url = `${location.origin}/t/${S.code.replace(/-/g, "")}`;
  box.innerHTML = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#0B0F19", light: "#FFFFFF" } });
  const sh = document.getElementById("inviteShare");
  if (sh) sh.innerHTML = shareHtml(url, `${S.team.name} komandasına qoşul (munsif.im)`);
}

function formHtml() {
  const s = S!;
  const m = s.materials;
  const p = m.presentation;
  const open = s.event.uploadsOpen;
  const conv = p?.ext === "pptx"
    ? p.conv === "done" ? `<span class="pill ok">PDF-ə çevrildi</span>`
      : p.conv === "running" || p.conv === "pending" ? `<span class="pill hot">PDF-ə çevrilir…</span>`
      : `<span class="pill danger">PPTX açılmadı, PDF yükləyin</span>`
    : "";
  const versions = s.history.filter(f => f.kind === "presentation");
  return `<section class="tcard tform">
    <form id="profile" class="stack" novalidate>
      <div><span class="f">Prezentasiya</span>
        ${p ? `<div class="pres-now">
          <div class="thumb" id="thumb">${p.viewable ? `<span class="spin"></span>` : icon("doc")}</div>
          <div class="pmeta"><b>${esc(p.name)}</b><small>${p.ext.toUpperCase()} · ${fmtSize(p.size)}${p.pages ? ` · ${p.pages} slayd` : ""} · ${ago(p.createdAt)}</small>${conv}
            ${p.viewable ? `<a class="btn sm" href="${p.url}" target="_blank" rel="noopener" style="margin-top:6px">${icon("expand")}Bax</a>` : ""}</div></div>` : ""}
        <label class="drop ${open ? "" : "disabled"}" id="drop">
          <input type="file" id="file" accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" ${open ? "" : "disabled"} hidden>
          <span class="dicon">${icon("cloud")}</span>
          <b>${open ? (p ? "Yeni versiyanı bura atın və ya seçin" : "Faylı bura atın və ya seçin") : "Yükləmə bağlıdır"}</b>
          <small>PDF${s.soffice ? " və ya PPTX" : ""} · maks. ${s.maxUploadMb} MB</small>
          <span class="btn sm primary" aria-hidden="true">${icon("plus")}Fayl seç</span>
          <div class="upbar" hidden><i></i></div>
        </label>
        ${versions.length > 1 ? `<details class="vers"><summary>Əvvəlki versiyalar (${versions.length - 1})</summary><ul>${versions.slice(1).map((f: TeamFile) => `<li><span>${esc(f.name)}</span><small>${fmtSize(f.size)} · ${dt(f.createdAt)}${f.uploadedBy === "admin" ? " · koordinator" : ""}</small></li>`).join("")}</ul></details>` : ""}
      </div>
      <div><label class="f" for="pSite">Sayt linki</label><input id="pSite" type="url" inputmode="url" maxlength="500" placeholder="https://" value="${esc(m.siteUrl)}" ${open ? "" : "disabled"}>
        ${m.siteUrl ? `<small class="sub">${m.siteEmbeddable === false ? "Sayt səhnə ekranında açılmır, onun yerinə QR kod göstəriləcək." : m.siteEmbeddable ? "Sayt səhnə ekranında açılır." : "Sayt yoxlanılır…"}</small>` : ""}</div>
      <details class="vers more-f"${m.videoUrl || m.logo ? " open" : ""}><summary>Əlavə: demo video və loqo (istəyə bağlı)</summary>
        <div class="stack" style="margin-top:10px">
          <div><label class="f" for="pVideo">Demo video linki</label><input id="pVideo" type="url" inputmode="url" maxlength="500" placeholder="https://" value="${esc(m.videoUrl)}" ${open ? "" : "disabled"}></div>
          <label class="btn sm ghost" style="justify-self:start" ${open ? "" : "aria-disabled=\"true\""}>${icon("plus")}${m.logo ? "Loqonu dəyiş" : "Loqo yüklə"}<input type="file" id="logo" accept="image/png,image/jpeg,image/webp" hidden ${open ? "" : "disabled"}></label>
        </div></details>
      <p class="err-t" id="pErr" role="alert"></p>
      ${open ? `<button class="btn primary lg" type="submit">Linkləri yadda saxla</button>` : ""}
    </form>
  </section>`;
}

let headerFor = "";
function render(force = false) {
  if (!S) return;
  if (headerFor !== "in") { header(true, S.team.name); headerFor = "in"; } else bell?.set(S.notices);
  // going on stage opens the Pult tab by itself (the slide buttons are there)
  if (S.queue.onStage && !wasOnStage) { tab = "pult"; try { sessionStorage.setItem("munsif-team-tab", "pult"); } catch { /* */ } }
  wasOnStage = S.queue.onStage;
  paintTabbar();
  // keep what the user is typing when a refresh arrives (socket) while a field has focus
  const focused = document.activeElement as HTMLInputElement | null;
  const typing = !force && focused && main.contains(focused) && /^(INPUT|TEXTAREA)$/.test(focused.tagName) && focused.type !== "file";
  if (typing) { renderStageOnly(); return; }
  const body = tab === "pult" ? pultHtml() : tab === "team" ? teamHtml() : `${statusHtml()}${formHtml()}`;
  main.innerHTML = `${tabsHtml("top")}${body}
    <p class="tfoot">Bal və reytinq komandalara göstərilmir. Nəticələr proqramın sonunda səhnədə açıqlanır.</p>`;
  if (tab === "panel") void thumb();
  if (tab === "pult") { void stageThumb(); tickClock(); }
  if (tab === "team") void paintInvite();
}
function renderStageOnly() {
  if (tab !== "pult") return;
  const cur = document.getElementById("onStage");
  const html = stageHtml();
  if (cur) { if (html) cur.outerHTML = html; else cur.remove(); }
  else if (html) document.getElementById("tClockCard")?.insertAdjacentHTML("beforebegin", html);
  void stageThumb();
}

async function thumb() {
  const p = S?.materials.presentation;
  const box = document.getElementById("thumb");
  if (!p?.viewable || !box) return;
  try {
    const doc = await openPdf(p.url);
    const r = await renderPage(doc, 1, 240, 160, 2);
    r.c.style.width = `${r.w}px`; r.c.style.height = `${r.h}px`;
    box.replaceChildren(r.c);
    void doc.loadingTask.destroy();
  } catch { box.innerHTML = icon("doc"); }
}

// the slide that is on the projector right now, small, under the big buttons
let osDoc: { url: string; doc: Awaited<ReturnType<typeof openPdf>> } | null = null;
let osTok = 0;
async function stageThumb() {
  const box = document.getElementById("osThumb");
  const p = S?.materials.presentation;
  if (!box || !p?.viewable || !S?.slideControl.allowed) return;
  const tok = ++osTok;
  try {
    if (osDoc?.url !== p.url) { void osDoc?.doc.loadingTask.destroy(); osDoc = { url: p.url, doc: await openPdf(p.url) }; }
    const n = Math.max(1, Math.min(osDoc.doc.numPages, S.slideControl.slide));
    const w = Math.min(box.clientWidth || 320, 520);
    const r = await renderPage(osDoc.doc, n, w, w * 0.62, 2);
    if (tok !== osTok) return;
    r.c.style.width = `${r.w}px`; r.c.style.height = `${r.h}px`;
    box.replaceChildren(r.c);
  } catch { /* the buttons still work */ }
}

// One tap = one slide, also on a slow network: a tap while the previous one is on its way (or a double tap within
// 350 ms) is ignored, and the phone asks for the exact slide it shows, so a repeated request cannot jump two slides.
function slide(d: number) {
  return guarded("slide", async () => {
    if (!S?.slideControl.allowed) return;
    const sc = S.slideControl;
    const n = Math.max(1, sc.pages ? Math.min(sc.pages, sc.slide + d) : sc.slide + d);
    if (n === sc.slide) return;
    sc.slide = n; // optimistic: the number moves at once
    renderStageOnly();
    navigator.vibrate?.(15);
    try {
      const r = await api<{ slideControl: TeamStatePayload["slideControl"]; stage: StagePayload }>("/api/team/slide", { method: "POST", body: { slide: n } });
      S.slideControl = r.slideControl; S.stage = r.stage;
    } catch (ex) { toast((ex as ApiError).message, "err"); await load(); }
    renderStageOnly();
  }, 350);
}

// deadline countdown
setInterval(() => {
  const el = document.getElementById("tdlLeft");
  const dl = deadlineOf();
  if (!el || !dl) return;
  const ms = dl - Date.now();
  el.textContent = left(ms);
  if (ms <= 0) void load();
  else if (ms < 3600_000) document.getElementById("tdl")?.classList.add("warn");
}, 1000);

function upload(file: File, kind: "presentation" | "logo") {
  if (busy) return;
  const max = (S?.maxUploadMb ?? 50) * 1048576;
  if (file.size > max) { toast(`Fayl ${S?.maxUploadMb} MB-dan böyük ola bilməz`, "err"); return; }
  busy = true;
  const barBox = document.querySelector<HTMLElement>(".upbar");
  const bar = barBox?.querySelector("i");
  if (kind === "presentation" && barBox) barBox.hidden = false;
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/team/files?kind=${kind}`);
  xhr.setRequestHeader("Content-Type", "application/octet-stream");
  xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
  xhr.upload.onprogress = e => { if (bar && e.lengthComputable) bar.style.width = `${(e.loaded / e.total) * 100}%`; };
  xhr.onload = () => {
    busy = false;
    let data: { error?: string; state?: TeamStatePayload } = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
    if (xhr.status >= 200 && xhr.status < 300 && data.state) {
      S = data.state;
      toast(kind === "presentation" ? "Prezentasiya yükləndi, koordinatora bildiriş getdi" : "Loqo yükləndi");
      render();
    } else { toast(data.error ?? `Yükləmə alınmadı (${xhr.status})`, "err"); if (barBox) barBox.hidden = true; }
  };
  xhr.onerror = () => { busy = false; toast("Bağlantı kəsildi. Yenidən cəhd edin.", "err"); if (barBox) barBox.hidden = true; };
  xhr.send(file);
}

main.addEventListener("change", e => {
  const i = e.target as HTMLInputElement;
  if (i.id === "file" && i.files?.[0]) upload(i.files[0], "presentation");
  if (i.id === "logo" && i.files?.[0]) upload(i.files[0], "logo");
});
main.addEventListener("dragover", e => { const d = (e.target as HTMLElement).closest("#drop"); if (d && S?.event.uploadsOpen) { e.preventDefault(); d.classList.add("over"); } });
main.addEventListener("dragleave", e => { (e.target as HTMLElement).closest("#drop")?.classList.remove("over"); });
main.addEventListener("drop", e => {
  const d = (e.target as HTMLElement).closest("#drop");
  if (!d) return;
  e.preventDefault(); d.classList.remove("over");
  const f = e.dataTransfer?.files?.[0];
  if (f && S?.event.uploadsOpen) upload(f, "presentation");
});
bindShare(main);
async function logout() {
  if (!confirm("Bu telefondan çıxırsınız. Yenidən daxil olmaq üçün komanda kodu lazım olacaq.")) return;
  await api("/api/team/logout", { method: "POST", body: {} }).catch(() => {});
  try { sessionStorage.removeItem("munsif-team-tab"); } catch { /* */ }
  location.href = "/team";
}
async function saveMembers(members: string[]) {
  try { S = await api<TeamStatePayload>("/api/team/profile", { method: "PATCH", body: { members } }); render(true); return true; }
  catch (ex) { toast((ex as ApiError).message, "err"); return false; }
}
main.addEventListener("click", async e => {
  const t = e.target as HTMLElement;
  const tb = t.closest<HTMLElement>("[data-tab]");
  if (tb) { e.preventDefault(); setTab(tb.dataset.tab as Tab); return; }
  if (t.closest("#tLogout")) { await logout(); return; }
  const md = t.closest<HTMLElement>("[data-mdel]");
  if (md && S) {
    const i = Number(md.dataset.mdel), name = S.materials.members[i];
    if (name == null || !confirm(`“${name}” üzvlər siyahısından silinsin?`)) return;
    if (await saveMembers(S.materials.members.filter((_, k) => k !== i))) toast("Siyahıdan silindi");
    return;
  }
  if (t.closest("#allowNotif")) { const p = await askNotifications(); toast(p === "granted" ? "Bildirişlər açıqdır" : "Brauzer icazə vermədi"); render(true); return; }
  const sb = t.closest<HTMLButtonElement>("[data-slide]");
  if (sb && !sb.disabled) void slide(Number(sb.dataset.slide));
});
// big buttons also on a Bluetooth clicker / keyboard while on stage
document.addEventListener("keydown", e => {
  if (!S?.slideControl.allowed || (e.target as HTMLElement).closest("input, textarea")) return;
  const k = e.key.toLowerCase();
  if (["arrowright", "pagedown"].includes(k)) { e.preventDefault(); void slide(1); }
  else if (["arrowleft", "pageup"].includes(k)) { e.preventDefault(); void slide(-1); }
});
main.addEventListener("submit", async e => {
  const id = (e.target as HTMLElement).id;
  if (!S || !["profile", "teamForm", "memberForm"].includes(id)) return;
  e.preventDefault();
  const v = (sel: string) => $<HTMLInputElement>(sel).value.trim();
  if (id === "memberForm") {
    const n = v("#mNew").replace(/\s+/g, " ");
    if (n.length < 2) { toast("Üzvün adını yazın", "err"); return; }
    if (S.materials.members.some(x => x.toLocaleLowerCase("az") === n.toLocaleLowerCase("az"))) { toast("Bu ad artıq siyahıdadır", "err"); return; }
    if (S.materials.members.length >= 12) { toast("Ən çox 12 üzv yazmaq olar", "err"); return; }
    if (await saveMembers([...S.materials.members, n])) toast("Üzv əlavə olundu");
    return;
  }
  const body: Record<string, unknown> = {};
  if (id === "profile") { body.siteUrl = v("#pSite"); body.videoUrl = v("#pVideo"); }
  if (id === "teamForm") {
    const nameEl = $<HTMLInputElement>("#pName"), projEl = $<HTMLInputElement>("#pProj");
    if (!nameEl.disabled) {
      if (nameEl.value.trim() !== S.team.name && S.event.renamesLeft != null && S.materials.approval !== "pending"
        && !confirm(`Komanda adı “${nameEl.value.trim()}” olsun? Adı daha ${S.event.renamesLeft - 1} dəfə dəyişə biləcəksiniz.`)) return;
      body.name = nameEl.value.trim();
    }
    if (!projEl.disabled) body.project = projEl.value.trim();
  }
  const err = $(id === "profile" ? "#pErr" : "#tErr");
  try { S = await api<TeamStatePayload>("/api/team/profile", { method: "PATCH", body }); toast("Yadda saxlanıldı"); render(true); }
  catch (ex) { err.textContent = (ex as ApiError).message; }
});

async function load() {
  try { S = await api<TeamStatePayload>("/api/team/state"); syncClock(S.stage.serverNow); render(); return true; }
  catch (e) { if ((e as ApiError).status === 401) return false; toast((e as ApiError).message, "err"); return !!S; }
}

let socketOn = false;
let lastStageTeam = -1;
async function boot() {
  // /t/<code>: sign in with the link, then continue at /team (the code leaves the address bar)
  const m = location.pathname.match(/^\/t\/([^/]+)\/?$/);
  if (m) {
    // v14: the shared link of the program shows the team list first (a team already signed in here goes to its panel)
    let info: (Partial<JoinInfo> & { pick?: boolean }) | null = null, infoErr = "";
    try { info = await api(`/api/auth/team/${encodeURIComponent(m[1])}`); } catch (e) { infoErr = (e as ApiError).message; }
    const ses = await api<{ team: boolean }>("/api/auth/session").catch(() => ({ team: false }));
    const signedIn = ses.team && (await load());
    if (!info) { history.replaceState(null, "", "/team"); if (!signedIn) await signedOut(infoErr); else await boot(); return; }
    if (info.pick) {
      if (!signedIn) { await pickScreen(m[1], info as unknown as PickInfo); return; }
    } else if (!signedIn || S?.team.name !== info.teamName) {
      // v15: a teammate (or a new phone): the name goes into the member list
      await joinScreen(m[1], info as JoinInfo); return;
    }
    history.replaceState(null, "", "/team");
  }
  // ask without a 401 first (a fresh visitor gets the sign-in form, and no console error)
  const ses = await api<{ team: boolean }>("/api/auth/session").catch(() => ({ team: true }));
  if (!ses.team || !(await load())) { await signedOut(); return; }
  if (socketOn) return;
  socketOn = true;
  live({
    role: "team",
    on: {
      notice: (n: Notice) => { bell?.push(n); void load(); },
      "team:changed": () => void load(),
      "stage:changed": (st: StagePayload) => {
        const me = S?.team.id;
        const changed = (st.team?.id ?? 0) !== lastStageTeam;
        lastStageTeam = st.team?.id ?? 0;
        // on stage: the slide number follows the projector (coordinator / remote / our own presses) without a refetch
        if (!changed && S && me && st.team?.id === me && S.slideControl.allowed && st.show.scene === "team" && st.show.mode === "auto") {
          S.stage = st; S.slideControl.slide = st.show.slide; renderStageOnly(); return;
        }
        if (changed || st.team?.id === me || S?.queue.onStage) void load();
      },
      "config:changed": () => void load(),
      "timer:changed": (p: { timer: StagePayload["timer"]; serverNow: number }) => { if (S) { S.stage = { ...S.stage, timer: p.timer }; syncClock(p.serverNow); tickClock(); } },
    },
    resync: () => void load(),
  });
}
void boot();
