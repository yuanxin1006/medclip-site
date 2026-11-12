import assert from "node:assert/strict";
import test from "node:test";
import {
  ConstraintEnforcementBlockedError,
  createSemanticActionTupleV1,
  verifyPostApplyConstraintInvariantsV1,
} from "./editor-constraint-enforcement.ts";
import { applyAIEditingPlan, type EditorAIEditingPlan } from "./editor-ai-requirements.ts";
import { executeCompiledNarrativeActionPlan } from "./editor-compiled-plan-execution.ts";
import { createConstraintSet, type ConstraintSetV1 } from "./editor-constraints.ts";
import { evaluateConstraintFeasibilityV1 } from "./editor-constraint-feasibility.ts";
import {
  createNegotiationStateV1,
  negotiationStateFromFeasibilityV1,
  resolveConstraintConflictV1,
  transitionNegotiationStateV1,
  type ProposalConstraintContextV1,
} from "./editor-constraint-negotiation.ts";
import { evaluateEditorExecution } from "./editor-evaluator.ts";
import { generateEditorProposal, type EditorProposalBundle } from "./editor-proposal-orchestrator.ts";
import {
  ProposalReviewError,
  createHumanReviewState,
  executeReviewedProposal,
  reviewProposalEntry,
} from "./editor-proposal-review.ts";
import {
  createConstraintEnforcementFixture,
  createProtectedClipConstraintSet,
} from "./test-support/editor-constraint-enforcement-fixture.ts";
import {
  createMedicalReviewInput,
  createMedicalReviewProposal,
  createMedicalReviewedExecution,
} from "./test-support/editor-proposal-review-fixture.ts";

function expectedContext(set: ConstraintSetV1) {
  return {
    intentVersionId: set.intentVersionId,
    constraintSetId: set.constraintSetId,
    constraintFingerprint: set.constraintFingerprint,
  } as const;
}

function proposalContext(set: ConstraintSetV1): ProposalConstraintContextV1 {
  return {
    sourceIntentVersionId: set.intentVersionId,
    sourceConstraintSetId: set.constraintSetId,
    sourceConstraintFingerprint: set.constraintFingerprint,
    resolutionIds: set.resolutionIds,
    feasibilityReportId: "feasibility-report-v1-23e00001",
    readiness: "READY_TO_PLAN",
  };
}

function plan(action: EditorAIEditingPlan["actions"][number]): EditorAIEditingPlan {
  return { summary: "Constraint attack fixture.", actions: [action], unsupported: [], warnings: [] };
}

function canonicalContext(project: ReturnType<typeof createConstraintEnforcementFixture>["project"], set: ConstraintSetV1) {
  return {
    project,
    ownedAssetIds: new Set(project.assets.map((item) => item.id)),
    audioSourceDurationMs: project.audioSelection.sourceDurationMs,
    nowIso: "2026-10-25T06:00:00.000Z",
    constraintSet: set,
    constraintContext: expectedContext(set),
  };
}

function attachConstraint(proposal: EditorProposalBundle, set: ConstraintSetV1): EditorProposalBundle {
  return {
    ...proposal,
    constraintSet: set,
    evidenceMetadata: { ...proposal.evidenceMetadata, constraintContext: proposalContext(set) },
  };
}

function oneActionPlan(proposal: EditorProposalBundle, actionIndex = 0) {
  const source = proposal.compiledPlan;
  const action = source.canonicalPlan.actions[actionIndex];
  const link = source.intervalActionMap.find((item) => item.actionIndex === actionIndex)!;
  return {
    ...source,
    canonicalPlan: { ...source.canonicalPlan, summary: "One controlled assignment.", actions: [action] },
    intervalActionMap: [{ ...link, actionIndex: 0 }],
  };
}

test("canonical validator blocks provider-style delete, speed, and logo replacement attacks before mutation", () => {
  const { project, constraintSet } = createConstraintEnforcementFixture();
  const attacks: readonly EditorAIEditingPlan["actions"][number][] = [
    { type: "REMOVE_CLIP", targetId: "clip-teacher", assetId: "", startSeconds: 0, endSeconds: 0, reason: "Provider asks to delete speech." },
    { type: "SET_CLIP_PLAYBACK_SPEED", targetId: "clip-teacher", assetId: "", playbackRate: 1.25, reason: "Provider asks to speed speech." },
    { type: "MATCH_ASSET_TO_SEGMENT", targetId: "clip-logo", assetId: "asset-teacher", startSeconds: 35, endSeconds: 38, reason: "Provider asks to replace logo." },
  ];
  const before = structuredClone(project);
  for (const action of attacks) {
    assert.throws(
      () => applyAIEditingPlan(plan(action), canonicalContext(project, constraintSet)),
      (error) => error instanceof ConstraintEnforcementBlockedError && error.result.status === "BLOCKED_HARD_CONSTRAINT",
    );
    assert.deepEqual(project, before);
  }
});
test("V2.0C compiler defense rejects a protected assignment before a proposal is shown", () => {
  const input = createMedicalReviewInput();
  const constraintSet = createProtectedClipConstraintSet(input.project, "clip-0");
  const generated = generateEditorProposal({ ...input, constraintSet, constraintContext: proposalContext(constraintSet) });
  assert.equal(generated.ok, false);
  assert.equal(generated.status, "COMPILATION_REJECTED");
});

test("session rejection ledger blocks only the same deterministic project/intent operation tuple", () => {
  const input = createMedicalReviewInput();
  const baseline = generateEditorProposal(input);
  if (!baseline.ok) assert.fail(baseline.message);
  const firstAction = baseline.bundle.compiledPlan.canonicalPlan.actions[0];
  const set = createConstraintSet({
    version: 1,
    projectId: input.project.id,
    intentVersionId: "intent-v1-23e00002",
    validatedAgainstProjectFingerprint: baseline.bundle.sourceProjectFingerprint,
    activeConstraints: [],
    confirmedBindings: [],
    resolutionIds: [],
  });
  const tuple = createSemanticActionTupleV1(input.project.id, set.intentVersionId, firstAction);
  const generated = generateEditorProposal({
    ...input,
    constraintSet: set,
    constraintContext: proposalContext(set),
    sessionDecisionLedger: {
      schemaVersion: 1,
      projectId: input.project.id,
      confirmedBindingIds: [],
      selectedResolutionIds: [],
      rejectedProposalOperationTuples: [tuple],
      humanModifiedSelections: [],
    },
  });
  assert.equal(generated.ok, false);
  assert.equal(generated.status, "COMPILATION_REJECTED");
});

test("V2.0D verifies exact context, rejects protected canonical input, and records no mutation or history", () => {
  const proposal = createMedicalReviewProposal();
  const preProject = proposal.trustedPreExecutionProject;
  const constraintSet = createProtectedClipConstraintSet(preProject, "clip-0");
  const result = executeCompiledNarrativeActionPlan({
    preExecutionProject: preProject,
    compiledPlan: oneActionPlan(proposal),
    ownedAssetIds: preProject.assets.map((item) => item.id),
    expectedProjectId: preProject.id,
    expectedProjectUpdatedAt: preProject.updatedAt,
    executionUpdatedAt: "2026-10-25T06:10:00.000Z",
    constraintContext: { ...expectedContext(constraintSet), constraintSet },
  });
  assert.equal(result.status, "FAILED");
  assert.equal(result.failureCode, "HARD_CONSTRAINT_BLOCKED");
  assert.deepEqual(result.postProject, result.preProject);
  assert.equal(result.appliedActionCount, 0);
  assert.equal(result.historyBoundary.shouldRecordPlanUndo, false);
});

test("V2.0D rejects a stale project fingerprint and malformed exact fingerprint", () => {
  const proposal = createMedicalReviewProposal();
  const original = proposal.trustedPreExecutionProject;
  const constraintSet = createProtectedClipConstraintSet(original, "clip-4");
  const staleProject = structuredClone(original);
  staleProject.title = "changed after constraint confirmation";
  const common = {
    preExecutionProject: staleProject,
    compiledPlan: oneActionPlan(proposal),
    ownedAssetIds: staleProject.assets.map((item) => item.id),
    expectedProjectId: staleProject.id,
    expectedProjectUpdatedAt: staleProject.updatedAt,
    executionUpdatedAt: "2026-10-25T06:11:00.000Z",
  };
  const stale = executeCompiledNarrativeActionPlan({ ...common, constraintContext: { ...expectedContext(constraintSet), constraintSet } });
  assert.equal(stale.failureCode, "STALE_CONSTRAINT_CONTEXT");
  assert.equal(stale.historyBoundary.shouldRecordPlanUndo, false);
  assert.throws(() => executeCompiledNarrativeActionPlan({
    ...common,
    preExecutionProject: original,
    expectedProjectUpdatedAt: original.updatedAt,
    constraintContext: { ...expectedContext(constraintSet), constraintFingerprint: "constraint-fingerprint-v1-deadbeef", constraintSet },
  }), /identities do not match/);
});

test("V2.0D post-apply invariant check rejects indirect protected damage and returns the exact pre-project", () => {
  const proposal = createMedicalReviewProposal();
  const preProject = proposal.trustedPreExecutionProject;
  const constraintSet = createProtectedClipConstraintSet(preProject, "clip-4");
  const result = executeCompiledNarrativeActionPlan({
    preExecutionProject: preProject,
    compiledPlan: oneActionPlan(proposal),
    ownedAssetIds: preProject.assets.map((item) => item.id),
    expectedProjectId: preProject.id,
    expectedProjectUpdatedAt: preProject.updatedAt,
    executionUpdatedAt: "2026-10-25T06:12:00.000Z",
    constraintContext: { ...expectedContext(constraintSet), constraintSet },
  }, {
    applyPlan: (value, context) => {
      const applied = applyAIEditingPlan(value, context);
      const damaged = structuredClone(applied.project);
      damaged.tracks[0].clips.find((item) => item.id === "clip-4")!.sourceInMs = 100;
      return { ...applied, project: damaged };
    },
  });
  assert.equal(result.status, "FAILED");
  assert.equal(result.failureCode, "POST_APPLY_CONSTRAINT_VIOLATION");
  assert.deepEqual(result.postProject, result.preProject);
  assert.equal(result.historyBoundary.shouldRecordPlanUndo, false);
});

test("Human Review ACCEPT and MODIFY are constrained while REJECT remains permitted", () => {
  const raw = createMedicalReviewProposal();
  const protectedSet = createProtectedClipConstraintSet(raw.trustedPreExecutionProject, "clip-0");
  const proposal = attachConstraint(raw, protectedSet);
  const entry = proposal.proposalEntries[0];
  const pending = createHumanReviewState(proposal);
  assert.throws(
    () => reviewProposalEntry(proposal, pending, { proposalEntryId: entry.proposalEntryId, decision: "ACCEPT" }),
    (error) => error instanceof ProposalReviewError && error.code === "HARD_CONSTRAINT_BLOCKED",
  );
  const rejected = reviewProposalEntry(proposal, pending, { proposalEntryId: entry.proposalEntryId, decision: "REJECT" });
  assert.equal(rejected.entries[0].status, "REJECTED");
  const alternative = raw.proposalEntries[0].candidateAlternativeAssetIds[0];
  if (!alternative) assert.fail("Expected trusted review alternative.");
  assert.throws(
    () => reviewProposalEntry(proposal, pending, { proposalEntryId: entry.proposalEntryId, decision: "MODIFY", selectedAssetId: alternative }),
    (error) => error instanceof ProposalReviewError && error.code === "INVALID_ALTERNATIVE",
  );

  const compliantSet = createProtectedClipConstraintSet(raw.trustedPreExecutionProject, "clip-4");
  const compliant = attachConstraint(raw, compliantSet);
  const accepted = reviewProposalEntry(compliant, createHumanReviewState(compliant), {
    proposalEntryId: compliant.proposalEntries[0].proposalEntryId,
    decision: "ACCEPT",
  });
  assert.equal(accepted.entries[0].status, "ACCEPTED");
});

test("Human Review cannot accept protected speech move or transform actions or reintroduce them through MODIFY", () => {
  const raw = createMedicalReviewProposal();
  const protectedSet = createProtectedClipConstraintSet(raw.trustedPreExecutionProject, "clip-0");
  const entry = raw.proposalEntries[0];
  const alternative = entry.candidateAlternativeAssetIds[0];
  if (!alternative) assert.fail("Expected trusted review alternative.");
  const attacks: readonly EditorAIEditingPlan["actions"][number][] = [
    {
      type: "REORDER_CLIP", targetId: "clip-0", assetId: "", referenceId: "clip-1", placement: "AFTER",
      reason: "Attempt to move protected speech during Human Review.",
    },
    {
      type: "SET_CLIP_POSITION_SCALE", targetId: "clip-0", assetId: "", x: 10, y: 0, scale: 1,
      reason: "Attempt to transform protected speech during Human Review.",
    },
  ];
  for (const action of attacks) {
    const attackedRaw = {
      ...raw,
      compiledPlan: {
        ...raw.compiledPlan,
        canonicalPlan: {
          ...raw.compiledPlan.canonicalPlan,
          actions: Object.freeze([action, ...raw.compiledPlan.canonicalPlan.actions.slice(1)]),
        },
      },
    } as EditorProposalBundle;
    const proposal = attachConstraint(attackedRaw, protectedSet);
    const pending = createHumanReviewState(proposal);
    assert.throws(
      () => reviewProposalEntry(proposal, pending, { proposalEntryId: entry.proposalEntryId, decision: "ACCEPT" }),
      (error) => error instanceof ProposalReviewError && error.code === "HARD_CONSTRAINT_BLOCKED",
    );
    assert.throws(
      () => reviewProposalEntry(proposal, pending, {
        proposalEntryId: entry.proposalEntryId,
        decision: "MODIFY",
        selectedAssetId: alternative,
      }),
      (error) => error instanceof ProposalReviewError && error.code === "INVALID_ALTERNATIVE",
    );
  }
});

test("Human Review emits rejected semantic tuples into the same project and intent session ledger", () => {
  const raw = createMedicalReviewProposal();
  const constraintSet = createProtectedClipConstraintSet(raw.trustedPreExecutionProject, "clip-0");
  const proposal: EditorProposalBundle = {
    ...attachConstraint(raw, constraintSet),
    sessionDecisionLedger: {
      schemaVersion: 1,
      projectId: raw.trustedPreExecutionProject.id,
      confirmedBindingIds: [],
      selectedResolutionIds: [],
      rejectedProposalOperationTuples: [],
      humanModifiedSelections: [],
    },
  };
  let review = createHumanReviewState(proposal);
  for (const entry of proposal.proposalEntries) {
    review = reviewProposalEntry(proposal, review, { proposalEntryId: entry.proposalEntryId, decision: "REJECT" });
  }
  const result = executeReviewedProposal({
    proposal,
    review,
    currentProject: proposal.trustedPreExecutionProject,
    executionUpdatedAt: "2026-10-25T06:15:00.000Z",
  });
  const firstAction = proposal.compiledPlan.canonicalPlan.actions[0];
  const tuple = createSemanticActionTupleV1(proposal.trustedPreExecutionProject.id, constraintSet.intentVersionId, firstAction);
  assert.equal(result.status, "REVIEWED_NO_ACTIONS");
  assert.equal(result.sessionDecisionLedger?.rejectedProposalOperationTuples.includes(tuple), true);
  assert.equal(result.sessionDecisionLedger?.projectId, proposal.trustedPreExecutionProject.id);
});

test("evaluator structurally fails protected asset and partial-range attacks even when quality metrics pass", () => {
  const scenario = createMedicalReviewedExecution();
  const common = {
    proposalBundle: scenario.proposal,
    humanReviewState: scenario.result.reviewState,
    reviewedPlan: scenario.result.reviewedPlan,
    executionResult: scenario.result.execution,
    planEvidence: scenario.result.planEvidence,
    videoSemanticEvidence: scenario.input.videoAnalyses,
    audioRhythmEvidence: scenario.input.rhythm,
  };
  const assetSet = createProtectedClipConstraintSet(scenario.result.execution!.preProject, "clip-0");
  const assetReport = evaluateEditorExecution({
    ...common,
    postProject: scenario.result.execution!.postProject,
    constraintSet: assetSet,
  });
  const hardAsset = assetReport.metricResults.find((item) => item.metric === "HARD_CONSTRAINT_COMPLIANCE")!;
  assert.equal(hardAsset.status, "FAIL");
  assert.equal(assetReport.overallStatus, "FAIL");
  assert.equal(assetReport.metricResults.some((item) => item.metric === "SEMANTIC_MATCH" && item.status === "PASS"), true);

  const rangeSet = createProtectedClipConstraintSet(scenario.result.execution!.preProject, "clip-4");
  const partial = structuredClone(scenario.result.execution!.postProject);
  partial.tracks[0].clips.find((item) => item.id === "clip-4")!.sourceInMs = 100;
  const rangeReport = evaluateEditorExecution({ ...common, postProject: partial, constraintSet: rangeSet });
  assert.equal(rangeReport.metricResults.find((item) => item.metric === "HARD_CONSTRAINT_COMPLIANCE")?.status, "FAIL");
  assert.equal(rangeReport.defects.some((item) => item.metric === "HARD_CONSTRAINT_COMPLIANCE" && item.severity === "FAIL"), true);
});

test("Option B 30s/38s policy passes safe protection and still reports the truthful 8s gap", () => {
  const input = createMedicalReviewInput();
  input.project.durationMs = 38_000;
  input.project.audioSelection = {
    mode: "full", sourceDurationMs: 38_000, sourceInMs: 0, sourceOutMs: 38_000, selectedDurationMs: 38_000,
  };
  const generated = generateEditorProposal(input);
  if (!generated.ok) assert.fail(generated.message);
  let review = createHumanReviewState(generated.bundle);
  for (const entry of generated.bundle.proposalEntries) {
    review = reviewProposalEntry(generated.bundle, review, { proposalEntryId: entry.proposalEntryId, decision: "ACCEPT" });
  }
  const execution = executeReviewedProposal({
    proposal: generated.bundle,
    review,
    currentProject: generated.bundle.trustedPreExecutionProject,
    executionUpdatedAt: "2026-10-25T06:20:00.000Z",
  });
  const report = evaluateEditorExecution({
    proposalBundle: generated.bundle,
    humanReviewState: execution.reviewState,
    reviewedPlan: execution.reviewedPlan,
    executionResult: execution.execution,
    postProject: execution.execution!.postProject,
    planEvidence: execution.planEvidence,
    videoSemanticEvidence: input.videoAnalyses,
    resolvedDurationPolicy: {
      policy: "CLOSEST_SAFELY_ACHIEVABLE",
      requestedDurationMs: 30_000,
      minimumFeasibleDurationMs: 38_000,
      remainingGapMs: 8_000,
      canReachRequestedDuration: false,
      hardProtections: "UNCHANGED",
    },
  });
  assert.equal(report.overallStatus, "PASS");
  assert.deepEqual(report.summary.durationOutcome, {
    policy: "CLOSEST_SAFELY_ACHIEVABLE",
    requestedDurationMs: 30_000,
    achievedDurationMs: 38_000,
    remainingTargetGapMs: 8_000,
    hardProtectionCompliant: true,
  });
});

test("campus Option B safe path edits only unprotected B-roll and preserves 35s speech plus 3s ending", () => {
  const fixture = createConstraintEnforcementFixture({ includeUnprotected: true });
  const feasibility = evaluateConstraintFeasibilityV1({
    project: fixture.project,
    intent: fixture.intent,
    constraintSet: fixture.constraintSet,
    projectFingerprint: fixture.projectFingerprint,
  });
  const draft = createNegotiationStateV1(fixture.intent);
  const checking = transitionNegotiationStateV1(draft, {
    status: "FEASIBILITY_CHECK",
    activeIntentVersionId: fixture.intent.intentId,
    constraintSetId: fixture.constraintSet.constraintSetId,
    constraintFingerprint: fixture.constraintSet.constraintFingerprint,
    resolutionIds: [], unresolvedConflictIds: [], planningPaused: false,
  });
  const state = negotiationStateFromFeasibilityV1(checking, fixture.intent, fixture.constraintSet, feasibility);
  const conflict = feasibility.conflicts.find((item) => item.type === "DURATION_CONFLICT")!;
  const resolved = resolveConstraintConflictV1({
    state,
    intent: fixture.intent,
    project: fixture.project,
    projectFingerprint: fixture.projectFingerprint,
    confirmedBindings: fixture.confirmedBindings,
    feasibilityReport: feasibility,
    conflictId: conflict.conflictId,
    selectedResolution: "OPTIMIZE_UNPROTECTED_ONLY",
    createdAt: "2026-10-25T06:30:00.000Z",
  });
  assert.equal(resolved.state.status, "READY_TO_PLAN");
  if (!resolved.constraintSet || !resolved.proposalContext) assert.fail("Option B did not produce authoritative planning context.");
  const safe = applyAIEditingPlan(plan({
    type: "MATCH_ASSET_TO_SEGMENT",
    targetId: "clip-broll",
    assetId: "asset-broll-alt",
    startSeconds: 35,
    endSeconds: 38,
    reason: "Edit only unprotected B-roll.",
  }), canonicalContext(fixture.project, resolved.constraintSet));
  const invariant = verifyPostApplyConstraintInvariantsV1({
    preProject: fixture.project,
    candidateProject: safe.project,
    constraintSet: resolved.constraintSet,
    expectedContext: expectedContext(resolved.constraintSet),
  });
  assert.equal(invariant.status, "ALLOWED");
  assert.equal(safe.project.durationMs, 38_000);
  assert.deepEqual(safe.project.tracks[0].clips.find((item) => item.id === "clip-teacher"), fixture.project.tracks[0].clips.find((item) => item.id === "clip-teacher"));
  assert.deepEqual(safe.project.tracks[0].clips.find((item) => item.id === "clip-logo"), fixture.project.tracks[0].clips.find((item) => item.id === "clip-logo"));
  assert.equal(resolved.feasibilityReport?.remainingGapMs, 8_000);
  assert.equal(resolved.resolution.structuredPolicy.policy, "CLOSEST_SAFELY_ACHIEVABLE");
});
