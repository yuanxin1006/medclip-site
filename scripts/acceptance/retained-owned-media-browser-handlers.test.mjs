import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import test from 'node:test';
import {
  RETAINED_TIMELINE_EDITOR_SELECTOR,
  assertRetainedOwnedMediaBinding,
  cleanupRetainedOwnedMedia,
  createRetainedOwnedMediaFiles,
  exportAndDownloadRetainedOwnedMedia,
  prepareRetainedOwnedMedia,
  proveRetainedOwnedMediaPreview,
  resolveRetainedOwnedMediaTarget,
  saveRetainedDownload,
  validateRetainedDownloadObservation,
  validateRetainedExportObservation,
  validateRetainedPreviewObservation,
} from './retained-owned-media-browser-handlers.mjs';
import {
  createExecutionEditorFixtureV1,
  createImmutableRepetitionEditorFixtureV1,
} from './editor-input-fixtures.mjs';

function projectBoundTo(assetId) {
  return {
    schemaVersion: 2,
    id: 'owned-media-project',
    title: 'Owned media project',
    updatedAt: '2026-10-30T00:00:00.000Z',
    durationMs: 1_200,
    ratio: '16:9',
    audioSelection: {
      mode: 'full', sourceInMs: 0, sourceOutMs: 1_200,
      sourceDurationMs: 1_200, selectedDurationMs: 1_200,
    },
    assets: [{ id: assetId, name: 'owned.webm', kind: '视频', durationMs: 1_200 }],
    tracks: [
      { id: 'audio-main', type: 'audio', name: 'Audio', clips: [], locked: true },
      { id: 'video-main', type: 'video', name: 'Video', clips: [{
        id: 'owned-clip', assetId, name: 'owned.webm', kind: '视频', trackId: 'video-main',
        timelineStartMs: 0, timelineEndMs: 1_200, sourceInMs: 0, sourceOutMs: 1_200,
        transform: { x: 0, y: 0, scale: 1, crop: 0, rotation: 0, fit: 'cover' },
        speedCurve: [{ at: 0, rate: 1 }, { at: 1, rate: 1 }],
      }] },
      { id: 'broll', type: 'broll', name: 'B-roll', clips: [] },
      { id: 'captions', type: 'captions', name: 'Captions', clips: [] },
    ],
    captions: [],
  };
}

function freshDocumentHarness(fixture) {
  const target = resolveRetainedOwnedMediaTarget({ editorInputFixture: fixture });
  const calls = [];
  let project = null;
  let override = null;
  const basic = (selector, options) => ({
    async count() { return 1; },
    async isChecked() { return false; },
    async check() { calls.push(`check:${selector}`); },
    async click() {
      calls.push(`click:${selector}`);
      if (selector === 'button.generate-button') project = projectBoundTo(target.fixtureAssetId);
    },
    async fill() { calls.push(`fill:${selector}`); },
    async setInputFiles(file) {
      calls.push(`file:${selector}:${file.name}`);
      if (selector.includes('accept^="video/"')) {
        assert.equal(override?.assetId, target.fixtureAssetId);
        override.used = true;
      }
    },
    async waitFor() { calls.push(`wait:${selector}:${options?.hasText ?? ''}`); },
    filter() { return basic(`${selector}:filtered`, options); },
  });
  const page = {
    async goto(url) { calls.push(`goto:${url}`); },
    locator(selector, options) { return basic(selector, options); },
    async waitForFunction() { calls.push('waitForFunction'); },
    async evaluate(callback, argument) {
      const source = String(callback);
      if (callback.name === 'installNextRetainedAssetId') {
        override = { assetId: argument, used: false };
        return;
      }
      if (callback.name === 'restoreRetainedAssetId') {
        const result = { installed: Boolean(override), used: override?.used === true, assetId: override?.assetId };
        override = null;
        return result;
      }
      if (source.includes('__MEDCLIP_ACCEPTANCE_DOCUMENT_ID__')) return 'fresh-document-1';
      if (argument === 'medclip-editor-draft-v1') return structuredClone(project);
      throw new Error(`unexpected evaluate: ${callback.name}`);
    },
  };
  return {
    harness: { page, server: { url: 'http://127.0.0.1:43117' } },
    calls,
    target,
  };
}

test('repository-owned media is tiny, deterministic, browser-oriented, and external-provider free', () => {
  const first = createRetainedOwnedMediaFiles('fixture-asset.webm');
  const second = createRetainedOwnedMediaFiles('fixture-asset.webm');
  assert.deepEqual(first.video.buffer, second.video.buffer);
  assert.deepEqual(first.audio.buffer, second.audio.buffer);
  assert.equal(first.video.buffer.subarray(0, 4).toString('hex'), '1a45dfa3');
  assert.equal(first.audio.buffer.subarray(0, 4).toString(), 'RIFF');
  assert.equal(first.audio.buffer.subarray(8, 12).toString(), 'WAVE');
  assert.ok(first.video.buffer.length > 1_000 && first.video.buffer.length < 10_000);
  assert.ok(first.audio.buffer.length > 0 && first.audio.buffer.length < 50_000);
});

test('fixture target resolution is order independent for execution and repair resumes', () => {
  const execution = createExecutionEditorFixtureV1();
  const repair = createImmutableRepetitionEditorFixtureV1();
  const repairFirst = resolveRetainedOwnedMediaTarget({ editorInputFixture: repair });
  const executionSecond = resolveRetainedOwnedMediaTarget({ editorInputFixture: execution });
  assert.equal(repairFirst.fixture.fixtureId, 'medical-adjacent-repetition-v1');
  assert.equal(executionSecond.fixture.fixtureId, 'medical-review-execution-v1');
  assert.ok(repairFirst.fixtureAssetId);
  assert.ok(executionSecond.fixtureAssetId);
});

test('fresh-document preparation uses real inputs and proves fixture=media=clip asset identity', async () => {
  const fixture = createImmutableRepetitionEditorFixtureV1();
  const mock = freshDocumentHarness(fixture);
  const result = await prepareRetainedOwnedMedia({
    harness: mock.harness,
    gateFixtures: { editorInputFixture: fixture },
  });
  assert.equal(result.documentId, 'fresh-document-1');
  assert.equal(result.fixtureAssetId, mock.target.fixtureAssetId);
  assert.equal(result.boundMediaAssetId, mock.target.fixtureAssetId);
  assert.equal(result.clipReferencedAssetId, mock.target.fixtureAssetId);
  assert.ok(mock.calls[0].startsWith('goto:'));
  assert.ok(mock.calls.findIndex(item => item.includes('accept="audio/*"'))
    < mock.calls.findIndex(item => item.includes('accept^="video/"')));
});

test('wrong or missing fixture asset binding fails closed', () => {
  assert.throws(
    () => assertRetainedOwnedMediaBinding({ fixtureAssetId: 'fixture-a', project: projectBoundTo('fixture-b') }),
    /fixture media binding mismatch/,
  );
  assert.throws(() => assertRetainedOwnedMediaBinding({}), /required/);
});

test('preview contract requires current document, ready Blob media, and advancing playback', () => {
  const valid = {
    documentId: 'doc-1', currentSrc: 'blob:http://127.0.0.1:43117/media',
    readyState: 4, duration: 1.2, startTime: 0, endTime: 0.1, paused: false,
  };
  assert.equal(validateRetainedPreviewObservation(valid, 'doc-1').playbackTimeAdvanced, true);
  assert.throws(() => validateRetainedPreviewObservation(valid, 'doc-2'), /stale document/);
  assert.throws(() => validateRetainedPreviewObservation({ ...valid, currentSrc: '' }, 'doc-1'), /Blob URL/);
  assert.throws(() => validateRetainedPreviewObservation({ ...valid, endTime: 0 }, 'doc-1'), /did not advance/);
});

test('preview handler uses the real current control and observes advancing video time', async () => {
  let videoReads = 0;
  let clicked = false;
  const video = {
    async count() { return 1; },
    async evaluate(_callback, argument) {
      videoReads += 1;
      if (videoReads === 1) return undefined;
      if (videoReads === 2) return 0;
      return {
        documentId: argument.documentId,
        currentSrc: 'blob:http://127.0.0.1:43117/preview', readyState: 4,
        duration: 1.2, startTime: argument.startTime, endTime: 0.15, paused: false,
      };
    },
  };
  const control = {
    async count() { return 1; },
    async isEnabled() { return true; },
    async click() { clicked = true; },
  };
  const page = {
    locator(selector) { return selector.endsWith('.editor-canvas video') ? video : control; },
    async waitForFunction() { assert.equal(clicked, true); },
    async evaluate(callback) {
      assert.match(String(callback), /__MEDCLIP_ACCEPTANCE_DOCUMENT_ID__/);
      return 'doc-1';
    },
  };
  const result = await proveRetainedOwnedMediaPreview({ page, mediaEvidence: { documentId: 'doc-1' } });
  assert.equal(result.playRequest, 'SUCCESS');
  assert.equal(result.playbackTimeAdvanced, true);
});

test('export and download contracts reject stale, missing, and zero-byte artifacts', () => {
  const exported = validateRetainedExportObservation({
    documentId: 'doc-1', currentSrc: 'blob:http://127.0.0.1:43117/export', duration: 1.2, bytes: 42,
  }, 'doc-1');
  assert.equal(exported.outputExists, true);
  assert.throws(() => validateRetainedExportObservation({ ...exported, bytes: 0 }, 'doc-1'), /zero bytes/);
  assert.throws(() => validateRetainedExportObservation(exported, 'doc-2'), /stale document/);
  assert.equal(validateRetainedDownloadObservation({
    suggestedFilename: 'owned.webm', pathExists: true, bytes: 42,
  }).fileExists, true);
  assert.throws(() => validateRetainedDownloadObservation({
    suggestedFilename: 'owned.webm', pathExists: true, bytes: 0,
  }), /zero bytes/);
});

test('export handler uses product render/download controls and saveAs-owned temp cleanup', async () => {
  let renderClicked = false;
  let downloadClicked = false;
  let savedDestination;
  const locator = selector => ({
    async count() { return 1; },
    async isEnabled() { return true; },
    async isVisible() { return true; },
    async click() {
      if (selector.endsWith('.render-button')) renderClicked = true;
      if (selector === '.rendered-output-actions a[download]') downloadClicked = true;
    },
    async waitFor() { assert.equal(renderClicked, true); },
    async evaluate(_callback, documentId) {
      return {
        documentId, currentSrc: 'blob:http://127.0.0.1:43117/export',
        duration: 1.2, bytes: 12,
      };
    },
  });
  const download = {
    async failure() { return null; },
    suggestedFilename() { return 'owned.webm'; },
    async saveAs(destination) {
      savedDestination = destination;
      await writeFile(destination, Buffer.from('owned-export'));
    },
  };
  const page = {
    locator,
    async evaluate(callback) {
      assert.match(String(callback), /__MEDCLIP_ACCEPTANCE_DOCUMENT_ID__/);
      return 'doc-1';
    },
    async waitForEvent(name) { assert.equal(name, 'download'); return download; },
  };
  const result = await exportAndDownloadRetainedOwnedMedia({
    page, mediaEvidence: { documentId: 'doc-1' },
  });
  assert.equal(result.exported.outputExists, true);
  assert.equal(result.downloaded.fileExists, true);
  assert.equal(result.downloaded.bytes, Buffer.byteLength('owned-export'));
  assert.equal(result.downloaded.destinationOwner, 'ACCEPTANCE');
  assert.equal(result.downloaded.tempCleanup, 'PASS');
  assert.equal(downloadClicked, true);
  assert.ok(savedDestination.startsWith(tmpdir()));
  await assert.rejects(access(savedDestination));
  await assert.rejects(access(dirname(savedDestination)));
});

test('remote BrowserServer download succeeds through saveAs without requiring path()', async () => {
  let pathCalled = false;
  let destination;
  const result = await saveRetainedDownload({
    async failure() { return null; },
    suggestedFilename() { return '医学科普成片.webm'; },
    async path() {
      pathCalled = true;
      throw new Error('Path is not available when connecting remotely. Use saveAs() to save a local copy.');
    },
    async saveAs(value) {
      destination = value;
      await writeFile(value, Buffer.from('remote-owned-download'));
    },
  });
  assert.equal(pathCalled, false);
  assert.equal(result.suggestedFilename, '医学科普成片.webm');
  assert.equal(result.fileExists, true);
  assert.equal(result.bytes, Buffer.byteLength('remote-owned-download'));
  assert.equal(result.destinationOwner, 'ACCEPTANCE');
  assert.ok(destination.startsWith(tmpdir()));
  await assert.rejects(access(destination));
  await assert.rejects(access(dirname(destination)));
});

test('zero-byte remote save fails closed and removes the acceptance temp directory', async () => {
  let destination;
  await assert.rejects(saveRetainedDownload({
    async failure() { return null; },
    suggestedFilename() { return 'zero.webm'; },
    async saveAs(value) {
      destination = value;
      await writeFile(value, Buffer.alloc(0));
    },
  }), /zero bytes/);
  await assert.rejects(access(destination));
  await assert.rejects(access(dirname(destination)));
});

test('saveAs resolving without a saved file fails closed and cleans the temp directory', async () => {
  let destination;
  await assert.rejects(saveRetainedDownload({
    async failure() { return null; },
    suggestedFilename() { return 'missing.webm'; },
    async saveAs(value) { destination = value; },
  }), /saveAs verification failed/);
  await assert.rejects(access(destination));
  await assert.rejects(access(dirname(destination)));
});

test('saveAs failure fails closed and cleans its acceptance-owned destination', async () => {
  let destination;
  await assert.rejects(saveRetainedDownload({
    async failure() { return null; },
    suggestedFilename() { return 'failed.webm'; },
    async saveAs(value) {
      destination = value;
      throw new Error('remote transfer failed');
    },
  }), /saveAs verification failed/);
  await assert.rejects(access(destination));
  await assert.rejects(access(dirname(destination)));
});

test('cleanup uses product remove controls so current-document object URLs are revoked at teardown', async () => {
  const clicked = [];
  const row = label => ({
    async count() { return 1; },
    locator(selector) {
      assert.equal(selector, '.remove-button');
      return { async count() { return 1; }, async click() { clicked.push(label); } };
    },
    async waitFor(options) { assert.deepEqual(options, { state: 'detached', timeout: 15_000 }); },
  });
  const editor = {
    async count() { return 0; },
    async isVisible() { return false; },
  };
  const page = {
    locator(selector) {
      if (selector === RETAINED_TIMELINE_EDITOR_SELECTOR) return editor;
      if (selector === '.asset-row') return row('visual');
      if (selector === '.audio-card') return row('audio');
      throw new Error(`unexpected selector ${selector}`);
    },
    async evaluate(callback) {
      assert.match(String(callback), /__MEDCLIP_ACCEPTANCE_DOCUMENT_ID__/);
      return 'doc-1';
    },
  };
  const result = await cleanupRetainedOwnedMedia({
    page,
    mediaEvidence: {
      documentId: 'doc-1',
      videoName: 'owned.webm',
      audioName: 'owned.wav',
    },
  });
  assert.deepEqual(clicked, ['visual', 'audio']);
  assert.equal(result.visualObjectUrlRevokedByProduct, true);
  assert.equal(result.audioObjectUrlRevokedByProduct, true);
  assert.equal(result.renderedObjectUrlClearedByProduct, true);
});

test('retained implementation uses product controls, download cleanup, and no provider or direct recorder substitute', async () => {
  const [source, harnessSource] = await Promise.all([
    readFile(new URL('./retained-owned-media-browser-handlers.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./medclip-browser-harness.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /input\[type="file"\]\[accept\^="video\/"\]/);
  assert.match(source, /input\[type="file"\]\[accept="audio\/\*"\]/);
  assert.match(source, /button\.generate-button/);
  assert.match(source, /\.render-button/);
  assert.match(source, /waitForEvent\('download'/);
  assert.match(source, /download\.saveAs\(destination\)/);
  assert.doesNotMatch(source, /download\.path\(\)/);
  assert.match(source, /visualObjectUrlRevokedByProduct: true/);
  assert.doesNotMatch(source, /TokenHub|DeepSeek|Doubao|Kimi|new MediaRecorder/);
  assert.match(harnessSource, /newContext\(\{ acceptDownloads: true, serviceWorkers: 'block' \}\)/);
});
