import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { EditorProject } from "./editor-core.ts";
import type { EditorProposalBundle } from "./editor-proposal-orchestrator.ts";
import {
  ProposalReviewError,
  buildReviewedProposalPlan,
  createHumanReviewState,
  reviewProposalEntry,
  safeModificationCandidates,
  type HumanReviewDecision,
  type HumanReviewState,
} from "./editor-proposal-review.ts";
import { createMedicalReviewProposal } from "./test-support/editor-proposal-review-fixture.ts";

function decide(proposal: EditorProposalBundle, review: HumanReviewState, index: number, decision: HumanReviewDecision["decision"], selectedAssetId?: string) {
  return reviewProposalEntry(proposal, review, {
    proposalEntryId: proposal.proposalEntries[index].proposalEntryId,
    decision,
    ...(selectedAssetId ? { selectedAssetId } : {}),
  });
}

function expectReviewError(code: ProposalReviewError["code"], operation: () => unknown) {
  assert.throws(operation, (error) => error instanceof ProposalReviewError && error.code === code);
}

function completeMixedReview(proposal: EditorProposalBundle): HumanReviewState {
  let review = createHumanReviewState(proposal);
  review = decide(proposal, review, 0, "ACCEPT");
  review = decide(proposal, review, 1, "ACCEPT");
  review = decide(proposal, review, 2, "MODIFY", "asset-ecg-alt");
  review = decide(proposal, review, 3, "REJECT");
  return decide(proposal, review, 4, "ACCEPT");
}

test("accept records an explicit per-entry decision without changing the project", () => {
  const proposal = createMedicalReviewProposal();
  const before = structuredClone(proposal.trustedPreExecutionProject);
  const review = decide(proposal, createHumanReviewState(proposal), 0, "ACCEPT");
  assert.deepEqual(review.entries[0], {
    proposalEntryId: proposal.proposalEntries[0].proposalEntryId,
    intervalId: "interval-consultation",
    status: "ACCEPTED",
    provenance: "USER_ACCEPTED",
  });
  assert.equal(review.lifecycle, "REVIEW_IN_PROGRESS");
  assert.deepEqual(proposal.trustedPreExecutionProject, before);
});

test("reject records provenance and retains the original proposal entry", () => {
  const proposal = createMedicalReviewProposal();
  const review = decide(proposal, createHumanReviewState(proposal), 3, "REJECT");
  assert.equal(review.entries[3].status, "REJECTED");
  assert.equal(review.entries[3].provenance, "USER_REJECTED");
  assert.equal(proposal.proposalEntries[3].selectedAssetId, "asset-treatment");
});

test("modify permits a valid accepted alternative from the same interval", () => {
  const proposal = createMedicalReviewProposal();
  const alternatives = safeModificationCandidates(proposal, proposal.proposalEntries[2].proposalEntryId);
  assert.deepEqual(alternatives.map((item) => item.assetId), ["asset-ecg-alt"]);
  const review = decide(proposal, createHumanReviewState(proposal), 2, "MODIFY", "asset-ecg-alt");
  assert.equal(review.entries[2].status, "MODIFIED");
  assert.equal(review.entries[2].provenance, "USER_MODIFIED");
  assert.equal(review.entries[2].selectedAssetId, "asset-ecg-alt");
});

test("invalid alternative from another interval is rejected", () => {
  const proposal = createMedicalReviewProposal();
  expectReviewError("INVALID_ALTERNATIVE", () => decide(proposal, createHumanReviewState(proposal), 2, "MODIFY", "asset-treatment"));
});

test("invented asset IDs are rejected", () => {
  const proposal = createMedicalReviewProposal();
  expectReviewError("INVALID_ALTERNATIVE", () => decide(proposal, createHumanReviewState(proposal), 2, "MODIFY", "invented-asset"));
});

test("a V2.0A-rejected candidate cannot be selected", () => {
  const proposal = createMedicalReviewProposal();
  const ecgSet = proposal.rankedCandidateSets.find((set) => set.intervalId === "interval-ecg");
  assert.equal(ecgSet?.candidates.some((item) => item.assetId === "asset-ecg-rejected"), true);
  assert.equal(safeModificationCandidates(proposal, proposal.proposalEntries[2].proposalEntryId).some((item) => item.assetId === "asset-ecg-rejected"), false);
  expectReviewError("INVALID_ALTERNATIVE", () => decide(proposal, createHumanReviewState(proposal), 2, "MODIFY", "asset-ecg-rejected"));
});

test("mixed review builds only accepted and modified actions", () => {
  const proposal = createMedicalReviewProposal();
  const reviewed = buildReviewedProposalPlan(proposal, completeMixedReview(proposal), proposal.trustedPreExecutionProject);
  assert.equal(reviewed.status, "READY_TO_EXECUTE");
  assert.equal(reviewed.compiledPlan.canonicalPlan.actions.length, 4);
  assert.deepEqual(reviewed.reviewedEntries.map((entry) => entry.decision), ["ACCEPTED", "ACCEPTED", "MODIFIED", "REJECTED", "ACCEPTED"]);
  assert.equal(reviewed.compiledPlan.canonicalPlan.actions.some((action) => action.assetId === "asset-treatment"), false);
  assert.equal(reviewed.compiledPlan.canonicalPlan.actions[2].assetId, "asset-ecg-alt");
  assert.deepEqual(reviewed.compiledPlan.canonicalPlan.actions[0], proposal.compiledPlan.canonicalPlan.actions[0]);
});

test("all rejected creates an explicit no-actions reviewed plan", () => {
  const proposal = createMedicalReviewProposal();
  let review = createHumanReviewState(proposal);
  proposal.proposalEntries.forEach((_, index) => { review = decide(proposal, review, index, "REJECT"); });
  const reviewed = buildReviewedProposalPlan(proposal, review, proposal.trustedPreExecutionProject);
  assert.equal(review.lifecycle, "REVIEWED_NO_ACTIONS");
  assert.equal(reviewed.status, "REVIEWED_NO_ACTIONS");
  assert.equal(reviewed.compiledPlan.canonicalPlan.actions.length, 0);
});

test("pending entries block plan construction", () => {
  const proposal = createMedicalReviewProposal();
  const review = decide(proposal, createHumanReviewState(proposal), 0, "ACCEPT");
  expectReviewError("PENDING_ENTRIES", () => buildReviewedProposalPlan(proposal, review, proposal.trustedPreExecutionProject));
});

test("the same proposal and decisions produce a deterministic reviewed plan", () => {
  const proposal = createMedicalReviewProposal();
  const review = completeMixedReview(proposal);
  assert.deepEqual(
    buildReviewedProposalPlan(proposal, review, proposal.trustedPreExecutionProject),
    buildReviewedProposalPlan(proposal, review, proposal.trustedPreExecutionProject),
  );
});

test("building a reviewed plan leaves the original proposal immutable", () => {
  const proposal = createMedicalReviewProposal();
  const before = structuredClone(proposal);
  buildReviewedProposalPlan(proposal, completeMixedReview(proposal), proposal.trustedPreExecutionProject);
  assert.deepEqual(proposal, before);
});

test("user-modified provenance and original/final assets are retained structurally", () => {
  const proposal = createMedicalReviewProposal();
  const reviewed = buildReviewedProposalPlan(proposal, completeMixedReview(proposal), proposal.trustedPreExecutionProject);
  const ecg = reviewed.reviewedEntries[2];
  assert.equal(ecg.decision, "MODIFIED");
  assert.equal(ecg.originalAssetId, "asset-ecg");
  assert.equal(ecg.selectedAssetId, "asset-ecg-alt");
  assert.match(ecg.action?.reason ?? "", /User modified trusted proposal entry/);
});

test("duplicate target mutations fail closed", () => {
  const proposal = structuredClone(createMedicalReviewProposal()) as unknown as EditorProposalBundle;
  const mutable = proposal as unknown as { compiledPlan: { canonicalPlan: { actions: Array<{ targetId: string }> } } };
  mutable.compiledPlan.canonicalPlan.actions[1].targetId = mutable.compiledPlan.canonicalPlan.actions[0].targetId;
  expectReviewError("DUPLICATE_TARGET", () => buildReviewedProposalPlan(proposal, completeMixedReview(proposal), proposal.trustedPreExecutionProject));
});

test("stale proposal project fingerprint blocks reviewed plan construction", () => {
  const proposal = createMedicalReviewProposal();
  const changed = structuredClone(proposal.trustedPreExecutionProject) as EditorProject;
  changed.tracks[0].clips[0].assetId = "asset-recovery";
  changed.updatedAt = "2026-10-25T00:01:00.000Z";
  expectReviewError("STALE_PROPOSAL", () => buildReviewedProposalPlan(proposal, completeMixedReview(proposal), changed));
});

test("review reuses frozen planning outputs and contains no replanning, provider, or second mutation pipeline", () => {
  const source = readFileSync(new URL("./editor-proposal-review.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /buildMultimodalCandidateTable|planNarrativeSequence|compileNarrativeActionPlan\s*\(|analyzeAudioRhythm|analyzeVideo|runAITask|fetch\s*\(|DeepSeek|Kimi|Doubao|TokenHub/);
  assert.match(source, /parseAIEditingPlan/);
  assert.match(source, /executeCompiledNarrativeActionPlan/);
  assert.doesNotMatch(source, /applyAIEditingPlan\s*\(/);
});
