import {
  REPETITION_PENALTY_MODEL,
  SOURCE_START_PLACEMENT_TOLERANCE_MS,
} from "./editor-multimodal-matching.ts";
import {
  assertMusicVideoIdentity,
  roundMusicVideoScore,
  type MusicSegmentV1,
  type VideoSceneV1,
} from "./editor-music-video-evidence.ts";

export const MUSIC_VIDEO_LINKAGE_SCORE_WEIGHTS = Object.freeze({
  semantic: 0.45,
  duration: 0.20,
  usability: 0.15,
  rhythm: 0.15,
  repetitionPenalty: 0.05,
});

export type MusicVideoNotEvaluableReasonV1 =
  | "NO_MUSIC_SEGMENTS"
  | "NO_VIDEO_SCENES"
  | "NO_SEMANTIC_EVIDENCE"
  | "NO_DURATION_COMPATIBLE_SCENE"
  | "HARD_CONSTRAINT_CONFLICT"
  | "ALL_CANDIDATES_REJECTED"
  | "NO_TIMELINE_SLOT"
  | "SOURCE_RANGE_UNSUPPORTED"
  | "STALE_CONSTRAINT_CONTEXT"
  | "COMPILATION_REJECTED";

export type MusicVideoCandidateEvidenceV1 = Readonly<{
  musicSegmentId: string;
  sceneId: string;
  assetId: string;
  semanticScore: number;
  durationScore: number;
  rhythmScore: number | null;
  usabilityScore: number;
  usageCount: number;
  immediateRepeat: boolean;
  reusePenalty: number;
  totalScore: number;
  matchedTags: readonly string[];
  reasons: readonly string[];
  eligible: boolean;
  rejectionReason?: MusicVideoNotEvaluableReasonV1;
}>;

function scoreCandidate(
  segment: MusicSegmentV1,
  scene: VideoSceneV1,
  usageCount: number,
  previousAssetId: string | undefined,
): MusicVideoCandidateEvidenceV1 {
  const matchedTags = segment.semanticTags.filter((tag) => scene.semanticTags.includes(tag));
  const semanticScore = segment.semanticTags.length
    ? roundMusicVideoScore((matchedTags.length / segment.semanticTags.length) * scene.confidence)
    : 0;
  const segmentDuration = segment.endMs - segment.startMs;
  const sceneDuration = scene.endMs - scene.startMs;
  const durationScore = roundMusicVideoScore(Math.min(segmentDuration, sceneDuration) / Math.max(segmentDuration, sceneDuration));
  const rhythmScore = segment.energy === null || scene.rhythmSuitability === null
    ? null
    : roundMusicVideoScore(1 - Math.abs(segment.energy - scene.rhythmSuitability));
  const immediateRepeat = previousAssetId === scene.assetId;
  const reusePenalty = roundMusicVideoScore(Math.min(1,
    (immediateRepeat ? REPETITION_PENALTY_MODEL.immediateRepeat : 0)
    + Math.min(REPETITION_PENALTY_MODEL.maximumUsageOnly, usageCount * REPETITION_PENALTY_MODEL.perPriorUse)));
  const rhythmContribution = rhythmScore === null ? 0 : rhythmScore * MUSIC_VIDEO_LINKAGE_SCORE_WEIGHTS.rhythm;
  const redistributed = rhythmScore === null ? MUSIC_VIDEO_LINKAGE_SCORE_WEIGHTS.rhythm : 0;
  const totalScore = roundMusicVideoScore(
    semanticScore * (MUSIC_VIDEO_LINKAGE_SCORE_WEIGHTS.semantic + redistributed * 0.6)
    + durationScore * (MUSIC_VIDEO_LINKAGE_SCORE_WEIGHTS.duration + redistributed * 0.4)
    + scene.usability * MUSIC_VIDEO_LINKAGE_SCORE_WEIGHTS.usability
    + rhythmContribution
    - reusePenalty * MUSIC_VIDEO_LINKAGE_SCORE_WEIGHTS.repetitionPenalty,
  );
  let rejectionReason: MusicVideoNotEvaluableReasonV1 | undefined;
  if (!segment.semanticTags.length || !scene.semanticTags.length || !matchedTags.length) rejectionReason = "NO_SEMANTIC_EVIDENCE";
  else if (durationScore < 0.5) rejectionReason = "NO_DURATION_COMPATIBLE_SCENE";
  else if (scene.startMs > SOURCE_START_PLACEMENT_TOLERANCE_MS) rejectionReason = "SOURCE_RANGE_UNSUPPORTED";
  const reasons = Object.freeze([
    `semantic=${semanticScore.toFixed(3)}:${matchedTags.join(",") || "none"}`,
    `duration=${durationScore.toFixed(3)}:${sceneDuration}ms/${segmentDuration}ms`,
    rhythmScore === null ? "rhythm=not-evaluable" : `rhythm=${rhythmScore.toFixed(3)}`,
    `reuse-penalty=${reusePenalty.toFixed(3)}`,
  ]);
  return Object.freeze({
    musicSegmentId: segment.id,
    sceneId: scene.sceneId,
    assetId: scene.assetId,
    semanticScore,
    durationScore,
    rhythmScore,
    usabilityScore: scene.usability,
    usageCount,
    immediateRepeat,
    reusePenalty,
    totalScore,
    matchedTags: Object.freeze(matchedTags),
    reasons,
    eligible: rejectionReason === undefined,
    ...(rejectionReason ? { rejectionReason } : {}),
  });
}

export function scoreMusicVideoCandidates(input: Readonly<{
  musicSegments: readonly MusicSegmentV1[];
  videoScenes: readonly VideoSceneV1[];
  initialAssetUsage?: Readonly<Record<string, number>>;
  previousAssetId?: string;
}>): readonly MusicVideoCandidateEvidenceV1[] {
  const usage = new Map(Object.entries(input.initialAssetUsage ?? {}).map(([assetId, count]) => {
    assertMusicVideoIdentity(assetId, "initialAssetUsage key");
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("initialAssetUsage values must be non-negative safe integers.");
    return [assetId, count] as const;
  }));
  let previous = input.previousAssetId;
  const result: MusicVideoCandidateEvidenceV1[] = [];
  input.musicSegments.forEach((segment) => {
    const segmentScores = input.videoScenes.map((scene) => scoreCandidate(segment, scene, usage.get(scene.assetId) ?? 0, previous));
    result.push(...segmentScores);
    const best = segmentScores.filter((candidate) => candidate.eligible)
      .sort((left, right) => right.totalScore - left.totalScore || right.semanticScore - left.semanticScore
        || left.assetId.localeCompare(right.assetId) || left.sceneId.localeCompare(right.sceneId))[0];
    if (best) {
      usage.set(best.assetId, (usage.get(best.assetId) ?? 0) + 1);
      previous = best.assetId;
    }
  });
  return Object.freeze(result);
}
