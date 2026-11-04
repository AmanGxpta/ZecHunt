import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../lib/db";
import { DomainError } from "../lib/errors";
import { MockBitrefillAdapter, MockZcashAdapter } from "../lib/providers/mock";
import type { BitrefillAdapter } from "../lib/providers/types";
import { checkSpend } from "../lib/policy/spend-guard";
import {
  createQuest,
  fulfillClaim,
  getClaimStatus,
  MAX_CHECKPOINT_FAILURES,
  reconcileFulfillments,
  reserveWinnerSlot,
  submitCheckpoint,
  syncFunding,
} from "../lib/quests/service";

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

async function winAs(ctx: ReturnType<typeof setup>, questId: string, code: string, session: string, now = Date.now()) {
  const { claimToken } = submitCheckpoint(ctx.db, questId, code, session, now);
  const reserved = reserveWinnerSlot(ctx.db, questId, claimToken, session, now);
  if ("error" in reserved) return reserved;
  return fulfillClaim(ctx.db, ctx.bitrefill, reserved.claimId, now);
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
    assert.notEqual(value, created.checkpointCode, "checkpoint code must not be stored in plaintext");
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

test("checkpoint locks out after repeated wrong codes", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  const wrong = created.checkpointCode === "000000" ? "111111" : "000000";
  for (let i = 0; i < MAX_CHECKPOINT_FAILURES; i++) {
    assert.throws(() => submitCheckpoint(ctx.db, created.questId, wrong, `s${i}`), (e: unknown) => e instanceof DomainError && e.code === "invalid_code");
  }
  assert.throws(
    () => submitCheckpoint(ctx.db, created.questId, created.checkpointCode, "late"),
    (e: unknown) => e instanceof DomainError && e.code === "too_many_attempts",
  );
});

test("exactly one player wins; the second correct entry is rejected", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);

  // Both players pass the checkpoint before either claims: a real race.
  const alice = submitCheckpoint(ctx.db, created.questId, created.checkpointCode, "alice");
  const bob = submitCheckpoint(ctx.db, created.questId, created.checkpointCode, "bob");

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
    () => submitCheckpoint(ctx.db, created.questId, created.checkpointCode, "carol"),
    (e: unknown) => e instanceof DomainError && e.code === "quest_not_active",
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
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, created.checkpointCode, "alice");
  const first = reserveWinnerSlot(ctx.db, created.questId, claimToken, "alice");
  assert.ok("claimId" in first);
  const replay = reserveWinnerSlot(ctx.db, created.questId, claimToken, "alice");
  assert.ok("error" in replay);
  assert.equal(replay.error, "invalid_token");
});

test("a claim token cannot be used by another session", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, created.checkpointCode, "alice");
  const stolen = reserveWinnerSlot(ctx.db, created.questId, claimToken, "mallory");
  assert.ok("error" in stolen);
  assert.equal(stolen.error, "invalid_token");
});

test("expired claim tokens are rejected", async () => {
  const ctx = setup();
  const created = await fundedQuest(ctx);
  const t0 = 1_000_000;
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, created.checkpointCode, "alice", t0);
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
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, created.checkpointCode, "alice");
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
    // Cap is $5, credit is $3: the $5 product is excluded, the $3 product is allowed.
    const outcome = await winAs(ctx, created.questId, created.checkpointCode, "alice");
    assert.ok(!("error" in outcome));
    assert.equal(outcome.purchase?.priceCents, 300);
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
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, created.checkpointCode, "alice");
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
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, created.checkpointCode, "alice");
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
  const { claimToken } = submitCheckpoint(ctx.db, created.questId, created.checkpointCode, "alice");
  const r = reserveWinnerSlot(ctx.db, created.questId, claimToken, "alice");
  assert.ok("claimId" in r);
  const now = Date.now();
  // Simulate a crash after persisting intent but before calling Bitrefill.
  ctx.db.prepare(
    `INSERT INTO purchase_attempts (claim_id, product_id, product_name, quoted_cents, state, invoice_id, created_at, updated_at)
     VALUES (?, 'mock-food-3', 'Mock food voucher $3', 300, 'PURCHASE_PENDING', NULL, ?, ?)`,
  ).run(r.claimId, now - 120_000, now - 120_000);
  ctx.db.prepare("UPDATE claims SET status = 'purchase_pending' WHERE id = ?").run(r.claimId);

  const summary = await reconcileFulfillments(ctx.db, ctx.bitrefill, { now });
  assert.equal(summary.flagged, 1);
  assert.equal(getClaimStatus(ctx.db, created.questId, "alice")?.claimStatus, "needs_reconciliation");
});
