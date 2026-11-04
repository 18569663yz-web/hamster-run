CREATE TABLE player_discoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  character_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX player_discoveries_player_char ON player_discoveries (player_id, character_id);
