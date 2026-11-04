// D1 schema test: the migration SQL must execute cleanly on a fresh
// SQLite database (D1 is SQLite), create every expected table, and
// support the core write/read flow (player → session → run → board).
// Run: bun ./tests/d1-schema.ts   (from the cloudflare/ directory)

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sqlPath = join(import.meta.dir, "../migrations/0001_init.sql");
const raw = readFileSync(sqlPath, "utf8");
const sql = raw
  .split("\n")
  .filter((line) => !line.trim().startsWith("--> statement-breakpoint"))
  .join("\n");

const db = new Database(":memory:");
db.exec(sql);

const tables = db
  .query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all()
  .map((r) => r.name);

const expected = [
  "challenges",
  "daily_tracks",
  "hamster_levels",
  "mint_requests",
  "player_discoveries",
  "players",
  "relay_state",
  "runs",
  "sessions",
];
const missing = expected.filter((t) => !tables.includes(t));
if (missing.length) {
  console.error("FAIL missing tables:", missing, "got:", tables);
  process.exit(1);
}
console.log("OK tables:", tables.join(", "));

// smoke flow: preview player + session + one run + leaderboard read
const now = Date.now();
db.query(
  "INSERT INTO players (address, name, is_preview, created_at) VALUES (?, ?, ?, ?)",
).run("preview:test", "测试玩家", 1, now);
db.query("INSERT INTO sessions (token, player_id, created_at) VALUES (?, ?, ?)").run(
  "tok-1",
  1,
  now,
);
db.query(
  "INSERT INTO runs (player_id, seed, character_id, score, distance, seeds, ticks, is_preview, level, squeek_block, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
).run(1, 20261102, "lizi", 1512, 189, 12, 640, 1, 1, 5973, now);
db.query(
  "INSERT INTO daily_tracks (day_id, seed, block_height, work_units, distance_mm, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
).run("2026-11-02", 20261102, 5973, "", "", "squeekchain", now);

const joined = db
  .query<{ name: string }, []>(
    "SELECT p.name AS name FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token = 'tok-1'",
  )
  .get();
const board = db
  .query<{ best: number }, []>(
    "SELECT MAX(score) AS best FROM runs WHERE is_preview = 0",
  )
  .get();
console.log(
  `OK smoke: session→player=${joined?.name}, official board best (preview excluded)=${board?.best ?? "null"}`,
);
console.log("D1 migration executes cleanly.");
