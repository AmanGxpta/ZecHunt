# zechunt Bitrefill integration

Status: **live catalog verified; no invoice created and no event credit spent**. The locally configured API key returned HTTP 401 from both REST and MCP on 4 Nov 2026. A valid key and a one-use human approval are still needed for a real delivery.

## Live read-only findings, 4 Nov 2026

The official Bitrefill CLI 0.3.0 reached the production eCommerce catalog without an account:

```bash
bitrefill --json search-products --query swiggy --country IN --intent "hackathon digital food reward"
bitrefill --json get-product-details --product_id swiggy-money-india
```

`swiggy-money-india` was in stock. It is a `food` gift card with `recipient_type: none`. The ₹50 package had `payment_price: "0.55"` and `payment_currency: "USD"`; the ₹100 package was $1.10. Prices and stock can change, so the adapter fetches them again before spending. Airtel India ₹10 was $0.11 but requires a phone number, which the current `BitrefillAdapter` purchase interface cannot pass. The live adapter therefore exposes only the Swiggy ₹50 food reward.

Official API references: [eCommerce MCP](https://docs.bitrefill.com/docs/ecommerce-mcp), [MCP partner guide](https://docs.bitrefill.com/docs/mcp-partner-integration-guide), [orders](https://docs.bitrefill.com/reference/get_orders-id.md).

## Product handoff

`RestBitrefillAdapter` in `lib/bitrefill/adapter.ts` matches Claude's `BitrefillAdapter` contract. Instantiate it only on the server:

```ts
new RestBitrefillAdapter({
  apiKey: process.env.BITREFILL_API_KEY!,
  dbPath: process.env.ZECHUNT_BITREFILL_DB!,
  livePurchases: process.env.ZECHUNT_LIVE_PURCHASES === "true",
  perPurchaseCapCents: 55,
  dailyCapCents: 55,
  totalCapCents: 55,
});
```

The adapter defaults to dry run. In live mode, it returns no eligible products until a human records one unexpired approval for the exact Swiggy ₹50 reward and a maximum price. The product must be approved **before** a player claims: the current claim route selects and fulfills immediately. Keep the approval SQLite file on persistent storage and inaccessible from public routes or agent tools.

The backend must still verify a funded quest and reserve the winner before calling `purchaseApprovedReward`; the product service currently does this. The adapter independently checks the allowlist, live USD quote, per-purchase cap, daily cap, total cap, one-use approval, and unique claim. It persists a `RESERVED` attempt before MCP `buy-products` with `payment_method: "balance"` and **`balance_currency: "USD"`**, selecting the USD sub-account explicitly. An unknown purchase result is never retried automatically. Only an invoice with an order whose status is `delivered` produces redemption data. Do not log that data.

The local API key failed authentication, so the USD balance and MCP purchase call remain unverified against the dedicated account. Replace or correct the key before enabling `livePurchases`. The explicit `balance_currency` parameter is documented by Bitrefill; no live purchase has been attempted.

## Approval and spend state

The approval operation `approveOnePurchase(dbPath, maxPriceCents, expiresAt)` is deliberately separate from the player and agent interfaces. For the first live test, a human should inspect the fresh ₹50 quote, choose a maximum of 55 cents (or a higher explicit ceiling if the price moved), and run `ZECHUNT_BITREFILL_DB=<persistent path> tsx scripts/bitrefill-approve.ts swiggy-money-india:50 55` immediately before the claim. The approval expires after 15 minutes. The current test setup has **zero approvals**. The $25 event credit remains untouched.

The package is a Swiggy Money voucher; its product instructions describe adding a code and PIN to a Swiggy account and may require account KYC. The demo should mask the code and verify redemption on a supported account. The Bitrefill account and zechunt server see the purchase even though the Zcash trigger is shielded on-chain.
