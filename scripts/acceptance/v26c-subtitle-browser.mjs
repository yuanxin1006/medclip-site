import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startControlledStaticServer } from './medclip-browser-harness.mjs';

function wavSilence(durationSeconds = 3, sampleRate = 8_000) {
  const samples = Math.round(durationSeconds * sampleRate);
  const dataLength = samples * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

function runtimePaths(env = process.env) {
  const playwright = env.MEDCLIP_PLAYWRIGHT_MODULE
    ?? join(env.USERPROFILE ?? env.HOME ?? '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
  const edge = env.MEDCLIP_EDGE_EXECUTABLE
    ?? join(env['PROGRAMFILES(X86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe');
  assert.ok(existsSync(playwright), 'Playwright runtime is unavailable.');
  assert.ok(existsSync(edge), 'Microsoft Edge is unavailable.');
  return { playwright, edge };
}

const suffix = `${process.pid}-${Date.now()}`;
const imagePath = join(tmpdir(), `medclip-v26c-${suffix}.png`);
const audioPath = join(tmpdir(), `medclip-v26c-${suffix}.wav`);
const bootstrapSubtitlePath = join(tmpdir(), `medclip-v26c-bootstrap-${suffix}.srt`);
const importedSubtitlePath = join(tmpdir(), `medclip-v26c-import-${suffix}.srt`);
const temporaryFiles = [imagePath, audioPath, bootstrapSubtitlePath, importedSubtitlePath];
let server;
let browser;
let providerCalls = 0;

try {
  writeFileSync(imagePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ));
  writeFileSync(audioPath, wavSilence());
  writeFileSync(bootstrapSubtitlePath, '1\n00:00:00,000 --> 00:00:02,900\nBootstrap caption\n');
  writeFileSync(importedSubtitlePath, [
    '1', '00:00:00,000 --> 00:00:00,800', '第一句字幕', '',
    '2', '00:00:00,900 --> 00:00:01,800', '第二句字幕', '',
    '3', '00:00:01,900 --> 00:00:02,800', '第三句字幕', '',
  ].join('\n'));

  server = await startControlledStaticServer();
  const { chromium } = await import(pathToFileURL(runtimePaths().playwright).href);
  browser = await chromium.launch({
    executablePath: runtimePaths().edge,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/functions/v1/ai-tasks')) providerCalls += 1;
    if (url.origin === server.url || url.protocol === 'blob:' || url.protocol === 'data:') await route.continue();
    else await route.abort('blockedbyclient');
  });
  await page.goto(`${server.url}/editor`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  await page.locator('input[type="file"][accept^="video/mp4"]').setInputFiles(imagePath);
  await page.getByText('medclip-v26c-', { exact: false }).first().waitFor({ state: 'visible' });
  await page.locator('input[type="file"][accept="audio/*"]').first().setInputFiles(audioPath);
  await page.locator('button').filter({ hasText: /上传同步字幕|涓婁紶鍚屾瀛楀箷/ }).click();
  await page.locator('input[type="file"][accept*=".srt"]').first().setInputFiles(bootstrapSubtitlePath);
  await page.locator('label.consent input[type="checkbox"]').check();
  await page.locator('button').filter({ hasText: /生成剪辑预览|鐢熸垚鍓緫棰勮/ }).click();
  const editor = page.locator('.timeline-editor-shell');
  await editor.waitFor({ state: 'visible', timeout: 90_000 });

  // C1: the dedicated editor import converts SRT into three real caption-lane cues.
  const importToolbox = editor.locator('.subtitle-import-toolbox');
  await importToolbox.locator('select').selectOption('replace');
  await importToolbox.locator('input[type="file"]').setInputFiles(importedSubtitlePath);
  await page.waitForFunction(() => document.querySelectorAll('.timeline-editor-shell .timeline-caption').length === 3);
  assert.equal(await editor.locator('.timeline-caption').count(), 3);
  await editor.locator('.timeline-caption').first().getByText('第一句字幕', { exact: true }).waitFor({ state: 'visible' });

  // C4 (import): import creates one exact Undo / Redo boundary.
  await editor.getByRole('button', { name: /撤销|鎾ら攢/ }).click();
  assert.equal(await editor.locator('.timeline-caption').count(), 1);
  await editor.getByRole('button', { name: /重做|閲嶅仛/ }).click();
  assert.equal(await editor.locator('.timeline-caption').count(), 3);

  // C2: edit one cue's authoritative text and timing.
  await editor.locator('.timeline-caption').first().click();
  const properties = editor.locator('.caption-properties');
  await properties.locator('textarea').fill('浏览器已编辑字幕');
  await properties.locator('textarea').press('Tab');
  const numbers = properties.locator('input[type="number"]');
  await numbers.nth(0).fill('0.10');
  await numbers.nth(0).press('Tab');
  await numbers.nth(1).fill('0.75');
  await numbers.nth(1).press('Tab');
  assert.equal(await properties.locator('textarea').inputValue(), '浏览器已编辑字幕');
  assert.equal(await numbers.nth(0).inputValue(), '0.10');
  assert.equal(await numbers.nth(1).inputValue(), '0.75');
  await editor.locator('.timeline-caption').first().getByText('浏览器已编辑字幕', { exact: true }).waitFor({ state: 'visible' });

  // C3: move the selected active caption directly in the production preview.
  await properties.locator('button').last().click();
  const previewCaption = editor.locator('.editor-caption-preview');
  await previewCaption.waitFor({ state: 'visible' });
  const beforePosition = await previewCaption.evaluate(node => ({ left: node.style.left, top: node.style.top }));
  const captionBox = await previewCaption.boundingBox();
  assert.ok(captionBox);
  await page.mouse.move(captionBox.x + captionBox.width / 2, captionBox.y + captionBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(captionBox.x + captionBox.width / 2 + 36, captionBox.y + captionBox.height / 2 - 24, { steps: 4 });
  await page.mouse.up();
  const afterPosition = await previewCaption.evaluate(node => ({ left: node.style.left, top: node.style.top }));
  assert.notDeepEqual(afterPosition, beforePosition);
  await properties.getByRole('button', { name: '应用到全部字幕', exact: true }).click();
  await page.waitForFunction(() => {
    const captions = JSON.parse(localStorage.getItem('medclip-editor-draft-v1') ?? '{}').captions ?? [];
    return captions.length === 3 && captions.every(caption => caption.x === captions[0].x && caption.y === captions[0].y);
  });

  // C4 (position): apply-to-all also restores exact per-caption presentation.
  await editor.getByRole('button', { name: /撤销|鎾ら攢/ }).click();
  await page.waitForFunction(() => {
    const captions = JSON.parse(localStorage.getItem('medclip-editor-draft-v1') ?? '{}').captions ?? [];
    return captions.length === 3 && captions.some(caption => caption.x !== captions[0].x || caption.y !== captions[0].y);
  });
  await editor.getByRole('button', { name: /重做|閲嶅仛/ }).click();
  await page.waitForFunction(() => {
    const captions = JSON.parse(localStorage.getItem('medclip-editor-draft-v1') ?? '{}').captions ?? [];
    return captions.length === 3 && captions.every(caption => caption.x === captions[0].x && caption.y === captions[0].y);
  });

  // C5: production canvas receives the edited caption at the persisted position.
  await page.evaluate(() => {
    const calls = [];
    Object.defineProperty(window, '__MEDCLIP_V26C_CAPTION_CALLS__', { value: calls, configurable: true });
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
      if (String(text) === '浏览器已编辑字幕') calls.push({ x: Number(x), y: Number(y), width: this.canvas.width, height: this.canvas.height });
      return fillText.call(this, text, x, y, ...args);
    };
  });
  await editor.getByRole('button', { name: /重新渲染|閲嶆柊娓叉煋/, exact: true }).click();
  await page.waitForFunction(() => window.__MEDCLIP_V26C_CAPTION_CALLS__?.length > 0, null, { timeout: 30_000 });
  await page.getByText(/成片已生成|鎴愮墖宸茬敓鎴?/).waitFor({ state: 'attached', timeout: 45_000 });
  const exportEvidence = await page.evaluate(async () => {
    const project = JSON.parse(localStorage.getItem('medclip-editor-draft-v1') ?? '{}');
    const call = window.__MEDCLIP_V26C_CAPTION_CALLS__?.[0];
    const video = document.querySelector('.rendered-output video');
    const size = video?.src ? (await (await fetch(video.src)).blob()).size : 0;
    return { call, cue: project.captions?.find(caption => caption.text === '浏览器已编辑字幕'), size };
  });
  assert.ok(exportEvidence.size > 0, 'production export artifact must be non-empty');
  assert.ok(exportEvidence.call && exportEvidence.cue, 'edited caption must reach export');
  assert.ok(Math.abs(exportEvidence.call.x - exportEvidence.cue.x * exportEvidence.call.width) < 2);
  assert.ok(Math.abs(exportEvidence.call.y - exportEvidence.cue.y * exportEvidence.call.height) < 2);
  assert.equal(providerCalls, 0);

  process.stdout.write(`${JSON.stringify({
    C1: 'PASS', C2: 'PASS', C3: 'PASS', C4: 'PASS', C5: 'PASS', providerCalls,
    exportBytes: exportEvidence.size,
  })}\n`);
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  for (const file of temporaryFiles) if (existsSync(file)) rmSync(file, { force: true });
}
