// Provider conformance suite for BitrefillAdapterV2. An adapter branch is not
// mergeable until this suite passes against it (with an injected transport; no
// real money). Codex wires the live adapter in its own test file:
//   runBitrefillV2Conformance("live adapter (recorded transport)", makeHarness)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BitrefillAdapterV2, PurchaseRequest, RewardCandidate } from "../../lib/providers/v2";

export interface BitrefillV2Harness {
  adapter: BitrefillAdapterV2;
  /** Number of money-moving provider calls (buy-products) made so far. */
  moneyCalls(): number;
  /** Make the NEXT money-moving call succeed at the provider but lose its response. */
  loseNextPurchaseResponse(): void;
  /** A category/country with at least one code-only product under the cap. */
  fixture: { country: string; category: string; maxSpendUsdCents: number };
}

function request(c: RewardCandidate, attemptId: string, over: Partial<PurchaseRequest["approval"]> = {}): PurchaseRequest {
  return {
    attemptId,
    claimId: `claim-${attemptId}`,
    productId: c.productId,
    packageValue: c.packageValue,
    approval: {
      approvalId: `appr-${attemptId}`,
      productId: c.productId,
      packageValue: c.packageValue,
      maxSpendUsdCents: c.quotedPrice.amountMinor,
      expiresAt: Date.now() + 120_000,
      ...over,
    },
  };
}

export function runBitrefillV2Conformance(name: string, make: () => Promise<BitrefillV2Harness>): void {
  const first = async (h: BitrefillV2Harness) => {
    const list = await h.adapter.searchEligibleProducts(h.fixture);
    const c = list.find((x) => !x.requiresRecipientInput && x.available);
    assert.ok(c, "fixture must yield a code-only available product");
    return c;
  };

  test(`${name}: search returns integer USD quotes within the cap`, async () => {
    const h = await make();
    for (const c of await h.adapter.searchEligibleProducts(h.fixture)) {
      assert.equal(c.quotedPrice.currency, "USD");
      assert.ok(Number.isSafeInteger(c.quotedPrice.amountMinor) && c.quotedPrice.amountMinor > 0);
      assert.ok(c.quotedPrice.amountMinor <= h.fixture.maxSpendUsdCents);
      assert.equal(typeof c.packageValue, "string");
    }
    assert.equal(h.moneyCalls(), 0);
  });

  test(`${name}: expired or mismatched approvals are rejected without spending`, async () => {
    const h = await make();
    const c = await first(h);
    const expired = await h.adapter.purchaseApprovedReward(request(c, "a1", { expiresAt: Date.now() - 1 }));
    assert.deepEqual([expired.kind, expired.kind === "rejected" && expired.reasonCode], ["rejected", "approval_expired"]);
    const wrong = await h.adapter.purchaseApprovedReward(request(c, "a2", { productId: "something-else" }));
    assert.deepEqual([wrong.kind, wrong.kind === "rejected" && wrong.reasonCode], ["rejected", "approval_mismatch"]);
    const low = await h.adapter.purchaseApprovedReward(request(c, "a3", { maxSpendUsdCents: c.quotedPrice.amountMinor - 1 }));
    assert.equal(low.kind, "rejected");
    assert.equal(h.moneyCalls(), 0);
  });

  test(`${name}: one attemptId never spends twice`, async () => {
    const h = await make();
    const c = await first(h);
    const r1 = await h.adapter.purchaseApprovedReward(request(c, "b1"));
    assert.equal(r1.kind, "invoiced");
    const r2 = await h.adapter.purchaseApprovedReward(request(c, "b1"));
    assert.ok(r2.kind === "invoiced" || (r2.kind === "rejected" && r2.reasonCode === "duplicate_attempt"));
    if (r1.kind === "invoiced" && r2.kind === "invoiced") assert.equal(r2.invoiceId, r1.invoiceId);
    assert.equal(h.moneyCalls(), 1);
  });

  test(`${name}: a lost response is uncertain, then reconciles to exactly that invoice`, async () => {
    const h = await make();
    const c = await first(h);
    const startedAt = Date.now() - 1;
    h.loseNextPurchaseResponse();
    const r = await h.adapter.purchaseApprovedReward(request(c, "c1"));
    assert.equal(r.kind, "uncertain");
    assert.equal(h.moneyCalls(), 1);
    const base = { attemptId: "c1", claimId: "claim-c1", productId: c.productId, packageValue: c.packageValue, quotedPrice: c.quotedPrice, startedAt };
    const competitor = { attemptId: "c0", productId: c.productId, packageValue: c.packageValue, quotedPrice: c.quotedPrice, startedAt: startedAt - 1 };
    const contested = await h.adapter.reconcileAttempt({ ...base, excludeInvoiceIds: [], competingAttempts: [competitor] });
    assert.equal(contested.kind, "ambiguous", "an app-known competing attempt must block adoption (CR-1)");
    const found = await h.adapter.reconcileAttempt({ ...base, excludeInvoiceIds: [], competingAttempts: [] });
    assert.equal(found.kind, "matched");
    if (found.kind === "matched") {
      const again = await h.adapter.reconcileAttempt({ ...base, excludeInvoiceIds: [found.invoiceId], competingAttempts: [] });
      assert.notEqual(again.kind, "matched", "an excluded invoice must never match");
    }
    assert.equal(h.moneyCalls(), 1, "reconciliation must never buy");
  });

  test(`${name}: order status carries no redemption secret`, async () => {
    const h = await make();
    const c = await first(h);
    const r = await h.adapter.purchaseApprovedReward(request(c, "d1"));
    assert.equal(r.kind, "invoiced");
    if (r.kind !== "invoiced") return;
    const s = await h.adapter.getOrderStatus(r.invoiceId);
    assert.deepEqual(Object.keys(s).sort(), ["redemptionAvailable", "status"]);
  });
}
