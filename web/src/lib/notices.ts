// munsif.im notifications: bell with an unread count and a list, a toast for each new one, and a system
// notification (Notification API) when the tab is in the background and the user allowed it.
import type { Notice } from "../../../shared/types";
import { api } from "./api";
import { ago, esc, icon, toast } from "./dom";
import { chime } from "./alert";

export interface NoticeBell { set(list: Notice[]): void; push(n: Notice): void; refresh(): Promise<void> }

export function browserNotify(title: string, body: string) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
    new Notification(title, { body, icon: "/brand/icon-192.png", tag: `munsif-${title}` });
  } catch { /* unsupported */ }
}

export async function askNotifications(): Promise<string> {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "default") { try { return await Notification.requestPermission(); } catch { return "denied"; } }
  return Notification.permission;
}

/** Renders a bell into `slot`. `paths` = list + mark-read endpoints. */
export function noticeBell(slot: HTMLElement, paths: { list: string; read: string }, opts: { onOpen?: () => void } = {}): NoticeBell {
  let list: Notice[] = [];
  let open = false;
  slot.className = "bell-wrap";
  slot.innerHTML = `<button class="icon-btn bell" type="button" aria-haspopup="true" aria-expanded="false" title="Bildirişlər" aria-label="Bildirişlər">${icon("bell")}<span class="bell-n" hidden>0</span></button>
    <div class="npanel" role="dialog" aria-label="Bildirişlər" hidden></div>`;
  const btn = slot.querySelector<HTMLButtonElement>(".bell")!;
  const n = slot.querySelector<HTMLElement>(".bell-n")!;
  const panel = slot.querySelector<HTMLElement>(".npanel")!;

  const render = () => {
    const unread = list.filter(x => !x.read).length;
    n.hidden = !unread;
    n.textContent = unread > 9 ? "9+" : String(unread);
    btn.classList.toggle("has", unread > 0);
    const perm = "Notification" in window ? Notification.permission : "unsupported";
    panel.innerHTML = `<div class="np-head"><b>Bildirişlər</b>${perm === "default" ? `<button class="btn sm" data-np-allow>${icon("bell")}Brauzer bildirişləri</button>` : ""}</div>
      ${list.length ? `<ul class="np-list">${list.map(x => `<li class="${x.read ? "" : "new"}"><b>${esc(x.title)}</b>${x.body ? `<span>${esc(x.body)}</span>` : ""}<time>${ago(x.at)}</time></li>`).join("")}</ul>`
        : `<p class="np-empty">Hələ bildiriş yoxdur.</p>`}`;
  };
  const toggle = async (v = !open) => {
    open = v;
    panel.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      render();
      opts.onOpen?.();
      if (list.some(x => !x.read)) {
        await api(paths.read, { method: "POST", body: {} }).catch(() => {});
        list = list.map(x => ({ ...x, read: true }));
        setTimeout(render, 1200);
        n.hidden = true;
      }
    }
  };
  btn.addEventListener("click", e => { e.stopPropagation(); void toggle(); });
  panel.addEventListener("click", async e => {
    e.stopPropagation();
    if ((e.target as HTMLElement).closest("[data-np-allow]")) { await askNotifications(); render(); }
  });
  document.addEventListener("click", () => { if (open) void toggle(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && open) void toggle(false); });

  const api2: NoticeBell = {
    set(l) { list = l; render(); },
    push(x) {
      list = [x, ...list.filter(y => y.id !== x.id)].slice(0, 60);
      render();
      toast(x.body ? `${x.title}: ${x.body}` : x.title);
      chime();
      browserNotify(x.title, x.body);
      btn.classList.remove("ring"); void btn.offsetWidth; btn.classList.add("ring");
    },
    async refresh() { try { list = await api<Notice[]>(paths.list); render(); } catch { /* offline */ } },
  };
  render();
  return api2;
}
