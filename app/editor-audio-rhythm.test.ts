import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIO_ENERGY_WINDOW_MS,
  AUDIO_MEANINGFUL_PAUSE_MS,
  AUDIO_RHYTHM_SCHEMA_VERSION,
  AUDIO_SHORT_GAP_MS,
  LOCAL_AUDIO_RHYTHM_ANALYSIS_VERSION,
  MAX_AUDIO_ENERGY_POINTS,
  MAX_AUDIO_ONSET_CANDIDATES,
  MAX_AUDIO_RHYTHM_SEGMENTS,
  MIN_AUDIO_ONSET_SPACING_MS,
  AudioRhythmAnalysisError,
  analyzeAudioRhythm,
  createAudioRhythmSourceId,
  parseAudioRhythmAnalysis,
} from "./editor-audio-rhythm.ts";

const sampleRate = 1_000;

function pcm(
  durationMs: number,
  valueAt: (timeMs: number, index: number) => number,
): Float32Array {
  const samples = new Float32Array(Math.round(durationMs / 1_000 * sampleRate));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = valueAt(index / sampleRate * 1_000, index);
  }
  return samples;
}

function analyze(
  samples: Float32Array,
  speechRegions?: Array<{ startMs: number; endMs: number }>,
) {
  return analyzeAudioRhythm({
    sourceId: "audio-a",
    samples,
    sampleRate,
    speechRegions,
  });
}

test("silence produces normalized zero energy and explicit pause evidence", () => {
  const result = analyze(pcm(1_000, () => 0));
  assert.equal(result.schemaVersion, AUDIO_RHYTHM_SCHEMA_VERSION);
  assert.equal(result.analysisVersion, LOCAL_AUDIO_RHYTHM_ANALYSIS_VERSION);
  assert.equal(result.energyEnvelope.length, 10);
  assert.equal(result.energyEnvelope.every((point) => point.energy === 0), true);
  assert.deepEqual(result.onsets, []);
  assert.equal(result.segments.length, 1);
  assert.deepEqual(
    { startMs: result.segments[0].startMs, endMs: result.segments[0].endMs, pause: result.segments[0].pause },
    { startMs: 0, endMs: 1_000, pause: true },
  );
});

test("constant speech-like energy reuses local speech detection without false pauses", () => {
  const result = analyze(pcm(1_000, (_time, index) => Math.sin(index * 0.37) * 0.2));
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].speech, true);
  assert.equal(result.segments[0].pause, false);
  assert.ok(result.segments[0].energy > 0.99);
  assert.ok(result.segments[0].confidence > 0.99);
});

test("speech with one clear pause creates source-relative speech and pause segments", () => {
  const samples = pcm(2_200, (time, index) =>
    time < 800 || time >= 1_400 ? Math.sin(index * 0.41) * 0.3 : 0);
  const result = analyze(samples);
  const pauses = result.segments.filter((segment) => segment.pause);
  const speech = result.segments.filter((segment) => segment.speech);
  assert.equal(speech.length, 2);
  assert.ok(pauses.some((segment) => segment.startMs <= 810 && segment.endMs >= 1_390));
  assert.equal(result.segments[0].startMs, 0);
  assert.equal(result.segments.at(-1)?.endMs, 2_200);
});

test("short-gap and meaningful-pause confidence use the frozen 180ms and 480ms thresholds", () => {
  const samples = pcm(1_500, (_time, index) => Math.sin(index * 0.29) * 0.2);
  const short = analyze(samples, [
    { startMs: 0, endMs: 400 },
    { startMs: 520, endMs: 1_500 },
  ]).segments.find((segment) => segment.pause)!;
  const meaningful = analyze(samples, [
    { startMs: 0, endMs: 400 },
    { startMs: 880, endMs: 1_500 },
  ]).segments.find((segment) => segment.pause)!;
  assert.equal(AUDIO_SHORT_GAP_MS, 180);
  assert.equal(AUDIO_MEANINGFUL_PAUSE_MS, 480);
  assert.equal(short.confidence, 0.266667);
  assert.equal(meaningful.confidence, 0.75);
});

test("two strong energy rises become bounded onset candidates", () => {
  const samples = pcm(1_200, (time, index) => {
    if (time >= 200 && time < 500) return Math.sin(index * 0.53) * 0.25;
    if (time >= 800) return Math.sin(index * 0.53) * 0.8;
    return 0;
  });
  const result = analyze(samples, []);
  assert.deepEqual(result.onsets.map((onset) => onset.timeMs), [250, 850]);
  assert.ok(result.onsets.every((onset) => onset.strength >= 0.22 && onset.strength <= 1));
});

test("low-level stable noise creates no speech or false transient density", () => {
  const samples = pcm(2_000, (_time, index) => ((index * 17) % 23 - 11) / 11 * 0.0004);
  const result = analyze(samples);
  assert.equal(result.segments.every((segment) => segment.pause), true);
  assert.equal(result.onsets.length, 0);
  assert.equal(result.energyEnvelope.every((point) => point.energy >= 0 && point.energy <= 1), true);
});

test("short audio remains finite, bounded, and source-relative", () => {
  const result = analyze(pcm(50, (_time, index) => Math.sin(index) * 0.1));
  assert.equal(result.sourceDurationMs, 50);
  assert.equal(result.energyEnvelope.length, 1);
  assert.equal(result.energyEnvelope[0].timeMs, 25);
  assert.equal(result.segments[0].startMs, 0);
  assert.equal(result.segments[0].endMs, 50);
});

test("empty, zero-duration, non-finite, and pre-aborted inputs fail with typed errors", () => {
  assert.throws(
    () => analyze(new Float32Array()),
    (error: unknown) => error instanceof AudioRhythmAnalysisError && error.code === "EMPTY_PCM",
  );
  assert.throws(
    () => analyzeAudioRhythm({ sourceId: "audio-a", samples: new Float32Array([0]), sampleRate: 384_000 }),
    (error: unknown) => error instanceof AudioRhythmAnalysisError && error.code === "ZERO_DURATION",
  );
  assert.throws(
    () => analyze(new Float32Array([0, Number.NaN, 0])),
    (error: unknown) => error instanceof AudioRhythmAnalysisError && error.code === "INVALID_INPUT",
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => analyzeAudioRhythm({
      sourceId: "audio-a",
      samples: pcm(100, () => 0),
      sampleRate,
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof AudioRhythmAnalysisError && error.code === "ANALYSIS_ABORTED",
  );
});

test("clipped high-amplitude PCM is clamped for finite normalized energy", () => {
  const result = analyze(pcm(500, (_time, index) => index % 2 ? 4 : -4), [
    { startMs: 0, endMs: 500 },
  ]);
  assert.equal(result.energyEnvelope.every((point) => point.energy === 1), true);
  assert.equal(result.segments[0].energy, 1);
  assert.equal(result.segments[0].confidence, 1);
});

test("repeated transient peaks obey minimum spacing and onset count bounds", () => {
  const samples = pcm(3_000, (time) => Math.floor(time / 100) % 2 ? 0.8 : 0);
  const result = analyze(samples, []);
  assert.ok(result.onsets.length > 1);
  assert.ok(result.onsets.length <= MAX_AUDIO_ONSET_CANDIDATES);
  result.onsets.slice(1).forEach((onset, index) => {
    assert.ok(onset.timeMs - result.onsets[index].timeMs >= MIN_AUDIO_ONSET_SPACING_MS);
  });
});

test("energy output uses 100ms nominal windows and adapts to the hard point bound", () => {
  assert.equal(AUDIO_ENERGY_WINDOW_MS, 100);
  const long = analyze(pcm(610_000, () => 0), []);
  assert.ok(long.energyEnvelope.length <= MAX_AUDIO_ENERGY_POINTS);
  assert.equal(long.segments.length <= MAX_AUDIO_RHYTHM_SEGMENTS, true);
});

test("analysis parser rejects unknown fields, invalid scores, and unresolved onset references", () => {
  const valid = analyze(pcm(1_000, () => 0));
  assert.throws(
    () => parseAudioRhythmAnalysis({ ...valid, providerModel: "forbidden" }),
    AudioRhythmAnalysisError,
  );
  assert.throws(
    () => parseAudioRhythmAnalysis({
      ...valid,
      energyEnvelope: [{ ...valid.energyEnvelope[0], energy: Number.POSITIVE_INFINITY }],
    }),
    AudioRhythmAnalysisError,
  );
  assert.throws(
    () => parseAudioRhythmAnalysis({
      ...valid,
      segments: [{ ...valid.segments[0], onsetMs: 100 }],
    }),
    AudioRhythmAnalysisError,
  );
  assert.throws(
    () => parseAudioRhythmAnalysis({
      ...valid,
      segments: [{ ...valid.segments[0], id: "forged-segment-id" }],
    }),
    AudioRhythmAnalysisError,
  );
});

test("audio source identity uses one trusted asset ID or a stable ordered composite", () => {
  assert.equal(createAudioRhythmSourceId(["audio-a"]), "audio-a");
  assert.equal(
    createAudioRhythmSourceId(["audio-a", "audio-b"]),
    createAudioRhythmSourceId(["audio-a", "audio-b"]),
  );
  assert.notEqual(
    createAudioRhythmSourceId(["audio-a", "audio-b"]),
    createAudioRhythmSourceId(["audio-b", "audio-a"]),
  );
  assert.throws(() => createAudioRhythmSourceId(["blob:https://invalid/audio"]), AudioRhythmAnalysisError);
});

test("deterministic reruns preserve energy, onsets, segments, IDs, and version", () => {
  const samples = pcm(2_000, (time, index) =>
    time < 700 || time >= 1_200 ? Math.sin(index * 0.31) * 0.3 : 0);
  const first = analyze(samples);
  const second = analyze(samples);
  assert.deepEqual(second, first);
  assert.equal(first.analysisVersion, LOCAL_AUDIO_RHYTHM_ANALYSIS_VERSION);
  assert.equal(first.energyEnvelope.every((point) => Number.isFinite(point.energy)), true);
});
