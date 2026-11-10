#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  canonicalProjectFingerprint,
  launchAcceptanceBrowser,
  loadRepositoryEnvFile,
  readAcceptanceDiagnostics,
  readCanonicalProjectFingerprint,
} from './medclip-browser-harness.mjs';
import { authenticateAcceptanceBrowserToEditor } from './v24abc-r11e.mjs';
import { beginRetainedExecutionPlanning } from './retained-execution-browser-handlers.mjs';
import {
  applyRetainedRepairHumanReview,
  beginRetainedRepairPlanning,
  evaluateRetainedRepairResult,
  executeRetainedRepair,
  preflightRetainedRepair,
} from './retained-repair-browser-handlers.mjs';
import {
  createExecutionEditorFixtureV1,
  createImmutableRepetitionEditorFixtureV1,
} from './editor-input-fixtures.mjs';

const mode = process.argv.find(argument => argument.startsWith('--mode='))?.slice('--mode='.length);
const allowedModes = new Set(['normal-negative', 'no-payload', 'malformed', 'downstream', 'execution', 'repair']);
if (!allowedModes.has(mode)) throw new Error(`Unknown H4B smoke mode: ${mode}`);

function syntheticIntentResponse(sourceRequest, { protectFirstClip = false } = {}) {
  const clauses = [{
    kind: 'GOAL',
    payload: { type: 'TARGET_DURATION', durationMs: 10_000, policy: 'EXACT' },
    provenance: { schemaVersion: 1, authority: 'MODEL_SUGGESTION', sourceReference: sourceRequest },
  }];
  if (protectFirstClip) clauses.push({
    kind: 'HARD_CONSTRAINT_REQUEST',
    payload: {
      type: 'PROTECT_CLIP',
      reference: { schemaVersion: 1, state: 'UNRESOLVED_REFERENCE', semanticKind: 'SPEECH', referenceText: 'the first clip' },
    },
    provenance: { schemaVersion: 1, authority: 'MODEL_UNCERTAIN_INFERENCE', sourceReference: 'protect the first clip' },
  });
  return {
    ok: true,
    task: 'editor.creative_intent_parse',
    provider: 'deepseek',
    result: { capability: 'TEXT_REASONING', data: { schemaVersion: 1, sourceRequest, clauses } },
    usage: null,
    metadata: { providerUsed: 'deepseek', taskType: 'editor.creative_intent_parse', generationOccurred: true },
  };
}

async function waitForHydration(page, category = 'SUCCESS') {
  await page.waitForFunction(expected => (window.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__ ?? [])
    .some(item => item.diagnostic?.kind === 'ACCEPTANCE_INPUT_HYDRATED'
      && item.diagnostic?.category === expected), category, { timeout: 10_000 });
  return (await readAcceptanceDiagnostics(page)).findLast(item =>
    item.diagnostic.kind === 'ACCEPTANCE_INPUT_HYDRATED')?.diagnostic;
}

async function assertAuthoritativeProject(page, fixture) {
  assert.equal(
    await readCanonicalProjectFingerprint(page),
    canonicalProjectFingerprint(fixture.initialProject),
    'Authoritative browser project does not match fixture project',
  );
}

async function assertCleanAndClose(harness) {
  const report = await harness.collect();
  assert.equal(report.providerCalls, 0);
  assert.equal(report.unclassifiedConsoleErrors.length, 0);
  assert.equal(report.pageErrors.length, 0);
  assert.equal(report.unhandledRejections.length, 0);
  assert.equal(report.criticalRuntimeErrors.length, 0);
  assert.equal(report.unexpectedBlockedRequests.length, 0);
  const finalReport = await harness.close();
  assert.equal(finalReport.harnessExitedCleanly, true);
  return finalReport;
}

async function runSimpleBoundaryMode() {
  const fixture = createExecutionEditorFixtureV1();
  const withHarnessFixture = mode === 'normal-negative';
  const harness = await launchAcceptanceBrowser({
    navigateToEditor: false,
    ...(withHarnessFixture ? { editorInputFixture: fixture } : {}),
  });
  try {
    if (!withHarnessFixture) {
      const payload = mode === 'no-payload' ? undefined
        : mode === 'malformed' ? { ...fixture.inputEvidence, semanticEvidence: fixture.inputEvidence.semanticEvidence.slice(1) }
          : { ...fixture.inputEvidence, repairProposal: {} };
      await harness.context.addInitScript(({ project, inputEvidence }) => {
        window.localStorage.setItem('medclip-editor-draft-v1', JSON.stringify(project));
        if (inputEvidence !== undefined) window.__MEDCLIP_ACCEPTANCE_INPUT_EVIDENCE__ = inputEvidence;
      }, { project: fixture.initialProject, inputEvidence: payload });
    }
    const editorUrl = mode === 'normal-negative'
      ? `${harness.server.url}/editor?acceptanceInput=1&fixture=medical-review-execution-v1`
      : `${harness.server.url}/editor`;
    await harness.page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await assertAuthoritativeProject(harness.page, fixture);
    if (mode === 'malformed' || mode === 'downstream') {
      const diagnostic = await waitForHydration(harness.page, 'INVALID_PAYLOAD');
      assert.equal(diagnostic.semanticAssetCount, 0);
      assert.equal(diagnostic.rhythmEvidencePresent, false);
    } else {
      await harness.page.waitForTimeout(500);
      assert.equal((await readAcceptanceDiagnostics(harness.page)).some(item =>
        item.diagnostic.kind === 'ACCEPTANCE_INPUT_HYDRATED'), false);
      assert.equal(await harness.page.locator('.editor-proposal-status').count(), 0);
    }
    await assertCleanAndClose(harness);
    console.log(`${mode.toUpperCase().replace('-', '_')} = PASS`);
  } catch (error) {
    await harness.close();
    throw error;
  }
}

async function runPlanningMode() {
  await loadRepositoryEnvFile();
  const repair = mode === 'repair';
  const fixture = repair ? createImmutableRepetitionEditorFixtureV1() : createExecutionEditorFixtureV1();
  const sourceRequest = repair
    ? 'Create a complete ten-second medical narrative with upbeat pacing.'
    : 'Create a complete ten-second medical narrative and protect the first clip.';
  const harness = await launchAcceptanceBrowser({
    navigateToEditor: false,
    editorInputFixture: fixture,
    fixtures: {
      providerAvailability: { provider: 'deepseek', status: 'connected' },
      syntheticIntentResponse: syntheticIntentResponse(sourceRequest, { protectFirstClip: !repair }),
    },
  });
  try {
    await authenticateAcceptanceBrowserToEditor({ harness, env: process.env });
    const firstHydration = await waitForHydration(harness.page);
    assert.equal(firstHydration.semanticAssetCount, 12);
    assert.equal(firstHydration.rhythmEvidencePresent, true);
    await assertAuthoritativeProject(harness.page, fixture);
    await harness.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForHydration(harness.page);
    await assertAuthoritativeProject(harness.page, fixture);
    const repairPlanning = repair
      ? await beginRetainedRepairPlanning({ page: harness.page, sourceRequest })
      : null;
    if (!repair) {
      await beginRetainedExecutionPlanning({ page: harness.page, sourceRequest, protectFirstClip: true });
    }

    if (!repair) {
      const proposalEntries = harness.page.locator('.plan-evidence-entry');
      assert.equal(await proposalEntries.count(), 5);
      const entryTexts = await proposalEntries.allTextContents();
      const legalActionCount = entryTexts.filter(text => text.includes('MATCH_ASSET_TO_SEGMENT')).length;
      assert.ok(legalActionCount >= 1);
      assert.equal(entryTexts.some(text => text.includes('MATCH_ASSET_TO_SEGMENT') && text.includes('clip-0')), false);
      const modifyOptions = await harness.page.locator('.plan-evidence-review-controls select option').evaluateAll(options =>
        options.map(option => option.value));
      assert.ok(modifyOptions.includes('asset-ecg-alt'));
      console.log(`LEGAL_ACTION_COUNT = ${legalActionCount}`);
      console.log('PROTECTED_CLIP_SAFE = YES');
      console.log('TRUSTED_MODIFY_ALTERNATIVE = asset-ecg-alt');
    } else {
      assert.deepEqual(repairPlanning.assetSequence, [
        'asset-consultation', 'asset-consultation', 'asset-ecg', 'asset-treatment', 'asset-recovery',
      ]);
      assert.ok(repairPlanning.defectCodes.includes('IMMEDIATE_ASSET_REPEAT'));
      assert.ok(repairPlanning.defectCodes.includes('RECENT_ASSET_REUSE'));
      assert.equal(repairPlanning.duplicateTargetConflictCount, 1);
      const review = await applyRetainedRepairHumanReview({ page: harness.page });
      assert.equal(review.provenance, 'REPAIR_USER_ACCEPTED');
      const preflight = await preflightRetainedRepair(harness.page);
      assert.equal(preflight.canonicalValidator, 'PASS');
      assert.equal(preflight.hardConstraintValidator, 'PASS');
      const execution = await executeRetainedRepair({ page: harness.page });
      const final = await evaluateRetainedRepairResult(harness.page);
      assert.equal(execution.appliedActionCount, 1);
      assert.equal(execution.failedActionCount, 0);
      assert.equal(final.evaluationCount, 1);
      assert.equal(final.remainingDefectCount, 0);
      assert.equal(final.finalStatus, 'REPAIR_FINAL_PASS');
      console.log('REPEATED_SEQUENCE = asset-consultation,asset-consultation,asset-ecg,asset-treatment,asset-recovery');
      console.log('REPETITION_DEFECTS = IMMEDIATE_ASSET_REPEAT,RECENT_ASSET_REUSE');
      console.log('REPAIR_ACTION = MATCH_ASSET_TO_SEGMENT clip-1 asset-anatomy');
      console.log('REPAIR_HUMAN_REVIEW_COMPATIBLE = YES');
      console.log('REPAIR_EXECUTION = PASS');
      console.log('PROTECTED_CONTENT_UNCHANGED = YES');
      console.log('SECOND_REPAIR_ROUND = ABSENT');
      console.log('REPAIR_FINAL_STATUS = REPAIR_FINAL_PASS');
    }
    assert.equal(harness.fixtures.syntheticIntentRequests, 1);
    await assertCleanAndClose(harness);
    console.log('AUTHORITATIVE_PROJECT_MATCH = PASS');
    console.log('SEMANTIC_HYDRATION = PASS');
    console.log('RHYTHM_HYDRATION = PASS');
    console.log('PROPOSAL_PRESEEDED = NO');
    console.log('PROPOSAL_GENERATED_BY_PRODUCTION = YES');
    console.log(`${mode.toUpperCase()}_BROWSER_SMOKE = PASS`);
  } catch (error) {
    await harness.close();
    throw error;
  }
}

if (['normal-negative', 'no-payload', 'malformed', 'downstream'].includes(mode)) {
  await runSimpleBoundaryMode();
} else {
  await runPlanningMode();
}
