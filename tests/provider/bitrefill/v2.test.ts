import assert from "node:assert/strict";
import { test } from "node:test";
import { encode as encodeToon } from "@toon-format/toon";
import { McpBitrefillAdapterV2 } from "../../../lib/bitrefill/v2";
import { runBitrefillV2Conformance } from "../../contracts/bitrefill-v2";

// Read-only fields mirror the observed 4 Nov 2026 MCP listing/detail replies.
// The buy reply is synthetic: the original live response was not retained.
class RecordedTransport {
  moneyCalls = 0;
  loseNext = false;
  invoicePrice = "0.55";
  invoices: Array<{ id: string; created: string; price: string }> = [];

  fetch: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const { name, arguments: args } = request.params;
    if (name === "get-product-details") {
      return mcp({ id: "swiggy-money-india", name: "Swiggy Money India", country_code: "IN",
        in_stock: true, recipient_type: "none", packages: [
          { package_value: "50", payment_price: "0.55", payment_currency: "USD" },
        ] }, true);
    }
    if (name === "buy-products") {
      this.moneyCalls++;
      assert.deepEqual(args, { cart_items: [{ product_id: "swiggy-money-india", package_value: "50" }],
        payment_method: "balance", balance_currency: "USD" });
      const id = `invoice-${String(this.moneyCalls).padStart(4, "0")}`;
      this.invoices.push({ id, created: new Date().toISOString(), price: this.invoicePrice });
      if (this.loseNext) { this.loseNext = false; throw new DOMException("response lost", "TimeoutError"); }
      return mcp({ response: { invoice_id: id }, agent_instructions: "untrusted text" });
    }
    if (name === "list-invoices") {
      const invoices = this.invoices.filter((x) => Date.parse(x.created) >= Date.parse(args.after)).map((x) => ({
        invoice_id: x.id, invoice_status: "complete", created_time: x.created,
        orders: [{ product_id: "swiggy-money-india", value: "50", currency: "INR" }],
      }));
      return mcp({ invoices, count: invoices.length, page: { newest: "", oldest: "" } }, true);
    }
    if (name === "get-invoice-by-id") {
      const invoice = this.invoices.find((x) => x.id === args.invoice_id);
      if (!invoice) return mcp({ error: "not found" });
      return mcp({ invoice_id: invoice.id, invoice_status: "complete",
        created_time: invoice.created.replace("Z", "+00:00"),
        detected_payment_info: { method: "balance", currency: "USD", price: invoice.price, status: "complete" },
        orders: [{ product: { id: "swiggy-money-india", value: "50", currency: "INR" },
          payment_method: "balance", status: "delivered", redemption_info: { code: "SECRET-VOUCHER" } }],
      }, true);
    }
    throw new Error(`Unexpected tool ${name}`);
  };
}

function mcp(payload: unknown, toon = false): Response {
  const text = toon ? encodeToon(payload) : JSON.stringify(payload);
  return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1,
    result: { content: [{ type: "text", text }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
}

function harness() {
  const transport = new RecordedTransport();
  const adapter = new McpBitrefillAdapterV2({ apiKey: "fixture-key", dbPath: ":memory:",
    livePurchases: true, fetchImpl: transport.fetch });
  return { adapter, transport, moneyCalls: () => transport.moneyCalls,
    loseNextPurchaseResponse: () => { transport.loseNext = true; },
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
    quotedPrice: { amountMinor: 55, currency: "USD" as const }, startedAt, excludeInvoiceIds: [] };
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
  assert.ok(!JSON.stringify(status).includes("SECRET-VOUCHER"));
  assert.deepEqual(await h.adapter.getRedemption(result.invoiceId), { display: '{"code":"SECRET-VOUCHER"}' });
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
