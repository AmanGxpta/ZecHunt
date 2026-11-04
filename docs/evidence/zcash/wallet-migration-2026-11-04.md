# Move the zkool watch-only wallet off /tmp (no rescan)

**For the founder to run.** I did not stop, copy or modify the running wallet. Everything under "Current state" was observed read-only on 4 Nov 2026.

## Why

macOS clears `/tmp` on reboot. Today these all live there:

- the encrypted watch-only wallet
- its password file
- the quest → address map, which is the only record of which address belongs to which quest
- the `zkool_graphql` binary itself

A reboot would lose funding detection for every existing quest. Rebuilding would mean re-importing the UFVK and rescanning from the birthday height, and re-deriving the quest map is not possible automatically.

## Current state (read-only observation)

| Item | Value |
|---|---|
| Process | `zkool_graphql -d /tmp/zechunt-watch-wallet.db -p 8766 -l https://testnet.zec.rocks:443 -C 1 --bind-address 127.0.0.1 --db-password-file <file> --allow-unauthenticated` |
| Binary | `/tmp/sidequest-zkool2/target/release/zkool_graphql` (zkool2 commit `4d12780`, v6.36.0) |
| Wallet DB | `/tmp/zechunt-watch-wallet.db` (encrypted; ~360 KB) |
| Sidecar | `/tmp/zechunt-watch-wallet.db.voting` (zkool creates it beside the wallet DB) |
| Password file | the path after `--db-password-file` in the command line (not printed here) |
| Quest map | `/tmp/zechunt-quest-map.db` (`ZECHUNT_ZCASH_MAPPING_DB` in the product `.env.local`) |
| Account | id 1, birthday 4,582,030, synced to 4,582,418; chain tip 4,582,641 at check time |
| WAL files | none present while running |

Why no rescan is needed: zkool keeps its scan progress (`sync_heights`), notes and transactions inside the wallet DB. A byte-for-byte copy of a cleanly stopped wallet resumes from its stored height. Only new blocks are scanned.

## New layout

Pick one persistent directory and set `ZECHUNT_ZKOOL_DATA_DIR` to it. `lib/zcash/data-dir.ts` refuses relative paths and temp directories, including symlinks into `/tmp`. The file names inside it are fixed:

```
$ZECHUNT_ZKOOL_DATA_DIR/
  watch-wallet.db           ← /tmp/zechunt-watch-wallet.db
  watch-wallet.db.voting    ← /tmp/zechunt-watch-wallet.db.voting
  wallet-password           ← the --db-password-file (mode 0600)
  quest-addresses.db        ← /tmp/zechunt-quest-map.db
```

The wallet holds a viewing key, which reveals every incoming payment to the account. Don't put this directory in a cloud-synced folder.

## Steps

Run in a terminal. Nothing below prints a password or key.

```bash
# 0. Choose the directory (macOS example; on Linux e.g. /var/lib/zechunt/zkool)
export ZECHUNT_ZKOOL_DATA_DIR="$HOME/Library/Application Support/zechunt/zkool"
mkdir -p "$ZECHUNT_ZKOOL_DATA_DIR" && chmod 700 "$ZECHUNT_ZKOOL_DATA_DIR"
mkdir -p "$HOME/.local/bin"

# 1. Baseline, read-only. Keep this output.
curl -s http://127.0.0.1:8766/graphql -H 'content-type: application/json' \
  -d '{"query":"{ accounts(accountFilter:{id:1}) { id height birth } transactionsByAccount(idAccount:1) { txid } }"}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0)).data; console.log(JSON.stringify({account:d.accounts[0], txCount:d.transactionsByAccount.length}))' \
  | tee "$ZECHUNT_ZKOOL_DATA_DIR/baseline.json"
sqlite3 -readonly /tmp/zechunt-quest-map.db "SELECT COUNT(*) FROM zcash_quest_addresses"

# 2. Stop the app and any worker (next dev / npm run worker) so nothing syncs or allocates
#    an address during the copy.

# 3. Note the password-file path, then stop zkool cleanly and wait for it to exit.
PID=$(pgrep -f 'zkool_graphql.*zechunt-watch-wallet.db')
OLD_PW=$(ps -o args= -p "$PID" | sed -E 's/.*--db-password-file ([^ ]+).*/\1/')
kill -TERM "$PID"; while kill -0 "$PID" 2>/dev/null; do sleep 1; done
lsof /tmp/zechunt-watch-wallet.db || echo "wallet closed"

# 4. Copy (don't move: /tmp stays as the rollback copy).
ls /tmp/zechunt-watch-wallet.db*        # copy every sibling listed (-wal/-shm/-journal if any)
cp -p /tmp/zechunt-watch-wallet.db        "$ZECHUNT_ZKOOL_DATA_DIR/watch-wallet.db"
cp -p /tmp/zechunt-watch-wallet.db.voting "$ZECHUNT_ZKOOL_DATA_DIR/watch-wallet.db.voting"
cp -p "$OLD_PW" "$ZECHUNT_ZKOOL_DATA_DIR/wallet-password" && chmod 600 "$ZECHUNT_ZKOOL_DATA_DIR/wallet-password"
sqlite3 /tmp/zechunt-quest-map.db ".backup '$ZECHUNT_ZKOOL_DATA_DIR/quest-addresses.db'"
cp -p /tmp/sidequest-zkool2/target/release/zkool_graphql "$HOME/.local/bin/zkool_graphql"

# 5. Verify the copies.
shasum -a 256 /tmp/zechunt-watch-wallet.db "$ZECHUNT_ZKOOL_DATA_DIR/watch-wallet.db"
shasum -a 256 /tmp/zechunt-watch-wallet.db.voting "$ZECHUNT_ZKOOL_DATA_DIR/watch-wallet.db.voting"
cmp -s "$OLD_PW" "$ZECHUNT_ZKOOL_DATA_DIR/wallet-password" && echo "password file identical"
sqlite3 -readonly "$ZECHUNT_ZKOOL_DATA_DIR/quest-addresses.db" "PRAGMA integrity_check; SELECT COUNT(*) FROM zcash_quest_addresses"

# 6. Start zkool on the new path. The launcher refuses to start if the wallet file is
#    missing, so a typo can't create an empty wallet.
ZECHUNT_ZKOOL_BIN="$HOME/.local/bin/zkool_graphql" \
ZECHUNT_ZKOOL_GRAPHQL_URL=http://127.0.0.1:8766/graphql \
ZECHUNT_ZKOOL_ALLOW_UNAUTHENTICATED=true \
node --import tsx lib/zcash/run-watcher.ts
#   (equivalent manual command:
#    zkool_graphql -d "$ZECHUNT_ZKOOL_DATA_DIR/watch-wallet.db" \
#      --db-password-file "$ZECHUNT_ZKOOL_DATA_DIR/wallet-password" \
#      -l https://testnet.zec.rocks:443 -p 8766 --bind-address 127.0.0.1 -C 1 --allow-unauthenticated)
```

**7. Check that no rescan happened.** In a second terminal, rerun the step 1 `curl` and compare it with `baseline.json`:

- `birth` must be the same (4,582,030).
- `height` must be **equal to or higher than** the baseline height, never back at the birthday.
- `txCount` must be the same.

If `height` equals `birth` or `txCount` is 0, you are on an empty wallet. Stop zkool and go back to step 4.

**8. Point the app at the new files** in `.env.local`, then restart the app:

```
ZECHUNT_ZKOOL_DATA_DIR=<the directory>
ZECHUNT_ZCASH_MAPPING_DB=<the directory>/quest-addresses.db
```

Then open an already-funded quest's creator page. It must still show as funded, with the same funding event. A new funding check only scans blocks after the stored height.

**9. Keep `/tmp` until it's proven.** Leave the `/tmp` copies until the new setup survives one reboot and one funding check. Then delete them: `rm /tmp/zechunt-watch-wallet.db* /tmp/zechunt-quest-map.db`, plus the old password file.

**Rollback** (any time before step 9): stop the new process and rerun the original command with the `/tmp` paths. The copies were made from a stopped wallet, and the originals were never modified.

## Notes

- `--allow-unauthenticated` gives full wallet-API access to anyone who can reach the port. The launcher only permits it on a loopback bind address. A JWT public key (`ZECHUNT_ZKOOL_JWT_PUBLIC_KEY_FILE`) is the route for any deployment.
- With an account-scoped JWT, zkool's `accounts` query (used by `getWatcherHealth` for the synced height) returns "Unauthorized". Health then reports `synced_height_unauthorized` instead of a number.
- This wallet has never been tested for spend capability through a read-only API call. The earlier evidence is that `pay` on this UFVK-only wallet returned `No Signing Key` (see `docs/ZCASH_SPIKE.md`).
