// Hamster Run — Cloudflare Worker API.
//
// Equivalent port of the Muse-hosted server actions
// (server/src/actions.ts): same action names, same request/response
// shapes, same rules. The client calls POST /api/<actionName> with the
// args object as the JSON body (see client/src/api.ts — the Pages host
// page sets window.__HAMSTER_API_BASE__ = "/api").
//
// Differences from the hosted version, all infrastructure-only:
//  - storage is Cloudflare D1 (drizzle-orm/d1) instead of the space DB;
//    the schema file is the same one the hosted server uses;
//  - the mint authorisation signer reads its key from the Worker secret
//    MINT_SIGNER_PRIVATE_KEY (set with `wrangler secret put`) instead of
//    the owner's local deployer-wallet file. The key never appears in
//    code, config, or this package's files;
//  - scoring reuses sim.ts byte-for-byte (copied from server/src/sim.ts
//    and guarded by tests/sim-parity), so a run scores identically.
//
// Actions: getWalletConnectConfig, getChallenge, verifySignature,
// startPreview, me, getMyHamsters, getProgression, requestMint,
// getMintAuthorization, confirmMint, getChainHamsters, getChampion,
// getDailyTrack, getRelay, getGhost, discoverImdpepe, startRun,
// submitRun, leaderboard.

import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, gte, like, lt, or, sql } from "drizzle-orm";
import * as schema from "./schema";
import { simulateRun, type InputEvent } from "./sim";
import { bytesToHex, hexToBytes, keccak256, recoverDigestSign, recoverPersonalSign, signDigest } from "./evm";
import { WALLET_CONNECT_CHAIN_ID, WALLET_CONNECT_PROJECT_ID } from "./wallet-connect-config";

export interface Env {
  DB: D1Database;
  /** Deployer wallet private key (0x-prefixed hex) — wrangler secret ONLY. */
  MINT_SIGNER_PRIVATE_KEY?: string;
  /** Optional override of the bundled WalletConnect project id. */
  WALLET_CONNECT_PROJECT_ID?: string;
  /** Optional override of the public Sepolia RPC endpoint. */
  SEPOLIA_RPC_URL?: string;
  /** Management-console key (wrangler secret ADMIN_KEY). Requests to
   *  POST /api/admin/<name> must carry it in the x-admin-key header. */
  ADMIN_KEY?: string;
}

type Db = ReturnType<typeof drizzle<typeof schema>>;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const CHAR_IDS = ["lizi", "xueqiu", "meiqiu", "huasheng", "zhima", "imdpepe"] as const;
type CharId = (typeof CHAR_IDS)[number];
const IMDPEPE_ID = "imdpepe";
const IMDPEPE_UNLOCK_TOTAL_M = 100000;
const SQUEEK_API = "https://api.squeekchain.com/v1";
const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const HAMSTER_NFT = "0x15601070312Fd8071d11B6Bd2606B2A5D9ec620b";
const SCORE_LEDGER = "0xFB650C5503A2A05f01D4DF91e5a522EbD1Eba552";
const SPECIES_OF: Record<string, number> = {
  lizi: 1,
  xueqiu: 2,
  meiqiu: 3,
  huasheng: 4,
  zhima: 5,
};
const RELAY_THEMES = ["晨光草原", "黄昏屋顶", "星夜山谷", "雪原松林"];
const RELAY_STEP_KM = 100;
const UNLOCK_ORDER = ["lizi", "xueqiu", "meiqiu", "huasheng", "zhima"] as const;
const UNLOCK_TOTAL_M: Record<string, number> = {
  lizi: 0,
  xueqiu: 2000,
  meiqiu: 5000,
  huasheng: 10000,
  zhima: 20000,
  imdpepe: IMDPEPE_UNLOCK_TOTAL_M,
};
const MINT_PRICE_ETH = "0.01";
const LEVEL_UP_M: Record<number, number> = { 1: 1000, 2: 3000, 3: 5000, 4: 8000 };
const CHAR_DISPLAY_NAME: Record<string, string> = {
  lizi: "栗子",
  xueqiu: "雪球",
  meiqiu: "煤球",
  huasheng: "花生",
  zhima: "芝麻",
  imdpepe: "imdpepe",
};

function rpcUrl(env: Env): string {
  return env.SEPOLIA_RPC_URL?.trim() || DEFAULT_SEPOLIA_RPC;
}

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

async function ethCall(env: Env, to: string, data: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(rpcUrl(env), {
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

async function chainSpeciesLevel(env: Env, address: string, species: number): Promise<number | null> {
  const data = selector("speciesLevel(address,uint8)") + encAddress(address) + encUint(species);
  const out = await ethCall(env, HAMSTER_NFT, data);
  if (!out) return null;
  return Number(wordAt(out, 0));
}

async function chainMintNonce(env: Env, address: string): Promise<bigint | null> {
  const data = selector("mintNonce(address)") + encAddress(address);
  const out = await ethCall(env, HAMSTER_NFT, data);
  if (!out) return null;
  return wordAt(out, 0);
}

async function chainServerSigner(env: Env): Promise<string | null> {
  const out = await ethCall(env, HAMSTER_NFT, selector("serverSigner()"));
  if (!out || out.length < 66) return null;
  return "0x" + out.slice(2 + 24, 2 + 64).toLowerCase();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ethRpc(env: Env, method: string, params: unknown[]): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(rpcUrl(env), {
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

/* ------------------------------ player helpers ------------------------------ */

type PlayerRow = typeof schema.players.$inferSelect;

async function playerByToken(db: Db, token: string): Promise<PlayerRow | null> {
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

async function effectiveLevel(env: Env, db: Db, player: PlayerRow, characterId: string): Promise<number> {
  // Guest mode (isPreview): only the base hamster at Lv1, ever.
  if (player.isPreview === 1) return 1;
  if (ADDRESS_RE.test(player.address)) {
    const species = SPECIES_OF[characterId];
    if (species) {
      const chainLevel = await chainSpeciesLevel(env, player.address, species);
      if (chainLevel !== null && chainLevel > 0) {
        return Math.min(5, chainLevel);
      }
    }
  }
  return levelFor(db, player.id, characterId);
}

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

async function isUnlocked(env: Env, db: Db, player: PlayerRow, characterId: string): Promise<boolean> {
  // Guest mode (isPreview, formerly the test entry): ONLY the base
  // hamster 栗子 is playable; every other character stays locked for
  // guests regardless of any older test-entry registrations.
  if (player.isPreview === 1) return characterId === "lizi";
  if (characterId === IMDPEPE_ID) return hasUnlockMint(db, player.id, IMDPEPE_ID);
  if (characterId === "lizi") return true;
  if (player.isPreview !== 1 && ADDRESS_RE.test(player.address)) {
    const species = SPECIES_OF[characterId];
    if (species) {
      const chainLevel = await chainSpeciesLevel(env, player.address, species);
      if (chainLevel !== null && chainLevel > 0) return true;
    }
  }
  return hasUnlockMint(db, player.id, characterId);
}

interface ProgressionHamster {
  characterId: string;
  level: number;
  ownM: number;
  unlocked: boolean;
  state: "base" | "unlocked" | "eligible" | "pending" | "locked";
  unlockThresholdM: number;
  levelUpReady: boolean;
  levelUpProgress: number;
  levelUpThresholdM: number | null;
  pendingMint: boolean;
}

async function progressionFor(env: Env, db: Db, player: PlayerRow) {
  const { totalMeters, perCharMeters } = await mileageFor(db, player.id);
  const totalM = totalMeters;
  const pending = await db
    .select()
    .from(schema.mintRequests)
    .where(eq(schema.mintRequests.playerId, player.id));
  const hamsters: ProgressionHamster[] = [];
  for (const characterId of UNLOCK_ORDER) {
    // Effective level (chain holding wins) — the framework table level
    // is never advanced by an on-chain mint, so keying thresholds off
    // it pinned every wallet player at the Lv1→Lv2 gate (1000 m).
    const level = await effectiveLevel(env, db, player, characterId);
    const ownM = perCharMeters[characterId] ?? 0;
    const thresholdM = UNLOCK_TOTAL_M[characterId] ?? 0;
    const unlocked = await isUnlocked(env, db, player, characterId);
    const hasPending = pending.some((p) => p.characterId === characterId);
    const state: ProgressionHamster["state"] = unlocked
      ? characterId === "lizi"
        ? "base"
        : "unlocked"
      : hasPending
        ? "pending"
        : totalM >= thresholdM
          ? "eligible"
          : "locked";
    const nextThreshold = LEVEL_UP_M[level] ?? null;
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
  const isGuest = player.isPreview === 1;
  const discovered = !isGuest && (await hasDiscoveredImdpepe(db, player.id));
  {
    const characterId = IMDPEPE_ID;
    const level = await levelFor(db, player.id, characterId);
    const ownM = perCharMeters[characterId] ?? 0;
    const thresholdM = IMDPEPE_UNLOCK_TOTAL_M;
    const unlocked = !isGuest && (await hasUnlockMint(db, player.id, IMDPEPE_ID));
    const hasPending = pending.some((p) => p.characterId === characterId);
    const state: ProgressionHamster["state"] = unlocked
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

async function checkMintEligibility(
  env: Env,
  db: Db,
  player: PlayerRow,
  characterId: string,
  kind: "unlock" | "levelup",
): Promise<{ targetLevel: number }> {
  if (player.isPreview === 1) throw new Error("游客模式不能 Mint，连接钱包后可用");
  const { hamsters, totalM } = await progressionFor(env, db, player);
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

/* --------------------- mint signer (Worker secret) --------------------- */

function encAddressWord(address: string): Uint8Array {
  const clean = address.toLowerCase().replace("0x", "").padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function encUintWord(v: number): Uint8Array {
  const hex = v.toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Same digest the HamsterNFT v2 contract verifies and the hosted
 *  privileged signer produces:
 *  toEthSignedMessageHash(keccak256(abi.encode(player, species,
 *  deadline, nonce))). The key comes ONLY from the Worker secret. */
function signMintAuthorization(
  env: Env,
  args: { player: string; species: number; deadline: number; nonce: number },
): { signature: string; signer: string } {
  const privateKey = env.MINT_SIGNER_PRIVATE_KEY?.trim();
  if (!privateKey) throw new Error("签名服务暂时不可用，请稍后再试");
  const encoded = new Uint8Array(128);
  encoded.set(encAddressWord(args.player), 0);
  encoded.set(encUintWord(args.species), 32);
  encoded.set(encUintWord(args.deadline), 64);
  encoded.set(encUintWord(args.nonce), 96);
  const inner = keccak256(encoded);
  const prefix = new TextEncoder().encode("\x19Ethereum Signed Message:\n32");
  const digest = keccak256(new Uint8Array([...prefix, ...inner]));
  const signature = signDigest(digest, privateKey);
  if (!signature) throw new Error("签名服务暂时不可用，请稍后再试");
  const recovered = recoverDigestSign(digest, signature);
  if (!recovered) throw new Error("签名服务暂时不可用，请稍后再试");
  return { signature, signer: recovered.toLowerCase() };
}


/* --------------------------------- actions --------------------------------- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;
type Handler = (env: Env, db: Db, args: Args) => Promise<unknown>;

function requireToken(args: Args): string {
  if (typeof args.token !== "string" || !args.token) throw new Error("登录已失效，请重新进入");
  return args.token;
}

async function requirePlayer(db: Db, args: Args): Promise<PlayerRow> {
  const player = await playerByToken(db, requireToken(args));
  if (!player) throw new Error("登录已失效，请重新进入");
  return player;
}

function requireCharId(args: Args): CharId {
  if (!CHAR_IDS.includes(args.characterId as CharId)) throw new Error("仓鼠不存在");
  return args.characterId as CharId;
}

function requireMintKind(args: Args): "unlock" | "levelup" {
  if (args.kind !== "unlock" && args.kind !== "levelup") throw new Error("参数不正确");
  return args.kind;
}

function playerShape(player: PlayerRow) {
  return {
    id: player.id,
    address: player.address,
    name: player.name,
    isPreview: player.isPreview === 1,
  };
}


/* ------------------- boards + daily champion settlement -------------------
 * Port of the hosted server logic (server/src/actions.ts). Differences:
 * the champion proof transaction is signed with the Worker secret
 * MINT_SIGNER_PRIVATE_KEY (the deployer wallet — ScoreLedger owner and
 * reporter), and settlement runs from the Worker's Cron Trigger at
 * 00:00 UTC (see wrangler.toml [triggers]); getYesterdayChampion also
 * settles lazily as a fallback. Same honesty rules: a day is submitted
 * at most once, an existing on-chain record is adopted never rewritten,
 * and failed/pending rows never claim an on-chain proof. */

const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";
const SEPOLIA_CHAIN_ID = 11155111;

async function boardEntries(
  db: Db,
  opts: { start?: Date; end?: Date; limit: number },
) {
  // Boards never include admin-removed players (players.banned = 1).
  const conds = [eq(schema.runs.isPreview, 0), eq(schema.players.banned, 0)];
  if (opts.start) conds.push(gte(schema.runs.createdAt, opts.start));
  if (opts.end) conds.push(lt(schema.runs.createdAt, opts.end));
  const where = and(...conds);
  const rows = await db
    .select({
      playerId: schema.runs.playerId,
      best: sql<number>`MAX(${schema.runs.score})`,
    })
    .from(schema.runs)
    .innerJoin(schema.players, eq(schema.runs.playerId, schema.players.id))
    .where(where)
    .groupBy(schema.runs.playerId)
    .orderBy(desc(sql`MAX(${schema.runs.score})`))
    .limit(opts.limit);
  const entries = [];
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
    .innerJoin(schema.players, eq(schema.runs.playerId, schema.players.id))
    .where(where);
  return { entries, totalPlayers: countRows[0]?.n ?? 0 };
}

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

async function chainChampion(env: Env, dayNum: number) {
  const out = await ethCall(env, SCORE_LEDGER, selector("getChampion(uint32)") + encUint(dayNum));
  if (!out || out.length < 2 + 64 * 6) return null;
  const player = "0x" + out.slice(2 + 24, 2 + 64).toLowerCase();
  if (player === "0x0000000000000000000000000000000000000000") return null;
  return {
    player,
    score: Number(wordAt(out, 1)),
    distance: Number(wordAt(out, 2)),
    hamsterSpecies: Number(wordAt(out, 3)),
    squeekBlock: Number(wordAt(out, 4)),
    payloadHash: "0x" + out.slice(2 + 64 * 5, 2 + 64 * 6).toLowerCase(),
  };
}

/* ------------------------- raw tx plumbing (RLP) ------------------------ */

function uintWord(v: number | bigint): Uint8Array {
  const hex = v.toString(16).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bigintBytes(v: bigint): Uint8Array {
  if (v === 0n) return new Uint8Array(0);
  let hex = v.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return hexToBytes("0x" + hex);
}

function rlpBytes(b: Uint8Array): Uint8Array {
  if (b.length === 1 && b[0]! < 0x80) return b;
  if (b.length <= 55) return new Uint8Array([0x80 + b.length, ...b]);
  const len = bigintBytes(BigInt(b.length));
  return new Uint8Array([0xb7 + len.length, ...len, ...b]);
}

function rlpList(items: Uint8Array[]): Uint8Array {
  const parts = items.map(rlpBytes);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const payload = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    payload.set(p, off);
    off += p.length;
  }
  if (total <= 55) return new Uint8Array([0xc0 + total, ...payload]);
  const len = bigintBytes(BigInt(total));
  return new Uint8Array([0xf7 + len.length, ...len, ...payload]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpcStrict(env: Env, method: string, params: unknown[]): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(rpcUrl(env), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    if (json?.error) throw new Error(`RPC ${method}: ${json.error.message ?? "error"}`);
    return json?.result;
  } finally {
    clearTimeout(timer);
  }
}

function signerAddress(privateKey: string): string | null {
  const digest = keccak256(new TextEncoder().encode("hamster-run:signer-check"));
  const sig = signDigest(digest, privateKey);
  if (!sig) return null;
  return recoverDigestSign(digest, sig);
}

/** Sends ScoreLedger.submitChampion from the deployer wallet (contract
 *  owner + reporter, so an empty signature is accepted). Resolves with
 *  the tx hash only after a successful receipt; throws otherwise. */
async function submitChampionTx(
  env: Env,
  args: {
    dayId: number;
    player: string;
    score: number;
    distance: number;
    species: number;
    squeekBlock: number;
    payloadHash: string;
  },
): Promise<string> {
  const privateKey = env.MINT_SIGNER_PRIVATE_KEY?.trim();
  if (!privateKey) throw new Error("champion signer key is not configured");
  const from = signerAddress(privateKey);
  if (!from) throw new Error("champion signer key is invalid");

  const payloadHashBytes = hexToBytes(args.payloadHash);
  if (payloadHashBytes.length !== 32) throw new Error("bad payload hash");
  // Champion is a STATIC tuple: encoded inline after dayId (byte-compared
  // against viem + a live eth_call); head is 8 words, bytes offset = 0x100.
  const words: Uint8Array[] = [
    uintWord(args.dayId),
    (() => {
      const clean = args.player.toLowerCase().replace("0x", "").padStart(64, "0");
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      return out;
    })(),
    uintWord(args.score),
    uintWord(args.distance),
    uintWord(args.species),
    uintWord(args.squeekBlock),
    payloadHashBytes,
    uintWord(0x100),
    uintWord(0),
  ];
  const data = new Uint8Array(4 + words.reduce((n, w) => n + w.length, 0));
  data.set(hexToBytes(selector("submitChampion(uint32,(address,uint64,uint32,uint16,uint64,bytes32),bytes)")), 0);
  let off = 4;
  for (const w of words) {
    data.set(w, off);
    off += w.length;
  }
  const dataHex = "0x" + bytesToHex(data);

  const nonce = BigInt(await rpcStrict(env, "eth_getTransactionCount", [from, "pending"]));
  const gasPriceRaw = BigInt(await rpcStrict(env, "eth_gasPrice", []));
  const gasPrice = (gasPriceRaw * 13n) / 10n + 1n;
  let gasLimit = 250000n;
  try {
    const est = BigInt(await rpcStrict(env, "eth_estimateGas", [{ from, to: SCORE_LEDGER, data: dataHex }]));
    gasLimit = (est * 13n) / 10n + 5000n;
  } catch {
    /* keep the fallback limit */
  }
  const unsigned = rlpList([
    bigintBytes(nonce),
    bigintBytes(gasPrice),
    bigintBytes(gasLimit),
    hexToBytes(SCORE_LEDGER),
    new Uint8Array(0),
    data,
    bigintBytes(BigInt(SEPOLIA_CHAIN_ID)),
    new Uint8Array(0),
    new Uint8Array(0),
  ]);
  const digest = keccak256(unsigned);
  const signature = signDigest(digest, privateKey);
  if (!signature) throw new Error("signing failed");
  const sigBytes = hexToBytes(signature);
  const recId = BigInt(sigBytes[64]! - 27);
  const v = BigInt(SEPOLIA_CHAIN_ID) * 2n + 35n + recId;
  const signedTx = rlpList([
    bigintBytes(nonce),
    bigintBytes(gasPrice),
    bigintBytes(gasLimit),
    hexToBytes(SCORE_LEDGER),
    new Uint8Array(0),
    data,
    bigintBytes(v),
    sigBytes.slice(0, 32),
    sigBytes.slice(32, 64),
  ]);
  const txHash: string = await rpcStrict(env, "eth_sendRawTransaction", ["0x" + bytesToHex(signedTx)]);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const receipt: any = await rpcStrict(env, "eth_getTransactionReceipt", [txHash]).catch(() => null);
    if (receipt) {
      if (receipt.status === "0x1") return txHash;
      throw new Error("champion transaction reverted on chain");
    }
  }
  throw new Error("champion transaction not confirmed in time");
}

/** Settles one UTC day: adopts an existing on-chain record, otherwise
 *  submits the day's #1 formal run once and records the outcome. */
async function settleChampionDay(env: Env, db: Db, dayId: string) {
  const dayNum = Number(dayId);
  const base = {
    dayId,
    dayDisplay: utcDayDisplay(dayId),
    contractUrl: `${SEPOLIA_EXPLORER}/address/${SCORE_LEDGER}`,
  };
  const none = {
    ...base,
    status: "none" as const,
    player: "",
    name: "",
    score: 0,
    distance: 0,
    characterId: "",
    level: 0,
    squeekBlock: null as number | null,
    txHash: null as string | null,
    explorerUrl: null as string | null,
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
      status: "submitted" as const,
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
  const onChain = await chainChampion(env, dayNum);

  if (onChain) {
    const localMatch =
      champ && champ.entry.address.toLowerCase() === onChain.player ? champ : null;
    const speciesId = Object.keys(SPECIES_OF).find(
      (k) => SPECIES_OF[k] === onChain.hamsterSpecies,
    );
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
    return {
      ...base,
      status: "submitted" as const,
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

  const data = {
    ...base,
    status: "pending" as const,
    player: entry.address,
    name: entry.name,
    score: entry.score,
    distance: run.distance,
    characterId: entry.characterId,
    level: entry.level,
    squeekBlock: run.squeekBlock ?? null,
    txHash: null as string | null,
    explorerUrl: null as string | null,
  };
  try {
    const txHash = await submitChampionTx(env, {
      dayId: dayNum,
      player: entry.address.toLowerCase(),
      score: entry.score,
      distance: run.distance,
      species: SPECIES_OF[entry.characterId] ?? 0,
      squeekBlock: run.squeekBlock ?? 0,
      payloadHash,
    });
    await db
      .update(schema.dailyChampions)
      .set({ status: "submitted", txHash, lastError: null, updatedAt: new Date() })
      .where(eq(schema.dailyChampions.dayId, dayId));
    return {
      ...data,
      status: "submitted" as const,
      txHash,
      explorerUrl: `${SEPOLIA_EXPLORER}/tx/${txHash}`,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db
      .update(schema.dailyChampions)
      .set({ status: "failed", lastError: message, updatedAt: new Date() })
      .where(eq(schema.dailyChampions.dayId, dayId));
    return { ...data, status: "failed" as const };
  }
}

function yesterdayUtcDayId(now = new Date()): string {
  return utcDayId(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)),
  );
}

const handlers: Record<string, Handler> = {
  async getWalletConnectConfig(env) {
    const projectId = (env.WALLET_CONNECT_PROJECT_ID ?? WALLET_CONNECT_PROJECT_ID).trim();
    return {
      configured: projectId.length > 0,
      projectId: projectId || null,
      chainId: WALLET_CONNECT_CHAIN_ID,
    };
  },

  async getChallenge(_env, db, args) {
    if (typeof args.address !== "string" || !ADDRESS_RE.test(args.address)) {
      throw new Error("钱包地址不正确");
    }
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

  async verifySignature(_env, db, args) {
    if (typeof args.address !== "string" || !ADDRESS_RE.test(args.address)) {
      throw new Error("钱包地址不正确");
    }
    if (typeof args.signature !== "string" || args.signature.length < 100) {
      throw new Error("签名不正确");
    }
    const name = typeof args.name === "string" ? args.name.trim().slice(0, 16) : "";
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
        .values({ address, name: name || shortName(address), isPreview: 0 })
        .returning();
      player = inserted[0];
    } else if (name && player.isPreview === 0) {
      await db.update(schema.players).set({ name }).where(eq(schema.players.id, player.id));
      player = { ...player, name };
    }
    if (!player) throw new Error("玩家创建失败");
    const token = randomHex(24);
    await db.insert(schema.sessions).values({ token, playerId: player.id });
    return { token, player: playerShape(player) };
  },

  async startPreview(_env, db, args) {
    const name = typeof args.name === "string" ? args.name.trim().slice(0, 16) : "";
    const address = `preview:${randomHex(10)}`;
    const inserted = await db
      .insert(schema.players)
      .values({ address, name: name || "游客", isPreview: 1 })
      .returning();
    const player = inserted[0];
    if (!player) throw new Error("游客创建失败");
    const token = randomHex(24);
    await db.insert(schema.sessions).values({ token, playerId: player.id });
    return { token, player: { ...playerShape(player), isPreview: true } };
  },

  async me(_env, db, args) {
    const player = await playerByToken(db, requireToken(args));
    if (!player) return { player: null };
    return { player: playerShape(player) };
  },

  async getMyHamsters(_env, db, args) {
    const player = await requirePlayer(db, args);
    const hamsters = [];
    for (const characterId of CHAR_IDS) {
      hamsters.push({ characterId, level: await levelFor(db, player.id, characterId) });
    }
    return { hamsters };
  },

  async getProgression(env, db, args) {
    const player = await requirePlayer(db, args);
    const { totalM, hamsters, imdpepeDiscovered } = await progressionFor(env, db, player);
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
    return {
      totalM,
      imdpepeDiscovered,
      mintPriceEth: MINT_PRICE_ETH,
      contractV2Pending: false,
      stats,
      hamsters,
    };
  },

  async requestMint(env, db, args) {
    const player = await requirePlayer(db, args);
    const characterId = requireCharId(args);
    const kind = requireMintKind(args);
    const { targetLevel } = await checkMintEligibility(env, db, player, characterId, kind);
    await recordMintRequest(db, player.id, characterId, kind, targetLevel, null);
    return { recorded: true, status: "pending_payment", priceEth: MINT_PRICE_ETH };
  },

  async getMintAuthorization(env, db, args) {
    const player = await requirePlayer(db, args);
    const characterId = requireCharId(args);
    const kind = requireMintKind(args);
    const { targetLevel } = await checkMintEligibility(env, db, player, characterId, kind);
    const species = SPECIES_OF[characterId];
    if (player.isPreview === 1 || !ADDRESS_RE.test(player.address) || !species) {
      await recordMintRequest(db, player.id, characterId, kind, targetLevel, null);
      return {
        mode: "registered" as const,
        contract: null,
        species: null,
        deadline: null,
        signature: null,
        priceWei: "10000000000000000",
        priceEth: MINT_PRICE_ETH,
      };
    }
    const nonce = await chainMintNonce(env, player.address);
    if (nonce === null) throw new Error("链上暂时读不到，请稍后再试");
    const trustedSigner = await chainServerSigner(env);
    if (!trustedSigner) throw new Error("链上暂时读不到，请稍后再试");
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const signed = signMintAuthorization(env, {
      player: player.address.toLowerCase(),
      species,
      deadline,
      nonce: Number(nonce),
    });
    if (signed.signer.toLowerCase() !== trustedSigner) {
      throw new Error("签名服务暂时不可用，请稍后再试");
    }
    return {
      mode: "onchain" as const,
      contract: HAMSTER_NFT,
      species,
      deadline,
      signature: signed.signature,
      priceWei: "10000000000000000",
      priceEth: MINT_PRICE_ETH,
    };
  },

  async confirmMint(env, db, args) {
    const player = await requirePlayer(db, args);
    const characterId = requireCharId(args);
    const kind = requireMintKind(args);
    if (typeof args.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(args.txHash)) {
      throw new Error("交易哈希不正确");
    }
    const receipt = await ethRpc(env, "eth_getTransactionReceipt", [args.txHash]);
    if (!receipt) return { confirmed: false, status: "pending" };
    if (receipt.status !== "0x1") throw new Error("这笔交易在链上失败了，Mint 没有完成");
    const rawTx = await ethRpc(env, "eth_getTransactionByHash", [args.txHash]);
    if (!rawTx) return { confirmed: false, status: "pending" };
    let valueWei = 0n;
    try {
      valueWei = BigInt(String(rawTx.value ?? "0x0"));
    } catch {
      valueWei = 0n;
    }
    if (
      String(rawTx.from ?? "").toLowerCase() !== player.address.toLowerCase() ||
      String(rawTx.to ?? "").toLowerCase() !== HAMSTER_NFT.toLowerCase() ||
      valueWei !== 10000000000000000n
    ) {
      throw new Error("这笔交易和本次 Mint 对不上，没有登记");
    }
    const { hamsters } = await progressionFor(env, db, player);
    const prog = hamsters.find((h) => h.characterId === characterId);
    if (!prog) throw new Error("仓鼠不存在");
    let targetLevel: number;
    if (kind === "unlock") {
      targetLevel = 1;
    } else {
      const species = SPECIES_OF[characterId];
      const chainLevel =
        species && ADDRESS_RE.test(player.address)
          ? await chainSpeciesLevel(env, player.address, species)
          : null;
      targetLevel =
        chainLevel !== null && chainLevel > 0
          ? Math.min(5, chainLevel)
          : Math.min(5, prog.level + 1);
    }
    await recordMintRequest(db, player.id, characterId, kind, targetLevel, args.txHash);
    return { confirmed: true, status: "recorded" };
  },

  async getChainHamsters(env, db, args) {
    const player = await requirePlayer(db, args);
    const empty = { available: false, mintOpen: false, balance: 0, hamsters: [] as { characterId: string; species: number; chainLevel: number }[] };
    if (player.isPreview === 1 || !ADDRESS_RE.test(player.address)) return empty;
    const balOut = await ethCall(
      env,
      HAMSTER_NFT,
      selector("balanceOf(address)") + encAddress(player.address),
    );
    if (!balOut) return empty;
    const openOut = await ethCall(env, HAMSTER_NFT, selector("mintOpen()"));
    const hamsters = [];
    for (const characterId of CHAR_IDS) {
      const species = SPECIES_OF[characterId];
      if (!species) continue;
      const chainLevel = (await chainSpeciesLevel(env, player.address, species)) ?? 0;
      hamsters.push({ characterId, species, chainLevel });
    }
    return {
      available: true,
      mintOpen: openOut ? wordAt(openOut, 0) === 1n : false,
      balance: Number(wordAt(balOut, 0)),
      hamsters,
    };
  },

  async getChampion(env) {
    const now = new Date();
    const dayId =
      now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
    const empty = {
      available: false,
      hasChampion: false,
      dayId,
      player: "",
      score: 0,
      distance: 0,
      hamsterSpecies: 0,
      squeekBlock: 0,
    };
    const out = await ethCall(env, SCORE_LEDGER, selector("getChampion(uint32)") + encUint(dayId));
    if (!out || out.length < 2 + 64 * 6) return empty;
    const playerWord = out.slice(2 + 24, 2 + 64);
    const player = "0x" + playerWord.toLowerCase();
    const hasChampion = player !== "0x0000000000000000000000000000000000000000";
    return {
      available: true,
      hasChampion,
      dayId,
      player: hasChampion ? player : "",
      score: Number(wordAt(out, 1)),
      distance: Number(wordAt(out, 2)),
      hamsterSpecies: Number(wordAt(out, 3)),
      squeekBlock: Number(wordAt(out, 4)),
    };
  },

  async dailyBoard(_env, db) {
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const end = new Date(start.getTime() + 86400000);
    const { entries, totalPlayers } = await boardEntries(db, { start, end, limit: 3 });
    return { dayId: utcDayDisplay(utcDayId(now)), entries, totalPlayers };
  },

  async getYesterdayChampion(env, db) {
    return settleChampionDay(env, db, yesterdayUtcDayId());
  },

  async getDailyTrack(_env, db) {
    const track = await ensureDailyTrack(db);
    return { dayId: track.dayId, blockHeight: track.blockHeight, source: track.source };
  },

  async getRelay(_env, db) {
    const stats = await squeekJson("/measurement/stats?range=7d");
    const rows = await db.select().from(schema.relayState).limit(1);
    let state = rows[0];
    const currentMm = stats?.lifetime?.observedDistanceMm
      ? parseInt(String(stats.lifetime.observedDistanceMm), 10)
      : NaN;
    if (Number.isFinite(currentMm)) {
      if (!state) {
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

  async getGhost() {
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

  async discoverImdpepe(_env, db, args) {
    const player = await requirePlayer(db, args);
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
    return { discovered: true, already: false };
  },

  async startRun(env, db, args) {
    const player = await requirePlayer(db, args);
    const characterId = requireCharId(args);
    if (!(await isUnlocked(env, db, player, characterId))) {
      throw new Error("这只仓鼠还没解锁，先用已解锁的仓鼠累计里程吧");
    }
    const track = await ensureDailyTrack(db);
    const level = await effectiveLevel(env, db, player, characterId);
    // One-time run token: submitRun must present it; it binds the
    // submission to this player, this character and today's seed.
    const now = Date.now();
    const runToken = randomHex(24);
    await db.insert(schema.runTokens).values({
      token: runToken,
      playerId: player.id,
      characterId,
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

  async submitRun(env, db, args) {
    const player = await requirePlayer(db, args);
    const characterId = requireCharId(args);
    const seed = typeof args.seed === "number" && Number.isInteger(args.seed) && args.seed >= 0 ? args.seed : -1;
    if (seed < 0) throw new Error("参数不正确");
    const rawInputs: unknown[] = Array.isArray(args.inputs) ? args.inputs : [];
    if (rawInputs.length > 20000) throw new Error("参数不正确");
    const inputs: InputEvent[] = [];
    for (const raw of rawInputs) {
      const ev = raw as { tick?: unknown; action?: unknown };
      if (
        typeof ev.tick !== "number" ||
        (ev.action !== "left" && ev.action !== "right" && ev.action !== "jump" && ev.action !== "slide")
      ) {
        throw new Error("参数不正确");
      }
      inputs.push({ tick: ev.tick, action: ev.action });
    }
    // --- one-time run token gate -------------------------------------
    // The token (issued by startRun) is the only trusted source of the
    // seed; any attempt that passes token validation consumes it, so a
    // payload can never be replayed and mileage cannot be farmed by
    // resubmitting the same run.
    const rejectRun = async (reason: string) => ({
      accepted: false,
      reason,
      score: 0,
      distance: 0,
      seeds: 0,
      rank: null,
      bestScore: 0,
      level: await levelFor(db, player.id, characterId),
      squeekBlock: null,
    });
    const runTokenArg = typeof args.runToken === "string" ? args.runToken : "";
    if (!runTokenArg) return rejectRun("run_token_required");
    const tokenRows = await db
      .select()
      .from(schema.runTokens)
      .where(eq(schema.runTokens.token, runTokenArg));
    const tokenRow = tokenRows[0];
    if (!tokenRow) return rejectRun("invalid_run_token");
    if (tokenRow.playerId !== player.id || tokenRow.characterId !== characterId) {
      return rejectRun("invalid_run_token");
    }
    if (tokenRow.usedAt !== null && tokenRow.usedAt !== undefined) {
      return rejectRun("run_token_used");
    }
    if (Date.now() > tokenRow.expiresAt) return rejectRun("run_token_expired");
    // Validation passed: consume the token now. Later rejections (seed
    // mismatch, invalid inputs, too-early submit) do NOT un-consume it.
    await db
      .update(schema.runTokens)
      .set({ usedAt: Date.now() })
      .where(eq(schema.runTokens.id, tokenRow.id));
    if (seed !== tokenRow.seed) return rejectRun("seed_mismatch");
    if (!(await isUnlocked(env, db, player, characterId))) {
      const level = await levelFor(db, player.id, characterId);
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
    const level = await effectiveLevel(env, db, player, characterId);
    const result = simulateRun(tokenRow.seed, characterId, inputs, level);
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
    // Minimum real duration: the run must have actually been played.
    // Sim ticks run at 60/s; allow a 10% clock/rounding margin.
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
      characterId,
      score: result.score,
      distance: result.distance,
      seeds: result.seeds,
      ticks: result.ticks,
      isPreview: isPreview ? 1 : 0,
      level,
      squeekBlock: squeekBlock || null,
    });
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
        .innerJoin(schema.players, eq(schema.runs.playerId, schema.players.id))
        .where(and(eq(schema.runs.isPreview, 0), eq(schema.players.banned, 0)))
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

  async leaderboard(_env, db, args) {
    const limit =
      typeof args.limit === "number" && Number.isInteger(args.limit)
        ? Math.min(30, Math.max(1, args.limit))
        : 30;
    return boardEntries(db, { limit });
  },
};

/* ------------------------------ admin backend ------------------------------
 * Project management console endpoints: POST /api/admin/<name> with the
 * header x-admin-key equal to the ADMIN_KEY Worker secret (401 without
 * it). The only consumer is the static admin page (hamster-admin Pages
 * project); nothing here is reachable from the game client.
 *
 * IP gate: login-class actions (startPreview / getChallenge /
 * verifySignature), startRun and submitRun check CF-Connecting-IP
 * against ip_bans (403 {error:"ip_banned"}) and record the caller's IP
 * on their player row (players.last_ip). */

const GATED_ACTIONS = new Set([
  "startPreview",
  "getChallenge",
  "verifySignature",
  "startRun",
  "submitRun",
]);

async function recordLastIp(
  env: Env,
  db: Db,
  action: string,
  args: Args,
  result: unknown,
  ip: string,
): Promise<void> {
  let playerId: number | null = null;
  if (action === "startPreview") {
    const t = (result as Args | null)?.token;
    if (typeof t === "string") playerId = (await playerByToken(db, t))?.id ?? null;
  } else if (action === "verifySignature" || action === "getChallenge") {
    if (typeof args.address === "string" && ADDRESS_RE.test(args.address)) {
      const rows = await db
        .select({ id: schema.players.id })
        .from(schema.players)
        .where(eq(schema.players.address, args.address.toLowerCase()))
        .limit(1);
      playerId = rows[0]?.id ?? null;
    }
  } else if (typeof args.token === "string") {
    playerId = (await playerByToken(db, args.token))?.id ?? null;
  }
  if (playerId !== null) {
    await env.DB.prepare("UPDATE players SET last_ip = ? WHERE id = ?")
      .bind(ip, playerId)
      .run();
  }
}

function formatEthFromWei(wei: bigint): string {
  const whole = wei / 1000000000000000000n;
  const frac = (wei % 1000000000000000000n)
    .toString()
    .padStart(18, "0")
    .slice(0, 6);
  return `${whole.toString()}.${frac}`;
}

const DEPLOYER_FALLBACK = "0xD71bab0dcA1799d63CCa4E6a70A38eF0a8e56662";

async function handleAdmin(
  env: Env,
  request: Request,
  db: Db,
  name: string,
  args: Args,
): Promise<Response> {
  if (!env.ADMIN_KEY || (request.headers.get("x-admin-key") ?? "") !== env.ADMIN_KEY) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  try {
    switch (name) {
      case "stats": {
        const now = new Date();
        const todayStart = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
        const pAgg = await db
          .select({
            total: sql<number>`COUNT(*)`,
            wallets: sql<number>`COALESCE(SUM(CASE WHEN ${schema.players.address} LIKE '0x%' THEN 1 ELSE 0 END), 0)`,
          })
          .from(schema.players);
        const playersTotal = pAgg[0]?.total ?? 0;
        const walletPlayers = pAgg[0]?.wallets ?? 0;
        const rAgg = await db
          .select({ total: sql<number>`COUNT(*)` })
          .from(schema.runs);
        const tAgg = await db
          .select({
            n: sql<number>`COUNT(*)`,
            active: sql<number>`COUNT(DISTINCT ${schema.runs.playerId})`,
          })
          .from(schema.runs)
          .where(gte(schema.runs.createdAt, todayStart));
        return jsonResponse({
          playersTotal,
          walletPlayers,
          guestPlayers: playersTotal - walletPlayers,
          runsTotal: rAgg[0]?.total ?? 0,
          runsTodayUtc: tAgg[0]?.n ?? 0,
          activeTodayUtc: tAgg[0]?.active ?? 0,
          generatedAtUtc: now.toISOString(),
        });
      }

      case "health": {
        let d1 = "ok";
        try {
          await env.DB.prepare("SELECT 1 AS one").first();
        } catch {
          d1 = "fail";
        }
        const status = await squeekJson("/status");
        const block =
          parseInt(String(status?.builder?.anchor?.blockHeight ?? "0"), 10) || 0;
        const champ = await db
          .select()
          .from(schema.dailyChampions)
          .orderBy(desc(schema.dailyChampions.dayId))
          .limit(1);
        const c = champ[0];
        return jsonResponse({
          api: "ok",
          d1,
          squeekchain: { ok: !!status && block > 0, latestBlock: block },
          champion: c
            ? {
                lastSettledDay: utcDayDisplay(c.dayId),
                status: c.status,
                lastTx: c.txHash,
              }
            : { lastSettledDay: null, status: null, lastTx: null },
          serverTimeUtc: new Date().toISOString(),
        });
      }

      case "nft": {
        const deployer =
          (env.MINT_SIGNER_PRIVATE_KEY
            ? signerAddress(env.MINT_SIGNER_PRIVATE_KEY)
            : null) ?? DEPLOYER_FALLBACK;
        const balRaw = await ethRpc(env, "eth_getBalance", [deployer, "latest"]);
        let deployerBalanceEth: string | null = null;
        if (typeof balRaw === "string") {
          try {
            deployerBalanceEth = formatEthFromWei(BigInt(balRaw));
          } catch {
            deployerBalanceEth = null;
          }
        }
        const openOut = await ethCall(env, HAMSTER_NFT, selector("mintOpen()"));
        const mintOpen = openOut ? wordAt(openOut, 0) === 1n : null;
        // "Confirmed" mint = the request row carries a tx_hash, which is
        // only ever written after confirmMint verified the on-chain
        // receipt. The status column stays 'pending_payment' forever and
        // is NOT a confirmation signal.
        const confRows = await db
          .select({
            characterId: schema.mintRequests.characterId,
            targetLevel: schema.mintRequests.targetLevel,
            n: sql<number>`COUNT(*)`,
          })
          .from(schema.mintRequests)
          .where(sql`${schema.mintRequests.txHash} IS NOT NULL`)
          .groupBy(schema.mintRequests.characterId, schema.mintRequests.targetLevel)
          .orderBy(schema.mintRequests.characterId, schema.mintRequests.targetLevel);
        const pendAgg = await db
          .select({ n: sql<number>`COUNT(*)` })
          .from(schema.mintRequests)
          .where(sql`${schema.mintRequests.txHash} IS NULL`);
        return jsonResponse({
          deployer,
          deployerBalanceEth,
          contract: HAMSTER_NFT,
          mintOpen,
          mints: {
            confirmed: confRows.map((r) => ({
              characterId: r.characterId,
              species: SPECIES_OF[r.characterId] ?? null,
              targetLevel: r.targetLevel,
              count: r.n,
            })),
            confirmedTotal: confRows.reduce((a, r) => a + r.n, 0),
            pendingTotal: pendAgg[0]?.n ?? 0,
            note: "已确认 = mint_requests 中 tx_hash 已回填（confirmMint 链上核验通过）；status 字段恒为 pending_payment，不作判据",
          },
        });
      }

      case "players": {
        const q =
          typeof args.query === "string" ? args.query.trim().slice(0, 64) : "";
        const base = db
          .select({
            id: schema.players.id,
            name: schema.players.name,
            address: schema.players.address,
            isPreview: schema.players.isPreview,
            lastIp: schema.players.lastIp,
            banned: schema.players.banned,
            runs: sql<number>`COUNT(${schema.runs.id})`,
            bestScore: sql<number>`COALESCE(MAX(${schema.runs.score}), 0)`,
          })
          .from(schema.players)
          .leftJoin(schema.runs, eq(schema.runs.playerId, schema.players.id));
        const rows = await (q
          ? base.where(
              or(
                like(schema.players.name, `%${q}%`),
                like(schema.players.address, `%${q}%`),
              ),
            )
          : base
        )
          .groupBy(schema.players.id)
          .orderBy(desc(sql`COALESCE(MAX(${schema.runs.score}), 0)`))
          .limit(50);
        return jsonResponse({
          players: rows.map((r) => ({
            id: r.id,
            name: r.name,
            wallet: r.isPreview === 1 ? null : r.address,
            address: r.address,
            isGuest: r.isPreview === 1,
            lastIp: r.lastIp,
            runs: r.runs,
            bestScore: r.bestScore,
            banned: r.banned === 1,
          })),
        });
      }

      case "recentPlayers": {
        // Newest joins first. players.created_at is a real epoch-ms
        // column (migration 0001; verified live via PRAGMA), so this is
        // true join-time order; id DESC only breaks same-ms ties (id is
        // AUTOINCREMENT, i.e. join sequence).
        const limit =
          typeof args.limit === "number" && Number.isInteger(args.limit)
            ? Math.min(50, Math.max(1, args.limit))
            : 20;
        const rows = await db
          .select({
            id: schema.players.id,
            name: schema.players.name,
            address: schema.players.address,
            isPreview: schema.players.isPreview,
            createdAt: schema.players.createdAt,
            lastIp: schema.players.lastIp,
            banned: schema.players.banned,
            runs: sql<number>`COUNT(${schema.runs.id})`,
            bestScore: sql<number>`COALESCE(MAX(${schema.runs.score}), 0)`,
          })
          .from(schema.players)
          .leftJoin(schema.runs, eq(schema.runs.playerId, schema.players.id))
          .groupBy(schema.players.id)
          .orderBy(desc(schema.players.createdAt), desc(schema.players.id))
          .limit(limit);
        return jsonResponse({
          players: rows.map((r) => ({
            id: r.id,
            name: r.name,
            wallet: r.isPreview === 1 ? null : r.address,
            address: r.address,
            isGuest: r.isPreview === 1,
            joinedAt: r.createdAt.toISOString(),
            lastIp: r.lastIp,
            runs: r.runs,
            bestScore: r.bestScore,
            banned: r.banned === 1,
          })),
        });
      }

      case "banIp": {
        const ip = typeof args.ip === "string" ? args.ip.trim() : "";
        if (!ip || ip.length > 45 || !/^[0-9a-fA-F.:]+$/.test(ip)) {
          throw new Error("IP 格式不正确");
        }
        const reason =
          typeof args.reason === "string" ? args.reason.trim().slice(0, 200) : "";
        await db
          .insert(schema.ipBans)
          .values({ ip, reason: reason || null })
          .onConflictDoUpdate({
            target: schema.ipBans.ip,
            set: { reason: reason || null, createdAt: new Date() },
          });
        return jsonResponse({ ok: true, ip });
      }

      case "unbanIp": {
        const ip = typeof args.ip === "string" ? args.ip.trim() : "";
        if (!ip) throw new Error("IP 不能为空");
        await db.delete(schema.ipBans).where(eq(schema.ipBans.ip, ip));
        return jsonResponse({ ok: true, ip });
      }

      case "listBans": {
        const rows = await db
          .select()
          .from(schema.ipBans)
          .orderBy(desc(schema.ipBans.createdAt));
        return jsonResponse({
          bans: rows.map((r) => ({
            ip: r.ip,
            reason: r.reason,
            createdAt: r.createdAt.toISOString(),
          })),
        });
      }

      case "removeFromBoard":
      case "restorePlayer": {
        const pid =
          typeof args.playerId === "number" && Number.isInteger(args.playerId)
            ? args.playerId
            : -1;
        if (pid <= 0) throw new Error("playerId 不正确");
        const banned = name === "removeFromBoard" ? 1 : 0;
        await db
          .update(schema.players)
          .set({ banned })
          .where(eq(schema.players.id, pid));
        return jsonResponse({ ok: true, playerId: pid, banned: banned === 1 });
      }

      default:
        return jsonResponse({ error: `unknown admin action: ${name}` }, 404);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "服务器内部错误";
    return jsonResponse({ error: message }, 400);
  }
}

/* --------------------------------- HTTP entry --------------------------------- */

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, x-admin-key",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === "/api/health" || url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "hamster-run-api" });
    }
    // Routes: POST /api/<action> with the args object as body, or
    // POST /api with {action, args} (the Muse SDK client's shape).
    let actionName = "";
    let adminName = "";
    if (url.pathname.startsWith("/api/")) {
      const parts = decodeURIComponent(url.pathname.slice("/api/".length)).split("/");
      actionName = parts[0] ?? "";
      if (actionName === "admin") adminName = parts[1] ?? "";
    } else if (url.pathname === "/api") {
      actionName = "";
    } else {
      return jsonResponse({ error: "not found" }, 404);
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "method not allowed" }, 405);
    }
    let body: Args = {};
    try {
      body = (await request.json()) as Args;
    } catch {
      return jsonResponse({ error: "请求格式不正确" }, 400);
    }
    let args: Args = body;
    if (!actionName) {
      if (typeof body.action === "string") {
        actionName = body.action;
        args = (body.args as Args) ?? {};
      }
    }
    const db = drizzle(env.DB, { schema });
    if (actionName === "admin") {
      return handleAdmin(env, request, db, adminName, args ?? {});
    }
    const handler = handlers[actionName];
    if (!handler) {
      return jsonResponse({ error: `unknown action: ${actionName}` }, 404);
    }
    // IP gate for login-class actions and run actions.
    const clientIp = request.headers.get("CF-Connecting-IP") ?? "";
    if (clientIp && GATED_ACTIONS.has(actionName)) {
      try {
        const ban = await env.DB.prepare("SELECT ip FROM ip_bans WHERE ip = ?")
          .bind(clientIp)
          .first();
        if (ban) return jsonResponse({ error: "ip_banned" }, 403);
      } catch {
        // If the ban table is somehow unavailable, never block gameplay.
      }
    }
    try {
      const result = await handler(env, db, args ?? {});
      if (clientIp && GATED_ACTIONS.has(actionName)) {
        try {
          await recordLastIp(env, db, actionName, args ?? {}, result, clientIp);
        } catch {
          // last_ip bookkeeping is best-effort only.
        }
      }
      return jsonResponse(result ?? {});
    } catch (e) {
      const message = e instanceof Error ? e.message : "服务器内部错误";
      return jsonResponse({ error: message }, 400);
    }
  },

  // Cron Trigger "0 0 * * *" (UTC): settle the previous UTC day's
  // champion into ScoreLedger. Idempotent — settleChampionDay adopts an
  // existing on-chain record and never writes a day twice.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = drizzle(env.DB, { schema });
    ctx.waitUntil(
      settleChampionDay(env, db, yesterdayUtcDayId()).catch((e) => {
        console.error("champion settlement failed", e);
      }),
    );
  },
};
