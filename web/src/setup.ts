import "./styles.css";
import { fmtClock } from "../../shared/timer";
import type { Criterion, Juror, ScoreRow, Team, TimerState } from "../../shared/types";
import { api, ApiError } from "./lib/api";
import { $, esc, icon, toast } from "./lib/dom";
import { topbar } from "./lib/topbar";

interface EventState { name: string; date: string; currentTeamId: number | null; timer: TimerState; locked: boolean; showJurorTotal: boolean }
interface SetupState { event: EventState; teams: Team[]; criteria: Criterion[]; scores: ScoreRow[] }
type JurorRow = Juror & { sessionCount: number };

const bar = topbar({
  role: "admin",
  nav: [
    { href: "/admin", label: "Canlı panel" },
    { href: "/admin/setup", label: "Quraşdırma", current: true },
    { href: "/timer", label: "Taymer", external: true },
  ],
});
const main = $("#main");

let S: SetupState | null = null;
let jurors: JurorRow[] = [];
/** Pending destructive confirmation, shown inline under the row it belongs to. */
let confirm: { kind: "teams" | "jurors" | "criteria"; id: number; msg: string } | null = null;

async function load() {
  try {
    const [st, js] = await Promise.all([api<SetupState>("/api/admin/state"), api<JurorRow[]>("/api/admin/jurors")]);
    S = st;
    jurors = js;
    bar.setOnline(true);
    bar.setEventName(st.event.name);
    render();
  } catch (e) {
    bar.setOnline(false);
    main.innerHTML = `<div class="banner err">${esc((e as Error).message)}</div>`;
  }
}

const parseClock = (v: string) => {
  const m = v.trim().match(/^(\d{1,2})(?::([0-5]\d))?$/);
  if (!m) return null;
  return m[2] != null ? Number(m[1]) * 60 + Number(m[2]) : Number(m[1]) * 60;
};

/** Short readable password suggestion, e.g. "kora-tumi-47". */
function suggestPassword() {
  const c = "bdfgklmnprstvz", v = "aeiou";
  const r = (s: string) => s[crypto.getRandomValues(new Uint32Array(1))[0] % s.length];
  const syl = () => r(c) + r(v) + r(c) + r(v);
  return `${syl()}-${syl()}-${String(crypto.getRandomValues(new Uint32Array(1))[0] % 90 + 10)}`;
}

const scoreCount = (teamId: number) => S?.scores.filter(s => s.teamId === teamId).length ?? 0;
const confirmRow = (kind: string, id: number) =>
  confirm && confirm.kind === kind && confirm.id === id
    ? `<div class="confirm" style="grid-column:1/-1"><span>${esc(confirm.msg)}</span>
        <button class="btn danger solid sm" data-force="${kind}:${id}">Bəli, sil</button><button class="btn sm" data-cancel>Ləğv et</button></div>`
    : "";

// ---------- render ----------
function render() {
  if (!S) return;
  const ev = S.event;
  const nScores = S.scores.length;
  const wsum = S.criteria.reduce((a, c) => a + c.weight, 0);
  main.innerHTML = `
    <div class="stack">
      <div><h2>Quraşdırma</h2><p class="sub">Hər sahə xanadan çıxanda yadda saxlanılır və bütün ekranlarda dərhal yenilənir.</p></div>

      <section class="card pad stack" aria-labelledby="h-ev">
        <div class="row between"><h3 id="h-ev">Tədbir və taymer</h3><span class="saved" id="evSaved"></span></div>
        <form id="evForm" class="stack" novalidate>
          <div class="row" style="align-items:flex-start">
            <div style="flex:2 1 240px"><label class="f" for="evName">Tədbirin adı</label><input type="text" id="evName" value="${esc(ev.name)}" maxlength="120" required></div>
            <div style="flex:1 1 140px"><label class="f" for="evDate">Tarix</label><input type="text" id="evDate" value="${esc(ev.date)}" maxlength="40" placeholder="29.10.2026"></div>
            <div style="flex:1 1 110px"><label class="f" for="evPitch">Pitch (dəq:san)</label><input type="text" id="evPitch" class="mono" inputmode="numeric" value="${fmtClock(ev.timer.pitchSec)}"></div>
            <div style="flex:1 1 110px"><label class="f" for="evQa">Sual-cavab (dəq:san)</label><input type="text" id="evQa" class="mono" inputmode="numeric" value="${fmtClock(ev.timer.qaSec)}"></div>
          </div>
          <p class="err" id="evErr" role="alert" style="color:var(--danger);margin:0;font-size:13px;font-weight:600"></p>
          <div class="toggle" style="border-top:1px solid var(--line)"><div><b>Münsif öz yekun balını görsün</b><small>Bağlı olanda münsif yalnız kriteriya ballarını görür (tövsiyə olunur).</small></div>
            <button type="button" class="sw" role="switch" id="evTotal" aria-checked="${ev.showJurorTotal}" aria-label="Münsif öz yekun balını görsün"></button></div>
          <div class="row"><button class="btn primary" type="submit">Yadda saxla</button></div>
        </form>
      </section>

      <section class="card pad stack" aria-labelledby="h-teams">
        <div class="row between"><h3 id="h-teams">Komandalar (${S.teams.length})</h3>
          <button class="btn sm" data-add="teams">${icon("plus")}Komanda əlavə et</button></div>
        ${nScores ? `<p class="note">Artıq <b>${nScores}</b> qiymət var. Qiyməti olan komandanı silsəniz, qiymətləri də silinəcək — bunun əvəzinə deaktiv edə bilərsiniz.</p>` : ""}
        <div class="ed teams" role="list">
          <div class="er sub" aria-hidden="true" style="font-size:12px;font-weight:700"><span></span><span>Komanda adı</span><span class="pj">Layihə / məhsul</span><span>Aktiv</span><span></span><span></span></div>
          ${S.teams.map((t, i) => `
          <div class="er ${t.active ? "" : "off"}" role="listitem" data-row="teams:${t.id}">
            <span class="ix">${i + 1}</span>
            <input type="text" data-k="name" value="${esc(t.name)}" maxlength="120" aria-label="Komanda ${i + 1} adı">
            <input type="text" class="pj" data-k="project" value="${esc(t.project)}" maxlength="160" placeholder="məs. Ağıllı parkinq" aria-label="Komanda ${i + 1} layihəsi">
            <button type="button" class="sw" role="switch" data-active aria-checked="${t.active}" aria-label="Komanda ${i + 1} aktivdir"></button>
            <div class="mv"><button type="button" class="x" data-move="up" ${i ? "" : "disabled"} aria-label="Yuxarı">${icon("up")}</button><button type="button" class="x" data-move="down" ${i < S!.teams.length - 1 ? "" : "disabled"} aria-label="Aşağı">${icon("down")}</button></div>
            <button type="button" class="x del" data-del aria-label="Komanda ${i + 1}-i sil">${icon("trash")}</button>
            ${scoreCount(t.id) ? `<div class="meta">${scoreCount(t.id)} qiymət</div>` : ""}
            ${confirmRow("teams", t.id)}
          </div>`).join("")}
        </div>
      </section>

      <section class="card pad stack" aria-labelledby="h-jur">
        <div class="row between"><h3 id="h-jur">Münsiflər (${jurors.length})</h3></div>
        <p class="sub" style="margin:0">Hər münsifin istifadəçi adını və şifrəsini siz təyin edirsiniz. Şifrə dəyişəndə münsifin açıq sessiyaları bağlanır.</p>
        <div class="ed jur">
          ${jurors.map(j => `
          <div class="er jrow ${j.active ? "" : "off"}" data-row="jurors:${j.id}">
            <div><label class="f" for="jn-${j.id}">Görünən ad</label><input type="text" id="jn-${j.id}" data-k="displayName" value="${esc(j.displayName)}" maxlength="80"></div>
            <div><label class="f" for="ju-${j.id}">İstifadəçi adı</label><input type="text" id="ju-${j.id}" data-k="username" value="${esc(j.username)}" maxlength="40" autocapitalize="none" spellcheck="false"></div>
            <div class="pw"><label class="f" for="jp-${j.id}">Yeni şifrə</label>
              <div class="row" style="flex-wrap:nowrap;gap:6px"><input type="text" id="jp-${j.id}" data-pw autocomplete="off" spellcheck="false" placeholder="ən azı 6 simvol">
              <button type="button" class="btn sm" data-setpw>${icon("key")}Təyin et</button></div></div>
            <div><span class="f">Aktiv</span><button type="button" class="sw" role="switch" data-active aria-checked="${j.active}" aria-label="${esc(j.displayName)} aktivdir"></button></div>
            <div><span class="f">&nbsp;</span><button type="button" class="x del" data-del aria-label="${esc(j.displayName)} sil">${icon("trash")}</button></div>
            <div class="meta">
              <span>${j.sessionCount ? `${j.sessionCount} açıq sessiya` : "Açıq sessiya yoxdur"}</span>
              ${j.sessionCount ? `<button type="button" class="btn ghost sm" data-logout>Sessiyaları bağla</button>` : ""}
              <span class="saved" data-saved></span>
            </div>
            ${confirmRow("jurors", j.id)}
          </div>`).join("") || `<p class="note">Hələ münsif yoxdur. Aşağıdan əlavə edin.</p>`}
        </div>
        <form class="newj" id="newJ" novalidate>
          <div><label class="f" for="nj-name">Görünən ad</label><input type="text" id="nj-name" maxlength="80" placeholder="Əli Məmmədov" required></div>
          <div><label class="f" for="nj-user">İstifadəçi adı</label><input type="text" id="nj-user" maxlength="40" autocapitalize="none" spellcheck="false" placeholder="ali" required></div>
          <div><label class="f" for="nj-pw">Şifrə</label>
            <div class="row" style="flex-wrap:nowrap;gap:6px"><input type="text" id="nj-pw" autocomplete="off" spellcheck="false" required>
            <button type="button" class="btn sm ghost" id="genPw" title="Şifrə təklif et">Yarat</button></div></div>
          <button class="btn primary" type="submit">${icon("plus")}Münsif əlavə et</button>
          <p id="njErr" role="alert" style="grid-column:1/-1;color:var(--danger);margin:0;font-size:13px;font-weight:600"></p>
        </form>
      </section>

      <section class="card pad stack" aria-labelledby="h-cr">
        <div class="row between"><h3 id="h-cr">Kriteriyalar</h3><span class="sum ${wsum === 100 ? "" : "bad"}" role="status">Çəki cəmi: ${wsum}%${wsum === 100 ? "" : " — 100 olmalıdır"}</span></div>
        ${nScores ? `<p class="note">Artıq <b>${nScores}</b> qiymət var. Kriteriya əlavə etsəniz, köhnə qiymətlər natamam sayılacaq; çəki dəyişsə, yekun ballar yenidən hesablanacaq.</p>` : ""}
        <div class="ed cr">
          <div class="er sub" aria-hidden="true" style="font-size:12px;font-weight:700"><span>Ad</span><span class="cd">Münsif üçün izah</span><span>Çəki %</span><span></span><span></span></div>
          ${S.criteria.map((c, i) => `
          <div class="er" data-row="criteria:${c.id}">
            <input type="text" data-k="name" value="${esc(c.name)}" maxlength="120" aria-label="Kriteriya ${i + 1} adı">
            <input type="text" class="cd" data-k="description" value="${esc(c.description)}" maxlength="400" aria-label="Kriteriya ${i + 1} izahı">
            <input type="number" class="mono" data-k="weight" value="${c.weight}" min="0" max="100" inputmode="numeric" aria-label="Kriteriya ${i + 1} çəkisi">
            <div class="mv"><button type="button" class="x" data-move="up" ${i ? "" : "disabled"} aria-label="Yuxarı">${icon("up")}</button><button type="button" class="x" data-move="down" ${i < S!.criteria.length - 1 ? "" : "disabled"} aria-label="Aşağı">${icon("down")}</button></div>
            <button type="button" class="x del" data-del aria-label="Kriteriya ${i + 1}-i sil">${icon("trash")}</button>
            ${confirmRow("criteria", c.id)}
          </div>`).join("")}
        </div>
        <div class="row"><button class="btn sm" data-add="criteria">${icon("plus")}Kriteriya əlavə et</button></div>
      </section>
    </div>`;
}

// ---------- helpers ----------
const rowOf = (el: HTMLElement) => {
  const r = el.closest<HTMLElement>("[data-row]");
  if (!r) return null;
  const [kind, id] = r.dataset.row!.split(":");
  return { el: r, kind: kind as "teams" | "jurors" | "criteria", id: Number(id) };
};
function flashSaved(row: HTMLElement | null, text = "Saxlanıldı") {
  const s = row?.querySelector<HTMLElement>("[data-saved]");
  if (s) { s.textContent = text; setTimeout(() => { s.textContent = ""; }, 1800); }
  else toast(text);
}

async function patchRow(kind: string, id: number, body: Record<string, unknown>, row: HTMLElement | null, rerender = false) {
  try {
    await api(`/api/admin/${kind}/${id}`, { method: "PATCH", body });
    if (rerender) await load();
    else {
      // Update the local copy without re-rendering so focus stays where the user tabbed to.
      const list = kind === "teams" ? S!.teams : kind === "criteria" ? S!.criteria : jurors;
      const item = (list as Array<{ id: number }>).find(x => x.id === id);
      if (item) Object.assign(item, body);
      if (kind === "criteria" && "weight" in body) {
        const w = S!.criteria.reduce((a, c) => a + c.weight, 0);
        const sum = main.querySelector<HTMLElement>(".sum")!;
        sum.textContent = `Çəki cəmi: ${w}%${w === 100 ? "" : " — 100 olmalıdır"}`;
        sum.classList.toggle("bad", w !== 100);
      }
      flashSaved(row);
    }
    return true;
  } catch (e) {
    toast((e as ApiError).message, "err");
    return false;
  }
}

// ---------- events ----------
main.addEventListener("change", async e => {
  const el = e.target as HTMLInputElement;
  const k = el.dataset.k;
  if (!k) return;
  const r = rowOf(el);
  if (!r) return;
  let v: string | number = el.value.trim();
  if (k === "weight") {
    v = Math.max(0, Math.min(100, Math.round(Number(el.value) || 0)));
    el.value = String(v);
  } else if (k === "name" || k === "displayName" || k === "username") {
    if (!v) {
      toast("Bu sahə boş ola bilməz.", "err");
      const list = r.kind === "teams" ? S!.teams : r.kind === "criteria" ? S!.criteria : jurors;
      el.value = String((list as unknown as Array<Record<string, unknown>>).find(x => x.id === r.id)?.[k] ?? "");
      return;
    }
  }
  el.setAttribute("aria-invalid", "false");
  const ok = await patchRow(r.kind, r.id, { [k]: v }, r.el);
  if (!ok) { el.setAttribute("aria-invalid", "true"); el.focus(); }
});

main.addEventListener("click", async e => {
  const t = e.target as HTMLElement;
  if (!S) return;

  const add = t.closest<HTMLElement>("[data-add]");
  if (add) {
    try {
      if (add.dataset.add === "teams") await api("/api/admin/teams", { method: "POST", body: { name: `Komanda ${S.teams.length + 1}`, project: "" } });
      else await api("/api/admin/criteria", { method: "POST", body: { name: "Yeni kriteriya", description: "", weight: 0 } });
      await load();
      const rows = main.querySelectorAll<HTMLElement>(`[data-row^="${add.dataset.add}:"]`);
      rows[rows.length - 1]?.querySelector<HTMLInputElement>("input")?.select();
    } catch (ex) { toast((ex as ApiError).message, "err"); }
    return;
  }

  if (t.closest("#genPw")) { $<HTMLInputElement>("#nj-pw").value = suggestPassword(); return; }
  if (t.closest("#evTotal")) {
    const sw = t.closest<HTMLElement>("#evTotal")!;
    sw.setAttribute("aria-checked", String(sw.getAttribute("aria-checked") !== "true"));
    return;
  }
  if (t.closest("[data-cancel]")) { confirm = null; render(); return; }

  const force = t.closest<HTMLElement>("[data-force]");
  if (force) {
    const [kind, id] = force.dataset.force!.split(":");
    try { await api(`/api/admin/${kind}/${id}?force=1`, { method: "DELETE" }); toast("Silindi"); }
    catch (ex) { toast((ex as ApiError).message, "err"); }
    confirm = null;
    await load();
    return;
  }

  const r = rowOf(t);
  if (!r) return;

  if (t.closest("[data-active]")) {
    const sw = t.closest<HTMLElement>("[data-active]")!;
    const next = sw.getAttribute("aria-checked") !== "true";
    await patchRow(r.kind, r.id, { active: next }, r.el, true);
    if (r.kind === "jurors" && !next) toast("Münsif deaktiv edildi; sessiyaları bağlandı");
    return;
  }
  const mv = t.closest<HTMLElement>("[data-move]");
  if (mv && (r.kind === "teams" || r.kind === "criteria")) {
    const ids = (r.kind === "teams" ? S.teams : S.criteria).map(x => x.id);
    const i = ids.indexOf(r.id), j = mv.dataset.move === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api(`/api/admin/${r.kind}/reorder`, { method: "POST", body: { ids } }); await load(); }
    catch (ex) { toast((ex as ApiError).message, "err"); }
    main.querySelector<HTMLElement>(`[data-row="${r.kind}:${r.id}"] [data-move="${mv.dataset.move}"]`)?.focus();
    return;
  }
  if (t.closest("[data-del]")) {
    try {
      await api(`/api/admin/${r.kind}/${r.id}`, { method: "DELETE" });
      toast("Silindi");
      await load();
    } catch (ex) {
      const err = ex as ApiError;
      if (err.status === 409) { confirm = { kind: r.kind, id: r.id, msg: err.message }; render(); }
      else toast(err.message, "err");
    }
    return;
  }
  if (t.closest("[data-setpw]")) {
    const input = r.el.querySelector<HTMLInputElement>("[data-pw]")!;
    const pw = input.value;
    if (pw.length < 6) { toast("Şifrə ən azı 6 simvol olmalıdır.", "err"); input.focus(); return; }
    if (await patchRow("jurors", r.id, { password: pw }, r.el)) {
      input.value = "";
      flashSaved(r.el, "Şifrə təyin edildi");
      const j = jurors.find(x => x.id === r.id);
      if (j?.sessionCount) { j.sessionCount = 0; setTimeout(render, 1900); }
    }
    return;
  }
  if (t.closest("[data-logout]")) {
    try {
      const res = await api<{ closed: number }>(`/api/admin/jurors/${r.id}/logout`, { method: "POST" });
      toast(`${res.closed} sessiya bağlandı`);
      await load();
    } catch (ex) { toast((ex as ApiError).message, "err"); }
  }
});

main.addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  if (form.id === "evForm") {
    const err = $("#evErr");
    const pitchSec = parseClock($<HTMLInputElement>("#evPitch").value);
    const qaSec = parseClock($<HTMLInputElement>("#evQa").value);
    const name = $<HTMLInputElement>("#evName").value.trim();
    if (!name) { err.textContent = "Tədbirin adı boş ola bilməz."; $("#evName").focus(); return; }
    if (!pitchSec || pitchSec < 10) { err.textContent = "Pitch müddətini dəq:san formatında yazın, məs. 3:00."; $("#evPitch").focus(); return; }
    if (!qaSec || qaSec < 10) { err.textContent = "Sual-cavab müddətini dəq:san formatında yazın, məs. 2:00."; $("#evQa").focus(); return; }
    err.textContent = "";
    try {
      await api("/api/admin/event", { method: "PATCH", body: {
        name, date: $<HTMLInputElement>("#evDate").value.trim(), pitchSec, qaSec,
        showJurorTotal: $("#evTotal").getAttribute("aria-checked") === "true",
      } });
      bar.setEventName(name);
      const s = $("#evSaved"); s.textContent = "Saxlanıldı"; setTimeout(() => { s.textContent = ""; }, 1800);
      $<HTMLInputElement>("#evPitch").value = fmtClock(pitchSec);
      $<HTMLInputElement>("#evQa").value = fmtClock(qaSec);
    } catch (ex) { err.textContent = (ex as ApiError).message; }
    return;
  }
  if (form.id === "newJ") {
    const err = $("#njErr");
    const displayName = $<HTMLInputElement>("#nj-name").value.trim();
    const username = $<HTMLInputElement>("#nj-user").value.trim();
    const password = $<HTMLInputElement>("#nj-pw").value;
    if (!displayName) { err.textContent = "Görünən adı yazın."; $("#nj-name").focus(); return; }
    if (!username) { err.textContent = "İstifadəçi adını yazın."; $("#nj-user").focus(); return; }
    if (password.length < 6) { err.textContent = "Şifrə ən azı 6 simvol olmalıdır."; $("#nj-pw").focus(); return; }
    try {
      await api("/api/admin/jurors", { method: "POST", body: { displayName, username, password } });
      toast(`${displayName} əlavə edildi. Giriş: ${username} / ${password}`);
      await load();
      $<HTMLInputElement>("#nj-name").focus();
    } catch (ex) { err.textContent = (ex as ApiError).message; }
  }
});

load();
