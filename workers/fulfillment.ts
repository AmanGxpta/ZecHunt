// Purchase reconciliation. Never re-buys: PURCHASE_PENDING attempts older than the
// grace period become NEEDS_RECONCILIATION for a human; attempts with an invoice
// are re-checked with the provider.
import { getDb } from "../lib/db";
import { getProviders } from "../lib/providers";
import { reconcileFulfillments } from "../lib/quests/service";

export async function fulfillmentTick(log = console.log): Promise<void> {
  const { flagged, refreshed, adopted } = await reconcileFulfillments(getDb(), getProviders().bitrefill);
  if (flagged || refreshed || adopted) log(`[fulfillment] flagged ${flagged}, adopted ${adopted}, refreshed ${refreshed}`);
}
