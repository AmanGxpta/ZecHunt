import type { RewardProduct } from "./types";

/**
 * Deterministic reward selection: the most valuable eligible product within the cap.
 * Replace with an agent proposal later; the spend guard still decides.
 */
export function selectReward(
  products: RewardProduct[],
  constraints: { category: string; maxPriceCents: number },
): RewardProduct | null {
  const eligible = products
    .filter(
      (p) =>
        (constraints.category === "any" || p.category === constraints.category) &&
        Number.isInteger(p.priceCents) &&
        p.priceCents > 0 &&
        p.priceCents <= constraints.maxPriceCents,
    )
    .sort((a, b) => b.priceCents - a.priceCents || a.productId.localeCompare(b.productId));
  return eligible[0] ?? null;
}
