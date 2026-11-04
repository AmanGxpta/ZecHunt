import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decode as decodeToon } from "@toon-format/toon";
import { usdToCents } from "./adapter";
import { displayTitle, REWARD_CATALOG, sanitizeProviderText, type CatalogEntry } from "./catalog";
import type {
  BitrefillAdapterV2, CompetingAttempt, Money, OrderStatus, OrderSummary, PurchaseRequest, PurchaseResult,
  ReconcileRequest, ReconciliationResult, Redemption, RewardCandidate,
} from "../providers/v2";

type AllowedProduct = CatalogEntry;

export interface McpBitrefillAdapterV2Options {
  apiKey: string;
  /** SQLite file for the adapter's own attempt ledger. Ignored when `database` is given. */
  dbPath: string;
  /** Share an existing connection (the v1 bridge passes its own so both ledgers are one file). */
  database?: DatabaseSync;
  /**
   * Also count the v1 `bitrefill_attempts` ledger (same database) toward the daily and
   * total caps, and treat a v1 row for the same claim as a duplicate. Required whenever
   * v1 purchases exist in this database, or the caps would restart from zero.
   */
  legacyV1Ledger?: boolean;
  livePurchases?: boolean;
  perPurchaseCapCents?: number;
  dailyCapCents?: number;
  totalCapCents?: number;
  mcpUrl?: string;
  fetchImpl?: typeof fetch;
  /** A server-owned hard allowlist. Defaults to REWARD_CATALOG. Catalog text cannot add products. */
  allowlist?: readonly AllowedProduct[];
}

/** Read-only view of one attempt in the adapter ledger (no secrets). */
export interface LedgerAttempt {
  attemptId: string;
  claimId: string;
  productId: string;
  packageValue: string;
  quotedCents: number;
  state: AttemptState;
  invoiceId: string | null;
  createdAt: number;
}

interface ProductDetail {
  id?: string;
  name?: string;
  country_code?: string;
  in_stock?: boolean;
  recipient_type?: string;
  packages?: Array<{
    value?: string | number; package_value?: string; package_currency?: string;
    payment_price?: string; payment_currency?: string;
  }>;
}

interface ListedInvoice {
  invoice_id?: string;
  invoice_status?: string;
  created_time?: string;
  orders?: Array<{ product_id?: string; value?: string; currency?: string }>;
}

interface InvoiceDetail {
  invoice_id?: string;
  invoice_status?: string;
  created_time?: string;
  detected_payment_info?: { method?: string; currency?: string; price?: string; status?: string };
  orders?: Array<{
    product?: { id?: string; value?: string; currency?: string };
    payment_method?: string;
    status?: string;
    redemption_info?: unknown;
  }>;
}

interface AttemptRow {
  attempt_id: string;
  claim_id: string;
  product_id: string;
  package_value: string;
  approval_id: string;
  quoted_cents: number;
  state: string;
  invoice_id: string | null;
  created_at: number;
}

interface BalanceEntry {
  payment_method?: string;
  balance_currency?: string;
  amount_base?: number;
  decimals?: number;
}

/** Ledger states. REFUSED = the provider provably refused before executing (no invoice, no charge). */
type AttemptState = "RESERVED" | "UNCERTAIN" | "INVOICED" | "REFUSED";

class McpError extends Error {
  /** auth_refused: HTTP 401, the request was not authenticated, so no tool ran. */
  constructor(readonly code: "timeout" | "transport_error" | "unparseable_response" | "provider_error" | "auth_refused") {
    super(`Bitrefill MCP ${code}`);
  }
}

/** The v2 provider lives beside RestBitrefillAdapter; the live app still uses v1. */
export class McpBitrefillAdapterV2 implements BitrefillAdapterV2 {
  readonly mode = "live" as const;
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly mcpUrl: string;
  private readonly allowlist: readonly AllowedProduct[];

  constructor(private readonly options: McpBitrefillAdapterV2Options) {
    if (!options.apiKey) throw new Error("Bitrefill API key is required");
    if (options.database) {
      this.db = options.database;
      this.ownsDb = false;
    } else {
      if (options.dbPath !== ":memory:") mkdirSync(dirname(options.dbPath), { recursive: true });
      this.db = new DatabaseSync(options.dbPath);
      this.ownsDb = true;
    }
    this.db.exec("PRAGMA busy_timeout = 30000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS bitrefill_v2_attempts (
      attempt_id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL UNIQUE,
      product_id TEXT NOT NULL,
      package_value TEXT NOT NULL,
      approval_id TEXT NOT NULL UNIQUE,
      quoted_cents INTEGER NOT NULL,
      state TEXT NOT NULL,
      invoice_id TEXT UNIQUE,
      created_at INTEGER NOT NULL
    )`);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.mcpUrl = options.mcpUrl ?? "https://api.bitrefill.com/mcp";
    this.allowlist = options.allowlist ?? REWARD_CATALOG;
  }

  close(): void { if (this.ownsDb) this.db.close(); }

  async searchEligibleProducts(input: { country: string; category: string; maxSpendUsdCents: number }): Promise<RewardCandidate[]> {
    const entries = this.allowlist.filter((x) => x.country === input.country && x.category === input.category);
    // One product-details call per brand, in parallel; a failing brand is skipped, not fatal.
    const ids = [...new Set(entries.map((x) => x.productId))];
    const details = new Map<string, ProductDetail>();
    await Promise.all(ids.map(async (id) => {
      try { details.set(id, await this.productDetail(id)); } catch { /* Brand unavailable right now. */ }
    }));
    const cap = this.options.perPurchaseCapCents ?? 55;
    return entries.flatMap((entry) => {
      const detail = details.get(entry.productId);
      if (!detail) return [];
      const quote = quoteFrom(entry, detail);
      return quote.available && !quote.requiresRecipientInput && quote.quotedPrice.amountMinor <= input.maxSpendUsdCents &&
        quote.quotedPrice.amountMinor <= cap ? [quote] : [];
    }).sort((a, b) => a.quotedPrice.amountMinor - b.quotedPrice.amountMinor || a.title.localeCompare(b.title));
  }

  async getLiveQuote(input: { productId: string; packageValue: string }): Promise<RewardCandidate> {
    const allowed = this.allowlist.find((x) => x.productId === input.productId && x.packageValue === input.packageValue);
    if (!allowed) return unavailableQuote(input.productId, input.packageValue);
    return quoteFrom(allowed, await this.productDetail(allowed.productId));
  }

  async purchaseApprovedReward(req: PurchaseRequest): Promise<PurchaseResult> {
    const reject = (reasonCode: Extract<PurchaseResult, { kind: "rejected" }>["reasonCode"]): PurchaseResult =>
      ({ kind: "rejected", attemptId: req.attemptId, reasonCode });
    if (!req.attemptId || !req.claimId || !req.approval?.approvalId) return reject("approval_mismatch");
    // A prior attempt is answered from the ledger BEFORE any policy check: if the
    // freeze switch or allowlist changed since, a charged attempt must still read as
    // charged/uncertain, never as "rejected" (R5). And it never reaches buy-products (R3).
    const prior = this.getAttempt(req.attemptId);
    if (prior) {
      if (prior.claim_id !== req.claimId || prior.product_id !== req.productId ||
          prior.package_value !== req.packageValue ||
          // A row rebuilt by reconcileAttempt never saw the original approval id.
          (!prior.approval_id.startsWith("recovered:") && prior.approval_id !== req.approval.approvalId)) {
        return reject("duplicate_attempt");
      }
      if (prior.invoice_id) return { kind: "invoiced", attemptId: req.attemptId,
        invoiceId: prior.invoice_id, status: "unknown" };
      if (prior.state === "REFUSED") return reject("provider_refused");
      return { kind: "uncertain", attemptId: req.attemptId, reasonCode: "provider_error" };
    }
    if (!this.options.livePurchases) return reject("purchases_disabled");
    if (!this.allowed(req.productId, req.packageValue)) return reject("not_allowlisted");
    if (req.approval.productId !== req.productId || req.approval.packageValue !== req.packageValue ||
        !Number.isSafeInteger(req.approval.maxSpendUsdCents) || req.approval.maxSpendUsdCents <= 0) return reject("approval_mismatch");
    if (!Number.isSafeInteger(req.approval.expiresAt) || req.approval.expiresAt <= Date.now()) return reject("approval_expired");
    let quote: RewardCandidate;
    try { quote = await this.getLiveQuote(req); }
    catch { return reject("unavailable"); } // No money-moving call happened.
    if (!quote.available) return reject("unavailable");
    if (quote.requiresRecipientInput) return reject("recipient_input_required");
    const cents = quote.quotedPrice.amountMinor;
    if (cents > req.approval.maxSpendUsdCents || cents > (this.options.perPurchaseCapCents ?? 55)) return reject("repriced_over_cap");
    // Read-only balance check. Refusing here is certain (no buy-products call). A failed
    // or unrecognized balance reply also refuses: we don't spend into a provider we can't read.
    const balance = await this.usdBalanceCents();
    if (balance === null) return reject("unavailable");
    if (balance < cents) return reject("insufficient_balance");

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.getAttempt(req.attemptId) || this.db.prepare(
        "SELECT 1 FROM bitrefill_v2_attempts WHERE claim_id = ? OR approval_id = ?",
      ).get(req.claimId, req.approval.approvalId) || (this.options.legacyV1Ledger && this.hasV1Ledger() &&
        this.db.prepare("SELECT 1 FROM bitrefill_attempts WHERE claim_id = ?").get(req.claimId))) {
        this.db.exec("ROLLBACK");
        return reject("duplicate_attempt");
      }
      const spent = this.spentCents();
      if (spent.all + cents > (this.options.totalCapCents ?? 500) ||
          spent.today + cents > (this.options.dailyCapCents ?? 500)) {
        this.db.exec("ROLLBACK");
        return reject("spend_ceiling_reached");
      }
      this.db.prepare(`INSERT INTO bitrefill_v2_attempts
        (attempt_id,claim_id,product_id,package_value,approval_id,quoted_cents,state,invoice_id,created_at)
        VALUES (?,?,?,?,?,?,'RESERVED',NULL,?)`).run(
        req.attemptId, req.claimId, req.productId, req.packageValue, req.approval.approvalId, cents, Date.now(),
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error; // Local storage failure before buy-products; no charge occurred.
    }

    let reply: unknown;
    try {
      reply = await this.mcpTool("buy-products", {
        cart_items: [{ product_id: req.productId, package_value: req.packageValue }],
        payment_method: "balance", balance_currency: "USD",
      });
    } catch (error) {
      if (error instanceof McpError && error.code === "auth_refused") {
        // HTTP 401: the MCP server did not authenticate the request, so buy-products never
        // executed and no invoice exists (verified 4 Nov 2026: an invalid key gets a bare
        // 401 before any tool runs). Every other failure, including a tool-level
        // "insufficient balance" error after execution, stays uncertain.
        this.setState(req.attemptId, "REFUSED");
        return reject("provider_refused");
      }
      const reasonCode = error instanceof McpError && error.code !== "auth_refused" ? error.code : "provider_error";
      this.setState(req.attemptId, "UNCERTAIN");
      return { kind: "uncertain", attemptId: req.attemptId, reasonCode };
    }
    const invoice = unwrapInvoice(reply);
    if (!invoice) {
      this.setState(req.attemptId, "UNCERTAIN");
      return { kind: "uncertain", attemptId: req.attemptId, reasonCode: "missing_invoice_id" };
    }
    try {
      this.db.prepare("UPDATE bitrefill_v2_attempts SET invoice_id = ?, state = 'INVOICED' WHERE attempt_id = ?")
        .run(invoice.invoiceId, req.attemptId);
    } catch {
      return { kind: "uncertain", attemptId: req.attemptId, reasonCode: "provider_error" };
    }
    return { kind: "invoiced", attemptId: req.attemptId, invoiceId: invoice.invoiceId, status: invoice.status };
  }

  async reconcileAttempt(req: ReconcileRequest): Promise<ReconciliationResult> {
    const allowed = this.allowed(req.productId, req.packageValue);
    if (!allowed || req.quotedPrice.currency !== "USD" ||
        !Number.isSafeInteger(req.quotedPrice.amountMinor) || req.quotedPrice.amountMinor <= 0 ||
        !Number.isSafeInteger(req.startedAt) || !Array.isArray(req.excludeInvoiceIds) ||
        !Array.isArray(req.competingAttempts)) return { kind: "unavailable", reasonCode: "invalid_request" };
    const prior = this.getAttempt(req.attemptId);
    // Provably refused: no invoice can belong to it. Never adopt someone else's.
    if (prior?.state === "REFUSED") return { kind: "not_found" };
    if (prior && (prior.claim_id !== req.claimId || prior.product_id !== req.productId ||
        prior.package_value !== req.packageValue || prior.quoted_cents !== req.quotedPrice.amountMinor)) {
      return { kind: "unavailable", reasonCode: "attempt_mismatch" };
    }
    let listing: { invoices?: ListedInvoice[]; count?: number };
    try {
      listing = await this.mcpTool("list-invoices", {
        limit: 20, after: new Date(req.startedAt).toISOString(), include_orders: true,
      });
    } catch { return { kind: "unavailable", reasonCode: "invoice_history_lookup_failed" }; }
    if (!Array.isArray(listing.invoices) || listing.invoices.length >= 20 ||
        (typeof listing.count === "number" && listing.count > listing.invoices.length)) {
      return { kind: "unavailable", reasonCode: "invoice_history_incomplete" };
    }
    const candidates = listing.invoices.filter((i) => i.invoice_id && !req.excludeInvoiceIds.includes(i.invoice_id) &&
      i.created_time && Number.isFinite(Date.parse(i.created_time)) && Date.parse(i.created_time) >= req.startedAt &&
      i.orders?.length === 1 && i.orders[0].product_id === req.productId &&
      i.orders[0].value === req.packageValue && i.orders[0].currency === allowed.faceValue.currency);
    const matches: Array<{ id: string; status: OrderStatus; createdAt: number }> = [];
    for (const candidate of candidates) {
      let detail: InvoiceDetail;
      try { detail = await this.invoice(candidate.invoice_id!); }
      catch { return { kind: "unavailable", reasonCode: "invoice_detail_lookup_failed" }; }
      if (!detail.created_time || !Number.isFinite(Date.parse(detail.created_time)) ||
          Date.parse(detail.created_time) !== Date.parse(candidate.created_time!) ||
          detail.invoice_id !== candidate.invoice_id || detail.orders?.length !== 1) {
        return { kind: "unavailable", reasonCode: "invoice_detail_incomplete" };
      }
      const order = detail.orders[0];
      const payment = detail.detected_payment_info;
      if (!payment?.price || !payment.currency || !payment.method || !payment.status ||
          !order.product?.id || !order.product.value || !order.product.currency) {
        return { kind: "unavailable", reasonCode: "invoice_detail_incomplete" };
      }
      let paidCents: number;
      try { paidCents = usdToCents(payment.price); }
      catch { return { kind: "unavailable", reasonCode: "invoice_price_unreadable" }; }
      if (order.product.id === req.productId && order.product.value === req.packageValue &&
          order.product.currency === allowed.faceValue.currency && order.payment_method === "balance" &&
          payment.method === "balance" && payment.currency === "USD" && payment.status === "complete" &&
          paidCents === req.quotedPrice.amountMinor) {
        matches.push({ id: candidate.invoice_id!, status: invoiceStatus(detail), createdAt: Date.parse(detail.created_time) });
      }
    }
    if (matches.length === 0) return { kind: "not_found" };
    if (matches.length > 1) return { kind: "ambiguous", candidateInvoiceIds: matches.map((x) => x.id) };
    const match = matches[0];
    if (prior?.invoice_id && prior.invoice_id !== match.id) {
      return { kind: "unavailable", reasonCode: "attempt_already_invoiced" };
    }
    // CR-1: the app's ledger is authoritative for other unresolved attempts. Any of them
    // that could have produced this invoice (same product, package and quoted price,
    // started at or before it) makes the match ambiguous. This holds even when this
    // adapter's own ledger was lost; the local check below is the second guard.
    if (req.competingAttempts.some((a) => a.attemptId !== req.attemptId &&
        a.productId === req.productId && a.packageValue === req.packageValue &&
        a.quotedPrice?.currency === req.quotedPrice.currency &&
        a.quotedPrice.amountMinor === req.quotedPrice.amountMinor &&
        Number.isFinite(a.startedAt) && a.startedAt <= match.createdAt)) {
      return { kind: "ambiguous", candidateInvoiceIds: [match.id] };
    }
    // The provider has no claim correlation field. A competing local reservation
    // makes this candidate ambiguous even if only one invoice is currently paid.
    try {
      this.db.exec("BEGIN IMMEDIATE");
      if (this.db.prepare(`SELECT 1 FROM bitrefill_v2_attempts WHERE attempt_id <> ?
        AND product_id = ? AND package_value = ? AND quoted_cents = ?
        AND invoice_id IS NULL AND state <> 'REFUSED' AND created_at <= ? LIMIT 1`).get(
        req.attemptId, req.productId, req.packageValue, req.quotedPrice.amountMinor, match.createdAt,
      )) {
        this.db.exec("ROLLBACK");
        return { kind: "ambiguous", candidateInvoiceIds: [match.id] };
      }
      if (this.db.prepare("SELECT 1 FROM bitrefill_v2_attempts WHERE invoice_id = ? AND attempt_id <> ?").get(match.id, req.attemptId)) {
        this.db.exec("ROLLBACK");
        return { kind: "not_found" };
      }
      if (prior) {
        this.db.prepare("UPDATE bitrefill_v2_attempts SET invoice_id = ?, state = 'INVOICED' WHERE attempt_id = ?")
          .run(match.id, req.attemptId);
      } else {
        // Rebuild the secondary ledger if only the app's durable attempt survived.
        this.db.prepare(`INSERT INTO bitrefill_v2_attempts
          (attempt_id,claim_id,product_id,package_value,approval_id,quoted_cents,state,invoice_id,created_at)
          VALUES (?,?,?,?,?,?,'INVOICED',?,?)`).run(
          req.attemptId, req.claimId, req.productId, req.packageValue,
          `recovered:${req.attemptId}`, req.quotedPrice.amountMinor, match.id, req.startedAt,
        );
      }
      this.db.exec("COMMIT");
      return { kind: "matched", invoiceId: match.id, status: match.status };
    } catch {
      try { this.db.exec("ROLLBACK"); } catch { /* Transaction already closed. */ }
      return { kind: "unavailable", reasonCode: "local_ledger_update_failed" };
    }
  }

  async getOrderStatus(invoiceId: string): Promise<OrderSummary> {
    const detail = await this.invoice(invoiceId);
    const status = invoiceStatus(detail);
    return { status, redemptionAvailable: status === "delivered" && detail.orders?.length === 1 &&
      detail.orders[0].redemption_info != null };
  }

  async getRedemption(invoiceId: string): Promise<Redemption | null> {
    const detail = await this.invoice(invoiceId);
    if (invoiceStatus(detail) !== "delivered" || detail.orders?.length !== 1) return null;
    const display = formatRedemption(detail.orders[0].redemption_info);
    return display ? { display } : null;
  }

  // ───────────── ledger helpers for the v1 bridge (not part of the v2 contract) ─────────────

  getLedgerAttempt(attemptId: string): LedgerAttempt | undefined {
    const row = this.getAttempt(attemptId);
    return row && toLedger(row);
  }

  /**
   * Cents still spendable under the daily and total caps (uncertain attempts count; only
   * provably refused ones don't). Read-only; the purchase path re-checks inside its
   * transaction.
   */
  remainingBudgetCents(): number {
    const { all, today } = this.spentCents();
    return Math.max(0, Math.min((this.options.totalCapCents ?? 500) - all, (this.options.dailyCapCents ?? 500) - today));
  }

  /**
   * Reconcile one ledger attempt using only ledger evidence: every invoice already linked
   * (v2 and, with legacyV1Ledger, v1) is excluded, and every other unresolved attempt is
   * passed as a competing attempt (CR-1). For callers with no app-side ledger of their own,
   * i.e. the v1 bridge. Read-only at the provider.
   */
  async reconcileFromLedger(attemptId: string): Promise<ReconciliationResult> {
    const row = this.getAttempt(attemptId);
    if (!row) return { kind: "unavailable", reasonCode: "unknown_attempt" };
    const others = (this.db.prepare(`SELECT * FROM bitrefill_v2_attempts
      WHERE attempt_id <> ? AND invoice_id IS NULL AND state <> 'REFUSED'`).all(attemptId) as unknown as AttemptRow[])
      .map((r): CompetingAttempt => ({ attemptId: r.attempt_id, productId: r.product_id, packageValue: r.package_value,
        quotedPrice: { amountMinor: r.quoted_cents, currency: "USD" }, startedAt: r.created_at }));
    const linked = (this.db.prepare("SELECT invoice_id FROM bitrefill_v2_attempts WHERE invoice_id IS NOT NULL AND attempt_id <> ?")
      .all(attemptId) as Array<{ invoice_id: string }>).map((r) => r.invoice_id);
    if (this.options.legacyV1Ledger && this.hasV1Ledger()) {
      for (const r of this.db.prepare("SELECT claim_id, reward_id, quoted_cents, invoice_id, created_at FROM bitrefill_attempts")
        .all() as Array<{ claim_id: string; reward_id: string; quoted_cents: number; invoice_id: string | null; created_at: number }>) {
        if (r.invoice_id) { linked.push(r.invoice_id); continue; }
        const sep = r.reward_id.lastIndexOf(":");
        others.push({ attemptId: `v1:${r.claim_id}`, productId: r.reward_id.slice(0, sep), packageValue: r.reward_id.slice(sep + 1),
          quotedPrice: { amountMinor: r.quoted_cents, currency: "USD" }, startedAt: r.created_at });
      }
    }
    return this.reconcileAttempt({
      attemptId, claimId: row.claim_id, productId: row.product_id, packageValue: row.package_value,
      quotedPrice: { amountMinor: row.quoted_cents, currency: "USD" }, startedAt: row.created_at,
      excludeInvoiceIds: linked, competingAttempts: others,
    });
  }

  private allowed(productId: string, packageValue: string): AllowedProduct | undefined {
    return this.allowlist.find((x) => x.productId === productId && x.packageValue === packageValue);
  }

  /** Spend that may have happened: every attempt except provably refused ones (plus v1 when enabled). */
  private spentCents(): { all: number; today: number } {
    const midnight = new Date().setUTCHours(0, 0, 0, 0);
    const sum = (sql: string, ...args: number[]) => (this.db.prepare(sql).get(...args) as { cents: number }).cents;
    let all = sum("SELECT COALESCE(SUM(quoted_cents),0) AS cents FROM bitrefill_v2_attempts WHERE state <> 'REFUSED'");
    let today = sum("SELECT COALESCE(SUM(quoted_cents),0) AS cents FROM bitrefill_v2_attempts WHERE state <> 'REFUSED' AND created_at >= ?", midnight);
    if (this.options.legacyV1Ledger && this.hasV1Ledger()) {
      all += sum("SELECT COALESCE(SUM(quoted_cents),0) AS cents FROM bitrefill_attempts");
      today += sum("SELECT COALESCE(SUM(quoted_cents),0) AS cents FROM bitrefill_attempts WHERE created_at >= ?", midnight);
    }
    return { all, today };
  }

  private hasV1Ledger(): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bitrefill_attempts'").get();
  }

  private productDetail(productId: string): Promise<ProductDetail> {
    return this.mcpTool<ProductDetail>("get-product-details", { product_id: productId, currency: "USD" });
  }

  private getAttempt(attemptId: string): AttemptRow | undefined {
    return this.db.prepare("SELECT * FROM bitrefill_v2_attempts WHERE attempt_id = ?").get(attemptId) as AttemptRow | undefined;
  }

  private setState(attemptId: string, state: Exclude<AttemptState, "RESERVED" | "INVOICED">): void {
    // If this write fails the row stays RESERVED: replay is still forbidden and the
    // attempt reads as uncertain, which is the safe direction for REFUSED too.
    try { this.db.prepare("UPDATE bitrefill_v2_attempts SET state = ? WHERE attempt_id = ? AND invoice_id IS NULL").run(state, attemptId); }
    catch { /* See above. */ }
  }

  /** Spendable USD balance in cents, or null if it can't be read with certainty. Read-only. */
  private async usdBalanceCents(): Promise<number | null> {
    let reply: { balances?: BalanceEntry[] };
    try { reply = await this.mcpTool("get-balances", { currency: "USD" }); }
    catch { return null; }
    if (!Array.isArray(reply?.balances)) return null;
    const usd = reply.balances.filter((b) => b.payment_method === "balance" && b.balance_currency === "USD");
    if (usd.length !== 1 || usd[0].decimals !== 2 || !Number.isSafeInteger(usd[0].amount_base) ||
        usd[0].amount_base! < 0) return null;
    return usd[0].amount_base!;
  }

  private async invoice(invoiceId: string): Promise<InvoiceDetail> {
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(invoiceId)) throw new McpError("unparseable_response");
    return this.mcpTool<InvoiceDetail>("get-invoice-by-id", { invoice_id: invoiceId });
  }

  private async mcpTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.mcpUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json",
          accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) { throw new McpError(isTimeout(error) ? "timeout" : "transport_error"); }
    if (!response.ok) throw new McpError(response.status === 401 ? "auth_refused" : "provider_error");
    let raw: string;
    try { raw = await response.text(); }
    catch (error) { throw new McpError(isTimeout(error) ? "timeout" : "transport_error"); }
    const data = raw.startsWith("event:") || raw.startsWith("data:")
      ? raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).at(-1)?.slice(5).trim() : raw;
    let message: { result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown }; error?: unknown };
    try { message = JSON.parse(data ?? ""); }
    catch { throw new McpError("unparseable_response"); }
    if (message.error || message.result?.isError) throw new McpError("provider_error");
    if (message.result?.structuredContent && typeof message.result.structuredContent === "object") {
      return message.result.structuredContent as T;
    }
    const text = message.result?.content?.find((x) => x.type === "text")?.text;
    if (!text) throw new McpError("unparseable_response");
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch {
      try { parsed = decodeToon(text); }
      catch { throw new McpError("unparseable_response"); }
    }
    // TOON decodes almost any text to *something*; every tool we call returns an object.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new McpError("unparseable_response");
    return parsed as T;
  }
}

/**
 * Builds a quote for one catalog entry from an untrusted product-details reply. The title is
 * our own catalog text; provider text never becomes a title. Any disagreement with the
 * catalog (id, country, stock, listed package, USD payment, stated face value) makes the
 * entry unavailable rather than guessing.
 */
function quoteFrom(entry: CatalogEntry, detail: ProductDetail): RewardCandidate {
  const pack = detail.packages?.find((x) => String(x.package_value ?? x.value) === entry.packageValue);
  const faceAmount = Number(pack?.package_value ?? pack?.value);
  const stated: Money | undefined = pack?.package_currency && (pack.package_currency === "INR" || pack.package_currency === "USD") &&
    Number.isFinite(faceAmount) && faceAmount > 0
    ? { amountMinor: Math.round(faceAmount * 100), currency: pack.package_currency } : undefined;
  const faceAgrees = !stated || (stated.currency === entry.faceValue.currency && stated.amountMinor === entry.faceValue.amountMinor);
  const valid = detail.id === entry.productId && detail.country_code === entry.country &&
    detail.in_stock === true && !!pack && pack.payment_currency === "USD" && faceAgrees;
  let cents = 0;
  if (valid) {
    try { cents = usdToCents(pack.payment_price ?? ""); } catch { /* Untrusted quote: unavailable. */ }
  }
  return {
    productId: entry.productId, packageValue: entry.packageValue,
    title: displayTitle(entry), category: entry.category, country: entry.country,
    quotedPrice: { amountMinor: cents, currency: "USD" },
    // Only what the provider states; never inferred from the package id.
    faceValue: stated && faceAgrees ? stated : undefined,
    requiresRecipientInput: detail.recipient_type !== "none", available: valid && cents > 0,
  };
}

/**
 * Winner-facing text from Bitrefill's redemption_info. Real shape (invoice of 4 Nov 2026):
 * { pin, other, expirationTime, extraFields: { "PIN Code": ... } } where `other` repeats an
 * extra field as "Label: value". Also handles code/link variants. Unknown shapes fall back
 * to JSON so a winner is never left with nothing. SECRET: never log the result.
 */
export function formatRedemption(info: unknown): string | null {
  if (info == null || info === "") return null;
  if (typeof info === "string") return info;
  if (typeof info !== "object" || Array.isArray(info)) return JSON.stringify(info);
  const r = info as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" || typeof v === "number") && String(v).trim() ? String(v).trim() : null;
  const lines: string[] = [];
  const code = str(r.code);
  const pin = str(r.pin);
  if (code) lines.push(`Code: ${code}`);
  if (pin) lines.push(code ? `PIN: ${pin}` : `Code: ${pin}`);
  const link = str(r.link);
  if (link && /^https:\/\//.test(link)) lines.push(`Link: ${link}`);
  if (r.extraFields && typeof r.extraFields === "object" && !Array.isArray(r.extraFields)) {
    for (const [label, value] of Object.entries(r.extraFields as Record<string, unknown>)) {
      const v = str(value);
      const l = sanitizeProviderText(label, 40);
      if (v && l) lines.push(`${l}: ${v}`);
    }
  }
  const other = str(r.other);
  if (other && !lines.includes(other)) lines.push(other);
  const expires = str(r.expirationTime);
  if (expires && Number.isFinite(Date.parse(expires))) lines.push(`Valid until: ${new Date(expires).toISOString().slice(0, 10)}`);
  const hasSecret = lines.some((l) => !l.startsWith("Valid until:"));
  return hasSecret ? lines.join("\n") : JSON.stringify(info);
}

function toLedger(r: AttemptRow): LedgerAttempt {
  return { attemptId: r.attempt_id, claimId: r.claim_id, productId: r.product_id, packageValue: r.package_value,
    quotedCents: r.quoted_cents, state: r.state as AttemptState, invoiceId: r.invoice_id, createdAt: r.created_at };
}

function unavailableQuote(productId: string, packageValue: string): RewardCandidate {
  return { productId, packageValue, title: productId, category: "", country: "",
    quotedPrice: { amountMinor: 0, currency: "USD" }, requiresRecipientInput: false, available: false };
}

function unwrapInvoice(value: unknown): { invoiceId: string; status: OrderStatus } | null {
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;
  const inner = root.response && typeof root.response === "object" ? root.response as Record<string, unknown> : root;
  if (typeof inner.invoice_id !== "string" || !/^[a-zA-Z0-9-]{8,100}$/.test(inner.invoice_id)) return null;
  return { invoiceId: inner.invoice_id, status: "pending" };
}

function invoiceStatus(invoice: InvoiceDetail): OrderStatus {
  if (["blocked", "denied", "payment_error", "failed", "refunded"].includes(invoice.invoice_status ?? "")) return "failed";
  if (invoice.orders?.length === 1 && invoice.orders[0].status === "delivered") return "delivered";
  if (invoice.detected_payment_info?.status === "complete" || invoice.invoice_status === "complete") return "paid";
  if (["pending", "unconfirmed"].includes(invoice.invoice_status ?? "")) return "pending";
  return "unknown";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
