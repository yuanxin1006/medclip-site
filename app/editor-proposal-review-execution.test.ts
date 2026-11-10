import assert from "node:assert/strict";
import test from "node:test";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import { executeCompiledNarrativeActionPlan } from "./editor-compiled-plan-execution.ts";
import type { EditorProposalBundle } from "./editor-proposal-orchestrator.ts";
import {
  ProposalReviewError,
  createHumanReviewState,
  executeReviewedProposal,
  reviewProposalEntry,
  type HumanReviewState,
} from "./editor-proposal-review.ts";
import { createMedicalReviewProposal } from "./test-support/editor-proposal-review-fixture.ts";

function decide(proposal: EditorProposalBundle, review: HumanReviewState, index: number, decision: "ACCEPT" | "REJECT" | "MODIFY", selectedAssetId?: string) {
  return reviewProposalEntry(proposal, review, {
    proposalEntryId: proposal.proposalEntries[index].proposalEntryId,
    decision,
    ...(selectedAssetId ? { selectedAssetId } : {}),
  });
}

function acceptAll(proposal: EditorProposalBundle) {
  let review = createHumanReviewState(proposal);
  proposal.proposalEntries.forEach((_, index) => { review = decide(proposal, review, index, "ACCEPT"); });
  return review;
}

function mixed(proposal: EditorProposalBundle) {
  let review = createHumanReviewState(proposal);
  review = decide(proposal, review, 0, "ACCEPT");
  review = decide(proposal, review, 1, "ACCEPT");
  review = decide(proposal, review, 2, "MODIFY", "asset-ecg-alt");
  review = decide(proposal, review, 3, "REJECT");
  return decide(proposal, review, 4, "ACCEPT");
}

function execute(proposal: EditorProposalBundle, review: HumanReviewState) {
  return executeReviewedProposal({
    proposal,
    review,
    currentProject: proposal.trustedPreExecutionProject,
    executionUpdatedAt: "2026-10-25T00:10:00.000Z",
  });
}

test("an accepted batch executes through the real V2.0D path", () => {
  const proposal = createMedicalReviewProposal();
  const result = execute(proposal, acceptAll(proposal));
  assert.equal(result.status, "EXECUTED");
  assert.equal(result.execution?.status, "APPLIED");
  assert.equal(result.execution?.actionResults.length, 5);
  assert.equal(result.execution?.historyBoundary.strategy, "EXISTING_PROJECT_SNAPSHOT");
});

test("mixed review executes only accepted and modified actions", () => {
  const proposal = createMedicalReviewProposal();
  const result = execute(proposal, mixed(proposal));
  assert.equal(result.execution?.actionResults.length, 4);
  assert.equal(result.execution?.appliedActionCount, 4);
  assert.deepEqual(result.execution?.postProject.tracks[0].clips.map((clip) => clip.assetId), [
    "asset-consultation", "asset-anatomy", "asset-ecg-alt", "seed-3", "asset-recovery",
  ]);
});

test("rejected actions never reach the executor", () => {
  const proposal = createMedicalReviewProposal();
  let capturedAssets: readonly (string | undefined)[] = [];
  executeReviewedProposal({
    proposal,
    review: mixed(proposal),
    currentProject: proposal.trustedPreExecutionProject,
    executionUpdatedAt: "2026-10-25T00:10:00.000Z",
  }, { executePlan: (input) => {
    capturedAssets = input.compiledPlan.canonicalPlan.actions.map((action) => action.assetId);
    return executeCompiledNarrativeActionPlan(input);
  } });
  assert.deepEqual(capturedAssets, ["asset-consultation", "asset-anatomy", "asset-ecg-alt", "asset-recovery"]);
  assert.equal(capturedAssets.includes("asset-treatment"), false);
});

test("modified action executes the selected trusted alternative", () => {
  const proposal = createMedicalReviewProposal();
  const result = execute(proposal, mixed(proposal));
  const ecg = result.reviewedPlan.reviewedEntries[2];
  assert.equal(ecg.originalAssetId, "asset-ecg");
  assert.equal(ecg.selectedAssetId, "asset-ecg-alt");
  assert.equal(result.execution?.postProject.tracks[0].clips[2].assetId, "asset-ecg-alt");
});

test("existing canonical parser validation completes before executor invocation", () => {
  const proposal = createMedicalReviewProposal();
  let invoked = false;
  executeReviewedProposal({
    proposal,
    review: acceptAll(proposal),
    currentProject: proposal.trustedPreExecutionProject,
    executionUpdatedAt: "2026-10-25T00:10:00.000Z",
  }, { executePlan: (input) => {
    invoked = true;
    assert.deepEqual(input.compiledPlan.canonicalValidation, { parser: "parseAIEditingPlan", valid: true });
    return executeCompiledNarrativeActionPlan(input);
  } });
  assert.equal(invoked, true);
});

test("execution failure preserves the exact pre-project and creates no history boundary", () => {
  const proposal = createMedicalReviewProposal();
  const result = executeReviewedProposal({
    proposal,
    review: acceptAll(proposal),
    currentProject: proposal.trustedPreExecutionProject,
    executionUpdatedAt: "2026-10-25T00:10:00.000Z",
  }, { executePlan: (input) => executeCompiledNarrativeActionPlan(input, { applyPlan: () => { throw new Error("controlled failure"); } }) });
  assert.equal(result.status, "EXECUTION_FAILED");
  assert.equal(result.execution?.failureCode, "ACTION_APPLICATION_FAILED");
  assert.deepEqual(result.execution?.postProject, proposal.trustedPreExecutionProject);
  assert.deepEqual(result.history, { shouldRecord: false });
});

test("all rejected produces no V2.0D call and no execution evidence", () => {
  const proposal = createMedicalReviewProposal();
  let review = createHumanReviewState(proposal);
  proposal.proposalEntries.forEach((_, index) => { review = decide(proposal, review, index, "REJECT"); });
  let calls = 0;
  const result = executeReviewedProposal({
    proposal,
    review,
    currentProject: proposal.trustedPreExecutionProject,
    executionUpdatedAt: "2026-10-25T00:10:00.000Z",
  }, { executePlan: (input) => { calls += 1; return executeCompiledNarrativeActionPlan(input); } });
  assert.equal(calls, 0);
  assert.equal(result.status, "REVIEWED_NO_ACTIONS");
  assert.equal(result.execution, undefined);
  assert.equal(result.planEvidence.summary.execution, undefined);
});

test("real V2.0D no-op behavior creates no false history", () => {
  const source = createMedicalReviewProposal();
  const firstExecution = execute(source, acceptAll(source));
  const current = structuredClone(firstExecution.execution!.postProject);
  const proposal = structuredClone(source) as unknown as EditorProposalBundle;
  const mutable = proposal as unknown as { trustedPreExecutionProject: typeof current; sourceProjectFingerprint: string };
  mutable.trustedPreExecutionProject = current;
  mutable.sourceProjectFingerprint = createEditorProjectFingerprint(current);
  const result = executeReviewedProposal({
    proposal,
    review: acceptAll(proposal),
    currentProject: current,
    executionUpdatedAt: "2026-10-25T00:10:00.000Z",
  });
  assert.equal(result.execution?.status, "NO_OP");
  assert.equal(result.history.shouldRecord, false);
});

test("post-execution PlanEvidence is based on real action results", () => {
  const proposal = createMedicalReviewProposal();
  const result = execute(proposal, mixed(proposal));
  assert.equal(result.planEvidence.lifecycleStatus, "EXECUTED");
  assert.equal(result.planEvidence.summary.execution?.fingerprint, result.execution?.executionFingerprint);
  assert.equal(result.planEvidence.entries.filter((entry) => entry.status === "APPLIED").length, 4);
  assert.equal(result.planEvidence.entries[3].status, "NOT_EXECUTED");
  assert.equal(result.planEvidence.entries[3].beforeAfter, undefined);
  assert.equal(result.planEvidence.entries[3].actionResultStatus, undefined);
});

test("post evidence preserves AI proposal, human decisions, modification, and actual result", () => {
  const proposal = createMedicalReviewProposal();
  const result = execute(proposal, mixed(proposal));
  const ecg = result.planEvidence.entries[2];
  assert.equal(ecg.selectedAssetId, "asset-ecg");
  assert.equal(ecg.compiledAction?.assetId, "asset-ecg");
  assert.deepEqual(ecg.humanReview, {
    decision: "MODIFIED",
    provenance: "USER_MODIFIED",
    originalAssetId: "asset-ecg",
    selectedAssetId: "asset-ecg-alt",
  });
  assert.equal(ecg.executedAction?.assetId, "asset-ecg-alt");
  assert.equal(ecg.beforeAfter?.assetAfter, "asset-ecg-alt");
  assert.equal(result.planEvidence.entries[3].humanReview?.provenance, "USER_REJECTED");
});

test("stale proposal blocks execution before V2.0D is invoked", () => {
  const proposal = createMedicalReviewProposal();
  const current = structuredClone(proposal.trustedPreExecutionProject);
  current.updatedAt = "2026-10-25T00:09:00.000Z";
  let calls = 0;
  assert.throws(() => executeReviewedProposal({
    proposal,
    review: acceptAll(proposal),
    currentProject: current,
    executionUpdatedAt: "2026-10-25T00:10:00.000Z",
  }, { executePlan: (input) => { calls += 1; return executeCompiledNarrativeActionPlan(input); } }),
  (error) => error instanceof ProposalReviewError && error.code === "STALE_PROPOSAL");
  assert.equal(calls, 0);
});
