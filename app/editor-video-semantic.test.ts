import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_CLIP_ANALYSIS_VERSION,
  VIDEO_SEMANTIC_SCHEMA_VERSION,
  VideoSemanticAnalysisCache,
  VideoSemanticValidationError,
  createFilenameFallbackAssetSemantics,
  createSourceRangeIdentity,
  createVideoSemanticSegmentId,
  normalizeLocalClipAnalysis,
  parseVideoSemanticAnalysis,
  parseVideoSemanticSegment,
  sourceIdentityForSemanticSegment,
  sourceIdentityForTimelineClip,
} from "./editor-video-semantic.ts";

const createdAt = "2026-10-24T10:00:00.000Z";

function validSegment(overrides: Record<string, unknown> = {}) {
  return {
    id: "segment-a-0-5000",
    assetId: "asset-a",
    startMs: 0,
    endMs: 5_000,
    summary: "  doctor consultation  ",
    concepts: [" doctor ", "patient"],
    action: " talking ",
    usability: 0.9,
    confidence: 0.8,
    evidenceFrameMs: [750, 2_500, 4_250],
    ...overrides,
  };
}

function validAnalysis(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: VIDEO_SEMANTIC_SCHEMA_VERSION,
    assetId: "asset-a",
    assetDurationMs: 10_000,
    segments: [validSegment()],
    analysisMethod: "local-clip",
    createdAt,
    analysisVersion: LOCAL_CLIP_ANALYSIS_VERSION,
    ...overrides,
  };
}

test("semantic segment parser normalizes only bounded text and retains trusted source identity", () => {
  const parsed = parseVideoSemanticSegment(validSegment());
  assert.deepEqual(parsed, {
    id: "segment-a-0-5000",
    assetId: "asset-a",
    startMs: 0,
    endMs: 5_000,
    summary: "doctor consultation",
    concepts: ["doctor", "patient"],
    action: "talking",
    usability: 0.9,
    confidence: 0.8,
    evidenceFrameMs: [750, 2_500, 4_250],
  });
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.concepts), true);
  assert.equal(Object.isFrozen(parsed.evidenceFrameMs), true);
});

test("semantic parser rejects invalid source ranges and non-finite millisecond values", () => {
  for (const value of [
    validSegment({ startMs: -1 }),
    validSegment({ endMs: 0 }),
    validSegment({ startMs: Number.NaN }),
    validSegment({ endMs: Number.POSITIVE_INFINITY }),
    validSegment({ startMs: 1.5 }),
  ]) {
    assert.throws(() => parseVideoSemanticSegment(value), VideoSemanticValidationError);
  }
});

test("semantic scores accept inclusive limits and reject values outside zero to one", () => {
  assert.equal(parseVideoSemanticSegment(validSegment({ confidence: 0, usability: 1 })).confidence, 0);
  for (const value of [
    validSegment({ confidence: -0.001 }),
    validSegment({ confidence: 1.001 }),
    validSegment({ usability: -0.001 }),
    validSegment({ usability: 1.001 }),
    validSegment({ confidence: Number.NaN }),
  ]) {
    assert.throws(() => parseVideoSemanticSegment(value), VideoSemanticValidationError);
  }
});

test("semantic parser rejects malformed concepts, unbounded text, URL identities, and unknown fields", () => {
  assert.throws(() => parseVideoSemanticSegment(validSegment({ concepts: [] })), VideoSemanticValidationError);
  assert.throws(() => parseVideoSemanticSegment(validSegment({ concepts: ["doctor", " doctor "] })), VideoSemanticValidationError);
  assert.throws(() => parseVideoSemanticSegment(validSegment({ concepts: [""] })), VideoSemanticValidationError);
  assert.throws(() => parseVideoSemanticSegment(validSegment({ summary: "x".repeat(1_001) })), VideoSemanticValidationError);
  assert.throws(() => parseVideoSemanticSegment(validSegment({ assetId: "blob:https://example.invalid/id" })), VideoSemanticValidationError);
  assert.throws(() => parseVideoSemanticSegment(validSegment({ assetId: "C:\\media\\clip.mp4" })), VideoSemanticValidationError);
  assert.throws(() => parseVideoSemanticSegment({ ...validSegment(), providerModel: "secret-model" }), VideoSemanticValidationError);
});

test("analysis parser rejects duplicate segment IDs, mismatched assets, out-of-range segments, and schema drift", () => {
  assert.throws(() => parseVideoSemanticAnalysis(validAnalysis({
    segments: [validSegment(), validSegment({ startMs: 5_000, endMs: 9_000, evidenceFrameMs: [6_000] })],
  })), VideoSemanticValidationError);
  assert.throws(() => parseVideoSemanticAnalysis(validAnalysis({
    segments: [validSegment({ assetId: "asset-b" })],
  })), VideoSemanticValidationError);
  assert.throws(() => parseVideoSemanticAnalysis(validAnalysis({
    segments: [validSegment({ endMs: 11_000, evidenceFrameMs: [10_500] })],
  })), VideoSemanticValidationError);
  assert.throws(() => parseVideoSemanticAnalysis(validAnalysis({ schemaVersion: 2 })), VideoSemanticValidationError);
  assert.throws(() => parseVideoSemanticAnalysis({ ...validAnalysis(), rawProviderResponse: {} }), VideoSemanticValidationError);
});

test("evidence timestamps must be unique finite source times inside the semantic segment", () => {
  assert.throws(() => parseVideoSemanticSegment(validSegment({ evidenceFrameMs: [-1] })), VideoSemanticValidationError);
  assert.throws(() => parseVideoSemanticSegment(validSegment({ evidenceFrameMs: [5_001] })), VideoSemanticValidationError);
  assert.throws(() => parseVideoSemanticSegment(validSegment({ evidenceFrameMs: [1_000, 1_000] })), VideoSemanticValidationError);
  assert.throws(() => parseVideoSemanticSegment(validSegment({ evidenceFrameMs: [Number.NaN] })), VideoSemanticValidationError);
});

test("asset, semantic segment, source range, and timeline clip identities remain distinct", () => {
  const first = parseVideoSemanticSegment(validSegment());
  const second = parseVideoSemanticSegment(validSegment({
    id: "segment-a-5000-10000",
    startMs: 5_000,
    endMs: 10_000,
    evidenceFrameMs: [5_500, 8_000],
  }));
  const clipX = sourceIdentityForTimelineClip({
    id: "clip-x",
    assetId: "asset-a",
    sourceInMs: 0,
    sourceOutMs: 5_000,
  });
  const clipY = sourceIdentityForTimelineClip({
    id: "clip-y",
    assetId: "asset-a",
    sourceInMs: 5_000,
    sourceOutMs: 10_000,
  });

  assert.equal(first.assetId, second.assetId);
  assert.notEqual(first.id, second.id);
  assert.notEqual(sourceIdentityForSemanticSegment(first).key, sourceIdentityForSemanticSegment(second).key);
  assert.equal(clipX.sourceRangeKey, sourceIdentityForSemanticSegment(first).key);
  assert.equal(clipY.sourceRangeKey, sourceIdentityForSemanticSegment(second).key);
  assert.notEqual(clipX.clipId, clipY.clipId);
  assert.equal(createSourceRangeIdentity("asset-a", 0, 5_000).key, "asset-a@0-5000");
  assert.equal(createVideoSemanticSegmentId("asset-a", 0, 5_000), "video-semantic:asset-a@0-5000");
});

test("local CLIP frame scores normalize deterministically into source-grounded evidence", () => {
  const analysis = normalizeLocalClipAnalysis({
    assetId: "asset-a",
    assetDurationMs: 12_000,
    createdAt,
    analysisMethod: "local-clip",
    frames: [
      { sourceTimeMs: 10_200, concepts: [{ concept: "test", score: 0.7 }, { concept: "doctor", score: 0.4 }] },
      { sourceTimeMs: 1_800, concepts: [{ concept: "doctor", score: 0.9 }, { concept: "test", score: 0.5 }] },
    ],
  });
  assert.equal(analysis.schemaVersion, 1);
  assert.equal(analysis.analysisMethod, "local-clip");
  assert.equal(analysis.analysisVersion, LOCAL_CLIP_ANALYSIS_VERSION);
  assert.deepEqual(analysis.segments[0].concepts, ["doctor", "test"]);
  assert.deepEqual(analysis.segments[0].evidenceFrameMs, [1_800, 10_200]);
  assert.equal(analysis.segments[0].summary, "doctor / test");
  assert.equal(analysis.segments[0].confidence, 0.9);
  assert.equal("providerModel" in analysis, false);
});

test("filename fallback remains explicit and cannot claim high model confidence", () => {
  const analysis = normalizeLocalClipAnalysis({
    assetId: "asset-a",
    assetDurationMs: 4_000,
    createdAt,
    analysisMethod: "filename-fallback",
    frames: [{ sourceTimeMs: 0, concepts: [{ concept: "doctor", score: 1 }] }],
  });
  assert.equal(analysis.analysisMethod, "filename-fallback");
  assert.equal(analysis.segments[0].confidence, 0.25);
  assert.deepEqual(createFilenameFallbackAssetSemantics("doctor"), {
    semanticTopic: "doctor",
    semanticScore: undefined,
  });
});

test("session-local cache keys by asset, analysis version, and duration and supports invalidation", () => {
  const cache = new VideoSemanticAnalysisCache();
  const first = cache.set(validAnalysis());
  const secondVersion = cache.set(validAnalysis({ analysisVersion: "local-clip-medical-v2" }));
  const otherAsset = cache.set(validAnalysis({
    assetId: "asset-b",
    segments: [validSegment({ assetId: "asset-b", id: "segment-b" })],
  }));

  assert.equal(cache.size, 3);
  assert.equal(cache.get("asset-a", LOCAL_CLIP_ANALYSIS_VERSION, 10_000), first);
  assert.equal(cache.get("asset-a", "local-clip-medical-v2", 10_000), secondVersion);
  assert.equal(cache.get("asset-a", LOCAL_CLIP_ANALYSIS_VERSION, 9_999), undefined);
  assert.equal(cache.invalidateAsset("asset-a"), 2);
  assert.equal(cache.size, 1);
  assert.equal(cache.get("asset-b", LOCAL_CLIP_ANALYSIS_VERSION, 10_000), otherAsset);
  cache.clear();
  assert.equal(cache.size, 0);
});
