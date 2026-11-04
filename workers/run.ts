// Long-running worker: `npm run worker`. Shares the SQLite database with the web app.
// Mock providers keep state in memory, so this worker is only meaningful with
// ZECHUNT_ZCASH_MODE=live and/or ZECHUNT_BITREFILL_MODE=live.
import { getProviders } from "../lib/providers";
import { fundingTick } from "./funding";
import { fulfillmentTick } from "./fulfillment";

const INTERVAL_MS = Number(process.env.ZECHUNT_WORKER_INTERVAL_MS ?? 15_000);
let stopping = false;

async function main() {
  const { modes } = getProviders();
  console.log(`[worker] zcash=${modes.zcash} bitrefill=${modes.bitrefill} every ${INTERVAL_MS}ms`);
  if (modes.zcash === "mock" && modes.bitrefill === "mock") {
    console.log("[worker] both providers are mock; the web process handles everything. Exiting.");
    return;
  }
  while (!stopping) {
    if (modes.zcash === "live") await fundingTick();
    if (modes.bitrefill === "live") await fulfillmentTick().catch((e) => console.log(`[fulfillment] ${e}`));
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stopping = true));
main();
