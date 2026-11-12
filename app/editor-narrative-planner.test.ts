import assert from "node:assert/strict";
import test from "node:test";
import {
  NARRATIVE_PLANNER_LIMITS,
  NARRATIVE_SCORE_MODEL,
  NarrativePlanningValidationError,
  parseNarrativePlanningContext,
  planNarrativeSequence,
} from "./editor-narrative-planner.ts";
import { rankMultimodalCandidates } from "./editor-multimodal-matching.ts";

type CandidateFixture = {
  assetId: string;
  confidence?: number;
  usability?: number;
  concepts?: string[];
  action?: string;
};

type IntervalFixture = {
  id: string;
  concept: string;
  candidates: CandidateFixture[];
};

function buildFixture(rows: IntervalFixture[], actionProgressionHints?: string[]) {
  const semanticEvidence: Record<string, unknown>[] = [];
  const intervals = rows.map((row, index) => ({
    id: row.id,
    timelineStartMs: index * 2_000,
    timelineEndMs: (index + 1) * 2_000,
    text: `Caption for ${row.id}`,
    concepts: [row.concept],
  }));
  const rankedCandidateSets = rows.map((row, index) => {
    const assets = row.candidates.map((candidate) => {
      const segment = {
        id: `${row.id}-${candidate.assetId}-segment`,
        assetId: candidate.assetId,
        startMs: 0,
        endMs: 2_000,
        summary: `${row.concept} evidence`,
        concepts: [row.concept, ...(candidate.concepts ?? [])],
        ...(candidate.action === undefined ? {} : { action: candidate.action }),
        usability: candidate.usability ?? 0.8,
        confidence: candidate.confidence ?? 0.9,
        evidenceFrameMs: [500, 1_500],
      };
      semanticEvidence.push(segment);
      return {
        assetId: candidate.assetId,
        sourceDurationMs: 4_000,
        semanticSegments: [segment],
      };
    });
    return rankMultimodalCandidates({ interval: intervals[index], assets });
  });
  return {
    intervals,
    rankedCandidateSets,
    semanticEvidence,
    ...(actionProgressionHints === undefined ? {} : { actionProgressionHints }),
  };
}

function selectedAssets(plan: ReturnType<typeof planNarrativeSequence>): (string | null)[] {
  return plan.intervalPlans.map((item) => item.status === "resolved" ? item.assetId : null);
}

test("A: local winners already form a coherent sequence", () => {
  const input = buildFixture([
    { id: "i1", concept: "visit", candidates: [{ assetId: "consult", action: "consultation", concepts: ["patient"] }, { assetId: "other-1", confidence: 0.86 }] },
    { id: "i2", concept: "ecg", candidates: [{ assetId: "exam", action: "examination", concepts: ["patient"] }, { assetId: "other-2", confidence: 0.86 }] },
    { id: "i3", concept: "medicine", candidates: [{ assetId: "treat", action: "treatment", concepts: ["patient"] }, { assetId: "other-3", confidence: 0.86 }] },
  ]);
  const plan = planNarrativeSequence(input);
  assert.deepEqual(selectedAssets(plan), ["consult", "exam", "treat"]);
  assert.ok(plan.totalNarrativeScore > 0);
});

test("B: narrative evidence can change one near-tied local interval winner", () => {
  const input = buildFixture([
    { id: "i1", concept: "visit", candidates: [{ assetId: "consult", action: "consultation", concepts: ["patient"] }] },
    { id: "i2", concept: "ecg", candidates: [
      { assetId: "isolated", confidence: 0.91, action: "consultation", concepts: ["laboratory"] },
      { assetId: "exam", confidence: 0.9, action: "examination", concepts: ["patient"] },
    ] },
    { id: "i3", concept: "medicine", candidates: [{ assetId: "treat", action: "treatment", concepts: ["patient"] }] },
  ]);
  assert.equal(input.rankedCandidateSets[1].selectedAssetId, "isolated");
  assert.deepEqual(selectedAssets(planNarrativeSequence(input)), ["consult", "exam", "treat"]);
});

test("C: V2.0A semantic rejection cannot be overridden by narrative", () => {
  const input = buildFixture([
    { id: "i1", concept: "visit", candidates: [{ assetId: "consult", action: "consultation" }] },
    { id: "i2", concept: "ecg", candidates: [{ assetId: "perfect-action", confidence: 0.2, usability: 1, action: "examination" }] },
  ]);
  assert.equal(input.rankedCandidateSets[1].selectedAssetId, undefined);
  const plan = planNarrativeSequence(input);
  assert.deepEqual(selectedAssets(plan), ["consult", null]);
  assert.deepEqual(plan.unresolvedIntervalIds, ["i2"]);
});

test("D: shared non-identifying semantic labels prefer subject continuity", () => {
  const input = buildFixture([
    { id: "i1", concept: "opening", candidates: [{ assetId: "start", concepts: ["patient"] }] },
    { id: "i2", concept: "detail", candidates: [
      { assetId: "lab", confidence: 0.905, concepts: ["laboratory"] },
      { assetId: "patient-view", confidence: 0.9, concepts: ["patient"] },
    ] },
  ]);
  const plan = planNarrativeSequence(input);
  assert.deepEqual(selectedAssets(plan), ["start", "patient-view"]);
  const second = plan.intervalPlans[1];
  assert.equal(second.status, "resolved");
  assert.ok(second.status === "resolved" && second.transitionEvidence.some((item) =>
    item.code === "SUBJECT_CONTINUITY_PRESERVED" && item.sharedConcepts?.includes("patient")));
});

test("E: explicit action evidence prefers bounded forward progression", () => {
  const input = buildFixture([
    { id: "i1", concept: "visit", candidates: [{ assetId: "start", action: "consultation" }] },
    { id: "i2", concept: "ecg", candidates: [
      { assetId: "static", confidence: 0.905, action: "consultation" },
      { assetId: "exam", confidence: 0.9, action: "examination" },
    ] },
  ]);
  const plan = planNarrativeSequence(input);
  assert.deepEqual(selectedAssets(plan), ["start", "exam"]);
  const second = plan.intervalPlans[1];
  assert.ok(second.status === "resolved" && second.transitionEvidence.some((item) =>
    item.code === "ACTION_PROGRESSION_SUPPORTED"));
});

test("F: immediate repeated assets receive a sequence penalty", () => {
  const input = buildFixture([
    { id: "i1", concept: "a", candidates: [{ assetId: "asset-a" }] },
    { id: "i2", concept: "b", candidates: [
      { assetId: "asset-a", confidence: 0.91 },
      { assetId: "asset-b", confidence: 0.9 },
    ] },
  ]);
  assert.deepEqual(selectedAssets(planNarrativeSequence(input)), ["asset-a", "asset-b"]);
});

test("G: A-B-A oscillation is penalized independently of immediate repetition", () => {
  const input = buildFixture([
    { id: "i1", concept: "a", candidates: [{ assetId: "asset-a" }] },
    { id: "i2", concept: "b", candidates: [{ assetId: "asset-b" }] },
    { id: "i3", concept: "c", candidates: [
      { assetId: "asset-a", confidence: 0.91 },
      { assetId: "asset-c", confidence: 0.9 },
    ] },
  ]);
  assert.deepEqual(selectedAssets(planNarrativeSequence(input)), ["asset-a", "asset-b", "asset-c"]);
});

test("H: asset reuse remains allowed when it is the only acceptable evidence", () => {
  const input = buildFixture([
    { id: "i1", concept: "a", candidates: [{ assetId: "asset-a" }] },
    { id: "i2", concept: "b", candidates: [{ assetId: "asset-a" }] },
    { id: "i3", concept: "c", candidates: [{ assetId: "asset-a" }] },
  ]);
  const plan = planNarrativeSequence(input);
  assert.deepEqual(selectedAssets(plan), ["asset-a", "asset-a", "asset-a"]);
  assert.ok(plan.totalSequenceRepetitionPenalty > 0);
});

test("I: an unresolved interval remains explicit and breaks inferred adjacency", () => {
  const input = buildFixture([
    { id: "i1", concept: "a", candidates: [{ assetId: "asset-a" }] },
    { id: "i2", concept: "b", candidates: [] },
    { id: "i3", concept: "c", candidates: [{ assetId: "asset-a" }] },
  ]);
  const plan = planNarrativeSequence(input);
  assert.deepEqual(selectedAssets(plan), ["asset-a", null, "asset-a"]);
  assert.deepEqual(plan.unresolvedIntervalIds, ["i2"]);
  assert.equal(plan.intervalPlans[2].narrativeScore, 0);
});

test("J: a one-interval plan has no fabricated transition evidence", () => {
  const plan = planNarrativeSequence(buildFixture([
    { id: "only", concept: "doctor", candidates: [{ assetId: "asset-a", action: "consultation" }] },
  ]));
  assert.deepEqual(selectedAssets(plan), ["asset-a"]);
  assert.equal(plan.totalNarrativeScore, 0);
  assert.deepEqual(plan.intervalPlans[0].status === "resolved" && plan.intervalPlans[0].transitionEvidence, []);
});

test("K: all unresolved intervals produce a bounded empty-selection plan", () => {
  const plan = planNarrativeSequence(buildFixture([
    { id: "i1", concept: "a", candidates: [] },
    { id: "i2", concept: "b", candidates: [] },
  ]));
  assert.deepEqual(selectedAssets(plan), [null, null]);
  assert.deepEqual(plan.unresolvedIntervalIds, ["i1", "i2"]);
  assert.equal(plan.totalSequenceScore, 0);
});

test("L: an exact sequence score tie uses lexical asset ID ordering", () => {
  const plan = planNarrativeSequence(buildFixture([
    { id: "i1", concept: "a", candidates: [{ assetId: "z-asset" }, { assetId: "a-asset" }] },
  ]));
  assert.deepEqual(selectedAssets(plan), ["a-asset"]);
});

test("M: identical trusted evidence produces deeply equal reruns", () => {
  const input = buildFixture([
    { id: "i1", concept: "a", candidates: [{ assetId: "asset-a" }, { assetId: "asset-b" }] },
    { id: "i2", concept: "b", candidates: [{ assetId: "asset-a" }, { assetId: "asset-b" }] },
  ]);
  assert.deepEqual(planNarrativeSequence(input), planNarrativeSequence(input));
});

test("N: malformed, unbounded, URL-based, and trust-inconsistent inputs are rejected", () => {
  const valid = buildFixture([
    { id: "i1", concept: "doctor", candidates: [{ assetId: "asset-a" }] },
  ]);
  const wrongSegment = structuredClone(valid) as unknown as {
    rankedCandidateSets: Array<{ candidates: Array<{ supportingSegmentIds: string[] }> }>;
  };
  wrongSegment.rankedCandidateSets[0].candidates[0].supportingSegmentIds[0] = "unknown-segment";
  const malformed = [
    null,
    { ...valid, providerPrompt: "not allowed" },
    { ...valid, intervals: [{ ...valid.intervals[0], id: "blob:https://invalid/id" }] },
    { ...valid, intervals: Array.from({ length: NARRATIVE_PLANNER_LIMITS.maxIntervals + 1 }, (_, index) => ({
      id: `i-${index}`,
      timelineStartMs: index * 2_000,
      timelineEndMs: (index + 1) * 2_000,
      text: "x",
      concepts: ["x"],
    })) },
    wrongSegment,
  ];
  for (const value of malformed) {
    assert.throws(() => parseNarrativePlanningContext(value), NarrativePlanningValidationError);
  }
});

test("O: consultation-to-recovery medical fixture changes local ECG winner for global coherence", () => {
  const input = buildFixture([
    { id: "consultation", concept: "doctor", candidates: [{ assetId: "clip-consult", action: "consultation", concepts: ["patient"] }] },
    { id: "explanation", concept: "anatomy", candidates: [{ assetId: "clip-heart", action: "explanation", concepts: ["patient", "heart"] }] },
    { id: "ecg", concept: "test", candidates: [
      { assetId: "clip-generic-test", confidence: 0.91, action: "explanation", concepts: ["laboratory"] },
      { assetId: "clip-ecg", confidence: 0.9, action: "examination", concepts: ["patient", "heart"] },
    ] },
    { id: "treatment", concept: "medicine", candidates: [{ assetId: "clip-treatment", action: "treatment", concepts: ["patient"] }] },
    { id: "recovery", concept: "exercise", candidates: [{ assetId: "clip-recovery", action: "recovery", concepts: ["patient"] }] },
  ]);
  assert.equal(input.rankedCandidateSets[2].selectedAssetId, "clip-generic-test");
  const plan = planNarrativeSequence(input);
  assert.deepEqual(selectedAssets(plan), [
    "clip-consult",
    "clip-heart",
    "clip-ecg",
    "clip-treatment",
    "clip-recovery",
  ]);
  assert.equal(plan.unresolvedIntervalIds.length, 0);
});

test("custom progression hints are bounded, normalized, and deterministic", () => {
  const input = buildFixture([
    { id: "i1", concept: "a", candidates: [{ assetId: "start", action: "prepare" }] },
    { id: "i2", concept: "b", candidates: [
      { assetId: "static", confidence: 0.905, action: "prepare" },
      { assetId: "finish", confidence: 0.9, action: "deliver" },
    ] },
  ], [" Prepare ", "DELIVER"]);
  assert.deepEqual(selectedAssets(planNarrativeSequence(input)), ["start", "finish"]);
});

test("published budgets and weights keep the search bounded and local scores primary", () => {
  assert.deepEqual(NARRATIVE_PLANNER_LIMITS, {
    maxIntervals: 128,
    maxCandidatesPerInterval: 3,
    maxBeamWidth: 64,
    maxProgressionHints: 16,
    recentReuseWindow: 4,
  });
  assert.equal(NARRATIVE_SCORE_MODEL.localScoreWeight, 1);
  assert.equal(NARRATIVE_SCORE_MODEL.maximumLocalScoreDeficit, 0.08);
  assert.equal(NARRATIVE_SCORE_MODEL.maximumSemanticScoreDeficit, 0.08);
});
