import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acceptanceEditorFixtureInitScript, startControlledStaticServer } from './medclip-browser-harness.mjs';

function runtimePaths(env = process.env) {
  const playwright = env.MEDCLIP_PLAYWRIGHT_MODULE
    ?? join(env.USERPROFILE ?? env.HOME ?? '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const edge = env.MEDCLIP_EDGE_EXECUTABLE
    ?? join(env['PROGRAMFILES(X86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe');
  assert.ok(existsSync(playwright), 'Playwright runtime is unavailable.');
  assert.ok(existsSync(edge), 'Microsoft Edge is unavailable.');
  return { playwright, edge };
}

function createReferenceVideo(path) {
  const result = spawnSync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1:r=12',
    '-f', 'lavfi', '-i', 'color=c=white:s=320x180:d=1:r=12',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1:r=12',
    '-f', 'lavfi', '-i', 'color=c=white:s=320x180:d=1:r=12',
    '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]',
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `ffmpeg fixture creation failed: ${result.stderr}`);
}

const suffix = `${process.pid}-${Date.now()}`;
const referencePath = join(tmpdir(), `medclip-v27b-reference-${suffix}.mp4`);
let server;
let browser;
let providerCalls = 0;

const project = {
  schemaVersion: 2,
  id: 'v27b-browser-project',
  title: 'Reference style target fixture',
  updatedAt: '2026-10-31T00:00:00.000Z',
  durationMs: 8000,
  ratio: '16:9',
  audioSelection: { mode: 'full', sourceDurationMs: 8000, sourceInMs: 0, sourceOutMs: 8000, selectedDurationMs: 8000 },
  assets: [
    { id: 'user-teacher', name: '用户老师镜头.mp4', kind: '视频', durationMs: 8000 },
    { id: 'user-campus', name: '用户校园镜头.mp4', kind: '视频', durationMs: 8000 },
    { id: 'user-city', name: '用户城市镜头.mp4', kind: '视频', durationMs: 8000 },
    { id: 'user-event-alt', name: 'campus activity alternative.mp4', kind: '瑙嗛', durationMs: 8000 },
  ],
  tracks: [
    { id: 'protected-teacher', type: 'video', name: '受保护老师讲话', locked: true, clips: [{
      id: 'clip-teacher', assetId: 'user-teacher', name: '老师讲话', kind: '视频', trackId: 'protected-teacher',
      timelineStartMs: 0, timelineEndMs: 2000, sourceInMs: 0, sourceOutMs: 2000,
      transform: { x: 0, y: 0, scale: 1, crop: 0, fit: 'cover' },
      speedCurve: [{ id: 'teacher-start', at: 0, rate: 1 }, { id: 'teacher-end', at: 1, rate: 1 }],
    }] },
    { id: 'video-main', type: 'video', name: '主视频', clips: [
      {
        id: 'clip-campus', assetId: 'user-campus', name: '校园', kind: '视频', trackId: 'video-main',
        timelineStartMs: 2000, timelineEndMs: 4000, sourceInMs: 0, sourceOutMs: 2000,
        transform: { x: 0, y: 0, scale: 1, crop: 0, fit: 'cover' },
        speedCurve: [{ id: 'campus-start', at: 0, rate: 1 }, { id: 'campus-end', at: 1, rate: 1 }],
      },
      {
        id: 'clip-city', assetId: 'user-city', name: '城市', kind: '视频', trackId: 'video-main',
        timelineStartMs: 4000, timelineEndMs: 6000, sourceInMs: 0, sourceOutMs: 2000,
        transform: { x: 0, y: 0, scale: 1, crop: 0, fit: 'cover' },
        speedCurve: [{ id: 'city-start', at: 0, rate: 1 }, { id: 'city-end', at: 1, rate: 1 }],
      },
      {
        id: 'clip-event', assetId: 'user-event-alt', name: 'campus event', kind: '瑙嗛', trackId: 'video-main',
        timelineStartMs: 6000, timelineEndMs: 8000, sourceInMs: 0, sourceOutMs: 2000,
        transform: { x: 0, y: 0, scale: 1, crop: 0, fit: 'cover' },
        speedCurve: [{ id: 'event-start', at: 0, rate: 1 }, { id: 'event-end', at: 1, rate: 1 }],
      },
    ] },
    { id: 'audio-main', type: 'audio', name: '主音频', clips: [], locked: true },
    { id: 'captions', type: 'captions', name: '字幕', clips: [] },
  ],
  captions: [],
  overlays: [],
  secondaryAudioClips: [],
};

try {
  createReferenceVideo(referencePath);
  server = await startControlledStaticServer();
  const { chromium } = await import(pathToFileURL(runtimePaths().playwright).href);
  browser = await chromium.launch({
    executablePath: runtimePaths().edge,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const inputEvidence = {
    version: 1,
    semanticEvidence: project.assets.map((asset, index) => ({
      schemaVersion: 1,
      assetId: asset.id,
      assetDurationMs: asset.durationMs,
      analysisMethod: 'local-clip',
      createdAt: '2026-10-31T00:00:00.000Z',
      analysisVersion: 'local-clip-medical-v1',
      segments: [{ id: `scene-${asset.id}`, assetId: asset.id, startMs: 0, endMs: index === 3 ? 2_000 : 3_000, summary: 'eligible campus activity scene', concepts: ['campus activity'], usability: 0.95, confidence: 0.95, evidenceFrameMs: [100] }],
    })),
  };
  await context.addInitScript(acceptanceEditorFixtureInitScript, { storageKey: 'medclip-editor-draft-v1', project, inputEvidence });
  const page = await context.newPage();
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/functions/v1/ai-tasks')) providerCalls += 1;
    if (url.origin === server.url || url.protocol === 'blob:' || url.protocol === 'data:') await route.continue();
    else await route.abort('blockedbyclient');
  });
  await page.goto(`${server.url}/editor`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const panel = page.locator('.reference-style-panel');
  await panel.waitFor({ state: 'visible' });
  const beforeProject = await page.evaluate(() => localStorage.getItem('medclip-editor-draft-v1'));

  await panel.locator('input[type="file"]').setInputFiles(referencePath);
  await page.getByText('medclip-v27b-reference-', { exact: false }).waitFor({ state: 'visible' });
  const styleSummary = panel.locator('.reference-style-summary').first();
  await styleSummary.waitFor({ state: 'visible', timeout: 45_000 });
  await panel.getByRole('button', { name: /鎸夊弬鑰冮鏍肩敓鎴愬壀杈戝缓璁|参考风格/ }).click();
  const styleProposal = panel.locator('.reference-style-proposal');
  await styleProposal.waitFor({ state: 'visible' });
  const preExecution = JSON.parse(await page.evaluate(() => localStorage.getItem('medclip-editor-draft-v1')));
  assert.equal(preExecution.assets.some(asset => asset.id.startsWith('reference-v1-')), false);
  assert.equal(await styleProposal.locator('.reference-style-item.protected').count(), 1);

  // B1: local reference analysis and V2.7A style plan are visible.
  const reviewPanel = page.locator('.plan-evidence-panel');
  const rows = reviewPanel.locator('.plan-evidence-entry');
  await rows.first().waitFor({ state: 'visible' });
  assert.ok(await rows.count() >= 4);

  // B2: settle the existing Human Review rows with ACCEPT, MODIFY, and REJECT.
  const clickDecision = async (index, expression) => {
    const row = rows.nth(index);
    if (!await row.evaluate(element => element.open)) await row.locator('summary').click();
    await row.getByRole('button').filter({ hasText: expression }).click();
  };
  const materialRows = [];
  let modifyIndex = -1;
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const content = await row.textContent() ?? '';
    if (!content.includes('MATCH_ASSET_TO_SEGMENT')) continue;
    materialRows.push(index);
    const selector = row.locator('select');
    if (modifyIndex < 0 && await selector.count() && await selector.locator('option').count() > 1) modifyIndex = index;
  }
  assert.ok(materialRows.length >= 3, `three material style actions expected: ${materialRows.join(',')}`);
  assert.ok(modifyIndex >= 0, 'eligible same-semantic alternative should be available');
  const acceptIndex = materialRows.find(index => index !== modifyIndex);
  const rejectIndex = materialRows.find(index => index !== modifyIndex && index !== acceptIndex);
  await rows.nth(modifyIndex).locator('summary').click();
  const modifiedChoice = rows.nth(modifyIndex).locator('select');
  assert.ok(await modifiedChoice.locator('option').count() > 1, 'eligible same-semantic alternative should be available');
  await modifiedChoice.selectOption({ index: 1 });
  await clickDecision(acceptIndex, /接受|鎺ュ彈/);
  await clickDecision(rejectIndex, /拒绝|鎷掔粷/);
  const settled = new Set([acceptIndex, modifyIndex, rejectIndex]);
  for (let index = 0; index < await rows.count(); index += 1) if (!settled.has(index)) await clickDecision(index, /接受|鎺ュ彈/);
  assert.equal(await rows.locator('.plan-evidence-status').filter({ hasText: /等待|寰呭/ }).count(), 0);
  const executeButton = reviewPanel.locator('.plan-evidence-review-footer button');
  assert.equal(await executeButton.isEnabled(), true);

  // B3/B4: the existing reviewed-execution handler performs canonical and hard-constraint validation, then applies once.
  await executeButton.click();
  const executionSummary = panel.locator('[aria-label="参考风格执行结果"]');
  await executionSummary.waitFor({ state: 'visible', timeout: 15_000 });
  const summaryText = await executionSummary.innerText();
  assert.match(summaryText, /执行修改数\s*[1-9]/);
  assert.match(summaryText, /参考素材 \/ 音频 \/ 画面进入输出\s*NO \/ NO \/ NO/);
  const postExecution = JSON.parse(await page.evaluate(() => localStorage.getItem('medclip-editor-draft-v1')));
  assert.notDeepEqual(postExecution.tracks.flatMap(track => track.clips).map(clip => clip.assetId), preExecution.tracks.flatMap(track => track.clips).map(clip => clip.assetId));
  assert.deepEqual(postExecution.assets.map(asset => asset.id), preExecution.assets.map(asset => asset.id));
  assert.equal(providerCalls, 0);

  // B5: the existing timeline history restores exact PRE and POST project material.
  const material = value => { const copy = structuredClone(value); delete copy.updatedAt; return JSON.stringify(copy); };
  await page.getByRole('button', { name: /继续精剪/ }).first().click();
  const toolbar = page.locator('.timeline-editor-header .editor-toolbar');
  await toolbar.waitFor({ state: 'visible' });
  const historyButtons = toolbar.locator('button');
  await historyButtons.nth(0).click();
  await page.waitForFunction(expected => {
    const current = JSON.parse(localStorage.getItem('medclip-editor-draft-v1'));
    delete current.updatedAt;
    return JSON.stringify(current) === expected;
  }, material(preExecution));
  await historyButtons.nth(1).click();
  await page.waitForFunction(expected => {
    const current = JSON.parse(localStorage.getItem('medclip-editor-draft-v1'));
    delete current.updatedAt;
    return JSON.stringify(current) === expected;
  }, material(postExecution));
  process.stdout.write(`${JSON.stringify({ B1: 'PASS', B2: 'PASS', B3: 'PASS', B4: 'PASS', B5: 'PASS', providerCalls })}\n`);
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  if (existsSync(referencePath)) rmSync(referencePath, { force: true });
}
