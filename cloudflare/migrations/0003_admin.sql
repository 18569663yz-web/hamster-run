-- Admin backend support (management console):
--  - ip_bans: IPs blocked at the API entry for login/run actions.
--  - players.banned: board-removal flag (leaderboards exclude banned=1).
--  - players.last_ip: last IP seen for the player on gated actions.
-- players currently has exactly (id, address, name, is_preview,
-- created_at) — verified against the remote DB with PRAGMA before
-- writing this migration, so the plain ALTERs below are safe.
CREATE TABLE IF NOT EXISTS ip_bans (
  ip TEXT PRIMARY KEY,
  reason TEXT,
  created_at INTEGER NOT NULL
);
ALTER TABLE players ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN last_ip TEXT;
