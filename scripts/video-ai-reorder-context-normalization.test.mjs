import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMatchesPersistedFixtureProject } from './video-ai-reorder-browser-adapter.mjs';
import { setup } from './video-ai-reorder-test-fixture.mjs';
import { inspectPreLiveSafeEditorContext } from './video-ai-live-acceptance-harness.ts';

const clone = value => JSON.parse(JSON.stringify(value));
const captionWithOptionalUndefined = project => {
  project.captions[0].confidence = undefined;
  project.captions[0].needsReview = undefined;
  project.captions[0].boundaryClipped = undefined;
};

test('persisted JSON normalization equates absent caption options with undefined without mutation', () => {
  const { project } = setup();
  const current = clone(project);
  const expected = clone(project);
  captionWithOptionalUndefined(expected);
  const currentBefore = clone(current);
  const expectedBefore = { ...clone(expected), captions: [{ ...clone(expected.captions[0]), confidence: '[undefined]', needsReview: '[undefined]', boundaryClipped: '[undefined]' }] };

  assert.doesNotThrow(() => assertMatchesPersistedFixtureProject(current, expected));
  assert.deepEqual(current, currentBefore);
  assert.equal(expected.captions[0].confidence, undefined);
  assert.equal(expected.captions[0].needsReview, undefined);
  assert.equal(expected.captions[0].boundaryClipped, undefined);
  assert.deepEqual(Object.keys(expected.captions[0]), Object.keys(expectedBefore.captions[0]));
});

test('LIVE_CONTEXT_VALIDATE passes normalized project equality and unchanged safe semantic gate', () => {
  const { project, input } = setup();
  const current = clone(project);
  const expected = clone(project);
  captionWithOptionalUndefined(expected);
  assert.doesNotThrow(() => assertMatchesPersistedFixtureProject(current, expected));
  assert.equal(inspectPreLiveSafeEditorContext(input).eligible, true);
});

test('normalization rejects null versus absent meaningful properties', () => {
  const { project } = setup();
  const current = clone(project);
  const expected = clone(project);
  current.captions[0].confidence = null;
  assert.throws(() => assertMatchesPersistedFixtureProject(current, expected), assert.AssertionError);
});

const driftCases = [
  ['caption text', p => { p.captions[0].text = 'Changed'; }],
  ['caption timing', p => { p.captions[0].startMs = 20; p.captions[0].endMs = 900; }],
  ['clip order', p => { p.tracks[0].clips.reverse(); }],
  ['asset binding', p => { p.tracks[0].clips[0].assetId = 'different-asset'; }],
  ['project duration', p => { p.durationMs += 1; }],
  ['caption collection', p => { p.captions.push({ id:'extra-caption', text:'extra', startMs:1, endMs:2 }); }],
  ['audio collection', p => { p.tracks.find(t => t.type === 'audio').clips.push({ id:'extra-audio', assetId:'audio', timelineStartMs:0, timelineEndMs:100 }); }],
];
for (const [label, mutate] of driftCases) test(`persistence normalization rejects ${label} drift`, () => {
  const { project } = setup();
  const current = clone(project);
  mutate(current);
  assert.throws(() => assertMatchesPersistedFixtureProject(current, project), assert.AssertionError);
});

test('normalization preserves ordering in clips, tracks, assets, captions, and audio arrays', () => {
  const { project } = setup();
  const reordered = clone(project);
  reordered.assets.push({ ...clone(reordered.assets[0]), id:'second-asset' });
  reordered.captions.push({ ...clone(reordered.captions[0]), id:'second-caption' });
  const audioTrack = reordered.tracks.find(t => t.type === 'audio');
  audioTrack.clips.push({ id:'audio-a', assetId:'audio', timelineStartMs:0, timelineEndMs:100 }, { id:'audio-b', assetId:'audio', timelineStartMs:100, timelineEndMs:200 });
  reordered.assets.reverse();
  reordered.captions.reverse();
  audioTrack.clips.reverse();
  reordered.tracks.reverse();
  for (const track of reordered.tracks) if (Array.isArray(track.clips) && track.clips.length > 1) track.clips.reverse();
  assert.throws(() => assertMatchesPersistedFixtureProject(reordered, project), assert.AssertionError);
});

test('missing meaningful property remains different after persisted JSON normalization', () => {
  const { project } = setup();
  const current = clone(project);
  delete current.captions[0].text;
  assert.throws(() => assertMatchesPersistedFixtureProject(current, project), assert.AssertionError);
});
