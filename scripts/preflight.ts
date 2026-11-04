// zecHunt demo preflight. READ-ONLY.
//   node --env-file=.env.local --import tsx scripts/preflight.ts
//
// Checks what a live demo needs and prints a go/no-go table with a fix for every failing
// item. It never calls buy-products (a guarded fetch refuses every Bitrefill tool except
// get-balances and get-product-details, and every zkool mutation), never writes a database
// (all SQLite files are opened read-only), and never prints keys, tokens or codes.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CATALOG_CATEGORIES, REWARD_CATALOG } from "../lib/bitrefill/catalog";
import { McpBitrefillAdapterV2, readLedgerSpend } from "../lib/bitrefill/v2";
import { isUnderTempDir } from "../lib/zcash/data-dir";
import { readLastScanAt, ZkoolZcashAdapter } from "../lib/zcash/zkool";
import { INR_CAPS, inrCapToCents } from "../lib/money";
import type { RewardCandidate } from "../lib/providers/v2";

type Verdict = "GO" | "WARN" | "NO-GO";
interface Row { verdict: Verdict; item: string; detail: string; fix?: string }
const rows: Row[] = [];
const add = (verdict: Verdict, item: string, detail: string, fix?: string) => rows.push({ verdict, item, detail, fix });

const env = process.env;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const int = (value: string | undefined, fallback: number) => {
  const n = Number(value ?? fallback);
  return Number.isSafeInteger(n) ? n : NaN;
};
const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** Bitrefill MCP fetch that can only read. Anything else throws before leaving the process. */
const BITREFILL_READ_TOOLS = new Set(["get-balances", "get-product-details"]);
const bitrefillReadOnly: typeof fetch = (url, init) => {
  const name = JSON.parse(String(init?.body ?? "{}"))?.params?.name;
  if (!BITREFILL_READ_TOOLS.has(name)) throw new Error(`preflight refused Bitrefill tool ${String(name)}`);
  return fetch(url, init);
};
const zkoolReadOnly: typeof fetch = (url, init) => {
  const query = String(JSON.parse(String(init?.body ?? "{}"))?.query ?? "");
  if (/^\s*mutation/i.test(query)) throw new Error("preflight refused a zkool mutation");
  return fetch(url, init);
};

async function bitrefill(): Promise<void> {
  const mode = env.ZECHUNT_BITREFILL_MODE ?? "mock";
  const live = env.ZECHUNT_LIVE_PURCHASES === "true";
  const autoApprove = env.ZECHUNT_BITREFILL_AUTO_APPROVE === "true";
  add(mode === "live" ? "GO" : "NO-GO", "Bitrefill mode", mode, mode === "live" ? undefined : "set ZECHUNT_BITREFILL_MODE=live");
  add(live ? "GO" : "NO-GO", "Real purchases", live ? "enabled" : "dry run",
    live ? undefined : "set ZECHUNT_LIVE_PURCHASES=true (the founder's opt-in to spend credit)");
  add(autoApprove ? "GO" : "WARN", "Purchase approval", autoApprove ? "policy auto-approval" : "manual one-use approvals",
    autoApprove ? undefined : "set ZECHUNT_BITREFILL_AUTO_APPROVE=true, or approve each purchase with scripts/bitrefill-approve.ts");

  const apiKey = env.BITREFILL_API_KEY;
  if (!apiKey) {
    add("NO-GO", "Bitrefill API key", "missing", "set BITREFILL_API_KEY in .env.local");
    return;
  }
  add("GO", "Bitrefill API key", "set (not shown)");

  // Caps exactly as lib/providers/index.ts derives them.
  const creditCents = Math.round(Number(env.BITREFILL_CREDIT_USD ?? "25") * 100);
  const per = int(env.BITREFILL_PER_PURCHASE_CAP_CENTS, 55);
  const daily = int(env.BITREFILL_DAILY_CAP_CENTS, 55);
  const total = Math.min(Math.min(500, creditCents), int(env.BITREFILL_TOTAL_CAP_CENTS, 55));
  const dbPath = env.ZECHUNT_BITREFILL_DB ?? resolve(process.cwd(), ".data/bitrefill.db");
  let spent = { all: 0, today: 0 };
  let unusedApprovals = 0;
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      spent = readLedgerSpend(db, true);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bitrefill_approvals'").get()) {
        unusedApprovals = (db.prepare("SELECT COUNT(*) AS n FROM bitrefill_approvals WHERE used_at IS NULL AND expires_at > ?")
          .get(Date.now()) as { n: number }).n;
      }
    } finally { db.close(); }
  }
  const dailyLeft = Math.max(0, daily - spent.today);
  const totalLeft = Math.max(0, total - spent.all);
  const headroom = Math.min(per, dailyLeft, totalLeft);

  const quoter = new McpBitrefillAdapterV2({ apiKey, dbPath: ":memory:", livePurchases: false,
    perPurchaseCapCents: 500, fetchImpl: bitrefillReadOnly });
  try {
    const balance = await quoter.getUsdBalanceCents();
    if (balance === null) add("NO-GO", "USD balance", "could not be read", "check the API key and Bitrefill status; MCP get-balances failed");
    else add(balance >= Math.max(headroom, 1) ? "GO" : "NO-GO", "USD balance", usd(balance),
      balance >= Math.max(headroom, 1) ? undefined : "top up the Bitrefill USD balance");

    add(per > 0 ? "GO" : "NO-GO", "Per-purchase cap", `${usd(per)} (BITREFILL_PER_PURCHASE_CAP_CENTS)`);
    add(dailyLeft > 0 ? "GO" : "NO-GO", "Daily cap headroom", `${usd(dailyLeft)} left of ${usd(daily)} (UTC day)`,
      dailyLeft > 0 ? undefined : `raise BITREFILL_DAILY_CAP_CENTS above ${spent.today}, or wait for 00:00 UTC`);
    add(totalLeft > 0 ? "GO" : "NO-GO", "Total cap headroom", `${usd(totalLeft)} left of ${usd(total)} (${usd(spent.all)} already spent)`,
      totalLeft > 0 ? undefined : `raise BITREFILL_TOTAL_CAP_CENTS to at least ${spent.all + 363} for any ₹400-tier reward (max 500, and BITREFILL_CREDIT_USD bounds it)`);
    if (!autoApprove && live) {
      add(unusedApprovals > 0 ? "GO" : "NO-GO", "Unused approvals", String(unusedApprovals),
        unusedApprovals > 0 ? undefined : "run scripts/bitrefill-approve.ts before the winner claims");
    }

    // What a winner would see now, per tier: the bridge offers live quotes within
    // min(tier cap, credit, per-purchase cap, daily and total headroom).
    const country = env.ZECHUNT_REWARD_COUNTRY ?? "IN";
    const quotes: RewardCandidate[] = [];
    for (const category of CATALOG_CATEGORIES) {
      quotes.push(...await quoter.searchEligibleProducts({ country, category, maxSpendUsdCents: 500 }));
    }
    add(quotes.length > 0 ? "GO" : "NO-GO", "Live catalog quotes", `${quotes.length}/${REWARD_CATALOG.length} catalog packages in stock and quotable`,
      quotes.length > 0 ? undefined : "Bitrefill product details unavailable; retry, or check ZECHUNT_REWARD_COUNTRY=IN");
    for (const tier of INR_CAPS) {
      const tierCap = inrCapToCents(tier);
      const ceiling = Math.min(tierCap, creditCents, headroom);
      const visible = quotes.filter((q) => q.quotedPrice.amountMinor <= ceiling);
      const wouldFit = quotes.filter((q) => q.quotedPrice.amountMinor <= Math.min(tierCap, creditCents));
      const needed = wouldFit.reduce((m, q) => Math.max(m, q.quotedPrice.amountMinor), 0);
      const byCat = CATALOG_CATEGORIES.map((c) => {
        const names = visible.filter((q) => q.category === c).map((q) => q.title);
        return `${c}: ${names.length ? names.join(", ") : "—"}`;
      }).join(" | ");
      const missing = CATALOG_CATEGORIES.filter((c) => !visible.some((q) => q.category === c));
      const verdict: Verdict = visible.length === 0 ? "NO-GO" : missing.length ? "WARN" : "GO";
      const blockers = [
        per < needed ? `per-purchase cap to ${needed}` : "",
        dailyLeft < needed ? `daily cap so ≥${needed}¢ remain today` : "",
        totalLeft < needed ? `total cap so ≥${needed}¢ remain` : "",
      ].filter(Boolean);
      add(verdict, `Winner sees at ₹${tier} (cap ${usd(tierCap)})`, `${visible.length}/${wouldFit.length} — ${byCat}`,
        verdict === "GO" ? undefined
          : blockers.length ? `raise ${blockers.join("; ")} (cents)` : `no ${missing.join("/")} product fits ₹${tier}`);
    }
  } finally {
    quoter.close();
  }
}

async function zcash(): Promise<void> {
  const mode = env.ZECHUNT_ZCASH_MODE ?? "mock";
  add(mode === "live" ? "GO" : "NO-GO", "Zcash mode", mode, mode === "live" ? undefined : "set ZECHUNT_ZCASH_MODE=live");
  const endpoint = env.ZECHUNT_ZKOOL_GRAPHQL_URL;
  const accountId = Number(env.ZECHUNT_ZKOOL_ACCOUNT_ID);
  if (!endpoint || !Number.isSafeInteger(accountId) || accountId <= 0) {
    add("NO-GO", "zkool config", "ZECHUNT_ZKOOL_GRAPHQL_URL / ZECHUNT_ZKOOL_ACCOUNT_ID missing", "set both in .env.local");
    return;
  }
  const watcher = new ZkoolZcashAdapter({ endpoint, accountId, mappingDbPath: ":memory:",
    bearerToken: env.ZECHUNT_ZKOOL_BEARER_TOKEN, fetchImpl: zkoolReadOnly });
  try {
    const health = await watcher.getWatcherHealth();
    const reachable = health.syncedHeight !== null || health.chainTipHeight !== null;
    add(reachable ? "GO" : "NO-GO", "zkool reachable", reachable ? endpoint : `no answer at ${endpoint}`,
      reachable ? undefined : "start the watch-only wallet (lib/zcash/run-watcher.ts) and check the URL/port");
    if (!reachable) return;
    const lag = health.syncedHeight !== null && health.chainTipHeight !== null ? health.chainTipHeight - health.syncedHeight : null;
    add(health.syncedHeight !== null ? "GO" : "WARN", "Synced height",
      health.syncedHeight === null ? `unavailable (${health.unavailable.join(", ")})`
        : `${health.syncedHeight}${health.chainTipHeight !== null ? ` / tip ${health.chainTipHeight} (${lag} behind)` : " / tip unavailable"}`,
      health.syncedHeight === null ? "use an admin JWT or the loopback unauthenticated service"
        : lag !== null && lag > 1000 ? "a funding check will catch up; run one before the demo so it's quick" : undefined);
    if (health.chainTipHeight === null) add("WARN", "Chain tip", "unavailable from the light-wallet server", "check ZECHUNT_ZKOOL_LWD_URL / network");
  } finally {
    watcher.close();
  }
  const mappingDb = env.ZECHUNT_ZCASH_MAPPING_DB ?? resolve(process.cwd(), ".data/zcash-addresses.db");
  const lastScan = readLastScanAt(mappingDb);
  add(lastScan === null ? "WARN" : Date.now() - lastScan > 6 * 3600_000 ? "WARN" : "GO", "Last funding scan",
    lastScan === null ? "never recorded" : ago(lastScan),
    lastScan === null ? "open a quest's creator page once to run a funding check" : undefined);
  const onTemp = isUnderTempDir(mappingDb) || (env.ZECHUNT_ZKOOL_DATA_DIR ? isUnderTempDir(env.ZECHUNT_ZKOOL_DATA_DIR) : true);
  add(onTemp ? "WARN" : "GO", "Wallet data location", onTemp ? "temporary directory (lost on reboot)" : "persistent",
    onTemp ? "follow docs/evidence/zcash/wallet-migration-2026-11-04.md; don't reboot before the demo" : undefined);
}

function print(): void {
  const w = { v: 6, i: Math.max(...rows.map((r) => r.item.length)) };
  for (const r of rows) {
    console.log(`${r.verdict.padEnd(w.v)} ${r.item.padEnd(w.i)}  ${r.detail}`);
    if (r.fix) console.log(`${"".padEnd(w.v + w.i + 3)}→ ${r.fix}`);
  }
  const nogo = rows.filter((r) => r.verdict === "NO-GO").length;
  const warn = rows.filter((r) => r.verdict === "WARN").length;
  console.log(`\n${nogo ? "NO-GO" : "GO"}: ${nogo} blocking, ${warn} warning(s). Read-only: no purchase was made.`);
  process.exitCode = nogo ? 1 : 0;
}

async function main(): Promise<void> {
  console.log(`zecHunt preflight — ${new Date().toISOString()}\n`);
  try { await bitrefill(); } catch (e) { add("NO-GO", "Bitrefill checks", e instanceof Error ? e.message : "failed", "see the message; nothing was bought"); }
  try { await zcash(); } catch (e) { add("NO-GO", "Zcash checks", e instanceof Error ? e.message : "failed"); }
  print();
}

void main();
