// The five racers （方案 v0.2 §2). Every hamster has its own personality,
// display stats and a deterministic skill whose numbers live in sim.ts
// (charParams level tables) so the server recomputes them. The in-run
// look comes entirely from each character's GLB model (see Runner.tsx).

/* Front-view portraits: transparent-background (alpha) cutouts of the
 * front frame of each hamster's three-view render, copied byte-for-byte
 * from ~/workspace/hamster-model/views/*-front-nobg.png into
 * client/src/assets. The previous *-front.png files carried a light
 * backdrop baked in, which showed as a white box on the dark UI. */
import liziFront from "./assets/lizi-front-nobg.png";
import xueqiuFront from "./assets/xueqiu-front-nobg.png";
import meiqiuFront from "./assets/meiqiu-front-nobg.png";
import huashengFront from "./assets/huasheng-front-nobg.png";
import zhimaFront from "./assets/zhima-front-nobg.png";
import imdpepeFront from "./assets/imdpepe-front-nobg.png";

const FRONT_PORTRAITS: Record<string, string> = {
  lizi: liziFront,
  xueqiu: xueqiuFront,
  meiqiu: meiqiuFront,
  huasheng: huashengFront,
  zhima: zhimaFront,
  imdpepe: imdpepeFront,
};

export interface CharacterMeta {
  id: string;
  name: string;
  title: string;
  desc: string;
  accent: string;
  trait: string;
  /** display stats, 5-point scale (§2.2 — display only, not physics) */
  speed: number;
  stamina: number;
  luck: number;
  skillName: string;
  /** skill summary at Lv1 → Lv5, shown on the character card */
  skillText: string;
}

export const CHARACTERS: CharacterMeta[] = [
  {
    id: "lizi",
    name: "栗子",
    title: "红围巾 · 爆发手",
    desc: "攒满 30 颗葵花籽就冲刺，冲刺时撞碎木箱不减速。",
    accent: "#d8402e",
    trait: "冲刺",
    speed: 4,
    stamina: 3,
    luck: 3,
    skillName: "攒劲冲刺",
    skillText: "每 30 籽触发冲刺：Lv1 3.0 秒 ×1.40 → Lv5 4.5 秒 ×1.60",
  },
  {
    id: "xueqiu",
    name: "雪球",
    title: "蓝领结 · 耐力王",
    desc: "开局自带双层护盾，护盾碎了还会自己慢慢充回来。",
    accent: "#3a7bd5",
    trait: "护盾",
    speed: 2,
    stamina: 5,
    luck: 3,
    skillName: "双层护盾",
    skillText: "护盾层数 / 重充：Lv1 2 层 / 28 秒 → Lv5 4 层 / 16 秒",
  },
  {
    id: "meiqiu",
    name: "煤球",
    title: "绿发带 · 碎箱手",
    desc: "滑铲更久，滑铲全程无敌，还能把木箱直接铲碎。",
    accent: "#58b368",
    trait: "碎箱",
    speed: 4,
    stamina: 3,
    luck: 2,
    skillName: "碎箱滑铲",
    skillText: "滑铲时长：Lv1 0.78 秒 → Lv5 1.05 秒，滑铲中撞碎木箱",
  },
  {
    id: "huasheng",
    name: "花生",
    title: "海盗眼罩 · 幸运星",
    desc: "运气拉满，赛道上的葵花籽和道具都比别人多。",
    accent: "#e2543e",
    trait: "幸运",
    speed: 3,
    stamina: 2,
    luck: 5,
    skillName: "幸运掉落",
    skillText: "金籽与道具出现率：Lv1 +25% → Lv5 +50%",
  },
  {
    id: "zhima",
    name: "芝麻",
    title: "金方牌 · 磁力王",
    desc: "磁铁时间更长、吸得更远，隔着一条道也能把籽吸过来。",
    accent: "#e0a81c",
    trait: "磁铁",
    speed: 3,
    stamina: 3,
    luck: 4,
    skillName: "强力磁铁",
    skillText: "磁铁时长 / 半径：Lv1 12 秒 / ×1.5 → Lv5 18 秒 / ×3.0",
  },
];

/** The hidden sixth character. Deliberately NOT in CHARACTERS: it never
 *  joins the regular select row, the sequential unlock order, or any
 *  docs. It renders only as a silhouette card until the player discovers
 *  it (see App.tsx), then as its own card below the five. */
export const IMDPEPE_META: CharacterMeta = {
  id: "imdpepe",
  name: "imdpepe",
  title: "一只来自未知世界的pepe，那里似乎有很多智能体ai……",
  desc: "吃籽蓄力，攒满就进入「impepe」：无敌撞碎一切障碍、全赛道金籽吸附、得分翻倍。",
  accent: "#4a90d9",
  trait: "凝视",
  speed: 3,
  stamina: 4,
  luck: 5,
  skillName: "impepe",
  skillText: "每 40 籽触发 5 秒 impepe：Lv1 40 籽 / 5 秒 → Lv5 28 籽 / 8 秒",
};

export function charById(id: string): CharacterMeta {
  if (id === IMDPEPE_META.id) return IMDPEPE_META;
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0]!;
}

/* English display text per hamster (names are pinyin of the Chinese name).
 * `charText` picks the set for the active UI language so no screen shows
 * untranslated character copy. */
export interface CharacterText {
  name: string;
  title: string;
  desc: string;
  trait: string;
  skillName: string;
  skillText: string;
}

const CHARACTERS_EN: Record<string, CharacterText> = {
  lizi: {
    name: "Lizi",
    title: "Red Scarf · Burst Sprinter",
    desc: "Collect 30 sunflower seeds to trigger a dash — smashing crates at full speed while it lasts.",
    trait: "Dash",
    skillName: "Charged Dash",
    skillText: "Dash every 30 seeds: Lv1 3.0s ×1.40 → Lv5 4.5s ×1.60",
  },
  xueqiu: {
    name: "Xueqiu",
    title: "Blue Bow · Stamina King",
    desc: "Starts with a double-layer shield that slowly recharges itself after it breaks.",
    trait: "Shield",
    skillName: "Double Shield",
    skillText: "Shield layers / recharge: Lv1 2 layers / 28s → Lv5 4 layers / 16s",
  },
  meiqiu: {
    name: "Meiqiu",
    title: "Green Headband · Crate Smasher",
    desc: "Slides longer, is invincible while sliding, and smashes crates to pieces.",
    trait: "Smash",
    skillName: "Crate-Smash Slide",
    skillText: "Slide duration: Lv1 0.78s → Lv5 1.05s; smashes crates while sliding",
  },
  huasheng: {
    name: "Huasheng",
    title: "Pirate Patch · Lucky Star",
    desc: "Luck maxed out: more sunflower seeds and power-ups on the track than anyone else.",
    trait: "Luck",
    skillName: "Lucky Drops",
    skillText: "Golden seed & power-up rates: Lv1 +25% → Lv5 +50%",
  },
  imdpepe: {
    name: "imdpepe",
    title: "A pepe from an unknown world — there seem to be many AI agents there……",
    desc: "Charges up on seeds, then enters impepe: invincible, smashing every obstacle, pulling in seeds track-wide, double score.",
    trait: "Stare",
    skillName: "impepe",
    skillText: "Triggers every 40 seeds for 5s: Lv1 40 seeds / 5s → Lv5 28 seeds / 8s",
  },
  zhima: {
    name: "Zhima",
    title: "Gold Tag · Magnet King",
    desc: "A longer, wider magnet that pulls in seeds from a full lane away.",
    trait: "Magnet",
    skillName: "Power Magnet",
    skillText: "Magnet duration / radius: Lv1 12s / ×1.5 → Lv5 18s / ×3.0",
  },
};

export function charText(meta: CharacterMeta, lang: "zh" | "en"): CharacterText {
  if (lang === "en") {
    return (
      CHARACTERS_EN[meta.id] ?? {
        name: meta.name,
        title: meta.title,
        desc: meta.desc,
        trait: meta.trait,
        skillName: meta.skillName,
        skillText: meta.skillText,
      }
    );
  }
  return {
    name: meta.name,
    title: meta.title,
    desc: meta.desc,
    trait: meta.trait,
    skillName: meta.skillName,
    skillText: meta.skillText,
  };
}

/** Front-facing 3D portrait per hamster: the transparent cutout of the
 * front frame of the owner's three-view render (tight-cropped RGBA,
 * roughly 0.63 aspect). The container paints NO background and has NO
 * border or box: the alpha image sits directly on the caller's card,
 * so no white or light rectangle can show around the hamster.
 * Large placements (size \u2265 64: detail card, result screen) show the
 * full body with object-fit: contain; small avatar spots crop square
 * on the head with object-fit: cover anchored to the top \u2014 the crop
 * corners are transparent pixels, so the card colour shows through.
 * The image is never stretched. Locked select cards keep the caller's
 * grayscale/opacity wrapper, which applies to this element too.
 * \u96ea\u7403 (xueqiu) is white-furred: on the light Morning Meadow cards
 * its silhouette would wash into the white surface, so its cutout
 * gets a faint alpha-following drop-shadow \u2014 a soft contour that
 * hugs the fur outline (detail image and select avatars alike, since
 * every placement goes through this component). */
export function HamsterFace({
  meta,
  size = 64,
  silhouette = false,
}: {
  meta: CharacterMeta;
  size?: number;
  /** renders the cutout as a solid black silhouette (undiscovered
   *  hidden character) — the portrait itself stays hidden */
  silhouette?: boolean;
}) {
  const src = FRONT_PORTRAITS[meta.id] ?? liziFront;
  const large = size >= 64;
  const w = large ? Math.round(size * 0.72) : size;
  const h = large ? Math.round(size * 1.2) : size;
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: w,
        height: h,
        flex: "none",
        overflow: "hidden",
        background: "transparent",
        lineHeight: 0,
      }}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          objectFit: large ? "contain" : "cover",
          objectPosition: large ? "50% 50%" : "50% 0%",
          filter: silhouette
            ? "brightness(0)"
            : meta.id === "xueqiu"
              ? "drop-shadow(0 1px 2px rgba(90, 110, 80, 0.4)) drop-shadow(0 0 7px rgba(120, 150, 110, 0.3))"
              : undefined,
        }}
      />
    </span>
  );
}
