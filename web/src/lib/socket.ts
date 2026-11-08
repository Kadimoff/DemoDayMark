import { io, type Socket } from "socket.io-client";
import { pageOrg } from "./org";

export interface LiveOptions {
  /** Which session to connect with; omitted = anonymous (public room only). */
  role?: "admin" | "juror" | "team";
  /** Extra handshake fields (v3: `watch: "root"` for the platform panel). */
  auth?: Record<string, string>;
  on: Record<string, (payload: any) => void>;
  /** Called after every reconnect (and when the tab becomes visible again) to refetch full state. */
  resync: () => void;
  status?: (online: boolean) => void;
  /** v3: show the small "Yenidən qoşulur…" pill while the connection is down (default true). */
  indicator?: boolean;
}

// v3 reliability: WebSocket first, long-polling as the fallback (some venue Wi-Fi / proxies block WebSocket).
// Reconnects with exponential backoff (0.5 s → 5 s, randomised so 30 phones do not reconnect in lockstep) and
// refetches the full state on every reconnect, when the tab comes back from the background and when the
// network returns — so the timer, the stage, the slide and notifications are never left stale.
export function live({ role, auth, on, resync, status, indicator = true }: LiveOptions): Socket {
  const s = io({
    path: "/socket.io", transports: ["websocket", "polling"], tryAllTransports: true,
    reconnectionDelay: 500, reconnectionDelayMax: 5000, randomizationFactor: 0.5, timeout: 10000,
    auth: { ...(role ? { role } : {}), ...(pageOrg() ? { org: pageOrg()! } : {}), ...(auth ?? {}) },
  });
  const pill = indicator ? netPill() : null;
  let connectedOnce = false;
  let lastResync = 0;
  const doResync = () => { lastResync = Date.now(); resync(); };
  s.on("connect", () => {
    status?.(true);
    pill?.up(connectedOnce);
    if (connectedOnce) doResync();
    connectedOnce = true;
  });
  s.on("disconnect", reason => {
    status?.(false);
    pill?.down();
    // the server closed us on purpose (e.g. session ended): socket.io does not retry that by itself
    if (reason === "io server disconnect") setTimeout(() => s.connect(), 1500);
  });
  s.on("connect_error", () => { status?.(false); pill?.down(); });
  s.io.on("reconnect_attempt", n => pill?.attempt(n));
  for (const [ev, fn] of Object.entries(on)) s.on(ev, fn);
  const wake = () => {
    if (!s.connected) s.connect();
    // a phone coming back from the background: refetch even if the socket survived (events may have been missed)
    if (Date.now() - lastResync > 1500) doResync();
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wake(); });
  addEventListener("online", wake);
  addEventListener("pageshow", e => { if ((e as PageTransitionEvent).persisted) wake(); });
  return s;
}

/** Small fixed pill: "Yenidən qoşulur…" while down (after a short grace period), "Bağlantı bərpa olundu" for a moment after. */
function netPill() {
  let el: HTMLElement | null = null;
  let t = 0, hideT = 0, isDown = false;
  const node = () => {
    if (!el) {
      el = document.createElement("div");
      el.className = "net-pill";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.hidden = true;
      document.body.appendChild(el);
    }
    return el;
  };
  return {
    down() {
      if (isDown) return;
      isDown = true;
      clearTimeout(t); clearTimeout(hideT);
      // brief blips (a deploy, a Wi-Fi handover) stay invisible
      t = window.setTimeout(() => { const n = node(); n.className = "net-pill down"; n.innerHTML = `<i></i>Yenidən qoşulur…`; n.hidden = false; }, 1200);
    },
    attempt(n: number) { if (el && !el.hidden && isDown) el.innerHTML = `<i></i>Yenidən qoşulur…${n > 2 ? ` <small>(${n})</small>` : ""}`; },
    up(again: boolean) {
      clearTimeout(t);
      const wasShown = !!el && !el.hidden;
      isDown = false;
      if (!again || !wasShown) { if (el) el.hidden = true; return; }
      const n = node(); n.className = "net-pill up"; n.textContent = "Bağlantı bərpa olundu"; n.hidden = false;
      hideT = window.setTimeout(() => { n.hidden = true; }, 1800);
    },
  };
}
