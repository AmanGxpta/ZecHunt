# Provider integration guide

Product code depends only on `lib/providers/types.ts` (committed on `main`).
Provider owners implement those interfaces. Business logic does not change when a mock is swapped for a live adapter.

| Area | Owner | Files |
| --- | --- | --- |
| App, API, DB, claims, guard, workers | Claude (`feat/product`) | `app/`, `components/`, `lib/{db,quests,policy,providers/index,providers/mock,client}`, `workers/` |
| Zcash | Codex (`feat/zechunt-zcash`) | `lib/zcash/`, Zcash scripts and tests |
| Bitrefill | Codex (`feat/bitrefill`) | `lib/bitrefill/`, Bitrefill scripts and tests |

## Zcash: wired

`lib/providers/index.ts` builds `ZkoolZcashAdapter` when `ZECHUNT_ZCASH_MODE=live`.

```bash
# 1. zkool_graphql running with the WATCH-ONLY account (see docs/ZCASH_SPIKE.md)
# 2. .env.local:
ZECHUNT_ZCASH_MODE=live
ZECHUNT_ZKOOL_ACCOUNT_ID=<watch-only account id>
# 3. run web + worker
npm run dev            # or: npm run build && npm start
npm run worker         # scans awaiting_funding quests every 15 s
```

How the app uses the adapter:
- `getQuestAddress(questId)` runs once per quest at creation. The address is stored on the quest.
- `findFunding(questId)` runs from the worker, and from the creator dashboard's poll with at most one scan per quest per process.
  Events are upserted by `outputId` (`funding_events.output_id` is the primary key), so repeated scans never double-count.
- A quest activates when the sum of events with `confirmations >= 1` reaches `expected_zatoshis` (0.01 TAZ).
- The worker never holds a spending key.

**Gate 2 acceptance:** create a quest in live mode, send 0.01 TAZ to the shown address, and watch the dashboard flip to *Funded privately*. The dashboard shows the explorer link for the txid.

## Bitrefill: contract for the Codex Bitrefill session

Create `lib/bitrefill/index.ts` exporting:

```ts
export function createBitrefillAdapter(): BitrefillAdapter // from lib/providers/types
```

Requirements the product already relies on:
1. **`searchEligibleProducts({ country, category, maxPriceCents })`** returns only purchasable products, with `priceCents` as the *current* integer USD-cent price. `category` is one of `food | mobile-recharge | gaming`. Map these to Bitrefill categories inside your adapter. The agent's product choice belongs here, or in a `selectReward` replacement inside `lib/bitrefill`.
2. **`purchaseApprovedReward({ claimId, productId, expectedMaxPriceCents })`**
   - It is only called after the deterministic guard approves and after a `PURCHASE_PENDING` row is committed.
   - It must refuse if the live price is above `expectedMaxPriceCents`.
   - It must be idempotent per `claimId`: a repeat call returns the same invoice, and you can pass `claimId` as Bitrefill's idempotency/reference if supported.
   - It throws on any uncertain outcome. The app then marks the attempt `NEEDS_RECONCILIATION` and **never retries automatically**.
   - It must default to dry-run unless explicitly enabled (e.g. `BITREFILL_ALLOW_REAL_PURCHASES=1`).
3. **`getOrderStatus(invoiceId)`** returns `status` normalised to `pending | delivered | failed`. `redemptionData` must only be returned when delivered. The app never stores or logs it; it fetches it live for the winner's session only.

Global guard (already enforced in `lib/policy/spend-guard.ts` and `fulfillClaim`): the per-quest cap is at most $5, and the sum of all non-failed attempts stays at or below `BITREFILL_CREDIT_USD`.

Wiring at integration: replace `liveBitrefill()` in `lib/providers/index.ts` with `createBitrefillAdapter()`.

**Gate 3 acceptance:** catalog smoke test, an over-cap refusal with zero purchase calls, and one manually approved real purchase with an invoice ID.
