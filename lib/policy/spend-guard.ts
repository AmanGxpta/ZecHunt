// Deterministic spending guard. The only code path allowed to approve a purchase.
// An AI agent may propose a product; it never overrides these checks.

export interface SpendRequest {
  questFunded: boolean;
  winnerSlotReserved: boolean;
  /** No purchase attempt exists yet for this claim. */
  claimHasNoPurchase: boolean;
  productCategory: string;
  requiredCategory: string;
  quotedCents: number;
  rewardCapCents: number;
  creditRemainingCents: number;
}

export type GuardDecision = { ok: true } | { ok: false; reason: string };

export function checkSpend(req: SpendRequest): GuardDecision {
  if (!req.questFunded) return deny("quest_not_funded");
  if (!req.winnerSlotReserved) return deny("no_winner_slot");
  if (!req.claimHasNoPurchase) return deny("duplicate_purchase");
  if (req.productCategory !== req.requiredCategory) return deny("category_mismatch");
  if (!Number.isInteger(req.quotedCents) || req.quotedCents <= 0) return deny("invalid_quote");
  if (req.quotedCents > req.rewardCapCents) return deny("over_reward_cap");
  if (req.quotedCents > req.creditRemainingCents) return deny("insufficient_credit");
  return { ok: true };
}

function deny(reason: string): GuardDecision {
  return { ok: false, reason };
}
