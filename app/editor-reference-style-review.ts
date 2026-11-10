import { cloneProject, type EditorProject } from "./editor-core.ts";
import { parseAIEditingPlan } from "./editor-ai-requirements.ts";
import type { CandidateMatchScore, MatchingInterval, RankedCandidateSet } from "./editor-multimodal-matching.ts";
import type { NarrativeSequencePlan } from "./editor-narrative-planner.ts";
import { createEditorProjectFingerprint, createPlanEvidence } from "./editor-plan-evidence.ts";
import type { EditorProposalBundle } from "./editor-proposal-orchestrator.ts";
import type { ReferenceEditStyleProfile, ReferenceStyleProposal, StyleCandidateScene } from "./editor-reference-style.ts";
import type { ConstraintSetV1 } from "./editor-constraints.ts";
import type { ProposalConstraintContextV1 } from "./editor-constraint-negotiation.ts";

/** Adapts the frozen V2.7A plan to the existing V2.4 review and V2.0D executor contracts. */
export function buildReferenceStyleReviewBundle(input: {
  proposal: ReferenceStyleProposal;
  profile: ReferenceEditStyleProfile;
  project: EditorProject;
  scenes: readonly StyleCandidateScene[];
  constraintSet?: ConstraintSetV1;
  constraintContext?: ProposalConstraintContextV1;
}): EditorProposalBundle {
  const { proposal, project } = input;
  const trusted = cloneProject(project);
  const assets = new Set(trusted.assets.map((asset) => asset.id));
  const sceneById = new Map(input.scenes.filter((scene) => assets.has(scene.assetId)
    && scene.assetId !== input.profile.referenceId && !scene.assetId.startsWith("reference-v1-")
    && scene.semanticScore !== null && scene.semanticScore >= 0.5).map((scene) => [scene.sceneId, scene]));
  const intervals: MatchingInterval[] = [];
  const ranked: RankedCandidateSet[] = [];
  const narratives: NarrativeSequencePlan["intervalPlans"][number][] = [];
  const actions = [] as Array<ReturnType<typeof parseAIEditingPlan>["actions"][number]>;
  const links: Array<EditorProposalBundle["compiledPlan"]["intervalActionMap"][number]> = [];
  const proposalEntries: EditorProposalBundle["proposalEntries"][number][] = [];
  const clips = new Map(trusted.tracks.flatMap((track) => track.clips).map((clip) => [clip.id, clip]));

  proposal.items.forEach((item, index) => {
    const id = item.slotId;
    const clip = item.targetClipId ? clips.get(item.targetClipId) : undefined;
    const selectedScene = item.selectedSceneId ? sceneById.get(item.selectedSceneId) : undefined;
    const start = clip?.timelineStartMs ?? item.targetStartMs;
    const end = clip?.timelineEndMs ?? item.targetEndMs;
    const interval: MatchingInterval = Object.freeze({ id, timelineStartMs: start, timelineEndMs: Math.max(start + 1, end), text: `${item.selectedSceneId ? `建议场景：${item.selectedSceneId}。` : "未匹配场景。"}${item.reasons.join("；")}`, concepts: Object.freeze([]) });
    intervals.push(interval);
    const eligibleScenes = input.scenes.filter((scene) => assets.has(scene.assetId) && scene.assetId !== input.profile.referenceId
      && !scene.assetId.startsWith("reference-v1-") && scene.semanticScore !== null && scene.semanticScore >= 0.5
      && (!selectedScene || scene.semanticSummary.trim().toLocaleLowerCase() === selectedScene.semanticSummary.trim().toLocaleLowerCase()));
    const eligibleByAsset = new Map<string, StyleCandidateScene>();
    eligibleScenes.forEach((scene) => {
      const current = eligibleByAsset.get(scene.assetId);
      const distance = Math.abs((scene.sourceEndMs - scene.sourceStartMs) - item.desiredDurationMs);
      const currentDistance = current ? Math.abs((current.sourceEndMs - current.sourceStartMs) - item.desiredDurationMs) : Number.POSITIVE_INFINITY;
      if (!current || (scene.semanticScore ?? 0) > (current.semanticScore ?? 0)
        || ((scene.semanticScore ?? 0) === (current.semanticScore ?? 0) && distance < currentDistance)) eligibleByAsset.set(scene.assetId, scene);
    });
    const eligible = [...eligibleByAsset.values()];
    const candidates: CandidateMatchScore[] = eligible.map((scene) => {
      const score = scene.semanticScore ?? 0;
      const duration = scene.sourceEndMs - scene.sourceStartMs;
      return Object.freeze({ assetId: scene.assetId, semanticScore: score, usabilityScore: score, timingScore: Math.max(0, 1 - Math.abs(duration - item.desiredDurationMs) / Math.max(duration, item.desiredDurationMs)), repetitionPenalty: 0, totalScore: score * 0.7 + (item.selectedAssetId === scene.assetId ? 0.3 : 0), matchedConcepts: Object.freeze([]), supportingSegmentIds: Object.freeze([scene.sceneId]), supportingSourceRanges: Object.freeze([{ segmentId: scene.sceneId, sourceStartMs: scene.sourceStartMs, sourceEndMs: scene.sourceEndMs, confidence: score, usability: score, matchedConcepts: Object.freeze([]) }]), evidenceFrameMs: Object.freeze([]), sourceRangePlacementLimitation: false, semanticEvidence: Object.freeze({ intervalConcepts: Object.freeze([]), conceptSupport: Object.freeze([]), aggregateConceptSupport: score, strongestSegmentSupport: score }), timingEvidence: Object.freeze({ intervalDurationMs: item.desiredDurationMs, sourceDurationMs: duration }), repetitionEvidence: Object.freeze({ usageCount: 0, immediateRepeat: false }) });
    }).sort((a, b) => b.totalScore - a.totalScore || a.assetId.localeCompare(b.assetId));
    const selected = selectedScene ? candidates.find((candidate) => candidate.assetId === selectedScene.assetId) : undefined;
    const candidateSet: RankedCandidateSet = Object.freeze({ intervalId: id, candidates: Object.freeze(candidates), ...(selected ? { selectedAssetId: selected.assetId } : {}), confidence: selected?.totalScore ?? 0 });
    ranked.push(candidateSet);
    const chosen = selected ?? candidates[0];
    if (chosen) narratives.push(Object.freeze({ status: "resolved", intervalId: id, assetId: chosen.assetId, localScore: chosen.totalScore, semanticScore: chosen.semanticScore, narrativeScore: chosen.totalScore, supportingSegmentIds: chosen.supportingSegmentIds, supportingSourceRanges: chosen.supportingSourceRanges, evidenceFrameMs: Object.freeze([]), matchEvidence: chosen, transitionEvidence: Object.freeze([]) }));
    else narratives.push(Object.freeze({ status: "unresolved", intervalId: id, narrativeScore: 0, reason: "NO_ACCEPTED_V2_0A_CANDIDATE" }));
    const action = !item.protected && clip && item.canonicalAction && item.selectedAssetId && selectedScene ? item.canonicalAction : undefined;
    const actionIndex = action ? actions.push(action) - 1 : undefined;
    links.push(Object.freeze({ intervalId: id, narrativePlanIndex: index, status: action ? "COMPILED" : clip ? "NO_ACTION_REQUIRED" : "UNRESOLVED", ...(item.selectedAssetId ? { selectedAssetId: item.selectedAssetId } : {}), ...(clip ? { targetClipId: clip.id } : {}), ...(actionIndex === undefined ? {} : { actionIndex, actionType: "MATCH_ASSET_TO_SEGMENT" as const }), supportingSegmentIds: Object.freeze(selectedScene ? [selectedScene.sceneId] : []), narrativeReasonCodes: Object.freeze([]) }));
    proposalEntries.push(Object.freeze({ proposalEntryId: "", intervalId: id, ...(actionIndex === undefined ? {} : { actionIndex }), ...(clip ? { targetId: clip.id } : {}), ...(item.selectedAssetId ? { selectedAssetId: item.selectedAssetId } : {}), candidateAlternativeAssetIds: Object.freeze(candidates.filter((candidate) => candidate.assetId !== item.selectedAssetId).map((candidate) => candidate.assetId)) }));
  });
  const narrativePlan: NarrativeSequencePlan = Object.freeze({ intervalPlans: Object.freeze(narratives), totalLocalScore: 0, totalNarrativeScore: 0, totalSequenceScore: 0, totalSemanticScore: 0, totalSequenceRepetitionPenalty: 0, unresolvedIntervalIds: Object.freeze(narratives.filter((item) => item.status === "unresolved").map((item) => item.intervalId)) });
  const canonicalPlan = parseAIEditingPlan({ summary: "Human-reviewed reference style plan; reference media is analysis-only.", actions, unsupported: [], warnings: proposal.conflicts.map((conflict) => conflict.detail).slice(0, 24) });
  const compiledPlan: EditorProposalBundle["compiledPlan"] = Object.freeze({ schemaVersion: 1, mode: "INITIAL_PLAN", status: "VALIDATED", sourceNarrativeReference: proposal.proposalId, canonicalPlan, intervalActionMap: Object.freeze(links), unresolvedIntervalIds: Object.freeze([]), unsupportedIntervalIds: Object.freeze([]), warnings: Object.freeze([]), errors: Object.freeze([]), canonicalValidation: Object.freeze({ parser: "parseAIEditingPlan", valid: true }) });
  const planEvidence = createPlanEvidence({ intervals, rankedCandidateSets: ranked, narrativePlan, compiledPlan, preExecutionProject: trusted, ...(input.constraintSet ? { constraintSet: input.constraintSet } : {}) });
  const alignedEntries = proposalEntries.map((entry, index) => Object.freeze({ ...entry, proposalEntryId: planEvidence.entries[index].proposalEntryId }));
  return Object.freeze({ schemaVersion: 1, proposalId: proposal.proposalId, status: "PENDING_REVIEW", sourceProjectFingerprint: createEditorProjectFingerprint(trusted), matchingIntervals: Object.freeze(intervals), rankedCandidateSets: Object.freeze(ranked), narrativePlan, compiledPlan, trustedPreExecutionProject: trusted, planEvidence, proposalEntries: Object.freeze(alignedEntries), evidenceMetadata: Object.freeze({ videoAnalysisVersions: Object.freeze(["reference-style-planner-v1"]), providerCalls: 0, networkCalls: 0, ...(input.constraintContext ? { constraintContext: input.constraintContext } : {}) }), ...(input.constraintSet ? { constraintSet: input.constraintSet } : {}) });
}
