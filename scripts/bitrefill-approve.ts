// Local operator command. Do not expose through HTTP or agent tools.
import { approveOnePurchase } from "../lib/bitrefill/adapter";

const [rewardId, maxCentsText] = process.argv.slice(2);
const dbPath = process.env.ZECHUNT_BITREFILL_DB;
if (!dbPath || rewardId !== "swiggy-money-india:50" || !/^\d+$/.test(maxCentsText ?? "")) {
  console.error("Usage: ZECHUNT_BITREFILL_DB=<persistent path> tsx scripts/bitrefill-approve.ts swiggy-money-india:50 <max USD cents>");
  process.exit(2);
}

approveOnePurchase(dbPath, Number(maxCentsText), Date.now() + 15 * 60_000);
console.log("One approval recorded for Swiggy Money ₹50; expires in 15 minutes.");
