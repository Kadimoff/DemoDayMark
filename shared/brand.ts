// Event name. Since v13 the organiser types the whole name ("IDDA Hakaton 2026") and `product` is "" (FREE_NAME).
// Older rows (and archived settings) keep a brand prefix ("Ignite") + event type ("Hakaton" / "DemoDay") → "Ignite Hakaton".
export const PRODUCTS = ["Hakaton", "DemoDay"] as const;
/** product value of an event whose `name` is already the full name. */
export const FREE_NAME = "" as const;
export type Product = (typeof PRODUCTS)[number] | typeof FREE_NAME;
export const DEFAULT_PRODUCT: Product = "Hakaton";
export const asProduct = (v: unknown): Product => v === FREE_NAME || (PRODUCTS as readonly unknown[]).includes(v) ? (v as Product) : DEFAULT_PRODUCT;
/** Shown when a free-named event has no name yet. */
export const UNNAMED_EVENT = "Tədbir";

export function brandName(prefix: string | null | undefined, product: string = DEFAULT_PRODUCT): string {
  const p = (prefix ?? "").trim();
  const k = asProduct(product);
  if (k === FREE_NAME) return p || UNNAMED_EVENT;
  return p ? `${p} ${k}` : k;
}

/** File-name-safe form: "Ignite_Hakaton" / "DemoDay". */
export function brandSlug(name: string): string {
  return name.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
}

/** Strips a trailing event type the organiser may have typed into the prefix ("Ignite Demo Day" → "Ignite"). */
export function prefixFromLegacyName(name: string): string {
  return name.replace(/\s*(demo\s*day|hakaton|hackathon)\s*$/i, "").trim();
}

export const DEFAULT_FEEDBACK_TAGS = [
  "Güclü texnologiya",
  "Güclü komanda",
  "Yüksək B2B potensialı",
  "Aydın gəlir modeli",
  "GTM strategiyası qeyri-müəyyən",
  "Trakşn aydın deyil",
  "Rəqabət riski",
];

/** Name a juror account has from creation until the person scans the QR and types their own ("Münsif 3"). */
export const placeholderName = (n: number) => `Münsif ${n}`;
export const isPlaceholderName = (name: string) => /^Münsif \d+$/.test(name);
