import type { EditorProject, TimelineClip } from "./editor-core.ts";
import type { AudioRhythmAnalysis } from "./editor-audio-rhythm.ts";
import {
  AUDIO_ENERGY_WINDOW_MS,
  AUDIO_MEANINGFUL_PAUSE_MS,
  parseAudioRhythmAnalysis,
} from "./editor-audio-rhythm.ts";
import type { CompiledPlanExecutionResult } from "./editor-compiled-plan-execution.ts";
import {
  MATCHING_THRESHOLD_EPSILON,
  MINIMUM_SEMANTIC_SCORE,
  candidateClearsMatchingThresholds,
  normalizeMatchingConcept,
  rankMultimodalCandidates,
  rhythmEvidenceForInterval,
  type CandidateMatchScore,
  type MatchingInterval,
} from "./editor-multimodal-matching.ts";
import { scoreNarrativeTransition, type NarrativeTransitionEvidence } from "./editor-narrative-planner.ts";
import { createEditorProjectFingerprint, parsePlanEvidence, type PlanEvidence } from "./editor-plan-evidence.ts";
import type { EditorProposalBundle } from "./editor-proposal-orchestrator.ts";
import type { HumanReviewState, ReviewedCompiledPlan } from "./editor-proposal-review.ts";
import { parseVideoSemanticAnalysis, type VideoSemanticAnalysis, type VideoSemanticSegment } from "./editor-video-semantic.ts";
import type { ConstraintSetV1 } from "./editor-constraints.ts";
import { verifyPostApplyConstraintInvariantsV1 } from "./editor-constraint-enforcement.ts";
import type { ConstraintResolutionPolicyV1 } from "./editor-constraint-negotiation.ts";

export const EDITOR_EVALUATION_SCHEMA_VERSION = 1 as const;
export const EDITOR_EVALUATOR_VERSION = "deterministic-evaluator-v1" as const;
export const EVALUATOR_RHYTHM_TOLERANCES = Object.freeze({
  alignedMaxOffsetMs: AUDIO_ENERGY_WINDOW_MS,
  nearMaxOffsetMs: AUDIO_MEANINGFUL_PAUSE_MS,
});

export type EvaluationStatus = "PASS" | "FAIL" | "WARNING" | "NOT_EVALUABLE";
export type EvaluationOverallStatus = "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "NOT_EVALUABLE" | "NO_EXECUTED_ACTIONS";
export type EvaluationMetric =
  | "HARD_CONSTRAINT_COMPLIANCE"
  | "REQUIREMENT_COMPLETION"
  | "SEMANTIC_MATCH"
  | "RHYTHM_ALIGNMENT"
  | "REPETITION"
  | "NARRATIVE_CONTINUITY"
  | "PRESERVATION";
export type RepairEligibility =
  | "DETERMINISTIC_REPAIR_POSSIBLE"
  | "PROVIDER_REPLAN_MAY_BE_REQUIRED"
  | "HUMAN_DECISION_PROTECTED"
  | "UNSUPPORTED";

export type EvaluationDefectCode =
  | "HARD_CONSTRAINT_VIOLATION"
  | "STALE_CONSTRAINT_CONTEXT"
  | "EXECUTION_FAILED"
  | "TARGET_CLIP_MISSING"
  | "INTENDED_STATE_NOT_REALIZED"
  | "EXECUTION_EVIDENCE_CONFLICT"
  | "PROTECTED_STATE_REGRESSION"
  | "MISSING_SEMANTIC_EVIDENCE"
  | "LOW_SEMANTIC_SUPPORT"
  | "RHYTHM_EVIDENCE_UNAVAILABLE"
  | "CUT_NEAR_RHYTHM_MARKER"
  | "CUT_MISALIGNED"
  | "IMMEDIATE_ASSET_REPEAT"
  | "ABA_ASSET_OSCILLATION"
  | "RECENT_ASSET_REUSE"
  | "ACTION_REGRESSION"
  | "NARRATIVE_EVIDENCE_INSUFFICIENT";

export type EvaluationEvidenceItem = Readonly<{
  key: string;
  value: string | number | boolean | null | readonly string[];
}>;

export type EvaluationDefect = Readonly<{
  id: string;
  metric: EvaluationMetric;
  severity: Exclude<EvaluationStatus, "PASS">;
  code: EvaluationDefectCode;
  expected: string;
  observed: string;
  evidence: readonly EvaluationEvidenceItem[];
  repairEligibility: RepairEligibility;
  intervalId?: string;
  clipId?: string;
  assetId?: string;
  candidateAssetIds?: readonly string[];
}>;

export type EvaluationObservation = Readonly<{
  status: EvaluationStatus;
  code: string;
  message: string;
  intervalId?: string;
  clipId?: string;
  assetId?: string;
  expectedAssetId?: string;
  observedAssetId?: string;
  markerType?: "PAUSE" | "ONSET";
  markerTimeMs?: number;
  offsetMs?: number;
  alignment?: "ALIGNED" | "NEAR" | "MISALIGNED" | "NOT_EVALUABLE";
  reviewDecision?: "ACCEPTED" | "REJECTED" | "MODIFIED";
}>;

export type EvaluationMetricResult = Readonly<{
  metric: EvaluationMetric;
  status: EvaluationStatus;
  observations: readonly EvaluationObservation[];
}>;

export type EditorEvaluationInput = Readonly<{
  proposalBundle: EditorProposalBundle;
  humanReviewState: HumanReviewState;
  reviewedPlan: ReviewedCompiledPlan;
  executionResult?: CompiledPlanExecutionResult;
  postProject: EditorProject;
  planEvidence: PlanEvidence;
  videoSemanticEvidence: readonly VideoSemanticAnalysis[];
  audioRhythmEvidence?: AudioRhythmAnalysis;
  constraintSet?: ConstraintSetV1;
  resolvedDurationPolicy?: ConstraintResolutionPolicyV1;
}>;

export type EditorEvaluationReport = Readonly<{
  schemaVersion: typeof EDITOR_EVALUATION_SCHEMA_VERSION;
  evaluatorVersion: typeof EDITOR_EVALUATOR_VERSION;
  evaluationId: string;
  sourceProposalId: string;
  executionFingerprint?: string;
  postProjectFingerprint: string;
  overallStatus: EvaluationOverallStatus;
  metricResults: readonly EvaluationMetricResult[];
  defects: readonly EvaluationDefect[];
  warnings: readonly string[];
  notEvaluable: readonly string[];
  summary: Readonly<{
    acceptedCount: number;
    modifiedCount: number;
    rejectedCount: number;
    intendedActionCount: number;
    realizedActionCount: number;
    failedRequirementCount: number;
    warningCount: number;
    notEvaluableCount: number;
    durationOutcome?: Readonly<{
      policy: ConstraintResolutionPolicyV1["policy"];
      requestedDurationMs: number;
      achievedDurationMs: number;
      remainingTargetGapMs: number;
      hardProtectionCompliant: boolean;
    }>;
  }>;
}>;

export class EditorEvaluationInputError extends Error {
  constructor(message: string) { super(message); this.name = "EditorEvaluationInputError"; }
}

const METRIC_ORDER: readonly EvaluationMetric[] = Object.freeze([
  "HARD_CONSTRAINT_COMPLIANCE",
  "REQUIREMENT_COMPLETION",
  "SEMANTIC_MATCH",
  "RHYTHM_ALIGNMENT",
  "REPETITION",
  "NARRATIVE_CONTINUITY",
  "PRESERVATION",
]);

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

function metricStatus(observations: readonly EvaluationObservation[]): EvaluationStatus {
  if (observations.some((item) => item.status === "FAIL")) return "FAIL";
  if (observations.some((item) => item.status === "WARNING")) return "WARNING";
  if (observations.length > 0 && observations.every((item) => item.status === "NOT_EVALUABLE")) return "NOT_EVALUABLE";
  return "PASS";
}

function metric(metric: EvaluationMetric, observations: readonly EvaluationObservation[]): EvaluationMetricResult {
  return Object.freeze({ metric, status: metricStatus(observations), observations: Object.freeze(observations) });
}

type DefectInput = Omit<EvaluationDefect, "id">;

function defect(value: DefectInput): EvaluationDefect {
  const material = {
    metric: value.metric,
    code: value.code,
    intervalId: value.intervalId ?? "",
    clipId: value.clipId ?? "",
    assetId: value.assetId ?? "",
    expected: value.expected,
    observed: value.observed,
  };
  return Object.freeze({ id: `defect-${hash(stable(material))}`, ...value });
}

function validateInput(input: EditorEvaluationInput): void {
  const evidence = parsePlanEvidence(input.planEvidence);
  if (!input || input.proposalBundle.proposalId !== input.humanReviewState.proposalId
    || input.proposalBundle.proposalId !== input.reviewedPlan.proposalId
    || input.proposalBundle.proposalId !== evidence.planId
    || input.postProject.id !== input.proposalBundle.trustedPreExecutionProject.id) {
    throw new EditorEvaluationInputError("Evaluation inputs do not share one trusted proposal and project identity.");
  }
  if (!["EXECUTED", "EXECUTION_FAILED", "REVIEWED_NO_ACTIONS"].includes(input.humanReviewState.lifecycle)) {
    throw new EditorEvaluationInputError("Only finalized human review state can be evaluated.");
  }
  if (input.humanReviewState.lifecycle === "REVIEWED_NO_ACTIONS") {
    if (input.executionResult !== undefined || input.reviewedPlan.status !== "REVIEWED_NO_ACTIONS"
      || evidence.lifecycleStatus !== "REVIEWED_NO_ACTIONS") {
      throw new EditorEvaluationInputError("No-actions evaluation cannot contain execution evidence.");
    }
  } else if (!input.executionResult) {
    throw new EditorEvaluationInputError("Executed review requires canonical execution evidence.");
  }
  if (input.humanReviewState.lifecycle === "EXECUTED" && evidence.lifecycleStatus !== "EXECUTED") {
    throw new EditorEvaluationInputError("Executed review requires executed PlanEvidence.");
  }
  if (input.humanReviewState.lifecycle === "EXECUTION_FAILED" && evidence.lifecycleStatus !== "EXECUTION_FAILED") {
    throw new EditorEvaluationInputError("Failed review requires failed PlanEvidence.");
  }
  if (input.executionResult && input.executionResult.preProject.id !== input.postProject.id) {
    throw new EditorEvaluationInputError("Execution and authoritative post-project identities differ.");
  }
  if (input.executionResult && (evidence.summary.execution?.fingerprint !== input.executionResult.executionFingerprint
    || evidence.summary.execution.postProjectReference !== createEditorProjectFingerprint(input.executionResult.postProject))) {
    throw new EditorEvaluationInputError("PlanEvidence does not describe the supplied canonical execution.");
  }
  if (input.humanReviewState.entries.length !== input.reviewedPlan.reviewedEntries.length
    || input.humanReviewState.entries.some((entry, index) => {
      const reviewed = input.reviewedPlan.reviewedEntries[index];
      return entry.proposalEntryId !== reviewed?.proposalEntryId || entry.intervalId !== reviewed.intervalId
        || entry.status !== reviewed.decision;
    })) {
    throw new EditorEvaluationInputError("Human decisions and the reviewed canonical plan differ.");
  }
  if (input.proposalBundle.constraintSet && input.constraintSet
    && (input.proposalBundle.constraintSet.constraintSetId !== input.constraintSet.constraintSetId
      || input.proposalBundle.constraintSet.constraintFingerprint !== input.constraintSet.constraintFingerprint)) {
    throw new EditorEvaluationInputError("Evaluation ConstraintSet differs from the proposal constraint context.");
  }
  input.videoSemanticEvidence.forEach(parseVideoSemanticAnalysis);
  if (input.audioRhythmEvidence) parseAudioRhythmAnalysis(input.audioRhythmEvidence);
}

function hardConstraintCompliance(input: EditorEvaluationInput, defects: EvaluationDefect[]): EvaluationMetricResult {
  const constraintSet = input.constraintSet ?? input.proposalBundle.constraintSet;
  const before = input.executionResult?.preProject ?? input.proposalBundle.trustedPreExecutionProject;
  const result = verifyPostApplyConstraintInvariantsV1({
    preProject: before,
    candidateProject: input.postProject,
    constraintSet,
  });
  if (!constraintSet) {
    return metric("HARD_CONSTRAINT_COMPLIANCE", [Object.freeze({
      status: "PASS",
      code: "NO_ACTIVE_CONSTRAINT_SET",
      message: "当前生命周期没有已激活的 ConstraintSetV1。",
    })]);
  }
  if (result.status === "ALLOWED") {
    return metric("HARD_CONSTRAINT_COMPLIANCE", [Object.freeze({
      status: "PASS",
      code: "HARD_CONSTRAINTS_PRESERVED",
      message: input.executionResult
        ? "真实执行后工程完整保留了所有活动硬约束。"
        : "当前工程完整保留了所有活动硬约束，本轮未执行编辑动作。",
    })]);
  }
  const observations = result.violations.map((item) => Object.freeze({
    status: "FAIL" as const,
    code: item.code,
    message: item.messageZh,
    ...(item.targetId ? { clipId: item.targetId } : {}),
  }));
  result.violations.forEach((item) => defects.push(defect({
    metric: "HARD_CONSTRAINT_COMPLIANCE",
    severity: "FAIL",
    code: item.code === "STALE_CONSTRAINT_CONTEXT" ? "STALE_CONSTRAINT_CONTEXT" : "HARD_CONSTRAINT_VIOLATION",
    ...(item.targetId ? { clipId: item.targetId } : {}),
    expected: item.expected,
    observed: item.observed,
    evidence: Object.freeze(Object.entries(item.evidence).map(([key, value]) => Object.freeze({ key, value }))),
    repairEligibility: "UNSUPPORTED",
  })));
  return metric("HARD_CONSTRAINT_COMPLIANCE", observations.length ? observations : [Object.freeze({
    status: "FAIL",
    code: result.status,
    message: "硬约束上下文无法安全评估。",
  })]);
}

function intendedAsset(entry: ReviewedCompiledPlan["reviewedEntries"][number]): string | undefined {
  return entry.decision === "REJECTED" ? undefined : entry.selectedAssetId ?? entry.action?.assetId;
}

function safeAlternatives(input: EditorEvaluationInput, intervalId: string, actualAssetId?: string): readonly string[] {
  const assets = new Set(input.postProject.assets.map((asset) => asset.id));
  const set = input.proposalBundle.rankedCandidateSets.find((item) => item.intervalId === intervalId);
  return Object.freeze((set?.candidates ?? [])
    .filter((candidate) => candidate.assetId !== actualAssetId && assets.has(candidate.assetId)
      && candidateClearsMatchingThresholds(candidate) && !candidate.sourceRangePlacementLimitation)
    .map((candidate) => candidate.assetId));
}

function requirementCompletion(input: EditorEvaluationInput, defects: EvaluationDefect[]): EvaluationMetricResult {
  const postClips = clipMap(input.postProject);
  const execution = input.executionResult;
  const observations: EvaluationObservation[] = [];
  if (execution?.status === "FAILED") {
    observations.push(Object.freeze({ status: "FAIL", code: "EXECUTION_FAILED", message: "审核后的规范编辑未能原子执行。" }));
    defects.push(defect({
      metric: "REQUIREMENT_COMPLETION", severity: "FAIL", code: "EXECUTION_FAILED",
      expected: "审核后的动作批次成功执行或确认无需改变", observed: execution.failureCode ?? "FAILED",
      evidence: Object.freeze([{ key: "executionStatus", value: execution.status }, { key: "failureCode", value: execution.failureCode ?? null }]),
      repairEligibility: "UNSUPPORTED",
    }));
  }
  for (const reviewed of input.reviewedPlan.reviewedEntries) {
    const decision = input.humanReviewState.entries.find((item) => item.proposalEntryId === reviewed.proposalEntryId);
    if (reviewed.decision === "REJECTED") {
      observations.push(Object.freeze({
        status: "PASS", code: "INTENTIONAL_NOT_EXECUTED", intervalId: reviewed.intervalId,
        reviewDecision: "REJECTED", message: "用户已拒绝该建议；未执行是预期结果。",
      }));
      continue;
    }
    const action = reviewed.action;
    const expectedAssetId = intendedAsset(reviewed);
    const clip = action ? postClips.get(action.targetId) : undefined;
    const run = execution && reviewed.reviewedActionIndex !== undefined
      ? execution.actionResults.find((item) => item.actionIndex === reviewed.reviewedActionIndex)
      : undefined;
    const common = {
      intervalId: reviewed.intervalId,
      ...(action ? { clipId: action.targetId } : {}),
      ...(expectedAssetId ? { assetId: expectedAssetId, expectedAssetId } : {}),
      reviewDecision: reviewed.decision,
    } as const;
    if (!action || !expectedAssetId || !clip) {
      observations.push(Object.freeze({ ...common, status: "FAIL", code: "TARGET_CLIP_MISSING", message: "审核目标片段在真实执行后项目中不存在。" }));
      defects.push(defect({
        metric: "REQUIREMENT_COMPLETION", severity: "FAIL", code: "TARGET_CLIP_MISSING",
        intervalId: reviewed.intervalId, ...(action ? { clipId: action.targetId } : {}), ...(expectedAssetId ? { assetId: expectedAssetId } : {}),
        expected: expectedAssetId ?? "存在审核目标片段", observed: "目标片段不存在",
        evidence: Object.freeze([{ key: "reviewDecision", value: reviewed.decision }]), repairEligibility: "DETERMINISTIC_REPAIR_POSSIBLE",
        candidateAssetIds: safeAlternatives(input, reviewed.intervalId, expectedAssetId),
      }));
      continue;
    }
    if (clip.assetId !== expectedAssetId) {
      observations.push(Object.freeze({ ...common, observedAssetId: clip.assetId, status: "FAIL", code: "INTENDED_STATE_NOT_REALIZED", message: "真实项目中的素材指派与人工审核结果不一致。" }));
      defects.push(defect({
        metric: "REQUIREMENT_COMPLETION", severity: "FAIL", code: "INTENDED_STATE_NOT_REALIZED",
        intervalId: reviewed.intervalId, clipId: clip.id, assetId: expectedAssetId,
        expected: expectedAssetId, observed: clip.assetId,
        evidence: Object.freeze([{ key: "reviewDecision", value: reviewed.decision }, { key: "actionResult", value: run?.status ?? null }]),
        repairEligibility: "DETERMINISTIC_REPAIR_POSSIBLE",
        candidateAssetIds: safeAlternatives(input, reviewed.intervalId, clip.assetId),
      }));
      continue;
    }
    if (!run || !["APPLIED", "NO_OP"].includes(run.status)) {
      observations.push(Object.freeze({ ...common, observedAssetId: clip.assetId, status: "FAIL", code: "EXECUTION_EVIDENCE_CONFLICT", message: "真实项目满足审核结果，但规范执行证据与该状态不一致。" }));
      defects.push(defect({
        metric: "REQUIREMENT_COMPLETION", severity: "FAIL", code: "EXECUTION_EVIDENCE_CONFLICT",
        intervalId: reviewed.intervalId, clipId: clip.id, assetId: expectedAssetId,
        expected: "APPLIED 或 NO_OP", observed: run?.status ?? "缺少动作结果",
        evidence: Object.freeze([{ key: "actualAssetId", value: clip.assetId }]), repairEligibility: "UNSUPPORTED",
      }));
      continue;
    }
    observations.push(Object.freeze({
      ...common, observedAssetId: clip.assetId, status: "PASS", code: "REVIEWED_INTENT_REALIZED",
      message: reviewed.decision === "MODIFIED" ? "已按用户修改使用可信替代素材。" : "已按用户接受的建议完成素材指派。",
    }));
  }
  return metric("REQUIREMENT_COMPLETION", observations);
}

type ActualRow = Readonly<{
  interval: MatchingInterval;
  reviewed: ReviewedCompiledPlan["reviewedEntries"][number];
  decision: HumanReviewState["entries"][number];
  clip?: TimelineClip;
  analysis?: VideoSemanticAnalysis;
  score?: CandidateMatchScore;
  segments: readonly VideoSemanticSegment[];
}>;

function actualRows(input: EditorEvaluationInput): readonly ActualRow[] {
  const postClips = clipMap(input.postProject);
  const analyses = new Map(input.videoSemanticEvidence.map((item) => [item.assetId, item]));
  return Object.freeze(input.proposalBundle.matchingIntervals.map((interval) => {
    const proposalEntry = input.proposalBundle.proposalEntries.find((item) => item.intervalId === interval.id)!;
    const reviewed = input.reviewedPlan.reviewedEntries.find((item) => item.intervalId === interval.id)!;
    const decision = input.humanReviewState.entries.find((item) => item.proposalEntryId === proposalEntry.proposalEntryId)!;
    const targetId = reviewed.action?.targetId ?? proposalEntry.targetId;
    const clip = targetId ? postClips.get(targetId) : undefined;
    const analysis = clip ? analyses.get(clip.assetId) : undefined;
    const projectAsset = clip ? input.postProject.assets.find((asset) => asset.id === clip.assetId) : undefined;
    const ranked = analysis && projectAsset ? rankMultimodalCandidates({
      interval,
      assets: [{ assetId: analysis.assetId, sourceDurationMs: projectAsset.durationMs, semanticSegments: analysis.segments }],
    }) : undefined;
    const score = ranked?.candidates[0]
      ?? input.proposalBundle.rankedCandidateSets.find((item) => item.intervalId === interval.id)
        ?.candidates.find((candidate) => candidate.assetId === clip?.assetId);
    const supportingIds = new Set(score?.supportingSegmentIds ?? []);
    return Object.freeze({
      interval, reviewed, decision, ...(clip ? { clip } : {}), ...(analysis ? { analysis } : {}), ...(score ? { score } : {}),
      segments: Object.freeze((analysis?.segments ?? []).filter((segment) => supportingIds.has(segment.id))),
    });
  }));
}

function semanticMatch(input: EditorEvaluationInput, rows: readonly ActualRow[], defects: EvaluationDefect[]): EvaluationMetricResult {
  const observations: EvaluationObservation[] = [];
  for (const row of rows) {
    if (row.decision.status === "REJECTED") continue;
    if (!row.clip || !row.analysis || !row.score) {
      observations.push(Object.freeze({ status: "NOT_EVALUABLE", code: "MISSING_SEMANTIC_EVIDENCE", intervalId: row.interval.id, clipId: row.clip?.id, assetId: row.clip?.assetId, message: "缺少最终素材的可信语义证据，无法判断。" }));
      defects.push(defect({
        metric: "SEMANTIC_MATCH", severity: "NOT_EVALUABLE", code: "MISSING_SEMANTIC_EVIDENCE",
        intervalId: row.interval.id, ...(row.clip ? { clipId: row.clip.id, assetId: row.clip.assetId } : {}),
        expected: "最终素材具有可信视频语义证据", observed: "证据缺失",
        evidence: Object.freeze([{ key: "intervalConcepts", value: row.interval.concepts }]), repairEligibility: "PROVIDER_REPLAN_MAY_BE_REQUIRED",
      }));
      continue;
    }
    const clears = row.score.semanticScore + MATCHING_THRESHOLD_EPSILON >= MINIMUM_SEMANTIC_SCORE;
    if (!clears) {
      const protectedDecision = row.decision.status === "MODIFIED";
      observations.push(Object.freeze({ status: "WARNING", code: "LOW_SEMANTIC_SUPPORT", intervalId: row.interval.id, clipId: row.clip.id, assetId: row.clip.assetId, message: "最终素材与该区间的语义支持较弱。" }));
      defects.push(defect({
        metric: "SEMANTIC_MATCH", severity: "WARNING", code: "LOW_SEMANTIC_SUPPORT",
        intervalId: row.interval.id, clipId: row.clip.id, assetId: row.clip.assetId,
        expected: `semanticScore >= ${MINIMUM_SEMANTIC_SCORE}`, observed: String(row.score.semanticScore),
        evidence: Object.freeze([{ key: "matchedConcepts", value: row.score.matchedConcepts }, { key: "supportingSegmentIds", value: row.score.supportingSegmentIds }]),
        repairEligibility: protectedDecision ? "HUMAN_DECISION_PROTECTED"
          : safeAlternatives(input, row.interval.id, row.clip.assetId).length ? "DETERMINISTIC_REPAIR_POSSIBLE" : "PROVIDER_REPLAN_MAY_BE_REQUIRED",
        candidateAssetIds: safeAlternatives(input, row.interval.id, row.clip.assetId),
      }));
    } else {
      observations.push(Object.freeze({ status: "PASS", code: "SEMANTIC_SUPPORT_ACCEPTED", intervalId: row.interval.id, clipId: row.clip.id, assetId: row.clip.assetId, message: "最终素材通过现有语义支持阈值。" }));
    }
  }
  return metric("SEMANTIC_MATCH", observations);
}

function rhythmAlignment(input: EditorEvaluationInput, rows: readonly ActualRow[], defects: EvaluationDefect[]): EvaluationMetricResult {
  const actionable = rows.filter((row) => row.decision.status !== "REJECTED" && row.clip)
    .sort((left, right) => left.clip!.timelineStartMs - right.clip!.timelineStartMs || left.clip!.id.localeCompare(right.clip!.id));
  if (!input.audioRhythmEvidence) {
    const observation = Object.freeze({ status: "NOT_EVALUABLE" as const, code: "RHYTHM_EVIDENCE_UNAVAILABLE", message: "当前会话没有可用的节奏证据，无法判断切点对齐。" });
    defects.push(defect({
      metric: "RHYTHM_ALIGNMENT", severity: "NOT_EVALUABLE", code: "RHYTHM_EVIDENCE_UNAVAILABLE",
      expected: "会话内 AudioRhythmAnalysis", observed: "证据缺失", evidence: Object.freeze([]), repairEligibility: "UNSUPPORTED",
    }));
    return metric("RHYTHM_ALIGNMENT", [observation]);
  }
  const observations: EvaluationObservation[] = [];
  actionable.slice(0, -1).forEach((row) => {
    const boundary = row.clip!.timelineEndMs;
    const evidence = rhythmEvidenceForInterval({ ...row.interval, timelineEndMs: boundary }, input.audioRhythmEvidence!);
    const markers = [
      evidence.nearestPauseToTimelineEnd ? { type: "PAUSE" as const, ...evidence.nearestPauseToTimelineEnd } : undefined,
      evidence.nearestOnsetToTimelineEnd ? { type: "ONSET" as const, ...evidence.nearestOnsetToTimelineEnd } : undefined,
    ].filter((item): item is { type: "PAUSE" | "ONSET"; rhythmSourceTimeMs: number; distanceMs: number } => Boolean(item))
      .sort((left, right) => left.distanceMs - right.distanceMs || left.rhythmSourceTimeMs - right.rhythmSourceTimeMs || left.type.localeCompare(right.type));
    const nearest = markers[0];
    if (!nearest) {
      observations.push(Object.freeze({ status: "NOT_EVALUABLE", code: "RHYTHM_EVIDENCE_UNAVAILABLE", intervalId: row.interval.id, clipId: row.clip!.id, alignment: "NOT_EVALUABLE", message: "该切点附近没有停顿或起音证据。" }));
      return;
    }
    const alignment = nearest.distanceMs <= EVALUATOR_RHYTHM_TOLERANCES.alignedMaxOffsetMs ? "ALIGNED"
      : nearest.distanceMs <= EVALUATOR_RHYTHM_TOLERANCES.nearMaxOffsetMs ? "NEAR" : "MISALIGNED";
    const status: EvaluationStatus = alignment === "ALIGNED" ? "PASS" : "WARNING";
    const code = alignment === "ALIGNED" ? "CUT_ALIGNED" : alignment === "NEAR" ? "CUT_NEAR_RHYTHM_MARKER" : "CUT_MISALIGNED";
    observations.push(Object.freeze({
      status, code, intervalId: row.interval.id, clipId: row.clip!.id, markerType: nearest.type,
      markerTimeMs: nearest.rhythmSourceTimeMs, offsetMs: nearest.distanceMs, alignment,
      message: `该切点距离最近${nearest.type === "PAUSE" ? "停顿" : "起音"} ${nearest.distanceMs} ms。`,
    }));
    if (status === "WARNING") defects.push(defect({
      metric: "RHYTHM_ALIGNMENT", severity: "WARNING", code: code as "CUT_NEAR_RHYTHM_MARKER" | "CUT_MISALIGNED",
      intervalId: row.interval.id, clipId: row.clip!.id,
      expected: `offsetMs <= ${EVALUATOR_RHYTHM_TOLERANCES.alignedMaxOffsetMs}`, observed: String(nearest.distanceMs),
      evidence: Object.freeze([{ key: "markerType", value: nearest.type }, { key: "markerTimeMs", value: nearest.rhythmSourceTimeMs }, { key: "captionBoundaryMs", value: row.interval.timelineEndMs }]),
      repairEligibility: row.decision.status === "MODIFIED" ? "HUMAN_DECISION_PROTECTED" : "DETERMINISTIC_REPAIR_POSSIBLE",
    }));
  });
  if (!observations.length) observations.push(Object.freeze({ status: "NOT_EVALUABLE", code: "RHYTHM_EVIDENCE_UNAVAILABLE", message: "没有可评估的内部切点。" }));
  return metric("RHYTHM_ALIGNMENT", observations);
}

type NarrativeCandidate = Readonly<{
  match: CandidateMatchScore;
  actions: readonly string[];
  subjectConcepts: readonly string[];
}>;

function narrativeCandidate(row: ActualRow): NarrativeCandidate | undefined {
  if (!row.score) return undefined;
  return Object.freeze({
    match: row.score,
    actions: Object.freeze([...new Set(row.segments.map((segment) => segment.action && normalizeMatchingConcept(segment.action)).filter((item): item is string => Boolean(item)))].sort()),
    subjectConcepts: Object.freeze([...new Set(row.segments.flatMap((segment) => segment.concepts.map(normalizeMatchingConcept)))].sort()),
  });
}

function transitionMetrics(rows: readonly ActualRow[], defects: EvaluationDefect[]): Readonly<[EvaluationMetricResult, EvaluationMetricResult]> {
  const ordered = rows.filter((row) => row.clip).sort((left, right) => left.clip!.timelineStartMs - right.clip!.timelineStartMs || left.clip!.id.localeCompare(right.clip!.id));
  const repetition: EvaluationObservation[] = [];
  const narrative: EvaluationObservation[] = [];
  const recent: string[] = [];
  let previous: NarrativeCandidate | undefined;
  ordered.forEach((row, index) => {
    const candidate = narrativeCandidate(row);
    if (!candidate) {
      if (index > 0) narrative.push(Object.freeze({ status: "NOT_EVALUABLE", code: "NARRATIVE_EVIDENCE_INSUFFICIENT", intervalId: row.interval.id, clipId: row.clip!.id, assetId: row.clip!.assetId, message: "语义或动作证据不足，无法判断叙事连续性。" }));
      previous = undefined;
      recent.push(row.clip!.assetId);
      return;
    }
    const transition = scoreNarrativeTransition(previous, candidate, recent);
    const repeated = transition.evidence.filter((item) => ["IMMEDIATE_ASSET_REPEAT", "ABA_ASSET_OSCILLATION", "RECENT_ASSET_REUSE"].includes(item.code));
    repeated.forEach((item) => {
      repetition.push(Object.freeze({ status: "WARNING", code: item.code, intervalId: row.interval.id, clipId: row.clip!.id, assetId: row.clip!.assetId, message: item.summary }));
      defects.push(defect({
        metric: "REPETITION", severity: "WARNING", code: item.code as "IMMEDIATE_ASSET_REPEAT" | "ABA_ASSET_OSCILLATION" | "RECENT_ASSET_REUSE",
        intervalId: row.interval.id, clipId: row.clip!.id, assetId: row.clip!.assetId,
        expected: "有界时间窗口内避免重复镜头模式", observed: item.code,
        evidence: Object.freeze([{ key: "fromAssetId", value: item.fromAssetId ?? null }, { key: "toAssetId", value: item.toAssetId }, { key: "priorIntervalDistance", value: item.priorIntervalDistance ?? null }]),
        repairEligibility: row.decision.status === "MODIFIED" || row.decision.status === "REJECTED" ? "HUMAN_DECISION_PROTECTED" : "DETERMINISTIC_REPAIR_POSSIBLE",
      }));
    });
    if (index > 0) {
      const narrativeEvidence = transition.evidence.filter((item) => ["ACTION_PROGRESSION_SUPPORTED", "ACTION_REGRESSION", "SUBJECT_CONTINUITY_PRESERVED"].includes(item.code));
      const regression = narrativeEvidence.find((item) => item.code === "ACTION_REGRESSION");
      if (regression) {
        narrative.push(Object.freeze({ status: "WARNING", code: regression.code, intervalId: row.interval.id, clipId: row.clip!.id, assetId: row.clip!.assetId, message: regression.summary }));
        defects.push(defect({
          metric: "NARRATIVE_CONTINUITY", severity: "WARNING", code: "ACTION_REGRESSION",
          intervalId: row.interval.id, clipId: row.clip!.id, assetId: row.clip!.assetId,
          expected: "已授权动作序列保持前进或主体连续", observed: regression.summary,
          evidence: narrativeEvidence.map(evidenceItem),
          repairEligibility: row.decision.status === "MODIFIED" || row.decision.status === "REJECTED" ? "HUMAN_DECISION_PROTECTED" : "PROVIDER_REPLAN_MAY_BE_REQUIRED",
        }));
      } else if (narrativeEvidence.length) {
        narrativeEvidence.forEach((item) => narrative.push(Object.freeze({
          status: "PASS", code: item.code, intervalId: row.interval.id, clipId: row.clip!.id,
          assetId: row.clip!.assetId, message: item.summary,
        })));
      } else {
        narrative.push(Object.freeze({ status: "NOT_EVALUABLE", code: "NARRATIVE_EVIDENCE_INSUFFICIENT", intervalId: row.interval.id, clipId: row.clip!.id, assetId: row.clip!.assetId, message: "现有证据不足以判断动作进展或主体连续性。" }));
      }
    }
    previous = candidate;
    recent.push(row.clip!.assetId);
  });
  if (!repetition.length) repetition.push(Object.freeze({ status: "PASS", code: "NO_BOUNDED_REPETITION_PATTERN", message: "未发现相邻重复、A-B-A 振荡或有界过度复用。" }));
  if (!narrative.length) narrative.push(Object.freeze({ status: "NOT_EVALUABLE", code: "NARRATIVE_EVIDENCE_INSUFFICIENT", message: "没有足够的相邻区间用于叙事判断。" }));
  return Object.freeze([metric("REPETITION", repetition), metric("NARRATIVE_CONTINUITY", narrative)]);
}

function evidenceItem(item: NarrativeTransitionEvidence): EvaluationEvidenceItem {
  return Object.freeze({ key: item.code, value: item.summary });
}

function preservation(input: EditorEvaluationInput, defects: EvaluationDefect[]): EvaluationMetricResult {
  const before = input.executionResult?.preProject ?? input.proposalBundle.trustedPreExecutionProject;
  const after = input.postProject;
  const targetIds = new Set(input.reviewedPlan.reviewedEntries.flatMap((entry) => entry.action ? [entry.action.targetId] : []));
  const beforeClips = clipMap(before);
  const afterClips = clipMap(after);
  const changes: string[] = [];
  const check = (label: string, left: unknown, right: unknown) => { if (stable(left) !== stable(right)) changes.push(label); };
  check("project.id", before.id, after.id);
  check("project.schemaVersion", before.schemaVersion, after.schemaVersion);
  check("project.title", before.title, after.title);
  check("project.durationMs", before.durationMs, after.durationMs);
  check("project.ratio", before.ratio, after.ratio);
  check("project.captions", before.captions, after.captions);
  check("project.audioSelection", before.audioSelection, after.audioSelection);
  check("project.assets", before.assets, after.assets);
  check("project.trackIdentityOrder", before.tracks.map(({ id, type, name, muted, locked }) => ({ id, type, name, muted, locked })), after.tracks.map(({ id, type, name, muted, locked }) => ({ id, type, name, muted, locked })));
  check("project.clipIdentityOrder", before.tracks.map((track) => track.clips.map((clip) => clip.id)), after.tracks.map((track) => track.clips.map((clip) => clip.id)));
  for (const [clipId, beforeClip] of beforeClips) {
    const afterClip = afterClips.get(clipId);
    if (!afterClip) { changes.push(`clip.${clipId}.missing`); continue; }
    if (!targetIds.has(clipId)) check(`clip.${clipId}.unrelated`, beforeClip, afterClip);
    else {
      check(`clip.${clipId}.timeline`, [beforeClip.trackId, beforeClip.timelineStartMs, beforeClip.timelineEndMs], [afterClip.trackId, afterClip.timelineStartMs, afterClip.timelineEndMs]);
      check(`clip.${clipId}.transform`, beforeClip.transform, afterClip.transform);
      const executedClip = input.executionResult ? clipMap(input.executionResult.postProject).get(clipId) : undefined;
      if (executedClip) check(`clip.${clipId}.speedCurve`, executedClip.speedCurve, afterClip.speedCurve);
    }
  }
  for (const clipId of afterClips.keys()) if (!beforeClips.has(clipId)) changes.push(`clip.${clipId}.unexpected`);
  const observations: EvaluationObservation[] = [];
  if (changes.length) {
    observations.push(Object.freeze({ status: "FAIL", code: "PROTECTED_STATE_REGRESSION", message: `检测到 ${changes.length} 项非授权状态变化。` }));
    defects.push(defect({
      metric: "PRESERVATION", severity: "FAIL", code: "PROTECTED_STATE_REGRESSION",
      expected: "字幕、音频、画幅、时长、轨道、无关片段、变换与素材注册表保持不变", observed: changes.join(", "),
      evidence: Object.freeze([{ key: "unexpectedChanges", value: Object.freeze(changes) }]), repairEligibility: "UNSUPPORTED",
    }));
  } else observations.push(Object.freeze({ status: "PASS", code: "PROTECTED_STATE_PRESERVED", message: "受保护的工程状态保持不变。" }));
  return metric("PRESERVATION", observations);
}

function durationOutcome(
  input: EditorEvaluationInput,
  hardProtectionCompliant: boolean,
): EditorEvaluationReport["summary"]["durationOutcome"] {
  const policy = input.resolvedDurationPolicy;
  if (!policy || policy.policy !== "CLOSEST_SAFELY_ACHIEVABLE") return undefined;
  return Object.freeze({
    policy: policy.policy,
    requestedDurationMs: policy.requestedDurationMs,
    achievedDurationMs: input.postProject.durationMs,
    remainingTargetGapMs: Math.max(0, input.postProject.durationMs - policy.requestedDurationMs),
    hardProtectionCompliant,
  });
}

function noActionsReport(input: EditorEvaluationInput): EditorEvaluationReport {
  const postProjectFingerprint = createEditorProjectFingerprint(input.postProject);
  const rejectedCount = input.humanReviewState.entries.filter((entry) => entry.status === "REJECTED").length;
  const requirement = metric("REQUIREMENT_COMPLETION", input.humanReviewState.entries.map((entry) => Object.freeze({
    status: "PASS" as const, code: "INTENTIONAL_NOT_EXECUTED", intervalId: entry.intervalId, reviewDecision: "REJECTED" as const,
    message: "用户已拒绝该建议；未执行是预期结果。",
  })));
  const unavailable = (name: EvaluationMetric) => metric(name, [Object.freeze({ status: "NOT_EVALUABLE" as const, code: "NO_EXECUTED_ACTIONS", message: "没有已执行动作需要评估。" })]);
  const defects: EvaluationDefect[] = [];
  const hardConstraints = hardConstraintCompliance(input, defects);
  const metricResults = Object.freeze([
    hardConstraints, requirement, unavailable("SEMANTIC_MATCH"), unavailable("RHYTHM_ALIGNMENT"), unavailable("REPETITION"), unavailable("NARRATIVE_CONTINUITY"),
    metric("PRESERVATION", [Object.freeze({ status: "PASS", code: "NO_PROJECT_CHANGE", message: "未执行动作，工程保持不变。" })]),
  ]);
  const evaluationId = `evaluation-${hash(stable({ version: EDITOR_EVALUATOR_VERSION, proposalId: input.proposalBundle.proposalId, review: input.humanReviewState.entries, postProjectFingerprint }))}`;
  return Object.freeze({
    schemaVersion: EDITOR_EVALUATION_SCHEMA_VERSION, evaluatorVersion: EDITOR_EVALUATOR_VERSION, evaluationId,
    sourceProposalId: input.proposalBundle.proposalId, postProjectFingerprint,
    overallStatus: hardConstraints.status === "FAIL" ? "FAIL" : "NO_EXECUTED_ACTIONS",
    metricResults, defects: Object.freeze(defects), warnings: Object.freeze([]), notEvaluable: Object.freeze([]),
    summary: Object.freeze({
      acceptedCount: 0, modifiedCount: 0, rejectedCount, intendedActionCount: 0, realizedActionCount: 0,
      failedRequirementCount: 0, warningCount: 0, notEvaluableCount: 0,
      ...(durationOutcome(input, hardConstraints.status === "PASS") ? { durationOutcome: durationOutcome(input, hardConstraints.status === "PASS") } : {}),
    }),
  });
}

/**
 * Deterministically evaluates final human-reviewed intent against the actual
 * post-execution project. Quality evidence never overrides human decisions.
 * This function is read-only and cannot compile, execute, repair, or replan.
 */
export function evaluateEditorExecution(input: EditorEvaluationInput): EditorEvaluationReport {
  validateInput(input);
  if (input.humanReviewState.lifecycle === "REVIEWED_NO_ACTIONS") return noActionsReport(input);
  const defects: EvaluationDefect[] = [];
  const hardConstraints = hardConstraintCompliance(input, defects);
  const requirement = requirementCompletion(input, defects);
  const preserved = preservation(input, defects);
  const rows = actualRows(input);
  const executionFailed = input.executionResult?.status === "FAILED";
  const unavailableAfterFailure = (name: EvaluationMetric) => metric(name, [Object.freeze({
    status: "NOT_EVALUABLE" as const,
    code: "EXECUTION_FAILED",
    message: "规范执行已原子失败，不对未形成的目标状态进行质量判断。",
  })]);
  const semantic = executionFailed ? unavailableAfterFailure("SEMANTIC_MATCH") : semanticMatch(input, rows, defects);
  const rhythm = executionFailed ? unavailableAfterFailure("RHYTHM_ALIGNMENT") : rhythmAlignment(input, rows, defects);
  const [repetition, narrative] = executionFailed
    ? [unavailableAfterFailure("REPETITION"), unavailableAfterFailure("NARRATIVE_CONTINUITY")] as const
    : transitionMetrics(rows, defects);
  const byMetric = new Map([hardConstraints, requirement, semantic, rhythm, repetition, narrative, preserved].map((item) => [item.metric, item]));
  const metricResults = Object.freeze(METRIC_ORDER.map((name) => byMetric.get(name)!));
  const structural = [hardConstraints, requirement, preserved];
  const overallStatus: EvaluationOverallStatus = structural.some((item) => item.status === "FAIL") ? "FAIL"
    : structural.some((item) => item.status === "NOT_EVALUABLE") ? "NOT_EVALUABLE"
      : metricResults.some((item) => item.status === "WARNING") ? "PASS_WITH_WARNINGS" : "PASS";
  const orderedDefects = Object.freeze([...defects].sort((left, right) =>
    METRIC_ORDER.indexOf(left.metric) - METRIC_ORDER.indexOf(right.metric)
    || (left.intervalId ?? "").localeCompare(right.intervalId ?? "")
    || left.code.localeCompare(right.code)
    || left.id.localeCompare(right.id)));
  const postProjectFingerprint = createEditorProjectFingerprint(input.postProject);
  const evaluationId = `evaluation-${hash(stable({
    version: EDITOR_EVALUATOR_VERSION,
    proposalId: input.proposalBundle.proposalId,
    review: input.humanReviewState.entries,
    reviewedPlan: input.reviewedPlan.reviewedEntries,
    executionFingerprint: input.executionResult?.executionFingerprint ?? null,
    postProjectFingerprint,
  }))}`;
  const acceptedCount = input.humanReviewState.entries.filter((entry) => entry.status === "ACCEPTED").length;
  const modifiedCount = input.humanReviewState.entries.filter((entry) => entry.status === "MODIFIED").length;
  const rejectedCount = input.humanReviewState.entries.filter((entry) => entry.status === "REJECTED").length;
  const intendedActionCount = input.reviewedPlan.reviewedEntries.filter((entry) => entry.decision !== "REJECTED" && entry.action).length;
  const realizedActionCount = requirement.observations.filter((item) => item.code === "REVIEWED_INTENT_REALIZED").length;
  const warnings = Object.freeze(orderedDefects.filter((item) => item.severity === "WARNING").map((item) => item.id));
  const notEvaluable = Object.freeze(orderedDefects.filter((item) => item.severity === "NOT_EVALUABLE").map((item) => item.id));
  return Object.freeze({
    schemaVersion: EDITOR_EVALUATION_SCHEMA_VERSION,
    evaluatorVersion: EDITOR_EVALUATOR_VERSION,
    evaluationId,
    sourceProposalId: input.proposalBundle.proposalId,
    ...(input.executionResult ? { executionFingerprint: input.executionResult.executionFingerprint } : {}),
    postProjectFingerprint,
    overallStatus,
    metricResults,
    defects: orderedDefects,
    warnings,
    notEvaluable,
    summary: Object.freeze({
      acceptedCount, modifiedCount, rejectedCount, intendedActionCount, realizedActionCount,
      failedRequirementCount: requirement.observations.filter((item) => item.status === "FAIL").length,
      warningCount: warnings.length,
      notEvaluableCount: notEvaluable.length,
      ...(durationOutcome(input, hardConstraints.status === "PASS") ? { durationOutcome: durationOutcome(input, hardConstraints.status === "PASS") } : {}),
    }),
  });
}
