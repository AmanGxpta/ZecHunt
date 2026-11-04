// zecHunt application domain contracts (owner: Claude; Codex reads only).
// Separate from provider models on purpose: nothing a provider returns is a
// domain fact until the app has checked it.

import type { Money } from "../providers/v2";

export type ClaimState =
  | "reserved"            // won the slot; no reward chosen yet
  | "choosing_reward"     // Phase 2: winner is picking among creator-approved options
  | "approved"            // policy engine minted a one-use approval for an exact product
  | "purchase_pending"    // attempt persisted; provider call in flight or invoice not delivered
  | "needs_reconciliation"// outcome unknown; NEVER re-purchased automatically
  | "fulfilled"           // invoice delivered; winner may retrieve the redemption
  | "failed"              // certain: no charge happened, or provider failed the order
  | "cancelled";          // creator/operator cancelled before any purchase

/** Allowed transitions. Anything not listed is a bug and must throw. */
export const CLAIM_TRANSITIONS: Record<ClaimState, readonly ClaimState[]> = {
  reserved: ["choosing_reward", "approved", "failed", "cancelled"],
  choosing_reward: ["approved", "failed", "cancelled"],
  approved: ["purchase_pending", "choosing_reward", "failed"], // back to choosing on reprice/expiry
  purchase_pending: ["fulfilled", "needs_reconciliation", "failed"],
  // Only reconciliation (matched) or an operator decision leaves this state.
  needs_reconciliation: ["purchase_pending", "fulfilled", "failed"],
  fulfilled: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: ClaimState, to: ClaimState): boolean {
  return CLAIM_TRANSITIONS[from].includes(to);
}

export type AttemptState =
  | "pending"          // persisted BEFORE the provider call
  | "invoiced"
  | "delivered"
  | "uncertain"        // provider said nothing we can trust; reconcile, never retry
  | "ambiguous"        // reconciliation found several candidates; operator decides
  | "rejected"         // certain no charge
  | "failed";          // provider failed the order after invoicing

export interface PurchaseAttempt {
  attemptId: string;
  claimId: string;
  approvalId: string;
  productId: string;
  packageValue: string;
  quotedPrice: Money;
  state: AttemptState;
  invoiceId: string | null;
  reasonCode: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface PurchaseApproval {
  id: string;
  claimId: string;
  productId: string;
  packageValue: string;
  maxSpendUsdCents: number;
  expiresAt: number;
  consumedAt: number | null;
}

/** Who may see a fulfilled reward. Checked server-side on every redemption read. */
export interface WinnerEntitlement {
  claimId: string;
  questId: string;
  /** Hash of the winner's session credential; the raw credential is never stored. */
  winnerSessionHash: string;
  /** Hash of an optional one-time-shown recovery key (Phase 3). */
  recoveryKeyHash: string | null;
  status: "reserved" | "fulfilled";
}

/** Structured output of the Phase 2 reward agent. A proposal, never an authorization. */
export interface RewardSelection {
  productId: string;
  packageValue: string;
  /** Short, plain-text rationale shown to the winner. */
  reason: string;
  confidence?: number;
}

/** Operator-set spend policy. Raising any value requires an explicit operator action. */
export interface SpendPolicy {
  perPurchaseUsdCents: number;
  dailyUsdCents: number;
  totalUsdCents: number;
  /** Global kill switch: when true, no approval may be minted. */
  frozen: boolean;
}
