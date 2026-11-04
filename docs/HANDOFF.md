# zecHunt Bitrefill v2 handoff — 4 Nov 2026

## Resume here

Worktree: `.worktrees/zechunt-bitrefill-phase1`, branch `feat/bitrefill-phase1`. The branch was rebased onto frozen contracts `4526eec` and `29fd381`. The accepted v1 safety commit `a4fb283` became `2d0a819` after rebase; **do not revert it**. The v2 changes described below are in the handoff commit (`git log -1` for its hash). Do not edit `lib/providers/v2.ts` or `lib/contracts/**`; Claude owns them. Read `docs/CONTRACTS.md` before editing.

The live app still uses `RestBitrefillAdapter` (v1). No real purchase is authorized for this work. Provider tests use an injected recorded transport.

## Current changes

- `lib/bitrefill/adapter.ts`: v1 reconciliation compares parsed `created_time` timestamps, allowing equivalent timezone representations.
- `tests/bitrefill-adapter.test.ts`: covers equivalent `Z` and `+00:00` timestamps.
- `lib/bitrefill/v2.ts`: new `McpBitrefillAdapterV2` beside v1. It checks app-issued approval fields and expiry, live USD quotes, a hard allowlist, recipient requirements, per-purchase/daily/total caps, and a durable SQLite attempt row keyed by `attemptId` before `buy-products`. It never reissues a buy for a prior attempt. Post-call errors return `uncertain`; pre-call policy refusals return `rejected`. Reconciliation checks list and detail fields for exact product, package, denomination currency, USD charge, balance method, payment completion, timestamp, and exclusions. Order status omits codes; `getRedemption` is separate.
- `tests/provider/bitrefill/v2.test.ts`: recorded MCP transport, five frozen conformance tests, plus price mismatch, ambiguous invoice, secret separation, and refusal/uncertainty tests.

The original live `buy-products` response was not recorded. The recorded buy reply in tests is explicitly synthetic; read-only invoice fields mirror the previously observed provider replies. See `docs/evidence/bitrefill/reconciliation-2026-11-04.md` for the earlier live read-only v1 reconciliation evidence.

## Verification already run

`node --import tsx --test tests/provider/bitrefill/v2.test.ts`: **9/9 passed** (five frozen conformance tests plus four extra tests).

`npm test`: **35/35 passed** (the project's root-level suite).

`npm run typecheck`, `npm run lint`, and `git diff --check`: **passed**.

No provider network call or purchase was made in this v2 work.

## Review and finish before handoff

1. Review `lib/bitrefill/v2.ts` for concurrency and ledger failure behavior. `reconcileAttempt` now records a match atomically in its local ledger, rebuilding a row from the app request if its own row was lost. Keep all reconciliation provider calls read-only.
2. Add tests for restart with the same SQLite file, malformed/truncated invoice history, `excludeInvoiceIds`, quote changes, approval ID reuse, spend caps, and redaction. Verify no buy call occurs on a retry after a lost response.
3. Rerun the full test suite, targeted provider tests, typecheck, lint, and `git diff --check` after further changes. Inspect `git status` for generated files.
4. Report any additional commit hash, test output, remaining limits, and contract deviations to the user/Claude. Do not merge provider code into Claude's integration branch yourself.

## Contract change request for Claude

Proposed field: `ReconcileRequest.competingAttempts` (or an equivalent app-supplied list of other unresolved attempt windows with product, package, quote and start time).

Reason: The provider invoice has no claim/attempt correlation field. If the adapter's local ledger is lost, `excludeInvoiceIds` only excludes **already linked** invoices; it cannot see another unresolved same-product attempt from the app ledger. A single exact-price invoice can then be plausible for two claims. The current adapter detects overlap only when its own ledger survives. The app must supply unresolved competing attempts for automatic reconciliation to remain conservative after adapter ledger loss.

Evidence: The real read-only invoice listing/detail expose product, denomination, created time, payment currency/amount and method, but no internal claim or attempt ID. The recorded transport's overlapping-attempt scenario demonstrates the ambiguity. Until the contract is extended, the app should avoid automatic adoption if it knows another unresolved matching attempt exists.

## Suggested skills

No special skill is required for provider implementation. Use the `handoff` skill only if another session handoff is needed. The repository `AGENTS.md` requires reading Next's bundled docs before editing Next application code; this provider branch should not edit app code.
