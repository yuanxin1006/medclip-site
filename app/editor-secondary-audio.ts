export type SecondaryAudioSourceType = "sound-effect" | "voice" | "imported-audio";

export type SecondaryAudioClip = {
  id: string;
  name: string;
  sourceUrl: string;
  sourceDurationMs: number;
  timelineStartMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  sourceType: SecondaryAudioSourceType;
};

export type SecondaryAudioMixEntry = Readonly<{
  clipId: string;
  timelineStartSeconds: number;
  sourceOffsetSeconds: number;
  durationSeconds: number;
  volume: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
}>;

export const MIN_SECONDARY_AUDIO_DURATION_MS = 50;

const finite = (value: unknown, fallback: number) => (
  typeof value === "number" && Number.isFinite(value) ? value : fallback
);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function secondaryAudioDurationMs(clip: SecondaryAudioClip) {
  return Math.max(0, clip.sourceEndMs - clip.sourceStartMs);
}

export function secondaryAudioEndMs(clip: SecondaryAudioClip) {
  return clip.timelineStartMs + secondaryAudioDurationMs(clip);
}

export function normalizeSecondaryAudioClip(clip: SecondaryAudioClip, projectDurationMs: number): SecondaryAudioClip {
  const projectDuration = Math.max(MIN_SECONDARY_AUDIO_DURATION_MS, Math.round(finite(projectDurationMs, 1_000)));
  const sourceDurationMs = Math.max(MIN_SECONDARY_AUDIO_DURATION_MS, Math.round(finite(clip.sourceDurationMs, MIN_SECONDARY_AUDIO_DURATION_MS)));
  const sourceStartMs = clamp(Math.round(finite(clip.sourceStartMs, 0)), 0, sourceDurationMs - MIN_SECONDARY_AUDIO_DURATION_MS);
  const requestedEnd = clamp(
    Math.round(finite(clip.sourceEndMs, sourceDurationMs)),
    sourceStartMs + MIN_SECONDARY_AUDIO_DURATION_MS,
    sourceDurationMs,
  );
  const sourceEndMs = Math.min(requestedEnd, sourceStartMs + projectDuration);
  const playableDurationMs = sourceEndMs - sourceStartMs;
  const timelineStartMs = clamp(
    Math.round(finite(clip.timelineStartMs, 0)),
    0,
    Math.max(0, projectDuration - playableDurationMs),
  );
  const fadeInMs = clamp(Math.round(finite(clip.fadeInMs, 0)), 0, playableDurationMs);
  const fadeOutMs = clamp(Math.round(finite(clip.fadeOutMs, 0)), 0, Math.max(0, playableDurationMs - fadeInMs));
  return {
    id: String(clip.id || ""),
    name: String(clip.name || "音频片段").slice(0, 160),
    sourceUrl: String(clip.sourceUrl || ""),
    sourceDurationMs,
    timelineStartMs,
    sourceStartMs,
    sourceEndMs,
    volume: clamp(finite(clip.volume, 1), 0, 1),
    fadeInMs,
    fadeOutMs,
    sourceType: ["sound-effect", "voice", "imported-audio"].includes(clip.sourceType)
      ? clip.sourceType
      : "imported-audio",
  };
}

export function validateSecondaryAudioClip(clip: SecondaryAudioClip, projectDurationMs: number) {
  const numeric = [
    clip.sourceDurationMs, clip.timelineStartMs, clip.sourceStartMs, clip.sourceEndMs,
    clip.volume, clip.fadeInMs, clip.fadeOutMs,
  ];
  if (!clip.id.trim() || !clip.name.trim() || !clip.sourceUrl.trim()) {
    return { valid: false, error: "Secondary audio identity, name, and source are required." };
  }
  if (!numeric.every(Number.isFinite) || !Number.isFinite(projectDurationMs)) {
    return { valid: false, error: "Secondary audio values must be finite." };
  }
  if (clip.sourceDurationMs < MIN_SECONDARY_AUDIO_DURATION_MS) {
    return { valid: false, error: "Secondary audio duration is invalid." };
  }
  if (clip.sourceStartMs < 0 || clip.sourceEndMs <= clip.sourceStartMs || clip.sourceEndMs > clip.sourceDurationMs) {
    return { valid: false, error: "Secondary audio trim range is invalid." };
  }
  if (clip.timelineStartMs < 0 || secondaryAudioEndMs(clip) > projectDurationMs) {
    return { valid: false, error: "Secondary audio is outside the project timeline." };
  }
  if (clip.volume < 0 || clip.volume > 1) return { valid: false, error: "Secondary audio volume is invalid." };
  if (clip.fadeInMs < 0 || clip.fadeOutMs < 0 || clip.fadeInMs + clip.fadeOutMs > secondaryAudioDurationMs(clip)) {
    return { valid: false, error: "Secondary audio fades exceed its playable duration." };
  }
  if (!["sound-effect", "voice", "imported-audio"].includes(clip.sourceType)) {
    return { valid: false, error: "Secondary audio source type is invalid." };
  }
  return { valid: true, error: "" };
}

export function createSecondaryAudioClip(input: Readonly<{
  id: string;
  name: string;
  sourceUrl: string;
  sourceDurationMs: number;
  timelineStartMs: number;
  projectDurationMs: number;
  sourceType: SecondaryAudioSourceType;
}>): SecondaryAudioClip {
  const clip = normalizeSecondaryAudioClip({
    id: input.id,
    name: input.name,
    sourceUrl: input.sourceUrl,
    sourceDurationMs: input.sourceDurationMs,
    timelineStartMs: input.timelineStartMs,
    sourceStartMs: 0,
    sourceEndMs: input.sourceDurationMs,
    volume: input.sourceType === "sound-effect" ? 0.8 : 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    sourceType: input.sourceType,
  }, input.projectDurationMs);
  const validation = validateSecondaryAudioClip(clip, input.projectDurationMs);
  if (!validation.valid) throw new RangeError(validation.error);
  return clip;
}

export function patchSecondaryAudioClip(clip: SecondaryAudioClip, patch: Partial<SecondaryAudioClip>, projectDurationMs: number) {
  return normalizeSecondaryAudioClip({ ...clip, ...patch }, projectDurationMs);
}

export function secondaryAudioClipsAt(clips: readonly SecondaryAudioClip[] | undefined, timelineMs: number) {
  const at = finite(timelineMs, 0);
  return (clips ?? []).filter((clip) => at >= clip.timelineStartMs && at < secondaryAudioEndMs(clip));
}

export function secondaryAudioGainAt(clip: SecondaryAudioClip, timelineMs: number) {
  if (timelineMs < clip.timelineStartMs || timelineMs >= secondaryAudioEndMs(clip)) return 0;
  const localMs = timelineMs - clip.timelineStartMs;
  const remainingMs = secondaryAudioDurationMs(clip) - localMs;
  const fadeInGain = clip.fadeInMs > 0 ? clamp(localMs / clip.fadeInMs, 0, 1) : 1;
  const fadeOutGain = clip.fadeOutMs > 0 ? clamp(remainingMs / clip.fadeOutMs, 0, 1) : 1;
  return clip.volume * Math.min(fadeInGain, fadeOutGain);
}

export function buildSecondaryAudioMixPlan(clips: readonly SecondaryAudioClip[] | undefined, projectDurationMs: number): SecondaryAudioMixEntry[] {
  return (clips ?? []).map((clip) => normalizeSecondaryAudioClip(clip, projectDurationMs))
    .filter((clip) => validateSecondaryAudioClip(clip, projectDurationMs).valid)
    .map((clip) => ({
      clipId: clip.id,
      timelineStartSeconds: clip.timelineStartMs / 1_000,
      sourceOffsetSeconds: clip.sourceStartMs / 1_000,
      durationSeconds: secondaryAudioDurationMs(clip) / 1_000,
      volume: clip.volume,
      fadeInSeconds: clip.fadeInMs / 1_000,
      fadeOutSeconds: clip.fadeOutMs / 1_000,
    }));
}
