import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createMedicalReviewInput } from "./test-support/editor-proposal-review-fixture.ts";
import { createHumanReviewState, executeReviewedProposal, ProposalReviewError, reviewProposalEntry } from "./editor-proposal-review.ts";
import { executeCompiledNarrativeActionPlan } from "./editor-compiled-plan-execution.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import { createReferenceEditStyleProfile, evaluateReferenceStyleFit, planReferenceStyleTransfer, type ReferenceVideoEvidence, REFERENCE_STYLE_ANALYSIS_VERSION } from "./editor-reference-style.ts";
import { buildReferenceStyleReviewBundle } from "./editor-reference-style-review.ts";

const evidence: ReferenceVideoEvidence = { version: 1, id: "reference-v1-fixture", durationMs: 12_000, analysisVersion: REFERENCE_STYLE_ANALYSIS_VERSION, analysisOnly: true, cutBoundaries: [2_000, 4_000, 7_000, 9_000].map((timestampMs) => ({ timestampMs, changeScore: 0.8, confidence: "HIGH", provenance: "MEASURED" })), frameSampleCounts: { coarse: 12, fine: 20 } };
const profile = createReferenceEditStyleProfile(evidence);

function fixture() {
  const { project } = createMedicalReviewInput();
  project.durationMs = 11_000;
  project.audioSelection = { mode: "full", sourceDurationMs: 11_000, sourceInMs: 0, sourceOutMs: 11_000, selectedDurationMs: 11_000 };
  project.tracks[0].clips.forEach((clip, index) => {
    clip.timelineStartMs = index === 0 ? 0 : 3_000 + (index - 1) * 2_000;
    clip.timelineEndMs = index === 0 ? 3_000 : clip.timelineStartMs + 2_000;
    clip.sourceOutMs = clip.timelineEndMs - clip.timelineStartMs;
  });
  const scenes = project.assets.filter((asset) => asset.id.startsWith("asset-")).map((asset, index) => ({ sceneId: `scene-${asset.id}`, assetId: asset.id, sourceStartMs: 0, sourceEndMs: [1_800, 2_200, 2_800, 3_200][index % 4], semanticSummary: "eligible campus activity scene", semanticScore: 0.9, semanticProvenance: "VIDEO_SEMANTIC_EVIDENCE" as const }));
  const alternatives = project.assets.filter((asset) => asset.id.startsWith("asset-")).slice(0, 2).map((asset, index) => ({ sceneId: `alt-${asset.id}`, assetId: asset.id, sourceStartMs: 0, sourceEndMs: 1_800 + index * 400, semanticSummary: "eligible campus activity scene", semanticScore: 0.9, semanticProvenance: "VIDEO_SEMANTIC_EVIDENCE" as const }));
  const targetClips = project.tracks.flatMap((track) => track.clips).map((clip) => ({ clipId: clip.id, assetId: clip.assetId, timelineStartMs: clip.timelineStartMs, timelineEndMs: clip.timelineEndMs }));
  const plan = planReferenceStyleTransfer({ profile, targetDurationMs: project.durationMs, targetClips, candidateScenes: [...scenes, ...alternatives], protectedRanges: [{ id: "teacher-speech", startMs: 20_000, endMs: 21_000, clipId: "clip-1", assetId: "seed-1" }], referenceId: evidence.id });
  assert.equal(plan.status, "READY_FOR_REVIEW");
  if (plan.status !== "READY_FOR_REVIEW") throw new Error("style fixture did not produce a proposal");
  const proposal = buildReferenceStyleReviewBundle({ proposal: plan.proposal, profile, project, scenes: [...scenes, ...alternatives] });
  return { project, scenes: [...scenes, ...alternatives], plan: plan.proposal, proposal };
}

function decide(proposal: ReturnType<typeof fixture>["proposal"], review: ReturnType<typeof createHumanReviewState>, index: number, decision: "ACCEPT" | "REJECT" | "MODIFY", selectedAssetId?: string) {
  return reviewProposalEntry(proposal, review, { proposalEntryId: proposal.proposalEntries[index].proposalEntryId, decision, ...(selectedAssetId ? { selectedAssetId } : {}) }, proposal.trustedPreExecutionProject);
}

test("V2.7B style proposal enters existing review, canonical validation, and mixed human decisions", () => {
  const { proposal, plan } = fixture();
  assert.equal(proposal.proposalId, plan.proposalId);
  assert.equal(proposal.planEvidence.lifecycleStatus, "PENDING_REVIEW");
  assert.equal(proposal.compiledPlan.canonicalValidation.valid, true);
  assert.ok(proposal.compiledPlan.canonicalPlan.actions.some((action) => action.type === "MATCH_ASSET_TO_SEGMENT" && /Reference cadence/.test(action.reason)));
  assert.equal(proposal.evidenceMetadata.providerCalls, 0);
  assert.ok(proposal.proposalEntries.every((entry) => entry.proposalEntryId.startsWith("e-")));
});

test("V2.7B review explanation hides raw matching scores for reference-style proposals", () => {
  const source = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  assert.match(source, /showDetailedScores=\{!musicVideoResult && !\(editorProposal \?\? reviewedEvidenceProposal\)\?\.proposalId\.startsWith\("reference-style-proposal-v1-"\)\}/);
});

test("V2.7B ACCEPT executes, MODIFY compiles only its final choice, REJECT never executes, and history restores exact states", () => {
  const { proposal, project, plan } = fixture();
  const actionIndexes = proposal.proposalEntries.map((entry, index) => entry.actionIndex === undefined ? -1 : index).filter((index) => index >= 0);
  assert.ok(actionIndexes.length >= 3, JSON.stringify({ actionIndexes, items: plan.items.map((item) => ({ slot: item.slotId, clip: item.targetClipId, scene: item.selectedSceneId, protected: item.protected, action: item.canonicalAction?.type })) }));
  const acceptIndex = actionIndexes[0];
  const modifyIndex = actionIndexes.find((index) => index !== acceptIndex && !plan.items[index].protected)!;
  const rejectIndex = actionIndexes.find((index) => index !== acceptIndex && index !== modifyIndex && !plan.items[index].protected)!;
  const modifyId = proposal.proposalEntries[modifyIndex].proposalEntryId;
  const ranked = proposal.rankedCandidateSets.find((item) => item.intervalId === proposal.proposalEntries[modifyIndex].intervalId)!;
  const original = proposal.proposalEntries[modifyIndex].selectedAssetId;
  const alternative = ranked.candidates.find((candidate) => candidate.assetId !== original)?.assetId;
  assert.ok(alternative, "fixture provides an eligible alternative for MODIFY");

  let review = createHumanReviewState(proposal);
  review = decide(proposal, review, acceptIndex, "ACCEPT");
  review = decide(proposal, review, modifyIndex, "MODIFY", alternative);
  review = decide(proposal, review, rejectIndex, "REJECT");
  for (let index = 0; index < proposal.proposalEntries.length; index += 1) if (review.entries[index].status === "PENDING") review = decide(proposal, review, index, "ACCEPT");

  let executorCalls = 0;
  const execution = executeReviewedProposal({ proposal, review, currentProject: project, executionUpdatedAt: "2026-10-31T10:00:00.000Z" }, { executePlan: (input) => { executorCalls += 1; return executeCompiledNarrativeActionPlan(input); } });
  assert.equal(executorCalls, 1, "one approved reviewed execution runs once without an optimization loop");
  assert.equal(execution.execution?.status, "APPLIED", JSON.stringify({ failure: execution.execution?.failureCode, actions: execution.reviewedPlan.compiledPlan.canonicalPlan.actions }));
  assert.ok(execution.execution!.appliedActionCount >= 2);
  assert.equal(execution.reviewedPlan.reviewedEntries.find((entry) => entry.proposalEntryId === proposal.proposalEntries[rejectIndex].proposalEntryId)?.reviewedActionIndex, undefined);
  const modified = execution.reviewedPlan.reviewedEntries.find((entry) => entry.proposalEntryId === modifyId)!;
  assert.equal(modified.decision, "MODIFIED");
  assert.equal(modified.selectedAssetId, alternative);
  assert.notEqual(modified.action?.assetId, original);
  assert.equal(execution.planEvidence.entries.find((entry) => entry.proposalEntryId === proposal.proposalEntries[rejectIndex].proposalEntryId)?.executionDisposition, "NOT_EXECUTED_USER_REJECTED");
  assert.equal(execution.execution!.postProject.tracks.flatMap((track) => track.clips).find((clip) => clip.id === "clip-1")?.assetId, "seed-1", "protected teacher segment remains unchanged");
  assert.ok(execution.reviewedPlan.compiledPlan.canonicalPlan.actions.every((action) => action.assetId !== evidence.id));
  assert.notEqual(execution.reviewedPlan.reviewedEntries.find((entry) => entry.proposalEntryId === proposal.proposalEntries[modifyIndex].proposalEntryId)?.action?.assetId, original, "original pre-modify material is excluded");
  assert.equal(execution.reviewedPlan.reviewedEntries.find((entry) => entry.proposalEntryId === proposal.proposalEntries[modifyIndex].proposalEntryId)?.action?.assetId, alternative, "final modified choice is compiled");
  const modifiedTargetId = proposal.proposalEntries[modifyIndex].targetId;
  assert.equal(execution.execution!.postProject.tracks.flatMap((track) => track.clips).find((clip) => clip.id === modifiedTargetId)?.assetId, alternative);
  assert.equal(execution.history.shouldRecord, true);
  assert.deepEqual(execution.history.undoProject, project);
  assert.deepEqual(execution.history.redoProject, execution.execution!.postProject);
  assert.equal(createEditorProjectFingerprint(execution.history.undoProject!), createEditorProjectFingerprint(project));
  assert.equal(createEditorProjectFingerprint(execution.history.redoProject!), createEditorProjectFingerprint(execution.execution!.postProject));
  assert.ok(execution.execution!.postProject.assets.every((asset) => asset.id !== evidence.id));
});

test("V2.7B stale reviewed style proposal fails closed before execution", () => {
  const { proposal } = fixture();
  let review = createHumanReviewState(proposal);
  proposal.proposalEntries.forEach((_, index) => { review = decide(proposal, review, index, "ACCEPT"); });
  const changed = structuredClone(proposal.trustedPreExecutionProject);
  changed.title = "authoritative project changed";
  assert.throws(() => executeReviewedProposal({ proposal, review, currentProject: changed, executionUpdatedAt: "2026-10-31T10:00:00.000Z" }), (error) => error instanceof ProposalReviewError && error.code === "STALE_PROPOSAL");
});

test("V2.7B reports the same measurable duration fit before and after match-only execution without optimization loops", () => {
  const { proposal, project, plan } = fixture();
  let review = createHumanReviewState(proposal);
  proposal.proposalEntries.forEach((_, index) => { review = decide(proposal, review, index, "ACCEPT"); });
  const result = executeReviewedProposal({ proposal, review, currentProject: project, executionUpdatedAt: "2026-10-31T10:00:00.000Z" });
  const durations = (state: typeof project) => state.tracks.flatMap((track) => track.clips).sort((a, b) => a.timelineStartMs - b.timelineStartMs).map((clip) => clip.timelineEndMs - clip.timelineStartMs);
  const pre = evaluateReferenceStyleFit(profile, durations(project), project.durationMs);
  const post = evaluateReferenceStyleFit(profile, durations(result.execution!.postProject), project.durationMs);
  assert.ok(pre.score >= 0 && pre.score <= 1 && post.score >= 0 && post.score <= 1);
  assert.equal(post.score, pre.score, "MATCH_ASSET_TO_SEGMENT preserves shot durations, so the fit metric must remain unchanged");
  assert.equal(plan.autoExecuted, false);
  assert.equal(plan.referenceMediaExclusion.assetUsedInOutput, false);
  assert.equal(plan.referenceMediaExclusion.audioUsedInOutput, false);
  assert.equal(plan.referenceMediaExclusion.frameUsedInOutput, false);
  assert.equal(result.reviewState.lifecycle, "EXECUTED");
});
