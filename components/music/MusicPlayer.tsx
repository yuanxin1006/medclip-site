"use client";

import { useEffect, useRef, useState } from "react";

type MusicPlayerProps = {
  artist: string;
  disabled?: boolean;
  durationSeconds: number;
  error?: string | null;
  loading?: boolean;
  onRetry?: () => void;
  src?: string | null;
  title: string;
};

function formatTime(totalSeconds: number) {
  const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
  return `${Math.floor(safeSeconds / 60)}:${String(Math.floor(safeSeconds % 60)).padStart(2, "0")}`;
}

export default function MusicPlayer({
  artist,
  disabled = false,
  durationSeconds,
  error = null,
  loading = false,
  onRetry,
  src = null,
  title,
}: MusicPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [runtimeDuration, setRuntimeDuration] = useState(durationSeconds);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    setPosition(0);
    setRuntimeDuration(durationSeconds);
    setIsPlaying(false);
    setPlaybackError(null);
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    audio.load();
    return () => { audio.pause(); };
  }, [durationSeconds, src]);

  const unavailable = disabled || loading || !src || Boolean(error);
  const visibleError = error || playbackError;

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || unavailable) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    setPlaybackError(null);
    try {
      await audio.play();
    } catch {
      setPlaybackError("浏览器无法开始播放，请重试。");
      setIsPlaying(false);
    }
  };

  const seek = (nextPosition: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(nextPosition)) return;
    audio.currentTime = nextPosition;
    setPosition(nextPosition);
  };

  return (
    <section className={`music-player ${unavailable ? "is-disabled" : ""}`} aria-label="音乐播放器">
      <audio
        onDurationChange={(event) => {
          if (Number.isFinite(event.currentTarget.duration)) setRuntimeDuration(event.currentTarget.duration);
        }}
        onEnded={() => {
          setIsPlaying(false);
          setPosition(0);
        }}
        onError={() => {
          if (src) setPlaybackError("音频加载失败，签名链接可能已失效。");
          setIsPlaying(false);
        }}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        preload="metadata"
        ref={audioRef}
        src={src ?? undefined}
      />
      <button
        aria-label={isPlaying ? "暂停" : "播放"}
        className="music-player-control"
        disabled={unavailable}
        onClick={() => void togglePlayback()}
        type="button"
      >
        {loading ? "…" : isPlaying ? "Ⅱ" : "▶"}
      </button>
      <div className="music-player-meta">
        <strong>{title}</strong>
        <span>{artist}</span>
      </div>
      <span className="music-player-time">
        {formatTime(position)} / {formatTime(runtimeDuration)}
      </span>
      <input
        aria-label="播放进度"
        className="music-player-range"
        disabled={unavailable}
        max={Math.max(1, runtimeDuration)}
        min={0}
        onChange={(event) => seek(Number(event.target.value))}
        step="0.1"
        type="range"
        value={Math.min(position, Math.max(1, runtimeDuration))}
      />
      {visibleError && (
        <p className="music-player-error">
          {visibleError}
          {onRetry && <button onClick={onRetry} type="button">重新获取播放链接</button>}
        </p>
      )}
    </section>
  );
}
