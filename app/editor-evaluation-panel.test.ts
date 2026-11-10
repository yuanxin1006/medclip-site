import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorEvaluationPanel } from "./editor-evaluation-panel.ts";
import { evaluateEditorExecution, type EditorEvaluationInput, type EditorEvaluationReport } from "./editor-evaluator.ts";
import { createMedicalReviewedExecution } from "./test-support/editor-proposal-review-fixture.ts";

function evaluationInput(): EditorEvaluationInput {
  const scenario = createMedicalReviewedExecution();
  return {
    proposalBundle: scenario.proposal,
    humanReviewState: scenario.result.reviewState,
    reviewedPlan: scenario.result.reviewedPlan,
    executionResult: scenario.result.execution,
    postProject: scenario.result.execution!.postProject,
    planEvidence: scenario.result.planEvidence,
    videoSemanticEvidence: scenario.input.videoAnalyses,
    audioRhythmEvidence: scenario.input.rhythm,
  };
}

test("PASS evaluation renders all seven factual metric sections", () => {
  const html = renderToStaticMarkup(EditorEvaluationPanel({ report: evaluateEditorExecution(evaluationInput()) }));
  assert.match(html, /硬约束合规/);
  assert.match(html, /执行结果/);
  assert.match(html, /需求完成情况/);
  assert.match(html, /语义匹配/);
  assert.match(html, /节奏对齐/);
  assert.match(html, /重复镜头/);
  assert.match(html, /叙事连续性/);
  assert.match(html, /状态保护/);
  assert.match(html, /通过/);
});

test("PASS_WITH_WARNINGS renders a warning and typed factual explanation", () => {
  const input = evaluationInput();
  const videoSemanticEvidence = input.videoSemanticEvidence.map((analysis) => analysis.assetId === "asset-consultation"
    ? { ...analysis, segments: analysis.segments.map((segment) => ({ ...segment, confidence: 0.1 })) }
    : analysis);
  const html = renderToStaticMarkup(EditorEvaluationPanel({ report: evaluateEditorExecution({ ...input, videoSemanticEvidence }) }));
  assert.match(html, /通过，但有警告/);
  assert.match(html, /最终素材与该区间的语义支持较弱|semanticScore/);
  assert.match(html, /预期：/);
  assert.match(html, /实际：/);
});

test("FAIL renders when real post-project violates reviewed intent", () => {
  const input = evaluationInput();
  const postProject = structuredClone(input.postProject);
  postProject.tracks[0].clips[0].assetId = "seed-0";
  const html = renderToStaticMarkup(EditorEvaluationPanel({ report: evaluateEditorExecution({ ...input, postProject }) }));
  assert.match(html, /失败/);
  assert.match(html, /真实项目中的素材指派与人工审核结果不一致/);
});

test("NOT_EVALUABLE has a distinct user-facing state", () => {
  const pass = evaluateEditorExecution(evaluationInput());
  const report = { ...pass, overallStatus: "NOT_EVALUABLE" as const } satisfies EditorEvaluationReport;
  const html = renderToStaticMarkup(EditorEvaluationPanel({ report }));
  assert.match(html, /无法判断/);
});

test("user-rejected entry is shown as intentional non-execution rather than failure", () => {
  const html = renderToStaticMarkup(EditorEvaluationPanel({ report: evaluateEditorExecution(evaluationInput()) }));
  assert.match(html, /用户已拒绝，未执行（符合审核结果）/);
  assert.doesNotMatch(html, /用户已拒绝[^<]*失败/);
});

test("user-modified provenance and final intended asset are visible", () => {
  const html = renderToStaticMarkup(EditorEvaluationPanel({ report: evaluateEditorExecution(evaluationInput()) }));
  assert.match(html, /用户已修改，以用户选择为准/);
  assert.match(html, /审核目标：asset-ecg-alt，实际：asset-ecg-alt/);
});

test("evaluation UI has no repair or mutation control", () => {
  const html = renderToStaticMarkup(EditorEvaluationPanel({ report: evaluateEditorExecution(evaluationInput()) }));
  assert.doesNotMatch(html, /<button|<select|修复|重新执行|回滚/);
});

test("EditorStudio evaluates the real reviewed result before creating any bounded repair proposal", () => {
  const source = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  const executeHandler = source.slice(source.indexOf("const executeApprovedProposal"), source.indexOf("const handleRepairReviewDecision"));
  assert.match(executeHandler, /evaluateEditorExecution/);
  assert.match(executeHandler, /const authoritativePostProject = result\.execution\?\.postProject \?\? editorProject/);
  assert.match(executeHandler, /postProject: authoritativePostProject/);
  assert.ok(executeHandler.indexOf("evaluateEditorExecution") < executeHandler.indexOf("createRepairProposalBundle"));
  assert.match(source, /evaluation=\{editorEvaluation\}/);
  assert.doesNotMatch(executeHandler, /executeReviewedRepairLoop|rollback|re-?evaluate/i);
});
