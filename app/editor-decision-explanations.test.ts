import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorDecisionExplanationPanel } from "./editor-decision-explanation-panel.ts";
import { deriveEditorDecisionExplanationsV1 } from "./editor-decision-explanations.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import { deriveProtectedTimelineAnnotationsV1 } from "./editor-protected-timeline.ts";
import { guardManualTimelineMutationV1 } from "./editor-manual-constraint-guard.ts";
import { createCampusNegotiationScenario } from "./test-support/editor-constraint-negotiation-fixture.ts";
import { createConstraintEnforcementFixture } from "./test-support/editor-constraint-enforcement-fixture.ts";
import type { PlanEvidence } from "./editor-plan-evidence.ts";
import type { CollaborativeEditingOptionsV1 } from "./editor-collaborative-options.ts";
import type { EditorEvaluationReport } from "./editor-evaluator.ts";

function campus() {
  const fixture = createConstraintEnforcementFixture();
  const annotations = deriveProtectedTimelineAnnotationsV1({ project: fixture.project, intent: fixture.intent, constraintSet: fixture.constraintSet, confirmedBindings: fixture.confirmedBindings });
  return { ...fixture, annotations };
}

test("confirmed protection explanations preserve user provenance and teacher/logo identity", () => {
  const fixture = campus();
  const explanations = deriveEditorDecisionExplanationsV1({ project: fixture.project, intent: fixture.intent, constraintSet: fixture.constraintSet, annotations: fixture.annotations });
  const teacher = explanations.find((item) => item.subjectId === fixture.annotations[0].sourceClauseId)!;
  const logo = explanations.find((item) => item.subjectId === fixture.annotations[1].sourceClauseId)!;
  assert.equal(teacher.decisionKind, "PROTECTED");
  assert.equal(teacher.provenance, "USER_CONFIRMED");
  assert.equal(teacher.status, "CURRENT");
  assert.deepEqual(teacher.timelineRange, { coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 });
  assert.match(teacher.summary, /由你确认/);
  assert.match(teacher.evidenceItems.find((item) => item.label === "限制")?.detail ?? "", /移动|修剪|变换/);
  assert.equal(logo.decisionKind, "PROTECTED");
  assert.equal(logo.provenance, "USER_CONFIRMED");
  assert.equal(logo.status, "CURRENT");
  assert.deepEqual(logo.timelineRange, { coordinateSpace: "TIMELINE", startMs: 35_000, endMs: 38_000 });
  assert.match(logo.summary, /由你确认/);
  assert.notEqual(teacher.explanationId, logo.explanationId);
  assert.deepEqual(fixture.annotations.map(({ timelineStart, timelineEnd }) => [timelineStart, timelineEnd]), [[0, 35_000], [35_000, 38_000]]);
});

test("unresolved requests and candidate bindings are never described as confirmed protection", () => {
  const scenario = createCampusNegotiationScenario();
  const unresolvedAnnotations = deriveProtectedTimelineAnnotationsV1({ project: scenario.project, intent: scenario.intent });
  const unresolved = deriveEditorDecisionExplanationsV1({ project: scenario.project, intent: scenario.intent, annotations: unresolvedAnnotations });
  assert.ok(unresolved.filter((item) => item.subjectKind === "PROTECTION").every((item) => item.provenance !== "USER_CONFIRMED" && !/由你确认/.test(item.summary)));
  const candidate = { ...unresolvedAnnotations[0], status: "CANDIDATE_BINDING" as const, timelineStart: 0, timelineEnd: 35_000 };
  const candidateExplanation = deriveEditorDecisionExplanationsV1({ project: scenario.project, intent: scenario.intent, annotations: [candidate] })[0];
  assert.match(candidateExplanation.summary, /候选范围/);
  assert.notEqual(candidateExplanation.certainty, "CONFIRMED");
  assert.equal(candidateExplanation.timelineRange, undefined);
});

test("campus duration explanation reports 30/38/8 without framing the gap as an error", () => {
  const scenario = createCampusNegotiationScenario();
  const explanation = deriveEditorDecisionExplanationsV1({ project: scenario.project, intent: scenario.intent, constraintSet: scenario.constraintSet, feasibilityReport: scenario.report }).find((item) => item.decisionKind === "DURATION_GAP")!;
  assert.match(explanation.summary, /30 秒/);
  assert.match(explanation.summary, /38 秒/);
  assert.equal(explanation.evidenceItems.find((item) => item.label === "剩余差距")?.detail, "8 秒");
  assert.equal(explanation.status, "CURRENT");
  assert.equal(explanation.timelineRange, undefined);
});

test("blocked transform and reorder explanations link to actual V2.3E results", () => {
  const fixture = campus();
  const changed = structuredClone(fixture.project);
  changed.tracks[0].clips[0].transform.scale = 1.1;
  const transform = guardManualTimelineMutationV1({ currentProject: fixture.project, candidateProject: changed, constraintSet: fixture.constraintSet, action: { type: "SET_CLIP_POSITION_SCALE", targetId: "clip-teacher", scale: 1.1 } });
  const transformExplanation = deriveEditorDecisionExplanationsV1({ project: fixture.project, intent: fixture.intent, constraintSet: fixture.constraintSet, annotations: fixture.annotations, blockedEnforcement: transform }).find((item) => item.decisionKind === "BLOCKED_BY_CONSTRAINT")!;
  assert.equal(transformExplanation.constraintReferences[0], transform.violations[0].constraintId);
  assert.match(transformExplanation.summary, /老师/);
  assert.deepEqual(transformExplanation.timelineRange, { coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 });
  const reorder = guardManualTimelineMutationV1({ currentProject: fixture.project, candidateProject: fixture.project, constraintSet: fixture.constraintSet, action: { type: "REORDER_CLIP", targetId: "clip-logo", referenceId: "clip-teacher", placement: "BEFORE" } });
  const reorderExplanation = deriveEditorDecisionExplanationsV1({ project: fixture.project, intent: fixture.intent, constraintSet: fixture.constraintSet, annotations: fixture.annotations, blockedEnforcement: reorder }).find((item) => item.decisionKind === "BLOCKED_BY_CONSTRAINT")!;
  assert.equal(reorderExplanation.constraintReferences[0], reorder.violations[0].constraintId);
});

test("post-execution Human Review acceptance, rejection and modification keep their provenance", () => {
  const { project, intent, constraintSet } = campus();
  const fingerprint = createEditorProjectFingerprint(project);
  const reviewedEvidence = {
    planId: "private-plan-id", summary: { execution: { postProjectReference: fingerprint } },
    entries: ["ACCEPTED", "REJECTED", "MODIFIED"].map((decision, i) => ({ intervalId: `interval-${i}`, proposalEntryId: `entry-${i}`, humanReview: { decision } })),
  } as unknown as PlanEvidence;
  const explanations = deriveEditorDecisionExplanationsV1({ project, intent, constraintSet, reviewedEvidence });
  assert.equal(explanations.filter((item) => item.provenance === "HUMAN_REVIEW_DECISION").length, 3);
  assert.ok(explanations.some((item) => item.headline.includes("由你确认")));
  assert.ok(explanations.some((item) => item.headline.includes("拒绝")));
  assert.ok(explanations.some((item) => item.decisionKind === "USER_MODIFIED"));
});

test("NOT_EVALUABLE is explicit and never presented as PASS", () => {
  const { project, intent, constraintSet } = campus();
  const fingerprint = createEditorProjectFingerprint(project);
  const evaluation = { evaluationId: "private-evaluation-id", postProjectFingerprint: fingerprint, overallStatus: "NOT_EVALUABLE", warnings: [], notEvaluable: [], metricResults: [{ metric: "HARD_CONSTRAINT_COMPLIANCE", status: "NOT_EVALUABLE", observations: [] }] } as unknown as EditorEvaluationReport;
  const explanations = deriveEditorDecisionExplanationsV1({ project, intent, constraintSet, evaluation });
  const metric = explanations.find((item) => item.subjectId === "HARD_CONSTRAINT_COMPLIANCE")!;
  assert.equal(metric.certainty, "NOT_EVALUABLE");
  assert.match(metric.headline, /无法评估/);
  assert.doesNotMatch(metric.headline, /通过/);
});

test("evaluator explanations preserve authoritative zero-action versus executed wording", () => {
  const { project, intent, constraintSet } = campus();
  const fingerprint = createEditorProjectFingerprint(project);
  const evaluation = (evaluationId: string, overallStatus: "NO_EXECUTED_ACTIONS" | "PASS", message: string) => ({
    evaluationId,
    postProjectFingerprint: fingerprint,
    overallStatus,
    warnings: [],
    notEvaluable: [],
    metricResults: [{
      metric: "HARD_CONSTRAINT_COMPLIANCE",
      status: "PASS",
      observations: [{ status: "PASS", code: "HARD_CONSTRAINTS_PRESERVED", message }],
    }],
  }) as unknown as EditorEvaluationReport;
  const zeroAction = deriveEditorDecisionExplanationsV1({
    project,
    intent,
    constraintSet,
    evaluation: evaluation("private-zero-action-evaluation", "NO_EXECUTED_ACTIONS", "当前工程完整保留了所有活动硬约束，本轮未执行编辑动作。"),
  }).find((item) => item.subjectId === "HARD_CONSTRAINT_COMPLIANCE")!;
  const executed = deriveEditorDecisionExplanationsV1({
    project,
    intent,
    constraintSet,
    evaluation: evaluation("private-executed-evaluation", "PASS", "真实执行后工程完整保留了所有活动硬约束。"),
  }).find((item) => item.subjectId === "HARD_CONSTRAINT_COMPLIANCE")!;

  assert.equal(zeroAction.summary, "当前工程完整保留了所有活动硬约束，本轮未执行编辑动作。");
  assert.doesNotMatch(zeroAction.summary, /真实执行后|执行后|修改后/);
  assert.equal(executed.summary, "真实执行后工程完整保留了所有活动硬约束。");
  const html = renderToStaticMarkup(createElement(EditorDecisionExplanationPanel, { explanations: [zeroAction, executed] }));
  assert.doesNotMatch(html, /private-zero-action-evaluation|private-executed-evaluation|\{\s*"/);
});

test("stale fingerprints fail closed and explanation derivation leaves project and ConstraintSet unchanged", () => {
  const fixture = campus();
  const beforeProject = structuredClone(fixture.project);
  const beforeConstraints = structuredClone(fixture.constraintSet);
  const changed = structuredClone(fixture.project);
  changed.title += " changed";
  const explanations = deriveEditorDecisionExplanationsV1({ project: changed, intent: fixture.intent, constraintSet: fixture.constraintSet, annotations: fixture.annotations });
  assert.ok(explanations.filter((item) => item.subjectKind === "PROTECTION").every((item) => item.status === "STALE" && item.certainty === "NOT_EVALUABLE" && item.constraintReferences.length === 0));
  assert.deepEqual(fixture.project, beforeProject);
  assert.deepEqual(fixture.constraintSet, beforeConstraints);
});

test("single and multi-option explanations reflect actual generation mode and avoid fee claims", () => {
  const { project, intent, constraintSet } = campus();
  const fingerprint = createEditorProjectFingerprint(project);
  const common = { schemaVersion: 1 as const, optionSetId: "private-option-id", requestedOptionCount: 3, generatedOptionCount: 1, providerGenerationBudget: 0, providerCallsUsed: 0 as const, networkCallsUsed: 0 as const, intentVersionId: intent.intentId, constraintSetId: constraintSet.constraintSetId, constraintFingerprint: constraintSet.constraintFingerprint, constraintResolutionId: null, projectFingerprint: fingerprint, feasibilityRef: { reportId: "private-report-id", requestedDurationMs: 30_000, minimumFeasibleDurationMs: 38_000, remainingGapMs: 8_000 } };
  const single = { ...common, planGenerationMode: "SINGLE" as const, options: [] } as unknown as CollaborativeEditingOptionsV1;
  const singleExplanation = deriveEditorDecisionExplanationsV1({ project, intent, constraintSet, options: single });
  assert.match(singleExplanation[0].summary, /没有生成多个/);
  assert.doesNotMatch(singleExplanation[0].summary, /多个方案.*已生成/);
  const deduped = { ...common, planGenerationMode: "MULTI_OPTION" as const, options: [{ optionId: "private-one", strategyKind: "BALANCED", title: "平衡方案", summary: "平衡内容和节奏", tradeoffs: [], proposalBundle: { compiledPlan: { canonicalPlan: { actions: [] } } } }] } as unknown as CollaborativeEditingOptionsV1;
  const multiExplanation = deriveEditorDecisionExplanationsV1({ project, intent, constraintSet, options: deduped });
  assert.match(multiExplanation[0].summary, /没有生成其他/);
  assert.ok(multiExplanation[0].evidenceItems.some((item) => /0 次；未产生额外 API 费用/.test(item.detail)));
  assert.ok(!multiExplanation.some((item) => /费用/.test(item.summary)));
});

test("distinct multi-option plans describe their concrete strategy direction", () => {
  const { project, intent, constraintSet } = campus();
  const fingerprint = createEditorProjectFingerprint(project);
  const options = {
    schemaVersion: 1, optionSetId: "options", planGenerationMode: "MULTI_OPTION", requestedOptionCount: 2, generatedOptionCount: 2,
    providerGenerationBudget: 0, providerCallsUsed: 0, networkCallsUsed: 0, intentVersionId: intent.intentId,
    constraintSetId: constraintSet.constraintSetId, constraintFingerprint: constraintSet.constraintFingerprint,
    constraintResolutionId: null, projectFingerprint: fingerprint,
    feasibilityRef: { reportId: "report", requestedDurationMs: 30_000, minimumFeasibleDurationMs: 38_000, remainingGapMs: 8_000 },
    options: [
      { optionId: "option-a", strategyKind: "CONTENT_PRIORITY", title: "内容优先", summary: "保留更多内容", tradeoffs: [], proposalBundle: { compiledPlan: { canonicalPlan: { actions: [{ type: "DELETE_CLIP", targetId: "a" }] } } } },
      { optionId: "option-b", strategyKind: "RHYTHM_PRIORITY", title: "节奏优先", summary: "优化可编辑内容节奏", tradeoffs: [], proposalBundle: { compiledPlan: { canonicalPlan: { actions: [{ type: "DELETE_CLIP", targetId: "b" }] } } } },
    ],
  } as unknown as CollaborativeEditingOptionsV1;
  const explanations = deriveEditorDecisionExplanationsV1({ project, intent, constraintSet, options });
  assert.equal(explanations.length, 2);
  assert.match(explanations[0].evidenceItems[0].detail, /内容优先/);
  assert.match(explanations[1].evidenceItems[0].detail, /节奏优先/);
});

test("proposed edits show their supported reason and safely name non-removal edit categories", () => {
  const { project, intent, constraintSet } = campus();
  const fingerprint = createEditorProjectFingerprint(project);
  const proposal = {
    proposalId: "private-proposal-id", sourceProjectFingerprint: fingerprint, constraintSet,
    compiledPlan: { canonicalPlan: { actions: [{ type: "SET_CAPTION_TEXT", targetId: "caption-1", text: "updated", reason: "修正识别错字" }] } },
    planEvidence: { entries: [{ compiledAction: { actionIndex: 0, targetId: "caption-1" }, explanation: "字幕识别结果与确认文本不一致" }] },
  } as never;
  const explanation = deriveEditorDecisionExplanationsV1({ project, intent, constraintSet, proposal })[0];
  assert.equal(explanation.decisionKind, "NOT_EXPLAINABLE");
  assert.match(explanation.headline, /修改字幕/);
  assert.match(explanation.summary, /字幕识别结果与确认文本不一致/);
  assert.doesNotMatch(explanation.headline, /SET_CAPTION_TEXT|caption-1/);
});

test("repair explanation states its structured trigger, proposed change, protection boundary, and review requirement", () => {
  const { project, intent, constraintSet } = campus();
  const fingerprint = createEditorProjectFingerprint(project);
  const repairProposal = {
    repairProposalId: "private-repair-id", sourceProjectFingerprint: fingerprint, constraintSet,
    entries: [{ repairEntryId: "private-repair-entry", defectId: "private-defect", reason: "素材区间存在重复", proposedAction: { type: "REMOVE_CLIP", targetId: "unprotected-clip" }, humanProtection: "HUMAN_PROTECTED_AUTO_REPAIR_BLOCKED" }],
  } as never;
  const explanation = deriveEditorDecisionExplanationsV1({ project, intent, constraintSet, repairProposal }).find((item) => item.decisionKind === "REPAIR_PROPOSED")!;
  assert.match(explanation.summary, /素材区间存在重复/);
  assert.match(explanation.summary, /移除一个片段/);
  assert.match(explanation.summary, /保护内容不会被自动修改/);
  assert.match(explanation.summary, /仍需人工审核/);
});

test("teacher and logo annotations map to distinct explanations; touching identity is preserved", () => {
  const fixture = campus();
  const explanations = deriveEditorDecisionExplanationsV1({ project: fixture.project, intent: fixture.intent, constraintSet: fixture.constraintSet, annotations: fixture.annotations });
  const linked = fixture.annotations.map((annotation) => explanations.find((item) => item.subjectKind === "PROTECTION" && item.subjectId === annotation.sourceClauseId));
  assert.ok(linked.every(Boolean));
  assert.notEqual(linked[0]?.explanationId, linked[1]?.explanationId);
  assert.deepEqual(fixture.annotations.map((annotation) => [annotation.timelineStart, annotation.timelineEnd]), [[0, 35_000], [35_000, 38_000]]);
  assert.deepEqual(linked.map((item) => item?.timelineRange), [
    { coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 },
    { coordinateSpace: "TIMELINE", startMs: 35_000, endMs: 38_000 },
  ]);
});

test("R11A campus protection explanations render separate authoritative teacher and logo ranges", () => {
  const fixture = campus();
  const explanations = deriveEditorDecisionExplanationsV1({
    project: fixture.project,
    intent: fixture.intent,
    constraintSet: fixture.constraintSet,
    annotations: fixture.annotations,
  });
  const html = renderToStaticMarkup(createElement(EditorDecisionExplanationPanel, { explanations }));
  assert.match(html, /老师完整讲话已保留/);
  assert.match(html, /保护范围：00:00–00:35/);
  assert.match(html, /结尾Logo已保留/);
  assert.match(html, /保护范围：00:35–00:38/);
  assert.doesNotMatch(html, /保护范围：00:00–00:38/);
  assert.match(html, /你已确认/);
  assert.match(html, /有效硬约束/);
  assert.match(html, /禁止：.*移动.*修剪/);
  assert.doesNotMatch(html, /constraint-v1-|binding-v1-|decision-explanation-v1-|\{\s*"/);
});

test("SAFE_NO_CHANGE and other project-level explanations receive no fabricated timeline range", () => {
  const fixture = campus();
  const fingerprint = createEditorProjectFingerprint(fixture.project);
  const proposal = {
    proposalId: "private-safe-no-change-proposal",
    status: "SAFE_NO_CHANGE",
    sourceProjectFingerprint: fingerprint,
    compiledPlan: { canonicalPlan: { actions: [] } },
    planEvidence: { entries: [] },
    safeNoChangeOutcome: {
      status: "SAFE_NO_CHANGE",
      intentVersionId: fixture.intent.intentId,
      constraintSetId: fixture.constraintSet.constraintSetId,
      constraintResolutionId: "private-resolution",
      projectFingerprint: fingerprint,
      feasibilityRef: { reportId: "private-report", requestedDurationMs: 30_000, minimumFeasibleDurationMs: 38_000, remainingGapMs: 8_000 },
      requestedTargetMs: 30_000,
      minimumFeasibleDurationMs: 38_000,
      remainingGapMs: 8_000,
      protectedContentStatus: "PRESERVED",
      reasonCode: "NO_LEGAL_UNPROTECTED_EDITS",
      reason: "当前没有可安全执行的进一步修改。",
      evidence: { protectedConstraintIds: [], protectedTimelineRangeCount: 2, blockedCandidateCount: 2, legalExecutableActionCount: 0, filteredCandidateIssues: [] },
    },
  } as never;
  const explanation = deriveEditorDecisionExplanationsV1({
    project: fixture.project,
    intent: fixture.intent,
    constraintSet: fixture.constraintSet,
    proposal,
  }).find((item) => item.headline === "当前没有可安全执行的进一步修改")!;
  assert.match(explanation.summary, /当前 38 秒全部属于已确认保护内容/);
  assert.match(explanation.summary, /30 秒目标不可达/);
  assert.equal(explanation.evidenceItems.find((item) => item.label === "剩余差距")?.detail, "8 秒");
  assert.equal(explanation.timelineRange, undefined);
});

test("panel renders readable overview/details/provenance without raw IDs or JSON", () => {
  const fixture = campus();
  const explanations = deriveEditorDecisionExplanationsV1({ project: fixture.project, intent: fixture.intent, constraintSet: fixture.constraintSet, annotations: fixture.annotations });
  const html = renderToStaticMarkup(createElement(EditorDecisionExplanationPanel, { explanations, selectedProtectionClauseId: fixture.annotations[0].sourceClauseId }));
  assert.match(html, /AI 剪辑说明/);
  assert.match(html, /由你确认/);
  assert.match(html, /查看依据与参与来源/);
  assert.doesNotMatch(html, /constraint-v1-|binding-v1-|decision-explanation-v1-|private-plan-id|\{\s*"/);
});
