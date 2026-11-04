// MOCK v2 Bitrefill provider. Reference implementation of the v2 contract for
// tests and the conformance suite. Results are NOT real purchases.
import type {
  BitrefillAdapterV2,
  OrderSummary,
  PurchaseRequest,
  PurchaseResult,
  ReconcileRequest,
  ReconciliationResult,
  Redemption,
  RewardCandidate,
} from "./v2";

const CATALOG: RewardCandidate[] = [
  { productId: "mock-swiggy", packageValue: "50", title: "Mock food voucher ₹50", category: "food", country: "IN",
    quotedPrice: { amountMinor: 55, currency: "USD" }, faceValue: { amountMinor: 5000, currency: "INR" }, requiresRecipientInput: false, available: true },
  { productId: "mock-zomato", packageValue: "100", title: "Mock food voucher ₹100", category: "food", country: "IN",
    quotedPrice: { amountMinor: 115, currency: "USD" }, faceValue: { amountMinor: 10000, currency: "INR" }, requiresRecipientInput: false, available: true },
  { productId: "mock-airtel", packageValue: "10", title: "Mock mobile top-up ₹10", category: "mobile-recharge", country: "IN",
    quotedPrice: { amountMinor: 11, currency: "USD" }, requiresRecipientInput: true, available: true },
];

interface MockInvoice { invoiceId: string; productId: string; packageValue: string; createdAt: number }

export class MockBitrefillAdapterV2 implements BitrefillAdapterV2 {
  readonly mode = "mock" as const;
  moneyCalls = 0;
  private loseNext = false;
  private seq = 0;
  private readonly invoices: MockInvoice[] = [];
  private readonly byAttempt = new Map<string, string | null>();

  loseNextPurchaseResponse(): void { this.loseNext = true; }

  async searchEligibleProducts(input: { country: string; category: string; maxSpendUsdCents: number }): Promise<RewardCandidate[]> {
    return CATALOG.filter((c) => c.country === input.country && c.category === input.category &&
      c.quotedPrice.amountMinor <= input.maxSpendUsdCents).map((c) => ({ ...c }));
  }

  async getLiveQuote(input: { productId: string; packageValue: string }): Promise<RewardCandidate> {
    const c = CATALOG.find((x) => x.productId === input.productId && x.packageValue === input.packageValue);
    return c ? { ...c } : { ...CATALOG[0], productId: input.productId, packageValue: input.packageValue, available: false };
  }

  async purchaseApprovedReward(req: PurchaseRequest): Promise<PurchaseResult> {
    const { attemptId, approval } = req;
    if (this.byAttempt.has(attemptId)) {
      const inv = this.byAttempt.get(attemptId);
      return inv ? { kind: "invoiced", attemptId, invoiceId: inv, status: "delivered" } : { kind: "rejected", attemptId, reasonCode: "duplicate_attempt" };
    }
    if (approval.productId !== req.productId || approval.packageValue !== req.packageValue) {
      return { kind: "rejected", attemptId, reasonCode: "approval_mismatch" };
    }
    if (approval.expiresAt <= Date.now()) return { kind: "rejected", attemptId, reasonCode: "approval_expired" };
    const quote = await this.getLiveQuote(req);
    if (!quote.available) return { kind: "rejected", attemptId, reasonCode: "unavailable" };
    if (quote.requiresRecipientInput) return { kind: "rejected", attemptId, reasonCode: "recipient_input_required" };
    if (quote.quotedPrice.amountMinor > approval.maxSpendUsdCents) return { kind: "rejected", attemptId, reasonCode: "repriced_over_cap" };

    this.byAttempt.set(attemptId, null); // reserved before the money call
    this.moneyCalls += 1;
    const invoiceId = `mock-inv-${++this.seq}`;
    this.invoices.push({ invoiceId, productId: req.productId, packageValue: req.packageValue, createdAt: Date.now() });
    if (this.loseNext) {
      this.loseNext = false;
      return { kind: "uncertain", attemptId, reasonCode: "missing_invoice_id" };
    }
    this.byAttempt.set(attemptId, invoiceId);
    return { kind: "invoiced", attemptId, invoiceId, status: "delivered" };
  }

  async reconcileAttempt(req: ReconcileRequest): Promise<ReconciliationResult> {
    const hits = this.invoices.filter((i) => i.productId === req.productId && i.packageValue === req.packageValue &&
      i.createdAt >= req.startedAt && !req.excludeInvoiceIds.includes(i.invoiceId));
    if (hits.length === 0) return { kind: "not_found" };
    if (hits.length > 1) return { kind: "ambiguous", candidateInvoiceIds: hits.map((h) => h.invoiceId) };
    return { kind: "matched", invoiceId: hits[0].invoiceId, status: "delivered" };
  }

  async getOrderStatus(invoiceId: string): Promise<OrderSummary> {
    const known = this.invoices.some((i) => i.invoiceId === invoiceId);
    return { status: known ? "delivered" : "unknown", redemptionAvailable: known };
  }

  async getRedemption(invoiceId: string): Promise<Redemption | null> {
    return this.invoices.some((i) => i.invoiceId === invoiceId) ? { display: "MOCK-REDEMPTION-NOT-A-REAL-CODE" } : null;
  }
}
