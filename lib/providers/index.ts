import { resolve } from "node:path";
import { DomainError } from "../errors";
import { ANY_CATALOG_PRODUCT, approveOnePurchase } from "../bitrefill/adapter";
import { CatalogBitrefillBridge } from "../bitrefill/bridge";
import { ZkoolZcashAdapter } from "../zcash/zkool";
import { MockBitrefillAdapter, MockZcashAdapter } from "./mock";
import { PurchaseRejectedError, type BitrefillAdapter, type Providers, type ZcashAdapter } from "./types";

export type ProviderMode = "mock" | "live";

export interface AppProviders extends Providers {
  /** Per-provider mode. The UI labels every mock result as simulated. */
  modes: { zcash: ProviderMode; bitrefill: ProviderMode };
}

const g = globalThis as unknown as { __zechuntProviders?: AppProviders };

function modeFor(name: "ZCASH" | "BITREFILL"): ProviderMode {
  const raw = process.env[`ZECHUNT_${name}_MODE`] ?? process.env.ZECHUNT_PROVIDER_MODE ?? "mock";
  if (raw !== "mock" && raw !== "live") {
    throw new DomainError("invalid_provider_mode", 500, `ZECHUNT_${name}_MODE must be mock or live`);
  }
  return raw;
}

function liveZcash(): ZcashAdapter {
  const endpoint = process.env.ZECHUNT_ZKOOL_GRAPHQL_URL ?? "http://127.0.0.1:8000/graphql";
  const accountId = Number(process.env.ZECHUNT_ZKOOL_ACCOUNT_ID);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new DomainError("zcash_not_configured", 500, "ZECHUNT_ZKOOL_ACCOUNT_ID (watch-only account) is required");
  }
  return new ZkoolZcashAdapter({
    endpoint,
    accountId,
    mappingDbPath: process.env.ZECHUNT_ZCASH_MAPPING_DB ?? resolve(process.cwd(), ".data/zcash-addresses.db"),
    bearerToken: process.env.ZECHUNT_ZKOOL_BEARER_TOKEN,
  });
}

function liveBitrefill(): BitrefillAdapter {
  const apiKey = process.env.BITREFILL_API_KEY;
  if (!apiKey) {
    throw new DomainError("bitrefill_not_configured", 500, "BITREFILL_API_KEY is required for ZECHUNT_BITREFILL_MODE=live");
  }
  const capCents = Math.min(500, Math.round(Number(process.env.BITREFILL_CREDIT_USD ?? "25") * 100));
  const dbPath = process.env.ZECHUNT_BITREFILL_DB ?? resolve(process.cwd(), ".data/bitrefill.db");
  const perPurchaseCapCents = Number(process.env.BITREFILL_PER_PURCHASE_CAP_CENTS ?? 55);
  // Catalog bridge: the India allowlist in lib/bitrefill/catalog.ts, live quotes, and the
  // same guards as before (reprice, one-use approval, per-purchase/daily/total caps,
  // one purchase per claim). Existing Swiggy claims keep their product id.
  const bridge = new CatalogBitrefillBridge({
    apiKey,
    dbPath,
    livePurchases: process.env.ZECHUNT_LIVE_PURCHASES === "true",
    perPurchaseCapCents,
    dailyCapCents: Number(process.env.BITREFILL_DAILY_CAP_CENTS ?? 55),
    totalCapCents: Math.min(capCents, Number(process.env.BITREFILL_TOTAL_CAP_CENTS ?? 55)),
  });
  const live: BitrefillAdapter = {
    searchEligibleProducts: (input) => bridge.searchEligibleProducts(input),
    async purchaseApprovedReward(input) {
      try {
        return await bridge.purchaseApprovedReward(input);
      } catch (err) {
        // Map the adapter's certain-refusal error onto the shared contract.
        if (err instanceof Error && err.name === "BitrefillPurchaseRejected") {
          throw new PurchaseRejectedError(String((err as { reasonCode?: unknown }).reasonCode ?? "rejected"));
        }
        throw err;
      }
    },
    getOrderStatus: (invoiceId) => bridge.getOrderStatus(invoiceId),
    reconcilePurchase: (claimId) => bridge.reconcilePurchase(claimId),
  };
  return process.env.ZECHUNT_BITREFILL_AUTO_APPROVE === "true"
    ? withPolicyApproval(live, dbPath, perPurchaseCapCents)
    : live;
}

/**
 * Autonomous approval rail. The creator's funded quest and its cap are the
 * authorization; this records a one-use, 2-minute approval bounded by
 * min(quest cap, per-purchase cap) just before the agent searches. The adapter
 * still enforces allowlist, live reprice, daily/total caps and one purchase per
 * claim, and the product spend guard still runs before any purchase.
 */
function withPolicyApproval(inner: BitrefillAdapter, dbPath: string, perPurchaseCapCents: number): BitrefillAdapter {
  // Searches happen on every reward-picker load (and per category), so keep at most one
  // live approval per ceiling instead of minting one per search. A purchase consumes it.
  const validUntil = new Map<number, number>();
  const TTL = 2 * 60_000;
  return {
    async searchEligibleProducts(input) {
      const ceiling = Math.min(input.maxPriceCents, perPurchaseCapCents);
      const now = Date.now();
      if (Number.isSafeInteger(ceiling) && ceiling > 0 && (validUntil.get(ceiling) ?? 0) < now + 30_000) {
        approveOnePurchase(dbPath, ceiling, now + TTL, ANY_CATALOG_PRODUCT);
        validUntil.set(ceiling, now + TTL);
      }
      return inner.searchEligibleProducts(input);
    },
    async purchaseApprovedReward(input) {
      validUntil.clear();
      return inner.purchaseApprovedReward(input);
    },
    getOrderStatus: (invoiceId) => inner.getOrderStatus(invoiceId),
    reconcilePurchase: inner.reconcilePurchase && ((claimId) => inner.reconcilePurchase!(claimId)),
  };
}

/** Selects provider implementations per provider. Defaults to mock. */
export function getProviders(): AppProviders {
  if (g.__zechuntProviders) return g.__zechuntProviders;
  const modes = { zcash: modeFor("ZCASH"), bitrefill: modeFor("BITREFILL") };
  g.__zechuntProviders = {
    mode: modes.zcash === "live" && modes.bitrefill === "live" ? "live" : "mock",
    modes,
    zcash: modes.zcash === "live" ? liveZcash() : new MockZcashAdapter(),
    bitrefill: modes.bitrefill === "live" ? liveBitrefill() : new MockBitrefillAdapter(),
  };
  return g.__zechuntProviders;
}

export function resetProvidersForTests(): void {
  g.__zechuntProviders = undefined;
}
