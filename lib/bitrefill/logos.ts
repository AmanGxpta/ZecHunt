// Brand logos for the reward catalog, built from Bitrefill's own image ids.
//
// Source: Bitrefill REST `GET /v2/products/{id}` → `image` (an image id such as
// "2024_logos/swiggy-svg") and `logo_background` ("#FE5005"). The MCP get-product-details
// reply carries neither. Ids are stored in ./logos.generated.ts (refresh read-only with
// `node --env-file=.env.local --import tsx lib/bitrefill/refresh-logos.ts`) so the picker
// never makes a call per product.
//
// URL shape (verified 4 Nov 2026: anonymous GET returns image/png):
//   https://cdn.bitrefill.com/content/cn/b_rgb%3A<RRGGBB>%2Cc_pad%2Ch_256%2Cw_256/v1/<image id>.png
// Only https URLs on cdn.bitrefill.com survive `safeLogoUrl`; anything else is dropped.
import { CATALOG_LOGOS } from "./logos.generated";

export const LOGO_HOSTS: readonly string[] = ["cdn.bitrefill.com"];

export interface LogoSource {
  /** Bitrefill image id, e.g. "2024_logos/swiggy-svg". */
  image: string;
  /** Brand tile colour "#RRGGBB", or null for white. */
  background: string | null;
}

const IMAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*(\/[A-Za-z0-9_-]+){0,3}$/;
const COLOUR = /^#[0-9A-Fa-f]{6}$/;

/** Validates untrusted provider fields; null when either looks wrong. */
export function logoSource(image: unknown, background: unknown): LogoSource | null {
  if (typeof image !== "string" || image.length > 120 || !IMAGE_ID.test(image) || image.includes("..")) return null;
  const bg = typeof background === "string" && COLOUR.test(background) ? background.toUpperCase() : null;
  return { image, background: bg };
}

/** https only, on Bitrefill's own image host, no credentials or custom port; otherwise null. */
export function safeLogoUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !LOGO_HOSTS.includes(url.hostname)) return null;
  return url.toString();
}

export function logoUrlFor(source: LogoSource): string | null {
  const bg = (source.background ?? "#FFFFFF").slice(1);
  return safeLogoUrl(`https://cdn.bitrefill.com/content/cn/b_rgb%3A${bg}%2Cc_pad%2Ch_256%2Cw_256/v1/${source.image}.png`);
}

/** Logo for a catalog product id, or undefined (no stored id, or it failed validation). */
export function catalogLogoUrl(productId: string): string | undefined {
  const stored = CATALOG_LOGOS[productId];
  const source = stored && logoSource(stored.image, stored.background);
  return (source && logoUrlFor(source)) || undefined;
}
