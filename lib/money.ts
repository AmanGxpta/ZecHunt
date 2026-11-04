// Players and creators see rupees; the spend guard counts US cents, because the
// Bitrefill event credit is a USD balance. The rate is config, not a live quote.
export const INR_PER_USD = Number(process.env.ZECHUNT_INR_PER_USD ?? "88");
/** Headroom so a ₹50 voucher quoted at a slightly worse rate is still allowed. */
export const CAP_MARGIN = 0.1;
export const INR_CAPS = [50, 100, 250, 400] as const;

export function inrCapToCents(inr: number): number {
  return Math.min(500, Math.round((inr / INR_PER_USD) * 100 * (1 + CAP_MARGIN)));
}

export function centsToInr(cents: number): number {
  return Math.round((cents / 100) * INR_PER_USD);
}
