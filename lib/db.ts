import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Single source of truth. Money-like values are stored as integers
// (zatoshis for ZEC, cents for USD) so no float arithmetic decides a spend.
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS quests (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  clue                  TEXT NOT NULL,
  reward_category       TEXT NOT NULL,
  reward_cap_cents      INTEGER NOT NULL CHECK (reward_cap_cents > 0),
  max_winners           INTEGER NOT NULL CHECK (max_winners = 1),
  winners_claimed       INTEGER NOT NULL DEFAULT 0,
  funding_address       TEXT NOT NULL,
  expected_zatoshis     INTEGER NOT NULL CHECK (expected_zatoshis > 0),
  funded_zatoshis       INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL CHECK (status IN ('awaiting_funding','active','exhausted')),
  -- Rotating checkpoint code: secret = HMAC(ZECHUNT_SECRET, id:nonce). Nonce alone is useless.
  checkpoint_nonce      TEXT NOT NULL,
  checkpoint_key_hash   TEXT NOT NULL,
  creator_token_hash    TEXT NOT NULL,
  zcash_mode            TEXT NOT NULL CHECK (zcash_mode IN ('mock','live')),
  activated_at          INTEGER,
  created_at            INTEGER NOT NULL
);

-- output_id is the primary key: one shielded output can fund a quest only once.
CREATE TABLE IF NOT EXISTS funding_events (
  output_id         TEXT PRIMARY KEY,
  quest_id          TEXT NOT NULL REFERENCES quests(id),
  txid              TEXT NOT NULL,
  amount_zatoshis   INTEGER NOT NULL,
  confirmations     INTEGER NOT NULL,
  seen_at           INTEGER NOT NULL
);

-- Failed checkpoint guesses, for per-player, per-IP and per-quest rate limits.
CREATE TABLE IF NOT EXISTS checkpoint_failures (
  quest_id        TEXT NOT NULL REFERENCES quests(id),
  player_session  TEXT NOT NULL,
  ip_hash         TEXT NOT NULL,
  at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoint_failures_quest_at ON checkpoint_failures (quest_id, at);

CREATE TABLE IF NOT EXISTS claim_tokens (
  token_hash      TEXT PRIMARY KEY,
  quest_id        TEXT NOT NULL REFERENCES quests(id),
  player_session  TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER
);

-- One claim per player per quest, enforced by the database. With max_winners = 1
-- the quest row update below is the single-winner gate; UNIQUE(quest_id) on claims
-- would also hold today but would block raising max_winners later.
CREATE TABLE IF NOT EXISTS claims (
  id              TEXT PRIMARY KEY,
  quest_id        TEXT NOT NULL REFERENCES quests(id),
  player_session  TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('reserved','purchase_pending','delivered','needs_reconciliation','failed')),
  failure_reason  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (quest_id, player_session)
);

-- One purchase attempt per claim. Never retried blindly.
CREATE TABLE IF NOT EXISTS purchase_attempts (
  claim_id          TEXT PRIMARY KEY REFERENCES claims(id),
  product_id        TEXT NOT NULL,
  product_name      TEXT NOT NULL,
  quoted_cents      INTEGER NOT NULL CHECK (quoted_cents > 0),
  provider_mode     TEXT NOT NULL CHECK (provider_mode IN ('mock','live')),
  state             TEXT NOT NULL CHECK (state IN ('PURCHASE_PENDING','INVOICE_CREATED','DELIVERED','NEEDS_RECONCILIATION','FAILED')),
  invoice_id        TEXT UNIQUE,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
  // Additive migrations for databases created before a column existed.
  try { db.exec("ALTER TABLE claims ADD COLUMN failure_reason TEXT"); } catch { /* already present */ }
  try { db.exec("ALTER TABLE quests ADD COLUMN reward_cap_inr INTEGER"); } catch { /* already present */ }
  return db;
}

const g = globalThis as unknown as { __zechuntDb?: DatabaseSync };

/** Process-wide database handle. Survives Next.js dev hot reloads. */
export function getDb(): DatabaseSync {
  if (!g.__zechuntDb) {
    const path =
      process.env.ZECHUNT_DB_PATH ?? resolve(process.cwd(), ".data/zechunt.db");
    g.__zechuntDb = openDatabase(path);
  }
  return g.__zechuntDb;
}

/**
 * Runs fn inside BEGIN IMMEDIATE so no other writer can interleave.
 * fn must be synchronous. Throwing rolls everything back, so functions
 * that must persist state before failing return a result instead of throwing.
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
