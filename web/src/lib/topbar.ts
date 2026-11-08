import { api, ApiError, logout } from "./api";
import { $, brandHtml, esc, icon, toast } from "./dom";
import { setPanelOrg } from "./org";
import { themeSwitch, themeToggleHtml, toggleTheme } from "./theme";

export interface TopbarOpts {
  role: "admin" | "juror";
  eventName?: string;
  /** `short` and `icon` are used by the phone tab bar. */
  nav?: Array<{ href: string; label: string; short?: string; icon?: string; current?: boolean; external?: boolean; tab?: boolean }>;
  logout?: boolean;
  wide?: boolean;
}

export { brandHtml } from "./dom";

export interface Me {
  id: number; role: "admin" | "juror"; username: string; displayName: string; isRoot: boolean; impersonating: boolean;
  org: { id: number; slug: string; name: string; root: boolean } | null;
}
let meP: Promise<Me | null> | null = null;
/** orgs: the signed-in coordinator, its organisation and whether it is the platform owner (cached per page). */
export const whoAmI = () => (meP ??= api<Me>("/api/auth/me?role=admin").catch(() => null));

/** Renders the shared coordinator header into #top and returns setters for the brand and connection pill. */
export function topbar(opts: TopbarOpts) {
  const root = $("#top");
  const item = (n: NonNullable<TopbarOpts["nav"]>[number]) => `<a href="${n.href}"${n.current ? ' aria-current="page"' : ""}${n.external ? ' target="_blank" rel="noopener"' : ""}>${n.icon ? `<span class="ni">${icon(n.icon)}</span>` : ""}<span class="nl">${esc(n.label)}</span><span class="ns">${esc(n.short ?? n.label)}</span>${n.external ? `<span class="nx">${icon("ext")}</span>` : ""}</a>`;
  const navHtml = opts.nav ? opts.nav.map(item).join("") : "";
  // v4: the phone tab bar shows only the entries meant for it
  const tabHtml = opts.nav ? opts.nav.filter(n => n.tab !== false).map(item).join("") : "";
  root.className = "top";
  root.innerHTML = `<div class="wrap${opts.wide ? " wide" : ""}">
    <a class="brand" href="/" title="munsif.im"><img class="mlogo" src="/brand/munsif-logo.svg" alt="munsif.im" width="111" height="32"><img class="mmark" src="/brand/munsif-mark-flat.svg" alt="munsif.im" width="32" height="32"></a>
    <span class="evpill"><b id="topBrand">${brandHtml(opts.eventName ?? "Hakaton")}</b><span class="role">${opts.role === "admin" ? "Koordinator" : "Münsif"}</span></span>
    ${navHtml ? `<nav class="nav" aria-label="Bölmələr">${navHtml}</nav>` : ""}
    <span class="spacer"></span>
    <span class="conn" id="conn">Qoşulur…</span>
    ${opts.role === "admin" ? `<span id="bellSlot"></span>` : ""}
    <div id="themeSw"></div><span class="th1" id="themeOne">${themeToggleHtml()}</span>
    <div class="who-me"><div class="nm"><b id="meName">Koordinator</b><small id="meOrg">Admin sessiyası</small></div><span class="avatar" aria-hidden="true">${icon("users")}</span></div>
    ${opts.role === "admin" ? `<button class="icon-btn" id="pwBtn" title="Şifrəni dəyiş" aria-label="Şifrəni dəyiş">${icon("key")}</button>` : ""}
    ${opts.logout !== false ? `<button class="icon-btn" id="logout" title="Hesabdan çıx" aria-label="Hesabdan çıx">${icon("logout")}</button>` : ""}
  </div>
  <div class="imp-bar" id="impBar" hidden></div>`;
  // Phones: the same links as a tab bar fixed to the bottom of the screen (outside the blurred header,
  // whose backdrop-filter would otherwise pin a fixed child to the header instead of the viewport).
  if (navHtml && !document.querySelector(".tabbar")) {
    const tb = document.createElement("nav");
    tb.className = "tabbar";
    tb.setAttribute("aria-label", "Bölmələr");
    tb.innerHTML = tabHtml;
    document.body.appendChild(tb);
  }
  root.querySelector("#logout")?.addEventListener("click", () => logout(opts.role));
  root.querySelector("#pwBtn")?.addEventListener("click", () => passwordDialog());
  if (opts.role === "admin") void whoAmI().then(me => { if (me) applyMe(me, opts); });
  themeSwitch($("#themeSw"));
  // Phones get one light/dark button instead of the three-way switch.
  const one = $("#themeOne");
  one.addEventListener("click", () => { toggleTheme(); one.innerHTML = themeToggleHtml(); $("#themeSw").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", "false")); });
  return {
    setEventName(name: string) {
      $("#topBrand").innerHTML = brandHtml(name);
      shownEvent = name;
      syncOrgName();
      const page = document.title.split(" · ")[0];
      document.title = `${page} · ${name || "Hakaton"} · munsif.im`;
    },
    setOnline(online: boolean) {
      const c = $("#conn");
      c.className = `conn ${online ? "online" : "offline"}`;
      c.textContent = online ? "Sinxron" : "Oflayn";
    },
  };
}

let orgName = "";
let shownEvent = "";
/** The organisation's name is shown next to the event only when the event name does not already say it. */
function syncOrgName() {
  const el = document.querySelector<HTMLElement>(".evpill .orgname");
  if (el) el.hidden = !orgName || (!!shownEvent && shownEvent.toLocaleLowerCase("az").includes(orgName.toLocaleLowerCase("az")));
}

/** orgs: organisation name in the header, "Təşkilatlar" for the platform owner, the impersonation banner, own links. */
function applyMe(me: Me, opts: TopbarOpts) {
  if (me.org) setPanelOrg(me.org.slug);
  const org = me.org?.name ?? "";
  $("#meName").textContent = me.displayName || "Koordinator";
  $("#meOrg").textContent = me.isRoot && !me.impersonating ? "Platforma sahibi" : org || "Koordinator";
  const pill = document.querySelector(".evpill");
  if (pill && org) {
    const o = document.createElement("span");
    o.className = "orgname";
    o.title = "Təşkilat";
    o.textContent = org;
    pill.prepend(o);
    orgName = org;
    syncOrgName();
  }
  // v3: the platform owner reaches its own panel (/root) from every coordinator page it opens
  if (me.isRoot && opts.nav && location.pathname !== "/root" && !document.querySelector("a[data-orgs-link]")) {
    const html = `<a href="/root" data-orgs-link><span class="ni">${icon("db")}</span><span class="nl">Platforma</span><span class="ns">Platforma</span></a>`;
    document.querySelectorAll(".nav, .tabbar").forEach(n => n.insertAdjacentHTML("beforeend", html));
  }
  if (me.impersonating && me.org) {
    const b = $("#impBar");
    b.hidden = false;
    b.innerHTML = `<div class="wrap wide row"><span>${icon("shield")}Müdaxilə: siz <b>${esc(me.org.name)}</b> təşkilatının panelindəsiniz (platforma sahibi kimi).</span>
      <span class="spacer"></span><button class="btn sm" id="impBack">${icon("back")}Platformaya qayıt</button></div>`;
    $("#impBack").addEventListener("click", async () => {
      try { await api<{ redirect: string }>("/api/root/impersonate", { method: "POST", body: { orgId: null } }); location.href = "/root"; }
      catch (e) { toast((e as ApiError).message, "err"); }
    });
  }
}

/** "Şifrəni dəyiş" — for every coordinator and the platform owner. */
export function passwordDialog() {
  let d = document.getElementById("pwDlg") as HTMLDialogElement | null;
  if (!d) {
    d = document.createElement("dialog");
    d.id = "pwDlg";
    d.setAttribute("aria-labelledby", "pwTitle");
    document.body.appendChild(d);
  }
  d.innerHTML = `<div class="dh"><div><h2 id="pwTitle" style="font-size:19px">${icon("key")} Şifrəni dəyiş</h2><p class="sub">Yeni şifrə ən azı 8 simvol. Digər cihazlardakı sessiyalar bağlanacaq.</p></div>
      <button class="icon-btn" data-close aria-label="Bağla">${icon("close")}</button></div>
    <form class="db stack" id="pwForm" novalidate>
      <div><label class="f" for="pwCur">Hazırkı şifrə</label><input type="password" id="pwCur" autocomplete="current-password" required></div>
      <div><label class="f" for="pwNew">Yeni şifrə</label><input type="password" id="pwNew" autocomplete="new-password" minlength="8" required></div>
      <div><label class="f" for="pwNew2">Yeni şifrə (təkrar)</label><input type="password" id="pwNew2" autocomplete="new-password" minlength="8" required></div>
      <p class="err-t" id="pwErr" role="alert"></p>
      <div class="row"><button class="btn primary" type="submit" id="pwGo">Yadda saxla</button><button class="btn" type="button" data-close>Ləğv et</button></div>
    </form>`;
  const dlg = d;
  dlg.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => dlg.close()));
  $<HTMLFormElement>("#pwForm", dlg).addEventListener("submit", async e => {
    e.preventDefault();
    const current = $<HTMLInputElement>("#pwCur", dlg).value, next = $<HTMLInputElement>("#pwNew", dlg).value;
    const err = $("#pwErr", dlg);
    if (!current || !next) { err.textContent = "Bütün sahələri doldurun."; return; }
    if (next.length < 8) { err.textContent = "Yeni şifrə ən azı 8 simvol olmalıdır."; return; }
    if (next !== $<HTMLInputElement>("#pwNew2", dlg).value) { err.textContent = "Yeni şifrələr eyni deyil."; return; }
    const go = $<HTMLButtonElement>("#pwGo", dlg);
    go.disabled = true;
    try {
      await api("/api/auth/password", { method: "POST", body: { current, next } });
      dlg.close();
      toast("Şifrə dəyişdirildi");
    } catch (ex) { err.textContent = ex instanceof ApiError ? ex.message : "Xəta baş verdi."; go.disabled = false; }
  });
  dlg.showModal();
  $<HTMLInputElement>("#pwCur", dlg).focus();
}
