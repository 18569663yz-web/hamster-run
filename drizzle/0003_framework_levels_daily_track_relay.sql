CREATE TABLE hamster_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  character_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX hamster_levels_player_char ON hamster_levels (player_id, character_id);
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN level INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN squeek_block INTEGER;
--> statement-breakpoint
CREATE TABLE daily_tracks (
  day_id TEXT PRIMARY KEY,
  seed INTEGER NOT NULL,
  block_height INTEGER NOT NULL DEFAULT 0,
  work_units TEXT NOT NULL DEFAULT '',
  distance_mm TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'squeekchain',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE relay_state (
  id INTEGER PRIMARY KEY,
  baseline_mm TEXT NOT NULL,
  last_mm TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
