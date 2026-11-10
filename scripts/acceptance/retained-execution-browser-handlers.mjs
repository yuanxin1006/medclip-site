import assert from 'node:assert/strict';
import { buildReviewedProposalPlan } from '../../app/editor-proposal-review.ts';
import { validateConstraintContextV1 } from '../../app/editor-constraint-enforcement.ts';
import { EXECUTION_FIXTURE_ID, validateAcceptanceEditorFixtureV1 } from './editor-input-fixtures.mjs';
import {
  canonicalProjectFingerprint, openRequirementFlow, PROJECT_STORAGE_KEY, readAuthoritativeProject,
  readCanonicalProjectFingerprint, readCanonicalProjectSnapshot, transitionAcceptanceEditorFixture,
} from './medclip-browser-harness.mjs';

export const RETAINED_EXECUTION_SOURCE_REQUEST =
  'Create a complete ten-second medical narrative and protect the first clip.';

export const RETAINED_EXECUTION_REVIEW_DECISIONS = Object.freeze([
  Object.freeze({ intervalId: 'interval-consultation', proposedAssetId: 'asset-consultation', decision: 'ACCEPT' }),
  Object.freeze({ intervalId: 'interval-anatomy', proposedAssetId: 'asset-anatomy', decision: 'ACCEPT' }),
  Object.freeze({ intervalId: 'interval-ecg', proposedAssetId: 'asset-ecg', decision: 'MODIFY', selectedAssetId: 'asset-ecg-alt' }),
  Object.freeze({ intervalId: 'interval-treatment', proposedAssetId: 'asset-treatment', decision: 'REJECT' }),
  Object.freeze({ intervalId: 'interval-recovery', proposedAssetId: 'asset-recovery', decision: 'ACCEPT' }),
]);

export const RETAINED_TIMELINE_EDITOR_SELECTOR =
  'section.timeline-editor-shell[aria-label="\u751f\u6210\u540e\u7ee7\u7eed\u526a\u8f91"]';
export const RETAINED_UNDO_ACCESSIBLE_NAME = '\u21b6 \u64a4\u9500';
export const RETAINED_REDO_ACCESSIBLE_NAME = '\u21b7 \u91cd\u505a';

function failure(message, cause) {
  return Object.assign(new Error(`RETAINED EXECUTION CONTRACT: ${message}`, cause ? { cause } : undefined), {
    harnessFailure: true,
  });
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function expectedReviewStatus(decision) {
  return decision === 'ACCEPT' ? 'ACCEPTED' : decision === 'REJECT' ? 'REJECTED' : 'MODIFIED';
}

function expectedReviewProvenance(decision) {
  return decision === 'ACCEPT' ? 'USER_ACCEPTED'
    : decision === 'REJECT' ? 'USER_REJECTED' : 'USER_MODIFIED';
}

function validateRetainedHumanReviewDecisions(decisions) {
  if (!Array.isArray(decisions) || decisions.length !== RETAINED_EXECUTION_REVIEW_DECISIONS.length) {
    throw failure('Human Review decisions must cover every retained proposal entry');
  }
  for (let index = 0; index < RETAINED_EXECUTION_REVIEW_DECISIONS.length; index += 1) {
    const expected = RETAINED_EXECUTION_REVIEW_DECISIONS[index];
    const actual = decisions[index];
    if (!record(actual)
      || actual.intervalId !== expected.intervalId
      || actual.proposedAssetId !== expected.proposedAssetId
      || actual.decision !== expected.decision
      || actual.selectedAssetId !== expected.selectedAssetId) {
      throw failure(`Human Review decision contract mismatch at ${expected.intervalId}`);
    }
  }
  return decisions;
}

export function resolveRetainedExecutionFixture(gateFixtures) {
  if (!record(gateFixtures)) throw failure('gateFixtures must be an object');
  let fixture;
  try { fixture = validateAcceptanceEditorFixtureV1(gateFixtures.editorInputFixture); }
  catch (error) { throw failure('gateFixtures.editorInputFixture is invalid', error); }
  if (fixture.fixtureId !== EXECUTION_FIXTURE_ID) {
    throw failure(`expected ${EXECUTION_FIXTURE_ID}, received ${fixture.fixtureId}`);
  }
  return fixture;
}

export function inspectCurrentMountedPlanState(expected = null, rootOverride = null) {
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
    if (props && typeof props === 'object' && props.evidence
      && Array.isArray(props.evidence.entries)
      && Object.hasOwn(props, 'proposal') && Object.hasOwn(props, 'review')) {
      state = {
        proposal: props.proposal ?? null,
        review: props.review ?? null,
        evidence: props.evidence,
        evaluation: props.evaluation ?? null,
      };
      break;
    }
    fiber = fiber.return;
  }
  if (!expected) return state;
  if (!state?.review || !Array.isArray(state.review.entries)) return false;
  if (expected.lifecycle !== null && state.review.lifecycle !== expected.lifecycle) return false;
  return expected.entries.every(wanted => state.review.entries.some(entry =>
    entry.intervalId === wanted.intervalId
      && entry.status === wanted.status
      && entry.provenance === wanted.provenance
      && (wanted.selectedAssetId === null || entry.selectedAssetId === wanted.selectedAssetId)));
}

async function readMountedPlanState(page) {
  const state = await page.evaluate(inspectCurrentMountedPlanState, null);
  if (!state?.evidence) throw failure('mounted PlanEvidencePanel structured state is unavailable');
  return state;
}

function actionProjection(action) {
  if (!record(action)) return null;
  return Object.freeze({
    actionIndex: Number.isSafeInteger(action.actionIndex) ? action.actionIndex : null,
    actionType: String(action.actionType ?? action.type ?? ''),
    targetId: String(action.targetId ?? ''),
    ...(typeof action.assetId === 'string' ? { assetId: action.assetId } : {}),
  });
}

export function projectRetainedExecutionState({ proposal, review, evidence, evaluation = null }) {
  if (!record(evidence) || !Array.isArray(evidence.entries)) throw failure('PlanEvidence is malformed');
  const reviewByEntry = new Map((review?.entries ?? []).map(entry => [entry.proposalEntryId, entry]));
  const entries = evidence.entries.map(entry => {
    const decision = reviewByEntry.get(entry.proposalEntryId);
    return Object.freeze({
      proposalEntryId: String(entry.proposalEntryId),
      intervalId: String(entry.intervalId),
      status: String(entry.status),
      reviewStatus: String(decision?.status ?? entry.humanReview?.decision ?? ''),
      ...(typeof decision?.selectedAssetId === 'string' || typeof entry.humanReview?.selectedAssetId === 'string'
        ? { reviewedAssetId: String(decision?.selectedAssetId ?? entry.humanReview.selectedAssetId) } : {}),
      ...(typeof decision?.provenance === 'string' || typeof entry.humanReview?.provenance === 'string'
        ? { provenance: String(decision?.provenance ?? entry.humanReview.provenance) } : {}),
      ...(entry.executedAction ? { executedAction: actionProjection(entry.executedAction) } : {}),
      ...(typeof entry.executionDisposition === 'string' ? { executionDisposition: entry.executionDisposition } : {}),
      ...(typeof entry.actionResultStatus === 'string' ? { actionResultStatus: entry.actionResultStatus } : {}),
      ...(entry.beforeAfter ? { beforeAfter: Object.freeze({
        targetClipId: String(entry.beforeAfter.targetClipId),
        ...(typeof entry.beforeAfter.assetBefore === 'string' ? { assetBefore: entry.beforeAfter.assetBefore } : {}),
        ...(typeof entry.beforeAfter.assetAfter === 'string' ? { assetAfter: entry.beforeAfter.assetAfter } : {}),
      }) } : {}),
    });
  });
  const execution = evidence.summary?.execution;
  const constraint = evidence.summary?.constraintValidation;
  const hard = evaluation?.metricResults?.find(item => item.metric === 'HARD_CONSTRAINT_COMPLIANCE');
  return Object.freeze({
    schemaVersion: 1,
    proposalStatus: proposal ? String(proposal.status) : null,
    reviewLifecycle: review ? String(review.lifecycle) : null,
    lifecycleStatus: String(evidence.lifecycleStatus),
    compiledActionCount: Number(evidence.summary?.compiledActionCount ?? 0),
    entries: Object.freeze(entries),
    execution: execution ? Object.freeze({
      status: String(execution.status), fingerprint: String(execution.fingerprint),
      postProjectReference: String(execution.postProjectReference),
      appliedCount: Number(execution.appliedCount), noOpCount: Number(execution.noOpCount),
      failedCount: Number(execution.failedCount),
    }) : null,
    constraintValidation: constraint ? Object.freeze({
      status: String(constraint.status),
      violationIds: Object.freeze([...(constraint.violationIds ?? [])].map(String)),
    }) : null,
    preservation: evidence.preservation ? Object.freeze(Object.fromEntries([
      'captionsUnchanged', 'audioUnchanged', 'ratioUnchanged', 'durationUnchanged',
      'unrelatedClipsUnchanged', 'transformsUnchanged', 'tracksUnchanged',
    ].map(key => [key, evidence.preservation[key] === true]))) : null,
    evaluator: evaluation ? Object.freeze({
      overallStatus: String(evaluation.overallStatus),
      hardConstraintCompliance: String(hard?.status ?? ''),
      acceptedCount: Number(evaluation.summary?.acceptedCount ?? 0),
      modifiedCount: Number(evaluation.summary?.modifiedCount ?? 0),
      rejectedCount: Number(evaluation.summary?.rejectedCount ?? 0),
      intendedActionCount: Number(evaluation.summary?.intendedActionCount ?? 0),
      realizedActionCount: Number(evaluation.summary?.realizedActionCount ?? 0),
      defectCodes: Object.freeze((evaluation.defects ?? []).map(item => String(item.code))),
    }) : null,
  });
}

export async function readRetainedExecutionState(page) {
  return projectRetainedExecutionState(await readMountedPlanState(page));
}

export function projectRetainedHumanReviewSnapshot({
  proposal, review, decisions = RETAINED_EXECUTION_REVIEW_DECISIONS, requireSettled = false,
} = {}) {
  validateRetainedHumanReviewDecisions(decisions);
  if (!record(proposal) || !Array.isArray(proposal.proposalEntries)
    || !record(proposal.compiledPlan) || !Array.isArray(proposal.compiledPlan.canonicalPlan?.actions)) {
    throw failure('proposal structure is unavailable for Human Review evidence');
  }
  if (!record(review) || !Array.isArray(review.entries)) {
    throw failure('review structure is unavailable for Human Review evidence');
  }
  if (proposal.proposalEntries.length !== decisions.length || review.entries.length !== decisions.length) {
    throw failure(`Human Review entry count mismatch: proposal=${proposal.proposalEntries.length}, review=${review.entries.length}, required=${decisions.length}`);
  }
  const expectedByInterval = new Map(decisions.map(item => [item.intervalId, item]));
  const reviewById = new Map(review.entries.map(item => [item.proposalEntryId, item]));
  if (expectedByInterval.size !== decisions.length || reviewById.size !== review.entries.length) {
    throw failure('Human Review contains duplicate required interval or entry identities');
  }
  const entries = proposal.proposalEntries.map(source => {
    const expected = expectedByInterval.get(source.intervalId);
    const actual = reviewById.get(source.proposalEntryId);
    if (!expected || !actual || actual.intervalId !== source.intervalId
      || source.selectedAssetId !== expected.proposedAssetId) {
      throw failure(`required Human Review entry is unavailable or mismatched for ${source.intervalId}`);
    }
    const originalAction = Number.isSafeInteger(source.actionIndex)
      ? proposal.compiledPlan.canonicalPlan.actions[source.actionIndex] : null;
    if (source.actionIndex !== undefined && !originalAction) {
      throw failure(`Human Review action index is invalid for ${source.intervalId}`);
    }
    const expectedStatus = expectedReviewStatus(expected.decision);
    const expectedProvenance = expectedReviewProvenance(expected.decision);
    const settled = actual.status !== 'PENDING';
    const summary = {
      proposalEntryId: String(source.proposalEntryId),
      intervalId: String(source.intervalId),
      required: true,
      expectedDecision: expected.decision,
      status: String(actual.status),
      provenance: actual.provenance ?? null,
      originalActionIndex: Number.isSafeInteger(source.actionIndex) ? source.actionIndex : null,
      originalAssetId: source.selectedAssetId ?? null,
      selectedAssetId: actual.status === 'MODIFIED' ? actual.selectedAssetId ?? null : source.selectedAssetId ?? null,
      executable: actual.status === 'MODIFIED' || (actual.status === 'ACCEPTED' && Boolean(originalAction)),
    };
    if (settled && (actual.status !== expectedStatus || actual.provenance !== expectedProvenance)) {
      throw failure(`contradictory Human Review decision for ${source.intervalId}: expected ${expectedStatus}/${expectedProvenance}, received ${actual.status}/${actual.provenance ?? 'NONE'}`);
    }
    if (actual.status === 'MODIFIED' && actual.selectedAssetId !== expected.selectedAssetId) {
      throw failure(`wrong MODIFY alternative for ${source.intervalId}: expected ${expected.selectedAssetId}, received ${actual.selectedAssetId ?? 'NONE'}`);
    }
    return Object.freeze(summary);
  });
  const pending = entries.filter(item => item.status === 'PENDING');
  const derivedLifecycle = pending.length === entries.length ? 'PENDING_REVIEW'
    : pending.length > 0 ? 'REVIEW_IN_PROGRESS'
      : entries.every(item => item.status === 'REJECTED') ? 'REVIEWED_NO_ACTIONS' : 'READY_TO_EXECUTE';
  if (review.lifecycle !== derivedLifecycle) {
    throw failure(`contradictory Human Review lifecycle: expected ${derivedLifecycle}, received ${review.lifecycle}`);
  }
  if (requireSettled && (pending.length !== 0 || review.lifecycle !== 'READY_TO_EXECUTE')) {
    throw failure(`Human Review is not settled: lifecycle=${review.lifecycle}, pending=${pending.map(item => item.intervalId).join(',') || 'NONE'}`);
  }
  const executable = entries.filter(item => item.executable).map(item => {
    const source = proposal.proposalEntries.find(entry => entry.proposalEntryId === item.proposalEntryId);
    const originalAction = Number.isSafeInteger(source.actionIndex)
      ? proposal.compiledPlan.canonicalPlan.actions[source.actionIndex] : null;
    return Object.freeze({
      proposalEntryId: item.proposalEntryId,
      intervalId: item.intervalId,
      decision: item.status,
      actionType: String(originalAction?.type ?? 'MATCH_ASSET_TO_SEGMENT'),
      targetId: String(originalAction?.targetId ?? source.targetId ?? ''),
      assetId: String(item.status === 'MODIFIED' ? item.selectedAssetId : originalAction?.assetId ?? item.selectedAssetId ?? ''),
      provenance: item.provenance,
    });
  });
  if (executable.some(item => item.decision === 'REJECTED')) {
    throw failure('reviewed executable evidence contains a rejected action');
  }
  const modified = entries.filter(item => item.status === 'MODIFIED');
  if (modified.some(item => executable.some(action => action.proposalEntryId === item.proposalEntryId
    && action.assetId === item.originalAssetId))) {
    throw failure('reviewed executable evidence contains the original pre-MODIFY action');
  }
  const allUserProvenance = entries.every(item => item.status === 'PENDING'
    || ['USER_ACCEPTED', 'USER_REJECTED', 'USER_MODIFIED'].includes(item.provenance));
  return Object.freeze({
    schemaVersion: 1,
    reviewLifecycle: String(review.lifecycle),
    requiredEntryCount: entries.length,
    settledRequiredEntryCount: entries.length - pending.length,
    pendingRequiredEntryCount: pending.length,
    pendingRequiredEntries: Object.freeze(pending.map(item => Object.freeze({
      proposalEntryId: item.proposalEntryId, intervalId: item.intervalId,
      expectedDecision: item.expectedDecision, status: item.status,
    }))),
    entries: Object.freeze(entries),
    acceptedEntries: Object.freeze(entries.filter(item => item.status === 'ACCEPTED')),
    rejectedEntries: Object.freeze(entries.filter(item => item.status === 'REJECTED')),
    modifiedEntries: Object.freeze(modified),
    reviewedExecutableActions: Object.freeze(executable),
    humanReviewProvenance: allUserProvenance,
    autoApproval: false,
    reviewBypass: false,
  });
}

export async function readRetainedHumanReviewSnapshot(
  page,
  { decisions = RETAINED_EXECUTION_REVIEW_DECISIONS, requireSettled = false } = {},
) {
  const state = await readMountedPlanState(page);
  if (!state.proposal || !state.review) throw failure('mounted proposal/review state is unavailable');
  return projectRetainedHumanReviewSnapshot({ proposal: state.proposal, review: state.review, decisions, requireSettled });
}

function reviewExpectation(decision) {
  return Object.freeze({
    intervalId: decision.intervalId,
    decision: decision.decision,
    status: expectedReviewStatus(decision.decision),
    provenance: expectedReviewProvenance(decision.decision),
    selectedAssetId: decision.decision === 'MODIFY' ? decision.selectedAssetId : null,
  });
}

async function waitForStructuredReviewState(page, expectedEntries, lifecycle, timeout, label) {
  try {
    await page.waitForFunction(
      inspectCurrentMountedPlanState, { entries: expectedEntries, lifecycle }, { timeout },
    );
  } catch (error) {
    let current;
    try { current = await readRetainedHumanReviewSnapshot(page); }
    catch { current = null; }
    const expected = expectedEntries.length === 1 ? expectedEntries[0] : null;
    const actual = expected && current
      ? current.entries.find(item => item.intervalId === expected.intervalId) : null;
    const evidence = current ? {
      entryId: expected?.intervalId ?? 'ALL_REQUIRED',
      expectedDecision: expected?.decision ?? 'ALL_SETTLED',
      currentStatus: actual?.status ?? 'UNAVAILABLE',
      currentProvenance: actual?.provenance ?? null,
      globalLifecycle: current.reviewLifecycle,
      settledRequiredEntryCount: current.settledRequiredEntryCount,
      pendingRequiredEntryCount: current.pendingRequiredEntryCount,
    } : {
      entryId: expected?.intervalId ?? 'ALL_REQUIRED',
      expectedDecision: expected?.decision ?? 'ALL_SETTLED',
      currentStatus: 'UNAVAILABLE',
      currentProvenance: null,
      globalLifecycle: 'UNAVAILABLE',
      settledRequiredEntryCount: null,
      pendingRequiredEntryCount: null,
    };
    throw failure(`${label} did not settle: ${JSON.stringify(evidence)}`, error);
  }
}

export async function waitForRetainedHumanReviewSettled({
  page, decisions = RETAINED_EXECUTION_REVIEW_DECISIONS, timeout = 10_000,
} = {}) {
  if (!page) throw failure('page required');
  validateRetainedHumanReviewDecisions(decisions);
  await waitForStructuredReviewState(
    page, decisions.map(reviewExpectation), 'READY_TO_EXECUTE', timeout, 'Human Review',
  );
  return readRetainedHumanReviewSnapshot(page, { decisions, requireSettled: true });
}

export async function prepareRetainedExecutionFixture({ harness, gateFixtures, timeout = 10_000 } = {}) {
  if (!harness?.page || !harness?.server?.url) throw failure('owned harness page/server required');
  const fixture = resolveRetainedExecutionFixture(gateFixtures);
  const hydration = await transitionAcceptanceEditorFixture({
    harness, editorInputFixture: fixture, timeout,
  });
  const hydrated = hydration.diagnostic;
  assert.equal(hydrated.fixtureId, fixture.fixtureId);
  const projectFingerprint = await readCanonicalProjectFingerprint(harness.page);
  assert.equal(projectFingerprint, canonicalProjectFingerprint(fixture.initialProject));
  assert.equal(await harness.page.locator('.editor-proposal-status').count(), 0);
  return Object.freeze({
    fixtureId: fixture.fixtureId, projectFingerprint,
    semanticAssetCount: hydrated.semanticAssetCount,
    rhythmEvidencePresent: hydrated.rhythmEvidencePresent,
    proposalPresent: false,
  });
}

export async function beginRetainedExecutionPlanning({
  page, sourceRequest = RETAINED_EXECUTION_SOURCE_REQUEST, protectFirstClip = true, timeout = 10_000,
} = {}) {
  if (!page) throw failure('page required');
  await page.locator('.ai-task-provider-options button[aria-checked="true"]').waitFor({ state: 'visible', timeout: 15_000 });
  const input = await openRequirementFlow(page);
  await input.fill(sourceRequest);
  assert.equal(await page.locator('.editor-proposal-status').count(), 0);
  const dialog = page.locator('section.requirement-dialog[role="dialog"]');
  assert.equal(await dialog.count(), 1);
  await dialog.getByRole('button', { name: '\u5206\u6790\u521b\u4f5c\u610f\u56fe', exact: true }).click();
  if (protectFirstClip) {
    const candidate = page.locator('.creative-intent-grounding-candidates button')
      .filter({ hasText: 'Friendly asset-consultation' });
    await candidate.waitFor({ state: 'visible', timeout });
    assert.equal(await candidate.count(), 1);
    await candidate.click();
  }
  await page.waitForFunction(() => document.querySelector('.creative-intent-panel header span')?.textContent === 'READY_TO_PLAN', undefined, { timeout });
  assert.equal(await page.locator('.editor-proposal-status').count(), 0);
  const generate = page.locator('.editor-proposal-actions button.platform-secondary-button');
  assert.equal(await generate.count(), 1);
  await generate.click();
  await page.waitForFunction(() => (window.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__ ?? [])
    .some(item => item.diagnostic?.kind === 'EDITOR_PROPOSAL_STAGE'
      && item.diagnostic?.stage === 'RESULT_MAPPING'
      && item.diagnostic?.outcome === 'READY_FOR_REVIEW'), undefined, { timeout });
  await page.locator('.editor-proposal-status').waitFor({ state: 'visible', timeout });
  const snapshot = await readRetainedExecutionState(page);
  assert.equal(snapshot.lifecycleStatus, 'PENDING_REVIEW');
  return snapshot;
}

function reviewEntry(page, proposedAssetId) {
  return page.locator('details.plan-evidence-entry').filter({
    has: page.locator('summary', { hasText: `Friendly ${proposedAssetId}` }),
  });
}

export async function applyRetainedExecutionHumanReview({
  page, decisions = RETAINED_EXECUTION_REVIEW_DECISIONS, timeout = 10_000,
} = {}) {
  if (!page) throw failure('page required');
  validateRetainedHumanReviewDecisions(decisions);
  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index];
    const before = await readRetainedHumanReviewSnapshot(page, { decisions });
    const current = before.entries.find(item => item.intervalId === decision.intervalId);
    if (!current || current.status !== 'PENDING' || current.provenance !== null
      || before.settledRequiredEntryCount !== index) {
      throw failure(`${decision.intervalId} is not the next pending Human Review entry: ${JSON.stringify({
        entryId: decision.intervalId,
        expectedDecision: decision.decision,
        currentStatus: current?.status ?? 'MISSING',
        currentProvenance: current?.provenance ?? null,
        globalLifecycle: before.reviewLifecycle,
        settledRequiredEntryCount: before.settledRequiredEntryCount,
        pendingRequiredEntryCount: before.pendingRequiredEntryCount,
      })}`);
    }
    const entry = reviewEntry(page, decision.proposedAssetId);
    assert.equal(await entry.count(), 1, `${decision.intervalId} review entry is missing or ambiguous`);
    await entry.evaluate(element => { element.open = true; });
    if (decision.decision === 'MODIFY') {
      const select = entry.locator(`select[aria-label*="${decision.intervalId}"]`);
      assert.equal(await select.count(), 1);
      await select.selectOption(decision.selectedAssetId);
    } else {
      const name = decision.decision === 'ACCEPT' ? '\u63a5\u53d7' : '\u62d2\u7edd';
      const button = entry.getByRole('button', { name, exact: true });
      assert.equal(await button.count(), 1);
      await button.click();
    }
    await waitForStructuredReviewState(
      page, [reviewExpectation(decision)], null, timeout, `${decision.intervalId} Human Review decision`,
    );
    const after = await readRetainedHumanReviewSnapshot(page, { decisions });
    const settled = after.entries.find(item => item.intervalId === decision.intervalId);
    const expected = reviewExpectation(decision);
    if (!settled || settled.status !== expected.status || settled.provenance !== expected.provenance
      || (expected.selectedAssetId !== null && settled.selectedAssetId !== expected.selectedAssetId)
      || after.settledRequiredEntryCount !== index + 1) {
      throw failure(`${decision.intervalId} Human Review transaction settled incorrectly`);
    }
  }
  return waitForRetainedHumanReviewSettled({ page, decisions, timeout });
}

export function validateRetainedReviewedPlan({ proposal, review, currentProject }) {
  let reviewedPlan;
  try { reviewedPlan = buildReviewedProposalPlan(proposal, review, currentProject); }
  catch (error) { throw failure('canonical reviewed-plan validation failed', error); }
  assert.equal(reviewedPlan.status, 'READY_TO_EXECUTE');
  assert.equal(reviewedPlan.compiledPlan.canonicalValidation.valid, true);
  const context = proposal.evidenceMetadata?.constraintContext;
  const hard = validateConstraintContextV1(currentProject, proposal.constraintSet, context ? {
    intentVersionId: context.sourceIntentVersionId,
    constraintSetId: context.sourceConstraintSetId,
    constraintFingerprint: context.sourceConstraintFingerprint,
  } : undefined);
  assert.equal(hard.status, 'ALLOWED');
  const rejected = reviewedPlan.reviewedEntries.filter(entry => entry.decision === 'REJECTED');
  const modified = reviewedPlan.reviewedEntries.filter(entry => entry.decision === 'MODIFIED');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].intervalId, 'interval-treatment');
  assert.equal(rejected[0].action, undefined);
  assert.equal(modified.length, 1);
  assert.equal(modified[0].intervalId, 'interval-ecg');
  assert.equal(modified[0].selectedAssetId, 'asset-ecg-alt');
  assert.equal(modified[0].action?.assetId, 'asset-ecg-alt');
  return Object.freeze({
    canonicalValidator: 'PASS', hardConstraintValidator: 'PASS',
    reviewedPlanStatus: reviewedPlan.status,
    executableActionCount: reviewedPlan.compiledPlan.canonicalPlan.actions.length,
    acceptedCount: reviewedPlan.reviewedEntries.filter(entry => entry.decision === 'ACCEPTED').length,
    rejectedCount: rejected.length, modifiedCount: modified.length,
    rejectedIntervalIds: Object.freeze(rejected.map(entry => entry.intervalId)),
    reviewedEntries: Object.freeze(reviewedPlan.reviewedEntries.map(entry => Object.freeze({
      proposalEntryId: entry.proposalEntryId,
      intervalId: entry.intervalId,
      decision: entry.decision,
      reviewedActionIndex: entry.reviewedActionIndex ?? null,
      action: entry.action ? Object.freeze({
        type: entry.action.type,
        targetId: entry.action.targetId,
        ...(entry.action.assetId ? { assetId: entry.action.assetId } : {}),
      }) : null,
    }))),
    modifiedActions: Object.freeze(modified.map(entry => Object.freeze({
      intervalId: entry.intervalId, targetId: entry.action?.targetId ?? null,
      originalAssetId: entry.originalAssetId ?? null, selectedAssetId: entry.selectedAssetId ?? null,
      actionAssetId: entry.action?.assetId ?? null,
    }))),
  });
}

export async function preflightRetainedExecution(page) {
  const state = await readMountedPlanState(page);
  if (!state.proposal || !state.review) throw failure('proposal/review unavailable before execution');
  return validateRetainedReviewedPlan({
    proposal: state.proposal, review: state.review, currentProject: await readAuthoritativeProject(page),
  });
}

export async function executeRetainedReviewedPlan({ page, timeout = 10_000 } = {}) {
  if (!page) throw failure('page required');
  const validation = await preflightRetainedExecution(page);
  const preProjectSnapshot = await readCanonicalProjectSnapshot(page);
  const preProjectFingerprint = await readCanonicalProjectFingerprint(page);
  const execute = page.locator('.plan-evidence-review-footer').getByRole('button', {
    name: '\u6267\u884c\u5df2\u6279\u51c6\u4fee\u6539', exact: true,
  });
  assert.equal(await execute.count(), 1);
  assert.equal(await execute.isEnabled(), true);
  await execute.click();
  await page.waitForFunction(() => {
    const root = document.querySelector('.plan-evidence-panel');
    const key = root && Object.keys(root).find(item => item.startsWith('__reactFiber$'));
    let fiber = key ? root[key] : null;
    while (fiber) {
      if (fiber.memoizedProps?.evidence?.lifecycleStatus === 'EXECUTED'
        && fiber.memoizedProps?.evaluation?.metricResults) return true;
      fiber = fiber.return;
    }
    return false;
  }, undefined, { timeout });
  const postProjectSnapshot = await readCanonicalProjectSnapshot(page);
  const postProjectFingerprint = await readCanonicalProjectFingerprint(page);
  assert.notEqual(postProjectFingerprint, preProjectFingerprint);
  const snapshot = await readRetainedExecutionState(page);
  assert.equal(snapshot.lifecycleStatus, 'EXECUTED');
  assert.ok(snapshot.execution?.appliedCount >= 1);
  assert.equal(snapshot.execution?.failedCount, 0);
  assert.equal(snapshot.constraintValidation?.status, 'ALLOWED');
  assert.deepEqual(snapshot.constraintValidation?.violationIds, []);
  assert.ok(snapshot.preservation && Object.values(snapshot.preservation).every(Boolean));
  const rejected = snapshot.entries.find(entry => entry.intervalId === 'interval-treatment');
  assert.equal(rejected?.executionDisposition, 'NOT_EXECUTED_USER_REJECTED');
  assert.equal(rejected?.executedAction, undefined);
  const modified = snapshot.entries.find(entry => entry.intervalId === 'interval-ecg');
  assert.equal(modified?.executedAction?.assetId, 'asset-ecg-alt');
  assert.equal(modified?.beforeAfter?.assetAfter, 'asset-ecg-alt');
  assert.equal(snapshot.evaluator?.hardConstraintCompliance, 'PASS');
  return Object.freeze({
    validation, preProjectSnapshot, postProjectSnapshot,
    preProjectFingerprint, postProjectFingerprint, snapshot,
  });
}

async function waitFingerprint(page, expected, timeout) {
  try {
    await page.waitForFunction(async ({ storageKey, fingerprint }) => {
      const serialized = window.localStorage.getItem(storageKey);
      if (!serialized) return false;
      let project;
      try { project = JSON.parse(serialized); }
      catch { return false; }
      if (!project || typeof project !== 'object' || Array.isArray(project)) return false;
      const material = { ...project };
      delete material.updatedAt;
      const canonicalize = value => {
        if (Array.isArray(value)) return value.map(canonicalize);
        if (value && typeof value === 'object') {
          const output = {};
          for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
          return output;
        }
        return value;
      };
      const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(material)));
      const digest = await window.crypto.subtle.digest('SHA-256', bytes);
      const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      return `editor-project-r10c-sha256-${hex}` === fingerprint;
    }, { storageKey: PROJECT_STORAGE_KEY, fingerprint: expected }, { timeout });
  } catch (error) {
    const last = await readCanonicalProjectFingerprint(page).catch(() => 'UNAVAILABLE');
    throw failure(`project fingerprint did not become ${expected}; last=${last}`, error);
  }
  const actual = await readCanonicalProjectFingerprint(page);
  if (actual !== expected) throw failure(`project fingerprint settled incorrectly: expected=${expected}, actual=${actual}`);
  return actual;
}

export function assertRetainedUndoRedoComparison(input) {
  const expectedUndoDisabledAfterUndo = input.expectedUndoDisabledAfterUndo ?? true;
  assert.equal(input.undoProjectFingerprint, input.preProjectFingerprint);
  assert.equal(input.redoProjectFingerprint, input.executedProjectFingerprint);
  assert.deepEqual(input.undoProjectSnapshot, input.preProjectSnapshot);
  assert.deepEqual(input.redoProjectSnapshot, input.executedProjectSnapshot);
  assert.equal(input.undoDisabledAfterUndo, expectedUndoDisabledAfterUndo);
  assert.equal(input.redoDisabledAfterRedo, true);
  return Object.freeze({ exactUndo: true, exactRedo: true, logicalHistoryEntryCount: 1 });
}

function retainedTimelineControl(page, accessibleName) {
  return page.locator(RETAINED_TIMELINE_EDITOR_SELECTOR)
    .locator('.editor-toolbar').getByRole('button', { name: accessibleName, exact: true });
}

async function controlFailureEvidence(page, control, accessibleName) {
  const editor = page.locator(RETAINED_TIMELINE_EDITOR_SELECTOR);
  const candidate = retainedTimelineControl(page, accessibleName);
  return Object.freeze({
    control,
    scope: `${RETAINED_TIMELINE_EDITOR_SELECTOR} .editor-toolbar`,
    editorVisible: await editor.isVisible().catch(() => false),
    candidateMatchCount: await candidate.count().catch(() => 0),
  });
}

async function waitForRetainedControlState(page, control, accessibleName, disabled, timeout) {
  try {
    await page.waitForFunction(({ editorSelector, name, expectedDisabled }) => {
      const editor = document.querySelector(editorSelector);
      if (!editor) return false;
      const matches = [...editor.querySelectorAll('.editor-toolbar button')]
        .filter(button => button.textContent?.trim() === name);
      return matches.length === 1 && matches[0].disabled === expectedDisabled;
    }, {
      editorSelector: RETAINED_TIMELINE_EDITOR_SELECTOR,
      name: accessibleName,
      expectedDisabled: disabled,
    }, { timeout });
  } catch (error) {
    const evidence = await controlFailureEvidence(page, control, accessibleName);
    throw failure(`${control} control state unavailable: ${JSON.stringify(evidence)}`, error);
  }
  const current = retainedTimelineControl(page, accessibleName);
  const count = await current.count();
  const visible = count === 1 && await current.isVisible();
  const enabled = count === 1 && await current.isEnabled();
  if (count !== 1 || !visible || enabled === disabled) {
    const evidence = await controlFailureEvidence(page, control, accessibleName);
    throw failure(`${control} control state contradicted after wait: ${JSON.stringify(evidence)}`);
  }
  return current;
}

export async function ensureRetainedTimelineEditorOpen({ page, timeout = 10_000 } = {}) {
  if (!page) throw failure('page required');
  const editor = page.locator(RETAINED_TIMELINE_EDITOR_SELECTOR);
  const initialCount = await editor.count();
  if (initialCount > 1) {
    throw failure(`TimelineEditor is ambiguous: ${JSON.stringify({
      scope: RETAINED_TIMELINE_EDITOR_SELECTOR, editorVisible: false, candidateMatchCount: initialCount,
    })}`);
  }
  if (initialCount === 1 && await editor.isVisible()) {
    return Object.freeze({ opened: false, editorVisible: true });
  }
  const open = page.locator('button.continue-edit-button');
  const openCount = await open.count();
  const openVisible = openCount === 1 && await open.isVisible();
  const openEnabled = openCount === 1 && await open.isEnabled();
  if (openCount !== 1 || !openVisible || !openEnabled) {
    throw failure(`TimelineEditor open control unavailable: ${JSON.stringify({
      control: 'Open TimelineEditor', scope: 'button.continue-edit-button',
      editorVisible: false, candidateMatchCount: openCount,
    })}`);
  }
  await open.click();
  try { await editor.waitFor({ state: 'visible', timeout }); }
  catch (error) {
    throw failure(`TimelineEditor did not open: ${JSON.stringify({
      control: 'Open TimelineEditor', scope: RETAINED_TIMELINE_EDITOR_SELECTOR,
      editorVisible: await editor.isVisible().catch(() => false),
      candidateMatchCount: await editor.count().catch(() => 0),
    })}`, error);
  }
  return Object.freeze({ opened: true, editorVisible: true });
}

export async function exerciseRetainedExecutionUndoRedo({
  page, preProjectFingerprint, executedProjectFingerprint,
  preProjectSnapshot, executedProjectSnapshot,
  expectedUndoDisabledAfterUndo = true, timeout = 10_000,
} = {}) {
  if (!page || !preProjectFingerprint || !executedProjectFingerprint
    || !preProjectSnapshot || !executedProjectSnapshot) {
    throw failure('page and exact pre/post execution project evidence are required for Undo/Redo');
  }
  if (typeof expectedUndoDisabledAfterUndo !== 'boolean') {
    throw failure('expectedUndoDisabledAfterUndo must be boolean');
  }
  assert.equal(await readCanonicalProjectFingerprint(page), executedProjectFingerprint);
  assert.deepEqual(await readCanonicalProjectSnapshot(page), executedProjectSnapshot);
  const editor = await ensureRetainedTimelineEditorOpen({ page, timeout });
  const redoBeforeUndo = await waitForRetainedControlState(
    page, 'Redo', RETAINED_REDO_ACCESSIBLE_NAME, true, timeout,
  );
  assert.equal(await redoBeforeUndo.isDisabled(), true);
  const undo = await waitForRetainedControlState(
    page, 'Undo', RETAINED_UNDO_ACCESSIBLE_NAME, false, timeout,
  );
  await undo.click();
  const undoProjectFingerprint = await waitFingerprint(page, preProjectFingerprint, timeout);
  const undoProjectSnapshot = await readCanonicalProjectSnapshot(page);
  assert.deepEqual(undoProjectSnapshot, preProjectSnapshot);
  const undoAfterUndo = await waitForRetainedControlState(
    page, 'Undo', RETAINED_UNDO_ACCESSIBLE_NAME, expectedUndoDisabledAfterUndo, timeout,
  );
  const undoDisabledAfterUndo = await undoAfterUndo.isDisabled();
  const redo = await waitForRetainedControlState(
    page, 'Redo', RETAINED_REDO_ACCESSIBLE_NAME, false, timeout,
  );
  await redo.click();
  const redoProjectFingerprint = await waitFingerprint(page, executedProjectFingerprint, timeout);
  const redoProjectSnapshot = await readCanonicalProjectSnapshot(page);
  assert.deepEqual(redoProjectSnapshot, executedProjectSnapshot);
  const redoAfterRedo = await waitForRetainedControlState(
    page, 'Redo', RETAINED_REDO_ACCESSIBLE_NAME, true, timeout,
  );
  const redoDisabledAfterRedo = await redoAfterRedo.isDisabled();
  return Object.freeze({
    ...assertRetainedUndoRedoComparison({
      preProjectFingerprint, executedProjectFingerprint,
      preProjectSnapshot, executedProjectSnapshot,
      undoProjectFingerprint, redoProjectFingerprint,
      undoProjectSnapshot, redoProjectSnapshot,
      undoDisabledAfterUndo, redoDisabledAfterRedo, expectedUndoDisabledAfterUndo,
    }),
    editorOpened: editor.opened,
  });
}

export function verifyRetainedExecutionFingerprintSupport(project) {
  const original = canonicalProjectFingerprint(project);
  assert.equal(canonicalProjectFingerprint(structuredClone(project)), original);
  const mutation = structuredClone(project);
  mutation.title = `${mutation.title} material mutation`;
  assert.notEqual(canonicalProjectFingerprint(mutation), original);
  return Object.freeze({ equivalentClone: true, materialMutationChangesFingerprint: true });
}

export function verifyRetainedExecutionStaleSupport({ proposal, review, currentProject }) {
  const staleProject = structuredClone(currentProject);
  staleProject.title = `${staleProject.title} stale`;
  assert.throws(() => buildReviewedProposalPlan(proposal, review, staleProject));
  return Object.freeze({ staleProposalRejected: true });
}
