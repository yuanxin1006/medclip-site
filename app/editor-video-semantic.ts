import {parseClipVisualEvidence,CLIP_ANALYSIS_VERSION,type ClipVisualEvidence} from "./editor-clip-evidence.ts";
export const VIDEO_SEMANTIC_SCHEMA_VERSION = 1 as const;
export const LOCAL_CLIP_ANALYSIS_VERSION = "local-clip-medical-v1";

const MAX_ID_LENGTH = 512;
const MAX_SUMMARY_LENGTH = 1_000;
const MAX_ACTION_LENGTH = 240;
const MAX_CONCEPT_LENGTH = 120;
const MAX_CONCEPTS = 16;
const MAX_EVIDENCE_FRAMES = 16;
const MAX_SEGMENTS = 128;
const MAX_ASSET_DURATION_MS = 86_400_000;

export type VideoSemanticSegment = Readonly<{
  id: string;
  assetId: string;
  startMs: number;
  endMs: number;
  summary: string;
  concepts: readonly string[];
  action?: string;
  usability: number;
  confidence: number;
  evidenceFrameMs: readonly number[];
  visualEvidence?: ClipVisualEvidence;
}>;

export type VideoSemanticAnalysisMethod = "local-clip" | "filename-fallback";

export function createFilenameFallbackAssetSemantics(semanticTopic: string) {
  return Object.freeze({
    semanticTopic,
    semanticScore: undefined,
  });
}

export type VideoSemanticAnalysis = Readonly<{
  schemaVersion: typeof VIDEO_SEMANTIC_SCHEMA_VERSION;
  assetId: string;
  assetDurationMs: number;
  segments: readonly VideoSemanticSegment[];
  analysisMethod: VideoSemanticAnalysisMethod;
  createdAt: string;
  analysisVersion: string;
}>;

export type VideoSourceRangeIdentity = Readonly<{
  assetId: string;
  startMs: number;
  endMs: number;
  key: string;
}>;

export type TimelineClipSourceIdentity = Readonly<{
  clipId: string;
  assetId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  sourceRangeKey: string;
}>;

export type LocalClipConceptScore = Readonly<{
  concept: string;
  score: number;
}>;

export type LocalClipFrameClassification = Readonly<{
  sourceTimeMs: number;
  concepts: readonly LocalClipConceptScore[];
}>;

export class VideoSemanticValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoSemanticValidationError";
  }
}

function fail(message: string): never {
  throw new VideoSemanticValidationError(message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail(`${label} is missing a required field.`);
  }
  if (actual.some((key) => !allowed.has(key))) {
    fail(`${label} contains an unknown field.`);
  }
}

function safeIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_ID_LENGTH
    || value !== value.trim()
    || /\u0000/.test(value)
    || /^(?:blob:|file:|https?:)/i.test(value)
    || /[\\/]/.test(value)
  ) {
    fail(`${label} must be a bounded trusted identity, not a URL or path.`);
  }
  return value;
}

function safeBoundedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength || /\u0000/.test(value)) {
    fail(`${label} must be a bounded string.`);
  }
  const normalized = value.trim();
  if (!normalized) fail(`${label} must not be empty.`);
  return normalized;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail(`${label} must be a finite integer in milliseconds.`);
  }
  return Number(value);
}

function safeScore(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be a finite number between 0 and 1.`);
  }
  return value;
}

function safeAnalysisVersion(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    fail("analysisVersion must be a bounded stable identifier.");
  }
  return value;
}

function safeCreatedAt(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    fail("createdAt must be a bounded UTC ISO timestamp.");
  }
  return value;
}

function freezeSegment(segment: VideoSemanticSegment): VideoSemanticSegment {
  Object.freeze(segment.concepts);
  Object.freeze(segment.evidenceFrameMs);
  return Object.freeze(segment);
}

export function parseVideoSemanticSegment(
  value: unknown,
  expectedAssetId?: string,
): VideoSemanticSegment {
  if (!plainRecord(value)) fail("VideoSemanticSegment must be an object.");
  requireExactKeys(
    value,
    ["id", "assetId", "startMs", "endMs", "summary", "concepts", "usability", "confidence", "evidenceFrameMs"],
    ["action", "visualEvidence"],
    "VideoSemanticSegment",
  );

  const id = safeIdentity(value.id, "segment.id");
  const assetId = safeIdentity(value.assetId, "segment.assetId");
  if (expectedAssetId !== undefined && assetId !== expectedAssetId) {
    fail("Segment asset identity does not match its analysis container.");
  }
  const startMs = safeInteger(value.startMs, "segment.startMs");
  const endMs = safeInteger(value.endMs, "segment.endMs");
  if (endMs <= startMs) fail("Segment endMs must be greater than startMs.");

  if (!Array.isArray(value.concepts) || value.concepts.length === 0 || value.concepts.length > MAX_CONCEPTS) {
    fail("segment.concepts must be a non-empty bounded array.");
  }
  const concepts = value.concepts.map((concept, index) =>
    safeBoundedText(concept, `segment.concepts[${index}]`, MAX_CONCEPT_LENGTH));
  if (new Set(concepts).size !== concepts.length) fail("segment.concepts must not contain duplicates.");

  if (
    !Array.isArray(value.evidenceFrameMs)
    || value.evidenceFrameMs.length === 0
    || value.evidenceFrameMs.length > MAX_EVIDENCE_FRAMES
  ) {
    fail("segment.evidenceFrameMs must be a non-empty bounded array.");
  }
  const evidenceFrameMs = value.evidenceFrameMs.map((timestamp, index) => {
    const parsed = safeInteger(timestamp, `segment.evidenceFrameMs[${index}]`);
    if (parsed < startMs || parsed > endMs) {
      fail("Evidence frame timestamp must be inside its source segment.");
    }
    return parsed;
  });
  if (new Set(evidenceFrameMs).size !== evidenceFrameMs.length) {
    fail("segment.evidenceFrameMs must not contain duplicates.");
  }

  const segment: VideoSemanticSegment = {
    id,
    assetId,
    startMs,
    endMs,
    summary: safeBoundedText(value.summary, "segment.summary", MAX_SUMMARY_LENGTH),
    concepts: Object.freeze(concepts),
    ...(value.action === undefined
      ? {}
      : { action: safeBoundedText(value.action, "segment.action", MAX_ACTION_LENGTH) }),
    usability: safeScore(value.usability, "segment.usability"),
    confidence: safeScore(value.confidence, "segment.confidence"),
    evidenceFrameMs: Object.freeze(evidenceFrameMs),
    ...(value.visualEvidence===undefined?{}:{visualEvidence:parseClipVisualEvidence(value.visualEvidence,startMs,endMs)}),
  };
  if(segment.visualEvidence && JSON.stringify([...segment.evidenceFrameMs].sort((a,b)=>a-b))!==JSON.stringify(segment.visualEvidence.frames.map(f=>f.sourceTimeMs).sort((a,b)=>a-b)))fail("CLIP sample times differ from segment evidence.");
  return freezeSegment(segment);
}

export function parseVideoSemanticAnalysis(value: unknown): VideoSemanticAnalysis {
  if (!plainRecord(value)) fail("VideoSemanticAnalysis must be an object.");
  requireExactKeys(
    value,
    ["schemaVersion", "assetId", "assetDurationMs", "segments", "analysisMethod", "createdAt", "analysisVersion"],
    [],
    "VideoSemanticAnalysis",
  );
  if (value.schemaVersion !== VIDEO_SEMANTIC_SCHEMA_VERSION) {
    fail("Unsupported video semantic schemaVersion.");
  }
  const assetId = safeIdentity(value.assetId, "analysis.assetId");
  const assetDurationMs = safeInteger(value.assetDurationMs, "analysis.assetDurationMs", 1);
  if (assetDurationMs > MAX_ASSET_DURATION_MS) fail("analysis.assetDurationMs exceeds the supported bound.");
  if (!Array.isArray(value.segments) || value.segments.length === 0 || value.segments.length > MAX_SEGMENTS) {
    fail("analysis.segments must be a non-empty bounded array.");
  }
  const segments = value.segments.map((segment) => parseVideoSemanticSegment(segment, assetId));
  if (new Set(segments.map((segment) => segment.id)).size !== segments.length) {
    fail("analysis.segments contains duplicate segment IDs.");
  }
  if (segments.some((segment) => segment.endMs > assetDurationMs)) {
    fail("A semantic segment exceeds the original asset duration.");
  }
  if (value.analysisMethod !== "local-clip" && value.analysisMethod !== "filename-fallback") {
    fail("analysisMethod is not supported by the local semantic foundation.");
  }
  if(value.analysisVersion===CLIP_ANALYSIS_VERSION && (value.analysisMethod!=="local-clip" || segments.some(s=>!s.visualEvidence))) fail("Current CLIP analyses require frame/model evidence.");
  const analysis: VideoSemanticAnalysis = {
    schemaVersion: VIDEO_SEMANTIC_SCHEMA_VERSION,
    assetId,
    assetDurationMs,
    segments: Object.freeze(segments),
    analysisMethod: value.analysisMethod,
    createdAt: safeCreatedAt(value.createdAt),
    analysisVersion: safeAnalysisVersion(value.analysisVersion),
  };
  Object.freeze(analysis.segments);
  return Object.freeze(analysis);
}

export function createSourceRangeIdentity(
  assetIdValue: unknown,
  startMsValue: unknown,
  endMsValue: unknown,
): VideoSourceRangeIdentity {
  const assetId = safeIdentity(assetIdValue, "sourceRange.assetId");
  const startMs = safeInteger(startMsValue, "sourceRange.startMs");
  const endMs = safeInteger(endMsValue, "sourceRange.endMs");
  if (endMs <= startMs) fail("Source range endMs must be greater than startMs.");
  return Object.freeze({
    assetId,
    startMs,
    endMs,
    key: `${encodeURIComponent(assetId)}@${startMs}-${endMs}`,
  });
}

export function sourceIdentityForSemanticSegment(segment: VideoSemanticSegment): VideoSourceRangeIdentity {
  return createSourceRangeIdentity(segment.assetId, segment.startMs, segment.endMs);
}

export function sourceIdentityForTimelineClip(clip: {
  id: unknown;
  assetId: unknown;
  sourceInMs: unknown;
  sourceOutMs: unknown;
}): TimelineClipSourceIdentity {
  const clipId = safeIdentity(clip.id, "clip.id");
  const range = createSourceRangeIdentity(clip.assetId, clip.sourceInMs, clip.sourceOutMs);
  return Object.freeze({
    clipId,
    assetId: range.assetId,
    sourceStartMs: range.startMs,
    sourceEndMs: range.endMs,
    sourceRangeKey: range.key,
  });
}

export function createVideoSemanticSegmentId(
  assetIdValue: unknown,
  startMsValue: unknown,
  endMsValue: unknown,
): string {
  const range = createSourceRangeIdentity(assetIdValue, startMsValue, endMsValue);
  return `video-semantic:${range.key}`;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeLocalClipAnalysis(input: {
  assetId: string;
  assetDurationMs: number;
  frames: readonly LocalClipFrameClassification[];
  analysisMethod: VideoSemanticAnalysisMethod;
  analysisVersion?: string;
  createdAt: string;
  usability?: number;
}): VideoSemanticAnalysis {
  const range = createSourceRangeIdentity(input.assetId, 0, input.assetDurationMs);
  if (!Array.isArray(input.frames) || input.frames.length === 0 || input.frames.length > MAX_EVIDENCE_FRAMES) {
    fail("Local CLIP normalization requires a non-empty bounded frame array.");
  }
  const aggregate = new Map<string, number>();
  const evidenceFrameMs = input.frames.map((frame, frameIndex) => {
    const sourceTimeMs = safeInteger(frame.sourceTimeMs, `frames[${frameIndex}].sourceTimeMs`);
    if (sourceTimeMs < range.startMs || sourceTimeMs > range.endMs) {
      fail("Local CLIP frame timestamp exceeds the original asset range.");
    }
    if (!Array.isArray(frame.concepts) || frame.concepts.length === 0 || frame.concepts.length > 32) {
      fail("Each local CLIP frame requires bounded concept scores.");
    }
    frame.concepts.forEach((entry: unknown, conceptIndex: number) => {
      if (!plainRecord(entry)) fail(`frames[${frameIndex}].concepts[${conceptIndex}] must be an object.`);
      requireExactKeys(entry, ["concept", "score"], [], `frames[${frameIndex}].concepts[${conceptIndex}]`);
      const concept = safeBoundedText(entry.concept, "local CLIP concept", MAX_CONCEPT_LENGTH);
      const score = safeScore(entry.score, "local CLIP score");
      aggregate.set(concept, Math.max(aggregate.get(concept) ?? 0, score));
    });
    return sourceTimeMs;
  });
  if (new Set(evidenceFrameMs).size !== evidenceFrameMs.length) {
    fail("Local CLIP frame timestamps must be unique.");
  }
  const ranked = [...aggregate.entries()]
    .sort((left, right) => right[1] - left[1] || lexicalCompare(left[0], right[0]))
    .slice(0, MAX_CONCEPTS);
  if (!ranked.length) fail("Local CLIP normalization produced no semantic concepts.");
  const topScore = ranked[0][1];
  const confidence = input.analysisMethod === "filename-fallback"
    ? Math.min(0.25, topScore)
    : topScore;
  return parseVideoSemanticAnalysis({
    schemaVersion: VIDEO_SEMANTIC_SCHEMA_VERSION,
    assetId: range.assetId,
    assetDurationMs: range.endMs,
    segments: [{
      id: createVideoSemanticSegmentId(range.assetId, range.startMs, range.endMs),
      assetId: range.assetId,
      startMs: range.startMs,
      endMs: range.endMs,
      summary: ranked.slice(0, 2).map(([concept]) => concept).join(" / "),
      concepts: ranked.map(([concept]) => concept),
      usability: input.usability ?? 1,
      confidence,
      evidenceFrameMs: [...evidenceFrameMs].sort((left, right) => left - right),
    }],
    analysisMethod: input.analysisMethod,
    createdAt: input.createdAt,
    analysisVersion: input.analysisVersion ?? LOCAL_CLIP_ANALYSIS_VERSION,
  });
}

function cacheKey(assetId: string, analysisVersion: string, assetDurationMs: number): string {
  return JSON.stringify([assetId, analysisVersion, assetDurationMs]);
}

export class VideoSemanticAnalysisCache {
  readonly #values = new Map<string, VideoSemanticAnalysis>();

  get size(): number {
    return this.#values.size;
  }

  get(assetIdValue: unknown, analysisVersionValue: unknown, assetDurationMsValue: unknown): VideoSemanticAnalysis | undefined {
    const assetId = safeIdentity(assetIdValue, "cache.assetId");
    const analysisVersion = safeAnalysisVersion(analysisVersionValue);
    const assetDurationMs = safeInteger(assetDurationMsValue, "cache.assetDurationMs", 1);
    return this.#values.get(cacheKey(assetId, analysisVersion, assetDurationMs));
  }

  set(value: unknown): VideoSemanticAnalysis {
    const analysis = parseVideoSemanticAnalysis(value);
    this.#values.set(
      cacheKey(analysis.assetId, analysis.analysisVersion, analysis.assetDurationMs),
      analysis,
    );
    return analysis;
  }

  invalidateAsset(assetIdValue: unknown): number {
    const assetId = safeIdentity(assetIdValue, "cache.assetId");
    let removed = 0;
    for (const [key, analysis] of this.#values) {
      if (analysis.assetId !== assetId) continue;
      this.#values.delete(key);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.#values.clear();
  }
}
