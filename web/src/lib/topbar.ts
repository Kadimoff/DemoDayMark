import { logout } from "./api";
import { $, brandHtml, esc, icon } from "./dom";
import { themeSwitch, themeToggleHtml, toggleTheme } from "./theme";

export interface TopbarOpts {
  role: "admin" | "juror";
  eventName?: string;
  /** `short` and `icon` are used by the phone tab bar. */
  nav?: Array<{ href: string; label: string; short?: string; icon?: string; current?: boolean; external?: boolean }>;
  logout?: boolean;
  wide?: boolean;
}

export { brandHtml } from "./dom";

/** Renders the shared coordinator header into #top and returns setters for the brand and connection pill. */
export function topbar(opts: TopbarOpts) {
  const root = $("#top");
  const navHtml = opts.nav ? `${opts.nav.map(n => `<a href="${n.href}"${n.current ? ' aria-current="page"' : ""}${n.external ? ' target="_blank" rel="noopener"' : ""}>${n.icon ? `<span class="ni">${icon(n.icon)}</span>` : ""}<span class="nl">${esc(n.label)}</span><span class="ns">${esc(n.short ?? n.label)}</span>${n.external ? `<span class="nx">${icon("ext")}</span>` : ""}</a>`).join("")}` : "";
  root.className = "top";
  root.innerHTML = `<div class="wrap${opts.wide ? " wide" : ""}">
    <a class="brand" href="/" title="munsif.im"><img class="mlogo" src="/brand/munsif-logo.svg" alt="munsif.im" width="111" height="32"><img class="mmark" src="/brand/munsif-mark-flat.svg" alt="munsif.im" width="32" height="32"></a>
    <span class="evpill"><b id="topBrand">${brandHtml(opts.eventName ?? "Hakaton")}</b><span class="role">${opts.role === "admin" ? "Koordinator" : "Münsif"}</span></span>
    ${navHtml ? `<nav class="nav" aria-label="Bölmələr">${navHtml}</nav>` : ""}
    <span class="spacer"></span>
    <span class="conn" id="conn">Qoşulur…</span>
    ${opts.role === "admin" ? `<span id="bellSlot"></span>` : ""}
    <div id="themeSw"></div><span class="th1" id="themeOne">${themeToggleHtml()}</span>
    <div class="who-me"><div class="nm"><b>Koordinator</b><small>Admin sessiyası</small></div><span class="avatar" aria-hidden="true">${icon("users")}</span></div>
    ${opts.logout !== false ? `<button class="icon-btn" id="logout" title="Çıxış" aria-label="Çıxış">${icon("logout")}</button>` : ""}
  </div>`;
  // Phones: the same links as a tab bar fixed to the bottom of the screen (outside the blurred header,
  // whose backdrop-filter would otherwise pin a fixed child to the header instead of the viewport).
  if (navHtml && !document.querySelector(".tabbar")) {
    const tb = document.createElement("nav");
    tb.className = "tabbar";
    tb.setAttribute("aria-label", "Bölmələr");
    tb.innerHTML = navHtml;
    document.body.appendChild(tb);
  }
  root.querySelector("#logout")?.addEventListener("click", () => logout(opts.role));
  themeSwitch($("#themeSw"));
  // Phones get one light/dark button instead of the three-way switch.
  const one = $("#themeOne");
  one.addEventListener("click", () => { toggleTheme(); one.innerHTML = themeToggleHtml(); $("#themeSw").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", "false")); });
  return {
    setEventName(name: string) {
      $("#topBrand").innerHTML = brandHtml(name);
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
