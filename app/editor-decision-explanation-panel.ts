import { createElement as h } from "react";
import type { EditorDecisionExplanationV1, ExplanationProvenanceV1 } from "./editor-decision-explanations.ts";
import { formatTimeMs } from "./editor-core.ts";

const provenanceLabel: Readonly<Record<ExplanationProvenanceV1, string>> = {
  USER_STATED: "你的要求", USER_CONFIRMED: "你已确认", DETERMINISTIC_ANALYSIS: "素材分析",
  MODEL_SUGGESTED_UNTRUSTED: "系统建议，待审核", SYSTEM_RULE: "保护规则",
  HUMAN_REVIEW_DECISION: "人工审核决定", EVALUATOR_RESULT: "执行评估", REPAIR_RESULT: "修复评估",
};
const certaintyLabel = { CONFIRMED: "已确认", SUPPORTED: "有依据", INFERRED: "推断", UNCERTAIN: "不确定", NOT_EVALUABLE: "无法评估" } as const;
const formatRangeTime = (valueMs: number) => formatTimeMs(valueMs).replace(/\.000$/, "");

export function EditorDecisionExplanationPanel({
  explanations, selectedProtectionClauseId,
}: Readonly<{ explanations: readonly EditorDecisionExplanationV1[]; selectedProtectionClauseId?: string | null }>) {
  if (!explanations.length) return null;
  return h("section", { className: "editor-decision-explanation-panel", "aria-label": "AI 剪辑说明" },
    h("header", { className: "decision-explanation-heading" },
      h("div", null, h("strong", null, "AI 剪辑说明"), h("p", null, "说明只依据当前项目中的结构化证据。")),
      h("span", null, `${explanations.filter((item) => item.status === "CURRENT").length} 条当前说明`),
    ),
    h("div", { className: "decision-explanation-list" }, ...explanations.map((item) => {
      const highlighted = item.subjectKind === "PROTECTION" && item.subjectId === selectedProtectionClauseId;
      return h("article", {
        className: `decision-explanation status-${item.status.toLowerCase()} ${highlighted ? "selected" : ""}`,
        key: item.explanationId,
      },
      h("div", { className: "decision-explanation-overview" },
        h("div", null, h("b", null, item.headline), h("span", { className: `decision-certainty certainty-${item.certainty.toLowerCase()}` }, certaintyLabel[item.certainty])),
        h("p", null, item.summary),
        item.timelineRange ? h("p", { className: "decision-explanation-range" },
          `保护范围：${formatRangeTime(item.timelineRange.startMs)}–${formatRangeTime(item.timelineRange.endMs)}`,
        ) : null,
        item.status === "STALE" ? h("span", { className: "decision-stale-status", role: "status" }, "当前说明已失效，需要重新分析") : null,
      ),
      item.evidenceItems.length ? h("details", { className: "decision-explanation-details" },
        h("summary", null, "查看依据与参与来源"),
        h("ul", null, ...item.evidenceItems.map((evidence, index) => h("li", { key: `${item.explanationId}-${index}` },
          h("b", null, evidence.label), h("span", null, evidence.detail),
          h("small", null, provenanceLabel[evidence.provenance]),
        ))),
        h("p", null, `说明来源：${provenanceLabel[item.provenance]}`),
        item.tradeoff ? h("p", null, `方案取舍：${item.tradeoff}`) : null,
      ) : null,
      );
    })),
  );
}
