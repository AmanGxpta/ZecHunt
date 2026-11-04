# Privacy & trust model

zecHunt is a **custodial prototype on Zcash testnet**. This document says exactly what is private and from whom.

## What the chain hides
The creator funds a quest with a shielded payment (Ironwood pool, NU7 testnet) to a fresh per-quest unified address.
On-chain observers cannot see the sender, the receiver, the amount, or the memo.

## What our server sees
- The server sees incoming notes for its **viewing key** only: amount, tx id, and which quest address was paid. It cannot see who sent them.
- The watcher holds a watch-only (UFVK) wallet and **cannot spend**.
- Quest content, the per-quest funding address, and a link between the quest and the funding txid.
- Players are anonymous browser sessions (a random cookie). There are no accounts, wallets, emails, or locations.
- IP addresses are used only as HMAC hashes for rate limiting.

## What others see
- **Light-wallet server** (`testnet.zec.rocks`): the watcher's IP address and sync timing.
- **Bitrefill**: the purchase made with our event-credit account. The reward does **not** inherit Zcash privacy.
- **Checkpoint volunteer**: sees whoever shows up in person.

## Secrets
- Creator token, checkpoint key, and claim tokens are stored only as HMAC hashes.
- Checkpoint codes rotate every 60 s and are derived from a server secret. They are never stored.
- Redemption codes are fetched live for the winner's session and are never stored or logged.
- No seed, spending key, or viewing key is in the repo or the app database.

## Honest limits
- A six-digit code at a staffed checkpoint is a *trusted-checkpoint* proof, not cheat-proof location proof.
- The TAZ deposit authorises activation in a test environment. It does **not** pay for the Bitrefill reward, which comes from a capped event-credit budget.
- In production this would need a real settlement path (a ZEC-funded treasury or user checkout), refunds, and non-custodial options.
