import { getTaskBudget } from "./budget.ts";
import { SafeTaskError, type AITaskStatus, type SafeTextTaskFailureClass } from "./errors.ts";
import { getTaskDefinition } from "./registry.ts";
import { safeResultData } from "./safe-result.ts";
import {
  createDeepSeekTextTaskExecutor,
  DEEPSEEK_TASK_MODEL,
} from "./providers/deepseek.ts";
import type { AITaskExecutionContext, ParsedAITaskRequest } from "./types.ts";

export const INTERNAL_TEXT_TASK_FIXTURE_HEADER = "x-medclip-internal-text-task-fixture";

const EDITOR_CONTEXT = Object.freeze({
  videoDurationSeconds: 10,
  clips: [Object.freeze({ id: "clip-example-1", startSeconds: 0, endSeconds: 10 })],
  assets: [],
});

const TRIM_ACTION = Object.freeze({
  type: "TRIM_CLIP",
  targetId: "clip-example-1",
  assetId: "",
  startSeconds: 1,
  endSeconds: 6,
  reason: "Remove the unnecessary opening second.",
});

function speedAction(playbackRate: unknown, targetId = "clip-example-1", type = "SET_CLIP_PLAYBACK_SPEED") {
  return { type, targetId, assetId: "", playbackRate, reason: "Use the fixture playback rate." };
}

function splitAction(splitAtSeconds: unknown, targetId = "clip-example-1", type = "SPLIT_CLIP") {
  return { type, targetId, assetId: "", splitAtSeconds, reason: "Use the fixture clip-local split position." };
}

function reorderAction(
  targetId: string,
  referenceId: string,
  placement: unknown,
  type = "REORDER_CLIP",
) {
  return { type, targetId, assetId: "", referenceId, placement, reason: "Use the fixture relative clip order." };
}

function positionScaleAction(
  targetId: string,
  x: unknown,
  y: unknown,
  scale: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: "SET_CLIP_POSITION_SCALE",
    targetId,
    assetId: "",
    x,
    y,
    scale,
    reason: "Use the absolute fixture position and scale.",
    ...overrides,
  };
}

function captionTextAction(targetId: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "SET_CAPTION_TEXT",
    targetId,
    text,
    reason: "Use the exact requested replacement caption text.",
    ...overrides,
  };
}

function plan(actions: readonly unknown[]) {
  return {
    summary: "Apply the exact synthetic editing fixture.",
    actions,
    unsupported: [],
    warnings: [],
  };
}

type FixtureResponse =
  | { readonly kind: "canonical"; readonly status: 200; readonly content: Readonly<Record<string, unknown>> }
  | { readonly kind: "canonical_raw"; readonly status: 200; readonly content: string }
  | { readonly kind: "upstream_http"; readonly status: number }
  | { readonly kind: "upstream_malformed"; readonly status: 200 };

export type InternalTextTaskFixtureExpectation = Readonly<{
  providerResponseClass: "CANONICAL_SUCCESS" | "UPSTREAM_HTTP_ERROR" | "UPSTREAM_MALFORMED_JSON" | "CANONICAL_REJECT" | "CANONICAL_MALFORMED_JSON";
  edgeHttpStatus: 200 | 502;
  canonicalValidation: "PASS" | "REJECT";
  actionTypes: readonly string[];
  deterministicApplication: "PASS" | "REJECT" | "NOT_APPLICABLE";
  deterministicResult?: Readonly<{
    clipIds?: readonly string[];
    timelineRangesMs: readonly (readonly [number, number])[];
    sourceRangesMs: readonly (readonly [number, number])[];
    playbackRates: readonly number[];
  }>;
  deterministicCaptionResult?: readonly (readonly [string, string, number, number])[];
  safeDiagnosticClass: SafeTextTaskFailureClass | null;
  safeErrorCode: AITaskStatus | null;
}>;

export type InternalTextTaskFixtureDefinition = Readonly<{
  input: Readonly<{ editingRequirement: string; editorContext: string }>;
  response: FixtureResponse;
  expected: InternalTextTaskFixtureExpectation;
}>;

const SUCCESS = (actionTypes: readonly string[], deterministicApplication: "PASS" | "REJECT" = "PASS") => ({
  providerResponseClass: "CANONICAL_SUCCESS" as const,
  edgeHttpStatus: 200 as const,
  canonicalValidation: "PASS" as const,
  actionTypes,
  deterministicApplication,
  safeDiagnosticClass: null,
  safeErrorCode: null,
});

const SCHEMA_REJECT = (actionTypes: readonly string[]) => ({
  providerResponseClass: "CANONICAL_REJECT" as const,
  edgeHttpStatus: 502 as const,
  canonicalValidation: "REJECT" as const,
  actionTypes,
  deterministicApplication: "NOT_APPLICABLE" as const,
  safeDiagnosticClass: "CANONICAL_SCHEMA_ERROR" as const,
  safeErrorCode: "PROVIDER_SCHEMA_MISMATCH" as const,
});

const BASE_INPUT = Object.freeze({
  editingRequirement: "provider-free diagnostic fixture",
  editorContext: JSON.stringify(EDITOR_CONTEXT),
});

function editorContextForClip(
  id: string,
  timelineDurationSeconds = 10,
  sourceDurationSeconds = 10,
  playbackRate = 1,
) {
  const assetId = `asset-${id}`;
  return Object.freeze({
    videoDurationSeconds: timelineDurationSeconds,
    clips: [Object.freeze({
      id,
      trackId: "video-main",
      assetId,
      startSeconds: 0,
      endSeconds: timelineDurationSeconds,
      timelineDurationSeconds,
      playbackRate,
    })],
    assets: [Object.freeze({ id: assetId, name: "Synthetic video", kind: "video", durationSeconds: sourceDurationSeconds })],
  });
}

function inputForEditorContext(
  editorContext: Readonly<Record<string, unknown>>,
  editingRequirement = "provider-free diagnostic fixture",
) {
  return Object.freeze({
    editingRequirement,
    editorContext: JSON.stringify(editorContext),
  });
}

type ReorderClipSpec = Readonly<{
  id: string;
  timelineDurationSeconds?: number;
  sourceDurationSeconds?: number;
  playbackRate?: number;
  x?: number;
  y?: number;
  scale?: number;
}>;

function editorContextForOrderedClips(specs: readonly ReorderClipSpec[]) {
  let cursorSeconds = 0;
  const clips = specs.map((spec) => {
    const timelineDurationSeconds = spec.timelineDurationSeconds ?? 10;
    const startSeconds = cursorSeconds;
    cursorSeconds += timelineDurationSeconds;
    return Object.freeze({
      id: spec.id,
      trackId: "video-main",
      assetId: `asset-${spec.id}`,
      kind: "video",
      startSeconds,
      endSeconds: cursorSeconds,
      timelineDurationSeconds,
      playbackRate: spec.playbackRate ?? 1,
      positionScaleEligible: true,
      x: spec.x ?? 0,
      y: spec.y ?? 0,
      scale: spec.scale ?? 1,
    });
  });
  return Object.freeze({
    videoDurationSeconds: cursorSeconds,
    clips,
    assets: specs.map((spec) => Object.freeze({
      id: `asset-${spec.id}`,
      name: `Synthetic ${spec.id}`,
      kind: "video",
      durationSeconds: spec.sourceDurationSeconds ?? 10,
    })),
  });
}

function reorderDeterministicResult(specs: readonly ReorderClipSpec[], orderedIds: readonly string[]) {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  let cursorMs = 0;
  const timelineRangesMs: Array<readonly [number, number]> = [];
  const sourceRangesMs: Array<readonly [number, number]> = [];
  const playbackRates: number[] = [];
  for (const id of orderedIds) {
    const spec = byId.get(id);
    if (!spec) throw new Error(`Unknown synthetic reorder clip: ${id}`);
    const timelineDurationMs = Math.round((spec.timelineDurationSeconds ?? 10) * 1_000);
    const sourceDurationMs = Math.round((spec.sourceDurationSeconds ?? 10) * 1_000);
    timelineRangesMs.push([cursorMs, cursorMs + timelineDurationMs]);
    sourceRangesMs.push([0, sourceDurationMs]);
    playbackRates.push(spec.playbackRate ?? 1);
    cursorMs += timelineDurationMs;
  }
  return { clipIds: orderedIds, timelineRangesMs, sourceRangesMs, playbackRates };
}

const REORDER_STANDARD_SPECS = Object.freeze([
  Object.freeze({ id: "clip-a" }),
  Object.freeze({ id: "clip-b" }),
  Object.freeze({ id: "clip-c" }),
]);
const REORDER_FOUR_CLIP_SPECS = Object.freeze([
  ...REORDER_STANDARD_SPECS,
  Object.freeze({ id: "clip-d" }),
]);
const REORDER_SPEED_SPECS = Object.freeze([
  Object.freeze({ id: "clip-a", timelineDurationSeconds: 10, sourceDurationSeconds: 10, playbackRate: 1 }),
  Object.freeze({ id: "clip-b", timelineDurationSeconds: 5, sourceDurationSeconds: 10, playbackRate: 2 }),
  Object.freeze({ id: "clip-c", timelineDurationSeconds: 8, sourceDurationSeconds: 10, playbackRate: 1.25 }),
]);
const REORDER_SPLIT_CHILD_SPECS = Object.freeze([
  Object.freeze({ id: "split-left-existing", timelineDurationSeconds: 5, sourceDurationSeconds: 5 }),
  Object.freeze({ id: "split-right-existing", timelineDurationSeconds: 5, sourceDurationSeconds: 5 }),
  Object.freeze({ id: "clip-b" }),
]);

const REORDER_EDITOR_CONTEXT = editorContextForOrderedClips(REORDER_STANDARD_SPECS);

const REORDER_INPUT = inputForEditorContext(REORDER_EDITOR_CONTEXT);

const POSITION_SCALE_SPECS = Object.freeze([
  Object.freeze({ id: "clip-a", x: 10, y: -5, scale: 1.4 }),
  Object.freeze({ id: "clip-b", x: 8, y: -3, scale: 1 }),
  Object.freeze({ id: "clip-c", x: 0, y: 0, scale: 1 }),
]);
const POSITION_SCALE_CONTEXT = Object.freeze({
  ...editorContextForOrderedClips(POSITION_SCALE_SPECS),
  currentClipId: "clip-b",
});
const POSITION_SCALE_UPPER_CONTEXT = Object.freeze({
  ...editorContextForOrderedClips(POSITION_SCALE_SPECS.map((spec) => spec.id === "clip-b" ? { ...spec, scale: 3 } : spec)),
  currentClipId: "clip-b",
});
const POSITION_SCALE_LOWER_CONTEXT = Object.freeze({
  ...editorContextForOrderedClips(POSITION_SCALE_SPECS.map((spec) => spec.id === "clip-b" ? { ...spec, scale: 0.25 } : spec)),
  currentClipId: "clip-b",
});
const POSITION_SCALE_INPUT = inputForEditorContext(POSITION_SCALE_CONTEXT);
const CAPTION_CONTEXT = Object.freeze({
  videoDurationSeconds: 10,
  assets: [Object.freeze({ id: "asset-example-1", name: "Synthetic video", kind: "video", durationSeconds: 10 })],
  clips: [Object.freeze({
    id: "clip-example-1", trackId: "video-main", assetId: "asset-example-1", kind: "video",
    startSeconds: 0, endSeconds: 10, timelineDurationSeconds: 10, playbackRate: 1,
  })],
  captions: [
    Object.freeze({ id: "caption-1", text: "高血呀", startMs: 0, endMs: 1_000, ordinal: 1, eligible: true }),
    Object.freeze({ id: "caption-2", text: "Take medicine", startMs: 1_000, endMs: 2_000, ordinal: 2, eligible: true }),
    Object.freeze({ id: "caption-3", text: "患者无发热", startMs: 2_000, endMs: 3_000, ordinal: 3, eligible: true }),
  ],
});
const CAPTION_INPUT = inputForEditorContext(CAPTION_CONTEXT);
const DUPLICATE_CAPTION_CONTEXT = Object.freeze({
  ...CAPTION_CONTEXT,
  captions: [
    Object.freeze({ id: "caption-1", text: "好的", startMs: 0, endMs: 1_000, ordinal: 1, eligible: true }),
    Object.freeze({ id: "caption-2", text: "好的", startMs: 1_000, endMs: 2_000, ordinal: 2, eligible: true }),
  ],
});
const DUPLICATE_CAPTION_INPUT = inputForEditorContext(DUPLICATE_CAPTION_CONTEXT);
function unsupportedPlan(request: string, reason: string) {
  return {
    summary: "The requested clip transform cannot be resolved safely.",
    actions: [],
    unsupported: [{ request, reason }],
    warnings: [],
  };
}

function canonicalFixture(
  content: Readonly<Record<string, unknown>>,
  expected: InternalTextTaskFixtureExpectation,
  input: InternalTextTaskFixtureDefinition["input"] = BASE_INPUT,
): InternalTextTaskFixtureDefinition {
  return Object.freeze({ input, response: { kind: "canonical", status: 200, content }, expected });
}

export const INTERNAL_TEXT_TASK_FIXTURE_DEFINITIONS = Object.freeze({
  valid_canonical_plan: canonicalFixture(plan([TRIM_ACTION]), SUCCESS(["TRIM_CLIP"])),
  valid_caption_first_chinese_medical_correction: canonicalFixture(
    plan([captionTextAction("caption-1", "高血压")]),
    { ...SUCCESS(["SET_CAPTION_TEXT"]), deterministicCaptionResult: [["caption-1", "高血压", 0, 1_000], ["caption-2", "Take medicine", 1_000, 2_000], ["caption-3", "患者无发热", 2_000, 3_000]] },
    inputForEditorContext(CAPTION_CONTEXT, "把第一条字幕改成‘高血压’"),
  ),
  valid_caption_second_english_replacement: canonicalFixture(
    plan([captionTextAction("caption-2", "Take the medicine after meals.")]),
    { ...SUCCESS(["SET_CAPTION_TEXT"]), deterministicCaptionResult: [["caption-1", "高血呀", 0, 1_000], ["caption-2", "Take the medicine after meals.", 1_000, 2_000], ["caption-3", "患者无发热", 2_000, 3_000]] },
    inputForEditorContext(CAPTION_CONTEXT, "把第二条字幕改成‘Take the medicine after meals.’"),
  ),
  valid_caption_unique_current_text: canonicalFixture(
    plan([captionTextAction("caption-3", "患者今天无发热")]),
    { ...SUCCESS(["SET_CAPTION_TEXT"]), deterministicCaptionResult: [["caption-1", "高血呀", 0, 1_000], ["caption-2", "Take medicine", 1_000, 2_000], ["caption-3", "患者今天无发热", 2_000, 3_000]] },
    inputForEditorContext(CAPTION_CONTEXT, "把‘患者无发热’改成‘患者今天无发热’"),
  ),
  valid_caption_multiple_edits: canonicalFixture(
    plan([captionTextAction("caption-1", "高血压"), captionTextAction("caption-2", "Take after meals.")]),
    { ...SUCCESS(["SET_CAPTION_TEXT", "SET_CAPTION_TEXT"]), deterministicCaptionResult: [["caption-1", "高血压", 0, 1_000], ["caption-2", "Take after meals.", 1_000, 2_000], ["caption-3", "患者无发热", 2_000, 3_000]] },
    inputForEditorContext(CAPTION_CONTEXT, "把第一条字幕改成‘高血压’，第二条字幕改成‘Take after meals.’"),
  ),
  valid_caption_noop_exact_text: canonicalFixture(
    plan([captionTextAction("caption-1", "高血呀")]),
    { ...SUCCESS(["SET_CAPTION_TEXT"]), deterministicCaptionResult: [["caption-1", "高血呀", 0, 1_000], ["caption-2", "Take medicine", 1_000, 2_000], ["caption-3", "患者无发热", 2_000, 3_000]] },
    inputForEditorContext(CAPTION_CONTEXT, "把第一条字幕改成‘高血呀’"),
  ),
  ambiguous_caption_duplicate_text: canonicalFixture(
    { summary: "The quoted text matches more than one caption.", actions: [], unsupported: [{ request: "把‘好的’改成‘明白’", reason: "多个字幕具有相同原文，请用序号或其他明确方式指定。" }], warnings: [] },
    SUCCESS([]), DUPLICATE_CAPTION_INPUT,
  ),
  ambiguous_caption_deictic_reference: canonicalFixture(
    { summary: "The caption target is ambiguous.", actions: [], unsupported: [{ request: "把这条字幕改成‘正常’", reason: "没有选中字幕上下文，无法唯一确定目标。" }], warnings: [] },
    SUCCESS([]), inputForEditorContext(CAPTION_CONTEXT, "把这条字幕改成‘正常’"),
  ),
  unsupported_caption_timing_request: canonicalFixture(
    { summary: "Subtitle timing is outside the supported editing actions.", actions: [], unsupported: [{ request: "把第一条字幕提前2秒", reason: "字幕时间由音频控制，不能通过此操作修改。" }], warnings: [] },
    SUCCESS([]), inputForEditorContext(CAPTION_CONTEXT, "把第一条字幕提前2秒"),
  ),
  invalid_caption_invented_target: canonicalFixture(
    plan([captionTextAction("caption-model-invented", "新文")]), SCHEMA_REJECT(["SET_CAPTION_TEXT"]), CAPTION_INPUT,
  ),
  invalid_caption_wrong_object_target: canonicalFixture(
    plan([captionTextAction("clip-example-1", "新文")]), SCHEMA_REJECT(["SET_CAPTION_TEXT"]), CAPTION_INPUT,
  ),
  invalid_caption_asset_id_target: canonicalFixture(
    plan([captionTextAction("asset-example-1", "新文")]), SCHEMA_REJECT(["SET_CAPTION_TEXT"]), CAPTION_INPUT,
  ),
  invalid_caption_duplicate_id: canonicalFixture(
    plan([captionTextAction("caption-1", "新文")]), SCHEMA_REJECT(["SET_CAPTION_TEXT"]),
    inputForEditorContext({ ...CAPTION_CONTEXT, captions: [
      { ...CAPTION_CONTEXT.captions[0], eligible: false },
      { ...CAPTION_CONTEXT.captions[0], text: "另一个重复 id", ordinal: 2, eligible: false },
    ] }),
  ),
  invalid_caption_unknown_field: canonicalFixture(
    plan([captionTextAction("caption-1", "新文", { startMs: 2_000 })]), SCHEMA_REJECT(["SET_CAPTION_TEXT"]), CAPTION_INPUT,
  ),
  invalid_caption_over_2000_code_units: canonicalFixture(
    plan([captionTextAction("caption-1", "😀".repeat(1_001))]), SCHEMA_REJECT(["SET_CAPTION_TEXT"]), CAPTION_INPUT,
  ),
  upstream_http_502: Object.freeze({
    input: BASE_INPUT,
    response: { kind: "upstream_http", status: 502 } as const,
    expected: Object.freeze({
      providerResponseClass: "UPSTREAM_HTTP_ERROR", edgeHttpStatus: 502, canonicalValidation: "REJECT",
      actionTypes: [], deterministicApplication: "NOT_APPLICABLE", safeDiagnosticClass: "UPSTREAM_HTTP_ERROR",
      safeErrorCode: "PROVIDER_HTTP_ERROR",
    }),
  }),
  upstream_malformed_json: Object.freeze({
    input: BASE_INPUT,
    response: { kind: "upstream_malformed", status: 200 } as const,
    expected: Object.freeze({
      providerResponseClass: "UPSTREAM_MALFORMED_JSON", edgeHttpStatus: 502, canonicalValidation: "REJECT",
      actionTypes: [], deterministicApplication: "NOT_APPLICABLE", safeDiagnosticClass: "UPSTREAM_JSON_PARSE_ERROR",
      safeErrorCode: "PROVIDER_INVALID_JSON",
    }),
  }),
  canonical_schema_error: canonicalFixture(
    plan([{ ...TRIM_ACTION, type: "UNSUPPORTED_UNKNOWN_ACTION" }]),
    SCHEMA_REJECT(["UNSUPPORTED_UNKNOWN_ACTION"]),
  ),
  valid_playback_speed_1_25: canonicalFixture(plan([speedAction(1.25)]), SUCCESS(["SET_CLIP_PLAYBACK_SPEED"])),
  valid_playback_speed_0_25: canonicalFixture(plan([speedAction(0.25)]), SUCCESS(["SET_CLIP_PLAYBACK_SPEED"])),
  valid_playback_speed_4: canonicalFixture(plan([speedAction(4)]), SUCCESS(["SET_CLIP_PLAYBACK_SPEED"])),
  invalid_playback_speed_0_24: canonicalFixture(plan([speedAction(0.24)]), SCHEMA_REJECT(["SET_CLIP_PLAYBACK_SPEED"])),
  invalid_playback_speed_4_01: canonicalFixture(plan([speedAction(4.01)]), SCHEMA_REJECT(["SET_CLIP_PLAYBACK_SPEED"])),
  invalid_playback_speed_zero: canonicalFixture(plan([speedAction(0)]), SCHEMA_REJECT(["SET_CLIP_PLAYBACK_SPEED"])),
  invalid_playback_speed_negative: canonicalFixture(plan([speedAction(-1)]), SCHEMA_REJECT(["SET_CLIP_PLAYBACK_SPEED"])),
  invalid_playback_speed_nan: Object.freeze({
    input: BASE_INPUT,
    response: { kind: "canonical_raw", status: 200, content: '{"summary":"invalid","actions":[{"type":"SET_CLIP_PLAYBACK_SPEED","targetId":"clip-example-1","assetId":"","playbackRate":NaN,"reason":"invalid"}],"unsupported":[],"warnings":[]}' } as const,
    expected: Object.freeze({
      providerResponseClass: "CANONICAL_MALFORMED_JSON", edgeHttpStatus: 502, canonicalValidation: "REJECT",
      actionTypes: ["SET_CLIP_PLAYBACK_SPEED"], deterministicApplication: "NOT_APPLICABLE",
      safeDiagnosticClass: "CANONICAL_PARSE_ERROR", safeErrorCode: "PROVIDER_INVALID_JSON",
    }),
  }),
  invalid_playback_speed_infinity: Object.freeze({
    input: BASE_INPUT,
    response: { kind: "canonical_raw", status: 200, content: '{"summary":"invalid","actions":[{"type":"SET_CLIP_PLAYBACK_SPEED","targetId":"clip-example-1","assetId":"","playbackRate":Infinity,"reason":"invalid"}],"unsupported":[],"warnings":[]}' } as const,
    expected: Object.freeze({
      providerResponseClass: "CANONICAL_MALFORMED_JSON", edgeHttpStatus: 502, canonicalValidation: "REJECT",
      actionTypes: ["SET_CLIP_PLAYBACK_SPEED"], deterministicApplication: "NOT_APPLICABLE",
      safeDiagnosticClass: "CANONICAL_PARSE_ERROR", safeErrorCode: "PROVIDER_INVALID_JSON",
    }),
  }),
  invalid_playback_speed_string: canonicalFixture(plan([speedAction("1.25")]), SCHEMA_REJECT(["SET_CLIP_PLAYBACK_SPEED"])),
  unknown_playback_speed_target: canonicalFixture(plan([speedAction(1.25, "clip-unknown")]), SUCCESS(["SET_CLIP_PLAYBACK_SPEED"], "REJECT")),
  invented_playback_speed_target: canonicalFixture(plan([speedAction(1.25, "invented-clip")]), SUCCESS(["SET_CLIP_PLAYBACK_SPEED"], "REJECT")),
  target_not_in_context_playback_speed: canonicalFixture(plan([speedAction(1.25, "clip-not-in-context")]), SUCCESS(["SET_CLIP_PLAYBACK_SPEED"], "REJECT")),
  raw_url_playback_speed_target: canonicalFixture(plan([speedAction(1.25, "https://example.invalid/video.mp4")]), SUCCESS(["SET_CLIP_PLAYBACK_SPEED"], "REJECT")),
  invalid_alias_set_speed: canonicalFixture(plan([speedAction(1.25, "clip-example-1", "SET_SPEED")]), SCHEMA_REJECT(["SET_SPEED"])),
  invalid_alias_change_playback_speed: canonicalFixture(plan([speedAction(1.25, "clip-example-1", "CHANGE_PLAYBACK_SPEED")]), SCHEMA_REJECT(["CHANGE_PLAYBACK_SPEED"])),
  invalid_alias_playback_rate: canonicalFixture(plan([speedAction(1.25, "clip-example-1", "PLAYBACK_RATE")]), SCHEMA_REJECT(["PLAYBACK_RATE"])),
  valid_trim_and_playback_speed: canonicalFixture(plan([TRIM_ACTION, speedAction(1.25)]), SUCCESS(["TRIM_CLIP", "SET_CLIP_PLAYBACK_SPEED"])),
  invalid_trim_and_playback_speed: canonicalFixture(plan([TRIM_ACTION, speedAction(4.01)]), SCHEMA_REJECT(["TRIM_CLIP", "SET_CLIP_PLAYBACK_SPEED"])),
  valid_split_clip_6: canonicalFixture(plan([splitAction(6)]), SUCCESS(["SPLIT_CLIP"])),
  invalid_split_clip_zero: canonicalFixture(plan([splitAction(0)]), SCHEMA_REJECT(["SPLIT_CLIP"])),
  invalid_split_clip_negative: canonicalFixture(plan([splitAction(-1)]), SCHEMA_REJECT(["SPLIT_CLIP"])),
  invalid_split_clip_string: canonicalFixture(plan([splitAction("6")]), SCHEMA_REJECT(["SPLIT_CLIP"])),
  invalid_split_clip_exact_end: canonicalFixture(
    plan([splitAction(10, "clip-split-exact-end")]),
    SUCCESS(["SPLIT_CLIP"], "REJECT"),
    inputForEditorContext(editorContextForClip("clip-split-exact-end")),
  ),
  invalid_split_clip_after_end: canonicalFixture(
    plan([splitAction(10.1, "clip-split-after-end")]),
    SUCCESS(["SPLIT_CLIP"], "REJECT"),
    inputForEditorContext(editorContextForClip("clip-split-after-end")),
  ),
  invalid_split_clip_nan_string: canonicalFixture(
    plan([splitAction("NaN", "clip-split-non-finite")]),
    SCHEMA_REJECT(["SPLIT_CLIP"]),
    inputForEditorContext(editorContextForClip("clip-split-non-finite")),
  ),
  invalid_split_clip_infinity_string: canonicalFixture(
    plan([splitAction("Infinity", "clip-split-non-finite")]),
    SCHEMA_REJECT(["SPLIT_CLIP"]),
    inputForEditorContext(editorContextForClip("clip-split-non-finite")),
  ),
  valid_split_clip_min_left_100ms: canonicalFixture(
    plan([splitAction(0.1, "clip-split-left-bound")]),
    SUCCESS(["SPLIT_CLIP"]),
    inputForEditorContext(editorContextForClip("clip-split-left-bound")),
  ),
  invalid_split_clip_min_left_99ms: canonicalFixture(
    plan([splitAction(0.099, "clip-split-left-bound")]),
    SUCCESS(["SPLIT_CLIP"], "REJECT"),
    inputForEditorContext(editorContextForClip("clip-split-left-bound")),
  ),
  valid_split_clip_min_right_100ms: canonicalFixture(
    plan([splitAction(9.9, "clip-split-right-bound")]),
    SUCCESS(["SPLIT_CLIP"]),
    inputForEditorContext(editorContextForClip("clip-split-right-bound")),
  ),
  invalid_split_clip_min_right_99ms: canonicalFixture(
    plan([splitAction(9.901, "clip-split-right-bound")]),
    SUCCESS(["SPLIT_CLIP"], "REJECT"),
    inputForEditorContext(editorContextForClip("clip-split-right-bound")),
  ),
  unknown_split_clip_target: canonicalFixture(plan([splitAction(6, "clip-unknown")]), SUCCESS(["SPLIT_CLIP"], "REJECT")),
  invented_split_clip_target: canonicalFixture(
    plan([splitAction(6, "clip-invented-by-model")]),
    SUCCESS(["SPLIT_CLIP"], "REJECT"),
    inputForEditorContext(editorContextForClip("clip-real-1")),
  ),
  raw_url_split_clip_target: canonicalFixture(plan([splitAction(6, "https://example.invalid/video.mp4")]), SUCCESS(["SPLIT_CLIP"], "REJECT")),
  invalid_alias_cut_clip: canonicalFixture(plan([splitAction(6, "clip-example-1", "CUT_CLIP")]), SCHEMA_REJECT(["CUT_CLIP"])),
  invalid_alias_split_video: canonicalFixture(plan([splitAction(6, "clip-example-1", "SPLIT_VIDEO")]), SCHEMA_REJECT(["SPLIT_VIDEO"])),
  invalid_alias_divide_clip: canonicalFixture(plan([splitAction(6, "clip-example-1", "DIVIDE_CLIP")]), SCHEMA_REJECT(["DIVIDE_CLIP"])),
  valid_split_clip_speed_2x_at_3s: canonicalFixture(
    plan([splitAction(3, "clip-speed-2x")]),
    {
      ...SUCCESS(["SPLIT_CLIP"]),
      deterministicResult: {
        timelineRangesMs: [[0, 3_000], [3_000, 5_000]],
        sourceRangesMs: [[0, 6_000], [6_000, 10_000]],
        playbackRates: [2, 2],
      },
    },
    inputForEditorContext(editorContextForClip("clip-speed-2x", 5, 10, 2)),
  ),
  valid_speed_and_split: canonicalFixture(plan([speedAction(1.25), splitAction(6)]), SUCCESS(["SET_CLIP_PLAYBACK_SPEED", "SPLIT_CLIP"])),
  invalid_speed_and_split: canonicalFixture(plan([speedAction(4), splitAction(6)]), SUCCESS(["SET_CLIP_PLAYBACK_SPEED", "SPLIT_CLIP"], "REJECT")),
  valid_reorder_c_before_a: canonicalFixture(
    plan([reorderAction("clip-c", "clip-a", "BEFORE")]),
    {
      ...SUCCESS(["REORDER_CLIP"]),
      deterministicResult: reorderDeterministicResult(REORDER_STANDARD_SPECS, ["clip-c", "clip-a", "clip-b"]),
    },
    REORDER_INPUT,
  ),
  valid_reorder_a_after_c: canonicalFixture(
    plan([reorderAction("clip-a", "clip-c", "AFTER")]),
    {
      ...SUCCESS(["REORDER_CLIP"]),
      deterministicResult: reorderDeterministicResult(REORDER_STANDARD_SPECS, ["clip-b", "clip-c", "clip-a"]),
    },
    REORDER_INPUT,
  ),
  valid_reorder_b_after_c: canonicalFixture(
    plan([reorderAction("clip-b", "clip-c", "AFTER")]),
    {
      ...SUCCESS(["REORDER_CLIP"]),
      deterministicResult: reorderDeterministicResult(
        REORDER_FOUR_CLIP_SPECS,
        ["clip-a", "clip-c", "clip-b", "clip-d"],
      ),
    },
    inputForEditorContext(editorContextForOrderedClips(REORDER_FOUR_CLIP_SPECS)),
  ),
  valid_reorder_target: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "BEFORE")]),
    {
      ...SUCCESS(["REORDER_CLIP"]),
      deterministicResult: reorderDeterministicResult(REORDER_STANDARD_SPECS, ["clip-b", "clip-a", "clip-c"]),
    },
    REORDER_INPUT,
  ),
  valid_reorder_already_in_position: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "AFTER")]),
    {
      ...SUCCESS(["REORDER_CLIP"]),
      deterministicResult: reorderDeterministicResult(REORDER_STANDARD_SPECS, ["clip-a", "clip-b", "clip-c"]),
    },
    REORDER_INPUT,
  ),
  invalid_reorder_unknown_target: canonicalFixture(
    plan([reorderAction("clip-unknown", "clip-a", "BEFORE")]), SUCCESS(["REORDER_CLIP"], "REJECT"), REORDER_INPUT,
  ),
  invalid_reorder_invented_target: canonicalFixture(
    plan([reorderAction("clip-model-invented", "clip-a", "BEFORE")]), SUCCESS(["REORDER_CLIP"], "REJECT"), REORDER_INPUT,
  ),
  invalid_reorder_raw_url_target: canonicalFixture(
    plan([reorderAction("https://example.invalid/video.mp4", "clip-a", "BEFORE")]), SUCCESS(["REORDER_CLIP"], "REJECT"), REORDER_INPUT,
  ),
  invalid_reorder_non_context_target: canonicalFixture(
    plan([reorderAction("clip-hidden-not-in-safe-context", "clip-a", "BEFORE")]), SUCCESS(["REORDER_CLIP"], "REJECT"), REORDER_INPUT,
  ),
  valid_reorder_reference: canonicalFixture(
    plan([reorderAction("clip-b", "clip-c", "AFTER")]),
    {
      ...SUCCESS(["REORDER_CLIP"]),
      deterministicResult: reorderDeterministicResult(REORDER_STANDARD_SPECS, ["clip-a", "clip-c", "clip-b"]),
    },
    REORDER_INPUT,
  ),
  invalid_reorder_unknown_reference: canonicalFixture(
    plan([reorderAction("clip-b", "clip-unknown", "BEFORE")]), SUCCESS(["REORDER_CLIP"], "REJECT"), REORDER_INPUT,
  ),
  invalid_reorder_invented_reference: canonicalFixture(
    plan([reorderAction("clip-b", "clip-model-invented", "BEFORE")]), SUCCESS(["REORDER_CLIP"], "REJECT"), REORDER_INPUT,
  ),
  invalid_reorder_raw_url_reference: canonicalFixture(
    plan([reorderAction("clip-b", "https://example.invalid/video.mp4", "BEFORE")]), SUCCESS(["REORDER_CLIP"], "REJECT"), REORDER_INPUT,
  ),
  invalid_reorder_non_context_reference: canonicalFixture(
    plan([reorderAction("clip-b", "clip-hidden-not-in-safe-context", "BEFORE")]), SUCCESS(["REORDER_CLIP"], "REJECT"), REORDER_INPUT,
  ),
  invalid_reorder_self: canonicalFixture(
    plan([reorderAction("clip-b", "clip-b", "BEFORE")]), SUCCESS(["REORDER_CLIP"], "REJECT"), REORDER_INPUT,
  ),
  valid_reorder_before_placement: canonicalFixture(
    plan([reorderAction("clip-c", "clip-a", "BEFORE")]),
    {
      ...SUCCESS(["REORDER_CLIP"]),
      deterministicResult: reorderDeterministicResult(REORDER_STANDARD_SPECS, ["clip-c", "clip-a", "clip-b"]),
    },
    REORDER_INPUT,
  ),
  valid_reorder_after_placement: canonicalFixture(
    plan([reorderAction("clip-a", "clip-c", "AFTER")]),
    {
      ...SUCCESS(["REORDER_CLIP"]),
      deterministicResult: reorderDeterministicResult(REORDER_STANDARD_SPECS, ["clip-b", "clip-c", "clip-a"]),
    },
    REORDER_INPUT,
  ),
  invalid_reorder_lowercase_placement: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "before")]), SCHEMA_REJECT(["REORDER_CLIP"]), REORDER_INPUT,
  ),
  invalid_reorder_lowercase_after: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "after")]), SCHEMA_REJECT(["REORDER_CLIP"]), REORDER_INPUT,
  ),
  invalid_reorder_left_placement: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "LEFT")]), SCHEMA_REJECT(["REORDER_CLIP"]), REORDER_INPUT,
  ),
  invalid_reorder_right_placement: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "RIGHT")]), SCHEMA_REJECT(["REORDER_CLIP"]), REORDER_INPUT,
  ),
  invalid_reorder_start_placement: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "START")]), SCHEMA_REJECT(["REORDER_CLIP"]), REORDER_INPUT,
  ),
  invalid_reorder_end_placement: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "END")]), SCHEMA_REJECT(["REORDER_CLIP"]), REORDER_INPUT,
  ),
  invalid_reorder_move_alias: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "BEFORE", "MOVE_CLIP")]), SCHEMA_REJECT(["MOVE_CLIP"]), REORDER_INPUT,
  ),
  invalid_reorder_reposition_alias: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "BEFORE", "REPOSITION_CLIP")]), SCHEMA_REJECT(["REPOSITION_CLIP"]), REORDER_INPUT,
  ),
  invalid_reorder_change_order_alias: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "BEFORE", "CHANGE_CLIP_ORDER")]), SCHEMA_REJECT(["CHANGE_CLIP_ORDER"]), REORDER_INPUT,
  ),
  invalid_reorder_sort_alias: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "BEFORE", "SORT_CLIP")]), SCHEMA_REJECT(["SORT_CLIP"]), REORDER_INPUT,
  ),
  valid_reorder_ordinal_context: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "BEFORE")]),
    {
      ...SUCCESS(["REORDER_CLIP"]),
      deterministicResult: reorderDeterministicResult(REORDER_STANDARD_SPECS, ["clip-b", "clip-a", "clip-c"]),
    },
    inputForEditorContext(REORDER_EDITOR_CONTEXT, "把第二个视频片段移动到第一个视频片段前面。"),
  ),
  valid_reorder_pure_contract: canonicalFixture(
    plan([reorderAction("clip-c", "clip-a", "BEFORE")]),
    {
      ...SUCCESS(["REORDER_CLIP"]),
      deterministicResult: reorderDeterministicResult(REORDER_STANDARD_SPECS, ["clip-c", "clip-a", "clip-b"]),
    },
    REORDER_INPUT,
  ),
  valid_reorder_speed_adjusted_context: canonicalFixture(
    plan([reorderAction("clip-c", "clip-a", "BEFORE")]),
    {
      ...SUCCESS(["REORDER_CLIP"]),
      deterministicResult: reorderDeterministicResult(REORDER_SPEED_SPECS, ["clip-c", "clip-a", "clip-b"]),
    },
    inputForEditorContext(editorContextForOrderedClips(REORDER_SPEED_SPECS)),
  ),
  valid_reorder_existing_split_child: canonicalFixture(
    plan([reorderAction("split-right-existing", "clip-b", "AFTER")]),
    {
      ...SUCCESS(["REORDER_CLIP"]),
      deterministicResult: reorderDeterministicResult(
        REORDER_SPLIT_CHILD_SPECS,
        ["split-left-existing", "clip-b", "split-right-existing"],
      ),
    },
    inputForEditorContext(editorContextForOrderedClips(REORDER_SPLIT_CHILD_SPECS)),
  ),
  invalid_reorder_future_child_after_split: canonicalFixture(
    plan([
      splitAction(5, "clip-a"),
      reorderAction("clip-b", "invented-future-right-child-id", "AFTER"),
    ]),
    SUCCESS(["SPLIT_CLIP", "REORDER_CLIP"], "REJECT"),
    REORDER_INPUT,
  ),
  valid_speed_and_reorder: canonicalFixture(
    plan([
      speedAction(1.25, "clip-b"),
      reorderAction("clip-b", "clip-a", "BEFORE"),
    ]),
    {
      ...SUCCESS(["SET_CLIP_PLAYBACK_SPEED", "REORDER_CLIP"]),
      deterministicResult: {
        clipIds: ["clip-b", "clip-a", "clip-c"],
        timelineRangesMs: [[0, 8_000], [8_000, 18_000], [18_000, 28_000]],
        sourceRangesMs: [[0, 10_000], [0, 10_000], [0, 10_000]],
        playbackRates: [1.25, 1, 1],
      },
    },
    REORDER_INPUT,
  ),
  invalid_speed_and_reorder: canonicalFixture(
    plan([
      speedAction(1.25, "clip-b"),
      reorderAction("clip-b", "clip-unknown", "BEFORE"),
    ]),
    SUCCESS(["SET_CLIP_PLAYBACK_SPEED", "REORDER_CLIP"], "REJECT"),
    REORDER_INPUT,
  ),
  valid_reorder_full_pipeline: canonicalFixture(
    plan([reorderAction("clip-b", "clip-a", "BEFORE")]),
    {
      ...SUCCESS(["REORDER_CLIP"]),
      deterministicResult: reorderDeterministicResult(REORDER_STANDARD_SPECS, ["clip-b", "clip-a", "clip-c"]),
    },
    inputForEditorContext(REORDER_EDITOR_CONTEXT, "把第二个视频片段移动到第一个视频片段前面。"),
  ),
  valid_position_scale_top_right_80: canonicalFixture(
    plan([positionScaleAction("clip-c", 25, -25, 0.8)]), SUCCESS(["SET_CLIP_POSITION_SCALE"]),
    inputForEditorContext(POSITION_SCALE_CONTEXT, "把第三个视频缩小到80%，放到右上角。"),
  ),
  valid_position_scale_center: canonicalFixture(
    plan([positionScaleAction("clip-a", 0, 0, 1.4)]), SUCCESS(["SET_CLIP_POSITION_SCALE"]),
    inputForEditorContext(POSITION_SCALE_CONTEXT, "把第一个视频放在画面中央。"),
  ),
  valid_position_scale_enlarge_slightly: canonicalFixture(
    plan([positionScaleAction("clip-b", 8, -3, 1.05)]), SUCCESS(["SET_CLIP_POSITION_SCALE"]),
    inputForEditorContext(POSITION_SCALE_CONTEXT, "把第二个视频放大一点。"),
  ),
  valid_position_scale_shrink_slightly: canonicalFixture(
    plan([positionScaleAction("clip-b", 8, -3, 0.95)]), SUCCESS(["SET_CLIP_POSITION_SCALE"]),
    inputForEditorContext(POSITION_SCALE_CONTEXT, "把第二个视频缩小一点。"),
  ),
  valid_position_scale_restore_current: canonicalFixture(
    plan([positionScaleAction("clip-b", 8, -3, 1)]), SUCCESS(["SET_CLIP_POSITION_SCALE"]),
    inputForEditorContext(POSITION_SCALE_CONTEXT, "把这个视频恢复原大小。"),
  ),
  valid_position_scale_bottom_left: canonicalFixture(
    plan([positionScaleAction("clip-c", -25, 25, 1)]), SUCCESS(["SET_CLIP_POSITION_SCALE"]),
    inputForEditorContext(POSITION_SCALE_CONTEXT, "把第三个视频移到左下角。"),
  ),
  valid_position_scale_125_percent: canonicalFixture(
    plan([positionScaleAction("clip-b", 8, -3, 1.25)]), SUCCESS(["SET_CLIP_POSITION_SCALE"]),
    inputForEditorContext(POSITION_SCALE_CONTEXT, "把第二个视频缩放到125%。"),
  ),
  valid_position_scale_noop: canonicalFixture(
    plan([positionScaleAction("clip-c", 0, 0, 1)]), SUCCESS(["SET_CLIP_POSITION_SCALE"]),
    inputForEditorContext(POSITION_SCALE_CONTEXT, "保持第三个视频的当前位置和大小。"),
  ),
  valid_position_scale_enlarge_at_max_noop: canonicalFixture(
    plan([positionScaleAction("clip-b", 8, -3, 3)]), SUCCESS(["SET_CLIP_POSITION_SCALE"]),
    inputForEditorContext(POSITION_SCALE_UPPER_CONTEXT, "把第二个视频放大一点。"),
  ),
  valid_position_scale_shrink_at_min_noop: canonicalFixture(
    plan([positionScaleAction("clip-b", 8, -3, 0.25)]), SUCCESS(["SET_CLIP_POSITION_SCALE"]),
    inputForEditorContext(POSITION_SCALE_LOWER_CONTEXT, "把第二个视频缩小一点。"),
  ),
  unsupported_position_scale_percent_below: canonicalFixture(
    unsupportedPlan("把第二个视频缩放到24%。", "Absolute scale percentages below 25% are unsupported."),
    SUCCESS([]), POSITION_SCALE_INPUT,
  ),
  unsupported_position_scale_percent_above: canonicalFixture(
    unsupportedPlan("把第二个视频缩放到301%。", "Absolute scale percentages above 300% are unsupported."),
    SUCCESS([]), POSITION_SCALE_INPUT,
  ),
  unsupported_position_scale_fourth_ordinal: canonicalFixture(
    unsupportedPlan("把第四个视频移到右边。", "The safe context contains only three eligible visual clips."),
    SUCCESS([]), POSITION_SCALE_INPUT,
  ),
  unsupported_position_scale_ambiguous_current: canonicalFixture(
    unsupportedPlan("把这个视频恢复原大小。", "Multiple eligible clips exist and no current clip is supplied."),
    SUCCESS([]),
    inputForEditorContext({ ...POSITION_SCALE_CONTEXT, currentClipId: undefined }, "把这个视频恢复原大小。"),
  ),
  invalid_position_scale_invented_target: canonicalFixture(
    plan([positionScaleAction("clip-model-invented", 25, -25, 0.8)]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT,
  ),
  invalid_position_scale_outside_context: canonicalFixture(
    plan([positionScaleAction("clip-hidden-not-in-safe-context", 25, -25, 0.8)]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT,
  ),
  invalid_position_scale_x_below: canonicalFixture(plan([positionScaleAction("clip-a", -50.01, 0, 1)]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT),
  invalid_position_scale_x_above: canonicalFixture(plan([positionScaleAction("clip-a", 50.01, 0, 1)]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT),
  invalid_position_scale_y_below: canonicalFixture(plan([positionScaleAction("clip-a", 0, -50.01, 1)]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT),
  invalid_position_scale_y_above: canonicalFixture(plan([positionScaleAction("clip-a", 0, 50.01, 1)]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT),
  invalid_position_scale_scale_below: canonicalFixture(plan([positionScaleAction("clip-a", 0, 0, 0.249)]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT),
  invalid_position_scale_scale_above: canonicalFixture(plan([positionScaleAction("clip-a", 0, 0, 3.001)]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT),
  invalid_position_scale_numeric_string: canonicalFixture(plan([positionScaleAction("clip-a", "25", 0, 1)]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT),
  invalid_position_scale_nonempty_asset: canonicalFixture(plan([positionScaleAction("clip-a", 0, 0, 1, { assetId: "asset-a" })]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT),
  invalid_position_scale_unknown_field: canonicalFixture(plan([positionScaleAction("clip-a", 0, 0, 1, { arbitrary: true })]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT),
  invalid_position_scale_rotation: canonicalFixture(plan([positionScaleAction("clip-a", 0, 0, 1, { rotation: 20 })]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT),
  invalid_position_scale_css: canonicalFixture(plan([positionScaleAction("clip-a", 0, 0, 1, { transform: "translate(1px)" })]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT),
  invalid_position_scale_matrix: canonicalFixture(plan([positionScaleAction("clip-a", 0, 0, 1, { matrix: [1, 0, 0, 1] })]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT),
  invalid_position_scale_crop_fit: canonicalFixture(plan([positionScaleAction("clip-a", 0, 0, 1, { crop: 10, fit: "contain" })]), SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT),
  invalid_position_scale_duplicate: canonicalFixture(
    plan([positionScaleAction("clip-a", 10, -5, 1.4), positionScaleAction("clip-a", 0, 0, 1)]),
    SCHEMA_REJECT(["SET_CLIP_POSITION_SCALE", "SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT,
  ),
  invalid_remove_and_position_scale_same_target: canonicalFixture(
    plan([
      { type: "REMOVE_CLIP", targetId: "clip-a", assetId: "", startSeconds: 0, endSeconds: 0, reason: "Remove the clip." },
      positionScaleAction("clip-a", 0, 0, 1),
    ]), SCHEMA_REJECT(["REMOVE_CLIP", "SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT,
  ),
  invalid_split_child_position_target: canonicalFixture(
    plan([
      { type: "SPLIT_CLIP", targetId: "clip-a", assetId: "", splitAtSeconds: 5, reason: "Split the clip." },
      positionScaleAction("split-child-invented", 0, 0, 1),
    ]), SCHEMA_REJECT(["SPLIT_CLIP", "SET_CLIP_POSITION_SCALE"]), POSITION_SCALE_INPUT,
  ),
} satisfies Record<string, InternalTextTaskFixtureDefinition>);

export const INTERNAL_TEXT_TASK_FIXTURES = Object.freeze(
  Object.keys(INTERNAL_TEXT_TASK_FIXTURE_DEFINITIONS),
) as readonly InternalTextTaskFixture[];

export type InternalTextTaskFixture = keyof typeof INTERNAL_TEXT_TASK_FIXTURE_DEFINITIONS;

export function parseInternalTextTaskFixture(value: string | null): InternalTextTaskFixture | null {
  if (value === null) return null;
  if (Object.prototype.hasOwnProperty.call(INTERNAL_TEXT_TASK_FIXTURE_DEFINITIONS, value)) {
    return value as InternalTextTaskFixture;
  }
  throw new SafeTaskError("INVALID_INPUT", "Internal text fixture is invalid.", 400);
}

export function getInternalTextTaskFixtureDefinition(fixture: InternalTextTaskFixture): InternalTextTaskFixtureDefinition {
  return INTERNAL_TEXT_TASK_FIXTURE_DEFINITIONS[fixture];
}

type FixtureEditorContext = Readonly<{
  videoDurationSeconds: number;
  currentClipId?: string;
  captions?: readonly Readonly<{
    id: string;
    text: string;
    startMs: number;
    endMs: number;
    ordinal: number;
    eligible: boolean;
  }>[];
  assets?: readonly Readonly<{ id: string; name?: string; durationSeconds: number }>[];
  clips: readonly Readonly<{
    id: string;
    assetId?: string;
    startSeconds: number;
    endSeconds: number;
    playbackRate?: number;
    positionScaleEligible?: boolean;
    x?: number;
    y?: number;
    scale?: number;
  }>[];
}>;

export function createInternalTextTaskFixtureApplicationContext(fixture: InternalTextTaskFixture) {
  const definition = getInternalTextTaskFixtureDefinition(fixture);
  const editorContext = JSON.parse(definition.input.editorContext) as FixtureEditorContext;
  const contextAssets = editorContext.assets?.length
    ? editorContext.assets
    : [{ id: "asset-example-1", name: "Synthetic video", durationSeconds: 10 }];
  const assets = contextAssets.map((asset) => ({
    id: asset.id,
    name: asset.name ?? "Synthetic video",
    kind: "\u89c6\u9891" as const,
    durationMs: Math.round(asset.durationSeconds * 1_000),
  }));
  const clips = editorContext.clips.map((clip) => {
    const assetId = clip.assetId ?? assets[0].id;
    const asset = assets.find((candidate) => candidate.id === assetId) ?? assets[0];
    const playbackRate = clip.playbackRate ?? 1;
    return {
      id: clip.id,
      assetId,
      name: "Synthetic video",
      kind: "\u89c6\u9891" as const,
      trackId: "video-main",
      timelineStartMs: Math.round(clip.startSeconds * 1_000),
      timelineEndMs: Math.round(clip.endSeconds * 1_000),
      sourceInMs: 0,
      sourceOutMs: asset.durationMs,
      transform: { x: clip.x ?? 0, y: clip.y ?? 0, scale: clip.scale ?? 1, crop: 0, fit: "cover" as const },
      speedCurve: [{ id: "start", at: 0, rate: playbackRate }, { id: "end", at: 1, rate: playbackRate }],
    };
  });
  const audioSourceDurationMs = Math.max(1_000, ...assets.map((asset) => asset.durationMs));
  return {
    project: {
      schemaVersion: 2 as const,
      id: "project-remote-fixture",
      title: "Provider-free remote fixture",
      updatedAt: "2026-10-18T00:00:00.000Z",
      durationMs: Math.round(editorContext.videoDurationSeconds * 1_000),
      ratio: "16:9" as const,
      audioSelection: {
        mode: "full" as const,
        sourceDurationMs: audioSourceDurationMs,
        sourceInMs: 0,
        sourceOutMs: audioSourceDurationMs,
        selectedDurationMs: audioSourceDurationMs,
      },
      assets,
      tracks: [
        { id: "video-main", type: "video" as const, name: "video", clips },
        { id: "audio-main", type: "audio" as const, name: "audio", clips: [] },
      ],
      captions: (editorContext.captions ?? []).map((caption) => ({
        id: caption.id,
        text: caption.text,
        startMs: caption.startMs,
        endMs: caption.endMs,
      })),
    },
    ownedAssetIds: assets.map((asset) => asset.id),
    audioSourceDurationMs,
    childIds: ["fixture-child-left", "fixture-child-right"] as const,
  };
}

function providerEnvelope(content: string): string {
  return JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function fixtureResponse(fixture: InternalTextTaskFixture): Response {
  const response = getInternalTextTaskFixtureDefinition(fixture).response;
  if (response.kind === "upstream_http") {
    return new Response(JSON.stringify({ error: { code: "fixture_upstream" } }), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (response.kind === "upstream_malformed") {
    return new Response("not-json", { status: response.status, headers: { "Content-Type": "application/json" } });
  }
  const content = response.kind === "canonical_raw" ? response.content : JSON.stringify(response.content);
  return new Response(providerEnvelope(content), { status: response.status, headers: { "Content-Type": "application/json" } });
}

export async function executeInternalTextTaskFixture(
  userId: string,
  request: ParsedAITaskRequest,
  fixture: InternalTextTaskFixture,
): Promise<Record<string, unknown>> {
  if (request.provider !== "deepseek" || request.task !== "editor.requirements_parse") {
    throw new SafeTaskError("INVALID_TASK", "Internal text fixture task is invalid.", 400);
  }
  const budget = getTaskBudget(request.task);
  const context: AITaskExecutionContext = {
    userId,
    task: request.task,
    provider: request.provider,
    capability: "TEXT_REASONING",
    input: request.input,
    serverInstruction: getTaskDefinition(request.task).serverInstruction,
    serverControlledModel: DEEPSEEK_TASK_MODEL,
    apiKey: "provider-free-fixture",
    budget: {
      maxOutputTokens: budget.maxOutputTokens,
      timeoutMs: budget.timeoutMs,
      automaticProviderRetryCount: 0,
      maxProviderCalls: 1,
    },
  };
  const executor = createDeepSeekTextTaskExecutor(async () => fixtureResponse(fixture));
  try {
    const execution = await executor(context);
    return {
      ok: true,
      task: request.task,
      provider: request.provider,
      result: { capability: "TEXT_REASONING", data: safeResultData(execution.data) },
      usage: execution.usage ?? null,
      metadata: {
        providerUsed: request.provider,
        taskType: request.task,
        generationOccurred: false,
        providerFreeFixture: true,
      },
    };
  } catch (error) {
    if (error instanceof SafeTaskError) {
      throw new SafeTaskError(
        error.code,
        error.message,
        error.httpStatus,
        error.diagnostic ? { ...error.diagnostic, providerCallCount: 0 } : undefined,
      );
    }
    throw error;
  }
}
