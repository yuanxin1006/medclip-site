import { cloneProject, type EditorProject, type TimelineClip } from "./editor-core.ts";
import { parseAIEditingPlan, type EditorAIPlanAction } from "./editor-ai-requirements.ts";
import { candidateClearsMatchingThresholds, type CandidateMatchScore } from "./editor-multimodal-matching.ts";
import type { CompiledNarrativeActionPlan, IntervalActionLink } from "./editor-narrative-action-compiler.ts";
import {
  executeCompiledNarrativeActionPlan,
  type CompiledPlanExecutionInput,
  type CompiledPlanExecutionResult,
} from "./editor-compiled-plan-execution.ts";
import {
  createEditorProjectFingerprint,
  parsePlanEvidence,
  type PlanEvidence,
  type PlanEvidenceEntry,
} from "./editor-plan-evidence.ts";
import type { EditorProposalBundle } from "./editor-proposal-orchestrator.ts";
import {
  appendProposalDecisionEvidenceV1,
  type SessionDecisionLedgerV1,
} from "./editor-constraint-negotiation.ts";
import {
  constraintEnforcementMessageZh,
  createSemanticActionTupleV1,
  enforceEditorActionConstraintsV1,
  isRejectedSemanticActionV1,
  type ConstraintContextExpectationV1,
} from "./editor-constraint-enforcement.ts";

export const HUMAN_REVIEW_SCHEMA_VERSION = 1 as const;
export const REVIEWED_PLAN_SCHEMA_VERSION = 1 as const;

export type HumanReviewEntryStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "MODIFIED";
export type HumanReviewLifecycle =
  | "PENDING_REVIEW"
  | "REVIEW_IN_PROGRESS"
  | "READY_TO_EXECUTE"
  | "EXECUTED"
  | "EXECUTION_FAILED"
  | "REVIEWED_NO_ACTIONS";

export type HumanReviewEntry = Readonly<{
  proposalEntryId: string;
  intervalId: string;
  status: HumanReviewEntryStatus;
  provenance?: "USER_ACCEPTED" | "USER_REJECTED" | "USER_MODIFIED";
  selectedAssetId?: string;
}>;

export type HumanReviewState = Readonly<{
  schemaVersion: typeof HUMAN_REVIEW_SCHEMA_VERSION;
  proposalId: string;
  lifecycle: HumanReviewLifecycle;
  entries: readonly HumanReviewEntry[];
}>;

export type HumanReviewDecision = Readonly<{
  proposalEntryId: string;
  decision: "ACCEPT" | "REJECT" | "MODIFY";
  selectedAssetId?: string;
}>;

export type ReviewAlternative = Readonly<{
  assetId: string;
  assetName: string;
  totalScore: number;
  semanticScore: number;
}>;

export type ReviewedEntryAction = Readonly<{
  proposalEntryId: string;
  intervalId: string;
  decision: Exclude<HumanReviewEntryStatus, "PENDING">;
  originalActionIndex?: number;
  reviewedActionIndex?: number;
  originalAssetId?: string;
  selectedAssetId?: string;
  action?: Readonly<EditorAIPlanAction>;
}>;

export type ReviewedCompiledPlan = Readonly<{
  schemaVersion: typeof REVIEWED_PLAN_SCHEMA_VERSION;
  proposalId: string;
  status: "READY_TO_EXECUTE" | "REVIEWED_NO_ACTIONS";
  sourceProjectFingerprint: string;
  compiledPlan: CompiledNarrativeActionPlan;
  reviewedEntries: readonly ReviewedEntryAction[];
}>;

export type ReviewedProposalExecution = Readonly<{
  status: "EXECUTED" | "EXECUTION_FAILED" | "REVIEWED_NO_ACTIONS";
  reviewState: HumanReviewState;
  reviewedPlan: ReviewedCompiledPlan;
  execution?: CompiledPlanExecutionResult;
  planEvidence: PlanEvidence;
  history: Readonly<{
    shouldRecord: boolean;
    undoProject?: EditorProject;
    redoProject?: EditorProject;
  }>;
  sessionDecisionLedger?: SessionDecisionLedgerV1;
}>;

export type ProposalReviewErrorCode =
  | "PROPOSAL_MISMATCH"
  | "ENTRY_NOT_FOUND"
  | "REVIEW_FINALIZED"
  | "INVALID_DECISION"
  | "INVALID_ALTERNATIVE"
  | "PENDING_ENTRIES"
  | "STALE_PROPOSAL"
  | "UNKNOWN_TARGET"
  | "UNKNOWN_ASSET"
  | "DUPLICATE_TARGET"
  | "DUPLICATE_ACTION"
  | "CONFLICTING_REVIEWED_ACTIONS"
  | "HARD_CONSTRAINT_BLOCKED"
  | "REJECTED_OPERATION_REINTRODUCED";

export class ProposalReviewError extends Error {
  readonly code: ProposalReviewErrorCode;
  constructor(code: ProposalReviewErrorCode, message: string) {
    super(message);
    this.name = "ProposalReviewError";
    this.code = code;
  }
}

function fail(code: ProposalReviewErrorCode, message: string): never {
  throw new ProposalReviewError(code, message);
}

function freezeEntry(entry: HumanReviewEntry): HumanReviewEntry { return Object.freeze(entry); }

function lifecycleFor(entries: readonly HumanReviewEntry[]): HumanReviewLifecycle {
  if (entries.length === 0) return "REVIEWED_NO_ACTIONS";
  const pending = entries.filter((entry) => entry.status === "PENDING").length;
  if (pending === entries.length) return "PENDING_REVIEW";
  if (pending > 0) return "REVIEW_IN_PROGRESS";
  if (entries.every((entry) => entry.status === "REJECTED")) return "REVIEWED_NO_ACTIONS";
  return "READY_TO_EXECUTE";
}

function validateReviewState(proposal: EditorProposalBundle, review: HumanReviewState): void {
  if (review.schemaVersion !== HUMAN_REVIEW_SCHEMA_VERSION || review.proposalId !== proposal.proposalId) {
    fail("PROPOSAL_MISMATCH", "审核状态不属于当前剪辑建议。");
  }
  if (review.entries.length !== proposal.proposalEntries.length) fail("PROPOSAL_MISMATCH", "审核条目与建议条目不一致。");
  const proposalIds = proposal.proposalEntries.map((entry) => entry.proposalEntryId);
  if (new Set(review.entries.map((entry) => entry.proposalEntryId)).size !== review.entries.length) fail("PROPOSAL_MISMATCH", "审核条目标识重复。");
  review.entries.forEach((entry, index) => {
    const source = proposal.proposalEntries[index];
    if (entry.proposalEntryId !== proposalIds[index] || entry.intervalId !== source.intervalId) fail("PROPOSAL_MISMATCH", "审核条目顺序或区间不匹配。");
    if (!["PENDING", "ACCEPTED", "REJECTED", "MODIFIED"].includes(entry.status)) fail("INVALID_DECISION", "审核状态无效。");
    if (entry.status === "MODIFIED" && (!entry.selectedAssetId || entry.provenance !== "USER_MODIFIED")) fail("INVALID_DECISION", "修改决定缺少可信素材或来源。");
    if (entry.status === "ACCEPTED" && entry.provenance !== "USER_ACCEPTED") fail("INVALID_DECISION", "接受决定缺少用户来源。");
    if (entry.status === "REJECTED" && entry.provenance !== "USER_REJECTED") fail("INVALID_DECISION", "拒绝决定缺少用户来源。");
    if (entry.status === "PENDING" && (entry.provenance !== undefined || entry.selectedAssetId !== undefined)) fail("INVALID_DECISION", "待审核条目不能包含决定证据。");
  });
  if (["PENDING_REVIEW", "REVIEW_IN_PROGRESS", "READY_TO_EXECUTE", "REVIEWED_NO_ACTIONS"].includes(review.lifecycle)
    && review.lifecycle !== lifecycleFor(review.entries)) fail("INVALID_DECISION", "审核生命周期与逐条决定不一致。");
}

export function createHumanReviewState(proposal: EditorProposalBundle): HumanReviewState {
  const entries = Object.freeze(proposal.proposalEntries.map((entry) => freezeEntry({
    proposalEntryId: entry.proposalEntryId,
    intervalId: entry.intervalId,
    status: "PENDING",
  })));
  return Object.freeze({
    schemaVersion: HUMAN_REVIEW_SCHEMA_VERSION,
    proposalId: proposal.proposalId,
    lifecycle: lifecycleFor(entries),
    entries,
  });
}

function rankedSetFor(proposal: EditorProposalBundle, intervalId: string) {
  return proposal.rankedCandidateSets.find((set) => set.intervalId === intervalId);
}

function sourceEntry(proposal: EditorProposalBundle, proposalEntryId: string) {
  return proposal.proposalEntries.find((entry) => entry.proposalEntryId === proposalEntryId);
}

function candidateIsSafe(candidate: CandidateMatchScore, projectAssetIds: ReadonlySet<string>): boolean {
  return projectAssetIds.has(candidate.assetId)
    && candidateClearsMatchingThresholds(candidate)
    && !candidate.sourceRangePlacementLimitation;
}

export function safeModificationCandidates(
  proposal: EditorProposalBundle,
  proposalEntryId: string,
  currentProject: EditorProject = proposal.trustedPreExecutionProject,
): readonly ReviewAlternative[] {
  const entry = sourceEntry(proposal, proposalEntryId);
  if (!entry) fail("ENTRY_NOT_FOUND", "找不到要修改的建议条目。");
  const ranked = rankedSetFor(proposal, entry.intervalId);
  if (!ranked) fail("PROPOSAL_MISMATCH", "建议条目缺少原始候选证据。");
  const assets = new Map(currentProject.assets.map((asset) => [asset.id, asset]));
  const ids = new Set(assets.keys());
  const base = originalAction(proposal, proposalEntryId);
  const targetId = base?.targetId ?? entry.targetId;
  return Object.freeze(ranked.candidates
    .filter((candidate) => candidate.assetId !== entry.selectedAssetId && candidateIsSafe(candidate, ids))
    .filter((candidate) => {
      if (!targetId) return false;
      const clip = clipMap(currentProject).get(targetId);
      if (!clip) return false;
      return reviewActionAllowed(proposal, currentProject, {
        type: "MATCH_ASSET_TO_SEGMENT",
        targetId,
        assetId: candidate.assetId,
        startSeconds: base?.startSeconds ?? clip.timelineStartMs / 1_000,
        endSeconds: base?.endSeconds ?? clip.timelineEndMs / 1_000,
        reason: "Human review candidate constraint preflight.",
      });
    })
    .map((candidate) => Object.freeze({
      assetId: candidate.assetId,
      assetName: assets.get(candidate.assetId)!.name,
      totalScore: candidate.totalScore,
      semanticScore: candidate.semanticScore,
    })));
}

export function reviewProposalEntry(
  proposal: EditorProposalBundle,
  review: HumanReviewState,
  decision: HumanReviewDecision,
  currentProject: EditorProject = proposal.trustedPreExecutionProject,
): HumanReviewState {
  validateReviewState(proposal, review);
  if (["EXECUTED", "EXECUTION_FAILED"].includes(review.lifecycle)) fail("REVIEW_FINALIZED", "已完成执行的审核不能再次修改。");
  const target = sourceEntry(proposal, decision.proposalEntryId);
  if (!target) fail("ENTRY_NOT_FOUND", "找不到要审核的建议条目。");
  let replacement: HumanReviewEntry;
  if (decision.decision === "ACCEPT") {
    if (decision.selectedAssetId !== undefined) fail("INVALID_DECISION", "接受决定不能替换素材。");
    replacement = freezeEntry({ proposalEntryId: target.proposalEntryId, intervalId: target.intervalId, status: "ACCEPTED", provenance: "USER_ACCEPTED" });
  } else if (decision.decision === "REJECT") {
    if (decision.selectedAssetId !== undefined) fail("INVALID_DECISION", "拒绝决定不能替换素材。");
    replacement = freezeEntry({ proposalEntryId: target.proposalEntryId, intervalId: target.intervalId, status: "REJECTED", provenance: "USER_REJECTED" });
  } else if (decision.decision === "MODIFY") {
    const alternatives = safeModificationCandidates(proposal, target.proposalEntryId, currentProject);
    if (!decision.selectedAssetId || !alternatives.some((candidate) => candidate.assetId === decision.selectedAssetId)) {
      fail("INVALID_ALTERNATIVE", "只能选择该区间中通过 V2.0A 与源范围安全检查的可信候选素材。");
    }
    replacement = freezeEntry({ proposalEntryId: target.proposalEntryId, intervalId: target.intervalId, status: "MODIFIED", provenance: "USER_MODIFIED", selectedAssetId: decision.selectedAssetId });
  } else {
    fail("INVALID_DECISION", "未知审核决定。");
  }
  if (replacement.status !== "REJECTED") {
    const action = replacement.status === "MODIFIED"
      ? modifiedAction(proposal, replacement, currentProject)
      : originalAction(proposal, replacement.proposalEntryId);
    if (action) assertReviewActionAllowed(proposal, currentProject, action);
  }
  const entries = Object.freeze(review.entries.map((entry) => entry.proposalEntryId === target.proposalEntryId ? replacement : entry));
  return Object.freeze({ schemaVersion: HUMAN_REVIEW_SCHEMA_VERSION, proposalId: proposal.proposalId, lifecycle: lifecycleFor(entries), entries });
}

function clipMap(project: EditorProject): ReadonlyMap<string, TimelineClip> {
  return new Map(project.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function assertCurrentProposal(proposal: EditorProposalBundle, currentProject: EditorProject): void {
  if (proposal.sourceProjectFingerprint !== createEditorProjectFingerprint(currentProject)
    || proposal.trustedPreExecutionProject.id !== currentProject.id
    || proposal.trustedPreExecutionProject.updatedAt !== currentProject.updatedAt) {
    fail("STALE_PROPOSAL", "当前项目已发生变化，请重新生成剪辑建议。");
  }
}

function originalLink(proposal: EditorProposalBundle, intervalId: string): IntervalActionLink | undefined {
  return proposal.compiledPlan.intervalActionMap.find((link) => link.intervalId === intervalId);
}

function originalAction(proposal: EditorProposalBundle, entryId: string): EditorAIPlanAction | undefined {
  const entry = sourceEntry(proposal, entryId);
  if (entry?.actionIndex === undefined) return undefined;
  return proposal.compiledPlan.canonicalPlan.actions[entry.actionIndex];
}

function proposalConstraintExpectation(proposal: EditorProposalBundle): ConstraintContextExpectationV1 | undefined {
  const context = proposal.evidenceMetadata.constraintContext;
  if (!context) return undefined;
  return {
    intentVersionId: context.sourceIntentVersionId,
    constraintSetId: context.sourceConstraintSetId,
    constraintFingerprint: context.sourceConstraintFingerprint,
  };
}

function reviewActionAllowed(
  proposal: EditorProposalBundle,
  currentProject: EditorProject,
  action: EditorAIPlanAction,
): boolean {
  const result = enforceEditorActionConstraintsV1({
    project: currentProject,
    constraintSet: proposal.constraintSet,
    expectedContext: proposalConstraintExpectation(proposal),
    action,
  });
  if (result.status !== "ALLOWED") return false;
  const expectation = proposalConstraintExpectation(proposal);
  return !(expectation && isRejectedSemanticActionV1({
    projectId: currentProject.id,
    intentVersionId: expectation.intentVersionId,
    action,
    rejectedOperationTuples: proposal.sessionDecisionLedger?.rejectedProposalOperationTuples,
  }));
}

function assertReviewActionAllowed(
  proposal: EditorProposalBundle,
  currentProject: EditorProject,
  action: EditorAIPlanAction,
): void {
  const result = enforceEditorActionConstraintsV1({
    project: currentProject,
    constraintSet: proposal.constraintSet,
    expectedContext: proposalConstraintExpectation(proposal),
    action,
  });
  if (result.status !== "ALLOWED") fail("HARD_CONSTRAINT_BLOCKED", constraintEnforcementMessageZh(result));
  const expectation = proposalConstraintExpectation(proposal);
  if (expectation && isRejectedSemanticActionV1({
    projectId: currentProject.id,
    intentVersionId: expectation.intentVersionId,
    action,
    rejectedOperationTuples: proposal.sessionDecisionLedger?.rejectedProposalOperationTuples,
  })) {
    fail("REJECTED_OPERATION_REINTRODUCED", "该操作已被用户明确拒绝，不能在同一工程和意图版本中再次提出。");
  }
}

function modifiedAction(
  proposal: EditorProposalBundle,
  reviewEntry: HumanReviewEntry,
  currentProject: EditorProject,
): EditorAIPlanAction {
  const proposalEntry = sourceEntry(proposal, reviewEntry.proposalEntryId)!;
  const evidenceEntry = proposal.planEvidence.entries.find((entry) => entry.proposalEntryId === reviewEntry.proposalEntryId);
  const base = originalAction(proposal, reviewEntry.proposalEntryId);
  const targetId = base?.targetId ?? evidenceEntry?.currentProposed?.targetClipId;
  const target = targetId ? clipMap(currentProject).get(targetId) : undefined;
  if (!targetId || !target) fail("UNKNOWN_TARGET", "审核动作的目标片段已不存在。");
  return {
    type: "MATCH_ASSET_TO_SEGMENT",
    targetId,
    assetId: reviewEntry.selectedAssetId!,
    startSeconds: base?.startSeconds ?? target.timelineStartMs / 1_000,
    endSeconds: base?.endSeconds ?? target.timelineEndMs / 1_000,
    reason: `User modified trusted proposal entry ${proposalEntry.proposalEntryId}.`,
  };
}

export function buildReviewedProposalPlan(
  proposal: EditorProposalBundle,
  review: HumanReviewState,
  currentProject: EditorProject,
): ReviewedCompiledPlan {
  validateReviewState(proposal, review);
  if (review.lifecycle === "EXECUTED" || review.lifecycle === "EXECUTION_FAILED") {
    fail("REVIEW_FINALIZED", "已完成执行的审核不能再次生成执行计划。");
  }
  assertCurrentProposal(proposal, currentProject);
  if (review.entries.some((entry) => entry.status === "PENDING")) fail("PENDING_ENTRIES", "请先逐条审核所有可执行建议。");
  const currentAssets = new Set(currentProject.assets.map((asset) => asset.id));
  const currentClips = clipMap(currentProject);
  const actions: EditorAIPlanAction[] = [];
  const links: IntervalActionLink[] = [];
  const reviewedEntries: ReviewedEntryAction[] = [];
  review.entries.forEach((reviewEntry) => {
    const proposalEntry = sourceEntry(proposal, reviewEntry.proposalEntryId)!;
    const sourceLink = originalLink(proposal, reviewEntry.intervalId);
    const aiAction = originalAction(proposal, reviewEntry.proposalEntryId);
    if (reviewEntry.status === "REJECTED") {
      reviewedEntries.push(Object.freeze({ proposalEntryId: reviewEntry.proposalEntryId, intervalId: reviewEntry.intervalId, decision: "REJECTED", ...(proposalEntry.actionIndex === undefined ? {} : { originalActionIndex: proposalEntry.actionIndex }), ...(proposalEntry.selectedAssetId ? { originalAssetId: proposalEntry.selectedAssetId } : {}) }));
      return;
    }
    let action: EditorAIPlanAction | undefined;
    if (reviewEntry.status === "ACCEPTED") {
      action = aiAction ? { ...aiAction } : undefined;
    } else if (reviewEntry.status === "MODIFIED") {
      const alternatives = safeModificationCandidates(proposal, reviewEntry.proposalEntryId, currentProject);
      if (!reviewEntry.selectedAssetId || !alternatives.some((candidate) => candidate.assetId === reviewEntry.selectedAssetId)) fail("INVALID_ALTERNATIVE", "所选替代素材已不再满足可信候选条件。");
      action = modifiedAction(proposal, reviewEntry, currentProject);
    } else {
      fail("INVALID_DECISION", "审核条目尚未形成明确决定。");
    }
    if (!action) {
      reviewedEntries.push(Object.freeze({ proposalEntryId: reviewEntry.proposalEntryId, intervalId: reviewEntry.intervalId, decision: reviewEntry.status, ...(proposalEntry.selectedAssetId ? { originalAssetId: proposalEntry.selectedAssetId, selectedAssetId: proposalEntry.selectedAssetId } : {}) }));
      return;
    }
    if (!currentClips.has(action.targetId)) fail("UNKNOWN_TARGET", "审核动作引用了不存在的目标片段。");
    if (!action.assetId || !currentAssets.has(action.assetId)) fail("UNKNOWN_ASSET", "审核动作引用了不存在的可信素材。");
    assertReviewActionAllowed(proposal, currentProject, action);
    const reviewedActionIndex = actions.length;
    actions.push(action);
    links.push(Object.freeze({
      intervalId: reviewEntry.intervalId,
      narrativePlanIndex: sourceLink?.narrativePlanIndex ?? proposal.matchingIntervals.findIndex((interval) => interval.id === reviewEntry.intervalId),
      status: "COMPILED",
      selectedAssetId: action.assetId,
      targetClipId: action.targetId,
      actionIndex: reviewedActionIndex,
      actionType: "MATCH_ASSET_TO_SEGMENT",
      supportingSegmentIds: reviewEntry.status === "MODIFIED"
        ? rankedSetFor(proposal, reviewEntry.intervalId)!.candidates.find((candidate) => candidate.assetId === action!.assetId)!.supportingSegmentIds
        : sourceLink?.supportingSegmentIds ?? Object.freeze([]),
      ...(sourceLink?.matchingEvidenceReference ? { matchingEvidenceReference: sourceLink.matchingEvidenceReference } : {}),
      narrativeReasonCodes: reviewEntry.status === "MODIFIED" ? Object.freeze([]) : sourceLink?.narrativeReasonCodes ?? Object.freeze([]),
    }));
    reviewedEntries.push(Object.freeze({
      proposalEntryId: reviewEntry.proposalEntryId,
      intervalId: reviewEntry.intervalId,
      decision: reviewEntry.status,
      ...(proposalEntry.actionIndex === undefined ? {} : { originalActionIndex: proposalEntry.actionIndex }),
      reviewedActionIndex,
      ...(proposalEntry.selectedAssetId ? { originalAssetId: proposalEntry.selectedAssetId } : {}),
      selectedAssetId: action.assetId,
      action: Object.freeze({ ...action }),
    }));
  });
  if (new Set(actions.map((action) => action.targetId)).size !== actions.length) fail("DUPLICATE_TARGET", "审核后的动作包含重复目标。");
  if (new Set(actions.map((action) => stable(action))).size !== actions.length) fail("DUPLICATE_ACTION", "审核后的动作包含重复操作。");
  const canonicalPlan = parseAIEditingPlan({
    summary: `Human-reviewed proposal ${proposal.proposalId}: ${actions.length} approved action(s).`,
    actions,
    unsupported: [],
    warnings: [],
  });
  const compiledPlan: CompiledNarrativeActionPlan = Object.freeze({
    schemaVersion: 1,
    mode: "INITIAL_PLAN",
    status: "VALIDATED",
    sourceNarrativeReference: proposal.compiledPlan.sourceNarrativeReference,
    canonicalPlan: Object.freeze({ ...canonicalPlan, actions: Object.freeze(canonicalPlan.actions.map((action) => Object.freeze(action))) }) as unknown as CompiledNarrativeActionPlan["canonicalPlan"],
    intervalActionMap: Object.freeze(links),
    unresolvedIntervalIds: Object.freeze([]),
    unsupportedIntervalIds: Object.freeze([]),
    warnings: Object.freeze([]),
    errors: Object.freeze([]),
    canonicalValidation: Object.freeze({ parser: "parseAIEditingPlan", valid: true }),
  });
  return Object.freeze({
    schemaVersion: REVIEWED_PLAN_SCHEMA_VERSION,
    proposalId: proposal.proposalId,
    status: actions.length ? "READY_TO_EXECUTE" : "REVIEWED_NO_ACTIONS",
    sourceProjectFingerprint: proposal.sourceProjectFingerprint,
    compiledPlan,
    reviewedEntries: Object.freeze(reviewedEntries),
  });
}

function completedReview(review: HumanReviewState, lifecycle: HumanReviewLifecycle): HumanReviewState {
  return Object.freeze({ ...review, lifecycle, entries: Object.freeze([...review.entries]) });
}

function reviewEvidence(
  proposal: EditorProposalBundle,
  review: HumanReviewState,
  reviewedPlan: ReviewedCompiledPlan,
  execution?: CompiledPlanExecutionResult,
): PlanEvidence {
  const reviewedByEntry = new Map(reviewedPlan.reviewedEntries.map((entry) => [entry.proposalEntryId, entry]));
  const preClips = execution ? clipMap(execution.preProject) : clipMap(proposal.trustedPreExecutionProject);
  const postClips = execution ? clipMap(execution.postProject) : preClips;
  const entries = proposal.planEvidence.entries.map((base): PlanEvidenceEntry => {
    if (proposal.status === "SAFE_NO_CHANGE" && proposal.safeNoChangeOutcome) {
      return Object.freeze({
        ...base,
        status: "NOT_EXECUTED",
        executionDisposition: "NOT_EXECUTED_NO_ACTION",
        explanation: proposal.safeNoChangeOutcome.reason,
      });
    }
    const decision = review.entries.find((entry) => entry.proposalEntryId === base.proposalEntryId)!;
    const reviewed = reviewedByEntry.get(base.proposalEntryId)!;
    const run = execution && reviewed.reviewedActionIndex !== undefined
      ? execution.actionResults.find((result) => result.actionIndex === reviewed.reviewedActionIndex)
      : undefined;
    const action = reviewed.action;
    const before = action ? preClips.get(action.targetId) : undefined;
    const after = action ? postClips.get(action.targetId) : undefined;
    const humanReview = Object.freeze({
      decision: decision.status as "ACCEPTED" | "REJECTED" | "MODIFIED",
      provenance: decision.provenance!,
      ...(base.selectedAssetId ? { originalAssetId: base.selectedAssetId } : {}),
      ...(decision.status === "MODIFIED" && decision.selectedAssetId ? { selectedAssetId: decision.selectedAssetId } : {}),
    });
    const status: PlanEvidenceEntry["status"] = decision.status === "REJECTED" || !action ? "NOT_EXECUTED"
      : run?.status === "APPLIED" ? "APPLIED"
        : run?.status === "NO_OP" ? "NO_OP"
          : "FAILED";
    const disposition: NonNullable<PlanEvidenceEntry["executionDisposition"]> = decision.status === "REJECTED"
      ? "NOT_EXECUTED_USER_REJECTED" : !action ? "NOT_EXECUTED_NO_ACTION"
        : execution?.status === "FAILED" ? "EXECUTION_FAILED" : "EXECUTED";
    const proposalExplanation = base.explanation.replace(/；等待人工审核。$/, "。");
    const reviewedExplanation = decision.status === "REJECTED"
      ? `${proposalExplanation} 用户已拒绝，未执行。`
      : decision.status === "MODIFIED"
        ? `${proposalExplanation} 用户已选择可信替代素材。`
        : `${proposalExplanation} 用户已接受。`;
    return Object.freeze({
      ...base,
      humanReview,
      status,
      executionDisposition: disposition,
      ...(action && reviewed.reviewedActionIndex !== undefined ? { executedAction: Object.freeze({
        actionIndex: reviewed.reviewedActionIndex,
        actionType: action.type,
        targetId: action.targetId,
        ...(action.assetId ? { assetId: action.assetId } : {}),
        reason: action.reason,
      }) } : {}),
      ...(run ? { actionResultStatus: run.status } : {}),
      ...(run?.failureCode ?? execution?.failureCode ? { failureCode: run?.failureCode ?? execution?.failureCode } : {}),
      ...(execution && action ? { beforeAfter: Object.freeze({
        targetClipId: action.targetId,
        ...(before ? { assetBefore: before.assetId, sourceStartBeforeMs: before.sourceInMs, sourceEndBeforeMs: before.sourceOutMs } : {}),
        ...(after ? { assetAfter: after.assetId, sourceStartAfterMs: after.sourceInMs, sourceEndAfterMs: after.sourceOutMs } : {}),
        timelineStartMs: before?.timelineStartMs ?? base.interval.startMs,
        timelineEndMs: before?.timelineEndMs ?? base.interval.endMs,
      }) } : {}),
      explanation: reviewedExplanation,
    });
  });
  const evidence: PlanEvidence = Object.freeze({
    ...proposal.planEvidence,
    lifecycleStatus: execution ? execution.status === "FAILED" ? "EXECUTION_FAILED" : "EXECUTED" : "REVIEWED_NO_ACTIONS",
    entries: Object.freeze(entries),
    summary: Object.freeze({
      ...proposal.planEvidence.summary,
      compiledActionCount: reviewedPlan.compiledPlan.canonicalPlan.actions.length,
      ...(execution ? { execution: Object.freeze({
        status: execution.status,
        fingerprint: execution.executionFingerprint,
        postProjectReference: createEditorProjectFingerprint(execution.postProject),
        appliedCount: execution.appliedActionCount,
        noOpCount: execution.noOpActionCount,
        failedCount: execution.actionResults.filter((result) => ["FAILED", "ROLLED_BACK", "NOT_RUN"].includes(result.status)).length,
      }) } : {}),
      ...(execution?.constraintEnforcement ? { constraintValidation: Object.freeze({
        status: execution.constraintEnforcement.status,
        ...(execution.constraintEnforcement.constraintSetId ? { constraintSetId: execution.constraintEnforcement.constraintSetId } : {}),
        ...(execution.constraintEnforcement.constraintFingerprint ? { constraintFingerprint: execution.constraintEnforcement.constraintFingerprint } : {}),
        violationIds: Object.freeze(execution.constraintEnforcement.violations.map((item) => item.violationId)),
      }) } : {}),
    }),
    ...(execution ? { preservation: Object.freeze({
      captionsUnchanged: execution.preservation.captionsPreserved,
      audioUnchanged: execution.preservation.audioSelectionPreserved,
      ratioUnchanged: execution.preservation.projectRatioPreserved,
      durationUnchanged: execution.preservation.projectDurationPreserved,
      unrelatedClipsUnchanged: execution.preservation.unrelatedClipsPreserved,
      transformsUnchanged: execution.preservation.targetTimelineAndTransformPreserved,
      tracksUnchanged: execution.preservation.trackIdentityAndOrderPreserved && execution.preservation.clipIdentityAndOrderPreserved,
    }) } : {}),
  });
  return parsePlanEvidence(evidence);
}

type ReviewedExecutionDependencies = Readonly<{
  executePlan?: (input: CompiledPlanExecutionInput) => CompiledPlanExecutionResult;
}>;

function decisionLedgerAfterReview(
  proposal: EditorProposalBundle,
  review: HumanReviewState,
): SessionDecisionLedgerV1 | undefined {
  const ledger = proposal.sessionDecisionLedger;
  const context = proposal.evidenceMetadata.constraintContext;
  if (!ledger || !context) return ledger;
  const rejectedOperationTuples: string[] = [];
  const humanModifiedSelections: Array<Readonly<{ proposalEntryId: string; selectedAssetId: string }>> = [];
  for (const entry of review.entries) {
    if (entry.status !== "REJECTED" && entry.status !== "MODIFIED") continue;
    const action = originalAction(proposal, entry.proposalEntryId);
    if (action) {
      rejectedOperationTuples.push(createSemanticActionTupleV1(
        proposal.trustedPreExecutionProject.id,
        context.sourceIntentVersionId,
        action,
      ));
    }
    if (entry.status === "MODIFIED" && entry.selectedAssetId) {
      humanModifiedSelections.push(Object.freeze({
        proposalEntryId: entry.proposalEntryId,
        selectedAssetId: entry.selectedAssetId,
      }));
    }
  }
  return appendProposalDecisionEvidenceV1(ledger, { rejectedOperationTuples, humanModifiedSelections });
}

export function executeReviewedProposal(
  input: Readonly<{
    proposal: EditorProposalBundle;
    review: HumanReviewState;
    currentProject: EditorProject;
    executionUpdatedAt: string;
  }>,
  dependencies: ReviewedExecutionDependencies = {},
): ReviewedProposalExecution {
  const reviewedPlan = buildReviewedProposalPlan(input.proposal, input.review, input.currentProject);
  const sessionDecisionLedger = decisionLedgerAfterReview(input.proposal, input.review);
  if (reviewedPlan.status === "REVIEWED_NO_ACTIONS") {
    const reviewState = completedReview(input.review, "REVIEWED_NO_ACTIONS");
    return Object.freeze({
      status: "REVIEWED_NO_ACTIONS",
      reviewState,
      reviewedPlan,
      planEvidence: reviewEvidence(input.proposal, reviewState, reviewedPlan),
      history: Object.freeze({ shouldRecord: false }),
      ...(sessionDecisionLedger ? { sessionDecisionLedger } : {}),
    });
  }
  const executePlan = dependencies.executePlan ?? executeCompiledNarrativeActionPlan;
  const execution = executePlan({
    preExecutionProject: input.currentProject,
    compiledPlan: reviewedPlan.compiledPlan,
    ownedAssetIds: input.currentProject.assets.map((asset) => asset.id),
    expectedProjectId: input.currentProject.id,
    expectedProjectUpdatedAt: input.currentProject.updatedAt,
    executionUpdatedAt: input.executionUpdatedAt,
    ...(input.proposal.constraintSet && input.proposal.evidenceMetadata.constraintContext ? { constraintContext: {
      intentVersionId: input.proposal.evidenceMetadata.constraintContext.sourceIntentVersionId,
      constraintSetId: input.proposal.evidenceMetadata.constraintContext.sourceConstraintSetId,
      constraintFingerprint: input.proposal.evidenceMetadata.constraintContext.sourceConstraintFingerprint,
      constraintSet: input.proposal.constraintSet,
    } } : {}),
    ...(input.proposal.sessionDecisionLedger ? {
      rejectedOperationTuples: input.proposal.sessionDecisionLedger.rejectedProposalOperationTuples,
    } : {}),
  });
  const lifecycle = execution.status === "FAILED" ? "EXECUTION_FAILED" : "EXECUTED";
  const reviewState = completedReview(input.review, lifecycle);
  const shouldRecord = execution.historyBoundary.shouldRecordPlanUndo;
  return Object.freeze({
    status: lifecycle,
    reviewState,
    reviewedPlan,
    execution,
    planEvidence: reviewEvidence(input.proposal, reviewState, reviewedPlan, execution),
    history: Object.freeze({
      shouldRecord,
      ...(shouldRecord ? { undoProject: cloneProject(execution.preProject), redoProject: cloneProject(execution.postProject) } : {}),
    }),
    ...(sessionDecisionLedger ? { sessionDecisionLedger } : {}),
  });
}
