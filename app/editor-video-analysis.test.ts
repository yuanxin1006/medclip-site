import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CANDIDATE_RANGES_PER_ASSET,
  MAX_TOTAL_CLASSIFIED_FRAMES_PER_ASSET,
  TWO_STAGE_LOCAL_ANALYSIS_VERSION,
  VideoAnalysisError,
  adaptLocalClipFrameObservation,
  aggregateVideoFrameObservations,
  analyzeVideoAssetTwoStage,
  createCandidateSourceRanges,
  parseVideoFrameObservation,
  type RawLocalClipClassification,
} from "./editor-video-analysis.ts";
import {
  MAX_FINE_VIDEO_FRAME_COUNT,
  createFineFrameSampleTimes,
  type FrameSample,
} from "./editor-video-sampling.ts";
import { VideoSemanticAnalysisCache } from "./editor-video-semantic.ts";

const createdAt = "2026-10-24T12:00:00.000Z";

function observation(
  sourceTimeMs: number,
  concepts: Array<{ label: string; score: number }>,
  assetId = "asset-a",
) {
  return adaptLocalClipFrameObservation({ assetId, sourceTimeMs, classifications: concepts });
}

function fixturePipeline(input: {
  durationMs: number;
  classify: (sourceTimeMs: number) => readonly RawLocalClipClassification[] | Promise<readonly RawLocalClipClassification[]>;
  assetId?: string;
  cache?: VideoSemanticAnalysisCache;
}) {
  const assetId = input.assetId ?? "asset-a";
  return analyzeVideoAssetTwoStage({
    assetId,
    assetDurationMs: input.durationMs,
    createdAt,
    cache: input.cache,
    captureFrames: async (timestamps) => timestamps.map((sourceTimeMs) => Object.freeze({
      assetId,
      sourceTimeMs,
      image: `fixture:${assetId}:${sourceTimeMs}`,
    })),
    classifyFrame: async (sample: FrameSample) => input.classify(sample.sourceTimeMs),
  });
}

test("short single-concept video produces one validated source segment", async () => {
  const result = await fixturePipeline({
    durationMs: 3_000,
    classify: () => [{ label: "doctor", score: 0.9 }, { label: "test", score: 0.1 }],
  });
  assert.equal(result.analysis.segments.length, 1);
  assert.equal(result.analysis.segments[0].id, "video-semantic:asset-a@0-3000");
  assert.deepEqual(result.analysis.segments[0].evidenceFrameMs, [600, 1_500, 2_400]);
  assert.equal(result.analysis.segments[0].confidence, 0.9);
  assert.equal(result.analysis.segments[0].usability, 0.5);
  assert.equal(result.classifiedFrameCount, 3);
});

test("two coarse concept regions produce stable non-overlapping candidate ranges", async () => {
  const result = await fixturePipeline({
    durationMs: 12_000,
    classify: (time) => time < 4_000
      ? [{ label: "doctor", score: 0.92 }, { label: "test", score: 0.08 }]
      : [{ label: "test", score: 0.88 }, { label: "doctor", score: 0.12 }],
  });
  assert.deepEqual(result.candidates.map(({ startMs, endMs }) => [startMs, endMs]), [
    [0, 3_900],
    [3_900, 12_000],
  ]);
  assert.deepEqual(result.analysis.segments.map((segment) => segment.concepts[0]), ["doctor", "test"]);
  assert.equal(result.analysis.segments.every((segment) => segment.assetId === "asset-a"), true);
});

test("ambiguous mixed concepts lower deterministic aggregate confidence", () => {
  const agreed = aggregateVideoFrameObservations("asset-a", [
    observation(100, [{ label: "doctor", score: 0.9 }, { label: "test", score: 0.1 }]),
    observation(200, [{ label: "doctor", score: 0.8 }, { label: "test", score: 0.2 }]),
    observation(300, [{ label: "doctor", score: 0.85 }, { label: "test", score: 0.15 }]),
  ]);
  const mixed = aggregateVideoFrameObservations("asset-a", [
    observation(100, [{ label: "doctor", score: 0.6 }, { label: "test", score: 0.4 }]),
    observation(200, [{ label: "test", score: 0.6 }, { label: "doctor", score: 0.4 }]),
    observation(300, [{ label: "exercise", score: 0.6 }, { label: "doctor", score: 0.4 }]),
  ]);
  assert.equal(agreed.confidence, 0.85);
  assert.equal(mixed.confidence, 0.155556);
  assert.ok(mixed.confidence < agreed.confidence);
});

test("single and low-confidence observations cannot claim high confidence", () => {
  const strongSingle = aggregateVideoFrameObservations("asset-a", [
    observation(100, [{ label: "doctor", score: 0.9 }]),
  ]);
  const lowAgreement = aggregateVideoFrameObservations("asset-a", [
    observation(100, [{ label: "doctor", score: 0.2 }]),
    observation(200, [{ label: "doctor", score: 0.3 }]),
    observation(300, [{ label: "doctor", score: 0.1 }]),
  ]);
  assert.equal(strongSingle.confidence, 0.54);
  assert.equal(lowAgreement.confidence, 0.2);
});

test("repeated concept evidence keeps one candidate and exposes support counts", () => {
  const observations = [
    observation(1_000, [{ label: "doctor", score: 0.8 }, { label: "test", score: 0.2 }]),
    observation(5_000, [{ label: "doctor", score: 0.7 }, { label: "test", score: 0.3 }]),
    observation(9_000, [{ label: "doctor", score: 0.9 }, { label: "test", score: 0.1 }]),
  ];
  const aggregate = aggregateVideoFrameObservations("asset-a", observations);
  const candidates = createCandidateSourceRanges({ assetId: "asset-a", assetDurationMs: 10_000, observations });
  assert.equal(candidates.length, 1);
  assert.deepEqual([candidates[0].startMs, candidates[0].endMs], [0, 10_000]);
  assert.equal(aggregate.conceptSupport[0].supportCount, 3);
  assert.equal(aggregate.conceptSupport[0].dominantCount, 3);
});

test("multiple semantic changes remain bounded to three stable candidate ranges", () => {
  const concepts = ["doctor", "test", "exercise", "food", "hospital"];
  const observations = concepts.map((label, index) => observation(
    1_000 + index * 2_000,
    [{ label, score: 0.9 - index * 0.01 }],
  ));
  const candidates = createCandidateSourceRanges({ assetId: "asset-a", assetDurationMs: 10_000, observations });
  assert.equal(candidates.length, MAX_CANDIDATE_RANGES_PER_ASSET);
  assert.deepEqual(candidates.map(({ startMs, endMs }) => [startMs, endMs]), [
    [0, 2_000],
    [2_000, 4_000],
    [4_000, 10_000],
  ]);
});

test("invalid classifier observations fail closed without leaking unknown fields", () => {
  assert.throws(
    () => adaptLocalClipFrameObservation({
      assetId: "asset-a",
      sourceTimeMs: 100,
      classifications: [{ label: "doctor", score: Number.NaN }],
    }),
    VideoAnalysisError,
  );
  assert.throws(
    () => parseVideoFrameObservation({
      ...observation(100, [{ label: "doctor", score: 0.9 }]),
      providerModel: "not-allowed",
    }),
    VideoAnalysisError,
  );
});

test("local CLIP adapter maps worker labels and orders equal scores lexically", () => {
  const mapped = adaptLocalClipFrameObservation({
    assetId: "asset-a",
    sourceTimeMs: 100,
    labelMap: new Map([
      ["worker doctor prompt", "doctor"],
      ["worker test prompt", "test"],
    ]),
    classifications: [
      { label: "ignored prompt", score: 0.99 },
      { label: "worker test prompt", score: 0.8 },
      { label: "worker doctor prompt", score: 0.8 },
    ],
  });
  assert.deepEqual(mapped.concepts, [
    { label: "doctor", score: 0.8 },
    { label: "test", score: 0.8 },
  ]);
  assert.equal(mapped.dominantConcept, "doctor");
});

test("fine sampling honors tiny range boundaries and remains bounded", () => {
  assert.deepEqual(createFineFrameSampleTimes(0, 1), [0]);
  assert.deepEqual(createFineFrameSampleTimes(100, 102), [100, 101]);
  assert.deepEqual(createFineFrameSampleTimes(1_000, 2_000), [1_200, 1_500, 1_800]);
  assert.equal(createFineFrameSampleTimes(1_000, 2_000).length, MAX_FINE_VIDEO_FRAME_COUNT);
});

test("coarse and fine duplicate timestamps are classified only once", async () => {
  const seen: number[] = [];
  const result = await fixturePipeline({
    durationMs: 3_000,
    classify: (time) => {
      seen.push(time);
      return [{ label: "doctor", score: 0.9 }];
    },
  });
  assert.equal(seen.filter((time) => time === 1_500).length, 1);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(result.classifiedFrameCount, 3);
});

test("worst-case analysis respects the fourteen-frame hard budget", async () => {
  const result = await fixturePipeline({
    durationMs: 45_000,
    classify: (time) => {
      if (time < 7_000) return [{ label: "doctor", score: 0.2 }];
      if (time < 17_000) return [{ label: "test", score: 0.9 }];
      if (time < 37_000) return [{ label: "exercise", score: 0.9 }];
      return [{ label: "hospital", score: 0.9 }];
    },
  });
  assert.equal(result.candidates.length, 3);
  assert.equal(result.classifiedFrameCount, MAX_TOTAL_CLASSIFIED_FRAMES_PER_ASSET);
  assert.equal(MAX_TOTAL_CLASSIFIED_FRAMES_PER_ASSET, 14);
});

test("one classifier failure is recorded while successful frame identities remain usable", async () => {
  const result = await fixturePipeline({
    durationMs: 4_000,
    classify: (time) => {
      if (time === 1_000) throw new Error("fixture classifier failure");
      return [{ label: "doctor", score: 0.8 }];
    },
  });
  assert.equal(result.failures.length, 1);
  assert.deepEqual(result.failures[0], {
    assetId: "asset-a",
    sourceTimeMs: 1_000,
    stage: "classification",
    message: "fixture classifier failure",
  });
  assert.equal(result.analysis.assetId, "asset-a");
});

test("deterministic fixture reruns produce equal semantic analyses and segment IDs", async () => {
  const run = () => fixturePipeline({
    durationMs: 12_000,
    classify: (time) => time < 6_000
      ? [{ label: "doctor", score: 0.8 }]
      : [{ label: "test", score: 0.75 }],
  });
  const first = await run();
  const second = await run();
  assert.deepEqual(first.analysis, second.analysis);
  assert.deepEqual(first.candidates, second.candidates);
  assert.equal(first.analysis.analysisVersion, TWO_STAGE_LOCAL_ANALYSIS_VERSION);
});

test("final validated analysis is reused only by matching cache identity and duration", async () => {
  const cache = new VideoSemanticAnalysisCache();
  let classificationCalls = 0;
  const run = (durationMs: number) => fixturePipeline({
    durationMs,
    cache,
    classify: () => {
      classificationCalls += 1;
      return [{ label: "doctor", score: 0.9 }];
    },
  });
  const first = await run(3_000);
  const callsAfterFirst = classificationCalls;
  const cached = await run(3_000);
  const changedDuration = await run(3_001);
  assert.equal(first.fromCache, false);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.classifiedFrameCount, 0);
  assert.equal(classificationCalls, callsAfterFirst + changedDuration.classifiedFrameCount);
  assert.equal(changedDuration.fromCache, false);
});

test("an aborted analysis returns a typed controlled failure before sampling", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => analyzeVideoAssetTwoStage({
      assetId: "asset-a",
      assetDurationMs: 3_000,
      createdAt,
      signal: controller.signal,
      captureFrames: async () => assert.fail("capture must not run"),
      classifyFrame: async () => assert.fail("classifier must not run"),
    }),
    (error: unknown) => error instanceof VideoAnalysisError && error.code === "ANALYSIS_ABORTED",
  );
});

test("decode or seek failure returns a typed capture failure", async () => {
  await assert.rejects(
    () => analyzeVideoAssetTwoStage({
      assetId: "asset-a",
      assetDurationMs: 3_000,
      createdAt,
      captureFrames: async () => { throw new Error("fixture decode failure"); },
      classifyFrame: async () => assert.fail("classifier must not run"),
    }),
    (error: unknown) => error instanceof VideoAnalysisError
      && error.code === "FRAME_CAPTURE_FAILED"
      && error.message.includes("fixture decode failure"),
  );
});

test("empty classifications never fabricate evidence", async () => {
  await assert.rejects(
    () => fixturePipeline({ durationMs: 3_000, classify: () => [] }),
    (error: unknown) => error instanceof VideoAnalysisError
      && error.code === "INSUFFICIENT_EVIDENCE",
  );
});
