export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const fmt1 = (n: number | null | undefined) => (n == null || Number.isNaN(n) ? "-" : n.toFixed(1));
export const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

let toastTimer = 0;
export function toast(msg: string, kind: "ok" | "err" = "ok") {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.className = "toast";
    t.setAttribute("role", "status");
    t.setAttribute("aria-live", "polite");
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.toggle("err", kind === "err");
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove("on"), 3400);
}

// Stroke icons (24px grid). No emoji anywhere in the UI.
const P: Record<string, string> = {
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/>',
  skip: '<path d="M13 5l7 7-7 7M5 5l7 7-7 7"/>',
  reset: '<path d="M4 4v5h5M4.6 9A8 8 0 1 1 4 13"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  sound: '<path d="M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16a8 8 0 0 0 0-16z" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l3 3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  retry: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 14h2M14 18h2M18 18h2v2M17 17h1"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.2a3 3 0 0 1 0 5.6M17.5 14.3A5.5 5.5 0 0 1 20.5 19"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  timer: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.5M9.5 3h5"/>',
  medal: '<circle cx="12" cy="15" r="5"/><path d="M8.5 11 6 3h4l2 5 2-5h4l-2.5 8"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  send: '<path d="M4 12l16-8-6 16-2.5-6.5z"/><path d="M11.5 13.5 20 4"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.1 4.5 4.5 0 0 0 7 18z"/><path d="M9.5 13.5l2 2 3.5-3.5"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  sheet: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>',
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
  power: '<path d="M12 3v8M7 6.3a7 7 0 1 0 10 0"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
};
export const icon = (name: keyof typeof P | string) =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ""}</svg>`;

/** FLIP: call before re-render to record positions, then call the returned function after. */
export function flip(container: HTMLElement, selector = "[data-flip]") {
  const before = new Map<string, number>();
  container.querySelectorAll<HTMLElement>(selector).forEach(el => before.set(el.dataset.flip!, el.getBoundingClientRect().top));
  return () => {
    if (reducedMotion()) return;
    container.querySelectorAll<HTMLElement>(selector).forEach(el => {
      const old = before.get(el.dataset.flip!);
      if (old == null) return;
      const dy = old - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) return;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 560, easing: "cubic-bezier(.2,.8,.2,1)" });
    });
  };
}

/** "Rəşad Əliyev" → "RƏ"; "Münsif 3" → "M3". */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toLocaleUpperCase("az");
  return (parts[0][0] + (/^\d+$/.test(parts[1]) ? parts[1] : parts[1][0])).toLocaleUpperCase("az");
}

/** "45 san əvvəl", "3 dəq əvvəl", "14:05". */
export function ago(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 10) return "indi";
  if (s < 60) return `${s} san əvvəl`;
  if (s < 3600) return `${Math.floor(s / 60)} dəq əvvəl`;
  return hhmm(ms);
}

/** The event's name exactly as the organiser typed it (escaped). */
export function brandHtml(name: string) {
  return esc((name || "").trim());
}

// ---------- double-tap guard (slow network) ----------
const lastRun = new Map<string, number>(); // -1 = still running
/**
 * Runs `fn` unless the same control (key) is still waiting for the server or finished less than `gap` ms ago.
 * On a slow network a second tap on "Başlat" / "Növbəti" / a slide button must not pause the timer again, skip a team or
 * jump two slides. Returns undefined when the tap was ignored.
 */
export async function guarded<T>(key: string, fn: () => Promise<T>, gap = 600): Promise<T | undefined> {
  const last = lastRun.get(key);
  if (last === -1 || (last != null && Date.now() - last < gap)) return undefined;
  lastRun.set(key, -1);
  try { return await fn(); } finally { lastRun.set(key, Date.now()); }
}

// ---------- dropdown menus stay on screen ----------
// "⋯ Daha çox" menus (details.more > .menu) open under their button; on a phone a button near the right edge pushed the
// menu off the screen. When one opens, it is placed so it fits: right-aligned if it would overflow, never past the edges.
if (typeof document !== "undefined") {
  document.addEventListener("toggle", e => {
    const d = e.target as HTMLElement;
    if (!(d instanceof HTMLDetailsElement) || !d.open || !d.classList.contains("more")) return;
    const menu = d.querySelector<HTMLElement>(":scope > .menu");
    if (!menu) return;
    menu.style.left = "0px"; menu.style.right = "auto"; menu.style.maxWidth = `calc(100vw - 24px)`;
    const r = menu.getBoundingClientRect(), W = document.documentElement.clientWidth, pad = 12;
    if (r.right > W - pad) {
      const shift = Math.min(r.right - (W - pad), r.left - pad);
      menu.style.left = `${-Math.max(0, shift)}px`;
    }
    // close the other open menus and close on a tap outside
    document.querySelectorAll<HTMLDetailsElement>("details.more[open]").forEach(o => { if (o !== d) o.open = false; });
  }, true);
  document.addEventListener("click", e => {
    const t = e.target as HTMLElement;
    document.querySelectorAll<HTMLDetailsElement>("details.more[open]").forEach(o => { if (!o.contains(t)) o.open = false; });
  });
}
