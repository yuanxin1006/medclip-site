import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { deriveEditorCaptionConceptsV1 } from '../../app/editor-caption-concepts.ts';
import { generateEditorProposal } from '../../app/editor-proposal-orchestrator.ts';
import { createHumanReviewState, reviewProposalEntry } from '../../app/editor-proposal-review.ts';
import { createExecutionEditorFixtureV1 } from './editor-input-fixtures.mjs';
import {
  RETAINED_EXECUTION_REVIEW_DECISIONS,
  applyRetainedExecutionHumanReview,
  inspectCurrentMountedPlanState,
  projectRetainedHumanReviewSnapshot,
  waitForRetainedHumanReviewSettled,
} from './retained-execution-browser-handlers.mjs';

function browserExecutionProposal() {
  const fixture = createExecutionEditorFixtureV1();
  const generated = generateEditorProposal({
    project: fixture.initialProject,
    videoAnalyses: fixture.inputEvidence.semanticEvidence,
    rhythm: fixture.inputEvidence.rhythmEvidence,
    captionConcepts: deriveEditorCaptionConceptsV1(fixture.initialProject.captions),
  });
  assert.equal(generated.ok, true);
  return generated.bundle;
}

function applyDecision(proposal, review, decision) {
  const entry = proposal.proposalEntries.find(item => item.intervalId === decision.intervalId);
  assert.ok(entry);
  return reviewProposalEntry(proposal, review, {
    proposalEntryId: entry.proposalEntryId,
    decision: decision.decision,
    ...(decision.selectedAssetId ? { selectedAssetId: decision.selectedAssetId } : {}),
  });
}

function completeReview(proposal, count = RETAINED_EXECUTION_REVIEW_DECISIONS.length) {
  let review = createHumanReviewState(proposal);
  for (const decision of RETAINED_EXECUTION_REVIEW_DECISIONS.slice(0, count)) {
    review = applyDecision(proposal, review, decision);
  }
  return review;
}

function reviewPage(proposal, { leavePendingInterval = null, misrouteInterval = null } = {}) {
  let review = createHumanReviewState(proposal);
  let queuedDecision = null;
  let waitCalls = 0;
  let renderVersion = 0;
  let detailsLookupCount = 0;
  const settledProgress = [];
  const byAsset = new Map(RETAINED_EXECUTION_REVIEW_DECISIONS.map(item => [item.proposedAssetId, item]));

  const page = {
    locator(selector, options = {}) {
      if (selector === 'summary') {
        return { proposedAssetId: String(options.hasText).replace(/^Friendly /, '') };
      }
      if (selector === 'details.plan-evidence-entry') {
        detailsLookupCount += 1;
        const locatorRenderVersion = renderVersion;
        return {
          filter({ has }) {
            const decision = byAsset.get(has.proposedAssetId);
            const assertCurrentRender = () => {
              if (locatorRenderVersion !== renderVersion) throw new Error('stale synthetic review row');
            };
            return {
              async count() { assertCurrentRender(); return decision ? 1 : 0; },
              async evaluate() { assertCurrentRender(); },
              locator() {
                return {
                  async count() { assertCurrentRender(); return 1; },
                  async selectOption(selectedAssetId) {
                    assertCurrentRender();
                    queuedDecision = { ...decision, selectedAssetId };
                  },
                };
              },
              getByRole(_role, { name }) {
                return {
                  async count() { assertCurrentRender(); return 1; },
                  async click() {
                    assertCurrentRender();
                    queuedDecision = { ...decision, decision: name === '\u63a5\u53d7' ? 'ACCEPT' : 'REJECT' };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected locator: ${selector}`);
    },
    async waitForFunction(_predicate, expected) {
      waitCalls += 1;
      if (queuedDecision) {
        if (queuedDecision.intervalId !== leavePendingInterval) {
          const applied = queuedDecision.intervalId === misrouteInterval
            ? { ...RETAINED_EXECUTION_REVIEW_DECISIONS[2], decision: queuedDecision.decision }
            : queuedDecision;
          review = applyDecision(proposal, review, applied);
          renderVersion += 1;
          settledProgress.push(review.entries.filter(item => item.status !== 'PENDING').length);
        }
        queuedDecision = null;
      }
      const entriesMatch = expected.entries.every(wanted => review.entries.some(entry =>
        entry.intervalId === wanted.intervalId
          && entry.status === wanted.status
          && entry.provenance === wanted.provenance
          && (wanted.selectedAssetId === null || entry.selectedAssetId === wanted.selectedAssetId)));
      const lifecycleMatch = expected.lifecycle === null || review.lifecycle === expected.lifecycle;
      if (!entriesMatch || !lifecycleMatch) throw new Error('synthetic structured wait timeout');
    },
    async evaluate() {
      return { proposal, review, evidence: proposal.planEvidence, evaluation: null };
    },
  };
  return {
    page,
    review: () => review,
    waitCalls: () => waitCalls,
    detailsLookupCount: () => detailsLookupCount,
    settledProgress: () => settledProgress,
  };
}

function alternateFiberRoot(proposal, staleReview, currentReview) {
  const rootState = {};
  const staleRoot = { return: null, stateNode: rootState };
  const currentRoot = { return: null, stateNode: rootState };
  staleRoot.alternate = currentRoot;
  currentRoot.alternate = staleRoot;
  rootState.current = currentRoot;
  const props = review => ({
    evidence: proposal.planEvidence, proposal, review, evaluation: null,
  });
  const stalePanel = { memoizedProps: props(staleReview), return: staleRoot };
  const currentPanel = { memoizedProps: props(currentReview), return: currentRoot };
  stalePanel.alternate = currentPanel;
  currentPanel.alternate = stalePanel;
  const staleHost = { memoizedProps: {}, return: stalePanel };
  const currentHost = { memoizedProps: {}, return: currentPanel };
  staleHost.alternate = currentHost;
  currentHost.alternate = staleHost;
  return { root: { '__reactFiber$test': staleHost }, rootState, staleRoot, currentRoot };
}

test('five required review entries truthfully contain four compiled actions and one required no-action entry', () => {
  const proposal = browserExecutionProposal();
  assert.equal(proposal.proposalEntries.length, 5);
  assert.equal(proposal.compiledPlan.canonicalPlan.actions.length, 4);
  const consultation = proposal.proposalEntries.find(item => item.intervalId === 'interval-consultation');
  assert.equal(consultation.actionIndex, undefined);
  assert.equal(proposal.compiledPlan.intervalActionMap.find(item =>
    item.intervalId === 'interval-consultation').status, 'NO_ACTION_REQUIRED');
  const initial = projectRetainedHumanReviewSnapshot({ proposal, review: createHumanReviewState(proposal) });
  assert.equal(initial.requiredEntryCount, 5);
  assert.equal(initial.pendingRequiredEntryCount, 5);
  assert.equal(initial.entries.find(item => item.intervalId === 'interval-consultation').required, true);
  assert.equal(initial.entries.find(item => item.intervalId === 'interval-consultation').executable, false);
});

test('settled snapshot preserves ACCEPT, REJECT, MODIFY, provenance, and only reviewed executable forms', () => {
  const proposal = browserExecutionProposal();
  const snapshot = projectRetainedHumanReviewSnapshot({
    proposal, review: completeReview(proposal), requireSettled: true,
  });
  assert.equal(snapshot.reviewLifecycle, 'READY_TO_EXECUTE');
  assert.deepEqual([
    snapshot.requiredEntryCount, snapshot.settledRequiredEntryCount, snapshot.pendingRequiredEntryCount,
  ], [5, 5, 0]);
  assert.deepEqual(snapshot.acceptedEntries.map(item => item.intervalId),
    ['interval-consultation', 'interval-anatomy', 'interval-recovery']);
  assert.deepEqual(snapshot.rejectedEntries.map(item => item.intervalId), ['interval-treatment']);
  assert.deepEqual(snapshot.modifiedEntries.map(item => [item.intervalId, item.selectedAssetId]),
    [['interval-ecg', 'asset-ecg-alt']]);
  assert.equal(snapshot.reviewedExecutableActions.some(item => item.intervalId === 'interval-treatment'), false);
  assert.equal(snapshot.reviewedExecutableActions.some(item => item.intervalId === 'interval-consultation'), false);
  assert.equal(snapshot.reviewedExecutableActions.some(item => item.assetId === 'asset-ecg'), false);
  assert.equal(snapshot.reviewedExecutableActions.find(item => item.intervalId === 'interval-ecg').assetId,
    'asset-ecg-alt');
  assert.equal(snapshot.humanReviewProvenance, true);
  assert.equal(snapshot.autoApproval, false);
  assert.equal(snapshot.reviewBypass, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /trustedPreExecutionProject|credentials|tokens|__reactFiber/);
});

test('retained Human Review waits after every asynchronous decision and returns settled structured evidence', async () => {
  const proposal = browserExecutionProposal();
  const fixture = reviewPage(proposal);
  const snapshot = await applyRetainedExecutionHumanReview({ page: fixture.page });
  assert.equal(snapshot.reviewLifecycle, 'READY_TO_EXECUTE');
  assert.equal(snapshot.pendingRequiredEntryCount, 0);
  assert.equal(fixture.waitCalls(), 6);
  assert.equal(fixture.detailsLookupCount(), 5);
  assert.deepEqual(fixture.settledProgress(), [1, 2, 3, 4, 5]);
  assert.equal(fixture.review().lifecycle, 'READY_TO_EXECUTE');
});

test('consultation then anatomy use fresh replacement rows and advance structured settlement from one to two', async () => {
  const proposal = browserExecutionProposal();
  const fixture = reviewPage(proposal);
  const snapshot = await applyRetainedExecutionHumanReview({ page: fixture.page });
  assert.deepEqual(fixture.settledProgress().slice(0, 2), [1, 2]);
  assert.equal(fixture.detailsLookupCount(), 5);
  const anatomy = snapshot.entries.find(item => item.intervalId === 'interval-anatomy');
  assert.equal(anatomy.status, 'ACCEPTED');
  assert.equal(anatomy.provenance, 'USER_ACCEPTED');
});

test('mounted plan-state inspection follows the HostRoot current fiber instead of a stale attached branch', () => {
  const proposal = browserExecutionProposal();
  const staleReview = completeReview(proposal, 1);
  const currentReview = completeReview(proposal, 2);
  const fibers = alternateFiberRoot(proposal, staleReview, currentReview);
  const state = inspectCurrentMountedPlanState(null, fibers.root);
  assert.equal(state.review.entries.find(item => item.intervalId === 'interval-consultation').status, 'ACCEPTED');
  assert.equal(state.review.entries.find(item => item.intervalId === 'interval-anatomy').status, 'ACCEPTED');
  assert.equal(inspectCurrentMountedPlanState({
    lifecycle: null,
    entries: [{
      intervalId: 'interval-anatomy', status: 'ACCEPTED', provenance: 'USER_ACCEPTED', selectedAssetId: null,
    }],
  }, fibers.root), true);
  fibers.rootState.current = fibers.staleRoot;
  assert.equal(inspectCurrentMountedPlanState({
    lifecycle: null,
    entries: [{
      intervalId: 'interval-anatomy', status: 'ACCEPTED', provenance: 'USER_ACCEPTED', selectedAssetId: null,
    }],
  }, fibers.root), false);
});

test('wrong-entry targeting fails closed without allowing anatomy evidence to be borrowed from another row', async () => {
  const proposal = browserExecutionProposal();
  const fixture = reviewPage(proposal, { misrouteInterval: 'interval-anatomy' });
  await assert.rejects(
    applyRetainedExecutionHumanReview({ page: fixture.page }),
    /interval-anatomy Human Review decision did not settle/,
  );
  assert.equal(fixture.review().entries.find(item => item.intervalId === 'interval-anatomy').status, 'PENDING');
});

test('bounded structured wait observes REVIEW_IN_PROGRESS to READY_TO_EXECUTE without a sleep', async () => {
  const proposal = browserExecutionProposal();
  let review = completeReview(proposal, 4);
  let waited = false;
  const page = {
    async waitForFunction(_predicate, expected) {
      assert.equal(review.lifecycle, 'REVIEW_IN_PROGRESS');
      assert.equal(expected.lifecycle, 'READY_TO_EXECUTE');
      review = applyDecision(proposal, review, RETAINED_EXECUTION_REVIEW_DECISIONS[4]);
      waited = true;
    },
    async evaluate() { return { proposal, review, evidence: proposal.planEvidence, evaluation: null }; },
  };
  const result = await waitForRetainedHumanReviewSettled({ page });
  assert.equal(waited, true);
  assert.equal(result.reviewLifecycle, 'READY_TO_EXECUTE');
});

test('one required entry left pending fails closed with bounded pending-entry evidence', async () => {
  const proposal = browserExecutionProposal();
  const fixture = reviewPage(proposal, { leavePendingInterval: 'interval-recovery' });
  await assert.rejects(
    applyRetainedExecutionHumanReview({ page: fixture.page }),
    error => {
      assert.match(error.message, /interval-recovery Human Review decision did not settle/);
      assert.match(error.message, /REVIEW_IN_PROGRESS/);
      assert.match(error.message, /interval-recovery/);
      assert.doesNotMatch(error.message, /trustedPreExecutionProject|semanticEvidence|credentials|tokens/);
      return true;
    },
  );
});

test('wrong MODIFY alternative and contradictory lifecycle fail closed', () => {
  const proposal = browserExecutionProposal();
  const settled = completeReview(proposal);
  const wrongModify = Object.freeze({
    ...settled,
    entries: Object.freeze(settled.entries.map(entry => entry.intervalId === 'interval-ecg'
      ? Object.freeze({ ...entry, selectedAssetId: 'asset-ecg' }) : entry)),
  });
  assert.throws(
    () => projectRetainedHumanReviewSnapshot({ proposal, review: wrongModify, requireSettled: true }),
    /wrong MODIFY alternative/,
  );
  const contradictory = Object.freeze({ ...settled, lifecycle: 'REVIEW_IN_PROGRESS' });
  assert.throws(
    () => projectRetainedHumanReviewSnapshot({ proposal, review: contradictory, requireSettled: true }),
    /contradictory Human Review lifecycle/,
  );
});

test('Human Review settling has no explicit completion click, fixed sleep, execution, or preflight coupling', async () => {
  const source = await readFile(new URL('./retained-execution-browser-handlers.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export async function applyRetainedExecutionHumanReview');
  const end = source.indexOf('export function validateRetainedReviewedPlan', start);
  const implementation = source.slice(start, end);
  assert.doesNotMatch(implementation, /waitForTimeout|setTimeout|sleep\s*\(/);
  assert.doesNotMatch(implementation, /plan-evidence-review-footer|executeRetainedReviewedPlan|preflightRetainedExecution/);
  assert.match(implementation, /waitForStructuredReviewState/);
  assert.match(implementation, /waitForRetainedHumanReviewSettled/);
});
