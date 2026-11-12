import assert from "node:assert/strict";
import test from "node:test";
import {
  createEditorProjectFingerprint,
  createPlanEvidence,
  parsePlanEvidence,
  PlanEvidenceValidationError,
} from "./editor-plan-evidence.ts";
import { rankMultimodalCandidates, type MatchingInterval, type RankedCandidateSet } from "./editor-multimodal-matching.ts";
import { planNarrativeSequence } from "./editor-narrative-planner.ts";
import { compileNarrativeActionPlan } from "./editor-narrative-action-compiler.ts";
import { executeCompiledNarrativeActionPlan } from "./editor-compiled-plan-execution.ts";
import { cloneProject, parseEditorProject, type EditorProject } from "./editor-core.ts";
import { createCampusNegotiationProject } from "./test-support/editor-constraint-negotiation-fixture.ts";

type Row = { id: string; concept: string; assetId: string; action?: string; alternatives?: string[] };
const beforeAt = "2026-10-24T00:00:00.000Z";
const afterAt = "2026-10-24T00:01:00.000Z";

function build(rows: readonly Row[], options: { noOp?: boolean; failed?: boolean } = {}) {
  const intervals: MatchingInterval[] = rows.map((row, index) => ({ id: row.id, timelineStartMs: index * 2_000, timelineEndMs: (index + 1) * 2_000, text: `Caption ${row.id}`, concepts: [row.concept] }));
  const semanticEvidence: Record<string, unknown>[] = [];
  const rankedCandidateSets: RankedCandidateSet[] = rows.map((row, index) => {
    const assets = [row.assetId, ...(row.alternatives ?? [])].map((assetId) => {
      const segment = { id: `${row.id}-${assetId}-segment`, assetId, startMs: 0, endMs: 2_000, summary: `${row.concept} evidence`, concepts: [row.concept], ...(row.action ? { action: row.action } : {}), usability: 0.9, confidence: 0.95, evidenceFrameMs: [500, 1_500] };
      semanticEvidence.push(segment);
      return { assetId, sourceDurationMs: 4_000, semanticSegments: [segment] };
    });
    return rankMultimodalCandidates({ interval: intervals[index], assets });
  });
  const narrativePlan = planNarrativeSequence({ intervals, rankedCandidateSets, semanticEvidence });
  const sourceAssetIds = rows.map((_, index) => options.noOp ? rows[index].assetId : `seed-${index}`);
  const allAssets = [...new Set([...sourceAssetIds, ...rows.flatMap((row) => [row.assetId, ...(row.alternatives ?? [])])])];
  const project: EditorProject = {
    schemaVersion: 2, id: "project-evidence", title: "Fixture", updatedAt: beforeAt, durationMs: rows.length * 2_000, ratio: "16:9",
    audioSelection: { mode: "range", sourceDurationMs: rows.length * 2_000 + 1_000, sourceInMs: 0, sourceOutMs: rows.length * 2_000, selectedDurationMs: rows.length * 2_000 },
    assets: allAssets.map((id) => ({ id, name: id, kind: "视频", durationMs: 4_000 })),
    tracks: [{ id: "track-main", type: "video", name: "Video", muted: false, locked: false, clips: rows.map((_, index) => ({
      id: `clip-${index}`, assetId: sourceAssetIds[index], name: sourceAssetIds[index], kind: "视频", trackId: "track-main",
      timelineStartMs: index * 2_000, timelineEndMs: (index + 1) * 2_000, sourceInMs: 0, sourceOutMs: 2_000,
      transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" }, speedCurve: [{ id: "s0", at: 0, rate: 1 }, { id: "s1", at: 1, rate: 1 }],
    })) }], captions: [{ id: "caption", text: "fixed caption", startMs: 0, endMs: 1_000 }],
  };
  const context = { mode: "INITIAL_PLAN" as const, narrativePlan, seedSlots: rows.map((row, index) => ({ order: index, intervalId: row.id, clipId: `clip-${index}`, timelineStartMs: index * 2_000, timelineEndMs: (index + 1) * 2_000, currentAssetId: sourceAssetIds[index] })), project, ownedAssetIds: allAssets };
  const compiledPlan = compileNarrativeActionPlan(context);
  const executionInput = { preExecutionProject: project, compiledPlan, ownedAssetIds: allAssets, expectedProjectId: options.failed ? "wrong-project" : project.id, expectedProjectUpdatedAt: project.updatedAt, executionUpdatedAt: afterAt };
  const execution = executeCompiledNarrativeActionPlan(executionInput);
  return { intervals, rankedCandidateSets, narrativePlan, compiledPlan, execution, evidence: createPlanEvidence({ intervals, rankedCandidateSets, narrativePlan, compiledPlan, execution }) };
}

const medicalRows: Row[] = [
  { id: "consultation", concept: "doctor", assetId: "asset-consultation", action: "consultation" },
  { id: "anatomy", concept: "heart", assetId: "asset-anatomy", action: "explanation" },
  { id: "ecg", concept: "ecg", assetId: "asset-ecg", action: "examination" },
  { id: "treatment", concept: "medication", assetId: "asset-treatment", action: "treatment" },
  { id: "recovery", concept: "walking person", assetId: "asset-recovery", action: "recovery" },
];

test("restored project fingerprints are invariant across production and JSON clones", () => {
  const restored = parseEditorProject(JSON.stringify(createCampusNegotiationProject()));
  assert.ok(restored);
  const fingerprint = createEditorProjectFingerprint(restored);
  assert.equal(createEditorProjectFingerprint(cloneProject(restored)), fingerprint);
  assert.equal(createEditorProjectFingerprint(JSON.parse(JSON.stringify(restored)) as EditorProject), fingerprint);

  const materiallyChanged = cloneProject(restored);
  materiallyChanged.captions[0].text = `${materiallyChanged.captions[0].text} changed`;
  assert.notEqual(createEditorProjectFingerprint(materiallyChanged), fingerprint);
});

test("A/F/G/H/I/J/K/L/M/O: applied evidence retains matching, narrative, alternatives, changes, preservation and stable IDs", () => {
  const result = build([{ id: "consultation", concept: "doctor", assetId: "asset-doctor", action: "consultation", alternatives: ["asset-alt"] }]);
  const entry = result.evidence.entries[0];
  assert.equal(entry.status, "APPLIED");
  assert.equal(entry.matching?.semanticScore, result.narrativePlan.intervalPlans[0].status === "resolved" ? result.narrativePlan.intervalPlans[0].matchEvidence.semanticScore : -1);
  assert.ok(entry.matching?.rejectedAlternatives.some((item) => item.assetId !== entry.selectedAssetId));
  assert.deepEqual(entry.beforeAfter && [entry.beforeAfter.assetBefore, entry.beforeAfter.assetAfter], ["seed-0", entry.selectedAssetId]);
  assert.equal(result.evidence.preservation?.captionsUnchanged, true);
  assert.equal(result.evidence.summary.execution?.fingerprint, result.execution.executionFingerprint);
  assert.equal(result.evidence.summary.preProjectReference.startsWith("project-v1-"), true);
  assert.equal(result.evidence.entries[0].id, build([{ id: "consultation", concept: "doctor", assetId: "asset-doctor", action: "consultation", alternatives: ["asset-alt"] }]).evidence.entries[0].id);
  assert.deepEqual(result.evidence, build([{ id: "consultation", concept: "doctor", assetId: "asset-doctor", action: "consultation", alternatives: ["asset-alt"] }]).evidence);
  assert.equal(result.evidence.entries[0].explanation, "素材支持「doctor」。");
});

test("B: five-step medical demo yields five selected entries, mappings and results", () => {
  const result = build(medicalRows);
  assert.equal(result.evidence.entries.length, 5);
  assert.equal(result.evidence.entries.filter((entry) => entry.selectedAssetId).length, 5);
  assert.equal(result.compiledPlan.intervalActionMap.filter((item) => item.status === "COMPILED").length, 5);
  assert.equal(result.execution.actionResults.length, 5);
  assert.ok(result.evidence.entries.every((entry) => entry.matching && entry.narrative && entry.beforeAfter));
});

test("C: no-op evidence shows identical before and after", () => {
  const result = build([{ id: "same", concept: "doctor", assetId: "asset-same" }], { noOp: true });
  assert.equal(result.evidence.entries[0].status, "NO_OP");
  assert.equal(result.evidence.entries[0].beforeAfter?.assetBefore, result.evidence.entries[0].beforeAfter?.assetAfter);
});

test("D: unresolved interval is explicit and has no selected asset", () => {
  const intervals: MatchingInterval[] = [{ id: "unknown", timelineStartMs: 0, timelineEndMs: 2_000, text: "unknown", concepts: ["unknown"] }];
  const rankedCandidateSets = [rankMultimodalCandidates({ interval: intervals[0], assets: [] })];
  const narrativePlan = planNarrativeSequence({ intervals, rankedCandidateSets, semanticEvidence: [] });
  const project = build([{ id: "placeholder", concept: "doctor", assetId: "asset-doctor" }]).execution.preProject;
  const seedSlots = [{ order: 0, intervalId: "unknown", clipId: "clip-0", timelineStartMs: 0, timelineEndMs: 2_000, currentAssetId: "seed-0" }];
  const compiledPlan = compileNarrativeActionPlan({ mode: "INITIAL_PLAN", narrativePlan, seedSlots, project, ownedAssetIds: ["asset-doctor"] });
  const execution = executeCompiledNarrativeActionPlan({ preExecutionProject: project, compiledPlan, ownedAssetIds: ["asset-doctor"], expectedProjectId: project.id, expectedProjectUpdatedAt: project.updatedAt, executionUpdatedAt: afterAt });
  const evidence = createPlanEvidence({ intervals, rankedCandidateSets, narrativePlan, compiledPlan, execution });
  assert.equal(evidence.entries[0].status, "UNRESOLVED");
  assert.equal(evidence.entries[0].selectedAssetId, undefined);
  assert.match(evidence.entries[0].explanation, /没有找到足够可信的素材/);
});

test("E: failed execution is retained with failure code and unchanged target", () => {
  const evidence = build([{ id: "consultation", concept: "doctor", assetId: "asset-doctor" }], { failed: true }).evidence;
  assert.equal(evidence.lifecycleStatus, "EXECUTION_FAILED");
  assert.equal(evidence.entries[0].status, "FAILED");
  assert.equal(evidence.entries[0].failureCode, "PROJECT_IDENTITY_MISMATCH");
  assert.equal(evidence.entries[0].beforeAfter?.assetBefore, evidence.entries[0].beforeAfter?.assetAfter);
});

test("N: malformed evidence is rejected", () => {
  assert.throws(() => parsePlanEvidence({ schemaVersion: 1, planId: "x", entries: [{ id: "dup", status: "APPLIED", explanation: "ok" }, { id: "dup", status: "APPLIED", explanation: "ok" }], summary: {}, preservation: {} }), PlanEvidenceValidationError);
  assert.throws(() => createPlanEvidence(null), PlanEvidenceValidationError);
});

test("P: pre-execution evidence is pending review and contains no fabricated execution state", () => {
  const result = build([{ id: "consultation", concept: "doctor", assetId: "asset-doctor", alternatives: ["asset-alt"] }]);
  const pending = createPlanEvidence({
    intervals: result.intervals,
    rankedCandidateSets: result.rankedCandidateSets,
    narrativePlan: result.narrativePlan,
    compiledPlan: result.compiledPlan,
    preExecutionProject: result.execution.preProject,
  });
  assert.equal(pending.lifecycleStatus, "PENDING_REVIEW");
  assert.equal(pending.summary.execution, undefined);
  assert.equal(pending.preservation, undefined);
  assert.equal(pending.entries[0].status, "PENDING_REVIEW");
  assert.equal(pending.entries[0].actionResultStatus, undefined);
  assert.equal(pending.entries[0].failureCode, undefined);
  assert.equal(pending.entries[0].beforeAfter, undefined);
  assert.deepEqual(
    [pending.entries[0].currentProposed?.currentAssetId, pending.entries[0].currentProposed?.proposedAssetId],
    ["seed-0", pending.entries[0].selectedAssetId],
  );
  assert.equal(parsePlanEvidence(pending), pending);
});

test("Q: pending evidence parser rejects fabricated execution claims", () => {
  const result = build([{ id: "consultation", concept: "doctor", assetId: "asset-doctor" }]);
  const pending = createPlanEvidence({
    intervals: result.intervals,
    rankedCandidateSets: result.rankedCandidateSets,
    narrativePlan: result.narrativePlan,
    compiledPlan: result.compiledPlan,
    preExecutionProject: result.execution.preProject,
  });
  assert.throws(() => parsePlanEvidence({
    ...pending,
    entries: [{ ...pending.entries[0], status: "APPLIED" }],
  }), PlanEvidenceValidationError);
  assert.throws(() => parsePlanEvidence({
    ...pending,
    entries: [{
      ...pending.entries[0],
      humanReview: { decision: "ACCEPTED", provenance: "USER_ACCEPTED" },
      executedAction: { actionIndex: 0, actionType: "MATCH_ASSET_TO_SEGMENT", targetId: "clip-0", assetId: "asset-doctor", reason: "fabricated" },
      executionDisposition: "EXECUTED",
    }],
  }), PlanEvidenceValidationError);
});
