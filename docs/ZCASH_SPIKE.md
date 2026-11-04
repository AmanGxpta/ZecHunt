# zechunt Zcash capability spike

Status: **live shielded funding detection passed**. Application quest activation is still an integration step and has not been claimed here.

The first build attempt stopped while fetching zkool2's Nym Git dependency: the machine had only about 212 MiB free and Cargo reported `No space left on device`. After space became available, `cargo build --release --no-default-features --features graphql --bin zkool_graphql` succeeded in five minutes. The binary was built outside the repository.

## Target flow

A creator funds a quest with testnet TAZ. A server process holding only a viewing key detects a decrypted incoming Ironwood note, waits for at least one confirmation, and activates that quest once. The Bitrefill reward is paid separately from event credits. Testnet TAZ authorizes the purchase; it does not pay Bitrefill.

## Verified setup

- Stadium's [Privacy brief](https://stadium.joinwebzero.com/programs/free-society-hack-2026/privacy/llms.txt), version 2026-11-02, identifies NU7 testnet, `utest1` unified addresses with Ironwood receivers, and `https://testnet.zec.rocks:443` as the live light-wallet endpoint.
- This machine is Apple Silicon and had no NU7 wallet binary at the start of the spike. `zkool_graphql` was compiled locally from the source below.
- The zkool2 `zkool-v6.36.0` release page shows Linux/Android assets but no macOS binary. Source was checked out at commit `4d12780960392d87b850ddaf677c49ee058f538e` for a local `zkool_graphql` build.
- The checked-out zkool2 GraphQL source has `addressByAccount(idAccount, pools)` (pool mask `4` selects Ironwood), `newAddresses(idAccount)`, `synchronizeAccount(idAccount)`, `transactionsByAccount`, and note fields `id`, `pool`, `scope`, `value`, `address`, and `memo`. Those are source-level findings, not proof of network behavior.

## Open proof steps

1. Integrate `lib/zcash/zkool.ts` into the product's provider selector and run a real quest from `awaiting_funding` to `active`.
2. Verify that the application database counts the same funding event only once across repeated syncs.
3. Replace the localhost demo server with an authenticated or isolated watch-only wallet service for any deployment.

Run the read-only probe with `ZECHUNT_ZKOOL_ACCOUNT_ID=<id> node scripts/zcash-probe.mjs`. It reports the Ironwood address and confirmed incoming notes; it does not synchronize or spend. Set `ZECHUNT_ZKOOL_GRAPHQL_URL` if the GraphQL endpoint differs from `http://127.0.0.1:8000/graphql`.

## Product handoff

`ZkoolZcashAdapter` in `lib/zcash/zkool.ts` structurally implements Claude's `lib/providers/types.ts` interface. The product provider selector can instantiate it like this, with all values supplied from server-only environment configuration:

```ts
new ZkoolZcashAdapter({
  endpoint: process.env.ZECHUNT_ZKOOL_GRAPHQL_URL!,
  accountId: Number(process.env.ZECHUNT_ZKOOL_ACCOUNT_ID),
  mappingDbPath: process.env.ZECHUNT_ZCASH_MAPPING_DB!,
  bearerToken: process.env.ZECHUNT_ZKOOL_BEARER_TOKEN,
});
```

Use the watch-only account, not the spending demo account. Keep `ZECHUNT_ZCASH_MAPPING_DB` and the zkool wallet database on persistent storage. The app currently asks the creator to poll funding; an unattended worker would call the same `findFunding` path and persist each event before activating the quest. The adapter does not broadcast any payment.

## Live testnet evidence, 4 Nov 2026

- Dedicated demo account A received 1 TAZ from Fauzec in [transaction `4ea9e231…e3dc9b`](https://zexplorer.app/testnet/tx/4ea9e23142e79eef1527f3cef654d8f25b2a0c6f232395badb916853c9e3dc9b), confirmed at height 4,582,034. The wallet independently decrypted an incoming Ironwood (`pool: 3`, `scope: 0`) note for 100,000,000 zatoshis.
- Demo account A sent 0.01 TAZ to demo account B in [transaction `38c44579…c4e47`](https://zexplorer.app/testnet/tx/38c445797e97076befaed7adc31f3eb568c84d515ea73546ac545cecbf0c4e47). Account B decrypted the incoming 1,000,000-zatoshi Ironwood note and memo `ZECHUNT-DEMO-1` at height 4,582,043.
- Account B's Ironwood-only UFVK was imported into a separate encrypted wallet database with birthday 4,582,030. That watch-only account independently decrypted the same note. Attempting `pay` there returned `No Signing Key`.
- The live adapter allocated a fresh quest address from the watch-only account, then detected a 0.01 TAZ deposit to that exact address in [transaction `800e91d9…1546d`](https://zexplorer.app/testnet/tx/800e91d9394467ac3483d57b60e00c7547fbe2b3c10a0b7db1d11afd95f1546d) at one confirmation. A repeat scan returned the same `outputId` and a higher confirmation count. This proves the adapter path through `getQuestAddress` and `findFunding`; it does not yet prove the Next.js quest state transition.
- The demo wallet databases and password files are under `/tmp/zechunt-*` with passwords stored in mode-0600 files. No seed, spending key, or viewing key was printed or committed.

## Integration constraints

- The product worktree currently defines `FundingEvent { txid, outputId, amountZatoshis, confirmations }` and `ZcashAdapter { getQuestAddress, findFunding }`. These are uncommitted product-worktree contracts, so this branch does not copy or edit them.
- `notes[].id` is a zkool wallet database row ID: the same chain note had ID 2 in the spending wallet and ID 1 in the watch-only wallet. The adapter therefore groups all incoming Ironwood notes to one quest address within each tx and emits a stable `outputId` of `txid:questAddress`. This is one funding event per transaction and quest, rather than a literal chain output ID. Multiple outputs in that transaction to the same quest address are summed. The shared contract's `outputId` comment should be clarified during integration.
- zkool's `newAddresses(idAccount)` advances a diversifier. The watch-only account successfully created fresh Ironwood addresses. The adapter stores a quest-to-address map in a separate SQLite file; keep both that file and the zkool wallet database persistent across restarts.
- `transactionsByAccount.value` is the account's net change and is wrong for self-send amount checks. Sum only incoming decrypted notes (`scope: 0`) for the quest address. Convert decimal ZEC to integer zatoshis exactly.
- Do not expose an unauthenticated GraphQL service containing a spending account to the venue network. The application watcher should use a viewing-key-only wallet and a localhost or authenticated endpoint.

## Privacy note draft

The chain shields sender, receiver, and amount, and encrypts the memo. The zechunt server can see payments to its viewing account and stores quest-to-funding associations. The light-wallet server can see the watcher's IP and sync timing. Bitrefill sees the purchase and the credited account's details; the reward does not inherit Zcash's on-chain privacy.
