import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCEPTANCE_FIXTURE_UNMAPPED_REQUEST,
  CAMPUS_OPTION_B_EXPECTED,
  PROJECT_STORAGE_KEY,
  acceptanceInitScript,
  assertSyntheticIntentOnly,
  captureAcceptanceDiagnosticBaseline,
  canonicalProjectFingerprint,
  canonicalProjectSnapshot,
  classifyExpectedFixtureBlock,
  classifyHttpFailure,
  classifyNetworkFailure,
  classifyBrowserError,
  ensureAdvancedSettingsOpen,
  installAcceptanceFixtures,
  NEGOTIATION_OPTION_CONTRACTS,
  openRequirementFlow,
  readAcceptanceDiagnostics,
  readNegotiationOptionSnapshot,
  selectNegotiationOption,
  waitForNegotiationState,
  waitForZeroActionReviewResult,
} from './medclip-browser-harness.mjs';
import {
  R11E_GATES,
  authenticateAcceptanceBrowserToEditor,
  resolveR11EGateFixtures,
  runG2ASetupSmoke,
  runGateSequence,
  runR11E,
} from './v24abc-r11e.mjs';
import {
  createExecutionEditorFixtureV1,
  createImmutableRepetitionEditorFixtureV1,
} from './editor-input-fixtures.mjs';
import { auditR11EScenarioContracts, R11E_SCENARIO_CONTRACT } from './v24abc-r11e-scenario-contract.mjs';

const FIXTURE_SUPABASE_ORIGIN = 'https://acceptance-fixture.supabase.co';
const INTENT_REQUIREMENTS = Object.freeze({
  campus: 'Create a 30 second campus video and preserve the teacher speech and ending logo.',
  execution: 'Create a complete ten-second medical narrative and protect the first clip.',
  repair: 'Create a complete ten-second medical narrative with upbeat pacing.',
});

function intentFixtureResponse(sourceRequest, durationMs) {
  return Object.freeze({
    ok: true,
    task: 'editor.creative_intent_parse',
    provider: 'deepseek',
    result: Object.freeze({
      capability: 'TEXT_REASONING',
      data: Object.freeze({
        schemaVersion: 1,
        sourceRequest,
        clauses: Object.freeze([Object.freeze({
          kind: 'GOAL',
          payload: Object.freeze({ type: 'TARGET_DURATION', durationMs, policy: 'TARGET' }),
          provenance: Object.freeze({ schemaVersion: 1, authority: 'MODEL_SUGGESTION', sourceReference: sourceRequest }),
        })]),
      }),
    }),
    usage: null,
    metadata: Object.freeze({
      providerUsed: 'deepseek',
      taskType: 'editor.creative_intent_parse',
      generationOccurred: false,
    }),
  });
}

const INTENT_RESPONSES = Object.freeze({
  campus: intentFixtureResponse(INTENT_REQUIREMENTS.campus, 30_000),
  execution: intentFixtureResponse(INTENT_REQUIREMENTS.execution, 10_000),
  repair: intentFixtureResponse(INTENT_REQUIREMENTS.repair, 12_000),
});

function createFixtureRoutePage() {
  let handler = null;
  let routeCalls = 0;
  return {
    page: {
      async route(pattern, nextHandler) {
        assert.equal(pattern, '**/*');
        routeCalls += 1;
        handler = nextHandler;
      },
    },
    get routeCalls() { return routeCalls; },
    async dispatch(requestBody, { method = 'POST', url = `${FIXTURE_SUPABASE_ORIGIN}/functions/v1/ai-tasks` } = {}) {
      assert.equal(typeof handler, 'function', 'Fixture route was not installed');
      const outcome = { fulfilled: null, aborted: null, continued: false };
      const request = {
        url: () => url,
        method: () => method,
        postDataJSON: () => requestBody,
        headers: () => ({}),
      };
      await handler({
        request: () => request,
        fulfill: async options => { outcome.fulfilled = options; },
        abort: async reason => { outcome.aborted = reason; },
        continue: async () => { outcome.continued = true; },
      });
      return Object.freeze({
        ...outcome,
        response: outcome.fulfilled ? JSON.parse(outcome.fulfilled.body) : null,
      });
    },
  };
}

function intentRequest(editingRequirement) {
  return Object.freeze({
    task: 'editor.creative_intent_parse',
    provider: 'deepseek',
    input: Object.freeze({ editingRequirement }),
  });
}

function semanticIntentResolver(observed = []) {
  const byRequirement = new Map([
    [INTENT_REQUIREMENTS.campus, INTENT_RESPONSES.campus],
    [INTENT_REQUIREMENTS.execution, INTENT_RESPONSES.execution],
    [INTENT_REQUIREMENTS.repair, INTENT_RESPONSES.repair],
  ]);
  return context => {
    observed.push(context);
    if (context.task !== 'editor.creative_intent_parse') return null;
    return byRequirement.get(context.input?.editingRequirement) ?? null;
  };
}

async function installIntentFixture(options) {
  const controlled = createFixtureRoutePage();
  const fixtures = await installAcceptanceFixtures(controlled.page, {
    ...options,
    env: { NEXT_PUBLIC_SUPABASE_URL: FIXTURE_SUPABASE_ORIGIN },
  });
  return { controlled, fixtures };
}

test('harness enables and captures only the ordered sanitized diagnostic contract', () => {
  const script = acceptanceInitScript.toString();
  assert.match(script, /__MEDCLIP_ACCEPTANCE_DIAGNOSTICS__/);
  assert.match(script, /medclip:acceptance-diagnostic/);
  assert.match(script, /sequence:/);
  assert.match(script, /SAFE_NO_CHANGE_ELIGIBILITY/);
  assert.match(script, /ZERO_ACTION_REVIEW_RESULT/);
  assert.equal(PROJECT_STORAGE_KEY, 'medclip-editor-draft-v1');
});

test('browser collector projects the zero-action review event without private payload fields', async () => {
  const root = globalThis;
  const previous = Object.getOwnPropertyDescriptor(root, 'window');
  const listeners = new Map();
  const browserWindow = {
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  Object.defineProperty(root, 'window', { configurable: true, value: browserWindow });
  try {
    acceptanceInitScript();
    listeners.get('medclip:acceptance-diagnostic')({ detail: {
      schemaVersion: 1,
      kind: 'ZERO_ACTION_REVIEW_RESULT',
      stage: 'ZERO_ACTION_REVIEW_RESULT',
      proposalStatus: 'SAFE_NO_CHANGE',
      reviewLifecycle: 'REVIEWED_NO_ACTIONS',
      reviewedPlanStatus: 'REVIEWED_NO_ACTIONS',
      planEvidenceLifecycleStatus: 'REVIEWED_NO_ACTIONS',
      executionPresent: false,
      historyShouldRecord: false,
      historyRecordCommitted: false,
      proposalActionCount: 0,
      reviewedActionCount: 0,
      executedActionCount: 0,
      project: { private: true },
      token: 'must-not-survive',
    } });
    const collected = await readAcceptanceDiagnostics({
      evaluate: async () => browserWindow.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__,
    });
    assert.deepEqual(collected, [{ sequence: 1, diagnostic: {
      schemaVersion: 1,
      kind: 'ZERO_ACTION_REVIEW_RESULT',
      stage: 'ZERO_ACTION_REVIEW_RESULT',
      proposalStatus: 'SAFE_NO_CHANGE',
      reviewLifecycle: 'REVIEWED_NO_ACTIONS',
      reviewedPlanStatus: 'REVIEWED_NO_ACTIONS',
      planEvidenceLifecycleStatus: 'REVIEWED_NO_ACTIONS',
      executionPresent: false,
      historyShouldRecord: false,
      historyRecordCommitted: false,
      proposalActionCount: 0,
      reviewedActionCount: 0,
      executedActionCount: 0,
    } }]);
    assert.doesNotMatch(JSON.stringify(collected), /private|must-not-survive|project|token/i);
  } finally {
    if (previous) Object.defineProperty(root, 'window', previous);
    else Reflect.deleteProperty(root, 'window');
  }
});

const zeroActionReviewDiagnostic = () => ({
  schemaVersion: 1,
  kind: 'ZERO_ACTION_REVIEW_RESULT',
  stage: 'ZERO_ACTION_REVIEW_RESULT',
  proposalStatus: 'SAFE_NO_CHANGE',
  reviewLifecycle: 'REVIEWED_NO_ACTIONS',
  reviewedPlanStatus: 'REVIEWED_NO_ACTIONS',
  planEvidenceLifecycleStatus: 'REVIEWED_NO_ACTIONS',
  executionPresent: false,
  historyShouldRecord: false,
  historyRecordCommitted: false,
  proposalActionCount: 0,
  reviewedActionCount: 0,
  executedActionCount: 0,
});

async function withAcceptanceDiagnosticWindow(run) {
  const root = globalThis;
  const previous = Object.getOwnPropertyDescriptor(root, 'window');
  const listeners = new Map();
  const browserWindow = { addEventListener: (type, listener) => listeners.set(type, listener) };
  Object.defineProperty(root, 'window', { configurable: true, value: browserWindow });
  try {
    acceptanceInitScript();
    return await run({ browserWindow, emit(detail) { listeners.get('medclip:acceptance-diagnostic')({ detail }); } });
  } finally {
    if (previous) Object.defineProperty(root, 'window', previous);
    else Reflect.deleteProperty(root, 'window');
  }
}

function diagnosticPage(browserWindow, waitForFunction = async (predicate, arg) => {
  assert.equal(predicate(arg), true);
}) {
  return {
    waitForFunction,
    evaluate: async () => browserWindow.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__,
  };
}

test('zero-action reader waits for a new diagnostic after the captured baseline', async () => {
  await withAcceptanceDiagnosticWindow(async ({ browserWindow, emit }) => {
    emit(zeroActionReviewDiagnostic());
    const page = diagnosticPage(browserWindow, async (predicate, afterSequence, options) => {
      assert.deepEqual(options, { timeout: 321 });
      assert.equal(predicate(afterSequence), false, 'the stale event must not satisfy the wait');
      browserWindow.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__.push({
        sequence: 2,
        diagnostic: { ...zeroActionReviewDiagnostic(), kind: 'EDITOR_PROPOSAL_STAGE', stage: 'RESULT_MAPPING' },
      });
      emit(zeroActionReviewDiagnostic());
      assert.equal(predicate(afterSequence), true);
    });
    const baseline = await captureAcceptanceDiagnosticBaseline(page);
    assert.deepEqual(baseline, { sequence: 1 });
    const snapshot = await waitForZeroActionReviewResult(page, baseline, 321);
    assert.equal(snapshot.proposalStatus, 'SAFE_NO_CHANGE');
  });
});

test('zero-action reader returns the exact allowlisted zero-action snapshot', async () => {
  await withAcceptanceDiagnosticWindow(async ({ browserWindow, emit }) => {
    const page = diagnosticPage(browserWindow);
    const baseline = await captureAcceptanceDiagnosticBaseline(page);
    emit({ ...zeroActionReviewDiagnostic(), project: { private: true }, constraints: ['private'], token: 'secret' });
    const result = await waitForZeroActionReviewResult(page, baseline);
    assert.deepEqual(result, {
      proposalStatus: 'SAFE_NO_CHANGE', reviewLifecycle: 'REVIEWED_NO_ACTIONS',
      reviewedPlanStatus: 'REVIEWED_NO_ACTIONS', planEvidenceLifecycleStatus: 'REVIEWED_NO_ACTIONS',
      executionPresent: false, historyShouldRecord: false, historyRecordCommitted: false,
      proposalActionCount: 0, reviewedActionCount: 0, executedActionCount: 0,
    });
  });
});

test('zero-action reader ignores a stale prior result and requires a post-baseline result', async () => {
  await withAcceptanceDiagnosticWindow(async ({ browserWindow, emit }) => {
    emit(zeroActionReviewDiagnostic());
    const page = diagnosticPage(browserWindow, async (predicate, afterSequence) => {
      assert.equal(predicate(afterSequence), false);
      emit(zeroActionReviewDiagnostic());
      assert.equal(predicate(afterSequence), true);
    });
    const baseline = await captureAcceptanceDiagnosticBaseline(page);
    const result = await waitForZeroActionReviewResult(page, baseline);
    assert.equal(result.executionPresent, false);
  });
});

test('zero-action reader fails closed when no matching event arrives', async () => {
  await withAcceptanceDiagnosticWindow(async ({ browserWindow }) => {
    const page = diagnosticPage(browserWindow, async () => { throw new Error('timeout'); });
    await assert.rejects(waitForZeroActionReviewResult(page, { sequence: 0 }), /timeout/);
  });
});

test('zero-action diagnostic sanitizer drops malformed payloads instead of defaulting fields', async () => {
  await withAcceptanceDiagnosticWindow(async ({ browserWindow, emit }) => {
    const malformed = { ...zeroActionReviewDiagnostic() };
    delete malformed.historyRecordCommitted;
    emit(malformed);
    assert.deepEqual(await readAcceptanceDiagnostics({ evaluate: async () => browserWindow.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__ }), []);
    const page = diagnosticPage(browserWindow, async () => { throw new Error('timeout'); });
    await assert.rejects(waitForZeroActionReviewResult(page, { sequence: 0 }), /timeout/);
  });
});

test('zero-action diagnostic sanitizer drops invalid booleans and counts', async () => {
  await withAcceptanceDiagnosticWindow(async ({ browserWindow, emit }) => {
    emit({ ...zeroActionReviewDiagnostic(), executionPresent: 'false' });
    emit({ ...zeroActionReviewDiagnostic(), proposalActionCount: -1 });
    assert.deepEqual(await readAcceptanceDiagnostics({ evaluate: async () => browserWindow.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__ }), []);
  });
});

test('zero-action snapshot preserves execution absence distinctly', async () => {
  await withAcceptanceDiagnosticWindow(async ({ browserWindow, emit }) => {
    const page = diagnosticPage(browserWindow);
    const baseline = await captureAcceptanceDiagnosticBaseline(page);
    emit(zeroActionReviewDiagnostic());
    assert.equal((await waitForZeroActionReviewResult(page, baseline)).executionPresent, false);
  });
});

test('zero-action snapshot preserves both history decision and actual sink result', async () => {
  await withAcceptanceDiagnosticWindow(async ({ browserWindow, emit }) => {
    const page = diagnosticPage(browserWindow);
    const baseline = await captureAcceptanceDiagnosticBaseline(page);
    emit(zeroActionReviewDiagnostic());
    const snapshot = await waitForZeroActionReviewResult(page, baseline);
    assert.equal(snapshot.historyShouldRecord, false);
    assert.equal(snapshot.historyRecordCommitted, false);
  });
});

test('zero-action snapshot requires all action counts to remain zero', async () => {
  await withAcceptanceDiagnosticWindow(async ({ browserWindow, emit }) => {
    const page = diagnosticPage(browserWindow);
    const baseline = await captureAcceptanceDiagnosticBaseline(page);
    emit(zeroActionReviewDiagnostic());
    const snapshot = await waitForZeroActionReviewResult(page, baseline);
    assert.deepEqual([snapshot.proposalActionCount, snapshot.reviewedActionCount, snapshot.executedActionCount], [0, 0, 0]);
  });
});

test('zero-action reader is UI-independent and exposes no non-allowlisted fields', async () => {
  await withAcceptanceDiagnosticWindow(async ({ browserWindow, emit }) => {
    emit({ ...zeroActionReviewDiagnostic(), session: { secret: true }, project: { id: 'private' }, bindings: ['private'], rawActions: [{}], token: 'secret' });
    const page = diagnosticPage(browserWindow);
    const baseline = { sequence: 0 };
    const result = await waitForZeroActionReviewResult(page, baseline);
    assert.deepEqual(Object.keys(result), [
      'proposalStatus', 'reviewLifecycle', 'reviewedPlanStatus', 'planEvidenceLifecycleStatus',
      'executionPresent', 'historyShouldRecord', 'historyRecordCommitted',
      'proposalActionCount', 'reviewedActionCount', 'executedActionCount',
    ]);
    assert.doesNotMatch(JSON.stringify(result), /session|project|binding|token|rawActions/i);
  });
});

test('zero-action reader rejects multiple fresh results rather than choosing one', async () => {
  await withAcceptanceDiagnosticWindow(async ({ browserWindow, emit }) => {
    const page = diagnosticPage(browserWindow);
    emit(zeroActionReviewDiagnostic());
    emit({ ...zeroActionReviewDiagnostic(), historyShouldRecord: true });
    await assert.rejects(waitForZeroActionReviewResult(page, { sequence: 0 }), /exactly one new ZERO_ACTION_REVIEW_RESULT/);
  });
});

test('canonical project snapshots compare only project material and omit updatedAt', () => {
  const project = { schemaVersion: 2, id: 'p', updatedAt: 'now', assets: [], tracks: [], captions: [] };
  const reordered = { captions: [], tracks: [], assets: [], id: 'p', updatedAt: 'later', schemaVersion: 2 };
  assert.deepEqual(canonicalProjectSnapshot(project), canonicalProjectSnapshot(reordered));
  assert.equal(canonicalProjectFingerprint(project), canonicalProjectFingerprint(reordered));
  assert.notEqual(canonicalProjectFingerprint(project), canonicalProjectFingerprint({ ...project, title: 'changed' }));
  assert.equal('updatedAt' in canonicalProjectSnapshot(project), false);
});

function negotiationPage({
  state = 'NEEDS_USER_DECISION', panels = null,
} = {}) {
  const optionControls = Object.entries(NEGOTIATION_OPTION_CONTRACTS).map(([semanticKey, contract]) => ({
    semanticKey, accessibleName: contract.accessibleName, visible: true, enabled: true,
  }));
  const currentPanels = panels ?? [{ inScope: true, visible: true, controls: optionControls }];
  const clicks = [];
  const snapshot = () => {
    const scoped = currentPanels.filter(panel => panel.inScope !== false);
    const visiblePanels = scoped.filter(panel => panel.visible);
    const controls = visiblePanels.flatMap(panel => panel.controls.map(control => ({
      accessibleName: control.accessibleName, visible: control.visible,
      enabled: control.enabled, semanticIdentity: control.semanticIdentity ?? null,
    })));
    return {
      negotiationState: state,
      panelCount: scoped.length,
      visiblePanelCount: visiblePanels.length,
      interactiveControlCount: controls.length,
      visibleOptionControlCount: controls.filter(control => control.visible && control.enabled).length,
      controls,
    };
  };
  return {
    clicks,
    page: {
      async waitForFunction(_predicate, input) {
        const current = snapshot();
        const ready = current.negotiationState === 'NEEDS_USER_DECISION'
          && current.visiblePanelCount === 1
          && input.options.every(option => current.controls.filter(control => control.visible && control.enabled
            && control.accessibleName === option.accessibleName).length === 1);
        if (!ready) throw new Error('bounded negotiation readiness did not settle');
      },
      async evaluate() { return snapshot(); },
      locator(selector) {
        assert.equal(selector, 'section.constraint-negotiation-panel[aria-label="约束协商"]:visible');
        const visiblePanels = currentPanels.filter(panel => panel.inScope !== false && panel.visible);
        return {
          getByRole(role, options) {
            assert.equal(role, 'button');
            assert.equal(options.exact, true);
            const matches = visiblePanels.flatMap(panel => panel.controls)
              .filter(control => control.accessibleName === options.name);
            return {
              async count() { return matches.length; },
              async isVisible() { return matches.length === 1 && matches[0].visible; },
              async isEnabled() { return matches.length === 1 && matches[0].enabled; },
              async click() { clicks.push(matches[0].semanticKey); },
            };
          },
        };
      },
    },
  };
}

test('all three semantic negotiation options resolve uniquely independent of DOM order', async () => {
  const reverse = Object.entries(NEGOTIATION_OPTION_CONTRACTS).reverse().map(([semanticKey, contract]) => ({
    semanticKey, accessibleName: contract.accessibleName, visible: true, enabled: true,
  }));
  for (const identity of Object.keys(NEGOTIATION_OPTION_CONTRACTS)) {
    const { page, clicks } = negotiationPage({ panels: [{ inScope: true, visible: true, controls: reverse }] });
    await selectNegotiationOption(page, identity, 50);
    assert.deepEqual(clicks, [identity]);
  }
  assert.equal(/\.first\(|\.nth\(/.test(selectNegotiationOption.toString()), false);
});

test('Option B exact simple-Chinese accessible name remains stable through text wrappers', async () => {
  assert.equal(NEGOTIATION_OPTION_CONTRACTS.OPTIMIZE_UNPROTECTED_ONLY.accessibleName,
    'B. 优先压缩其他非保护内容，尽量接近30秒，但不改变讲话和Logo');
  const { page, clicks } = negotiationPage();
  await selectNegotiationOption(page, 'OPTIMIZE_UNPROTECTED_ONLY', 50);
  assert.deepEqual(clicks, ['OPTIMIZE_UNPROTECTED_ONLY']);
});

test('missing or duplicate Option B fails closed with bounded semantic diagnostics', async () => {
  const base = Object.entries(NEGOTIATION_OPTION_CONTRACTS).map(([semanticKey, contract]) => ({
    semanticKey, accessibleName: contract.accessibleName, visible: true, enabled: true,
  }));
  for (const controls of [
    base.filter(control => control.semanticKey !== 'OPTIMIZE_UNPROTECTED_ONLY'),
    [...base, { ...base.find(control => control.semanticKey === 'OPTIMIZE_UNPROTECTED_ONLY') }],
  ]) {
    const { page } = negotiationPage({ panels: [{ inScope: true, visible: true, controls }] });
    await assert.rejects(selectNegotiationOption(page, 'OPTIMIZE_UNPROTECTED_ONLY', 50), error => {
      assert.match(error.message, /G2A_NEGOTIATION_OPTION_B_RESOLUTION/);
      assert.match(error.message, /requestedSemanticKey=OPTIMIZE_UNPROTECTED_ONLY/);
      assert.match(error.message, /negotiationState=NEEDS_USER_DECISION/);
      assert.match(error.message, /visibleOptionControlCount=/);
      return true;
    });
  }
});

test('wrong-panel and hidden stale Option B-like controls cannot satisfy current selection', async () => {
  const base = Object.entries(NEGOTIATION_OPTION_CONTRACTS).map(([semanticKey, contract]) => ({
    semanticKey, accessibleName: contract.accessibleName, visible: true, enabled: true,
  }));
  const withoutB = base.filter(control => control.semanticKey !== 'OPTIMIZE_UNPROTECTED_ONLY');
  const optionB = base.find(control => control.semanticKey === 'OPTIMIZE_UNPROTECTED_ONLY');
  const { page } = negotiationPage({ panels: [
    { inScope: true, visible: true, controls: withoutB },
    { inScope: true, visible: false, controls: [optionB] },
    { inScope: false, visible: true, controls: [optionB] },
  ] });
  await assert.rejects(selectNegotiationOption(page, 'OPTIMIZE_UNPROTECTED_ONLY', 50),
    /G2A_NEGOTIATION_OPTION_B_RESOLUTION/);
});

test('negotiation selection waits for NEEDS_USER_DECISION and the complete three-option panel', async () => {
  const { page } = negotiationPage({ state: 'GROUNDING_REQUIRED' });
  await assert.rejects(selectNegotiationOption(page, 'OPTIMIZE_UNPROTECTED_ONLY', 50), error => {
    assert.match(error.message, /G2A_NEGOTIATION_OPTION_B_RESOLUTION/);
    assert.match(error.message, /negotiationState=GROUNDING_REQUIRED/);
    assert.match(error.message, /panelCount=1/);
    assert.match(error.message, /interactiveControlCount=3/);
    return true;
  });
  assert.equal((await readNegotiationOptionSnapshot(negotiationPage().page)).visibleOptionControlCount, 3);
});

test('campus negotiation guard checks all authoritative expected fields', async () => {
  const diagnostic = { kind: 'NEGOTIATION_STATE', ...CAMPUS_OPTION_B_EXPECTED };
  let predicate;
  let expected;
  const page = {
    waitForFunction: async (fn, wanted) => { predicate = fn; expected = wanted; },
    evaluate: async () => [{ sequence: 1, diagnostic }],
  };
  const result = await waitForNegotiationState(page, CAMPUS_OPTION_B_EXPECTED);
  assert.equal(result.kind, 'NEGOTIATION_STATE');
  assert.equal(predicate.toString().includes('NEGOTIATION_STATE'), true);
  assert.deepEqual(expected, CAMPUS_OPTION_B_EXPECTED);
});

test('Option B semantic click continues through the exact READY_TO_PLAN transition contract', async () => {
  const selection = negotiationPage();
  await selectNegotiationOption(selection.page, 'OPTIMIZE_UNPROTECTED_ONLY', 50);
  assert.deepEqual(selection.clicks, ['OPTIMIZE_UNPROTECTED_ONLY']);
  const diagnostic = { kind: 'NEGOTIATION_STATE', ...CAMPUS_OPTION_B_EXPECTED };
  const transitionPage = {
    async waitForFunction(_predicate, expected) { assert.deepEqual(expected, CAMPUS_OPTION_B_EXPECTED); },
    async evaluate() { return [{ sequence: 1, diagnostic }]; },
  };
  const result = await waitForNegotiationState(transitionPage, CAMPUS_OPTION_B_EXPECTED);
  for (const [key, value] of Object.entries(diagnostic)) assert.equal(result[key], value);
});

test('synthetic intent fixture rejects downstream product outputs', () => {
  assert.doesNotThrow(() => assertSyntheticIntentOnly({ intent: { goal: 'shorten', clauses: [] } }));
  for (const key of ['ConstraintSet', 'constraint_set', 'feasibility', 'proposal', 'SAFE_NO_CHANGE', 'safeNoChange', 'evaluator', 'repair']) {
    assert.throws(() => assertSyntheticIntentOnly({ intent: {}, [key]: {} }));
  }
});

test('legacy static synthetic intent response remains provider-free and unchanged', async () => {
  const { controlled, fixtures } = await installIntentFixture({ syntheticIntentResponse: INTENT_RESPONSES.campus });
  const result = await controlled.dispatch(intentRequest('A legacy caller does not need a resolver.'));
  assert.equal(result.fulfilled.status, 200);
  assert.deepEqual(result.response, INTENT_RESPONSES.campus);
  assert.equal(result.aborted, null);
  assert.equal(result.continued, false);
  assert.equal(fixtures.syntheticIntentRequests, 1);
  assert.equal(fixtures.providerCalls, 0);
});

test('request-aware intent fixture routes campus semantics without another phase response', async () => {
  const observed = [];
  const { controlled, fixtures } = await installIntentFixture({ syntheticIntentResponseResolver: semanticIntentResolver(observed) });
  const result = await controlled.dispatch(intentRequest(INTENT_REQUIREMENTS.campus));
  assert.deepEqual(result.response, INTENT_RESPONSES.campus);
  assert.notDeepEqual(result.response, INTENT_RESPONSES.execution);
  assert.notDeepEqual(result.response, INTENT_RESPONSES.repair);
  assert.deepEqual(Object.keys(observed[0]), ['method', 'url', 'task', 'provider', 'input', 'requestBody']);
  assert.deepEqual(observed[0].url, { origin: FIXTURE_SUPABASE_ORIGIN, pathname: '/functions/v1/ai-tasks' });
  assert.equal(observed[0].requestBody.input.editingRequirement, INTENT_REQUIREMENTS.campus);
  assert.equal('headers' in observed[0], false);
  assert.equal('request' in observed[0], false);
  assert.equal(fixtures.providerCalls, 0);
});

test('request-aware intent fixture routes execution semantics without another phase response', async () => {
  const { controlled, fixtures } = await installIntentFixture({ syntheticIntentResponseResolver: semanticIntentResolver() });
  const result = await controlled.dispatch(intentRequest(INTENT_REQUIREMENTS.execution));
  assert.deepEqual(result.response, INTENT_RESPONSES.execution);
  assert.notDeepEqual(result.response, INTENT_RESPONSES.campus);
  assert.notDeepEqual(result.response, INTENT_RESPONSES.repair);
  assert.equal(fixtures.providerCalls, 0);
});

test('request-aware intent fixture routes repair semantics without another phase response', async () => {
  const { controlled, fixtures } = await installIntentFixture({ syntheticIntentResponseResolver: semanticIntentResolver() });
  const result = await controlled.dispatch(intentRequest(INTENT_REQUIREMENTS.repair));
  assert.deepEqual(result.response, INTENT_RESPONSES.repair);
  assert.notDeepEqual(result.response, INTENT_RESPONSES.campus);
  assert.notDeepEqual(result.response, INTENT_RESPONSES.execution);
  assert.equal(fixtures.providerCalls, 0);
});

test('request-aware routing is semantic and independent of phase order', async () => {
  const observed = [];
  const { controlled, fixtures } = await installIntentFixture({ syntheticIntentResponseResolver: semanticIntentResolver(observed) });
  const order = ['repair', 'campus', 'execution', 'campus'];
  const responses = [];
  for (const phase of order) {
    responses.push((await controlled.dispatch(intentRequest(INTENT_REQUIREMENTS[phase]))).response);
  }
  assert.deepEqual(responses, order.map(phase => INTENT_RESPONSES[phase]));
  assert.deepEqual(observed.map(context => context.input.editingRequirement), order.map(phase => INTENT_REQUIREMENTS[phase]));
  assert.equal(fixtures.syntheticIntentRequests, 4);
  assert.equal(fixtures.providerCalls, 0);
});

test('repeated request semantics return the same deterministic fixture without phase advancement', async () => {
  const { controlled, fixtures } = await installIntentFixture({ syntheticIntentResponseResolver: semanticIntentResolver() });
  const first = await controlled.dispatch(intentRequest(INTENT_REQUIREMENTS.campus));
  const second = await controlled.dispatch(intentRequest(INTENT_REQUIREMENTS.campus));
  assert.deepEqual(first.response, INTENT_RESPONSES.campus);
  assert.deepEqual(second.response, INTENT_RESPONSES.campus);
  assert.deepEqual(first.response, second.response);
  assert.equal(fixtures.syntheticIntentRequests, 2);
  assert.equal(fixtures.providerCalls, 0);
});

test('unmapped request fails closed inside the acceptance fixture without provider fallback', async () => {
  const { controlled, fixtures } = await installIntentFixture({ syntheticIntentResponseResolver: semanticIntentResolver() });
  const result = await controlled.dispatch(intentRequest('Unmapped request text'));
  assert.equal(result.fulfilled, null);
  assert.equal(result.aborted, 'blockedbyclient');
  assert.equal(result.continued, false);
  assert.equal(fixtures.syntheticIntentRequests, 0);
  assert.equal(fixtures.providerCalls, 0);
  assert.equal(fixtures.unexpectedBlockedRequests.length, 1);
  assert.equal(fixtures.unexpectedBlockedRequests[0].reason, ACCEPTANCE_FIXTURE_UNMAPPED_REQUEST);
  assert.equal(fixtures.unexpectedBlockedRequests[0].reason.includes('Unmapped request text'), false);
});

test('static and request-aware intent fixture configuration is explicitly ambiguous', async () => {
  const controlled = createFixtureRoutePage();
  await assert.rejects(
    installAcceptanceFixtures(controlled.page, {
      syntheticIntentResponse: INTENT_RESPONSES.campus,
      syntheticIntentResponseResolver: semanticIntentResolver(),
      env: { NEXT_PUBLIC_SUPABASE_URL: FIXTURE_SUPABASE_ORIGIN },
    }),
    /either syntheticIntentResponse or syntheticIntentResponseResolver, not both/,
  );
  assert.equal(controlled.routeCalls, 0);
});

test('request-aware resolver lifetime is isolated to each installed fixture instance', async () => {
  let firstCalls = 0;
  const first = await installIntentFixture({
    syntheticIntentResponseResolver: context => {
      firstCalls += 1;
      return context.input?.editingRequirement === INTENT_REQUIREMENTS.campus ? INTENT_RESPONSES.campus : null;
    },
  });
  assert.deepEqual((await first.controlled.dispatch(intentRequest(INTENT_REQUIREMENTS.campus))).response, INTENT_RESPONSES.campus);
  first.fixtures.dispose();

  let secondCalls = 0;
  const second = await installIntentFixture({
    syntheticIntentResponseResolver: context => {
      secondCalls += 1;
      return context.input?.editingRequirement === INTENT_REQUIREMENTS.repair ? INTENT_RESPONSES.repair : null;
    },
  });
  assert.deepEqual((await second.controlled.dispatch(intentRequest(INTENT_REQUIREMENTS.repair))).response, INTENT_RESPONSES.repair);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
  assert.equal(first.fixtures.providerCalls, 0);
  assert.equal(second.fixtures.providerCalls, 0);
  second.fixtures.dispose();
});

test('known static export page txt 404 is classified separately and other errors remain visible', () => {
  assert.equal(classifyBrowserError({ message: '404 at __next.__PAGE__.txt' }).classification, 'STATIC_EXPORT_PREFETCH_NOISE');
  assert.equal(classifyBrowserError({ message: 'application crash' }).classification, 'PRODUCT_OR_BROWSER_ERROR');
});

test('Advanced Settings initially collapsed opens before returning the requirement section', async () => {
  let open = false;
  let toggles = 0;
  const section = { count: async () => 1, getAttribute: async () => open ? '' : null };
  const summary = { count: async () => 1, isVisible: async () => true, click: async () => { open = true; toggles += 1; } };
  const page = {
    locator: selector => selector === 'details.requirement-advanced' ? section : summary,
    waitForFunction: async (_predicate, _argument, options) => { assert.equal(open, true); assert.equal(options.timeout, 5_000); },
  };
  assert.equal(await ensureAdvancedSettingsOpen(page), section);
  assert.equal(toggles, 1);
});

test('Advanced Settings already open is not toggled closed', async () => {
  let summaryClicks = 0;
  const section = { count: async () => 1, getAttribute: async () => '' };
  const summary = { count: async () => 1, isVisible: async () => true, click: async () => { summaryClicks += 1; } };
  const page = { locator: selector => selector === 'details.requirement-advanced' ? section : summary };
  assert.equal(await ensureAdvancedSettingsOpen(page), section);
  assert.equal(summaryClicks, 0);
});

test('requirement control is verified visible and enabled before it is clicked', async () => {
  const events = [];
  let open = false;
  const control = {
    count: async () => 1,
    isVisible: async () => { events.push('visible'); assert.equal(open, true); return true; },
    isEnabled: async () => { events.push('enabled'); return true; },
    click: async () => { events.push('clicked'); },
  };
  const section = { count: async () => 1, getAttribute: async () => open ? '' : null, getByRole: (role, opts) => { assert.equal(role, 'button'); assert.match(String(opts.name), /填写视频与音频编排需求/); return control; } };
  const input = { waitFor: async ({ state }) => { assert.equal(state, 'visible'); events.push('input-visible'); }, isEnabled: async () => true };
  const page = {
    locator: selector => selector === 'details.requirement-advanced' ? section : { count: async () => 1, isVisible: async () => true, click: async () => { open = true; } },
    waitForFunction: async () => { assert.equal(open, true); },
    getByLabel: name => { assert.match(String(name), /具体剪辑要求/); return input; },
  };
  assert.equal(await openRequirementFlow(page), input);
  assert.deepEqual(events, ['visible', 'enabled', 'clicked', 'input-visible']);
});

test('retained auth helper preserves sign-in and editor readiness and stops before requirement flow', async () => {
  const events = [];
  const email = { fill: async value => { assert.equal(value, 'user-a@example.test'); events.push('email'); } };
  const password = { fill: async value => { assert.equal(value, 'secret'); events.push('password'); } };
  const advanced = { waitFor: async options => { assert.deepEqual(options, { state: 'attached', timeout: 30_000 }); events.push('editor-ready'); } };
  const submit = {
    count: async () => 1,
    click: async () => { events.push('submit'); },
  };
  const page = {
    goto: async (url, options) => {
      assert.deepEqual(options, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      events.push(url.endsWith('/auth') ? 'auth-navigation' : 'editor-navigation');
    },
    locator: selector => {
      if (selector === 'form.auth-form input[type="email"]') return email;
      if (selector === 'form.auth-form input[type="password"]') return password;
      if (selector === 'details.requirement-advanced') return advanced;
      assert.fail(`Unexpected selector before auth-only return: ${selector}`);
    },
    getByRole: (role, options) => {
      assert.equal(role, 'button');
      assert.match(String(options.name), /登录/);
      return submit;
    },
    waitForURL: async (predicate, options) => {
      assert.equal(predicate(new URL('http://127.0.0.1:43117/')), true);
      assert.deepEqual(options, { timeout: 30_000 });
      events.push('signed-in-root');
    },
    evaluate: async predicate => {
      assert.match(predicate.toString(), /sb-.+-auth-token/);
      assert.match(predicate.toString(), /access_token/);
      events.push('session-check');
      return true;
    },
  };
  const result = await authenticateAcceptanceBrowserToEditor({
    harness: { page, server: { url: 'http://127.0.0.1:43117' } },
    env: {
      MEDCLIP_TEST_USER_A_EMAIL: 'user-a@example.test',
      MEDCLIP_TEST_USER_A_PASSWORD: 'secret',
    },
  });

  assert.deepEqual(result, {
    authenticated: true,
    sessionPresent: true,
    editorReady: true,
    advancedSettingsAttached: true,
  });
  assert.deepEqual(events, [
    'auth-navigation', 'email', 'password', 'signed-in-root', 'submit',
    'session-check', 'editor-navigation', 'editor-ready',
  ]);
  const helperSource = authenticateAcceptanceBrowserToEditor.toString();
  assert.doesNotMatch(helperSource, /openRequirementFlow|campusText|setInputFiles|consent|Generate Preview/);

  const smokeSource = runG2ASetupSmoke.toString();
  const authIndex = smokeSource.indexOf('await authenticateAcceptanceBrowserToEditor');
  const requirementIndex = smokeSource.indexOf('await openRequirementFlow');
  assert.ok(authIndex >= 0 && requirementIndex > authIndex);
  assert.doesNotMatch(smokeSource, /form\.auth-form|sb-.+-auth-token|details\.requirement-advanced/);
});

test('exact signed-in profile GET is reported as EXPECTED_FIXTURE_BLOCK', () => {
  const origin = 'https://project-ref.supabase.co';
  const url = `${origin}/rest/v1/profiles?select=id%2Cdisplay_name%2Cavatar_url%2Ccreated_at&id=eq.33333333-3333-4333-8333-333333333333`;
  const result = classifyExpectedFixtureBlock({ method: 'GET', url, supabaseOrigin: origin });
  assert.equal(result.fixture, 'auth-profile-read isolation');
  assert.equal(result.method, 'GET');
  assert.equal(result.pathPattern, '/rest/v1/profiles?select=id,display_name,avatar_url,created_at&id=eq.<uuid>');
});

test('unexpected Supabase profile requests and HTTP errors remain failures', () => {
  const origin = 'https://project-ref.supabase.co';
  const wrongQuery = `${origin}/rest/v1/profiles?select=*`;
  assert.equal(classifyExpectedFixtureBlock({ method: 'GET', url: wrongQuery, supabaseOrigin: origin }), null);
  assert.equal(classifyExpectedFixtureBlock({ method: 'PATCH', url: wrongQuery, supabaseOrigin: origin }), null);
  assert.equal(classifyHttpFailure({ method: 'GET', url: `${origin}/auth/v1/user`, status: 401 }).classification, 'HTTP_FAILURE');
  assert.equal(classifyHttpFailure({ method: 'POST', url: `${origin}/functions/v1/ai-credentials`, status: 500 }).classification, 'HTTP_FAILURE');
});

test('static export page-data 404 is separate and unrelated 404 remains an HTTP failure', () => {
  const staticNoise = classifyHttpFailure({ method: 'GET', url: 'http://127.0.0.1:3000/editor/__next.editor.__PAGE__.txt?_rsc=abc', status: 404 });
  const unrelated = classifyHttpFailure({ method: 'GET', url: 'http://127.0.0.1:3000/missing-route', status: 404 });
  const unknownPageData = classifyHttpFailure({ method: 'GET', url: 'http://127.0.0.1:3000/other/__next.other.__PAGE__.txt', status: 404 });
  assert.equal(staticNoise.classification, 'STATIC_EXPORT_PREFETCH_NOISE');
  assert.equal(unrelated.classification, 'HTTP_FAILURE');
  assert.equal(unknownPageData.classification, 'HTTP_FAILURE');
});

test('only canceled loopback static-export prefetches are separate from genuine network failures', () => {
  assert.equal(classifyNetworkFailure({ method: 'HEAD', url: 'http://127.0.0.1:3000/editor', errorText: 'net::ERR_ABORTED' }).classification, 'STATIC_EXPORT_PREFETCH_NOISE');
  assert.equal(classifyNetworkFailure({ method: 'GET', url: 'http://127.0.0.1:3000/__next._tree.txt', errorText: 'net::ERR_ABORTED' }).classification, 'STATIC_EXPORT_PREFETCH_NOISE');
  assert.equal(classifyNetworkFailure({ method: 'GET', url: 'https://project-ref.supabase.co/auth/v1/user', errorText: 'net::ERR_ABORTED' }).classification, 'NETWORK_REQUEST_FAILURE');
  assert.equal(classifyNetworkFailure({ method: 'GET', url: 'http://127.0.0.1:3000/api/data', errorText: 'net::ERR_CONNECTION_RESET' }).classification, 'NETWORK_REQUEST_FAILURE');
  assert.equal(classifyNetworkFailure({ method: 'HEAD', url: 'http://127.0.0.1:3000/api/data', errorText: 'net::ERR_ABORTED' }).classification, 'NETWORK_REQUEST_FAILURE');
});

test('same-page loopback media blob GET cancellations have a narrow expected class and preserve the raw URL', () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    const blobUrl = `blob:http://${host}:43117/123e4567-e89b-42d3-a456-426614174000`;
    const result = classifyNetworkFailure({
      method: 'GET',
      url: blobUrl,
      resourceType: 'media',
      errorText: 'net::ERR_ABORTED',
      pageUrl: `http://${host}:43117/editor`,
    });
    assert.equal(result.classification, 'EXPECTED_LOCAL_MEDIA_BLOB_CANCEL');
    assert.equal(result.pathPattern, blobUrl);
    assert.equal(result.rawUrl, blobUrl);
    assert.equal(result.resourceType, 'media');
    assert.equal(result.pathPattern.includes(`http://${host}:43117http://${host}:43117`), false);
  }
});

test('malformed HTTP and non-aborted or non-media local blob failures remain strict', () => {
  const pageUrl = 'http://127.0.0.1:43117/editor';
  const blobUrl = 'blob:http://127.0.0.1:43117/123e4567-e89b-42d3-a456-426614174000';
  const malformedHttp = 'http://127.0.0.1:43117/http://127.0.0.1:43117/123e4567-e89b-42d3-a456-426614174000';
  assert.equal(classifyNetworkFailure({ method: 'GET', url: malformedHttp, resourceType: 'media', errorText: 'net::ERR_ABORTED', pageUrl }).classification, 'NETWORK_REQUEST_FAILURE');
  assert.equal(classifyNetworkFailure({ method: 'GET', url: blobUrl, resourceType: 'media', errorText: 'net::ERR_FAILED', pageUrl }).classification, 'NETWORK_REQUEST_FAILURE');
  for (const resourceType of ['script', 'worker', 'fetch', 'document']) {
    assert.equal(classifyNetworkFailure({ method: 'GET', url: blobUrl, resourceType, errorText: 'net::ERR_ABORTED', pageUrl }).classification, 'NETWORK_REQUEST_FAILURE');
  }
});

test('remote, cross-origin, and non-GET blob cancellations remain strict', () => {
  const localBlob = 'blob:http://127.0.0.1:43117/123e4567-e89b-42d3-a456-426614174000';
  const remoteBlob = 'blob:https://unexpected.example/123e4567-e89b-42d3-a456-426614174000';
  const common = { resourceType: 'media', errorText: 'net::ERR_ABORTED', pageUrl: 'http://127.0.0.1:43117/editor' };
  assert.equal(classifyNetworkFailure({ method: 'GET', url: remoteBlob, ...common }).classification, 'NETWORK_REQUEST_FAILURE');
  assert.equal(classifyNetworkFailure({ method: 'GET', url: localBlob, ...common, pageUrl: 'http://127.0.0.1:43118/editor' }).classification, 'NETWORK_REQUEST_FAILURE');
  assert.equal(classifyNetworkFailure({ method: 'POST', url: localBlob, ...common }).classification, 'NETWORK_REQUEST_FAILURE');
});

test('Hugging Face failures remain strict while static-export prefetch policy is unchanged', () => {
  const huggingFace = classifyNetworkFailure({
    method: 'GET',
    url: 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/tokenizer.json',
    resourceType: 'fetch',
    errorText: 'net::ERR_BLOCKED_BY_CLIENT',
    pageUrl: 'http://127.0.0.1:43117/editor',
  });
  const staticPrefetch = classifyNetworkFailure({
    method: 'GET',
    url: 'http://127.0.0.1:43117/editor/__next.editor.__PAGE__.txt',
    resourceType: 'fetch',
    errorText: 'net::ERR_ABORTED',
    pageUrl: 'http://127.0.0.1:43117/editor',
  });
  assert.equal(huggingFace.classification, 'NETWORK_REQUEST_FAILURE');
  assert.equal(staticPrefetch.classification, 'STATIC_EXPORT_PREFETCH_NOISE');
  assert.equal(staticPrefetch.pathPattern, '/editor/__next.editor.__PAGE__.txt');
});

test('R11E driver has all requested gates, resumes at Gate 2, and stops at first defect', async () => {
  assert.deepEqual(R11E_GATES.map(([id]) => id), ['G2-A','G2-B','G2-C','G2-D','G2-E','G2-F','G2-G','G2-H','G2-I','G2-J','G2-K','G2-L','G2-M','G2-N','G2-O','G2-P','G2-Q','G2-R']);
  const seen = [];
  await assert.rejects(runGateSequence(R11E_GATES, async ({ id }) => {
    seen.push(id);
    if (id === 'G2-D') throw new Error('freeze gate');
  }), /freeze gate/);
  assert.deepEqual(seen, ['G2-A','G2-B','G2-C','G2-D']);
});

test('execution scenario is an existing production-planner fixture with semantic evidence and legal actions', () => {
  const audit = auditR11EScenarioContracts();
  assert.equal(audit.executionScenario.source, R11E_SCENARIO_CONTRACT.executionScenario.source);
  assert.ok(audit.executionScenario.entries >= 5);
  assert.ok(audit.executionScenario.actions >= 3);
  assert.equal(audit.executionScenario.localEvidenceCount, 12);
  assert.equal(audit.executionScenario.planningState, 'READY_TO_PLAN');
  assert.deepEqual(audit.executionScenario.protectedClipIds, ['clip-0']);
  assert.ok(audit.executionScenario.unprotectedEditableIntervals >= 1);
});

test('execution fixture supports real ACCEPT, REJECT, and trusted MODIFY review decisions', () => {
  const audit = auditR11EScenarioContracts();
  assert.deepEqual(audit.executionScenario.reviewDecisions, ['ACCEPTED', 'ACCEPTED', 'MODIFIED', 'REJECTED', 'ACCEPTED']);
  assert.equal(audit.executionScenario.modifyAssetId, 'asset-ecg-alt');
});

test('repair scenario uses immutable evidence and production-derived repetition repair', () => {
  const audit = auditR11EScenarioContracts();
  assert.equal(audit.repairScenario.source, R11E_SCENARIO_CONTRACT.repairScenario.source);
  assert.deepEqual(audit.repairScenario.defectCodes, ['IMMEDIATE_ASSET_REPEAT', 'RECENT_ASSET_REUSE']);
  assert.equal(audit.repairScenario.repairEligibility, 'ELIGIBLE');
  assert.equal(audit.repairScenario.repairActionType, 'MATCH_ASSET_TO_SEGMENT');
  assert.equal(audit.repairScenario.repairClipId, 'clip-1');
  assert.equal(audit.repairScenario.repairAssetId, 'asset-anatomy');
  assert.equal(audit.repairScenario.reEvaluationCount, 1);
  assert.equal(audit.repairScenario.finalStatus, 'REPAIR_FINAL_PASS');
});

function createDriverOnlyHarness() {
  let closed = false;
  const report = {
    providerCalls: 0,
    get harnessExitedCleanly() { return closed; },
  };
  return {
    report,
    fixtures: Object.freeze({}),
    async collect() { return report; },
    async close() {
      closed = true;
      return {
        ...report,
        browserClosed: true,
        serverStopped: true,
        ownedPidsGone: true,
        harnessExitedCleanly: true,
      };
    },
  };
}

const DRIVER_FIXTURE_PHASES = Object.freeze({
  campus: Object.freeze({ fixtureIdentity: 'CAMPUS' }),
  final: Object.freeze({ fixtureIdentity: 'FINAL' }),
});

function driverFixtureResolver({ id }) {
  if (id === 'G2-A' || id === 'G2-B') return DRIVER_FIXTURE_PHASES.campus;
  if (['G2-C', 'G2-D', 'G2-E', 'G2-F', 'G2-G', 'G2-H', 'G2-I', 'G2-J', 'G2-K'].includes(id)) {
    return { fixtureIdentity: 'EXECUTION', editorInputFixture: createExecutionEditorFixtureV1() };
  }
  if (['G2-L', 'G2-M', 'G2-N'].includes(id)) {
    return { fixtureIdentity: 'REPAIR', editorInputFixture: createImmutableRepetitionEditorFixtureV1() };
  }
  if (['G2-O', 'G2-P', 'G2-Q', 'G2-R'].includes(id)) return DRIVER_FIXTURE_PHASES.final;
  return undefined;
}

test('R11E legacy static fixtures remain lifetime-scoped and setup contract is unchanged', async () => {
  const staticFixtures = { providerAvailability: { provider: 'deepseek', status: 'connected' } };
  const observed = [];
  let setupArguments;
  let launchOptions;
  const harness = createDriverOnlyHarness();
  const scenarioModule = {
    fixtures: staticFixtures,
    setup(args) { setupArguments = args; return Object.freeze({ scenario: 'legacy' }); },
    runGate({ id, gateFixtures, session }) {
      observed.push({ id, gateFixtures, session });
    },
  };

  await runR11E({
    scenarioModule,
    launchBrowser: async options => { launchOptions = options; return harness; },
  });

  assert.deepEqual(launchOptions.fixtures, staticFixtures);
  assert.equal(Object.isFrozen(launchOptions.fixtures), true);
  assert.deepEqual(setupArguments, { harness });
  assert.equal(observed.length, R11E_GATES.length);
  assert.equal(observed.every(item => item.gateFixtures === launchOptions.fixtures), true);
  assert.equal(observed.every(item => item.session.scenario === 'legacy'), true);
});

test('R11E gate fixture resolver supplies campus, H4B execution, and repair contexts without leakage', async () => {
  const intentResolver = context => context.input?.editingRequirement ? INTENT_RESPONSES.campus : null;
  const baseFixtures = { syntheticIntentResponseResolver: intentResolver };
  const observed = [];
  let installedFixtures;
  const scenarioModule = {
    fixtures: baseFixtures,
    resolveFixturesForGate(args) {
      assert.equal(args.baseFixtures.syntheticIntentResponseResolver, intentResolver);
      return driverFixtureResolver(args);
    },
    runGate({ id, gateFixtures }) {
      observed.push({ id, gateFixtures });
    },
  };

  await runR11E({
    scenarioModule,
    launchBrowser: async options => {
      installedFixtures = options.fixtures;
      return createDriverOnlyHarness();
    },
  });

  assert.equal(installedFixtures.syntheticIntentResponseResolver, intentResolver);
  assert.equal(observed.find(item => item.id === 'G2-A').gateFixtures.fixtureIdentity, 'CAMPUS');
  assert.equal(observed.find(item => item.id === 'G2-C').gateFixtures.editorInputFixture.fixtureId,
    'medical-review-execution-v1');
  assert.equal(observed.find(item => item.id === 'G2-L').gateFixtures.editorInputFixture.fixtureId,
    'medical-adjacent-repetition-v1');
  const execution = observed.find(item => item.id === 'G2-K').gateFixtures;
  const repair = observed.find(item => item.id === 'G2-L').gateFixtures;
  assert.notEqual(execution, repair);
  assert.equal(execution.fixtureIdentity, 'EXECUTION');
  assert.equal(repair.fixtureIdentity, 'REPAIR');
  assert.equal(Object.isFrozen(execution), true);
  assert.equal(Object.isFrozen(repair), true);
});

test('gate fixture resolution is order-independent and does not use completed count as phase state', async () => {
  const scenarioModule = { resolveFixturesForGate: driverFixtureResolver };
  const baseFixtures = Object.freeze({});
  const order = ['G2-L', 'G2-A', 'G2-C', 'G2-L'];
  const completedInputs = [['G2-A'], ['G2-A', 'G2-B'], [], ['G2-A', 'G2-B', 'G2-C']];
  const resolved = [];
  for (let index = 0; index < order.length; index += 1) {
    resolved.push(await resolveR11EGateFixtures({
      scenarioModule,
      id: order[index],
      label: 'driver-only fixture test',
      completed: completedInputs[index],
      baseFixtures,
      session: Object.freeze({}),
    }));
  }
  assert.deepEqual(resolved.map(item => item.fixtureIdentity), ['REPAIR', 'CAMPUS', 'EXECUTION', 'REPAIR']);
  assert.notEqual(resolved[0], resolved[3]);
  assert.equal(resolved[0].editorInputFixture.fixtureId, 'medical-adjacent-repetition-v1');
  assert.equal(resolved[2].editorInputFixture.fixtureId, 'medical-review-execution-v1');
});

test('R11E resume-from a later gate resolves its fixture before the first executed handler', async () => {
  const observed = [];
  await runR11E({
    resumeFrom: 'G2-F',
    scenarioModule: {
      resolveFixturesForGate: driverFixtureResolver,
      runGate({ id, completed, gateFixtures }) {
        observed.push({ id, completed, gateFixtures });
      },
    },
    launchBrowser: async () => createDriverOnlyHarness(),
  });
  assert.equal(observed[0].id, 'G2-F');
  assert.deepEqual(observed[0].completed, []);
  assert.equal(observed[0].gateFixtures.fixtureIdentity, 'EXECUTION');
  assert.equal(observed[0].gateFixtures.editorInputFixture.fixtureId, 'medical-review-execution-v1');
});

test('R11E dynamic fixture contract fails closed before an unmapped gate handler executes', async () => {
  let handlerCalls = 0;
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await assert.rejects(
      runR11E({
        resumeFrom: 'G2-C',
        scenarioModule: {
          resolveFixturesForGate: () => undefined,
          runGate() { handlerCalls += 1; },
        },
        launchBrowser: async () => createDriverOnlyHarness(),
      }),
      error => {
        assert.match(error.message, /R11E FIXTURE CONTRACT: resolveFixturesForGate returned no valid fixture context for G2-C/);
        assert.equal(error.harnessFailure, true);
        assert.equal(error.acceptanceGate, 'G2-C');
        return true;
      },
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(handlerCalls, 0);
  assert.equal(errors.some(line => line.includes('FAILURE CLASSIFICATION = HARNESS FAILURE')), true);
});

test('R11E rejects invalid dynamic hook and invalid H4B editor fixture shapes', async () => {
  let launchCalls = 0;
  await assert.rejects(
    runR11E({
      scenarioModule: { resolveFixturesForGate: 'G2-C' },
      launchBrowser: async () => { launchCalls += 1; return createDriverOnlyHarness(); },
    }),
    /R11E FIXTURE CONTRACT: resolveFixturesForGate must be a function/,
  );
  assert.equal(launchCalls, 0);
  await assert.rejects(
    resolveR11EGateFixtures({
      scenarioModule: { resolveFixturesForGate: () => ({ editorInputFixture: { fixtureId: 'malformed' } }) },
      id: 'G2-C',
      label: 'second execution-capable fixture',
    }),
    /R11E FIXTURE CONTRACT: invalid editorInputFixture for G2-C/,
  );
});
