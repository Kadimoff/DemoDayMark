import { logout } from "./api";
import { $, esc, icon } from "./dom";

export interface TopbarOpts {
  role: "admin" | "juror";
  eventName?: string;
  nav?: Array<{ href: string; label: string; current?: boolean; external?: boolean }>;
  logout?: boolean;
  wide?: boolean;
}

/** "Ignite DemoDay" → `IGNITE <i>DEMODAY</i>`: the fixed product word is highlighted. */
export function brandHtml(name: string) {
  const n = (name || "DemoDay").trim();
  const m = n.match(/^(.*?)\s*(DemoDay)$/i);
  return m && m[1] ? `${esc(m[1])} <i>${esc(m[2])}</i>` : `<i>${esc(n)}</i>`;
}

/** Renders the shared coordinator header into #top and returns setters for the brand and connection pill. */
export function topbar(opts: TopbarOpts) {
  const root = $("#top");
  root.className = "top";
  root.innerHTML = `<div class="wrap${opts.wide ? " wide" : ""}">
    <a class="brand" href="/"><span class="flame" aria-hidden="true"></span><b id="evName">${brandHtml(opts.eventName ?? "DemoDay")}</b><span class="role">${opts.role === "admin" ? "Koordinator paneli" : "Münsif"}</span></a>
    ${opts.nav ? `<nav class="nav" aria-label="Bölmələr">${opts.nav.map(n => `<a href="${n.href}"${n.current ? ' aria-current="page"' : ""}${n.external ? ' target="_blank" rel="noopener"' : ""}>${esc(n.label)}${n.external ? icon("ext") : ""}</a>`).join("")}</nav>` : ""}
    <span class="spacer"></span>
    <span class="conn" id="conn">Qoşulur…</span>
    <div class="who-me"><div class="nm"><b>Koordinator</b><small>Admin sessiyası</small></div><span class="avatar" aria-hidden="true">${icon("users")}</span></div>
    ${opts.logout !== false ? `<button class="icon-btn" id="logout" title="Çıxış" aria-label="Çıxış">${icon("logout")}</button>` : ""}
  </div>`;
  root.querySelector("#logout")?.addEventListener("click", () => logout(opts.role));
  return {
    setEventName(name: string) {
      $("#evName").innerHTML = brandHtml(name);
      const page = document.title.split(" · ")[0];
      document.title = `${page} · ${name || "DemoDay"}`;
    },
    setOnline(online: boolean) {
      const c = $("#conn");
      c.className = `conn ${online ? "online" : "offline"}`;
      c.textContent = online ? "Sinxron" : "Oflayn";
    },
  };
}
