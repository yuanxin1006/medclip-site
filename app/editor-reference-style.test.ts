import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { EditorProject } from "./editor-core.ts";
import type { VideoSemanticAnalysis } from "./editor-video-semantic.ts";
import {
  REFERENCE_STYLE_ANALYSIS_VERSION,
  REFERENCE_STYLE_PROFILE_VERSION,
  ReferenceObjectUrlOwner,
  buildReferenceStylePlanningInputs,
  classifyReferenceVideoInput,
  createReferenceEditStyleProfile,
  createReferenceVideoIdentity,
  detectReferenceCuts,
  evaluateReferenceStyleFit,
  normalizeStyleDurations,
  planReferenceStyleTransfer,
  type ReferenceFrameSignature,
  type ReferenceVideoEvidence,
  type StyleCandidateScene,
  type StyleTargetClip,
} from "./editor-reference-style.ts";

const durationMs = 12_000;
const sceneLevels = [0, 0, 0.3, 0.3, 0.6, 0.6, 0.6, 0.9, 0.9, 0.1, 0.1, 0.1];
const frames: ReferenceFrameSignature[] = sceneLevels.map((level, index) => ({
  timestampMs: index * 1_000,
  values: [level, level, level, level],
}));
const cuts = detectReferenceCuts(frames);
const evidence: ReferenceVideoEvidence = {
  version: 1,
  id: "reference-v1-1234abcd",
  durationMs,
  analysisVersion: REFERENCE_STYLE_ANALYSIS_VERSION,
  analysisOnly: true,
  cutBoundaries: cuts,
  frameSampleCounts: { coarse: frames.length, fine: 20 },
};
const profile = createReferenceEditStyleProfile(evidence);

test("V2.7A classifies one local reference as analysis-only and rejects unsafe input", () => {
  assert.deepEqual(classifyReferenceVideoInput({ name: "style.mp4", type: "video/mp4", size: 100 }), {
    eligible: true,
    role: "REFERENCE_ANALYSIS_ONLY",
    entersEditableAssetPool: false,
    reason: null,
  });
  assert.equal(classifyReferenceVideoInput({ name: "empty.mp4", type: "video/mp4", size: 0 }).eligible, false);
  assert.equal(classifyReferenceVideoInput({ name: "mime-missing.mov", type: "", size: 100 }).eligible, true);
  assert.equal(classifyReferenceVideoInput({ name: "image.png", type: "image/png", size: 100 }).eligible, false);
  assert.equal(classifyReferenceVideoInput({ name: "video.exe", type: "video/mp4", size: 100 }).eligible, false);
});

test("V2.7A reference identity is deterministic and contains no Blob URL", () => {
  const input = { name: "reference.mp4", size: 4_096, lastModified: 1_700_000_000_000, durationMs };
  const first = createReferenceVideoIdentity(input);
  assert.equal(first, createReferenceVideoIdentity(input));
  assert.match(first, /^reference-v1-[0-9a-f]{8}$/);
  assert.doesNotMatch(first, /blob:|https?:|\\|\//);
});

test("V2.7A detects ordered deterministic hard cuts with retained score evidence", () => {
  assert.deepEqual(cuts.map((cut) => cut.timestampMs), [2_000, 4_000, 7_000, 9_000]);
  assert.ok(cuts.every((cut) => cut.changeScore >= 0.16 && cut.provenance === "MEASURED"));
  assert.deepEqual(detectReferenceCuts([...frames].reverse()), cuts);
  const closeChanges = detectReferenceCuts([
    { timestampMs: 0, values: [0] },
    { timestampMs: 1_000, values: [0.3] },
    { timestampMs: 1_100, values: [1] },
  ]);
  assert.deepEqual(closeChanges.map((cut) => cut.timestampMs), [1_100]);
});

test("V2.7A calculates exact shot durations, mean, median, and bounded distribution", () => {
  assert.equal(profile.version, REFERENCE_STYLE_PROFILE_VERSION);
  assert.deepEqual(profile.cutCadence.shotDurationsMs, [2_000, 2_000, 3_000, 2_000, 3_000]);
  assert.equal(profile.cutCadence.cutCount, 4);
  assert.equal(profile.cutCadence.meanShotDurationMs, 2_400);
  assert.equal(profile.cutCadence.medianShotDurationMs, 2_000);
  assert.equal(
    profile.cutCadence.shortShotRatio + profile.cutCadence.mediumShotRatio + profile.cutCadence.longShotRatio,
    1,
  );
});

test("V2.7A derives pacing and bounded rhythm while complex transitions remain NOT_EVALUABLE", () => {
  assert.equal(profile.pacing.sections.length, 4);
  assert.ok(profile.pacing.sections.every((section, index) => section.index === index && section.provenance === "DERIVED"));
  assert.equal(profile.rhythm.audioRelationship, "NOT_EVALUABLE");
  assert.equal(profile.transitions.hardCutCount, 4);
  assert.equal(profile.transitions.otherTransitionTypes, "NOT_EVALUABLE");
});

test("V2.7A style profile output is deterministic", () => {
  assert.deepEqual(createReferenceEditStyleProfile(structuredClone(evidence)), profile);
  assert.equal(JSON.stringify(createReferenceEditStyleProfile(evidence)), JSON.stringify(profile));
});

test("V2.7A normalizes style to a different target duration instead of copying timestamps", () => {
  const durations = normalizeStyleDurations(profile, 8_000);
  assert.equal(durations.reduce((sum, value) => sum + value, 0), 8_000);
  assert.equal(durations.length, 3);
  assert.notDeepEqual(durations, profile.cutCadence.shotDurationsMs);
  assert.ok(durations.every((value) => value >= 100));
});

const targetClips: StyleTargetClip[] = [
  { clipId: "clip-a", assetId: "asset-a", timelineStartMs: 0, timelineEndMs: 2_500 },
  { clipId: "clip-protected", assetId: "asset-protected", timelineStartMs: 2_500, timelineEndMs: 5_500 },
  { clipId: "clip-c", assetId: "asset-c", timelineStartMs: 5_500, timelineEndMs: 8_000 },
];
const scenes: StyleCandidateScene[] = [
  { sceneId: "reference-scene", assetId: evidence.id, sourceStartMs: 0, sourceEndMs: 3_000, semanticSummary: "forbidden", semanticScore: 1, semanticProvenance: "VIDEO_SEMANTIC_EVIDENCE" },
  { sceneId: "semantic-best", assetId: "asset-best", sourceStartMs: 0, sourceEndMs: 7_000, semanticSummary: "best semantic match", semanticScore: 0.95, semanticProvenance: "VIDEO_SEMANTIC_EVIDENCE" },
  { sceneId: "duration-best", assetId: "asset-duration", sourceStartMs: 0, sourceEndMs: 2_500, semanticSummary: "duration fit", semanticScore: 0.5, semanticProvenance: "VIDEO_SEMANTIC_EVIDENCE" },
  { sceneId: "protected-original", assetId: "asset-protected", sourceStartMs: 0, sourceEndMs: 3_000, semanticSummary: "protected", semanticScore: 0.1, semanticProvenance: "VIDEO_SEMANTIC_EVIDENCE" },
  { sceneId: "third-scene", assetId: "asset-third", sourceStartMs: 0, sourceEndMs: 2_000, semanticSummary: "third", semanticScore: 0.4, semanticProvenance: "VIDEO_SEMANTIC_EVIDENCE" },
];

test("V2.7A planner preserves semantic-content priority and never selects reference media", () => {
  const result = planReferenceStyleTransfer({
    profile,
    targetDurationMs: 8_000,
    targetClips,
    candidateScenes: scenes,
    referenceId: evidence.id,
  });
  assert.equal(result.status, "READY_FOR_REVIEW");
  if (result.status !== "READY_FOR_REVIEW") return;
  assert.equal(result.proposal.items[0].selectedSceneId, "semantic-best");
  assert.ok(result.proposal.items.every((item) => item.selectedAssetId !== evidence.id));
  assert.ok(result.proposal.canonicalPlan.actions.every((action) => action.assetId !== evidence.id));
  assert.deepEqual(result.proposal.referenceMediaExclusion, {
    assetUsedInOutput: false,
    audioUsedInOutput: false,
    frameUsedInOutput: false,
  });
});

test("V2.7A hard constraints move style cuts and preserve protected clips without actions", () => {
  const result = planReferenceStyleTransfer({
    profile,
    targetDurationMs: 8_000,
    targetClips,
    candidateScenes: scenes,
    protectedRanges: [{ id: "teacher-speech", startMs: 2_500, endMs: 5_500, clipId: "clip-protected", assetId: "asset-protected" }],
    referenceId: evidence.id,
  });
  assert.equal(result.status, "READY_FOR_REVIEW");
  if (result.status !== "READY_FOR_REVIEW") return;
  const protectedItem = result.proposal.items.find((item) => item.targetClipId === "clip-protected");
  assert.equal(protectedItem?.protected, true);
  assert.equal(protectedItem?.selectedAssetId, "asset-protected");
  assert.equal(protectedItem?.canonicalAction, undefined);
  assert.ok(result.proposal.conflicts.some((conflict) => conflict.code === "PROTECTED_SLOT_PRESERVED"));
  assert.ok(result.proposal.canonicalPlan.actions.every((action) => action.targetId !== "clip-protected"));
});

test("V2.7A proposal is pending Human Review and reuses only existing canonical action types", () => {
  const result = planReferenceStyleTransfer({ profile, targetDurationMs: 8_000, targetClips, candidateScenes: scenes, referenceId: evidence.id });
  assert.equal(result.status, "READY_FOR_REVIEW");
  if (result.status !== "READY_FOR_REVIEW") return;
  assert.equal(result.proposal.humanReviewCompatible, true);
  assert.equal(result.proposal.autoExecuted, false);
  assert.equal(result.proposal.status, "PENDING_HUMAN_REVIEW");
  assert.equal(result.proposal.humanReview.schemaVersion, 1);
  assert.equal(result.proposal.humanReview.proposalId, result.proposal.proposalId);
  assert.equal(result.proposal.humanReview.lifecycle, "PENDING_REVIEW");
  assert.equal(result.proposal.humanReview.entries.length, result.proposal.items.length);
  assert.ok(result.proposal.humanReview.entries.every((entry) => entry.status === "PENDING"));
  assert.ok(result.proposal.canonicalPlan.actions.every((action) => ["MATCH_ASSET_TO_SEGMENT", "TRIM_CLIP", "SPLIT_CLIP", "REORDER_CLIP", "SET_CLIP_PLAYBACK_SPEED"].includes(action.type)));
  assert.ok(result.proposal.items.every((item) => item.reasons.length >= 2));
});

test("V2.7A style-fit score has a documented deterministic three-component formula", () => {
  const durations = normalizeStyleDurations(profile, 8_000);
  const fit = evaluateReferenceStyleFit(profile, durations, 8_000);
  assert.equal(fit.formula, "ARITHMETIC_MEAN_OF_THREE_DOCUMENTED_COMPONENTS");
  assert.ok(fit.score >= 0 && fit.score <= 1);
  assert.equal(fit.score, evaluateReferenceStyleFit(profile, durations, 8_000).score);
  assert.deepEqual(Object.keys(fit.components).sort(), ["cutDensity", "pacingSections", "shotDurationDistribution"]);
});

test("V2.7A returns bounded NOT_EVALUABLE states", () => {
  assert.equal(planReferenceStyleTransfer({ profile, targetDurationMs: 0, targetClips, candidateScenes: scenes, referenceId: evidence.id }).status, "NOT_EVALUABLE");
  assert.equal(planReferenceStyleTransfer({ profile, targetDurationMs: 8_000, targetClips, candidateScenes: [], referenceId: evidence.id }).status, "NOT_EVALUABLE");
  const allProtected = planReferenceStyleTransfer({
    profile,
    targetDurationMs: 8_000,
    targetClips,
    candidateScenes: scenes,
    protectedRanges: [{ id: "all", startMs: 0, endMs: 8_000 }],
    referenceId: evidence.id,
  });
  assert.deepEqual(allProtected, { status: "NOT_EVALUABLE", reason: "HARD_CONSTRAINTS_PREVENT_STYLE_TRANSFER", message: "All target slots are protected." });
});

test("V2.7A derives planning inputs only from project-owned assets and existing semantic evidence", () => {
  const project: EditorProject = {
    schemaVersion: 2,
    id: "project",
    title: "fixture",
    updatedAt: "2026-10-31T00:00:00.000Z",
    durationMs: 8_000,
    ratio: "16:9",
    audioSelection: { mode: "full", sourceDurationMs: 8_000, sourceInMs: 0, sourceOutMs: 8_000, selectedDurationMs: 8_000 },
    assets: [
      { id: "owned", name: "owned.mp4", kind: "视频" as EditorProject["assets"][number]["kind"], durationMs: 8_000 },
      { id: "fallback", name: "fallback.mp4", kind: "视频" as EditorProject["assets"][number]["kind"], durationMs: 4_000 },
    ],
    tracks: [{ id: "video", type: "video", name: "video", locked: true, clips: [{
      id: "clip", assetId: "owned", name: "owned", kind: "视频" as EditorProject["tracks"][number]["clips"][number]["kind"], trackId: "video",
      timelineStartMs: 0, timelineEndMs: 8_000, sourceInMs: 0, sourceOutMs: 8_000,
      transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" }, speedCurve: [{ id: "start", at: 0, rate: 1 }, { id: "end", at: 1, rate: 1 }],
    }]}],
    captions: [], overlays: [], secondaryAudioClips: [],
  };
  const analysis: VideoSemanticAnalysis = {
    schemaVersion: 1,
    assetId: "owned",
    assetDurationMs: 8_000,
    analysisMethod: "local-clip",
    createdAt: "2026-10-31T00:00:00.000Z",
    analysisVersion: "test",
    segments: [{ id: "scene", assetId: "owned", startMs: 0, endMs: 4_000, summary: "medical explanation", concepts: ["medical"], usability: 0.8, confidence: 0.9, evidenceFrameMs: [1_000] }],
  };
  const inputs = buildReferenceStylePlanningInputs(project, [analysis, { ...analysis, assetId: "foreign", segments: [] }]);
  assert.deepEqual(inputs.targetClips.map((clip) => clip.clipId), ["clip"]);
  assert.deepEqual(inputs.candidateScenes.map((scene) => [scene.assetId, scene.semanticProvenance]), [
    ["owned", "VIDEO_SEMANTIC_EVIDENCE"],
    ["fallback", "USER_ASSET_FALLBACK"],
  ]);
  assert.deepEqual(inputs.protectedRanges.map((range) => [range.clipId, range.startMs, range.endMs]), [["clip", 0, 8_000]]);
});

test("V2.7A reference Blob URL ownership revokes on replacement, removal, and unmount", () => {
  const revoked: string[] = [];
  const owner = new ReferenceObjectUrlOwner((url) => revoked.push(url));
  owner.replace("blob:first");
  owner.replace("blob:second");
  owner.clear();
  owner.replace("blob:third");
  owner.dispose();
  assert.deepEqual(revoked, ["blob:first", "blob:second", "blob:third"]);
  assert.equal(owner.current, "");
  assert.throws(() => owner.replace("https://example.test/reference.mp4"), /owned blob/);
});

test("V2.7A production wiring keeps reference evidence outside assets and never auto-executes", () => {
  const source = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  assert.match(source, /accept="video\/mp4,video\/webm,video\/quicktime,video\/x-m4v"/);
  assert.match(source, /analyzeReferenceVideoFile/);
  assert.match(source, /buildReferenceStylePlanningInputs/);
  assert.match(source, /planReferenceStyleTransfer/);
  assert.doesNotMatch(source, /setAssets\([\s\S]{0,160}referenceStyle/);
  assert.doesNotMatch(source, /applyAIEditingPlan\([\s\S]{0,240}referenceStyle/);
});
