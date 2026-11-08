// orgs: the platform owner's page (/admin/orgs) — customer organisations, their coordinator accounts, and a way
// into each organisation's panel. Coordinators never reach it (the server redirects them; /api/root/* answers 403).
import "./styles.css";
import { api, ApiError } from "./lib/api";
import { $, esc, icon, toast } from "./lib/dom";
import { topbar, whoAmI } from "./lib/topbar";

interface Coord { id: number; username: string; displayName: string; active: boolean; root: boolean }
interface OrgView {
  id: number; slug: string; name: string; active: boolean; root: boolean; createdAt: number; eventName: string;
  teams: number; jurors: number; scores: number; coordinators: Coord[]; links: { stage: string; reveal: string; team: string };
}

const bar = topbar({
  role: "admin",
  nav: [
    { href: "/admin", label: "Canlı panel", short: "Panel", icon: "users" },
    { href: "/admin/setup", label: "Quraşdırma", icon: "pencil" },
    { href: "/admin/pult", label: "Pult", icon: "timer" },
  ],
  wide: true,
});
bar.setOnline(true);
const main = $("#main");
let orgs: OrgView[] = [];
/** Which inline form is open: "coord:<orgId>" or "reset:<userId>"; and a pending deactivation. */
let open: string | null = null;
let confirmOff: number | null = null;

async function load() {
  try { orgs = await api<OrgView[]>("/api/root/orgs"); }
  catch (e) { main.innerHTML = `<div class="banner err">${esc((e as Error).message)}</div>`; return; }
  const me = await whoAmI();
  const mine = orgs.find(o => o.id === me?.org?.id);
  if (mine) bar.setEventName(mine.eventName);
  render();
}

const abs = (p: string) => `${location.origin}${p}`;
const linkHtml = (label: string, p: string) => `<span>${esc(label)}: <a href="${esc(p)}" target="_blank" rel="noopener" data-raw>${esc(abs(p))}</a></span>`;

function orgCard(o: OrgView) {
  const coords = o.coordinators.map(c => `<div class="coord">
      <div><b>${esc(c.displayName)}</b> <span class="u">@${esc(c.username)}</span></div>
      ${c.root ? `<span class="pill hot">Root</span>` : c.active ? `<span class="pill ok">Aktiv</span>` : `<span class="pill warn">Deaktiv</span>`}
      <span class="spacer"></span>
      ${c.root ? "" : `<button class="btn sm" data-reset="${c.id}">${icon("key")}Şifrəni sıfırla</button>
        <button class="btn sm ghost" data-uactive="${c.id}:${c.active ? 0 : 1}">${c.active ? "Deaktiv et" : "Aktiv et"}</button>`}
      ${open === `reset:${c.id}` ? `<form class="inline-form" data-reset-form="${c.id}" style="width:100%" novalidate>
        <div><label class="f" for="rp${c.id}">Yeni şifrə (min. 8)</label><input type="password" id="rp${c.id}" autocomplete="new-password" minlength="8" required></div>
        <button class="btn primary sm" type="submit">Saxla</button><button class="btn sm" type="button" data-cancel>Ləğv et</button></form>` : ""}
    </div>`).join("") || `<p class="sub" style="margin:0">Koordinator hesabı yoxdur.</p>`;
  return `<section class="card pad-lg org-card${o.active ? "" : " off"}" data-org="${o.id}">
    <div class="oh"><div><h3>${esc(o.name)}</h3><div class="slug">/${esc(o.slug)} · ${esc(o.eventName)}</div></div>
      <div class="row" style="gap:6px">${o.root ? `<span class="pill hot">Əsas</span>` : ""}${o.active ? `<span class="pill ok">Aktiv</span>` : `<span class="pill warn">Deaktiv</span>`}</div></div>
    <div class="nums"><div><b>${o.teams}</b><span>komanda</span></div><div><b>${o.jurors}</b><span>münsif</span></div><div><b>${o.scores}</b><span>qiymət</span></div></div>
    <div class="links">${linkHtml("Səhnə", o.links.stage)}${linkHtml("Nəticə", o.links.reveal)}${linkHtml("Komanda", o.links.team)}</div>
    <div class="stack" style="gap:8px"><div class="lbl" style="font-size:12px;color:var(--muted)">Koordinatorlar</div>${coords}
      ${open === `coord:${o.id}` ? `<form class="inline-form" data-coord-form="${o.id}" novalidate>
        <div><label class="f" for="cu${o.id}">İstifadəçi adı</label><input type="text" id="cu${o.id}" autocapitalize="none" spellcheck="false" autocomplete="off" required></div>
        <div><label class="f" for="cp${o.id}">Şifrə (min. 8)</label><input type="password" id="cp${o.id}" autocomplete="new-password" minlength="8" required></div>
        <button class="btn primary sm" type="submit">Yarat</button><button class="btn sm" type="button" data-cancel>Ləğv et</button></form>` : ""}
    </div>
    ${confirmOff === o.id ? `<div class="confirm"><span><b>${esc(o.name)}</b> deaktiv edilsin? Koordinator, münsif və komandaların sessiyaları bağlanacaq, ictimai ekranları açılmayacaq. Data silinmir.</span>
      <button class="btn sm danger solid" data-off-yes="${o.id}">Bəli, deaktiv et</button><button class="btn sm" data-cancel>Ləğv et</button></div>` : ""}
    <div class="row">
      <button class="btn primary sm" data-enter="${o.id}">${icon("ext")}Panelinə keç</button>
      ${o.root ? "" : `<button class="btn sm" data-addcoord="${o.id}">${icon("plus")}Koordinator</button>
        <button class="btn sm ghost" data-active="${o.id}:${o.active ? 0 : 1}">${icon("power")}${o.active ? "Deaktiv et" : "Aktiv et"}</button>`}
    </div>
  </section>`;
}

function render() {
  main.innerHTML = `
    <section class="card hero pad-lg"><div class="head"><div><h1 style="margin:0">${icon("db")} Təşkilatlar</h1>
      <p class="sub">Hər müştəri şirkətin öz tədbiri, komandaları, münsifləri və balları var; koordinatoru yalnız öz təşkilatını görür. “Panelinə keç” ilə istənilən təşkilatın panelinə platforma sahibi kimi daxil olursunuz.</p></div></div></section>
    <section class="card pad-lg stack section-gap" aria-labelledby="h-new">
      <h2 id="h-new">${icon("plus")}Yeni təşkilat</h2>
      <form class="inline-form" id="newOrg" novalidate>
        <div><label class="f" for="nName">Ad (tədbir brendi)</label><input type="text" id="nName" maxlength="40" placeholder="məs. Demo" required></div>
        <div><label class="f" for="nSlug">Qısa ad (linklər üçün)</label><input type="text" id="nSlug" maxlength="32" placeholder="demo" autocapitalize="none" spellcheck="false" required></div>
        <div><label class="f" for="nUser">Koordinator istifadəçi adı</label><input type="text" id="nUser" maxlength="64" autocapitalize="none" spellcheck="false" autocomplete="off"></div>
        <div><label class="f" for="nPass">Koordinator şifrəsi (min. 8)</label><input type="password" id="nPass" autocomplete="new-password"></div>
        <button class="btn primary" type="submit" id="nGo">${icon("plus")}Yarat</button>
      </form>
      <p class="sub" style="margin:0">Yeni təşkilat boş tədbirlə başlayır: standart meyarlar, təqdimat 3:00 + sual-cavab 2:00, komanda və münsif yoxdur. Ekran linkləri <span class="mono">/o/&lt;qısa ad&gt;/stage</span>, <span class="mono">/o/&lt;qısa ad&gt;/reveal</span>.</p>
      <p class="err-t" id="nErr" role="alert"></p>
    </section>
    <div class="orgs-grid section-gap">${orgs.map(orgCard).join("")}</div>`;
  bind();
}

function bind() {
  const nSlug = $<HTMLInputElement>("#nSlug"), nName = $<HTMLInputElement>("#nName");
  nName.addEventListener("input", () => {
    if (nSlug.dataset.touched) return;
    nSlug.value = nName.value.toLowerCase().replace(/ə/g, "e").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ş/g, "s").replace(/ç/g, "c").replace(/ğ/g, "g")
      .normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  });
  nSlug.addEventListener("input", () => { nSlug.dataset.touched = "1"; });
  $<HTMLFormElement>("#newOrg").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#nErr");
    const username = $<HTMLInputElement>("#nUser").value.trim(), password = $<HTMLInputElement>("#nPass").value;
    if ((username && !password) || (!username && password)) { err.textContent = "Koordinator üçün həm istifadəçi adı, həm şifrə yazın (və ya ikisini də boş saxlayın)."; return; }
    const go = $<HTMLButtonElement>("#nGo");
    go.disabled = true;
    try {
      await api("/api/root/orgs", { method: "POST", body: { slug: nSlug.value.trim(), name: nName.value.trim(), ...(username ? { coordinator: { username, password } } : {}) } });
      toast("Təşkilat yaradıldı");
      await load();
    } catch (ex) { err.textContent = ex instanceof ApiError ? ex.message : "Xəta baş verdi."; go.disabled = false; }
  });

  main.querySelectorAll<HTMLElement>("[data-cancel]").forEach(b => b.addEventListener("click", () => { open = null; confirmOff = null; render(); }));
  main.querySelectorAll<HTMLElement>("[data-addcoord]").forEach(b => b.addEventListener("click", () => { open = `coord:${b.dataset.addcoord}`; render(); $<HTMLInputElement>(`#cu${b.dataset.addcoord}`).focus(); }));
  main.querySelectorAll<HTMLElement>("[data-reset]").forEach(b => b.addEventListener("click", () => { open = `reset:${b.dataset.reset}`; render(); $<HTMLInputElement>(`#rp${b.dataset.reset}`).focus(); }));
  main.querySelectorAll<HTMLFormElement>("[data-coord-form]").forEach(f => f.addEventListener("submit", async e => {
    e.preventDefault();
    const id = f.dataset.coordForm!;
    await act(`/api/root/orgs/${id}/coordinators`, "POST", { username: $<HTMLInputElement>(`#cu${id}`).value.trim(), password: $<HTMLInputElement>(`#cp${id}`).value }, "Koordinator yaradıldı");
  }));
  main.querySelectorAll<HTMLFormElement>("[data-reset-form]").forEach(f => f.addEventListener("submit", async e => {
    e.preventDefault();
    const id = f.dataset.resetForm!;
    await act(`/api/root/users/${id}/password`, "POST", { password: $<HTMLInputElement>(`#rp${id}`).value }, "Şifrə sıfırlandı, köhnə sessiyalar bağlandı");
  }));
  main.querySelectorAll<HTMLElement>("[data-uactive]").forEach(b => b.addEventListener("click", () => {
    const [id, on] = b.dataset.uactive!.split(":");
    void act(`/api/root/users/${id}`, "PATCH", { active: on === "1" }, on === "1" ? "Koordinator aktiv edildi" : "Koordinator deaktiv edildi");
  }));
  main.querySelectorAll<HTMLElement>("[data-active]").forEach(b => b.addEventListener("click", () => {
    const [id, on] = b.dataset.active!.split(":");
    if (on === "0") { confirmOff = Number(id); render(); return; }
    void act(`/api/root/orgs/${id}`, "PATCH", { active: true }, "Təşkilat aktiv edildi");
  }));
  main.querySelectorAll<HTMLElement>("[data-off-yes]").forEach(b => b.addEventListener("click", () => {
    void act(`/api/root/orgs/${b.dataset.offYes}`, "PATCH", { active: false }, "Təşkilat deaktiv edildi");
  }));
  main.querySelectorAll<HTMLElement>("[data-enter]").forEach(b => b.addEventListener("click", async () => {
    try { const r = await api<{ redirect: string }>("/api/root/impersonate", { method: "POST", body: { orgId: Number(b.dataset.enter) } }); location.href = r.redirect; }
    catch (ex) { toast((ex as ApiError).message, "err"); }
  }));
}

async function act(path: string, method: string, body: unknown, ok: string) {
  try {
    await api(path, { method, body });
    open = null; confirmOff = null;
    toast(ok);
    await load();
  } catch (ex) { toast(ex instanceof ApiError ? ex.message : "Xəta baş verdi.", "err"); }
}

void load();
