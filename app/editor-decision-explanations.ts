import type { ConstraintFeasibilityReportV1 } from "./editor-constraint-feasibility.ts";
import type { ConstraintSetV1 } from "./editor-constraints.ts";
import type { CreativeIntentV1 } from "./editor-creative-intent.ts";
import type { EditorProject } from "./editor-core.ts";
import type { EditorEvaluationReport } from "./editor-evaluator.ts";
import type { CollaborativeEditingOptionsV1 } from "./editor-collaborative-options.ts";
import type { EditorProposalBundle } from "./editor-proposal-orchestrator.ts";
import type { HumanReviewState } from "./editor-proposal-review.ts";
import type { ClosedLoopRepairResult, RepairProposalBundle, RepairReviewState } from "./editor-repair.ts";
import type { ProtectedTimelineAnnotationV1 } from "./editor-protected-timeline.ts";
import type { ConstraintEnforcementResultV1 } from "./editor-constraint-enforcement.ts";
import type { PlanEvidence } from "./editor-plan-evidence.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";

export const EDITOR_DECISION_EXPLANATION_SCHEMA_VERSION = 1 as const;
export type EditorDecisionKindV1 = "RETAINED" | "REMOVED" | "REORDERED" | "SPEED_ADJUSTED" | "ASSET_MATCHED" | "PROTECTED" | "BLOCKED_BY_CONSTRAINT" | "DURATION_GAP" | "OPTION_DIFFERENCE" | "USER_MODIFIED" | "REPAIR_PROPOSED" | "REPAIR_REJECTED" | "NOT_EXPLAINABLE";
export type ExplanationProvenanceV1 = "USER_STATED" | "USER_CONFIRMED" | "DETERMINISTIC_ANALYSIS" | "MODEL_SUGGESTED_UNTRUSTED" | "SYSTEM_RULE" | "HUMAN_REVIEW_DECISION" | "EVALUATOR_RESULT" | "REPAIR_RESULT";
export type ExplanationCertaintyV1 = "CONFIRMED" | "SUPPORTED" | "INFERRED" | "UNCERTAIN" | "NOT_EVALUABLE";
export type ExplanationStatusV1 = "CURRENT" | "STALE";
export type EditorDecisionEvidenceV1 = Readonly<{ label: string; detail: string; provenance: ExplanationProvenanceV1 }>;
export type EditorDecisionTimelineRangeV1 = Readonly<{
  coordinateSpace: "TIMELINE";
  startMs: number;
  endMs: number;
}>;
export type EditorDecisionExplanationV1 = Readonly<{
  schemaVersion: typeof EDITOR_DECISION_EXPLANATION_SCHEMA_VERSION;
  explanationId: string;
  decisionKind: EditorDecisionKindV1;
  subjectKind: "CLIP" | "PROTECTION" | "DURATION" | "OPTION" | "REVIEW" | "EVALUATION" | "REPAIR" | "PROJECT";
  subjectId?: string;
  headline: string;
  summary: string;
  evidenceItems: readonly EditorDecisionEvidenceV1[];
  timelineRange?: EditorDecisionTimelineRangeV1;
  constraintReferences: readonly string[];
  tradeoff?: string;
  certainty: ExplanationCertaintyV1;
  provenance: ExplanationProvenanceV1;
  projectFingerprint: string;
  intentVersionId?: string;
  constraintSetId?: string;
  optionId?: string;
  actionId?: string;
  status: ExplanationStatusV1;
}>;

export type DeriveEditorDecisionExplanationsInputV1 = Readonly<{
  project: EditorProject;
  intent?: CreativeIntentV1 | null;
  constraintSet?: ConstraintSetV1 | null;
  feasibilityReport?: ConstraintFeasibilityReportV1 | null;
  annotations?: readonly ProtectedTimelineAnnotationV1[];
  blockedEnforcement?: ConstraintEnforcementResultV1 | null;
  options?: CollaborativeEditingOptionsV1 | null;
  selectedOptionId?: string | null;
  proposal?: EditorProposalBundle | null;
  review?: HumanReviewState | null;
  reviewedEvidence?: PlanEvidence | null;
  evaluation?: EditorEvaluationReport | null;
  repairProposal?: RepairProposalBundle | null;
  repairReview?: RepairReviewState | null;
  repairResult?: ClosedLoopRepairResult | null;
}>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
function actionSignature(action: unknown): string {
  if (!action || typeof action !== "object" || Array.isArray(action)) return stable(action);
  const { reason: _reason, ...semanticAction } = action as Record<string, unknown>;
  return stable(semanticAction);
}
function formatSeconds(ms: number | null | undefined): string { return ms === null || ms === undefined ? "无法确定" : `${Math.round(ms / 1000)} 秒`; }
function frozenEvidence(items: readonly EditorDecisionEvidenceV1[]): readonly EditorDecisionEvidenceV1[] { return Object.freeze(items.map((item) => Object.freeze(item))); }

export function deriveEditorDecisionExplanationsV1(input: DeriveEditorDecisionExplanationsInputV1): readonly EditorDecisionExplanationV1[] {
  const fingerprint = createEditorProjectFingerprint(input.project);
  const intentId = input.intent?.intentId;
  const set = input.constraintSet ?? undefined;
  const setCurrent = !set || (set.projectId === input.project.id && set.validatedAgainstProjectFingerprint === fingerprint && (!intentId || set.intentVersionId === intentId));
  const explanations: EditorDecisionExplanationV1[] = [];
  const add = (value: Omit<EditorDecisionExplanationV1, "schemaVersion" | "explanationId" | "projectFingerprint" | "intentVersionId" | "constraintSetId"> & { sourceIdentity: unknown; sourceFingerprint?: string; sourceIntentId?: string; sourceConstraintSetId?: string }) => {
    const status: ExplanationStatusV1 = value.status === "STALE" || (value.sourceFingerprint !== undefined && value.sourceFingerprint !== fingerprint)
      || (value.sourceIntentId !== undefined && value.sourceIntentId !== intentId)
      || (value.sourceConstraintSetId !== undefined && value.sourceConstraintSetId !== set?.constraintSetId)
      ? "STALE" : "CURRENT";
    const stale = status === "STALE";
    const { sourceIdentity, sourceFingerprint: _sourceFingerprint, sourceIntentId: _sourceIntentId, sourceConstraintSetId: _sourceConstraintSetId, timelineRange, ...rest } = value;
    const row = Object.freeze({
      schemaVersion: EDITOR_DECISION_EXPLANATION_SCHEMA_VERSION,
      explanationId: `decision-explanation-v1-${hash(stable({ decisionKind: value.decisionKind, subjectKind: value.subjectKind, subjectId: value.subjectId, actionId: value.actionId, optionId: value.optionId, sourceIdentity }))}`,
      ...rest,
      ...(!stale && timelineRange ? { timelineRange: Object.freeze({ ...timelineRange }) } : {}),
      summary: stale ? "当前说明已失效，需要基于最新项目重新分析。" : value.summary,
      evidenceItems: stale ? Object.freeze([]) : value.evidenceItems,
      constraintReferences: stale ? Object.freeze([]) : value.constraintReferences,
      certainty: stale ? "NOT_EVALUABLE" as const : value.certainty,
      projectFingerprint: value.sourceFingerprint ?? fingerprint,
      ...(value.sourceIntentId ? { intentVersionId: value.sourceIntentId } : intentId ? { intentVersionId: intentId } : {}),
      ...(value.sourceConstraintSetId ? { constraintSetId: value.sourceConstraintSetId } : set?.constraintSetId ? { constraintSetId: set.constraintSetId } : {}),
      status,
    });
    explanations.push(row);
  };
  if (set && !setCurrent) add({ decisionKind: "NOT_EXPLAINABLE", subjectKind: "PROJECT", headline: "保护说明已失效", summary: "当前说明已失效，需要基于最新项目重新分析。", evidenceItems: Object.freeze([]), constraintReferences: Object.freeze([]), certainty: "NOT_EVALUABLE", provenance: "SYSTEM_RULE", status: "STALE", sourceIdentity: [set.constraintSetId, fingerprint], sourceFingerprint: set.validatedAgainstProjectFingerprint, sourceIntentId: set.intentVersionId, sourceConstraintSetId: set.constraintSetId });

  for (const annotation of input.annotations ?? []) {
    const status = annotation.status;
    const current = status !== "STALE" && setCurrent;
    const confirmed = status === "ACTIVE_HARD_CONSTRAINT" && annotation.isActiveHardConstraint && current;
    const summary = confirmed
      ? annotation.protectionKind === "PRESERVE_ENDING" ? "该结尾内容由你确认受到保护，当前处于有效保护状态。" : "这段内容由你确认受到保护，当前处于有效保护状态。"
      : status === "UNRESOLVED_REFERENCE" ? `你提出了保护“${annotation.label}”的请求，但范围尚未确认；目前不能将其描述为已锁定。`
        : status === "CANDIDATE_BINDING" ? `“${annotation.label}”目前只有候选范围，尚未成为有效保护约束。`
          : "当前说明已失效，需要重新确认保护范围。";
    add({ decisionKind: confirmed ? "PROTECTED" : "NOT_EXPLAINABLE", subjectKind: "PROTECTION", subjectId: annotation.sourceClauseId,
      headline: confirmed ? `${annotation.label}已保留` : `${annotation.label}保护状态`, summary,
      ...(confirmed && annotation.timelineEnd > annotation.timelineStart ? { timelineRange: {
        coordinateSpace: "TIMELINE" as const,
        startMs: annotation.timelineStart,
        endMs: annotation.timelineEnd,
      } } : {}),
      evidenceItems: frozenEvidence([
        { label: "状态", detail: confirmed ? "有效硬约束" : status === "STALE" ? "需要重新确认" : status === "CANDIDATE_BINDING" ? "候选范围，尚未确认" : "待确认", provenance: confirmed ? "USER_CONFIRMED" : "USER_STATED" },
        ...(annotation.forbiddenEdits.length ? [{ label: "限制", detail: `禁止：${annotation.forbiddenEdits.join("、")}`, provenance: "SYSTEM_RULE" as const }] : []),
        ...(annotation.provenance ? [{ label: "确认来源", detail: annotation.provenance, provenance: confirmed ? "USER_CONFIRMED" as const : "USER_STATED" as const }] : []),
      ]), constraintReferences: Object.freeze([annotation.constraintId, annotation.bindingId].filter((id): id is string => !!id)), certainty: confirmed ? "CONFIRMED" : status === "STALE" ? "NOT_EVALUABLE" : "UNCERTAIN",
      provenance: confirmed ? "USER_CONFIRMED" : status === "UNRESOLVED_REFERENCE" ? "USER_STATED" : "SYSTEM_RULE", status: current ? "CURRENT" : "STALE",
      sourceIdentity: annotation.annotationId, sourceFingerprint: annotation.isStale ? undefined : fingerprint, sourceIntentId: intentId, sourceConstraintSetId: annotation.constraintId ? set?.constraintSetId : undefined });
  }

  const report = input.feasibilityReport;
  if (report && report.remainingGapMs !== null && report.remainingGapMs > 0) {
    const current = report.projectId === input.project.id && report.evaluatedProjectFingerprint === fingerprint && (!set || (report.constraintSetId === set.constraintSetId && report.constraintFingerprint === set.constraintFingerprint));
    const protectedOnly = report.minimumProtectedDurationMs === report.minimumFeasibleDurationMs;
    const target = formatSeconds(report.requestedDurationMs);
    const minimum = formatSeconds(report.minimumFeasibleDurationMs);
    add({ decisionKind: "DURATION_GAP", subjectKind: "DURATION", headline: "目标时长尚不可达",
      summary: protectedOnly ? `当前无法压缩到${target}，因为已确认的保护内容至少需要${minimum}。` : `当前无法压缩到${target}；按现有保护约束和素材可压缩范围，最低可行时长为${minimum}。`,
      evidenceItems: frozenEvidence([
        { label: "目标时长", detail: target, provenance: "USER_STATED" },
        { label: "最低可行时长", detail: minimum, provenance: "DETERMINISTIC_ANALYSIS" },
        { label: "剩余差距", detail: formatSeconds(report.remainingGapMs), provenance: "DETERMINISTIC_ANALYSIS" },
      ]), constraintReferences: Object.freeze(set?.activeConstraints.map((item) => item.constraintId) ?? []), certainty: current ? "SUPPORTED" : "NOT_EVALUABLE", provenance: current ? "DETERMINISTIC_ANALYSIS" : "SYSTEM_RULE", status: current ? "CURRENT" : "STALE", sourceIdentity: report.reportId, sourceFingerprint: report.evaluatedProjectFingerprint, sourceIntentId: intentId, sourceConstraintSetId: report.constraintSetId });
  }

  const options = input.options;
  if (options) {
    const current = options.projectFingerprint === fingerprint && options.intentVersionId === intentId && (!set || options.constraintSetId === set.constraintSetId);
    if (options.planGenerationMode === "SINGLE") {
      add({ decisionKind: "OPTION_DIFFERENCE", subjectKind: "OPTION", headline: "单方案模式", summary: "你选择了单方案模式，本次没有生成多个剪辑方案。", evidenceItems: frozenEvidence([{ label: "生成模式", detail: "单方案", provenance: "USER_STATED" }]), constraintReferences: [], certainty: "CONFIRMED", provenance: "USER_STATED", status: current ? "CURRENT" : "STALE", sourceIdentity: [options.optionSetId, "single"], sourceFingerprint: options.projectFingerprint, sourceIntentId: options.intentVersionId, sourceConstraintSetId: options.constraintSetId });
    } else if (options.options.length === 1 && options.generatedOptionCount === 1) {
      add({ decisionKind: "OPTION_DIFFERENCE", subjectKind: "OPTION", headline: "没有其他实质不同的安全方案", summary: "当前保护约束下没有生成其他具有实质差异的安全方案。", evidenceItems: frozenEvidence([{ label: "规划方向", detail: options.options[0].strategyKind === "CONTENT_PRIORITY" ? "内容优先" : options.options[0].strategyKind === "RHYTHM_PRIORITY" ? "节奏优先" : "平衡", provenance: "DETERMINISTIC_ANALYSIS" }, { label: "Provider 调用", detail: "0 次；未产生额外 API 费用", provenance: "SYSTEM_RULE" }]), constraintReferences: set?.activeConstraints.map((item) => item.constraintId) ?? [], optionId: options.options[0].optionId, certainty: "SUPPORTED", provenance: "DETERMINISTIC_ANALYSIS", status: current ? "CURRENT" : "STALE", sourceIdentity: [options.optionSetId, options.options[0].optionId], sourceFingerprint: options.projectFingerprint, sourceIntentId: options.intentVersionId, sourceConstraintSetId: options.constraintSetId });
    } else {
      const signatures = options.options.map((option) => new Set(option.proposalBundle.compiledPlan.canonicalPlan.actions.map(actionSignature)));
      options.options.forEach((option, i) => {
        const distinct = signatures.some((other, j) => i !== j && (other.size !== signatures[i].size || [...other].some((item) => !signatures[i].has(item))));
        if (!distinct) return;
        add({ decisionKind: "OPTION_DIFFERENCE", subjectKind: "OPTION", subjectId: option.optionId, headline: option.title,
          summary: `${option.summary} 当前方案通过不同的安全操作与其他方案形成实质差异。`,
          evidenceItems: frozenEvidence([{ label: "策略", detail: option.strategyKind === "CONTENT_PRIORITY" ? "内容优先" : option.strategyKind === "RHYTHM_PRIORITY" ? "节奏优先" : "平衡", provenance: "DETERMINISTIC_ANALYSIS" }, { label: "方案差异", detail: `${option.proposalBundle.compiledPlan.canonicalPlan.actions.length} 条操作；Provider 调用 0 次`, provenance: "DETERMINISTIC_ANALYSIS" }]),
          constraintReferences: Object.freeze(set?.activeConstraints.map((item) => item.constraintId) ?? []), tradeoff: option.tradeoffs.join("；"), certainty: "SUPPORTED", provenance: "DETERMINISTIC_ANALYSIS", status: current ? "CURRENT" : "STALE", optionId: option.optionId,
          sourceIdentity: [options.optionSetId, option.optionId, [...signatures[i]]], sourceFingerprint: options.projectFingerprint, sourceIntentId: options.intentVersionId, sourceConstraintSetId: options.constraintSetId });
      });
    }
  }

  const proposal = input.proposal;
  const review = input.review;
  if (proposal) {
    const reviewedPostCurrent = input.reviewedEvidence?.summary.execution?.postProjectReference === fingerprint;
    const snapshotCurrent = proposal.sourceProjectFingerprint === fingerprint || reviewedPostCurrent;
    if (!snapshotCurrent) add({ decisionKind: "NOT_EXPLAINABLE", subjectKind: "PROJECT", headline: "剪辑说明已失效", summary: "当前说明已失效，需要基于最新项目重新分析。", evidenceItems: [], constraintReferences: [], certainty: "NOT_EVALUABLE", provenance: "SYSTEM_RULE", status: "STALE", sourceIdentity: proposal.proposalId, sourceFingerprint: proposal.sourceProjectFingerprint, sourceIntentId: intentId, sourceConstraintSetId: proposal.constraintSet?.constraintSetId });
    else {
      const safeNoChange = proposal.safeNoChangeOutcome;
      if (safeNoChange) {
        add({
          decisionKind: "RETAINED",
          subjectKind: "PROJECT",
          headline: "当前没有可安全执行的进一步修改",
          summary: `没有进一步修改，是因为当前 ${Math.round(safeNoChange.minimumFeasibleDurationMs / 1_000)} 秒全部属于已确认保护内容；在不违反保护约束的前提下，${Math.round(safeNoChange.requestedTargetMs / 1_000)} 秒目标不可达。`,
          evidenceItems: frozenEvidence([
            { label: "目标时长", detail: formatSeconds(safeNoChange.requestedTargetMs), provenance: "USER_STATED" },
            { label: "最短安全时长", detail: formatSeconds(safeNoChange.minimumFeasibleDurationMs), provenance: "DETERMINISTIC_ANALYSIS" },
            { label: "剩余差距", detail: formatSeconds(safeNoChange.remainingGapMs), provenance: "DETERMINISTIC_ANALYSIS" },
            { label: "保护状态", detail: "已确认保护内容保持不变", provenance: "SYSTEM_RULE" },
          ]),
          constraintReferences: safeNoChange.evidence.protectedConstraintIds,
          certainty: "SUPPORTED",
          provenance: "DETERMINISTIC_ANALYSIS",
          status: "CURRENT",
          sourceIdentity: [proposal.proposalId, safeNoChange.feasibilityRef.reportId, safeNoChange.reasonCode],
          sourceFingerprint: safeNoChange.projectFingerprint,
          sourceIntentId: safeNoChange.intentVersionId,
          sourceConstraintSetId: safeNoChange.constraintSetId,
        });
      }
      const actions = proposal.compiledPlan.canonicalPlan.actions as readonly Readonly<Record<string, unknown>>[];
      for (const [index, action] of actions.entries()) {
        const targetId = typeof action.targetId === "string" ? action.targetId : typeof action.clipId === "string" ? action.clipId : undefined;
        const type = String(action.type ?? "");
        const decisionKind: EditorDecisionKindV1 = type === "REMOVE_CLIP" ? "REMOVED" : type === "REORDER_CLIP" ? "REORDERED" : type === "SET_CLIP_PLAYBACK_SPEED" ? "SPEED_ADJUSTED" : type === "MATCH_ASSET_TO_SEGMENT" ? "ASSET_MATCHED" : "NOT_EXPLAINABLE";
        const operationLabel = type === "REMOVE_CLIP" ? "移除片段" : type === "TRIM_CLIP" ? "调整片段范围" : type === "REORDER_CLIP" ? "调整片段顺序" : type === "SET_CLIP_PLAYBACK_SPEED" ? "调整片段速度" : type === "MATCH_ASSET_TO_SEGMENT" ? "匹配素材" : type === "SPLIT_CLIP" ? "分割片段" : type === "SET_CLIP_POSITION_SCALE" ? "调整画面位置或大小" : type === "SET_CAPTION_TEXT" ? "修改字幕" : type === "SET_BACKGROUND_AUDIO_RANGE" ? "调整背景音频范围" : "调整片段";
        const evidence = proposal.planEvidence.entries.find((entry) => entry.compiledAction?.actionIndex === index || entry.compiledAction?.targetId === targetId);
        const detail = evidence?.explanation || (typeof action.reason === "string" ? action.reason : undefined);
        add({ decisionKind, subjectKind: "CLIP", ...(targetId ? { subjectId: targetId } : {}), headline: `建议${operationLabel}`,
          summary: detail ? `系统建议${operationLabel}；依据：${detail}` : `系统建议${operationLabel}，但现有结构化证据不足，无法确定具体原因。`,
          evidenceItems: detail ? frozenEvidence([{ label: "计划证据", detail, provenance: "MODEL_SUGGESTED_UNTRUSTED" }]) : [], constraintReferences: Object.freeze(set?.activeConstraints.map((item) => item.constraintId) ?? []), certainty: detail ? "INFERRED" : "UNCERTAIN", provenance: "MODEL_SUGGESTED_UNTRUSTED", status: "CURRENT", actionId: `${proposal.proposalId}:${index}`, optionId: input.selectedOptionId ?? undefined, sourceIdentity: [proposal.proposalId, index, action], sourceFingerprint: proposal.sourceProjectFingerprint, sourceIntentId: intentId, sourceConstraintSetId: proposal.constraintSet?.constraintSetId });
      }
      for (const item of review?.entries ?? []) {
        if (item.status === "PENDING") continue;
        const accepted = item.status === "ACCEPTED";
        const rejected = item.status === "REJECTED";
        add({ decisionKind: rejected ? "NOT_EXPLAINABLE" : item.status === "MODIFIED" ? "USER_MODIFIED" : "RETAINED", subjectKind: "REVIEW", subjectId: item.intervalId,
          headline: rejected ? "原建议已由你拒绝" : item.status === "MODIFIED" ? "按你的修改方向审核" : "此建议已由你确认",
          summary: rejected ? "原建议已被你拒绝，因此不会按该建议执行。" : item.status === "MODIFIED" ? "该项由你修改后确认；后续执行使用你的选择。" : "该项由你确认；确认来源是人工审核。",
          evidenceItems: frozenEvidence([{ label: "审核决定", detail: rejected ? "你已拒绝" : item.status === "MODIFIED" ? "你已修改并确认" : "你已接受", provenance: "HUMAN_REVIEW_DECISION" }]), constraintReferences: [], certainty: "CONFIRMED", provenance: "HUMAN_REVIEW_DECISION", status: "CURRENT", actionId: item.proposalEntryId, optionId: input.selectedOptionId ?? undefined, sourceIdentity: [proposal.proposalId, item.proposalEntryId, item.status], sourceFingerprint: reviewedPostCurrent ? fingerprint : proposal.sourceProjectFingerprint, sourceIntentId: intentId, sourceConstraintSetId: proposal.constraintSet?.constraintSetId });
      }
    }
  }

  const reviewedEvidence = input.reviewedEvidence;
  if (reviewedEvidence?.summary.execution?.postProjectReference === fingerprint) {
    for (const entry of reviewedEvidence.entries) {
      const executed = entry.executedAction;
      if (executed) {
        const kind: EditorDecisionKindV1 | undefined = executed.actionType === "REMOVE_CLIP" ? "REMOVED" : executed.actionType === "REORDER_CLIP" ? "REORDERED" : executed.actionType === "SET_CLIP_PLAYBACK_SPEED" ? "SPEED_ADJUSTED" : executed.actionType === "MATCH_ASSET_TO_SEGMENT" ? "ASSET_MATCHED" : undefined;
        if (kind) add({ decisionKind: kind, subjectKind: "CLIP", subjectId: executed.targetId,
          headline: kind === "REMOVED" ? "片段已移除" : kind === "REORDERED" ? "片段顺序已调整" : kind === "SPEED_ADJUSTED" ? "播放速度已调整" : "素材已匹配",
          summary: executed.reason ? `该操作已执行。依据：${executed.reason}` : "该操作已执行；当前结构化记录没有提供更多原因。",
          evidenceItems: executed.reason ? frozenEvidence([{ label: "执行记录", detail: executed.reason, provenance: "DETERMINISTIC_ANALYSIS" }]) : [],
          constraintReferences: Object.freeze(set?.activeConstraints.map((item) => item.constraintId) ?? []), certainty: executed.reason ? "SUPPORTED" : "UNCERTAIN", provenance: "DETERMINISTIC_ANALYSIS", status: setCurrent ? "CURRENT" : "STALE", actionId: `${reviewedEvidence.planId}:${executed.actionIndex}`, sourceIdentity: [reviewedEvidence.planId, executed.actionIndex, executed.actionType, executed.targetId], sourceFingerprint: fingerprint, sourceIntentId: intentId, sourceConstraintSetId: set?.constraintSetId });
      }
      if (!entry.humanReview && !entry.executedAction && entry.explanation && entry.executionDisposition === "NOT_EXECUTED_NO_ACTION") {
        add({ decisionKind: "RETAINED", subjectKind: "CLIP", subjectId: entry.intervalId,
          headline: "该区间没有执行素材替换", summary: `当前计划保留原有素材。依据：${entry.explanation}`,
          evidenceItems: frozenEvidence([{ label: "保留依据", detail: entry.explanation, provenance: "DETERMINISTIC_ANALYSIS" }]),
          constraintReferences: Object.freeze(set?.activeConstraints.map((item) => item.constraintId) ?? []), certainty: "SUPPORTED", provenance: "DETERMINISTIC_ANALYSIS", status: setCurrent ? "CURRENT" : "STALE", sourceIdentity: [reviewedEvidence.planId, entry.intervalId, "retained"], sourceFingerprint: fingerprint, sourceIntentId: intentId, sourceConstraintSetId: set?.constraintSetId });
      }
      const decision = entry.humanReview;
      if (!decision) continue;
      const rejected = decision.decision === "REJECTED";
      const modified = decision.decision === "MODIFIED";
      add({ decisionKind: rejected ? "NOT_EXPLAINABLE" : modified ? "USER_MODIFIED" : "RETAINED", subjectKind: "REVIEW", subjectId: entry.intervalId,
        headline: rejected ? "原建议已由你拒绝" : modified ? "按你的修改版本执行" : "此修改由你确认",
        summary: rejected ? "你拒绝了原建议，因此该建议未执行。" : modified ? "该修改按你确认的版本执行。" : "该修改由你确认后执行。",
        evidenceItems: frozenEvidence([{ label: "人工审核", detail: rejected ? "已拒绝，未执行" : modified ? "已修改并确认" : "已接受并确认", provenance: "HUMAN_REVIEW_DECISION" }]),
        constraintReferences: Object.freeze(set?.activeConstraints.map((item) => item.constraintId) ?? []), certainty: "CONFIRMED", provenance: "HUMAN_REVIEW_DECISION", status: setCurrent ? "CURRENT" : "STALE", sourceIdentity: [reviewedEvidence.planId, entry.proposalEntryId, decision.decision], sourceFingerprint: fingerprint, sourceIntentId: intentId, sourceConstraintSetId: set?.constraintSetId });
    }
  }

  if (input.blockedEnforcement) {
    const blocked = input.blockedEnforcement;
    const violations = blocked.violations;
    if (blocked.status === "BLOCKED_HARD_CONSTRAINT" && violations.length) {
      for (const violation of violations) {
        const annotation = (input.annotations ?? []).find((item) => item.constraintId === violation.constraintId);
        if (!annotation) continue;
        add({ decisionKind: "BLOCKED_BY_CONSTRAINT", subjectKind: "PROTECTION", subjectId: annotation.sourceClauseId,
          headline: "操作被保护约束拦截", summary: `无法执行该编辑：它属于「${annotation.label}」保护区域，而当前保护规则禁止此操作。`,
          ...(annotation.status === "ACTIVE_HARD_CONSTRAINT" && annotation.isActiveHardConstraint
            && annotation.timelineEnd > annotation.timelineStart ? { timelineRange: {
              coordinateSpace: "TIMELINE" as const,
              startMs: annotation.timelineStart,
              endMs: annotation.timelineEnd,
            } } : {}),
          evidenceItems: frozenEvidence([{ label: "拦截依据", detail: violation.messageZh, provenance: "SYSTEM_RULE" }]), constraintReferences: [violation.constraintId], certainty: "CONFIRMED", provenance: "SYSTEM_RULE", status: setCurrent ? "CURRENT" : "STALE", sourceIdentity: [violation.violationId, violation.constraintId], sourceFingerprint: fingerprint, sourceIntentId: intentId, sourceConstraintSetId: blocked.constraintSetId });
      }
    }
  }

  const evaluation = input.evaluation;
  if (evaluation) {
    const evaluationCurrent = evaluation.postProjectFingerprint === fingerprint;
    const overallLabel = evaluation.overallStatus === "PASS" ? "通过" : evaluation.overallStatus === "PASS_WITH_WARNINGS" ? "通过，但有提醒" : evaluation.overallStatus === "FAIL" ? "未通过" : evaluation.overallStatus === "NOT_EVALUABLE" ? "无法评估" : "没有已执行操作";
    add({ decisionKind: "NOT_EXPLAINABLE", subjectKind: "EVALUATION", subjectId: "overall", headline: `整体执行评估：${overallLabel}`,
      summary: evaluation.overallStatus === "NOT_EVALUABLE" ? "当前证据不足，不能把结果判定为通过。" : evaluation.overallStatus === "NO_EXECUTED_ACTIONS" ? "本次没有已执行的剪辑操作需要评估。" : evaluation.warnings[0] ?? evaluation.notEvaluable[0] ?? "整体结论来自当前执行评估结果。",
      evidenceItems: frozenEvidence([{ label: "评估结论", detail: overallLabel, provenance: "EVALUATOR_RESULT" }]), constraintReferences: Object.freeze(set?.activeConstraints.map((item) => item.constraintId) ?? []), certainty: evaluation.overallStatus === "NOT_EVALUABLE" ? "NOT_EVALUABLE" : "SUPPORTED", provenance: "EVALUATOR_RESULT", status: evaluationCurrent && setCurrent ? "CURRENT" : "STALE", sourceIdentity: [evaluation.evaluationId, "overall", evaluation.overallStatus], sourceFingerprint: evaluation.postProjectFingerprint, sourceIntentId: intentId, sourceConstraintSetId: set?.constraintSetId });
    for (const metric of evaluation.metricResults) {
      const notEvaluable = metric.status === "NOT_EVALUABLE";
      const statusText = notEvaluable ? "当前无法评估" : metric.status === "PASS" ? "已通过" : metric.status === "FAIL" ? "未通过" : "有提醒";
      const statements = metric.observations.map((observation) => observation.message).filter(Boolean);
      const metricLabel = metric.metric === "HARD_CONSTRAINT_COMPLIANCE" ? "保护约束" : metric.metric === "REQUIREMENT_COMPLETION" ? "需求完成" : metric.metric === "SEMANTIC_MATCH" ? "素材语义匹配" : metric.metric === "RHYTHM_ALIGNMENT" ? "节奏匹配" : metric.metric === "REPETITION" ? "素材重复" : metric.metric === "NARRATIVE_CONTINUITY" ? "叙事连续性" : "内容保留";
      add({ decisionKind: "NOT_EXPLAINABLE", subjectKind: "EVALUATION", subjectId: metric.metric,
        headline: `${metricLabel}核验：${statusText}`,
        summary: notEvaluable ? "当前证据不足，无法判断该项是否通过。" : statements[0] ?? "评估结果未附带可展示的具体说明。",
        evidenceItems: frozenEvidence(metric.observations.map((item) => ({ label: "评估说明", detail: item.message, provenance: "EVALUATOR_RESULT" as const }))),
        constraintReferences: Object.freeze(set?.activeConstraints.map((item) => item.constraintId) ?? []), certainty: notEvaluable ? "NOT_EVALUABLE" : metric.status === "PASS" || metric.status === "FAIL" ? "SUPPORTED" : "UNCERTAIN", provenance: "EVALUATOR_RESULT", status: evaluationCurrent && setCurrent ? "CURRENT" : "STALE", sourceIdentity: [evaluation.evaluationId, metric.metric, metric.status], sourceFingerprint: evaluation.postProjectFingerprint, sourceIntentId: intentId, sourceConstraintSetId: set?.constraintSetId });
    }
  }

  if (input.repairProposal) {
    const proposal = input.repairProposal;
    const repairCurrent = proposal.sourceProjectFingerprint === fingerprint && setCurrent;
    for (const entry of proposal.entries) {
      const decision = input.repairReview?.entries.find((item) => item.repairEntryId === entry.repairEntryId);
      const rejected = decision?.status === "REJECTED" || decision?.status === "NOT_ACTIONABLE";
      const repairBlock = entry.humanProtection === "HUMAN_PROTECTED_AUTO_REPAIR_BLOCKED";
      const action = entry.proposedAction as Readonly<Record<string, unknown>> | undefined;
      const actionType = action?.type;
      const proposedChange = actionType === "REMOVE_CLIP" ? "建议移除一个片段" : actionType === "TRIM_CLIP" ? "建议调整片段范围" : actionType === "REORDER_CLIP" ? "建议调整片段顺序" : actionType === "SET_CLIP_PLAYBACK_SPEED" ? "建议调整片段速度" : actionType === "MATCH_ASSET_TO_SEGMENT" ? "建议为片段匹配素材" : actionType === "SPLIT_CLIP" ? "建议分割片段" : actionType === "SET_CLIP_POSITION_SCALE" ? "建议调整画面位置或大小" : actionType === "SET_CAPTION_TEXT" ? "建议修改字幕" : actionType === "SET_BACKGROUND_AUDIO_RANGE" ? "建议调整背景音频范围" : undefined;
      add({ decisionKind: rejected ? "REPAIR_REJECTED" : "REPAIR_PROPOSED", subjectKind: "REPAIR", subjectId: entry.defectId,
        headline: rejected ? "修复未获批准" : "检测到可审核的修复建议",
        summary: rejected ? "该修复由人工审核拒绝或标记为不可执行，因此不会执行。" : repairBlock ? `修复原因：${entry.reason}。${proposedChange ? `${proposedChange}；` : "修复操作将在审核中确认；"}保护内容不会被自动修改，该建议仍需人工审核。` : `修复原因：${entry.reason}。${proposedChange ? `${proposedChange}；` : "该建议的操作需在审核中查看；"}仍需人工审核，尚未执行。`,
        evidenceItems: frozenEvidence([{ label: "触发原因", detail: entry.reason, provenance: "REPAIR_RESULT" }, ...(proposedChange ? [{ label: "建议调整", detail: proposedChange, provenance: "REPAIR_RESULT" as const }] : [])]), constraintReferences: Object.freeze(set?.activeConstraints.map((item) => item.constraintId) ?? []), certainty: repairCurrent ? "SUPPORTED" : "NOT_EVALUABLE", provenance: rejected ? "HUMAN_REVIEW_DECISION" : "REPAIR_RESULT", status: repairCurrent ? "CURRENT" : "STALE", actionId: entry.repairEntryId, sourceIdentity: [proposal.repairProposalId, entry.repairEntryId, decision?.status], sourceFingerprint: proposal.sourceProjectFingerprint, sourceIntentId: intentId, sourceConstraintSetId: proposal.constraintSet?.constraintSetId });
    }
  }
  if (input.repairResult) {
    const result = input.repairResult;
    const current = result.finalProjectFingerprint === fingerprint;
    const message = result.finalStatus === "REPAIR_FINAL_PASS" ? "修复已通过后续评估。"
      : result.finalStatus === "REPAIR_ROLLED_BACK" ? "修复结果未满足保留条件，项目已回退到修复前状态。"
        : result.finalStatus === "REPAIR_NO_ACTIONS" ? "没有执行修复操作。" : "修复后问题仍未全部解决；本轮流程已结束。";
    add({ decisionKind: result.finalStatus === "REPAIR_ROLLED_BACK" || result.finalStatus === "REPAIR_NO_ACTIONS" ? "REPAIR_REJECTED" : "REPAIR_PROPOSED", subjectKind: "REPAIR", subjectId: result.repairProposal.repairProposalId,
      headline: "修复结果", summary: message, evidenceItems: frozenEvidence([{ label: "修复状态", detail: message, provenance: "REPAIR_RESULT" }]), constraintReferences: Object.freeze(set?.activeConstraints.map((item) => item.constraintId) ?? []), certainty: current ? "SUPPORTED" : "NOT_EVALUABLE", provenance: "REPAIR_RESULT", status: current && setCurrent ? "CURRENT" : "STALE", sourceIdentity: [result.repairProposal.repairProposalId, result.finalStatus, result.finalProjectFingerprint], sourceFingerprint: result.finalProjectFingerprint, sourceIntentId: intentId, sourceConstraintSetId: set?.constraintSetId });
  }
  return Object.freeze(explanations);
}
