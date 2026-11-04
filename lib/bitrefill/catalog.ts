// zecHunt reward catalog: the server-owned hard allowlist for Bitrefill purchases.
//
// Every entry was verified read-only on 4 Nov 2026 (search-products + get-product-details,
// country IN, currency USD): code-only delivery (recipient_type "none"), in stock, a
// LISTED package (not a custom amount) priced in USD for balance payment.
// Evidence: docs/evidence/bitrefill/catalog-2026-11-04.md.
//
// Rules:
//  - Catalog text cannot add purchasable products: only entries here are buyable.
//  - `brand` is our own display text. Provider names and descriptions are untrusted and
//    never become titles.
//  - `recordedUsdCents` is the price seen at verification time, for planning and caps
//    reporting only. Spending always uses a fresh live quote.
//  - Listing here does not make a product buyable. The adapter's per-purchase, daily and
//    total caps still apply (currently $0.55 / $0.55 / $0.55).

import type { Money } from "../providers/v2";

export const CATALOG_CATEGORIES = ["food", "shopping", "gaming"] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

export interface CatalogEntry {
  productId: string;
  /** Exactly the listed package_value buy-products expects. */
  packageValue: string;
  category: CatalogCategory;
  country: "IN";
  /** Clean display brand (ours, not provider text). */
  brand: string;
  /** Face value the winner receives, as stated by the provider (package_currency). */
  faceValue: Money;
  /** USD price observed on 4 Nov 2026. Evidence only; never used to authorize spend. */
  recordedUsdCents: number;
}

type Row = [productId: string, brand: string, category: CatalogCategory, packageInr: number, recordedUsdCents: number];

// Packages chosen per category at the listed denominations closest to (and not above)
// the ₹50 / ₹100 / ₹250 / ₹400 quest tiers, plus near neighbours for choice.
const ROWS: Row[] = [
  // food
  ["swiggy-money-india", "Swiggy Money", "food", 50, 55],
  ["swiggy-money-india", "Swiggy Money", "food", 100, 110],
  ["swiggy-money-india", "Swiggy Money", "food", 250, 275],
  ["subway-india", "Subway", "food", 50, 55],
  ["subway-india", "Subway", "food", 100, 110],
  ["subway-india", "Subway", "food", 200, 220],
  ["dominos-india", "Domino's", "food", 100, 110],
  ["dominos-india", "Domino's", "food", 200, 220],
  ["kfc-india", "KFC", "food", 100, 110],
  ["kfc-india", "KFC", "food", 250, 275],
  ["pizza-hut-india", "Pizza Hut", "food", 100, 111],
  ["pizza-hut-india", "Pizza Hut", "food", 300, 331],
  ["blink-it-india", "Blinkit", "food", 250, 276],
  // shopping
  ["ajio-india", "AJIO", "shopping", 50, 55],
  ["ajio-india", "AJIO", "shopping", 100, 110],
  ["ajio-india", "AJIO", "shopping", 200, 220],
  ["flipkart-india", "Flipkart", "shopping", 50, 56],
  ["flipkart-india", "Flipkart", "shopping", 100, 112],
  ["tata-cliq-fashion-india", "Tata CLiQ Fashion", "shopping", 50, 56],
  ["tata-cliq-fashion-india", "Tata CLiQ Fashion", "shopping", 100, 111],
  ["tata-cliq-fashion-india", "Tata CLiQ Fashion", "shopping", 200, 221],
  ["westside-voucher-india", "Westside", "shopping", 100, 110],
  ["westside-voucher-india", "Westside", "shopping", 200, 220],
  ["myntra-india", "Myntra", "shopping", 250, 275],
  // gaming
  ["google-play-india", "Google Play", "gaming", 50, 57],
  ["google-play-india", "Google Play", "gaming", 100, 113],
  ["google-play-india", "Google Play", "gaming", 300, 338],
  ["unipin-voucher-india", "UniPin", "gaming", 100, 110],
  ["unipin-voucher-india", "UniPin", "gaming", 250, 275],
  ["app-store-and-itunes-inr-india", "App Store & iTunes", "gaming", 100, 119],
  ["steam-india", "Steam", "gaming", 130, 147],
  ["steam-india", "Steam", "gaming", 325, 363],
];

export const REWARD_CATALOG: readonly CatalogEntry[] = Object.freeze(ROWS.map(([productId, brand, category, inr, cents]) =>
  Object.freeze({
    productId, packageValue: String(inr), category, country: "IN" as const, brand,
    faceValue: { amountMinor: inr * 100, currency: "INR" as const }, recordedUsdCents: cents,
  })));

/** v1 product id ("<productId>:<packageValue>"); "swiggy-money-india:50" matches the v1 REWARD_ID. */
export function catalogKey(entry: { productId: string; packageValue: string }): string {
  return `${entry.productId}:${entry.packageValue}`;
}

export function findCatalogEntry(productId: string, packageValue: string,
  catalog: readonly CatalogEntry[] = REWARD_CATALOG): CatalogEntry | undefined {
  return catalog.find((e) => e.productId === productId && e.packageValue === packageValue);
}

export function findByCatalogKey(key: string, catalog: readonly CatalogEntry[] = REWARD_CATALOG): CatalogEntry | undefined {
  return catalog.find((e) => catalogKey(e) === key);
}

export function isCatalogCategory(value: string): value is CatalogCategory {
  return (CATALOG_CATEGORIES as readonly string[]).includes(value);
}

/** "₹1,000" style face value. INR only; other currencies print as "<amount> <CUR>". */
export function formatFaceValue(face: Money): string {
  const major = face.amountMinor / 100;
  const text = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(major);
  return face.currency === "INR" ? `₹${text}` : `${text} ${face.currency}`;
}

/** Winner-facing title, e.g. "Swiggy Money ₹50". Built only from our own catalog text. */
export function displayTitle(entry: CatalogEntry, face: Money = entry.faceValue): string {
  return `${entry.brand} ${formatFaceValue(face)}`;
}

/**
 * Untrusted provider text → plain display text: strips tags, decodes the few entities
 * Bitrefill uses, removes control and bidi-override characters, collapses whitespace and
 * truncates. For showing descriptions/instructions; never feed the result to a model as
 * instructions.
 */
export function sanitizeProviderText(value: unknown, maxLength = 200): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", nbsp: " " })[e] ?? "")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}
