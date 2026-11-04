import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FundingEvent, ZcashAdapter } from "../providers/types";

type GraphqlResponse<T> = { data?: T; errors?: { message: string }[] };

interface Options {
  endpoint: string;
  accountId: number;
  mappingDbPath: string;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
}

interface QuestAddress {
  address: string;
}

/**
 * Read-only watcher status for operators and the creator page. Null means "not known
 * right now", never a guess; `unavailable` says which part could not be read and why
 * (safe to log: reason codes only).
 */
export interface ZkoolWatcherHealth {
  /** Height this watch-only account has scanned to (zkool's sync_heights), or null. */
  syncedHeight: number | null;
  /** Latest block height reported by the light-wallet server through zkool, or null. */
  chainTipHeight: number | null;
  /** Epoch ms of the last findFunding scan (sync + transaction read) that completed. Survives restarts. */
  lastSuccessfulScanAt: number | null;
  unavailable: WatcherHealthGap[];
}

export type WatcherHealthGap =
  | "chain_tip_unavailable"
  | "synced_height_unavailable"
  | "synced_height_unauthorized"
  | "never_scanned";

interface WalletTransaction {
  txid: string;
  height: number;
  notes: { pool: number; scope: number; value: string; address: string }[];
}

/** Exact conversion: GraphQL returns decimal ZEC, while the app uses integer zatoshis. */
export function zecToZatoshis(value: string): bigint {
  const match = value.match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!match) throw new Error("Invalid ZEC amount from zkool");
  return BigInt(match[1]) * 100_000_000n + BigInt((match[2] ?? "").padEnd(8, "0"));
}

/**
 * zkool2 NU7 testnet adapter. The GraphQL account must be watch-only (UFVK),
 * and its encrypted wallet database must persist across restarts.
 */
export class ZkoolZcashAdapter implements ZcashAdapter {
  private readonly db: DatabaseSync;
  private readonly fetchImpl: typeof fetch;
  private allocationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: Options) {
    if (!/^https?:\/\//.test(options.endpoint)) throw new Error("Invalid zkool endpoint");
    if (!Number.isSafeInteger(options.accountId) || options.accountId <= 0) {
      throw new Error("Invalid zkool account ID");
    }
    if (options.mappingDbPath !== ":memory:") {
      mkdirSync(dirname(options.mappingDbPath), { recursive: true });
    }
    this.db = new DatabaseSync(options.mappingDbPath);
    this.db.exec("PRAGMA busy_timeout = 30000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS zcash_quest_addresses (
      quest_id TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS zcash_watcher_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_scan_at INTEGER NOT NULL,
      last_synced_height INTEGER NOT NULL
    )`);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  close(): void {
    this.db.close();
  }

  async getQuestAddress(questId: string): Promise<string> {
    if (!questId) throw new Error("Quest ID is required");
    const previous = this.allocationTail;
    let release!: () => void;
    this.allocationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.lookup(questId);
        if (existing) {
          this.db.exec("COMMIT");
          return existing.address;
        }

        const allocated = await this.query<{
          newAddresses: { ironwood: string | null };
        }>(
          "mutation($id: Int!) { newAddresses(idAccount: $id) { ironwood } }",
          { id: this.options.accountId },
        );
        const ironwood = await this.query<{
          addressByAccount: { ua: string; ironwood: string | null };
        }>(
          "query($id: Int!) { addressByAccount(idAccount: $id, pools: 4) { ua ironwood } }",
          { id: this.options.accountId },
        );
        const address = ironwood.addressByAccount?.ua;
        if (!address?.startsWith("utest1") ||
            address !== ironwood.addressByAccount.ironwood ||
            address !== allocated.newAddresses?.ironwood) {
          throw new Error("zkool did not allocate a matching Ironwood testnet address");
        }
        this.db.prepare(
          "INSERT INTO zcash_quest_addresses (quest_id, address) VALUES (?, ?)",
        ).run(questId, address);
        this.db.exec("COMMIT");
        return address;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      release();
    }
  }

  async findFunding(questId: string): Promise<FundingEvent[]> {
    const address = this.lookup(questId)?.address;
    if (!address) throw new Error("Unknown Zcash quest address");

    // zkool persists its scan cursor in its own wallet database. Never count
    // more confirmations than that account has actually synchronized.
    const synced = await this.query<{ synchronizeAccount: number }>(
      "mutation($id: Int!) { synchronizeAccount(idAccount: $id) }",
      { id: this.options.accountId },
      180_000,
    );
    const syncedHeight = synced.synchronizeAccount;
    if (!Number.isSafeInteger(syncedHeight) || syncedHeight <= 0) {
      throw new Error("Invalid zkool synchronized height");
    }
    const result = await this.query<{ transactionsByAccount: WalletTransaction[] }>(
      `query($id: Int!) {
        transactionsByAccount(idAccount: $id) {
          txid height notes { pool scope value address }
        }
      }`,
      { id: this.options.accountId },
    );

    const byTransaction = new Map<string, bigint>();
    const heights = new Map<string, number>();
    for (const tx of result.transactionsByAccount ?? []) {
      if (!/^[0-9a-f]{64}$/i.test(tx.txid) ||
          !Number.isSafeInteger(tx.height) || tx.height <= 0 || tx.height > syncedHeight) continue;
      for (const note of tx.notes ?? []) {
        if (note.pool !== 3 || note.scope !== 0 || note.address !== address) continue;
        const amount = zecToZatoshis(note.value);
        if (amount <= 0n) continue;
        byTransaction.set(tx.txid, (byTransaction.get(tx.txid) ?? 0n) + amount);
        heights.set(tx.txid, tx.height);
      }
    }

    this.db.prepare(`INSERT INTO zcash_watcher_state (id, last_scan_at, last_synced_height) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_scan_at = excluded.last_scan_at, last_synced_height = excluded.last_synced_height`)
      .run(Date.now(), syncedHeight);

    // zkool's note ID is local to its wallet DB and changes in a fresh
    // watch-only wallet. Group by txid and quest address for stable dedupe.
    return [...byTransaction].map(([txid, amountZatoshis]) => ({
      txid,
      outputId: `${txid}:${address}`,
      amountZatoshis,
      confirmations: syncedHeight - heights.get(txid)! + 1,
    }));
  }

  /**
   * Read-only: two GraphQL queries, no mutation, no synchronization, and never the
   * account's seed or keys. The tip and the synced height are queried separately so one
   * failing (e.g. light-wallet server down) does not hide the other. Never throws for
   * provider failures.
   */
  async getWatcherHealth(): Promise<ZkoolWatcherHealth> {
    const unavailable: WatcherHealthGap[] = [];
    const [tip, account] = await Promise.allSettled([
      this.query<{ currentHeight: number }>("query { currentHeight }", {}),
      this.query<{ accounts: { id: number; height: number }[] }>(
        "query($id: Int!) { accounts(accountFilter: { id: $id }) { id height } }",
        { id: this.options.accountId },
      ),
    ]);
    const positive = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) > 0 ? v as number : null;

    const chainTipHeight = tip.status === "fulfilled" ? positive(tip.value.currentHeight) : null;
    if (chainTipHeight === null) unavailable.push("chain_tip_unavailable");

    let syncedHeight: number | null = null;
    if (account.status === "fulfilled") {
      const rows = (account.value.accounts ?? []).filter((a) => a.id === this.options.accountId);
      syncedHeight = rows.length === 1 ? positive(rows[0].height) : null;
    }
    if (syncedHeight === null) {
      // zkool's `accounts` query is admin-only; an account-scoped JWT gets "Unauthorized".
      const unauthorized = account.status === "rejected" && /Unauthorized/.test(String(account.reason));
      unavailable.push(unauthorized ? "synced_height_unauthorized" : "synced_height_unavailable");
    }

    const state = this.db.prepare("SELECT last_scan_at FROM zcash_watcher_state WHERE id = 1").get() as
      { last_scan_at: number } | undefined;
    const lastSuccessfulScanAt = state?.last_scan_at ?? null;
    if (lastSuccessfulScanAt === null) unavailable.push("never_scanned");
    return { syncedHeight, chainTipHeight, lastSuccessfulScanAt, unavailable };
  }

  private lookup(questId: string): QuestAddress | undefined {
    return this.db.prepare(
      "SELECT address FROM zcash_quest_addresses WHERE quest_id = ?",
    ).get(questId) as QuestAddress | undefined;
  }

  private async query<T>(query: string, variables: Record<string, unknown>, timeout = 15_000): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.bearerToken) headers.authorization = `Bearer ${this.options.bearerToken}`;
    const response = await this.fetchImpl(this.options.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`zkool GraphQL HTTP ${response.status}`);
    const body = await response.json() as GraphqlResponse<T>;
    if (body.errors?.length) throw new Error(`zkool GraphQL: ${body.errors[0].message}`);
    if (!body.data) throw new Error("zkool GraphQL response has no data");
    return body.data;
  }
}
