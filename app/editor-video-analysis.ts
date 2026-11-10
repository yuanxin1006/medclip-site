import {CLIP_TEST_ENABLED,CLIP_ANALYSIS_VERSION,CLIP_MODEL_SOURCE,type ClipFrameEvidence,type ClipPrediction} from "./editor-clip-evidence.ts";
import {
  MAX_COARSE_VIDEO_FRAME_COUNT,
  MAX_FINE_VIDEO_FRAME_COUNT,
  createCoarseFrameSampleTimes,
  createFineFrameSampleTimes,
  type FrameSample,
} from "./editor-video-sampling.ts";
import {
  VIDEO_SEMANTIC_SCHEMA_VERSION,
  LOCAL_CLIP_ANALYSIS_VERSION,
  VideoSemanticAnalysisCache,
  createSourceRangeIdentity,
  createVideoSemanticSegmentId,
  parseVideoSemanticAnalysis,
  parseVideoSemanticSegment,
  type VideoSemanticAnalysis,
  type VideoSemanticSegment,
} from "./editor-video-semantic.ts";

export const TWO_STAGE_LOCAL_ANALYSIS_VERSION = CLIP_TEST_ENABLED ? CLIP_ANALYSIS_VERSION : "local-clip-medical-two-stage-v1";
export const MAX_CANDIDATE_RANGES_PER_ASSET = 3;
export const MAX_TOTAL_CLASSIFIED_FRAMES_PER_ASSET =
  MAX_COARSE_VIDEO_FRAME_COUNT
  + MAX_CANDIDATE_RANGES_PER_ASSET * MAX_FINE_VIDEO_FRAME_COUNT;

const MAX_OBSERVATION_CONCEPTS = 16;
const MAX_RAW_CLASSIFICATIONS = 64;
const USABLE_CLASSIFICATION_SCORE = 0.5;
const LOCAL_DECODABLE_USABILITY = 0.5;

export type VideoFrameConcept = Readonly<{
  label: string;
  score: number;
}>;

export type VideoFrameObservation = Readonly<{
  assetId: string;
  sourceTimeMs: number;
  concepts: readonly VideoFrameConcept[];
  dominantConcept: string;
  confidence: number;
}>;

export type VideoConceptSupport = Readonly<{
  label: string;
  supportCount: number;
  dominantCount: number;
  meanScore: number;
}>;

export type CoarseVideoAnalysis = Readonly<{
  assetId: string;
  observations: readonly VideoFrameObservation[];
  dominantConcepts: readonly string[];
  conceptSupport: readonly VideoConceptSupport[];
  confidence: number;
  usability: number;
}>;

export type VideoCandidateSourceRange = Readonly<{
  assetId: string;
  startMs: number;
  endMs: number;
  basisConcepts: readonly string[];
  confidence: number;
}>;

export type RawLocalClipClassification = Readonly<{
  label: string;
  score: number;
  cosineSimilarity?: number;
  logit?: number;
  modelSource?: typeof CLIP_MODEL_SOURCE;
}>;

export type VideoAnalysisFrameFailure = Readonly<{
  assetId: string;
  sourceTimeMs: number;
  stage: "capture" | "classification";
  message: string;
}>;

export type VideoAnalysisErrorCode =
  | "INVALID_INPUT"
  | "FRAME_CAPTURE_FAILED"
  | "INSUFFICIENT_EVIDENCE"
  | "ANALYSIS_ABORTED";

export class VideoAnalysisError extends Error {
  readonly code: VideoAnalysisErrorCode;

  constructor(code: VideoAnalysisErrorCode, message: string) {
    super(message);
    this.name = "VideoAnalysisError";
    this.code = code;
  }
}

export type TwoStageVideoAnalysisResult = Readonly<{
  analysis: VideoSemanticAnalysis;
  coarse: CoarseVideoAnalysis | null;
  candidates: readonly VideoCandidateSourceRange[];
  failures: readonly VideoAnalysisFrameFailure[];
  classifiedFrameCount: number;
  fromCache: boolean;
}>;

export type TwoStageVideoAnalysisInput = Readonly<{
  assetId: string;
  assetDurationMs: number;
  createdAt: string;
  captureFrames: (
    sourceTimeMs: readonly number[],
    stage: "coarse" | "fine",
  ) => Promise<readonly FrameSample[]>;
  classifyFrame: (sample: FrameSample) => Promise<readonly RawLocalClipClassification[]>;
  labelMap?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  cache?: VideoSemanticAnalysisCache;
  analysisVersion?: string;
  detailedSampling?: boolean;
  signal?: AbortSignal;
}>;

function fail(code: VideoAnalysisErrorCode, message: string): never {
  throw new VideoAnalysisError(code, message);
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function validLabel(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 120
    || value !== value.trim()
    || /\u0000/.test(value)
  ) {
    fail("INVALID_INPUT", `${field} must be a bounded normalized label.`);
  }
  return value;
}

function validScore(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail("INVALID_INPUT", `${field} must be a finite score between zero and one.`);
  }
  return value;
}

function validTime(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail("INVALID_INPUT", `${field} must be a non-negative source-relative millisecond value.`);
  }
  return Number(value);
}

function assertActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail("ANALYSIS_ABORTED", "Video analysis was cancelled or its asset was removed.");
}

function lookupMappedLabel(
  label: string,
  labelMap: TwoStageVideoAnalysisInput["labelMap"],
): string | undefined {
  if (!labelMap) return label;
  if (typeof (labelMap as ReadonlyMap<string, string>).get === "function") {
    return (labelMap as ReadonlyMap<string, string>).get(label);
  }
  return (labelMap as Readonly<Record<string, string>>)[label];
}

export function parseVideoFrameObservation(value: unknown): VideoFrameObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_INPUT", "VideoFrameObservation must be an object.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expected = ["assetId", "sourceTimeMs", "concepts", "dominantConcept", "confidence"];
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) {
    fail("INVALID_INPUT", "VideoFrameObservation has missing or unknown fields.");
  }
  const assetId = createSourceRangeIdentity(record.assetId, 0, 1).assetId;
  const sourceTimeMs = validTime(record.sourceTimeMs, "observation.sourceTimeMs");
  if (
    !Array.isArray(record.concepts)
    || record.concepts.length === 0
    || record.concepts.length > MAX_OBSERVATION_CONCEPTS
  ) {
    fail("INVALID_INPUT", "Observation concepts must be a non-empty bounded array.");
  }
  const concepts = record.concepts.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("INVALID_INPUT", `observation.concepts[${index}] must be an object.`);
    }
    const concept = entry as Record<string, unknown>;
    if (
      Object.keys(concept).length !== 2
      || !Object.hasOwn(concept, "label")
      || !Object.hasOwn(concept, "score")
    ) {
      fail("INVALID_INPUT", `observation.concepts[${index}] has missing or unknown fields.`);
    }
    return Object.freeze({
      label: validLabel(concept.label, `observation.concepts[${index}].label`),
      score: validScore(concept.score, `observation.concepts[${index}].score`),
    });
  });
  if (new Set(concepts.map((concept) => concept.label)).size !== concepts.length) {
    fail("INVALID_INPUT", "Observation concept labels must be unique.");
  }
  const sorted = [...concepts].sort((left, right) =>
    right.score - left.score || lexicalCompare(left.label, right.label));
  if (sorted.some((concept, index) => concept !== concepts[index])) {
    fail("INVALID_INPUT", "Observation concepts must use deterministic score and label ordering.");
  }
  const dominantConcept = validLabel(record.dominantConcept, "observation.dominantConcept");
  if (dominantConcept !== concepts[0].label) {
    fail("INVALID_INPUT", "Observation dominantConcept must match its highest-ranked concept.");
  }
  const confidence = validScore(record.confidence, "observation.confidence");
  if (confidence !== concepts[0].score) {
    fail("INVALID_INPUT", "Observation confidence must equal its strongest observed score.");
  }
  return Object.freeze({
    assetId,
    sourceTimeMs,
    concepts: Object.freeze(concepts),
    dominantConcept,
    confidence,
  });
}

export function adaptLocalClipFrameObservation(input: {
  assetId: string;
  sourceTimeMs: number;
  classifications: readonly RawLocalClipClassification[];
  labelMap?: TwoStageVideoAnalysisInput["labelMap"];
}): VideoFrameObservation {
  createSourceRangeIdentity(input.assetId, 0, 1);
  validTime(input.sourceTimeMs, "sourceTimeMs");
  if (
    !Array.isArray(input.classifications)
    || input.classifications.length === 0
    || input.classifications.length > MAX_RAW_CLASSIFICATIONS
  ) {
    fail("INVALID_INPUT", "Local CLIP returned an empty or unbounded classification.");
  }
  const mapped = new Map<string, number>();
  input.classifications.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("INVALID_INPUT", `classification[${index}] must be an object.`);
    }
    const rawLabel = validLabel(entry.label, `classification[${index}].label`);
    const score = validScore(entry.score, `classification[${index}].score`);
    const mappedLabel = lookupMappedLabel(rawLabel, input.labelMap);
    if (mappedLabel === undefined) return;
    const label = validLabel(mappedLabel, `classification[${index}].mappedLabel`);
    mapped.set(label, Math.max(mapped.get(label) ?? 0, score));
  });
  const concepts = [...mapped.entries()]
    .sort((left, right) => right[1] - left[1] || lexicalCompare(left[0], right[0]))
    .slice(0, MAX_OBSERVATION_CONCEPTS)
    .map(([label, score]) => ({ label, score }));
  if (concepts.length === 0) {
    fail("INSUFFICIENT_EVIDENCE", "Local CLIP returned no recognized concepts.");
  }
  return parseVideoFrameObservation({
    assetId: input.assetId,
    sourceTimeMs: input.sourceTimeMs,
    concepts,
    dominantConcept: concepts[0].label,
    confidence: concepts[0].score,
  });
}

function observationConceptScore(observation: VideoFrameObservation, label: string): number {
  return observation.concepts.find((concept) => concept.label === label)?.score ?? 0;
}

export function aggregateVideoFrameObservations(
  assetId: string,
  values: readonly VideoFrameObservation[],
): CoarseVideoAnalysis {
  createSourceRangeIdentity(assetId, 0, 1);
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_TOTAL_CLASSIFIED_FRAMES_PER_ASSET) {
    fail("INSUFFICIENT_EVIDENCE", "Semantic aggregation requires bounded frame observations.");
  }
  const observations = values.map((value) => parseVideoFrameObservation(value));
  if (observations.some((observation) => observation.assetId !== assetId)) {
    fail("INVALID_INPUT", "Frame observation asset identity changed during aggregation.");
  }
  const ordered = [...observations].sort((left, right) => left.sourceTimeMs - right.sourceTimeMs);
  if (new Set(ordered.map((observation) => observation.sourceTimeMs)).size !== ordered.length) {
    fail("INVALID_INPUT", "Frame observations must have unique source timestamps.");
  }
  const labels = new Set(ordered.flatMap((observation) => observation.concepts.map((concept) => concept.label)));
  const conceptSupport = [...labels].map((label) => {
    const scores = ordered.map((observation) => observationConceptScore(observation, label));
    return Object.freeze({
      label,
      supportCount: scores.filter((score) => score >= USABLE_CLASSIFICATION_SCORE).length,
      dominantCount: ordered.filter((observation) => observation.dominantConcept === label).length,
      meanScore: roundScore(scores.reduce((sum, score) => sum + score, 0) / ordered.length),
    });
  }).sort((left, right) =>
    right.dominantCount - left.dominantCount
    || right.supportCount - left.supportCount
    || right.meanScore - left.meanScore
    || lexicalCompare(left.label, right.label));
  const consensus = conceptSupport[0];
  const agreement = consensus.dominantCount / ordered.length;
  const sampleWeight = ordered.length === 1 ? 0.6 : ordered.length === 2 ? 0.85 : 1;
  const confidence = roundScore(consensus.meanScore * agreement * sampleWeight);
  return Object.freeze({
    assetId,
    observations: Object.freeze(ordered),
    dominantConcepts: Object.freeze(conceptSupport.slice(0, 3).map((concept) => concept.label)),
    conceptSupport: Object.freeze(conceptSupport),
    confidence,
    usability: LOCAL_DECODABLE_USABILITY,
  });
}

export function createCandidateSourceRanges(input: {
  assetId: string;
  assetDurationMs: number;
  observations: readonly VideoFrameObservation[];
}): readonly VideoCandidateSourceRange[] {
  const fullRange = createSourceRangeIdentity(input.assetId, 0, input.assetDurationMs);
  const aggregate = aggregateVideoFrameObservations(fullRange.assetId, input.observations);
  if (aggregate.observations.some((observation) => observation.sourceTimeMs > fullRange.endMs)) {
    fail("INVALID_INPUT", "A coarse observation exceeds the asset duration.");
  }
  const transitions = aggregate.observations.slice(1).flatMap((current, index) => {
    const previous = aggregate.observations[index];
    if (previous.dominantConcept === current.dominantConcept) return [];
    const boundary = Math.floor((previous.sourceTimeMs + current.sourceTimeMs) / 2);
    if (boundary <= 0 || boundary >= fullRange.endMs) return [];
    return [{ boundary, strength: roundScore((previous.confidence + current.confidence) / 2) }];
  });
  const selectedBoundaries = transitions
    .sort((left, right) => right.strength - left.strength || left.boundary - right.boundary)
    .slice(0, MAX_CANDIDATE_RANGES_PER_ASSET - 1)
    .map((transition) => transition.boundary)
    .sort((left, right) => left - right);
  const boundaries = [0, ...new Set(selectedBoundaries), fullRange.endMs];
  const candidates = boundaries.slice(0, -1).map((startMs, index) => {
    const endMs = boundaries[index + 1];
    const supporting = aggregate.observations.filter((observation) =>
      observation.sourceTimeMs >= startMs
      && (index === boundaries.length - 2
        ? observation.sourceTimeMs <= endMs
        : observation.sourceTimeMs < endMs));
    const evidence = supporting.length ? aggregateVideoFrameObservations(fullRange.assetId, supporting) : aggregate;
    return Object.freeze({
      assetId: fullRange.assetId,
      startMs,
      endMs,
      basisConcepts: Object.freeze(evidence.dominantConcepts.slice(0, 2)),
      confidence: evidence.confidence,
    });
  });
  return Object.freeze(candidates);
}

function failureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Frame classification failed.";
}

function candidatesFromCachedAnalysis(analysis: VideoSemanticAnalysis): readonly VideoCandidateSourceRange[] {
  return Object.freeze(analysis.segments.map((segment) => Object.freeze({
    assetId: segment.assetId,
    startMs: segment.startMs,
    endMs: segment.endMs,
    basisConcepts: Object.freeze(segment.concepts.slice(0, 2)),
    confidence: segment.confidence,
  })));
}

export async function analyzeVideoAssetTwoStage(
  input: TwoStageVideoAnalysisInput,
): Promise<TwoStageVideoAnalysisResult> {
  const fullRange = createSourceRangeIdentity(input.assetId, 0, input.assetDurationMs);
  const analysisVersion = input.analysisVersion ?? TWO_STAGE_LOCAL_ANALYSIS_VERSION;
  assertActive(input.signal);
  const cached = input.cache?.get(fullRange.assetId, analysisVersion, fullRange.endMs);
  if (cached) {
    return Object.freeze({
      analysis: cached,
      coarse: null,
      candidates: candidatesFromCachedAnalysis(cached),
      failures: Object.freeze([]),
      classifiedFrameCount: 0,
      fromCache: true,
    });
  }

  const failures: VideoAnalysisFrameFailure[] = [];
  const observations = new Map<number, VideoFrameObservation>();
  const frameEvidence = new Map<number,ClipFrameEvidence>();
  let classifiedFrameCount = 0;

  const observe = async (timestamps: readonly number[], stage: "coarse" | "fine") => {
    assertActive(input.signal);
    let samples: readonly FrameSample[];
    try {
      samples = await input.captureFrames(timestamps, stage);
    } catch (error) {
      fail("FRAME_CAPTURE_FAILED", `Could not capture ${stage} frames: ${failureMessage(error)}`);
    }
    assertActive(input.signal);
    const requested = new Set(timestamps);
    const returnedTimes = new Set<number>();
    for (const sample of samples) {
      if (
        sample.assetId !== fullRange.assetId
        || !requested.has(sample.sourceTimeMs)
        || returnedTimes.has(sample.sourceTimeMs)
        || typeof sample.image !== "string"
        || sample.image.length === 0
      ) {
        fail("INVALID_INPUT", "Captured frame identity or timestamp did not match its request.");
      }
      returnedTimes.add(sample.sourceTimeMs);
      if (observations.has(sample.sourceTimeMs)) continue;
      assertActive(input.signal);
      classifiedFrameCount += 1;
      if (classifiedFrameCount > MAX_TOTAL_CLASSIFIED_FRAMES_PER_ASSET) {
        fail("INVALID_INPUT", "Video analysis exceeded its hard classification budget.");
      }
      try {
        const classifications = await input.classifyFrame(sample);
        assertActive(input.signal);
        if(analysisVersion===CLIP_ANALYSIS_VERSION){
          if(classifications.some(p=>JSON.stringify(p.modelSource)!==JSON.stringify(CLIP_MODEL_SOURCE)))throw new Error("Missing fixed CLIP model provenance.");
          frameEvidence.set(sample.sourceTimeMs,{sourceTimeMs:sample.sourceTimeMs,image:sample.image,predictions:classifications.map(p=>({label:p.label,score:p.score,cosineSimilarity:p.cosineSimilarity!,logit:p.logit!}))});
        }
        observations.set(sample.sourceTimeMs, adaptLocalClipFrameObservation({
          assetId: fullRange.assetId,
          sourceTimeMs: sample.sourceTimeMs,
          classifications,
          labelMap: input.labelMap,
        }));
      } catch (error) {
        if (error instanceof VideoAnalysisError && error.code === "ANALYSIS_ABORTED") throw error;
        failures.push(Object.freeze({
          assetId: fullRange.assetId,
          sourceTimeMs: sample.sourceTimeMs,
          stage: "classification",
          message: failureMessage(error),
        }));
      }
    }
    for (const sourceTimeMs of timestamps) {
      if (returnedTimes.has(sourceTimeMs)) continue;
      failures.push(Object.freeze({
        assetId: fullRange.assetId,
        sourceTimeMs,
        stage: "capture",
        message: "Frame sampler did not return the requested source timestamp.",
      }));
    }
  };

  const coarseTimes = createCoarseFrameSampleTimes(fullRange.endMs, input.detailedSampling ?? true);
  await observe(coarseTimes, "coarse");
  const coarseObservations = coarseTimes.flatMap((timestamp) => {
    const observation = observations.get(timestamp);
    return observation ? [observation] : [];
  });
  if (coarseObservations.length === 0) {
    fail("INSUFFICIENT_EVIDENCE", "No valid coarse frame observations were produced.");
  }
  const coarse = aggregateVideoFrameObservations(fullRange.assetId, coarseObservations);
  const candidates = createCandidateSourceRanges({
    assetId: fullRange.assetId,
    assetDurationMs: fullRange.endMs,
    observations: coarse.observations,
  });
  const fineTimesByCandidate = candidates.map((candidate) =>
    createFineFrameSampleTimes(candidate.startMs, candidate.endMs));
  const newFineTimes = [...new Set(fineTimesByCandidate.flat())]
    .filter((timestamp) => !observations.has(timestamp))
    .sort((left, right) => left - right);
  if (newFineTimes.length > 0) await observe(newFineTimes, "fine");

  const segments: VideoSemanticSegment[] = candidates.map((candidate, index) => {
    const fineObservations = fineTimesByCandidate[index].flatMap((timestamp) => {
      const observation = observations.get(timestamp);
      return observation ? [observation] : [];
    });
    if (fineObservations.length === 0) {
      fail("INSUFFICIENT_EVIDENCE", `Candidate range ${candidate.startMs}-${candidate.endMs} has no fine evidence.`);
    }
    const aggregate = aggregateVideoFrameObservations(fullRange.assetId, fineObservations);
    return parseVideoSemanticSegment({
      id: createVideoSemanticSegmentId(fullRange.assetId, candidate.startMs, candidate.endMs),
      assetId: fullRange.assetId,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      summary: aggregate.dominantConcepts.join(" / "),
      concepts: aggregate.dominantConcepts,
      usability: aggregate.usability,
      confidence: aggregate.confidence,
      evidenceFrameMs: aggregate.observations.map((observation) => observation.sourceTimeMs),
      ...(analysisVersion===CLIP_ANALYSIS_VERSION?{visualEvidence:{model:CLIP_MODEL_SOURCE,frames:aggregate.observations.map(o=>frameEvidence.get(o.sourceTimeMs)!)}}:{}),
    }, fullRange.assetId);
  });
  const analysis = parseVideoSemanticAnalysis({
    schemaVersion: VIDEO_SEMANTIC_SCHEMA_VERSION,
    assetId: fullRange.assetId,
    assetDurationMs: fullRange.endMs,
    segments,
    analysisMethod: "local-clip",
    createdAt: input.createdAt,
    analysisVersion,
  });
  const stored = input.cache?.set(analysis) ?? analysis;
  return Object.freeze({
    analysis: stored,
    coarse,
    candidates,
    failures: Object.freeze(failures),
    classifiedFrameCount,
    fromCache: false,
  });
}

/** Read real current-session analyses without treating filename fallback as visual evidence. */
export function collectCurrentVideoEvidence(
  cache: VideoSemanticAnalysisCache,
  assets: readonly Readonly<{ id: string; durationMs: number }>[],
): readonly VideoSemanticAnalysis[] {
  return assets.flatMap((asset) => {
    for(const version of (CLIP_TEST_ENABLED ? [CLIP_ANALYSIS_VERSION] : [TWO_STAGE_LOCAL_ANALYSIS_VERSION,LOCAL_CLIP_ANALYSIS_VERSION])) {
      const analysis = cache.get(asset.id, version, asset.durationMs);
      if (analysis?.analysisMethod === "local-clip") return [analysis];
    }
    return [];
  });
}
