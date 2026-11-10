import assert from 'node:assert/strict';
import { createConstraintSet, hasEnforceableConstraintsV1 } from '../../app/editor-constraints.ts';
import { evaluateEditorExecution } from '../../app/editor-evaluator.ts';
import { createEditorProjectFingerprint } from '../../app/editor-plan-evidence.ts';
import { generateEditorProposal } from '../../app/editor-proposal-orchestrator.ts';
import {
  createHumanReviewState, executeReviewedProposal, reviewProposalEntry, safeModificationCandidates,
} from '../../app/editor-proposal-review.ts';
import {
  createRepairProposalBundle, createRepairReviewState, executeReviewedRepairLoop, reviewRepairEntry,
} from '../../app/editor-repair.ts';
import { resolveConstraintConflictV1 } from '../../app/editor-constraint-negotiation.ts';
import { createCampusNegotiationScenario } from '../../app/test-support/editor-constraint-negotiation-fixture.ts';
import { createProtectedClipConstraintSet } from '../../app/test-support/editor-constraint-enforcement-fixture.ts';
import { createMedicalReviewInput, createMedicalReviewedExecution } from '../../app/test-support/editor-proposal-review-fixture.ts';
import {
  createExecutionEditorFixtureV1,
  createImmutableRepetitionEditorFixtureV1,
  createImmutableRepetitionPlanningInput,
} from './editor-input-fixtures.mjs';

export const R11E_SCENARIO_CONTRACT = Object.freeze({
  campusScenario: Object.freeze({
    source: 'app/test-support/editor-constraint-negotiation-fixture.ts:createCampusNegotiationScenario',
    browserBoundary: 'Synthetic Creative Intent response only; confirm protected bindings and select Option B in the UI.',
    expected: Object.freeze({ resolution: 'OPTIMIZE_UNPROTECTED_ONLY', requestedTargetMs: 30_000, minimumFeasibleMs: 38_000, targetGapMs: 8_000, planningState: 'READY_TO_PLAN' }),
  }),
  executionScenario: Object.freeze({
    source: 'app/test-support/editor-proposal-review-fixture.ts:createMedicalReviewInput',
    planner: 'generateEditorProposal',
    evidence: 'Existing local-clip semantic segments, evidence frames, captions, and audio rhythm samples.',
  }),
  repairScenario: Object.freeze({
    source: 'app/test-support/editor-proposal-review-fixture.ts:createMedicalReviewInput',
    evaluator: 'evaluateEditorExecution',
    repairBuilder: 'createRepairProposalBundle',
    defect: 'IMMEDIATE_ASSET_REPEAT and RECENT_ASSET_REUSE on clip-1 from one immutable evidence snapshot.',
    restriction: 'No evidence transition or injected proposal, evaluator result, repair result, or canonical action.',
  }),
});

function generatedExecutionProposal(input) {
  const result = generateEditorProposal(input);
  assert.equal(result.ok, true, `Existing execution fixture failed production planning: ${result.status}`);
  assert.ok(result.bundle.proposalEntries.length >= 3);
  assert.ok(result.bundle.planEvidence.entries.every(entry => entry.matching
    && entry.matching.supportingSourceRanges.length > 0
    && entry.matching.evidenceFrameMs.length > 0));
  return result.bundle;
}

export function loadCampusScenarioEvidence() {
  const scenario = createCampusNegotiationScenario();
  assert.equal(scenario.report.status, 'FEASIBLE_WITH_TARGET_GAP');
  assert.ok(scenario.confirmedBindings.length >= 2);
  assert.equal(scenario.state.status, 'NEEDS_USER_DECISION');
  return scenario;
}

export function loadExecutionScenarioEvidence() {
  const input = createMedicalReviewInput();
  const constraintSet = createProtectedClipConstraintSet(input.project, 'clip-0', {
    allowDelete: false, allowTrim: false, allowMove: false, allowSpeedChange: false,
    allowAssetReplace: true, allowCaptionTextChange: false, allowTimingChange: false,
    allowSplit: false, allowTransformChange: false, allowAudioRangeChange: false,
  });
  const campus = createCampusNegotiationScenario();
  const conflict = campus.report.conflicts.find(item => item.type === 'DURATION_CONFLICT');
  assert.ok(conflict);
  const resolved = resolveConstraintConflictV1({
    state: campus.state, intent: campus.intent, project: campus.project,
    projectFingerprint: campus.projectFingerprint, confirmedBindings: campus.confirmedBindings,
    feasibilityReport: campus.report, conflictId: conflict.conflictId,
    selectedResolution: 'RELAX_TARGET_DURATION', createdAt: '2026-10-25T01:00:00.000Z',
  });
  assert.equal(resolved.state.status, 'READY_TO_PLAN');
  assert.ok(resolved.proposalContext);
  const constraintContext = {
    ...resolved.proposalContext,
    sourceIntentVersionId: constraintSet.intentVersionId,
    sourceConstraintSetId: constraintSet.constraintSetId,
    sourceConstraintFingerprint: constraintSet.constraintFingerprint,
  };
  const constrainedInput = { ...input, constraintSet, constraintContext };
  const proposal = generatedExecutionProposal(constrainedInput);
  const protectedClipIds = new Set(constraintSet.confirmedBindings.flatMap(binding => binding.bindingType === 'CLIP' ? [binding.clipId] : []));
  assert.deepEqual([...protectedClipIds], ['clip-0']);
  const mixed = createMedicalReviewedExecution();
  assert.equal(safeModificationCandidates(proposal, proposal.proposalEntries[2].proposalEntryId)[0].assetId, 'asset-ecg-alt');
  assert.ok(mixed.result.reviewedPlan.compiledPlan.canonicalPlan.actions.length >= 3);
  const localEvidenceCount = input.videoAnalyses.filter(analysis => analysis.analysisMethod === 'local-clip').length;
  assert.equal(localEvidenceCount, input.videoAnalyses.length);
  return Object.freeze({ input: constrainedInput, constraintSet, constraintContext, proposal, reviewedExecution: mixed.result, localEvidenceCount });
}

function createImmutableRepairEvidence() {
  const input = createImmutableRepetitionPlanningInput();
  const constraintSet = createConstraintSet({
    version: 1,
    projectId: input.project.id,
    intentVersionId: 'intent-v1-23e00005',
    validatedAgainstProjectFingerprint: createEditorProjectFingerprint(input.project),
    activeConstraints: [],
    confirmedBindings: [],
    resolutionIds: [],
  });
  assert.equal(hasEnforceableConstraintsV1(constraintSet), false);
  const constraintContext = {
    sourceIntentVersionId: constraintSet.intentVersionId,
    sourceConstraintSetId: constraintSet.constraintSetId,
    sourceConstraintFingerprint: constraintSet.constraintFingerprint,
    resolutionIds: constraintSet.resolutionIds,
    feasibilityReportId: 'feasibility-report-v1-h4b-empty',
    readiness: 'READY_TO_PLAN',
  };
  const proposal = generatedExecutionProposal({ ...input, constraintSet, constraintContext });
  let review = createHumanReviewState(proposal);
  for (const entry of proposal.proposalEntries) {
    review = reviewProposalEntry(proposal, review, { proposalEntryId: entry.proposalEntryId, decision: 'ACCEPT' });
  }
  const execution = executeReviewedProposal({ proposal, review, currentProject: proposal.trustedPreExecutionProject, executionUpdatedAt: '2026-10-25T04:00:00.000Z' });
  assert.ok(execution.execution);
  assert.notEqual(
    createEditorProjectFingerprint(execution.execution.postProject),
    constraintSet.validatedAgainstProjectFingerprint,
  );
  const repeatedSequence = execution.execution.postProject.tracks[0].clips.map(clip => clip.assetId);
  assert.deepEqual(repeatedSequence, ['asset-consultation', 'asset-consultation', 'asset-ecg', 'asset-treatment', 'asset-recovery']);
  const evaluation = evaluateEditorExecution({
    proposalBundle: proposal, humanReviewState: execution.reviewState, reviewedPlan: execution.reviewedPlan,
    executionResult: execution.execution, postProject: execution.execution.postProject,
    planEvidence: execution.planEvidence, videoSemanticEvidence: input.videoAnalyses,
    audioRhythmEvidence: input.rhythm,
  });
  const immediate = evaluation.defects.find(item => item.code === 'IMMEDIATE_ASSET_REPEAT' && item.clipId === 'clip-1');
  const recent = evaluation.defects.find(item => item.code === 'RECENT_ASSET_REUSE' && item.clipId === 'clip-1');
  assert.ok(immediate);
  assert.ok(recent);
  const repairProposal = createRepairProposalBundle({
    evaluation, proposal, humanReview: execution.reviewState, reviewedPlan: execution.reviewedPlan,
    execution: execution.execution, planEvidence: execution.planEvidence,
    currentProject: execution.execution.postProject, videoSemanticEvidence: input.videoAnalyses,
    audioRhythmEvidence: input.rhythm,
  });
  const eligible = repairProposal.entries.find(entry => entry.repairEligibility === 'ELIGIBLE');
  assert.equal(eligible?.proposedAction?.type, 'MATCH_ASSET_TO_SEGMENT');
  assert.equal(eligible?.proposedAction?.targetId, 'clip-1');
  assert.equal(eligible?.proposedAction?.assetId, 'asset-anatomy');
  const duplicate = repairProposal.entries.find(entry => entry.repairEligibility === 'DUPLICATE_TARGET_CONFLICT');
  assert.ok(duplicate);
  let repairReview = createRepairReviewState(repairProposal);
  repairReview = reviewRepairEntry(repairProposal, repairReview, { repairEntryId: eligible.repairEntryId, decision: 'ACCEPT' });
  assert.equal(repairReview.lifecycle, 'REPAIR_READY_TO_EXECUTE');
  let evaluationCalls = 0;
  const repairResult = executeReviewedRepairLoop({
    originalEvaluation: evaluation, repairProposal, repairReview,
    currentProject: execution.execution.postProject, executionUpdatedAt: '2026-10-25T05:00:00.000Z',
  }, { evaluate: evaluateInput => { evaluationCalls += 1; return evaluateEditorExecution(evaluateInput); } });
  assert.equal(evaluationCalls, 1);
  assert.equal(repairResult.reEvaluationCount, 1);
  assert.equal(repairResult.finalStatus, 'REPAIR_FINAL_PASS');
  assert.equal(repairResult.reEvaluation?.defects.length, 0);
  assert.equal(repairResult.repairExecution?.postProject.tracks[0].clips.find(clip => clip.id === 'clip-1')?.assetId, 'asset-anatomy');
  assert.equal(repairResult.history.entryCount, 1);
  const preRepairOtherClips = execution.execution.postProject.tracks.flatMap(track => track.clips).filter(clip => clip.id !== 'clip-1');
  const finalOtherClips = repairResult.finalProject.tracks.flatMap(track => track.clips).filter(clip => clip.id !== 'clip-1');
  assert.deepEqual(finalOtherClips, preRepairOtherClips);
  assert.deepEqual(repairResult.finalProject.captions, execution.execution.postProject.captions);
  assert.deepEqual(repairResult.finalProject.audioSelection, execution.execution.postProject.audioSelection);
  return Object.freeze({ input, constraintSet, constraintContext, proposal, execution, evaluation, defects: Object.freeze([immediate, recent]), repairProposal, eligible, duplicate, repairReview, repairResult, repeatedSequence: Object.freeze(repeatedSequence) });
}

export function loadRepairScenarioEvidence() {
  return createImmutableRepairEvidence();
}

export function loadCampusScenario() {
  return loadCampusScenarioEvidence();
}

export function loadExecutionScenario() {
  return createExecutionEditorFixtureV1();
}

export function loadRepairScenario() {
  return createImmutableRepetitionEditorFixtureV1();
}

export function auditR11EScenarioContracts() {
  const campusScenario = loadCampusScenarioEvidence();
  const executionScenario = loadExecutionScenarioEvidence();
  const repairScenario = loadRepairScenarioEvidence();
  return Object.freeze({
    campusScenario: Object.freeze({ source: R11E_SCENARIO_CONTRACT.campusScenario.source, verified: true }),
    executionScenario: Object.freeze({ source: R11E_SCENARIO_CONTRACT.executionScenario.source, entries: executionScenario.proposal.proposalEntries.length, actions: executionScenario.proposal.compiledPlan.canonicalPlan.actions.length, localEvidenceCount: executionScenario.localEvidenceCount, planningState: executionScenario.constraintContext.readiness, protectedClipIds: ['clip-0'], unprotectedEditableIntervals: 4, reviewDecisions: executionScenario.reviewedExecution.reviewState.entries.map(entry => entry.status), modifyAssetId: 'asset-ecg-alt' }),
    repairScenario: Object.freeze({ source: R11E_SCENARIO_CONTRACT.repairScenario.source, defectCodes: repairScenario.defects.map(defect => defect.code), repairEligibility: repairScenario.eligible.repairEligibility, repairActionType: repairScenario.eligible.proposedAction.type, repairClipId: repairScenario.eligible.proposedAction.targetId, repairAssetId: repairScenario.eligible.proposedAction.assetId, duplicateTargetHandling: repairScenario.duplicate.repairEligibility, humanReviewLifecycle: repairScenario.repairReview.lifecycle, repairExecutionStatus: repairScenario.repairResult.repairExecution?.status, protectedContentUnchanged: true, historyEntryCount: repairScenario.repairResult.history.entryCount, reEvaluationCount: repairScenario.repairResult.reEvaluationCount, remainingDefectCount: repairScenario.repairResult.reEvaluation?.defects.length, secondRepairRound: false, finalStatus: repairScenario.repairResult.finalStatus }),
    campusResolution: campusScenario.state.status,
  });
}
