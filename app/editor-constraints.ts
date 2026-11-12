import {
  CreativeIntentValidationError,
  parseDomainProvenance,
  parseUnresolvedSemanticReference,
  type DomainProvenanceV1,
  type UnresolvedSemanticReferenceV1,
} from "./editor-creative-intent.ts";

export const CONSTRAINT_DOMAIN_SCHEMA_VERSION = 1 as const;
export const CONSTRAINT_SET_SCHEMA_VERSION = 1 as const;
export const TIME_RANGE_SCHEMA_VERSION = 1 as const;

const MAX_ID_LENGTH = 512;
const MAX_BINDINGS = 128;
const MAX_CONSTRAINTS = 128;
const MAX_RESOLUTION_IDS = 128;
const BINDING_ID_PATTERN = /^binding-v1-[0-9a-f]{8}$/;
const CONSTRAINT_ID_PATTERN = /^constraint-v1-[0-9a-f]{8}$/;
const CONSTRAINT_SET_ID_PATTERN = /^constraint-set-v1-[0-9a-f]{8}$/;
const CONSTRAINT_FINGERPRINT_PATTERN = /^constraint-fingerprint-v1-[0-9a-f]{8}$/;
const INTENT_ID_PATTERN = /^intent-v1-[0-9a-f]{8}$/;
const CLAUSE_ID_PATTERN = /^clause-v1-[0-9a-f]{8}$/;
const PROJECT_FINGERPRINT_PATTERN = /^project-v1-[0-9a-f]{8}$/;

export type BindingLifecycleState =
  | "UNRESOLVED_REFERENCE"
  | "CANDIDATE_BINDING"
  | "USER_CONFIRMED_BINDING"
  | "ACTIVE_HARD_CONSTRAINT"
  | "STALE_BINDING";

export type TimeRangeV1 =
  | Readonly<{
    schemaVersion: typeof TIME_RANGE_SCHEMA_VERSION;
    coordinateSpace: "TIMELINE";
    startMs: number;
    endMs: number;
  }>
  | Readonly<{
    schemaVersion: typeof TIME_RANGE_SCHEMA_VERSION;
    coordinateSpace: "SOURCE_ASSET";
    assetId: string;
    startMs: number;
    endMs: number;
  }>;

export type ProtectionPermissionPolicyV1 = Readonly<{
  allowDelete: boolean;
  allowTrim: boolean;
  allowMove: boolean;
  allowSpeedChange: boolean;
  allowAssetReplace: boolean;
  allowCaptionTextChange: boolean;
  allowTimingChange: boolean;
  allowSplit: boolean;
  allowTransformChange: boolean;
  allowAudioRangeChange: boolean;
}>;

type BindingBase = Readonly<{
  schemaVersion: typeof CONSTRAINT_DOMAIN_SCHEMA_VERSION;
  bindingId: string;
  projectId: string;
  state: BindingLifecycleState;
  provenance: DomainProvenanceV1;
}>;

export type UnresolvedSemanticBindingV1 = BindingBase & Readonly<{
  bindingType: "UNRESOLVED_SEMANTIC_REFERENCE";
  state: "UNRESOLVED_REFERENCE";
  semanticReference: UnresolvedSemanticReferenceV1;
}>;

export type TrustedClipBindingV1 = BindingBase & Readonly<{
  bindingType: "CLIP";
  state: Exclude<BindingLifecycleState, "UNRESOLVED_REFERENCE">;
  clipId: string;
  assetId: string;
  trackId: string;
}>;

export type TrustedCaptionBindingV1 = BindingBase & Readonly<{
  bindingType: "CAPTION";
  state: Exclude<BindingLifecycleState, "UNRESOLVED_REFERENCE">;
  captionId: string;
}>;

export type TrustedTimeRangeBindingV1 = BindingBase & Readonly<{
  bindingType: "TIME_RANGE";
  state: Exclude<BindingLifecycleState, "UNRESOLVED_REFERENCE">;
  range: TimeRangeV1;
}>;

export type TrustedVideoSemanticSourceRangeBindingV1 = BindingBase & Readonly<{
  bindingType: "VIDEO_SEMANTIC_SOURCE_RANGE";
  state: Exclude<BindingLifecycleState, "UNRESOLVED_REFERENCE">;
  assetId: string;
  startMs: number;
  endMs: number;
  analysisVersion: string;
}>;

export type ConstraintBindingV1 =
  | UnresolvedSemanticBindingV1
  | TrustedClipBindingV1
  | TrustedCaptionBindingV1
  | TrustedTimeRangeBindingV1
  | TrustedVideoSemanticSourceRangeBindingV1;

export type EnforcementReadyBindingV1 = Exclude<ConstraintBindingV1, UnresolvedSemanticBindingV1>;

export type ActiveConstraintType = "PROTECT_TIME_RANGE" | "PROTECT_CLIP" | "PRESERVE_ENDING";
export type ConstraintConfirmationStatus = "USER_CONFIRMED" | "TRUSTED_PROJECT_FACT";

export type ActiveConstraintV1 = Readonly<{
  schemaVersion: typeof CONSTRAINT_DOMAIN_SCHEMA_VERSION;
  constraintId: string;
  type: ActiveConstraintType;
  sourceClauseId: string;
  bindingId: string;
  permissions: ProtectionPermissionPolicyV1;
  provenance: DomainProvenanceV1;
  confirmationStatus: ConstraintConfirmationStatus;
}>;

export type ConstraintSetV1 = Readonly<{
  schemaVersion: typeof CONSTRAINT_SET_SCHEMA_VERSION;
  constraintSetId: string;
  version: number;
  projectId: string;
  intentVersionId: string;
  validatedAgainstProjectFingerprint: string;
  activeConstraints: readonly ActiveConstraintV1[];
  confirmedBindings: readonly EnforcementReadyBindingV1[];
  resolutionIds: readonly string[];
  constraintFingerprint: string;
}>;

export class ConstraintDomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConstraintDomainValidationError";
  }
}

function fail(message: string): never {
  throw new ConstraintDomainValidationError(message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || actual.some((key) => !allowed.has(key))) {
    fail(`${label} contains missing or unknown fields.`);
  }
}

function safeIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > MAX_ID_LENGTH
    || /\u0000/.test(value)
    || /^(?:blob:|file:|https?:)/i.test(value)
    || /[\\/]/.test(value)
  ) fail(`${label} must be a bounded trusted identity, not a URL or path.`);
  return value;
}

function matchingId(value: unknown, label: string, pattern: RegExp): string {
  const id = safeIdentity(value, label);
  if (!pattern.test(id)) fail(`${label} is not a valid deterministic identity.`);
  return id;
}

function safeVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(`${label} must be a positive safe integer.`);
  return Number(value);
}

function safeTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a non-negative integer millisecond value.`);
  return Number(value);
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

function constraintProvenance(value: unknown): DomainProvenanceV1 {
  try {
    return parseDomainProvenance(value);
  } catch (error) {
    if (error instanceof CreativeIntentValidationError) fail(`Invalid constraint provenance: ${error.message}`);
    throw error;
  }
}

function unresolvedReference(value: unknown): UnresolvedSemanticReferenceV1 {
  try {
    return parseUnresolvedSemanticReference(value);
  } catch (error) {
    if (error instanceof CreativeIntentValidationError) fail(`Invalid unresolved semantic reference: ${error.message}`);
    throw error;
  }
}

export function parseTimeRange(value: unknown): TimeRangeV1 {
  if (!plainRecord(value)) fail("time range must be an object.");
  if (value.coordinateSpace === "TIMELINE") {
    exactKeys(value, ["schemaVersion", "coordinateSpace", "startMs", "endMs"], [], "timeline range");
    if (value.schemaVersion !== TIME_RANGE_SCHEMA_VERSION) fail("time range has an unsupported schema version.");
    const startMs = safeTime(value.startMs, "range.startMs");
    const endMs = safeTime(value.endMs, "range.endMs");
    if (endMs <= startMs) fail("range.endMs must be greater than range.startMs.");
    return deepFreeze({ schemaVersion: TIME_RANGE_SCHEMA_VERSION, coordinateSpace: "TIMELINE", startMs, endMs });
  }
  if (value.coordinateSpace === "SOURCE_ASSET") {
    exactKeys(value, ["schemaVersion", "coordinateSpace", "assetId", "startMs", "endMs"], [], "source-asset range");
    if (value.schemaVersion !== TIME_RANGE_SCHEMA_VERSION) fail("time range has an unsupported schema version.");
    const startMs = safeTime(value.startMs, "range.startMs");
    const endMs = safeTime(value.endMs, "range.endMs");
    if (endMs <= startMs) fail("range.endMs must be greater than range.startMs.");
    return deepFreeze({
      schemaVersion: TIME_RANGE_SCHEMA_VERSION,
      coordinateSpace: "SOURCE_ASSET",
      assetId: safeIdentity(value.assetId, "range.assetId"),
      startMs,
      endMs,
    });
  }
  fail("time range has an unknown coordinate space.");
}

const PERMISSION_KEYS = [
  "allowDelete",
  "allowTrim",
  "allowMove",
  "allowSpeedChange",
  "allowAssetReplace",
  "allowCaptionTextChange",
  "allowTimingChange",
  "allowSplit",
  "allowTransformChange",
  "allowAudioRangeChange",
] as const;

export function parseProtectionPermissionPolicy(value: unknown): ProtectionPermissionPolicyV1 {
  if (!plainRecord(value)) fail("protection permission policy must be an object.");
  exactKeys(value, PERMISSION_KEYS, [], "protection permission policy");
  for (const key of PERMISSION_KEYS) {
    if (typeof value[key] !== "boolean") fail(`protection permission ${key} must be an explicit boolean.`);
  }
  return deepFreeze(Object.fromEntries(PERMISSION_KEYS.map((key) => [key, value[key]])) as ProtectionPermissionPolicyV1);
}

export const PROTECTED_SPEECH_PERMISSIONS: ProtectionPermissionPolicyV1 = parseProtectionPermissionPolicy({
  allowDelete: false,
  allowTrim: false,
  allowMove: false,
  allowSpeedChange: false,
  allowAssetReplace: false,
  allowCaptionTextChange: false,
  allowTimingChange: false,
  allowSplit: false,
  allowTransformChange: false,
  allowAudioRangeChange: false,
});

export const PROTECTED_ENDING_LOGO_PERMISSIONS: ProtectionPermissionPolicyV1 = parseProtectionPermissionPolicy({
  allowDelete: false,
  allowTrim: false,
  allowMove: false,
  allowSpeedChange: false,
  allowAssetReplace: false,
  allowCaptionTextChange: true,
  allowTimingChange: false,
  allowSplit: false,
  allowTransformChange: false,
  allowAudioRangeChange: true,
});

function parseState(value: unknown): BindingLifecycleState {
  const states: readonly BindingLifecycleState[] = [
    "UNRESOLVED_REFERENCE",
    "CANDIDATE_BINDING",
    "USER_CONFIRMED_BINDING",
    "ACTIVE_HARD_CONSTRAINT",
    "STALE_BINDING",
  ];
  if (!states.includes(value as BindingLifecycleState)) fail("binding has an unknown lifecycle state.");
  return value as BindingLifecycleState;
}

function trustedAuthority(provenance: DomainProvenanceV1): boolean {
  return ["USER_DIRECT_SELECTION", "USER_CONFIRMED_BINDING", "DETERMINISTIC_PROJECT_FACT"].includes(provenance.authority);
}

function validateStateTrust(state: BindingLifecycleState, provenance: DomainProvenanceV1): void {
  if (state === "ACTIVE_HARD_CONSTRAINT" && !trustedAuthority(provenance)) {
    fail("An active hard-constraint binding requires user authorization or a deterministic project fact.");
  }
  if (state === "USER_CONFIRMED_BINDING"
    && !["USER_DIRECT_SELECTION", "USER_CONFIRMED_BINDING"].includes(provenance.authority)) {
    fail("A user-confirmed binding requires user confirmation provenance.");
  }
}

type WithoutBindingIdentity<T> = T extends unknown ? Omit<T, "bindingId" | "schemaVersion"> : never;
type BindingWithoutIdentity = WithoutBindingIdentity<ConstraintBindingV1>;

function bindingIdentityMaterial(binding: BindingWithoutIdentity): unknown {
  if (binding.bindingType === "UNRESOLVED_SEMANTIC_REFERENCE") {
    return { projectId: binding.projectId, bindingType: binding.bindingType, semanticReference: binding.semanticReference };
  }
  if (binding.bindingType === "CLIP") {
    return { projectId: binding.projectId, bindingType: binding.bindingType, clipId: binding.clipId, assetId: binding.assetId, trackId: binding.trackId };
  }
  if (binding.bindingType === "CAPTION") {
    return { projectId: binding.projectId, bindingType: binding.bindingType, captionId: binding.captionId };
  }
  if (binding.bindingType === "TIME_RANGE") {
    return { projectId: binding.projectId, bindingType: binding.bindingType, range: binding.range };
  }
  return {
    projectId: binding.projectId,
    bindingType: binding.bindingType,
    assetId: binding.assetId,
    startMs: binding.startMs,
    endMs: binding.endMs,
    analysisVersion: binding.analysisVersion,
  };
}

export function createConstraintBindingId(binding: BindingWithoutIdentity): string {
  return `binding-v1-${fnv1a(stable(bindingIdentityMaterial(binding)))}`;
}

function normalizeBindingDraft(value: unknown): BindingWithoutIdentity {
  if (!plainRecord(value)) fail("constraint binding draft must be an object.");
  const commonKeys = ["bindingType", "projectId", "state", "provenance"] as const;
  const bindingType = value.bindingType;
  const projectId = safeIdentity(value.projectId, "binding.projectId");
  const state = parseState(value.state);
  const provenance = constraintProvenance(value.provenance);
  if (bindingType === "UNRESOLVED_SEMANTIC_REFERENCE") {
    exactKeys(value, [...commonKeys, "semanticReference"], [], "unresolved semantic binding draft");
    if (state !== "UNRESOLVED_REFERENCE") fail("An unresolved semantic binding must remain UNRESOLVED_REFERENCE.");
    return deepFreeze({
      bindingType,
      projectId,
      state,
      semanticReference: unresolvedReference(value.semanticReference),
      provenance,
    });
  }
  if (state === "UNRESOLVED_REFERENCE") fail("Only semantic-reference bindings may use UNRESOLVED_REFERENCE.");
  validateStateTrust(state, provenance);
  if (bindingType === "CLIP") {
    exactKeys(value, [...commonKeys, "clipId", "assetId", "trackId"], [], "clip binding draft");
    return deepFreeze({
      bindingType,
      projectId,
      state,
      clipId: safeIdentity(value.clipId, "binding.clipId"),
      assetId: safeIdentity(value.assetId, "binding.assetId"),
      trackId: safeIdentity(value.trackId, "binding.trackId"),
      provenance,
    });
  }
  if (bindingType === "CAPTION") {
    exactKeys(value, [...commonKeys, "captionId"], [], "caption binding draft");
    return deepFreeze({
      bindingType,
      projectId,
      state,
      captionId: safeIdentity(value.captionId, "binding.captionId"),
      provenance,
    });
  }
  if (bindingType === "TIME_RANGE") {
    exactKeys(value, [...commonKeys, "range"], [], "time-range binding draft");
    return deepFreeze({ bindingType, projectId, state, range: parseTimeRange(value.range), provenance });
  }
  if (bindingType === "VIDEO_SEMANTIC_SOURCE_RANGE") {
    exactKeys(value, [...commonKeys, "assetId", "startMs", "endMs", "analysisVersion"], [], "video-semantic binding draft");
    const startMs = safeTime(value.startMs, "binding.startMs");
    const endMs = safeTime(value.endMs, "binding.endMs");
    if (endMs <= startMs) fail("binding.endMs must be greater than binding.startMs.");
    return deepFreeze({
      bindingType,
      projectId,
      state,
      assetId: safeIdentity(value.assetId, "binding.assetId"),
      startMs,
      endMs,
      analysisVersion: safeIdentity(value.analysisVersion, "binding.analysisVersion"),
      provenance,
    });
  }
  fail("constraint binding has an unknown bindingType.");
}

export function createConstraintBinding(value: unknown): ConstraintBindingV1 {
  const draft = normalizeBindingDraft(value);
  return deepFreeze({
    schemaVersion: CONSTRAINT_DOMAIN_SCHEMA_VERSION,
    bindingId: createConstraintBindingId(draft),
    ...draft,
  }) as ConstraintBindingV1;
}

export function parseConstraintBinding(value: unknown): ConstraintBindingV1 {
  if (!plainRecord(value)) fail("ConstraintBindingV1 must be an object.");
  if (value.schemaVersion !== CONSTRAINT_DOMAIN_SCHEMA_VERSION) fail("ConstraintBindingV1 has an unsupported schema version.");
  const { schemaVersion: _schemaVersion, bindingId: _bindingId, ...draft } = value;
  const recreated = createConstraintBinding(draft);
  const suppliedId = matchingId(value.bindingId, "binding.bindingId", BINDING_ID_PATTERN);
  if (suppliedId !== recreated.bindingId) fail("bindingId does not match deterministic binding content.");
  return recreated;
}

function sameProvenance(left: DomainProvenanceV1, right: DomainProvenanceV1): boolean {
  return stable(left) === stable(right);
}

function validateConstraintBindingType(type: ActiveConstraintType, binding: EnforcementReadyBindingV1): void {
  if (type === "PROTECT_CLIP" && binding.bindingType !== "CLIP") {
    fail("PROTECT_CLIP requires a trusted clip binding.");
  }
  if (type === "PROTECT_TIME_RANGE"
    && binding.bindingType !== "TIME_RANGE"
    && binding.bindingType !== "VIDEO_SEMANTIC_SOURCE_RANGE") {
    fail("PROTECT_TIME_RANGE requires a trusted time-range or video-semantic source-range binding.");
  }
  if (type === "PRESERVE_ENDING"
    && !["CLIP", "TIME_RANGE", "VIDEO_SEMANTIC_SOURCE_RANGE"].includes(binding.bindingType)) {
    fail("PRESERVE_ENDING requires a trusted clip or range binding.");
  }
}

type ActiveConstraintDraft = Readonly<{
  type: ActiveConstraintType;
  sourceClauseId: string;
  binding: EnforcementReadyBindingV1;
  permissions: ProtectionPermissionPolicyV1;
  provenance: DomainProvenanceV1;
  confirmationStatus: ConstraintConfirmationStatus;
}>;

function activeConstraintIdentityMaterial(value: Omit<ActiveConstraintV1, "constraintId" | "schemaVersion">): unknown {
  return value;
}

export function createActiveConstraintId(value: Omit<ActiveConstraintV1, "constraintId" | "schemaVersion">): string {
  return `constraint-v1-${fnv1a(stable(activeConstraintIdentityMaterial(value)))}`;
}

function normalizeActiveConstraintDraft(value: unknown): ActiveConstraintDraft {
  if (!plainRecord(value)) fail("active constraint draft must be an object.");
  exactKeys(
    value,
    ["type", "sourceClauseId", "binding", "permissions", "provenance", "confirmationStatus"],
    [],
    "active constraint draft",
  );
  if (!["PROTECT_TIME_RANGE", "PROTECT_CLIP", "PRESERVE_ENDING"].includes(String(value.type))) {
    fail("active constraint has an unknown type.");
  }
  const binding = parseConstraintBinding(value.binding);
  if (binding.bindingType === "UNRESOLVED_SEMANTIC_REFERENCE") {
    fail("An unresolved semantic reference cannot activate a hard constraint.");
  }
  if (binding.state !== "ACTIVE_HARD_CONSTRAINT") {
    fail("An active constraint requires an explicitly active, confirmed/trusted binding.");
  }
  const provenance = constraintProvenance(value.provenance);
  const confirmationStatus = value.confirmationStatus;
  if (confirmationStatus !== "USER_CONFIRMED" && confirmationStatus !== "TRUSTED_PROJECT_FACT") {
    fail("active constraint has an unknown confirmation status.");
  }
  if (confirmationStatus === "USER_CONFIRMED"
    && !["USER_DIRECT_SELECTION", "USER_CONFIRMED_BINDING"].includes(provenance.authority)) {
    fail("USER_CONFIRMED activation requires user-authoritative provenance.");
  }
  if (confirmationStatus === "TRUSTED_PROJECT_FACT" && provenance.authority !== "DETERMINISTIC_PROJECT_FACT") {
    fail("TRUSTED_PROJECT_FACT activation requires deterministic project provenance.");
  }
  if (!sameProvenance(binding.provenance, provenance)) {
    fail("active constraint provenance must match its trusted binding provenance.");
  }
  validateConstraintBindingType(value.type as ActiveConstraintType, binding);
  return deepFreeze({
    type: value.type as ActiveConstraintType,
    sourceClauseId: matchingId(value.sourceClauseId, "sourceClauseId", CLAUSE_ID_PATTERN),
    binding,
    permissions: parseProtectionPermissionPolicy(value.permissions),
    provenance,
    confirmationStatus,
  });
}

export function createActiveConstraint(value: unknown): ActiveConstraintV1 {
  const draft = normalizeActiveConstraintDraft(value);
  const withoutIdentity: Omit<ActiveConstraintV1, "constraintId" | "schemaVersion"> = {
    type: draft.type,
    sourceClauseId: draft.sourceClauseId,
    bindingId: draft.binding.bindingId,
    permissions: draft.permissions,
    provenance: draft.provenance,
    confirmationStatus: draft.confirmationStatus,
  };
  return deepFreeze({
    schemaVersion: CONSTRAINT_DOMAIN_SCHEMA_VERSION,
    constraintId: createActiveConstraintId(withoutIdentity),
    ...withoutIdentity,
  });
}

function parseActiveConstraintShape(value: unknown): ActiveConstraintV1 {
  if (!plainRecord(value)) fail("ActiveConstraintV1 must be an object.");
  exactKeys(
    value,
    ["schemaVersion", "constraintId", "type", "sourceClauseId", "bindingId", "permissions", "provenance", "confirmationStatus"],
    [],
    "ActiveConstraintV1",
  );
  if (value.schemaVersion !== CONSTRAINT_DOMAIN_SCHEMA_VERSION) fail("ActiveConstraintV1 has an unsupported schema version.");
  if (!["PROTECT_TIME_RANGE", "PROTECT_CLIP", "PRESERVE_ENDING"].includes(String(value.type))) {
    fail("ActiveConstraintV1 has an unknown type.");
  }
  const confirmationStatus = value.confirmationStatus;
  if (confirmationStatus !== "USER_CONFIRMED" && confirmationStatus !== "TRUSTED_PROJECT_FACT") {
    fail("ActiveConstraintV1 has an unknown confirmation status.");
  }
  const withoutIdentity: Omit<ActiveConstraintV1, "constraintId" | "schemaVersion"> = {
    type: value.type as ActiveConstraintType,
    sourceClauseId: matchingId(value.sourceClauseId, "sourceClauseId", CLAUSE_ID_PATTERN),
    bindingId: matchingId(value.bindingId, "bindingId", BINDING_ID_PATTERN),
    permissions: parseProtectionPermissionPolicy(value.permissions),
    provenance: constraintProvenance(value.provenance),
    confirmationStatus,
  };
  const suppliedId = matchingId(value.constraintId, "constraintId", CONSTRAINT_ID_PATTERN);
  if (suppliedId !== createActiveConstraintId(withoutIdentity)) {
    fail("constraintId does not match deterministic active-constraint content.");
  }
  return deepFreeze({ schemaVersion: CONSTRAINT_DOMAIN_SCHEMA_VERSION, constraintId: suppliedId, ...withoutIdentity });
}

function parseResolutionIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_RESOLUTION_IDS) fail("resolutionIds must be a bounded array.");
  const ids = value.map((item, index) => safeIdentity(item, `resolutionIds[${index}]`));
  if (new Set(ids).size !== ids.length) fail("resolutionIds must not contain duplicates.");
  return Object.freeze(ids);
}

function constraintFingerprintMaterial(value: Omit<ConstraintSetV1, "constraintSetId" | "constraintFingerprint" | "schemaVersion" | "version" | "intentVersionId" | "resolutionIds">): unknown {
  return {
    projectId: value.projectId,
    validatedAgainstProjectFingerprint: value.validatedAgainstProjectFingerprint,
    activeConstraints: value.activeConstraints,
    confirmedBindings: value.confirmedBindings,
  };
}

export function createConstraintFingerprint(
  value: Omit<ConstraintSetV1, "constraintSetId" | "constraintFingerprint" | "schemaVersion" | "version" | "intentVersionId" | "resolutionIds">,
): string {
  return `constraint-fingerprint-v1-${fnv1a(stable(constraintFingerprintMaterial(value)))}`;
}

function constraintSetIdentityMaterial(value: Omit<ConstraintSetV1, "constraintSetId" | "schemaVersion">): unknown {
  return value;
}

export function createConstraintSetId(value: Omit<ConstraintSetV1, "constraintSetId" | "schemaVersion">): string {
  return `constraint-set-v1-${fnv1a(stable(constraintSetIdentityMaterial(value)))}`;
}

function validateActiveConstraintAgainstBinding(
  constraint: ActiveConstraintV1,
  binding: EnforcementReadyBindingV1 | undefined,
): void {
  if (!binding) fail(`Active constraint ${constraint.constraintId} references a missing confirmed binding.`);
  if (binding.state !== "ACTIVE_HARD_CONSTRAINT") {
    fail(`Active constraint ${constraint.constraintId} references an unconfirmed or stale binding.`);
  }
  validateConstraintBindingType(constraint.type, binding);
  if (!sameProvenance(constraint.provenance, binding.provenance)) {
    fail(`Active constraint ${constraint.constraintId} provenance differs from its binding.`);
  }
  if (constraint.confirmationStatus === "USER_CONFIRMED"
    && !["USER_DIRECT_SELECTION", "USER_CONFIRMED_BINDING"].includes(binding.provenance.authority)) {
    fail("A user-confirmed active constraint requires user-authoritative binding provenance.");
  }
  if (constraint.confirmationStatus === "TRUSTED_PROJECT_FACT"
    && binding.provenance.authority !== "DETERMINISTIC_PROJECT_FACT") {
    fail("A deterministic active constraint requires deterministic project provenance.");
  }
}

type ConstraintSetDraft = Omit<ConstraintSetV1, "schemaVersion" | "constraintSetId" | "constraintFingerprint">;

function normalizeConstraintSetDraft(value: unknown): ConstraintSetDraft {
  if (!plainRecord(value)) fail("ConstraintSet draft must be an object.");
  exactKeys(
    value,
    ["version", "projectId", "intentVersionId", "validatedAgainstProjectFingerprint", "activeConstraints", "confirmedBindings", "resolutionIds"],
    [],
    "ConstraintSet draft",
  );
  const version = safeVersion(value.version, "constraintSet.version");
  const projectId = safeIdentity(value.projectId, "constraintSet.projectId");
  const intentVersionId = matchingId(value.intentVersionId, "constraintSet.intentVersionId", INTENT_ID_PATTERN);
  const validatedAgainstProjectFingerprint = matchingId(
    value.validatedAgainstProjectFingerprint,
    "constraintSet.validatedAgainstProjectFingerprint",
    PROJECT_FINGERPRINT_PATTERN,
  );
  if (!Array.isArray(value.confirmedBindings) || value.confirmedBindings.length > MAX_BINDINGS) {
    fail("confirmedBindings must be a bounded array.");
  }
  const confirmedBindings = value.confirmedBindings.map((item, index) => {
    const binding = parseConstraintBinding(item);
    if (binding.bindingType === "UNRESOLVED_SEMANTIC_REFERENCE") {
      fail(`confirmedBindings[${index}] cannot contain an unresolved semantic reference.`);
    }
    if (binding.state !== "USER_CONFIRMED_BINDING" && binding.state !== "ACTIVE_HARD_CONSTRAINT") {
      fail(`confirmedBindings[${index}] must be confirmed and non-stale.`);
    }
    if (binding.projectId !== projectId) fail(`confirmedBindings[${index}] belongs to a different project.`);
    return binding;
  });
  if (new Set(confirmedBindings.map((binding) => binding.bindingId)).size !== confirmedBindings.length) {
    fail("confirmedBindings must not contain duplicate binding identities.");
  }
  if (!Array.isArray(value.activeConstraints) || value.activeConstraints.length > MAX_CONSTRAINTS) {
    fail("activeConstraints must be a bounded array.");
  }
  const activeConstraints = value.activeConstraints.map(parseActiveConstraintShape);
  if (new Set(activeConstraints.map((constraint) => constraint.constraintId)).size !== activeConstraints.length) {
    fail("activeConstraints must not contain duplicate constraint identities.");
  }
  const bindingById = new Map(confirmedBindings.map((binding) => [binding.bindingId, binding]));
  activeConstraints.forEach((constraint) => validateActiveConstraintAgainstBinding(constraint, bindingById.get(constraint.bindingId)));
  return deepFreeze({
    version,
    projectId,
    intentVersionId,
    validatedAgainstProjectFingerprint,
    activeConstraints: Object.freeze(activeConstraints),
    confirmedBindings: Object.freeze(confirmedBindings),
    resolutionIds: parseResolutionIds(value.resolutionIds),
  });
}

export function createConstraintSet(value: unknown): ConstraintSetV1 {
  const draft = normalizeConstraintSetDraft(value);
  const fingerprintInput = {
    projectId: draft.projectId,
    validatedAgainstProjectFingerprint: draft.validatedAgainstProjectFingerprint,
    activeConstraints: draft.activeConstraints,
    confirmedBindings: draft.confirmedBindings,
  };
  const constraintFingerprint = createConstraintFingerprint(fingerprintInput);
  const withoutSetIdentity: Omit<ConstraintSetV1, "constraintSetId" | "schemaVersion"> = {
    ...draft,
    constraintFingerprint,
  };
  return deepFreeze({
    schemaVersion: CONSTRAINT_SET_SCHEMA_VERSION,
    constraintSetId: createConstraintSetId(withoutSetIdentity),
    ...withoutSetIdentity,
  });
}

export function parseConstraintSet(value: unknown): ConstraintSetV1 {
  if (!plainRecord(value)) fail("ConstraintSetV1 must be an object.");
  exactKeys(
    value,
    [
      "schemaVersion",
      "constraintSetId",
      "version",
      "projectId",
      "intentVersionId",
      "validatedAgainstProjectFingerprint",
      "activeConstraints",
      "confirmedBindings",
      "resolutionIds",
      "constraintFingerprint",
    ],
    [],
    "ConstraintSetV1",
  );
  if (value.schemaVersion !== CONSTRAINT_SET_SCHEMA_VERSION) fail("ConstraintSetV1 has an unsupported schema version.");
  const recreated = createConstraintSet({
    version: value.version,
    projectId: value.projectId,
    intentVersionId: value.intentVersionId,
    validatedAgainstProjectFingerprint: value.validatedAgainstProjectFingerprint,
    activeConstraints: value.activeConstraints,
    confirmedBindings: value.confirmedBindings,
    resolutionIds: value.resolutionIds,
  });
  const suppliedFingerprint = matchingId(value.constraintFingerprint, "constraintFingerprint", CONSTRAINT_FINGERPRINT_PATTERN);
  if (suppliedFingerprint !== recreated.constraintFingerprint) fail("constraintFingerprint does not match active constraint content.");
  const suppliedSetId = matchingId(value.constraintSetId, "constraintSetId", CONSTRAINT_SET_ID_PATTERN);
  if (suppliedSetId !== recreated.constraintSetId) fail("constraintSetId does not match deterministic set content.");
  return recreated;
}

/**
 * Returns whether a valid ConstraintSet can constrain an editor mutation.
 * Lineage-only fields and confirmed bindings without an active hard constraint
 * do not grant or deny mutation permission.
 */
export function hasEnforceableConstraintsV1(value: ConstraintSetV1): boolean {
  const set = parseConstraintSet(value);
  const activeBindingIds = new Set(set.confirmedBindings
    .filter((binding) => binding.state === "ACTIVE_HARD_CONSTRAINT")
    .map((binding) => binding.bindingId));
  return set.activeConstraints.some((constraint) => activeBindingIds.has(constraint.bindingId));
}
