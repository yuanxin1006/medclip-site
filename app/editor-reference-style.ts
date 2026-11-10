import { parseAIEditingPlan, type EditorAIPlanAction } from "./editor-ai-requirements.ts";
import type { EditorProject } from "./editor-core.ts";
import type { ConstraintSetV1, TimeRangeV1 } from "./editor-constraints.ts";
import type { VideoSemanticAnalysis } from "./editor-video-semantic.ts";
import {
  HUMAN_REVIEW_SCHEMA_VERSION,
  type HumanReviewState,
} from "./editor-proposal-review.ts";

export const REFERENCE_VIDEO_EVIDENCE_VERSION = 1 as const;
export const REFERENCE_STYLE_PROFILE_VERSION = 1 as const;
export const REFERENCE_STYLE_ANALYSIS_VERSION = "local-reference-cut-analysis-v1";
export const REFERENCE_STYLE_PLANNER_VERSION = "reference-style-planner-v1";
export const MAX_REFERENCE_CUTS = 23;
export const MAX_REFERENCE_STYLE_SLOTS = 24;

export type EvidenceProvenance = "MEASURED" | "DERIVED" | "NOT_EVALUABLE";

export type ReferenceFrameSignature = Readonly<{
  timestampMs: number;
  values: readonly number[];
}>;

export type ReferenceCutEvidence = Readonly<{
  timestampMs: number;
  changeScore: number;
  confidence: "HIGH" | "MEDIUM";
  provenance: "MEASURED";
}>;

export type ReferenceVideoEvidence = Readonly<{
  version: typeof REFERENCE_VIDEO_EVIDENCE_VERSION;
  id: string;
  durationMs: number;
  analysisVersion: typeof REFERENCE_STYLE_ANALYSIS_VERSION;
  analysisOnly: true;
  cutBoundaries: readonly ReferenceCutEvidence[];
  frameSampleCounts: Readonly<{ coarse: number; fine: number }>;
}>;

export type ReferencePacingSection = Readonly<{
  index: number;
  startRatio: number;
  endRatio: number;
  cutCount: number;
  cutDensityPerSecond: number;
  meanShotDurationMs: number;
  pace: "FAST" | "SIMILAR" | "SLOW";
  provenance: "DERIVED";
}>;

export type ReferenceEditStyleProfile = Readonly<{
  version: typeof REFERENCE_STYLE_PROFILE_VERSION;
  referenceId: string;
  referenceDurationMs: number;
  cutCadence: Readonly<{
    cutCount: number;
    shotDurationsMs: readonly number[];
    meanShotDurationMs: number;
    medianShotDurationMs: number;
    shortShotRatio: number;
    mediumShotRatio: number;
    longShotRatio: number;
    provenance: "MEASURED";
  }>;
  pacing: Readonly<{
    overall: "FAST" | "MEDIUM" | "SLOW";
    sections: readonly ReferencePacingSection[];
    provenance: "DERIVED";
  }>;
  rhythm: Readonly<{
    temporalCutDensityPerSecond: number;
    cadenceVariation: number;
    audioRelationship: "NOT_EVALUABLE";
    provenance: "DERIVED";
  }>;
  transitions: Readonly<{
    hardCutCount: number;
    otherTransitionTypes: "NOT_EVALUABLE";
    provenance: "MEASURED";
  }>;
  provenance: "MEASURED_AND_DERIVED";
}>;

export type ReferenceStyleAnalysisResult =
  | Readonly<{
    status: "READY";
    evidence: ReferenceVideoEvidence;
    profile: ReferenceEditStyleProfile;
  }>
  | Readonly<{
    status: "NOT_EVALUABLE";
    reason: "REFERENCE_TOO_SHORT" | "NO_USABLE_FRAMES" | "CUT_EVIDENCE_INSUFFICIENT" | "ANALYSIS_FAILED";
    message: string;
  }>;

export type StyleCandidateScene = Readonly<{
  sceneId: string;
  assetId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  semanticSummary: string;
  semanticScore: number | null;
  semanticProvenance: "VIDEO_SEMANTIC_EVIDENCE" | "USER_ASSET_FALLBACK";
}>;

export type StyleTargetClip = Readonly<{
  clipId: string;
  assetId: string;
  timelineStartMs: number;
  timelineEndMs: number;
}>;

export type StyleProtectedRange = Readonly<{
  id: string;
  startMs: number;
  endMs: number;
  clipId?: string;
  assetId?: string;
}>;

export type StylePlanConflict = Readonly<{
  code: "CUT_MOVED_FOR_PROTECTION" | "PROTECTED_SLOT_PRESERVED" | "NO_ELIGIBLE_USER_SCENE" | "NO_TARGET_CLIP";
  slotId?: string;
  protectedRangeId?: string;
  detail: string;
}>;

export type StylePlanItem = Readonly<{
  slotId: string;
  targetStartMs: number;
  targetEndMs: number;
  desiredDurationMs: number;
  pace: ReferencePacingSection["pace"];
  protected: boolean;
  targetClipId?: string;
  selectedSceneId?: string;
  selectedAssetId?: string;
  semanticScore: number | null;
  reasons: readonly string[];
  canonicalAction?: Readonly<EditorAIPlanAction>;
}>;

export type StyleFitEvidence = Readonly<{
  score: number;
  components: Readonly<{
    shotDurationDistribution: number;
    cutDensity: number;
    pacingSections: number;
  }>;
  formula: "ARITHMETIC_MEAN_OF_THREE_DOCUMENTED_COMPONENTS";
  provenance: "DERIVED";
}>;

export type ReferenceStyleProposal = Readonly<{
  version: typeof REFERENCE_STYLE_PROFILE_VERSION;
  plannerVersion: typeof REFERENCE_STYLE_PLANNER_VERSION;
  proposalId: string;
  status: "PENDING_HUMAN_REVIEW";
  referenceStyleSummary: string;
  targetDurationMs: number;
  desiredSegmentDurationsMs: readonly number[];
  items: readonly StylePlanItem[];
  conflicts: readonly StylePlanConflict[];
  unmatchedSlotIds: readonly string[];
  styleFit: StyleFitEvidence;
  canonicalPlan: ReturnType<typeof parseAIEditingPlan>;
  humanReview: HumanReviewState;
  humanReviewCompatible: true;
  autoExecuted: false;
  referenceMediaExclusion: Readonly<{
    assetUsedInOutput: false;
    audioUsedInOutput: false;
    frameUsedInOutput: false;
  }>;
}>;

export type ReferenceStylePlanningResult =
  | Readonly<{ status: "READY_FOR_REVIEW"; proposal: ReferenceStyleProposal }>
  | Readonly<{
    status: "NOT_EVALUABLE";
    reason: "INVALID_TARGET_DURATION" | "NO_USER_MATERIAL" | "HARD_CONSTRAINTS_PREVENT_STYLE_TRANSFER";
    message: string;
  }>;

export function classifyReferenceVideoInput(file: Readonly<{ name: string; type: string; size: number }>) {
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const supportedExtension = ["mp4", "webm", "mov", "m4v"].includes(extension);
  const supportedMime = !file.type || file.type.startsWith("video/");
  const eligible = file.size > 0 && supportedMime && supportedExtension;
  return Object.freeze({
    eligible,
    role: "REFERENCE_ANALYSIS_ONLY" as const,
    entersEditableAssetPool: false as const,
    reason: eligible ? null : "Reference must be a non-empty local MP4, WebM, MOV, or M4V video.",
  });
}

const round = (value: number, digits = 6) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function validDuration(value: number) {
  return Number.isSafeInteger(value) && value > 0 && value <= 86_400_000;
}

export function createReferenceVideoIdentity(input: {
  name: string;
  size: number;
  lastModified: number;
  durationMs: number;
}) {
  if (!input.name.trim() || !Number.isSafeInteger(input.size) || input.size <= 0 || !validDuration(input.durationMs)) {
    throw new RangeError("Reference identity requires bounded local file metadata and duration.");
  }
  return `reference-v1-${fnv1a(`${input.name.trim()}|${input.size}|${Math.round(input.lastModified)}|${input.durationMs}`)}`;
}

export function frameChangeScore(left: ReferenceFrameSignature, right: ReferenceFrameSignature) {
  if (!left.values.length || left.values.length !== right.values.length) {
    throw new RangeError("Frame signatures must have the same non-empty shape.");
  }
  const total = left.values.reduce((sum, value, index) => {
    const next = right.values[index];
    if (!Number.isFinite(value) || !Number.isFinite(next)) throw new RangeError("Frame signatures must be finite.");
    return sum + Math.abs(value - next);
  }, 0);
  return round(clamp(total / left.values.length, 0, 1));
}

export function detectReferenceCuts(
  frames: readonly ReferenceFrameSignature[],
  options: Readonly<{ threshold?: number; minimumGapMs?: number }> = {},
) {
  const threshold = clamp(options.threshold ?? 0.16, 0.01, 1);
  const minimumGapMs = Math.max(100, Math.round(options.minimumGapMs ?? 250));
  const ordered = [...frames].sort((left, right) => left.timestampMs - right.timestampMs);
  if (ordered.length < 2 || ordered.some((frame) => !Number.isSafeInteger(frame.timestampMs) || frame.timestampMs < 0)) return Object.freeze([]);
  if (new Set(ordered.map((frame) => frame.timestampMs)).size !== ordered.length) {
    throw new RangeError("Reference frame timestamps must be unique.");
  }
  const cuts: ReferenceCutEvidence[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const score = frameChangeScore(ordered[index - 1], ordered[index]);
    if (score < threshold) continue;
    const candidate: ReferenceCutEvidence = Object.freeze({
      timestampMs: ordered[index].timestampMs,
      changeScore: score,
      confidence: score >= Math.max(0.4, threshold * 1.75) ? "HIGH" : "MEDIUM",
      provenance: "MEASURED",
    });
    const previous = cuts.at(-1);
    if (previous && candidate.timestampMs - previous.timestampMs < minimumGapMs) {
      if (candidate.changeScore > previous.changeScore) cuts[cuts.length - 1] = candidate;
      continue;
    }
    cuts.push(candidate);
  }
  return Object.freeze(cuts.slice(0, MAX_REFERENCE_CUTS));
}

function median(values: readonly number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : Math.round((ordered[middle - 1] + ordered[middle]) / 2);
}

function shotDurations(durationMs: number, cuts: readonly ReferenceCutEvidence[]) {
  const boundaries = [0, ...cuts.map((cut) => cut.timestampMs), durationMs];
  return boundaries.slice(1).map((end, index) => end - boundaries[index]);
}

function distribution(durations: readonly number[]) {
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  const short = durations.filter((value) => value < mean * 0.75).length / durations.length;
  const long = durations.filter((value) => value > mean * 1.5).length / durations.length;
  return { short: round(short), medium: round(1 - short - long), long: round(long) };
}

function derivePacingSections(durationMs: number, cuts: readonly ReferenceCutEvidence[]) {
  const allBoundaries = [0, ...cuts.map((cut) => cut.timestampMs), durationMs];
  const globalDensity = cuts.length / (durationMs / 1_000);
  return Object.freeze(Array.from({ length: 4 }, (_, index): ReferencePacingSection => {
    const startMs = Math.round(durationMs * index / 4);
    const endMs = Math.round(durationMs * (index + 1) / 4);
    const sectionCuts = cuts.filter((cut) => cut.timestampMs > startMs && cut.timestampMs <= endMs).length;
    const pieces = allBoundaries
      .slice(0, -1)
      .map((start, boundaryIndex) => Math.max(0, Math.min(endMs, allBoundaries[boundaryIndex + 1]) - Math.max(startMs, start)))
      .filter(Boolean);
    const density = sectionCuts / Math.max(0.001, (endMs - startMs) / 1_000);
    return Object.freeze({
      index,
      startRatio: index / 4,
      endRatio: (index + 1) / 4,
      cutCount: sectionCuts,
      cutDensityPerSecond: round(density),
      meanShotDurationMs: Math.round(pieces.reduce((sum, value) => sum + value, 0) / Math.max(1, pieces.length)),
      pace: density > globalDensity * 1.2 ? "FAST" : density < globalDensity * 0.8 ? "SLOW" : "SIMILAR",
      provenance: "DERIVED",
    });
  }));
}

export function createReferenceEditStyleProfile(evidence: ReferenceVideoEvidence): ReferenceEditStyleProfile {
  if (!validDuration(evidence.durationMs) || evidence.durationMs < 2_000 || evidence.cutBoundaries.length === 0) {
    throw new RangeError("A style profile requires a usable duration and measured cut evidence.");
  }
  const cuts = [...evidence.cutBoundaries].sort((left, right) => left.timestampMs - right.timestampMs);
  if (cuts.some((cut, index) => cut.timestampMs <= 0 || cut.timestampMs >= evidence.durationMs || (index > 0 && cut.timestampMs <= cuts[index - 1].timestampMs))) {
    throw new RangeError("Reference cuts must be ordered inside the reference duration.");
  }
  const durations = shotDurations(evidence.durationMs, cuts);
  const mean = Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
  const ratios = distribution(durations);
  const variation = Math.sqrt(durations.reduce((sum, value) => sum + (value - mean) ** 2, 0) / durations.length) / mean;
  return Object.freeze({
    version: REFERENCE_STYLE_PROFILE_VERSION,
    referenceId: evidence.id,
    referenceDurationMs: evidence.durationMs,
    cutCadence: Object.freeze({
      cutCount: cuts.length,
      shotDurationsMs: Object.freeze(durations),
      meanShotDurationMs: mean,
      medianShotDurationMs: median(durations),
      shortShotRatio: ratios.short,
      mediumShotRatio: ratios.medium,
      longShotRatio: ratios.long,
      provenance: "MEASURED",
    }),
    pacing: Object.freeze({
      overall: mean <= 1_500 ? "FAST" : mean <= 4_000 ? "MEDIUM" : "SLOW",
      sections: derivePacingSections(evidence.durationMs, cuts),
      provenance: "DERIVED",
    }),
    rhythm: Object.freeze({
      temporalCutDensityPerSecond: round(cuts.length / (evidence.durationMs / 1_000)),
      cadenceVariation: round(variation),
      audioRelationship: "NOT_EVALUABLE",
      provenance: "DERIVED",
    }),
    transitions: Object.freeze({
      hardCutCount: cuts.length,
      otherTransitionTypes: "NOT_EVALUABLE",
      provenance: "MEASURED",
    }),
    provenance: "MEASURED_AND_DERIVED",
  });
}

export function normalizeStyleDurations(profile: ReferenceEditStyleProfile, targetDurationMs: number) {
  if (!validDuration(targetDurationMs) || targetDurationMs < 500) throw new RangeError("Target duration must be at least 500 ms.");
  const source = profile.cutCadence.shotDurationsMs;
  const maxByMinimum = Math.max(1, Math.floor(targetDurationMs / 100));
  const count = clamp(
    Math.round(targetDurationMs / profile.cutCadence.meanShotDurationMs),
    1,
    Math.min(MAX_REFERENCE_STYLE_SLOTS, maxByMinimum),
  );
  const sampled = Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.min(source.length - 1, Math.floor(((index + 0.5) / count) * source.length));
    return source[sourceIndex];
  });
  const total = sampled.reduce((sum, value) => sum + value, 0);
  const boundaries = [0];
  let cumulative = 0;
  sampled.forEach((value, index) => {
    cumulative += value;
    const ideal = index === sampled.length - 1 ? targetDurationMs : Math.round(cumulative / total * targetDurationMs);
    const minimum = boundaries.at(-1)! + 100;
    const maximum = targetDurationMs - (sampled.length - index - 1) * 100;
    boundaries.push(clamp(ideal, minimum, maximum));
  });
  return Object.freeze(boundaries.slice(1).map((end, index) => end - boundaries[index]));
}

function rangesOverlap(startMs: number, endMs: number, range: StyleProtectedRange) {
  return endMs > range.startMs && startMs < range.endMs;
}

function paceAt(profile: ReferenceEditStyleProfile, ratio: number) {
  return profile.pacing.sections.find((section) => ratio >= section.startRatio && ratio < section.endRatio)?.pace
    ?? profile.pacing.sections.at(-1)?.pace
    ?? "SIMILAR";
}

function adjustBoundariesForProtection(
  durations: readonly number[],
  targetDurationMs: number,
  protectedRanges: readonly StyleProtectedRange[],
) {
  const boundaries = [0];
  let cursor = 0;
  const conflicts: StylePlanConflict[] = [];
  durations.slice(0, -1).forEach((duration) => {
    cursor += duration;
    const blocking = protectedRanges.find((range) => cursor > range.startMs && cursor < range.endMs);
    const adjusted = blocking ? Math.min(targetDurationMs, blocking.endMs) : cursor;
    if (blocking) conflicts.push(Object.freeze({
      code: "CUT_MOVED_FOR_PROTECTION",
      protectedRangeId: blocking.id,
      detail: `Style cut ${cursor} ms moved to ${adjusted} ms because protected content has priority.`,
    }));
    if (adjusted - boundaries.at(-1)! >= 100 && targetDurationMs - adjusted >= 100) boundaries.push(adjusted);
  });
  boundaries.push(targetDurationMs);
  return {
    durations: Object.freeze(boundaries.slice(1).map((end, index) => end - boundaries[index])),
    conflicts,
  };
}

function distributionSimilarity(reference: ReferenceEditStyleProfile, durations: readonly number[]) {
  const target = distribution(durations);
  const difference = Math.abs(reference.cutCadence.shortShotRatio - target.short)
    + Math.abs(reference.cutCadence.mediumShotRatio - target.medium)
    + Math.abs(reference.cutCadence.longShotRatio - target.long);
  return round(clamp(1 - difference / 2, 0, 1));
}

function pacingSimilarity(reference: ReferenceEditStyleProfile, durations: readonly number[], targetDurationMs: number) {
  const cuts: ReferenceCutEvidence[] = [];
  let cursor = 0;
  durations.slice(0, -1).forEach((duration) => {
    cursor += duration;
    cuts.push({ timestampMs: cursor, changeScore: 1, confidence: "HIGH", provenance: "MEASURED" });
  });
  const targetSections = derivePacingSections(targetDurationMs, cuts);
  const rank = { FAST: 2, SIMILAR: 1, SLOW: 0 } as const;
  const meanDifference = reference.pacing.sections.reduce((sum, section, index) => (
    sum + Math.abs(rank[section.pace] - rank[targetSections[index].pace]) / 2
  ), 0) / reference.pacing.sections.length;
  return round(1 - meanDifference);
}

export function evaluateReferenceStyleFit(
  profile: ReferenceEditStyleProfile,
  plannedDurationsMs: readonly number[],
  targetDurationMs: number,
): StyleFitEvidence {
  if (!plannedDurationsMs.length || plannedDurationsMs.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError("Style fit requires positive planned shot durations.");
  }
  const distributionScore = distributionSimilarity(profile, plannedDurationsMs);
  const referenceDensity = profile.rhythm.temporalCutDensityPerSecond;
  const targetDensity = Math.max(0, plannedDurationsMs.length - 1) / (targetDurationMs / 1_000);
  const densityScore = round(referenceDensity === 0 ? (targetDensity === 0 ? 1 : 0) : clamp(1 - Math.abs(referenceDensity - targetDensity) / Math.max(referenceDensity, targetDensity), 0, 1));
  const pacingScore = pacingSimilarity(profile, plannedDurationsMs, targetDurationMs);
  return Object.freeze({
    score: round((distributionScore + densityScore + pacingScore) / 3),
    components: Object.freeze({
      shotDurationDistribution: distributionScore,
      cutDensity: densityScore,
      pacingSections: pacingScore,
    }),
    formula: "ARITHMETIC_MEAN_OF_THREE_DOCUMENTED_COMPONENTS",
    provenance: "DERIVED",
  });
}

export function buildReferenceStylePlanningInputs(
  project: EditorProject,
  analyses: readonly VideoSemanticAnalysis[],
  constraintSet?: ConstraintSetV1,
) {
  const ownedAssets = new Set(project.assets.map((asset) => asset.id));
  const targetClips: StyleTargetClip[] = project.tracks
    .flatMap((track) => track.clips)
    .filter((clip) => ownedAssets.has(clip.assetId))
    .sort((left, right) => left.timelineStartMs - right.timelineStartMs || left.id.localeCompare(right.id))
    .map((clip) => Object.freeze({
      clipId: clip.id,
      assetId: clip.assetId,
      timelineStartMs: clip.timelineStartMs,
      timelineEndMs: clip.timelineEndMs,
    }));
  const semanticScenes: StyleCandidateScene[] = analyses
    .filter((analysis) => ownedAssets.has(analysis.assetId))
    .flatMap((analysis) => analysis.segments.map((segment) => Object.freeze({
      sceneId: segment.id,
      assetId: segment.assetId,
      sourceStartMs: segment.startMs,
      sourceEndMs: segment.endMs,
      semanticSummary: segment.summary,
      semanticScore: round(segment.confidence * segment.usability),
      semanticProvenance: "VIDEO_SEMANTIC_EVIDENCE" as const,
    })));
  const semanticAssets = new Set(semanticScenes.map((scene) => scene.assetId));
  const fallbackScenes: StyleCandidateScene[] = project.assets
    .filter((asset) => !semanticAssets.has(asset.id))
    .map((asset) => Object.freeze({
      sceneId: `user-asset-${asset.id}`,
      assetId: asset.id,
      sourceStartMs: 0,
      sourceEndMs: asset.kind === "图片" ? project.durationMs : asset.durationMs,
      semanticSummary: "User-owned material; semantic evidence is not available.",
      semanticScore: null,
      semanticProvenance: "USER_ASSET_FALLBACK" as const,
    }));
  const lockedTrackRanges: StyleProtectedRange[] = project.tracks
    .filter((track) => track.locked)
    .flatMap((track) => track.clips.map((clip) => Object.freeze({
      id: `locked-track-${track.id}-${clip.id}`,
      startMs: clip.timelineStartMs,
      endMs: clip.timelineEndMs,
      clipId: clip.id,
      assetId: clip.assetId,
    })));
  const constraintRanges = collectReferenceStyleProtectedRanges(project, constraintSet);
  return Object.freeze({
    targetClips: Object.freeze(targetClips),
    candidateScenes: Object.freeze([...semanticScenes, ...fallbackScenes]),
    protectedRanges: Object.freeze([...lockedTrackRanges, ...constraintRanges]),
  });
}

function rangeForBinding(range: TimeRangeV1, project: EditorProject): readonly StyleProtectedRange[] {
  if (range.coordinateSpace === "TIMELINE") {
    return [{ id: `protected-timeline-${range.startMs}-${range.endMs}`, startMs: range.startMs, endMs: range.endMs }];
  }
  return project.tracks.flatMap((track) => track.clips)
    .filter((clip) => clip.assetId === range.assetId && clip.sourceOutMs > range.startMs && clip.sourceInMs < range.endMs)
    .map((clip) => ({ id: `protected-source-${clip.id}`, startMs: clip.timelineStartMs, endMs: clip.timelineEndMs, clipId: clip.id, assetId: clip.assetId }));
}

export function collectReferenceStyleProtectedRanges(project: EditorProject, constraintSet?: ConstraintSetV1) {
  if (!constraintSet) return Object.freeze([]);
  const activeBindingIds = new Set(constraintSet.activeConstraints.map((constraint) => constraint.bindingId));
  const ranges = constraintSet.confirmedBindings.flatMap((binding): readonly StyleProtectedRange[] => {
    if (!activeBindingIds.has(binding.bindingId)) return [];
    if (binding.bindingType === "CLIP") {
      const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === binding.clipId);
      return clip ? [{ id: binding.bindingId, startMs: clip.timelineStartMs, endMs: clip.timelineEndMs, clipId: clip.id, assetId: clip.assetId }] : [];
    }
    if (binding.bindingType === "TIME_RANGE") return rangeForBinding(binding.range, project);
    if (binding.bindingType === "VIDEO_SEMANTIC_SOURCE_RANGE") {
      return rangeForBinding({ schemaVersion: 1, coordinateSpace: "SOURCE_ASSET", assetId: binding.assetId, startMs: binding.startMs, endMs: binding.endMs }, project);
    }
    return [];
  });
  const unique = new Map(ranges.map((range) => [`${range.startMs}:${range.endMs}:${range.clipId ?? ""}`, Object.freeze(range)]));
  return Object.freeze([...unique.values()].sort((left, right) => left.startMs - right.startMs));
}

export function planReferenceStyleTransfer(input: Readonly<{
  profile: ReferenceEditStyleProfile;
  targetDurationMs: number;
  targetClips: readonly StyleTargetClip[];
  candidateScenes: readonly StyleCandidateScene[];
  protectedRanges?: readonly StyleProtectedRange[];
  referenceId: string;
}>): ReferenceStylePlanningResult {
  if (!validDuration(input.targetDurationMs) || input.targetDurationMs < 500) {
    return Object.freeze({ status: "NOT_EVALUABLE", reason: "INVALID_TARGET_DURATION", message: "Target duration is not usable." });
  }
  const candidates = input.candidateScenes.filter((scene) => scene.assetId !== input.referenceId && !scene.assetId.startsWith("reference-v1-") && scene.sourceEndMs > scene.sourceStartMs);
  if (!candidates.length) {
    return Object.freeze({ status: "NOT_EVALUABLE", reason: "NO_USER_MATERIAL", message: "No eligible user-owned scenes are available." });
  }
  const protectedRanges = input.protectedRanges ?? [];
  const normalized = normalizeStyleDurations(input.profile, input.targetDurationMs);
  const adjusted = adjustBoundariesForProtection(normalized, input.targetDurationMs, protectedRanges);
  const targetClips = [...input.targetClips].sort((left, right) => left.timelineStartMs - right.timelineStartMs || left.clipId.localeCompare(right.clipId));
  const usedScenes = new Set<string>();
  const conflicts = [...adjusted.conflicts];
  const actions: EditorAIPlanAction[] = [];
  const items: StylePlanItem[] = [];
  let cursor = 0;
  adjusted.durations.forEach((duration, index) => {
    const slotId = `style-slot-${index + 1}`;
    const startMs = cursor;
    const endMs = cursor + duration;
    cursor = endMs;
    const targetClip = targetClips[index];
    const blocking = protectedRanges.find((range) => (
      (targetClip?.clipId && range.clipId === targetClip.clipId)
      || rangesOverlap(startMs, endMs, range)
      || (targetClip && rangesOverlap(targetClip.timelineStartMs, targetClip.timelineEndMs, range))
    ));
    let selected: StyleCandidateScene | undefined;
    if (blocking && targetClip) {
      selected = candidates.find((scene) => scene.assetId === targetClip.assetId);
      conflicts.push(Object.freeze({
        code: "PROTECTED_SLOT_PRESERVED",
        slotId,
        protectedRangeId: blocking.id,
        detail: "Protected content remains authoritative; no style action is generated for this slot.",
      }));
    } else {
      selected = candidates
        .filter((scene) => !usedScenes.has(scene.sceneId))
        .sort((left, right) => (
          (right.semanticScore ?? -1) - (left.semanticScore ?? -1)
          || Math.abs((left.sourceEndMs - left.sourceStartMs) - duration) - Math.abs((right.sourceEndMs - right.sourceStartMs) - duration)
          || left.sceneId.localeCompare(right.sceneId)
        ))[0];
    }
    if (!selected) {
      conflicts.push(Object.freeze({ code: "NO_ELIGIBLE_USER_SCENE", slotId, detail: "No unused user-owned scene can fill this style slot." }));
    } else if (!blocking) {
      usedScenes.add(selected.sceneId);
    }
    let canonicalAction: EditorAIPlanAction | undefined;
    if (!blocking && selected && targetClip && selected.assetId !== targetClip.assetId) {
      canonicalAction = {
        type: "MATCH_ASSET_TO_SEGMENT",
        targetId: targetClip.clipId,
        assetId: selected.assetId,
        startSeconds: targetClip.timelineStartMs / 1_000,
        endSeconds: targetClip.timelineEndMs / 1_000,
        reason: `Reference cadence suggests a ${duration} ms slot; existing semantic evidence selected user scene ${selected.sceneId}.`,
      };
      actions.push(canonicalAction);
    }
    if (!targetClip) conflicts.push(Object.freeze({ code: "NO_TARGET_CLIP", slotId, detail: "The style structure needs an additional review-time split or slot." }));
    items.push(Object.freeze({
      slotId,
      targetStartMs: startMs,
      targetEndMs: endMs,
      desiredDurationMs: duration,
      pace: paceAt(input.profile, (startMs + duration / 2) / input.targetDurationMs),
      protected: Boolean(blocking),
      ...(targetClip ? { targetClipId: targetClip.clipId } : {}),
      ...(selected ? { selectedSceneId: selected.sceneId, selectedAssetId: selected.assetId } : {}),
      semanticScore: selected?.semanticScore ?? null,
      reasons: Object.freeze([
        `Reference pacing at this normalized position is ${paceAt(input.profile, (startMs + duration / 2) / input.targetDurationMs)}.`,
        blocking ? "Hard protection overrides reference style." : selected?.semanticScore === null ? "User material is eligible, but semantic evidence is not evaluable." : "Existing user-material semantic evidence has priority over duration fit.",
      ]),
      ...(canonicalAction ? { canonicalAction: Object.freeze(canonicalAction) } : {}),
    }));
  });
  const unprotectedItems = items.filter((item) => !item.protected);
  if (!unprotectedItems.length) {
    return Object.freeze({ status: "NOT_EVALUABLE", reason: "HARD_CONSTRAINTS_PREVENT_STYLE_TRANSFER", message: "All target slots are protected." });
  }
  const canonicalPlan = parseAIEditingPlan({
    summary: "Reference-conditioned style proposal using only user-owned material.",
    actions,
    unsupported: [],
    warnings: conflicts.map((conflict) => conflict.detail).slice(0, 24),
  });
  const proposalId = `reference-style-proposal-v1-${fnv1a(`${input.profile.referenceId}|${input.targetDurationMs}|${items.map((item) => `${item.selectedSceneId ?? "none"}:${item.desiredDurationMs}`).join("|")}`)}`;
  const humanReviewEntries = Object.freeze(items.map((item) => Object.freeze({
    proposalEntryId: `reference-style-review-${item.slotId}`,
    intervalId: item.slotId,
    status: "PENDING" as const,
  })));
  const humanReview: HumanReviewState = Object.freeze({
    schemaVersion: HUMAN_REVIEW_SCHEMA_VERSION,
    proposalId,
    lifecycle: "PENDING_REVIEW",
    entries: humanReviewEntries,
  });
  const proposal: ReferenceStyleProposal = Object.freeze({
    version: REFERENCE_STYLE_PROFILE_VERSION,
    plannerVersion: REFERENCE_STYLE_PLANNER_VERSION,
    proposalId,
    status: "PENDING_HUMAN_REVIEW",
    referenceStyleSummary: `${input.profile.cutCadence.cutCount} measured cuts; mean shot ${input.profile.cutCadence.meanShotDurationMs} ms; ${input.profile.pacing.overall} operational cadence.`,
    targetDurationMs: input.targetDurationMs,
    desiredSegmentDurationsMs: Object.freeze(items.map((item) => item.desiredDurationMs)),
    items: Object.freeze(items),
    conflicts: Object.freeze(conflicts),
    unmatchedSlotIds: Object.freeze(items.filter((item) => !item.selectedSceneId || !item.targetClipId).map((item) => item.slotId)),
    styleFit: evaluateReferenceStyleFit(input.profile, items.map((item) => item.desiredDurationMs), input.targetDurationMs),
    canonicalPlan,
    humanReview,
    humanReviewCompatible: true,
    autoExecuted: false,
    referenceMediaExclusion: Object.freeze({ assetUsedInOutput: false, audioUsedInOutput: false, frameUsedInOutput: false }),
  });
  return Object.freeze({ status: "READY_FOR_REVIEW", proposal });
}

function waitForMetadata(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Reference metadata timed out.")), 12_000);
    video.onloadedmetadata = () => { window.clearTimeout(timer); resolve(); };
    video.onerror = () => { window.clearTimeout(timer); reject(new Error("Reference video could not be decoded.")); };
    video.load();
  });
}

function seek(video: HTMLVideoElement, timeMs: number) {
  if (video.readyState >= 2 && Math.abs(video.currentTime * 1_000 - timeMs) < 15) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Reference frame seek timed out.")), 8_000);
    video.onseeked = () => { window.clearTimeout(timer); resolve(); };
    video.onerror = () => { window.clearTimeout(timer); reject(new Error("Reference frame could not be decoded.")); };
    video.currentTime = timeMs / 1_000;
  });
}

async function captureSignatures(video: HTMLVideoElement, times: readonly number[]) {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 18;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Reference frame canvas is unavailable.");
  const signatures: ReferenceFrameSignature[] = [];
  for (const timestampMs of times) {
    await seek(video, timestampMs);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const values: number[] = [];
    for (let index = 0; index < pixels.length; index += 4) {
      values.push(round((pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114) / 255, 4));
    }
    signatures.push(Object.freeze({ timestampMs, values: Object.freeze(values) }));
  }
  return Object.freeze(signatures);
}

export async function analyzeReferenceVideoFile(input: Readonly<{
  file: File;
  sourceUrl: string;
}>): Promise<ReferenceStyleAnalysisResult> {
  if (!classifyReferenceVideoInput(input.file).eligible || !input.sourceUrl) {
    return Object.freeze({ status: "NOT_EVALUABLE", reason: "ANALYSIS_FAILED", message: "A non-empty local video file is required." });
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = input.sourceUrl;
  try {
    await waitForMetadata(video);
    const durationMs = Math.round(video.duration * 1_000);
    if (!validDuration(durationMs) || durationMs < 2_000) {
      return Object.freeze({ status: "NOT_EVALUABLE", reason: "REFERENCE_TOO_SHORT", message: "Reference video must be at least two seconds." });
    }
    const coarseStep = clamp(Math.round(durationMs / 24), 250, 1_000);
    const coarseTimes = Array.from({ length: Math.ceil(durationMs / coarseStep) }, (_, index) => Math.min(durationMs - 40, index * coarseStep));
    if (coarseTimes.at(-1)! < durationMs - 80) coarseTimes.push(durationMs - 40);
    const coarse = await captureSignatures(video, [...new Set(coarseTimes)]);
    const coarseCuts = detectReferenceCuts(coarse, { threshold: 0.12, minimumGapMs: 250 });
    if (!coarseCuts.length) {
      return Object.freeze({ status: "NOT_EVALUABLE", reason: "CUT_EVIDENCE_INSUFFICIENT", message: "No reliable hard-cut evidence was measured." });
    }
    const fineStep = Math.max(60, Math.round(coarseStep / 5));
    const fineMinimumGapMs = Math.max(180, Math.round(coarseStep / 2));
    const verifiedCandidates: ReferenceCutEvidence[] = [];
    let fineFrameCount = 0;
    for (const coarseCut of coarseCuts.slice(0, MAX_REFERENCE_CUTS)) {
      const fineTimes = [...new Set(Array.from(
        { length: 7 },
        (_, index) => clamp(coarseCut.timestampMs + (index - 3) * fineStep, 0, durationMs - 40),
      ))].sort((left, right) => left - right);
      const fineWindow = await captureSignatures(video, fineTimes);
      fineFrameCount += fineWindow.length;
      const bestLocalCut = [...detectReferenceCuts(fineWindow, { threshold: 0.1, minimumGapMs: 120 })]
        .sort((left, right) => right.changeScore - left.changeScore || Math.abs(left.timestampMs - coarseCut.timestampMs) - Math.abs(right.timestampMs - coarseCut.timestampMs))[0];
      if (bestLocalCut) verifiedCandidates.push(bestLocalCut);
    }
    const verified = verifiedCandidates
      .sort((left, right) => left.timestampMs - right.timestampMs)
      .reduce<ReferenceCutEvidence[]>((merged, candidate) => {
        const previous = merged.at(-1);
        if (!previous || candidate.timestampMs - previous.timestampMs >= fineMinimumGapMs) {
          merged.push(candidate);
        } else if (candidate.changeScore > previous.changeScore) {
          merged[merged.length - 1] = candidate;
        }
        return merged;
      }, []);
    const cuts = verified.length ? verified : coarseCuts;
    const id = createReferenceVideoIdentity({ name: input.file.name, size: input.file.size, lastModified: input.file.lastModified, durationMs });
    const evidence: ReferenceVideoEvidence = Object.freeze({
      version: REFERENCE_VIDEO_EVIDENCE_VERSION,
      id,
      durationMs,
      analysisVersion: REFERENCE_STYLE_ANALYSIS_VERSION,
      analysisOnly: true,
      cutBoundaries: cuts,
      frameSampleCounts: Object.freeze({ coarse: coarse.length, fine: fineFrameCount }),
    });
    return Object.freeze({ status: "READY", evidence, profile: createReferenceEditStyleProfile(evidence) });
  } catch (error) {
    return Object.freeze({ status: "NOT_EVALUABLE", reason: "ANALYSIS_FAILED", message: error instanceof Error ? error.message : "Reference analysis failed." });
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

export class ReferenceObjectUrlOwner {
  #url = "";
  readonly #revoke: (url: string) => void;

  constructor(revoke: (url: string) => void) {
    this.#revoke = revoke;
  }

  replace(url: string) {
    if (!url.startsWith("blob:")) throw new Error("Only subsystem-owned blob URLs may be tracked.");
    if (this.#url && this.#url !== url) this.#revoke(this.#url);
    this.#url = url;
  }

  clear() {
    if (this.#url) this.#revoke(this.#url);
    this.#url = "";
  }

  dispose() { this.clear(); }
  get current() { return this.#url; }
}
