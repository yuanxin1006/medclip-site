export const CREATIVE_INTENT_SCHEMA_VERSION = 1 as const;
export const UNRESOLVED_SEMANTIC_REFERENCE_SCHEMA_VERSION = 1 as const;

const MAX_ID_LENGTH = 512;
const MAX_SOURCE_REQUEST_LENGTH = 24_000;
const MAX_REFERENCE_TEXT_LENGTH = 2_000;
const MAX_CLAUSES = 128;
const MAX_RESOLUTION_IDS = 128;
const DOMAIN_ID_PATTERN = /^(?:intent|clause)-v1-[0-9a-f]{8}$/;

export type DomainProvenanceAuthority =
  | "USER_TEXT"
  | "USER_DIRECT_SELECTION"
  | "USER_CONFIRMED_BINDING"
  | "DETERMINISTIC_PROJECT_FACT"
  | "MODEL_SUGGESTION"
  | "MODEL_UNCERTAIN_INFERENCE";

export type DomainProvenanceV1 = Readonly<{
  schemaVersion: 1;
  authority: DomainProvenanceAuthority;
  sourceReference: string;
}>;

export type DurationPolicy =
  | "TARGET"
  | "APPROXIMATE_TARGET"
  | "MAXIMUM"
  | "MINIMUM"
  | "EXACT";

export type TargetDurationGoal = Readonly<{
  type: "TARGET_DURATION";
  durationMs: number;
  policy: DurationPolicy;
}>;

export type PacePreference = Readonly<{
  type: "PACE";
  value: "UPBEAT";
}>;

export type SemanticReferenceKind = "SPEECH" | "VISUAL_OBJECT" | "ENDING_CONTENT" | "OTHER";

export type UnresolvedSemanticReferenceV1 = Readonly<{
  schemaVersion: typeof UNRESOLVED_SEMANTIC_REFERENCE_SCHEMA_VERSION;
  state: "UNRESOLVED_REFERENCE";
  semanticKind: SemanticReferenceKind;
  referenceText: string;
}>;

export type HardConstraintRequestPayload = Readonly<{
  type: "PROTECT_TIME_RANGE" | "PROTECT_CLIP" | "PRESERVE_ENDING";
  reference: UnresolvedSemanticReferenceV1;
}>;

type IntentClauseBase = Readonly<{
  clauseId: string;
  provenance: DomainProvenanceV1;
}>;

export type GoalIntentClause = IntentClauseBase & Readonly<{
  kind: "GOAL";
  payload: TargetDurationGoal;
}>;

export type SoftPreferenceIntentClause = IntentClauseBase & Readonly<{
  kind: "SOFT_PREFERENCE";
  payload: PacePreference;
}>;

export type HardConstraintRequestIntentClause = IntentClauseBase & Readonly<{
  kind: "HARD_CONSTRAINT_REQUEST";
  payload: HardConstraintRequestPayload;
}>;

export type IntentClauseV1 =
  | GoalIntentClause
  | SoftPreferenceIntentClause
  | HardConstraintRequestIntentClause;

export type IntentGroundingState =
  | "NOT_REQUIRED"
  | "UNRESOLVED_REFERENCE"
  | "CANDIDATE_BINDING"
  | "USER_CONFIRMED_BINDING"
  | "ACTIVE_HARD_CONSTRAINT"
  | "STALE_BINDING";

export type CreativeIntentV1 = Readonly<{
  schemaVersion: typeof CREATIVE_INTENT_SCHEMA_VERSION;
  intentId: string;
  version: number;
  projectId: string;
  parentIntentVersionId?: string;
  sourceRequest: string;
  clauses: readonly IntentClauseV1[];
  groundingState: IntentGroundingState;
  resolutionIds: readonly string[];
  createdAt: string;
}>;

export type IntentClauseDraft =
  | Readonly<{ kind: "GOAL"; payload: TargetDurationGoal; provenance: DomainProvenanceV1 }>
  | Readonly<{ kind: "SOFT_PREFERENCE"; payload: PacePreference; provenance: DomainProvenanceV1 }>
  | Readonly<{ kind: "HARD_CONSTRAINT_REQUEST"; payload: HardConstraintRequestPayload; provenance: DomainProvenanceV1 }>;

export type CreativeIntentDraft = Readonly<{
  version: number;
  projectId: string;
  parentIntentVersionId?: string;
  sourceRequest: string;
  clauses: readonly IntentClauseDraft[];
  groundingState: IntentGroundingState;
  resolutionIds: readonly string[];
  createdAt: string;
}>;

export class CreativeIntentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreativeIntentValidationError";
  }
}

function fail(message: string): never {
  throw new CreativeIntentValidationError(message);
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

function safeDomainId(value: unknown, label: string, prefix?: "intent" | "clause"): string {
  const id = safeIdentity(value, label);
  if (!DOMAIN_ID_PATTERN.test(id) || prefix && !id.startsWith(`${prefix}-v1-`)) {
    fail(`${label} is not a valid deterministic V1 domain identity.`);
  }
  return id;
}

function preservedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > maximum
    || /\u0000/.test(value)
  ) fail(`${label} must be non-empty bounded text.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(`${label} must be a positive safe integer.`);
  return Number(value);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 64) fail(`${label} must be a canonical ISO timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
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

export function parseDomainProvenance(value: unknown): DomainProvenanceV1 {
  if (!plainRecord(value)) fail("provenance must be an object.");
  exactKeys(value, ["schemaVersion", "authority", "sourceReference"], [], "provenance");
  if (value.schemaVersion !== 1) fail("provenance has an unsupported schema version.");
  const authorities: readonly DomainProvenanceAuthority[] = [
    "USER_TEXT",
    "USER_DIRECT_SELECTION",
    "USER_CONFIRMED_BINDING",
    "DETERMINISTIC_PROJECT_FACT",
    "MODEL_SUGGESTION",
    "MODEL_UNCERTAIN_INFERENCE",
  ];
  if (!authorities.includes(value.authority as DomainProvenanceAuthority)) fail("provenance has an unknown authority.");
  return deepFreeze({
    schemaVersion: 1,
    authority: value.authority as DomainProvenanceAuthority,
    sourceReference: preservedText(value.sourceReference, "provenance.sourceReference", MAX_REFERENCE_TEXT_LENGTH),
  });
}

export function parseUnresolvedSemanticReference(value: unknown): UnresolvedSemanticReferenceV1 {
  if (!plainRecord(value)) fail("semantic reference must be an object.");
  exactKeys(value, ["schemaVersion", "state", "semanticKind", "referenceText"], [], "semantic reference");
  if (value.schemaVersion !== UNRESOLVED_SEMANTIC_REFERENCE_SCHEMA_VERSION
    || value.state !== "UNRESOLVED_REFERENCE") {
    fail("semantic reference must remain explicitly unresolved in V2.3B.");
  }
  const kinds: readonly SemanticReferenceKind[] = ["SPEECH", "VISUAL_OBJECT", "ENDING_CONTENT", "OTHER"];
  if (!kinds.includes(value.semanticKind as SemanticReferenceKind)) fail("semantic reference has an unknown kind.");
  return deepFreeze({
    schemaVersion: UNRESOLVED_SEMANTIC_REFERENCE_SCHEMA_VERSION,
    state: "UNRESOLVED_REFERENCE",
    semanticKind: value.semanticKind as SemanticReferenceKind,
    referenceText: preservedText(value.referenceText, "semanticReference.referenceText", MAX_REFERENCE_TEXT_LENGTH),
  });
}

function parseGoal(value: unknown): TargetDurationGoal {
  if (!plainRecord(value)) fail("GOAL payload must be an object.");
  exactKeys(value, ["type", "durationMs", "policy"], [], "GOAL payload");
  if (value.type !== "TARGET_DURATION") fail("GOAL payload has an unknown type.");
  if (!Number.isSafeInteger(value.durationMs) || Number(value.durationMs) <= 0) {
    fail("TARGET_DURATION durationMs must be a positive integer millisecond value.");
  }
  const policies: readonly DurationPolicy[] = ["TARGET", "APPROXIMATE_TARGET", "MAXIMUM", "MINIMUM", "EXACT"];
  if (!policies.includes(value.policy as DurationPolicy)) fail("TARGET_DURATION has an unknown policy.");
  return deepFreeze({ type: "TARGET_DURATION", durationMs: Number(value.durationMs), policy: value.policy as DurationPolicy });
}

function parsePreference(value: unknown): PacePreference {
  if (!plainRecord(value)) fail("SOFT_PREFERENCE payload must be an object.");
  exactKeys(value, ["type", "value"], [], "SOFT_PREFERENCE payload");
  if (value.type !== "PACE" || value.value !== "UPBEAT") fail("SOFT_PREFERENCE has an unsupported type or value.");
  return deepFreeze({ type: "PACE", value: "UPBEAT" });
}

function parseHardRequest(value: unknown): HardConstraintRequestPayload {
  if (!plainRecord(value)) fail("HARD_CONSTRAINT_REQUEST payload must be an object.");
  exactKeys(value, ["type", "reference"], [], "HARD_CONSTRAINT_REQUEST payload");
  if (!["PROTECT_TIME_RANGE", "PROTECT_CLIP", "PRESERVE_ENDING"].includes(String(value.type))) {
    fail("HARD_CONSTRAINT_REQUEST has an unknown type.");
  }
  return deepFreeze({
    type: value.type as HardConstraintRequestPayload["type"],
    reference: parseUnresolvedSemanticReference(value.reference),
  });
}

function parseClauseDraft(value: unknown): IntentClauseDraft {
  if (!plainRecord(value)) fail("intent clause draft must be an object.");
  exactKeys(value, ["kind", "payload", "provenance"], [], "intent clause draft");
  const provenance = parseDomainProvenance(value.provenance);
  if (value.kind === "GOAL") return deepFreeze({ kind: "GOAL", payload: parseGoal(value.payload), provenance });
  if (value.kind === "SOFT_PREFERENCE") {
    return deepFreeze({ kind: "SOFT_PREFERENCE", payload: parsePreference(value.payload), provenance });
  }
  if (value.kind === "HARD_CONSTRAINT_REQUEST") {
    return deepFreeze({ kind: "HARD_CONSTRAINT_REQUEST", payload: parseHardRequest(value.payload), provenance });
  }
  fail("intent clause has an unknown kind.");
}

function clauseMaterial(clause: IntentClauseDraft): unknown {
  return { kind: clause.kind, payload: clause.payload, provenance: clause.provenance };
}

export function createIntentClauseId(
  projectIdValue: unknown,
  intentVersionValue: unknown,
  clauseIndexValue: unknown,
  clauseValue: unknown,
): string {
  const projectId = safeIdentity(projectIdValue, "projectId");
  const intentVersion = positiveInteger(intentVersionValue, "intentVersion");
  if (!Number.isSafeInteger(clauseIndexValue) || Number(clauseIndexValue) < 0) {
    fail("clauseIndex must be a non-negative safe integer.");
  }
  const clause = parseClauseDraft(clauseValue);
  return `clause-v1-${fnv1a(stable({ projectId, intentVersion, clauseIndex: clauseIndexValue, clause: clauseMaterial(clause) }))}`;
}

function intentIdentityMaterial(value: Omit<CreativeIntentV1, "intentId" | "createdAt">): unknown {
  return {
    schemaVersion: value.schemaVersion,
    version: value.version,
    projectId: value.projectId,
    parentIntentVersionId: value.parentIntentVersionId ?? null,
    sourceRequest: value.sourceRequest,
    clauses: value.clauses,
    groundingState: value.groundingState,
    resolutionIds: value.resolutionIds,
  };
}

export function createCreativeIntentId(value: Omit<CreativeIntentV1, "intentId" | "createdAt">): string {
  return `intent-v1-${fnv1a(stable(intentIdentityMaterial(value)))}`;
}

function parseGroundingState(value: unknown): IntentGroundingState {
  const states: readonly IntentGroundingState[] = [
    "NOT_REQUIRED",
    "UNRESOLVED_REFERENCE",
    "CANDIDATE_BINDING",
    "USER_CONFIRMED_BINDING",
    "ACTIVE_HARD_CONSTRAINT",
    "STALE_BINDING",
  ];
  if (!states.includes(value as IntentGroundingState)) fail("CreativeIntent has an unknown grounding state.");
  return value as IntentGroundingState;
}

function parseResolutionIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_RESOLUTION_IDS) fail("resolutionIds must be a bounded array.");
  const ids = value.map((item, index) => safeIdentity(item, `resolutionIds[${index}]`));
  if (new Set(ids).size !== ids.length) fail("resolutionIds must not contain duplicates.");
  return Object.freeze(ids);
}

function validateGroundingConsistency(clauses: readonly IntentClauseV1[], state: IntentGroundingState): void {
  const hasHardRequest = clauses.some((clause) => clause.kind === "HARD_CONSTRAINT_REQUEST");
  if (!hasHardRequest && state !== "NOT_REQUIRED") fail("An intent without hard-constraint requests must use NOT_REQUIRED grounding state.");
  if (hasHardRequest && state === "NOT_REQUIRED") fail("Hard-constraint requests require an explicit grounding lifecycle state.");
}

export function createCreativeIntent(value: unknown): CreativeIntentV1 {
  if (!plainRecord(value)) fail("CreativeIntent draft must be an object.");
  exactKeys(
    value,
    ["version", "projectId", "sourceRequest", "clauses", "groundingState", "resolutionIds", "createdAt"],
    ["parentIntentVersionId"],
    "CreativeIntent draft",
  );
  const version = positiveInteger(value.version, "version");
  const projectId = safeIdentity(value.projectId, "projectId");
  const parentIntentVersionId = value.parentIntentVersionId === undefined
    ? undefined
    : safeDomainId(value.parentIntentVersionId, "parentIntentVersionId", "intent");
  if (version === 1 && parentIntentVersionId !== undefined) fail("Intent version 1 cannot have a parent.");
  if (version > 1 && parentIntentVersionId === undefined) fail("Intent versions after 1 require an immutable parent identity.");
  const sourceRequest = preservedText(value.sourceRequest, "sourceRequest", MAX_SOURCE_REQUEST_LENGTH);
  if (!Array.isArray(value.clauses) || value.clauses.length === 0 || value.clauses.length > MAX_CLAUSES) {
    fail("clauses must be a non-empty bounded array.");
  }
  const clauseDrafts = value.clauses.map(parseClauseDraft);
  const clauses = clauseDrafts.map((clause, index): IntentClauseV1 => deepFreeze({
    clauseId: createIntentClauseId(projectId, version, index, clause),
    ...clause,
  }) as IntentClauseV1);
  if (new Set(clauses.map((clause) => clause.clauseId)).size !== clauses.length) fail("clause identities must be unique.");
  const groundingState = parseGroundingState(value.groundingState);
  validateGroundingConsistency(clauses, groundingState);
  const resolutionIds = parseResolutionIds(value.resolutionIds);
  const withoutIdentity: Omit<CreativeIntentV1, "intentId" | "createdAt"> = {
    schemaVersion: CREATIVE_INTENT_SCHEMA_VERSION,
    version,
    projectId,
    ...(parentIntentVersionId ? { parentIntentVersionId } : {}),
    sourceRequest,
    clauses: Object.freeze(clauses),
    groundingState,
    resolutionIds,
  };
  return deepFreeze({
    ...withoutIdentity,
    intentId: createCreativeIntentId(withoutIdentity),
    createdAt: canonicalTimestamp(value.createdAt, "createdAt"),
  });
}

export function parseCreativeIntent(value: unknown): CreativeIntentV1 {
  if (!plainRecord(value)) fail("CreativeIntentV1 must be an object.");
  exactKeys(
    value,
    ["schemaVersion", "intentId", "version", "projectId", "sourceRequest", "clauses", "groundingState", "resolutionIds", "createdAt"],
    ["parentIntentVersionId"],
    "CreativeIntentV1",
  );
  if (value.schemaVersion !== CREATIVE_INTENT_SCHEMA_VERSION) fail("CreativeIntentV1 has an unsupported schema version.");
  if (!Array.isArray(value.clauses) || value.clauses.length === 0 || value.clauses.length > MAX_CLAUSES) {
    fail("CreativeIntentV1 clauses must be a non-empty bounded array.");
  }
  const draftClauses = value.clauses.map((item, index) => {
    if (!plainRecord(item)) fail(`clauses[${index}] must be an object.`);
    exactKeys(item, ["clauseId", "kind", "payload", "provenance"], [], `clauses[${index}]`);
    return {
      suppliedId: safeDomainId(item.clauseId, `clauses[${index}].clauseId`, "clause"),
      draft: parseClauseDraft({ kind: item.kind, payload: item.payload, provenance: item.provenance }),
    };
  });
  const recreated = createCreativeIntent({
    version: value.version,
    projectId: value.projectId,
    ...(value.parentIntentVersionId === undefined ? {} : { parentIntentVersionId: value.parentIntentVersionId }),
    sourceRequest: value.sourceRequest,
    clauses: draftClauses.map((item) => item.draft),
    groundingState: value.groundingState,
    resolutionIds: value.resolutionIds,
    createdAt: value.createdAt,
  });
  draftClauses.forEach((item, index) => {
    if (item.suppliedId !== recreated.clauses[index].clauseId) fail(`clauses[${index}].clauseId does not match deterministic content.`);
  });
  const suppliedIntentId = safeDomainId(value.intentId, "intentId", "intent");
  if (suppliedIntentId !== recreated.intentId) fail("intentId does not match deterministic content and lineage.");
  return recreated;
}
