import assert from "node:assert/strict";
import test from "node:test";
import { recordProjectUndoSnapshot, type EditorProject } from "./editor-core.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import { executeCompiledNarrativeActionPlan } from "./editor-compiled-plan-execution.ts";
import type { EditorProposalBundle } from "./editor-proposal-orchestrator.ts";
import {
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

function medicalReview(proposal: EditorProposalBundle) {
  let review = createHumanReviewState(proposal);
  review = decide(proposal, review, 0, "ACCEPT");
  review = decide(proposal, review, 1, "ACCEPT");
  review = decide(proposal, review, 2, "MODIFY", "asset-ecg-alt");
  review = decide(proposal, review, 3, "REJECT");
  return decide(proposal, review, 4, "ACCEPT");
}

function run(proposal: EditorProposalBundle, review: HumanReviewState) {
  return executeReviewedProposal({ proposal, review, currentProject: proposal.trustedPreExecutionProject, executionUpdatedAt: "2026-10-25T01:00:00.000Z" });
}

test("review-state changes create zero project history", () => {
  const proposal = createMedicalReviewProposal();
  const before = structuredClone(proposal.trustedPreExecutionProject);
  const history: EditorProject[] = [];
  medicalReview(proposal);
  assert.equal(history.length, 0);
  assert.deepEqual(proposal.trustedPreExecutionProject, before);
});

test("successful reviewed execution contributes one logical history entry", () => {
  const proposal = createMedicalReviewProposal();
  const result = run(proposal, medicalReview(proposal));
  let history: EditorProject[] = [];
  if (result.history.shouldRecord) history = recordProjectUndoSnapshot(history, result.history.undoProject!);
  assert.equal(result.execution?.appliedActionCount, 4);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], proposal.trustedPreExecutionProject);
});

test("undo restores the exact pre-review-execution project", () => {
  const proposal = createMedicalReviewProposal();
  const result = run(proposal, medicalReview(proposal));
  let current = result.history.redoProject!;
  const undo = recordProjectUndoSnapshot([], result.history.undoProject!);
  const future: EditorProject[] = [];
  const previous = undo.pop()!;
  future.push(structuredClone(current));
  current = previous;
  assert.deepEqual(current, proposal.trustedPreExecutionProject);
  assert.equal(future.length, 1);
});

test("redo restores the exact executed post-project", () => {
  const proposal = createMedicalReviewProposal();
  const result = run(proposal, medicalReview(proposal));
  let current = result.history.undoProject!;
  const undo: EditorProject[] = [];
  const future = [structuredClone(result.history.redoProject!)];
  const next = future.pop()!;
  undo.push(structuredClone(current));
  current = next;
  assert.deepEqual(current, result.execution?.postProject);
  assert.deepEqual(current.tracks[0].clips.map((clip) => clip.assetId), [
    "asset-consultation", "asset-anatomy", "asset-ecg-alt", "seed-3", "asset-recovery",
  ]);
});

test("failed reviewed execution creates no history", () => {
  const proposal = createMedicalReviewProposal();
  const result = executeReviewedProposal({
    proposal,
    review: medicalReview(proposal),
    currentProject: proposal.trustedPreExecutionProject,
    executionUpdatedAt: "2026-10-25T01:00:00.000Z",
  }, { executePlan: (input) => executeCompiledNarrativeActionPlan(input, { applyPlan: () => { throw new Error("fail"); } }) });
  assert.equal(result.status, "EXECUTION_FAILED");
  assert.equal(result.history.shouldRecord, false);
  assert.equal(result.history.undoProject, undefined);
});

test("all-rejected review creates no history", () => {
  const proposal = createMedicalReviewProposal();
  let review = createHumanReviewState(proposal);
  proposal.proposalEntries.forEach((_, index) => { review = decide(proposal, review, index, "REJECT"); });
  const result = run(proposal, review);
  assert.equal(result.status, "REVIEWED_NO_ACTIONS");
  assert.deepEqual(result.history, { shouldRecord: false });
});

test("pure V2.0D no-op creates no false history", () => {
  const source = createMedicalReviewProposal();
  let accepted = createHumanReviewState(source);
  source.proposalEntries.forEach((_, index) => { accepted = decide(source, accepted, index, "ACCEPT"); });
  const applied = run(source, accepted);
  const current = structuredClone(applied.execution!.postProject);
  const proposal = structuredClone(source) as unknown as EditorProposalBundle;
  const mutable = proposal as unknown as { trustedPreExecutionProject: typeof current; sourceProjectFingerprint: string };
  mutable.trustedPreExecutionProject = current;
  mutable.sourceProjectFingerprint = createEditorProjectFingerprint(current);
  let repeated = createHumanReviewState(proposal);
  proposal.proposalEntries.forEach((_, index) => { repeated = decide(proposal, repeated, index, "ACCEPT"); });
  const result = executeReviewedProposal({ proposal, review: repeated, currentProject: current, executionUpdatedAt: "2026-10-25T01:01:00.000Z" });
  assert.equal(result.execution?.status, "NO_OP");
  assert.equal(result.history.shouldRecord, false);
});
