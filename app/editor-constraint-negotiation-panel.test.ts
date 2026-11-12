import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConstraintNegotiationPanel } from "./editor-constraint-negotiation-panel.ts";
import { PlanEvidencePanel } from "./editor-plan-evidence-panel.ts";
import {
  createNegotiationStateV1,
  resolveConstraintConflictV1,
  transitionNegotiationStateV1,
  type ConstraintResolutionChoice,
} from "./editor-constraint-negotiation.ts";
import { createCampusNegotiationScenario } from "./test-support/editor-constraint-negotiation-fixture.ts";

function elements(node: ReactNode, type?: string): ReactElement[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  const self = !type || element.type === type ? [element] : [];
  const children = Array.isArray(element.props.children) ? element.props.children : [element.props.children];
  return [...self, ...children.flatMap((child) => elements(child, type))];
}

function resolve(choice: ConstraintResolutionChoice) {
  const scenario = createCampusNegotiationScenario();
  const conflict = scenario.report.conflicts.find((item) => item.type === "DURATION_CONFLICT")!;
  return resolveConstraintConflictV1({
    state: scenario.state, intent: scenario.intent, project: scenario.project,
    projectFingerprint: scenario.projectFingerprint, confirmedBindings: scenario.confirmedBindings,
    feasibilityReport: scenario.report, conflictId: conflict.conflictId,
    selectedResolution: choice, createdAt: "2026-10-25T01:00:00.000Z",
  });
}

test("grounding-required UI is separate from duration conflict language", () => {
  const scenario = createCampusNegotiationScenario();
  const grounding = transitionNegotiationStateV1(createNegotiationStateV1(scenario.intent), {
    status: "GROUNDING_REQUIRED", activeIntentVersionId: scenario.intent.intentId,
    resolutionIds: [], unresolvedConflictIds: [], planningPaused: false,
  });
  const html = renderToStaticMarkup(ConstraintNegotiationPanel({ state: grounding }));
  assert.match(html, /我还不能可靠确定老师完整讲话的准确范围/);
  assert.match(html, /候选建议不等于已确认事实/);
  assert.doesNotMatch(html, /无法同时满足 30 秒目标/);
});

test("duration decision UI shows deterministic 30/38/8 facts and structured A/B/C controls", () => {
  const scenario = createCampusNegotiationScenario();
  const decisions: ConstraintResolutionChoice[] = [];
  const tree = ConstraintNegotiationPanel({ state: scenario.state, report: scenario.report, onSelectResolution: (choice) => decisions.push(choice) });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /我发现一个需要您决定的问题/);
  assert.match(html, /目标时长：30 秒/);
  assert.match(html, /当前最短可行时长：38 秒/);
  assert.match(html, /仍相差：8 秒/);
  assert.match(html, /保留老师完整讲话和结尾 Logo 后/);
  const buttons = elements(tree, "button") as Array<ReactElement<{ children?: ReactNode; onClick?: () => void }>>;
  buttons.filter((item) => typeof item.props.children === "string" && /^[ABC]\./.test(item.props.children)).forEach((item) => item.props.onClick?.());
  assert.deepEqual(decisions, ["RELAX_TARGET_DURATION", "OPTIMIZE_UNPROTECTED_ONLY", "EDIT_REQUIREMENTS_MANUALLY"]);
  assert.doesNotMatch(html, /\{&quot;|"conflictId"/);
});

test("option A result enables proposal generation only at READY_TO_PLAN", () => {
  const scenario = createCampusNegotiationScenario();
  const before = elements(ConstraintNegotiationPanel({ state: scenario.state, report: scenario.report, onGenerateProposal: () => undefined }), "button") as Array<ReactElement<{ children?: ReactNode; disabled?: boolean }>>;
  assert.equal(before.find((item) => item.props.children === "生成 AI 剪辑建议")?.props.disabled, true);
  const result = resolve("RELAX_TARGET_DURATION");
  const after = elements(ConstraintNegotiationPanel({ state: result.state, report: result.feasibilityReport, resolution: result.resolution, onGenerateProposal: () => undefined }), "button") as Array<ReactElement<{ children?: ReactNode; disabled?: boolean }>>;
  assert.equal(after.find((item) => item.props.children === "生成 AI 剪辑建议")?.props.disabled, false);
});

test("option B result keeps the explicit remaining gap and makes no false execution-enforcement claim", () => {
  const result = resolve("OPTIMIZE_UNPROTECTED_ONLY");
  const html = renderToStaticMarkup(ConstraintNegotiationPanel({ state: result.state, report: result.feasibilityReport, resolution: result.resolution, onGenerateProposal: () => undefined }));
  assert.match(html, /当前最短可行时长仍为38 秒，比目标多8 秒/);
  assert.match(html, /执行层强制保护将在后续安全校验阶段生效/);
  assert.doesNotMatch(html, /系统已保证任何操作都不能修改该内容/);
  assert.doesNotMatch(html, /已满足30秒|已达到30秒/);
});

test("option C visibly pauses planning and keeps proposal generation disabled", () => {
  const result = resolve("EDIT_REQUIREMENTS_MANUALLY");
  const tree = ConstraintNegotiationPanel({ state: result.state, resolution: result.resolution, onGenerateProposal: () => undefined });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /已暂停规划/);
  const button = (elements(tree, "button") as Array<ReactElement<{ children?: ReactNode; disabled?: boolean }>>).find((item) => item.props.children === "生成 AI 剪辑建议");
  assert.equal(button?.props.disabled, true);
});

test("the existing proposal/review panel hosts negotiation without exposing raw JSON", () => {
  const scenario = createCampusNegotiationScenario();
  const html = renderToStaticMarkup(PlanEvidencePanel({
    evidence: null,
    negotiationState: scenario.state,
    negotiationReport: scenario.report,
    onSelectConstraintResolution: () => undefined,
  }));
  assert.match(html, /我发现一个需要您决定的问题/);
  assert.match(html, /目标时长：30 秒/);
  assert.doesNotMatch(html, /&quot;conflictId&quot;|\{"schemaVersion"/);
});
