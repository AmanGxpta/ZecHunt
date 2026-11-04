// v1 bridge: lets the live app (v1 BitrefillAdapter) buy from the reward catalog through
// the v2 MCP adapter, without changing the app's v1 contract.
//
// Guards kept from v1, all enforced here or in McpBitrefillAdapterV2:
//  - hard allowlist (lib/bitrefill/catalog.ts); provider text never adds a product
//  - live reprice right before spending, against min(expectedMaxPriceCents, per-purchase cap)
//  - a one-use human/policy approval from approveOnePurchase, consumed atomically
//  - per-purchase, daily and total caps, counting the v1 ledger too (same SQLite file)
//  - one purchase per claim, across v1 and v2 rows; an uncertain purchase is never re-bought
//  - read-only reconciliation that refuses ambiguous matches (CR-1 + local ledger)
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PurchaseRejectedError, type BitrefillAdapter, type PurchaseOrderStatus, type RewardProduct } from "../providers/types";
import { ANY_CATALOG_PRODUCT, initializeV1Ledger, RestBitrefillAdapter } from "./adapter";
import { catalogKey, findByCatalogKey, findCatalogEntry, REWARD_CATALOG, type CatalogEntry } from "./catalog";
import { safeLogoUrl } from "./logos";
import { McpBitrefillAdapterV2 } from "./v2";

export interface CatalogBitrefillBridgeOptions {
  apiKey: string;
  /** The same SQLite file the v1 adapter and approveOnePurchase use (ZECHUNT_BITREFILL_DB). */
  dbPath: string;
  /** Real balance spending. Must be an explicit true. */
  livePurchases: boolean;
  /** Required, no defaults: the bridge never invents a spending limit. */
  perPurchaseCapCents: number;
  dailyCapCents: number;
  totalCapCents: number;
  mcpUrl?: string;
  fetchImpl?: typeof fetch;
  /** Defaults to REWARD_CATALOG. */
  catalog?: readonly CatalogEntry[];
}

/**
 * Certain refusal: no money moved in this call. The app may fail the claim cleanly.
 * A PurchaseRejectedError (shared v1 contract), so `instanceof PurchaseRejectedError` works;
 * the name stays "BitrefillPurchaseRejected" for existing name-based mapping.
 */
export class BitrefillPurchaseRejected extends PurchaseRejectedError {
  constructor(reasonCode: string) {
    super(reasonCode);
    this.name = "BitrefillPurchaseRejected";
  }
}

/** Outcome unknown: money may have moved. Never retry; reconcile. */
export class BitrefillPurchaseUncertain extends Error {
  constructor(readonly reasonCode: string) {
    super(`Bitrefill purchase outcome unknown (${reasonCode}); reconcile before retrying`);
    this.name = "BitrefillPurchaseUncertain";
  }
}

interface ApprovalRow { id: number; max_price_cents: number; expires_at: number }

export class CatalogBitrefillBridge implements BitrefillAdapter {
  private readonly db: DatabaseSync;
  private readonly v2: McpBitrefillAdapterV2;
  private readonly catalog: readonly CatalogEntry[];
  private legacy: RestBitrefillAdapter | undefined;

  constructor(private readonly options: CatalogBitrefillBridgeOptions) {
    if (!options.apiKey) throw new Error("Bitrefill API key is required");
    for (const [name, value] of Object.entries({ perPurchaseCapCents: options.perPurchaseCapCents,
      dailyCapCents: options.dailyCapCents, totalCapCents: options.totalCapCents })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    }
    if (options.dbPath !== ":memory:") mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec("PRAGMA busy_timeout = 30000");
    initializeV1Ledger(this.db);
    this.catalog = options.catalog ?? REWARD_CATALOG;
    this.v2 = new McpBitrefillAdapterV2({
      apiKey: options.apiKey, dbPath: options.dbPath, database: this.db, legacyV1Ledger: true,
      livePurchases: options.livePurchases === true, perPurchaseCapCents: options.perPurchaseCapCents,
      dailyCapCents: options.dailyCapCents, totalCapCents: options.totalCapCents,
      mcpUrl: options.mcpUrl, fetchImpl: options.fetchImpl, allowlist: this.catalog,
    });
  }

  close(): void {
    this.legacy?.close();
    this.v2.close();
    this.db.close();
  }

  /**
   * Every buyable catalog product in the category: live USD quote, code-only, within
   * maxPriceCents, the per-purchase cap and the remaining daily/total budget, and (when
   * live) covered by an unused approval. productId is the catalog key, e.g. "swiggy-money-india:50".
   */
  async searchEligibleProducts(input: { country: string; category: string; maxPriceCents: number }): Promise<RewardProduct[]> {
    if (!Number.isSafeInteger(input.maxPriceCents) || input.maxPriceCents <= 0) return [];
    const ceiling = Math.min(input.maxPriceCents, this.v2.remainingBudgetCents());
    if (ceiling <= 0) return [];
    const quotes = await this.v2.searchEligibleProducts({ country: input.country, category: input.category, maxSpendUsdCents: ceiling });
    return quotes
      .filter((q) => !this.options.livePurchases || this.findApproval(catalogKey(q), q.quotedPrice.amountMinor))
      .map((q): RewardProduct => ({ productId: catalogKey(q), name: q.title, category: q.category,
        priceCents: q.quotedPrice.amountMinor,
        // CR-4: only when the provider stated it (v2 quote drops a face value that disagrees with the catalog).
        ...(q.faceValue ? { faceValue: { amountMinor: q.faceValue.amountMinor, currency: q.faceValue.currency } } : {}),
        // Logo from the stored catalog (no extra call), re-validated: https on Bitrefill's image host only.
        ...logoFor(this.catalog, q.productId, q.packageValue) }));
  }

  async purchaseApprovedReward(input: { claimId: string; productId: string; expectedMaxPriceCents: number }): Promise<{ invoiceId: string; status: string }> {
    if (!input.claimId) throw new Error("claimId is required");
    // 1. A claim that already has an attempt is answered from the ledgers, before any policy
    //    check, and is never bought again.
    const legacyRow = this.legacyAttempt(input.claimId);
    if (legacyRow) {
      if (legacyRow.invoice_id) return { invoiceId: legacyRow.invoice_id, status: legacyRow.state };
      return this.legacyAdapter().reconcileReservedPurchase(input.claimId);
    }
    const prior = this.v2.getLedgerAttempt(attemptIdFor(input.claimId));
    if (prior) {
      if (prior.invoiceId) return { invoiceId: prior.invoiceId, status: "pending" };
      if (prior.state === "REFUSED") throw new BitrefillPurchaseRejected("provider_refused");
      return this.reconcilePurchase(input.claimId);
    }

    // 2. New purchase.
    if (!this.options.livePurchases) throw new Error("Bitrefill purchases are disabled (dry run)");
    const entry = findByCatalogKey(input.productId, this.catalog);
    if (!entry) throw new Error("Product is not allowlisted");
    // Reprice immediately before spending. The proposal's price is a ceiling, never
    // authority to buy an unavailable or more expensive package.
    const quote = await this.v2.getLiveQuote(entry).catch(() => null);
    if (!quote?.available) throw new BitrefillPurchaseRejected("unavailable");
    if (quote.requiresRecipientInput) throw new BitrefillPurchaseRejected("recipient_input_required");
    const ceiling = Math.min(input.expectedMaxPriceCents, this.options.perPurchaseCapCents);
    const price = quote.quotedPrice.amountMinor;
    if (!Number.isSafeInteger(ceiling) || price > ceiling) throw new BitrefillPurchaseRejected("repriced_over_cap");

    const approval = this.consumeApproval(catalogKey(entry), price);
    if (!approval) throw new BitrefillPurchaseRejected("no_approval");
    const result = await this.v2.purchaseApprovedReward({
      attemptId: attemptIdFor(input.claimId), claimId: input.claimId,
      productId: entry.productId, packageValue: entry.packageValue,
      approval: { approvalId: `v1-approval:${approval.id}`, productId: entry.productId, packageValue: entry.packageValue,
        maxSpendUsdCents: Math.min(approval.max_price_cents, ceiling), expiresAt: approval.expires_at },
    });
    if (result.kind === "invoiced") return { invoiceId: result.invoiceId, status: result.status };
    if (result.kind === "uncertain") throw new BitrefillPurchaseUncertain(result.reasonCode);
    // rejected. duplicate_attempt means another attempt for this claim exists (maybe charged).
    if (result.reasonCode === "duplicate_attempt") throw new Error("Duplicate purchase attempt");
    // Refused before the ledger reservation: certain no charge, so the one-use approval goes
    // back. provider_refused (HTTP 401) already holds a ledger row with this approval id.
    if (result.reasonCode !== "provider_refused") {
      this.db.prepare("UPDATE bitrefill_approvals SET used_at = NULL WHERE id = ?").run(approval.id);
    }
    throw new BitrefillPurchaseRejected(result.reasonCode);
  }

  /** Never buys. Delivered → redemptionData (SECRET); delivered without a code yet → pending. */
  async getOrderStatus(invoiceId: string): Promise<PurchaseOrderStatus> {
    const summary = await this.v2.getOrderStatus(invoiceId);
    if (summary.status === "failed") return { status: "failed" };
    if (summary.status !== "delivered") return { status: "pending" };
    const redemption = await this.v2.getRedemption(invoiceId);
    return redemption ? { status: "delivered", redemptionData: redemption.display } : { status: "pending" };
  }

  /** Read-only. Adopts exactly one invoice or throws (zero, several, overlapping or unreadable). */
  async reconcilePurchase(claimId: string): Promise<{ invoiceId: string; status: string }> {
    if (this.legacyAttempt(claimId)) return this.legacyAdapter().reconcileReservedPurchase(claimId);
    const attemptId = attemptIdFor(claimId);
    const prior = this.v2.getLedgerAttempt(attemptId);
    if (!prior) throw new Error("No matching Bitrefill purchase attempt");
    if (prior.invoiceId) return { invoiceId: prior.invoiceId, status: "pending" };
    if (prior.state === "REFUSED") throw new BitrefillPurchaseRejected("provider_refused");
    const r = await this.v2.reconcileFromLedger(attemptId);
    if (r.kind === "matched") return { invoiceId: r.invoiceId, status: r.status };
    if (r.kind === "ambiguous") {
      throw new Error(`Bitrefill reconciliation is ambiguous (${r.candidateInvoiceIds.length} candidate invoice(s) or an overlapping attempt); operator review required`);
    }
    if (r.kind === "not_found") throw new Error("Bitrefill reconciliation found no matching invoice yet");
    throw new Error(`Bitrefill reconciliation unavailable: ${r.reasonCode}`);
  }

  private legacyAttempt(claimId: string): { state: string; invoice_id: string | null } | undefined {
    return this.db.prepare("SELECT state, invoice_id FROM bitrefill_attempts WHERE claim_id = ?").get(claimId) as
      { state: string; invoice_id: string | null } | undefined;
  }

  /** v1 reconciliation for rows the v1 adapter created (Swiggy ₹50 only). It never buys. */
  private legacyAdapter(): RestBitrefillAdapter {
    this.legacy ??= new RestBitrefillAdapter({ apiKey: this.options.apiKey, dbPath: this.options.dbPath,
      livePurchases: false, mcpUrl: this.options.mcpUrl, fetchImpl: this.options.fetchImpl });
    return this.legacy;
  }

  /** Specific approvals first, then ANY_CATALOG_PRODUCT; tightest ceiling first. */
  private findApproval(key: string, priceCents: number): ApprovalRow | undefined {
    return this.db.prepare(`SELECT id, max_price_cents, expires_at FROM bitrefill_approvals
      WHERE reward_id IN (?, ?) AND max_price_cents >= ? AND expires_at > ? AND used_at IS NULL
      ORDER BY (reward_id = ?) ASC, max_price_cents ASC, id ASC LIMIT 1`)
      .get(key, ANY_CATALOG_PRODUCT, priceCents, Date.now(), ANY_CATALOG_PRODUCT) as ApprovalRow | undefined;
  }

  private consumeApproval(key: string, priceCents: number): ApprovalRow | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const approval = this.findApproval(key, priceCents);
      if (approval) {
        this.db.prepare("UPDATE bitrefill_approvals SET used_at = ? WHERE id = ? AND used_at IS NULL").run(Date.now(), approval.id);
      }
      this.db.exec("COMMIT");
      return approval;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function logoFor(catalog: readonly CatalogEntry[], productId: string, packageValue: string): { imageUrl?: string } {
  const url = safeLogoUrl(findCatalogEntry(productId, packageValue, catalog)?.imageUrl);
  return url ? { imageUrl: url } : {};
}

function attemptIdFor(claimId: string): string {
  return `v1:${claimId}`;
}
