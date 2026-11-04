import assert from "node:assert/strict";
import { encode as encodeToon } from "@toon-format/toon";

// Recorded Bitrefill MCP transport. Read-only reply shapes mirror the live replies
// observed on 4 Nov 2026 (SSE JSON-RPC, TOON text content): get-product-details,
// list-invoices, get-invoice-by-id, get-balances, and an HTTP 401 for a bad key.
// The buy-products reply is synthetic: the original live response was not retained.
// No values here are real: invoice ids, codes and tokens are fixtures.

export const FIXTURE_KEY = "fixture-api-key-DO-NOT-LEAK";
export const FIXTURE_CODE = "SECRET-VOUCHER-0000";
export const FIXTURE_ACCESS_TOKEN = "SECRET-ACCESS-TOKEN-0000";

export type BuyMode = "ok" | "lose" | "http401" | "http500" | "toolError" | "noInvoiceId";

export interface RecordedInvoice { id: string; created: string; price: string }

export class RecordedTransport {
  /** buy-products calls that reached the transport (money-moving). */
  moneyCalls = 0;
  calls: string[] = [];
  buyMode: BuyMode = "ok";
  /** One-shot override for the next buy only. */
  nextBuyMode: BuyMode | null = null;
  quotePrice = "0.55";
  invoicePrice = "0.55";
  /** USD balance in cents; null makes get-balances fail. */
  balanceCents: number | null = 2500;
  invoices: RecordedInvoice[] = [];
  /** Replace the list-invoices reply payload (or raw text when a string). */
  listOverride: ((invoices: unknown[]) => unknown) | null = null;
  /** Mutate the get-invoice-by-id payload before it is sent. */
  detailOverride: ((detail: Record<string, unknown>) => void) | null = null;
  private seq = 0;

  fetch: typeof fetch = async (_url, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${FIXTURE_KEY}`);
    const request = JSON.parse(String(init?.body));
    const { name, arguments: args } = request.params;
    this.calls.push(name);
    if (name === "get-product-details") {
      return mcp({ id: "swiggy-money-india", name: "Swiggy Money India", country_code: "IN",
        in_stock: true, recipient_type: "none", packages: [
          { package_value: "50", payment_price: this.quotePrice, payment_currency: "USD" },
        ] }, true);
    }
    if (name === "get-balances") {
      assert.deepEqual(args, { currency: "USD" });
      if (this.balanceCents === null) return new Response("upstream error", { status: 502 });
      return mcp({ balances: [{ payment_method: "balance", balance_currency: "USD",
        amount: (this.balanceCents / 100).toFixed(2), amount_base: this.balanceCents, decimals: 2,
        equivalent_eur: { amount: "0.00", amount_base: 0, decimals: 2, currency: "EUR" } }],
      top_up: [], agent_instructions: "untrusted text" }, true);
    }
    if (name === "buy-products") {
      this.moneyCalls++;
      assert.deepEqual(args, { cart_items: [{ product_id: "swiggy-money-india", package_value: "50" }],
        payment_method: "balance", balance_currency: "USD" });
      const mode = this.nextBuyMode ?? this.buyMode;
      this.nextBuyMode = null;
      if (mode === "http401") return new Response("Unauthorized", { status: 401 });
      if (mode === "toolError") {
        // Tool ran and reported an error. We cannot prove no invoice was created.
        return rpc({ isError: true, content: [{ type: "text", text: "Insufficient balance" }] });
      }
      const id = `invoice-${String(++this.seq).padStart(4, "0")}`;
      this.invoices.push({ id, created: new Date().toISOString(), price: this.invoicePrice });
      if (mode === "lose") throw new DOMException("response lost", "TimeoutError");
      if (mode === "http500") return new Response("Internal error", { status: 500 });
      if (mode === "noInvoiceId") return mcp({ response: { status: "created" }, agent_instructions: "untrusted" });
      return mcp({ response: { invoice_id: id, access_token: FIXTURE_ACCESS_TOKEN }, agent_instructions: "untrusted text" });
    }
    if (name === "list-invoices") {
      const invoices = this.invoices.filter((x) => Date.parse(x.created) >= Date.parse(args.after)).map((x) => ({
        invoice_id: x.id, invoice_status: "complete", created_time: x.created,
        orders: [{ product_id: "swiggy-money-india", value: "50", currency: "INR" }],
      }));
      if (this.listOverride) {
        const payload = this.listOverride(invoices);
        return typeof payload === "string" ? rpc({ content: [{ type: "text", text: payload }] }) : mcp(payload, true);
      }
      return mcp({ invoices, count: invoices.length, page: { newest: "", oldest: "" } }, true);
    }
    if (name === "get-invoice-by-id") {
      const invoice = this.invoices.find((x) => x.id === args.invoice_id);
      if (!invoice) return rpc({ isError: true, content: [{ type: "text", text: "not found" }] });
      const detail: Record<string, unknown> = { invoice_id: invoice.id, invoice_status: "complete",
        created_time: invoice.created.replace("Z", "+00:00"), access_token: FIXTURE_ACCESS_TOKEN,
        payment_link: `https://example.invalid/pay?token=${FIXTURE_ACCESS_TOKEN}`,
        detected_payment_info: { method: "balance", currency: "USD", price: invoice.price, status: "complete" },
        orders: [{ product: { id: "swiggy-money-india", value: "50", currency: "INR" },
          payment_method: "balance", status: "delivered", redemption_info: { code: FIXTURE_CODE } }],
      };
      this.detailOverride?.(detail);
      return mcp(detail, true);
    }
    throw new Error(`Unexpected tool ${name}`);
  };
}

function rpc(result: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`,
    { headers: { "content-type": "text/event-stream" } });
}

export function mcp(payload: unknown, toon = false): Response {
  return rpc({ content: [{ type: "text", text: toon ? encodeToon(payload) : JSON.stringify(payload) }] });
}
