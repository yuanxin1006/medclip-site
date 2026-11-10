import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startControlledStaticServer } from './medclip-browser-harness.mjs';

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
const referencePath = join(tmpdir(), `medclip-v27a-reference-${suffix}.mp4`);
let server;
let browser;
let providerCalls = 0;

const project = {
  schemaVersion: 2,
  id: 'v27a-browser-project',
  title: 'Reference style target fixture',
  updatedAt: '2026-10-31T00:00:00.000Z',
  durationMs: 8000,
  ratio: '16:9',
  audioSelection: { mode: 'full', sourceDurationMs: 8000, sourceInMs: 0, sourceOutMs: 8000, selectedDurationMs: 8000 },
  assets: [
    { id: 'user-teacher', name: '用户老师镜头.mp4', kind: '视频', durationMs: 8000 },
    { id: 'user-campus', name: '用户校园镜头.mp4', kind: '视频', durationMs: 8000 },
    { id: 'user-city', name: '用户城市镜头.mp4', kind: '视频', durationMs: 8000 },
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
        timelineStartMs: 2000, timelineEndMs: 5000, sourceInMs: 0, sourceOutMs: 3000,
        transform: { x: 0, y: 0, scale: 1, crop: 0, fit: 'cover' },
        speedCurve: [{ id: 'campus-start', at: 0, rate: 1 }, { id: 'campus-end', at: 1, rate: 1 }],
      },
      {
        id: 'clip-city', assetId: 'user-city', name: '城市', kind: '视频', trackId: 'video-main',
        timelineStartMs: 5000, timelineEndMs: 8000, sourceInMs: 0, sourceOutMs: 3000,
        transform: { x: 0, y: 0, scale: 1, crop: 0, fit: 'cover' },
        speedCurve: [{ id: 'city-start', at: 0, rate: 1 }, { id: 'city-end', at: 1, rate: 1 }],
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
  await context.addInitScript(value => localStorage.setItem('medclip-editor-draft-v1', JSON.stringify(value)), project);
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

  // R1: upload exactly one local analysis-only reference video.
  await panel.locator('input[type="file"]').setInputFiles(referencePath);
  await panel.getByText('medclip-v27a-reference-', { exact: false }).waitFor({ state: 'visible' });

  // R2: real browser frame sampling yields the deterministic three-cut profile.
  const summary = panel.locator('.reference-style-summary');
  await summary.waitFor({ state: 'visible', timeout: 45_000 });
  await summary.getByText('硬切', { exact: false }).waitFor({ state: 'visible' });
  const summaryText = await summary.innerText();
  assert.match(summaryText, /硬切\s*3/);
  assert.match(summaryText, /平均镜头\s*1\.00 秒/);

  // R3: target is eight seconds while the reference is four; a normalized proposal is produced.
  await panel.getByRole('button', { name: '按参考风格生成剪辑建议', exact: true }).click();
  const proposal = panel.locator('.reference-style-proposal');
  await proposal.waitFor({ state: 'visible' });
  await proposal.getByText(/目标 8\.0 秒/).waitFor({ state: 'visible' });
  assert.ok(await proposal.locator('.reference-style-item').count() > 3, 'normalized target should not copy the three raw reference cut timestamps');

  // R4: the locked teacher clip is preserved and receives no style mutation.
  const protectedItem = proposal.locator('.reference-style-item.protected');
  assert.ok(await protectedItem.count() >= 1);
  await protectedItem.first().getByText('保护内容优先', { exact: false }).waitFor({ state: 'visible' });

  // R5: reference identity/media never enters the target project or output-facing action set.
  const afterProject = await page.evaluate(() => localStorage.getItem('medclip-editor-draft-v1'));
  assert.equal(afterProject, beforeProject);
  const persisted = JSON.parse(afterProject);
  assert.deepEqual(persisted.assets.map(asset => asset.id), ['user-teacher', 'user-campus', 'user-city']);
  assert.ok(!afterProject.includes('medclip-v27a-reference-'));
  await proposal.getByText(/reference asset\/audio\/frame 使用均为 NO/).waitFor({ state: 'visible' });
  assert.equal(providerCalls, 0);

  process.stdout.write(`${JSON.stringify({
    R1: 'PASS', R2: 'PASS', R3: 'PASS', R4: 'PASS', R5: 'PASS', providerCalls,
    detectedCuts: 3,
  })}\n`);
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  if (existsSync(referencePath)) rmSync(referencePath, { force: true });
}
