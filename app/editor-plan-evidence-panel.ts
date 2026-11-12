import { createElement as h } from "react";
import type { PlanEvidence, PlanEvidenceEntry } from "./editor-plan-evidence.ts";
import {
  safeModificationCandidates,
  type HumanReviewDecision,
  type HumanReviewState,
} from "./editor-proposal-review.ts";
import type { EditorProposalBundle } from "./editor-proposal-orchestrator.ts";
import { EditorEvaluationPanel } from "./editor-evaluation-panel.ts";
import type { EditorEvaluationReport } from "./editor-evaluator.ts";
import { EditorRepairPanel } from "./editor-repair-panel.ts";
import type {
  ClosedLoopRepairResult,
  RepairProposalBundle,
  RepairReviewDecision,
  RepairReviewState,
} from "./editor-repair.ts";
import { ConstraintNegotiationPanel } from "./editor-constraint-negotiation-panel.ts";
import type { ConstraintFeasibilityReportV1 } from "./editor-constraint-feasibility.ts";
import type {
  ConstraintResolutionChoice,
  ConstraintResolutionV1,
  NegotiationStateV1,
} from "./editor-constraint-negotiation.ts";

const STATUS_LABEL: Record<PlanEvidenceEntry["status"], string> = {
  PENDING_REVIEW: "等待审核",
  APPLIED: "已执行（已应用）",
  NO_OP: "未改变",
  FAILED: "执行失败",
  NOT_EXECUTED: "未执行（用户拒绝）",
  UNRESOLVED: "没有找到足够可信的素材",
};

const REVIEW_LABEL = {
  PENDING: "待审核",
  ACCEPTED: "已接受",
  REJECTED: "已拒绝",
  MODIFIED: "已修改",
} as const;

export type PlanEvidencePanelProps = Readonly<{
  evidence: PlanEvidence | null;
  proposal?: EditorProposalBundle | null;
  review?: HumanReviewState | null;
  onReviewDecision?: (decision: HumanReviewDecision) => void;
  onExecuteReviewed?: () => void;
  executionBusy?: boolean;
  staleMessage?: string | null;
  evaluation?: EditorEvaluationReport | null;
  repairProposal?: RepairProposalBundle | null;
  repairReview?: RepairReviewState | null;
  repairResult?: ClosedLoopRepairResult | null;
  repairExecutionBusy?: boolean;
  onRepairReviewDecision?: (decision: RepairReviewDecision) => void;
  onExecuteReviewedRepair?: () => void;
  negotiationState?: NegotiationStateV1 | null;
  negotiationReport?: ConstraintFeasibilityReportV1 | null;
  constraintResolution?: ConstraintResolutionV1 | null;
  onSelectConstraintResolution?: (choice: ConstraintResolutionChoice) => void;
  onGenerateResolvedProposal?: () => void;
  showDetailedScores?: boolean;
}>;

function score(label: string, value: number) {
  return h("span", { key: label, className: "plan-evidence-score" }, `${label} ${Math.round(value * 100)}/100`);
}

function assetName(proposal: EditorProposalBundle | null | undefined, assetId: string | undefined): string {
  if (!assetId) return "未选择素材";
  return proposal?.trustedPreExecutionProject.assets.find((asset) => asset.id === assetId)?.name ?? assetId;
}

export function PlanEvidencePanel({
  evidence,
  proposal = null,
  review = null,
  onReviewDecision,
  onExecuteReviewed,
  executionBusy = false,
  staleMessage = null,
  evaluation = null,
  repairProposal = null,
  repairReview = null,
  repairResult = null,
  repairExecutionBusy = false,
  onRepairReviewDecision,
  onExecuteReviewedRepair,
  negotiationState = null,
  negotiationReport = null,
  constraintResolution = null,
  onSelectConstraintResolution,
  onGenerateResolvedProposal,
  showDetailedScores = true,
}: PlanEvidencePanelProps) {
  const pending = evidence?.lifecycleStatus === "PENDING_REVIEW";
  const execution = evidence?.summary.execution;
  const reviewByEntry = new Map(review?.entries.map((entry) => [entry.proposalEntryId, entry]) ?? []);
  const pendingCount = review?.entries.filter((entry) => entry.status === "PENDING").length ?? 0;
  const safeNoChange = proposal?.safeNoChangeOutcome;
  const controlsAvailable = Boolean(pending && proposal && review && (safeNoChange || onReviewDecision));
  const canExecute = Boolean(controlsAvailable && pendingCount === 0 && !executionBusy && !staleMessage);

  return h("section", { className: "plan-evidence-panel", "aria-label": "AI 剪辑说明" },
    h(ConstraintNegotiationPanel, {
      state: negotiationState,
      report: negotiationReport,
      resolution: constraintResolution,
      onSelectResolution: onSelectConstraintResolution,
      onGenerateProposal: onGenerateResolvedProposal,
    }),
    h("header", null, h("strong", null, "AI 剪辑说明"), evidence
      ? h("span", null, pending
        ? `${evidence.entries.length} 段，${pendingCount ? `${pendingCount} 条待审核` : "审核已完成"}`
        : evidence.lifecycleStatus === "REVIEWED_NO_ACTIONS"
          ? `${evidence.entries.length} 段，已审核，无执行操作`
          : `${evidence.entries.length} 段，已执行 ${execution?.appliedCount ?? 0}，未改变 ${execution?.noOpCount ?? 0}，失败 ${execution?.failedCount ?? 0}`)
      : h("span", null, "尚无可展示的结构化剪辑证据")),
    staleMessage ? h("p", { className: "plan-evidence-stale", role: "alert" }, staleMessage) : null,
    safeNoChange ? h("div", { className: "plan-evidence-safe-no-change", role: "status" },
      h("strong", null, "当前没有可安全执行的进一步修改"),
      h("p", null, `在保留已确认保护内容的情况下，最短仍为 ${formatMs(safeNoChange.minimumFeasibleDurationMs)}，与目标相差 ${formatMs(safeNoChange.remainingGapMs)}。`),
    ) : null,
    evidence ? h("div", { className: "plan-evidence-list" }, ...evidence.entries.map((entry) => {
      const decision = reviewByEntry.get(entry.proposalEntryId);
      const alternatives = controlsAvailable && proposal && !safeNoChange
        ? safeModificationCandidates(proposal, entry.proposalEntryId)
        : [];
      const selectedAssetId = decision?.status === "MODIFIED" ? decision.selectedAssetId : entry.selectedAssetId;
      return h("details", { className: `plan-evidence-entry status-${entry.status.toLowerCase()}`, key: entry.id },
        h("summary", null,
          h("span", { className: "plan-evidence-status" }, decision ? REVIEW_LABEL[decision.status] : STATUS_LABEL[entry.status]),
          h("strong", null, `${formatMs(entry.interval.startMs)}–${formatMs(entry.interval.endMs)}`),
          h("span", null, assetName(proposal, selectedAssetId)),
          h("small", null, entry.explanation)),
        h("div", { className: "plan-evidence-detail" },
          h("p", null, h("b", null, "目标区间："), entry.interval.caption || entry.intervalId),
          h("p", null, h("b", null, "为什么选："), entry.explanation),
          entry.matching && showDetailedScores ? h("div", { className: "plan-evidence-scores" },
            score("语义匹配", entry.matching.semanticScore), score("素材可用性", entry.matching.usabilityScore),
            score("时长适配", entry.matching.timingScore), score("重复惩罚", entry.matching.repetitionPenalty),
            h("span", { className: "plan-evidence-concepts" }, `支持概念：${entry.matching.matchedConcepts.join("、") || "无"}`),
            h("span", { className: "plan-evidence-concepts" }, `证据片段：${entry.matching.supportingSegmentIds.length} 个，画面时间：${entry.matching.evidenceFrameMs.map(formatMs).join("、") || "无"}`),
          ) : null,
          entry.narrative ? h("p", null, h("b", null, "为什么这样排："), entry.narrative.evidence.length
            ? entry.narrative.evidence.map((item) => item.summary).join("；")
            : "没有记录到相邻内容关系。") : null,
          entry.compiledAction ? h("p", null, h("b", null, pending ? "建议的规范编辑：" : "AI 原建议："),
            `${entry.compiledAction.actionType}：${entry.compiledAction.targetId}`) : null,
          entry.executedAction ? h("p", null, h("b", null, "实际执行："),
            `${entry.executedAction.actionType}：${entry.executedAction.targetId}，${assetName(proposal, entry.executedAction.assetId)}`) : null,
          h("p", null, h("b", null, pending ? "审核状态：" : "执行状态："),
            decision ? REVIEW_LABEL[decision.status] : STATUS_LABEL[entry.status],
            entry.failureCode ? `，${entry.failureCode}` : "", entry.actionResultStatus ? `，${entry.actionResultStatus}` : ""),
          pending && entry.currentProposed ? h("p", null, h("b", null, "当前 → 建议："),
            `${assetName(proposal, entry.currentProposed.currentAssetId)} → ${assetName(proposal, selectedAssetId ?? entry.currentProposed.proposedAssetId)}`) : null,
          entry.humanReview ? h("p", null, h("b", null, "人工决定："),
            `${REVIEW_LABEL[entry.humanReview.decision]}，${entry.humanReview.provenance}`,
            entry.humanReview.decision === "MODIFIED"
              ? `，AI ${assetName(proposal, entry.humanReview.originalAssetId)} → 用户 ${assetName(proposal, entry.humanReview.selectedAssetId)}` : "") : null,
          !pending && entry.beforeAfter ? h("p", null, h("b", null, "执行前后："),
            `${assetName(proposal, entry.beforeAfter.assetBefore)} → ${assetName(proposal, entry.beforeAfter.assetAfter)}`,
            entry.beforeAfter.sourceStartBeforeMs !== undefined && entry.beforeAfter.sourceStartAfterMs !== undefined
              ? `，源片段 ${entry.beforeAfter.sourceStartBeforeMs}–${entry.beforeAfter.sourceEndBeforeMs}ms → ${entry.beforeAfter.sourceStartAfterMs}–${entry.beforeAfter.sourceEndAfterMs}ms` : "") : null,
          entry.matching?.rejectedAlternatives.length ? h("p", null, h("b", null, "其他候选："),
            entry.matching.rejectedAlternatives.map((item) => assetName(proposal, item.assetId)).join("、")) : null,
          controlsAvailable && decision ? h("div", { className: "plan-evidence-review-controls" },
            h("button", { type: "button", onClick: () => onReviewDecision?.({ proposalEntryId: entry.proposalEntryId, decision: "ACCEPT" }) }, "接受"),
            h("button", { type: "button", onClick: () => onReviewDecision?.({ proposalEntryId: entry.proposalEntryId, decision: "REJECT" }) }, "拒绝"),
            alternatives.length ? h("label", null, h("span", null, "修改"), h("select", {
              "aria-label": `修改 ${entry.intervalId} 的素材`,
              value: decision.status === "MODIFIED" ? decision.selectedAssetId : "",
              onChange: (event: { currentTarget: { value: string } }) => {
                if (event.currentTarget.value) onReviewDecision?.({ proposalEntryId: entry.proposalEntryId, decision: "MODIFY", selectedAssetId: event.currentTarget.value });
              },
            }, h("option", { value: "" }, "选择可信候选"), ...alternatives.map((candidate) => h("option", { key: candidate.assetId, value: candidate.assetId }, showDetailedScores ? `${candidate.assetName}，${Math.round(candidate.totalScore * 100)}/100` : candidate.assetName)))) : null,
          ) : null,
        ),
      );
    })) : null,
    controlsAvailable ? h("footer", { className: "plan-evidence-review-footer" },
      h("button", { className: "platform-primary-button", type: "button", disabled: !canExecute, onClick: onExecuteReviewed }, executionBusy ? "正在确认…" : safeNoChange ? "保持当前结果" : "执行已批准修改"),
      h("small", null, safeNoChange
        ? "确认后不会调用执行器，不会修改项目，也不会创建撤销或执行历史。"
        : pendingCount ? `仍有 ${pendingCount} 条建议待审核，暂不能执行。` : "全部条目已审核；执行前将再次校验项目状态。"),
    ) : null,
    h(EditorEvaluationPanel, { report: evaluation }),
    h(EditorRepairPanel, {
      proposal: repairProposal,
      review: repairReview,
      result: repairResult,
      executionBusy: repairExecutionBusy,
      onReviewDecision: onRepairReviewDecision,
      onExecuteReviewed: onExecuteReviewedRepair,
    }),
  );
}

function formatMs(value: number): string {
  const total = Math.max(0, Math.floor(value / 1_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
