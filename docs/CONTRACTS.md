# Contracts v2: compatibility report and freeze (Mission C1, step 1)

Baseline: tag `mvp-v1` (= `main` @ 66d7892). Contract owner: Claude. Codex proposes changes in writing; it does not edit these files.

| File | What |
|---|---|
| `lib/providers/v2.ts` | `BitrefillAdapterV2`, `ZcashAdapterV2`, `Money`, `PurchaseResult`, `ReconciliationResult`, rules R1–R6 |
| `lib/contracts/domain.ts` | `ClaimState` + allowed transitions, `PurchaseAttempt`, `PurchaseApproval`, `WinnerEntitlement`, `RewardSelection`, `SpendPolicy` |
| `lib/providers/mock-v2.ts` | Reference mock implementation |
| `tests/contracts/bitrefill-v2.ts` | **Conformance suite.** An adapter branch can't merge until it passes this suite through an injected transport (no real money). |

v1 (`lib/providers/types.ts`) keeps running the live app until both v2 adapters pass conformance and the app is switched over.

## What already exists (the roadmap assumes some of this is missing)

| Roadmap item | Status at `mvp-v1` |
|---|---|
| Purchase intent persisted before the provider call | **Done**: `purchase_attempts` row `PURCHASE_PENDING` inside the guard transaction |
| Uncertain outcome never retried | **Done**: `NEEDS_RECONCILIATION`; reconciler flags stale `PURCHASE_PENDING` after 60 s |
| `list-invoices` reconciliation | **Done, narrow**: 61fd31f/66d7892. Matches on product + time + single order. Verified read-only against the real invoice. |
| Redemption never stored | **Done**: re-fetched from Bitrefill on each winner poll (`app/api/quests/[id]/claim/route.ts`), so a worker restart already loses nothing **as long as the winner keeps their cookie** |
| One purchase per claim | **Done, twice**: app (`purchase_attempts` PK = claim_id) and adapter (`bitrefill_attempts` PK = claim_id) |

## Gaps found in the code (v2 addresses each one)

1. **BUG: certain refusals are recorded as uncertain.** The v1 adapter *throws* for everything, including refusals made before any money call: dry run, not allowlisted, repriced over cap, no approval, spend ceiling. `fulfillClaim` turns every throw into `NEEDS_RECONCILIATION`. So a winner whose reward was simply over the cap ends up frozen with "reconciling" forever, instead of a clean failure.
   → v2 `PurchaseResult` = `invoiced | uncertain | rejected`, and R5 says *when in doubt, uncertain*.
2. **Two ledgers, no shared id.** The app and the adapter each keep their own attempts table keyed by `claim_id`, in different databases, with different state vocabularies (`PURCHASE_PENDING…` vs `RESERVED`/provider status).
   → `attemptId` is minted by the app and passed through. The adapter keeps its own cap ledger as a second, independent guard (defense in depth), keyed by `attemptId`.
3. **The approval is minted inside the adapter.** `approveOnePurchase()` writes to the adapter's database, and it's bound only to a price (`reward_id` is hard-coded).
   → v2 `PurchaseApprovalToken` is minted by the app's policy engine, bound to product + package + USD ceiling + expiry. The adapter verifies it and never mints one.
4. **Implicit currency.** `priceCents` is "USD, we think"; this is the REST/MCP price disagreement in FEEDBACK.md.
   → `Money { amountMinor, currency }`, with optional `faceValue` in INR.
5. **`getOrderStatus` returns the redemption secret** next to a status anyone might log.
   → It is split: `getOrderStatus` (no secrets; asserted by conformance) and `getRedemption` (server-only, called only after the entitlement check).
6. **Reconciliation input lives in adapter memory.** If the adapter DB is lost, so is the evidence.
   → `ReconcileRequest` carries product, package, price, start time and `excludeInvoiceIds` from the app's own ledger. The result adds `unavailable` (lookup failed or truncated; nothing concluded), separate from `not_found`.
7. **Winner entitlement = raw cookie value.** `playerSession()` accepts any client-supplied 8–64 char value (fixation-friendly), and new ids are 72 bits.
   → The `WinnerEntitlement` stores a *hash* of the session credential. C1 will raise new ids to 128 bits and reject ids the server didn't issue (signed cookie). Recovery key = Phase 3.
8. **Funding identity.** `outputId = txid:address` *sums* all notes in a tx to that address, so a multi-output tx is credited once with the correct total. That is not the collision the roadmap fears. But it can't represent invalidation (reorg) and isn't per-note.
   → `FundingEventV2.eventId` + `status: invalidated` + `pool` + `blockHeight`; `getWatcherHealth()` with `canSpend` (must be false).
9. **Claim state vocabulary.** `delivered` in the DB becomes `fulfilled` in the domain; `choosing_reward`, `approved` and `cancelled` are added. This is a DB migration (C1 step 2), and the old values are mapped, not dropped.

## Hand-off to Codex (the frozen interface it implements)

- **X1 (Bitrefill):** implement `BitrefillAdapterV2` next to the v1 class. Don't modify the v1 class, which the live app still uses.
  - Reuse your nested-`response` parsing and `list-invoices` logic.
  - Match on product **and** package **and** price, plus any correlation field the real envelope actually has. Document which fields exist.
  - Wire `runBitrefillV2Conformance` to a recorded transport in `tests/provider/bitrefill/`.
- **X2 (Zcash):** implement `ZcashAdapterV2`. Find out whether zkool exposes a stable per-note identity (pool + output index?), and document it before using it.
- **Change requests** go to the contract owner as a short note: field, reason, evidence.

## Next (C1 step 2, Claude, in parallel with X1/X2)

1. Migration to `attempt_id` and the new states, run on a **copy** of the live DB first.
2. App-minted approvals plus a `SpendPolicy` freeze switch.
3. Hashed winner entitlement and signed player cookie.
4. Rejected-vs-uncertain handling, behind a v1→v2 shim so the live app keeps working.
5. Restart-recovery and duplicate-purchase tests.

## Change log

- **CR-1 (accepted 2026-11-04, proposed by Codex):** `ReconcileRequest.competingAttempts` is required. The app passes its other unresolved attempts that match on product, package and price. If any of them started at or before the candidate invoice, the result must be `ambiguous`, so reconciliation stays conservative even when the adapter's own ledger is lost. The conformance suite asserts this.
