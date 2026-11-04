import type { DatabaseSync } from "node:sqlite";
import { tx } from "../db";
import { DomainError } from "../errors";
import {
  keyedHash,
  randomId,
  randomToken,
  safeEqualHex,
} from "../crypto";
import { checkSpend } from "../policy/spend-guard";
import { currentCode, verifyCode } from "./checkpoint";
import { centsToInr, INR_CAPS, inrCapToCents } from "../money";
import { PurchaseRejectedError, type BitrefillAdapter, type RewardProduct, type ZcashAdapter } from "../providers/types";
import { recommendReward, type Recommendation } from "../agent/recommend";
import { selectReward } from "../providers/select";

export const MIN_CONFIRMATIONS = 1;
export const CLAIM_TOKEN_TTL_MS = 10 * 60 * 1000;
/** Failed guesses allowed per player session, per IP, and per quest, inside each window. */
export const CHECKPOINT_LIMITS = {
  session: { max: 5, windowMs: 10 * 60_000 },
  ip: { max: 20, windowMs: 10 * 60_000 },
  quest: { max: 60, windowMs: 60_000 },
} as const;
export type ProviderMode = "mock" | "live";
/** Test-network activation threshold: 0.01 TAZ. Not an exchange rate. */
export const DEFAULT_EXPECTED_ZATOSHIS = 1_000_000;
export const MAX_REWARD_CAP_CENTS = 500;
export const REWARD_CATEGORIES = ["food", "shopping", "gaming"] as const;
export type RewardCategory = (typeof REWARD_CATEGORIES)[number];
/** Creator lets the winner pick from every supported category. */
export const ANY_CATEGORY = "any";
/** What "winner's choice" offers: code-only categories (no phone number needed). */
export const WINNER_CHOICE_CATEGORIES = ["food", "shopping", "gaming"] as const;

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
  reward_cap_inr: number | null;
  max_winners: number;
  winners_claimed: number;
  funding_address: string;
  expected_zatoshis: number;
  funded_zatoshis: number;
  status: "awaiting_funding" | "active" | "exhausted";
  checkpoint_nonce: string;
  checkpoint_key_hash: string;
  creator_token_hash: string;
  zcash_mode: ProviderMode;
  activated_at: number | null;
  created_at: number;
  paused_at: number | null;
  cancelled_at: number | null;
}

/** What players and creators see. Pause and cancel overlay the funding lifecycle. */
export type QuestStatus = "awaiting_funding" | "active" | "paused" | "exhausted" | "cancelled";

function effectiveStatus(q: QuestRow): QuestStatus {
  if (q.cancelled_at) return "cancelled";
  if (q.status === "exhausted") return "exhausted";
  if (q.paused_at && q.status === "active") return "paused";
  return q.status;
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
  provider_mode: ProviderMode;
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
  /** What people see. Older quests fall back to a converted value. */
  rewardCapInr: number;
  status: QuestStatus;
  winnersRemaining: number;
  zcashMode: ProviderMode;
}

export interface CreatorQuest extends PublicQuest {
  fundingAddress: string;
  expectedZatoshis: number;
  fundedZatoshis: number;
  activatedAt: number | null;
  fundingEvents: { txid: string; amountZatoshis: number; confirmations: number }[];
  /** Winner progress for the creator. Never includes redemption data. */
  winner: { claimStatus: string; productName: string | null; purchaseState: string | null; providerMode: string | null } | null;
}

function toPublic(q: QuestRow): PublicQuest {
  return {
    id: q.id,
    title: q.title,
    clue: q.clue,
    rewardCategory: q.reward_category,
    rewardCapCents: q.reward_cap_cents,
    rewardCapInr: q.reward_cap_inr ?? centsToInr(q.reward_cap_cents),
    status: effectiveStatus(q),
    winnersRemaining: Math.max(0, q.max_winners - q.winners_claimed),
    zcashMode: q.zcash_mode,
  };
}

function winnerSummary(db: DatabaseSync, questId: string): CreatorQuest["winner"] {
  const row = db
    .prepare(
      `SELECT c.status AS claim_status, p.product_name, p.state, p.provider_mode
       FROM claims c LEFT JOIN purchase_attempts p ON p.claim_id = c.id
       WHERE c.quest_id = ? ORDER BY c.created_at LIMIT 1`,
    )
    .get(questId) as { claim_status: string; product_name: string | null; state: string | null; provider_mode: string | null } | undefined;
  return row
    ? { claimStatus: row.claim_status, productName: row.product_name, purchaseState: row.state, providerMode: row.provider_mode }
    : null;
}

function toCreator(db: DatabaseSync, q: QuestRow): CreatorQuest {
  const events = db
    .prepare(
      `SELECT txid, amount_zatoshis, confirmations FROM funding_events
       WHERE quest_id = ? ORDER BY seen_at, output_id`,
    )
    .all(q.id) as { txid: string; amount_zatoshis: number; confirmations: number }[];
  return {
    ...toPublic(q),
    fundingAddress: q.funding_address,
    expectedZatoshis: q.expected_zatoshis,
    fundedZatoshis: q.funded_zatoshis,
    activatedAt: q.activated_at,
    winner: winnerSummary(db, q.id),
    fundingEvents: events.map((e) => ({
      txid: e.txid,
      amountZatoshis: Number(e.amount_zatoshis),
      confirmations: Number(e.confirmations),
    })),
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

function verifyCheckpointKey(q: QuestRow, key: string | null): boolean {
  return !!key && safeEqualHex(keyedHash(key), q.checkpoint_key_hash);
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
  /** Preferred: one of INR_CAPS. Converted to a USD-cent cap for the spend guard. */
  rewardCapInr?: number;
  rewardCapCents?: number;
}

export async function createQuest(
  db: DatabaseSync,
  zcash: ZcashAdapter,
  input: CreateQuestInput,
  { now = Date.now(), zcashMode = "mock" as ProviderMode } = {},
) {
  const title = input.title?.trim() ?? "";
  const clue = input.clue?.trim() ?? "";
  if (title.length < 3 || title.length > 80) {
    throw new DomainError("invalid_title", 400, "Title must be 3–80 characters");
  }
  if (clue.length < 1 || clue.length > 500) {
    throw new DomainError("invalid_clue", 400, "Clue must be 1–500 characters");
  }
  if (input.rewardCategory !== ANY_CATEGORY && !(REWARD_CATEGORIES as readonly string[]).includes(input.rewardCategory)) {
    throw new DomainError("invalid_category", 400, "Unsupported reward category");
  }
  let rewardCapInr: number | null = null;
  let rewardCapCents: number;
  if (input.rewardCapInr !== undefined) {
    if (!(INR_CAPS as readonly number[]).includes(input.rewardCapInr)) {
      throw new DomainError("invalid_reward_cap", 400, `Reward must be one of ₹${INR_CAPS.join(", ₹")}`);
    }
    rewardCapInr = input.rewardCapInr;
    rewardCapCents = inrCapToCents(input.rewardCapInr);
  } else {
    rewardCapCents = input.rewardCapCents ?? NaN;
  }
  if (!Number.isInteger(rewardCapCents) || rewardCapCents <= 0 || rewardCapCents > MAX_REWARD_CAP_CENTS) {
    throw new DomainError("invalid_reward_cap", 400, "Reward cap must be $0.01–$5.00");
  }

  const id = randomId();
  // Allocates a fresh shielded receiving address in the watch-only wallet.
  const fundingAddress = await zcash.getQuestAddress(id);
  const creatorToken = randomToken();
  const checkpointKey = randomToken();

  db.prepare(
    `INSERT INTO quests (id, title, clue, reward_category, reward_cap_cents, reward_cap_inr, max_winners,
       winners_claimed, funding_address, expected_zatoshis, funded_zatoshis, status,
       checkpoint_nonce, checkpoint_key_hash, creator_token_hash, zcash_mode, activated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, 0, 'awaiting_funding', ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    title,
    clue,
    input.rewardCategory,
    rewardCapCents,
    rewardCapInr,
    fundingAddress,
    DEFAULT_EXPECTED_ZATOSHIS,
    randomToken(),
    keyedHash(checkpointKey),
    keyedHash(creatorToken),
    zcashMode,
    now,
  );

  // Creator secrets are returned exactly once here and never stored in plaintext.
  return {
    quest: toCreator(db, loadQuest(db, id)),
    creatorToken,
    checkpointKey,
  };
}

export function getPublicQuest(db: DatabaseSync, id: string): PublicQuest {
  return toPublic(loadQuest(db, id));
}

export function getCreatorQuest(db: DatabaseSync, id: string, creatorToken: string | null): CreatorQuest {
  const q = loadQuest(db, id);
  verifyCreator(q, creatorToken);
  return toCreator(db, q);
}

/**
 * The code the checkpoint volunteer shows. Requires the checkpoint key (given to
 * whoever staffs the checkpoint) or the creator token.
 */
export function getCheckpointCode(
  db: DatabaseSync,
  id: string,
  auth: { checkpointKey?: string | null; creatorToken?: string | null },
  now = Date.now(),
) {
  const q = loadQuest(db, id);
  const creatorOk = !!auth.creatorToken && safeEqualHex(keyedHash(auth.creatorToken), q.creator_token_hash);
  if (!creatorOk && !verifyCheckpointKey(q, auth.checkpointKey ?? null)) {
    throw new DomainError("forbidden", 403, "Checkpoint key required");
  }
  return { ...currentCode(q.id, q.checkpoint_nonce, now), title: q.title, status: effectiveStatus(q) };
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
  verifyCreator(loadQuest(db, id), creatorToken);
  return syncQuestFunding(db, zcash, id, now);
}

/** Worker entry point: no creator token, because it runs server-side only. */
export async function syncQuestFunding(
  db: DatabaseSync,
  zcash: ZcashAdapter,
  id: string,
  now = Date.now(),
): Promise<CreatorQuest> {
  loadQuest(db, id);
  const events = await zcash.findFunding(id);

  return tx(db, () => {
    const upsert = db.prepare(
      `INSERT INTO funding_events (output_id, quest_id, txid, amount_zatoshis, confirmations, seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(output_id) DO UPDATE SET confirmations = excluded.confirmations`,
    );
    for (const e of events) {
      if (typeof e.amountZatoshis !== "bigint" || e.amountZatoshis <= 0n) continue;
      if (!Number.isSafeInteger(e.confirmations) || e.confirmations < 0) continue;
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
      db.prepare("UPDATE quests SET status = 'active', funded_zatoshis = ?, activated_at = ? WHERE id = ?").run(
        total,
        now,
        id,
      );
    } else {
      db.prepare("UPDATE quests SET funded_zatoshis = ? WHERE id = ?").run(total, id);
    }
    return toCreator(db, loadQuest(db, id));
  });
}

/** Quests the funding worker should keep scanning. */
export function questsAwaitingFunding(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT id FROM quests WHERE status = 'awaiting_funding' AND cancelled_at IS NULL ORDER BY created_at").all() as { id: string }[]
  ).map((r) => r.id);
}

// ---------- checkpoint and claim ----------

/** Player submits the checkpoint code. Returns a short-lived, single-use claim token. */
export function submitCheckpoint(
  db: DatabaseSync,
  id: string,
  code: string,
  playerSession: string,
  { now = Date.now(), ip = "unknown" }: { now?: number; ip?: string } = {},
): { claimToken: string; expiresAt: number } {
  const ipHash = keyedHash(`ip:${ip}`);
  const outcome = tx(db, () => {
    const q = loadQuest(db, id);
    const st = effectiveStatus(q);
    if (st === "exhausted") return { ok: false as const, error: "quest_exhausted" };
    if (st === "paused") return { ok: false as const, error: "quest_paused" };
    if (st === "cancelled") return { ok: false as const, error: "quest_cancelled" };
    if (st !== "active") return { ok: false as const, error: "quest_not_active" };
    const existing = db
      .prepare("SELECT id FROM claims WHERE quest_id = ? AND player_session = ?")
      .get(id, playerSession);
    if (existing) return { ok: false as const, error: "already_claimed" };

    const count = (where: string, windowMs: number, ...args: string[]) =>
      Number(
        (
          db
            .prepare(`SELECT COUNT(*) AS n FROM checkpoint_failures WHERE quest_id = ? AND at > ? ${where}`)
            .get(id, now - windowMs, ...args) as { n: number }
        ).n,
      );
    const L = CHECKPOINT_LIMITS;
    if (
      count("AND player_session = ?", L.session.windowMs, playerSession) >= L.session.max ||
      count("AND ip_hash = ?", L.ip.windowMs, ipHash) >= L.ip.max ||
      count("", L.quest.windowMs) >= L.quest.max
    ) {
      return { ok: false as const, error: "too_many_attempts" };
    }

    if (!verifyCode(q.id, q.checkpoint_nonce, code, now)) {
      db.prepare("INSERT INTO checkpoint_failures (quest_id, player_session, ip_hash, at) VALUES (?, ?, ?, ?)").run(
        id,
        playerSession,
        ipHash,
        now,
      );
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
): { claimId: string } | { error: "invalid_token" | "quest_exhausted" | "quest_not_active" | "quest_paused" | "quest_cancelled" | "already_claimed" } {
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
    const st = effectiveStatus(q);
    if (st === "paused") return { error: "quest_paused" as const };
    if (st === "cancelled") return { error: "quest_cancelled" as const };
    if (st !== "active") {
      return { error: st === "exhausted" ? ("quest_exhausted" as const) : ("quest_not_active" as const) };
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
  purchase: {
    productName: string;
    priceCents: number;
    /** Approximate, for display only. */
    priceInr: number;
    state: string;
    invoiceId: string | null;
    providerMode: ProviderMode;
  } | null;
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
  { now = Date.now(), bitrefillMode = "mock" as ProviderMode, productId }: { now?: number; bitrefillMode?: ProviderMode; productId?: string } = {},
): Promise<ClaimOutcome> {
  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId) as ClaimRow | undefined;
  if (!claim) throw new DomainError("claim_not_found", 404);
  const q = loadQuest(db, claim.quest_id);

  const products = await eligibleProducts(bitrefill, q);
  const credit = bitrefillCreditCents();
  // The winner's pick must be one of the fresh, eligible results. Anything else is refused
  // without touching the claim, so a stale or forged choice can't fail someone's win.
  if (productId && !products.some((p) => p.productId === productId)) {
    throw new DomainError("reward_unavailable", 409, "That reward is no longer available. Pick another.");
  }
  const product = productId
    ? products.find((p) => p.productId === productId)!
    : selectReward(products, { category: q.reward_category, maxPriceCents: Math.min(q.reward_cap_cents, credit) });

  // Guard + persistence in one transaction so two claims cannot both spend the same credit.
  const decision = tx(db, () => {
    // Duplicate call on an already-fulfilled claim: report it, never change its state.
    if (db.prepare("SELECT 1 FROM purchase_attempts WHERE claim_id = ?").get(claimId)) {
      return { ok: false as const, reason: "duplicate_purchase", keepState: true };
    }
    if (!product) {
      db.prepare("UPDATE claims SET status = 'failed', failure_reason = 'no_eligible_product', updated_at = ? WHERE id = ?").run(now, claimId);
      return { ok: false as const, reason: "no_eligible_product" };
    }
    const guard = checkSpend({
      questFunded: q.funded_zatoshis >= q.expected_zatoshis,
      winnerSlotReserved: true,
      claimHasNoPurchase: !db.prepare("SELECT 1 FROM purchase_attempts WHERE claim_id = ?").get(claimId),
      productCategory: product.category,
      requiredCategory: q.reward_category === ANY_CATEGORY ? product.category : q.reward_category,
      quotedCents: product.priceCents,
      rewardCapCents: q.reward_cap_cents,
      creditRemainingCents: credit - reservedCents(db),
    });
    if (!guard.ok) {
      db.prepare("UPDATE claims SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?").run(guard.reason, now, claimId);
      return { ok: false as const, reason: guard.reason };
    }
    db.prepare(
      `INSERT INTO purchase_attempts (claim_id, product_id, product_name, quoted_cents, provider_mode, state, invoice_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'PURCHASE_PENDING', NULL, ?, ?)`,
    ).run(claimId, product.productId, product.name, product.priceCents, bitrefillMode, now, now);
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
  } catch (err) {
    if (err instanceof PurchaseRejectedError) {
      // Certain no charge: fail the claim cleanly instead of freezing it for reconciliation.
      const t = Date.now();
      db.prepare("UPDATE purchase_attempts SET state = 'FAILED', updated_at = ? WHERE claim_id = ?").run(t, claimId);
      db.prepare("UPDATE claims SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?").run(err.reasonCode, t, claimId);
      return loadOutcome(db, claimId, err.reasonCode);
    }
    // Message only: adapters must never put credentials or redemption data in errors.
    console.error(`[fulfillment] claim ${claimId} purchase uncertain:`, err instanceof Error ? err.message : String(err));
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
  const now = Date.now();
  db.prepare("UPDATE purchase_attempts SET state = 'NEEDS_RECONCILIATION', updated_at = ? WHERE claim_id = ?").run(now, claimId);
  db.prepare("UPDATE claims SET status = 'needs_reconciliation', failure_reason = ?, updated_at = ? WHERE id = ?").run(reason, now, claimId);
}

function loadOutcome(db: DatabaseSync, claimId: string, reason?: string): ClaimOutcome {
  const claim = db.prepare("SELECT * FROM claims WHERE id = ?").get(claimId) as unknown as ClaimRow & { failure_reason: string | null };
  const attempt = db.prepare("SELECT * FROM purchase_attempts WHERE claim_id = ?").get(claimId) as AttemptRow | undefined;
  return {
    claimId,
    claimStatus: claim.status,
    purchase: attempt
      ? {
          productName: attempt.product_name,
          priceCents: attempt.quoted_cents,
          priceInr: centsToInr(attempt.quoted_cents),
          state: attempt.state,
          invoiceId: attempt.invoice_id,
          providerMode: attempt.provider_mode,
        }
      : null,
    reason: reason ?? claim.failure_reason ?? undefined,
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
): Promise<{ flagged: number; refreshed: number; adopted: number }> {
  // Grace period: never touch an attempt that may still be inside its purchase call.
  const pending = db
    .prepare("SELECT claim_id FROM purchase_attempts WHERE state = 'PURCHASE_PENDING' AND updated_at < ?")
    .all(now - graceMs) as { claim_id: string }[];
  for (const row of pending) markNeedsReconciliation(db, row.claim_id, "interrupted_before_invoice");

  // Uncertain purchases: ask the provider to find the invoice. This never buys.
  let adopted = 0;
  if (bitrefill.reconcilePurchase) {
    const frozen = db
      .prepare("SELECT claim_id FROM purchase_attempts WHERE state = 'NEEDS_RECONCILIATION' AND invoice_id IS NULL")
      .all() as { claim_id: string }[];
    for (const row of frozen) {
      try {
        const found = await bitrefill.reconcilePurchase(row.claim_id);
        adopted += tx(db, () => {
          const t = Date.now();
          const changed = db
            .prepare(
              `UPDATE purchase_attempts SET state = 'INVOICE_CREATED', invoice_id = ?, updated_at = ?
               WHERE claim_id = ? AND state = 'NEEDS_RECONCILIATION' AND invoice_id IS NULL`,
            )
            .run(found.invoiceId, t, row.claim_id);
          if (Number(changed.changes) !== 1) return 0;
          db.prepare("UPDATE claims SET status = 'purchase_pending', failure_reason = NULL, updated_at = ? WHERE id = ?").run(t, row.claim_id);
          return 1;
        });
      } catch (err) {
        console.error(`[fulfillment] claim ${row.claim_id} still uncertain:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  const open = db.prepare("SELECT claim_id FROM purchase_attempts WHERE state = 'INVOICE_CREATED'").all() as { claim_id: string }[];
  for (const row of open) await refreshOrderStatus(db, bitrefill, row.claim_id);
  return { flagged: pending.length, refreshed: open.length, adopted };
}

export function getClaimStatus(db: DatabaseSync, questId: string, playerSession: string): ClaimOutcome | null {
  const claim = db
    .prepare("SELECT id FROM claims WHERE quest_id = ? AND player_session = ?")
    .get(questId, playerSession) as { id: string } | undefined;
  return claim ? loadOutcome(db, claim.id) : null;
}

/** Every product the guard could approve for this quest right now, across its allowed categories. */
async function eligibleProducts(bitrefill: BitrefillAdapter, q: QuestRow): Promise<RewardProduct[]> {
  const maxPriceCents = Math.min(q.reward_cap_cents, bitrefillCreditCents());
  const categories: string[] = q.reward_category === ANY_CATEGORY ? [...WINNER_CHOICE_CATEGORIES] : [q.reward_category];
  const lists = await Promise.all(categories.map((category) =>
    bitrefill.searchEligibleProducts({ country: rewardCountry(), category, maxPriceCents }).catch(() => [] as RewardProduct[])));
  const seen = new Set<string>();
  return lists.flat().filter((p) => {
    const ok = categories.includes(p.category) && Number.isInteger(p.priceCents) && p.priceCents > 0 &&
      p.priceCents <= maxPriceCents && !seen.has(p.productId);
    seen.add(p.productId);
    return ok;
  });
}

export interface RewardOption {
  productId: string;
  name: string;
  category: string;
  priceCents: number;
  priceInr: number;
  /** Face value in rupees when the provider states it, else an estimate from the price. */
  faceInr: number;
}

/** The caller's claim on this quest if it is still waiting for a reward choice. */
export function reservedClaimFor(db: DatabaseSync, questId: string, playerSession: string): string {
  const claim = db.prepare("SELECT id, status FROM claims WHERE quest_id = ? AND player_session = ?").get(questId, playerSession) as
    { id: string; status: string } | undefined;
  if (!claim) throw new DomainError("not_winner", 403, "Only the winner can choose a reward");
  if (claim.status !== "reserved") throw new DomainError("reward_already_chosen", 409, "The reward has already been chosen");
  return claim.id;
}

/** Options for the winner's reserved claim, plus the agent's recommendation. */
export async function listRewardOptions(
  db: DatabaseSync,
  bitrefill: BitrefillAdapter,
  questId: string,
  playerSession: string,
): Promise<{ claimId: string; options: RewardOption[]; recommendation: Recommendation | null }> {
  const claimId = reservedClaimFor(db, questId, playerSession);
  const q = loadQuest(db, questId);
  const options = (await eligibleProducts(bitrefill, q)).map((p) => ({
    productId: p.productId, name: p.name, category: p.category, priceCents: p.priceCents, priceInr: centsToInr(p.priceCents),
    faceInr: p.faceValue?.currency === "INR" ? Math.round(p.faceValue.amountMinor / 100) : centsToInr(p.priceCents),
  }));
  const recommendation = await recommendReward(options, { capCents: q.reward_cap_cents, questTitle: q.title });
  return { claimId, options, recommendation };
}

// ---------- creator controls ----------

export type QuestControl = "pause" | "resume" | "cancel";

/**
 * Pause stops new claims (an in-flight claim token still fails at reservation).
 * Cancel is final and only allowed before anyone has won, so no reward is ever
 * stranded. Nothing here moves money; a testnet funding deposit is not refunded.
 */
export function controlQuest(db: DatabaseSync, id: string, creatorToken: string | null, action: QuestControl, now = Date.now()): CreatorQuest {
  return tx(db, () => {
    const q = loadQuest(db, id);
    verifyCreator(q, creatorToken);
    const st = effectiveStatus(q);
    if (action === "pause") {
      if (st !== "active") throw new DomainError("cannot_pause", 409, "Only a live quest can be paused");
      db.prepare("UPDATE quests SET paused_at = ? WHERE id = ?").run(now, id);
    } else if (action === "resume") {
      if (st !== "paused") throw new DomainError("cannot_resume", 409, "This quest isn’t paused");
      db.prepare("UPDATE quests SET paused_at = NULL WHERE id = ?").run(id);
    } else if (action === "cancel") {
      if (st === "cancelled") return toCreator(db, q);
      if (q.winners_claimed > 0 || db.prepare("SELECT 1 FROM claims WHERE quest_id = ?").get(id)) {
        throw new DomainError("cannot_cancel", 409, "Someone has already won this quest");
      }
      db.prepare("UPDATE quests SET cancelled_at = ? WHERE id = ?").run(now, id);
    } else {
      throw new DomainError("invalid_action", 400, "Unknown action");
    }
    return toCreator(db, loadQuest(db, id));
  });
}
