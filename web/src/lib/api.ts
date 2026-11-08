import { pageOrg } from "./org";

/** orgs: public pages (/o/<slug>/…) ask the API about their organisation. Session-bound APIs ignore the parameter. */
function withOrg(path: string) {
  const o = pageOrg();
  if (!o || !path.startsWith("/api/") || /[?&]org=/.test(path)) return path;
  return `${path}${path.includes("?") ? "&" : "?"}org=${encodeURIComponent(o)}`;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly data: Record<string, unknown> = {}) { super(message); }
  /** No response at all (Wi-Fi drop, server down) or a gateway error. */
  get network() { return this.status === 0 || this.status >= 502; }
}

/** `timeoutMs`: a request that hangs (dead connection on a flaky network) fails instead of spinning forever. */
export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  let res: Response;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15000);
  try {
    res = await fetch(withOrg(path), {
      method: opts.method ?? "GET",
      credentials: "same-origin",
      headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal,
    });
  } catch {
    throw new ApiError(ctl.signal.aborted ? "Server vaxtında cavab vermədi." : "Serverə qoşulmaq mümkün olmadı. İnterneti yoxlayın.", 0);
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !location.pathname.startsWith("/login") && !path.startsWith("/api/auth/") && !path.startsWith("/api/team/")) {
    location.href = "/login";
  }
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Xəta baş verdi (${res.status}).`, res.status, data);
  return data as T;
}

export const logout = async (role: "admin" | "juror") => {
  await api("/api/auth/logout", { method: "POST", body: { role } }).catch(() => {});
  location.href = "/login";
};
