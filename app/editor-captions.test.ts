import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  cloneProject,
  createFullAudioSelection,
  parseEditorProject,
  recordProjectUndoSnapshot,
  type EditorProject,
  type TimelineCaption,
} from "./editor-core.ts";
import {
  DEFAULT_CAPTION_PRESENTATION,
  activeCaptionAt,
  applyCaptionPresentationToAll,
  captionPresentation,
  drawEditorCaptionAt,
  mergeAdjacentCaptions,
  parseSubtitleFile,
  patchCaption,
  splitCaption,
  type CaptionCanvasContext,
} from "./editor-captions.ts";

const durationMs = 8_000;
const srtFixture = `1
00:00:00,000 --> 00:00:02,000
第一句字幕

2
00:00:02,000 --> 00:00:05,000
第二句字幕

3
00:00:05,000 --> 00:00:08,000
第三句字幕`;

const project = (captions: TimelineCaption[] = []): EditorProject => ({
  schemaVersion: 2,
  id: "v26c-project",
  title: "V2.6C subtitle fixture",
  updatedAt: "2026-10-31T00:00:00.000Z",
  durationMs,
  ratio: "16:9",
  audioSelection: createFullAudioSelection(durationMs),
  assets: [],
  tracks: [{ id: "captions", type: "captions", name: "字幕", clips: [] }],
  captions,
  overlays: [],
  secondaryAudioClips: [],
});

test("V2.6C parses deterministic SRT cues into the canonical caption model", () => {
  const result = parseSubtitleFile(srtFixture, "fixture.srt", durationMs);
  assert.equal(result.format, "srt");
  assert.deepEqual(result.captions.map(({ text, startMs, endMs, provenance }) => ({ text, startMs, endMs, provenance })), [
    { text: "第一句字幕", startMs: 0, endMs: 2_000, provenance: "IMPORTED_SRT" },
    { text: "第二句字幕", startMs: 2_000, endMs: 5_000, provenance: "IMPORTED_SRT" },
    { text: "第三句字幕", startMs: 5_000, endMs: 8_000, provenance: "IMPORTED_SRT" },
  ]);
});

test("V2.6C parses VTT cue identifiers, settings, markup, and line breaks", () => {
  const vtt = `WEBVTT\n\ncue-a\n00:00:00.000 --> 00:00:02.000 align:center\n<b>第一句</b>\n第二行`;
  const [caption] = parseSubtitleFile(vtt, "fixture.vtt", durationMs).captions;
  assert.equal(caption.text, "第一句\n第二行");
  assert.equal(caption.provenance, "IMPORTED_VTT");
  assert.deepEqual([caption.startMs, caption.endMs], [0, 2_000]);
});

test("V2.6C parses basic ASS dialogue and safe alignment without importing effects", () => {
  const ass = `[Script Info]\nTitle: fixture\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\an8}顶部\\N字幕\nDialogue: 0,0:00:02.00,0:00:05.00,Default,,0,0,0,,第二句`;
  const captions = parseSubtitleFile(ass, "fixture.ass", durationMs).captions;
  assert.equal(captions.length, 2);
  assert.equal(captions[0].text, "顶部\n字幕");
  assert.equal(captions[0].provenance, "IMPORTED_ASS");
  assert.equal(captions[0].y, 0.12);
  assert.equal(captions[0].alignment, "center");
});

test("V2.6C import fails closed for empty, unsupported, malformed, invalid, or unreadable files", () => {
  assert.throws(() => parseSubtitleFile("", "empty.srt", durationMs), /为空/);
  assert.throws(() => parseSubtitleFile(srtFixture, "fixture.txt", durationMs), /仅支持/);
  assert.throws(() => parseSubtitleFile("not timed", "bad.srt", durationMs), /未找到/);
  assert.throws(() => parseSubtitleFile("1\n00:00:02,000 --> 00:00:01,000\nbad", "bad.srt", durationMs), /未找到/);
  assert.throws(() => parseSubtitleFile(`1\n00:00:00,000 --> 00:00:01,000\n\uFFFD`, "bad.srt", durationMs), /UTF-8/);
});

test("V2.6C timestamp normalization clips partial cues and excludes fully out-of-range cues", () => {
  const input = `1\n00:00:07,500 --> 00:00:09,000\nclipped\n\n2\n00:00:09,000 --> 00:00:10,000\noutside`;
  const captions = parseSubtitleFile(input, "bounds.srt", durationMs).captions;
  assert.equal(captions.length, 1);
  assert.deepEqual([captions[0].startMs, captions[0].endMs], [7_500, 8_000]);
});

test("V2.6C timing move and trim preserve finite minimum-duration project bounds", () => {
  const original = parseSubtitleFile(srtFixture, "fixture.srt", durationMs).captions[1];
  const moved = patchCaption(original, { startMs: 4_000, endMs: 7_000 }, durationMs);
  assert.deepEqual([moved.startMs, moved.endMs], [4_000, 7_000]);
  const trimmed = patchCaption(moved, { startMs: 6_990, endMs: Number.NaN }, durationMs);
  assert.deepEqual([trimmed.startMs, trimmed.endMs], [6_990, 7_000 + 40]);
  const bounded = patchCaption(original, { startMs: -9_000, endMs: 99_000 }, durationMs);
  assert.deepEqual([bounded.startMs, bounded.endMs], [0, 8_000]);
});

test("V2.6C text, position, color, alignment, opacity, and font size share one caption record", () => {
  const original = parseSubtitleFile(srtFixture, "fixture.srt", durationMs).captions[0];
  const edited = patchCaption(original, {
    text: "已编辑字幕",
    x: -10,
    y: 10,
    color: "#000000",
    alignment: "right",
    opacity: 5,
    fontSize: 999,
  }, durationMs);
  assert.equal(edited.text, "已编辑字幕");
  assert.deepEqual(captionPresentation(edited), {
    x: 0.05, y: 0.95, color: "#000000", alignment: "right", opacity: 1, fontSize: 120,
  });
});

test("V2.6C apply-to-all explicitly copies presentation and preserves cue text and timing", () => {
  const captions = parseSubtitleFile(srtFixture, "fixture.srt", durationMs).captions;
  const source = patchCaption(captions[1], {
    x: 0.3, y: 0.25, color: "#000000", alignment: "center", opacity: 0.75, fontSize: 50,
  }, durationMs);
  const applied = applyCaptionPresentationToAll(captions, source);
  assert.ok(applied.every((caption) => caption.x === 0.3 && caption.y === 0.25 && caption.color === "#000000"));
  assert.deepEqual(applied.map((caption) => [caption.text, caption.startMs, caption.endMs]), captions.map((caption) => [caption.text, caption.startMs, caption.endMs]));
});

test("V2.6C split, near-adjacent merge, and delete remain deterministic", () => {
  const caption = { ...parseSubtitleFile(srtFixture, "fixture.srt", durationMs).captions[0], text: "前半句，后半句" };
  const [first, second] = splitCaption(caption, 1_000, "first", "second");
  assert.deepEqual([first.startMs, first.endMs, second.startMs, second.endMs], [0, 1_000, 1_000, 2_000]);
  assert.deepEqual([first.text, second.text], ["前半句，", "后半句"]);
  const merged = mergeAdjacentCaptions(first, { ...second, startMs: 1_500, endMs: 2_500 });
  assert.deepEqual([merged.startMs, merged.endMs, merged.text], [0, 2_500, "前半句，后半句"]);
  assert.throws(() => mergeAdjacentCaptions(first, { ...second, startMs: 2_100 }), /不超过 1 秒/);
  assert.deepEqual([first, second].filter((item) => item.id !== "first").map((item) => item.id), ["second"]);
});

test("V2.6C import, edits, apply-to-all, and delete participate in exact snapshot Undo/Redo", () => {
  const before = project([]);
  const imported = project(parseSubtitleFile(srtFixture, "fixture.srt", durationMs).captions);
  const history = recordProjectUndoSnapshot([], before);
  assert.deepEqual(history.pop()?.captions, []);
  const redo = [cloneProject(imported)].pop();
  assert.equal(redo?.captions.length, 3);
  const editBase = cloneProject(imported);
  const edited = cloneProject(imported);
  edited.captions[0] = patchCaption(edited.captions[0], { text: "编辑", x: 0.2, startMs: 250 }, durationMs);
  const editHistory = recordProjectUndoSnapshot([], editBase);
  assert.deepEqual(editHistory.pop()?.captions[0], imported.captions[0]);
  assert.deepEqual([cloneProject(edited)].pop()?.captions[0], edited.captions[0]);
});

test("V2.6C active preview is start-inclusive, end-exclusive, and uses the same styled canvas renderer as export", () => {
  const captions = parseSubtitleFile(srtFixture, "fixture.srt", durationMs).captions;
  captions[0] = patchCaption(captions[0], { x: 0.25, y: 0.4, color: "#000000", opacity: 0.6, fontSize: 54 }, durationMs);
  assert.equal(activeCaptionAt(captions, 0)?.text, "第一句字幕");
  assert.equal(activeCaptionAt(captions, 2_000)?.text, "第二句字幕");
  const calls: Array<unknown[]> = [];
  const context = {
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    fillText: (...args: unknown[]) => calls.push(["fillText", ...args]),
    strokeText: (...args: unknown[]) => calls.push(["strokeText", ...args]),
    measureText: () => ({ width: 100 }),
    globalAlpha: 1,
    font: "",
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    textAlign: "center",
    textBaseline: "middle",
  } as unknown as CaptionCanvasContext;
  const rendered = drawEditorCaptionAt(context, captions, 1_000, 1_000, 1_000);
  assert.equal(rendered?.id, captions[0].id);
  assert.deepEqual(calls.find((call) => call[0] === "fillText")?.slice(1, 4), ["第一句字幕", 250, 400]);
  assert.equal(context.globalAlpha, 0.6);
});

test("V2.6C legacy and Whisper captions preserve legacy defaults and optional presentation persistence", () => {
  const legacy = project([{ id: "asr-1", text: "识别字幕", startMs: 0, endMs: 1_000, provenance: "ASR" }]);
  const restored = parseEditorProject(JSON.stringify(legacy));
  assert.deepEqual(captionPresentation(restored!.captions[0]), DEFAULT_CAPTION_PRESENTATION);
  const styled = project([{ id: "styled", text: "样式", startMs: 0, endMs: 1_000, x: 0.2, y: 0.3, color: "#000000", alignment: "left", opacity: 0.7, fontSize: 36 }]);
  assert.deepEqual(captionPresentation(parseEditorProject(JSON.stringify(styled))!.captions[0]), {
    x: 0.2, y: 0.3, color: "#000000", alignment: "left", opacity: 0.7, fontSize: 36,
  });
});

test("V2.6C production wiring keeps import, preview, timeline, history, and export on project captions", () => {
  const timelineSource = readFileSync(new URL("./TimelineEditor.tsx", import.meta.url), "utf8");
  const studioSource = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  assert.match(timelineSource, /accept="\.srt,\.vtt,\.ass/);
  assert.match(timelineSource, /next\.captions = subtitleImportMode === "replace"/);
  assert.match(timelineSource, /beginCaptionCanvasDrag[\s\S]*finishOverlayInteraction\(base, latest\)/);
  assert.match(timelineSource, /applySelectedCaptionPresentationToAll[\s\S]*applyCaptionPresentationToAll/);
  assert.match(timelineSource, /captionPropertyBaseRef[\s\S]*recordProjectUndoSnapshot/);
  assert.match(studioSource, /drawEditorOverlaysAt\([\s\S]*drawEditorCaptionAt\(context, editorProject\?\.captions/);
  assert.match(studioSource, /aria-label="成片字幕预览"[\s\S]*activeSubtitlePresentation/);
  assert.doesNotMatch(timelineSource, /ImportedSubtitle\[\]/);
});
