import assert from "node:assert/strict";
import test from "node:test";
import { cloneProject, recordProjectUndoSnapshot, type EditorProject } from "./editor-core.ts";
import { executeCompiledNarrativeActionPlan } from "./editor-compiled-plan-execution.ts";
import { createSemanticActionTupleV1 } from "./editor-constraint-enforcement.ts";
import { createConstraintSet, type ConstraintSetV1 } from "./editor-constraints.ts";
import { evaluateEditorExecution, type EditorEvaluationReport, type EvaluationDefect } from "./editor-evaluator.ts";
import {
  EditorRepairError,
  MAX_REPAIR_ACTIONS,
  buildReviewedRepairPlan,
  createRepairProposalBundle,
  createRepairReviewState,
  executeReviewedRepairLoop,
  reviewRepairEntry,
  type CreateRepairProposalInput,
  type RepairActionTuple,
  type RepairProposalBundle,
  type RepairReviewState,
} from "./editor-repair.ts";
import { generateEditorProposal, type EditorProposalBundle } from "./editor-proposal-orchestrator.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import {
  createHumanReviewState,
  executeReviewedProposal,
  reviewProposalEntry,
  type ReviewedProposalExecution,
} from "./editor-proposal-review.ts";
import { createMedicalReviewInput } from "./test-support/editor-proposal-review-fixture.ts";
import { createProtectedClipConstraintSet } from "./test-support/editor-constraint-enforcement-fixture.ts";

const INITIAL_EXECUTION_AT = "2026-10-25T04:00:00.000Z";
const REPAIR_EXECUTION_AT = "2026-10-25T05:00:00.000Z";

type Scenario = Readonly<{
  proposal: EditorProposalBundle;
  execution: ReviewedProposalExecution;
  evaluation: EditorEvaluationReport;
  input: ReturnType<typeof createMedicalReviewInput>;
  repairInput: CreateRepairProposalInput;
}>;

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

function acceptAllProposalEntries(proposal: EditorProposalBundle): ReviewedProposalExecution {
  let review = createHumanReviewState(proposal);
  for (const entry of proposal.proposalEntries) {
    review = reviewProposalEntry(proposal, review, { proposalEntryId: entry.proposalEntryId, decision: "ACCEPT" });
  }
  return executeReviewedProposal({
    proposal,
    review,
    currentProject: proposal.trustedPreExecutionProject,
    executionUpdatedAt: INITIAL_EXECUTION_AT,
  });
}

function semanticDefectScenario(): Scenario {
  const input = createMedicalRepairInput();
  const generated = generateEditorProposal(input);
  if (!generated.ok) throw new Error(generated.message);
  const proposal = generated.bundle;
  const execution = acceptAllProposalEntries(proposal);
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
  assert.ok(evaluation.defects.some((defect) => defect.code === "LOW_SEMANTIC_SUPPORT" && defect.intervalId === "interval-ecg"));
  return {
    proposal,
    execution,
    evaluation,
    input,
    repairInput: {
      evaluation,
      proposal,
      humanReview: execution.reviewState,
      reviewedPlan: execution.reviewedPlan,
      execution: execution.execution,
      planEvidence: execution.planEvidence,
      currentProject: execution.execution!.postProject,
      videoSemanticEvidence,
      audioRhythmEvidence: input.rhythm,
    },
  };
}

function acceptAllRepairs(bundle: RepairProposalBundle): RepairReviewState {
  let review = createRepairReviewState(bundle);
  for (const entry of bundle.entries.filter((item) => item.repairEligibility === "ELIGIBLE")) {
    review = reviewRepairEntry(bundle, review, { repairEntryId: entry.repairEntryId, decision: "ACCEPT" });
  }
  return review;
}

function withInheritedConstraintSet(
  proposal: EditorProposalBundle,
  constraintSet: ConstraintSetV1,
): EditorProposalBundle {
  return Object.freeze({
    ...proposal,
    constraintSet,
    evidenceMetadata: Object.freeze({
      ...proposal.evidenceMetadata,
      constraintContext: Object.freeze({
        sourceIntentVersionId: constraintSet.intentVersionId,
        sourceConstraintSetId: constraintSet.constraintSetId,
        sourceConstraintFingerprint: constraintSet.constraintFingerprint,
        resolutionIds: constraintSet.resolutionIds,
        feasibilityReportId: "feasibility-report-v1-repair-context",
        readiness: "READY_TO_PLAN" as const,
      }),
    }),
  });
}

function withSyntheticDefects(scenario: Scenario, defects: readonly EvaluationDefect[]): CreateRepairProposalInput {
  const evaluation: EditorEvaluationReport = Object.freeze({
    ...scenario.evaluation,
    evaluationId: `evaluation-synthetic-${defects.length}-${defects.map((item) => item.id).join("-")}`,
    defects: Object.freeze(defects),
    warnings: Object.freeze(defects.filter((item) => item.severity === "WARNING").map((item) => item.id)),
    notEvaluable: Object.freeze(defects.filter((item) => item.severity === "NOT_EVALUABLE").map((item) => item.id)),
  });
  return { ...scenario.repairInput, evaluation };
}

function defect(
  id: string,
  metric: EvaluationDefect["metric"],
  code: EvaluationDefect["code"],
  overrides: Partial<EvaluationDefect> = {},
): EvaluationDefect {
  return Object.freeze({
    id,
    metric,
    severity: "WARNING",
    code,
    expected: "better",
    observed: "worse",
    evidence: Object.freeze([]),
    repairEligibility: "DETERMINISTIC_REPAIR_POSSIBLE",
    intervalId: "interval-ecg",
    clipId: "clip-2",
    assetId: "asset-ecg",
    ...overrides,
  });
}

test("medical semantic repair closes the loop through review, V2.0D, and exactly one V2.2A re-evaluation", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(scenario.repairInput);
  const semantic = bundle.entries.find((entry) => entry.defectCode === "LOW_SEMANTIC_SUPPORT");
  assert.equal(semantic?.repairEligibility, "ELIGIBLE");
  assert.equal(semantic?.proposedAction?.assetId, "asset-ecg-alt");
  const review = acceptAllRepairs(bundle);
  let evaluationCalls = 0;
  const result = executeReviewedRepairLoop({
    originalEvaluation: scenario.evaluation,
    repairProposal: bundle,
    repairReview: review,
    currentProject: scenario.execution.execution!.postProject,
    executionUpdatedAt: REPAIR_EXECUTION_AT,
  }, { evaluate: (input) => { evaluationCalls += 1; return evaluateEditorExecution(input); } });
  assert.equal(result.finalStatus, "REPAIR_FINAL_PASS");
  assert.equal(result.reEvaluationCount, 1);
  assert.equal(evaluationCalls, 1);
  assert.equal(result.repairExecution?.status, "APPLIED");
  assert.equal(result.repairExecution?.postProject.tracks[0].clips[2].assetId, "asset-ecg-alt");
  assert.equal(result.history.entryCount, 1);
  assert.equal(result.history.undoProject?.tracks[0].clips[2].assetId, "asset-ecg");
  assert.equal(result.history.redoProject?.tracks[0].clips[2].assetId, "asset-ecg-alt");
});

test("pre-execution empty ConstraintSet remains repair-eligible after legitimate execution", () => {
  const scenario = semanticDefectScenario();
  const constraintSet = createConstraintSet({
    version: 1,
    projectId: scenario.proposal.trustedPreExecutionProject.id,
    intentVersionId: "intent-v1-23e00004",
    validatedAgainstProjectFingerprint: scenario.proposal.sourceProjectFingerprint,
    activeConstraints: [],
    confirmedBindings: [],
    resolutionIds: [],
  });
  const proposal = withInheritedConstraintSet(scenario.proposal, constraintSet);
  const currentProject = scenario.execution.execution!.postProject;
  assert.notEqual(createEditorProjectFingerprint(currentProject), constraintSet.validatedAgainstProjectFingerprint);
  const bundle = createRepairProposalBundle({ ...scenario.repairInput, proposal });
  const semantic = bundle.entries.find((entry) => entry.defectCode === "LOW_SEMANTIC_SUPPORT")!;
  assert.equal(semantic.repairEligibility, "ELIGIBLE");
  let review = createRepairReviewState(bundle);
  review = reviewRepairEntry(bundle, review, { repairEntryId: semantic.repairEntryId, decision: "ACCEPT" });
  let evaluationCalls = 0;
  const result = executeReviewedRepairLoop({
    originalEvaluation: scenario.evaluation,
    repairProposal: bundle,
    repairReview: review,
    currentProject,
    executionUpdatedAt: REPAIR_EXECUTION_AT,
  }, { evaluate: (input) => { evaluationCalls += 1; return evaluateEditorExecution(input); } });
  assert.equal(result.finalStatus, "REPAIR_FINAL_PASS");
  assert.equal(result.reEvaluationCount, 1);
  assert.equal(evaluationCalls, 1);
  assert.equal(result.history.entryCount, 1);
});

test("stale constraint-bearing context blocks repair even when the repair target is unprotected", () => {
  const scenario = semanticDefectScenario();
  const constraintSet = createProtectedClipConstraintSet(scenario.proposal.trustedPreExecutionProject, "clip-4");
  const proposal = withInheritedConstraintSet(scenario.proposal, constraintSet);
  const currentProject = scenario.execution.execution!.postProject;
  assert.notEqual(createEditorProjectFingerprint(currentProject), constraintSet.validatedAgainstProjectFingerprint);
  const bundle = createRepairProposalBundle({ ...scenario.repairInput, proposal });
  const semantic = bundle.entries.find((entry) => entry.defectCode === "LOW_SEMANTIC_SUPPORT")!;
  assert.equal(semantic.clipId, "clip-2");
  assert.equal(semantic.repairEligibility, "HARD_CONSTRAINT_BLOCKED");
  assert.equal(semantic.proposedAction, undefined);
  assert.equal(createRepairReviewState(bundle).lifecycle, "REPAIR_NO_ACTIONS");
});

test("protected repair target is excluded before display with no proposed action", () => {
  const scenario = semanticDefectScenario();
  const currentProject = scenario.execution.execution!.postProject;
  const constraintSet = createProtectedClipConstraintSet(currentProject, "clip-2");
  const bundle = createRepairProposalBundle({ ...scenario.repairInput, constraintSet });
  const target = bundle.entries.find((entry) => entry.defectCode === "LOW_SEMANTIC_SUPPORT")!;
  assert.equal(target.repairEligibility, "HARD_CONSTRAINT_BLOCKED");
  assert.equal(target.proposedAction, undefined);
  assert.deepEqual(target.trustedAlternatives, []);
  assert.equal(bundle.status, "REPAIR_NO_ACTIONS");
  assert.deepEqual(bundle.constraintContext, {
    intentVersionId: constraintSet.intentVersionId,
    constraintSetId: constraintSet.constraintSetId,
    constraintFingerprint: constraintSet.constraintFingerprint,
  });
});

test("repair session ledger does not resurrect an explicitly rejected semantic tuple", () => {
  const scenario = semanticDefectScenario();
  const currentProject = scenario.execution.execution!.postProject;
  const constraintSet = createProtectedClipConstraintSet(currentProject, "clip-4");
  const baseline = createRepairProposalBundle({ ...scenario.repairInput, constraintSet });
  const target = baseline.entries.find((entry) => entry.defectCode === "LOW_SEMANTIC_SUPPORT")!;
  if (!target.proposedAction) assert.fail("Expected baseline repair action.");
  const tuples = target.trustedAlternatives.map((candidate) => createSemanticActionTupleV1(
    currentProject.id,
    constraintSet.intentVersionId,
    { ...target.proposedAction!, assetId: candidate.assetId },
  ));
  const bundle = createRepairProposalBundle({
    ...scenario.repairInput,
    constraintSet,
    sessionDecisionLedger: {
      schemaVersion: 1,
      projectId: currentProject.id,
      confirmedBindingIds: [],
      selectedResolutionIds: [],
      rejectedProposalOperationTuples: tuples,
      humanModifiedSelections: [],
    },
  });
  const rejected = bundle.entries.find((entry) => entry.defectCode === "LOW_SEMANTIC_SUPPORT")!;
  assert.equal(rejected.repairEligibility, "SESSION_REJECTED");
  assert.equal(rejected.proposedAction, undefined);
});

test("repair MODIFY is rechecked against the same active ConstraintSet", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(scenario.repairInput);
  const target = bundle.entries.find((entry) => entry.defectCode === "LOW_SEMANTIC_SUPPORT")!;
  const constraintSet = createProtectedClipConstraintSet(scenario.execution.execution!.postProject, "clip-2");
  const constrained: RepairProposalBundle = {
    ...bundle,
    constraintSet,
    constraintContext: {
      intentVersionId: constraintSet.intentVersionId,
      constraintSetId: constraintSet.constraintSetId,
      constraintFingerprint: constraintSet.constraintFingerprint,
    },
  };
  let review = createRepairReviewState(constrained);
  const alternative = target.trustedAlternatives.find((item) => item.assetId !== target.proposedAction?.assetId);
  if (!alternative) assert.fail("Expected a trusted MODIFY alternative.");
  assert.throws(
    () => reviewRepairEntry(constrained, review, {
      repairEntryId: target.repairEntryId,
      decision: "MODIFY",
      selectedAssetId: alternative.assetId,
    }),
    (error) => error instanceof EditorRepairError && error.code === "INVALID_ALTERNATIVE",
  );
  assert.equal(review.lifecycle, "REPAIR_PROPOSED");
});

test("indirect hard-constraint failure after repair execution rolls back exact snapshot with no bad history or second round", () => {
  const scenario = semanticDefectScenario();
  const currentProject = scenario.execution.execution!.postProject;
  const constraintSet = createProtectedClipConstraintSet(currentProject, "clip-4");
  const bundle = createRepairProposalBundle({ ...scenario.repairInput, constraintSet });
  const review = acceptAllRepairs(bundle);
  let evaluationCalls = 0;
  const result = executeReviewedRepairLoop({
    originalEvaluation: scenario.evaluation,
    repairProposal: bundle,
    repairReview: review,
    currentProject,
    executionUpdatedAt: REPAIR_EXECUTION_AT,
  }, {
    executePlan: (input) => {
      const executed = executeCompiledNarrativeActionPlan(input);
      assert.notEqual(executed.status, "FAILED");
      const damaged = structuredClone(executed.postProject);
      damaged.tracks[0].clips.find((clip) => clip.id === "clip-4")!.assetId = "asset-consultation";
      return { ...executed, postProject: damaged };
    },
    evaluate: (input) => {
      evaluationCalls += 1;
      return evaluateEditorExecution(input);
    },
  });
  assert.equal(result.finalStatus, "REPAIR_ROLLED_BACK");
  assert.equal(result.rollback.performed, true);
  assert.equal(result.rollback.reason, "NEW_STRUCTURAL_FAIL");
  assert.deepEqual(result.finalProject, currentProject);
  assert.equal(result.history.entryCount, 0);
  assert.equal(result.history.shouldRecord, false);
  assert.equal(result.reEvaluationCount, 1);
  assert.equal(evaluationCalls, 1);
  assert.equal(result.reEvaluation?.metricResults.find((item) => item.metric === "HARD_CONSTRAINT_COMPLIANCE")?.status, "FAIL");
  assert.equal(result.repairProposal.repairRound, 1);
});

test("human repair MODIFY keeps proposed B historically but executes trusted C as final intent", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(scenario.repairInput);
  const target = bundle.entries.find((entry) => entry.defectCode === "LOW_SEMANTIC_SUPPORT")!;
  assert.ok(target.trustedAlternatives.some((candidate) => candidate.assetId === "asset-ecg-alt-2"));
  let review = createRepairReviewState(bundle);
  review = reviewRepairEntry(bundle, review, {
    repairEntryId: target.repairEntryId,
    decision: "MODIFY",
    selectedAssetId: "asset-ecg-alt-2",
  });
  const plan = buildReviewedRepairPlan(bundle, review, scenario.execution.execution!.postProject);
  assert.equal(target.proposedAction?.assetId, "asset-ecg-alt");
  assert.equal(plan.compiledPlan.canonicalPlan.actions[0].assetId, "asset-ecg-alt-2");
  assert.equal(plan.reviewedEntries[0].provenance, "REPAIR_USER_MODIFIED");
  const result = executeReviewedRepairLoop({
    originalEvaluation: scenario.evaluation,
    repairProposal: bundle,
    repairReview: review,
    currentProject: scenario.execution.execution!.postProject,
    executionUpdatedAt: REPAIR_EXECUTION_AT,
  });
  assert.equal(result.finalStatus, "REPAIR_FINAL_PASS");
  assert.equal(result.repairExecution?.postProject.tracks[0].clips[2].assetId, "asset-ecg-alt-2");
  assert.ok(result.reEvaluation?.metricResults
    .find((metric) => metric.metric === "REQUIREMENT_COMPLETION")?.observations
    .some((observation) => observation.expectedAssetId === "asset-ecg-alt-2" && observation.observedAssetId === "asset-ecg-alt-2"));
  assert.equal(result.evidence.initialProposalId, scenario.proposal.proposalId);
  assert.equal(result.repairProposal.entries.find((entry) => entry.repairEntryId === target.repairEntryId)?.proposedAction?.assetId, "asset-ecg-alt");
});

test("repair reject leaves project and history unchanged and performs no re-evaluation", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(scenario.repairInput);
  let review = createRepairReviewState(bundle);
  for (const entry of bundle.entries.filter((item) => item.repairEligibility === "ELIGIBLE")) {
    review = reviewRepairEntry(bundle, review, { repairEntryId: entry.repairEntryId, decision: "REJECT" });
  }
  let evaluationCalls = 0;
  const result = executeReviewedRepairLoop({
    originalEvaluation: scenario.evaluation,
    repairProposal: bundle,
    repairReview: review,
    currentProject: scenario.execution.execution!.postProject,
    executionUpdatedAt: REPAIR_EXECUTION_AT,
  }, { evaluate: (input) => { evaluationCalls += 1; return evaluateEditorExecution(input); } });
  assert.equal(result.finalStatus, "REPAIR_NO_ACTIONS");
  assert.equal(result.repairExecution, undefined);
  assert.equal(result.reEvaluation, undefined);
  assert.equal(evaluationCalls, 0);
  assert.equal(result.history.entryCount, 0);
  assert.deepEqual(result.finalProject, scenario.execution.execution!.postProject);
});

test("successful execution with a worsened post-evaluation rolls back the exact pre-repair snapshot and records no history", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(scenario.repairInput);
  const review = acceptAllRepairs(bundle);
  const worse: EditorEvaluationReport = Object.freeze({
    ...scenario.evaluation,
    evaluationId: "evaluation-controlled-worse",
    defects: Object.freeze([defect("post-worse", "SEMANTIC_MATCH", "LOW_SEMANTIC_SUPPORT", { observed: "0.01" })]),
  });
  const before = cloneProject(scenario.execution.execution!.postProject);
  const result = executeReviewedRepairLoop({
    originalEvaluation: scenario.evaluation,
    repairProposal: bundle,
    repairReview: review,
    currentProject: before,
    executionUpdatedAt: REPAIR_EXECUTION_AT,
  }, { evaluate: () => worse });
  assert.equal(result.repairExecution?.status, "APPLIED");
  assert.equal(result.finalStatus, "REPAIR_ROLLED_BACK");
  assert.equal(result.rollback.performed, true);
  assert.deepEqual(result.finalProject, before);
  assert.equal(result.history.entryCount, 0);
  assert.equal(result.originalEvaluation.evaluationId, scenario.evaluation.evaluationId);
  assert.equal(result.reEvaluation?.evaluationId, "evaluation-controlled-worse");
});

test("a deterministic semantic improvement may be retained even when the warning remains", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(scenario.repairInput);
  const review = acceptAllRepairs(bundle);
  const sourceDefect = scenario.evaluation.defects.find((item) => item.code === "LOW_SEMANTIC_SUPPORT")!;
  const improvedDefect = Object.freeze({ ...sourceDefect, id: "post-improved", observed: String(Number(sourceDefect.observed) + 0.05) });
  const improved: EditorEvaluationReport = Object.freeze({
    ...scenario.evaluation,
    evaluationId: "evaluation-controlled-improved",
    defects: Object.freeze([improvedDefect]),
    warnings: Object.freeze([improvedDefect.id]),
  });
  const result = executeReviewedRepairLoop({
    originalEvaluation: scenario.evaluation,
    repairProposal: bundle,
    repairReview: review,
    currentProject: scenario.execution.execution!.postProject,
    executionUpdatedAt: REPAIR_EXECUTION_AT,
  }, { evaluate: () => improved });
  assert.equal(result.finalStatus, "REPAIR_FINAL_UNRESOLVED_IMPROVED");
  assert.equal(result.comparison?.targetedDefects[0].outcome, "IMPROVED");
  assert.equal(result.rollback.performed, false);
  assert.equal(result.history.entryCount, 1);
});

test("a new structural failure rolls back even when the targeted warning resolves", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(scenario.repairInput);
  const review = acceptAllRepairs(bundle);
  const structural = defect("post-structural", "REQUIREMENT_COMPLETION", "EXECUTION_EVIDENCE_CONFLICT", {
    severity: "FAIL",
    intervalId: "interval-ecg",
    observed: "FAILED",
    repairEligibility: "UNSUPPORTED",
  });
  const report: EditorEvaluationReport = Object.freeze({
    ...scenario.evaluation,
    evaluationId: "evaluation-new-structural-fail",
    defects: Object.freeze([structural]),
    warnings: Object.freeze([]),
  });
  const result = executeReviewedRepairLoop({
    originalEvaluation: scenario.evaluation,
    repairProposal: bundle,
    repairReview: review,
    currentProject: scenario.execution.execution!.postProject,
    executionUpdatedAt: REPAIR_EXECUTION_AT,
  }, { evaluate: () => report });
  assert.equal(result.finalStatus, "REPAIR_ROLLED_BACK");
  assert.equal(result.comparison?.newStructuralFail, true);
  assert.equal(result.rollback.reason, "NEW_STRUCTURAL_FAIL");
  assert.equal(result.history.entryCount, 0);
});

test("a protected-state regression rolls back and remains preserved in historical re-evaluation evidence", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(scenario.repairInput);
  const review = acceptAllRepairs(bundle);
  const protectedDefect = defect("post-protected", "PRESERVATION", "PROTECTED_STATE_REGRESSION", {
    severity: "FAIL",
    intervalId: undefined,
    clipId: undefined,
    assetId: undefined,
    observed: "project.captions",
    repairEligibility: "UNSUPPORTED",
  });
  const report: EditorEvaluationReport = Object.freeze({
    ...scenario.evaluation,
    evaluationId: "evaluation-protected-regression",
    defects: Object.freeze([protectedDefect]),
    warnings: Object.freeze([]),
  });
  const result = executeReviewedRepairLoop({
    originalEvaluation: scenario.evaluation,
    repairProposal: bundle,
    repairReview: review,
    currentProject: scenario.execution.execution!.postProject,
    executionUpdatedAt: REPAIR_EXECUTION_AT,
  }, { evaluate: () => report });
  assert.equal(result.finalStatus, "REPAIR_ROLLED_BACK");
  assert.equal(result.comparison?.protectedStateRegression, true);
  assert.equal(result.reEvaluation?.evaluationId, "evaluation-protected-regression");
  assert.deepEqual(result.finalProject, scenario.execution.execution!.postProject);
});

test("requirement defect deterministically reapplies the original reviewed assignment", () => {
  const scenario = semanticDefectScenario();
  const project = cloneProject(scenario.execution.execution!.postProject);
  project.tracks[0].clips[0].assetId = "seed-0";
  const evaluation = evaluateEditorExecution({
    proposalBundle: scenario.proposal,
    humanReviewState: scenario.execution.reviewState,
    reviewedPlan: scenario.execution.reviewedPlan,
    executionResult: scenario.execution.execution,
    postProject: project,
    planEvidence: scenario.execution.planEvidence,
    videoSemanticEvidence: scenario.input.videoAnalyses,
    audioRhythmEvidence: scenario.input.rhythm,
  });
  const bundle = createRepairProposalBundle({ ...scenario.repairInput, evaluation, currentProject: project, videoSemanticEvidence: scenario.input.videoAnalyses });
  const entry = bundle.entries.find((item) => item.defectCode === "INTENDED_STATE_NOT_REALIZED")!;
  assert.equal(entry.strategy, "REAPPLY_REVIEWED_MATCH");
  assert.equal(entry.proposedAction?.assetId, "asset-consultation");
});

test("repetition defect chooses a trusted alternative that reduces the bounded repetition pattern", () => {
  const scenario = semanticDefectScenario();
  const project = cloneProject(scenario.execution.execution!.postProject);
  project.tracks[0].clips[2].assetId = project.tracks[0].clips[1].assetId;
  const synthetic = withSyntheticDefects(scenario, [defect("repeat", "REPETITION", "IMMEDIATE_ASSET_REPEAT", {
    intervalId: "interval-ecg",
    clipId: "clip-2",
    assetId: project.tracks[0].clips[2].assetId,
  })]);
  const bundle = createRepairProposalBundle({
    ...synthetic,
    currentProject: project,
    evaluation: Object.freeze({ ...synthetic.evaluation, postProjectFingerprint: createEditorProjectFingerprint(project) }),
  });
  const entry = bundle.entries[0];
  assert.equal(entry.strategy, "REDUCE_REPETITION");
  assert.equal(entry.repairEligibility, "ELIGIBLE");
  assert.notEqual(entry.proposedAction?.assetId, project.tracks[0].clips[1].assetId);
});

test("rhythm, NOT_EVALUABLE, and narrative defects remain report-only", () => {
  const scenario = semanticDefectScenario();
  const input = withSyntheticDefects(scenario, [
    defect("rhythm", "RHYTHM_ALIGNMENT", "CUT_MISALIGNED"),
    defect("missing", "SEMANTIC_MATCH", "MISSING_SEMANTIC_EVIDENCE", { severity: "NOT_EVALUABLE", repairEligibility: "PROVIDER_REPLAN_MAY_BE_REQUIRED" }),
    defect("narrative", "NARRATIVE_CONTINUITY", "ACTION_REGRESSION"),
  ]);
  const bundle = createRepairProposalBundle(input);
  assert.equal(bundle.status, "REPAIR_NO_ACTIONS");
  assert.ok(bundle.entries.every((entry) => entry.repairEligibility === "UNSUPPORTED"));
  assert.equal(bundle.providerCalls, 0);
  assert.equal(bundle.networkCalls, 0);
});

test("human-protected defects and originally rejected entries cannot be auto-repaired", () => {
  const scenario = semanticDefectScenario();
  const protectedBundle = createRepairProposalBundle(withSyntheticDefects(scenario, [
    defect("protected", "SEMANTIC_MATCH", "LOW_SEMANTIC_SUPPORT", { repairEligibility: "HUMAN_DECISION_PROTECTED" }),
  ]));
  assert.equal(protectedBundle.entries[0].repairEligibility, "HUMAN_PROTECTED");
  assert.equal(protectedBundle.entries[0].humanProtection, "HUMAN_PROTECTED_AUTO_REPAIR_BLOCKED");

  const rejectedReview = Object.freeze({
    ...scenario.execution.reviewState,
    entries: Object.freeze(scenario.execution.reviewState.entries.map((entry) => entry.intervalId === "interval-ecg"
      ? Object.freeze({ ...entry, status: "REJECTED" as const, provenance: "USER_REJECTED" as const })
      : entry)),
  });
  const rejected = createRepairProposalBundle({
    ...withSyntheticDefects(scenario, [defect("rejected", "SEMANTIC_MATCH", "LOW_SEMANTIC_SUPPORT")]),
    humanReview: rejectedReview,
  });
  assert.equal(rejected.entries[0].repairEligibility, "USER_REJECTED");
});

test("no trusted alternative fails closed", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(withSyntheticDefects(scenario, [
    defect("none", "SEMANTIC_MATCH", "LOW_SEMANTIC_SUPPORT", { intervalId: "interval-recovery", clipId: "clip-4", assetId: "asset-recovery", observed: "0.1" }),
  ]));
  assert.equal(bundle.entries[0].repairEligibility, "NO_TRUSTED_ALTERNATIVE");
});

test("more than six eligible target mutations fails the entire batch closed", () => {
  const scenario = semanticDefectScenario();
  const baseDefect = scenario.evaluation.defects.find((item) => item.code === "LOW_SEMANTIC_SUPPORT")!;
  const project: EditorProject = cloneProject(scenario.execution.execution!.postProject);
  const defects = Array.from({ length: MAX_REPAIR_ACTIONS + 1 }, (_, index) => Object.freeze({
    ...baseDefect,
    id: `limit-${index}`,
    intervalId: `interval-limit-${index}`,
    clipId: `clip-limit-${index}`,
  }));
  const candidateSet = scenario.proposal.rankedCandidateSets.find((set) => set.intervalId === "interval-ecg")!;
  const proposal: EditorProposalBundle = Object.freeze({
    ...scenario.proposal,
    matchingIntervals: Object.freeze(defects.map((item, index) => Object.freeze({ id: item.intervalId!, timelineStartMs: index * 10, timelineEndMs: index * 10 + 10, text: "x", concepts: Object.freeze(["ecg"]) }))),
    rankedCandidateSets: Object.freeze(defects.map((item) => Object.freeze({ ...candidateSet, intervalId: item.intervalId! }))),
    proposalEntries: Object.freeze(defects.map((item) => Object.freeze({ proposalEntryId: `e-limit-${item.id}`, intervalId: item.intervalId!, targetId: item.clipId!, selectedAssetId: "asset-ecg", candidateAlternativeAssetIds: Object.freeze(["asset-ecg-alt"]) }))),
  });
  project.tracks[0].clips = defects.map((item, index) => Object.freeze({ ...project.tracks[0].clips[2], id: item.clipId!, timelineStartMs: index * 10, timelineEndMs: index * 10 + 10 }));
  const humanReview = Object.freeze({ ...scenario.execution.reviewState, entries: Object.freeze(defects.map((item) => Object.freeze({ proposalEntryId: `e-limit-${item.id}`, intervalId: item.intervalId!, status: "ACCEPTED" as const, provenance: "USER_ACCEPTED" as const }))) });
  const reviewedPlan = Object.freeze({ ...scenario.execution.reviewedPlan, reviewedEntries: Object.freeze(defects.map((item) => Object.freeze({ proposalEntryId: `e-limit-${item.id}`, intervalId: item.intervalId!, decision: "ACCEPTED" as const, selectedAssetId: "asset-ecg", action: Object.freeze({ type: "MATCH_ASSET_TO_SEGMENT", targetId: item.clipId!, assetId: "asset-ecg", startSeconds: 0, endSeconds: 1, reason: "fixture" }) }))) });
  const evaluation = Object.freeze({ ...scenario.evaluation, evaluationId: "evaluation-limit", sourceProposalId: proposal.proposalId, postProjectFingerprint: createEditorProjectFingerprint(project), defects: Object.freeze(defects) });
  const bundle = createRepairProposalBundle({ ...scenario.repairInput, evaluation, proposal, humanReview, reviewedPlan, currentProject: project });
  assert.equal(bundle.status, "REPAIR_MANUAL_REQUIRED");
  assert.equal(bundle.attemptedRepairTuples.length, 0);
  assert.equal(bundle.entries.filter((entry) => entry.repairEligibility === "ACTION_LIMIT_EXCEEDED").length, MAX_REPAIR_ACTIONS + 1);
});

test("competing defects on one target produce one deterministic mutation", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(withSyntheticDefects(scenario, [
    defect("requirement", "REQUIREMENT_COMPLETION", "INTENDED_STATE_NOT_REALIZED", { severity: "FAIL", assetId: "seed-2", observed: "seed-2", expected: "asset-ecg" }),
    defect("semantic", "SEMANTIC_MATCH", "LOW_SEMANTIC_SUPPORT", { observed: "0.1" }),
  ]));
  assert.equal(bundle.attemptedRepairTuples.length, 1);
  assert.equal(bundle.entries.find((entry) => entry.defectId === "semantic")?.repairEligibility, "DUPLICATE_TARGET_CONFLICT");
});

test("repair IDs and ordering are deterministic", () => {
  const scenario = semanticDefectScenario();
  const first = createRepairProposalBundle(scenario.repairInput);
  const second = createRepairProposalBundle(scenario.repairInput);
  assert.equal(first.repairProposalId, second.repairProposalId);
  assert.equal(first.attemptedRepairFingerprint, second.attemptedRepairFingerprint);
  assert.deepEqual(first.entries.map((entry) => entry.repairEntryId), second.entries.map((entry) => entry.repairEntryId));
});

test("same repair tuple is rejected on replay and repairRound 2 is rejected", () => {
  const scenario = semanticDefectScenario();
  const first = createRepairProposalBundle(scenario.repairInput);
  const attempted: readonly RepairActionTuple[] = first.attemptedRepairTuples;
  const replay = createRepairProposalBundle({ ...scenario.repairInput, previouslyAttemptedTuples: attempted });
  assert.equal(replay.status, "REPAIR_NO_ACTIONS");
  assert.ok(replay.entries.some((entry) => entry.repairEligibility === "ALREADY_ATTEMPTED"));
  assert.throws(() => createRepairProposalBundle({ ...scenario.repairInput, repairRound: 2 }), (error: unknown) =>
    error instanceof EditorRepairError && error.code === "INVALID_REPAIR_ROUND");
});

test("invalid MODIFY alternatives and pending review block execution", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(scenario.repairInput);
  const review = createRepairReviewState(bundle);
  const target = bundle.entries.find((entry) => entry.repairEligibility === "ELIGIBLE")!;
  assert.throws(() => reviewRepairEntry(bundle, review, { repairEntryId: target.repairEntryId, decision: "MODIFY", selectedAssetId: "invented-asset" }), (error: unknown) =>
    error instanceof EditorRepairError && error.code === "INVALID_ALTERNATIVE");
  assert.throws(() => buildReviewedRepairPlan(bundle, review, scenario.execution.execution!.postProject), (error: unknown) =>
    error instanceof EditorRepairError && error.code === "PENDING_ENTRIES");
});

test("reviewed repair uses the existing canonical parser contract and a single validated V2.0D batch", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(scenario.repairInput);
  const review = acceptAllRepairs(bundle);
  const plan = buildReviewedRepairPlan(bundle, review, scenario.execution.execution!.postProject);
  assert.equal(plan.compiledPlan.canonicalValidation.parser, "parseAIEditingPlan");
  assert.equal(plan.compiledPlan.canonicalValidation.valid, true);
  assert.equal(plan.compiledPlan.canonicalPlan.actions.length, 1);
  const result = executeReviewedRepairLoop({
    originalEvaluation: scenario.evaluation,
    repairProposal: bundle,
    repairReview: review,
    currentProject: scenario.execution.execution!.postProject,
    executionUpdatedAt: REPAIR_EXECUTION_AT,
  });
  assert.equal(result.repairExecution?.historyBoundary.strategy, "EXISTING_PROJECT_SNAPSHOT");
  assert.equal(result.history.entryCount, 1);
});

test("queued existing snapshot history undoes repair then initial edit and redoes both exact states", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(scenario.repairInput);
  const review = acceptAllRepairs(bundle);
  const result = executeReviewedRepairLoop({
    originalEvaluation: scenario.evaluation,
    repairProposal: bundle,
    repairReview: review,
    currentProject: scenario.execution.execution!.postProject,
    executionUpdatedAt: REPAIR_EXECUTION_AT,
  });
  let history: EditorProject[] = [];
  history = recordProjectUndoSnapshot(history, scenario.execution.history.undoProject!);
  history = recordProjectUndoSnapshot(history, result.history.undoProject!);
  const future: EditorProject[] = [];
  let draft = cloneProject(result.history.redoProject!);
  const undoRepair = history.pop()!;
  future.push(cloneProject(draft));
  draft = undoRepair;
  assert.deepEqual(draft, result.history.undoProject);
  const undoInitial = history.pop()!;
  future.push(cloneProject(draft));
  draft = undoInitial;
  assert.deepEqual(draft, scenario.execution.history.undoProject);
  const redoInitial = future.pop()!;
  history.push(cloneProject(draft));
  draft = redoInitial;
  assert.deepEqual(draft, result.history.undoProject);
  const redoRepair = future.pop()!;
  history.push(cloneProject(draft));
  draft = redoRepair;
  assert.deepEqual(draft, result.history.redoProject);
});

test("atomic V2.0D failure preserves snapshot, creates no history, and skips re-evaluation", () => {
  const scenario = semanticDefectScenario();
  const bundle = createRepairProposalBundle(scenario.repairInput);
  const review = acceptAllRepairs(bundle);
  let evaluationCalls = 0;
  const result = executeReviewedRepairLoop({
    originalEvaluation: scenario.evaluation,
    repairProposal: bundle,
    repairReview: review,
    currentProject: scenario.execution.execution!.postProject,
    executionUpdatedAt: REPAIR_EXECUTION_AT,
  }, {
    executePlan: (input) => ({
      ...scenario.execution.execution!,
      status: "FAILED",
      preProject: cloneProject(input.preExecutionProject),
      postProject: cloneProject(input.preExecutionProject),
      appliedActionCount: 0,
      noOpActionCount: 0,
      failureCode: "ACTION_APPLICATION_FAILED",
      historyBoundary: Object.freeze({ strategy: "EXISTING_PROJECT_SNAPSHOT", shouldRecordPlanUndo: false }),
    }),
    evaluate: (value) => { evaluationCalls += 1; return evaluateEditorExecution(value); },
  });
  assert.equal(result.finalStatus, "REPAIR_FINAL_UNRESOLVED");
  assert.equal(result.reEvaluationCount, 0);
  assert.equal(evaluationCalls, 0);
  assert.equal(result.history.entryCount, 0);
  assert.deepEqual(result.finalProject, scenario.execution.execution!.postProject);
});
