// Shielded deposit watcher. Holds only a viewing-key wallet connection (via the
// Zcash adapter); it can detect and decrypt incoming notes but cannot spend.
// Restart-safe: funding events are keyed by outputId in SQLite, and zkool keeps
// its own scan cursor in its wallet database.
import { getDb } from "../lib/db";
import { getProviders } from "../lib/providers";
import { syncOnce } from "../lib/quests/funding-sync";
import { questsAwaitingFunding } from "../lib/quests/service";

export async function fundingTick(log = console.log): Promise<void> {
  const db = getDb();
  const { zcash } = getProviders();
  for (const id of questsAwaitingFunding(db)) {
    try {
      const q = await syncOnce(db, zcash, id);
      if (q.status === "active") log(`[funding] quest ${id} activated (${q.fundedZatoshis} zat confirmed)`);
    } catch (err) {
      log(`[funding] quest ${id}: ${err instanceof Error ? err.message : "scan failed"}`);
    }
  }
}
