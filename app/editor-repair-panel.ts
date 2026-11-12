import { createElement as h } from "react";
import type {
  ClosedLoopRepairResult,
  RepairProposalBundle,
  RepairReviewDecision,
  RepairReviewState,
} from "./editor-repair.ts";

export type EditorRepairPanelProps = Readonly<{
  proposal: RepairProposalBundle | null;
  review: RepairReviewState | null;
  result?: ClosedLoopRepairResult | null;
  executionBusy?: boolean;
  onReviewDecision?: (decision: RepairReviewDecision) => void;
  onExecuteReviewed?: () => void;
}>;

const METRIC_LABEL = {
  HARD_CONSTRAINT_COMPLIANCE: "硬约束违规",
  REQUIREMENT_COMPLETION: "已审核要求未实现",
  SEMANTIC_MATCH: "语义匹配较弱",
  RHYTHM_ALIGNMENT: "节奏对齐提醒",
  REPETITION: "镜头重复",
  NARRATIVE_CONTINUITY: "叙事连续性提醒",
  PRESERVATION: "受保护状态异常",
} as const;

function assetName(proposal: RepairProposalBundle, assetId: string | undefined): string {
  if (!assetId) return "无";
  return proposal.trustedPreRepairProject.assets.find((asset) => asset.id === assetId)?.name ?? assetId;
}

function finalMessage(result: ClosedLoopRepairResult): string {
  if (result.finalStatus === "REPAIR_FINAL_PASS") return "修复成功";
  if (result.finalStatus === "REPAIR_ROLLED_BACK") return "修复结果变差，已恢复到修复前状态";
  if (result.finalStatus === "REPAIR_NO_ACTIONS") return "用户未执行修复";
  return "修复后仍有问题";
}

export function EditorRepairPanel({
  proposal,
  review,
  result = null,
  executionBusy = false,
  onReviewDecision,
  onExecuteReviewed,
}: EditorRepairPanelProps) {
  if (!proposal) return null;
  const reviewById = new Map(review?.entries.map((entry) => [entry.repairEntryId, entry]) ?? []);
  const actionable = proposal.entries.filter((entry) => entry.repairEligibility === "ELIGIBLE");
  const pendingCount = review?.entries.filter((entry) => entry.status === "PENDING").length ?? 0;
  const controlsAvailable = Boolean(!result && review && onReviewDecision);
  const canExecute = Boolean(controlsAvailable && actionable.length > 0 && pendingCount === 0
    && review?.lifecycle === "REPAIR_READY_TO_EXECUTE" && !executionBusy);
  return h("section", { className: "editor-repair-panel", "aria-label": "修复建议" },
    h("header", null,
      h("strong", null, "修复建议"),
      h("span", null, result ? finalMessage(result)
        : actionable.length ? `${actionable.length} 条可审核修复` : "当前问题需要人工处理"),
    ),
    h("div", { className: "editor-repair-list" }, ...proposal.entries.map((entry) => {
      const decision = reviewById.get(entry.repairEntryId);
      const blocked = entry.humanProtection === "HUMAN_PROTECTED_AUTO_REPAIR_BLOCKED";
      return h("article", { className: `editor-repair-entry eligibility-${entry.repairEligibility.toLowerCase()}`, key: entry.repairEntryId },
        h("header", null,
          h("b", null, METRIC_LABEL[entry.metric]),
          h("span", null, entry.severity === "FAIL" ? "需要修复" : "建议关注"),
        ),
        h("p", null, h("b", null, "检测到的问题："), `${entry.defectCode}，${entry.currentObservedState.metricValue}`),
        h("p", null, h("b", null, "当前状态："), assetName(proposal, entry.currentObservedState.assetId)),
        entry.proposedAction ? h("p", null, h("b", null, "建议修正为："), assetName(proposal, entry.proposedAction.assetId)) : null,
        h("p", null, h("b", null, "原因与证据："), entry.reason),
        blocked ? h("p", { className: "editor-repair-protected", role: "status" }, "这是用户明确选择的结果，系统不会自动替换。") : null,
        entry.repairEligibility === "UNSUPPORTED" && entry.metric === "RHYTHM_ALIGNMENT"
          ? h("p", { className: "editor-repair-report-only" }, "当前仅保留节奏提醒，不自动移动切点。") : null,
        controlsAvailable && decision?.status !== "NOT_ACTIONABLE" ? h("div", { className: "editor-repair-controls" },
          h("button", { type: "button", onClick: () => onReviewDecision?.({ repairEntryId: entry.repairEntryId, decision: "ACCEPT" }) }, "接受修复"),
          h("button", { type: "button", onClick: () => onReviewDecision?.({ repairEntryId: entry.repairEntryId, decision: "REJECT" }) }, "拒绝修复"),
          entry.trustedAlternatives.length > 1 ? h("label", null,
            h("span", null, "修改修复"),
            h("select", {
              "aria-label": `修改修复 ${entry.intervalId ?? entry.repairEntryId}`,
              value: decision?.status === "MODIFIED" ? decision.selectedAssetId : "",
              onChange: (event: { currentTarget: { value: string } }) => {
                if (event.currentTarget.value) onReviewDecision?.({
                  repairEntryId: entry.repairEntryId,
                  decision: "MODIFY",
                  selectedAssetId: event.currentTarget.value,
                });
              },
            },
            h("option", { value: "" }, "选择可信替代素材"),
            ...entry.trustedAlternatives.map((alternative) => h("option", {
              key: alternative.assetId,
              value: alternative.assetId,
            }, `${alternative.assetName}，语义 ${Math.round(alternative.semanticScore * 100)}/100`))),
          ) : null,
        ) : null,
      );
    })),
    result ? h("footer", { className: `editor-repair-result status-${result.finalStatus.toLowerCase()}` },
      h("strong", null, finalMessage(result)),
      result.finalStatus === "REPAIR_FINAL_UNRESOLVED_IMPROVED"
        ? h("small", null, "结果已有安全改善，但仍保留提醒；本轮到此停止。") : null,
      result.finalStatus === "REPAIR_ROLLED_BACK"
        ? h("small", null, "修复前的已审核工程已完整恢复，未保留本次修复历史。") : null,
    ) : controlsAvailable && actionable.length ? h("footer", { className: "editor-repair-review-footer" },
      h("button", {
        className: "platform-primary-button",
        disabled: !canExecute,
        onClick: onExecuteReviewed,
        type: "button",
      }, executionBusy ? "正在执行修复…" : "执行已批准修复"),
      h("small", null, pendingCount ? `仍有 ${pendingCount} 条修复建议待审核。` : actionable.length ? "所有可执行修复均已审核。" : "没有可自动执行的修复。"),
    ) : null,
  );
}
