import { gateScope, SafeAcceptanceGateError, safeError, formatAcceptanceFailure } from './video-ai-reorder-diagnostics.mjs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { inspectPreLiveSafeEditorContext, runExactlyOnceVideoAILiveAcceptance } from './video-ai-live-acceptance-harness.ts';
import { EXPECTED_AI_TASKS_VERSION } from './video-ai-reorder-identity.mjs';

export const REORDER_REQUIREMENT = '把第三个视频片段移动到第一个视频片段前面。';
export function parseMode(args, env) {
  if (args.length !== 1 || !['--mode=preflight','--mode=live'].includes(args[0]) || (args[0] === '--mode=live' && env.MEDCLIP_ALLOW_REORDER_LIVE !== 'YES')) throw new SafeAcceptanceGateError('MODE_VALIDATION');
  const mode = args[0].slice(7);
  return mode;
}
export function once(action) {
  let used = false;
  return async (...args) => {
    assert.equal(used, false, 'Second submit forbidden');
    used = true;
    return action(...args);
  };
}
export function orderedClips(project) {
  return project.tracks.filter(t => t.type === 'video' || t.type === 'broll')
    .flatMap(t => t.clips).sort((a,b) => a.timelineStartMs - b.timelineStartMs);
}
export function normalizePersistedValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
export function expectedReorderedProjectDuration(project, priorDurationMs) {
  const latestClipEnd = project.tracks.flatMap(track => track.clips ?? [])
    .reduce((latest, clip) => Math.max(latest, clip.timelineEndMs), 0);
  const latestCaptionEnd = (project.captions ?? [])
    .reduce((latest, caption) => Math.max(latest, caption.endMs), 0);
  return Math.max(1000, priorDurationMs, latestClipEnd, latestCaptionEnd);
}
export function assertCanonical(response, ids, setSubstage = () => {}) {
  setSubstage('LIVE_RESPONSE_STATUS');
  assert.equal(response?.httpStatus, 200);
  setSubstage('LIVE_RESPONSE_COMPLETED');
  assert.equal(response?.responseCompleted, true);
  setSubstage('LIVE_RESPONSE_OK');
  assert.equal(response?.ok, true);
  setSubstage('LIVE_ACTION_COUNT');
  assert.equal(response?.canonical?.actions?.length, 1);
  const action = response.canonical.actions[0];
  setSubstage('LIVE_ACTION_TYPE');
  assert.equal(action.type, 'REORDER_CLIP');
  setSubstage('LIVE_ACTION_TARGET');
  assert.equal(action.targetId, ids[2]);
  setSubstage('LIVE_ACTION_REFERENCE');
  assert.equal(action.referenceId, ids[0]);
  setSubstage('LIVE_ACTION_PLACEMENT');
  assert.equal(action.placement, 'BEFORE');
}
export function assertPreserved(before, after, expectedOrder, setSubstage = () => {}) {
  const old = orderedClips(before), clips = orderedClips(after);
  setSubstage('LIVE_PRESERVE_IDENTITY');
  assert.equal(old.length, 3); assert.equal(clips.length, 3);
  assert.equal(new Set(clips.map(c => c.id)).size, 3);
  assert.deepEqual(clips.map(c => c.id), expectedOrder);
  assert.deepEqual([...clips.map(c => c.id)].sort(), [...old.map(c => c.id)].sort());

  const previousById = new Map(old.map(clip => [clip.id, clip]));
  setSubstage('LIVE_PRESERVE_BINDINGS');
  for (const clip of clips) {
    const previous = previousById.get(clip.id);
    assert.ok(previous, 'Clip identity preserved');
    assert.equal(clip.assetId, previous.assetId, 'Asset binding preserved');
    assert.equal(clip.trackId, previous.trackId, 'Track binding preserved');
  }
  setSubstage('LIVE_PRESERVE_SOURCE_RANGE');
  for (const clip of clips) {
    const previous = previousById.get(clip.id);
    assert.equal(clip.sourceInMs, previous.sourceInMs, 'Source start preserved');
    assert.equal(clip.sourceOutMs, previous.sourceOutMs, 'Source end preserved');
  }
  setSubstage('LIVE_PRESERVE_SPEED');
  for (const clip of clips) {
    const previous = previousById.get(clip.id);
    assert.deepEqual(normalizePersistedValue(clip.speedCurve), normalizePersistedValue(previous.speedCurve), 'Playback speed preserved');
    assert.equal(clip.playbackRate, previous.playbackRate, 'Playback rate preserved');
  }
  setSubstage('LIVE_PRESERVE_TRANSFORM');
  for (const clip of clips) {
    const previous = previousById.get(clip.id);
    assert.deepEqual(normalizePersistedValue(clip.transform), normalizePersistedValue(previous.transform), 'Transform preserved');
  }
  setSubstage('LIVE_PRESERVE_DURATION');
  for (const clip of clips) {
    const previous = previousById.get(clip.id);
    const duration = previous.timelineEndMs - previous.timelineStartMs;
    assert.ok(duration > 0);
    assert.equal(clip.timelineEndMs - clip.timelineStartMs, duration, 'Displayed duration preserved');
  }
  setSubstage('LIVE_PRESERVE_TIMELINE_PACKING');
  const cursorOrigin = Math.min(...old.map(clip => clip.timelineStartMs));
  let cursor = cursorOrigin;
  for (const clip of clips) {
    assert.equal(clip.timelineStartMs, cursor, 'Packed timeline');
    cursor = clip.timelineEndMs;
  }
  setSubstage('LIVE_PRESERVE_PROJECT_DURATION');
  assert.equal(after.durationMs, expectedReorderedProjectDuration(after, before.durationMs), 'Deterministic project duration');
  setSubstage('LIVE_PRESERVE_CAPTIONS');
  assert.deepEqual(normalizePersistedValue(after.captions), normalizePersistedValue(before.captions), 'Subtitle text and timing preserved');
  setSubstage('LIVE_PRESERVE_AUDIO_SELECTION');
  assert.deepEqual(normalizePersistedValue(after.audioSelection), normalizePersistedValue(before.audioSelection));
  setSubstage('LIVE_PRESERVE_AUDIO_TRACKS');
  assert.deepEqual(normalizePersistedValue(after.tracks.filter(t => t.type === 'audio')), normalizePersistedValue(before.tracks.filter(t => t.type === 'audio')));
  setSubstage('LIVE_PRESERVE_ASSETS');
  assert.deepEqual(normalizePersistedValue(after.assets), normalizePersistedValue(before.assets));
}
// All effects live in the adapter. Tests inject local mocks; importing this module performs no I/O.
export async function runReorderAcceptance(args, env, adapter) {
  const mode = parseMode(args, env);
  let primary;
  try {
    return await gateScope('AUTH_HEALTH', async (stage, substage) => {
      await adapter.reachability();
      stage('AUTH_SIGN_IN');
      await adapter.authenticate();
      stage('REMOTE_SOURCE_IDENTITY');
      const identity = await adapter.identity();
      stage('REMOTE_VERSION');
      assert.equal(identity.version, EXPECTED_AI_TASKS_VERSION,
        `Remote ai-tasks must be exact v${EXPECTED_AI_TASKS_VERSION}`);
      stage('REMOTE_SOURCE_IDENTITY');
      assert.equal(identity.hashMismatches, 0, 'Remote/local source identity mismatch');
      assert.ok(identity.fileCount > 0, 'Source identity evidence required');
      stage('REMOTE_REORDER_SMOKE');
      const smoke = await adapter.smoke();
      assert.equal(smoke.pass, true, 'Provider-free remote smoke failed');
      assert.equal(smoke.providerCalls, 0);
      stage('BROWSER_LAUNCH');
      await adapter.openEditor();
      stage('OWNED_MEDIA_SETUP');
      const fixture = await adapter.fixture();
      stage('SAFE_CONTEXT_ORDER');
      const ids = orderedClips(fixture.project).map(c => c.id);
      assert.equal(ids.length, 3);
      assert.deepEqual(ids, fixture.preLiveContext.expectedClipIds);
      const evidence = inspectPreLiveSafeEditorContext(fixture.preLiveContext);
      stage('TARGET_REFERENCE_GATE');
      assert.ok(evidence.expectedTargetPresent && evidence.expectedReferencePresent && evidence.targetReferenceDistinct);
      stage('SAFE_CONTEXT_ORDER');
      assert.equal(evidence.eligible, true);
      if (mode === 'preflight') return { result:'PREFLIGHT_PASS', providerCalls:0, remoteVersion:EXPECTED_AI_TASKS_VERSION, sourceIdentity:'PASS', remoteSmoke:'PASS', ownedFixture:'PASS', safeContextOrder:'A,B,C', target:'C', reference:'A' };
      stage('LIVE_ACCEPTANCE');
      substage('LIVE_REQUIREMENT_PREPARE');
      await adapter.prepareRequirement(REORDER_REQUIREMENT);
      const result = await runExactlyOnceVideoAILiveAcceptance({
        ...adapter.harness,
        setSubstage: substage,
        readPreLiveSafeContext: () => adapter.readSafeContext(fixture),
        submitOnce: once(adapter.harness.submitOnce),
    });
    substage(result.result === 'PRELIVE_BLOCKED' ? 'LIVE_CONTEXT_VALIDATE'
      : result.timeoutStage === 'ai_tasks_response' ? 'LIVE_RESPONSE_WAIT' : 'LIVE_UI_OUTCOME');
    assert.equal(result.result, 'SUCCESS');
    assertCanonical(result.response, ids, substage);
    const finalOrder = [ids[2], ids[0], ids[1]];
    substage('LIVE_FINAL_ORDER');
    assert.deepEqual(orderedClips(result.editorState).map(c => c.id), finalOrder);
    substage('LIVE_FINAL_PRESERVATION');
    assertPreserved(fixture.project, result.editorState, finalOrder, substage);
    substage('LIVE_PREVIEW_EXPORT');
    await adapter.assertPreviewAndExport(finalOrder);
    substage('LIVE_UNDO');
    await adapter.undo();
    substage('LIVE_UNDO_STATE');
    assertPreserved(fixture.project, await adapter.captureProject(), ids, substage);
    substage('LIVE_REDO');
    await adapter.redo();
    substage('LIVE_REDO_STATE');
    assertPreserved(fixture.project, await adapter.captureProject(), finalOrder, substage);
    substage('LIVE_PREVIEW_EXPORT');
    await adapter.assertPreviewAndExport(finalOrder);
    substage('LIVE_FINAL_REQUEST_COUNT');
    assert.equal(adapter.harness.getRequestCount(), 1);
    return { result: 'LIVE_PASS', requestCount: 1 };
    });
  } catch(error) { primary=safeError(error); throw primary; }
  finally {
    try { await adapter.close(); }
    catch { if(primary) Object.defineProperty(primary,'cleanupFailed',{value:true, configurable:true}); else throw new SafeAcceptanceGateError('CLEANUP'); }
  }
}
// Factory injection keeps CLI tests entirely local; normal execution uses the real adapter.
export async function runAcceptanceCLI(args, env, factory, output = console) {
  try {
    parseMode(args, env); // Before imports, auth, browser, or network.
    const adapter = await gateScope('ENV_CONFIGURATION', async () => {
      const create = factory ?? (await import('./video-ai-reorder-browser-adapter.mjs')).createReorderAdapter;
      return create(env);
    });
    const result = await runReorderAcceptance(args, env, adapter);
    output.log(JSON.stringify(result));
    return 0;
  } catch(error) {
    output.error(formatAcceptanceFailure(error, !args.includes('--mode=live')));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runAcceptanceCLI(process.argv.slice(2), process.env);
}
