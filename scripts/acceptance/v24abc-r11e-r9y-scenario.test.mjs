import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildConstraintSetV1, confirmDirectSelectionV1 } from '../../app/editor-constraint-grounding.ts';
import { R11E_GATES } from './v24abc-r11e.mjs';
import {
  CAMPUS_SOURCE_REQUEST, DURABLE_R11E_GATE_ORDER, DURABLE_R11E_PHASE_BY_GATE,
  assertCampusProject, assertCampusStructuredGrounding, assertG2ALocatorCount,
  captureCampusFilenameFallbackEvidence,
  createCampusMediaFiles, createDurableR11EScenario,
  fixtures, resolveFixturesForGate, syntheticIntentResponseResolver,
  readCampusAudioUploadState, resolveCampusSpeechGroundingCandidate,
  readCampusVideoUploadState, uploadCampusAudioAndWait, uploadCampusVideosAndWait,
  verifyDurableStaleAndProtectedContracts,
} from './v24abc-r11e-r9y-scenario.mjs';
import { loadCampusScenarioEvidence } from './v24abc-r11e-scenario-contract.mjs';

function fakeAdapters(calls = []) {
  const call = (name, value) => async () => { calls.push(name); return structuredClone(value); };
  return {
    authenticateAcceptanceBrowserToEditor: call('auth', { authenticated: true }),
    prepareCampusSafeNoChange: call('campus', { proposalStatus: 'SAFE_NO_CHANGE', projectFingerprint: 'campus-fingerprint', projectSnapshot: {} }),
    completeCampusZeroActionReview: call('zero', { reviewLifecycle: 'REVIEWED_NO_ACTIONS', historyRecordCommitted: false }),
    prepareRetainedExecutionFixture: call('execution-fixture', { fixtureId: 'medical-review-execution-v1' }),
    beginRetainedExecutionPlanning: call('execution-plan', { lifecycleStatus: 'PENDING_REVIEW', compiledActionCount: 4 }),
    applyRetainedExecutionHumanReview: call('execution-review', {
      requiredEntryCount: 5,
      pendingRequiredEntryCount: 0,
      autoApproval: false,
      reviewBypass: false,
      acceptedEntries: [{ intervalId: 'interval-consultation' }, { intervalId: 'interval-anatomy' }, { intervalId: 'interval-recovery' }],
      rejectedEntries: [{ intervalId: 'interval-treatment' }],
      modifiedEntries: [{ intervalId: 'interval-ecg', selectedAssetId: 'asset-ecg-alt' }],
    }),
    preflightRetainedExecution: call('execution-preflight', { canonicalValidator: 'PASS', hardConstraintValidator: 'PASS', executableActionCount: 3 }),
    executeRetainedReviewedPlan: call('execution', {
      preProjectFingerprint: 'execution-pre', postProjectFingerprint: 'execution-post',
      preProjectSnapshot: { title: 'pre' }, postProjectSnapshot: { title: 'post' },
      snapshot: { execution: { appliedCount: 3, failedCount: 0 }, evaluator: { realizedActionCount: 3, hardConstraintCompliance: 'PASS' } },
    }),
    exerciseRetainedExecutionUndoRedo: call('execution-undo-redo', { exactUndo: true, exactRedo: true }),
    prepareRetainedRepairFixture: call('repair-fixture', { fixtureId: 'medical-adjacent-repetition-v1' }),
    beginRetainedRepairPlanning: call('repair-plan', { defectCodes: ['IMMEDIATE_ASSET_REPEAT', 'RECENT_ASSET_REUSE'] }),
    applyRetainedRepairHumanReview: call('repair-review', {
      reviewLifecycle: 'REPAIR_READY_TO_EXECUTE',
      provenance: 'REPAIR_USER_ACCEPTED',
      autoApproval: false,
      reviewBypass: false,
    }),
    preflightRetainedRepair: call('repair-preflight', {
      canonicalValidator: 'PASS',
      hardConstraintValidator: 'PASS',
      protectedViolationCount: 0,
    }),
    executeRetainedRepair: call('repair', { finalStatus: 'REPAIR_FINAL_PASS', appliedActionCount: 1, failedActionCount: 0 }),
    evaluateRetainedRepairResult: call('repair-evaluate', { evaluationCount: 1, remainingDefectCount: 0, finalStatus: 'REPAIR_FINAL_PASS' }),
    exerciseRetainedRepairUndoRedo: call('repair-undo-redo', { exactUndo: true, exactRedo: true }),
    verifyRetainedRepairRoundPolicy() { calls.push('repair-round'); return { maxRepairRounds: 1 }; },
    verifyDurableStaleAndProtectedContracts() {
      calls.push('stale');
      return {
        executionStaleCode: 'STALE_PROPOSAL', repairStaleCode: 'STALE_REPAIR',
        protectedRepairCode: 'HARD_CONSTRAINT_BLOCKED', emptyNonEnforcingFalseStale: false,
      };
    },
    prepareRetainedOwnedMedia: call('media', { documentId: 'current-document', fixtureAssetId: 'seed-0', boundMediaAssetId: 'seed-0', clipReferencedAssetId: 'seed-0' }),
    proveRetainedOwnedMediaPreview: call('preview', { playbackTimeAdvanced: true }),
    exportAndDownloadRetainedOwnedMedia: call('export', {
      exported: { outputExists: true }, downloaded: { fileExists: true, tempCleanup: 'PASS' },
    }),
    cleanupRetainedOwnedMedia: call('media-cleanup', { visualObjectUrlRevokedByProduct: true }),
  };
}

function fakeHarness() {
  const report = {
    providerCalls: 0, unclassifiedConsoleErrors: [], pageErrors: [], unhandledRejections: [],
    criticalRuntimeErrors: [], unexpectedBlockedRequests: [],
  };
  return { page: {}, async collect() { return report; } };
}

function campusVisibilityPage({
  insightText = '已识别：医生问诊', insightCount = 1, restoreWorkspace = true,
} = {}) {
  const calls = [];
  let editorOpen = true;
  let workspaceVisible = false;
  const editor = {
    async count() { return 1; },
    async waitFor({ state }) {
      calls.push(`editor:${state}`);
      if (state === 'visible' && !editorOpen) throw new Error('TimelineEditor is not visible');
      if (state === 'detached' && editorOpen) throw new Error('TimelineEditor remains attached');
    },
  };
  const workspace = {
    async count() { return 1; },
    async isVisible() { calls.push('workspace:isVisible'); return workspaceVisible; },
    async waitFor({ state }) {
      calls.push(`workspace:${state}`);
      if (state === 'visible' && !workspaceVisible) throw new Error('Workspace remained hidden after editor close');
    },
  };
  const insight = {
    async count() { return insightCount; },
    async waitFor({ state }) {
      calls.push(`insight:${state}`);
      if (state === 'visible' && !workspaceVisible) throw new Error('Insight cannot be visible in a hidden workspace');
    },
    async textContent() { return insightText; },
  };
  const row = {
    async count() { return 1; },
    async waitFor({ state }) {
      calls.push(`row:${state}`);
      if (state === 'visible' && !workspaceVisible) throw new Error('Teacher row cannot be visible in a hidden workspace');
    },
    locator(selector) {
      assert.equal(selector, '.asset-insight');
      return insight;
    },
  };
  const close = {
    async count() { return 1; },
    async isVisible() { return editorOpen; },
    async isEnabled() { return editorOpen; },
    async click() {
      calls.push('close:click');
      editorOpen = false;
      workspaceVisible = restoreWorkspace;
    },
  };
  return {
    calls,
    page: {
      locator(selector, options) {
        if (selector === 'section.timeline-editor-shell[aria-label="生成后继续剪辑"]') return editor;
        if (selector === 'section.workspace#workspace') return workspace;
        if (selector === '.asset-row') {
          assert.equal(options?.hasText, 'teacher-speech.mp4');
          return row;
        }
        throw new Error(`Unexpected locator ${selector}`);
      },
      getByRole(role, options) {
        assert.equal(role, 'button');
        assert.deepEqual(options, { name: '关闭编辑器', exact: true });
        return close;
      },
    },
  };
}

function campusGroundingPage({ targetCount = 1, availableCandidateCount = 2 } = {}) {
  const target = { async count() { return targetCount; }, async click() {} };
  const card = {
    filter(options) {
      assert.deepEqual(options, { hasText: '老师完整讲话' });
      return this;
    },
    locator(selector) {
      assert.equal(selector, '.creative-intent-grounding-candidates button');
      return { async count() { return availableCandidateCount; } };
    },
    getByRole(role, options) {
      assert.equal(role, 'button');
      assert.deepEqual(options, {
        name: '确认保护字幕范围 00:00–00:35 · 老师完整讲话 医生问诊', exact: true,
      });
      return target;
    },
  };
  return {
    target,
    page: {
      locator(selector) {
        assert.equal(selector, '.creative-intent-grounding-card');
        return card;
      },
    },
  };
}

function campusAudioUploadPage({
  initialRows = [], settledRows = [], waitError = null, documentIdentity = 'http://localhost/editor|12345',
} = {}) {
  let rows = structuredClone(initialRows);
  const calls = [];
  const snapshot = (filename, durationText) => {
    const matching = rows.filter(row => row.name === filename);
    return {
      documentIdentity, filename,
      matchingRowCount: matching.length,
      visibleMatchingRowCount: matching.filter(row => row.visible).length,
      readyMatchingRowCount: matching.filter(row => row.ready).length,
      durationReadyMatchingRowCount: matching.filter(row => row.text?.includes(durationText)).length,
      rowIdentities: rows.map(row => ({
        name: row.name, visible: row.visible, ready: row.ready, text: row.text,
      })),
    };
  };
  const page = {
    async evaluate(_reader, input) {
      calls.push('evaluate');
      return snapshot(input.filename, input.expectedDurationText);
    },
    async waitForFunction(_predicate, input) {
      calls.push('waitForFunction');
      rows = structuredClone(settledRows);
      if (waitError) throw waitError;
      const current = snapshot(input.filename, input.durationText);
      const ready = current.documentIdentity === input.documentIdentity
        && current.visibleMatchingRowCount > 0 && current.readyMatchingRowCount > 0
        && current.durationReadyMatchingRowCount > 0;
      if (!ready) throw new Error('bounded structured wait did not settle');
    },
  };
  const audioInput = {
    async setInputFiles(file) { calls.push(`setInputFiles:${file.name}`); },
  };
  return { page, audioInput, calls };
}

function campusVideoUploadPage({
  initialRows = [], settledRows = [], documentIdentity = 'http://localhost/editor|12345',
} = {}) {
  let rows = structuredClone(initialRows);
  const calls = [];
  const snapshot = (filename, durationText) => {
    const matching = rows.filter(row => row.name === filename);
    return {
      documentIdentity, filename,
      matchingRowCount: matching.length,
      visibleMatchingRowCount: matching.filter(row => row.visible).length,
      readyMatchingRowCount: matching.filter(row => row.ready && row.text?.includes(durationText)).length,
      durationReadyMatchingRowCount: matching.filter(row => row.text?.includes(durationText)).length,
      rowIdentities: rows.map(row => ({
        name: row.name, visible: row.visible, ready: row.ready, text: row.text,
      })),
    };
  };
  const page = {
    async evaluate(_reader, input) {
      calls.push(`evaluate:${input.filename}`);
      return snapshot(input.filename, input.durationText);
    },
    async waitForFunction(_predicate, input) {
      calls.push('waitForFunction');
      rows = structuredClone(settledRows);
      const ready = input.specs.every(spec => {
        const current = snapshot(spec.filename, spec.expectedDurationText);
        return current.documentIdentity === input.documentIdentity
          && current.visibleMatchingRowCount > 0 && current.readyMatchingRowCount > 0;
      });
      if (!ready) throw new Error('bounded structured video wait did not settle');
    },
  };
  const videoInput = {
    async setInputFiles(files) { calls.push(`setInputFiles:${files.map(file => file.name).join(',')}`); },
  };
  return { page, videoInput, calls };
}

test('durable module exports the exact R11E order and repository interface without temp/auth duplication', async () => {
  assert.deepEqual(DURABLE_R11E_GATE_ORDER, R11E_GATES.map(([id]) => id));
  const scenario = createDurableR11EScenario(fakeAdapters());
  for (const member of ['fixtures', 'setup', 'beforeTeardown', 'resolveFixturesForGate', 'runGate']) {
    assert.ok(scenario[member], `missing scenario interface member ${member}`);
  }
  const source = await readFile(new URL('./v24abc-r11e-r9y-scenario.mjs', import.meta.url), 'utf8');
  assert.match(source, /authenticateAcceptanceBrowserToEditor/);
  assert.doesNotMatch(source, /input\[type=["']password["']\]|MEDCLIP_TEST_USER_A_PASSWORD/);
  assert.doesNotMatch(source, /%TEMP%|os\.tmpdir|currentPhase|phaseCounter/);
  assert.doesNotMatch(source, /download\.path\(/);
});

test('every important G2-A expected-one assertion has a stable diagnostic identity', async () => {
  const scenarioSource = await readFile(new URL('./v24abc-r11e-r9y-scenario.mjs', import.meta.url), 'utf8');
  const harnessSource = await readFile(new URL('./medclip-browser-harness.mjs', import.meta.url), 'utf8');
  const identities = [
    'G2A_AUDIO_INPUT_COUNT', 'G2A_AUDIO_UPLOAD_ROW_COUNT', 'G2A_VIDEO_INPUT_COUNT',
    'G2A_TEACHER_UPLOAD_ROW_COUNT', 'G2A_ENDING_UPLOAD_ROW_COUNT', 'G2A_SUBTITLE_SOURCE_CONTROL_COUNT',
    'G2A_SUBTITLE_TEXTAREA_COUNT', 'G2A_CONSENT_CHECKBOX_COUNT', 'G2A_GENERATE_PREVIEW_CONTROL_COUNT',
    'G2A_TIMELINE_EDITOR_COUNT', 'G2A_WORKSPACE_COUNT', 'G2A_EDITOR_CLOSE_CONTROL_COUNT',
    'G2A_TEACHER_MEDIA_ROW_COUNT', 'G2A_TEACHER_ASSET_INSIGHT_COUNT', 'G2A_REQUIREMENT_DIALOG_COUNT',
    'G2A_ANALYZE_INTENT_CONTROL_COUNT', 'G2A_TEACHER_GROUNDING_TARGET_COUNT',
    'G2A_ENDING_GROUNDING_TARGET_COUNT',
    'G2A_PROPOSAL_GENERATE_CONTROL_COUNT', 'G2A_KEEP_CURRENT_RESULT_COUNT',
  ];
  identities.forEach(identity => assert.match(scenarioSource, new RegExp(identity)));
  assert.match(scenarioSource, /G2A_AUDIO_UPLOAD_ROW_READY/);
  assert.match(scenarioSource, /G2A_TEACHER_VIDEO_UPLOAD_READY/);
  assert.match(scenarioSource, /G2A_ENDING_VIDEO_UPLOAD_READY/);
  for (const identity of [
    'REQUIREMENT_ADVANCED_SECTION_COUNT', 'REQUIREMENT_ADVANCED_SUMMARY_COUNT',
    'REQUIREMENT_OPEN_CONTROL_COUNT', 'G2A_NEGOTIATION_OPTION_B_RESOLUTION',
  ]) assert.match(harnessSource, new RegExp(identity));
  assert.equal(identities.length + 4, 24);
});

test('campus audio upload waits for the exact current row to appear asynchronously and become metadata-ready', async () => {
  const unrelated = { name: 'other.wav', visible: true, ready: true, text: '音频 1 · 00:12' };
  const current = { name: 'campus-38s.wav', visible: true, ready: true, text: '音频 2 · 00:38' };
  const { page, audioInput, calls } = campusAudioUploadPage({
    initialRows: [unrelated], settledRows: [unrelated, current],
  });
  const evidence = await uploadCampusAudioAndWait({
    page, audioInput, file: { name: 'campus-38s.wav' }, timeout: 50,
  });
  assert.deepEqual(evidence, {
    filename: 'campus-38s.wav', documentIdentity: 'http://localhost/editor|12345',
    matchingRowCount: 1, visibleMatchingRowCount: 1, readyMatchingRowCount: 1,
    durationReadyMatchingRowCount: 1, expectedDurationText: '00:38',
  });
  assert.deepEqual(calls, ['evaluate', 'setInputFiles:campus-38s.wav', 'waitForFunction', 'evaluate']);
});

test('campus audio readiness fails closed for duplicate exact rows with bounded diagnostics', async () => {
  const duplicate = { name: 'campus-38s.wav', visible: true, ready: true, text: '音频 · 00:38' };
  const { page, audioInput } = campusAudioUploadPage({ settledRows: [duplicate, duplicate] });
  await assert.rejects(
    uploadCampusAudioAndWait({ page, audioInput, file: { name: 'campus-38s.wav' }, timeout: 50 }),
    /G2A_AUDIO_UPLOAD_ROW_COUNT.*expectedFilename=campus-38s\.wav.*matchingRowCount=2.*rowIdentities=/,
  );
});

test('campus audio readiness fails closed for wrong filename, missing, hidden, and never-ready rows', async () => {
  for (const settledRows of [
    [{ name: 'wrong.wav', visible: true, ready: true, text: '音频 · 00:38' }],
    [],
    [{ name: 'campus-38s.wav', visible: false, ready: true, text: '音频 · 00:38' }],
    [{ name: 'campus-38s.wav', visible: true, ready: false, text: '音频 · 读取中' }],
  ]) {
    const { page, audioInput } = campusAudioUploadPage({ settledRows });
    await assert.rejects(
      uploadCampusAudioAndWait({ page, audioInput, file: { name: 'campus-38s.wav' }, timeout: 50 }),
      /G2A_AUDIO_UPLOAD_ROW_READY.*expectedFilename=campus-38s\.wav/,
    );
  }
});

test('campus audio readiness rejects a stale same-name row before starting a new upload', async () => {
  const stale = { name: 'campus-38s.wav', visible: true, ready: true, text: '音频 · 00:38' };
  const { page, audioInput, calls } = campusAudioUploadPage({ initialRows: [stale], settledRows: [stale] });
  await assert.rejects(
    uploadCampusAudioAndWait({ page, audioInput, file: { name: 'campus-38s.wav' }, timeout: 50 }),
    /G2A_AUDIO_UPLOAD_STALE_ROW_COUNT.*expected=0 actual=1/,
  );
  assert.equal(calls.some(call => call.startsWith('setInputFiles:')), false);
});

test('campus audio readiness uses structured waiting without fixed sleeps', async () => {
  const source = await readFile(new URL('./v24abc-r11e-r9y-scenario.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export async function uploadCampusAudioAndWait');
  const end = source.indexOf('export async function resolveCampusSpeechGroundingCandidate', start);
  const helper = source.slice(start, end);
  assert.match(helper, /page\.waitForFunction/);
  assert.doesNotMatch(helper, /waitForTimeout|setTimeout|\bsleep\s*\(/);
  const { page } = campusAudioUploadPage();
  assert.equal((await readCampusAudioUploadState(page, { filename: 'campus-38s.wav' })).matchingRowCount, 0);
});

const campusVideoFiles = Object.freeze([
  Object.freeze({ name: 'teacher-speech.mp4' }),
  Object.freeze({ name: 'campus-logo.mp4' }),
]);
const readyTeacherVideo = Object.freeze({
  name: 'teacher-speech.mp4', visible: true, ready: true, text: '视频 · 00:35',
});
const readyEndingVideo = Object.freeze({
  name: 'campus-logo.mp4', visible: true, ready: true, text: '视频 · 00:03',
});

test('campus teacher and ending videos appear asynchronously with exact identities while unrelated rows coexist', async () => {
  const unrelated = { name: 'other.mp4', visible: true, ready: true, text: '视频 · 00:12' };
  const { page, videoInput, calls } = campusVideoUploadPage({
    initialRows: [unrelated], settledRows: [unrelated, readyTeacherVideo, readyEndingVideo],
  });
  const evidence = await uploadCampusVideosAndWait({ page, videoInput, files: campusVideoFiles, timeout: 50 });
  assert.equal(evidence.teacher.filename, 'teacher-speech.mp4');
  assert.equal(evidence.teacher.expectedDurationText, '00:35');
  assert.equal(evidence.ending.filename, 'campus-logo.mp4');
  assert.equal(evidence.ending.expectedDurationText, '00:03');
  assert.deepEqual(calls, [
    'evaluate:teacher-speech.mp4', 'evaluate:campus-logo.mp4',
    'setInputFiles:teacher-speech.mp4,campus-logo.mp4', 'waitForFunction',
    'evaluate:teacher-speech.mp4', 'evaluate:campus-logo.mp4',
  ]);
});

test('campus video readiness fails closed for duplicate exact teacher and ending rows', async () => {
  for (const [rows, pattern] of [
    [[readyTeacherVideo, readyTeacherVideo, readyEndingVideo], /G2A_TEACHER_UPLOAD_ROW_COUNT.*matchingRowCount=2/],
    [[readyTeacherVideo, readyEndingVideo, readyEndingVideo], /G2A_ENDING_UPLOAD_ROW_COUNT.*matchingRowCount=2/],
  ]) {
    const { page, videoInput } = campusVideoUploadPage({ settledRows: rows });
    await assert.rejects(
      uploadCampusVideosAndWait({ page, videoInput, files: campusVideoFiles, timeout: 50 }), pattern,
    );
  }
});

test('campus video readiness fails closed for wrong filenames and each missing expected row', async () => {
  for (const [rows, pattern] of [
    [[{ name: 'wrong.mp4', visible: true, ready: true, text: '视频 · 00:35' }, readyEndingVideo], /G2A_TEACHER_VIDEO_UPLOAD_READY/],
    [[readyEndingVideo], /G2A_TEACHER_VIDEO_UPLOAD_READY/],
    [[readyTeacherVideo], /G2A_ENDING_VIDEO_UPLOAD_READY/],
  ]) {
    const { page, videoInput } = campusVideoUploadPage({ settledRows: rows });
    await assert.rejects(
      uploadCampusVideosAndWait({ page, videoInput, files: campusVideoFiles, timeout: 50 }), pattern,
    );
  }
});

test('campus video readiness rejects a stale exact-name row before uploading the pair', async () => {
  const { page, videoInput, calls } = campusVideoUploadPage({
    initialRows: [readyTeacherVideo], settledRows: [readyTeacherVideo, readyEndingVideo],
  });
  await assert.rejects(
    uploadCampusVideosAndWait({ page, videoInput, files: campusVideoFiles, timeout: 50 }),
    /G2A_TEACHER_VIDEO_UPLOAD_STALE_ROW_COUNT.*matchingRowCount=1/,
  );
  assert.equal(calls.some(call => call.startsWith('setInputFiles:')), false);
});

test('all campus uploads use structured readiness helpers and leave no immediate async final-state assertion', async () => {
  const source = await readFile(new URL('./v24abc-r11e-r9y-scenario.mjs', import.meta.url), 'utf8');
  const prepareStart = source.indexOf('export async function prepareCampusSafeNoChange');
  const prepareEnd = source.indexOf('\nexport ', prepareStart + 1);
  const prepare = source.slice(prepareStart, prepareEnd < 0 ? source.length : prepareEnd);
  assert.doesNotMatch(prepare, /\.setInputFiles\s*\(/);
  assert.match(prepare, /uploadCampusAudioAndWait/);
  assert.match(prepare, /uploadCampusVideosAndWait/);
  const readinessStart = source.indexOf('export async function uploadCampusAudioAndWait');
  const readinessEnd = source.indexOf('async function uniqueVisibleEnabled', readinessStart);
  const readiness = source.slice(readinessStart, readinessEnd);
  assert.equal((readiness.match(/\.setInputFiles\s*\(/g) ?? []).length, 2);
  assert.equal((readiness.match(/page\.waitForFunction/g) ?? []).length, 2);
  assert.doesNotMatch(readiness, /waitForTimeout|setTimeout|\bsleep\s*\(/);
  const { page } = campusVideoUploadPage();
  assert.equal((await readCampusVideoUploadState(page, {
    filename: 'teacher-speech.mp4', expectedDurationText: '00:35',
  })).matchingRowCount, 0);
});

test('fixture resolution is gate-semantic, immutable, resume-safe, and phase isolated', async () => {
  const expected = {
    'G2-A': 'CAMPUS', 'G2-B': 'CAMPUS', 'G2-C': 'EXECUTION', 'G2-F': 'EXECUTION',
    'G2-K': 'EXECUTION', 'G2-L': 'REPAIR', 'G2-O': 'REPAIR', 'G2-P': 'REPAIR',
    'G2-Q': 'REPAIR', 'G2-R': 'FINAL',
  };
  for (const id of ['G2-Q', 'G2-A', 'G2-F', 'G2-P', 'G2-L', 'G2-B', 'G2-R']) {
    const resolved = await resolveFixturesForGate({ id, baseFixtures: fixtures });
    assert.equal(resolved.phase, expected[id]);
    assert.equal(Object.isFrozen(resolved), true);
    if (resolved.phase === 'EXECUTION') assert.equal(resolved.editorInputFixture.fixtureId, 'medical-review-execution-v1');
    if (resolved.phase === 'REPAIR') assert.equal(resolved.editorInputFixture.fixtureId, 'medical-adjacent-repetition-v1');
  }
  assert.equal(DURABLE_R11E_PHASE_BY_GATE['G2-P'], 'REPAIR');
  assert.equal(DURABLE_R11E_PHASE_BY_GATE['G2-Q'], 'REPAIR');
});

test('request-aware provider-free intent routing is order independent and fails closed', async () => {
  const request = editingRequirement => ({ task: 'editor.creative_intent_parse', input: { editingRequirement } });
  const values = [
    await syntheticIntentResponseResolver(request(REPAIR_SOURCE_REQUEST)),
    await syntheticIntentResponseResolver(request(CAMPUS_SOURCE_REQUEST)),
    await syntheticIntentResponseResolver(request(EXECUTION_SOURCE_REQUEST)),
    await syntheticIntentResponseResolver(request(CAMPUS_SOURCE_REQUEST)),
  ];
  assert.deepEqual(values.map(value => value.result.data.sourceRequest), [
    REPAIR_SOURCE_REQUEST, CAMPUS_SOURCE_REQUEST, EXECUTION_SOURCE_REQUEST, CAMPUS_SOURCE_REQUEST,
  ]);
  assert.equal(await syntheticIntentResponseResolver(request('unmapped')), null);
  assert.equal(await syntheticIntentResponseResolver({ task: 'editor.timeline_plan', input: {} }), null);
});

const EXECUTION_SOURCE_REQUEST = 'Create a complete ten-second medical narrative and protect the first clip.';
const REPAIR_SOURCE_REQUEST = 'Create a complete ten-second medical narrative with upbeat pacing.';

test('all G2 gates dispatch once through retained adapters and reuse phase evidence', async () => {
  const calls = [];
  const scenario = createDurableR11EScenario(fakeAdapters(calls));
  const harness = fakeHarness();
  const session = await scenario.setup({ harness });
  const completed = [];
  for (const id of DURABLE_R11E_GATE_ORDER) {
    const gateFixtures = await scenario.resolveFixturesForGate({ id, baseFixtures: scenario.fixtures, completed, session });
    await scenario.runGate({ id, label: id, completed: [...completed], harness, session, gateFixtures });
    completed.push(id);
  }
  assert.equal(calls.filter(item => item === 'execution-fixture').length, 1);
  assert.equal(calls.filter(item => item === 'execution').length, 1);
  assert.equal(calls.filter(item => item === 'repair-fixture').length, 1);
  assert.equal(calls.filter(item => item === 'repair').length, 1);
  assert.equal(calls.filter(item => item === 'media').length, 1);
  assert.equal(calls.filter(item => item === 'export').length, 1);
  assert.equal(calls.at(-1), 'media-cleanup');
});

test('direct resume at campus, execution, repair, G2-P, and G2-Q prepares only required current phase', async () => {
  for (const [id, required, forbidden] of [
    ['G2-A', 'campus', 'execution-fixture'],
    ['G2-F', 'execution-fixture', 'campus'],
    ['G2-L', 'repair-fixture', 'execution-fixture'],
    ['G2-P', 'media', 'repair-fixture'],
    ['G2-Q', 'media', 'preview'],
  ]) {
    const calls = [];
    const scenario = createDurableR11EScenario(fakeAdapters(calls));
    const harness = fakeHarness();
    const session = await scenario.setup({ harness });
    const gateFixtures = await scenario.resolveFixturesForGate({ id, baseFixtures: scenario.fixtures, completed: [], session });
    await scenario.runGate({ id, label: id, completed: [], harness, session, gateFixtures });
    assert.ok(calls.includes(required), `${id} did not prepare ${required}`);
    assert.equal(calls.includes(forbidden), false, `${id} leaked into ${forbidden}`);
  }
});

test('campus project/media contract is deterministic and owns the required 35s/3s sources', () => {
  const media = createCampusMediaFiles();
  assert.deepEqual(media.videos.map(item => [item.name, item.mimeType, item.buffer.length]), [
    ['teacher-speech.mp4', 'video/webm', 588], ['campus-logo.mp4', 'video/webm', 573],
  ]);
  assert.equal(media.audio.buffer.length, 44 + 38_000 * 16_000 / 1_000 * 2);
  assert.equal(media.subtitleText.includes('00:00:35,000 --> 00:00:38,000'), true);
  assertCampusProject({
    schemaVersion: 2, durationMs: 38_000,
    tracks: [{ clips: [{}, {}, {}, {}, {}, {}] }, { clips: [] }, { clips: [] }, { clips: [] }],
    captions: [{}, {}], assets: [{}, {}],
  });
  const campus = loadCampusScenarioEvidence();
  const hardClauses = campus.intent.clauses.filter(item => item.kind === 'HARD_CONSTRAINT_REQUEST');
  const speech = confirmDirectSelectionV1({
    context: { intent: campus.intent, project: campus.project, projectFingerprint: campus.projectFingerprint },
    sourceClauseId: hardClauses.find(item => item.payload.reference.referenceText === '老师完整讲话').clauseId,
    selection: { bindingType: 'CAPTION', captionId: 'caption-teacher' },
  });
  assert.equal(speech.status, 'ACCEPTED');
  const ending = campus.confirmedBindings.find(item => item.binding.bindingType === 'CLIP');
  const built = buildConstraintSetV1({
    intent: campus.intent, project: campus.project, projectFingerprint: campus.projectFingerprint,
    confirmedBindings: [speech.value, ending],
  });
  assert.equal(built.status, 'CONSTRAINT_SET_BUILT');
  assert.deepEqual(assertCampusStructuredGrounding({
    session: {
      status: 'NEEDS_USER_DECISION', confirmedBindings: [speech.value, ending],
      constraintSet: built.constraintSet,
    },
    project: campus.project,
  }), {
    constraintSetId: built.constraintSet.constraintSetId,
    userConfirmationCount: 2, canonicalBindingCount: 3, activeBindingCount: 2,
    constraintCount: 2, duplicates: 0,
  });
});

test('campus fallback restores the intentionally hidden workspace before requiring visible evidence', async () => {
  const { page, calls } = campusVisibilityPage();
  const evidence = await captureCampusFilenameFallbackEvidence({ page, teacherFilename: 'teacher-speech.mp4' });
  assert.deepEqual(evidence, {
    teacherFilename: 'teacher-speech.mp4', text: '已识别：医生问诊',
    editorAutoOpened: true, workspaceRestored: true, visible: true,
    confidencePercentagePresent: false,
  });
  assert.deepEqual(calls, [
    'editor:visible', 'workspace:isVisible', 'close:click', 'editor:detached',
    'workspace:visible', 'row:visible', 'insight:visible',
  ]);
});

test('G2-A identifies the old 1-vs-2 teacher candidate assertion and selects one semantic target from two valid captions', async () => {
  let anonymous;
  try { assert.equal(2, 1); } catch (error) { anonymous = error; }
  assert.equal(anonymous.actual, 2);
  assert.equal(anonymous.expected, 1);
  assert.doesNotMatch(anonymous.message, /G2A_/);

  const { page, target } = campusGroundingPage({ availableCandidateCount: 2, targetCount: 1 });
  assert.equal(await resolveCampusSpeechGroundingCandidate(page), target);
});

test('G2-A duplicate semantic teacher target fails closed with stable assertion identity and bounded evidence', async () => {
  await assert.rejects(
    resolveCampusSpeechGroundingCandidate(campusGroundingPage({ targetCount: 2 }).page),
    error => {
      assert.match(error.message, /G2A_TEACHER_GROUNDING_TARGET_COUNT/);
      assert.match(error.message, /phase=STRUCTURED_GROUNDING/);
      assert.match(error.message, /expected=1 actual=2/);
      assert.match(error.message, /availableCandidateCount=2/);
      return true;
    },
  );
});

test('G2-A generic locator count failures always include assertion ID, phase, expected, actual, and identifiers', async () => {
  await assert.rejects(
    assertG2ALocatorCount({ async count() { return 2; } }, {
      id: 'G2A_TEST_COUNT', phase: 'TEST_PHASE', identifiers: 'entity=test',
    }),
    /\[G2A_TEST_COUNT\] phase=TEST_PHASE expected=1 actual=2 identifiers=entity=test/,
  );
});

test('campus fallback fails closed for missing or incorrect recognition evidence', async () => {
  await assert.rejects(
    captureCampusFilenameFallbackEvidence({
      page: campusVisibilityPage({ insightCount: 0 }).page, teacherFilename: 'teacher-speech.mp4',
    }),
    /G2A_TEACHER_ASSET_INSIGHT_COUNT.*expected=1 actual=0/,
  );
  await assert.rejects(
    captureCampusFilenameFallbackEvidence({
      page: campusVisibilityPage({ insightText: '已识别：其他主题' }).page, teacherFilename: 'teacher-speech.mp4',
    }),
    /已识别：医生问诊/,
  );
});

test('campus fallback fails closed if closing TimelineEditor does not restore the workspace', async () => {
  await assert.rejects(
    captureCampusFilenameFallbackEvidence({
      page: campusVisibilityPage({ restoreWorkspace: false }).page, teacherFilename: 'teacher-speech.mp4',
    }),
    /Workspace remained hidden after editor close/,
  );
});

test('durable G2-A captures restored visible insight before grounding and continues to SAFE_NO_CHANGE', async () => {
  const source = await readFile(new URL('./v24abc-r11e-r9y-scenario.mjs', import.meta.url), 'utf8');
  const captureIndex = source.indexOf('const fallbackEvidence = await captureCampusFilenameFallbackEvidence');
  const groundingIndex = source.indexOf('const requirementInput = await openRequirementFlow', captureIndex);
  const optionBIndex = source.indexOf("await selectNegotiationOption(page, 'OPTIMIZE_UNPROTECTED_ONLY'", groundingIndex);
  const readyToPlanIndex = source.indexOf('await waitForNegotiationState', optionBIndex);
  const safeNoChangeIndex = source.indexOf("assert.equal(plan?.proposalStatus, 'SAFE_NO_CHANGE')", readyToPlanIndex);
  assert.ok(captureIndex > 0 && groundingIndex > captureIndex && optionBIndex > groundingIndex);
  assert.ok(readyToPlanIndex > optionBIndex && safeNoChangeIndex > readyToPlanIndex);
});

test('durable stale/protected tail reuses production contracts with distinct fail-closed codes', () => {
  assert.deepEqual(verifyDurableStaleAndProtectedContracts(), {
    executionStaleCode: 'STALE_PROPOSAL', repairStaleCode: 'STALE_REPAIR',
    protectedRepairCode: 'HARD_CONSTRAINT_BLOCKED', emptyNonEnforcingFalseStale: false,
    noStaleExecution: true, noStaleRepairExecution: true, protectedHistoryCount: 0,
  });
});
