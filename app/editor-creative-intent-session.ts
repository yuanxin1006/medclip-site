import type { CreativeIntentV1 } from "./editor-creative-intent.ts";
import {
  buildConstraintSetV1,
  confirmDirectSelectionV1,
  type ConfirmedBindingRecordV1,
  type GroundingSelectionV1,
} from "./editor-constraint-grounding.ts";
import {
  evaluateConstraintFeasibilityV1,
  type ConstraintFeasibilityReportV1,
} from "./editor-constraint-feasibility.ts";
import type { ConstraintSetV1 } from "./editor-constraints.ts";
import type { EditorProject } from "./editor-core.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import {
  createNegotiationStateV1,
  negotiationStateFromFeasibilityV1,
  resolveConstraintConflictV1,
  transitionNegotiationStateV1,
  type ConstraintResolutionChoice,
  type ConstraintResolutionV1,
  type NegotiationStateV1,
  type ProposalConstraintContextV1,
  type SessionDecisionLedgerV1,
} from "./editor-constraint-negotiation.ts";
import type { VideoSemanticAnalysis } from "./editor-video-semantic.ts";

export type CreativeIntentSessionStatus =
  | "NO_INTENT"
  | "ANALYZING_INTENT"
  | "INTENT_READY"
  | "GROUNDING_REQUIRED"
  | "FEASIBILITY_CHECK"
  | "NEEDS_USER_DECISION"
  | "READY_TO_PLAN"
  | "BLOCKED";

export type CreativeIntentSessionV1 = Readonly<{
  status: CreativeIntentSessionStatus;
  sourceRequest: string;
  intent: CreativeIntentV1 | null;
  confirmedBindings: readonly ConfirmedBindingRecordV1[];
  constraintSet: ConstraintSetV1 | null;
  feasibilityReport: ConstraintFeasibilityReportV1 | null;
  negotiationState: NegotiationStateV1 | null;
  resolution: ConstraintResolutionV1 | null;
  proposalContext: ProposalConstraintContextV1 | null;
  ledger: SessionDecisionLedgerV1 | null;
  reason: string | null;
}>;

export function emptyCreativeIntentSessionV1(sourceRequest = ""): CreativeIntentSessionV1 {
  return Object.freeze({
    status: "NO_INTENT", sourceRequest, intent: null, confirmedBindings: Object.freeze([]),
    constraintSet: null, feasibilityReport: null, negotiationState: null, resolution: null,
    proposalContext: null, ledger: null, reason: null,
  });
}
export function analyzingCreativeIntentSessionV1(sourceRequest: string): CreativeIntentSessionV1 {
  return Object.freeze({ ...emptyCreativeIntentSessionV1(sourceRequest), status: "ANALYZING_INTENT" });
}
export function creativeIntentReadySessionV1(
  intent: CreativeIntentV1,
  priorLedger: SessionDecisionLedgerV1 | null = null,
): CreativeIntentSessionV1 {
  const draft = createNegotiationStateV1(intent);
  const hasHard = intent.clauses.some((clause) => clause.kind === "HARD_CONSTRAINT_REQUEST");
  const negotiationState = hasHard ? transitionNegotiationStateV1(draft, {
    status: "GROUNDING_REQUIRED",
    activeIntentVersionId: intent.intentId,
    resolutionIds: intent.resolutionIds,
    unresolvedConflictIds: Object.freeze([]),
    planningPaused: false,
  }) : draft;
  return Object.freeze({
    ...emptyCreativeIntentSessionV1(intent.sourceRequest),
    status: hasHard ? "GROUNDING_REQUIRED" : "INTENT_READY",
    intent,
    negotiationState,
    ledger: priorLedger?.projectId === intent.projectId ? priorLedger : null,
  });
}

export function evaluateCreativeIntentSessionV1(input: Readonly<{
  session: CreativeIntentSessionV1;
  project: EditorProject;
  videoSemanticAnalyses?: readonly VideoSemanticAnalysis[];
}>): CreativeIntentSessionV1 {
  const { session } = input;
  if (!session.intent || !session.negotiationState) throw new Error("No creative intent is ready for feasibility.");
  const projectFingerprint = createEditorProjectFingerprint(input.project);
  const build = buildConstraintSetV1({
    intent: session.intent, project: input.project, projectFingerprint,
    confirmedBindings: session.confirmedBindings, videoSemanticAnalyses: input.videoSemanticAnalyses,
  });
  if (build.status !== "CONSTRAINT_SET_BUILT") return Object.freeze({
    ...session, status: "BLOCKED", constraintSet: null, feasibilityReport: null,
    proposalContext: null, reason: build.message,
  });
  if (build.unresolvedRequestCount > 0) return Object.freeze({ ...session, status: "GROUNDING_REQUIRED" });
  const checking = transitionNegotiationStateV1(session.negotiationState, {
    status: "FEASIBILITY_CHECK", activeIntentVersionId: session.intent.intentId,
    constraintSetId: build.constraintSet.constraintSetId,
    constraintFingerprint: build.constraintSet.constraintFingerprint,
    resolutionIds: session.intent.resolutionIds, unresolvedConflictIds: Object.freeze([]), planningPaused: false,
  });
  const report = evaluateConstraintFeasibilityV1({
    project: input.project, intent: session.intent, constraintSet: build.constraintSet,
    projectFingerprint, videoSemanticAnalyses: input.videoSemanticAnalyses,
  });
  const negotiationState = negotiationStateFromFeasibilityV1(checking, session.intent, build.constraintSet, report);
  const ready = negotiationState.status === "READY_TO_PLAN";
  const ledger: SessionDecisionLedgerV1 = Object.freeze({
    schemaVersion: 1, projectId: input.project.id,
    confirmedBindingIds: Object.freeze([...new Set([
      ...(session.ledger?.confirmedBindingIds ?? []),
      ...session.confirmedBindings.map((item) => item.confirmationId),
    ])]),
    selectedResolutionIds: Object.freeze([...new Set([
      ...(session.ledger?.selectedResolutionIds ?? []),
      ...session.intent.resolutionIds,
    ])]),
    rejectedProposalOperationTuples: Object.freeze([...(session.ledger?.rejectedProposalOperationTuples ?? [])]),
    humanModifiedSelections: Object.freeze([...(session.ledger?.humanModifiedSelections ?? [])]),
  });
  return Object.freeze({
    ...session,
    status: ready ? "READY_TO_PLAN" : negotiationState.status === "NEEDS_USER_DECISION" ? "NEEDS_USER_DECISION" : "BLOCKED",
    constraintSet: build.constraintSet, feasibilityReport: report, negotiationState, ledger,
    proposalContext: ready ? Object.freeze({
      sourceIntentVersionId: session.intent.intentId,
      sourceConstraintSetId: build.constraintSet.constraintSetId,
      sourceConstraintFingerprint: build.constraintSet.constraintFingerprint,
      resolutionIds: Object.freeze([...session.intent.resolutionIds]),
      feasibilityReportId: report.reportId,
      readiness: "READY_TO_PLAN" as const,
    }) : null,
    reason: negotiationState.reason ?? null,
  });
}

export function confirmCreativeIntentGroundingV1(input: Readonly<{
  session: CreativeIntentSessionV1;
  project: EditorProject;
  sourceClauseId: string;
  selection: GroundingSelectionV1;
  videoSemanticAnalyses?: readonly VideoSemanticAnalysis[];
}>): CreativeIntentSessionV1 {
  if (!input.session.intent || !input.session.negotiationState) throw new Error("No active creative intent is available for grounding.");
  const projectFingerprint = createEditorProjectFingerprint(input.project);
  const confirmation = confirmDirectSelectionV1({
    context: { intent: input.session.intent, project: input.project, projectFingerprint, videoSemanticAnalyses: input.videoSemanticAnalyses },
    sourceClauseId: input.sourceClauseId,
    selection: input.selection,
  });
  if (confirmation.status !== "ACCEPTED") throw new Error(confirmation.message);
  const confirmedBindings = Object.freeze([
    ...input.session.confirmedBindings.filter((item) => item.sourceClauseId !== input.sourceClauseId),
    confirmation.value,
  ]);
  const build = buildConstraintSetV1({
    intent: input.session.intent,
    project: input.project,
    projectFingerprint,
    confirmedBindings,
    videoSemanticAnalyses: input.videoSemanticAnalyses,
  });
  if (build.status !== "CONSTRAINT_SET_BUILT") return Object.freeze({
    ...input.session, status: "BLOCKED", confirmedBindings, constraintSet: null,
    feasibilityReport: null, proposalContext: null, reason: build.message,
    negotiationState: transitionNegotiationStateV1(input.session.negotiationState, {
      status: "BLOCKED", activeIntentVersionId: input.session.intent.intentId,
      resolutionIds: input.session.intent.resolutionIds, unresolvedConflictIds: Object.freeze([]),
      planningPaused: false, reason: build.message,
    }),
  });
  if (build.unresolvedRequestCount > 0) return Object.freeze({
    ...input.session, status: "GROUNDING_REQUIRED", confirmedBindings,
    constraintSet: null, feasibilityReport: null, proposalContext: null, reason: null,
  });
  return evaluateCreativeIntentSessionV1({
    session: Object.freeze({ ...input.session, confirmedBindings, constraintSet: build.constraintSet }),
    project: input.project,
    videoSemanticAnalyses: input.videoSemanticAnalyses,
  });
}

export function resolveCreativeIntentConflictV1(input: Readonly<{
  session: CreativeIntentSessionV1;
  project: EditorProject;
  choice: ConstraintResolutionChoice;
  createdAt: string;
  videoSemanticAnalyses?: readonly VideoSemanticAnalysis[];
}>): CreativeIntentSessionV1 {
  const { session } = input;
  if (!session.intent || !session.negotiationState || !session.feasibilityReport) throw new Error("No active feasibility conflict is available.");
  const conflict = session.feasibilityReport.conflicts.find((item) => item.status !== "RESOLVED_BY_USER");
  if (!conflict) throw new Error("No unresolved conflict is available.");
  const result = resolveConstraintConflictV1({
    state: session.negotiationState, intent: session.intent, project: input.project,
    projectFingerprint: createEditorProjectFingerprint(input.project), confirmedBindings: session.confirmedBindings,
    feasibilityReport: session.feasibilityReport, conflictId: conflict.conflictId,
    selectedResolution: input.choice, createdAt: input.createdAt,
    videoSemanticAnalyses: input.videoSemanticAnalyses, ledger: session.ledger ?? undefined,
  });
  return Object.freeze({
    ...session,
    status: result.state.planningPaused ? "INTENT_READY"
      : result.state.status === "READY_TO_PLAN" ? "READY_TO_PLAN"
        : result.state.status === "GROUNDING_REQUIRED" ? "GROUNDING_REQUIRED"
          : result.state.status === "NEEDS_USER_DECISION" ? "NEEDS_USER_DECISION" : "BLOCKED",
    intent: result.resultingIntent,
    confirmedBindings: result.confirmedBindings,
    constraintSet: result.constraintSet ?? session.constraintSet,
    feasibilityReport: result.feasibilityReport ?? session.feasibilityReport,
    negotiationState: result.state,
    resolution: result.resolution,
    proposalContext: result.proposalContext ?? null,
    ledger: result.ledger,
    reason: result.state.reason ?? null,
  });
}

export function invalidateCreativeIntentSessionV1(
  session: CreativeIntentSessionV1,
  sourceRequest: string,
  reason = "Requirement or trusted project state changed; reconfirm creative intent.",
): CreativeIntentSessionV1 {
  if (session.status === "NO_INTENT" && session.sourceRequest === sourceRequest) return session;
  return Object.freeze({ ...emptyCreativeIntentSessionV1(sourceRequest), ledger: session.ledger, reason });
}
