import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startControlledStaticServer } from './medclip-browser-harness.mjs';

function wavSilence(durationSeconds = 1, sampleRate = 8_000) {
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
const imagePath = join(tmpdir(), `medclip-v26a-${suffix}.png`);
const audioPath = join(tmpdir(), `medclip-v26a-${suffix}.wav`);
const subtitlePath = join(tmpdir(), `medclip-v26a-${suffix}.srt`);
const temporaryFiles = [imagePath, audioPath, subtitlePath];
let server;
let browser;
let providerCalls = 0;

try {
  writeFileSync(imagePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ));
  writeFileSync(audioPath, wavSilence());
  writeFileSync(subtitlePath, '1\n00:00:00,000 --> 00:00:00,900\nBrowser acceptance\n');

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
    if (url.origin === server.url || url.protocol === 'blob:' || url.protocol === 'data:') {
      await route.continue();
    } else {
      await route.abort('blockedbyclient');
    }
  });
  await page.goto(`${server.url}/editor`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  await page.locator('input[type="file"][accept^="video/mp4"]').setInputFiles(imagePath);
  await page.getByText('medclip-v26a-', { exact: false }).first().waitFor({ state: 'visible' });
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles(audioPath);
  await page.getByText('音频 1', { exact: false }).first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /上传同步字幕/ }).click();
  await page.locator('input[type="file"][accept*=".srt"]').setInputFiles(subtitlePath);
  await page.getByText('已读取字幕文件', { exact: false }).waitFor({ state: 'visible' });
  await page.locator('label.consent input[type="checkbox"]').check();
  const generate = page.getByRole('button', { name: '生成剪辑预览', exact: true });
  await generate.waitFor({ state: 'visible' });
  await generate.click();
  const editor = page.locator('.timeline-editor-shell');
  await editor.waitFor({ state: 'visible', timeout: 90_000 });

  // A1: add text.
  await editor.locator('.overlay-toolbox').getByRole('button', { name: '文字', exact: true }).click();
  assert.equal(await editor.locator('.editor-overlay-text').count(), 1);
  assert.equal(await editor.locator('.timeline-overlay').count(), 1);

  // A2: edit, move, and resize text directly on the production preview.
  const textArea = editor.getByLabel('文字内容（允许留空）');
  await textArea.fill('Browser overlay');
  await assert.doesNotReject(() => textArea.inputValue().then(value => assert.equal(value, 'Browser overlay')));
  const textOverlay = editor.locator('.editor-overlay-text');
  const beforeMove = await textOverlay.evaluate(node => ({ left: node.style.left, top: node.style.top, width: node.style.width }));
  const textBox = await textOverlay.boundingBox();
  assert.ok(textBox);
  await page.mouse.move(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(textBox.x + textBox.width / 2 + 28, textBox.y + textBox.height / 2 + 18, { steps: 4 });
  await page.mouse.up();
  const afterMove = await textOverlay.evaluate(node => ({ left: node.style.left, top: node.style.top }));
  assert.notDeepEqual(afterMove, { left: beforeMove.left, top: beforeMove.top });
  const resizeHandle = textOverlay.locator('.overlay-resize-handle');
  const handleBox = await resizeHandle.boundingBox();
  assert.ok(handleBox);
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 24, handleBox.y + handleBox.height / 2 + 14, { steps: 4 });
  await page.mouse.up();
  assert.notEqual(await textOverlay.evaluate(node => node.style.width), beforeMove.width);

  // A3: add an arrow and a basic shape.
  await editor.locator('.overlay-toolbox').getByRole('button', { name: '箭头', exact: true }).click();
  await editor.locator('.overlay-toolbox').getByRole('button', { name: '矩形', exact: true }).click();
  assert.equal(await editor.locator('.timeline-overlay').count(), 3);
  assert.equal(await editor.locator('.editor-overlay-arrow').count(), 1);
  assert.equal(await editor.locator('.editor-overlay-rectangle').count(), 1);

  // A4: one completed add is one undo/redo boundary.
  await editor.getByRole('button', { name: /撤销/ }).click();
  assert.equal(await editor.locator('.timeline-overlay').count(), 2);
  await editor.getByRole('button', { name: /重做/ }).click();
  assert.equal(await editor.locator('.timeline-overlay').count(), 3);

  // A5: instrument the real canvas API, invoke generateCompleteVideo(), and
  // prove text, arrow, and rectangle operations reached the production export.
  await page.evaluate(() => {
    const calls = { fillText: [], lineTo: 0, strokeRect: 0 };
    Object.defineProperty(window, '__MEDCLIP_V26A_CANVAS_CALLS__', { value: calls, configurable: true });
    const prototype = CanvasRenderingContext2D.prototype;
    const fillText = prototype.fillText;
    const lineTo = prototype.lineTo;
    const strokeRect = prototype.strokeRect;
    prototype.fillText = function (text, ...args) { calls.fillText.push(String(text)); return fillText.call(this, text, ...args); };
    prototype.lineTo = function (...args) { calls.lineTo += 1; return lineTo.call(this, ...args); };
    prototype.strokeRect = function (...args) { calls.strokeRect += 1; return strokeRect.call(this, ...args); };
  });
  await editor.getByRole('button', { name: '重新渲染', exact: true }).click();
  await page.waitForFunction(() => {
    const calls = window.__MEDCLIP_V26A_CANVAS_CALLS__;
    return calls?.fillText?.includes('Browser overlay') && calls.lineTo > 0 && calls.strokeRect > 0;
  }, null, { timeout: 30_000 });
  await page.getByText('成片已生成', { exact: true }).waitFor({ state: 'attached', timeout: 30_000 });
  assert.equal(providerCalls, 0);

  process.stdout.write(`${JSON.stringify({
    A1: 'PASS', A2: 'PASS', A3: 'PASS', A4: 'PASS', A5: 'PASS', providerCalls,
  })}\n`);
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  for (const file of temporaryFiles) {
    if (existsSync(file)) rmSync(file, { force: true });
  }
}
