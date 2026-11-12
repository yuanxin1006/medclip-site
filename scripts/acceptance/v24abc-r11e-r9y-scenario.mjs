import assert from 'node:assert/strict';
import { parseConstraintSet } from '../../app/editor-constraints.ts';
import {
  buildReviewedProposalPlan, createHumanReviewState, ProposalReviewError, reviewProposalEntry,
} from '../../app/editor-proposal-review.ts';
import {
  buildReviewedRepairPlan, createRepairProposalBundle, createRepairReviewState,
  EditorRepairError, executeReviewedRepairLoop,
} from '../../app/editor-repair.ts';
import { createProtectedClipConstraintSet } from '../../app/test-support/editor-constraint-enforcement-fixture.ts';
import {
  createExecutionEditorFixtureV1, createImmutableRepetitionEditorFixtureV1,
} from './editor-input-fixtures.mjs';
import {
  CAMPUS_OPTION_B_EXPECTED, captureAcceptanceDiagnosticBaseline,
  openRequirementFlow, readAcceptanceDiagnostics, readCanonicalProjectFingerprint,
  readCanonicalProjectSnapshot, selectNegotiationOption, waitForNegotiationState,
  waitForZeroActionReviewResult,
} from './medclip-browser-harness.mjs';
import {
  applyRetainedExecutionHumanReview, beginRetainedExecutionPlanning,
  executeRetainedReviewedPlan, exerciseRetainedExecutionUndoRedo,
  preflightRetainedExecution, prepareRetainedExecutionFixture,
  verifyRetainedExecutionFingerprintSupport, verifyRetainedExecutionStaleSupport,
} from './retained-execution-browser-handlers.mjs';
import {
  applyRetainedRepairHumanReview, beginRetainedRepairPlanning,
  evaluateRetainedRepairResult, executeRetainedRepair, exerciseRetainedRepairUndoRedo,
  preflightRetainedRepair, prepareRetainedRepairFixture, validateRetainedRepairPlan,
  verifyRetainedRepairRoundPolicy,
} from './retained-repair-browser-handlers.mjs';
import {
  cleanupRetainedOwnedMedia as cleanupOwnedMedia,
  exportAndDownloadRetainedOwnedMedia, prepareRetainedOwnedMedia,
  proveRetainedOwnedMediaPreview,
} from './retained-owned-media-browser-handlers.mjs';
import {
  loadExecutionScenarioEvidence, loadRepairScenarioEvidence,
} from './v24abc-r11e-scenario-contract.mjs';
import { authenticateAcceptanceBrowserToEditor } from './v24abc-r11e.mjs';

export const DURABLE_R11E_GATE_ORDER = Object.freeze([
  'G2-A', 'G2-B', 'G2-C', 'G2-D', 'G2-E', 'G2-F', 'G2-G', 'G2-H', 'G2-I',
  'G2-J', 'G2-K', 'G2-L', 'G2-M', 'G2-N', 'G2-O', 'G2-P', 'G2-Q', 'G2-R',
]);

export const DURABLE_R11E_PHASE_BY_GATE = Object.freeze(Object.fromEntries([
  ...['G2-A', 'G2-B'].map(id => [id, 'CAMPUS']),
  ...['G2-C', 'G2-D', 'G2-E', 'G2-F', 'G2-G', 'G2-H', 'G2-I', 'G2-J', 'G2-K'].map(id => [id, 'EXECUTION']),
  ...['G2-L', 'G2-M', 'G2-N', 'G2-O', 'G2-P', 'G2-Q'].map(id => [id, 'REPAIR']),
  ['G2-R', 'FINAL'],
]));

export const CAMPUS_SOURCE_REQUEST = '请将成片目标时长设为30秒，完整保留老师讲话和结尾Logo。';
const EXECUTION_SOURCE_REQUEST = 'Create a complete ten-second medical narrative and protect the first clip.';
const REPAIR_SOURCE_REQUEST = 'Create a complete ten-second medical narrative with upbeat pacing.';
const CAMPUS_SRT = '1\n00:00:00,000 --> 00:00:35,000\n老师完整讲话 医生问诊\n\n2\n00:00:35,000 --> 00:00:38,000\n结尾 Logo';

// Deterministic repository-owned VP8 fixtures generated from solid colors. Their
// 35s/3s durations make the retained six-clip campus timeline reproducible.
const CAMPUS_TEACHER_WEBM_BASE64 =
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAIcEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEzTbuMU6uEHFO7a1OsggIG7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDJXQYxMYXZmNjMuMS4xMDJEiYhA4RcAAAAAABZUrmvYrgEAAAAAAABP14EBc8WIq+FSsBCXP3ecgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4UIJimeAOCQsIGguoFamoECVbCEVbmBAVXugQDsAQAAAAAAAAIAABJUw2f6c3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2My4xLjEwMnNz1WPAi2PFiKvhUrAQlz93Z8igRaOHRU5DT0RFUkSHk0xhdmM2My4xLjEwMiBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjM1LjAwMDAwMDAwMAAfQ7Z1z+eBAKPKgQAAgHAFAJ0BKqAAWgAHBwiFhYiZhIglggJ08kDoisghqqTXcQ6qk13EOqpNdxDqqTXcQ6qk120A/u3O3/43j/Jd/bvt5EYZ1gAcU7trkbuPs4EAt4r3gQHxggGy8IED';
const CAMPUS_LOGO_WEBM_BASE64 =
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAINEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggH37AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDJXQYxMYXZmNjMuMS4xMDJEiYhAp3AAAAAAABZUrmvXrgEAAAAAAABO14EBc8WII9rqaC981vacgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4Sy0F4A4JCwgaC6gVqagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAyc3PVY8CLY8WII9rqaC981vZnyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDMuMDAwMDAwMDAwAB9DtnXB54EAo7yBAACAUAUAnQEqoABaAAcHCIWFiJmEiCWCAAYoDwh1VJruIdVSa7iHVUmu4h1VJruIdVSa7iG8AP7vYAAcU7trkbuPs4EAt4r3gQHxggGx8IED';

function createWav(durationMs = 38_000) {
  const sampleRate = 16_000;
  const samples = Math.round(sampleRate * durationMs / 1_000);
  const output = Buffer.alloc(44 + samples * 2);
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write('data', 36);
  output.writeUInt32LE(samples * 2, 40);
  return output;
}

export function createCampusMediaFiles() {
  return Object.freeze({
    audio: Object.freeze({ name: 'campus-38s.wav', mimeType: 'audio/wav', buffer: createWav() }),
    videos: Object.freeze([
      Object.freeze({ name: 'teacher-speech.mp4', mimeType: 'video/webm', buffer: Buffer.from(CAMPUS_TEACHER_WEBM_BASE64, 'base64') }),
      Object.freeze({ name: 'campus-logo.mp4', mimeType: 'video/webm', buffer: Buffer.from(CAMPUS_LOGO_WEBM_BASE64, 'base64') }),
    ]),
    subtitleText: CAMPUS_SRT,
  });
}

function syntheticIntentResponse(sourceRequest, { campus = false, protectFirstClip = false } = {}) {
  const clauses = [{
    kind: 'GOAL',
    payload: { type: 'TARGET_DURATION', durationMs: campus ? 30_000 : 10_000, policy: campus ? 'TARGET' : 'EXACT' },
    provenance: { schemaVersion: 1, authority: 'MODEL_SUGGESTION', sourceReference: sourceRequest },
  }];
  if (campus) {
    clauses.push(
      { kind: 'SOFT_PREFERENCE', payload: { type: 'PACE', value: 'UPBEAT' }, provenance: { schemaVersion: 1, authority: 'MODEL_SUGGESTION', sourceReference: '节奏轻快' } },
      { kind: 'HARD_CONSTRAINT_REQUEST', payload: { type: 'PROTECT_TIME_RANGE', reference: { schemaVersion: 1, state: 'UNRESOLVED_REFERENCE', semanticKind: 'SPEECH', referenceText: '老师完整讲话' } }, provenance: { schemaVersion: 1, authority: 'MODEL_UNCERTAIN_INFERENCE', sourceReference: '完整保留老师讲话' } },
      { kind: 'HARD_CONSTRAINT_REQUEST', payload: { type: 'PRESERVE_ENDING', reference: { schemaVersion: 1, state: 'UNRESOLVED_REFERENCE', semanticKind: 'VISUAL_OBJECT', referenceText: '结尾Logo' } }, provenance: { schemaVersion: 1, authority: 'MODEL_UNCERTAIN_INFERENCE', sourceReference: '结尾Logo' } },
    );
  } else if (protectFirstClip) {
    clauses.push({
      kind: 'HARD_CONSTRAINT_REQUEST',
      payload: { type: 'PROTECT_CLIP', reference: { schemaVersion: 1, state: 'UNRESOLVED_REFERENCE', semanticKind: 'SPEECH', referenceText: 'the first clip' } },
      provenance: { schemaVersion: 1, authority: 'MODEL_UNCERTAIN_INFERENCE', sourceReference: 'protect the first clip' },
    });
  }
  return Object.freeze({
    ok: true, task: 'editor.creative_intent_parse', provider: 'deepseek',
    result: { capability: 'TEXT_REASONING', data: { schemaVersion: 1, sourceRequest, clauses } },
    usage: null,
    metadata: { providerUsed: 'deepseek', taskType: 'editor.creative_intent_parse', generationOccurred: true },
  });
}

export async function syntheticIntentResponseResolver({ task, input } = {}) {
  if (task !== 'editor.creative_intent_parse') return null;
  const request = input?.editingRequirement;
  if (request === CAMPUS_SOURCE_REQUEST) return syntheticIntentResponse(request, { campus: true });
  if (request === EXECUTION_SOURCE_REQUEST) return syntheticIntentResponse(request, { protectFirstClip: true });
  if (request === REPAIR_SOURCE_REQUEST) return syntheticIntentResponse(request);
  return null;
}

export const fixtures = Object.freeze({
  providerAvailability: Object.freeze({ provider: 'deepseek', status: 'connected' }),
  syntheticIntentResponseResolver,
});

function inspectCampusIntentState() {
  const root = document.querySelector('.creative-intent-panel');
  const key = root && Object.keys(root).find(item => item.startsWith('__reactFiber$'));
  let fiber = key ? root[key] : null;
  while (fiber) {
    const props = fiber.memoizedProps;
    if (props?.session && props?.project && Object.hasOwn(props.session, 'confirmedBindings')) {
      return { session: props.session, project: props.project };
    }
    fiber = fiber.return;
  }
  return null;
}

function inspectCampusPlanState() {
  const root = document.querySelector('.plan-evidence-panel');
  const key = root && Object.keys(root).find(item => item.startsWith('__reactFiber$'));
  let fiber = key ? root[key] : null;
  while (fiber) {
    const props = fiber.memoizedProps;
    if (props?.evidence && Object.hasOwn(props, 'proposal') && Object.hasOwn(props, 'review')) {
      return {
        proposalStatus: props.proposal?.status ?? null,
        safeNoChangeOutcome: props.proposal?.safeNoChangeOutcome ?? null,
        proposalActionCount: props.proposal?.compiledPlan?.canonicalPlan?.actions?.length ?? null,
        reviewLifecycle: props.review?.lifecycle ?? null,
        evidenceLifecycle: props.evidence?.lifecycleStatus ?? null,
        evidenceEntryCount: props.evidence?.entries?.length ?? null,
        executionPresent: Boolean(props.evidence?.summary?.execution),
      };
    }
    fiber = fiber.return;
  }
  return null;
}

export function assertCampusProject(project) {
  assert.equal(project.schemaVersion, 2, '[G2A_PROJECT_SCHEMA_VERSION] phase=PROJECT_SHAPE expected=2');
  assert.equal(project.durationMs, 38_000, '[G2A_PROJECT_DURATION_MS] phase=PROJECT_SHAPE expected=38000');
  assert.equal(project.tracks.length, 4, '[G2A_PROJECT_TRACK_COUNT] phase=PROJECT_SHAPE expected=4');
  assert.equal(project.tracks.flatMap(track => track.clips).length, 6, '[G2A_PROJECT_CLIP_COUNT] phase=PROJECT_SHAPE expected=6');
  assert.equal(project.captions.length, 2, '[G2A_PROJECT_CAPTION_COUNT] phase=PROJECT_SHAPE expected=2');
  assert.equal(project.assets.length, 2, '[G2A_PROJECT_ASSET_COUNT] phase=PROJECT_SHAPE expected=2');
  return true;
}

export function assertCampusStructuredGrounding(state) {
  assert.ok(state?.session?.constraintSet, 'Campus structured ConstraintSet is unavailable');
  const set = parseConstraintSet(state.session.constraintSet);
  const activeBindings = set.confirmedBindings.filter(item => item.state === 'ACTIVE_HARD_CONSTRAINT');
  assert.equal(state.session.status, 'NEEDS_USER_DECISION', '[G2A_SESSION_STATUS] phase=STRUCTURED_GROUNDING expected=NEEDS_USER_DECISION');
  assert.equal(state.session.confirmedBindings.length, 2, '[G2A_USER_CONFIRMATION_RECORD_COUNT] phase=STRUCTURED_GROUNDING expected=2');
  assert.equal(set.confirmedBindings.length, 3, '[G2A_CANONICAL_CONFIRMED_BINDING_COUNT] phase=STRUCTURED_GROUNDING expected=3 identifiers=caption+promoted-time-range+ending-clip');
  assert.equal(activeBindings.length, 2, '[G2A_ACTIVE_BINDING_COUNT] phase=STRUCTURED_GROUNDING expected=2');
  assert.equal(set.activeConstraints.length, 2, '[G2A_ACTIVE_CONSTRAINT_COUNT] phase=STRUCTURED_GROUNDING expected=2');
  assert.equal(new Set(set.confirmedBindings.map(item => item.bindingId)).size, 3, '[G2A_CANONICAL_BINDING_ID_UNIQUENESS] phase=STRUCTURED_GROUNDING expected=3');
  assert.equal(new Set(set.activeConstraints.map(item => item.constraintId)).size, 2, '[G2A_CONSTRAINT_ID_UNIQUENESS] phase=STRUCTURED_GROUNDING expected=2');
  assert.deepEqual(new Set(set.activeConstraints.map(item => item.type)), new Set(['PROTECT_TIME_RANGE', 'PRESERVE_ENDING']), '[G2A_ACTIVE_CONSTRAINT_TYPES] phase=STRUCTURED_GROUNDING');
  assert.equal(set.activeConstraints.every(item => activeBindings.some(binding => binding.bindingId === item.bindingId)), true, '[G2A_ACTIVE_CONSTRAINT_LINEAGE] phase=STRUCTURED_GROUNDING expected=true');
  assert.equal(set.projectId, state.project.id, '[G2A_CONSTRAINT_PROJECT_IDENTITY] phase=STRUCTURED_GROUNDING');
  const speech = activeBindings.find(item => item.bindingType === 'TIME_RANGE');
  const ending = activeBindings.find(item => item.bindingType === 'CLIP');
  const caption = speech?.bindingType === 'CAPTION'
    ? state.project.captions.find(item => item.id === speech.captionId) : null;
  const clip = state.project.tracks.flatMap(track => track.clips).find(item => item.id === ending?.clipId);
  const speechRange = speech?.bindingType === 'TIME_RANGE'
    ? [speech.range.startMs, speech.range.endMs] : caption && [caption.startMs, caption.endMs];
  assert.deepEqual(speechRange, [0, 35_000], '[G2A_TEACHER_PROTECTED_RANGE] phase=STRUCTURED_GROUNDING expected=0-35000');
  assert.deepEqual(clip && [clip.timelineStartMs, clip.timelineEndMs], [35_000, 38_000], '[G2A_ENDING_PROTECTED_RANGE] phase=STRUCTURED_GROUNDING expected=35000-38000');
  return Object.freeze({ constraintSetId: set.constraintSetId, userConfirmationCount: 2, canonicalBindingCount: 3, activeBindingCount: 2, constraintCount: 2, duplicates: 0 });
}

export async function assertG2ALocatorCount(locator, {
  id, expected = 1, phase, identifiers = 'none',
} = {}) {
  const actual = await locator.count();
  assert.equal(actual, expected, `[${id}] phase=${phase} expected=${expected} actual=${actual} identifiers=${identifiers}`);
  return actual;
}

const CAMPUS_AUDIO_ROW_SELECTOR = '.panel.input-panel .audio-card';
const CAMPUS_AUDIO_NAME_SELECTOR = '.audio-info > b';
const CAMPUS_AUDIO_READY_SELECTOR = '.demo-wave[aria-label="音频已就绪"]';

export async function readCampusAudioUploadState(page, {
  filename, expectedDurationText = '00:38',
} = {}) {
  assert.equal(typeof filename, 'string', 'Campus audio filename is required');
  return page.evaluate(({ rowSelector, nameSelector, readySelector, filename: wanted, expectedDurationText: durationText }) => {
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && style.opacity !== '0' && element.getClientRects().length > 0;
    };
    const rows = [...document.querySelectorAll(rowSelector)].map(row => {
      const name = row.querySelector(nameSelector)?.textContent?.trim() ?? '';
      const text = row.textContent?.replace(/\s+/g, ' ').trim().slice(0, 240) ?? '';
      return {
        name, text, visible: isVisible(row),
        ready: Boolean(row.querySelector(readySelector)),
        durationReady: text.includes(durationText),
      };
    });
    const matching = rows.filter(row => row.name === wanted);
    return {
      documentIdentity: `${window.location.href}|${window.performance.timeOrigin}`,
      filename: wanted,
      matchingRowCount: matching.length,
      visibleMatchingRowCount: matching.filter(row => row.visible).length,
      readyMatchingRowCount: matching.filter(row => row.ready).length,
      durationReadyMatchingRowCount: matching.filter(row => row.durationReady).length,
      rowIdentities: rows.slice(0, 10).map(row => ({
        name: row.name, visible: row.visible, ready: row.ready, text: row.text,
      })),
    };
  }, {
    rowSelector: CAMPUS_AUDIO_ROW_SELECTOR,
    nameSelector: CAMPUS_AUDIO_NAME_SELECTOR,
    readySelector: CAMPUS_AUDIO_READY_SELECTOR,
    filename,
    expectedDurationText,
  });
}

function campusAudioReadinessError(state, expectedDurationText, cause, id = 'G2A_AUDIO_UPLOAD_ROW_READY') {
  const identities = JSON.stringify(state.rowIdentities ?? []);
  return Object.assign(new Error(
    `[${id}] phase=AUDIO_UPLOAD expectedFilename=${state.filename}`
    + ` matchingRowCount=${state.matchingRowCount} visibleMatchingRowCount=${state.visibleMatchingRowCount}`
    + ` readyMatchingRowCount=${state.readyMatchingRowCount}`
    + ` durationReadyMatchingRowCount=${state.durationReadyMatchingRowCount}`
    + ` expectedDuration=${expectedDurationText} rowIdentities=${identities}`,
    { cause },
  ), { harnessFailure: true });
}

export async function uploadCampusAudioAndWait({
  page, audioInput, file, timeout = 90_000, expectedDurationText = '00:38',
} = {}) {
  if (!page || !audioInput || !file) {
    throw Object.assign(new Error('G2A audio upload requires page, audioInput, and file'), { harnessFailure: true });
  }
  const baseline = await readCampusAudioUploadState(page, { filename: file.name, expectedDurationText });
  assert.equal(
    baseline.matchingRowCount, 0,
    `[G2A_AUDIO_UPLOAD_STALE_ROW_COUNT] phase=AUDIO_UPLOAD_BASELINE expected=0 actual=${baseline.matchingRowCount}`
    + ` filename=${file.name} documentIdentity=${baseline.documentIdentity}`,
  );
  await audioInput.setInputFiles(file);
  try {
    await page.waitForFunction(({ rowSelector, nameSelector, readySelector, filename, documentIdentity, durationText }) => {
      const currentDocumentIdentity = `${window.location.href}|${window.performance.timeOrigin}`;
      if (currentDocumentIdentity !== documentIdentity) return false;
      return [...document.querySelectorAll(rowSelector)].some(row => {
        const style = window.getComputedStyle(row);
        const visible = style.display !== 'none' && style.visibility !== 'hidden'
          && style.opacity !== '0' && row.getClientRects().length > 0;
        const name = row.querySelector(nameSelector)?.textContent?.trim() ?? '';
        const text = row.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        return name === filename && visible && Boolean(row.querySelector(readySelector)) && text.includes(durationText);
      });
    }, {
      rowSelector: CAMPUS_AUDIO_ROW_SELECTOR,
      nameSelector: CAMPUS_AUDIO_NAME_SELECTOR,
      readySelector: CAMPUS_AUDIO_READY_SELECTOR,
      filename: file.name,
      documentIdentity: baseline.documentIdentity,
      durationText: expectedDurationText,
    }, { timeout });
  } catch (cause) {
    const failed = await readCampusAudioUploadState(page, { filename: file.name, expectedDurationText });
    throw campusAudioReadinessError(failed, expectedDurationText, cause);
  }
  const current = await readCampusAudioUploadState(page, { filename: file.name, expectedDurationText });
  if (current.documentIdentity !== baseline.documentIdentity) {
    throw campusAudioReadinessError(current, expectedDurationText, new Error('Current document changed during audio upload'));
  }
  if (current.matchingRowCount !== 1) {
    throw campusAudioReadinessError(
      current, expectedDurationText,
      new Error(`Expected one exact current audio row, received ${current.matchingRowCount}`),
      'G2A_AUDIO_UPLOAD_ROW_COUNT',
    );
  }
  if (current.visibleMatchingRowCount !== 1 || current.readyMatchingRowCount !== 1
    || current.durationReadyMatchingRowCount !== 1) {
    throw campusAudioReadinessError(current, expectedDurationText);
  }
  return Object.freeze({
    filename: file.name,
    documentIdentity: current.documentIdentity,
    matchingRowCount: 1,
    visibleMatchingRowCount: 1,
    readyMatchingRowCount: 1,
    durationReadyMatchingRowCount: 1,
    expectedDurationText,
  });
}

const CAMPUS_VIDEO_ROW_SELECTOR = '.panel.input-panel .asset-row';
const CAMPUS_VIDEO_NAME_SELECTOR = '.asset-name > b';
const CAMPUS_VIDEO_BLOCKED_SELECTOR = '.asset-processing, .asset-alert';

export async function readCampusVideoUploadState(page, {
  filename, expectedDurationText,
} = {}) {
  assert.equal(typeof filename, 'string', 'Campus video filename is required');
  assert.equal(typeof expectedDurationText, 'string', 'Campus video expected duration is required');
  return page.evaluate(({ rowSelector, nameSelector, blockedSelector, filename: wanted, durationText }) => {
    const isVisible = element => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && style.opacity !== '0' && element.getClientRects().length > 0;
    };
    const rows = [...document.querySelectorAll(rowSelector)].map(row => {
      const name = row.querySelector(nameSelector)?.textContent?.trim() ?? '';
      const text = row.textContent?.replace(/\s+/g, ' ').trim().slice(0, 240) ?? '';
      const durationReady = text.includes(durationText);
      return {
        name, text, visible: isVisible(row), durationReady,
        ready: durationReady && !row.querySelector(blockedSelector),
      };
    });
    const matching = rows.filter(row => row.name === wanted);
    return {
      documentIdentity: `${window.location.href}|${window.performance.timeOrigin}`,
      filename: wanted,
      matchingRowCount: matching.length,
      visibleMatchingRowCount: matching.filter(row => row.visible).length,
      readyMatchingRowCount: matching.filter(row => row.ready).length,
      durationReadyMatchingRowCount: matching.filter(row => row.durationReady).length,
      rowIdentities: rows.slice(0, 30).map(row => ({
        name: row.name, visible: row.visible, ready: row.ready, text: row.text,
      })),
    };
  }, {
    rowSelector: CAMPUS_VIDEO_ROW_SELECTOR,
    nameSelector: CAMPUS_VIDEO_NAME_SELECTOR,
    blockedSelector: CAMPUS_VIDEO_BLOCKED_SELECTOR,
    filename,
    durationText: expectedDurationText,
  });
}

function campusVideoReadinessError(spec, state, cause, id = spec.readyId) {
  return Object.assign(new Error(
    `[${id}] phase=VIDEO_UPLOAD expectedFilename=${spec.filename}`
    + ` matchingRowCount=${state.matchingRowCount} visibleMatchingRowCount=${state.visibleMatchingRowCount}`
    + ` readyMatchingRowCount=${state.readyMatchingRowCount}`
    + ` durationReadyMatchingRowCount=${state.durationReadyMatchingRowCount}`
    + ` expectedDuration=${spec.expectedDurationText} documentIdentity=${state.documentIdentity}`
    + ` rowIdentities=${JSON.stringify(state.rowIdentities ?? [])}`,
    { cause },
  ), { harnessFailure: true });
}

export async function uploadCampusVideosAndWait({
  page, videoInput, files, timeout = 90_000,
} = {}) {
  if (!page || !videoInput || !Array.isArray(files) || files.length !== 2) {
    throw Object.assign(new Error('G2A video upload requires page, videoInput, and the teacher/ending file pair'), { harnessFailure: true });
  }
  const specs = [
    Object.freeze({
      role: 'teacher', filename: files[0].name, expectedDurationText: '00:35',
      readyId: 'G2A_TEACHER_VIDEO_UPLOAD_READY', countId: 'G2A_TEACHER_UPLOAD_ROW_COUNT',
      staleId: 'G2A_TEACHER_VIDEO_UPLOAD_STALE_ROW_COUNT',
    }),
    Object.freeze({
      role: 'ending', filename: files[1].name, expectedDurationText: '00:03',
      readyId: 'G2A_ENDING_VIDEO_UPLOAD_READY', countId: 'G2A_ENDING_UPLOAD_ROW_COUNT',
      staleId: 'G2A_ENDING_VIDEO_UPLOAD_STALE_ROW_COUNT',
    }),
  ];
  const baselines = [];
  for (const spec of specs) {
    const baseline = await readCampusVideoUploadState(page, spec);
    if (baseline.matchingRowCount !== 0) {
      throw campusVideoReadinessError(spec, baseline,
        new Error(`Pre-upload exact-name baseline must be zero, received ${baseline.matchingRowCount}`), spec.staleId);
    }
    baselines.push(baseline);
  }
  const documentIdentity = baselines[0].documentIdentity;
  if (baselines.some(baseline => baseline.documentIdentity !== documentIdentity)) {
    throw Object.assign(new Error('[G2A_VIDEO_UPLOAD_DOCUMENT_IDENTITY] phase=VIDEO_UPLOAD_BASELINE document changed while capturing baselines'), { harnessFailure: true });
  }
  await videoInput.setInputFiles(files);
  try {
    await page.waitForFunction(({ rowSelector, nameSelector, blockedSelector, specs: expected, documentIdentity: wantedDocument }) => {
      if (`${window.location.href}|${window.performance.timeOrigin}` !== wantedDocument) return false;
      const rows = [...document.querySelectorAll(rowSelector)];
      return expected.every(spec => rows.some(row => {
        const style = window.getComputedStyle(row);
        const visible = style.display !== 'none' && style.visibility !== 'hidden'
          && style.opacity !== '0' && row.getClientRects().length > 0;
        const name = row.querySelector(nameSelector)?.textContent?.trim() ?? '';
        const text = row.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        return name === spec.filename && visible && text.includes(spec.expectedDurationText)
          && !row.querySelector(blockedSelector);
      }));
    }, {
      rowSelector: CAMPUS_VIDEO_ROW_SELECTOR,
      nameSelector: CAMPUS_VIDEO_NAME_SELECTOR,
      blockedSelector: CAMPUS_VIDEO_BLOCKED_SELECTOR,
      specs: specs.map(({ filename, expectedDurationText }) => ({ filename, expectedDurationText })),
      documentIdentity,
    }, { timeout });
  } catch (cause) {
    for (const spec of specs) {
      const failed = await readCampusVideoUploadState(page, spec);
      if (failed.documentIdentity !== documentIdentity || failed.matchingRowCount !== 1
        || failed.visibleMatchingRowCount !== 1 || failed.readyMatchingRowCount !== 1) {
        throw campusVideoReadinessError(spec, failed, cause);
      }
    }
    throw Object.assign(new Error('[G2A_VIDEO_UPLOAD_READY] phase=VIDEO_UPLOAD structured wait failed after both rows appeared ready', { cause }), { harnessFailure: true });
  }
  const evidence = {};
  for (const spec of specs) {
    const current = await readCampusVideoUploadState(page, spec);
    if (current.documentIdentity !== documentIdentity) {
      throw campusVideoReadinessError(spec, current, new Error('Current document changed during video upload'));
    }
    if (current.matchingRowCount !== 1) {
      throw campusVideoReadinessError(spec, current,
        new Error(`Expected one exact current video row, received ${current.matchingRowCount}`), spec.countId);
    }
    if (current.visibleMatchingRowCount !== 1 || current.readyMatchingRowCount !== 1
      || current.durationReadyMatchingRowCount !== 1) {
      throw campusVideoReadinessError(spec, current);
    }
    evidence[spec.role] = Object.freeze({
      filename: spec.filename, documentIdentity, expectedDurationText: spec.expectedDurationText,
      matchingRowCount: 1, visibleMatchingRowCount: 1, readyMatchingRowCount: 1,
      durationReadyMatchingRowCount: 1,
    });
  }
  return Object.freeze(evidence);
}

async function uniqueVisibleEnabled(locator, { id, label, phase, identifiers = 'none' }) {
  const count = await locator.count();
  const matches = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible() && await candidate.isEnabled()) matches.push(candidate);
  }
  assert.equal(matches.length, 1, `[${id}] phase=${phase} expected=1 actual=${matches.length} identifiers=${identifiers};label=${label};totalMatches=${count}`);
  return matches[0];
}

export async function resolveCampusSpeechGroundingCandidate(page) {
  const card = page.locator('.creative-intent-grounding-card').filter({ hasText: '老师完整讲话' });
  const allCandidates = card.locator('.creative-intent-grounding-candidates button');
  const availableCandidateCount = await allCandidates.count();
  const candidate = card.getByRole('button', {
    name: '确认保护字幕范围 00:00–00:35 · 老师完整讲话 医生问诊', exact: true,
  });
  await assertG2ALocatorCount(candidate, {
    id: 'G2A_TEACHER_GROUNDING_TARGET_COUNT', phase: 'STRUCTURED_GROUNDING',
    identifiers: `source=老师完整讲话;range=00:00-00:35;availableCandidateCount=${availableCandidateCount}`,
  });
  return candidate;
}

export async function captureCampusFilenameFallbackEvidence({
  page, teacherFilename, timeout = 90_000,
} = {}) {
  assert.ok(page, 'Campus filename fallback requires a browser page');
  assert.equal(typeof teacherFilename, 'string');
  const editor = page.locator('section.timeline-editor-shell[aria-label="生成后继续剪辑"]');
  const workspace = page.locator('section.workspace#workspace');
  await assertG2ALocatorCount(editor, { id: 'G2A_TIMELINE_EDITOR_COUNT', phase: 'AUTO_OPEN', identifiers: 'aria-label=生成后继续剪辑' });
  await assertG2ALocatorCount(workspace, { id: 'G2A_WORKSPACE_COUNT', phase: 'AUTO_OPEN', identifiers: 'section.workspace#workspace' });
  await editor.waitFor({ state: 'visible', timeout });
  assert.equal(await workspace.isVisible(), false, '[G2A_WORKSPACE_HIDDEN_WHILE_EDITOR_OPEN] phase=AUTO_OPEN expected=false');

  const close = page.getByRole('button', { name: '关闭编辑器', exact: true });
  await assertG2ALocatorCount(close, { id: 'G2A_EDITOR_CLOSE_CONTROL_COUNT', phase: 'AUTO_OPEN', identifiers: 'accessibleName=关闭编辑器' });
  assert.equal(await close.isVisible(), true, 'TimelineEditor close control must be visible');
  assert.equal(await close.isEnabled(), true, 'TimelineEditor close control must be enabled');
  await close.click();
  await editor.waitFor({ state: 'detached', timeout });
  await workspace.waitFor({ state: 'visible', timeout });

  const teacherRow = page.locator('.asset-row', { hasText: teacherFilename });
  await assertG2ALocatorCount(teacherRow, { id: 'G2A_TEACHER_MEDIA_ROW_COUNT', phase: 'WORKSPACE_RESTORED', identifiers: `filename=${teacherFilename}` });
  await teacherRow.waitFor({ state: 'visible', timeout });
  const insight = teacherRow.locator('.asset-insight');
  await assertG2ALocatorCount(insight, { id: 'G2A_TEACHER_ASSET_INSIGHT_COUNT', phase: 'WORKSPACE_RESTORED', identifiers: `filename=${teacherFilename}` });
  await insight.waitFor({ state: 'visible', timeout });
  const text = (await insight.textContent())?.trim() ?? '';
  assert.match(text, /已识别：医生问诊/, '[G2A_TEACHER_ASSET_INSIGHT_TEXT] phase=WORKSPACE_RESTORED expected=已识别：医生问诊');
  assert.equal(text.includes('%'), false, 'Filename fallback must not display a fake confidence percentage');
  return Object.freeze({
    teacherFilename, text, editorAutoOpened: true, workspaceRestored: true,
    visible: true, confidencePercentagePresent: false,
  });
}

export async function prepareCampusSafeNoChange({ harness, timeout = 90_000 } = {}) {
  const page = harness?.page;
  if (!page) throw Object.assign(new Error('DURABLE CAMPUS CONTRACT: harness page is required'), { harnessFailure: true });
  const media = createCampusMediaFiles();
  const audioInput = page.locator('input[type="file"][accept="audio/*"]');
  await assertG2ALocatorCount(audioInput, { id: 'G2A_AUDIO_INPUT_COUNT', phase: 'INPUT_PREPARATION', identifiers: 'accept=audio/*' });
  await uploadCampusAudioAndWait({ page, audioInput, file: media.audio, timeout });
  const videoInput = page.locator('input[type="file"][accept^="video/"]');
  await assertG2ALocatorCount(videoInput, { id: 'G2A_VIDEO_INPUT_COUNT', phase: 'INPUT_PREPARATION', identifiers: 'acceptStartsWith=video/' });
  await uploadCampusVideosAndWait({ page, videoInput, files: media.videos, timeout });
  const subtitleSource = page.locator('.subtitle-source-tabs').getByRole('button', {
    name: '上传同步字幕 SRT 或 VTT（需时间码）', exact: true,
  });
  await assertG2ALocatorCount(subtitleSource, {
    id: 'G2A_SUBTITLE_SOURCE_CONTROL_COUNT', phase: 'INPUT_PREPARATION',
    identifiers: 'accessibleName=上传同步字幕 SRT 或 VTT（需时间码）',
  });
  await subtitleSource.click();
  const subtitleInput = page.locator('textarea[aria-label="字幕文本"]');
  await assertG2ALocatorCount(subtitleInput, { id: 'G2A_SUBTITLE_TEXTAREA_COUNT', phase: 'INPUT_PREPARATION', identifiers: 'aria-label=字幕文本' });
  await subtitleInput.fill(media.subtitleText);
  const consent = page.getByRole('checkbox', { name: '我确认拥有上传素材和音频的使用权，内容不涉及患者隐私或未经授权的个人信息。', exact: true });
  await assertG2ALocatorCount(consent, { id: 'G2A_CONSENT_CHECKBOX_COUNT', phase: 'INPUT_PREPARATION', identifiers: 'exactAccessibleName=true' });
  await consent.check();
  const generate = await uniqueVisibleEnabled(page.locator('button.generate-button'), {
    id: 'G2A_GENERATE_PREVIEW_CONTROL_COUNT', label: 'Generate preview', phase: 'INPUT_PREPARATION',
  });
  await generate.click();
  await page.locator('section.timeline-editor-shell[aria-label="生成后继续剪辑"]').waitFor({ state: 'visible', timeout });
  const project = await page.evaluate(key => JSON.parse(window.localStorage.getItem(key)), 'medclip-editor-draft-v1');
  assertCampusProject(project);
  const fallbackEvidence = await captureCampusFilenameFallbackEvidence({
    page, teacherFilename: media.videos[0].name, timeout,
  });
  await assertG2ALocatorCount(page.locator('.semantic-match-card.state-error .ai-progress'), {
    id: 'G2A_FALLBACK_PROGRESS_COUNT', expected: 0, phase: 'WORKSPACE_RESTORED', identifiers: 'matchingState=error',
  });

  const requirementInput = await openRequirementFlow(page);
  await requirementInput.fill(CAMPUS_SOURCE_REQUEST);
  const dialog = page.locator('section.requirement-dialog[role="dialog"]');
  await assertG2ALocatorCount(dialog, { id: 'G2A_REQUIREMENT_DIALOG_COUNT', phase: 'CREATIVE_INTENT', identifiers: 'role=dialog' });
  const analyze = dialog.getByRole('button', { name: '分析创作意图', exact: true });
  await assertG2ALocatorCount(analyze, { id: 'G2A_ANALYZE_INTENT_CONTROL_COUNT', phase: 'CREATIVE_INTENT', identifiers: 'accessibleName=分析创作意图' });
  await analyze.click();
  const groundingCards = page.locator('.creative-intent-grounding-card');
  await groundingCards.first().waitFor({ state: 'visible', timeout });
  await assertG2ALocatorCount(groundingCards, { id: 'G2A_GROUNDING_CARD_COUNT', expected: 2, phase: 'STRUCTURED_GROUNDING', identifiers: 'teacher+ending' });
  const speech = await resolveCampusSpeechGroundingCandidate(page);
  await speech.click();
  const ending = page.locator('.creative-intent-grounding-card', { hasText: '结尾Logo' })
    .locator('.creative-intent-grounding-candidates button').filter({ hasText: '00:35' });
  await assertG2ALocatorCount(ending, { id: 'G2A_ENDING_GROUNDING_TARGET_COUNT', phase: 'STRUCTURED_GROUNDING', identifiers: 'source=结尾Logo;timelineStart=00:35' });
  await ending.click();
  await page.waitForFunction(() => document.querySelector('.creative-intent-panel header span')?.textContent === 'NEEDS_USER_DECISION', undefined, { timeout });
  const grounding = await page.evaluate(inspectCampusIntentState);
  const groundingEvidence = assertCampusStructuredGrounding(grounding);
  await selectNegotiationOption(page, 'OPTIMIZE_UNPROTECTED_ONLY', timeout);
  const negotiationEvidence = await waitForNegotiationState(page, CAMPUS_OPTION_B_EXPECTED, timeout);
  assert.ok(negotiationEvidence);
  const proposalBaseline = await captureAcceptanceDiagnosticBaseline(page);
  const proposal = await uniqueVisibleEnabled(
    page.getByRole('button', { name: '生成 AI 剪辑建议', exact: true }),
    { id: 'G2A_PROPOSAL_GENERATE_CONTROL_COUNT', label: 'Campus proposal generation', phase: 'SAFE_NO_CHANGE_PROPOSAL' },
  );
  await proposal.click();
  await page.waitForFunction(after => (window.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__ ?? []).some(item =>
    item.sequence > after && item.diagnostic?.kind === 'EDITOR_PROPOSAL_STAGE'
      && item.diagnostic?.stage === 'RESULT_MAPPING' && item.diagnostic?.outcome === 'SAFE_NO_CHANGE'),
  proposalBaseline.sequence, { timeout });
  const diagnostics = await readAcceptanceDiagnostics(page);
  const eligibility = diagnostics.findLast(item => item.sequence > proposalBaseline.sequence
    && item.diagnostic.kind === 'SAFE_NO_CHANGE_ELIGIBILITY')?.diagnostic;
  assert.equal(eligibility?.eligible, true);
  const plan = await page.evaluate(inspectCampusPlanState);
  assert.equal(plan?.proposalStatus, 'SAFE_NO_CHANGE');
  assert.equal(plan?.proposalActionCount, 0);
  assert.equal(plan?.reviewLifecycle, 'REVIEWED_NO_ACTIONS');
  assert.equal(plan?.evidenceLifecycle, 'PENDING_REVIEW');
  assert.equal(plan?.executionPresent, false);
  const keep = page.getByRole('button', { name: '保持当前结果', exact: true });
  await assertG2ALocatorCount(keep, { id: 'G2A_KEEP_CURRENT_RESULT_COUNT', phase: 'SAFE_NO_CHANGE_REVIEW', identifiers: 'accessibleName=保持当前结果' });
  assert.equal(await keep.isVisible(), true);
  assert.equal(await keep.isEnabled(), true);
  return Object.freeze({
    projectFingerprint: await readCanonicalProjectFingerprint(page),
    projectSnapshot: await readCanonicalProjectSnapshot(page),
    fallback: fallbackEvidence, grounding: groundingEvidence, negotiation: negotiationEvidence,
    proposalStatus: plan.proposalStatus, proposalActionCount: 0,
  });
}

export async function completeCampusZeroActionReview({ page, campus, timeout = 10_000 } = {}) {
  const baseline = await captureAcceptanceDiagnosticBaseline(page);
  const keep = page.getByRole('button', { name: '保持当前结果', exact: true });
  assert.equal(await keep.count(), 1);
  await keep.click();
  const review = await waitForZeroActionReviewResult(page, baseline, timeout);
  assert.equal(await keep.count(), 0);
  assert.equal(await readCanonicalProjectFingerprint(page), campus.projectFingerprint);
  assert.deepEqual(await readCanonicalProjectSnapshot(page), campus.projectSnapshot);
  return Object.freeze({ ...review, projectFingerprintStable: true, actionCount: 0 });
}

function repairInput(evidence, extra = {}) {
  return {
    evaluation: evidence.evaluation, proposal: evidence.proposal,
    humanReview: evidence.execution.reviewState, reviewedPlan: evidence.execution.reviewedPlan,
    execution: evidence.execution.execution, planEvidence: evidence.execution.planEvidence,
    currentProject: evidence.execution.execution.postProject,
    videoSemanticEvidence: evidence.input.videoAnalyses, audioRhythmEvidence: evidence.input.rhythm,
    ...extra,
  };
}

export function verifyDurableStaleAndProtectedContracts() {
  const execution = loadExecutionScenarioEvidence();
  let executionReview = createHumanReviewState(execution.proposal);
  for (const entry of execution.proposal.proposalEntries) {
    const decision = entry.intervalId === 'interval-treatment' ? { decision: 'REJECT' }
      : entry.intervalId === 'interval-ecg' ? { decision: 'MODIFY', selectedAssetId: 'asset-ecg-alt' }
        : { decision: 'ACCEPT' };
    executionReview = reviewProposalEntry(execution.proposal, executionReview, {
      proposalEntryId: entry.proposalEntryId, ...decision,
    });
  }
  verifyRetainedExecutionFingerprintSupport(execution.proposal.trustedPreExecutionProject);
  verifyRetainedExecutionStaleSupport({
    proposal: execution.proposal, review: executionReview,
    currentProject: execution.proposal.trustedPreExecutionProject,
  });
  const staleExecution = structuredClone(execution.proposal.trustedPreExecutionProject);
  staleExecution.title += ' material mutation';
  assert.throws(
    () => buildReviewedProposalPlan(execution.proposal, executionReview, staleExecution),
    error => error instanceof ProposalReviewError && error.code === 'STALE_PROPOSAL',
  );

  const repair = loadRepairScenarioEvidence();
  validateRetainedRepairPlan({
    proposal: repair.repairProposal, review: repair.repairReview,
    currentProject: repair.execution.execution.postProject,
  });
  const staleRepair = structuredClone(repair.execution.execution.postProject);
  staleRepair.title += ' material mutation';
  assert.throws(
    () => buildReviewedRepairPlan(repair.repairProposal, repair.repairReview, staleRepair),
    error => error instanceof EditorRepairError && error.code === 'STALE_REPAIR',
  );
  const protectedSet = createProtectedClipConstraintSet(repair.execution.execution.postProject, 'clip-1');
  const protectedProposal = {
    ...repair.proposal, constraintSet: protectedSet,
    evidenceMetadata: { ...repair.proposal.evidenceMetadata, constraintContext: {
      sourceIntentVersionId: protectedSet.intentVersionId,
      sourceConstraintSetId: protectedSet.constraintSetId,
      sourceConstraintFingerprint: protectedSet.constraintFingerprint,
      resolutionIds: protectedSet.resolutionIds,
      feasibilityReportId: 'feasibility-report-v1-durable-protected', readiness: 'READY_TO_PLAN',
    } },
  };
  const blocked = createRepairProposalBundle(repairInput(repair, {
    proposal: protectedProposal, constraintSet: protectedSet,
  }));
  assert.equal(blocked.entries.some(item => item.repairEligibility === 'HARD_CONSTRAINT_BLOCKED'), true);
  assert.equal(blocked.entries.some(item => item.repairEligibility === 'ELIGIBLE'), false);
  const blockedReview = createRepairReviewState(blocked);
  const blockedResult = executeReviewedRepairLoop({
    originalEvaluation: repair.evaluation, repairProposal: blocked,
    repairReview: blockedReview, currentProject: repair.execution.execution.postProject,
    executionUpdatedAt: '2026-10-30T00:00:00.000Z',
  });
  assert.equal(blockedResult.repairExecution, undefined);
  assert.equal(blockedResult.history.shouldRecord, false);
  assert.equal(blockedResult.history.entryCount, 0);
  return Object.freeze({
    executionStaleCode: 'STALE_PROPOSAL', repairStaleCode: 'STALE_REPAIR',
    protectedRepairCode: 'HARD_CONSTRAINT_BLOCKED', emptyNonEnforcingFalseStale: false,
    noStaleExecution: true, noStaleRepairExecution: true, protectedHistoryCount: 0,
  });
}

export async function resolveFixturesForGate({ id, baseFixtures = fixtures } = {}) {
  const phase = DURABLE_R11E_PHASE_BY_GATE[id];
  if (!phase) throw Object.assign(new Error(`DURABLE SCENARIO CONTRACT: unsupported gate ${id}`), { harnessFailure: true });
  if (phase === 'EXECUTION') return Object.freeze({ ...baseFixtures, phase, editorInputFixture: createExecutionEditorFixtureV1() });
  if (phase === 'REPAIR') return Object.freeze({ ...baseFixtures, phase, editorInputFixture: createImmutableRepetitionEditorFixtureV1() });
  return Object.freeze({ ...baseFixtures, phase });
}

const DEFAULT_ADAPTERS = Object.freeze({
  authenticateAcceptanceBrowserToEditor,
  prepareCampusSafeNoChange,
  completeCampusZeroActionReview,
  prepareRetainedExecutionFixture,
  beginRetainedExecutionPlanning,
  applyRetainedExecutionHumanReview,
  preflightRetainedExecution,
  executeRetainedReviewedPlan,
  exerciseRetainedExecutionUndoRedo,
  prepareRetainedRepairFixture,
  beginRetainedRepairPlanning,
  applyRetainedRepairHumanReview,
  preflightRetainedRepair,
  executeRetainedRepair,
  evaluateRetainedRepairResult,
  exerciseRetainedRepairUndoRedo,
  verifyRetainedRepairRoundPolicy,
  prepareRetainedOwnedMedia,
  proveRetainedOwnedMediaPreview,
  exportAndDownloadRetainedOwnedMedia,
  cleanupRetainedOwnedMedia: cleanupOwnedMedia,
  verifyDurableStaleAndProtectedContracts,
});

export function createDurableR11EScenario(overrides = {}) {
  const api = Object.freeze({ ...DEFAULT_ADAPTERS, ...overrides });
  const scenarioFixtures = fixtures;
  const ensureCampus = async (harness, session) => {
    session.campus ??= await api.prepareCampusSafeNoChange({ harness });
    return session.campus;
  };
  const ensureZeroAction = async (harness, session) => {
    const campus = await ensureCampus(harness, session);
    session.zeroAction ??= await api.completeCampusZeroActionReview({ page: harness.page, campus });
    return session.zeroAction;
  };
  const ensureExecutionPlanning = async (harness, session, gateFixtures) => {
    if (!session.executionPreparation) {
      session.executionPreparation = await api.prepareRetainedExecutionFixture({ harness, gateFixtures });
      session.executionPlanning = await api.beginRetainedExecutionPlanning({ page: harness.page });
    }
    return session.executionPlanning;
  };
  const ensureExecutionReview = async (harness, session, gateFixtures) => {
    await ensureExecutionPlanning(harness, session, gateFixtures);
    session.executionReview ??= await api.applyRetainedExecutionHumanReview({ page: harness.page });
    assert.equal(session.executionReview.requiredEntryCount, 5);
    assert.equal(session.executionReview.pendingRequiredEntryCount, 0);
    assert.equal(session.executionReview.autoApproval, false);
    assert.equal(session.executionReview.reviewBypass, false);
    return session.executionReview;
  };
  const ensureExecutionPreflight = async (harness, session, gateFixtures) => {
    await ensureExecutionReview(harness, session, gateFixtures);
    session.executionPreflight ??= await api.preflightRetainedExecution(harness.page);
    return session.executionPreflight;
  };
  const ensureExecution = async (harness, session, gateFixtures) => {
    await ensureExecutionPreflight(harness, session, gateFixtures);
    session.execution ??= await api.executeRetainedReviewedPlan({ page: harness.page });
    return session.execution;
  };
  const ensureExecutionUndoRedo = async (harness, session, gateFixtures) => {
    const execution = await ensureExecution(harness, session, gateFixtures);
    session.executionUndoRedo ??= await api.exerciseRetainedExecutionUndoRedo({
      page: harness.page,
      preProjectFingerprint: execution.preProjectFingerprint,
      executedProjectFingerprint: execution.postProjectFingerprint,
      preProjectSnapshot: execution.preProjectSnapshot,
      executedProjectSnapshot: execution.postProjectSnapshot,
    });
    return session.executionUndoRedo;
  };
  const ensureRepairPlanning = async (harness, session, gateFixtures) => {
    if (!session.repairPreparation) {
      session.repairPreparation = await api.prepareRetainedRepairFixture({ harness, gateFixtures });
      session.repairPlanning = await api.beginRetainedRepairPlanning({ page: harness.page });
      assert.ok(session.repairPlanning.defectCodes.includes('IMMEDIATE_ASSET_REPEAT'));
      assert.ok(session.repairPlanning.defectCodes.includes('RECENT_ASSET_REUSE'));
    }
    return session.repairPlanning;
  };
  const ensureRepair = async (harness, session, gateFixtures) => {
    await ensureRepairPlanning(harness, session, gateFixtures);
    session.repairReview ??= await api.applyRetainedRepairHumanReview({ page: harness.page });
    assert.equal(session.repairReview.reviewLifecycle, 'REPAIR_READY_TO_EXECUTE');
    assert.equal(session.repairReview.provenance, 'REPAIR_USER_ACCEPTED');
    assert.equal(session.repairReview.autoApproval, false);
    assert.equal(session.repairReview.reviewBypass, false);
    session.repairPreflight ??= await api.preflightRetainedRepair(harness.page);
    assert.equal(session.repairPreflight.canonicalValidator, 'PASS');
    assert.equal(session.repairPreflight.hardConstraintValidator, 'PASS');
    assert.equal(session.repairPreflight.protectedViolationCount, 0);
    session.repairExecution ??= await api.executeRetainedRepair({ page: harness.page });
    session.repairEvaluation ??= await api.evaluateRetainedRepairResult(harness.page);
    assert.equal(session.repairEvaluation.evaluationCount, 1);
    assert.equal(session.repairEvaluation.remainingDefectCount, 0);
    return session.repairExecution;
  };
  const ensureMedia = async (harness, session, gateFixtures) => {
    session.media ??= await api.prepareRetainedOwnedMedia({ harness, gateFixtures });
    assert.equal(session.media.fixtureAssetId, session.media.boundMediaAssetId);
    assert.equal(session.media.fixtureAssetId, session.media.clipReferencedAssetId);
    return session.media;
  };

  return Object.freeze({
    fixtures: scenarioFixtures,
    resolveFixturesForGate,
    async setup({ harness }) {
      const authentication = await api.authenticateAcceptanceBrowserToEditor({ harness });
      return {
        authentication,
        campus: null, zeroAction: null,
        executionPreparation: null, executionPlanning: null, executionReview: null,
        executionPreflight: null, execution: null, executionUndoRedo: null,
        repairPreparation: null, repairPlanning: null, repairReview: null,
        repairPreflight: null, repairExecution: null, repairEvaluation: null, repairUndoRedo: null,
        staleContracts: null, repairRoundPolicy: null,
        media: null, preview: null, export: null, mediaCleanup: null, finalReport: null,
      };
    },
    async beforeTeardown({ harness, session }) {
      assert.ok(harness?.page && session?.authentication?.authenticated, 'Durable retained session is unavailable before teardown');
    },
    async runGate({ id, harness, session, gateFixtures }) {
      assert.equal(DURABLE_R11E_PHASE_BY_GATE[id], gateFixtures.phase, `Wrong fixture phase for ${id}`);
      switch (id) {
        case 'G2-A': {
          const result = await ensureCampus(harness, session);
          assert.equal(result.proposalStatus, 'SAFE_NO_CHANGE');
          break;
        }
        case 'G2-B': {
          const result = await ensureZeroAction(harness, session);
          assert.equal(result.reviewLifecycle, 'REVIEWED_NO_ACTIONS');
          assert.equal(result.historyRecordCommitted, false);
          break;
        }
        case 'G2-C': {
          const result = await ensureExecutionPlanning(harness, session, gateFixtures);
          assert.equal(result.lifecycleStatus, 'PENDING_REVIEW');
          assert.equal(result.compiledActionCount, 4);
          break;
        }
        case 'G2-D': {
          const result = await ensureExecutionReview(harness, session, gateFixtures);
          assert.equal(result.acceptedEntries.length, 3);
          break;
        }
        case 'G2-E': {
          const result = await ensureExecutionReview(harness, session, gateFixtures);
          assert.deepEqual(result.rejectedEntries.map(item => item.intervalId), ['interval-treatment']);
          break;
        }
        case 'G2-F': {
          const result = await ensureExecutionReview(harness, session, gateFixtures);
          assert.equal(result.modifiedEntries[0]?.intervalId, 'interval-ecg');
          assert.equal(result.modifiedEntries[0]?.selectedAssetId, 'asset-ecg-alt');
          break;
        }
        case 'G2-G': {
          const result = await ensureExecutionPreflight(harness, session, gateFixtures);
          assert.equal(result.canonicalValidator, 'PASS');
          assert.equal(result.hardConstraintValidator, 'PASS');
          assert.equal(result.executableActionCount, 3);
          break;
        }
        case 'G2-H': {
          const result = await ensureExecution(harness, session, gateFixtures);
          assert.equal(result.snapshot.execution.appliedCount, 3);
          assert.equal(result.snapshot.execution.failedCount, 0);
          break;
        }
        case 'G2-I':
        case 'G2-J': {
          const result = await ensureExecutionUndoRedo(harness, session, gateFixtures);
          assert.equal(id === 'G2-I' ? result.exactUndo : result.exactRedo, true);
          break;
        }
        case 'G2-K': {
          const result = await ensureExecution(harness, session, gateFixtures);
          assert.equal(result.snapshot.evaluator.realizedActionCount, 3);
          assert.equal(result.snapshot.evaluator.hardConstraintCompliance, 'PASS');
          break;
        }
        case 'G2-L': {
          const result = await ensureRepair(harness, session, gateFixtures);
          assert.equal(result.finalStatus, 'REPAIR_FINAL_PASS');
          assert.equal(result.appliedActionCount, 1);
          assert.equal(result.failedActionCount, 0);
          break;
        }
        case 'G2-M': {
          await ensureRepair(harness, session, gateFixtures);
          const evidence = loadRepairScenarioEvidence();
          session.repairRoundPolicy ??= api.verifyRetainedRepairRoundPolicy(repairInput(evidence), evidence.repairProposal);
          assert.equal(session.repairRoundPolicy.maxRepairRounds, 1);
          assert.equal(session.repairEvaluation.evaluationCount, 1);
          break;
        }
        case 'G2-N': {
          await ensureRepair(harness, session, gateFixtures);
          session.repairUndoRedo ??= await api.exerciseRetainedRepairUndoRedo({ page: harness.page });
          assert.equal(session.repairUndoRedo.exactUndo, true);
          assert.equal(session.repairUndoRedo.exactRedo, true);
          break;
        }
        case 'G2-O': {
          session.staleContracts ??= api.verifyDurableStaleAndProtectedContracts();
          assert.equal(session.staleContracts.executionStaleCode, 'STALE_PROPOSAL');
          assert.equal(session.staleContracts.repairStaleCode, 'STALE_REPAIR');
          assert.equal(session.staleContracts.protectedRepairCode, 'HARD_CONSTRAINT_BLOCKED');
          assert.equal(session.staleContracts.emptyNonEnforcingFalseStale, false);
          break;
        }
        case 'G2-P': {
          const media = await ensureMedia(harness, session, gateFixtures);
          session.preview ??= await api.proveRetainedOwnedMediaPreview({ page: harness.page, mediaEvidence: media });
          assert.equal(session.preview.playbackTimeAdvanced, true);
          break;
        }
        case 'G2-Q': {
          const media = await ensureMedia(harness, session, gateFixtures);
          session.export ??= await api.exportAndDownloadRetainedOwnedMedia({ page: harness.page, mediaEvidence: media });
          assert.equal(session.export.exported.outputExists, true);
          assert.equal(session.export.downloaded.fileExists, true);
          assert.equal(session.export.downloaded.tempCleanup, 'PASS');
          break;
        }
        case 'G2-R': {
          if (session.media && !session.mediaCleanup) {
            session.mediaCleanup = await api.cleanupRetainedOwnedMedia({ page: harness.page, mediaEvidence: session.media });
          }
          session.finalReport = await harness.collect();
          for (const key of ['providerCalls', 'unclassifiedConsoleErrors', 'pageErrors', 'unhandledRejections', 'criticalRuntimeErrors', 'unexpectedBlockedRequests']) {
            const value = session.finalReport[key];
            assert.equal(Array.isArray(value) ? value.length : value, 0, `Final retained report ${key} must be zero`);
          }
          break;
        }
        default:
          throw Object.assign(new Error(`DURABLE SCENARIO CONTRACT: unsupported gate ${id}`), { harnessFailure: true });
      }
      return Object.freeze({ id, phase: gateFixtures.phase });
    },
  });
}

const DURABLE_SCENARIO = createDurableR11EScenario();
export const setup = DURABLE_SCENARIO.setup;
export const beforeTeardown = DURABLE_SCENARIO.beforeTeardown;
export const runGate = DURABLE_SCENARIO.runGate;
