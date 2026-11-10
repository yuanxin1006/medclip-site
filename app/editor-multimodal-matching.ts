import {clipConceptScore} from "./editor-clip-evidence.ts";
import {EDITOR_VISUAL_TOPICS} from "./editor-caption-concepts.ts";
import {
  parseVideoSemanticSegment,
  type VideoSemanticSegment,
} from "./editor-video-semantic.ts";
import {
  parseAudioRhythmAnalysis,
  type AudioRhythmAnalysis,
} from "./editor-audio-rhythm.ts";

/**
 * V2.0A is deliberately a structured-evidence matcher, not a language model.
 * Caption text is retained for provenance, while semantic scoring uses only the
 * caller's trusted, explicit concepts. Unknown language therefore scores zero.
 *
 * The source-duration timing score is min(1, sourceDuration / intervalDuration).
 * Rhythm is retained as evidence but does not affect the V2.0A score.
 * Complexity is O(intervals * assets * bounded semantic segments).
 */

export const MULTIMODAL_MATCHING_WEIGHTS = Object.freeze({
  semantic: 0.55,
  usability: 0.20,
  timing: 0.15,
  repetition: 0.10,
});

export const SEMANTIC_SCORE_WEIGHTS = Object.freeze({
  aggregateConceptSupport: 0.75,
  strongestSegmentSupport: 0.25,
});

export const REPETITION_PENALTY_MODEL = Object.freeze({
  immediateRepeat: 0.70,
  perPriorUse: 0.10,
  maximumUsageOnly: 0.30,
});

export const MINIMUM_ACCEPTABLE_CANDIDATE_SCORE = 0.40;
export const MINIMUM_SEMANTIC_SCORE = 0.25;
export const MATCHING_THRESHOLD_EPSILON = 1e-9;
export const SOURCE_START_PLACEMENT_TOLERANCE_MS = 1_000;

export const MULTIMODAL_MATCHING_LIMITS = Object.freeze({
  maxIntervals: 128,
  maxAssets: 64,
  maxConcepts: 16,
  maxTextLength: 2_000,
  maxIdLength: 512,
  maxUsageCount: 1_000_000,
  maxAssetDurationMs: 86_400_000,
});

const SCORE_PRECISION = 1_000_000;

export type MatchingInterval = Readonly<{
  id: string;
  timelineStartMs: number;
  timelineEndMs: number;
  text: string;
  concepts: readonly string[];
}>;

export type MatchingAssetCandidate = Readonly<{
  assetId: string;
  sourceDurationMs: number;
  semanticSegments: readonly VideoSemanticSegment[];
}>;

export type MatchingContext = Readonly<{
  interval: MatchingInterval;
  assets: readonly MatchingAssetCandidate[];
  rhythm?: AudioRhythmAnalysis;
  previousAssetId?: string;
  assetUsage?: Readonly<Record<string, number>>;
}>;

export type SupportingSourceRange = Readonly<{
  segmentId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  confidence: number;
  usability: number;
  matchedConcepts: readonly string[];
}>;

export type SemanticConceptSupport = Readonly<{
  concept: string;
  confidence: number;
}>;

export type CandidateSemanticEvidence = Readonly<{
  intervalConcepts: readonly string[];
  conceptSupport: readonly SemanticConceptSupport[];
  aggregateConceptSupport: number;
  strongestSegmentSupport: number;
}>;

export type CandidateTimingEvidence = Readonly<{
  intervalDurationMs: number;
  sourceDurationMs: number;
}>;

export type CandidateRepetitionEvidence = Readonly<{
  usageCount: number;
  immediateRepeat: boolean;
  previousAssetId?: string;
}>;

export type RhythmBoundaryEvidence = Readonly<{
  rhythmSourceTimeMs: number;
  distanceMs: number;
}>;

export type IntervalRhythmEvidence = Readonly<{
  rhythmSourceId: string;
  nearestPauseToTimelineStart?: RhythmBoundaryEvidence;
  nearestPauseToTimelineEnd?: RhythmBoundaryEvidence;
  nearestOnsetToTimelineStart?: RhythmBoundaryEvidence;
  nearestOnsetToTimelineEnd?: RhythmBoundaryEvidence;
  meanEnergy: number | null;
}>;

export type CandidateMatchScore = Readonly<{
  assetId: string;
  semanticScore: number;
  usabilityScore: number;
  timingScore: number;
  repetitionPenalty: number;
  totalScore: number;
  matchedConcepts: readonly string[];
  supportingSegmentIds: readonly string[];
  supportingSourceRanges: readonly SupportingSourceRange[];
  evidenceFrameMs: readonly number[];
  sourceRangePlacementLimitation: boolean;
  semanticEvidence: CandidateSemanticEvidence;
  timingEvidence: CandidateTimingEvidence;
  repetitionEvidence: CandidateRepetitionEvidence;
}>;

export type CandidateRejectionReason =
  | "NO_VALID_CANDIDATE"
  | "LOW_SEMANTIC_SUPPORT"
  | "LOW_TOTAL_SCORE";

export type RankedCandidateSet = Readonly<{
  intervalId: string;
  candidates: readonly CandidateMatchScore[];
  selectedAssetId?: string;
  confidence: number;
  rejectionReason?: CandidateRejectionReason;
  rhythmEvidence?: IntervalRhythmEvidence;
}>;

export type CandidateTableInput = Readonly<{
  intervals: readonly MatchingInterval[];
  assets: readonly MatchingAssetCandidate[];
  rhythm?: AudioRhythmAnalysis;
  previousAssetId?: string;
  assetUsage?: Readonly<Record<string, number>>;
}>;

export class MultimodalMatchingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultimodalMatchingValidationError";
  }
}

function fail(message: string): never {
  throw new MultimodalMatchingValidationError(message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} is missing a required field.`);
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail(`${label} contains an unknown field.`);
  }
}

function safeIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MULTIMODAL_MATCHING_LIMITS.maxIdLength
    || value !== value.trim()
    || /\u0000/.test(value)
    || /^(?:blob:|file:|https?:)/i.test(value)
    || /[\\/]/.test(value)
  ) {
    fail(`${label} must be a bounded trusted identity, not a URL or path.`);
  }
  return value;
}

function safeTime(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail(`${label} must be a safe integer millisecond value.`);
  }
  return Number(value);
}

function safeText(value: unknown, label: string, allowEmpty = false): string {
  if (
    typeof value !== "string"
    || value.length > MULTIMODAL_MATCHING_LIMITS.maxTextLength
    || /\u0000/.test(value)
  ) {
    fail(`${label} must be a bounded string.`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) fail(`${label} must not be empty.`);
  return trimmed;
}

export function normalizeMatchingConcept(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("und");
}

function parseConcepts(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MULTIMODAL_MATCHING_LIMITS.maxConcepts) {
    fail(`${label} must be a bounded array.`);
  }
  const concepts = value.map((item, index) => {
    const concept = safeText(item, `${label}[${index}]`);
    if (concept.length > 120) fail(`${label}[${index}] exceeds the concept length bound.`);
    return normalizeMatchingConcept(concept);
  });
  if (new Set(concepts).size !== concepts.length) fail(`${label} contains duplicate normalized concepts.`);
  return Object.freeze(concepts);
}

export function parseMatchingInterval(value: unknown): MatchingInterval {
  if (!plainRecord(value)) fail("MatchingInterval must be a plain object.");
  exactKeys(value, ["id", "timelineStartMs", "timelineEndMs", "text", "concepts"], [], "MatchingInterval");
  const timelineStartMs = safeTime(value.timelineStartMs, "interval.timelineStartMs");
  const timelineEndMs = safeTime(value.timelineEndMs, "interval.timelineEndMs");
  if (timelineEndMs <= timelineStartMs) fail("interval.timelineEndMs must be greater than timelineStartMs.");
  if (timelineEndMs > MULTIMODAL_MATCHING_LIMITS.maxAssetDurationMs) {
    fail("interval timeline range exceeds the supported bound.");
  }
  return Object.freeze({
    id: safeIdentity(value.id, "interval.id"),
    timelineStartMs,
    timelineEndMs,
    text: safeText(value.text, "interval.text", true),
    concepts: parseConcepts(value.concepts, "interval.concepts"),
  });
}

export function parseMatchingAssetCandidate(value: unknown): MatchingAssetCandidate {
  if (!plainRecord(value)) fail("MatchingAssetCandidate must be a plain object.");
  exactKeys(value, ["assetId", "sourceDurationMs", "semanticSegments"], [], "MatchingAssetCandidate");
  const assetId = safeIdentity(value.assetId, "asset.assetId");
  const sourceDurationMs = safeTime(value.sourceDurationMs, "asset.sourceDurationMs", 1);
  if (sourceDurationMs > MULTIMODAL_MATCHING_LIMITS.maxAssetDurationMs) {
    fail("asset.sourceDurationMs exceeds the supported bound.");
  }
  if (!Array.isArray(value.semanticSegments) || value.semanticSegments.length === 0 || value.semanticSegments.length > 128) {
    fail("asset.semanticSegments must be a non-empty bounded array.");
  }
  let semanticSegments: VideoSemanticSegment[];
  try {
    semanticSegments = value.semanticSegments.map((segment) => parseVideoSemanticSegment(segment, assetId));
  } catch {
    fail("asset.semanticSegments contains invalid V1.9 semantic evidence.");
  }
  if (new Set(semanticSegments.map((segment) => segment.id)).size !== semanticSegments.length) {
    fail("asset.semanticSegments contains duplicate segment IDs.");
  }
  if (semanticSegments.some((segment) => segment.endMs > sourceDurationMs)) {
    fail("A semantic segment exceeds the trusted source duration.");
  }
  return Object.freeze({
    assetId,
    sourceDurationMs,
    semanticSegments: Object.freeze(semanticSegments),
  });
}

function parseUsage(value: unknown): Readonly<Record<string, number>> | undefined {
  if (value === undefined) return undefined;
  if (!plainRecord(value)) fail("assetUsage must be a plain record.");
  const entries = Object.entries(value);
  if (entries.length > MULTIMODAL_MATCHING_LIMITS.maxAssets) fail("assetUsage exceeds the supported bound.");
  const result: Record<string, number> = Object.create(null);
  for (const [key, count] of entries) {
    const assetId = safeIdentity(key, "assetUsage key");
    if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > MULTIMODAL_MATCHING_LIMITS.maxUsageCount) {
      fail("assetUsage values must be bounded non-negative integers.");
    }
    result[assetId] = Number(count);
  }
  return Object.freeze(result);
}

function parseAssets(value: unknown): readonly MatchingAssetCandidate[] {
  if (!Array.isArray(value) || value.length > MULTIMODAL_MATCHING_LIMITS.maxAssets) {
    fail("assets must be a bounded array.");
  }
  const assets = value.map(parseMatchingAssetCandidate);
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length) {
    fail("assets contains duplicate trusted asset IDs.");
  }
  return Object.freeze(assets);
}

function parseRhythm(value: unknown): AudioRhythmAnalysis | undefined {
  if (value === undefined) return undefined;
  try {
    return parseAudioRhythmAnalysis(value);
  } catch {
    fail("rhythm contains invalid V1.9 audio evidence.");
  }
}

export function parseMatchingContext(value: unknown): MatchingContext {
  if (!plainRecord(value)) fail("MatchingContext must be a plain object.");
  exactKeys(value, ["interval", "assets"], ["rhythm", "previousAssetId", "assetUsage"], "MatchingContext");
  const previousAssetId = value.previousAssetId === undefined
    ? undefined
    : safeIdentity(value.previousAssetId, "previousAssetId");
  return Object.freeze({
    interval: parseMatchingInterval(value.interval),
    assets: parseAssets(value.assets),
    ...(value.rhythm === undefined ? {} : { rhythm: parseRhythm(value.rhythm)! }),
    ...(previousAssetId === undefined ? {} : { previousAssetId }),
    ...(value.assetUsage === undefined ? {} : { assetUsage: parseUsage(value.assetUsage)! }),
  });
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * SCORE_PRECISION) / SCORE_PRECISION;
}

function boundaryEvidence(timeMs: number, boundaryMs: number): RhythmBoundaryEvidence {
  return Object.freeze({ rhythmSourceTimeMs: timeMs, distanceMs: Math.abs(timeMs - boundaryMs) });
}

function nearestTime(times: readonly number[], boundaryMs: number): RhythmBoundaryEvidence | undefined {
  if (times.length === 0) return undefined;
  const timeMs = [...times].sort((left, right) =>
    Math.abs(left - boundaryMs) - Math.abs(right - boundaryMs) || left - right)[0];
  return boundaryEvidence(timeMs, boundaryMs);
}

export function rhythmEvidenceForInterval(
  intervalValue: unknown,
  rhythmValue: unknown,
): IntervalRhythmEvidence {
  const interval = parseMatchingInterval(intervalValue);
  const rhythm = parseRhythm(rhythmValue);
  if (!rhythm) fail("rhythm evidence is required.");
  const pauseBoundaries = rhythm.segments
    .filter((segment) => segment.pause)
    .flatMap((segment) => [segment.startMs, segment.endMs]);
  const onsetTimes = rhythm.onsets.map((onset) => onset.timeMs);
  const energyPoints = rhythm.energyEnvelope.filter((point) =>
    point.timeMs >= interval.timelineStartMs && point.timeMs <= interval.timelineEndMs);
  const meanEnergy = energyPoints.length === 0
    ? null
    : roundScore(energyPoints.reduce((sum, point) => sum + point.energy, 0) / energyPoints.length);
  return Object.freeze({
    rhythmSourceId: rhythm.sourceId,
    ...(nearestTime(pauseBoundaries, interval.timelineStartMs) === undefined
      ? {}
      : { nearestPauseToTimelineStart: nearestTime(pauseBoundaries, interval.timelineStartMs)! }),
    ...(nearestTime(pauseBoundaries, interval.timelineEndMs) === undefined
      ? {}
      : { nearestPauseToTimelineEnd: nearestTime(pauseBoundaries, interval.timelineEndMs)! }),
    ...(nearestTime(onsetTimes, interval.timelineStartMs) === undefined
      ? {}
      : { nearestOnsetToTimelineStart: nearestTime(onsetTimes, interval.timelineStartMs)! }),
    ...(nearestTime(onsetTimes, interval.timelineEndMs) === undefined
      ? {}
      : { nearestOnsetToTimelineEnd: nearestTime(onsetTimes, interval.timelineEndMs)! }),
    meanEnergy,
  });
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repetitionPenalty(assetId: string, previousAssetId: string | undefined, usage: Readonly<Record<string, number>>): number {
  const immediate = previousAssetId === assetId ? REPETITION_PENALTY_MODEL.immediateRepeat : 0;
  const usagePenalty = Math.min(
    REPETITION_PENALTY_MODEL.maximumUsageOnly,
    (usage[assetId] ?? 0) * REPETITION_PENALTY_MODEL.perPriorUse,
  );
  return roundScore(immediate + usagePenalty);
}

function conceptConfidence(segment: VideoSemanticSegment,concept:string):number {
  if(!segment.visualEvidence)return segment.confidence; // Legacy evidence retains its original contract.
  const topic=EDITOR_VISUAL_TOPICS.find(t=>normalizeMatchingConcept(t.title)===concept);
  return topic?clipConceptScore(segment.visualEvidence,topic.label):0;
}

function scoreAsset(
  interval: MatchingInterval,
  asset: MatchingAssetCandidate,
  previousAssetId: string | undefined,
  usage: Readonly<Record<string, number>>,
): CandidateMatchScore {
  const wanted = interval.concepts;
  const wantedSet = new Set(wanted);
  const matchingSegments = asset.semanticSegments
    .map((segment) => {
      const normalized = segment.concepts.map(normalizeMatchingConcept);
      const matches = wanted.filter((concept) => normalized.includes(concept) && (!segment.visualEvidence || conceptConfidence(segment,concept)>0));
      return { segment, matches };
    })
    .filter((item) => item.matches.length > 0)
    .sort((left, right) => left.segment.startMs - right.segment.startMs || lexicalCompare(left.segment.id, right.segment.id));

  const conceptSupport = wanted.map((concept) => Math.max(0, ...matchingSegments
    .filter((item) => item.matches.includes(concept))
    .map((item) => conceptConfidence(item.segment,concept))));
  const aggregateSupport = conceptSupport.length === 0
    ? 0
    : conceptSupport.reduce((sum, score) => sum + score, 0) / conceptSupport.length;
  const strongestSegmentSupport = Math.max(0, ...matchingSegments.map((item) =>
    item.matches.reduce((sum,c)=>sum+conceptConfidence(item.segment,c),0) / Math.max(1, wantedSet.size)));
  const semanticScore = roundScore(
    aggregateSupport * SEMANTIC_SCORE_WEIGHTS.aggregateConceptSupport
    + strongestSegmentSupport * SEMANTIC_SCORE_WEIGHTS.strongestSegmentSupport,
  );
  const usabilityScore = roundScore(Math.max(0, ...matchingSegments.map(({segment,matches}) => segment.usability * Math.max(0,...matches.map(c=>conceptConfidence(segment,c))))));
  const intervalDurationMs = interval.timelineEndMs - interval.timelineStartMs;
  const timingScore = roundScore(Math.min(1, asset.sourceDurationMs / intervalDurationMs));
  const repeatPenalty = repetitionPenalty(asset.assetId, previousAssetId, usage);
  const totalScore = roundScore(
    semanticScore * MULTIMODAL_MATCHING_WEIGHTS.semantic
    + usabilityScore * MULTIMODAL_MATCHING_WEIGHTS.usability
    + timingScore * MULTIMODAL_MATCHING_WEIGHTS.timing
    - repeatPenalty * MULTIMODAL_MATCHING_WEIGHTS.repetition,
  );
  const supportingSourceRanges = matchingSegments.map(({ segment, matches }) => Object.freeze({
    segmentId: segment.id,
    sourceStartMs: segment.startMs,
    sourceEndMs: segment.endMs,
    confidence: segment.confidence, // Source identity only; concept scores remain in semanticEvidence.
    usability: segment.usability,
    matchedConcepts: Object.freeze([...matches]),
  }));
  const matchedConcepts = wanted.filter((concept) => matchingSegments.some((item) => item.matches.includes(concept)));
  const evidenceFrameMs = [...new Set(matchingSegments.flatMap(({ segment }) => segment.evidenceFrameMs))]
    .sort((left, right) => left - right);
  const sourceRangePlacementLimitation = matchingSegments.length > 0
    && matchingSegments.every(({ segment }) => segment.startMs > SOURCE_START_PLACEMENT_TOLERANCE_MS);
  const usageCount = usage[asset.assetId] ?? 0;

  return Object.freeze({
    assetId: asset.assetId,
    semanticScore,
    usabilityScore,
    timingScore,
    repetitionPenalty: repeatPenalty,
    totalScore,
    matchedConcepts: Object.freeze(matchedConcepts),
    supportingSegmentIds: Object.freeze(matchingSegments.map(({ segment }) => segment.id)),
    supportingSourceRanges: Object.freeze(supportingSourceRanges),
    evidenceFrameMs: Object.freeze(evidenceFrameMs),
    sourceRangePlacementLimitation,
    semanticEvidence: Object.freeze({
      intervalConcepts: Object.freeze([...wanted]),
      conceptSupport: Object.freeze(wanted.map((concept, index) => Object.freeze({
        concept,
        confidence: roundScore(conceptSupport[index]),
      }))),
      aggregateConceptSupport: roundScore(aggregateSupport),
      strongestSegmentSupport: roundScore(strongestSegmentSupport),
    }),
    timingEvidence: Object.freeze({ intervalDurationMs, sourceDurationMs: asset.sourceDurationMs }),
    repetitionEvidence: Object.freeze({
      usageCount,
      immediateRepeat: previousAssetId === asset.assetId,
      ...(previousAssetId === undefined ? {} : { previousAssetId }),
    }),
  });
}

export function candidateClearsMatchingThresholds(
  score: Pick<CandidateMatchScore, "semanticScore" | "totalScore">,
): boolean {
  return score.semanticScore + MATCHING_THRESHOLD_EPSILON >= MINIMUM_SEMANTIC_SCORE
    && score.totalScore + MATCHING_THRESHOLD_EPSILON >= MINIMUM_ACCEPTABLE_CANDIDATE_SCORE;
}

function compareCandidates(left: CandidateMatchScore, right: CandidateMatchScore): number {
  return right.totalScore - left.totalScore
    || right.semanticScore - left.semanticScore
    || right.usabilityScore - left.usabilityScore
    || left.repetitionPenalty - right.repetitionPenalty
    || lexicalCompare(left.assetId, right.assetId);
}

export function rankMultimodalCandidates(value: unknown): RankedCandidateSet {
  const context = parseMatchingContext(value);
  const usage = context.assetUsage ?? Object.freeze(Object.create(null) as Record<string, number>);
  const candidates = context.assets
    .map((asset) => scoreAsset(context.interval, asset, context.previousAssetId, usage))
    .sort(compareCandidates);
  const first = candidates[0];
  const selected = first !== undefined && candidateClearsMatchingThresholds(first) ? first : undefined;
  const rejectionReason: CandidateRejectionReason | undefined = selected
    ? undefined
    : first === undefined
      ? "NO_VALID_CANDIDATE"
      : first.semanticScore + MATCHING_THRESHOLD_EPSILON < MINIMUM_SEMANTIC_SCORE
        ? "LOW_SEMANTIC_SUPPORT"
        : "LOW_TOTAL_SCORE";
  return Object.freeze({
    intervalId: context.interval.id,
    candidates: Object.freeze(candidates),
    ...(selected ? { selectedAssetId: selected.assetId } : {}),
    confidence: first?.totalScore ?? 0,
    ...(rejectionReason ? { rejectionReason } : {}),
    ...(context.rhythm ? { rhythmEvidence: rhythmEvidenceForInterval(context.interval, context.rhythm) } : {}),
  });
}

export function buildMultimodalCandidateTable(value: unknown): readonly RankedCandidateSet[] {
  if (!plainRecord(value)) fail("CandidateTableInput must be a plain object.");
  exactKeys(value, ["intervals", "assets"], ["rhythm", "previousAssetId", "assetUsage"], "CandidateTableInput");
  if (!Array.isArray(value.intervals) || value.intervals.length > MULTIMODAL_MATCHING_LIMITS.maxIntervals) {
    fail("intervals must be a bounded array.");
  }
  const intervals = value.intervals.map(parseMatchingInterval);
  if (new Set(intervals.map((interval) => interval.id)).size !== intervals.length) {
    fail("intervals contains duplicate trusted IDs.");
  }
  const assets = parseAssets(value.assets);
  const rhythm = parseRhythm(value.rhythm);
  let previousAssetId = value.previousAssetId === undefined
    ? undefined
    : safeIdentity(value.previousAssetId, "previousAssetId");
  const usage = { ...(parseUsage(value.assetUsage) ?? {}) };
  const results: RankedCandidateSet[] = [];
  for (const interval of intervals) {
    const ranked = rankMultimodalCandidates({
      interval,
      assets,
      ...(rhythm ? { rhythm } : {}),
      ...(previousAssetId ? { previousAssetId } : {}),
      assetUsage: usage,
    });
    results.push(ranked);
    if (ranked.selectedAssetId) {
      usage[ranked.selectedAssetId] = (usage[ranked.selectedAssetId] ?? 0) + 1;
      previousAssetId = ranked.selectedAssetId;
    }
  }
  return Object.freeze(results);
}
