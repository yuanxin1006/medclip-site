import assert from "node:assert/strict";
import test from "node:test";
import {
  appendProposalDecisionEvidenceV1,
  createConstraintResolutionV1,
  createNegotiationStateV1,
  isProposalConstraintContextCurrentV1,
  parseConstraintResolutionV1,
  resolveConstraintConflictV1,
  transitionNegotiationStateV1,
  type ConstraintResolutionChoice,
  type ProposalConstraintContextV1,
} from "./editor-constraint-negotiation.ts";
import { createCampusNegotiationScenario, NEGOTIATION_FIXTURE_CREATED_AT } from "./test-support/editor-constraint-negotiation-fixture.ts";

function conflictId() {
  const scenario = createCampusNegotiationScenario();
  return scenario.report.conflicts.find((item) => item.type === "DURATION_CONFLICT")!.conflictId;
}

function resolve(choice: ConstraintResolutionChoice, selectedDurationMs?: number) {
  const scenario = createCampusNegotiationScenario();
  return resolveConstraintConflictV1({
    state: scenario.state,
    intent: scenario.intent,
    project: scenario.project,
    projectFingerprint: scenario.projectFingerprint,
    confirmedBindings: scenario.confirmedBindings,
    feasibilityReport: scenario.report,
    conflictId: conflictId(),
    selectedResolution: choice,
    createdAt: "2026-10-25T01:00:00.000Z",
    ...(selectedDurationMs === undefined ? {} : { selectedDurationMs }),
  });
}

function manualDraft(createdAt = NEGOTIATION_FIXTURE_CREATED_AT) {
  const scenario = createCampusNegotiationScenario();
  const conflict = scenario.report.conflicts.find((item) => item.type === "DURATION_CONFLICT")!;
  return {
    conflictId: conflict.conflictId,
    selectedResolution: "EDIT_REQUIREMENTS_MANUALLY" as const,
    affectedConstraintIds: conflict.involvedConstraintIds,
    priorIntentVersionId: scenario.intent.intentId,
    resultingIntentVersionId: scenario.intent.intentId,
    structuredPolicy: { policy: "MANUAL_REQUIREMENT_EDIT" as const, planningPaused: true as const, generateProposal: false as const, execute: false as const, preserveConfirmedBindings: true as const },
    userConfirmed: true as const,
    createdAt,
  };
}

test("resolution domain A-C: valid resolution parses, identity is deterministic, and createdAt is excluded", () => {
  const first = createConstraintResolutionV1(manualDraft());
  const second = createConstraintResolutionV1(manualDraft("2026-10-25T02:00:00.000Z"));
  assert.equal(first.resolutionId, second.resolutionId);
  assert.deepEqual(parseConstraintResolutionV1(first), first);
  assert.equal(Object.isFrozen(first), true);
});

test("resolution domain D-H: invalid conflict, unsupported choice, missing confirmation, bad lineage and malformed policy are rejected", () => {
  assert.throws(() => createConstraintResolutionV1({ ...manualDraft(), conflictId: "bad" }), /conflictId/);
  assert.throws(() => createConstraintResolutionV1({ ...manualDraft(), selectedResolution: "DELETE_PROTECTION" }), /unsupported/);
  assert.throws(() => createConstraintResolutionV1({ ...manualDraft(), userConfirmed: false }), /userConfirmed/);
  assert.throws(() => createConstraintResolutionV1({ ...manualDraft(), resultingIntentVersionId: "intent-v1-deadbeef" }), /lineage/);
  assert.throws(() => createConstraintResolutionV1({ ...manualDraft(), structuredPolicy: { policy: "MANUAL_REQUIREMENT_EDIT" } }), /missing or unknown/);
});

test("campus baseline is a deterministic 30s versus 38s decision with an 8s gap", () => {
  const scenario = createCampusNegotiationScenario();
  assert.equal(scenario.state.status, "NEEDS_USER_DECISION");
  assert.equal(scenario.report.requestedDurationMs, 30_000);
  assert.equal(scenario.report.minimumFeasibleDurationMs, 38_000);
  assert.equal(scenario.report.remainingGapMs, 8_000);
});

test("option A creates immutable intent v2, preserves hard requirements, rebuilds constraints and becomes ready only after re-feasibility", () => {
  const scenario = createCampusNegotiationScenario();
  const priorSnapshot = JSON.stringify(scenario.intent);
  const result = resolve("RELAX_TARGET_DURATION", 38_000);
  assert.equal(JSON.stringify(scenario.intent), priorSnapshot);
  assert.equal(result.resultingIntent.version, 2);
  assert.equal(result.resultingIntent.parentIntentVersionId, scenario.intent.intentId);
  assert.equal(result.resultingIntent.sourceRequest, scenario.intent.sourceRequest);
  assert.equal(result.resultingIntent.clauses.filter((item) => item.kind === "HARD_CONSTRAINT_REQUEST").length, 2);
  assert.equal(result.resultingIntent.clauses.find((item) => item.kind === "GOAL")?.payload.durationMs, 38_000);
  assert.notEqual(result.constraintSet?.constraintSetId, scenario.constraintSet.constraintSetId);
  assert.equal(result.feasibilityReport?.status, "FEASIBLE");
  assert.equal(result.state.status, "READY_TO_PLAN");
  assert.ok(result.proposalContext);
});

test("option A rejects a duration below the safe lower bound and cannot infer readiness", () => {
  assert.throws(() => resolve("RELAX_TARGET_DURATION", 37_999), /safe lower bound/);
});

test("option B preserves target and protections, exposes 38s/8s truth, and enables only explicit closest-safe planning", () => {
  const scenario = createCampusNegotiationScenario();
  const result = resolve("OPTIMIZE_UNPROTECTED_ONLY");
  const goal = result.resultingIntent.clauses.find((item) => item.kind === "GOAL");
  assert.equal(goal?.payload.durationMs, 30_000);
  assert.equal(goal?.payload.policy, "APPROXIMATE_TARGET");
  assert.equal(result.constraintSet?.activeConstraints.length, scenario.constraintSet.activeConstraints.length);
  assert.deepEqual(result.constraintSet?.activeConstraints.map((item) => item.permissions), scenario.constraintSet.activeConstraints.map((item) => item.permissions));
  assert.equal(result.feasibilityReport?.requestedDurationMs, 30_000);
  assert.equal(result.feasibilityReport?.minimumFeasibleDurationMs, 38_000);
  assert.equal(result.feasibilityReport?.remainingGapMs, 8_000);
  assert.equal(result.feasibilityReport?.status, "FEASIBLE_WITH_TARGET_GAP");
  assert.equal(result.resolution.structuredPolicy.policy, "CLOSEST_SAFELY_ACHIEVABLE");
  if (result.resolution.structuredPolicy.policy === "CLOSEST_SAFELY_ACHIEVABLE") {
    assert.equal(result.resolution.structuredPolicy.canReachRequestedDuration, false);
    assert.equal(result.resolution.structuredPolicy.hardProtections, "UNCHANGED");
  }
  assert.equal(result.state.status, "READY_TO_PLAN");
});

test("option C pauses planning without a proposal, execution, intent mutation, or binding deletion", () => {
  const scenario = createCampusNegotiationScenario();
  const result = resolve("EDIT_REQUIREMENTS_MANUALLY");
  assert.equal(result.state.status, "DRAFT");
  assert.equal(result.state.planningPaused, true);
  assert.equal(result.resultingIntent, result.priorIntent);
  assert.equal(result.constraintSet, undefined);
  assert.equal(result.feasibilityReport, undefined);
  assert.equal(result.proposalContext, undefined);
  assert.deepEqual(result.confirmedBindings, scenario.confirmedBindings);
  assert.equal(result.resolution.structuredPolicy.policy, "MANUAL_REQUIREMENT_EDIT");
});

test("state machine covers every state and rejects silent jumps", () => {
  const scenario = createCampusNegotiationScenario();
  const draft = createNegotiationStateV1(scenario.intent);
  const grounding = transitionNegotiationStateV1(draft, { status: "GROUNDING_REQUIRED", activeIntentVersionId: scenario.intent.intentId, resolutionIds: [], unresolvedConflictIds: [], planningPaused: false });
  const checking = transitionNegotiationStateV1(grounding, { status: "FEASIBILITY_CHECK", activeIntentVersionId: scenario.intent.intentId, resolutionIds: [], unresolvedConflictIds: [], planningPaused: false });
  const decision = transitionNegotiationStateV1(checking, { status: "NEEDS_USER_DECISION", activeIntentVersionId: scenario.intent.intentId, resolutionIds: [], unresolvedConflictIds: [conflictId()], planningPaused: false });
  const resolved = transitionNegotiationStateV1(decision, { status: "RESOLVED", activeIntentVersionId: scenario.intent.intentId, resolutionIds: [], unresolvedConflictIds: [], planningPaused: false });
  const checkingAgain = transitionNegotiationStateV1(resolved, { status: "FEASIBILITY_CHECK", activeIntentVersionId: scenario.intent.intentId, resolutionIds: [], unresolvedConflictIds: [], planningPaused: false });
  const ready = transitionNegotiationStateV1(checkingAgain, { status: "READY_TO_PLAN", activeIntentVersionId: scenario.intent.intentId, resolutionIds: [], unresolvedConflictIds: [], planningPaused: false });
  const blocked = transitionNegotiationStateV1(ready, { status: "BLOCKED", activeIntentVersionId: scenario.intent.intentId, resolutionIds: [], unresolvedConflictIds: [], planningPaused: false });
  assert.deepEqual([draft.status, grounding.status, checking.status, decision.status, resolved.status, ready.status, blocked.status], ["DRAFT", "GROUNDING_REQUIRED", "FEASIBILITY_CHECK", "NEEDS_USER_DECISION", "RESOLVED", "READY_TO_PLAN", "BLOCKED"]);
  assert.throws(() => transitionNegotiationStateV1(draft, { status: "READY_TO_PLAN", activeIntentVersionId: scenario.intent.intentId, resolutionIds: [], unresolvedConflictIds: [], planningPaused: false }), /Invalid negotiation transition/);
});

test("proposal invalidation detects intent, constraint fingerprint, resolution, and feasibility changes", () => {
  const context = resolve("RELAX_TARGET_DURATION").proposalContext!;
  assert.equal(isProposalConstraintContextCurrentV1(context, context), true);
  const changes: ProposalConstraintContextV1[] = [
    { ...context, sourceIntentVersionId: "intent-v1-deadbeef" },
    { ...context, sourceConstraintFingerprint: "constraint-fingerprint-v1-deadbeef" },
    { ...context, resolutionIds: ["resolution-v1-deadbeef"] },
    { ...context, feasibilityReportId: "feasibility-report-v1-deadbeef" },
  ];
  changes.forEach((changed) => assert.equal(isProposalConstraintContextCurrentV1(context, changed), false));
});

test("stale binding cannot be silently carried and returns to grounding", () => {
  const scenario = createCampusNegotiationScenario();
  const changedProject = { ...scenario.project, tracks: [{ ...scenario.project.tracks[0], clips: scenario.project.tracks[0].clips.filter((item) => item.id !== "clip-logo") }] };
  const result = resolveConstraintConflictV1({
    state: scenario.state, intent: scenario.intent, project: changedProject,
    projectFingerprint: scenario.projectFingerprint, confirmedBindings: scenario.confirmedBindings,
    feasibilityReport: scenario.report, conflictId: conflictId(), selectedResolution: "RELAX_TARGET_DURATION",
    createdAt: "2026-10-25T01:00:00.000Z", selectedDurationMs: 38_000,
  });
  assert.equal(result.state.status, "GROUNDING_REQUIRED");
  assert.equal(result.proposalContext, undefined);
});

test("full structured lineage and session decision evidence remain retained", () => {
  const scenario = createCampusNegotiationScenario();
  const result = resolve("RELAX_TARGET_DURATION");
  assert.equal(result.priorIntent.sourceRequest, scenario.intent.sourceRequest);
  assert.equal(result.resolution.conflictId, conflictId());
  assert.equal(result.resultingIntent.resolutionIds.at(-1), result.resolution.resolutionId);
  assert.equal(result.constraintSet?.intentVersionId, result.resultingIntent.intentId);
  assert.equal(result.constraintSet?.resolutionIds.at(-1), result.resolution.resolutionId);
  assert.equal(result.feasibilityReport?.constraintSetId, result.constraintSet?.constraintSetId);
  assert.equal(result.proposalContext?.feasibilityReportId, result.feasibilityReport?.reportId);
  const ledger = appendProposalDecisionEvidenceV1(result.ledger, {
    rejectedOperationTuples: ["MATCH_ASSET_TO_SEGMENT|clip-a|asset-b"],
    humanModifiedSelections: [{ proposalEntryId: "entry-a", selectedAssetId: "asset-c" }],
  });
  assert.equal(ledger.confirmedBindingIds.length, 4);
  assert.deepEqual(ledger.rejectedProposalOperationTuples, ["MATCH_ASSET_TO_SEGMENT|clip-a|asset-b"]);
  assert.deepEqual(ledger.humanModifiedSelections, [{ proposalEntryId: "entry-a", selectedAssetId: "asset-c" }]);
});
