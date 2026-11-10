import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COARSE_VIDEO_FRAME_COUNT,
  VideoFrameSamplingError,
  createCoarseFrameSampleTimes,
} from "./editor-video-sampling.ts";

test("coarse sampling preserves the current deterministic duration thresholds", () => {
  assert.deepEqual(createCoarseFrameSampleTimes(3_999, true), [2_000]);
  assert.deepEqual(createCoarseFrameSampleTimes(4_000, true), [1_000, 3_000]);
  assert.deepEqual(createCoarseFrameSampleTimes(12_000, true), [1_800, 6_000, 10_200]);
  assert.deepEqual(createCoarseFrameSampleTimes(45_000, true), [3_600, 11_250, 22_500, 33_750, 41_400]);
});

test("very long assets remain bounded to five coarse samples", () => {
  const samples = createCoarseFrameSampleTimes(36_000_000, true);
  assert.equal(MAX_COARSE_VIDEO_FRAME_COUNT, 5);
  assert.equal(samples.length, MAX_COARSE_VIDEO_FRAME_COUNT);
  assert.deepEqual(samples, [2_880_000, 9_000_000, 18_000_000, 27_000_000, 33_120_000]);
  assert.equal(Object.isFrozen(samples), true);
});

test("non-detailed sampling remains capped at the existing three-frame path", () => {
  assert.deepEqual(createCoarseFrameSampleTimes(45_000, false), [6_750, 22_500, 38_250]);
});

test("invalid video durations fail instead of producing fabricated timestamps", () => {
  for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createCoarseFrameSampleTimes(duration, true),
      VideoFrameSamplingError,
    );
  }
});
