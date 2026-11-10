import assert from "node:assert/strict";
import test from "node:test";
import {
  NarrativeActionCompilerValidationError,
  compileNarrativeActionPlan,
  parseNarrativeActionCompilerContext,
} from "./editor-narrative-action-compiler.ts";
import { parseAIEditingPlan } from "./editor-ai-requirements.ts";
import type { EditorProject } from "./editor-core.ts";
import { rankMultimodalCandidates } from "./editor-multimodal-matching.ts";
import { planNarrativeSequence, type NarrativeSequencePlan } from "./editor-narrative-planner.ts";

type CandidateFixture = {
  assetId: string;
  confidence?: number;
  action?: string;
  concepts?: string[];
  sourceStartMs?: number;
};

type IntervalFixture = {
  id: string;
  concept: string;
  candidates: CandidateFixture[];
};

function narrativeFixture(rows: IntervalFixture[]): NarrativeSequencePlan {
  const semanticEvidence: Record<string, unknown>[] = [];
  const intervals = rows.map((row, index) => ({
    id: row.id,
    timelineStartMs: index * 2_000,
    timelineEndMs: (index + 1) * 2_000,
    text: `Caption ${row.id}`,
    concepts: [row.concept],
  }));
  const rankedCandidateSets = rows.map((row, index) => {
    const assets = row.candidates.map((candidate) => {
      const sourceStartMs = candidate.sourceStartMs ?? 0;
      const segment = {
        id: `${row.id}-${candidate.assetId}-segment`,
        assetId: candidate.assetId,
        startMs: sourceStartMs,
        endMs: sourceStartMs + 2_000,
        summary: `${row.concept} evidence`,
        concepts: [row.concept, ...(candidate.concepts ?? [])],
        ...(candidate.action === undefined ? {} : { action: candidate.action }),
        usability: 0.8,
        confidence: candidate.confidence ?? 0.9,
        evidenceFrameMs: [sourceStartMs + 500, sourceStartMs + 1_500],
      };
      semanticEvidence.push(segment);
      return {
        assetId: candidate.assetId,
        sourceDurationMs: sourceStartMs + 4_000,
        semanticSegments: [segment],
      };
    });
    return rankMultimodalCandidates({ interval: intervals[index], assets });
  });
  return planNarrativeSequence({ intervals, rankedCandidateSets, semanticEvidence });
}

function compilerFixture(plan: NarrativeSequencePlan) {
  const resolvedAssetIds = plan.intervalPlans
    .filter((item) => item.status === "resolved")
    .map((item) => item.assetId);
  const assetIds = [...new Set([
    ...plan.intervalPlans.map((_, index) => `seed-asset-${index + 1}`),
    ...resolvedAssetIds,
  ])];
  const seedSlots = plan.intervalPlans.map((item, index) => ({
    order: index,
    intervalId: item.intervalId,
    clipId: `seed-clip-${index + 1}`,
    timelineStartMs: index * 2_000,
    timelineEndMs: (index + 1) * 2_000,
    currentAssetId: `seed-asset-${index + 1}`,
  }));
  const durationMs = Math.max(1_000, plan.intervalPlans.length * 2_000);
  const project: EditorProject = {
    schemaVersion: 2,
    id: "project-seed",
    title: "Deterministic seed project",
    updatedAt: "2026-01-01T00:00:00.000Z",
    durationMs,
    ratio: "16:9",
    audioSelection: {
      mode: "full",
      sourceDurationMs: durationMs,
      sourceInMs: 0,
      sourceOutMs: durationMs,
      selectedDurationMs: durationMs,
    },
    assets: assetIds.map((id) => ({ id, name: id, kind: "视频", durationMs: 6_000 })),
    tracks: [{
      id: "video-main",
      type: "video",
      name: "Video",
      clips: seedSlots.map((slot) => ({
        id: slot.clipId,
        assetId: slot.currentAssetId,
        name: slot.currentAssetId,
        kind: "视频",
        trackId: "video-main",
        timelineStartMs: slot.timelineStartMs,
        timelineEndMs: slot.timelineEndMs,
        sourceInMs: 0,
        sourceOutMs: 2_000,
        transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
        speedCurve: [{ id: "speed-start", at: 0, rate: 1 }, { id: "speed-end", at: 1, rate: 1 }],
      })),
    }],
    captions: [],
  };
  return {
    mode: "INITIAL_PLAN" as const,
    narrativePlan: plan,
    seedSlots,
    project,
    ownedAssetIds: assetIds,
  };
}

test("A: one resolved interval compiles to one exact asset assignment", () => {
  const input = compilerFixture(narrativeFixture([
    { id: "consultation", concept: "doctor", candidates: [{ assetId: "asset-doctor" }] },
  ]));
  const before = structuredClone(input.project);
  const compiled = compileNarrativeActionPlan(input);
  assert.equal(compiled.status, "VALIDATED");
  assert.deepEqual(compiled.canonicalPlan.actions, [{
    type: "MATCH_ASSET_TO_SEGMENT",
    targetId: "seed-clip-1",
    assetId: "asset-doctor",
    startSeconds: 0,
    endSeconds: 2,
    reason: "Matches trusted narrative interval consultation; semantic and narrative selection.",
  }]);
  assert.deepEqual(input.project, before);
});

test("B: multiple intervals compile in explicit seed-slot order", () => {
  const compiled = compileNarrativeActionPlan(compilerFixture(narrativeFixture([
    { id: "i1", concept: "doctor", candidates: [{ assetId: "asset-a" }] },
    { id: "i2", concept: "test", candidates: [{ assetId: "asset-b" }] },
    { id: "i3", concept: "medicine", candidates: [{ assetId: "asset-c" }] },
  ])));
  assert.deepEqual(compiled.canonicalPlan.actions.map((action) => action.targetId), [
    "seed-clip-1", "seed-clip-2", "seed-clip-3",
  ]);
  assert.deepEqual(compiled.canonicalPlan.actions.map((action) => action.assetId), ["asset-a", "asset-b", "asset-c"]);
});

test("C: any unresolved interval rejects the whole initial plan without partial actions", () => {
  const compiled = compileNarrativeActionPlan(compilerFixture(narrativeFixture([
    { id: "resolved", concept: "doctor", candidates: [{ assetId: "asset-a" }] },
    { id: "unresolved", concept: "test", candidates: [] },
  ])));
  assert.equal(compiled.status, "NOT_COMPILABLE");
  assert.deepEqual(compiled.canonicalPlan.actions, []);
  assert.deepEqual(compiled.unresolvedIntervalIds, ["unresolved"]);
  assert.equal(compiled.errors[0].code, "UNRESOLVED_INTERVAL");
  assert.deepEqual(compiled.intervalActionMap.map((link) => link.status), [
    "BLOCKED_BY_ATOMIC_POLICY",
    "UNRESOLVED",
  ]);
});

test("D: a resolved entry tampered below V2.0A thresholds cannot compile", () => {
  const input = compilerFixture(narrativeFixture([
    { id: "i1", concept: "doctor", candidates: [{ assetId: "asset-a" }] },
  ]));
  const tampered = structuredClone(input) as unknown as {
    narrativePlan: { intervalPlans: Array<{ semanticScore: number; matchEvidence: { semanticScore: number } }> };
  };
  tampered.narrativePlan.intervalPlans[0].semanticScore = 0.1;
  tampered.narrativePlan.intervalPlans[0].matchEvidence.semanticScore = 0.1;
  assert.throws(() => compileNarrativeActionPlan(tampered), NarrativeActionCompilerValidationError);
});

test("E: selected asset identity must exist in the trusted owned project context", () => {
  const input = compilerFixture(narrativeFixture([
    { id: "i1", concept: "doctor", candidates: [{ assetId: "asset-a" }] },
  ]));
  input.project.assets = input.project.assets.filter((asset) => asset.id !== "asset-a");
  input.ownedAssetIds = input.ownedAssetIds.filter((assetId) => assetId !== "asset-a");
  assert.throws(() => compileNarrativeActionPlan(input), NarrativeActionCompilerValidationError);
});

test("F: seed slot cannot guess an unknown clip ID", () => {
  const input = compilerFixture(narrativeFixture([
    { id: "i1", concept: "doctor", candidates: [{ assetId: "asset-a" }] },
  ]));
  input.seedSlots[0].clipId = "unknown-clip";
  assert.throws(() => compileNarrativeActionPlan(input), NarrativeActionCompilerValidationError);
});

test("G: ambiguous interval-to-slot mapping is rejected", () => {
  const input = compilerFixture(narrativeFixture([
    { id: "i1", concept: "doctor", candidates: [{ assetId: "asset-a" }] },
    { id: "i2", concept: "test", candidates: [{ assetId: "asset-b" }] },
  ]));
  input.seedSlots[1].intervalId = "i1";
  assert.throws(() => parseNarrativeActionCompilerContext(input), NarrativeActionCompilerValidationError);
});

test("H: non-zero semantic source placement is explicitly unsupported", () => {
  const compiled = compileNarrativeActionPlan(compilerFixture(narrativeFixture([
    { id: "i1", concept: "test", candidates: [{ assetId: "asset-late", sourceStartMs: 2_000 }] },
  ])));
  assert.equal(compiled.status, "NOT_COMPILABLE");
  assert.deepEqual(compiled.canonicalPlan.actions, []);
  assert.deepEqual(compiled.unsupportedIntervalIds, ["i1"]);
  assert.equal(compiled.errors[0].code, "SOURCE_RANGE_PLACEMENT_LIMITATION");
});

test("I: duplicate target mutation through two seed slots is rejected", () => {
  const input = compilerFixture(narrativeFixture([
    { id: "i1", concept: "doctor", candidates: [{ assetId: "asset-a" }] },
    { id: "i2", concept: "test", candidates: [{ assetId: "asset-b" }] },
  ]));
  input.seedSlots[1].clipId = input.seedSlots[0].clipId;
  input.seedSlots[1].currentAssetId = input.seedSlots[0].currentAssetId;
  input.seedSlots[1].timelineStartMs = input.seedSlots[0].timelineStartMs;
  input.seedSlots[1].timelineEndMs = input.seedSlots[0].timelineEndMs;
  assert.throws(() => compileNarrativeActionPlan(input), NarrativeActionCompilerValidationError);
});

test("J: action order is deterministic even when trusted asset IDs are lexically reversed", () => {
  const compiled = compileNarrativeActionPlan(compilerFixture(narrativeFixture([
    { id: "first", concept: "doctor", candidates: [{ assetId: "z-asset" }] },
    { id: "second", concept: "test", candidates: [{ assetId: "a-asset" }] },
  ])));
  assert.deepEqual(compiled.intervalActionMap.map((link) => link.intervalId), ["first", "second"]);
  assert.deepEqual(compiled.canonicalPlan.actions.map((action) => action.assetId), ["z-asset", "a-asset"]);
});

test("K: reason generation is concise, deterministic, and score-free", () => {
  const compiled = compileNarrativeActionPlan(compilerFixture(narrativeFixture([
    { id: "ecg", concept: "test", candidates: [{ assetId: "asset-ecg" }] },
  ])));
  const reason = compiled.canonicalPlan.actions[0].reason;
  assert.equal(reason, "Matches trusted narrative interval ecg; semantic and narrative selection.");
  assert.doesNotMatch(reason, /0\.\d+|provider|filename/i);
});

test("L: emitted batch is accepted unchanged by the existing canonical parser", () => {
  const compiled = compileNarrativeActionPlan(compilerFixture(narrativeFixture([
    { id: "i1", concept: "doctor", candidates: [{ assetId: "asset-a" }] },
    { id: "i2", concept: "test", candidates: [{ assetId: "asset-b" }] },
  ])));
  assert.deepEqual(parseAIEditingPlan(compiled.canonicalPlan), compiled.canonicalPlan);
  assert.equal(compiled.canonicalValidation.parser, "parseAIEditingPlan");
  assert.equal(compiled.canonicalValidation.valid, true);
});

test("M: malformed NarrativeSequencePlan and unknown compiler fields fail closed", () => {
  const valid = compilerFixture(narrativeFixture([
    { id: "i1", concept: "doctor", candidates: [{ assetId: "asset-a" }] },
  ]));
  const malformedPlan = structuredClone(valid) as Record<string, unknown>;
  (malformedPlan.narrativePlan as Record<string, unknown>).providerText = "untrusted";
  assert.throws(() => compileNarrativeActionPlan(malformedPlan), NarrativeActionCompilerValidationError);
  assert.throws(() => compileNarrativeActionPlan({ ...valid, extra: true }), NarrativeActionCompilerValidationError);
});

test("N: identical narrative, seed timeline, and project produce deeply equal output", () => {
  const input = compilerFixture(narrativeFixture([
    { id: "i1", concept: "doctor", candidates: [{ assetId: "asset-a" }] },
    { id: "i2", concept: "test", candidates: [{ assetId: "asset-b" }] },
  ]));
  assert.deepEqual(compileNarrativeActionPlan(input), compileNarrativeActionPlan(input));
});

test("O: controlled consultation-to-recovery narrative compiles to five canonical assignments", () => {
  const plan = narrativeFixture([
    { id: "consultation", concept: "doctor", candidates: [{ assetId: "clip-consult", action: "consultation", concepts: ["patient"] }] },
    { id: "explanation", concept: "anatomy", candidates: [{ assetId: "clip-heart", action: "explanation", concepts: ["heart"] }] },
    { id: "ecg", concept: "test", candidates: [{ assetId: "clip-ecg", action: "examination", concepts: ["patient"] }] },
    { id: "treatment", concept: "medicine", candidates: [{ assetId: "clip-treatment", action: "treatment", concepts: ["patient"] }] },
    { id: "recovery", concept: "exercise", candidates: [{ assetId: "clip-recovery", action: "recovery", concepts: ["patient"] }] },
  ]);
  const compiled = compileNarrativeActionPlan(compilerFixture(plan));
  assert.equal(compiled.status, "VALIDATED");
  assert.equal(compiled.canonicalPlan.actions.length, 5);
  assert.ok(compiled.canonicalPlan.actions.every((action) => action.type === "MATCH_ASSET_TO_SEGMENT"));
  assert.deepEqual(compiled.intervalActionMap.map((link) => link.status), Array(5).fill("COMPILED"));
});

test("already assigned seed assets emit no redundant canonical action", () => {
  const input = compilerFixture(narrativeFixture([
    { id: "i1", concept: "doctor", candidates: [{ assetId: "asset-a" }] },
  ]));
  input.seedSlots[0].currentAssetId = "asset-a";
  input.project.tracks[0].clips[0].assetId = "asset-a";
  const compiled = compileNarrativeActionPlan(input);
  assert.equal(compiled.status, "VALIDATED");
  assert.deepEqual(compiled.canonicalPlan.actions, []);
  assert.equal(compiled.intervalActionMap[0].status, "NO_ACTION_REQUIRED");
});

test("intent-to-action links retain target, semantic segments, and narrative reason codes", () => {
  const compiled = compileNarrativeActionPlan(compilerFixture(narrativeFixture([
    { id: "visit", concept: "doctor", candidates: [{ assetId: "asset-a", action: "consultation", concepts: ["patient"] }] },
    { id: "exam", concept: "test", candidates: [{ assetId: "asset-b", action: "examination", concepts: ["patient"] }] },
  ])));
  const link = compiled.intervalActionMap[1];
  assert.equal(link.actionIndex, 1);
  assert.equal(link.targetClipId, "seed-clip-2");
  assert.equal(link.selectedAssetId, "asset-b");
  assert.deepEqual(link.supportingSegmentIds, ["exam-asset-b-segment"]);
  assert.ok(link.matchingEvidenceReference?.startsWith("match-evidence-v1-"));
  assert.ok(link.narrativeReasonCodes.includes("ACTION_PROGRESSION_SUPPORTED"));
});
