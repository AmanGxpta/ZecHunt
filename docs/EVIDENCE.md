# Evidence checklist

Only tick an item with real provider evidence. Mock runs do not count.

| # | Evidence | Status | Reference |
| - | --- | --- | --- |
| 1 | Real shielded testnet tx to a quest address | ✅ at adapter level (Codex spike) | `800e91d9394467ac3483d57b60e00c7547fbe2b3c10a0b7db1d11afd95f1546d` (docs/ZCASH_SPIKE.md) |
| 2 | Receiving watch-only wallet decrypted it | ✅ at adapter level | docs/ZCASH_SPIKE.md |
| 3 | Quest moved `awaiting_funding → active` from a real tx | ✅ in the running app (quest "DGS", 4 Nov 18:4x IST), plus Codex service smoke | app: `c1e3d85793b034160d4caec10ae7d33e01f556c34a9ee96410f0aa523dce1486` · smoke: `5ebb0957b12c7c6ce2ca05223dc924d96b7de3bd3ad68e6817f7c3676e725770` |
| 4 | First claim accepted | ✅ on a live-funded quest (DGS) | reward step was mock and failed: no mock item ≤ $1 (fixed) |
| 5 | Duplicate claim rejected (`quest_exhausted`, token replay `invalid_token`) | ✅ two-phone run on a live-funded quest (4 Nov, via tunnel) + tests | |
| 6 | Over-cap product refused, zero purchase calls | ✅ tests / ☐ live catalog | |
| 7 | Approved Bitrefill order with a real invoice ID | ✅ policy-approved, paid from the USD balance ($25.00 → $24.45) | `3923a98e-e06e-4775-b8ea-d0db067a3683` (Swiggy Money ₹50, 4 Nov 20:35 IST) |
| 8 | Delivered status + redemption shown to the winner only | ✅ delivered; revealed after manual reconciliation (see note) | quest `pb5PFV6ri22z` |

## Human acceptance run (4 Nov 2026, evening IST)
Production build behind a Cloudflare tunnel; laptop (creator) + two phones. Passed:
the app working on phones, quest creation, live 0.01 TAZ funding auto-activating the quest, the rotating checkpoint code,
the first player winning (reward: mock), a second player rejected, the checkpoint stopping after the win, and a per-player wrong-guess limit
that still let another player win. Bitrefill reward was still mock in this run.

## First live purchase: what happened
The adapter's `buy-products` call created and paid the invoice, but the adapter could not read an invoice ID from the reply.
The app correctly froze the claim as `NEEDS_RECONCILIATION`, with no retry and no second charge.
The invoice was matched manually: one invoice, same product, same minute.
Once it was linked, the worker's REST status check returned `delivered`, and the code was revealed to the winner's session.
Follow-up: diagnose the `buy-products` reply handling (error now logged) and add automatic reconciliation via `list-invoices`.
