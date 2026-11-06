// Product name. The organiser fills in only the prefix (e.g. "Ignite"); "DemoDay" is fixed.
export const PRODUCT = "DemoDay";

export function brandName(prefix: string | null | undefined): string {
  const p = (prefix ?? "").trim();
  return p ? `${p} ${PRODUCT}` : PRODUCT;
}

/** File-name-safe form: "Ignite_DemoDay" / "DemoDay". */
export function brandSlug(prefix: string | null | undefined): string {
  return brandName(prefix).replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
}

/** Turns a legacy full event name ("Ignite Demo Day") into its prefix ("Ignite"). */
export function prefixFromLegacyName(name: string): string {
  return name.replace(/\s*demo\s*day\s*$/i, "").trim();
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
