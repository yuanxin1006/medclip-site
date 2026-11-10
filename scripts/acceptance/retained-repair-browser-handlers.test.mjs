import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createProtectedClipConstraintSet } from '../../app/test-support/editor-constraint-enforcement-fixture.ts';
import {
  buildReviewedRepairPlan, createRepairProposalBundle, createRepairReviewState,
  EditorRepairError, executeReviewedRepairLoop, reviewRepairEntry,
} from '../../app/editor-repair.ts';
import {
  createExecutionEditorFixtureV1, createImmutableRepetitionEditorFixtureV1,
} from './editor-input-fixtures.mjs';
import { canonicalProjectFingerprint } from './medclip-browser-harness.mjs';
import {
  RETAINED_REPAIR_ASSET_SEQUENCE,
  RETAINED_REPAIR_EXPECTED_ACTION,
  RETAINED_REPAIR_EXPECTED_DEFECT_CODES,
  applyRetainedRepairHumanReview,
  executeRetainedRepair,
  exerciseRetainedRepairUndoRedo,
  projectRetainedRepairState,
  resolveRetainedRepairFixture,
  validateRetainedRepairPlan,
  verifyRetainedRepairRoundPolicy,
} from './retained-repair-browser-handlers.mjs';
import {
  RETAINED_REDO_ACCESSIBLE_NAME, RETAINED_TIMELINE_EDITOR_SELECTOR, RETAINED_UNDO_ACCESSIBLE_NAME,
} from './retained-execution-browser-handlers.mjs';
import { loadRepairScenarioEvidence } from './v24abc-r11e-scenario-contract.mjs';

function repairInput(evidence, extra = {}) {
  return {
    evaluation: evidence.evaluation,
    proposal: evidence.proposal,
    humanReview: evidence.execution.reviewState,
    reviewedPlan: evidence.execution.reviewedPlan,
    execution: evidence.execution.execution,
    planEvidence: evidence.execution.planEvidence,
    currentProject: evidence.execution.execution.postProject,
    videoSemanticEvidence: evidence.input.videoAnalyses,
    audioRhythmEvidence: evidence.input.rhythm,
    ...extra,
  };
}

function mountedState(evidence, { reviewed = true, executed = false } = {}) {
  return {
    proposal: evidence.repairProposal,
    review: executed ? evidence.repairResult.repairReview
      : reviewed ? evidence.repairReview : createRepairReviewState(evidence.repairProposal),
    result: executed ? evidence.repairResult : null,
    evaluation: executed ? evidence.repairResult.reEvaluation : evidence.evaluation,
  };
}

test('repair fixture is validated, phase-specific, and direct-resume compatible', () => {
  const fixture = createImmutableRepetitionEditorFixtureV1();
  assert.deepEqual(resolveRetainedRepairFixture({ editorInputFixture: fixture }), fixture);
  assert.throws(() => resolveRetainedRepairFixture({}), /editorInputFixture is invalid/);
  assert.throws(
    () => resolveRetainedRepairFixture({ editorInputFixture: createExecutionEditorFixtureV1() }),
    /expected medical-adjacent-repetition-v1/,
  );
});

test('natural production repair evidence preserves immutable sequence, defects, action, and duplicate conflict', () => {
  const evidence = loadRepairScenarioEvidence();
  assert.deepEqual(evidence.repeatedSequence, RETAINED_REPAIR_ASSET_SEQUENCE);
  assert.deepEqual(evidence.defects.map(item => item.code), RETAINED_REPAIR_EXPECTED_DEFECT_CODES);
  assert.deepEqual({
    type: evidence.eligible.proposedAction.type,
    targetId: evidence.eligible.proposedAction.targetId,
    assetId: evidence.eligible.proposedAction.assetId,
  }, RETAINED_REPAIR_EXPECTED_ACTION);
  assert.equal(evidence.duplicate.repairEligibility, 'DUPLICATE_TARGET_CONFLICT');
  assert.equal(evidence.repairProposal.providerCalls, 0);
  assert.equal(evidence.repairProposal.networkCalls, 0);
});

test('bounded repair projection exposes Human Review, one re-evaluation, final pass, and no second round', () => {
  const evidence = loadRepairScenarioEvidence();
  const snapshot = projectRetainedRepairState(mountedState(evidence, { executed: true }));
  assert.equal(snapshot.repairRound, 1);
  assert.equal(snapshot.reviewLifecycle, 'REPAIR_EXECUTED');
  assert.equal(snapshot.eligibleCount, 1);
  assert.equal(snapshot.duplicateTargetConflictCount, 1);
  assert.deepEqual(snapshot.result, {
    finalStatus: 'REPAIR_FINAL_PASS',
    reEvaluationCount: 1,
    remainingDefectCount: 0,
    repairExecutionPresent: true,
    appliedActionCount: 1,
    failedActionCount: 0,
    historyShouldRecord: true,
    historyEntryCount: 1,
    rollbackPerformed: false,
    secondRepairPlanCreated: false,
    secondRepairExecution: false,
    repairBudgetExhausted: true,
  });
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['trustedPreRepairProject', 'undoProject', 'redoProject', 'videoSemanticEvidence', 'credentials', 'tokens']) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(JSON.parse(serialized), snapshot);
});

test('repair Human Review uses exact structured entry identity and user provenance', async () => {
  const evidence = loadRepairScenarioEvidence();
  const state = mountedState(evidence, { reviewed: false });
  let clicks = 0;
  const accept = {
    async count() { return 1; },
    async click() {
      clicks += 1;
      state.review = reviewRepairEntry(state.proposal, state.review, {
        repairEntryId: evidence.eligible.repairEntryId, decision: 'ACCEPT',
      });
    },
  };
  const row = {
    async count() { return 1; },
    getByRole(_role, options) {
      assert.deepEqual(options, { name: '\u63a5\u53d7\u4fee\u590d', exact: true });
      return accept;
    },
  };
  const page = {
    async evaluate() { return structuredClone(state); },
    locator(selector) {
      assert.equal(selector, '.editor-repair-entry.eligibility-eligible');
      return row;
    },
    async waitForFunction(_predicate, expected) {
      assert.equal(expected.acceptedRepairEntryId, evidence.eligible.repairEntryId);
      assert.equal(state.review.lifecycle, 'REPAIR_READY_TO_EXECUTE');
    },
  };
  const result = await applyRetainedRepairHumanReview({ page });
  assert.equal(clicks, 1);
  assert.deepEqual(result, {
    reviewLifecycle: 'REPAIR_READY_TO_EXECUTE',
    decision: 'ACCEPT',
    provenance: 'REPAIR_USER_ACCEPTED',
    reviewedAction: RETAINED_REPAIR_EXPECTED_ACTION,
    autoApproval: false,
    reviewBypass: false,
  });
});

test('canonical repair preflight uses production parser and allows the empty non-enforcing context', () => {
  const evidence = loadRepairScenarioEvidence();
  const result = validateRetainedRepairPlan({
    proposal: evidence.repairProposal,
    review: evidence.repairReview,
    currentProject: evidence.execution.execution.postProject,
  });
  assert.deepEqual(result, {
    canonicalValidator: 'PASS',
    hardConstraintValidator: 'PASS',
    protectedViolationCount: 0,
    reviewedPlanStatus: 'REPAIR_READY_TO_EXECUTE',
    executableActionCount: 1,
    reviewedAction: RETAINED_REPAIR_EXPECTED_ACTION,
    provenance: 'REPAIR_USER_ACCEPTED',
  });
  assert.equal(evidence.constraintSet.activeConstraints.length, 0);
  assert.equal(evidence.constraintSet.confirmedBindings.length, 0);
});

test('protected repair target and stale enforcing context fail closed with HARD_CONSTRAINT_BLOCKED', () => {
  const evidence = loadRepairScenarioEvidence();
  const currentProject = evidence.execution.execution.postProject;
  const protectedSet = createProtectedClipConstraintSet(currentProject, 'clip-1');
  const withConstraint = constraintSet => ({
    ...evidence.proposal,
    constraintSet,
    evidenceMetadata: {
      ...evidence.proposal.evidenceMetadata,
      constraintContext: {
        sourceIntentVersionId: constraintSet.intentVersionId,
        sourceConstraintSetId: constraintSet.constraintSetId,
        sourceConstraintFingerprint: constraintSet.constraintFingerprint,
        resolutionIds: constraintSet.resolutionIds,
        feasibilityReportId: 'feasibility-report-v1-retained-repair-constraint',
        readiness: 'READY_TO_PLAN',
      },
    },
  });
  const protectedBundle = createRepairProposalBundle(repairInput(evidence, {
    proposal: withConstraint(protectedSet), constraintSet: protectedSet,
  }));
  const protectedEntry = protectedBundle.entries.find(item => item.clipId === 'clip-1');
  assert.equal(protectedEntry.repairEligibility, 'HARD_CONSTRAINT_BLOCKED');
  assert.equal(protectedEntry.proposedAction, undefined);
  assert.equal(protectedBundle.status, 'REPAIR_NO_ACTIONS');
  const protectedReview = createRepairReviewState(protectedBundle);
  assert.equal(protectedReview.lifecycle, 'REPAIR_NO_ACTIONS');
  const blockedResult = executeReviewedRepairLoop({
    originalEvaluation: evidence.evaluation,
    repairProposal: protectedBundle,
    repairReview: protectedReview,
    currentProject,
    executionUpdatedAt: '2026-10-29T15:00:00.000Z',
  });
  assert.equal(blockedResult.finalStatus, 'REPAIR_NO_ACTIONS');
  assert.equal(blockedResult.repairExecution, undefined);
  assert.equal(blockedResult.history.shouldRecord, false);
  assert.equal(blockedResult.history.entryCount, 0);
  assert.deepEqual(blockedResult.finalProject, currentProject);

  const staleSet = createProtectedClipConstraintSet(evidence.proposal.trustedPreExecutionProject, 'clip-4');
  const staleProposal = withConstraint(staleSet);
  const staleBundle = createRepairProposalBundle(repairInput(evidence, { proposal: staleProposal }));
  assert.ok(staleBundle.entries.some(item => item.repairEligibility === 'HARD_CONSTRAINT_BLOCKED'));
  assert.equal(staleBundle.entries.some(item => item.repairEligibility === 'ELIGIBLE'), false);
});

test('reviewed repair becomes STALE_REPAIR after an authoritative project mutation', () => {
  const evidence = loadRepairScenarioEvidence();
  const staleProject = structuredClone(evidence.execution.execution.postProject);
  staleProject.title = `${staleProject.title} stale`;
  assert.throws(
    () => buildReviewedRepairPlan(evidence.repairProposal, evidence.repairReview, staleProject),
    error => error instanceof EditorRepairError && error.code === 'STALE_REPAIR',
  );
});

test('one-round policy rejects tuple replay and repair round two', () => {
  const evidence = loadRepairScenarioEvidence();
  assert.deepEqual(verifyRetainedRepairRoundPolicy(repairInput(evidence), evidence.repairProposal), {
    maxRepairRounds: 1,
    replayEligibility: 'ALREADY_ATTEMPTED',
    secondRoundCode: 'INVALID_REPAIR_ROUND',
    antiOscillation: true,
  });
});

test('browser execution handler uses actual repair result and returns bounded evidence', async () => {
  const evidence = loadRepairScenarioEvidence();
  const state = mountedState(evidence);
  let project = structuredClone(evidence.execution.execution.postProject);
  let clicked = 0;
  const button = {
    async count() { return 1; },
    async isEnabled() { return true; },
    async click() {
      clicked += 1;
      state.review = evidence.repairResult.repairReview;
      state.result = evidence.repairResult;
      state.evaluation = evidence.repairResult.reEvaluation;
      project = structuredClone(evidence.repairResult.finalProject);
    },
  };
  const page = {
    async evaluate(callback, argument) {
      if (callback.name === 'inspectCurrentMountedRepairState') return structuredClone(state);
      if (typeof argument === 'string') return structuredClone(project);
      throw new Error(`unexpected evaluate callback: ${callback.name}`);
    },
    locator(selector) {
      assert.equal(selector, '.editor-repair-review-footer');
      return { getByRole(_role, options) {
        assert.deepEqual(options, { name: '\u6267\u884c\u5df2\u6279\u51c6\u4fee\u590d', exact: true });
        return button;
      } };
    },
    async waitForFunction(_predicate, expected) {
      assert.equal(expected.finalStatus, 'REPAIR_FINAL_PASS');
      assert.equal(state.result.finalStatus, 'REPAIR_FINAL_PASS');
    },
  };
  const result = await executeRetainedRepair({ page });
  assert.equal(clicked, 1);
  assert.equal(result.finalStatus, 'REPAIR_FINAL_PASS');
  assert.equal(result.reEvaluationCount, 1);
  assert.equal(result.remainingDefectCount, 0);
  assert.equal(result.appliedActionCount, 1);
  assert.equal(result.failedActionCount, 0);
  assert.equal(result.repairRoundCount, 1);
  assert.equal(result.secondRepairPlanCreated, false);
  assert.equal(result.secondRepairExecution, false);
  assert.equal(result.antiOscillation, true);
  assert.equal(result.preRepairFingerprint, canonicalProjectFingerprint(evidence.execution.execution.postProject));
  assert.equal(result.postRepairFingerprint, canonicalProjectFingerprint(evidence.repairResult.finalProject));
  assert.equal(JSON.stringify(result).includes('undoProject'), false);
});

test('repair Undo and Redo use the shared real-control contract and restore exact repair PRE/POST', async () => {
  const evidence = loadRepairScenarioEvidence();
  const state = mountedState(evidence, { executed: true });
  const initialPre = structuredClone(evidence.execution.history.undoProject);
  const pre = structuredClone(evidence.repairResult.history.undoProject);
  const post = structuredClone(evidence.repairResult.history.redoProject);
  let project = structuredClone(post);
  let editorOpen = false;
  let history = [];
  let future = [];
  let renderVersion = 0;
  const resolutions = { Undo: 0, Redo: 0 };
  const control = (label, name) => {
    const version = renderVersion;
    resolutions[label] += 1;
    const disabled = () => label === 'Undo' ? history.length === 0 : future.length === 0;
    return {
      async count() { return editorOpen ? 1 : 0; },
      async isVisible() { return editorOpen; },
      async isEnabled() { assert.equal(version, renderVersion); return editorOpen && !disabled(); },
      async isDisabled() { assert.equal(version, renderVersion); return !editorOpen || disabled(); },
      async click() {
        assert.equal(version, renderVersion);
        if (name === RETAINED_UNDO_ACCESSIBLE_NAME) {
          future = [structuredClone(project)];
          project = history.pop();
        } else {
          history = [structuredClone(project)];
          project = future.pop();
        }
        renderVersion += 1;
      },
    };
  };
  const editor = {
    async count() { return editorOpen ? 1 : 0; },
    async isVisible() { return editorOpen; },
    locator(selector) {
      assert.equal(selector, '.editor-toolbar');
      return { getByRole(_role, { name }) {
        return name === RETAINED_UNDO_ACCESSIBLE_NAME ? control('Undo', name) : control('Redo', name);
      } };
    },
    async waitFor() { assert.equal(editorOpen, true); },
  };
  const open = {
    async count() { return editorOpen ? 0 : 1; },
    async isVisible() { return !editorOpen; },
    async isEnabled() { return !editorOpen; },
    async click() {
      editorOpen = true;
      history = [structuredClone(initialPre), structuredClone(pre)];
      future = [];
      renderVersion += 1;
    },
  };
  const page = {
    async evaluate(callback, argument) {
      if (callback.name === 'inspectCurrentMountedRepairState') return structuredClone(state);
      if (typeof argument === 'string') return structuredClone(project);
      throw new Error(`unexpected evaluate callback: ${callback.name}`);
    },
    locator(selector) {
      if (selector === RETAINED_TIMELINE_EDITOR_SELECTOR) return editor;
      if (selector === 'button.continue-edit-button') return open;
      throw new Error(`unexpected selector: ${selector}`);
    },
    async waitForFunction(_predicate, expected) {
      if (Object.hasOwn(expected, 'fingerprint')) {
        assert.equal(canonicalProjectFingerprint(project), expected.fingerprint);
        return;
      }
      const label = expected.name === RETAINED_UNDO_ACCESSIBLE_NAME ? 'Undo' : 'Redo';
      const disabled = label === 'Undo' ? history.length === 0 : future.length === 0;
      assert.equal(disabled, expected.expectedDisabled);
    },
  };
  const result = await exerciseRetainedRepairUndoRedo({ page });
  assert.equal(result.exactUndo, true);
  assert.equal(result.exactRedo, true);
  assert.equal(result.preRepairFingerprint, canonicalProjectFingerprint(pre));
  assert.equal(result.postRepairFingerprint, canonicalProjectFingerprint(post));
  assert.deepEqual(project, post);
  assert.deepEqual(resolutions, { Undo: 2, Redo: 3 });
});

test('retained repair module is importable by R11E and contains no auth, global phase, fixed sleep, or direct action injection', async () => {
  const [source, h4b] = await Promise.all([
    readFile(new URL('./retained-repair-browser-handlers.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./v24abc-r11e-h4b-smoke.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /transitionAcceptanceEditorFixture/);
  assert.match(source, /beginRetainedExecutionPlanning/);
  assert.match(source, /exerciseRetainedExecutionUndoRedo/);
  assert.doesNotMatch(source, /auth-form|authenticateAcceptanceBrowserToEditor|currentPhase|waitForTimeout|setTimeout|sleep\s*\(/);
  assert.doesNotMatch(source, /executeCompiledNarrativeActionPlan|type:\s*['"]MATCH_ASSET_TO_SEGMENT['"].*execute/);
  assert.doesNotMatch(source, /\.nth\s*\(/);
  assert.match(h4b, /beginRetainedRepairPlanning/);
  assert.match(h4b, /applyRetainedRepairHumanReview/);
  assert.match(h4b, /preflightRetainedRepair/);
  assert.match(h4b, /executeRetainedRepair/);
  assert.match(h4b, /evaluateRetainedRepairResult/);
  assert.doesNotMatch(h4b, /editor-repair-entry|editor-repair-review-footer|\.nth\s*\(|\.first\s*\(/);
});
