import { LangToggle, useLang } from "./i18n";

/**
 * Game documentation page — the finalized draft
 * (~/workspace/hamster-run-docs-draft.md) shipped in-game.
 *
 * Rules honoured here:
 * - The draft's internal note section is NOT published.
 * - Numbers that change (current settled block height, SQUEEKTOSHI's cumulative mileage) are rendered from the game's live
 *   Squeekchain data (dailyTrack / relay queries passed in as props),
 *   never hard-coded; when live data is unavailable the copy says to
 *   check the live on-chain data instead of showing a stale figure.
 * - The hidden character is never mentioned anywhere in this page.
 * - Current rules: mileage gates in metres, relay step 100 km,
 *   one-click mint at 0.01 Sepolia ETH.
 */

const HAMSTER_NFT_V2 = "0x15601070312Fd8071d11B6Bd2606B2A5D9ec620b";
const SCORE_LEDGER = "0xFB650C5503A2A05f01D4DF91e5a522EbD1Eba552";

export interface DocsLiveData {
  /** Today's daily-track source block height (live), null when unknown. */
  blockHeight: number | null;
  /** SQUEEKTOSHI's cumulative mileage in km (live), null when unknown. */
  relayCurrentKm: number | null;
  /** SQUEEKTOSHI's launch-day baseline in km (live), null when unknown. */
  relayBaselineKm: number | null;
  /** Kilometres gained since the baseline (live), null when unknown. */
  relayGainedKm: number | null;
}

interface DocsCopy {
  intro: string;
  liveTitle: string;
  liveBlock: (h: number) => string;
  liveBlockUnknown: string;
  liveRelay: (currentKm: string, baselineKm: string) => string;
  liveRelayUnknown: string;
  liveNote: string;
  sections: {
    title: string;
    paragraphs: string[];
    bullets?: string[];
    subsections?: { title: string; paragraphs: string[] }[];
  }[];
  faqTitle: string;
  faqs: { q: string; a: string }[];
  musicCreditTitle: string;
  musicCredit: string;
}

function buildCopy(lang: "zh" | "en", _live: DocsLiveData): DocsCopy {
  if (lang === "en") {
    return {
      intro:
        "Everything about how Hamster Run plays, scores, unlocks — and how it is built on real Squeekchain data.",
      liveTitle: "Live Squeekchain data",
      liveBlock: (h) => `Today's track is generated from settled block ${h}.`,
      liveBlockUnknown: "Today's track block height is shown on the lobby's Today's Track card, from live on-chain data.",
      liveRelay: (currentKm, baselineKm) =>
        `SQUEEKTOSHI's cumulative mileage is currently ${currentKm} km (launch baseline ${baselineKm} km) — live data, it keeps growing as it runs.`,
      liveRelayUnknown:
        "SQUEEKTOSHI's cumulative mileage is shown on the lobby's SQUEEKTOSHI Mileage Relay card, from live on-chain data.",
      liveNote: "Block height and mileage change over time — the live on-chain data is always the source of truth.",
      sections: [
        {
          title: "1. What this game is",
          paragraphs: [
            "Hamster Run is a 3D endless runner: you steer a hamster down a three-lane track, dodging obstacles, collecting sunflower seeds and grabbing power-ups. The farther you run, the higher you score. It is all swipes — one thumb is all you need:",
          ],
          bullets: [
            "Swipe left / right: switch lanes",
            "Swipe up: jump",
            "Swipe down: slide",
            "On desktop, use the keyboard: A / D to switch lanes, W or Space to jump, S to slide",
          ],
        },
        {
          title: "2. Hamsters & power-ups",
          paragraphs: [
            "The launch roster has 5 hamsters. Each has its own skill, and each levels from Lv1 to Lv5 — the more it runs, the stronger its skill gets:",
          ],
          bullets: [
            "Lizi (owned from the start): Charged Dash",
            "Xueqiu: Double Shield — one hit doesn't end the run",
            "Meiqiu: slide smashes crates",
            "Huasheng: Lucky Drops — sunflower seed rewards +25%",
            "Zhima: Power Magnet — a wider pull range",
          ],
        },
        {
          title: "Scoring",
          paragraphs: [
            "6 kinds of power-ups appear randomly on the track and take effect the moment you pick them up: Shield (blocks one hit), Magnet (pulls in nearby seeds for a while), Jetpack (flies over a stretch of obstacles), Boost Pad (speeds up and smashes obstacles), Double Points (double scoring for a while) and Spring Shoes (jump higher).",
            "Scoring is public and transparent: score = distance (m) × 8 + sunflower seeds × 2, plus power-up and level bonuses. Your final score is recomputed by the server on the same track — editing the score locally does nothing. The leaderboard ranks your best single run: finish a normal run and you make the board, while top scores take route choice and power-up timing.",
          ],
        },
        {
          title: "3. Unlocks & level-ups",
          paragraphs: [],
          bullets: [
            "Only Lizi is playable at the start. The other four unlock in order, by your account's lifetime mileage: 2,000 m unlocks Xueqiu, 5,000 m Meiqiu, 10,000 m Huasheng, 20,000 m Zhima.",
            "Each hamster levels up on its own mileage: 1,000 / 3,000 / 5,000 / 8,000 m take it to Lv2 / Lv3 / Lv4 / Lv5.",
            "Unlocks and level-ups are both minted through the HamsterNFT contract (Sepolia testnet), 0.01 Sepolia ETH each time. One click: the button checks your mileage in the background and your wallet asks for a single confirmation. Mileage eligibility is verified and signed off by the server — if you haven't reached the gate, you can't mint, and paying alone never skips a level.",
          ],
        },
        {
          title: "4. Built on Squeekchain",
          paragraphs: [
            "This game's track isn't generated out of thin air — it grows out of Squeekchain's real data. Squeekchain is a toy chain driven by SQUEEKTOSHI: as SQUEEKTOSHI runs on its wheel, sensors record its activity in rounds (10 minutes each) and settle it on-chain. That public data is there for anyone to check, and we use it in four places:",
          ],
          subsections: [
            {
              title: "1) Daily track: the same track for everyone",
              paragraphs: [
                "The server takes the height of the latest settled block on-chain, adds today's date, and makes a seed — and that seed builds today's track. So everyone runs the same track today and it's pure skill. At settlement, the page stamps the block height that generated the track: a birth certificate for your score. Why a settled block? Settled data never changes, so the seed stays stable all day; once settlement advances on-chain, tomorrow's track is naturally a new one.",
              ],
            },
            {
              title: "2) Shadow Rival: racing SQUEEKTOSHI's past pace",
              paragraphs: [
                "The Shadow Rival running alongside you takes its pace from the real workload of one of SQUEEKTOSHI's past rounds: a busy round makes a fast rival, a lazy round a slow one. To be clear up front: the Shadow Rival is not a real player, and not your own personal best — it converts one real round of SQUEEKTOSHI into a challenge pace, so every run gives you a visible opponent.",
              ],
            },
            {
              title: "3) SQUEEKTOSHI Mileage Relay: SQUEEKTOSHI runs out new tracks",
              paragraphs: [
                "To be clear up front: this mileage is run entirely by SQUEEKTOSHI. Player scores don't count towards it, and no player ever needs to grind progress here. The game took SQUEEKTOSHI's cumulative mileage at launch as its baseline; from there, every extra 100 km it runs automatically unlocks the next track theme for everyone: Dusk Rooftops, Starry Valley, Snowy Pines (the base theme is Dawn Meadow). You just wait for it to run enough — the theme opens by itself.",
              ],
            },
            {
              title: "4) Scores & hamsters on-chain",
              paragraphs: [
                `Sign-in is a wallet signature only — no transfer, no gas. The server verifies the signature before it recognises your account, so typing in someone else's address can't impersonate them. Hamster unlocks and levels are recorded in the HamsterNFT contract (${HAMSTER_NFT_V2}, Sepolia testnet) — connect the same wallet on another device and your hamsters and levels are right there. Key scores are recorded by the ScoreLedger contract (${SCORE_LEDGER}), and with the server's recomputation, every score on the board can be re-verified.`,
              ],
            },
          ],
        },
      ],
      faqTitle: "5. FAQ",
      faqs: [
        {
          q: "Is signature sign-in safe? Can you control my wallet?",
          a: `No. Sign-in only signs a piece of challenge text to prove the address is yours: it doesn't expose your private key, transfer anything, or cost gas, and that signature gives the project no power over your wallet. In the whole game you only ever send one transaction yourself: when minting, 0.01 Sepolia ETH to the HamsterNFT contract (${HAMSTER_NFT_V2}, the fixed address in section 4) — your wallet's confirmation screen shows the amount and destination clearly. The game never asks you to approve any token. Any pop-up asking for your private key, seed phrase, or a token approval is not from us.`,
        },
        {
          q: "My run score matched the settled score, so why didn't my rank move?",
          a: "The leaderboard ranks your best single run. Only beating your own best score moves you up.",
        },
        {
          q: "When does a new track theme unlock?",
          a: "Watch the SQUEEKTOSHI Mileage Relay: every extra 100 km SQUEEKTOSHI runs above the baseline unlocks one. The lobby shows the current progress.",
        },
      ],
      musicCreditTitle: "Music credits",
      musicCredit:
        'Menu: "Carefree" · In-game: "Rocket Power" — Kevin MacLeod (incompetech.com), licensed under CC BY 4.0.',
    };
  }
  return {
    intro: "玩法、计分、解锁升级，还有这款游戏和 Squeekchain 的结合方式，都写在这里。",
    liveTitle: "Squeekchain 实时数据",
    liveBlock: (h) => `今日赛道由第 ${h} 块已结算数据生成。`,
    liveBlockUnknown: "今日赛道的块高见大厅「今日赛道」卡片，以链上实时数据为准。",
    liveRelay: (currentKm, baselineKm) =>
      `SQUEEKTOSHI 累计里程当前 ${currentKm} km（上线基线 ${baselineKm} km），实时数据，它还在继续跑。`,
    liveRelayUnknown: "SQUEEKTOSHI 累计里程见大厅 SQUEEKTOSHI 里程接力卡片，以链上实时数据为准。",
    liveNote: "块高和里程都会变，以链上实时数据为准。",
    sections: [
      {
        title: "一、这是什么游戏",
        paragraphs: [
          "《仓鼠快跑》是一款 3D 无尽跑酷游戏：你操控一只仓鼠在三车道赛道上奔跑，躲障碍、吃葵花籽、捡道具，跑得越远分越高。全程滑动操作，单手就能玩：",
        ],
        bullets: ["左滑 / 右滑：变道", "上滑：跳跃", "下滑：滑铲", "电脑上用键盘：A / D 变道，W 或空格跳跃，S 滑铲"],
      },
      {
        title: "二、仓鼠与道具",
        paragraphs: ["首版共 5 只仓鼠，每只都有自己的技能，等级从 Lv1 到 Lv5，跑得越多等级越高，技能越强："],
        bullets: [
          "栗子（初始拥有）：攒劲冲刺",
          "雪球：双层护盾，撞一次不结束",
          "煤球：滑铲能碎箱",
          "花生：幸运掉落，葵花籽收益 +25%",
          "芝麻：强力磁铁，吸附范围更大",
        ],
      },
      {
        title: "计分",
        paragraphs: [
          "赛道上会随机出现 6 种道具，捡到立即生效：护盾（抵挡一次撞击）、磁铁（一段时间自动吸附附近葵花籽）、飞行器（飞起来越过一段障碍）、加速板（加速一段并撞碎障碍）、双倍积分（一段时间内得分翻倍）、弹力鞋（跳得更高）。",
          "计分规则公开透明：分数 = 距离（米）× 8 + 葵花籽 × 2，再加道具与等级加成。最终成绩由服务端用同一条赛道重新验算，本地改分无效。排行榜按单局最佳排名，普通人完整跑完一局就能上榜，顶级分数要靠路线和道具时机。",
        ],
      },
      {
        title: "三、解锁与升级",
        paragraphs: [],
        bullets: [
          "开局只有栗子。其余 4 只按顺序解锁，看你的账号累计总里程：2000 米解锁雪球，5000 米解锁煤球，10000 米解锁花生，20000 米解锁芝麻。",
          "每只仓鼠单独升级，看它自己跑过的里程：1000 / 3000 / 5000 / 8000 米，依次升到 Lv2 / Lv3 / Lv4 / Lv5。",
          "解锁和升级都通过 HamsterNFT 合约铸造（Sepolia 测试网），每次 0.01 Sepolia ETH，一键完成：点 Mint 后后台自动核验里程，钱包只弹一次确认。里程够不够由服务端核验后签名放行，没达标铸不了，不是花钱就能跳级。",
        ],
      },
      {
        title: "四、与 Squeekchain 的结合",
        paragraphs: [
          "这款游戏的赛道不是凭空生成的，它长在 Squeekchain 的真实数据上。Squeekchain 是一条由 SQUEEKTOSHI 驱动的玩具链：SQUEEKTOSHI 在转轮上跑动，转轮传感器把它的运动量按轮次（10 分钟一轮）记录并结算上链。它的公开数据谁都能查，我们用了其中四处：",
        ],
        subsections: [
          {
            title: "1. 每日赛道：全服同一条",
            paragraphs: [
              "服务端取链上最新一个已结算块的块高，加上当天日期，生成一颗种子，用这颗种子拼出当天的赛道。所以全服玩家今天跑的是同一条赛道，拼的是纯技术。结算时页面会盖上生成这条赛道的块高，算是这局成绩的出生证明。为什么用已结算的块：已结算数据不会再变，种子一整天稳定；链上结算推进后，明天的赛道自然换新。",
            ],
          },
          {
            title: "2. 影子对手：和 SQUEEKTOSHI 的历史节奏赛跑",
            paragraphs: [
              "对局里和你并行的影子对手，节奏来自 SQUEEKTOSHI 某个历史轮次的真实工作量：那一轮它跑得勤，影子就快；它偷懒，影子就慢。先说清：影子对手不是真人玩家，也不是你自己的历史最佳，它是把 SQUEEKTOSHI 的一轮真实表现换算成了一条挑战节奏，让你每局都有个看得见的对手。",
            ],
          },
          {
            title: "3. SQUEEKTOSHI 里程接力：SQUEEKTOSHI 跑出新赛道",
            paragraphs: [
              "先说清：这段里程完全是 SQUEEKTOSHI 跑出来的，玩家跑的分不计入这里，也不需要玩家参与刷进度。游戏上线时以 SQUEEKTOSHI 当时的累计里程作基线，此后它每再跑出 100 公里，下一个赛道主题就自动为所有人解锁：黄昏屋顶、星夜山谷、雪原松林（基础主题是晨光草原）。你只要等它跑够，主题自己会开。",
            ],
          },
          {
            title: "4. 成绩与仓鼠上链",
            paragraphs: [
              `登录只需钱包签名，不转账、不花 gas；服务端验证签名后才认你这个账号，手填地址冒充不了。仓鼠的解锁与等级记录在 HamsterNFT 合约里（${HAMSTER_NFT_V2}，Sepolia 测试网），换个设备连上同一钱包就能看到你的仓鼠和等级。成绩由 ScoreLedger 合约（${SCORE_LEDGER}）记录关键成绩，配合服务端验算，榜上的分都经得起复算。`,
            ],
          },
        ],
      },
    ],
    faqTitle: "五、常见问题",
    faqs: [
      {
        q: "签名登录安全吗？你们能控制我的钱包吗？",
        a: `不能。登录只是对一段挑战文字签名，证明这个地址是你的：不暴露私钥、不转账、不花 gas，项目方凭这个签名动不了你的钱包。整个游戏里你只会主动发出一笔交易：mint 时付 0.01 Sepolia ETH 到 HamsterNFT 合约（${HAMSTER_NFT_V2}，就是第四节那个固定地址），钱包确认页能看清金额和去向；游戏从不要你授权任何代币。凡是让你输私钥、助记词，或授权代币的弹窗，都不是我们。`,
      },
      {
        q: "为什么我跑的分和结算分一样，但榜上名次没动？",
        a: "排行榜排的是单局最佳，只有刷新你自己的最佳成绩才会往上走。",
      },
      {
        q: "新赛道主题什么时候解锁？",
        a: "看 SQUEEKTOSHI 里程接力：SQUEEKTOSHI 在基线之上每多跑 100 公里解锁一个，大厅里能看到当前进度。",
      },
    ],
    musicCreditTitle: "音乐鸣谢",
    musicCredit: "菜单音乐「Carefree」、对局音乐「Rocket Power」— Kevin MacLeod (incompetech.com)，CC BY 4.0 授权。",
  };
}

export function DocsPage({
  live,
  onBack,
}: {
  live: DocsLiveData;
  onBack: () => void;
}) {
  const { lang, t } = useLang();
  const copy = buildCopy(lang, live);
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3.5 px-4 pb-10 pt-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label={t.backToLobby}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-lg font-extrabold shadow-[0_4px_14px_rgba(60,90,50,0.12)]"
        >
          ←
        </button>
        <h1 className="min-w-0 flex-1 text-2xl font-extrabold">{t.docsTitle}</h1>
        <LangToggle />
      </div>

      <p className="text-sm leading-relaxed text-[var(--dim)]">{copy.intro}</p>

      <section
        aria-label={copy.liveTitle}
        className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5"
      >
        <h2 className="text-base font-extrabold">{copy.liveTitle}</h2>
        <p className="mt-1.5 text-sm leading-relaxed [overflow-wrap:anywhere]">
          {live.blockHeight !== null ? copy.liveBlock(live.blockHeight) : copy.liveBlockUnknown}
        </p>
        <p className="mt-1 text-sm leading-relaxed [overflow-wrap:anywhere]">
          {live.relayCurrentKm !== null && live.relayBaselineKm !== null
            ? copy.liveRelay(live.relayCurrentKm.toFixed(2), live.relayBaselineKm.toFixed(2))
            : copy.liveRelayUnknown}
          {live.relayGainedKm !== null
            ? lang === "en"
              ? ` It has added ${live.relayGainedKm.toFixed(2)} km since the baseline.`
              : ` 上线以来已新增 ${live.relayGainedKm.toFixed(2)} km。`
            : ""}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">{copy.liveNote}</p>
      </section>

      {copy.sections.map((section) => (
        <section
          key={section.title}
          aria-label={section.title}
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5"
        >
          <h2 className="text-base font-extrabold">{section.title}</h2>
          {section.paragraphs.map((p) => (
            <p key={p.slice(0, 24)} className="mt-1.5 text-sm leading-relaxed [overflow-wrap:anywhere]">
              {p}
            </p>
          ))}
          {section.bullets && (
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed">
              {section.bullets.map((b) => (
                <li key={b.slice(0, 24)}>{b}</li>
              ))}
            </ul>
          )}
          {section.subsections?.map((sub) => (
            <div key={sub.title} className="mt-3">
              <h3 className="text-sm font-extrabold">{sub.title}</h3>
              {sub.paragraphs.map((p) => (
                <p key={p.slice(0, 24)} className="mt-1 text-sm leading-relaxed [overflow-wrap:anywhere]">
                  {p}
                </p>
              ))}
            </div>
          ))}
        </section>
      ))}

      <section
        aria-label={copy.faqTitle}
        className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5"
      >
        <h2 className="text-base font-extrabold">{copy.faqTitle}</h2>
        <div className="mt-1.5 flex flex-col gap-3">
          {copy.faqs.map((f) => (
            <div key={f.q}>
              <h3 className="text-sm font-extrabold leading-relaxed">{f.q}</h3>
              <p className="mt-0.5 text-sm leading-relaxed text-[var(--dim)] [overflow-wrap:anywhere]">{f.a}</p>
            </div>
          ))}
        </div>
      </section>

      <section
        aria-label={copy.musicCreditTitle}
        className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5"
      >
        <h2 className="text-base font-extrabold">{copy.musicCreditTitle}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)] [overflow-wrap:anywhere]">
          {copy.musicCredit}
        </p>
      </section>

      <button
        type="button"
        onClick={onBack}
        className="w-full rounded-[var(--radius)] bg-[var(--accent)] py-3.5 text-base font-extrabold text-white shadow-[0_4px_14px_rgba(60,90,50,0.16)]"
      >
        {t.backToLobby}
      </button>
    </div>
  );
}
