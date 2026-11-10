import type { AudioRhythmAnalysis } from "./editor-audio-rhythm.ts";
import {
  createConstraintBinding,
  createActiveConstraint,
  createConstraintSet,
  parseConstraintBinding,
  parseProtectionPermissionPolicy,
  parseTimeRange,
  PROTECTED_ENDING_LOGO_PERMISSIONS,
  PROTECTED_SPEECH_PERMISSIONS,
  type ConstraintBindingV1,
  type ConstraintSetV1,
  type EnforcementReadyBindingV1,
  type ProtectionPermissionPolicyV1,
  type TimeRangeV1,
} from "./editor-constraints.ts";
import {
  parseCreativeIntent,
  type CreativeIntentV1,
  type DomainProvenanceV1,
  type HardConstraintRequestIntentClause,
} from "./editor-creative-intent.ts";
import type { EditorProject, TimelineCaption, TimelineClip } from "./editor-core.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import type { VideoSemanticAnalysis } from "./editor-video-semantic.ts";

export const CONSTRAINT_GROUNDING_SCHEMA_VERSION = 1 as const;

export type CandidateBindingProvenance =
  | "MODEL_SUGGESTION"
  | "DETERMINISTIC_PROJECT_FACT"
  | "USER_DIRECT_SELECTION";

export type GroundingSelectionV1 =
  | Readonly<{ bindingType: "CLIP"; clipId: string }>
  | Readonly<{ bindingType: "CAPTION"; captionId: string }>
  | Readonly<{ bindingType: "TIME_RANGE"; range: TimeRangeV1 }>
  | Readonly<{
    bindingType: "VIDEO_SEMANTIC_SOURCE_RANGE";
    assetId: string;
    startMs: number;
    endMs: number;
    analysisVersion: string;
  }>;

export type ConstraintGroundingContextV1 = Readonly<{
  intent: CreativeIntentV1;
  project: EditorProject;
  projectFingerprint: string;
  videoSemanticAnalyses?: readonly VideoSemanticAnalysis[];
  audioRhythmAnalysis?: AudioRhythmAnalysis;
}>;

export type CandidateBindingRecordV1 = Readonly<{
  schemaVersion: typeof CONSTRAINT_GROUNDING_SCHEMA_VERSION;
  recordType: "CANDIDATE_BINDING";
  candidateId: string;
  intentVersionId: string;
  sourceClauseId: string;
  validatedAgainstProjectFingerprint: string;
  binding: Exclude<ConstraintBindingV1, { bindingType: "UNRESOLVED_SEMANTIC_REFERENCE" }>;
}>;

export type ConfirmedBindingRecordV1 = Readonly<{
  schemaVersion: typeof CONSTRAINT_GROUNDING_SCHEMA_VERSION;
  recordType: "USER_CONFIRMED_BINDING";
  confirmationId: string;
  intentVersionId: string;
  sourceClauseId: string;
  validatedAgainstProjectFingerprint: string;
  binding: EnforcementReadyBindingV1;
  sourceCandidateProvenance?: DomainProvenanceV1;
}>;

export type GroundingRejectionCode =
  | "INVALID_CONTEXT"
  | "PROJECT_CONTEXT_MISMATCH"
  | "HARD_REQUEST_NOT_FOUND"
  | "INCOMPATIBLE_BINDING_TYPE"
  | "UNTRUSTED_PROVENANCE"
  | "TARGET_NOT_FOUND"
  | "AMBIGUOUS_TARGET"
  | "INVALID_RANGE"
  | "MISSING_ANALYSIS"
  | "ANALYSIS_VERSION_MISMATCH"
  | "STALE_BINDING"
  | "INVALID_CANDIDATE";

export type GroundingResultV1<T> =
  | Readonly<{ status: "ACCEPTED"; value: T }>
  | Readonly<{ status: "REJECTED"; code: GroundingRejectionCode; message: string }>;

export type StaleBindingReason =
  | "PROJECT_ID_MISMATCH"
  | "PROJECT_FINGERPRINT_MISMATCH"
  | "INTENT_VERSION_MISMATCH"
  | "SOURCE_CLAUSE_MISSING"
  | "INCOMPATIBLE_BINDING_TYPE"
  | "MISSING_CLIP"
  | "CLIP_IDENTITY_MISMATCH"
  | "MISSING_CAPTION"
  | "MISSING_ASSET"
  | "INVALIDATED_RANGE"
  | "MISSING_SEMANTIC_ANALYSIS"
  | "ANALYSIS_VERSION_MISMATCH";

export type ConfirmedBindingValidationV1 =
  | Readonly<{ status: "VALID"; record: ConfirmedBindingRecordV1 }>
  | Readonly<{
    status: "STALE_BINDING";
    confirmationId: string;
    reasons: readonly StaleBindingReason[];
  }>;

export type ConstraintPlanningReadiness =
  | "READY_TO_PLAN"
  | "GROUNDING_REQUIRED"
  | "NEEDS_USER_DECISION"
  | "BLOCKED_NOT_EVALUABLE";

export type ExcludedBindingReason =
  | "MODEL_ONLY_UNCONFIRMED"
  | "MALFORMED_CONFIRMED_BINDING"
  | "NO_MATCHING_HARD_REQUEST";

export type ConstraintSetBuildSuccessV1 = Readonly<{
  status: "CONSTRAINT_SET_BUILT";
  constraintSet: ConstraintSetV1;
  readiness: ConstraintPlanningReadiness;
  confirmedRequestCount: number;
  unresolvedRequestCount: number;
  confirmedClauseIds: readonly string[];
  unresolvedClauseIds: readonly string[];
  excludedBindings: readonly Readonly<{
    sourceClauseId?: string;
    reason: ExcludedBindingReason;
  }>[];
}>;

export type ConstraintSetBuildFailureCode =
  | "PROJECT_CONTEXT_MISMATCH"
  | "STALE_BINDING"
  | "DUPLICATE_CONFIRMED_BINDING"
  | "MISSING_PERMISSION_POLICY"
  | "INVALID_PERMISSION_POLICY"
  | "INVALID_INPUT";

export type ConstraintSetBuildResultV1 = ConstraintSetBuildSuccessV1 | Readonly<{
  status: "CONSTRAINT_SET_BUILD_FAILED";
  code: ConstraintSetBuildFailureCode;
  readiness: "BLOCKED_NOT_EVALUABLE";
  message: string;
  staleClauseIds: readonly string[];
}>;

export type BuildConstraintSetInputV1 = Readonly<{
  intent: CreativeIntentV1;
  project: EditorProject;
  projectFingerprint: string;
  confirmedBindings: readonly unknown[];
  permissionPolicies?: Readonly<Record<string, unknown>>;
  videoSemanticAnalyses?: readonly VideoSemanticAnalysis[];
  audioRhythmAnalysis?: AudioRhythmAnalysis;
}>;

class GroundingFailure extends Error {
  readonly code: GroundingRejectionCode;

  constructor(code: GroundingRejectionCode, message: string) {
    super(message);
    this.name = "GroundingFailure";
    this.code = code;
  }
}

function fail(code: GroundingRejectionCode, message: string): never {
  throw new GroundingFailure(code, message);
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

function safeIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > 512
    || /\u0000/.test(value)
    || /^(?:blob:|file:|https?:)/i.test(value)
    || /[\\/]/.test(value)
  ) fail("INVALID_CANDIDATE", `${label} is not a trusted bounded identity.`);
  return value;
}

function uniqueById<T extends { id: string }>(items: readonly T[], id: string): T {
  const matches = items.filter((item) => item.id === id);
  if (matches.length === 0) fail("TARGET_NOT_FOUND", `Trusted target ${id} no longer exists.`);
  if (matches.length !== 1) fail("AMBIGUOUS_TARGET", `Trusted target ${id} is not unique.`);
  return matches[0];
}

function hardClause(intent: CreativeIntentV1, clauseId: string): HardConstraintRequestIntentClause {
  const clause = intent.clauses.find((item) => item.clauseId === clauseId);
  if (!clause || clause.kind !== "HARD_CONSTRAINT_REQUEST") {
    fail("HARD_REQUEST_NOT_FOUND", "The binding does not reference a current hard-constraint request.");
  }
  return clause;
}

function assertCompatible(
  clause: HardConstraintRequestIntentClause,
  bindingType: GroundingSelectionV1["bindingType"],
): void {
  const compatible = clause.payload.type === "PROTECT_CLIP"
    ? bindingType === "CLIP"
    : ["CLIP", "CAPTION", "TIME_RANGE", "VIDEO_SEMANTIC_SOURCE_RANGE"].includes(bindingType);
  if (!compatible) {
    fail(
      "INCOMPATIBLE_BINDING_TYPE",
      `${clause.payload.type} is incompatible with a ${bindingType} binding.`,
    );
  }
}

function assertProjectContext(context: ConstraintGroundingContextV1): void {
  const intent = parseCreativeIntent(context.intent);
  if (!context.project || !Array.isArray(context.project.assets) || !Array.isArray(context.project.tracks)
    || !Array.isArray(context.project.captions)) {
    fail("INVALID_CONTEXT", "The editor project context is malformed.");
  }
  if (intent.projectId !== context.project.id) {
    fail("PROJECT_CONTEXT_MISMATCH", "Creative intent and editor project identities differ.");
  }
  const actualFingerprint = createEditorProjectFingerprint(context.project);
  if (context.projectFingerprint !== actualFingerprint) {
    fail("PROJECT_CONTEXT_MISMATCH", "The supplied project fingerprint is not current trusted project state.");
  }
}

function allClips(project: EditorProject): readonly TimelineClip[] {
  return project.tracks.flatMap((track) => track.clips);
}

function validateClipSelection(project: EditorProject, clipIdValue: unknown): TimelineClip {
  const clipId = safeIdentity(clipIdValue, "clipId");
  const clip = uniqueById(allClips(project), clipId);
  const containingTracks = project.tracks.filter((track) => track.clips.some((item) => item.id === clipId));
  if (containingTracks.length !== 1 || clip.trackId !== containingTracks[0].id) {
    fail("AMBIGUOUS_TARGET", "The clip does not have one exact trusted track placement.");
  }
  uniqueById(project.assets, clip.assetId);
  if (!Number.isSafeInteger(clip.timelineStartMs) || !Number.isSafeInteger(clip.timelineEndMs)
    || clip.timelineStartMs < 0 || clip.timelineEndMs <= clip.timelineStartMs
    || clip.timelineEndMs > project.durationMs) {
    fail("INVALID_RANGE", "The selected clip has an invalid current timeline range.");
  }
  return clip;
}

function validateCaptionSelection(project: EditorProject, captionIdValue: unknown): TimelineCaption {
  const caption = uniqueById(project.captions, safeIdentity(captionIdValue, "captionId"));
  if (!Number.isSafeInteger(caption.startMs) || !Number.isSafeInteger(caption.endMs)
    || caption.startMs < 0 || caption.endMs <= caption.startMs || caption.endMs > project.durationMs) {
    fail("INVALID_RANGE", "The selected caption has an invalid current timeline range.");
  }
  return caption;
}

function validateRange(project: EditorProject, value: unknown): TimeRangeV1 {
  let range: TimeRangeV1;
  try {
    range = parseTimeRange(value);
  } catch {
    fail("INVALID_RANGE", "The selected range is malformed.");
  }
  if (range.coordinateSpace === "TIMELINE") {
    if (range.endMs > project.durationMs) fail("INVALID_RANGE", "Timeline range exceeds the current project.");
    return range;
  }
  const asset = uniqueById(project.assets, range.assetId);
  if (!Number.isSafeInteger(asset.durationMs) || asset.durationMs <= 0 || range.endMs > asset.durationMs) {
    fail("INVALID_RANGE", "Source range exceeds the exact trusted asset duration.");
  }
  return range;
}

function semanticAnalysis(
  context: ConstraintGroundingContextV1,
  assetId: string,
  analysisVersion: string,
): VideoSemanticAnalysis {
  const forAsset = (context.videoSemanticAnalyses ?? []).filter((analysis) => analysis.assetId === assetId);
  if (forAsset.length === 0) fail("MISSING_ANALYSIS", "No current semantic analysis exists for the exact asset.");
  const matches = forAsset.filter((analysis) => analysis.analysisVersion === analysisVersion);
  if (matches.length === 0) fail("ANALYSIS_VERSION_MISMATCH", "Semantic analysis version is stale.");
  if (matches.length !== 1) fail("AMBIGUOUS_TARGET", "Semantic analysis identity is not unique.");
  return matches[0];
}

function validateSemanticSelection(
  context: ConstraintGroundingContextV1,
  selection: Extract<GroundingSelectionV1, { bindingType: "VIDEO_SEMANTIC_SOURCE_RANGE" }>,
): GroundingSelectionV1 {
  const assetId = safeIdentity(selection.assetId, "assetId");
  const asset = uniqueById(context.project.assets, assetId);
  if (!Number.isSafeInteger(selection.startMs) || !Number.isSafeInteger(selection.endMs)
    || selection.startMs < 0 || selection.endMs <= selection.startMs) {
    fail("INVALID_RANGE", "Semantic source range is invalid.");
  }
  const analysisVersion = safeIdentity(selection.analysisVersion, "analysisVersion");
  const analysis = semanticAnalysis(context, assetId, analysisVersion);
  if (analysis.assetDurationMs !== asset.durationMs || selection.endMs > analysis.assetDurationMs) {
    fail("INVALID_RANGE", "Semantic source range no longer matches the trusted asset duration.");
  }
  const supported = analysis.segments.some((segment) => (
    segment.assetId === assetId
    && segment.startMs <= selection.startMs
    && segment.endMs >= selection.endMs
  ));
  if (!supported) fail("INVALID_RANGE", "Semantic source range is not supported by current analysis evidence.");
  return { bindingType: "VIDEO_SEMANTIC_SOURCE_RANGE", assetId, startMs: selection.startMs, endMs: selection.endMs, analysisVersion };
}

function validateSelection(
  context: ConstraintGroundingContextV1,
  sourceClauseId: string,
  selection: GroundingSelectionV1,
): GroundingSelectionV1 {
  assertProjectContext(context);
  const clause = hardClause(context.intent, sourceClauseId);
  assertCompatible(clause, selection.bindingType);
  if (selection.bindingType === "CLIP") {
    const clip = validateClipSelection(context.project, selection.clipId);
    return { bindingType: "CLIP", clipId: clip.id };
  }
  if (selection.bindingType === "CAPTION") {
    const caption = validateCaptionSelection(context.project, selection.captionId);
    return { bindingType: "CAPTION", captionId: caption.id };
  }
  if (selection.bindingType === "TIME_RANGE") {
    return { bindingType: "TIME_RANGE", range: validateRange(context.project, selection.range) };
  }
  return validateSemanticSelection(context, selection);
}

function provenance(authority: DomainProvenanceV1["authority"], sourceReference: string): DomainProvenanceV1 {
  return deepFreeze({ schemaVersion: 1, authority, sourceReference });
}

function bindingFromSelection(
  context: ConstraintGroundingContextV1,
  selection: GroundingSelectionV1,
  state: "CANDIDATE_BINDING" | "USER_CONFIRMED_BINDING",
  bindingProvenance: DomainProvenanceV1,
): EnforcementReadyBindingV1 {
  if (selection.bindingType === "CLIP") {
    const clip = validateClipSelection(context.project, selection.clipId);
    return createConstraintBinding({
      bindingType: "CLIP",
      projectId: context.project.id,
      state,
      clipId: clip.id,
      assetId: clip.assetId,
      trackId: clip.trackId,
      provenance: bindingProvenance,
    }) as EnforcementReadyBindingV1;
  }
  if (selection.bindingType === "CAPTION") {
    return createConstraintBinding({
      bindingType: "CAPTION",
      projectId: context.project.id,
      state,
      captionId: selection.captionId,
      provenance: bindingProvenance,
    }) as EnforcementReadyBindingV1;
  }
  if (selection.bindingType === "TIME_RANGE") {
    return createConstraintBinding({
      bindingType: "TIME_RANGE",
      projectId: context.project.id,
      state,
      range: selection.range,
      provenance: bindingProvenance,
    }) as EnforcementReadyBindingV1;
  }
  return createConstraintBinding({
    ...selection,
    projectId: context.project.id,
    state,
    provenance: bindingProvenance,
  }) as EnforcementReadyBindingV1;
}

function asRejected(error: unknown): GroundingResultV1<never> {
  if (error instanceof GroundingFailure) {
    return deepFreeze({ status: "REJECTED", code: error.code, message: error.message });
  }
  return deepFreeze({
    status: "REJECTED",
    code: "INVALID_CANDIDATE",
    message: error instanceof Error ? error.message : "Grounding input is invalid.",
  });
}

export function createCandidateBindingV1(input: Readonly<{
  context: ConstraintGroundingContextV1;
  sourceClauseId: string;
  selection: GroundingSelectionV1;
  provenance: Readonly<{
    authority: CandidateBindingProvenance;
    sourceReference: string;
  }>;
}>): GroundingResultV1<CandidateBindingRecordV1> {
  try {
    const selection = validateSelection(input.context, input.sourceClauseId, input.selection);
    if (!["MODEL_SUGGESTION", "DETERMINISTIC_PROJECT_FACT", "USER_DIRECT_SELECTION"].includes(input.provenance.authority)) {
      fail("UNTRUSTED_PROVENANCE", "Candidate provenance is not allowed.");
    }
    const candidateProvenance = provenance(
      input.provenance.authority,
      safeIdentity(input.provenance.sourceReference, "sourceReference"),
    );
    const binding = bindingFromSelection(input.context, selection, "CANDIDATE_BINDING", candidateProvenance);
    const identityMaterial = {
      intentVersionId: input.context.intent.intentId,
      sourceClauseId: input.sourceClauseId,
      projectFingerprint: input.context.projectFingerprint,
      binding,
    };
    return deepFreeze({
      status: "ACCEPTED",
      value: {
        schemaVersion: CONSTRAINT_GROUNDING_SCHEMA_VERSION,
        recordType: "CANDIDATE_BINDING",
        candidateId: `candidate-v1-${fnv1a(stable(identityMaterial))}`,
        intentVersionId: input.context.intent.intentId,
        sourceClauseId: input.sourceClauseId,
        validatedAgainstProjectFingerprint: input.context.projectFingerprint,
        binding,
      },
    });
  } catch (error) {
    return asRejected(error);
  }
}

function confirmationId(record: Omit<ConfirmedBindingRecordV1, "confirmationId" | "schemaVersion" | "recordType">): string {
  return `confirmation-v1-${fnv1a(stable(record))}`;
}

function confirmedRecord(
  context: ConstraintGroundingContextV1,
  sourceClauseId: string,
  binding: EnforcementReadyBindingV1,
  sourceCandidateProvenance?: DomainProvenanceV1,
): ConfirmedBindingRecordV1 {
  const material = {
    intentVersionId: context.intent.intentId,
    sourceClauseId,
    validatedAgainstProjectFingerprint: context.projectFingerprint,
    binding,
    ...(sourceCandidateProvenance ? { sourceCandidateProvenance } : {}),
  };
  return deepFreeze({
    schemaVersion: CONSTRAINT_GROUNDING_SCHEMA_VERSION,
    recordType: "USER_CONFIRMED_BINDING",
    confirmationId: confirmationId(material),
    ...material,
  });
}

export function confirmDirectSelectionV1(input: Readonly<{
  context: ConstraintGroundingContextV1;
  sourceClauseId: string;
  selection: GroundingSelectionV1;
}>): GroundingResultV1<ConfirmedBindingRecordV1> {
  try {
    const selection = validateSelection(input.context, input.sourceClauseId, input.selection);
    const binding = bindingFromSelection(
      input.context,
      selection,
      "USER_CONFIRMED_BINDING",
      provenance("USER_DIRECT_SELECTION", `direct-selection:${input.sourceClauseId}`),
    );
    return deepFreeze({ status: "ACCEPTED", value: confirmedRecord(input.context, input.sourceClauseId, binding) });
  } catch (error) {
    return asRejected(error);
  }
}

function selectionFromBinding(binding: EnforcementReadyBindingV1): GroundingSelectionV1 {
  if (binding.bindingType === "CLIP") return { bindingType: "CLIP", clipId: binding.clipId };
  if (binding.bindingType === "CAPTION") return { bindingType: "CAPTION", captionId: binding.captionId };
  if (binding.bindingType === "TIME_RANGE") return { bindingType: "TIME_RANGE", range: binding.range };
  return {
    bindingType: "VIDEO_SEMANTIC_SOURCE_RANGE",
    assetId: binding.assetId,
    startMs: binding.startMs,
    endMs: binding.endMs,
    analysisVersion: binding.analysisVersion,
  };
}

export function confirmCandidateBindingV1(input: Readonly<{
  context: ConstraintGroundingContextV1;
  candidate: CandidateBindingRecordV1;
}>): GroundingResultV1<ConfirmedBindingRecordV1> {
  try {
    if (input.candidate.recordType !== "CANDIDATE_BINDING"
      || input.candidate.binding.state !== "CANDIDATE_BINDING"
      || input.candidate.intentVersionId !== input.context.intent.intentId
      || input.candidate.validatedAgainstProjectFingerprint !== input.context.projectFingerprint) {
      fail("STALE_BINDING", "Candidate binding is not current for this intent and project fingerprint.");
    }
    const parsed = parseConstraintBinding(input.candidate.binding);
    if (parsed.bindingType === "UNRESOLVED_SEMANTIC_REFERENCE") fail("INVALID_CANDIDATE", "Unresolved references cannot be confirmed.");
    const selection = validateSelection(input.context, input.candidate.sourceClauseId, selectionFromBinding(parsed));
    const binding = bindingFromSelection(
      input.context,
      selection,
      "USER_CONFIRMED_BINDING",
      provenance("USER_CONFIRMED_BINDING", `confirmed-candidate:${input.candidate.candidateId}`),
    );
    return deepFreeze({
      status: "ACCEPTED",
      value: confirmedRecord(input.context, input.candidate.sourceClauseId, binding, parsed.provenance),
    });
  } catch (error) {
    return asRejected(error);
  }
}

function structuralConfirmedRecord(value: unknown): ConfirmedBindingRecordV1 | undefined {
  if (!plainRecord(value)
    || value.schemaVersion !== CONSTRAINT_GROUNDING_SCHEMA_VERSION
    || value.recordType !== "USER_CONFIRMED_BINDING"
    || typeof value.confirmationId !== "string"
    || typeof value.intentVersionId !== "string"
    || typeof value.sourceClauseId !== "string"
    || typeof value.validatedAgainstProjectFingerprint !== "string") return undefined;
  try {
    const binding = parseConstraintBinding(value.binding);
    if (binding.bindingType === "UNRESOLVED_SEMANTIC_REFERENCE" || binding.state !== "USER_CONFIRMED_BINDING") return undefined;
    const material = {
      intentVersionId: value.intentVersionId,
      sourceClauseId: value.sourceClauseId,
      validatedAgainstProjectFingerprint: value.validatedAgainstProjectFingerprint,
      binding,
      ...(value.sourceCandidateProvenance === undefined
        ? {}
        : { sourceCandidateProvenance: value.sourceCandidateProvenance as DomainProvenanceV1 }),
    };
    if (confirmationId(material) !== value.confirmationId) return undefined;
    return value as ConfirmedBindingRecordV1;
  } catch {
    return undefined;
  }
}

function staleReasons(
  record: ConfirmedBindingRecordV1,
  context: ConstraintGroundingContextV1,
): StaleBindingReason[] {
  const reasons: StaleBindingReason[] = [];
  const currentFingerprint = createEditorProjectFingerprint(context.project);
  if (record.binding.projectId !== context.project.id || context.intent.projectId !== context.project.id) {
    reasons.push("PROJECT_ID_MISMATCH");
  }
  if (record.validatedAgainstProjectFingerprint !== currentFingerprint
    || context.projectFingerprint !== currentFingerprint) reasons.push("PROJECT_FINGERPRINT_MISMATCH");
  if (record.intentVersionId !== context.intent.intentId) reasons.push("INTENT_VERSION_MISMATCH");
  const clause = context.intent.clauses.find((item) => item.clauseId === record.sourceClauseId);
  if (!clause || clause.kind !== "HARD_CONSTRAINT_REQUEST") {
    reasons.push("SOURCE_CLAUSE_MISSING");
  } else {
    try {
      assertCompatible(clause, record.binding.bindingType);
    } catch {
      reasons.push("INCOMPATIBLE_BINDING_TYPE");
    }
  }
  const binding = record.binding;
  if (binding.bindingType === "CLIP") {
    const matches = allClips(context.project).filter((clip) => clip.id === binding.clipId);
    if (matches.length !== 1) reasons.push("MISSING_CLIP");
    else if (matches[0].assetId !== binding.assetId || matches[0].trackId !== binding.trackId) {
      reasons.push("CLIP_IDENTITY_MISMATCH");
    } else if (!context.project.assets.some((asset) => asset.id === binding.assetId)) reasons.push("MISSING_ASSET");
  } else if (binding.bindingType === "CAPTION") {
    const matches = context.project.captions.filter((caption) => caption.id === binding.captionId);
    if (matches.length !== 1) reasons.push("MISSING_CAPTION");
    else if (matches[0].startMs < 0 || matches[0].endMs <= matches[0].startMs
      || matches[0].endMs > context.project.durationMs) reasons.push("INVALIDATED_RANGE");
  } else if (binding.bindingType === "TIME_RANGE") {
    const range = binding.range;
    if (range.coordinateSpace === "TIMELINE") {
      if (range.endMs > context.project.durationMs) reasons.push("INVALIDATED_RANGE");
    } else {
      const asset = context.project.assets.find((item) => item.id === range.assetId);
      if (!asset) reasons.push("MISSING_ASSET");
      else if (asset.durationMs <= 0 || range.endMs > asset.durationMs) reasons.push("INVALIDATED_RANGE");
    }
  } else {
    const asset = context.project.assets.find((item) => item.id === binding.assetId);
    if (!asset) reasons.push("MISSING_ASSET");
    else if (asset.durationMs !== undefined && binding.endMs > asset.durationMs) reasons.push("INVALIDATED_RANGE");
    const analyses = (context.videoSemanticAnalyses ?? []).filter((item) => item.assetId === binding.assetId);
    if (analyses.length === 0) reasons.push("MISSING_SEMANTIC_ANALYSIS");
    else if (!analyses.some((item) => item.analysisVersion === binding.analysisVersion)) {
      reasons.push("ANALYSIS_VERSION_MISMATCH");
    }
  }
  return [...new Set(reasons)];
}

export function validateConfirmedBindingV1(
  recordValue: unknown,
  context: ConstraintGroundingContextV1,
): ConfirmedBindingValidationV1 {
  const record = structuralConfirmedRecord(recordValue);
  if (!record) {
    return deepFreeze({
      status: "STALE_BINDING",
      confirmationId: plainRecord(recordValue) && typeof recordValue.confirmationId === "string"
        ? recordValue.confirmationId
        : "invalid-confirmation",
      reasons: ["SOURCE_CLAUSE_MISSING"],
    });
  }
  const reasons = staleReasons(record, context);
  return reasons.length
    ? deepFreeze({ status: "STALE_BINDING", confirmationId: record.confirmationId, reasons })
    : deepFreeze({ status: "VALID", record });
}

function permissionFor(
  clause: HardConstraintRequestIntentClause,
  explicit: Readonly<Record<string, unknown>> | undefined,
): ProtectionPermissionPolicyV1 {
  const supplied = explicit?.[clause.clauseId];
  if (supplied !== undefined) return parseProtectionPermissionPolicy(supplied);
  if (clause.payload.reference.semanticKind === "SPEECH") return PROTECTED_SPEECH_PERMISSIONS;
  if (clause.payload.type === "PRESERVE_ENDING") return PROTECTED_ENDING_LOGO_PERMISSIONS;
  fail("INVALID_CANDIDATE", `No complete permission policy exists for ${clause.clauseId}.`);
}

function promoteBinding(
  record: ConfirmedBindingRecordV1,
  project: EditorProject,
): readonly EnforcementReadyBindingV1[] {
  const binding = record.binding;
  if (binding.bindingType === "CAPTION") {
    const caption = uniqueById(project.captions, binding.captionId);
    const active = createConstraintBinding({
      bindingType: "TIME_RANGE",
      projectId: project.id,
      state: "ACTIVE_HARD_CONSTRAINT",
      range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: caption.startMs, endMs: caption.endMs },
      provenance: binding.provenance,
    }) as EnforcementReadyBindingV1;
    return [binding, active];
  }
  const { schemaVersion: _schemaVersion, bindingId: _bindingId, ...draft } = binding;
  return [createConstraintBinding({ ...draft, state: "ACTIVE_HARD_CONSTRAINT" }) as EnforcementReadyBindingV1];
}

export function buildConstraintSetV1(input: BuildConstraintSetInputV1): ConstraintSetBuildResultV1 {
  try {
    const intent = parseCreativeIntent(input.intent);
    const context: ConstraintGroundingContextV1 = {
      intent,
      project: input.project,
      projectFingerprint: input.projectFingerprint,
      videoSemanticAnalyses: input.videoSemanticAnalyses,
      audioRhythmAnalysis: input.audioRhythmAnalysis,
    };
    assertProjectContext(context);
    const hardClauses = intent.clauses.filter(
      (clause): clause is HardConstraintRequestIntentClause => clause.kind === "HARD_CONSTRAINT_REQUEST",
    );
    const records: ConfirmedBindingRecordV1[] = [];
    const excludedBindings: { sourceClauseId?: string; reason: ExcludedBindingReason }[] = [];
    for (const value of input.confirmedBindings) {
      const parsed = structuralConfirmedRecord(value);
      if (parsed) records.push(parsed);
      else {
        const candidateLike = plainRecord(value) && value.recordType === "CANDIDATE_BINDING";
        excludedBindings.push({
          ...(plainRecord(value) && typeof value.sourceClauseId === "string" ? { sourceClauseId: value.sourceClauseId } : {}),
          reason: candidateLike ? "MODEL_ONLY_UNCONFIRMED" : "MALFORMED_CONFIRMED_BINDING",
        });
      }
    }
    const hardClauseIds = new Set(hardClauses.map((clause) => clause.clauseId));
    records.filter((record) => !hardClauseIds.has(record.sourceClauseId)).forEach((record) => {
      excludedBindings.push({ sourceClauseId: record.sourceClauseId, reason: "NO_MATCHING_HARD_REQUEST" });
    });
    const relevant = records.filter((record) => hardClauseIds.has(record.sourceClauseId));
    const duplicates = hardClauses.filter((clause) => relevant.filter((record) => record.sourceClauseId === clause.clauseId).length > 1);
    if (duplicates.length) {
      return deepFreeze({
        status: "CONSTRAINT_SET_BUILD_FAILED",
        code: "DUPLICATE_CONFIRMED_BINDING",
        readiness: "BLOCKED_NOT_EVALUABLE",
        message: "A hard request has multiple confirmed bindings and cannot be activated ambiguously.",
        staleClauseIds: [],
      });
    }
    const staleClauseIds: string[] = [];
    for (const record of relevant) {
      if (validateConfirmedBindingV1(record, context).status !== "VALID") staleClauseIds.push(record.sourceClauseId);
    }
    if (staleClauseIds.length) {
      return deepFreeze({
        status: "CONSTRAINT_SET_BUILD_FAILED",
        code: "STALE_BINDING",
        readiness: "BLOCKED_NOT_EVALUABLE",
        message: "Stale confirmed bindings block ConstraintSet activation.",
        staleClauseIds: [...new Set(staleClauseIds)].sort(),
      });
    }

    const activeConstraints = [];
    const confirmedBindings: EnforcementReadyBindingV1[] = [];
    const confirmedClauseIds: string[] = [];
    for (const clause of hardClauses) {
      const record = relevant.find((item) => item.sourceClauseId === clause.clauseId);
      if (!record) continue;
      let permissions: ProtectionPermissionPolicyV1;
      try {
        permissions = permissionFor(clause, input.permissionPolicies);
      } catch (error) {
        const missing = !input.permissionPolicies?.[clause.clauseId]
          && clause.payload.reference.semanticKind !== "SPEECH"
          && clause.payload.type !== "PRESERVE_ENDING";
        return deepFreeze({
          status: "CONSTRAINT_SET_BUILD_FAILED",
          code: missing ? "MISSING_PERMISSION_POLICY" : "INVALID_PERMISSION_POLICY",
          readiness: "BLOCKED_NOT_EVALUABLE",
          message: error instanceof Error ? error.message : "Permission policy is invalid.",
          staleClauseIds: [],
        });
      }
      const promoted = promoteBinding(record, input.project);
      const activeBinding = promoted.at(-1)!;
      confirmedBindings.push(...promoted);
      activeConstraints.push(createActiveConstraint({
        type: clause.payload.type,
        sourceClauseId: clause.clauseId,
        binding: activeBinding,
        permissions,
        provenance: activeBinding.provenance,
        confirmationStatus: "USER_CONFIRMED",
      }));
      confirmedClauseIds.push(clause.clauseId);
    }
    const deduplicatedBindings = [...new Map(confirmedBindings.map((binding) => [
      `${binding.bindingId}:${binding.state}:${binding.provenance.authority}:${binding.provenance.sourceReference}`,
      binding,
    ])).values()];
    const unresolvedClauseIds = hardClauses
      .map((clause) => clause.clauseId)
      .filter((clauseId) => !confirmedClauseIds.includes(clauseId));
    const constraintSet = createConstraintSet({
      version: 1,
      projectId: input.project.id,
      intentVersionId: intent.intentId,
      validatedAgainstProjectFingerprint: input.projectFingerprint,
      activeConstraints,
      confirmedBindings: deduplicatedBindings,
      resolutionIds: intent.resolutionIds,
    });
    const readiness: ConstraintPlanningReadiness = unresolvedClauseIds.length === 0
      ? "READY_TO_PLAN"
      : intent.groundingState === "CANDIDATE_BINDING"
        ? "GROUNDING_REQUIRED"
        : "NEEDS_USER_DECISION";
    return deepFreeze({
      status: "CONSTRAINT_SET_BUILT",
      constraintSet,
      readiness,
      confirmedRequestCount: confirmedClauseIds.length,
      unresolvedRequestCount: unresolvedClauseIds.length,
      confirmedClauseIds: confirmedClauseIds.sort(),
      unresolvedClauseIds: unresolvedClauseIds.sort(),
      excludedBindings,
    });
  } catch (error) {
    return deepFreeze({
      status: "CONSTRAINT_SET_BUILD_FAILED",
      code: error instanceof GroundingFailure && error.code === "PROJECT_CONTEXT_MISMATCH"
        ? "PROJECT_CONTEXT_MISMATCH"
        : "INVALID_INPUT",
      readiness: "BLOCKED_NOT_EVALUABLE",
      message: error instanceof Error ? error.message : "ConstraintSet input is invalid.",
      staleClauseIds: [],
    });
  }
}
