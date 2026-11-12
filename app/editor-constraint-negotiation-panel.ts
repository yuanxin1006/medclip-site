import { createElement as h } from "react";
import type { ConstraintFeasibilityReportV1 } from "./editor-constraint-feasibility.ts";
import type {
  ConstraintResolutionChoice,
  ConstraintResolutionV1,
  NegotiationStateV1,
} from "./editor-constraint-negotiation.ts";

export type ConstraintNegotiationPanelProps = Readonly<{
  state: NegotiationStateV1 | null;
  report?: ConstraintFeasibilityReportV1 | null;
  resolution?: ConstraintResolutionV1 | null;
  onSelectResolution?: (choice: ConstraintResolutionChoice) => void;
  onGenerateProposal?: () => void;
  proposalBusy?: boolean;
}>;

function seconds(value: number | null): string {
  return value === null ? "未知" : `${Math.round(value / 1_000)} 秒`;
}

export function ConstraintNegotiationPanel({
  state,
  report = null,
  resolution = null,
  onSelectResolution,
  onGenerateProposal,
  proposalBusy = false,
}: ConstraintNegotiationPanelProps) {
  if (!state) return null;
  const durationConflict = report?.conflicts.find((item) => item.type === "DURATION_CONFLICT" && item.evidence.kind === "DURATION_GAP");
  const gap = durationConflict?.evidence.kind === "DURATION_GAP" ? durationConflict.evidence : null;
  const optimizePolicy = resolution?.selectedResolution === "OPTIMIZE_UNPROTECTED_ONLY"
    && resolution.structuredPolicy.policy === "CLOSEST_SAFELY_ACHIEVABLE"
    ? resolution.structuredPolicy : null;
  const canGenerate = state.status === "READY_TO_PLAN" && !state.planningPaused && Boolean(onGenerateProposal) && !proposalBusy;

  return h("section", { className: "constraint-negotiation-panel", "aria-label": "约束协商" },
    state.status === "GROUNDING_REQUIRED" ? h("div", { role: "status" },
      h("strong", null, "需要先确认保护对象"),
      h("p", null, "我还不能可靠确定老师完整讲话的准确范围，请先确认要保护的片段。"),
      h("small", null, "可确认可信的片段、字幕、时间线范围或源素材范围；候选建议不等于已确认事实。"),
    ) : null,
    state.status === "NEEDS_USER_DECISION" ? h("div", { role: "alert" },
      h("strong", null, "我发现一个需要您决定的问题"),
      gap ? h("div", { className: "constraint-negotiation-facts" },
        h("p", null, `目标时长：${seconds(gap.requestedDurationMs)}`),
        h("p", null, `当前最短可行时长：${seconds(gap.minimumFeasibleDurationMs)}`),
        h("p", null, `仍相差：${seconds(gap.remainingGapMs)}`),
        h("p", null, `保留老师完整讲话和结尾 Logo 后，当前最短可行时长约为 ${seconds(gap.minimumFeasibleDurationMs)}，因此无法同时满足 ${seconds(gap.requestedDurationMs)}目标。`),
      ) : h("p", null, "当前存在尚未解决的结构化约束冲突。"),
      h("div", { className: "constraint-negotiation-options" },
        h("button", { type: "button", onClick: () => onSelectResolution?.("RELAX_TARGET_DURATION") }, "A. 允许视频超过30秒，优先保证讲话和Logo完整"),
        h("button", { type: "button", onClick: () => onSelectResolution?.("OPTIMIZE_UNPROTECTED_ONLY") }, "B. 优先压缩其他非保护内容，尽量接近30秒，但不改变讲话和Logo"),
        h("button", { type: "button", onClick: () => onSelectResolution?.("EDIT_REQUIREMENTS_MANUALLY") }, "C. 暂时不执行，我要手动修改要求"),
      ),
    ) : null,
    state.status === "DRAFT" && state.planningPaused ? h("p", { role: "status" }, "已暂停规划。请手动修改要求；现有已确认绑定不会被静默删除。") : null,
    optimizePolicy && state.status === "READY_TO_PLAN" && !optimizePolicy.canReachRequestedDuration ? h("p", { role: "status" },
      `在不修改受保护内容的情况下，当前最短可行时长仍为${seconds(optimizePolicy.minimumFeasibleDurationMs)}，比目标多${seconds(optimizePolicy.remainingGapMs)}。`,
    ) : null,
    state.status === "READY_TO_PLAN" ? h("p", { role: "status" }, "约束协商已完成，可以基于当前意图和约束上下文生成新建议。") : null,
    state.status === "BLOCKED" ? h("p", { role: "alert" }, state.reason ?? "当前上下文不可评估，规划已阻止。") : null,
    h("p", { className: "constraint-negotiation-safety-note" }, "已确认保护对象；执行层强制保护将在后续安全校验阶段生效。"),
    h("button", {
      className: "platform-secondary-button",
      type: "button",
      disabled: !canGenerate,
      onClick: onGenerateProposal,
    }, proposalBusy ? "正在生成本地建议…" : "生成 AI 剪辑建议"),
  );
}
