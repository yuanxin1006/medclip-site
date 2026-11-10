import { createElement as h } from "react";
import type {
  EditorEvaluationReport,
  EvaluationMetric,
  EvaluationStatus,
} from "./editor-evaluator.ts";

const METRIC_LABEL: Record<EvaluationMetric, string> = {
  HARD_CONSTRAINT_COMPLIANCE: "硬约束合规",
  REQUIREMENT_COMPLETION: "需求完成情况",
  SEMANTIC_MATCH: "语义匹配",
  RHYTHM_ALIGNMENT: "节奏对齐",
  REPETITION: "重复镜头",
  NARRATIVE_CONTINUITY: "叙事连续性",
  PRESERVATION: "状态保护",
};

const STATUS_LABEL: Record<EvaluationStatus, string> = {
  PASS: "通过",
  WARNING: "警告",
  FAIL: "失败",
  NOT_EVALUABLE: "无法判断",
};

const OVERALL_LABEL: Record<EditorEvaluationReport["overallStatus"], string> = {
  PASS: "通过",
  PASS_WITH_WARNINGS: "通过，但有警告",
  FAIL: "失败",
  NOT_EVALUABLE: "无法判断",
  NO_EXECUTED_ACTIONS: "审核完成，无执行操作",
};

export function EditorEvaluationPanel({ report }: Readonly<{ report: EditorEvaluationReport | null }>) {
  if (!report) return null;
  return h("section", { className: "editor-evaluation-panel", "aria-label": "执行结果" },
    h("header", null,
      h("strong", null, "执行结果"),
      h("span", { className: `evaluation-overall status-${report.overallStatus.toLowerCase()}` }, OVERALL_LABEL[report.overallStatus]),
    ),
    h("div", { className: "evaluation-metrics" }, ...report.metricResults.map((result) => h("section", {
      className: `evaluation-metric status-${result.status.toLowerCase()}`,
      key: result.metric,
    },
    h("header", null,
      h("b", null, METRIC_LABEL[result.metric]),
      result.metric === "HARD_CONSTRAINT_COMPLIANCE" ? h("code", null, result.metric) : null,
      h("span", null, STATUS_LABEL[result.status])),
    h("ul", null, ...result.observations.map((observation, index) => h("li", { key: `${observation.intervalId ?? "summary"}-${observation.code}-${index}` },
      observation.reviewDecision === "REJECTED" ? h("span", { className: "evaluation-provenance" }, "用户已拒绝，未执行（符合审核结果）") : null,
      observation.reviewDecision === "MODIFIED" ? h("span", { className: "evaluation-provenance" }, "用户已修改，以用户选择为准") : null,
      h("span", null, observation.message),
      observation.expectedAssetId && observation.observedAssetId
        ? h("small", null, `审核目标：${observation.expectedAssetId}，实际：${observation.observedAssetId}`) : null,
    ))),
    ))),
    report.defects.length ? h("details", { className: "evaluation-defects" },
      h("summary", null, `需要关注的事实（${report.defects.length}）`),
      h("ul", null, ...report.defects.map((item) => h("li", { key: item.id },
        h("b", null, `${METRIC_LABEL[item.metric]}：${STATUS_LABEL[item.severity]}`),
        h("span", null, `预期：${item.expected}`),
        h("span", null, `实际：${item.observed}`),
      ))),
    ) : null,
  );
}
