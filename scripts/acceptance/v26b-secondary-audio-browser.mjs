import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startControlledStaticServer } from './medclip-browser-harness.mjs';

function wavTone(durationSeconds = 1, frequency = 440, sampleRate = 8_000) {
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
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.round(Math.sin((index / sampleRate) * frequency * Math.PI * 2) * 5_000);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }
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
const imagePath = join(tmpdir(), `medclip-v26b-${suffix}.png`);
const mainAudioPath = join(tmpdir(), `medclip-v26b-main-${suffix}.wav`);
const effectPath = join(tmpdir(), `medclip-v26b-effect-${suffix}.wav`);
const subtitlePath = join(tmpdir(), `medclip-v26b-${suffix}.srt`);
const temporaryFiles = [imagePath, mainAudioPath, effectPath, subtitlePath];
let server;
let browser;
let providerCalls = 0;

try {
  writeFileSync(imagePath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ));
  writeFileSync(mainAudioPath, wavTone(3, 220));
  writeFileSync(effectPath, wavTone(1, 660));
  writeFileSync(subtitlePath, '1\n00:00:00,000 --> 00:00:02,900\nBrowser secondary audio acceptance\n');

  server = await startControlledStaticServer();
  const { chromium } = await import(pathToFileURL(runtimePaths().playwright).href);
  browser = await chromium.launch({
    executablePath: runtimePaths().edge,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
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
  await page.getByText('medclip-v26b-', { exact: false }).first().waitFor({ state: 'visible' });
  await page.locator('input[type="file"][accept="audio/*"]').first().setInputFiles(mainAudioPath);
  await page.getByText('音频 1', { exact: false }).first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /上传同步字幕/ }).click();
  await page.locator('input[type="file"][accept*=".srt"]').setInputFiles(subtitlePath);
  await page.getByText('已读取字幕文件', { exact: false }).waitFor({ state: 'visible' });
  await page.locator('label.consent input[type="checkbox"]').check();
  await page.getByRole('button', { name: '生成剪辑预览', exact: true }).click();
  const editor = page.locator('.timeline-editor-shell');
  await editor.waitFor({ state: 'visible', timeout: 90_000 });

  // B1: add a real local sound effect.
  const toolbox = editor.locator('.secondary-audio-toolbox');
  await toolbox.locator('input[type="file"]').setInputFiles(effectPath);
  await editor.locator('.timeline-secondary-audio').waitFor({ state: 'visible' });
  assert.equal(await editor.locator('.timeline-secondary-audio').count(), 1);

  // B4: add participates in one meaningful Undo / Redo boundary.
  await editor.getByRole('button', { name: /撤销/ }).click();
  assert.equal(await editor.locator('.timeline-secondary-audio').count(), 0);
  await editor.getByRole('button', { name: /重做/ }).click();
  assert.equal(await editor.locator('.timeline-secondary-audio').count(), 1);

  // B2: move, trim, change gain, and apply both fades through the compact panel.
  const properties = editor.locator('.secondary-audio-properties');
  const numbers = properties.locator('input[type="number"]');
  await numbers.nth(0).fill('0.50');
  await numbers.nth(0).press('Tab');
  await numbers.nth(2).fill('0.10');
  await numbers.nth(2).press('Tab');
  await numbers.nth(3).fill('0.80');
  await numbers.nth(3).press('Tab');
  const sliders = properties.locator('input[type="range"]');
  const setRange = async (locator, value) => locator.evaluate((node, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter.call(node, nextValue);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await setRange(sliders.nth(0), '0.60');
  await sliders.nth(0).press('Tab');
  await setRange(sliders.nth(1), '100');
  await sliders.nth(1).press('Tab');
  await setRange(sliders.nth(2), '150');
  await sliders.nth(2).press('Tab');
  assert.equal(await numbers.nth(0).inputValue(), '0.50');
  assert.equal(await numbers.nth(2).inputValue(), '0.10');
  assert.equal(await numbers.nth(3).inputValue(), '0.80');
  assert.equal(await sliders.nth(0).inputValue(), '0.6');
  await properties.getByText('淡入 0.10 秒', { exact: true }).waitFor({ state: 'visible' });
  await properties.getByText('淡出 0.15 秒', { exact: true }).waitFor({ state: 'visible' });

  // B3: prove the real HTMLMediaElement secondary preview path is activated.
  await page.evaluate(() => {
    const calls = [];
    Object.defineProperty(window, '__MEDCLIP_V26B_PREVIEW_CALLS__', { value: calls, configurable: true });
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (this.dataset.secondaryAudioId) calls.push(this.dataset.secondaryAudioId);
      return play.apply(this, args);
    };
  });
  await properties.getByRole('button', { name: '播放头定位到声音' }).click();
  await editor.locator('.editor-player-controls button').click();
  await page.waitForFunction(() => window.__MEDCLIP_V26B_PREVIEW_CALLS__?.length > 0, null, { timeout: 10_000 });
  await editor.locator('.editor-player-controls button').click();

  // B5: instrument Web Audio scheduling and verify a non-empty production artifact.
  await page.evaluate(() => {
    const calls = { starts: [], gains: 0, ramps: [] };
    Object.defineProperty(window, '__MEDCLIP_V26B_EXPORT_CALLS__', { value: calls, configurable: true });
    const createBufferSource = AudioContext.prototype.createBufferSource;
    const createGain = AudioContext.prototype.createGain;
    AudioContext.prototype.createBufferSource = function (...args) {
      const node = createBufferSource.apply(this, args);
      const start = node.start;
      node.start = function (...startArgs) {
        calls.starts.push(startArgs.map(Number));
        return start.apply(this, startArgs);
      };
      return node;
    };
    AudioContext.prototype.createGain = function (...args) {
      const node = createGain.apply(this, args);
      calls.gains += 1;
      const ramp = node.gain.linearRampToValueAtTime;
      node.gain.linearRampToValueAtTime = function (...rampArgs) {
        calls.ramps.push(rampArgs.map(Number));
        return ramp.apply(this, rampArgs);
      };
      return node;
    };
  });
  await editor.getByRole('button', { name: '重新渲染', exact: true }).click();
  await page.getByText('成片已生成', { exact: true }).waitFor({ state: 'attached', timeout: 45_000 });
  const exportEvidence = await page.evaluate(async () => {
    const video = document.querySelector('.rendered-output video');
    const size = video?.src ? (await (await fetch(video.src)).blob()).size : 0;
    return { calls: window.__MEDCLIP_V26B_EXPORT_CALLS__, size };
  });
  assert.ok(exportEvidence.calls.starts.length >= 2, 'main and secondary audio must both be scheduled');
  assert.ok(exportEvidence.calls.gains >= 1, 'secondary gain node must be created');
  assert.ok(exportEvidence.calls.ramps.length >= 2, 'fade-in and fade-out ramps must be scheduled');
  assert.ok(exportEvidence.size > 0, 'production export artifact must be non-empty');
  assert.equal(providerCalls, 0);

  process.stdout.write(`${JSON.stringify({
    B1: 'PASS', B2: 'PASS', B3: 'PASS', B4: 'PASS', B5: 'PASS', providerCalls,
    exportBytes: exportEvidence.size,
  })}\n`);
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  for (const file of temporaryFiles) if (existsSync(file)) rmSync(file, { force: true });
}
