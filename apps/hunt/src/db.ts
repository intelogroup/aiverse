/**
 * SQLite open + migrations runner (SPEC slice 1) and the §5 schema (slice 2).
 * Single file, WAL mode, via bun:sqlite. Money is integer cents; timestamps
 * are UTC epoch-ms integers; coordinates are world metres (City 3 frame).
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_V1 = /* sql */ `
CREATE TABLE IF NOT EXISTS hunt_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  gateway_owner_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  -- SPEC §11.2 built to the recommendation: winner publicity opt-out.
  publicity_opt_out INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES hunt_users(id),
  kind TEXT NOT NULL,             -- 'magic' | 'session'
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, kind);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  district TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',  -- draft|scheduled|live|ended|paused|cancelled
  pool_cap_cents INTEGER NOT NULL,
  claim_radius_m REAL NOT NULL,
  tier TEXT NOT NULL DEFAULT 'major',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prizes (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  label_public TEXT NOT NULL,
  kind TEXT NOT NULL,             -- gift_code|game_key|coupon
  face_value_cents INTEGER NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,  -- server-only, never serialized (I4)
  code_encrypted BLOB NOT NULL,
  code_nonce BLOB NOT NULL,
  state TEXT NOT NULL DEFAULT 'seeded',  -- seeded|claimed|expired|voided
  claimed_by_user_id TEXT NULL REFERENCES hunt_users(id),
  claimed_at INTEGER NULL,
  reveal_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prizes_event_state ON prizes(event_id, state);

CREATE TABLE IF NOT EXISTS claim_attempts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  prize_id TEXT NULL,
  user_id TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
  body_id TEXT NOT NULL,
  client_ts INTEGER NULL,
  received_at INTEGER NOT NULL,
  verdict TEXT NOT NULL,  -- won|no_prize_in_radius|already_claimed|too_fast|rate_limited|event_not_live|suspended_user
  distance_m REAL NULL,
  via TEXT NOT NULL DEFAULT 'claim'  -- 'claim' | 'ping' (continuous checks, hunt v0 delta 1)
);
CREATE INDEX IF NOT EXISTS idx_attempts_event_user ON claim_attempts(event_id, user_id, received_at);
-- I1 backstop: exactly one winner per prize, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_winner ON claim_attempts(prize_id) WHERE verdict = 'won';

CREATE TABLE IF NOT EXISTS position_samples (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
  body_id TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_event_user ON position_samples(event_id, user_id, received_at);

-- Phase 2 shape only (SPEC §5.7): table exists, no endpoint writes it in v1.
CREATE TABLE IF NOT EXISTS payout_addresses (
  user_id TEXT PRIMARY KEY REFERENCES hunt_users(id),
  kind TEXT NOT NULL DEFAULT 'paypal',
  address TEXT NOT NULL,
  verified_at INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hint_schedule (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  tier TEXT NOT NULL,  -- district|neighbourhood|street|room
  text TEXT NOT NULL,
  fires_at INTEGER NULL,           -- scheduled fallback (server clock)
  -- Hunt v0 delta 3: progress-paced rungs are the primary pacing.
  progress_kind TEXT NULL,         -- 'prizes_claimed_fraction' | 'hunters_in_area'
  progress_value REAL NULL,
  area_x REAL NULL, area_z REAL NULL, area_radius_m REAL NULL,
  fired_at INTEGER NULL
);
CREATE INDEX IF NOT EXISTS idx_hints_event ON hint_schedule(event_id, fired_at);

CREATE TABLE IF NOT EXISTS pool_ledger (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,  -- seed|claim_award|void|expire_return
  prize_id TEXT NULL,
  amount_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  note TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_event ON pool_ledger(event_id, created_at);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NULL,
  type TEXT NOT NULL,  -- hunt_start|hint|prize_claimed|hunt_end|ping
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_announce_event ON announcements(event_id, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail_json TEXT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS body_constants (
  body_id TEXT PRIMARY KEY,
  max_speed_mps REAL NOT NULL
);
-- Measured constants, copied from apps/console/src/features/world/bodies.ts
-- (BODIES registry, post-scale effective speeds; run speed where the body has
-- a Run cycle, else walk speed). Values verified 2026-11-08 against ac9b01b4.
INSERT OR IGNORE INTO body_constants (body_id, max_speed_mps) VALUES
  ('remy', 3.6894),
  ('summer', 3.8052),
  ('cast', 1.1422),
  ('mage', 0.3996),
  ('barbarian', 0.4564),
  ('knight', 0.4438),
  ('skeleton-warrior', 1.2612);
`;

const MIGRATIONS: { version: number; sql: string }[] = [{ version: 1, sql: SCHEMA_V1 }];

export function openDb(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return db;
}

export function runMigrations(db: Database): void {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version};`);
    }
  }
}
