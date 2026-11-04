import { resolve } from "node:path";
import { DomainError } from "../errors";
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
  // Wired at integration time once lib/bitrefill/ (Codex) lands. See docs/INTEGRATIONS.md.
  throw new DomainError(
    "bitrefill_live_not_integrated",
    501,
    "ZECHUNT_BITREFILL_MODE=live needs the lib/bitrefill adapter, which is not merged yet",
  );
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
