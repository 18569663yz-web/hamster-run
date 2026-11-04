-- Daily champion on-chain proof records (mirrors hosted migration 0007).
CREATE TABLE IF NOT EXISTS daily_champions (
  day_id TEXT PRIMARY KEY NOT NULL,
  player_id INTEGER NOT NULL,
  player_address TEXT NOT NULL,
  player_name TEXT NOT NULL,
  score INTEGER NOT NULL,
  distance INTEGER NOT NULL,
  character_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  squeek_block INTEGER,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
