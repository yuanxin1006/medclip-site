import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeAudioRhythm, type AudioRhythmAnalysis } from "./editor-audio-rhythm.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import { executeCompiledNarrativeActionPlan } from "./editor-compiled-plan-execution.ts";
import {
  EDITOR_EVALUATOR_VERSION,
  EVALUATOR_RHYTHM_TOLERANCES,
  evaluateEditorExecution,
  type EditorEvaluationInput,
} from "./editor-evaluator.ts";
import type { EditorProposalBundle } from "./editor-proposal-orchestrator.ts";
import {
  createHumanReviewState,
  executeReviewedProposal,
  reviewProposalEntry,
  type HumanReviewState,
} from "./editor-proposal-review.ts";
import {
  createMedicalReviewInput,
  createMedicalReviewProposal,
  createMedicalReviewedExecution,
} from "./test-support/editor-proposal-review-fixture.ts";
import { createProtectedClipConstraintSet } from "./test-support/editor-constraint-enforcement-fixture.ts";

function baseInput(): EditorEvaluationInput {
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

function resultFor(input: EditorEvaluationInput, metric: string) {
  return evaluateEditorExecution(input).metricResults.find((item) => item.metric === metric)!;
}

function rhythmWithPause(startMs: number, endMs: number): AudioRhythmAnalysis {
  const samples = new Float32Array(10_000);
  samples.fill(0.2);
  return analyzeAudioRhythm({
    sourceId: `rhythm-${startMs}-${endMs}`,
    samples,
    sampleRate: 1_000,
    speechRegions: [{ startMs: 0, endMs: startMs }, { startMs: endMs, endMs: 10_000 }],
  });
}

test("medical reviewed execution evaluates the real post-project as PASS", () => {
  const input = baseInput();
  const before = structuredClone(input.postProject);
  const report = evaluateEditorExecution({
    ...input,
    constraintSet: createProtectedClipConstraintSet(input.executionResult!.preProject, "clip-3"),
  });
  const hardConstraints = report.metricResults.find((item) => item.metric === "HARD_CONSTRAINT_COMPLIANCE")!;
  assert.equal(report.evaluatorVersion, EDITOR_EVALUATOR_VERSION);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(hardConstraints.status, "PASS");
  assert.equal(hardConstraints.observations[0]?.message, "真实执行后工程完整保留了所有活动硬约束。");
  assert.deepEqual(report.metricResults.map((item) => item.status), ["PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
  assert.deepEqual(report.summary, {
    acceptedCount: 3, modifiedCount: 1, rejectedCount: 1, intendedActionCount: 4,
    realizedActionCount: 4, failedRequirementCount: 0, warningCount: 0, notEvaluableCount: 0,
  });
  assert.deepEqual(input.postProject, before);
});

test("evaluation is read-only across project, review, proposal, evidence, and updatedAt", () => {
  const input = baseInput();
  const before = structuredClone(input);
  const updatedAt = input.postProject.updatedAt;
  evaluateEditorExecution(input);
  assert.deepEqual(input, before);
  assert.equal(input.postProject.updatedAt, updatedAt);
});

test("accepted and modified realized actions pass against authoritative human intent", () => {
  const completion = resultFor(baseInput(), "REQUIREMENT_COMPLETION");
  const consultation = completion.observations.find((item) => item.intervalId === "interval-consultation")!;
  const ecg = completion.observations.find((item) => item.intervalId === "interval-ecg")!;
  assert.deepEqual([consultation.status, consultation.expectedAssetId, consultation.observedAssetId], ["PASS", "asset-consultation", "asset-consultation"]);
  assert.deepEqual([ecg.status, ecg.reviewDecision, ecg.expectedAssetId, ecg.observedAssetId], ["PASS", "MODIFIED", "asset-ecg-alt", "asset-ecg-alt"]);
});

test("rejected entry is intentional non-execution and never a completion failure", () => {
  const report = evaluateEditorExecution(baseInput());
  const treatment = report.metricResults
    .find((item) => item.metric === "REQUIREMENT_COMPLETION")!
    .observations.find((item) => item.intervalId === "interval-treatment")!;
  assert.deepEqual([treatment.status, treatment.code, treatment.reviewDecision], ["PASS", "INTENTIONAL_NOT_EXECUTED", "REJECTED"]);
  assert.equal(report.defects.some((item) => item.intervalId === "interval-treatment" && item.metric === "REQUIREMENT_COMPLETION"), false);
});

test("accepted wrong final asset is detected despite APPLIED execution evidence", () => {
  const input = baseInput();
  const postProject = structuredClone(input.postProject);
  postProject.tracks[0].clips[0].assetId = "seed-0";
  const report = evaluateEditorExecution({ ...input, postProject });
  assert.equal(report.overallStatus, "FAIL");
  const found = report.defects.find((item) => item.code === "INTENDED_STATE_NOT_REALIZED" && item.intervalId === "interval-consultation");
  assert.deepEqual([found?.expected, found?.observed], ["asset-consultation", "seed-0"]);
});

test("modified wrong final asset is evaluated against the human-selected asset", () => {
  const input = baseInput();
  const postProject = structuredClone(input.postProject);
  postProject.tracks[0].clips[2].assetId = "asset-ecg";
  const report = evaluateEditorExecution({ ...input, postProject });
  const found = report.defects.find((item) => item.code === "INTENDED_STATE_NOT_REALIZED" && item.intervalId === "interval-ecg");
  assert.deepEqual([found?.expected, found?.observed], ["asset-ecg-alt", "asset-ecg"]);
});

test("true canonical no-op passes when reviewed intent was already satisfied", () => {
  const source = createMedicalReviewProposal();
  let review = createHumanReviewState(source);
  source.proposalEntries.forEach((entry) => { review = reviewProposalEntry(source, review, { proposalEntryId: entry.proposalEntryId, decision: "ACCEPT" }); });
  const applied = executeReviewedProposal({ proposal: source, review, currentProject: source.trustedPreExecutionProject, executionUpdatedAt: "2026-10-25T04:00:00.000Z" });
  const current = structuredClone(applied.execution!.postProject);
  const proposal = structuredClone(source) as unknown as EditorProposalBundle;
  const mutable = proposal as unknown as { trustedPreExecutionProject: typeof current; sourceProjectFingerprint: string };
  mutable.trustedPreExecutionProject = current;
  mutable.sourceProjectFingerprint = createEditorProjectFingerprint(current);
  review = createHumanReviewState(proposal);
  proposal.proposalEntries.forEach((entry) => { review = reviewProposalEntry(proposal, review, { proposalEntryId: entry.proposalEntryId, decision: "ACCEPT" }); });
  const noOp = executeReviewedProposal({ proposal, review, currentProject: current, executionUpdatedAt: "2026-10-25T04:01:00.000Z" });
  const evidence = createMedicalReviewInput();
  const report = evaluateEditorExecution({
    proposalBundle: proposal, humanReviewState: noOp.reviewState, reviewedPlan: noOp.reviewedPlan,
    executionResult: noOp.execution, postProject: noOp.execution!.postProject, planEvidence: noOp.planEvidence,
    videoSemanticEvidence: evidence.videoAnalyses, audioRhythmEvidence: evidence.rhythm,
  });
  assert.equal(noOp.execution?.status, "NO_OP");
  assert.equal(report.metricResults[0].status, "PASS");
  assert.notEqual(report.overallStatus, "FAIL");
});

test("atomic failed execution is a structural evaluation failure", () => {
  const scenario = createMedicalReviewedExecution();
  const failed = executeReviewedProposal({
    proposal: scenario.proposal,
    review: (() => {
      let review = createHumanReviewState(scenario.proposal);
      scenario.proposal.proposalEntries.forEach((entry) => { review = reviewProposalEntry(scenario.proposal, review, { proposalEntryId: entry.proposalEntryId, decision: "ACCEPT" }); });
      return review;
    })(),
    currentProject: scenario.proposal.trustedPreExecutionProject,
    executionUpdatedAt: "2026-10-25T04:02:00.000Z",
  }, { executePlan: (executionInput) => executeCompiledNarrativeActionPlan(executionInput, { applyPlan: () => { throw new Error("controlled"); } }) });
  const report = evaluateEditorExecution({
    proposalBundle: scenario.proposal, humanReviewState: failed.reviewState, reviewedPlan: failed.reviewedPlan,
    executionResult: failed.execution, postProject: failed.execution!.postProject, planEvidence: failed.planEvidence,
    videoSemanticEvidence: scenario.input.videoAnalyses, audioRhythmEvidence: scenario.input.rhythm,
  });
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.defects.some((item) => item.code === "EXECUTION_FAILED"), true);
});

test("unrelated project mutation is independently detected as protected-state regression", () => {
  const input = baseInput();
  const postProject = structuredClone(input.postProject);
  postProject.captions[0].text = "unauthorized caption mutation";
  const report = evaluateEditorExecution({ ...input, postProject });
  assert.equal(report.metricResults.find((item) => item.metric === "PRESERVATION")?.status, "FAIL");
  assert.match(report.defects.find((item) => item.code === "PROTECTED_STATE_REGRESSION")?.observed ?? "", /project\.captions/);
});

test("strong semantic match passes using the existing deterministic scorer", () => {
  assert.equal(resultFor(baseInput(), "SEMANTIC_MATCH").status, "PASS");
});

test("semantic support below the shared threshold produces a quality warning", () => {
  const input = baseInput();
  const videoSemanticEvidence = input.videoSemanticEvidence.map((analysis) => analysis.assetId === "asset-consultation"
    ? { ...analysis, segments: analysis.segments.map((segment) => ({ ...segment, confidence: 0.1 })) }
    : analysis);
  const report = evaluateEditorExecution({ ...input, videoSemanticEvidence });
  const found = report.defects.find((item) => item.code === "LOW_SEMANTIC_SUPPORT" && item.intervalId === "interval-consultation");
  assert.equal(report.overallStatus, "PASS_WITH_WARNINGS");
  assert.equal(found?.severity, "WARNING");
});

test("human-modified low semantic support remains visible and human-protected", () => {
  const input = baseInput();
  const videoSemanticEvidence = input.videoSemanticEvidence.map((analysis) => analysis.assetId === "asset-ecg-alt"
    ? { ...analysis, segments: analysis.segments.map((segment) => ({ ...segment, confidence: 0.1 })) }
    : analysis);
  const report = evaluateEditorExecution({ ...input, videoSemanticEvidence });
  const found = report.defects.find((item) => item.code === "LOW_SEMANTIC_SUPPORT" && item.intervalId === "interval-ecg");
  assert.equal(found?.repairEligibility, "HUMAN_DECISION_PROTECTED");
});

test("rhythm boundaries classify aligned, near, and misaligned with central tolerances", () => {
  assert.deepEqual(EVALUATOR_RHYTHM_TOLERANCES, { alignedMaxOffsetMs: 100, nearMaxOffsetMs: 480 });
  const aligned = resultFor({ ...baseInput(), audioRhythmEvidence: rhythmWithPause(1_900, 2_100) }, "RHYTHM_ALIGNMENT");
  const near = resultFor({ ...baseInput(), audioRhythmEvidence: rhythmWithPause(1_600, 1_700) }, "RHYTHM_ALIGNMENT");
  const misaligned = resultFor({ ...baseInput(), audioRhythmEvidence: rhythmWithPause(900, 1_000) }, "RHYTHM_ALIGNMENT");
  assert.equal(aligned.observations.find((item) => item.intervalId === "interval-consultation")?.alignment, "ALIGNED");
  assert.equal(near.observations.find((item) => item.intervalId === "interval-consultation")?.alignment, "NEAR");
  assert.equal(misaligned.observations.find((item) => item.intervalId === "interval-consultation")?.alignment, "MISALIGNED");
});

test("missing rhythm evidence is NOT_EVALUABLE rather than failure", () => {
  const input = baseInput();
  const report = evaluateEditorExecution({ ...input, audioRhythmEvidence: undefined });
  assert.equal(report.metricResults.find((item) => item.metric === "RHYTHM_ALIGNMENT")?.status, "NOT_EVALUABLE");
  assert.equal(report.overallStatus, "PASS");
});

test("actual final sequence detects immediate repetition and A-B-A oscillation", () => {
  const immediateInput = baseInput();
  const immediatePost = structuredClone(immediateInput.postProject);
  immediatePost.tracks[0].clips[1].assetId = immediatePost.tracks[0].clips[0].assetId;
  const immediate = evaluateEditorExecution({ ...immediateInput, postProject: immediatePost });
  assert.equal(immediate.defects.some((item) => item.code === "IMMEDIATE_ASSET_REPEAT"), true);

  const abaInput = baseInput();
  const abaPost = structuredClone(abaInput.postProject);
  abaPost.tracks[0].clips[2].assetId = abaPost.tracks[0].clips[0].assetId;
  const aba = evaluateEditorExecution({ ...abaInput, postProject: abaPost });
  assert.equal(aba.defects.some((item) => item.code === "ABA_ASSET_OSCILLATION"), true);
});

test("basic narrative evaluation reports action progression", () => {
  const narrative = resultFor(baseInput(), "NARRATIVE_CONTINUITY");
  assert.equal(narrative.observations.some((item) => item.code === "ACTION_PROGRESSION_SUPPORTED"), true);
});

test("basic narrative evaluation reports subject continuity from actual assets", () => {
  const input = baseInput();
  const videoSemanticEvidence = input.videoSemanticEvidence.map((analysis) => ["asset-consultation", "asset-anatomy"].includes(analysis.assetId)
    ? { ...analysis, segments: analysis.segments.map((segment) => ({ ...segment, concepts: [...segment.concepts, "patient"] })) }
    : analysis);
  const narrative = resultFor({ ...input, videoSemanticEvidence }, "NARRATIVE_CONTINUITY");
  assert.equal(narrative.observations.some((item) => item.code === "SUBJECT_CONTINUITY_PRESERVED"), true);
});

test("insufficient semantic/action evidence produces NOT_EVALUABLE narrative observations", () => {
  const input = baseInput();
  const videoSemanticEvidence = input.videoSemanticEvidence.filter((item) => item.assetId !== "asset-anatomy");
  const narrative = resultFor({ ...input, videoSemanticEvidence }, "NARRATIVE_CONTINUITY");
  assert.equal(narrative.observations.some((item) => item.status === "NOT_EVALUABLE"), true);
});

test("all rejected returns NO_EXECUTED_ACTIONS without invented defects", () => {
  const source = createMedicalReviewInput();
  const proposal = createMedicalReviewProposal();
  let review: HumanReviewState = createHumanReviewState(proposal);
  proposal.proposalEntries.forEach((entry) => { review = reviewProposalEntry(proposal, review, { proposalEntryId: entry.proposalEntryId, decision: "REJECT" }); });
  const noActions = executeReviewedProposal({ proposal, review, currentProject: proposal.trustedPreExecutionProject, executionUpdatedAt: "2026-10-25T04:03:00.000Z" });
  const report = evaluateEditorExecution({
    proposalBundle: proposal, humanReviewState: noActions.reviewState, reviewedPlan: noActions.reviewedPlan,
    postProject: proposal.trustedPreExecutionProject, planEvidence: noActions.planEvidence,
    videoSemanticEvidence: source.videoAnalyses, audioRhythmEvidence: source.rhythm,
    constraintSet: createProtectedClipConstraintSet(proposal.trustedPreExecutionProject, "clip-0"),
  });
  const hardConstraints = report.metricResults.find((item) => item.metric === "HARD_CONSTRAINT_COMPLIANCE")!;
  assert.equal(report.overallStatus, "NO_EXECUTED_ACTIONS");
  assert.equal(hardConstraints.status, "PASS");
  assert.equal(hardConstraints.observations[0]?.message, "当前工程完整保留了所有活动硬约束，本轮未执行编辑动作。");
  assert.doesNotMatch(hardConstraints.observations[0]?.message ?? "", /真实执行后|执行后|修改后/);
  assert.equal(report.metricResults.find((item) => item.metric === "SEMANTIC_MATCH")?.status, "NOT_EVALUABLE");
  assert.equal(report.defects.length, 0);
});

test("same trusted input yields identical IDs, metrics, defects, ordering, and summary", () => {
  const input = baseInput();
  const first = evaluateEditorExecution(input);
  const second = evaluateEditorExecution(input);
  assert.deepEqual(second, first);
  assert.match(first.evaluationId, /^evaluation-[0-9a-f]{8}$/);
  assert.deepEqual(first.defects.map((item) => item.id), second.defects.map((item) => item.id));
});

test("evaluator source is pure, local, read-only, and contains no repair implementation", () => {
  const source = readFileSync(new URL("./editor-evaluator.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /React|Supabase|fetch\s*\(|runAITask|DeepSeek|Kimi|Doubao|TokenHub|applyAIEditingPlan|executeCompiledNarrativeActionPlan|setEditorProject|recordProjectUndoSnapshot/);
  assert.doesNotMatch(source, /repairProposal|generateRepair|compileRepair|executeRepair/i);
  assert.match(source, /rankMultimodalCandidates/);
  assert.match(source, /scoreNarrativeTransition/);
});
