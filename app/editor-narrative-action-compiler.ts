import {
  candidateClearsMatchingThresholds,
  SOURCE_START_PLACEMENT_TOLERANCE_MS,
  type CandidateMatchScore,
  type SupportingSourceRange,
} from "./editor-multimodal-matching.ts";
import {
  NARRATIVE_PLANNER_LIMITS,
  type NarrativeIntervalPlan,
  type NarrativeResolvedIntervalPlan,
  type NarrativeSequencePlan,
  type NarrativeTransitionEvidence,
} from "./editor-narrative-planner.ts";
import {
  parseAIEditingPlan,
  type EditorAIEditingPlan,
  type EditorAIPlanAction,
} from "./editor-ai-requirements.ts";
import type { EditorProject, TimelineClip } from "./editor-core.ts";
import { parseConstraintSet, type ConstraintSetV1 } from "./editor-constraints.ts";
import {
  enforceEditorActionConstraintsV1,
  isRejectedSemanticActionV1,
} from "./editor-constraint-enforcement.ts";

/**
 * V2.0C compiles only INITIAL_PLAN asset assignments. It deliberately does
 * not call applyAIEditingPlan: compilation validates and returns a canonical
 * plan but never mutates EditorProject.
 */

export const NARRATIVE_ACTION_COMPILER_SCHEMA_VERSION = 1 as const;
export const NARRATIVE_ACTION_COMPILER_LIMITS = Object.freeze({
  maxIntervals: NARRATIVE_PLANNER_LIMITS.maxIntervals,
  maxCanonicalActions: 24,
  maxIdLength: 512,
});

export type NarrativeCompileMode = "INITIAL_PLAN";

export type SeedTimelineSlot = Readonly<{
  order: number;
  intervalId: string;
  clipId: string;
  timelineStartMs: number;
  timelineEndMs: number;
  currentAssetId: string;
}>;

export type NarrativeActionCompilerContext = Readonly<{
  mode: NarrativeCompileMode;
  narrativePlan: NarrativeSequencePlan;
  seedSlots: readonly SeedTimelineSlot[];
  project: EditorProject;
  ownedAssetIds: readonly string[];
  constraintContext?: Readonly<{
    intentVersionId: string;
    constraintSetId: string;
    constraintFingerprint: string;
    constraintSet: ConstraintSetV1;
  }>;
  rejectedOperationTuples?: readonly string[];
}>;

export type CompilerIssueCode =
  | "UNRESOLVED_INTERVAL"
  | "SOURCE_RANGE_PLACEMENT_LIMITATION"
  | "ACTION_BATCH_LIMIT"
  | "HARD_CONSTRAINT_BLOCKED"
  | "STALE_CONSTRAINT_CONTEXT"
  | "SESSION_REJECTION_REINTRODUCED";

export type CompilerIssue = Readonly<{
  code: CompilerIssueCode;
  message: string;
  intervalId?: string;
}>;

export type IntervalActionStatus =
  | "COMPILED"
  | "NO_ACTION_REQUIRED"
  | "UNRESOLVED"
  | "UNSUPPORTED"
  | "BLOCKED_BY_ATOMIC_POLICY";

export type IntervalActionLink = Readonly<{
  intervalId: string;
  narrativePlanIndex: number;
  status: IntervalActionStatus;
  selectedAssetId?: string;
  targetClipId?: string;
  actionIndex?: number;
  actionType?: "MATCH_ASSET_TO_SEGMENT";
  supportingSegmentIds: readonly string[];
  matchingEvidenceReference?: string;
  narrativeReasonCodes: readonly string[];
}>;

export type CompiledNarrativeActionPlan = Readonly<{
  schemaVersion: typeof NARRATIVE_ACTION_COMPILER_SCHEMA_VERSION;
  mode: "INITIAL_PLAN";
  status: "VALIDATED" | "NOT_COMPILABLE";
  sourceNarrativeReference: string;
  canonicalPlan: EditorAIEditingPlan;
  intervalActionMap: readonly IntervalActionLink[];
  unresolvedIntervalIds: readonly string[];
  unsupportedIntervalIds: readonly string[];
  warnings: readonly CompilerIssue[];
  errors: readonly CompilerIssue[];
  canonicalValidation: Readonly<{
    parser: "parseAIEditingPlan";
    valid: boolean;
  }>;
}>;

export class NarrativeActionCompilerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarrativeActionCompilerValidationError";
  }
}

type ParsedContext = Readonly<{
  mode: "INITIAL_PLAN";
  narrativePlan: NarrativeSequencePlan;
  seedSlots: readonly SeedTimelineSlot[];
  project: EditorProject;
  ownedAssetIds: ReadonlySet<string>;
  constraintContext?: NonNullable<NarrativeActionCompilerContext["constraintContext"]>;
  rejectedOperationTuples?: readonly string[];
}>;

const RESOLVED_PLAN_KEYS = [
  "status",
  "intervalId",
  "assetId",
  "localScore",
  "semanticScore",
  "narrativeScore",
  "supportingSegmentIds",
  "supportingSourceRanges",
  "evidenceFrameMs",
  "matchEvidence",
  "transitionEvidence",
] as const;

const UNRESOLVED_PLAN_KEYS = ["status", "intervalId", "narrativeScore", "reason"] as const;
const NARRATIVE_PLAN_KEYS = [
  "intervalPlans",
  "totalLocalScore",
  "totalNarrativeScore",
  "totalSequenceScore",
  "totalSemanticScore",
  "totalSequenceRepetitionPenalty",
  "unresolvedIntervalIds",
] as const;

function fail(message: string): never {
  throw new NarrativeActionCompilerValidationError(message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail(`${label} contains missing or unknown fields.`);
  }
}

function safeIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !value
    || value.length > NARRATIVE_ACTION_COMPILER_LIMITS.maxIdLength
    || value !== value.trim()
    || /\u0000/.test(value)
    || /^(?:blob:|file:|https?:)/i.test(value)
    || /[\\/]/.test(value)
  ) {
    fail(`${label} must be a bounded trusted identity, not a URL or path.`);
  }
  return value;
}

function safeText(value: unknown, label: string, maximum = 512): string {
  if (
    typeof value !== "string"
    || !value.trim()
    || value !== value.trim()
    || value.length > maximum
    || /\u0000/.test(value)
  ) {
    fail(`${label} must be a bounded normalized string.`);
  }
  return value;
}

function safeTime(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail(`${label} must be a safe integer millisecond value.`);
  }
  return Number(value);
}

function safeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be finite.`);
  return value;
}

function safeScore(value: unknown, label: string): number {
  const score = safeFinite(value, label);
  if (score < 0 || score > 1) fail(`${label} must be normalized.`);
  return score;
}

function safeIdentityArray(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must be a bounded array.`);
  const values = value.map((item, index) => safeIdentity(item, `${label}[${index}]`));
  if (new Set(values).size !== values.length) fail(`${label} contains duplicate identities.`);
  return Object.freeze(values);
}

function safeTextArray(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} must be a bounded array.`);
  const values = value.map((item, index) => safeText(item, `${label}[${index}]`, 120));
  if (new Set(values).size !== values.length) fail(`${label} contains duplicate values.`);
  return Object.freeze(values);
}

function sameArray(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseSupportingRange(value: unknown, assetId: string): SupportingSourceRange {
  if (!plainRecord(value)) fail("Narrative supporting source range must be an object.");
  exactKeys(
    value,
    ["segmentId", "sourceStartMs", "sourceEndMs", "confidence", "usability", "matchedConcepts"],
    "Narrative supporting source range",
  );
  const sourceStartMs = safeTime(value.sourceStartMs, "sourceRange.sourceStartMs");
  const sourceEndMs = safeTime(value.sourceEndMs, "sourceRange.sourceEndMs");
  if (sourceEndMs <= sourceStartMs) fail("Narrative supporting source range must have positive duration.");
  const matchedConcepts = safeTextArray(value.matchedConcepts, "sourceRange.matchedConcepts", 16);
  if (matchedConcepts.length === 0) fail("Narrative supporting range requires matched concepts.");
  return Object.freeze({
    segmentId: safeIdentity(value.segmentId, "sourceRange.segmentId"),
    sourceStartMs,
    sourceEndMs,
    confidence: safeScore(value.confidence, "sourceRange.confidence"),
    usability: safeScore(value.usability, "sourceRange.usability"),
    matchedConcepts,
  });
}

function parseTransitionEvidence(value: unknown, selectedAssetId: string): NarrativeTransitionEvidence {
  if (!plainRecord(value)) fail("Narrative transition evidence must be an object.");
  const required = ["code", "scoreDelta", "summary", "toAssetId"];
  const optional = ["fromAssetId", "fromAction", "toAction", "sharedConcepts", "priorIntervalDistance"];
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    fail("Narrative transition evidence contains missing or unknown fields.");
  }
  const codes = new Set([
    "ACTION_PROGRESSION_SUPPORTED",
    "ACTION_REGRESSION",
    "SUBJECT_CONTINUITY_PRESERVED",
    "IMMEDIATE_ASSET_REPEAT",
    "ABA_ASSET_OSCILLATION",
    "RECENT_ASSET_REUSE",
  ]);
  if (typeof value.code !== "string" || !codes.has(value.code)) fail("Narrative transition reason code is unsupported.");
  if (value.toAssetId !== selectedAssetId) fail("Narrative transition evidence targets a different asset.");
  const summary = safeText(value.summary, "transition.summary", 2_000);
  const scoreDelta = safeFinite(value.scoreDelta, "transition.scoreDelta");
  if (scoreDelta < -1 || scoreDelta > 1) fail("Narrative transition score delta is outside its bound.");
  const fromAssetId = value.fromAssetId === undefined
    ? undefined
    : safeIdentity(value.fromAssetId, "transition.fromAssetId");
  const fromAction = value.fromAction === undefined
    ? undefined
    : safeText(value.fromAction, "transition.fromAction", 240);
  const toAction = value.toAction === undefined
    ? undefined
    : safeText(value.toAction, "transition.toAction", 240);
  const sharedConcepts = value.sharedConcepts === undefined
    ? undefined
    : safeTextArray(value.sharedConcepts, "transition.sharedConcepts", 16);
  const priorIntervalDistance = value.priorIntervalDistance === undefined
    ? undefined
    : safeTime(value.priorIntervalDistance, "transition.priorIntervalDistance", 1);
  return Object.freeze({
    code: value.code as NarrativeTransitionEvidence["code"],
    scoreDelta,
    summary,
    toAssetId: selectedAssetId,
    ...(fromAssetId === undefined ? {} : { fromAssetId }),
    ...(fromAction === undefined ? {} : { fromAction }),
    ...(toAction === undefined ? {} : { toAction }),
    ...(sharedConcepts === undefined ? {} : { sharedConcepts }),
    ...(priorIntervalDistance === undefined ? {} : { priorIntervalDistance }),
  });
}

function parseMatchEvidence(
  value: unknown,
  assetId: string,
  localScore: number,
  semanticScore: number,
  supportingSegmentIds: readonly string[],
): CandidateMatchScore {
  if (!plainRecord(value)) fail("Narrative matchEvidence must be an object.");
  const required = [
    "assetId", "semanticScore", "usabilityScore", "timingScore", "repetitionPenalty", "totalScore",
    "matchedConcepts", "supportingSegmentIds", "supportingSourceRanges", "evidenceFrameMs",
    "sourceRangePlacementLimitation", "semanticEvidence", "timingEvidence", "repetitionEvidence",
  ];
  exactKeys(value, required, "Narrative matchEvidence");
  if (safeIdentity(value.assetId, "matchEvidence.assetId") !== assetId) fail("Narrative asset identity does not match matchEvidence.");
  if (safeScore(value.totalScore, "matchEvidence.totalScore") !== localScore) fail("Narrative local score does not match matchEvidence.");
  if (safeScore(value.semanticScore, "matchEvidence.semanticScore") !== semanticScore) fail("Narrative semantic score does not match matchEvidence.");
  const evidenceSegmentIds = safeIdentityArray(value.supportingSegmentIds, "matchEvidence.supportingSegmentIds", 128);
  if (!sameArray(evidenceSegmentIds, supportingSegmentIds)) fail("Narrative supporting segment references do not match matchEvidence.");
  if (!Array.isArray(value.supportingSourceRanges) || value.supportingSourceRanges.length !== supportingSegmentIds.length) {
    fail("Narrative source ranges must align with supporting segment references.");
  }
  const supportingSourceRanges = value.supportingSourceRanges.map((range) => parseSupportingRange(range, assetId));
  if (supportingSourceRanges.some((range, index) => range.segmentId !== supportingSegmentIds[index])) {
    fail("Narrative source ranges do not preserve segment order.");
  }
  if (!Array.isArray(value.evidenceFrameMs) || value.evidenceFrameMs.length === 0 || value.evidenceFrameMs.length > 128) {
    fail("Narrative match evidence requires bounded source frame timestamps.");
  }
  const evidenceFrameMs = value.evidenceFrameMs.map((time, index) => safeTime(time, `matchEvidence.evidenceFrameMs[${index}]`));
  if (new Set(evidenceFrameMs).size !== evidenceFrameMs.length) fail("Narrative frame evidence contains duplicate timestamps.");
  const matchedConcepts = safeTextArray(value.matchedConcepts, "matchEvidence.matchedConcepts", 16);
  if (matchedConcepts.length === 0) fail("Narrative match evidence requires matched concepts.");
  if (typeof value.sourceRangePlacementLimitation !== "boolean") fail("Narrative source-range limitation flag must be boolean.");
  const computedLimitation = supportingSourceRanges.length > 0
    && supportingSourceRanges.every((range) => range.sourceStartMs > SOURCE_START_PLACEMENT_TOLERANCE_MS);
  if (computedLimitation !== value.sourceRangePlacementLimitation) {
    fail("Narrative source-range limitation flag is inconsistent with trusted source evidence.");
  }
  if (!plainRecord(value.semanticEvidence) || !plainRecord(value.timingEvidence) || !plainRecord(value.repetitionEvidence)) {
    fail("Narrative match evidence components must remain structured.");
  }
  const match = Object.freeze({
    assetId,
    semanticScore,
    usabilityScore: safeScore(value.usabilityScore, "matchEvidence.usabilityScore"),
    timingScore: safeScore(value.timingScore, "matchEvidence.timingScore"),
    repetitionPenalty: safeScore(value.repetitionPenalty, "matchEvidence.repetitionPenalty"),
    totalScore: localScore,
    matchedConcepts,
    supportingSegmentIds,
    supportingSourceRanges: Object.freeze(supportingSourceRanges),
    evidenceFrameMs: Object.freeze(evidenceFrameMs),
    sourceRangePlacementLimitation: value.sourceRangePlacementLimitation,
    semanticEvidence: value.semanticEvidence as CandidateMatchScore["semanticEvidence"],
    timingEvidence: value.timingEvidence as CandidateMatchScore["timingEvidence"],
    repetitionEvidence: value.repetitionEvidence as CandidateMatchScore["repetitionEvidence"],
  }) satisfies CandidateMatchScore;
  if (!candidateClearsMatchingThresholds(match)) {
    fail("A V2.0A-rejected candidate cannot enter narrative action compilation.");
  }
  return match;
}

function parseResolvedIntervalPlan(value: Record<string, unknown>): NarrativeResolvedIntervalPlan {
  exactKeys(value, RESOLVED_PLAN_KEYS, "Resolved narrative interval plan");
  const intervalId = safeIdentity(value.intervalId, "narrative.intervalId");
  const assetId = safeIdentity(value.assetId, "narrative.assetId");
  const localScore = safeScore(value.localScore, "narrative.localScore");
  const semanticScore = safeScore(value.semanticScore, "narrative.semanticScore");
  const narrativeScore = safeFinite(value.narrativeScore, "narrative.narrativeScore");
  if (narrativeScore < -1 || narrativeScore > 1) fail("Narrative transition score is outside its bound.");
  const supportingSegmentIds = safeIdentityArray(value.supportingSegmentIds, "narrative.supportingSegmentIds", 128);
  if (supportingSegmentIds.length === 0) fail("Resolved narrative interval requires supporting segment IDs.");
  const matchEvidence = parseMatchEvidence(
    value.matchEvidence,
    assetId,
    localScore,
    semanticScore,
    supportingSegmentIds,
  );
  if (!Array.isArray(value.supportingSourceRanges) || value.supportingSourceRanges.length !== matchEvidence.supportingSourceRanges.length) {
    fail("Narrative interval source ranges do not match its evidence.");
  }
  const supportingSourceRanges = value.supportingSourceRanges.map((range) => parseSupportingRange(range, assetId));
  if (JSON.stringify(supportingSourceRanges) !== JSON.stringify(matchEvidence.supportingSourceRanges)) {
    fail("Narrative interval source ranges differ from matchEvidence.");
  }
  if (!Array.isArray(value.evidenceFrameMs)) fail("Narrative interval frame evidence must be an array.");
  const evidenceFrameMs = value.evidenceFrameMs.map((time, index) => safeTime(time, `narrative.evidenceFrameMs[${index}]`));
  if (!sameArray(evidenceFrameMs, matchEvidence.evidenceFrameMs)) fail("Narrative frame evidence differs from matchEvidence.");
  if (!Array.isArray(value.transitionEvidence) || value.transitionEvidence.length > 16) {
    fail("Narrative transition evidence must be bounded.");
  }
  const transitionEvidence = value.transitionEvidence.map((entry) => parseTransitionEvidence(entry, assetId));
  const summedNarrative = Math.round(transitionEvidence.reduce((sum, item) => sum + item.scoreDelta, 0) * 1_000_000) / 1_000_000;
  if (summedNarrative !== narrativeScore) fail("Narrative transition evidence does not reproduce its score.");
  return Object.freeze({
    status: "resolved",
    intervalId,
    assetId,
    localScore,
    semanticScore,
    narrativeScore,
    supportingSegmentIds,
    supportingSourceRanges: Object.freeze(supportingSourceRanges),
    evidenceFrameMs: Object.freeze(evidenceFrameMs),
    matchEvidence,
    transitionEvidence: Object.freeze(transitionEvidence),
  });
}

function parseIntervalPlan(value: unknown): NarrativeIntervalPlan {
  if (!plainRecord(value)) fail("Narrative interval plan must be an object.");
  if (value.status === "resolved") return parseResolvedIntervalPlan(value);
  if (value.status !== "unresolved") fail("Narrative interval status is unsupported.");
  exactKeys(value, UNRESOLVED_PLAN_KEYS, "Unresolved narrative interval plan");
  if (value.narrativeScore !== 0 || value.reason !== "NO_ACCEPTED_V2_0A_CANDIDATE") {
    fail("Unresolved narrative interval must preserve the V2.0B rejection state.");
  }
  return Object.freeze({
    status: "unresolved",
    intervalId: safeIdentity(value.intervalId, "narrative.intervalId"),
    narrativeScore: 0,
    reason: "NO_ACCEPTED_V2_0A_CANDIDATE",
  });
}

function parseNarrativePlan(value: unknown): NarrativeSequencePlan {
  if (!plainRecord(value)) fail("NarrativeSequencePlan must be an object.");
  exactKeys(value, NARRATIVE_PLAN_KEYS, "NarrativeSequencePlan");
  if (!Array.isArray(value.intervalPlans) || value.intervalPlans.length > NARRATIVE_ACTION_COMPILER_LIMITS.maxIntervals) {
    fail("Narrative interval plans must be bounded.");
  }
  const intervalPlans = value.intervalPlans.map(parseIntervalPlan);
  if (new Set(intervalPlans.map((plan) => plan.intervalId)).size !== intervalPlans.length) {
    fail("NarrativeSequencePlan contains duplicate interval IDs.");
  }
  const unresolvedIntervalIds = safeIdentityArray(
    value.unresolvedIntervalIds,
    "narrative.unresolvedIntervalIds",
    NARRATIVE_ACTION_COMPILER_LIMITS.maxIntervals,
  );
  const actualUnresolved = intervalPlans
    .filter((plan) => plan.status === "unresolved")
    .map((plan) => plan.intervalId);
  if (!sameArray(unresolvedIntervalIds, actualUnresolved)) {
    fail("Narrative unresolved interval IDs do not match interval plans.");
  }
  const totalLocalScore = safeFinite(value.totalLocalScore, "narrative.totalLocalScore");
  const totalNarrativeScore = safeFinite(value.totalNarrativeScore, "narrative.totalNarrativeScore");
  const totalSequenceScore = safeFinite(value.totalSequenceScore, "narrative.totalSequenceScore");
  const totalSemanticScore = safeFinite(value.totalSemanticScore, "narrative.totalSemanticScore");
  const totalSequenceRepetitionPenalty = safeFinite(
    value.totalSequenceRepetitionPenalty,
    "narrative.totalSequenceRepetitionPenalty",
  );
  const resolved = intervalPlans.filter((plan): plan is NarrativeResolvedIntervalPlan => plan.status === "resolved");
  const expectedLocal = Math.round(resolved.reduce((sum, plan) => sum + plan.localScore, 0) * 1_000_000) / 1_000_000;
  const expectedNarrative = Math.round(resolved.reduce((sum, plan) => sum + plan.narrativeScore, 0) * 1_000_000) / 1_000_000;
  const expectedSemantic = Math.round(resolved.reduce((sum, plan) => sum + plan.semanticScore, 0) * 1_000_000) / 1_000_000;
  const repetitionCodes = new Set(["IMMEDIATE_ASSET_REPEAT", "ABA_ASSET_OSCILLATION", "RECENT_ASSET_REUSE"]);
  const expectedRepetition = Math.round(resolved.reduce((sum, plan) => sum + plan.transitionEvidence
    .filter((evidence) => repetitionCodes.has(evidence.code))
    .reduce((transitionSum, evidence) => transitionSum - evidence.scoreDelta, 0), 0) * 1_000_000) / 1_000_000;
  if (
    totalLocalScore !== expectedLocal
    || totalNarrativeScore !== expectedNarrative
    || totalSequenceScore !== Math.round((expectedLocal + expectedNarrative) * 1_000_000) / 1_000_000
    || totalSemanticScore !== expectedSemantic
    || totalSequenceRepetitionPenalty !== expectedRepetition
  ) {
    fail("NarrativeSequencePlan aggregate scores are inconsistent.");
  }
  return Object.freeze({
    intervalPlans: Object.freeze(intervalPlans),
    totalLocalScore,
    totalNarrativeScore,
    totalSequenceScore,
    totalSemanticScore,
    totalSequenceRepetitionPenalty,
    unresolvedIntervalIds,
  });
}

function parseProject(value: unknown): EditorProject {
  if (!plainRecord(value) || value.schemaVersion !== 2) fail("Compiler project must be an EditorProject schema v2 object.");
  const durationMs = safeTime(value.durationMs, "project.durationMs", 1);
  if (!Array.isArray(value.assets) || !Array.isArray(value.tracks) || !Array.isArray(value.captions)) {
    fail("Compiler project is missing structured assets, tracks, or captions.");
  }
  const project = structuredClone(value) as EditorProject;
  if (project.durationMs !== durationMs) fail("Compiler project duration is invalid.");
  const assetIds = project.assets.map((asset, index) => safeIdentity(asset?.id, `project.assets[${index}].id`));
  if (new Set(assetIds).size !== assetIds.length) fail("Compiler project contains duplicate asset IDs.");
  const clips = project.tracks.flatMap((track) => track.clips ?? []);
  const clipIds = clips.map((clip, index) => safeIdentity(clip?.id, `project.clips[${index}].id`));
  if (new Set(clipIds).size !== clipIds.length) fail("Compiler project contains duplicate clip IDs.");
  return project;
}

function allClips(project: EditorProject): readonly TimelineClip[] {
  return project.tracks.flatMap((track) => track.clips);
}

function parseSeedSlots(value: unknown, project: EditorProject, narrativePlan: NarrativeSequencePlan): readonly SeedTimelineSlot[] {
  if (!Array.isArray(value) || value.length > NARRATIVE_ACTION_COMPILER_LIMITS.maxIntervals) {
    fail("seedSlots must be a bounded array.");
  }
  if (value.length !== narrativePlan.intervalPlans.length) {
    fail("The deterministic seed timeline must contain exactly one explicit slot per narrative interval.");
  }
  const narrativeIds = new Set(narrativePlan.intervalPlans.map((plan) => plan.intervalId));
  const clipById = new Map(allClips(project).map((clip) => [clip.id, clip]));
  const slots = value.map((item, index) => {
    if (!plainRecord(item)) fail(`seedSlots[${index}] must be an object.`);
    exactKeys(
      item,
      ["order", "intervalId", "clipId", "timelineStartMs", "timelineEndMs", "currentAssetId"],
      `seedSlots[${index}]`,
    );
    const order = safeTime(item.order, `seedSlots[${index}].order`);
    if (order !== index) fail("Seed slot order must be explicit, contiguous, and match array order.");
    const intervalId = safeIdentity(item.intervalId, `seedSlots[${index}].intervalId`);
    if (!narrativeIds.has(intervalId)) fail("Seed slot references an unknown narrative interval.");
    if (intervalId !== narrativePlan.intervalPlans[index].intervalId) {
      fail("Seed slot order must exactly preserve narrative interval order.");
    }
    const clipId = safeIdentity(item.clipId, `seedSlots[${index}].clipId`);
    const currentAssetId = safeIdentity(item.currentAssetId, `seedSlots[${index}].currentAssetId`);
    const timelineStartMs = safeTime(item.timelineStartMs, `seedSlots[${index}].timelineStartMs`);
    const timelineEndMs = safeTime(item.timelineEndMs, `seedSlots[${index}].timelineEndMs`, 1);
    if (timelineEndMs <= timelineStartMs || timelineEndMs > project.durationMs) {
      fail("Seed slot timeline range is outside the trusted project duration.");
    }
    const clip = clipById.get(clipId);
    if (
      !clip
      || clip.assetId !== currentAssetId
      || clip.timelineStartMs !== timelineStartMs
      || clip.timelineEndMs !== timelineEndMs
    ) {
      fail("Seed slot does not exactly match one trusted project clip.");
    }
    return Object.freeze({ order, intervalId, clipId, timelineStartMs, timelineEndMs, currentAssetId });
  });
  if (new Set(slots.map((slot) => slot.intervalId)).size !== slots.length) {
    fail("Ambiguous interval-to-slot mapping is not allowed.");
  }
  if (new Set(slots.map((slot) => slot.clipId)).size !== slots.length) {
    fail("One seed clip cannot receive multiple interval mutations.");
  }
  if (slots.some((slot, index) => index > 0 && slot.timelineStartMs < slots[index - 1].timelineEndMs)) {
    fail("Seed slots must preserve explicit non-overlapping timeline order.");
  }
  return Object.freeze(slots);
}

export function parseNarrativeActionCompilerContext(value: unknown): ParsedContext {
  if (!plainRecord(value)) fail("NarrativeActionCompilerContext must be an object.");
  const requiredKeys = ["mode", "narrativePlan", "seedSlots", "project", "ownedAssetIds"];
  const allowedKeys = new Set([...requiredKeys, "constraintContext", "rejectedOperationTuples"]);
  if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some((key) => !allowedKeys.has(key))) {
    fail("NarrativeActionCompilerContext contains missing or unknown fields.");
  }
  if (value.mode !== "INITIAL_PLAN") fail("V2.0C supports INITIAL_PLAN only.");
  const narrativePlan = parseNarrativePlan(value.narrativePlan);
  const project = parseProject(value.project);
  const ownedAssetIds = safeIdentityArray(value.ownedAssetIds, "ownedAssetIds", 64);
  const projectAssetIds = new Set(project.assets.map((asset) => asset.id));
  if (ownedAssetIds.some((assetId) => !projectAssetIds.has(assetId))) {
    fail("ownedAssetIds contains an asset absent from the trusted project.");
  }
  const seedSlots = parseSeedSlots(value.seedSlots, project, narrativePlan);
  let constraintContext: ParsedContext["constraintContext"];
  if (value.constraintContext !== undefined) {
    if (!plainRecord(value.constraintContext)) fail("constraintContext must be an object.");
    exactKeys(value.constraintContext, ["intentVersionId", "constraintSetId", "constraintFingerprint", "constraintSet"], "constraintContext");
    const constraintSet = parseConstraintSet(value.constraintContext.constraintSet);
    const intentVersionId = safeIdentity(value.constraintContext.intentVersionId, "constraintContext.intentVersionId");
    const constraintSetId = safeIdentity(value.constraintContext.constraintSetId, "constraintContext.constraintSetId");
    const constraintFingerprint = safeIdentity(value.constraintContext.constraintFingerprint, "constraintContext.constraintFingerprint");
    if (intentVersionId !== constraintSet.intentVersionId
      || constraintSetId !== constraintSet.constraintSetId
      || constraintFingerprint !== constraintSet.constraintFingerprint) {
      fail("constraintContext identities do not match ConstraintSetV1.");
    }
    constraintContext = Object.freeze({ intentVersionId, constraintSetId, constraintFingerprint, constraintSet });
  }
  let rejectedOperationTuples: readonly string[] | undefined;
  if (value.rejectedOperationTuples !== undefined) {
    if (!Array.isArray(value.rejectedOperationTuples)) fail("rejectedOperationTuples must be an array.");
    rejectedOperationTuples = Object.freeze(value.rejectedOperationTuples.map((item, index) => safeIdentity(item, `rejectedOperationTuples[${index}]`)));
  }
  return Object.freeze({
    mode: "INITIAL_PLAN",
    narrativePlan,
    seedSlots,
    project,
    ownedAssetIds: new Set(ownedAssetIds),
    ...(constraintContext ? { constraintContext } : {}),
    ...(rejectedOperationTuples ? { rejectedOperationTuples } : {}),
  });
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function narrativeReference(plan: NarrativeSequencePlan): string {
  const identity = plan.intervalPlans.map((item) => item.status === "resolved"
    ? [item.intervalId, item.assetId, item.supportingSegmentIds]
    : [item.intervalId, null]);
  return `narrative-plan-v1-${fnv1a(JSON.stringify(identity))}-${plan.intervalPlans.length}`;
}

function matchingEvidenceReference(plan: NarrativeResolvedIntervalPlan): string {
  return `match-evidence-v1-${fnv1a(JSON.stringify([
    plan.intervalId,
    plan.assetId,
    plan.supportingSegmentIds,
    plan.evidenceFrameMs,
  ]))}`;
}

function reasonForInterval(intervalId: string): string {
  return `Matches trusted narrative interval ${intervalId}; semantic and narrative selection.`;
}

function emptyCanonicalPlan(errorCount: number): EditorAIEditingPlan {
  return freezeCanonicalPlan(parseAIEditingPlan({
    summary: "Narrative initial plan is not compilable.",
    actions: [],
    unsupported: [{
      request: "Compile narrative initial plan",
      reason: `${errorCount} compiler issue(s) require resolution before execution.`,
    }],
    warnings: [],
  }));
}

function freezeCanonicalPlan(plan: EditorAIEditingPlan): EditorAIEditingPlan {
  plan.actions.forEach(Object.freeze);
  plan.unsupported.forEach(Object.freeze);
  Object.freeze(plan.actions);
  Object.freeze(plan.unsupported);
  Object.freeze(plan.warnings);
  return Object.freeze(plan);
}

function validateMatchPreconditions(
  action: EditorAIPlanAction,
  slot: SeedTimelineSlot,
  clipById: ReadonlyMap<string, TimelineClip>,
  projectAssetIds: ReadonlySet<string>,
  projectDurationMs: number,
  ownedAssetIds: ReadonlySet<string>,
): void {
  const clip = clipById.get(action.targetId);
  if (
    action.type !== "MATCH_ASSET_TO_SEGMENT"
    || !clip
    || !projectAssetIds.has(action.assetId ?? "")
    || !ownedAssetIds.has(clip.assetId)
    || !ownedAssetIds.has(action.assetId ?? "")
    || Math.round((action.startSeconds ?? Number.NaN) * 1_000) !== slot.timelineStartMs
    || Math.round((action.endSeconds ?? Number.NaN) * 1_000) !== slot.timelineEndMs
    || slot.timelineEndMs > projectDurationMs
  ) {
    fail("Compiled MATCH_ASSET_TO_SEGMENT does not satisfy trusted canonical preconditions.");
  }
}

export function compileNarrativeActionPlan(value: unknown): CompiledNarrativeActionPlan {
  const context = parseNarrativeActionCompilerContext(value);
  const slotByInterval = new Map(context.seedSlots.map((slot) => [slot.intervalId, slot]));
  const clipById = new Map(allClips(context.project).map((clip) => [clip.id, clip]));
  const projectAssetIds = new Set(context.project.assets.map((asset) => asset.id));
  const unresolvedIntervalIds = [...context.narrativePlan.unresolvedIntervalIds];
  const unsupportedIntervalIds: string[] = [];
  const errors: CompilerIssue[] = unresolvedIntervalIds.map((intervalId) => Object.freeze({
    code: "UNRESOLVED_INTERVAL" as const,
    intervalId,
    message: `Interval ${intervalId} has no accepted V2.0A candidate.`,
  }));

  for (const plan of context.narrativePlan.intervalPlans) {
    if (plan.status !== "resolved") continue;
    if (!slotByInterval.has(plan.intervalId)) fail("A resolved narrative interval has no explicit seed-slot mapping.");
    if (plan.matchEvidence.sourceRangePlacementLimitation) {
      unsupportedIntervalIds.push(plan.intervalId);
      errors.push(Object.freeze({
        code: "SOURCE_RANGE_PLACEMENT_LIMITATION",
        intervalId: plan.intervalId,
        message: `Interval ${plan.intervalId} requires unsupported non-zero source-range placement.`,
      }));
    }
  }

  const assignable = context.narrativePlan.intervalPlans.filter((plan): plan is NarrativeResolvedIntervalPlan => (
    plan.status === "resolved"
    && !plan.matchEvidence.sourceRangePlacementLimitation
    && (
      slotByInterval.get(plan.intervalId)?.currentAssetId !== plan.assetId
      || clipById.get(slotByInterval.get(plan.intervalId)!.clipId)?.sourceInMs !== 0
    )
  ));
  if (assignable.length > NARRATIVE_ACTION_COMPILER_LIMITS.maxCanonicalActions) {
    const overflowIds = assignable.map((plan) => plan.intervalId);
    unsupportedIntervalIds.push(...overflowIds.filter((id) => !unsupportedIntervalIds.includes(id)));
    errors.push(Object.freeze({
      code: "ACTION_BATCH_LIMIT",
      message: `Initial plan requires ${assignable.length} actions; canonical batches support at most ${NARRATIVE_ACTION_COMPILER_LIMITS.maxCanonicalActions}.`,
    }));
  }

  const nonCompilable = errors.length > 0;
  const actions: EditorAIPlanAction[] = [];
  const intervalActionMap: IntervalActionLink[] = [];
  context.narrativePlan.intervalPlans.forEach((plan, narrativePlanIndex) => {
    if (plan.status === "unresolved") {
      intervalActionMap.push(Object.freeze({
        intervalId: plan.intervalId,
        narrativePlanIndex,
        status: "UNRESOLVED",
        supportingSegmentIds: Object.freeze([]),
        narrativeReasonCodes: Object.freeze([]),
      }));
      return;
    }
    const slot = slotByInterval.get(plan.intervalId)!;
    const narrativeReasonCodes = Object.freeze(plan.transitionEvidence.map((reason) => reason.code));
    const evidenceReference = matchingEvidenceReference(plan);
    if (plan.matchEvidence.sourceRangePlacementLimitation || assignable.length > NARRATIVE_ACTION_COMPILER_LIMITS.maxCanonicalActions) {
      intervalActionMap.push(Object.freeze({
        intervalId: plan.intervalId,
        narrativePlanIndex,
        status: "UNSUPPORTED",
        selectedAssetId: plan.assetId,
        targetClipId: slot.clipId,
        supportingSegmentIds: plan.supportingSegmentIds,
        matchingEvidenceReference: evidenceReference,
        narrativeReasonCodes,
      }));
      return;
    }
    if (nonCompilable) {
      intervalActionMap.push(Object.freeze({
        intervalId: plan.intervalId,
        narrativePlanIndex,
        status: "BLOCKED_BY_ATOMIC_POLICY",
        selectedAssetId: plan.assetId,
        targetClipId: slot.clipId,
        supportingSegmentIds: plan.supportingSegmentIds,
        matchingEvidenceReference: evidenceReference,
        narrativeReasonCodes,
      }));
      return;
    }
    if (slot.currentAssetId === plan.assetId && clipById.get(slot.clipId)?.sourceInMs === 0) {
      intervalActionMap.push(Object.freeze({
        intervalId: plan.intervalId,
        narrativePlanIndex,
        status: "NO_ACTION_REQUIRED",
        selectedAssetId: plan.assetId,
        targetClipId: slot.clipId,
        supportingSegmentIds: plan.supportingSegmentIds,
        matchingEvidenceReference: evidenceReference,
        narrativeReasonCodes,
      }));
      return;
    }
    const actionIndex = actions.length;
    const action = {
      type: "MATCH_ASSET_TO_SEGMENT",
      targetId: slot.clipId,
      assetId: plan.assetId,
      startSeconds: slot.timelineStartMs / 1_000,
      endSeconds: slot.timelineEndMs / 1_000,
      reason: reasonForInterval(plan.intervalId),
    } satisfies EditorAIPlanAction;
    actions.push(action);
    intervalActionMap.push(Object.freeze({
      intervalId: plan.intervalId,
      narrativePlanIndex,
      status: "COMPILED",
      selectedAssetId: plan.assetId,
      targetClipId: slot.clipId,
      actionIndex,
      actionType: "MATCH_ASSET_TO_SEGMENT",
      supportingSegmentIds: plan.supportingSegmentIds,
      matchingEvidenceReference: evidenceReference,
      narrativeReasonCodes,
    }));
  });

  if (nonCompilable) {
    return Object.freeze({
      schemaVersion: NARRATIVE_ACTION_COMPILER_SCHEMA_VERSION,
      mode: "INITIAL_PLAN",
      status: "NOT_COMPILABLE",
      sourceNarrativeReference: narrativeReference(context.narrativePlan),
      canonicalPlan: emptyCanonicalPlan(errors.length),
      intervalActionMap: Object.freeze(intervalActionMap),
      unresolvedIntervalIds: Object.freeze(unresolvedIntervalIds),
      unsupportedIntervalIds: Object.freeze(unsupportedIntervalIds),
      warnings: Object.freeze([]),
      errors: Object.freeze(errors),
      canonicalValidation: Object.freeze({ parser: "parseAIEditingPlan", valid: true }),
    });
  }

  if (new Set(actions.map((action) => action.targetId)).size !== actions.length) {
    fail("Compiled batch contains duplicate target mutation.");
  }
  if (new Set(actions.map((action) => JSON.stringify(action))).size !== actions.length) {
    fail("Compiled batch contains repeated identical actions.");
  }
  const canonicalPlan = freezeCanonicalPlan(parseAIEditingPlan({
    summary: `Compile ${actions.length} narrative asset assignment(s).`,
    actions,
    unsupported: [],
    warnings: [],
  }));
  canonicalPlan.actions.forEach((action, index) => {
    const link = intervalActionMap.find((item) => item.actionIndex === index);
    if (!link?.targetClipId) fail("Compiled action is missing deterministic intent mapping.");
    validateMatchPreconditions(
      action,
      slotByInterval.get(link.intervalId)!,
      clipById,
      projectAssetIds,
      context.project.durationMs,
      context.ownedAssetIds,
    );
  });
  const enforcementIssues: CompilerIssue[] = [];
  if (context.constraintContext) {
    for (const action of canonicalPlan.actions) {
      const enforcement = enforceEditorActionConstraintsV1({
        project: context.project,
        constraintSet: context.constraintContext.constraintSet,
        expectedContext: {
          intentVersionId: context.constraintContext.intentVersionId,
          constraintSetId: context.constraintContext.constraintSetId,
          constraintFingerprint: context.constraintContext.constraintFingerprint,
        },
        action,
      });
      if (enforcement.status !== "ALLOWED") {
        enforcementIssues.push(Object.freeze({
          code: enforcement.status === "STALE_CONSTRAINT_CONTEXT" ? "STALE_CONSTRAINT_CONTEXT" : "HARD_CONSTRAINT_BLOCKED",
          message: enforcement.violations[0]?.messageZh ?? "Canonical action is blocked by active hard constraints.",
          intervalId: intervalActionMap.find((link) => link.actionIndex === canonicalPlan.actions.indexOf(action))?.intervalId,
        }));
      } else if (isRejectedSemanticActionV1({
        projectId: context.project.id,
        intentVersionId: context.constraintContext.intentVersionId,
        action,
        rejectedOperationTuples: context.rejectedOperationTuples,
      })) {
        enforcementIssues.push(Object.freeze({
          code: "SESSION_REJECTION_REINTRODUCED",
          message: "A user-rejected semantic action tuple cannot be reintroduced in the same project and intent lineage.",
          intervalId: intervalActionMap.find((link) => link.actionIndex === canonicalPlan.actions.indexOf(action))?.intervalId,
        }));
      }
    }
  }
  if (enforcementIssues.length) {
    const blockedLinks = intervalActionMap.map((link) => {
      if (link.status !== "COMPILED") return link;
      const { actionIndex: _actionIndex, actionType: _actionType, ...rest } = link;
      return Object.freeze({ ...rest, status: "BLOCKED_BY_ATOMIC_POLICY" as const });
    });
    return Object.freeze({
      schemaVersion: NARRATIVE_ACTION_COMPILER_SCHEMA_VERSION,
      mode: "INITIAL_PLAN",
      status: "NOT_COMPILABLE",
      sourceNarrativeReference: narrativeReference(context.narrativePlan),
      canonicalPlan: emptyCanonicalPlan(enforcementIssues.length),
      intervalActionMap: Object.freeze(blockedLinks),
      unresolvedIntervalIds: Object.freeze([]),
      unsupportedIntervalIds: Object.freeze(enforcementIssues.flatMap((issue) => issue.intervalId ? [issue.intervalId] : [])),
      warnings: Object.freeze([]),
      errors: Object.freeze(enforcementIssues),
      canonicalValidation: Object.freeze({ parser: "parseAIEditingPlan", valid: true }),
    });
  }
  return Object.freeze({
    schemaVersion: NARRATIVE_ACTION_COMPILER_SCHEMA_VERSION,
    mode: "INITIAL_PLAN",
    status: "VALIDATED",
    sourceNarrativeReference: narrativeReference(context.narrativePlan),
    canonicalPlan,
    intervalActionMap: Object.freeze(intervalActionMap),
    unresolvedIntervalIds: Object.freeze([]),
    unsupportedIntervalIds: Object.freeze([]),
    warnings: Object.freeze([]),
    errors: Object.freeze([]),
    canonicalValidation: Object.freeze({ parser: "parseAIEditingPlan", valid: true }),
  });
}
