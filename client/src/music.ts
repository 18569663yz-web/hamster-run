import { useEffect, useReducer } from "react";
import bgmLobbyUrl from "./assets/bgm-lobby-carefree.mp3";
import bgmGameUrl from "./assets/bgm-game-rocket-power.mp3";
import { storageGet, storageSet } from "./storage";

// Background music (both Kevin MacLeod, incompetech.com, CC BY 4.0):
//   "Carefree" — lobby / main menu, loops
//   "Rocket Power" — in-run, loops; ducked to 0.2 on the result screen
// Scene switches crossfade between the two tracks (the outgoing track is
// paused at its position, so coming back resumes mid-loop). Browsers block
// audio before the first user gesture, so playback starts on unlock().

export type MusicScene = "lobby" | "game" | "result";

type TrackName = "lobby" | "game";

const SCENE_TRACK: Record<MusicScene, TrackName> = {
  lobby: "lobby",
  game: "game",
  result: "game", // same track as the run, just ducked
};

const SCENE_VOLUME: Record<MusicScene, number> = {
  lobby: 0.5,
  game: 0.55,
  result: 0.2,
};

const MUTE_KEY = "hamster-bgm-muted";
const FADE_STEP_MS = 60;
const FADE_STEP = 0.07;

class MusicManager {
  muted =
    storageGet(MUTE_KEY) === "1";
  private scene: MusicScene = "lobby";
  private unlocked = false;
  private tracks: Record<TrackName, HTMLAudioElement> | null = null;
  private fadeTimer: number | null = null;
  private listeners = new Set<() => void>();

  private ensure(): Record<TrackName, HTMLAudioElement> {
    if (!this.tracks) {
      const lobby = new Audio(bgmLobbyUrl as string);
      lobby.loop = true;
      lobby.preload = "auto";
      lobby.volume = 0;
      const game = new Audio(bgmGameUrl as string);
      game.loop = true;
      game.preload = "auto";
      game.volume = 0;
      this.tracks = { lobby, game };
    }
    return this.tracks;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** Call from the first pointer/key gesture so autoplay rules allow play. */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.apply();
  }

  setScene(scene: MusicScene) {
    if (this.scene === scene) return;
    this.scene = scene;
    this.apply();
  }

  toggleMute() {
    this.muted = !this.muted;
    storageSet(MUTE_KEY, this.muted ? "1" : "0");
    this.apply();
    this.emit();
  }

  private apply() {
    if (typeof window === "undefined") return;
    const tracks = this.ensure();
    const want = SCENE_TRACK[this.scene];
    const goals: Record<TrackName, number> = { lobby: 0, game: 0 };
    if (!this.muted && this.unlocked) goals[want] = SCENE_VOLUME[this.scene];
    if (goals[want] > 0) {
      // start (or resume) the wanted track immediately; the fade raises it
      void tracks[want].play().catch(() => undefined);
    }
    if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer);
    this.fadeTimer = window.setInterval(() => {
      let settled = true;
      (Object.keys(goals) as TrackName[]).forEach((name) => {
        const el = tracks[name];
        const goal = goals[name]!;
        const diff = goal - el.volume;
        if (Math.abs(diff) <= FADE_STEP) {
          el.volume = goal;
        } else {
          el.volume += Math.sign(diff) * FADE_STEP;
          settled = false;
        }
        if (el.volume === 0 && goal === 0 && !el.paused) el.pause();
        if (Math.abs(el.volume - goal) > 0.001) settled = false;
      });
      if (settled && this.fadeTimer !== null) {
        window.clearInterval(this.fadeTimer);
        this.fadeTimer = null;
      }
    }, FADE_STEP_MS);
  }
}

export const music = new MusicManager();

/** Mute toggle state + action, shared by the lobby and the in-game HUD. */
export function useMusicMute(): { muted: boolean; toggle: () => void } {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => music.subscribe(force), []);
  return { muted: music.muted, toggle: () => music.toggleMute() };
}
