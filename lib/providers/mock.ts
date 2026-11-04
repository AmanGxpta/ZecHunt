// MOCK PROVIDERS. Results from these are NOT real transactions or purchases.
// The UI and the demo must label them as mock.
import type {
  BitrefillAdapter,
  FundingEvent,
  PurchaseOrderStatus,
  RewardProduct,
  ZcashAdapter,
} from "./types";

export class MockZcashAdapter implements ZcashAdapter {
  private readonly notes = new Map<string, FundingEvent[]>();
  private counter = 0;

  async getQuestAddress(questId: string): Promise<string> {
    return `utest1mock${questId.toLowerCase()}`;
  }

  async findFunding(questId: string): Promise<FundingEvent[]> {
    return [...(this.notes.get(questId) ?? [])];
  }

  /** Test/demo hook: pretend a shielded output arrived for a quest. */
  simulateFunding(questId: string, amountZatoshis: bigint, confirmations = 1): FundingEvent {
    this.counter += 1;
    const event: FundingEvent = {
      txid: `mock-txid-${this.counter}`,
      outputId: `mock-output-${this.counter}`,
      amountZatoshis,
      confirmations,
    };
    const list = this.notes.get(questId) ?? [];
    list.push(event);
    this.notes.set(questId, list);
    return event;
  }
}

const MOCK_CATALOG: RewardProduct[] = [
  { productId: "mock-food-3", name: "Mock food voucher $3", category: "food", priceCents: 300 },
  { productId: "mock-food-5", name: "Mock food voucher $5", category: "food", priceCents: 500 },
  { productId: "mock-mobile-5", name: "Mock mobile top-up $5", category: "mobile-recharge", priceCents: 500 },
  { productId: "mock-gaming-10", name: "Mock gaming credit $10", category: "gaming", priceCents: 1000 },
];

export class MockBitrefillAdapter implements BitrefillAdapter {
  /** Invoices keyed by claimId, so a repeated purchase call returns the same invoice. */
  private readonly invoices = new Map<string, { invoiceId: string; productId: string }>();
  purchaseCalls = 0;

  async searchEligibleProducts(input: { category: string; maxPriceCents: number }) {
    return MOCK_CATALOG.filter(
      (p) => p.category === input.category && p.priceCents <= input.maxPriceCents,
    );
  }

  async purchaseApprovedReward(input: {
    claimId: string;
    productId: string;
    expectedMaxPriceCents: number;
  }) {
    this.purchaseCalls += 1;
    const existing = this.invoices.get(input.claimId);
    if (existing) return { invoiceId: existing.invoiceId, status: "pending" };
    const product = MOCK_CATALOG.find((p) => p.productId === input.productId);
    if (!product || product.priceCents > input.expectedMaxPriceCents) {
      throw new Error("mock: product unavailable or above approved price");
    }
    const invoiceId = `mock-inv-${input.claimId}`;
    this.invoices.set(input.claimId, { invoiceId, productId: input.productId });
    return { invoiceId, status: "pending" };
  }

  async getOrderStatus(invoiceId: string): Promise<PurchaseOrderStatus> {
    const known = [...this.invoices.values()].some((v) => v.invoiceId === invoiceId);
    if (!known) throw new Error(`mock: unknown invoice ${invoiceId}`);
    return {
      status: "delivered",
      redemptionData: "MOCK-REDEMPTION-NOT-A-REAL-CODE",
    };
  }
}
