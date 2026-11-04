import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approveOnePurchase, RestBitrefillAdapter, usdToCents } from "../lib/bitrefill/adapter";

test("USD prices are exact cents", () => {
  assert.equal(usdToCents("0.55"), 55);
  assert.equal(usdToCents("5"), 500);
  assert.throws(() => usdToCents("0.555"));
});

test("a one-use approval permits one purchase and duplicate claims reuse its invoice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zechunt-bitrefill-test-"));
  const dbPath = join(dir, "purchase.db");
  let posts = 0;
  const fakeFetch: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    let data: unknown;
    if (path.endsWith("/mcp")) {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.method, "tools/call");
      const tool = request.params;
      if (tool.name === "get-product-details") {
        assert.deepEqual(tool.arguments, { product_id: "swiggy-money-india", currency: "USD" });
        data = { id: "swiggy-money-india", name: "Swiggy Money India", country_code: "IN",
          in_stock: true, recipient_type: "none", packages: [
            { package_value: "50", payment_price: "0.55", payment_currency: "USD" },
          ] };
      } else if (tool.name === "buy-products") {
        posts++;
        assert.deepEqual(tool.arguments, {
          cart_items: [{ product_id: "swiggy-money-india", package_value: "50" }],
          payment_method: "balance", balance_currency: "USD",
        });
        data = { invoice_id: "invoice-1234", status: "pending" };
      } else throw new Error(`Unexpected tool: ${tool.name}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(data) }] } }),
      { headers: { "content-type": "application/json" } });
    } else if (path.endsWith("/invoices/invoice-1234")) {
      data = { id: "invoice-1234", status: "complete", orders: [{ id: "order-1234", status: "delivered" }] };
    } else if (path.endsWith("/orders/order-1234")) {
      data = { status: "delivered", redemption_info: { code: "TEST-ONLY" } };
    } else throw new Error(`Unexpected request: ${path}`);
    return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
  };

  const adapter = new RestBitrefillAdapter({
    apiKey: "test-key", dbPath, livePurchases: true, accountPricesAreUsd: true, fetchImpl: fakeFetch,
  });
  try {
    assert.deepEqual(await adapter.searchEligibleProducts({ country: "IN", category: "food", maxPriceCents: 100 }), []);
    approveOnePurchase(dbPath, 55, Date.now() + 60_000);
    assert.deepEqual(await adapter.searchEligibleProducts({ country: "IN", category: "food", maxPriceCents: 54 }), []);
    assert.deepEqual(await adapter.searchEligibleProducts({ country: "US", category: "food", maxPriceCents: 55 }), []);
    const eligible = await adapter.searchEligibleProducts({ country: "IN", category: "food", maxPriceCents: 55 });
    assert.deepEqual(eligible, [{ productId: "swiggy-money-india:50", name: "Swiggy Money ₹50", category: "food", priceCents: 55 }]);
    await assert.rejects(adapter.purchaseApprovedReward({ claimId: "claim-1", productId: eligible[0].productId, expectedMaxPriceCents: 54 }), /price exceeds/);
    assert.equal(posts, 0);
    const first = await adapter.purchaseApprovedReward({ claimId: "claim-1", productId: eligible[0].productId, expectedMaxPriceCents: 55 });
    assert.equal(first.invoiceId, "invoice-1234");
    const repeated = await adapter.purchaseApprovedReward({ claimId: "claim-1", productId: eligible[0].productId, expectedMaxPriceCents: 55 });
    assert.equal(repeated.invoiceId, first.invoiceId);
    assert.equal(posts, 1);
    assert.equal((await adapter.getOrderStatus(first.invoiceId)).status, "delivered");
    await assert.rejects(adapter.purchaseApprovedReward({ claimId: "claim-2", productId: eligible[0].productId, expectedMaxPriceCents: 55 }), /approval/);
  } finally {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed invoice call leaves an uncertain reservation and is never retried", async () => {
  let posts = 0;
  const fakeFetch: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/mcp")) {
      const tool = JSON.parse(String(init?.body)).params.name;
      if (tool === "get-product-details") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({
          id: "swiggy-money-india", country_code: "IN", in_stock: true, recipient_type: "none",
          packages: [{ package_value: "50", payment_price: "0.55", payment_currency: "USD" }],
        }) }] } }));
      if (tool === "buy-products") { posts++; throw new Error("network outcome unknown"); }
    }
    throw new Error("Unexpected request");
  };
  const dir = mkdtempSync(join(tmpdir(), "zechunt-bitrefill-test-"));
  const dbPath = join(dir, "purchase.db");
  approveOnePurchase(dbPath, 55, Date.now() + 60_000);
  const adapter = new RestBitrefillAdapter({ apiKey: "test-key", dbPath, livePurchases: true, accountPricesAreUsd: true, fetchImpl: fakeFetch });
  try {
    const input = { claimId: "claim-uncertain", productId: "swiggy-money-india:50", expectedMaxPriceCents: 55 };
    await assert.rejects(adapter.purchaseApprovedReward(input), /outcome unknown/);
    await assert.rejects(adapter.purchaseApprovedReward(input), /uncertain/);
    assert.equal(posts, 1);
  } finally {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
