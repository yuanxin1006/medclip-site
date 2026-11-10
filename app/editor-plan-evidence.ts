import type { EditorProject, TimelineClip } from "./editor-core.ts";
import type { MatchingInterval, RankedCandidateSet } from "./editor-multimodal-matching.ts";
import type { NarrativeSequencePlan, NarrativeTransitionEvidence } from "./editor-narrative-planner.ts";
import type { CompiledNarrativeActionPlan } from "./editor-narrative-action-compiler.ts";
import type { CompiledPlanExecutionResult } from "./editor-compiled-plan-execution.ts";
import type { ConstraintSetV1 } from "./editor-constraints.ts";
import type { ProposalConstraintContextV1 } from "./editor-constraint-negotiation.ts";

export const PLAN_EVIDENCE_SCHEMA_VERSION = 2 as const;
export const PLAN_EVIDENCE_LIMITS = Object.freeze({ maxEntries: 128, maxAlternatives: 3, maxTextLength: 240 });

export type PlanEvidenceLifecycleStatus = "PENDING_REVIEW" | "REVIEWED_NO_ACTIONS" | "EXECUTED" | "EXECUTION_FAILED";
export type PlanEvidenceStatus = "PENDING_REVIEW" | "APPLIED" | "NO_OP" | "FAILED" | "NOT_EXECUTED" | "UNRESOLVED";
export type HumanReviewProvenance = "USER_ACCEPTED" | "USER_REJECTED" | "USER_MODIFIED";
export type PlanEvidenceEntry = Readonly<{
  id: string;
  proposalEntryId: string;
  intervalId: string;
  interval: Readonly<{ startMs: number; endMs: number; caption: string; concepts: readonly string[] }>;
  selectedAssetId?: string;
  matching?: Readonly<{
    semanticScore: number; usabilityScore: number; timingScore: number; repetitionPenalty: number;
    totalScore: number; matchedConcepts: readonly string[]; supportingSegmentIds: readonly string[];
    supportingSourceRanges: readonly Readonly<{ segmentId: string; sourceStartMs: number; sourceEndMs: number; confidence: number; usability: number; matchedConcepts: readonly string[] }>[];
    evidenceFrameMs: readonly number[];
    rejectedAlternatives: readonly Readonly<{ assetId: string; totalScore: number; semanticScore: number }>[];
    rhythmEvidence?: RankedCandidateSet["rhythmEvidence"];
  }>;
  narrative?: Readonly<{ scoreDelta: number; evidence: readonly NarrativeTransitionEvidence[] }>;
  compiledAction?: Readonly<{ actionIndex: number; actionType: string; targetId: string; assetId?: string; intervalId: string; validationStatus: string; mappingStatus: string; reason: string }>;
  humanReview?: Readonly<{
    decision: "ACCEPTED" | "REJECTED" | "MODIFIED";
    provenance: HumanReviewProvenance;
    originalAssetId?: string;
    selectedAssetId?: string;
  }>;
  executedAction?: Readonly<{ actionIndex: number; actionType: string; targetId: string; assetId?: string; reason: string }>;
  executionDisposition?: "EXECUTED" | "EXECUTION_FAILED" | "NOT_EXECUTED_USER_REJECTED" | "NOT_EXECUTED_NO_ACTION";
  status: PlanEvidenceStatus;
  actionResultStatus?: string;
  failureCode?: string;
  currentProposed?: Readonly<{
    targetClipId: string; currentAssetId?: string; proposedAssetId?: string;
    timelineStartMs: number; timelineEndMs: number; currentSourceStartMs?: number; currentSourceEndMs?: number;
  }>;
  beforeAfter?: Readonly<{ targetClipId: string; assetBefore?: string; assetAfter?: string; timelineStartMs: number; timelineEndMs: number; sourceStartBeforeMs?: number; sourceEndBeforeMs?: number; sourceStartAfterMs?: number; sourceEndAfterMs?: number }>;
  explanation: string;
}>;

export type PlanEvidence = Readonly<{
  schemaVersion: typeof PLAN_EVIDENCE_SCHEMA_VERSION;
  planId: string;
  lifecycleStatus: PlanEvidenceLifecycleStatus;
  entries: readonly PlanEvidenceEntry[];
  summary: Readonly<{
    resolvedIntervalCount: number; unresolvedIntervalCount: number; compiledActionCount: number;
    averageSemanticScore: number | null; narrativeEvidenceAvailable: boolean; preProjectReference: string;
    execution?: Readonly<{
      status: CompiledPlanExecutionResult["status"]; fingerprint: string; postProjectReference: string;
      appliedCount: number; noOpCount: number; failedCount: number;
    }>;
    constraintLineage?: Readonly<{
      intentVersionId: string;
      constraintSetId: string;
      constraintFingerprint: string;
      confirmedBindingIds: readonly string[];
      resolutionIds: readonly string[];
    }>;
    constraintValidation?: Readonly<{
      status: string;
      constraintSetId?: string;
      constraintFingerprint?: string;
      violationIds: readonly string[];
    }>;
  }>;
  preservation?: Readonly<{
    captionsUnchanged: boolean; audioUnchanged: boolean; ratioUnchanged: boolean; durationUnchanged: boolean;
    unrelatedClipsUnchanged: boolean; transformsUnchanged: boolean; tracksUnchanged: boolean;
  }>;
}>;

export type PlanEvidenceInput = Readonly<{
  intervals: readonly MatchingInterval[];
  rankedCandidateSets: readonly RankedCandidateSet[];
  narrativePlan: NarrativeSequencePlan;
  compiledPlan: CompiledNarrativeActionPlan;
  preExecutionProject?: EditorProject;
  execution?: CompiledPlanExecutionResult;
  constraintSet?: ConstraintSetV1;
  constraintContext?: ProposalConstraintContextV1;
}>;

export class PlanEvidenceValidationError extends Error {
  constructor(message: string) { super(message); this.name = "PlanEvidenceValidationError"; }
}

function fail(message: string): never { throw new PlanEvidenceValidationError(message); }
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!plainRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
function clipMap(project: EditorProject) { return new Map(project.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip])); }

/** Fingerprint material project state only; timestamps, filenames and Blob URLs are never identity. */
export function createEditorProjectFingerprint(project: EditorProject): string {
  const { updatedAt: _updatedAt, ...material } = project;
  return `project-v1-${hash(stable(material))}`;
}

function explanation(entry: Omit<PlanEvidenceEntry, "explanation">): string {
  if (entry.status === "UNRESOLVED") return "没有找到足够可信的素材。";
  const concepts = entry.matching?.matchedConcepts ?? [];
  const match = concepts.length ? `素材支持「${concepts.slice(0, 2).join("、")}」` : "有结构化素材匹配证据";
  const narrative = entry.narrative?.evidence.some((item) => item.code === "ACTION_PROGRESSION_SUPPORTED")
    ? "，并承接前一段的内容进展" : entry.narrative?.evidence.some((item) => item.code === "SUBJECT_CONTINUITY_PRESERVED")
      ? "，并延续前一段的主体" : "";
  if (entry.status === "FAILED") return `${match}${narrative}；执行未完成。`;
  if (entry.status === "NO_OP") return `${match}${narrative}；执行后素材指派未改变。`;
  if (entry.status === "PENDING_REVIEW") return `${match}${narrative}；等待人工审核。`;
  return `${match}${narrative}。`;
}

function targetClipFor(
  link: CompiledNarrativeActionPlan["intervalActionMap"][number] | undefined,
  run: CompiledPlanExecutionResult["actionResults"][number] | undefined,
  clips: ReadonlyMap<string, TimelineClip>,
): TimelineClip | undefined {
  const targetId = link?.targetClipId ?? run?.targetId;
  return targetId ? clips.get(targetId) : undefined;
}

/** Build immutable deterministic evidence from V2.0 outputs, before or after execution. */
export function createPlanEvidence(value: unknown): PlanEvidence {
  if (!plainRecord(value)) fail("PlanEvidence input must be an object.");
  const input = value as unknown as PlanEvidenceInput;
  const { intervals, rankedCandidateSets, narrativePlan, compiledPlan, execution, constraintSet, constraintContext } = input;
  const preProject = execution?.preProject ?? input.preExecutionProject;
  if (!Array.isArray(intervals) || intervals.length > PLAN_EVIDENCE_LIMITS.maxEntries || !Array.isArray(rankedCandidateSets)
    || !narrativePlan || !Array.isArray(narrativePlan.intervalPlans) || !compiledPlan || !preProject
    || !Array.isArray(compiledPlan.intervalActionMap) || (execution && !Array.isArray(execution.actionResults))) fail("PlanEvidence input is malformed.");
  if (intervals.length !== rankedCandidateSets.length || intervals.length !== narrativePlan.intervalPlans.length) fail("PlanEvidence intervals and upstream evidence must align.");
  const before = clipMap(preProject);
  const after = execution ? clipMap(execution.postProject) : undefined;
  const entries: PlanEvidenceEntry[] = intervals.map((interval, index) => {
    const ranked: RankedCandidateSet = rankedCandidateSets[index]; const narrative = narrativePlan.intervalPlans[index];
    if (ranked.intervalId !== interval.id || narrative.intervalId !== interval.id) fail("PlanEvidence interval identities do not align.");
    const link = compiledPlan.intervalActionMap.find((item) => item.intervalId === interval.id);
    const run = execution && link?.actionIndex !== undefined ? execution.actionResults.find((item) => item.actionIndex === link.actionIndex) : undefined;
    const selectedAssetId = narrative.status === "resolved" ? narrative.assetId : undefined;
    const targetId = link?.targetClipId ?? run?.targetId;
    const beforeClip = targetClipFor(link, run, before);
    const afterClip = after ? targetClipFor(link, run, after) : undefined;
    const status: PlanEvidenceStatus = narrative.status === "unresolved" || link?.status === "UNRESOLVED" ? "UNRESOLVED"
      : !execution ? "PENDING_REVIEW"
        : run?.status === "NO_OP" || link?.status === "NO_ACTION_REQUIRED" ? "NO_OP"
          : run?.status === "FAILED" || run?.status === "ROLLED_BACK" || run?.status === "NOT_RUN" || execution.status === "FAILED" && link?.actionIndex !== undefined ? "FAILED"
            : run?.status === "APPLIED" ? "APPLIED" : "FAILED";
    const proposalEntryId = `e-${hash(`${interval.id}\u0000${link?.actionIndex ?? -1}\u0000${targetId ?? "unresolved"}\u0000${selectedAssetId ?? "none"}`)}`;
    const entryWithoutExplanation: Omit<PlanEvidenceEntry, "explanation"> = {
      id: proposalEntryId, proposalEntryId,
      intervalId: interval.id,
      interval: Object.freeze({ startMs: interval.timelineStartMs, endMs: interval.timelineEndMs, caption: interval.text, concepts: Object.freeze([...interval.concepts]) }),
      ...(selectedAssetId ? { selectedAssetId } : {}),
      ...(narrative.status === "resolved" ? { matching: Object.freeze({
        semanticScore: narrative.matchEvidence.semanticScore, usabilityScore: narrative.matchEvidence.usabilityScore,
        timingScore: narrative.matchEvidence.timingScore, repetitionPenalty: narrative.matchEvidence.repetitionPenalty,
        totalScore: narrative.matchEvidence.totalScore, matchedConcepts: narrative.matchEvidence.matchedConcepts,
        supportingSegmentIds: narrative.supportingSegmentIds, supportingSourceRanges: narrative.supportingSourceRanges,
        evidenceFrameMs: narrative.evidenceFrameMs,
        rejectedAlternatives: Object.freeze(ranked.candidates.filter((candidate) => candidate.assetId !== selectedAssetId).slice(0, PLAN_EVIDENCE_LIMITS.maxAlternatives).map((candidate) => Object.freeze({ assetId: candidate.assetId, totalScore: candidate.totalScore, semanticScore: candidate.semanticScore }))),
        ...(ranked.rhythmEvidence ? { rhythmEvidence: ranked.rhythmEvidence } : {}),
      }) } : {}),
      ...(narrative.status === "resolved" ? { narrative: Object.freeze({ scoreDelta: narrative.narrativeScore, evidence: narrative.transitionEvidence }) } : {}),
      ...(link?.actionIndex !== undefined && link.actionIndex < compiledPlan.canonicalPlan.actions.length ? { compiledAction: Object.freeze({
        actionIndex: link.actionIndex, actionType: compiledPlan.canonicalPlan.actions[link.actionIndex].type,
        targetId: compiledPlan.canonicalPlan.actions[link.actionIndex].targetId,
        ...(compiledPlan.canonicalPlan.actions[link.actionIndex].assetId ? { assetId: compiledPlan.canonicalPlan.actions[link.actionIndex].assetId } : {}),
        intervalId: link.intervalId, validationStatus: compiledPlan.status, mappingStatus: link.status,
        reason: compiledPlan.canonicalPlan.actions[link.actionIndex].reason,
      }) } : {}),
      status,
      ...(run ? { actionResultStatus: run.status } : {}),
      ...(execution && (run?.failureCode ?? execution.failureCode) ? { failureCode: run?.failureCode ?? execution.failureCode } : {}),
      ...(targetId ? { currentProposed: Object.freeze({ targetClipId: targetId,
        ...(beforeClip ? { currentAssetId: beforeClip.assetId, currentSourceStartMs: beforeClip.sourceInMs, currentSourceEndMs: beforeClip.sourceOutMs } : {}),
        ...(selectedAssetId ? { proposedAssetId: selectedAssetId } : {}),
        timelineStartMs: beforeClip?.timelineStartMs ?? interval.timelineStartMs,
        timelineEndMs: beforeClip?.timelineEndMs ?? interval.timelineEndMs,
      }) } : {}),
      ...(execution && targetId ? { beforeAfter: Object.freeze({ targetClipId: targetId,
        ...(beforeClip ? { assetBefore: beforeClip.assetId } : {}), ...(afterClip ? { assetAfter: afterClip.assetId } : {}),
        timelineStartMs: beforeClip?.timelineStartMs ?? interval.timelineStartMs, timelineEndMs: beforeClip?.timelineEndMs ?? interval.timelineEndMs,
        ...(beforeClip ? { sourceStartBeforeMs: beforeClip.sourceInMs, sourceEndBeforeMs: beforeClip.sourceOutMs } : {}),
        ...(afterClip ? { sourceStartAfterMs: afterClip.sourceInMs, sourceEndAfterMs: afterClip.sourceOutMs } : {}),
      }) } : {}),
    };
    return Object.freeze({ ...entryWithoutExplanation, explanation: explanation(entryWithoutExplanation) });
  });
  const resolved = entries.filter((entry) => entry.status !== "UNRESOLVED");
  const semanticScores = entries.flatMap((entry) => entry.matching ? [entry.matching.semanticScore] : []);
  const targetIds = new Set(entries.map((entry) => entry.currentProposed?.targetClipId).filter((id): id is string => Boolean(id)));
  const preservation = execution ? execution.preservation : undefined;
  const transformsUnchanged = execution && after ? [...targetIds].every((id) => {
    const a = before.get(id); const b = after.get(id); return !a || !b || stable(a.transform) === stable(b.transform);
  }) : undefined;
  const material = { sourceProjectFingerprint: createEditorProjectFingerprint(preProject), intervals, narrativePlan, compiledPlan, constraintContext: constraintContext ?? null };
  return Object.freeze({
    schemaVersion: PLAN_EVIDENCE_SCHEMA_VERSION,
    planId: `plan-${hash(stable(material))}`,
    lifecycleStatus: execution ? execution.status === "FAILED" ? "EXECUTION_FAILED" : "EXECUTED" : "PENDING_REVIEW",
    entries: Object.freeze(entries),
    summary: Object.freeze({
      resolvedIntervalCount: resolved.length,
      unresolvedIntervalCount: entries.length - resolved.length,
      compiledActionCount: compiledPlan.canonicalPlan.actions.length,
      averageSemanticScore: semanticScores.length ? semanticScores.reduce((sum, score) => sum + score, 0) / semanticScores.length : null,
      narrativeEvidenceAvailable: entries.some((entry) => Boolean(entry.narrative)),
      preProjectReference: createEditorProjectFingerprint(preProject),
      ...(execution ? { execution: Object.freeze({
        status: execution.status, fingerprint: execution.executionFingerprint,
        postProjectReference: createEditorProjectFingerprint(execution.postProject),
        appliedCount: execution.appliedActionCount, noOpCount: execution.noOpActionCount,
        failedCount: entries.filter((entry) => entry.status === "FAILED").length,
      }) } : {}),
      ...(constraintSet && constraintContext ? { constraintLineage: Object.freeze({
        intentVersionId: constraintContext.sourceIntentVersionId,
        constraintSetId: constraintContext.sourceConstraintSetId,
        constraintFingerprint: constraintContext.sourceConstraintFingerprint,
        confirmedBindingIds: Object.freeze(constraintSet.confirmedBindings.map((binding) => binding.bindingId)),
        resolutionIds: Object.freeze([...constraintContext.resolutionIds]),
      }) } : {}),
      ...(execution?.constraintEnforcement ? { constraintValidation: Object.freeze({
        status: execution.constraintEnforcement.status,
        ...(execution.constraintEnforcement.constraintSetId ? { constraintSetId: execution.constraintEnforcement.constraintSetId } : {}),
        ...(execution.constraintEnforcement.constraintFingerprint ? { constraintFingerprint: execution.constraintEnforcement.constraintFingerprint } : {}),
        violationIds: Object.freeze(execution.constraintEnforcement.violations.map((item) => item.violationId)),
      }) } : {}),
    }),
    ...(preservation && transformsUnchanged !== undefined ? { preservation: Object.freeze({
      captionsUnchanged: preservation.captionsPreserved, audioUnchanged: preservation.audioSelectionPreserved,
      ratioUnchanged: preservation.projectRatioPreserved, durationUnchanged: preservation.projectDurationPreserved,
      unrelatedClipsUnchanged: preservation.unrelatedClipsPreserved, transformsUnchanged,
      tracksUnchanged: preservation.trackIdentityAndOrderPreserved && preservation.clipIdentityAndOrderPreserved,
    }) } : {}),
  });
}

/** Reject malformed external evidence before display or downstream review. */
export function parsePlanEvidence(value: unknown): PlanEvidence {
  if (!plainRecord(value) || value.schemaVersion !== PLAN_EVIDENCE_SCHEMA_VERSION || typeof value.planId !== "string"
    || !["PENDING_REVIEW", "REVIEWED_NO_ACTIONS", "EXECUTED", "EXECUTION_FAILED"].includes(String(value.lifecycleStatus))
    || !Array.isArray(value.entries) || !plainRecord(value.summary)) fail("PlanEvidence is malformed or has an unsupported version.");
  if (value.entries.length > PLAN_EVIDENCE_LIMITS.maxEntries) fail("PlanEvidence exceeds the supported entry count.");
  if (!value.planId.startsWith("plan-") || !Number.isInteger(value.summary.resolvedIntervalCount)
    || !Number.isInteger(value.summary.unresolvedIntervalCount) || !Number.isInteger(value.summary.compiledActionCount)
    || !(value.summary.averageSemanticScore === null || typeof value.summary.averageSemanticScore === "number")
    || typeof value.summary.narrativeEvidenceAvailable !== "boolean" || typeof value.summary.preProjectReference !== "string") fail("PlanEvidence summary is invalid.");
  if (value.summary.constraintLineage !== undefined && (!plainRecord(value.summary.constraintLineage)
    || typeof value.summary.constraintLineage.intentVersionId !== "string"
    || typeof value.summary.constraintLineage.constraintSetId !== "string"
    || typeof value.summary.constraintLineage.constraintFingerprint !== "string"
    || !Array.isArray(value.summary.constraintLineage.confirmedBindingIds)
    || !Array.isArray(value.summary.constraintLineage.resolutionIds))) {
    fail("PlanEvidence constraint lineage is invalid.");
  }
  if (value.summary.constraintValidation !== undefined && (!plainRecord(value.summary.constraintValidation)
    || typeof value.summary.constraintValidation.status !== "string"
    || !Array.isArray(value.summary.constraintValidation.violationIds))) {
    fail("PlanEvidence constraint validation is invalid.");
  }
  if (["PENDING_REVIEW", "REVIEWED_NO_ACTIONS"].includes(String(value.lifecycleStatus)) && value.summary.execution !== undefined) fail("Pre-execution evidence must not contain execution evidence.");
  if (["PENDING_REVIEW", "REVIEWED_NO_ACTIONS"].includes(String(value.lifecycleStatus)) && value.preservation !== undefined) fail("Pre-execution evidence must not contain post-execution preservation claims.");
  if (value.lifecycleStatus === "EXECUTED" || value.lifecycleStatus === "EXECUTION_FAILED") {
    if (!plainRecord(value.summary.execution)
      || !["APPLIED", "NO_OP", "FAILED"].includes(String(value.summary.execution.status))
      || typeof value.summary.execution.fingerprint !== "string"
      || typeof value.summary.execution.postProjectReference !== "string"
      || !Number.isInteger(value.summary.execution.appliedCount)
      || !Number.isInteger(value.summary.execution.noOpCount)
      || !Number.isInteger(value.summary.execution.failedCount)
      || !plainRecord(value.preservation)) fail("Executed evidence requires a valid execution and preservation summary.");
    if ((value.lifecycleStatus === "EXECUTED" && value.summary.execution.status === "FAILED")
      || (value.lifecycleStatus === "EXECUTION_FAILED" && value.summary.execution.status !== "FAILED")) {
      fail("PlanEvidence lifecycle and execution result are inconsistent.");
    }
    for (const key of ["captionsUnchanged", "audioUnchanged", "ratioUnchanged", "durationUnchanged", "unrelatedClipsUnchanged", "transformsUnchanged", "tracksUnchanged"] as const) {
      if (typeof value.preservation[key] !== "boolean") fail("PlanEvidence preservation summary is invalid.");
    }
  }
  const ids = new Set<string>();
  for (const item of value.entries) {
    if (!plainRecord(item) || typeof item.id !== "string" || item.proposalEntryId !== item.id || ids.has(item.id)
      || !["PENDING_REVIEW", "APPLIED", "NO_OP", "FAILED", "NOT_EXECUTED", "UNRESOLVED"].includes(String(item.status))
      || !item.id.startsWith("e-") || typeof item.intervalId !== "string" || !plainRecord(item.interval)
      || !Number.isSafeInteger(item.interval.startMs) || !Number.isSafeInteger(item.interval.endMs)
      || Number(item.interval.endMs) <= Number(item.interval.startMs) || typeof item.interval.caption !== "string"
      || !Array.isArray(item.interval.concepts) || typeof item.explanation !== "string") fail("PlanEvidence contains an invalid entry.");
    if (value.lifecycleStatus === "PENDING_REVIEW" && (item.status === "APPLIED" || item.status === "NO_OP" || item.status === "FAILED" || item.status === "NOT_EXECUTED" || item.beforeAfter !== undefined || item.actionResultStatus !== undefined)) {
      fail("Pending evidence contains fabricated execution state.");
    }
    if (value.lifecycleStatus === "PENDING_REVIEW" && (item.humanReview !== undefined || item.executedAction !== undefined || item.executionDisposition !== undefined)) {
      fail("Pending evidence contains fabricated human review or execution provenance.");
    }
    if ((value.lifecycleStatus === "EXECUTED" || value.lifecycleStatus === "EXECUTION_FAILED" || value.lifecycleStatus === "REVIEWED_NO_ACTIONS") && item.status === "PENDING_REVIEW") fail("Reviewed evidence contains a pending entry.");
    if (item.humanReview !== undefined) {
      if (!plainRecord(item.humanReview)
        || !["ACCEPTED", "REJECTED", "MODIFIED"].includes(String(item.humanReview.decision))
        || !["USER_ACCEPTED", "USER_REJECTED", "USER_MODIFIED"].includes(String(item.humanReview.provenance))
        || (item.humanReview.decision === "ACCEPTED" && item.humanReview.provenance !== "USER_ACCEPTED")
        || (item.humanReview.decision === "REJECTED" && item.humanReview.provenance !== "USER_REJECTED")
        || (item.humanReview.decision === "MODIFIED" && (item.humanReview.provenance !== "USER_MODIFIED"
          || typeof item.humanReview.originalAssetId !== "string" || typeof item.humanReview.selectedAssetId !== "string"))) {
        fail("PlanEvidence contains invalid human review provenance.");
      }
      if (item.humanReview.decision === "REJECTED" && (item.executedAction !== undefined || item.beforeAfter !== undefined || item.actionResultStatus !== undefined
        || item.executionDisposition !== "NOT_EXECUTED_USER_REJECTED" || item.status !== "NOT_EXECUTED")) {
        fail("Rejected evidence must remain visibly unexecuted.");
      }
    }
    if (item.executedAction !== undefined && (!plainRecord(item.executedAction)
      || !Number.isInteger(item.executedAction.actionIndex) || typeof item.executedAction.actionType !== "string"
      || typeof item.executedAction.targetId !== "string" || typeof item.executedAction.reason !== "string")) {
      fail("PlanEvidence contains an invalid executed action reference.");
    }
    if (item.executionDisposition !== undefined && !["EXECUTED", "EXECUTION_FAILED", "NOT_EXECUTED_USER_REJECTED", "NOT_EXECUTED_NO_ACTION"].includes(String(item.executionDisposition))) {
      fail("PlanEvidence contains an invalid execution disposition.");
    }
    ids.add(item.id);
  }
  return value as unknown as PlanEvidence;
}

export function planEvidenceReferences(evidence: PlanEvidence, execution?: CompiledPlanExecutionResult) {
  return Object.freeze({
    preProjectReference: evidence.summary.preProjectReference,
    ...(execution ? { postProjectReference: createEditorProjectFingerprint(execution.postProject), executionFingerprint: execution.executionFingerprint } : {}),
  });
}
