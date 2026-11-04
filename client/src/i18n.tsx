import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { PowerKind } from "./sim";
import { storageGet, storageSet } from "./storage";

/* Bilingual UI layer (zh-CN default, English switchable). The choice is
 * stored in localStorage and restored on the next visit. All user-facing
 * copy lives here (plus per-character text in characters.tsx) so no screen
 * hard-codes a single language. */

export type Lang = "zh" | "en";
const LANG_KEY = "hamster-run-lang";

const zh = {
  close: "关闭",
  backToLobby: "返回大厅",
  langSwitchAria: "切换语言 / Switch language",

  docsEntry: "文档",
  docsEntrySub: "玩法 · 计分 · 解锁 · Squeekchain 说明",
  docsTitle: "游戏文档",
  docsAria: "游戏文档",

  /* hero + entry */
  heroAlt: "金毛仓鼠栗子戴着红围巾在晨光草原的土赛道上冲刺",
  heroTitle: "仓鼠快跑",
  heroSub: "3D 三车道跑酷 · 单手滑动 · 五只仓鼠，五种技能",
  testMode: "游客模式",
  playerInfoAria: "玩家信息",
  previewNote: "游客模式 · 成绩不进正式排行榜",
  chainReading: "正在读取链上持有…",
  chainHeld: (count: number, balance: number) => `链上持有 ${count} 只仓鼠（NFT ${balance} 枚）`,
  chainUnavailable: "链上持有暂时读不到",
  logout: "退出",
  entryAria: "进入游戏",
  nickname: "昵称",
  nicknamePlaceholder: "榜上显示的名字（可不填）",
  connectWallet: "连接钱包 · 签名登录",
  testEntry: "游客模式 · 免钱包试玩",
  entering: "正在进入…",
  entryNote: "钱包登录只签名，不转账、不花 gas。游客模式不用钱包、只解锁基础仓鼠栗子，成绩不进正式排行榜。",
  walletNotFound: (name: string) =>
    `没检测到 ${name}，已打开下载页。安装后刷新页面再试。`,
  walletNoAddress: "钱包没有返回地址",
  signFailed: "签名被取消或失败",

  /* daily track + relay */
  dailyTrackAria: "今日赛道与 SQUEEKTOSHI 里程主题解锁",
  todayTrack: "今日赛道",
  trackFromA: "由",
  trackBlock: (h: number) => `Squeekchain 第 ${h} 块`,
  trackFromB: "已结算数据生成，全服今天跑同一条赛道。",
  trackFallback: "Squeekchain 暂时读不到，今天沿用昨天的赛道种子。",
  trackLoading: "正在读取 Squeekchain…",
  relayTitle: "SQUEEKTOSHI 里程接力",
  relaySubtitle: "SQUEEKTOSHI · Squeekchain 实时数据",
  relayTotal: (km: string) => `累计 ${km} km`,
  relayProgressAria: "SQUEEKTOSHI 里程主题解锁进度",
  relayText: (km: string) =>
    `里程由 SQUEEKTOSHI 跑出，不是玩家跑的，玩家成绩不计入。上线以来它已新增 ${km} km；玩家不用刷进度——它每多跑 100 km，下一个主题自动为所有人解锁。`,
  relayStepProgress: (km: string) => `下一主题进度 ${km} / 100 km`,
  relayLocked: " · 未解锁",
  relayCurrent: " · 当前",
  relayUnavailable: "SQUEEKTOSHI 里程数据暂时拉不到，主题解锁进度稍后再看。",

  /* shadow rival */
  shadowAria: "历史轮次影子挑战",
  shadowTitle: "历史轮次影子挑战",
  shadowSwitchAria: "本局带影子对手一起跑",
  shadowLabel: "影子对手",
  on: "开",
  off: "关",
  shadowChallengeA: "挑战",
  shadowRound: (r: number) => `第 ${r} 轮的影子对手`,
  shadowDisclaimer: (work: number) => `由该轮工作量 ${work} 合成，不是真人回放，也不是你的历史成绩`,
  shadowBodyB: "开跑后，顶部会实时显示双方差距。",
  shadowNote: (r: number) => `影子对手：第 ${r} 轮合成节奏，只用来挑战，不计入排行榜。`,
  shadowStatsAria: "影子对手数据",
  shadowStatRound: (r: number) => `轮次 · 第 ${r} 轮`,
  shadowStatWork: (w: number) => `合成工作量 · ${w}`,
  shadowStatPace: (f: number) => `目标节奏 · ×${f}`,
  shadowStateOn: "本局开启 · 开跑后顶部实时显示差距",
  shadowStateOff: "本局关闭 · 这一局自己跑",
  hudShadowNote: (r: number) => `影子对手：由第 ${r} 轮 SQUEEKTOSHI 工作量合成的挑战节奏，不是你的历史成绩。`,
  shadowUnavailable: "影子对手数据暂时拉不到，这一局先自己跑。",

  /* my data */
  myDataAria: "我的数据",
  myDataTitle: "我的数据",
  myDataConnect: "连接钱包查看你的数据",
  myDataConnectBtn: "连接钱包",
  myDataTestBadge: "游客数据",
  statTotalM: "账号总里程",
  statRuns: "对局数",
  statBest: "最佳成绩",
  statFarthest: "最远距离",
  statDistVal: (m: number) => `${m} 米`,
  statMVal: (m: string) => `${m} 米`,
  dataUnlocked: "已解锁",
  dataHeldChain: (lv: number) => `链上 Lv${lv}`,
  dataLocked: "未解锁",
  dataOwnM: (m: string) => `本鼠里程 ${m} 米`,
  dataNextLevel: (cur: string, target: string, lv: number) => `升 Lv${lv}：${cur} / ${target} 米`,
  dataUnlockNext: (cur: string, target: string, name: string) => `解锁${name}：总里程 ${cur} / ${target} 米`,
  dataAccountProgress: "账号解锁进度",
  dataAllUnlocked: "五只仓鼠已全部解锁",
  dataMaxLevel: "已满级",

  /* characters */
  selectAria: "选择仓鼠",
  pickHamster: "选你的仓鼠",
  hamsterListAria: "仓鼠列表",
  statSpeed: "速度",
  statStamina: "耐力",
  statLuck: "幸运",
  levelAria: (lv: number) => `当前等级 Lv${lv}`,
  chainHoldLabel: "Sepolia 链上持有（v2 合约）：",
  chainHoldReading: "读取中…",
  chainHoldUnavailable: "暂时读不到",
  chainHoldLevel: (lv: number) => `Lv${lv}（本局按链上等级结算）`,
  chainHoldNone: "未持有（解锁需先达到里程门槛再 mint）",
  mint: "Mint",

  /* progression / locks (rules v2) */
  lockBadge: "锁定",
  cardUnlockAt: (m: string) => `累计 ${m} 米解锁`,
  loginToProgress: "登录后累计里程解锁",
  unlockProgressLabel: (cur: string, target: string) => `总里程 ${cur} / ${target} 米`,
  unlockReady: "里程已达标，可 mint 解锁",
  unlockNotReady: "里程未达标，先用已解锁的仓鼠累计里程",
  pendingPayment: "待支付 · 已登记",
  mintUnlockBtn: (price: string) => `Mint 解锁 · ${price} Sepolia ETH`,
  mintUpgradeBtn: (price: string, lv: number) => `Mint 升级 Lv${lv} · ${price} Sepolia ETH`,
  levelUpBadge: (lv: number) => `升级 Lv${lv}`,
  levelUpOwnLabel: (cur: string, target: string) => `本鼠里程 ${cur} / ${target} 米`,
  levelUpNotReady: "本鼠里程未达标，先用这只仓鼠多跑几局",
  levelUpProgressLabel: (cur: string, target: string, lv: number) =>
    `本鼠里程 ${cur} / ${target} 米，达标后可升 Lv${lv}`,
  levelUpReadyText: (lv: number) => `本鼠里程已达标，可 mint 升 Lv${lv}`,
  maxLevel: "已满级 Lv5",
  /* hidden character imdpepe (easter egg — never in docs) */
  imdpepeHint: "有个家伙在终端里看着你",
  imdpepeJoined: "> agent imdpepe joined",
  imdpepeDragged: "你被 imdpepe 拽入了一个未知的世界",
  imdpepeSilhouetteAria: "未发现的角色剪影",
  imdpepeCardAria: "隐藏角色 imdpepe",
  guestNeedWallet: "游客模式不能 Mint，连接钱包后可用",
  guestOnlyBase: "游客模式只解锁基础仓鼠栗子，连接钱包后可解锁更多仓鼠",
  registerPending: "登记待支付",
  registeredPending: "已登记 · 待支付",
  stickyLocked: "未解锁",

  /* how to play + items */
  howToAria: "玩法与道具图鉴",
  howToTitle: "单手操作",
  howTo1: "左滑 / 右滑换道，上滑跳过低栏，下滑钻过高栏",
  howTo2: "木箱要换道躲开；栗子的技能冲刺、煤球的滑铲可以撞碎。水坑只减速，滚石会左右移动",
  howTo3: "计分：距离 × 8 + 葵花籽 × 2，再按仓鼠等级加成；服务端按操作记录重算",
  itemsTitle: "道具图鉴",
  items: [
    { name: "护盾", desc: "挡下一次撞击；雪球可以叠层" },
    { name: "磁铁", desc: "8 秒吸附附近葵花籽；芝麻更久" },
    { name: "飞行器", desc: "6 秒飞越全部障碍" },
    { name: "加速板", desc: "3 秒速度 ×1.3，撞碎障碍 +20 分" },
    { name: "双倍积分", desc: "6 秒内葵花籽得分 ×2" },
    { name: "弹力鞋", desc: "10 秒跳跃高度 ×1.45" },
  ] as { name: string; desc: string }[],
  playToBoard: "跑完一局就上榜",

  /* tiers */
  tierSuffix: (name: string) => `${name}段位`,

  /* leaderboard */
  boardAria: "总排行榜",
  boardTitle: "总排行榜",
  boardSub: "自上线以来 · 每人取单局最佳 · 只显示前 30 名",
  boardPlayers: (n: number) => `共 ${n} 名玩家`,
  loading: "加载中…",
  boardEmpty: "还没有正式成绩。签名登录并跑完一局，你就是第 1 名。",
  boardFootnote:
    "正式成绩由服务端按操作记录重算，本地改分无效；游客成绩不进此榜。影子对手由历史轮次工作量合成，不是真人回放。",
  boardBornAt: (b: number) => `诞生于第 ${b} 块`,

  /* champion */
  championAria: "昨日冠军链上存证",
  championTitle: "昨日冠军存证",
  championOnChain: "链上冠军：",
  championScore: (s: number) => `${s} 分`,
  championBorn: (b: number) => `诞生于 Squeekchain 第 ${b} 块`,
  championMeta: (day: string, distance: number, who: string) =>
    `${day}（UTC）${who ? ` · ${who}` : ""} · 距离 ${distance} 米`,
  championNone: "暂无昨日冠军存证。",
  championUnavailable: "存证合约暂时读不到，稍后再看。",
  championPending: "昨日冠军已定，正在写入链上存证，稍后再看。",
  championFailed: "昨日冠军已定，但上次写入链上失败，等下次打开页面时会自动重试。",
  championViewTx: "在区块浏览器查看这笔上链记录",
  championContractLink: "ScoreLedger 合约",
  championFlow:
    "每日 UTC 0 点结算前一日的日榜第 1 名：成绩先经服务端重算确认，再由项目方部署钱包写入 ScoreLedger 存证。",

  /* daily board */
  dailyBoardAria: "日排行榜",
  dailyBoardTitle: "日排行榜",
  dailyBoardSub: "今日（UTC）单局最佳 · 前 3 名 · 每日 UTC 0 点刷新",
  dailyBoardEmpty: "今天还没有正式成绩，跑完一局你就是今日第 1 名。",

  /* sticky start bar */
  stickyReady: "今日赛道已就绪",
  stickyShadow: (r: number) => `第 ${r} 轮影子对手 · `,
  startRun: "开始跑酷",

  /* mint modal — one button, one wallet confirmation */
  mintModalAria: "Mint 仓鼠",
  mintTitleUnlock: (name: string) => `Mint 解锁 ${name}`,
  mintTitleUpgrade: (name: string, lv: number) => `Mint 升级 ${name} → Lv${lv}`,
  mintPriceLine: (price: string) => `${price} Sepolia ETH（另付 gas）`,
  mintReadyLine: "已达标，可以 Mint",
  mintShortBy: (m: string) => `还差 ${m} 米达标`,
  mintBtn: (price: string) => `Mint · ${price} Sepolia ETH`,
  mintProcessing: "处理中…",
  mintSuccessTitle: "Mint 成功",
  mintSuccessTx: (hash: string) => `交易 ${hash}`,
  mintConfirming: "已提交，正在等链上确认…",
  mintConfirmSlow: "链上确认比较慢，不用重复 Mint，确认后卡片会自动刷新。",
  mintRegisteredTitle: "已登记",
  mintRegisteredBody: "这只仓鼠已经解锁，可以开跑了。",
  mintTestNote: "游客模式不能 Mint，连接钱包后可用。",
  mintImdpepeRegNote: "imdpepe 不在 HamsterNFT 合约里，这次是游戏内登记，不上链。",
  mintSafetyTip:
    "官方只会让你发这一笔：付 0.01 Sepolia ETH 到 HamsterNFT 合约（0x1560…620b）。任何让你授权代币、输入助记词或私钥的弹窗都不是我们。",
  mintErrCancelled: "你取消了钱包确认，Mint 没有完成。",
  mintErrNoWallet: "没检测到钱包，请在钱包里打开游戏再 Mint。",
  mintErrChain: "钱包还没切到 Sepolia 网络，请在钱包里切过去再试。",
  mintErrGeneric: "Mint 没完成，请稍后再试。",
  mintErrNotReady: "里程还没达标，暂时不能 Mint。",
  mintDone: "完成",

  /* wallet modal */
  walletModalAria: "选择钱包",
  walletTitle: "选择钱包",
  walletIntro: "选择已安装的钱包并签名登录。只签名，不转账、不花 gas。未检测到的钱包会打开下载页。",
  walletWaiting: "等待签名…",
  walletDetected: "已检测到",
  walletNotDetected: "未检测到",
  signTimeout: "签名等待超时，请回到钱包确认，或重新发起签名。",

  /* result screen */
  resCrashed: "撞到了 · 本局结束",
  resFinished: "跑满全程 · 本局结束",
  resToBronze: (n: number) => `差 ${n} 分到青铜`,
  resDistance: "距离",
  resSeeds: "葵花籽",
  resBoard: "排行榜",
  resTest: "游客",
  resRank: (n: number) => `第 ${n} 名`,
  resDistVal: (n: number) => `${n} 米`,
  resSeedVal: (n: number) => `${n} 颗`,
  resShadowWin: (d: number, r: number) =>
    `你赢了影子对手！它跑了 ${d} 米（第 ${r} 轮合成节奏，不是真人回放）`,
  resShadowLose: (d: number, diff: number, r: number) =>
    `影子对手跑了 ${d} 米，你差 ${diff} 米（第 ${r} 轮合成节奏，不是真人回放）`,
  resBirth: (block: number, lvText: string) =>
    `成绩出生证明：Squeekchain 第 ${block} 块${lvText}。已写入游戏记录；成为当日冠军后，次日 UTC 0 点结算时写入 ScoreLedger 存证。`,
  resBirthLv: (name: string, lv: number) => ` · ${name} Lv${lv} 结算`,
  resBest: (s: number) => `你的个人最佳是 ${s} 分`,
  resPreviewNote: "这是游客成绩，不进正式排行榜。想上榜就连接钱包签名登录，再跑一局。",
  resRejected: "这局的操作记录没通过服务端校验，成绩没有记录。正常手速游玩不会触发。",
  resSubmitFailed: (e: string) => `成绩提交失败：${e}`,
  resReplay: "再来一局",
  resConnect: "连接钱包 · 签名上榜",

  /* runner / HUD */
  runStartFailed: "开局失败",
  runContainerError: "画面容器未就绪",
  runGlError: "WebGL 初始化失败",
  runSubmitFailed: "成绩提交失败",
  modelLoading: "模型加载中",
  modelLoadFailed: "模型加载失败",
  modelRetry: "重试加载",
  glScreenTitle: "3D 画面没能启动",
  viewportAria: "3D 仓鼠跑酷赛道：仓鼠在三车道上向前奔跑",
  hudScore: "分数",
  hudDistance: "距离",
  hudSeeds: "葵花籽",
  hudSpeed: "时速",
  hudShield: (n: number) => (n > 1 ? `护盾 ×${n}` : "护盾"),
  hudMagnet: (s: number) => `磁铁 ${s} 秒`,
  hudFlight: (s: number) => `飞行器 ${s} 秒`,
  hudBoost: (s: number) => `加速板 ${s} 秒`,
  hudDouble: (s: number) => `双倍 ${s} 秒`,
  hudSneak: (s: number) => `弹力鞋 ${s} 秒`,
  hudSkillBoost: (s: number) => `技能冲刺 ${s} 秒`,
  hudCharge: (n: number) => `冲刺蓄力 ${n}/30 籽`,
  hudImpepe: (s: number) => `impepe ${s} 秒`,
  hudImpepeCharge: (n: number, th: number) => `impepe 蓄力 ${n}/${th} 籽`,
  hudShadowAhead: (r: number, d: number) => `领先影子对手 ${d} 米 · 第 ${r} 轮`,
  hudShadowBehind: (r: number, d: number) => `落后影子对手 ${d} 米 · 第 ${r} 轮`,
  hudToFirst: (n: number) => `距第 1 名还差 ${n} 分`,
  hudFirst: "你暂时超过了第 1 名",
  pauseAria: (paused: boolean): string => (paused ? "继续" : "暂停"),
  pausedTitle: "已暂停",
  pausedResume: "继续跑",
  pausedQuit: "放弃这局",
  flashCrash: "撞到了！",
  flashShield: "护盾挡下了一次撞击！",
  flashPickup: (name: string) => `捡到${name}！`,
  padLeft: "左移",
  padRight: "右移",
  padSlide: "滑铲",
  padJump: "跳跃",
  padHint: "滑动换道 · 上滑跳 · 下滑滑铲",
  padHintKeys: "空格 / W 跳 · A / D 换道 · S 滑铲",
  powers: {
    shield: "护盾",
    magnet: "磁铁",
    flight: "飞行器",
    boost: "加速板",
    double: "双倍积分",
    sneak: "弹力鞋",
  } as Record<PowerKind, string>,

  /* music */
  muteAria: (muted: boolean): string => (muted ? "打开背景音乐" : "静音背景音乐"),
  musicOn: "音乐开",
  musicOff: "音乐关",
};

export type Dict = typeof zh;

const en: Dict = {
  close: "Close",
  backToLobby: "Back to lobby",
  langSwitchAria: "切换语言 / Switch language",

  docsEntry: "Docs",
  docsEntrySub: "How to play · Scoring · Unlocks · Squeekchain",
  docsTitle: "Game Docs",
  docsAria: "Game documentation",

  heroAlt: "Lizi, a golden hamster in a red scarf, sprinting down a dirt track through a sunny morning meadow",
  heroTitle: "Hamster Run",
  heroSub: "3D three-lane runner · one-thumb swipes · five hamsters, five skills",
  testMode: "Guest Mode",
  playerInfoAria: "Player info",
  previewNote: "Guest mode · not ranked",
  chainReading: "Reading on-chain holdings…",
  chainHeld: (count: number, balance: number) => `Holding ${count} hamsters on-chain (${balance} NFTs)`,
  chainUnavailable: "On-chain holdings unavailable right now",
  logout: "Log out",
  entryAria: "Enter the game",
  nickname: "Nickname",
  nicknamePlaceholder: "Name shown on the board (optional)",
  connectWallet: "Connect Wallet · Sign In",
  testEntry: "Guest Mode · Play Without a Wallet",
  entering: "Entering…",
  entryNote:
    "Wallet sign-in is signature-only — no transfer, no gas. Guest mode needs no wallet and unlocks only the base hamster Lizi; its runs never reach the official leaderboard.",
  walletNotFound: (name: string) =>
    `${name} wasn't detected, so its download page has opened. Install it, refresh, and try again.`,
  walletNoAddress: "The wallet didn't return an address",
  signFailed: "Signature cancelled or failed",

  dailyTrackAria: "Today's track and SQUEEKTOSHI mileage theme unlocks",
  todayTrack: "Today's Track",
  trackFromA: "Generated from settled data in",
  trackBlock: (h: number) => `Squeekchain block ${h}`,
  trackFromB: " — everyone runs the same track today.",
  trackFallback: "Squeekchain is unreachable, so today's track reuses yesterday's seed.",
  trackLoading: "Reading Squeekchain…",
  relayTitle: "SQUEEKTOSHI Mileage Relay",
  relaySubtitle: "SQUEEKTOSHI · Live Squeekchain data",
  relayTotal: (km: string) => `${km} km total`,
  relayProgressAria: "SQUEEKTOSHI mileage theme unlock progress",
  relayText: (km: string) =>
    `This mileage is run by SQUEEKTOSHI, not by players — player scores don't count. It has added ${km} km since launch, and you don't need to grind anything: every extra 100 km it runs auto-unlocks the next theme for everyone.`,
  relayStepProgress: (km: string) => `Next theme: ${km} / 100 km`,
  relayLocked: " · Locked",
  relayCurrent: " · Current",
  relayUnavailable: "SQUEEKTOSHI mileage data isn't available right now — check theme unlock progress later.",

  shadowAria: "Round Shadow Challenge",
  shadowTitle: "Round Shadow Challenge",
  shadowSwitchAria: "Run this round with the Shadow Rival",
  shadowLabel: "Shadow Rival",
  on: "On",
  off: "Off",
  shadowChallengeA: "Take on",
  shadowRound: (r: number) => `the Shadow Rival of Round ${r}`,
  shadowDisclaimer: (work: number) =>
    `Synthesized from that round's workload (${work}) — not a real replay or your personal best.`,
  shadowBodyB: "During the run, the top bar shows the live gap.",
  shadowNote: (r: number) =>
    `Shadow Rival: a Round ${r} synthesized pace for this challenge only; it is not ranked.`,
  shadowStatsAria: "Shadow Rival data",
  shadowStatRound: (r: number) => `Round · ${r}`,
  shadowStatWork: (w: number) => `Synthesized workload · ${w}`,
  shadowStatPace: (f: number) => `Target pace · ×${f}`,
  shadowStateOn: "On for this run · live gap shown up top",
  shadowStateOff: "Off for this run · running solo",
  hudShadowNote: (r: number) =>
    `Shadow Rival: a challenge pace synthesized from Round ${r}'s workload — not your personal best.`,
  shadowUnavailable: "Shadow Rival data isn't available right now — run solo this time.",

  /* my data */
  myDataAria: "My data",
  myDataTitle: "My Data",
  myDataConnect: "Connect a wallet to see your data",
  myDataConnectBtn: "Connect Wallet",
  myDataTestBadge: "Guest data",
  statTotalM: "Total mileage",
  statRuns: "Runs",
  statBest: "Best score",
  statFarthest: "Farthest",
  statDistVal: (m: number) => `${m} m`,
  statMVal: (m: string) => `${m} m`,
  dataUnlocked: "Unlocked",
  dataHeldChain: (lv: number) => `On-chain Lv${lv}`,
  dataLocked: "Locked",
  dataOwnM: (m: string) => `Own mileage ${m} m`,
  dataNextLevel: (cur: string, target: string, lv: number) => `To Lv${lv}: ${cur} / ${target} m`,
  dataUnlockNext: (cur: string, target: string, name: string) => `Unlock ${name}: total ${cur} / ${target} m`,
  dataAccountProgress: "Account unlock progress",
  dataAllUnlocked: "All five hamsters unlocked",
  dataMaxLevel: "Max level",

  selectAria: "Choose your hamster",
  pickHamster: "Pick Your Hamster",
  hamsterListAria: "Hamster list",
  statSpeed: "Speed",
  statStamina: "Stamina",
  statLuck: "Luck",
  levelAria: (lv: number) => `Current level Lv${lv}`,
  chainHoldLabel: "Sepolia on-chain holding (v2 contract):",
  chainHoldReading: "reading…",
  chainHoldUnavailable: "unavailable right now",
  chainHoldLevel: (lv: number) => `Lv${lv} (this run settles at the on-chain level)`,
  chainHoldNone: "not held (unlock by reaching the mileage gate, then mint)",
  mint: "Mint",

  /* progression / locks (rules v2) */
  lockBadge: "Locked",
  cardUnlockAt: (m: string) => `Unlocks at ${m} m total`,
  loginToProgress: "Sign in to build mileage and unlock",
  unlockProgressLabel: (cur: string, target: string) => `Total mileage ${cur} / ${target} m`,
  unlockReady: "Mileage reached — ready to mint and unlock",
  unlockNotReady: "Not enough mileage yet — build it up with an unlocked hamster",
  pendingPayment: "Pending payment · registered",
  mintUnlockBtn: (price: string) => `Mint to Unlock · ${price} Sepolia ETH`,
  mintUpgradeBtn: (price: string, lv: number) => `Mint to Lv${lv} · ${price} Sepolia ETH`,
  levelUpBadge: (lv: number) => `Level up to Lv${lv}`,
  levelUpOwnLabel: (cur: string, target: string) => `This hamster ${cur} / ${target} m`,
  levelUpNotReady: "This hamster's mileage isn't there yet — run more with it",
  levelUpProgressLabel: (cur: string, target: string, lv: number) =>
    `This hamster: ${cur} / ${target} m — reach it to level up to Lv${lv}`,
  levelUpReadyText: (lv: number) => `This hamster's mileage is in — ready to mint up to Lv${lv}`,
  maxLevel: "Max level Lv5",
  /* hidden character imdpepe (easter egg — never in docs) */
  imdpepeHint: "Someone is watching you from a terminal",
  imdpepeJoined: "> agent imdpepe joined",
  imdpepeDragged: "imdpepe has dragged you into an unknown world",
  imdpepeSilhouetteAria: "Silhouette of an undiscovered character",
  imdpepeCardAria: "Hidden character imdpepe",
  guestNeedWallet: "Guest mode can't mint — connect a wallet first",
  guestOnlyBase: "Guest mode only unlocks the base hamster Lizi — connect a wallet to unlock more",
  registerPending: "Register as pending payment",
  registeredPending: "Registered · pending payment",
  stickyLocked: "Locked",

  howToAria: "How to play and power-up guide",
  howToTitle: "One-Thumb Controls",
  howTo1: "Swipe left / right to switch lanes, up to jump low rails, down to duck under high rails",
  howTo2:
    "Change lanes to dodge crates; Lizi's Charged Dash and Meiqiu's slide can smash them. Puddles only slow you down; rolling stones move sideways",
  howTo3: "Score: distance × 8 + seeds × 2, plus your hamster's level bonus — recomputed server-side from your inputs",
  itemsTitle: "Power-Up Guide",
  items: [
    { name: "Shield", desc: "Blocks one hit; Xueqiu can stack layers" },
    { name: "Magnet", desc: "Pulls in nearby seeds for 8s; longer for Zhima" },
    { name: "Jetpack", desc: "Flies over every obstacle for 6s" },
    { name: "Boost Pad", desc: "Speed ×1.3 for 3s; smashing adds +20 pts" },
    { name: "Double Points", desc: "Seed points ×2 for 6s" },
    { name: "Spring Shoes", desc: "Jump height ×1.45 for 10s" },
  ],
  playToBoard: "Finish a run to hit the board",

  tierSuffix: (name: string) => `${name} Tier`,

  boardAria: "All-Time Leaderboard",
  boardTitle: "All-Time Leaderboard",
  boardSub: "Since launch · best single run per player · top 30 only",
  boardPlayers: (n: number) => `${n} players`,
  loading: "Loading…",
  boardEmpty: "No official scores yet. Sign in and finish a run to take #1.",
  boardFootnote:
    "Official scores are recomputed server-side from your input log, so local edits don't count. Guest runs are not listed. The Shadow Rival is synthesized from a past round's workload — not a real replay.",
  boardBornAt: (b: number) => `born at block ${b}`,

  championAria: "Yesterday's champion on-chain proof",
  championTitle: "Yesterday's Champion Proof",
  championOnChain: "On-chain champion:",
  championScore: (s: number) => `${s} pts`,
  championBorn: (b: number) => `born at Squeekchain block ${b}`,
  championMeta: (day: string, distance: number, who: string) =>
    `${day} (UTC)${who ? ` · ${who}` : ""} · ${distance} m`,
  championNone: "No yesterday champion proof yet.",
  championUnavailable: "The proof contract is unreachable right now — check back later.",
  championPending: "Yesterday's champion is decided — the on-chain proof is being written, check back shortly.",
  championFailed: "Yesterday's champion is decided, but the last on-chain write failed; it retries automatically on the next visit.",
  championViewTx: "View this record on the block explorer",
  championContractLink: "ScoreLedger contract",
  championFlow:
    "At 00:00 UTC each day, the previous day's #1 is settled: the score is re-verified server-side, then the project deployer wallet writes it into ScoreLedger.",

  dailyBoardAria: "Daily Leaderboard",
  dailyBoardTitle: "Daily Leaderboard",
  dailyBoardSub: "Today (UTC) best single run · top 3 · resets at 00:00 UTC",
  dailyBoardEmpty: "No official scores yet today — finish a run to be today's #1.",

  stickyReady: "Track ready",
  stickyShadow: (r: number) => `Shadow Rival · R${r} · `,
  startRun: "Start Run",

  mintModalAria: "Mint hamster",
  mintTitleUnlock: (name: string) => `Mint to Unlock ${name}`,
  mintTitleUpgrade: (name: string, lv: number) => `Mint to Upgrade ${name} → Lv${lv}`,
  mintPriceLine: (price: string) => `${price} Sepolia ETH (plus gas)`,
  mintReadyLine: "Mileage reached — ready to mint",
  mintShortBy: (m: string) => `${m} m short of the goal`,
  mintBtn: (price: string) => `Mint · ${price} Sepolia ETH`,
  mintProcessing: "Processing…",
  mintSuccessTitle: "Mint successful",
  mintSuccessTx: (hash: string) => `Tx ${hash}`,
  mintConfirming: "Sent — waiting for the on-chain confirmation…",
  mintConfirmSlow: "On-chain confirmation is taking a while. Don't mint again — the card will refresh itself once it lands.",
  mintRegisteredTitle: "Registered",
  mintRegisteredBody: "This hamster is unlocked and ready to run.",
  mintTestNote: "Guest mode can't mint — connect a wallet first.",
  mintImdpepeRegNote: "imdpepe isn't part of the HamsterNFT contract, so this mint is an in-game registration and doesn't go on-chain.",
  mintSafetyTip:
    "The only transaction we will ever ask you to send is this one: 0.01 Sepolia ETH to the HamsterNFT contract (0x1560…620b). Any pop-up asking you to approve tokens or enter a seed phrase or private key is not from us.",
  mintErrCancelled: "You cancelled in the wallet, so the mint didn't go through.",
  mintErrNoWallet: "No wallet detected — open the game inside your wallet to mint.",
  mintErrChain: "Your wallet isn't on the Sepolia network yet — switch it over and try again.",
  mintErrGeneric: "The mint didn't complete — please try again in a bit.",
  mintErrNotReady: "Mileage not reached yet, so this can't be minted for now.",
  mintDone: "Done",

  walletModalAria: "Choose a wallet",
  walletTitle: "Choose a Wallet",
  walletIntro:
    "Choose an installed wallet and sign in. Signature only — no transfer, no gas. An undetected wallet opens its download page.",
  walletWaiting: "Waiting for signature…",
  walletDetected: "Detected",
  walletNotDetected: "Not detected",
  signTimeout: "Signature timed out. Return to your wallet to confirm, or start the sign-in again.",

  resCrashed: "Crashed · Run over",
  resFinished: "Full course · Run over",
  resToBronze: (n: number) => `${n} pts to Bronze`,
  resDistance: "Distance",
  resSeeds: "Sunflower seeds",
  resBoard: "Leaderboard",
  resTest: "Guest",
  resRank: (n: number) => `#${n}`,
  resDistVal: (n: number) => `${n} m`,
  resSeedVal: (n: number) => `${n}`,
  resShadowWin: (d: number, r: number) =>
    `You beat the Shadow Rival! It covered ${d} m (Round ${r} synthesized pace — not a real replay.)`,
  resShadowLose: (d: number, diff: number, r: number) =>
    `The Shadow Rival covered ${d} m — you were ${diff} m short (Round ${r} synthesized pace — not a real replay.)`,
  resBirth: (block: number, lvText: string) =>
    `Score birth certificate: Squeekchain block ${block}${lvText}. Stored in game records; the day's champion is written into ScoreLedger at the next 00:00 UTC settlement.`,
  resBirthLv: (name: string, lv: number) => ` · settled as ${name} Lv${lv}`,
  resBest: (s: number) => `Your personal best is ${s} pts`,
  resPreviewNote:
    "This is a guest score and doesn't count on the official leaderboard. Connect a wallet and sign in, then run again to get ranked.",
  resRejected:
    "This run's input log didn't pass server validation, so the score wasn't recorded. Normal human-speed play never triggers this.",
  resSubmitFailed: (e: string) => `Score submission failed: ${e}`,
  resReplay: "Run Again",
  resConnect: "Connect Wallet · Sign In to Rank",

  runStartFailed: "Couldn't start the run",
  runContainerError: "The view container isn't ready",
  runGlError: "WebGL failed to initialise",
  runSubmitFailed: "Score submission failed",
  modelLoading: "Loading model",
  modelLoadFailed: "Model failed to load",
  modelRetry: "Retry",
  glScreenTitle: "The 3D view couldn't start",
  viewportAria: "3D hamster runner track: the hamster runs forward across three lanes",
  hudScore: "Score",
  hudDistance: "Distance",
  hudSeeds: "Seeds",
  hudSpeed: "Speed",
  hudShield: (n: number) => (n > 1 ? `Shield ×${n}` : "Shield"),
  hudMagnet: (s: number) => `Magnet ${s}s`,
  hudFlight: (s: number) => `Jetpack ${s}s`,
  hudBoost: (s: number) => `Boost ${s}s`,
  hudDouble: (s: number) => `Double ${s}s`,
  hudSneak: (s: number) => `Spring Shoes ${s}s`,
  hudSkillBoost: (s: number) => `Skill Boost ${s}s`,
  hudCharge: (n: number) => `Boost charge ${n}/30 seeds`,
  hudImpepe: (s: number) => `impepe ${s}s`,
  hudImpepeCharge: (n: number, th: number) => `impepe charge ${n}/${th} seeds`,
  hudShadowAhead: (r: number, d: number) => `Ahead of Shadow Rival by ${d} m · Round ${r}`,
  hudShadowBehind: (r: number, d: number) => `Behind Shadow Rival by ${d} m · Round ${r}`,
  hudToFirst: (n: number) => `${n} pts behind #1`,
  hudFirst: "You're ahead of #1 for now",
  pauseAria: (paused: boolean) => (paused ? "Resume" : "Pause"),
  pausedTitle: "Paused",
  pausedResume: "Keep Running",
  pausedQuit: "Quit This Run",
  flashCrash: "Crashed!",
  flashShield: "Shield blocked a hit!",
  flashPickup: (name: string) => `Picked up ${name}!`,
  padLeft: "Move left",
  padRight: "Move right",
  padSlide: "Slide",
  padJump: "Jump",
  padHint: "Swipe to move · up: jump · down: slide",
  padHintKeys: "Space / W: jump · A / D: move · S: slide",
  powers: {
    shield: "Shield",
    magnet: "Magnet",
    flight: "Jetpack",
    boost: "Boost Pad",
    double: "Double Points",
    sneak: "Spring Shoes",
  },

  muteAria: (muted: boolean) => (muted ? "Unmute background music" : "Mute background music"),
  musicOn: "Music on",
  musicOff: "Music off",
};

/** Server actions throw fixed Chinese messages; map the known ones to
 * English client-side so EN mode never surfaces Chinese error copy. The
 * server logic itself is untouched. */
const SERVER_ERRORS_EN: Record<string, string> = {
  "没有待验证的签名挑战，请重新连接钱包": "No pending signature challenge — please reconnect your wallet",
  "签名挑战已过期，请重新连接钱包": "The signature challenge has expired — please reconnect your wallet",
  "签名验证失败：签名和钱包地址对不上": "Signature verification failed: the signature doesn't match the wallet address",
  "玩家创建失败": "Failed to create the player",
  "游客创建失败": "Failed to create the guest player",
  "游客模式不能 Mint，连接钱包后可用": "Guest mode can't mint — connect a wallet first",
  "登录已失效，请重新进入": "Your session has expired — please sign in again",
  "这只仓鼠还没解锁，先用已解锁的仓鼠累计里程吧":
    "This hamster isn't unlocked yet — build mileage with an unlocked hamster first",
  "仓鼠不存在": "That hamster doesn't exist",
  "这只仓鼠已经解锁了": "This hamster is already unlocked",
  "里程还没达标，暂时不能解锁这只仓鼠": "Mileage not reached yet — this hamster can't be unlocked for now",
  "这只仓鼠还没解锁，不能升级": "This hamster isn't unlocked yet, so it can't level up",
  "已经满级了": "Already at max level",
  "这只仓鼠的里程还没达标，暂时不能升级":
    "This hamster's mileage hasn't reached the threshold, so it can't level up yet",
  "还没发现这个角色，不能 mint": "This character hasn't been discovered yet, so it can't be minted",
  "总里程还没到 100,000 米，暂时不能 mint 这个角色":
    "Total mileage hasn't reached 100,000 m yet, so this character can't be minted for now",
  "链上暂时读不到，请稍后再试": "The chain can't be read right now — please try again in a bit",
  "签名服务暂时不可用，请稍后再试": "The mint couldn't be prepared — please try again in a bit",
  "这笔交易在链上失败了，Mint 没有完成": "That transaction failed on-chain, so the mint didn't complete",
  "这笔交易和本次 Mint 对不上，没有登记": "That transaction doesn't match this mint, so it wasn't recorded",
};

export function localizeError(message: string, lang: Lang): string {
  if (lang === "en") return SERVER_ERRORS_EN[message] ?? message;
  return message;
}

/** Relay theme names come from the server in Chinese; EN labels by index. */
export const THEME_NAMES_EN = ["Dawn Meadow", "Dusk Rooftops", "Starry Valley", "Snowy Pines"];

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Dict;
}

const LangContext = createContext<LangState>({ lang: "zh", setLang: () => undefined, t: zh });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() =>
    storageGet(LANG_KEY) === "en" ? "en" : "zh",
  );
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);
  const setLang = (l: Lang) => {
    storageSet(LANG_KEY, l);
    setLangState(l);
  };
  return (
    <LangContext.Provider value={{ lang, setLang, t: lang === "zh" ? zh : en }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang(): LangState {
  return useContext(LangContext);
}

/** Segmented 中文 / EN switch. Default styling is the light pill used on the hero/HUD;
 * pass className to restyle the shell. */
export function LangToggle({ className }: { className?: string }) {
  const { lang, setLang, t } = useLang();
  const seg = (active: boolean) =>
    `px-2.5 py-1 ${active ? "bg-[var(--accent)] text-white" : "text-[#5a6b58]"}`;
  return (
    <div
      role="group"
      aria-label={t.langSwitchAria}
      className={
        className ??
        "flex items-center overflow-hidden rounded-full border border-[#e2ead8] bg-white/90 text-xs font-bold shadow-[0_4px_14px_rgba(60,90,50,0.16)]"
      }
    >
      <button type="button" aria-pressed={lang === "zh"} onClick={() => setLang("zh")} className={seg(lang === "zh")}>
        中文
      </button>
      <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")} className={seg(lang === "en")}>
        EN
      </button>
    </div>
  );
}
