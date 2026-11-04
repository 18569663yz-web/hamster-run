import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import * as schema from "./schema";
import { simulateRun } from "./sim";
import { bytesToHex, keccak256, recoverPersonalSign } from "./evm";
import { WALLET_CONNECT_CHAIN_ID, WALLET_CONNECT_PROJECT_ID } from "./wallet-connect-config";
import { PrivilegedContracts } from "@space/privileged";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CHAR_IDS = ["lizi", "xueqiu", "meiqiu", "huasheng", "zhima", "imdpepe"] as const;
/** The hidden sixth character: not part of the sequential unlock order
 *  and with no species on the HamsterNFT contract. */
const IMDPEPE_ID = "imdpepe";
/** Account lifetime metres required before imdpepe may mint (owner rule). */
const IMDPEPE_UNLOCK_TOTAL_M = 100000;
const SQUEEK_API = "https://api.squeekchain.com/v1";

/* Sepolia contracts (deployed by the project owner, chainId 11155111).
 * This action bundle never holds a signing key: mint authorisation
 * signatures are produced by the host-only privileged signer
 * (server/src/privileged.ts), which reads the owner's deployer wallet
 * file on the owner's machine and signs there. The key never enters
 * this bundle or the client. Daily champion proofs are submitted to
 * ScoreLedger by the same host-only privileged path (the deployer
 * wallet is the contract's owner and reporter, so it writes directly);
 * see getYesterdayChampion. */
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
/* HamsterNFT v2 (deployed & verified by the project owner, 2026-11-02):
 * payable mint at 0.01 Sepolia ETH (fee straight to the deployer wallet),
 * sequential unlock enforced by the contract, mileage eligibility
 * released by a server signature the contract verifies. */
const HAMSTER_NFT = "0x15601070312Fd8071d11B6Bd2606B2A5D9ec620b";
/* HamsterNFT v1 — history only. Never read or displayed as the operative
 * contract any more. */
const HAMSTER_NFT_V1_LEGACY = "0x83cc3505A00F3EE70C27f4ac2d82E6543249188D";
void HAMSTER_NFT_V1_LEGACY;
const SCORE_LEDGER = "0xFB650C5503A2A05f01D4DF91e5a522EbD1Eba552";
/** Sepolia block explorer used for the champion proof links. */
const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";
/** species ids on chain: 1 栗子 2 雪球 3 煤球 4 花生 5 芝麻 */
const SPECIES_OF: Record<string, number> = {
  lizi: 1,
  xueqiu: 2,
  meiqiu: 3,
  huasheng: 4,
  zhima: 5,
};
export const RELAY_THEMES = ["晨光草原", "黄昏屋顶", "星夜山谷", "雪原松林"];
/** Kilometres of NEW SQUEEKTOSHI distance per unlocked relay theme
 * (owner, 2026-11-02: step raised from 1 km to 5 km, then 20 km, then
 * 100 km — SQUEEKTOSHI runs too fast for smaller steps;
 * the launch-day baseline itself is unchanged). */
export const RELAY_STEP_KM = 100;

/* ------------------------- progression rules (v2) -------------------------
 * Owner rules change, 2026-11-02 (supersedes "mint is free / first mint
 * random 3-pick-1"):
 * - Only 栗子 (lizi) is playable from the start. The other four unlock in
 *   selection order (雪球 → 煤球 → 花生 → 芝麻) as the account's lifetime
 *   mileage (server-recorded run distance, all hamsters combined) grows.
 * - Unlocking a hamster IS a mint, and levelling up is a repeat mint.
 *   Every mint costs MINT_PRICE_ETH Sepolia ETH (anti-sybil).
 * - The deployed HamsterNFT is the 0-price non-payable v1, so on-chain
 *   charging needs a v2 redeploy; until then mints are registered as
 *   pending_payment and nothing is charged or minted on chain.
 * - A level-up additionally requires mileage run with THAT hamster,
 *   cumulative over the account's lifetime (never reset per level):
 *   Lv2 at 1000 m, Lv3 at 3000 m, Lv4 at 5000 m, Lv5 at 8000 m of
 *   that hamster's own mileage (owner-confirmed 2026-11-02; thresholds
 *   were originally stated in km and the owner switched the unit to
 *   metres with the numbers unchanged).
 * - The owner has deployed HamsterNFT v2 (payable mint at MINT_PRICE_ETH
 *   straight to the deployer wallet, sequential unlock enforced by the
 *   contract, mileage eligibility released by server signature). The read
 *   side points at v2; the v1 address is kept in code as history only.
 *   Mint authorisation signatures are issued on demand by the host-only
 *   privileged signer (the deployer key stays in the owner's local file;
 *   see getMintAuthorization). Wallet players pay on chain in one click;
 *   test-entry accounts and imdpepe (no contract species) keep the
 *   pending_payment in-game registration. */
export const UNLOCK_ORDER = ["lizi", "xueqiu", "meiqiu", "huasheng", "zhima"] as const;
export const UNLOCK_TOTAL_M: Record<string, number> = {
  lizi: 0,
  xueqiu: 2000,
  meiqiu: 5000,
  huasheng: 10000,
  zhima: 20000,
  imdpepe: IMDPEPE_UNLOCK_TOTAL_M,
};
export const MINT_PRICE_ETH = "0.01";
/** Own-hamster cumulative metres required to level UP from key level. */
export const LEVEL_UP_M: Record<number, number> = { 1: 1000, 2: 3000, 3: 5000, 4: 8000 };
/** Chinese display names for plain-language eligibility errors. */
export const CHAR_DISPLAY_NAME: Record<string, string> = {
  lizi: "栗子",
  xueqiu: "雪球",
  meiqiu: "煤球",
  huasheng: "花生",
  zhima: "芝麻",
  imdpepe: "imdpepe",
};

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function shortName(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function hashSeedInt(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2147483647;
}

/* ------------------------------ Squeekchain ------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function squeekJson(path: string): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${SQUEEK_API}${path}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function getDb(ctx: Ctx) {
  return ctx.db<typeof schema>();
}
type Db = ReturnType<typeof getDb>;

/** §6 结合①: today's track seed comes from Squeekchain's settled anchor
 *  (blockHeight ‖ lifetime work ‖ lifetime distance ‖ dayId). If the API
 *  is unreachable, yesterday's seed keeps the game running. */
async function ensureDailyTrack(db: Db) {
  const dayId = new Date().toISOString().slice(0, 10);
  const existing = await db
    .select()
    .from(schema.dailyTracks)
    .where(eq(schema.dailyTracks.dayId, dayId))
    .limit(1);
  if (existing[0]) return existing[0];

  const status = await squeekJson("/status");
  const stats = await squeekJson("/measurement/stats?range=7d");
  let row: typeof schema.dailyTracks.$inferInsert;
  const anchor = status?.builder?.anchor;
  if (anchor && stats?.lifetime) {
    const blockHeight = parseInt(String(anchor.blockHeight ?? "0"), 10) || 0;
    const workUnits = String(stats.lifetime.acceptedWorkUnits ?? anchor.cumulativeWork ?? "");
    const distanceMm = String(stats.lifetime.observedDistanceMm ?? "");
    row = {
      dayId,
      seed: hashSeedInt(`${blockHeight}|${workUnits}|${distanceMm}|${dayId}`),
      blockHeight,
      workUnits,
      distanceMm,
      source: "squeekchain",
    };
  } else {
    const prev = await db
      .select()
      .from(schema.dailyTracks)
      .orderBy(desc(schema.dailyTracks.dayId))
      .limit(1);
    if (prev[0]) {
      row = {
        dayId,
        seed: prev[0].seed,
        blockHeight: prev[0].blockHeight,
        workUnits: prev[0].workUnits,
        distanceMm: prev[0].distanceMm,
        source: "fallback-yesterday",
      };
    } else {
      row = {
        dayId,
        seed: hashSeedInt(`dayhash|${dayId}`),
        blockHeight: 0,
        workUnits: "",
        distanceMm: "",
        source: "fallback-dayhash",
      };
    }
  }
  try {
    await db.insert(schema.dailyTracks).values(row);
  } catch {
    // a concurrent startRun already wrote today's row
  }
  const saved = await db
    .select()
    .from(schema.dailyTracks)
    .where(eq(schema.dailyTracks.dayId, dayId))
    .limit(1);
  return (
    saved[0] ?? {
      id: 0,
      ...row,
      workUnits: row.workUnits ?? "",
      distanceMm: row.distanceMm ?? "",
      blockHeight: row.blockHeight ?? 0,
      source: row.source ?? "squeekchain",
      createdAt: new Date(),
    }
  );
}

/* ------------------------------ Sepolia reads ------------------------------ */

function selector(signature: string): string {
  const hash = keccak256(new TextEncoder().encode(signature));
  return "0x" + Array.from(hash.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
}

function encAddress(address: string): string {
  return address.toLowerCase().replace("0x", "").padStart(64, "0");
}

function encUint(v: number | bigint): string {
  return v.toString(16).padStart(64, "0");
}

/** One eth_call against the public Sepolia RPC; null on any failure. */
async function ethCall(to: string, data: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(SEPOLIA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    const result = json?.result;
    return typeof result === "string" && result.startsWith("0x") ? result : null;
  } catch {
    return null;
  }
}

function wordAt(hex: string, index: number): bigint {
  const clean = hex.slice(2);
  const word = clean.slice(index * 64, index * 64 + 64);
  return word ? BigInt("0x" + word) : 0n;
}

/** Chain level for one species (0 = not held); null when the RPC failed. */
async function chainSpeciesLevel(address: string, species: number): Promise<number | null> {
  const data = selector("speciesLevel(address,uint8)") + encAddress(address) + encUint(species);
  const out = await ethCall(HAMSTER_NFT, data);
  if (!out) return null;
  return Number(wordAt(out, 0));
}

/** The player's current mint nonce on HamsterNFT v2 — the contract binds
 *  every authorisation signature to it, so it must be read fresh. */
async function chainMintNonce(address: string): Promise<bigint | null> {
  const data = selector("mintNonce(address)") + encAddress(address);
  const out = await ethCall(HAMSTER_NFT, data);
  if (!out) return null;
  return wordAt(out, 0);
}

/** The serverSigner address the v2 contract currently trusts. */
async function chainServerSigner(): Promise<string | null> {
  const out = await ethCall(HAMSTER_NFT, selector("serverSigner()"));
  if (!out || out.length < 66) return null;
  return "0x" + out.slice(2 + 24, 2 + 64).toLowerCase();
}

/** One JSON-RPC call against the public Sepolia RPC; null on failure. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ethRpc(method: string, params: unknown[]): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(SEPOLIA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    return json?.result ?? null;
  } catch {
    return null;
  }
}

async function playerByToken(db: Db, token: string) {
  const rows = await db
    .select({ player: schema.players })
    .from(schema.sessions)
    .innerJoin(schema.players, eq(schema.sessions.playerId, schema.players.id))
    .where(eq(schema.sessions.token, token))
    .limit(1);
  return rows[0]?.player ?? null;
}

async function levelFor(db: Db, playerId: number, characterId: string): Promise<number> {
  const rows = await db
    .select()
    .from(schema.hamsterLevels)
    .where(
      and(
        eq(schema.hamsterLevels.playerId, playerId),
        eq(schema.hamsterLevels.characterId, characterId),
      ),
    )
    .limit(1);
  const lv = rows[0]?.level ?? 1;
  return Math.min(5, Math.max(1, lv));
}

/** Settlement level (§2.4: level must not be client-reported): the chain
 *  wins — when the player holds the hamster on Sepolia, speciesLevel is
 *  authoritative; otherwise the framework database level applies. */
async function effectiveLevel(
  db: Db,
  player: typeof schema.players.$inferSelect,
  characterId: string,
): Promise<number> {
  // Guest mode (isPreview): only the base hamster at Lv1, ever.
  if (player.isPreview === 1) return 1;
  if (ADDRESS_RE.test(player.address)) {
    const species = SPECIES_OF[characterId];
    if (species) {
      const chainLevel = await chainSpeciesLevel(player.address, species);
      if (chainLevel !== null && chainLevel > 0) {
        return Math.min(5, chainLevel);
      }
    }
  }
  return levelFor(db, player.id, characterId);
}

/* --------------------- hidden character: imdpepe --------------------- */

/** Whether this player has discovered the hidden character imdpepe
 *  (recorded server-side per account when the easter egg fires). */
async function hasDiscoveredImdpepe(db: Db, playerId: number): Promise<boolean> {
  const rows = await db
    .select()
    .from(schema.playerDiscoveries)
    .where(
      and(
        eq(schema.playerDiscoveries.playerId, playerId),
        eq(schema.playerDiscoveries.characterId, IMDPEPE_ID),
      ),
    )
    .limit(1);
  return !!rows[0];
}

/** Whether this player has a recorded unlock mint registration for the
 *  character (the pending_payment registration written by requestMint). */
async function hasUnlockMint(db: Db, playerId: number, characterId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(schema.mintRequests)
    .where(
      and(
        eq(schema.mintRequests.playerId, playerId),
        eq(schema.mintRequests.characterId, characterId),
        eq(schema.mintRequests.kind, "unlock"),
      ),
    )
    .limit(1);
  return !!rows[0];
}

/** imdpepe has no species on the HamsterNFT v2 contract, so its mint is
 *  the in-game registration itself: a recorded unlock mint request IS
 *  the holding that makes it playable (the same pending_payment
 *  registration flow as the other five). */
async function hasImdpepeMint(db: Db, playerId: number): Promise<boolean> {
  return hasUnlockMint(db, playerId, IMDPEPE_ID);
}

/* --------------------------- progression (v2) --------------------------- */

/** Lifetime mileage from stored (server-validated) runs: total metres for
 *  the account and metres per hamster. */
async function mileageFor(
  db: Db,
  playerId: number,
): Promise<{ totalMeters: number; perCharMeters: Record<string, number> }> {
  const rows = await db
    .select({
      characterId: schema.runs.characterId,
      meters: sql<number>`SUM(${schema.runs.distance})`,
    })
    .from(schema.runs)
    .where(eq(schema.runs.playerId, playerId))
    .groupBy(schema.runs.characterId);
  const perCharMeters: Record<string, number> = {};
  let totalMeters = 0;
  for (const r of rows) {
    perCharMeters[r.characterId] = r.meters ?? 0;
    totalMeters += r.meters ?? 0;
  }
  return { totalMeters, perCharMeters };
}

/** Playable check (rules v2, unified with imdpepe by owner direction
 *  2026-11-02): 栗子 always; any other hamster when the player holds it
 *  on the HamsterNFT v2 contract (Sepolia) OR has a recorded unlock mint
 *  registration for it — the same rule imdpepe has always used, since its
 *  registration IS its holding. Mileage alone still only makes a hamster
 *  ELIGIBLE: the registration is written by requestMint only after the
 *  server-side mileage gate passes. The registration stays
 *  pending_payment (the on-chain mint still completes through the
 *  owner's signing service); nothing here claims a chain mint happened. */
async function isUnlocked(
  db: Db,
  player: typeof schema.players.$inferSelect,
  characterId: string,
): Promise<boolean> {
  // Guest mode (isPreview, formerly the test entry): ONLY the base
  // hamster 栗子 is playable. Every other character — including
  // imdpepe — stays locked for guests no matter what registrations or
  // discoveries an older test-entry session may have accumulated.
  // Wallet accounts are untouched: their unlock order, mileage gates
  // and mint rules below apply as before.
  if (player.isPreview === 1) return characterId === "lizi";
  if (characterId === IMDPEPE_ID) return hasImdpepeMint(db, player.id);
  if (characterId === "lizi") return true;
  if (player.isPreview !== 1 && ADDRESS_RE.test(player.address)) {
    const species = SPECIES_OF[characterId];
    if (species) {
      const chainLevel = await chainSpeciesLevel(player.address, species);
      if (chainLevel !== null && chainLevel > 0) return true;
    }
  }
  return hasUnlockMint(db, player.id, characterId);
}

const progressionHamster = z.object({
  characterId: z.string(),
  level: z.number(),
  ownM: z.number(),
  unlocked: z.boolean(),
  state: z.enum(["base", "unlocked", "eligible", "pending", "locked"]),
  unlockThresholdM: z.number(),
  levelUpReady: z.boolean(),
  levelUpProgress: z.number(),
  levelUpThresholdM: z.number().nullable(),
  pendingMint: z.boolean(),
});

async function progressionFor(db: Db, player: typeof schema.players.$inferSelect) {
  const { totalMeters, perCharMeters } = await mileageFor(db, player.id);
  const totalM = totalMeters;
  const pending = await db
    .select()
    .from(schema.mintRequests)
    .where(eq(schema.mintRequests.playerId, player.id));
  const hamsters: z.infer<typeof progressionHamster>[] = [];
  for (const characterId of UNLOCK_ORDER) {
    // The operative level is the EFFECTIVE level (chain holding wins for
    // wallet players): the framework table level is never advanced by an
    // on-chain mint, so keying thresholds off it pinned every wallet
    // player at the Lv1→Lv2 gate (1000 m) no matter how far the chain
    // level had actually climbed — the bug behind the Lv3/Lv4 incident.
    const level = await effectiveLevel(db, player, characterId);
    const ownM = perCharMeters[characterId] ?? 0;
    const thresholdM = UNLOCK_TOTAL_M[characterId] ?? 0;
    const unlocked = await isUnlocked(db, player, characterId);
    const hasPending = pending.some((p) => p.characterId === characterId);
    const state = unlocked
      ? characterId === "lizi"
        ? "base"
        : "unlocked"
      : hasPending
        ? "pending"
        : totalM >= thresholdM
          ? "eligible"
          : "locked";
    const nextThreshold = LEVEL_UP_M[level] ?? null;
    // A registration only counts as "pending" for the step it targets:
    // a completed past mint (target already reached on chain) must not
    // masquerade as a pending registration for the NEXT level.
    const pendingMint = unlocked
      ? pending.some(
          (p) =>
            p.characterId === characterId && p.kind === "levelup" && p.targetLevel === level + 1,
        )
      : pending.some((p) => p.characterId === characterId && p.kind === "unlock");
    hamsters.push({
      characterId,
      level,
      ownM,
      unlocked,
      state,
      unlockThresholdM: thresholdM,
      levelUpReady: unlocked && level < 5 && nextThreshold !== null && ownM >= nextThreshold,
      levelUpProgress:
        unlocked && level < 5 && nextThreshold
          ? Math.min(1, ownM / nextThreshold)
          : unlocked
            ? 1
            : 0,
      levelUpThresholdM: unlocked && level < 5 ? nextThreshold : null,
      pendingMint,
    });
  }
  // Hidden character (not in UNLOCK_ORDER): discovered per account;
  // mint additionally needs IMDPEPE_UNLOCK_TOTAL_M of account mileage.
  // Playable once its unlock mint is registered (hasImdpepeMint).
  // Guests never count as discovered or unlocked (see isUnlocked):
  // imdpepe stays an undiscovered "???" silhouette for them.
  const isGuest = player.isPreview === 1;
  const discovered = !isGuest && (await hasDiscoveredImdpepe(db, player.id));
  {
    const characterId = IMDPEPE_ID;
    const level = await levelFor(db, player.id, characterId);
    const ownM = perCharMeters[characterId] ?? 0;
    const thresholdM = IMDPEPE_UNLOCK_TOTAL_M;
    const unlocked = !isGuest && (await hasImdpepeMint(db, player.id));
    const hasPending = pending.some((p) => p.characterId === characterId);
    const state = unlocked
      ? "unlocked"
      : discovered && totalM >= thresholdM
        ? "eligible"
        : "locked";
    const nextThreshold = LEVEL_UP_M[level] ?? null;
    hamsters.push({
      characterId,
      level,
      ownM,
      unlocked,
      state: state as "unlocked" | "eligible" | "locked",
      unlockThresholdM: thresholdM,
      levelUpReady: unlocked && level < 5 && nextThreshold !== null && ownM >= nextThreshold,
      levelUpProgress:
        unlocked && level < 5 && nextThreshold
          ? Math.min(1, ownM / nextThreshold)
          : unlocked
            ? 1
            : 0,
      levelUpThresholdM: unlocked && level < 5 ? nextThreshold : null,
      pendingMint: unlocked
        ? pending.some(
            (p) =>
              p.characterId === characterId && p.kind === "levelup" && p.targetLevel === level + 1,
          )
        : hasPending,
    });
  }
  return { totalM, hamsters, pending, imdpepeDiscovered: discovered };
}

/* --------------------------- mint flow (one-click) --------------------------- */

/** Server-side mint eligibility, shared by requestMint /
 *  getMintAuthorization: unlocks need the account-mileage gate (plus
 *  discovery for imdpepe), level-ups need the hamster's own mileage.
 *  Returns the target level; throws the same plain-language errors the
 *  UI has always shown. */
async function checkMintEligibility(
  db: Db,
  player: typeof schema.players.$inferSelect,
  characterId: string,
  kind: "unlock" | "levelup",
): Promise<{ targetLevel: number }> {
  if (player.isPreview === 1) throw new Error("游客模式不能 Mint，连接钱包后可用");
  const { hamsters, totalM } = await progressionFor(db, player);
  const prog = hamsters.find((h) => h.characterId === characterId);
  if (!prog) throw new Error("仓鼠不存在");
  const name = CHAR_DISPLAY_NAME[characterId] ?? characterId;
  if (kind === "unlock") {
    if (prog.unlocked) throw new Error("这只仓鼠已经解锁了");
    if (characterId === IMDPEPE_ID) {
      if (!(await hasDiscoveredImdpepe(db, player.id))) {
        throw new Error("还没发现这个角色，不能 mint");
      }
      if (totalM < IMDPEPE_UNLOCK_TOTAL_M) {
        throw new Error(
          `账号总里程还差 ${IMDPEPE_UNLOCK_TOTAL_M - totalM} 米到解锁这个角色（需要 100,000 米，已跑 ${totalM} 米）`,
        );
      }
      return { targetLevel: 1 };
    }
    // Sequential order: the previous hamster in UNLOCK_ORDER must
    // already be held before the next one may unlock (the contract
    // enforces this too; the server must not sign past it).
    const orderIdx = (UNLOCK_ORDER as readonly string[]).indexOf(characterId);
    if (orderIdx > 0) {
      const prevId = UNLOCK_ORDER[orderIdx - 1]!;
      const prev = hamsters.find((h) => h.characterId === prevId);
      if (!prev?.unlocked) {
        throw new Error(
          `要按顺序解锁：先解锁${CHAR_DISPLAY_NAME[prevId] ?? prevId}，才能解锁${name}`,
        );
      }
    }
    // The account-mileage gate itself — checked directly against the
    // threshold for THIS species, never via a cached state or a stale
    // registration (a pending row used to bypass this check entirely).
    const thresholdM = UNLOCK_TOTAL_M[characterId] ?? 0;
    if (totalM < thresholdM) {
      throw new Error(
        `账号总里程还差 ${thresholdM - totalM} 米到解锁${name}（需要 ${thresholdM} 米，已跑 ${totalM} 米）`,
      );
    }
    return { targetLevel: 1 };
  }
  if (!prog.unlocked) throw new Error("这只仓鼠还没解锁，不能升级");
  if (prog.level >= 5) throw new Error("已经满级了");
  // The gate for the TARGET level: prog.level is the effective (chain)
  // level, so levelling to Lv4 checks LEVEL_UP_M[3] = 5000 m of this
  // hamster's own mileage. No pending-registration bypass: a recorded
  // mint for an earlier level never authorises the next one.
  const targetLevel = prog.level + 1;
  const thresholdM = LEVEL_UP_M[prog.level];
  if (thresholdM === undefined) throw new Error("已经满级了");
  if (prog.ownM < thresholdM) {
    throw new Error(
      `${name}本鼠里程还差 ${thresholdM - prog.ownM} 米到 Lv${targetLevel}（需要 ${thresholdM} 米，已跑 ${prog.ownM} 米）`,
    );
  }
  return { targetLevel };
}

/** Writes (or updates) the mint registration row for an eligible mint. */
async function recordMintRequest(
  db: Db,
  playerId: number,
  characterId: string,
  kind: "unlock" | "levelup",
  targetLevel: number,
  txHash: string | null,
): Promise<void> {
  const existing = await db
    .select()
    .from(schema.mintRequests)
    .where(
      and(
        eq(schema.mintRequests.playerId, playerId),
        eq(schema.mintRequests.characterId, characterId),
        eq(schema.mintRequests.kind, kind),
        eq(schema.mintRequests.targetLevel, targetLevel),
      ),
    )
    .limit(1);
  if (!existing[0]) {
    await db.insert(schema.mintRequests).values({
      playerId,
      characterId,
      kind,
      targetLevel,
      priceEth: MINT_PRICE_ETH,
      status: "pending_payment",
      txHash,
    });
  } else if (txHash && !existing[0].txHash) {
    await db
      .update(schema.mintRequests)
      .set({ txHash })
      .where(eq(schema.mintRequests.id, existing[0].id));
  }
}

const mintAuthResponse = z.object({
  mode: z.enum(["onchain", "registered"]),
  contract: z.string().nullable(),
  species: z.number().nullable(),
  deadline: z.number().nullable(),
  signature: z.string().nullable(),
  priceWei: z.string(),
  priceEth: z.string(),
});

/* --------------------------------- shapes --------------------------------- */

const playerShape = z.object({
  id: z.number(),
  address: z.string(),
  name: z.string(),
  isPreview: z.boolean(),
});

const boardEntry = z.object({
  rank: z.number(),
  playerId: z.number(),
  name: z.string(),
  address: z.string(),
  score: z.number(),
  characterId: z.string(),
  level: z.number(),
  squeekBlock: z.number().nullable(),
});

type BoardEntry = z.infer<typeof boardEntry>;

const yesterdayChampionResponse = z.object({
  dayId: z.string(),
  dayDisplay: z.string(),
  status: z.enum(["none", "pending", "submitted", "failed"]),
  player: z.string(),
  name: z.string(),
  score: z.number(),
  distance: z.number(),
  characterId: z.string(),
  level: z.number(),
  squeekBlock: z.number().nullable(),
  txHash: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  contractUrl: z.string(),
});

/** Best-single-run-per-player board over formal (non-preview) runs,
 *  optionally restricted to a [start, end) creation window. Shared by
 *  the all-time board and the UTC daily board so both apply the exact
 *  same exclusions. */
async function boardEntries(
  db: Db,
  opts: { start?: Date; end?: Date; limit: number },
): Promise<{ entries: BoardEntry[]; totalPlayers: number }> {
  const conds = [eq(schema.runs.isPreview, 0)];
  if (opts.start) conds.push(gte(schema.runs.createdAt, opts.start));
  if (opts.end) conds.push(lt(schema.runs.createdAt, opts.end));
  const where = and(...conds);
  const rows = await db
    .select({
      playerId: schema.runs.playerId,
      best: sql<number>`MAX(${schema.runs.score})`,
    })
    .from(schema.runs)
    .where(where)
    .groupBy(schema.runs.playerId)
    .orderBy(desc(sql`MAX(${schema.runs.score})`))
    .limit(opts.limit);

  const entries: BoardEntry[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const playerRows = await db
      .select()
      .from(schema.players)
      .where(eq(schema.players.id, row.playerId))
      .limit(1);
    const bestRunConds = [
      eq(schema.runs.playerId, row.playerId),
      eq(schema.runs.score, row.best),
      eq(schema.runs.isPreview, 0),
    ];
    if (opts.start) bestRunConds.push(gte(schema.runs.createdAt, opts.start));
    if (opts.end) bestRunConds.push(lt(schema.runs.createdAt, opts.end));
    const bestRunRows = await db
      .select()
      .from(schema.runs)
      .where(and(...bestRunConds))
      .orderBy(schema.runs.id)
      .limit(1);
    const p = playerRows[0];
    const br = bestRunRows[0];
    if (!p || !br) continue;
    entries.push({
      rank: i + 1,
      playerId: p.id,
      name: p.name,
      address: p.address,
      score: row.best,
      characterId: br.characterId,
      level: br.level,
      squeekBlock: br.squeekBlock ?? null,
    });
  }

  const countRows = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${schema.runs.playerId})` })
    .from(schema.runs)
    .where(where);
  return { entries, totalPlayers: countRows[0]?.n ?? 0 };
}

/* --------------------- daily champion settlement ------------------------
 * Rule (owner, 2026-11-03): at every UTC day boundary the PREVIOUS UTC
 * day's #1 formal run becomes that day's champion and is written to the
 * Sepolia ScoreLedger contract. The public (Cloudflare) build runs this
 * from a Cron Trigger at 00:00 UTC; this Muse build has no cron, so the
 * same settlement runs lazily on the first read of a new day (and is
 * retried on later reads while a row is pending/failed). One row per
 * day in daily_champions; a day is only ever submitted once — before
 * submitting we re-read the contract, and a champion already on chain
 * (e.g. written by the other build's cron) is adopted, never rewritten. */

function utcDayId(d: Date): string {
  return (
    String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

function utcDayDisplay(dayId: string): string {
  return `${dayId.slice(0, 4)}-${dayId.slice(4, 6)}-${dayId.slice(6, 8)}`;
}

/** The day's #1 formal run (best single run; earliest run wins a tie
 *  because boardEntries orders by score desc over grouped maxima and
 *  picks each player's earliest best run). */
async function dailyChampionRun(db: Db, dayId: string) {
  const y = Number(dayId.slice(0, 4));
  const m = Number(dayId.slice(4, 6));
  const d = Number(dayId.slice(6, 8));
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 1));
  const { entries } = await boardEntries(db, { start, end, limit: 1 });
  const top = entries[0];
  if (!top) return null;
  const runRows = await db
    .select()
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.playerId, top.playerId),
        eq(schema.runs.score, top.score),
        eq(schema.runs.isPreview, 0),
        gte(schema.runs.createdAt, start),
        lt(schema.runs.createdAt, end),
      ),
    )
    .orderBy(schema.runs.id)
    .limit(1);
  const run = runRows[0];
  if (!run) return null;
  return { entry: top, run };
}

async function chainChampion(dayNum: number) {
  const out = await ethCall(
    SCORE_LEDGER,
    selector("getChampion(uint32)") + encUint(dayNum),
  );
  if (!out || out.length < 2 + 64 * 6) return null;
  const player = "0x" + out.slice(2 + 24, 2 + 64).toLowerCase();
  if (player === "0x0000000000000000000000000000000000000000") return null;
  return {
    player,
    score: Number(wordAt(out, 1)),
    distance: Number(wordAt(out, 2)),
    hamsterSpecies: Number(wordAt(out, 3)),
    squeekBlock: Number(wordAt(out, 4)),
    payloadHash:
      "0x" + out.slice(2 + 64 * 5, 2 + 64 * 6).toLowerCase(),
  };
}

export const Actions = {
  getWalletConnectConfig: defineAction({
    description:
      "Returns the public WalletConnect configuration for QR sign-in: whether the owner's Project ID has been configured, that ID when present, and the target Sepolia chain.",
    request: z.object({}),
    response: z.object({
      configured: z.boolean(),
      projectId: z.string().nullable(),
      chainId: z.number(),
    }),
    async handler(): Promise<{ configured: boolean; projectId: string | null; chainId: number }> {
      const projectId = WALLET_CONNECT_PROJECT_ID.trim();
      return {
        configured: projectId.length > 0,
        projectId: projectId || null,
        chainId: WALLET_CONNECT_CHAIN_ID,
      };
    },
  }),

  getChallenge: defineAction({
    description: "Issues a one-time sign-in challenge message for a wallet address.",
    request: z.object({ address: z.string().regex(ADDRESS_RE) }),
    response: z.object({ message: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const address = args.address.toLowerCase();
      const nonce = randomHex(16);
      const message =
        `仓鼠快跑 · 签名登录\n` +
        `钱包: ${address}\n` +
        `随机码: ${nonce}\n` +
        `签名只证明这个钱包地址是你的，不能转走你的任何资产，不转账、不花 gas。`;
      await db.insert(schema.challenges).values({ address, nonce, message });
      return { message };
    },
  }),

  verifySignature: defineAction({
    description: "Verifies a wallet signature against the pending challenge and returns a session token.",
    request: z.object({
      address: z.string().regex(ADDRESS_RE),
      signature: z.string().min(100),
      name: z.string().trim().max(16).optional(),
    }),
    response: z.object({
      token: z.string(),
      player: playerShape,
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const address = args.address.toLowerCase();
      const pending = await db
        .select()
        .from(schema.challenges)
        .where(and(eq(schema.challenges.address, address), eq(schema.challenges.used, 0)))
        .orderBy(desc(schema.challenges.id))
        .limit(1);
      const challenge = pending[0];
      if (!challenge) throw new Error("没有待验证的签名挑战，请重新连接钱包");
      if (Date.now() - challenge.createdAt.getTime() > 10 * 60 * 1000) {
        throw new Error("签名挑战已过期，请重新连接钱包");
      }
      const recovered = recoverPersonalSign(challenge.message, args.signature);
      if (!recovered || recovered.toLowerCase() !== address) {
        throw new Error("签名验证失败：签名和钱包地址对不上");
      }
      await db
        .update(schema.challenges)
        .set({ used: 1 })
        .where(eq(schema.challenges.id, challenge.id));

      const existing = await db
        .select()
        .from(schema.players)
        .where(eq(schema.players.address, address))
        .limit(1);
      let player = existing[0];
      if (!player) {
        const inserted = await db
          .insert(schema.players)
          .values({
            address,
            name: args.name?.trim() ? args.name.trim() : shortName(address),
            isPreview: 0,
          })
          .returning();
        player = inserted[0];
      } else if (args.name?.trim() && player.isPreview === 0) {
        await db
          .update(schema.players)
          .set({ name: args.name.trim() })
          .where(eq(schema.players.id, player.id));
        player = { ...player, name: args.name.trim() };
      }
      if (!player) throw new Error("玩家创建失败");
      const token = randomHex(24);
      await db.insert(schema.sessions).values({ token, playerId: player.id });
      ctx.invalidateQueries();
      return {
        token,
        player: {
          id: player.id,
          address: player.address,
          name: player.name,
          isPreview: player.isPreview === 1,
        },
      };
    },
  }),

  startPreview: defineAction({
    description: "Creates a guest-mode player (no wallet) and returns its session token. Guests can only play the base hamster Lizi at Lv1, and guest scores never enter the official leaderboard.",
    request: z.object({ name: z.string().trim().max(16).optional() }),
    response: z.object({ token: z.string(), player: playerShape }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const address = `preview:${randomHex(10)}`;
      const inserted = await db
        .insert(schema.players)
        .values({
          address,
          name: args.name?.trim() ? args.name.trim() : "游客",
          isPreview: 1,
        })
        .returning();
      const player = inserted[0];
      if (!player) throw new Error("游客创建失败");
      const token = randomHex(24);
      await db.insert(schema.sessions).values({ token, playerId: player.id });
      return {
        token,
        player: {
          id: player.id,
          address: player.address,
          name: player.name,
          isPreview: true,
        },
      };
    },
  }),

  me: defineAction({
    description: "Returns the player for a session token, or null when the token is unknown.",
    request: z.object({ token: z.string() }),
    response: z.object({ player: playerShape.nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const player = await playerByToken(db, args.token);
      if (!player) return { player: null };
      return {
        player: {
          id: player.id,
          address: player.address,
          name: player.name,
          isPreview: player.isPreview === 1,
        },
      };
    },
  }),

  getMyHamsters: defineAction({
    description: "Returns the signed-in player's hamsters with their current skill levels (Lv1–Lv5), including the hidden character imdpepe.",
    request: z.object({ token: z.string() }),
    response: z.object({
      hamsters: z.array(z.object({ characterId: z.string(), level: z.number() })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const player = await playerByToken(db, args.token);
      if (!player) throw new Error("登录已失效，请重新进入");
      const hamsters = [];
      for (const characterId of CHAR_IDS) {
        hamsters.push({ characterId, level: await levelFor(db, player.id, characterId) });
      }
      return { hamsters };
    },
  }),

  getProgression: defineAction({
    description:
      "Returns the player's progression under rules v2: lifetime mileage in metres (total and per hamster), which hamsters are unlocked / eligible / locked, unlock thresholds in metres (2000 / 5000 / 10000 / 20000 m of account total), level-up readiness and the confirmed own-hamster cumulative metre threshold for the next level (Lv2 1000 / Lv3 3000 / Lv4 5000 / Lv5 8000 m), the fixed mint price, and any pending mint registrations.",
    request: z.object({ token: z.string() }),
    response: z.object({
      totalM: z.number(),
      imdpepeDiscovered: z.boolean(),
      mintPriceEth: z.string(),
      contractV2Pending: z.boolean(),
      stats: z.object({
        runs: z.number(),
        bestScore: z.number(),
        bestDistanceMeters: z.number(),
      }),
      hamsters: z.array(progressionHamster),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const player = await playerByToken(db, args.token);
      if (!player) throw new Error("登录已失效，请重新进入");
      const { totalM, hamsters, imdpepeDiscovered } = await progressionFor(db, player);
      const statRows = await db
        .select({
          runs: sql<number>`COUNT(*)`,
          bestScore: sql<number>`MAX(${schema.runs.score})`,
          bestDistance: sql<number>`MAX(${schema.runs.distance})`,
        })
        .from(schema.runs)
        .where(eq(schema.runs.playerId, player.id));
      const stats = {
        runs: statRows[0]?.runs ?? 0,
        bestScore: statRows[0]?.bestScore ?? 0,
        bestDistanceMeters: statRows[0]?.bestDistance ?? 0,
      };
      return { totalM, imdpepeDiscovered, mintPriceEth: MINT_PRICE_ETH, contractV2Pending: false, stats, hamsters };
    },
  }),

  requestMint: defineAction({
    description:
      "Registers a mint intent (unlock or level-up) for an eligible hamster at the fixed 0.01 Sepolia ETH price, stored as pending_payment. Eligibility (account mileage for unlocks, own-hamster mileage for level-ups) is verified server-side here. Kept for imdpepe; wallet players use the one-click getMintAuthorization + confirmMint flow instead. Guest accounts are rejected inside checkMintEligibility.",
    request: z.object({
      token: z.string(),
      characterId: z.enum(CHAR_IDS),
      kind: z.enum(["unlock", "levelup"]),
    }),
    response: z.object({
      recorded: z.boolean(),
      status: z.string(),
      priceEth: z.string(),
    }),
    handler: async (ctx, args): Promise<{ recorded: boolean; status: string; priceEth: string }> => {
      const db = ctx.db<typeof schema>();
      const player = await playerByToken(db, args.token);
      if (!player) throw new Error("登录已失效，请重新进入");
      const { targetLevel } = await checkMintEligibility(db, player, args.characterId, args.kind);
      await recordMintRequest(db, player.id, args.characterId, args.kind, targetLevel, null);
      ctx.invalidateQueries();
      return { recorded: true, status: "pending_payment", priceEth: MINT_PRICE_ETH };
    },
  }),

  getMintAuthorization: defineAction({
    description:
      "One-click mint, step hidden in the background: verifies the player's mileage eligibility server-side, then returns everything the wallet needs to send the HamsterNFT v2 mint in a single confirmation — contract, species, deadline and the server authorisation signature (signed on the owner's machine by the privileged signer; the key never leaves it). imdpepe (no contract species) is registered in-game instead and returns mode=registered. Guest accounts never reach here — checkMintEligibility rejects them.",
    request: z.object({
      token: z.string(),
      characterId: z.enum(CHAR_IDS),
      kind: z.enum(["unlock", "levelup"]),
    }),
    response: mintAuthResponse,
    privileged: [PrivilegedContracts.signMintAuthorization],
    handler: async (ctx, args): Promise<z.infer<typeof mintAuthResponse>> => {
      const db = ctx.db<typeof schema>();
      const player = await playerByToken(db, args.token);
      if (!player) throw new Error("登录已失效，请重新进入");
      const { targetLevel } = await checkMintEligibility(db, player, args.characterId, args.kind);
      const species = SPECIES_OF[args.characterId];
      // imdpepe has no species on the contract, so it keeps the in-game
      // registration. (Guests are already rejected by
      // checkMintEligibility above; the isPreview check stays as a
      // belt-and-braces guard.)
      if (player.isPreview === 1 || !ADDRESS_RE.test(player.address) || !species) {
        await recordMintRequest(db, player.id, args.characterId, args.kind, targetLevel, null);
        ctx.invalidateQueries();
        return {
          mode: "registered",
          contract: null,
          species: null,
          deadline: null,
          signature: null,
          priceWei: "10000000000000000",
          priceEth: MINT_PRICE_ETH,
        };
      }
      const nonce = await chainMintNonce(player.address);
      if (nonce === null) throw new Error("链上暂时读不到，请稍后再试");
      const trustedSigner = await chainServerSigner();
      if (!trustedSigner) throw new Error("链上暂时读不到，请稍后再试");
      const deadline = Math.floor(Date.now() / 1000) + 600;
      let signed: { signature: string; signer: string };
      try {
        signed = await ctx.executePrivileged(PrivilegedContracts.signMintAuthorization, {
          player: player.address.toLowerCase(),
          species,
          deadline,
          nonce: Number(nonce),
        });
      } catch {
        throw new Error("签名服务暂时不可用，请稍后再试");
      }
      if (signed.signer.toLowerCase() !== trustedSigner) {
        throw new Error("签名服务暂时不可用，请稍后再试");
      }
      return {
        mode: "onchain",
        contract: HAMSTER_NFT,
        species,
        deadline,
        signature: signed.signature,
        priceWei: "10000000000000000",
        priceEth: MINT_PRICE_ETH,
      };
    },
  }),

  confirmMint: defineAction({
    description:
      "Records a wallet mint after the fact: verifies the transaction receipt on Sepolia (successful, sent by the player, to HamsterNFT v2, paying exactly 0.01 ETH) and only then writes the mint registration with the tx hash, so the hamster's card state and level refresh. Returns confirmed=false while the transaction is still pending on chain.",
    request: z.object({
      token: z.string(),
      characterId: z.enum(CHAR_IDS),
      kind: z.enum(["unlock", "levelup"]),
      txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    }),
    response: z.object({ confirmed: z.boolean(), status: z.string() }),
    handler: async (
      ctx,
      args,
    ): Promise<{ confirmed: boolean; status: string }> => {
      const db = ctx.db<typeof schema>();
      const player = await playerByToken(db, args.token);
      if (!player) throw new Error("登录已失效，请重新进入");
      const receipt = await ethRpc("eth_getTransactionReceipt", [args.txHash]);
      if (!receipt) return { confirmed: false, status: "pending" };
      if (receipt.status !== "0x1") throw new Error("这笔交易在链上失败了，Mint 没有完成");
      const rawTx = await ethRpc("eth_getTransactionByHash", [args.txHash]);
      if (!rawTx) return { confirmed: false, status: "pending" };
      const valueWei = (() => {
        try {
          return BigInt(String(rawTx.value ?? "0x0"));
        } catch {
          return 0n;
        }
      })();
      if (
        String(rawTx.from ?? "").toLowerCase() !== player.address.toLowerCase() ||
        String(rawTx.to ?? "").toLowerCase() !== HAMSTER_NFT.toLowerCase() ||
        valueWei !== 10000000000000000n
      ) {
        throw new Error("这笔交易和本次 Mint 对不上，没有登记");
      }
      // The mint already happened on chain (receipt verified above), so
      // eligibility is NOT re-checked here — the chain holding would now
      // read as "already unlocked". The recorded target level is the
      // level the mint actually produced: the post-mint chain level
      // (progression's level already includes it, so never add +1 to a
      // chain-derived level — that would record one level too many).
      const { hamsters } = await progressionFor(db, player);
      const prog = hamsters.find((h) => h.characterId === args.characterId);
      if (!prog) throw new Error("仓鼠不存在");
      let targetLevel: number;
      if (args.kind === "unlock") {
        targetLevel = 1;
      } else {
        const species = SPECIES_OF[args.characterId];
        const chainLevel =
          species && ADDRESS_RE.test(player.address)
            ? await chainSpeciesLevel(player.address, species)
            : null;
        targetLevel =
          chainLevel !== null && chainLevel > 0
            ? Math.min(5, chainLevel)
            : Math.min(5, prog.level + 1);
      }
      await recordMintRequest(db, player.id, args.characterId, args.kind, targetLevel, args.txHash);
      ctx.invalidateQueries();
      return { confirmed: true, status: "recorded" };
    },
  }),

  getChainHamsters: defineAction({
    description: "Reads the player's hamster holdings and levels from the Sepolia HamsterNFT contract (speciesLevel / balanceOf / mintOpen).",
    request: z.object({ token: z.string() }),
    response: z.object({
      available: z.boolean(),
      mintOpen: z.boolean(),
      balance: z.number(),
      hamsters: z.array(
        z.object({ characterId: z.string(), species: z.number(), chainLevel: z.number() }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const player = await playerByToken(db, args.token);
      if (!player) throw new Error("登录已失效，请重新进入");
      const empty = { available: false, mintOpen: false, balance: 0, hamsters: [] };
      if (player.isPreview === 1 || !ADDRESS_RE.test(player.address)) return empty;
      const balOut = await ethCall(
        HAMSTER_NFT,
        selector("balanceOf(address)") + encAddress(player.address),
      );
      if (!balOut) return empty;
      const openOut = await ethCall(HAMSTER_NFT, selector("mintOpen()"));
      const hamsters = [];
      for (const characterId of CHAR_IDS) {
        const species = SPECIES_OF[characterId];
        if (!species) continue; // imdpepe: no species on the contract
        const chainLevel = (await chainSpeciesLevel(player.address, species)) ?? 0;
        hamsters.push({ characterId, species, chainLevel });
      }
      return {
        available: true,
        mintOpen: openOut ? wordAt(openOut, 0) === 1n : false,
        balance: Number(wordAt(balOut, 0)),
        hamsters,
      };
    },
  }),

  dailyBoard: defineAction({
    description:
      "Returns today's (UTC) daily leaderboard for the lobby's small daily card: best single formal run per player since 00:00 UTC, top 3; guest (preview) runs excluded, same as the all-time board. The day rolls over automatically at 00:00 UTC because the query window is derived from the current UTC date.",
    request: z.object({}),
    response: z.object({
      dayId: z.string(),
      entries: z.array(boardEntry),
      totalPlayers: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const now = new Date();
      const start = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const end = new Date(start.getTime() + 86400000);
      const { entries, totalPlayers } = await boardEntries(db, { start, end, limit: 3 });
      return { dayId: utcDayDisplay(utcDayId(now)), entries, totalPlayers };
    },
  }),

  getYesterdayChampion: defineAction({
    description:
      "Returns yesterday's (UTC) champion proof: the previous UTC day's #1 formal run, settled to the Sepolia ScoreLedger contract. Settlement is idempotent — an on-chain record for the day is adopted, never rewritten; otherwise the first read of a new day submits it via the host-only deployer signer (the public build does the same from its 00:00 UTC cron). Status is honest: none / pending / failed rows never claim an on-chain record.",
    request: z.object({}),
    response: yesterdayChampionResponse,
    privileged: [PrivilegedContracts.submitChampionProof],
    handler: async (ctx): Promise<z.infer<typeof yesterdayChampionResponse>> => {
      const db = ctx.db<typeof schema>();
      const now = new Date();
      const yest = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
      );
      const dayId = utcDayId(yest);
      const dayNum = Number(dayId);
      const base = {
        dayId,
        dayDisplay: utcDayDisplay(dayId),
        contractUrl: `${SEPOLIA_EXPLORER}/address/${SCORE_LEDGER}`,
      };
      const none: z.infer<typeof yesterdayChampionResponse> = {
        ...base,
        status: "none",
        player: "",
        name: "",
        score: 0,
        distance: 0,
        characterId: "",
        level: 0,
        squeekBlock: null,
        txHash: null,
        explorerUrl: null,
      };

      const rowRows = await db
        .select()
        .from(schema.dailyChampions)
        .where(eq(schema.dailyChampions.dayId, dayId))
        .limit(1);
      const row = rowRows[0];
      if (row && row.status === "submitted" && row.txHash) {
        return {
          ...base,
          status: "submitted",
          player: row.playerAddress,
          name: row.playerName,
          score: row.score,
          distance: row.distance,
          characterId: row.characterId,
          level: row.level,
          squeekBlock: row.squeekBlock ?? null,
          txHash: row.txHash,
          explorerUrl: `${SEPOLIA_EXPLORER}/tx/${row.txHash}`,
        };
      }

      const champ = await dailyChampionRun(db, dayId);
      const onChain = await chainChampion(dayNum);

      // A record already on chain for this day (e.g. written by the
      // public build's cron) is the day's proof — adopt it, never
      // rewrite it.
      if (onChain) {
        const localMatch =
          champ && champ.entry.address.toLowerCase() === onChain.player
            ? champ
            : null;
        const speciesId = Object.keys(SPECIES_OF).find(
          (k) => SPECIES_OF[k] === onChain.hamsterSpecies,
        );
        const adopted: z.infer<typeof yesterdayChampionResponse> = {
          ...base,
          status: "submitted",
          player: onChain.player,
          name: localMatch ? localMatch.entry.name : "",
          score: onChain.score,
          distance: onChain.distance,
          characterId: localMatch ? localMatch.entry.characterId : (speciesId ?? ""),
          level: localMatch ? localMatch.entry.level : 0,
          squeekBlock: onChain.squeekBlock || null,
          txHash: row?.txHash ?? null,
          explorerUrl: row?.txHash
            ? `${SEPOLIA_EXPLORER}/tx/${row.txHash}`
            : base.contractUrl,
        };
        if (champ) {
          await db
            .insert(schema.dailyChampions)
            .values({
              dayId,
              playerId: champ.entry.playerId,
              playerAddress: champ.entry.address,
              playerName: champ.entry.name,
              score: champ.entry.score,
              distance: champ.run.distance,
              characterId: champ.entry.characterId,
              level: champ.entry.level,
              squeekBlock: champ.run.squeekBlock ?? null,
              payloadHash: onChain.payloadHash,
              status: "submitted",
              txHash: row?.txHash ?? null,
              attempts: row?.attempts ?? 0,
              lastError: null,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: schema.dailyChampions.dayId,
              set: { status: "submitted", updatedAt: new Date() },
            });
        }
        return adopted;
      }

      if (!champ) return none;

      const { entry, run } = champ;
      const payloadHash =
        "0x" +
        bytesToHex(
          keccak256(
            new TextEncoder().encode(
              `hamster-run:champion:${dayId}:${run.id}:${entry.playerId}:${entry.score}`,
            ),
          ),
        );
      const pendingRow = {
        dayId,
        playerId: entry.playerId,
        playerAddress: entry.address,
        playerName: entry.name,
        score: entry.score,
        distance: run.distance,
        characterId: entry.characterId,
        level: entry.level,
        squeekBlock: run.squeekBlock ?? null,
        payloadHash,
        attempts: (row?.attempts ?? 0) + 1,
        updatedAt: new Date(),
      };
      await db
        .insert(schema.dailyChampions)
        .values({ ...pendingRow, status: "pending" })
        .onConflictDoUpdate({
          target: schema.dailyChampions.dayId,
          set: { ...pendingRow, status: "pending" },
        });

      const data: z.infer<typeof yesterdayChampionResponse> = {
        ...base,
        status: "pending",
        player: entry.address,
        name: entry.name,
        score: entry.score,
        distance: run.distance,
        characterId: entry.characterId,
        level: entry.level,
        squeekBlock: run.squeekBlock ?? null,
        txHash: null,
        explorerUrl: null,
      };
      try {
        const res = await ctx.executePrivileged(
          PrivilegedContracts.submitChampionProof,
          {
            dayId: dayNum,
            player: entry.address.toLowerCase(),
            score: entry.score,
            distance: run.distance,
            species: SPECIES_OF[entry.characterId] ?? 0,
            squeekBlock: run.squeekBlock ?? 0,
            payloadHash,
          },
        );
        await db
          .update(schema.dailyChampions)
          .set({
            status: "submitted",
            txHash: res.txHash,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(schema.dailyChampions.dayId, dayId));
        return {
          ...data,
          status: "submitted",
          txHash: res.txHash,
          explorerUrl: `${SEPOLIA_EXPLORER}/tx/${res.txHash}`,
        };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await db
          .update(schema.dailyChampions)
          .set({ status: "failed", lastError: message, updatedAt: new Date() })
          .where(eq(schema.dailyChampions.dayId, dayId));
        return { ...data, status: "failed" };
      }
    },
  }),

  getDailyTrack: defineAction({
    description: "Returns today's Squeekchain-generated track info (source block height and seed provenance) for the lobby display.",
    request: z.object({}),
    response: z.object({
      dayId: z.string(),
      blockHeight: z.number(),
      source: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const track = await ensureDailyTrack(db);
      return { dayId: track.dayId, blockHeight: track.blockHeight, source: track.source };
    },
  }),

  getRelay: defineAction({
    description: "Returns the SQUEEKTOSHI Squeekchain mileage relay: lifetime distance vs the launch-day baseline, kilometres gained, and unlocked track themes (one new theme per 100 km gained).",
    request: z.object({}),
    response: z.object({
      available: z.boolean(),
      baselineKm: z.number(),
      currentKm: z.number(),
      gainedKm: z.number(),
      nextMilestoneKm: z.number(),
      themes: z.array(z.string()),
      unlockedThemes: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const stats = await squeekJson("/measurement/stats?range=7d");
      const rows = await db.select().from(schema.relayState).limit(1);
      let state = rows[0];
      const currentMm = stats?.lifetime?.observedDistanceMm
        ? parseInt(String(stats.lifetime.observedDistanceMm), 10)
        : NaN;
      if (Number.isFinite(currentMm)) {
        if (!state) {
          // first ever read = the launch baseline (§6 结合③)
          await db.insert(schema.relayState).values({
            id: 1,
            baselineMm: String(currentMm),
            lastMm: String(currentMm),
          });
          const saved = await db.select().from(schema.relayState).limit(1);
          state = saved[0];
        } else if (String(currentMm) !== state.lastMm) {
          await db
            .update(schema.relayState)
            .set({ lastMm: String(currentMm), updatedAt: new Date() })
            .where(eq(schema.relayState.id, 1));
          state = { ...state, lastMm: String(currentMm) };
        }
      }
      if (!state) {
        return {
          available: false,
          baselineKm: 0,
          currentKm: 0,
          gainedKm: 0,
          nextMilestoneKm: RELAY_STEP_KM,
          themes: RELAY_THEMES,
          unlockedThemes: 1,
        };
      }
      const baselineKm = parseInt(state.baselineMm, 10) / 1_000_000;
      const curKm = parseInt(state.lastMm, 10) / 1_000_000;
      const gainedKm = Math.max(0, curKm - baselineKm);
      return {
        available: true,
        baselineKm: Math.round(baselineKm * 100) / 100,
        currentKm: Math.round(curKm * 100) / 100,
        gainedKm: Math.round(gainedKm * 1000) / 1000,
        nextMilestoneKm: (Math.floor(gainedKm / RELAY_STEP_KM) + 1) * RELAY_STEP_KM,
        themes: RELAY_THEMES,
        unlockedThemes: Math.min(RELAY_THEMES.length, 1 + Math.floor(gainedKm / RELAY_STEP_KM)),
      };
    },
  }),

  getGhost: defineAction({
    description: "Returns today's historical-round ghost: a speed factor synthesized from a settled Squeekchain round's work distribution. The curve is synthesized, never a real replay.",
    request: z.object({}),
    response: z.object({
      available: z.boolean(),
      round: z.number(),
      work: z.number(),
      factor: z.number(),
    }),
    async handler() {
      const status = await squeekJson("/status");
      const stats = await squeekJson("/measurement/stats?range=30d");
      const rounds = stats?.rounds;
      const settled = parseInt(String(status?.builder?.anchor?.settledThroughRound ?? "0"), 10);
      if (!rounds || !settled) return { available: false, round: 0, work: 0, factor: 1 };
      const median = parseInt(String(rounds.medianActiveWork ?? "0"), 10) || 0;
      const p90 = parseInt(String(rounds.p90ActiveWork ?? "0"), 10) || median;
      const most = parseInt(String(rounds.mostActiveWork ?? "0"), 10) || median;
      const dayId = new Date().toISOString().slice(0, 10);
      const span = Math.max(0, most - median);
      const work = median + (span > 0 ? hashSeedInt(`ghost|${dayId}`) % (span + 1) : 0);
      const t = Math.min(1.5, Math.max(0, (work - median) / Math.max(1, p90 - median)));
      const factor = Math.round((0.85 + 0.35 * t) * 1000) / 1000;
      return { available: true, round: settled, work, factor };
    },
  }),

  discoverImdpepe: defineAction({
    description:
      "Records that the signed-in player discovered the hidden character imdpepe (the lobby easter egg: seven taps on the Shadow Rival card). Idempotent. Guest accounts cannot discover it — for them it stays an undiscovered silhouette.",
    request: z.object({ token: z.string() }),
    response: z.object({ discovered: z.boolean(), already: z.boolean() }),
    handler: async (
      ctx,
      args,
    ): Promise<{ discovered: boolean; already: boolean }> => {
      const db = ctx.db<typeof schema>();
      const player = await playerByToken(db, args.token);
      if (!player) throw new Error("登录已失效，请重新进入");
      // Guests get no discovery easter egg: imdpepe stays "???".
      if (player.isPreview === 1) {
        return { discovered: false, already: false };
      }
      if (await hasDiscoveredImdpepe(db, player.id)) {
        return { discovered: true, already: true };
      }
      await db.insert(schema.playerDiscoveries).values({
        playerId: player.id,
        characterId: IMDPEPE_ID,
      });
      ctx.invalidateQueries();
      return { discovered: true, already: false };
    },
  }),

  startRun: defineAction({
    description: "Starts a run on today's Squeekchain-generated track: returns the seed, the player's hamster level, and the source block.",
    request: z.object({
      token: z.string(),
      characterId: z.enum(CHAR_IDS),
    }),
    response: z.object({
      seed: z.number(),
      level: z.number(),
      dayId: z.string(),
      squeekBlock: z.number(),
      trackSource: z.string(),
      runToken: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const player = await playerByToken(db, args.token);
      if (!player) throw new Error("登录已失效，请重新进入");
      if (!(await isUnlocked(db, player, args.characterId))) {
        throw new Error("这只仓鼠还没解锁，先用已解锁的仓鼠累计里程吧");
      }
      const track = await ensureDailyTrack(db);
      const level = await effectiveLevel(db, player, args.characterId);
      const now = Date.now();
      const runToken = randomHex(24);
      await db.insert(schema.runTokens).values({
        token: runToken,
        playerId: player.id,
        characterId: args.characterId,
        seed: track.seed,
        issuedAt: now,
        expiresAt: now + 30 * 60 * 1000,
      });
      return {
        seed: track.seed,
        level,
        dayId: track.dayId,
        squeekBlock: track.blockHeight,
        trackSource: track.source,
        runToken,
      };
    },
  }),

  submitRun: defineAction({
    description:
      "Submits a finished run's input log; the server re-simulates it with the player's stored hamster level and stores only its own computed score, stamped with the current Squeekchain block height (score birth certificate).",
    request: z.object({
      token: z.string(),
      seed: z.number().int().min(0),
      characterId: z.enum(CHAR_IDS),
      runToken: z.string().optional(),
      inputs: z
        .array(
          z.object({
            tick: z.number().int().min(0),
            action: z.enum(["left", "right", "jump", "slide"]),
          }),
        )
        .max(20000),
    }),
    response: z.object({
      accepted: z.boolean(),
      reason: z.string().nullable(),
      score: z.number(),
      distance: z.number(),
      seeds: z.number(),
      rank: z.number().nullable(),
      bestScore: z.number(),
      level: z.number(),
      squeekBlock: z.number().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const player = await playerByToken(db, args.token);
      if (!player) throw new Error("登录已失效，请重新进入");
      // One-shot run token (security fix): the submission must carry the
      // token startRun issued for this player + character + daily seed,
      // and each token is consumed on first use — replaying a stored run
      // or forging one on an arbitrary seed is rejected before anything
      // is simulated or stored.
      const tokenReject = async (reason: string) => ({
        accepted: false,
        reason,
        score: 0,
        distance: 0,
        seeds: 0,
        rank: null,
        bestScore: 0,
        level: await levelFor(db, player.id, args.characterId),
        squeekBlock: null,
      });
      if (!args.runToken) {
        return tokenReject("run_token_required");
      }
      const tokenRows = await db
        .select()
        .from(schema.runTokens)
        .where(eq(schema.runTokens.token, args.runToken));
      const tokenRow = tokenRows[0];
      if (!tokenRow) {
        return tokenReject("invalid_run_token");
      }
      if (tokenRow.playerId !== player.id || tokenRow.characterId !== args.characterId) {
        return tokenReject("invalid_run_token");
      }
      if (tokenRow.usedAt !== null) {
        return tokenReject("run_token_used");
      }
      if (Date.now() > tokenRow.expiresAt) {
        return tokenReject("run_token_expired");
      }
      // Consume immediately: any later rejection keeps the token spent.
      await db
        .update(schema.runTokens)
        .set({ usedAt: Date.now() })
        .where(eq(schema.runTokens.id, tokenRow.id));
      if (args.seed !== tokenRow.seed) {
        return tokenReject("seed_mismatch");
      }
      if (!(await isUnlocked(db, player, args.characterId))) {
        const level = await levelFor(db, player.id, args.characterId);
        return {
          accepted: false,
          reason: "character_locked",
          score: 0,
          distance: 0,
          seeds: 0,
          rank: null,
          bestScore: 0,
          level,
          squeekBlock: null,
        };
      }
      const level = await effectiveLevel(db, player, args.characterId);

      const result = simulateRun(tokenRow.seed, args.characterId, args.inputs, level);
      if (!result.valid) {
        return {
          accepted: false,
          reason: result.reason ?? "invalid",
          score: 0,
          distance: 0,
          seeds: 0,
          rank: null,
          bestScore: 0,
          level,
          squeekBlock: null,
        };
      }

      // A real run takes wall-clock time: reject submissions that arrive
      // faster than the simulated run could possibly have been played.
      const minElapsedMs = Math.floor((result.ticks / 60) * 1000 * 0.9);
      if (Date.now() - tokenRow.issuedAt < minElapsedMs) {
        return {
          accepted: false,
          reason: "submit_too_early",
          score: 0,
          distance: 0,
          seeds: 0,
          rank: null,
          bestScore: 0,
          level,
          squeekBlock: null,
        };
      }

      // 成绩出生证明 (§6 结合④): stamp the run with the Squeekchain block
      // height at settlement time; the ScoreLedger contract will anchor
      // the same value on chain once its address is provided.
      const status = await squeekJson("/status");
      let squeekBlock = parseInt(String(status?.builder?.anchor?.blockHeight ?? "0"), 10) || 0;
      if (!squeekBlock) {
        const track = await ensureDailyTrack(db);
        squeekBlock = track.blockHeight;
      }

      const isPreview = player.isPreview === 1;
      await db.insert(schema.runs).values({
        playerId: player.id,
        seed: tokenRow.seed,
        characterId: args.characterId,
        score: result.score,
        distance: result.distance,
        seeds: result.seeds,
        ticks: result.ticks,
        isPreview: isPreview ? 1 : 0,
        level,
        squeekBlock: squeekBlock || null,
      });
      ctx.invalidateQueries();

      const bestRows = await db
        .select({ best: sql<number>`MAX(${schema.runs.score})` })
        .from(schema.runs)
        .where(eq(schema.runs.playerId, player.id));
      const bestScore = bestRows[0]?.best ?? result.score;

      let rank: number | null = null;
      if (!isPreview) {
        const better = await db
          .select({ playerId: schema.runs.playerId, best: sql<number>`MAX(${schema.runs.score})` })
          .from(schema.runs)
          .where(eq(schema.runs.isPreview, 0))
          .groupBy(schema.runs.playerId);
        const sorted = better.sort((a, b) => b.best - a.best);
        const idx = sorted.findIndex((r) => r.playerId === player.id);
        rank = idx >= 0 ? idx + 1 : null;
      }

      return {
        accepted: true,
        reason: null,
        score: result.score,
        distance: result.distance,
        seeds: result.seeds,
        rank,
        bestScore,
        level,
        squeekBlock: squeekBlock || null,
      };
    },
  }),

  leaderboard: defineAction({
    description: "Returns the official all-time leaderboard (best single run per wallet player across all days since launch; guest players excluded). The lobby asks for the top 30.",
    request: z.object({ limit: z.number().int().min(1).max(30).default(30) }),
    response: z.object({ entries: z.array(boardEntry), totalPlayers: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      return boardEntries(db, { limit: args.limit });
    },
  }),
} satisfies ActionsModule;
