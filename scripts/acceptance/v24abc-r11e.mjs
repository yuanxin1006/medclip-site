#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateAcceptanceEditorFixtureV1 } from './editor-input-fixtures.mjs';
import { launchAcceptanceBrowser, loadRepositoryEnvFile, openRequirementFlow, runTeardownSmoke } from './medclip-browser-harness.mjs';

export const R11E_GATES = Object.freeze([
  ['G2-A', 'campus evaluator sanity'],
  ['G2-B', 'zero-action evaluator wording'],
  ['G2-C', 'second execution-capable fixture'],
  ['G2-D', 'Human Review ACCEPT'],
  ['G2-E', 'Human Review REJECT'],
  ['G2-F', 'Human Review MODIFY'],
  ['G2-G', 'pre-execution validation'],
  ['G2-H', 'safe execution'],
  ['G2-I', 'Undo'],
  ['G2-J', 'Redo'],
  ['G2-K', 'evaluator'],
  ['G2-L', 'repair'],
  ['G2-M', 'repair round limit'],
  ['G2-N', 'repair Undo/Redo'],
  ['G2-O', 'stale invalidation where browser-safe'],
  ['G2-P', 'preview'],
  ['G2-Q', 'export'],
  ['G2-R', 'final teardown'],
]);

export async function runGateSequence(gates, handler) {
  const completed = [];
  for (const [id, label] of gates) {
    await handler({ id, label, completed: [...completed] });
    completed.push(id);
  }
  return completed;
}

function fixtureContractError(message, cause) {
  return Object.assign(new Error(`R11E FIXTURE CONTRACT: ${message}`, cause ? { cause } : undefined), {
    harnessFailure: true,
  });
}

function fixtureRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function immutableFixtureContext(value, gateId) {
  if (!fixtureRecord(value)) {
    throw fixtureContractError(`resolveFixturesForGate returned no valid fixture context for ${gateId}`);
  }
  let editorInputFixture = value.editorInputFixture;
  if (editorInputFixture !== undefined && editorInputFixture !== null) {
    try { editorInputFixture = validateAcceptanceEditorFixtureV1(editorInputFixture); }
    catch (error) { throw fixtureContractError(`invalid editorInputFixture for ${gateId}`, error); }
  }
  return Object.freeze({
    ...value,
    ...(editorInputFixture === undefined ? {} : { editorInputFixture }),
  });
}

export async function resolveR11EGateFixtures({
  scenarioModule,
  id,
  label,
  completed = [],
  baseFixtures = Object.freeze({}),
  session,
} = {}) {
  const resolver = scenarioModule?.resolveFixturesForGate;
  if (resolver === undefined || resolver === null) return baseFixtures;
  if (typeof resolver !== 'function') {
    throw fixtureContractError('resolveFixturesForGate must be a function when configured');
  }
  let resolved;
  try {
    resolved = await resolver({
      id,
      label,
      completed: Object.freeze([...completed]),
      baseFixtures,
      session,
    });
  } catch (error) {
    if (error?.harnessFailure === true) throw error;
    throw fixtureContractError(`resolver failed for ${id}`, error);
  }
  return immutableFixtureContext(resolved, id);
}

function safeWorktreeStatus() {
  const result = spawnSync('git', ['status', '--short'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? (result.stdout.trim() || 'CLEAN') : 'UNAVAILABLE';
}

function parseArgs(args) {
  const options = { resumeFrom: 'G2-A', scenario: null, teardownSmoke: false, g2aSetupSmoke: false };
  for (const arg of args) {
    if (arg === '--teardown-smoke') options.teardownSmoke = true;
    else if (arg === '--g2a-setup-smoke') options.g2aSetupSmoke = true;
    else if (arg.startsWith('--resume-from=')) options.resumeFrom = arg.slice('--resume-from='.length);
    else if (arg.startsWith('--scenario=')) options.scenario = arg.slice('--scenario='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printSmoke(report) {
  console.log(`BROWSER CLOSED = ${report.browserClosed ? 'YES' : 'NO'}`);
  console.log(`SERVER STOPPED = ${report.serverStopped ? 'YES' : 'NO'}`);
  console.log(`OWNED PIDS GONE = ${report.ownedPidsGone ? 'YES' : 'NO'}`);
  console.log(`HARNESS EXITED CLEANLY = ${report.harnessExitedCleanly ? 'YES' : 'NO'}`);
  console.log(`CLEANUP FAILURES = ${report.cleanupFailures.length}`);
  console.log(`REAL PROVIDER CALLS = ${report.providerCalls}`);
  console.log(`DIAGNOSTIC EVENTS = ${report.diagnostics.length}`);
  printBrowserErrorReport(report);
}

function printBrowserErrorReport(report) {
  console.log(`EXPECTED FIXTURE BLOCKS = ${report.expectedFixtureBlocks.length}`);
  for (const item of report.expectedFixtureBlocks) console.log(`EXPECTED FIXTURE BLOCK = ${item.method} ${item.pathPattern} [${item.fixture}]`);
  console.log(`EXPECTED LOCAL MEDIA BLOB CANCELS = ${report.expectedLocalMediaBlobCancels.length}`);
  for (const item of report.expectedLocalMediaBlobCancels) console.log(`EXPECTED LOCAL MEDIA BLOB CANCEL = ${item.method} ${item.resourceType} ${item.rawUrl}`);
  console.log(`STATIC EXPORT PREFETCH NOISE = ${report.staticExportPrefetchNoise.length}`);
  for (const item of report.staticExportPrefetchNoise) console.log(`STATIC EXPORT PREFETCH NOISE ITEM = ${item.method} ${item.pathPattern} ${item.status}`);
  console.log(`UNCLASSIFIED CONSOLE ERRORS = ${report.unclassifiedConsoleErrors.length}`);
  for (const item of report.unclassifiedConsoleErrors) console.log(`CONSOLE ERROR = ${item.message}`);
  console.log(`PAGE ERRORS = ${report.pageErrors.length}`);
  console.log(`UNHANDLED REJECTIONS = ${report.unhandledRejections.length}`);
  console.log(`CRITICAL RUNTIME ERRORS = ${report.criticalRuntimeErrors.length}`);
  console.log(`NETWORK FAILURES = ${report.networkFailures.length}`);
  for (const item of report.networkFailures) console.log(`NETWORK FAILURE = ${item.method} ${item.pathPattern}: ${item.message}`);
  console.log(`HTTP FAILURES = ${report.httpFailures.length}`);
  console.log(`UNEXPECTED BLOCKED REQUESTS = ${report.unexpectedBlockedRequests.length}`);
  const unclassified = report.unclassifiedConsoleErrors.length + report.pageErrors.length
    + report.unhandledRejections.length + report.networkFailures.length + report.httpFailures.length + report.unexpectedBlockedRequests.length;
  console.log(`UNCLASSIFIED BROWSER ERRORS = ${unclassified}`);
}

function assertProviderFreeClean(report) {
  const unclassified = report.unclassifiedConsoleErrors.length + report.pageErrors.length
    + report.unhandledRejections.length + report.networkFailures.length + report.httpFailures.length + report.unexpectedBlockedRequests.length;
  if (report.providerCalls !== 0 || unclassified !== 0 || report.criticalRuntimeErrors.length !== 0) {
    throw Object.assign(new Error('Provider-free smoke recorded an unexpected browser or network failure'), { diagnostics: report });
  }
}

function requireAcceptanceUserA(env) {
  const email = env.MEDCLIP_TEST_USER_A_EMAIL;
  const password = env.MEDCLIP_TEST_USER_A_PASSWORD;
  if (!email || !password) throw new Error('HARNESS FAILURE: .env.local must provide MEDCLIP_TEST_USER_A_EMAIL and MEDCLIP_TEST_USER_A_PASSWORD');
  return { email, password };
}

export async function authenticateAcceptanceBrowserToEditor({ harness, env = process.env } = {}) {
  const { email, password } = requireAcceptanceUserA(env);
  const page = harness.page;
  await page.goto(`${harness.server.url}/auth`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('form.auth-form input[type="email"]').fill(email);
  await page.locator('form.auth-form input[type="password"]').fill(password);
  const submit = page.getByRole('button', { name: /登录/ });
  assert.equal(await submit.count(), 1, 'Login submit button is missing or ambiguous');
  await Promise.all([
    page.waitForURL(url => url.pathname === '/', { timeout: 30_000 }),
    submit.click(),
  ]);
  const authenticated = await page.evaluate(() => Object.keys(localStorage).some(key => /^sb-.+-auth-token$/.test(key)
    && (() => { try { return Boolean(JSON.parse(localStorage.getItem(key) ?? 'null')?.access_token); } catch { return false; } })()));
  assert.equal(authenticated, true, 'Supabase browser session was not established');
  await page.goto(`${harness.server.url}/editor`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('details.requirement-advanced').waitFor({ state: 'attached', timeout: 30_000 });
  return Object.freeze({
    authenticated: true,
    sessionPresent: true,
    editorReady: true,
    advancedSettingsAttached: true,
  });
}

export async function runG2ASetupSmoke({ env = process.env } = {}) {
  requireAcceptanceUserA(env);
  const harness = await launchAcceptanceBrowser({ env, navigateToEditor: false });
  let primaryError = null;
  let report;
  try {
    const page = harness.page;
    await authenticateAcceptanceBrowserToEditor({ harness, env });
    const requirementInput = await openRequirementFlow(page);
    const campusText = '请将成片目标时长设为30秒，完整保留老师讲话和结尾Logo。';
    await requirementInput.fill(campusText);
    assert.equal(await requirementInput.inputValue(), campusText, 'Campus requirement text was not retained in the open requirement flow');
    await harness.fixtures.waitForExpectedBlock(item => item.fixture === 'auth-profile-read isolation', 10_000);
    report = await harness.collect();
    assertProviderFreeClean(report);
    console.log('G2-A SETUP SMOKE = PASS');
    console.log('EDITOR LOADED = YES');
    console.log('AUTHENTICATED = YES');
    console.log('ADVANCED SETTINGS OPEN = YES');
    console.log('REQUIREMENT CONTROL INTERACTABLE = YES');
    console.log('CAMPUS REQUIREMENT FLOW BEGUN = YES');
    console.log('CREATIVE INTENT SUBMITTED = NO');
    printBrowserErrorReport(report);
  } catch (error) {
    primaryError = error;
    report = await harness.collect().catch(() => harness.report);
    console.error('HARNESS FAILURE');
    console.error(`G2-A SETUP SMOKE = FAIL`);
    console.error(`STAGE SYMPTOM = ${String(error.userVisibleSymptom ?? error.message).slice(0, 500)}`);
    printBrowserErrorReport(report);
  } finally {
    const finalReport = await harness.close();
    if (!finalReport.harnessExitedCleanly) primaryError ??= new Error(`HARNESS FAILURE: teardown did not verify: ${JSON.stringify(finalReport.cleanupFailures)}`);
    console.log(`BROWSER CLOSED = ${finalReport.browserClosed ? 'YES' : 'NO'}`);
    console.log(`SERVER STOPPED = ${finalReport.serverStopped ? 'YES' : 'NO'}`);
    console.log(`OWNED PIDS GONE = ${finalReport.ownedPidsGone ? 'YES' : 'NO'}`);
  }
  if (primaryError) throw primaryError;
  return report;
}

export async function runR11E({
  resumeFrom = 'G2-A',
  scenarioModule,
  env = process.env,
  onGate = null,
  launchBrowser = launchAcceptanceBrowser,
} = {}) {
  const start = R11E_GATES.findIndex(([id]) => id === resumeFrom);
  if (start < 0) throw new Error(`Unknown R11E gate: ${resumeFrom}`);
  const gates = R11E_GATES.slice(start);
  const completed = [];
  const configuredFixtures = scenarioModule?.fixtures ?? {};
  if (!fixtureRecord(configuredFixtures)) throw fixtureContractError('scenario fixtures must be an object');
  const baseFixtures = Object.freeze({ ...configuredFixtures });
  const fixtureResolver = scenarioModule?.resolveFixturesForGate;
  if (fixtureResolver !== undefined && fixtureResolver !== null && typeof fixtureResolver !== 'function') {
    throw fixtureContractError('resolveFixturesForGate must be a function when configured');
  }
  const harness = await launchBrowser({ env, fixtures: baseFixtures });
  let primaryError = null;
  try {
    const session = await scenarioModule?.setup?.({ harness });
    try {
      const result = await runGateSequence(gates, async ({ id, label, completed: done }) => {
        try {
          const gateFixtures = await resolveR11EGateFixtures({
            scenarioModule, id, label, completed: done, baseFixtures, session,
          });
          if (id === 'G2-R') {
            await harness.collect();
            await scenarioModule?.beforeTeardown?.({ harness, session });
          }
          if (onGate) await onGate({ id, label, completed: done, harness, session, gateFixtures });
          else if (scenarioModule?.runGate) {
            await scenarioModule.runGate({ id, label, completed: done, harness, session, gateFixtures });
          } else {
            throw new Error('R11E scenario module does not export runGate({ id, label, completed, harness, session, gateFixtures })');
          }
          if (id === 'G2-R') {
            const report = await harness.close();
            if (!report.harnessExitedCleanly) throw Object.assign(new Error('Owned browser/server cleanup did not verify'), { diagnostics: report });
          }
        } catch (error) {
          const status = safeWorktreeStatus();
          const evidence = error?.diagnosticEvidence ?? error?.diagnostics ?? await harness.collect().catch(() => 'Diagnostics unavailable');
          console.error('R11E ACCEPTANCE STOPPED');
          console.error(`FAILURE CLASSIFICATION = ${error?.harnessFailure === true ? 'HARNESS FAILURE' : 'PRODUCT DEFECT'}`);
          console.error(`LAST COMPLETED GATE = ${done.at(-1) ?? 'NONE'}`);
          console.error(`FIRST FAILED/UNFINISHED GATE = ${id} (${label})`);
          console.error(`USER-VISIBLE SYMPTOM = ${String(error?.userVisibleSymptom ?? error?.message ?? 'Unspecified gate failure').slice(0, 500)}`);
          console.error(`DIAGNOSTIC EVIDENCE = ${JSON.stringify(evidence).slice(0, 3000)}`);
          console.error(`WORKTREE STATUS = ${status}`);
          error.acceptanceGate = id;
          throw error;
        }
      });
      completed.push(...result);
    } catch (error) { throw error; }
    if (harness.report.providerCalls !== 0) throw new Error('Provider-free acceptance observed a real provider call');
  } catch (error) { primaryError = error; }
  finally {
    if (!harness.report.harnessExitedCleanly) {
      const cleanup = await harness.close();
      if (primaryError && !cleanup.harnessExitedCleanly) primaryError.cleanupFailure = cleanup;
      else if (!cleanup.harnessExitedCleanly) primaryError = Object.assign(new Error('R11E teardown did not verify'), { diagnostics: cleanup });
    }
  }
  if (primaryError) throw primaryError;
  return { lastCompletedGate: completed.at(-1) ?? null, completed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadRepositoryEnvFile();
  if (options.teardownSmoke) {
    const report = await runTeardownSmoke();
    printSmoke(report);
    return;
  }
  if (options.g2aSetupSmoke) {
    await runG2ASetupSmoke();
    return;
  }
  if (!options.scenario) throw new Error('Full R11E is intentionally separate; provide --scenario=<acceptance-only module> in Session A.');
  const scenario = await import(pathToFileURL(options.scenario).href);
  const result = await runR11E({ resumeFrom: options.resumeFrom, scenarioModule: scenario });
  console.log(`LAST COMPLETED GATE = ${result.lastCompletedGate}`);
  console.log('R11E ACCEPTANCE = COMPLETE');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    if (!error.acceptanceGate) console.error(`R11E HARNESS ERROR = ${String(error?.message ?? 'Unknown failure').slice(0, 500)}`);
    process.exitCode = 1;
  });
}
