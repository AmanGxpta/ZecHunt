# Zechunt

Hide a real reward behind a real-world challenge. A creator funds a quest with shielded Zcash testnet funds, shares the link and a checkpoint code, and the first verified player receives a Bitrefill reward.

Status: **MVP in progress.** The application flow runs end to end against mock providers. Live Zcash and Bitrefill adapters are not implemented yet.

## Run it

```bash
npm install
cp .env.example .env.local   # then set ZECHUNT_SECRET
npm run dev                  # http://localhost:3000
npm test                     # domain tests (node:test + tsx)
npm run typecheck
```

## Status: what is real and what is mocked

| Capability | Status |
| --- | --- |
| Quest creation, funding activation, checkpoint, single-winner claim | Implemented, tested (`tests/quests.test.ts`) |
| Spend guard (cap, credit, category, duplicate) | Implemented, unit-tested |
| Restart-safe purchase state, no blind retries, reconciliation | Implemented, tested |
| Zcash funding detection | **Mock only.** `lib/providers/mock.ts` |
| Bitrefill catalog and purchase | **Mock only.** `lib/providers/mock.ts` |
| Live Zcash NU7 testnet adapter | Not implemented (`ZECHUNT_PROVIDER_MODE=live` returns 501) |
| Live Bitrefill MCP/API adapter | Not implemented |
| Agent-based product selection | Deterministic selection only (`lib/providers/select.ts`); the guard still decides |

Every mock result is labelled in the API (`providerMode`) and in the UI. A mock is never presented as a real transaction or purchase.

## Architecture

- `lib/quests/service.ts`: quest state machine, funding sync, checkpoint verification, atomic claim, guarded fulfillment, reconciliation.
- `lib/policy/spend-guard.ts`: the only code path that can approve a purchase.
- `lib/providers/`: adapter contracts (`types.ts`) and mock implementations.
- `lib/db.ts`: SQLite (`node:sqlite`). Money is stored as integers: zatoshis and cents.
- `app/api/quests/...`: HTTP routes. Sensitive checks run on the server only.

Security properties enforced by the code and tests:

- Creator token and checkpoint code are stored only as keyed HMACs. Both are shown once.
- Checkpoint codes lock out after 10 wrong attempts.
- Claim tokens are single-use, expire after 10 minutes, and are bound to the player session.
- Exactly one winner per quest, enforced in one `BEGIN IMMEDIATE` transaction.
- An output of a shielded transaction can fund a quest only once (primary key on the output id).
- A purchase intent is persisted before the Bitrefill call. A failed call is marked for reconciliation, never retried.

## Privacy and trust note (draft)

- **What stays private:** on the Zcash side, funding amounts, sender and receiver addresses, and memos are shielded on-chain. Quest creators and winners need no public wallet history.
- **What the app reveals, and to whom:** the server stores quest titles, clues, reward categories, and claim timing. The server sees player session IDs (anonymous cookies) and the creator's funding address. The reward category and cap are public by design.
- **What users must trust:** the operator's server (it holds the checkpoint secret and the claim logic); the Zcash testnet wallet/viewing-key service for funding detection; Bitrefill for fulfilment; the Bitrefill credit owner for spending limits.
- **Known gaps:** the checkpoint is a shared six-digit code, not location proof. Redemption data is fetched live and not stored, but there is no encryption-at-rest for invoice records yet. The custody model is custodial and must not be described as trustless.

## Next steps

1. Live Zcash adapter: detect a real shielded testnet deposit to a per-quest address.
2. Live Bitrefill adapter: catalog search and `buy-products` with test products first.
3. Demo video and public URL.
