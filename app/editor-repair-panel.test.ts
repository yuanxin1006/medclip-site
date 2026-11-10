import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorRepairPanel } from "./editor-repair-panel.ts";
import { evaluateEditorExecution } from "./editor-evaluator.ts";
import {
  createRepairProposalBundle,
  createRepairReviewState,
  executeReviewedRepairLoop,
  reviewRepairEntry,
  type ClosedLoopFinalStatus,
  type ClosedLoopRepairResult,
} from "./editor-repair.ts";
import { generateEditorProposal } from "./editor-proposal-orchestrator.ts";
import { createHumanReviewState, executeReviewedProposal, reviewProposalEntry } from "./editor-proposal-review.ts";
import { createMedicalReviewInput } from "./test-support/editor-proposal-review-fixture.ts";

function createMedicalRepairInput(): ReturnType<typeof createMedicalReviewInput> {
  const input = createMedicalReviewInput();
  const source = input.videoAnalyses.find((analysis) => analysis.assetId === "asset-ecg-alt")!;
  return {
    ...input,
    project: {
      ...input.project,
      assets: [...input.project.assets, { id: "asset-ecg-alt-2", name: "Friendly asset-ecg-alt-2", kind: "视频", durationMs: 4_000 }],
    },
    videoAnalyses: [...input.videoAnalyses, {
      ...source,
      assetId: "asset-ecg-alt-2",
      segments: source.segments.map((segment) => ({ ...segment, id: "segment-asset-ecg-alt-2", assetId: "asset-ecg-alt-2", confidence: 0.8 })),
    }],
  };
}

function repairFixture() {
  const input = createMedicalRepairInput();
  const generated = generateEditorProposal(input);
  if (!generated.ok) throw new Error(generated.message);
  const proposal = generated.bundle;
  let initialReview = createHumanReviewState(proposal);
  for (const entry of proposal.proposalEntries) {
    initialReview = reviewProposalEntry(proposal, initialReview, { proposalEntryId: entry.proposalEntryId, decision: "ACCEPT" });
  }
  const execution = executeReviewedProposal({
    proposal,
    review: initialReview,
    currentProject: proposal.trustedPreExecutionProject,
    executionUpdatedAt: "2026-10-25T04:00:00.000Z",
  });
  const videoSemanticEvidence = input.videoAnalyses.map((analysis) => analysis.assetId === "asset-ecg"
    ? { ...analysis, segments: analysis.segments.map((segment) => ({ ...segment, confidence: 0.1 })) }
    : analysis);
  const evaluation = evaluateEditorExecution({
    proposalBundle: proposal,
    humanReviewState: execution.reviewState,
    reviewedPlan: execution.reviewedPlan,
    executionResult: execution.execution,
    postProject: execution.execution!.postProject,
    planEvidence: execution.planEvidence,
    videoSemanticEvidence,
    audioRhythmEvidence: input.rhythm,
  });
  const repairProposal = createRepairProposalBundle({
    evaluation,
    proposal,
    humanReview: execution.reviewState,
    reviewedPlan: execution.reviewedPlan,
    execution: execution.execution,
    planEvidence: execution.planEvidence,
    currentProject: execution.execution!.postProject,
    videoSemanticEvidence,
    audioRhythmEvidence: input.rhythm,
  });
  return { evaluation, execution, repairProposal };
}

test("repair proposal UI shows issue, current state, correction, evidence, ACCEPT, REJECT, and MODIFY", () => {
  const fixture = repairFixture();
  const review = createRepairReviewState(fixture.repairProposal);
  const html = renderToStaticMarkup(EditorRepairPanel({
    proposal: fixture.repairProposal,
    review,
    onReviewDecision: () => undefined,
    onExecuteReviewed: () => undefined,
  }));
  assert.match(html, /修复建议/);
  assert.match(html, /检测到的问题/);
  assert.match(html, /当前状态/);
  assert.match(html, /建议修正为/);
  assert.match(html, /原因与证据/);
  assert.match(html, /接受修复/);
  assert.match(html, /拒绝修复/);
  assert.match(html, /修改修复/);
  assert.match(html, /执行已批准修复/);
});

test("human-protected warning has no automatic repair controls", () => {
  const fixture = repairFixture();
  const proposal = Object.freeze({
    ...fixture.repairProposal,
    entries: Object.freeze(fixture.repairProposal.entries.map((entry, index) => index === 0 ? Object.freeze({
      ...entry,
      repairEligibility: "HUMAN_PROTECTED" as const,
      humanProtection: "HUMAN_PROTECTED_AUTO_REPAIR_BLOCKED" as const,
      proposedAction: undefined,
      attemptedTuple: undefined,
    }) : Object.freeze({ ...entry, repairEligibility: "UNSUPPORTED" as const, proposedAction: undefined, attemptedTuple: undefined }))),
  });
  const html = renderToStaticMarkup(EditorRepairPanel({
    proposal,
    review: createRepairReviewState(proposal),
    onReviewDecision: () => undefined,
    onExecuteReviewed: () => undefined,
  }));
  assert.match(html, /这是用户明确选择的结果，系统不会自动替换/);
  assert.doesNotMatch(html, /接受修复|拒绝修复|修改修复|执行已批准修复/);
});

function completedRepair(): ClosedLoopRepairResult {
  const fixture = repairFixture();
  let review = createRepairReviewState(fixture.repairProposal);
  for (const entry of fixture.repairProposal.entries.filter((item) => item.repairEligibility === "ELIGIBLE")) {
    review = reviewRepairEntry(fixture.repairProposal, review, { repairEntryId: entry.repairEntryId, decision: "ACCEPT" });
  }
  return executeReviewedRepairLoop({
    originalEvaluation: fixture.evaluation,
    repairProposal: fixture.repairProposal,
    repairReview: review,
    currentProject: fixture.execution.execution!.postProject,
    executionUpdatedAt: "2026-10-25T05:00:00.000Z",
  });
}

test("post-repair UI shows all bounded final messages and never exposes a second repair control", () => {
  const successful = completedRepair();
  const messages: Readonly<Record<ClosedLoopFinalStatus, string>> = {
    REPAIR_FINAL_PASS: "修复成功",
    REPAIR_FINAL_UNRESOLVED_IMPROVED: "修复后仍有问题",
    REPAIR_FINAL_UNRESOLVED: "修复后仍有问题",
    REPAIR_ROLLED_BACK: "修复结果变差，已恢复到修复前状态",
    REPAIR_NO_ACTIONS: "用户未执行修复",
  };
  for (const [finalStatus, message] of Object.entries(messages) as [ClosedLoopFinalStatus, string][]) {
    const result = Object.freeze({ ...successful, finalStatus });
    const html = renderToStaticMarkup(EditorRepairPanel({
      proposal: successful.repairProposal,
      review: successful.repairReview,
      result,
      onReviewDecision: () => undefined,
      onExecuteReviewed: () => undefined,
    }));
    assert.match(html, new RegExp(message));
    assert.doesNotMatch(html, /<button|<select|执行已批准修复/);
  }
});

test("EditorStudio wires repair generation, review, execution, result, and queued history without Provider calls", () => {
  const source = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  assert.match(source, /createRepairProposalBundle/);
  assert.match(source, /createRepairReviewState/);
  assert.match(source, /reviewRepairEntry/);
  assert.match(source, /executeReviewedRepairLoop/);
  assert.match(source, /repairProposal=\{editorRepairProposal\}/);
  assert.match(source, /repairResult=\{editorRepairResult\}/);
  assert.match(source, /setEditorAIUndoProject\(cloneProject\(result\.history\.undoProject\)\)/);
  assert.match(source, /setEditorAIUndoProjects\(\(current\) => snapshot \? \[\.\.\.current, snapshot\] : \[\]\)/);
  const repairHandler = source.slice(source.indexOf("const executeApprovedRepair"), source.indexOf("const runEditorTextTask"));
  assert.doesNotMatch(repairHandler, /runAITask|DeepSeek|Kimi|Doubao|TokenHub|fetch\(/i);
});
