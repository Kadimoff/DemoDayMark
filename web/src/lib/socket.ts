import { io, type Socket } from "socket.io-client";
import { pageOrg } from "./org";

export interface LiveOptions {
  /** Which session to connect with; omitted = anonymous (public room only). */
  role?: "admin" | "juror" | "team";
  on: Record<string, (payload: any) => void>;
  /** Called after every reconnect (and when the tab becomes visible again) to refetch full state. */
  resync: () => void;
  status?: (online: boolean) => void;
}

export function live({ role, on, resync, status }: LiveOptions): Socket {
  const s = io({ path: "/socket.io", transports: ["websocket", "polling"], reconnectionDelayMax: 4000, auth: { ...(role ? { role } : {}), ...(pageOrg() ? { org: pageOrg()! } : {}) } });
  let connectedOnce = false;
  s.on("connect", () => {
    status?.(true);
    if (connectedOnce) resync();
    connectedOnce = true;
  });
  s.on("disconnect", () => status?.(false));
  s.on("connect_error", () => status?.(false));
  for (const [ev, fn] of Object.entries(on)) s.on(ev, fn);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (!s.connected) s.connect();
      resync();
    }
  });
  return s;
}
