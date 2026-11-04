-- One-time run tokens: startRun issues, submitRun consumes.
-- Binds a submission to the player, character and daily-track seed that
-- startRun issued, and gives submitRun a server-side issued_at for the
-- minimum-duration check. Timestamps are millisecond epoch integers.
CREATE TABLE IF NOT EXISTS run_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  player_id INTEGER NOT NULL,
  character_id TEXT NOT NULL,
  seed INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS run_tokens_player_idx ON run_tokens (player_id);
