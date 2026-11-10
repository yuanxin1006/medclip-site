import assert from "node:assert/strict";
import test from "node:test";
import { generateEditorProposal, isEditorProposalCurrent } from "./editor-proposal-orchestrator.ts";
import { resolveConstraintConflictV1, type ProposalConstraintContextV1 } from "./editor-constraint-negotiation.ts";
import { createCampusNegotiationScenario } from "./test-support/editor-constraint-negotiation-fixture.ts";
import { createMedicalReviewInput } from "./test-support/editor-proposal-review-fixture.ts";
import { createProtectedClipConstraintSet } from "./test-support/editor-constraint-enforcement-fixture.ts";

function readyContext(): ProposalConstraintContextV1 {
  const scenario = createCampusNegotiationScenario();
  const conflict = scenario.report.conflicts.find((item) => item.type === "DURATION_CONFLICT")!;
  const result = resolveConstraintConflictV1({
    state: scenario.state, intent: scenario.intent, project: scenario.project,
    projectFingerprint: scenario.projectFingerprint, confirmedBindings: scenario.confirmedBindings,
    feasibilityReport: scenario.report, conflictId: conflict.conflictId,
    selectedResolution: "RELAX_TARGET_DURATION", createdAt: "2026-10-25T01:00:00.000Z",
  });
  return result.proposalContext!;
}

test("existing proposal entry point records resolved intent, constraint, resolution and feasibility provenance", () => {
  const input = createMedicalReviewInput();
  const resolved = readyContext();
  const constraintSet = createProtectedClipConstraintSet(input.project, "clip-0", {
    allowDelete: true, allowTrim: true, allowMove: true, allowSpeedChange: true, allowAssetReplace: true,
    allowCaptionTextChange: true, allowTimingChange: true, allowSplit: true, allowTransformChange: true,
    allowAudioRangeChange: true,
  });
  const constraintContext: ProposalConstraintContextV1 = {
    ...resolved,
    sourceIntentVersionId: constraintSet.intentVersionId,
    sourceConstraintSetId: constraintSet.constraintSetId,
    sourceConstraintFingerprint: constraintSet.constraintFingerprint,
  };
  const generated = generateEditorProposal({ ...input, constraintContext, constraintSet });
  assert.equal(generated.ok, true);
  if (!generated.ok) return;
  assert.deepEqual(generated.bundle.evidenceMetadata.constraintContext, constraintContext);
  assert.equal(isEditorProposalCurrent(generated.bundle, input.project, constraintContext), true);
  assert.equal(isEditorProposalCurrent(generated.bundle, input.project, { ...constraintContext, sourceIntentVersionId: "intent-v1-deadbeef" }), false);
});

test("proposal generation is rejected before READY_TO_PLAN and no alternate planner is introduced", () => {
  const input = createMedicalReviewInput();
  const notReady = { ...readyContext(), readiness: "NEEDS_USER_DECISION" } as unknown as ProposalConstraintContextV1;
  const generated = generateEditorProposal({ ...input, constraintContext: notReady });
  assert.deepEqual(generated, { ok: false, status: "NEGOTIATION_NOT_READY", message: "Constraint negotiation has not reached READY_TO_PLAN." });
});
