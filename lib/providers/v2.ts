// zecHunt provider contracts, v2 (FROZEN at contract-freeze commit; owner: Claude).
// Codex implements these in lib/zcash and lib/bitrefill. Changes go through a
// written change request to the contract owner; never edit this file from a
// provider branch. v1 (./types.ts) stays live until both adapters pass the
// conformance suite in tests/contracts/.
//
// Rules that are part of the contract, not just comments:
//  R1  Provider responses are untrusted. Nothing returned here grants eligibility,
//      spending authority, or ownership of a reward. The app decides those.
//  R2  attemptId is OUR correlation id. It is not a provider idempotency key
//      unless Bitrefill documents one. Adapters must not claim otherwise.
//  R3  Only purchaseApprovedReward may call a money-moving provider tool, and only
//      once per attemptId, ever. Every other method is read-only.
//  R4  No method returns or throws redemption secrets, API keys, viewing keys or
//      invoice access tokens, except getRedemption. Error text must be safe to log.
//  R5  "rejected" means: we are certain no charge happened (refused before the
//      money-moving call, or the provider definitively refused it). Anything else
//      that is not a confirmed invoice is "uncertain". When in doubt: uncertain.
//  R6  Amounts are integers in minor units with an explicit currency. No floats.

export type Currency = "USD" | "INR";

export interface Money {
  /** Integer minor units: cents for USD, paise for INR. */
  amountMinor: number;
  currency: Currency;
}

// ───────────────────────────── Bitrefill ─────────────────────────────

export interface RewardCandidate {
  productId: string;
  /** Provider package/denomination id, exactly as buy-products expects it (e.g. "50"). */
  packageValue: string;
  /** Untrusted provider text. Display-escaped; never fed to a model as instructions. */
  title: string;
  category: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** What we would be charged, in the balance currency we pay from. */
  quotedPrice: Money;
  /** Face value the winner receives, when the provider states it (e.g. INR 5000 paise). */
  faceValue?: Money;
  /** True if the product needs a phone number, email or similar. v2 only buys false. */
  requiresRecipientInput: boolean;
  available: boolean;
}

/** Minted by the app's policy engine; the adapter verifies it, it never mints one. */
export interface PurchaseApprovalToken {
  approvalId: string;
  productId: string;
  packageValue: string;
  /** Hard ceiling for this one purchase, USD cents. */
  maxSpendUsdCents: number;
  /** Epoch ms. The adapter refuses an expired approval ("rejected", approval_expired). */
  expiresAt: number;
}

export interface PurchaseRequest {
  attemptId: string;
  claimId: string;
  productId: string;
  packageValue: string;
  approval: PurchaseApprovalToken;
}

export type PurchaseRejectCode =
  | "purchases_disabled"
  | "not_allowlisted"
  | "approval_mismatch"
  | "approval_expired"
  | "repriced_over_cap"
  | "unavailable"
  | "recipient_input_required"
  | "spend_ceiling_reached"
  | "duplicate_attempt"
  | "insufficient_balance"
  | "provider_refused";

export type PurchaseUncertainCode =
  | "timeout"
  | "transport_error"
  | "unparseable_response"
  | "missing_invoice_id"
  | "provider_error";

export type PurchaseResult =
  | { kind: "invoiced"; attemptId: string; invoiceId: string; status: OrderStatus; diagnosticRef?: string }
  | { kind: "uncertain"; attemptId: string; reasonCode: PurchaseUncertainCode; diagnosticRef?: string }
  | { kind: "rejected"; attemptId: string; reasonCode: PurchaseRejectCode };

/** Everything the adapter needs to look for the invoice without trusting its own memory. */
export interface ReconcileRequest {
  attemptId: string;
  claimId: string;
  productId: string;
  packageValue: string;
  quotedPrice: Money;
  /** Epoch ms when the app persisted the attempt (before the provider call). */
  startedAt: number;
  /** Invoices already linked to other attempts; never matched again. */
  excludeInvoiceIds: string[];
  /**
   * Other attempts in the APP ledger that are still unresolved (no invoice) and could
   * have produced the same kind of invoice. Bitrefill invoices carry no claim/attempt
   * id, so if any of these could explain the candidate (same product, package and
   * quoted price, started at or before the invoice), the result MUST be "ambiguous".
   * Supplied by the app so this holds even if the adapter's own ledger is lost.
   * (CR-1 from Codex, accepted 2026-11-04.)
   */
  competingAttempts: CompetingAttempt[];
}

export interface CompetingAttempt {
  attemptId: string;
  productId: string;
  packageValue: string;
  quotedPrice: Money;
  startedAt: number;
}

export type ReconciliationResult =
  | { kind: "matched"; invoiceId: string; status: OrderStatus }
  | { kind: "ambiguous"; candidateInvoiceIds: string[] }
  | { kind: "not_found" }
  /** Lookup itself failed or was truncated; try again later, nothing is concluded. */
  | { kind: "unavailable"; reasonCode: string };

export type OrderStatus = "pending" | "paid" | "delivered" | "failed" | "unknown";

export interface OrderSummary {
  status: OrderStatus;
  redemptionAvailable: boolean;
}

/** SECRET. Server-only. Never log, persist, cache, or put in a URL. */
export interface Redemption {
  /** Opaque provider redemption payload (code, link, PIN…), as display text. */
  display: string;
}

export interface BitrefillAdapterV2 {
  readonly mode: "mock" | "live";
  searchEligibleProducts(input: {
    country: string;
    category: string;
    maxSpendUsdCents: number;
  }): Promise<RewardCandidate[]>;
  /** Fresh price for exactly this package. Read-only. */
  getLiveQuote(input: { productId: string; packageValue: string }): Promise<RewardCandidate>;
  /** The only money-moving call (R3). Never throws for business outcomes; returns a PurchaseResult. */
  purchaseApprovedReward(request: PurchaseRequest): Promise<PurchaseResult>;
  /** Read-only (R3). Conservative: one unambiguous match or nothing. */
  reconcileAttempt(request: ReconcileRequest): Promise<ReconciliationResult>;
  getOrderStatus(invoiceId: string): Promise<OrderSummary>;
  /** Called only after the app verified the winner entitlement. */
  getRedemption(invoiceId: string): Promise<Redemption | null>;
}

// ─────────────────────────────── Zcash ───────────────────────────────

export type ShieldedPool = "ironwood" | "orchard" | "sapling";

export interface FundingEventV2 {
  /**
   * Stable identity across wallet rebuilds/rescans. If zkool exposes no stable note
   * id, the adapter documents and uses a verified composite (e.g. txid + pool +
   * output index). Never a wallet-local row id.
   */
  eventId: string;
  questId: string;
  txid: string;
  receivingAddress: string;
  amountZatoshis: bigint;
  pool: ShieldedPool;
  /** null while unmined. */
  blockHeight: number | null;
  confirmations: number;
  /** "invalidated" = seen before, no longer in the best chain (reorg/expiry). */
  status: "observed" | "confirmed" | "invalidated";
}

export interface WatcherHealth {
  syncedHeight: number;
  chainTipHeight: number;
  /** Epoch ms of the last scan that completed without error. */
  lastSuccessfulScanAt: number | null;
  /** Must be false. True means a spending key is loaded: refuse to run. */
  canSpend: boolean;
}

export interface ZcashAdapterV2 {
  readonly mode: "mock" | "live";
  getQuestAddress(questId: string): Promise<string>;
  /** All events for the quest, including invalidated ones, so the app can reverse credit. */
  findFunding(questId: string): Promise<FundingEventV2[]>;
  getWatcherHealth(): Promise<WatcherHealth>;
}
