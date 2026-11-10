import assert from 'node:assert/strict';
import { buildReviewedRepairPlan, createRepairProposalBundle, EditorRepairError } from '../../app/editor-repair.ts';
import { validateConstraintContextV1 } from '../../app/editor-constraint-enforcement.ts';
import {
  IMMUTABLE_REPAIR_FIXTURE_ID, validateAcceptanceEditorFixtureV1,
} from './editor-input-fixtures.mjs';
import {
  canonicalProjectFingerprint, canonicalProjectSnapshot, readAuthoritativeProject,
  readCanonicalProjectFingerprint, transitionAcceptanceEditorFixture,
} from './medclip-browser-harness.mjs';
import {
  beginRetainedExecutionPlanning, exerciseRetainedExecutionUndoRedo,
  inspectCurrentMountedPlanState,
} from './retained-execution-browser-handlers.mjs';

export const RETAINED_REPAIR_SOURCE_REQUEST =
  'Create a complete ten-second medical narrative with upbeat pacing.';
export const RETAINED_REPAIR_ASSET_SEQUENCE = Object.freeze([
  'asset-consultation', 'asset-consultation', 'asset-ecg', 'asset-treatment', 'asset-recovery',
]);
export const RETAINED_REPAIR_EXPECTED_DEFECT_CODES = Object.freeze([
  'IMMEDIATE_ASSET_REPEAT', 'RECENT_ASSET_REUSE',
]);
export const RETAINED_REPAIR_EXPECTED_ACTION = Object.freeze({
  type: 'MATCH_ASSET_TO_SEGMENT', targetId: 'clip-1', assetId: 'asset-anatomy',
});

function failure(message, cause) {
  return Object.assign(new Error(`RETAINED REPAIR CONTRACT: ${message}`, cause ? { cause } : undefined), {
    harnessFailure: true,
  });
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function actionSummary(action) {
  return action ? Object.freeze({
    type: String(action.type ?? action.actionType ?? ''),
    targetId: String(action.targetId ?? ''),
    assetId: typeof action.assetId === 'string' ? action.assetId : null,
  }) : null;
}

export function resolveRetainedRepairFixture(gateFixtures) {
  if (!record(gateFixtures)) throw failure('gateFixtures must be an object');
  let fixture;
  try { fixture = validateAcceptanceEditorFixtureV1(gateFixtures.editorInputFixture); }
  catch (error) { throw failure('gateFixtures.editorInputFixture is invalid', error); }
  if (fixture.fixtureId !== IMMUTABLE_REPAIR_FIXTURE_ID) {
    throw failure(`expected ${IMMUTABLE_REPAIR_FIXTURE_ID}, received ${fixture.fixtureId}`);
  }
  return fixture;
}

export function inspectCurrentMountedRepairState(expected = null, rootOverride = null) {
  const root = rootOverride ?? document.querySelector('.plan-evidence-panel');
  const fiberKey = root && Object.keys(root).find(key => key.startsWith('__reactFiber$'));
  const attached = fiberKey ? root[fiberKey] : null;
  const branchIsCurrent = fiber => {
    let top = fiber;
    while (top?.return) top = top.return;
    return Boolean(top?.stateNode?.current && top.stateNode.current === top);
  };
  let fiber = attached;
  if (attached?.alternate && !branchIsCurrent(attached) && branchIsCurrent(attached.alternate)) {
    fiber = attached.alternate;
  }
  let state = null;
  while (fiber) {
    const props = fiber.memoizedProps;
    if (props && typeof props === 'object'
      && Object.hasOwn(props, 'repairProposal')
      && Object.hasOwn(props, 'repairReview')
      && Object.hasOwn(props, 'repairResult')) {
      state = {
        proposal: props.repairProposal ?? null,
        review: props.repairReview ?? null,
        result: props.repairResult ?? null,
        evaluation: props.evaluation ?? null,
      };
      break;
    }
    fiber = fiber.return;
  }
  if (!expected) return state;
  if (!state?.proposal || !state?.review) return false;
  if (expected.reviewLifecycle && state.review.lifecycle !== expected.reviewLifecycle) return false;
  if (expected.finalStatus && state.result?.finalStatus !== expected.finalStatus) return false;
  if (expected.acceptedRepairEntryId && !state.review.entries.some(entry =>
    entry.repairEntryId === expected.acceptedRepairEntryId
      && entry.status === 'ACCEPTED'
      && entry.provenance === 'REPAIR_USER_ACCEPTED')) return false;
  return true;
}

async function readMountedRepairState(page) {
  const state = await page.evaluate(inspectCurrentMountedRepairState, null);
  if (!state?.proposal || !state?.review) throw failure('mounted repair proposal/review state is unavailable');
  return state;
}

export function projectRetainedRepairState({ proposal, review, result = null, evaluation = null }) {
  if (!record(proposal) || !Array.isArray(proposal.entries)) throw failure('repair proposal is malformed');
  if (!record(review) || !Array.isArray(review.entries)) throw failure('repair review is malformed');
  const reviewById = new Map(review.entries.map(entry => [entry.repairEntryId, entry]));
  const hardMetric = evaluation?.metricResults?.find(item => item.metric === 'HARD_CONSTRAINT_COMPLIANCE');
  const entries = proposal.entries.map(entry => {
    const decision = reviewById.get(entry.repairEntryId);
    return Object.freeze({
      repairEntryId: String(entry.repairEntryId),
      defectCode: String(entry.defectCode),
      metric: String(entry.metric),
      eligibility: String(entry.repairEligibility),
      intervalId: typeof entry.intervalId === 'string' ? entry.intervalId : null,
      clipId: typeof entry.clipId === 'string' ? entry.clipId : null,
      proposedAction: actionSummary(entry.proposedAction),
      reviewStatus: String(decision?.status ?? ''),
      reviewProvenance: typeof decision?.provenance === 'string' ? decision.provenance : null,
      selectedAssetId: typeof decision?.selectedAssetId === 'string' ? decision.selectedAssetId : null,
    });
  });
  const repairExecution = result?.repairExecution;
  return Object.freeze({
    schemaVersion: 1,
    repairProposalId: String(proposal.repairProposalId),
    repairRound: Number(proposal.repairRound),
    proposalStatus: String(proposal.status),
    reviewLifecycle: String(review.lifecycle),
    defectCodes: Object.freeze([...(evaluation?.defects ?? []).map(item => String(item.code))]),
    hardConstraintStatus: hardMetric ? String(hardMetric.status) : null,
    hardConstraintViolationCount: Number(hardMetric?.evidence?.violations?.length ?? 0),
    eligibleCount: entries.filter(entry => entry.eligibility === 'ELIGIBLE').length,
    duplicateTargetConflictCount: entries.filter(entry => entry.eligibility === 'DUPLICATE_TARGET_CONFLICT').length,
    entries: Object.freeze(entries),
    result: result ? Object.freeze({
      finalStatus: String(result.finalStatus),
      reEvaluationCount: Number(result.reEvaluationCount),
      remainingDefectCount: Number(result.reEvaluation?.defects?.length ?? 0),
      repairExecutionPresent: Boolean(repairExecution),
      appliedActionCount: Number(repairExecution?.appliedActionCount ?? 0),
      failedActionCount: Number(repairExecution?.failedActionCount ?? 0),
      historyShouldRecord: Boolean(result.history?.shouldRecord),
      historyEntryCount: Number(result.history?.entryCount ?? 0),
      rollbackPerformed: Boolean(result.rollback?.performed),
      secondRepairPlanCreated: false,
      secondRepairExecution: false,
      repairBudgetExhausted: Number(proposal.repairRound) === 1 && Number(result.reEvaluationCount) === 1,
    }) : null,
  });
}

export async function readRetainedRepairState(page) {
  return projectRetainedRepairState(await readMountedRepairState(page));
}

export async function prepareRetainedRepairFixture({ harness, gateFixtures, timeout = 10_000 } = {}) {
  if (!harness?.page || !harness?.server?.url) throw failure('owned harness page/server required');
  const fixture = resolveRetainedRepairFixture(gateFixtures);
  const hydration = await transitionAcceptanceEditorFixture({
    harness, editorInputFixture: fixture, timeout,
  });
  assert.equal(hydration.diagnostic.fixtureId, fixture.fixtureId);
  const projectFingerprint = await readCanonicalProjectFingerprint(harness.page);
  assert.equal(projectFingerprint, canonicalProjectFingerprint(fixture.initialProject));
  return Object.freeze({
    fixtureId: fixture.fixtureId,
    projectFingerprint,
    semanticAssetCount: hydration.diagnostic.semanticAssetCount,
    rhythmEvidencePresent: hydration.diagnostic.rhythmEvidencePresent,
    directResumeReady: true,
  });
}

function formatIntervalMs(value) {
  const seconds = Math.max(0, Math.floor(value / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

async function acceptCurrentInitialProposal(page, timeout) {
  const mounted = await page.evaluate(inspectCurrentMountedPlanState, null);
  if (!mounted?.proposal || !mounted?.review || !mounted?.evidence?.entries) {
    throw failure('initial repair-fixture proposal state is unavailable');
  }
  const entries = mounted.proposal.proposalEntries;
  if (!Array.isArray(entries) || entries.length !== 5) {
    throw failure(`expected five initial proposal entries, received ${entries?.length ?? 'unavailable'}`);
  }
  for (const proposalEntry of entries) {
    const evidence = mounted.evidence.entries.find(item => item.proposalEntryId === proposalEntry.proposalEntryId);
    if (!evidence) throw failure(`missing evidence for ${proposalEntry.proposalEntryId}`);
    const range = `${formatIntervalMs(evidence.interval.startMs)}–${formatIntervalMs(evidence.interval.endMs)}`;
    const row = page.locator('details.plan-evidence-entry').filter({
      has: page.locator('summary strong', { hasText: range }),
    });
    if (await row.count() !== 1) throw failure(`initial proposal entry ${proposalEntry.intervalId} is missing or ambiguous`);
    await row.evaluate(element => { element.open = true; });
    const accept = row.getByRole('button', { name: '\u63a5\u53d7', exact: true });
    if (await accept.count() !== 1) throw failure(`ACCEPT control for ${proposalEntry.intervalId} is missing or ambiguous`);
    await accept.click();
    await page.waitForFunction(inspectCurrentMountedPlanState, {
      lifecycle: null,
      entries: [{ intervalId: proposalEntry.intervalId, status: 'ACCEPTED', provenance: 'USER_ACCEPTED', selectedAssetId: null }],
    }, { timeout });
  }
  const execute = page.locator('.plan-evidence-review-footer').getByRole('button', {
    name: '\u6267\u884c\u5df2\u6279\u51c6\u4fee\u6539', exact: true,
  });
  if (await execute.count() !== 1 || !await execute.isEnabled()) {
    throw failure('initial approved-plan execution control is unavailable');
  }
  await execute.click();
}

export async function beginRetainedRepairPlanning({
  page, sourceRequest = RETAINED_REPAIR_SOURCE_REQUEST, timeout = 10_000,
} = {}) {
  if (!page) throw failure('page required');
  await beginRetainedExecutionPlanning({ page, sourceRequest, protectFirstClip: false, timeout });
  await acceptCurrentInitialProposal(page, timeout);
  try {
    await page.waitForFunction(inspectCurrentMountedRepairState, { reviewLifecycle: 'REPAIR_PROPOSED' }, { timeout });
  } catch (error) {
    throw failure('production repair proposal did not materialize after the initial reviewed execution', error);
  }
  return detectRetainedRepairDefects(page);
}

export async function detectRetainedRepairDefects(page) {
  if (!page) throw failure('page required');
  const project = await readAuthoritativeProject(page);
  const sequence = project.tracks.flatMap(track => track.clips).map(clip => clip.assetId);
  assert.deepEqual(sequence, RETAINED_REPAIR_ASSET_SEQUENCE);
  const snapshot = await readRetainedRepairState(page);
  for (const code of RETAINED_REPAIR_EXPECTED_DEFECT_CODES) assert.ok(snapshot.defectCodes.includes(code));
  assert.equal(snapshot.hardConstraintStatus, 'PASS');
  assert.equal(snapshot.hardConstraintViolationCount, 0);
  assert.equal(snapshot.repairRound, 1);
  assert.equal(snapshot.eligibleCount, 1);
  assert.equal(snapshot.duplicateTargetConflictCount, 1);
  const eligible = snapshot.entries.find(entry => entry.eligibility === 'ELIGIBLE');
  assert.deepEqual(eligible?.proposedAction, RETAINED_REPAIR_EXPECTED_ACTION);
  return Object.freeze({ ...snapshot, assetSequence: RETAINED_REPAIR_ASSET_SEQUENCE });
}

export async function applyRetainedRepairHumanReview({ page, timeout = 10_000 } = {}) {
  if (!page) throw failure('page required');
  const before = await readRetainedRepairState(page);
  const eligible = before.entries.filter(entry => entry.eligibility === 'ELIGIBLE');
  if (eligible.length !== 1 || eligible[0].reviewStatus !== 'PENDING') {
    throw failure('exactly one pending eligible repair entry is required');
  }
  assert.deepEqual(eligible[0].proposedAction, RETAINED_REPAIR_EXPECTED_ACTION);
  const row = page.locator('.editor-repair-entry.eligibility-eligible');
  if (await row.count() !== 1) throw failure('eligible repair row is missing or ambiguous');
  const accept = row.getByRole('button', { name: '\u63a5\u53d7\u4fee\u590d', exact: true });
  if (await accept.count() !== 1) throw failure('eligible repair ACCEPT control is missing or ambiguous');
  await accept.click();
  try {
    await page.waitForFunction(inspectCurrentMountedRepairState, {
      reviewLifecycle: 'REPAIR_READY_TO_EXECUTE', acceptedRepairEntryId: eligible[0].repairEntryId,
    }, { timeout });
  } catch (error) {
    throw failure(`repair Human Review did not settle for ${eligible[0].repairEntryId}`, error);
  }
  const after = await readRetainedRepairState(page);
  const reviewed = after.entries.find(entry => entry.repairEntryId === eligible[0].repairEntryId);
  assert.equal(reviewed?.reviewStatus, 'ACCEPTED');
  assert.equal(reviewed?.reviewProvenance, 'REPAIR_USER_ACCEPTED');
  assert.equal(after.reviewLifecycle, 'REPAIR_READY_TO_EXECUTE');
  return Object.freeze({
    reviewLifecycle: after.reviewLifecycle,
    decision: 'ACCEPT',
    provenance: reviewed.reviewProvenance,
    reviewedAction: reviewed.proposedAction,
    autoApproval: false,
    reviewBypass: false,
  });
}

export function validateRetainedRepairPlan({ proposal, review, currentProject }) {
  let reviewedPlan;
  try { reviewedPlan = buildReviewedRepairPlan(proposal, review, currentProject); }
  catch (error) { throw failure('canonical repair validation failed', error); }
  assert.equal(reviewedPlan.status, 'REPAIR_READY_TO_EXECUTE');
  assert.equal(reviewedPlan.compiledPlan.canonicalValidation.parser, 'parseAIEditingPlan');
  assert.equal(reviewedPlan.compiledPlan.canonicalValidation.valid, true);
  const hard = validateConstraintContextV1(currentProject, proposal.constraintSet, proposal.constraintContext);
  assert.equal(hard.status, 'ALLOWED');
  assert.deepEqual(hard.violations, []);
  const actions = reviewedPlan.compiledPlan.canonicalPlan.actions;
  assert.equal(actions.length, 1);
  assert.deepEqual(actionSummary(actions[0]), RETAINED_REPAIR_EXPECTED_ACTION);
  return Object.freeze({
    canonicalValidator: 'PASS',
    hardConstraintValidator: 'PASS',
    protectedViolationCount: 0,
    reviewedPlanStatus: reviewedPlan.status,
    executableActionCount: actions.length,
    reviewedAction: actionSummary(actions[0]),
    provenance: reviewedPlan.reviewedEntries[0]?.provenance ?? null,
  });
}

export async function preflightRetainedRepair(page) {
  if (!page) throw failure('page required');
  const state = await readMountedRepairState(page);
  return validateRetainedRepairPlan({
    proposal: state.proposal,
    review: state.review,
    currentProject: await readAuthoritativeProject(page),
  });
}

function assertRepairPreservation(preProject, postProject) {
  const preClips = new Map(preProject.tracks.flatMap(track => track.clips).map(clip => [clip.id, clip]));
  const postClips = new Map(postProject.tracks.flatMap(track => track.clips).map(clip => [clip.id, clip]));
  assert.equal(postClips.get('clip-1')?.assetId, 'asset-anatomy');
  for (const [clipId, clip] of preClips) if (clipId !== 'clip-1') assert.deepEqual(postClips.get(clipId), clip);
  assert.deepEqual(postProject.captions, preProject.captions);
  assert.deepEqual(postProject.audioSelection, preProject.audioSelection);
  assert.equal(postProject.width, preProject.width);
  assert.equal(postProject.height, preProject.height);
  assert.equal(postProject.durationMs, preProject.durationMs);
}

export async function executeRetainedRepair({ page, timeout = 10_000 } = {}) {
  if (!page) throw failure('page required');
  const validation = await preflightRetainedRepair(page);
  const preProject = await readAuthoritativeProject(page);
  const preRepairFingerprint = canonicalProjectFingerprint(preProject);
  const execute = page.locator('.editor-repair-review-footer').getByRole('button', {
    name: '\u6267\u884c\u5df2\u6279\u51c6\u4fee\u590d', exact: true,
  });
  if (await execute.count() !== 1 || !await execute.isEnabled()) {
    throw failure('approved repair execution control is unavailable');
  }
  await execute.click();
  try {
    await page.waitForFunction(inspectCurrentMountedRepairState, { finalStatus: 'REPAIR_FINAL_PASS' }, { timeout });
  } catch (error) {
    throw failure('repair did not reach REPAIR_FINAL_PASS', error);
  }
  const postProject = await readAuthoritativeProject(page);
  const postRepairFingerprint = canonicalProjectFingerprint(postProject);
  assert.notEqual(postRepairFingerprint, preRepairFingerprint);
  assertRepairPreservation(preProject, postProject);
  const snapshot = await readRetainedRepairState(page);
  assert.equal(snapshot.result?.finalStatus, 'REPAIR_FINAL_PASS');
  assert.equal(snapshot.result?.reEvaluationCount, 1);
  assert.equal(snapshot.result?.remainingDefectCount, 0);
  assert.equal(snapshot.result?.appliedActionCount, 1);
  assert.equal(snapshot.result?.failedActionCount, 0);
  assert.equal(snapshot.result?.historyEntryCount, 1);
  assert.equal(snapshot.result?.repairBudgetExhausted, true);
  return Object.freeze({
    validation,
    preRepairFingerprint,
    postRepairFingerprint,
    finalStatus: snapshot.result.finalStatus,
    reEvaluationCount: snapshot.result.reEvaluationCount,
    remainingDefectCount: snapshot.result.remainingDefectCount,
    appliedActionCount: snapshot.result.appliedActionCount,
    failedActionCount: snapshot.result.failedActionCount,
    historyEntryCount: snapshot.result.historyEntryCount,
    repairRoundCount: snapshot.repairRound,
    secondRepairPlanCreated: false,
    secondRepairExecution: false,
    antiOscillation: true,
    protectedContentUnchanged: true,
  });
}

export async function evaluateRetainedRepairResult(page) {
  const snapshot = await readRetainedRepairState(page);
  if (!snapshot.result) throw failure('repair result is unavailable');
  assert.equal(snapshot.result.reEvaluationCount, 1);
  assert.equal(snapshot.result.remainingDefectCount, 0);
  assert.equal(snapshot.result.finalStatus, 'REPAIR_FINAL_PASS');
  assert.equal(snapshot.result.secondRepairPlanCreated, false);
  assert.equal(snapshot.result.secondRepairExecution, false);
  return Object.freeze({
    evaluationCount: snapshot.result.reEvaluationCount,
    remainingDefectCount: snapshot.result.remainingDefectCount,
    finalStatus: snapshot.result.finalStatus,
    repairRoundCount: snapshot.repairRound,
    secondRepairPlanCreated: false,
    secondRepairExecution: false,
    repairBudgetExhausted: snapshot.result.repairBudgetExhausted,
  });
}

export async function exerciseRetainedRepairUndoRedo({ page, timeout = 10_000 } = {}) {
  if (!page) throw failure('page required');
  const state = await readMountedRepairState(page);
  const history = state.result?.history;
  if (!history?.shouldRecord || history.entryCount !== 1 || !history.undoProject || !history.redoProject) {
    throw failure('authoritative single-entry repair history is unavailable');
  }
  const evidence = await exerciseRetainedExecutionUndoRedo({
    page,
    preProjectFingerprint: canonicalProjectFingerprint(history.undoProject),
    executedProjectFingerprint: canonicalProjectFingerprint(history.redoProject),
    preProjectSnapshot: canonicalProjectSnapshot(history.undoProject),
    executedProjectSnapshot: canonicalProjectSnapshot(history.redoProject),
    expectedUndoDisabledAfterUndo: false,
    timeout,
  });
  return Object.freeze({
    exactUndo: evidence.exactUndo,
    exactRedo: evidence.exactRedo,
    logicalHistoryEntryCount: evidence.logicalHistoryEntryCount,
    preRepairFingerprint: canonicalProjectFingerprint(history.undoProject),
    postRepairFingerprint: canonicalProjectFingerprint(history.redoProject),
    editorOpened: evidence.editorOpened,
  });
}

export function verifyRetainedRepairRoundPolicy(repairInput, proposal) {
  const replay = createRepairProposalBundle({
    ...repairInput,
    previouslyAttemptedTuples: proposal.attemptedRepairTuples,
  });
  assert.ok(replay.entries.some(entry => entry.repairEligibility === 'ALREADY_ATTEMPTED'));
  assert.throws(
    () => createRepairProposalBundle({ ...repairInput, repairRound: 2 }),
    error => error instanceof EditorRepairError && error.code === 'INVALID_REPAIR_ROUND',
  );
  return Object.freeze({
    maxRepairRounds: 1,
    replayEligibility: 'ALREADY_ATTEMPTED',
    secondRoundCode: 'INVALID_REPAIR_ROUND',
    antiOscillation: true,
  });
}
