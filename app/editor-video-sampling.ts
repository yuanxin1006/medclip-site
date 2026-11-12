export const MAX_COARSE_VIDEO_FRAME_COUNT = 5;
export const MAX_FINE_VIDEO_FRAME_COUNT = 3;
const MAX_FRAME_CAPTURE_REQUEST = 14;

export type FrameSample = Readonly<{
  assetId: string;
  sourceTimeMs: number;
  image: string;
}>;

export type FrameSamplingSource = Readonly<{
  assetId: string;
  name: string;
  kind: "video" | "image";
  sourceUrl: string;
  assetDurationMs?: number;
}>;

export class VideoFrameSamplingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoFrameSamplingError";
  }
}

function requireAssetId(value: string): string {
  if (!value || value !== value.trim() || value.length > 512 || /\u0000/.test(value)) {
    throw new VideoFrameSamplingError("Frame sampling requires a trusted asset ID.");
  }
  return value;
}

export function createCoarseFrameSampleTimes(
  assetDurationMs: number,
  detailedSampling: boolean,
): readonly number[] {
  if (!Number.isFinite(assetDurationMs) || assetDurationMs <= 0) {
    throw new VideoFrameSamplingError("Video duration must be a positive finite number.");
  }
  const durationMs = Math.round(assetDurationMs);
  const ratios = detailedSampling && durationMs >= 45_000
    ? [0.08, 0.25, 0.5, 0.75, 0.92]
    : durationMs >= 12_000
      ? [0.15, 0.5, 0.85]
      : durationMs >= 4_000
        ? [0.25, 0.75]
        : [0.5];
  return Object.freeze(ratios.map((ratio) => Math.round(Math.min(
    Math.max(50, durationMs * ratio),
    Math.max(50, durationMs - 80),
  ))));
}

export function createFineFrameSampleTimes(
  startMs: number,
  endMs: number,
): readonly number[] {
  if (
    !Number.isSafeInteger(startMs)
    || !Number.isSafeInteger(endMs)
    || startMs < 0
    || endMs <= startMs
  ) {
    throw new VideoFrameSamplingError("Fine sampling requires a valid source-relative range.");
  }
  const durationMs = endMs - startMs;
  const timestamps = [0.2, 0.5, 0.8].map((ratio) =>
    Math.min(endMs, startMs + Math.floor(durationMs * ratio)));
  return Object.freeze([...new Set(timestamps)]);
}

function waitForVideoMetadata(video: HTMLVideoElement, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new VideoFrameSamplingError(`Timed out while reading ${name}.`));
    }, 12_000);
    video.onloadedmetadata = () => {
      cleanup();
      resolve();
    };
    video.onerror = () => {
      cleanup();
      reject(new VideoFrameSamplingError(`Could not decode ${name}.`));
    };
    video.load();
  });
}

function seekVideo(video: HTMLVideoElement, sourceTimeMs: number, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timer);
      video.onseeked = null;
      video.onerror = null;
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new VideoFrameSamplingError(`Timed out while seeking ${name}.`));
    }, 8_000);
    video.onseeked = () => {
      cleanup();
      resolve();
    };
    video.onerror = () => {
      cleanup();
      reject(new VideoFrameSamplingError(`Could not decode ${name}.`));
    };
    video.currentTime = sourceTimeMs / 1_000;
  });
}

export async function captureBoundedFrameSamples(
  source: FrameSamplingSource,
  detailedSampling: boolean,
): Promise<readonly FrameSample[]> {
  const assetId = requireAssetId(source.assetId);
  if (!source.sourceUrl) throw new VideoFrameSamplingError(`Asset ${source.name} has no readable source.`);
  if (source.kind === "image") {
    return Object.freeze([{ assetId, sourceTimeMs: 0, image: source.sourceUrl }]);
  }

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = source.sourceUrl;
  try {
    await waitForVideoMetadata(video, source.name);
    const durationMs = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration * 1_000
      : source.assetDurationMs;
    if (durationMs === undefined) {
      throw new VideoFrameSamplingError(`Asset ${source.name} has no valid duration.`);
    }
    const sourceTimes = createCoarseFrameSampleTimes(durationMs, detailedSampling);
    const canvas = document.createElement("canvas");
    canvas.width = 384;
    canvas.height = 216;
    const context = canvas.getContext("2d");
    if (!context) throw new VideoFrameSamplingError("Could not create the frame-sampling canvas.");

    const frames: FrameSample[] = [];
    for (const sourceTimeMs of sourceTimes) {
      await seekVideo(video, sourceTimeMs, source.name);
      const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        video,
        (canvas.width - width) / 2,
        (canvas.height - height) / 2,
        width,
        height,
      );
      frames.push(Object.freeze({
        assetId,
        sourceTimeMs,
        image: canvas.toDataURL("image/jpeg", 0.8),
      }));
    }
    return Object.freeze(frames);
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

export async function captureFrameSamplesAtTimes(
  source: FrameSamplingSource,
  sourceTimes: readonly number[],
): Promise<readonly FrameSample[]> {
  const assetId = requireAssetId(source.assetId);
  if (!source.sourceUrl) throw new VideoFrameSamplingError(`Asset ${source.name} has no readable source.`);
  if (
    !Array.isArray(sourceTimes)
    || sourceTimes.length === 0
    || sourceTimes.length > MAX_FRAME_CAPTURE_REQUEST
    || sourceTimes.some((timestamp) => !Number.isSafeInteger(timestamp) || timestamp < 0)
    || new Set(sourceTimes).size !== sourceTimes.length
  ) {
    throw new VideoFrameSamplingError("Explicit frame sampling requires bounded unique source timestamps.");
  }
  if (source.kind === "image") {
    if (sourceTimes.length !== 1 || sourceTimes[0] !== 0) {
      throw new VideoFrameSamplingError("Still images only support the source timestamp zero.");
    }
    return Object.freeze([{ assetId, sourceTimeMs: 0, image: source.sourceUrl }]);
  }

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = source.sourceUrl;
  try {
    await waitForVideoMetadata(video, source.name);
    const durationMs = Number.isFinite(video.duration) && video.duration > 0
      ? Math.round(video.duration * 1_000)
      : source.assetDurationMs;
    if (
      durationMs === undefined
      || !Number.isFinite(durationMs)
      || sourceTimes.some((timestamp) => timestamp > durationMs)
    ) {
      throw new VideoFrameSamplingError(`Asset ${source.name} has an invalid sampling range.`);
    }
    const canvas = document.createElement("canvas");
    canvas.width = 384;
    canvas.height = 216;
    const context = canvas.getContext("2d");
    if (!context) throw new VideoFrameSamplingError("Could not create the frame-sampling canvas.");

    const frames: FrameSample[] = [];
    for (const sourceTimeMs of sourceTimes) {
      await seekVideo(video, sourceTimeMs, source.name);
      const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        video,
        (canvas.width - width) / 2,
        (canvas.height - height) / 2,
        width,
        height,
      );
      frames.push(Object.freeze({
        assetId,
        sourceTimeMs,
        image: canvas.toDataURL("image/jpeg", 0.8),
      }));
    }
    return Object.freeze(frames);
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}
