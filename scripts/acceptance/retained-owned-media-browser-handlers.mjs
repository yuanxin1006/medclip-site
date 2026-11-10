import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { validateAcceptanceEditorFixtureV1 } from './editor-input-fixtures.mjs';
import { readAuthoritativeProject } from './medclip-browser-harness.mjs';

export const RETAINED_OWNED_MEDIA_SCHEMA_VERSION = 1;
export const RETAINED_OWNED_MEDIA_VIDEO_NAME = 'retained-owned-preview.webm';
export const RETAINED_OWNED_MEDIA_AUDIO_NAME = 'retained-owned-narration.wav';
export const RETAINED_OWNED_MEDIA_DURATION_MS = 1_200;
export const RETAINED_TIMELINE_EDITOR_SELECTOR =
  'section.timeline-editor-shell[aria-label="\u751f\u6210\u540e\u7ee7\u7eed\u526a\u8f91"]';

// Generated locally with a deterministic 160x90 VP8 color source. The tiny
// repository-owned payload has no external provenance or runtime dependency.
const RETAINED_OWNED_VIDEO_BASE64 =
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAX9EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggXn7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDJXQYxMYXZmNjMuMS4xMDJEiYhAksAAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIkli9C6pjHH2cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QD+UCq4JCwgaC6gVqagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAyc3PVY8CLY8WIkli9C6pjHH1nyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMjAwMDAwMDAwAB9DtnVEMOeBAKPYgQAAgBAGAJ0BKqAAWgAARwiFhYiZhIgCggLsugP4AgbONQPnTp0dZs2bNmzZs2bNmzZs2bNmzZs2bNmzY8D++Wcf/4hno9TJd//Oxvzsb87G/85oahKExKOygQBDAHEDAAgRDAAYABi39AwAA1VYAKwAVgArABWACsAFWP7ff6xAb4F4/13jbMNtwoCjs4EAhQBxAwAIEOQAGAAYt/QMAANVWACsAFYAKwAVgArABVj+5AEEkG+BeP+g2daidbO6AKO5gQDIALEDAAgQuAAYABl39AwACfCFWgKwFsK1gLYVrAWwrVoA/ueL8EQzVjMrP+5AfSOfSr3uDAAAo7OBAQsAcQMACBCMABgAGLf0DAADVVgArABWACsAFYAKwAVY/uuOWUoZqxmVn/8WcjEdl4CjtIEBTQBxAwAIEGgAGAAYt/QMAANVWACsAFYAKwAVgArABVj+7nZ/kTEj0kiAf/mwK5rn3NCjvIEBkACxAwAIEEwAGAAZd/QMAAnwhVoCsBbCtYC2FawFsK1aAP7vvVeRMSPSSIB/+jD+GH8MP7w8eebdQKO3gQHTAHEDAAgQOAAYABi39AwAA1VYAKwAVgArABWACsAFWP7wsDfivGQ4ZFY//69H89H89H+cAKO4gQIVAHEDAAgQKAAYABi39AwAA1VYAKwAVgArABWACsAFWP70UR/o3nfwHf5bP/3eb9vN+3m/35CjuIECWABxAwAIEBwAGAAYt/QMAANVWACsAFYAKwAVgArABVj++CNv/4H5dOGPD/+Rx/I4/kcf/IZAo76BApsAsQMACBAUABgAGXf0DAAJ8IVaArAWwrWAthWsBbCtWgD++Wcf/4hno9TJd//Oxvzsb87G/85oahKExKO5gQLdAHEDAAgQEAAYABi39AwAA1VYAKwAVgArABWACsAFWP76eV//kpr/G3LV//VY/1WP9Vj/9UaAo7mBAyAAcQMACBAQABgAGLf0DAADVVgArABWACsAFYAKwAVY/vp5X/+Smv8bctX/9Vj/VY//VGgKO5gQNjAHEDAAgQEAAYABi39AwAA1VYAKwAVgArABWACsAFWP76eV//kpr/G3LV//VY/1WP9Vj/9UaAo7mBA6UAcQMACBAQABgAGLf0DAADVVgArABWACsAFYAKwAVY/vp5X/+Smv8bctX/9Vj/VY//VGgKO5gQPoAHEDAAgQEAAYABi39AwAA1VYAKwAVgArABWACsAFWP76eV//kpr/G3LV//VY/1WP9Vj/9UaAo7mBBDsAcQMACBAQABgAGLf0DAADVVgArABWACsAFYAKwAVY/vp5X/+Smv8bctX/9Vj/VY//VGgKO1gQRtAPECAAgQEAAYABi39AwX+gYGAAeVz50505YA/vp5X/+Smv8bctX/9Vj/VY/1WP/1RoAcU7trkbuPs4EAt4r3gQHxggGx8IED';

const RETAINED_OWNED_VIDEO_BASE64_EXACT =
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAX9EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggXn7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDJXQYxMYXZmNjMuMS4xMDJEiYhAksAAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIkli9C6pjHH2cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QD+UCq4JCwgaC6gVqagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAyc3PVY8CLY8WIkli9C6pjHH1nyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMjAwMDAwMDAwAB9DtnVEMOeBAKPYgQAAgBAGAJ0BKqAAWgAARwiFhYiZhIgCggLsugP4AgbONQPnTp0dZs2bNmzZs2bNmzZs2bNmzZs2bNmzY8D++Wcf/4hno9TJd//Oxvzsb87G/85oahKExKOygQBDAHEDAAgRDAAYABi39AwAA1VYAKwAVgArABWACsAFWP7ff6xAb4F4/13jbMNtwoCjs4EAhQBxAwAIEOQAGAAYt/QMAANVWACsAFYAKwAVgArABVj+5AEEkG+BeP+g2daidbO6AKO5gQDIALEDAAgQuAAYABl39AwACfCFWgKwFsK1gLYVrAWwrVoA/ueL8EQzVjMrP+5AfSOfSr3uDAAAo7OBAQsAcQMACBCMABgAGLf0DAADVVgArABWACsAFYAKwAVY/uuOWUoZqxmVn/8WcjEdl4CjtIEBTQBxAwAIEGgAGAAYt/QMAANVWACsAFYAKwAVgArABVj+7nZ/kTEj0kiAf/mwK5rn3NCjvIEBkACxAwAIEEwAGAAZd/QMAAnwhVoCsBbCtYC2FawFsK1aAP7vvVeRMSPSSIB/+jD+GH8MP7w8eebdQKO3gQHTAHEDAAgQOAAYABi39AwAA1VYAKwAVgArABWACsAFWP7wsDfivGQ4ZFY//69H89H89H+cAKO4gQIVAHEDAAgQKAAYABi39AwAA1VYAKwAVgArABWACsAFWP70UR/o3nfwHf5bP/3eb9vN+3m/35CjuIECWABxAwAIEBwAGAAYt/QMAANVWACsAFYAKwAVgArABVj++CNv/4H5dOGPD/+Rx/I4/kcf/IZAo76BApsAsQMACBAUABgAGXf0DAAJ8IVaArAWwrWAthWsBbCtWgD++Wcf/4hno9TJd//Oxvzsb87G/85oahKExKO5gQLdAHEDAAgQEAAYABi39AwAA1VYAKwAVgArABWACsAFWP76eV//kpr/G3LV//VY/1WP9Vj/9UaAo7mBAyAAcQMACBAQABgAGLf0DAADVVgArABWACsAFYAKwAVY/vp5X/+Smv8bctX/9Vj/VY//VGgCjuYEDYwBxAwAIEBAAGAAYt/QMAANVWACsAFYAKwAVgArABVj++nlf/5Ka/xty1f/1WP9Vj/VY//VGgKO5gQOlAHEDAAgQEAAYABi39AwAA1VYAKwAVgArABWACsAFWP76eV//kpr/G3LV//VY/1WP9Vj/9UaAo7mBA+gAcQMACBAQABgAGLf0DAADVVgArABWACsAFYAKwAVY/vp5X/+Smv8bctX/9Vj/VY//VGgCjuYEEKwBxAwAIEBAAGAAYt/QMAANVWACsAFYAKwAVgArABVj++nlf/5Ka/xty1f/1WP9Vj/VY//VGgKO1gQRtAPECAAgQEAAYABi39AwX+gYGAAeVz50505YA/vp5X/+Smv8bctX/9Vj/VY/1WP/1RoAcU7trkbuPs4EAt4r3gQHxggGx8IED';

function failure(message, cause) {
  return Object.assign(new Error(`RETAINED OWNED MEDIA CONTRACT: ${message}`, cause ? { cause } : undefined), {
    harnessFailure: true,
  });
}

function createDeterministicWav(durationMs = RETAINED_OWNED_MEDIA_DURATION_MS) {
  const sampleRate = 16_000;
  const samples = Math.round(sampleRate * durationMs / 1_000);
  const output = Buffer.alloc(44 + samples * 2);
  output.write('RIFF', 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36);
  output.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / 160, (samples - index) / 160);
    const value = Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 4_000 * envelope);
    output.writeInt16LE(value, 44 + index * 2);
  }
  return output;
}

export function createRetainedOwnedMediaFiles(assetName = RETAINED_OWNED_MEDIA_VIDEO_NAME) {
  return Object.freeze({
    video: Object.freeze({
      name: assetName,
      mimeType: 'video/webm',
      buffer: Buffer.from(RETAINED_OWNED_VIDEO_BASE64_EXACT, 'base64'),
    }),
    audio: Object.freeze({
      name: RETAINED_OWNED_MEDIA_AUDIO_NAME,
      mimeType: 'audio/wav',
      buffer: createDeterministicWav(),
    }),
    subtitleText: '1\n00:00:00,000 --> 00:00:01,000\nOwned acceptance preview.',
  });
}

function visualClips(project) {
  return project.tracks
    .filter(track => track.type === 'video' || track.type === 'broll')
    .flatMap(track => track.clips)
    .sort((left, right) => left.timelineStartMs - right.timelineStartMs);
}

export function resolveRetainedOwnedMediaTarget(gateFixtures) {
  let fixture;
  try { fixture = validateAcceptanceEditorFixtureV1(gateFixtures?.editorInputFixture); }
  catch (error) { throw failure('gateFixtures.editorInputFixture is invalid', error); }
  const clip = visualClips(fixture.initialProject)[0];
  if (!clip?.assetId) throw failure('fixture has no visual clip asset binding');
  const asset = fixture.initialProject.assets.find(item => item.id === clip.assetId);
  if (!asset) throw failure(`fixture clip references missing asset ${clip.assetId}`);
  return Object.freeze({ fixture, fixtureAssetId: asset.id, fixtureAssetName: asset.name });
}

export function assertRetainedOwnedMediaBinding({ fixtureAssetId, project }) {
  if (!fixtureAssetId || !project) throw failure('fixture asset and generated project are required');
  const assets = project.assets.filter(asset => asset.id === fixtureAssetId);
  const clips = visualClips(project).filter(clip => clip.assetId === fixtureAssetId);
  if (assets.length !== 1 || clips.length < 1) {
    throw failure(`fixture media binding mismatch for ${fixtureAssetId}`);
  }
  return Object.freeze({
    fixtureAssetId,
    boundMediaAssetId: assets[0].id,
    clipReferencedAssetId: clips[0].assetId,
    clipId: clips[0].id,
  });
}

function installNextRetainedAssetId(assetId) {
  const cryptoObject = window.crypto;
  const ownDescriptor = Object.getOwnPropertyDescriptor(cryptoObject, 'randomUUID');
  const original = cryptoObject.randomUUID.bind(cryptoObject);
  const state = { assetId, ownDescriptor, original, used: false };
  window.__MEDCLIP_RETAINED_MEDIA_ID_OVERRIDE__ = state;
  Object.defineProperty(cryptoObject, 'randomUUID', {
    configurable: true,
    value() {
      if (state.used) return original();
      state.used = true;
      return assetId;
    },
  });
}

function restoreRetainedAssetId() {
  const state = window.__MEDCLIP_RETAINED_MEDIA_ID_OVERRIDE__;
  if (!state) return { installed: false, used: false };
  if (state.ownDescriptor) Object.defineProperty(window.crypto, 'randomUUID', state.ownDescriptor);
  else delete window.crypto.randomUUID;
  delete window.__MEDCLIP_RETAINED_MEDIA_ID_OVERRIDE__;
  return { installed: true, used: state.used === true, assetId: state.assetId };
}

async function currentDocumentId(page) {
  const documentId = await page.evaluate(() => window.__MEDCLIP_ACCEPTANCE_DOCUMENT_ID__ ?? null);
  if (typeof documentId !== 'string' || !documentId) throw failure('current acceptance document identity is unavailable');
  return documentId;
}

async function uploadVideoWithFixtureId(page, file, fixtureAssetId, timeout) {
  await page.evaluate(installNextRetainedAssetId, fixtureAssetId);
  try {
    await page.locator('input[type="file"][accept^="video/"]').setInputFiles(file);
    await page.locator('.asset-row', { hasText: file.name }).waitFor({ state: 'visible', timeout });
  } finally {
    const restored = await page.evaluate(restoreRetainedAssetId);
    if (!restored?.installed || !restored?.used || restored.assetId !== fixtureAssetId) {
      throw failure(`production upload did not consume fixture asset identity ${fixtureAssetId}`);
    }
  }
}

export async function prepareRetainedOwnedMedia({ harness, gateFixtures, timeout = 60_000 } = {}) {
  if (!harness?.page || !harness?.server?.url) throw failure('owned harness page and server are required');
  const { fixture, fixtureAssetId, fixtureAssetName } = resolveRetainedOwnedMediaTarget(gateFixtures);
  const page = harness.page;
  await page.goto(`${harness.server.url}/editor`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const documentId = await currentDocumentId(page);
  const media = createRetainedOwnedMediaFiles(fixtureAssetName);

  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles(media.audio);
  await page.locator('.audio-card', { hasText: media.audio.name }).waitFor({ state: 'visible', timeout });
  await uploadVideoWithFixtureId(page, media.video, fixtureAssetId, timeout);

  const subtitleSource = page.locator('.subtitle-source-tabs button').filter({ hasText: 'SRT' });
  if (await subtitleSource.count() !== 1) throw failure('upload-subtitle source control is missing or ambiguous');
  await subtitleSource.click();
  await page.locator('textarea[aria-label="\u5b57\u5e55\u6587\u672c"]').fill(media.subtitleText);
  const consent = page.locator('.consent input[type="checkbox"]');
  if (!await consent.isChecked()) await consent.check();
  const generate = page.locator('button.generate-button');
  await page.waitForFunction(() => {
    const button = document.querySelector('button.generate-button');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout });
  await generate.click();
  await page.locator(RETAINED_TIMELINE_EDITOR_SELECTOR).waitFor({ state: 'visible', timeout });
  await page.waitForFunction(() => Boolean(window.localStorage.getItem('medclip-editor-draft-v1')), undefined, { timeout });

  const project = await readAuthoritativeProject(page);
  const binding = assertRetainedOwnedMediaBinding({ fixtureAssetId, project });
  const currentId = await currentDocumentId(page);
  if (currentId !== documentId) throw failure('owned media was created in a stale editor document');
  return Object.freeze({
    schemaVersion: RETAINED_OWNED_MEDIA_SCHEMA_VERSION,
    fixtureId: fixture.fixtureId,
    documentId,
    ...binding,
    videoName: media.video.name,
    audioName: media.audio.name,
    providerDependency: false,
  });
}

export function validateRetainedPreviewObservation(observation, expectedDocumentId) {
  if (observation?.documentId !== expectedDocumentId) throw failure('preview evidence belongs to a stale document');
  if (typeof observation.currentSrc !== 'string' || !observation.currentSrc.startsWith('blob:')) {
    throw failure('preview does not use a current-document Blob URL');
  }
  if (!Number.isFinite(observation.duration) || observation.duration <= 0 || observation.readyState < 2) {
    throw failure('preview media is not ready');
  }
  if (observation.paused || !Number.isFinite(observation.startTime)
    || !Number.isFinite(observation.endTime) || observation.endTime <= observation.startTime) {
    throw failure('preview playback time did not advance');
  }
  return Object.freeze({ ...observation, playRequest: 'SUCCESS', playbackTimeAdvanced: true });
}

export async function proveRetainedOwnedMediaPreview({ page, mediaEvidence, timeout = 15_000 } = {}) {
  if (!page || !mediaEvidence?.documentId) throw failure('page and prepared media evidence are required');
  const video = page.locator(`${RETAINED_TIMELINE_EDITOR_SELECTOR} .editor-canvas video`);
  if (await video.count() !== 1) throw failure('owned preview video is missing or ambiguous');
  await video.evaluate(element => {
    if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
    return new Promise((resolve, reject) => {
      element.addEventListener('canplay', resolve, { once: true });
      element.addEventListener('error', reject, { once: true });
    });
  });
  const start = await video.evaluate(element => element.currentTime);
  const play = page.locator(`${RETAINED_TIMELINE_EDITOR_SELECTOR} .editor-player-controls button`);
  if (await play.count() !== 1 || !await play.isEnabled()) throw failure('real preview playback control is unavailable');
  await play.click();
  await page.waitForFunction(({ selector, startTime }) => {
    const element = document.querySelector(selector);
    return element instanceof HTMLVideoElement && !element.paused && element.currentTime > startTime;
  }, { selector: `${RETAINED_TIMELINE_EDITOR_SELECTOR} .editor-canvas video`, startTime: start }, { timeout });
  const observation = await video.evaluate((element, input) => ({
    documentId: input.documentId,
    currentSrc: element.currentSrc,
    readyState: element.readyState,
    duration: element.duration,
    startTime: input.startTime,
    endTime: element.currentTime,
    paused: element.paused,
  }), { documentId: mediaEvidence.documentId, startTime: start });
  return validateRetainedPreviewObservation(observation, await currentDocumentId(page));
}

export function validateRetainedExportObservation(observation, expectedDocumentId) {
  if (observation?.documentId !== expectedDocumentId) throw failure('export evidence belongs to a stale document');
  if (typeof observation.currentSrc !== 'string' || !observation.currentSrc.startsWith('blob:')) {
    throw failure('real export Blob URL is unavailable');
  }
  if (!Number.isSafeInteger(observation.bytes) || observation.bytes <= 0) throw failure('export output is zero bytes');
  return Object.freeze({ ...observation, exportCompletion: 'PASS', outputExists: true });
}

export function validateRetainedDownloadObservation(observation) {
  if (typeof observation?.suggestedFilename !== 'string' || !observation.suggestedFilename.trim()) {
    throw failure('download suggested filename is unavailable');
  }
  if (!observation.pathExists || !Number.isSafeInteger(observation.bytes) || observation.bytes <= 0) {
    throw failure('downloaded export is missing or zero bytes');
  }
  return Object.freeze({ ...observation, downloadEvent: 'PASS', fileExists: true });
}

function safeDownloadFilename(suggestedFilename) {
  if (typeof suggestedFilename !== 'string' || !suggestedFilename.trim()) {
    throw failure('download suggested filename is unavailable');
  }
  const safeName = basename(suggestedFilename.trim())
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '');
  if (!safeName || safeName === '.' || safeName === '..') {
    throw failure('download suggested filename is unsafe for the acceptance temp directory');
  }
  return safeName;
}

export async function saveRetainedDownload(download) {
  if (!download || typeof download.saveAs !== 'function') {
    throw failure('Playwright Download.saveAs is unavailable');
  }
  const suggestedFilename = download.suggestedFilename();
  const safeName = safeDownloadFilename(suggestedFilename);
  const ownedDirectory = await mkdtemp(join(tmpdir(), 'medclip-s5-download-'));
  const destination = join(ownedDirectory, safeName);
  let downloaded;
  let operationError;
  try {
    const downloadFailure = await download.failure();
    if (downloadFailure) throw failure(`product download failed: ${String(downloadFailure).slice(0, 200)}`);
    await download.saveAs(destination);
    const fileStat = await stat(destination);
    downloaded = validateRetainedDownloadObservation({
      suggestedFilename,
      pathExists: fileStat.isFile(),
      bytes: fileStat.size,
    });
  } catch (error) {
    operationError = error?.harnessFailure
      ? error
      : failure('remote-compatible download saveAs verification failed', error);
  }

  try {
    await rm(ownedDirectory, { recursive: true, force: true });
  } catch (error) {
    throw failure('acceptance-owned download temp cleanup failed', error);
  }
  if (operationError) throw operationError;
  return Object.freeze({
    ...downloaded,
    destinationOwner: 'ACCEPTANCE',
    tempCleanup: 'PASS',
  });
}

export async function exportAndDownloadRetainedOwnedMedia({ page, mediaEvidence, timeout = 90_000 } = {}) {
  if (!page || !mediaEvidence?.documentId) throw failure('page and prepared media evidence are required');
  if (await currentDocumentId(page) !== mediaEvidence.documentId) throw failure('prepared media belongs to a stale document');
  const render = page.locator(`${RETAINED_TIMELINE_EDITOR_SELECTOR} .render-button`);
  if (await render.count() !== 1 || !await render.isEnabled()) throw failure('real export control is unavailable');
  await render.click();
  await page.locator('.final-output-card.ready').waitFor({ state: 'attached', timeout });
  const outputVideo = page.locator('.rendered-output video');
  await outputVideo.waitFor({ state: 'attached', timeout });
  const exportObservation = await outputVideo.evaluate(async (element, documentId) => {
    if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise((resolve, reject) => {
        element.addEventListener('loadedmetadata', resolve, { once: true });
        element.addEventListener('error', reject, { once: true });
      });
    }
    const blob = await fetch(element.currentSrc).then(response => response.blob());
    return { documentId, currentSrc: element.currentSrc, duration: element.duration, bytes: blob.size };
  }, mediaEvidence.documentId);
  const exported = validateRetainedExportObservation(exportObservation, await currentDocumentId(page));

  const close = page.locator(`${RETAINED_TIMELINE_EDITOR_SELECTOR} .close-editor`);
  if (await close.count() === 1 && await close.isVisible()) await close.click();
  const downloadControl = page.locator('.rendered-output-actions a[download]');
  if (await downloadControl.count() !== 1) throw failure('real product download control is missing or ambiguous');
  const downloadPromise = page.waitForEvent('download', { timeout });
  await downloadControl.click();
  const download = await downloadPromise;
  const downloaded = await saveRetainedDownload(download);
  return Object.freeze({ exported, downloaded, cleanedDownload: true });
}

export async function cleanupRetainedOwnedMedia({ page, mediaEvidence, timeout = 15_000 } = {}) {
  if (!page || !mediaEvidence?.documentId) throw failure('page and prepared media evidence are required');
  if (await currentDocumentId(page) !== mediaEvidence.documentId) {
    throw failure('refusing to clean media from a different editor document');
  }

  const editor = page.locator(RETAINED_TIMELINE_EDITOR_SELECTOR);
  if (await editor.count() === 1 && await editor.isVisible()) {
    const close = editor.locator('.close-editor');
    if (await close.count() !== 1) throw failure('editor close control is missing during media cleanup');
    await close.click();
  }

  const assetRow = page.locator('.asset-row', { hasText: mediaEvidence.videoName });
  if (await assetRow.count() !== 1) throw failure('owned visual asset is missing or ambiguous during cleanup');
  const removeAsset = assetRow.locator('.remove-button');
  if (await removeAsset.count() !== 1) throw failure('owned visual remove control is missing during cleanup');
  await removeAsset.click();
  await assetRow.waitFor({ state: 'detached', timeout });

  const audioCard = page.locator('.audio-card', { hasText: mediaEvidence.audioName });
  if (await audioCard.count() !== 1) throw failure('owned audio asset is missing or ambiguous during cleanup');
  const removeAudio = audioCard.locator('.remove-button');
  if (await removeAudio.count() !== 1) throw failure('owned audio remove control is missing during cleanup');
  await removeAudio.click();
  await audioCard.waitFor({ state: 'detached', timeout });

  return Object.freeze({
    documentId: mediaEvidence.documentId,
    visualObjectUrlRevokedByProduct: true,
    audioObjectUrlRevokedByProduct: true,
    renderedObjectUrlClearedByProduct: true,
  });
}
