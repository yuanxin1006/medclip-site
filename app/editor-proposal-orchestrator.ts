import { cloneProject, type EditorProject, type TimelineCaption, type TimelineClip } from "./editor-core.ts";
import {
  buildMultimodalCandidateTable,
  candidateClearsMatchingThresholds,
  normalizeMatchingConcept,
  type MatchingAssetCandidate,
  type MatchingInterval,
  type RankedCandidateSet,
} from "./editor-multimodal-matching.ts";
import type { ConstraintFeasibilityReportV1 } from "./editor-constraint-feasibility.ts";
import {
  enforceEditorActionConstraintsV1,
} from "./editor-constraint-enforcement.ts";
import { NARRATIVE_SCORE_MODEL, planNarrativeSequence, type NarrativeSequencePlan } from "./editor-narrative-planner.ts";
import {
  compileNarrativeActionPlan,
  type CompiledNarrativeActionPlan,
  type SeedTimelineSlot,
} from "./editor-narrative-action-compiler.ts";
import { createEditorProjectFingerprint, createPlanEvidence, type PlanEvidence } from "./editor-plan-evidence.ts";
import type { VideoSemanticAnalysis, VideoSemanticSegment } from "./editor-video-semantic.ts";
import type { AudioRhythmAnalysis } from "./editor-audio-rhythm.ts";
import {
  isProposalConstraintContextCurrentV1,
  type ProposalConstraintContextV1,
} from "./editor-constraint-negotiation.ts";
import type { SessionDecisionLedgerV1 } from "./editor-constraint-negotiation.ts";
import type { ConstraintSetV1 } from "./editor-constraints.ts";
import {
  emitEditorProposalStageDiagnosticV1,
  emitSafeNoChangeEligibilityDiagnosticV1,
  type EditorAcceptanceDiagnosticStageV1,
} from "./editor-acceptance-diagnostics.ts";

export const EDITOR_PROPOSAL_SCHEMA_VERSION = 1 as const;
export type ProposalPlanningStrategyV1 = "BALANCED" | "CONTENT_PRIORITY" | "RHYTHM_PRIORITY";
export type EditorProposalStatus = "PENDING_REVIEW" | "SAFE_NO_CHANGE";
export type ProposalGenerationStatus =
  | "READY_FOR_REVIEW"
  | "READY_WITH_NO_CHANGES"
  | "NO_VALID_CANDIDATE"
  | "UNRESOLVED_INTERVAL"
  | "SOURCE_RANGE_UNSUPPORTED"
  | "MISSING_VIDEO_EVIDENCE"
  | "MISSING_INTERVALS"
  | "NEGOTIATION_NOT_READY"
  | "COMPILATION_REJECTED";

export type CaptionConceptInput = Readonly<{ captionId: string; concepts: readonly string[] }>;
export type EditorProposalInput = Readonly<{
  project: EditorProject;
  videoAnalyses: readonly VideoSemanticAnalysis[];
  captionConcepts: readonly CaptionConceptInput[];
  captionScopeIds?: readonly string[];
  rhythm?: AudioRhythmAnalysis;
  constraintContext?: ProposalConstraintContextV1;
  constraintSet?: ConstraintSetV1;
  sessionDecisionLedger?: SessionDecisionLedgerV1;
  planningStrategy?: ProposalPlanningStrategyV1;
  feasibilityReport?: ConstraintFeasibilityReportV1;
}>;

export type SafeNoChangeEligibilityCheckV1 =
  | "FEASIBILITY_REPORT_PRESENT"
  | "CONSTRAINT_SET_PRESENT"
  | "CONSTRAINT_CONTEXT_PRESENT"
  | "RESOLUTION_PRESENT"
  | "PROJECT_ID_MATCH"
  | "PROJECT_FINGERPRINT_MATCH"
  | "CONSTRAINT_SET_ID_MATCH"
  | "CONSTRAINT_FINGERPRINT_MATCH"
  | "FEASIBILITY_CONTEXT_MATCH"
  | "CONSTRAINT_SET_PROJECT_FINGERPRINT_MATCH"
  | "FEASIBILITY_STATUS_SUPPORTED"
  | "DURATION_POLICY_SUPPORTED"
  | "REQUESTED_TARGET_VALID"
  | "MINIMUM_FEASIBLE_VALID"
  | "TARGET_GAP_VALID"
  | "TARGET_GAP_POSITIVE"
  | "CURRENT_PROJECT_IS_MINIMUM"
  | "NO_COMPRESSIBLE_UNPROTECTED_DURATION"
  | "FULL_TIMELINE_PROTECTED"
  | "NO_LEGAL_MUTATION_CANDIDATES";

export type SafeNoChangeEligibilityReasonCodeV1 =
  | "ELIGIBLE"
  | "FEASIBILITY_MISSING"
  | "CONSTRAINT_CONTEXT_INVALID"
  | "RESOLUTION_NOT_ALLOWED"
  | "PROJECT_FINGERPRINT_MISMATCH"
  | "CONSTRAINT_SET_MISMATCH"
  | "STALE_CONSTRAINT_SET"
  | "FEASIBILITY_STATUS_NOT_ALLOWED"
  | "MALFORMED_FEASIBILITY"
  | "TARGET_GAP_MISSING"
  | "CURRENT_PROJECT_NOT_MINIMUM"
  | "UNPROTECTED_CONTENT_REMAINS"
  | "TIMELINE_NOT_FULLY_PROTECTED"
  | "LEGAL_ACTIONS_REMAIN";

export type SafeNoChangeEligibilityV1 = Readonly<{
  eligible: boolean;
  reasonCode: SafeNoChangeEligibilityReasonCodeV1;
  failedChecks: readonly SafeNoChangeEligibilityCheckV1[];
  passedChecks: readonly SafeNoChangeEligibilityCheckV1[];
  evidence: Readonly<{
    feasibilityStatus: ConstraintFeasibilityReportV1["status"] | null;
    durationPolicy: ConstraintFeasibilityReportV1["durationPolicy"] | null;
    requestedDurationMs: number | null;
    minimumFeasibleDurationMs: number | null;
    remainingGapMs: number | null;
    projectDurationMs: number;
    compressibleUnprotectedDurationMs: number | null;
    protectedTimelineRangeCount: number;
    legalMutationCandidateCount: number;
  }>;
}>;

export type EditorSafeNoChangeOutcomeV1 = Readonly<{
  status: "SAFE_NO_CHANGE";
  intentVersionId: string;
  constraintSetId: string;
  constraintResolutionId: string;
  projectFingerprint: string;
  feasibilityRef: Readonly<{
    reportId: string;
    requestedDurationMs: number;
    minimumFeasibleDurationMs: number;
    remainingGapMs: number;
  }>;
  requestedTargetMs: number;
  minimumFeasibleDurationMs: number;
  remainingGapMs: number;
  protectedContentStatus: "PRESERVED";
  reasonCode: "NO_LEGAL_UNPROTECTED_EDITS";
  reason: string;
  evidence: Readonly<{
    protectedConstraintIds: readonly string[];
    protectedTimelineRangeCount: number;
    blockedCandidateCount: number;
    legalExecutableActionCount: 0;
    filteredCandidateIssues: readonly Readonly<{
      code: "HARD_CONSTRAINT_BLOCKED";
      intervalId: string;
      detail: string;
    }>[];
  }>;
}>;

export type EditorProposalEntryReference = Readonly<{
  proposalEntryId: string;
  intervalId: string;
  actionIndex?: number;
  targetId?: string;
  selectedAssetId?: string;
  candidateAlternativeAssetIds: readonly string[];
}>;

export type EditorProposalBundle = Readonly<{
  schemaVersion: typeof EDITOR_PROPOSAL_SCHEMA_VERSION;
  proposalId: string;
  status: EditorProposalStatus;
  sourceProjectFingerprint: string;
  matchingIntervals: readonly MatchingInterval[];
  rankedCandidateSets: readonly RankedCandidateSet[];
  narrativePlan: NarrativeSequencePlan;
  compiledPlan: CompiledNarrativeActionPlan;
  trustedPreExecutionProject: EditorProject;
  planEvidence: PlanEvidence;
  proposalEntries: readonly EditorProposalEntryReference[];
  evidenceMetadata: Readonly<{
    videoAnalysisVersions: readonly string[];
    audioRhythmSourceId?: string;
    constraintContext?: ProposalConstraintContextV1;
    providerCalls: 0;
    networkCalls: 0;
  }>;
  constraintSet?: ConstraintSetV1;
  sessionDecisionLedger?: SessionDecisionLedgerV1;
  safeNoChangeOutcome?: EditorSafeNoChangeOutcomeV1;
}>;

export type EditorProposalGenerationResult =
  | Readonly<{ ok: true; status: "READY_FOR_REVIEW" | "READY_WITH_NO_CHANGES"; bundle: EditorProposalBundle }>
  | Readonly<{ ok: false; status: Exclude<ProposalGenerationStatus, "READY_FOR_REVIEW" | "READY_WITH_NO_CHANGES">; message: string; intervalIds?: readonly string[]; assetIds?: readonly string[] }>;

class ControlledProposalFailure extends Error {
  readonly code: Exclude<ProposalGenerationStatus, "READY_FOR_REVIEW" | "READY_WITH_NO_CHANGES">;
  readonly details: Readonly<{ intervalIds?: readonly string[]; assetIds?: readonly string[] }>;

  constructor(
    code: Exclude<ProposalGenerationStatus, "READY_FOR_REVIEW" | "READY_WITH_NO_CHANGES">,
    message: string,
    details: Readonly<{ intervalIds?: readonly string[]; assetIds?: readonly string[] }> = {},
  ) {
    super(message);
    this.name = "ControlledProposalFailure";
    this.code = code;
    this.details = details;
  }
}

function fail(
  code: ControlledProposalFailure["code"],
  message: string,
  details?: ControlledProposalFailure["details"],
): never {
  throw new ControlledProposalFailure(code, message, details);
}

function buildIntervals(project: EditorProject, conceptInputs: readonly CaptionConceptInput[], scope?:readonly string[]): readonly MatchingInterval[] {
  if(scope && (!scope.length||new Set(scope).size!==scope.length||scope.some(id=>!project.captions.some(c=>c.id===id))))fail("MISSING_INTERVALS","所选字幕区间无效。");
  const conceptsByCaption = new Map(conceptInputs.map((item) => [item.captionId, item.concepts]));
  const captions = [...project.captions]
    .filter((caption) => usableCaption(caption, project.durationMs) && (!scope||scope.includes(caption.id)))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id));
  if (!captions.length) fail("MISSING_INTERVALS", "当前工程没有可用于规划的有效字幕时间区间。");
  if (new Set(captions.map((caption) => caption.id)).size !== captions.length) {
    fail("MISSING_INTERVALS", "字幕区间标识不唯一，无法安全生成建议。");
  }
  return Object.freeze(captions.map((caption) => Object.freeze({
    id: caption.id,
    timelineStartMs: caption.startMs,
    timelineEndMs: caption.endMs,
    text: caption.text.trim(),
    concepts: Object.freeze([...(conceptsByCaption.get(caption.id) ?? [])]
      .map(normalizeMatchingConcept)
      .filter((concept, index, all) => Boolean(concept) && all.indexOf(concept) === index)),
  })));
}

function usableCaption(caption: TimelineCaption, durationMs: number): boolean {
  return Boolean(caption.id && caption.text.trim())
    && Number.isSafeInteger(caption.startMs) && Number.isSafeInteger(caption.endMs)
    && caption.startMs >= 0 && caption.endMs > caption.startMs && caption.endMs <= durationMs;
}

function buildAssets(project: EditorProject, analyses: readonly VideoSemanticAnalysis[]): {
  assets: readonly MatchingAssetCandidate[];
  semanticEvidence: readonly VideoSemanticSegment[];
} {
  const byAsset = new Map(analyses.map((analysis) => [analysis.assetId, analysis]));
  const missing = project.assets.filter((asset) => !byAsset.has(asset.id)).map((asset) => asset.id);
  if (missing.length) {
    fail("MISSING_VIDEO_EVIDENCE", "部分素材尚无当前会话的视频语义证据。", { assetIds: Object.freeze(missing) });
  }
  const mismatched = project.assets.filter((asset) => byAsset.get(asset.id)?.assetDurationMs !== asset.durationMs).map((asset) => asset.id);
  if (mismatched.length) {
    fail("MISSING_VIDEO_EVIDENCE", "素材语义证据与当前素材时长不一致，请重新分析。", { assetIds: Object.freeze(mismatched) });
  }
  const assets = project.assets.map((asset) => {
    const analysis = byAsset.get(asset.id)!;
    return Object.freeze({ assetId: asset.id, sourceDurationMs: asset.durationMs, semanticSegments: analysis.segments });
  });
  return {
    assets: Object.freeze(assets),
    semanticEvidence: Object.freeze(assets.flatMap((asset) => [...asset.semanticSegments])),
  };
}

function overlapMs(interval: MatchingInterval, clip: TimelineClip): number {
  return Math.max(0, Math.min(interval.timelineEndMs, clip.timelineEndMs) - Math.max(interval.timelineStartMs, clip.timelineStartMs));
}

function buildSeedSlots(project: EditorProject, intervals: readonly MatchingInterval[]): readonly SeedTimelineSlot[] {
  const clips = project.tracks
    .filter((track) => track.type === "video" || track.type === "broll")
    .flatMap((track) => track.clips)
    .sort((left, right) => left.timelineStartMs - right.timelineStartMs || left.timelineEndMs - right.timelineEndMs || left.id.localeCompare(right.id));
  const claimed = new Set<string>();
  const slots = intervals.map((interval, order) => {
    const clip = clips
      .filter((candidate) => !claimed.has(candidate.id) && overlapMs(interval, candidate) > 0)
      .sort((left, right) => overlapMs(interval, right) - overlapMs(interval, left)
        || left.timelineStartMs - right.timelineStartMs || left.id.localeCompare(right.id))[0];
    if (!clip) {
      fail("SOURCE_RANGE_UNSUPPORTED", "当前时间线不能为每个字幕区间提供唯一的可信目标片段。", { intervalIds: [interval.id] });
    }
    claimed.add(clip.id);
    return Object.freeze({
      order,
      intervalId: interval.id,
      clipId: clip.id,
      timelineStartMs: clip.timelineStartMs,
      timelineEndMs: clip.timelineEndMs,
      currentAssetId: clip.assetId,
    });
  });
  return Object.freeze(slots);
}

function usageContext(project: EditorProject): Readonly<Record<string, number>> {
  const usage: Record<string, number> = Object.create(null);
  project.tracks.flatMap((track) => track.clips).forEach((clip) => { usage[clip.assetId] = (usage[clip.assetId] ?? 0) + 1; });
  return Object.freeze(usage);
}

function strategyCandidateTable(
  table: readonly RankedCandidateSet[],
  strategy: ProposalPlanningStrategyV1 | undefined,
): readonly RankedCandidateSet[] {
  if (!strategy || strategy === "BALANCED") return table;
  return Object.freeze(table.map((set, intervalIndex) => {
    const acceptable = set.candidates
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate }) => candidateClearsMatchingThresholds(candidate));
    if (acceptable.length < 2) return set;
    const originalBest = acceptable[0].candidate;
    const materiallyEligible = acceptable.filter(({ candidate }) => (
      originalBest.totalScore - candidate.totalScore <= NARRATIVE_SCORE_MODEL.maximumLocalScoreDeficit
      && originalBest.semanticScore - candidate.semanticScore <= NARRATIVE_SCORE_MODEL.maximumSemanticScoreDeficit
    ));
    let chosen = materiallyEligible[0];
    if (strategy === "CONTENT_PRIORITY") {
      chosen = [...materiallyEligible].sort((left, right) => (
        right.candidate.semanticScore - left.candidate.semanticScore
        || right.candidate.usabilityScore - left.candidate.usabilityScore
        || right.candidate.totalScore - left.candidate.totalScore
        || left.candidate.assetId.localeCompare(right.candidate.assetId)
      ))[0];
    } else if (materiallyEligible.length > 1) {
      // V2.0A currently exposes rhythm as interval evidence rather than a
      // candidate score. A bounded alternate on every other eligible interval
      // gives V2.0B a distinct, still-thresholded sequence to optimize.
      chosen = materiallyEligible[Math.min(1 + (intervalIndex % 2), materiallyEligible.length - 1)];
    }
    if (!chosen || chosen.candidateIndex === 0) return set;
    const candidates = Object.freeze(set.candidates.slice(chosen.candidateIndex));
    return Object.freeze({
      intervalId: set.intervalId,
      candidates,
      selectedAssetId: candidates[0].assetId,
      confidence: candidates[0].totalScore,
      ...(set.rhythmEvidence ? { rhythmEvidence: set.rhythmEvidence } : {}),
    });
  }));
}

type CandidateConstraintAudit = Readonly<{
  rankedCandidateSets: readonly RankedCandidateSet[];
  blockedCandidateCount: number;
  legalMutationCandidateCount: number;
  blockedIssues: readonly Readonly<{
    code: "HARD_CONSTRAINT_BLOCKED";
    intervalId: string;
    detail: string;
  }>[];
}>;

function safeNoChangeMutationAudit(input: EditorProposalInput): CandidateConstraintAudit {
  const set = input.constraintSet;
  const context = input.constraintContext;
  if (!set || !context) {
    return Object.freeze({
      rankedCandidateSets: Object.freeze([]),
      blockedCandidateCount: 0,
      legalMutationCandidateCount: 1,
      blockedIssues: Object.freeze([]),
    });
  }
  let blockedCandidateCount = 0;
  let legalMutationCandidateCount = 0;
  const blockedIssues: Array<{
    code: "HARD_CONSTRAINT_BLOCKED";
    intervalId: string;
    detail: string;
  }> = [];
  const clips = input.project.tracks
    .filter((track) => track.type === "video" || track.type === "broll")
    .flatMap((track) => track.clips);
  for (const clip of clips) {
    for (const asset of input.project.assets) {
      if (asset.id === clip.assetId) continue;
      const enforcement = enforceEditorActionConstraintsV1({
        project: input.project,
        constraintSet: set,
        expectedContext: {
          intentVersionId: context.sourceIntentVersionId,
          constraintSetId: context.sourceConstraintSetId,
          constraintFingerprint: context.sourceConstraintFingerprint,
        },
        action: {
          type: "MATCH_ASSET_TO_SEGMENT",
          targetId: clip.id,
          assetId: asset.id,
          startSeconds: clip.timelineStartMs / 1_000,
          endSeconds: clip.timelineEndMs / 1_000,
        },
      });
      if (enforcement.status === "ALLOWED" && enforcement.violations.length === 0) {
        legalMutationCandidateCount += 1;
        continue;
      }
      blockedCandidateCount += 1;
      blockedIssues.push(Object.freeze({
        code: "HARD_CONSTRAINT_BLOCKED",
        intervalId: clip.id,
        detail: enforcement.status === "STALE_CONSTRAINT_CONTEXT"
          ? "Constraint context is stale during safe no-change diagnostics."
          : enforcement.violations[0]?.messageZh ?? "Canonical candidate is blocked by active hard constraints.",
      }));
    }
  }
  return Object.freeze({
    rankedCandidateSets: Object.freeze([]),
    blockedCandidateCount,
    legalMutationCandidateCount,
    blockedIssues: Object.freeze(blockedIssues),
  });
}

export function diagnoseSafeNoChangeEligibilityV1(input: EditorProposalInput): SafeNoChangeEligibilityV1 {
  const projectFingerprint = createEditorProjectFingerprint(input.project);
  const audit = safeNoChangeMutationAudit(input);
  return evaluateSafeNoChangeEligibilityV1(input, projectFingerprint, audit.legalMutationCandidateCount);
}

function constraintSafeCandidateTable(
  table: readonly RankedCandidateSet[],
  seedSlots: readonly SeedTimelineSlot[],
  project: EditorProject,
  constraintSet: ConstraintSetV1 | undefined,
  constraintContext: ProposalConstraintContextV1 | undefined,
): CandidateConstraintAudit {
  if (!constraintSet || !constraintContext) {
    return Object.freeze({ rankedCandidateSets: table, blockedCandidateCount: 0, legalMutationCandidateCount: 0, blockedIssues: Object.freeze([]) });
  }
  const slots = new Map(seedSlots.map((slot) => [slot.intervalId, slot]));
  const clips = new Map(project.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]));
  let blockedCandidateCount = 0;
  let legalMutationCandidateCount = 0;
  const blockedIssues: Array<{ code: "HARD_CONSTRAINT_BLOCKED"; intervalId: string; detail: string }> = [];
  const filtered = table.map((set) => {
    const slot = slots.get(set.intervalId);
    const clip = slot ? clips.get(slot.clipId) : undefined;
    if (!slot || !clip) return set;
    const candidates = set.candidates.filter((candidate) => {
      if (candidate.assetId === slot.currentAssetId && clip.sourceInMs === 0) return true;
      const enforcement = enforceEditorActionConstraintsV1({
        project,
        constraintSet,
        expectedContext: {
          intentVersionId: constraintContext.sourceIntentVersionId,
          constraintSetId: constraintContext.sourceConstraintSetId,
          constraintFingerprint: constraintContext.sourceConstraintFingerprint,
        },
        action: {
          type: "MATCH_ASSET_TO_SEGMENT",
          targetId: slot.clipId,
          assetId: candidate.assetId,
          startSeconds: slot.timelineStartMs / 1_000,
          endSeconds: slot.timelineEndMs / 1_000,
        },
      });
      if (enforcement.status === "STALE_CONSTRAINT_CONTEXT") {
        fail("COMPILATION_REJECTED", "Constraint context became stale during candidate preflight.");
      }
      if (enforcement.status !== "ALLOWED") {
        blockedCandidateCount += 1;
        blockedIssues.push(Object.freeze({
          code: "HARD_CONSTRAINT_BLOCKED",
          intervalId: set.intervalId,
          detail: enforcement.violations[0]?.messageZh ?? "Canonical candidate is blocked by active hard constraints.",
        }));
        return false;
      }
      if (candidateClearsMatchingThresholds(candidate)) legalMutationCandidateCount += 1;
      return true;
    });
    const selectedAssetId = candidates.find(candidateClearsMatchingThresholds)?.assetId;
    return Object.freeze({
      ...set,
      candidates: Object.freeze(candidates),
      ...(selectedAssetId ? { selectedAssetId } : { selectedAssetId: undefined }),
      confidence: selectedAssetId ? candidates.find((candidate) => candidate.assetId === selectedAssetId)!.totalScore : 0,
    });
  });
  return Object.freeze({
    rankedCandidateSets: Object.freeze(filtered),
    blockedCandidateCount,
    legalMutationCandidateCount,
    blockedIssues: Object.freeze(blockedIssues),
  });
}

function emptySafeNoChangeNarrativePlan(): NarrativeSequencePlan {
  return Object.freeze({
    intervalPlans: Object.freeze([]),
    totalLocalScore: 0,
    totalNarrativeScore: 0,
    totalSequenceScore: 0,
    totalSemanticScore: 0,
    totalSequenceRepetitionPenalty: 0,
    unresolvedIntervalIds: Object.freeze([]),
  });
}

function fullyProtectedTimeline(report: ConstraintFeasibilityReportV1, durationMs: number): boolean {
  if (!Array.isArray(report.mergedProtectedTimelineRanges)) return false;
  const ranges = [...report.mergedProtectedTimelineRanges]
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  if (!ranges.length || ranges[0].startMs > 0) return false;
  let coveredUntil = ranges[0].endMs;
  for (const range of ranges.slice(1)) {
    if (range.startMs > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, range.endMs);
  }
  return coveredUntil >= durationMs;
}

type EligibilityCheckResult = Readonly<{
  check: SafeNoChangeEligibilityCheckV1;
  passed: boolean;
  reasonCode: Exclude<SafeNoChangeEligibilityReasonCodeV1, "ELIGIBLE">;
}>;

export function evaluateSafeNoChangeEligibilityV1(
  input: EditorProposalInput,
  projectFingerprint: string,
  legalMutationCandidateCount: number,
): SafeNoChangeEligibilityV1 {
  const report = input.feasibilityReport;
  const set = input.constraintSet;
  const context = input.constraintContext;
  const resolutionId = context?.resolutionIds.at(-1);
  const checks: readonly EligibilityCheckResult[] = [
    { check: "FEASIBILITY_REPORT_PRESENT", passed: Boolean(report), reasonCode: "FEASIBILITY_MISSING" },
    { check: "CONSTRAINT_SET_PRESENT", passed: Boolean(set), reasonCode: "CONSTRAINT_CONTEXT_INVALID" },
    { check: "CONSTRAINT_CONTEXT_PRESENT", passed: Boolean(context), reasonCode: "CONSTRAINT_CONTEXT_INVALID" },
    { check: "RESOLUTION_PRESENT", passed: Boolean(resolutionId), reasonCode: "RESOLUTION_NOT_ALLOWED" },
    { check: "PROJECT_ID_MATCH", passed: Boolean(report && report.projectId === input.project.id), reasonCode: "PROJECT_FINGERPRINT_MISMATCH" },
    { check: "PROJECT_FINGERPRINT_MATCH", passed: Boolean(report && report.evaluatedProjectFingerprint === projectFingerprint), reasonCode: "PROJECT_FINGERPRINT_MISMATCH" },
    { check: "CONSTRAINT_SET_ID_MATCH", passed: Boolean(report && set && report.constraintSetId === set.constraintSetId), reasonCode: "CONSTRAINT_SET_MISMATCH" },
    { check: "CONSTRAINT_FINGERPRINT_MATCH", passed: Boolean(report && set && report.constraintFingerprint === set.constraintFingerprint), reasonCode: "CONSTRAINT_SET_MISMATCH" },
    { check: "FEASIBILITY_CONTEXT_MATCH", passed: Boolean(report && context && report.reportId === context.feasibilityReportId), reasonCode: "CONSTRAINT_CONTEXT_INVALID" },
    { check: "CONSTRAINT_SET_PROJECT_FINGERPRINT_MATCH", passed: Boolean(set && set.validatedAgainstProjectFingerprint === projectFingerprint), reasonCode: "STALE_CONSTRAINT_SET" },
    { check: "FEASIBILITY_STATUS_SUPPORTED", passed: report?.status === "FEASIBLE_WITH_TARGET_GAP", reasonCode: "FEASIBILITY_STATUS_NOT_ALLOWED" },
    { check: "DURATION_POLICY_SUPPORTED", passed: report?.durationPolicy === "APPROXIMATE_TARGET", reasonCode: "RESOLUTION_NOT_ALLOWED" },
    { check: "REQUESTED_TARGET_VALID", passed: Number.isSafeInteger(report?.requestedDurationMs) && (report?.requestedDurationMs ?? -1) >= 0, reasonCode: "MALFORMED_FEASIBILITY" },
    { check: "MINIMUM_FEASIBLE_VALID", passed: Number.isSafeInteger(report?.minimumFeasibleDurationMs) && (report?.minimumFeasibleDurationMs ?? -1) >= 0, reasonCode: "MALFORMED_FEASIBILITY" },
    { check: "TARGET_GAP_VALID", passed: Number.isSafeInteger(report?.remainingGapMs) && (report?.remainingGapMs ?? -1) >= 0, reasonCode: "MALFORMED_FEASIBILITY" },
    { check: "TARGET_GAP_POSITIVE", passed: Boolean(report && report.remainingGapMs !== null && report.remainingGapMs > 0), reasonCode: "TARGET_GAP_MISSING" },
    { check: "CURRENT_PROJECT_IS_MINIMUM", passed: Boolean(report && report.minimumFeasibleDurationMs === input.project.durationMs), reasonCode: "CURRENT_PROJECT_NOT_MINIMUM" },
    { check: "NO_COMPRESSIBLE_UNPROTECTED_DURATION", passed: report?.compressibleUnprotectedDurationMs === 0, reasonCode: "UNPROTECTED_CONTENT_REMAINS" },
    { check: "FULL_TIMELINE_PROTECTED", passed: Boolean(report && fullyProtectedTimeline(report, input.project.durationMs)), reasonCode: "TIMELINE_NOT_FULLY_PROTECTED" },
    { check: "NO_LEGAL_MUTATION_CANDIDATES", passed: legalMutationCandidateCount === 0, reasonCode: "LEGAL_ACTIONS_REMAIN" },
  ];
  const failed = checks.filter((item) => !item.passed);
  return Object.freeze({
    eligible: failed.length === 0,
    reasonCode: failed[0]?.reasonCode ?? "ELIGIBLE",
    failedChecks: Object.freeze(failed.map((item) => item.check)),
    passedChecks: Object.freeze(checks.filter((item) => item.passed).map((item) => item.check)),
    evidence: Object.freeze({
      feasibilityStatus: report?.status ?? null,
      durationPolicy: report?.durationPolicy ?? null,
      requestedDurationMs: report?.requestedDurationMs ?? null,
      minimumFeasibleDurationMs: report?.minimumFeasibleDurationMs ?? null,
      remainingGapMs: report?.remainingGapMs ?? null,
      projectDurationMs: input.project.durationMs,
      compressibleUnprotectedDurationMs: report?.compressibleUnprotectedDurationMs ?? null,
      protectedTimelineRangeCount: Array.isArray(report?.mergedProtectedTimelineRanges) ? report.mergedProtectedTimelineRanges.length : 0,
      legalMutationCandidateCount,
    }),
  });
}

function safeNoChangeOutcome(
  input: EditorProposalInput,
  projectFingerprint: string,
  audit: CandidateConstraintAudit,
  compiledPlan: CompiledNarrativeActionPlan,
  eligibility: SafeNoChangeEligibilityV1,
): EditorSafeNoChangeOutcomeV1 | undefined {
  const report = input.feasibilityReport;
  const set = input.constraintSet;
  const context = input.constraintContext;
  const resolutionId = context?.resolutionIds.at(-1);
  if (!report || !set || !context || !resolutionId
    || !eligibility.eligible
    || report.requestedDurationMs === null
    || report.minimumFeasibleDurationMs === null
    || report.remainingGapMs === null
    || audit.legalMutationCandidateCount !== 0
    || compiledPlan.status !== "VALIDATED"
    || compiledPlan.canonicalPlan.actions.length !== 0) return undefined;
  return Object.freeze({
    status: "SAFE_NO_CHANGE",
    intentVersionId: context.sourceIntentVersionId,
    constraintSetId: context.sourceConstraintSetId,
    constraintResolutionId: resolutionId,
    projectFingerprint,
    feasibilityRef: Object.freeze({
      reportId: report.reportId,
      requestedDurationMs: report.requestedDurationMs,
      minimumFeasibleDurationMs: report.minimumFeasibleDurationMs,
      remainingGapMs: report.remainingGapMs,
    }),
    requestedTargetMs: report.requestedDurationMs,
    minimumFeasibleDurationMs: report.minimumFeasibleDurationMs,
    remainingGapMs: report.remainingGapMs,
    protectedContentStatus: "PRESERVED",
    reasonCode: "NO_LEGAL_UNPROTECTED_EDITS",
    reason: `当前保护约束下没有可安全执行的进一步修改，现有 ${Math.round(input.project.durationMs / 1_000)} 秒已经是最接近目标的安全结果。`,
    evidence: Object.freeze({
      protectedConstraintIds: Object.freeze(set.activeConstraints.map((constraint) => constraint.constraintId)),
      protectedTimelineRangeCount: report.mergedProtectedTimelineRanges.length,
      blockedCandidateCount: audit.blockedCandidateCount,
      legalExecutableActionCount: 0,
      filteredCandidateIssues: audit.blockedIssues,
    }),
  });
}

/**
 * Production V2.1P handoff: current trusted state -> V2.0A -> V2.0B -> V2.0C.
 * It deliberately has no dependency on the V2.0D executor and never mutates input state.
 */
export function generateEditorProposal(input: EditorProposalInput): EditorProposalGenerationResult {
  let diagnosticStage: EditorAcceptanceDiagnosticStageV1 = "CONTEXT_VALIDATION";
  emitEditorProposalStageDiagnosticV1(diagnosticStage, "ENTERED");
  try {
    if (input.constraintContext && input.constraintContext.readiness !== "READY_TO_PLAN") {
      fail("NEGOTIATION_NOT_READY", "Constraint negotiation has not reached READY_TO_PLAN.");
    }
    if (Boolean(input.constraintSet) !== Boolean(input.constraintContext)
      || (input.constraintSet && input.constraintContext && (
        input.constraintSet.intentVersionId !== input.constraintContext.sourceIntentVersionId
        || input.constraintSet.constraintSetId !== input.constraintContext.sourceConstraintSetId
        || input.constraintSet.constraintFingerprint !== input.constraintContext.sourceConstraintFingerprint
      ))) {
      fail("NEGOTIATION_NOT_READY", "ConstraintSet and READY_TO_PLAN context must be supplied together with matching identities.");
    }
    if (input.feasibilityReport && (!input.constraintSet || !input.constraintContext
      || input.feasibilityReport.projectId !== input.project.id
      || input.feasibilityReport.evaluatedProjectFingerprint !== createEditorProjectFingerprint(input.project)
      || input.feasibilityReport.constraintSetId !== input.constraintSet.constraintSetId
      || input.feasibilityReport.constraintFingerprint !== input.constraintSet.constraintFingerprint
      || input.feasibilityReport.reportId !== input.constraintContext.feasibilityReportId)) {
      fail("NEGOTIATION_NOT_READY", "Feasibility evidence is stale or does not match the active planning context.");
    }
    if (input.sessionDecisionLedger && input.sessionDecisionLedger.projectId !== input.project.id) {
      fail("NEGOTIATION_NOT_READY", "Session decision ledger belongs to another project.");
    }
    const trustedProject = cloneProject(input.project);
    const projectFingerprint = createEditorProjectFingerprint(trustedProject);
    const trustedInput: EditorProposalInput = Object.freeze({ ...input, project: trustedProject });
    diagnosticStage = "SAFE_NO_CHANGE_ELIGIBILITY";
    const safeNoChangeAudit = safeNoChangeMutationAudit(trustedInput);
    const safeNoChangeEligibility = evaluateSafeNoChangeEligibilityV1(
      trustedInput,
      projectFingerprint,
      safeNoChangeAudit.legalMutationCandidateCount,
    );
    emitSafeNoChangeEligibilityDiagnosticV1(safeNoChangeEligibility);
    const compileAsSafeNoChange = safeNoChangeEligibility.eligible;
    if (!compileAsSafeNoChange) {
      diagnosticStage = "INTERVAL_BUILD";
      emitEditorProposalStageDiagnosticV1(diagnosticStage, "ENTERED");
    }
    const intervals = compileAsSafeNoChange
      ? Object.freeze([])
      : buildIntervals(trustedProject, input.captionConcepts,input.captionScopeIds);
    const { assets, semanticEvidence } = compileAsSafeNoChange
      ? { assets: Object.freeze([]), semanticEvidence: Object.freeze([]) }
      : buildAssets(trustedProject, input.videoAnalyses);
    if (!compileAsSafeNoChange) {
      diagnosticStage = "SEED_SLOT_BUILD";
      emitEditorProposalStageDiagnosticV1(diagnosticStage, "ENTERED");
    }
    const seedSlots = compileAsSafeNoChange
      ? Object.freeze([])
      : buildSeedSlots(trustedProject, intervals);
    if(input.captionScopeIds && seedSlots.some(slot=>{const interval=intervals.find(i=>i.id===slot.intervalId)!;return slot.timelineStartMs!==interval.timelineStartMs||slot.timelineEndMs!==interval.timelineEndMs;}))fail("SOURCE_RANGE_UNSUPPORTED","请先在精剪中按所选字幕起止分割目标片段。");
    const firstClip = seedSlots.length ? trustedProject.tracks.flatMap((track) => track.clips).find((clip) => clip.id === seedSlots[0].clipId) : undefined;
    if (!compileAsSafeNoChange) {
      diagnosticStage = "CANDIDATE_FILTER";
      emitEditorProposalStageDiagnosticV1(diagnosticStage, "ENTERED");
    }
    const strategyRankedCandidateSets = compileAsSafeNoChange
      ? Object.freeze([])
      : strategyCandidateTable(buildMultimodalCandidateTable({
        intervals,
        assets,
        ...(input.rhythm ? { rhythm: input.rhythm } : {}),
        ...(firstClip ? { previousAssetId: firstClip.assetId } : {}),
        assetUsage: usageContext(trustedProject),
      }), input.planningStrategy);
    const candidateAudit = compileAsSafeNoChange
      ? safeNoChangeAudit
      : constraintSafeCandidateTable(
        strategyRankedCandidateSets,
        seedSlots,
        trustedProject,
        input.constraintSet,
        input.constraintContext,
      );
    const rankedCandidateSets = candidateAudit.rankedCandidateSets;
    const unresolved = rankedCandidateSets.filter((set) => !set.selectedAssetId);
    if (unresolved.length && !compileAsSafeNoChange) {
      if (candidateAudit.blockedCandidateCount > 0) {
        fail("COMPILATION_REJECTED", "All proposed mutations were blocked by active hard constraints; safe no-change was not proven.", {
          intervalIds: Object.freeze(unresolved.map((set) => set.intervalId)),
        });
      }
      const status = unresolved.length === rankedCandidateSets.length ? "NO_VALID_CANDIDATE" : "UNRESOLVED_INTERVAL";
      fail(status, status === "NO_VALID_CANDIDATE" ? "没有候选素材通过 V2.0A 可信度门槛。" : "部分字幕区间没有候选素材通过 V2.0A 可信度门槛。", {
        intervalIds: Object.freeze(unresolved.map((set) => set.intervalId)),
      });
    }
    const narrativePlan = compileAsSafeNoChange
      ? emptySafeNoChangeNarrativePlan()
      : planNarrativeSequence({ intervals, rankedCandidateSets, semanticEvidence });
    if (narrativePlan.unresolvedIntervalIds.length) {
      fail("UNRESOLVED_INTERVAL", "叙事规划仍包含未解决区间。", { intervalIds: narrativePlan.unresolvedIntervalIds });
    }
    diagnosticStage = "COMPILER";
    emitEditorProposalStageDiagnosticV1(diagnosticStage, "ENTERED");
    const compiledPlan = compileNarrativeActionPlan({
      mode: "INITIAL_PLAN",
      narrativePlan,
      seedSlots: compileAsSafeNoChange ? Object.freeze([]) : seedSlots,
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
      const sourceRangeIds = compiledPlan.errors.filter((issue) => issue.code === "SOURCE_RANGE_PLACEMENT_LIMITATION").flatMap((issue) => issue.intervalId ? [issue.intervalId] : []);
      fail(sourceRangeIds.length ? "SOURCE_RANGE_UNSUPPORTED" : "COMPILATION_REJECTED",
        sourceRangeIds.length ? "建议需要当前编译器尚不支持的非零源片段定位。" : "建议未通过规范动作编译。",
        sourceRangeIds.length ? { intervalIds: Object.freeze(sourceRangeIds) } : undefined);
    }
    const noChangeOutcome = safeNoChangeOutcome(input, projectFingerprint, candidateAudit, compiledPlan, safeNoChangeEligibility);
    if (noChangeOutcome) {
      diagnosticStage = "SAFE_NO_CHANGE_SELECTED";
      emitEditorProposalStageDiagnosticV1(diagnosticStage, "SAFE_NO_CHANGE");
    }
    if (candidateAudit.blockedCandidateCount > 0
      && candidateAudit.legalMutationCandidateCount === 0
      && compiledPlan.canonicalPlan.actions.length === 0
      && !noChangeOutcome) {
      fail("COMPILATION_REJECTED", "Protected candidate actions were filtered, but the safe no-change proof was not satisfied.");
    }
    const planEvidence = createPlanEvidence({
      intervals: compileAsSafeNoChange ? Object.freeze([]) : intervals,
      rankedCandidateSets: compileAsSafeNoChange ? Object.freeze([]) : rankedCandidateSets,
      narrativePlan, compiledPlan, preExecutionProject: trustedProject,
      ...(input.constraintSet ? { constraintSet: input.constraintSet } : {}),
      ...(input.constraintContext ? { constraintContext: input.constraintContext } : {}),
    });
    const analyses = [...input.videoAnalyses].sort((left, right) => left.assetId.localeCompare(right.assetId));
    const bundle: EditorProposalBundle = Object.freeze({
      schemaVersion: EDITOR_PROPOSAL_SCHEMA_VERSION,
      proposalId: planEvidence.planId,
      status: noChangeOutcome ? "SAFE_NO_CHANGE" : "PENDING_REVIEW",
      sourceProjectFingerprint: planEvidence.summary.preProjectReference,
      matchingIntervals: intervals,
      rankedCandidateSets,
      narrativePlan,
      compiledPlan,
      trustedPreExecutionProject: trustedProject,
      planEvidence,
      proposalEntries: noChangeOutcome ? Object.freeze([]) : Object.freeze(planEvidence.entries.map((entry) => Object.freeze({
        proposalEntryId: entry.proposalEntryId,
        intervalId: entry.intervalId,
        ...(entry.compiledAction ? { actionIndex: entry.compiledAction.actionIndex, targetId: entry.compiledAction.targetId } : {}),
        ...(entry.selectedAssetId ? { selectedAssetId: entry.selectedAssetId } : {}),
        candidateAlternativeAssetIds: Object.freeze(entry.matching?.rejectedAlternatives.map((item) => item.assetId) ?? []),
      }))),
      evidenceMetadata: Object.freeze({
        videoAnalysisVersions: Object.freeze(analyses.map((analysis) => analysis.analysisVersion)),
        ...(input.rhythm ? { audioRhythmSourceId: input.rhythm.sourceId } : {}),
        ...(input.constraintContext ? { constraintContext: Object.freeze({
          ...input.constraintContext,
          resolutionIds: Object.freeze([...input.constraintContext.resolutionIds]),
        }) } : {}),
        providerCalls: 0,
        networkCalls: 0,
      }),
      ...(input.constraintSet ? { constraintSet: input.constraintSet } : {}),
      ...(input.sessionDecisionLedger ? { sessionDecisionLedger: input.sessionDecisionLedger } : {}),
      ...(noChangeOutcome ? { safeNoChangeOutcome: noChangeOutcome } : {}),
    });
    diagnosticStage = "RESULT_MAPPING";
    emitEditorProposalStageDiagnosticV1(
      diagnosticStage,
      noChangeOutcome ? "SAFE_NO_CHANGE" : "READY_FOR_REVIEW",
    );
    return Object.freeze({ ok: true, status: noChangeOutcome ? "READY_WITH_NO_CHANGES" : "READY_FOR_REVIEW", bundle });
  } catch (error) {
    if (error instanceof ControlledProposalFailure) {
      emitEditorProposalStageDiagnosticV1(diagnosticStage, "FAILED", error.code);
      return Object.freeze({ ok: false, status: error.code, message: error.message, ...error.details });
    }
    emitEditorProposalStageDiagnosticV1(diagnosticStage, "FAILED", "UNEXPECTED_INTERNAL_ERROR");
    return Object.freeze({ ok: false, status: "COMPILATION_REJECTED", message: "当前结构化状态未通过本地规划校验。" });
  }
}

export function isEditorProposalCurrent(
  bundle: EditorProposalBundle,
  project: EditorProject,
  constraintContext?: ProposalConstraintContextV1,
): boolean {
  return bundle.sourceProjectFingerprint === createEditorProjectFingerprint(project)
    && isProposalConstraintContextCurrentV1(bundle.evidenceMetadata.constraintContext, constraintContext);
}
