import assert from "node:assert/strict";
import test from "node:test";
import {
  MATCHING_THRESHOLD_EPSILON,
  MINIMUM_ACCEPTABLE_CANDIDATE_SCORE,
  MINIMUM_SEMANTIC_SCORE,
  MULTIMODAL_MATCHING_WEIGHTS,
  REPETITION_PENALTY_MODEL,
  SEMANTIC_SCORE_WEIGHTS,
  MultimodalMatchingValidationError,
  buildMultimodalCandidateTable,
  candidateClearsMatchingThresholds,
  normalizeMatchingConcept,
  rankMultimodalCandidates,
  rhythmEvidenceForInterval,
} from "./editor-multimodal-matching.ts";
import {
  AUDIO_RHYTHM_SCHEMA_VERSION,
  LOCAL_AUDIO_RHYTHM_ANALYSIS_VERSION,
  createAudioRhythmSegmentId,
} from "./editor-audio-rhythm.ts";

function interval(concepts: string[] = ["doctor"], overrides: Record<string, unknown> = {}) {
  return {
    id: "interval-1",
    timelineStartMs: 0,
    timelineEndMs: 2_000,
    text: "trusted caption",
    concepts,
    ...overrides,
  };
}

function segment(
  assetId: string,
  concepts: string[] = ["doctor"],
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `${assetId}-segment-1`,
    assetId,
    startMs: 0,
    endMs: 2_000,
    summary: "trusted local semantic evidence",
    concepts,
    usability: 0.8,
    confidence: 0.9,
    evidenceFrameMs: [500, 1_500],
    ...overrides,
  };
}

function asset(
  assetId: string,
  concepts: string[] = ["doctor"],
  overrides: Record<string, unknown> = {},
) {
  return {
    assetId,
    sourceDurationMs: 4_000,
    semanticSegments: [segment(assetId, concepts)],
    ...overrides,
  };
}

function context(assets: unknown[], overrides: Record<string, unknown> = {}) {
  return { interval: interval(), assets, ...overrides };
}

function rhythm() {
  const sourceId = "audio-main";
  return {
    schemaVersion: AUDIO_RHYTHM_SCHEMA_VERSION,
    sourceId,
    sourceDurationMs: 4_000,
    energyEnvelope: [
      { timeMs: 500, energy: 0.2 },
      { timeMs: 1_500, energy: 0.6 },
      { timeMs: 2_500, energy: 0.8 },
      { timeMs: 3_500, energy: 0.4 },
    ],
    onsets: [{ timeMs: 750, strength: 0.7 }, { timeMs: 2_750, strength: 0.8 }],
    segments: [
      {
        id: createAudioRhythmSegmentId(sourceId, 0, 1_000, true),
        startMs: 0,
        endMs: 1_000,
        energy: 0.4,
        speech: true,
        pause: false,
        onsetMs: 750,
        confidence: 0.8,
      },
      {
        id: createAudioRhythmSegmentId(sourceId, 1_000, 2_000, false),
        startMs: 1_000,
        endMs: 2_000,
        energy: 0.1,
        speech: false,
        pause: true,
        confidence: 0.9,
      },
      {
        id: createAudioRhythmSegmentId(sourceId, 2_000, 4_000, true),
        startMs: 2_000,
        endMs: 4_000,
        energy: 0.7,
        speech: true,
        pause: false,
        onsetMs: 2_750,
        confidence: 0.8,
      },
    ],
    analysisVersion: LOCAL_AUDIO_RHYTHM_ANALYSIS_VERSION,
  };
}

test("A: an obvious semantic winner is selected with transparent component scores", () => {
  const result = rankMultimodalCandidates(context([
    asset("asset-unrelated", ["food"]),
    asset("asset-doctor", [" Doctor "]),
  ]));
  assert.equal(result.selectedAssetId, "asset-doctor");
  assert.deepEqual(result.candidates.map((candidate) => candidate.assetId), ["asset-doctor", "asset-unrelated"]);
  const winner = result.candidates[0];
  assert.equal(winner.semanticScore, 0.9);
  assert.equal(winner.usabilityScore, 0.72);
  assert.equal(winner.timingScore, 1);
  assert.equal(winner.repetitionPenalty, 0);
  assert.equal(winner.totalScore, 0.789);
  assert.deepEqual(winner.timingEvidence, { intervalDurationMs: 2_000, sourceDurationMs: 4_000 });
  assert.deepEqual(winner.repetitionEvidence, { usageCount: 0, immediateRepeat: false });
});

test("B: two semantically similar candidates are ranked by bounded confidence support", () => {
  const result = rankMultimodalCandidates(context([
    asset("asset-lower", ["doctor"], { semanticSegments: [segment("asset-lower", ["doctor"], { confidence: 0.7 })] }),
    asset("asset-higher", ["doctor"], { semanticSegments: [segment("asset-higher", ["doctor"], { confidence: 0.9 })] }),
  ]));
  assert.equal(result.candidates[0].assetId, "asset-higher");
  assert.ok(result.candidates[0].semanticScore > result.candidates[1].semanticScore);
});

test("C: low semantic confidence rejects rather than inventing certainty", () => {
  const result = rankMultimodalCandidates(context([
    asset("asset-low", ["doctor"], { semanticSegments: [segment("asset-low", ["doctor"], { confidence: 0.2, usability: 1 })] }),
  ]));
  assert.equal(result.selectedAssetId, undefined);
  assert.equal(result.rejectionReason, "LOW_SEMANTIC_SUPPORT");
  assert.equal(result.candidates[0].semanticScore, 0.2);
});

test("D: no available asset returns an explicit no-valid-candidate result", () => {
  const result = rankMultimodalCandidates(context([]));
  assert.deepEqual(result.candidates, []);
  assert.equal(result.selectedAssetId, undefined);
  assert.equal(result.confidence, 0);
  assert.equal(result.rejectionReason, "NO_VALID_CANDIDATE");
});

test("E: immediate repetition is penalized without permanently forbidding reuse", () => {
  const result = rankMultimodalCandidates(context([
    asset("asset-a"),
    asset("asset-b"),
  ], { previousAssetId: "asset-a" }));
  assert.equal(result.candidates[0].assetId, "asset-b");
  assert.equal(result.candidates.find((candidate) => candidate.assetId === "asset-a")?.repetitionPenalty, 0.7);
  assert.deepEqual(result.candidates.find((candidate) => candidate.assetId === "asset-a")?.repetitionEvidence, {
    usageCount: 0,
    immediateRepeat: true,
    previousAssetId: "asset-a",
  });
  assert.ok(result.candidates.some((candidate) => candidate.assetId === "asset-a"));
});

test("F: repeated usage gradually lowers preference and remains bounded", () => {
  const result = rankMultimodalCandidates(context([
    asset("asset-a"),
    asset("asset-b"),
  ], { assetUsage: { "asset-a": 3, "asset-b": 1 } }));
  assert.equal(result.candidates[0].assetId, "asset-b");
  assert.equal(result.candidates.find((candidate) => candidate.assetId === "asset-a")?.repetitionPenalty, 0.3);
  assert.equal(result.candidates.find((candidate) => candidate.assetId === "asset-b")?.repetitionPenalty, 0.1);
});

test("G: source duration mismatch lowers timing fit without creating a speed action", () => {
  const result = rankMultimodalCandidates(context([
    asset("asset-short", ["doctor"], { sourceDurationMs: 1_000, semanticSegments: [segment("asset-short", ["doctor"], { endMs: 1_000, evidenceFrameMs: [500] })] }),
    asset("asset-covering"),
  ]));
  assert.equal(result.candidates[0].assetId, "asset-covering");
  assert.equal(result.candidates.find((candidate) => candidate.assetId === "asset-short")?.timingScore, 0.5);
  assert.doesNotMatch(JSON.stringify(result), /MATCH_ASSET_TO_SEGMENT|SET_CLIP_PLAYBACK_SPEED/);
});

test("H: stronger semantic evidence can outweigh a merely more usable candidate", () => {
  const result = rankMultimodalCandidates(context([
    asset("asset-semantic", ["doctor"], { semanticSegments: [segment("asset-semantic", ["doctor"], { confidence: 1, usability: 0.8 })] }),
    asset("asset-usable", ["doctor"], { semanticSegments: [segment("asset-usable", ["doctor"], { confidence: 0.7, usability: 1 })] }),
  ]));
  assert.equal(result.candidates[0].assetId, "asset-semantic");
  assert.ok(result.candidates[0].semanticScore > result.candidates[1].semanticScore);
});

test("I: exact score ties use stable assetId lexical order", () => {
  const result = rankMultimodalCandidates(context([asset("asset-z"), asset("asset-a")]));
  assert.deepEqual(result.candidates.map((candidate) => candidate.assetId), ["asset-a", "asset-z"]);
});

test("J: matched concepts, source ranges, segment IDs, and frame evidence survive scoring", () => {
  const evidenceSegment = segment("asset-a", ["doctor", "patient"], {
    id: "segment-support",
    startMs: 300,
    endMs: 1_800,
    evidenceFrameMs: [400, 1_700],
    confidence: 0.85,
    usability: 0.75,
  });
  const result = rankMultimodalCandidates({
    interval: interval(["doctor", "patient"]),
    assets: [asset("asset-a", ["doctor"], { semanticSegments: [evidenceSegment] })],
  });
  const candidate = result.candidates[0];
  assert.deepEqual(candidate.matchedConcepts, ["doctor", "patient"]);
  assert.deepEqual(candidate.supportingSegmentIds, ["segment-support"]);
  assert.deepEqual(candidate.supportingSourceRanges, [{
    segmentId: "segment-support",
    sourceStartMs: 300,
    sourceEndMs: 1_800,
    confidence: 0.85,
    usability: 0.75,
    matchedConcepts: ["doctor", "patient"],
  }]);
  assert.deepEqual(candidate.evidenceFrameMs, [400, 1_700]);
});

test("K: support far from source zero exposes the current placement limitation", () => {
  const far = segment("asset-a", ["doctor"], {
    startMs: 3_000,
    endMs: 5_000,
    evidenceFrameMs: [3_500, 4_500],
  });
  const result = rankMultimodalCandidates(context([
    asset("asset-a", ["doctor"], { sourceDurationMs: 6_000, semanticSegments: [far] }),
  ]));
  assert.equal(result.candidates[0].sourceRangePlacementLimitation, true);
});

test("L: the ordered multi-interval table evolves usage explicitly between recommendations", () => {
  const intervals = [
    interval(["doctor"], { id: "interval-1" }),
    interval(["doctor"], { id: "interval-2", timelineStartMs: 2_000, timelineEndMs: 4_000 }),
  ];
  const table = buildMultimodalCandidateTable({ intervals, assets: [asset("asset-a"), asset("asset-b")] });
  assert.deepEqual(table.map((set) => set.intervalId), ["interval-1", "interval-2"]);
  assert.equal(table[0].selectedAssetId, "asset-a");
  assert.equal(table[1].selectedAssetId, "asset-b");
  assert.equal(Object.isFrozen(table), true);
});

test("M: identical structured evidence produces deeply equal reruns", () => {
  const input = context([asset("asset-b"), asset("asset-a")], { rhythm: rhythm() });
  assert.deepEqual(rankMultimodalCandidates(input), rankMultimodalCandidates(input));
});

test("N: malformed, unbounded, URL-based, and unknown-field inputs are rejected", () => {
  const malformed = [
    null,
    { interval: interval(), assets: [], providerText: "untrusted" },
    context([asset("blob:https://example.invalid/id")]),
    context([asset("asset-a", ["doctor"], { sourceDurationMs: Number.POSITIVE_INFINITY })]),
    context([asset("asset-a")], { assetUsage: { "asset-a": -1 } }),
    { interval: interval([], { timelineEndMs: 0 }), assets: [] },
    { interval: interval([], { timelineEndMs: 86_400_001 }), assets: [] },
    { interval: interval(Array.from({ length: 17 }, (_, index) => `concept-${index}`)), assets: [] },
  ];
  for (const value of malformed) {
    assert.throws(() => rankMultimodalCandidates(value), MultimodalMatchingValidationError);
  }
});

test("exact threshold boundary is accepted using the documented epsilon", () => {
  assert.equal(candidateClearsMatchingThresholds({
    semanticScore: MINIMUM_SEMANTIC_SCORE,
    totalScore: MINIMUM_ACCEPTABLE_CANDIDATE_SCORE,
  }), true);
  assert.equal(MATCHING_THRESHOLD_EPSILON, 1e-9);
});

test("just below either threshold is rejected beyond epsilon", () => {
  assert.equal(candidateClearsMatchingThresholds({
    semanticScore: MINIMUM_SEMANTIC_SCORE - 0.000001,
    totalScore: MINIMUM_ACCEPTABLE_CANDIDATE_SCORE,
  }), false);
  assert.equal(candidateClearsMatchingThresholds({
    semanticScore: MINIMUM_SEMANTIC_SCORE,
    totalScore: MINIMUM_ACCEPTABLE_CANDIDATE_SCORE - 0.000001,
  }), false);
});

test("just above both thresholds is accepted", () => {
  assert.equal(candidateClearsMatchingThresholds({
    semanticScore: MINIMUM_SEMANTIC_SCORE + 0.000001,
    totalScore: MINIMUM_ACCEPTABLE_CANDIDATE_SCORE + 0.000001,
  }), true);
});

test("unknown caption text alone is not fabricated into a semantic concept", () => {
  const result = rankMultimodalCandidates({
    interval: interval([], { text: "arbitrary locally unknown medical phrase" }),
    assets: [asset("asset-a", ["doctor"])],
  });
  assert.equal(result.candidates[0].semanticScore, 0);
  assert.equal(result.selectedAssetId, undefined);
  assert.equal(result.rejectionReason, "LOW_SEMANTIC_SUPPORT");
});

test("concept normalization is deterministic NFKC, whitespace, and case folding only", () => {
  assert.equal(normalizeMatchingConcept("  ＤＯＣＴＯＲ   Visit "), "doctor visit");
});

test("rhythm queries retain bounded pause, onset, and mean-energy evidence without changing scores", () => {
  const evidence = rhythmEvidenceForInterval(interval(), rhythm());
  assert.deepEqual(evidence, {
    rhythmSourceId: "audio-main",
    nearestPauseToTimelineStart: { rhythmSourceTimeMs: 1_000, distanceMs: 1_000 },
    nearestPauseToTimelineEnd: { rhythmSourceTimeMs: 2_000, distanceMs: 0 },
    nearestOnsetToTimelineStart: { rhythmSourceTimeMs: 750, distanceMs: 750 },
    nearestOnsetToTimelineEnd: { rhythmSourceTimeMs: 2_750, distanceMs: 750 },
    meanEnergy: 0.4,
  });
  const withoutRhythm = rankMultimodalCandidates(context([asset("asset-a")]));
  const withRhythm = rankMultimodalCandidates(context([asset("asset-a")], { rhythm: rhythm() }));
  assert.deepEqual(withRhythm.candidates, withoutRhythm.candidates);
  assert.deepEqual(withRhythm.rhythmEvidence, evidence);
});

test("published weights are centralized and sum to the documented positive-minus-penalty model", () => {
  assert.deepEqual(MULTIMODAL_MATCHING_WEIGHTS, {
    semantic: 0.55,
    usability: 0.20,
    timing: 0.15,
    repetition: 0.10,
  });
  assert.deepEqual(SEMANTIC_SCORE_WEIGHTS, {
    aggregateConceptSupport: 0.75,
    strongestSegmentSupport: 0.25,
  });
  assert.deepEqual(REPETITION_PENALTY_MODEL, {
    immediateRepeat: 0.70,
    perPriorUse: 0.10,
    maximumUsageOnly: 0.30,
  });
});
