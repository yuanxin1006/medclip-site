import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyAIEditingPlan } from "./editor-ai-requirements.ts";
import { ConstraintEnforcementBlockedError } from "./editor-constraint-enforcement.ts";
import { createConstraintEnforcementFixture } from "./test-support/editor-constraint-enforcement-fixture.ts";

const studio = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
const evaluationPanel = readFileSync(new URL("./editor-evaluation-panel.ts", import.meta.url), "utf8");

test("EditorStudio explains unavailable intent intake and retains grounding and negotiation guards", () => {
  assert.doesNotMatch(studio, /runAITask\(\{ task: "editor\.creative_intent_parse"/);
  assert.match(studio, /"分析创作意图"/);
  assert.match(studio, /当前服务未注册独立的创作意图与保护范围解析任务/);
  assert.match(studio, /confirmCreativeIntentGroundingV1/);
  assert.match(studio, /resolveCreativeIntentConflictV1/);
  assert.match(studio, /<CreativeIntentPanel/);
  assert.match(studio, /negotiationState=\{creativeIntentSession\.negotiationState\}/);
  assert.match(studio, /onSelectConstraintResolution=\{selectConstraintResolution\}/);
  assert.match(studio, /creativeIntentSession\.status !== "READY_TO_PLAN"/);
  assert.match(studio, /确认并应用剪辑建议/);
});
test("production proposal call uses the cost-aware collaborative boundary with complete authoritative context", () => {
  const handler = studio.slice(studio.indexOf("const generateProductionProposal"), studio.indexOf("const currentVideoSemanticEvidence"));
  assert.match(handler, /generateCollaborativeEditingOptionsV1\(/);
  assert.match(handler, /providerGenerationBudget: 0/);
  assert.match(handler, /constraintSet: creativeIntentSession\.constraintSet/);
  assert.match(handler, /constraintContext: creativeIntentSession\.proposalContext/);
  assert.match(handler, /sessionDecisionLedger: creativeIntentSession\.ledger/);
  assert.doesNotMatch(handler, /new .*Planner|create.*Planner/);
});
test("production review/evaluation/repair remains the existing closed loop and exposes HARD_CONSTRAINT_COMPLIANCE", () => {
  assert.match(studio, /executeReviewedProposal\(/);
  assert.match(studio, /evaluateEditorExecution\(/);
  assert.match(studio, /createRepairProposalBundle\(/);
  assert.match(studio, /executeReviewedRepairLoop\(/);
  assert.match(evaluationPanel, /HARD_CONSTRAINT_COMPLIANCE/);
});

test("legacy provider-style canonical action cannot bypass an active V2.3E ConstraintSet", () => {
  const fixture = createConstraintEnforcementFixture();
  assert.throws(() => applyAIEditingPlan({
    summary: "Provider asks to delete protected speech.",
    actions: [{ type: "REMOVE_CLIP", targetId: "clip-teacher", assetId: "", startSeconds: 0, endSeconds: 0, reason: "delete" }],
    unsupported: [], warnings: [],
  }, {
    project: fixture.project,
    ownedAssetIds: new Set(fixture.project.assets.map((asset) => asset.id)),
    audioSourceDurationMs: fixture.project.audioSelection.sourceDurationMs,
    constraintSet: fixture.constraintSet,
  }), ConstraintEnforcementBlockedError);
});
