import assert from "node:assert/strict";
import { test } from "node:test";
import { McpBitrefillAdapterV2 } from "../../../lib/bitrefill/v2";
import { runBitrefillV2Conformance } from "../../contracts/bitrefill-v2";
import { FIXTURE_CODE, FIXTURE_KEY, RecordedTransport } from "./transport";

function harness() {
  const transport = new RecordedTransport();
  const adapter = new McpBitrefillAdapterV2({ apiKey: FIXTURE_KEY, dbPath: ":memory:",
    livePurchases: true, fetchImpl: transport.fetch });
  return { adapter, transport, moneyCalls: () => transport.moneyCalls,
    loseNextPurchaseResponse: () => { transport.nextBuyMode = "lose"; },
    fixture: { country: "IN", category: "food", maxSpendUsdCents: 55 } };
}

runBitrefillV2Conformance("Bitrefill v2 (recorded MCP transport)", async () => harness());

function purchase(attemptId: string, maxSpendUsdCents = 55) {
  return { attemptId, claimId: `claim-${attemptId}`, productId: "swiggy-money-india", packageValue: "50",
    approval: { approvalId: `approval-${attemptId}`, productId: "swiggy-money-india", packageValue: "50",
      maxSpendUsdCents, expiresAt: Date.now() + 60_000 } };
}

function reconcile(attemptId: string, startedAt: number) {
  return { attemptId, claimId: `claim-${attemptId}`, productId: "swiggy-money-india", packageValue: "50",
    quotedPrice: { amountMinor: 55, currency: "USD" as const }, startedAt, excludeInvoiceIds: [], competingAttempts: [] };
}

test("v2 refuses a same-product invoice charged at a different price", async () => {
  const h = harness();
  h.transport.invoicePrice = "0.60";
  const start = Date.now() - 1;
  h.loseNextPurchaseResponse();
  assert.equal((await h.adapter.purchaseApprovedReward(purchase("price"))).kind, "uncertain");
  assert.deepEqual(await h.adapter.reconcileAttempt(reconcile("price", start)), { kind: "not_found" });
  assert.equal(h.moneyCalls(), 1);
  h.adapter.close();
});

test("v2 reports two matching invoices as ambiguous and never buys during lookup", async () => {
  const h = harness();
  const start = Date.now() - 1;
  for (const id of ["one", "two"]) {
    h.loseNextPurchaseResponse();
    assert.equal((await h.adapter.purchaseApprovedReward(purchase(id))).kind, "uncertain");
  }
  const result = await h.adapter.reconcileAttempt(reconcile("one", start));
  assert.equal(result.kind, "ambiguous");
  assert.equal(h.moneyCalls(), 2);
  h.adapter.close();
});

test("v2 never returns redemption data in order status", async () => {
  const h = harness();
  const result = await h.adapter.purchaseApprovedReward(purchase("redemption"));
  assert.equal(result.kind, "invoiced");
  if (result.kind !== "invoiced") return;
  const status = await h.adapter.getOrderStatus(result.invoiceId);
  assert.deepEqual(status, { status: "delivered", redemptionAvailable: true });
  assert.ok(!JSON.stringify(status).includes(FIXTURE_CODE));
  assert.deepEqual(await h.adapter.getRedemption(result.invoiceId), { display: JSON.stringify({ code: FIXTURE_CODE }) });
  h.adapter.close();
});

test("v2 pre-buy cap refusal is rejected and a lost response remains uncertain on repeat", async () => {
  const h = harness();
  assert.deepEqual(await h.adapter.purchaseApprovedReward(purchase("low", 54)),
    { kind: "rejected", attemptId: "low", reasonCode: "repriced_over_cap" });
  h.loseNextPurchaseResponse();
  const first = await h.adapter.purchaseApprovedReward(purchase("lost"));
  const repeated = await h.adapter.purchaseApprovedReward(purchase("lost"));
  assert.equal(first.kind, "uncertain");
  assert.equal(repeated.kind, "uncertain");
  assert.equal(h.moneyCalls(), 1);
  h.adapter.close();
});
