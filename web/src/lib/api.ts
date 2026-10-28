export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly data: Record<string, unknown> = {}) { super(message); }
  /** No response at all (Wi-Fi drop, server down) or a gateway error. */
  get network() { return this.status === 0 || this.status >= 502; }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      credentials: "same-origin",
      headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError("Serverə qoşulmaq mümkün olmadı. İnterneti yoxlayın.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !location.pathname.startsWith("/login") && !path.startsWith("/api/auth/")) {
    location.href = "/login";
  }
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Xəta baş verdi (${res.status}).`, res.status, data);
  return data as T;
}

export const logout = async (role: "admin" | "juror") => {
  await api("/api/auth/logout", { method: "POST", body: { role } }).catch(() => {});
  location.href = "/login";
};
