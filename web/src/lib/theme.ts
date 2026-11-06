// Light / dark / system for the app screens. The choice lives in localStorage ("ij.theme") and is applied as
// <html data-theme="light|dark">. An inline script in each app page's <head> applies it before first paint;
// projector screens (/timer, /reveal) never load this and always stay dark.
import { icon } from "./dom";

export type Mode = "light" | "dark" | "system";
const KEY = "ij.theme";
const media = matchMedia("(prefers-color-scheme: light)");

export const readMode = (): Mode => {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
};
const resolve = (m: Mode) => (m === "system" ? (media.matches ? "light" : "dark") : m);
function apply(m: Mode) {
  document.documentElement.dataset.theme = resolve(m);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolve(m) === "light" ? "#F3F4F7" : "#0B0F19");
}
function save(m: Mode) {
  try { if (m === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, m); } catch { /* private mode */ }
  apply(m);
}

let listening = false;
export function initTheme() {
  apply(readMode());
  if (!listening) { listening = true; media.addEventListener("change", () => { if (readMode() === "system") apply("system"); }); }
}

const MODES: Array<[Mode, string, string]> = [["light", "sun", "Açıq tema"], ["dark", "moon", "Tünd tema"], ["system", "auto", "Sistem teması"]];

/** Three-way segmented switch (coordinator header). */
export function themeSwitch(root: HTMLElement) {
  initTheme();
  root.className = "theme";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Tema");
  const render = () => {
    const cur = readMode();
    root.innerHTML = MODES.map(([m, ic, label]) => `<button type="button" data-mode="${m}" aria-pressed="${cur === m}" title="${label}" aria-label="${label}">${icon(ic)}</button>`).join("");
  };
  root.addEventListener("click", e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-mode]");
    if (!b) return;
    save(b.dataset.mode as Mode);
    render();
  });
  render();
}

/** One round button that flips light ↔ dark (phone headers, where space is tight). */
export function themeToggleHtml() {
  const light = resolve(readMode()) === "light";
  return `<button type="button" class="theme-1" data-theme-toggle title="${light ? "Tünd tema" : "Açıq tema"}" aria-label="${light ? "Tünd temaya keç" : "Açıq temaya keç"}">${icon(light ? "moon" : "sun")}</button>`;
}
export function toggleTheme() { save(resolve(readMode()) === "light" ? "dark" : "light"); }
