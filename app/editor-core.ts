import { normalizeOverlay, type EditorOverlay } from "./editor-overlays.ts";
import { normalizeSecondaryAudioClip, type SecondaryAudioClip } from "./editor-secondary-audio.ts";

export type AudioSelectionMode = "full" | "range";
export type TimelineTrackType = "audio" | "video" | "broll" | "captions";
export type FitMode = "cover" | "contain" | "crop";
export type ClipPlacement = "BEFORE" | "AFTER";

export type AudioSelection = {
  mode: AudioSelectionMode;
  sourceDurationMs: number;
  sourceInMs: number;
  sourceOutMs: number;
  selectedDurationMs: number;
};

export type TimelineCaption = {
  id: string;
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  needsReview?: boolean;
  boundaryClipped?: boolean;
  /** Video ASR cue owned by this timeline clip. Other captions are independent. */
  videoClipId?: string;
  /** ASR text before script conversion or user edits. */
  recognizedText?: string;
  /** Normalized cue-local presentation. Missing values retain the legacy default. */
  x?: number;
  y?: number;
  color?: string;
  alignment?: "left" | "center" | "right";
  opacity?: number;
  fontSize?: number;
  provenance?: "ASR" | "IMPORTED_SRT" | "IMPORTED_VTT" | "IMPORTED_ASS" | "MANUAL";
};

export type SpeedPoint = {
  id: string;
  at: number;
  rate: number;
};

export type ClipTransform = {
  x: number;
  y: number;
  scale: number;
  crop: number;
  fit: FitMode;
};

export type ClipPositionScale = {
  x: number;
  y: number;
  scale: number;
};

export type TimelineClip = {
  id: string;
  assetId: string;
  name: string;
  kind: "视频" | "图片";
  trackId: string;
  timelineStartMs: number;
  timelineEndMs: number;
  sourceInMs: number;
  sourceOutMs: number;
  transform: ClipTransform;
  speedCurve: SpeedPoint[];
  reason?: string;
};

export type TimelineTrack = {
  id: string;
  type: TimelineTrackType;
  name: string;
  clips: TimelineClip[];
  muted?: boolean;
  locked?: boolean;
};

export type EditorAssetRef = {
  id: string;
  name: string;
  kind: "视频" | "图片";
  durationMs: number;
};

export type EditorProject = {
  schemaVersion: 2;
  id: string;
  title: string;
  updatedAt: string;
  durationMs: number;
  /** Legacy presets (9:16, 16:9, 1:1), or exact custom output pixels as "width:height". */
  ratio: string;
  audioSelection: AudioSelection;
  assets: EditorAssetRef[];
  tracks: TimelineTrack[];
  captions: TimelineCaption[];
  /** Optional for backward compatibility with projects saved before V2.6A. */
  overlays?: EditorOverlay[];
  /** Optional for backward compatibility with projects saved before V2.6B. */
  secondaryAudioClips?: SecondaryAudioClip[];
};

export const DEFAULT_TRANSFORM: ClipTransform = {
  x: 0,
  y: 0,
  scale: 1,
  crop: 0,
  fit: "cover"
};

export function isAIClipPositionScale(value: unknown): value is ClipPositionScale {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.x === "number"
    && Number.isFinite(candidate.x)
    && candidate.x >= -50
    && candidate.x <= 50
    && typeof candidate.y === "number"
    && Number.isFinite(candidate.y)
    && candidate.y >= -50
    && candidate.y <= 50
    && typeof candidate.scale === "number"
    && Number.isFinite(candidate.scale)
    && candidate.scale >= 0.25
    && candidate.scale <= 3;
}

export function applyClipPositionScale(
  clip: TimelineClip,
  positionScale: ClipPositionScale,
): TimelineClip {
  const transform = clip?.transform as unknown;
  if (
    !positionScale
    || typeof positionScale !== "object"
    || typeof positionScale.x !== "number"
    || !Number.isFinite(positionScale.x)
    || typeof positionScale.y !== "number"
    || !Number.isFinite(positionScale.y)
    || typeof positionScale.scale !== "number"
    || !Number.isFinite(positionScale.scale)
  ) {
    throw new RangeError("Clip position and scale values must be finite numbers.");
  }
  if (
    !transform
    || typeof transform !== "object"
    || Array.isArray(transform)
    || typeof (transform as Record<string, unknown>).x !== "number"
    || !Number.isFinite((transform as Record<string, unknown>).x)
    || typeof (transform as Record<string, unknown>).y !== "number"
    || !Number.isFinite((transform as Record<string, unknown>).y)
    || typeof (transform as Record<string, unknown>).scale !== "number"
    || !Number.isFinite((transform as Record<string, unknown>).scale)
    || typeof (transform as Record<string, unknown>).crop !== "number"
    || !Number.isFinite((transform as Record<string, unknown>).crop)
    || !["cover", "contain", "crop"].includes(String((transform as Record<string, unknown>).fit))
  ) {
    throw new RangeError("Clip transform must have finite position, scale, and crop values and a valid fit mode.");
  }
  return {
    ...clip,
    transform: {
      ...(transform as ClipTransform),
      x: positionScale.x,
      y: positionScale.y,
      scale: positionScale.scale,
    },
  };
}

export function applyClipPositionScaleToProject(
  project: EditorProject,
  clipId: string,
  positionScale: ClipPositionScale,
): EditorProject {
  const matches = project.tracks.flatMap((track) => track.clips)
    .filter((clip) => clip.id === clipId);
  if (!clipId || matches.length !== 1) {
    throw new RangeError("Clip position and scale mutation requires one existing clip ID.");
  }
  const target = matches[0];
  const updatedTarget = applyClipPositionScale(target, positionScale);
  if (
    target.transform.x === positionScale.x
    && target.transform.y === positionScale.y
    && target.transform.scale === positionScale.scale
  ) return project;
  return {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => clip.id === clipId
        ? updatedTarget
        : clip),
    })),
  };
}

export function clipPositionScaleCss(transform: Pick<ClipTransform, "x" | "y" | "scale">): string {
  return `translate(${transform.x}%, ${transform.y}%) scale(${transform.scale})`;
}

export function clipPositionScaleCanvasOffset(
  transform: Pick<ClipTransform, "x" | "y">,
  canvasWidth: number,
  canvasHeight: number,
) {
  return {
    x: canvasWidth * transform.x / 100,
    y: canvasHeight * transform.y / 100,
  };
}

export function recordProjectUndoSnapshot(
  history: readonly EditorProject[],
  snapshot: EditorProject,
  limit = 50,
): EditorProject[] {
  return [...history.slice(-(limit - 1)), cloneProject(snapshot)];
}

export const DEFAULT_SPEED_CURVE: SpeedPoint[] = [
  { id: "speed-start", at: 0, rate: 1 },
  { id: "speed-end", at: 1, rate: 1 }
];

export const MIN_CLIP_SPLIT_CHILD_DURATION_MS = 100;

export const SPEED_PRESETS: Record<string, SpeedPoint[]> = {
  标准: DEFAULT_SPEED_CURVE,
  渐快: [
    { id: "speed-start", at: 0, rate: 0.75 },
    { id: "speed-mid", at: 0.55, rate: 1 },
    { id: "speed-end", at: 1, rate: 1.8 }
  ],
  渐慢: [
    { id: "speed-start", at: 0, rate: 1.8 },
    { id: "speed-mid", at: 0.45, rate: 1 },
    { id: "speed-end", at: 1, rate: 0.75 }
  ],
  蒙太奇: [
    { id: "speed-start", at: 0, rate: 1 },
    { id: "speed-a", at: 0.22, rate: 2.5 },
    { id: "speed-b", at: 0.48, rate: 0.55 },
    { id: "speed-c", at: 0.75, rate: 1.8 },
    { id: "speed-end", at: 1, rate: 1 }
  ],
  子弹时间: [
    { id: "speed-start", at: 0, rate: 1 },
    { id: "speed-a", at: 0.35, rate: 1 },
    { id: "speed-b", at: 0.5, rate: 0.3 },
    { id: "speed-c", at: 0.68, rate: 1 },
    { id: "speed-end", at: 1, rate: 1 }
  ]
};

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function roundMs(value: number) {
  return Math.round(Number.isFinite(value) ? value : 0);
}

export function createFullAudioSelection(sourceDurationMs: number): AudioSelection {
  const duration = Math.max(0, roundMs(sourceDurationMs));
  return {
    mode: "full",
    sourceDurationMs: duration,
    sourceInMs: 0,
    sourceOutMs: duration,
    selectedDurationMs: duration
  };
}

export function normalizeAudioSelection(selection: AudioSelection): AudioSelection {
  const sourceDurationMs = Math.max(0, roundMs(selection.sourceDurationMs));
  if (selection.mode === "full") return createFullAudioSelection(sourceDurationMs);
  const sourceInMs = clamp(roundMs(selection.sourceInMs), 0, sourceDurationMs);
  const sourceOutMs = clamp(roundMs(selection.sourceOutMs), 0, sourceDurationMs);
  return {
    mode: "range",
    sourceDurationMs,
    sourceInMs,
    sourceOutMs,
    selectedDurationMs: Math.max(0, sourceOutMs - sourceInMs)
  };
}

export function validateAudioSelection(selection: AudioSelection) {
  const normalized = normalizeAudioSelection(selection);
  if (normalized.sourceInMs < 0) return { valid: false, error: "开始时间不能小于 0。" };
  if (normalized.sourceOutMs > normalized.sourceDurationMs) {
    return { valid: false, error: "结束时间不能超过音频总时长。" };
  }
  if (normalized.sourceOutMs <= normalized.sourceInMs) {
    return { valid: false, error: "结束时间必须晚于开始时间。" };
  }
  if (normalized.selectedDurationMs < 10) {
    return { valid: false, error: "所选音频区间不能短于 10 毫秒。" };
  }
  return { valid: true, error: "" };
}

export function formatTimeMs(valueMs: number, forceHours = false) {
  const safe = Math.max(0, roundMs(valueMs));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const milliseconds = safe % 1000;
  const tail = `${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
  if (forceHours || hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${tail}`;
  }
  return `${String(minutes).padStart(2, "0")}:${tail}`;
}

export function parseTimeMs(value: string) {
  const text = value.trim().replace(",", ".");
  if (!text) return undefined;
  const parts = text.split(":");
  if (parts.length < 2 || parts.length > 3) return undefined;
  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isFinite(part) || part < 0)) return undefined;
  const seconds = parts.length === 3
    ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    : numbers[0] * 60 + numbers[1];
  return roundMs(seconds * 1000);
}

export function cropAndRebaseCaptions(
  cues: TimelineCaption[],
  sourceInMs: number,
  sourceOutMs: number
) {
  const start = Math.max(0, sourceInMs);
  const end = Math.max(start, sourceOutMs);
  const result: TimelineCaption[] = [];
  cues.forEach((cue) => {
    const cueStartMs = roundMs(cue.startMs);
    const cueEndMs = roundMs(cue.endMs);
    if (cueEndMs <= start || cueStartMs >= end) return;
    const clippedStart = Math.max(start, cueStartMs);
    const clippedEnd = Math.min(end, cueEndMs);
    if (clippedEnd <= clippedStart) return;
    const boundaryClipped = clippedStart !== cueStartMs || clippedEnd !== cueEndMs;
    result.push({
      ...cue,
      id: cue.id || `caption-${result.length + 1}`,
      startMs: clippedStart - start,
      endMs: clippedEnd - start,
      boundaryClipped,
      needsReview: cue.needsReview || boundaryClipped
    });
  });
  return result;
}

export function normalizeSpeedCurve(points: SpeedPoint[]) {
  const normalized = points
    .map((point, index) => ({
      id: point.id || `speed-${index + 1}`,
      at: clamp(point.at, 0, 1),
      rate: clamp(point.rate, 0.25, 4)
    }))
    .sort((left, right) => left.at - right.at);
  if (!normalized.length) return DEFAULT_SPEED_CURVE.map((point) => ({ ...point }));
  if (normalized[0].at > 0) {
    normalized.unshift({ id: "speed-start", at: 0, rate: normalized[0].rate });
  } else {
    normalized[0].at = 0;
  }
  const last = normalized.at(-1)!;
  if (last.at < 1) {
    normalized.push({ id: "speed-end", at: 1, rate: last.rate });
  } else {
    last.at = 1;
  }
  return normalized;
}

export function averageSpeed(points: SpeedPoint[]) {
  const curve = normalizeSpeedCurve(points);
  let area = 0;
  for (let index = 1; index < curve.length; index += 1) {
    const previous = curve[index - 1];
    const current = curve[index];
    area += (current.at - previous.at) * (previous.rate + current.rate) / 2;
  }
  return clamp(area, 0.25, 4);
}

export function speedAt(points: SpeedPoint[], normalizedTime: number) {
  const curve = normalizeSpeedCurve(points);
  const at = clamp(normalizedTime, 0, 1);
  for (let index = 1; index < curve.length; index += 1) {
    const previous = curve[index - 1];
    const current = curve[index];
    if (at <= current.at) {
      const span = Math.max(0.0001, current.at - previous.at);
      const progress = (at - previous.at) / span;
      return previous.rate + (current.rate - previous.rate) * progress;
    }
  }
  return curve.at(-1)?.rate ?? 1;
}

function integratedCurveRate(points: SpeedPoint[], normalizedTime: number) {
  const curve = normalizeSpeedCurve(points);
  const endAt = clamp(normalizedTime, 0, 1);
  let area = 0;
  for (let index = 1; index < curve.length; index += 1) {
    const previous = curve[index - 1];
    const current = curve[index];
    if (endAt <= previous.at) break;
    const segmentEnd = Math.min(endAt, current.at);
    const span = Math.max(0.0001, current.at - previous.at);
    const localProgress = (segmentEnd - previous.at) / span;
    const endRate = previous.rate + (current.rate - previous.rate) * localProgress;
    area += (segmentEnd - previous.at) * (previous.rate + endRate) / 2;
    if (endAt <= current.at) break;
  }
  return area;
}

export function timelineDurationForSource(sourceDurationMs: number, points: SpeedPoint[]) {
  return Math.max(10, roundMs(sourceDurationMs / averageSpeed(points)));
}

export function applyClipSpeedCurve(clip: TimelineClip, points: SpeedPoint[]): TimelineClip {
  const speedCurve = normalizeSpeedCurve(points);
  const sourceDurationMs = Math.max(100, clip.sourceOutMs - clip.sourceInMs);
  const timelineDurationMs = timelineDurationForSource(sourceDurationMs, speedCurve);
  return {
    ...clip,
    speedCurve,
    timelineEndMs: clip.timelineStartMs + timelineDurationMs,
  };
}

export function speedCurveForTimelineDuration(sourceDurationMs: number, timelineDurationMs: number) {
  const sourceDuration = Math.max(10, roundMs(sourceDurationMs));
  const timelineDuration = Math.max(10, roundMs(timelineDurationMs));
  const rate = clamp(sourceDuration / timelineDuration, 0.25, 4);
  return [
    { id: "speed-start", at: 0, rate },
    { id: "speed-end", at: 1, rate }
  ];
}

export function timelineDurationBoundsForSource(sourceDurationMs: number) {
  const sourceDuration = Math.max(10, roundMs(sourceDurationMs));
  return {
    minMs: Math.max(10, Math.ceil(sourceDuration / 4)),
    maxMs: Math.max(10, Math.floor(sourceDuration / 0.25))
  };
}

export function sourceTimeAtTimelineMs(clip: TimelineClip, timelineMs: number) {
  const timelineDuration = Math.max(10, clip.timelineEndMs - clip.timelineStartMs);
  const normalizedTime = clamp((timelineMs - clip.timelineStartMs) / timelineDuration, 0, 1);
  const sourceDuration = Math.max(0, clip.sourceOutMs - clip.sourceInMs);
  const totalArea = Math.max(0.0001, averageSpeed(clip.speedCurve));
  const sourceProgress = integratedCurveRate(clip.speedCurve, normalizedTime) / totalArea;
  return clamp(
    clip.sourceInMs + sourceDuration * sourceProgress,
    clip.sourceInMs,
    clip.sourceOutMs
  );
}

export function placeVideoCaption(cue: TimelineCaption, clip: TimelineClip): TimelineCaption | null {
  const start = Math.max(clip.sourceInMs, cue.startMs);
  const end = Math.min(clip.sourceOutMs, cue.endMs);
  if (end <= start) return null;
  const toTimeline = (source: number) => {
    let low = clip.timelineStartMs;
    let high = clip.timelineEndMs;
    while (high - low > 0.25) {
      const middle = (low + high) / 2;
      if (sourceTimeAtTimelineMs(clip, middle) < source) low = middle;
      else high = middle;
    }
    return Math.round((low + high) / 2);
  };
  const startMs = toTimeline(start);
  const endMs = toTimeline(end);
  if (endMs <= startMs) return null;
  return {
    ...cue,
    videoClipId: clip.id,
    startMs,
    endMs,
    ...(start !== cue.startMs || end !== cue.endMs ? { boundaryClipped: true, needsReview: true } : {}),
  };
}

export function remapVideoCaptions(
  before: EditorProject,
  after: EditorProject,
  splitClipId?: string,
): EditorProject {
  if (!after.captions.some((cue) => cue.videoClipId)) return after;
  const visualClips = (project: EditorProject) => project.tracks
    .filter((track) => track.type === "video" || track.type === "broll")
    .flatMap((track) => track.clips);
  const oldClips = new Map(visualClips(before).map((clip) => [clip.id, clip]));
  const newClips = visualClips(after);
  const captions = after.captions.flatMap((cue) => {
    if (!cue.videoClipId) return [cue];
    const old = oldClips.get(cue.videoClipId);
    if (!old) return [cue];
    const candidates = newClips.filter((clip) => clip.assetId === old.assetId && (
      clip.id === old.id || (old.id === splitClipId && !oldClips.has(clip.id)
        && clip.trackId === old.trackId && clip.timelineStartMs >= old.timelineStartMs
        && clip.timelineEndMs <= old.timelineEndMs)
    ));
    if (candidates.length === 1 && candidates[0].timelineStartMs === old.timelineStartMs
      && candidates[0].timelineEndMs === old.timelineEndMs && candidates[0].sourceInMs === old.sourceInMs
      && candidates[0].sourceOutMs === old.sourceOutMs
      && JSON.stringify(candidates[0].speedCurve) === JSON.stringify(old.speedCurve)) return [cue];
    const sourceCue = {
      ...cue,
      startMs: Math.round(sourceTimeAtTimelineMs(old, cue.startMs)),
      endMs: Math.round(sourceTimeAtTimelineMs(old, cue.endMs)),
    };
    return candidates.flatMap((clip, index) => {
      const mapped = placeVideoCaption(sourceCue, clip);
      return mapped ? [{ ...mapped, id: index === 0 ? cue.id : `${cue.id}:${clip.id}` }] : [];
    });
  });
  return { ...after, captions: captions.sort((left, right) => left.startMs - right.startMs) };
}

function speedCurveForTimelineSlice(points: SpeedPoint[], startAt: number, endAt: number) {
  const curve = normalizeSpeedCurve(points);
  const start = clamp(startAt, 0, 1);
  const end = clamp(endAt, start, 1);
  const span = end - start;
  if (span <= 0) throw new RangeError("Speed-curve slice must have a positive duration.");
  const sliced = [
    { id: "speed-start", at: 0, rate: speedAt(curve, start) },
    ...curve
      .filter((point) => point.at > start && point.at < end)
      .map((point) => ({ ...point, at: (point.at - start) / span })),
    { id: "speed-end", at: 1, rate: speedAt(curve, end) },
  ];
  return normalizeSpeedCurve(sliced);
}

export function splitTimelineClip(
  clip: TimelineClip,
  splitAtLocalTimelineMs: number,
  createClipId: () => string,
): readonly [TimelineClip, TimelineClip] {
  if (!Number.isFinite(splitAtLocalTimelineMs)) {
    throw new RangeError("Clip split position must be finite.");
  }
  const timelineDurationMs = roundMs(clip.timelineEndMs - clip.timelineStartMs);
  const splitLocalMs = roundMs(splitAtLocalTimelineMs);
  if (
    timelineDurationMs < MIN_CLIP_SPLIT_CHILD_DURATION_MS * 2
    || splitLocalMs < MIN_CLIP_SPLIT_CHILD_DURATION_MS
    || timelineDurationMs - splitLocalMs < MIN_CLIP_SPLIT_CHILD_DURATION_MS
  ) {
    throw new RangeError("Clip split must leave two valid child durations.");
  }
  const splitAtTimelineMs = clip.timelineStartMs + splitLocalMs;
  const sourceAtMs = sourceTimeAtTimelineMs(clip, splitAtTimelineMs);
  if (
    !Number.isFinite(sourceAtMs)
    || sourceAtMs <= clip.sourceInMs
    || sourceAtMs >= clip.sourceOutMs
  ) {
    throw new RangeError("Clip split exceeds source bounds.");
  }
  const leftId = createClipId();
  const rightId = createClipId();
  if (!leftId || !rightId || leftId === rightId || leftId === clip.id || rightId === clip.id) {
    throw new Error("Clip split requires two unique editor-generated IDs.");
  }
  const splitAt = splitLocalMs / timelineDurationMs;
  return [
    {
      ...clip,
      id: leftId,
      timelineEndMs: splitAtTimelineMs,
      sourceOutMs: sourceAtMs,
      speedCurve: speedCurveForTimelineSlice(clip.speedCurve, 0, splitAt),
    },
    {
      ...clip,
      id: rightId,
      timelineStartMs: splitAtTimelineMs,
      sourceInMs: sourceAtMs,
      speedCurve: speedCurveForTimelineSlice(clip.speedCurve, splitAt, 1),
    },
  ];
}

export function editorProjectDurationMs(project: EditorProject) {
  const clipEnd = project.tracks.flatMap((track) => track.clips)
    .reduce((max, clip) => Math.max(max, clip.timelineEndMs), 0);
  const captionEnd = project.captions.reduce(
    (max, caption) => Math.max(max, caption.endMs),
    0,
  );
  return Math.max(1_000, project.durationMs, clipEnd, captionEnd);
}

export function reorderTimelineClip(
  project: EditorProject,
  targetId: string,
  referenceId: string,
  placement: ClipPlacement,
): EditorProject {
  if (!targetId || !referenceId || targetId === referenceId) {
    throw new RangeError("Clip reorder requires two different existing clip IDs.");
  }
  if (placement !== "BEFORE" && placement !== "AFTER") {
    throw new RangeError("Clip reorder placement must be BEFORE or AFTER.");
  }

  const next = cloneProject(project);
  const matchingTracks = next.tracks.filter((track) => (
    track.clips.some((clip) => clip.id === targetId)
    || track.clips.some((clip) => clip.id === referenceId)
  ));
  const targetCount = next.tracks.reduce(
    (count, track) => count + track.clips.filter((clip) => clip.id === targetId).length,
    0,
  );
  const referenceCount = next.tracks.reduce(
    (count, track) => count + track.clips.filter((clip) => clip.id === referenceId).length,
    0,
  );
  if (targetCount !== 1 || referenceCount !== 1 || matchingTracks.length !== 1) {
    throw new RangeError("Clip reorder requires unique clips on the same timeline track.");
  }

  const track = matchingTracks[0];
  const clips = track.clips
    .map((clip, index) => ({ clip, index }))
    .sort((left, right) => (
      left.clip.timelineStartMs - right.clip.timelineStartMs || left.index - right.index
    ))
    .map(({ clip }) => clip);
  const originalOrder = clips.map((clip) => clip.id);
  const targetIndex = clips.findIndex((clip) => clip.id === targetId);
  const [target] = clips.splice(targetIndex, 1);
  const referenceIndex = clips.findIndex((clip) => clip.id === referenceId);
  clips.splice(placement === "BEFORE" ? referenceIndex : referenceIndex + 1, 0, target);

  const orderChanged = clips.some((clip, index) => clip.id !== originalOrder[index]);
  if (orderChanged) {
    let cursor = Math.min(...clips.map((clip) => clip.timelineStartMs));
    clips.forEach((clip) => {
      const duration = clip.timelineEndMs - clip.timelineStartMs;
      clip.timelineStartMs = cursor;
      clip.timelineEndMs = cursor + duration;
      cursor += duration;
    });
    track.clips = clips;
  }
  next.durationMs = editorProjectDurationMs(next);
  return next;
}

export function snapMs(valueMs: number, enabled: boolean, intervalMs = 100) {
  const value = Math.max(0, roundMs(valueMs));
  return enabled ? Math.round(value / intervalMs) * intervalMs : value;
}

export function collectTimelineSnapTargets(
  project: EditorProject,
  exclude?: { kind: "clip" | "caption" | "overlay" | "secondary-audio"; id: string }
) {
  const targets = new Set<number>([
    0,
    Math.max(0, roundMs(project.durationMs)),
    Math.max(0, roundMs(project.audioSelection.selectedDurationMs))
  ]);
  project.tracks.forEach((track) => {
    track.clips.forEach((clip) => {
      if (exclude?.kind === "clip" && exclude.id === clip.id) return;
      targets.add(Math.max(0, roundMs(clip.timelineStartMs)));
      targets.add(Math.max(0, roundMs(clip.timelineEndMs)));
    });
  });
  project.captions.forEach((caption) => {
    if (exclude?.kind === "caption" && exclude.id === caption.id) return;
    // 字幕边界同时代表语音起止和可用的停顿吸附点。
    targets.add(Math.max(0, roundMs(caption.startMs)));
    targets.add(Math.max(0, roundMs(caption.endMs)));
  });
  (project.overlays ?? []).forEach((overlay) => {
    if (exclude?.kind === "overlay" && exclude.id === overlay.id) return;
    targets.add(Math.max(0, roundMs(overlay.startMs)));
    targets.add(Math.max(0, roundMs(overlay.endMs)));
  });
  (project.secondaryAudioClips ?? []).forEach((clip) => {
    if (exclude?.kind === "secondary-audio" && exclude.id === clip.id) return;
    targets.add(Math.max(0, roundMs(clip.timelineStartMs)));
    targets.add(Math.max(0, roundMs(clip.timelineStartMs + clip.sourceEndMs - clip.sourceStartMs)));
  });
  return [...targets].sort((left, right) => left - right);
}

export function snapTimelineMs(
  valueMs: number,
  targets: number[],
  enabled: boolean,
  thresholdMs = 140,
  intervalMs = 100
) {
  const value = Math.max(0, roundMs(valueMs));
  if (!enabled) return value;
  let nearestTarget: number | undefined;
  let targetDistance = Number.POSITIVE_INFINITY;
  targets.forEach((target) => {
    const nextDistance = Math.abs(target - value);
    if (nextDistance <= thresholdMs && nextDistance < targetDistance) {
      nearestTarget = target;
      targetDistance = nextDistance;
    }
  });
  return nearestTarget === undefined
    ? snapMs(value, true, intervalMs)
    : Math.max(0, roundMs(nearestTarget));
}

export function cloneProject(project: EditorProject): EditorProject {
  return JSON.parse(JSON.stringify(project)) as EditorProject;
}

export function parseEditorProject(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Omit<EditorProject, "schemaVersion" | "captions"> & {
      schemaVersion?: number;
      captions?: Array<Partial<TimelineCaption> & { start?: number; end?: number }>;
    };
    if (
      (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2)
      || !Array.isArray(parsed.tracks)
      || !Array.isArray(parsed.captions)
      || !parsed.audioSelection
    ) return null;
    const captions = parsed.captions
      .map((caption, index) => {
        const startMs = Number.isFinite(caption.startMs)
          ? roundMs(caption.startMs!)
          : roundMs((caption.start ?? 0) * 1000);
        const endMs = Number.isFinite(caption.endMs)
          ? roundMs(caption.endMs!)
          : roundMs((caption.end ?? 0) * 1000);
        return {
          id: caption.id || `caption-${index + 1}`,
          text: String(caption.text ?? ""),
          startMs: Math.max(0, startMs),
          endMs: Math.max(0, endMs),
          ...(typeof caption.confidence === "number" && Number.isFinite(caption.confidence)
            ? { confidence: caption.confidence }
            : {}),
          ...(typeof caption.needsReview === "boolean"
            ? { needsReview: caption.needsReview }
            : {}),
          ...(typeof caption.recognizedText === "string" ? { recognizedText: caption.recognizedText } : {}),
          ...(typeof caption.videoClipId === "string" && caption.videoClipId ? { videoClipId: caption.videoClipId } : {}),
          ...(typeof caption.boundaryClipped === "boolean"
            ? { boundaryClipped: caption.boundaryClipped }
            : {}),
          ...(typeof caption.x === "number" && Number.isFinite(caption.x)
            ? { x: clamp(caption.x, 0.05, 0.95) }
            : {}),
          ...(typeof caption.y === "number" && Number.isFinite(caption.y)
            ? { y: clamp(caption.y, 0.08, 0.95) }
            : {}),
          ...(typeof caption.color === "string" && /^#[0-9a-f]{6}$/i.test(caption.color)
            ? { color: caption.color.toLowerCase() }
            : {}),
          ...(["left", "center", "right"].includes(caption.alignment ?? "")
            ? { alignment: caption.alignment as "left" | "center" | "right" }
            : {}),
          ...(typeof caption.opacity === "number" && Number.isFinite(caption.opacity)
            ? { opacity: clamp(caption.opacity, 0.1, 1) }
            : {}),
          ...(typeof caption.fontSize === "number" && Number.isFinite(caption.fontSize)
            ? { fontSize: clamp(Math.round(caption.fontSize), 12, 120) }
            : {}),
          ...(["ASR", "IMPORTED_SRT", "IMPORTED_VTT", "IMPORTED_ASS", "MANUAL"].includes(caption.provenance ?? "")
            ? { provenance: caption.provenance as TimelineCaption["provenance"] }
            : {}),
        };
      })
      .filter((caption) => caption.text.trim() && caption.endMs > caption.startMs)
      .sort((left, right) => left.startMs - right.startMs);
    const projectDurationMs = Math.max(1_000, roundMs(parsed.durationMs));
    const overlays = (Array.isArray(parsed.overlays) ? parsed.overlays : [])
      .filter((overlay): overlay is EditorOverlay => Boolean(
        overlay
        && typeof overlay === "object"
        && typeof overlay.id === "string"
        && overlay.id.trim()
        && ["text", "arrow", "rectangle", "circle"].includes(overlay.type)
      ))
      .map((overlay) => normalizeOverlay(overlay, projectDurationMs));
    const secondaryAudioClips = (Array.isArray(parsed.secondaryAudioClips) ? parsed.secondaryAudioClips : [])
      .filter((clip): clip is SecondaryAudioClip => Boolean(
        clip
        && typeof clip === "object"
        && typeof clip.id === "string"
        && clip.id.trim()
        && typeof clip.name === "string"
        && typeof clip.sourceUrl === "string"
      ))
      .map((clip) => normalizeSecondaryAudioClip(clip, projectDurationMs));
    parsed.durationMs = projectDurationMs;
    parsed.overlays = overlays;
    parsed.secondaryAudioClips = secondaryAudioClips;
    return {
      ...parsed,
      schemaVersion: 2,
      captions
    } as EditorProject;
  } catch {
    return null;
  }
}
