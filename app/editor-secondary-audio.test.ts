import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  cloneProject,
  createFullAudioSelection,
  parseEditorProject,
  recordProjectUndoSnapshot,
  type EditorProject,
} from "./editor-core.ts";
import {
  buildSecondaryAudioMixPlan,
  createSecondaryAudioClip,
  normalizeSecondaryAudioClip,
  patchSecondaryAudioClip,
  secondaryAudioClipsAt,
  secondaryAudioDurationMs,
  secondaryAudioEndMs,
  secondaryAudioGainAt,
  validateSecondaryAudioClip,
  type SecondaryAudioClip,
} from "./editor-secondary-audio.ts";

const projectDurationMs = 12_000;

const clipA = (): SecondaryAudioClip => createSecondaryAudioClip({
  id: "sfx-a",
  name: "提示音.wav",
  sourceUrl: "blob:sfx-a",
  sourceDurationMs: 2_000,
  timelineStartMs: 2_000,
  projectDurationMs,
  sourceType: "sound-effect",
});

const clipB = (): SecondaryAudioClip => patchSecondaryAudioClip(createSecondaryAudioClip({
  id: "voice-b",
  name: "补充配音.wav",
  sourceUrl: "blob:voice-b",
  sourceDurationMs: 6_000,
  timelineStartMs: 6_000,
  projectDurationMs,
  sourceType: "voice",
}), {
  sourceStartMs: 1_000,
  sourceEndMs: 5_000,
  volume: 0.55,
  fadeInMs: 500,
  fadeOutMs: 750,
}, projectDurationMs);

const fixture = (clips: SecondaryAudioClip[] = [clipA(), clipB()]): EditorProject => ({
  schemaVersion: 2,
  id: "v26b-fixture",
  title: "V2.6B deterministic 12 second project",
  updatedAt: "2026-10-31T00:00:00.000Z",
  durationMs: projectDurationMs,
  ratio: "16:9",
  audioSelection: createFullAudioSelection(projectDurationMs),
  assets: [],
  tracks: [{ id: "audio-main", type: "audio", name: "主音频", clips: [], locked: true }],
  captions: [],
  overlays: [],
  secondaryAudioClips: clips,
});

test("V2.6B creates sound-effect, voice, and imported-audio clips from one bounded model", () => {
  for (const sourceType of ["sound-effect", "voice", "imported-audio"] as const) {
    const clip = createSecondaryAudioClip({
      id: sourceType,
      name: `${sourceType}.wav`,
      sourceUrl: `blob:${sourceType}`,
      sourceDurationMs: 2_000,
      timelineStartMs: 11_500,
      projectDurationMs,
      sourceType,
    });
    assert.equal(clip.sourceType, sourceType);
    assert.equal(secondaryAudioEndMs(clip), projectDurationMs);
    assert.equal(validateSecondaryAudioClip(clip, projectDurationMs).valid, true);
  }
});

test("V2.6B validation rejects non-finite timing, trim inversion, volume, fades, and missing sources", () => {
  const valid = clipB();
  assert.equal(validateSecondaryAudioClip(valid, projectDurationMs).valid, true);
  assert.equal(validateSecondaryAudioClip({ ...valid, sourceUrl: "" }, projectDurationMs).valid, false);
  assert.equal(validateSecondaryAudioClip({ ...valid, timelineStartMs: Number.NaN }, projectDurationMs).valid, false);
  assert.equal(validateSecondaryAudioClip({ ...valid, sourceEndMs: valid.sourceStartMs }, projectDurationMs).valid, false);
  assert.equal(validateSecondaryAudioClip({ ...valid, volume: 1.1 }, projectDurationMs).valid, false);
  assert.equal(validateSecondaryAudioClip({ ...valid, fadeInMs: 3_000, fadeOutMs: 2_000 }, projectDurationMs).valid, false);
});

test("V2.6B move, trim, volume, and fade edits clamp to safe project and source bounds", () => {
  const original = clipB();
  const bounded = patchSecondaryAudioClip(original, {
    timelineStartMs: -900,
    sourceStartMs: -200,
    sourceEndMs: 99_000,
    volume: 7,
    fadeInMs: 9_000,
    fadeOutMs: 9_000,
  }, projectDurationMs);
  assert.equal(bounded.timelineStartMs, 0);
  assert.equal(bounded.sourceStartMs, 0);
  assert.equal(bounded.sourceEndMs, original.sourceDurationMs);
  assert.equal(bounded.volume, 1);
  assert.equal(bounded.fadeInMs + bounded.fadeOutMs <= secondaryAudioDurationMs(bounded), true);
  assert.equal(validateSecondaryAudioClip(bounded, projectDurationMs).valid, true);

  const nonFinite = normalizeSecondaryAudioClip({ ...original, timelineStartMs: Number.NaN }, projectDurationMs);
  assert.equal(Number.isFinite(nonFinite.timelineStartMs), true);
  assert.equal(validateSecondaryAudioClip(nonFinite, projectDurationMs).valid, true);
});

test("V2.6B supports multiple overlapping clips and computes preview fade gain", () => {
  const a = clipA();
  const overlapping = patchSecondaryAudioClip(clipB(), { timelineStartMs: 3_000 }, projectDurationMs);
  assert.deepEqual(secondaryAudioClipsAt([a, overlapping], 3_500).map((clip) => clip.id), ["sfx-a", "voice-b"]);
  assert.equal(secondaryAudioGainAt(overlapping, 2_999), 0);
  assert.equal(secondaryAudioGainAt(overlapping, 3_250), 0.275);
  assert.equal(secondaryAudioGainAt(overlapping, 4_000), 0.55);
  assert.ok(secondaryAudioGainAt(overlapping, secondaryAudioEndMs(overlapping) - 250) < 0.55);
  assert.equal(secondaryAudioGainAt(overlapping, secondaryAudioEndMs(overlapping)), 0);
});

test("V2.6B add, delete, Undo, and Redo preserve exact secondary clip metadata", () => {
  const beforeAdd = fixture([]);
  const afterAdd = cloneProject(beforeAdd);
  afterAdd.secondaryAudioClips = [clipA()];
  const undoHistory = recordProjectUndoSnapshot([], beforeAdd);
  const undoAdd = undoHistory.pop();
  assert.deepEqual(undoAdd?.secondaryAudioClips, []);
  const redoHistory = [cloneProject(afterAdd)];
  assert.equal(redoHistory.pop()?.secondaryAudioClips?.[0]?.id, "sfx-a");

  const beforeDelete = cloneProject(afterAdd);
  const afterDelete = cloneProject(beforeDelete);
  afterDelete.secondaryAudioClips = [];
  const deleteHistory = recordProjectUndoSnapshot([], beforeDelete);
  assert.deepEqual(afterDelete.secondaryAudioClips, []);
  assert.deepEqual(deleteHistory.pop()?.secondaryAudioClips, [clipA()]);
});

test("V2.6B project persistence is backward compatible and normalizes saved clips", () => {
  const legacy = fixture();
  delete legacy.secondaryAudioClips;
  assert.deepEqual(parseEditorProject(JSON.stringify(legacy))?.secondaryAudioClips, []);
  const restored = parseEditorProject(JSON.stringify(fixture()));
  assert.deepEqual(restored?.secondaryAudioClips?.map((clip) => clip.id), ["sfx-a", "voice-b"]);
  assert.equal(restored?.secondaryAudioClips?.[1]?.volume, 0.55);
});

test("V2.6B export mix plan preserves timeline start, source trim, gain, and fade envelope", () => {
  const plan = buildSecondaryAudioMixPlan([clipA(), clipB()], projectDurationMs);
  assert.deepEqual(plan, [
    {
      clipId: "sfx-a",
      timelineStartSeconds: 2,
      sourceOffsetSeconds: 0,
      durationSeconds: 2,
      volume: 0.8,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
    },
    {
      clipId: "voice-b",
      timelineStartSeconds: 6,
      sourceOffsetSeconds: 1,
      durationSeconds: 4,
      volume: 0.55,
      fadeInSeconds: 0.5,
      fadeOutSeconds: 0.75,
    },
  ]);
});

test("V2.6B production paths use real media preview and shared AudioContext export mixing", () => {
  const editorSource = readFileSync(new URL("./TimelineEditor.tsx", import.meta.url), "utf8");
  const studioSource = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  assert.match(editorSource, /secondaryAudioElementsRef[\s\S]*audio\.play\(\)/);
  assert.match(editorSource, /beginSecondaryAudioTimelineDrag[\s\S]*sourceStartMs[\s\S]*sourceEndMs/);
  assert.match(editorSource, /secondaryAudioPropertyBaseRef[\s\S]*recordProjectUndoSnapshot/);
  assert.match(studioSource, /buildSecondaryAudioMixPlan\([\s\S]*secondaryAudioClips/);
  assert.match(studioSource, /createGain\(\)[\s\S]*linearRampToValueAtTime\(entry\.volume[\s\S]*linearRampToValueAtTime\(0/);
  assert.match(studioSource, /source\.start\(startsAt, entry\.sourceOffsetSeconds, playableDuration\)/);
  assert.match(studioSource, /source\.connect\(gain\)[\s\S]*gain\.connect\(audioDestination\)/);
});

