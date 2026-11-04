-- Hamster Run — D1 initial schema.
-- Mirrors the Muse-hosted Drizzle schema (server/src/schema.ts, migrations
-- 0001–0006) table-for-table: same table names, same columns, same
-- semantics. Timestamps are epoch milliseconds (INTEGER), exactly as the
-- hosted DB stores them. Apply with:
--   wrangler d1 migrations apply hamster-run-db            (remote)
--   wrangler d1 migrations apply hamster-run-db --local    (local dev)

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_preview INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  nonce TEXT NOT NULL,
  message TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  character_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  distance INTEGER NOT NULL,
  seeds INTEGER NOT NULL,
  ticks INTEGER NOT NULL,
  is_preview INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  squeek_block INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hamster_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  character_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS hamster_levels_player_char ON hamster_levels (player_id, character_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS daily_tracks (
  day_id TEXT PRIMARY KEY,
  seed INTEGER NOT NULL,
  block_height INTEGER NOT NULL DEFAULT 0,
  work_units TEXT NOT NULL DEFAULT '',
  distance_mm TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'squeekchain',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS relay_state (
  id INTEGER PRIMARY KEY,
  baseline_mm TEXT NOT NULL,
  last_mm TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS player_discoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  character_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS player_discoveries_player_char ON player_discoveries (player_id, character_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mint_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  character_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'unlock',
  target_level INTEGER NOT NULL DEFAULT 1,
  price_eth TEXT NOT NULL DEFAULT '0.01',
  status TEXT NOT NULL DEFAULT 'pending_payment',
  tx_hash TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS mint_requests_player_char_kind_level ON mint_requests (player_id, character_id, kind, target_level);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS runs_player_idx ON runs (player_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS runs_leaderboard_idx ON runs (is_preview, score);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_player_idx ON sessions (player_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS challenges_address_idx ON challenges (address, used);
