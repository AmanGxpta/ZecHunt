import { DomainError } from "../errors";
import { MockBitrefillAdapter, MockZcashAdapter } from "./mock";
import type { Providers } from "./types";

const g = globalThis as unknown as { __zechuntProviders?: Providers };

/**
 * Selects provider implementations. Defaults to mock.
 * Live adapters are owned by the integration track and are not implemented yet.
 */
export function getProviders(): Providers {
  if (g.__zechuntProviders) return g.__zechuntProviders;

  const mode = process.env.ZECHUNT_PROVIDER_MODE ?? "mock";
  if (mode === "mock") {
    g.__zechuntProviders = {
      mode: "mock",
      zcash: new MockZcashAdapter(),
      bitrefill: new MockBitrefillAdapter(),
    };
    return g.__zechuntProviders;
  }
  throw new DomainError(
    "live_providers_not_implemented",
    501,
    `ZECHUNT_PROVIDER_MODE=${mode} requires live adapters, which are not implemented yet`,
  );
}

export function resetProvidersForTests(): void {
  g.__zechuntProviders = undefined;
}
