// Light / dark / system. The choice lives in localStorage and is applied as <html data-theme>;
// an inline script in each page's <head> applies it before first paint.
import { icon } from "./dom";

type Mode = "light" | "dark" | "system";
const KEY = "ij.theme";

const read = (): Mode => {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
};

function apply(mode: Mode) {
  if (mode === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}

export function initTheme() { apply(read()); }

export function themeSwitch(root: HTMLElement) {
  const modes: Array<[Mode, string, string]> = [["light", "sun", "Açıq tema"], ["dark", "moon", "Tünd tema"], ["system", "auto", "Sistem teması"]];
  root.className = "theme";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Tema");
  const render = () => {
    const cur = read();
    root.innerHTML = modes.map(([m, ic, label]) =>
      `<button type="button" data-mode="${m}" aria-pressed="${cur === m}" title="${label}" aria-label="${label}">${icon(ic)}</button>`).join("");
  };
  root.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-mode]");
    if (!b) return;
    const m = b.dataset.mode as Mode;
    try { if (m === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, m); } catch { /* private mode */ }
    apply(m);
    render();
  });
  render();
}
