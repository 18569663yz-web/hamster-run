import { useMusicMute } from "./music";
import { useLang } from "./i18n";

export function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M4 9v6h4l5 4V5L8 9H4z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {muted ? (
        <path d="M16 9l6 6M22 9l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      ) : (
        <path
          d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

/** Shared background-music mute toggle (lobby hero + in-game HUD). */
export function MuteButton({ className }: { className?: string }) {
  const { muted, toggle } = useMusicMute();
  const { t } = useLang();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={t.muteAria(muted)}
      aria-pressed={muted}
      className={
        className ??
        "flex items-center gap-1.5 rounded-full border border-[#e2ead8] bg-white/90 px-3 py-1.5 text-xs font-bold text-[#2e3d2a] shadow-[0_4px_14px_rgba(60,90,50,0.16)]"
      }
    >
      <SpeakerIcon muted={muted} />
      {muted ? t.musicOff : t.musicOn}
    </button>
  );
}
