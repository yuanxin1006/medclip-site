import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AIEditingPlanValidationError,
  applyAIEditingPlan,
  applySetCaptionTextToProject,
  createSafeCaptionAIContext,
  createSafeEditorAIContext,
  parseAIEditingPlan,
} from "./editor-ai-requirements.ts";
import {
  averageSpeed,
  cloneProject,
  parseEditorProject,
  recordProjectUndoSnapshot,
  sourceTimeAtTimelineMs,
  type EditorProject,
} from "./editor-core.ts";

function projectFixture(): EditorProject {
  return {
    schemaVersion: 2,
    id: "project-a",
    title: "fixture",
    updatedAt: "2026-10-16T00:00:00.000Z",
    durationMs: 20_000,
    ratio: "16:9",
    audioSelection: { mode: "full", sourceDurationMs: 30_000, sourceInMs: 0, sourceOutMs: 30_000, selectedDurationMs: 30_000 },
    assets: [
      { id: "asset-a", name: "A", kind: "视频", durationMs: 20_000 },
      { id: "asset-b", name: "B", kind: "视频", durationMs: 12_000 },
    ],
    tracks: [
      {
        id: "video-main", type: "video", name: "video", clips: [
          {
            id: "clip-a", assetId: "asset-a", name: "A", kind: "视频", trackId: "video-main",
            timelineStartMs: 0, timelineEndMs: 10_000, sourceInMs: 0, sourceOutMs: 10_000,
            transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
            speedCurve: [{ id: "start", at: 0, rate: 1 }, { id: "end", at: 1, rate: 1 }],
          },
          {
            id: "clip-b", assetId: "asset-a", name: "A2", kind: "视频", trackId: "video-main",
            timelineStartMs: 10_000, timelineEndMs: 20_000, sourceInMs: 10_000, sourceOutMs: 20_000,
            transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
            speedCurve: [{ id: "start", at: 0, rate: 1 }, { id: "end", at: 1, rate: 1 }],
          },
        ],
      },
      { id: "audio-main", type: "audio", name: "audio", clips: [] },
      { id: "captions", type: "captions", name: "captions", clips: [] },
    ],
    captions: [{ id: "caption-a", text: "hello", startMs: 1_000, endMs: 2_000 }],
  };
}

function action(overrides: Record<string, unknown> = {}) {
  return {
    type: "TRIM_CLIP", targetId: "clip-a", assetId: "", startSeconds: 5, endSeconds: 10,
    reason: "Remove the first five seconds from this clip.", ...overrides,
  };
}

function speedAction(overrides: Record<string, unknown> = {}) {
  return {
    type: "SET_CLIP_PLAYBACK_SPEED", targetId: "clip-a", assetId: "", playbackRate: 1.25,
    reason: "Use the explicit requested playback rate.", ...overrides,
  };
}

function splitAction(overrides: Record<string, unknown> = {}) {
  return {
    type: "SPLIT_CLIP", targetId: "clip-a", assetId: "", splitAtSeconds: 6,
    reason: "Split six seconds from the start of the clip displayed timeline.", ...overrides,
  };
}

function reorderAction(overrides: Record<string, unknown> = {}) {
  return {
    type: "REORDER_CLIP", targetId: "clip-c", assetId: "", referenceId: "clip-a", placement: "BEFORE",
    reason: "Move the selected clip relative to the supplied reference clip.", ...overrides,
  };
}

function positionScaleAction(overrides: Record<string, unknown> = {}) {
  return {
    type: "SET_CLIP_POSITION_SCALE", targetId: "clip-a", assetId: "", x: 0, y: 0, scale: 1,
    reason: "Center and size the selected clip as requested.", ...overrides,
  };
}

function captionTextAction(overrides: Record<string, unknown> = {}) {
  return {
    type: "SET_CAPTION_TEXT", targetId: "caption-a", text: "Updated caption",
    reason: "Correct the caption wording.", ...overrides,
  };
}

function threeClipProject(): EditorProject {
  const project = projectFixture();
  project.durationMs = 30_000;
  project.tracks[0].clips.push({
    ...structuredClone(project.tracks[0].clips[1]),
    id: "clip-c",
    name: "C",
    assetId: "asset-b",
    timelineStartMs: 20_000,
    timelineEndMs: 30_000,
    sourceInMs: 0,
    sourceOutMs: 10_000,
  });
  return project;
}

function plan(actions: unknown[] = [], unsupported: unknown[] = []) {
  return { summary: "Safe plan", actions, unsupported, warnings: [] };
}

function context(project = projectFixture(), childIds = ["clip-left", "clip-right"]) {
  let childIndex = 0;
  return {
    project,
    ownedAssetIds: new Set(["asset-a", "asset-b"]),
    audioSourceDurationMs: 30_000,
    nowIso: "2026-10-16T01:00:00.000Z",
    createClipId: () => childIds[childIndex++] ?? `clip-child-${childIndex}`,
  };
}

type CaptionIntegrationState = {
  project: EditorProject;
  captionRecords: EditorProject["captions"];
  history: EditorProject[];
  future: EditorProject[];
  selection: { kind: "caption"; id: string } | null;
};

function captionIntegrationState(project = projectFixture()): CaptionIntegrationState {
  return {
    project,
    captionRecords: project.captions.map((caption) => ({ ...caption })),
    history: [],
    future: [],
    selection: { kind: "caption", id: "caption-a" },
  };
}

function syncIntegratedProject(state: CaptionIntegrationState, project: EditorProject) {
  state.project = project;
  state.captionRecords = project.captions.map((caption) => ({ ...caption }));
}

function applyCaptionPlanToIntegration(state: CaptionIntegrationState, value: unknown) {
  const applied = applyAIEditingPlan(value, context(state.project));
  if (applied.project === state.project) return applied;
  state.history = recordProjectUndoSnapshot(state.history, state.project);
  state.future = [];
  syncIntegratedProject(state, applied.project);
  return applied;
}

function undoIntegratedProject(state: CaptionIntegrationState) {
  const previous = state.history.pop();
  if (!previous) return;
  state.future.push(cloneProject(state.project));
  syncIntegratedProject(state, previous);
}

function redoIntegratedProject(state: CaptionIntegrationState) {
  const next = state.future.pop();
  if (!next) return;
  state.history = recordProjectUndoSnapshot(state.history, state.project);
  syncIntegratedProject(state, next);
}

function integrationSrt(captions: EditorProject["captions"]) {
  const timecode = (valueMs: number) => {
    const hours = Math.floor(valueMs / 3_600_000);
    const minutes = Math.floor(valueMs / 60_000) % 60;
    const seconds = Math.floor(valueMs / 1_000) % 60;
    const milliseconds = valueMs % 1_000;
    return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":")
      + `,${String(milliseconds).padStart(3, "0")}`;
  };
  return captions.map((caption, index) => (
    `${index + 1}\n${timecode(caption.startMs)} --> ${timecode(caption.endMs)}\n${caption.text}`
  )).join("\n\n");
}

test("strict plan parser rejects malformed shapes and empty output", () => {
  assert.throws(() => parseAIEditingPlan("not-json"), AIEditingPlanValidationError);
  assert.throws(() => parseAIEditingPlan({ ...plan(), extra: true }), AIEditingPlanValidationError);
  assert.throws(() => parseAIEditingPlan({ ...plan(), summary: "" }), AIEditingPlanValidationError);
});

test("SET_CAPTION_TEXT has an exact canonical shape and preserves replacement text verbatim", () => {
  const valid = captionTextAction({ text: "  肺炎链球菌 (S. pneumoniae)，已校正。  " });
  assert.deepEqual(parseAIEditingPlan(plan([valid])).actions[0], valid);
  for (const invalid of [
    { extra: true }, { targetId: "" }, { targetId: " caption-a " }, { text: "" },
    { text: " \n\t " }, { text: null }, { text: 12 }, { reason: "" },
  ]) {
    assert.throws(() => parseAIEditingPlan(plan([captionTextAction(invalid)])), AIEditingPlanValidationError);
  }
  for (const key of ["type", "targetId", "text", "reason"]) {
    const missing = captionTextAction();
    delete (missing as Record<string, unknown>)[key];
    assert.throws(() => parseAIEditingPlan(plan([missing])), AIEditingPlanValidationError);
  }
  assert.throws(() => parseAIEditingPlan(plan([captionTextAction({ type: "SET_CAPTION_TIMING" })])), AIEditingPlanValidationError);
  assert.throws(() => parseAIEditingPlan(plan([captionTextAction({ text: "x".repeat(2_001) })])), AIEditingPlanValidationError);
});

test("SET_CAPTION_TEXT deterministically changes only one exact caption and preserves project data", () => {
  const source = projectFixture();
  source.captions.push({ id: "caption-b", text: "hello", startMs: 2_500, endMs: 3_500, needsReview: true });
  const before = structuredClone(source);
  const expectedTexts = ["中文：β-内酰胺酶；", "Corrected English: Streptococcus pneumoniae.", "SpO₂ 98% — no change to timing!"];
  for (const text of expectedTexts) {
    const result = applyAIEditingPlan(plan([captionTextAction({ text })]), context(source));
    assert.equal(result.project.captions[0].text, text);
    assert.deepEqual(result.project.captions[0], { ...before.captions[0], text });
    assert.deepEqual(result.project.captions[1], before.captions[1]);
    assert.deepEqual(result.project.tracks, before.tracks);
    assert.deepEqual(result.project.audioSelection, before.audioSelection);
    assert.equal(result.project.ratio, before.ratio);
    assert.equal(result.project.durationMs, before.durationMs);
    assert.equal(result.project.captions[0].id, before.captions[0].id);
    assert.equal(result.project.captions[0].startMs, before.captions[0].startMs);
    assert.equal(result.project.captions[0].endMs, before.captions[0].endMs);
    assert.equal(result.project.updatedAt, "2026-10-16T01:00:00.000Z");
  }
  assert.equal(source.captions[0].text, before.captions[0].text);
});

test("SET_CAPTION_TEXT rejects missing, stale, and duplicate caption identities", () => {
  assert.throws(() => applyAIEditingPlan(plan([captionTextAction({ targetId: "missing" })]), context()), AIEditingPlanValidationError);
  assert.throws(() => applyAIEditingPlan(plan([captionTextAction({ targetId: "clip-a" })]), context()), AIEditingPlanValidationError);
  const duplicate = projectFixture();
  duplicate.captions.push({ ...duplicate.captions[0], text: "another" });
  assert.throws(() => applyAIEditingPlan(plan([captionTextAction()]), context(duplicate)), AIEditingPlanValidationError);
  assert.throws(() => applySetCaptionTextToProject(projectFixture(), { ...captionTextAction(), targetId: "deleted" } as never), AIEditingPlanValidationError);
});

test("SET_CAPTION_TEXT no-op preserves project identity and timestamp", () => {
  const source = projectFixture();
  source.updatedAt = "keep-this-timestamp";
  assert.equal(applySetCaptionTextToProject(source, {
    ...captionTextAction(), text: "hello",
  } as { type: "SET_CAPTION_TEXT"; targetId: string; text: string; reason: string }), source);
  const result = applyAIEditingPlan(plan([captionTextAction({ text: "hello" })]), context(source));
  assert.equal(result.project, source);
  assert.equal(result.project.updatedAt, "keep-this-timestamp");
});

test("SET_CAPTION_TEXT editor integration synchronizes project, records, preview, persistence, and SRT", () => {
  const source = projectFixture();
  source.captions = [
    { id: "caption-a", text: "OLD", startMs: 1_000, endMs: 2_000 },
    { id: "caption-b", text: "Sibling", startMs: 2_000, endMs: 3_000, needsReview: true },
  ];
  const before = cloneProject(source);
  const state = captionIntegrationState(source);
  const applied = applyCaptionPlanToIntegration(state, plan([captionTextAction({ text: "肺炎链球菌（Streptococcus pneumoniae）" })]));

  assert.notEqual(applied.project, before);
  assert.equal(state.history.length, 1);
  assert.equal(state.future.length, 0);
  assert.equal(state.project.captions[0].text, "肺炎链球菌（Streptococcus pneumoniae）");
  assert.equal(state.captionRecords[0].text, state.project.captions[0].text);
  assert.equal(state.captionRecords.find((caption) => 1_500 >= caption.startMs && 1_500 < caption.endMs)?.text,
    "肺炎链球菌（Streptococcus pneumoniae）");
  assert.deepEqual(state.project.captions[0], { ...before.captions[0], text: "肺炎链球菌（Streptococcus pneumoniae）" });
  assert.deepEqual(state.project.captions[1], before.captions[1]);
  assert.deepEqual(state.project.tracks, before.tracks);
  assert.deepEqual(state.project.audioSelection, before.audioSelection);
  assert.equal(state.project.ratio, before.ratio);
  assert.equal(state.project.durationMs, before.durationMs);
  assert.deepEqual(state.selection, { kind: "caption", id: "caption-a" });

  const persisted = parseEditorProject(JSON.stringify(state.project));
  assert.ok(persisted);
  assert.deepEqual(
    (({ id, text, startMs, endMs }) => ({ id, text, startMs, endMs }))(persisted.captions[0]),
    (({ id, text, startMs, endMs }) => ({ id, text, startMs, endMs }))(state.project.captions[0]),
  );
  assert.match(integrationSrt(state.captionRecords), /00:00:01,000 --> 00:00:02,000\n肺炎链球菌（Streptococcus pneumoniae）/);
});

test("SET_CAPTION_TEXT integration undo and redo stay synchronized without timing changes", () => {
  const source = projectFixture();
  source.captions[0] = { id: "caption-a", text: "OLD", startMs: 1_234, endMs: 4_567 };
  const state = captionIntegrationState(source);
  const timing = { startMs: 1_234, endMs: 4_567 };

  applyCaptionPlanToIntegration(state, plan([captionTextAction({ text: "Corrected English caption." })]));
  assert.deepEqual([state.project.captions[0].text, state.captionRecords[0].text], ["Corrected English caption.", "Corrected English caption."]);
  assert.deepEqual({ startMs: state.project.captions[0].startMs, endMs: state.project.captions[0].endMs }, timing);
  assert.match(integrationSrt(state.captionRecords), /Corrected English caption\./);

  undoIntegratedProject(state);
  assert.deepEqual([state.project.captions[0].text, state.captionRecords[0].text], ["OLD", "OLD"]);
  assert.deepEqual({ startMs: state.project.captions[0].startMs, endMs: state.project.captions[0].endMs }, timing);
  assert.match(integrationSrt(state.captionRecords), /\nOLD$/);

  redoIntegratedProject(state);
  assert.deepEqual([state.project.captions[0].text, state.captionRecords[0].text], ["Corrected English caption.", "Corrected English caption."]);
  assert.deepEqual({ startMs: state.project.captions[0].startMs, endMs: state.project.captions[0].endMs }, timing);
  assert.match(integrationSrt(state.captionRecords), /Corrected English caption\./);
  assert.deepEqual([state.history.length, state.future.length], [1, 0]);
});

test("SET_CAPTION_TEXT integration no-op preserves history, redo, records, and timestamp", () => {
  const state = captionIntegrationState();
  applyCaptionPlanToIntegration(state, plan([captionTextAction({ text: "NEW" })]));
  undoIntegratedProject(state);
  const before = cloneProject(state.project);
  const recordsBefore = structuredClone(state.captionRecords);
  const historyBefore = structuredClone(state.history);
  const futureBefore = structuredClone(state.future);

  const noOp = applyCaptionPlanToIntegration(state, plan([captionTextAction({ text: "hello" })]));
  assert.equal(noOp.project, state.project);
  assert.deepEqual(state.project, before);
  assert.deepEqual(state.captionRecords, recordsBefore);
  assert.deepEqual(state.history, historyBefore);
  assert.deepEqual(state.future, futureBefore);
  assert.equal(state.project.updatedAt, before.updatedAt);

  applyCaptionPlanToIntegration(state, plan([captionTextAction({ text: "BRANCH" })]));
  assert.equal(state.history.length, historyBefore.length + 1);
  assert.equal(state.future.length, 0);
});

test("SET_CAPTION_TEXT remains manually editable after AI integration", () => {
  const state = captionIntegrationState();
  applyCaptionPlanToIntegration(state, plan([captionTextAction({ text: "AI edit" })]));
  const manuallyEditedRecords = state.captionRecords.map((caption) => (
    caption.id === "caption-a" ? { ...caption, text: "Manual edit" } : caption
  ));
  state.captionRecords = manuallyEditedRecords.map((caption) => ({ ...caption }));
  state.project = { ...state.project, captions: manuallyEditedRecords.map((caption) => ({ ...caption })) };
  assert.equal(state.project.captions[0].text, "Manual edit");
  assert.equal(state.captionRecords[0].text, "Manual edit");
  assert.equal(state.project.captions[0].id, "caption-a");
  assert.deepEqual(
    { startMs: state.project.captions[0].startMs, endMs: state.project.captions[0].endMs },
    { startMs: 1_000, endMs: 2_000 },
  );
});

test("SET_CAPTION_TEXT integration rejects invalid plans atomically", () => {
  for (const invalid of [
    captionTextAction({ targetId: "missing" }),
    captionTextAction({ text: "" }),
    { type: "SET_CAPTION_TEXT", targetId: "caption-a", text: "wrong object", reason: "x", extra: true },
  ]) {
    const state = captionIntegrationState();
    const before = structuredClone(state);
    assert.throws(() => applyCaptionPlanToIntegration(state, plan([invalid])), AIEditingPlanValidationError);
    assert.deepEqual(state, before);
  }
  const duplicate = projectFixture();
  duplicate.captions.push({ ...duplicate.captions[0] });
  const state = captionIntegrationState(duplicate);
  const before = structuredClone(state);
  assert.throws(() => applyCaptionPlanToIntegration(state, plan([captionTextAction()])), AIEditingPlanValidationError);
  assert.deepEqual(state, before);
});

test("SET_CAPTION_TEXT production wiring uses one project commit and the existing derived consumers", () => {
  const studio = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  const timeline = readFileSync(new URL("./TimelineEditor.tsx", import.meta.url), "utf8");
  assert.match(studio, /applyAIEditingPlan\(\s*review\.result\.result\.data/);
  assert.match(studio, /setEditorAIUndoProject\(cloneProject\(editorProject\)\);\s*handleEditorProjectChange\(applied\.project\)/);
  assert.doesNotMatch(studio, /handleEditorProjectChange\(applied\.project\);\s*\}\s*else\s*\{\s*setEditorAIUndoProject/);
  assert.match(studio, /const syncCaptionRecordsFromProject = \(project: EditorProject\) => \{[\s\S]*project\.captions\.map[\s\S]*setCaptionRecords\(captions\)[\s\S]*setSubtitleText\(cuesToSrt\(captions\)\)/);
  assert.match(studio, /const handleEditorProjectChange = \(nextProject: EditorProject\) => \{[\s\S]*setEditorProject\(nextProject\)[\s\S]*syncCaptionRecordsFromProject\(nextProject\)/);
  assert.match(studio, /const subtitleCues = captionRecords;[\s\S]*activeSubtitleCue\?\.text/);
  assert.match(studio, /new Blob\(\[cuesToSrt\(cues\)\]/);
  assert.match(studio, /localStorage\.setItem\(storageKey, JSON\.stringify\(editorProject\)\)/);
  assert.match(studio, /const updateSubtitleCueText = \(cueId: string, text: string\) => \{[\s\S]*commitCaptionRecords\(updated\)/);
  assert.doesNotMatch(studio, /applySetCaptionTextToProject/);
  assert.match(timeline, /recordProjectUndoSnapshot\(historyRef\.current, initialUndoProject\)/);
  assert.match(timeline, /futureRef\.current = \[\]/);
  assert.match(timeline, /value=\{selectedCaption\.text\}/);
});

test("safe caption context preserves duplicate IDs/text and source ordinal/timing without project internals", () => {
  const source = projectFixture();
  source.title = "SECRET TITLE";
  source.assets[0].name = "C:\\private\\secret.mp4";
  source.captions.push({ id: "caption-b", text: "hello", startMs: 2_500, endMs: 3_500 });
  const serialized = createSafeCaptionAIContext(source);
  const parsed = JSON.parse(serialized) as { captions: Array<Record<string, unknown>> };
  assert.deepEqual(parsed.captions, [
    { id: "caption-a", text: "hello", startMs: 1_000, endMs: 2_000, ordinal: 1, eligible: true },
    { id: "caption-b", text: "hello", startMs: 2_500, endMs: 3_500, ordinal: 2, eligible: true },
  ]);
  assert.doesNotMatch(serialized, /SECRET TITLE|private|secret\.mp4|updatedAt|asset-a/);
  assert.equal(parsed.captions[0].id, "caption-a");

  source.captions.push({ ...source.captions[0], text: "ambiguous identity" });
  const duplicateIdContext = JSON.parse(createSafeCaptionAIContext(source)) as { captions: Array<{ eligible: boolean }> };
  assert.equal(duplicateIdContext.captions[0].eligible, false);
  assert.equal(duplicateIdContext.captions[2].eligible, false);

  const editorContext = JSON.parse(createSafeEditorAIContext(source, new Set(["asset-a"]), 30_000)) as {
    captions: Array<Record<string, unknown>>;
    currentClipId?: string;
  };
  assert.deepEqual(editorContext.captions, duplicateIdContext.captions);
  assert.ok(editorContext.captions.every((caption) => (
    Object.keys(caption).sort().join(",") === "eligible,endMs,id,ordinal,startMs,text"
  )));
  assert.equal(editorContext.currentClipId, undefined);
});

test("playback speed action has one strict canonical shape", () => {
  assert.deepEqual(parseAIEditingPlan(plan([speedAction()])).actions[0], speedAction());
  assert.throws(() => parseAIEditingPlan(plan([speedAction({ startSeconds: 0 })])), AIEditingPlanValidationError);
  assert.throws(() => parseAIEditingPlan(plan([speedAction({ playbackRate: "1.25" })])), AIEditingPlanValidationError);
  assert.throws(() => parseAIEditingPlan(plan([{
    type: "SET_SPEED", targetId: "clip-a", assetId: "", playbackRate: 1.25, reason: "Unknown alias.",
  }])), AIEditingPlanValidationError);
});

test("position and scale action has one strict canonical shape and rejects transform injection fields", () => {
  assert.deepEqual(parseAIEditingPlan(plan([positionScaleAction()])).actions[0], positionScaleAction());
  for (const invalid of [
    { targetId: "" }, { targetId: " clip-a " }, { assetId: "asset-a" },
    { x: "0" }, { y: "0" }, { scale: "1" }, { x: Number.NaN },
    { y: Number.POSITIVE_INFINITY }, { scale: Number.NEGATIVE_INFINITY },
    { x: -50.01 }, { x: 50.01 }, { y: -50.01 }, { y: 50.01 },
    { scale: 0.249 }, { scale: 3.001 }, { x: undefined }, { y: undefined }, { scale: undefined },
    { reason: "" }, { reason: undefined }, { rotate: 0 }, { rotation: 0 }, { scaleX: 1 }, { scaleY: 1 },
    { width: 100 }, { height: 100 }, { opacity: 0.5 }, { anchor: "center" }, { crop: 0.2 },
    { fit: "cover" }, { transform: {} }, { transform: "translate(1px, 2px)" },
    { css: "scale(2)" }, { matrix: [1, 0, 0, 1] },
  ]) {
    assert.throws(() => parseAIEditingPlan(plan([positionScaleAction(invalid)])), AIEditingPlanValidationError);
  }
  const missingX = positionScaleAction();
  delete (missingX as Record<string, unknown>).x;
  const missingY = positionScaleAction();
  delete (missingY as Record<string, unknown>).y;
  const missingScale = positionScaleAction();
  delete (missingScale as Record<string, unknown>).scale;
  const missingReason = positionScaleAction();
  delete (missingReason as Record<string, unknown>).reason;
  for (const invalid of [missingX, missingY, missingScale, missingReason]) {
    assert.throws(() => parseAIEditingPlan(plan([invalid])), AIEditingPlanValidationError);
  }
});

test("position and scale applies absolute values and preserves every unrelated project field", () => {
  const cases = [
    { x: 0, y: 0, scale: 1, label: "center" },
    { x: 25, y: -25, scale: 0.8, label: "top-right" },
    { x: -25, y: 25, scale: 1.25, label: "bottom-left" },
    { x: -50, y: 50, scale: 0.25, label: "minimum boundary" },
    { x: 50, y: -50, scale: 3, label: "maximum boundary" },
  ];
  for (const { label, ...values } of cases) {
    const source = projectFixture();
    source.tracks[0].clips[0].transform = { x: 4, y: -3, scale: 1.4, crop: 0.2, fit: "contain" };
    const before = structuredClone(source);
    const result = applyAIEditingPlan(plan([positionScaleAction(values)]), context(source));
    const target = result.project.tracks[0].clips[0];
    assert.deepEqual(target.transform, { ...before.tracks[0].clips[0].transform, ...values }, label);
    assert.deepEqual(source, before, `${label}: input project mutated`);
    assert.equal(target.id, before.tracks[0].clips[0].id);
    assert.equal(target.trackId, before.tracks[0].clips[0].trackId);
    assert.equal(target.assetId, before.tracks[0].clips[0].assetId);
    assert.equal(target.sourceInMs, before.tracks[0].clips[0].sourceInMs);
    assert.equal(target.sourceOutMs, before.tracks[0].clips[0].sourceOutMs);
    assert.equal(target.timelineStartMs, before.tracks[0].clips[0].timelineStartMs);
    assert.equal(target.timelineEndMs, before.tracks[0].clips[0].timelineEndMs);
    assert.deepEqual(target.speedCurve, before.tracks[0].clips[0].speedCurve);
    assert.deepEqual(result.project.tracks.map((track) => track.id), before.tracks.map((track) => track.id));
    assert.deepEqual(result.project.tracks[0].clips.map((clip) => clip.id), before.tracks[0].clips.map((clip) => clip.id));
    assert.deepEqual(result.project.captions, before.captions);
    assert.deepEqual(result.audioSelection, before.audioSelection);
    assert.deepEqual(result.project.tracks.slice(1), before.tracks.slice(1));
    assert.equal(result.project.ratio, before.ratio);
    assert.equal(result.project.durationMs, before.durationMs);
    assert.equal(result.project.updatedAt, context(source).nowIso);
  }
});

test("position and scale exact no-op returns the existing project without timestamp mutation", () => {
  const source = projectFixture();
  source.updatedAt = "2026-10-16T00:00:00.000Z";
  const result = applyAIEditingPlan(plan([positionScaleAction()]), context(source));
  assert.equal(result.project, source);
  assert.equal(result.project.updatedAt, source.updatedAt);
  assert.deepEqual(result.project, source);
  assert.equal(result.applied.length, 1);
});

test("AI transform mutation uses one undo boundary and no-op creates none", () => {
  const before = projectFixture();
  const changed = applyAIEditingPlan(plan([positionScaleAction({ x: 25, y: -25, scale: 0.8 })]), context(before)).project;
  assert.notEqual(changed, before);
  const undo = recordProjectUndoSnapshot([], before);
  const history = [...undo];
  const future: EditorProject[] = [cloneProject(changed)];
  const restored = history.pop()!;
  const changedSnapshot = future.pop()!;
  assert.deepEqual(restored.tracks[0].clips[0].transform, before.tracks[0].clips[0].transform);
  assert.deepEqual(changedSnapshot.tracks[0].clips[0].transform, { x: 25, y: -25, scale: 0.8, crop: 0, fit: "cover" });

  const noOp = applyAIEditingPlan(plan([positionScaleAction()]), context(before)).project;
  assert.equal(noOp, before);
  const noOpUndo = noOp === before ? [] : recordProjectUndoSnapshot([], before);
  assert.equal(noOpUndo.length, 0);
});

test("position and scale validates unique owned visual targets and rejects unsafe action conflicts", () => {
  for (const targetId of ["unknown", "invented", ""]) {
    assert.throws(() => applyAIEditingPlan(plan([positionScaleAction({ targetId })]), context()), AIEditingPlanValidationError);
  }
  const duplicate = projectFixture();
  duplicate.tracks[0].clips.push(structuredClone(duplicate.tracks[0].clips[0]));
  assert.throws(() => applyAIEditingPlan(plan([positionScaleAction()]), context(duplicate)), AIEditingPlanValidationError);
  assert.throws(() => applyAIEditingPlan(plan([positionScaleAction()]), {
    ...context(), ownedAssetIds: new Set(["asset-b"]),
  }), AIEditingPlanValidationError);
  const missingAsset = projectFixture();
  missingAsset.tracks[0].clips[0].assetId = "missing-asset";
  assert.throws(() => applyAIEditingPlan(plan([positionScaleAction()]), context(missingAsset)), AIEditingPlanValidationError);
  const mismatchedAsset = projectFixture();
  mismatchedAsset.assets[0].kind = "not-the-clip-kind" as typeof mismatchedAsset.assets[0]["kind"];
  assert.throws(() => applyAIEditingPlan(plan([positionScaleAction()]), context(mismatchedAsset)), AIEditingPlanValidationError);
  const duplicateAsset = projectFixture();
  duplicateAsset.assets.push(structuredClone(duplicateAsset.assets[0]));
  assert.throws(() => applyAIEditingPlan(plan([positionScaleAction()]), context(duplicateAsset)), AIEditingPlanValidationError);
  const audioTrack = projectFixture();
  const [audioTarget] = audioTrack.tracks[0].clips.splice(0, 1);
  audioTarget.trackId = "audio-main";
  audioTrack.tracks[1].clips.push(audioTarget);
  assert.throws(() => applyAIEditingPlan(plan([positionScaleAction()]), context(audioTrack)), AIEditingPlanValidationError);
  const remove = action({ type: "REMOVE_CLIP", startSeconds: 0, endSeconds: 0 });
  assert.throws(() => applyAIEditingPlan(plan([remove, positionScaleAction({ x: 10 })]), context()), AIEditingPlanValidationError);
  assert.throws(() => applyAIEditingPlan(plan([splitAction(), positionScaleAction({ x: 10 })]), context()), AIEditingPlanValidationError);
  assert.throws(() => applyAIEditingPlan(plan([
    positionScaleAction({ x: 10 }), positionScaleAction({ x: 20 }),
  ]), context()), AIEditingPlanValidationError);
});

test("playback speed applies 1.25x through the official speed curve without changing other clips", () => {
  const source = projectFixture();
  const secondBefore = structuredClone(source.tracks[0].clips[1]);
  const captionsBefore = structuredClone(source.captions);
  const result = applyAIEditingPlan(plan([speedAction()]), context(source));
  const target = result.project.tracks[0].clips[0];
  assert.equal(averageSpeed(target.speedCurve), 1.25);
  assert.equal(target.timelineStartMs, 0);
  assert.equal(target.timelineEndMs, 8_000);
  assert.equal(sourceTimeAtTimelineMs(target, 4_000), 5_000);
  assert.deepEqual(result.project.tracks[0].clips[1], secondBefore);
  assert.deepEqual(result.project.captions, captionsBefore);
  assert.equal(averageSpeed(source.tracks[0].clips[0].speedCurve), 1);
});

test("playback speed accepts inclusive 0.25x and 4x boundaries", () => {
  const slow = applyAIEditingPlan(plan([speedAction({ playbackRate: 0.25 })]), context());
  assert.equal(averageSpeed(slow.project.tracks[0].clips[0].speedCurve), 0.25);
  assert.equal(slow.project.tracks[0].clips[0].timelineEndMs, 40_000);
  const fast = applyAIEditingPlan(plan([speedAction({ playbackRate: 4 })]), context());
  assert.equal(averageSpeed(fast.project.tracks[0].clips[0].speedCurve), 4);
  assert.equal(fast.project.tracks[0].clips[0].timelineEndMs, 2_500);
});

test("playback speed rejects non-finite and out-of-range values without mutation", () => {
  for (const playbackRate of [0.24, 4.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const source = projectFixture();
    assert.throws(
      () => applyAIEditingPlan(plan([speedAction({ playbackRate })]), context(source)),
      AIEditingPlanValidationError,
    );
    assert.equal(averageSpeed(source.tracks[0].clips[0].speedCurve), 1);
    assert.equal(source.tracks[0].clips[0].timelineEndMs, 10_000);
  }
});

test("playback speed independently enforces target, media kind, and owner boundary", () => {
  assert.throws(
    () => applyAIEditingPlan(plan([speedAction({ targetId: "invented-clip" })]), context()),
    AIEditingPlanValidationError,
  );
  assert.throws(
    () => applyAIEditingPlan(plan([speedAction()]), { ...context(), ownedAssetIds: new Set(["asset-b"]) }),
    AIEditingPlanValidationError,
  );
  const imageProject = projectFixture();
  imageProject.assets[0].kind = "图片";
  imageProject.tracks[0].clips[0].kind = "图片";
  assert.throws(
    () => applyAIEditingPlan(plan([speedAction()]), context(imageProject)),
    AIEditingPlanValidationError,
  );
});

test("trim plus playback speed is deterministic and invalid mixed plans are atomic", () => {
  const source = projectFixture();
  const result = applyAIEditingPlan(plan([action(), speedAction()]), context(source));
  const target = result.project.tracks[0].clips[0];
  assert.equal(target.sourceInMs, 5_000);
  assert.equal(target.sourceOutMs, 10_000);
  assert.equal(target.timelineStartMs, 5_000);
  assert.equal(target.timelineEndMs, 9_000);
  assert.equal(averageSpeed(target.speedCurve), 1.25);
  assert.equal(result.applied.length, 2);

  assert.throws(
    () => applyAIEditingPlan(plan([action(), speedAction({ playbackRate: 4.01 })]), context(source)),
    AIEditingPlanValidationError,
  );
  assert.equal(source.tracks[0].clips[0].timelineStartMs, 0);
  assert.equal(averageSpeed(source.tracks[0].clips[0].speedCurve), 1);
});

test("playback speed result supports the existing snapshot undo and redo semantics", () => {
  const before = projectFixture();
  const after = applyAIEditingPlan(plan([speedAction()]), context(before)).project;
  const history = [cloneProject(before)];
  const future: EditorProject[] = [];
  future.push(cloneProject(after));
  const undone = history.pop()!;
  assert.equal(averageSpeed(undone.tracks[0].clips[0].speedCurve), 1);
  const redone = future.pop()!;
  assert.equal(averageSpeed(redone.tracks[0].clips[0].speedCurve), 1.25);
});

test("split action has one strict canonical shape and forbids AI-generated child IDs", () => {
  assert.deepEqual(parseAIEditingPlan(plan([splitAction()])).actions[0], splitAction());
  for (const extra of [
    { leftClipId: "ai-left" }, { rightClipId: "ai-right" }, { newClipId: "ai-new" },
    { startSeconds: 0 }, { endSeconds: 6 },
  ]) {
    assert.throws(() => parseAIEditingPlan(plan([splitAction(extra)])), AIEditingPlanValidationError);
  }
  assert.throws(() => parseAIEditingPlan(plan([splitAction({ splitAtSeconds: "6" })])), AIEditingPlanValidationError);
});

test("split applies at clip-local timeline seconds with deterministic IDs and preserved state", () => {
  const source = projectFixture();
  source.tracks[0].clips[0].transform = { x: 0.2, y: -0.1, scale: 1.3, crop: 0.1, fit: "contain" };
  source.tracks[0].clips[0].reason = "original";
  const secondBefore = structuredClone(source.tracks[0].clips[1]);
  const captionsBefore = structuredClone(source.captions);
  const audioBefore = structuredClone(source.audioSelection);
  const result = applyAIEditingPlan(plan([splitAction()]), context(source));
  const clips = result.project.tracks[0].clips;
  assert.equal(clips.length, 3);
  assert.deepEqual(clips.map((clip) => clip.id), ["clip-left", "clip-right", "clip-b"]);
  assert.deepEqual([clips[0].timelineStartMs, clips[0].timelineEndMs], [0, 6_000]);
  assert.deepEqual([clips[1].timelineStartMs, clips[1].timelineEndMs], [6_000, 10_000]);
  assert.deepEqual([clips[0].sourceInMs, clips[0].sourceOutMs], [0, 6_000]);
  assert.deepEqual([clips[1].sourceInMs, clips[1].sourceOutMs], [6_000, 10_000]);
  assert.equal(clips[0].assetId, "asset-a");
  assert.equal(clips[1].assetId, "asset-a");
  assert.deepEqual(clips[0].transform, source.tracks[0].clips[0].transform);
  assert.deepEqual(clips[1].transform, source.tracks[0].clips[0].transform);
  assert.deepEqual(clips[2], secondBefore);
  assert.deepEqual(result.project.captions, captionsBefore);
  assert.deepEqual(result.audioSelection, audioBefore);
  assert.equal(source.tracks[0].clips.length, 2);

  const offsetSource = projectFixture();
  const offset = applyAIEditingPlan(
    plan([splitAction({ targetId: "clip-b", splitAtSeconds: 6 })]),
    context(offsetSource, ["offset-left", "offset-right"]),
  );
  assert.deepEqual(
    offset.project.tracks[0].clips.slice(1).map((clip) => [clip.timelineStartMs, clip.timelineEndMs]),
    [[10_000, 16_000], [16_000, 20_000]],
  );
});

test("split rejects invalid positions, targets, media kind, owner boundary, raw URLs, and aliases atomically", () => {
  for (const splitAtSeconds of [0, -1, 0.099, 9.901, 10, 11, Number.NaN, Number.POSITIVE_INFINITY]) {
    const source = projectFixture();
    assert.throws(
      () => applyAIEditingPlan(plan([splitAction({ splitAtSeconds })]), context(source)),
      AIEditingPlanValidationError,
    );
    assert.deepEqual(source.tracks[0].clips.map((clip) => clip.id), ["clip-a", "clip-b"]);
  }
  for (const targetId of ["clip-unknown", "invented-clip", "https://example.invalid/video.mp4"]) {
    assert.throws(() => applyAIEditingPlan(plan([splitAction({ targetId })]), context()), AIEditingPlanValidationError);
  }
  assert.throws(
    () => applyAIEditingPlan(plan([splitAction()]), { ...context(), ownedAssetIds: new Set(["asset-b"]) }),
    AIEditingPlanValidationError,
  );
  const imageProject = projectFixture();
  imageProject.assets[0].kind = "图片";
  imageProject.tracks[0].clips[0].kind = "图片";
  assert.throws(() => applyAIEditingPlan(plan([splitAction()]), context(imageProject)), AIEditingPlanValidationError);
  for (const type of ["CUT_CLIP", "SPLIT_VIDEO", "DIVIDE_CLIP"]) {
    assert.throws(() => parseAIEditingPlan(plan([splitAction({ type })])), AIEditingPlanValidationError);
  }
});

test("split accepts the exact 100ms child boundary and rejects one millisecond inside it", () => {
  for (const splitAtSeconds of [0.1, 9.9]) {
    const result = applyAIEditingPlan(
      plan([splitAction({ splitAtSeconds })]),
      context(projectFixture(), ["boundary-left", "boundary-right"]),
    );
    const children = result.project.tracks[0].clips.slice(0, 2);
    assert.ok(children[0].timelineEndMs - children[0].timelineStartMs >= 100);
    assert.ok(children[1].timelineEndMs - children[1].timelineStartMs >= 100);
  }
  for (const splitAtSeconds of [0.099, 9.901]) {
    assert.throws(
      () => applyAIEditingPlan(plan([splitAction({ splitAtSeconds })]), context()),
      AIEditingPlanValidationError,
    );
  }
});

test("speed-adjusted and mixed speed-plus-split plans use official timeline/source mapping", () => {
  const adjusted = projectFixture();
  adjusted.tracks[0].clips[0].timelineEndMs = 5_000;
  adjusted.tracks[0].clips[0].sourceOutMs = 10_000;
  adjusted.tracks[0].clips[0].speedCurve = [
    { id: "start", at: 0, rate: 2 }, { id: "end", at: 1, rate: 2 },
  ];
  const splitAdjusted = applyAIEditingPlan(plan([splitAction({ splitAtSeconds: 3 })]), context(adjusted));
  const adjustedChildren = splitAdjusted.project.tracks[0].clips.slice(0, 2);
  assert.deepEqual(adjustedChildren.map((clip) => [clip.timelineStartMs, clip.timelineEndMs]), [[0, 3_000], [3_000, 5_000]]);
  assert.deepEqual(adjustedChildren.map((clip) => [clip.sourceInMs, clip.sourceOutMs]), [[0, 6_000], [6_000, 10_000]]);
  assert.deepEqual(adjustedChildren.map((clip) => averageSpeed(clip.speedCurve)), [2, 2]);

  const mixed = applyAIEditingPlan(
    plan([speedAction({ playbackRate: 2 }), splitAction({ splitAtSeconds: 3 })]),
    context(),
  );
  const mixedChildren = mixed.project.tracks[0].clips.slice(0, 2);
  assert.deepEqual(mixedChildren.map((clip) => [clip.timelineStartMs, clip.timelineEndMs]), [[0, 3_000], [3_000, 5_000]]);
  assert.deepEqual(mixedChildren.map((clip) => [clip.sourceInMs, clip.sourceOutMs]), [[0, 6_000], [6_000, 10_000]]);
  assert.deepEqual(mixedChildren.map((clip) => averageSpeed(clip.speedCurve)), [2, 2]);

  const source = projectFixture();
  assert.throws(
    () => applyAIEditingPlan(
      plan([speedAction({ playbackRate: 4 }), splitAction({ splitAtSeconds: 3 })]),
      context(source),
    ),
    AIEditingPlanValidationError,
  );
  assert.equal(source.tracks[0].clips.length, 2);
  assert.equal(averageSpeed(source.tracks[0].clips[0].speedCurve), 1);
});

test("split result supports snapshot undo/redo and official preview/export clip state", () => {
  const before = projectFixture();
  const after = applyAIEditingPlan(plan([splitAction()]), context(before)).project;
  const history = [cloneProject(before)];
  const future = [cloneProject(after)];
  assert.equal(history.pop()!.tracks[0].clips.length, 2);
  const redone = future.pop()!;
  assert.equal(redone.tracks[0].clips.length, 3);
  const [left, right] = redone.tracks[0].clips;
  assert.equal(sourceTimeAtTimelineMs(left, left.timelineEndMs), left.sourceOutMs);
  assert.equal(sourceTimeAtTimelineMs(right, right.timelineStartMs), right.sourceInMs);
  assert.equal(left.timelineEndMs, right.timelineStartMs);
  assert.equal(left.sourceOutMs, right.sourceInMs);
});

test("reorder action has one strict canonical shape and rejects aliases or invalid placement", () => {
  assert.deepEqual(parseAIEditingPlan(plan([reorderAction()])).actions[0], reorderAction());
  for (const type of ["MOVE_CLIP", "REPOSITION_CLIP", "CHANGE_CLIP_ORDER", "SORT_CLIP"]) {
    assert.throws(() => parseAIEditingPlan(plan([reorderAction({ type })])), AIEditingPlanValidationError);
  }
  for (const placement of ["before", "LEFT", "RIGHT", "START", "END"]) {
    assert.throws(() => parseAIEditingPlan(plan([reorderAction({ placement })])), AIEditingPlanValidationError);
  }
  for (const extra of [{ targetIndex: 2 }, { destinationIndex: 0 }, { startSeconds: 0 }]) {
    assert.throws(() => parseAIEditingPlan(plan([reorderAction(extra)])), AIEditingPlanValidationError);
  }
});

test("reorder applies BEFORE and AFTER with official contiguous timeline semantics", () => {
  const cBeforeA = applyAIEditingPlan(plan([reorderAction()]), context(threeClipProject()));
  assert.deepEqual(cBeforeA.project.tracks[0].clips.map((clip) => clip.id), ["clip-c", "clip-a", "clip-b"]);
  assert.deepEqual(
    cBeforeA.project.tracks[0].clips.map((clip) => [clip.timelineStartMs, clip.timelineEndMs]),
    [[0, 10_000], [10_000, 20_000], [20_000, 30_000]],
  );

  const aAfterC = applyAIEditingPlan(plan([reorderAction({
    targetId: "clip-a", referenceId: "clip-c", placement: "AFTER",
  })]), context(threeClipProject()));
  assert.deepEqual(aAfterC.project.tracks[0].clips.map((clip) => clip.id), ["clip-b", "clip-c", "clip-a"]);

  const four = threeClipProject();
  four.durationMs = 40_000;
  four.tracks[0].clips.push({
    ...structuredClone(four.tracks[0].clips[2]), id: "clip-d", name: "D",
    timelineStartMs: 30_000, timelineEndMs: 40_000,
  });
  const bAfterC = applyAIEditingPlan(plan([reorderAction({
    targetId: "clip-b", referenceId: "clip-c", placement: "AFTER",
  })]), context(four));
  assert.deepEqual(bAfterC.project.tracks[0].clips.map((clip) => clip.id), ["clip-a", "clip-c", "clip-b", "clip-d"]);

  const already = threeClipProject();
  const alreadyResult = applyAIEditingPlan(plan([reorderAction({
    targetId: "clip-b", referenceId: "clip-c", placement: "BEFORE",
  })]), context(already));
  assert.deepEqual(alreadyResult.project.tracks, already.tracks);
});

test("reorder preserves clip identity, source, duration, speed, transforms, assets, captions, and audio", () => {
  const source = threeClipProject();
  source.tracks[0].clips[0].transform = { x: 0.2, y: -0.1, scale: 1.4, crop: 0.2, fit: "contain" };
  source.tracks[0].clips[1].speedCurve = [{ id: "start", at: 0, rate: 2 }, { id: "end", at: 1, rate: 2 }];
  source.tracks[0].clips[1].timelineEndMs = 15_000;
  source.tracks[0].clips[2].timelineStartMs = 15_000;
  const before = structuredClone(source);
  const result = applyAIEditingPlan(plan([reorderAction()]), context(source));
  assert.deepEqual(result.project.tracks[0].clips.map((clip) => clip.id), ["clip-c", "clip-a", "clip-b"]);
  assert.equal(new Set(result.project.tracks[0].clips.map((clip) => clip.id)).size, 3);
  for (const clip of before.tracks[0].clips) {
    const moved = result.project.tracks[0].clips.find((candidate) => candidate.id === clip.id)!;
    assert.equal(moved.sourceInMs, clip.sourceInMs);
    assert.equal(moved.sourceOutMs, clip.sourceOutMs);
    assert.equal(moved.timelineEndMs - moved.timelineStartMs, clip.timelineEndMs - clip.timelineStartMs);
    assert.deepEqual(moved.speedCurve, clip.speedCurve);
    assert.deepEqual(moved.transform, clip.transform);
    assert.equal(moved.assetId, clip.assetId);
  }
  assert.deepEqual(result.project.captions, before.captions);
  assert.deepEqual(result.audioSelection, before.audioSelection);
  assert.deepEqual(source, before);
});

test("reorder validates both owned same-track clips and rejects self, unknown, URL, split-child guesses, or removal", () => {
  for (const overrides of [
    { targetId: "clip-unknown" },
    { targetId: "https://example.invalid/video.mp4" },
    { referenceId: "clip-unknown" },
    { referenceId: "https://example.invalid/video.mp4" },
    { targetId: "clip-a", referenceId: "clip-a" },
  ]) {
    assert.throws(() => applyAIEditingPlan(plan([reorderAction(overrides)]), context(threeClipProject())), AIEditingPlanValidationError);
  }
  assert.throws(
    () => applyAIEditingPlan(plan([reorderAction()]), { ...context(threeClipProject()), ownedAssetIds: new Set(["asset-a"]) }),
    AIEditingPlanValidationError,
  );
  const otherTrack = threeClipProject();
  const [clipC] = otherTrack.tracks[0].clips.splice(2, 1);
  clipC.trackId = "broll";
  otherTrack.tracks.push({ id: "broll", type: "broll", name: "broll", clips: [clipC] });
  assert.throws(() => applyAIEditingPlan(plan([reorderAction()]), context(otherTrack)), AIEditingPlanValidationError);
  assert.throws(() => applyAIEditingPlan(plan([
    splitAction(), reorderAction({ targetId: "clip-a", referenceId: "clip-b" }),
  ]), context(threeClipProject())), AIEditingPlanValidationError);
  assert.throws(() => applyAIEditingPlan(plan([
    action({ type: "REMOVE_CLIP", targetId: "clip-a", startSeconds: 0, endSeconds: 0 }),
    reorderAction({ targetId: "clip-b", referenceId: "clip-a" }),
  ]), context(threeClipProject())), AIEditingPlanValidationError);
});

test("speed plus reorder is deterministic and a split child can be reordered only after its real ID exists", () => {
  const mixed = applyAIEditingPlan(plan([
    speedAction({ targetId: "clip-b", playbackRate: 2 }),
    reorderAction({ targetId: "clip-b", referenceId: "clip-a", placement: "BEFORE" }),
  ]), context(threeClipProject()));
  assert.deepEqual(mixed.project.tracks[0].clips.map((clip) => clip.id), ["clip-b", "clip-a", "clip-c"]);
  assert.equal(averageSpeed(mixed.project.tracks[0].clips[0].speedCurve), 2);
  assert.equal(mixed.project.tracks[0].clips[0].timelineEndMs - mixed.project.tracks[0].clips[0].timelineStartMs, 5_000);

  const split = applyAIEditingPlan(plan([splitAction()]), context(threeClipProject(), ["actual-left", "actual-right"]));
  const reordered = applyAIEditingPlan(plan([reorderAction({
    targetId: "actual-right", referenceId: "clip-b", placement: "AFTER",
  })]), context(split.project));
  assert.deepEqual(
    reordered.project.tracks[0].clips.map((clip) => clip.id),
    ["actual-left", "clip-b", "actual-right", "clip-c"],
  );
  assert.throws(() => applyAIEditingPlan(plan([reorderAction({
    targetId: "future-right", referenceId: "clip-b", placement: "AFTER",
  })]), context(threeClipProject())), AIEditingPlanValidationError);
});

test("reorder supports snapshot undo/redo and official preview/export ordering", () => {
  const before = threeClipProject();
  const after = applyAIEditingPlan(plan([reorderAction()]), context(before)).project;
  const history = [cloneProject(before)];
  const future = [cloneProject(after)];
  assert.deepEqual(history.pop()!.tracks[0].clips.map((clip) => clip.id), ["clip-a", "clip-b", "clip-c"]);
  const redone = future.pop()!;
  const previewAndExportOrder = redone.tracks
    .flatMap((track) => track.clips)
    .sort((left, right) => left.timelineStartMs - right.timelineStartMs)
    .map((clip) => clip.id);
  assert.deepEqual(previewAndExportOrder, ["clip-c", "clip-a", "clip-b"]);
});

test("trim and remove apply deterministically without mutating the source", () => {
  const source = projectFixture();
  const result = applyAIEditingPlan(plan([
    action(),
    action({ type: "REMOVE_CLIP", targetId: "clip-b", startSeconds: 0, endSeconds: 0 }),
  ]), context(source));
  const clips = result.project.tracks[0].clips;
  assert.equal(clips.length, 1);
  assert.equal(clips[0].timelineStartMs, 5_000);
  assert.equal(clips[0].sourceInMs, 5_000);
  assert.equal(source.tracks[0].clips.length, 2);
  assert.equal(source.tracks[0].clips[0].timelineStartMs, 0);
});

test("background audio range is bounded and subtitle timing remains unchanged", () => {
  const source = projectFixture();
  const result = applyAIEditingPlan(plan([action({
    type: "SET_BACKGROUND_AUDIO_RANGE", targetId: "audio-main", startSeconds: 10, endSeconds: 25,
  })]), context(source));
  assert.deepEqual(result.audioSelection, {
    mode: "range", sourceDurationMs: 30_000, sourceInMs: 10_000, sourceOutMs: 25_000, selectedDurationMs: 15_000,
  });
  assert.deepEqual(result.project.captions, source.captions);
});

test("material matching only accepts an owned asset and exact segment", () => {
  const result = applyAIEditingPlan(plan([action({
    type: "MATCH_ASSET_TO_SEGMENT", targetId: "clip-a", assetId: "asset-b", startSeconds: 0, endSeconds: 10,
  })]), context());
  assert.equal(result.project.tracks[0].clips[0].assetId, "asset-b");
  assert.throws(() => applyAIEditingPlan(plan([action({
    type: "MATCH_ASSET_TO_SEGMENT", targetId: "clip-a", assetId: "other-users-asset", startSeconds: 0, endSeconds: 10,
  })]), context()), AIEditingPlanValidationError);
});

test("out-of-bounds timestamps reject the whole plan atomically", () => {
  const source = projectFixture();
  assert.throws(() => applyAIEditingPlan(plan([
    action(), action({ targetId: "clip-b", startSeconds: 10, endSeconds: 21 }),
  ]), context(source)), AIEditingPlanValidationError);
  assert.equal(source.tracks[0].clips[0].timelineStartMs, 0);
  assert.equal(source.tracks[0].clips[1].timelineEndMs, 20_000);
});

test("sub-millisecond ranges and conflicting actions on one clip are rejected", () => {
  assert.throws(() => applyAIEditingPlan(plan([action({
    type: "SET_BACKGROUND_AUDIO_RANGE", targetId: "audio-main", startSeconds: 1, endSeconds: 1.00001,
  })]), context()), AIEditingPlanValidationError);
  assert.throws(() => applyAIEditingPlan(plan([
    action(),
    action({ type: "REMOVE_CLIP", targetId: "clip-a", startSeconds: 0, endSeconds: 0 }),
  ]), context()), AIEditingPlanValidationError);
});

test("unknown actions are reported and never executed", () => {
  const result = applyAIEditingPlan(plan([action({ type: "PUBLISH_VIDEO" })]), context());
  assert.equal(result.applied.length, 0);
  assert.equal(result.unsupported.length, 1);
  assert.match(result.unsupported[0].reason, /PUBLISH_VIDEO/);
  assert.equal(result.project.tracks[0].clips.length, 2);
});

test("mixed supported and unsupported actions apply only the allowlist", () => {
  const result = applyAIEditingPlan(plan(
    [action(), action({ type: "ANIME_STYLE" })],
    [{ request: "Lower background music volume", reason: "Volume automation is not supported." }],
  ), context());
  assert.equal(result.applied.length, 1);
  assert.equal(result.unsupported.length, 2);
  assert.equal(result.project.tracks[0].clips[0].timelineStartMs, 5_000);
});

test("safe context has allowlisted assets, no URL, and the subtitle invariant", () => {
  const serialized = createSafeEditorAIContext(projectFixture(), new Set(["asset-a"]), 30_000);
  const value = JSON.parse(serialized) as Record<string, unknown>;
  assert.equal(serialized.includes("http"), false);
  assert.deepEqual((value.assets as Array<{ id: string }>).map((asset) => asset.id), ["asset-a"]);
  assert.equal(value.subtitleTimingInvariant, "AUDIO_TIMING_ONLY");
  assert.equal((value.clips as Array<{ playbackRate: number }>)[0].playbackRate, 1);
  assert.equal((value.clips as Array<{ timelineDurationSeconds: number }>)[0].timelineDurationSeconds, 10);
  assert.deepEqual(value.supportedActions, [
    "TRIM_CLIP", "REMOVE_CLIP", "SET_BACKGROUND_AUDIO_RANGE", "MATCH_ASSET_TO_SEGMENT", "SET_CLIP_PLAYBACK_SPEED", "SPLIT_CLIP", "REORDER_CLIP", "SET_CLIP_POSITION_SCALE", "SET_CAPTION_TEXT",
  ]);
});

test("safe transform context exposes ordered visual transforms and only a trusted active clip id", () => {
  const project = projectFixture();
  project.tracks[0].clips[0].transform = { x: 12, y: -7, scale: 1.25, crop: 9, fit: "contain" };
  const active = JSON.parse(createSafeEditorAIContext(project, new Set(["asset-a"]), 30_000, "clip-a")) as {
    currentClipId?: string;
    clips: Array<Record<string, unknown>>;
  };
  assert.equal(active.currentClipId, "clip-a");
  assert.equal(active.clips[0].positionScaleEligible, true);
  assert.deepEqual(
    [active.clips[0].id, active.clips[0].x, active.clips[0].y, active.clips[0].scale],
    ["clip-a", 12, -7, 1.25],
  );
  assert.equal("crop" in active.clips[0], false);
  assert.equal("fit" in active.clips[0], false);

  const untrustedActive = JSON.parse(createSafeEditorAIContext(project, new Set(["asset-a"]), 30_000, "invented-clip")) as {
    currentClipId?: string;
  };
  assert.equal("currentClipId" in untrustedActive, false);
});

test("safe context ordinal order follows visible timeline order rather than stored array order", () => {
  const project = threeClipProject();
  project.tracks[0].clips = [project.tracks[0].clips[2], project.tracks[0].clips[0], project.tracks[0].clips[1]];
  const value = JSON.parse(createSafeEditorAIContext(
    project,
    new Set(["asset-a", "asset-b"]),
    30_000,
  )) as { clips: Array<{ id: string }> };
  assert.deepEqual(value.clips.map((clip) => clip.id), ["clip-a", "clip-b", "clip-c"]);
});

test("ambiguous plans request clarification without timeline mutation", () => {
  const source = projectFixture();
  const result = applyAIEditingPlan(plan([], [{ request: "Make this better", reason: "Specify a time range and target." }]), context(source));
  assert.equal(result.applied.length, 0);
  assert.equal(result.unsupported.length, 1);
  assert.deepEqual(result.project.tracks, source.tracks);
});
