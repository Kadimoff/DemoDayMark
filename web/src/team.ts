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
    ${signedIn ? `<button class="icon-btn" id="logout" title="Çıxış" aria-label="Çıxış">${icon("logout")}</button>` : ""}
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
      <p class="sub">Təşkilatçının göndərdiyi <b>komanda linkini</b> açın və ya linkdəki kodu yazın. Komandanın bütün üzvləri eyni linklə daxil ola bilər.</p>
      <form id="codeForm" class="stack" novalidate>
        <div><label class="f" for="code">Komanda kodu və ya link</label>
          <input id="code" name="code" class="mono" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH-JKMN" required></div>
        <p class="err-t" id="err" role="alert">${esc(err)}</p>
        <button class="btn primary lg" type="submit">Daxil ol</button>
      </form>
    </section>
    ${reg.open ? `<section class="tcard fade">
      <h2>Qeydiyyat</h2>
      <p class="sub">Komandanız siyahıda yoxdursa, qeydiyyatdan keçin. Təşkilatçı təsdiqləyəndən sonra çıxış sırasına düşəcəksiniz.</p>
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
    try { await api("/api/auth/team-code", { method: "POST", body: { code } }); await boot(); }
    catch (ex) { $("#err").textContent = (ex as ApiError).message; }
  });
  document.getElementById("regForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    const name = $<HTMLInputElement>("#rName").value.trim(), project = $<HTMLInputElement>("#rProj").value.trim();
    try {
      const r = await api<{ code: string; path: string }>("/api/team/register", { method: "POST", body: { name, project } });
      toast(`Komanda kodunuz: ${r.code} — yadda saxlayın`);
      sessionStorage.setItem("munsif-newcode", r.code);
      await boot();
    } catch (ex) { $("#rErr").textContent = (ex as ApiError).message; }
  });
}

// ---------- signed in ----------
function statusCard() {
  const s = S!;
  const m = s.materials;
  const q = s.queue;
  const step = m.approval === "pending"
    ? { cls: "warn", t: "Təsdiq gözləyir", d: "Təşkilatçı komandanızı təsdiqləyəndən sonra çıxış sırasına düşəcəksiniz. Materialları indidən yükləyə bilərsiniz." }
    : m.review === "accepted" ? { cls: "ok", t: "Prezentasiyanız qəbul edildi", d: "Hər şey hazırdır. Dəyişiklik etsəniz, yenidən yoxlanılacaq." }
    : m.review === "submitted" ? { cls: "hot", t: "Yoxlanılır", d: "Prezentasiyanız təşkilatçıya göndərildi. Qəbul edəndə bildiriş gələcək." }
    : m.review === "returned" ? { cls: "danger", t: "Geri qaytarıldı", d: m.reviewNote || "Təşkilatçı düzəliş istəyir." }
    : { cls: "", t: "Prezentasiya gözlənilir", d: "Prezentasiyanızı PDF (və ya PPTX) kimi yükləyin." };
  const queue = !s.team.active ? "Sırada deyilsiniz"
    : q.onStage ? `<b class="ok-t">Səhnədəsiniz!</b>`
    : q.ahead != null ? `Sıranız: <b>${q.position}</b> / ${q.total} · qabaqda <b>${q.ahead}</b> komanda`
    : `Sıranız: <b>${q.position}</b> / ${q.total}${q.current ? "" : " · çıxışlar hələ başlamayıb"}`;
  const dl = s.event.deadline;
  const newCode = sessionStorage.getItem("munsif-newcode");
  return `<section class="tcard status-card ${step.cls}">
    <div class="row between" style="align-items:flex-start;gap:12px">
      <div style="min-width:0"><span class="kicker">${esc(s.event.displayName)}${s.event.date ? ` · ${esc(s.event.date)}` : ""}</span>
        <h1 class="tname">${esc(s.team.name)}</h1><p class="sub" style="margin:2px 0 0">${esc(s.team.project || "Layihə adı yazılmayıb")}</p></div>
      <span class="tlogo">${m.logo ? `<img src="${m.logo.url}" alt="">` : esc((s.team.name.trim()[0] ?? "m").toLocaleUpperCase("az"))}</span>
    </div>
    <div class="tstep ${step.cls}"><b>${step.t}</b><span>${esc(step.d)}</span></div>
    <div class="tmeta">
      <span>${icon("list")}${queue}</span>
      <span>${icon("timer")}Pitch ${Math.round(s.event.pitchSec / 60 * 10) / 10} dəq + sual-cavab ${Math.round(s.event.qaSec / 60 * 10) / 10} dəq</span>
      ${dl ? `<span class="${s.event.uploadsOpen ? "" : "danger-t"}">${icon("lock")}Deadline: ${dt(dl)}${s.event.uploadsOpen ? "" : " — yükləmə bağlıdır"}</span>` : ""}
    </div>
    ${newCode ? `<div class="note" style="margin-top:12px">Komanda kodunuz: <b class="mono">${esc(newCode)}</b> — üzvlərlə paylaşın (munsif.im/team səhifəsində yazılır).</div>` : ""}
    ${"Notification" in window && Notification.permission === "default" ? `<button class="btn sm" id="allowNotif" style="margin-top:12px">${icon("bell")}Bildirişlərə icazə ver</button>` : ""}
  </section>`;
}

function presCard() {
  const s = S!;
  const p = s.materials.presentation;
  const open = s.event.uploadsOpen;
  const conv = p?.ext === "pptx"
    ? p.conv === "done" ? `<span class="pill ok">PPTX → PDF hazırdır</span>`
      : p.conv === "running" || p.conv === "pending" ? `<span class="pill hot">PDF-ə çevrilir…</span>`
      : `<span class="pill danger">PPTX səhnədə göstərilə bilmir — PDF kimi yükləyin</span>`
    : "";
  return `<section class="tcard">
    <div class="row between"><h2>${icon("doc")}Prezentasiya</h2>${p ? `<span class="sub" style="margin:0">${ago(p.createdAt)} yükləndi</span>` : ""}</div>
    ${p ? `<div class="pres-now">
        <div class="thumb" id="thumb">${p.viewable ? `<span class="spin"></span>` : icon("doc")}</div>
        <div class="pmeta"><b>${esc(p.name)}</b><small>${p.ext.toUpperCase()} · ${fmtSize(p.size)}${p.pages ? ` · ${p.pages} slayd` : ""}</small>${conv}
          <div class="row" style="gap:6px;margin-top:6px">${p.viewable ? `<a class="btn sm" href="${p.url}" target="_blank" rel="noopener">${icon("expand")}Bax</a>` : ""}
          <a class="btn sm ghost" href="${p.url}?orig=1&download=1">${icon("download")}Endir</a></div></div></div>` : ""}
    <label class="drop ${open ? "" : "disabled"}" id="drop">
      <input type="file" id="file" accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" ${open ? "" : "disabled"} hidden>
      <span class="dicon">${icon("cloud")}</span>
      <b>${p ? "Yeni versiya yüklə" : "Prezentasiyanı yüklə"}</b>
      <small>PDF${s.soffice ? " və ya PPTX (avtomatik PDF-ə çevrilir)" : " (PPTX-i əvvəlcə PDF kimi saxlayın)"} · maks. ${s.maxUploadMb} MB</small>
      <div class="upbar" hidden><i></i></div>
    </label>
    ${s.history.filter(f => f.kind === "presentation").length > 1 ? `<details class="vers"><summary>Versiyalar (${s.history.filter(f => f.kind === "presentation").length})</summary>
      <ul>${s.history.filter(f => f.kind === "presentation").map((f: TeamFile) => `<li class="${f.active ? "on" : ""}"><span>${esc(f.name)}</span><small>${fmtSize(f.size)}${f.pages ? ` · ${f.pages} slayd` : ""} · ${dt(f.createdAt)}${f.uploadedBy === "admin" ? " · təşkilatçı" : ""}${f.active ? " · <b>aktiv</b>" : ""}</small></li>`).join("")}</ul></details>` : ""}
  </section>`;
}

function profileCard() {
  const s = S!;
  const m = s.materials;
  const canName = s.event.canRename || m.approval === "pending";
  const open = s.event.uploadsOpen;
  return `<section class="tcard">
    <h2>${icon("users")}Komanda və linklər</h2>
    <form id="profile" class="stack" novalidate>
      <div class="row" style="align-items:flex-start">
        <div style="flex:1 1 200px"><label class="f" for="pName">Komanda adı</label><input id="pName" maxlength="120" value="${esc(s.team.name)}" ${canName ? "" : "disabled"}></div>
        <div style="flex:1 1 200px"><label class="f" for="pProj">Layihə</label><input id="pProj" maxlength="160" value="${esc(s.team.project)}" ${canName ? "" : "disabled"}></div>
      </div>
      ${canName ? "" : `<p class="sub" style="margin:-6px 0 0">Adı dəyişmək üçün təşkilatçıya yazın.</p>`}
      <div><label class="f" for="pMembers">Üzvlər (hər sətirdə bir nəfər)</label><textarea id="pMembers" rows="3" maxlength="1000" placeholder="Aysel Məmmədova&#10;Rəşad Quliyev">${esc(m.members.join("\n"))}</textarea></div>
      <div><label class="f" for="pSite">Layihə saytı</label><input id="pSite" type="url" inputmode="url" maxlength="500" placeholder="https://" value="${esc(m.siteUrl)}" ${open ? "" : "disabled"}>
        ${m.siteUrl ? `<small class="sub">${m.siteEmbeddable === false ? "Sayt səhnədə daxil edilə bilmir — səhnədə QR kod göstəriləcək." : m.siteEmbeddable ? "Sayt səhnədə açılır." : "Sayt yoxlanılır…"}</small>` : ""}</div>
      <div><label class="f" for="pVideo">Demo video (YouTube, Drive və s.)</label><input id="pVideo" type="url" inputmode="url" maxlength="500" placeholder="https://" value="${esc(m.videoUrl)}" ${open ? "" : "disabled"}></div>
      <p class="err-t" id="pErr" role="alert"></p>
      <div class="row"><button class="btn primary" type="submit">Yadda saxla</button>
        <label class="btn ghost" ${open ? "" : "aria-disabled=\"true\""}>${icon("plus")}${m.logo ? "Loqonu dəyiş" : "Loqo yüklə"}<input type="file" id="logo" accept="image/png,image/jpeg,image/webp" hidden ${open ? "" : "disabled"}></label></div>
    </form>
  </section>`;
}

let headerFor = "";
function render() {
  if (!S) return;
  if (headerFor !== "in") { header(true, S.team.name); headerFor = "in"; } else bell?.set(S.notices);
  main.innerHTML = `${statusCard()}${presCard()}${profileCard()}
    <p class="tfoot">Bal və reytinq komandalara göstərilmir. Nəticələr tədbirin sonunda səhnədə açıqlanır.</p>`;
  void thumb();
}

let thumbUrl = "";
async function thumb() {
  const p = S?.materials.presentation;
  const box = document.getElementById("thumb");
  if (!p?.viewable || !box) return;
  try {
    const doc = await openPdf(p.url);
    const r = await renderPage(doc, 1, 240, 160, 2);
    r.c.style.width = `${r.w}px`; r.c.style.height = `${r.h}px`;
    box.replaceChildren(r.c);
    thumbUrl = p.url;
    void doc.loadingTask.destroy();
  } catch { box.innerHTML = icon("doc"); }
}

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
      toast(kind === "presentation" ? "Prezentasiya yükləndi — təşkilatçıya bildiriş getdi" : "Loqo yükləndi");
      render();
    } else { toast(data.error ?? `Yükləmə alınmadı (${xhr.status})`, "err"); if (barBox) barBox.hidden = true; }
  };
  xhr.onerror = () => { busy = false; toast("Bağlantı kəsildi — yenidən cəhd edin", "err"); if (barBox) barBox.hidden = true; };
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
  if ((e.target as HTMLElement).closest("#allowNotif")) { const p = await askNotifications(); toast(p === "granted" ? "Bildirişlər açıqdır" : "Brauzer icazə vermədi"); render(); }
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
    try { await api(`/api/auth/team/${encodeURIComponent(m[1])}`, { method: "POST", body: {} }); }
    catch (e) { history.replaceState(null, "", "/team"); if (!(await load())) await signedOut((e as ApiError).message); return; }
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
      "stage:changed": (st: StagePayload) => { if ((st.team?.id ?? 0) !== lastStageTeam) { lastStageTeam = st.team?.id ?? 0; void load(); } },
      "config:changed": () => void load(),
    },
    resync: () => void load(),
  });
}
void boot();
