# Bitrefill reconciliation evidence — 4 Nov 2026

This check made **read-only** MCP calls against the authenticated Bitrefill USD account. It did not call `buy-products` or change the application database. A temporary local SQLite ledger was deleted after the check.

## Provider fields observed

The existing delivered invoice `3923a98e-e06e-4775-b8ea-d0db067a3683` appeared in `list-invoices` with one order: `swiggy-money-india`, value `50`, currency `INR`. `get-invoice-by-id` returned the same invoice and creation time, a single matching product order, `payment_method: balance`, and payment information with method `balance`, currency `USD`, price `0.55`, status `complete`. The invoice and order were delivered. Both MCP replies used SSE JSON-RPC and TOON text content. The account identity is established by the configured authenticated MCP credential; neither reply exposes a separate account ID for stronger correlation.

The original `buy-products` reply was not recorded. Its exact failed envelope cannot be reconstructed without another purchase. The adapter accepts the documented nested `response.invoice_id`, but that remains a defensive parsing fix rather than proof of the original failure's precise cause.

## Recovery check

An isolated `RESERVED` attempt for the exact product and a 55-cent quote was reconciled through the adapter against the existing invoice. It returned `complete` and the expected invoice ID. A fetch guard rejected any `buy-products` call; the observed purchase-call count was **zero**. No voucher code, access token, API key, or raw response was saved here.

Provider matching now requires one candidate in complete invoice history, created after the reservation, with the exact product, denomination, and denomination currency. The detailed invoice must confirm the same identity, balance payment, USD currency, completed payment, and exact 55-cent charge. A second unresolved same-product attempt whose reservation predates the candidate makes the association ambiguous and blocks automatic adoption. Missing, multiple, incomplete, or mismatched results remain unresolved for operator review.

## Limits

This is a live read-only reconciliation of an already delivered order using a synthetic isolated ledger. It does not establish that the application worker survives a real crash or restores the winner's entitlement; those are application-owned acceptance checks. It also cannot prove a unique claim association when Bitrefill provides no claim correlation field and multiple plausible purchases overlap.
