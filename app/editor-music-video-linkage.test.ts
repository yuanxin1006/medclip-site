import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMusicVideoTimelineProposal,
  normalizeVideoSceneIndex,
  scoreMusicVideoCandidates,
  segmentMusicForVideoLinkage,
  type MusicSegmentV1,
  type VideoSceneV1,
} from "./editor-music-video-linkage.ts";
import { analyzeAudioRhythm } from "./editor-audio-rhythm.ts";
import { createHumanReviewState, executeReviewedProposal, reviewProposalEntry } from "./editor-proposal-review.ts";
import { LOCAL_CLIP_ANALYSIS_VERSION, VIDEO_SEMANTIC_SCHEMA_VERSION, type VideoSemanticAnalysis } from "./editor-video-semantic.ts";
import { DEFAULT_SPEED_CURVE, DEFAULT_TRANSFORM, type EditorProject } from "./editor-core.ts";
import { createProtectedClipConstraintSet } from "./test-support/editor-constraint-enforcement-fixture.ts";
import { editorTopicsForTextV1 } from "./editor-caption-concepts.ts";

const CREATED_AT = "2026-10-31T00:00:00.000Z";

function project(): EditorProject {
  const seedIds = ["seed-city", "seed-campus", "seed-ending"];
  const candidateIds = [
    "asset-city-night", "asset-city-night-alt",
    "asset-campus", "asset-campus-alt",
    "asset-ending", "asset-ending-alt",
  ];
  return {
    schemaVersion: 2,
    id: "music-video-linkage-project",
    title: "Music-video linkage fixture",
    updatedAt: CREATED_AT,
    durationMs: 12_000,
    ratio: "16:9",
    audioSelection: { mode: "full", sourceDurationMs: 12_000, sourceInMs: 0, sourceOutMs: 12_000, selectedDurationMs: 12_000 },
    assets: [...seedIds, ...candidateIds].map((id) => ({ id, name: `${id}.mp4`, kind: "视频", durationMs: 4_000 })),
    tracks: [{
      id: "video-main",
      type: "video",
      name: "Video",
      clips: seedIds.map((assetId, index) => ({
        id: `clip-${index}`,
        assetId,
        name: assetId,
        kind: "视频",
        trackId: "video-main",
        timelineStartMs: index * 4_000,
        timelineEndMs: (index + 1) * 4_000,
        sourceInMs: 0,
        sourceOutMs: 4_000,
        transform: { ...DEFAULT_TRANSFORM },
        speedCurve: DEFAULT_SPEED_CURVE.map((point) => ({ ...point })),
      })),
    }],
    captions: [],
  };
}

function analysis(assetId: string, concept: string, confidence = 0.96, startMs = 0, endMs = 4_000): VideoSemanticAnalysis {
  return {
    schemaVersion: VIDEO_SEMANTIC_SCHEMA_VERSION,
    assetId,
    assetDurationMs: Math.max(4_000, endMs),
    segments: [{
      id: `scene-${assetId}`,
      assetId,
      startMs,
      endMs,
      summary: `${concept} visible scene`,
      concepts: [concept],
      usability: 0.95,
      confidence,
      evidenceFrameMs: [startMs],
    }],
    analysisMethod: "local-clip",
    createdAt: CREATED_AT,
    analysisVersion: LOCAL_CLIP_ANALYSIS_VERSION,
  };
}

function segments(): readonly MusicSegmentV1[] {
  return segmentMusicForVideoLinkage({
    sourceId: "song-linkage-fixture",
    durationMs: 12_000,
    lyrics: [
      { id: "music-city", text: "夜晚的风吹过城市", semanticTags: ["city-night"], startMs: 0, endMs: 4_000 },
      { id: "music-campus", text: "校园里奔跑的身影", semanticTags: ["campus-activity"], startMs: 4_000, endMs: 8_000 },
      { id: "music-ending", text: "光亮中迎来高潮", semanticTags: ["high-energy-ending"], startMs: 8_000, endMs: 12_000 },
    ],
    sections: [
      { id: "section-intro", startMs: 0, endMs: 4_000, kind: "INTRO" },
      { id: "section-verse", startMs: 4_000, endMs: 8_000, kind: "VERSE" },
      { id: "section-chorus", startMs: 8_000, endMs: 12_000, kind: "CHORUS" },
    ],
  });
}

function scenes(): readonly VideoSceneV1[] {
  return normalizeVideoSceneIndex({
    analyses: [
      analysis("asset-city-night", "city-night"),
      analysis("asset-city-night-alt", "city-night", 0.85),
      analysis("asset-campus", "campus-activity"),
      analysis("asset-campus-alt", "campus-activity", 0.85),
      analysis("asset-ending", "high-energy-ending"),
      analysis("asset-ending-alt", "high-energy-ending", 0.85),
    ],
    rhythmSuitabilityBySceneId: {
      "scene-asset-city-night": 0.3,
      "scene-asset-city-night-alt": 0.8,
      "scene-asset-campus": 0.5,
      "scene-asset-campus-alt": 0.5,
      "scene-asset-ending": 0.9,
      "scene-asset-ending-alt": 0.4,
    },
  });
}

test("V2.5A segments timed and untimed lyrics with explicit provenance and local rhythm only", () => {
  const samples = new Float32Array(12_000);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(index * 0.11) * (index < 4_000 ? 0.15 : 0.7);
  const rhythm = analyzeAudioRhythm({ sourceId: "song-segmentation", samples, sampleRate: 1_000 });
  const timed = segmentMusicForVideoLinkage({
    sourceId: "song-segmentation",
    durationMs: 12_000,
    rhythm,
    lyrics: [
      { id: "line-1", text: "城市夜色", semanticTags: ["city-night"], startMs: 0, endMs: 4_000 },
      { id: "line-2", text: "校园活动", semanticTags: ["campus"], startMs: 4_000, endMs: 12_000 },
    ],
  });
  assert.equal(timed.length, 2);
  assert.deepEqual(timed[0].evidenceSources, ["LYRIC_TIMECODE", "LOCAL_RHYTHM"]);
  assert.notEqual(timed[0].energy, null);
  const untimed = segmentMusicForVideoLinkage({
    sourceId: "song-untimed",
    durationMs: 12_000,
    lyrics: [
      { id: "untimed-1", text: "A", semanticTags: ["a"] },
      { id: "untimed-2", text: "B", semanticTags: ["b"] },
      { id: "untimed-3", text: "C", semanticTags: ["c"] },
    ],
  });
  assert.deepEqual(untimed.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 4_000], [4_000, 8_000], [8_000, 12_000]]);
  assert.deepEqual(untimed[0].evidenceSources, ["EVEN_DISTRIBUTION"]);
  const session = segmentMusicForVideoLinkage({
    sourceId: "session-caption-audio",
    durationMs: 4_000,
    lyrics: [{ id: "caption-1", text: "城市夜景", semanticTags: ["city-night"], startMs: 0, endMs: 4_000 }],
    lyricTimingProvenance: "SESSION_EVIDENCE",
  });
  assert.deepEqual(session[0].evidenceSources, ["SESSION_EVIDENCE"]);
});

test("V2.5A normalizes real local semantic segments into a deterministic scene index", () => {
  const index = scenes();
  assert.equal(index.length, 6);
  assert.deepEqual(index.map((scene) => scene.sceneId), [...index].map((scene) => scene.sceneId).sort());
  assert.equal(index[0].evidenceSource, "local-clip");
  assert.equal(index[0].analysisVersion, LOCAL_CLIP_ANALYSIS_VERSION);
});

test("editor lyrics derive supported city, campus, and ending concepts from bounded local vocabulary", () => {
  assert.ok(editorTopicsForTextV1("夜晚城市霓虹").some(({ topic }) => topic.id === "city-night"));
  assert.ok(editorTopicsForTextV1("校园活动学生").some(({ topic }) => topic.id === "campus-activity"));
  assert.ok(editorTopicsForTextV1("结束时大家欢呼").some(({ topic }) => topic.id === "high-energy-ending"));
});

test("semantic, duration, rhythm, and reuse evidence all affect deterministic candidate ranking", () => {
  const music: MusicSegmentV1[] = [
    { id: "m-1", sourceId: "song", startMs: 0, endMs: 4_000, lyricText: "city", semanticSummary: "city", semanticTags: ["city"], sectionKind: "VERSE", energy: 0.8, evidenceSources: ["LYRIC_TIMECODE", "LOCAL_RHYTHM"] },
    { id: "m-2", sourceId: "song", startMs: 4_000, endMs: 8_000, lyricText: "city", semanticSummary: "city", semanticTags: ["city"], sectionKind: "CHORUS", energy: 0.8, evidenceSources: ["LYRIC_TIMECODE", "LOCAL_RHYTHM"] },
  ];
  const video: VideoSceneV1[] = [
    { sceneId: "s-a", assetId: "asset-a", assetDurationMs: 4_000, startMs: 0, endMs: 4_000, semanticTags: ["city"], semanticSummary: "city", usability: 1, confidence: 1, rhythmSuitability: 0.8, evidenceSource: "local-clip", analysisVersion: "v1", evidenceFrameMs: [0] },
    { sceneId: "s-b", assetId: "asset-b", assetDurationMs: 4_000, startMs: 0, endMs: 4_000, semanticTags: ["city"], semanticSummary: "city", usability: 1, confidence: 1, rhythmSuitability: 0.2, evidenceSource: "local-clip", analysisVersion: "v1", evidenceFrameMs: [0] },
  ];
  const scored = scoreMusicVideoCandidates({ musicSegments: music, videoScenes: video });
  const firstA = scored.find((candidate) => candidate.musicSegmentId === "m-1" && candidate.assetId === "asset-a")!;
  const firstB = scored.find((candidate) => candidate.musicSegmentId === "m-1" && candidate.assetId === "asset-b")!;
  assert.ok(firstA.rhythmScore! > firstB.rhythmScore!);
  assert.ok(firstA.totalScore > firstB.totalScore);
  const secondA = scored.find((candidate) => candidate.musicSegmentId === "m-2" && candidate.assetId === "asset-a")!;
  assert.equal(secondA.immediateRepeat, true);
  assert.ok(secondA.reusePenalty > firstA.reusePenalty);
  assert.deepEqual(scored, scoreMusicVideoCandidates({ musicSegments: music, videoScenes: video }));
});

test("provider-free linkage creates an auditable existing-canonical-action proposal for Human Review", () => {
  const result = buildMusicVideoTimelineProposal({ project: project(), musicSegments: segments(), videoScenes: scenes() });
  assert.equal(result.status, "READY_FOR_REVIEW");
  if (result.status !== "READY_FOR_REVIEW") return;
  assert.equal(result.evidence.musicSegmentCount, 3);
  assert.equal(result.evidence.videoSceneCount, 6);
  assert.equal(result.evidence.candidateMatchCount, 18);
  assert.equal(result.evidence.selectedMatchCount, 3);
  assert.deepEqual(result.evidence.unmatchedMusicSegmentIds, []);
  assert.equal(result.evidence.providerCalls, 0);
  assert.equal(result.evidence.networkCalls, 0);
  assert.equal(result.proposal.status, "PENDING_REVIEW");
  assert.equal(result.proposal.compiledPlan.status, "VALIDATED");
  assert.deepEqual(result.proposal.compiledPlan.canonicalPlan.actions.map((action) => action.type), [
    "MATCH_ASSET_TO_SEGMENT", "MATCH_ASSET_TO_SEGMENT", "MATCH_ASSET_TO_SEGMENT",
  ]);
  assert.deepEqual(result.evidence.selectedMatches.map((match) => match.assetId), ["asset-city-night", "asset-campus", "asset-ending"]);
  assert.ok(result.evidence.selectedMatches.every((match) => match.reasons.length === 4));

  let review = createHumanReviewState(result.proposal);
  assert.equal(review.lifecycle, "PENDING_REVIEW");
  review = reviewProposalEntry(result.proposal, review, { proposalEntryId: result.proposal.proposalEntries[0].proposalEntryId, decision: "ACCEPT" });
  review = reviewProposalEntry(result.proposal, review, { proposalEntryId: result.proposal.proposalEntries[1].proposalEntryId, decision: "REJECT" });
  review = reviewProposalEntry(result.proposal, review, {
    proposalEntryId: result.proposal.proposalEntries[2].proposalEntryId,
    decision: "MODIFY",
    selectedAssetId: "asset-ending-alt",
  });
  assert.deepEqual(review.entries.map((entry) => entry.status), ["ACCEPTED", "REJECTED", "MODIFIED"]);
  assert.equal(review.lifecycle, "READY_TO_EXECUTE");
  const executed = executeReviewedProposal({
    proposal: result.proposal,
    review,
    currentProject: project(),
    executionUpdatedAt: "2026-10-31T00:01:00.000Z",
  });
  assert.equal(executed.status, "EXECUTED");
  assert.deepEqual(executed.reviewedPlan.compiledPlan.canonicalPlan.actions.map((action) => action.assetId), [
    "asset-city-night", "asset-ending-alt",
  ]);
  assert.equal(executed.reviewedPlan.compiledPlan.canonicalPlan.actions.some((action) => action.assetId === "asset-campus"), false);
  assert.equal(executed.execution?.appliedActionCount, 2);
  assert.equal(executed.history.shouldRecord, true);
});

test("hard constraints exclude protected timeline mutations and report bounded conflicts", () => {
  const currentProject = project();
  const constraintSet = createProtectedClipConstraintSet(currentProject, "clip-0");
  const constraintContext = {
    sourceIntentVersionId: constraintSet.intentVersionId,
    sourceConstraintSetId: constraintSet.constraintSetId,
    sourceConstraintFingerprint: constraintSet.constraintFingerprint,
    resolutionIds: constraintSet.resolutionIds,
    feasibilityReportId: "fixture-feasibility",
    readiness: "READY_TO_PLAN" as const,
  };
  const result = buildMusicVideoTimelineProposal({
    project: currentProject,
    musicSegments: segments(),
    videoScenes: scenes(),
    constraintSet,
    constraintContext,
  });
  assert.equal(result.status, "READY_FOR_REVIEW");
  if (result.status !== "READY_FOR_REVIEW") return;
  assert.deepEqual(result.evidence.unmatchedMusicSegmentIds, ["music-city"]);
  assert.ok(result.evidence.protectedConflicts.length > 0);
  assert.ok(result.evidence.protectedConflicts.every((conflict) => conflict.targetClipId === "clip-0"));
  assert.equal(result.proposal.proposalEntries.some((entry) => entry.intervalId === "music-city"), false);
  assert.equal(result.proposal.trustedPreExecutionProject.tracks[0].clips[0].assetId, "seed-city");
});

test("city and campus match while teacher or logo candidates cannot replace protected ending content", () => {
  const currentProject = project();
  currentProject.assets.push(
    { id: "asset-teacher", name: "teacher.mp4", kind: "视频", durationMs: 4_000 },
    { id: "asset-logo", name: "school-logo.mp4", kind: "视频", durationMs: 4_000 },
  );
  const constraintSet = createProtectedClipConstraintSet(currentProject, "clip-2");
  const constraintContext = {
    sourceIntentVersionId: constraintSet.intentVersionId,
    sourceConstraintSetId: constraintSet.constraintSetId,
    sourceConstraintFingerprint: constraintSet.constraintFingerprint,
    resolutionIds: constraintSet.resolutionIds,
    feasibilityReportId: "fixture-feasibility",
    readiness: "READY_TO_PLAN" as const,
  };
  const videoScenes = normalizeVideoSceneIndex({ analyses: [
    analysis("asset-city-night", "city-night"),
    analysis("asset-campus", "campus-activity"),
    analysis("asset-teacher", "high-energy-ending"),
    analysis("asset-logo", "high-energy-ending"),
  ] });
  const result = buildMusicVideoTimelineProposal({
    project: currentProject,
    musicSegments: segments(),
    videoScenes,
    constraintSet,
    constraintContext,
  });
  assert.equal(result.status, "READY_FOR_REVIEW");
  if (result.status !== "READY_FOR_REVIEW") return;
  assert.deepEqual(result.evidence.selectedMatches.map((match) => match.assetId), ["asset-city-night", "asset-campus"]);
  assert.deepEqual(result.evidence.unmatchedMusicSegmentIds, ["music-ending"]);
  assert.equal(result.evidence.protectedConflicts.length, 2);
  assert.ok(result.evidence.protectedConflicts.every((conflict) => conflict.targetClipId === "clip-2"));

  let review = createHumanReviewState(result.proposal);
  result.proposal.proposalEntries.forEach((entry) => {
    review = reviewProposalEntry(result.proposal, review, { proposalEntryId: entry.proposalEntryId, decision: "ACCEPT" });
  });
  const execution = executeReviewedProposal({
    proposal: result.proposal,
    review,
    currentProject,
    executionUpdatedAt: "2026-10-31T00:02:00.000Z",
  });
  assert.equal(execution.execution?.appliedActionCount, 2);
  assert.equal(execution.execution?.postProject.tracks[0].clips[2].assetId, "seed-ending");
});

test("insufficient semantic evidence returns NOT_EVALUABLE instead of a confident match", () => {
  const noSemantic = scenes().map((scene) => ({ ...scene, semanticTags: [] }));
  const result = buildMusicVideoTimelineProposal({ project: project(), musicSegments: segments(), videoScenes: noSemantic });
  assert.equal(result.status, "NOT_EVALUABLE");
  if (result.status !== "NOT_EVALUABLE") return;
  assert.deepEqual(result.reasons, ["NO_SEMANTIC_EVIDENCE"]);
  assert.equal(result.evidence.selectedMatchCount, 0);
  assert.deepEqual(result.evidence.unmatchedMusicSegmentIds, ["music-city", "music-campus", "music-ending"]);
});

test("missing music segments and missing video scenes remain bounded NOT_EVALUABLE states", () => {
  const noMusic = buildMusicVideoTimelineProposal({ project: project(), musicSegments: [], videoScenes: scenes() });
  assert.equal(noMusic.status, "NOT_EVALUABLE");
  if (noMusic.status === "NOT_EVALUABLE") assert.deepEqual(noMusic.reasons, ["NO_MUSIC_SEGMENTS"]);
  const noVideo = buildMusicVideoTimelineProposal({ project: project(), musicSegments: segments(), videoScenes: [] });
  assert.equal(noVideo.status, "NOT_EVALUABLE");
  if (noVideo.status === "NOT_EVALUABLE") assert.deepEqual(noVideo.reasons, ["NO_VIDEO_SCENES"]);
});

test("duration-incompatible scenes and unsupported non-zero source ranges fail closed distinctly", () => {
  const shortScenes = scenes().map((scene) => ({ ...scene, endMs: 500 }));
  const durationResult = buildMusicVideoTimelineProposal({ project: project(), musicSegments: segments(), videoScenes: shortScenes });
  assert.equal(durationResult.status, "NOT_EVALUABLE");
  if (durationResult.status === "NOT_EVALUABLE") assert.ok(durationResult.reasons.includes("NO_DURATION_COMPATIBLE_SCENE"));

  const nonZero = scenes().map((scene) => ({ ...scene, startMs: 1_200, endMs: 4_000 }));
  const sourceRangeResult = buildMusicVideoTimelineProposal({ project: project(), musicSegments: segments(), videoScenes: nonZero });
  assert.equal(sourceRangeResult.status, "NOT_EVALUABLE");
  if (sourceRangeResult.status === "NOT_EVALUABLE") assert.ok(sourceRangeResult.reasons.includes("SOURCE_RANGE_UNSUPPORTED"));
});

test("wrong rhythm identity and mixed timed lyrics fail validation without provider fallback", () => {
  const rhythm = analyzeAudioRhythm({ sourceId: "other-song", samples: new Float32Array(2_000), sampleRate: 1_000 });
  assert.throws(() => segmentMusicForVideoLinkage({
    sourceId: "song",
    durationMs: 2_000,
    rhythm,
    lyrics: [{ id: "line", text: "line", semanticTags: ["line"], startMs: 0, endMs: 2_000 }],
  }), /same music source/);
  assert.throws(() => segmentMusicForVideoLinkage({
    sourceId: "song",
    durationMs: 2_000,
    lyrics: [
      { id: "line-1", text: "line", semanticTags: ["line"], startMs: 0, endMs: 1_000 },
      { id: "line-2", text: "line", semanticTags: ["line"] },
    ],
  }), /all timed or all untimed/);
});

test("linkage source contains no provider gateway, TokenHub, executor, or automatic review bypass", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = (await Promise.all([
    "./editor-music-video-evidence.ts",
    "./editor-music-video-matching.ts",
    "./editor-music-video-linkage.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")))).join("\n");
  assert.doesNotMatch(source, /TokenHub|DeepSeek|Kimi|Doubao|invokeAITask|executeReviewedProposal|applyAIEditingPlan/);
  assert.doesNotMatch(source, /AUTO_APPROVAL|REVIEW_BYPASS/);
  assert.match(source, /providerCalls:\s*0/);
  assert.match(source, /networkCalls:\s*0/);
});
