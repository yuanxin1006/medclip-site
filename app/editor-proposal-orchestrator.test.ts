import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { EditorProject } from "./editor-core.ts";
import { analyzeAudioRhythm } from "./editor-audio-rhythm.ts";
import {
  generateEditorProposal,
  isEditorProposalCurrent,
  type EditorProposalInput,
} from "./editor-proposal-orchestrator.ts";
import {
  LOCAL_CLIP_ANALYSIS_VERSION,
  VIDEO_SEMANTIC_SCHEMA_VERSION,
  type VideoSemanticAnalysis,
} from "./editor-video-semantic.ts";

const createdAt = "2026-10-24T00:00:00.000Z";
const concepts = ["consultation", "anatomy", "ecg", "treatment", "recovery"] as const;
const actions = ["consultation", "explanation", "examination", "treatment", "recovery"] as const;

function analysis(
  assetId: string,
  concept: string,
  action: string,
  confidence = 0.95,
  sourceStartMs = 0,
): VideoSemanticAnalysis {
  return {
    schemaVersion: VIDEO_SEMANTIC_SCHEMA_VERSION,
    assetId,
    assetDurationMs: 4_000,
    segments: [{
      id: `segment-${assetId}`,
      assetId,
      startMs: sourceStartMs,
      endMs: sourceStartMs ? 4_000 : 3_800,
      summary: `${concept} evidence`,
      concepts: [concept],
      action,
      usability: 0.95,
      confidence,
      evidenceFrameMs: [sourceStartMs + 100],
    }],
    analysisMethod: "local-clip",
    createdAt,
    analysisVersion: LOCAL_CLIP_ANALYSIS_VERSION,
  };
}

function medicalInput(): EditorProposalInput {
  const seedIds = concepts.map((_, index) => `seed-${index}`);
  const targetIds = concepts.map((concept) => `asset-${concept}`);
  const allIds = [...seedIds, ...targetIds];
  const project: EditorProject = {
    schemaVersion: 2,
    id: "medical-production-project",
    title: "Medical production-style state",
    updatedAt: createdAt,
    durationMs: 10_000,
    ratio: "16:9",
    audioSelection: { mode: "full", sourceDurationMs: 10_000, sourceInMs: 0, sourceOutMs: 10_000, selectedDurationMs: 10_000 },
    assets: allIds.map((id) => ({ id, name: id, kind: "视频", durationMs: 4_000 })),
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
        timelineStartMs: index * 2_000,
        timelineEndMs: (index + 1) * 2_000,
        sourceInMs: 0,
        sourceOutMs: 2_000,
        transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
        speedCurve: [{ id: "s0", at: 0, rate: 1 }, { id: "s1", at: 1, rate: 1 }],
      })),
    }],
    captions: concepts.map((concept, index) => ({
      id: `interval-${concept}`,
      text: `Medical ${concept}`,
      startMs: index * 2_000,
      endMs: (index + 1) * 2_000,
    })),
  };
  const videoAnalyses = [
    ...seedIds.map((assetId) => analysis(assetId, "unrelated", "background", 0.1)),
    ...targetIds.map((assetId, index) => analysis(assetId, concepts[index], actions[index])),
  ];
  const samples = new Float32Array(10_000);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(index * 0.31) * 0.2;
  const rhythm = analyzeAudioRhythm({ sourceId: "audio-medical", samples, sampleRate: 1_000 });
  return {
    project,
    videoAnalyses,
    rhythm,
    captionConcepts: project.captions.map((caption, index) => ({ captionId: caption.id, concepts: [concepts[index]] })),
  };
}

test("A-Q: real V2.0A/B/C handoff creates a deterministic five-entry pending medical proposal without mutation", () => {
  const input = medicalInput();
  const before = structuredClone(input.project);
  const history: EditorProject[] = [];
  const result = generateEditorProposal(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "READY_FOR_REVIEW");
  assert.equal(result.bundle.status, "PENDING_REVIEW");
  assert.equal(result.bundle.matchingIntervals.length, 5);
  assert.equal(result.bundle.rankedCandidateSets.length, 5);
  assert.equal(result.bundle.rankedCandidateSets.every((set) => Boolean(set.selectedAssetId)), true);
  assert.equal(result.bundle.narrativePlan.intervalPlans.length, 5);
  assert.equal(result.bundle.compiledPlan.status, "VALIDATED");
  assert.equal(result.bundle.compiledPlan.canonicalPlan.actions.length, 5);
  assert.equal(result.bundle.proposalEntries.length, 5);
  assert.equal(result.bundle.planEvidence.lifecycleStatus, "PENDING_REVIEW");
  assert.equal(result.bundle.planEvidence.entries.every((entry) => entry.status === "PENDING_REVIEW"), true);
  assert.equal(result.bundle.planEvidence.entries.every((entry) => entry.currentProposed?.currentAssetId?.startsWith("seed-") && entry.currentProposed.proposedAssetId?.startsWith("asset-")), true);
  assert.equal(result.bundle.planEvidence.entries.every((entry) => entry.beforeAfter === undefined && entry.actionResultStatus === undefined && entry.failureCode === undefined), true);
  assert.equal(result.bundle.planEvidence.summary.execution, undefined);
  assert.equal(result.bundle.evidenceMetadata.audioRhythmSourceId, "audio-medical");
  assert.equal(result.bundle.evidenceMetadata.networkCalls, 0);
  assert.equal(result.bundle.evidenceMetadata.providerCalls, 0);
  assert.deepEqual(input.project, before);
  assert.equal(input.project.updatedAt, createdAt);
  assert.equal(history.length, 0);
  const again = generateEditorProposal(input);
  assert.equal(again.ok, true);
  if (again.ok) assert.deepEqual(again.bundle, result.bundle);
});

test("proposal entries retain stable review references and alternatives without recomputation", () => {
  const result = generateEditorProposal(medicalInput());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.bundle.proposalEntries.every((entry, index) =>
    entry.proposalEntryId === result.bundle.planEvidence.entries[index].proposalEntryId
      && entry.intervalId === result.bundle.matchingIntervals[index].id
      && entry.actionIndex === index
      && entry.targetId === `clip-${index}`
      && Boolean(entry.selectedAssetId)
      && entry.candidateAlternativeAssetIds.length > 0), true);
});

test("missing intervals and missing current-session semantic evidence fail explicitly", () => {
  const withoutCaptions = medicalInput();
  withoutCaptions.project.captions = [];
  const noIntervals = generateEditorProposal(withoutCaptions);
  assert.deepEqual([noIntervals.ok, noIntervals.status], [false, "MISSING_INTERVALS"]);

  const missingEvidence = medicalInput();
  const missingAssetId = missingEvidence.project.assets[0].id;
  const missing = generateEditorProposal({ ...missingEvidence, videoAnalyses: missingEvidence.videoAnalyses.filter((item) => item.assetId !== missingAssetId) });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, "MISSING_VIDEO_EVIDENCE");
  if (!missing.ok) assert.deepEqual(missing.assetIds, [missingAssetId]);
});

test("low confidence and partially unresolved intervals preserve V2.0A rejection behavior", () => {
  const low = medicalInput();
  const lowResult = generateEditorProposal({
    ...low,
    videoAnalyses: low.videoAnalyses.map((item) => ({ ...item, segments: item.segments.map((segment) => ({ ...segment, confidence: 0.1 })) })),
  });
  assert.equal(lowResult.ok, false);
  assert.equal(lowResult.status, "NO_VALID_CANDIDATE");

  const partial = medicalInput();
  const partialResult = generateEditorProposal({
    ...partial,
    videoAnalyses: partial.videoAnalyses.map((item) => item.assetId === "asset-ecg"
      ? analysis(item.assetId, "not-ecg", "background", 0.1)
      : item),
  });
  assert.equal(partialResult.ok, false);
  assert.equal(partialResult.status, "UNRESOLVED_INTERVAL");
  if (!partialResult.ok) assert.deepEqual(partialResult.intervalIds, ["interval-ecg"]);
});

test("unsupported non-zero source placement is rejected by the real V2.0C policy", () => {
  const input = medicalInput();
  const result = generateEditorProposal({
    ...input,
    videoAnalyses: input.videoAnalyses.map((item) => item.assetId === "asset-treatment"
      ? analysis(item.assetId, "treatment", "treatment", 0.95, 1_500)
      : item),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "SOURCE_RANGE_UNSUPPORTED");
  if (!result.ok) assert.deepEqual(result.intervalIds, ["interval-treatment"]);
});

test("project/manual changes invalidate proposal identity rather than rebasing", () => {
  const input = medicalInput();
  const result = generateEditorProposal(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(isEditorProposalCurrent(result.bundle, input.project), true);
  const changed = structuredClone(input.project);
  changed.tracks[0].clips[0].assetId = "asset-consultation";
  changed.updatedAt = "2026-10-24T00:01:00.000Z";
  assert.equal(isEditorProposalCurrent(result.bundle, changed), false);
});

test("production orchestrator contains no executor, provider, network, fixture, or AI apply path", () => {
  const source = readFileSync(new URL("./editor-proposal-orchestrator.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /executeCompiledNarrativeActionPlan|applyAIEditingPlan|runAITask|fetch\s*\(|DeepSeek|Kimi|Doubao|TokenHub/i);
  assert.doesNotMatch(source, /fixture|demo/i);
  assert.match(source, /buildMultimodalCandidateTable/);
  assert.match(source, /planNarrativeSequence/);
  assert.match(source, /compileNarrativeActionPlan/);

  const studio = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  const proposalHandler = studio.slice(studio.indexOf("const generateProductionProposal"), studio.indexOf("const handleProposalReviewDecision"));
  assert.match(proposalHandler, /generateCollaborativeEditingOptionsV1/);
  assert.match(proposalHandler, /providerGenerationBudget: 0/);
  assert.doesNotMatch(proposalHandler, /applyAIEditingPlan|executeCompiledNarrativeActionPlan|runAITask|setEditorProject|setEditorAIUndoProject/);
  assert.match(studio, /evidence=\{reviewedPlanEvidence \?\? editorProposal\?\.planEvidence \?\? null\}/);
  assert.match(studio, /生成 AI 剪辑建议/);
});
