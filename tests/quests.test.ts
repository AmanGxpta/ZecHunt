import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../lib/db";

// Tests never call the model; the rule-based recommender stands in.
process.env.ZECHUNT_AGENT = "off";
import { DomainError } from "../lib/errors";
import { MockBitrefillAdapter, MockZcashAdapter } from "../lib/providers/mock";
import { PurchaseRejectedError, type BitrefillAdapter } from "../lib/providers/types";
import { checkSpend } from "../lib/policy/spend-guard";
import {
  createQuest,
  fulfillClaim,
  getClaimStatus,
  listRewardOptions,
  CHECKPOINT_LIMITS,
  getCheckpointCode,
  reconcileFulfillments,
  reserveWinnerSlot,
  submitCheckpoint,
  syncFunding,
} from "../lib/quests/service";
import { CODE_WINDOW_MS, currentCode, verifyCode } from "../lib/quests/checkpoint";

process.env.BITREFILL_CREDIT_USD = "25";
process.env.ZECHUNT_SECRET = "test-secret";

function setup() {
  const db = openDatabase(":memory:");
  const zcash = new MockZcashAdapter();
  const bitrefill = new MockBitrefillAdapter();
  return { db, zcash, bitrefill };
}

async function fundedQuest(ctx: ReturnType<typeof setup>, category = "food", capCents = 500) {
  const created = await createQuest(ctx.db, ctx.zcash, {
    title: "Find the hidden QR",
    clue: "Look where the coffee is",
    rewardCategory: category,
    rewardCapCents: capCents,
  });
  ctx.zcash.simulateFunding(created.quest.id, BigInt(1_000_000));
  const synced = await syncFunding(ctx.db, ctx.zcash, created.quest.id, created.creatorToken);
  assert.equal(synced.status, "active");
  return { ...created, questId: created.quest.id };
}

/** What the checkpoint volunteer's screen shows right now. */
function codeOf(ctx: ReturnType<typeof setup>, questId: string, now = Date.now()) {
  const { checkpoint_nonce } = ctx.db.prepare("SELECT checkpoint_nonce FROM quests WHERE id = ?").get(questId) as {
    checkpoint_nonce: string;
  };
  return currentCode(questId, checkpoint_nonce, now).code;
}

function wrongCode(right: string) {
  return right === "000000" ? "111111" : "000000";
}

async function winAs(ctx: ReturnType<typeof setup>, questId: string, code: string, session: string, now = Date.now()) {
  const { claimToken } = submitCheckpoint(ctx.db, questId, code, session, { now });
  const reserved = reserveWinnerSlot(ctx.db, questId, claimToken, session, now);
  if ("error" in reserved) return reserved;
  return fulfillClaim(ctx.db, ctx.bitrefill, reserved.claimId, { now });
}

test("creation validates input and stores no plaintext secrets", async () => {
  const ctx = setup();
  await assert.rejects(
    createQuest(ctx.db, ctx.zcash, { title: "x", clue: "c", rewardCategory: "food", rewardCapCents: 300 }),
    (e: unknown) => e instanceof DomainError && e.code === "invalid_title",
  );
  await assert.rejects(
    createQuest(ctx.db, ctx.zcash, { title: "Good title", clue: "c", rewardCategory: "cars", rewardCapCents: 300 }),
    (e: unknown) => e instanceof DomainError && e.code === "invalid_category",
  );
  await assert.rejects(
    createQuest(ctx.db, ctx.zcash, { title: "Good title", clue: "c", rewardCategory: "food", rewardCapCents: 501 }),
    (e: unknown) => e instanceof DomainError && e.code === "invalid_reward_cap",
  );

  const created = await fundedQuest(ctx);
  const row = ctx.db.prepare("SELECT * FROM quests WHERE id = ?").get(created.questId) as Record<string, unknown>;
  for (const value of Object.values(row)) {
    assert.notEqual(value, created.creatorToken, "creator token must not be stored in plaintext");
    assert.notEqual(value, created.checkpointKey, "checkpoint key must not be stored in plaintext");
    assert.notEqual(value, codeOf(ctx, created.questId), "checkpoint code must not be stored");
  }
});

test("quest activates only once confirmed funding reaches the threshold, and outputs count once", async () => {
  const ctx = setup();
  const created = await createQuest(ctx.db, ctx.zcash, {
    title: "Find the hidden QR", clue: "c", rewardCategory: "food", rewardCapCents: 300,
  });
  const id = created.quest.id;

  ctx.zcash.simulateFunding(id, BigInt(500_000));
  let q = await syncFunding(ctx.db, ctx.zcash, id, created.creatorToken);
  assert.equal(q.status, "awaiting_funding", "half the threshold must not activate");

  q = await syncFunding(ctx.db, ctx.zcash, id, created.creatorToken);
  assert.equal(q.status, "awaiting_funding", "re-syncing the same output must not double-count");

  ctx.zcash.simulateFunding(id, BigInt(500_000));
  q = await syncFunding(ctx.db, ctx.zcash, id, created.creatorToken);
  assert.equal(q.status, "active");
  assert.equal(q.fundedZatoshis, 1_000_000);
});

test("funding sync requires the creator token", async () => {
  const ctx = setup();
  const created = await createQuest(ctx.db, ctx.zcash, {
    title: "Find the hidden QR", clue: "c", rewardCategory: "food", rewardCapCents: 300,
  });
  await assert.rejects(
    syncFunding(ctx.db, ctx.zcash, created.quest.id, "wrong-token"),
    (e: unknown) => e instanceof DomainError && e.status === 403,
  );
});

test("rotating checkpoint code: current and previous window valid, older rejected", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  const { checkpoint_nonce: nonce } = ctx.db.prepare("SELECT checkpoint_nonce FROM quests WHERE id = ?").get(created.questId) as { checkpoint_nonce: string };
  const t = 10 * CODE_WINDOW_MS + 5;
  const code = currentCode(created.questId, nonce, t).code;
  assert.match(code, /^\d{6}$/);
  assert.ok(verifyCode(created.questId, nonce, code, t));
  assert.ok(verifyCode(created.questId, nonce, code, t + CODE_WINDOW_MS), "grace window");
  assert.ok(!verifyCode(created.questId, nonce, code, t + 2 * CODE_WINDOW_MS), "expired");
  assert.ok(!verifyCode(created.questId, nonce, `${code}9`, t));
});

test("checkpoint display needs the checkpoint key or creator token", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  assert.throws(() => getCheckpointCode(ctx.db, created.questId, { checkpointKey: "nope" }), (e: unknown) => e instanceof DomainError && e.status === 403);
  const viaKey = getCheckpointCode(ctx.db, created.questId, { checkpointKey: created.checkpointKey });
  const viaCreator = getCheckpointCode(ctx.db, created.questId, { creatorToken: created.creatorToken });
  assert.equal(viaKey.code, viaCreator.code);
  assert.equal(viaKey.code, codeOf(ctx, created.questId));
});

test("wrong guesses rate-limit that player, not everyone else", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  const wrong = wrongCode(codeOf(ctx, created.questId));
  for (let i = 0; i < CHECKPOINT_LIMITS.session.max; i++) {
    assert.throws(() => submitCheckpoint(ctx.db, created.questId, wrong, "griefer", { ip: "1.1.1.1" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_code");
  }
  assert.throws(
    () => submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "griefer", { ip: "1.1.1.1" }),
    (e: unknown) => e instanceof DomainError && e.code === "too_many_attempts",
  );
  // An honest player elsewhere still gets in.
  const ok = submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "honest", { ip: "2.2.2.2" });
  assert.ok(ok.claimToken);
});

test("rotating sessions from one IP are throttled per IP", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  const wrong = wrongCode(codeOf(ctx, created.questId));
  for (let i = 0; i < CHECKPOINT_LIMITS.ip.max; i++) {
    assert.throws(() => submitCheckpoint(ctx.db, created.questId, wrong, `s${i}`, { ip: "6.6.6.6" }));
  }
  assert.throws(
    () => submitCheckpoint(ctx.db, created.questId, wrong, "fresh-session", { ip: "6.6.6.6" }),
    (e: unknown) => e instanceof DomainError && e.code === "too_many_attempts",
  );
});

test("exactly one player wins; the second correct entry is rejected", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);

  // Both players pass the checkpoint before either claims: a real race.
  const alice = submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "alice");
  const bob = submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "bob");

  const first = reserveWinnerSlot(ctx.db, created.questId, alice.claimToken, "alice");
  assert.ok("claimId" in first);
  const aliceOutcome = await fulfillClaim(ctx.db, ctx.bitrefill, first.claimId);
  assert.equal(aliceOutcome.claimStatus, "delivered");
  assert.equal(aliceOutcome.purchase?.state, "DELIVERED");

  const second = reserveWinnerSlot(ctx.db, created.questId, bob.claimToken, "bob");
  assert.ok("error" in second);
  assert.equal(second.error, "quest_exhausted");

  // A new checkpoint attempt is refused once the quest is exhausted.
  assert.throws(
    () => submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "carol"),
    (e: unknown) => e instanceof DomainError && e.code === "quest_exhausted",
  );

  const quest = ctx.db.prepare("SELECT winners_claimed, status FROM quests WHERE id = ?").get(created.questId) as {
    winners_claimed: number; status: string;
  };
  assert.equal(quest.winners_claimed, 1);
  assert.equal(quest.status, "exhausted");
});

test("claim tokens are single-use", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "alice");
  const first = reserveWinnerSlot(ctx.db, created.questId, claimToken, "alice");
  assert.ok("claimId" in first);
  const replay = reserveWinnerSlot(ctx.db, created.questId, claimToken, "alice");
  assert.ok("error" in replay);
  assert.equal(replay.error, "invalid_token");
});

test("a claim token cannot be used by another session", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "alice");
  const stolen = reserveWinnerSlot(ctx.db, created.questId, claimToken, "mallory");
  assert.ok("error" in stolen);
  assert.equal(stolen.error, "invalid_token");
});

test("expired claim tokens are rejected", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  const t0 = 1_000_000;
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId, t0), "alice", { now: t0 });
  const late = reserveWinnerSlot(ctx.db, created.questId, claimToken, "alice", t0 + 11 * 60 * 1000);
  assert.ok("error" in late);
  assert.equal(late.error, "invalid_token");
});

test("spend guard denies each unsafe condition, in order", () => {
  const base = {
    questFunded: true,
    winnerSlotReserved: true,
    claimHasNoPurchase: true,
    productCategory: "food",
    requiredCategory: "food",
    quotedCents: 300,
    rewardCapCents: 500,
    creditRemainingCents: 2500,
  };
  assert.deepEqual(checkSpend(base), { ok: true });
  assert.deepEqual(checkSpend({ ...base, questFunded: false }), { ok: false, reason: "quest_not_funded" });
  assert.deepEqual(checkSpend({ ...base, claimHasNoPurchase: false }), { ok: false, reason: "duplicate_purchase" });
  assert.deepEqual(checkSpend({ ...base, productCategory: "gaming" }), { ok: false, reason: "category_mismatch" });
  assert.deepEqual(checkSpend({ ...base, quotedCents: 600 }), { ok: false, reason: "over_reward_cap" });
  assert.deepEqual(checkSpend({ ...base, creditRemainingCents: 200 }), { ok: false, reason: "insufficient_credit" });
});

test("spend guard denies when a product slips past the search filter", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx, "food", 300);
  const leaky: BitrefillAdapter = {
    async searchEligibleProducts() {
      return [{ productId: "leaky", name: "Leaky $9", category: "food", priceCents: 900 }];
    },
    purchaseApprovedReward: async () => {
      throw new Error("must not be called");
    },
    getOrderStatus: async () => ({ status: "delivered" }),
  };
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "alice");
  const r = reserveWinnerSlot(ctx.db, created.questId, claimToken, "alice");
  assert.ok("claimId" in r);
  const outcome = await fulfillClaim(ctx.db, leaky, r.claimId);
  assert.equal(outcome.claimStatus, "failed");
  assert.equal(outcome.reason, "no_eligible_product");
});

test("credit limit caps the reward budget across quests", async () => {
  const prior = process.env.BITREFILL_CREDIT_USD;
  process.env.BITREFILL_CREDIT_USD = "3";
  try {
    const ctx = setup();
    const created = await fundedQuest(ctx, "food", 500);
    // Cap is $5, credit is $3: the $4.54 product is excluded, the $2.84 (₹250) product is allowed.
    const outcome = await winAs(ctx, created.questId, codeOf(ctx, created.questId), "alice");
    assert.ok(!("error" in outcome));
    assert.equal(outcome.purchase?.priceCents, 284);
  } finally {
    process.env.BITREFILL_CREDIT_USD = prior;
  }
});

test("a failed purchase call is never retried blindly and is flagged for reconciliation", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  const flaky: BitrefillAdapter = {
    searchEligibleProducts: (input) => ctx.bitrefill.searchEligibleProducts(input),
    async purchaseApprovedReward() {
      throw new Error("timeout");
    },
    getOrderStatus: async () => ({ status: "delivered" }),
  };
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "alice");
  const r = reserveWinnerSlot(ctx.db, created.questId, claimToken, "alice");
  assert.ok("claimId" in r);
  const outcome = await fulfillClaim(ctx.db, flaky, r.claimId);
  assert.equal(outcome.claimStatus, "needs_reconciliation");
  assert.equal(outcome.purchase?.state, "NEEDS_RECONCILIATION");

  // Calling fulfillClaim again must not create a second purchase.
  const again = await fulfillClaim(ctx.db, ctx.bitrefill, r.claimId);
  assert.equal(again.purchase?.state, "NEEDS_RECONCILIATION");
  assert.equal(ctx.bitrefill.purchaseCalls, 0);
});

test("a duplicate fulfillment of a delivered claim keeps it delivered", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "alice");
  const r = reserveWinnerSlot(ctx.db, created.questId, claimToken, "alice");
  assert.ok("claimId" in r);
  const first = await fulfillClaim(ctx.db, ctx.bitrefill, r.claimId);
  assert.equal(first.claimStatus, "delivered");
  const second = await fulfillClaim(ctx.db, ctx.bitrefill, r.claimId);
  assert.equal(second.claimStatus, "delivered", "state must not be overwritten");
  assert.equal(second.reason, "duplicate_purchase");
});

test("reconciler flags stale PURCHASE_PENDING attempts but leaves fresh ones alone", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "alice");
  const r = reserveWinnerSlot(ctx.db, created.questId, claimToken, "alice");
  assert.ok("claimId" in r);
  const now = Date.now();
  // Simulate a crash after persisting intent but before calling Bitrefill.
  ctx.db.prepare(
    `INSERT INTO purchase_attempts (claim_id, product_id, product_name, quoted_cents, provider_mode, state, invoice_id, created_at, updated_at)
     VALUES (?, 'mock-food-3', 'Mock food voucher $3', 300, 'mock', 'PURCHASE_PENDING', NULL, ?, ?)`,
  ).run(r.claimId, now - 120_000, now - 120_000);
  ctx.db.prepare("UPDATE claims SET status = 'purchase_pending' WHERE id = ?").run(r.claimId);

  const summary = await reconcileFulfillments(ctx.db, ctx.bitrefill, { now });
  assert.equal(summary.flagged, 1);
  assert.equal(getClaimStatus(ctx.db, created.questId, "alice")?.claimStatus, "needs_reconciliation");
});

test("rupee caps convert to a USD-cent guard limit with margin; ₹50 can buy a ~$0.55 voucher", async () => {
  const ctx = setup();
  await assert.rejects(
    createQuest(ctx.db, ctx.zcash, { title: "Rupee quest", clue: "c", rewardCategory: "food", rewardCapInr: 77 }),
    (e: unknown) => e instanceof DomainError && e.code === "invalid_reward_cap",
  );
  const created = await createQuest(ctx.db, ctx.zcash, { title: "Rupee quest", clue: "c", rewardCategory: "food", rewardCapInr: 50 });
  assert.equal(created.quest.rewardCapInr, 50);
  assert.equal(created.quest.rewardCapCents, 63);
  ctx.zcash.simulateFunding(created.quest.id, BigInt(1_000_000));
  await syncFunding(ctx.db, ctx.zcash, created.quest.id, created.creatorToken);
  const outcome = await winAs(ctx, created.quest.id, codeOf(ctx, created.quest.id), "alice");
  assert.ok(!("error" in outcome));
  assert.equal(outcome.purchase?.priceCents, 55);
  assert.equal(outcome.purchase?.priceInr, 48);
});

test("an uncertain purchase is adopted from the provider's invoice history, never re-bought", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  let buys = 0;
  let reconciles = 0;
  const flaky: BitrefillAdapter = {
    searchEligibleProducts: (input) => ctx.bitrefill.searchEligibleProducts(input),
    async purchaseApprovedReward() { buys++; throw new Error("reply unreadable"); },
    getOrderStatus: async () => ({ status: "delivered", redemptionData: "SECRET" }),
    async reconcilePurchase(claimId) { reconciles++; return { invoiceId: `inv-${claimId}`, status: "complete" }; },
  };
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "alice");
  const r = reserveWinnerSlot(ctx.db, created.questId, claimToken, "alice");
  assert.ok("claimId" in r);
  const first = await fulfillClaim(ctx.db, flaky, r.claimId);
  assert.equal(first.claimStatus, "needs_reconciliation");

  const summary = await reconcileFulfillments(ctx.db, flaky);
  assert.equal(summary.adopted, 1);
  assert.equal(buys, 1, "reconciliation must never buy again");
  assert.equal(reconciles, 1);
  const after = getClaimStatus(ctx.db, created.questId, "alice");
  assert.equal(after?.claimStatus, "delivered");
  assert.equal(after?.purchase?.invoiceId, `inv-${r.claimId}`);

  // A second pass changes nothing.
  const again = await reconcileFulfillments(ctx.db, flaky);
  assert.equal(again.adopted, 0);
  assert.equal(reconciles, 1);
});

test("the winner picks a reward: options span winner's-choice categories, a forged pick changes nothing", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx, "any", 300);
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "alice");
  const r = reserveWinnerSlot(ctx.db, created.questId, claimToken, "alice");
  assert.ok("claimId" in r);
  const { options, recommendation } = await listRewardOptions(ctx.db, ctx.bitrefill, created.questId, "alice");
  assert.ok(new Set(options.map((o) => o.category)).size >= 3, "winner's choice spans categories");
  assert.ok(options.every((o) => o.priceCents <= 300));
  assert.ok(recommendation && options.some((o) => o.productId === recommendation.productId));
  await assert.rejects(listRewardOptions(ctx.db, ctx.bitrefill, created.questId, "mallory"),
    (e: unknown) => e instanceof DomainError && e.code === "not_winner");
  await assert.rejects(fulfillClaim(ctx.db, ctx.bitrefill, r.claimId, { productId: "mock-myntra-400" }),
    (e: unknown) => e instanceof DomainError && e.code === "reward_unavailable");
  assert.equal(getClaimStatus(ctx.db, created.questId, "alice")?.claimStatus, "reserved");
  const pick = options.find((o) => o.category === "gaming")!;
  const outcome = await fulfillClaim(ctx.db, ctx.bitrefill, r.claimId, { productId: pick.productId });
  assert.equal(outcome.purchase?.productName, pick.name);
  assert.equal(outcome.claimStatus, "delivered");
});

test("a certain refusal (no charge) fails the claim cleanly instead of freezing it", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  const refusing: BitrefillAdapter = {
    searchEligibleProducts: (input) => ctx.bitrefill.searchEligibleProducts(input),
    async purchaseApprovedReward() { throw new PurchaseRejectedError("repriced_over_cap"); },
    getOrderStatus: (id) => ctx.bitrefill.getOrderStatus(id),
  };
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, codeOf(ctx, created.questId), "alice");
  const r = reserveWinnerSlot(ctx.db, created.questId, claimToken, "alice");
  assert.ok("claimId" in r);
  const outcome = await fulfillClaim(ctx.db, refusing, r.claimId);
  assert.equal(outcome.claimStatus, "failed");
  assert.equal(outcome.reason, "repriced_over_cap");
  const { options } = await listRewardOptions(ctx.db, ctx.bitrefill, created.questId, "bob").catch(() => ({ options: [] }));
  assert.equal(options.length, 0);
});
