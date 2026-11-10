import { createElement as h } from "react";
import type { CollaborativeEditingOptionsV1 } from "./editor-collaborative-options.ts";

export type CollaborativeEditingOptionsPanelProps = Readonly<{
  optionSet: CollaborativeEditingOptionsV1 | null;
  selectedOptionId?: string | null;
  onSelectOption?: (optionId: string) => void;
}>;

function duration(value: number | null): string {
  if (value === null) return "未知";
  const seconds = Math.round(value / 1_000);
  return `${seconds} 秒`;
}

export function CollaborativeEditingOptionsPanel({
  optionSet,
  selectedOptionId = null,
  onSelectOption,
}: CollaborativeEditingOptionsPanelProps) {
  if (!optionSet || optionSet.planGenerationMode !== "MULTI_OPTION") return null;
  return h("section", { className: "collaborative-options-panel", "aria-label": "选择剪辑方案" },
    h("header", null,
      h("div", null,
        h("strong", null, "选择剪辑方案"),
        h("p", null, `已生成 ${optionSet.generatedOptionCount} 个实质不同且通过保护校验的方案。选择方案后再进行人工审核。`),
      ),
      h("small", null, "当前版本：本地生成，无 Provider 调用"),
    ),
    optionSet.generationNotice ? h("p", { className: "collaborative-options-notice", role: "status" }, optionSet.generationNotice) : null,
    h("div", { className: "collaborative-option-grid" }, ...optionSet.options.map((option) => {
      const selected = option.optionId === selectedOptionId;
      const gap = option.targetGap.remainingGapMs;
      return h("article", { className: `collaborative-option-card${selected ? " selected" : ""}`, key: option.optionId },
        h("div", { className: "collaborative-option-heading" },
          h("strong", null, option.title),
          h("span", null, option.strategyKind),
        ),
        h("p", null, option.summary),
        h("dl", null,
          h("div", null, h("dt", null, "预计成片时长"), h("dd", null, duration(option.predictedDuration))),
          h("div", null, h("dt", null, "与目标时长差距"), h("dd", null, gap === null ? "未知" : gap === 0 ? "无" : `至少 ${duration(gap)}`)),
          h("div", null, h("dt", null, "保护内容状态"), h("dd", null, option.protectedContentPreserved ? "完整保留" : "不可选择")),
        ),
        h("div", { className: "collaborative-option-detail" },
          h("b", null, "主要变化"),
          h("p", null, option.evidence.whyStrategyDiffers),
          h("b", null, "主要取舍"),
          h("p", null, option.tradeoffs.join("；")),
        ),
        h("button", {
          className: selected ? "platform-primary-button" : "platform-secondary-button",
          type: "button",
          "aria-pressed": selected,
          onClick: () => onSelectOption?.(option.optionId),
        }, selected ? "已选择此方案" : "选择此方案"),
      );
    })),
    h("small", { className: "collaborative-options-safety" }, "选择方案不等于批准，也不会修改项目；仍需逐项完成人工审核。"),
  );
}
