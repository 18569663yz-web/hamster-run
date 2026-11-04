DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_preview INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  nonce TEXT NOT NULL,
  message TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  character_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  distance INTEGER NOT NULL,
  seeds INTEGER NOT NULL,
  ticks INTEGER NOT NULL,
  is_preview INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
