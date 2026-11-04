// Shared provider contracts for zecHunt. Product code (Claude) depends only on
// these; provider adapters (Codex: lib/zcash, lib/bitrefill) implement them.
// Change only by agreement between owners.
// Product code depends only on these interfaces; mocks live beside them,
// and live implementations must satisfy the same shapes.

export interface FundingEvent {
  txid: string;
  /** Stable, wallet-independent funding identity used to deduplicate.
   *  The zkool adapter emits `${txid}:${questAddress}` (one event per tx+address). */
  outputId: string;
  amountZatoshis: bigint;
  confirmations: number;
}

export interface ZcashAdapter {
  /** Dedicated shielded receiving address for a quest (utest1... on testnet). */
  getQuestAddress(questId: string): Promise<string>;
  /** Decrypted, received notes for this quest's address that the wallet may view. */
  findFunding(questId: string): Promise<FundingEvent[]>;
}

export interface RewardProduct {
  productId: string;
  name: string;
  category: string;
  /** What we pay, USD cents. */
  priceCents: number;
  /** What the winner receives, when the provider states it (CR-4), e.g. INR 5000 paise. */
  faceValue?: { amountMinor: number; currency: "INR" | "USD" };
  /** Brand logo. https only, from the provider's own image host; the UI shows it as an <img>. */
  imageUrl?: string;
}

/**
 * Thrown by purchaseApprovedReward ONLY when it is certain no money moved (refused before
 * the money-moving call, or definitively refused by the provider). The app fails the claim
 * cleanly. Any other error means the outcome is unknown: reconcile, never retry.
 */
export class PurchaseRejectedError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Purchase refused before any charge: ${reasonCode}`);
    this.name = "PurchaseRejectedError";
  }
}

export interface PurchaseOrderStatus {
  /** Normalised: "pending" | "delivered" | "failed". */
  status: string;
  /** Secret. Never log, never persist in plaintext, show only to the winner. */
  redemptionData?: string;
}

export interface BitrefillAdapter {
  searchEligibleProducts(input: {
    /** ISO country code, e.g. "IN". */
    country: string;
    category: string;
    maxPriceCents: number;
  }): Promise<RewardProduct[]>;
  /** Must be idempotent per claimId: a repeat call returns the same invoice. */
  purchaseApprovedReward(input: {
    claimId: string;
    productId: string;
    expectedMaxPriceCents: number;
  }): Promise<{ invoiceId: string; status: string }>;
  getOrderStatus(invoiceId: string): Promise<PurchaseOrderStatus>;
  /**
   * Optional. Finds the provider invoice for a purchase whose outcome was uncertain.
   * MUST NOT buy. Throws when it cannot match exactly one invoice.
   */
  reconcilePurchase?(claimId: string): Promise<{ invoiceId: string; status: string }>;
}

export interface Providers {
  mode: "mock" | "live";
  zcash: ZcashAdapter;
  bitrefill: BitrefillAdapter;
}
