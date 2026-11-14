import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.env.MEDCLIP_PLAYWRIGHT_MODULE));
const origin = process.env.MEDCLIP_EDITOR_TEST_ORIGIN;
assert.ok(['http://localhost:3000', 'https://deploy-preview-2--medclip-studio-2026.netlify.app'].includes(origin));
const projectOrigin = 'https://gyfjsuhbhjbfastcfohn.supabase.co';
const files = Array.from({ length: 8 }, (_, index) => resolve(process.env.MEDCLIP_EDITOR_FIXTURES, `video-${index + 1}.mp4`));
const browser = await chromium.launch({ executablePath: process.env.MEDCLIP_BROWSER_PATH, headless: true });
const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(15000);
let stage = 'setup';
const checks = [];
const taskRequests = [];
let armed = false;
const authPath = '/auth/v1/token';
const taskPath = '/functions/v1/ai-tasks';
const credentialsPath = '/functions/v1/ai-credentials';
await context.route('**/*', route => {
  const request = route.request();
  const url = new URL(request.url());
  if (['blob:', 'data:'].includes(url.protocol)) return route.continue();
  if (url.origin === origin && ['GET', 'HEAD'].includes(request.method())) return route.continue();
  if (url.origin !== projectOrigin) return route.abort();
  if (['GET', 'OPTIONS'].includes(request.method())) return route.continue();
  if (request.method() !== 'POST') return route.abort();
  if (url.pathname === authPath) return route.continue();
  if (url.pathname === credentialsPath && request.postDataJSON()?.action === 'list') return route.continue();
  if (url.pathname !== taskPath) return route.abort();
  const body = request.postDataJSON();
  taskRequests.push(body);
  return armed && taskRequests.length === 1 && body.task === 'editor.requirements_parse' ? route.continue() : route.abort();
});

const media = page.locator('input[type=file][accept^="video/mp4"]').first();
const timeline = page.locator('.timeline-editor-shell');
const materials = page.locator('.editor-flow-nav').getByRole('button', { name: /添加素材/ });
const assistant = page.locator('.editor-flow-nav').getByRole('button', { name: /AI 辅助/ });
const finish = page.locator('.editor-flow-nav').getByRole('button', { name: /精剪与导出/ });
const run = page.getByRole('button', { name: '生成 AI 剪辑建议', exact: true });
const requirement = page.getByRole('textbox', { name: '剪辑需求' });
const closeEditor = () => timeline.getByRole('button', { name: '关闭编辑器' }).click();
const clips = project => project.tracks.filter(track => ['video', 'broll'].includes(track.type))
  .flatMap(track => track.clips).sort((a, b) => a.timelineStartMs - b.timelineStartMs);
const scopedKey = () => page.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('medclip-editor-draft-v2:user:')));
const state = key => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
async function waitForProject(key, predicate, argument) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await state(key);
    if (value && predicate(value, argument)) return value;
    await new Promise(ready => setTimeout(ready, 50));
  }
  assert.fail('Expected project state was not persisted');
}
async function signIn(account) {
  await page.goto(origin + '/auth');
  await page.locator('input[type=email]').fill(process.env[`MEDCLIP_TEST_USER_${account}_EMAIL`]);
  await page.locator('input[type=password]').fill(process.env[`MEDCLIP_TEST_USER_${account}_PASSWORD`]);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/');
  await page.goto(origin + '/editor');
}
async function openAssistant() {
  await assistant.click();
  const providerSettings = page.locator('details.flow-provider');
  if (await providerSettings.getAttribute('open') === null) await providerSettings.locator('summary').click();
  await page.getByRole('radio', { name: /DeepSeek/i }).click();
}
async function checkProjectAbsent() {
  assert.equal(await page.getByText('video-1.mp4', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '继续精剪', exact: true }).count(), 0);
}

try {
  stage = 'A-initialize';
  await signIn('A');
  await media.setInputFiles(files);
  await page.getByRole('checkbox', { name: '加入初始时间线 video-8.mp4' }).uncheck();
  await page.getByRole('checkbox', { name: /我确认拥有上传素材/ }).check();
  assert.equal(await page.locator('input[aria-label^="加入初始时间线"]:checked').count(), 7);
  assert.equal(await page.locator('.asset-link-state').filter({ hasText: '本地文件已关联' }).count(), 8);
  assert.equal(await page.locator('.asset-timeline-state').filter({ hasText: '未加入时间线' }).count(), 8);
  assert.equal(await scopedKey(), undefined);
  await finish.click();
  await timeline.waitFor();
  const key = await scopedKey();
  const initial = await state(key);
  assert.equal(initial.assets.length, 8);
  assert.deepEqual(clips(initial).map(clip => clip.name), files.slice(0, 7).map((_, index) => `video-${index + 1}.mp4`));
  await timeline.getByRole('button', { name: '添加到时间线 video-8.mp4' }).waitFor();
  checks.push('A-stage-04-initializes-seven-checked-out-of-eight');

  stage = 'B-edit';
  await timeline.getByRole('button', { name: '选择素材 video-2.mp4' }).click();
  await timeline.getByRole('button', { name: '← 前移' }).click();
  await waitForProject(key, value => value.tracks.find(track => track.type === 'video').clips[0].name === 'video-2.mp4');
  await timeline.getByRole('button', { name: '选择素材 video-3.mp4' }).click();
  await timeline.getByRole('button', { name: '渐快', exact: true }).click();
  await waitForProject(key, value => value.tracks.flatMap(track => track.clips).some(clip => clip.name === 'video-3.mp4' && clip.speedCurve.at(-1).rate === 1.8));
  await timeline.getByRole('button', { name: '选择素材 video-4.mp4' }).click();
  const fourth = clips(await state(key)).find(clip => clip.name === 'video-4.mp4');
  await timeline.locator('.editor-player-controls input[type=range]').fill(String(fourth.timelineStartMs + 1000));
  await timeline.getByRole('button', { name: /分割/ }).click();
  await waitForProject(key, value => value.tracks.flatMap(track => track.clips).filter(clip => clip.name === 'video-4.mp4').length === 2);
  await timeline.locator('.subtitle-import-toolbox input[type=file]').setInputFiles({
    name: 'fixture.srt', mimeType: 'application/x-subrip', buffer: Buffer.from('1\n00:00:00,250 --> 00:00:01,500\n保留这条字幕\n'),
  });
  await waitForProject(key, value => value.captions.some(caption => caption.text === '保留这条字幕'));
  await timeline.getByRole('combobox', { name: '画面比例', exact: true }).selectOption('16:9');
  const edited = await waitForProject(key, value => value.ratio === '16:9');
  checks.push('B-reorder-split-speed-subtitle-canvas');

  stage = 'C-switch';
  await closeEditor();
  await assistant.click();
  await finish.click();
  await page.getByRole('button', { name: '打开精剪', exact: true }).click();
  await closeEditor();
  await materials.click();
  await page.getByRole('button', { name: '继续精剪', exact: true }).click();
  await closeEditor();
  assert.deepEqual(await state(key), edited);
  checks.push('C-switch-preserves-project-and-asset-ids');

  stage = 'D-G-relink';
  await page.reload();
  const linked = page.locator('.asset-link-state').filter({ hasText: '本地文件已关联' });
  await page.getByRole('region', { name: '恢复素材关联' }).waitFor();
  assert.deepEqual((await state(key)).tracks, edited.tracks);
  await openAssistant();
  await requirement.fill('第二个视频 1.5 倍速。');
  await run.click();
  await page.getByRole('alert').filter({ hasText: /尚未全部关联/ }).waitFor();
  assert.equal(taskRequests.length, 0);
  await materials.click();
  const wrong = { name: 'video-1.mp4', mimeType: 'video/mp4', buffer: await readFile(files[2]) };
  assert.equal(wrong.buffer.length, (await readFile(files[0])).length);
  await page.getByLabel('重新关联 video-1.mp4', { exact: true }).setInputFiles(wrong);
  await page.getByRole('alert').filter({ hasText: /内容与工程记录不一致/ }).waitFor();
  assert.equal(await linked.count(), 0);
  await media.setInputFiles(files.slice(1));
  await page.waitForFunction(() => [...document.querySelectorAll('.asset-link-state')].filter(node => node.textContent === '本地文件已关联').length === 7);
  await openAssistant();
  await run.click();
  await page.getByRole('alert').filter({ hasText: /尚未全部关联/ }).waitFor();
  assert.equal(taskRequests.length, 0);
  await materials.click();
  await media.setInputFiles(files[0]);
  await page.waitForFunction(() => [...document.querySelectorAll('.asset-link-state')].filter(node => node.textContent === '本地文件已关联').length === 8);
  await media.setInputFiles(files[0]);
  await page.getByRole('status').filter({ hasText: /正在读取文件/ }).waitFor({ state: 'hidden' });
  assert.equal(await linked.count(), 8);
  const restored = await state(key);
  assert.deepEqual(restored, edited);
  checks.push('D-batch-relink-preserves-complete-project', 'G-missing-and-same-size-wrong-content-rejected');

  stage = 'H-unsupported-status';
  await openAssistant();
  await page.getByText('高级规划与诊断', { exact: true }).click();
  await page.getByText('当前服务未注册独立的创作意图与保护范围解析任务。', { exact: true }).waitFor();
  assert.equal(await page.getByText('暂不支持此 AI 任务。', { exact: true }).count(), 0);
  checks.push('H-unavailable-tools-explained-and-old-error-cleared');

  stage = 'E-F-live-ai';
  armed = true;
  const pending = page.waitForResponse(response => response.url() === projectOrigin + taskPath && response.request().method() === 'POST');
  await run.click();
  const response = await pending;
  assert.equal(response.status(), 200);
  const envelope = await response.json();
  assert.equal(envelope.metadata?.generationOccurred, true);
  const [action] = envelope.result.data.actions;
  const target = clips(restored)[1];
  assert.equal(target.name, 'video-1.mp4');
  assert.equal(action.targetId, target.id);
  assert.equal(action.playbackRate, 1.5);
  assert.equal(taskRequests.length, 1);
  const editorContext = JSON.parse(taskRequests[0].input.editorContext);
  assert.equal(editorContext.clips[1].id, target.id);
  assert.ok(!JSON.stringify(editorContext).includes('contentSha256'));
  const confirm = page.getByRole('button', { name: '确认并应用剪辑建议', exact: true });
  await confirm.waitFor();
  assert.deepEqual(await state(key), restored);
  await confirm.click();
  const applied = await waitForProject(key, (value, id) => value.tracks.flatMap(track => track.clips).find(clip => clip.id === id)?.speedCurve.every(point => point.rate === 1.5), target.id);
  assert.deepEqual(clips(applied).filter(clip => clip.id !== target.id), clips(restored).filter(clip => clip.id !== target.id));
  assert.deepEqual(applied.captions, restored.captions);
  await finish.click();
  await page.getByRole('button', { name: '打开精剪', exact: true }).click();
  await timeline.getByRole('button', { name: '↶ 撤销', exact: true }).click();
  await waitForProject(key, (value, id) => value.tracks.flatMap(track => track.clips).find(clip => clip.id === id)?.speedCurve[0].rate === 1, target.id);
  await timeline.getByRole('button', { name: '↷ 重做', exact: true }).click();
  await waitForProject(key, (value, id) => value.tracks.flatMap(track => track.clips).find(clip => clip.id === id)?.speedCurve[0].rate === 1.5, target.id);
  checks.push('E-F-live-requirements-target-review-undo-redo');

  stage = 'J-workspace-isolation';
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('sb-') && key.endsWith('-auth-token')) localStorage.removeItem(key); });
  await page.reload();
  await checkProjectAbsent();
  await signIn('B');
  await checkProjectAbsent();
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('sb-') && key.endsWith('-auth-token')) localStorage.removeItem(key); });
  await signIn('A');
  assert.equal((await state(key)).id, edited.id);
  await page.getByText('video-1.mp4', { exact: true }).first().waitFor();
  assert.equal(await page.locator('.asset-link-state').filter({ hasText: '本地文件已关联' }).count(), 0);
  checks.push('J-anonymous-and-account-B-cannot-load-A-draft');

  stage = 'D-legacy-recovery';
  const legacy = structuredClone(edited);
  delete legacy.visualTimelineInitialized;
  for (const asset of legacy.assets) delete asset.mediaIdentity;
  await page.evaluate(({ key, legacy }) => {
    localStorage.removeItem(key);
    localStorage.setItem('medclip-editor-draft-v1', JSON.stringify(legacy));
  }, { key, legacy });
  await page.reload();
  await page.getByRole('button', { name: '恢复此浏览器的旧工程' }).click();
  await media.setInputFiles(files[0]);
  await page.getByRole('alert').filter({ hasText: /内容无法匹配/ }).waitFor();
  await page.getByLabel('重新关联 video-1.mp4', { exact: true }).setInputFiles(files[0]);
  await page.getByRole('button', { name: '取消关联', exact: true }).click();
  assert.equal(await linked.count(), 0);
  await page.getByLabel('重新关联 video-1.mp4', { exact: true }).setInputFiles(files[0]);
  await page.getByRole('button', { name: '确认是原始文件', exact: true }).click();
  const upgraded = await waitForProject(key, value => value.assets.find(asset => asset.name === 'video-1.mp4')?.mediaIdentity);
  assert.deepEqual(upgraded.tracks, legacy.tracks);
  assert.deepEqual(upgraded.captions, legacy.captions);
  assert.equal(await linked.count(), 1);
  checks.push('D-legacy-requires-preview-and-explicit-confirmation');

  stage = 'C-restored-empty-timeline';
  const empty = { ...edited, tracks: edited.tracks.map(track => ({ ...track, clips: [] })) };
  delete empty.visualTimelineInitialized;
  await page.evaluate(({ key, empty }) => localStorage.setItem(key, JSON.stringify(empty)), { key, empty });
  await page.reload();
  await page.getByRole('region', { name: '恢复素材关联' }).waitFor();
  await finish.click();
  await page.getByRole('status').filter({ hasText: /重新关联勾选素材的原文件/ }).waitFor();
  assert.equal(await timeline.isVisible(), false);
  await page.getByRole('button', { name: '重新关联原文件', exact: true }).click();
  await media.setInputFiles(files);
  await page.waitForFunction(() => [...document.querySelectorAll('.asset-link-state')].filter(node => node.textContent === '本地文件已关联').length === 8);
  await page.getByRole('checkbox', { name: '加入初始时间线 video-8.mp4' }).uncheck();
  await finish.click();
  const establish = page.getByRole('button', { name: '建立时间线并打开精剪', exact: true });
  await establish.waitFor();
  assert.equal(await establish.isEnabled(), false);
  await page.getByRole('checkbox', { name: /我确认拥有上传素材/ }).check();
  await establish.click();
  await timeline.waitFor();
  const initialized = await waitForProject(key, value => value.visualTimelineInitialized === true);
  assert.equal(initialized.id, edited.id);
  assert.deepEqual(initialized.captions, edited.captions);
  assert.deepEqual(initialized.assets, edited.assets);
  assert.equal(initialized.ratio, edited.ratio);
  assert.deepEqual(clips(initialized).map(clip => clip.assetId), edited.assets.slice(0, 7).map(asset => asset.id));
  checks.push('C-stage-04-relinks-and-fills-an-empty-legacy-draft-with-inline-consent');

  stage = 'G-intentionally-empty-timeline';
  const cleared = { ...empty, visualTimelineInitialized: true };
  await page.evaluate(({ key, cleared }) => localStorage.setItem(key, JSON.stringify(cleared)), { key, cleared });
  await page.reload();
  await media.setInputFiles(files);
  await page.waitForFunction(() => [...document.querySelectorAll('.asset-link-state')].filter(node => node.textContent === '本地文件已关联').length === 8);
  await page.getByRole('checkbox', { name: /我确认拥有上传素材/ }).check();
  await finish.click();
  assert.equal(await timeline.isVisible(), false);
  await page.getByRole('button', { name: '打开精剪', exact: true }).click();
  await timeline.waitFor();
  assert.deepEqual(await state(key), cleared);
  checks.push('G-intentionally-empty-timeline-opens-without-repopulating');
  console.log(JSON.stringify({ origin, checks, realProviderCalls: taskRequests.length, aiStatus: response.status() }));
} catch (error) {
  console.error(JSON.stringify({ stage, checks, type: error.name, location: error.stack?.split('\n').find(line => line.includes('editor-media-recovery.mjs'))?.trim() }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
