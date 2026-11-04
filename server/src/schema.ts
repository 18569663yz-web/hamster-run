import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const players = sqliteTable("players", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  address: text("address").notNull().unique(),
  name: text("name").notNull(),
  isPreview: integer("is_preview").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const challenges = sqliteTable("challenges", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  address: text("address").notNull(),
  nonce: text("nonce").notNull(),
  message: text("message").notNull(),
  used: integer("used").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  playerId: integer("player_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull(),
  seed: integer("seed").notNull(),
  characterId: text("character_id").notNull(),
  score: integer("score").notNull(),
  distance: integer("distance").notNull(),
  seeds: integer("seeds").notNull(),
  ticks: integer("ticks").notNull(),
  isPreview: integer("is_preview").notNull().default(0),
  level: integer("level").notNull().default(1),
  squeekBlock: integer("squeek_block"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Per-player hamster skill levels (framework data; once mint is wired,
 *  the level source becomes the chain). */
export const hamsterLevels = sqliteTable("hamster_levels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull(),
  characterId: text("character_id").notNull(),
  level: integer("level").notNull().default(1),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** One Squeekchain-derived track seed per UTC day (§6 结合①). */
export const dailyTracks = sqliteTable("daily_tracks", {
  dayId: text("day_id").primaryKey(),
  seed: integer("seed").notNull(),
  blockHeight: integer("block_height").notNull().default(0),
  workUnits: text("work_units").notNull().default(""),
  distanceMm: text("distance_mm").notNull().default(""),
  source: text("source").notNull().default("squeekchain"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** SQUEEKTOSHI 里程接力 baseline (§6 结合③): the first lifetime distance ever
 *  read becomes the baseline; gains are measured from it. */
export const relayState = sqliteTable("relay_state", {
  id: integer("id").primaryKey(),
  baselineMm: text("baseline_mm").notNull(),
  lastMm: text("last_mm").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Mint intents for hamster unlocks / level-ups (rules v2, 2026-11-02).
 *  A row records that an eligible player registered a mint at the fixed
 *  price; status stays `pending_payment` until the owner's signing
 *  service (which issues the authorisation the HamsterNFT v2 contract
 *  verifies) is connected — no row here ever claims a payment or an
 *  on-chain mint happened. */
/** Hidden-character discoveries (imdpepe easter egg): one row per player
 *  who has found the hidden character. Server-side record so discovery
 *  survives reloads and gates the imdpepe mint. */
export const playerDiscoveries = sqliteTable("player_discoveries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull(),
  characterId: text("character_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Daily champion on-chain proof records: one row per settled UTC day.
 *  Written by the lazy settlement in `getYesterdayChampion` (Muse build)
 *  / the Worker cron (public build) after the day's #1 formal run is
 *  submitted to the Sepolia ScoreLedger contract. `status` is honest:
 *  pending/failed rows never claim an on-chain record exists; only
 *  `submitted` rows carry a real tx hash. */
export const dailyChampions = sqliteTable("daily_champions", {
  /** UTC day, "YYYYMMDD". */
  dayId: text("day_id").primaryKey(),
  playerId: integer("player_id").notNull(),
  playerAddress: text("player_address").notNull(),
  playerName: text("player_name").notNull(),
  score: integer("score").notNull(),
  distance: integer("distance").notNull(),
  characterId: text("character_id").notNull(),
  level: integer("level").notNull().default(1),
  squeekBlock: integer("squeek_block"),
  payloadHash: text("payload_hash").notNull(),
  status: text("status", { enum: ["pending", "submitted", "failed"] })
    .notNull()
    .default("pending"),
  txHash: text("tx_hash"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** One-shot run tokens: issued by startRun, consumed by submitRun.
 *  Binds a submission to the player, character, and daily-track seed the
 *  server actually issued, so a stored run cannot be replayed or forged
 *  on an arbitrary seed. Times are millisecond epochs (plain integers). */
export const runTokens = sqliteTable("run_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  token: text("token").notNull().unique(),
  playerId: integer("player_id").notNull(),
  characterId: text("character_id").notNull(),
  seed: integer("seed").notNull(),
  issuedAt: integer("issued_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
});

export const mintRequests = sqliteTable("mint_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  playerId: integer("player_id").notNull(),
  characterId: text("character_id").notNull(),
  kind: text("kind", { enum: ["unlock", "levelup"] }).notNull().default("unlock"),
  targetLevel: integer("target_level").notNull().default(1),
  priceEth: text("price_eth").notNull().default("0.01"),
  status: text("status", { enum: ["pending_payment"] }).notNull().default("pending_payment"),
  /** On-chain mint transaction hash once the player's wallet has paid
   *  and the server verified the receipt (null for registrations that
   *  never went on chain, e.g. test-entry accounts). */
  txHash: text("tx_hash"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
