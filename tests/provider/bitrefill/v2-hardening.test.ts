import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { McpBitrefillAdapterV2 } from "../../../lib/bitrefill/v2";
import type { CompetingAttempt, PurchaseRequest, ReconcileRequest } from "../../../lib/providers/v2";
import { FIXTURE_ACCESS_TOKEN, FIXTURE_CODE, FIXTURE_KEY, RecordedTransport } from "./transport";

const PRICE = { amountMinor: 55, currency: "USD" as const };

function adapter(t: RecordedTransport, dbPath = ":memory:", over: Partial<ConstructorParameters<typeof McpBitrefillAdapterV2>[0]> = {}) {
  return new McpBitrefillAdapterV2({ apiKey: FIXTURE_KEY, dbPath, livePurchases: true, fetchImpl: t.fetch, ...over });
}

function purchase(attemptId: string, over: Partial<PurchaseRequest["approval"]> & { claimId?: string } = {}): PurchaseRequest {
  const { claimId, ...approval } = over;
  return { attemptId, claimId: claimId ?? `claim-${attemptId}`, productId: "swiggy-money-india", packageValue: "50",
    approval: { approvalId: `approval-${attemptId}`, productId: "swiggy-money-india", packageValue: "50",
      maxSpendUsdCents: 55, expiresAt: Date.now() + 60_000, ...approval } };
}

function reconcile(attemptId: string, startedAt: number, over: Partial<ReconcileRequest> = {}): ReconcileRequest {
  return { attemptId, claimId: `claim-${attemptId}`, productId: "swiggy-money-india", packageValue: "50",
    quotedPrice: PRICE, startedAt, excludeInvoiceIds: [], competingAttempts: [], ...over };
}

function competitor(attemptId: string, startedAt: number, over: Partial<CompetingAttempt> = {}): CompetingAttempt {
  return { attemptId, productId: "swiggy-money-india", packageValue: "50", quotedPrice: PRICE, startedAt, ...over };
}

function tempDb(): { path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zechunt-bitrefill-v2-"));
  return { path: join(dir, "bitrefill.db"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─────────────────────── restart and lost responses ───────────────────────

test("restart on the same SQLite file: a lost response is never re-bought and reconciles once", async () => {
  const db = tempDb();
  const t = new RecordedTransport();
  const start = Date.now() - 1;
  const a1 = adapter(t, db.path);
  t.nextBuyMode = "lose";
  assert.equal((await a1.purchaseApprovedReward(purchase("r1"))).kind, "uncertain");
  a1.close();

  // Process restart: new adapter instance, same file. The app retries the same attempt.
  const a2 = adapter(t, db.path);
  const retry = await a2.purchaseApprovedReward(purchase("r1"));
  assert.deepEqual(retry, { kind: "uncertain", attemptId: "r1", reasonCode: "provider_error" });
  assert.equal(t.moneyCalls, 1, "retry after a lost response must not call buy-products");
  const found = await a2.reconcileAttempt(reconcile("r1", start));
  assert.equal(found.kind, "matched");
  a2.close();

  // Second restart, freeze switch on: the attempt still reads as invoiced, not rejected.
  const a3 = adapter(t, db.path, { livePurchases: false });
  const after = await a3.purchaseApprovedReward(purchase("r1"));
  assert.equal(after.kind, "invoiced");
  if (found.kind === "matched" && after.kind === "invoiced") assert.equal(after.invoiceId, found.invoiceId);
  assert.equal(t.moneyCalls, 1);
  a3.close();
  db.done();
});

test("a prior uncertain attempt stays uncertain when purchases are frozen or the allowlist changes", async () => {
  const db = tempDb();
  const t = new RecordedTransport();
  const a1 = adapter(t, db.path);
  t.nextBuyMode = "lose";
  await a1.purchaseApprovedReward(purchase("f1"));
  a1.close();
  const frozen = adapter(t, db.path, { livePurchases: false });
  assert.equal((await frozen.purchaseApprovedReward(purchase("f1"))).kind, "uncertain");
  frozen.close();
  const delisted = adapter(t, db.path, { allowlist: [] });
  assert.equal((await delisted.purchaseApprovedReward(purchase("f1"))).kind, "uncertain");
  delisted.close();
  assert.equal(t.moneyCalls, 1);
  db.done();
});

test("every post-call failure without proof of refusal is uncertain and never retried", async () => {
  for (const mode of ["lose", "http500", "toolError", "noInvoiceId"] as const) {
    const t = new RecordedTransport();
    const a = adapter(t);
    t.nextBuyMode = mode;
    const r = await a.purchaseApprovedReward(purchase(`u-${mode}`));
    assert.equal(r.kind, "uncertain", mode);
    assert.equal((await a.purchaseApprovedReward(purchase(`u-${mode}`))).kind, "uncertain", mode);
    assert.equal(t.moneyCalls, 1, mode);
    a.close();
  }
});

// ───────────────────────────── refusals ─────────────────────────────

test("insufficient balance is refused before buy-products; an unreadable balance refuses too", async () => {
  const t = new RecordedTransport();
  const a = adapter(t);
  t.balanceCents = 54;
  assert.deepEqual(await a.purchaseApprovedReward(purchase("bal-low")),
    { kind: "rejected", attemptId: "bal-low", reasonCode: "insufficient_balance" });
  t.balanceCents = null;
  assert.deepEqual(await a.purchaseApprovedReward(purchase("bal-err")),
    { kind: "rejected", attemptId: "bal-err", reasonCode: "unavailable" });
  t.balanceCents = 55;
  assert.equal((await a.purchaseApprovedReward(purchase("bal-ok"))).kind, "invoiced");
  assert.equal(t.moneyCalls, 1);
  a.close();
});

test("HTTP 401 on buy is a proven refusal: rejected, not re-bought, and not counted against caps", async () => {
  const t = new RecordedTransport();
  const a = adapter(t, ":memory:", { dailyCapCents: 55, totalCapCents: 55 });
  t.nextBuyMode = "http401";
  assert.deepEqual(await a.purchaseApprovedReward(purchase("auth")),
    { kind: "rejected", attemptId: "auth", reasonCode: "provider_refused" });
  assert.equal(t.invoices.length, 0);
  assert.deepEqual(await a.purchaseApprovedReward(purchase("auth")),
    { kind: "rejected", attemptId: "auth", reasonCode: "provider_refused" });
  assert.equal(t.moneyCalls, 1, "a refused attempt is answered from the ledger");
  assert.deepEqual(await a.reconcileAttempt(reconcile("auth", Date.now() - 60_000)), { kind: "not_found" });
  // The refused 55 cents did not consume the 55-cent cap.
  assert.equal((await a.purchaseApprovedReward(purchase("after-auth"))).kind, "invoiced");
  a.close();
});

// ─────────────────────────── quotes and approvals ───────────────────────────

test("a quote change between approval and purchase is re-checked against the approval", async () => {
  const t = new RecordedTransport();
  const a = adapter(t);
  t.quotePrice = "0.56";
  assert.deepEqual(await a.purchaseApprovedReward(purchase("up")),
    { kind: "rejected", attemptId: "up", reasonCode: "repriced_over_cap" });
  t.quotePrice = "0.50";
  assert.equal((await a.purchaseApprovedReward(purchase("down"))).kind, "invoiced");
  // An approval above the adapter's own per-purchase cap is still capped.
  t.quotePrice = "0.60";
  assert.deepEqual(await a.purchaseApprovedReward(purchase("big", { maxSpendUsdCents: 100 })),
    { kind: "rejected", attemptId: "big", reasonCode: "repriced_over_cap" });
  t.quotePrice = "garbage";
  assert.deepEqual(await a.purchaseApprovedReward(purchase("bad")),
    { kind: "rejected", attemptId: "bad", reasonCode: "unavailable" });
  assert.equal(t.moneyCalls, 1);
  a.close();
});

test("an approval id is single-use across attempts and claims", async () => {
  const t = new RecordedTransport();
  const a = adapter(t);
  assert.equal((await a.purchaseApprovedReward(purchase("ap1", { approvalId: "shared" }))).kind, "invoiced");
  assert.deepEqual(await a.purchaseApprovedReward(purchase("ap2", { approvalId: "shared" })),
    { kind: "rejected", attemptId: "ap2", reasonCode: "duplicate_attempt" });
  // The same attempt id replayed with a different approval is also refused.
  assert.deepEqual(await a.purchaseApprovedReward(purchase("ap1", { approvalId: "other" })),
    { kind: "rejected", attemptId: "ap1", reasonCode: "duplicate_attempt" });
  // A second attempt for the same claim is refused (one purchase per claim).
  assert.deepEqual(await a.purchaseApprovedReward(purchase("ap3", { claimId: "claim-ap1" })),
    { kind: "rejected", attemptId: "ap3", reasonCode: "duplicate_attempt" });
  assert.equal(t.moneyCalls, 1);
  a.close();
});

test("concurrent purchases for one attempt make exactly one buy call", async () => {
  const t = new RecordedTransport();
  const a = adapter(t);
  const results = await Promise.all([1, 2, 3].map(() => a.purchaseApprovedReward(purchase("race"))));
  assert.equal(t.moneyCalls, 1);
  assert.equal(results.filter((r) => r.kind === "invoiced").length, 1);
  a.close();
});

// ─────────────────────────────── caps ───────────────────────────────

test("daily and total caps count uncertain attempts and refuse before buying", async () => {
  const t = new RecordedTransport();
  const daily = adapter(t, ":memory:", { dailyCapCents: 110, totalCapCents: 500 });
  t.nextBuyMode = "lose";
  assert.equal((await daily.purchaseApprovedReward(purchase("d1"))).kind, "uncertain");
  assert.equal((await daily.purchaseApprovedReward(purchase("d2"))).kind, "invoiced");
  assert.deepEqual(await daily.purchaseApprovedReward(purchase("d3")),
    { kind: "rejected", attemptId: "d3", reasonCode: "spend_ceiling_reached" });
  assert.equal(t.moneyCalls, 2);
  daily.close();
});

test("yesterday's spend leaves the daily cap but still counts toward the total cap", async () => {
  const db = tempDb();
  const t = new RecordedTransport();
  const a1 = adapter(t, db.path, { dailyCapCents: 55, totalCapCents: 110 });
  assert.equal((await a1.purchaseApprovedReward(purchase("y1"))).kind, "invoiced");
  a1.close();
  const raw = new DatabaseSync(db.path);
  raw.prepare("UPDATE bitrefill_v2_attempts SET created_at = ?").run(Date.now() - 2 * 86_400_000);
  raw.close();
  const a2 = adapter(t, db.path, { dailyCapCents: 55, totalCapCents: 110 });
  assert.equal((await a2.purchaseApprovedReward(purchase("y2"))).kind, "invoiced");
  assert.deepEqual(await a2.purchaseApprovedReward(purchase("y3")),
    { kind: "rejected", attemptId: "y3", reasonCode: "spend_ceiling_reached" });
  assert.equal(t.moneyCalls, 2);
  a2.close();
  db.done();
});

test("search never offers a product above the adapter's per-purchase cap", async () => {
  const t = new RecordedTransport();
  const a = adapter(t, ":memory:", { perPurchaseCapCents: 54 });
  assert.deepEqual(await a.searchEligibleProducts({ country: "IN", category: "food", maxSpendUsdCents: 500 }), []);
  assert.deepEqual(await a.searchEligibleProducts({ country: "US", category: "food", maxSpendUsdCents: 500 }), []);
  a.close();
});

// ───────────────────────── reconciliation inputs ─────────────────────────

test("CR-1: app-supplied competing attempts block adoption even after the adapter ledger is lost", async () => {
  const t = new RecordedTransport();
  const lost = adapter(t);
  const start = Date.now() - 1;
  t.nextBuyMode = "lose";
  await lost.purchaseApprovedReward(purchase("cr1"));
  lost.close();

  const fresh = adapter(t); // Empty ledger: only the app's request carries evidence.
  const invoiceAt = Date.parse(t.invoices[0].created);
  for (const c of [competitor("other", start - 1), competitor("other", invoiceAt)]) {
    assert.equal((await fresh.reconcileAttempt(reconcile("cr1", start, { competingAttempts: [c] }))).kind, "ambiguous");
  }
  // Not competing: started after the invoice, a different price, a different package, or itself.
  for (const c of [competitor("later", invoiceAt + 1), competitor("cheaper", start, { quotedPrice: { amountMinor: 50, currency: "USD" } }),
    competitor("other-pack", start, { packageValue: "100" }), competitor("cr1", start)]) {
    assert.equal((await fresh.reconcileAttempt(reconcile("cr1", start, { competingAttempts: [c] }))).kind, "matched",
      `${c.attemptId} must not block`);
  }
  assert.equal(t.moneyCalls, 1);
  fresh.close();
});

test("an ambiguous result writes nothing to the ledger", async () => {
  const db = tempDb();
  const t = new RecordedTransport();
  const a = adapter(t, db.path);
  const start = Date.now() - 1;
  t.nextBuyMode = "lose";
  await a.purchaseApprovedReward(purchase("amb"));
  assert.equal((await a.reconcileAttempt(reconcile("amb", start, { competingAttempts: [competitor("x", start)] }))).kind, "ambiguous");
  const raw = new DatabaseSync(db.path);
  assert.deepEqual({ ...raw.prepare("SELECT state, invoice_id FROM bitrefill_v2_attempts WHERE attempt_id = 'amb'").get() },
    { state: "UNCERTAIN", invoice_id: null });
  raw.close();
  a.close();
  db.done();
});

test("excludeInvoiceIds removes an already-linked invoice from the candidates", async () => {
  const t = new RecordedTransport();
  const linkedApp = adapter(t);
  const start = Date.now() - 1;
  const first = await linkedApp.purchaseApprovedReward(purchase("e1"));
  assert.equal(first.kind, "invoiced");
  linkedApp.close();
  if (first.kind !== "invoiced") return;
  const other = adapter(t);
  t.nextBuyMode = "lose";
  await other.purchaseApprovedReward(purchase("e2"));
  // Both invoices are plausible for e2 until the app excludes the one it already linked.
  assert.equal((await other.reconcileAttempt(reconcile("e2", start))).kind, "ambiguous");
  const found = await other.reconcileAttempt(reconcile("e2", start, { excludeInvoiceIds: [first.invoiceId] }));
  assert.equal(found.kind, "matched");
  if (found.kind === "matched") assert.notEqual(found.invoiceId, first.invoiceId);
  assert.equal(t.moneyCalls, 2);
  other.close();
});

test("malformed or truncated invoice history is unavailable, never a match", async () => {
  const cases: Array<[string, (t: RecordedTransport) => void, string]> = [
    ["page full", (t) => { t.listOverride = (inv) => ({ invoices: Array.from({ length: 20 }, () => inv[0]), count: 20 }); }, "invoice_history_incomplete"],
    ["count exceeds page", (t) => { t.listOverride = (inv) => ({ invoices: inv, count: inv.length + 1 }); }, "invoice_history_incomplete"],
    ["invoices not a list", (t) => { t.listOverride = () => ({ invoices: "nope" }); }, "invoice_history_incomplete"],
    ["unparseable text", (t) => { t.listOverride = () => "{{not json or toon"; }, "invoice_history_lookup_failed"],
    ["detail lacks payment info", (t) => { t.detailOverride = (d) => { delete d.detected_payment_info; }; }, "invoice_detail_incomplete"],
    ["detail time differs", (t) => { t.detailOverride = (d) => { d.created_time = "2020-01-01T00:00:00Z"; }; }, "invoice_detail_incomplete"],
    ["detail id differs", (t) => { t.detailOverride = (d) => { d.invoice_id = "invoice-9999"; }; }, "invoice_detail_incomplete"],
    ["detail price unreadable", (t) => { t.detailOverride = (d) => { (d.detected_payment_info as { price: string }).price = "fifty"; }; }, "invoice_price_unreadable"],
  ];
  for (const [label, setup, reasonCode] of cases) {
    const t = new RecordedTransport();
    const a = adapter(t);
    const start = Date.now() - 1;
    t.nextBuyMode = "lose";
    await a.purchaseApprovedReward(purchase("m1"));
    setup(t);
    assert.deepEqual(await a.reconcileAttempt(reconcile("m1", start)), { kind: "unavailable", reasonCode }, label);
    assert.equal(t.moneyCalls, 1, label);
    a.close();
  }
});

test("reconcile rejects malformed requests without calling the provider", async () => {
  const t = new RecordedTransport();
  const a = adapter(t);
  const bad: Array<Partial<ReconcileRequest>> = [
    { quotedPrice: { amountMinor: 55, currency: "INR" } }, { quotedPrice: { amountMinor: 0.55, currency: "USD" } },
    { productId: "amazon-in" }, { startedAt: Number.NaN },
    { competingAttempts: undefined as unknown as CompetingAttempt[] },
  ];
  for (const over of bad) {
    assert.deepEqual(await a.reconcileAttempt(reconcile("bad", Date.now(), over)), { kind: "unavailable", reasonCode: "invalid_request" });
  }
  assert.deepEqual(t.calls, []);
  a.close();
});

// ─────────────────────────────── redaction ───────────────────────────────

test("codes, access tokens and the API key never leave through results, errors or the ledger", async () => {
  const db = tempDb();
  const t = new RecordedTransport();
  const a = adapter(t, db.path);
  const start = Date.now() - 1;
  const seen: unknown[] = [];
  const capture = async (p: Promise<unknown>) => { try { seen.push(await p); } catch (e) { seen.push(String(e), (e as Error).stack); } };
  await capture(a.searchEligibleProducts({ country: "IN", category: "food", maxSpendUsdCents: 55 }));
  await capture(a.getLiveQuote({ productId: "swiggy-money-india", packageValue: "50" }));
  const bought = await a.purchaseApprovedReward(purchase("s1"));
  seen.push(bought);
  t.nextBuyMode = "lose";
  await capture(a.purchaseApprovedReward(purchase("s2")));
  await capture(a.reconcileAttempt(reconcile("s2", start, { excludeInvoiceIds: bought.kind === "invoiced" ? [bought.invoiceId] : [] })));
  if (bought.kind === "invoiced") await capture(a.getOrderStatus(bought.invoiceId));
  await capture(a.getOrderStatus("../../etc/passwd")); // rejected id: throws a safe error
  t.nextBuyMode = "http500";
  await capture(a.purchaseApprovedReward(purchase("s3")));
  a.close();
  const ledger = readFileSync(db.path).toString("latin1");
  const text = JSON.stringify(seen) + ledger;
  for (const secret of [FIXTURE_KEY, FIXTURE_CODE, FIXTURE_ACCESS_TOKEN]) {
    assert.ok(!text.includes(secret), `leaked ${secret.slice(0, 12)}…`);
  }
  // getRedemption is the one deliberate exit, and it carries the code only.
  const b = adapter(t, db.path);
  if (bought.kind === "invoiced") {
    const r = await b.getRedemption(bought.invoiceId);
    assert.deepEqual(r, { display: JSON.stringify({ code: FIXTURE_CODE }) });
    assert.ok(!JSON.stringify(r).includes(FIXTURE_ACCESS_TOKEN));
  }
  b.close();
  db.done();
});
