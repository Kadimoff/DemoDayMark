// Scoring history card on the live panel: every juror submit and change, read from the permanent
// score_history table (wipes and deletions don't remove it). Filters by juror / team, pages of 40.
import type { HistoryPage, HistoryRow } from "../../../shared/types";
import { api, ApiError } from "./api";
import { esc, icon } from "./dom";

const PAGE = 40;
let box: HTMLElement | null = null;
let rows: HistoryRow[] = [];
let meta: Omit<HistoryPage, "rows"> = { more: false, total: 0, jurors: [], teams: [] };
let juror = "", team = "";
let loading = false, err = "";
let refreshT = 0;
/** v4: the same card reads an archived program's history too (/api/admin/events/<id>/history). */
let baseUrl = "/api/admin/history";

const p2 = (n: number) => String(n).padStart(2, "0");
function when(ms: number) {
  const d = new Date(ms), t = new Date();
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  return d.toDateString() === t.toDateString() ? time : `${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${time}`;
}
const num = (v: number | null) => (v == null ? "-" : String(Math.round(v * 100) / 100));

function query(before?: number) {
  const q = new URLSearchParams({ limit: String(PAGE) });
  if (juror) q.set("juror", juror);
  if (team) q.set("team", team);
  if (before) q.set("before", String(before));
  return `${baseUrl}?${q}`;
}

async function fetchPage(append: boolean) {
  if (loading) return;
  loading = true; err = "";
  if (!append) render();
  try {
    const r = await api<HistoryPage>(query(append ? rows.at(-1)?.id : undefined));
    rows = append ? [...rows, ...r.rows] : r.rows;
    meta = { more: r.more, total: r.total, jurors: r.jurors, teams: r.teams };
  } catch (e) { err = (e as ApiError).message; }
  loading = false;
  render();
}

function rowHtml(h: HistoryRow) {
  if (h.kind === "wipe" || h.kind === "team.delete" || h.kind === "juror.delete") {
    const what = h.kind === "wipe" ? "Bütün ballar silindi" : h.kind === "team.delete" ? `Komanda silindi: <b>${esc(h.teamName)}</b>` : `Münsif silindi: <b>${esc(h.jurorName)}</b>`;
    return `<li class="hx mark"><span class="t mono">${when(h.at)}</span>
      <span class="w">${icon("trash")}${what} · ${h.count ?? 0} qiymət${h.actorName ? ` · ${esc(h.actorName)}` : ""}</span>
      <span class="s">Yuxarıdakı qeydlər tarixçədə qalır</span></li>`;
  }
  const upd = h.kind === "update";
  const changed = h.values.filter(v => v.prev != null).length;
  const totalDiff = upd && h.prevTotal != null && h.prevTotal !== h.total;
  return `<li class="hx${upd ? " upd" : ""}">
    <span class="t mono">${when(h.at)}</span>
    <span class="who"><b>${esc(h.jurorName)}</b><span class="arr" aria-hidden="true">→</span><b>${esc(h.teamName)}</b></span>
    <span class="pill ${upd ? "warn" : "ok"}">${upd ? (changed || totalDiff || h.prevNote != null ? "Dəyişdi" : "Təkrar göndərildi") : "Göndərildi"}</span>
    <span class="tot mono">${totalDiff ? `<s>${num(h.prevTotal)}</s>` : ""}<b>${num(h.total)}</b></span>
    <span class="vals">${h.values.map(v => `<span class="hv${v.prev != null ? " ch" : ""}" title="${esc(v.name)}${v.max ? ` (maks. ${v.max})` : ""}">
      <i>${esc(v.name)}</i><b class="mono">${v.prev != null ? `<s>${v.prev}</s>→` : ""}${v.v}${v.max ? `<small>/${v.max}</small>` : ""}</b></span>`).join("")}</span>
    ${h.tags.length || h.note ? `<span class="nt">${h.tags.map(t => `<span class="tag">${esc(t)}</span>`).join("")}${h.note ? `<q>${esc(h.note)}</q>` : ""}${h.prevNote != null ? `<small>şərh dəyişdi</small>` : ""}</span>` : ""}
  </li>`;
}

function render() {
  if (!box) return;
  const opt = (list: Array<{ id: number; name: string }>, sel: string) => list.map(x => `<option value="${x.id}"${String(x.id) === sel ? " selected" : ""}>${esc(x.name)}</option>`).join("");
  box.innerHTML = `
    <div class="head">
      <div><h2 id="h-hist">${icon("list")}Qiymətləndirmə tarixçəsi <span class="pill">${meta.total}</span></h2>
        <p class="sub">Münsiflərin hər göndərişi və dəyişikliyi bazada saxlanılır. Ballar silinsə də, tarixçə qalır.</p></div>
      <div class="row hfil">
        <select id="hJ" aria-label="Münsif"><option value="">Bütün münsiflər</option>${opt(meta.jurors, juror)}</select>
        <select id="hT" aria-label="Komanda"><option value="">Bütün komandalar</option>${opt(meta.teams, team)}</select>
      </div>
    </div>
    ${err ? `<div class="banner err">${esc(err)}</div>` : ""}
    ${rows.length ? `<ol class="hist">${rows.map(rowHtml).join("")}</ol>`
      : `<p class="note">${loading ? "Yüklənir…" : juror || team ? "Bu seçim üçün qeyd yoxdur." : "Hələ heç bir qiymət göndərilməyib."}</p>`}
    ${meta.more ? `<button class="btn sm ghost fin-more" id="hMore" ${loading ? "disabled" : ""}>Daha çox göstər</button>` : ""}`;
}

/** Mounts the card into `el` and loads the first page. */
export function mountHistory(el: HTMLElement, base = "/api/admin/history") {
  box = el;
  baseUrl = base;
  rows = []; juror = ""; team = ""; err = "";
  meta = { more: false, total: 0, jurors: [], teams: [] };
  el.addEventListener("change", e => {
    const t = e.target as HTMLElement;
    if (t.id === "hJ") { juror = (t as HTMLSelectElement).value; void fetchPage(false); }
    if (t.id === "hT") { team = (t as HTMLSelectElement).value; void fetchPage(false); }
  });
  el.addEventListener("click", e => { if ((e.target as HTMLElement).closest("#hMore")) void fetchPage(true); });
  void fetchPage(false);
}

/** New scores arrived: reload the first page (debounced) unless the admin paged further down. */
export function refreshHistory() {
  if (!box) return;
  clearTimeout(refreshT);
  refreshT = window.setTimeout(() => {
    if (rows.length > PAGE) return; // keep their place; "Daha çox" list stays as it is
    void fetchPage(false);
  }, 800);
}
