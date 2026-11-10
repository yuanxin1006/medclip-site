import {
  parseConstraintSet,
  type ActiveConstraintV1,
  type ConstraintSetV1,
  type EnforcementReadyBindingV1,
} from "./editor-constraints.ts";
import {
  parseCreativeIntent,
  type CreativeIntentV1,
  type DurationPolicy,
  type HardConstraintRequestIntentClause,
} from "./editor-creative-intent.ts";
import type { EditorProject, TimelineClip } from "./editor-core.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import type { VideoSemanticAnalysis } from "./editor-video-semantic.ts";

export const CONSTRAINT_FEASIBILITY_SCHEMA_VERSION = 1 as const;
export const CONSTRAINT_CONFLICT_SCHEMA_VERSION = 1 as const;
export const NON_REMOVABLE_LOWER_BOUND_POLICY =
  "Only complete current clips wholly outside protected time are counted as compressible; gaps, partial clips, captions, and audio are conservatively non-removable." as const;

export type ConstraintFeasibilityStatus =
  | "FEASIBLE"
  | "FEASIBLE_WITH_TARGET_GAP"
  | "CONFIRMED_CONFLICT"
  | "NEEDS_USER_DECISION"
  | "NOT_EVALUABLE";

export type FeasibilityReadiness =
  | "READY_TO_PLAN"
  | "GROUNDING_REQUIRED"
  | "NEEDS_USER_DECISION"
  | "BLOCKED_NOT_EVALUABLE";

export type NormalizedProtectedRangeV1 = Readonly<{
  schemaVersion: typeof CONSTRAINT_FEASIBILITY_SCHEMA_VERSION;
  constraintId: string;
  coordinateSpace: "TIMELINE" | "SOURCE_ASSET";
  startMs: number;
  endMs: number;
  timelineMapping: Readonly<{
    startMs: number;
    endMs: number;
    mappingType: "DIRECT_TIMELINE" | "CURRENT_CLIP_OUTPUT" | "UNIQUE_LINEAR_SOURCE_PLACEMENT";
    clipId?: string;
  }>;
  sourceIdentity?: Readonly<{
    assetId: string;
    sourceStartMs: number;
    sourceEndMs: number;
  }>;
  movable: boolean;
  anchored: boolean;
  speedChangePolicy: "PROHIBITED" | "ALLOWED_REQUIRES_FUTURE_POLICY";
}>;

export type MergedProtectedTimelineRangeV1 = Readonly<{
  startMs: number;
  endMs: number;
  constraintIds: readonly string[];
}>;

export type ConstraintConflictType =
  | "DURATION_CONFLICT"
  | "PROTECTED_RANGE_CONFLICT"
  | "ACTION_PERMISSION_CONFLICT"
  | "AMBIGUOUS_REFERENCE"
  | "UNSUPPORTED_OPERATION";

export type ConstraintConflictStatus =
  | "CONFIRMED_CONFLICT"
  | "POSSIBLE_CONFLICT"
  | "NOT_EVALUABLE"
  | "RESOLVED_BY_USER";

export type FutureResolutionOptionV1 = Readonly<{
  type: "RELAX_TARGET_DURATION" | "OPTIMIZE_UNPROTECTED_ONLY" | "EDIT_REQUIREMENTS_MANUALLY";
  lifecycle: "METADATA_ONLY";
  canReachRequestedDuration?: boolean;
  maximumRecoverableMs?: number;
}>;

export type ConstraintConflictEvidenceV1 =
  | Readonly<{
    kind: "DURATION_GAP";
    requestedDurationMs: number;
    minimumFeasibleDurationMs: number;
    remainingGapMs: number;
    durationPolicy: DurationPolicy;
  }>
  | Readonly<{
    kind: "UNRESOLVED_REFERENCE";
    sourceClauseId: string;
    semanticKind: string;
    referenceText: string;
  }>
  | Readonly<{
    kind: "ENDING_NOT_AT_PROJECT_END";
    endingRangeEndMs: number;
    projectDurationMs: number;
  }>
  | Readonly<{
    kind: "UNSUPPORTED_TEMPORAL_OPERATION";
    operation: string;
    reason: string;
  }>
  | Readonly<{
    kind: "PERMISSION_COLLISION";
    actionType: string;
    reason: string;
  }>;

export type ConstraintConflictV1 = Readonly<{
  schemaVersion: typeof CONSTRAINT_CONFLICT_SCHEMA_VERSION;
  conflictId: string;
  type: ConstraintConflictType;
  status: ConstraintConflictStatus;
  involvedConstraintIds: readonly string[];
  evidence: ConstraintConflictEvidenceV1;
  possibleResolutions: readonly FutureResolutionOptionV1[];
}>;

export type ConstraintFeasibilityReportV1 = Readonly<{
  schemaVersion: typeof CONSTRAINT_FEASIBILITY_SCHEMA_VERSION;
  reportId: string;
  projectId: string;
  evaluatedProjectFingerprint: string;
  constraintSetId: string;
  constraintFingerprint: string;
  status: ConstraintFeasibilityStatus;
  readiness: FeasibilityReadiness;
  requestedDurationMs: number | null;
  durationPolicy: DurationPolicy | null;
  normalizedProtectedRanges: readonly NormalizedProtectedRangeV1[];
  mergedProtectedTimelineRanges: readonly MergedProtectedTimelineRangeV1[];
  minimumProtectedDurationMs: number | null;
  nonRemovableUnprotectedLowerBoundMs: number | null;
  compressibleUnprotectedDurationMs: number | null;
  minimumFeasibleDurationMs: number | null;
  remainingGapMs: number | null;
  lowerBoundPolicy: typeof NON_REMOVABLE_LOWER_BOUND_POLICY;
  conflicts: readonly ConstraintConflictV1[];
}>;

export type ConstraintFeasibilityInputV1 = Readonly<{
  project: EditorProject;
  intent: CreativeIntentV1;
  constraintSet: ConstraintSetV1;
  projectFingerprint: string;
  videoSemanticAnalyses?: readonly VideoSemanticAnalysis[];
}>;

class FeasibilityFailure extends Error {
  readonly operation: string;
  readonly constraintIds: readonly string[];

  constructor(operation: string, message: string, constraintIds: readonly string[] = []) {
    super(message);
    this.name = "FeasibilityFailure";
    this.operation = operation;
    this.constraintIds = constraintIds;
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!plainRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  return value;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createConstraintConflictV1(input: Readonly<{
  type: ConstraintConflictType;
  status: ConstraintConflictStatus;
  involvedConstraintIds: readonly string[];
  evidence: ConstraintConflictEvidenceV1;
  possibleResolutions?: readonly FutureResolutionOptionV1[];
}>): ConstraintConflictV1 {
  const material = {
    type: input.type,
    status: input.status,
    involvedConstraintIds: sortedUnique(input.involvedConstraintIds),
    evidence: input.evidence,
    possibleResolutions: input.possibleResolutions ?? [],
  };
  return deepFreeze({
    schemaVersion: CONSTRAINT_CONFLICT_SCHEMA_VERSION,
    conflictId: `conflict-v1-${fnv1a(stable(material))}`,
    ...material,
  });
}

const CONFLICT_ORDER: Readonly<Record<ConstraintConflictType, number>> = Object.freeze({
  AMBIGUOUS_REFERENCE: 0,
  PROTECTED_RANGE_CONFLICT: 1,
  ACTION_PERMISSION_CONFLICT: 2,
  DURATION_CONFLICT: 3,
  UNSUPPORTED_OPERATION: 4,
});

function sortConflicts(conflicts: readonly ConstraintConflictV1[]): readonly ConstraintConflictV1[] {
  return [...conflicts].sort((left, right) => (
    CONFLICT_ORDER[left.type] - CONFLICT_ORDER[right.type]
    || compareText(left.conflictId, right.conflictId)
  ));
}

export function mergeProtectedTimelineRangesV1(
  ranges: readonly Pick<NormalizedProtectedRangeV1, "constraintId" | "timelineMapping">[],
): readonly MergedProtectedTimelineRangeV1[] {
  const sorted = ranges.map((range) => ({
    startMs: range.timelineMapping.startMs,
    endMs: range.timelineMapping.endMs,
    constraintIds: [range.constraintId],
  })).sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs
    || compareText(left.constraintIds[0], right.constraintIds[0]));
  const merged: { startMs: number; endMs: number; constraintIds: string[] }[] = [];
  for (const range of sorted) {
    const current = merged.at(-1);
    // Half-open ranges merge when they overlap or touch. This makes adjacency explicit and deterministic.
    if (current && range.startMs <= current.endMs) {
      current.endMs = Math.max(current.endMs, range.endMs);
      current.constraintIds = [...new Set([...current.constraintIds, ...range.constraintIds])].sort();
    } else {
      merged.push({ ...range, constraintIds: [...range.constraintIds] });
    }
  }
  return deepFreeze(merged);
}

function intervalDuration(ranges: readonly { startMs: number; endMs: number }[]): number {
  return ranges.reduce((total, range) => total + range.endMs - range.startMs, 0);
}

function allClips(project: EditorProject): readonly TimelineClip[] {
  return project.tracks.flatMap((track) => track.clips);
}

function exactClip(project: EditorProject, clipId: string, constraintId: string): TimelineClip {
  const matches = allClips(project).filter((clip) => clip.id === clipId);
  if (matches.length !== 1) {
    throw new FeasibilityFailure("PROTECT_CLIP_MAPPING", "Protected clip is missing or not unique.", [constraintId]);
  }
  return matches[0];
}

function assertTimelineInterval(startMs: number, endMs: number, project: EditorProject, constraintId: string): void {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
    || startMs < 0 || endMs <= startMs || endMs > project.durationMs) {
    throw new FeasibilityFailure("TIMELINE_RANGE_VALIDATION", "Protected timeline range is no longer valid.", [constraintId]);
  }
}

function constantSpeed(clip: TimelineClip): boolean {
  if (!Array.isArray(clip.speedCurve) || clip.speedCurve.length === 0) return false;
  return clip.speedCurve.every((point) => Number.isFinite(point.rate) && point.rate === clip.speedCurve[0].rate);
}

function mapSourceRange(
  project: EditorProject,
  assetId: string,
  sourceStartMs: number,
  sourceEndMs: number,
  constraintId: string,
): Readonly<{ startMs: number; endMs: number; clipId: string }> {
  const assetMatches = project.assets.filter((asset) => asset.id === assetId);
  if (assetMatches.length !== 1) {
    throw new FeasibilityFailure("SOURCE_IDENTITY", "Exact source asset identity is missing or ambiguous.", [constraintId]);
  }
  const asset = assetMatches[0];
  if (!Number.isSafeInteger(sourceStartMs) || !Number.isSafeInteger(sourceEndMs)
    || sourceStartMs < 0 || sourceEndMs <= sourceStartMs || asset.durationMs <= 0
    || sourceEndMs > asset.durationMs) {
    throw new FeasibilityFailure("SOURCE_RANGE_VALIDATION", "Source range is invalid for its exact asset.", [constraintId]);
  }
  const placements = allClips(project).filter((clip) => (
    clip.assetId === assetId
    && clip.sourceInMs <= sourceStartMs
    && clip.sourceOutMs >= sourceEndMs
  ));
  if (placements.length !== 1) {
    throw new FeasibilityFailure(
      "SOURCE_TO_TIMELINE_MAPPING",
      placements.length === 0
        ? "No trusted current clip maps the protected source range."
        : "Multiple current placements make the source-to-timeline mapping ambiguous.",
      [constraintId],
    );
  }
  const clip = placements[0];
  if (!constantSpeed(clip)) {
    throw new FeasibilityFailure(
      "NONLINEAR_SOURCE_TO_TIMELINE_MAPPING",
      "Nonlinear speed curves are unsupported for durable source-range feasibility mapping.",
      [constraintId],
    );
  }
  const sourceDurationMs = clip.sourceOutMs - clip.sourceInMs;
  const timelineDurationMs = clip.timelineEndMs - clip.timelineStartMs;
  if (sourceDurationMs <= 0 || timelineDurationMs <= 0) {
    throw new FeasibilityFailure("SOURCE_TO_TIMELINE_MAPPING", "Clip source mapping has a non-positive span.", [constraintId]);
  }
  const mappedStart = clip.timelineStartMs
    + (sourceStartMs - clip.sourceInMs) * timelineDurationMs / sourceDurationMs;
  const mappedEnd = clip.timelineStartMs
    + (sourceEndMs - clip.sourceInMs) * timelineDurationMs / sourceDurationMs;
  if (!Number.isSafeInteger(mappedStart) || !Number.isSafeInteger(mappedEnd)) {
    throw new FeasibilityFailure(
      "AMBIGUOUS_TEMPORAL_TRANSFORMATION",
      "Source boundaries do not map to exact integer timeline milliseconds.",
      [constraintId],
    );
  }
  assertTimelineInterval(mappedStart, mappedEnd, project, constraintId);
  return { startMs: mappedStart, endMs: mappedEnd, clipId: clip.id };
}

function semanticEvidenceCurrent(
  input: ConstraintFeasibilityInputV1,
  binding: Extract<EnforcementReadyBindingV1, { bindingType: "VIDEO_SEMANTIC_SOURCE_RANGE" }>,
  constraintId: string,
): void {
  const analyses = (input.videoSemanticAnalyses ?? []).filter((analysis) => analysis.assetId === binding.assetId);
  if (analyses.length === 0) {
    throw new FeasibilityFailure("SEMANTIC_ANALYSIS", "Required semantic evidence is missing.", [constraintId]);
  }
  const current = analyses.filter((analysis) => analysis.analysisVersion === binding.analysisVersion);
  if (current.length !== 1) {
    throw new FeasibilityFailure("SEMANTIC_ANALYSIS_VERSION", "Required semantic evidence is stale or ambiguous.", [constraintId]);
  }
  if (binding.endMs > current[0].assetDurationMs) {
    throw new FeasibilityFailure("SEMANTIC_SOURCE_RANGE", "Semantic range exceeds current analyzed source.", [constraintId]);
  }
}

function normalizeConstraint(
  input: ConstraintFeasibilityInputV1,
  constraint: ActiveConstraintV1,
  binding: EnforcementReadyBindingV1,
): NormalizedProtectedRangeV1 {
  const movable = constraint.type !== "PRESERVE_ENDING" && constraint.permissions.allowMove;
  const anchored = constraint.type === "PRESERVE_ENDING" || !constraint.permissions.allowMove;
  const speedChangePolicy = constraint.permissions.allowSpeedChange
    ? "ALLOWED_REQUIRES_FUTURE_POLICY" as const
    : "PROHIBITED" as const;
  if (binding.bindingType === "CAPTION") {
    throw new FeasibilityFailure("CAPTION_ACTIVATION", "A caption must be promoted to a timeline range before activation.", [constraint.constraintId]);
  }
  if (binding.bindingType === "CLIP") {
    const clip = exactClip(input.project, binding.clipId, constraint.constraintId);
    if (clip.assetId !== binding.assetId || clip.trackId !== binding.trackId) {
      throw new FeasibilityFailure("PROTECT_CLIP_IDENTITY", "Protected clip asset or track identity has changed.", [constraint.constraintId]);
    }
    if (!input.project.assets.some((asset) => asset.id === clip.assetId)) {
      throw new FeasibilityFailure("SOURCE_IDENTITY", "Protected clip asset no longer exists.", [constraint.constraintId]);
    }
    assertTimelineInterval(clip.timelineStartMs, clip.timelineEndMs, input.project, constraint.constraintId);
    return deepFreeze({
      schemaVersion: CONSTRAINT_FEASIBILITY_SCHEMA_VERSION,
      constraintId: constraint.constraintId,
      coordinateSpace: "TIMELINE",
      startMs: clip.timelineStartMs,
      endMs: clip.timelineEndMs,
      timelineMapping: {
        startMs: clip.timelineStartMs,
        endMs: clip.timelineEndMs,
        mappingType: "CURRENT_CLIP_OUTPUT",
        clipId: clip.id,
      },
      sourceIdentity: { assetId: clip.assetId, sourceStartMs: clip.sourceInMs, sourceEndMs: clip.sourceOutMs },
      movable,
      anchored,
      speedChangePolicy,
    });
  }
  if (binding.bindingType === "TIME_RANGE" && binding.range.coordinateSpace === "TIMELINE") {
    assertTimelineInterval(binding.range.startMs, binding.range.endMs, input.project, constraint.constraintId);
    return deepFreeze({
      schemaVersion: CONSTRAINT_FEASIBILITY_SCHEMA_VERSION,
      constraintId: constraint.constraintId,
      coordinateSpace: "TIMELINE",
      startMs: binding.range.startMs,
      endMs: binding.range.endMs,
      timelineMapping: {
        startMs: binding.range.startMs,
        endMs: binding.range.endMs,
        mappingType: "DIRECT_TIMELINE",
      },
      movable,
      anchored,
      speedChangePolicy,
    });
  }
  let source: { assetId: string; startMs: number; endMs: number };
  if (binding.bindingType === "TIME_RANGE") {
    if (binding.range.coordinateSpace !== "SOURCE_ASSET") {
      throw new FeasibilityFailure("RANGE_NORMALIZATION", "Timeline range did not normalize directly.", [constraint.constraintId]);
    }
    source = { assetId: binding.range.assetId, startMs: binding.range.startMs, endMs: binding.range.endMs };
  } else {
    source = { assetId: binding.assetId, startMs: binding.startMs, endMs: binding.endMs };
  }
  if (binding.bindingType === "VIDEO_SEMANTIC_SOURCE_RANGE") {
    semanticEvidenceCurrent(input, binding, constraint.constraintId);
  }
  const mapped = mapSourceRange(input.project, source.assetId, source.startMs, source.endMs, constraint.constraintId);
  return deepFreeze({
    schemaVersion: CONSTRAINT_FEASIBILITY_SCHEMA_VERSION,
    constraintId: constraint.constraintId,
    coordinateSpace: "SOURCE_ASSET",
    startMs: source.startMs,
    endMs: source.endMs,
    timelineMapping: {
      startMs: mapped.startMs,
      endMs: mapped.endMs,
      mappingType: "UNIQUE_LINEAR_SOURCE_PLACEMENT",
      clipId: mapped.clipId,
    },
    sourceIdentity: { assetId: source.assetId, sourceStartMs: source.startMs, sourceEndMs: source.endMs },
    movable,
    anchored,
    speedChangePolicy,
  });
}

function intervalsOverlap(
  left: Readonly<{ startMs: number; endMs: number }>,
  right: Readonly<{ startMs: number; endMs: number }>,
): boolean {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}

function mergedIntervals(ranges: readonly { startMs: number; endMs: number }[]): readonly { startMs: number; endMs: number }[] {
  const sorted = [...ranges].sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  const merged: { startMs: number; endMs: number }[] = [];
  for (const range of sorted) {
    const current = merged.at(-1);
    if (current && range.startMs <= current.endMs) current.endMs = Math.max(current.endMs, range.endMs);
    else merged.push({ ...range });
  }
  return merged;
}

function intersectionDuration(
  left: readonly { startMs: number; endMs: number }[],
  right: readonly { startMs: number; endMs: number }[],
): number {
  let total = 0;
  for (const a of left) for (const b of right) {
    total += Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
  }
  return total;
}

function lowerBounds(
  project: EditorProject,
  protectedRanges: readonly MergedProtectedTimelineRangeV1[],
): Readonly<{
  minimumProtectedDurationMs: number;
  nonRemovableUnprotectedLowerBoundMs: number;
  compressibleUnprotectedDurationMs: number;
  minimumFeasibleDurationMs: number;
}> {
  const minimumProtectedDurationMs = intervalDuration(protectedRanges);
  const totalUnprotectedMs = Math.max(0, project.durationMs - minimumProtectedDurationMs);
  const removableWholeClips = allClips(project).filter((clip) => (
    Number.isSafeInteger(clip.timelineStartMs)
    && Number.isSafeInteger(clip.timelineEndMs)
    && clip.timelineStartMs >= 0
    && clip.timelineEndMs > clip.timelineStartMs
    && clip.timelineEndMs <= project.durationMs
    && project.assets.some((asset) => asset.id === clip.assetId)
    && !protectedRanges.some((range) => intervalsOverlap(
      { startMs: clip.timelineStartMs, endMs: clip.timelineEndMs },
      range,
    ))
  )).map((clip) => ({ startMs: clip.timelineStartMs, endMs: clip.timelineEndMs }));
  const compressibleCoverage = mergedIntervals(removableWholeClips);
  const protectedCoverage = protectedRanges.map((range) => ({ startMs: range.startMs, endMs: range.endMs }));
  const compressibleUnprotectedDurationMs = Math.max(
    0,
    intervalDuration(compressibleCoverage) - intersectionDuration(compressibleCoverage, protectedCoverage),
  );
  const nonRemovableUnprotectedLowerBoundMs = Math.max(0, totalUnprotectedMs - compressibleUnprotectedDurationMs);
  return {
    minimumProtectedDurationMs,
    nonRemovableUnprotectedLowerBoundMs,
    compressibleUnprotectedDurationMs,
    minimumFeasibleDurationMs: minimumProtectedDurationMs + nonRemovableUnprotectedLowerBoundMs,
  };
}

function durationGoal(intent: CreativeIntentV1): Readonly<{ durationMs: number; policy: DurationPolicy }> | undefined {
  const goals = intent.clauses.filter((clause): clause is Extract<CreativeIntentV1["clauses"][number], { kind: "GOAL" }> => (
    clause.kind === "GOAL" && clause.payload.type === "TARGET_DURATION"
  ));
  if (goals.length > 1) {
    throw new FeasibilityFailure("MULTIPLE_DURATION_GOALS", "Multiple duration goals are not deterministically ordered in V1.");
  }
  return goals[0]?.payload;
}

function ambiguousReferenceConflict(clause: HardConstraintRequestIntentClause): ConstraintConflictV1 {
  return createConstraintConflictV1({
    type: "AMBIGUOUS_REFERENCE",
    status: "POSSIBLE_CONFLICT",
    involvedConstraintIds: [],
    evidence: {
      kind: "UNRESOLVED_REFERENCE",
      sourceClauseId: clause.clauseId,
      semanticKind: clause.payload.reference.semanticKind,
      referenceText: clause.payload.reference.referenceText,
    },
    possibleResolutions: [{ type: "EDIT_REQUIREMENTS_MANUALLY", lifecycle: "METADATA_ONLY" }],
  });
}

function unsupportedConflict(failure: FeasibilityFailure): ConstraintConflictV1 {
  return createConstraintConflictV1({
    type: "UNSUPPORTED_OPERATION",
    status: "NOT_EVALUABLE",
    involvedConstraintIds: failure.constraintIds,
    evidence: {
      kind: "UNSUPPORTED_TEMPORAL_OPERATION",
      operation: failure.operation,
      reason: failure.message,
    },
    possibleResolutions: [{ type: "EDIT_REQUIREMENTS_MANUALLY", lifecycle: "METADATA_ONLY" }],
  });
}

function reportIdentity(
  report: Omit<ConstraintFeasibilityReportV1, "reportId" | "schemaVersion">,
): string {
  return `feasibility-report-v1-${fnv1a(stable(report))}`;
}

function finalReport(
  report: Omit<ConstraintFeasibilityReportV1, "reportId" | "schemaVersion">,
): ConstraintFeasibilityReportV1 {
  return deepFreeze({
    schemaVersion: CONSTRAINT_FEASIBILITY_SCHEMA_VERSION,
    reportId: reportIdentity(report),
    ...report,
  });
}

function invalidReport(
  input: ConstraintFeasibilityInputV1,
  projectFingerprint: string,
  constraintSet: ConstraintSetV1 | undefined,
  conflicts: readonly ConstraintConflictV1[],
): ConstraintFeasibilityReportV1 {
  const sorted = sortConflicts(conflicts);
  return finalReport({
    projectId: input.project?.id ?? "invalid-project",
    evaluatedProjectFingerprint: projectFingerprint,
    constraintSetId: constraintSet?.constraintSetId ?? "invalid-constraint-set",
    constraintFingerprint: constraintSet?.constraintFingerprint ?? "invalid-constraint-fingerprint",
    status: "NOT_EVALUABLE",
    readiness: "BLOCKED_NOT_EVALUABLE",
    requestedDurationMs: null,
    durationPolicy: null,
    normalizedProtectedRanges: [],
    mergedProtectedTimelineRanges: [],
    minimumProtectedDurationMs: null,
    nonRemovableUnprotectedLowerBoundMs: null,
    compressibleUnprotectedDurationMs: null,
    minimumFeasibleDurationMs: null,
    remainingGapMs: null,
    lowerBoundPolicy: NON_REMOVABLE_LOWER_BOUND_POLICY,
    conflicts: sorted,
  });
}

/**
 * Pure V2.3C feasibility analysis. It does not mutate the timeline, authorize edits,
 * resolve conflicts, call providers, or weaken active hard constraints.
 */
export function evaluateConstraintFeasibilityV1(
  input: ConstraintFeasibilityInputV1,
): ConstraintFeasibilityReportV1 {
  let constraintSet: ConstraintSetV1 | undefined;
  let intent: CreativeIntentV1;
  const actualFingerprint = input.project ? createEditorProjectFingerprint(input.project) : "invalid-project-fingerprint";
  try {
    intent = parseCreativeIntent(input.intent);
    constraintSet = parseConstraintSet(input.constraintSet);
    if (!input.project || !Number.isSafeInteger(input.project.durationMs) || input.project.durationMs < 0
      || !Array.isArray(input.project.assets) || !Array.isArray(input.project.tracks)
      || !Array.isArray(input.project.captions)) {
      throw new FeasibilityFailure("PROJECT_CONTEXT", "Editor project is malformed.");
    }
    if (intent.projectId !== input.project.id || constraintSet.projectId !== input.project.id
      || constraintSet.intentVersionId !== intent.intentId) {
      throw new FeasibilityFailure("PROJECT_IDENTITY", "Intent, ConstraintSet, and project identity do not match.");
    }
    if (input.projectFingerprint !== actualFingerprint
      || constraintSet.validatedAgainstProjectFingerprint !== actualFingerprint) {
      throw new FeasibilityFailure("PROJECT_FINGERPRINT", "ConstraintSet is stale for the current project fingerprint.");
    }
  } catch (error) {
    const failure = error instanceof FeasibilityFailure
      ? error
      : new FeasibilityFailure("INPUT_VALIDATION", error instanceof Error ? error.message : "Feasibility input is invalid.");
    return invalidReport(input, actualFingerprint, constraintSet, [unsupportedConflict(failure)]);
  }

  const conflicts: ConstraintConflictV1[] = [];
  const activeClauseIds = new Set(constraintSet.activeConstraints.map((constraint) => constraint.sourceClauseId));
  const unresolvedClauses = intent.clauses.filter(
    (clause): clause is HardConstraintRequestIntentClause => (
      clause.kind === "HARD_CONSTRAINT_REQUEST" && !activeClauseIds.has(clause.clauseId)
    ),
  );
  conflicts.push(...unresolvedClauses.map(ambiguousReferenceConflict));

  const bindingById = new Map(constraintSet.confirmedBindings.map((binding) => [binding.bindingId, binding]));
  const normalized: NormalizedProtectedRangeV1[] = [];
  const failures: FeasibilityFailure[] = [];
  for (const constraint of constraintSet.activeConstraints) {
    const binding = bindingById.get(constraint.bindingId);
    if (!binding) {
      failures.push(new FeasibilityFailure("CONSTRAINT_BINDING", "Active constraint binding is missing.", [constraint.constraintId]));
      continue;
    }
    try {
      normalized.push(normalizeConstraint(input, constraint, binding));
    } catch (error) {
      failures.push(error instanceof FeasibilityFailure
        ? error
        : new FeasibilityFailure("RANGE_NORMALIZATION", error instanceof Error ? error.message : "Range normalization failed.", [constraint.constraintId]));
    }
  }
  for (const range of normalized) {
    if (range.speedChangePolicy === "ALLOWED_REQUIRES_FUTURE_POLICY") {
      failures.push(new FeasibilityFailure(
        "PROTECTED_SPEED_CHANGE_LOWER_BOUND",
        "A speed-change permission lacks a V1 deterministic protected-duration lower-bound policy.",
        [range.constraintId],
      ));
    }
  }
  if (failures.length) {
    conflicts.push(...failures.map(unsupportedConflict));
    return finalReport({
      projectId: input.project.id,
      evaluatedProjectFingerprint: actualFingerprint,
      constraintSetId: constraintSet.constraintSetId,
      constraintFingerprint: constraintSet.constraintFingerprint,
      status: "NOT_EVALUABLE",
      readiness: "BLOCKED_NOT_EVALUABLE",
      requestedDurationMs: null,
      durationPolicy: null,
      normalizedProtectedRanges: normalized.sort((left, right) => (
        left.timelineMapping.startMs - right.timelineMapping.startMs || compareText(left.constraintId, right.constraintId)
      )),
      mergedProtectedTimelineRanges: [],
      minimumProtectedDurationMs: null,
      nonRemovableUnprotectedLowerBoundMs: null,
      compressibleUnprotectedDurationMs: null,
      minimumFeasibleDurationMs: null,
      remainingGapMs: null,
      lowerBoundPolicy: NON_REMOVABLE_LOWER_BOUND_POLICY,
      conflicts: sortConflicts(conflicts),
    });
  }

  normalized.sort((left, right) => left.timelineMapping.startMs - right.timelineMapping.startMs
    || left.timelineMapping.endMs - right.timelineMapping.endMs
    || compareText(left.constraintId, right.constraintId));
  const merged = mergeProtectedTimelineRangesV1(normalized);
  const bounds = lowerBounds(input.project, merged);

  for (const constraint of constraintSet.activeConstraints.filter((item) => item.type === "PRESERVE_ENDING")) {
    const range = normalized.find((item) => item.constraintId === constraint.constraintId);
    if (range && range.timelineMapping.endMs !== input.project.durationMs) {
      conflicts.push(createConstraintConflictV1({
        type: "PROTECTED_RANGE_CONFLICT",
        status: "CONFIRMED_CONFLICT",
        involvedConstraintIds: [constraint.constraintId],
        evidence: {
          kind: "ENDING_NOT_AT_PROJECT_END",
          endingRangeEndMs: range.timelineMapping.endMs,
          projectDurationMs: input.project.durationMs,
        },
        possibleResolutions: [{ type: "EDIT_REQUIREMENTS_MANUALLY", lifecycle: "METADATA_ONLY" }],
      }));
    }
  }

  let goal: Readonly<{ durationMs: number; policy: DurationPolicy }> | undefined;
  try {
    goal = durationGoal(intent);
  } catch (error) {
    const failure = error instanceof FeasibilityFailure
      ? error
      : new FeasibilityFailure("DURATION_GOAL", "Duration goal is not evaluable.");
    conflicts.push(unsupportedConflict(failure));
    return finalReport({
      projectId: input.project.id,
      evaluatedProjectFingerprint: actualFingerprint,
      constraintSetId: constraintSet.constraintSetId,
      constraintFingerprint: constraintSet.constraintFingerprint,
      status: "NOT_EVALUABLE",
      readiness: "BLOCKED_NOT_EVALUABLE",
      requestedDurationMs: null,
      durationPolicy: null,
      normalizedProtectedRanges: normalized,
      mergedProtectedTimelineRanges: merged,
      ...bounds,
      remainingGapMs: null,
      lowerBoundPolicy: NON_REMOVABLE_LOWER_BOUND_POLICY,
      conflicts: sortConflicts(conflicts),
    });
  }

  const durationPolicyConstrainsMaximum = Boolean(
    goal && ["TARGET", "APPROXIMATE_TARGET", "MAXIMUM", "EXACT"].includes(goal.policy),
  );
  const remainingGapMs = durationPolicyConstrainsMaximum && goal
    ? Math.max(0, bounds.minimumFeasibleDurationMs - goal.durationMs)
    : 0;
  if (goal && remainingGapMs > 0) {
    conflicts.push(createConstraintConflictV1({
      type: "DURATION_CONFLICT",
      status: "CONFIRMED_CONFLICT",
      involvedConstraintIds: constraintSet.activeConstraints.map((constraint) => constraint.constraintId),
      evidence: {
        kind: "DURATION_GAP",
        requestedDurationMs: goal.durationMs,
        minimumFeasibleDurationMs: bounds.minimumFeasibleDurationMs,
        remainingGapMs,
        durationPolicy: goal.policy,
      },
      possibleResolutions: [
        { type: "RELAX_TARGET_DURATION", lifecycle: "METADATA_ONLY" },
        {
          type: "OPTIMIZE_UNPROTECTED_ONLY",
          lifecycle: "METADATA_ONLY",
          canReachRequestedDuration: false,
          maximumRecoverableMs: bounds.compressibleUnprotectedDurationMs,
        },
        { type: "EDIT_REQUIREMENTS_MANUALLY", lifecycle: "METADATA_ONLY" },
      ],
    }));
  }

  const hasProtectedRangeConflict = conflicts.some((conflict) => conflict.type === "PROTECTED_RANGE_CONFLICT");
  let status: ConstraintFeasibilityStatus;
  let readiness: FeasibilityReadiness;
  if (unresolvedClauses.length) {
    status = "NEEDS_USER_DECISION";
    readiness = intent.groundingState === "CANDIDATE_BINDING" ? "GROUNDING_REQUIRED" : "NEEDS_USER_DECISION";
  } else if (hasProtectedRangeConflict || (remainingGapMs > 0 && goal && ["MAXIMUM", "EXACT"].includes(goal.policy))) {
    status = "CONFIRMED_CONFLICT";
    readiness = "NEEDS_USER_DECISION";
  } else if (remainingGapMs > 0) {
    status = "FEASIBLE_WITH_TARGET_GAP";
    readiness = "NEEDS_USER_DECISION";
  } else {
    status = "FEASIBLE";
    readiness = "READY_TO_PLAN";
  }

  return finalReport({
    projectId: input.project.id,
    evaluatedProjectFingerprint: actualFingerprint,
    constraintSetId: constraintSet.constraintSetId,
    constraintFingerprint: constraintSet.constraintFingerprint,
    status,
    readiness,
    requestedDurationMs: goal?.durationMs ?? null,
    durationPolicy: goal?.policy ?? null,
    normalizedProtectedRanges: normalized,
    mergedProtectedTimelineRanges: merged,
    ...bounds,
    remainingGapMs: goal ? remainingGapMs : null,
    lowerBoundPolicy: NON_REMOVABLE_LOWER_BOUND_POLICY,
    conflicts: sortConflicts(conflicts),
  });
}
