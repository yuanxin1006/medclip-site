import {
  createCreativeIntent,
  parseCreativeIntent,
  type CreativeIntentV1,
  type IntentClauseDraft,
} from "./editor-creative-intent.ts";
import {
  buildConstraintSetV1,
  confirmDirectSelectionV1,
  type BuildConstraintSetInputV1,
  type ConfirmedBindingRecordV1,
  type ConstraintGroundingContextV1,
  type GroundingSelectionV1,
} from "./editor-constraint-grounding.ts";
import {
  evaluateConstraintFeasibilityV1,
  type ConstraintConflictV1,
  type ConstraintFeasibilityReportV1,
} from "./editor-constraint-feasibility.ts";
import type { ConstraintSetV1, EnforcementReadyBindingV1 } from "./editor-constraints.ts";
import type { EditorProject } from "./editor-core.ts";
import type { VideoSemanticAnalysis } from "./editor-video-semantic.ts";

export const CONSTRAINT_RESOLUTION_SCHEMA_VERSION = 1 as const;
export const NEGOTIATION_STATE_SCHEMA_VERSION = 1 as const;

export type ConstraintResolutionChoice =
  | "RELAX_TARGET_DURATION"
  | "OPTIMIZE_UNPROTECTED_ONLY"
  | "EDIT_REQUIREMENTS_MANUALLY";

export type ConstraintResolutionPolicyV1 =
  | Readonly<{
    policy: "RELAX_TARGET_DURATION";
    selectedDurationMs: number;
    safeLowerBoundMs: number;
    hardProtections: "UNCHANGED";
  }>
  | Readonly<{
    policy: "CLOSEST_SAFELY_ACHIEVABLE";
    requestedDurationMs: number;
    minimumFeasibleDurationMs: number;
    remainingGapMs: number;
    canReachRequestedDuration: boolean;
    hardProtections: "UNCHANGED";
  }>
  | Readonly<{
    policy: "MANUAL_REQUIREMENT_EDIT";
    planningPaused: true;
    generateProposal: false;
    execute: false;
    preserveConfirmedBindings: true;
  }>;

export type ConstraintResolutionV1 = Readonly<{
  schemaVersion: typeof CONSTRAINT_RESOLUTION_SCHEMA_VERSION;
  resolutionId: string;
  conflictId: string;
  selectedResolution: ConstraintResolutionChoice;
  affectedConstraintIds: readonly string[];
  priorIntentVersionId: string;
  resultingIntentVersionId: string;
  structuredPolicy: ConstraintResolutionPolicyV1;
  userConfirmed: true;
  createdAt: string;
}>;

export type NegotiationStatusV1 =
  | "DRAFT"
  | "GROUNDING_REQUIRED"
  | "FEASIBILITY_CHECK"
  | "NEEDS_USER_DECISION"
  | "RESOLVED"
  | "READY_TO_PLAN"
  | "BLOCKED";

export type NegotiationStateV1 = Readonly<{
  schemaVersion: typeof NEGOTIATION_STATE_SCHEMA_VERSION;
  status: NegotiationStatusV1;
  activeIntentVersionId: string;
  constraintSetId?: string;
  constraintFingerprint?: string;
  feasibilityReportId?: string;
  resolutionIds: readonly string[];
  unresolvedConflictIds: readonly string[];
  planningPaused: boolean;
  reason?: string;
}>;

export type SessionDecisionLedgerV1 = Readonly<{
  schemaVersion: 1;
  projectId: string;
  confirmedBindingIds: readonly string[];
  selectedResolutionIds: readonly string[];
  rejectedProposalOperationTuples: readonly string[];
  humanModifiedSelections: readonly Readonly<{ proposalEntryId: string; selectedAssetId: string }>[];
}>;

export type ProposalConstraintContextV1 = Readonly<{
  sourceIntentVersionId: string;
  sourceConstraintSetId: string;
  sourceConstraintFingerprint: string;
  resolutionIds: readonly string[];
  feasibilityReportId: string;
  readiness: "READY_TO_PLAN";
}>;

export type NegotiationResolutionResultV1 = Readonly<{
  state: NegotiationStateV1;
  resolution: ConstraintResolutionV1;
  priorIntent: CreativeIntentV1;
  resultingIntent: CreativeIntentV1;
  confirmedBindings: readonly ConfirmedBindingRecordV1[];
  constraintSet?: ConstraintSetV1;
  feasibilityReport?: ConstraintFeasibilityReportV1;
  ledger: SessionDecisionLedgerV1;
  proposalContext?: ProposalConstraintContextV1;
}>;

export class ConstraintNegotiationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConstraintNegotiationValidationError";
  }
}

const TRANSITIONS: Readonly<Record<NegotiationStatusV1, readonly NegotiationStatusV1[]>> = {
  DRAFT: ["GROUNDING_REQUIRED", "FEASIBILITY_CHECK", "BLOCKED"],
  GROUNDING_REQUIRED: ["FEASIBILITY_CHECK", "DRAFT", "BLOCKED"],
  FEASIBILITY_CHECK: ["NEEDS_USER_DECISION", "READY_TO_PLAN", "BLOCKED"],
  NEEDS_USER_DECISION: ["RESOLVED", "DRAFT", "BLOCKED"],
  RESOLVED: ["FEASIBILITY_CHECK", "GROUNDING_REQUIRED", "DRAFT", "BLOCKED"],
  READY_TO_PLAN: ["DRAFT", "GROUNDING_REQUIRED", "FEASIBILITY_CHECK", "BLOCKED"],
  BLOCKED: ["DRAFT", "GROUNDING_REQUIRED", "FEASIBILITY_CHECK"],
};

function fail(message: string): never {
  throw new ConstraintNegotiationValidationError(message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], label: string): void {
  const allowed = new Set(required);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))) fail(`${label} contains missing or unknown fields.`);
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

function freeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value as Record<string, unknown>).forEach(freeze);
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) fail("createdAt must be a canonical ISO timestamp.");
  return value;
}

function domainId(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${label} is invalid.`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a non-negative integer.`);
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed === 0) fail(`${label} must be positive.`);
  return parsed;
}

function parsePolicy(value: unknown, selected: ConstraintResolutionChoice): ConstraintResolutionPolicyV1 {
  if (!plainRecord(value)) fail("structuredPolicy must be an object.");
  if (selected === "RELAX_TARGET_DURATION") {
    exactKeys(value, ["policy", "selectedDurationMs", "safeLowerBoundMs", "hardProtections"], "RELAX_TARGET_DURATION policy");
    const selectedDurationMs = positiveInteger(value.selectedDurationMs, "selectedDurationMs");
    const safeLowerBoundMs = positiveInteger(value.safeLowerBoundMs, "safeLowerBoundMs");
    if (value.policy !== selected || value.hardProtections !== "UNCHANGED" || selectedDurationMs < safeLowerBoundMs) {
      fail("RELAX_TARGET_DURATION must keep protections and select a duration at or above the safe lower bound.");
    }
    return freeze({ policy: selected, selectedDurationMs, safeLowerBoundMs, hardProtections: "UNCHANGED" });
  }
  if (selected === "OPTIMIZE_UNPROTECTED_ONLY") {
    exactKeys(value, ["policy", "requestedDurationMs", "minimumFeasibleDurationMs", "remainingGapMs", "canReachRequestedDuration", "hardProtections"], "OPTIMIZE_UNPROTECTED_ONLY policy");
    const requestedDurationMs = positiveInteger(value.requestedDurationMs, "requestedDurationMs");
    const minimumFeasibleDurationMs = positiveInteger(value.minimumFeasibleDurationMs, "minimumFeasibleDurationMs");
    const remainingGapMs = nonNegativeInteger(value.remainingGapMs, "remainingGapMs");
    const expectedGap = Math.max(0, minimumFeasibleDurationMs - requestedDurationMs);
    if (value.policy !== "CLOSEST_SAFELY_ACHIEVABLE" || value.hardProtections !== "UNCHANGED"
      || typeof value.canReachRequestedDuration !== "boolean" || remainingGapMs !== expectedGap
      || value.canReachRequestedDuration !== (expectedGap === 0)) {
      fail("OPTIMIZE_UNPROTECTED_ONLY policy must truthfully retain the requested target and feasibility gap.");
    }
    return freeze({
      policy: "CLOSEST_SAFELY_ACHIEVABLE", requestedDurationMs, minimumFeasibleDurationMs,
      remainingGapMs, canReachRequestedDuration: value.canReachRequestedDuration, hardProtections: "UNCHANGED",
    });
  }
  exactKeys(value, ["policy", "planningPaused", "generateProposal", "execute", "preserveConfirmedBindings"], "EDIT_REQUIREMENTS_MANUALLY policy");
  if (value.policy !== "MANUAL_REQUIREMENT_EDIT" || value.planningPaused !== true
    || value.generateProposal !== false || value.execute !== false || value.preserveConfirmedBindings !== true) {
    fail("EDIT_REQUIREMENTS_MANUALLY must pause planning and preserve confirmed bindings.");
  }
  return freeze({ policy: "MANUAL_REQUIREMENT_EDIT", planningPaused: true, generateProposal: false, execute: false, preserveConfirmedBindings: true });
}

function resolutionIdentityMaterial(value: Omit<ConstraintResolutionV1, "resolutionId" | "createdAt">): unknown {
  return {
    schemaVersion: value.schemaVersion,
    conflictId: value.conflictId,
    selectedResolution: value.selectedResolution,
    affectedConstraintIds: value.affectedConstraintIds,
    priorIntentVersionId: value.priorIntentVersionId,
    structuredPolicy: value.structuredPolicy,
    userConfirmed: value.userConfirmed,
  };
}

export function createConstraintResolutionId(value: Omit<ConstraintResolutionV1, "resolutionId" | "createdAt">): string {
  return `resolution-v1-${fnv1a(stable(resolutionIdentityMaterial(value)))}`;
}

export function createConstraintResolutionV1(value: unknown): ConstraintResolutionV1 {
  if (!plainRecord(value)) fail("ConstraintResolutionV1 draft must be an object.");
  exactKeys(value, ["conflictId", "selectedResolution", "affectedConstraintIds", "priorIntentVersionId", "resultingIntentVersionId", "structuredPolicy", "userConfirmed", "createdAt"], "ConstraintResolutionV1 draft");
  const conflictId = domainId(value.conflictId, "conflictId", /^conflict-v1-[0-9a-f]{8}$/);
  const choices: readonly ConstraintResolutionChoice[] = ["RELAX_TARGET_DURATION", "OPTIMIZE_UNPROTECTED_ONLY", "EDIT_REQUIREMENTS_MANUALLY"];
  if (!choices.includes(value.selectedResolution as ConstraintResolutionChoice)) fail("selectedResolution is unsupported.");
  if (value.userConfirmed !== true) fail("userConfirmed must be true.");
  if (!Array.isArray(value.affectedConstraintIds)) fail("affectedConstraintIds must be an array.");
  const affectedConstraintIds = value.affectedConstraintIds.map((id) => domainId(id, "affectedConstraintId", /^constraint-v1-[0-9a-f]{8}$/));
  if (new Set(affectedConstraintIds).size !== affectedConstraintIds.length) fail("affectedConstraintIds must be unique.");
  const selectedResolution = value.selectedResolution as ConstraintResolutionChoice;
  const priorIntentVersionId = domainId(value.priorIntentVersionId, "priorIntentVersionId", /^intent-v1-[0-9a-f]{8}$/);
  const resultingIntentVersionId = domainId(value.resultingIntentVersionId, "resultingIntentVersionId", /^intent-v1-[0-9a-f]{8}$/);
  if (selectedResolution === "EDIT_REQUIREMENTS_MANUALLY" ? resultingIntentVersionId !== priorIntentVersionId : resultingIntentVersionId === priorIntentVersionId) {
    fail("prior/resulting intent lineage does not match the selected resolution.");
  }
  const structuredPolicy = parsePolicy(value.structuredPolicy, selectedResolution);
  const withoutIdentity = {
    schemaVersion: CONSTRAINT_RESOLUTION_SCHEMA_VERSION,
    conflictId,
    selectedResolution,
    affectedConstraintIds: Object.freeze(affectedConstraintIds),
    priorIntentVersionId,
    resultingIntentVersionId,
    structuredPolicy,
    userConfirmed: true as const,
  };
  return freeze({
    ...withoutIdentity,
    resolutionId: createConstraintResolutionId(withoutIdentity),
    createdAt: canonicalTimestamp(value.createdAt),
  });
}

export function parseConstraintResolutionV1(value: unknown): ConstraintResolutionV1 {
  if (!plainRecord(value)) fail("ConstraintResolutionV1 must be an object.");
  exactKeys(value, ["schemaVersion", "resolutionId", "conflictId", "selectedResolution", "affectedConstraintIds", "priorIntentVersionId", "resultingIntentVersionId", "structuredPolicy", "userConfirmed", "createdAt"], "ConstraintResolutionV1");
  if (value.schemaVersion !== CONSTRAINT_RESOLUTION_SCHEMA_VERSION) fail("Unsupported resolution schema version.");
  const { schemaVersion: _schemaVersion, resolutionId: _resolutionId, ...draft } = value;
  const recreated = createConstraintResolutionV1(draft);
  if (value.resolutionId !== recreated.resolutionId) fail("resolutionId does not match deterministic resolution content.");
  return recreated;
}

export function transitionNegotiationStateV1(
  current: NegotiationStateV1,
  next: Omit<NegotiationStateV1, "schemaVersion">,
): NegotiationStateV1 {
  if (!TRANSITIONS[current.status].includes(next.status)) fail(`Invalid negotiation transition: ${current.status} -> ${next.status}.`);
  return freeze({ schemaVersion: NEGOTIATION_STATE_SCHEMA_VERSION, ...next });
}

export function createNegotiationStateV1(intent: CreativeIntentV1): NegotiationStateV1 {
  const parsed = parseCreativeIntent(intent);
  return freeze({
    schemaVersion: NEGOTIATION_STATE_SCHEMA_VERSION,
    status: "DRAFT",
    activeIntentVersionId: parsed.intentId,
    resolutionIds: Object.freeze([...parsed.resolutionIds]),
    unresolvedConflictIds: Object.freeze([]),
    planningPaused: false,
  });
}

export function negotiationStateFromFeasibilityV1(
  previous: NegotiationStateV1,
  intent: CreativeIntentV1,
  constraintSet: ConstraintSetV1,
  report: ConstraintFeasibilityReportV1,
): NegotiationStateV1 {
  const status: NegotiationStatusV1 = report.readiness === "READY_TO_PLAN" ? "READY_TO_PLAN"
    : report.readiness === "GROUNDING_REQUIRED" ? "GROUNDING_REQUIRED"
      : report.readiness === "NEEDS_USER_DECISION" ? "NEEDS_USER_DECISION" : "BLOCKED";
  return transitionNegotiationStateV1(previous, {
    status,
    activeIntentVersionId: intent.intentId,
    constraintSetId: constraintSet.constraintSetId,
    constraintFingerprint: constraintSet.constraintFingerprint,
    feasibilityReportId: report.reportId,
    resolutionIds: Object.freeze([...intent.resolutionIds]),
    unresolvedConflictIds: Object.freeze(report.conflicts.filter((item) => item.status !== "RESOLVED_BY_USER").map((item) => item.conflictId)),
    planningPaused: false,
  });
}

function clauseDraft(clause: CreativeIntentV1["clauses"][number], selected: ConstraintResolutionChoice, selectedDurationMs?: number): IntentClauseDraft {
  if (clause.kind === "GOAL") return {
    kind: "GOAL",
    payload: {
      ...clause.payload,
      ...(selected === "RELAX_TARGET_DURATION" ? { durationMs: selectedDurationMs! }
        : selected === "OPTIMIZE_UNPROTECTED_ONLY" ? { policy: "APPROXIMATE_TARGET" as const } : {}),
    },
    provenance: clause.provenance,
  };
  return { kind: clause.kind, payload: clause.payload, provenance: clause.provenance } as IntentClauseDraft;
}

function selectionFromBinding(binding: EnforcementReadyBindingV1): GroundingSelectionV1 {
  if (binding.bindingType === "CLIP") return { bindingType: "CLIP", clipId: binding.clipId };
  if (binding.bindingType === "CAPTION") return { bindingType: "CAPTION", captionId: binding.captionId };
  if (binding.bindingType === "TIME_RANGE") return { bindingType: "TIME_RANGE", range: binding.range };
  return { bindingType: "VIDEO_SEMANTIC_SOURCE_RANGE", assetId: binding.assetId, startMs: binding.startMs, endMs: binding.endMs, analysisVersion: binding.analysisVersion };
}

function carryBindings(
  priorIntent: CreativeIntentV1,
  resultingIntent: CreativeIntentV1,
  project: EditorProject,
  projectFingerprint: string,
  records: readonly ConfirmedBindingRecordV1[],
  videoSemanticAnalyses?: readonly VideoSemanticAnalysis[],
): readonly ConfirmedBindingRecordV1[] {
  const oldHard = priorIntent.clauses.filter((item) => item.kind === "HARD_CONSTRAINT_REQUEST");
  const newHard = resultingIntent.clauses.filter((item) => item.kind === "HARD_CONSTRAINT_REQUEST");
  const context: ConstraintGroundingContextV1 = { intent: resultingIntent, project, projectFingerprint, videoSemanticAnalyses };
  return freeze(records.map((record) => {
    const index = oldHard.findIndex((item) => item.clauseId === record.sourceClauseId);
    if (index < 0 || !newHard[index]) fail("Confirmed binding no longer maps to a hard requirement.");
    const confirmed = confirmDirectSelectionV1({ context, sourceClauseId: newHard[index].clauseId, selection: selectionFromBinding(record.binding) });
    if (confirmed.status !== "ACCEPTED") fail(`Confirmed binding carry-forward failed: ${confirmed.message}`);
    return confirmed.value;
  }));
}

type DurationConflictV1 = ConstraintConflictV1 & Readonly<{
  type: "DURATION_CONFLICT";
  evidence: Extract<ConstraintConflictV1["evidence"], { kind: "DURATION_GAP" }>;
}>;

function durationConflict(report: ConstraintFeasibilityReportV1, conflictId: string): DurationConflictV1 {
  const conflict = report.conflicts.find((item) => item.conflictId === conflictId);
  if (!conflict) fail("conflictId is not present in the supplied feasibility report.");
  if (conflict.type !== "DURATION_CONFLICT" || conflict.evidence.kind !== "DURATION_GAP") fail("MVP automatic resolutions require a duration conflict.");
  return conflict as DurationConflictV1;
}

function makeLedger(
  projectId: string,
  bindings: readonly ConfirmedBindingRecordV1[],
  resolutionIds: readonly string[],
  prior?: SessionDecisionLedgerV1,
): SessionDecisionLedgerV1 {
  if (prior && prior.projectId !== projectId) fail("Decision ledgers cannot cross project boundaries.");
  return freeze({
    schemaVersion: 1,
    projectId,
    confirmedBindingIds: Object.freeze([...new Set([...(prior?.confirmedBindingIds ?? []), ...bindings.map((item) => item.confirmationId)])]),
    selectedResolutionIds: Object.freeze([...new Set([...(prior?.selectedResolutionIds ?? []), ...resolutionIds])]),
    rejectedProposalOperationTuples: Object.freeze([...(prior?.rejectedProposalOperationTuples ?? [])]),
    humanModifiedSelections: Object.freeze([...(prior?.humanModifiedSelections ?? [])]),
  });
}

function resolvedReadiness(
  choice: ConstraintResolutionChoice,
  report: ConstraintFeasibilityReportV1,
): "READY_TO_PLAN" | "NEEDS_USER_DECISION" | "BLOCKED" | "GROUNDING_REQUIRED" {
  if (report.readiness === "GROUNDING_REQUIRED") return "GROUNDING_REQUIRED";
  if (report.status === "NOT_EVALUABLE") return "BLOCKED";
  const unresolvedNonDuration = report.conflicts.some((item) => item.type !== "DURATION_CONFLICT" && item.status !== "RESOLVED_BY_USER");
  if (unresolvedNonDuration) return "NEEDS_USER_DECISION";
  if (choice === "OPTIMIZE_UNPROTECTED_ONLY" && report.status === "FEASIBLE_WITH_TARGET_GAP") return "READY_TO_PLAN";
  return report.readiness === "READY_TO_PLAN" ? "READY_TO_PLAN" : "NEEDS_USER_DECISION";
}

export function resolveConstraintConflictV1(input: Readonly<{
  state: NegotiationStateV1;
  intent: CreativeIntentV1;
  project: EditorProject;
  projectFingerprint: string;
  confirmedBindings: readonly ConfirmedBindingRecordV1[];
  feasibilityReport: ConstraintFeasibilityReportV1;
  conflictId: string;
  selectedResolution: ConstraintResolutionChoice;
  createdAt: string;
  selectedDurationMs?: number;
  videoSemanticAnalyses?: readonly VideoSemanticAnalysis[];
  audioRhythmAnalysis?: BuildConstraintSetInputV1["audioRhythmAnalysis"];
  permissionPolicies?: BuildConstraintSetInputV1["permissionPolicies"];
  ledger?: SessionDecisionLedgerV1;
}>): NegotiationResolutionResultV1 {
  const intent = parseCreativeIntent(input.intent);
  if (input.state.status !== "NEEDS_USER_DECISION" || input.state.activeIntentVersionId !== intent.intentId) {
    fail("A resolution may only be accepted for the active NEEDS_USER_DECISION intent.");
  }
  const conflict = durationConflict(input.feasibilityReport, input.conflictId);
  const evidence = conflict.evidence;
  const choice = input.selectedResolution;
  if (!conflict.possibleResolutions.some((item) => item.type === choice)) fail("Selected resolution is not offered for this conflict.");
  let policy: ConstraintResolutionPolicyV1;
  if (choice === "RELAX_TARGET_DURATION") {
    const selectedDurationMs = input.selectedDurationMs ?? evidence.minimumFeasibleDurationMs;
    policy = parsePolicy({ policy: choice, selectedDurationMs, safeLowerBoundMs: evidence.minimumFeasibleDurationMs, hardProtections: "UNCHANGED" }, choice);
  } else if (choice === "OPTIMIZE_UNPROTECTED_ONLY") {
    policy = parsePolicy({
      policy: "CLOSEST_SAFELY_ACHIEVABLE",
      requestedDurationMs: evidence.requestedDurationMs,
      minimumFeasibleDurationMs: evidence.minimumFeasibleDurationMs,
      remainingGapMs: evidence.remainingGapMs,
      canReachRequestedDuration: evidence.remainingGapMs === 0,
      hardProtections: "UNCHANGED",
    }, choice);
  } else {
    policy = parsePolicy({ policy: "MANUAL_REQUIREMENT_EDIT", planningPaused: true, generateProposal: false, execute: false, preserveConfirmedBindings: true }, choice);
  }

  const provisional = {
    schemaVersion: CONSTRAINT_RESOLUTION_SCHEMA_VERSION,
    conflictId: conflict.conflictId,
    selectedResolution: choice,
    affectedConstraintIds: conflict.involvedConstraintIds,
    priorIntentVersionId: intent.intentId,
    resultingIntentVersionId: intent.intentId,
    structuredPolicy: policy,
    userConfirmed: true as const,
  };
  const resolutionId = createConstraintResolutionId(provisional);
  const { schemaVersion: _resolutionSchemaVersion, ...resolutionDraft } = provisional;
  if (choice === "EDIT_REQUIREMENTS_MANUALLY") {
    const resolution = createConstraintResolutionV1({ ...resolutionDraft, createdAt: input.createdAt });
    const state = transitionNegotiationStateV1(input.state, {
      status: "DRAFT", activeIntentVersionId: intent.intentId,
      resolutionIds: Object.freeze([...intent.resolutionIds, resolution.resolutionId]),
      unresolvedConflictIds: Object.freeze([conflict.conflictId]), planningPaused: true,
      reason: "Manual requirement editing requested; proposal generation and execution remain paused.",
    });
    return freeze({
      state, resolution, priorIntent: intent, resultingIntent: intent,
      confirmedBindings: Object.freeze([...input.confirmedBindings]),
      ledger: makeLedger(intent.projectId, input.confirmedBindings, [resolution.resolutionId], input.ledger),
    });
  }

  const resultingIntent = createCreativeIntent({
    version: intent.version + 1,
    projectId: intent.projectId,
    parentIntentVersionId: intent.intentId,
    sourceRequest: intent.sourceRequest,
    clauses: intent.clauses.map((item) => clauseDraft(item, choice, input.selectedDurationMs ?? evidence.minimumFeasibleDurationMs)),
    groundingState: intent.groundingState,
    resolutionIds: [...intent.resolutionIds, resolutionId],
    createdAt: input.createdAt,
  });
  const resolution = createConstraintResolutionV1({ ...resolutionDraft, resultingIntentVersionId: resultingIntent.intentId, createdAt: input.createdAt });
  if (resolution.resolutionId !== resolutionId) fail("Resolution identity changed while establishing intent lineage.");
  let confirmedBindings: readonly ConfirmedBindingRecordV1[];
  try {
    confirmedBindings = carryBindings(intent, resultingIntent, input.project, input.projectFingerprint, input.confirmedBindings, input.videoSemanticAnalyses);
  } catch (error) {
    const resolvedState = transitionNegotiationStateV1(input.state, {
      status: "RESOLVED", activeIntentVersionId: resultingIntent.intentId,
      resolutionIds: resultingIntent.resolutionIds, unresolvedConflictIds: Object.freeze([]), planningPaused: false,
    });
    const state = transitionNegotiationStateV1(resolvedState, {
      status: "GROUNDING_REQUIRED", activeIntentVersionId: resultingIntent.intentId,
      resolutionIds: resultingIntent.resolutionIds, unresolvedConflictIds: Object.freeze([]), planningPaused: false,
      reason: error instanceof Error ? error.message : "Confirmed binding carry-forward requires user confirmation.",
    });
    return freeze({
      state, resolution, priorIntent: intent, resultingIntent, confirmedBindings: Object.freeze([]),
      ledger: makeLedger(intent.projectId, input.confirmedBindings, resultingIntent.resolutionIds, input.ledger),
    });
  }
  const build = buildConstraintSetV1({
    intent: resultingIntent,
    project: input.project,
    projectFingerprint: input.projectFingerprint,
    confirmedBindings,
    videoSemanticAnalyses: input.videoSemanticAnalyses,
    audioRhythmAnalysis: input.audioRhythmAnalysis,
    permissionPolicies: input.permissionPolicies,
  });
  const resolvedState = transitionNegotiationStateV1(input.state, {
    status: "RESOLVED", activeIntentVersionId: resultingIntent.intentId,
    resolutionIds: resultingIntent.resolutionIds, unresolvedConflictIds: Object.freeze([]), planningPaused: false,
  });
  const ledger = makeLedger(intent.projectId, [...input.confirmedBindings, ...confirmedBindings], resultingIntent.resolutionIds, input.ledger);
  if (build.status !== "CONSTRAINT_SET_BUILT") {
    const status: NegotiationStatusV1 = build.code === "STALE_BINDING" ? "GROUNDING_REQUIRED" : "BLOCKED";
    const state = transitionNegotiationStateV1(resolvedState, {
      status, activeIntentVersionId: resultingIntent.intentId, resolutionIds: resultingIntent.resolutionIds,
      unresolvedConflictIds: Object.freeze([]), planningPaused: false, reason: build.message,
    });
    return freeze({ state, resolution, priorIntent: intent, resultingIntent, confirmedBindings, ledger });
  }
  const checking = transitionNegotiationStateV1(resolvedState, {
    status: "FEASIBILITY_CHECK", activeIntentVersionId: resultingIntent.intentId,
    constraintSetId: build.constraintSet.constraintSetId, constraintFingerprint: build.constraintSet.constraintFingerprint,
    resolutionIds: resultingIntent.resolutionIds, unresolvedConflictIds: Object.freeze([]), planningPaused: false,
  });
  const feasibilityReport = evaluateConstraintFeasibilityV1({
    project: input.project, intent: resultingIntent, constraintSet: build.constraintSet,
    projectFingerprint: input.projectFingerprint, videoSemanticAnalyses: input.videoSemanticAnalyses,
  });
  const status = resolvedReadiness(choice, feasibilityReport);
  const state = transitionNegotiationStateV1(checking, {
    status, activeIntentVersionId: resultingIntent.intentId,
    constraintSetId: build.constraintSet.constraintSetId, constraintFingerprint: build.constraintSet.constraintFingerprint,
    feasibilityReportId: feasibilityReport.reportId, resolutionIds: resultingIntent.resolutionIds,
    unresolvedConflictIds: Object.freeze(status === "READY_TO_PLAN" ? [] : feasibilityReport.conflicts.map((item) => item.conflictId)),
    planningPaused: false,
  });
  const proposalContext: ProposalConstraintContextV1 | undefined = status === "READY_TO_PLAN" ? freeze({
    sourceIntentVersionId: resultingIntent.intentId,
    sourceConstraintSetId: build.constraintSet.constraintSetId,
    sourceConstraintFingerprint: build.constraintSet.constraintFingerprint,
    resolutionIds: Object.freeze([...resultingIntent.resolutionIds]),
    feasibilityReportId: feasibilityReport.reportId,
    readiness: "READY_TO_PLAN",
  }) : undefined;
  return freeze({ state, resolution, priorIntent: intent, resultingIntent, confirmedBindings, constraintSet: build.constraintSet, feasibilityReport, ledger, ...(proposalContext ? { proposalContext } : {}) });
}

export function isProposalConstraintContextCurrentV1(
  proposal: ProposalConstraintContextV1 | undefined,
  current: ProposalConstraintContextV1 | undefined,
): boolean {
  if (!proposal || !current) return proposal === current;
  return proposal.sourceIntentVersionId === current.sourceIntentVersionId
    && proposal.sourceConstraintSetId === current.sourceConstraintSetId
    && proposal.sourceConstraintFingerprint === current.sourceConstraintFingerprint
    && proposal.feasibilityReportId === current.feasibilityReportId
    && stable(proposal.resolutionIds) === stable(current.resolutionIds)
    && current.readiness === "READY_TO_PLAN";
}

export function appendProposalDecisionEvidenceV1(
  ledger: SessionDecisionLedgerV1,
  input: Readonly<{ rejectedOperationTuples?: readonly string[]; humanModifiedSelections?: readonly Readonly<{ proposalEntryId: string; selectedAssetId: string }>[] }>,
): SessionDecisionLedgerV1 {
  return freeze({
    ...ledger,
    rejectedProposalOperationTuples: Object.freeze([...new Set([...ledger.rejectedProposalOperationTuples, ...(input.rejectedOperationTuples ?? [])])]),
    humanModifiedSelections: Object.freeze([...ledger.humanModifiedSelections, ...(input.humanModifiedSelections ?? [])]),
  });
}
