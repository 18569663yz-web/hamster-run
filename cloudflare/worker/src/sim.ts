// Deterministic runner simulation — framework edition (方案 v0.2).
// The exact same code runs in the browser (rendering) and on the server
// (score recomputation). The client never reports a score, only inputs.
//
// Implemented from 实现方案 v0.2:
// - §1.1 speed curve (原创): v(t) = 10 + 10.5 * min(t/120, 1) 身高/秒
// - §1.3 track: 40+ hand-authored 12-unit template segments chained with
//   an adjacency reachability check (D_react), safe-segment fallback
// - §1.4 difficulty tiers by time (density + double-obstacle share)
// - §1.5 scoring: floor((floor(8*distance) + seeds*2 + bonus) * mult),
//   mult = 1 + roleMul * 0.01, roleMul from character level (§2.3)
// - §2.2/§2.3 five hamsters' skills with Lv1–Lv5 tables
// Distances are in hamster heights (仓鼠身高 = 1 unit).

export type ActionType = "left" | "right" | "jump" | "slide";

export interface InputEvent {
  tick: number;
  action: ActionType;
}

export type ObKind = "hurdle" | "beam" | "crate" | "puddle" | "mover";
export type PowerKind = "shield" | "magnet" | "flight" | "boost" | "double" | "sneak";

/** Timed power-up durations in ticks (60/s). §1.6: 加速板 3s, 分数倍率 6s;
 *  magnet is per-character (芝麻 longer, see ZHIMA_MAGNET_SEC). */
export const POWER_DURATIONS: Record<PowerKind, number> = {
  shield: 0,
  magnet: 60 * 8,
  flight: 60 * 6,
  boost: 60 * 3,
  double: 60 * 6,
  sneak: 60 * 10,
};

export const POWER_NAMES: Record<PowerKind, string> = {
  shield: "护盾",
  magnet: "磁铁",
  flight: "飞行器",
  boost: "加速板",
  double: "双倍积分",
  sneak: "弹力鞋",
};

export interface Obstacle {
  id: number;
  dist: number;
  lane: number;
  kind: ObKind;
  passed: boolean;
  /** live lateral position for movers (patrols inside its lane) */
  curLane: number;
  phase: number;
}

export interface SeedItem {
  id: number;
  dist: number;
  lane: number;
  air: boolean;
  taken: boolean;
  pull: number;
}

export interface PowerItem {
  id: number;
  dist: number;
  lane: number;
  kind: PowerKind;
  taken: boolean;
}

/* ------------------------- §2.2 / §2.3 level tables ------------------------- */

export const CHAR_IDS = ["lizi", "xueqiu", "meiqiu", "huasheng", "zhima", "imdpepe"] as const;
export type CharId = (typeof CHAR_IDS)[number];

/** roleMul by level (§1.5/§2.3): Lv1=0 … Lv5=20 */
export const ROLE_MUL = [0, 0, 5, 10, 15, 20];
const LIZI_BOOST_SEC = [3.0, 3.3, 3.6, 4.0, 4.5];
const LIZI_BOOST_MUL = [1.4, 1.44, 1.48, 1.54, 1.6];
const XUEQIU_SHIELD_MAX = [2, 2, 3, 3, 4];
const XUEQIU_RECHARGE_SEC = [28, 25, 22, 19, 16];
const MEIQIU_SLIDE_SEC = [0.78, 0.84, 0.9, 0.97, 1.05];
const HUASHENG_SPAWN_MUL = [1.25, 1.3, 1.35, 1.42, 1.5];
const ZHIMA_MAGNET_SEC = [12, 13, 14.5, 16, 18];
/** 磁铁吸附半径: base 0.75 身高; 芝麻 Lv1 1.50 → range ×2, Lv3 2.25 → ×3, Lv5 3.00 → ×4 */
const ZHIMA_MAGNET_RANGE_MUL = [2, 2, 3, 3, 4];
/** imdpepe「impepe」: seed charge threshold Lv1 40 → Lv5 28 (−3 per level) */
const IMDPEPE_THRESHOLD = [40, 37, 34, 31, 28];
/** imdpepe「impepe」: state duration Lv1 5s → Lv5 8s (+0.75s per level) */
const IMDPEPE_DURATION_SEC = [5, 5.75, 6.5, 7.25, 8];

export interface CharParams {
  airTicks: number;
  slideTicks: number;
  roleMul: number;
  spawnMul: number;
  shieldMax: number;
  shieldRechargeTicks: number;
  magnetTicks: number;
  magnetRange: number;
  skillBoostTicks: number;
  skillBoostMul: number;
  /** imdpepe only: seeds needed to trigger impepe (0 for other characters) */
  impepeThreshold: number;
  /** imdpepe only: impepe state duration in ticks (0 for other characters) */
  impepeDurationTicks: number;
}

export function charParams(characterId: string, level: number): CharParams {
  const lv = Math.min(5, Math.max(1, Math.floor(level) || 1));
  const i = lv - 1;
  const base: CharParams = {
    airTicks: 44,
    slideTicks: 36, // §1.2 滑铲上限 0.6s
    roleMul: ROLE_MUL[lv] ?? 0,
    spawnMul: 1,
    shieldMax: 1,
    shieldRechargeTicks: 0,
    magnetTicks: POWER_DURATIONS.magnet,
    magnetRange: 8,
    skillBoostTicks: 0,
    skillBoostMul: 1,
    impepeThreshold: 0,
    impepeDurationTicks: 0,
  };
  switch (characterId) {
    case "lizi":
      return {
        ...base,
        skillBoostTicks: Math.round(LIZI_BOOST_SEC[i]! * 60),
        skillBoostMul: LIZI_BOOST_MUL[i]!,
      };
    case "xueqiu":
      return {
        ...base,
        shieldMax: XUEQIU_SHIELD_MAX[i]!,
        shieldRechargeTicks: Math.round(XUEQIU_RECHARGE_SEC[i]! * 60),
      };
    case "meiqiu":
      return { ...base, airTicks: 52, slideTicks: Math.round(MEIQIU_SLIDE_SEC[i]! * 60) };
    case "huasheng":
      return { ...base, spawnMul: HUASHENG_SPAWN_MUL[i]! };
    case "zhima":
      return {
        ...base,
        magnetTicks: Math.round(ZHIMA_MAGNET_SEC[i]! * 60),
        magnetRange: 8 * ZHIMA_MAGNET_RANGE_MUL[i]!,
      };
    case "imdpepe":
      return {
        ...base,
        impepeThreshold: IMDPEPE_THRESHOLD[i]!,
        impepeDurationTicks: Math.round(IMDPEPE_DURATION_SEC[i]! * 60),
      };
    default:
      return base;
  }
}

export const DEFAULT_CHAR = "lizi";
export const MAX_TICKS = 60 * 300;
export const MAGNET_RANGE = 8;
/** Seed pickup lead (heights): a seed is collected the moment it enters
 *  this far in FRONT of the hamster instead of at the body's centre
 *  plane — the trigger zone is bigger than the body, so a grabbed seed
 *  never visually overlaps the model. The rendered body front sits
 *  ≈0.4 heights ahead of the centre plane; 0.55 clears it with margin.
 *  Identical code runs client- and server-side, so recomputation agrees. */
export const SEED_COLLECT_LEAD = 0.55;
/** 3D seed pickup (world units, mirroring the renderer): a seed is
 *  collected the moment its centre comes within the hamster's body
 *  capsule (a vertical capsule of BODY_RADIUS around the body axis,
 *  head included, base at the feet) plus the seed's own radius and a
 *  small margin — i.e. at first contact with the body surface, never
 *  after it has sunk into the model. This single rule covers running,
 *  lane changes, jumps, slides, boosts and magnet homing: any seed
 *  whose path would visually touch the body is eaten at the surface.
 *  Renderer mapping: 1 height = 1.5 world units forward, lane width
 *  2.2 world units, jump lift = jumpHeight × 1.7 world units, ground
 *  seeds ride at y 0.42 and air seeds at y 1.55 (magnet-homed seeds
 *  glide to y 1.05 as their pull rises — mirrored in the check). */
export const WORLD_PER_HEIGHT = 1.5;
export const LANE_WORLD_W = 2.2;
export const BODY_RADIUS = 0.72;
export const BODY_HEIGHT = 2.3;
export const SEED_RADIUS = 0.2;
export const SEED_PICKUP_DIST = BODY_RADIUS + SEED_RADIUS + 0.15;
export const SEG_LEN = 12;

/** Collision geometry, mirroring the renderer's meshes (world units).
 *  The hit test is a VISUAL contact test, evaluated at the interpolated
 *  state (lane + jump height) of the exact moment the obstacle plane
 *  is crossed — never at the tick's end state, so a lane change that
 *  sweeps the body through an obstacle's side registers, and a jump
 *  whose feet are above an obstacle's top clears it.
 *  - OB_TOP_WORLD: the obstacle's top edge. A jump clears the obstacle
 *    iff the feet (jumpHeight × 1.7 world, the renderer's lift) reach
 *    its top; before this, hurdle/mover used a flat jumpHeight ≤ 0.45
 *    gate whose feet (0.77 world) were still inside the hurdle bar
 *    (top 0.99), and crates/beams ignored jump height entirely, so a
 *    sneak-boosted jump (feet 2.47) "crashed" into a beam whose top
 *    (2.24) it had visually cleared.
 *  - the beam is a band [1.72, 2.24]: sliding ducks under it; a jump
 *    clears it only when the feet pass its TOP (sneak apex) — a normal
 *    jump's body still spans the band, so it still hits.
 *  - OB_LATERAL: lateral contact distance in lanes = (obstacle half
 *    width + BODY_RADIUS) / LANE_WORLD_W, per kind.
 *  - CRASH_STOP: on a fatal hit the run stops this many heights BEFORE
 *    the obstacle plane, so the body front (BODY_RADIUS ahead of the
 *    centre plane) plus the obstacle's front face leave a visible gap
 *    (≈0.12 world) — the model never sits embedded in the mesh during
 *    the crash演出. */
export const OB_TOP_WORLD: Record<ObKind, number> = {
  hurdle: 0.99,
  beam: 2.24,
  crate: 1.5,
  puddle: 0,
  mover: 1.24,
};
const OB_LATERAL: Record<ObKind, number> = {
  crate: 0.71,
  hurdle: 0.75,
  beam: 0.75,
  mover: 0.61,
  puddle: 0.55,
};
const CRASH_STOP: Record<ObKind, number> = {
  crate: 0.93,
  hurdle: 0.61,
  beam: 0.66,
  mover: 0.97,
  puddle: 0,
};
/** Power-up pickup volume: the pickup floats at this rendered height
 *  and is collected on body-capsule contact (same capsule as seeds),
 *  so a low jump through the pickup's halo grabs it, while a full
 *  jump clean over it (feet above the halo top) does not. Flight
 *  keeps its wide same-lane grab. */
export const POWER_Y = 1.05;
export const POWER_PICKUP_DIST = BODY_RADIUS + 0.52;

/** §1.1 original speed curve, hamster heights per second. */
export function speedAt(seconds: number): number {
  return 10 + 10.5 * Math.min(seconds / 120, 1);
}

/** §1.3.2 reaction distance: D_react(v) = v * (t_action + t_lane), t_lane = 0.30s */
export function dReact(v: number, tAction: number): number {
  return v * (tAction + 0.3);
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimResult {
  score: number;
  distance: number;
  seeds: number;
  ticks: number;
  crashed: boolean;
}

/* --------------------------- §1.3 segment templates --------------------------- */

type StateKind = "normal" | "air" | "slide";
type EntryState = StateKind | "any";
type Tag = "safe" | "single" | "double" | "gate" | "full" | "special";

interface SegRow {
  off: number;
  kind: ObKind;
  lanes: number[];
}
interface Template {
  id: string;
  tag: Tag;
  entryMask: number;
  entryState: EntryState;
  exitState: StateKind;
  exitRemain: number;
  exitClearance: number;
  solveMask: number;
  rows: SegRow[];
  seedLine: { off: number; lane: number; air: boolean; n: number } | null;
}

const LANES = [-1, 0, 1];
const bit = (lane: number) => 1 << (lane + 1);

function solveMaskFor(rows: SegRow[]): number {
  let mask = 0;
  for (const lane of LANES) {
    let ok = true;
    for (const row of rows) {
      // a crate in your lane cannot be cleared in place (character skills
      // aside — the template guarantee must hold for everyone)
      if (row.lanes.includes(lane) && row.kind === "crate") ok = false;
    }
    if (ok) mask |= bit(lane);
  }
  return mask;
}

function makeTemplate(
  id: string,
  tag: Tag,
  rows: SegRow[],
  seedLine: Template["seedLine"],
  opts?: { entryMask?: number; entryState?: EntryState },
): Template {
  const lastOff = rows.reduce((m, r) => Math.max(m, r.off), 0);
  let exitState: StateKind = "normal";
  let exitRemain = 0;
  // a full-width hurdle/beam late in the segment leaves the player
  // airborne / sliding at the exit
  for (const row of rows) {
    if (row.lanes.length === 3 && row.off >= 7) {
      if (row.kind === "hurdle") {
        exitState = "air";
        exitRemain = 0.4;
      } else if (row.kind === "beam") {
        exitState = "slide";
        exitRemain = 0.3;
      }
    }
  }
  return {
    id,
    tag,
    entryMask: opts?.entryMask ?? 0b111,
    entryState: opts?.entryState ?? "any",
    exitState,
    exitRemain,
    exitClearance: rows.length ? SEG_LEN - (lastOff + 1) : SEG_LEN,
    solveMask: solveMaskFor(rows),
    rows,
    seedLine,
  };
}

function buildTemplates(): Template[] {
  const list: Template[] = [];
  const seedFor = (freeLane: number) => ({ off: 4, lane: freeLane, air: false, n: 4 });
  // safe / seed segments
  for (const lane of LANES) {
    list.push(makeTemplate(`safe-${lane}`, "safe", [], { off: 2, lane, air: lane === 0, n: 6 }));
  }
  list.push(makeTemplate("safe-open", "safe", [], null));
  // single-obstacle segments, every lane × kind
  for (const lane of LANES) {
    for (const kind of ["hurdle", "beam", "crate"] as ObKind[]) {
      const free = LANES.find((l) => l !== lane)!;
      list.push(
        makeTemplate(`single-${kind}-${lane}`, "single", [{ off: 6, kind, lanes: [lane] }], seedFor(free)),
      );
    }
    list.push(
      makeTemplate(`puddle-${lane}`, "special", [{ off: 6, kind: "puddle", lanes: [lane] }], seedFor(LANES.find((l) => l !== lane)!)),
    );
    list.push(
      makeTemplate(`mover-${lane}`, "special", [{ off: 6, kind: "mover", lanes: [lane] }], null),
    );
  }
  // double-obstacle segments (two lanes blocked, one free)
  const doubleKinds: [ObKind, ObKind][] = [
    ["crate", "crate"],
    ["hurdle", "beam"],
    ["crate", "hurdle"],
    ["beam", "crate"],
  ];
  for (const free of LANES) {
    const blocked = LANES.filter((l) => l !== free);
    for (const [k1, k2] of doubleKinds) {
      list.push(
        makeTemplate(
          `double-${free}-${k1}-${k2}`,
          "double",
          [
            { off: 6, kind: k1, lanes: [blocked[0]!] },
            { off: 6, kind: k2, lanes: [blocked[1]!] },
          ],
          seedFor(free),
        ),
      );
    }
    // gate: the two crates sit right at the entry — you must already be
    // in the free lane when the segment starts (restricted entryMask)
    list.push(
      makeTemplate(
        `gate-${free}`,
        "gate",
        [
          { off: 1.5, kind: "crate", lanes: [blocked[0]!] },
          { off: 1.5, kind: "crate", lanes: [blocked[1]!] },
        ],
        seedFor(free),
        { entryMask: bit(free) },
      ),
    );
  }
  // full-width forced-action segments (§1.3.1: 三道强制跳 / 三道强制滑)
  list.push(makeTemplate("full-jump", "full", [{ off: 6, kind: "hurdle", lanes: [...LANES] }], null));
  list.push(makeTemplate("full-jump-late", "full", [{ off: 9, kind: "hurdle", lanes: [...LANES] }], null));
  list.push(makeTemplate("full-slide", "full", [{ off: 6, kind: "beam", lanes: [...LANES] }], null));
  list.push(makeTemplate("full-slide-late", "full", [{ off: 9, kind: "beam", lanes: [...LANES] }], null));
  // combo: jump then slide inside one segment
  list.push(
    makeTemplate("combo-js", "single", [
      { off: 3, kind: "hurdle", lanes: [...LANES] },
      { off: 9, kind: "beam", lanes: [...LANES] },
    ], null),
  );
  list.push(
    makeTemplate("combo-sj", "single", [
      { off: 3, kind: "beam", lanes: [...LANES] },
      { off: 9, kind: "hurdle", lanes: [...LANES] },
    ], null),
  );
  // landing gate: must enter grounded (a jump from the previous segment
  // would land on the entry crates)
  list.push(
    makeTemplate("landing", "gate", [{ off: 1.5, kind: "crate", lanes: [0] }], seedFor(-1), {
      entryState: "normal",
    }),
  );
  return list;
}

export const TEMPLATES = buildTemplates();
const SAFE_TEMPLATE = TEMPLATES.find((t) => t.id === "safe-open")!;

/** §1.4 difficulty tier by elapsed seconds. */
function tierAt(seconds: number): { density: number; doublePct: number } {
  if (seconds < 30) return { density: 4, doublePct: 0 };
  if (seconds < 60) return { density: 6, doublePct: 0.1 };
  if (seconds < 90) return { density: 8, doublePct: 0.2 };
  if (seconds < 120) return { density: 10, doublePct: 0.3 };
  return { density: 12, doublePct: 0.4 };
}

function stateCompatible(exitState: StateKind, entryState: EntryState): boolean {
  if (entryState === "any") return true;
  return exitState === entryState;
}

/** §1.3.2 adjacency check: segment A (prev) may be followed by B (next). */
export function canChain(
  prev: Pick<Template, "solveMask" | "exitState" | "exitRemain" | "exitClearance">,
  next: Pick<Template, "entryMask" | "entryState">,
  vNext: number,
): boolean {
  if ((prev.solveMask & next.entryMask) !== 0 && stateCompatible(prev.exitState, next.entryState)) {
    return true;
  }
  const tAction = prev.exitState === "normal" ? 0 : prev.exitRemain;
  return prev.exitClearance >= dReact(vNext, tAction);
}

/* --------------------------------- the sim --------------------------------- */

export class RunnerSim {
  readonly params: CharParams;
  readonly characterId: string;
  readonly level: number;
  private rng: () => number;
  tick = 0;
  distance = 0;
  speed = 10;
  lanePos = 0;
  targetLane = 0;
  jumpTick = 0;
  slideTick = 0;
  shield = 0;
  private shieldRechargeProgress = 0;
  magnetTicks = 0;
  flightTicks = 0;
  boostTicks = 0;
  doubleTicks = 0;
  sneakTicks = 0;
  skillBoostTicks = 0;
  /** imdpepe「impepe」state: remaining ticks, seeds charged toward the
   *  next trigger, and the accumulated ×2 double-score bonus (float;
   *  floored when it enters the score). */
  impepeTicks = 0;
  impepeCharge = 0;
  private impepeBonus = 0;
  puddleSlowTicks = 0;
  bonusPoints = 0;
  invulnTicks = 0;
  seedsCollected = 0;
  nearMiss = 0;
  crashed = false;
  finished = false;
  obstacles: Obstacle[] = [];
  seeds: SeedItem[] = [];
  powers: PowerItem[] = [];
  private nextSegDist = 30;
  private segCount = 0;
  private prevTemplate: Template = SAFE_TEMPLATE;
  private nextId = 1;
  lastShieldTick = -9999;
  lastPowerTick = -9999;
  lastPowerKind: PowerKind | null = null;
  lastSkillBoostTick = -9999;
  lastImpepeTick = -9999;

  constructor(seed: number, characterId: string, level = 1) {
    this.rng = mulberry32(seed);
    this.characterId = CHAR_IDS.includes(characterId as CharId) ? characterId : DEFAULT_CHAR;
    this.level = Math.min(5, Math.max(1, Math.floor(level) || 1));
    this.params = charParams(this.characterId, this.level);
    this.shield = this.characterId === "xueqiu" ? this.params.shieldMax : 0;
  }

  get jumpHeight(): number {
    if (this.flightTicks > 0) return 1.3;
    if (this.jumpTick <= 0) return 0;
    const t = this.jumpTick / this.params.airTicks;
    const h = Math.sin(Math.PI * Math.min(1, t));
    return this.sneakTicks > 0 ? h * 1.45 : h;
  }

  get flying(): boolean {
    return this.flightTicks > 0;
  }

  get boosting(): boolean {
    return this.boostTicks > 0 || this.skillBoostTicks > 0;
  }

  get sliding(): boolean {
    return this.slideTick > 0 && this.jumpTick <= 0;
  }

  /** §1.5: floor((floor(8 × distance) + seeds × 2 + bonus) × 倍率).
   *  imdpepe's impepe state adds its accumulated ×2 bonus (distance and
   *  seed points earned while it lasts, counted a second time). */
  get score(): number {
    const base =
      Math.floor(8 * this.distance) +
      this.seedsCollected * 2 +
      this.bonusPoints +
      Math.floor(this.impepeBonus);
    return Math.floor(base * (1 + this.params.roleMul * 0.01));
  }

  get impepeActive(): boolean {
    return this.impepeTicks > 0;
  }

  applyAction(action: ActionType) {
    if (this.crashed || this.finished) return;
    if (action === "left") this.targetLane = Math.max(-1, this.targetLane - 1);
    else if (action === "right") this.targetLane = Math.min(1, this.targetLane + 1);
    else if (action === "jump") {
      if (this.flightTicks <= 0 && this.jumpTick <= 0) {
        this.jumpTick = 1;
        this.slideTick = 0;
      }
    } else if (action === "slide") {
      if (this.flightTicks > 0) {
        // already airborne on the jetpack — sliding does nothing
      } else if (this.jumpTick > 0) {
        this.jumpTick = Math.max(this.jumpTick, this.params.airTicks - 3);
        this.slideTick = this.params.slideTicks;
      } else {
        this.slideTick = this.params.slideTicks;
      }
    }
  }

  private pickTemplate(secondsAtSeg: number): Template {
    const tier = tierAt(secondsAtSeg);
    const weights: Record<Tag, number> = {
      safe: Math.max(0.14, 1 - tier.density / 13),
      single: 0.5,
      double: 0.06 + tier.doublePct,
      gate: 0.04 + tier.doublePct * 0.5,
      full: 0.09,
      special: 0.18,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const total = Object.values(weights).reduce((a, b) => a + b, 0);
      let r = this.rng() * total;
      let tag: Tag = "single";
      for (const [t, w] of Object.entries(weights) as [Tag, number][]) {
        r -= w;
        if (r <= 0) {
          tag = t;
          break;
        }
      }
      const pool = TEMPLATES.filter((t) => t.tag === tag);
      const cand = pool[Math.floor(this.rng() * pool.length)] ?? SAFE_TEMPLATE;
      const vNext = speedAt(secondsAtSeg);
      if (canChain(this.prevTemplate, cand, vNext)) return cand;
    }
    return SAFE_TEMPLATE; // §1.3.2: 3 failed draws → degrade to a safe segment
  }

  private generateUntil() {
    while (this.nextSegDist < this.distance + 150) {
      const segStart = this.nextSegDist;
      const secondsAtSeg = this.tick / 60 + (segStart - this.distance) / Math.max(10, this.speed);
      const tpl = this.segCount < 2 ? SAFE_TEMPLATE : this.pickTemplate(secondsAtSeg);
      this.segCount += 1;
      this.prevTemplate = tpl;
      for (const row of tpl.rows) {
        for (const lane of row.lanes) {
          this.obstacles.push({
            id: this.nextId++,
            dist: segStart + row.off,
            lane,
            kind: row.kind,
            passed: false,
            curLane: lane,
            phase: this.rng() * Math.PI * 2,
          });
        }
      }
      if (tpl.seedLine) {
        const air = tpl.seedLine.air;
        for (let i = 0; i < tpl.seedLine.n; i++) {
          this.seeds.push({
            id: this.nextId++,
            dist: segStart + tpl.seedLine.off + i * 1.6,
            lane: tpl.seedLine.lane,
            air,
            taken: false,
            pull: 0,
          });
        }
      }
      // loose seed lines between segments （花生 spawnMul raises this rate)
      if (this.rng() < 0.22 * this.params.spawnMul) {
        const lane = Math.floor(this.rng() * 3) - 1;
        const air = this.rng() < 0.3;
        const n = 4 + Math.floor(this.rng() * 4);
        for (let i = 0; i < n; i++) {
          this.seeds.push({
            id: this.nextId++,
            dist: segStart + SEG_LEN + 2 + i * 1.6,
            lane,
            air,
            taken: false,
            pull: 0,
          });
        }
      }
      // power-up in a lane that is free at its offset
      if (tpl.tag !== "full" && this.rng() < 0.24 * this.params.spawnMul) {
        const kinds: PowerKind[] = ["shield", "magnet", "flight", "boost", "double", "sneak"];
        const kind = kinds[Math.floor(this.rng() * kinds.length)]!;
        const blockedAt6 = new Set(tpl.rows.filter((r) => Math.abs(r.off - 6) < 1.5).flatMap((r) => r.lanes));
        const freeLanes = LANES.filter((l) => !blockedAt6.has(l));
        const lane = freeLanes[Math.floor(this.rng() * freeLanes.length)] ?? 0;
        this.powers.push({ id: this.nextId++, dist: segStart + 6, lane, kind, taken: false });
      }
      this.nextSegDist += SEG_LEN;
    }
    const cutoff = this.distance - 15;
    this.obstacles = this.obstacles.filter((o) => o.dist > cutoff);
    this.seeds = this.seeds.filter((s) => s.dist > cutoff);
    this.powers = this.powers.filter((p) => p.dist > cutoff);
  }

  /** 3D distance (world units) from a seed's rendered centre to the
   *  hamster's body capsule at the given state snapshot. The capsule
   *  axis runs from BODY_RADIUS above the feet to BODY_HEIGHT −
   *  BODY_RADIUS (sliding squashes the top to ≈1.35); the seed's height
   *  mirrors the renderer, including the magnet glide toward chest
   *  height as s.pull rises. */
  private seedBodyDist(s: SeedItem, dist: number, lanePos: number, jumpH: number): number {
    const baseY = s.air ? 1.55 : 0.42;
    const seedY = s.pull > 0 ? baseY + (1.05 - baseY) * s.pull : baseY;
    const dx = (s.lane - lanePos) * LANE_WORLD_W;
    const dz = -(s.dist - dist) * WORLD_PER_HEIGHT;
    const jumpY = jumpH * 1.7;
    const top = this.sliding ? 1.35 : BODY_HEIGHT;
    const yLo = jumpY + BODY_RADIUS;
    const yHi = jumpY + Math.max(BODY_RADIUS, top - BODY_RADIUS);
    const cy = Math.min(yHi, Math.max(yLo, seedY));
    const dy = seedY - cy;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** 3D distance (world units) from a power-up's rendered centre
   *  (floating at POWER_Y in its lane) to the body capsule — the same
   *  capsule the seed pickup uses, so the grab fires on visual contact
   *  at any jump height instead of the old same-lane + jumpHeight<0.55
   *  gate, which let low jumps pass through the halo empty-handed. */
  private powerBodyDist(p: PowerItem, dist: number, lanePos: number, jumpH: number): number {
    const dx = (p.lane - lanePos) * LANE_WORLD_W;
    const dz = -(p.dist - dist) * WORLD_PER_HEIGHT;
    const jumpY = jumpH * 1.7;
    const top = this.sliding ? 1.35 : BODY_HEIGHT;
    const yLo = jumpY + BODY_RADIUS;
    const yHi = jumpY + Math.max(BODY_RADIUS, top - BODY_RADIUS);
    const cy = Math.min(yHi, Math.max(yLo, POWER_Y));
    const dy = POWER_Y - cy;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private collectSeed() {
    this.seedsCollected += 1;
    if (this.doubleTicks > 0) this.bonusPoints += 2; // 双倍积分: the seed counts twice
    if (this.impepeTicks > 0) this.impepeBonus += 2; // impepe ×2: the seed counts twice
    // 栗子 §2.2: every 30 seeds triggers the skill boost
    if (
      this.characterId === "lizi" &&
      this.seedsCollected % 30 === 0 &&
      this.params.skillBoostTicks > 0
    ) {
      this.skillBoostTicks = this.params.skillBoostTicks;
      this.lastSkillBoostTick = this.tick;
    }
    // imdpepe「impepe」: charge per seed; at the threshold the state
    // triggers (charging pauses while the state is running)
    if (
      this.characterId === "imdpepe" &&
      this.params.impepeThreshold > 0 &&
      this.impepeTicks <= 0
    ) {
      this.impepeCharge += 1;
      if (this.impepeCharge >= this.params.impepeThreshold) {
        this.impepeCharge = 0;
        this.impepeTicks = this.params.impepeDurationTicks;
        this.lastImpepeTick = this.tick;
      }
    }
  }

  step(action: ActionType | null): boolean {
    if (this.crashed || this.finished) return false;
    if (action) this.applyAction(action);
    this.tick += 1;
    const seconds = this.tick / 60;
    let speedMul = 1;
    if (this.boostTicks > 0) speedMul *= 1.3; // §1.6 加速板 ×1.3
    if (this.flightTicks > 0) speedMul *= 1.12;
    if (this.skillBoostTicks > 0) speedMul *= this.params.skillBoostMul;
    if (this.puddleSlowTicks > 0) speedMul *= 0.7; // 水坑减速 30%
    this.speed = speedAt(seconds) * speedMul;
    const prevDist = this.distance;
    const prevLanePos = this.lanePos;
    const prevJumpH = this.jumpHeight;
    this.distance += this.speed / 60;
    // impepe ×2: distance points earned during the state count twice
    if (this.impepeTicks > 0) this.impepeBonus += (this.distance - prevDist) * 8;

    // §1.2 lane change: exponential approach, τ = 0.1s, snap at 0.05 units
    const diff = this.targetLane - this.lanePos;
    if (Math.abs(diff) < 0.066) this.lanePos = this.targetLane;
    else this.lanePos += diff * Math.min(1, 10 / 60);

    if (this.jumpTick > 0) {
      this.jumpTick += 1;
      if (this.jumpTick > this.params.airTicks) this.jumpTick = 0;
    } else if (this.slideTick > 0) {
      this.slideTick -= 1;
    }
    if (this.magnetTicks > 0) this.magnetTicks -= 1;
    if (this.flightTicks > 0) this.flightTicks -= 1;
    if (this.boostTicks > 0) this.boostTicks -= 1;
    if (this.doubleTicks > 0) this.doubleTicks -= 1;
    if (this.sneakTicks > 0) this.sneakTicks -= 1;
    if (this.skillBoostTicks > 0) this.skillBoostTicks -= 1;
    if (this.impepeTicks > 0) this.impepeTicks -= 1;
    if (this.puddleSlowTicks > 0) this.puddleSlowTicks -= 1;
    if (this.invulnTicks > 0) this.invulnTicks -= 1;

    // 雪球 §2.3: shield layers recharge one at a time
    if (
      this.params.shieldRechargeTicks > 0 &&
      this.shield < this.params.shieldMax &&
      !this.crashed
    ) {
      this.shieldRechargeProgress += 1;
      if (this.shieldRechargeProgress >= this.params.shieldRechargeTicks) {
        this.shield += 1;
        this.shieldRechargeProgress = 0;
      }
    }

    this.generateUntil();

    // movers patrol inside their lane
    for (const o of this.obstacles) {
      if (o.kind === "mover") {
        o.curLane = o.lane + 0.5 * Math.sin(this.tick * 0.055 + o.phase);
      }
    }

    // magnet attraction （芝麻 has a longer reach — params.magnetRange);
    // during impepe the pull covers the whole generated track ahead
    if (this.magnetTicks > 0 || this.impepeTicks > 0) {
      const pullRange = this.impepeTicks > 0 ? 1000 : this.params.magnetRange;
      for (const s of this.seeds) {
        if (s.taken) continue;
        const dz = s.dist - this.distance;
        if (dz < -1 || dz > pullRange) continue;
        s.pull = Math.min(1, s.pull + 0.14);
        s.lane += (this.lanePos - s.lane) * 0.22;
        s.dist += (this.distance + 0.3 - s.dist) * 0.22;
        // the grab itself happens in the unified 3D pickup pass below:
        // a homing seed is collected the tick its centre reaches the
        // body capsule's surface — it never flies into the body centre
      }
    }
    // seeds — 3D pickup (see SEED_PICKUP_DIST): a seed is collected in
    // this same tick (before the frame is rendered) as soon as its
    // centre is within pickup distance of the body capsule, checked at
    // the current state and at the tick's midpoint state so a fast
    // diagonal pass cannot tunnel through the capsule between ticks.
    // This replaces the old forward-window + height-gate rule, which
    // let seeds whose lane/height gate missed (grounded runs into air
    // seeds, late lane changes, jump descents onto an air arc) travel
    // through the model before — or without — being collected.
    // While flight / magnet / impepe lasts, the previous wide forward
    // sweep is kept as a second rule: those states vacuum seeds in
    // front of the body (flight passes far above ground seeds), and
    // the grab still fires ahead of the body plane, never inside it.
    const sweeping = this.flightTicks > 0 || this.magnetTicks > 0 || this.impepeTicks > 0;
    const midDist = (prevDist + this.distance) / 2;
    const midLane = (prevLanePos + this.lanePos) / 2;
    const midJump = (prevJumpH + this.jumpHeight) / 2;
    for (const s of this.seeds) {
      if (s.taken) continue;
      const near =
        this.seedBodyDist(s, this.distance, this.lanePos, this.jumpHeight) <= SEED_PICKUP_DIST ||
        this.seedBodyDist(s, midDist, midLane, midJump) <= SEED_PICKUP_DIST;
      if (near) {
        s.taken = true;
        this.collectSeed();
        continue;
      }
      if (
        sweeping &&
        s.dist <= this.distance + SEED_COLLECT_LEAD &&
        s.dist >= this.distance - 0.25 &&
        Math.abs(this.lanePos - s.lane) <= 1.6
      ) {
        s.taken = true;
        this.collectSeed();
      }
    }
    // powers — 3D capsule pickup (see POWER_PICKUP_DIST): collected
    // the tick the floating pickup touches the body capsule, checked
    // at the current and midpoint states; flight keeps the old wide
    // same-lane grab (evaluated at the crossing lane).
    for (const p of this.powers) {
      if (p.taken) continue;
      if (prevDist < p.dist && p.dist <= this.distance) {
        const fracP = (p.dist - prevDist) / Math.max(1e-9, this.distance - prevDist);
        const laneAtCrossP = prevLanePos + (this.lanePos - prevLanePos) * fracP;
        const got =
          this.flightTicks > 0
            ? Math.abs(laneAtCrossP - p.lane) <= 0.6
            : this.powerBodyDist(p, this.distance, this.lanePos, this.jumpHeight) <= POWER_PICKUP_DIST ||
              this.powerBodyDist(p, midDist, midLane, midJump) <= POWER_PICKUP_DIST;
        if (got) {
          p.taken = true;
          this.lastPowerTick = this.tick;
          this.lastPowerKind = p.kind;
          if (p.kind === "shield") this.shield = Math.min(this.params.shieldMax, this.shield + 1);
          else if (p.kind === "magnet") this.magnetTicks = this.params.magnetTicks;
          else if (p.kind === "flight") {
            this.flightTicks = POWER_DURATIONS.flight;
            this.jumpTick = 0;
            this.slideTick = 0;
          } else if (p.kind === "boost") this.boostTicks = POWER_DURATIONS.boost;
          else if (p.kind === "double") this.doubleTicks = POWER_DURATIONS.double;
          else this.sneakTicks = POWER_DURATIONS.sneak;
        }
      }
    }
    // obstacles — visual-contact test at the interpolated crossing
    // state (see OB_TOP_WORLD): the lane and jump height of the exact
    // moment the obstacle plane is crossed, not the tick's end state,
    // so a lane-change sweep through an obstacle's side registers and
    // a jump is judged by where its feet actually were at the plane.
    for (const o of this.obstacles) {
      if (o.passed) continue;
      if (prevDist < o.dist && o.dist <= this.distance) {
        o.passed = true;
        const frac = (o.dist - prevDist) / Math.max(1e-9, this.distance - prevDist);
        const laneAtCross = prevLanePos + (this.lanePos - prevLanePos) * frac;
        const jumpAtCross = prevJumpH + (this.jumpHeight - prevJumpH) * frac;
        const effLane = o.kind === "mover" ? o.curLane : o.lane;
        const lateral = Math.abs(laneAtCross - effLane);
        if (lateral >= OB_LATERAL[o.kind]) {
          if (lateral < 1.5) this.nearMiss += 1;
          continue;
        }
        if (o.kind === "puddle") {
          if (this.impepeTicks <= 0 && this.flightTicks <= 0 && jumpAtCross < 0.3) {
            this.puddleSlowTicks = 60;
          }
          continue;
        }
        const feetLift = jumpAtCross * 1.7;
        let hit = false;
        if (this.flightTicks > 0) hit = false;
        else if (o.kind === "beam")
          // the beam band is [1.72, 2.24]: sliding ducks under it; a
          // jump whose feet clear its top (sneak apex 2.47) flies
          // over; anything between still spans the band and hits
          hit = !this.sliding && feetLift < OB_TOP_WORLD.beam + 0.03;
        else hit = feetLift < OB_TOP_WORLD[o.kind];
        if (!hit) continue;
        // imdpepe「impepe」: invincible — smashes every obstacle for +20
        if (this.impepeTicks > 0) {
          this.bonusPoints += 20;
          continue;
        }
        // 煤球 §2.2: sliding is invincible and smashes crates
        if (this.characterId === "meiqiu" && this.sliding) {
          if (o.kind === "crate") this.bonusPoints += 20;
          continue;
        }
        // 栗子 skill boost smashes crates only
        if (this.skillBoostTicks > 0 && o.kind === "crate") {
          this.bonusPoints += 20;
          continue;
        }
        // 加速板 boost smashes through anything
        if (this.boostTicks > 0) {
          this.bonusPoints += 20;
          continue;
        }
        if (this.shield > 0 && this.invulnTicks <= 0) {
          this.shield -= 1;
          this.shieldRechargeProgress = 0;
          this.invulnTicks = 90;
          this.lastShieldTick = this.tick;
        } else if (this.invulnTicks <= 0) {
          this.crashed = true;
          // stop BEFORE the obstacle's front face (see CRASH_STOP):
          // the body never ends the run embedded in the mesh, and the
          // crash演出 plays out in front of the obstacle with a gap
          this.distance = Math.min(this.distance, o.dist - CRASH_STOP[o.kind]);
          break;
        }
      }
    }

    if (this.tick >= MAX_TICKS) this.finished = true;
    return !this.crashed && !this.finished;
  }

  result(): SimResult {
    return {
      score: this.score,
      distance: Math.floor(this.distance),
      seeds: this.seedsCollected,
      ticks: this.tick,
      crashed: this.crashed,
    };
  }
}

/** Replay a full input log on the server. Pure and deterministic. */
export function simulateRun(
  seed: number,
  characterId: string,
  inputs: InputEvent[],
  level = 1,
): SimResult & { valid: boolean; reason?: string } {
  let prev = -100;
  for (const ev of inputs) {
    if (!Number.isInteger(ev.tick) || ev.tick < 0 || ev.tick > MAX_TICKS) {
      return { ...new RunnerSim(seed, characterId, level).result(), valid: false, reason: "bad_tick" };
    }
    if (ev.tick - prev < 4) {
      return { ...new RunnerSim(seed, characterId, level).result(), valid: false, reason: "too_fast" };
    }
    prev = ev.tick;
  }
  if (inputs.length > 3000) {
    return { ...new RunnerSim(seed, characterId, level).result(), valid: false, reason: "too_many" };
  }
  const sim = new RunnerSim(seed, characterId, level);
  const byTick = new Map<number, ActionType>();
  for (const ev of inputs) byTick.set(ev.tick, ev.action);
  while (!sim.crashed && !sim.finished) {
    sim.step(byTick.get(sim.tick + 1) ?? null);
  }
  return { ...sim.result(), valid: true };
}
