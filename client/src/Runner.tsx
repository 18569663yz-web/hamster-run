import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js";
import { api, type ApiResponse } from "./api";
import liziTrellisUrl from "./assets/lizi-trellis.glb";
import xueqiuGlbUrl from "./assets/xueqiu-game.glb";
import meiqiuGlbUrl from "./assets/meiqiu-game.glb";
import huashengGlbUrl from "./assets/huasheng-game.glb";
import zhimaGlbUrl from "./assets/zhima-game.glb";
import imdpepeGlbUrl from "./assets/imdpepe-game.glb";
import { RunnerSim, type ActionType, type InputEvent, type PowerKind } from "./sim";
import { charById, type CharacterMeta } from "./characters";
import { LangToggle, localizeError, useLang } from "./i18n";
import { MuteButton } from "./MuteButton";

export interface RunOutcome {
  localScore: number;
  localDistance: number;
  localSeeds: number;
  crashed: boolean;
  /** ghost opponent's final distance (same time window), null when no ghost */
  ghostDistance: number | null;
  submit: ApiResponse<typeof api, "submitRun"> | null;
  submitError: string | null;
}

export interface GhostInfo {
  round: number;
  work: number;
  factor: number;
}

interface RunnerProps {
  token: string;
  characterId: string;
  ghostBest: number;
  ghost: GhostInfo | null;
  themeIndex: number;
  onFinish: (outcome: RunOutcome) => void;
  onExit: () => void;
}

type CharIdArg = "lizi" | "xueqiu" | "meiqiu" | "huasheng" | "zhima" | "imdpepe";

/** distance the base speed curve covers by time t (§1.1 D(t)) */
function curveDistance(t: number): number {
  if (t <= 120) return 10 * t + (10.5 * t * t) / 240;
  return 1830 + 20.5 * (t - 120);
}

const STEP_MS = 1000 / 60;
const LANE_W = 2.2;

/* ---------------- GLB models: the ONLY character models ----------------
 * Every character renders from its real GLB file — 栗子's TRELLIS model,
 * the four 混元 models, and imdpepe's rigged model. There is no
 * code-built stand-in and no silent fallback: the lobby preloads the
 * selected character's GLB and tracks its state, and a run can only be
 * started once that state is "ready". A failed load surfaces as an
 * explicit error with a retry in the lobby (see App.tsx); the countdown
 * and the run itself never wait on a load. */
const gltfCache = new Map<string, Promise<GLTF>>();

function loadGltfCached(url: string): Promise<GLTF> {
  let p = gltfCache.get(url);
  if (!p) {
    p = new GLTFLoader().loadAsync(url);
    gltfCache.set(url, p);
  }
  return p;
}

/** The one GLB each character renders from. The five hamsters are all
 *  single fused textured meshes （栗子 TRELLIS + four 混元） and share
 *  one attach/align/animate path; imdpepe's file is skinned (see
 *  attachFrogGlb) and needs the SkeletonUtils clone + per-bone path. */
const CHARACTER_GLB_URLS: Record<CharIdArg, string> = {
  lizi: liziTrellisUrl as string,
  xueqiu: xueqiuGlbUrl as string,
  meiqiu: meiqiuGlbUrl as string,
  huasheng: huashengGlbUrl as string,
  zhima: zhimaGlbUrl as string,
  imdpepe: imdpepeGlbUrl as string,
};

export type CharacterModelState = "loading" | "ready" | "error";

const modelStateByChar = new Map<string, CharacterModelState>();
const modelErrorByChar = new Map<string, string>();
const modelListeners = new Map<string, Set<() => void>>();

function setModelState(characterId: string, state: CharacterModelState): void {
  if (modelStateByChar.get(characterId) === state) return;
  modelStateByChar.set(characterId, state);
  for (const cb of modelListeners.get(characterId) ?? []) cb();
}

export function getCharacterModelState(characterId: string): CharacterModelState {
  return modelStateByChar.get(characterId) ?? "loading";
}

export function getCharacterModelError(characterId: string): string | null {
  return modelErrorByChar.get(characterId) ?? null;
}

export function subscribeCharacterModel(characterId: string, cb: () => void): () => void {
  let set = modelListeners.get(characterId);
  if (!set) {
    set = new Set();
    modelListeners.set(characterId, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

/** Start (or restart) loading a character's GLB and track the outcome.
 *  A rejected load evicts the cached promise, so a retry refetches the
 *  file instead of replaying the same failure. */
export function preloadCharacterModel(characterId: string): void {
  const url = CHARACTER_GLB_URLS[characterId as CharIdArg];
  if (!url) return;
  if (modelStateByChar.get(characterId) === "ready") return;
  setModelState(characterId, "loading");
  loadGltfCached(url).then(
    () => {
      modelErrorByChar.delete(characterId);
      setModelState(characterId, "ready");
    },
    (e: unknown) => {
      gltfCache.delete(url);
      modelErrorByChar.set(characterId, e instanceof Error ? e.message : String(e));
      setModelState(characterId, "error");
    },
  );
}

export function Runner({ token, characterId, ghostBest, ghost, themeIndex, onFinish, onExit }: RunnerProps) {
  const ghostRef = useRef(ghost);
  ghostRef.current = ghost;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const simRef = useRef<RunnerSim | null>(null);
  const queueRef = useRef<ActionType[]>([]);
  const inputsRef = useRef<InputEvent[]>([]);
  const rafRef = useRef(0);
  const submittedRef = useRef(false);
  const runTokenRef = useRef<string | null>(null);
  /** set while the post-crash演出 is playing: a tap fires it to skip
   *  straight to the result panel */
  const finishSkipRef = useRef<(() => void) | null>(null);
  const pausedRef = useRef(false);
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const meta = charById(characterId);
  const { lang, t } = useLang();
  /** fine pointer (mouse/trackpad — a desktop with a keyboard) shows
   *  the keyboard control hint; touch devices keep the swipe hint */
  const [finePointer] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: fine)").matches,
  );

  const [countdown, setCountdown] = useState(3);
  const [hud, setHud] = useState({ score: 0, distance: 0, seeds: 0, speed: 0, shield: 0, magnet: 0, flight: 0, boost: 0, double: 0, sneak: 0, skillBoost: 0, seedCharge: 0, impepe: 0, impepeCharge: 0, impepeThreshold: 0, ghostDiff: null as number | null });
  const [paused, setPaused] = useState(false);
  const [crashedFlash, setCrashedFlash] = useState(false);
  const [shieldFlash, setShieldFlash] = useState(false);
  const [powerFlash, setPowerFlash] = useState<PowerKind | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: (args: { seed: number; inputs: InputEvent[] }) =>
      api.submitRun({
        token,
        seed: args.seed,
        characterId: characterId as CharIdArg,
        runToken: runTokenRef.current ?? undefined,
        inputs: args.inputs,
      }),
  });
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    let cancelled = false;
    let seed = 0;
    let view: GameView | null = null;
    (async () => {
      try {
        const res = await api.startRun({
          token,
          characterId: characterId as CharIdArg,
        });
        if (cancelled) return;
        seed = res.seed;
        runTokenRef.current = res.runToken ?? null;
        const sim = new RunnerSim(seed, characterId, res.level);
        simRef.current = sim;

        // Build the 3D view before the countdown so the track is already live.
        const wrap = wrapRef.current;
        if (!wrap) throw new Error(t.runContainerError);
        try {
          view = new GameView(wrap, meta, themeIndex, lang, (msg) => {
            if (!cancelled) {
              setPaused(true);
              setModelError(msg);
            }
          });
        } catch (e) {
          setGlError(e instanceof Error ? localizeError(e.message, lang) : t.runGlError);
          return;
        }
        view.update(sim, 0);

        for (const n of [3, 2, 1, 0]) {
          if (cancelled) return;
          setCountdown(n);
          const t0 = performance.now();
          const dur = n === 0 ? 350 : 620;
          // keep rendering during countdown (idle run-in-place); a timeout
          // watchdog guarantees progress even where rAF is throttled
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              resolve();
            };
            const tickCd = () => {
              if (cancelled || done) return finish();
              view?.update(sim, performance.now() / 1000);
              if (performance.now() - t0 >= dur) return finish();
              requestAnimationFrame(tickCd);
            };
            tickCd();
            window.setTimeout(finish, dur + 60);
          });
        }
        if (cancelled) return;
        setCountdown(-1);

        let last = performance.now();
        let acc = 0;
        let hudTick = 0;
        let prevShieldTick = sim.lastShieldTick;
        let prevPowerTick = sim.lastPowerTick;
        const loop = (now: number) => {
          if (cancelled) return;
          rafRef.current = requestAnimationFrame(loop);
          const simNow = simRef.current;
          if (!simNow || !view) return;
          try {
            if (!pausedRef.current) {
              acc += Math.min(120, now - last);
              while (acc >= STEP_MS) {
                acc -= STEP_MS;
                // One action per step, and never two recorded actions closer
                // than 4 ticks — the server rejects denser logs as scripted,
                // so quick human combos are spaced by a few ticks instead.
                let action: ActionType | null = null;
                const next = queueRef.current[0];
                if (next) {
                  const tick = simNow.tick + 1;
                  const lastInput = inputsRef.current[inputsRef.current.length - 1];
                  if (!lastInput || tick - lastInput.tick >= 4) {
                    queueRef.current.shift();
                    inputsRef.current.push({ tick, action: next });
                    action = next;
                  }
                }
                simNow.step(action);
                if (simNow.crashed || simNow.finished) break;
              }
            }
            last = now;
            view.update(simNow, now / 1000);
            if (simNow.lastShieldTick !== prevShieldTick) {
              prevShieldTick = simNow.lastShieldTick;
              setShieldFlash(true);
              window.setTimeout(() => setShieldFlash(false), 450);
            }
            if (simNow.lastPowerTick !== prevPowerTick) {
              prevPowerTick = simNow.lastPowerTick;
              if (simNow.lastPowerKind) {
                setPowerFlash(simNow.lastPowerKind);
                window.setTimeout(() => setPowerFlash(null), 1100);
              }
            }
            hudTick += 1;
            if (hudTick % 6 === 0 || simNow.crashed || simNow.finished) {
              const g = ghostRef.current;
              setHud({
                score: simNow.score,
                distance: Math.floor(simNow.distance),
                seeds: simNow.seedsCollected,
                speed: Math.round(simNow.speed * 3.6),
                shield: simNow.shield,
                magnet: Math.ceil(simNow.magnetTicks / 60),
                flight: Math.ceil(simNow.flightTicks / 60),
                boost: Math.ceil(simNow.boostTicks / 60),
                double: Math.ceil(simNow.doubleTicks / 60),
                sneak: Math.ceil(simNow.sneakTicks / 60),
                skillBoost: Math.ceil(simNow.skillBoostTicks / 60),
                seedCharge: simNow.seedsCollected % 30,
                impepe: Math.ceil(simNow.impepeTicks / 60),
                impepeCharge: simNow.impepeCharge,
                impepeThreshold: simNow.params.impepeThreshold,
                ghostDiff: g
                  ? Math.floor(simNow.distance - curveDistance(simNow.tick / 60) * g.factor)
                  : null,
              });
            }
            if ((simNow.crashed || simNow.finished) && !submittedRef.current) {
              submittedRef.current = true;
              if (simNow.crashed) setCrashedFlash(true);
              const g = ghostRef.current;
              const local = {
                localScore: simNow.score,
                localDistance: Math.floor(simNow.distance),
                localSeeds: simNow.seedsCollected,
                crashed: simNow.crashed,
                ghostDistance: g
                  ? Math.floor(curveDistance(simNow.tick / 60) * g.factor)
                  : null,
              };
              let fired = false;
              const doFinish = async () => {
                if (fired || cancelled) return;
                fired = true;
                finishSkipRef.current = null;
                try {
                  const res = await submitRef.current.mutateAsync({
                    seed,
                    inputs: inputsRef.current,
                  });
                  onFinish({ ...local, submit: res, submitError: null });
                } catch (e) {
                  onFinish({
                    ...local,
                    submit: null,
                    submitError: e instanceof Error ? e.message : t.runSubmitFailed,
                  });
                }
              };
              finishSkipRef.current = () => {
                void doFinish();
              };
              // a real crash first plays the ~1.5s dizzy演出 in the view
              // (turn, sit, sway, stars) — a tap skips to the panel
              window.setTimeout(
                () => {
                  void doFinish();
                },
                simNow.crashed ? 1550 : 750,
              );
            }
          } catch {
            // a single bad frame must not kill the loop
          }
        };
        rafRef.current = requestAnimationFrame(loop);
      } catch (e) {
        if (!cancelled) setStartError(e instanceof Error ? localizeError(e.message, lang) : t.runStartFailed);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      view?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const queueAction = (action: ActionType) => {
    // during the post-crash演出 any tap skips to the result panel
    if (finishSkipRef.current) {
      finishSkipRef.current();
      return;
    }
    if (countdown !== -1) return;
    if (queueRef.current.length < 3) queueRef.current.push(action);
  };

  // Desktop keyboard control — this listener exists only while the
  // Runner (the in-run screen) is mounted, so the keys do nothing in
  // the lobby/menus. W / Space / ↑ jump, A / ← left, D / → right,
  // S / ↓ slide; every mapped key is preventDefaulted (Space would
  // otherwise scroll the page).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const map: Record<string, ActionType> = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "jump",
        ArrowDown: "slide",
        a: "left",
        d: "right",
        w: "jump",
        s: "slide",
        " ": "jump",
      };
      const a = map[key];
      if (a) {
        e.preventDefault();
        queueAction(a);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown]);

  const onTouchStart = (e: React.TouchEvent) => {
    if (finishSkipRef.current) {
      finishSkipRef.current();
      return;
    }
    const t = e.touches[0];
    if (t) touchRef.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchRef.current;
    touchRef.current = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    if (Math.abs(dx) > Math.abs(dy)) queueAction(dx > 0 ? "right" : "left");
    else queueAction(dy > 0 ? "slide" : "jump");
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (finishSkipRef.current) {
      finishSkipRef.current();
      return;
    }
    if (e.pointerType === "touch") return;
    touchRef.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") return;
    const start = touchRef.current;
    touchRef.current = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    if (Math.abs(dx) > Math.abs(dy)) queueAction(dx > 0 ? "right" : "left");
    else queueAction(dy > 0 ? "slide" : "jump");
  };

  if (startError) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-[var(--bg)] px-6 text-center">
        <p className="text-lg font-bold text-[var(--text)]">{t.runStartFailed}</p>
        <p className="text-sm text-[var(--dim)]">{startError}</p>
        <button
          type="button"
          onClick={onExit}
          className="rounded-full bg-[var(--accent)] px-6 py-2.5 font-bold text-white"
        >
          {t.backToLobby}
        </button>
      </div>
    );
  }

  if (modelError) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-[var(--bg)] px-6 text-center">
        <p className="text-lg font-bold text-[var(--text)]">{t.modelLoadFailed}</p>
        <p className="max-w-[340px] break-words text-sm text-[var(--dim)]">{modelError}</p>
        <button
          type="button"
          onClick={onExit}
          className="rounded-full bg-[var(--accent)] px-6 py-2.5 font-bold text-white"
        >
          {t.backToLobby}
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40 select-none overflow-hidden bg-[#87c5e8] text-white">
      {/* 3D viewport — fills the whole screen */}
      <div
        ref={wrapRef}
        className="absolute inset-0 touch-none"
        role="img"
        aria-label={t.viewportAria}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      />

      {glError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#87c5e8] px-6 text-center">
          <p className="text-lg font-extrabold">{t.glScreenTitle}</p>
          <p className="text-sm text-[#41603c]">{glError}</p>
          <button
            type="button"
            onClick={onExit}
            className="rounded-full bg-[var(--accent)] px-6 py-2.5 font-bold text-white"
          >
            {t.backToLobby}
          </button>
        </div>
      )}

      {/* HUD — thin top band floating over the scene */}
      <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/45 to-transparent px-4 pb-6 pt-3">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] font-semibold tracking-widest text-white/70">{t.hudScore}</div>
            <div className="font-display text-2xl font-extrabold leading-none drop-shadow">{hud.score}</div>
            <div className="mt-1 flex max-w-[240px] flex-wrap gap-2 text-[11px] font-semibold text-white/85">
              {hud.shield > 0 && (
                <span className="rounded-md border border-[#e2ead8] bg-[#3aa8c9]/90 px-2 py-0.5 text-white">
                  {t.hudShield(hud.shield)}
                </span>
              )}
              {hud.magnet > 0 && (
                <span className="rounded-md border border-[#e2ead8] bg-[#e05252]/90 px-2 py-0.5 text-white">
                  {t.hudMagnet(hud.magnet)}
                </span>
              )}
              {hud.flight > 0 && (
                <span className="rounded-md border border-[#e2ead8] bg-[#39c2d7]/90 px-2 py-0.5 text-white">
                  {t.hudFlight(hud.flight)}
                </span>
              )}
              {hud.boost > 0 && (
                <span className="rounded-md border border-[#e2ead8] bg-[#f5c542]/90 px-2 py-0.5 text-[#5a3d00]">
                  {t.hudBoost(hud.boost)}
                </span>
              )}
              {hud.double > 0 && (
                <span className="rounded-md border border-[#e2ead8] bg-[#b07fe8]/90 px-2 py-0.5 text-white">
                  {t.hudDouble(hud.double)}
                </span>
              )}
              {hud.sneak > 0 && (
                <span className="rounded-md border border-[#e2ead8] bg-[#7ed492]/90 px-2 py-0.5 text-white">
                  {t.hudSneak(hud.sneak)}
                </span>
              )}
              {hud.skillBoost > 0 && (
                <span className="rounded-md border border-[#e2ead8] bg-[#ff8c42]/95 px-2 py-0.5 text-white">
                  {t.hudSkillBoost(hud.skillBoost)}
                </span>
              )}
              {characterId === "lizi" && hud.skillBoost <= 0 && (
                <span className="rounded-md border border-[#e2ead8] bg-black/55 px-2 py-0.5 text-white/90">
                  {t.hudCharge(hud.seedCharge)}
                </span>
              )}
              {hud.impepe > 0 && (
                <span className="rounded-md border border-[#e2ead8] bg-[#2e7d32]/95 px-2 py-0.5 font-mono text-white">
                  {t.hudImpepe(hud.impepe)}
                </span>
              )}
              {characterId === "imdpepe" && hud.impepe <= 0 && hud.impepeThreshold > 0 && (
                <span className="rounded-md border border-[#e2ead8] bg-black/55 px-2 py-0.5 font-mono text-white/90">
                  {t.hudImpepeCharge(hud.impepeCharge, hud.impepeThreshold)}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-start gap-3 text-right">
            <div>
              <div className="text-[10px] font-semibold tracking-widest text-white/70">{t.hudDistance}</div>
              <div className="font-display text-[11px] font-bold leading-5">{hud.distance} {lang === "zh" ? "米" : "m"}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold tracking-widest text-white/70">{t.hudSeeds}</div>
              <div className="font-display text-[11px] font-bold leading-5 text-[#ffc93c]">{hud.seeds}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold tracking-widest text-white/70">{t.hudSpeed}</div>
              <div className="font-display text-[11px] font-bold leading-5">{hud.speed} <span className="text-[8px] text-white/70">km/h</span></div>
            </div>
          </div>
        </div>
        <div className="mt-1.5 flex items-center justify-end gap-2">
          <LangToggle className="pointer-events-auto flex items-center overflow-hidden rounded-full border border-white/70 bg-white/85 text-xs font-bold text-[#2e3d2a]" />
          <MuteButton className="pointer-events-auto flex h-9 items-center gap-1.5 rounded-full border border-white/70 bg-white/85 px-3 text-xs font-bold text-[#2e3d2a]" />
          <button
            type="button"
            aria-label={t.pauseAria(paused)}
            onClick={() => setPaused((p) => !p)}
            className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-white/70 bg-white/85 text-sm text-[#2e3d2a]"
          >
            {paused ? "▶" : "❚❚"}
          </button>
        </div>
        {ghost && hud.ghostDiff !== null && (
          <>
            <div className="mt-1 text-[11px] font-semibold text-white/85">
              {hud.ghostDiff >= 0
                ? t.hudShadowAhead(ghost.round, hud.ghostDiff)
                : t.hudShadowBehind(ghost.round, -hud.ghostDiff)}
            </div>
            <div className="mt-0.5 max-w-[300px] text-[10px] font-medium leading-snug text-white/60">
              {t.hudShadowNote(ghost.round)}
            </div>
          </>
        )}
        {ghostBest > 0 && (
          <div className="mt-1 text-[11px] font-semibold text-white/75">
            {hud.score < ghostBest
              ? t.hudToFirst(ghostBest - hud.score)
              : t.hudFirst}
          </div>
        )}
      </div>

      {/* countdown / pause / crash overlays */}
      {countdown > 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="font-display text-8xl font-extrabold text-white drop-shadow-[0_3px_10px_rgba(40,60,30,0.45)]">
            {countdown}
          </span>
        </div>
      )}
      {countdown === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="font-display text-7xl font-extrabold text-[#ffc93c] drop-shadow-[0_3px_10px_rgba(40,60,30,0.45)]">
            GO!
          </span>
        </div>
      )}
      {paused && countdown === -1 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/55">
          <p className="text-2xl font-extrabold">{t.pausedTitle}</p>
          <button
            type="button"
            onClick={() => setPaused(false)}
            className="rounded-full bg-[var(--accent)] px-6 py-2.5 font-bold text-white"
          >
            {t.pausedResume}
          </button>
          <button
            type="button"
            onClick={onExit}
            className="rounded-full border border-white/70 bg-white/85 px-6 py-2.5 font-bold text-[#2e3d2a]"
          >
            {t.pausedQuit}
          </button>
        </div>
      )}
      {crashedFlash && (
        <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center">
          <span className="rounded-md border border-[#e2ead8] bg-[#e85d4f] px-4 py-1.5 text-lg font-extrabold shadow-[0_4px_14px_rgba(60,90,50,0.16)]">
            {t.flashCrash}
          </span>
        </div>
      )}
      {shieldFlash && !crashedFlash && (
        <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center">
          <span className="rounded-md border border-[#e2ead8] bg-[#3aa8c9] px-4 py-1.5 text-base font-extrabold text-white shadow-[0_4px_14px_rgba(60,90,50,0.16)]">
            {t.flashShield}
          </span>
        </div>
      )}
      {powerFlash && !crashedFlash && !shieldFlash && (
        <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center">
          <span className="rounded-md border border-[#e2ead8] bg-[#ffc93c] px-4 py-1.5 text-base font-extrabold text-[#5a3d00] shadow-[0_4px_14px_rgba(60,90,50,0.16)]">
            {t.flashPickup(t.powers[powerFlash])}
          </span>
        </div>
      )}

      {/* control hint only — no on-screen buttons: touch plays by
          swipe, desktop by keyboard (WASD / arrows / space) */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-center px-4 pb-5">
        <div className="pb-1 text-center text-[11px] font-semibold text-white/60">
          {finePointer ? t.padHintKeys : t.padHint}
        </div>
      </div>
    </div>
  );
}

/* ============================ 3D view (three.js) ============================ */

function canvasTexture(draw: (g: CanvasRenderingContext2D, s: number) => void, size = 256): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  if (g) draw(g, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function std(color: number, roughness = 0.9, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

interface SceneryItem {
  group: THREE.Group;
  dist: number;
}

class GameView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private hamster = new THREE.Group();
  private hamsterBody = new THREE.Group();
  /** the attached GLB model group (hamsters + frog alike) */
  private modelGroup: THREE.Group | null = null;
  private usingModel = false;
  /** GLB fade-in: materials of the attached model + progress 0..1 */
  private fadeMats: THREE.Material[] = [];
  private modelFade = 1;
  /** flight pose blend 0..1 — eases the dive pose in and back out */
  private flightBlend = 0;
  /** seed-collect burst sprites (expanding gold puffs at pickup point) */
  private bursts: { sprite: THREE.Sprite; t0: number }[] = [];
  private burstPool: THREE.Sprite[] = [];
  private burstTex: THREE.CanvasTexture | null = null;
  /** real-crash dizzy演出： ring of stars over the head + crash clock */
  private dizzyStars = new THREE.Group();
  private crashT = -1;
  private disposed = false;
  /** imdpepe skinned model: bone name → bone object + rest quaternion.
   *  The frog GLB ships a full humanoid skeleton (23 joints) but zero
   *  animation clips, so the run cycle is driven per-bone in code. */
  private frogBones = new Map<string, { obj: THREE.Object3D; rest: THREE.Quaternion }>();
  private usingFrog = false;
  private shieldBubble!: THREE.Mesh;
  private jetpack = new THREE.Group();
  private jetFlameL!: THREE.Mesh;
  private jetFlameR!: THREE.Mesh;
  private sunLight: THREE.DirectionalLight;
  private trackTex: THREE.CanvasTexture;
  private grassTex: THREE.CanvasTexture;
  private scenery: SceneryItem[] = [];
  private clouds: SceneryItem[] = [];
  private obstaclePool = new Map<string, THREE.Group[]>();
  private activeObstacles = new Map<number, THREE.Group>();
  private seedPool: THREE.Group[] = [];
  private activeSeeds = new Map<number, THREE.Group>();
  private powerPool = new Map<string, THREE.Group[]>();
  private activePowers = new Map<number, THREE.Group>();
  private dust!: THREE.Points;
  private dustPos!: Float32Array;
  private shake = 0;
  private wasCrashed = false;
  private rngState = 1234567;

  constructor(
    private wrap: HTMLElement,
    private meta: CharacterMeta,
    private themeIndex = 0,
    private lang: "zh" | "en" = "zh",
    /** called if the character's GLB fails to attach even though the
     *  lobby gate let the run start — the Runner surfaces it as an
     *  explicit error screen; nothing is ever substituted silently */
    private onModelError?: (message: string) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.32;
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    wrap.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 420);
    this.camera.position.set(0, 4.3, 7.6);

    // sky gradient per relay-unlocked theme （SQUEEKTOSHI 里程接力解锁主题)
    const THEMES: { sky: [string, string, string, string]; fog: number; fogNear: number; fogFar: number }[] = [
      { sky: ["#4f9fd8", "#8fc3ea", "#f6d894", "#ffefc0"], fog: 0xdce8c8, fogNear: 46, fogFar: 178 },
      { sky: ["#274b6d", "#7a5a52", "#e8933c", "#f7b95c"], fog: 0xdd9250, fogNear: 60, fogFar: 205 },
      { sky: ["#0b1030", "#1d2a52", "#3a4a8a", "#7a6ab0"], fog: 0x2a3560, fogNear: 60, fogFar: 205 },
      { sky: ["#8fb6d9", "#c9deed", "#eef6ff", "#ffffff"], fog: 0xdceefc, fogNear: 55, fogFar: 195 },
    ];
    const theme = THEMES[Math.min(THEMES.length - 1, Math.max(0, this.themeIndex))]!;
    const skyTex = canvasTexture((g, s) => {
      const grad = g.createLinearGradient(0, 0, 0, s);
      grad.addColorStop(0, theme.sky[0]);
      grad.addColorStop(0.45, theme.sky[1]);
      grad.addColorStop(0.75, theme.sky[2]);
      grad.addColorStop(1, theme.sky[3]);
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
    });
    this.scene.background = skyTex;
    this.scene.fog = new THREE.Fog(theme.fog, theme.fogNear, theme.fogFar);

    // lights: warm key sun + sky fill + rim — kept bright so the scene
    // sits at the same level as the morning-meadow UI; shadows still read
    const hemi = new THREE.HemisphereLight(0xfff2cf, 0x648552, 1.25);
    this.scene.add(hemi);
    this.sunLight = new THREE.DirectionalLight(0xffdca8, 2.05);
    this.sunLight.position.set(14, 20, -18);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.left = -20;
    this.sunLight.shadow.camera.right = 20;
    this.sunLight.shadow.camera.top = 26;
    this.sunLight.shadow.camera.bottom = -30;
    this.sunLight.shadow.camera.far = 90;
    this.sunLight.shadow.bias = -0.0002;
    this.sunLight.shadow.normalBias = 0.03;
    this.sunLight.shadow.radius = 4;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.6);
    rim.position.set(-10, 8, 14);
    this.scene.add(rim);

    // sun disc + clouds
    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(7, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xffd97a, fog: false }),
    );
    sun.position.set(38, 30, -150);
    this.scene.add(sun);
    this.buildClouds();

    // ground: grass both sides + dirt track with painted lanes
    this.grassTex = canvasTexture((g, s) => {
      g.fillStyle = "#679c46";
      g.fillRect(0, 0, s, s);
      // soft mottled patches so the field is not one flat colour
      for (let i = 0; i < 46; i++) {
        const px = (i * 97) % s;
        const py = (i * 61) % s;
        const pr = 14 + ((i * 37) % 30);
        const grad = g.createRadialGradient(px, py, 2, px, py, pr);
        const tone = i % 3 === 0 ? "119,173,85" : i % 3 === 1 ? "82,138,58" : "140,180,96";
        grad.addColorStop(0, `rgba(${tone},0.20)`);
        grad.addColorStop(1, `rgba(${tone},0)`);
        g.fillStyle = grad;
        g.fillRect(px - pr, py - pr, pr * 2, pr * 2);
      }
      // fine grain noise
      for (let i = 0; i < 2600; i++) {
        g.fillStyle = i % 4 === 0 ? "rgba(46,92,32,0.25)" : i % 4 === 1 ? "rgba(150,196,110,0.22)" : "rgba(104,156,70,0.3)";
        g.fillRect((i * 67) % s, (i * 131) % s, 2, 2);
      }
      // grass blades
      for (let i = 0; i < 900; i++) {
        g.fillStyle = i % 3 ? "#58913c" : "#77ad55";
        g.fillRect((i * 67) % s, (i * 131) % s, 3, 7);
      }
      // a few dry sandy speckles
      for (let i = 0; i < 60; i++) {
        g.fillStyle = "rgba(196,178,110,0.35)";
        g.fillRect((i * 149) % s, (i * 83) % s, 3, 2);
      }
    });
    this.grassTex.repeat.set(10, 30);
    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 260),
      new THREE.MeshStandardMaterial({ map: this.grassTex, roughness: 1 }),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(0, -0.02, -110);
    grass.receiveShadow = true;
    this.scene.add(grass);

    this.trackTex = canvasTexture((g, s) => {
      g.fillStyle = "#8a6a47";
      g.fillRect(0, 0, s, s);
      // broad tonal variation along the dirt
      for (let i = 0; i < 26; i++) {
        const px = (i * 113) % s;
        const py = (i * 71) % s;
        const pr = 18 + ((i * 41) % 34);
        const grad = g.createRadialGradient(px, py, 2, px, py, pr);
        const tone = i % 2 ? "160,128,84" : "112,86,58";
        grad.addColorStop(0, `rgba(${tone},0.20)`);
        grad.addColorStop(1, `rgba(${tone},0)`);
        g.fillStyle = grad;
        g.fillRect(px - pr, py - pr, pr * 2, pr * 2);
      }
      for (let i = 0; i < 500; i++) {
        g.fillStyle = i % 2 ? "#82664a" : "#93744f";
        g.fillRect((i * 89) % s, (i * 57) % s, 5, 3);
      }
      // fine dirt grain + tiny pebbles
      for (let i = 0; i < 1800; i++) {
        g.fillStyle = i % 5 === 0 ? "rgba(60,42,26,0.28)" : i % 5 === 1 ? "rgba(196,164,116,0.25)" : "rgba(130,102,70,0.3)";
        g.fillRect((i * 53) % s, (i * 97) % s, 2, 2);
      }
      for (let i = 0; i < 90; i++) {
        g.fillStyle = i % 2 ? "#9a958c" : "#7c766c";
        g.beginPath();
        g.arc((i * 137) % s, (i * 59) % s, 1.6 + (i % 3) * 0.7, 0, Math.PI * 2);
        g.fill();
      }
      // edge warning stripes
      g.fillStyle = "#d8a03c";
      g.fillRect(4, 0, 7, s);
      g.fillRect(s - 11, 0, 7, s);
      // lane divider dashes at 1/3 and 2/3
      g.fillStyle = "#f3e6c2";
      for (const x of [s / 3 - 2, (2 * s) / 3 - 2]) {
        g.fillRect(x, 0, 4, s * 0.55);
      }
      // cross tie at the tile seam
      g.fillStyle = "rgba(40,26,16,0.35)";
      g.fillRect(0, 0, s, 6);
    });
    this.trackTex.repeat.set(1, 26);
    const track = new THREE.Mesh(
      new THREE.PlaneGeometry(7.4, 260),
      new THREE.MeshStandardMaterial({ map: this.trackTex, roughness: 0.95 }),
    );
    track.rotation.x = -Math.PI / 2;
    track.position.set(0, 0, -110);
    track.receiveShadow = true;
    this.scene.add(track);

    this.buildScenery();
    this.buildCharacter();
    this.buildDust();
    this.resize();
    window.addEventListener("resize", this.resize);
  }

  private rand(): number {
    this.rngState = (this.rngState * 1103515245 + 12345) & 0x7fffffff;
    return this.rngState / 0x7fffffff;
  }

  private resize = () => {
    const w = this.wrap.clientWidth || window.innerWidth;
    const h = this.wrap.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  /* ------------------------------ scenery ------------------------------ */

  private buildClouds() {
    // soft clustered puffs: several overlapping squashed spheres per
    // cloud, smooth shading so they read as one billowy mass
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
    const matWarm = new THREE.MeshStandardMaterial({ color: 0xfff3da, roughness: 1 });
    for (let i = 0; i < 7; i++) {
      const grp = new THREE.Group();
      const m = this.rand() < 0.5 ? mat : matWarm;
      const n = 5 + Math.floor(this.rand() * 3);
      for (let j = 0; j < n; j++) {
        const r = 1.7 + this.rand() * 2.1;
        const s = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), m);
        const t = n === 1 ? 0.5 : j / (n - 1);
        s.position.set((t - 0.5) * 7.5 + (this.rand() - 0.5) * 1.2, Math.sin(t * Math.PI) * 1.1 + this.rand() * 0.5, (this.rand() - 0.5) * 2.2);
        s.scale.set(1.15, 0.5 + this.rand() * 0.14, 0.85);
        grp.add(s);
      }
      grp.position.set((this.rand() - 0.5) * 130, 24 + this.rand() * 14, -40 - i * 26);
      this.scene.add(grp);
      this.clouds.push({ group: grp, dist: 40 + i * 26 + this.rand() * 10 });
    }
  }

  /** greens shared by all tree species — 2-3 tones picked per tree */
  private pickGreen(palette: number[]): THREE.MeshStandardMaterial {
    return std(palette[Math.floor(this.rand() * palette.length)]!, 1);
  }

  /** layered pine: tapered trunk + 3 stacked canopy tiers, each tier a
   *  slightly offset squashed cone so the silhouette is not a stamp */
  private makeTree(): THREE.Group {
    const grp = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.32, 2.1, 7), std(0x6e4a26, 1));
    trunk.position.y = 1.05;
    trunk.castShadow = true;
    grp.add(trunk);
    const greens = [0x2f6b2e, 0x3a7d33, 0x478a38];
    const tiers: [number, number, number][] = [
      [1.95, 2.5, 2.6],
      [1.5, 2.2, 4.05],
      [1.0, 1.9, 5.35],
    ];
    tiers.forEach(([r, h, y], i) => {
      const c = new THREE.Mesh(new THREE.ConeGeometry(r, h, 9), this.pickGreen(greens));
      c.position.set((this.rand() - 0.5) * 0.22, y, (this.rand() - 0.5) * 0.22);
      c.rotation.y = this.rand() * Math.PI;
      c.castShadow = i < 2;
      grp.add(c);
    });
    grp.rotation.z = (this.rand() - 0.5) * 0.05;
    return grp;
  }

  /** round-crown tree: forked trunk + a cluster of 5 canopy blobs in
   *  mixed greens, plus a low side blob so no two crowns match */
  private makeRoundTree(): THREE.Group {
    const grp = new THREE.Group();
    const trunkMat = std(0x74522c, 1);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.38, 2.3, 7), trunkMat);
    trunk.position.y = 1.15;
    trunk.castShadow = true;
    grp.add(trunk);
    for (const sx of [-1, 1]) {
      const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 1.1, 6), trunkMat);
      branch.position.set(0.42 * sx, 2.45, 0);
      branch.rotation.z = -0.7 * sx;
      grp.add(branch);
    }
    const greens = [0x4c8a3c, 0x5da047, 0x3f7d33];
    const blobs: [number, number, number, number][] = [
      [0, 3.9, 0, 1.85],
      [1.15, 3.25, 0.3, 1.3],
      [-1.1, 3.35, -0.25, 1.25],
      [0.45, 3.15, -0.75, 1.05],
      [-0.4, 4.45, 0.45, 1.1],
    ];
    for (const [x, y, z, r] of blobs) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), this.pickGreen(greens));
      s.position.set(x + (this.rand() - 0.5) * 0.3, y + (this.rand() - 0.5) * 0.25, z);
      s.scale.y = 0.88;
      s.castShadow = true;
      grp.add(s);
    }
    grp.rotation.z = (this.rand() - 0.5) * 0.06;
    return grp;
  }

  /** tall poplar: slim trunk and a narrow stacked teardrop canopy */
  private makePoplar(): THREE.Group {
    const grp = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.24, 3.1, 7), std(0x7a5a30, 1));
    trunk.position.y = 1.55;
    trunk.castShadow = true;
    grp.add(trunk);
    const greens = [0x6aa844, 0x7cb350, 0x5c9a3e];
    const layers: [number, number, number][] = [
      [0.95, 3.6, 1.5],
      [0.8, 5.1, 1.25],
      [0.55, 6.5, 1.0],
    ];
    for (const [r, y, sy] of layers) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 10), this.pickGreen(greens));
      s.position.set((this.rand() - 0.5) * 0.15, y, 0);
      s.scale.set(1, sy * 1.7, 1);
      s.castShadow = true;
      grp.add(s);
    }
    grp.rotation.z = (this.rand() - 0.5) * 0.07;
    return grp;
  }

  private houseWindow(w: number, h: number): THREE.Group {
    const g = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, h + 0.16, 0.07), std(0xf7f2e2, 0.8));
    g.add(frame);
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, 0.09),
      new THREE.MeshStandardMaterial({ color: 0xbfe3f2, emissive: 0xffc36b, emissiveIntensity: 0.35, roughness: 0.25 }),
    );
    g.add(glass);
    const barV = new THREE.Mesh(new THREE.BoxGeometry(0.06, h, 0.1), std(0xf7f2e2, 0.8));
    g.add(barV);
    const barH = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, 0.1), std(0xf7f2e2, 0.8));
    g.add(barH);
    return g;
  }

  /** gabled roof prism (triangular cross-section, apex up) with an
   *  eave slab overhanging the walls on every side */
  private gableRoof(width: number, depth: number, height: number, color: number): THREE.Group {
    const g = new THREE.Group();
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, 0);
    shape.lineTo(width / 2, 0);
    shape.lineTo(0, height);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.translate(0, 0, -depth / 2);
    const roof = new THREE.Mesh(geo, std(color, 0.9));
    roof.position.y = -height / 2;
    roof.castShadow = true;
    g.add(roof);
    const eave = new THREE.Mesh(new THREE.BoxGeometry(width + 0.45, 0.14, depth + 0.45), std(0x8a5a34, 0.95));
    eave.position.y = -height / 2 - 0.02;
    g.add(eave);
    return g;
  }

  /** houses: 3 variants — cottage (porch + fence snippet), tall house
   *  (blue-grey roof, side chimney), small barn-style (gable ends).
   *  Front (+Z) carries door + windows; buildScenery turns the front
   *  toward the track. */
  private makeHouse(): THREE.Group {
    const grp = new THREE.Group();
    const variant = Math.floor(this.rand() * 3);
    const walls = [0xf3e9cf, 0xf7ecc9, 0xefe3c2, 0xf1dfb4];
    const roofs = [0xb5502f, 0x9c4a2e, 0x7d8fa3, 0xa0522d];
    const wallColor = walls[Math.floor(this.rand() * walls.length)]!;
    const roofColor = roofs[Math.floor(this.rand() * roofs.length)]!;
    const tall = variant === 1;
    const W = tall ? 4.2 : 5.0;
    const H = tall ? 4.3 : 3.2;
    const D = 4.2;
    const base = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), std(wallColor, 0.95));
    base.position.y = H / 2;
    base.castShadow = true;
    base.receiveShadow = true;
    grp.add(base);
    // stone footing strip
    const footing = new THREE.Mesh(new THREE.BoxGeometry(W + 0.24, 0.4, D + 0.24), std(0xa39a8a, 1));
    footing.position.y = 0.2;
    grp.add(footing);
    const roof = this.gableRoof(W + 0.7, D + 0.9, tall ? 2.0 : 1.8, roofColor);
    roof.position.y = H + (tall ? 0.85 : 0.75);
    grp.add(roof);
    // chimney with cap
    const chim = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.5, 0.62), std(0xb08a6a, 0.95));
    chim.position.set(W * 0.28, H + 1.15, variant === 1 ? -D * 0.22 : D * 0.18);
    chim.castShadow = true;
    grp.add(chim);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.16, 0.8), std(0x8a6a4e, 0.95));
    cap.position.set(chim.position.x, H + 1.95, chim.position.z);
    grp.add(cap);
    // door + step + knob
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.9, 0.09), std(variant === 2 ? 0x5d7d4a : 0x7a4a26, 0.85));
    door.position.set(-W * 0.22, 0.95, D / 2 + 0.05);
    grp.add(door);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), std(0xd8a03c, 0.4, 0.6));
    knob.position.set(-W * 0.22 + 0.32, 0.95, D / 2 + 0.13);
    grp.add(knob);
    const step = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.16, 0.6), std(0xa39a8a, 1));
    step.position.set(-W * 0.22, 0.08, D / 2 + 0.32);
    grp.add(step);
    // front windows flanking the door + one on the upper floor / side
    const win1 = this.houseWindow(0.85, 0.95);
    win1.position.set(W * 0.26, 1.75, D / 2 + 0.04);
    grp.add(win1);
    if (tall) {
      const win2 = this.houseWindow(0.8, 0.9);
      win2.position.set(W * 0.2, 3.35, D / 2 + 0.04);
      grp.add(win2);
      const win3 = this.houseWindow(0.8, 0.9);
      win3.position.set(-W * 0.24, 3.35, D / 2 + 0.04);
      grp.add(win3);
    }
    const sideWin = this.houseWindow(0.8, 0.9);
    sideWin.position.set(W / 2 + 0.04, 1.8, 0.4);
    sideWin.rotation.y = Math.PI / 2;
    grp.add(sideWin);
    // the chase camera sees the wall opposite the front — it gets a
    // window too, so no house ever shows a blank wall to the player
    const backSideWin = this.houseWindow(0.8, 0.9);
    backSideWin.position.set(-W / 2 - 0.04, 1.8, -0.3);
    backSideWin.rotation.y = -Math.PI / 2;
    grp.add(backSideWin);
    if (variant === 0) {
      // little porch: slab roof on two posts over the door
      const porchRoof = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 1.1), std(roofColor, 0.9));
      porchRoof.position.set(-W * 0.22, 2.25, D / 2 + 0.55);
      porchRoof.rotation.x = 0.12;
      grp.add(porchRoof);
      for (const px of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.2, 0.12), std(0x8a6238, 1));
        post.position.set(-W * 0.22 + px * 0.95, 1.1, D / 2 + 0.95);
        grp.add(post);
      }
      // short fence run in front of the yard
      const fence = this.makeFenceRun();
      fence.rotation.y = Math.PI / 2;
      fence.position.set(W * 0.3, 0, D / 2 + 1.7);
      fence.scale.setScalar(0.75);
      grp.add(fence);
    }
    if (variant === 2) {
      // barn-style: cross braces on the gable end
      for (const rz of [-0.6, 0.6]) {
        const brace = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.6, 0.06), std(0x7a4a26, 0.9));
        brace.position.set(W / 2 + 0.05, 1.6, 0);
        brace.rotation.x = rz;
        brace.rotation.y = Math.PI / 2;
        grp.add(brace);
      }
    }
    return grp;
  }

  private makeFenceRun(): THREE.Group {
    const grp = new THREE.Group();
    const mat = std(0x8a6238, 1);
    const capMat = std(0x744d24, 1);
    for (let i = 0; i < 5; i++) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.15, 0.18), mat);
      post.position.set(0, 0.57, -i * 1.6);
      post.castShadow = true;
      grp.add(post);
      const capTop = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.16, 4), capMat);
      capTop.position.set(0, 1.22, -i * 1.6);
      capTop.rotation.y = Math.PI / 4;
      grp.add(capTop);
    }
    for (const y of [0.42, 0.88]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 6.6), mat);
      rail.position.set(0, y, -3.2);
      rail.rotation.z = (this.rand() - 0.5) * 0.012;
      grp.add(rail);
    }
    return grp;
  }

  /** flower patch: low foliage blobs + instanced flower heads in
   *  mixed colours — one instanced draw for all the blooms */
  private makeFlowerPatch(): THREE.Group {
    const grp = new THREE.Group();
    const leafMat = this.pickGreen([0x55873a, 0x639a44, 0x4c7f36]);
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.55 + this.rand() * 0.3, 9, 8), leafMat);
      b.position.set((this.rand() - 0.5) * 1.6, 0.28, (this.rand() - 0.5) * 1.4);
      b.scale.y = 0.6;
      grp.add(b);
    }
    const count = 14;
    const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 7, 6), new THREE.MeshStandardMaterial({ roughness: 0.7 }), count);
    const dummy = new THREE.Object3D();
    const colors = [0xf28bb4, 0xffd94d, 0xffffff, 0xe85d4f, 0xb07fe8];
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      dummy.position.set((this.rand() - 0.5) * 2.1, 0.52 + this.rand() * 0.25, (this.rand() - 0.5) * 1.8);
      dummy.scale.setScalar(0.8 + this.rand() * 0.7);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      inst.setColorAt(i, col.setHex(colors[Math.floor(this.rand() * colors.length)]!));
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    grp.add(inst);
    return grp;
  }

  /** grass tuft: instanced blades — one draw per tuft */
  private makeGrassTuft(): THREE.Group {
    const grp = new THREE.Group();
    const count = 9;
    const inst = new THREE.InstancedMesh(new THREE.ConeGeometry(0.09, 0.85, 5), std(0x5c9440, 1), count);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      dummy.position.set((this.rand() - 0.5) * 0.9, 0.4, (this.rand() - 0.5) * 0.9);
      dummy.rotation.set((this.rand() - 0.5) * 0.45, 0, (this.rand() - 0.5) * 0.45);
      dummy.scale.set(1, 0.7 + this.rand() * 0.8, 1);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    grp.add(inst);
    return grp;
  }

  /** leafy bush: flattened blob cluster, no trunk */
  private makeBush(): THREE.Group {
    const grp = new THREE.Group();
    const greens = [0x4c8a3c, 0x5da047, 0x679c46];
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.55 + this.rand() * 0.35, 10, 8), this.pickGreen(greens));
      s.position.set((this.rand() - 0.5) * 1.1, 0.45 + this.rand() * 0.25, (this.rand() - 0.5) * 0.9);
      s.scale.y = 0.75;
      s.castShadow = true;
      grp.add(s);
    }
    return grp;
  }

  /** hay bale: a lying cylinder with two darker binding bands */
  private makeHayBale(): THREE.Group {
    const grp = new THREE.Group();
    const bale = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 1.15, 12), std(0xd9b45c, 1));
    bale.rotation.z = Math.PI / 2;
    bale.position.y = 0.85;
    bale.castShadow = true;
    grp.add(bale);
    for (const bx of [-0.34, 0.34]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.045, 6, 18), std(0xa8823c, 1));
      band.position.set(bx, 0.85, 0);
      band.rotation.y = Math.PI / 2;
      grp.add(band);
    }
    const end = new THREE.Mesh(new THREE.CircleGeometry(0.8, 12), std(0xc7a44e, 1));
    end.position.set(0.59, 0.85, 0);
    end.rotation.y = Math.PI / 2;
    grp.add(end);
    return grp;
  }

  private makeRock(): THREE.Group {
    const grp = new THREE.Group();
    const n = 2 + Math.floor(this.rand() * 2);
    for (let i = 0; i < n; i++) {
      const rock = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.5 + this.rand() * 0.65, 0),
        std(i % 2 ? 0x9a9a92 : 0x8d8d84, 1),
      );
      rock.position.set((this.rand() - 0.5) * 1.3, 0.3 + this.rand() * 0.15, (this.rand() - 0.5) * 1.1);
      rock.scale.y = 0.65 + this.rand() * 0.3;
      rock.rotation.set(this.rand() * 3, this.rand() * 3, 0);
      rock.castShadow = true;
      grp.add(rock);
    }
    return grp;
  }

  /** distant hill: rounded dome (squashed sphere), soft green that the
   *  fog melts into the sky at range */
  private makeHill(): THREE.Group {
    const grp = new THREE.Group();
    const r = 15 + this.rand() * 11;
    const hill = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), std(this.rand() < 0.5 ? 0x5d8a4c : 0x527f42, 1));
    hill.scale.y = 0.34 + this.rand() * 0.1;
    hill.position.y = -0.6;
    grp.add(hill);
    const bump = new THREE.Mesh(new THREE.SphereGeometry(r * 0.55, 12, 9), std(0x648f50, 1));
    bump.scale.y = 0.36;
    bump.position.set(r * 0.5, -0.5, r * 0.2);
    grp.add(bump);
    return grp;
  }

  private buildScenery() {
    // weighted kinds: trees dominate, houses punctuate, small props
    // fill the gaps — denser than before but the placement corridor is
    // unchanged (|x| >= 5.6 keeps the track + sightlines clear)
    type Kind = "pine" | "round" | "poplar" | "house" | "fence" | "rock" | "flower" | "tuft" | "bush" | "hay";
    const bag: Kind[] = [
      "pine", "pine", "round", "round", "poplar", "house", "house",
      "fence", "flower", "flower", "tuft", "bush", "rock", "hay", "pine", "round",
    ];
    const make = (kind: Kind): THREE.Group => {
      switch (kind) {
        case "pine": return this.makeTree();
        case "round": return this.makeRoundTree();
        case "poplar": return this.makePoplar();
        case "house": return this.makeHouse();
        case "fence": return this.makeFenceRun();
        case "rock": return this.makeRock();
        case "flower": return this.makeFlowerPatch();
        case "tuft": return this.makeGrassTuft();
        case "bush": return this.makeBush();
        case "hay": return this.makeHayBale();
      }
    };
    const COUNT = 48;
    for (let i = 0; i < COUNT; i++) {
      const kind = bag[Math.floor(this.rand() * bag.length)]!;
      const grp = make(kind);
      const side = i % 2 === 0 ? -1 : 1;
      const near = i % 5 !== 4;
      const houseFar = kind === "house" && !near;
      grp.position.x = side * (near ? 5.7 + this.rand() * 5.2 : 13.5 + this.rand() * 9);
      const baseScale = houseFar ? 1.5 : near ? 0.85 + this.rand() * 0.4 : 1.35 + this.rand() * 0.3;
      grp.scale.setScalar(baseScale);
      if (kind === "house") {
        // front (+Z local: door/windows) faces the track
        grp.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
        grp.rotation.y += (this.rand() - 0.5) * 0.22;
      } else if (kind === "fence") {
        grp.rotation.y = (this.rand() - 0.5) * 0.3;
      } else {
        grp.rotation.y = this.rand() * Math.PI * 2;
      }
      this.scene.add(grp);
      this.scenery.push({ group: grp, dist: 6 + i * 4.4 + this.rand() * 2.6 });
    }
    for (let i = 0; i < 8; i++) {
      const hill = this.makeHill();
      const side = i % 2 === 0 ? -1 : 1;
      hill.position.x = side * (36 + this.rand() * 28);
      this.scene.add(hill);
      this.scenery.push({ group: hill, dist: 60 + i * 42 + this.rand() * 18 });
    }
  }

  /* ------------------------------ character ------------------------------ */

  /** Character rig: the shared root groups plus the effects that hang
   *  off the character (shield bubble, jetpack, dizzy stars). The
   *  character itself is ALWAYS its real GLB model, attached by
   *  loadGlbModel() — there is no code-built stand-in. The lobby gate
   *  only starts a run once the model is ready, so by the time this
   *  view exists the GLB is already parsed and attach is instant. */
  private buildCharacter() {
    const root = this.hamster;
    root.add(this.hamsterBody);

    // shield bubble
    this.shieldBubble = new THREE.Mesh(
      new THREE.SphereGeometry(1.45, 20, 14),
      new THREE.MeshStandardMaterial({
        color: 0x7ce79b,
        transparent: true,
        opacity: 0.22,
        roughness: 0.15,
        depthWrite: false,
      }),
    );
    this.shieldBubble.position.y = 1.05;
    this.shieldBubble.visible = false;
    root.add(this.shieldBubble);

    // jetpack — strapped to the back (the side the camera sees), visible
    // only while the 飞行器 power-up lasts; flame cones flicker in update()
    const packMat = std(0xe86a1e, 0.45, 0.25);
    const tankMat = std(0xd8dde2, 0.35, 0.5);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.62, 0.2), packMat);
    pack.position.set(0, 0.95, 0.52);
    pack.castShadow = true;
    this.jetpack.add(pack);
    for (const sx of [-1, 1]) {
      const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.34, 4, 8), tankMat);
      tank.position.set(0.17 * sx, 1.0, 0.56);
      this.jetpack.add(tank);
    }
    const flameMat = new THREE.MeshStandardMaterial({
      color: 0xffb340,
      emissive: 0xff7b1c,
      emissiveIntensity: 1.6,
      roughness: 0.4,
      transparent: true,
      opacity: 0.9,
    });
    this.jetFlameL = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.42, 8), flameMat);
    this.jetFlameR = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.42, 8), flameMat);
    this.jetFlameL.position.set(-0.17, 0.42, 0.56);
    this.jetFlameR.position.set(0.17, 0.42, 0.56);
    this.jetFlameL.rotation.x = Math.PI;
    this.jetFlameR.rotation.x = Math.PI;
    this.jetpack.add(this.jetFlameL);
    this.jetpack.add(this.jetFlameR);
    this.jetpack.visible = false;
    this.hamsterBody.add(this.jetpack);

    // dizzy stars — a ring of gold stars that circles the head during the
    // real-crash演出； hidden at all other times
    const starTex = canvasTexture((g, s) => {
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? s * 0.42 : s * 0.18;
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const x = s / 2 + Math.cos(a) * r;
        const y = s / 2 + Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.fillStyle = "#ffd83d";
      g.fill();
      g.strokeStyle = "#e8a812";
      g.lineWidth = 3;
      g.stroke();
    }, 64);
    for (let i = 0; i < 5; i++) {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: starTex, transparent: true, depthWrite: false }),
      );
      const a = (i / 5) * Math.PI * 2;
      sp.position.set(Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55);
      sp.scale.setScalar(0.34);
      this.dizzyStars.add(sp);
    }
    this.dizzyStars.position.y = 2.45;
    this.dizzyStars.visible = false;
    root.add(this.dizzyStars);

    root.position.set(0, 0, 0);
    this.scene.add(root);

    // sun shadow follows the hamster
    this.sunLight.target = root;

    void this.loadGlbModel();
  }

  /* --------------------- GLB models --------------------- */

  /**
   * Attach the character's one and only model: imdpepe goes through the
   * skinned path, the five hamsters through the textured path. The
   * lobby gate guarantees the GLB is already loaded before a run can
   * start, so a failure here means the load broke between the gate and
   * the run — it is reported to the Runner as an explicit error, never
   * papered over with a substitute model.
   */
  private async loadGlbModel() {
    const ok =
      this.meta.id === "imdpepe"
        ? await this.attachFrogGlb()
        : await this.attachTexturedGlb(CHARACTER_GLB_URLS[this.meta.id as CharIdArg]);
    if (this.disposed) return;
    if (!ok) {
      this.onModelError?.(
        getCharacterModelError(this.meta.id) ?? "GLB load failed",
      );
    }
  }

  /** Register an attached GLB group for the fade-in: its materials start
   *  fully transparent and update() eases opacity to 1, then restores
   *  opaque rendering. Materials were cloned per run, so this never
   *  touches the shared preload cache. */
  private beginModelFade(group: THREE.Group) {
    this.fadeMats = [];
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (!this.fadeMats.includes(m)) this.fadeMats.push(m);
        }
      }
    });
    for (const m of this.fadeMats) {
      m.transparent = true;
      m.opacity = 0;
    }
    this.modelFade = 0;
  }

  /**
   * Textured boneless GLB: one fused mesh with a PBR baseColor texture.
   * 栗子's TRELLIS file has its origin at the model's centre
   * (y ≈ -0.5..+0.5) and no normals; the 混元 files sit on their feet
   * (min.y = 0) at ~1.07 units tall. The Box3 alignment below handles
   * both: scale to the standard ~2.3-unit character height, lift by
   * −min.y so the feet sit exactly on the track plane, centre x/z.
   * Keep the model's own material/texture; only rebuild missing normals.
   */
  private async attachTexturedGlb(url: string): Promise<boolean> {
    try {
      const gltf = await loadGltfCached(url);
      if (this.disposed) return false;
      // clone the cached scene (and its materials) so this run owns its
      // copy — the cache stays pristine for the next run
      const model = gltf.scene.clone(true);
      model.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.castShadow = true;
          if (!obj.geometry.getAttribute("normal")) obj.geometry.computeVertexNormals();
          const mats = (Array.isArray(obj.material) ? obj.material : [obj.material]).map((m) => m.clone());
          obj.material = Array.isArray(obj.material) ? mats : mats[0]!;
          for (const m of mats) {
            if (m instanceof THREE.MeshStandardMaterial) {
              if (m.map) {
                m.map.colorSpace = THREE.SRGBColorSpace;
                m.map.anisotropy = 4;
              }
              m.roughness = Math.max(m.roughness, 0.85);
              m.metalness = 0;
            }
          }
        }
      });
      // Align to the standard character size: ~2.3 units tall, feet
      // exactly on the ground plane (origin is mid-body, so lift by
      // min.y), and horizontally centred.
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      if (!(size.y > 0)) throw new Error("模型尺寸异常");
      const s = 2.3 / size.y;
      model.scale.setScalar(s);
      model.position.set(-center.x * s, -box.min.y * s, -center.z * s);
      const group = new THREE.Group();
      group.add(model);
      // The source views (front/side/back renders the model was checked
      // against) put the face on +Z and the tail/scarf tails on -Z; the
      // runner travels toward -Z with the camera behind at +Z, so turn it
      // around — verified against the in-game frame in audit.
      group.rotation.y = Math.PI;
      this.hamsterBody.add(group);
      this.modelGroup = group;
      this.usingModel = true;
      this.beginModelFade(group);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * imdpepe's rigged GLB: a skinned humanoid (23 joints, standard names
   * Hips/Spine/…/LeftUpLeg/…) with NO animation clips — the run cycle is
   * driven per-bone in animateFrog(). Axis facts, measured from the file
   * at build time (not assumed): the mesh-local positions are Z-up
   * (height 0→1.33 along +Z), but the file's own wrapper nodes already
   * rotate that into glTF Y-up, so the loaded scene stands on y=0 at
   * 1.33 tall — the same Box3 alignment as the boneless models applies,
   * with NO extra root rotation. The toes point toward +Z, exactly like
   * the hamsters' faces, so the same 180° Y turn puts its back to the
   * chase camera. Cloning MUST go through SkeletonUtils.clone: a plain
   * scene.clone() leaves the SkinnedMesh bound to the cached original's
   * skeleton, and the cloned bones would not move the mesh.
   */
  private async attachFrogGlb(): Promise<boolean> {
    try {
      const gltf = await loadGltfCached(imdpepeGlbUrl as string);
      if (this.disposed) return false;
      const model = skeletonClone(gltf.scene) as THREE.Group;
      let foundSkin = false;
      model.traverse((obj) => {
        if (obj instanceof THREE.SkinnedMesh) {
          foundSkin = true;
          // skinned bounds follow the bones, not the static geometry —
          // never let frustum culling hide the frog mid-pose
          obj.frustumCulled = false;
        }
        if (obj instanceof THREE.Mesh) {
          obj.castShadow = true;
          if (!obj.geometry.getAttribute("normal")) obj.geometry.computeVertexNormals();
          const mats = (Array.isArray(obj.material) ? obj.material : [obj.material]).map((m) => m.clone());
          obj.material = Array.isArray(obj.material) ? mats : mats[0]!;
          for (const m of mats) {
            if (m instanceof THREE.MeshStandardMaterial) {
              if (m.map) {
                m.map.colorSpace = THREE.SRGBColorSpace;
                m.map.anisotropy = 4;
              }
              m.roughness = Math.max(m.roughness, 0.85);
              m.metalness = 0;
            }
          }
        }
      });
      if (!foundSkin) throw new Error("青蛙模型没有蒙皮");
      // collect the skeleton, remembering every bone's rest orientation —
      // poses are rest * (local-Z swing), measured per bone below
      this.frogBones.clear();
      for (const name of [
        "Hips", "Spine", "Spine1", "Spine2", "Head",
        "LeftArm", "LeftForeArm", "RightArm", "RightForeArm",
        "LeftUpLeg", "LeftLeg", "LeftFoot", "RightUpLeg", "RightLeg", "RightFoot",
      ]) {
        const obj = model.getObjectByName(name);
        if (obj) this.frogBones.set(name, { obj, rest: obj.quaternion.clone() });
      }
      for (const need of ["LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg"]) {
        if (!this.frogBones.has(need)) throw new Error("青蛙骨骼不完整");
      }
      // Same alignment as the boneless textured models: ~2.3 units tall,
      // feet exactly on the track plane, horizontally centred, back to
      // the camera (toes/face point +Z in the file, runner heads −Z).
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      if (!(size.y > 0)) throw new Error("模型尺寸异常");
      const s = 2.3 / size.y;
      model.scale.setScalar(s);
      model.position.set(-center.x * s, -box.min.y * s, -center.z * s);
      const group = new THREE.Group();
      group.add(model);
      group.rotation.y = Math.PI;
      this.hamsterBody.add(group);
      this.modelGroup = group;
      this.usingFrog = true;
      this.beginModelFade(group);
      return true;
    } catch {
      this.frogBones.clear();
      return false;
    }
  }

  private frogTmpQ = new THREE.Quaternion();
  private frogTmpE = new THREE.Euler();

  /** Pose one frog bone: rest orientation swung by deltaZ about the
   *  bone's own local Z and twisted by deltaY about its local Y (the
   *  bone's length axis — used for pelvis/shoulder counter-rotation).
   *  The swing axis/signs were measured from this exact file at build
   *  time by rotating each bone and watching its child joint move in
   *  world space: for every limb bone the local Z is the forward/back
   *  swing axis; on the left side +Z swings the limb forward, on the
   *  right side −Z does (mirrored bind poses), knees bend with the shin
   *  swinging back (+Z left / −Z right), and the Spine leans forward
   *  toward −Z. The formulas below fold those signs in per bone.
   *  deltaX is a third measured axis, used only on the Arm bones: the
   *  bind pose is a T (arms horizontal), and local +X is the axis that
   *  lowers an arm out of it — the same + rotation on both sides drops
   *  the hand from shoulder height to the hip (at ≈+83° the elbow sits
   *  directly under the shoulder, forearm hanging straight down). */
  private setFrogBone(name: string, deltaZ: number, deltaY = 0, deltaX = 0) {
    const b = this.frogBones.get(name);
    if (!b) return;
    this.frogTmpQ.setFromEuler(this.frogTmpE.set(deltaX, deltaY, deltaZ));
    b.obj.quaternion.copy(b.rest).multiply(this.frogTmpQ);
  }

  /** Ready-pose blend for the frog: 1 while standing by (countdown /
   *  pre-start), 0 in any action pose. Starts at 1 so the very first
   *  posed frame is already the ready stance — the T bind pose never
   *  shows. Damped toward its target in animateFrog (τ ≈ 70 ms, so a
   *  full ease takes ~250 ms) — the countdown→run transition is a
   *  continuous blend, never a pose snap. */
  private frogReadyBlend = 1;
  private frogReadyLastT = -1;

  /**
   * Per-bone frog animation — a HUMAN run cycle, deliberately unlike
   * the hamsters' whole-body bounce (imdpepe only; the five hamsters
   * keep the shared root-group animation untouched). `phase` arrives
   * pre-scaled to a human stride length (≈1.7 m per L+R cycle, so the
   * frequency still follows game speed via distance):
   * - thighs swing ±0.87 rad (≈50°) antiphase about the hips;
   * - the swinging leg's knee flexes hard (up to ~1.5 rad) to recover
   *   through, peaking just before mid-swing, while the stance leg
   *   stays near-straight to push off; feet roll with the stride;
   * - arms pump antiphase to their own side's leg with the elbow held
   *   near 90°, like a person running;
   * - torso leans forward ~10°, pelvis and shoulders counter-rotate
   *   about the vertical (local-Y twist on Hips vs Spine2), and the
   *   head counter-twists to stay facing forward;
   * - the centre-of-mass bob lives on the root in update() (two small
   *   rises per stride cycle, synced to this same phase).
   * Jump is a human takeoff: lead leg drives forward and tucks, trail
   * leg extends back, both arms swing up. Slide is a low crouch: front
   * leg stretched ahead near-straight, rear leg folded under, torso
   * leaned back (the frog-specific root crouch in update() adds the
   * low body position — not the hamster pancake squash). Flight trails
   * the limbs behind, blended by flightBlend. Crash keeps the seated
   * bone pose under the shared root演出.
   */
  private animateFrog(
    phase: number,
    jumping: boolean,
    sliding: boolean,
    runningNow: boolean,
    flightBlend = 0,
    tSec = 0,
    crashed = false,
  ) {
    if (this.frogBones.size === 0) return;
    const s = Math.sin(phase);
    // ---- human run cycle (base pose everything else blends from) ----
    const A = 0.87; // thigh swing amplitude ≈ 50°
    let thighL = A * s;
    let thighR = A * s;
    // knee recovery: flex peaks just before the leg swings through
    // (cos shifted +0.45), stance leg keeps only a soft base bend
    const flexL = 0.18 + 1.35 * Math.pow(Math.max(0, Math.cos(phase + 0.45)), 1.5);
    const flexR = 0.18 + 1.35 * Math.pow(Math.max(0, Math.cos(phase + Math.PI + 0.45)), 1.5);
    let shinL = flexL;
    let shinR = -flexR;
    let footL = 0.3 * Math.sin(phase - 0.9);
    let footR = -0.3 * Math.sin(phase + Math.PI - 0.9);
    // arm pump: antiphase to the same-side leg, elbow held near 90°
    let armL = -0.55 * s;
    let armR = -0.55 * s;
    let foreL = 1.05 + 0.15 * s;
    let foreR = -(1.05 + 0.15 * s);
    let spine = -0.17 - 0.02 * Math.sin(phase * 2);
    let spine1 = -0.1;
    // pelvis/shoulder counter-rotation + head stabilisation (twists)
    let hipsTwist = 0.09 * s;
    let shoulderTwist = -0.12 * s;
    let headTwist = 0.07 * s;
    let headZ = 0.03 * Math.sin(phase * 2);
    // ---- ready stance (countdown / pre-start) ----
    // The bind pose is a T, so "near-rest" standing reads as arms held
    // out horizontal — bizarre on the start line. Instead, whenever
    // the frog is standing by, the pose blends to a sprinter's ready
    // stance: arms LOWERED to the sides (the Arm bones' local-X drop,
    // ≈83° out of the T), elbows softly bent, torso tipped forward,
    // knees slightly bent, breathing through the spine. frogReadyBlend
    // eases over ~250 ms both ways, so the start of the run grows out
    // of the stance instead of snapping from it.
    const dtReady =
      this.frogReadyLastT >= 0 ? Math.min(0.05, Math.max(0, tSec - this.frogReadyLastT)) : 0;
    this.frogReadyLastT = tSec;
    const readyTarget =
      !runningNow && !jumping && !sliding && !crashed && flightBlend < 0.05 ? 1 : 0;
    this.frogReadyBlend +=
      (readyTarget - this.frogReadyBlend) * (1 - Math.exp(-dtReady / 0.07));
    if (Math.abs(readyTarget - this.frogReadyBlend) < 0.002) {
      this.frogReadyBlend = readyTarget;
    }
    const rb = this.frogReadyBlend;
    let armDropX = 0;
    if (rb > 0.001) {
      const mix = (a: number, b: number) => a + (b - a) * rb;
      thighL = mix(thighL, 0.16);
      thighR = mix(thighR, 0.16);
      shinL = mix(shinL, 0.24);
      shinR = mix(shinR, -0.24);
      footL = mix(footL, 0);
      footR = mix(footR, 0);
      armL = mix(armL, 0.05);
      armR = mix(armR, 0.05);
      foreL = mix(foreL, 0.35);
      foreR = mix(foreR, -0.35);
      spine = mix(spine, -0.15 - 0.015 * Math.sin(tSec * 2));
      spine1 = mix(spine1, -0.08);
      hipsTwist = mix(hipsTwist, 0);
      shoulderTwist = mix(shoulderTwist, 0);
      headTwist = mix(headTwist, 0);
      headZ = mix(headZ, 0);
      armDropX = 1.45 * rb;
    }
    if (jumping) {
      // human takeoff: lead leg forward + tucked, trail leg extended
      // back, arms swung up, slight forward drive through the torso
      thighL = 1.0; thighR = -0.7;
      shinL = 1.45; shinR = -0.3;
      footL = 0.35; footR = -0.5;
      armL = 0.85; armR = -0.85;
      foreL = 0.7; foreR = -0.7;
      spine = -0.08; spine1 = -0.05;
      hipsTwist = 0.05; shoulderTwist = -0.06; headTwist = 0.03; headZ = 0;
    } else if (sliding) {
      // low crouch slide: front leg stretched ahead, rear leg folded
      // under the body, torso leaned back, arms back for balance
      thighL = 1.15; thighR = -0.55;
      shinL = 0.12; shinR = -1.85;
      footL = 0.3; footR = -0.2;
      armL = -0.5; armR = 0.5;
      foreL = 0.5; foreR = -0.5;
      spine = 0.22; spine1 = 0.12;
      hipsTwist = 0; shoulderTwist = 0; headTwist = 0; headZ = 0;
    }
    if (flightBlend > 0) {
      // flying: limbs trail behind the body, run cycle freezes out
      const fb = flightBlend;
      thighL += (-0.5 - thighL) * fb;
      thighR += (0.5 - thighR) * fb;
      shinL += (0.35 - shinL) * fb;
      shinR += (-0.35 - shinR) * fb;
      armL += (-0.9 - armL) * fb;
      armR += (0.9 - armR) * fb;
      foreL += (0.4 - foreL) * fb;
      foreR += (-0.4 - foreR) * fb;
      spine += (-0.15 - spine) * fb;
    }
    if (crashed) {
      // seated bone pose under the root演出's turn + squash: thighs
      // forward like sitting on the ground, shins folded back down,
      // forearms raised beside the head (the "holding my head" read)
      const ct = this.crashT >= 0 ? tSec - this.crashT : 0;
      const sit = 1 - Math.pow(1 - Math.min(1, Math.max(0, ct / 0.6)), 3);
      thighL += (1.18 - thighL) * sit;
      thighR += (-1.06 - thighR) * sit;
      shinL += (1.2 - shinL) * sit;
      shinR += (-1.2 - shinR) * sit;
      armL += (0.55 - armL) * sit;
      armR += (-0.55 - armR) * sit;
      foreL += (1.6 - foreL) * sit;
      foreR += (-1.6 - foreR) * sit;
      spine += (-0.28 - spine) * sit;
      spine1 += (-0.16 - spine1) * sit;
      hipsTwist *= 1 - sit;
      shoulderTwist *= 1 - sit;
      headTwist *= 1 - sit;
    }
    this.setFrogBone("LeftUpLeg", thighL);
    this.setFrogBone("RightUpLeg", thighR);
    this.setFrogBone("LeftLeg", shinL);
    this.setFrogBone("RightLeg", shinR);
    this.setFrogBone("LeftFoot", footL);
    this.setFrogBone("RightFoot", footR);
    this.setFrogBone("LeftArm", armL, 0, armDropX);
    this.setFrogBone("RightArm", armR, 0, armDropX);
    this.setFrogBone("LeftForeArm", foreL);
    this.setFrogBone("RightForeArm", foreR);
    this.setFrogBone("Spine", spine);
    this.setFrogBone("Spine1", spine1);
    this.setFrogBone("Spine2", spine1 * 0.7, shoulderTwist);
    this.setFrogBone("Hips", 0, hipsTwist);
    this.setFrogBone("Head", headZ, headTwist);
  }

  /**
   * Whole-body animation for the hamster GLBs: each is a single fused
   * mesh with no named nodes and no bones, so the run feel comes from
   * the root group — a gentle side sway while running (the vertical bob,
   * jump lift, slide squash and lane lean are applied to the shared
   * hamster groups in update()).
   */
  private animateModel(phase: number, jumping: boolean, sliding: boolean, runningNow: boolean, flightBlend = 0) {
    const g = this.modelGroup;
    if (!g) return;
    if (jumping) {
      g.rotation.z = 0;
      g.rotation.x = -0.1;
    } else if (sliding) {
      g.rotation.z = 0;
      g.rotation.x = 0.12;
    } else if (runningNow) {
      g.rotation.z = Math.sin(phase) * 0.045;
      g.rotation.x = 0;
    } else {
      g.rotation.z = 0;
      g.rotation.x = 0;
    }
    if (flightBlend > 0) {
      // flying: all run sway freezes out — the dive pitch lives on the
      // shared hamsterBody in update(), this group just goes still
      g.rotation.z *= 1 - flightBlend;
      g.rotation.x *= 1 - flightBlend;
    }
  }

  private buildDust() {
    const n = 90;
    this.dustPos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.dustPos[i * 3] = (this.rand() - 0.5) * 3;
      this.dustPos[i * 3 + 1] = this.rand() * 0.7;
      this.dustPos[i * 3 + 2] = 0.5 + this.rand() * 3.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.dustPos, 3));
    const sprite = canvasTexture((g, s) => {
      const grad = g.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
      grad.addColorStop(0, "rgba(255,240,210,0.85)");
      grad.addColorStop(1, "rgba(255,240,210,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
    }, 64);
    const mat = new THREE.PointsMaterial({
      size: 0.34,
      map: sprite,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.dust = new THREE.Points(geo, mat);
    this.scene.add(this.dust);
  }

  /* ------------------------------ obstacles / items ------------------------------ */

  private makeObstacle(kind: "hurdle" | "beam" | "crate" | "puddle" | "mover"): THREE.Group {
    const grp = new THREE.Group();
    if (kind === "hurdle") {
      const postMat = std(0x3a2c20, 1);
      for (const sx of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.95, 0.14), postMat);
        post.position.set(1.02 * sx, 0.47, 0);
        post.castShadow = true;
        grp.add(post);
      }
      const stripeTex = canvasTexture((g, s) => {
        g.fillStyle = "#ffd319";
        g.fillRect(0, 0, s, s);
        g.fillStyle = "#231600";
        for (let i = -1; i < 5; i++) {
          g.save();
          g.translate(i * 64, 0);
          g.rotate(0.6);
          g.fillRect(0, -40, 30, s + 80);
          g.restore();
        }
      }, 128);
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(2.2, 0.42, 0.12),
        new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.8 }),
      );
      bar.position.y = 0.78;
      bar.castShadow = true;
      grp.add(bar);
    } else if (kind === "beam") {
      const postMat = std(0x3a2c20, 1);
      for (const sx of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.6, 0.16), postMat);
        post.position.set(1.05 * sx, 1.3, 0);
        post.castShadow = true;
        grp.add(post);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.52, 0.3), std(0x87431f, 0.9));
      beam.position.y = 1.98;
      beam.castShadow = true;
      grp.add(beam);
      const signTex = canvasTexture((g, s) => {
        g.fillStyle = "#ffd319";
        g.fillRect(0, 0, s, s);
        g.fillStyle = "#5a3410";
        g.font = `bold ${this.lang === "en" ? s * 0.3 : s * 0.42}px sans-serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(this.lang === "en" ? "DUCK" : "低头", s / 2, s / 2 + 2);
      }, 128);
      const sign = new THREE.Mesh(
        new THREE.BoxGeometry(0.95, 0.4, 0.06),
        new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.8 }),
      );
      sign.position.set(0, 1.98, 0.19);
      grp.add(sign);
    } else if (kind === "crate") {
      const crateTex = canvasTexture((g, s) => {
        g.fillStyle = "#9a6b3f";
        g.fillRect(0, 0, s, s);
        g.strokeStyle = "#6e4a26";
        g.lineWidth = 10;
        g.strokeRect(5, 5, s - 10, s - 10);
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(s, s);
        g.moveTo(s, 0);
        g.lineTo(0, s);
        g.stroke();
        g.fillStyle = "#b5854f";
        g.fillRect(0, 0, s, s * 0.14);
      }, 128);
      const crate = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 1.5, 1.1),
        new THREE.MeshStandardMaterial({ map: crateTex, roughness: 0.95 }),
      );
      crate.position.y = 0.75;
      crate.castShadow = true;
      grp.add(crate);
    }
    if (kind === "puddle") {
      // flat reflective puddle: slows you down, never kills
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.95, 0.95, 0.05, 22),
        new THREE.MeshStandardMaterial({ color: 0x3f7fae, roughness: 0.15, metalness: 0.25 }),
      );
      disc.position.y = 0.03;
      disc.scale.z = 1.5;
      grp.add(disc);
      const shine = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.55, 0.06, 18),
        new THREE.MeshStandardMaterial({ color: 0x9fd0ee, roughness: 0.1, transparent: true, opacity: 0.55 }),
      );
      shine.position.set(0.18, 0.035, 0.25);
      shine.scale.z = 1.4;
      grp.add(shine);
    } else if (kind === "mover") {
      // spiky rolling boulder that patrols sideways inside its lane
      const ball = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.62, 0),
        std(0xb0502e, 0.85),
      );
      ball.position.y = 0.62;
      ball.castShadow = true;
      grp.add(ball);
      const bandRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.64, 0.05, 8, 20),
        std(0x5a3410, 0.8),
      );
      bandRing.position.y = 0.62;
      bandRing.rotation.y = Math.PI / 3;
      grp.add(bandRing);
    }
    return grp;
  }

  private makeSeed(): THREE.Group {
    const grp = new THREE.Group();
    const seedTex = canvasTexture((g, s) => {
      g.fillStyle = "#2e2019";
      g.fillRect(0, 0, s, s);
      g.strokeStyle = "#e8d9ae";
      g.lineWidth = 9;
      for (const x of [s * 0.3, s * 0.5, s * 0.7]) {
        g.beginPath();
        g.moveTo(x, 6);
        g.lineTo(x, s - 6);
        g.stroke();
      }
    }, 64);
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.21, 12, 10),
      new THREE.MeshStandardMaterial({ map: seedTex, roughness: 0.5 }),
    );
    m.scale.set(0.75, 1.15, 0.45);
    m.castShadow = true;
    grp.add(m);
    return grp;
  }

  private makePower(kind: PowerKind): THREE.Group {
    const grp = new THREE.Group();
    const HALO: Record<PowerKind, number> = {
      shield: 0x58b368,
      magnet: 0xe05252,
      flight: 0x39c2d7,
      boost: 0xf5c542,
      double: 0xb07fe8,
      sneak: 0x7ed492,
    };
    const haloColor = HALO[kind];
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.52, 0.045, 8, 28),
      new THREE.MeshStandardMaterial({
        color: haloColor,
        emissive: haloColor,
        emissiveIntensity: 0.45,
        roughness: 0.4,
      }),
    );
    grp.add(halo);
    if (kind === "shield") {
      const shield = new THREE.Mesh(
        new THREE.SphereGeometry(0.34, 14, 10),
        std(0x58b368, 0.45),
      );
      shield.scale.set(0.85, 1.05, 0.4);
      grp.add(shield);
      const checkMat = std(0xeaffef, 0.4);
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.09, 0.05), checkMat);
      c1.position.set(-0.05, -0.02, 0.15);
      c1.rotation.z = -0.7;
      grp.add(c1);
      const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.09, 0.05), checkMat);
      c2.position.set(0.08, 0.05, 0.15);
      c2.rotation.z = 0.6;
      grp.add(c2);
    } else if (kind === "magnet") {
      const mag = new THREE.Mesh(
        new THREE.TorusGeometry(0.26, 0.11, 10, 20, Math.PI),
        std(0xe05252, 0.4),
      );
      mag.rotation.z = Math.PI;
      grp.add(mag);
      const tipMat = std(0xf3f3f3, 0.4);
      for (const sx of [-1, 1]) {
        const tip = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.18, 0.2), tipMat);
        tip.position.set(0.26 * sx, 0, 0);
        grp.add(tip);
      }
    } else if (kind === "flight") {
      // mini jetpack: orange body, twin silver tanks, wing fins, flame cone
      const bodyM = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.22, 4, 10), std(0xe86a1e, 0.45, 0.25));
      bodyM.castShadow = true;
      grp.add(bodyM);
      const tankMat = std(0xd8dde2, 0.35, 0.5);
      for (const sx of [-1, 1]) {
        const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.2, 4, 8), tankMat);
        tank.position.set(0.21 * sx, 0.02, 0);
        grp.add(tank);
        const wing = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.16), std(0x39c2d7, 0.5));
        wing.position.set(0.36 * sx, 0.17, 0);
        wing.rotation.z = sx * -0.25;
        grp.add(wing);
      }
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.13, 0.34, 10),
        new THREE.MeshStandardMaterial({
          color: 0xffb340,
          emissive: 0xff7b1c,
          emissiveIntensity: 1.4,
          roughness: 0.4,
        }),
      );
      flame.position.y = -0.38;
      flame.rotation.x = Math.PI;
      grp.add(flame);
    } else if (kind === "boost") {
      // lightning bolt: two slanted bars
      const boltMat = new THREE.MeshStandardMaterial({
        color: 0xffd83d,
        emissive: 0xa87b00,
        emissiveIntensity: 0.55,
        roughness: 0.35,
      });
      const top = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.46, 0.09), boltMat);
      top.position.set(0.07, 0.16, 0);
      top.rotation.z = 0.5;
      grp.add(top);
      const bottom = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.46, 0.09), boltMat);
      bottom.position.set(-0.07, -0.16, 0);
      bottom.rotation.z = 0.5;
      grp.add(bottom);
    } else if (kind === "double") {
      // gold disc stamped with x2
      const discTex = canvasTexture((g, s) => {
        g.fillStyle = "#f5c542";
        g.fillRect(0, 0, s, s);
        g.fillStyle = "#7a4d00";
        g.font = `bold ${s * 0.42}px sans-serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText("×2", s / 2, s / 2 + 2);
      }, 128);
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.34, 0.34, 0.09, 24),
        new THREE.MeshStandardMaterial({ map: discTex, roughness: 0.35, metalness: 0.35 }),
      );
      disc.rotation.x = Math.PI / 2;
      grp.add(disc);
    } else {
      // sneak: spring coil under a shoe sole
      const coilMat = std(0xd8dde2, 0.35, 0.6);
      for (let i = 0; i < 3; i++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2 - i * 0.03, 0.035, 8, 20), coilMat);
        ring.position.y = -0.22 + i * 0.13;
        ring.rotation.x = Math.PI / 2;
        grp.add(ring);
      }
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.09, 0.24), std(0xe05252, 0.55));
      sole.position.y = 0.24;
      sole.castShadow = true;
      grp.add(sole);
      const toe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.24), std(0xf3f3f3, 0.55));
      toe.position.set(0.32, 0.26, 0);
      grp.add(toe);
    }
    return grp;
  }

  private obtain(pool: Map<string, THREE.Group[]> | THREE.Group[], key: string, factory: () => THREE.Group): THREE.Group {
    const list = Array.isArray(pool) ? pool : (pool.get(key) ?? []);
    let grp = list.pop();
    if (!grp) {
      grp = factory();
    }
    if (!Array.isArray(pool) && !pool.has(key)) pool.set(key, list);
    grp.visible = true;
    this.scene.add(grp);
    return grp;
  }

  private release(pool: Map<string, THREE.Group[]> | THREE.Group[], key: string, grp: THREE.Group) {
    grp.visible = false;
    this.scene.remove(grp);
    if (Array.isArray(pool)) pool.push(grp);
    else {
      const list = pool.get(key) ?? [];
      list.push(grp);
      pool.set(key, list);
    }
  }

  /** Gold puff burst at the point a seed is collected — the seed is
   *  already gone (picked up in front of the body), this sells the grab. */
  private spawnBurst(pos: THREE.Vector3, tSec: number) {
    if (!this.burstTex) {
      this.burstTex = canvasTexture((g, s) => {
        const grad = g.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
        grad.addColorStop(0, "rgba(255,214,90,0.95)");
        grad.addColorStop(0.55, "rgba(255,180,60,0.55)");
        grad.addColorStop(1, "rgba(255,180,60,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, s, s);
      }, 64);
    }
    let sprite = this.burstPool.pop();
    if (!sprite) {
      sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: this.burstTex, transparent: true, depthWrite: false }),
      );
    } else {
      (sprite.material as THREE.SpriteMaterial).map = this.burstTex;
    }
    sprite.position.copy(pos);
    sprite.scale.setScalar(0.35);
    (sprite.material as THREE.SpriteMaterial).opacity = 0.95;
    sprite.visible = true;
    this.scene.add(sprite);
    this.bursts.push({ sprite, t0: tSec });
  }

  /* ------------------------------ per-frame update ------------------------------ */

  update(sim: RunnerSim, tSec: number) {
    const dist = sim.distance;
    // sim distances are hamster heights (§1.1); the rendered world runs
    // 1.5 world units per height so the visual speed matches the feel
    const W = 1.5;
    const wDist = dist * W;
    // scrolling world textures
    this.trackTex.offset.y = (wDist % 10) / 10;
    this.grassTex.offset.y = (wDist % 8.66) / 8.66;

    // scenery streaming
    for (const item of this.scenery) {
      let rel = item.dist - wDist;
      if (rel < -14) {
        item.dist += 210 + this.rand() * 30;
        rel = item.dist - wDist;
      }
      item.group.position.z = -rel;
    }
    for (const item of this.clouds) {
      let rel = item.dist - wDist * 0.92;
      if (rel < -20) {
        item.dist += 260;
        rel = item.dist - wDist * 0.92;
      }
      item.group.position.z = -rel;
    }

    // hamster animation
    const laneX = sim.lanePos * LANE_W;
    const jumpY = sim.jumpHeight * 1.7;
    const running = sim.tick > 0 && !sim.crashed;
    const phase = wDist * 4.4;
    // the frog runs a HUMAN stride: a longer cycle (≈1.7 m per L+R
    // stride instead of the hamsters' ≈0.95 m scamper), and its COM
    // bob below follows this same phase — no hamster bounce for it
    const frogPhase = phase * 0.55;
    // flight pose blend: eases toward 1 while the 飞行器 lasts, back to 0
    // when it ends — the dive pose and the frozen legs ride on this, and
    // the run cycle resumes smoothly instead of snapping back
    const flyTarget = sim.flightTicks > 0 ? 1 : 0;
    this.flightBlend += (flyTarget - this.flightBlend) * 0.09;
    if (Math.abs(flyTarget - this.flightBlend) < 0.02) this.flightBlend = flyTarget;
    const fb = this.flightBlend;
    const runBob =
      running && sim.jumpTick <= 0
        ? Math.abs(Math.sin(this.usingFrog ? frogPhase : phase)) * (this.usingFrog ? 0.07 : 0.09)
        : 0;
    // while flying the run bob is replaced by a gentle hover float
    const bob = runBob * (1 - fb) + Math.sin(tSec * 2.1) * 0.07 * fb;
    this.hamster.position.set(laneX, jumpY + bob, 0);
    // lean into lane changes + slight forward pitch that grows with speed
    const lean = THREE.MathUtils.clamp((sim.targetLane - sim.lanePos) * -0.35, -0.4, 0.4);
    this.hamsterBody.rotation.z = lean;
    this.hamsterBody.rotation.y = lean * 0.7;
    const sliding = sim.sliding;
    if (sliding && this.usingFrog) {
      // frog slide: a low human crouch (hips drop, torso tips back a
      // touch) — NOT the hamsters' pancake squash; the stretched front
      // leg and folded rear leg are bone poses in animateFrog().
      // The squash must pull the frog's head BELOW the beam's bottom
      // edge (1.72 world): at scale 0.82 the 2.3-tall humanoid's top
      // sat at ≈1.79 and grazed through the beam; 0.74 with a −0.16
      // drop puts the top at ≈1.54, clear by ≈0.18.
      this.hamsterBody.scale.set(1.04, 0.74, 1.02);
      this.hamsterBody.position.y = -0.16;
      this.hamsterBody.rotation.x = 0.26;
    } else if (sliding) {
      this.hamsterBody.scale.set(1.15, 0.55, 1.05);
      this.hamsterBody.position.y = -0.32;
      this.hamsterBody.rotation.x = 0.35;
    } else if (sim.jumpTick > 0 && this.usingFrog) {
      // frog jump: near-neutral root — the takeoff reads from the
      // bones (lead leg tucked, trail leg extended), no hamster squash
      this.hamsterBody.scale.set(0.98, 1.03, 0.98);
      this.hamsterBody.position.y = 0;
      this.hamsterBody.rotation.x = -0.08;
    } else if (sim.jumpTick > 0) {
      this.hamsterBody.scale.set(0.96, 1.06, 0.96);
      this.hamsterBody.position.y = 0;
      this.hamsterBody.rotation.x = -0.14;
    } else {
      this.hamsterBody.scale.set(1, 1, 1);
      this.hamsterBody.position.y = 0;
      this.hamsterBody.rotation.x = sim.crashed ? 0.9 : 0.06 + sim.speed * 0.002;
    }
    if (fb > 0) {
      // dive pose: whole body pitches nose-down ≈ -31° (head forward and
      // down, toward -Z), squash/jump offsets ease out — flight height and
      // timing stay the sim's, this is presentation only
      const hx = this.hamsterBody.rotation.x;
      this.hamsterBody.rotation.x = hx + (-0.55 - hx) * fb;
      const cs = this.hamsterBody.scale;
      cs.set(
        1 + (cs.x - 1) * (1 - fb),
        1 + (cs.y - 1) * (1 - fb),
        1 + (cs.z - 1) * (1 - fb),
      );
      this.hamsterBody.position.y *= 1 - fb;
    }
    // ---- real-crash dizzy演出 (presentation only; sim.crashed is set
    // solely by an unblocked fatal hit — shield saves, boost/skill
    // smashes and flight never reach here). The model is one fused
    // boneless mesh, so the "sits down holding its head, dizzy" read is
    // faked whole-body: turn 180° to face the camera, drop into a sit
    // with a slight lean-back, wobble in a small circle, stars overhead.
    if (sim.crashed) {
      if (this.crashT < 0) this.crashT = tSec;
      const ct = tSec - this.crashT;
      const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
      const turn = ease(ct / 0.55);
      const sit = ease(ct / 0.6);
      // GROUNDED SIT — the sit is anchored to the track plane, never
      // below it. hamsterBody's origin is the feet plane (y = 0) and the
      // squash scales about that origin, so a vertical squash alone
      // reads as "sitting down" with the feet/bottom planted at y = 0.
      // The previous version also pushed hamsterBody.position.y to
      // −0.4, which sank the whole model under the track (半个身位遁地).
      // Now: no negative offset at all — the only downward motion is a
      // mid-air crash settling back to the ground (position.y eases to
      // exactly 0, never past it), plus the squash itself.
      this.hamster.position.y = Math.max(0, this.hamster.position.y * (1 - sit));
      // slight recoil off the obstacle face in the first ~0.13s: the
      // sim already stopped the body in front of the mesh (CRASH_STOP
      // gap), this small bounce-back sells the impact and widens the
      // visible separation before the sit settles
      this.hamster.position.z = 0.16 * Math.min(1, ct / 0.13);
      this.hamsterBody.rotation.y = Math.PI * turn;
      this.hamsterBody.scale.set(1 + 0.1 * sit, 1 - 0.2 * sit, 1 + 0.05 * sit);
      this.hamsterBody.position.y = 0;
      this.hamsterBody.rotation.x = 0.18 * sit;
      // dizzy sway once seated: z and x oscillate a quarter-period apart
      // so the wobble traces a small circle, like a head going round
      const swayT = Math.max(0, ct - 0.45);
      const amp = 0.11 * Math.min(1, swayT / 0.25);
      this.hamsterBody.rotation.z = Math.sin(swayT * 6.5) * amp;
      this.hamsterBody.rotation.x += Math.sin(swayT * 6.5 - Math.PI / 2) * amp * 0.55;
      // ring of stars circling ABOVE the seated head: the star group
      // follows the head's current height every frame (full standing
      // height × the live squash, plus this frame's settle offset), so
      // the ring hovers over the head instead of ending up projected
      // onto the road ahead. The stars are camera-facing sprites, so
      // the ring stays a 3D ring around the head from the chase view.
      this.dizzyStars.visible = ct > 0.3;
      if (this.dizzyStars.visible) {
        this.dizzyStars.rotation.y = ct * 4.6;
        const seatedHeadTop = 2.3 * this.hamsterBody.scale.y;
        this.dizzyStars.position.y =
          this.hamster.position.y + seatedHeadTop + 0.34 + Math.sin(ct * 5.2) * 0.04;
      }
    }
    // character animation: the frog is posed per-bone; the hamster GLBs
    // are fused meshes animated whole-body from the root group
    if (this.usingFrog) {
      this.animateFrog(frogPhase, sim.jumpTick > 0, sliding, running, fb, tSec, sim.crashed);
    } else if (this.usingModel) {
      this.animateModel(phase, sim.jumpTick > 0, sliding, running, fb);
    }
    // invulnerability blink after a shield save
    this.hamsterBody.visible = !(sim.invulnTicks > 0 && sim.tick % 6 < 3);
    this.shieldBubble.visible = sim.shield > 0;
    if (this.shieldBubble.visible) {
      const s = 1 + Math.sin(tSec * 3) * 0.03;
      this.shieldBubble.scale.setScalar(s);
    }
    // jetpack shows while flying; its twin flames flicker out of phase
    this.jetpack.visible = sim.flightTicks > 0;
    if (this.jetpack.visible) {
      const flick = 0.85 + Math.sin(tSec * 41) * 0.25 + Math.sin(tSec * 67) * 0.12;
      this.jetFlameL.scale.set(1, flick, 1);
      this.jetFlameR.scale.set(1, Math.max(0.3, 1.7 - flick), 1);
    }

    // dust kicked up behind the hamster
    this.dust.position.set(laneX, 0.05, 0.4);
    const pos = this.dustPos;
    const n = pos.length / 3;
    for (let i = 0; i < n; i++) {
      pos[i * 3 + 2] = pos[i * 3 + 2]! + 0.06 + sim.speed * 0.002;
      pos[i * 3 + 1] = pos[i * 3 + 1]! + 0.008;
      if (pos[i * 3 + 2]! > 4.2) {
        pos[i * 3] = laneX * 0 + (this.rand() - 0.5) * 1.4;
        pos[i * 3 + 1] = 0.05 + this.rand() * 0.25;
        pos[i * 3 + 2] = 0.4;
      }
    }
    (this.dust.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.dust.material as THREE.PointsMaterial).opacity =
      (sim.crashed ? 0 : sim.boostTicks > 0 ? 0.85 : 0.5) * (1 - 0.8 * fb);

    // GLB fade-in progress (only while a loaded model is fading in)
    if (this.modelFade < 1 && this.fadeMats.length > 0) {
      this.modelFade = Math.min(1, this.modelFade + 0.05);
      for (const m of this.fadeMats) m.opacity = this.modelFade;
      if (this.modelFade >= 1) {
        for (const m of this.fadeMats) {
          m.opacity = 1;
          m.transparent = false;
        }
        this.fadeMats = [];
      }
    }
    // seed-collect bursts: expand and fade over ~0.28s, then recycle
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i]!;
      const age = tSec - b.t0;
      if (age >= 0.28) {
        b.sprite.visible = false;
        this.scene.remove(b.sprite);
        this.burstPool.push(b.sprite);
        this.bursts.splice(i, 1);
      } else {
        b.sprite.scale.setScalar(0.35 + age * 3.4);
        (b.sprite.material as THREE.SpriteMaterial).opacity = 0.95 * (1 - age / 0.28);
      }
    }

    // obstacles: sync pool to sim state
    const seenObs = new Set<number>();
    for (const o of sim.obstacles) {
      const rel = (o.dist - dist) * W;
      if (rel < -4 || rel > 190) continue;
      seenObs.add(o.id);
      let grp = this.activeObstacles.get(o.id);
      if (!grp) {
        grp = this.obtain(this.obstaclePool, o.kind, () => this.makeObstacle(o.kind));
        grp.userData.kind = o.kind;
        this.activeObstacles.set(o.id, grp);
      }
      const effLane = o.kind === "mover" ? o.curLane : o.lane;
      grp.position.set(effLane * LANE_W, 0, -rel);
      if (o.kind === "mover") grp.rotation.y = tSec * 2 + o.phase;
    }
    for (const [id, grp] of this.activeObstacles) {
      if (!seenObs.has(id)) {
        const kind = (grp.userData.kind as string | undefined) ?? "crate";
        this.release(this.obstaclePool, kind, grp);
        this.activeObstacles.delete(id);
      }
    }
    // seeds
    const seenSeeds = new Set<number>();
    for (const s of sim.seeds) {
      if (s.taken) {
        // collected this frame (the sim now grabs seeds in front of the
        // body, before they can touch it) — puff a burst where it was
        const grp = this.activeSeeds.get(s.id);
        if (grp) this.spawnBurst(grp.position.clone(), tSec);
        continue;
      }
      const rel = (s.dist - dist) * W;
      if (rel < -2.5 || rel > 190) continue;
      seenSeeds.add(s.id);
      let grp = this.activeSeeds.get(s.id);
      if (!grp) {
        grp = this.obtain(this.seedPool, "seed", () => this.makeSeed());
        this.activeSeeds.set(s.id, grp);
      }
      // magnet pull: the sim homes the seed's lane/dist toward the hamster;
      // here its height glides from spawn height down to the hamster as
      // s.pull rises, so the attraction is actually visible.
      const baseY = s.air ? 1.55 : 0.42;
      const seedY = s.pull > 0 ? baseY + (1.05 - baseY) * s.pull : baseY;
      grp.position.set(s.lane * LANE_W, seedY, -rel);
      grp.rotation.y = tSec * (s.pull > 0 ? 9 : 2.6) + s.id;
    }
    for (const [id, grp] of this.activeSeeds) {
      if (!seenSeeds.has(id)) {
        this.release(this.seedPool, "seed", grp);
        this.activeSeeds.delete(id);
      }
    }
    // powers
    const seenPowers = new Set<number>();
    for (const p of sim.powers) {
      if (p.taken) continue;
      const rel = (p.dist - dist) * W;
      if (rel < -2.5 || rel > 190) continue;
      seenPowers.add(p.id);
      let grp = this.activePowers.get(p.id);
      if (!grp) {
        grp = this.obtain(this.powerPool, p.kind, () => this.makePower(p.kind));
        grp.userData.kind = p.kind;
        this.activePowers.set(p.id, grp);
      }
      grp.position.set(p.lane * LANE_W, 1.05 + Math.sin(tSec * 2.4 + p.id) * 0.12, -rel);
      grp.rotation.y = tSec * 1.8 + p.id;
    }
    for (const [id, grp] of this.activePowers) {
      if (!seenPowers.has(id)) {
        const kind = (grp.userData.kind as string | undefined) ?? "magnet";
        this.release(this.powerPool, kind, grp);
        this.activePowers.delete(id);
      }
    }

    // camera: chase view from behind-above, eases with the hamster's lane
    if (sim.crashed && !this.wasCrashed) this.shake = 0.55;
    this.wasCrashed = sim.crashed;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - 0.016);
    const shakeX = this.shake > 0 ? (this.rand() - 0.5) * this.shake * 0.5 : 0;
    const shakeY = this.shake > 0 ? (this.rand() - 0.5) * this.shake * 0.4 : 0;
    const camX = laneX * 0.55 + shakeX;
    this.camera.position.set(camX, 4.3 + jumpY * 0.25 + shakeY, 7.6);
    this.camera.lookAt(laneX * 0.85, 1.15 + (sim.flightTicks > 0 ? 0.7 : 0), -10);
    // boost eases the FOV wider for a sense of speed
    const targetFov = sim.boostTicks > 0 ? 70 : 62;
    if (Math.abs(this.camera.fov - targetFov) > 0.1) {
      this.camera.fov += (targetFov - this.camera.fov) * 0.12;
      this.camera.updateProjectionMatrix();
    }
    this.sunLight.position.set(laneX + 14, 20, -14);

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener("resize", this.resize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
        obj.geometry.dispose();
        const m = obj.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    });
  }
}
