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
  checkpoint_code_hash  TEXT NOT NULL,
  checkpoint_failures   INTEGER NOT NULL DEFAULT 0,
  creator_token_hash    TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS claim_tokens (
  token_hash      TEXT PRIMARY KEY,
  quest_id        TEXT NOT NULL REFERENCES quests(id),
  player_session  TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER
);

-- One claim per player per quest, enforced by the database.
CREATE TABLE IF NOT EXISTS claims (
  id              TEXT PRIMARY KEY,
  quest_id        TEXT NOT NULL REFERENCES quests(id),
  player_session  TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('reserved','purchase_pending','delivered','needs_reconciliation','failed')),
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
  state             TEXT NOT NULL CHECK (state IN ('PURCHASE_PENDING','INVOICE_CREATED','DELIVERED','NEEDS_RECONCILIATION','FAILED')),
  invoice_id        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
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
