import { cloneProject, type EditorProject, type TimelineClip } from "./editor-core.ts";
import {
  candidateClearsMatchingThresholds,
  SOURCE_START_PLACEMENT_TOLERANCE_MS,
  type CandidateMatchScore,
  type MatchingInterval,
  type RankedCandidateSet,
} from "./editor-multimodal-matching.ts";
import { planNarrativeSequence } from "./editor-narrative-planner.ts";
import { compileNarrativeActionPlan, type SeedTimelineSlot } from "./editor-narrative-action-compiler.ts";
import { createEditorProjectFingerprint, createPlanEvidence } from "./editor-plan-evidence.ts";
import {
  EDITOR_PROPOSAL_SCHEMA_VERSION,
  type EditorProposalBundle,
  type EditorProposalEntryReference,
} from "./editor-proposal-orchestrator.ts";
import type { VideoSemanticSegment } from "./editor-video-semantic.ts";
import { enforceEditorActionConstraintsV1 } from "./editor-constraint-enforcement.ts";
import type { ProposalConstraintContextV1, SessionDecisionLedgerV1 } from "./editor-constraint-negotiation.ts";
import type { ConstraintSetV1 } from "./editor-constraints.ts";
import {
  MUSIC_VIDEO_LINKAGE_SCHEMA_VERSION,
  type MusicSegmentV1,
  type VideoSceneV1,
} from "./editor-music-video-evidence.ts";
import {
  scoreMusicVideoCandidates,
  type MusicVideoCandidateEvidenceV1,
  type MusicVideoNotEvaluableReasonV1,
} from "./editor-music-video-matching.ts";

export {
  MUSIC_VIDEO_LINKAGE_SCHEMA_VERSION,
  MusicVideoLinkageValidationError,
  normalizeVideoSceneIndex,
  segmentMusicForVideoLinkage,
  type MusicEvidenceSourceV1,
  type MusicLyricEvidenceV1,
  type MusicSectionEvidenceV1,
  type MusicSectionKindV1,
  type MusicSegmentV1,
  type VideoSceneV1,
} from "./editor-music-video-evidence.ts";
export {
  MUSIC_VIDEO_LINKAGE_SCORE_WEIGHTS,
  scoreMusicVideoCandidates,
  type MusicVideoCandidateEvidenceV1,
  type MusicVideoNotEvaluableReasonV1,
} from "./editor-music-video-matching.ts";

/**
 * V2.5A planning boundary: structured music and video evidence enter here;
 * the output is the unchanged V2.4 Human Review proposal contract. This
 * module never executes a plan or calls an AI/network provider.
 */

export type MusicVideoProtectedConflictV1 = Readonly<{
  musicSegmentId: string;
  sceneId: string;
  targetClipId: string;
  code: "HARD_CONSTRAINT_BLOCKED" | "STALE_CONSTRAINT_CONTEXT";
}>;

export type MusicVideoLinkageEvidenceV1 = Readonly<{
  schemaVersion: typeof MUSIC_VIDEO_LINKAGE_SCHEMA_VERSION;
  musicSegmentCount: number;
  videoSceneCount: number;
  candidateMatchCount: number;
  selectedMatchCount: number;
  unmatchedMusicSegmentIds: readonly string[];
  rejectedMatches: readonly MusicVideoCandidateEvidenceV1[];
  protectedConflicts: readonly MusicVideoProtectedConflictV1[];
  selectedMatches: readonly MusicVideoCandidateEvidenceV1[];
  providerCalls: 0;
  networkCalls: 0;
}>;

export type MusicVideoLinkageResultV1 =
  | Readonly<{
    status: "READY_FOR_REVIEW";
    musicSegments: readonly MusicSegmentV1[];
    videoScenes: readonly VideoSceneV1[];
    candidateMatches: readonly MusicVideoCandidateEvidenceV1[];
    evidence: MusicVideoLinkageEvidenceV1;
    proposal: EditorProposalBundle;
  }>
  | Readonly<{
    status: "NOT_EVALUABLE";
    reasons: readonly MusicVideoNotEvaluableReasonV1[];
    musicSegments: readonly MusicSegmentV1[];
    videoScenes: readonly VideoSceneV1[];
    candidateMatches: readonly MusicVideoCandidateEvidenceV1[];
    evidence: MusicVideoLinkageEvidenceV1;
  }>;

function overlapMs(segment: MusicSegmentV1, clip: TimelineClip): number {
  return Math.max(0, Math.min(segment.endMs, clip.timelineEndMs) - Math.max(segment.startMs, clip.timelineStartMs));
}

function seedSlots(project: EditorProject, segments: readonly MusicSegmentV1[]): readonly SeedTimelineSlot[] {
  const clips = project.tracks.filter((track) => track.type === "video" || track.type === "broll").flatMap((track) => track.clips);
  const claimed = new Set<string>();
  const slots: SeedTimelineSlot[] = [];
  for (const [order, segment] of segments.entries()) {
    const candidates = clips.filter((clip) => !claimed.has(clip.id) && overlapMs(segment, clip) > 0)
      .sort((left, right) => overlapMs(segment, right) - overlapMs(segment, left)
        || left.timelineStartMs - right.timelineStartMs || left.id.localeCompare(right.id));
    if (!candidates.length) continue;
    const clip = candidates[0];
    claimed.add(clip.id);
    slots.push(Object.freeze({
      order,
      intervalId: segment.id,
      clipId: clip.id,
      timelineStartMs: clip.timelineStartMs,
      timelineEndMs: clip.timelineEndMs,
      currentAssetId: clip.assetId,
    }));
  }
  return Object.freeze(slots);
}

function candidateMatchScore(
  candidate: MusicVideoCandidateEvidenceV1,
  scene: VideoSceneV1,
  segment: MusicSegmentV1,
): CandidateMatchScore {
  return Object.freeze({
    assetId: candidate.assetId,
    semanticScore: candidate.semanticScore,
    usabilityScore: candidate.usabilityScore,
    timingScore: candidate.durationScore,
    repetitionPenalty: candidate.reusePenalty,
    totalScore: candidate.totalScore,
    matchedConcepts: candidate.matchedTags,
    supportingSegmentIds: Object.freeze([scene.sceneId]),
    supportingSourceRanges: Object.freeze([Object.freeze({
      segmentId: scene.sceneId,
      sourceStartMs: scene.startMs,
      sourceEndMs: scene.endMs,
      confidence: scene.confidence,
      usability: scene.usability,
      matchedConcepts: candidate.matchedTags,
    })]),
    evidenceFrameMs: scene.evidenceFrameMs,
    sourceRangePlacementLimitation: scene.startMs > SOURCE_START_PLACEMENT_TOLERANCE_MS,
    semanticEvidence: Object.freeze({
      intervalConcepts: segment.semanticTags,
      conceptSupport: Object.freeze(candidate.matchedTags.map((concept) => Object.freeze({ concept, confidence: scene.confidence }))),
      aggregateConceptSupport: candidate.semanticScore,
      strongestSegmentSupport: candidate.semanticScore,
    }),
    timingEvidence: Object.freeze({
      intervalDurationMs: segment.endMs - segment.startMs,
      sourceDurationMs: scene.assetDurationMs,
    }),
    repetitionEvidence: Object.freeze({
      usageCount: candidate.usageCount,
      immediateRepeat: candidate.immediateRepeat,
      ...(candidate.immediateRepeat ? { previousAssetId: candidate.assetId } : {}),
    }),
  });
}

function emptyEvidence(
  segments: readonly MusicSegmentV1[],
  scenes: readonly VideoSceneV1[],
  candidates: readonly MusicVideoCandidateEvidenceV1[],
  unmatched: readonly string[],
  protectedConflicts: readonly MusicVideoProtectedConflictV1[],
): MusicVideoLinkageEvidenceV1 {
  return Object.freeze({
    schemaVersion: MUSIC_VIDEO_LINKAGE_SCHEMA_VERSION,
    musicSegmentCount: segments.length,
    videoSceneCount: scenes.length,
    candidateMatchCount: candidates.length,
    selectedMatchCount: 0,
    unmatchedMusicSegmentIds: Object.freeze([...unmatched]),
    rejectedMatches: Object.freeze(candidates.filter((candidate) => !candidate.eligible)),
    protectedConflicts: Object.freeze([...protectedConflicts]),
    selectedMatches: Object.freeze([]),
    providerCalls: 0,
    networkCalls: 0,
  });
}

function notEvaluable(
  reasons: readonly MusicVideoNotEvaluableReasonV1[],
  segments: readonly MusicSegmentV1[],
  scenes: readonly VideoSceneV1[],
  candidates: readonly MusicVideoCandidateEvidenceV1[],
  unmatched: readonly string[] = segments.map((segment) => segment.id),
  protectedConflicts: readonly MusicVideoProtectedConflictV1[] = [],
): MusicVideoLinkageResultV1 {
  return Object.freeze({
    status: "NOT_EVALUABLE",
    reasons: Object.freeze([...new Set(reasons)]),
    musicSegments: segments,
    videoScenes: scenes,
    candidateMatches: candidates,
    evidence: emptyEvidence(segments, scenes, candidates, unmatched, protectedConflicts),
  });
}

function buildRankedCandidates(input: Readonly<{
  project: EditorProject;
  segments: readonly MusicSegmentV1[];
  scenes: readonly VideoSceneV1[];
  candidates: readonly MusicVideoCandidateEvidenceV1[];
  slots: readonly SeedTimelineSlot[];
  constraintSet?: ConstraintSetV1;
  constraintContext?: ProposalConstraintContextV1;
}>): Readonly<{
  rankedCandidateSets: readonly RankedCandidateSet[];
  protectedConflicts: readonly MusicVideoProtectedConflictV1[];
  rejected: readonly MusicVideoCandidateEvidenceV1[];
  unmatched: readonly string[];
}> {
  const scenesById = new Map(input.scenes.map((scene) => [scene.sceneId, scene]));
  const slotByInterval = new Map(input.slots.map((slot) => [slot.intervalId, slot]));
  const clips = new Map(input.project.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]));
  const protectedConflicts: MusicVideoProtectedConflictV1[] = [];
  const rankedCandidateSets: RankedCandidateSet[] = [];
  const unmatched: string[] = [];
  const rejected: MusicVideoCandidateEvidenceV1[] = [];

  for (const segment of input.segments) {
    const slot = slotByInterval.get(segment.id);
    const clip = slot ? clips.get(slot.clipId) : undefined;
    if (!slot || !clip) {
      unmatched.push(segment.id);
      continue;
    }
    const bestByAsset = new Map<string, MusicVideoCandidateEvidenceV1>();
    input.candidates.filter((candidate) => candidate.musicSegmentId === segment.id).forEach((candidate) => {
      if (!candidate.eligible) {
        rejected.push(candidate);
        return;
      }
      const current = bestByAsset.get(candidate.assetId);
      if (!current || candidate.totalScore > current.totalScore
        || candidate.totalScore === current.totalScore && candidate.sceneId.localeCompare(current.sceneId) < 0) {
        bestByAsset.set(candidate.assetId, candidate);
      }
    });
    const allowed = [...bestByAsset.values()].filter((candidate) => {
      if (!input.constraintSet || !input.constraintContext
        || (candidate.assetId === slot.currentAssetId && clip.sourceInMs === 0)) return true;
      const enforcement = enforceEditorActionConstraintsV1({
        project: input.project,
        constraintSet: input.constraintSet,
        expectedContext: {
          intentVersionId: input.constraintContext.sourceIntentVersionId,
          constraintSetId: input.constraintContext.sourceConstraintSetId,
          constraintFingerprint: input.constraintContext.sourceConstraintFingerprint,
        },
        action: {
          type: "MATCH_ASSET_TO_SEGMENT",
          targetId: slot.clipId,
          assetId: candidate.assetId,
          startSeconds: slot.timelineStartMs / 1_000,
          endSeconds: slot.timelineEndMs / 1_000,
        },
      });
      if (enforcement.status === "ALLOWED" && !enforcement.violations.length) return true;
      protectedConflicts.push(Object.freeze({
        musicSegmentId: segment.id,
        sceneId: candidate.sceneId,
        targetClipId: slot.clipId,
        code: enforcement.status === "STALE_CONSTRAINT_CONTEXT" ? "STALE_CONSTRAINT_CONTEXT" : "HARD_CONSTRAINT_BLOCKED",
      }));
      return false;
    }).sort((left, right) => right.totalScore - left.totalScore || right.semanticScore - left.semanticScore
      || left.assetId.localeCompare(right.assetId) || left.sceneId.localeCompare(right.sceneId));
    const scored = Object.freeze(allowed.map((candidate) => candidateMatchScore(
      candidate,
      scenesById.get(candidate.sceneId)!,
      segment,
    )));
    const selected = scored.find(candidateClearsMatchingThresholds);
    if (!selected) unmatched.push(segment.id);
    rankedCandidateSets.push(Object.freeze({
      intervalId: segment.id,
      candidates: scored,
      ...(selected ? { selectedAssetId: selected.assetId } : {}),
      confidence: selected?.totalScore ?? 0,
    }));
  }
  return Object.freeze({
    rankedCandidateSets: Object.freeze(rankedCandidateSets),
    protectedConflicts: Object.freeze(protectedConflicts),
    rejected: Object.freeze(rejected),
    unmatched: Object.freeze(unmatched),
  });
}

export function buildMusicVideoTimelineProposal(input: Readonly<{
  project: EditorProject;
  musicSegments: readonly MusicSegmentV1[];
  videoScenes: readonly VideoSceneV1[];
  constraintSet?: ConstraintSetV1;
  constraintContext?: ProposalConstraintContextV1;
  sessionDecisionLedger?: SessionDecisionLedgerV1;
}>): MusicVideoLinkageResultV1 {
  const trustedProject = cloneProject(input.project);
  const segments = Object.freeze([...input.musicSegments]);
  const scenes = Object.freeze([...input.videoScenes]);
  if (!segments.length) return notEvaluable(["NO_MUSIC_SEGMENTS"], segments, scenes, []);
  if (!scenes.length) return notEvaluable(["NO_VIDEO_SCENES"], segments, scenes, []);
  if (Boolean(input.constraintSet) !== Boolean(input.constraintContext)) {
    return notEvaluable(["STALE_CONSTRAINT_CONTEXT"], segments, scenes, []);
  }
  const slots = seedSlots(trustedProject, segments);
  if (!slots.length) return notEvaluable(["NO_TIMELINE_SLOT"], segments, scenes, []);
  const usage: Record<string, number> = Object.create(null);
  trustedProject.tracks.flatMap((track) => track.clips).forEach((clip) => { usage[clip.assetId] = (usage[clip.assetId] ?? 0) + 1; });
  const candidates = scoreMusicVideoCandidates({ musicSegments: segments, videoScenes: scenes, initialAssetUsage: usage });
  const audit = buildRankedCandidates({
    project: trustedProject,
    segments,
    scenes,
    candidates,
    slots,
    ...(input.constraintSet ? { constraintSet: input.constraintSet } : {}),
    ...(input.constraintContext ? { constraintContext: input.constraintContext } : {}),
  });
  const matchedSegments = segments.filter((segment) => !audit.unmatched.includes(segment.id));
  if (!matchedSegments.length) {
    const unmatchedCandidates = candidates.filter((candidate) => audit.unmatched.includes(candidate.musicSegmentId));
    const reasons: MusicVideoNotEvaluableReasonV1[] = [];
    if (audit.protectedConflicts.length) reasons.push("HARD_CONSTRAINT_CONFLICT");
    if (unmatchedCandidates.some((candidate) => candidate.rejectionReason === "SOURCE_RANGE_UNSUPPORTED")) reasons.push("SOURCE_RANGE_UNSUPPORTED");
    if (unmatchedCandidates.length && unmatchedCandidates.every((candidate) => candidate.rejectionReason === "NO_SEMANTIC_EVIDENCE")) reasons.push("NO_SEMANTIC_EVIDENCE");
    if (unmatchedCandidates.some((candidate) => candidate.rejectionReason === "NO_DURATION_COMPATIBLE_SCENE")) reasons.push("NO_DURATION_COMPATIBLE_SCENE");
    if (!reasons.length) reasons.push("ALL_CANDIDATES_REJECTED");
    return notEvaluable(reasons, segments, scenes, candidates, audit.unmatched, audit.protectedConflicts);
  }

  const intervals: readonly MatchingInterval[] = Object.freeze(matchedSegments.map((segment) => Object.freeze({
    id: segment.id,
    timelineStartMs: segment.startMs,
    timelineEndMs: segment.endMs,
    text: segment.lyricText,
    concepts: segment.semanticTags,
  })));
  const semanticEvidence: readonly VideoSemanticSegment[] = Object.freeze(scenes.map((scene) => Object.freeze({
    id: scene.sceneId,
    assetId: scene.assetId,
    startMs: scene.startMs,
    endMs: scene.endMs,
    summary: scene.semanticSummary,
    concepts: scene.semanticTags,
    usability: scene.usability,
    confidence: scene.confidence,
    evidenceFrameMs: scene.evidenceFrameMs,
  })));
  const matchedRankedSets = audit.rankedCandidateSets.filter((set) => !audit.unmatched.includes(set.intervalId));
  const matchedSlots = slots.filter((slot) => !audit.unmatched.includes(slot.intervalId))
    .map((slot, order) => Object.freeze({ ...slot, order }));
  const narrativePlan = planNarrativeSequence({ intervals, rankedCandidateSets: matchedRankedSets, semanticEvidence });
  if (narrativePlan.unresolvedIntervalIds.length) {
    return notEvaluable(["ALL_CANDIDATES_REJECTED"], segments, scenes, candidates, narrativePlan.unresolvedIntervalIds, audit.protectedConflicts);
  }
  const compiledPlan = compileNarrativeActionPlan({
    mode: "INITIAL_PLAN",
    narrativePlan,
    seedSlots: matchedSlots,
    project: trustedProject,
    ownedAssetIds: trustedProject.assets.map((asset) => asset.id),
    ...(input.constraintSet && input.constraintContext ? { constraintContext: {
      intentVersionId: input.constraintContext.sourceIntentVersionId,
      constraintSetId: input.constraintContext.sourceConstraintSetId,
      constraintFingerprint: input.constraintContext.sourceConstraintFingerprint,
      constraintSet: input.constraintSet,
    } } : {}),
    ...(input.sessionDecisionLedger ? { rejectedOperationTuples: input.sessionDecisionLedger.rejectedProposalOperationTuples } : {}),
  });
  if (compiledPlan.status !== "VALIDATED") {
    const sourceRange = compiledPlan.errors.some((issue) => issue.code === "SOURCE_RANGE_PLACEMENT_LIMITATION");
    const stale = compiledPlan.errors.some((issue) => issue.code === "STALE_CONSTRAINT_CONTEXT");
    return notEvaluable([
      stale ? "STALE_CONSTRAINT_CONTEXT" : sourceRange ? "SOURCE_RANGE_UNSUPPORTED" : "COMPILATION_REJECTED",
    ], segments, scenes, candidates, segments.map((segment) => segment.id), audit.protectedConflicts);
  }
  const planEvidence = createPlanEvidence({
    intervals,
    rankedCandidateSets: matchedRankedSets,
    narrativePlan,
    compiledPlan,
    preExecutionProject: trustedProject,
    ...(input.constraintSet ? { constraintSet: input.constraintSet } : {}),
    ...(input.constraintContext ? { constraintContext: input.constraintContext } : {}),
  });
  const proposalEntries: readonly EditorProposalEntryReference[] = Object.freeze(planEvidence.entries.map((entry) => Object.freeze({
    proposalEntryId: entry.proposalEntryId,
    intervalId: entry.intervalId,
    ...(entry.compiledAction ? { actionIndex: entry.compiledAction.actionIndex, targetId: entry.compiledAction.targetId } : {}),
    ...(entry.selectedAssetId ? { selectedAssetId: entry.selectedAssetId } : {}),
    candidateAlternativeAssetIds: Object.freeze(entry.matching?.rejectedAlternatives.map((item) => item.assetId) ?? []),
  })));
  const proposal: EditorProposalBundle = Object.freeze({
    schemaVersion: EDITOR_PROPOSAL_SCHEMA_VERSION,
    proposalId: planEvidence.planId,
    status: "PENDING_REVIEW",
    sourceProjectFingerprint: createEditorProjectFingerprint(trustedProject),
    matchingIntervals: intervals,
    rankedCandidateSets: matchedRankedSets,
    narrativePlan,
    compiledPlan,
    trustedPreExecutionProject: trustedProject,
    planEvidence,
    proposalEntries,
    evidenceMetadata: Object.freeze({
      videoAnalysisVersions: Object.freeze([...new Set(scenes.map((scene) => scene.analysisVersion))].sort()),
      ...(segments.some((segment) => segment.evidenceSources.includes("LOCAL_RHYTHM"))
        ? { audioRhythmSourceId: segments[0].sourceId }
        : {}),
      ...(input.constraintContext ? { constraintContext: input.constraintContext } : {}),
      providerCalls: 0,
      networkCalls: 0,
    }),
    ...(input.constraintSet ? { constraintSet: input.constraintSet } : {}),
    ...(input.sessionDecisionLedger ? { sessionDecisionLedger: input.sessionDecisionLedger } : {}),
  });
  const chosenByInterval = new Map(narrativePlan.intervalPlans.flatMap((plan) => (
    plan.status === "resolved" ? [[plan.intervalId, plan.assetId] as const] : []
  )));
  const selectedMatches = Object.freeze(segments.flatMap((segment) => {
    const selectedAssetId = chosenByInterval.get(segment.id);
    if (!selectedAssetId) return [];
    const match = candidates.filter((candidate) => candidate.musicSegmentId === segment.id
      && candidate.assetId === selectedAssetId && candidate.eligible)
      .sort((left, right) => right.totalScore - left.totalScore || left.sceneId.localeCompare(right.sceneId))[0];
    return match ? [match] : [];
  }));
  const evidence: MusicVideoLinkageEvidenceV1 = Object.freeze({
    schemaVersion: MUSIC_VIDEO_LINKAGE_SCHEMA_VERSION,
    musicSegmentCount: segments.length,
    videoSceneCount: scenes.length,
    candidateMatchCount: candidates.length,
    selectedMatchCount: selectedMatches.length,
    unmatchedMusicSegmentIds: Object.freeze([...audit.unmatched]),
    rejectedMatches: Object.freeze([
      ...audit.rejected,
      ...candidates.filter((candidate) => candidate.eligible
        && !selectedMatches.some((selected) => selected.musicSegmentId === candidate.musicSegmentId && selected.sceneId === candidate.sceneId)),
    ]),
    protectedConflicts: audit.protectedConflicts,
    selectedMatches,
    providerCalls: 0,
    networkCalls: 0,
  });
  return Object.freeze({
    status: "READY_FOR_REVIEW",
    musicSegments: segments,
    videoScenes: scenes,
    candidateMatches: candidates,
    evidence,
    proposal,
  });
}
