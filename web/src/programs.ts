// v4 "Proqramlar": a program (proqram = one event / competition) has its own teams, jurors, rubric and results.
// One program is active at a time; earlier ones stay in the history, read-only, with everything that happened in them.
// - Aktiv proqram: what runs now.
// - Yeni proqram yarat: archives the active program and starts a new one; the rubric, the team names and the juror names
//   can be taken from any earlier program (each copied juror gets a new QR, no scores move).
// - Tarixçə: every archived program (programs imported from a backup too) → a full read-only view: final ranking, teams and
//   their materials, jurors, every juror's scores, the scoring history, Excel / PDF.
import "./styles.css";
import { FREE_NAME, brandName } from "../../shared/brand";
import { fmtClock } from "../../shared/timer";
import type { AdminTeam, Criterion, Juror, ScoreRow, TeamFile } from "../../shared/types";
import { api, ApiError } from "./lib/api";
import { adminNav } from "./lib/adminnav";
import { $, esc, icon, toast } from "./lib/dom";
import { mountHistory } from "./lib/history";
import { live } from "./lib/socket";
import { topbar } from "./lib/topbar";
import { openViewer } from "./lib/viewer";

interface EventItem {
  id: number; name: string; status: "active" | "archived"; createdAt: number; archivedAt: number | null; date: string; product: string;
  teams: number; jurors: number; scores: number; top: Array<{ rank: number | null; name: string; score: number | null }>;
  imported: { file: string; at: number } | null;
}
interface RankRow { team: AdminTeam; rank: number | null; score: number | null; demo: number | null; entry: number | null; n: number; incomplete: boolean }
interface Detail {
  meta: { id: number; name: string; status: string; createdAt: number; archivedAt: number | null };
  event: { name: string; product: string; displayName: string; date: string; pitchSec: number; qaSec: number; includeEntry: boolean; entryMax: number; locked: boolean };
  readOnly: boolean;
  results: { ranking: RankRow[]; matrix: Record<number, Record<number, number | null>>; done: number; need: number; demoMax: number; maxTotal: number };
  teams: Array<AdminTeam & { members: string[]; siteUrl: string; videoUrl: string; presentation: (TeamFile & { missing: boolean }) | null; logo: (TeamFile & { missing: boolean }) | null; scores: number }>;
  jurors: Juror[];
  criteria: Criterion[];
  scores: Array<ScoreRow & { total: number | null }>;
  historyTotal: number;
  imported: { file: string; schema: number; at: number } | null;
}
interface ActiveState { event: { name: string; product: string; date: string; timer: { pitchSec: number; qaSec: number } }; criteria: Criterion[]; jurors: Juror[] }

const bar = topbar({ role: "admin", nav: adminNav("programs"), wide: true });
const main = $("#main");
let EV: EventItem[] = [];
let ACT: ActiveState | null = null;
let formOpen = false;
let view: number | null = null;

const p2 = (n: number) => String(n).padStart(2, "0");
const d = (ms: number | null) => { if (!ms) return ""; const x = new Date(ms); return `${p2(x.getDate())}.${p2(x.getMonth() + 1)}.${x.getFullYear()}`; };
const f2 = (v: number | null) => (v == null ? "" : (Math.round(v * 100) / 100).toFixed(2));
const parseClock = (v: string) => { const m = v.trim().match(/^(\d{1,2})(?::([0-5]\d))?$/); return m ? Number(m[1]) * 60 + Number(m[2] ?? 0) : null; };
const hashId = () => { const m = location.hash.match(/^#p(\d+)$/); return m ? Number(m[1]) : null; };

async function load() {
  try {
    const [evs, st] = await Promise.all([api<EventItem[]>("/api/admin/events"), api<ActiveState & { stage: { eventName: string } }>("/api/admin/state")]);
    EV = evs; ACT = st;
    bar.setEventName(st.stage.eventName);
  } catch (e) { main.innerHTML = `<div class="banner err">${esc((e as Error).message)}</div>`; return; }
  view = hashId();
  if (view) await renderDetail(view); else renderList();
}

function winner(e: EventItem) {
  const w = e.top.find(t => t.rank === 1) ?? e.top[0];
  return w ? `<span class="pg-win">${icon("medal")}${esc(w.name)}${w.score != null ? ` <span class="mono">${f2(w.score)}</span>` : ""}</span>` : "";
}

function renderList() {
  const cur = EV.find(e => e.status === "active");
  const arch = EV.filter(e => e.status === "archived");
  const ev = ACT!.event;
  main.innerHTML = `
    <section class="pg-head"><div><h1>${icon("db")} Proqramlar</h1>
      <p class="sub">Proqram (tədbir) bir yarışdır: öz komandaları, münsifləri, meyarları və nəticəsi olur. Eyni vaxtda bir proqram aktivdir. Əvvəlki proqramlar tarixçədə oxuma rejimində qalır, heç nə silinmir.</p></div>
      <button class="btn primary" id="newToggle">${icon("plus")}Yeni proqram yarat</button></section>
    ${cur ? `<section class="card pad-lg stack pg-active" aria-labelledby="h-act">
      <div class="row between"><div><span class="caps">Aktiv proqram</span><h2 id="h-act">${esc(brandName(ev.name, ev.product))}</h2>
        <p class="sub">${esc(ev.date)} · ${cur.teams} komanda · ${cur.jurors} münsif · ${cur.scores} qiymət</p></div>${winner(cur) ? `<div class="pg-lead"><small>Hazırda öndədir</small>${winner(cur)}</div>` : ""}</div>
      <div class="row"><a class="btn" href="/admin">${icon("users")}Canlı panel</a><a class="btn" href="/admin/setup">${icon("pencil")}Quraşdırma</a><a class="btn ghost" href="/admin/qr">${icon("qr")}QR kodlar</a></div>
    </section>` : ""}
    ${formOpen ? newFormHtml(cur) : ""}
    <section class="stack section-gap" aria-labelledby="h-hist">
      <div class="head"><div><h2 id="h-hist">${icon("list")}Tarixçə <span class="pill">${arch.length}</span></h2>
        <p class="sub">Arxivdəki proqramlar. Birinə toxunun: yekun reytinq, komandalar və materialları, münsiflər və balları, qiymətləndirmə tarixçəsi.</p></div></div>
      ${arch.length ? `<div class="pg-list">${arch.map(e => `
        <a class="pg-item" href="#p${e.id}" data-open="${e.id}">
          <div class="pg-nm"><b>${esc(e.name)}</b><small>${esc(e.date || d(e.createdAt))}${e.archivedAt ? ` · arxivə keçib ${d(e.archivedAt)}` : ""}</small></div>
          <div class="pg-nums"><span><b>${e.teams}</b> komanda</span><span><b>${e.jurors}</b> münsif</span><span><b>${e.scores}</b> qiymət</span></div>
          <div class="pg-tags">${winner(e)}${e.imported ? `<span class="pill">yedəkdən</span>` : ""}</div>
          <span class="pg-go" aria-hidden="true">›</span>
        </a>`).join("")}</div>` : `<p class="note">Hələ arxiv proqram yoxdur. Yeni proqram yaradanda hazırkı proqram bura keçir.</p>`}
    </section>`;
}

function newFormHtml(cur: EventItem | undefined) {
  const ev = ACT!.event;
  const from = EV.map(e => `<option value="${e.id}">${esc(e.name)}${e.status === "active" ? " (aktiv)" : ` (${esc(e.date || d(e.createdAt))})`}</option>`).join("");
  return `<section class="card pad-lg stack section-gap" aria-labelledby="h-new" id="newCard">
    <h2 id="h-new">${icon("plus")}Yeni proqram</h2>
    <form id="newForm" class="stack" novalidate>
      <p class="sub" style="margin:0">Hazırkı proqram (<b>${esc(cur?.name ?? "")}</b>) arxivə keçir: nəticələri, tarixçəsi və Excel/PDF ixracı qalır. Arxivdəki münsiflərin və komandaların girişləri bağlanır.</p>
      <div class="row" style="align-items:flex-start">
        <div style="flex:2 1 260px"><label class="f" for="neName">Proqramın adı</label><input id="neName" maxlength="60" placeholder="məs. IDDA Hakaton 2026" autocomplete="off" required></div>
        <div style="flex:1 1 130px"><label class="f" for="neDate">Tarix</label><input id="neDate" maxlength="40" placeholder="${esc(ev.date)}"></div>
      </div>
      <div class="row" style="align-items:flex-start">
        <div style="flex:1 1 110px"><label class="f" for="nePitch">Təqdimat (dəq:san)</label><input id="nePitch" class="mono" inputmode="numeric" value="${fmtClock(ev.timer.pitchSec)}"></div>
        <div style="flex:1 1 110px"><label class="f" for="neQa">Sual-cavab (dəq:san)</label><input id="neQa" class="mono" inputmode="numeric" value="${fmtClock(ev.timer.qaSec)}"></div>
        <div style="flex:2 1 220px"><label class="f" for="neDeadline">Yükləmə üçün son tarix (istəyə bağlı)</label><input id="neDeadline" type="datetime-local"></div>
      </div>
      <div><label class="f" for="neFrom">Nəyi hansı proqramdan götürək</label><select id="neFrom">${from}</select></div>
      <label class="check"><input type="checkbox" id="neCrit" checked> Meyarlar</label>
      <label class="check"><input type="checkbox" id="neJurors"> Münsiflər (adları; hər birinə yeni QR verəcəksiniz, ballar köçmür)</label>
      <label class="check"><input type="checkbox" id="neTeams"> Komandaların adları (fayl, link və ballar köçmür)</label>
      <label class="check"><input type="checkbox" id="neConfirm"> Hazırkı proqramın arxivə keçməsini təsdiqləyirəm</label>
      <p class="err-t" id="neErr" role="alert"></p>
      <div class="row"><button class="btn primary" type="submit" id="neGo">${icon("plus")}Proqramı yarat</button><button class="btn" type="button" id="neCancel">Ləğv et</button></div>
    </form></section>`;
}

async function createProgram() {
  const err = $("#neErr");
  const name = $<HTMLInputElement>("#neName").value.trim().replace(/\s+/g, " ");
  const pitchSec = parseClock($<HTMLInputElement>("#nePitch").value), qaSec = parseClock($<HTMLInputElement>("#neQa").value);
  const dl = $<HTMLInputElement>("#neDeadline").value;
  if (name.length < 2) { err.textContent = "Yeni proqramın adını yazın."; $("#neName").focus(); return; }
  if (!pitchSec || pitchSec < 10 || !qaSec || qaSec < 10) { err.textContent = "Müddətləri dəq:san formatında yazın, məs. 3:00 və 2:00."; return; }
  if (!$<HTMLInputElement>("#neConfirm").checked) { err.textContent = "Hazırkı proqramın arxivə keçməsini təsdiqləyin."; return; }
  err.textContent = "";
  const go = $<HTMLButtonElement>("#neGo");
  go.disabled = true;
  try {
    await api("/api/admin/events", { method: "POST", body: {
      name, product: FREE_NAME, date: $<HTMLInputElement>("#neDate").value.trim() || undefined, pitchSec, qaSec,
      uploadDeadline: dl ? new Date(dl).getTime() : null, copyFrom: Number($<HTMLSelectElement>("#neFrom").value) || null,
      copyCriteria: $<HTMLInputElement>("#neCrit").checked, copyJurors: $<HTMLInputElement>("#neJurors").checked, copyTeams: $<HTMLInputElement>("#neTeams").checked, confirm: true,
    } });
    formOpen = false;
    toast("Yeni proqram yaradıldı, əvvəlki tarixçəyə keçdi");
    await load();
    scrollTo({ top: 0, behavior: "smooth" });
  } catch (ex) { err.textContent = (ex as ApiError).message; go.disabled = false; }
}

// ---------- one program, read-only ----------
async function renderDetail(id: number) {
  let D: Detail;
  try { D = await api<Detail>(`/api/admin/events/${id}/detail`); }
  catch (e) { main.innerHTML = `<p><a class="btn sm ghost" href="#">‹ Proqramlar</a></p><div class="banner err">${esc((e as Error).message)}</div>`; return; }
  const r = D.results;
  const byId = new Map(D.teams.map(t => [t.id, t]));
  const scoreOf = (j: number, t: number) => D.scores.find(s => s.jurorId === j && s.teamId === t) ?? null;
  const ranked = r.ranking;
  const activeTeams = D.teams.filter(t => t.active);
  main.innerHTML = `
    <p class="pg-back"><a class="btn sm ghost" href="#">‹ Proqramlar</a></p>
    <section class="card pad-lg stack" aria-labelledby="h-d">
      <div class="row between" style="align-items:flex-start"><div><span class="caps">${D.readOnly ? "Arxiv · oxuma rejimi" : "Aktiv proqram"}</span>
        <h1 id="h-d" class="pg-title">${esc(D.meta.name)}</h1>
        <p class="sub">${esc(D.event.date)}${D.meta.archivedAt ? ` · arxivə keçib ${d(D.meta.archivedAt)}` : ""} · təqdimat ${fmtClock(D.event.pitchSec)} + sual-cavab ${fmtClock(D.event.qaSec)}${D.event.includeEntry ? ` · giriş balı daxildir (maks. ${D.event.entryMax})` : ""}</p>
        ${D.imported ? `<p class="sub">${icon("db")}Yedəkdən import edilib: <span class="mono">${esc(D.imported.file)}</span> (sxem v${D.imported.schema}), ${d(D.imported.at)}</p>` : ""}</div>
        ${D.readOnly ? `<span class="pill">${icon("lock")}Oxuma rejimi</span>` : ""}</div>
      <div class="pg-kpis"><div><b>${activeTeams.length}</b><span>komanda</span></div><div><b>${D.jurors.length}</b><span>münsif</span></div><div><b>${D.scores.length}</b><span>qiymət</span></div><div><b>${D.historyTotal}</b><span>tarixçə qeydi</span></div></div>
      <div class="row"><a class="btn sm" href="/api/admin/events/${id}/export.xlsx" download>${icon("sheet")}Excel</a><a class="btn sm" href="/api/admin/events/${id}/export.pdf" download>${icon("doc")}PDF protokol</a>
        <a class="btn sm ghost" href="/api/admin/events/${id}/history.xlsx" download>${icon("list")}Tarixçə (Excel)</a></div>
    </section>
    <section class="section-gap" aria-labelledby="h-rk"><div class="head"><div><h2 id="h-rk">${icon("medal")}Yekun reytinq</h2></div></div>
      <div class="card" style="overflow:hidden"><ol class="lb">${ranked.map(x => `<li class="${x.rank && x.rank <= 3 ? `r${x.rank}` : ""}"><span class="rk">${x.rank ?? "-"}</span>
        <div class="nm"><b>${esc(x.team.name)}</b><small>${esc(x.team.project)}${x.incomplete && x.score != null ? " · natamam" : ""}</small></div>
        <div class="sc"><b>${x.score == null ? "-" : f2(x.score)}</b><small>${x.n} münsif</small></div></li>`).join("") || `<li><span></span><div class="nm"><b>Qiymət yoxdur</b></div></li>`}</ol></div></section>
    <section class="card pad-lg stack section-gap" aria-labelledby="h-tm"><h2 id="h-tm">${icon("list")}Komandalar və materiallar</h2>
      <div class="pg-teams">${D.teams.map(t => `<div class="pg-team${t.active ? "" : " off"}">
        <div class="pg-nm"><b>${esc(t.name)}</b><small>${esc(t.project)}${t.members.length ? ` · ${t.members.map(esc).join(", ")}` : ""}</small></div>
        <div class="row" style="gap:6px">
          ${t.presentation ? (t.presentation.missing ? `<span class="pill warn" title="${esc(t.presentation.name)}">Fayl yoxdur</span>`
            : `<button class="btn sm" data-view="${t.id}"${t.presentation.viewable ? "" : " disabled"}>${icon("expand")}Prezentasiya</button>`) : `<span class="pill">Prezentasiya yüklənməyib</span>`}
          ${t.siteUrl ? `<a class="btn sm ghost" href="${esc(t.siteUrl)}" target="_blank" rel="noopener noreferrer">${icon("ext")}Sayt</a>` : ""}
          ${t.videoUrl ? `<a class="btn sm ghost" href="${esc(t.videoUrl)}" target="_blank" rel="noopener noreferrer">${icon("play")}Video</a>` : ""}
          <span class="pill">${t.scores} qiymət</span></div></div>`).join("")}</div></section>
    <section class="card pad-lg stack section-gap" aria-labelledby="h-jr"><h2 id="h-jr">${icon("users")}Münsiflər və balları</h2>
      <p class="sub" style="margin:0">Hər xanada münsifin komandaya verdiyi yekun bal (maks. ${r.demoMax}). Xanaya toxunun: meyarlar üzrə ballar və şərh.</p>
      <div class="tbl"><table class="pg-mtx"><thead><tr><th>Komanda</th>${D.jurors.map(j => `<th>${esc(j.displayName)}</th>`).join("")}<th>Orta</th></tr></thead>
        <tbody>${ranked.map(x => `<tr><th>${esc(x.team.name)}</th>${D.jurors.map(j => { const s = scoreOf(j.id, x.team.id); return `<td>${s ? `<button class="cellb" data-cell="${j.id}:${x.team.id}">${f2(s.total)}</button>` : `<span class="faint">-</span>`}</td>`; }).join("")}<td><b>${x.demo == null ? "-" : f2(x.demo)}</b></td></tr>`).join("")}</tbody></table></div>
      <div id="cellBox"></div>
    </section>
    <section class="card pad-lg stack section-gap" id="histCard" aria-labelledby="h-hist"></section>`;
  mountHistory($("#histCard"), `/api/admin/events/${id}/history`);
  main.querySelectorAll<HTMLElement>("[data-view]").forEach(b => b.addEventListener("click", () => {
    const t = byId.get(Number(b.dataset.view));
    if (t?.presentation?.viewable) openViewer({ url: t.presentation.url, title: t.name, subtitle: [t.project, t.presentation.name].filter(Boolean).join(" · "), siteUrl: t.siteUrl || null });
  }));
  main.querySelectorAll<HTMLElement>("[data-cell]").forEach(b => b.addEventListener("click", () => {
    const [j, t] = b.dataset.cell!.split(":").map(Number);
    const s = scoreOf(j, t);
    const jn = D.jurors.find(x => x.id === j)?.displayName ?? "";
    if (!s) return;
    $("#cellBox").innerHTML = `<div class="pg-cell"><b>${esc(jn)} → ${esc(byId.get(t)?.name ?? "")}</b>
      <ul>${D.criteria.map(c => `<li><span>${esc(c.name)}</span><b class="mono">${s.values[c.key] ?? "-"}<small>/${c.maxScore}</small></b></li>`).join("")}</ul>
      ${s.tags.length ? `<p>${s.tags.map(x => `<span class="tag">${esc(x)}</span>`).join(" ")}</p>` : ""}${s.note ? `<q>${esc(s.note)}</q>` : ""}</div>`;
  }));
}

// ---------- events ----------
main.addEventListener("click", e => {
  const t = e.target as HTMLElement;
  if (t.closest("#newToggle")) { formOpen = !formOpen; renderList(); if (formOpen) { document.getElementById("newCard")?.scrollIntoView({ block: "center" }); $<HTMLInputElement>("#neName").focus(); } return; }
  if (t.closest("#neCancel")) { formOpen = false; renderList(); }
});
main.addEventListener("submit", e => { if ((e.target as HTMLElement).id === "newForm") { e.preventDefault(); void createProgram(); } });
addEventListener("hashchange", () => { view = hashId(); if (view) { void renderDetail(view); scrollTo({ top: 0 }); } else renderList(); });

live({
  role: "admin",
  on: { "events:changed": () => void load(), "config:changed": () => { if (!view && !formOpen) void load(); } },
  resync: () => { if (!formOpen) void load(); },
  status: online => bar.setOnline(online),
});
void load();
