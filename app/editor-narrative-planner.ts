import {
  MULTIMODAL_MATCHING_LIMITS,
  candidateClearsMatchingThresholds,
  normalizeMatchingConcept,
  parseMatchingInterval,
  type CandidateMatchScore,
  type MatchingInterval,
  type RankedCandidateSet,
  type SupportingSourceRange,
} from "./editor-multimodal-matching.ts";
import {
  parseVideoSemanticSegment,
  type VideoSemanticSegment,
} from "./editor-video-semantic.ts";

/**
 * V2.0B refines already-acceptable V2.0A matches. It never creates candidates,
 * lowers V2.0A thresholds, mutates a timeline, or emits editor actions.
 *
 * The bounded beam expands at most:
 * maxIntervals * maxBeamWidth * maxCandidatesPerInterval
 * = 128 * 64 * 3 = 24,576 states.
 */

export const NARRATIVE_PLANNER_LIMITS = Object.freeze({
  maxIntervals: MULTIMODAL_MATCHING_LIMITS.maxIntervals,
  maxCandidatesPerInterval: 3,
  maxBeamWidth: 64,
  maxProgressionHints: 16,
  recentReuseWindow: 4,
});

export const NARRATIVE_SCORE_MODEL = Object.freeze({
  localScoreWeight: 1,
  maximumLocalScoreDeficit: 0.08,
  maximumSemanticScoreDeficit: 0.08,
  adjacentActionProgression: 0.03,
  skippedActionProgression: 0.015,
  actionRegressionPenalty: 0.02,
  maximumSubjectContinuity: 0.02,
  immediateRepeatPenalty: 0.05,
  abaOscillationPenalty: 0.04,
  perRecentReusePenalty: 0.01,
  maximumRecentReusePenalty: 0.02,
});

const SCORE_PRECISION = 1_000_000;
const MAX_ACTION_LENGTH = 240;

const DEFAULT_ACTION_PROGRESSIONS = Object.freeze([
  Object.freeze(["consultation", "explanation", "examination", "treatment", "recovery"]),
  Object.freeze(["approach", "enter", "operate", "leave"]),
]);

export type NarrativeReasonCode =
  | "ACTION_PROGRESSION_SUPPORTED"
  | "ACTION_REGRESSION"
  | "SUBJECT_CONTINUITY_PRESERVED"
  | "IMMEDIATE_ASSET_REPEAT"
  | "ABA_ASSET_OSCILLATION"
  | "RECENT_ASSET_REUSE";

export type NarrativeTransitionEvidence = Readonly<{
  code: NarrativeReasonCode;
  scoreDelta: number;
  summary: string;
  fromAssetId?: string;
  toAssetId: string;
  fromAction?: string;
  toAction?: string;
  sharedConcepts?: readonly string[];
  priorIntervalDistance?: number;
}>;

export type NarrativePlanningContext = Readonly<{
  intervals: readonly MatchingInterval[];
  rankedCandidateSets: readonly RankedCandidateSet[];
  semanticEvidence: readonly VideoSemanticSegment[];
  actionProgressionHints?: readonly string[];
}>;

export type NarrativeResolvedIntervalPlan = Readonly<{
  status: "resolved";
  intervalId: string;
  assetId: string;
  localScore: number;
  semanticScore: number;
  narrativeScore: number;
  supportingSegmentIds: readonly string[];
  supportingSourceRanges: readonly SupportingSourceRange[];
  evidenceFrameMs: readonly number[];
  matchEvidence: CandidateMatchScore;
  transitionEvidence: readonly NarrativeTransitionEvidence[];
}>;

export type NarrativeUnresolvedIntervalPlan = Readonly<{
  status: "unresolved";
  intervalId: string;
  narrativeScore: 0;
  reason: "NO_ACCEPTED_V2_0A_CANDIDATE";
}>;

export type NarrativeIntervalPlan = NarrativeResolvedIntervalPlan | NarrativeUnresolvedIntervalPlan;

export type NarrativeSequencePlan = Readonly<{
  intervalPlans: readonly NarrativeIntervalPlan[];
  totalLocalScore: number;
  totalNarrativeScore: number;
  totalSequenceScore: number;
  totalSemanticScore: number;
  totalSequenceRepetitionPenalty: number;
  unresolvedIntervalIds: readonly string[];
}>;

export class NarrativePlanningValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarrativePlanningValidationError";
  }
}

type NarrativeCandidate = Readonly<{
  match: CandidateMatchScore;
  actions: readonly string[];
  subjectConcepts: readonly string[];
}>;

type BeamState = Readonly<{
  plans: readonly NarrativeIntervalPlan[];
  selectedCandidates: readonly NarrativeCandidate[];
  recentAssetIds: readonly string[];
  totalLocalScore: number;
  totalNarrativeScore: number;
  totalSemanticScore: number;
  totalSequenceRepetitionPenalty: number;
}>;

function fail(message: string): never {
  throw new NarrativePlanningValidationError(message);
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
  if (required.some((key) => !Object.hasOwn(value, key))) fail(`${label} is missing a required field.`);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail(`${label} contains an unknown field.`);
}

function roundScore(value: number): number {
  return Math.round(value * SCORE_PRECISION) / SCORE_PRECISION;
}

function safeScore(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be a finite normalized score.`);
  }
  return value;
}

function safeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be boolean.`);
  return value;
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

function safeTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a safe source-relative millisecond value.`);
  return Number(value);
}

function safeStringArray(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must be a bounded array.`);
  const parsed = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item !== item.trim() || item.length > 512 || /\u0000/.test(item)) {
      fail(`${label}[${index}] must be a bounded string.`);
    }
    return item;
  });
  if (new Set(parsed).size !== parsed.length) fail(`${label} must not contain duplicates.`);
  return Object.freeze(parsed);
}

function normalizedConceptArray(value: unknown, label: string, maximum: number): readonly string[] {
  const normalized = safeStringArray(value, label, maximum).map(normalizeMatchingConcept);
  if (new Set(normalized).size !== normalized.length) fail(`${label} contains duplicate normalized concepts.`);
  return Object.freeze(normalized);
}

function parseSourceRange(value: unknown, assetId: string, segmentMap: ReadonlyMap<string, VideoSemanticSegment>): SupportingSourceRange {
  if (!plainRecord(value)) fail("Candidate supporting source range must be a plain object.");
  exactKeys(
    value,
    ["segmentId", "sourceStartMs", "sourceEndMs", "confidence", "usability", "matchedConcepts"],
    [],
    "Candidate supporting source range",
  );
  const segmentId = safeIdentity(value.segmentId, "sourceRange.segmentId");
  const segment = segmentMap.get(segmentId);
  if (!segment || segment.assetId !== assetId) fail("Candidate source evidence does not resolve to its trusted asset.");
  const sourceStartMs = safeTime(value.sourceStartMs, "sourceRange.sourceStartMs");
  const sourceEndMs = safeTime(value.sourceEndMs, "sourceRange.sourceEndMs");
  if (
    sourceStartMs !== segment.startMs
    || sourceEndMs !== segment.endMs
    || value.confidence !== segment.confidence
    || value.usability !== segment.usability
  ) {
    fail("Candidate source range does not match trusted semantic evidence.");
  }
  const matchedConcepts = normalizedConceptArray(value.matchedConcepts, "sourceRange.matchedConcepts", 16);
  const segmentConcepts = new Set(segment.concepts.map(normalizeMatchingConcept));
  if (matchedConcepts.some((concept) => !segmentConcepts.has(concept))) {
    fail("Candidate matched concepts are not supported by its semantic segment.");
  }
  return Object.freeze({
    segmentId,
    sourceStartMs,
    sourceEndMs,
    confidence: safeScore(value.confidence, "sourceRange.confidence"),
    usability: safeScore(value.usability, "sourceRange.usability"),
    matchedConcepts: Object.freeze(matchedConcepts),
  });
}

function parseCandidate(
  value: unknown,
  interval: MatchingInterval,
  segmentMap: ReadonlyMap<string, VideoSemanticSegment>,
): CandidateMatchScore {
  if (!plainRecord(value)) fail("CandidateMatchScore must be a plain object.");
  exactKeys(value, [
    "assetId",
    "semanticScore",
    "usabilityScore",
    "timingScore",
    "repetitionPenalty",
    "totalScore",
    "matchedConcepts",
    "supportingSegmentIds",
    "supportingSourceRanges",
    "evidenceFrameMs",
    "sourceRangePlacementLimitation",
    "semanticEvidence",
    "timingEvidence",
    "repetitionEvidence",
  ], [], "CandidateMatchScore");
  const assetId = safeIdentity(value.assetId, "candidate.assetId");
  const supportingSegmentIds = safeStringArray(value.supportingSegmentIds, "candidate.supportingSegmentIds", 128)
    .map((id) => safeIdentity(id, "candidate.supportingSegmentIds item"));
  const supportingSegments = supportingSegmentIds.map((id) => {
    const segment = segmentMap.get(id);
    if (!segment || segment.assetId !== assetId) fail("Candidate segment identity does not resolve to its trusted asset.");
    return segment;
  });
  if (!Array.isArray(value.supportingSourceRanges) || value.supportingSourceRanges.length !== supportingSegmentIds.length) {
    fail("Candidate source ranges must align with supporting segment IDs.");
  }
  const supportingSourceRanges = value.supportingSourceRanges.map((range) => parseSourceRange(range, assetId, segmentMap));
  if (supportingSourceRanges.some((range, index) => range.segmentId !== supportingSegmentIds[index])) {
    fail("Candidate source ranges must preserve supporting segment order.");
  }
  const matchedConcepts = normalizedConceptArray(value.matchedConcepts, "candidate.matchedConcepts", 16);
  const evidenceFrameMs = (() => {
    if (!Array.isArray(value.evidenceFrameMs) || value.evidenceFrameMs.length > 128) {
      fail("candidate.evidenceFrameMs must be a bounded array.");
    }
    const frames = value.evidenceFrameMs.map((time, index) => safeTime(time, `candidate.evidenceFrameMs[${index}]`));
    if (new Set(frames).size !== frames.length || frames.some((time, index) => index > 0 && time <= frames[index - 1])) {
      fail("candidate.evidenceFrameMs must be unique and increasing.");
    }
    const supportedFrames = new Set(supportingSegments.flatMap((segment) => [...segment.evidenceFrameMs]));
    if (frames.some((time) => !supportedFrames.has(time))) fail("Candidate frame evidence is not backed by a semantic segment.");
    return Object.freeze(frames);
  })();

  if (!plainRecord(value.semanticEvidence)) fail("candidate.semanticEvidence must be a plain object.");
  exactKeys(
    value.semanticEvidence,
    ["intervalConcepts", "conceptSupport", "aggregateConceptSupport", "strongestSegmentSupport"],
    [],
    "candidate.semanticEvidence",
  );
  const intervalConcepts = normalizedConceptArray(
    value.semanticEvidence.intervalConcepts,
    "semanticEvidence.intervalConcepts",
    16,
  );
  if (JSON.stringify(intervalConcepts) !== JSON.stringify(interval.concepts)) {
    fail("Candidate semantic evidence belongs to a different interval.");
  }
  if (!Array.isArray(value.semanticEvidence.conceptSupport) || value.semanticEvidence.conceptSupport.length !== intervalConcepts.length) {
    fail("Candidate concept support must align with interval concepts.");
  }
  const conceptSupport = value.semanticEvidence.conceptSupport.map((entry, index) => {
    if (!plainRecord(entry)) fail("Candidate concept support must contain plain objects.");
    exactKeys(entry, ["concept", "confidence"], [], "candidate concept support");
    if (typeof entry.concept !== "string") fail("Candidate concept support label must be a string.");
    const concept = normalizeMatchingConcept(entry.concept);
    if (concept !== intervalConcepts[index]) fail("Candidate concept support order does not match the interval.");
    return Object.freeze({ concept, confidence: safeScore(entry.confidence, "conceptSupport.confidence") });
  });

  if (!plainRecord(value.timingEvidence)) fail("candidate.timingEvidence must be a plain object.");
  exactKeys(value.timingEvidence, ["intervalDurationMs", "sourceDurationMs"], [], "candidate.timingEvidence");
  const intervalDurationMs = safeTime(value.timingEvidence.intervalDurationMs, "timingEvidence.intervalDurationMs");
  const sourceDurationMs = safeTime(value.timingEvidence.sourceDurationMs, "timingEvidence.sourceDurationMs");
  if (intervalDurationMs !== interval.timelineEndMs - interval.timelineStartMs || sourceDurationMs <= 0) {
    fail("Candidate timing evidence does not match the trusted interval.");
  }

  if (!plainRecord(value.repetitionEvidence)) fail("candidate.repetitionEvidence must be a plain object.");
  exactKeys(value.repetitionEvidence, ["usageCount", "immediateRepeat"], ["previousAssetId"], "candidate.repetitionEvidence");
  if (!Number.isSafeInteger(value.repetitionEvidence.usageCount) || Number(value.repetitionEvidence.usageCount) < 0) {
    fail("Candidate repetition usageCount must be a non-negative safe integer.");
  }
  const immediateRepeat = safeBoolean(value.repetitionEvidence.immediateRepeat, "repetitionEvidence.immediateRepeat");
  const previousAssetId = value.repetitionEvidence.previousAssetId === undefined
    ? undefined
    : safeIdentity(value.repetitionEvidence.previousAssetId, "repetitionEvidence.previousAssetId");

  const candidate: CandidateMatchScore = Object.freeze({
    assetId,
    semanticScore: safeScore(value.semanticScore, "candidate.semanticScore"),
    usabilityScore: safeScore(value.usabilityScore, "candidate.usabilityScore"),
    timingScore: safeScore(value.timingScore, "candidate.timingScore"),
    repetitionPenalty: safeScore(value.repetitionPenalty, "candidate.repetitionPenalty"),
    totalScore: safeScore(value.totalScore, "candidate.totalScore"),
    matchedConcepts: Object.freeze(matchedConcepts),
    supportingSegmentIds: Object.freeze(supportingSegmentIds),
    supportingSourceRanges: Object.freeze(supportingSourceRanges),
    evidenceFrameMs,
    sourceRangePlacementLimitation: safeBoolean(
      value.sourceRangePlacementLimitation,
      "candidate.sourceRangePlacementLimitation",
    ),
    semanticEvidence: Object.freeze({
      intervalConcepts: Object.freeze(intervalConcepts),
      conceptSupport: Object.freeze(conceptSupport),
      aggregateConceptSupport: safeScore(value.semanticEvidence.aggregateConceptSupport, "semanticEvidence.aggregateConceptSupport"),
      strongestSegmentSupport: safeScore(value.semanticEvidence.strongestSegmentSupport, "semanticEvidence.strongestSegmentSupport"),
    }),
    timingEvidence: Object.freeze({ intervalDurationMs, sourceDurationMs }),
    repetitionEvidence: Object.freeze({
      usageCount: Number(value.repetitionEvidence.usageCount),
      immediateRepeat,
      ...(previousAssetId === undefined ? {} : { previousAssetId }),
    }),
  });
  if (
    candidateClearsMatchingThresholds(candidate)
    && (
      candidate.supportingSegmentIds.length === 0
      || candidate.matchedConcepts.length === 0
      || candidate.evidenceFrameMs.length === 0
    )
  ) {
    fail("An acceptable V2.0A candidate must retain concrete semantic source evidence.");
  }
  return candidate;
}

function compareLocalCandidates(left: CandidateMatchScore, right: CandidateMatchScore): number {
  return right.totalScore - left.totalScore
    || right.semanticScore - left.semanticScore
    || right.usabilityScore - left.usabilityScore
    || left.repetitionPenalty - right.repetitionPenalty
    || lexicalCompare(left.assetId, right.assetId);
}

function parseRankedCandidateSet(
  value: unknown,
  interval: MatchingInterval,
  segmentMap: ReadonlyMap<string, VideoSemanticSegment>,
): RankedCandidateSet {
  if (!plainRecord(value)) fail("RankedCandidateSet must be a plain object.");
  exactKeys(
    value,
    ["intervalId", "candidates", "confidence"],
    ["selectedAssetId", "rejectionReason", "rhythmEvidence"],
    "RankedCandidateSet",
  );
  const intervalId = safeIdentity(value.intervalId, "candidateSet.intervalId");
  if (intervalId !== interval.id) fail("Ranked candidate set does not match its trusted interval.");
  if (!Array.isArray(value.candidates) || value.candidates.length > MULTIMODAL_MATCHING_LIMITS.maxAssets) {
    fail("Ranked candidate set must contain a bounded candidate array.");
  }
  const candidates = value.candidates.map((candidate) => parseCandidate(candidate, interval, segmentMap));
  if (new Set(candidates.map((candidate) => candidate.assetId)).size !== candidates.length) {
    fail("Ranked candidate set contains duplicate asset IDs.");
  }
  const sorted = [...candidates].sort(compareLocalCandidates);
  if (sorted.some((candidate, index) => candidate.assetId !== candidates[index]?.assetId)) {
    fail("Ranked candidates do not preserve V2.0A deterministic ordering.");
  }
  const selectedAssetId = value.selectedAssetId === undefined
    ? undefined
    : safeIdentity(value.selectedAssetId, "candidateSet.selectedAssetId");
  if (selectedAssetId !== undefined) {
    if (
      value.rejectionReason !== undefined
      || candidates[0]?.assetId !== selectedAssetId
      || !candidateClearsMatchingThresholds(candidates[0])
    ) {
      fail("Ranked candidate selection is inconsistent with V2.0A acceptance.");
    }
  }
  if (selectedAssetId === undefined) {
    if (!(["NO_VALID_CANDIDATE", "LOW_SEMANTIC_SUPPORT", "LOW_TOTAL_SCORE"] as const).includes(value.rejectionReason as never)) {
      fail("Unresolved candidate set requires a V2.0A rejection reason.");
    }
  }
  if (value.rhythmEvidence !== undefined && !plainRecord(value.rhythmEvidence)) {
    fail("candidateSet.rhythmEvidence must be structured V2.0A evidence.");
  }
  const confidence = safeScore(value.confidence, "candidateSet.confidence");
  if (confidence !== (candidates[0]?.totalScore ?? 0)) {
    fail("Ranked candidate confidence does not match the V2.0A leading score.");
  }
  return Object.freeze({
    intervalId,
    candidates: Object.freeze(candidates),
    ...(selectedAssetId === undefined ? {} : { selectedAssetId }),
    confidence,
    ...(value.rejectionReason === undefined ? {} : { rejectionReason: value.rejectionReason as RankedCandidateSet["rejectionReason"] }),
    ...(value.rhythmEvidence === undefined ? {} : { rhythmEvidence: value.rhythmEvidence as RankedCandidateSet["rhythmEvidence"] }),
  });
}

function parseProgressionHints(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 2 || value.length > NARRATIVE_PLANNER_LIMITS.maxProgressionHints) {
    fail("actionProgressionHints must contain between two and sixteen action labels.");
  }
  const hints = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.length > MAX_ACTION_LENGTH || /\u0000/.test(item)) {
      fail(`actionProgressionHints[${index}] must be a bounded action label.`);
    }
    return normalizeMatchingConcept(item);
  });
  if (new Set(hints).size !== hints.length) fail("actionProgressionHints must not contain duplicate normalized labels.");
  return Object.freeze(hints);
}

export function parseNarrativePlanningContext(value: unknown): NarrativePlanningContext {
  if (!plainRecord(value)) fail("NarrativePlanningContext must be a plain object.");
  exactKeys(
    value,
    ["intervals", "rankedCandidateSets", "semanticEvidence"],
    ["actionProgressionHints"],
    "NarrativePlanningContext",
  );
  if (!Array.isArray(value.intervals) || value.intervals.length > NARRATIVE_PLANNER_LIMITS.maxIntervals) {
    fail("Narrative intervals must be a bounded array.");
  }
  const intervals = value.intervals.map((interval) => {
    try {
      return parseMatchingInterval(interval);
    } catch {
      fail("Narrative intervals contain invalid V2.0A matching intervals.");
    }
  });
  if (new Set(intervals.map((interval) => interval.id)).size !== intervals.length) fail("Narrative intervals contain duplicate IDs.");
  if (intervals.some((interval, index) => index > 0 && interval.timelineStartMs < intervals[index - 1].timelineEndMs)) {
    fail("Narrative intervals must be ordered and non-overlapping.");
  }
  if (!Array.isArray(value.semanticEvidence) || value.semanticEvidence.length > 8_192) {
    fail("semanticEvidence must be a bounded array.");
  }
  const semanticEvidence = value.semanticEvidence.map((segment) => {
    try {
      return parseVideoSemanticSegment(segment);
    } catch {
      fail("semanticEvidence contains invalid V1.9 video evidence.");
    }
  });
  const segmentMap = new Map(semanticEvidence.map((segment) => [segment.id, segment]));
  if (segmentMap.size !== semanticEvidence.length) fail("semanticEvidence contains duplicate segment IDs.");
  if (!Array.isArray(value.rankedCandidateSets) || value.rankedCandidateSets.length !== intervals.length) {
    fail("Each narrative interval requires exactly one ordered ranked candidate set.");
  }
  const rankedCandidateSets = value.rankedCandidateSets.map((set, index) =>
    parseRankedCandidateSet(set, intervals[index], segmentMap));
  const actionProgressionHints = parseProgressionHints(value.actionProgressionHints);
  return Object.freeze({
    intervals: Object.freeze(intervals),
    rankedCandidateSets: Object.freeze(rankedCandidateSets),
    semanticEvidence: Object.freeze(semanticEvidence),
    ...(actionProgressionHints === undefined ? {} : { actionProgressionHints }),
  });
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateFromMatch(
  match: CandidateMatchScore,
  segmentMap: ReadonlyMap<string, VideoSemanticSegment>,
): NarrativeCandidate {
  const segments = match.supportingSegmentIds.map((id) => segmentMap.get(id)!);
  const actions = [...new Set(segments
    .map((segment) => segment.action && normalizeMatchingConcept(segment.action))
    .filter((action): action is string => Boolean(action)))]
    .sort(lexicalCompare);
  const subjectConcepts = [...new Set(segments.flatMap((segment) => segment.concepts.map(normalizeMatchingConcept)))]
    .sort(lexicalCompare);
  return Object.freeze({
    match,
    actions: Object.freeze(actions),
    subjectConcepts: Object.freeze(subjectConcepts),
  });
}

function eligibleCandidates(
  set: RankedCandidateSet,
  segmentMap: ReadonlyMap<string, VideoSemanticSegment>,
): readonly NarrativeCandidate[] {
  // A rejected V2.0A set is terminal even if a lower-ranked row happens to
  // satisfy the scalar thresholds in isolation. V2.0B cannot resurrect it.
  if (set.selectedAssetId === undefined) return Object.freeze([]);
  const accepted = set.candidates.filter(candidateClearsMatchingThresholds);
  const best = accepted[0];
  if (!best) return Object.freeze([]);
  return Object.freeze(accepted
    .filter((candidate) =>
      best.totalScore - candidate.totalScore <= NARRATIVE_SCORE_MODEL.maximumLocalScoreDeficit
      && best.semanticScore - candidate.semanticScore <= NARRATIVE_SCORE_MODEL.maximumSemanticScoreDeficit)
    .slice(0, NARRATIVE_PLANNER_LIMITS.maxCandidatesPerInterval)
    .map((candidate) => candidateFromMatch(candidate, segmentMap)));
}

function actionProgression(
  previous: NarrativeCandidate,
  next: NarrativeCandidate,
  hint: readonly string[] | undefined,
): NarrativeTransitionEvidence | undefined {
  const progressions = hint ? [hint] : DEFAULT_ACTION_PROGRESSIONS;
  const options: NarrativeTransitionEvidence[] = [];
  for (const fromAction of previous.actions) {
    for (const toAction of next.actions) {
      for (const progression of progressions) {
        const fromIndex = progression.indexOf(fromAction);
        const toIndex = progression.indexOf(toAction);
        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) continue;
        const forward = toIndex > fromIndex;
        const scoreDelta = forward
          ? toIndex === fromIndex + 1
            ? NARRATIVE_SCORE_MODEL.adjacentActionProgression
            : NARRATIVE_SCORE_MODEL.skippedActionProgression
          : -NARRATIVE_SCORE_MODEL.actionRegressionPenalty;
        options.push(Object.freeze({
          code: forward ? "ACTION_PROGRESSION_SUPPORTED" : "ACTION_REGRESSION",
          scoreDelta,
          summary: forward
            ? `Explicit action evidence progresses from ${fromAction} to ${toAction}.`
            : `Explicit action evidence regresses from ${fromAction} to ${toAction}.`,
          fromAssetId: previous.match.assetId,
          toAssetId: next.match.assetId,
          fromAction,
          toAction,
        }));
      }
    }
  }
  return options.sort((left, right) =>
    right.scoreDelta - left.scoreDelta
    || lexicalCompare(left.fromAction ?? "", right.fromAction ?? "")
    || lexicalCompare(left.toAction ?? "", right.toAction ?? ""))[0];
}

function subjectContinuity(previous: NarrativeCandidate, next: NarrativeCandidate): NarrativeTransitionEvidence | undefined {
  const previousConcepts = new Set(previous.subjectConcepts);
  const sharedConcepts = next.subjectConcepts.filter((concept) => previousConcepts.has(concept));
  if (sharedConcepts.length === 0) return undefined;
  const unionSize = new Set([...previous.subjectConcepts, ...next.subjectConcepts]).size;
  const scoreDelta = roundScore(NARRATIVE_SCORE_MODEL.maximumSubjectContinuity * sharedConcepts.length / unionSize);
  return Object.freeze({
    code: "SUBJECT_CONTINUITY_PRESERVED",
    scoreDelta,
    summary: `Non-identifying semantic subjects continue: ${sharedConcepts.join(", ")}.`,
    fromAssetId: previous.match.assetId,
    toAssetId: next.match.assetId,
    sharedConcepts: Object.freeze(sharedConcepts),
  });
}

function repetitionEvidence(
  next: NarrativeCandidate,
  recentAssetIds: readonly string[],
): readonly NarrativeTransitionEvidence[] {
  if (recentAssetIds.length === 0) return Object.freeze([]);
  const result: NarrativeTransitionEvidence[] = [];
  const previousAssetId = recentAssetIds.at(-1);
  const twoBackAssetId = recentAssetIds.at(-2);
  if (previousAssetId === next.match.assetId) {
    result.push(Object.freeze({
      code: "IMMEDIATE_ASSET_REPEAT",
      scoreDelta: -NARRATIVE_SCORE_MODEL.immediateRepeatPenalty,
      summary: "The same original asset is repeated in adjacent resolved intervals.",
      fromAssetId: previousAssetId,
      toAssetId: next.match.assetId,
      priorIntervalDistance: 1,
    }));
  }
  if (twoBackAssetId === next.match.assetId && previousAssetId !== next.match.assetId) {
    result.push(Object.freeze({
      code: "ABA_ASSET_OSCILLATION",
      scoreDelta: -NARRATIVE_SCORE_MODEL.abaOscillationPenalty,
      summary: "The sequence returns to the same original asset after one intervening asset.",
      fromAssetId: twoBackAssetId,
      toAssetId: next.match.assetId,
      priorIntervalDistance: 2,
    }));
  }
  const reusableWindow = recentAssetIds.slice(-NARRATIVE_PLANNER_LIMITS.recentReuseWindow);
  const priorUses = reusableWindow.filter((assetId) => assetId === next.match.assetId).length;
  if (priorUses > 0) {
    result.push(Object.freeze({
      code: "RECENT_ASSET_REUSE",
      scoreDelta: -Math.min(
        NARRATIVE_SCORE_MODEL.maximumRecentReusePenalty,
        priorUses * NARRATIVE_SCORE_MODEL.perRecentReusePenalty,
      ),
      summary: `The original asset already appears ${priorUses} time(s) in the bounded recent window.`,
      fromAssetId: previousAssetId,
      toAssetId: next.match.assetId,
      priorIntervalDistance: reusableWindow.length - reusableWindow.lastIndexOf(next.match.assetId),
    }));
  }
  return Object.freeze(result);
}

export function scoreNarrativeTransition(
  previous: NarrativeCandidate | undefined,
  next: NarrativeCandidate,
  recentAssetIds: readonly string[],
  actionProgressionHints?: readonly string[],
): Readonly<{ score: number; repetitionPenalty: number; evidence: readonly NarrativeTransitionEvidence[] }> {
  if (!previous) return Object.freeze({ score: 0, repetitionPenalty: 0, evidence: Object.freeze([]) });
  const evidence = [
    actionProgression(previous, next, actionProgressionHints),
    subjectContinuity(previous, next),
    ...repetitionEvidence(next, recentAssetIds),
  ].filter((item): item is NarrativeTransitionEvidence => item !== undefined);
  const score = roundScore(evidence.reduce((sum, item) => sum + item.scoreDelta, 0));
  const repetitionPenalty = roundScore(-evidence
    .filter((item) => item.code === "IMMEDIATE_ASSET_REPEAT" || item.code === "ABA_ASSET_OSCILLATION" || item.code === "RECENT_ASSET_REUSE")
    .reduce((sum, item) => sum + item.scoreDelta, 0));
  return Object.freeze({ score, repetitionPenalty, evidence: Object.freeze(evidence) });
}

function assetSequence(state: BeamState): string {
  return state.plans.map((plan) => plan.status === "resolved" ? plan.assetId : "~").join("\u0001");
}

function compareBeamStates(left: BeamState, right: BeamState): number {
  const leftSequence = roundScore(left.totalLocalScore + left.totalNarrativeScore);
  const rightSequence = roundScore(right.totalLocalScore + right.totalNarrativeScore);
  return rightSequence - leftSequence
    || right.totalLocalScore - left.totalLocalScore
    || right.totalSemanticScore - left.totalSemanticScore
    || left.totalSequenceRepetitionPenalty - right.totalSequenceRepetitionPenalty
    || lexicalCompare(assetSequence(left), assetSequence(right));
}

function unresolvedPlan(intervalId: string): NarrativeUnresolvedIntervalPlan {
  return Object.freeze({
    status: "unresolved",
    intervalId,
    narrativeScore: 0,
    reason: "NO_ACCEPTED_V2_0A_CANDIDATE",
  });
}

export function planNarrativeSequence(value: unknown): NarrativeSequencePlan {
  const context = parseNarrativePlanningContext(value);
  const segmentMap = new Map(context.semanticEvidence.map((segment) => [segment.id, segment]));
  let beam: readonly BeamState[] = [Object.freeze({
    plans: Object.freeze([]),
    selectedCandidates: Object.freeze([]),
    recentAssetIds: Object.freeze([]),
    totalLocalScore: 0,
    totalNarrativeScore: 0,
    totalSemanticScore: 0,
    totalSequenceRepetitionPenalty: 0,
  })];

  context.intervals.forEach((interval, intervalIndex) => {
    const candidates = eligibleCandidates(context.rankedCandidateSets[intervalIndex], segmentMap);
    if (candidates.length === 0) {
      beam = beam.map((state) => Object.freeze({
        ...state,
        plans: Object.freeze([...state.plans, unresolvedPlan(interval.id)]),
        selectedCandidates: Object.freeze([]),
        recentAssetIds: Object.freeze([]),
      }));
      return;
    }
    const expanded: BeamState[] = [];
    for (const state of beam) {
      for (const candidate of candidates) {
        const previous = state.selectedCandidates.at(-1);
        const transition = scoreNarrativeTransition(
          previous,
          candidate,
          state.recentAssetIds,
          context.actionProgressionHints,
        );
        const plan: NarrativeResolvedIntervalPlan = Object.freeze({
          status: "resolved",
          intervalId: interval.id,
          assetId: candidate.match.assetId,
          localScore: candidate.match.totalScore,
          semanticScore: candidate.match.semanticScore,
          narrativeScore: transition.score,
          supportingSegmentIds: candidate.match.supportingSegmentIds,
          supportingSourceRanges: candidate.match.supportingSourceRanges,
          evidenceFrameMs: candidate.match.evidenceFrameMs,
          matchEvidence: candidate.match,
          transitionEvidence: transition.evidence,
        });
        expanded.push(Object.freeze({
          plans: Object.freeze([...state.plans, plan]),
          selectedCandidates: Object.freeze([...state.selectedCandidates, candidate].slice(-2)),
          recentAssetIds: Object.freeze(
            [...state.recentAssetIds, candidate.match.assetId].slice(-NARRATIVE_PLANNER_LIMITS.recentReuseWindow),
          ),
          totalLocalScore: roundScore(state.totalLocalScore + candidate.match.totalScore * NARRATIVE_SCORE_MODEL.localScoreWeight),
          totalNarrativeScore: roundScore(state.totalNarrativeScore + transition.score),
          totalSemanticScore: roundScore(state.totalSemanticScore + candidate.match.semanticScore),
          totalSequenceRepetitionPenalty: roundScore(
            state.totalSequenceRepetitionPenalty + transition.repetitionPenalty,
          ),
        }));
      }
    }
    beam = Object.freeze(expanded.sort(compareBeamStates).slice(0, NARRATIVE_PLANNER_LIMITS.maxBeamWidth));
  });

  const winner = [...beam].sort(compareBeamStates)[0]!;
  const unresolvedIntervalIds = winner.plans
    .filter((plan): plan is NarrativeUnresolvedIntervalPlan => plan.status === "unresolved")
    .map((plan) => plan.intervalId);
  return Object.freeze({
    intervalPlans: winner.plans,
    totalLocalScore: winner.totalLocalScore,
    totalNarrativeScore: winner.totalNarrativeScore,
    totalSequenceScore: roundScore(winner.totalLocalScore + winner.totalNarrativeScore),
    totalSemanticScore: winner.totalSemanticScore,
    totalSequenceRepetitionPenalty: winner.totalSequenceRepetitionPenalty,
    unresolvedIntervalIds: Object.freeze(unresolvedIntervalIds),
  });
}
