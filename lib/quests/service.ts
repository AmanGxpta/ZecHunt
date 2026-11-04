import type { DatabaseSync } from "node:sqlite";
import { tx } from "../db";
import { DomainError } from "../errors";
import {
  keyedHash,
  normalizeCode,
  randomCheckpointCode,
  randomId,
  randomToken,
  safeEqualHex,
} from "../crypto";
import { checkSpend } from "../policy/spend-guard";
import type { BitrefillAdapter, ZcashAdapter } from "../providers/types";
import { selectReward } from "../providers/select";

export const MIN_CONFIRMATIONS = 1;
export const CLAIM_TOKEN_TTL_MS = 10 * 60 * 1000;
export const MAX_CHECKPOINT_FAILURES = 10;
/** Test-network activation threshold: 0.01 TAZ. Not an exchange rate. */
export const DEFAULT_EXPECTED_ZATOSHIS = 1_000_000;
export const MAX_REWARD_CAP_CENTS = 500;
export const REWARD_CATEGORIES = ["food", "mobile-recharge", "gaming"] as const;
export type RewardCategory = (typeof REWARD_CATEGORIES)[number];

/** Bitrefill credit available to the demo. Stored in cents. */
export function bitrefillCreditCents(): number {
  const raw = Number(process.env.BITREFILL_CREDIT_USD ?? "25");
  if (!Number.isFinite(raw) || raw <= 0) throw new Error("BITREFILL_CREDIT_USD must be > 0");
  return Math.round(raw * 100);
}

export function rewardCountry(): string {
  return process.env.ZECHUNT_REWARD_COUNTRY ?? "IN";
}

// ---------- row types ----------

interface QuestRow {
  id: string;
  title: string;
  clue: string;
  reward_category: string;
  reward_cap_cents: number;
  max_winners: number;
  winners_claimed: number;
  funding_address: string;
  expected_zatoshis: number;
  funded_zatoshis: number;
  status: "awaiting_funding" | "active" | "exhausted";
  checkpoint_code_hash: string;
  checkpoint_failures: number;
  creator_token_hash: string;
  created_at: number;
}

interface ClaimRow {
  id: string;
  quest_id: string;
  player_session: string;
  status: string;
  created_at: number;
  updated_at: number;
}

interface AttemptRow {
  claim_id: string;
  product_id: string;
  product_name: string;
  quoted_cents: number;
  state: string;
  invoice_id: string | null;
}

// ---------- public views ----------

export interface PublicQuest {
  id: string;
  title: string;
  clue: string;
  rewardCategory: string;
  rewardCapCents: number;
  status: QuestRow["status"];
  winnersRemaining: number;
}

export interface CreatorQuest extends PublicQuest {
  fundingAddress: string;
  expectedZatoshis: number;
  fundedZatoshis: number;
}

function toPublic(q: QuestRow): PublicQuest {
  return {
    id: q.id,
    title: q.title,
    clue: q.clue,
    rewardCategory: q.reward_category,
    rewardCapCents: q.reward_cap_cents,
    status: q.status,
    winnersRemaining: Math.max(0, q.max_winners - q.winners_claimed),
  };
}

function toCreator(q: QuestRow): CreatorQuest {
  return {
    ...toPublic(q),
    fundingAddress: q.funding_address,
    expectedZatoshis: q.expected_zatoshis,
    fundedZatoshis: q.funded_zatoshis,
  };
}

// ---------- helpers ----------

function loadQuest(db: DatabaseSync, id: string): QuestRow {
  const row = db.prepare("SELECT * FROM quests WHERE id = ?").get(id) as QuestRow | undefined;
  if (!row) throw new DomainError("quest_not_found", 404, "Quest not found");
  return row;
}

function verifyCreator(q: QuestRow, creatorToken: string | null): void {
  if (!creatorToken || !safeEqualHex(keyedHash(creatorToken), q.creator_token_hash)) {
    throw new DomainError("forbidden", 403, "Creator token required");
  }
}

function checkpointHash(questId: string, code: string): string {
  return keyedHash(`checkpoint:${questId}:${code}`);
}

function reservedCents(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quoted_cents), 0) AS total FROM purchase_attempts
       WHERE state IN ('PURCHASE_PENDING','INVOICE_CREATED','DELIVERED','NEEDS_RECONCILIATION')`,
    )
    .get() as { total: number };
  return Number(row.total);
}

// ---------- creation and funding ----------

export interface CreateQuestInput {
  title: string;
  clue: string;
  rewardCategory: string;
  rewardCapCents: number;
}

export async function createQuest(
  db: DatabaseSync,
  zcash: ZcashAdapter,
  input: CreateQuestInput,
  now = Date.now(),
) {
  const title = input.title?.trim() ?? "";
  const clue = input.clue?.trim() ?? "";
  if (title.length < 3 || title.length > 80) {
    throw new DomainError("invalid_title", 400, "Title must be 3–80 characters");
  }
  if (clue.length < 1 || clue.length > 500) {
    throw new DomainError("invalid_clue", 400, "Clue must be 1–500 characters");
  }
  if (!(REWARD_CATEGORIES as readonly string[]).includes(input.rewardCategory)) {
    throw new DomainError("invalid_category", 400, "Unsupported reward category");
  }
  if (
    !Number.isInteger(input.rewardCapCents) ||
    input.rewardCapCents <= 0 ||
    input.rewardCapCents > MAX_REWARD_CAP_CENTS
  ) {
    throw new DomainError("invalid_reward_cap", 400, "Reward cap must be $0.01–$5.00");
  }

  const id = randomId();
  // Provider call happens outside the transaction; it is read-only.
  const fundingAddress = await zcash.getQuestAddress(id);
  const checkpointCode = randomCheckpointCode();
  const creatorToken = randomToken();

  db.prepare(
    `INSERT INTO quests (id, title, clue, reward_category, reward_cap_cents, max_winners,
       winners_claimed, funding_address, expected_zatoshis, funded_zatoshis, status,
       checkpoint_code_hash, checkpoint_failures, creator_token_hash, created_at)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, 0, 'awaiting_funding', ?, 0, ?, ?)`,
  ).run(
    id,
    title,
    clue,
    input.rewardCategory,
    input.rewardCapCents,
    fundingAddress,
    DEFAULT_EXPECTED_ZATOSHIS,
    checkpointHash(id, checkpointCode),
    keyedHash(creatorToken),
    now,
  );

  // Creator secrets are returned exactly once here and never stored in plaintext.
  return {
    quest: toCreator(loadQuest(db, id)),
    creatorToken,
    checkpointCode,
  };
}

export function getPublicQuest(db: DatabaseSync, id: string): PublicQuest {
  return toPublic(loadQuest(db, id));
}

export function getCreatorQuest(db: DatabaseSync, id: string, creatorToken: string | null): CreatorQuest {
  const q = loadQuest(db, id);
  verifyCreator(q, creatorToken);
  return toCreator(q);
}

/**
 * Pulls funding events from the provider and activates the quest once confirmed
 * funds reach the threshold. Idempotent: an output is counted at most once.
 */
export async function syncFunding(
  db: DatabaseSync,
  zcash: ZcashAdapter,
  id: string,
  creatorToken: string | null,
  now = Date.now(),
): Promise<CreatorQuest> {
  const q = loadQuest(db, id);
  verifyCreator(q, creatorToken);
  const events = await zcash.findFunding(id);

  return tx(db, () => {
    const upsert = db.prepare(
      `INSERT INTO funding_events (output_id, quest_id, txid, amount_zatoshis, confirmations, seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(output_id) DO UPDATE SET confirmations = excluded.confirmations`,
    );
    for (const e of events) {
      upsert.run(e.outputId, id, e.txid, Number(e.amountZatoshis), e.confirmations, now);
    }
    const confirmed = db
      .prepare(
        `SELECT COALESCE(SUM(amount_zatoshis), 0) AS total FROM funding_events
         WHERE quest_id = ? AND confirmations >= ?`,
      )
      .get(id, MIN_CONFIRMATIONS) as { total: number };
    const total = Number(confirmed.total);
    const current = loadQuest(db, id);
    if (current.status === "awaiting_funding" && total >= current.expected_zatoshis) {
      db.prepare("UPDATE quests SET status = 'active', funded_zatoshis = ? WHERE id = ?").run(total, id);
    } else {
      db.prepare("UPDATE quests SET funded_zatoshis = ? WHERE id = ?").run(total, id);
    }
    return toCreator(loadQuest(db, id));
  });
}

// ---------- checkpoint and claim ----------

/** Player submits the checkpoint code. Returns a short-lived, single-use claim token. */
export function submitCheckpoint(
  db: DatabaseSync,
  id: string,
  code: string,
  playerSession: string,
  now = Date.now(),
): { claimToken: string; expiresAt: number } {
  const outcome = tx(db, () => {
    const q = loadQuest(db, id);
    if (q.status !== "active") return { ok: false as const, error: "quest_not_active" };
    if (q.checkpoint_failures >= MAX_CHECKPOINT_FAILURES) return { ok: false as const, error: "too_many_attempts" };
    const existing = db
      .prepare("SELECT id FROM claims WHERE quest_id = ? AND player_session = ?")
      .get(id, playerSession);
    if (existing) return { ok: false as const, error: "already_claimed" };

    const normalized = normalizeCode(code);
    if (!safeEqualHex(checkpointHash(id, normalized), q.checkpoint_code_hash)) {
      db.prepare("UPDATE quests SET checkpoint_failures = checkpoint_failures + 1 WHERE id = ?").run(id);
      return { ok: false as const, error: "invalid_code" };
    }

    const claimToken = randomToken();
    const expiresAt = now + CLAIM_TOKEN_TTL_MS;
    db.prepare(
      "INSERT INTO claim_tokens (token_hash, quest_id, player_session, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)",
    ).run(keyedHash(claimToken), id, playerSession, expiresAt);
    return { ok: true as const, claimToken, expiresAt };
  });

  if (!outcome.ok) {
    const status = outcome.error === "too_many_attempts" ? 429 : outcome.error === "invalid_code" ? 400 : 409;
    throw new DomainError(outcome.error, status);
  }
  return { claimToken: outcome.claimToken, expiresAt: outcome.expiresAt };
}

/**
 * Atomically consumes the claim token and reserves the single winner slot.
 * Returns the claim id. Purchase happens afterwards in fulfillClaim().
 */
export function reserveWinnerSlot(
  db: DatabaseSync,
  id: string,
  claimToken: string,
  playerSession: string,
  now = Date.now(),
): { claimId: string } | { error: "invalid_token" | "quest_exhausted" | "quest_not_active" | "already_claimed" } {
  return tx(db, () => {
    const q = loadQuest(db, id);
    const consumed = db
      .prepare(
        `UPDATE claim_tokens SET used_at = ?
         WHERE token_hash = ? AND quest_id = ? AND player_session = ?
           AND used_at IS NULL AND expires_at > ?`,
      )
      .run(now, keyedHash(claimToken), id, playerSession, now);
    if (Number(consumed.changes) !== 1) return { error: "invalid_token" as const };

    if (db.prepare("SELECT id FROM claims WHERE quest_id = ? AND player_session = ?").get(id, playerSession)) {
      return { error: "already_claimed" as const };
    }
    if (q.status !== "active") {
      return { error: q.status === "exhausted" ? ("quest_exhausted" as const) : ("quest_not_active" as const) };
    }
    if (q.winners_claimed >= q.max_winners) return { error: "quest_exhausted" as const };

    const claimId = randomId();
    db.prepare(
      `INSERT INTO claims (id, quest_id, player_session, status, created_at, updated_at)
       VALUES (?, ?, ?, 'reserved', ?, ?)`,
    ).run(claimId, id, playerSession, now, now);
    const claimed = q.winners_claimed + 1;
    db.prepare("UPDATE quests SET winners_claimed = ?, status = ? WHERE id = ?").run(
      claimed,
      claimed >= q.max_winners ? "exhausted" : "active",
      id,
    );
    return { claimId };
  });
}

export type ClaimOutcome = {
  claimId: string;
  claimStatus: string;
  purchase: { productName: string; priceCents: number; state: string; invoiceId: string | null } | null;
  reason?: string;
};

/**
 * Selects a reward, runs the deterministic spend guard, persists the purchase
 * intent BEFORE calling Bitrefill, and records the outcome. Never retries blindly.
 */
export async function fulfillClaim(
  db: DatabaseSync,
  bitrefill: BitrefillAdapter,
  claimId: string,
  now = Date.now(),
): Promise<ClaimOutcome> {
  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId) as ClaimRow | undefined;
  if (!claim) throw new DomainError("claim_not_found", 404);
  const q = loadQuest(db, claim.quest_id);

  const credit = bitrefillCreditCents();
  const products = await bitrefill.searchEligibleProducts({
    country: rewardCountry(),
    category: q.reward_category,
    maxPriceCents: Math.min(q.reward_cap_cents, credit),
  });
  const product = selectReward(products, {
    category: q.reward_category,
    maxPriceCents: Math.min(q.reward_cap_cents, credit),
  });

  // Guard + persistence in one transaction so two claims cannot both spend the same credit.
  const decision = tx(db, () => {
    // Duplicate call on an already-fulfilled claim: report it, never change its state.
    if (db.prepare("SELECT 1 FROM purchase_attempts WHERE claim_id = ?").get(claimId)) {
      return { ok: false as const, reason: "duplicate_purchase", keepState: true };
    }
    if (!product) {
      db.prepare("UPDATE claims SET status = 'failed', updated_at = ? WHERE id = ?").run(now, claimId);
      return { ok: false as const, reason: "no_eligible_product" };
    }
    const guard = checkSpend({
      questFunded: q.funded_zatoshis >= q.expected_zatoshis,
      winnerSlotReserved: true,
      claimHasNoPurchase: !db.prepare("SELECT 1 FROM purchase_attempts WHERE claim_id = ?").get(claimId),
      productCategory: product.category,
      requiredCategory: q.reward_category,
      quotedCents: product.priceCents,
      rewardCapCents: q.reward_cap_cents,
      creditRemainingCents: credit - reservedCents(db),
    });
    if (!guard.ok) {
      db.prepare("UPDATE claims SET status = 'failed', updated_at = ? WHERE id = ?").run(now, claimId);
      return { ok: false as const, reason: guard.reason };
    }
    db.prepare(
      `INSERT INTO purchase_attempts (claim_id, product_id, product_name, quoted_cents, state, invoice_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PURCHASE_PENDING', NULL, ?, ?)`,
    ).run(claimId, product.productId, product.name, product.priceCents, now, now);
    db.prepare("UPDATE claims SET status = 'purchase_pending', updated_at = ? WHERE id = ?").run(now, claimId);
    return { ok: true as const };
  });

  if (!decision.ok) {
    if ("keepState" in decision && decision.keepState) {
      return loadOutcome(db, claimId, decision.reason);
    }
    return { claimId, claimStatus: "failed", purchase: null, reason: decision.reason };
  }

  // The external call happens outside the transaction. The PURCHASE_PENDING row above
  // is the durable record of intent, so a crash never loses it.
  try {
    const invoice = await bitrefill.purchaseApprovedReward({
      claimId,
      productId: product!.productId,
      expectedMaxPriceCents: product!.priceCents,
    });
    db.prepare("UPDATE purchase_attempts SET state = 'INVOICE_CREATED', invoice_id = ?, updated_at = ? WHERE claim_id = ?").run(
      invoice.invoiceId,
      Date.now(),
      claimId,
    );
  } catch {
    markNeedsReconciliation(db, claimId, "purchase_call_failed");
    return loadOutcome(db, claimId, "purchase_call_failed");
  }

  await refreshOrderStatus(db, bitrefill, claimId);
  return loadOutcome(db, claimId);
}

async function refreshOrderStatus(db: DatabaseSync, bitrefill: BitrefillAdapter, claimId: string): Promise<void> {
  const attempt = db.prepare("SELECT * FROM purchase_attempts WHERE claim_id = ?").get(claimId) as AttemptRow | undefined;
  if (!attempt?.invoice_id) return;
  try {
    const order = await bitrefill.getOrderStatus(attempt.invoice_id);
    const s = order.status.toLowerCase();
    if (s === "delivered" || s === "completed") {
      db.prepare("UPDATE purchase_attempts SET state = 'DELIVERED', updated_at = ? WHERE claim_id = ?").run(Date.now(), claimId);
      db.prepare("UPDATE claims SET status = 'delivered', updated_at = ? WHERE id = ?").run(Date.now(), claimId);
    } else if (s === "failed" || s === "cancelled" || s === "canceled") {
      db.prepare("UPDATE purchase_attempts SET state = 'FAILED', updated_at = ? WHERE claim_id = ?").run(Date.now(), claimId);
      db.prepare("UPDATE claims SET status = 'failed', updated_at = ? WHERE id = ?").run(Date.now(), claimId);
    }
  } catch {
    // Leave INVOICE_CREATED; the reconciler will pick it up.
  }
}

function markNeedsReconciliation(db: DatabaseSync, claimId: string, reason: string): void {
  void reason;
  const now = Date.now();
  db.prepare("UPDATE purchase_attempts SET state = 'NEEDS_RECONCILIATION', updated_at = ? WHERE claim_id = ?").run(now, claimId);
  db.prepare("UPDATE claims SET status = 'needs_reconciliation', updated_at = ? WHERE id = ?").run(now, claimId);
}

function loadOutcome(db: DatabaseSync, claimId: string, reason?: string): ClaimOutcome {
  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId) as unknown as ClaimRow;
  const attempt = db.prepare("SELECT * FROM purchase_attempts WHERE claim_id = ?").get(claimId) as AttemptRow | undefined;
  return {
    claimId,
    claimStatus: claim.status,
    purchase: attempt
      ? {
          productName: attempt.product_name,
          priceCents: attempt.quoted_cents,
          state: attempt.state,
          invoiceId: attempt.invoice_id,
        }
      : null,
    reason,
  };
}

/**
 * Restart-safe recovery. Attempts stuck in PURCHASE_PENDING never received an
 * invoice id, so they are flagged for a human rather than retried. Attempts with an
 * invoice are re-checked with Bitrefill.
 */
export async function reconcileFulfillments(
  db: DatabaseSync,
  bitrefill: BitrefillAdapter,
  { graceMs = 60_000, now = Date.now() } = {},
): Promise<{ flagged: number; refreshed: number }> {
  // Grace period: never touch an attempt that may still be inside its purchase call.
  const pending = db
    .prepare("SELECT claim_id FROM purchase_attempts WHERE state = 'PURCHASE_PENDING' AND updated_at < ?")
    .all(now - graceMs) as { claim_id: string }[];
  for (const row of pending) markNeedsReconciliation(db, row.claim_id, "interrupted_before_invoice");

  const open = db.prepare("SELECT claim_id FROM purchase_attempts WHERE state = 'INVOICE_CREATED'").all() as { claim_id: string }[];
  for (const row of open) await refreshOrderStatus(db, bitrefill, row.claim_id);
  return { flagged: pending.length, refreshed: open.length };
}

export function getClaimStatus(db: DatabaseSync, questId: string, playerSession: string): ClaimOutcome | null {
  const claim = db
    .prepare("SELECT id FROM claims WHERE quest_id = ? AND player_session = ?")
    .get(questId, playerSession) as { id: string } | undefined;
  return claim ? loadOutcome(db, claim.id) : null;
}
