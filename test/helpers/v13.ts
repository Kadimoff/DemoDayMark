// v13 (free event name) rewrites the `event` row on purpose: name = the name it showed ("TechConnect" + "Hakaton" →
// "TechConnect Hakaton"), product = ''. Upgrade tests compare old snapshots of `event` through this.
import { brandName } from "../../shared/brand.js";

export function asV13<T>(table: string, rows: T): T {
  if (table !== "event" || !Array.isArray(rows)) return rows;
  return rows.map((r: Record<string, unknown>) =>
    "product" in r && r.product !== "" ? { ...r, name: brandName(String(r.name ?? ""), String(r.product)), product: "" } : r) as T;
}
