import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyClipPositionScale,
  applyClipPositionScaleToProject,
  applyClipSpeedCurve,
  averageSpeed,
  collectTimelineSnapTargets,
  createFullAudioSelection,
  cropAndRebaseCaptions,
  clipPositionScaleCanvasOffset,
  clipPositionScaleCss,
  formatTimeMs,
  isAIClipPositionScale,
  normalizeAudioSelection,
  parseEditorProject,
  parseTimeMs,
  reorderTimelineClip,
  remapVideoCaptions,
  recordProjectUndoSnapshot,
  sourceTimeAtTimelineMs,
  snapTimelineMs,
  splitTimelineClip,
  speedCurveForTimelineDuration,
  timelineDurationBoundsForSource,
  timelineDurationForSource,
  validateAudioSelection,
  type EditorProject,
  type TimelineClip
} from "./editor-core.ts";

function transformProjectFixture(): EditorProject {
  return {
    schemaVersion: 2,
    id: "transform-project",
    title: "transform fixture",
    updatedAt: "2026-10-22T00:00:00.000Z",
    durationMs: 10_000,
    ratio: "16:9",
    audioSelection: { mode: "range", sourceDurationMs: 20_000, sourceInMs: 2_000, sourceOutMs: 12_000, selectedDurationMs: 10_000 },
    assets: [{ id: "asset", name: "asset", kind: "video" as EditorProject["assets"][number]["kind"], durationMs: 20_000 }],
    tracks: [
      {
        id: "video-main", type: "video", name: "video", clips: [{
          id: "clip", assetId: "asset", name: "clip", kind: "video" as TimelineClip["kind"], trackId: "video-main",
          timelineStartMs: 0, timelineEndMs: 10_000, sourceInMs: 2_000, sourceOutMs: 12_000,
          transform: { x: 0, y: 0, scale: 1, crop: 0.2, fit: "contain" },
          speedCurve: [{ id: "start", at: 0, rate: 1 }, { id: "end", at: 1, rate: 1 }],
        }],
      },
      { id: "audio-main", type: "audio", name: "audio", clips: [] },
    ],
    captions: [{ id: "caption", text: "preserve", startMs: 1_000, endMs: 2_000 }],
  };
}

test("audio selection uses integer milliseconds and recomputes selected duration", () => {
  const selection = normalizeAudioSelection({
    mode: "range",
    sourceDurationMs: 90_000.4,
    sourceInMs: 10_000.4,
    sourceOutMs: 70_555.7,
    selectedDurationMs: 1
  });
  assert.deepEqual(selection, {
    mode: "range",
    sourceDurationMs: 90_000,
    sourceInMs: 10_000,
    sourceOutMs: 70_556,
    selectedDurationMs: 60_556
  });
  assert.equal(validateAudioSelection(selection).valid, true);
});

test("invalid and full selections are handled explicitly", () => {
  assert.equal(
    validateAudioSelection({
      mode: "range",
      sourceDurationMs: 60_000,
      sourceInMs: 10_000,
      sourceOutMs: 10_000,
      selectedDurationMs: 0
    }).valid,
    false
  );
  assert.deepEqual(createFullAudioSelection(12_345), {
    mode: "full",
    sourceDurationMs: 12_345,
    sourceInMs: 0,
    sourceOutMs: 12_345,
    selectedDurationMs: 12_345
  });
});

test("time input supports short and long audio formats", () => {
  assert.equal(formatTimeMs(62_345), "01:02.345");
  assert.equal(formatTimeMs(3_662_345), "01:01:02.345");
  assert.equal(parseTimeMs("01:02.345"), 62_345);
  assert.equal(parseTimeMs("01:01:02.345"), 3_662_345);
});

test("captions outside a selected range are removed and remaining cues are rebased", () => {
  const cues = cropAndRebaseCaptions([
    { id: "a", startMs: 1_000, endMs: 4_000, text: "outside" },
    { id: "b", startMs: 4_000, endMs: 7_000, text: "crossing" },
    { id: "c", startMs: 8_000, endMs: 10_000, text: "inside" },
    { id: "d", startMs: 12_000, endMs: 15_000, text: "outside" }
  ], 5_000, 12_000);
  assert.equal(cues.length, 2);
  assert.deepEqual(
    cues.map(({ startMs, endMs, boundaryClipped }) => ({ startMs, endMs, boundaryClipped })),
    [
      { startMs: 0, endMs: 2_000, boundaryClipped: true },
      { startMs: 3_000, endMs: 5_000, boundaryClipped: false }
    ]
  );
});

test("speed curves change timeline duration and preserve source endpoints", () => {
  const curve = [
    { id: "start", at: 0, rate: 0.5 },
    { id: "end", at: 1, rate: 1.5 }
  ];
  assert.equal(averageSpeed(curve), 1);
  assert.equal(timelineDurationForSource(10_000, curve), 10_000);
  const clip: TimelineClip = {
    id: "clip",
    assetId: "asset",
    name: "clip",
    kind: "视频",
    trackId: "video",
    timelineStartMs: 2_000,
    timelineEndMs: 12_000,
    sourceInMs: 3_000,
    sourceOutMs: 13_000,
    transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
    speedCurve: curve
  };
  assert.equal(sourceTimeAtTimelineMs(clip, 2_000), 3_000);
  assert.equal(sourceTimeAtTimelineMs(clip, 12_000), 13_000);
});

test("manual and AI callers can share one deterministic clip speed mutation", () => {
  const clip: TimelineClip = {
    id: "clip",
    assetId: "asset",
    name: "clip",
    kind: "视频",
    trackId: "video",
    timelineStartMs: 2_000,
    timelineEndMs: 12_000,
    sourceInMs: 3_000,
    sourceOutMs: 13_000,
    transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
    speedCurve: [{ id: "start", at: 0, rate: 1 }, { id: "end", at: 1, rate: 1 }],
  };
  const result = applyClipSpeedCurve(clip, [
    { id: "speed-start", at: 0, rate: 1.25 },
    { id: "speed-end", at: 1, rate: 1.25 },
  ]);
  assert.equal(averageSpeed(result.speedCurve), 1.25);
  assert.equal(result.timelineStartMs, 2_000);
  assert.equal(result.timelineEndMs, 10_000);
  assert.equal(sourceTimeAtTimelineMs(result, 6_000), 8_000);
  assert.equal(clip.timelineEndMs, 12_000);
});

test("AI position and scale validator uses inclusive finite numeric bounds", () => {
  for (const value of [
    { x: -50, y: 50, scale: 0.25 },
    { x: 50, y: -50, scale: 3 },
    { x: 0, y: 0, scale: 1 },
  ]) assert.equal(isAIClipPositionScale(value), true);
  for (const value of [
    { x: "0", y: 0, scale: 1 }, { x: 0, y: "0", scale: 1 }, { x: 0, y: 0, scale: "1" },
    { x: Number.NaN, y: 0, scale: 1 }, { x: 0, y: Number.POSITIVE_INFINITY, scale: 1 },
    { x: 0, y: 0, scale: Number.NEGATIVE_INFINITY }, { x: -50.01, y: 0, scale: 1 },
    { x: 50.01, y: 0, scale: 1 }, { x: 0, y: -50.01, scale: 1 },
    { x: 0, y: 50.01, scale: 1 }, { x: 0, y: 0, scale: 0.249 }, { x: 0, y: 0, scale: 3.001 },
  ]) assert.equal(isAIClipPositionScale(value), false);
});

test("pure clip position and scale mutation preserves crop, fit, other fields, and input", () => {
  const clip: TimelineClip = {
    id: "clip", assetId: "asset", name: "clip", kind: "video" as TimelineClip["kind"], trackId: "video",
    timelineStartMs: 2_000, timelineEndMs: 12_000, sourceInMs: 3_000, sourceOutMs: 13_000,
    transform: { x: 100, y: -100, scale: 1.4, crop: 0.15, fit: "contain" },
    speedCurve: [{ id: "start", at: 0, rate: 1 }, { id: "end", at: 1, rate: 1 }], reason: "original",
  };
  const before = structuredClone(clip);
  const next = applyClipPositionScale(clip, { x: 25, y: -25, scale: 0.8 });
  assert.deepEqual(next.transform, { x: 25, y: -25, scale: 0.8, crop: 0.15, fit: "contain" });
  assert.deepEqual({ ...next, transform: before.transform }, before);
  assert.deepEqual(clip, before);
  const manualRange = applyClipPositionScale(clip, { x: 100, y: -100, scale: 3 });
  assert.deepEqual(manualRange.transform, { x: 100, y: -100, scale: 3, crop: 0.15, fit: "contain" });
  assert.equal(isAIClipPositionScale({ x: 100, y: 0, scale: 1 }), false);
  assert.throws(() => applyClipPositionScale(clip, { x: Number.NaN, y: 0, scale: 1 }), RangeError);
  const malformed = { ...clip, transform: { ...clip.transform, fit: "stretch" } } as unknown as TimelineClip;
  assert.throws(() => applyClipPositionScale(malformed, { x: 0, y: 0, scale: 1 }), RangeError);
});

test("project transform mutation supports manual bounds, preserves project state, and returns identity for no-op", () => {
  const source = transformProjectFixture();
  const before = structuredClone(source);
  const noOp = applyClipPositionScaleToProject(source, "clip", { x: 0, y: 0, scale: 1 });
  assert.equal(noOp, source);
  const changed = applyClipPositionScaleToProject(source, "clip", { x: -100, y: 100, scale: 3 });
  const target = changed.tracks[0].clips[0];
  assert.deepEqual(target.transform, { x: -100, y: 100, scale: 3, crop: 0.2, fit: "contain" });
  assert.deepEqual(source, before);
  assert.equal(target.id, before.tracks[0].clips[0].id);
  assert.equal(target.assetId, before.tracks[0].clips[0].assetId);
  assert.equal(target.trackId, before.tracks[0].clips[0].trackId);
  assert.equal(target.sourceInMs, before.tracks[0].clips[0].sourceInMs);
  assert.equal(target.sourceOutMs, before.tracks[0].clips[0].sourceOutMs);
  assert.equal(target.timelineStartMs, before.tracks[0].clips[0].timelineStartMs);
  assert.equal(target.timelineEndMs, before.tracks[0].clips[0].timelineEndMs);
  assert.deepEqual(target.speedCurve, before.tracks[0].clips[0].speedCurve);
  assert.deepEqual(changed.tracks.slice(1), before.tracks.slice(1));
  assert.deepEqual(changed.captions, before.captions);
  assert.deepEqual(changed.audioSelection, before.audioSelection);
  assert.equal(changed.ratio, before.ratio);
  assert.equal(changed.durationMs, before.durationMs);
  assert.equal(changed.updatedAt, before.updatedAt);
  assert.throws(() => applyClipPositionScaleToProject(source, "unknown", { x: 1, y: 0, scale: 1 }), RangeError);
});

test("manual x, y, and scale edits each create one undo boundary and sequence undo/redo exactly", () => {
  const initial = transformProjectFixture();
  let current = initial;
  let undo: EditorProject[] = [];
  let redo: EditorProject[] = [];
  const edits = [
    { x: 100, y: 0, scale: 1 },
    { x: 100, y: -100, scale: 1 },
    { x: 100, y: -100, scale: 0.25 },
  ];
  for (const edit of edits) {
    undo = recordProjectUndoSnapshot(undo, current);
    redo = [];
    current = applyClipPositionScaleToProject(current, "clip", edit);
  }
  assert.deepEqual(current.tracks[0].clips[0].transform, { x: 100, y: -100, scale: 0.25, crop: 0.2, fit: "contain" });
  assert.equal(undo.length, 3);
  const walkedBack = [current.tracks[0].clips[0].transform];
  for (let index = 0; index < 3; index += 1) {
    const previous = undo.pop()!;
    redo.push(structuredClone(current));
    current = previous;
    walkedBack.push(current.tracks[0].clips[0].transform);
  }
  assert.deepEqual(walkedBack.map(({ x, y, scale }) => ({ x, y, scale })), [
    { x: 100, y: -100, scale: 0.25 },
    { x: 100, y: -100, scale: 1 },
    { x: 100, y: 0, scale: 1 },
    { x: 0, y: 0, scale: 1 },
  ]);
  for (let index = 0; index < 3; index += 1) {
    const next = redo.pop()!;
    undo.push(structuredClone(current));
    current = next;
  }
  assert.deepEqual(current.tracks[0].clips[0].transform, { x: 100, y: -100, scale: 0.25, crop: 0.2, fit: "contain" });
  assert.deepEqual([undo.length, redo.length], [3, 0]);
});

test("shared editor undo snapshot helper keeps the existing fifty snapshot cap", () => {
  let history: EditorProject[] = [];
  const project = transformProjectFixture();
  for (let index = 0; index < 55; index += 1) {
    project.updatedAt = `snapshot-${index}`;
    history = recordProjectUndoSnapshot(history, project);
  }
  assert.equal(history.length, 50);
  assert.equal(history[0].updatedAt, "snapshot-5");
  assert.equal(history.at(-1)?.updatedAt, "snapshot-54");
});

test("transform project round trip preserves values through the existing editor draft format", () => {
  const before = transformProjectFixture();
  const changed = applyClipPositionScaleToProject(before, "clip", { x: 25, y: -25, scale: 0.8 });
  const restored = parseEditorProject(JSON.stringify(changed));
  assert.ok(restored);
  assert.deepEqual(restored.tracks[0].clips[0].transform, { x: 25, y: -25, scale: 0.8, crop: 0.2, fit: "contain" });
  assert.equal(restored.tracks[0].clips[0].sourceInMs, before.tracks[0].clips[0].sourceInMs);
  assert.deepEqual(restored.captions.map(({ id, text, startMs, endMs }) => ({ id, text, startMs, endMs })),
    before.captions.map(({ id, text, startMs, endMs }) => ({ id, text, startMs, endMs })));
  assert.deepEqual(restored.audioSelection, before.audioSelection);
  assert.equal(restored.ratio, before.ratio);
});

test("restored captions omit absent or invalid optional fields and preserve explicit valid values", () => {
  const absentSource = transformProjectFixture();
  const absent = parseEditorProject(JSON.stringify(absentSource));
  assert.ok(absent);
  for (const field of ["confidence", "needsReview", "boundaryClipped"] as const) {
    assert.equal(Object.prototype.hasOwnProperty.call(absent.captions[0], field), false);
  }

  const explicitFalseAndZero = transformProjectFixture();
  explicitFalseAndZero.captions[0] = {
    ...explicitFalseAndZero.captions[0],
    confidence: 0,
    needsReview: false,
    boundaryClipped: false,
  };
  const restoredFalseAndZero = parseEditorProject(JSON.stringify(explicitFalseAndZero));
  assert.ok(restoredFalseAndZero);
  assert.deepEqual(restoredFalseAndZero.captions[0], explicitFalseAndZero.captions[0]);

  const explicitTrue = transformProjectFixture();
  explicitTrue.captions[0] = {
    ...explicitTrue.captions[0],
    confidence: 0.75,
    needsReview: true,
    boundaryClipped: true,
  };
  const restoredTrue = parseEditorProject(JSON.stringify(explicitTrue));
  assert.ok(restoredTrue);
  assert.deepEqual(restoredTrue.captions[0], explicitTrue.captions[0]);

  const invalid = JSON.parse(JSON.stringify(transformProjectFixture())) as Record<string, unknown>;
  const invalidCaptions = invalid.captions as Array<Record<string, unknown>>;
  invalidCaptions[0].confidence = null;
  invalidCaptions[0].needsReview = null;
  invalidCaptions[0].boundaryClipped = null;
  const restoredInvalid = parseEditorProject(JSON.stringify(invalid));
  assert.ok(restoredInvalid);
  for (const field of ["confidence", "needsReview", "boundaryClipped"] as const) {
    assert.equal(Object.prototype.hasOwnProperty.call(restoredInvalid.captions[0], field), false);
  }
});

test("preview CSS and export canvas use matching position and scale geometry including boundaries", () => {
  const cases = [
    { x: 0, y: 0, scale: 1 },
    { x: 25, y: -25, scale: 0.8 },
    { x: -25, y: 25, scale: 1.25 },
    { x: -50, y: -50, scale: 0.25 },
    { x: 50, y: 50, scale: 3 },
  ];
  for (const transform of cases) {
    const style = clipPositionScaleCss(transform);
    assert.equal(style, `translate(${transform.x}%, ${transform.y}%) scale(${transform.scale})`);
    const offset = clipPositionScaleCanvasOffset(transform, 1_920, 1_080);
    assert.deepEqual(offset, { x: 1_920 * transform.x / 100, y: 1_080 * transform.y / 100 });
    assert.equal(Math.max(0.25, transform.scale), transform.scale);
  }
  assert.deepEqual(clipPositionScaleCanvasOffset({ x: 50, y: -50 }, 1_920, 1_080), { x: 960, y: -540 });
  assert.deepEqual(clipPositionScaleCanvasOffset({ x: -50, y: 50 }, 1_920, 1_080), { x: -960, y: 540 });

  const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
  assert.match(css, /\.preview-stage\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /\.editor-canvas\s*\{[\s\S]*?overflow:\s*hidden/);
  const animation = css.match(/@keyframes preview-ken-burns\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(animation, /translate:/);
  assert.match(animation, /scale:/);
  assert.match(animation, /translate:\s*-1\.296% 0/);
  assert.match(animation, /scale:\s*1\.08/);
  assert.doesNotMatch(animation, /transform:/);
});

test("editor wiring uses shared manual mutation, no-op exit, one AI history boundary, and scoped draft storage", () => {
  const timeline = readFileSync(new URL("./TimelineEditor.tsx", import.meta.url), "utf8");
  assert.match(timeline, /applyClipPositionScaleToProject\(current, clipId, positionScale\)/);
  assert.match(timeline, /if \(next === current\) return;\s*commit\(next, true, \{ type: "SET_CLIP_POSITION_SCALE"/);
  assert.match(timeline, /max="100" min="-100" onChange=\{\(event\) => updateClipPositionScale\(selectedClip\.id, \{ x:/);
  assert.match(timeline, /max="100" min="-100" onChange=\{\(event\) => updateClipPositionScale\(selectedClip\.id, \{ y:/);
  assert.match(timeline, /max="3" min="0\.25" onChange=\{\(event\) => updateClipPositionScale\(selectedClip\.id, \{ scale:/);
  assert.match(timeline, /transform: clipPositionScaleCss\(activeClip\?\.transform/);
  assert.match(timeline, /recordProjectUndoSnapshot\(historyRef\.current, initialUndoProject\)/);
  const studio = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  assert.match(studio, /if \(applied\.project === editorProject \|\| !applied\.applied\.length\) return;\s*setEditorAIUndoProject\(cloneProject\(editorProject\)\)/);
  assert.match(studio, /transform: clip\.transform/);
  assert.match(studio, /const transform = segment\?\.transform \?\? DEFAULT_TRANSFORM/);
  assert.match(studio, /transform: clipPositionScaleCss\(activeMatchSegment\?\.transform \?\? DEFAULT_TRANSFORM\)/);
  assert.match(studio, /clipPositionScaleCanvasOffset\(transform, canvas\.width, canvas\.height\)/);
  assert.match(studio, /localStorage\.setItem\(storageKey, JSON\.stringify\(editorProject\)\)/);
});

test("manual and AI callers share one deterministic speed-aware clip split mutation", () => {
  const clip: TimelineClip = {
    id: "clip",
    assetId: "asset",
    name: "clip",
    kind: "视频",
    trackId: "video",
    timelineStartMs: 2_000,
    timelineEndMs: 7_000,
    sourceInMs: 0,
    sourceOutMs: 10_000,
    transform: { x: 0.2, y: -0.1, scale: 1.4, crop: 0.15, fit: "contain" },
    speedCurve: [{ id: "start", at: 0, rate: 2 }, { id: "end", at: 1, rate: 2 }],
    reason: "keep",
  };
  const ids = ["left", "right"];
  const [left, right] = splitTimelineClip(clip, 3_000, () => ids.shift()!);
  assert.deepEqual([left.id, right.id], ["left", "right"]);
  assert.deepEqual([left.timelineStartMs, left.timelineEndMs], [2_000, 5_000]);
  assert.deepEqual([right.timelineStartMs, right.timelineEndMs], [5_000, 7_000]);
  assert.deepEqual([left.sourceInMs, left.sourceOutMs], [0, 6_000]);
  assert.deepEqual([right.sourceInMs, right.sourceOutMs], [6_000, 10_000]);
  assert.equal(averageSpeed(left.speedCurve), 2);
  assert.equal(averageSpeed(right.speedCurve), 2);
  assert.deepEqual(left.transform, clip.transform);
  assert.deepEqual(right.transform, clip.transform);
  assert.equal(left.assetId, clip.assetId);
  assert.equal(right.assetId, clip.assetId);
  assert.equal(sourceTimeAtTimelineMs(left, left.timelineEndMs), 6_000);
  assert.equal(sourceTimeAtTimelineMs(right, right.timelineStartMs), 6_000);
  assert.equal(clip.id, "clip");
});

test("clip split slices a non-linear speed curve and rejects invalid child bounds or IDs", () => {
  const clip: TimelineClip = {
    id: "clip",
    assetId: "asset",
    name: "curve",
    kind: "视频",
    trackId: "video",
    timelineStartMs: 0,
    timelineEndMs: 10_000,
    sourceInMs: 0,
    sourceOutMs: 10_000,
    transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
    speedCurve: [{ id: "start", at: 0, rate: 0.5 }, { id: "mid", at: 0.5, rate: 1 }, { id: "end", at: 1, rate: 1.5 }],
  };
  const expectedSourceAt = sourceTimeAtTimelineMs(clip, 4_000);
  const ids = ["left", "right"];
  const [left, right] = splitTimelineClip(clip, 4_000, () => ids.shift()!);
  assert.equal(left.sourceOutMs, expectedSourceAt);
  assert.equal(right.sourceInMs, expectedSourceAt);
  assert.equal(left.speedCurve.at(-1)?.rate, right.speedCurve[0].rate);
  assert.equal(left.speedCurve.at(-1)?.rate, 0.9);
  for (const splitAt of [0, 99, 9_901, 10_000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => splitTimelineClip(clip, splitAt, () => crypto.randomUUID()), RangeError);
  }
  assert.throws(() => splitTimelineClip(clip, 5_000, () => "duplicate"), /unique editor-generated IDs/);
});

test("manual and AI callers share one deterministic clip reorder mutation", () => {
  const clips: TimelineClip[] = [
    {
      id: "clip-a", assetId: "asset-a", name: "A", kind: "视频", trackId: "video",
      timelineStartMs: 2_000, timelineEndMs: 6_000, sourceInMs: 1_000, sourceOutMs: 5_000,
      transform: { x: 0.2, y: -0.1, scale: 1.2, crop: 0.1, fit: "contain" },
      speedCurve: [{ id: "a-start", at: 0, rate: 1 }, { id: "a-end", at: 1, rate: 1 }], reason: "A",
    },
    {
      id: "clip-b", assetId: "asset-b", name: "B", kind: "视频", trackId: "video",
      timelineStartMs: 7_000, timelineEndMs: 10_000, sourceInMs: 2_000, sourceOutMs: 8_000,
      transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
      speedCurve: [{ id: "b-start", at: 0, rate: 2 }, { id: "b-end", at: 1, rate: 2 }], reason: "B",
    },
    {
      id: "clip-c", assetId: "asset-c", name: "C", kind: "视频", trackId: "video",
      timelineStartMs: 9_000, timelineEndMs: 13_000, sourceInMs: 3_000, sourceOutMs: 8_000,
      transform: { x: -0.2, y: 0.1, scale: 1.4, crop: 0.2, fit: "crop" },
      speedCurve: [{ id: "c-start", at: 0, rate: 1.25 }, { id: "c-end", at: 1, rate: 1.25 }], reason: "C",
    },
  ];
  const project: EditorProject = {
    schemaVersion: 2, id: "project", title: "reorder", updatedAt: "2026-10-19T00:00:00.000Z",
    durationMs: 13_000, ratio: "16:9", audioSelection: createFullAudioSelection(13_000),
    assets: clips.map((clip) => ({ id: clip.assetId, name: clip.name, kind: clip.kind, durationMs: clip.sourceOutMs })),
    tracks: [{ id: "video", type: "video", name: "video", clips }],
    captions: [{ id: "caption", text: "unchanged", startMs: 500, endMs: 1_500 }],
  };
  const original = structuredClone(project);
  const reordered = reorderTimelineClip(project, "clip-c", "clip-a", "BEFORE");
  assert.deepEqual(reordered.tracks[0].clips.map((clip) => clip.id), ["clip-c", "clip-a", "clip-b"]);
  assert.deepEqual(
    reordered.tracks[0].clips.map((clip) => [clip.timelineStartMs, clip.timelineEndMs]),
    [[2_000, 6_000], [6_000, 10_000], [10_000, 13_000]],
  );
  for (const clip of original.tracks[0].clips) {
    const moved = reordered.tracks[0].clips.find((candidate) => candidate.id === clip.id)!;
    assert.deepEqual(
      { ...moved, timelineStartMs: clip.timelineStartMs, timelineEndMs: clip.timelineEndMs },
      clip,
    );
    assert.equal(moved.timelineEndMs - moved.timelineStartMs, clip.timelineEndMs - clip.timelineStartMs);
  }
  assert.deepEqual(reordered.captions, original.captions);
  assert.deepEqual(project, original);
  assert.equal(reordered.durationMs, 13_000);

  const noOp = reorderTimelineClip(project, "clip-a", "clip-b", "BEFORE");
  assert.deepEqual(noOp.tracks, project.tracks);
  assert.throws(() => reorderTimelineClip(project, "clip-a", "clip-a", "BEFORE"), RangeError);
  assert.throws(() => reorderTimelineClip(project, "missing", "clip-a", "BEFORE"), RangeError);
  assert.throws(() => reorderTimelineClip(project, "clip-a", "clip-b", "LEFT" as "BEFORE"), RangeError);
});

test("timeline snapping prefers caption and clip boundaries while Alt-style fine adjustment stays exact", () => {
  const project = {
    schemaVersion: 2 as const,
    id: "project",
    title: "snap",
    updatedAt: "2026-08-06T00:00:00.000Z",
    durationMs: 20_000,
    ratio: "9:16",
    audioSelection: createFullAudioSelection(20_000),
    assets: [],
    tracks: [{ id: "video", type: "video" as const, name: "video", clips: [{
      id: "clip-a",
      assetId: "asset",
      name: "clip",
      kind: "视频" as const,
      trackId: "video",
      timelineStartMs: 2_000,
      timelineEndMs: 6_000,
      sourceInMs: 0,
      sourceOutMs: 4_000,
      transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" as const },
      speedCurve: [{ id: "start", at: 0, rate: 1 }, { id: "end", at: 1, rate: 1 }]
    }] }],
    captions: [{ id: "caption-a", text: "停顿边界", startMs: 6_480, endMs: 8_250 }]
  };
  const targets = collectTimelineSnapTargets(project);
  assert.deepEqual(targets, [0, 2_000, 6_000, 6_480, 8_250, 20_000]);
  assert.equal(snapTimelineMs(6_431, targets, true), 6_480);
  assert.equal(snapTimelineMs(6_431, targets, false), 6_431);
  assert.equal(snapTimelineMs(7_043, targets, true), 7_000);
});

test("video speed automatically fits the unchanged source range into a new timeline duration", () => {
  const faster = speedCurveForTimelineDuration(8_000, 5_000);
  assert.equal(averageSpeed(faster), 1.6);
  assert.equal(timelineDurationForSource(8_000, faster), 5_000);

  const slower = speedCurveForTimelineDuration(4_000, 10_000);
  assert.equal(averageSpeed(slower), 0.4);
  assert.equal(timelineDurationForSource(4_000, slower), 10_000);
  assert.deepEqual(timelineDurationBoundsForSource(4_000), { minMs: 1_000, maxMs: 16_000 });
});

test("video captions follow source intervals across split, removal, and draft restoration", () => {
  const original = transformProjectFixture();
  original.captions[0].videoClipId = "clip";
  original.captions.push({ id: "independent", text: "Independent", startMs: 3000, endMs: 3500 });
  const clip = original.tracks[0].clips[0];
  const ids = ["left", "right"];
  const split = structuredClone(original);
  split.tracks[0].clips = [...splitTimelineClip(clip, 1500, () => ids.shift()!)];
  const mapped = remapVideoCaptions(original, split, clip.id);
  assert.deepEqual(mapped.captions.map(({ videoClipId, startMs, endMs }) => [videoClipId, startMs, endMs]), [
    ["left", 1000, 1500], ["right", 1500, 2000], [undefined, 3000, 3500],
  ]);
  const removed = structuredClone(mapped);
  removed.tracks[0].clips = removed.tracks[0].clips.slice(1);
  const result = remapVideoCaptions(mapped, removed);
  assert.deepEqual(result.captions.map(({ videoClipId }) => videoClipId), ["right", undefined]);
  assert.equal(parseEditorProject(JSON.stringify(result))?.captions[0].videoClipId, "right");
});
