# zecHunt

**Hide a real reward somewhere in the world.** Create a quest, activate it privately with a shielded Zcash testnet payment, and share a link.
The first player to reach the checkpoint and enter its rotating code wins a real Bitrefill digital reward. An agent buys it inside hard, server-enforced spending limits.

Built at Free Society Hack 2026 (Zcash × Bitrefill) for both tracks: **Privacy** and **Agentic Commerce**.

## How it works

```
Creator ──create──▶ Quest API ──getQuestAddress──▶ Zcash watch-only wallet (zkool, NU7 testnet)
   │                                                     ▲
   └─ sends 0.01 TAZ (shielded) ─────────────────────────┘
                     worker: findFunding → funding_events (dedup by outputId) → quest ACTIVE

Player ─ code from checkpoint ─▶ /checkpoint ─ claim token ─▶ /claim
           atomic SQLite tx: consume token, reserve the single winner slot
           → agent proposes product → deterministic spend guard → persist PURCHASE_PENDING
           → Bitrefill purchase → invoice → reconcile → reveal reward to the winner only
```

- **Funding** is a real shielded payment to a per-quest unified address, detected by a viewing-key-only wallet. The watcher cannot spend.
- **Checkpoint** codes are TOTP-style: `HMAC(server secret, quest, minute)`. They rotate every 60 s and are never stored.
  Rate limits apply per player, per IP and per quest, so a griefer can lock out only themselves.
- **One winner** is enforced inside one `BEGIN IMMEDIATE` transaction with DB constraints.
- **Money safety:** the model only proposes. `lib/policy/spend-guard.ts` decides: funded quest, reserved slot, no prior purchase, matching category, price ≤ quest cap, and price ≤ remaining event credit.
  The purchase intent is persisted *before* the external call. Uncertain outcomes go to `NEEDS_RECONCILIATION` and are never retried automatically.
- **No player wallet or account.** An anonymous httpOnly cookie identifies the winner's browser.

## Run it

```bash
npm install
cp .env.example .env.local      # mock mode by default
npm run dev                     # http://localhost:3000
npm test && npm run typecheck && npm run lint
```

Live Zcash: see `docs/INTEGRATIONS.md`. Then run `npm run worker` alongside the web server.

## What is live vs mock (honest status)

| Capability | Status |
| --- | --- |
| Creator / player / checkpoint UX, claims, guard, reconciliation | Implemented, 22 tests |
| Zcash shielded funding detection (zkool watch-only) | Live-verified at adapter level (docs/ZCASH_SPIKE.md). Wired in app, end-to-end run pending |
| Bitrefill catalog + purchase | Live REST adapter wired (Swiggy ₹50, about $0.55), dry run by default. Catalog verified via CLI. Real purchase pending API key + human approval |
| Winner TAZ payout | Not implemented (optional) |

The UI shows a red **Simulated** badge on anything produced by a mock provider.

Docs: [PRIVACY](docs/PRIVACY.md) · [DEMO](docs/DEMO.md) · [INTEGRATIONS](docs/INTEGRATIONS.md) · [EVIDENCE](docs/EVIDENCE.md) · [ZCASH_SPIKE](docs/ZCASH_SPIKE.md)
