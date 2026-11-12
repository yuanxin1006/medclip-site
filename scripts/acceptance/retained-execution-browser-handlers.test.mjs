import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateEditorExecution } from '../../app/editor-evaluator.ts';
import { createHumanReviewState, reviewProposalEntry } from '../../app/editor-proposal-review.ts';
import { createMedicalReviewedExecution } from '../../app/test-support/editor-proposal-review-fixture.ts';
import { createExecutionEditorFixtureV1, createImmutableRepetitionEditorFixtureV1 } from './editor-input-fixtures.mjs';
import { acceptanceEditorFixtureInitScript } from './medclip-browser-harness.mjs';
import {
  RETAINED_EXECUTION_REVIEW_DECISIONS,
  assertRetainedUndoRedoComparison,
  projectRetainedExecutionState,
  readRetainedExecutionState,
  resolveRetainedExecutionFixture,
  validateRetainedReviewedPlan,
  verifyRetainedExecutionFingerprintSupport,
  verifyRetainedExecutionStaleSupport,
} from './retained-execution-browser-handlers.mjs';
import { loadExecutionScenarioEvidence } from './v24abc-r11e-scenario-contract.mjs';

function executedScenario() {
  const scenario = createMedicalReviewedExecution();
  const evaluation = evaluateEditorExecution({
    proposalBundle: scenario.proposal,
    humanReviewState: scenario.result.reviewState,
    reviewedPlan: scenario.result.reviewedPlan,
    executionResult: scenario.result.execution,
    postProject: scenario.result.execution.postProject,
    planEvidence: scenario.result.planEvidence,
    videoSemanticEvidence: scenario.input.videoAnalyses,
    audioRhythmEvidence: scenario.input.rhythm,
  });
  return { ...scenario, evaluation };
}

test('execution gate fixture is validated, identity-preserving, and resume-from compatible', () => {
  const fixture = createExecutionEditorFixtureV1();
  assert.deepEqual(resolveRetainedExecutionFixture({ editorInputFixture: fixture }), fixture);
  assert.throws(() => resolveRetainedExecutionFixture({}), /editorInputFixture is invalid/);
  assert.throws(
    () => resolveRetainedExecutionFixture({ editorInputFixture: createImmutableRepetitionEditorFixtureV1() }),
    /expected medical-review-execution-v1/,
  );
});

test('fixture init is request-scoped and does not leak across retained phase routes', () => {
  const priorWindow = globalThis.window;
  const writes = [];
  try {
    globalThis.window = {
      location: { search: '?acceptanceInput=1&fixture=medical-review-execution-v1' },
      localStorage: { setItem: (...args) => writes.push(args) },
    };
    acceptanceEditorFixtureInitScript({
      fixtureId: 'medical-review-execution-v1', storageKey: 'project',
      project: { id: 'execution' }, inputEvidence: { version: 1 },
    });
    assert.equal(writes.length, 1);
    assert.deepEqual(globalThis.window.__MEDCLIP_ACCEPTANCE_INPUT_EVIDENCE__, { version: 1 });
    globalThis.window.location.search = '?acceptanceInput=1&fixture=medical-adjacent-repetition-v1';
    acceptanceEditorFixtureInitScript({
      fixtureId: 'medical-review-execution-v1', storageKey: 'project',
      project: { id: 'wrong-phase' }, inputEvidence: { version: 2 },
    });
    assert.equal(writes.length, 1);
    assert.deepEqual(globalThis.window.__MEDCLIP_ACCEPTANCE_INPUT_EVIDENCE__, { version: 1 });
  } finally {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
});

test('canonical pre-execution validation retains ACCEPT, excludes REJECT, and canonicalizes MODIFY', () => {
  const scenario = executedScenario();
  const result = validateRetainedReviewedPlan({
    proposal: scenario.proposal,
    review: { ...scenario.result.reviewState, lifecycle: 'READY_TO_EXECUTE' },
    currentProject: scenario.proposal.trustedPreExecutionProject,
  });
  assert.equal(result.canonicalValidator, 'PASS');
  assert.equal(result.hardConstraintValidator, 'PASS');
  assert.deepEqual(result.rejectedIntervalIds, ['interval-treatment']);
  assert.equal(result.modifiedActions[0].originalAssetId, 'asset-ecg');
  assert.equal(result.modifiedActions[0].selectedAssetId, 'asset-ecg-alt');
  assert.equal(result.modifiedActions[0].actionAssetId, 'asset-ecg-alt');
  assert.equal(result.reviewedEntries.find(item => item.intervalId === 'interval-treatment').action, null);
  assert.equal(result.reviewedEntries.find(item => item.intervalId === 'interval-ecg').action.assetId, 'asset-ecg-alt');
  assert.ok(result.executableActionCount >= 1);
});

test('canonical preflight uses the retained hard-constraint context without bypassing validation', () => {
  const scenario = loadExecutionScenarioEvidence();
  let review = createHumanReviewState(scenario.proposal);
  for (const expected of RETAINED_EXECUTION_REVIEW_DECISIONS) {
    const entry = scenario.proposal.proposalEntries.find(item => item.intervalId === expected.intervalId);
    assert.ok(entry);
    review = reviewProposalEntry(scenario.proposal, review, {
      proposalEntryId: entry.proposalEntryId,
      decision: expected.decision,
      ...(expected.selectedAssetId ? { selectedAssetId: expected.selectedAssetId } : {}),
    });
  }
  const result = validateRetainedReviewedPlan({
    proposal: scenario.proposal,
    review,
    currentProject: scenario.proposal.trustedPreExecutionProject,
  });
  assert.equal(result.hardConstraintValidator, 'PASS');
  assert.ok(result.executableActionCount >= 1);
  assert.ok(scenario.proposal.constraintSet.activeConstraints.length >= 1);
});

test('execution evidence projection is allowlisted, JSON-safe, and distinguishes all review decisions', () => {
  const scenario = executedScenario();
  const snapshot = projectRetainedExecutionState({
    proposal: scenario.proposal,
    review: null,
    evidence: scenario.result.planEvidence,
    evaluation: scenario.evaluation,
  });
  assert.equal(snapshot.lifecycleStatus, 'EXECUTED');
  assert.equal(snapshot.execution.failedCount, 0);
  assert.equal(snapshot.evaluator.hardConstraintCompliance, 'PASS');
  assert.equal(snapshot.evaluator.rejectedCount, 1);
  assert.ok(snapshot.evaluator.realizedActionCount >= 1);
  const rejected = snapshot.entries.find(item => item.intervalId === 'interval-treatment');
  assert.equal(rejected.executionDisposition, 'NOT_EXECUTED_USER_REJECTED');
  assert.equal(rejected.executedAction, undefined);
  const modified = snapshot.entries.find(item => item.intervalId === 'interval-ecg');
  assert.equal(modified.executedAction.assetId, 'asset-ecg-alt');
  assert.equal(modified.beforeAfter.assetAfter, 'asset-ecg-alt');
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['trustedPreExecutionProject', 'constraintSet', 'sessionDecisionLedger', 'credentials', 'tokens']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(JSON.parse(serialized), snapshot);
});

test('browser reader projects mounted state and fails closed when structured state is missing', async () => {
  const scenario = executedScenario();
  const page = { async evaluate() {
    return { proposal: scenario.proposal, review: null, evidence: scenario.result.planEvidence, evaluation: scenario.evaluation };
  } };
  assert.equal((await readRetainedExecutionState(page)).lifecycleStatus, 'EXECUTED');
  await assert.rejects(readRetainedExecutionState({ evaluate: async () => null }), /structured state is unavailable/);
});

test('fingerprint, stale rejection, and exact single-entry Undo/Redo contracts fail closed', () => {
  const scenario = executedScenario();
  assert.deepEqual(verifyRetainedExecutionFingerprintSupport(scenario.input.project), {
    equivalentClone: true, materialMutationChangesFingerprint: true,
  });
  assert.deepEqual(verifyRetainedExecutionStaleSupport({
    proposal: scenario.proposal,
    review: { ...scenario.result.reviewState, lifecycle: 'READY_TO_EXECUTE' },
    currentProject: scenario.proposal.trustedPreExecutionProject,
  }), { staleProposalRejected: true });
  assert.deepEqual(assertRetainedUndoRedoComparison({
    preProjectFingerprint: 'pre', executedProjectFingerprint: 'post',
    preProjectSnapshot: { title: 'pre' }, executedProjectSnapshot: { title: 'post' },
    undoProjectFingerprint: 'pre', redoProjectFingerprint: 'post',
    undoProjectSnapshot: { title: 'pre' }, redoProjectSnapshot: { title: 'post' },
    undoDisabledAfterUndo: true, redoDisabledAfterRedo: true,
  }), { exactUndo: true, exactRedo: true, logicalHistoryEntryCount: 1 });
  assert.throws(() => assertRetainedUndoRedoComparison({
    preProjectFingerprint: 'pre', executedProjectFingerprint: 'post',
    preProjectSnapshot: { title: 'pre' }, executedProjectSnapshot: { title: 'post' },
    undoProjectFingerprint: 'wrong', redoProjectFingerprint: 'post',
    undoProjectSnapshot: { title: 'pre' }, redoProjectSnapshot: { title: 'post' },
    undoDisabledAfterUndo: true, redoDisabledAfterRedo: true,
  }));
});

test('retained review matrix and H4B reuse one auth/planning implementation without fragile nth selectors', async () => {
  assert.deepEqual(RETAINED_EXECUTION_REVIEW_DECISIONS.map(item => item.decision),
    ['ACCEPT', 'ACCEPT', 'MODIFY', 'REJECT', 'ACCEPT']);
  assert.equal(RETAINED_EXECUTION_REVIEW_DECISIONS[2].selectedAssetId, 'asset-ecg-alt');
  const h4b = await readFile(new URL('./v24abc-r11e-h4b-smoke.mjs', import.meta.url), 'utf8');
  assert.match(h4b, /authenticateAcceptanceBrowserToEditor/);
  assert.match(h4b, /beginRetainedExecutionPlanning/);
  assert.doesNotMatch(h4b, /form\.auth-form input\[type="email"\]/);
  assert.doesNotMatch(h4b, /beginProductionPlanning|form\.auth-form/);
});
