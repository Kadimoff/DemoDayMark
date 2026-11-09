// munsif.im team panel (/team, /t/<code>): sign in with the organiser's link or code (or register when the
// organiser opened registration), then upload the presentation (PDF / PPTX), logo, site and video links,
// follow the review and the running order, and get notifications. A team never sees any score.
import "./styles.css";
import type { Notice, StagePayload, TeamFile, TeamStatePayload } from "../../shared/types";
import { api, ApiError } from "./lib/api";
import { $, ago, esc, icon, toast } from "./lib/dom";
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
  head.querySelector("#logout")?.addEventListener("click", async () => { await api("/api/team/logout", { method: "POST", body: {} }).catch(() => {}); location.href = "/team"; });
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
    try {
      const r = await api<{ pick?: boolean; path?: string }>("/api/auth/team-code", { method: "POST", body: { code } });
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
        <p class="err-t" id="err" role="alert">${esc(err)}</p>
        <button class="btn primary lg" type="submit" ${free.length ? "" : "disabled"}>Daxil ol</button>
      </form>` : `<p class="note">Siyahıda hələ komanda yoxdur. Koordinatora yazın.</p>`}
      <p class="sub" style="margin:0">Komandanız artıq daxil olubsa, komanda yoldaşınızın panelindəki <b>komanda kodunu</b> <a href="/team">${esc(location.host)}/team</a> səhifəsində yazın.</p>
    </section>`;
  document.getElementById("pickForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const sel = main.querySelector<HTMLInputElement>("input[name=team]:checked");
    if (!sel) { $("#err").textContent = "Komandanızı seçin."; return; }
    const name = info.teams.find(t => t.id === Number(sel.value))?.name ?? "";
    if (!confirm(`“${name}” komandası kimi daxil olursunuz. Düzdür?`)) return;
    try {
      await api(`/api/auth/team/${encodeURIComponent(code)}`, { method: "POST", body: { teamId: Number(sel.value) } });
      history.replaceState(null, "", "/team");
      await boot();
    } catch (ex) {
      // somebody may have picked it a moment ago: show the fresh list
      const fresh = await api<PickInfo>(`/api/auth/team/${encodeURIComponent(code)}`).catch(() => info);
      await pickScreen(code, fresh, (ex as ApiError).message);
    }
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

function statusHtml() {
  const s = S!;
  const m = s.materials;
  const q = s.queue;
  const st = m.approval === "pending" ? { cls: "warn", t: "Təsdiq gözləyir", d: "Koordinator təsdiqləyəndən sonra çıxış sırasına düşəcəksiniz. Faylları indidən yükləyə bilərsiniz." }
    : !m.presentation ? { cls: "", t: "Prezentasiya yüklənməyib", d: "Prezentasiyanızı aşağıda yükləyin (PDF və ya PPTX)." }
    : m.review === "returned" ? { cls: "danger", t: "Düzəliş lazımdır", d: m.reviewNote || "Koordinator düzəliş istəyir." }
    : m.review === "accepted" ? { cls: "ok", t: "Hazırdır", d: "Koordinator prezentasiyanızı qəbul edib." }
    : { cls: "ok", t: "Prezentasiya yüklənib", d: "Koordinator ona baxa bilər. Dəyişmək üçün yeni versiyanı yükləyin." };
  const queue = !s.team.active ? "Sırada deyilsiniz"
    : q.onStage ? `<b class="ok-t">Səhnədəsiniz</b>`
    : q.ahead != null ? `Sıranız <b>${q.position}</b> / ${q.total} · qabaqda <b>${q.ahead}</b> komanda`
    : `Sıranız <b>${q.position}</b> / ${q.total}${q.current ? "" : " · çıxışlar başlamayıb"}`;
  const code = s.code ?? sessionStorage.getItem("munsif-newcode");
  return `<section class="tcard status-card ${st.cls}">
    <div class="row between" style="align-items:flex-start;gap:12px;flex-wrap:nowrap">
      <div style="min-width:0"><span class="kicker">${esc(s.event.displayName)}${s.event.date ? ` · ${esc(s.event.date)}` : ""}</span>
        <h1 class="tname">${esc(s.team.name)}</h1><p class="sub" style="margin:2px 0 0">${esc(s.team.project || "Layihə adı yazılmayıb")}</p></div>
      <span class="tlogo">${m.logo ? `<img src="${m.logo.url}" alt="">` : esc((s.team.name.trim()[0] ?? "m").toLocaleUpperCase("az"))}</span>
    </div>
    <div class="tstep ${st.cls}"><b>${st.t}</b><span>${esc(st.d)}</span></div>
    ${deadlineHtml()}
    <div class="tmeta"><span>${icon("list")}${queue}</span><span>${icon("timer")}Təqdimat ${Math.round(s.event.pitchSec / 6) / 10} dəq + sual-cavab ${Math.round(s.event.qaSec / 6) / 10} dəq</span></div>
    ${code ? `<div class="note tcode" style="margin-top:12px">Komanda kodunuz: <b class="mono">${esc(code)}</b>
      <span>Komanda yoldaşlarınız <b>${esc(location.host)}/team</b> səhifəsində bu kodu yazıb daxil olur.</span></div>` : ""}
    ${"Notification" in window && Notification.permission === "default" ? `<button class="btn sm" id="allowNotif" style="margin-top:12px">${icon("bell")}Bildirişlərə icazə ver</button>` : ""}
  </section>`;
}

function formHtml() {
  const s = S!;
  const m = s.materials;
  const p = m.presentation;
  const canName = s.event.canRename || m.approval === "pending";
  const open = s.event.uploadsOpen;
  const conv = p?.ext === "pptx"
    ? p.conv === "done" ? `<span class="pill ok">PDF-ə çevrildi</span>`
      : p.conv === "running" || p.conv === "pending" ? `<span class="pill hot">PDF-ə çevrilir…</span>`
      : `<span class="pill danger">PPTX açılmadı, PDF yükləyin</span>`
    : "";
  const versions = s.history.filter(f => f.kind === "presentation");
  return `<section class="tcard tform">
    <form id="profile" class="stack" novalidate>
      <div class="tgrid">
        <div><label class="f" for="pName">Komanda adı</label><input id="pName" maxlength="120" value="${esc(s.team.name)}" ${canName ? "" : "disabled"}></div>
        <div><label class="f" for="pProj">Layihə</label><input id="pProj" maxlength="160" value="${esc(s.team.project)}" ${canName ? "" : "disabled"}></div>
      </div>
      ${canName ? "" : `<p class="sub" style="margin:-8px 0 0">Adı dəyişmək üçün koordinatora yazın.</p>`}
      <div><label class="f" for="pMembers">Üzvlər <small>(hər sətirdə bir nəfər)</small></label><textarea id="pMembers" rows="3" maxlength="1000" placeholder="Aysel Məmmədova&#10;Rəşad Quliyev">${esc(m.members.join("\n"))}</textarea></div>
      <div><label class="f" for="pSite">Sayt linki</label><input id="pSite" type="url" inputmode="url" maxlength="500" placeholder="https://" value="${esc(m.siteUrl)}" ${open ? "" : "disabled"}>
        ${m.siteUrl ? `<small class="sub">${m.siteEmbeddable === false ? "Sayt səhnə ekranında açılmır, onun yerinə QR kod göstəriləcək." : m.siteEmbeddable ? "Sayt səhnə ekranında açılır." : "Sayt yoxlanılır…"}</small>` : ""}</div>
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
      <details class="vers more-f"${m.videoUrl || m.logo ? " open" : ""}><summary>Əlavə: demo video və loqo (istəyə bağlı)</summary>
        <div class="stack" style="margin-top:10px">
          <div><label class="f" for="pVideo">Demo video linki</label><input id="pVideo" type="url" inputmode="url" maxlength="500" placeholder="https://" value="${esc(m.videoUrl)}" ${open ? "" : "disabled"}></div>
          <label class="btn sm ghost" style="justify-self:start" ${open ? "" : "aria-disabled=\"true\""}>${icon("plus")}${m.logo ? "Loqonu dəyiş" : "Loqo yüklə"}<input type="file" id="logo" accept="image/png,image/jpeg,image/webp" hidden ${open ? "" : "disabled"}></label>
        </div></details>
      <p class="err-t" id="pErr" role="alert"></p>
      <button class="btn primary lg" type="submit">Yadda saxla</button>
    </form>
  </section>`;
}

let headerFor = "";
function render() {
  if (!S) return;
  if (headerFor !== "in") { header(true, S.team.name); headerFor = "in"; } else bell?.set(S.notices);
  // keep what the user is typing when a refresh arrives (socket) while a field has focus
  const focused = document.activeElement as HTMLInputElement | null;
  const typing = focused && main.contains(focused) && /^(INPUT|TEXTAREA)$/.test(focused.tagName) && focused.type !== "file" ? { id: focused.id, v: focused.value } : null;
  if (typing && document.getElementById("profile")) { renderStageOnly(); return; }
  main.innerHTML = `${stageHtml()}${statusHtml()}${formHtml()}
    <p class="tfoot">Bal və reytinq komandalara göstərilmir. Nəticələr proqramın sonunda səhnədə açıqlanır.</p>`;
  void thumb();
  void stageThumb();
}
function renderStageOnly() {
  const cur = document.getElementById("onStage");
  const html = stageHtml();
  if (cur) { if (html) cur.outerHTML = html; else cur.remove(); }
  else if (html) main.insertAdjacentHTML("afterbegin", html);
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

let slideBusy = false;
async function slide(d: number) {
  if (!S?.slideControl.allowed || slideBusy) return;
  slideBusy = true;
  // optimistic: the number moves at once, the server answers within ~100 ms
  const sc = S.slideControl;
  const n = Math.max(1, sc.pages ? Math.min(sc.pages, sc.slide + d) : sc.slide + d);
  if (n === sc.slide) { slideBusy = false; return; }
  sc.slide = n;
  renderStageOnly();
  navigator.vibrate?.(15);
  try {
    const r = await api<{ slideControl: TeamStatePayload["slideControl"]; stage: StagePayload }>("/api/team/slide", { method: "POST", body: { delta: d } });
    S.slideControl = r.slideControl; S.stage = r.stage;
  } catch (ex) { toast((ex as ApiError).message, "err"); await load(); }
  slideBusy = false;
  renderStageOnly();
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
main.addEventListener("click", async e => {
  const t = e.target as HTMLElement;
  if (t.closest("#allowNotif")) { const p = await askNotifications(); toast(p === "granted" ? "Bildirişlər açıqdır" : "Brauzer icazə vermədi"); render(); return; }
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
  if ((e.target as HTMLElement).id !== "profile" || !S) return;
  e.preventDefault();
  const v = (id: string) => $<HTMLInputElement>(id).value.trim();
  const body: Record<string, unknown> = {
    members: v("#pMembers").split(/\n|,/).map(x => x.trim()).filter(Boolean).slice(0, 12),
  };
  if (S.event.uploadsOpen) { body.siteUrl = v("#pSite"); body.videoUrl = v("#pVideo"); }
  if (S.event.canRename || S.materials.approval === "pending") { body.name = v("#pName"); body.project = v("#pProj"); }
  try { S = await api<TeamStatePayload>("/api/team/profile", { method: "PATCH", body }); toast("Yadda saxlanıldı"); render(); }
  catch (ex) { $("#pErr").textContent = (ex as ApiError).message; }
});

async function load() {
  try { S = await api<TeamStatePayload>("/api/team/state"); render(); return true; }
  catch (e) { if ((e as ApiError).status === 401) return false; toast((e as ApiError).message, "err"); return !!S; }
}

let socketOn = false;
let lastStageTeam = -1;
async function boot() {
  // /t/<code>: sign in with the link, then continue at /team (the code leaves the address bar)
  const m = location.pathname.match(/^\/t\/([^/]+)\/?$/);
  if (m) {
    // v14: the shared link of the program shows the team list first (a team already signed in here goes to its panel)
    const info = await api<{ pick?: boolean }>(`/api/auth/team/${encodeURIComponent(m[1])}`).catch(() => null);
    if (info?.pick) {
      const ses = await api<{ team: boolean }>("/api/auth/session").catch(() => ({ team: false }));
      if (!ses.team || !(await load())) { await pickScreen(m[1], info as PickInfo); return; }
    } else {
      try { await api(`/api/auth/team/${encodeURIComponent(m[1])}`, { method: "POST", body: {} }); }
      catch (e) { history.replaceState(null, "", "/team"); if (!(await load())) await signedOut((e as ApiError).message); return; }
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
    },
    resync: () => void load(),
  });
}
void boot();
