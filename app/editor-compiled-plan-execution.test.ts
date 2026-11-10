import assert from "node:assert/strict";
import test from "node:test";
import {
  CompiledPlanExecutionAbort,
  CompiledPlanExecutionInputError,
  executeCompiledNarrativeActionPlan,
  parseCompiledPlanExecutionInput,
} from "./editor-compiled-plan-execution.ts";
import { compileNarrativeActionPlan } from "./editor-narrative-action-compiler.ts";
import { applyAIEditingPlan } from "./editor-ai-requirements.ts";
import type { EditorProject } from "./editor-core.ts";
import { rankMultimodalCandidates } from "./editor-multimodal-matching.ts";
import { planNarrativeSequence, type NarrativeSequencePlan } from "./editor-narrative-planner.ts";

type Row = {
  id: string;
  concept: string;
  assetId: string;
  action?: string;
};

const BEFORE = "2026-10-24T00:00:00.000Z";
const AFTER = "2026-10-24T00:01:00.000Z";

function narrativeFixture(rows: readonly Row[]): NarrativeSequencePlan {
  const semanticEvidence: Record<string, unknown>[] = [];
  const intervals = rows.map((row, index) => ({
    id: row.id,
    timelineStartMs: index * 2_000,
    timelineEndMs: (index + 1) * 2_000,
    text: `Caption ${row.id}`,
    concepts: [row.concept],
  }));
  const rankedCandidateSets = rows.map((row, index) => {
    const segment = {
      id: `${row.id}-${row.assetId}-segment`,
      assetId: row.assetId,
      startMs: 0,
      endMs: 2_000,
      summary: `${row.concept} evidence`,
      concepts: [row.concept],
      ...(row.action ? { action: row.action } : {}),
      usability: 0.9,
      confidence: 0.95,
      evidenceFrameMs: [500, 1_500],
    };
    semanticEvidence.push(segment);
    return rankMultimodalCandidates({
      interval: intervals[index],
      assets: [{ assetId: row.assetId, sourceDurationMs: 4_000, semanticSegments: [segment] }],
    });
  });
  return planNarrativeSequence({ intervals, rankedCandidateSets, semanticEvidence });
}

function compilerContext(rows: readonly Row[]) {
  const plan = narrativeFixture(rows);
  const seedAssetIds = rows.map((_, index) => `seed-asset-${index + 1}`);
  const selectedAssetIds = rows.map((row) => row.assetId);
  const assetIds = [...new Set([...seedAssetIds, ...selectedAssetIds])];
  const durationMs = Math.max(2_000, rows.length * 2_000);
  const project: EditorProject = {
    schemaVersion: 2,
    id: "project-execution",
    title: "Protected demo project",
    updatedAt: BEFORE,
    durationMs,
    ratio: "16:9",
    audioSelection: {
      mode: "range",
      sourceDurationMs: durationMs + 1_000,
      sourceInMs: 250,
      sourceOutMs: durationMs + 250,
      selectedDurationMs: durationMs,
    },
    assets: assetIds.map((id) => ({ id, name: `Name ${id}`, kind: "视频", durationMs: 4_000 })),
    tracks: [{
      id: "video-main",
      type: "video",
      name: "Video",
      muted: false,
      locked: false,
      clips: rows.map((_, index) => ({
        id: `seed-clip-${index + 1}`,
        assetId: seedAssetIds[index],
        name: `Name ${seedAssetIds[index]}`,
        kind: "视频",
        trackId: "video-main",
        timelineStartMs: index * 2_000,
        timelineEndMs: (index + 1) * 2_000,
        sourceInMs: 0,
        sourceOutMs: 2_000,
        transform: { x: index, y: index === 0 ? 0 : -index, scale: 1, crop: 0, fit: "cover" },
        speedCurve: [{ id: "speed-start", at: 0, rate: 1 }, { id: "speed-end", at: 1, rate: 1 }],
      })),
    }],
    captions: [{ id: "caption-1", text: "Chest pain", startMs: 0, endMs: 1_000 }],
  };
  return {
    mode: "INITIAL_PLAN" as const,
    narrativePlan: plan,
    seedSlots: rows.map((row, index) => ({
      order: index,
      intervalId: row.id,
      clipId: `seed-clip-${index + 1}`,
      timelineStartMs: index * 2_000,
      timelineEndMs: (index + 1) * 2_000,
      currentAssetId: seedAssetIds[index],
    })),
    project,
    ownedAssetIds: assetIds,
  };
}

function executionFixture(rows: readonly Row[]) {
  const context = compilerContext(rows);
  const compiledPlan = compileNarrativeActionPlan(context);
  return {
    preExecutionProject: context.project,
    compiledPlan,
    ownedAssetIds: context.ownedAssetIds,
    expectedProjectId: context.project.id,
    expectedProjectUpdatedAt: context.project.updatedAt,
    executionUpdatedAt: AFTER,
  };
}

function medicalRows(): Row[] {
  return [
    { id: "consultation", concept: "doctor", assetId: "asset-consultation", action: "consultation" },
    { id: "anatomy", concept: "heart", assetId: "asset-anatomy", action: "explanation" },
    { id: "ecg", concept: "ecg", assetId: "asset-ecg", action: "examination" },
    { id: "treatment", concept: "medication", assetId: "asset-treatment", action: "treatment" },
    { id: "recovery", concept: "walking person", assetId: "asset-recovery", action: "recovery" },
  ];
}

test("A: one compiled assignment applies through the normal action pipeline", () => {
  const input = executionFixture([{ id: "consultation", concept: "doctor", assetId: "asset-doctor" }]);
  const before = structuredClone(input.preExecutionProject);
  const result = executeCompiledNarrativeActionPlan(input);
  assert.equal(result.status, "APPLIED");
  assert.equal(result.appliedActionCount, 1);
  assert.equal(result.postProject.tracks[0].clips[0].assetId, "asset-doctor");
  assert.equal(result.postProject.updatedAt, AFTER);
  assert.deepEqual(input.preExecutionProject, before);
  assert.equal(result.historyBoundary.shouldRecordPlanUndo, true);
});

test("B: controlled five-step medical demo applies five trusted assignments", () => {
  const result = executeCompiledNarrativeActionPlan(executionFixture(medicalRows()));
  assert.equal(result.status, "APPLIED");
  assert.equal(result.appliedActionCount, 5);
  assert.deepEqual(
    result.postProject.tracks[0].clips.map((clip) => clip.assetId),
    ["asset-consultation", "asset-anatomy", "asset-ecg", "asset-treatment", "asset-recovery"],
  );
  assert.equal(result.preservation.protectedFieldsPreserved, true);
});

test("C: compiler no-action assignment is a true no-op without updatedAt or history change", () => {
  const input = executionFixture([{ id: "same", concept: "doctor", assetId: "asset-same" }]);
  const mutable = structuredClone(input);
  mutable.preExecutionProject.tracks[0].clips[0].assetId = "asset-same";
  mutable.preExecutionProject.tracks[0].clips[0].name = "Name asset-same";
  const context = compilerContext([{ id: "same", concept: "doctor", assetId: "asset-same" }]);
  context.project = mutable.preExecutionProject;
  context.seedSlots[0].currentAssetId = "asset-same";
  const noOpInput = {
    ...mutable,
    compiledPlan: compileNarrativeActionPlan(context),
    ownedAssetIds: [...new Set(context.ownedAssetIds)],
  };
  const result = executeCompiledNarrativeActionPlan(noOpInput);
  assert.equal(noOpInput.compiledPlan.canonicalPlan.actions.length, 0);
  assert.equal(result.status, "NO_OP");
  assert.equal(result.postProject.updatedAt, BEFORE);
  assert.equal(result.historyBoundary.shouldRecordPlanUndo, false);
});

test("D: unknown target fails atomically through canonical validation", () => {
  const input = structuredClone(executionFixture([{ id: "i1", concept: "doctor", assetId: "asset-a" }]));
  input.compiledPlan.canonicalPlan.actions[0].targetId = "missing-clip";
  (input.compiledPlan.intervalActionMap[0] as { targetClipId?: string }).targetClipId = "missing-clip";
  const result = executeCompiledNarrativeActionPlan(input);
  assert.equal(result.status, "FAILED");
  assert.equal(result.failureCode, "CANONICAL_APPLY_REJECTED");
  assert.deepEqual(result.postProject, result.preProject);
});

test("E: unknown asset fails atomically through canonical validation", () => {
  const input = structuredClone(executionFixture([{ id: "i1", concept: "doctor", assetId: "asset-a" }]));
  input.compiledPlan.canonicalPlan.actions[0].assetId = "missing-asset";
  (input.compiledPlan.intervalActionMap[0] as { selectedAssetId?: string }).selectedAssetId = "missing-asset";
  input.ownedAssetIds.push("missing-asset");
  const result = executeCompiledNarrativeActionPlan(input);
  assert.equal(result.status, "FAILED");
  assert.equal(result.failureCode, "CANONICAL_APPLY_REJECTED");
  assert.deepEqual(result.postProject, result.preProject);
});

test("F: simulated mid-batch failure rolls back the isolated working copy", () => {
  const input = executionFixture(medicalRows().slice(0, 3));
  const original = structuredClone(input.preExecutionProject);
  const result = executeCompiledNarrativeActionPlan(input, {
    applyPlan: (_plan, context) => {
      context.project.tracks[0].clips[0].assetId = "partially-mutated-working-copy";
      throw new CompiledPlanExecutionAbort("ACTION_APPLICATION_FAILED", "simulated", 1);
    },
  });
  assert.equal(result.status, "FAILED");
  assert.equal(result.failedActionIndex, 1);
  assert.deepEqual(result.actionResults.map((item) => item.status), ["ROLLED_BACK", "FAILED", "NOT_RUN"]);
  assert.deepEqual(result.postProject, original);
  assert.deepEqual(input.preExecutionProject, original);
});

test("G: duplicate target batch is rejected before application", () => {
  const input = structuredClone(executionFixture(medicalRows().slice(0, 2)));
  input.compiledPlan.canonicalPlan.actions[1].targetId = input.compiledPlan.canonicalPlan.actions[0].targetId;
  (input.compiledPlan.intervalActionMap[1] as { targetClipId?: string }).targetClipId = input.compiledPlan.intervalActionMap[0].targetClipId;
  const result = executeCompiledNarrativeActionPlan(input);
  assert.equal(result.status, "FAILED");
  assert.equal(result.failureCode, "CONFLICTING_BATCH");
});

test("H: pre and post snapshots are independent immutable structures", () => {
  const input = executionFixture([{ id: "i1", concept: "doctor", assetId: "asset-a" }]);
  const result = executeCompiledNarrativeActionPlan(input);
  assert.notEqual(result.preProject, input.preExecutionProject);
  assert.notEqual(result.preProject, result.postProject);
  assert.notEqual(result.preProject.tracks, result.postProject.tracks);
  assert.equal(Object.isFrozen(result.preProject.tracks[0].clips[0].transform), true);
  assert.throws(() => { (result.preProject as { title: string }).title = "mutated"; }, TypeError);
});

test("I: captions, audio, assets, tracks, transforms, and unrelated clips are preserved", () => {
  const result = executeCompiledNarrativeActionPlan(executionFixture(medicalRows().slice(0, 2)));
  assert.equal(result.preservation.captionsPreserved, true);
  assert.equal(result.preservation.audioSelectionPreserved, true);
  assert.equal(result.preservation.assetRegistryPreserved, true);
  assert.equal(result.preservation.trackIdentityAndOrderPreserved, true);
  assert.equal(result.preservation.targetTimelineAndTransformPreserved, true);
  assert.equal(result.preservation.unrelatedClipsPreserved, true);
  assert.deepEqual(result.preservation.unexpectedChanges, []);
});

test("J: identical input produces a structurally identical execution result", () => {
  const input = executionFixture(medicalRows().slice(0, 2));
  const first = executeCompiledNarrativeActionPlan(input);
  const second = executeCompiledNarrativeActionPlan(structuredClone(input));
  assert.deepEqual(second, first);
  assert.equal(first.executionFingerprint, second.executionFingerprint);
});

test("K: action result evidence keeps action, target, interval, asset, and status", () => {
  const result = executeCompiledNarrativeActionPlan(executionFixture([
    { id: "consultation", concept: "doctor", assetId: "asset-doctor" },
  ]));
  assert.deepEqual(result.actionResults, [{
    actionIndex: 0,
    actionType: "MATCH_ASSET_TO_SEGMENT",
    targetId: "seed-clip-1",
    intervalId: "consultation",
    selectedAssetId: "asset-doctor",
    status: "APPLIED",
  }]);
});

test("L: intent-action mapping is retained without copying evidence into reason", () => {
  const input = executionFixture([{ id: "i1", concept: "doctor", assetId: "asset-a" }]);
  const result = executeCompiledNarrativeActionPlan(input);
  assert.deepEqual(result.intentActionMap, input.compiledPlan.intervalActionMap);
  assert.equal(result.intentActionMap[0].matchingEvidenceReference?.startsWith("match-evidence-v1-"), true);
  assert.match(result.postProject.tracks[0].clips[0].reason ?? "", /trusted narrative interval i1/);
});

test("M: applied updatedAt follows normal pipeline while compiler no-op preserves it", () => {
  const applied = executeCompiledNarrativeActionPlan(executionFixture([
    { id: "i1", concept: "doctor", assetId: "asset-a" },
  ]));
  assert.equal(applied.postProject.updatedAt, AFTER);
  assert.equal(applied.preProject.updatedAt, BEFORE);
  const staleInput = { ...executionFixture([{ id: "i1", concept: "doctor", assetId: "asset-a" }]), expectedProjectUpdatedAt: AFTER };
  const stale = executeCompiledNarrativeActionPlan(staleInput);
  assert.equal(stale.failureCode, "PROJECT_VERSION_MISMATCH");
  assert.equal(stale.postProject.updatedAt, BEFORE);
});

test("N: rollback snapshot remains complete after a canonical application failure", () => {
  const input = executionFixture(medicalRows().slice(0, 2));
  const original = structuredClone(input.preExecutionProject);
  const result = executeCompiledNarrativeActionPlan(input, {
    applyPlan: (plan, context) => {
      const firstOnly = structuredClone(plan) as { actions: unknown[] };
      firstOnly.actions = firstOnly.actions.slice(0, 1);
      applyAIEditingPlan(firstOnly, context);
      throw new CompiledPlanExecutionAbort("ACTION_APPLICATION_FAILED", "abort", 1);
    },
  });
  assert.deepEqual(result.preProject, original);
  assert.deepEqual(result.postProject, original);
  assert.notEqual(result.preProject, result.postProject);
  assert.equal(Object.isFrozen(result.preProject), true);
  assert.equal(result.historyBoundary.shouldRecordPlanUndo, false);
});

test("O: malformed execution input and unknown fields are rejected strictly", () => {
  const input = executionFixture([{ id: "i1", concept: "doctor", assetId: "asset-a" }]);
  assert.throws(() => parseCompiledPlanExecutionInput(null), CompiledPlanExecutionInputError);
  assert.throws(
    () => executeCompiledNarrativeActionPlan({ ...input, rawActions: [] }),
    CompiledPlanExecutionInputError,
  );
  const malformedCompiled = structuredClone(input) as unknown as Record<string, unknown> & {
    compiledPlan: Record<string, unknown>;
  };
  malformedCompiled.compiledPlan = {};
  const failed = executeCompiledNarrativeActionPlan(malformedCompiled);
  assert.equal(failed.failureCode, "COMPILED_PLAN_VALIDATION_BREACH");
});

test("validated-plan assumption breaches and preservation breaches fail closed", () => {
  const malformed = structuredClone(executionFixture([{ id: "i1", concept: "doctor", assetId: "asset-a" }]));
  (malformed.compiledPlan.canonicalValidation as { valid: boolean }).valid = false;
  const invalid = executeCompiledNarrativeActionPlan(malformed);
  assert.equal(invalid.failureCode, "COMPILED_PLAN_VALIDATION_BREACH");

  const input = executionFixture([{ id: "i1", concept: "doctor", assetId: "asset-a" }]);
  const breached = executeCompiledNarrativeActionPlan(input, {
    applyPlan: (plan, context) => {
      const applied = applyAIEditingPlan(plan, context);
      const project = structuredClone(applied.project);
      project.captions[0].text = "unexpected";
      return { ...applied, project };
    },
  });
  assert.equal(breached.status, "FAILED");
  assert.equal(breached.failureCode, "PRESERVATION_CONTRACT_BREACH");
  assert.deepEqual(breached.preservation.unexpectedChanges, ["project:captions"]);
  assert.deepEqual(breached.postProject, breached.preProject);
});
