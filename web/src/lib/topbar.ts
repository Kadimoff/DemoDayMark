import { logout } from "./api";
import { $, esc, icon } from "./dom";
import { initTheme, themeSwitch } from "./theme";

export interface TopbarOpts {
  role: "admin" | "juror";
  eventName?: string;
  nav?: Array<{ href: string; label: string; current?: boolean; external?: boolean }>;
  logout?: boolean;
  wide?: boolean;
}

/** Renders the shared header into #top and returns a setter for the connection pill. */
export function topbar(opts: TopbarOpts) {
  initTheme();
  const root = $("#top");
  root.className = "top";
  root.innerHTML = `<div class="wrap${opts.wide ? " wide" : ""}">
    <a class="brand" href="/"><b>IGN<i>I</i>TE</b><span id="evName">${esc(opts.eventName ?? "Demo Day")}</span></a>
    <span class="conn" id="conn">Qoşulur…</span>
    <span class="spacer"></span>
    ${opts.nav ? `<nav class="nav" aria-label="Bölmələr">${opts.nav.map(n => `<a href="${n.href}"${n.current ? ' aria-current="page"' : ""}${n.external ? ' target="_blank" rel="noopener"' : ""}>${esc(n.label)}${n.external ? icon("ext") : ""}</a>`).join("")}</nav>` : ""}
    <div id="themeSw"></div>
    ${opts.logout !== false ? `<button class="icon-btn" id="logout" title="Çıxış" aria-label="Çıxış">${icon("logout")}</button>` : ""}
  </div>`;
  themeSwitch($("#themeSw"));
  root.querySelector("#logout")?.addEventListener("click", () => logout(opts.role));
  return {
    setEventName(name: string) { $("#evName").textContent = name || "Demo Day"; },
    setOnline(online: boolean) {
      const c = $("#conn");
      c.className = `conn ${online ? "online" : "offline"}`;
      c.textContent = online ? "Canlı" : "Bağlantı yoxdur";
    },
  };
}
