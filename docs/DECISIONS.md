# Decisions log

Founder decisions are marked **[founder]**. Agents may research these and recommend, but only the founder decides. Status: `proposed` → `accepted` / `rejected`, with a date.

| # | Decision | Recommendation | Status |
|---|---|---|---|
| D1 | First customer **[founder]** | Event organizers / communities | proposed |
| D2 | Geography **[founder]** | India only | proposed |
| D3 | Catalog **[founder]** | Code-only food / shopping / entertainment; no recipient-input products in v2 | proposed |
| D4 | Accounts **[founder]** | Anonymous players; recoverable creator access in Phase 3 | proposed |
| D5 | Custody **[founder]** | Custodial testnet beta, disclosed; no mainnet deposits | proposed |
| D6 | Spend limits **[founder]** | Keep $0.55 / $5 / $5 through Phase 1; raising requires an explicit operator action | proposed |
| D7 | Unclaimed quest **[founder]** | Reward stays unpurchased; creator can cancel; no "refund" of testnet TAZ | proposed |
| D8 | Business model **[founder]** | Organizer-paid fee; don't monetize the reward balance | proposed |
| D9 | Contract ownership | Claude owns `lib/providers/*`, `lib/contracts/*`; Codex proposes changes | accepted 2026-11-04 |
| D10 | Approval authority | The app's policy engine mints approvals; adapters only verify them. The adapter keeps an independent cap ledger as a second guard | accepted 2026-11-04 |
| D11 | Persistence | SQLite, single writer, through the Phase 3 beta | accepted 2026-11-04 |
| D12 | Redemption storage | Never stored; re-fetched from Bitrefill after the entitlement check | accepted 2026-11-04 |
| D13 | Uncertain vs rejected | "Rejected" only when no charge is certain; otherwise "uncertain" and never retried | accepted 2026-11-04 |
