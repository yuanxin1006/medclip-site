import {
  AIEditingPlanValidationError,
  applyAIEditingPlan,
  parseAIEditingPlan,
  type EditorAIApplyResult,
  type EditorAIEditingPlan,
  type EditorAIPlanAction,
} from "./editor-ai-requirements.ts";
import {
  NARRATIVE_ACTION_COMPILER_LIMITS,
  type CompiledNarrativeActionPlan,
  type IntervalActionLink,
} from "./editor-narrative-action-compiler.ts";
import { cloneProject, type EditorProject, type TimelineClip } from "./editor-core.ts";
import { parseConstraintSet, type ConstraintSetV1 } from "./editor-constraints.ts";
import {
  ConstraintEnforcementBlockedError,
  validateConstraintContextV1,
  verifyPostApplyConstraintInvariantsV1,
  type ConstraintEnforcementResultV1,
} from "./editor-constraint-enforcement.ts";

/**
 * V2.0D is an atomic boundary around the existing applyAIEditingPlan path.
 * It does not implement action mutations and it does not write editor history.
 * A successful result exposes the one pre-plan snapshot that existing UI
 * history can record as a single logical undo boundary.
 */

export const COMPILED_PLAN_EXECUTION_SCHEMA_VERSION = 1 as const;
export const COMPILED_PLAN_EXECUTION_LIMITS = Object.freeze({
  maxActions: NARRATIVE_ACTION_COMPILER_LIMITS.maxCanonicalActions,
  maxIdentityLength: NARRATIVE_ACTION_COMPILER_LIMITS.maxIdLength,
});

export type CompiledPlanExecutionInput = Readonly<{
  preExecutionProject: EditorProject;
  compiledPlan: CompiledNarrativeActionPlan;
  ownedAssetIds: readonly string[];
  expectedProjectId: string;
  expectedProjectUpdatedAt: string;
  executionUpdatedAt: string;
  constraintContext?: Readonly<{
    intentVersionId: string;
    constraintSetId: string;
    constraintFingerprint: string;
    constraintSet: ConstraintSetV1;
  }>;
  rejectedOperationTuples?: readonly string[];
}>;

export type CompiledActionExecutionStatus =
  | "APPLIED"
  | "NO_OP"
  | "FAILED"
  | "ROLLED_BACK"
  | "NOT_RUN";

export type CompiledActionExecutionEvidence = Readonly<{
  actionIndex: number;
  actionType: string;
  targetId: string;
  intervalId: string;
  selectedAssetId?: string;
  status: CompiledActionExecutionStatus;
  failureCode?: CompiledPlanExecutionFailureCode;
}>;

export type ProjectClipChangeEvidence = Readonly<{
  clipId: string;
  beforeAssetId: string;
  afterAssetId: string;
  changedFields: readonly string[];
}>;

export type ProjectPreservationEvidence = Readonly<{
  projectIdentityPreserved: boolean;
  projectSchemaPreserved: boolean;
  projectTitlePreserved: boolean;
  projectDurationPreserved: boolean;
  projectRatioPreserved: boolean;
  captionsPreserved: boolean;
  audioSelectionPreserved: boolean;
  assetRegistryPreserved: boolean;
  trackIdentityAndOrderPreserved: boolean;
  clipIdentityAndOrderPreserved: boolean;
  unrelatedClipsPreserved: boolean;
  targetTimelineAndTransformPreserved: boolean;
  protectedFieldsPreserved: boolean;
  unexpectedChanges: readonly string[];
  clipChanges: readonly ProjectClipChangeEvidence[];
}>;

export type CompiledPlanExecutionFailureCode =
  | "COMPILED_PLAN_NOT_VALIDATED"
  | "COMPILED_PLAN_VALIDATION_BREACH"
  | "PROJECT_IDENTITY_MISMATCH"
  | "PROJECT_VERSION_MISMATCH"
  | "ACTION_BATCH_LIMIT"
  | "CONFLICTING_BATCH"
  | "CANONICAL_APPLY_REJECTED"
  | "ACTION_APPLICATION_FAILED"
  | "PRESERVATION_CONTRACT_BREACH"
  | "HARD_CONSTRAINT_BLOCKED"
  | "STALE_CONSTRAINT_CONTEXT"
  | "POST_APPLY_CONSTRAINT_VIOLATION";

export type CompiledPlanExecutionResult = Readonly<{
  schemaVersion: typeof COMPILED_PLAN_EXECUTION_SCHEMA_VERSION;
  status: "APPLIED" | "NO_OP" | "FAILED";
  preProject: EditorProject;
  postProject: EditorProject;
  actionResults: readonly CompiledActionExecutionEvidence[];
  appliedActionCount: number;
  noOpActionCount: number;
  failedActionIndex?: number;
  failureCode?: CompiledPlanExecutionFailureCode;
  intentActionMap: readonly IntervalActionLink[];
  preservation: ProjectPreservationEvidence;
  executionFingerprint: string;
  historyBoundary: Readonly<{
    strategy: "EXISTING_PROJECT_SNAPSHOT";
    shouldRecordPlanUndo: boolean;
  }>;
  constraintEnforcement?: ConstraintEnforcementResultV1;
}>;

export class CompiledPlanExecutionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompiledPlanExecutionInputError";
  }
}

/** A typed abort supports controlled integration failures and deterministic tests. */
export class CompiledPlanExecutionAbort extends Error {
  readonly failureCode: CompiledPlanExecutionFailureCode;
  readonly failedActionIndex?: number;

  constructor(
    failureCode: CompiledPlanExecutionFailureCode,
    message: string,
    failedActionIndex?: number,
  ) {
    super(message);
    this.name = "CompiledPlanExecutionAbort";
    this.failureCode = failureCode;
    this.failedActionIndex = failedActionIndex;
  }
}

export type CompiledPlanApplyFunction = (
  value: unknown,
  context: Parameters<typeof applyAIEditingPlan>[1],
) => EditorAIApplyResult;

type ExecutionDependencies = Readonly<{
  applyPlan?: CompiledPlanApplyFunction;
}>;

const INPUT_KEYS = [
  "preExecutionProject",
  "compiledPlan",
  "ownedAssetIds",
  "expectedProjectId",
  "expectedProjectUpdatedAt",
  "executionUpdatedAt",
] as const;
const OPTIONAL_INPUT_KEYS = ["constraintContext", "rejectedOperationTuples"] as const;

const COMPILED_PLAN_KEYS = [
  "schemaVersion",
  "mode",
  "status",
  "sourceNarrativeReference",
  "canonicalPlan",
  "intervalActionMap",
  "unresolvedIntervalIds",
  "unsupportedIntervalIds",
  "warnings",
  "errors",
  "canonicalValidation",
] as const;

const MATCH_MUTABLE_CLIP_FIELDS = new Set([
  "assetId",
  "name",
  "kind",
  "sourceInMs",
  "sourceOutMs",
  "speedCurve",
  "reason",
]);

function inputFail(message: string): never {
  throw new CompiledPlanExecutionInputError(message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string, optional: readonly string[] = []): void {
  const actual = Object.keys(value);
  const allowed = new Set([...keys, ...optional]);
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || actual.some((key) => !allowed.has(key))) {
    inputFail(`${label} contains missing or unknown fields.`);
  }
}

function safeIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > COMPILED_PLAN_EXECUTION_LIMITS.maxIdentityLength
    || /\u0000/.test(value)
    || /^(?:blob:|file:|https?:)/i.test(value)
    || /[\\/]/.test(value)
  ) {
    inputFail(`${label} must be a bounded trusted identity.`);
  }
  return value;
}

function exactIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 64) {
    inputFail(`${label} must be an ISO timestamp.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    inputFail(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function validateProjectShape(value: unknown): asserts value is EditorProject {
  if (!plainRecord(value)) inputFail("preExecutionProject must be a project object.");
  if (
    value.schemaVersion !== 2
    || typeof value.id !== "string"
    || !value.id
    || typeof value.updatedAt !== "string"
    || !Number.isFinite(value.durationMs)
    || typeof value.ratio !== "string"
    || !plainRecord(value.audioSelection)
    || !Array.isArray(value.assets)
    || !Array.isArray(value.tracks)
    || !Array.isArray(value.captions)
  ) {
    inputFail("preExecutionProject is not a valid EditorProject shape.");
  }
}

export function parseCompiledPlanExecutionInput(value: unknown): CompiledPlanExecutionInput {
  if (!plainRecord(value)) inputFail("Execution input must be an object.");
  exactKeys(value, INPUT_KEYS, "Execution input", OPTIONAL_INPUT_KEYS);
  validateProjectShape(value.preExecutionProject);
  if (!plainRecord(value.compiledPlan)) inputFail("compiledPlan must be an object.");
  if (!Array.isArray(value.ownedAssetIds)) inputFail("ownedAssetIds must be an array.");
  const ownedAssetIds = value.ownedAssetIds.map((id, index) => safeIdentity(id, `ownedAssetIds[${index}]`));
  if (new Set(ownedAssetIds).size !== ownedAssetIds.length) {
    inputFail("ownedAssetIds must not contain duplicates.");
  }
  let constraintContext: CompiledPlanExecutionInput["constraintContext"];
  if (value.constraintContext !== undefined) {
    if (!plainRecord(value.constraintContext)) inputFail("constraintContext must be an object.");
    exactKeys(value.constraintContext, ["intentVersionId", "constraintSetId", "constraintFingerprint", "constraintSet"], "constraintContext");
    const constraintSet = parseConstraintSet(value.constraintContext.constraintSet);
    const intentVersionId = safeIdentity(value.constraintContext.intentVersionId, "constraintContext.intentVersionId");
    const constraintSetId = safeIdentity(value.constraintContext.constraintSetId, "constraintContext.constraintSetId");
    const constraintFingerprint = safeIdentity(value.constraintContext.constraintFingerprint, "constraintContext.constraintFingerprint");
    if (intentVersionId !== constraintSet.intentVersionId
      || constraintSetId !== constraintSet.constraintSetId
      || constraintFingerprint !== constraintSet.constraintFingerprint) {
      inputFail("constraintContext identities do not match ConstraintSetV1.");
    }
    constraintContext = Object.freeze({ intentVersionId, constraintSetId, constraintFingerprint, constraintSet });
  }
  let rejectedOperationTuples: readonly string[] | undefined;
  if (value.rejectedOperationTuples !== undefined) {
    if (!Array.isArray(value.rejectedOperationTuples)) inputFail("rejectedOperationTuples must be an array.");
    rejectedOperationTuples = Object.freeze(value.rejectedOperationTuples.map((item, index) => safeIdentity(item, `rejectedOperationTuples[${index}]`)));
  }
  return Object.freeze({
    preExecutionProject: value.preExecutionProject,
    compiledPlan: value.compiledPlan as CompiledNarrativeActionPlan,
    ownedAssetIds: Object.freeze(ownedAssetIds),
    expectedProjectId: safeIdentity(value.expectedProjectId, "expectedProjectId"),
    expectedProjectUpdatedAt: exactIsoTimestamp(value.expectedProjectUpdatedAt, "expectedProjectUpdatedAt"),
    executionUpdatedAt: exactIsoTimestamp(value.executionUpdatedAt, "executionUpdatedAt"),
    ...(constraintContext ? { constraintContext } : {}),
    ...(rejectedOperationTuples ? { rejectedOperationTuples } : {}),
  });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  return value;
}

function snapshotProject(project: EditorProject): EditorProject {
  return deepFreeze(cloneProject(project));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function structuralProjectValue(project: EditorProject): unknown {
  const { updatedAt: _excludedTimestamp, ...structuralProject } = project;
  return structuralProject;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Structural, deterministic, non-cryptographic anti-replay correlation value. */
export function createCompiledPlanExecutionFingerprint(
  project: EditorProject,
  compiledPlan: CompiledNarrativeActionPlan,
): string {
  const material = {
    project: structuralProjectValue(project),
    sourceNarrativeReference: compiledPlan.sourceNarrativeReference,
    canonicalPlan: compiledPlan.canonicalPlan,
    intentActionMap: compiledPlan.intervalActionMap,
  };
  return `structural-v1-${fnv1a32(stableJson(material))}`;
}

function clipMap(project: EditorProject): Map<string, TimelineClip> {
  return new Map(project.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]));
}

function changedFields(before: TimelineClip, after: TimelineClip): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((key) => stableJson(
    (before as unknown as Record<string, unknown>)[key],
  ) !== stableJson((after as unknown as Record<string, unknown>)[key]));
}

function comparePreservation(
  before: EditorProject,
  after: EditorProject,
  targetIds: ReadonlySet<string>,
): ProjectPreservationEvidence {
  const unexpectedChanges: string[] = [];
  const beforeClips = clipMap(before);
  const afterClips = clipMap(after);
  const projectIdentityPreserved = before.id === after.id;
  const projectSchemaPreserved = before.schemaVersion === after.schemaVersion;
  const projectTitlePreserved = before.title === after.title;
  const projectDurationPreserved = before.durationMs === after.durationMs;
  const projectRatioPreserved = before.ratio === after.ratio;
  const captionsPreserved = stableJson(before.captions) === stableJson(after.captions);
  const audioSelectionPreserved = stableJson(before.audioSelection) === stableJson(after.audioSelection);
  const assetRegistryPreserved = stableJson(before.assets) === stableJson(after.assets);
  const trackIdentityAndOrderPreserved = stableJson(before.tracks.map(({ id, type, name, muted, locked }) => (
    { id, type, name, muted, locked }
  ))) === stableJson(after.tracks.map(({ id, type, name, muted, locked }) => (
    { id, type, name, muted, locked }
  )));
  const clipIdentityAndOrderPreserved = stableJson(before.tracks.map((track) => track.clips.map((clip) => clip.id)))
    === stableJson(after.tracks.map((track) => track.clips.map((clip) => clip.id)));
  let unrelatedClipsPreserved = true;
  let targetTimelineAndTransformPreserved = true;
  const clipChanges: ProjectClipChangeEvidence[] = [];

  for (const [clipId, beforeClip] of beforeClips) {
    const afterClip = afterClips.get(clipId);
    if (!afterClip) {
      unexpectedChanges.push(`clip:${clipId}:removed`);
      if (targetIds.has(clipId)) targetTimelineAndTransformPreserved = false;
      else unrelatedClipsPreserved = false;
      continue;
    }
    const fields = changedFields(beforeClip, afterClip);
    if (fields.length) {
      clipChanges.push(Object.freeze({
        clipId,
        beforeAssetId: beforeClip.assetId,
        afterAssetId: afterClip.assetId,
        changedFields: Object.freeze(fields),
      }));
    }
    if (!targetIds.has(clipId) && fields.length) {
      unrelatedClipsPreserved = false;
      unexpectedChanges.push(`clip:${clipId}:unrelated-change`);
    }
    if (targetIds.has(clipId)) {
      const prohibited = fields.filter((field) => !MATCH_MUTABLE_CLIP_FIELDS.has(field));
      if (prohibited.length) {
        targetTimelineAndTransformPreserved = false;
        unexpectedChanges.push(...prohibited.map((field) => `clip:${clipId}:${field}`));
      }
    }
  }
  for (const clipId of afterClips.keys()) {
    if (!beforeClips.has(clipId)) {
      unexpectedChanges.push(`clip:${clipId}:added`);
      if (targetIds.has(clipId)) targetTimelineAndTransformPreserved = false;
      else unrelatedClipsPreserved = false;
    }
  }

  const protectedChecks = [
    [projectIdentityPreserved, "project:id"],
    [projectSchemaPreserved, "project:schemaVersion"],
    [projectTitlePreserved, "project:title"],
    [projectDurationPreserved, "project:durationMs"],
    [projectRatioPreserved, "project:ratio"],
    [captionsPreserved, "project:captions"],
    [audioSelectionPreserved, "project:audioSelection"],
    [assetRegistryPreserved, "project:assets"],
    [trackIdentityAndOrderPreserved, "project:track-identity-order"],
    [clipIdentityAndOrderPreserved, "project:clip-identity-order"],
  ] as const;
  for (const [preserved, label] of protectedChecks) {
    if (!preserved) unexpectedChanges.push(label);
  }
  const protectedFieldsPreserved = unexpectedChanges.length === 0
    && unrelatedClipsPreserved
    && targetTimelineAndTransformPreserved;
  return deepFreeze({
    projectIdentityPreserved,
    projectSchemaPreserved,
    projectTitlePreserved,
    projectDurationPreserved,
    projectRatioPreserved,
    captionsPreserved,
    audioSelectionPreserved,
    assetRegistryPreserved,
    trackIdentityAndOrderPreserved,
    clipIdentityAndOrderPreserved,
    unrelatedClipsPreserved,
    targetTimelineAndTransformPreserved,
    protectedFieldsPreserved,
    unexpectedChanges: Object.freeze(unexpectedChanges),
    clipChanges: Object.freeze(clipChanges),
  });
}

function compiledPlanFailure(plan: CompiledNarrativeActionPlan): CompiledPlanExecutionFailureCode | undefined {
  if (!plainRecord(plan)) return "COMPILED_PLAN_VALIDATION_BREACH";
  const actualKeys = Object.keys(plan);
  if (
    actualKeys.length !== COMPILED_PLAN_KEYS.length
    || actualKeys.some((key) => !COMPILED_PLAN_KEYS.includes(key as typeof COMPILED_PLAN_KEYS[number]))
  ) {
    return "COMPILED_PLAN_VALIDATION_BREACH";
  }
  if (
    plan.schemaVersion !== 1
    || plan.mode !== "INITIAL_PLAN"
    || !plainRecord(plan.canonicalValidation)
    || plan.canonicalValidation.parser !== "parseAIEditingPlan"
    || plan.canonicalValidation.valid !== true
    || !Array.isArray(plan.intervalActionMap)
    || !Array.isArray(plan.unresolvedIntervalIds)
    || !Array.isArray(plan.unsupportedIntervalIds)
    || !Array.isArray(plan.warnings)
    || !Array.isArray(plan.errors)
  ) return "COMPILED_PLAN_VALIDATION_BREACH";
  if (plan.status !== "VALIDATED") return "COMPILED_PLAN_NOT_VALIDATED";
  if (plan.unresolvedIntervalIds.length || plan.unsupportedIntervalIds.length || plan.errors.length) {
    return "COMPILED_PLAN_VALIDATION_BREACH";
  }
  let canonicalPlan: EditorAIEditingPlan;
  try {
    canonicalPlan = parseAIEditingPlan(plan.canonicalPlan);
  } catch {
    return "COMPILED_PLAN_VALIDATION_BREACH";
  }
  if (stableJson(canonicalPlan) !== stableJson(plan.canonicalPlan)) {
    return "COMPILED_PLAN_VALIDATION_BREACH";
  }
  if (canonicalPlan.actions.length > COMPILED_PLAN_EXECUTION_LIMITS.maxActions) return "ACTION_BATCH_LIMIT";
  if (canonicalPlan.actions.some((action) => action.type !== "MATCH_ASSET_TO_SEGMENT")) {
    return "COMPILED_PLAN_VALIDATION_BREACH";
  }
  if (new Set(canonicalPlan.actions.map((action) => action.targetId)).size !== canonicalPlan.actions.length) {
    return "CONFLICTING_BATCH";
  }
  if (new Set(canonicalPlan.actions.map((action) => stableJson(action))).size !== canonicalPlan.actions.length) {
    return "CONFLICTING_BATCH";
  }
  const compiledLinks = plan.intervalActionMap.filter((link) => link.status === "COMPILED");
  if (compiledLinks.length !== canonicalPlan.actions.length) return "COMPILED_PLAN_VALIDATION_BREACH";
  const indices = new Set<number>();
  for (const link of compiledLinks) {
    if (
      !Number.isInteger(link.actionIndex)
      || link.actionIndex! < 0
      || link.actionIndex! >= canonicalPlan.actions.length
      || indices.has(link.actionIndex!)
    ) return "COMPILED_PLAN_VALIDATION_BREACH";
    indices.add(link.actionIndex!);
    const action = canonicalPlan.actions[link.actionIndex!];
    if (
      link.actionType !== "MATCH_ASSET_TO_SEGMENT"
      || link.targetClipId !== action.targetId
      || link.selectedAssetId !== action.assetId
    ) return "COMPILED_PLAN_VALIDATION_BREACH";
  }
  return undefined;
}

function actionEvidence(
  plan: CompiledNarrativeActionPlan,
  statuses: readonly CompiledActionExecutionStatus[],
  failureCode?: CompiledPlanExecutionFailureCode,
): CompiledActionExecutionEvidence[] {
  const actions = Array.isArray(plan.canonicalPlan?.actions) ? plan.canonicalPlan.actions : [];
  const links = Array.isArray(plan.intervalActionMap) ? plan.intervalActionMap : [];
  return actions.map((action, actionIndex) => {
    const link = links.find((item) => item.actionIndex === actionIndex);
    return Object.freeze({
      actionIndex,
      actionType: action.type,
      targetId: action.targetId,
      intervalId: link?.intervalId ?? "UNMAPPED",
      ...(action.assetId ? { selectedAssetId: action.assetId } : {}),
      status: statuses[actionIndex] ?? "FAILED",
      ...(failureCode ? { failureCode } : {}),
    });
  });
}

function failureStatuses(actionCount: number, failedActionIndex?: number): CompiledActionExecutionStatus[] {
  if (failedActionIndex === undefined || failedActionIndex < 0 || failedActionIndex >= actionCount) {
    return Array.from({ length: actionCount }, () => "FAILED" as const);
  }
  return Array.from({ length: actionCount }, (_, index) => (
    index < failedActionIndex ? "ROLLED_BACK" : index === failedActionIndex ? "FAILED" : "NOT_RUN"
  ));
}

function emptyPreservation(project: EditorProject): ProjectPreservationEvidence {
  return comparePreservation(project, project, new Set());
}

function failedResult(
  preProject: EditorProject,
  compiledPlan: CompiledNarrativeActionPlan,
  fingerprint: string,
  failureCode: CompiledPlanExecutionFailureCode,
  failedActionIndex?: number,
  preservation: ProjectPreservationEvidence = emptyPreservation(preProject),
  constraintEnforcement?: ConstraintEnforcementResultV1,
): CompiledPlanExecutionResult {
  const postProject = snapshotProject(preProject);
  return deepFreeze({
    schemaVersion: COMPILED_PLAN_EXECUTION_SCHEMA_VERSION,
    status: "FAILED" as const,
    preProject,
    postProject,
    actionResults: Object.freeze(actionEvidence(
      compiledPlan,
      failureStatuses(compiledPlan.canonicalPlan?.actions?.length ?? 0, failedActionIndex),
      failureCode,
    )),
    appliedActionCount: 0,
    noOpActionCount: 0,
    ...(failedActionIndex === undefined ? {} : { failedActionIndex }),
    failureCode,
    intentActionMap: compiledPlan.intervalActionMap ?? Object.freeze([]),
    preservation,
    executionFingerprint: fingerprint,
    historyBoundary: Object.freeze({
      strategy: "EXISTING_PROJECT_SNAPSHOT" as const,
      shouldRecordPlanUndo: false,
    }),
    ...(constraintEnforcement ? { constraintEnforcement } : {}),
  });
}

function provisionalFingerprint(project: EditorProject, plan: CompiledNarrativeActionPlan): string {
  try {
    return createCompiledPlanExecutionFingerprint(project, plan);
  } catch {
    return `structural-v1-${fnv1a32(stableJson(structuralProjectValue(project)))}`;
  }
}

function targetChanged(before: EditorProject, after: EditorProject, action: EditorAIPlanAction): boolean {
  const beforeClip = clipMap(before).get(action.targetId);
  const afterClip = clipMap(after).get(action.targetId);
  return stableJson(beforeClip) !== stableJson(afterClip);
}

export function executeCompiledNarrativeActionPlan(
  value: unknown,
  dependencies: ExecutionDependencies = {},
): CompiledPlanExecutionResult {
  const input = parseCompiledPlanExecutionInput(value);
  const preProject = snapshotProject(input.preExecutionProject);
  const fingerprint = provisionalFingerprint(preProject, input.compiledPlan);
  if (input.expectedProjectId !== preProject.id) {
    return failedResult(preProject, input.compiledPlan, fingerprint, "PROJECT_IDENTITY_MISMATCH");
  }
  if (input.expectedProjectUpdatedAt !== preProject.updatedAt) {
    return failedResult(preProject, input.compiledPlan, fingerprint, "PROJECT_VERSION_MISMATCH");
  }
  const constraintContext = input.constraintContext;
  const preExecutionConstraintCheck = validateConstraintContextV1(
    preProject,
    constraintContext?.constraintSet,
    constraintContext ? {
      intentVersionId: constraintContext.intentVersionId,
      constraintSetId: constraintContext.constraintSetId,
      constraintFingerprint: constraintContext.constraintFingerprint,
    } : undefined,
  );
  if (preExecutionConstraintCheck.status !== "ALLOWED") {
    return failedResult(
      preProject,
      input.compiledPlan,
      fingerprint,
      preExecutionConstraintCheck.status === "STALE_CONSTRAINT_CONTEXT"
        ? "STALE_CONSTRAINT_CONTEXT"
        : "HARD_CONSTRAINT_BLOCKED",
      undefined,
      emptyPreservation(preProject),
      preExecutionConstraintCheck,
    );
  }
  const planFailure = compiledPlanFailure(input.compiledPlan);
  if (planFailure) return failedResult(preProject, input.compiledPlan, fingerprint, planFailure);

  const actions = input.compiledPlan.canonicalPlan.actions;
  if (actions.length === 0) {
    const postProject = snapshotProject(preProject);
    return deepFreeze({
      schemaVersion: COMPILED_PLAN_EXECUTION_SCHEMA_VERSION,
      status: "NO_OP" as const,
      preProject,
      postProject,
      actionResults: Object.freeze([]),
      appliedActionCount: 0,
      noOpActionCount: 0,
      intentActionMap: input.compiledPlan.intervalActionMap,
      preservation: emptyPreservation(preProject),
      executionFingerprint: fingerprint,
      historyBoundary: Object.freeze({
        strategy: "EXISTING_PROJECT_SNAPSHOT" as const,
        shouldRecordPlanUndo: false,
      }),
      ...(constraintContext ? { constraintEnforcement: preExecutionConstraintCheck } : {}),
    });
  }

  const workingProject = cloneProject(preProject);
  const applyPlan = dependencies.applyPlan ?? applyAIEditingPlan;
  let applied: EditorAIApplyResult;
  try {
    applied = applyPlan(input.compiledPlan.canonicalPlan, {
      project: workingProject,
      ownedAssetIds: new Set(input.ownedAssetIds),
      audioSourceDurationMs: workingProject.audioSelection.sourceDurationMs,
      nowIso: input.executionUpdatedAt,
      ...(constraintContext ? {
        constraintSet: constraintContext.constraintSet,
        constraintContext: {
          intentVersionId: constraintContext.intentVersionId,
          constraintSetId: constraintContext.constraintSetId,
          constraintFingerprint: constraintContext.constraintFingerprint,
        },
      } : {}),
      ...(input.rejectedOperationTuples ? { rejectedOperationTuples: input.rejectedOperationTuples } : {}),
    });
  } catch (error) {
    if (error instanceof CompiledPlanExecutionAbort) {
      return failedResult(preProject, input.compiledPlan, fingerprint, error.failureCode, error.failedActionIndex);
    }
    if (error instanceof ConstraintEnforcementBlockedError) {
      return failedResult(
        preProject,
        input.compiledPlan,
        fingerprint,
        error.result.status === "STALE_CONSTRAINT_CONTEXT" ? "STALE_CONSTRAINT_CONTEXT" : "HARD_CONSTRAINT_BLOCKED",
        undefined,
        emptyPreservation(preProject),
        error.result,
      );
    }
    return failedResult(
      preProject,
      input.compiledPlan,
      fingerprint,
      error instanceof AIEditingPlanValidationError
        ? "CANONICAL_APPLY_REJECTED"
        : "ACTION_APPLICATION_FAILED",
    );
  }

  if (
    applied.applied.length !== actions.length
    || applied.applied.some((item, index) => item.type !== actions[index].type)
    || applied.project.updatedAt !== input.executionUpdatedAt
  ) {
    return failedResult(preProject, input.compiledPlan, fingerprint, "ACTION_APPLICATION_FAILED");
  }

  const candidatePostProject = snapshotProject(applied.project);
  const postApplyConstraintCheck = verifyPostApplyConstraintInvariantsV1({
    preProject,
    candidateProject: candidatePostProject,
    constraintSet: constraintContext?.constraintSet,
    expectedContext: constraintContext ? {
      intentVersionId: constraintContext.intentVersionId,
      constraintSetId: constraintContext.constraintSetId,
      constraintFingerprint: constraintContext.constraintFingerprint,
    } : undefined,
  });
  if (postApplyConstraintCheck.status !== "ALLOWED") {
    return failedResult(
      preProject,
      input.compiledPlan,
      fingerprint,
      postApplyConstraintCheck.status === "STALE_CONSTRAINT_CONTEXT"
        ? "STALE_CONSTRAINT_CONTEXT"
        : "POST_APPLY_CONSTRAINT_VIOLATION",
      undefined,
      emptyPreservation(preProject),
      postApplyConstraintCheck,
    );
  }
  const targetIds = new Set(actions.map((action) => action.targetId));
  const preservation = comparePreservation(preProject, candidatePostProject, targetIds);
  if (!preservation.protectedFieldsPreserved) {
    return failedResult(
      preProject,
      input.compiledPlan,
      fingerprint,
      "PRESERVATION_CONTRACT_BREACH",
      undefined,
      preservation,
    );
  }
  const statuses = actions.map((action) => (
    targetChanged(preProject, candidatePostProject, action) ? "APPLIED" as const : "NO_OP" as const
  ));
  const actionResults = actionEvidence(input.compiledPlan, statuses);
  const appliedActionCount = statuses.filter((status) => status === "APPLIED").length;
  const noOpActionCount = statuses.filter((status) => status === "NO_OP").length;
  const status = appliedActionCount > 0 ? "APPLIED" as const : "NO_OP" as const;
  return deepFreeze({
    schemaVersion: COMPILED_PLAN_EXECUTION_SCHEMA_VERSION,
    status,
    preProject,
    postProject: candidatePostProject,
    actionResults: Object.freeze(actionResults),
    appliedActionCount,
    noOpActionCount,
    intentActionMap: input.compiledPlan.intervalActionMap,
    preservation,
    executionFingerprint: fingerprint,
    historyBoundary: Object.freeze({
      strategy: "EXISTING_PROJECT_SNAPSHOT" as const,
      shouldRecordPlanUndo: status === "APPLIED",
    }),
    ...(constraintContext ? { constraintEnforcement: postApplyConstraintCheck } : {}),
  });
}
