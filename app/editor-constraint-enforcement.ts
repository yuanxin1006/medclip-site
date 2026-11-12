import {
  applyClipPositionScaleToProject,
  applyClipSpeedCurve,
  cloneProject,
  reorderTimelineClip,
  sourceTimeAtTimelineMs,
  type EditorProject,
  type TimelineCaption,
  type TimelineClip,
} from "./editor-core.ts";
import {
  hasEnforceableConstraintsV1,
  parseConstraintSet,
  type ActiveConstraintV1,
  type ConstraintSetV1,
  type EnforcementReadyBindingV1,
} from "./editor-constraints.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";

export const CONSTRAINT_ENFORCEMENT_SCHEMA_VERSION = 1 as const;

export type ConstraintEnforcementStatus =
  | "ALLOWED"
  | "BLOCKED_HARD_CONSTRAINT"
  | "STALE_CONSTRAINT_CONTEXT"
  | "NOT_EVALUABLE";

export type ConstraintViolationCode =
  | "PROTECTED_CONTENT_DELETE"
  | "PROTECTED_RANGE_TRIM"
  | "PROTECTED_CONTENT_MOVE"
  | "PROTECTED_SPEED_CHANGE"
  | "PROTECTED_ASSET_REPLACE"
  | "PROTECTED_CAPTION_CHANGE"
  | "PROTECTED_TIMING_CHANGE"
  | "PROTECTED_SPLIT"
  | "PROTECTED_TRANSFORM_CHANGE"
  | "PROTECTED_AUDIO_RANGE_CHANGE"
  | "PRESERVE_ENDING_VIOLATION"
  | "STALE_CONSTRAINT_CONTEXT"
  | "UNSUPPORTED_PROTECTED_MUTATION";

export type ConstraintCandidateActionV1 = Readonly<{
  type: string;
  targetId: string;
  assetId?: string;
  startSeconds?: number;
  endSeconds?: number;
  playbackRate?: number;
  splitAtSeconds?: number;
  referenceId?: string;
  placement?: "BEFORE" | "AFTER";
  x?: number;
  y?: number;
  scale?: number;
  text?: string;
}>;

export type ConstraintViolationV1 = Readonly<{
  violationId: string;
  constraintId: string;
  actionType?: string;
  targetId?: string;
  code: ConstraintViolationCode;
  expected: string;
  observed: string;
  evidence: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  messageZh: string;
}>;

export type ConstraintEnforcementResultV1 = Readonly<{
  schemaVersion: typeof CONSTRAINT_ENFORCEMENT_SCHEMA_VERSION;
  status: ConstraintEnforcementStatus;
  constraintSetId?: string;
  constraintFingerprint?: string;
  violations: readonly ConstraintViolationV1[];
}>;

export type ConstraintContextExpectationV1 = Readonly<{
  intentVersionId: string;
  constraintSetId: string;
  constraintFingerprint: string;
}>;

export type ConstraintEnforcementInputV1 = Readonly<{
  project: EditorProject;
  constraintSet?: ConstraintSetV1;
  action?: ConstraintCandidateActionV1;
  candidateProject?: EditorProject;
  expectedContext?: ConstraintContextExpectationV1;
}>;

export class ConstraintEnforcementBlockedError extends Error {
  readonly result: ConstraintEnforcementResultV1;

  constructor(result: ConstraintEnforcementResultV1) {
    super(constraintEnforcementMessageZh(result));
    this.name = "ConstraintEnforcementBlockedError";
    this.result = result;
  }
}
type ConstraintBindingPair = Readonly<{
  constraint: ActiveConstraintV1;
  bindings: readonly EnforcementReadyBindingV1[];
}>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193) >>> 0;
  }
  return result.toString(16).padStart(8, "0");
}

function freeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value as Record<string, unknown>).forEach(freeze);
  return value;
}

function emptyResult(status: ConstraintEnforcementStatus, set?: ConstraintSetV1): ConstraintEnforcementResultV1 {
  return freeze({
    schemaVersion: CONSTRAINT_ENFORCEMENT_SCHEMA_VERSION,
    status,
    ...(set ? { constraintSetId: set.constraintSetId, constraintFingerprint: set.constraintFingerprint } : {}),
    violations: Object.freeze([]),
  });
}

function messageFor(code: ConstraintViolationCode): string {
  if (code === "PROTECTED_CONTENT_DELETE") return "此操作会删除已保护的内容，因此未执行。";
  if (code === "PROTECTED_RANGE_TRIM") return "此操作会裁掉已保护的完整片段，因此未执行。";
  if (code === "PROTECTED_CONTENT_MOVE") return "此操作会移动已保护的片段，因此未执行。";
  if (code === "PROTECTED_SPEED_CHANGE") return "该片段已设置为不可变速，无法通过加速压缩时长。";
  if (code === "PROTECTED_ASSET_REPLACE") return "此操作会替换已保护的素材，因此未执行。";
  if (code === "PROTECTED_CAPTION_CHANGE") return "此操作会修改已保护的字幕，因此未执行。";
  if (code === "PROTECTED_TIMING_CHANGE") return "此操作会改变已保护内容的时间位置，因此未执行。";
  if (code === "PROTECTED_SPLIT") return "已保护片段缺少可证明的拆分继承关系，因此未执行。";
  if (code === "PROTECTED_TRANSFORM_CHANGE") return "此操作会改变已保护画面的变换，因此未执行。";
  if (code === "PROTECTED_AUDIO_RANGE_CHANGE") return "当前音频来源身份不足以证明该范围修改安全，因此未执行。";
  if (code === "PRESERVE_ENDING_VIOLATION") return "此操作会破坏已保护的结尾位置，因此未执行。";
  if (code === "STALE_CONSTRAINT_CONTEXT") return "保护约束与当前工程状态不一致，请先返回需求确认流程重新校验。";
  return "当前保护上下文无法证明此操作安全，因此未执行。";
}

function violation(
  set: ConstraintSetV1 | undefined,
  constraintId: string,
  code: ConstraintViolationCode,
  expected: string,
  observed: string,
  evidence: ConstraintViolationV1["evidence"],
  action?: ConstraintCandidateActionV1,
): ConstraintViolationV1 {
  const material = {
    constraintSetId: set?.constraintSetId ?? "invalid-constraint-set",
    constraintFingerprint: set?.constraintFingerprint ?? "invalid-constraint-fingerprint",
    constraintId,
    actionType: action?.type ?? "POST_APPLY",
    targetId: action?.targetId ?? "PROJECT",
    code,
    expected,
    observed,
    evidence,
  };
  return freeze({
    violationId: `constraint-violation-v1-${hash(stable(material))}`,
    constraintId,
    ...(action ? { actionType: action.type, targetId: action.targetId } : {}),
    code,
    expected,
    observed,
    evidence: freeze({ ...evidence }),
    messageZh: messageFor(code),
  });
}

function finalize(set: ConstraintSetV1, violations: readonly ConstraintViolationV1[]): ConstraintEnforcementResultV1 {
  const unique = [...new Map(violations.map((item) => [item.violationId, item])).values()]
    .sort((left, right) => left.constraintId.localeCompare(right.constraintId)
      || left.code.localeCompare(right.code)
      || (left.targetId ?? "").localeCompare(right.targetId ?? "")
      || left.violationId.localeCompare(right.violationId));
  return freeze({
    schemaVersion: CONSTRAINT_ENFORCEMENT_SCHEMA_VERSION,
    status: unique.length ? "BLOCKED_HARD_CONSTRAINT" : "ALLOWED",
    constraintSetId: set.constraintSetId,
    constraintFingerprint: set.constraintFingerprint,
    violations: Object.freeze(unique),
  });
}

function staleResult(
  set: ConstraintSetV1 | undefined,
  expected: string,
  observed: string,
  evidence: ConstraintViolationV1["evidence"],
  status: "STALE_CONSTRAINT_CONTEXT" | "NOT_EVALUABLE" = "STALE_CONSTRAINT_CONTEXT",
): ConstraintEnforcementResultV1 {
  const item = violation(set, "constraint-context", "STALE_CONSTRAINT_CONTEXT", expected, observed, evidence);
  return freeze({
    schemaVersion: CONSTRAINT_ENFORCEMENT_SCHEMA_VERSION,
    status,
    ...(set ? { constraintSetId: set.constraintSetId, constraintFingerprint: set.constraintFingerprint } : {}),
    violations: Object.freeze([item]),
  });
}

function sameProvenance(left: EnforcementReadyBindingV1, right: EnforcementReadyBindingV1): boolean {
  return left.projectId === right.projectId
    && left.provenance.authority === right.provenance.authority
    && left.provenance.sourceReference === right.provenance.sourceReference;
}

function pairs(set: ConstraintSetV1): readonly ConstraintBindingPair[] {
  return Object.freeze(set.activeConstraints.map((constraint) => {
    const primary = set.confirmedBindings.find((binding) => binding.bindingId === constraint.bindingId);
    if (!primary) return Object.freeze({ constraint, bindings: Object.freeze([]) });
    // Caption grounding is deliberately promoted to a current timeline range by
    // V2.3C. Retain the exact confirmed caption alongside that promoted range.
    const related = set.confirmedBindings.filter((binding) => (
      binding.bindingId === primary.bindingId
      || (binding.bindingType === "CAPTION" && sameProvenance(binding, primary))
    ));
    return Object.freeze({ constraint, bindings: Object.freeze(related) });
  }));
}

function clipMap(project: EditorProject): ReadonlyMap<string, TimelineClip> {
  return new Map(project.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]));
}

function captionMap(project: EditorProject): ReadonlyMap<string, TimelineCaption> {
  return new Map(project.captions.map((caption) => [caption.id, caption]));
}

function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return Math.min(endA, endB) > Math.max(startA, startB);
}

function bindingClips(project: EditorProject, binding: EnforcementReadyBindingV1): readonly TimelineClip[] {
  const clips = project.tracks.flatMap((track) => track.clips);
  if (binding.bindingType === "CLIP") return clips.filter((clip) => clip.id === binding.clipId);
  if (binding.bindingType === "TIME_RANGE") {
    if (binding.range.coordinateSpace === "TIMELINE") {
      return clips.filter((clip) => overlaps(
        clip.timelineStartMs,
        clip.timelineEndMs,
        binding.range.startMs,
        binding.range.endMs,
      ));
    }
    const range = binding.range;
    return clips.filter((clip) => clip.assetId === range.assetId && overlaps(
      clip.sourceInMs,
      clip.sourceOutMs,
      range.startMs,
      range.endMs,
    ));
  }
  if (binding.bindingType === "VIDEO_SEMANTIC_SOURCE_RANGE") {
    return clips.filter((clip) => clip.assetId === binding.assetId && overlaps(
      clip.sourceInMs,
      clip.sourceOutMs,
      binding.startMs,
      binding.endMs,
    ));
  }
  return Object.freeze([]);
}

function bindingCaptions(project: EditorProject, binding: EnforcementReadyBindingV1): readonly TimelineCaption[] {
  if (binding.bindingType === "CAPTION") return project.captions.filter((caption) => caption.id === binding.captionId);
  if (binding.bindingType === "TIME_RANGE" && binding.range.coordinateSpace === "TIMELINE") {
    return project.captions.filter((caption) => overlaps(
      caption.startMs,
      caption.endMs,
      binding.range.startMs,
      binding.range.endMs,
    ));
  }
  return Object.freeze([]);
}

function sourceRange(binding: EnforcementReadyBindingV1): Readonly<{ assetId: string; startMs: number; endMs: number }> | undefined {
  if (binding.bindingType === "TIME_RANGE" && binding.range.coordinateSpace === "SOURCE_ASSET") {
    return { assetId: binding.range.assetId, startMs: binding.range.startMs, endMs: binding.range.endMs };
  }
  if (binding.bindingType === "VIDEO_SEMANTIC_SOURCE_RANGE") {
    return { assetId: binding.assetId, startMs: binding.startMs, endMs: binding.endMs };
  }
  return undefined;
}

function fullyCovered(project: EditorProject, range: Readonly<{ assetId: string; startMs: number; endMs: number }>): boolean {
  const intervals = project.tracks.flatMap((track) => track.clips)
    .filter((clip) => clip.assetId === range.assetId && overlaps(clip.sourceInMs, clip.sourceOutMs, range.startMs, range.endMs))
    .map((clip) => [Math.max(range.startMs, clip.sourceInMs), Math.min(range.endMs, clip.sourceOutMs)] as const)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let cursor = range.startMs;
  for (const [start, end] of intervals) {
    if (start > cursor) return false;
    cursor = Math.max(cursor, end);
    if (cursor >= range.endMs) return true;
  }
  return cursor >= range.endMs;
}

function actionIsNoOp(project: EditorProject, action: ConstraintCandidateActionV1): boolean {
  const clip = clipMap(project).get(action.targetId);
  if (action.type === "SET_CAPTION_TEXT") return captionMap(project).get(action.targetId)?.text === action.text;
  if (action.type === "MATCH_ASSET_TO_SEGMENT") return Boolean(clip && clip.assetId === action.assetId && clip.sourceInMs === 0);
  if (action.type === "SET_CLIP_POSITION_SCALE") {
    return Boolean(clip && clip.transform.x === action.x && clip.transform.y === action.y && clip.transform.scale === action.scale);
  }
  if (action.type === "SET_CLIP_PLAYBACK_SPEED") {
    return Boolean(clip && clip.speedCurve.every((point) => point.rate === action.playbackRate));
  }
  if (action.type === "TRIM_CLIP") {
    return clip?.timelineStartMs === Math.round((action.startSeconds ?? -1) * 1_000)
      && clip.timelineEndMs === Math.round((action.endSeconds ?? -1) * 1_000);
  }
  return false;
}

function actionTouchesPair(
  project: EditorProject,
  action: ConstraintCandidateActionV1,
  pair: ConstraintBindingPair,
): boolean {
  if (action.type === "SET_BACKGROUND_AUDIO_RANGE") {
    return pair.bindings.some((binding) => binding.bindingType === "TIME_RANGE"
      || binding.bindingType === "VIDEO_SEMANTIC_SOURCE_RANGE");
  }
  if (action.type === "SET_CAPTION_TEXT") {
    return pair.bindings.some((binding) => bindingCaptions(project, binding).some((caption) => caption.id === action.targetId));
  }
  return pair.bindings.some((binding) => bindingClips(project, binding).some((clip) => clip.id === action.targetId));
}

function directActionViolations(
  project: EditorProject,
  set: ConstraintSetV1,
  action: ConstraintCandidateActionV1,
): ConstraintViolationV1[] {
  if (actionIsNoOp(project, action)) return [];
  const result: ConstraintViolationV1[] = [];
  for (const pair of pairs(set)) {
    if (!actionTouchesPair(project, action, pair)) continue;
    const permissions = pair.constraint.permissions;
    let code: ConstraintViolationCode | undefined;
    let expected = "protected mutation permission = true";
    if (action.type === "REMOVE_CLIP" && !permissions.allowDelete) code = "PROTECTED_CONTENT_DELETE";
    else if (action.type === "TRIM_CLIP" && !permissions.allowTrim) code = "PROTECTED_RANGE_TRIM";
    else if (action.type === "SET_CLIP_PLAYBACK_SPEED" && !permissions.allowSpeedChange) code = "PROTECTED_SPEED_CHANGE";
    else if (action.type === "MATCH_ASSET_TO_SEGMENT" && !permissions.allowAssetReplace) code = "PROTECTED_ASSET_REPLACE";
    else if (action.type === "REORDER_CLIP" && !permissions.allowMove) code = "PROTECTED_CONTENT_MOVE";
    else if (action.type === "SET_CLIP_POSITION_SCALE" && !permissions.allowTransformChange) code = "PROTECTED_TRANSFORM_CHANGE";
    else if (action.type === "SET_CAPTION_TEXT" && !permissions.allowCaptionTextChange) code = "PROTECTED_CAPTION_CHANGE";
    else if (action.type === "SET_BACKGROUND_AUDIO_RANGE") {
      if (!permissions.allowAudioRangeChange) code = "PROTECTED_AUDIO_RANGE_CHANGE";
      else {
        // ConstraintSetV1 deliberately has no durable background-audio source
        // identity. Permission alone cannot prove that a protected speech/audio
        // binding survives a source-range replacement.
        code = "UNSUPPORTED_PROTECTED_MUTATION";
        expected = "allowAudioRangeChange = true and a trusted durable audio source identity";
      }
    }
    else if (action.type === "SPLIT_CLIP") {
      // V2.3E has no durable child-binding lineage. Even an otherwise permissive
      // policy cannot prove that both generated children inherit the binding.
      code = permissions.allowSplit ? "UNSUPPORTED_PROTECTED_MUTATION" : "PROTECTED_SPLIT";
      expected = permissions.allowSplit ? "provable protected child-binding lineage" : "allowSplit = true";
    }
    if (!code) continue;
    result.push(violation(set, pair.constraint.constraintId, code, expected, `action ${action.type}`, {
      bindingIds: Object.freeze(pair.bindings.map((binding) => binding.bindingId)),
      permission: code === "PROTECTED_CONTENT_DELETE" ? permissions.allowDelete
        : code === "PROTECTED_RANGE_TRIM" ? permissions.allowTrim
          : code === "PROTECTED_SPEED_CHANGE" ? permissions.allowSpeedChange
            : code === "PROTECTED_ASSET_REPLACE" ? permissions.allowAssetReplace
              : code === "PROTECTED_CONTENT_MOVE" ? permissions.allowMove
                : code === "PROTECTED_TRANSFORM_CHANGE" ? permissions.allowTransformChange
                  : code === "PROTECTED_CAPTION_CHANGE" ? permissions.allowCaptionTextChange
                    : code === "PROTECTED_AUDIO_RANGE_CHANGE" ? permissions.allowAudioRangeChange
                      : permissions.allowSplit,
    }, action));
  }
  return result;
}

function changed(left: unknown, right: unknown): boolean {
  return stable(left) !== stable(right);
}

function clipInvariantViolations(
  set: ConstraintSetV1,
  pair: ConstraintBindingPair,
  before: TimelineClip,
  after: TimelineClip | undefined,
  action?: ConstraintCandidateActionV1,
): ConstraintViolationV1[] {
  const result: ConstraintViolationV1[] = [];
  const p = pair.constraint.permissions;
  const common = { bindingIds: Object.freeze(pair.bindings.map((binding) => binding.bindingId)), clipId: before.id };
  if (!after) {
    if (!p.allowDelete) result.push(violation(set, pair.constraint.constraintId, "PROTECTED_CONTENT_DELETE", "protected clip exists", "clip missing", common, action));
    return result;
  }
  if (!p.allowAssetReplace && before.assetId !== after.assetId) {
    result.push(violation(set, pair.constraint.constraintId, "PROTECTED_ASSET_REPLACE", before.assetId, after.assetId, common, action));
  }
  if (!p.allowTrim && (before.sourceInMs !== after.sourceInMs || before.sourceOutMs !== after.sourceOutMs)) {
    result.push(violation(set, pair.constraint.constraintId, "PROTECTED_RANGE_TRIM", `${before.sourceInMs}-${before.sourceOutMs}`, `${after.sourceInMs}-${after.sourceOutMs}`, common, action));
  }
  if (!p.allowMove && (before.trackId !== after.trackId || before.timelineStartMs !== after.timelineStartMs)) {
    result.push(violation(set, pair.constraint.constraintId, "PROTECTED_CONTENT_MOVE", `${before.trackId}@${before.timelineStartMs}`, `${after.trackId}@${after.timelineStartMs}`, common, action));
  }
  if (!p.allowTimingChange && before.timelineEndMs - before.timelineStartMs !== after.timelineEndMs - after.timelineStartMs) {
    result.push(violation(set, pair.constraint.constraintId, "PROTECTED_TIMING_CHANGE", `${before.timelineStartMs}-${before.timelineEndMs}`, `${after.timelineStartMs}-${after.timelineEndMs}`, common, action));
  }
  if (!p.allowSpeedChange && changed(before.speedCurve, after.speedCurve)) {
    result.push(violation(set, pair.constraint.constraintId, "PROTECTED_SPEED_CHANGE", stable(before.speedCurve), stable(after.speedCurve), common, action));
  }
  if (!p.allowTransformChange && changed(before.transform, after.transform)) {
    result.push(violation(set, pair.constraint.constraintId, "PROTECTED_TRANSFORM_CHANGE", stable(before.transform), stable(after.transform), common, action));
  }
  return result;
}

function captionInvariantViolations(
  set: ConstraintSetV1,
  pair: ConstraintBindingPair,
  before: TimelineCaption,
  after: TimelineCaption | undefined,
  action?: ConstraintCandidateActionV1,
): ConstraintViolationV1[] {
  const result: ConstraintViolationV1[] = [];
  const p = pair.constraint.permissions;
  const common = { bindingIds: Object.freeze(pair.bindings.map((binding) => binding.bindingId)), captionId: before.id };
  if (!after) {
    if (!p.allowDelete) result.push(violation(set, pair.constraint.constraintId, "PROTECTED_CONTENT_DELETE", "protected caption exists", "caption missing", common, action));
    return result;
  }
  if (!p.allowCaptionTextChange && before.text !== after.text) {
    result.push(violation(set, pair.constraint.constraintId, "PROTECTED_CAPTION_CHANGE", before.text, after.text, common, action));
  }
  if (!p.allowTimingChange && (before.startMs !== after.startMs || before.endMs !== after.endMs)) {
    result.push(violation(set, pair.constraint.constraintId, "PROTECTED_TIMING_CHANGE", `${before.startMs}-${before.endMs}`, `${after.startMs}-${after.endMs}`, common, action));
  }
  return result;
}

function endingViolations(
  set: ConstraintSetV1,
  pair: ConstraintBindingPair,
  before: EditorProject,
  after: EditorProject,
  action?: ConstraintCandidateActionV1,
): ConstraintViolationV1[] {
  if (pair.constraint.type !== "PRESERVE_ENDING") return [];
  const beforeBound = pair.bindings.flatMap((binding) => bindingClips(before, binding));
  const afterClips = clipMap(after);
  const candidateBound = beforeBound.map((clip) => afterClips.get(clip.id)).filter((clip): clip is TimelineClip => Boolean(clip));
  const finalVisualEnd = after.tracks
    .filter((track) => track.type === "video" || track.type === "broll")
    .flatMap((track) => track.clips)
    .reduce((maximum, clip) => Math.max(maximum, clip.timelineEndMs), 0);
  const preserved = candidateBound.length > 0 && candidateBound.some((clip) => clip.timelineEndMs === finalVisualEnd);
  if (preserved) return [];
  return [violation(set, pair.constraint.constraintId, "PRESERVE_ENDING_VIOLATION", "protected ending remains in final ending region", `protectedEnd=${candidateBound.reduce((maximum, clip) => Math.max(maximum, clip.timelineEndMs), 0)}, finalEnd=${finalVisualEnd}`, {
    bindingIds: Object.freeze(pair.bindings.map((binding) => binding.bindingId)),
    protectedClipIds: Object.freeze(beforeBound.map((clip) => clip.id)),
  }, action)];
}

function postApplyViolations(
  before: EditorProject,
  after: EditorProject,
  set: ConstraintSetV1,
  action?: ConstraintCandidateActionV1,
): ConstraintViolationV1[] {
  const result: ConstraintViolationV1[] = [];
  const afterClips = clipMap(after);
  const afterCaptions = captionMap(after);
  for (const pair of pairs(set)) {
    for (const binding of pair.bindings) {
      for (const clip of bindingClips(before, binding)) {
        result.push(...clipInvariantViolations(set, pair, clip, afterClips.get(clip.id), action));
      }
      for (const caption of bindingCaptions(before, binding)) {
        result.push(...captionInvariantViolations(set, pair, caption, afterCaptions.get(caption.id), action));
      }
      const range = sourceRange(binding);
      if (range && !pair.constraint.permissions.allowTrim && !fullyCovered(after, range)) {
        result.push(violation(set, pair.constraint.constraintId, "PROTECTED_RANGE_TRIM", `${range.assetId}:${range.startMs}-${range.endMs} fully represented`, "protected source range is incomplete", {
          bindingId: binding.bindingId,
          assetId: range.assetId,
          startMs: range.startMs,
          endMs: range.endMs,
        }, action));
      }
    }
    result.push(...endingViolations(set, pair, before, after, action));
  }
  if (before.id !== after.id) {
    result.push(violation(set, "constraint-context", "STALE_CONSTRAINT_CONTEXT", before.id, after.id, { reason: "project identity changed" }, action));
  }
  return result;
}

/**
 * Validates the authoritative context without evaluating a mutation. Absence of
 * a ConstraintSet means that no active hard constraint exists for this phase.
 */
export function validateConstraintContextV1(
  project: EditorProject,
  constraintSet?: ConstraintSetV1,
  expectedContext?: ConstraintContextExpectationV1,
): ConstraintEnforcementResultV1 {
  if (!constraintSet) {
    return expectedContext
      ? staleResult(undefined, "a valid ConstraintSetV1", "missing", { projectId: project.id }, "NOT_EVALUABLE")
      : emptyResult("ALLOWED");
  }
  let parsed: ConstraintSetV1;
  try {
    parsed = parseConstraintSet(constraintSet);
  } catch (error) {
    return staleResult(constraintSet, "valid ConstraintSetV1", "malformed constraint context", {
      projectId: project.id,
      reason: error instanceof Error ? error.message : "invalid constraint set",
    }, "NOT_EVALUABLE");
  }
  const actualFingerprint = createEditorProjectFingerprint(project);
  const hasEnforceableConstraints = hasEnforceableConstraintsV1(parsed);
  if (parsed.projectId !== project.id
    || (hasEnforceableConstraints && parsed.validatedAgainstProjectFingerprint !== actualFingerprint)
    || (expectedContext && (
      expectedContext.intentVersionId !== parsed.intentVersionId
      || expectedContext.constraintSetId !== parsed.constraintSetId
      || expectedContext.constraintFingerprint !== parsed.constraintFingerprint
    ))) {
    return staleResult(parsed, `${parsed.projectId}:${parsed.validatedAgainstProjectFingerprint}`, `${project.id}:${actualFingerprint}`, {
      expectedIntentVersionId: expectedContext?.intentVersionId ?? parsed.intentVersionId,
      actualIntentVersionId: parsed.intentVersionId,
      expectedConstraintSetId: expectedContext?.constraintSetId ?? parsed.constraintSetId,
      actualConstraintSetId: parsed.constraintSetId,
      expectedConstraintFingerprint: expectedContext?.constraintFingerprint ?? parsed.constraintFingerprint,
      actualConstraintFingerprint: parsed.constraintFingerprint,
    });
  }
  if (pairs(parsed).some((pair) => pair.bindings.length === 0)) {
    return staleResult(parsed, "every active constraint has a confirmed active binding", "binding missing", { projectId: project.id }, "NOT_EVALUABLE");
  }
  return emptyResult("ALLOWED", parsed);
}

/** Pure action-level and optional candidate-project preflight. */
export function enforceEditorActionConstraintsV1(input: ConstraintEnforcementInputV1): ConstraintEnforcementResultV1 {
  const context = validateConstraintContextV1(input.project, input.constraintSet, input.expectedContext);
  if (context.status !== "ALLOWED" || !input.constraintSet) return context;
  const parsed = parseConstraintSet(input.constraintSet);
  const violations = input.action ? directActionViolations(input.project, parsed, input.action) : [];
  if (input.candidateProject) {
    violations.push(...postApplyViolations(input.project, input.candidateProject, parsed, input.action));
  }
  return finalize(parsed, violations);
}

/** Deterministic structural post-apply verification used by executor/evaluator/manual guard. */
export function verifyPostApplyConstraintInvariantsV1(input: Readonly<{
  preProject: EditorProject;
  candidateProject: EditorProject;
  constraintSet?: ConstraintSetV1;
  expectedContext?: ConstraintContextExpectationV1;
}>): ConstraintEnforcementResultV1 {
  const context = validateConstraintContextV1(input.preProject, input.constraintSet, input.expectedContext);
  if (context.status !== "ALLOWED" || !input.constraintSet) return context;
  const parsed = parseConstraintSet(input.constraintSet);
  return finalize(parsed, postApplyViolations(input.preProject, input.candidateProject, parsed));
}

export function constraintEnforcementMessageZh(result: ConstraintEnforcementResultV1): string {
  return result.violations[0]?.messageZh ?? (result.status === "ALLOWED" ? "操作符合当前保护约束。" : "当前操作未通过保护约束检查。 ");
}

/** Stable project/intent-scoped semantic identity for rejection-ledger checks. */
export function createSemanticActionTupleV1(
  projectId: string,
  intentVersionId: string,
  action: ConstraintCandidateActionV1,
): string {
  const semantic = {
    projectId,
    intentVersionId,
    type: action.type,
    targetId: action.targetId,
    assetId: action.assetId ?? null,
    startSeconds: action.startSeconds ?? null,
    endSeconds: action.endSeconds ?? null,
    playbackRate: action.playbackRate ?? null,
    splitAtSeconds: action.splitAtSeconds ?? null,
    referenceId: action.referenceId ?? null,
    placement: action.placement ?? null,
    x: action.x ?? null,
    y: action.y ?? null,
    scale: action.scale ?? null,
    text: action.text ?? null,
  };
  return `semantic-action-v1-${hash(stable(semantic))}`;
}

export function isRejectedSemanticActionV1(input: Readonly<{
  projectId: string;
  intentVersionId: string;
  action: ConstraintCandidateActionV1;
  rejectedOperationTuples?: readonly string[];
}>): boolean {
  return new Set(input.rejectedOperationTuples ?? []).has(
    createSemanticActionTupleV1(input.projectId, input.intentVersionId, input.action),
  );
}

/** Utility for canonical preflight of the only action with indirect clip moves. */
export function candidateProjectForReorderV1(
  project: EditorProject,
  action: ConstraintCandidateActionV1,
): EditorProject | undefined {
  if (action.type !== "REORDER_CLIP" || !action.referenceId || !action.placement) return undefined;
  return reorderTimelineClip(project, action.targetId, action.referenceId, action.placement);
}

/** Test/manual helper for deterministic candidates without creating a second executor. */
export function candidateProjectForProtectedMutationTestV1(
  project: EditorProject,
  action: ConstraintCandidateActionV1,
): EditorProject {
  if (action.type === "REORDER_CLIP") return candidateProjectForReorderV1(project, action) ?? project;
  if (action.type === "SET_CLIP_POSITION_SCALE") {
    return applyClipPositionScaleToProject(project, action.targetId, { x: action.x!, y: action.y!, scale: action.scale! });
  }
  const next = cloneProject(project);
  if (action.type === "SET_CAPTION_TEXT") {
    next.captions = next.captions.map((caption) => caption.id === action.targetId ? { ...caption, text: action.text! } : caption);
    return next;
  }
  next.tracks.forEach((track) => {
    track.clips = track.clips.flatMap((clip) => {
      if (clip.id !== action.targetId) return [clip];
      if (action.type === "REMOVE_CLIP") return [];
      if (action.type === "MATCH_ASSET_TO_SEGMENT") return [{ ...clip, assetId: action.assetId! }];
      if (action.type === "SET_CLIP_PLAYBACK_SPEED") {
        return [applyClipSpeedCurve(clip, [{ id: "speed-start", at: 0, rate: action.playbackRate! }, { id: "speed-end", at: 1, rate: action.playbackRate! }])];
      }
      if (action.type === "TRIM_CLIP") {
        const timelineStartMs = Math.round(action.startSeconds! * 1_000);
        const timelineEndMs = Math.round(action.endSeconds! * 1_000);
        return [{ ...clip, timelineStartMs, timelineEndMs, sourceInMs: sourceTimeAtTimelineMs(clip, timelineStartMs), sourceOutMs: sourceTimeAtTimelineMs(clip, timelineEndMs) }];
      }
      return [clip];
    });
  });
  return next;
}
