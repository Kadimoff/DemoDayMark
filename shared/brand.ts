// Event name = organiser's prefix (e.g. "Ignite") + event type ("Hakaton" or "DemoDay") → "Ignite Hakaton".
export const PRODUCTS = ["Hakaton", "DemoDay"] as const;
export type Product = (typeof PRODUCTS)[number];
export const DEFAULT_PRODUCT: Product = "Hakaton";
export const asProduct = (v: unknown): Product => (PRODUCTS as readonly unknown[]).includes(v) ? (v as Product) : DEFAULT_PRODUCT;

export function brandName(prefix: string | null | undefined, product: string = DEFAULT_PRODUCT): string {
  const p = (prefix ?? "").trim();
  const k = asProduct(product);
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
