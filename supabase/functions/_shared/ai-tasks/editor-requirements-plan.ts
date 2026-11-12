import type { AITaskResultValue } from "./types.ts";

export const EDITOR_REQUIREMENTS_ACTION_TYPES = [
  "TRIM_CLIP",
  "REMOVE_CLIP",
  "SET_BACKGROUND_AUDIO_RANGE",
  "MATCH_ASSET_TO_SEGMENT",
  "SET_CLIP_PLAYBACK_SPEED",
  "SPLIT_CLIP",
  "REORDER_CLIP",
  "SET_CLIP_POSITION_SCALE",
  "SET_CAPTION_TEXT",
] as const;

const ROOT_KEYS = ["summary", "actions", "unsupported", "warnings"] as const;
const TIMED_ACTION_KEYS = ["type", "targetId", "assetId", "startSeconds", "endSeconds", "reason"] as const;
const SPEED_ACTION_KEYS = ["type", "targetId", "assetId", "playbackRate", "reason"] as const;
const SPLIT_ACTION_KEYS = ["type", "targetId", "assetId", "splitAtSeconds", "reason"] as const;
const REORDER_ACTION_KEYS = ["type", "targetId", "assetId", "referenceId", "placement", "reason"] as const;
const POSITION_SCALE_ACTION_KEYS = ["type", "targetId", "assetId", "x", "y", "scale", "reason"] as const;
const CAPTION_TEXT_ACTION_KEYS = ["type", "targetId", "text", "reason"] as const;
const UNSUPPORTED_KEYS = ["request", "reason"] as const;

export const EDITOR_REQUIREMENTS_TASK_INSTRUCTION = [
  "Convert the supplied text-only editing requirement and safe editor context into a deterministic editing plan.",
  "Do not claim to inspect image, audio, or video binary content. Do not mutate a timeline.",
  "Return exactly one JSON object and nothing else: no Markdown, no code fence, no prose, and no wrapper such as plan.",
  "The root object must contain exactly summary, actions, unsupported, and warnings. summary is a non-empty string; actions and unsupported are arrays; warnings is an array of non-empty strings. All four fields are required even when an array is empty; never use null.",
  "Every time-based action object must contain exactly type, targetId, assetId, startSeconds, endSeconds, and reason unless it uses one of the explicit exact shapes below. SET_CLIP_PLAYBACK_SPEED instead contains exactly type, targetId, assetId, playbackRate, and reason. SPLIT_CLIP instead contains exactly type, targetId, assetId, splitAtSeconds, and reason. REORDER_CLIP instead contains exactly type, targetId, assetId, referenceId, placement, and reason. SET_CLIP_POSITION_SCALE instead contains exactly type, targetId, assetId, x, y, scale, and reason. reason is always a non-empty string.",
  `Executable action types are limited to: ${EDITOR_REQUIREMENTS_ACTION_TYPES.join(", ")}.`,
  "All startSeconds and endSeconds values are finite numbers in seconds, never milliseconds. Example: five seconds is 5, not 5000.",
  'TRIM_CLIP shape: {"type":"TRIM_CLIP","targetId":"<exact clip id>","assetId":"","startSeconds":<retained clip timeline start in seconds>,"endSeconds":<retained clip timeline end in seconds>,"reason":"<non-empty reason>"}. Encode the retained timeline range, not a trim amount.',
  'REMOVE_CLIP shape: {"type":"REMOVE_CLIP","targetId":"<exact clip id>","assetId":"","startSeconds":0,"endSeconds":0,"reason":"<non-empty reason>"}.',
  'SET_BACKGROUND_AUDIO_RANGE shape: {"type":"SET_BACKGROUND_AUDIO_RANGE","targetId":"audio-main","assetId":"","startSeconds":<selected audio source start in seconds>,"endSeconds":<selected audio source end in seconds>,"reason":"<non-empty reason>"}.',
  'MATCH_ASSET_TO_SEGMENT shape: {"type":"MATCH_ASSET_TO_SEGMENT","targetId":"<exact target clip id>","assetId":"<exact available asset id>","startSeconds":<exact target clip timeline start in seconds>,"endSeconds":<exact target clip timeline end in seconds>,"reason":"<non-empty reason>"}.',
  'SET_CLIP_PLAYBACK_SPEED shape: {"type":"SET_CLIP_PLAYBACK_SPEED","targetId":"<exact video clip id>","assetId":"","playbackRate":<finite number from 0.25 through 4 inclusive>,"reason":"<non-empty reason>"}. playbackRate is numeric, not a string. Use this action only when the user supplies an explicit numeric target rate; do not guess a rate for ambiguous requests such as faster or slower.',
  'SPLIT_CLIP shape: {"type":"SPLIT_CLIP","targetId":"<exact video clip id>","assetId":"","splitAtSeconds":<finite positive number strictly inside the target clip>,"reason":"<non-empty reason>"}. splitAtSeconds is relative to the start of the target clip own displayed timeline duration, not the project-global timeline and not raw source-media time. Use the exact target clip timelineDurationSeconds from editorContext to check the bound.',
  'REORDER_CLIP shape: {"type":"REORDER_CLIP","targetId":"<exact existing clip id to move>","assetId":"","referenceId":"<exact existing anchor clip id>","placement":"BEFORE"|"AFTER","reason":"<non-empty reason>"}. This changes logical clip order only; it is not an absolute timeline-time move. targetId and referenceId must be different clips already present in editorContext on the same track.',
  'SET_CLIP_POSITION_SCALE shape: {"type":"SET_CLIP_POSITION_SCALE","targetId":"<exact trusted visual clip id>","assetId":"","x":<finite number from -50 through 50>,"y":<finite number from -50 through 50>,"scale":<finite number from 0.25 through 3>,"reason":"<non-empty reason>"}. Use absolute final values. This changes only x, y, and scale and preserves crop, fit, timeline, source range, playback, asset binding, captions, and audio. Never emit deltas, crop/fit, CSS, matrices, or other transform fields. Copy targetId exactly from the ordered eligible visual clips in editorContext; never invent it.',
  'SET_CAPTION_TEXT shape: {"type":"SET_CAPTION_TEXT","targetId":"<exact trusted eligible caption id>","text":"<exact replacement caption text>","reason":"<non-empty reason>"}. This is the complete action shape: do not add assetId, timing, index, style, or other fields. Copy targetId only from an eligible object in editorContext.captions; never invent or infer IDs.',
  "For caption targeting, use only editorContext.captions entries with eligible:true. Resolve ordinal phrases such as 第一条字幕 or 第二条字幕 from each entry's source-derived ordinal. A quoted current caption text may resolve only when exactly one eligible entry has that exact text. If the text matches multiple captions, or the ordinal does not resolve to one eligible entry, put the request in unsupported instead of guessing. Duplicate text does not identify a caption by itself.",
  "No selected-caption ID is supplied in editorContext. Deictic requests such as 这个字幕, 这条字幕, or 修改字幕 without a uniquely stated ordinal or unique exact current-text reference are ambiguous and must be unsupported. Never use currentClipId, clip IDs, asset IDs, subtitleText, or an invented identifier as a caption target.",
  "For an explicit replacement such as 把第一条字幕改成‘患者今天感觉好多了’, set text to exactly 患者今天感觉好多了. Remove the instruction words and quotation delimiters, but do not summarize, paraphrase, normalize, translate, or otherwise alter the requested replacement. Preserve Chinese, English, medical terms, punctuation, and mixed-language text exactly. This is deterministic text editing, not medical advice: do not independently correct medical content or change neighboring captions.",
  "SET_CAPTION_TEXT changes only the selected caption's text. It cannot change startMs, endMs, caption order, or caption count. Requests to advance/delay/retime a caption, merge captions, or split a caption must be unsupported and must never be mapped to SET_CAPTION_TEXT or any clip action.",
  'Example with editorContext.captions [{"id":"cap-a","text":"高血呀","startMs":0,"endMs":1000,"ordinal":1,"eligible":true}]: user request 把第一条字幕改成“高血压” returns {"summary":"Replace the first caption text as requested.","actions":[{"type":"SET_CAPTION_TEXT","targetId":"cap-a","text":"高血压","reason":"Use the exact replacement text requested for the first supplied caption."}],"unsupported":[],"warnings":[]}.',
  'Example with editorContext.captions [{"id":"cap-a","text":"旧文","startMs":0,"endMs":1000,"ordinal":1,"eligible":true},{"id":"cap-b","text":"旧文","startMs":1000,"endMs":2000,"ordinal":2,"eligible":true}]: request 把第二条字幕改成“Take the medicine after meals.” targets cap-b and preserves that exact English text. A request 把“旧文”改成“新文” is ambiguous and must have no SET_CAPTION_TEXT action.',
  'Example: with one eligible caption whose exact current text is 患者无发热, request 把“患者无发热”改成“患者今天无发热” targets that caption ID and sets text exactly to 患者今天无发热. With multiple captions and no selected-caption context, 把这条字幕改成“正常” is unsupported.',
  'Example: 把第一条字幕提前2秒, 合并这两条字幕, and 拆开这条字幕 are unsupported; do not emit SET_CAPTION_TEXT. If a user requests the exact text already present, the canonical action is allowed; local application treats exact-string equality as a no-op.',
  "Multiple caption replacements may be returned in the user's request order only when every target resolves uniquely. Emit at most one SET_CAPTION_TEXT action per caption ID; duplicate or conflicting edits to one target are invalid. Caption text edits are orthogonal to clip actions on different objects.",
  "For SET_CLIP_POSITION_SCALE, only count editorContext.clips with positionScaleEligible:true as the ordered eligible visual clip list. Use the exact current x, y, and scale supplied for the target clip. Preserve unspecified components by copying their current absolute values. Map center (0,0), top-left (-25,-25), top (0,-25), top-right (25,-25), left (-25,0), right (25,0), bottom-left (-25,25), bottom (0,25), and bottom-right (25,25); Chinese equivalents such as 右上角 and 左下角 use the same numeric values. Positive x is right; positive y is down.",
  "Chinese position mapping: 居中/画面中央=(0,0), 左上角=(-25,-25), 上方=(0,-25), 右上角=(25,-25), 左侧=(-25,0), 右侧=(25,0), 左下角=(-25,25), 下方=(0,25), 右下角=(25,25).",
  "For absolute percentages from 25% through 300%, set scale to the percentage divided by 100; 80%=0.8, 125%=1.25, 100%=1. Restore original size means scale=1 and keeps current x/y. For 放大一点 or 缩小一点, add or subtract exactly 0.05 from trusted current scale and output the absolute result. Bound this calculation to [0.25,3]: at 3, enlarge to 3; at 0.25, shrink to 0.25. These are valid no-op targets, never emit an out-of-range value or delta. Percentages outside 25%..300% are unsupported, never clamped.",
  "For 当前视频, 这个片段, or 这个视频, use editorContext.currentClipId only when supplied. If absent, resolve to the sole eligible visual clip only when exactly one exists. If multiple visual clips exist and there is no currentClipId, put the request in unsupported. Ordinals such as 第一个视频, 第二个视频, and 第三个视频 resolve only by ordered eligible visual clips in editorContext.clips; a missing ordinal is unsupported.",
  "Do not combine SET_CLIP_POSITION_SCALE with REMOVE_CLIP or SPLIT_CLIP for the same target. Do not emit multiple SET_CLIP_POSITION_SCALE actions for one target. If the target depends on a future split child or is otherwise unresolved, put it in unsupported.",
  "Use only exact asset and clip IDs present in editorContext. Resolve an ordinal reference such as first clip from editorContext.clips array order, then copy that supplied ID exactly. Never invent or infer IDs from labels, and never invent URLs, paths, or database commands. If a target cannot be resolved unambiguously to one supplied ID, put the request in unsupported instead of creating an action.",
  "For SPLIT_CLIP, provide only the existing targetId and splitAtSeconds. Never provide or invent a left clip ID, right clip ID, child clip ID, new clip ID, UUID, database row ID, or storage path. If the split position is ambiguous, put the request in unsupported; never guess the midpoint.",
  "For REORDER_CLIP, resolve first, second, third, or last clip only from the current ordered editorContext.clips array. Copy both supplied IDs exactly, use only uppercase BEFORE or AFTER, and never invent a target, reference, future split-child ID, URL, absolute index, or timeline second. If either clip or the relative placement is ambiguous, put the request in unsupported instead of guessing.",
  "Subtitle timing is audio-controlled and must never be shifted. Put unsupported subtitle timing requests in unsupported.",
  "Put volume changes, transitions, effects, ambiguous instructions, publishing, exporting, and unsupported operations in unsupported.",
  'Every unsupported item must contain exactly {"request":"<non-empty request>","reason":"<non-empty reason>"}. Do not put strings directly in unsupported.',
  "Do not invent an action type for an unsupported request. warnings contains strings only.",
  'Example for a supplied clip {"id":"clip-example-1","startSeconds":0,"endSeconds":10}: user intent "remove the first five seconds of the first clip" must return {"summary":"Remove the first five seconds from the supplied clip.","actions":[{"type":"TRIM_CLIP","targetId":"clip-example-1","assetId":"","startSeconds":5,"endSeconds":10,"reason":"Retain the clip timeline range after the first five seconds."}],"unsupported":[],"warnings":[]}.',
  'Example for a supplied video clip {"id":"clip-example-1","startSeconds":0,"endSeconds":10,"playbackRate":1}: user intent "set the first video clip to 1.25x speed" must return {"summary":"Set the supplied clip to 1.25x playback speed.","actions":[{"type":"SET_CLIP_PLAYBACK_SPEED","targetId":"clip-example-1","assetId":"","playbackRate":1.25,"reason":"Use the explicit playback rate requested for the first supplied video clip."}],"unsupported":[],"warnings":[]}.',
  'Example for a supplied video clip {"id":"clip-example-1","startSeconds":0,"endSeconds":10,"timelineDurationSeconds":10,"playbackRate":1}: user intent "在第一个视频片段第 6 秒处分割。" must return {"summary":"Split the first supplied video clip at its local timeline second 6.","actions":[{"type":"SPLIT_CLIP","targetId":"clip-example-1","assetId":"","splitAtSeconds":6,"reason":"Split at six seconds from the start of the supplied clip displayed timeline."}],"unsupported":[],"warnings":[]}.',
  'Example for ordered supplied clips clip-example-1, clip-example-2, clip-example-3: user intent "把第二个视频片段移动到第一个视频片段前面。" must return {"summary":"Move the second supplied clip before the first supplied clip.","actions":[{"type":"REORDER_CLIP","targetId":"clip-example-2","assetId":"","referenceId":"clip-example-1","placement":"BEFORE","reason":"Place the second clip immediately before the first clip in the supplied logical order."}],"unsupported":[],"warnings":[]}.',
  'Example for ordered visual clips clip-a, clip-b, clip-c with current transforms: user intent "把第三个视频缩小到80%，放到右上角。" must return {"summary":"Set the third visual clip to 80% scale in the top-right position.","actions":[{"type":"SET_CLIP_POSITION_SCALE","targetId":"clip-c","assetId":"","x":25,"y":-25,"scale":0.8,"reason":"Use the requested absolute top-right position and 80% scale for the third supplied visual clip."}],"unsupported":[],"warnings":[]}.',
] as const;

const SINGLE_JSON_FENCE = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i;

export function normalizeEditorRequirementsJSONText(content: string): string {
  const trimmed = content.trim();
  const fenced = SINGLE_JSON_FENCE.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

export type EditorSchemaMismatch = (missingFields: readonly string[], invalidFields: readonly string[]) => never;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  prefix: string,
  mismatch: EditorSchemaMismatch,
): void {
  const actual = Object.keys(record);
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(record, key)).map((key) => `${prefix}${key}`);
  const invalid = actual.some((key) => !keys.includes(key)) ? [`${prefix}$unknown`] : [];
  if (missing.length || invalid.length) mismatch(missing, invalid);
}

function safeString(value: unknown, field: string, mismatch: EditorSchemaMismatch, allowEmpty = false): string {
  if (typeof value !== "string" || /\u0000/.test(value) || value.length > 2_000) mismatch([], [field]);
  const normalized = value.trim();
  if (!allowEmpty && !normalized) mismatch([], [field]);
  return normalized;
}

function safeExactId(value: unknown, field: string, mismatch: EditorSchemaMismatch): string {
  if (typeof value !== "string" || !value || value !== value.trim() || /\u0000/.test(value) || value.length > 2_000) {
    mismatch([], [field]);
  }
  return value;
}

function safeNumber(value: unknown, field: string, mismatch: EditorSchemaMismatch): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 86_400) mismatch([], [field]);
  return value;
}

function safePlaybackRate(value: unknown, field: string, mismatch: EditorSchemaMismatch): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.25 || value > 4) {
    mismatch([], [field]);
  }
  return value;
}

function safePosition(value: unknown, field: string, mismatch: EditorSchemaMismatch): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < -50 || value > 50) mismatch([], [field]);
  return value;
}

function safeTransformScale(value: unknown, field: string, mismatch: EditorSchemaMismatch): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.25 || value > 3) mismatch([], [field]);
  return value;
}

function safeSplitSeconds(value: unknown, field: string, mismatch: EditorSchemaMismatch): number {
  const seconds = safeNumber(value, field, mismatch);
  if (seconds <= 0) mismatch([], [field]);
  return seconds;
}

function safeStringArray(value: unknown, field: string, mismatch: EditorSchemaMismatch): readonly string[] {
  if (!Array.isArray(value) || value.length > 24) mismatch([], [field]);
  return value.map((item, index) => safeString(item, `${field}[${index}]`, mismatch));
}

export function validateEditorRequirementsPlan(
  value: unknown,
  mismatch: EditorSchemaMismatch,
  editorContext?: unknown,
): Readonly<Record<string, AITaskResultValue>> {
  if (!plainRecord(value)) mismatch([], ["$root"]);
  requireExactKeys(value, ROOT_KEYS, "", mismatch);
  if (!Array.isArray(value.actions) || value.actions.length > 24) mismatch([], ["actions"]);
  if (!Array.isArray(value.unsupported) || value.unsupported.length > 24) mismatch([], ["unsupported"]);

  const actions = value.actions.map<Readonly<Record<string, AITaskResultValue>>>((item, index) => {
    if (!plainRecord(item)) mismatch([], [`actions[${index}]`]);
    const type = safeString(item.type, `actions[${index}].type`, mismatch);
    if (!(EDITOR_REQUIREMENTS_ACTION_TYPES as readonly string[]).includes(type)) {
      mismatch([], [`actions[${index}].type`]);
    }
    if (type === "SET_CLIP_PLAYBACK_SPEED") {
      requireExactKeys(item, SPEED_ACTION_KEYS, `actions[${index}].`, mismatch);
      return {
        type,
        targetId: safeString(item.targetId, `actions[${index}].targetId`, mismatch, true),
        assetId: safeString(item.assetId, `actions[${index}].assetId`, mismatch, true),
        playbackRate: safePlaybackRate(item.playbackRate, `actions[${index}].playbackRate`, mismatch),
        reason: safeString(item.reason, `actions[${index}].reason`, mismatch),
      } as Readonly<Record<string, AITaskResultValue>>;
    }
    if (type === "SPLIT_CLIP") {
      requireExactKeys(item, SPLIT_ACTION_KEYS, `actions[${index}].`, mismatch);
      return {
        type,
        targetId: safeString(item.targetId, `actions[${index}].targetId`, mismatch, true),
        assetId: safeString(item.assetId, `actions[${index}].assetId`, mismatch, true),
        splitAtSeconds: safeSplitSeconds(item.splitAtSeconds, `actions[${index}].splitAtSeconds`, mismatch),
        reason: safeString(item.reason, `actions[${index}].reason`, mismatch),
      } as Readonly<Record<string, AITaskResultValue>>;
    }
    if (type === "REORDER_CLIP") {
      requireExactKeys(item, REORDER_ACTION_KEYS, `actions[${index}].`, mismatch);
      const placement = safeString(item.placement, `actions[${index}].placement`, mismatch);
      if (placement !== "BEFORE" && placement !== "AFTER") {
        mismatch([], [`actions[${index}].placement`]);
      }
      return {
        type,
        targetId: safeString(item.targetId, `actions[${index}].targetId`, mismatch, true),
        assetId: safeString(item.assetId, `actions[${index}].assetId`, mismatch, true),
        referenceId: safeString(item.referenceId, `actions[${index}].referenceId`, mismatch, true),
        placement,
        reason: safeString(item.reason, `actions[${index}].reason`, mismatch),
      } as Readonly<Record<string, AITaskResultValue>>;
    }
    if (type === "SET_CLIP_POSITION_SCALE") {
      requireExactKeys(item, POSITION_SCALE_ACTION_KEYS, `actions[${index}].`, mismatch);
      if (item.assetId !== "") mismatch([], [`actions[${index}].assetId`]);
      const assetId = safeString(item.assetId, `actions[${index}].assetId`, mismatch, true);
      return {
        type,
        targetId: safeExactId(item.targetId, `actions[${index}].targetId`, mismatch),
        assetId,
        x: safePosition(item.x, `actions[${index}].x`, mismatch),
        y: safePosition(item.y, `actions[${index}].y`, mismatch),
        scale: safeTransformScale(item.scale, `actions[${index}].scale`, mismatch),
        reason: safeString(item.reason, `actions[${index}].reason`, mismatch),
      } as Readonly<Record<string, AITaskResultValue>>;
    }
    if (type === "SET_CAPTION_TEXT") {
      requireExactKeys(item, CAPTION_TEXT_ACTION_KEYS, `actions[${index}].`, mismatch);
      const targetId = safeExactId(item.targetId, `actions[${index}].targetId`, mismatch);
      if (typeof item.text !== "string" || item.text.length > 2_000 || /\u0000/.test(item.text) || !item.text.trim()) {
        mismatch([], [`actions[${index}].text`]);
      }
      return {
        type,
        targetId,
        text: item.text,
        reason: safeString(item.reason, `actions[${index}].reason`, mismatch),
      } as Readonly<Record<string, AITaskResultValue>>;
    }
    requireExactKeys(item, TIMED_ACTION_KEYS, `actions[${index}].`, mismatch);
    return {
      type,
      targetId: safeString(item.targetId, `actions[${index}].targetId`, mismatch, true),
      assetId: safeString(item.assetId, `actions[${index}].assetId`, mismatch, true),
      startSeconds: safeNumber(item.startSeconds, `actions[${index}].startSeconds`, mismatch),
      endSeconds: safeNumber(item.endSeconds, `actions[${index}].endSeconds`, mismatch),
      reason: safeString(item.reason, `actions[${index}].reason`, mismatch),
    } as Readonly<Record<string, AITaskResultValue>>;
  });

  const positionTargets = new Set<string>();
  const removedTargets = new Set<string>();
  const splitTargets = new Set<string>();
  const captionTargets = new Set<string>();
  for (const action of actions) {
    if (action.type === "SET_CAPTION_TEXT") {
      const targetId = action.targetId as string;
      if (captionTargets.has(targetId)) mismatch([], ["actions.$duplicateCaptionText"]);
      captionTargets.add(targetId);
    } else if (action.type === "SET_CLIP_POSITION_SCALE") {
      const targetId = action.targetId as string;
      if (positionTargets.has(targetId)) mismatch([], ["actions.$duplicatePositionScale"]);
      positionTargets.add(targetId);
    } else if (action.type === "REMOVE_CLIP") {
      removedTargets.add(action.targetId as string);
    } else if (action.type === "SPLIT_CLIP") {
      splitTargets.add(action.targetId as string);
    }
  }
  for (const targetId of positionTargets) {
    if (removedTargets.has(targetId) || splitTargets.has(targetId)) mismatch([], ["actions.$conflict"]);
  }
  if (positionTargets.size > 0) {
    if (editorContext === undefined) mismatch([], ["editorContext"]);
    let contextValue: unknown = editorContext;
    if (typeof contextValue === "string") {
      try {
        contextValue = JSON.parse(contextValue);
      } catch {
        mismatch([], ["editorContext"]);
      }
    }
    if (!plainRecord(contextValue) || !Array.isArray(contextValue.clips)) mismatch([], ["editorContext.clips"]);
    const eligibleIds = contextValue.clips
      .filter((clip: unknown): clip is Record<string, unknown> => plainRecord(clip) && clip.positionScaleEligible === true)
      .map((clip: Record<string, unknown>) => clip.id)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
    for (const targetId of positionTargets) {
      if (eligibleIds.filter((id: string) => id === targetId).length !== 1) {
        mismatch([], ["actions.targetId"]);
      }
    }
    if (contextValue.currentClipId !== undefined && (
      typeof contextValue.currentClipId !== "string"
      || eligibleIds.filter((id: string) => id === contextValue.currentClipId).length !== 1
    )) mismatch([], ["editorContext.currentClipId"]);
  }
  if (captionTargets.size > 0) {
    if (editorContext === undefined) mismatch([], ["editorContext"]);
    let contextValue: unknown = editorContext;
    if (typeof contextValue === "string") {
      try {
        contextValue = JSON.parse(contextValue);
      } catch {
        mismatch([], ["editorContext"]);
      }
    }
    if (!plainRecord(contextValue) || !Array.isArray(contextValue.captions)) mismatch([], ["editorContext.captions"]);
    const counts = new Map<string, number>();
    for (const [index, caption] of contextValue.captions.entries()) {
      if (!plainRecord(caption)) mismatch([], [`editorContext.captions[${index}]`]);
      requireExactKeys(caption, ["id", "text", "startMs", "endMs", "ordinal", "eligible"], `editorContext.captions[${index}].`, mismatch);
      const id = safeExactId(caption.id, `editorContext.captions[${index}].id`, mismatch);
      if (typeof caption.text !== "string" || caption.text.length > 2_000 || /\u0000/.test(caption.text)) {
        mismatch([], [`editorContext.captions[${index}].text`]);
      }
      if (typeof caption.startMs !== "number" || !Number.isFinite(caption.startMs) || caption.startMs < 0
        || typeof caption.endMs !== "number" || !Number.isFinite(caption.endMs) || caption.endMs <= caption.startMs
        || caption.ordinal !== index + 1 || typeof caption.eligible !== "boolean") {
        mismatch([], [`editorContext.captions[${index}]`]);
      }
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const targetId of captionTargets) {
      const matches = contextValue.captions.filter((caption: Record<string, unknown>) => caption.id === targetId);
      if (counts.get(targetId) !== 1 || matches.length !== 1 || matches[0].eligible !== true) {
        mismatch([], ["actions.targetId"]);
      }
    }
  }

  const unsupported = value.unsupported.map((item, index) => {
    if (!plainRecord(item)) mismatch([], [`unsupported[${index}]`]);
    requireExactKeys(item, UNSUPPORTED_KEYS, `unsupported[${index}].`, mismatch);
    return {
      request: safeString(item.request, `unsupported[${index}].request`, mismatch),
      reason: safeString(item.reason, `unsupported[${index}].reason`, mismatch),
    };
  });

  return {
    summary: safeString(value.summary, "summary", mismatch),
    actions,
    unsupported,
    warnings: safeStringArray(value.warnings, "warnings", mismatch),
  };
}

const stringSchema = Object.freeze({ type: "string", minLength: 1, maxLength: 2_000 });

const timedActionSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: EDITOR_REQUIREMENTS_ACTION_TYPES.filter((type) => type !== "SET_CLIP_PLAYBACK_SPEED" && type !== "SPLIT_CLIP" && type !== "REORDER_CLIP" && type !== "SET_CLIP_POSITION_SCALE" && type !== "SET_CAPTION_TEXT") },
    targetId: { type: "string", maxLength: 2_000 },
    assetId: { type: "string", maxLength: 2_000 },
    startSeconds: { type: "number", minimum: 0, maximum: 86_400 },
    endSeconds: { type: "number", minimum: 0, maximum: 86_400 },
    reason: stringSchema,
  },
  required: [...TIMED_ACTION_KEYS],
});

const speedActionSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["SET_CLIP_PLAYBACK_SPEED"] },
    targetId: { type: "string", maxLength: 2_000 },
    assetId: { type: "string", maxLength: 2_000 },
    playbackRate: { type: "number", minimum: 0.25, maximum: 4 },
    reason: stringSchema,
  },
  required: [...SPEED_ACTION_KEYS],
});

const splitActionSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["SPLIT_CLIP"] },
    targetId: { type: "string", maxLength: 2_000 },
    assetId: { type: "string", maxLength: 2_000 },
    splitAtSeconds: { type: "number", exclusiveMinimum: 0, maximum: 86_400 },
    reason: stringSchema,
  },
  required: [...SPLIT_ACTION_KEYS],
});

const reorderActionSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["REORDER_CLIP"] },
    targetId: { type: "string", maxLength: 2_000 },
    assetId: { type: "string", maxLength: 2_000 },
    referenceId: { type: "string", maxLength: 2_000 },
    placement: { type: "string", enum: ["BEFORE", "AFTER"] },
    reason: stringSchema,
  },
  required: [...REORDER_ACTION_KEYS],
});

const positionScaleActionSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["SET_CLIP_POSITION_SCALE"] },
    targetId: { type: "string", minLength: 1, maxLength: 2_000 },
    assetId: { type: "string", const: "" },
    x: { type: "number", minimum: -50, maximum: 50 },
    y: { type: "number", minimum: -50, maximum: 50 },
    scale: { type: "number", minimum: 0.25, maximum: 3 },
    reason: stringSchema,
  },
  required: [...POSITION_SCALE_ACTION_KEYS],
});

const captionTextActionSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", const: "SET_CAPTION_TEXT" },
    targetId: { type: "string", minLength: 1, maxLength: 2_000 },
    text: { type: "string", minLength: 1, maxLength: 2_000, pattern: "^[\\s\\S]{1,2000}$" },
    reason: stringSchema,
  },
  required: [...CAPTION_TEXT_ACTION_KEYS],
});

export const EDITOR_REQUIREMENTS_PLAN_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    summary: stringSchema,
    actions: {
      type: "array",
      maxItems: 24,
      items: { oneOf: [timedActionSchema, speedActionSchema, splitActionSchema, reorderActionSchema, positionScaleActionSchema, captionTextActionSchema] },
    },
    unsupported: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { request: stringSchema, reason: stringSchema },
        required: [...UNSUPPORTED_KEYS],
      },
    },
    warnings: { type: "array", maxItems: 24, items: stringSchema },
  },
  required: [...ROOT_KEYS],
});
