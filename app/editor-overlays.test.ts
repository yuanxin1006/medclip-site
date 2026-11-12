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
  MIN_OVERLAY_SIZE,
  createOverlay,
  drawEditorOverlaysAt,
  normalizeOverlay,
  overlaysVisibleAt,
  patchOverlay,
  validateOverlay,
  type EditorOverlay,
  type OverlayCanvasContext,
} from "./editor-overlays.ts";

const project = (overlays: EditorOverlay[] = []): EditorProject => ({
  schemaVersion: 2,
  id: "project-overlay-test",
  title: "Overlay test",
  updatedAt: "2026-10-31T00:00:00.000Z",
  durationMs: 10_000,
  ratio: "16:9",
  audioSelection: createFullAudioSelection(10_000),
  assets: [],
  tracks: [],
  captions: [],
  overlays,
});

test("V2.6A creates bounded text overlays without requiring non-empty text", () => {
  const overlay = createOverlay("text", { id: "text-1", atMs: 2_000, projectDurationMs: 10_000 });
  assert.equal(overlay.type, "text");
  assert.deepEqual([overlay.startMs, overlay.endMs], [2_000, 5_000]);
  assert.equal(validateOverlay(overlay, 10_000).valid, true);
  if (overlay.type !== "text") assert.fail("expected text overlay");
  const empty = patchOverlay(overlay, { text: "" }, 10_000);
  assert.equal(empty.type, "text");
  assert.equal(empty.type === "text" ? empty.text : "unexpected", "");
  assert.equal(validateOverlay(empty, 10_000).valid, true);
});

test("V2.6A creates arrow, rectangle, and circle from one overlay model", () => {
  const types = ["arrow", "rectangle", "circle"] as const;
  for (const type of types) {
    const overlay = createOverlay(type, { id: `${type}-1`, atMs: 9_900, projectDurationMs: 10_000 });
    assert.equal(overlay.type, type);
    assert.equal(overlay.endMs, 10_000);
    assert.ok(overlay.endMs > overlay.startMs);
    assert.equal(validateOverlay(overlay, 10_000).valid, true);
  }
});

test("V2.6A clamps move and resize geometry to finite canvas bounds", () => {
  const original = createOverlay("rectangle", { id: "rect-1", atMs: 0, projectDurationMs: 10_000 });
  const moved = patchOverlay(original, { x: Number.NaN, y: -4 }, 10_000);
  assert.equal(Number.isFinite(moved.x), true);
  assert.equal(moved.y, 0);
  const resized = patchOverlay(moved, { x: 0.98, y: 0.99, width: -8, height: 4 }, 10_000);
  assert.equal(resized.width, MIN_OVERLAY_SIZE);
  assert.equal(resized.height, 1);
  assert.equal(resized.x + resized.width <= 1, true);
  assert.equal(resized.y + resized.height <= 1, true);
  assert.equal(validateOverlay(resized, 10_000).valid, true);
});

test("V2.6A clamps time ranges to start >= 0, end > start, and project duration", () => {
  const original = createOverlay("circle", { id: "circle-1", atMs: 0, projectDurationMs: 10_000 });
  const normalized = normalizeOverlay({ ...original, startMs: -500, endMs: 50_000 }, 10_000);
  assert.deepEqual([normalized.startMs, normalized.endMs], [0, 10_000]);
  const collapsed = patchOverlay(normalized, { startMs: 9_999, endMs: 1 }, 10_000);
  assert.equal(collapsed.startMs, 9_950);
  assert.equal(collapsed.endMs, 10_000);
  assert.equal(validateOverlay(collapsed, 10_000).valid, true);
  assert.equal(validateOverlay(collapsed, Number.NaN).valid, false);
});

test("V2.6A delete participates in the existing project snapshot history", () => {
  const overlay = createOverlay("arrow", { id: "arrow-delete", atMs: 0, projectDurationMs: 10_000 });
  const before = project([overlay]);
  const history = recordProjectUndoSnapshot([], before);
  const after = cloneProject(before);
  after.overlays = after.overlays?.filter((item) => item.id !== overlay.id);
  assert.deepEqual(after.overlays, []);
  const undone = history.pop();
  assert.equal(undone?.overlays?.[0]?.id, "arrow-delete");
  const future = [cloneProject(after)];
  assert.deepEqual(future.pop()?.overlays, []);
});

test("V2.6A visibility is start-inclusive and end-exclusive", () => {
  const overlay = createOverlay("text", { id: "visible-text", atMs: 2_000, projectDurationMs: 10_000 });
  assert.deepEqual(overlaysVisibleAt([overlay], 1_999), []);
  assert.equal(overlaysVisibleAt([overlay], 2_000)[0]?.id, overlay.id);
  assert.equal(overlaysVisibleAt([overlay], 4_999)[0]?.id, overlay.id);
  assert.deepEqual(overlaysVisibleAt([overlay], 5_000), []);
});

test("V2.6A canvas renderer draws every overlay type only in its visible range", () => {
  const calls: string[] = [];
  const context = {
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    beginPath: () => calls.push("beginPath"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    stroke: () => calls.push("stroke"),
    strokeRect: () => calls.push("strokeRect"),
    ellipse: () => calls.push("ellipse"),
    fillText: () => calls.push("fillText"),
    strokeText: () => calls.push("strokeText"),
  } as unknown as OverlayCanvasContext;
  const overlays = (["text", "arrow", "rectangle", "circle"] as const).map((type) => (
    createOverlay(type, { id: type, atMs: 0, projectDurationMs: 10_000 })
  ));
  assert.equal(drawEditorOverlaysAt(context, overlays, 1_000, 1_920, 1_080), 4);
  assert.ok(calls.includes("fillText"));
  assert.ok(calls.includes("lineTo"));
  assert.ok(calls.includes("strokeRect"));
  assert.ok(calls.includes("ellipse"));
  const before = calls.length;
  assert.equal(drawEditorOverlaysAt(context, overlays, 9_000, 1_920, 1_080), 0);
  assert.equal(calls.length, before);
});

test("V2.6A saved projects default missing overlays and preserve overlay records", () => {
  const legacy = project();
  delete legacy.overlays;
  assert.deepEqual(parseEditorProject(JSON.stringify(legacy))?.overlays, []);
  const overlay = createOverlay("circle", { id: "saved-circle", atMs: 0, projectDurationMs: 10_000 });
  assert.equal(parseEditorProject(JSON.stringify(project([overlay])))?.overlays?.[0]?.id, "saved-circle");
});

test("V2.6A production export invokes the shared overlay canvas renderer", () => {
  const source = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  assert.match(source, /drawEditorOverlaysAt\([\s\S]*editorProject\?\.overlays[\s\S]*elapsed \* 1_000/);
  assert.match(source, /activeProductionOverlays = overlaysVisibleAt\(editorProject\?\.overlays, previewElapsed \* 1_000\)/);
  assert.match(source, /aria-label="成片叠加层预览"[\s\S]*activeProductionOverlays\.map/);
});

test("V2.6A text editing coalesces a focus session into one history boundary", () => {
  const source = readFileSync(new URL("./TimelineEditor.tsx", import.meta.url), "utf8");
  assert.match(source, /onFocus=\{beginOverlayTextEdit\}/);
  assert.match(source, /updateOverlay\(selectedOverlay\.id, \{ text: event\.target\.value \} as Partial<EditorOverlay>, false\)/);
  assert.match(source, /onBlur=\{finishOverlayTextEdit\}/);
  assert.match(source, /historyRef\.current = recordProjectUndoSnapshot\(historyRef\.current, base\)/);
});
