import type { EditorProposalBundle, SafeNoChangeEligibilityV1 } from "./editor-proposal-orchestrator.ts";
import type { ReviewedProposalExecution } from "./editor-proposal-review.ts";
import type {
  CreativeIntentSessionStatus,
  CreativeIntentSessionV1,
} from "./editor-creative-intent-session.ts";
import type { ConstraintFeasibilityStatus } from "./editor-constraint-feasibility.ts";
import type { ConstraintResolutionChoice } from "./editor-constraint-negotiation.ts";

export const EDITOR_ACCEPTANCE_DIAGNOSTICS_FLAG = "__MEDCLIP_ACCEPTANCE_DIAGNOSTICS__" as const;
export const EDITOR_ACCEPTANCE_DIAGNOSTIC_EVENT = "medclip:acceptance-diagnostic" as const;

export type EditorAcceptanceDiagnosticStageV1 =
  | "ACCEPTANCE_INPUT_HYDRATION"
  | "ACCEPTANCE_INPUT_CONSUMPTION"
  | "NEGOTIATION_STATE"
  | "CONTEXT_VALIDATION"
  | "SAFE_NO_CHANGE_ELIGIBILITY"
  | "SAFE_NO_CHANGE_SELECTED"
  | "INTERVAL_BUILD"
  | "SEED_SLOT_BUILD"
  | "CANDIDATE_FILTER"
  | "COMPILER"
  | "COLLABORATIVE_OPTION_FILTER"
  | "RESULT_MAPPING"
  | "ZERO_ACTION_REVIEW_RESULT";

export type EditorAcceptanceFailureCategoryV1 =
  | "NO_VALID_CANDIDATE"
  | "UNRESOLVED_INTERVAL"
  | "SOURCE_RANGE_UNSUPPORTED"
  | "MISSING_VIDEO_EVIDENCE"
  | "MISSING_INTERVALS"
  | "NEGOTIATION_NOT_READY"
  | "COMPILATION_REJECTED"
  | "NO_SAFE_OPTIONS"
  | "DISPLAY_SAFETY_FILTER_REJECTED"
  | "UNEXPECTED_INTERNAL_ERROR";

export type SafeNoChangeEligibilityDiagnosticV1 = Readonly<{
  schemaVersion: 1;
  kind: "SAFE_NO_CHANGE_ELIGIBILITY";
  stage: "SAFE_NO_CHANGE_ELIGIBILITY";
  evaluated: true;
  eligible: boolean;
  reasonCode: SafeNoChangeEligibilityV1["reasonCode"];
  failedChecks: SafeNoChangeEligibilityV1["failedChecks"];
  passedChecks: SafeNoChangeEligibilityV1["passedChecks"];
  evidence: SafeNoChangeEligibilityV1["evidence"];
}>;

export type EditorNegotiationStateDiagnosticV1 = Readonly<{
  schemaVersion: 1;
  kind: "NEGOTIATION_STATE";
  stage: "NEGOTIATION_STATE";
  resolution: ConstraintResolutionChoice;
  requestedTargetMs: number | null;
  minimumFeasibleMs: number | null;
  targetGapMs: number | null;
  planningState: CreativeIntentSessionStatus;
  feasibilityStatus: ConstraintFeasibilityStatus;
}>;

export type EditorProposalStageDiagnosticV1 = Readonly<{
  schemaVersion: 1;
  kind: "EDITOR_PROPOSAL_STAGE";
  stage: EditorAcceptanceDiagnosticStageV1;
  outcome: "ENTERED" | "SAFE_NO_CHANGE" | "READY_FOR_REVIEW" | "FAILED";
  failureCategory?: EditorAcceptanceFailureCategoryV1;
}>;

export type AcceptanceInputHydrationDiagnosticV1 = Readonly<{
  schemaVersion: 1;
  kind: "ACCEPTANCE_INPUT_HYDRATED";
  stage: "ACCEPTANCE_INPUT_HYDRATION";
  fixtureVersion: number | null;
  semanticAssetCount: number;
  rhythmEvidencePresent: boolean;
  category: "SUCCESS" | "INVALID_PAYLOAD" | "CACHE_NOT_EMPTY" | "BUILD_DISABLED" | "PAYLOAD_ABSENT";
}>;

export type AcceptanceInputConsumptionDiagnosticV1 = Readonly<{
  schemaVersion: 1;
  kind: "ACCEPTANCE_INPUT_AVAILABLE";
  stage: "ACCEPTANCE_INPUT_CONSUMPTION";
  fixtureVersion: 1;
  semanticAssetCount: number;
  rhythmEvidencePresent: boolean;
  category: "PLANNER_READ";
}>;

export type ZeroActionReviewResultDiagnosticV1 = Readonly<{
  schemaVersion: 1;
  kind: "ZERO_ACTION_REVIEW_RESULT";
  stage: "ZERO_ACTION_REVIEW_RESULT";
  proposalStatus: EditorProposalBundle["status"];
  reviewLifecycle: ReviewedProposalExecution["reviewState"]["lifecycle"];
  reviewedPlanStatus: ReviewedProposalExecution["reviewedPlan"]["status"];
  planEvidenceLifecycleStatus: ReviewedProposalExecution["planEvidence"]["lifecycleStatus"];
  executionPresent: boolean;
  historyShouldRecord: boolean;
  historyRecordCommitted: false;
  proposalActionCount: number;
  reviewedActionCount: number;
  executedActionCount: number;
}>;

export type EditorAcceptanceDiagnosticV1 =
  | EditorNegotiationStateDiagnosticV1
  | SafeNoChangeEligibilityDiagnosticV1
  | EditorProposalStageDiagnosticV1
  | AcceptanceInputHydrationDiagnosticV1
  | AcceptanceInputConsumptionDiagnosticV1
  | ZeroActionReviewResultDiagnosticV1;

type DiagnosticRuntime = Readonly<{
  [EDITOR_ACCEPTANCE_DIAGNOSTICS_FLAG]?: unknown;
  CustomEvent?: new (type: string, init: { detail: EditorAcceptanceDiagnosticV1 }) => Event;
  dispatchEvent?: (event: Event) => boolean;
}>;

function browserDiagnosticRuntime(): DiagnosticRuntime | undefined {
  const root = globalThis as typeof globalThis & { window?: DiagnosticRuntime };
  return root.window ?? (root as unknown as DiagnosticRuntime);
}

export function emitEditorAcceptanceDiagnosticV1(
  diagnostic: EditorAcceptanceDiagnosticV1,
  runtime: DiagnosticRuntime | undefined = browserDiagnosticRuntime(),
): boolean {
  if (!runtime
    || runtime[EDITOR_ACCEPTANCE_DIAGNOSTICS_FLAG] !== true
    || typeof runtime.CustomEvent !== "function"
    || typeof runtime.dispatchEvent !== "function") return false;
  try {
    return runtime.dispatchEvent(new runtime.CustomEvent(
      EDITOR_ACCEPTANCE_DIAGNOSTIC_EVENT,
      { detail: diagnostic },
    ));
  } catch {
    return false;
  }
}

export function emitSafeNoChangeEligibilityDiagnosticV1(
  eligibility: SafeNoChangeEligibilityV1,
): boolean {
  return emitEditorAcceptanceDiagnosticV1(Object.freeze({
    schemaVersion: 1,
    kind: "SAFE_NO_CHANGE_ELIGIBILITY",
    stage: "SAFE_NO_CHANGE_ELIGIBILITY",
    evaluated: true,
    eligible: eligibility.eligible,
    reasonCode: eligibility.reasonCode,
    failedChecks: Object.freeze([...eligibility.failedChecks]),
    passedChecks: Object.freeze([...eligibility.passedChecks]),
    evidence: Object.freeze({ ...eligibility.evidence }),
  }));
}

export function emitEditorNegotiationStateDiagnosticV1(
  session: CreativeIntentSessionV1,
): boolean {
  if (!session.resolution || !session.feasibilityReport) return false;
  return emitEditorAcceptanceDiagnosticV1(Object.freeze({
    schemaVersion: 1,
    kind: "NEGOTIATION_STATE",
    stage: "NEGOTIATION_STATE",
    resolution: session.resolution.selectedResolution,
    requestedTargetMs: session.feasibilityReport.requestedDurationMs,
    minimumFeasibleMs: session.feasibilityReport.minimumFeasibleDurationMs,
    targetGapMs: session.feasibilityReport.remainingGapMs,
    planningState: session.status,
    feasibilityStatus: session.feasibilityReport.status,
  }));
}

export function emitEditorProposalStageDiagnosticV1(
  stage: EditorAcceptanceDiagnosticStageV1,
  outcome: EditorProposalStageDiagnosticV1["outcome"],
  failureCategory?: EditorAcceptanceFailureCategoryV1,
): boolean {
  return emitEditorAcceptanceDiagnosticV1(Object.freeze({
    schemaVersion: 1,
    kind: "EDITOR_PROPOSAL_STAGE",
    stage,
    outcome,
    ...(failureCategory ? { failureCategory } : {}),
  }));
}

export function emitZeroActionReviewResultDiagnosticV1(input: Readonly<{
  proposal: EditorProposalBundle;
  result: ReviewedProposalExecution;
  historyRecordCommitted: false;
}>): boolean {
  if (input.proposal.status !== "SAFE_NO_CHANGE"
    || input.result.status !== "REVIEWED_NO_ACTIONS"
    || input.result.execution !== undefined
    || input.historyRecordCommitted !== false) return false;
  return emitEditorAcceptanceDiagnosticV1(Object.freeze({
    schemaVersion: 1,
    kind: "ZERO_ACTION_REVIEW_RESULT",
    stage: "ZERO_ACTION_REVIEW_RESULT",
    proposalStatus: input.proposal.status,
    reviewLifecycle: input.result.reviewState.lifecycle,
    reviewedPlanStatus: input.result.reviewedPlan.status,
    planEvidenceLifecycleStatus: input.result.planEvidence.lifecycleStatus,
    executionPresent: false,
    historyShouldRecord: input.result.history.shouldRecord,
    historyRecordCommitted: input.historyRecordCommitted,
    proposalActionCount: input.proposal.compiledPlan.canonicalPlan.actions.length,
    reviewedActionCount: input.result.reviewedPlan.compiledPlan.canonicalPlan.actions.length,
    executedActionCount: 0,
  }));
}
