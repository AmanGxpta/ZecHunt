import { resolve } from "node:path";
import { DomainError } from "../errors";
import { RestBitrefillAdapter } from "../bitrefill/adapter";
import { ZkoolZcashAdapter } from "../zcash/zkool";
import { MockBitrefillAdapter, MockZcashAdapter } from "./mock";
import type { BitrefillAdapter, Providers, ZcashAdapter } from "./types";

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
  return new RestBitrefillAdapter({
    apiKey,
    dbPath: process.env.ZECHUNT_BITREFILL_DB ?? resolve(process.cwd(), ".data/bitrefill.db"),
    // Real balance spending needs this exact opt-in AND a human approval (scripts/bitrefill-approve.ts).
    livePurchases: process.env.ZECHUNT_LIVE_PURCHASES === "true",
    accountPricesAreUsd: process.env.BITREFILL_ACCOUNT_PRICES_ARE_USD === "true",
    perPurchaseCapCents: Number(process.env.BITREFILL_PER_PURCHASE_CAP_CENTS ?? 55),
    dailyCapCents: Number(process.env.BITREFILL_DAILY_CAP_CENTS ?? 55),
    totalCapCents: Math.min(capCents, Number(process.env.BITREFILL_TOTAL_CAP_CENTS ?? 55)),
  });
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
