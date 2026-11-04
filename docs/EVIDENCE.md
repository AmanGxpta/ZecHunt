# Evidence checklist

Only tick an item with real provider evidence. Mock runs do not count.

| # | Evidence | Status | Reference |
| - | --- | --- | --- |
| 1 | Real shielded testnet tx to a quest address | ✅ at adapter level (Codex spike) | `800e91d9394467ac3483d57b60e00c7547fbe2b3c10a0b7db1d11afd95f1546d` (docs/ZCASH_SPIKE.md) |
| 2 | Receiving watch-only wallet decrypted it | ✅ at adapter level | docs/ZCASH_SPIKE.md |
| 3 | Quest moved `awaiting_funding → active` from a real tx | ✅ service level (Codex smoke DB) / ☐ in running app | `5ebb0957b12c7c6ce2ca05223dc924d96b7de3bd3ad68e6817f7c3676e725770` |
| 4 | First claim accepted | ✅ mock / ☐ live | |
| 5 | Duplicate claim rejected (`quest_exhausted`, token replay `invalid_token`) | ✅ mock + tests / ☐ live | |
| 6 | Over-cap product refused, zero purchase calls | ✅ tests / ☐ live catalog | |
| 7 | Approved Bitrefill order with a real invoice ID | ☐ | |
| 8 | Delivered status + redemption shown to the winner only | ☐ | |
