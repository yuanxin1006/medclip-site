import {
  LONG_PAUSE_MS,
  SHORT_PAUSE_MS,
  detectSpeechRegions,
  type SpeechRegion,
} from "./transcription-core.ts";

export const AUDIO_RHYTHM_SCHEMA_VERSION = 1 as const;
export const LOCAL_AUDIO_RHYTHM_ANALYSIS_VERSION = "local-audio-rhythm-v1";
export const AUDIO_ENERGY_WINDOW_MS = 100;
export const MAX_AUDIO_ENERGY_POINTS = 6_000;
export const MAX_AUDIO_ONSET_CANDIDATES = 256;
export const MIN_AUDIO_ONSET_SPACING_MS = 250;
export const MAX_AUDIO_RHYTHM_SEGMENTS = 512;
export const AUDIO_SHORT_GAP_MS = SHORT_PAUSE_MS;
export const AUDIO_MEANINGFUL_PAUSE_MS = LONG_PAUSE_MS;

const MAX_SOURCE_DURATION_MS = 86_400_000;
const ONSET_ENERGY_RISE_THRESHOLD = 0.22;
const SILENCE_RMS_EPSILON = 1e-8;

export type AudioRhythmPoint = Readonly<{
  timeMs: number;
  energy: number;
}>;

export type AudioOnsetCandidate = Readonly<{
  timeMs: number;
  strength: number;
}>;

export type AudioRhythmSegment = Readonly<{
  id: string;
  startMs: number;
  endMs: number;
  energy: number;
  speech: boolean;
  pause: boolean;
  onsetMs?: number;
  confidence: number;
}>;

export type AudioRhythmAnalysis = Readonly<{
  schemaVersion: typeof AUDIO_RHYTHM_SCHEMA_VERSION;
  sourceId: string;
  sourceDurationMs: number;
  energyEnvelope: readonly AudioRhythmPoint[];
  onsets: readonly AudioOnsetCandidate[];
  segments: readonly AudioRhythmSegment[];
  analysisVersion: string;
}>;

export type AudioRhythmAnalysisErrorCode =
  | "INVALID_INPUT"
  | "EMPTY_PCM"
  | "ZERO_DURATION"
  | "OUTPUT_LIMIT"
  | "ANALYSIS_ABORTED";

export class AudioRhythmAnalysisError extends Error {
  readonly code: AudioRhythmAnalysisErrorCode;

  constructor(code: AudioRhythmAnalysisErrorCode, message: string) {
    super(message);
    this.name = "AudioRhythmAnalysisError";
    this.code = code;
  }
}

export type AnalyzeAudioRhythmInput = Readonly<{
  sourceId: string;
  samples: Float32Array;
  sampleRate?: number;
  speechRegions?: readonly SpeechRegion[];
  analysisVersion?: string;
  signal?: AbortSignal;
}>;

function fail(code: AudioRhythmAnalysisErrorCode, message: string): never {
  throw new AudioRhythmAnalysisError(code, message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))) {
    fail("INVALID_INPUT", `${label} is missing a required field.`);
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail("INVALID_INPUT", `${label} contains an unknown field.`);
  }
}

function safeIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || value !== value.trim()
    || /\u0000/.test(value)
    || /^(?:blob:|file:|https?:)/i.test(value)
    || /[\\/]/.test(value)
  ) {
    fail("INVALID_INPUT", `${label} must be a bounded trusted identity, not a URL or path.`);
  }
  return value;
}

function safeTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail("INVALID_INPUT", `${label} must be a non-negative integer millisecond value.`);
  }
  return Number(value);
}

function safeScore(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail("INVALID_INPUT", `${label} must be a finite normalized score.`);
  }
  return value;
}

function safeAnalysisVersion(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail("INVALID_INPUT", "analysisVersion must be a bounded deterministic identifier.");
  }
  return value;
}

function assertActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    fail("ANALYSIS_ABORTED", "Audio rhythm analysis was interrupted.");
  }
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000) / 1_000_000;
}

function hashIdentity(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createAudioRhythmSourceId(assetIds: readonly string[]): string {
  if (!Array.isArray(assetIds) || assetIds.length === 0 || assetIds.length > 10) {
    fail("INVALID_INPUT", "Audio source identity requires one to ten ordered asset IDs.");
  }
  const validated = assetIds.map((assetId, index) => safeIdentity(assetId, `assetIds[${index}]`));
  if (new Set(validated).size !== validated.length) {
    fail("INVALID_INPUT", "Audio source asset IDs must be unique.");
  }
  return validated.length === 1
    ? validated[0]
    : `audio-composite-${hashIdentity(JSON.stringify(validated))}`;
}

export function createAudioRhythmSegmentId(
  sourceIdValue: unknown,
  startMsValue: unknown,
  endMsValue: unknown,
  speech: boolean,
): string {
  const sourceId = safeIdentity(sourceIdValue, "sourceId");
  const startMs = safeTime(startMsValue, "startMs");
  const endMs = safeTime(endMsValue, "endMs");
  if (endMs <= startMs) fail("INVALID_INPUT", "Audio rhythm segment range must be positive.");
  return `audio-rhythm:${hashIdentity(sourceId)}@${startMs}-${endMs}:${speech ? "speech" : "pause"}`;
}

export function parseAudioRhythmPoint(value: unknown): AudioRhythmPoint {
  if (!plainRecord(value)) fail("INVALID_INPUT", "AudioRhythmPoint must be an object.");
  exactKeys(value, ["timeMs", "energy"], [], "AudioRhythmPoint");
  return Object.freeze({
    timeMs: safeTime(value.timeMs, "point.timeMs"),
    energy: safeScore(value.energy, "point.energy"),
  });
}

export function parseAudioOnsetCandidate(value: unknown): AudioOnsetCandidate {
  if (!plainRecord(value)) fail("INVALID_INPUT", "AudioOnsetCandidate must be an object.");
  exactKeys(value, ["timeMs", "strength"], [], "AudioOnsetCandidate");
  return Object.freeze({
    timeMs: safeTime(value.timeMs, "onset.timeMs"),
    strength: safeScore(value.strength, "onset.strength"),
  });
}

export function parseAudioRhythmSegment(value: unknown): AudioRhythmSegment {
  if (!plainRecord(value)) fail("INVALID_INPUT", "AudioRhythmSegment must be an object.");
  exactKeys(
    value,
    ["id", "startMs", "endMs", "energy", "speech", "pause", "confidence"],
    ["onsetMs"],
    "AudioRhythmSegment",
  );
  const id = safeIdentity(value.id, "segment.id");
  const startMs = safeTime(value.startMs, "segment.startMs");
  const endMs = safeTime(value.endMs, "segment.endMs");
  if (endMs <= startMs) fail("INVALID_INPUT", "Audio rhythm segment endMs must exceed startMs.");
  if (typeof value.speech !== "boolean" || typeof value.pause !== "boolean" || value.speech === value.pause) {
    fail("INVALID_INPUT", "Audio rhythm segment must be exactly one of speech or pause.");
  }
  const onsetMs = value.onsetMs === undefined ? undefined : safeTime(value.onsetMs, "segment.onsetMs");
  if (onsetMs !== undefined && (onsetMs < startMs || onsetMs > endMs)) {
    fail("INVALID_INPUT", "Segment onsetMs must be inside its source-relative range.");
  }
  return Object.freeze({
    id,
    startMs,
    endMs,
    energy: safeScore(value.energy, "segment.energy"),
    speech: value.speech,
    pause: value.pause,
    ...(onsetMs === undefined ? {} : { onsetMs }),
    confidence: safeScore(value.confidence, "segment.confidence"),
  });
}

export function parseAudioRhythmAnalysis(value: unknown): AudioRhythmAnalysis {
  if (!plainRecord(value)) fail("INVALID_INPUT", "AudioRhythmAnalysis must be an object.");
  exactKeys(
    value,
    [
      "schemaVersion",
      "sourceId",
      "sourceDurationMs",
      "energyEnvelope",
      "onsets",
      "segments",
      "analysisVersion",
    ],
    [],
    "AudioRhythmAnalysis",
  );
  if (value.schemaVersion !== AUDIO_RHYTHM_SCHEMA_VERSION) {
    fail("INVALID_INPUT", "Unsupported audio rhythm schemaVersion.");
  }
  const sourceId = safeIdentity(value.sourceId, "analysis.sourceId");
  const sourceDurationMs = safeTime(value.sourceDurationMs, "analysis.sourceDurationMs");
  if (sourceDurationMs <= 0) fail("ZERO_DURATION", "Audio rhythm source duration must be positive.");
  if (sourceDurationMs > MAX_SOURCE_DURATION_MS) {
    fail("OUTPUT_LIMIT", "Audio rhythm source duration exceeds the supported bound.");
  }
  if (
    !Array.isArray(value.energyEnvelope)
    || value.energyEnvelope.length === 0
    || value.energyEnvelope.length > MAX_AUDIO_ENERGY_POINTS
  ) {
    fail("OUTPUT_LIMIT", "Energy envelope must be non-empty and bounded.");
  }
  const energyEnvelope = value.energyEnvelope.map(parseAudioRhythmPoint);
  if (
    energyEnvelope.some((point) => point.timeMs > sourceDurationMs)
    || energyEnvelope.some((point, index) => index > 0 && point.timeMs <= energyEnvelope[index - 1].timeMs)
  ) {
    fail("INVALID_INPUT", "Energy points must use unique increasing source-relative timestamps.");
  }
  if (!Array.isArray(value.onsets) || value.onsets.length > MAX_AUDIO_ONSET_CANDIDATES) {
    fail("OUTPUT_LIMIT", "Onset candidates must be bounded.");
  }
  const onsets = value.onsets.map(parseAudioOnsetCandidate);
  if (
    onsets.some((onset) => onset.timeMs > sourceDurationMs)
    || onsets.some((onset, index) => index > 0 && onset.timeMs <= onsets[index - 1].timeMs)
    || onsets.some((onset, index) => index > 0
      && onset.timeMs - onsets[index - 1].timeMs < MIN_AUDIO_ONSET_SPACING_MS)
  ) {
    fail("INVALID_INPUT", "Onsets must be ordered, unique, spaced, and inside the audio source.");
  }
  if (
    !Array.isArray(value.segments)
    || value.segments.length === 0
    || value.segments.length > MAX_AUDIO_RHYTHM_SEGMENTS
  ) {
    fail("OUTPUT_LIMIT", "Rhythm segments must be non-empty and bounded.");
  }
  const segments = value.segments.map(parseAudioRhythmSegment);
  if (new Set(segments.map((segment) => segment.id)).size !== segments.length) {
    fail("INVALID_INPUT", "Rhythm segment IDs must be unique.");
  }
  if (segments.some((segment) => segment.id !== createAudioRhythmSegmentId(
    sourceId,
    segment.startMs,
    segment.endMs,
    segment.speech,
  ))) {
    fail("INVALID_INPUT", "Rhythm segment IDs must match their source identity and range.");
  }
  if (
    segments[0].startMs !== 0
    || segments.at(-1)?.endMs !== sourceDurationMs
    || segments.some((segment, index) => segment.endMs > sourceDurationMs
      || (index > 0 && segment.startMs !== segments[index - 1].endMs))
  ) {
    fail("INVALID_INPUT", "Rhythm segments must form one ordered contiguous source timeline.");
  }
  const onsetTimes = new Set(onsets.map((onset) => onset.timeMs));
  if (segments.some((segment) => segment.onsetMs !== undefined && !onsetTimes.has(segment.onsetMs))) {
    fail("INVALID_INPUT", "Segment onset references must resolve to analysis onset evidence.");
  }
  return Object.freeze({
    schemaVersion: AUDIO_RHYTHM_SCHEMA_VERSION,
    sourceId,
    sourceDurationMs,
    energyEnvelope: Object.freeze(energyEnvelope),
    onsets: Object.freeze(onsets),
    segments: Object.freeze(segments),
    analysisVersion: safeAnalysisVersion(value.analysisVersion),
  });
}

function validateSpeechRegions(
  regions: readonly SpeechRegion[],
  sourceDurationMs: number,
): readonly SpeechRegion[] {
  if (!Array.isArray(regions)) fail("INVALID_INPUT", "speechRegions must be an array.");
  const validated = regions.map((region, index) => {
    if (!plainRecord(region)) fail("INVALID_INPUT", `speechRegions[${index}] must be an object.`);
    exactKeys(region, ["startMs", "endMs"], [], `speechRegions[${index}]`);
    const startMs = safeTime(region.startMs, `speechRegions[${index}].startMs`);
    const endMs = safeTime(region.endMs, `speechRegions[${index}].endMs`);
    if (endMs <= startMs || endMs > sourceDurationMs) {
      fail("INVALID_INPUT", "Speech regions must be positive and inside the audio source.");
    }
    return Object.freeze({ startMs, endMs });
  });
  if (validated.some((region, index) => index > 0 && region.startMs < validated[index - 1].endMs)) {
    fail("INVALID_INPUT", "Speech regions must be ordered and non-overlapping.");
  }
  return Object.freeze(validated);
}

function createEnergyEnvelope(
  samples: Float32Array,
  sampleRate: number,
  sourceDurationMs: number,
  signal?: AbortSignal,
): readonly AudioRhythmPoint[] {
  const adaptiveWindowMs = Math.max(
    AUDIO_ENERGY_WINDOW_MS,
    Math.ceil(sourceDurationMs / MAX_AUDIO_ENERGY_POINTS),
  );
  const windowSamples = Math.max(1, Math.round(sampleRate * adaptiveWindowMs / 1_000));
  const rmsValues: Array<{ timeMs: number; rms: number }> = [];
  for (let offset = 0; offset < samples.length; offset += windowSamples) {
    if (rmsValues.length % 256 === 0) assertActive(signal);
    const end = Math.min(samples.length, offset + windowSamples);
    let sumSquares = 0;
    for (let index = offset; index < end; index += 1) {
      const sample = Math.min(1, Math.max(-1, samples[index]));
      sumSquares += sample * sample;
    }
    const timeMs = Math.min(
      sourceDurationMs,
      Math.round(((offset + (end - offset) / 2) / sampleRate) * 1_000),
    );
    rmsValues.push({ timeMs, rms: Math.sqrt(sumSquares / Math.max(1, end - offset)) });
  }
  const peakRms = Math.max(0, ...rmsValues.map((point) => point.rms));
  return Object.freeze(rmsValues.map((point) => Object.freeze({
    timeMs: point.timeMs,
    energy: peakRms <= SILENCE_RMS_EPSILON ? 0 : roundScore(point.rms / peakRms),
  })));
}

function energyNearTime(envelope: readonly AudioRhythmPoint[], timeMs: number): number {
  let nearest = envelope[0];
  for (const point of envelope) {
    if (Math.abs(point.timeMs - timeMs) < Math.abs(nearest.timeMs - timeMs)) nearest = point;
  }
  return nearest.energy;
}

function createOnsetCandidates(
  envelope: readonly AudioRhythmPoint[],
  speechRegions: readonly SpeechRegion[],
): readonly AudioOnsetCandidate[] {
  const raw: AudioOnsetCandidate[] = [];
  for (let index = 1; index < envelope.length; index += 1) {
    const rise = envelope[index].energy - envelope[index - 1].energy;
    if (rise < ONSET_ENERGY_RISE_THRESHOLD) continue;
    raw.push(Object.freeze({ timeMs: envelope[index].timeMs, strength: roundScore(rise) }));
  }
  speechRegions.forEach((region) => {
    const strength = energyNearTime(envelope, region.startMs);
    if (strength >= ONSET_ENERGY_RISE_THRESHOLD) {
      raw.push(Object.freeze({ timeMs: region.startMs, strength: roundScore(strength) }));
    }
  });
  raw.sort((left, right) => left.timeMs - right.timeMs || right.strength - left.strength);
  const spaced: AudioOnsetCandidate[] = [];
  raw.forEach((candidate) => {
    const previous = spaced.at(-1);
    if (!previous || candidate.timeMs - previous.timeMs >= MIN_AUDIO_ONSET_SPACING_MS) {
      spaced.push(candidate);
      return;
    }
    if (candidate.strength > previous.strength) spaced[spaced.length - 1] = candidate;
  });
  if (spaced.length <= MAX_AUDIO_ONSET_CANDIDATES) return Object.freeze(spaced);
  const strongest = spaced
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) =>
      right.candidate.strength - left.candidate.strength || left.index - right.index)
    .slice(0, MAX_AUDIO_ONSET_CANDIDATES)
    .map(({ candidate }) => candidate)
    .sort((left, right) => left.timeMs - right.timeMs);
  return Object.freeze(strongest);
}

function meanEnergyForRange(
  envelope: readonly AudioRhythmPoint[],
  startMs: number,
  endMs: number,
): number {
  const points = envelope.filter((point) => point.timeMs >= startMs && point.timeMs <= endMs);
  if (!points.length) return energyNearTime(envelope, Math.round((startMs + endMs) / 2));
  return roundScore(points.reduce((sum, point) => sum + point.energy, 0) / points.length);
}

function pauseConfidence(durationMs: number): number {
  if (durationMs < AUDIO_SHORT_GAP_MS) {
    return roundScore(durationMs / AUDIO_SHORT_GAP_MS * 0.4);
  }
  if (durationMs < AUDIO_MEANINGFUL_PAUSE_MS) {
    return roundScore(0.4 + (durationMs - AUDIO_SHORT_GAP_MS)
      / (AUDIO_MEANINGFUL_PAUSE_MS - AUDIO_SHORT_GAP_MS) * 0.35);
  }
  return roundScore(0.75 + Math.min(1, (durationMs - AUDIO_MEANINGFUL_PAUSE_MS) / 1_000) * 0.25);
}

function createRhythmSegments(input: {
  sourceId: string;
  sourceDurationMs: number;
  speechRegions: readonly SpeechRegion[];
  energyEnvelope: readonly AudioRhythmPoint[];
  onsets: readonly AudioOnsetCandidate[];
}): readonly AudioRhythmSegment[] {
  const ranges: Array<{ startMs: number; endMs: number; speech: boolean }> = [];
  let cursor = 0;
  input.speechRegions.forEach((region) => {
    if (region.startMs > cursor) ranges.push({ startMs: cursor, endMs: region.startMs, speech: false });
    ranges.push({ startMs: region.startMs, endMs: region.endMs, speech: true });
    cursor = region.endMs;
  });
  if (cursor < input.sourceDurationMs) {
    ranges.push({ startMs: cursor, endMs: input.sourceDurationMs, speech: false });
  }
  if (!ranges.length) ranges.push({ startMs: 0, endMs: input.sourceDurationMs, speech: false });
  if (ranges.length > MAX_AUDIO_RHYTHM_SEGMENTS) {
    fail("OUTPUT_LIMIT", "Speech and pause segmentation exceeds the bounded evidence limit.");
  }
  return Object.freeze(ranges.map((range, index) => {
    const energy = meanEnergyForRange(input.energyEnvelope, range.startMs, range.endMs);
    const onset = input.onsets
      .filter((candidate) => candidate.timeMs >= range.startMs
        && (index === ranges.length - 1
          ? candidate.timeMs <= range.endMs
          : candidate.timeMs < range.endMs))
      .sort((left, right) => right.strength - left.strength || left.timeMs - right.timeMs)[0];
    const durationMs = range.endMs - range.startMs;
    const confidence = range.speech
      ? roundScore(Math.min(1, durationMs / AUDIO_MEANINGFUL_PAUSE_MS) * energy)
      : pauseConfidence(durationMs);
    return parseAudioRhythmSegment({
      id: createAudioRhythmSegmentId(input.sourceId, range.startMs, range.endMs, range.speech),
      startMs: range.startMs,
      endMs: range.endMs,
      energy,
      speech: range.speech,
      pause: !range.speech,
      ...(onset ? { onsetMs: onset.timeMs } : {}),
      confidence,
    });
  }));
}

/**
 * Local-only PCM analysis. Complexity is linear in PCM length plus the existing
 * speech detector's percentile sort; all serialized evidence arrays are capped.
 */
export function analyzeAudioRhythm(input: AnalyzeAudioRhythmInput): AudioRhythmAnalysis {
  const sourceId = safeIdentity(input.sourceId, "sourceId");
  if (!(input.samples instanceof Float32Array)) {
    fail("INVALID_INPUT", "Audio rhythm analysis requires mono Float32 PCM.");
  }
  if (input.samples.length === 0) fail("EMPTY_PCM", "Audio rhythm analysis requires non-empty PCM.");
  const sampleRate = input.sampleRate ?? 16_000;
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1_000 || sampleRate > 384_000) {
    fail("INVALID_INPUT", "Audio sampleRate is outside the supported finite range.");
  }
  assertActive(input.signal);
  for (let index = 0; index < input.samples.length; index += 1) {
    if (index % 65_536 === 0) assertActive(input.signal);
    if (!Number.isFinite(input.samples[index])) {
      fail("INVALID_INPUT", "PCM samples must all be finite numbers.");
    }
  }
  const sourceDurationMs = Math.round(input.samples.length / sampleRate * 1_000);
  if (sourceDurationMs <= 0) fail("ZERO_DURATION", "PCM duration rounds to zero milliseconds.");
  if (sourceDurationMs > MAX_SOURCE_DURATION_MS) {
    fail("OUTPUT_LIMIT", "PCM duration exceeds the supported analysis bound.");
  }
  const detectedRegions = input.speechRegions
    ?? detectSpeechRegions(input.samples, sampleRate);
  const speechRegions = validateSpeechRegions(detectedRegions, sourceDurationMs);
  const energyEnvelope = createEnergyEnvelope(
    input.samples,
    sampleRate,
    sourceDurationMs,
    input.signal,
  );
  const onsets = createOnsetCandidates(energyEnvelope, speechRegions);
  const segments = createRhythmSegments({
    sourceId,
    sourceDurationMs,
    speechRegions,
    energyEnvelope,
    onsets,
  });
  assertActive(input.signal);
  return parseAudioRhythmAnalysis({
    schemaVersion: AUDIO_RHYTHM_SCHEMA_VERSION,
    sourceId,
    sourceDurationMs,
    energyEnvelope,
    onsets,
    segments,
    analysisVersion: input.analysisVersion ?? LOCAL_AUDIO_RHYTHM_ANALYSIS_VERSION,
  });
}
