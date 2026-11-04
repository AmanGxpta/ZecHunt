# zechunt Zcash capability spike

Status: **in progress; no live payment has been observed yet**. Do not use this branch as evidence of a working shielded funding flow.

The first build attempt stopped while fetching zkool2's Nym Git dependency: the machine had only about 212 MiB free and Cargo reported `No space left on device`. The source checkout is small, but a Rust build needs substantially more free space. No wallet was created and no faucet claim was made.

## Target flow

A creator funds a quest with testnet TAZ. A server process holding only a viewing key detects a decrypted incoming Ironwood note, waits for at least one confirmation, and activates that quest once. The Bitrefill reward is paid separately from event credits. Testnet TAZ authorizes the purchase; it does not pay Bitrefill.

## Verified setup

- Stadium's [Privacy brief](https://stadium.joinwebzero.com/programs/free-society-hack-2026/privacy/llms.txt), version 2026-11-02, identifies NU7 testnet, `utest1` unified addresses with Ironwood receivers, and `https://testnet.zec.rocks:443` as the live light-wallet endpoint.
- This machine is Apple Silicon and has Rust, but no `zkool_graphql`, `zingo-cli`, or `zcash-devtool` binary installed.
- The zkool2 `zkool-v6.36.0` release page shows Linux/Android assets but no macOS binary. Source was checked out at commit `4d12780960392d87b850ddaf677c49ee058f538e` for a local `zkool_graphql` build.
- The checked-out zkool2 GraphQL source has `addressByAccount(idAccount, pools)` (pool mask `4` selects Ironwood), `newAddresses(idAccount)`, `synchronizeAccount(idAccount)`, `transactionsByAccount`, and note fields `id`, `pool`, `scope`, `value`, `address`, and `memo`. Those are source-level findings, not proof of network behavior.

## Open proof steps

1. Complete the zkool2 build and start it bound to localhost with the current testnet light-wallet endpoint.
2. Create a dedicated demo receiving account, record its wallet birthday and `utest1` Ironwood receiving address, and keep the seed outside the repository and chat.
3. Fund it with TAZ, then observe a decrypted incoming note in `transactionsByAccount` with `pool: 3`, `scope: 0`, transaction height, amount, and confirmation count.
4. Send a second real shielded payment from a separate testnet wallet, then verify the watcher maps it to a quest and activates that quest only once.
5. Record the actual txid and wallet receipt evidence in this document without publishing a seed or redemption data.

After a local zkool server and demo account exist, run the read-only probe with `ZECHUNT_ZKOOL_ACCOUNT_ID=<id> node scripts/zcash-probe.mjs`. It reports the Ironwood address and confirmed incoming notes; it does not synchronize or spend. Set `ZECHUNT_ZKOOL_GRAPHQL_URL` if the GraphQL endpoint differs from `http://127.0.0.1:8000/graphql`.

## Integration constraints

- The product worktree currently defines `FundingEvent { txid, outputId, amountZatoshis, confirmations }` and `ZcashAdapter { getQuestAddress, findFunding }`. These are uncommitted product-worktree contracts, so this branch does not copy or edit them.
- `notes[].id` is a zkool wallet database row ID. It survives a process restart when the database is retained, but it is not proven stable after rebuilding the wallet database. Before claiming robust replay protection, establish a chain-level output identity or enforce a durable txid-plus-quest reservation in the application database.
- `transactionsByAccount.value` is the account's net change and is wrong for self-send amount checks. Sum only incoming decrypted notes (`scope: 0`) for the quest address. Convert decimal ZEC to integer zatoshis exactly.
- Do not expose an unauthenticated GraphQL service containing a spending account to the venue network. The application watcher should use a viewing-key-only wallet and a localhost or authenticated endpoint.

## Privacy note draft

The chain shields sender, receiver, and amount, and encrypts the memo. The zechunt server can see payments to its viewing account and stores quest-to-funding associations. The light-wallet server can see the watcher's IP and sync timing. Bitrefill sees the purchase and the credited account's details; the reward does not inherit Zcash's on-chain privacy.
