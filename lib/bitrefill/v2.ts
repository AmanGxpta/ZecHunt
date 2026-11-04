import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decode as decodeToon } from "@toon-format/toon";
import { usdToCents } from "./adapter";
import type {
  BitrefillAdapterV2, OrderStatus, OrderSummary, PurchaseRequest, PurchaseResult,
  ReconcileRequest, ReconciliationResult, Redemption, RewardCandidate,
} from "../providers/v2";

interface AllowedProduct {
  productId: string;
  packageValue: string;
  category: string;
  country: string;
  faceCurrency: "INR" | "USD";
}

const DEFAULT_ALLOWLIST: AllowedProduct[] = [{
  productId: "swiggy-money-india", packageValue: "50", category: "food", country: "IN", faceCurrency: "INR",
}];

interface Options {
  apiKey: string;
  dbPath: string;
  livePurchases?: boolean;
  perPurchaseCapCents?: number;
  dailyCapCents?: number;
  totalCapCents?: number;
  mcpUrl?: string;
  fetchImpl?: typeof fetch;
  /** A server-owned hard allowlist. Catalog text cannot add purchasable products. */
  allowlist?: AllowedProduct[];
}

interface ProductDetail {
  id?: string;
  name?: string;
  country_code?: string;
  in_stock?: boolean;
  recipient_type?: string;
  packages?: Array<{ value?: string | number; package_value?: string; payment_price?: string; payment_currency?: string }>;
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
  private readonly fetchImpl: typeof fetch;
  private readonly mcpUrl: string;
  private readonly allowlist: AllowedProduct[];

  constructor(private readonly options: Options) {
    if (!options.apiKey) throw new Error("Bitrefill API key is required");
    if (options.dbPath !== ":memory:") mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
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
    this.allowlist = options.allowlist ?? DEFAULT_ALLOWLIST;
  }

  close(): void { this.db.close(); }

  async searchEligibleProducts(input: { country: string; category: string; maxSpendUsdCents: number }): Promise<RewardCandidate[]> {
    const result: RewardCandidate[] = [];
    for (const allowed of this.allowlist) {
      if (allowed.country !== input.country || allowed.category !== input.category) continue;
      const quote = await this.getLiveQuote(allowed);
      if (quote.available && !quote.requiresRecipientInput &&
          quote.quotedPrice.amountMinor <= input.maxSpendUsdCents &&
          quote.quotedPrice.amountMinor <= (this.options.perPurchaseCapCents ?? 55)) result.push(quote);
    }
    return result;
  }

  async getLiveQuote(input: { productId: string; packageValue: string }): Promise<RewardCandidate> {
    const allowed = this.allowlist.find((x) => x.productId === input.productId && x.packageValue === input.packageValue);
    if (!allowed) return unavailableQuote(input.productId, input.packageValue);
    const detail = await this.mcpTool<ProductDetail>("get-product-details", { product_id: allowed.productId, currency: "USD" });
    const pack = detail.packages?.find((x) => String(x.value ?? x.package_value) === allowed.packageValue);
    const recipient = detail.recipient_type !== "none";
    const valid = detail.id === allowed.productId && detail.country_code === allowed.country &&
      detail.in_stock === true && !!pack && pack.payment_currency === "USD";
    let cents = 0;
    if (valid) {
      try { cents = usdToCents(pack.payment_price ?? ""); } catch { /* Untrusted quote: unavailable. */ }
    }
    const face = Number(allowed.packageValue);
    return {
      productId: allowed.productId, packageValue: allowed.packageValue,
      title: detail.name ?? allowed.productId, category: allowed.category, country: allowed.country,
      quotedPrice: { amountMinor: cents, currency: "USD" },
      faceValue: Number.isSafeInteger(face) && face > 0 ? { amountMinor: face * 100, currency: allowed.faceCurrency } : undefined,
      requiresRecipientInput: recipient, available: valid && cents > 0,
    };
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
      ).get(req.claimId, req.approval.approvalId)) {
        this.db.exec("ROLLBACK");
        return reject("duplicate_attempt");
      }
      // Every attempt that may have charged counts, including uncertain ones. Only a
      // provably refused attempt is excluded.
      const all = this.db.prepare(
        "SELECT COALESCE(SUM(quoted_cents),0) AS cents FROM bitrefill_v2_attempts WHERE state <> 'REFUSED'",
      ).get() as { cents: number };
      const today = this.db.prepare(
        "SELECT COALESCE(SUM(quoted_cents),0) AS cents FROM bitrefill_v2_attempts WHERE state <> 'REFUSED' AND created_at >= ?",
      ).get(new Date().setUTCHours(0, 0, 0, 0)) as { cents: number };
      if (all.cents + cents > (this.options.totalCapCents ?? 500) ||
          today.cents + cents > (this.options.dailyCapCents ?? 500)) {
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
      i.orders[0].value === req.packageValue && i.orders[0].currency === allowed.faceCurrency);
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
          order.product.currency === allowed.faceCurrency && order.payment_method === "balance" &&
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
    const info = detail.orders[0].redemption_info;
    if (info == null) return null;
    return { display: typeof info === "string" ? info : JSON.stringify(info) };
  }

  private allowed(productId: string, packageValue: string): AllowedProduct | undefined {
    return this.allowlist.find((x) => x.productId === productId && x.packageValue === packageValue);
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
