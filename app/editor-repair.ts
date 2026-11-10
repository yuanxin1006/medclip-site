import { cloneProject, type EditorProject, type TimelineClip } from "./editor-core.ts";
import { parseAIEditingPlan, type EditorAIPlanAction } from "./editor-ai-requirements.ts";
import {
  executeCompiledNarrativeActionPlan,
  type CompiledPlanExecutionInput,
  type CompiledPlanExecutionResult,
} from "./editor-compiled-plan-execution.ts";
import type { CompiledNarrativeActionPlan, IntervalActionLink } from "./editor-narrative-action-compiler.ts";
import {
  evaluateEditorExecution,
  type EditorEvaluationInput,
  type EditorEvaluationReport,
  type EvaluationDefect,
  type EvaluationMetric,
} from "./editor-evaluator.ts";
import {
  candidateClearsMatchingThresholds,
  type CandidateMatchScore,
} from "./editor-multimodal-matching.ts";
import {
  createEditorProjectFingerprint,
  parsePlanEvidence,
  type PlanEvidence,
  type PlanEvidenceEntry,
} from "./editor-plan-evidence.ts";
import type { EditorProposalBundle, EditorProposalEntryReference } from "./editor-proposal-orchestrator.ts";
import type {
  HumanReviewState,
  ReviewedCompiledPlan,
  ReviewedEntryAction,
} from "./editor-proposal-review.ts";
import type { AudioRhythmAnalysis } from "./editor-audio-rhythm.ts";
import type { VideoSemanticAnalysis } from "./editor-video-semantic.ts";
import type { ConstraintSetV1 } from "./editor-constraints.ts";
import type { ConstraintResolutionPolicyV1, SessionDecisionLedgerV1 } from "./editor-constraint-negotiation.ts";
import {
  enforceEditorActionConstraintsV1,
  isRejectedSemanticActionV1,
  type ConstraintContextExpectationV1,
} from "./editor-constraint-enforcement.ts";

export const EDITOR_REPAIR_SCHEMA_VERSION = 1 as const;
export const CLOSED_LOOP_REPAIR_SCHEMA_VERSION = 1 as const;
export const MAX_REPAIR_ROUNDS = 1 as const;
export const MAX_REPAIR_ACTIONS = 6 as const;

export type RepairProposalStatus = "REPAIR_PROPOSED" | "REPAIR_NO_ACTIONS" | "REPAIR_MANUAL_REQUIRED";
export type RepairEligibilityStatus =
  | "ELIGIBLE"
  | "UNSUPPORTED"
  | "HUMAN_PROTECTED"
  | "USER_REJECTED"
  | "NO_TRUSTED_ALTERNATIVE"
  | "DUPLICATE_TARGET_CONFLICT"
  | "ALREADY_ATTEMPTED"
  | "ACTION_LIMIT_EXCEEDED"
  | "HARD_CONSTRAINT_BLOCKED"
  | "SESSION_REJECTED";
export type RepairStrategy =
  | "REAPPLY_REVIEWED_MATCH"
  | "BETTER_SEMANTIC_MATCH"
  | "REDUCE_REPETITION"
  | "REPORT_ONLY";
export type RepairHumanProtection = "NOT_PROTECTED" | "HUMAN_PROTECTED_AUTO_REPAIR_BLOCKED";

export type RepairAlternative = Readonly<{
  assetId: string;
  assetName: string;
  semanticScore: number;
  usabilityScore: number;
  timingScore: number;
  repetitionPenalty: number;
  totalScore: number;
  supportingSegmentIds: readonly string[];
}>;

export type RepairActionTuple = Readonly<{
  targetId: string;
  actionType: "MATCH_ASSET_TO_SEGMENT";
  assetId: string;
}>;

export type RepairProposalEntry = Readonly<{
  repairEntryId: string;
  defectId: string;
  defectCode: EvaluationDefect["code"];
  metric: EvaluationMetric;
  severity: EvaluationDefect["severity"];
  intervalId?: string;
  clipId?: string;
  currentObservedState: Readonly<{
    assetId?: string;
    metricValue: string;
  }>;
  desiredState: Readonly<{
    assetId?: string;
    metricValue: string;
  }>;
  strategy: RepairStrategy;
  proposedAction?: Readonly<EditorAIPlanAction>;
  trustedAlternatives: readonly RepairAlternative[];
  repairEligibility: RepairEligibilityStatus;
  humanProtection: RepairHumanProtection;
  originalReviewDecision?: "ACCEPTED" | "REJECTED" | "MODIFIED";
  reason: string;
  evidence: EvaluationDefect["evidence"];
  attemptedTuple?: RepairActionTuple;
}>;

export type RepairProposalBundle = Readonly<{
  schemaVersion: typeof EDITOR_REPAIR_SCHEMA_VERSION;
  repairProposalId: string;
  sourceEvaluationId: string;
  sourceProjectFingerprint: string;
  repairRound: typeof MAX_REPAIR_ROUNDS;
  status: RepairProposalStatus;
  entries: readonly RepairProposalEntry[];
  attemptedRepairFingerprint: string;
  attemptedRepairTuples: readonly RepairActionTuple[];
  sourceProposal: EditorProposalBundle;
  sourceHumanReview: HumanReviewState;
  sourceReviewedPlan: ReviewedCompiledPlan;
  sourceExecution?: CompiledPlanExecutionResult;
  sourcePlanEvidence: PlanEvidence;
  trustedPreRepairProject: EditorProject;
  videoSemanticEvidence: readonly VideoSemanticAnalysis[];
  audioRhythmEvidence?: AudioRhythmAnalysis;
  constraintSet?: ConstraintSetV1;
  constraintContext?: ConstraintContextExpectationV1;
  resolvedDurationPolicy?: ConstraintResolutionPolicyV1;
  sessionDecisionLedger?: SessionDecisionLedgerV1;
  providerCalls: 0;
  networkCalls: 0;
}>;

export type RepairReviewEntryStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "MODIFIED" | "NOT_ACTIONABLE";
export type RepairReviewLifecycle =
  | "REPAIR_PROPOSED"
  | "REPAIR_REVIEW_IN_PROGRESS"
  | "REPAIR_READY_TO_EXECUTE"
  | "REPAIR_REJECTED"
  | "REPAIR_NO_ACTIONS"
  | "REPAIR_EXECUTED"
  | "REPAIR_ROLLED_BACK";

export type RepairReviewEntry = Readonly<{
  repairEntryId: string;
  status: RepairReviewEntryStatus;
  provenance?: "REPAIR_USER_ACCEPTED" | "REPAIR_USER_REJECTED" | "REPAIR_USER_MODIFIED";
  selectedAssetId?: string;
}>;

export type RepairReviewState = Readonly<{
  schemaVersion: typeof EDITOR_REPAIR_SCHEMA_VERSION;
  repairProposalId: string;
  lifecycle: RepairReviewLifecycle;
  entries: readonly RepairReviewEntry[];
}>;

export type RepairReviewDecision = Readonly<{
  repairEntryId: string;
  decision: "ACCEPT" | "REJECT" | "MODIFY";
  selectedAssetId?: string;
}>;

export type ReviewedRepairPlan = Readonly<{
  schemaVersion: typeof EDITOR_REPAIR_SCHEMA_VERSION;
  repairProposalId: string;
  sourceProjectFingerprint: string;
  status: "REPAIR_READY_TO_EXECUTE" | "REPAIR_NO_ACTIONS";
  compiledPlan: CompiledNarrativeActionPlan;
  reviewedEntries: readonly Readonly<{
    repairEntryId: string;
    defectId: string;
    intervalId?: string;
    decision: "ACCEPTED" | "REJECTED" | "MODIFIED";
    originalAssetId?: string;
    selectedAssetId?: string;
    reviewedActionIndex?: number;
    action?: Readonly<EditorAIPlanAction>;
    provenance: "REPAIR_USER_ACCEPTED" | "REPAIR_USER_REJECTED" | "REPAIR_USER_MODIFIED";
  }>[];
}>;

export type RepairComparison = Readonly<{
  targetedDefects: readonly Readonly<{
    defectId: string;
    metric: EvaluationMetric;
    before: string;
    after: string;
    outcome: "RESOLVED" | "IMPROVED" | "UNCHANGED" | "WORSENED";
  }>[];
  allTargetsResolved: boolean;
  everyTargetImproved: boolean;
  newStructuralFail: boolean;
  protectedStateRegression: boolean;
  humanProtectedDecisionViolated: boolean;
  safeToKeep: boolean;
}>;

export type ClosedLoopFinalStatus =
  | "REPAIR_FINAL_PASS"
  | "REPAIR_FINAL_UNRESOLVED_IMPROVED"
  | "REPAIR_FINAL_UNRESOLVED"
  | "REPAIR_ROLLED_BACK"
  | "REPAIR_NO_ACTIONS";

export type ClosedLoopRepairResult = Readonly<{
  schemaVersion: typeof CLOSED_LOOP_REPAIR_SCHEMA_VERSION;
  originalEvaluation: EditorEvaluationReport;
  repairProposal: RepairProposalBundle;
  repairReview: RepairReviewState;
  reviewedRepairPlan?: ReviewedRepairPlan;
  repairExecution?: CompiledPlanExecutionResult;
  reEvaluation?: EditorEvaluationReport;
  reEvaluationCount: 0 | 1;
  comparison?: RepairComparison;
  rollback: Readonly<{
    performed: boolean;
    targetProjectFingerprint: string;
    reason?: string;
  }>;
  finalProject: EditorProject;
  finalProjectFingerprint: string;
  finalStatus: ClosedLoopFinalStatus;
  history: Readonly<{
    shouldRecord: boolean;
    entryCount: 0 | 1;
    undoProject?: EditorProject;
    redoProject?: EditorProject;
  }>;
  evidence: Readonly<{
    initialProposalId: string;
    initialReviewProposalId: string;
    initialEvaluationId: string;
    repairProposalId: string;
    repairReviewLifecycle: RepairReviewLifecycle;
    repairExecutionFingerprint?: string;
    reEvaluationId?: string;
    finalStatus: ClosedLoopFinalStatus;
  }>;
}>;

export type CreateRepairProposalInput = Readonly<{
  evaluation: EditorEvaluationReport;
  proposal: EditorProposalBundle;
  humanReview: HumanReviewState;
  reviewedPlan: ReviewedCompiledPlan;
  execution?: CompiledPlanExecutionResult;
  planEvidence: PlanEvidence;
  currentProject: EditorProject;
  videoSemanticEvidence: readonly VideoSemanticAnalysis[];
  audioRhythmEvidence?: AudioRhythmAnalysis;
  repairRound?: number;
  previouslyAttemptedTuples?: readonly RepairActionTuple[];
  constraintSet?: ConstraintSetV1;
  resolvedDurationPolicy?: ConstraintResolutionPolicyV1;
  sessionDecisionLedger?: SessionDecisionLedgerV1;
}>;

export class EditorRepairError extends Error {
  readonly code:
    | "INVALID_SOURCE"
    | "INVALID_REPAIR_ROUND"
    | "REVIEW_FINALIZED"
    | "ENTRY_NOT_FOUND"
    | "INVALID_DECISION"
    | "INVALID_ALTERNATIVE"
    | "PENDING_ENTRIES"
    | "STALE_REPAIR";

  constructor(code: EditorRepairError["code"], message: string) {
    super(message);
    this.name = "EditorRepairError";
    this.code = code;
  }
}

function fail(code: EditorRepairError["code"], message: string): never {
  throw new EditorRepairError(code, message);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193) >>> 0;
  }
  return result.toString(16).padStart(8, "0");
}

function clipMap(project: EditorProject): ReadonlyMap<string, TimelineClip> {
  return new Map(project.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]));
}

function tupleKey(tuple: RepairActionTuple): string {
  return `${tuple.targetId}\u0000${tuple.actionType}\u0000${tuple.assetId}`;
}

function originalDecision(
  input: CreateRepairProposalInput,
  intervalId: string | undefined,
): HumanReviewState["entries"][number] | undefined {
  if (!intervalId) return undefined;
  return input.humanReview.entries.find((entry) => entry.intervalId === intervalId);
}

function originalReviewed(
  input: CreateRepairProposalInput,
  intervalId: string | undefined,
): ReviewedEntryAction | undefined {
  if (!intervalId) return undefined;
  return input.reviewedPlan.reviewedEntries.find((entry) => entry.intervalId === intervalId);
}

function safeCandidates(input: CreateRepairProposalInput, defect: EvaluationDefect): readonly CandidateMatchScore[] {
  if (!defect.intervalId) return Object.freeze([]);
  const projectAssets = new Set(input.currentProject.assets.map((asset) => asset.id));
  const set = input.proposal.rankedCandidateSets.find((item) => item.intervalId === defect.intervalId);
  return Object.freeze((set?.candidates ?? []).filter((candidate) =>
    projectAssets.has(candidate.assetId)
    && candidate.assetId !== defect.assetId
    && candidateClearsMatchingThresholds(candidate)
    && !candidate.sourceRangePlacementLimitation));
}

function alternativeView(input: CreateRepairProposalInput, candidate: CandidateMatchScore): RepairAlternative {
  return Object.freeze({
    assetId: candidate.assetId,
    assetName: input.currentProject.assets.find((asset) => asset.id === candidate.assetId)?.name ?? candidate.assetId,
    semanticScore: candidate.semanticScore,
    usabilityScore: candidate.usabilityScore,
    timingScore: candidate.timingScore,
    repetitionPenalty: candidate.repetitionPenalty,
    totalScore: candidate.totalScore,
    supportingSegmentIds: Object.freeze([...candidate.supportingSegmentIds]),
  });
}

function compareSemantic(left: CandidateMatchScore, right: CandidateMatchScore): number {
  return right.semanticScore - left.semanticScore
    || right.totalScore - left.totalScore
    || right.usabilityScore - left.usabilityScore
    || right.timingScore - left.timingScore
    || left.repetitionPenalty - right.repetitionPenalty
    || left.assetId.localeCompare(right.assetId);
}

function orderedVisualClips(project: EditorProject): readonly TimelineClip[] {
  return Object.freeze(project.tracks
    .filter((track) => track.type === "video" || track.type === "broll")
    .flatMap((track) => track.clips)
    .sort((left, right) => left.timelineStartMs - right.timelineStartMs
      || left.timelineEndMs - right.timelineEndMs
      || left.id.localeCompare(right.id)));
}

function repetitionCost(clips: readonly TimelineClip[], targetId: string, assetId: string): number {
  const index = clips.findIndex((clip) => clip.id === targetId);
  if (index < 0) return Number.POSITIVE_INFINITY;
  const sequence = clips.map((clip, position) => position === index ? assetId : clip.assetId);
  let cost = 0;
  if (index > 0 && sequence[index - 1] === assetId) cost += 4;
  if (index + 1 < sequence.length && sequence[index + 1] === assetId) cost += 4;
  if (index > 1 && sequence[index - 2] === assetId) cost += 2;
  if (index + 2 < sequence.length && sequence[index + 2] === assetId) cost += 2;
  const recentStart = Math.max(0, index - 3);
  for (let position = recentStart; position < index; position += 1) if (sequence[position] === assetId) cost += 1;
  return cost;
}

function compareRepetition(
  clips: readonly TimelineClip[],
  targetId: string,
  left: CandidateMatchScore,
  right: CandidateMatchScore,
): number {
  return repetitionCost(clips, targetId, left.assetId) - repetitionCost(clips, targetId, right.assetId)
    || compareSemantic(left, right);
}

function intendedCandidate(input: CreateRepairProposalInput, defect: EvaluationDefect): CandidateMatchScore | undefined {
  const reviewed = originalReviewed(input, defect.intervalId);
  const intendedAssetId = reviewed?.selectedAssetId ?? reviewed?.action?.assetId ?? defect.assetId;
  return input.proposal.rankedCandidateSets.find((set) => set.intervalId === defect.intervalId)
    ?.candidates.find((candidate) => candidate.assetId === intendedAssetId
      && candidateClearsMatchingThresholds(candidate)
      && !candidate.sourceRangePlacementLimitation);
}

function targetClipId(input: CreateRepairProposalInput, defect: EvaluationDefect): string | undefined {
  return defect.clipId
    ?? originalReviewed(input, defect.intervalId)?.action?.targetId
    ?? input.proposal.proposalEntries.find((entry) => entry.intervalId === defect.intervalId)?.targetId;
}

function actionFor(
  input: CreateRepairProposalInput,
  defect: EvaluationDefect,
  strategy: RepairStrategy,
  candidate: CandidateMatchScore,
): EditorAIPlanAction | undefined {
  const targetId = targetClipId(input, defect);
  const clip = targetId ? clipMap(input.currentProject).get(targetId) : undefined;
  if (!clip) return undefined;
  return Object.freeze({
    type: "MATCH_ASSET_TO_SEGMENT",
    targetId: clip.id,
    assetId: candidate.assetId,
    startSeconds: clip.timelineStartMs / 1_000,
    endSeconds: clip.timelineEndMs / 1_000,
    reason: `${strategy} from trusted evaluation defect ${defect.id}.`,
  });
}

function repairActionBlockReason(
  input: CreateRepairProposalInput,
  action: EditorAIPlanAction,
): "HARD_CONSTRAINT_BLOCKED" | "SESSION_REJECTED" | undefined {
  const constraintSet = input.constraintSet ?? input.proposal.constraintSet;
  const sourceContext = input.proposal.evidenceMetadata.constraintContext;
  const context = sourceContext ? {
    intentVersionId: sourceContext.sourceIntentVersionId,
    constraintSetId: sourceContext.sourceConstraintSetId,
    constraintFingerprint: sourceContext.sourceConstraintFingerprint,
  } : constraintSet ? {
    intentVersionId: constraintSet.intentVersionId,
    constraintSetId: constraintSet.constraintSetId,
    constraintFingerprint: constraintSet.constraintFingerprint,
  } : undefined;
  const enforcement = enforceEditorActionConstraintsV1({
    project: input.currentProject,
    constraintSet,
    expectedContext: context,
    action,
  });
  if (enforcement.status !== "ALLOWED") return "HARD_CONSTRAINT_BLOCKED";
  const intentVersionId = context?.intentVersionId;
  const ledger = input.sessionDecisionLedger ?? input.proposal.sessionDecisionLedger;
  if (intentVersionId && isRejectedSemanticActionV1({
    projectId: input.currentProject.id,
    intentVersionId,
    action,
    rejectedOperationTuples: ledger?.rejectedProposalOperationTuples,
  })) return "SESSION_REJECTED";
  return undefined;
}

type EntryDraft = Omit<RepairProposalEntry, "repairEntryId">;

function unsupportedEntry(
  input: CreateRepairProposalInput,
  defect: EvaluationDefect,
  eligibility: RepairEligibilityStatus,
  reason: string,
): EntryDraft {
  const decision = originalDecision(input, defect.intervalId);
  return {
    defectId: defect.id,
    defectCode: defect.code,
    metric: defect.metric,
    severity: defect.severity,
    ...(defect.intervalId ? { intervalId: defect.intervalId } : {}),
    ...(defect.clipId ? { clipId: defect.clipId } : {}),
    currentObservedState: Object.freeze({ ...(defect.assetId ? { assetId: defect.assetId } : {}), metricValue: defect.observed }),
    desiredState: Object.freeze({ metricValue: defect.expected }),
    strategy: "REPORT_ONLY",
    trustedAlternatives: Object.freeze([]),
    repairEligibility: eligibility,
    humanProtection: eligibility === "HUMAN_PROTECTED"
      ? "HUMAN_PROTECTED_AUTO_REPAIR_BLOCKED"
      : "NOT_PROTECTED",
    ...(decision?.status && decision.status !== "PENDING" ? { originalReviewDecision: decision.status } : {}),
    reason,
    evidence: defect.evidence,
  };
}

function draftForDefect(input: CreateRepairProposalInput, defect: EvaluationDefect): EntryDraft {
  const decision = originalDecision(input, defect.intervalId);
  if (decision?.status === "REJECTED") {
    return unsupportedEntry(input, defect, "USER_REJECTED", "The original user-rejected entry cannot be resurrected by repair.");
  }
  if (defect.repairEligibility === "HUMAN_DECISION_PROTECTED") {
    return unsupportedEntry(input, defect, "HUMAN_PROTECTED", "HUMAN_PROTECTED_AUTO_REPAIR_BLOCKED");
  }
  if (defect.severity === "NOT_EVALUABLE") {
    return unsupportedEntry(input, defect, "UNSUPPORTED", "Insufficient evidence is report-only and cannot be repaired deterministically.");
  }
  if (defect.metric === "RHYTHM_ALIGNMENT") {
    return unsupportedEntry(input, defect, "UNSUPPORTED", "Rhythm warnings are report-only because the canonical action surface has no unambiguous cut-movement repair.");
  }
  if (defect.metric === "NARRATIVE_CONTINUITY") {
    return unsupportedEntry(input, defect, "UNSUPPORTED", "No trusted alternative proves a bounded narrative improvement without speculative replanning.");
  }
  const targetId = targetClipId(input, defect);
  if (!targetId || !clipMap(input.currentProject).has(targetId)) {
    return unsupportedEntry(input, defect, "UNSUPPORTED", "The repair target is missing from the authoritative project.");
  }
  const candidates = safeCandidates(input, defect);
  let strategy: RepairStrategy;
  let ranked: readonly CandidateMatchScore[];
  if (defect.code === "INTENDED_STATE_NOT_REALIZED") {
    strategy = "REAPPLY_REVIEWED_MATCH";
    const intended = intendedCandidate(input, defect);
    ranked = intended ? Object.freeze([intended, ...candidates.filter((candidate) => candidate.assetId !== intended.assetId)]) : Object.freeze([]);
  } else if (defect.code === "LOW_SEMANTIC_SUPPORT") {
    strategy = "BETTER_SEMANTIC_MATCH";
    const before = Number(defect.observed);
    ranked = Object.freeze([...candidates].filter((candidate) => !Number.isFinite(before) || candidate.semanticScore > before).sort(compareSemantic));
  } else if (["IMMEDIATE_ASSET_REPEAT", "ABA_ASSET_OSCILLATION", "RECENT_ASSET_REUSE"].includes(defect.code)) {
    strategy = "REDUCE_REPETITION";
    const clips = orderedVisualClips(input.currentProject);
    const currentCost = repetitionCost(clips, targetId, defect.assetId ?? clipMap(input.currentProject).get(targetId)!.assetId);
    ranked = Object.freeze([...candidates]
      .filter((candidate) => repetitionCost(clips, targetId, candidate.assetId) < currentCost)
      .sort((left, right) => compareRepetition(clips, targetId, left, right)));
  } else {
    return unsupportedEntry(input, defect, "UNSUPPORTED", "This typed defect has no deterministic V2.2B repair strategy.");
  }
  const unfilteredRanked = ranked;
  ranked = Object.freeze(ranked.filter((candidate) => {
    const action = actionFor(input, defect, strategy, candidate);
    return Boolean(action && !repairActionBlockReason(input, action));
  }));
  const selected = ranked[0];
  if (!selected) {
    const firstAction = unfilteredRanked[0] ? actionFor(input, defect, strategy, unfilteredRanked[0]) : undefined;
    const blockReason = firstAction ? repairActionBlockReason(input, firstAction) : undefined;
    if (blockReason) {
      return unsupportedEntry(
        input,
        defect,
        blockReason,
        blockReason === "SESSION_REJECTED"
          ? "The same user-rejected semantic operation cannot be resurrected."
          : "All otherwise eligible repair candidates violate an active hard constraint.",
      );
    }
    return unsupportedEntry(input, defect, "NO_TRUSTED_ALTERNATIVE", "No original V2.0A candidate safely improves the failing metric.");
  }
  const action = actionFor(input, defect, strategy, selected);
  if (!action?.assetId) return unsupportedEntry(input, defect, "UNSUPPORTED", "The canonical repair action could not be constructed safely.");
  const alternatives = Object.freeze(ranked.map((candidate) => alternativeView(input, candidate)));
  return {
    defectId: defect.id,
    defectCode: defect.code,
    metric: defect.metric,
    severity: defect.severity,
    ...(defect.intervalId ? { intervalId: defect.intervalId } : {}),
    clipId: targetId,
    currentObservedState: Object.freeze({ ...(defect.assetId ? { assetId: defect.assetId } : {}), metricValue: defect.observed }),
    desiredState: Object.freeze({ assetId: selected.assetId, metricValue: defect.expected }),
    strategy,
    proposedAction: action,
    trustedAlternatives: alternatives,
    repairEligibility: "ELIGIBLE",
    humanProtection: "NOT_PROTECTED",
    ...(decision?.status && decision.status !== "PENDING" ? { originalReviewDecision: decision.status } : {}),
    reason: strategy === "REAPPLY_REVIEWED_MATCH"
      ? "Reapply the trusted human-reviewed asset assignment."
      : strategy === "BETTER_SEMANTIC_MATCH"
        ? "Use the strongest threshold-clearing original candidate with better semantic evidence."
        : "Use an original threshold-clearing candidate that deterministically reduces the bounded repetition pattern.",
    evidence: defect.evidence,
    attemptedTuple: Object.freeze({ targetId, actionType: "MATCH_ASSET_TO_SEGMENT", assetId: action.assetId }),
  };
}

const METRIC_PRIORITY: Readonly<Record<EvaluationMetric, number>> = Object.freeze({
  HARD_CONSTRAINT_COMPLIANCE: 0,
  REQUIREMENT_COMPLETION: 1,
  SEMANTIC_MATCH: 2,
  REPETITION: 3,
  NARRATIVE_CONTINUITY: 4,
  RHYTHM_ALIGNMENT: 5,
  PRESERVATION: 6,
});

function orderedDefects(defects: readonly EvaluationDefect[]): readonly EvaluationDefect[] {
  return Object.freeze([...defects].sort((left, right) =>
    (left.severity === "FAIL" ? 0 : left.severity === "WARNING" ? 1 : 2)
    - (right.severity === "FAIL" ? 0 : right.severity === "WARNING" ? 1 : 2)
    || METRIC_PRIORITY[left.metric] - METRIC_PRIORITY[right.metric]
    || (left.intervalId ?? "").localeCompare(right.intervalId ?? "")
    || left.id.localeCompare(right.id)));
}

function validateSource(input: CreateRepairProposalInput, repairRound: number): void {
  if (repairRound !== MAX_REPAIR_ROUNDS) fail("INVALID_REPAIR_ROUND", "Only repairRound = 1 is valid; repair-of-repair is forbidden.");
  const fingerprint = createEditorProjectFingerprint(input.currentProject);
  if (input.evaluation.sourceProposalId !== input.proposal.proposalId
    || input.evaluation.postProjectFingerprint !== fingerprint
    || input.humanReview.proposalId !== input.proposal.proposalId
    || input.reviewedPlan.proposalId !== input.proposal.proposalId
    || parsePlanEvidence(input.planEvidence).planId !== input.proposal.proposalId
    || input.currentProject.id !== input.proposal.trustedPreExecutionProject.id) {
    fail("INVALID_SOURCE", "Repair sources do not describe one authoritative evaluated project.");
  }
  const constraintSet = input.constraintSet ?? input.proposal.constraintSet;
  if (constraintSet && (constraintSet.projectId !== input.currentProject.id
    || input.proposal.constraintSet && input.proposal.constraintSet.constraintSetId !== constraintSet.constraintSetId)) {
    fail("INVALID_SOURCE", "Repair ConstraintSet does not match the authoritative project/proposal.");
  }
  const ledger = input.sessionDecisionLedger ?? input.proposal.sessionDecisionLedger;
  if (ledger && ledger.projectId !== input.currentProject.id) {
    fail("INVALID_SOURCE", "Repair session decision ledger belongs to another project.");
  }
}

export function createRepairProposalBundle(input: CreateRepairProposalInput): RepairProposalBundle {
  const repairRound = input.repairRound ?? MAX_REPAIR_ROUNDS;
  validateSource(input, repairRound);
  const attemptedKeys = new Set((input.previouslyAttemptedTuples ?? []).map(tupleKey));
  const claimedTargets = new Set<string>();
  let drafts = orderedDefects(input.evaluation.defects).map((defect) => draftForDefect(input, defect));
  drafts = drafts.map((draft) => {
    if (draft.repairEligibility !== "ELIGIBLE" || !draft.attemptedTuple) return draft;
    if (attemptedKeys.has(tupleKey(draft.attemptedTuple))) {
      return { ...draft, proposedAction: undefined, attemptedTuple: undefined, repairEligibility: "ALREADY_ATTEMPTED" as const, reason: "The same target/action/value tuple was already attempted in this closed loop." };
    }
    if (claimedTargets.has(draft.attemptedTuple.targetId)) {
      return { ...draft, proposedAction: undefined, attemptedTuple: undefined, repairEligibility: "DUPLICATE_TARGET_CONFLICT" as const, reason: "A higher-priority defect already owns the single allowed mutation for this target." };
    }
    claimedTargets.add(draft.attemptedTuple.targetId);
    return draft;
  });
  const actionableCount = drafts.filter((entry) => entry.repairEligibility === "ELIGIBLE").length;
  if (actionableCount > MAX_REPAIR_ACTIONS) {
    drafts = drafts.map((draft) => draft.repairEligibility === "ELIGIBLE"
      ? { ...draft, proposedAction: undefined, attemptedTuple: undefined, repairEligibility: "ACTION_LIMIT_EXCEEDED" as const, reason: `More than ${MAX_REPAIR_ACTIONS} mutations are required; the batch failed closed for manual handling.` }
      : draft);
  }
  const entries = Object.freeze(drafts.map((draft) => Object.freeze({
    ...draft,
    repairEntryId: `repair-entry-${hash(stable({ sourceEvaluationId: input.evaluation.evaluationId, defectId: draft.defectId, strategy: draft.strategy }))}`,
  })));
  const tuples = Object.freeze(entries.flatMap((entry) => entry.attemptedTuple ? [entry.attemptedTuple] : []));
  const material = {
    sourceEvaluationId: input.evaluation.evaluationId,
    sourceProjectFingerprint: input.evaluation.postProjectFingerprint,
    repairRound,
    defects: entries.map((entry) => entry.defectId),
    tuples,
  };
  const repairProposalId = `repair-${hash(stable(material))}`;
  const status: RepairProposalStatus = actionableCount > MAX_REPAIR_ACTIONS
    ? "REPAIR_MANUAL_REQUIRED"
    : tuples.length ? "REPAIR_PROPOSED" : "REPAIR_NO_ACTIONS";
  const constraintSet = input.constraintSet ?? input.proposal.constraintSet;
  const sourceContext = input.proposal.evidenceMetadata.constraintContext;
  const constraintContext: ConstraintContextExpectationV1 | undefined = constraintSet ? Object.freeze(sourceContext ? {
    intentVersionId: sourceContext.sourceIntentVersionId,
    constraintSetId: sourceContext.sourceConstraintSetId,
    constraintFingerprint: sourceContext.sourceConstraintFingerprint,
  } : {
    intentVersionId: constraintSet.intentVersionId,
    constraintSetId: constraintSet.constraintSetId,
    constraintFingerprint: constraintSet.constraintFingerprint,
  }) : undefined;
  return Object.freeze({
    schemaVersion: EDITOR_REPAIR_SCHEMA_VERSION,
    repairProposalId,
    sourceEvaluationId: input.evaluation.evaluationId,
    sourceProjectFingerprint: input.evaluation.postProjectFingerprint,
    repairRound: MAX_REPAIR_ROUNDS,
    status,
    entries,
    attemptedRepairFingerprint: `repair-attempt-${hash(stable(material))}`,
    attemptedRepairTuples: tuples,
    sourceProposal: input.proposal,
    sourceHumanReview: input.humanReview,
    sourceReviewedPlan: input.reviewedPlan,
    ...(input.execution ? { sourceExecution: input.execution } : {}),
    sourcePlanEvidence: input.planEvidence,
    trustedPreRepairProject: cloneProject(input.currentProject),
    videoSemanticEvidence: Object.freeze([...input.videoSemanticEvidence]),
    ...(input.audioRhythmEvidence ? { audioRhythmEvidence: input.audioRhythmEvidence } : {}),
    ...(constraintSet ? { constraintSet, constraintContext } : {}),
    ...(input.resolvedDurationPolicy ? { resolvedDurationPolicy: input.resolvedDurationPolicy } : {}),
    ...((input.sessionDecisionLedger ?? input.proposal.sessionDecisionLedger) ? { sessionDecisionLedger: input.sessionDecisionLedger ?? input.proposal.sessionDecisionLedger } : {}),
    providerCalls: 0,
    networkCalls: 0,
  });
}

function reviewLifecycle(entries: readonly RepairReviewEntry[]): RepairReviewLifecycle {
  const actionable = entries.filter((entry) => entry.status !== "NOT_ACTIONABLE");
  if (!actionable.length) return "REPAIR_NO_ACTIONS";
  const pending = actionable.filter((entry) => entry.status === "PENDING").length;
  if (pending === actionable.length) return "REPAIR_PROPOSED";
  if (pending > 0) return "REPAIR_REVIEW_IN_PROGRESS";
  if (actionable.every((entry) => entry.status === "REJECTED")) return "REPAIR_REJECTED";
  return "REPAIR_READY_TO_EXECUTE";
}

export function createRepairReviewState(proposal: RepairProposalBundle): RepairReviewState {
  const entries = Object.freeze(proposal.entries.map((entry) => Object.freeze({
    repairEntryId: entry.repairEntryId,
    status: entry.repairEligibility === "ELIGIBLE" ? "PENDING" as const : "NOT_ACTIONABLE" as const,
  })));
  return Object.freeze({
    schemaVersion: EDITOR_REPAIR_SCHEMA_VERSION,
    repairProposalId: proposal.repairProposalId,
    lifecycle: reviewLifecycle(entries),
    entries,
  });
}

function validateRepairReview(proposal: RepairProposalBundle, review: RepairReviewState): void {
  if (review.schemaVersion !== EDITOR_REPAIR_SCHEMA_VERSION || review.repairProposalId !== proposal.repairProposalId
    || review.entries.length !== proposal.entries.length
    || review.entries.some((entry, index) => entry.repairEntryId !== proposal.entries[index].repairEntryId)) {
    fail("INVALID_SOURCE", "Repair review does not belong to this deterministic repair proposal.");
  }
  if (["REPAIR_EXECUTED", "REPAIR_ROLLED_BACK"].includes(review.lifecycle)) fail("REVIEW_FINALIZED", "Finalized repair review cannot be changed.");
  if (review.lifecycle !== reviewLifecycle(review.entries)) fail("INVALID_DECISION", "Repair review lifecycle does not match its entry decisions.");
}

export function reviewRepairEntry(
  proposal: RepairProposalBundle,
  review: RepairReviewState,
  decision: RepairReviewDecision,
): RepairReviewState {
  validateRepairReview(proposal, review);
  const source = proposal.entries.find((entry) => entry.repairEntryId === decision.repairEntryId);
  if (!source) fail("ENTRY_NOT_FOUND", "Repair entry was not found.");
  if (source.repairEligibility !== "ELIGIBLE" || !source.proposedAction) fail("INVALID_DECISION", "Report-only repair entries cannot be approved.");
  let replacement: RepairReviewEntry;
  if (decision.decision === "ACCEPT") {
    if (decision.selectedAssetId !== undefined) fail("INVALID_DECISION", "Accept cannot replace the proposed asset.");
    replacement = Object.freeze({ repairEntryId: source.repairEntryId, status: "ACCEPTED", provenance: "REPAIR_USER_ACCEPTED" });
  } else if (decision.decision === "REJECT") {
    if (decision.selectedAssetId !== undefined) fail("INVALID_DECISION", "Reject cannot select an asset.");
    replacement = Object.freeze({ repairEntryId: source.repairEntryId, status: "REJECTED", provenance: "REPAIR_USER_REJECTED" });
  } else if (decision.decision === "MODIFY") {
    const trustedCandidate = proposal.sourceProposal.rankedCandidateSets
      .find((set) => set.intervalId === source.intervalId)?.candidates
      .find((candidate) => candidate.assetId === decision.selectedAssetId);
    if (!decision.selectedAssetId
      || !source.trustedAlternatives.some((candidate) => candidate.assetId === decision.selectedAssetId)
      || !trustedCandidate
      || !candidateClearsMatchingThresholds(trustedCandidate)
      || trustedCandidate.sourceRangePlacementLimitation) {
      fail("INVALID_ALTERNATIVE", "Repair MODIFY must choose a threshold-clearing original candidate from the same interval.");
    }
    replacement = Object.freeze({ repairEntryId: source.repairEntryId, status: "MODIFIED", provenance: "REPAIR_USER_MODIFIED", selectedAssetId: decision.selectedAssetId });
  } else {
    fail("INVALID_DECISION", "Unknown repair review decision.");
  }
  if (replacement.status !== "REJECTED") {
    assertRepairActionAllowed(proposal, selectedRepairAction(proposal, source, replacement));
  }
  const entries = Object.freeze(review.entries.map((entry) => entry.repairEntryId === replacement.repairEntryId ? replacement : entry));
  return Object.freeze({ ...review, lifecycle: reviewLifecycle(entries), entries });
}

function selectedRepairAction(
  proposal: RepairProposalBundle,
  source: RepairProposalEntry,
  review: RepairReviewEntry,
): EditorAIPlanAction {
  if (!source.proposedAction?.assetId) fail("INVALID_SOURCE", "Approved repair is missing a canonical action.");
  const selectedAssetId = review.status === "MODIFIED" ? review.selectedAssetId : source.proposedAction.assetId;
  const trustedCandidate = proposal.sourceProposal.rankedCandidateSets
    .find((set) => set.intervalId === source.intervalId)?.candidates
    .find((candidate) => candidate.assetId === selectedAssetId);
  if (!selectedAssetId
    || !source.trustedAlternatives.some((candidate) => candidate.assetId === selectedAssetId)
    || !trustedCandidate
    || !candidateClearsMatchingThresholds(trustedCandidate)
    || trustedCandidate.sourceRangePlacementLimitation) {
    fail("INVALID_ALTERNATIVE", "Modified repair asset is no longer trusted.");
  }
  if (!proposal.trustedPreRepairProject.assets.some((asset) => asset.id === selectedAssetId)) {
    fail("INVALID_ALTERNATIVE", "Modified repair asset is absent from the authoritative project.");
  }
  if (review.status !== "MODIFIED") return Object.freeze({ ...source.proposedAction });
  return Object.freeze({
    ...source.proposedAction,
    assetId: selectedAssetId,
    reason: `REPAIR_USER_MODIFIED trusted repair entry ${source.repairEntryId}.`,
  });
}

function assertRepairActionAllowed(proposal: RepairProposalBundle, action: EditorAIPlanAction): void {
  const enforcement = enforceEditorActionConstraintsV1({
    project: proposal.trustedPreRepairProject,
    constraintSet: proposal.constraintSet,
    expectedContext: proposal.constraintContext,
    action,
  });
  if (enforcement.status !== "ALLOWED") {
    fail("INVALID_ALTERNATIVE", enforcement.violations[0]?.messageZh ?? "Repair action violates an active hard constraint.");
  }
  const intentVersionId = proposal.constraintContext?.intentVersionId;
  if (intentVersionId && isRejectedSemanticActionV1({
    projectId: proposal.trustedPreRepairProject.id,
    intentVersionId,
    action,
    rejectedOperationTuples: proposal.sessionDecisionLedger?.rejectedProposalOperationTuples,
  })) {
    fail("INVALID_ALTERNATIVE", "Repair action reintroduces a user-rejected semantic operation.");
  }
}

export function buildReviewedRepairPlan(
  proposal: RepairProposalBundle,
  review: RepairReviewState,
  currentProject: EditorProject,
): ReviewedRepairPlan {
  validateRepairReview(proposal, review);
  if (review.entries.some((entry) => entry.status === "PENDING")) fail("PENDING_ENTRIES", "Every actionable repair requires human review.");
  if (proposal.sourceProjectFingerprint !== createEditorProjectFingerprint(currentProject)
    || currentProject.id !== proposal.trustedPreRepairProject.id
    || currentProject.updatedAt !== proposal.trustedPreRepairProject.updatedAt) {
    fail("STALE_REPAIR", "The authoritative project changed after repair proposal generation.");
  }
  const actions: EditorAIPlanAction[] = [];
  const links: IntervalActionLink[] = [];
  const reviewedEntries: ReviewedRepairPlan["reviewedEntries"][number][] = [];
  proposal.entries.forEach((source) => {
    const decision = review.entries.find((entry) => entry.repairEntryId === source.repairEntryId)!;
    if (decision.status === "NOT_ACTIONABLE") return;
    if (decision.status === "REJECTED") {
      reviewedEntries.push(Object.freeze({
        repairEntryId: source.repairEntryId,
        defectId: source.defectId,
        ...(source.intervalId ? { intervalId: source.intervalId } : {}),
        decision: "REJECTED",
        ...(source.proposedAction?.assetId ? { originalAssetId: source.proposedAction.assetId } : {}),
        provenance: "REPAIR_USER_REJECTED",
      }));
      return;
    }
    if (decision.status !== "ACCEPTED" && decision.status !== "MODIFIED") fail("INVALID_DECISION", "Repair decision is not executable.");
    const action = selectedRepairAction(proposal, source, decision);
    if (!action.assetId || !clipMap(currentProject).has(action.targetId)
      || !currentProject.assets.some((asset) => asset.id === action.assetId)) {
      fail("INVALID_SOURCE", "Reviewed repair references an unknown trusted target or asset.");
    }
    assertRepairActionAllowed(proposal, action);
    const reviewedActionIndex = actions.length;
    actions.push(action);
    links.push(Object.freeze({
      intervalId: source.intervalId ?? source.defectId,
      narrativePlanIndex: proposal.sourceProposal.matchingIntervals.findIndex((interval) => interval.id === source.intervalId),
      status: "COMPILED",
      selectedAssetId: action.assetId,
      targetClipId: action.targetId,
      actionIndex: reviewedActionIndex,
      actionType: "MATCH_ASSET_TO_SEGMENT",
      supportingSegmentIds: source.trustedAlternatives.find((candidate) => candidate.assetId === action.assetId)?.supportingSegmentIds ?? Object.freeze([]),
      narrativeReasonCodes: Object.freeze([]),
    }));
    reviewedEntries.push(Object.freeze({
      repairEntryId: source.repairEntryId,
      defectId: source.defectId,
      ...(source.intervalId ? { intervalId: source.intervalId } : {}),
      decision: decision.status,
      originalAssetId: source.proposedAction!.assetId,
      selectedAssetId: action.assetId,
      reviewedActionIndex,
      action,
      provenance: decision.provenance!,
    }));
  });
  if (actions.length > MAX_REPAIR_ACTIONS) fail("INVALID_SOURCE", "Reviewed repair exceeds the hard action cap.");
  if (new Set(actions.map((action) => action.targetId)).size !== actions.length) fail("INVALID_SOURCE", "Reviewed repair contains conflicting target mutations.");
  const canonicalPlan = parseAIEditingPlan({
    summary: `Human-reviewed bounded repair ${proposal.repairProposalId}: ${actions.length} approved action(s).`,
    actions,
    unsupported: [],
    warnings: [],
  });
  const compiledPlan: CompiledNarrativeActionPlan = Object.freeze({
    schemaVersion: 1,
    mode: "INITIAL_PLAN",
    status: "VALIDATED",
    sourceNarrativeReference: `repair-source-${hash(proposal.sourceEvaluationId)}`,
    canonicalPlan: Object.freeze({
      ...canonicalPlan,
      actions: Object.freeze(canonicalPlan.actions.map((action) => Object.freeze(action))),
      unsupported: Object.freeze(canonicalPlan.unsupported),
      warnings: Object.freeze(canonicalPlan.warnings),
    }) as unknown as CompiledNarrativeActionPlan["canonicalPlan"],
    intervalActionMap: Object.freeze(links),
    unresolvedIntervalIds: Object.freeze([]),
    unsupportedIntervalIds: Object.freeze([]),
    warnings: Object.freeze([]),
    errors: Object.freeze([]),
    canonicalValidation: Object.freeze({ parser: "parseAIEditingPlan", valid: true }),
  });
  return Object.freeze({
    schemaVersion: EDITOR_REPAIR_SCHEMA_VERSION,
    repairProposalId: proposal.repairProposalId,
    sourceProjectFingerprint: proposal.sourceProjectFingerprint,
    status: actions.length ? "REPAIR_READY_TO_EXECUTE" : "REPAIR_NO_ACTIONS",
    compiledPlan,
    reviewedEntries: Object.freeze(reviewedEntries),
  });
}

function finalReviewState(review: RepairReviewState, lifecycle: RepairReviewLifecycle): RepairReviewState {
  return Object.freeze({ ...review, lifecycle, entries: Object.freeze([...review.entries]) });
}

function overlayEntryId(repairProposalId: string, intervalId: string): string {
  return `e-${hash(`${repairProposalId}\u0000${intervalId}`)}`;
}

type EvaluationOverlay = Readonly<{
  proposal: EditorProposalBundle;
  humanReview: HumanReviewState;
  reviewedPlan: ReviewedCompiledPlan;
  planEvidence: PlanEvidence;
  finalIntent: readonly Readonly<{ intervalId: string; assetId: string; provenance: "REPAIR_USER_ACCEPTED" | "REPAIR_USER_MODIFIED" }>[];
}>;

function createEvaluationOverlay(
  proposal: RepairProposalBundle,
  repairReview: RepairReviewState,
  reviewedRepair: ReviewedRepairPlan,
  execution: CompiledPlanExecutionResult,
): EvaluationOverlay {
  const overlayPlanId = `plan-repair-${hash(`${proposal.repairProposalId}\u0000${execution.executionFingerprint}`)}`;
  const reviewedByInterval = new Map(reviewedRepair.reviewedEntries
    .filter((entry) => entry.decision !== "REJECTED" && entry.intervalId && entry.action && entry.selectedAssetId)
    .map((entry) => [entry.intervalId!, entry]));
  const evaluationIntervalIds = new Set(reviewedByInterval.keys());
  reviewedRepair.reviewedEntries.forEach((reviewed) => {
    const source = proposal.entries.find((entry) => entry.repairEntryId === reviewed.repairEntryId);
    if (reviewed.decision === "REJECTED" || source?.metric !== "REPETITION" || !source.intervalId) return;
    const index = proposal.sourceProposal.matchingIntervals.findIndex((interval) => interval.id === source.intervalId);
    for (let offset = Math.max(0, index - 3); offset < index; offset += 1) {
      evaluationIntervalIds.add(proposal.sourceProposal.matchingIntervals[offset].id);
    }
  });
  const evaluationIntervals = proposal.sourceProposal.matchingIntervals
    .filter((interval) => evaluationIntervalIds.has(interval.id));
  const proposalEntries: EditorProposalEntryReference[] = [];
  const humanEntries: HumanReviewState["entries"][number][] = [];
  const reviewedEntries: ReviewedEntryAction[] = [];
  const evidenceEntries: PlanEvidenceEntry[] = [];
  const finalIntent: EvaluationOverlay["finalIntent"][number][] = [];
  const preClips = clipMap(execution.preProject);
  const postClips = clipMap(execution.postProject);
  evaluationIntervals.forEach((interval) => {
    const entryId = overlayEntryId(proposal.repairProposalId, interval.id);
    const repair = reviewedByInterval.get(interval.id);
    const sourceEntry = proposal.sourceProposal.proposalEntries.find((entry) => entry.intervalId === interval.id);
    const sourceEvidence = proposal.sourcePlanEvidence.entries.find((entry) => entry.intervalId === interval.id);
    const targetId = repair?.action?.targetId ?? sourceEntry?.targetId ?? sourceEvidence?.currentProposed?.targetClipId;
    proposalEntries.push(Object.freeze({
      proposalEntryId: entryId,
      intervalId: interval.id,
      ...(targetId ? { targetId } : {}),
      ...(repair?.selectedAssetId ? { selectedAssetId: repair.selectedAssetId } : {}),
      ...(repair?.reviewedActionIndex !== undefined ? { actionIndex: repair.reviewedActionIndex } : {}),
      candidateAlternativeAssetIds: Object.freeze(proposal.sourceProposal.rankedCandidateSets
        .find((set) => set.intervalId === interval.id)?.candidates.map((candidate) => candidate.assetId) ?? []),
    }));
    if (!repair || !repair.action || !repair.selectedAssetId || repair.reviewedActionIndex === undefined) {
      humanEntries.push(Object.freeze({ proposalEntryId: entryId, intervalId: interval.id, status: "REJECTED", provenance: "USER_REJECTED" }));
      reviewedEntries.push(Object.freeze({ proposalEntryId: entryId, intervalId: interval.id, decision: "REJECTED" }));
      evidenceEntries.push(Object.freeze({
        ...(sourceEvidence ?? {
          interval: Object.freeze({ startMs: interval.timelineStartMs, endMs: interval.timelineEndMs, caption: interval.text, concepts: interval.concepts }),
          explanation: "Untouched interval retained as evaluation context.",
        }),
        id: entryId,
        proposalEntryId: entryId,
        intervalId: interval.id,
        status: "NOT_EXECUTED",
        humanReview: Object.freeze({ decision: "REJECTED", provenance: "USER_REJECTED" }),
        executionDisposition: "NOT_EXECUTED_USER_REJECTED",
        executedAction: undefined,
        beforeAfter: undefined,
        actionResultStatus: undefined,
        failureCode: undefined,
      }));
      return;
    }
    const repairReviewEntry = repairReview.entries.find((entry) => entry.repairEntryId === repair.repairEntryId)!;
    const modified = repair.decision === "MODIFIED";
    humanEntries.push(Object.freeze({
      proposalEntryId: entryId,
      intervalId: interval.id,
      status: modified ? "MODIFIED" : "ACCEPTED",
      provenance: modified ? "USER_MODIFIED" : "USER_ACCEPTED",
      ...(modified ? { selectedAssetId: repair.selectedAssetId } : {}),
    }));
    reviewedEntries.push(Object.freeze({
      proposalEntryId: entryId,
      intervalId: interval.id,
      decision: modified ? "MODIFIED" : "ACCEPTED",
      reviewedActionIndex: repair.reviewedActionIndex,
      originalAssetId: repair.originalAssetId,
      selectedAssetId: repair.selectedAssetId,
      action: repair.action,
    }));
    const before = preClips.get(repair.action.targetId);
    const after = postClips.get(repair.action.targetId);
    const run = execution.actionResults.find((item) => item.actionIndex === repair.reviewedActionIndex);
    finalIntent.push(Object.freeze({
      intervalId: interval.id,
      assetId: repair.selectedAssetId,
      provenance: repairReviewEntry.provenance === "REPAIR_USER_MODIFIED" ? "REPAIR_USER_MODIFIED" : "REPAIR_USER_ACCEPTED",
    }));
    evidenceEntries.push(Object.freeze({
      ...(sourceEvidence ?? {
        interval: Object.freeze({ startMs: interval.timelineStartMs, endMs: interval.timelineEndMs, caption: interval.text, concepts: interval.concepts }),
        explanation: "Human-reviewed repair intent.",
      }),
      id: entryId,
      proposalEntryId: entryId,
      intervalId: interval.id,
      selectedAssetId: repair.selectedAssetId,
      status: run?.status === "NO_OP" ? "NO_OP" : run?.status === "APPLIED" ? "APPLIED" : "FAILED",
      humanReview: Object.freeze({
        decision: modified ? "MODIFIED" : "ACCEPTED",
        provenance: modified ? "USER_MODIFIED" : "USER_ACCEPTED",
        ...(repair.originalAssetId ? { originalAssetId: repair.originalAssetId } : {}),
        ...(modified ? { selectedAssetId: repair.selectedAssetId } : {}),
      }),
      executedAction: Object.freeze({
        actionIndex: repair.reviewedActionIndex,
        actionType: repair.action.type,
        targetId: repair.action.targetId,
        assetId: repair.selectedAssetId,
        reason: repair.action.reason,
      }),
      executionDisposition: execution.status === "FAILED" ? "EXECUTION_FAILED" : "EXECUTED",
      actionResultStatus: run?.status,
      ...(run?.failureCode ? { failureCode: run.failureCode } : {}),
      beforeAfter: Object.freeze({
        targetClipId: repair.action.targetId,
        ...(before ? { assetBefore: before.assetId, sourceStartBeforeMs: before.sourceInMs, sourceEndBeforeMs: before.sourceOutMs } : {}),
        ...(after ? { assetAfter: after.assetId, sourceStartAfterMs: after.sourceInMs, sourceEndAfterMs: after.sourceOutMs } : {}),
        timelineStartMs: before?.timelineStartMs ?? interval.timelineStartMs,
        timelineEndMs: before?.timelineEndMs ?? interval.timelineEndMs,
      }),
      explanation: `Authoritative repair intent: ${repair.selectedAssetId}. Original proposal remains preserved separately.`,
    }));
  });
  const preservation = execution.preservation;
  const planEvidence = parsePlanEvidence(Object.freeze({
    schemaVersion: 2,
    planId: overlayPlanId,
    lifecycleStatus: execution.status === "FAILED" ? "EXECUTION_FAILED" : "EXECUTED",
    entries: Object.freeze(evidenceEntries),
    summary: Object.freeze({
      resolvedIntervalCount: evidenceEntries.length,
      unresolvedIntervalCount: 0,
      compiledActionCount: reviewedRepair.compiledPlan.canonicalPlan.actions.length,
      averageSemanticScore: null,
      narrativeEvidenceAvailable: evidenceEntries.some((entry) => Boolean(entry.narrative)),
      preProjectReference: createEditorProjectFingerprint(execution.preProject),
      execution: Object.freeze({
        status: execution.status,
        fingerprint: execution.executionFingerprint,
        postProjectReference: createEditorProjectFingerprint(execution.postProject),
        appliedCount: execution.appliedActionCount,
        noOpCount: execution.noOpActionCount,
        failedCount: execution.actionResults.filter((item) => ["FAILED", "ROLLED_BACK", "NOT_RUN"].includes(item.status)).length,
      }),
      ...(proposal.sourcePlanEvidence.summary.constraintLineage ? { constraintLineage: proposal.sourcePlanEvidence.summary.constraintLineage } : {}),
      ...(execution.constraintEnforcement ? { constraintValidation: Object.freeze({
        status: execution.constraintEnforcement.status,
        ...(execution.constraintEnforcement.constraintSetId ? { constraintSetId: execution.constraintEnforcement.constraintSetId } : {}),
        ...(execution.constraintEnforcement.constraintFingerprint ? { constraintFingerprint: execution.constraintEnforcement.constraintFingerprint } : {}),
        violationIds: Object.freeze(execution.constraintEnforcement.violations.map((item) => item.violationId)),
      }) } : {}),
    }),
    preservation: Object.freeze({
      captionsUnchanged: preservation.captionsPreserved,
      audioUnchanged: preservation.audioSelectionPreserved,
      ratioUnchanged: preservation.projectRatioPreserved,
      durationUnchanged: preservation.projectDurationPreserved,
      unrelatedClipsUnchanged: preservation.unrelatedClipsPreserved,
      transformsUnchanged: preservation.targetTimelineAndTransformPreserved,
      tracksUnchanged: preservation.trackIdentityAndOrderPreserved && preservation.clipIdentityAndOrderPreserved,
    }),
  }));
  const humanReview: HumanReviewState = Object.freeze({
    schemaVersion: 1,
    proposalId: overlayPlanId,
    lifecycle: execution.status === "FAILED" ? "EXECUTION_FAILED" : "EXECUTED",
    entries: Object.freeze(humanEntries),
  });
  const reviewedPlan: ReviewedCompiledPlan = Object.freeze({
    schemaVersion: 1,
    proposalId: overlayPlanId,
    status: "READY_TO_EXECUTE",
    sourceProjectFingerprint: createEditorProjectFingerprint(execution.preProject),
    compiledPlan: reviewedRepair.compiledPlan,
    reviewedEntries: Object.freeze(reviewedEntries),
  });
  const overlayProposal: EditorProposalBundle = Object.freeze({
    ...proposal.sourceProposal,
    proposalId: overlayPlanId,
    sourceProjectFingerprint: createEditorProjectFingerprint(execution.preProject),
    trustedPreExecutionProject: cloneProject(execution.preProject),
    compiledPlan: reviewedRepair.compiledPlan,
    planEvidence,
    matchingIntervals: Object.freeze(evaluationIntervals),
    rankedCandidateSets: Object.freeze(proposal.sourceProposal.rankedCandidateSets
      .filter((set) => evaluationIntervalIds.has(set.intervalId))),
    proposalEntries: Object.freeze(proposalEntries),
    evidenceMetadata: Object.freeze({
      ...proposal.sourceProposal.evidenceMetadata,
      providerCalls: 0,
      networkCalls: 0,
    }),
  });
  return Object.freeze({ proposal: overlayProposal, humanReview, reviewedPlan, planEvidence, finalIntent: Object.freeze(finalIntent) });
}

function defectsFor(report: EditorEvaluationReport, source: RepairProposalEntry): readonly EvaluationDefect[] {
  return report.defects.filter((defect) => defect.metric === source.metric
    && (source.intervalId === undefined || defect.intervalId === source.intervalId));
}

function numericObserved(defect: EvaluationDefect): number | undefined {
  const value = Number(defect.observed);
  return Number.isFinite(value) ? value : undefined;
}

function compareTarget(
  original: EditorEvaluationReport,
  repaired: EditorEvaluationReport,
  source: RepairProposalEntry,
): RepairComparison["targetedDefects"][number] {
  const beforeDefect = original.defects.find((defect) => defect.id === source.defectId)!;
  const afterDefects = defectsFor(repaired, source);
  if (!afterDefects.length) {
    return Object.freeze({ defectId: source.defectId, metric: source.metric, before: beforeDefect.observed, after: "RESOLVED", outcome: "RESOLVED" });
  }
  let outcome: "IMPROVED" | "UNCHANGED" | "WORSENED" = "UNCHANGED";
  if (source.metric === "SEMANTIC_MATCH") {
    const before = numericObserved(beforeDefect);
    const after = afterDefects.map(numericObserved).filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0];
    if (before !== undefined && after !== undefined) outcome = after > before ? "IMPROVED" : after < before ? "WORSENED" : "UNCHANGED";
  } else if (source.metric === "REPETITION") {
    const beforeCount = original.defects.filter((defect) => defect.metric === "REPETITION" && defect.intervalId === source.intervalId).length;
    outcome = afterDefects.length < beforeCount ? "IMPROVED" : afterDefects.length > beforeCount ? "WORSENED" : "UNCHANGED";
  } else if (source.metric === "REQUIREMENT_COMPLETION") {
    outcome = afterDefects.some((defect) => defect.code !== beforeDefect.code) ? "WORSENED" : "UNCHANGED";
  }
  return Object.freeze({
    defectId: source.defectId,
    metric: source.metric,
    before: beforeDefect.observed,
    after: afterDefects.map((defect) => `${defect.code}:${defect.observed}`).join(" | "),
    outcome,
  });
}

function compareEvaluations(
  proposal: RepairProposalBundle,
  review: RepairReviewState,
  original: EditorEvaluationReport,
  repaired: EditorEvaluationReport,
  finalIntent: EvaluationOverlay["finalIntent"],
  postProject: EditorProject,
): RepairComparison {
  const approvedIds = new Set(review.entries.filter((entry) => entry.status === "ACCEPTED" || entry.status === "MODIFIED").map((entry) => entry.repairEntryId));
  const sources = proposal.entries.filter((entry) => approvedIds.has(entry.repairEntryId));
  const targetedDefects = Object.freeze(sources.map((entry) => compareTarget(original, repaired, entry)));
  const allTargetsResolved = targetedDefects.every((target) => target.outcome === "RESOLVED");
  const everyTargetImproved = targetedDefects.length > 0 && targetedDefects.every((target) => target.outcome === "RESOLVED" || target.outcome === "IMPROVED");
  const newStructuralFail = repaired.defects.some((defect) => defect.severity === "FAIL"
    && (defect.metric === "HARD_CONSTRAINT_COMPLIANCE"
      || defect.metric === "REQUIREMENT_COMPLETION"
      || defect.metric === "PRESERVATION"));
  const protectedStateRegression = repaired.defects.some((defect) => defect.code === "PROTECTED_STATE_REGRESSION");
  const postClips = clipMap(postProject);
  const humanProtectedDecisionViolated = finalIntent.some((intent) => {
    const reviewed = sources.find((entry) => entry.intervalId === intent.intervalId);
    const clipId = reviewed?.clipId;
    return !clipId || postClips.get(clipId)?.assetId !== intent.assetId;
  }) || sources.some((entry) => entry.humanProtection !== "NOT_PROTECTED");
  return Object.freeze({
    targetedDefects,
    allTargetsResolved,
    everyTargetImproved,
    newStructuralFail,
    protectedStateRegression,
    humanProtectedDecisionViolated,
    safeToKeep: everyTargetImproved && !newStructuralFail && !protectedStateRegression && !humanProtectedDecisionViolated,
  });
}

type RepairExecutionDependencies = Readonly<{
  executePlan?: (input: CompiledPlanExecutionInput) => CompiledPlanExecutionResult;
  evaluate?: (input: EditorEvaluationInput) => EditorEvaluationReport;
}>;

function baseResult(
  originalEvaluation: EditorEvaluationReport,
  proposal: RepairProposalBundle,
  review: RepairReviewState,
  finalProject: EditorProject,
  finalStatus: ClosedLoopFinalStatus,
  rollback: ClosedLoopRepairResult["rollback"],
  extra: Partial<ClosedLoopRepairResult> = {},
): ClosedLoopRepairResult {
  const evidence: ClosedLoopRepairResult["evidence"] = Object.freeze({
    initialProposalId: proposal.sourceProposal.proposalId,
    initialReviewProposalId: proposal.sourceHumanReview.proposalId,
    initialEvaluationId: originalEvaluation.evaluationId,
    repairProposalId: proposal.repairProposalId,
    repairReviewLifecycle: review.lifecycle,
    ...(extra.repairExecution ? { repairExecutionFingerprint: extra.repairExecution.executionFingerprint } : {}),
    ...(extra.reEvaluation ? { reEvaluationId: extra.reEvaluation.evaluationId } : {}),
    finalStatus,
  });
  return Object.freeze({
    schemaVersion: CLOSED_LOOP_REPAIR_SCHEMA_VERSION,
    originalEvaluation,
    repairProposal: proposal,
    repairReview: review,
    reEvaluationCount: 0,
    rollback,
    finalProject: cloneProject(finalProject),
    finalProjectFingerprint: createEditorProjectFingerprint(finalProject),
    finalStatus,
    history: Object.freeze({ shouldRecord: false, entryCount: 0 }),
    evidence,
    ...extra,
  });
}

/**
 * Executes at most one human-reviewed repair batch through V2.0D, invokes the
 * existing V2.2A evaluator exactly once after successful execution, then keeps
 * or discards the candidate state. It never proposes a repair of that result.
 */
export function executeReviewedRepairLoop(
  input: Readonly<{
    originalEvaluation: EditorEvaluationReport;
    repairProposal: RepairProposalBundle;
    repairReview: RepairReviewState;
    currentProject: EditorProject;
    executionUpdatedAt: string;
  }>,
  dependencies: RepairExecutionDependencies = {},
): ClosedLoopRepairResult {
  if (input.repairProposal.repairRound !== MAX_REPAIR_ROUNDS) fail("INVALID_REPAIR_ROUND", "Repair round 2 is forbidden.");
  const reviewedRepairPlan = buildReviewedRepairPlan(input.repairProposal, input.repairReview, input.currentProject);
  const preRepair = cloneProject(input.currentProject);
  const rollbackTarget = createEditorProjectFingerprint(preRepair);
  if (reviewedRepairPlan.status === "REPAIR_NO_ACTIONS") {
    const review = finalReviewState(input.repairReview, input.repairReview.lifecycle === "REPAIR_REJECTED" ? "REPAIR_REJECTED" : "REPAIR_NO_ACTIONS");
    return baseResult(input.originalEvaluation, input.repairProposal, review, preRepair, "REPAIR_NO_ACTIONS",
      Object.freeze({ performed: false, targetProjectFingerprint: rollbackTarget }), { reviewedRepairPlan });
  }
  const executePlan = dependencies.executePlan ?? executeCompiledNarrativeActionPlan;
  const execution = executePlan({
    preExecutionProject: preRepair,
    compiledPlan: reviewedRepairPlan.compiledPlan,
    ownedAssetIds: preRepair.assets.map((asset) => asset.id),
    expectedProjectId: preRepair.id,
    expectedProjectUpdatedAt: preRepair.updatedAt,
    executionUpdatedAt: input.executionUpdatedAt,
    ...(input.repairProposal.constraintSet && input.repairProposal.constraintContext ? { constraintContext: {
      intentVersionId: input.repairProposal.constraintContext.intentVersionId,
      constraintSetId: input.repairProposal.constraintContext.constraintSetId,
      constraintFingerprint: input.repairProposal.constraintContext.constraintFingerprint,
      constraintSet: input.repairProposal.constraintSet,
    } } : {}),
    ...(input.repairProposal.sessionDecisionLedger ? {
      rejectedOperationTuples: input.repairProposal.sessionDecisionLedger.rejectedProposalOperationTuples,
    } : {}),
  });
  if (execution.status === "FAILED") {
    return baseResult(input.originalEvaluation, input.repairProposal, input.repairReview, preRepair, "REPAIR_FINAL_UNRESOLVED",
      Object.freeze({ performed: false, targetProjectFingerprint: rollbackTarget, reason: execution.failureCode ?? "REPAIR_EXECUTION_FAILED" }),
      { reviewedRepairPlan, repairExecution: execution });
  }
  const overlay = createEvaluationOverlay(input.repairProposal, input.repairReview, reviewedRepairPlan, execution);
  const evaluate = dependencies.evaluate ?? evaluateEditorExecution;
  let reEvaluation: EditorEvaluationReport;
  try {
    reEvaluation = evaluate({
      proposalBundle: overlay.proposal,
      humanReviewState: overlay.humanReview,
      reviewedPlan: overlay.reviewedPlan,
      executionResult: execution,
      postProject: execution.postProject,
      planEvidence: overlay.planEvidence,
      videoSemanticEvidence: input.repairProposal.videoSemanticEvidence,
      ...(input.repairProposal.audioRhythmEvidence ? { audioRhythmEvidence: input.repairProposal.audioRhythmEvidence } : {}),
      ...(input.repairProposal.constraintSet ? { constraintSet: input.repairProposal.constraintSet } : {}),
      ...(input.repairProposal.resolvedDurationPolicy ? { resolvedDurationPolicy: input.repairProposal.resolvedDurationPolicy } : {}),
    });
  } catch (error) {
    const review = finalReviewState(input.repairReview, "REPAIR_ROLLED_BACK");
    return baseResult(input.originalEvaluation, input.repairProposal, review, preRepair, "REPAIR_ROLLED_BACK",
      Object.freeze({ performed: true, targetProjectFingerprint: rollbackTarget, reason: error instanceof Error ? `RE_EVALUATION_FAILED: ${error.message}` : "RE_EVALUATION_FAILED" }),
      { reviewedRepairPlan, repairExecution: execution, reEvaluationCount: 1 });
  }
  const comparison = compareEvaluations(input.repairProposal, input.repairReview, input.originalEvaluation, reEvaluation, overlay.finalIntent, execution.postProject);
  if (!comparison.safeToKeep) {
    const review = finalReviewState(input.repairReview, "REPAIR_ROLLED_BACK");
    return baseResult(input.originalEvaluation, input.repairProposal, review, preRepair, "REPAIR_ROLLED_BACK",
      Object.freeze({ performed: true, targetProjectFingerprint: rollbackTarget, reason: comparison.newStructuralFail
        ? "NEW_STRUCTURAL_FAIL" : comparison.protectedStateRegression
          ? "PROTECTED_STATE_REGRESSION" : comparison.humanProtectedDecisionViolated
            ? "HUMAN_PROTECTED_DECISION_VIOLATED" : "TARGET_METRIC_NOT_IMPROVED" }),
      { reviewedRepairPlan, repairExecution: execution, reEvaluation, reEvaluationCount: 1, comparison });
  }
  const finalStatus: ClosedLoopFinalStatus = comparison.allTargetsResolved
    ? "REPAIR_FINAL_PASS" : "REPAIR_FINAL_UNRESOLVED_IMPROVED";
  const review = finalReviewState(input.repairReview, "REPAIR_EXECUTED");
  const shouldRecord = execution.historyBoundary.shouldRecordPlanUndo;
  return baseResult(input.originalEvaluation, input.repairProposal, review, execution.postProject, finalStatus,
    Object.freeze({ performed: false, targetProjectFingerprint: rollbackTarget }), {
      reviewedRepairPlan,
      repairExecution: execution,
      reEvaluation,
      reEvaluationCount: 1,
      comparison,
      history: Object.freeze({
        shouldRecord,
        entryCount: shouldRecord ? 1 : 0,
        ...(shouldRecord ? { undoProject: cloneProject(preRepair), redoProject: cloneProject(execution.postProject) } : {}),
      }),
    });
}
