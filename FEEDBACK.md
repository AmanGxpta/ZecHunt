# FEEDBACK — zecHunt @ Free Society Hack 2026

What broke, confused, or slowed us down, in the order we hit it. Each item is something we actually ran into on 4 Nov 2026.

## Bitrefill

1. **The API key showed a $0 BTC balance while the account held $25 USD.**
   `GET /v2/accounts/balance` with our key returned `{"balance": 0, "currency": "BTC"}`, the *primary* sub-account.
   The same account showed `USD 25.00` as a separate sub-account in the Bitrefill MCP `get-balances` tool.
   Nothing in the REST response hinted that other sub-accounts existed. A careful spend guard (ours) therefore concluded "no funds" and refused to buy.
   *Suggestion:* return every sub-account from the balance endpoint, or document how to select the balance currency for prices and `payment_method: "balance"`.
2. **REST and the CLI/MCP disagree on prices and currency.**
   The public CLI (`bitrefill --json get-product-details --product_id swiggy-money-india`) showed a ₹50 package priced `payment_price: "0.55" USD`.
   The REST v2 product for the same id returned `price` as integers in satoshis, e.g. `70247` for the `5000` package. The packages we printed had no `payment_currency`.
   We had to read the account's primary currency to interpret a price. That is easy to get wrong when money is involved.
3. **A product that needs a phone number can't be a "just give the winner a code" reward.**
   Airtel India ₹10 ($0.11) was the cheapest option, but it requires a recipient phone number. Some form of per-product `recipient_type` filter in search would save a round of product-details calls.
4. **Test products vs balance payments.** The docs warn that balance payments can debit real funds even for test products.
   That's correct, but it means there's no free way to rehearse a balance-paid purchase end to end. A sandbox flag on the key would help hackathon teams protect their event credit.

## Zcash (NU7 testnet)

1. **No macOS wallet binary for NU7.** zkool2 `v6.36.0` ships Linux/Android assets only. We built `zkool_graphql` from source on Apple Silicon.
2. **The source build died on disk space.** Fetching zkool2's Nym git dependency failed with `No space left on device` at ~212 MiB free. Once space was freed, the build itself took ~5 min.
   A prebuilt macOS binary, or a note about the disk needed, would have saved real time.
3. **Wallet note IDs aren't stable identities.** The same on-chain note had id `2` in the spending wallet and id `1` in a fresh watch-only wallet.
   We dedupe on `txid + receiving address` instead. A documented stable output identifier in the GraphQL API would help anyone building a payment watcher.
4. **`transactionsByAccount.value` is the account's net change**, so it's wrong for self-sends. Only summing incoming decrypted notes (`scope: 0`) gives the received amount. This is easy to misuse.
5. **What worked well:** a viewing-key-only (UFVK) account imported with a recent birthday height synced fast, decrypted incoming Ironwood notes, and refused to spend (`No Signing Key`).
   That's exactly the security property a payment watcher needs.

## Tooling / event

1. **Next.js 16 dev server blocks phones on the LAN.**
   `allowedDevOrigins` is required, `.env.local` values aren't visible inside `next.config.ts`, and the failure mode is silent: the page renders but nothing is clickable.
   We switched to a production build behind a Cloudflare tunnel.
2. The Stadium program page returned no readable content to our web reader. The `llms.txt` files were what made the rules legible to our agents. Thank you for those.

## From the team (fill in)

- Things that confused you personally:
- What you'd want on day one next time:
