import type { EditorProject } from "../editor-core.ts";
import { analyzeAudioRhythm } from "../editor-audio-rhythm.ts";
import {
  generateEditorProposal,
  type EditorProposalBundle,
  type EditorProposalInput,
} from "../editor-proposal-orchestrator.ts";
import {
  createHumanReviewState,
  executeReviewedProposal,
  reviewProposalEntry,
  type ReviewedProposalExecution,
} from "../editor-proposal-review.ts";
import {
  LOCAL_CLIP_ANALYSIS_VERSION,
  VIDEO_SEMANTIC_SCHEMA_VERSION,
  type VideoSemanticAnalysis,
} from "../editor-video-semantic.ts";

export const REVIEW_FIXTURE_CREATED_AT = "2026-10-25T00:00:00.000Z";
export const REVIEW_FIXTURE_CONCEPTS = ["consultation", "anatomy", "ecg", "treatment", "recovery"] as const;
const actions = ["consultation", "explanation", "examination", "treatment", "recovery"] as const;

function analysis(assetId: string, concept: string, action: string, confidence = 0.95): VideoSemanticAnalysis {
  return {
    schemaVersion: VIDEO_SEMANTIC_SCHEMA_VERSION,
    assetId,
    assetDurationMs: 4_000,
    segments: [{
      id: `segment-${assetId}`,
      assetId,
      startMs: 0,
      endMs: 3_800,
      summary: `${concept} evidence`,
      concepts: [concept],
      action,
      usability: 0.95,
      confidence,
      evidenceFrameMs: [100],
    }],
    analysisMethod: "local-clip",
    createdAt: REVIEW_FIXTURE_CREATED_AT,
    analysisVersion: LOCAL_CLIP_ANALYSIS_VERSION,
  };
}

export function createMedicalReviewInput(): EditorProposalInput {
  const seedIds = REVIEW_FIXTURE_CONCEPTS.map((_, index) => `seed-${index}`);
  const targetIds = REVIEW_FIXTURE_CONCEPTS.map((concept) => `asset-${concept}`);
  const allIds = [...seedIds, ...targetIds, "asset-ecg-alt", "asset-ecg-rejected"];
  const project: EditorProject = {
    schemaVersion: 2,
    id: "medical-human-review-project",
    title: "Medical human review state",
    updatedAt: REVIEW_FIXTURE_CREATED_AT,
    durationMs: 10_000,
    ratio: "16:9",
    audioSelection: { mode: "full", sourceDurationMs: 10_000, sourceInMs: 0, sourceOutMs: 10_000, selectedDurationMs: 10_000 },
    assets: allIds.map((id) => ({ id, name: `Friendly ${id}`, kind: "视频", durationMs: 4_000 })),
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
    captions: REVIEW_FIXTURE_CONCEPTS.map((concept, index) => ({
      id: `interval-${concept}`,
      text: `Medical ${concept}`,
      startMs: index * 2_000,
      endMs: (index + 1) * 2_000,
    })),
  };
  const videoAnalyses = [
    ...seedIds.map((assetId) => analysis(assetId, "unrelated", "background", 0.1)),
    ...targetIds.map((assetId, index) => analysis(assetId, REVIEW_FIXTURE_CONCEPTS[index], actions[index])),
    analysis("asset-ecg-alt", "ecg", "examination", 0.86),
    analysis("asset-ecg-rejected", "ecg", "examination", 0.1),
  ];
  const samples = new Float32Array(10_000);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(index * 0.31) * 0.2;
  return {
    project,
    videoAnalyses,
    rhythm: analyzeAudioRhythm({
      sourceId: "audio-medical-review",
      samples,
      sampleRate: 1_000,
      speechRegions: [
        { startMs: 0, endMs: 1_900 },
        { startMs: 2_100, endMs: 3_900 },
        { startMs: 4_100, endMs: 5_900 },
        { startMs: 6_100, endMs: 7_900 },
        { startMs: 8_100, endMs: 10_000 },
      ],
    }),
    captionConcepts: project.captions.map((caption, index) => ({ captionId: caption.id, concepts: [REVIEW_FIXTURE_CONCEPTS[index]] })),
  };
}

export function createMedicalReviewProposal(): EditorProposalBundle {
  const result = generateEditorProposal(createMedicalReviewInput());
  if (!result.ok) throw new Error(`Medical review fixture failed: ${result.status}`);
  return result.bundle;
}

export function createMedicalReviewedExecution(): Readonly<{
  input: EditorProposalInput;
  proposal: EditorProposalBundle;
  result: ReviewedProposalExecution;
}> {
  const input = createMedicalReviewInput();
  const generated = generateEditorProposal(input);
  if (!generated.ok) throw new Error(`Medical review fixture failed: ${generated.status}`);
  const proposal = generated.bundle;
  let review = createHumanReviewState(proposal);
  const decide = (index: number, decision: "ACCEPT" | "REJECT" | "MODIFY", selectedAssetId?: string) => {
    review = reviewProposalEntry(proposal, review, {
      proposalEntryId: proposal.proposalEntries[index].proposalEntryId,
      decision,
      ...(selectedAssetId ? { selectedAssetId } : {}),
    });
  };
  decide(0, "ACCEPT");
  decide(1, "ACCEPT");
  decide(2, "MODIFY", "asset-ecg-alt");
  decide(3, "REJECT");
  decide(4, "ACCEPT");
  const result = executeReviewedProposal({
    proposal,
    review,
    currentProject: proposal.trustedPreExecutionProject,
    executionUpdatedAt: "2026-10-25T03:00:00.000Z",
  });
  return Object.freeze({ input, proposal, result });
}
