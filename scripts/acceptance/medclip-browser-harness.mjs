import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateAcceptanceEditorFixtureV1 } from './editor-input-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
export const DEFAULT_OUT_DIR = resolve(REPO_ROOT, 'out');
export const PROJECT_STORAGE_KEY = 'medclip-editor-draft-v1';
export const ACCEPTANCE_INPUT_BUILD_MARKER = '.medclip-acceptance-input-build-v1.json';
export const DIAGNOSTIC_FLAG = '__MEDCLIP_ACCEPTANCE_DIAGNOSTICS__';
export const DIAGNOSTIC_EVENT = 'medclip:acceptance-diagnostic';
export const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTICS = 500;
const MAX_ERRORS = 250;
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.woff2', 'font/woff2'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'],
]);

function boundedText(value, limit = 1000) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, '[KEY REDACTED]')
    .slice(0, limit);
}

function diagnosticProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value;
  const out = { schemaVersion: source.schemaVersion, kind: source.kind, stage: source.stage };
  if (source.kind === 'NEGOTIATION_STATE') {
    for (const key of ['resolution', 'requestedTargetMs', 'minimumFeasibleMs', 'targetGapMs', 'planningState', 'feasibilityStatus']) out[key] = source[key] ?? null;
  } else if (source.kind === 'SAFE_NO_CHANGE_ELIGIBILITY') {
    out.evaluated = source.evaluated === true;
    out.eligible = source.eligible === true;
    out.reasonCode = boundedText(source.reasonCode, 120);
    out.failedChecks = Array.isArray(source.failedChecks) ? source.failedChecks.map(x => boundedText(x, 120)).slice(0, 40) : [];
    out.passedChecks = Array.isArray(source.passedChecks) ? source.passedChecks.map(x => boundedText(x, 120)).slice(0, 40) : [];
    out.evidence = source.evidence && typeof source.evidence === 'object' ? Object.fromEntries(Object.entries(source.evidence).slice(0, 40).map(([k, v]) => [boundedText(k, 80), typeof v === 'number' || typeof v === 'boolean' || v === null ? v : boundedText(v, 120)])) : {};
  } else if (source.kind === 'EDITOR_PROPOSAL_STAGE') {
    out.outcome = boundedText(source.outcome, 80);
    if (source.failureCategory !== undefined) out.failureCategory = boundedText(source.failureCategory, 100);
  } else if (source.kind === 'ZERO_ACTION_REVIEW_RESULT') {
    const statusKeys = ['proposalStatus', 'reviewLifecycle', 'reviewedPlanStatus', 'planEvidenceLifecycleStatus'];
    const booleanKeys = ['executionPresent', 'historyShouldRecord', 'historyRecordCommitted'];
    const countKeys = ['proposalActionCount', 'reviewedActionCount', 'executedActionCount'];
    if (source.schemaVersion !== 1 || source.stage !== 'ZERO_ACTION_REVIEW_RESULT'
      || statusKeys.some(key => typeof source[key] !== 'string' || source[key].length === 0)
      || booleanKeys.some(key => typeof source[key] !== 'boolean')
      || countKeys.some(key => !Number.isSafeInteger(source[key]) || source[key] < 0)) return null;
    for (const key of statusKeys) out[key] = boundedText(source[key], 80);
    for (const key of booleanKeys) out[key] = source[key];
    for (const key of countKeys) out[key] = source[key];
  } else if (source.kind === 'ACCEPTANCE_INPUT_HYDRATED' || source.kind === 'ACCEPTANCE_INPUT_AVAILABLE') {
    out.fixtureVersion = Number.isSafeInteger(source.fixtureVersion) ? source.fixtureVersion : null;
    out.semanticAssetCount = Number.isSafeInteger(source.semanticAssetCount) ? source.semanticAssetCount : 0;
    out.rhythmEvidencePresent = source.rhythmEvidencePresent === true;
    out.category = boundedText(source.category, 80);
    if (typeof source.fixtureId === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(source.fixtureId)) {
      out.fixtureId = source.fixtureId;
    }
  } else return null;
  return out;
}

export function acceptanceInitScript() {
  window.__MEDCLIP_ACCEPTANCE_DIAGNOSTICS__ = true;
  window.__MEDCLIP_ACCEPTANCE_DOCUMENT_ID__ = globalThis.crypto?.randomUUID?.()
    ?? `acceptance-document-${Date.now()}-${Math.random()}`;
  window.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__ = [];
  window.__MEDCLIP_ACCEPTANCE_ERRORS__ = [];
  const pushBounded = (key, value, cap) => {
    const buffer = window[key];
    if (buffer.length < cap) buffer.push(value);
  };
  const sanitize = source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    const output = { schemaVersion: source.schemaVersion, kind: source.kind, stage: source.stage };
    if (source.kind === 'NEGOTIATION_STATE') {
      for (const key of ['resolution', 'requestedTargetMs', 'minimumFeasibleMs', 'targetGapMs', 'planningState', 'feasibilityStatus']) output[key] = source[key] ?? null;
    } else if (source.kind === 'SAFE_NO_CHANGE_ELIGIBILITY') {
      output.evaluated = source.evaluated === true;
      output.eligible = source.eligible === true;
      output.reasonCode = String(source.reasonCode ?? '').slice(0, 120);
      output.failedChecks = Array.isArray(source.failedChecks) ? source.failedChecks.map(value => String(value).slice(0, 120)).slice(0, 40) : [];
      output.passedChecks = Array.isArray(source.passedChecks) ? source.passedChecks.map(value => String(value).slice(0, 120)).slice(0, 40) : [];
      output.evidence = source.evidence && typeof source.evidence === 'object' ? Object.fromEntries(Object.entries(source.evidence).slice(0, 40).map(([key, value]) => [String(key).slice(0, 80), typeof value === 'number' || typeof value === 'boolean' || value === null ? value : String(value).slice(0, 120)])) : {};
    } else if (source.kind === 'EDITOR_PROPOSAL_STAGE') {
      output.outcome = String(source.outcome ?? '').slice(0, 80);
      if (source.failureCategory !== undefined) output.failureCategory = String(source.failureCategory).slice(0, 100);
    } else if (source.kind === 'ZERO_ACTION_REVIEW_RESULT') {
      const statusKeys = ['proposalStatus', 'reviewLifecycle', 'reviewedPlanStatus', 'planEvidenceLifecycleStatus'];
      const booleanKeys = ['executionPresent', 'historyShouldRecord', 'historyRecordCommitted'];
      const countKeys = ['proposalActionCount', 'reviewedActionCount', 'executedActionCount'];
      if (source.schemaVersion !== 1 || source.stage !== 'ZERO_ACTION_REVIEW_RESULT'
        || statusKeys.some(key => typeof source[key] !== 'string' || source[key].length === 0)
        || booleanKeys.some(key => typeof source[key] !== 'boolean')
        || countKeys.some(key => !Number.isSafeInteger(source[key]) || source[key] < 0)) return null;
      for (const key of ['proposalStatus', 'reviewLifecycle', 'reviewedPlanStatus', 'planEvidenceLifecycleStatus']) {
        output[key] = source[key].slice(0, 80);
      }
      for (const key of booleanKeys) output[key] = source[key];
      for (const key of ['proposalActionCount', 'reviewedActionCount', 'executedActionCount']) {
        output[key] = source[key];
      }
    } else if (source.kind === 'ACCEPTANCE_INPUT_HYDRATED' || source.kind === 'ACCEPTANCE_INPUT_AVAILABLE') {
      output.fixtureVersion = Number.isSafeInteger(source.fixtureVersion) ? source.fixtureVersion : null;
      output.semanticAssetCount = Number.isSafeInteger(source.semanticAssetCount) ? source.semanticAssetCount : 0;
      output.rhythmEvidencePresent = source.rhythmEvidencePresent === true;
      output.category = String(source.category ?? '').slice(0, 80);
      const fixtureId = new URLSearchParams(window.location.search).get('fixture');
      if (fixtureId && /^[a-z0-9][a-z0-9-]{0,127}$/.test(fixtureId)) output.fixtureId = fixtureId;
    } else return null;
    return output;
  };
  window.addEventListener('medclip:acceptance-diagnostic', event => {
    const detail = event && typeof event === 'object' ? event.detail : null;
    if (!detail || typeof detail !== 'object') return;
    const diagnostic = sanitize(detail);
    if (!diagnostic) return;
    const value = { sequence: window.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__.length + 1, diagnostic };
    pushBounded('__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__', value, 500);
  });
  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    pushBounded('__MEDCLIP_ACCEPTANCE_ERRORS__', { type: 'unhandledrejection', message: String(reason?.message ?? reason ?? 'Unhandled rejection').slice(0, 1000) }, 250);
  });
}

export function acceptanceEditorFixtureInitScript({ storageKey, project, inputEvidence, fixtureId = null }) {
  if (fixtureId !== null) {
    const params = new URLSearchParams(window.location.search);
    if (params.get('acceptanceInput') !== '1' || params.get('fixture') !== fixtureId) return;
  }
  window.localStorage.setItem(storageKey, JSON.stringify(project));
  window.__MEDCLIP_ACCEPTANCE_INPUT_EVIDENCE__ = inputEvidence;
}

function hydrationContractError(message, cause) {
  return Object.assign(new Error(`ACCEPTANCE HYDRATION CONTRACT: ${message}`, cause ? { cause } : undefined), {
    harnessFailure: true,
  });
}

export async function assertAcceptanceInputHydrationBuild(outDir = DEFAULT_OUT_DIR) {
  const resolvedOutDir = resolve(outDir);
  let marker;
  let editorHtml;
  try {
    [marker, editorHtml] = await Promise.all([
      readFile(resolve(resolvedOutDir, ACCEPTANCE_INPUT_BUILD_MARKER), 'utf8').then(JSON.parse),
      readFile(resolve(resolvedOutDir, 'editor.html')),
    ]);
  } catch (error) {
    throw hydrationContractError('static root is not an attested acceptance-input build; run npm run build:acceptance-input', error);
  }
  const editorHtmlSha256 = createHash('sha256').update(editorHtml).digest('hex');
  if (marker?.schemaVersion !== 1 || marker?.acceptanceInputHydration !== true
    || marker?.editorHtmlSha256 !== editorHtmlSha256) {
    throw hydrationContractError('acceptance-input build attestation is missing, invalid, or stale; run npm run build:acceptance-input');
  }
  return Object.freeze({ outDir: resolvedOutDir, editorHtmlSha256 });
}

export function canonicalProjectSnapshot(project) {
  assert.ok(project && typeof project === 'object' && !Array.isArray(project), 'Persisted EditorProject must be an object');
  assert.ok(Array.isArray(project.tracks) && Array.isArray(project.assets), 'Persisted EditorProject shape is invalid');
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
  return canonicalize(material);
}

export function canonicalProjectFingerprint(project) {
  const json = JSON.stringify(canonicalProjectSnapshot(project));
  return `editor-project-r10c-sha256-${createHash('sha256').update(json, 'utf8').digest('hex')}`;
}

export async function readAuthoritativeProject(page) {
  const project = await page.evaluate(key => {
    const serialized = window.localStorage.getItem(key);
    return serialized ? JSON.parse(serialized) : null;
  }, PROJECT_STORAGE_KEY);
  assert.ok(project, 'Authoritative persisted EditorProject is unavailable');
  return project;
}

export async function readCanonicalProjectSnapshot(page) {
  return canonicalProjectSnapshot(await readAuthoritativeProject(page));
}

export async function readCanonicalProjectFingerprint(page) {
  return canonicalProjectFingerprint(await readAuthoritativeProject(page));
}

export const NEGOTIATION_OPTION_CONTRACTS = Object.freeze({
  RELAX_TARGET_DURATION: Object.freeze({
    label: 'A', diagnosticId: 'G2A_NEGOTIATION_OPTION_A_RESOLUTION',
    accessibleName: 'A. 允许视频超过30秒，优先保证讲话和Logo完整',
  }),
  OPTIMIZE_UNPROTECTED_ONLY: Object.freeze({
    label: 'B', diagnosticId: 'G2A_NEGOTIATION_OPTION_B_RESOLUTION',
    accessibleName: 'B. 优先压缩其他非保护内容，尽量接近30秒，但不改变讲话和Logo',
  }),
  EDIT_REQUIREMENTS_MANUALLY: Object.freeze({
    label: 'C', diagnosticId: 'G2A_NEGOTIATION_OPTION_C_RESOLUTION',
    accessibleName: 'C. 暂时不执行，我要手动修改要求',
  }),
});

const NEGOTIATION_PANEL_SELECTOR = 'section.constraint-negotiation-panel[aria-label="约束协商"]';
const VISIBLE_NEGOTIATION_PANEL_SELECTOR = `${NEGOTIATION_PANEL_SELECTOR}:visible`;

export async function readNegotiationOptionSnapshot(page) {
  return page.evaluate(({ panelSelector }) => {
    const visible = element => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden'
        && style.opacity !== '0' && element.getClientRects().length > 0;
    };
    const panels = [...document.querySelectorAll(panelSelector)];
    const visiblePanels = panels.filter(visible);
    const controls = visiblePanels.flatMap(panel => [...panel.querySelectorAll('button')].map(button => ({
      accessibleName: (button.getAttribute('aria-label') ?? button.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
      visible: visible(button),
      enabled: !button.disabled && button.getAttribute('aria-disabled') !== 'true',
      semanticIdentity: button.getAttribute('data-negotiation-option'),
    })));
    return {
      negotiationState: document.querySelector('.creative-intent-panel header span')?.textContent?.trim() ?? null,
      panelCount: panels.length,
      visiblePanelCount: visiblePanels.length,
      interactiveControlCount: controls.length,
      visibleOptionControlCount: controls.filter(control => control.visible && control.enabled).length,
      controls: controls.slice(0, 10),
    };
  }, { panelSelector: NEGOTIATION_PANEL_SELECTOR });
}

function negotiationResolutionError(identity, snapshot, cause) {
  const contract = NEGOTIATION_OPTION_CONTRACTS[identity];
  const diagnosticId = contract?.diagnosticId ?? 'G2A_NEGOTIATION_OPTION_UNKNOWN_RESOLUTION';
  return Object.assign(new Error(
    `[${diagnosticId}] phase=NEGOTIATION requestedSemanticKey=${identity}`
    + ` negotiationState=${snapshot.negotiationState} panelCount=${snapshot.panelCount}`
    + ` visiblePanelCount=${snapshot.visiblePanelCount}`
    + ` interactiveControlCount=${snapshot.interactiveControlCount}`
    + ` visibleOptionControlCount=${snapshot.visibleOptionControlCount}`
    + ` controls=${JSON.stringify(snapshot.controls ?? [])}`,
    { cause },
  ), { harnessFailure: true });
}

function assertNegotiationSnapshotReady(identity, snapshot) {
  if (snapshot.negotiationState !== 'NEEDS_USER_DECISION'
    || snapshot.panelCount < 1 || snapshot.visiblePanelCount !== 1) {
    throw negotiationResolutionError(identity, snapshot, new Error('Negotiation panel is not ready'));
  }
  for (const [semanticKey, contract] of Object.entries(NEGOTIATION_OPTION_CONTRACTS)) {
    const matches = snapshot.controls.filter(control => control.visible && control.enabled
      && control.accessibleName === contract.accessibleName);
    if (matches.length !== 1) {
      throw negotiationResolutionError(identity, snapshot,
        new Error(`Expected one visible ${semanticKey} control, received ${matches.length}`));
    }
  }
}

export async function selectNegotiationOption(page, identity, timeout = 10_000) {
  const contract = NEGOTIATION_OPTION_CONTRACTS[identity];
  assert.ok(contract, `Unsupported semantic negotiation identity: ${identity}`);
  try {
    await page.waitForFunction(({ panelSelector, options }) => {
      const visible = element => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && style.opacity !== '0' && element.getClientRects().length > 0;
      };
      const state = document.querySelector('.creative-intent-panel header span')?.textContent?.trim();
      const panels = [...document.querySelectorAll(panelSelector)].filter(visible);
      if (state !== 'NEEDS_USER_DECISION' || panels.length !== 1) return false;
      const buttons = [...panels[0].querySelectorAll('button')];
      return options.every(({ accessibleName }) => buttons.filter(button => {
        const name = (button.getAttribute('aria-label') ?? button.textContent ?? '').replace(/\s+/g, ' ').trim();
        return name === accessibleName && visible(button) && !button.disabled
          && button.getAttribute('aria-disabled') !== 'true';
      }).length === 1);
    }, {
      panelSelector: NEGOTIATION_PANEL_SELECTOR,
      options: Object.values(NEGOTIATION_OPTION_CONTRACTS),
    }, { timeout });
  } catch (cause) {
    throw negotiationResolutionError(identity, await readNegotiationOptionSnapshot(page), cause);
  }
  const snapshot = await readNegotiationOptionSnapshot(page);
  assertNegotiationSnapshotReady(identity, snapshot);
  const panel = page.locator(VISIBLE_NEGOTIATION_PANEL_SELECTOR);
  const option = panel.getByRole('button', { name: contract.accessibleName, exact: true });
  const count = await option.count();
  if (count !== 1 || !await option.isVisible() || !await option.isEnabled()) {
    throw negotiationResolutionError(identity, await readNegotiationOptionSnapshot(page),
      new Error(`Exact semantic option control is unavailable; count=${count}`));
  }
  await option.click();
}

export async function waitForNegotiationState(page, expected, timeout = 10_000) {
  const exact = {
    resolution: expected.resolution,
    requestedTargetMs: expected.requestedTargetMs,
    minimumFeasibleMs: expected.minimumFeasibleMs,
    targetGapMs: expected.targetGapMs,
    planningState: expected.planningState,
  };
  await page.waitForFunction(wanted => {
    const events = window.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__ ?? [];
    return events.some(({ diagnostic }) => diagnostic?.kind === 'NEGOTIATION_STATE'
      && Object.entries(wanted).every(([key, value]) => diagnostic[key] === value));
  }, exact, { timeout });
  return (await readAcceptanceDiagnostics(page)).findLast(({ diagnostic }) => diagnostic?.kind === 'NEGOTIATION_STATE' && Object.entries(exact).every(([key, value]) => diagnostic[key] === value))?.diagnostic;
}

export const CAMPUS_OPTION_B_EXPECTED = Object.freeze({
  resolution: 'OPTIMIZE_UNPROTECTED_ONLY', requestedTargetMs: 30_000,
  minimumFeasibleMs: 38_000, targetGapMs: 8_000, planningState: 'READY_TO_PLAN',
});

export async function readAcceptanceDiagnostics(page) {
  const raw = await page.evaluate(() => window.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__ ?? []);
  return raw.map((item, index) => ({
    sequence: Number.isSafeInteger(item?.sequence) && item.sequence > 0 ? item.sequence : index + 1,
    diagnostic: diagnosticProjection(item?.diagnostic),
  })).filter(item => item.diagnostic);
}

export async function captureAcceptanceDiagnosticBaseline(page) {
  const diagnostics = await readAcceptanceDiagnostics(page);
  return Object.freeze({ sequence: diagnostics.at(-1)?.sequence ?? 0 });
}

export async function captureAcceptanceHydrationBaseline(page) {
  const baseline = await page.evaluate(() => ({
    documentId: window.__MEDCLIP_ACCEPTANCE_DOCUMENT_ID__ ?? null,
    sequence: (window.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__ ?? []).at(-1)?.sequence ?? 0,
  }));
  if (typeof baseline?.documentId !== 'string' || baseline.documentId.length === 0
    || !Number.isSafeInteger(baseline?.sequence) || baseline.sequence < 0) {
    throw hydrationContractError('acceptance diagnostic document baseline is unavailable');
  }
  return Object.freeze({ documentId: baseline.documentId, sequence: baseline.sequence });
}

export async function waitForAcceptanceInputHydration(page, fixture, baseline, timeout = 10_000) {
  const validatedFixture = validateAcceptanceEditorFixtureV1(fixture);
  if (typeof baseline?.documentId !== 'string' || baseline.documentId.length === 0
    || !Number.isSafeInteger(baseline?.sequence) || baseline.sequence < 0) {
    throw hydrationContractError('a captured hydration baseline is required');
  }
  const expected = {
    priorDocumentId: baseline.documentId,
    fixtureId: validatedFixture.fixtureId,
    fixtureVersion: validatedFixture.inputEvidence.version,
    semanticAssetCount: validatedFixture.fixtureAssertions.semanticAssetCount,
    rhythmEvidencePresent: validatedFixture.fixtureAssertions.rhythmEvidencePresent,
  };
  await page.waitForFunction(wanted => {
    if (!window.__MEDCLIP_ACCEPTANCE_DOCUMENT_ID__
      || window.__MEDCLIP_ACCEPTANCE_DOCUMENT_ID__ === wanted.priorDocumentId) return false;
    return (window.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__ ?? []).some(item => {
      const diagnostic = item?.diagnostic;
      return diagnostic?.kind === 'ACCEPTANCE_INPUT_HYDRATED'
        && diagnostic?.category === 'SUCCESS'
        && diagnostic?.fixtureId === wanted.fixtureId
        && diagnostic?.fixtureVersion === wanted.fixtureVersion
        && diagnostic?.semanticAssetCount === wanted.semanticAssetCount
        && diagnostic?.rhythmEvidencePresent === wanted.rhythmEvidencePresent;
    });
  }, expected, { timeout });
  const diagnostic = (await readAcceptanceDiagnostics(page)).findLast(item =>
    item.diagnostic.kind === 'ACCEPTANCE_INPUT_HYDRATED'
      && item.diagnostic.fixtureId === validatedFixture.fixtureId
      && item.diagnostic.category === 'SUCCESS')?.diagnostic;
  if (!diagnostic) throw hydrationContractError(`new hydration evidence is unavailable for ${validatedFixture.fixtureId}`);
  return Object.freeze({ ...diagnostic });
}

export async function transitionAcceptanceEditorFixture({
  harness, editorInputFixture, timeout = 10_000,
} = {}) {
  if (!harness?.context || !harness?.page || !harness?.server?.url || !harness?.outDir) {
    throw hydrationContractError('owned harness context, page, server, and static root are required');
  }
  let fixture;
  try { fixture = validateAcceptanceEditorFixtureV1(editorInputFixture); }
  catch (error) { throw hydrationContractError('editorInputFixture is invalid', error); }
  await assertAcceptanceInputHydrationBuild(harness.outDir);
  const baseline = await captureAcceptanceHydrationBaseline(harness.page);
  await harness.context.addInitScript(acceptanceEditorFixtureInitScript, {
    fixtureId: fixture.fixtureId,
    storageKey: PROJECT_STORAGE_KEY,
    project: fixture.initialProject,
    inputEvidence: fixture.inputEvidence,
  });
  const target = `${harness.server.url}/editor?acceptanceInput=1&fixture=${encodeURIComponent(fixture.fixtureId)}`;
  await harness.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const url = new URL(harness.page.url());
  if (url.pathname !== '/editor' || url.searchParams.get('fixture') !== fixture.fixtureId) {
    throw hydrationContractError(`editor fixture route did not retain ${fixture.fixtureId}`);
  }
  const diagnostic = await waitForAcceptanceInputHydration(harness.page, fixture, baseline, timeout);
  return Object.freeze({ fixtureId: fixture.fixtureId, baseline, diagnostic });
}

const ZERO_ACTION_REVIEW_FIELDS = Object.freeze([
  'proposalStatus', 'reviewLifecycle', 'reviewedPlanStatus', 'planEvidenceLifecycleStatus',
  'executionPresent', 'historyShouldRecord', 'historyRecordCommitted',
  'proposalActionCount', 'reviewedActionCount', 'executedActionCount',
]);

function zeroActionReviewSnapshot(diagnostic) {
  assert.equal(diagnostic.schemaVersion, 1, 'ZERO_ACTION_REVIEW_RESULT schema version is invalid');
  assert.equal(diagnostic.stage, 'ZERO_ACTION_REVIEW_RESULT', 'ZERO_ACTION_REVIEW_RESULT stage is invalid');
  for (const field of ZERO_ACTION_REVIEW_FIELDS) {
    assert.ok(Object.hasOwn(diagnostic, field), `ZERO_ACTION_REVIEW_RESULT is missing ${field}`);
  }
  assert.equal(diagnostic.proposalStatus, 'SAFE_NO_CHANGE');
  assert.equal(diagnostic.reviewLifecycle, 'REVIEWED_NO_ACTIONS');
  assert.equal(diagnostic.reviewedPlanStatus, 'REVIEWED_NO_ACTIONS');
  assert.equal(diagnostic.planEvidenceLifecycleStatus, 'REVIEWED_NO_ACTIONS');
  assert.equal(diagnostic.executionPresent, false);
  assert.equal(diagnostic.historyShouldRecord, false);
  assert.equal(diagnostic.historyRecordCommitted, false);
  assert.equal(diagnostic.proposalActionCount, 0);
  assert.equal(diagnostic.reviewedActionCount, 0);
  assert.equal(diagnostic.executedActionCount, 0);
  return Object.freeze(Object.fromEntries(ZERO_ACTION_REVIEW_FIELDS.map(field => [field, diagnostic[field]])));
}

export async function waitForZeroActionReviewResult(page, baseline, timeout = 10_000) {
  assert.ok(baseline && Number.isSafeInteger(baseline.sequence) && baseline.sequence >= 0,
    'A captured acceptance diagnostic baseline is required');
  await page.waitForFunction(afterSequence => (window.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__ ?? [])
    .some(item => Number.isSafeInteger(item?.sequence) && item.sequence > afterSequence
      && item.diagnostic?.kind === 'ZERO_ACTION_REVIEW_RESULT'), baseline.sequence, { timeout });
  const diagnostics = await readAcceptanceDiagnostics(page);
  const fresh = diagnostics.filter(item => item.sequence > baseline.sequence
    && item.diagnostic.kind === 'ZERO_ACTION_REVIEW_RESULT');
  assert.equal(fresh.length, 1, 'Expected exactly one new ZERO_ACTION_REVIEW_RESULT diagnostic');
  return zeroActionReviewSnapshot(fresh[0].diagnostic);
}

export async function readAcceptanceErrors(page) {
  const fromInit = await page.evaluate(() => window.__MEDCLIP_ACCEPTANCE_ERRORS__ ?? []);
  return fromInit.map(item => ({ ...item, classification: 'UNHANDLED_REJECTION' }));
}

export function classifyBrowserError(error) {
  const message = boundedText(error?.message ?? error, 2000);
  if (/__next(?:\.[^/?\s]+)?\.__PAGE__\.txt.*404|404.*__next(?:\.[^/?\s]+)?\.__PAGE__\.txt/i.test(message)) return { classification: 'STATIC_EXPORT_PREFETCH_NOISE', message };
  return { classification: 'PRODUCT_OR_BROWSER_ERROR', message };
}

export function classifyExpectedFixtureBlock({ method, url, supabaseOrigin, action = null }) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.origin !== supabaseOrigin) return null;
  if (method === 'GET' && parsed.pathname === '/rest/v1/profiles'
    && parsed.searchParams.get('select') === 'id,display_name,avatar_url,created_at'
    && /^eq\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.searchParams.get('id') ?? '')) {
    return { method, pathPattern: '/rest/v1/profiles?select=id,display_name,avatar_url,created_at&id=eq.<uuid>', reason: 'Provider-free isolation intentionally avoids loading the signed-in user profile.', fixture: 'auth-profile-read isolation' };
  }
  if (method === 'POST' && parsed.pathname === '/functions/v1/ai-tasks' && action === null) {
    return { method, pathPattern: '/functions/v1/ai-tasks', reason: 'Provider-free isolation blocks real AI task dispatch when no synthetic response is installed.', fixture: 'provider-free AI task guard' };
  }
  if (method === 'POST' && parsed.pathname === '/functions/v1/ai-credentials' && ['save', 'update', 'delete', 'test'].includes(action)) {
    return { method, pathPattern: '/functions/v1/ai-credentials', reason: 'Provider-free isolation blocks credential writes and validation calls.', fixture: 'read-only provider availability fixture' };
  }
  return null;
}

export function classifyHttpFailure({ method, url, status }) {
  let parsed;
  try { parsed = new URL(url); } catch { return { classification: 'HTTP_FAILURE', method, status, pathPattern: '<invalid-url>' }; }
  const knownPageData404 = parsed.pathname === '/__next.__PAGE__.txt'
    || /^\/(?:auth|editor|create-music|music|ai-services)\/__next\.(?:auth|editor|create-music|music|ai-services)\.__PAGE__\.txt$/i.test(parsed.pathname);
  if (status === 404 && knownPageData404) {
    return { classification: 'STATIC_EXPORT_PREFETCH_NOISE', method, status, pathPattern: parsed.pathname };
  }
  return { classification: 'HTTP_FAILURE', method, status, pathPattern: `${parsed.origin}${parsed.pathname}` };
}

export function classifyNetworkFailure({ method, url, resourceType = null, errorText, pageUrl = null }) {
  let parsed;
  try { parsed = new URL(url); } catch { return { classification: 'NETWORK_REQUEST_FAILURE', method, resourceType, pathPattern: '<invalid-url>', message: boundedText(errorText, 300) }; }
  let blobInnerUrl = null;
  let pageOrigin = null;
  if (parsed.protocol === 'blob:') {
    try { blobInnerUrl = new URL(parsed.pathname); } catch { /* malformed blob URLs remain strict below */ }
    try { pageOrigin = pageUrl ? new URL(pageUrl).origin : null; } catch { /* an unknown page origin cannot authorize a blob cancellation */ }
  }
  const localMediaBlobCancel = parsed.protocol === 'blob:'
    && blobInnerUrl?.protocol === 'http:'
    && (blobInnerUrl.hostname === 'localhost' || blobInnerUrl.hostname === '127.0.0.1')
    && blobInnerUrl.origin === pageOrigin
    && resourceType === 'media'
    && method === 'GET'
    && errorText === 'net::ERR_ABORTED';
  if (localMediaBlobCancel) {
    return {
      classification: 'EXPECTED_LOCAL_MEDIA_BLOB_CANCEL',
      method,
      resourceType,
      status: null,
      pathPattern: url,
      rawUrl: url,
      reason: 'A same-origin loopback media blob load was cancelled during the normal media element lifecycle.',
    };
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  const routes = ['auth', 'editor', 'create-music', 'music', 'ai-services'];
  const knownHeadRoute = new Set(['/', ...routes.map(route => `/${route}`)]).has(parsed.pathname);
  const rootPageData = parsed.pathname === '/__next.__PAGE__.txt' || /^\/__next\._(?:tree|head|index)\.txt$/i.test(parsed.pathname);
  const routePageData = routes.some(route => parsed.pathname === `/${route}/__next.${route}.txt`
    || parsed.pathname === `/${route}/__next.${route}.__PAGE__.txt`
    || ['tree', 'head', 'index'].some(kind => parsed.pathname === `/${route}/__next._${kind}.txt`));
  if (loopback && /net::ERR_ABORTED/i.test(errorText ?? '') && (method === 'HEAD' && knownHeadRoute || method === 'GET' && (rootPageData || routePageData))) {
    return { classification: 'STATIC_EXPORT_PREFETCH_NOISE', method, status: null, pathPattern: parsed.pathname, reason: 'Loopback static-export prefetch was cancelled by a later navigation.' };
  }
  return {
    classification: 'NETWORK_REQUEST_FAILURE',
    method,
    resourceType,
    pathPattern: parsed.protocol === 'blob:' ? url : `${parsed.origin}${parsed.pathname}`,
    message: boundedText(errorText, 300),
  };
}

export async function ensureAdvancedSettingsOpen(page) {
  const section = page.locator('details.requirement-advanced');
  assert.equal(await section.count(), 1, '[REQUIREMENT_ADVANCED_SECTION_COUNT] phase=REQUIREMENT_OPEN expected=1');
  const isOpen = async () => (await section.getAttribute('open')) !== null;
  if (!(await isOpen())) {
    const summary = page.locator('details.requirement-advanced > summary');
    assert.equal(await summary.count(), 1, '[REQUIREMENT_ADVANCED_SUMMARY_COUNT] phase=REQUIREMENT_OPEN expected=1');
    assert.equal(await summary.isVisible(), true, 'Advanced Settings summary must be visible');
    await summary.click();
    await page.waitForFunction(() => document.querySelector('details.requirement-advanced')?.open === true, undefined, { timeout: 5_000 });
  }
  assert.equal(await isOpen(), true, 'Advanced Settings did not expand');
  return section;
}

export async function openRequirementFlow(page) {
  const section = await ensureAdvancedSettingsOpen(page);
  const control = section.getByRole('button', { name: /填写视频与音频编排需求/ });
  assert.equal(await control.count(), 1, '[REQUIREMENT_OPEN_CONTROL_COUNT] phase=REQUIREMENT_OPEN expected=1');
  assert.equal(await control.isVisible(), true, 'Requirement control is not visible after expansion');
  assert.equal(await control.isEnabled(), true, 'Requirement control is disabled');
  await control.click();
  const input = page.getByLabel(/具体剪辑要求/);
  await input.waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await input.isEnabled(), true, 'Requirement input is disabled');
  return input;
}

export const ACCEPTANCE_FIXTURE_UNMAPPED_REQUEST = 'ACCEPTANCE FIXTURE UNMAPPED REQUEST';

function syntheticIntentRequestContext(request, url) {
  let requestBody;
  try { requestBody = request.postDataJSON(); } catch { return null; }
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) return null;
  const input = requestBody.input && typeof requestBody.input === 'object' && !Array.isArray(requestBody.input)
    ? Object.freeze({ ...requestBody.input }) : null;
  const task = typeof requestBody.task === 'string' ? requestBody.task : null;
  const provider = typeof requestBody.provider === 'string' ? requestBody.provider : null;
  return Object.freeze({
    method: request.method(),
    url: Object.freeze({ origin: url.origin, pathname: url.pathname }),
    task,
    provider,
    input,
    requestBody: Object.freeze({ task, provider, input }),
  });
}

export async function installAcceptanceFixtures(page, {
  providerAvailability = null,
  syntheticIntentResponse = null,
  syntheticIntentResponseResolver = null,
  env = process.env,
} = {}) {
  let syntheticIntentRequests = 0;
  const expectedFixtureBlocks = [];
  const unexpectedBlockedRequests = [];
  const expectedBlockedRequests = new WeakSet();
  const unexpectedBlockedRequestSet = new WeakSet();
  const expectedBlockWaiters = new Set();
  let pendingExpectedBlockedConsoleErrors = 0;
  let supabaseOrigin = null;
  try { if (env.NEXT_PUBLIC_SUPABASE_URL) supabaseOrigin = new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin; } catch { /* no remote routes are trusted */ }
  const providerIds = new Set(['deepseek', 'kimi', 'doubao', 'tencent_tokenhub']);
  if (providerAvailability) {
    assert.ok(providerIds.has(providerAvailability.provider), 'Unsupported fixture provider');
    assert.equal(providerAvailability.status, 'connected', 'Fixture may only simulate connected availability');
  }
  assert.equal(
    syntheticIntentResponse !== null && syntheticIntentResponseResolver !== null,
    false,
    'Acceptance intent fixture must configure either syntheticIntentResponse or syntheticIntentResponseResolver, not both',
  );
  if (syntheticIntentResponseResolver !== null) {
    assert.equal(typeof syntheticIntentResponseResolver, 'function', 'syntheticIntentResponseResolver must be a function');
  }
  if (syntheticIntentResponse !== null) assertSyntheticIntentOnly(syntheticIntentResponse);
  const providerBody = providerAvailability ? {
    ok: true, connections: [{ id: 'acceptance-only-provider', user_id: 'acceptance-only-user', provider: providerAvailability.provider,
      provider_resource_id: null, key_last4: '0000', status: 'connected', last_validated_at: null,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }],
  } : { ok: true, connections: [] };
  await page.route('**/*', async route => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); }
    catch {
      unexpectedBlockedRequestSet.add(request);
      unexpectedBlockedRequests.push({ method: request.method(), pathPattern: '<invalid-url>', reason: 'Unparseable request URL was blocked.' });
      return route.abort('blockedbyclient');
    }
    const expectedBlock = supabaseOrigin ? classifyExpectedFixtureBlock({
      method: request.method(), url: url.href, supabaseOrigin,
      action: (() => { try { return request.postDataJSON()?.action ?? null; } catch { return null; } })(),
    }) : null;
    const expectedAbort = async () => {
      expectedBlockedRequests.add(request);
      expectedFixtureBlocks.push(expectedBlock);
      pendingExpectedBlockedConsoleErrors += 1;
      for (const waiter of expectedBlockWaiters) {
        if (waiter.predicate(expectedBlock)) {
          expectedBlockWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(expectedBlock);
        }
      }
      return route.abort('blockedbyclient');
    };
    const unexpectedAbort = async (reason) => {
      unexpectedBlockedRequestSet.add(request);
      unexpectedBlockedRequests.push({ method: request.method(), pathPattern: `${url.origin}${url.pathname}`, reason });
      return route.abort('blockedbyclient');
    };
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
    if (supabaseOrigin && url.origin === supabaseOrigin && url.pathname === '/auth/v1/token' && request.method() === 'POST' && url.searchParams.get('grant_type') === 'password') return route.continue();
    if (supabaseOrigin && url.origin === supabaseOrigin && url.pathname === '/auth/v1/user' && request.method() === 'GET') return route.continue();
    if (expectedBlock?.pathPattern.startsWith('/rest/v1/profiles?')) return expectedAbort();
    if (url.pathname === '/functions/v1/ai-credentials' && supabaseOrigin && url.origin === supabaseOrigin && request.method() === 'POST') {
      let body = {};
      try { body = request.postDataJSON() ?? {}; } catch { /* fail closed below */ }
      if (body.action === 'list' && request.headers()['authorization']?.startsWith('Bearer ')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(providerBody) });
      if (expectedBlock) return expectedAbort();
      return unexpectedAbort('Credential request did not match an approved provider-free fixture action.');
    }
    if (url.pathname === '/functions/v1/ai-tasks' && supabaseOrigin && url.origin === supabaseOrigin && request.method() === 'POST') {
      if (syntheticIntentResponse !== null) {
        syntheticIntentRequests += 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(syntheticIntentResponse) });
      }
      if (syntheticIntentResponseResolver !== null) {
        const context = syntheticIntentRequestContext(request, url);
        if (!context) return unexpectedAbort(ACCEPTANCE_FIXTURE_UNMAPPED_REQUEST);
        let resolvedResponse;
        try { resolvedResponse = await syntheticIntentResponseResolver(context); }
        catch { return unexpectedAbort('ACCEPTANCE FIXTURE RESOLVER FAILURE'); }
        if (resolvedResponse === null || resolvedResponse === undefined) {
          return unexpectedAbort(ACCEPTANCE_FIXTURE_UNMAPPED_REQUEST);
        }
        try { assertSyntheticIntentOnly(resolvedResponse); }
        catch { return unexpectedAbort('ACCEPTANCE FIXTURE INVALID RESPONSE'); }
        syntheticIntentRequests += 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(resolvedResponse) });
      }
      return expectedBlock ? expectedAbort() : unexpectedAbort('AI task request did not match the provider-free POST fixture.');
    }
    if (url.origin === supabaseOrigin) return unexpectedAbort('Supabase request was outside the explicit acceptance allowlist.');
    return unexpectedAbort('Remote request was outside the explicit acceptance allowlist.');
  });
  return { providerCalls: 0, expectedFixtureBlocks, unexpectedBlockedRequests,
    isExpectedBlocked: request => expectedBlockedRequests.has(request),
    isUnexpectedBlocked: request => unexpectedBlockedRequestSet.has(request),
    waitForExpectedBlock: (predicate, timeoutMs = 10_000) => {
      const existing = expectedFixtureBlocks.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveBlock, rejectBlock) => {
        const waiter = { predicate, resolve: resolveBlock, timer: null };
        waiter.timer = setTimeout(() => {
          expectedBlockWaiters.delete(waiter);
          rejectBlock(new Error('EXPECTED_FIXTURE_BLOCK_TIMEOUT'));
        }, timeoutMs);
        expectedBlockWaiters.add(waiter);
      });
    },
    dispose: () => {
      for (const waiter of expectedBlockWaiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
      expectedBlockWaiters.clear();
    },
    consumeExpectedBlockedConsoleError: () => {
      if (pendingExpectedBlockedConsoleErrors < 1) return false;
      pendingExpectedBlockedConsoleErrors -= 1;
      return true;
    },
    get syntheticIntentRequests() { return syntheticIntentRequests; } };
}

function createAcceptanceReport() {
  return {
    browserClosed: false, serverStopped: false, ownedPidsGone: false, harnessExitedCleanly: false,
    providerCalls: 0, diagnostics: [], expectedFixtureBlocks: [], expectedLocalMediaBlobCancels: [], staticExportPrefetchNoise: [],
    unclassifiedConsoleErrors: [], pageErrors: [], unhandledRejections: [], criticalRuntimeErrors: [],
    networkFailures: [], httpFailures: [], unexpectedBlockedRequests: [], cleanupFailures: [],
  };
}

function attachBrowserErrorCapture(page, report, fixtures) {
  let pendingStaticPrefetchConsoleErrors = 0;
  const onConsole = message => {
    if (message.type() !== 'error') return;
    const text = boundedText(message.text(), 1600);
    const location = boundedText(message.location().url ?? '', 500);
    if (/\b404\b/.test(text) && pendingStaticPrefetchConsoleErrors > 0) {
      pendingStaticPrefetchConsoleErrors -= 1;
      return;
    }
    if (/ERR_BLOCKED_BY_CLIENT/i.test(text) && fixtures.consumeExpectedBlockedConsoleError()) return;
    const error = { classification: 'UNCLASSIFIED_CONSOLE_ERROR', message: boundedText(`${text} ${location}`, 2000) };
    report.unclassifiedConsoleErrors.push(error);
    if (/Minified React error|React error #|Hydration failed|The above error occurred|Uncaught Error|Maximum update depth/i.test(text)) {
      report.criticalRuntimeErrors.push({ classification: 'CRITICAL_REACT_RUNTIME_ERROR', message: error.message });
    }
  };
  const onPageError = error => {
    const item = classifyBrowserError(error);
    const record = { classification: 'PAGE_ERROR', message: item.message };
    report.pageErrors.push(record);
    report.criticalRuntimeErrors.push(record);
  };
  const onRequestFailed = request => {
    if (fixtures.isExpectedBlocked(request) || fixtures.isUnexpectedBlocked(request)) return;
    const rawUrl = request.url();
    const record = classifyNetworkFailure({
      method: request.method(),
      url: rawUrl,
      resourceType: request.resourceType(),
      errorText: request.failure()?.errorText ?? 'Request failed',
      pageUrl: page.url(),
    });
    if (record.classification === 'EXPECTED_LOCAL_MEDIA_BLOB_CANCEL') {
      report.expectedLocalMediaBlobCancels.push(record);
      return;
    }
    if (record.classification === 'STATIC_EXPORT_PREFETCH_NOISE') {
      report.staticExportPrefetchNoise.push(record);
      return;
    }
    report.networkFailures.push(record);
    report.criticalRuntimeErrors.push(record);
  };
  const onResponse = response => {
    const status = response.status();
    if (status < 400) return;
    const failure = classifyHttpFailure({ method: response.request().method(), url: response.url(), status });
    if (failure.classification === 'STATIC_EXPORT_PREFETCH_NOISE') {
      pendingStaticPrefetchConsoleErrors += 1;
      report.staticExportPrefetchNoise.push(failure);
      return;
    }
    report.httpFailures.push(failure);
    report.criticalRuntimeErrors.push(failure);
  };
  return [['console', onConsole], ['pageerror', onPageError], ['requestfailed', onRequestFailed], ['response', onResponse]];
}

export function assertSyntheticIntentOnly(response) {
  assert.ok(response && typeof response === 'object' && !Array.isArray(response), 'Synthetic intent response must be an object');
  const forbidden = new Set(['constraint', 'constraints', 'constraintset', 'feasibility', 'proposal', 'safenochange', 'evaluator', 'repair']);
  const visit = (value, path = 'response') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
      assert.ok(!forbidden.has(normalizedKey), `Synthetic provider response contains downstream product field at ${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(response);
}

function edgeExecutable(env = process.env) {
  const candidates = [env.MEDCLIP_EDGE_EXECUTABLE, process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'), process.env.ProgramFiles && join(process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe')].filter(Boolean);
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error('System Microsoft Edge executable was not found; set MEDCLIP_EDGE_EXECUTABLE.');
  return resolve(found);
}

async function resolvePlaywright(env = process.env) {
  try { return await import('playwright'); }
  catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    const runtimeModule = join(env.USERPROFILE ?? env.HOME ?? '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
    const candidates = [env.MEDCLIP_PLAYWRIGHT_MODULE, existsSync(runtimeModule) ? runtimeModule : null].filter(Boolean);
    for (const candidate of candidates) {
      try {
        const modulePath = isAbsolute(candidate) ? pathToFileURL(candidate).href : candidate;
        return await import(modulePath);
      } catch (fallbackError) {
        if (fallbackError?.code !== 'ERR_MODULE_NOT_FOUND') throw fallbackError;
      }
    }
    throw error;
  }
}

async function waitForExit(child, timeoutMs = CLEANUP_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolveExit => {
    const timer = setTimeout(() => { cleanup(); resolveExit(false); }, timeoutMs);
    const onExit = () => { cleanup(); resolveExit(true); };
    const cleanup = () => { clearTimeout(timer); child.off('exit', onExit); };
    child.once('exit', onExit);
  });
}

async function boundedCleanup(action, report, label) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup deadline exceeded')), CLEANUP_TIMEOUT_MS); }),
    ]);
    return true;
  } catch {
    report.cleanupFailures.push(label);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function startControlledStaticServer(outDir = DEFAULT_OUT_DIR) {
  const root = resolve(outDir);
  assert.ok(existsSync(root), `Static export directory is missing: ${root}`);
  const worker = fork(fileURLToPath(import.meta.url), ['--static-server-worker', root], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const ready = await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('Controlled static server startup timed out')), CLEANUP_TIMEOUT_MS);
    worker.on('message', message => {
      if (message?.type === 'ready') { clearTimeout(timer); resolveReady(message); }
      if (message?.type === 'startup-error') { clearTimeout(timer); rejectReady(new Error(message.code ?? 'Static server startup failed')); }
    });
    worker.once('error', error => { clearTimeout(timer); rejectReady(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) rejectReady(new Error(`Static server worker exited during startup (${code})`)); });
  });
  const url = `http://127.0.0.1:${ready.port}`;
  const response = await fetch(`${url}/editor`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200, 'Controlled static server GET /editor must return 200');
  return { url, pid: ready.pid, worker, async close() {
    if (worker.exitCode === null && worker.signalCode === null) worker.send({ type: 'close' });
    let exited = await waitForExit(worker);
    if (!exited && worker.exitCode === null && worker.signalCode === null) {
      worker.kill();
      exited = await waitForExit(worker);
    }
    if (!exited) throw new Error('Controlled static server process did not exit within bounded cleanup');
    return exited;
  } };
}

function serveStatic(root) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      let requested = pathname;
      if (requested === '/') requested = '/index.html';
      else if (!extname(requested)) requested = `${requested.replace(/\/$/, '')}.html`;
      const file = resolve(root, `.${requested}`);
      const rel = relative(root, file);
      if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) { response.writeHead(403).end(); return; }
      const data = await readFile(file);
      response.writeHead(200, { 'content-type': MIME.get(extname(file).toLowerCase()) ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(data);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  });
  return server;
}

async function workerMain(root) {
  const server = serveStatic(root);
  server.listen(0, '127.0.0.1', () => process.send?.({ type: 'ready', port: server.address().port, pid: process.pid }));
  process.on('message', message => {
    if (message?.type !== 'close') return;
    server.close(() => process.exitCode = 0);
  });
}

export async function launchAcceptanceBrowser({
  outDir = DEFAULT_OUT_DIR,
  env = process.env,
  headless = true,
  navigateToEditor = true,
  fixtures: fixtureOptions = {},
  editorInputFixture = null,
} = {}) {
  const resolvedOutDir = resolve(outDir);
  const launchEditorFixture = editorInputFixture === null
    ? null
    : validateAcceptanceEditorFixtureV1(editorInputFixture);
  if (launchEditorFixture) await assertAcceptanceInputHydrationBuild(resolvedOutDir);
  const owned = {
    outDir: resolvedOutDir,
    server: null, browserServer: null, browser: null, context: null, page: null,
    browserProcess: null, pageListeners: [],
  };
  const report = createAcceptanceReport();
  let closed = false;
  let fixtures = null;
  try {
    owned.server = await startControlledStaticServer(resolvedOutDir);
    const { chromium } = await resolvePlaywright(env);
    owned.browserServer = await chromium.launchServer({ executablePath: edgeExecutable(env), headless, args: ['--no-first-run', '--no-default-browser-check'] });
    owned.browserProcess = owned.browserServer.process();
    assert.ok(owned.browserProcess?.pid, 'BrowserServer must expose its owned Edge process identity');
    owned.browser = await chromium.connect(owned.browserServer.wsEndpoint());
    owned.context = await owned.browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
    await owned.context.addInitScript(acceptanceInitScript);
    if (launchEditorFixture) {
      await owned.context.addInitScript(acceptanceEditorFixtureInitScript, {
        storageKey: PROJECT_STORAGE_KEY,
        project: launchEditorFixture.initialProject,
        inputEvidence: launchEditorFixture.inputEvidence,
      });
    }
    owned.page = await owned.context.newPage();
    fixtures = await installAcceptanceFixtures(owned.page, { ...fixtureOptions, env });
    owned.pageListeners = attachBrowserErrorCapture(owned.page, report, fixtures);
    for (const [event, listener] of owned.pageListeners) owned.page.on(event, listener);
    report.providerCalls = fixtures.providerCalls;
    if (navigateToEditor) {
      await owned.page.goto(`${owned.server.url}/editor`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      assert.equal(new URL(owned.page.url()).pathname, '/editor');
    }
  } catch (error) {
    await close();
    throw Object.assign(new Error(error.message), { cause: error, report });
  }
  async function close() {
    if (closed) return report;
    closed = true;
    fixtures?.dispose();
    if (owned.page) for (const [event, listener] of owned.pageListeners) owned.page.off(event, listener);
    if (owned.page) await boundedCleanup(() => owned.page.close({ runBeforeUnload: false }), report, 'PAGE_CLOSE_TIMEOUT');
    if (owned.context) await boundedCleanup(() => owned.context.close(), report, 'CONTEXT_CLOSE_TIMEOUT');
    if (owned.browser) await boundedCleanup(() => owned.browser.close(), report, 'BROWSER_CLOSE_TIMEOUT');
    if (owned.browserServer) await boundedCleanup(() => owned.browserServer.close(), report, 'BROWSER_SERVER_CLOSE_TIMEOUT');
    report.browserClosed = Boolean(!owned.browserProcess || await waitForExit(owned.browserProcess));
    if (!report.browserClosed && owned.browserProcess?.exitCode === null && owned.browserProcess?.signalCode === null) {
      owned.browserProcess.kill();
      report.browserClosed = await waitForExit(owned.browserProcess);
      if (!report.browserClosed) report.cleanupFailures.push('OWNED_BROWSER_PROCESS_EXIT_TIMEOUT');
    }
    if (owned.server) { try { await owned.server.close(); report.serverStopped = true; } catch { report.serverStopped = false; } }
    const browserPidGone = !owned.browserProcess || owned.browserProcess.exitCode !== null || owned.browserProcess.signalCode !== null;
    const serverPidGone = !owned.server || owned.server.worker.exitCode !== null || owned.server.worker.signalCode !== null;
    report.ownedPidsGone = Boolean(browserPidGone && serverPidGone);
    report.harnessExitedCleanly = Boolean(report.browserClosed && report.serverStopped && report.ownedPidsGone && report.cleanupFailures.length === 0);
    return report;
  }
  return { ...owned, fixtures, get report() { return report; }, async collect() {
    report.diagnostics = await readAcceptanceDiagnostics(owned.page);
    report.expectedFixtureBlocks = [...fixtures.expectedFixtureBlocks];
    report.unexpectedBlockedRequests = [...fixtures.unexpectedBlockedRequests];
    report.unhandledRejections = await readAcceptanceErrors(owned.page);
    for (const item of report.unhandledRejections) report.criticalRuntimeErrors.push({ classification: 'UNHANDLED_REJECTION', message: item.message });
    for (const item of fixtures.unexpectedBlockedRequests) {
      if (!report.criticalRuntimeErrors.some(error => error.classification === 'UNEXPECTED_BLOCKED_REQUEST' && error.method === item.method && error.pathPattern === item.pathPattern)) {
        report.criticalRuntimeErrors.push({ classification: 'UNEXPECTED_BLOCKED_REQUEST', ...item });
      }
    }
    return report;
  }, close };
}

export async function runTeardownSmoke({ outDir = DEFAULT_OUT_DIR, env = process.env, headless = true } = {}) {
  const harness = await launchAcceptanceBrowser({ outDir, env, headless, navigateToEditor: true });
  let report;
  let primaryError = null;
  try {
    report = await harness.collect();
    assert.equal(report.providerCalls, 0, 'Provider calls must remain zero in teardown smoke');
  } catch (error) { primaryError = error; }
  finally { report = await harness.close(); }
  if (primaryError) throw Object.assign(new Error(primaryError.message), { report, cause: primaryError });
  assert.equal(report.browserClosed, true, 'BROWSER CLOSED = YES required');
  assert.equal(report.serverStopped, true, 'SERVER STOPPED = YES required');
  assert.equal(report.ownedPidsGone, true, 'OWNED PIDS GONE = YES required');
  assert.equal(report.harnessExitedCleanly, true, 'HARNESS EXITED CLEANLY = YES required');
  return report;
}

export async function loadRepositoryEnvFile(env = process.env) {
  const envPath = resolve(REPO_ROOT, '.env.local');
  if (!existsSync(envPath)) return { loaded: false, variables: 0 };
  const contents = await readFile(envPath, 'utf8');
  let loaded = 0;
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || Object.hasOwn(env, match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[match[1]] = value;
    loaded += 1;
  }
  return { loaded: true, variables: loaded };
}

if (process.argv[2] === '--static-server-worker') {
  workerMain(resolve(process.argv[3])).catch(() => { process.send?.({ type: 'startup-error', code: 'STATIC_SERVER_STARTUP_FAILED' }); process.exitCode = 1; });
}
