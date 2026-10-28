declare module "fontkit" {
  export interface Font { hasGlyphForCodePoint(cp: number): boolean }
  export function openSync(path: string): Font;
}
