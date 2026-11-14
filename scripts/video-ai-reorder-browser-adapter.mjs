import { gateScope, SafeAcceptanceGateError } from './video-ai-reorder-diagnostics.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSafeEditorAIContext } from '../app/editor-ai-requirements.ts';
import { buildOwnedAssetAcceptanceFixtureThroughEditor } from './video-ai-owned-asset-fixture.ts';
import { createAITaskNetworkTracker, readEditorSpecificSurface } from './video-ai-live-acceptance-harness.ts';
import { verifyRemoteIdentity } from './video-ai-reorder-identity.mjs';
import { getInternalTextTaskFixtureDefinition, INTERNAL_TEXT_TASK_FIXTURE_HEADER } from '../supabase/functions/_shared/ai-tasks/text-fixtures.ts';
import { createInternalLiveValidationProof, INTERNAL_LIVE_VALIDATION_HEADER } from '../supabase/functions/_shared/ai-tasks/internal-live-validation.ts';
import { REORDER_TIMED_SUBTITLE_FIXTURE } from './video-ai-reorder-subtitle-fixture.ts';

export const AUTO_OPEN_EDITOR_SELECTOR = 'section[aria-label="生成后继续剪辑"]';
export function isAutoOpenedProjectEditorHydrated() {
  if (window.location.pathname !== '/editor') return false;
  const shell = document.querySelector('section[aria-label="生成后继续剪辑"]');
  if (!(shell instanceof HTMLElement)) return false;
  const serialized = window.localStorage.getItem('medclip-editor-draft-v1');
  if (!serialized) return false;
  try {
    const project = JSON.parse(serialized);
    if (project?.schemaVersion !== 2 || !Array.isArray(project.tracks)) return false;
    const clips = project.tracks
      .filter(track => ['video','broll'].includes(track?.type) && Array.isArray(track.clips))
      .flatMap(track => track.clips);
    return clips.length > 0 && shell.querySelectorAll('.timeline-clip').length === clips.length;
  } catch {
    return false;
  }
}
export async function waitForAutoOpenedProjectEditor(page, diagnosticSubstage = () => {}) {
  diagnosticSubstage('PROJECT_AUTO_OPEN_WAIT');
  await page.locator(AUTO_OPEN_EDITOR_SELECTOR).waitFor({ state:'visible', timeout:60_000 });
  assert.equal(new URL(page.url()).pathname, '/editor');
  diagnosticSubstage('PROJECT_STATE_HYDRATION');
  await page.waitForFunction(isAutoOpenedProjectEditorHydrated, undefined, { timeout:60_000 });
}

export const ASSET_REPLACEMENT_TIMEOUT_MS = 30_000;

export function assertMatchesPersistedFixtureProject(currentProject, fixtureProject) {
  const normalizePersistedProject = project => JSON.parse(JSON.stringify(project));
  const currentNormalized = normalizePersistedProject(currentProject);
  const expectedNormalized = normalizePersistedProject(fixtureProject);
  assert.deepEqual(currentNormalized, expectedNormalized);
}

function replacementClips(project) {
  assert.ok(Array.isArray(project?.tracks));
  return project.tracks
    .filter(track => ['video','broll'].includes(track?.type) && Array.isArray(track.clips))
    .flatMap(track => track.clips);
}

export function resolveChronologicalReplacementPlan(project, fixtureNames) {
  assert.equal(fixtureNames?.length, 3, 'Exactly three fixture assets are required');
  const persistedOrder = replacementClips(project);
  assert.equal(persistedOrder.length, 3, 'Exactly three intended clips are required');
  assert.ok(persistedOrder.every(clip => clip?.id && Number.isFinite(clip.timelineStartMs)), 'Invalid persisted clip');
  const chronological = [...persistedOrder].sort((left, right) => left.timelineStartMs - right.timelineStartMs);
  assert.ok(chronological.every((clip, index) => index === 0 || clip.timelineStartMs > chronological[index - 1].timelineStartMs), 'Ambiguous chronological order');
  assert.ok(Array.isArray(project?.assets));
  const assetIds = fixtureNames.map(name => {
    const matches = project.assets.filter(asset => asset?.name === name);
    assert.equal(matches.length, 1, 'Fixture asset resolution failed');
    assert.ok(matches[0].id, 'Fixture asset identity unavailable');
    return matches[0].id;
  });
  return {
    clipIds: chronological.map(clip => clip.id),
    timelineStartMs: chronological.map(clip => clip.timelineStartMs),
    assetIds,
  };
}

export function persistedReplacementCondition(expected) {
  try {
    const serialized = window.localStorage.getItem('medclip-editor-draft-v1');
    if (!serialized) return false;
    const project = JSON.parse(serialized);
    const clips = project.tracks
      .filter(track => ['video','broll'].includes(track?.type) && Array.isArray(track.clips))
      .flatMap(track => track.clips);
    if (expected.kind === 'rendered-count') {
      return clips.length === expected.clipCount
        && document.querySelectorAll('.timeline-clip').length === expected.clipCount;
    }
    const chronological = [...clips].sort((left, right) => left.timelineStartMs - right.timelineStartMs);
    if (expected.kind === 'binding') {
      const clip = chronological[expected.index];
      return clip?.id === expected.clipId && clip.assetId === expected.assetId;
    }
    if (expected.kind === 'bindings') {
      return chronological.length === expected.clipIds.length
        && chronological.every((clip, index) => clip.id === expected.clipIds[index]
          && clip.assetId === expected.assetIds[index]);
    }
    return false;
  } catch {
    return false;
  }
}

export function assetAInteractionCondition(expected) {
  try {
    const visibleShells = [...document.querySelectorAll(expected.shellSelector)].filter(shell => {
      const rect = shell.getBoundingClientRect();
      const style = window.getComputedStyle(shell);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (visibleShells.length !== 1) return false;
    const shell = visibleShells[0];
    if (expected.kind === 'active-shell') return true;
    if (expected.kind === 'selected-clip') {
      const clips = [...shell.querySelectorAll('.timeline-clip')];
      const clip = clips[expected.index];
      const selected = clips.filter(node => node.classList.contains('selected'));
      return Boolean(clip?.classList.contains('selected') && selected.length === 1 && selected[0] === clip);
    }
    if (expected.kind === 'properties-context') {
      const title = shell.querySelector('.editor-properties .editor-pane-title');
      if (!title) return false;
      const rect = title.getBoundingClientRect();
      const style = window.getComputedStyle(title);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden'
        && [...title.children].some(child => (
          child.tagName === 'SPAN' && child.textContent?.trim() === '素材片段'
        ));
    }
    const labels = [...shell.querySelectorAll('label')].filter(node => (
      [...node.children].some(child => child.tagName === 'SPAN' && child.textContent?.trim() === '替换素材')
    ));
    const selects = labels.flatMap(label => [...label.querySelectorAll('select')]);
    if (expected.kind === 'replace-control-count') return selects.length === expected.count;
    if (selects.length !== 1) return false;
    const select = selects[0];
    if (expected.kind === 'control-enabled') return !select.disabled;
    if (expected.kind === 'control-ready') {
      const rect = select.getBoundingClientRect();
      const style = window.getComputedStyle(select);
      return !select.disabled && rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden';
    }
    if (expected.kind === 'option-ready') {
      return [...select.options].some(option => option.value === expected.assetId);
    }
    if (expected.kind === 'control-value') return select.value === expected.assetId;
    return false;
  } catch {
    return false;
  }
}

export async function readPersistedEditorProject(page) {
  const serialized = await page.evaluate(() => window.localStorage.getItem('medclip-editor-draft-v1'));
  assert.ok(serialized, 'Persisted editor project unavailable');
  const project = JSON.parse(serialized);
  assert.ok(project && Array.isArray(project.tracks) && Array.isArray(project.assets), 'Persisted editor project invalid');
  return project;
}

function assertReplacementPlanStillMatches(project, fixtureNames, expectedPlan) {
  const actual = resolveChronologicalReplacementPlan(project, fixtureNames);
  assert.deepEqual(actual.clipIds, expectedPlan.clipIds, 'Chronological clip identity changed');
  assert.deepEqual(actual.timelineStartMs, expectedPlan.timelineStartMs, 'Chronological clip order changed');
  assert.deepEqual(actual.assetIds, expectedPlan.assetIds, 'Fixture asset identity changed');
  return actual;
}

function assertReplacementBindings(project, fixtureNames, expectedPlan) {
  const actual = assertReplacementPlanStillMatches(project, fixtureNames, expectedPlan);
  const clips = [...replacementClips(project)].sort((left, right) => left.timelineStartMs - right.timelineStartMs);
  assert.deepEqual(clips.map(clip => clip.assetId), actual.assetIds, 'Replacement binding verification failed');
}

export async function replaceChronologicalClipAssetsAndClose(page, fixtureFiles, diagnosticSubstage = () => {}) {
  const fixtureNames = fixtureFiles.map(file => file.name);
  diagnosticSubstage('CLIP_ORDER_RESOLUTION');
  const initialProject = await readPersistedEditorProject(page);
  const expectedPlan = resolveChronologicalReplacementPlan(initialProject, fixtureNames);
  await page.waitForFunction(persistedReplacementCondition, {
    kind:'rendered-count', clipCount:expectedPlan.clipIds.length,
  }, { timeout:ASSET_REPLACEMENT_TIMEOUT_MS });

  diagnosticSubstage('A_CLIP_LOCATE');
  await page.waitForFunction(assetAInteractionCondition, {
    kind:'active-shell', shellSelector:AUTO_OPEN_EDITOR_SELECTOR,
  }, { timeout:ASSET_REPLACEMENT_TIMEOUT_MS });
  let activeEditorShell = page.locator(`${AUTO_OPEN_EDITOR_SELECTOR}:visible`);
  assert.equal(await activeEditorShell.count(), 1, 'Active editor shell resolution failed');

  for (let index = 0; index < expectedPlan.clipIds.length; index++) {
    const label = ['A','B','C'][index];
    if (index === 1) diagnosticSubstage('B_CLIP_LOCATE');
    if (index === 2) diagnosticSubstage('C_CLIP_LOCATE');
    const currentProject = await readPersistedEditorProject(page);
    const currentPlan = assertReplacementPlanStillMatches(currentProject, fixtureNames, expectedPlan);
    if (index > 0) {
      await page.waitForFunction(assetAInteractionCondition, {
        kind:'active-shell', shellSelector:AUTO_OPEN_EDITOR_SELECTOR,
      }, { timeout:ASSET_REPLACEMENT_TIMEOUT_MS });
      activeEditorShell = page.locator(`${AUTO_OPEN_EDITOR_SELECTOR}:visible`);
      assert.equal(await activeEditorShell.count(), 1, 'Active editor shell resolution failed');
    }
    const currentPersistedOrder = replacementClips(currentProject);
    const domIndex = currentPersistedOrder.findIndex(clip => clip.id === expectedPlan.clipIds[index]);
    assert.ok(domIndex >= 0, 'Chronological clip DOM position unavailable');
    assert.equal(currentPersistedOrder.filter(clip => clip.id === expectedPlan.clipIds[index]).length, 1, 'Chronological clip DOM position ambiguous');
    const clipLocator = activeEditorShell.locator('.timeline-clip').nth(domIndex);
    const prefix = label;
    const substage = suffix => `${prefix}_${suffix}`;
      await clipLocator.waitFor({ state:'visible', timeout:ASSET_REPLACEMENT_TIMEOUT_MS });
      diagnosticSubstage(substage('CLIP_SELECT'));
      await clipLocator.click();
      await page.waitForFunction(assetAInteractionCondition, {
        kind:'selected-clip', index:domIndex, shellSelector:AUTO_OPEN_EDITOR_SELECTOR,
      }, { timeout:ASSET_REPLACEMENT_TIMEOUT_MS });

      diagnosticSubstage(substage('PROPERTIES_CONTEXT'));
      await page.waitForFunction(assetAInteractionCondition, {
        kind:'properties-context', shellSelector:AUTO_OPEN_EDITOR_SELECTOR,
      }, { timeout:ASSET_REPLACEMENT_TIMEOUT_MS });

      diagnosticSubstage(substage('REPLACE_CONTROL_LOCATOR'));
      await page.waitForFunction(assetAInteractionCondition, {
        kind:'replace-control-count', count:1, shellSelector:AUTO_OPEN_EDITOR_SELECTOR,
      }, { timeout:ASSET_REPLACEMENT_TIMEOUT_MS });
      const replaceSelect = activeEditorShell
        .locator('.editor-properties')
        .getByRole('combobox', { name:'\u66ff\u6362\u7d20\u6750', exact:true });
      assert.equal(await replaceSelect.count(), 1, 'Replacement control locator is not unique');

      diagnosticSubstage(substage('REPLACE_CONTROL_ATTACHED'));
      await replaceSelect.waitFor({ state:'attached', timeout:ASSET_REPLACEMENT_TIMEOUT_MS });

      diagnosticSubstage(substage('REPLACE_CONTROL_VISIBLE'));
      await replaceSelect.waitFor({ state:'visible', timeout:ASSET_REPLACEMENT_TIMEOUT_MS });

      const controlReadinessDeadline = Date.now() + ASSET_REPLACEMENT_TIMEOUT_MS;
      diagnosticSubstage(substage('REPLACE_CONTROL_ENABLED'));
      await page.waitForFunction(assetAInteractionCondition, {
        kind:'control-enabled', shellSelector:AUTO_OPEN_EDITOR_SELECTOR,
      }, { timeout:ASSET_REPLACEMENT_TIMEOUT_MS });

      diagnosticSubstage(substage('REPLACE_CONTROL_READY'));
      await page.waitForFunction(assetAInteractionCondition, {
        kind:'control-ready', shellSelector:AUTO_OPEN_EDITOR_SELECTOR,
      }, { timeout:Math.max(1, controlReadinessDeadline - Date.now()) });

      diagnosticSubstage(substage('OPTION_WAIT'));
      await page.waitForFunction(assetAInteractionCondition, {
        kind:'option-ready', assetId:currentPlan.assetIds[index], shellSelector:AUTO_OPEN_EDITOR_SELECTOR,
      }, { timeout:ASSET_REPLACEMENT_TIMEOUT_MS });

      diagnosticSubstage(substage('SELECT_OPTION'));
      await replaceSelect.selectOption(currentPlan.assetIds[index]);

      diagnosticSubstage(substage('CONTROL_CONFIRMATION'));
      await page.waitForFunction(assetAInteractionCondition, {
        kind:'control-value', assetId:currentPlan.assetIds[index], shellSelector:AUTO_OPEN_EDITOR_SELECTOR,
      }, { timeout:ASSET_REPLACEMENT_TIMEOUT_MS });
    diagnosticSubstage(index === 0 ? 'REPLACEMENT_PERSISTENCE' : `${label}_REPLACEMENT_PERSISTENCE`);
    await page.waitForFunction(persistedReplacementCondition, {
      kind:'binding', index, clipId:expectedPlan.clipIds[index], assetId:currentPlan.assetIds[index],
    }, { timeout:ASSET_REPLACEMENT_TIMEOUT_MS });
    const persistedProject = await readPersistedEditorProject(page);
    const persistedPlan = assertReplacementPlanStillMatches(persistedProject, fixtureNames, expectedPlan);
    const persistedClips = [...replacementClips(persistedProject)].sort((left, right) => left.timelineStartMs - right.timelineStartMs);
    assert.equal(persistedClips[index].assetId, persistedPlan.assetIds[index], 'Replacement did not persist');
  }

  diagnosticSubstage('REPLACEMENT_VERIFICATION');
  const verifiedProject = await readPersistedEditorProject(page);
  assertReplacementBindings(verifiedProject, fixtureNames, expectedPlan);
  await page.waitForFunction(persistedReplacementCondition, {
    kind:'bindings', clipIds:expectedPlan.clipIds, assetIds:expectedPlan.assetIds,
  }, { timeout:ASSET_REPLACEMENT_TIMEOUT_MS });

  diagnosticSubstage('EDITOR_CLOSE');
  await page.getByRole('button',{name:'关闭编辑器',exact:true}).click();
  const postCloseProject = await readPersistedEditorProject(page);
  assertReplacementBindings(postCloseProject, fixtureNames, expectedPlan);
  return { clipCount:expectedPlan.clipIds.length };
}

// Read committed React state, never write it or synthesize owned IDs from restored metadata.
export async function readEditorState(page) {
  return page.evaluate(() => {
    const node = document.querySelector('main.app-shell');
    const key = node && Object.keys(node).find(k => k.startsWith('__reactFiber$'));
    let fiber = key && node[key];
    let values, project;
    const saved = localStorage.getItem('medclip-editor-draft-v1');
    // Resolve either fiber branch by committed persisted project identity; component
    // names may be minified. Never accept restored metadata as proof of ownership.
    while (fiber && !project) {
      for (const branch of [fiber, fiber.alternate]) {
        const candidate = [];
        for (let hook = branch?.memoizedState; hook && 'next' in hook; hook = hook.next) candidate.push(hook.memoizedState);
        const found = candidate.find(v => v?.schemaVersion === 2 && Array.isArray(v.tracks) && JSON.stringify(v) === saved);
        if (found) { project = found; values = candidate; break; }
      }
      fiber = fiber.return;
    }
    if (!project) throw new Error('Committed editor state unavailable');
    const arrays = values.filter(Array.isArray);
    const assets = arrays.find(v => v.length === 3 && v.every(a => a.id && a.preview && a.name && a.kind === '视频'));
    const segments = arrays.find(v => v.length === 3 && v.every(s => s.assetId && Number.isFinite(s.start) && Number.isFinite(s.end)));
    const audios = arrays.find(v => v.length > 0 && v.every(a => a.id && a.url && Number.isFinite(a.duration)));
    if (!project || !assets || !segments) throw new Error('Real project, owned uploads, or render plan unavailable');
    if (!audios) throw new Error('Registered audio unavailable');
    return { project, audio:audios.map(a => ({ id:a.id, name:a.name, duration:a.duration, binding:a.url })), ownedIds: assets.map(a => a.id), segments: segments.map(s => ({ id:s.id, assetId:s.assetId, start:s.start, end:s.end, sourceStart:s.sourceStart, sourceEnd:s.sourceEnd, playbackRate:s.playbackRate, transform:s.transform, speedCurve:s.speedCurve })) };
  });
}
export async function createReorderAdapter(env, dependencies = {}) {
  return gateScope('ENV_CONFIGURATION', async stage => {
    for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'MEDCLIP_TEST_USER_A_EMAIL',
      'MEDCLIP_TEST_USER_A_PASSWORD', 'SUPABASE_ACCESS_TOKEN', 'MEDCLIP_INTERNAL_LIVE_VALIDATION_SECRET',
      'MEDCLIP_REORDER_VIDEO_A', 'MEDCLIP_REORDER_VIDEO_B', 'MEDCLIP_REORDER_VIDEO_C', 'MEDCLIP_REORDER_AUDIO']) assert.ok(env[name], `Missing ${name}`);
    stage('SUPABASE_URL_VALIDATION');
    const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
    assert.equal(url.protocol, 'https:');
    const base = new URL(env.MEDCLIP_BASE_URL ?? 'http://localhost:3000');
    assert.ok(['localhost', '127.0.0.1'].includes(base.hostname), 'Local editor required');
    stage('ENV_CONFIGURATION');
    const { createClient } = dependencies.supabase ?? await import('@supabase/supabase-js');
    const fetch = dependencies.fetch ?? globalThis.fetch;
    const readMedia = dependencies.readFile ?? readFile;
    const client = createClient(url.href, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession:false, autoRefreshToken:false, detectSessionInUrl:false } });
    let session, browser, page, tracker, initialAudio, expectedContext, armed = false, requestCount = 0, violation = false;
    const capture = async () => (await readEditorState(page)).project;
    return {
      async reachability() {
        return gateScope('AUTH_HEALTH', async () => {
          const r = await fetch(new URL('/auth/v1/health', url), { headers:{ apikey:env.NEXT_PUBLIC_SUPABASE_ANON_KEY }, signal:AbortSignal.timeout(15_000) });
          if (!r.ok) throw new SafeAcceptanceGateError('AUTH_HEALTH','HTTP_FAILURE');
        });
      },
      async authenticate() {
        return gateScope('AUTH_SIGN_IN', async stage => {
          const r = await client.auth.signInWithPassword({ email:env.MEDCLIP_TEST_USER_A_EMAIL, password:env.MEDCLIP_TEST_USER_A_PASSWORD });
          assert.equal(r.error, null, 'Safe test user auth');
          stage('AUTH_GET_USER');
          session = r.data.session; assert.ok(session?.access_token && session.user?.id);
          const checked = await client.auth.getUser(session.access_token); assert.equal(checked.error, null);
          assert.equal(checked.data.user?.id, session.user.id);
        });
      },
      identity: () => verifyRemoteIdentity(env),
      async smoke() {
        return gateScope('REMOTE_REORDER_SMOKE', async () => {
          const fixture = getInternalTextTaskFixtureDefinition('valid_reorder_c_before_a');
          const request = { task:'editor.requirements_parse', provider:'deepseek', input:fixture.input };
          const proof = await createInternalLiveValidationProof({ secret:env.MEDCLIP_INTERNAL_LIVE_VALIDATION_SECRET, userId:session.user.id, request });
          const r = await fetch(new URL('/functions/v1/ai-tasks', url), { method:'POST', signal:AbortSignal.timeout(30_000), headers:{
            apikey:env.NEXT_PUBLIC_SUPABASE_ANON_KEY, Authorization:`Bearer ${session.access_token}`, 'Content-Type':'application/json',
            [INTERNAL_TEXT_TASK_FIXTURE_HEADER]:'valid_reorder_c_before_a', [INTERNAL_LIVE_VALIDATION_HEADER]:proof,
          }, body:JSON.stringify(request) });
          assert.equal(r.status, 200); const body = await r.json();
          assert.equal(body.ok, true); assert.equal(body.metadata?.providerFreeFixture, true);
          assert.equal(body.metadata?.generationOccurred, false);
          const actions = body.result?.data?.actions;
          assert.equal(actions?.length, 1);
          for (const [key,value] of Object.entries({ type:'REORDER_CLIP', targetId:'clip-c', referenceId:'clip-a', placement:'BEFORE' })) assert.equal(actions[0][key], value);
          return { pass:true, providerCalls:0 };
        });
      },
      async openEditor() {
        return gateScope('BROWSER_LAUNCH', async stage => {
          const { chromium } = dependencies.playwright ?? await import(env.MEDCLIP_PLAYWRIGHT_MODULE ?? 'file:///C:/Users/26484/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
          browser = await chromium.launch({ headless:true });
          const context = await browser.newContext();
          await context.addInitScript(({ key, session }) => {
            localStorage.setItem(key, JSON.stringify(session));
            localStorage.removeItem('medclip-editor-draft-v1');
          }, { key:`sb-${url.hostname.split('.')[0]}-auth-token`, session });
          // One browser AI request maximum. Other providers and unrelated external hosts are blocked.
          await context.route('**/*', async route => {
            const request = route.request(), dest = new URL(request.url());
            if (!['http:', 'https:'].includes(dest.protocol)) return route.continue();
            if (![base.origin, url.origin].includes(dest.origin)) return route.abort();
            if (dest.pathname.endsWith('/functions/v1/ai-tasks') && request.method() === 'POST') {
              let data; try { data = request.postDataJSON(); } catch { violation = true; return route.abort(); }
              requestCount++;
              if (!armed || requestCount !== 1 || data.provider !== 'deepseek' || data.task !== 'editor.requirements_parse'
                || data.input?.editingRequirement !== '把第三个视频片段移动到第一个视频片段前面。'
                || data.input?.editorContext !== expectedContext) { violation = true; return route.abort(); }
            } else if (dest.pathname.endsWith('/functions/v1/ai-credentials') && request.method() === 'POST') {
              // Listing existing connections does not validate or call a provider.
              let data; try { data = request.postDataJSON(); } catch { return route.abort(); }
              if (data.action !== 'list') { violation = true; return route.abort(); }
            } else if (dest.pathname.startsWith('/functions/')) { violation = true; return route.abort(); }
            return route.continue();
          });
          page = await context.newPage();
          stage('EDITOR_LOAD');
          const r = await page.goto(new URL('/editor', base).href);
          assert.equal(r.ok(), true); await page.locator('main.app-shell').waitFor();
          assert.equal(new URL(page.url()).pathname, '/editor');
          tracker = createAITaskNetworkTracker(page, 90_000);
        });
      },
      async fixture() {
        return gateScope('OWNED_MEDIA_SETUP', async (stage, substage) => {
          substage('LOCAL_FILE_READ');
          const video = async (label) => ({ name:`medclip-reorder-${label}.mp4`, mimeType:'video/mp4', buffer:await readMedia(env[`MEDCLIP_REORDER_VIDEO_${label}`]) });
          const [a,b,c] = await Promise.all(['A','B','C'].map(video));
          const fixture = await buildOwnedAssetAcceptanceFixtureThroughEditor(page, { video:a, additionalVideos:[b,c],
            audio:{ name:'medclip-reorder.wav', mimeType:'audio/wav', buffer:await readMedia(env.MEDCLIP_REORDER_AUDIO) },
            diagnosticStage:stage, diagnosticSubstage:substage,
            subtitleText:REORDER_TIMED_SUBTITLE_FIXTURE,
            prepareGeneratedProject:async () => {
              stage('PROJECT_OPEN');
              await waitForAutoOpenedProjectEditor(page, substage);
              const project = async () => JSON.parse(await page.evaluate(() => localStorage.getItem('medclip-editor-draft-v1')));
              const clips = p => p.tracks.filter(t => ['video','broll'].includes(t.type)).flatMap(t => t.clips);
              stage('THREE_CLIP_SETUP');
              let p = await project();
              assert.ok(clips(p).length > 0 && clips(p).length <= 3, 'Disposable generation must yield one to three clips');
              while (clips(p).length < 3) {
                const list = clips(p);
                const longest = list.reduce((a,b) => b.timelineEndMs-b.timelineStartMs > a.timelineEndMs-a.timelineStartMs ? b : a);
                assert.ok(longest.timelineEndMs-longest.timelineStartMs >= 400);
                await page.locator('.timeline-clip').nth(list.indexOf(longest)).dispatchEvent('click');
                await page.getByLabel('编辑器播放进度').evaluate((input, value) => {
                  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(value));
                  input.dispatchEvent(new Event('input',{bubbles:true}));
                  input.dispatchEvent(new Event('change',{bubbles:true}));
                }, Math.round((longest.timelineStartMs+longest.timelineEndMs)/20)*10);
                await page.getByRole('button',{name:'✂ 分割',exact:true}).click();
                await page.waitForFunction(count => JSON.parse(localStorage.getItem('medclip-editor-draft-v1')).tracks.flatMap(t=>t.clips).length === count, list.length+1);
                p = await project();
              }
              stage('ASSET_REPLACEMENT');
              await replaceChronologicalClipAssetsAndClose(page, [a,b,c], substage);
            } });
          stage('PROJECT_STATE_VALIDATION');
          await page.locator('.continue-edit-button').waitFor({ state:'visible', timeout:60_000 });
          const state = await readEditorState(page);
          initialAudio = state.audio;
          stage('OWNERSHIP_VALIDATION');
          assert.deepEqual(new Set(state.ownedIds), new Set(fixture.registeredAssets.map(a => a.id)));
          assert.equal(requestCount, 0); assert.equal(violation, false);
          return fixture;
        });
      },
      async prepareRequirement(requirement) {
        await page.getByRole('radio', { name:/DeepSeek/i }).click();
        await page.locator('.requirement-advanced summary').click();
        await page.locator('.requirement-trigger').click();
        await page.locator('#requirement-text').fill(requirement);
      },
      async readSafeContext(fixture) {
        const state = await readEditorState(page);
        assertMatchesPersistedFixtureProject(state.project, fixture.project);
        expectedContext = createSafeEditorAIContext(state.project, new Set(state.ownedIds), state.project.audioSelection.sourceDurationMs);
        return { ...fixture.preLiveContext, serializedContext:expectedContext };
      },
      harness:{
        timeoutMs:90_000,
        getRequestCount:() => tracker.getRequestCount(),
        waitForResponse:() => tracker.waitForResponse(),
        submitOnce:async () => {
          assert.equal(requestCount, 0);
          armed = true;
          await page.locator('.ai-apply-button').click();
          const confirm = page.getByRole('button', { name: '确认并应用剪辑建议', exact: true });
          await confirm.or(page.locator('.editor-ai-dialog-error[role="alert"]')).waitFor({ timeout: 90_000 });
          if (await confirm.isVisible()) await confirm.click();
        },
        readEditorSurface:() => readEditorSpecificSurface(page),
        captureEditorState:capture,
      },
      captureProject:capture,
      async assertPreviewAndExport(ids) {
        assert.equal(violation, false);
        const state = await readEditorState(page);
        // EditorStudio uses matchSegments for both preview lookup and the render plan.
        assert.deepEqual(state.audio, initialAudio, 'Background audio unchanged');
        assert.deepEqual(state.segments.map(s => s.id), ids, 'Actual preview/export segment order');
        const clips = state.project.tracks.filter(t => ['video','broll'].includes(t.type)).flatMap(t => t.clips).sort((a,b) => a.timelineStartMs-b.timelineStartMs);
        for (const [i,s] of state.segments.entries()) {
          assert.equal(s.assetId, clips[i].assetId); assert.equal(s.start*1000, clips[i].timelineStartMs); assert.equal(s.end*1000, clips[i].timelineEndMs);
          assert.equal(Math.round(s.sourceStart*1000), clips[i].sourceInMs);
          assert.equal(Math.round(s.sourceEnd*1000), clips[i].sourceOutMs);
          assert.deepEqual(s.transform, clips[i].transform);
          assert.deepEqual(s.speedCurve, clips[i].speedCurve);
        }
      },
      async undo() {
        await page.getByRole('button', { name:'关闭需求对话框' }).click();
        await page.locator('.continue-edit-button').click();
        await page.getByRole('button', { name:'↶ 撤销', exact:true }).click();
        await page.waitForTimeout(100);
      },
      async redo() { await page.getByRole('button', { name:'↷ 重做', exact:true }).click(); await page.waitForTimeout(100); },
      async close() { if (browser) await browser.close(); client.auth.stopAutoRefresh(); },
    };
  });
}
