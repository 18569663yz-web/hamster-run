import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import { CHARACTERS, IMDPEPE_META, HamsterFace, charById, charText } from "./characters";
import { LangToggle, THEME_NAMES_EN, localizeError, useLang } from "./i18n";
import {
Runner,
getCharacterModelError,
getCharacterModelState,
preloadCharacterModel,
subscribeCharacterModel,
type GhostInfo,
type RunOutcome,
} from "./Runner";
import { DocsPage } from "./Docs";
import { music } from "./music";
import { storageGet, storageRemove, storageSet } from "./storage";
import { MuteButton } from "./MuteButton";
import heroImg from "./assets/hero-meadow.webp";
import metamaskIcon from "./assets/wallet-metamask.jpg";
import okxIcon from "./assets/wallet-okx.jpg";
import tokenpocketIcon from "./assets/wallet-tokenpocket.jpg";

type Player = ApiResponse<typeof api, "me">["player"];
type BoardEntry = ApiResponse<typeof api, "leaderboard">["entries"][number];

const TOKEN_KEY = "hamster-run-token";

/* Tiers rescaled for the §1.5 scoring (score ≈ 8 × distance): a normal
 * 60–90s run lands ~6,000–10,000; 王者 needs a 1700+ unit expert run. */
export const TIERS = [
  { name: "王者", nameEn: "King", min: 32000, color: "#8a5a00", bg: "#ffe9a8" },
  { name: "黄金", nameEn: "Gold", min: 18000, color: "#8a5a00", bg: "#ffedb5" },
  { name: "白银", nameEn: "Silver", min: 8000, color: "#4a5a66", bg: "#e8eef2" },
  { name: "青铜", nameEn: "Bronze", min: 2000, color: "#8a4a1f", bg: "#fde8d8" },
];

export function tierFor(score: number) {
  return TIERS.find((t) => score >= t.min) ?? null;
}

/** Metre display: thresholds are round thousands, current mileage gets
 * decimals only while it is small. */
export function fmtM(m: number): string {
  if (m >= 100) return Math.round(m).toLocaleString("en-US");
  if (m >= 1) return (Math.round(m * 10) / 10).toString();
  return (Math.round(m * 100) / 100).toString();
}

/** Kilometres of new SQUEEKTOSHI distance per relay theme unlock —
 * mirrors the server's RELAY_STEP_KM (server/src/actions.ts); the server
 * stays authoritative for nextMilestoneKm / unlockedThemes. */
export const RELAY_STEP_KM = 100;

/** Unlock thresholds (metres of account total mileage) — display fallback
 * for the logged-out view; the server is authoritative once signed in. */
export const UNLOCK_M_DISPLAY: Record<string, number> = {
  xueqiu: 2000,
  meiqiu: 5000,
  huasheng: 10000,
  zhima: 20000,
  imdpepe: 100000,
};

export function LockIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <rect x="5" y="10" width="14" height="10" rx="2" fill="currentColor" />
      <path d="M8 10V7a4 4 0 018 0v3" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="12" cy="15" r="1.8" fill="#fff8e7" />
    </svg>
  );
}

/* ------------------------------ wallet plumbing ------------------------------ */

interface EthProvider {
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
  isMetaMask?: boolean;
  isOkxWallet?: boolean;
  isTokenPocket?: boolean;
  isCoinbaseWallet?: boolean;
  providers?: EthProvider[];
}

declare global {
  interface Window {
    ethereum?: EthProvider;
    okxwallet?: { ethereum?: EthProvider } | EthProvider;
    tokenpocket?: { ethereum?: EthProvider } | EthProvider;
  }
}

/* EIP-6963 wallet discovery — the ONLY primary detection path.
 * Wallets announce themselves with a reverse-DNS id (rdns); we match
 * that exactly per brand instead of guessing from window.ethereum,
 * which every injected wallet (OKX, Bitlight, …) also sets — the old
 * guessing misreported an absent MetaMask as installed and missed
 * the actually-installed OKX. Central rdns mapping: */
export const WALLET_RDNS: Record<string, string> = {
  metamask: "io.metamask",
  okx: "com.okx.wallet",
  tokenpocket: "pro.tokenpocket",
};

interface Eip6963ProviderDetail {
  info?: { rdns?: string; name?: string; uuid?: string };
  provider?: EthProvider;
}

const announcedProviders = new Map<string, EthProvider>();
const walletDiscoveryListeners = new Set<() => void>();

function notifyWalletDiscovery() {
  for (const cb of [...walletDiscoveryListeners]) cb();
}

function handleEip6963Announce(event: Event) {
  const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
  const rdns = detail?.info?.rdns;
  const provider = detail?.provider;
  if (!rdns || !provider || typeof provider.request !== "function") return;
  announcedProviders.set(rdns, provider);
  notifyWalletDiscovery();
}

let eip6963Listening = false;
export function ensureEip6963Listening() {
  if (typeof window === "undefined" || eip6963Listening) return;
  eip6963Listening = true;
  window.addEventListener("eip6963:announceProvider", handleEip6963Announce);
}
ensureEip6963Listening();

export function requestEip6963Providers() {
  if (typeof window === "undefined") return;
  ensureEip6963Listening();
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function subscribeWalletDiscovery(cb: () => void) {
  ensureEip6963Listening();
  walletDiscoveryListeners.add(cb);
  return () => {
    walletDiscoveryListeners.delete(cb);
  };
}

export function getAnnouncedProvider(walletId: string): EthProvider | null {
  const rdns = WALLET_RDNS[walletId];
  return rdns ? (announcedProviders.get(rdns) ?? null) : null;
}

function asProvider(candidate: unknown): EthProvider | null {
  if (candidate && typeof (candidate as EthProvider).request === "function") {
    return candidate as EthProvider;
  }
  return null;
}

/** A wallet's dedicated global holds either the provider itself or an
 * object wrapping it as `.ethereum` — accept both shapes. */
function dedicatedGlobalProvider(globalObj: unknown): EthProvider | null {
  if (!globalObj) return null;
  const nested = (globalObj as { ethereum?: unknown }).ethereum;
  return asProvider(nested) ?? asProvider(globalObj);
}

function allInjectedCandidates(): EthProvider[] {
  const list: EthProvider[] = [];
  const eth = window.ethereum;
  if (eth) {
    if (Array.isArray(eth.providers)) list.push(...eth.providers);
    list.push(eth);
  }
  const okx = dedicatedGlobalProvider(window.okxwallet);
  if (okx && !list.includes(okx)) list.push(okx);
  const tp = dedicatedGlobalProvider(window.tokenpocket);
  if (tp && !list.includes(tp)) list.push(tp);
  return list;
}

/** Fallback ONLY when EIP-6963 announced nothing for this wallet:
 * each brand's own dedicated global, plus per-provider identity
 * checks. MetaMask in particular may NOT be claimed from a bare
 * `window.ethereum` / `isMetaMask` flag — other wallets set that flag
 * for compatibility — so every candidate in the providers array is
 * checked individually and any candidate that is another wallet's
 * provider (by flag or by dedicated-global identity) is excluded. */
export function fallbackProviderFor(walletId: string): EthProvider | null {
  if (typeof window === "undefined") return null;
  if (walletId === "okx") {
    const dedicated = dedicatedGlobalProvider(window.okxwallet);
    if (dedicated) return dedicated;
    return allInjectedCandidates().find((p) => p.isOkxWallet === true) ?? null;
  }
  if (walletId === "tokenpocket") {
    const dedicated = dedicatedGlobalProvider(window.tokenpocket);
    if (dedicated) return dedicated;
    return allInjectedCandidates().find((p) => p.isTokenPocket === true) ?? null;
  }
  if (walletId === "metamask") {
    const okxProvider = dedicatedGlobalProvider(window.okxwallet);
    const tpProvider = dedicatedGlobalProvider(window.tokenpocket);
    const eth = window.ethereum;
    if (!eth) return null;
    const candidates =
      Array.isArray(eth.providers) && eth.providers.length > 0 ? eth.providers : [eth];
    for (const p of candidates) {
      if (!p || p.isMetaMask !== true) continue;
      if (p.isOkxWallet === true || p.isTokenPocket === true || p.isCoinbaseWallet === true) continue;
      if (okxProvider && p === okxProvider) continue;
      if (tpProvider && p === tpProvider) continue;
      return p;
    }
    return null;
  }
  return null;
}

/** The selected wallet's OWN provider: EIP-6963 announcement first,
 * dedicated-global fallback second. Never a guessed window.ethereum. */
export function resolveWalletProvider(walletId: string): EthProvider | null {
  return getAnnouncedProvider(walletId) ?? fallbackProviderFor(walletId);
}

export function snapshotWalletProviders(): Record<string, EthProvider | null> {
  return {
    metamask: resolveWalletProvider("metamask"),
    okx: resolveWalletProvider("okx"),
    tokenpocket: resolveWalletProvider("tokenpocket"),
  };
}

/** Re-runs discovery and briefly waits for announcements to land —
 * wallet injection is asynchronous, so a page-load snapshot is stale
 * by the time the sheet opens. */
export async function discoverWalletProviders(
  waitMs = 350,
): Promise<Record<string, EthProvider | null>> {
  requestEip6963Providers();
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
    requestEip6963Providers();
  }
  return snapshotWalletProviders();
}

interface WalletDef {
  id: string;
  name: string;
  sub: string;
  subEn: string;
  download: string;
  rdns: string;
  getProvider: () => EthProvider | null;
  /** Official app icon artwork (the brands' own App Store icons), bundled
   * locally — never a hand-drawn imitation. */
  icon: string;
}

const WALLETS: WalletDef[] = [
  {
    id: "metamask",
    name: "MetaMask",
    sub: "小狐狸钱包",
    subEn: "The fox wallet",
    download: "https://metamask.io/download/",
    rdns: WALLET_RDNS["metamask"]!,
    getProvider: () => resolveWalletProvider("metamask"),
    icon: metamaskIcon,
  },
  {
    id: "okx",
    name: "OKX Wallet",
    sub: "欧易钱包",
    subEn: "OKX exchange wallet",
    download: "https://www.okx.com/web3",
    rdns: WALLET_RDNS["okx"]!,
    getProvider: () => resolveWalletProvider("okx"),
    icon: okxIcon,
  },
  {
    id: "tokenpocket",
    name: "TokenPocket",
    sub: "TP 钱包",
    subEn: "TP Wallet",
    download: "https://www.tokenpocket.pro/",
    rdns: WALLET_RDNS["tokenpocket"]!,
    getProvider: () => resolveWalletProvider("tokenpocket"),
    icon: tokenpocketIcon,
  },
];

/** EIP-191 personal_sign takes the message as a hex string of its UTF-8
 * bytes. Some injected wallets also accept raw text, but strict wallets
 * expect the hex form. The wallet decodes the hex back to the original
 * bytes before signing, so server-side recovery is unchanged. */
export function toHexUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** HamsterNFT v2 on Sepolia — the one contract the Mint button pays. */
export const HAMSTER_NFT_V2 = "0x15601070312Fd8071d11B6Bd2606B2A5D9ec620b";
/** Function selector of mint(uint8,uint256,bytes) on HamsterNFT v2. */
export const MINT_SELECTOR = "0x75e7e053";
/** 0.01 ETH in wei, hex — the exact mint price the contract requires. */
export const MINT_VALUE_HEX = "0x2386f26fc10000";
export const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7"; // 11155111

/** ABI-encodes the HamsterNFT v2 mint call:
 *  mint(species: uint8, deadline: uint256, serverSig: bytes). */
export function encodeMintCalldata(species: number, deadline: number, signature: string): string {
  const word = (v: number) => v.toString(16).padStart(64, "0");
  const sig = signature.startsWith("0x") ? signature.slice(2) : signature;
  const sigPadded = sig.padEnd(Math.ceil(sig.length / 64) * 64, "0");
  return MINT_SELECTOR + word(species) + word(deadline) + word(96) + word(sig.length / 2) + sigPadded;
}

export function shortHash(hash: string): string {
  return hash.length > 18 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
}

/** Sentinel message for a sign request that produced no answer in time. */
export const SIGN_TIMEOUT = "SIGN_REQUEST_TIMEOUT";

/** How long sign-in waits for a wallet signature before giving up, so
 * a lost wallet response cannot leave the page waiting forever. */
export const SIGN_TIMEOUT_MS = 100_000;

/** Races a wallet request against SIGN_TIMEOUT_MS. The loser's late
 * settlement is swallowed so it cannot surface as an unhandled rejection. */
export function withSignTimeout<T>(pending: Promise<T>): Promise<T> {
  const raced = Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(SIGN_TIMEOUT)), SIGN_TIMEOUT_MS);
    }),
  ]);
  pending.catch(() => undefined);
  return raced;
}

/* ---------------------------------- app ---------------------------------- */

export function App() {
  const queryClient = useQueryClient();
  const { lang, t } = useLang();
  const [token, setToken] = useState<string | null>(() => storageGet(TOKEN_KEY));
  const [player, setPlayer] = useState<Player>(null);
  const [screen, setScreen] = useState<"lobby" | "game" | "result" | "docs">("lobby");
  const [charId, setCharId] = useState("lizi");
  // GLB models are preloaded in the lobby: every character's file warms
  // up on mount, and the selected character's load state gates the start
  // button — a run only begins once its real model is ready, and a
  // failed load shows an explicit error + retry on the detail card
  // instead of ever substituting a stand-in model
  useEffect(() => {
    for (const id of ["lizi", "xueqiu", "meiqiu", "huasheng", "zhima", "imdpepe"]) {
      preloadCharacterModel(id);
    }
  }, []);
  useEffect(() => {
    preloadCharacterModel(charId);
  }, [charId]);
  const selModelState = useSyncExternalStore(
    (cb) => subscribeCharacterModel(charId, cb),
    () => getCharacterModelState(charId),
  );
  const selModelError = selModelState === "error" ? getCharacterModelError(charId) : null;
  const [nickname, setNickname] = useState("");
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletBusy, setWalletBusy] = useState<string | null>(null);
  const [walletMsg, setWalletMsg] = useState<string | null>(null);
  /* EIP-6963 discovery results for the wallet sheet — refreshed every
   * time the sheet opens (injection is async; a page-load snapshot
   * goes stale) and updated live while announcements arrive. */
  const [walletProviders, setWalletProviders] = useState<Record<string, EthProvider | null>>({});
  useEffect(() => {
    if (!walletOpen) return;
    setWalletProviders(snapshotWalletProviders());
    const unsubscribe = subscribeWalletDiscovery(() => {
      setWalletProviders(snapshotWalletProviders());
    });
    requestEip6963Providers();
    const t1 = window.setTimeout(() => {
      requestEip6963Providers();
      setWalletProviders(snapshotWalletProviders());
    }, 120);
    const t2 = window.setTimeout(() => {
      requestEip6963Providers();
      setWalletProviders(snapshotWalletProviders());
    }, 400);
    return () => {
      unsubscribe();
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [walletOpen]);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [gameKey, setGameKey] = useState(0);
  const [ghostOn, setGhostOn] = useState(true);
  /* hidden character imdpepe: seven consecutive taps on the Shadow Rival
   * card reveal it (server records the discovery per account) */
  const shadowTapsRef = useRef<{ count: number; last: number }>({ count: 0, last: 0 });
  const [joinedToast, setJoinedToast] = useState(false);
  const [imdpepeSeenLocal, setImdpepeSeenLocal] = useState(false);
  /* second easter egg (independent from the 7-tap discovery): tapping
   * imdpepe himself 10 times anywhere he appears in the picker drags
   * the player to https://imd.fun */
  const frogTapsRef = useRef(0);
  const [frogEgg, setFrogEgg] = useState(false);
  const handleFrogTap = () => {
    // Guests get no hidden-character easter eggs at all.
    if (player?.isPreview) return;
    if (frogEgg) return;
    frogTapsRef.current += 1;
    if (frogTapsRef.current >= 10) {
      frogTapsRef.current = 0;
      setFrogEgg(true);
      window.setTimeout(() => {
        window.location.href = "https://imd.fun";
      }, 1800);
    }
  };

  const board = useQuery({
    queryKey: ["leaderboard"],
    queryFn: () => api.leaderboard({ limit: 30 }),
  });
  const dailyBoard = useQuery({
    queryKey: ["dailyBoard"],
    queryFn: () => api.dailyBoard({}),
  });
  const ghostBest = board.data?.entries[0]?.score ?? 0;
  const dailyTrack = useQuery({
    queryKey: ["dailyTrack"],
    queryFn: () => api.getDailyTrack({}),
  });
  const relay = useQuery({
    queryKey: ["relay"],
    queryFn: () => api.getRelay({}),
  });
  const ghost = useQuery({
    queryKey: ["ghost"],
    queryFn: () => api.getGhost({}),
  });
  const progression = useQuery({
    queryKey: ["progression", token],
    queryFn: () => api.getProgression({ token: token! }),
    enabled: !!token,
  });
  const chainHamsters = useQuery({
    queryKey: ["chainHamsters", token],
    queryFn: () => api.getChainHamsters({ token: token! }),
    enabled: !!token && !!player && !player.isPreview,
  });
  const champion = useQuery({
    queryKey: ["yesterdayChampion"],
    queryFn: () => api.getYesterdayChampion({}),
  });
  const [mintModal, setMintModal] = useState(false);
  const progById: Record<string, NonNullable<typeof progression.data>["hamsters"][number]> = {};
  for (const h of progression.data?.hamsters ?? []) progById[h.characterId] = h;
  const levels: Record<string, number> = {};
  for (const h of progression.data?.hamsters ?? []) levels[h.characterId] = h.level;
  const totalM = progression.data?.totalM ?? 0;
  const mintPrice = progression.data?.mintPriceEth ?? "0.01";
  const chainLevels: Record<string, number> = {};
  for (const h of chainHamsters.data?.hamsters ?? []) chainLevels[h.characterId] = h.chainLevel;
  const chainReady = chainHamsters.data?.available ?? false;
  const selChainLevel = chainLevels[charId] ?? 0;
  /** settlement level mirrors the server rule: chain level wins when held */
  const selLevel = selChainLevel > 0 ? selChainLevel : (levels[charId] ?? 1);
  const themeIndex = (relay.data?.unlockedThemes ?? 1) - 1;
  const ghostInfo: GhostInfo | null =
    ghostOn && ghost.data?.available
      ? { round: ghost.data.round, work: ghost.data.work, factor: ghost.data.factor }
      : null;

  /* one-click mint: a single button — the server authorisation happens
   * in the background, the wallet asks for exactly one confirmation */
  const [mintPhase, setMintPhase] = useState<"idle" | "processing" | "confirming" | "success" | "error">("idle");
  const [mintTxHash, setMintTxHash] = useState<string | null>(null);
  const [mintRegistered, setMintRegistered] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  /** Hash whose confirmation loop is currently authoritative for the
   *  modal — a stale loop for an earlier mint must not move the UI. */
  const mintPendingHashRef = useRef<string | null>(null);

  const openMint = () => {
    setMintPhase("idle");
    setMintTxHash(null);
    mintPendingHashRef.current = null;
    setMintRegistered(false);
    setMintError(null);
    setMintModal(true);
  };

  const closeMint = () => {
    setMintModal(false);
    if (mintPhase === "success") {
      queryClient.invalidateQueries({ queryKey: ["progression"] });
      queryClient.invalidateQueries({ queryKey: ["chainHamsters"] });
    }
  };

  /** After the wallet has sent the mint, success is only shown once the
   *  server has verified the on-chain receipt (confirmMint): a reverted
   *  transaction flips the modal to a plain-language error instead of
   *  ever reading as a successful mint. */
  const confirmMintAndSettle = (hash: string, kind: "unlock" | "levelup", forCharId: string) => {
    void (async () => {
      for (let i = 0; i < 20; i++) {
        try {
          const r = await api.confirmMint({
            token: token!,
            characterId: forCharId as "lizi" | "xueqiu" | "meiqiu" | "huasheng" | "zhima" | "imdpepe",
            kind,
            txHash: hash,
          });
          if (r.confirmed) {
            queryClient.invalidateQueries({ queryKey: ["progression"] });
            queryClient.invalidateQueries({ queryKey: ["chainHamsters"] });
            if (mintPendingHashRef.current === hash) setMintPhase("success");
            return;
          }
        } catch (e) {
          // receipt exists but the mint failed / doesn't match
          if (mintPendingHashRef.current === hash) {
            setMintError(describeMintError(e));
            setMintPhase("error");
          }
          return;
        }
        await new Promise((res) => setTimeout(res, 3000));
      }
      if (mintPendingHashRef.current === hash) {
        setMintError(t.mintConfirmSlow);
        setMintPhase("error");
      }
    })();
  };

  const describeMintError = (e: unknown): string => {
    const err = e as { code?: number; message?: string } | null;
    if (err?.code === 4001) return t.mintErrCancelled;
    const msg = err?.message ?? "";
    if (/user (rejected|denied)|rejected the request/i.test(msg)) return t.mintErrCancelled;
    if (msg) {
      const localized = localizeError(msg, lang);
      if (localized !== msg) return localized;
      if (lang === "zh" && /[\u4e00-\u9fff]/.test(msg)) return msg;
    }
    return t.mintErrGeneric;
  };

  const handleMintClick = async () => {
    if (!player || !token || mintPhase === "processing") return;
    const kind: "unlock" | "levelup" = selUnlocked ? "levelup" : "unlock";
    setMintPhase("processing");
    setMintError(null);
    try {
      // background step the player never sees: eligibility + signature
      const auth = await api.getMintAuthorization({
        token,
        characterId: charId as "lizi" | "xueqiu" | "meiqiu" | "huasheng" | "zhima" | "imdpepe",
        kind,
      });
      if (auth.mode === "registered" || !auth.contract || auth.species === null || auth.deadline === null || !auth.signature) {
        // imdpepe: in-game registration only (guests never reach mint)
        setMintRegistered(true);
        setMintPhase("success");
        queryClient.invalidateQueries({ queryKey: ["progression"] });
        return;
      }
      let provider: EthProvider | null = null;
      for (const w of WALLETS) {
        provider = w.getProvider();
        if (provider) break;
      }
      if (!provider) {
        setMintError(t.mintErrNoWallet);
        setMintPhase("error");
        return;
      }
      const chainId = (await provider.request({ method: "eth_chainId" })) as string;
      if (chainId !== SEPOLIA_CHAIN_ID_HEX) {
        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
          });
        } catch {
          setMintError(t.mintErrChain);
          setMintPhase("error");
          return;
        }
      }
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const from = accounts[0];
      if (!from) {
        setMintError(t.mintErrNoWallet);
        setMintPhase("error");
        return;
      }
      // the one and only wallet confirmation
      const hash = (await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from,
            to: auth.contract,
            value: MINT_VALUE_HEX,
            data: encodeMintCalldata(auth.species, auth.deadline, auth.signature),
          },
        ],
      })) as string;
      setMintTxHash(hash);
      mintPendingHashRef.current = hash;
      setMintPhase("confirming");
      confirmMintAndSettle(hash, kind, charId);
    } catch (e) {
      setMintError(describeMintError(e));
      setMintPhase("error");
    }
  };

  const discoverMutation = useMutation({
    mutationFn: () => api.discoverImdpepe({ token: token! }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["progression"] }),
  });
  const imdpepeDiscovered =
    !player?.isPreview &&
    ((progression.data?.imdpepeDiscovered ?? false) || imdpepeSeenLocal);
  // discovered while logged out → record it server-side once signed in
  useEffect(() => {
    if (
      token &&
      !player?.isPreview &&
      imdpepeSeenLocal &&
      progression.data &&
      !progression.data.imdpepeDiscovered &&
      !discoverMutation.isPending
    ) {
      discoverMutation.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, imdpepeSeenLocal, progression.data?.imdpepeDiscovered]);

  const handleShadowTap = () => {
    // Guest mode: no discovery easter egg — imdpepe stays "???".
    if (player?.isPreview) return;
    if (imdpepeDiscovered) return;
    const now = Date.now();
    const st = shadowTapsRef.current;
    st.count = now - st.last > 3000 ? 1 : st.count + 1;
    st.last = now;
    if (st.count >= 7) {
      st.count = 0;
      setImdpepeSeenLocal(true);
      setJoinedToast(true);
      window.setTimeout(() => setJoinedToast(false), 4200);
      if (token) discoverMutation.mutate();
    }
  };

  // background music: B (木琴微风) in the lobby, C (电子驱动) during a run
  useEffect(() => {
    const unlock = () => music.unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
  useEffect(() => {
    music.setScene(screen === "game" ? "game" : screen === "result" ? "result" : "lobby");
  }, [screen]);

  useEffect(() => {
    if (!token) {
      setPlayer(null);
      return;
    }
    let cancelled = false;
    api
      .me({ token })
      .then((res) => {
        if (cancelled) return;
        if (res.player) setPlayer(res.player);
        else {
          storageRemove(TOKEN_KEY);
          setToken(null);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token]);

  const previewMutation = useMutation({
    mutationFn: () => api.startPreview({ name: nickname.trim() || undefined }),
    onSuccess: (res) => {
      storageSet(TOKEN_KEY, res.token);
      setToken(res.token);
      setPlayer(res.player);
      // Guest mode only ever plays the base hamster.
      setCharId("lizi");
      setImdpepeSeenLocal(false);
    },
  });

  const closeWalletModal = () => setWalletOpen(false);

  const adoptSession = (tok: string, p: NonNullable<Player>) => {
    storageSet(TOKEN_KEY, tok);
    setToken(tok);
    setPlayer(p);
    setWalletOpen(false);
    queryClient.invalidateQueries({ queryKey: ["leaderboard"] });
    queryClient.invalidateQueries({ queryKey: ["dailyBoard"] });
  };

  /** Maps a sign-in failure to display copy, translating the local
   * timeout sentinel instead of leaking it raw. */
  const describeSignError = (e: unknown): string => {
    if (e instanceof Error && e.message === SIGN_TIMEOUT) return t.signTimeout;
    return e instanceof Error ? localizeError(e.message, lang) : t.signFailed;
  };

  /** Injected-wallet sign-in: EIP-191 personal_sign against the server
   * challenge, verified server-side. The message goes out hex-encoded
   * (see toHexUtf8) and the sign request is time-boxed (see
   * withSignTimeout) so it cannot wait forever. */
  const signInWithRequest = async (request: EthProvider["request"]) => {
    const accounts = (await request({ method: "eth_requestAccounts" })) as string[];
    const address = accounts[0];
    if (!address) throw new Error(t.walletNoAddress);
    const { message } = await api.getChallenge({ address });
    const signature = (await withSignTimeout(
      request({
        method: "personal_sign",
        params: [toHexUtf8(message), address],
      }) as Promise<unknown>,
    )) as string;
    const res = await api.verifySignature({
      address,
      signature,
      name: nickname.trim() || undefined,
    });
    adoptSession(res.token, res.player);
  };

  const connectWallet = async (w: WalletDef) => {
    setWalletMsg(null);
    /* Re-discover at click time and use ONLY this wallet's own
     * provider object — the sign request and the busy state both
     * belong to the row that was actually clicked. */
    const discovered = await discoverWalletProviders(250);
    setWalletProviders(discovered);
    const provider = discovered[w.id] ?? resolveWalletProvider(w.id);
    if (!provider) {
      window.open(w.download, "_blank", "noopener");
      setWalletMsg(t.walletNotFound(w.name));
      return;
    }
    setWalletBusy(w.id);
    try {
      await signInWithRequest((args) => provider.request(args));
    } catch (e) {
      setWalletMsg(describeSignError(e));
    } finally {
      setWalletBusy(null);
    }
  };

  const logout = () => {
    storageRemove(TOKEN_KEY);
    setToken(null);
    setPlayer(null);
    setScreen("lobby");
  };

  const startGame = () => {
    if (!selUnlocked) return;
    // the model gate lives here in the lobby: a run never starts (and
    // the countdown never waits) until the character's GLB is ready
    if (selModelState !== "ready") return;
    setOutcome(null);
    setGameKey((k) => k + 1);
    setScreen("game");
  };

  const meta = charById(charId);
  const metaText = charText(meta, lang);
  const selProg = progById[charId];
  /** Playable = base hamster, or progression says unlocked (v2 holding).
   * Before login / while progression loads, only 栗子 counts as unlocked. */
  const selUnlocked = charId === "lizi" ? true : (selProg?.unlocked ?? false);
  const selThresholdM = selProg?.unlockThresholdM ?? UNLOCK_M_DISPLAY[charId] ?? 0;
  /** One-click mint modal state: eligible, and how many metres short.
   * Eligibility is mileage only — a stale registration (pendingMint)
   * never makes an under-threshold mint look ready. */
  const mintReady = selUnlocked
    ? (selProg?.levelUpReady ?? false)
    : selProg?.state === "eligible";
  const mintShortM = selUnlocked
    ? Math.max(0, (selProg?.levelUpThresholdM ?? 0) - (selProg?.ownM ?? 0))
    : Math.max(0, selThresholdM - totalM);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto flex min-h-screen w-full max-w-[430px] flex-col md:max-w-[680px] lg:max-w-[1060px]">
        {screen === "game" && token && (
          <Runner
            key={gameKey}
            token={token}
            characterId={charId}
            ghostBest={ghostBest}
            ghost={ghostInfo}
            themeIndex={themeIndex}
            onFinish={(o) => {
              setOutcome(o);
              setScreen("result");
              queryClient.invalidateQueries({ queryKey: ["leaderboard"] });
    queryClient.invalidateQueries({ queryKey: ["dailyBoard"] });
              queryClient.invalidateQueries({ queryKey: ["progression"] });
              queryClient.invalidateQueries({ queryKey: ["chainHamsters"] });
            }}
            onExit={() => setScreen("lobby")}
          />
        )}

        {screen === "result" && outcome && (
          <ResultScreen
            outcome={outcome}
            player={player}
            characterId={charId}
            ghost={ghostInfo}
            onReplay={startGame}
            onLobby={() => setScreen("lobby")}
            onConnect={() => {
              setScreen("lobby");
              setWalletOpen(true);
            }}
          />
        )}

        {screen === "docs" && (
          <DocsPage
            live={{
              blockHeight:
                dailyTrack.data?.source === "squeekchain" ? dailyTrack.data.blockHeight : null,
              relayCurrentKm: relay.data?.available ? relay.data.currentKm : null,
              relayBaselineKm: relay.data?.available ? relay.data.baselineKm : null,
              relayGainedKm: relay.data?.available ? relay.data.gainedKm : null,
            }}
            onBack={() => setScreen("lobby")}
          />
        )}

        {screen === "lobby" && (
          <div className="px-4 pb-32 lg:px-6 lg:pb-36">
            {/* hero — full width on desktop, taller */}
            <div className="relative -mx-4 overflow-hidden lg:mx-0 lg:rounded-[var(--radius)]">
              <img
                src={heroImg}
                alt={t.heroAlt}
                className="h-44 w-full object-cover object-center md:h-56 lg:h-80"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/10 to-transparent" />
              <div className="absolute bottom-2 left-4 right-4">
                <h1 className="text-4xl font-extrabold tracking-wide text-white drop-shadow-[0_2px_10px_rgba(0,0,0,0.6)] lg:text-5xl">
                  {t.heroTitle}
                </h1>
                <p className="text-sm font-semibold text-[#ffec99]">
                  {t.heroSub}
                </p>
              </div>
              {player?.isPreview && (
                <span className="absolute left-3 top-3 rounded-full bg-[#e85d4f] px-3 py-1 text-xs font-bold text-white shadow-[0_4px_14px_rgba(60,90,50,0.16)]">
                  {t.testMode}
                </span>
              )}
              <div className="absolute right-3 top-3 flex items-center gap-2">
                <LangToggle />
                <MuteButton />
              </div>
            </div>

            <div className="mt-3.5 flex flex-col gap-3.5 lg:mt-5 lg:flex-row lg:items-start lg:gap-5">
              <div className="contents lg:flex lg:min-w-0 lg:flex-1 lg:flex-col lg:gap-5">
            {/* entry / player bar */}
            {player ? (
              <section aria-label={t.playerInfoAria} className="order-2 flex items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 lg:order-none">
                <HamsterFace meta={meta} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold">{player.name}</div>
                  {/* desktop (lg+): the original single-line subtitle,
                      address + chain holdings joined — unchanged */}
                  <div className="hidden truncate text-xs text-[var(--dim)] lg:block">
                    {player.isPreview
                      ? t.previewNote
                      : `${player.address.slice(0, 8)}…${player.address.slice(-6)} · ${
                          chainHamsters.isPending
                            ? t.chainReading
                            : chainReady
                              ? t.chainHeld(Object.values(chainLevels).filter((v) => v > 0).length, chainHamsters.data!.balance)
                              : t.chainUnavailable
                        }`}
                  </div>
                  {/* mobile (<lg): the chain-holdings text gets its own
                      line under the address so it is never truncated */}
                  <div className="lg:hidden">
                    {player.isPreview ? (
                      <div className="truncate text-xs text-[var(--dim)]">{t.previewNote}</div>
                    ) : (
                      <>
                        <div className="truncate text-xs text-[var(--dim)]">
                          {`${player.address.slice(0, 8)}…${player.address.slice(-6)}`}
                        </div>
                        <div className="text-xs text-[var(--dim)]">
                          {chainHamsters.isPending
                            ? t.chainReading
                            : chainReady
                              ? t.chainHeld(Object.values(chainLevels).filter((v) => v > 0).length, chainHamsters.data!.balance)
                              : t.chainUnavailable}
                        </div>
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={logout}
                  className="shrink-0 rounded-md border border-[#e2ead8] bg-[#f4f9ee] px-3.5 py-1.5 text-sm font-bold text-[var(--dim)]"
                >
                  {t.logout}
                </button>
              </section>
            ) : (
              <section aria-label={t.entryAria} className="order-2 flex flex-col gap-2.5 lg:order-none">
                <label className="flex items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                  <span className="shrink-0 text-sm font-bold text-[var(--dim)]">{t.nickname}</span>
                  <input
                    aria-label={t.nickname}
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    placeholder={t.nicknamePlaceholder}
                    maxLength={16}
                    className="w-full bg-transparent text-sm font-semibold text-[var(--text)] outline-none placeholder:text-[#9aa88f]"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setWalletMsg(null);
                    setWalletOpen(true);
                  }}
                  className="w-full rounded-[var(--radius)] bg-[var(--accent)] py-3.5 text-lg font-extrabold text-white shadow-[0_4px_14px_rgba(60,90,50,0.16)] active:scale-[0.99]"
                >
                  {t.connectWallet}
                </button>
                <button
                  type="button"
                  onClick={() => previewMutation.mutate()}
                  disabled={previewMutation.isPending}
                  className="w-full rounded-[var(--radius)] border-2 border-[#f0b429] bg-white py-3 text-base font-extrabold text-[#b97f00]"
                >
                  {previewMutation.isPending ? t.entering : t.testEntry}
                </button>
                <p className="text-center text-xs leading-relaxed text-[var(--dim)]">
                  {t.entryNote}
                </p>
              </section>
            )}

            {/* today's track + mileage relay */}
            <section aria-label={t.dailyTrackAria} className="order-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 lg:order-none">
              <div className="flex items-baseline justify-between">
                <h2 className="text-base font-extrabold">{t.todayTrack}</h2>
                <span className="font-display text-[10px] text-[var(--dim)]">{dailyTrack.data?.dayId ?? ""}（UTC）</span>
              </div>
              {dailyTrack.data ? (
                <p className="mt-1 text-sm leading-relaxed">
                  {dailyTrack.data.source === "squeekchain" ? (
                    <>
                      {t.trackFromA} <span className="font-display text-[11px] font-bold text-[#b97f00]">{t.trackBlock(dailyTrack.data.blockHeight)}</span>
                      {t.trackFromB}
                    </>
                  ) : (
                    <>{t.trackFallback}</>
                  )}
                </p>
              ) : (
                <p className="mt-1 text-sm text-[var(--dim)]">{t.trackLoading}</p>
              )}
              <div className="mt-3 border-t border-[#e6eee0] pt-3">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-extrabold">{t.relayTitle}</h3>
                  {relay.data?.available && (
                    <span className="font-display text-[10px] text-[var(--dim)]">
                      {t.relayTotal(relay.data.currentKm.toFixed(2))}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] font-bold text-[#2e6b30]">{t.relaySubtitle}</p>
                {relay.data?.available ? (
                  <>
                    <div
                      className="mt-2 h-2.5 overflow-hidden rounded-full bg-[#e3ecd9]"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={RELAY_STEP_KM}
                      aria-valuenow={Math.round((relay.data.gainedKm % RELAY_STEP_KM) * 100) / 100}
                      aria-label={t.relayProgressAria}
                    >
                      <div
                        className="h-full bg-[#58b368]"
                        style={{
                          width: `${Math.min(100, ((relay.data.gainedKm % RELAY_STEP_KM) / RELAY_STEP_KM) * 100)}%`,
                        }}
                      />
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
                      {t.relayText(relay.data.gainedKm.toFixed(2))}{" "}
                      <span className="font-display text-[10px] font-bold text-[#2e6b30]">
                        {t.relayStepProgress((relay.data.gainedKm % RELAY_STEP_KM).toFixed(2))}
                      </span>
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {relay.data.themes.map((themeName, i) => (
                        <span
                          key={themeName}
                          className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                            i < relay.data.unlockedThemes
                              ? "bg-[#e8f6df] text-[#2e6b30]"
                              : "bg-[#f4f9ee] text-[#7a8a72]"
                          }`}
                        >
                          {lang === "en" ? (THEME_NAMES_EN[i] ?? themeName) : themeName}
                          {i < relay.data.unlockedThemes ? "" : t.relayLocked}
                          {i === themeIndex && i < relay.data.unlockedThemes ? t.relayCurrent : ""}
                        </span>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="mt-1 text-xs text-[var(--dim)]">{t.relayUnavailable}</p>
                )}
              </div>
            </section>

            {/* my data — this account's server records + v2 chain holdings */}
            <section aria-label={t.myDataAria} className="order-6 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 lg:order-none">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-base font-extrabold">{t.myDataTitle}</h2>
                {player?.isPreview && (
                  <span className="rounded-full bg-[#e85d4f] px-2.5 py-1 text-[11px] font-bold text-white">
                    {t.myDataTestBadge}
                  </span>
                )}
              </div>
              {!player ? (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm text-[var(--dim)]">{t.myDataConnect}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setWalletMsg(null);
                      setWalletOpen(true);
                    }}
                    className="shrink-0 rounded-md border border-[#e2ead8] bg-[var(--accent)] px-3.5 py-1.5 text-xs font-extrabold text-white"
                  >
                    {t.myDataConnectBtn}
                  </button>
                </div>
              ) : progression.data ? (
                <>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    {(
                      [
                        [t.statMVal(fmtM(totalM)), t.statTotalM],
                        [String(progression.data.stats.runs), t.statRuns],
                        [String(progression.data.stats.bestScore), t.statBest],
                        [t.statDistVal(progression.data.stats.bestDistanceMeters), t.statFarthest],
                      ] as const
                    ).map(([value, label]) => (
                      <div key={label} className="rounded-xl bg-[#f4f9ee] px-1 py-2">
                        <div className="font-display truncate text-[11px] font-extrabold leading-5">{value}</div>
                        <div className="mt-0.5 text-[10px] font-bold text-[var(--dim)]">{label}</div>
                      </div>
                    ))}
                  </div>
                  <ul className="mt-2 flex flex-col divide-y divide-[#e6eee0]">
                    {[...CHARACTERS, ...(imdpepeDiscovered ? [IMDPEPE_META] : [])].map((c) => {
                      const prog = progById[c.id];
                      const ct = charText(c, lang);
                      const chainLv = chainLevels[c.id] ?? 0;
                      const effLevel = chainLv > 0 ? chainLv : (prog?.level ?? 1);
                      const unlocked = c.id === "lizi" ? true : (prog?.unlocked ?? false);
                      const threshold = prog?.unlockThresholdM ?? UNLOCK_M_DISPLAY[c.id] ?? 0;
                      const barPct = unlocked
                        ? effLevel >= 5
                          ? 100
                          : Math.round((prog?.levelUpProgress ?? 0) * 100)
                        : threshold > 0
                          ? Math.min(100, Math.round((totalM / threshold) * 100))
                          : 0;
                      const progressLabel = unlocked
                        ? effLevel >= 5
                          ? t.dataMaxLevel
                          : prog?.levelUpThresholdM
                            ? t.dataNextLevel(fmtM(prog.ownM), fmtM(prog.levelUpThresholdM), effLevel + 1)
                            : ""
                        : t.dataUnlockNext(fmtM(totalM), fmtM(threshold), ct.name);
                      return (
                        <li key={c.id} className="py-2">
                          <div className="flex items-center gap-2">
                            <HamsterFace meta={c} size={26} />
                            <span className="text-sm font-bold">{ct.name}</span>
                            <span className="text-[11px] font-semibold text-[var(--dim)]">Lv{effLevel}</span>
                            <span
                              className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                                unlocked ? "bg-[#e8f6df] text-[#2e6b30]" : "bg-[#e3ecd9] text-[#7a8a72]"
                              }`}
                            >
                              {unlocked
                                ? chainLv > 0
                                  ? t.dataHeldChain(chainLv)
                                  : t.dataUnlocked
                                : t.dataLocked}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-[var(--dim)]">
                            <span>{t.dataOwnM(fmtM(prog?.ownM ?? 0))}</span>
                            <span className="text-right font-semibold">{progressLabel}</span>
                          </div>
                          <div
                            className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#e3ecd9]"
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={barPct}
                            aria-label={progressLabel}
                          >
                            <div
                              className={`h-full ${unlocked ? "bg-[#58b368]" : "bg-[#f0b429]"}`}
                              style={{ width: `${barPct}%` }}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="mt-2 border-t border-[#e6eee0] pt-2.5">
                    {(() => {
                      const next = CHARACTERS.find(
                        (c) => c.id !== "lizi" && !(progById[c.id]?.unlocked ?? false),
                      );
                      if (!next) {
                        return (
                          <p className="text-[11px] font-bold text-[var(--dim)]">
                            {t.dataAccountProgress} · {t.dataAllUnlocked}
                          </p>
                        );
                      }
                      const th = progById[next.id]?.unlockThresholdM ?? UNLOCK_M_DISPLAY[next.id] ?? 0;
                      const pct = th > 0 ? Math.min(100, Math.round((totalM / th) * 100)) : 0;
                      return (
                        <>
                          <div className="flex items-center justify-between gap-2 text-[11px] font-bold">
                            <span>{t.dataAccountProgress}</span>
                            <span className="text-[var(--dim)]">
                              {t.dataUnlockNext(fmtM(totalM), fmtM(th), charText(next, lang).name)}
                            </span>
                          </div>
                          <div
                            className="mt-1.5 h-2 overflow-hidden rounded-full bg-[#e3ecd9]"
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={pct}
                            aria-label={t.dataAccountProgress}
                          >
                            <div className="h-full bg-[#f0b429]" style={{ width: `${pct}%` }} />
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </>
              ) : (
                <p className="text-sm text-[var(--dim)]">{t.loading}</p>
              )}
            </section>

            {/* how to play + items */}
            <section aria-label={t.howToAria} className="order-7 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 lg:order-none">
              <h2 className="mb-2 text-base font-extrabold">{t.howToTitle}</h2>
              <ul className="flex flex-col gap-1.5 text-sm font-medium">
                <li>{t.howTo1}</li>
                <li>{t.howTo2}</li>
                <li>{t.howTo3}</li>
              </ul>
              <h3 className="mb-2 mt-3.5 text-sm font-extrabold">{t.itemsTitle}</h3>
              <ul className="grid grid-cols-2 gap-2 text-sm font-medium">
                {t.items.map((item, i) => (
                  <li key={item.name} className="rounded-xl bg-[#f4f9ee] px-2.5 py-2">
                    <span
                      className="font-extrabold"
                      style={{ color: ["#2e9e5b", "#d84a4a", "#2a7fb8", "#b97f00", "#7a4fb0", "#3d8a4f"][i] }}
                    >
                      {item.name}
                    </span>{" "}
                    · {item.desc}
                  </li>
                ))}
              </ul>
            </section>

              </div>
              <div className="contents lg:flex lg:min-w-0 lg:flex-1 lg:flex-col lg:gap-5">
            {/* docs entry — lobby menu */}
            <button
              type="button"
              onClick={() => setScreen("docs")}
              aria-label={t.docsAria}
              className="order-1 flex w-full items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3 text-left shadow-[0_6px_20px_rgba(90,140,80,0.1)] lg:order-none"
            >
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#e8f6df] text-[#2e6b30]"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  />
                  <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  <path d="M9 13h6M9 17h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-extrabold leading-tight">
                  文档 / Docs
                </span>
                <span className="block truncate text-xs font-semibold text-[var(--dim)]">
                  {t.docsEntrySub}
                </span>
              </span>
              <span aria-hidden="true" className="shrink-0 text-xl font-extrabold text-[var(--dim)]">
                ›
              </span>
            </button>

            {/* shadow rival challenge */}
            <section aria-label={t.shadowAria} onClick={handleShadowTap} className="order-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 lg:order-none">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-extrabold">{t.shadowTitle}</h2>
                {ghost.data?.available && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={ghostOn}
                    aria-label={t.shadowSwitchAria}
                    onClick={(e) => {
                      e.stopPropagation();
                      setGhostOn((v) => !v);
                    }}
                    className={`rounded-full px-3 py-1.5 text-xs font-extrabold ${
                      ghostOn ? "bg-[#58b368] text-white" : "bg-[#e3ecd9] text-[var(--dim)]"
                    }`}
                  >
                    {t.shadowLabel} {ghostOn ? t.on : t.off}
                  </button>
                )}
              </div>
              {ghost.data?.available ? (
                <>
                  <p className="mt-1 text-sm leading-relaxed">
                    {t.shadowChallengeA} <span className="font-bold text-[#b97f00]">{t.shadowRound(ghost.data.round)}</span>
                    {lang === "zh" ? "——" : " — "}{t.shadowDisclaimer(ghost.data.work)}{lang === "zh" ? "。" : " "}{t.shadowBodyB}
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
                    {t.shadowNote(ghost.data.round)}
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-1.5" aria-label={t.shadowStatsAria}>
                    <span className="rounded-full bg-[#f4f9ee] px-2.5 py-1 text-[11px] font-bold text-[var(--dim)]">
                      {t.shadowStatRound(ghost.data.round)}
                    </span>
                    <span className="rounded-full bg-[#f4f9ee] px-2.5 py-1 text-[11px] font-bold text-[var(--dim)]">
                      {t.shadowStatWork(ghost.data.work)}
                    </span>
                    <span className="rounded-full bg-[#f4f9ee] px-2.5 py-1 text-[11px] font-bold text-[var(--dim)]">
                      {t.shadowStatPace(ghost.data.factor)}
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold ${
                        ghostOn ? "bg-[#e8f6df] text-[#2e6b30]" : "bg-[#e3ecd9] text-[#7a8a72]"
                      }`}
                    >
                      {ghostOn ? t.shadowStateOn : t.shadowStateOff}
                    </span>
                  </div>
                </>
              ) : (
                <p className="mt-1 text-sm text-[var(--dim)]">{t.shadowUnavailable}</p>
              )}
            </section>

            {/* character select — all five fit one row, no horizontal scroll */}
            <section aria-label={t.selectAria} className="order-5 lg:order-none">
              <h2 className="mb-2 text-base font-extrabold">{t.pickHamster}</h2>
              <div className="grid grid-cols-5 gap-1.5" role="listbox" aria-label={t.hamsterListAria}>
                {CHARACTERS.map((c) => {
                  const selected = c.id === charId;
                  const ct = charText(c, lang);
                  const prog = progById[c.id];
                  const unlocked = c.id === "lizi" ? true : (prog?.unlocked ?? false);
                  const threshold = prog?.unlockThresholdM ?? UNLOCK_M_DISPLAY[c.id] ?? 0;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={!!player?.isPreview && c.id !== "lizi"}
                      onClick={() => {
                        if (player?.isPreview && c.id !== "lizi") return;
                        setCharId(c.id);
                      }}
                      className={`relative flex min-w-0 flex-col items-center gap-0.5 rounded-2xl border-2 px-1 py-2 ${
                        selected
                          ? "border-[var(--accent)] bg-[#e8f6df]"
                          : "border-[var(--border)] bg-[var(--surface)]"
                      }`}
                    >
                      {!unlocked && (
                        <span className="absolute right-1 top-1 flex items-center gap-0.5 rounded-full bg-[#fff3c4] px-1.5 py-0.5 text-[8px] font-extrabold text-[#8a5a00]">
                          <LockIcon />
                          {t.lockBadge}
                        </span>
                      )}
                      <span className={unlocked ? "" : "opacity-55 grayscale"}>
                        <HamsterFace meta={c} size={36} />
                      </span>
                      <span className="max-w-full truncate text-[11px] font-extrabold leading-tight">{ct.name}</span>
                      {unlocked ? (
                        <span className="max-w-full truncate text-[9px] font-bold leading-tight text-[var(--dim)]">
                          Lv{(chainLevels[c.id] ?? 0) > 0 ? chainLevels[c.id] : (levels[c.id] ?? 1)} · {ct.trait}
                        </span>
                      ) : (
                        <span className="max-w-full truncate text-[8px] font-bold leading-tight tracking-tight text-[#b97f00]">
                          {player
                            ? `${fmtM(totalM)}/${fmtM(threshold)} ${lang === "en" ? "m" : "米"}`
                            : `${fmtM(threshold)} ${lang === "en" ? "m" : "米"}`}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* hidden character slot: silhouette until discovered,
                  then imdpepe's own card (never in the five-card row) */}
              {imdpepeDiscovered ? (
                <button
                  type="button"
                  aria-label={t.imdpepeCardAria}
                  aria-pressed={charId === "imdpepe"}
                  onClick={() => { setCharId("imdpepe"); handleFrogTap(); }}
                  className={`mt-1.5 flex w-full items-center gap-3 rounded-2xl border-2 px-3 py-2 text-left ${
                    charId === "imdpepe"
                      ? "border-[var(--accent)] bg-[#e8f6df]"
                      : "border-[var(--border)] bg-[var(--surface)]"
                  }`}
                >
                  <HamsterFace meta={IMDPEPE_META} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-extrabold leading-tight">imdpepe</span>
                    <span className="block truncate text-[10px] font-bold leading-tight text-[var(--dim)]">
                      {charText(IMDPEPE_META, lang).trait} · impepe
                    </span>
                  </span>
                  {(progById["imdpepe"]?.unlocked ?? false) ? (
                    <span className="shrink-0 text-[11px] font-extrabold text-[#2e6b30]">
                      Lv{levels["imdpepe"] ?? 1}
                    </span>
                  ) : (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] font-extrabold text-[#b97f00]">
                      <LockIcon />
                      {player
                        ? `${fmtM(totalM)}/${fmtM(100000)} ${lang === "en" ? "m" : "米"}`
                        : `${fmtM(100000)} ${lang === "en" ? "m" : "米"}`}
                    </span>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={t.imdpepeSilhouetteAria}
                  onClick={handleFrogTap}
                  className="mt-1.5 flex w-full cursor-pointer items-center gap-3 rounded-2xl border-2 border-dashed border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left"
                >
                  <HamsterFace meta={IMDPEPE_META} size={36} silhouette />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-extrabold leading-tight tracking-widest">???</span>
                    <span className="block truncate text-[10px] font-bold leading-tight text-[var(--dim)]">
                      {t.imdpepeHint}
                    </span>
                  </span>
                </button>
              )}

              {/* selected character detail card */}
              <div className="mt-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5">
                <div className="flex items-center gap-3">
                  {meta.id === "imdpepe" ? (
                    <button
                      type="button"
                      aria-label={t.imdpepeCardAria}
                      onClick={handleFrogTap}
                      className="cursor-pointer bg-transparent p-0"
                    >
                      <HamsterFace meta={meta} size={72} />
                    </button>
                  ) : (
                    <HamsterFace meta={meta} size={72} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xl font-extrabold">{metaText.name}</span>
                      <span
                        className="rounded-full px-2 py-0.5 text-[11px] font-extrabold text-[#14100a]"
                        style={{ background: meta.accent }}
                      >
                        {metaText.skillName}
                      </span>
                    </div>
                    <div className="text-xs font-semibold text-[var(--dim)]">{metaText.title}</div>
                    <div className="mt-1.5 flex items-center gap-1" aria-label={t.levelAria(selLevel)}>
                      {[1, 2, 3, 4, 5].map((lv) => (
                        <span
                          key={lv}
                          className={`h-2 w-6 rounded-sm ${lv <= selLevel ? "bg-[var(--accent)]" : "bg-[#e3ecd9]"}`}
                        />
                      ))}
                      <span className="ml-1 text-xs font-extrabold text-[#b97f00]">Lv{selLevel}</span>
                    </div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  {(
                    [
                      [t.statSpeed, meta.speed],
                      [t.statStamina, meta.stamina],
                      [t.statLuck, meta.luck],
                    ] as const
                  ).map(([label, v]) => (
                    <div key={label} className="rounded-xl bg-[#f4f9ee] px-2 py-1.5">
                      <div className="flex justify-center gap-0.5" aria-hidden="true">
                        {[1, 2, 3, 4, 5].map((i) => (
                          <span key={i} className={`h-1.5 w-3 rounded-sm ${i <= v ? "bg-[#58b368]" : "bg-[#e3ecd9]"}`} />
                        ))}
                      </div>
                      <div className="mt-0.5 text-[11px] font-bold text-[var(--dim)]">
                        {label} {v}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-2.5 text-sm leading-relaxed">{metaText.desc}</p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">{metaText.skillText}</p>
                {/* GLB model gate: loading is stated plainly, failure is an
                    explicit error with a retry — no stand-in model exists */}
                {selModelState === "loading" && (
                  <p className="mt-2 text-xs font-bold text-[var(--dim)]" role="status">
                    {t.modelLoading}…
                  </p>
                )}
                {selModelState === "error" && (
                  <div className="mt-3 rounded-xl bg-[#fdecea] px-3 py-2.5" role="alert">
                    <p className="text-xs font-extrabold text-[#b3352b]">{t.modelLoadFailed}</p>
                    {selModelError && (
                      <p className="mt-0.5 break-words text-[11px] leading-snug text-[#8a4a44]">
                        {selModelError}
                      </p>
                    )}
                    <button
                      type="button"
                      aria-label={t.modelRetry}
                      onClick={() => preloadCharacterModel(charId)}
                      className="mt-2 rounded-md bg-[#d84a3f] px-4 py-1.5 text-xs font-extrabold text-white active:scale-[0.98]"
                    >
                      {t.modelRetry}
                    </button>
                  </div>
                )}
                {/* progression gates (rules v2): locked hamsters show the
                    account-mileage unlock progress; unlocked ones show
                    their own-mileage level-up progress */}
                {!selUnlocked ? (
                  <div className="mt-3 rounded-xl bg-[#f4f9ee] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-xs font-extrabold text-[#b97f00]">
                        <LockIcon size={13} />
                        {t.lockBadge}
                      </span>
                      <span className="text-[11px] font-bold text-[var(--dim)]">
                        {player
                          ? t.unlockProgressLabel(fmtM(totalM), fmtM(selThresholdM))
                          : t.cardUnlockAt(fmtM(selThresholdM))}
                      </span>
                    </div>
                    <div
                      className="mt-2 h-2 overflow-hidden rounded-full bg-[#e3ecd9]"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(Math.min(100, selThresholdM > 0 ? (totalM / selThresholdM) * 100 : 0))}
                      aria-label={t.unlockProgressLabel(fmtM(totalM), fmtM(selThresholdM))}
                    >
                      <div
                        className="h-full bg-[#f0b429]"
                        style={{
                          width: `${selThresholdM > 0 ? Math.min(100, (totalM / selThresholdM) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold leading-relaxed text-[var(--dim)]">
                        {!player
                          ? t.loginToProgress
                          : player.isPreview
                            ? t.guestOnlyBase
                            : totalM >= selThresholdM
                              ? selProg?.state === "pending"
                                ? t.pendingPayment
                                : t.unlockReady
                              : t.unlockNotReady}
                      </span>
                      {player?.isPreview ? (
                        <span className="shrink-0 text-right text-[11px] font-extrabold text-[#b97f00]">
                          {t.guestNeedWallet}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => player && openMint()}
                          disabled={!player || totalM < selThresholdM}
                          className="shrink-0 rounded-md border border-[#e2ead8] bg-[var(--accent)] px-3.5 py-1.5 text-xs font-extrabold text-white disabled:opacity-40"
                        >
                          {t.mintUnlockBtn(mintPrice)}
                        </button>
                      )}
                    </div>
                  </div>
                ) : selProg && selLevel < 5 ? (
                  <div className="mt-3 rounded-xl bg-[#f4f9ee] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-xs font-extrabold text-[#2e6b30]">
                        {t.levelUpBadge(selLevel + 1)}
                      </span>
                      <span className="text-[11px] font-bold text-[var(--dim)]">
                        {player
                          ? t.levelUpOwnLabel(fmtM(selProg.ownM), fmtM(selProg.levelUpThresholdM ?? 0))
                          : t.levelUpProgressLabel(
                              fmtM(selProg.ownM),
                              fmtM(selProg.levelUpThresholdM ?? 0),
                              selLevel + 1,
                            )}
                      </span>
                    </div>
                    <div
                      className="mt-2 h-2 overflow-hidden rounded-full bg-[#e3ecd9]"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(selProg.levelUpProgress * 100)}
                      aria-label={t.levelUpProgressLabel(
                        fmtM(selProg.ownM),
                        fmtM(selProg.levelUpThresholdM ?? 0),
                        selLevel + 1,
                      )}
                    >
                      <div
                        className="h-full bg-[#58b368]"
                        style={{ width: `${selProg.levelUpProgress * 100}%` }}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold leading-relaxed text-[var(--dim)]">
                        {!player
                          ? t.loginToProgress
                          : player.isPreview
                            ? t.guestNeedWallet
                            : selProg.levelUpReady
                              ? selProg.pendingMint
                                ? t.pendingPayment
                                : t.levelUpReadyText(selLevel + 1)
                              : t.levelUpNotReady}
                      </span>
                      {player?.isPreview ? (
                        <span className="shrink-0 text-right text-[11px] font-extrabold text-[#b97f00]">
                          {t.guestNeedWallet}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => player && openMint()}
                          disabled={!player || !selProg.levelUpReady}
                          className="shrink-0 rounded-md border border-[#e2ead8] bg-[var(--accent)] px-3.5 py-1.5 text-xs font-extrabold text-white disabled:opacity-40"
                        >
                          {t.mintUpgradeBtn(mintPrice, selLevel + 1)}
                        </button>
                      )}
                    </div>
                  </div>
                ) : selProg ? (
                  <p className="mt-3 text-xs font-bold text-[var(--dim)]">{t.maxLevel}</p>
                ) : null}
                {player && !player.isPreview && charId !== "imdpepe" && (
                  <p className="mt-2.5 text-[11px] font-semibold leading-relaxed text-[var(--dim)]">
                    {t.chainHoldLabel}
                    {chainHamsters.isPending
                      ? t.chainHoldReading
                      : !chainReady
                        ? t.chainHoldUnavailable
                        : selChainLevel > 0
                          ? t.chainHoldLevel(selChainLevel)
                          : t.chainHoldNone}
                  </p>
                )}
              </div>
            </section>

            {/* tiers */}
            <section aria-label={lang === "zh" ? "段位" : "Tiers"} className="order-8 flex flex-wrap gap-1.5 lg:order-none">
              {TIERS.map((tier) => (
                <span
                  key={tier.name}
                  className="rounded-full px-3 py-1.5 text-xs font-extrabold"
                  style={{ background: tier.bg, color: tier.color }}
                >
                  {lang === "en" ? tier.nameEn : tier.name} · {tier.min}+ {lang === "en" ? "pts" : "分"}
                </span>
              ))}
              <span className="rounded-full bg-[var(--surface)] px-3 py-1.5 text-xs font-bold text-[var(--dim)]">
                {t.playToBoard}
              </span>
            </section>

            {/* yesterday's champion on-chain proof (ScoreLedger) */}
            <section aria-label={t.championAria} className="order-9 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 lg:order-none">
              <div className="flex items-baseline justify-between">
                <h2 className="text-base font-extrabold">{t.championTitle}</h2>
                <span className="text-[11px] text-[var(--dim)]">ScoreLedger · Sepolia</span>
              </div>
              {champion.isPending && <p className="mt-1.5 text-sm text-[var(--dim)]">{t.loading}</p>}
              {champion.data && champion.data.status === "submitted" ? (
                <div className="mt-1.5 text-sm leading-relaxed">
                  <p>
                    {t.championOnChain}
                    {champion.data.name ? `${champion.data.name} · ` : ""}
                    {champion.data.player.slice(0, 8)}…{champion.data.player.slice(-6)} ·{" "}
                    <span className="font-extrabold text-[#b97f00]">{t.championScore(champion.data.score)}</span>
                  </p>
                  <p className="mt-0.5 text-xs font-semibold text-[var(--dim)]">
                    {t.championMeta(
                      champion.data.dayDisplay,
                      champion.data.distance,
                      champion.data.characterId
                        ? `${charText(charById(champion.data.characterId), lang).name}${champion.data.level > 0 ? ` Lv${champion.data.level}` : ""}`
                        : "",
                    )}
                    {champion.data.squeekBlock
                      ? ` · ${t.championBorn(champion.data.squeekBlock)}`
                      : ""}
                  </p>
                  {champion.data.txHash && (
                    <p className="mt-0.5 font-mono text-[11px] text-[var(--dim)]">
                      tx {champion.data.txHash.slice(0, 10)}…{champion.data.txHash.slice(-8)}
                    </p>
                  )}
                  {champion.data.explorerUrl && (
                    <a
                      href={champion.data.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1.5 inline-block rounded-md border border-[#e2ead8] bg-[#f4f9ee] px-3 py-1.5 text-xs font-extrabold text-[#2e6b30]"
                    >
                      {t.championViewTx}
                    </a>
                  )}
                </div>
              ) : champion.data && champion.data.status !== "none" ? (
                <div className="mt-1.5 text-sm leading-relaxed">
                  <p>
                    {champion.data.name ? `${champion.data.name} · ` : ""}
                    {champion.data.player.slice(0, 8)}…{champion.data.player.slice(-6)} ·{" "}
                    <span className="font-extrabold text-[#b97f00]">{t.championScore(champion.data.score)}</span>
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                    {champion.data.status === "failed" ? t.championFailed : t.championPending}
                  </p>
                </div>
              ) : (
                <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">
                  {champion.data ? t.championNone : t.championUnavailable}
                </p>
              )}
              <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--dim)]">
                {t.championFlow}
                {champion.data && (
                  <>
                    {" "}
                    <a
                      href={champion.data.contractUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-bold text-[#2e6b30] underline"
                    >
                      {t.championContractLink}
                    </a>
                  </>
                )}
              </p>
            </section>

            {/* daily board — today's (UTC) top 3, right under the
                champion proof on desktop AND on mobile */}
            <section aria-label={t.dailyBoardAria} className="order-10 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 lg:order-none">
              <div className="mb-1 flex items-baseline justify-between">
                <h2 className="text-base font-extrabold">{t.dailyBoardTitle}</h2>
                <span className="text-[11px] text-[var(--dim)]">
                  {dailyBoard.data ? `${dailyBoard.data.dayId} (UTC)` : ""}
                </span>
              </div>
              <p className="mb-1 text-[11px] font-semibold text-[var(--dim)]">{t.dailyBoardSub}</p>
              {dailyBoard.isPending && <p className="text-sm text-[var(--dim)]">{t.loading}</p>}
              {dailyBoard.data && dailyBoard.data.entries.length === 0 && (
                <p className="text-sm leading-relaxed text-[var(--dim)]">{t.dailyBoardEmpty}</p>
              )}
              <ol className="flex flex-col">
                {(dailyBoard.data?.entries ?? []).map((e) => (
                  <BoardRow key={e.playerId} entry={e} highlight={player?.id === e.playerId} />
                ))}
              </ol>
            </section>

              </div>
            </div>

            {/* all-time leaderboard — full width under both columns on
                desktop (top 30); on mobile it stays in the single
                column flow at the bottom */}
            <section aria-label={t.boardAria} className="mt-3.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3.5 lg:mt-5">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-base font-extrabold">{t.boardTitle}</h2>
                <span className="text-xs text-[var(--dim)]">
                  {board.data ? t.boardPlayers(board.data.totalPlayers) : ""}
                </span>
              </div>
              <p className="-mt-1 mb-2 text-xs font-semibold text-[var(--dim)]">{t.boardSub}</p>
              {board.isPending && <p className="text-sm text-[var(--dim)]">{t.loading}</p>}
              {board.data && board.data.entries.length === 0 && (
                <p className="text-sm leading-relaxed text-[var(--dim)]">
                  {t.boardEmpty}
                </p>
              )}
              <ol className="flex flex-col">
                {(board.data?.entries ?? []).map((e) => (
                  <BoardRow key={e.playerId} entry={e} highlight={player?.id === e.playerId} />
                ))}
              </ol>
              <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--dim)]">
                {t.boardFootnote}
              </p>
            </section>

          </div>
        )}
      </main>

      {/* discovery toast — terminal-style, English in both languages */}
      {joinedToast && (
        <div
          role="status"
          className="fixed inset-x-0 bottom-24 z-50 mx-auto w-fit max-w-[92vw] rounded-md border border-[#2e4a2e] bg-black px-4 py-2.5 font-mono text-sm font-bold text-[#4ade80] shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
        >
          {t.imdpepeJoined}
        </div>
      )}

      {/* frog easter egg overlay — 10 taps on imdpepe */}
      {frogEgg && (
        <div
          role="alert"
          aria-label={t.imdpepeDragged}
          className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-5 bg-black/95 px-6 text-center"
        >
          <HamsterFace meta={IMDPEPE_META} size={96} />
          <div className="font-mono text-base font-bold leading-relaxed text-[#4ade80] sm:text-lg">
            {t.imdpepeDragged}
          </div>
          <div className="font-mono text-xs text-[#4ade80]/60">&gt; imd.fun</div>
        </div>
      )}

      {/* sticky start bar — thumb-reachable, always visible in the lobby */}
      {screen === "lobby" && player && (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto w-full max-w-[430px] px-4 pb-4 md:max-w-[680px] lg:max-w-[1060px] lg:px-6">
          <div className="flex items-center gap-3 rounded-2xl border border-[#e2ead8] bg-white p-2.5 shadow-[0_4px_14px_rgba(60,90,50,0.16)]">
            {meta.id === "imdpepe" ? (
              <button
                type="button"
                aria-label={t.imdpepeCardAria}
                onClick={handleFrogTap}
                className="shrink-0 cursor-pointer bg-transparent p-0"
              >
                <HamsterFace meta={meta} size={40} />
              </button>
            ) : (
              <span className="shrink-0">
                <HamsterFace meta={meta} size={40} />
              </span>
            )}
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-extrabold">
                {metaText.name} · Lv{selLevel}
              </div>
              <div className="text-[11px] leading-snug text-[var(--dim)]">
                {ghostInfo ? t.stickyShadow(ghostInfo.round) : ""}{t.stickyReady}
              </div>
            </div>
            <button
              type="button"
              onClick={startGame}
              disabled={!selUnlocked || selModelState !== "ready"}
              className="shrink-0 whitespace-nowrap rounded-md bg-[var(--accent)] px-5 py-3 text-base font-extrabold text-white shadow-[0_4px_14px_rgba(60,90,50,0.16)] active:scale-[0.98] disabled:opacity-40 disabled:shadow-none"
            >
              {!selUnlocked
                ? t.stickyLocked
                : selModelState === "loading"
                  ? t.modelLoading
                  : selModelState === "error"
                    ? t.modelLoadFailed
                    : t.startRun}
            </button>
          </div>
        </div>
      )}

      {/* mint modal — one click: the server authorisation is fetched in
          the background, the wallet asks for a single confirmation */}
      {mintModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#2e3d2a]/45 sm:items-center" role="dialog" aria-modal="true" aria-label={t.mintModalAria}>
          <div className="w-full max-w-[430px] rounded-t-[24px] border border-[#e2ead8] bg-white p-5 pb-7 sm:rounded-[24px]">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-xl font-extrabold">
                {selUnlocked
                  ? t.mintTitleUpgrade(metaText.name, Math.min(5, selLevel + 1))
                  : t.mintTitleUnlock(metaText.name)}
              </h2>
              <button
                type="button"
                aria-label={t.close}
                onClick={closeMint}
                className="flex h-9 w-9 items-center justify-center rounded-md border border-[#e2ead8] bg-[#f4f9ee] text-lg"
              >
                ✕
              </button>
            </div>
            <p className="text-sm font-semibold text-[var(--dim)]">{t.mintPriceLine(mintPrice)}</p>
            <p className="mb-4 mt-1 text-sm font-semibold">
              {mintReady ? t.mintReadyLine : t.mintShortBy(fmtM(mintShortM))}
            </p>
            {mintPhase === "confirming" ? (
              <div>
                <p className="text-base font-extrabold">{t.mintConfirming}</p>
                {mintTxHash && (
                  <p className="mt-1 break-all font-mono text-xs text-[var(--dim)]">
                    {t.mintSuccessTx(shortHash(mintTxHash))}
                  </p>
                )}
                <button
                  type="button"
                  onClick={closeMint}
                  className="mt-4 w-full rounded-xl bg-[var(--accent)] py-3 text-base font-extrabold text-white"
                >
                  {t.mintDone}
                </button>
              </div>
            ) : mintPhase === "success" ? (
              <div>
                <p className="text-lg font-extrabold text-[#2e6b30]">
                  {mintRegistered ? t.mintRegisteredTitle : t.mintSuccessTitle}
                </p>
                {mintRegistered ? (
                  <p className="mt-1 text-sm text-[var(--dim)]">{t.mintRegisteredBody}</p>
                ) : mintTxHash ? (
                  <p className="mt-1 break-all font-mono text-xs text-[var(--dim)]">
                    {t.mintSuccessTx(shortHash(mintTxHash))}
                  </p>
                ) : null}
                <button
                  type="button"
                  onClick={closeMint}
                  className="mt-4 w-full rounded-xl bg-[var(--accent)] py-3 text-base font-extrabold text-white"
                >
                  {t.mintDone}
                </button>
              </div>
            ) : (
              <div>
                <button
                  type="button"
                  disabled={!mintReady || mintPhase === "processing"}
                  onClick={handleMintClick}
                  className="w-full rounded-xl bg-[var(--accent)] py-3.5 text-base font-extrabold text-white disabled:opacity-40"
                >
                  {mintPhase === "processing" ? t.mintProcessing : t.mintBtn(mintPrice)}
                </button>
                {mintPhase === "error" && mintError && (
                  <p className="mt-2 rounded-xl bg-[#fdecea] px-3 py-2 text-xs font-semibold text-[#b3372a]">
                    {mintError}
                  </p>
                )}
                <p className="mt-3 text-[11px] leading-relaxed text-[var(--dim)]">
                  {player?.isPreview
                    ? t.mintTestNote
                    : charId === "imdpepe"
                      ? t.mintImdpepeRegNote
                      : t.mintSafetyTip}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* wallet modal */}
      {walletOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#2e3d2a]/45 sm:items-center" role="dialog" aria-modal="true" aria-label={t.walletModalAria}>
          <div className="max-h-[calc(100dvh-1.5rem)] w-full max-w-[430px] overflow-y-auto rounded-t-[24px] border border-[#e2ead8] bg-white p-5 pb-7 sm:rounded-[24px]">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-xl font-extrabold">{t.walletTitle}</h2>
              <button
                type="button"
                aria-label={t.close}
                onClick={closeWalletModal}
                className="flex h-9 w-9 items-center justify-center rounded-md border border-[#e2ead8] bg-[#f4f9ee] text-lg"
              >
                ✕
              </button>
            </div>
            <p className="mb-4 text-sm text-[var(--dim)]">
              {t.walletIntro}
            </p>
            <div className="flex flex-col gap-2.5">
              {WALLETS.map((w) => {
                const detected = !!walletProviders[w.id];
                return (
                  <button
                    key={w.id}
                    type="button"
                    disabled={walletBusy !== null}
                    onClick={() => connectWallet(w)}
                    className="flex items-center gap-3 rounded-md border border-[#e2ead8] bg-[var(--surface)] px-4 py-3 text-left active:bg-[#e8f6df]"
                  >
                    <img
                      src={w.icon}
                      alt=""
                      width={44}
                      height={44}
                      className="h-11 w-11 shrink-0 rounded-xl object-cover"
                    />
                    <span className="flex-1">
                      <span className="block font-extrabold leading-tight">{w.name}</span>
                      <span className="block text-xs text-[var(--dim)]">{lang === "en" ? w.subEn : w.sub}</span>
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                        detected ? "bg-[#58b368] text-white" : "bg-[#e3ecd9] text-[var(--dim)]"
                      }`}
                    >
                      {walletBusy === w.id ? t.walletWaiting : detected ? t.walletDetected : t.walletNotDetected}
                    </span>
                  </button>
                );
              })}
            </div>

            {walletMsg && (
              <p className="mt-3 rounded-xl bg-[#fdecea] px-3 py-2 text-sm font-semibold text-[#b3372a]">
                {walletMsg}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BoardRow({ entry, highlight }: { entry: BoardEntry; highlight?: boolean }) {
  const { lang, t } = useLang();
  const meta = charById(entry.characterId);
  const metaText = charText(meta, lang);
  const tier = tierFor(entry.score);
  const medal =
    entry.rank === 1 ? "#ffd319" : entry.rank === 2 ? "#d7dee2" : entry.rank === 3 ? "#e59a5f" : null;
  return (
    <li
      className={`flex items-center gap-2.5 border-b border-[#e6eee0] py-2 last:border-0 ${
        highlight ? "rounded-lg bg-[#e8f6df] px-2" : ""
      }`}
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-extrabold"
        style={{
          background: medal ?? "#e3ecd9",
          color: medal ? "#5a3d00" : "var(--dim)",
        }}
      >
        {entry.rank}
      </span>
      <HamsterFace meta={meta} size={30} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold leading-tight">{entry.name}</span>
        <span className="block text-[11px] text-[var(--dim)]">
          {metaText.name} Lv{entry.level} · {entry.address.slice(0, 6)}…{entry.address.slice(-4)}
          {entry.squeekBlock ? ` · ${t.boardBornAt(entry.squeekBlock)}` : ""}
        </span>
      </span>
      {tier && (
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-extrabold"
          style={{
            background: tier.bg,
            color: tier.color,
          }}
        >
          {lang === "en" ? tier.nameEn : tier.name}
        </span>
      )}
      <span className="font-display text-[13px] font-extrabold text-[#b97f00]">{entry.score}</span>
    </li>
  );
}

function ResultScreen({
  outcome,
  player,
  characterId,
  ghost,
  onReplay,
  onLobby,
  onConnect,
}: {
  outcome: RunOutcome;
  player: Player;
  characterId: string;
  ghost: GhostInfo | null;
  onReplay: () => void;
  onLobby: () => void;
  onConnect: () => void;
}) {
  const { lang, t } = useLang();
  const submit = outcome.submit;
  const accepted = submit?.accepted ?? false;
  const score = accepted ? submit!.score : outcome.localScore;
  const tier = tierFor(score);
  const meta = charById(characterId);
  const metaText = charText(meta, lang);
  const ghostWon =
    outcome.ghostDistance !== null && outcome.localDistance >= outcome.ghostDistance;
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col items-center gap-4 px-5 pb-8 pt-10">
      <HamsterFace meta={meta} size={96} />
      <div className="text-center">
        <div className="text-sm font-bold tracking-widest text-[var(--dim)]">
          {outcome.crashed ? t.resCrashed : t.resFinished}
        </div>
        <div className="font-display mt-1 text-5xl font-extrabold leading-none text-[#b97f00]">{score}</div>
        {tier ? (
          <span
            className="mt-3 inline-block rounded-full px-4 py-1.5 text-base font-extrabold"
            style={{ background: tier.bg, color: tier.color }}
          >
            {t.tierSuffix(lang === "en" ? tier.nameEn : tier.name)}
          </span>
        ) : (
          <span className="mt-3 inline-block rounded-full bg-[var(--surface)] px-4 py-1.5 text-sm font-bold text-[var(--dim)]">
            {t.resToBronze(2000 - score)}
          </span>
        )}
      </div>

      <div className="grid w-full grid-cols-3 gap-2 text-center">
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] py-3">
          <div className="font-display text-sm font-extrabold leading-6">{t.resDistVal(accepted ? submit!.distance : outcome.localDistance)}</div>
          <div className="text-xs text-[var(--dim)]">{t.resDistance}</div>
        </div>
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] py-3">
          <div className="font-display text-sm font-extrabold leading-6">{t.resSeedVal(accepted ? submit!.seeds : outcome.localSeeds)}</div>
          <div className="text-xs text-[var(--dim)]">{t.resSeeds}</div>
        </div>
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] py-3">
          <div className="text-lg font-extrabold">
            {player?.isPreview ? t.resTest : accepted && submit!.rank ? t.resRank(submit!.rank) : "—"}
          </div>
          <div className="text-xs text-[var(--dim)]">{t.resBoard}</div>
        </div>
      </div>

      {ghost && outcome.ghostDistance !== null && (
        <p className="rounded-xl bg-[#e8f4fb] px-3.5 py-2.5 text-center text-sm font-semibold text-[#2e6b30]">
          {ghostWon
            ? t.resShadowWin(outcome.ghostDistance, ghost.round)
            : t.resShadowLose(outcome.ghostDistance, outcome.ghostDistance - outcome.localDistance, ghost.round)}
        </p>
      )}
      {accepted && submit!.squeekBlock !== null && (
        <p className="text-center text-xs leading-relaxed text-[var(--dim)]">
          {t.resBirth(submit!.squeekBlock, submit!.level ? t.resBirthLv(metaText.name, submit!.level) : "")}
        </p>
      )}
      {accepted && !player?.isPreview && submit!.bestScore > score && (
        <p className="text-sm text-[var(--dim)]">{t.resBest(submit!.bestScore)}</p>
      )}
      {player?.isPreview && (
        <p className="rounded-xl bg-[#e8f4fb] px-3.5 py-2.5 text-center text-sm font-semibold text-[#2e6b30]">
          {t.resPreviewNote}
        </p>
      )}
      {submit && !accepted && (
        <p className="rounded-xl bg-[#fdecea] px-3.5 py-2.5 text-center text-sm font-semibold text-[#b3372a]">
          {t.resRejected}
        </p>
      )}
      {!submit && outcome.submitError && (
        <p className="rounded-xl bg-[#fdecea] px-3.5 py-2.5 text-center text-sm font-semibold text-[#b3372a]">
          {t.resSubmitFailed(localizeError(outcome.submitError, lang))}
        </p>
      )}

      <div className="flex w-full flex-col gap-2.5 pt-2">
        <button
          type="button"
          onClick={onReplay}
          className="w-full rounded-[var(--radius)] bg-[var(--accent)] py-3.5 text-lg font-extrabold text-white"
        >
          {t.resReplay}
        </button>
        {player?.isPreview ? (
          <button
            type="button"
            onClick={onConnect}
            className="w-full rounded-[var(--radius)] border-2 border-[var(--accent)] py-3 text-base font-extrabold text-[#2e7d32]"
          >
            {t.resConnect}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onLobby}
          className="w-full rounded-[var(--radius)] border border-[var(--border)] py-3 text-base font-bold text-[var(--dim)]"
        >
          {t.backToLobby}
        </button>
      </div>
    </div>
  );
}
