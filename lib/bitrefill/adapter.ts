import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decode as decodeToon } from "@toon-format/toon";
import type { BitrefillAdapter, PurchaseOrderStatus, RewardProduct } from "../providers/types";

const PRODUCT_ID = "swiggy-money-india";
const PACKAGE_VALUE = 50;
const REWARD_ID = `${PRODUCT_ID}:${PACKAGE_VALUE}`;

interface Options {
  apiKey: string;
  dbPath: string;
  /** Defaults to true. Live balance spending requires an explicit false. */
  livePurchases?: boolean;
  perPurchaseCapCents?: number;
  dailyCapCents?: number;
  totalCapCents?: number;
  baseUrl?: string;
  mcpUrl?: string;
  /** Deprecated compatibility option; MCP quotes and purchases explicitly use USD. */
  accountPricesAreUsd?: boolean;
  fetchImpl?: typeof fetch;
}

interface ProductDetail {
  id: string;
  name: string;
  country_code: string;
  in_stock: boolean;
  recipient_type: string;
  packages: Array<{
    value?: string | number;
    package_value?: string;
    payment_price?: string;
    payment_currency?: string;
  }>;
}

interface Invoice {
  id: string;
  status: string;
  orders?: Array<{ id: string; status: string }>;
}

interface Attempt {
  state: string;
  invoice_id: string | null;
  reward_id: string;
  quoted_cents: number;
  created_at: number;
}

interface ListedInvoice {
  invoice_id: string;
  invoice_status?: string;
  created_time: string;
  orders?: Array<{ product_id?: string; value?: string; currency?: string }>;
}

interface McpInvoiceDetail {
  invoice_id?: string;
  invoice_status?: string;
  created_time?: string;
  detected_payment_info?: { method?: string; currency?: string; price?: string; status?: string };
  orders?: Array<{
    product?: { id?: string; value?: string; currency?: string };
    payment_method?: string;
  }>;
}

export function usdToCents(value: string | number): number {
  const match = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error("Invalid USD price from Bitrefill");
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("USD price is too large");
  return Number(cents);
}

/** A human-only local operation. Never expose this method as an agent or player API. */
export function approveOnePurchase(dbPath: string, maxPriceCents: number, expiresAt: number): void {
  if (!Number.isSafeInteger(maxPriceCents) || maxPriceCents <= 0 || maxPriceCents > 500) {
    throw new Error("Approval cap must be between 1 and 500 cents");
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Approval expiry must be in the future");
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    initialize(db);
    db.prepare(
      "INSERT INTO bitrefill_approvals (reward_id, max_price_cents, expires_at, used_at) VALUES (?, ?, ?, NULL)",
    ).run(REWARD_ID, maxPriceCents, expiresAt);
  } finally {
    db.close();
  }
}

function initialize(db: DatabaseSync): void {
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec(`CREATE TABLE IF NOT EXISTS bitrefill_approvals (
    id INTEGER PRIMARY KEY,
    reward_id TEXT NOT NULL,
    max_price_cents INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS bitrefill_attempts (
    claim_id TEXT PRIMARY KEY,
    reward_id TEXT NOT NULL,
    quoted_cents INTEGER NOT NULL,
    state TEXT NOT NULL,
    invoice_id TEXT,
    created_at INTEGER NOT NULL
  );`);
}

/** Bitrefill MCP purchase adapter. It cannot purchase until a human records a one-use approval. */
export class RestBitrefillAdapter implements BitrefillAdapter {
  private readonly db: DatabaseSync;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly mcpUrl: string;

  constructor(private readonly options: Options) {
    if (!options.apiKey) throw new Error("Bitrefill API key is required");
    if (options.dbPath !== ":memory:") mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new DatabaseSync(options.dbPath);
    initialize(this.db);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.bitrefill.com/v2";
    this.mcpUrl = options.mcpUrl ?? "https://api.bitrefill.com/mcp";
  }

  close(): void { this.db.close(); }

  async searchEligibleProducts(input: { country: string; category: string; maxPriceCents: number }): Promise<RewardProduct[]> {
    if (input.country !== "IN" || input.category !== "food") return [];
    const product = await this.getProduct();
    const priceCents = packagePrice(product);
    if (priceCents > input.maxPriceCents || priceCents > (this.options.perPurchaseCapCents ?? 500)) return [];
    if (this.options.livePurchases && !this.getApproval(priceCents)) return [];
    return [{ productId: REWARD_ID, name: "Swiggy Money ₹50", category: "food", priceCents }];
  }

  async purchaseApprovedReward(input: {
    claimId: string;
    productId: string;
    expectedMaxPriceCents: number;
  }): Promise<{ invoiceId: string; status: string }> {
    if (!this.options.livePurchases) throw new Error("Bitrefill purchases are disabled (dry run)");
    if (!input.claimId || input.productId !== REWARD_ID) throw new Error("Product is not allowlisted");
    const prior = this.db.prepare(
      "SELECT state, invoice_id, reward_id, quoted_cents, created_at FROM bitrefill_attempts WHERE claim_id = ?",
    ).get(input.claimId) as Attempt | undefined;
    if (prior) {
      if (prior.invoice_id) return { invoiceId: prior.invoice_id, status: prior.state };
      return this.reconcileReservedPurchase(input.claimId);
    }

    // Reprice immediately before spending. The proposal's price is a ceiling,
    // never authority to buy an unavailable or more expensive package.
    const product = await this.getProduct();
    const priceCents = packagePrice(product);
    const cap = Math.min(input.expectedMaxPriceCents, this.options.perPurchaseCapCents ?? 500);
    if (!Number.isSafeInteger(cap) || priceCents > cap) throw new Error("Bitrefill price exceeds approved maximum");

    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM bitrefill_attempts WHERE claim_id = ?").get(input.claimId)) {
        throw new Error("Duplicate purchase attempt");
      }
      const approval = this.getApproval(priceCents);
      if (!approval) throw new Error("No one-use approval for this product and price");
      const all = this.db.prepare(
        "SELECT COALESCE(SUM(quoted_cents),0) AS cents FROM bitrefill_attempts",
      ).get() as { cents: number };
      const today = this.db.prepare(
        "SELECT COALESCE(SUM(quoted_cents),0) AS cents FROM bitrefill_attempts WHERE created_at >= ?",
      ).get(new Date().setUTCHours(0, 0, 0, 0)) as { cents: number };
      if (all.cents + priceCents > (this.options.totalCapCents ?? 2500) ||
          today.cents + priceCents > (this.options.dailyCapCents ?? 500)) {
        throw new Error("Bitrefill spending ceiling reached");
      }
      this.db.prepare("UPDATE bitrefill_approvals SET used_at = ? WHERE id = ?").run(now, approval.id);
      this.db.prepare(
        "INSERT INTO bitrefill_attempts (claim_id, reward_id, quoted_cents, state, invoice_id, created_at) VALUES (?, ?, ?, 'RESERVED', NULL, ?)",
      ).run(input.claimId, REWARD_ID, priceCents, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    // A crash after this POST leaves RESERVED in the database. Never replay it.
    const purchase = await this.mcpTool<unknown>("buy-products", {
      cart_items: [{ product_id: PRODUCT_ID, package_value: String(PACKAGE_VALUE) }],
      payment_method: "balance",
      balance_currency: "USD",
    });
    const invoice = purchase && typeof purchase === "object" && "response" in purchase
      ? (purchase as { response: unknown }).response : purchase;
    if (!invoice || typeof invoice !== "object" ||
        !("invoice_id" in invoice) || typeof invoice.invoice_id !== "string") {
      throw new Error(`Bitrefill buy-products returned no invoice ID; payload keys=${safeKeys(purchase)}; reconcile before retrying`);
    }
    const status = "status" in invoice && typeof invoice.status === "string" ? invoice.status : "pending";
    this.db.prepare(
      "UPDATE bitrefill_attempts SET invoice_id = ?, state = ? WHERE claim_id = ?",
    ).run(invoice.invoice_id, status, input.claimId);
    return { invoiceId: invoice.invoice_id, status };
  }

  /** Read-only provider lookup; only the local invoice association is changed. Never calls buy-products. */
  async reconcileReservedPurchase(claimId: string): Promise<{ invoiceId: string; status: string }> {
    const attempt = this.db.prepare(
      "SELECT state, invoice_id, reward_id, quoted_cents, created_at FROM bitrefill_attempts WHERE claim_id = ?",
    ).get(claimId) as Attempt | undefined;
    if (!attempt || attempt.reward_id !== REWARD_ID) throw new Error("No matching Bitrefill purchase attempt");
    if (attempt.invoice_id) return { invoiceId: attempt.invoice_id, status: attempt.state };
    if (attempt.state !== "RESERVED") throw new Error("Bitrefill attempt is not reserved");
    const listing = await this.mcpTool<{ invoices?: ListedInvoice[]; count?: number }>("list-invoices", {
      limit: 20,
      after: new Date(attempt.created_at).toISOString(),
      include_orders: true,
    });
    if (!Array.isArray(listing.invoices)) throw new Error(`Bitrefill invoice list has no invoices array; payload keys=${safeKeys(listing)}`);
    if (listing.invoices.length >= 20 || (typeof listing.count === "number" && listing.count > listing.invoices.length)) {
      throw new Error("Bitrefill invoice list is incomplete; cannot reconcile safely");
    }
    const candidates = listing.invoices.filter((invoice) =>
      typeof invoice.invoice_id === "string" &&
      Number.isFinite(Date.parse(invoice.created_time)) &&
      Date.parse(invoice.created_time) >= attempt.created_at &&
      invoice.orders?.length === 1 &&
      invoice.orders[0]?.product_id === PRODUCT_ID &&
      invoice.orders[0]?.value === String(PACKAGE_VALUE) &&
      invoice.orders[0]?.currency === "INR");
    if (candidates.length !== 1) throw new Error(`Bitrefill reconciliation found ${candidates.length} candidate invoices; expected exactly one`);
    const match = candidates[0];
    // The history summary does not contain the USD charge. Verify the invoice
    // itself before adopting it; never correlate a paid order by time alone.
    const detail = await this.mcpTool<McpInvoiceDetail>("get-invoice-by-id", { invoice_id: match.invoice_id });
    const payment = detail.detected_payment_info;
    const order = detail.orders?.[0];
    if (detail.invoice_id !== match.invoice_id || !detail.created_time ||
        !Number.isFinite(Date.parse(detail.created_time)) ||
        Date.parse(detail.created_time) !== Date.parse(match.created_time) ||
        detail.orders?.length !== 1 || order?.product?.id !== PRODUCT_ID ||
        order.product.value !== String(PACKAGE_VALUE) || order.product.currency !== "INR" ||
        order.payment_method !== "balance" || payment?.method !== "balance" ||
        payment.currency !== "USD" || payment.status !== "complete" ||
        !payment.price || usdToCents(payment.price) !== attempt.quoted_cents) {
      throw new Error("Bitrefill invoice details do not match the reserved product, denomination, USD charge, and payment method");
    }
    const status = detail.invoice_status ?? match.invoice_status ?? "pending";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Another unresolved claim could plausibly own this invoice. The provider
      // supplies no claim correlation key, so overlapping attempts need review.
      if (this.db.prepare(
        `SELECT 1 FROM bitrefill_attempts
         WHERE claim_id <> ? AND reward_id = ? AND quoted_cents = ?
           AND invoice_id IS NULL AND created_at <= ? LIMIT 1`,
      ).get(claimId, attempt.reward_id, attempt.quoted_cents, Date.parse(match.created_time))) {
        throw new Error("Bitrefill invoice overlaps another unresolved purchase attempt; operator review required");
      }
      if (this.db.prepare("SELECT 1 FROM bitrefill_attempts WHERE invoice_id = ? AND claim_id <> ?").get(match.invoice_id, claimId)) {
        throw new Error("Bitrefill invoice is already associated with another claim");
      }
      const result = this.db.prepare(
        "UPDATE bitrefill_attempts SET invoice_id = ?, state = ? WHERE claim_id = ? AND invoice_id IS NULL AND state = 'RESERVED'",
      ).run(match.invoice_id, status, claimId);
      if (result.changes !== 1) throw new Error("Bitrefill attempt changed during reconciliation");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { invoiceId: match.invoice_id, status };
  }

  async getOrderStatus(invoiceId: string): Promise<PurchaseOrderStatus> {
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(invoiceId)) throw new Error("Invalid invoice ID");
    const invoice = await this.api<Invoice>("GET", `/invoices/${invoiceId}`);
    if (["blocked", "denied", "payment_error"].includes(invoice.status)) return { status: "failed" };
    const order = invoice.orders?.[0];
    if (!order?.id) return { status: "pending" };
    const detail = await this.api<{ status: string; redemption_info?: unknown }>("GET", `/orders/${order.id}`);
    if (detail.status === "delivered") {
      return { status: "delivered", redemptionData: typeof detail.redemption_info === "string"
        ? detail.redemption_info : JSON.stringify(detail.redemption_info ?? {}) };
    }
    if (["failed", "refunded"].includes(detail.status)) return { status: "failed" };
    return { status: "pending" };
  }

  private getApproval(priceCents: number): { id: number } | undefined {
    return this.db.prepare(
      `SELECT id FROM bitrefill_approvals
       WHERE reward_id = ? AND max_price_cents >= ? AND expires_at > ? AND used_at IS NULL
       ORDER BY id LIMIT 1`,
    ).get(REWARD_ID, priceCents, Date.now()) as { id: number } | undefined;
  }

  private async getProduct(): Promise<ProductDetail> {
    return this.mcpTool<ProductDetail>("get-product-details", {
      product_id: PRODUCT_ID,
      currency: "USD",
    });
  }

  private async mcpTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    let response: Response;
    try { response = await this.fetchImpl(this.mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(15_000),
    }); }
    catch (error) {
      const kind = error instanceof Error ? error.name : "unknown";
      throw new Error(`Bitrefill MCP ${name} request ${kind === "TimeoutError" || kind === "AbortError" ? "timed out" : `failed (${kind})`}`);
    }
    if (!response.ok) throw new Error(`Bitrefill MCP ${name} returned HTTP ${response.status}`);
    let raw: string;
    try { raw = await response.text(); }
    catch (error) {
      const kind = error instanceof Error ? error.name : "unknown";
      throw new Error(`Bitrefill MCP ${name} response ${kind === "TimeoutError" || kind === "AbortError" ? "timed out" : `failed (${kind})`}`);
    }
    const eventData = raw.startsWith("event:") || raw.startsWith("data:")
      ? raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).at(-1)?.slice(5).trim()
      : raw;
    let message: { result?: { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: unknown }; error?: unknown };
    try { message = JSON.parse(eventData ?? ""); }
    catch { throw new Error(`Invalid Bitrefill MCP ${name} response; content-type=${response.headers.get("content-type") ?? "unknown"}`); }
    if (message.error || message.result?.isError) {
      throw new Error(`Bitrefill MCP ${name} failed; envelope keys=${safeKeys(message)}; result keys=${safeKeys(message.result)}; isError=${String(message.result?.isError ?? false)}`);
    }
    const structured = message.result?.structuredContent;
    if (structured && typeof structured === "object") return structured as T;
    const text = message.result?.content?.find((part) => part.type === "text")?.text;
    if (!text) throw new Error(`Bitrefill MCP ${name} returned no result; result keys=${safeKeys(message.result)}; isError=${String(message.result?.isError ?? false)}`);
    try { return JSON.parse(text) as T; }
    catch {
      try { return decodeToon(text) as T; }
      catch { throw new Error(`Bitrefill MCP ${name} returned unreadable data; result keys=${safeKeys(message.result)}; isError=${String(message.result?.isError ?? false)}`); }
    }
  }

  private async api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Bitrefill ${method} ${path} returned HTTP ${response.status}`);
    const payload = await response.json() as { data?: T };
    if (!payload.data) throw new Error("Bitrefill response has no data");
    return payload.data;
  }
}

function safeKeys(value: unknown): string {
  return value && typeof value === "object" ? Object.keys(value).slice(0, 20).join(",") : "none";
}

function packagePrice(product: ProductDetail): number {
  if (product.id !== PRODUCT_ID || product.country_code !== "IN" ||
      !product.in_stock || product.recipient_type !== "none" ||
      !Array.isArray(product.packages)) throw new Error("Swiggy ₹50 reward is unavailable");
  const pack = product.packages.find((p) => String(p.value ?? p.package_value) === String(PACKAGE_VALUE));
  if (!pack || pack.payment_currency !== "USD") {
    throw new Error("Swiggy ₹50 USD package is unavailable");
  }
  const cents = usdToCents(pack.payment_price ?? "");
  if (cents <= 0) throw new Error("Invalid Bitrefill package price");
  return cents;
}
