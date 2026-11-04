# Bitrefill MCP read-only probe — 4 Nov 2026

Purpose: learn the real reply shapes the v2 adapter needs to tell a provable refusal from an uncertain outcome. No `buy-products` call was made. The API key was read from the local env file by the probe script and never printed. Balance amounts are not recorded here.

## Calls made (all read-only)

| # | Call | Credential | Result |
|---|---|---|---|
| 1 | JSON-RPC `tools/list` | configured key | HTTP 200 |
| 2 | `tools/call get-balances {}` | configured key | HTTP 200, `isError` false |
| 3 | `tools/call get-balances {currency: "USD"}` | configured key | HTTP 200 |
| 4 | `tools/call get-balances {}` | deliberately invalid bearer string | **HTTP 401**, body `Unauthorized` |

## Findings

- **Tools exposed:** `get-product-details`, `search-products`, `buy-products`, `submit-prepayment-step`, `list-invoices`, `get-invoice-by-id`, `update-order`, `search_help_articles`, `get_help_article`, `list_help_articles`, `list-saved-fiat-cards`, `get-balances`.
- **`get-balances` input:** optional `currency` enum `USD | EUR | BTC`. The reply is TOON text, not `structuredContent`.
- **`get-balances` reply shape:** `{ balances: [{ payment_method, balance_currency, amount, amount_base, decimals, equivalent_eur{…}, primary? }], top_up: [...], agent_instructions }`. For USD: `payment_method: "balance"`, `balance_currency: "USD"`, `decimals: 2`. `amount` is a `"9.99"`-style string and `amount_base` is an integer in cents. The two agree (`amount × 10^decimals = amount_base`).
- **Authentication failure** is a bare HTTP 401 before any JSON-RPC handling. No tool runs, so a 401 on `buy-products` cannot have created an invoice.
- **`buy-products` schema** has no idempotency key, client reference or metadata field that could correlate an invoice to our `attemptId`. This confirms R2 and the need for CR-1.

## How the adapter uses this

- Before reserving an attempt, `purchaseApprovedReward` reads `get-balances {currency:"USD"}`. If `amount_base` is below the live quote, it returns `rejected / insufficient_balance` with no money-moving call. If the balance can't be read, or its shape isn't the one above, it returns `rejected / unavailable`, also without buying.
- An HTTP 401 from `buy-products` returns `rejected / provider_refused`. The ledger row is marked `REFUSED`, which is excluded from spend caps and never adopts an invoice.
- **Every other post-call failure stays `uncertain`.** That includes a tool-level `isError` reply such as "insufficient balance" after `buy-products` executed, HTTP 5xx, a timeout, and a reply with no invoice id. In those cases we can't prove that no invoice was created. The shape of a real post-execution refusal was not observed, because observing it would require a live buy.
