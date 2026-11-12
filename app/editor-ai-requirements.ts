import {
  DEFAULT_SPEED_CURVE,
  applyClipPositionScale,
  applyClipSpeedCurve,
  averageSpeed,
  cloneProject,
  isAIClipPositionScale,
  normalizeAudioSelection,
  reorderTimelineClip,
  remapVideoCaptions,
  splitTimelineClip,
  sourceTimeAtTimelineMs,
  speedCurveForTimelineDuration,
  type AudioSelection,
  type EditorProject,
  type TimelineClip,
} from "./editor-core.ts";
import type { ConstraintSetV1 } from "./editor-constraints.ts";
import {
  ConstraintEnforcementBlockedError,
  candidateProjectForReorderV1,
  enforceEditorActionConstraintsV1,
  isRejectedSemanticActionV1,
  verifyPostApplyConstraintInvariantsV1,
  type ConstraintContextExpectationV1,
  type ConstraintEnforcementResultV1,
} from "./editor-constraint-enforcement.ts";

export const EXECUTABLE_EDITOR_ACTION_TYPES = [
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

export type ExecutableEditorActionType = typeof EXECUTABLE_EDITOR_ACTION_TYPES[number];

export type EditorAIPlanAction = {
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
  reason: string;
};

export type SetCaptionTextAction = {
  type: "SET_CAPTION_TEXT";
  targetId: string;
  text: string;
  reason: string;
};

export type SetClipPositionScaleAction = {
  type: "SET_CLIP_POSITION_SCALE";
  targetId: string;
  assetId: "";
  x: number;
  y: number;
  scale: number;
  reason: string;
};

export type EditorAIUnsupportedItem = {
  request: string;
  reason: string;
};

export type EditorAIEditingPlan = {
  summary: string;
  actions: EditorAIPlanAction[];
  unsupported: EditorAIUnsupportedItem[];
  warnings: string[];
};

export type EditorAIApplyContext = {
  project: EditorProject;
  ownedAssetIds: ReadonlySet<string>;
  audioSourceDurationMs: number;
  nowIso?: string;
  createClipId?: () => string;
  constraintSet?: ConstraintSetV1;
  constraintContext?: ConstraintContextExpectationV1;
  rejectedOperationTuples?: readonly string[];
};

export type EditorAIApplyResult = {
  summary: string;
  project: EditorProject;
  audioSelection: AudioSelection;
  applied: ReadonlyArray<{ type: ExecutableEditorActionType; reason: string }>;
  unsupported: EditorAIUnsupportedItem[];
  warnings: string[];
  constraintEnforcement?: ConstraintEnforcementResultV1;
};

type ValidatedAction = EditorAIPlanAction & { type: ExecutableEditorActionType };

const ROOT_KEYS = ["summary", "actions", "unsupported", "warnings"] as const;
const TIMED_ACTION_KEYS = ["type", "targetId", "assetId", "startSeconds", "endSeconds", "reason"] as const;
const SPEED_ACTION_KEYS = ["type", "targetId", "assetId", "playbackRate", "reason"] as const;
const SPLIT_ACTION_KEYS = ["type", "targetId", "assetId", "splitAtSeconds", "reason"] as const;
const REORDER_ACTION_KEYS = ["type", "targetId", "assetId", "referenceId", "placement", "reason"] as const;
const POSITION_SCALE_ACTION_KEYS = ["type", "targetId", "assetId", "x", "y", "scale", "reason"] as const;
const CAPTION_TEXT_ACTION_KEYS = ["type", "targetId", "text", "reason"] as const;
const UNSUPPORTED_KEYS = ["request", "reason"] as const;
const MAX_ITEMS = 24;
const MIN_CLIP_DURATION_MS = 100;
// Caption editing UI/model has no maxLength; match the shared action string bound.
const MAX_CAPTION_TEXT_LENGTH = 2_000;

export class AIEditingPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIEditingPlanValidationError";
  }
}

function fail(message: string): never {
  throw new AIEditingPlanValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail(`${label} contains unsupported fields.`);
  }
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || /\u0000/.test(value) || value.length > 2_000) {
    fail(`${label} must be a safe string.`);
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) fail(`${label} is required.`);
  return normalized;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label} must be a finite number.`);
  }
  return value;
}

function parseUnsupported(value: unknown): EditorAIUnsupportedItem[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail("unsupported must be a bounded array.");
  return value.map((item, index) => {
    if (!isRecord(item)) fail(`unsupported[${index}] must be an object.`);
    requireExactKeys(item, UNSUPPORTED_KEYS, `unsupported[${index}]`);
    return {
      request: requireString(item.request, `unsupported[${index}].request`),
      reason: requireString(item.reason, `unsupported[${index}].reason`),
    };
  });
}

function parseWarnings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail("warnings must be a bounded array.");
  return value.map((item, index) => requireString(item, `warnings[${index}]`, false));
}

function parseActions(value: unknown): EditorAIPlanAction[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail("actions must be a bounded array.");
  return value.map((item, index) => {
    if (!isRecord(item)) fail(`actions[${index}] must be an object.`);
    const type = requireString(item.type, `actions[${index}].type`);
    if (type === "SET_CLIP_PLAYBACK_SPEED") {
      requireExactKeys(item, SPEED_ACTION_KEYS, `actions[${index}]`);
      return {
        type,
        targetId: requireString(item.targetId, `actions[${index}].targetId`, true),
        assetId: requireString(item.assetId, `actions[${index}].assetId`, true),
        playbackRate: requireFiniteNumber(item.playbackRate, `actions[${index}].playbackRate`),
        reason: requireString(item.reason, `actions[${index}].reason`),
      };
    }
    if (type === "SPLIT_CLIP") {
      requireExactKeys(item, SPLIT_ACTION_KEYS, `actions[${index}]`);
      return {
        type,
        targetId: requireString(item.targetId, `actions[${index}].targetId`, true),
        assetId: requireString(item.assetId, `actions[${index}].assetId`, true),
        splitAtSeconds: requireFiniteNumber(item.splitAtSeconds, `actions[${index}].splitAtSeconds`),
        reason: requireString(item.reason, `actions[${index}].reason`),
      };
    }
    if (type === "REORDER_CLIP") {
      requireExactKeys(item, REORDER_ACTION_KEYS, `actions[${index}]`);
      const placement = requireString(item.placement, `actions[${index}].placement`);
      if (placement !== "BEFORE" && placement !== "AFTER") {
        fail(`actions[${index}].placement must be BEFORE or AFTER.`);
      }
      return {
        type,
        targetId: requireString(item.targetId, `actions[${index}].targetId`, true),
        assetId: requireString(item.assetId, `actions[${index}].assetId`, true),
        referenceId: requireString(item.referenceId, `actions[${index}].referenceId`, true),
        placement,
        reason: requireString(item.reason, `actions[${index}].reason`),
      };
    }
    if (type === "SET_CLIP_POSITION_SCALE") {
      requireExactKeys(item, POSITION_SCALE_ACTION_KEYS, `actions[${index}]`);
      if (item.assetId !== "") fail(`actions[${index}].assetId must be empty.`);
      const targetId = requireString(item.targetId, `actions[${index}].targetId`);
      if (targetId !== item.targetId) fail(`actions[${index}].targetId must be an exact ID.`);
      const x = requireFiniteNumber(item.x, `actions[${index}].x`);
      const y = requireFiniteNumber(item.y, `actions[${index}].y`);
      const scale = requireFiniteNumber(item.scale, `actions[${index}].scale`);
      if (!isAIClipPositionScale({ x, y, scale })) {
        fail(`actions[${index}] contains position or scale values outside the AI-safe range.`);
      }
      return {
        type,
        targetId,
        assetId: requireString(item.assetId, `actions[${index}].assetId`, true),
        x,
        y,
        scale,
        reason: requireString(item.reason, `actions[${index}].reason`),
      };
    }
    if (type === "SET_CAPTION_TEXT") {
      requireExactKeys(item, CAPTION_TEXT_ACTION_KEYS, `actions[${index}]`);
      const targetId = requireString(item.targetId, `actions[${index}].targetId`);
      if (targetId !== item.targetId) fail(`actions[${index}].targetId must be an exact ID.`);
      if (typeof item.text !== "string" || item.text.length > MAX_CAPTION_TEXT_LENGTH || /\u0000/.test(item.text)) {
        fail(`actions[${index}].text must be a safe string no longer than ${MAX_CAPTION_TEXT_LENGTH} characters.`);
      }
      if (!item.text.trim()) fail(`actions[${index}].text must not be whitespace-only.`);
      return {
        type,
        targetId,
        text: item.text,
        reason: requireString(item.reason, `actions[${index}].reason`),
      };
    }
    requireExactKeys(item, TIMED_ACTION_KEYS, `actions[${index}]`);
    return {
      type,
      targetId: requireString(item.targetId, `actions[${index}].targetId`, true),
      assetId: requireString(item.assetId, `actions[${index}].assetId`, true),
      startSeconds: requireFiniteNumber(item.startSeconds, `actions[${index}].startSeconds`),
      endSeconds: requireFiniteNumber(item.endSeconds, `actions[${index}].endSeconds`),
      reason: requireString(item.reason, `actions[${index}].reason`),
    };
  });
}

export function parseAIEditingPlan(value: unknown): EditorAIEditingPlan {
  if (!isRecord(value)) fail("AI editing plan must be an object.");
  requireExactKeys(value, ROOT_KEYS, "AI editing plan");
  return {
    summary: requireString(value.summary, "summary"),
    actions: parseActions(value.actions),
    unsupported: parseUnsupported(value.unsupported),
    warnings: parseWarnings(value.warnings),
  };
}

function allClips(project: EditorProject): TimelineClip[] {
  return project.tracks.flatMap((track) => track.clips);
}

function requireTimelineRange(startSeconds: number, endSeconds: number, durationMs: number): [number, number] {
  const startMs = Math.round(startSeconds * 1_000);
  const endMs = Math.round(endSeconds * 1_000);
  if (startSeconds < 0 || endSeconds <= startSeconds || endMs <= startMs || endMs > durationMs) {
    fail("AI action contains an out-of-bounds timeline range.");
  }
  return [startMs, endMs];
}

function isExecutableType(value: string): value is ExecutableEditorActionType {
  return (EXECUTABLE_EDITOR_ACTION_TYPES as readonly string[]).includes(value);
}

export function validateExecutableActions(
  plan: EditorAIEditingPlan,
  context: EditorAIApplyContext,
): { actions: ValidatedAction[]; unsupported: EditorAIUnsupportedItem[] } {
  const clips = allClips(context.project);
  const clipById = new Map(clips.map((clip) => [clip.id, clip]));
  const assetById = new Map(context.project.assets.map((asset) => [asset.id, asset]));
  const actions: ValidatedAction[] = [];
  const unsupported = [...plan.unsupported];
  const mutationsByTarget = new Map<string, Set<ExecutableEditorActionType>>();
  const plannedSpeedByTarget = new Map(
    plan.actions
      .filter((action) => action.type === "SET_CLIP_PLAYBACK_SPEED")
      .map((action) => [action.targetId, action.playbackRate!] as const),
  );
  const splitTargetIds = new Set(
    plan.actions.filter((action) => action.type === "SPLIT_CLIP").map((action) => action.targetId),
  );
  const removedTargetIds = new Set(
    plan.actions.filter((action) => action.type === "REMOVE_CLIP").map((action) => action.targetId),
  );

  for (const action of plan.actions) {
    if (!isExecutableType(action.type)) {
      unsupported.push({
        request: action.reason,
        reason: `当前编辑器不支持自动执行 ${action.type}。`,
      });
      continue;
    }

    const targetKey = action.type === "SET_BACKGROUND_AUDIO_RANGE"
      ? `audio:${action.targetId}`
      : action.type === "SET_CAPTION_TEXT"
        ? `caption:${action.targetId}`
        : `clip:${action.targetId}`;
    const existingMutations = mutationsByTarget.get(targetKey);
    if (existingMutations) {
      const combined = new Set([...existingMutations, action.type]);
      const compatiblePair = combined.size === 2 && (
        (combined.has("TRIM_CLIP") && combined.has("SET_CLIP_PLAYBACK_SPEED"))
        || (combined.has("SPLIT_CLIP") && combined.has("SET_CLIP_PLAYBACK_SPEED"))
        || (combined.has("REORDER_CLIP") && combined.has("SET_CLIP_PLAYBACK_SPEED"))
      );
      if (!compatiblePair || existingMutations.has(action.type)) {
        fail("AI plan contains conflicting actions for the same target.");
      }
    }

    if (action.type === "REMOVE_CLIP") {
      const clip = clipById.get(action.targetId);
      if (!clip || !context.ownedAssetIds.has(clip.assetId) || action.assetId || action.startSeconds !== 0 || action.endSeconds !== 0) {
        fail("REMOVE_CLIP references an invalid clip or parameters.");
      }
    } else if (action.type === "TRIM_CLIP") {
      const clip = clipById.get(action.targetId);
      const asset = clip ? assetById.get(clip.assetId) : undefined;
      if (!clip || !asset || !context.ownedAssetIds.has(clip.assetId) || action.assetId) fail("TRIM_CLIP references an invalid clip.");
      const [startMs, endMs] = requireTimelineRange(
        action.startSeconds!,
        action.endSeconds!,
        context.project.durationMs,
      );
      if (
        startMs < clip.timelineStartMs
        || endMs > clip.timelineEndMs
        || endMs - startMs < MIN_CLIP_DURATION_MS
      ) fail("TRIM_CLIP exceeds the target clip bounds.");
      if (clip.speedCurve.some((point) => point.rate !== 1)) {
        fail("TRIM_CLIP does not support a non-linear speed curve.");
      }
      const sourceInMs = sourceTimeAtTimelineMs(clip, startMs);
      const sourceOutMs = sourceTimeAtTimelineMs(clip, endMs);
      if (
        sourceInMs < 0
        || sourceOutMs <= sourceInMs
        || (asset.durationMs > 0 && sourceOutMs > asset.durationMs)
      ) fail("TRIM_CLIP exceeds the source media bounds.");
    } else if (action.type === "SET_BACKGROUND_AUDIO_RANGE") {
      if (action.targetId !== "audio-main" || action.assetId) {
        fail("SET_BACKGROUND_AUDIO_RANGE must target audio-main.");
      }
      requireTimelineRange(action.startSeconds!, action.endSeconds!, context.audioSourceDurationMs);
    } else if (action.type === "SET_CLIP_PLAYBACK_SPEED") {
      const clip = clipById.get(action.targetId);
      const asset = clip ? assetById.get(clip.assetId) : undefined;
      if (
        !clip
        || !asset
        || clip.kind !== "视频"
        || asset.kind !== "视频"
        || !context.ownedAssetIds.has(clip.assetId)
        || action.assetId
        || action.playbackRate === undefined
        || !Number.isFinite(action.playbackRate)
        || action.playbackRate < 0.25
        || action.playbackRate > 4
      ) fail("SET_CLIP_PLAYBACK_SPEED references an invalid clip or playback rate.");
    } else if (action.type === "SPLIT_CLIP") {
      const clip = clipById.get(action.targetId);
      const targetCount = clips.filter((candidate) => candidate.id === action.targetId).length;
      const asset = clip ? assetById.get(clip.assetId) : undefined;
      if (
        !clip
        || targetCount !== 1
        || !asset
        || clip.kind !== "视频"
        || asset.kind !== "视频"
        || !context.ownedAssetIds.has(clip.assetId)
        || action.assetId
        || action.splitAtSeconds === undefined
        || !Number.isFinite(action.splitAtSeconds)
      ) fail("SPLIT_CLIP references an invalid clip or split position.");
      const plannedRate = plannedSpeedByTarget.get(action.targetId);
      const effectiveClip = plannedRate === undefined
        ? clip
        : applyClipSpeedCurve(clip, [
          { id: "speed-start", at: 0, rate: plannedRate },
          { id: "speed-end", at: 1, rate: plannedRate },
        ]);
      const splitAtMs = Math.round(action.splitAtSeconds * 1_000);
      const durationMs = effectiveClip.timelineEndMs - effectiveClip.timelineStartMs;
      if (splitAtMs < MIN_CLIP_DURATION_MS || durationMs - splitAtMs < MIN_CLIP_DURATION_MS) {
        fail("SPLIT_CLIP exceeds the target clip bounds.");
      }
      const sourceAtMs = sourceTimeAtTimelineMs(
        effectiveClip,
        effectiveClip.timelineStartMs + splitAtMs,
      );
      if (
        !Number.isFinite(sourceAtMs)
        || sourceAtMs <= effectiveClip.sourceInMs
        || sourceAtMs >= effectiveClip.sourceOutMs
        || sourceAtMs < 0
        || (asset.durationMs > 0 && sourceAtMs > asset.durationMs)
      ) fail("SPLIT_CLIP exceeds the source media bounds.");
    } else if (action.type === "REORDER_CLIP") {
      const target = clipById.get(action.targetId);
      const reference = clipById.get(action.referenceId ?? "");
      const targetCount = clips.filter((clip) => clip.id === action.targetId).length;
      const referenceCount = clips.filter((clip) => clip.id === action.referenceId).length;
      const targetAsset = target ? assetById.get(target.assetId) : undefined;
      const referenceAsset = reference ? assetById.get(reference.assetId) : undefined;
      if (
        !target
        || !reference
        || targetCount !== 1
        || referenceCount !== 1
        || !targetAsset
        || !referenceAsset
        || !context.ownedAssetIds.has(target.assetId)
        || !context.ownedAssetIds.has(reference.assetId)
        || action.assetId
        || action.targetId === action.referenceId
        || (action.placement !== "BEFORE" && action.placement !== "AFTER")
        || target.trackId !== reference.trackId
        || splitTargetIds.has(action.targetId)
        || splitTargetIds.has(action.referenceId ?? "")
        || removedTargetIds.has(action.targetId)
        || removedTargetIds.has(action.referenceId ?? "")
      ) fail("REORDER_CLIP references invalid clips or placement.");
    } else if (action.type === "SET_CLIP_POSITION_SCALE") {
      const clip = clipById.get(action.targetId);
      const matchingTracks = context.project.tracks.filter((track) => track.clips.some((candidate) => candidate.id === action.targetId));
      const targetCount = clips.filter((candidate) => candidate.id === action.targetId).length;
      const track = matchingTracks[0];
      const asset = clip ? assetById.get(clip.assetId) : undefined;
      const assetCount = clip ? context.project.assets.filter((candidate) => candidate.id === clip.assetId).length : 0;
      if (
        !clip
        || targetCount !== 1
        || matchingTracks.length !== 1
        || !track
        || (track.type !== "video" && track.type !== "broll")
        || clip.trackId !== track.id
        || !asset
        || assetCount !== 1
        || !context.ownedAssetIds.has(clip.assetId)
        || asset.kind !== clip.kind
        || action.assetId !== ""
        || !isAIClipPositionScale({ x: action.x, y: action.y, scale: action.scale })
      ) fail("SET_CLIP_POSITION_SCALE references an invalid clip, asset binding, or transform.");
      // Validate the current transform before any project clone is mutated.
      try {
        applyClipPositionScale(clip, { x: action.x!, y: action.y!, scale: action.scale! });
      } catch {
        fail("SET_CLIP_POSITION_SCALE target has an invalid transform.");
      }
    } else if (action.type === "SET_CAPTION_TEXT") {
      const matches = context.project.captions.filter((caption) => caption.id === action.targetId);
      if (matches.length !== 1 || typeof action.text !== "string" || !action.text.trim()) {
        fail("SET_CAPTION_TEXT references an invalid or ambiguous caption ID.");
      }
    } else {
      const clip = clipById.get(action.targetId);
      const asset = action.assetId ? assetById.get(action.assetId) : undefined;
      if (!clip || !action.assetId || !context.ownedAssetIds.has(clip.assetId) || !asset || !context.ownedAssetIds.has(action.assetId)) {
        fail("MATCH_ASSET_TO_SEGMENT references an unavailable asset or clip.");
      }
      const [startMs, endMs] = requireTimelineRange(
        action.startSeconds!,
        action.endSeconds!,
        context.project.durationMs,
      );
      if (startMs !== clip.timelineStartMs || endMs !== clip.timelineEndMs) {
        fail("MATCH_ASSET_TO_SEGMENT must use the target clip range.");
      }
    }

    const candidateProject = action.type === "REORDER_CLIP"
      ? candidateProjectForReorderV1(context.project, action)
      : undefined;
    const constraintEnforcement = enforceEditorActionConstraintsV1({
      project: context.project,
      constraintSet: context.constraintSet,
      expectedContext: context.constraintContext,
      action,
      ...(candidateProject ? { candidateProject } : {}),
    });
    if (constraintEnforcement.status !== "ALLOWED") {
      throw new ConstraintEnforcementBlockedError(constraintEnforcement);
    }
    if (context.constraintContext && isRejectedSemanticActionV1({
      projectId: context.project.id,
      intentVersionId: context.constraintContext.intentVersionId,
      action,
      rejectedOperationTuples: context.rejectedOperationTuples,
    })) {
      fail("该语义操作已在当前工程与意图版本中被用户明确拒绝，不能再次执行。");
    }

    const targetMutations = mutationsByTarget.get(targetKey) ?? new Set<ExecutableEditorActionType>();
    targetMutations.add(action.type);
    mutationsByTarget.set(targetKey, targetMutations);
    actions.push(action as ValidatedAction);
  }

  return { actions, unsupported };
}

function updateClip(project: EditorProject, clipId: string, update: (clip: TimelineClip) => TimelineClip): void {
  project.tracks.forEach((track) => {
    track.clips = track.clips.map((clip) => clip.id === clipId ? update(clip) : clip);
  });
}

/** Pure, deterministic caption text mutation. It deliberately never updates updatedAt. */
export function applySetCaptionTextToProject(
  project: EditorProject,
  action: SetCaptionTextAction,
): EditorProject {
  const matches = project.captions.filter((caption) => caption.id === action.targetId);
  if (matches.length !== 1) {
    throw new AIEditingPlanValidationError("SET_CAPTION_TEXT requires one existing caption ID.");
  }
  if (typeof action.text !== "string" || !action.text.trim() || action.text.length > MAX_CAPTION_TEXT_LENGTH) {
    throw new AIEditingPlanValidationError("SET_CAPTION_TEXT requires non-empty bounded text.");
  }
  const target = matches[0];
  if (target.text === action.text) return project;
  return {
    ...project,
    captions: project.captions.map((caption) => caption.id === action.targetId
      ? { ...caption, text: action.text }
      : caption),
  };
}

export function applyAIEditingPlan(value: unknown, context: EditorAIApplyContext): EditorAIApplyResult {
  const plan = parseAIEditingPlan(value);
  const validated = validateExecutableActions(plan, context);
  const transformActions = validated.actions.filter((action) => action.type === "SET_CLIP_POSITION_SCALE");
  const onlyTransformNoOps = transformActions.length > 0
    && transformActions.length === validated.actions.length
    && transformActions.every((action) => {
      const clip = allClips(context.project).find((candidate) => candidate.id === action.targetId)!;
      return clip.transform.x === action.x && clip.transform.y === action.y && clip.transform.scale === action.scale;
    });
  if (onlyTransformNoOps) {
    const constraintEnforcement = enforceEditorActionConstraintsV1({
      project: context.project,
      constraintSet: context.constraintSet,
      expectedContext: context.constraintContext,
    });
    return {
      summary: plan.summary,
      project: context.project,
      audioSelection: context.project.audioSelection,
      applied: validated.actions.map((action) => ({ type: action.type, reason: action.reason })),
      unsupported: validated.unsupported,
      warnings: plan.warnings,
      ...(context.constraintSet ? { constraintEnforcement } : {}),
    };
  }
  const captionActions = validated.actions.filter((action) => action.type === "SET_CAPTION_TEXT");
  const onlyCaptionNoOps = captionActions.length > 0
    && captionActions.length === validated.actions.length
    && captionActions.every((action) => (
      context.project.captions.find((caption) => caption.id === action.targetId)!.text === action.text
    ));
  if (onlyCaptionNoOps) {
    const constraintEnforcement = enforceEditorActionConstraintsV1({
      project: context.project,
      constraintSet: context.constraintSet,
      expectedContext: context.constraintContext,
    });
    return {
      summary: plan.summary,
      project: context.project,
      audioSelection: context.project.audioSelection,
      applied: validated.actions.map((action) => ({ type: action.type, reason: action.reason })),
      unsupported: validated.unsupported,
      warnings: plan.warnings,
      ...(context.constraintSet ? { constraintEnforcement } : {}),
    };
  }
  const project = cloneProject(context.project);
  let audioSelection = normalizeAudioSelection(project.audioSelection);
  const splitTargets = new Set(
    validated.actions.filter((action) => action.type === "SPLIT_CLIP").map((action) => action.targetId),
  );
  const reorderClipIds = new Set(
    validated.actions
      .filter((action) => action.type === "REORDER_CLIP")
      .flatMap((action) => [action.targetId, action.referenceId!]),
  );

  const applicationOrder = [
    ...validated.actions.filter((action) => (
      action.type === "SET_CLIP_PLAYBACK_SPEED"
      && (splitTargets.has(action.targetId) || reorderClipIds.has(action.targetId))
    )),
    ...validated.actions.filter((action) => action.type !== "SET_CLIP_PLAYBACK_SPEED"),
    ...validated.actions.filter((action) => (
      action.type === "SET_CLIP_PLAYBACK_SPEED"
      && !splitTargets.has(action.targetId)
      && !reorderClipIds.has(action.targetId)
    )),
  ];

  const applyAction = (action: (typeof applicationOrder)[number]) => {
    if (action.type === "REMOVE_CLIP") {
      project.tracks.forEach((track) => {
        track.clips = track.clips.filter((clip) => clip.id !== action.targetId);
      });
      return;
    }

    if (action.type === "TRIM_CLIP") {
      updateClip(project, action.targetId, (clip) => {
        const timelineStartMs = Math.round(action.startSeconds! * 1_000);
        const timelineEndMs = Math.round(action.endSeconds! * 1_000);
        const sourceInMs = sourceTimeAtTimelineMs(clip, timelineStartMs);
        const sourceOutMs = sourceTimeAtTimelineMs(clip, timelineEndMs);
        return {
          ...clip,
          timelineStartMs,
          timelineEndMs,
          sourceInMs,
          sourceOutMs,
          speedCurve: DEFAULT_SPEED_CURVE.map((point) => ({ ...point })),
          reason: action.reason,
        };
      });
      return;
    }

    if (action.type === "SET_BACKGROUND_AUDIO_RANGE") {
      audioSelection = normalizeAudioSelection({
        mode: "range",
        sourceDurationMs: context.audioSourceDurationMs,
        sourceInMs: action.startSeconds! * 1_000,
        sourceOutMs: action.endSeconds! * 1_000,
        selectedDurationMs: (action.endSeconds! - action.startSeconds!) * 1_000,
      });
      project.audioSelection = audioSelection;
      return;
    }

    if (action.type === "SET_CLIP_PLAYBACK_SPEED") {
      updateClip(project, action.targetId, (clip) => ({
        ...applyClipSpeedCurve(clip, [
          { id: "speed-start", at: 0, rate: action.playbackRate! },
          { id: "speed-end", at: 1, rate: action.playbackRate! },
        ]),
        reason: action.reason,
      }));
      return;
    }

    if (action.type === "SPLIT_CLIP") {
      let applied = false;
      project.tracks.forEach((track) => {
        const index = track.clips.findIndex((clip) => clip.id === action.targetId);
        if (index < 0) return;
        const clip = track.clips[index];
        const [left, right] = splitTimelineClip(
          { ...clip, reason: action.reason },
          Math.round(action.splitAtSeconds! * 1_000),
          context.createClipId ?? (() => crypto.randomUUID()),
        );
        track.clips.splice(index, 1, left, right);
        applied = true;
      });
      if (!applied) fail("Validated split target disappeared before application.");
      return;
    }

    if (action.type === "REORDER_CLIP") {
      const reordered = reorderTimelineClip(
        project,
        action.targetId,
        action.referenceId!,
        action.placement!,
      );
      project.tracks = reordered.tracks;
      project.durationMs = reordered.durationMs;
      return;
    }

    if (action.type === "SET_CLIP_POSITION_SCALE") {
      updateClip(project, action.targetId, (clip) => applyClipPositionScale(clip, {
        x: action.x!,
        y: action.y!,
        scale: action.scale!,
      }));
      return;
    }

    if (action.type === "SET_CAPTION_TEXT") {
      project.captions = applySetCaptionTextToProject(project, action as SetCaptionTextAction).captions;
      return;
    }

    const asset = project.assets.find((item) => item.id === action.assetId);
    if (!asset) fail("Validated asset disappeared before application.");
    updateClip(project, action.targetId, (clip) => {
      const timelineDurationMs = clip.timelineEndMs - clip.timelineStartMs;
      const sourceDurationMs = asset.durationMs > 0 ? asset.durationMs : timelineDurationMs;
      const sourceOutMs = Math.max(MIN_CLIP_DURATION_MS, Math.min(sourceDurationMs, timelineDurationMs));
      return {
        ...clip,
        assetId: asset.id,
        name: asset.name,
        kind: asset.kind,
        sourceInMs: 0,
        sourceOutMs,
        speedCurve: asset.kind === "视频"
          ? speedCurveForTimelineDuration(sourceOutMs, timelineDurationMs)
          : DEFAULT_SPEED_CURVE.map((point) => ({ ...point })),
        reason: action.reason,
      };
    });
  };

  for (const action of applicationOrder) {
    const changesClip = action.type !== "SET_CAPTION_TEXT" && action.type !== "SET_BACKGROUND_AUDIO_RANGE";
    const before = changesClip && project.captions.some((cue) => cue.videoClipId) ? cloneProject(project) : null;
    applyAction(action);
    if (before) {
      const splitClipId = action.type === "SPLIT_CLIP" ? action.targetId : undefined;
      project.captions = remapVideoCaptions(before, project, splitClipId).captions;
    }
  }

  const constraintEnforcement = verifyPostApplyConstraintInvariantsV1({
    preProject: context.project,
    candidateProject: project,
    constraintSet: context.constraintSet,
    expectedContext: context.constraintContext,
  });
  if (constraintEnforcement.status !== "ALLOWED") {
    throw new ConstraintEnforcementBlockedError(constraintEnforcement);
  }
  project.updatedAt = context.nowIso ?? new Date().toISOString();
  return {
    summary: plan.summary,
    project,
    audioSelection,
    applied: validated.actions.map((action) => ({ type: action.type, reason: action.reason })),
    unsupported: validated.unsupported,
    warnings: plan.warnings,
    ...(context.constraintSet ? { constraintEnforcement } : {}),
  };
}

export function createSafeEditorAIContext(
  project: EditorProject,
  ownedAssetIds: ReadonlySet<string>,
  audioSourceDurationMs: number,
  activeClipId?: string,
): string {
  const eligibleVisualClip = (track: EditorProject["tracks"][number], clip: TimelineClip) => {
    const matchingAssets = project.assets.filter((asset) => asset.id === clip.assetId);
    return (track.type === "video" || track.type === "broll")
      && clip.trackId === track.id
      && ownedAssetIds.has(clip.assetId)
      && matchingAssets.length === 1
      && matchingAssets[0].kind === clip.kind;
  };
  const currentClip = activeClipId
    ? project.tracks.flatMap((track) => track.clips
      .filter((clip) => clip.id === activeClipId && eligibleVisualClip(track, clip)))
    : [];
  const currentClipId = currentClip.length === 1 ? activeClipId : undefined;
  return JSON.stringify({
    videoDurationSeconds: project.durationMs / 1_000,
    audioSourceDurationSeconds: audioSourceDurationMs / 1_000,
    subtitleAvailability: project.captions.length > 0,
    subtitleTimingInvariant: "AUDIO_TIMING_ONLY",
    captions: (JSON.parse(createSafeCaptionAIContext(project)) as { captions: unknown[] }).captions,
    supportedActions: [...EXECUTABLE_EDITOR_ACTION_TYPES],
    ...(currentClipId ? { currentClipId } : {}),
    assets: project.assets
      .filter((asset) => ownedAssetIds.has(asset.id))
      .map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind, durationSeconds: asset.durationMs / 1_000 })),
    clips: project.tracks.flatMap((track) => track.clips
      .map((clip, index) => ({ clip, index }))
      .filter(({ clip }) => ownedAssetIds.has(clip.assetId))
      .sort((left, right) => (
        left.clip.timelineStartMs - right.clip.timelineStartMs || left.index - right.index
      ))
      .map(({ clip }) => clip)
      .map((clip) => ({
        id: clip.id,
        trackId: track.id,
        assetId: clip.assetId,
        kind: clip.kind,
        positionScaleEligible: eligibleVisualClip(track, clip),
        startSeconds: clip.timelineStartMs / 1_000,
        endSeconds: clip.timelineEndMs / 1_000,
        timelineDurationSeconds: (clip.timelineEndMs - clip.timelineStartMs) / 1_000,
        playbackRate: averageSpeed(clip.speedCurve),
        ...(eligibleVisualClip(track, clip) ? {
          x: clip.transform.x,
          y: clip.transform.y,
          scale: clip.transform.scale,
        } : {}),
      }))),
  });
}

/** Minimal caption-only context for future natural-language caption targeting. */
export function createSafeCaptionAIContext(project: EditorProject): string {
  const idCounts = new Map<string, number>();
  project.captions.forEach(({ id }) => idCounts.set(id, (idCounts.get(id) ?? 0) + 1));
  const captions = project.captions.map((caption, index) => ({
    id: caption.id,
    text: caption.text,
    startMs: caption.startMs,
    endMs: caption.endMs,
    ordinal: index + 1,
    eligible: Boolean(caption.id)
      && idCounts.get(caption.id) === 1
      && typeof caption.text === "string"
      && Number.isFinite(caption.startMs)
      && Number.isFinite(caption.endMs)
      && caption.endMs > caption.startMs,
  }));
  return JSON.stringify({ captions });
}
