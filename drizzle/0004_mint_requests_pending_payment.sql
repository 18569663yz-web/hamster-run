CREATE TABLE mint_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  character_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'unlock',
  target_level INTEGER NOT NULL DEFAULT 1,
  price_eth TEXT NOT NULL DEFAULT '0.01',
  status TEXT NOT NULL DEFAULT 'pending_payment',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX mint_requests_player_char_kind_level ON mint_requests (player_id, character_id, kind, target_level);
