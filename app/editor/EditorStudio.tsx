"use client";

import {
  ChangeEvent,
  DragEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import AITaskProviderSelector from "../../components/ai/AITaskProviderSelector";
import AITaskResultPreview from "../../components/ai/AITaskResultPreview";
import { useAuth } from "../../components/auth/AuthProvider";
import {
  AITaskClientError,
  runAITask,
  type AITaskSuccessResult,
} from "../../lib/ai/tasks";
import type { AIProviderId } from "../../lib/ai/types";
import TimelineEditor from "../TimelineEditor";
import {OutputCanvasSettings} from "../OutputCanvasSettings";
import {changeOutputCanvas,outputCanvasSize,isCanvasOnlyChange} from "../editor-output-settings";
import {renderTimelineExport} from "../editor-export";
import { decodeVideoSpeechPcm } from "../editor-export-media";
import {EditorCaptionView} from "../editor-caption-view";
import {EDITOR_FLOW_STAGES,friendlyEditingError,validateVisualRelink,type EditorFlowStage} from "../editor-workflow";
import {guardManualTimelineMutationV1} from "../editor-manual-constraint-guard";
import { CLIP_TEST_ENABLED } from "../editor-clip-evidence";
import { ClipEvidencePanel } from "../editor-clip-evidence-panel";
import { generateEditorProposal } from "../editor-proposal-orchestrator";
import { PlanEvidencePanel } from "../editor-plan-evidence-panel";
import { CollaborativeEditingOptionsPanel } from "../editor-collaborative-options-panel";
import { EditorDecisionExplanationPanel } from "../editor-decision-explanation-panel";
import { deriveEditorDecisionExplanationsV1 } from "../editor-decision-explanations";
import { deriveProtectedTimelineAnnotationsV1, type ProtectedTimelineAnnotationV1 } from "../editor-protected-timeline";
import { CreativeIntentPanel } from "../editor-creative-intent-panel";
import {
  confirmCreativeIntentGroundingV1,
  emptyCreativeIntentSessionV1,
  invalidateCreativeIntentSessionV1,
  resolveCreativeIntentConflictV1,
  type CreativeIntentSessionV1,
} from "../editor-creative-intent-session";
import type { GroundingSelectionV1 } from "../editor-constraint-grounding";
import type { ConstraintResolutionChoice } from "../editor-constraint-negotiation";
import {
  type EditorProposalBundle,
  type ProposalGenerationStatus,
} from "../editor-proposal-orchestrator";
import {
  DEFAULT_PLAN_GENERATION_MODE,
  assertCollaborativeOptionExecutableV1,
  generateCollaborativeEditingOptionsV1,
  isCollaborativeEditingOptionsCurrentV1,
  selectCollaborativeEditingOptionV1,
  type CollaborativeEditingOptionsV1,
  type PlanGenerationModeV1,
} from "../editor-collaborative-options";
import {
  ProposalReviewError,
  createHumanReviewState,
  executeReviewedProposal,
  reviewProposalEntry,
  type HumanReviewDecision,
  type HumanReviewState,
} from "../editor-proposal-review";
import type { PlanEvidence } from "../editor-plan-evidence";
import {
  buildMusicVideoTimelineProposal,
  normalizeVideoSceneIndex,
  segmentMusicForVideoLinkage,
  type MusicVideoLinkageResultV1,
} from "../editor-music-video-linkage";
import { evaluateEditorExecution, type EditorEvaluationReport } from "../editor-evaluator";
import {
  createRepairProposalBundle,
  createRepairReviewState,
  executeReviewedRepairLoop,
  reviewRepairEntry,
  type ClosedLoopRepairResult,
  type RepairProposalBundle,
  type RepairReviewDecision,
  type RepairReviewState,
} from "../editor-repair";
import {
  applyAIEditingPlan,
  createSafeEditorAIContext,
  type EditorAIApplyResult,
} from "../editor-ai-requirements";
import {
  DEFAULT_SPEED_CURVE,
  DEFAULT_TRANSFORM,
  clipPositionScaleCanvasOffset,
  clipPositionScaleCss,
  cloneProject,
  createFullAudioSelection,
  cropAndRebaseCaptions,
  formatTimeMs,
  normalizeAudioSelection,
  parseEditorProject,
  parseTimeMs,
  sourceTimeAtTimelineMs,
  placeVideoCaption,
  remapVideoCaptions,
  speedAt,
  validateAudioSelection,
  type AudioSelection,
  type ClipTransform,
  type EditorProject,
  type SpeedPoint,
  type TimelineCaption,
  type TimelineClip
} from "../editor-core";
import { drawEditorOverlaysAt, overlaysVisibleAt } from "../editor-overlays";
import {
  captionPresentation,
  activeCaptionAt,
  captionTimelineHasOverlap,
  drawEditorCaptionAt,
  parseSubtitleFile,
} from "../editor-captions";
import {
  buildSecondaryAudioMixPlan,
  secondaryAudioEndMs,
  secondaryAudioGainAt,
  type SecondaryAudioSourceType,
} from "../editor-secondary-audio";
import {
  TranscriptionFailure,
  applyReferenceTranscript,
  detectSpeechRegions,
  transcriptionOutputToCaptions,
  videoTranscriptionSegments,
  simplifyWhisperCaptions,
  transcriptionStageLabels,
  type TranscriptionOutput,
  type TranscriptionStage
} from "../transcription-core";
import {
  captureBoundedFrameSamples,
  captureFrameSamplesAtTimes,
} from "../editor-video-sampling";
import {
  analyzeAudioRhythm,
  createAudioRhythmSourceId,
  type AudioRhythmAnalysis,
} from "../editor-audio-rhythm";
import {
  MAX_TOTAL_CLASSIFIED_FRAMES_PER_ASSET,
  analyzeVideoAssetTwoStage,
  collectCurrentVideoEvidence,
} from "../editor-video-analysis";
import {
  VideoSemanticAnalysisCache,
  createFilenameFallbackAssetSemantics,
  normalizeLocalClipAnalysis,
  type VideoSemanticAnalysisMethod,
} from "../editor-video-semantic";
import { inspectEditorVisualContext, editorVisualContextMessage } from "../editor-visual-readiness";
import type { ConstraintSetV1 } from "../editor-constraints";
import { ConstraintEnforcementBlockedError, type ConstraintEnforcementResultV1 } from "../editor-constraint-enforcement";
import {
  ReferenceObjectUrlOwner,
  analyzeReferenceVideoFile,
  buildReferenceStylePlanningInputs,
  classifyReferenceVideoInput,
  evaluateReferenceStyleFit,
  planReferenceStyleTransfer,
  type ReferenceStyleAnalysisResult,
  type ReferenceStylePlanningResult,
} from "../editor-reference-style";
import { buildReferenceStyleReviewBundle } from "../editor-reference-style-review";
import {
  EDITOR_VISUAL_TOPICS as visualTopics,
  deriveEditorCaptionConceptsV1,
  editorTopicsForTextV1 as topicsForText,
} from "../editor-caption-concepts";
import {
  emitEditorNegotiationStateDiagnosticV1,
  emitEditorAcceptanceDiagnosticV1,
  emitEditorProposalStageDiagnosticV1,
  emitZeroActionReviewResultDiagnosticV1,
} from "../editor-acceptance-diagnostics";
import {
  ACCEPTANCE_INPUT_HYDRATION_BUILD_ENABLED,
  hydrateAcceptanceEditorInputEvidenceV1,
} from "../editor-acceptance-input-hydration";

type Asset = {
  id: string;
  name: string;
  kind: "视频" | "图片";
  size: string;
  preview?: string;
  file?: File;
  mime?: string;
  duration?: number;
  semanticTopic?: string;
  semanticScore?: number;
};

type AudioAsset = {
  id: string;
  name: string;
  size: string;
  url?: string;
  duration: number;
};

type JobState = "idle" | "processing" | "done";
type SubtitleSource = "auto" | "upload";
type DurationMode = "audio" | "custom";
type AudioInputMode = "original" | "external" | "mix" | "silent";
const audioModes: Record<AudioInputMode, string> = {
  original: "使用视频原声",
  external: "独立音频",
  mix: "视频原声与背景音乐混合",
  silent: "静音",
};

function matchSegmentAt(segments: MatchSegment[], seconds: number) {
  return segments.reduce<MatchSegment | undefined>((active, segment) => (
    seconds >= segment.start && seconds < segment.end && (segment.layer ?? 0) >= (active?.layer ?? 0)
      ? segment : active
  ), undefined);
}

function sourceOrderPlan(assets: Asset[], duration: number): MatchSegment[] {
  let cursor = 0;
  return assets.flatMap((asset) => {
    const length = Math.min(asset.duration ?? 0, duration - cursor);
    if (length <= 0) return [];
    const start = cursor;
    cursor += length;
    return [{ id: `source-${asset.id}`, start, end: cursor, assetId: asset.id, sourceStart: 0, sourceEnd: length, reason: "按素材顺序保留源时间" }];
  });
}
type RenderState = "idle" | "rendering" | "ready" | "error";
type AiState = "idle" | "loading" | "running" | "ready" | "error";
type TranscriptionQuality = "fast" | "accurate";

const unavailableEditorTools = [
  ["分析创作意图", "当前服务未注册独立的创作意图与保护范围解析任务。"],
  ["字幕语义规划", "服务商尚未启用字幕语义规划。"],
  ["素材匹配计划", "服务商尚未启用素材匹配，按画面内容选镜头仍需视觉理解能力。"],
  ["时间线规划", "服务商尚未启用通用时间线规划。可按明确的片段和时间生成待审核建议。"],
  ["生成剪辑简报", "服务商尚未启用剪辑简报。"],
] as const;

type EditorRequirementsReview = {
  result: AITaskSuccessResult;
  operationCount: number;
  project: EditorProject;
  assets: readonly Asset[];
  audioSelection: AudioSelection;
  audioDurationMs: number;
  requirement: string;
  userId: string;
  provider: AIProviderId;
  constraintSet: ConstraintSetV1 | null;
  intentSession: CreativeIntentSessionV1;
};

function editorRequirementsError(error: unknown): string {
  if (error instanceof AITaskClientError) {
    return error.code === "INVALID_TASK" || error.code === "PROVIDER_NOT_SUPPORTED_FOR_TASK"
      ? "当前 AI 服务未启用剪辑需求解析。"
      : error.message;
  }
  if (error instanceof ConstraintEnforcementBlockedError) {
    return "建议与当前保护约束冲突，时间线没有修改。";
  }
  return "AI 返回的剪辑计划未通过安全校验，时间线没有修改。";
}

type Classification = Array<import("../editor-video-analysis").RawLocalClipClassification>;

class LocalClipUnavailableError extends Error {
  readonly code = "LOCAL_CLIP_UNAVAILABLE" as const;

  constructor() {
    super("Approved local CLIP model pack is unavailable");
    this.name = "LocalClipUnavailableError";
  }
}

type AiWorkerMessage =
  | { type: "model-progress"; requestId: string; status?: string; progress?: number }
  | { type: "running"; requestId: string }
  | { type: "complete"; requestId: string; output: TranscriptionOutput }
  | { type: "error"; requestId: string; message: string; stage?: string; stack?: string }
  | { type: "classification-progress"; requestId: string; status?: string; progress?: number }
  | { type: "classification-running"; requestId: string }
  | { type: "classification-complete"; requestId: string; results: Classification }
  | { type: "classification-unavailable"; requestId: string; code: "LOCAL_CLIP_UNAVAILABLE" }
  | { type: "classification-error"; requestId: string; message: string };

type MatchSegment = {
  id?: string;
  start: number;
  end: number;
  assetId: string;
  reason: string;
  sourceStart?: number;
  sourceEnd?: number;
  playbackRate?: number;
  transform?: ClipTransform;
  speedCurve?: SpeedPoint[];
  trackId?: string;
  layer?: number;
  matchScore?: number;
  matchedTopic?: string;
};

function EditorAIApplySummary({ result }: { result: EditorAIApplyResult }) {
  return (
    <section aria-live="polite" className="editor-ai-apply-summary">
      <b>{result.summary}</b>
      <div>
        <span>已安全完成：{result.applied.length}</span>
        <span>暂不支持或需确认：{result.unsupported.length}</span>
      </div>
      {result.applied.length > 0 && (
        <ul>{result.applied.map((item, index) => (
          <li key={`${item.type}-${index}`}>{item.reason}</li>
        ))}</ul>
      )}
      {result.unsupported.length > 0 && (
        <div className="editor-ai-unsupported">
          <strong>以下要求没有自动执行</strong>
          <ul>{result.unsupported.map((item, index) => (
            <li key={`${item.request}-${index}`}><b>{item.request}</b>：{item.reason}</li>
          ))}</ul>
        </div>
      )}
      {result.warnings.length > 0 && (
        <p>提示：{result.warnings.join("；")}</p>
      )}
    </section>
  );
}

type FrameInsight = {
  at: number;
  scores: Map<string, number>;
};

type AssetVisualInsight = {
  frames: FrameInsight[];
  scores: Map<string, number>;
};

const stages = [
  { label: "素材校验", hint: "检查格式与清晰度", threshold: 8 },
  { label: "音频转写", hint: "识别人声与断句", threshold: 28 },
  { label: "智能匹配", hint: "按语义安排素材", threshold: 50 },
  { label: "字幕合成", hint: "白字黑描边样式", threshold: 72 },
  { label: "视频渲染", hint: "生成预览版本", threshold: 90 }
];

function Icon({
  children,
  size = 20,
  className = ""
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

const UploadIcon = ({ size = 22 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    <path d="M5 14.5v3A2.5 2.5 0 007.5 20h9a2.5 2.5 0 002.5-2.5v-3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
  </Icon>
);

const VideoIcon = ({ size = 20 }: { size?: number }) => (
  <Icon size={size}>
    <rect height="13" rx="2.5" stroke="currentColor" strokeWidth="1.7" width="15" x="3" y="5.5" />
    <path d="M18 10l3-2v8l-3-2" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
  </Icon>
);

const ImageIcon = () => (
  <Icon>
    <rect height="16" rx="2.5" stroke="currentColor" strokeWidth="1.7" width="18" x="3" y="4" />
    <circle cx="8.25" cy="9" r="1.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4.5 17l4.2-4 3.1 2.6 3.1-3.1 4.6 4.5" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
  </Icon>
);

const AudioIcon = () => (
  <Icon>
    <path d="M9 18V6l10-2v12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    <ellipse cx="6.5" cy="18" rx="2.5" ry="2" stroke="currentColor" strokeWidth="1.7" />
    <ellipse cx="16.5" cy="16" rx="2.5" ry="2" stroke="currentColor" strokeWidth="1.7" />
  </Icon>
);

const SparkIcon = ({ size = 18 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12 2.8c.5 4.9 2.3 6.7 7.2 7.2-4.9.5-6.7 2.3-7.2 7.2-.5-4.9-2.3-6.7-7.2-7.2 4.9-.5 6.7-2.3 7.2-7.2z" fill="currentColor" />
    <path d="M19 16.5c.2 2.1.9 2.8 3 3-2.1.2-2.8.9-3 3-.2-2.1-.9-2.8-3-3 2.1-.2 2.8-.9 3-3z" fill="currentColor" />
  </Icon>
);

const CheckIcon = ({ size = 18 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M5 12.5l4.2 4.1L19 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
  </Icon>
);

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatCueTime(valueMs: number) {
  const safe = Math.max(0, valueMs / 1000);
  const minutes = Math.floor(safe / 60);
  const remaining = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remaining.toFixed(1).padStart(4, "0")}`;
}

function readMediaDuration(url: string, mediaType: "audio" | "video") {
  return new Promise<number | undefined>((resolve) => {
    const media = document.createElement(mediaType);
    let settled = false;
    const finish = (duration?: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      media.removeAttribute("src");
      media.load();
      resolve(duration);
    };
    const timer = window.setTimeout(() => finish(), 5000);
    const readDuration = () => Number.isFinite(media.duration) && media.duration > 0 ? media.duration : undefined;
    media.preload = media instanceof HTMLVideoElement ? "auto" : "metadata";
    if (media instanceof HTMLVideoElement) {
      media.onloadeddata = () => finish(media.videoWidth > 0 ? readDuration() : undefined);
    } else {
      media.onloadedmetadata = () => finish(readDuration());
    }
    media.onerror = () => finish();
    media.src = url;
  });
}

function parseTimecode(value: string) {
  const parts = value.trim().replace(",", ".").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return undefined;
}

function formatTimecode(seconds: number) {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

function buildSubtitleCues(
  text: string,
  durationMs: number,
  preserveTimedCues = false
): TimelineCaption[] {
  const source = text.trim();
  const safeDurationMs = Math.max(1_000, Math.round(durationMs));
  if (!source) return [];

  const timed: TimelineCaption[] = [];
  const blocks = source.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [rawStart, rawEnd] = lines[timingIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const start = parseTimecode(rawStart);
    const end = parseTimecode(rawEnd);
    const cueText = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (start === undefined || end === undefined || end <= start) continue;
    timed.push({
      id: `cue-${timed.length + 1}`,
      startMs: Math.round(start * 1000),
      endMs: Math.round(end * 1000),
      text: cueText
    });
  }

  if (timed.length) {
    const sourceEndMs = Math.max(...timed.map((cue) => cue.endMs));
    const scale = preserveTimedCues
      ? 1
      : sourceEndMs > 0 ? safeDurationMs / sourceEndMs : 1;
    return timed
      .map((cue) => {
        const startMs = Math.min(safeDurationMs, Math.round(cue.startMs * scale));
        const scaledEndMs = Math.round(cue.endMs * scale);
        return {
          ...cue,
          startMs,
          endMs: Math.min(
            safeDurationMs,
            preserveTimedCues ? scaledEndMs : Math.max(startMs + 250, scaledEndMs)
          ),
        };
      })
      .filter((cue) => cue.endMs > cue.startMs)
      .map((cue, index) => ({ ...cue, id: `cue-${index + 1}` }));
  }

  // Plain text has no acoustic timing information. It must be aligned against
  // the final audio through automatic recognition instead of receiving
  // synthetic timestamps based on text length.
  return [];
}

function cuesToSrt(cues: TimelineCaption[]) {
  return cues.map((cue, index) =>
    `${index + 1}\n${formatTimecode(cue.startMs / 1000)} --> ${formatTimecode(cue.endMs / 1000)}\n${cue.text}`
  ).join("\n\n");
}

function cueAt(cues: TimelineCaption[], seconds: number) {
  const currentMs = Math.round(seconds * 1000);
  return activeCaptionAt(cues,currentMs);
}

function topicForText(text: string) {
  return topicsForText(text)[0]?.topic;
}

function segmentPlaybackRate(
  _assetDuration: number | undefined,
  _segmentDuration: number,
  _sourceStart = 0,
  _preferredRate = 1
) {
  return 1;
}

const MAX_VIDEO_SHOT_SECONDS = 8;
const MAX_IMAGE_SHOT_SECONDS = 4;
const MAX_IMAGE_TOTAL_SECONDS = 6;
const MAX_FALLBACK_SHOT_SECONDS = 1.25;

async function decodeAudioToMono16k(url: string) {
  const AudioContextClass = window.AudioContext;
  const audioContext = new AudioContextClass();
  try {
    const encoded = await fetch(url).then((response) => {
      if (!response.ok) throw new Error("无法读取音频文件");
      return response.arrayBuffer();
    });
    const decoded = await audioContext.decodeAudioData(encoded.slice(0));
    const frameCount = Math.max(1, Math.ceil(decoded.duration * 16000));
    const offline = new OfflineAudioContext(1, frameCount, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const samples = new Float32Array(rendered.length);
    samples.set(rendered.getChannelData(0));
    return samples;
  } finally {
    await audioContext.close().catch(() => undefined);
  }
}

function createEditorProject(
  plan: MatchSegment[],
  cues: TimelineCaption[],
  preparedAssets: Asset[],
  audioSelection: AudioSelection,
  durationSeconds: number,
  ratio: string,
  defaultFit: "cover" | "contain" = "cover"
): EditorProject {
  const videoClips = plan.map((segment, index) => {
    const asset = preparedAssets.find((item) => item.id === segment.assetId);
    const timelineStartMs = Math.round(segment.start * 1000);
    const timelineEndMs = Math.round(segment.end * 1000);
    const sourceInMs = Math.round((segment.sourceStart ?? 0) * 1000);
    const sourceOutMs = Math.min(
      Math.round((asset?.duration ?? Number.POSITIVE_INFINITY) * 1000),
      Math.max(
        sourceInMs + 100,
        Math.round((segment.sourceEnd ?? (
          (segment.sourceStart ?? 0) + Math.max(0.1, segment.end - segment.start)
        )) * 1000)
      )
    );
    return {
      id: segment.id ?? crypto.randomUUID(),
      assetId: segment.assetId,
      name: asset?.name ?? `素材 ${index + 1}`,
      kind: asset?.kind ?? ("视频" as const),
      trackId: "video-main",
      timelineStartMs,
      timelineEndMs,
      sourceInMs,
      sourceOutMs: Number.isFinite(sourceOutMs) ? sourceOutMs : sourceInMs + Math.max(100, timelineEndMs - timelineStartMs),
      transform: segment.transform ?? { ...DEFAULT_TRANSFORM,fit:defaultFit },
      speedCurve: segment.speedCurve?.length
        ? segment.speedCurve.map((point) => ({ ...point }))
        : DEFAULT_SPEED_CURVE.map((point) => ({ ...point })),
      reason: segment.reason
    };
  });

  return {
    schemaVersion: 2,
    id: crypto.randomUUID(),
    title: "医学科普剪辑工程",
    updatedAt: new Date().toISOString(),
    durationMs: Math.max(1000, Math.round(durationSeconds * 1000)),
    ratio,
    audioSelection: normalizeAudioSelection(audioSelection),
    assets: preparedAssets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      durationMs: Math.round((asset.duration ?? 0) * 1000)
    })),
    tracks: [
      { id: "audio-main", type: "audio", name: "主音频", clips: [], locked: true },
      { id: "video-main", type: "video", name: "主视频", clips: videoClips },
      { id: "broll", type: "broll", name: "B-roll", clips: [] },
      { id: "captions", type: "captions", name: "字幕", clips: [] }
    ],
    captions: cues.map((cue) => ({ ...cue })),
    overlays: [],
    secondaryAudioClips: [],
  };
}

function projectToMatchSegments(project: EditorProject): MatchSegment[] {
  return project.tracks
    .filter((track) => track.type === "video" || track.type === "broll")
    .flatMap((track, layer) => track.clips.map((clip, order) => ({
      id: clip.id,
      start: clip.timelineStartMs / 1000,
      end: clip.timelineEndMs / 1000,
      assetId: clip.assetId,
      reason: clip.reason ?? "用户在时间线中调整",
      sourceStart: clip.sourceInMs / 1000,
      sourceEnd: clip.sourceOutMs / 1000,
      playbackRate: 1,
      transform: clip.transform,
      speedCurve: clip.speedCurve,
      trackId: track.id,
      layer: layer * 1_000_000 + order
    })))
    .sort((left, right) => left.start - right.start);
}

function matchSegmentRateAt(segment: MatchSegment | undefined, seconds: number) {
  if (!segment?.speedCurve?.length) return segment?.playbackRate ?? 1;
  const normalizedTime = (seconds - segment.start) / Math.max(0.1, segment.end - segment.start);
  return speedAt(segment.speedCurve, normalizedTime);
}

function matchSegmentSourceTime(segment: MatchSegment, seconds: number) {
  if (!segment.speedCurve?.length || segment.sourceEnd === undefined) {
    return (segment.sourceStart ?? 0)
      + Math.max(0, seconds - segment.start) * (segment.playbackRate ?? 1);
  }
  const clip: TimelineClip = {
    id: segment.id ?? "preview",
    assetId: segment.assetId,
    name: "preview",
    kind: "视频",
    trackId: segment.trackId ?? "video-main",
    timelineStartMs: Math.round(segment.start * 1000),
    timelineEndMs: Math.round(segment.end * 1000),
    sourceInMs: Math.round((segment.sourceStart ?? 0) * 1000),
    sourceOutMs: Math.round(segment.sourceEnd * 1000),
    transform: segment.transform ?? DEFAULT_TRANSFORM,
    speedCurve: segment.speedCurve
  };
  return sourceTimeAtTimelineMs(clip, seconds * 1000) / 1000;
}

export default function Home() {
  const mediaInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const subtitleInput = useRef<HTMLInputElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewAudioRef = useRef<HTMLAudioElement>(null);
  const secondaryPreviewAudioRefs = useRef(new Map<string, HTMLAudioElement>());
  const secondaryAudioRuntimeRef = useRef(new Map<string, { file: File; url: string }>());
  const previewElapsedRef = useRef(0);
  const previewPendingSourceMsRef = useRef(0);
  const previewSyncFrameRef = useRef(0);
  const selectionAudioRef = useRef<HTMLAudioElement>(null);
  const selectionPendingSourceMsRef = useRef(0);
  const renderCancelRef = useRef(false);
  const semanticAnalysisCacheRef = useRef(new VideoSemanticAnalysisCache());
  const visualInsightCacheRef = useRef(new Map<string, AssetVisualInsight>());
  const videoAnalysisAbortRef = useRef(new Map<string, AbortController>());
  const audioRhythmAnalysisRef = useRef<AudioRhythmAnalysis | null>(null);
  const referenceVideoInputRef = useRef<HTMLInputElement>(null);
  const referenceObjectUrlOwnerRef = useRef<ReferenceObjectUrlOwner | null>(null);
  const referenceAnalysisTokenRef = useRef(0);
  const acceptanceInputHydratedRef = useRef(false);
  const videoAudioQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const transcriptionWorkerRef = useRef<Worker | null>(null);
  const activeTranscriptionRequestRef = useRef("");
  const transcriptionRunTokenRef = useRef(0);
  const transcriptionRequestsRef = useRef(new Map<string, {
    resolve: (output: TranscriptionOutput) => void;
    reject: (error: Error) => void;
  }>());
  const activeClassificationRequestRef = useRef("");
  const classificationRequestsRef = useRef(new Map<string, {
    resolve: (output: Classification) => void;
    reject: (error: Error) => void;
  }>());
  const [assets, setAssets] = useState<Asset[]>([]);
  const [mediaImportError, setMediaImportError] = useState("");
  const [audios, setAudios] = useState<AudioAsset[]>([]);
  // With no explicit choice, a narration upload retains the legacy workflow.
  const [audioModeChoice, setAudioModeChoice] = useState<AudioInputMode | null>(null);
  const [originalVolume, setOriginalVolume] = useState(1);
  const [musicVolume, setMusicVolume] = useState(0.25);
  const audioMode = audioModeChoice ?? (audios.length ? "external" : "original");
  const videoVolume = audioMode === "original" ? 1 : audioMode === "mix" ? originalVolume : 0;
  const originalEnabled = videoVolume > 0;
  const externalEnabled = audioMode === "external" || audioMode === "mix";
  const videoTranscription = audioMode === "original" || audioMode === "mix";
  const [subtitleSource, setSubtitleSource] = useState<SubtitleSource>("auto");
  const [subtitleName, setSubtitleName] = useState("");
  const [subtitleText, setSubtitleText] = useState("");
  const [captionRecords, setCaptionRecords] = useState<TimelineCaption[]>([]);
  const [recognizedSubtitleText, setRecognizedSubtitleText] = useState("");
  const recognizedCaptionRecords = useRef<TimelineCaption[]>([]);
  const [transcriptionState, setTranscriptionState] = useState<AiState>("idle");
  const [transcriptionProgress, setTranscriptionProgress] = useState(0);
  const [transcriptionError, setTranscriptionError] = useState("");
  const [transcriptionErrorStack, setTranscriptionErrorStack] = useState("");
  const [transcriptionStage, setTranscriptionStageState] = useState<TranscriptionStage>("waiting");
  const transcriptionStageRef = useRef<TranscriptionStage>("waiting");
  const setTranscriptionStage = (stage: TranscriptionStage) => {
    transcriptionStageRef.current = stage;
    setTranscriptionStageState(stage);
  };
  const [failureStage, setFailureStage] = useState<TranscriptionStage | null>(null);
  const [referenceTranscript, setReferenceTranscript] = useState("");
  const [medicalTerms, setMedicalTerms] = useState("");
  const [transcriptionQuality, setTranscriptionQuality] = useState<TranscriptionQuality>("accurate");
  const [matchingState, setMatchingState] = useState<AiState>("idle");
  const [matchingProgress, setMatchingProgress] = useState(0);
  const [matchSegments, setMatchSegments] = useState<MatchSegment[]>([]);
  const [durationMode, setDurationMode] = useState<DurationMode>("audio");
  const [customDuration, setCustomDuration] = useState(60);
  const [audioSelection, setAudioSelection] = useState<AudioSelection>(() =>
    createFullAudioSelection(0)
  );
  const [audioStartInput, setAudioStartInput] = useState("00:00.000");
  const [audioEndInput, setAudioEndInput] = useState("00:00.000");
  const [selectionAudioIndex, setSelectionAudioIndex] = useState(0);
  const [selectionPlayheadMs, setSelectionPlayheadMs] = useState(0);
  const [selectionPreviewPlaying, setSelectionPreviewPlaying] = useState(false);
  const [durationMismatchConfirmed, setDurationMismatchConfirmed] = useState(false);
  const [subtitleTimelineBasis, setSubtitleTimelineBasis] = useState<"source" | "selection">("selection");
  const [requirements, setRequirements] = useState("");
  const [requirementDraft, setRequirementDraft] = useState("");
  const [requirementDialogOpen, setRequirementDialogOpen] = useState(false);
  const { user, loading: authLoading } = useAuth();
  const [selectedAIProvider, setSelectedAIProvider] = useState<AIProviderId | null>(null);
  const [editorAITaskBusy, setEditorAITaskBusy] = useState(false);
  const editorAITaskInFlight = useRef(false);
  const [editorAITaskError, setEditorAITaskError] = useState<string | null>(null);
  const [requirementsReview, setRequirementsReview] = useState<EditorRequirementsReview | null>(null);
  const [editorAIApplyResult, setEditorAIApplyResult] = useState<EditorAIApplyResult | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewElapsed, setPreviewElapsed] = useState(0);
  const [previewAudioIndex, setPreviewAudioIndex] = useState(0);
  const [previewMediaError, setPreviewMediaError] = useState("");
  const [renderState, setRenderState] = useState<RenderState>("idle");
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderedVideoUrl, setRenderedVideoUrl] = useState("");
  const [renderedVideoSize, setRenderedVideoSize] = useState("");
  const [renderError, setRenderError] = useState("");
  const [dragging, setDragging] = useState(false);
  const canvasChangeRef = useRef(false);
  const [ratio, setRatio] = useState("9:16");
  const [fillMode, setFillMode] = useState("智能适配");
  const [subtitle, setSubtitle] = useState("白字黑描边");
  const [consent, setConsent] = useState(false);
  const [jobState, setJobState] = useState<JobState>("idle");
  const [startingJob, setStartingJob] = useState(false);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState("");
  const [editorProject, setEditorProject] = useState<EditorProject | null>(null);
  const [secondaryAudioSources, setSecondaryAudioSources] = useState<Record<string, string>>({});
  const [editorAIUndoProjects, setEditorAIUndoProjects] = useState<EditorProject[]>([]);
  const setEditorAIUndoProject = (snapshot: EditorProject | null) => {
    setEditorAIUndoProjects((current) => snapshot ? [...current, snapshot] : []);
  };
  const [editorProposal, setEditorProposal] = useState<EditorProposalBundle | null>(null);
  const [planGenerationMode, setPlanGenerationMode] = useState<PlanGenerationModeV1>(DEFAULT_PLAN_GENERATION_MODE);
  const [collaborativeOptionSet, setCollaborativeOptionSet] = useState<CollaborativeEditingOptionsV1 | null>(null);
  const [selectedCollaborativeOptionId, setSelectedCollaborativeOptionId] = useState<string | null>(null);
  const [optionReviewById, setOptionReviewById] = useState<Readonly<Record<string, HumanReviewState>>>({});
  const [activeConstraintSet, setActiveConstraintSet] = useState<ConstraintSetV1 | null>(null);
  const [creativeIntentSession, setCreativeIntentSession] = useState<CreativeIntentSessionV1>(() => emptyCreativeIntentSessionV1());
  const [editorProposalReview, setEditorProposalReview] = useState<HumanReviewState | null>(null);
  const [reviewedPlanEvidence, setReviewedPlanEvidence] = useState<PlanEvidence | null>(null);
  const [reviewedEvidenceProposal, setReviewedEvidenceProposal] = useState<EditorProposalBundle | null>(null);
  const [editorEvaluation, setEditorEvaluation] = useState<EditorEvaluationReport | null>(null);
  const [editorRepairProposal, setEditorRepairProposal] = useState<RepairProposalBundle | null>(null);
  const [editorRepairReview, setEditorRepairReview] = useState<RepairReviewState | null>(null);
  const [editorRepairResult, setEditorRepairResult] = useState<ClosedLoopRepairResult | null>(null);
  const [repairExecutionBusy, setRepairExecutionBusy] = useState(false);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [proposalExecutionBusy, setProposalExecutionBusy] = useState(false);
  const [proposalReviewError, setProposalReviewError] = useState<string | null>(null);
  const [proposalStaleMessage, setProposalStaleMessage] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<Readonly<{ status: ProposalGenerationStatus; message: string }> | null>(null);
  const [musicVideoLyricsDraft, setMusicVideoLyricsDraft] = useState("");
  const [musicVideoResult, setMusicVideoResult] = useState<MusicVideoLinkageResultV1 | null>(null);
  const [musicVideoBusy, setMusicVideoBusy] = useState(false);
  const [referenceVideoName, setReferenceVideoName] = useState("");
  const [referenceStyleBusy, setReferenceStyleBusy] = useState(false);
  const [referenceStyleAnalysis, setReferenceStyleAnalysis] = useState<ReferenceStyleAnalysisResult | null>(null);
  const [referenceStylePlan, setReferenceStylePlan] = useState<ReferenceStylePlanningResult | null>(null);
  const [referenceStyleExecutionSummary, setReferenceStyleExecutionSummary] = useState<Readonly<{ executed: number; rejected: number; protectedSkipped: number; preFit: number; postFit: number }> | null>(null);
  const [blockedExplanationResult, setBlockedExplanationResult] = useState<ConstraintEnforcementResultV1 | null>(null);
  const [selectedProtectionClauseId, setSelectedProtectionClauseId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [visualCaptionId,setVisualCaptionId]=useState("");
  const [flowStage,setFlowStage]=useState<EditorFlowStage>("materials");
  const [aiTool,setAiTool]=useState<"request"|"lyrics"|"reference">("request");
  const clipWorkerRef=useRef<Worker|null>(null);

  const [captionVisibleCount, setCaptionVisibleCount] = useState(60);

  const syncCaptionRecordsFromProject = (project: EditorProject) => {
    const captions = project.captions.map((caption) => ({ ...caption }));
    setCaptionRecords(captions);
    setSubtitleText(cuesToSrt(captions));
  };

  const commitCaptionRecords = (
    captions: TimelineCaption[],
    serialize = true
  ) => {
    const next = captions.map((caption) => ({ ...caption }));
    setCaptionRecords(next);
    if (serialize) setSubtitleText(cuesToSrt(next));
    setEditorProject((current) => current
      ? {
          ...current,
          captions: next,
          updatedAt: new Date().toISOString()
        }
      : current
    );
  };

  const getTranscriptionWorker = (forClassification=false) => {
    if(forClassification && clipWorkerRef.current)return clipWorkerRef.current;
    if (!forClassification && transcriptionWorkerRef.current) return transcriptionWorkerRef.current;
    const worker = forClassification ? new Worker(new URL("../clip.worker.ts",import.meta.url),{type:"module"}) : new Worker(
        new URL("../transcription.worker.ts", import.meta.url),
      { type: "module" }
    );
    worker.addEventListener("message", (event: MessageEvent<AiWorkerMessage>) => {
      const message = event.data;
      if (
        message.type === "classification-progress"
        || message.type === "classification-running"
        || message.type === "classification-complete"
        || message.type === "classification-unavailable"
        || message.type === "classification-error"
      ) {
        if (message.requestId !== activeClassificationRequestRef.current) return;
        if (message.type === "classification-progress") {
          if (message.status === "progress" && Number.isFinite(message.progress)) {
            setMatchingState("loading");
            setMatchingProgress(
              Math.min(55, Math.max(3, Math.round((message.progress ?? 0) * 0.55)))
            );
          }
          return;
        }
        if (message.type === "classification-running") {
          setMatchingState("running");
          setMatchingProgress((current) => Math.max(56, current));
          return;
        }
        const pending = classificationRequestsRef.current.get(message.requestId);
        if (!pending) return;
        classificationRequestsRef.current.delete(message.requestId);
        activeClassificationRequestRef.current = "";
        if (message.type === "classification-complete") {
          pending.resolve(message.results);
        } else if (message.type === "classification-unavailable") {
          pending.reject(new LocalClipUnavailableError());
        } else if (message.type === "classification-error") {
          pending.reject(new Error(message.message));
        }
        return;
      }

      if (message.requestId !== activeTranscriptionRequestRef.current) return;
      if (message.type === "model-progress") {
        setTranscriptionStage("loading-model");
        if (message.status === "progress" && Number.isFinite(message.progress)) {
          setTranscriptionState("loading");
          setTranscriptionProgress(
            Math.min(68, Math.max(12, 12 + Math.round((message.progress ?? 0) * 0.56)))
          );
        }
        return;
      }

      if (message.type === "running") {
        setTranscriptionState("running");
        setTranscriptionStage("recognizing");
        setTranscriptionProgress(72);
        return;
      }

      const pending = transcriptionRequestsRef.current.get(message.requestId);
      if (!pending) return;
      transcriptionRequestsRef.current.delete(message.requestId);
      activeTranscriptionRequestRef.current = "";
      if (message.type === "complete") {
        pending.resolve(message.output);
      } else {
        const stage = message.stage === "loading-model"
          ? "loading-model"
          : "recognizing";
        const error = new TranscriptionFailure(
          stage === "loading-model" ? "model-load" : "model-runtime",
          stage,
          message.message
        );
        error.stack = message.stack || error.stack;
        pending.reject(error);
      }
    });
    worker.addEventListener("error", (event) => {
      if(forClassification){const error=new Error(event.message||"本地视觉线程意外停止");classificationRequestsRef.current.forEach(({reject})=>reject(error));classificationRequestsRef.current.clear();activeClassificationRequestRef.current="";clipWorkerRef.current?.terminate();clipWorkerRef.current=null;return;}
      const error = new TranscriptionFailure(
        "model-runtime",
        "recognizing",
        event.message || "本地智能识别线程意外停止"
      );
      transcriptionRequestsRef.current.forEach(({ reject }) => reject(error));
      transcriptionRequestsRef.current.clear();
      activeTranscriptionRequestRef.current = "";
      classificationRequestsRef.current.forEach(({ reject }) => reject(error));
      classificationRequestsRef.current.clear();
      activeClassificationRequestRef.current = "";
      transcriptionWorkerRef.current?.terminate();
    clipWorkerRef.current?.terminate();clipWorkerRef.current=null;
      transcriptionWorkerRef.current = null;
    });
    if(forClassification)clipWorkerRef.current=worker;else transcriptionWorkerRef.current = worker;
    return worker;
  };

  const requestTranscription = (
    audio: Float32Array,
    model: string,
    prompt: string,
    timestampRetry = false
  ) =>
    new Promise<TranscriptionOutput>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      activeTranscriptionRequestRef.current = requestId;
      transcriptionRequestsRef.current.set(requestId, { resolve, reject });
      getTranscriptionWorker().postMessage(
        { type: "transcribe", requestId, model, audio, prompt, timestampRetry },
        [audio.buffer]
      );
    });

  const requestImageClassification = (image: string, labels: string[]) =>
    new Promise<Classification>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      activeClassificationRequestRef.current = requestId;
      classificationRequestsRef.current.set(requestId, { resolve, reject });
      getTranscriptionWorker(CLIP_TEST_ENABLED).postMessage({
        type: "classify",
        requestId,
        image,
        labels
      });
    });

  const stopTranscription = (showNotice = true) => {
    transcriptionRunTokenRef.current += 1;
    transcriptionWorkerRef.current?.terminate();
    clipWorkerRef.current?.terminate();clipWorkerRef.current=null;
    transcriptionWorkerRef.current = null;
    const cancelled = new DOMException("音频识别已取消", "AbortError");
    transcriptionRequestsRef.current.forEach(({ reject }) => reject(cancelled));
    transcriptionRequestsRef.current.clear();
    activeTranscriptionRequestRef.current = "";
    classificationRequestsRef.current.forEach(({ reject }) => reject(cancelled));
    classificationRequestsRef.current.clear();
    activeClassificationRequestRef.current = "";
    setTranscriptionState(recognizedSubtitleText ? "ready" : "idle");
    setTranscriptionProgress(recognizedSubtitleText ? 100 : 0);
    setTranscriptionError("");
    setTranscriptionErrorStack("");
    setFailureStage(null);
    setTranscriptionStage("cancelled");
    if (showNotice) setNotice("已取消音频识别，页面中的其他内容不受影响");
  };

  useEffect(() => () => {
    videoAnalysisAbortRef.current.forEach((controller) => controller.abort());
    videoAnalysisAbortRef.current.clear();
    transcriptionWorkerRef.current?.terminate();
    clipWorkerRef.current?.terminate();clipWorkerRef.current=null;
    transcriptionWorkerRef.current = null;
    transcriptionRequestsRef.current.forEach(({ reject }) =>
      reject(new DOMException("页面已关闭", "AbortError"))
    );
    transcriptionRequestsRef.current.clear();
    classificationRequestsRef.current.forEach(({ reject }) =>
      reject(new DOMException("页面已关闭", "AbortError"))
    );
    classificationRequestsRef.current.clear();
    secondaryPreviewAudioRefs.current.forEach((audio) => audio.pause());
    secondaryPreviewAudioRefs.current.clear();
    secondaryAudioRuntimeRef.current.forEach((runtime) => {
      if (runtime.url) URL.revokeObjectURL(runtime.url);
    });
    secondaryAudioRuntimeRef.current.clear();
    referenceAnalysisTokenRef.current += 1;
    referenceObjectUrlOwnerRef.current?.dispose();
    referenceObjectUrlOwnerRef.current = null;
  }, []);

  useEffect(() => {
    const restored = parseEditorProject(window.localStorage.getItem("medclip-editor-draft-v1"));
    if (!restored) return;
    if (ACCEPTANCE_INPUT_HYDRATION_BUILD_ENABLED && !acceptanceInputHydratedRef.current) {
      acceptanceInputHydratedRef.current = true;
      const hydration = hydrateAcceptanceEditorInputEvidenceV1({
        payload: window.__MEDCLIP_ACCEPTANCE_INPUT_EVIDENCE__,
        project: restored,
        semanticCache: semanticAnalysisCacheRef.current,
      });
      if (hydration.status === "HYDRATED") {
        audioRhythmAnalysisRef.current = hydration.rhythmEvidence ?? null;
      }
      if (hydration.status === "HYDRATED" || hydration.status === "REJECTED") {
        emitEditorAcceptanceDiagnosticV1(Object.freeze({
          schemaVersion: 1,
          kind: "ACCEPTANCE_INPUT_HYDRATED",
          stage: "ACCEPTANCE_INPUT_HYDRATION",
          fixtureVersion: hydration.fixtureVersion,
          semanticAssetCount: hydration.semanticAssetCount,
          rhythmEvidencePresent: hydration.rhythmEvidencePresent,
          category: hydration.category,
        }));
      }
    }
    setEditorAIUndoProject(null);
    setEditorProject(restored);
    // Restore the draft in the background, but always land on the main studio.
    // The user can explicitly enter the full-screen timeline with “继续精剪”.
    setEditorOpen(false);
    setAudioSelection(normalizeAudioSelection(restored.audioSelection));
    setAudioStartInput(formatTimeMs(restored.audioSelection.sourceInMs));
    setAudioEndInput(formatTimeMs(restored.audioSelection.sourceOutMs));
    setCustomDuration(Math.max(1, restored.durationMs / 1000));
    setDurationMode(
      Math.abs(restored.durationMs - restored.audioSelection.selectedDurationMs) <= 50
        ? "audio"
        : "custom"
    );
    setRatio(restored.ratio);
    setMatchSegments(projectToMatchSegments(restored));
    syncCaptionRecordsFromProject(restored);
    setSubtitleTimelineBasis("selection");
    if (restored.captions.length) {
      setTranscriptionState("ready");
      setTranscriptionStage("success");
      setTranscriptionProgress(100);
    }
    setJobState("done");
    setProgress(100);
    setNotice("已恢复上次工程结构；如需预览本地素材，请重新上传并在编辑器中替换关联");
  }, []);

  useEffect(() => {
    if (!editorProject) return;
    window.localStorage.setItem("medclip-editor-draft-v1", JSON.stringify(editorProject));
  }, [editorProject]);

  useEffect(() => {
    setCaptionVisibleCount(60);
  }, [captionRecords.length, subtitleSource]);

  // Proposals are bound to all relevant current-session source state. Review
  // never rebases: any manual/source change clears an active proposal and the
  // execution boundary performs the same fingerprint check again.
  useEffect(() => {
    const canvasOnly = canvasChangeRef.current;
    canvasChangeRef.current = false;
    if (creativeIntentSession.intent && !canvasOnly) {
      invalidateCreativeIntent(requirements, "项目、媒体或时间线已变化，请重新分析并确认保护范围。");
    }
    if (editorProposal) {
      setEditorProposal(null);
      setEditorProposalReview(null);
      setProposalStaleMessage("当前项目已发生变化，请重新生成剪辑建议");
    }
    setCollaborativeOptionSet(null);
    setSelectedCollaborativeOptionId(null);
    setOptionReviewById({});
    if (reviewedEvidenceProposal && editorProject?.id !== reviewedEvidenceProposal.trustedPreExecutionProject.id) {
      setReviewedPlanEvidence(null);
      setReviewedEvidenceProposal(null);
      setEditorEvaluation(null);
    }
    setProposalError(null);
    setProposalReviewError(null);
    // Proposal/evidence state is intentionally not a dependency: generating a proposal
    // is not itself a source-state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorProject, assets, audios, captionRecords, audioSelection, ratio, subtitleSource]);

  useEffect(() => {
    if (jobState !== "processing") return;
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(100, current + (current < 55 ? 5 : 3));
        if (next >= 100) {
          window.clearInterval(timer);
          setJobState("done");
          setEditorOpen(true);
          setNotice("预览片已生成，可以检查字幕和镜头顺序");
        }
        return next;
      });
    }, 360);
    return () => window.clearInterval(timer);
  }, [jobState]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (transcriptionState !== "running") return;
    const timer = window.setInterval(() => {
      setTranscriptionProgress((current) => Math.min(94, current + 1));
    }, 1800);
    return () => window.clearInterval(timer);
  }, [transcriptionState]);

  const activeStage = useMemo(() => {
    if (jobState === "done") return stages.length;
    return stages.findIndex((item) => progress < item.threshold);
  }, [jobState, progress]);

  const protectedSpeechClauses = activeConstraintSet?.activeConstraints.filter((constraint) =>
    creativeIntentSession.intent?.clauses.some((clause) =>
      clause.clauseId === constraint.sourceClauseId && clause.kind === "HARD_CONSTRAINT_REQUEST" && clause.payload.reference.semanticKind === "SPEECH"
    )).map((constraint) => constraint.sourceClauseId) ?? [];
  const speechProtected = protectedSpeechClauses.length > 0;
  const audioDuration = useMemo(
    () => audios.reduce((total, audio) => total + audio.duration, 0),
    [audios]
  );
  const audioOffsets = useMemo(() => {
    let offset = 0;
    return audios.map((audio) => {
      const current = offset;
      offset += audio.duration;
      return current;
    });
  }, [audios]);
  const waveformBars = useMemo(
    () => Array.from({ length: 72 }, (_, index) =>
      18 + Math.abs(Math.sin(index * 1.83) * 34)
        + Math.abs(Math.cos(index * 0.41) * 16)
    ),
    []
  );
  const audioDurationMs = Math.max(0, Math.round(audioDuration * 1000));
  const selectedAudioDuration = audioSelection.selectedDurationMs / 1000;
  const visualDuration = assets.reduce((total, asset) => total + (asset.duration ?? 0), 0);
  const naturalDuration = audioMode === "external" ? selectedAudioDuration : visualDuration;
  const targetDuration = durationMode === "audio"
    ? naturalDuration
    : Math.max(1, customDuration);
  const customDurationMax = Math.max(
    5,
    Math.ceil(Math.max(180, selectedAudioDuration * 2, audioDuration))
  );
  const previewDuration = Math.max(1, jobState === "done" ? (editorProject?.durationMs ?? targetDuration * 1000) / 1000 : targetDuration);
  const selectionValidation = validateAudioSelection(audioSelection);
  const parsedAudioStartMs = parseTimeMs(audioStartInput);
  const parsedAudioEndMs = parseTimeMs(audioEndInput);
  const audioSelectionInputError = audioSelection.mode === "range"
    ? parsedAudioStartMs === undefined || parsedAudioEndMs === undefined
      ? "请输入“分:秒.毫秒”或“时:分:秒.毫秒”格式。"
      : parsedAudioStartMs < 0
        ? "开始时间不能小于 0。"
        : parsedAudioEndMs > audioDurationMs
          ? "结束时间不能超过音频总时长。"
          : parsedAudioEndMs <= parsedAudioStartMs
            ? "结束时间必须晚于开始时间。"
            : ""
    : "";
  const durationMismatch = audioMode === "external" && durationMode === "custom"
    && Math.abs(targetDuration - selectedAudioDuration) > 0.05;
  const durationMismatchKind = durationMismatch
    ? targetDuration < selectedAudioDuration ? "shorter" : "longer"
    : "match";
  const subtitleCues = captionRecords;
  const activeSubtitleCue = cueAt(editorProject?.captions??subtitleCues, previewElapsed);
  const activeSubtitlePresentation = activeSubtitleCue ? captionPresentation(activeSubtitleCue) : null;
  const previewPercent = jobState === "done"
    ? Math.min(100, (previewElapsed / previewDuration) * 100)
    : progress;
  const uploadedPreviewAssets = useMemo(
    () => assets.filter((asset) => Boolean(asset.preview)),
    [assets]
  );
  const activeMatchSegment = matchSegmentAt(matchSegments, previewElapsed);
  const activeProductionOverlays = overlaysVisibleAt(editorProject?.overlays, previewElapsed * 1_000);
  const matchedAssetIndex = activeMatchSegment
    ? uploadedPreviewAssets.findIndex((asset) => asset.id === activeMatchSegment.assetId)
    : -1;
  const previewSegmentDuration = previewDuration / Math.max(1, uploadedPreviewAssets.length);
  const previewAssetIndex = matchedAssetIndex >= 0
    ? matchedAssetIndex
    : Math.min(
        Math.max(0, uploadedPreviewAssets.length - 1),
        Math.floor(previewElapsed / Math.max(0.1, previewSegmentDuration))
      );
  const previewAsset = jobState === "done" && !activeMatchSegment ? undefined : uploadedPreviewAssets[previewAssetIndex];
  const subtitlePreview = jobState === "done"
    ? activeSubtitleCue?.text ?? ""
    : subtitleCues[0]?.text
      ?? (subtitleSource === "upload" ? "等待上传或粘贴字幕文本" : "等待识别音频内容");
  const transcriptionBusy = transcriptionState === "loading" || transcriptionState === "running";
  const hasVideoForTranscription = assets.some((asset) => asset.kind === "视频" && asset.file);
  const showAudioRange = externalEnabled && audioDurationMs > 0;
  const workflowStages = useMemo(
    () => stages.map((stage) =>
      stage.label === "音频转写"
        ? {
            ...stage,
            hint: subtitleSource === "auto"
              ? "识别人声并生成时间码字幕"
              : "读取用户字幕并对齐音频"
          }
        : stage
    ),
    [subtitleSource]
  );

  useEffect(() => {
    if (!audios.length || audioDurationMs <= 0) return;
    setAudioSelection((current) => {
      if (current.sourceDurationMs === audioDurationMs) return current;
      if (current.mode === "full" || current.sourceDurationMs <= 0) {
        return createFullAudioSelection(audioDurationMs);
      }
      return normalizeAudioSelection({
        ...current,
        sourceDurationMs: audioDurationMs,
        sourceOutMs: Math.min(current.sourceOutMs, audioDurationMs)
      });
    });
  }, [audioDurationMs, audios.length]);

  useEffect(() => {
    setAudioStartInput(formatTimeMs(audioSelection.sourceInMs));
    setAudioEndInput(formatTimeMs(audioSelection.sourceOutMs));
    setSelectionPlayheadMs((current) =>
      current >= audioSelection.sourceInMs && current <= audioSelection.sourceOutMs
        ? current
        : audioSelection.sourceInMs
    );
  }, [
    audioSelection.mode,
    audioSelection.sourceInMs,
    audioSelection.sourceOutMs,
    audioSelection.sourceDurationMs
  ]);

  useEffect(() => {
    setDurationMismatchConfirmed(false);
  }, [
    audioSelection.sourceInMs,
    audioSelection.sourceOutMs,
    customDuration,
    durationMode
  ]);

  useEffect(() => {
    if (editorOpen) previewVideoRef.current?.pause();
  }, [editorOpen]);

  useEffect(() => {
    if (jobState === "done") return;
    setPreviewPlaying(false);
    previewVideoRef.current?.pause();
    previewAudioRef.current?.pause();
  }, [jobState]);

  useEffect(() => {
    previewElapsedRef.current = previewElapsed;
  }, [previewElapsed]);

  useEffect(() => {
    const clips = editorProject?.secondaryAudioClips ?? [];
    for (const [clipId, audio] of secondaryPreviewAudioRefs.current) {
      const clip = clips.find((item) => item.id === clipId);
      if (!clip || editorOpen || audioMode === "silent") {
        audio.pause();
        continue;
      }
      const timelineMs = previewElapsed * 1_000;
      const active = timelineMs >= clip.timelineStartMs && timelineMs < secondaryAudioEndMs(clip);
      if (!active) {
        audio.pause();
        continue;
      }
      const expectedSeconds = (clip.sourceStartMs + timelineMs - clip.timelineStartMs) / 1_000;
      if (Number.isFinite(audio.duration) && Math.abs(audio.currentTime - expectedSeconds) > (previewPlaying ? 0.2 : 0.025)) {
        audio.currentTime = Math.min(expectedSeconds, Math.max(0, audio.duration - 0.01));
      }
      audio.volume = secondaryAudioGainAt(clip, timelineMs);
      if (previewPlaying) {
        if (audio.paused) void audio.play().catch(() => setNotice(`无法播放辅助音频：${clip.name}`));
      } else if (!audio.paused) {
        audio.pause();
      }
    }
  }, [audioMode, editorOpen, editorProject?.secondaryAudioClips, previewElapsed, previewPlaying, secondaryAudioSources]);

  useEffect(() => {
    const audio = previewAudioRef.current;
    if (!audio) return;
    audio.playbackRate = 1;
    audio.volume = audioMode === "mix" ? musicVolume : 1;
    const pendingSeconds = Math.max(
      0,
      previewPendingSourceMsRef.current / 1000 - audioOffsetBefore(previewAudioIndex)
    );
    if (Number.isFinite(audio.duration) && Math.abs(audio.currentTime - pendingSeconds) > 0.03) {
      audio.currentTime = Math.min(Math.max(0, audio.duration - 0.01), pendingSeconds);
    }
    if (previewPlaying) {
      if (audio.paused) {
        void audio.play().catch(() => {
          setNotice("浏览器阻止了旁白自动播放，请再次点击播放");
          setPreviewPlaying(false);
        });
      }
    } else {
      if (!audio.paused) audio.pause();
    }
  }, [audioMode, musicVolume, previewAudioIndex, previewPlaying]);

  useEffect(() => {
    if (!selectionPreviewPlaying) return;
    const audio = selectionAudioRef.current;
    if (!audio) return;
    const pendingSeconds = Math.max(
      0,
      selectionPendingSourceMsRef.current / 1000 - audioOffsetBefore(selectionAudioIndex)
    );
    audio.currentTime = pendingSeconds;
    void audio.play().catch(() => {
      setSelectionPreviewPlaying(false);
    });
  }, [selectionAudioIndex, selectionPreviewPlaying]);

  useEffect(() => {
    if (editorOpen || jobState !== "done" || !previewPlaying) return;
    let lastUiUpdate = 0;
    let lastTick = performance.now();
    let lastSegment: MatchSegment | undefined;
    const synchronize = (now: number) => {
      const audio = previewAudioRef.current;
      const timelineSeconds = Math.min(previewDuration,
        audioMode === "external" && audio && !audio.ended && previewElapsedRef.current < selectedAudioDuration
          ? Math.min(selectedAudioDuration, Math.max(0, audioOffsetBefore(previewAudioIndex) + audio.currentTime - audioSelection.sourceInMs / 1000))
          : previewElapsedRef.current + (now - lastTick) / 1000
      );
      lastTick = now;
      if (audio && timelineSeconds >= selectedAudioDuration) audio.pause();
      previewElapsedRef.current = timelineSeconds;
      if (now - lastUiUpdate >= 180 || timelineSeconds >= previewDuration) {
        lastUiUpdate = now;
        setPreviewElapsed(timelineSeconds);
      }

      if (!editorOpen) {
        const segment = matchSegmentAt(matchSegments, timelineSeconds);
        const expectedAssetId = segment?.assetId ?? previewAsset?.id;
        const video = previewVideoRef.current;
        if (video && segment && expectedAssetId === previewAsset?.id) {
          const segmentDuration = segment
            ? Math.max(0.25, segment.end - segment.start)
            : previewSegmentDuration;
          const sourceStart = segment?.sourceStart ?? 0;
          const rate = segment
            ? matchSegmentRateAt(segment, timelineSeconds)
            : segmentPlaybackRate(previewAsset?.duration, segmentDuration, sourceStart, 1);
          const sourceTime = segment
            ? matchSegmentSourceTime(segment, timelineSeconds)
            : sourceStart + timelineSeconds * rate;
          if (Math.abs(video.playbackRate - rate) > 0.02) video.playbackRate = rate;
          video.volume = videoVolume;
          if (segment !== lastSegment || Math.abs(video.currentTime - sourceTime) > 0.10) {
            video.currentTime = Math.max(0, sourceTime);
          }
          lastSegment = segment;
          if (video.paused) {
            void video.play().catch(() => {
              setNotice(`无法播放素材 ${previewAssetIndex + 1}，请确认视频为浏览器支持的 MP4/H.264 格式`);
              setPreviewPlaying(false);
            });
          }
        } else {
          video?.pause();
        }
      }

      if (timelineSeconds >= previewDuration) {
        setPreviewPlaying(false);
        previewVideoRef.current?.pause();
        previewAudioRef.current?.pause();
        return;
      }
      previewSyncFrameRef.current = window.requestAnimationFrame(synchronize);
    };
    previewSyncFrameRef.current = window.requestAnimationFrame(synchronize);
    return () => {
      if (previewSyncFrameRef.current) {
        window.cancelAnimationFrame(previewSyncFrameRef.current);
        previewSyncFrameRef.current = 0;
      }
    };
  }, [
    audioMode,
    audioSelection.sourceInMs,
    editorOpen,
    jobState,
    videoVolume,
    selectedAudioDuration,
    matchSegments,
    previewAsset?.duration,
    previewAsset?.id,
    previewAudioIndex,
    previewDuration,
    previewPlaying,
    previewSegmentDuration
  ]);

  useEffect(() => {
    setPreviewMediaError("");
  }, [previewAsset?.id]);

  const canGenerate =
    assets.length > 0 &&
    (audioMode === "external" ? audioDuration > 0 : visualDuration > 0 || assets.some((asset) => asset.kind === "视频" && asset.file)) &&
    (!externalEnabled || !audios.length || (selectionValidation.valid && !audioSelectionInputError)) &&
    (!durationMismatch || durationMismatchConfirmed) &&
    !transcriptionBusy && !startingJob && renderState !== "rendering" && consent;

  const clearRenderedVideo = () => {
    if (renderedVideoUrl) URL.revokeObjectURL(renderedVideoUrl);
    setRenderedVideoUrl("");
    setRenderedVideoSize("");
    setRenderState("idle");
    setRenderProgress(0);
    setRenderError("");
  };

  const commitAudioSelection = (nextSelection: AudioSelection) => {
    audioRhythmAnalysisRef.current = null;
    const normalized = normalizeAudioSelection(nextSelection);
    if(editorProject){const next={...editorProject,audioSelection:normalized,updatedAt:new Date().toISOString()};const permission=guardManualTimelineMutationV1({currentProject:editorProject,candidateProject:next,constraintSet:activeConstraintSet??undefined});if(permission.status!=="ALLOWED"){setNotice("当前声音区间受到保护，未更改工程。");return;}setAudioSelection(normalized);setSelectionPreviewPlaying(false);selectionAudioRef.current?.pause();previewAudioRef.current?.pause();setPreviewPlaying(false);setSelectionPlayheadMs(normalized.sourceInMs);setEditorProject(next);clearRenderedVideo();setNotice("声音区间已更新，剪辑与字幕时间码保持不变，请试听核对。");return;}

    setAudioSelection(normalized);
    setSelectionPreviewPlaying(false);
    selectionAudioRef.current?.pause();
    setSelectionPlayheadMs(normalized.sourceInMs);
    if (audioMode !== "external") {
      previewAudioRef.current?.pause();
      setPreviewPlaying(false);
      setEditorProject((current) => current ? { ...current, audioSelection: normalized } : current);
      clearRenderedVideo();
      return;
    }
    if (subtitleSource === "auto") {
      setSubtitleText("");
      setCaptionRecords([]);
      setSubtitleName("");
      setRecognizedSubtitleText("");
      setSubtitleTimelineBasis("selection");
      setTranscriptionState("idle");
      setTranscriptionProgress(0);
      setTranscriptionError("");
      setTranscriptionErrorStack("");
      setFailureStage(null);
      setTranscriptionStage("waiting");
    } else if (subtitleText.trim()) {
      const hasTimedCues = subtitleText.includes("-->") || subtitleName.toLowerCase().endsWith(".ass");
      const parsed = subtitleName.toLowerCase().endsWith(".ass")
        ? parseSubtitleFile(subtitleText, subtitleName, Math.max(audioDurationMs, normalized.sourceOutMs)).captions
        : buildSubtitleCues(
            subtitleText,
            hasTimedCues && subtitleTimelineBasis === "source"
              ? audioDurationMs
              : normalized.selectedDurationMs,
            hasTimedCues
          );
      setCaptionRecords(
        hasTimedCues
          && subtitleTimelineBasis === "source"
          && normalized.mode === "range"
          ? cropAndRebaseCaptions(parsed, normalized.sourceInMs, normalized.sourceOutMs)
          : parsed
      );
    }
    setMatchSegments([]);
    setMatchingState("idle");
    setMatchingProgress(0);
    setEditorAIUndoProject(null);
    setEditorProject(null);
    setEditorOpen(false);
    // Audio-range changes never delete the saved draft.
    clearRenderedVideo();
    setJobState("idle");
    setProgress(0);
  };

  const applyAudioTimeInput = (kind: "start" | "end", value: string) => {
    if (kind === "start") setAudioStartInput(value);
    else setAudioEndInput(value);
    const parsed = parseTimeMs(value);
    if (parsed === undefined) return;
    const next = normalizeAudioSelection({
      ...audioSelection,
      mode: "range",
      sourceDurationMs: audioDurationMs,
      sourceInMs: kind === "start" ? parsed : audioSelection.sourceInMs,
      sourceOutMs: kind === "end" ? parsed : audioSelection.sourceOutMs
    });
    if (
      next.sourceOutMs > next.sourceInMs
      && parsed >= 0
      && parsed <= audioDurationMs
    ) {
      commitAudioSelection(next);
    }
  };

  const updateSubtitleCueText = (cueId: string, text: string) => {
    const updated = subtitleCues.map((cue) =>
      cue.id === cueId ? { ...cue, text } : cue
    );
    commitCaptionRecords(updated);
    clearRenderedVideo();
    if (audioMode !== "external") return;
    setMatchSegments([]);
    setMatchingState("idle");
    setJobState("idle");
    setProgress(0);
  };

  const restoreRecognizedSubtitles = () => {
    if (!recognizedSubtitleText) return;
    commitCaptionRecords(recognizedCaptionRecords.current);
    setMatchSegments([]);
    setMatchingState("idle");
    clearRenderedVideo();
    setJobState("idle");
    setProgress(0);
    setNotice("已恢复本次自动识别的原始字幕");
  };

  const downloadSubtitleFile = (cues: TimelineCaption[]) => {
    if (!cues.length) return;
    const blob = new Blob([cuesToSrt(cues)], {
      type: "application/x-subrip;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const baseName = subtitleName ? subtitleName.replace(/\.[^.]+$/, "") : "字幕";
    link.download = `${baseName}-已校对.srt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const addFiles = async (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (!incoming.length) return;
    const results = await Promise.all(incoming.map(async (file) => {
      const isVideo = file.type.startsWith("video/");
      if (!isVideo && !file.type.startsWith("image/")) return null;
      const preview = URL.createObjectURL(file);
      const duration = isVideo ? await readMediaDuration(preview, "video") : 4;
      if (!duration) {
        URL.revokeObjectURL(preview);
        return null;
      }
      return {
        id: crypto.randomUUID(),
        name: file.name,
        kind: isVideo ? ("视频" as const) : ("图片" as const),
        size: formatSize(file.size),
        preview,
        file,
        mime: file.type,
        duration,
      };
    }));
    const rejected = incoming.filter((_, index) => results[index] === null);
    setMediaImportError(rejected.length
      ? `当前浏览器不支持或无法读取：${rejected.map((file) => file.name).join("、")}。请使用 MP4（H.264/AAC）、WebM（VP8/VP9 + Opus）或 JPG、PNG、WebP。`
      : "");
    const next = results.filter((asset) => asset !== null);
    if (!next.length) return;
    if (transcriptionBusy) stopTranscription(false);
    setAssets((current) => [...current, ...next].slice(0, 30));
    setMatchSegments([]);
    setMatchingState("idle");
    setMatchingProgress(0);
    clearRenderedVideo();
    setJobState("idle");
    setProgress(0);
  };

  const relinkVisualFile=async(assetId:string,file:File)=>{
    const expected=editorProject?.assets.find(a=>a.id===assetId);if(!expected)return;
    const preview=URL.createObjectURL(file);
    try{
      const kind=file.type.startsWith("video/")?"视频":file.type.startsWith("image/")?"图片":undefined;
      if(!kind)throw new Error("请选择视频或图片文件。");
      const duration=kind==="视频"?await readMediaDuration(preview,"video"):4;
      if (!duration) throw new Error("当前浏览器无法播放这个视频，请使用 MP4（H.264/AAC）或浏览器支持的 WebM。");
      validateVisualRelink(expected,{name:file.name,kind,durationMs:Math.round((duration??0)*1000)});
      if(transcriptionBusy)stopTranscription(false);
      videoAnalysisAbortRef.current.get(assetId)?.abort();videoAnalysisAbortRef.current.delete(assetId);
      semanticAnalysisCacheRef.current.invalidateAsset(assetId);visualInsightCacheRef.current.delete(assetId);
      setAssets(current=>[...current.filter(a=>a.id!==assetId),{id:assetId,name:expected.name,kind,size:formatSize(file.size),preview,file,mime:file.type,duration}]);
      clearRenderedVideo();setNotice("已恢复素材关联，请核对画面。原有剪辑位置和字幕未改变。");
    }catch(error){URL.revokeObjectURL(preview);setNotice(error instanceof Error?error.message:"无法关联该文件。");}
  };

  const handleMediaChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addFiles(event.target.files);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(event.dataTransfer.files);
  };

  const handleAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
      .filter((file) => file.type.startsWith("audio/"));
    if (!files.length) return;
    if (transcriptionState === "loading" || transcriptionState === "running") {
      stopTranscription(false);
    }
    audioRhythmAnalysisRef.current = null;
    const next = await Promise.all(files.map(async (file) => {
      const url = URL.createObjectURL(file);
      const duration = await readMediaDuration(url, "audio");
      return {
        id: crypto.randomUUID(),
        name: file.name,
        size: formatSize(file.size),
        url,
        duration: duration ?? 0
      };
    }));
    setAudios((current) => [...current, ...next].slice(0, 10));
    if(editorProject||captionRecords.length){if(editorProject&&!audioModeChoice)setAudioModeChoice(audioMode);clearRenderedVideo();setNotice("已添加声音文件，时间线和字幕已保留。请选择需要的声音模式。");event.target.value="";return;}
    if (audioModeChoice && audioModeChoice !== "external") {
      clearRenderedVideo();
      event.target.value = "";
      return;
    }
    if (subtitleSource === "auto") {
      setSubtitleText("");
      setCaptionRecords([]);
      setSubtitleName("");
      setRecognizedSubtitleText("");
      setTranscriptionState("idle");
      setTranscriptionProgress(0);
      setTranscriptionError("");
      setTranscriptionStage("waiting");
    }
    setMatchSegments([]);
    setMatchingState("idle");
    setMatchingProgress(0);
    clearRenderedVideo();
    setJobState("idle");
    setProgress(0);
    setEditorAIUndoProject(null);
    setEditorProject(null);
    setEditorOpen(false);
    setNotice(`已添加 ${next.length} 段音频`);
    event.target.value = "";
  };

  const removeAudio = (id: string) => {
    if (transcriptionState === "loading" || transcriptionState === "running") {
      stopTranscription(false);
    }
    audioRhythmAnalysisRef.current = null;
    setAudios((current) => {
      const item = current.find((audio) => audio.id === id);
      if (item?.url) URL.revokeObjectURL(item.url);
      const remaining = current.filter((audio) => audio.id !== id);
      if (!remaining.length) {
        setAudioSelection(createFullAudioSelection(0));
        setAudioStartInput("00:00.000");
        setAudioEndInput("00:00.000");
      }
      return remaining;
    });
    if(editorProject||captionRecords.length){if(editorProject&&!audioModeChoice)setAudioModeChoice(audioMode);clearRenderedVideo();setNotice("已移除声音文件，剪辑与字幕保留。需要时请选择其他声音模式。");return;}
    if (audioModeChoice && audioModeChoice !== "external") {
      clearRenderedVideo();
      return;
    }
    if (subtitleSource === "auto") {
      setSubtitleText("");
      setCaptionRecords([]);
      setRecognizedSubtitleText("");
      setTranscriptionState("idle");
      setTranscriptionProgress(0);
      setTranscriptionError("");
      setTranscriptionStage("waiting");
    }
    setMatchSegments([]);
    setEditorAIUndoProject(null);
    setEditorProject(null);
    setEditorOpen(false);
    clearRenderedVideo();
    setJobState("idle");
    setProgress(0);
  };

  const handleSubtitleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseSubtitleFile(
        text,
        file.name,
        audioMode === "external" && audioDurationMs > 0 ? audioDurationMs : 86_400_000,
      ).captions;
      const selected = audioMode === "external" && audioSelection.mode === "range"
        ? cropAndRebaseCaptions(parsed, audioSelection.sourceInMs, audioSelection.sourceOutMs)
        : parsed;
      if (!selected.length) throw new Error("字幕时间不在当前音频范围内。");
      if(editorProject&&selected.some(c=>c.startMs<0||c.endMs>editorProject.durationMs))throw new Error("字幕超出当前成片时长，未改写时间码。请先调整时间线后再导入。");
      setSubtitleName(file.name);
      setSubtitleText(text);
      setCaptionRecords(selected);
      setSubtitleTimelineBasis("source");
      setRecognizedSubtitleText("");
      setTranscriptionState("ready");
      setTranscriptionProgress(100);
      setTranscriptionError("");
      setTranscriptionStage("success");
      if(editorProject){const permission=guardManualTimelineMutationV1({currentProject:editorProject,candidateProject:{...editorProject,captions:selected},constraintSet:activeConstraintSet??undefined});if(permission.status!=="ALLOWED")throw new Error("当前字幕受到保护，原字幕未更改。");commitCaptionRecords(selected);clearRenderedVideo();setNotice("字幕已导入，时间码保持不变。");return;}
      setMatchSegments([]);
      setMatchingState("idle");
      setJobState("idle");
      setProgress(0);
      setNotice(`已读取字幕文件：${file.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "字幕文件读取失败。";
      setTranscriptionError(message);
      setNotice(message);
    } finally {
      event.target.value = "";
    }
  };

  const removeAsset = (id: string) => {
    if (transcriptionBusy) stopTranscription(false);
    videoAnalysisAbortRef.current.get(id)?.abort();
    videoAnalysisAbortRef.current.delete(id);
    semanticAnalysisCacheRef.current.invalidateAsset(id);
    visualInsightCacheRef.current.delete(id);
    setAssets((current) => {
      const item = current.find((asset) => asset.id === id);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return current.filter((asset) => asset.id !== id);
    });
    setMatchSegments([]);
    setMatchingState("idle");
    clearRenderedVideo();
  };

  const loadDemo = () => {
    videoAnalysisAbortRef.current.forEach((controller) => controller.abort());
    videoAnalysisAbortRef.current.clear();
    semanticAnalysisCacheRef.current.clear();
    visualInsightCacheRef.current.clear();
    audioRhythmAnalysisRef.current = null;
    setAssets([
      { id: "demo-1", name: "医生问诊.mp4", kind: "视频", size: "42.8 MB", duration: 22 },
      { id: "demo-2", name: "心脏结构示意.mp4", kind: "视频", size: "31.2 MB", duration: 19 },
      { id: "demo-3", name: "检查报告.jpg", kind: "图片", size: "2.4 MB", duration: 4 },
      { id: "demo-4", name: "健康生活方式.mp4", kind: "视频", size: "56.1 MB", duration: 34 }
    ]);
    setAudios([
      { id: "audio-demo-1", name: "开场与病因旁白.wav", size: "3.2 MB", duration: 32 },
      { id: "audio-demo-2", name: "预防建议旁白.wav", size: "5.4 MB", duration: 53 }
    ]);
    setDurationMode("audio");
    setCustomDuration(60);
    setRequirements("视频 1 使用音频 1；视频 2 和视频 4 使用音频 2；检查报告图片在音频 2 提到检查指标时出现。");
    setRequirementDraft("视频 1 使用音频 1；视频 2 和视频 4 使用音频 2；检查报告图片在音频 2 提到检查指标时出现。");
    setSubtitleSource("auto");
    setSubtitleName("");
    setSubtitleText("");
    setCaptionRecords([]);
    setRecognizedSubtitleText("");
    setTranscriptionState("idle");
    setTranscriptionProgress(0);
    setTranscriptionError("");
    setTranscriptionStage("waiting");
    setConsent(true);
    setPreviewPlaying(false);
    setPreviewElapsed(0);
    setPreviewAudioIndex(0);
    clearRenderedVideo();
    setJobState("idle");
    setProgress(0);
    setNotice("已载入演示素材");
  };

  const locateAudioAt = (seconds: number) => {
    let remaining = seconds;
    for (let index = 0; index < audios.length; index += 1) {
      const duration = audios[index].duration;
      if (remaining < duration || index === audios.length - 1) {
        return { index, offset: Math.min(remaining, Math.max(0, duration - 0.05)) };
      }
      remaining -= duration;
    }
    return { index: 0, offset: 0 };
  };

  const audioOffsetBefore = (index: number) =>
    audioOffsets[index] ?? audioDuration;

  const pauseSelectionPreview = () => {
    setSelectionPreviewPlaying(false);
    selectionAudioRef.current?.pause();
  };

  const playSelectionPreview = () => {
    if (!audios.some((audio) => audio.url) || !selectionValidation.valid) {
      setNotice("请先上传可播放的音频并选择有效区间");
      return;
    }
    const sourceMs = selectionPlayheadMs >= audioSelection.sourceInMs
      && selectionPlayheadMs < audioSelection.sourceOutMs
      ? selectionPlayheadMs
      : audioSelection.sourceInMs;
    const position = locateAudioAt(sourceMs / 1000);
    selectionPendingSourceMsRef.current = sourceMs;
    setSelectionAudioIndex(position.index);
    setSelectionPlayheadMs(sourceMs);
    setSelectionPreviewPlaying(true);
    window.requestAnimationFrame(() => {
      const audio = selectionAudioRef.current;
      if (!audio) return;
      audio.currentTime = position.offset;
      void audio.play().catch(() => {
        setSelectionPreviewPlaying(false);
        setNotice("浏览器阻止了区间试听，请再次点击试听");
      });
    });
  };

  const handleSelectionTimeUpdate = (audio: HTMLAudioElement) => {
    const globalSourceMs = Math.round((audioOffsetBefore(selectionAudioIndex) + audio.currentTime) * 1000);
    if (globalSourceMs >= audioSelection.sourceOutMs) {
      pauseSelectionPreview();
      setSelectionPlayheadMs(audioSelection.sourceOutMs);
      return;
    }
    setSelectionPlayheadMs(globalSourceMs);
  };

  const handleSelectionAudioEnded = () => {
    const nextIndex = selectionAudioIndex + 1;
    const nextSourceMs = Math.round(audioOffsetBefore(nextIndex) * 1000);
    if (
      selectionPreviewPlaying
      && nextIndex < audios.length
      && nextSourceMs < audioSelection.sourceOutMs
      && audios[nextIndex]?.url
    ) {
      selectionPendingSourceMsRef.current = nextSourceMs;
      setSelectionAudioIndex(nextIndex);
      window.requestAnimationFrame(() => {
        const audio = selectionAudioRef.current;
        if (!audio) return;
        audio.currentTime = 0;
        void audio.play().catch(() => setSelectionPreviewPlaying(false));
      });
      return;
    }
    pauseSelectionPreview();
  };

  const syncPreviewMedia = (
    seconds: number,
    shouldPlay: boolean,
    syncVisual = true
  ) => {
    const currentSegment = matchSegmentAt(matchSegments, seconds);
    const currentAsset = currentSegment
      ? uploadedPreviewAssets.find((asset) => asset.id === currentSegment.assetId)
      : previewAsset;
    const segmentDuration = currentSegment
      ? Math.max(0.25, currentSegment.end - currentSegment.start)
      : previewSegmentDuration;
    const sourceStart = currentSegment?.sourceStart ?? 0;
    const playbackRate = currentSegment
      ? matchSegmentRateAt(currentSegment, seconds)
      : segmentPlaybackRate(currentAsset?.duration, segmentDuration, sourceStart, 1);
    const video = syncVisual ? previewVideoRef.current : null;
    if (video && currentSegment && currentAsset?.id === previewAsset?.id) {
      video.volume = videoVolume;
      video.playbackRate = playbackRate;
      if (Number.isFinite(video.duration) && video.duration > 0) {
        const segmentOffset = currentSegment ? Math.max(0, seconds - currentSegment.start) : seconds;
        video.currentTime = Math.min(
          Math.max(0, video.duration - 0.05),
          currentSegment
            ? matchSegmentSourceTime(currentSegment, seconds)
            : sourceStart + segmentOffset * playbackRate
        );
      }
      if (shouldPlay) {
        void video.play().catch(() => {
          setNotice("视频预览播放被浏览器阻止，请再次点击播放");
          setPreviewPlaying(false);
        });
      } else {
        video.pause();
      }
    }

    if (!externalEnabled || seconds >= selectedAudioDuration) {
      previewAudioRef.current?.pause();
      return;
    }
    const audioPosition = locateAudioAt(audioSelection.sourceInMs / 1000 + seconds);
    previewPendingSourceMsRef.current = Math.round(
      (audioSelection.sourceInMs / 1000 + seconds) * 1000
    );
    setPreviewAudioIndex(audioPosition.index);
    const audio = previewAudioRef.current;
    if (audio && previewAudioIndex === audioPosition.index) {
      audio.playbackRate = 1;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = Math.min(Math.max(0, audio.duration - 0.01), audioPosition.offset);
      }
      if (shouldPlay && audio.paused) {
        void audio.play().catch(() => {
          setNotice("旁白播放被浏览器阻止，请再次点击播放");
          setPreviewPlaying(false);
        });
      } else if (!shouldPlay && !audio.paused) {
        audio.pause();
      }
    }
  };

  const togglePreviewPlayback = () => {
    if (jobState !== "done") {
      setNotice("请先生成剪辑预览");
      return;
    }
    if (previewPlaying) {
      setPreviewPlaying(false);
      syncPreviewMedia(previewElapsed, false);
      return;
    }
    const startAt = previewElapsed >= previewDuration ? 0 : previewElapsed;
    previewElapsedRef.current = startAt;
    setPreviewElapsed(startAt);
    setPreviewPlaying(true);
    syncPreviewMedia(startAt, true);
  };

  const seekPreview = (seconds: number) => {
    const next = Math.min(previewDuration, Math.max(0, seconds));
    previewElapsedRef.current = next;
    setPreviewElapsed(next);
    syncPreviewMedia(next, previewPlaying);
  };

  const extractVideoSpeech = async (asset: Asset) => {
    if (!asset.file) throw new Error(`请重新关联视频“${asset.name}”。`);
    if (asset.file.size > 750 * 1024 * 1024) throw new Error(`“${asset.name}”超过浏览器提取上限 750 MB，请先拆分视频。`);
    try {
      if (!asset.duration) throw new Error("无法确定视频时长。");
      return await decodeVideoSpeechPcm(asset.file, asset.duration);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TranscriptionFailure(
        "audio-decode", "preparing-audio",
        `无法提取“${asset.name}”的原声：${detail} 请尝试 MP4（H.264/AAC）、WebM（VP8/VP9 + Opus）或上传独立音频。`,
        { cause: error }
      );
    }
  };

  const transcribeVideoSpeech = async (runToken: number) => {
    const assertCurrent = () => {
      if (runToken !== transcriptionRunTokenRef.current) throw new DOMException("音频识别已取消", "AbortError");
    };
    if (activeConstraintSet?.activeConstraints.length) {
      throw new TranscriptionFailure("result-format", "preparing-audio", "当前工程有已确认的保护约束，请先解除保护再重新识别字幕。");
    }
    const prepared = assets;
    assertCurrent();
    const visualLength = prepared.reduce((total, asset) => total + (asset.duration ?? 0), 0);
    const initialDuration = durationMode === "custom" ? Math.min(targetDuration, visualLength) : visualLength;
    const project = jobState === "done" && editorProject
      ? editorProject
      : createEditorProject(sourceOrderPlan(prepared, initialDuration), [], prepared, audioSelection, initialDuration, ratio);
    const clips = project.tracks.filter((track) => track.type === "video" || track.type === "broll")
      .flatMap((track) => track.clips);
    const segments = projectToMatchSegments(project);
    const assetIds = [...new Set(clips.filter((clip) => clip.kind === "视频").map((clip) => clip.assetId))];
    const captions: TimelineCaption[] = [];
    const noTrack: string[] = [];
    let silentTracks = 0;
    for (const assetId of assetIds) {
      const asset = prepared.find((item) => item.id === assetId);
      if (!asset) throw new Error("请重新关联时间线中的视频素材后再识别。");
      setTranscriptionStage("preparing-audio");
      const extraction = videoAudioQueueRef.current.then(() => {
        assertCurrent();
        return extractVideoSpeech(asset);
      });
      videoAudioQueueRef.current = extraction.catch(() => undefined);
      const samples = await extraction;
      assertCurrent();
      if (!samples) {
        noTrack.push(asset.name);
        continue;
      }
      if (!samples.some((value) => Math.abs(value) > 0.0025)) {
        silentTracks++;
        continue;
      }
      // Ignore isolated clicks when trimming leading silence. Keep preroll
      // and restore the actual sample offset to every model timestamp.
      const firstActivity = detectSpeechRegions(samples, 16_000)[0];
      const inputStart = Math.min(samples.length, Math.max(0, (firstActivity?.startMs ?? 0) - 150) * 16);
      const input = new Float32Array(samples.length - inputStart + 16_000);
      input.set(samples.subarray(inputStart));
      const offsetMs = Math.round(inputStart / 16);
      const recognize = async (retry: boolean) => {
        setTranscriptionStage("loading-model");
        const result = await requestTranscription(
          input.slice(),
          retry || transcriptionQuality === "accurate" ? "Xenova/whisper-base" : "Xenova/whisper-tiny",
          medicalTerms.trim() ? `医学术语：${medicalTerms.trim()}` : "",
          retry,
        );
        assertCurrent();
        setTranscriptionStage("timestamping");
        return videoTranscriptionSegments(result, Math.round(input.length / 16)).map((cue) => ({
          ...cue,
          startMs: cue.startMs + offsetMs,
          endMs: cue.endMs + offsetMs,
        }));
      };
      let cues: TimelineCaption[];
      try {
        cues = await recognize(false);
      } catch (error) {
        if (!(error instanceof TranscriptionFailure) || error.code !== "result-format") throw error;
        cues = await recognize(true);
      }
      for (const clip of clips.filter((item) => item.assetId === assetId)) {
        for (const cue of cues) {
          const mapped = placeVideoCaption(cue, clip);
          if (!mapped) continue;
          const boundaries = [...new Set([mapped.startMs, mapped.endMs, ...clips.flatMap((item) => [item.timelineStartMs, item.timelineEndMs])
            .filter((time) => time > mapped.startMs && time < mapped.endMs)])].sort((a, b) => a - b);
          for (let index = 1; index < boundaries.length; index++) {
            const startMs = boundaries[index - 1];
            const endMs = boundaries[index];
            if (matchSegmentAt(segments, (startMs + endMs) / 2000)?.id !== clip.id) continue;
            const id = `${clip.id}:${cue.id}`;
            const previous = captions.at(-1);
            if (previous?.id.startsWith(`${id}:`) && previous.endMs === startMs) previous.endMs = endMs;
            else captions.push({ ...mapped, id: `${id}:${index}`, startMs, endMs });
          }
        }
      }
    }
    if (!captions.length) {
      throw new TranscriptionFailure("audio-empty", "preparing-audio", noTrack.length === assetIds.length
        ? "视频没有音轨，无法自动识别。可以跳过字幕继续剪辑。"
        : "当前视频片段没有可用的带时间码字幕。可以跳过字幕继续剪辑。");
    }
    captions.sort((a, b) => a.startMs - b.startMs);
    const simplified = await simplifyWhisperCaptions(captions);
    assertCurrent();
    setEditorProject({ ...project, captions: simplified, updatedAt: new Date().toISOString() });
    setMatchSegments(segments);
    if (noTrack.length || silentTracks) setNotice(`已识别原声字幕，跳过 ${noTrack.length + silentTracks} 段无音轨或静音视频`);
    else setNotice("已识别视频原声，可逐句校对字幕");
    return simplified;
  };

  const transcribeAudio = async () => {
    if (activeTranscriptionRequestRef.current) stopTranscription(false);
    const runToken = ++transcriptionRunTokenRef.current;
    audioRhythmAnalysisRef.current = null;
    setTranscriptionState("loading");
    setTranscriptionProgress(2);
    setTranscriptionError("");
    setTranscriptionErrorStack("");
    setFailureStage(null);
    setTranscriptionStage("preparing-audio");

    try {
      if (videoTranscription) {
        const captions = await transcribeVideoSpeech(runToken);
        setCaptionRecords(captions);
        setSubtitleText(cuesToSrt(captions));
        recognizedCaptionRecords.current = captions;
        setRecognizedSubtitleText(cuesToSrt(captions));
        setSubtitleName("视频原声字幕.srt");
        setSubtitleTimelineBasis("selection");
        setTranscriptionProgress(100);
        setTranscriptionState("ready");
        setTranscriptionStage("success");
        clearRenderedVideo();
        return captions;
      }
      const tracks = audios.filter((audio) => Boolean(audio.url));
      if (!tracks.length) {
        throw new TranscriptionFailure(
          "audio-unreadable",
          "preparing-audio",
          "没有可读取的音频文件；Blob 地址可能已失效，请重新上传音频。"
        );
      }
      const transcriptionModel = transcriptionQuality === "accurate"
        ? "Xenova/whisper-base"
        : "Xenova/whisper-tiny";

      const decodedTracks: Float32Array[] = [];
      for (let index = 0; index < tracks.length; index += 1) {
        const audio = tracks[index];
        if (!audio.url) continue;
        setTranscriptionProgress(3 + Math.round(((index + 1) / tracks.length) * 7));
        try {
          decodedTracks.push(await decodeAudioToMono16k(audio.url));
        } catch (error) {
          throw new TranscriptionFailure(
            "audio-decode",
            "preparing-audio",
            `无法解码音频“${audio.name}”，请使用有效的 WAV、MP3 或 M4A 文件。`,
            { cause: error }
          );
        }
        if (runToken !== transcriptionRunTokenRef.current) {
          throw new DOMException("音频识别已取消", "AbortError");
        }
      }

      const totalSamples = decodedTracks.reduce((sum, samples) => sum + samples.length, 0);
      if (!totalSamples) {
        throw new TranscriptionFailure(
          "audio-empty",
          "preparing-audio",
          "音频解码后没有PCM采样数据。"
        );
      }
      const combined = new Float32Array(totalSamples);
      let writeOffset = 0;
      decodedTracks.forEach((samples) => {
        combined.set(samples, writeOffset);
        writeOffset += samples.length;
      });

      const selectionStartSample = Math.min(
        combined.length,
        Math.max(0, Math.round(audioSelection.sourceInMs / 1000 * 16000))
      );
      const selectionEndSample = Math.min(
        combined.length,
        Math.max(selectionStartSample + 1, Math.round(audioSelection.sourceOutMs / 1000 * 16000))
      );
      const selectedSamples = combined.slice(selectionStartSample, selectionEndSample);
      if (!selectedSamples.length) {
        throw new TranscriptionFailure(
          "audio-empty",
          "preparing-audio",
          "所选音频区间没有PCM采样数据。"
        );
      }
      // postMessage transfers and detaches selectedSamples.buffer. Capture the
      // exact integer duration before handing ownership to the worker.
      const recognizedDurationMs = Math.round(selectedSamples.length / 16000 * 1000);
      const speechRegions = detectSpeechRegions(selectedSamples, 16000);
      try {
        audioRhythmAnalysisRef.current = analyzeAudioRhythm({
          sourceId: createAudioRhythmSourceId(tracks.map((track) => track.id)),
          samples: selectedSamples,
          sampleRate: 16_000,
          speechRegions,
        });
      } catch {
        // Rhythm evidence is additive. A controlled local-analysis failure must
        // not change the established transcription or caption-timing behavior.
        audioRhythmAnalysisRef.current = null;
      }
      const prompt = [
        referenceTranscript.trim(),
        medicalTerms.trim()
          ? `医学术语：${medicalTerms.trim()}`
          : ""
      ].filter(Boolean).join("\n");
      setTranscriptionStage("loading-model");
      let result = await requestTranscription(
        selectedSamples.slice(),
        transcriptionModel,
        prompt
      );
      if (runToken !== transcriptionRunTokenRef.current) {
        throw new DOMException("音频识别已取消", "AbortError");
      }
      setTranscriptionStage("timestamping");
      setTranscriptionProgress(94);
      let wordTimedCaptions: TimelineCaption[];
      try {
        wordTimedCaptions = transcriptionOutputToCaptions(
          result,
          recognizedDurationMs,
          speechRegions
        );
      } catch (error) {
        if (
          !(error instanceof TranscriptionFailure)
          || error.code !== "result-format"
          || error.stage !== "timestamping"
        ) throw error;
        // A second recognition pass uses full sequences and a tighter overlap.
        // If it still lacks reliable timing, the original format failure is
        // surfaced instead of fabricating timestamps from character counts.
        setTranscriptionStage("loading-model");
        setTranscriptionProgress(76);
        result = await requestTranscription(
          selectedSamples.slice(),
          "Xenova/whisper-base",
          prompt,
          true
        );
        setTranscriptionStage("timestamping");
        setTranscriptionProgress(94);
        try {
          wordTimedCaptions = transcriptionOutputToCaptions(
            result,
            recognizedDurationMs,
            speechRegions
          );
        } catch (retryError) {
          if (retryError instanceof TranscriptionFailure && retryError.code === "result-format") {
            throw new TranscriptionFailure(
              "result-format",
              "timestamping",
              `两次识别均未返回可靠词级时间戳：${retryError.message}`,
              { cause: retryError }
            );
          }
          throw retryError;
        }
      }
      setTranscriptionStage("segmenting");
      setTranscriptionProgress(97);
      const simplified = await simplifyWhisperCaptions(wordTimedCaptions);
      if (runToken !== transcriptionRunTokenRef.current) throw new DOMException("音频识别已取消", "AbortError");
      const captions = referenceTranscript.trim()
        ? applyReferenceTranscript(simplified, referenceTranscript)
        : simplified;
      if (!captions.length) {
        throw new TranscriptionFailure(
          "result-format",
          "segmenting",
          "识别完成但未生成有效字幕。"
        );
      }
      const srt = cuesToSrt(captions);
      commitCaptionRecords(captions);
      recognizedCaptionRecords.current = captions;
      setRecognizedSubtitleText(srt);
      setSubtitleName("自动识别字幕.srt");
      setSubtitleTimelineBasis("selection");
      setTranscriptionProgress(100);
      setTranscriptionState("ready");
      setTranscriptionStage("success");
      setTranscriptionError("");
      setTranscriptionErrorStack("");
      setFailureStage(null);
      setMatchSegments([]);
      setMatchingState("idle");
      setEditorProject((current) => current ?? createEditorProject(
        [],
        captions,
        assets,
        audioSelection,
        recognizedDurationMs / 1000,
        ratio, fillMode === "居中留黑边" ? "contain" : "cover"
      ));
      clearRenderedVideo();
      return captions;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (runToken === transcriptionRunTokenRef.current) setTranscriptionStage("cancelled");
        throw error;
      }
      if (runToken !== transcriptionRunTokenRef.current) throw new DOMException("音频识别已取消", "AbortError");
      const errorRecord = error && typeof error === "object"
        ? error as { name?: unknown; message?: unknown; stack?: unknown }
        : undefined;
      const errorMessage = errorRecord?.message;
      const detail = typeof errorMessage === "string" && errorMessage.trim()
        ? `${typeof errorRecord?.name === "string" && errorRecord.name ? `${errorRecord.name}: ` : ""}${errorMessage}`
        : typeof error === "string" && error.trim()
          ? error
          : (() => {
              try {
                return error && typeof error === "object"
                  ? JSON.stringify(error) || "未知错误"
                  : String(error || "未知错误");
              } catch {
                return String(error || "未知错误");
              }
            })();
      const stage = error instanceof TranscriptionFailure
        ? error.stage
        : transcriptionStageRef.current;
      setTranscriptionState("error");
      setTranscriptionProgress(0);
      setTranscriptionError(detail);
      setFailureStage(stage);
      setTranscriptionStage("error");
      setTranscriptionErrorStack(
        process.env.NODE_ENV !== "production" && typeof errorRecord?.stack === "string"
          ? errorRecord.stack
          : ""
      );
      console.error("[MedClip ASR]", {
        stage,
        message: detail,
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error instanceof Error
        ? error
        : new Error(`音频识别失败：${detail}`);
    }
  };

  const captureAssetFrames = async (asset: Asset, detailedSampling: boolean) => {
    if (!asset.preview) throw new Error(`素材 ${asset.name} 没有可分析的画面`);
    const samples = await captureBoundedFrameSamples({
      assetId: asset.id,
      name: asset.name,
      kind: asset.kind === "图片" ? "image" : "video",
      sourceUrl: asset.preview,
      assetDurationMs: asset.duration === undefined ? undefined : Math.round(asset.duration * 1_000),
    }, detailedSampling);
    return samples.map((sample) => ({ image: sample.image, at: sample.sourceTimeMs / 1_000 }));
  };

  const buildMatchPlan = (
    cues: TimelineCaption[],
    preparedAssets: Asset[],
    insights: Map<string, AssetVisualInsight>
  ) => {
    const visualAssets = preparedAssets.filter((asset) => Boolean(asset.preview));
    if (!visualAssets.length) return [];
    const sourceCues = cues.length
      ? cues
      : [{ id: "full", startMs: 0, endMs: Math.round(targetDuration * 1000), text: "" }];
    const usage = new Map<string, number>();
    let previousAssetId = "";
    let previousTopics: ReturnType<typeof topicsForText> = [];
    let previousTopicIndex = -10;

    const planned = sourceCues.map((cue, index) => {
      const explicitTopics = topicsForText(cue.text);
      if (explicitTopics.length) {
        previousTopics = explicitTopics;
        previousTopicIndex = index;
      }
      const inheritedTopic = !explicitTopics.length && index - previousTopicIndex <= 2;
      const desiredTopics = explicitTopics.length ? explicitTopics : inheritedTopic ? previousTopics : [];
      const totalTopicWeight = desiredTopics.reduce((sum, item) => sum + item.score, 0) || 1;

      const ranked = visualAssets.map((asset, assetIndex) => {
        const insight = insights.get(asset.id);
        const frames = insight?.frames.length
          ? insight.frames
          : [{ at: 0, scores: insight?.scores ?? new Map<string, number>() }];
        const rankedFrames = frames.map((frame) => {
          const semanticScore = desiredTopics.length
            ? desiredTopics.reduce(
                (sum, item) =>
                  sum + (frame.scores.get(item.topic.title) ?? 0) * item.score,
                0
              ) / totalTopicWeight
            : Math.max(0, ...frame.scores.values());
          return { frame, semanticScore };
        }).sort((left, right) => right.semanticScore - left.semanticScore);
        const bestFrame = rankedFrames[0];
        const nameTopics = topicsForText(asset.name);
        const nameBonus = desiredTopics.some((desired) =>
          nameTopics.some((named) => named.topic.title === desired.topic.title)
        ) ? 0.16 : 0;
        const continuityBonus = asset.id === previousAssetId
          ? desiredTopics.length ? 0.07 : 0.12
          : 0;
        const usagePenalty = (usage.get(asset.id) ?? 0) * 0.018;
        const orderBias = ((visualAssets.length - assetIndex) / visualAssets.length) * 0.003;
        return {
          asset,
          frame: bestFrame.frame,
          semanticScore: bestFrame.semanticScore,
          score: bestFrame.semanticScore + nameBonus + continuityBonus - usagePenalty + orderBias
        };
      }).sort((left, right) => right.score - left.score);

      const selected = ranked[0];
      const asset = selected.asset;
      usage.set(asset.id, (usage.get(asset.id) ?? 0) + 1);
      previousAssetId = asset.id;
      const start = index === 0 ? 0 : cue.startMs / 1000;
      const nextCue = sourceCues[index + 1];
      const end = nextCue
        ? Math.max(start + 0.1, nextCue.startMs / 1000)
        : targetDuration;
      const segmentDuration = Math.max(0.25, end - start);
      const maxSourceStart = Math.max(0, (asset.duration ?? 0) - segmentDuration);
      const sourceStart = asset.kind === "视频"
        ? Math.min(maxSourceStart, Math.max(0, selected.frame.at - Math.min(1, segmentDuration * 0.25)))
        : 0;
      const matchedTopic = desiredTopics[0]?.topic.title
        ?? [...selected.frame.scores.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
        ?? "医学画面";
      const cueExcerpt = cue.text.trim().replace(/\s+/g, "").slice(0, 14);
      const reason = desiredTopics.length
        ? `${inheritedTopic ? "承接上一句" : `匹配“${cueExcerpt}${cue.text.length > 14 ? "…" : ""}”`}，${matchedTopic}`
        : `根据画面内容与旁白节奏安排，${matchedTopic}`;
      return {
        start,
        end,
        assetId: asset.id,
        reason,
        sourceStart,
        matchScore: selected.semanticScore,
        matchedTopic
      };
    });
    const compacted = planned.reduce<MatchSegment[]>((segments, segment) => {
      const previous = segments.at(-1);
      if (
        previous
        && previous.assetId === segment.assetId
        && previous.matchedTopic === segment.matchedTopic
        && Math.abs(previous.end - segment.start) < 0.2
      ) {
        previous.end = segment.end;
        return segments;
      }
      segments.push({ ...segment });
      return segments;
    }, []);

    const preferredRate = 1;
    const sourceCursors = new Map<string, number>();
    const allocatedSeconds = new Map<string, number>();
    const allocated: MatchSegment[] = [];
    let previousAllocatedAssetId = "";
    let fallbackShotIndex = 0;

    compacted.forEach((segment) => {
      const primaryAssetId = segment.assetId;
      let timelineCursor = segment.start;

      while (timelineCursor < segment.end - 0.05) {
        const remainingTimeline = segment.end - timelineCursor;
        const rankedCandidates = visualAssets
          .map((asset, assetIndex) => {
            const insight = insights.get(asset.id);
            const semanticScore = segment.matchedTopic
              ? Math.max(
                  0,
                  ...(insight?.frames ?? []).map(
                    (frame) => frame.scores.get(segment.matchedTopic ?? "") ?? 0
                  ),
                  insight?.scores.get(segment.matchedTopic) ?? 0
                )
              : Math.max(0, ...(insight?.scores.values() ?? []));
            const usedTimeline = allocatedSeconds.get(asset.id) ?? 0;
            const sourceCursor = sourceCursors.get(asset.id) ?? 0;
            const availableTimeline = asset.kind === "视频"
              ? Math.max(0, ((asset.duration ?? 0) - sourceCursor) / preferredRate)
              : Math.max(0, MAX_IMAGE_TOTAL_SECONDS - usedTimeline);
            const isPrimary = asset.id === primaryAssetId;
            const isPrevious = asset.id === previousAllocatedAssetId;
            const continuityAdjustment = asset.kind === "图片" && isPrevious
              ? -0.35
              : isPrevious
                ? 0.02
                : 0;
            const usagePenalty = usedTimeline * (asset.kind === "图片" ? 0.018 : 0.004);
            const orderBias = ((visualAssets.length - assetIndex) / visualAssets.length) * 0.002;
            return {
              asset,
              availableTimeline,
              semanticScore,
              score: semanticScore
                + (isPrimary ? 0.14 : 0)
                + continuityAdjustment
                - usagePenalty
                + orderBias
            };
          })
          .filter((candidate) => candidate.availableTimeline >= 0.35)
          .sort((left, right) => right.score - left.score);

        const selected = rankedCandidates[0];
        if (selected) {
          const asset = selected.asset;
          const maxShotDuration = asset.kind === "视频"
            ? MAX_VIDEO_SHOT_SECONDS
            : MAX_IMAGE_SHOT_SECONDS;
          const shotDuration = Math.min(
            remainingTimeline,
            maxShotDuration,
            selected.availableTimeline
          );
          const sourceStart = asset.kind === "视频"
            ? sourceCursors.get(asset.id) ?? 0
            : 0;
            const playbackRate = 1;
          const alternateReason = asset.id !== primaryAssetId
            ? "，语义匹配素材接力"
            : "";

          allocated.push({
            ...segment,
            start: timelineCursor,
            end: timelineCursor + shotDuration,
            assetId: asset.id,
              sourceStart,
              sourceEnd: asset.kind === "视频"
                ? sourceStart + shotDuration
                : sourceStart,
              playbackRate,
            matchScore: selected.semanticScore,
            reason: `${segment.reason}${alternateReason}，${
              asset.kind === "视频"
                ? "1.00× 原速连续播放"
                : "静态素材短镜头"
            }`
          });
          if (asset.kind === "视频") {
            sourceCursors.set(
              asset.id,
              Math.min(
                asset.duration ?? 0,
                sourceStart + shotDuration * playbackRate
              )
            );
          }
          allocatedSeconds.set(
            asset.id,
            (allocatedSeconds.get(asset.id) ?? 0) + shotDuration
          );
          previousAllocatedAssetId = asset.id;
          timelineCursor += shotDuration;
          continue;
        }

        const fallbackAssets = [
          ...visualAssets.filter((asset) => asset.id !== previousAllocatedAssetId),
          ...visualAssets.filter((asset) => asset.id === previousAllocatedAssetId)
        ];
        const asset = fallbackAssets[fallbackShotIndex % fallbackAssets.length];
        fallbackShotIndex += 1;
        const shotDuration = Math.min(
          remainingTimeline,
          asset.kind === "视频" ? MAX_FALLBACK_SHOT_SECONDS : MAX_IMAGE_SHOT_SECONDS
        );
        const duration = asset.duration ?? 0;
        const playbackRate = 1;
        const playableSpan = Math.max(0, duration - shotDuration * playbackRate - 0.05);
        const sourceStart = asset.kind === "视频" && playableSpan > 0
          ? ((fallbackShotIndex * 0.381966) % 1) * playableSpan
          : 0;

        allocated.push({
          ...segment,
          start: timelineCursor,
          end: timelineCursor + shotDuration,
          assetId: asset.id,
          sourceStart,
          sourceEnd: asset.kind === "视频" ? sourceStart + shotDuration : sourceStart,
          playbackRate,
          matchScore: 0,
          reason: "素材总时长不足。使用上传素材短镜头接力，避免长时间停帧"
        });
        previousAllocatedAssetId = asset.id;
        timelineCursor += shotDuration;
      }
    });

    return allocated;
  };

  const analyzeAndMatch = async (cues: TimelineCaption[], preparedAssets: Asset[], analysisOnly=false) => {
    const visualAssets = preparedAssets.filter((asset) => Boolean(asset.preview));
    if (!visualAssets.length) return [];
    setMatchingState("loading");
    setMatchingProgress(2);
    const insights = new Map<string, AssetVisualInsight>();
    let usedVisionModel = false;

    const cacheInsight = (
      asset: Asset,
      insight: AssetVisualInsight,
      analysisMethod: VideoSemanticAnalysisMethod,
    ) => {
      const assetDurationMs = Math.max(1, Math.round((asset.duration ?? 4) * 1_000));
      semanticAnalysisCacheRef.current.set(normalizeLocalClipAnalysis({
        assetId: asset.id,
        assetDurationMs,
        frames: insight.frames.map((frame) => ({
          sourceTimeMs: Math.min(assetDurationMs, Math.max(0, Math.round(frame.at * 1_000))),
          concepts: [...frame.scores.entries()].map(([concept, score]) => ({ concept, score })),
        })),
        analysisMethod,
        createdAt: new Date().toISOString(),
      }));
    };

    const addFallbackInsight = (asset: Asset, index: number) => {
      if(CLIP_TEST_ENABLED){asset.semanticTopic=undefined;asset.semanticScore=undefined;return;}
      const topic = topicForText(asset.name) ?? visualTopics[index % visualTopics.length];
      const scores = new Map<string, number>([[topic.title, 1]]);
      const insight = {
        frames: [{ at: asset.kind === "视频" ? (asset.duration ?? 0) * 0.3 : 0, scores }],
        scores
      };
      insights.set(asset.id, insight);
      cacheInsight(asset, insight, "filename-fallback");
      Object.assign(asset, createFilenameFallbackAssetSemantics(topic.title));
    };

    try {
      const detailedSampling = visualAssets.length <= 6;
      for (let index = 0; index < visualAssets.length; index += 1) {
        const asset = visualAssets[index];
        try {
          if (asset.kind === "视频" && asset.duration && asset.duration > 0 && asset.preview) {
            const assetDurationMs = Math.round(asset.duration * 1_000);
            const controller = new AbortController();
            videoAnalysisAbortRef.current.get(asset.id)?.abort();
            videoAnalysisAbortRef.current.set(asset.id, controller);
            let classifiedFrames = 0;
            try {
              const result = await analyzeVideoAssetTwoStage({
                assetId: asset.id,
                assetDurationMs,
                createdAt: new Date().toISOString(),
                detailedSampling,
                cache: semanticAnalysisCacheRef.current,
                signal: controller.signal,
                labelMap: new Map(visualTopics.map((topic) => [topic.label, topic.title])),
                captureFrames: (sourceTimeMs) => captureFrameSamplesAtTimes({
                  assetId: asset.id,
                  name: asset.name,
                  kind: "video",
                  sourceUrl: asset.preview ?? "",
                  assetDurationMs,
                }, sourceTimeMs),
                classifyFrame: async (sample) => {
                  const classification = await requestImageClassification(
                    sample.image,
                    visualTopics.map((topic) => topic.label),
                  );
                  classifiedFrames += 1;
                  const completed = (index + Math.min(
                    1,
                    classifiedFrames / MAX_TOTAL_CLASSIFIED_FRAMES_PER_ASSET,
                  ))
                    / Math.max(1, visualAssets.length);
                  setMatchingProgress(58 + Math.round(completed * 38));
                  return classification;
                },
              });
              const cachedInsight = visualInsightCacheRef.current.get(asset.id);
              const frames: FrameInsight[] = result.coarse
                ? result.coarse.observations.map((observation) => ({
                    at: observation.sourceTimeMs / 1_000,
                    scores: new Map(observation.concepts.map((concept) => [concept.label, concept.score])),
                  }))
                : cachedInsight?.frames ?? result.analysis.segments.flatMap((segment) =>
                    segment.evidenceFrameMs.map((sourceTimeMs) => ({
                      at: sourceTimeMs / 1_000,
                      scores: new Map(segment.visualEvidence ? (segment.visualEvidence.frames.find(f=>f.sourceTimeMs===sourceTimeMs)?.predictions??[]).flatMap(p=>{const topic=visualTopics.find(t=>t.label===p.label);return topic?[[topic.title,p.score] as const]:[];}) : segment.concepts.map((concept,index) => [concept,index===0?segment.confidence:0] as const)),
                    })));
              const aggregate = new Map<string, number>();
              frames.forEach((frame) => frame.scores.forEach((score, topic) => {
                aggregate.set(topic, Math.max(aggregate.get(topic) ?? 0, score));
              }));
              const topTopics = [...aggregate.entries()]
                .sort((left, right) => right[1] - left[1])
                .slice(0, 2);
              if (!topTopics.length) throw new Error("Local analysis returned no visual concepts.");
              const insight = { frames, scores: aggregate };
              insights.set(asset.id, insight);
              visualInsightCacheRef.current.set(asset.id, insight);
              asset.semanticTopic = CLIP_TEST_ENABLED ? topTopics[0][0] : topTopics.map(([title]) => title).join(" / ");
              asset.semanticScore = topTopics[0][1];
              usedVisionModel = true;
              continue;
            } finally {
              if (videoAnalysisAbortRef.current.get(asset.id) === controller) {
                videoAnalysisAbortRef.current.delete(asset.id);
              }
            }
          }

          const capturedFrames = await captureAssetFrames(asset, detailedSampling);
          const frames: FrameInsight[] = [];
          const aggregate = new Map<string, number>();
          for (let frameIndex = 0; frameIndex < capturedFrames.length; frameIndex += 1) {
            const captured = capturedFrames[frameIndex];
            const results = await requestImageClassification(
              captured.image,
              visualTopics.map((topic) => topic.label)
            );
            const scores = new Map<string, number>();
            results.forEach((result) => {
              const topic = visualTopics.find((item) => item.label === result.label);
              if (!topic) return;
              scores.set(topic.title, result.score);
              aggregate.set(
                topic.title,
                Math.max(aggregate.get(topic.title) ?? 0, result.score)
              );
            });
            frames.push({ at: captured.at, scores });
            const completed = (index + (frameIndex + 1) / capturedFrames.length)
              / Math.max(1, visualAssets.length);
            setMatchingProgress(58 + Math.round(completed * 38));
          }
          const topTopics = [...aggregate.entries()]
            .sort((left, right) => right[1] - left[1])
            .slice(0, 2);
          if (topTopics.length) {
            const insight = { frames, scores: aggregate };
            insights.set(asset.id, insight);
            cacheInsight(asset, insight, "local-clip");
            asset.semanticTopic = CLIP_TEST_ENABLED ? topTopics[0][0] : topTopics.map(([title]) => title).join(" / ");
            asset.semanticScore = topTopics[0][1];
            usedVisionModel = true;
          } else {
            addFallbackInsight(asset, index);
          }
        } catch {
          addFallbackInsight(asset, index);
        }
      }
    } catch {
      visualAssets.forEach((asset, index) => {
        if (!insights.has(asset.id)) addFallbackInsight(asset, index);
      });
    }

    const realAnalyses = collectCurrentVideoEvidence(semanticAnalysisCacheRef.current, preparedAssets.map((asset) => ({
      id: asset.id,
      durationMs: Math.max(1, Math.round((asset.duration ?? 4) * 1_000)),
    })));
    const realAssetIds = new Set(realAnalyses.map((analysis) => analysis.assetId));
    const trustedAssets = preparedAssets.filter((asset) => realAssetIds.has(asset.id));
    const trustedInsights = new Map([...insights].filter(([assetId]) => realAssetIds.has(assetId)));
    const hasVisualEvidence = usedVisionModel && trustedAssets.length > 0;
    const plan = hasVisualEvidence && !CLIP_TEST_ENABLED
      ? buildMatchPlan(cues, trustedAssets, trustedInsights)
      : sourceOrderPlan(preparedAssets, targetDuration);
    if(!analysisOnly)setAssets([...preparedAssets]);
    if(!analysisOnly)setMatchSegments(plan);
    setMatchingProgress(100);
    setMatchingState(hasVisualEvidence ? "ready" : "error");
    return plan;
  };

  const startJob = async (manualOnly=false) => {
    if (!canGenerate) {
      setNotice("请检查素材、音频模式及素材使用权");
      return;
    }
    setStartingJob(true);
    try {
      setPreviewPlaying(false);
      setPreviewElapsed(0);
      setPreviewAudioIndex(0);
      previewVideoRef.current?.pause();
      previewAudioRef.current?.pause();
      pauseSelectionPreview();
      clearRenderedVideo();
      const preparedAssets = assets;
      let cues = captionRecords;
      if (!manualOnly && audioMode === "external" && subtitleSource === "auto" && !cues.length && transcriptionState !== "error") {
        try {
          cues = await transcribeAudio();
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") throw error;
          // Recognition can be retried separately. The user can edit without subtitles.
        }
      }
      const sourceDuration = preparedAssets.reduce((total, asset) => total + (asset.duration ?? 0), 0);
      const projectDuration = audioMode === "external" ? targetDuration
        : Math.max(1, durationMode === "custom" ? Math.min(targetDuration, sourceDuration) : sourceDuration);
      const targetDurationMs = Math.round(projectDuration * 1000);
      const timelineCues = cues
        .filter((cue) => cue.startMs < targetDurationMs)
        .map((cue) => ({ ...cue, endMs: Math.min(targetDurationMs, cue.endMs) }))
        .filter((cue) => cue.endMs > cue.startMs);
      setNotice(audioMode === "external" ? "正在识别画面并匹配旁白" : "正在按素材顺序建立时间线");
      const plan = audioMode === "external" && !manualOnly
        ? await analyzeAndMatch(timelineCues, preparedAssets)
        : sourceOrderPlan(preparedAssets, projectDuration);
      if (!plan.length) throw new Error("没有可用于剪辑的素材");
      let nextProject = createEditorProject(
        plan,
        audioMode === "external" ? timelineCues.filter((cue) => !cue.videoClipId) : timelineCues,
        preparedAssets,
        audioSelection,
        projectDuration,
        ratio, fillMode === "居中留黑边" ? "contain" : "cover"
      );
      if (editorProject && audioMode !== "external") nextProject = remapVideoCaptions(editorProject, nextProject);
      setEditorAIUndoProject(null);
      setEditorProject(nextProject);
      syncCaptionRecordsFromProject(nextProject);
      setMatchSegments(projectToMatchSegments(nextProject));
      setProgress(4);
      setJobState(manualOnly ? "done" : "processing");
      if(manualOnly){setProgress(100);setFlowStage("finish");setEditorOpen(true);}
      setNotice(
        requirements
          ? `已按自定义需求创建 ${formatDuration(targetDuration)} 剪辑任务`
          : `已按音频时间轴创建 ${formatDuration(targetDuration)} 智能剪辑任务`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "智能剪辑准备失败";
      setJobState("idle");
      setProgress(0);
      setNotice(message);
    } finally {
      setStartingJob(false);
    }
  };

  const invalidateCreativeIntent = (nextRequirement: string, reason: string) => {
    setCreativeIntentSession((current) => invalidateCreativeIntentSessionV1(current, nextRequirement, reason));
    setActiveConstraintSet(null);
    setEditorProposal(null);
    setEditorProposalReview(null);
    setCollaborativeOptionSet(null);
    setSelectedCollaborativeOptionId(null);
    setOptionReviewById({});
    setProposalStaleMessage(reason);
  };

  const syncSecondaryAudioOwnership = (nextProject: EditorProject) => {
    const activeIds = new Set((nextProject.secondaryAudioClips ?? []).map((clip) => clip.id));
    const sources: Record<string, string> = {};
    for (const [clipId, runtime] of secondaryAudioRuntimeRef.current) {
      if (!activeIds.has(clipId)) {
        if (runtime.url) URL.revokeObjectURL(runtime.url);
        runtime.url = "";
        secondaryPreviewAudioRefs.current.get(clipId)?.pause();
        continue;
      }
      if (!runtime.url) runtime.url = URL.createObjectURL(runtime.file);
      sources[clipId] = runtime.url;
    }
    setSecondaryAudioSources(sources);
  };

  const importSecondaryAudio = async (
    clipId: string,
    file: File,
    _sourceType: SecondaryAudioSourceType,
  ) => {
    if (!file.size || (file.type && !file.type.startsWith("audio/"))) {
      throw new Error("请选择可解码且非空的音频文件。");
    }
    const url = URL.createObjectURL(file);
    const durationSeconds = await readMediaDuration(url, "audio");
    if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds < 0.05) {
      URL.revokeObjectURL(url);
      throw new Error("无法解码该音频，或音频时长无效。请使用浏览器支持的音频格式。");
    }
    const previous = secondaryAudioRuntimeRef.current.get(clipId);
    if (previous?.url) URL.revokeObjectURL(previous.url);
    secondaryAudioRuntimeRef.current.set(clipId, { file, url });
    setSecondaryAudioSources((current) => ({ ...current, [clipId]: url }));
    return { sourceUrl: url, sourceDurationMs: Math.round(durationSeconds * 1_000) };
  };

  useEffect(() => {
    if (editorProject) {
      syncSecondaryAudioOwnership(editorProject);
      return;
    }
    secondaryAudioRuntimeRef.current.forEach((runtime) => {
      if (runtime.url) URL.revokeObjectURL(runtime.url);
      runtime.url = "";
    });
    setSecondaryAudioSources({});
  }, [editorProject]);

  const handleEditorProjectChange = (nextProject: EditorProject) => {
    setEditorProject(nextProject);
    const canvasOnly = Boolean(editorProject && isCanvasOnlyChange(editorProject,nextProject));
    canvasChangeRef.current = canvasOnly;
    setRatio(nextProject.ratio);
    setBlockedExplanationResult(null);
    setSelectedProtectionClauseId(null);
    if (creativeIntentSession.intent && !canvasOnly) {
      invalidateCreativeIntent(requirements, "项目、媒体或时间线已变化，请重新分析并确认保护范围。");
    }
    setMatchSegments(projectToMatchSegments(nextProject));
    syncCaptionRecordsFromProject(nextProject);
    setSubtitleTimelineBasis("selection");
    if (Math.abs(nextProject.durationMs / 1000 - targetDuration) > 0.05) {
      setDurationMode("custom");
      setCustomDuration(nextProject.durationMs / 1000);
    }
    clearRenderedVideo();
    setJobState("done");
    setProgress(100);
  };

  const handleEditorPreviewTimeChange = (seconds: number, shouldPlay: boolean) => {
    const next = Math.min(Math.max(0, seconds), previewDuration);
    previewElapsedRef.current = next;
    setPreviewElapsed(next);
    setPreviewPlaying(shouldPlay);
    // TimelineEditor owns the visible video while open. Only synchronize the
    // single master audio element here to avoid decoding two videos at once.
    syncPreviewMedia(next, shouldPlay, false);
  };

  const generateCompleteVideo = async () => {
    if (renderState === "rendering") return;
    if (jobState !== "done") {
      setNotice("请先生成并确认剪辑预览");
      return;
    }
    if (!uploadedPreviewAssets.length) {
      setRenderState("error");
      setRenderError("没有可用于合成的真实视频或图片，请上传本地素材后重试。");
      return;
    }
    if (speechProtected && (audioMode === "silent" || (audioMode === "mix" && videoVolume === 0))) {
      setRenderState("error");
      setRenderError("当前工程锁定了讲话内容，请保留其音轨后再导出。");
      return;
    }
    const audioTracks = externalEnabled ? audios.filter((audio) => Boolean(audio.url)) : [];
    const exportDuration = (editorProject?.durationMs ?? Math.round(targetDuration * 1000)) / 1000;
    if ((audioMode === "external" || audioMode === "mix") && audioTracks.length && editorProject) {
      const visualEndMs = Math.max(0, ...projectToMatchSegments(editorProject).map((segment) => segment.end * 1_000));
      const emptyPictureTailMs = editorProject.durationMs - visualEndMs;
      if (emptyPictureTailMs > 50) {
        setRenderState("error");
        setRenderError(
          `当前画面在 ${formatTimeMs(visualEndMs)} 结束，所选${audioMode === "external" ? "独立音频" : "背景音乐"}仍需播放至 ${formatTimeMs(editorProject.durationMs)}；继续导出会出现 ${formatTimeMs(emptyPictureTailMs)} 的空画面尾段。音频未被裁剪。请缩短音频区间或补充/延长画面后重试。`,
        );
        return;
      }
    }
    if (originalEnabled && editorProject) {
      const exportPlan = projectToMatchSegments(editorProject);
      const hasUnsupportedSlowOriginalAudio = exportPlan.some((segment) => (
        segment.speedCurve?.some((point) => point.rate < 0.5 - 0.0001) ?? false
      ));
      if (hasUnsupportedSlowOriginalAudio) {
        setRenderState("error");
        setRenderError("原声变速导出当前仅验证 0.5×–4×。包含低于 0.5× 的速度区间时会安全拒绝导出；请调整速度，或在允许的保护约束下选择独立音频或静音模式。");
        return;
      }
    }
    if (audioMode === "external" && !audioTracks.length) {
      setRenderState("error");
      setRenderError("没有可用于合成的真实旁白文件，请上传本地音频后重试。");
      return;
    }
    if (captionTimelineHasOverlap(editorProject?.captions ?? subtitleCues)) {
      setRenderState("error");
      setRenderError("字幕存在重叠，原文和时码已保留，请在精剪中核对后导出。");
      return;
    }
    renderCancelRef.current = false;
    setPreviewPlaying(false);
    previewVideoRef.current?.pause();
    previewAudioRef.current?.pause();
    setRenderState("rendering");
    setRenderProgress(0);
    setRenderError("");
    if (renderedVideoUrl) URL.revokeObjectURL(renderedVideoUrl);
    setRenderedVideoUrl("");

    let outputSize;
    try { outputSize = outputCanvasSize(editorProject?.ratio ?? ratio); } catch(e) {setRenderState("error");setRenderError((e as Error).message);return;}
    const canvas = document.createElement("canvas");
    canvas.width = outputSize.width;
    canvas.height = outputSize.height;
    const context = canvas.getContext("2d", { alpha: false });

    if (!context) {
      setRenderState("error");
      setRenderError("无法创建视频画布，请刷新页面后重试。");
      return;
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    // The exact PTS exporter is the default for this isolated candidate. Its
    // errors are terminal for this export attempt; never fall back to the
    // known real-time MediaRecorder path with cut-point gaps.
    if (typeof window !== "undefined") {
      try {
        const plan = editorProject ? projectToMatchSegments(editorProject) : matchSegments;
        const protectedSpans = speechProtected && editorProject ? deriveProtectedTimelineAnnotationsV1({
          project: editorProject, intent: creativeIntentSession.intent,
          constraintSet: activeConstraintSet ?? undefined, confirmedBindings: creativeIntentSession.confirmedBindings,
        }).filter(span => span.isActiveHardConstraint && protectedSpeechClauses.includes(span.sourceClauseId)) : [];
        if (speechProtected && protectedSpeechClauses.some(id => !protectedSpans.some(span => span.sourceClauseId === id))) {
          throw new Error("无法确认受保护的讲话在成片中仍有对应音轨。请检查原声和保护范围。");
        }
        const secondary = buildSecondaryAudioMixPlan(audioMode === "silent" ? [] : editorProject?.secondaryAudioClips, Math.round(exportDuration * 1000)).map(entry => {
          const clip = editorProject?.secondaryAudioClips?.find(item => item.id === entry.clipId);
          const url = clip && (secondaryAudioSources[clip.id] ?? clip.sourceUrl);
          if (!url) throw new Error("辅助音频来源不可用，请重新关联。");
          return { url, start:entry.timelineStartSeconds, sourceStart:entry.sourceOffsetSeconds, duration:entry.durationSeconds,
            volume:entry.volume, fadeIn:entry.fadeInSeconds, fadeOut:entry.fadeOutSeconds };
        });
        const blob = await renderTimelineExport({
          canvas, segments:plan, assets:uploadedPreviewAssets, duration:exportDuration, mode:audioMode,
          videoVolume, musicVolume, externalUrls:audioTracks.map(audio => audio.url!), selection:audioSelection, secondary,
          protectedRanges:protectedSpans.map(span => ({start:span.timelineStart/1000,end:span.timelineEnd/1000,sourceAssetId:span.sourceAssetId})),
          extraFrameTimes:(editorProject?.captions ?? subtitleCues).flatMap(cue => [cue.startMs/1000,cue.endMs/1000]),
          sourceTime:(index,time) => matchSegmentSourceTime(plan[index],time),
          cancelled:() => renderCancelRef.current, progress:setRenderProgress,
          paint:(source,index,time) => {
            context.fillStyle = "#041c24";
            context.fillRect(0,0,canvas.width,canvas.height);
            if (source && index >= 0) {
              const transform = plan[index].transform ?? DEFAULT_TRANSFORM;
              const contain = transform.fit === "contain" || (transform.fit !== "cover" && fillMode === "居中留黑边");
              const base = contain ? Math.min(canvas.width/source.width,canvas.height/source.height) : Math.max(canvas.width/source.width,canvas.height/source.height);
              const scale = base*Math.max(.25,transform.scale)*(1+Math.max(0,transform.crop)/100);
              const width=source.width*scale,height=source.height*scale,offset=clipPositionScaleCanvasOffset(transform,canvas.width,canvas.height);
              source.draw(context,(canvas.width-width)/2+offset.x,(canvas.height-height)/2+offset.y,width,height);
            }
            context.save();context.fillStyle="rgba(5, 36, 44, 0.68)";context.fillRect(22,20,88,30);
            context.fillStyle="#ffffff";context.font="600 15px Microsoft YaHei, sans-serif";context.textAlign="center";context.fillText("健康科普",66,41);
            drawEditorOverlaysAt(context,editorProject?.overlays,time*1000,canvas.width,canvas.height);
            if (subtitle !== "不添加字幕") drawEditorCaptionAt(context,editorProject?.captions ?? subtitleCues,time*1000,canvas.width,canvas.height);
            context.restore();
          },
        });
        if (renderCancelRef.current) {setRenderState("idle");setRenderProgress(0);setNotice("完整视频生成已取消");return;}
        setRenderedVideoUrl(URL.createObjectURL(blob));setRenderedVideoSize(formatSize(blob.size));
        setRenderProgress(100);setRenderState("ready");setNotice("完整视频已生成，可播放或下载");
      } catch (error) {
        if (renderCancelRef.current) {setRenderState("idle");setRenderProgress(0);setNotice("完整视频生成已取消");return;}
        const message=error instanceof Error ? error.message : "完整视频生成失败";
        const safeMessage=`${message}\n精确导出未成功；为避免已知切点问题，本次没有回退到实时录制路径。`;
        setRenderError(safeMessage);setRenderState("error");setNotice(safeMessage);
      }
      return;
    }
    type VisualResource = {
      asset: Asset;
      element: HTMLImageElement | HTMLVideoElement;
      isVideo: boolean;
      audioGain?: GainNode;
    };

    const visualResources: VisualResource[] = [];
    const audioSources: AudioBufferSourceNode[] = [];
    let audioContext: AudioContext | null = null;
    let canvasStream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;

    try {
      for (const asset of uploadedPreviewAssets) {
        if (!asset.preview) continue;
        if (asset.kind === "视频") {
          const video = document.createElement("video");
          video.muted = true;
          video.loop = false;
          video.playsInline = true;
          video.preload = "auto";
          video.src = asset.preview;
          await new Promise<void>((resolve, reject) => {
            video.onloadeddata = () => resolve();
            video.onerror = () => reject(new Error(`无法读取视频素材：${asset.name}`));
            video.load();
          });
          visualResources.push({ asset, element: video, isVideo: true });
        } else {
          const image = new Image();
          image.src = asset.preview;
          await image.decode();
          visualResources.push({ asset, element: image, isVideo: false });
        }
      }

      if (!visualResources.length) {
        throw new Error("上传的素材无法被浏览器解码，请使用 MP4（H.264）或 JPG/PNG。");
      }

      const renderPlan = editorProject ? projectToMatchSegments(editorProject) : matchSegments;
      const trackPresence = new Map<string, boolean | undefined>();
      const videoHasAudio = (resource: VisualResource) => {
        if (!trackPresence.has(resource.asset.id)) {
          const video = resource.element as HTMLVideoElement & { captureStream?: () => MediaStream };
          const probe = video.captureStream?.();
          trackPresence.set(resource.asset.id, probe ? probe.getAudioTracks().length > 0 : undefined);
          probe?.getTracks().forEach((track) => track.stop());
        }
        return trackPresence.get(resource.asset.id);
      };
      let hasOriginalTrack = false;
      audioContext = new AudioContext({ sampleRate: 48000 });
      const audioDestination = audioContext.createMediaStreamDestination();
      if (originalEnabled) {
        for (const resource of visualResources) {
          if (!resource.isVideo || !renderPlan.some((segment) => segment.assetId === resource.asset.id)
            || videoHasAudio(resource) === false) continue;
          hasOriginalTrack = true;
          const video = resource.element as HTMLVideoElement;
          const source = audioContext.createMediaElementSource(video);
          const gain = audioContext.createGain();
          gain.gain.value = 0;
          source.connect(gain).connect(audioDestination);
          resource.audioGain = gain;
          // The graph is connected only to the recording stream, not speakers.
          video.muted = false;
        }
      }
      if (speechProtected && editorProject) {
        const protectedSpans = deriveProtectedTimelineAnnotationsV1({
          project: editorProject,
          intent: creativeIntentSession.intent,
          constraintSet: activeConstraintSet ?? undefined,
          confirmedBindings: creativeIntentSession.confirmedBindings,
        }).filter((span) => span.isActiveHardConstraint && protectedSpeechClauses.includes(span.sourceClauseId));
        const error = "无法确认受保护的讲话在成片中仍有对应音轨。请检查原声和保护范围。";
        if (protectedSpeechClauses.some((id) => !protectedSpans.some((span) => span.sourceClauseId === id))) {
          throw new Error(error);
        }
        for (const span of protectedSpans) {
          const start = span.timelineStart / 1000;
          const end = span.timelineEnd / 1000;
          if (end > exportDuration || end <= start) throw new Error(error);
          // A caption-only binding may refer to legacy independent narration.
          if (audioMode === "external" && !span.sourceAssetId) {
            if (end > selectedAudioDuration) throw new Error(error);
            continue;
          }
          const edges = [start, end, ...renderPlan.flatMap((segment) => [segment.start, segment.end])
            .filter((time) => time > start && time < end)].sort((a, b) => a - b);
          for (let index = 1; index < edges.length; index++) {
            const segment = matchSegmentAt(renderPlan, (edges[index - 1] + edges[index]) / 2);
            const resource = visualResources.find((item) => item.asset.id === segment?.assetId);
            if (!originalEnabled || !resource?.isVideo || (span.sourceAssetId && span.sourceAssetId !== resource.asset.id)) {
              throw new Error(error);
            }
            if (videoHasAudio(resource) !== true) throw new Error(error);
          }
        }
      }
      // Seek each source to its first use before recording. A later hard cut
      // between segments of the same file is handled by the render loop.
      await Promise.all(visualResources.filter((resource) => resource.isVideo).map(async (resource) => {
        const first = renderPlan.find((segment) => segment.assetId === resource.asset.id);
        if (!first) return;
        const video = resource.element as HTMLVideoElement;
        const start = first.sourceStart ?? 0;
        if (Math.abs(video.currentTime - start) > 0.001) {
          await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => reject(new Error(`无法定位视频素材：${resource.asset.name}`)), 5000);
            video.addEventListener("seeked", () => { window.clearTimeout(timeout); resolve(); }, { once: true });
            video.currentTime = start;
          });
        }
      }));
      const audioBuffers: AudioBuffer[] = [];

      for (const audio of audioTracks) {
        if (!audio.url) continue;
        const arrayBuffer = await fetch(audio.url).then((response) => response.arrayBuffer());
        audioBuffers.push(await audioContext.decodeAudioData(arrayBuffer.slice(0)));
      }
      const secondaryMixPlan = buildSecondaryAudioMixPlan(
        audioMode === "silent" ? [] : editorProject?.secondaryAudioClips,
        Math.round(exportDuration * 1_000),
      );
      const secondaryAudioBuffers = new Map<string, AudioBuffer>();
      for (const entry of secondaryMixPlan) {
        const clip = editorProject?.secondaryAudioClips?.find((item) => item.id === entry.clipId);
        if (!clip) continue;
        const sourceUrl = secondaryAudioSources[clip.id] ?? clip.sourceUrl;
        if (!sourceUrl) throw new Error(`辅助音频来源不可用：${clip.name}`);
        try {
          const response = await fetch(sourceUrl);
          if (!response.ok) throw new Error("fetch failed");
          secondaryAudioBuffers.set(
            clip.id,
            await audioContext.decodeAudioData((await response.arrayBuffer()).slice(0)),
          );
        } catch {
          throw new Error(`无法解码辅助音频：${clip.name}`);
        }
      }

      const includeAudio = hasOriginalTrack || audioBuffers.length > 0 || secondaryAudioBuffers.size > 0;
      const renderClock = audioContext;
      if (includeAudio) {
        await renderClock.resume();
        // The audio device can start substantially later than resume().
        // Let its clock and the output stream advance before recording.
        const warmupStart = renderClock.currentTime;
        const deadline = performance.now() + 3000;
        await new Promise<void>((resolve, reject) => {
          const ready = (now: number) => {
            if (renderClock.currentTime - warmupStart >= 0.15) resolve();
            else if (now >= deadline) reject(new Error("浏览器音频设备未能启动，请重试。"));
            else window.requestAnimationFrame(ready);
          };
          window.requestAnimationFrame(ready);
        });
      }
      canvasStream = canvas.captureStream(0);
      const canvasTrack = canvasStream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      const tracks = [
        ...canvasStream.getVideoTracks(),
        ...(includeAudio ? audioDestination.stream.getAudioTracks() : [])
      ];
      const outputStream = new MediaStream(tracks);
      const mimeType = [
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9,opus",
        "video/webm"
      ].find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
      recorder = new MediaRecorder(
        outputStream,
        mimeType
          ? { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 }
          : { videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 }
      );
      const chunks: BlobPart[] = [];
      const recordingFinished = new Promise<Blob>((resolve, reject) => {
        recorder!.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder!.onerror = () => reject(new Error("浏览器录制器发生错误"));
        recorder!.onstop = () => resolve(new Blob(chunks, { type: recorder!.mimeType || "video/webm" }));
      });

      // Attach a handler immediately: recorder errors can occur before the
      // render loop has finished.
      void recordingFinished.catch(() => undefined);
      let audioStartAt = 0;
      const scheduleAudio = () => {
        const selectedSourceStart = audioSelection.sourceInMs / 1000;
        const selectedSourceEnd = audioSelection.sourceOutMs / 1000;
        let audioSourceCursor = 0;
        for (const buffer of audioBuffers) {
          const bufferStart = audioSourceCursor;
          const bufferEnd = bufferStart + buffer.duration;
          const intersectionStart = Math.max(bufferStart, selectedSourceStart);
          const intersectionEnd = Math.min(bufferEnd, selectedSourceEnd);
          audioSourceCursor = bufferEnd;
          if (intersectionEnd <= intersectionStart) continue;
          const outputStart = intersectionStart - selectedSourceStart;
          if (outputStart >= exportDuration) break;
          const source = renderClock.createBufferSource();
          source.buffer = buffer;
          const gain = renderClock.createGain();
          gain.gain.value = audioMode === "mix" ? musicVolume : 1;
          source.connect(gain).connect(audioDestination);
          const playableDuration = Math.min(
            intersectionEnd - intersectionStart,
            exportDuration - outputStart
          );
          source.start(
            audioStartAt + outputStart,
            intersectionStart - bufferStart,
            playableDuration
          );
          audioSources.push(source);
        }

        for (const entry of secondaryMixPlan) {
          const clip = editorProject?.secondaryAudioClips?.find((item) => item.id === entry.clipId);
          if (!clip) continue;
          const buffer = secondaryAudioBuffers.get(clip.id);
          if (!buffer) throw new Error(`无法解码辅助音频：${clip.name}`);
          const playableDuration = Math.min(
            entry.durationSeconds,
            exportDuration - entry.timelineStartSeconds,
            buffer.duration - entry.sourceOffsetSeconds,
          );
          if (playableDuration <= 0) continue;
          const source = renderClock.createBufferSource();
          const gain = renderClock.createGain();
          source.buffer = buffer;
          source.connect(gain);
          gain.connect(audioDestination);
          const startsAt = audioStartAt + entry.timelineStartSeconds;
          const endsAt = startsAt + playableDuration;
          const fadeInSeconds = Math.min(entry.fadeInSeconds, playableDuration);
          const fadeOutSeconds = Math.min(entry.fadeOutSeconds, playableDuration - fadeInSeconds);
          gain.gain.cancelScheduledValues(startsAt);
          if (fadeInSeconds > 0) {
            gain.gain.setValueAtTime(0, startsAt);
            gain.gain.linearRampToValueAtTime(entry.volume, startsAt + fadeInSeconds);
          } else {
            gain.gain.setValueAtTime(entry.volume, startsAt);
          }
          if (fadeOutSeconds > 0) {
            gain.gain.setValueAtTime(entry.volume, endsAt - fadeOutSeconds);
            gain.gain.linearRampToValueAtTime(0, endsAt);
          }
          source.start(startsAt, entry.sourceOffsetSeconds, playableDuration);
          audioSources.push(source);
        }

      };
      let activeResource: VisualResource | undefined;
      let activeSegment: MatchSegment | undefined;
      let lastProgressUpdate = 0;
      let lastCanvasFrame = -Infinity;
      let lastRenderTick = performance.now();

      const drawFitted = (
        source: CanvasImageSource,
        sourceWidth: number,
        sourceHeight: number,
        transform: ClipTransform = DEFAULT_TRANSFORM
      ) => {
        const contain = transform.fit === "contain" || (
          transform.fit !== "cover" && fillMode === "居中留黑边"
        );
        const baseScale = contain
          ? Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight)
          : Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
        const scale = baseScale
          * Math.max(0.25, transform.scale)
          * (1 + Math.max(0, transform.crop) / 100);
        const width = sourceWidth * scale;
        const height = sourceHeight * scale;
        const positionOffset = clipPositionScaleCanvasOffset(transform, canvas.width, canvas.height);
        context.drawImage(
          source,
          (canvas.width - width) / 2 + positionOffset.x,
          (canvas.height - height) / 2 + positionOffset.y,
          width,
          height
        );
      };

      const drawOverlay = (elapsed: number) => {
        context.save();
        context.fillStyle = "rgba(5, 36, 44, 0.68)";
        context.fillRect(22, 20, 88, 30);
        context.fillStyle = "#ffffff";
        context.font = "600 15px Microsoft YaHei, sans-serif";
        context.textAlign = "center";
        context.fillText("健康科普", 66, 41);

        drawEditorOverlaysAt(
          context,
          editorProject?.overlays,
          elapsed * 1_000,
          canvas.width,
          canvas.height,
        );
        if (subtitle !== "不添加字幕") {
          drawEditorCaptionAt(context, editorProject?.captions ?? subtitleCues, elapsed * 1_000, canvas.width, canvas.height);
        }
        context.restore();
      };

      const paint = (elapsed: number, play: boolean) => {
        const segment = matchSegmentAt(renderPlan, elapsed);
        const transform = segment?.transform ?? DEFAULT_TRANSFORM;
        const resource = segment && visualResources.find((item) => item.asset.id === segment.assetId);
        if (activeResource !== resource && activeResource?.isVideo) {
          (activeResource.element as HTMLVideoElement).pause();
          if (activeResource.audioGain) activeResource.audioGain.gain.value = 0;
        }
        context.fillStyle = "#041c24";
        context.fillRect(0, 0, canvas.width, canvas.height);
        if (resource && segment) {
          if (resource.isVideo) {
            const video = resource.element as HTMLVideoElement;
            const sourceTime = matchSegmentSourceTime(segment, elapsed);
            const contiguous = activeResource === resource && activeSegment?.end === segment.start
              && Math.abs((activeSegment.sourceEnd ?? -1) - (segment.sourceStart ?? 0)) < 0.002;
            const drift = sourceTime - video.currentTime;
            if (activeSegment !== segment && !contiguous && Math.abs(drift) > 0.035) {
              video.currentTime = sourceTime;
            }
            const rate = matchSegmentRateAt(segment, elapsed);
            // Seeking during playback flushes the media decoder (and drops
            // speech). Correct small clock differences without seeking.
            const adjustedRate = Math.min(4, Math.max(0.25, rate + Math.max(-0.10, Math.min(0.10, drift * 0.6))));
            if (Math.abs(video.playbackRate - adjustedRate) > 0.015) video.playbackRate = adjustedRate;
            if (resource.audioGain) resource.audioGain.gain.value = play && !video.seeking ? videoVolume : 0;
            if (play && video.paused && !video.ended) {
              void video.play().catch((error) => {
                if (error instanceof DOMException && error.name === "AbortError") return;
                renderPlaybackError = new Error(`无法播放视频素材：${resource.asset.name}`);
              });
            }
            if (!video.seeking && video.readyState >= 2) {
              drawFitted(video, video.videoWidth, video.videoHeight, transform);
            }
          } else {
            const image = resource.element as HTMLImageElement;
            drawFitted(image, image.naturalWidth, image.naturalHeight, transform);
          }
        }
        activeResource = resource;
        activeSegment = segment;
        drawOverlay(elapsed);
      };
      let renderPlaybackError: Error | undefined;
      // Publish a decoded first frame before starting the shared audio clock.
      paint(0, false);
      recorder.start(1000);
      lastRenderTick = performance.now();
      canvasTrack.requestFrame();
      const wallStart = performance.now() + 35;
      audioStartAt = renderClock.currentTime + 0.035;
      scheduleAudio();
      await new Promise<void>((resolve, reject) => {
        const drawFrame = (now: number) => {
          if (renderPlaybackError) { reject(renderPlaybackError); return; }
          if (!recorder || recorder.state === "inactive") { reject(new Error("浏览器提前结束了录制。")); return; }
          const wallElapsed = (now - wallStart) / 1000;
          const elapsed = includeAudio ? renderClock.currentTime - audioStartAt : wallElapsed;
          if (!renderCancelRef.current && (now - lastRenderTick > 250 || document.hidden
            || (includeAudio && Math.abs(elapsed - wallElapsed) > 0.16))) {
            reject(new Error("浏览器未能连续合成，请保持此页面在前台并重试。"));
            return;
          }
          lastRenderTick = now;
          if (renderCancelRef.current || elapsed >= exportDuration) {
            recorder?.stop();
            resolve();
            return;
          }
          if (elapsed >= 0 && now - lastCanvasFrame >= 30) {
            paint(elapsed, true);
            canvasTrack.requestFrame();
            lastCanvasFrame = now;
          }
          if (elapsed >= 0 && now - lastProgressUpdate > 300) {
            lastProgressUpdate = now;
            setRenderProgress(Math.min(99, Math.round(elapsed / exportDuration * 100)));
          }
          window.requestAnimationFrame(drawFrame);
        };
        window.requestAnimationFrame(drawFrame);
      });

      const outputBlob = await recordingFinished;
      if (renderCancelRef.current) {
        setRenderState("idle");
        setRenderProgress(0);
        setNotice("完整视频生成已取消");
        return;
      }

      const outputUrl = URL.createObjectURL(outputBlob);
      setRenderedVideoUrl(outputUrl);
      setRenderedVideoSize(formatSize(outputBlob.size));
      setRenderProgress(100);
      setRenderState("ready");
      setNotice("完整视频已生成，可播放或下载");
    } catch (error) {
      const message = error instanceof Error ? error.message : "完整视频生成失败";
      setRenderError(message);
      setRenderState("error");
      setNotice(message);
      if (recorder?.state === "recording") recorder.stop();
    } finally {
      for (const source of audioSources) {
        try {
          source.stop();
        } catch {
          // The source may already have stopped naturally.
        }
      }
      for (const resource of visualResources) {
        if (resource.isVideo) (resource.element as HTMLVideoElement).pause();
      }
      canvasStream?.getTracks().forEach((track) => track.stop());
      if (audioContext && audioContext.state !== "closed") await audioContext.close();
    }
  };

  const confirmCreativeIntentGrounding = (sourceClauseId: string, selection: GroundingSelectionV1) => {
    if (!editorProject) return;
    try {
      const next = confirmCreativeIntentGroundingV1({
        session: creativeIntentSession,
        project: editorProject,
        sourceClauseId,
        selection,
        videoSemanticAnalyses: currentVideoSemanticEvidence(editorProject),
      });
      setCreativeIntentSession(next);
      setActiveConstraintSet(next.constraintSet);
      setCollaborativeOptionSet(null);
      setSelectedCollaborativeOptionId(null);
      setOptionReviewById({});
      setProposalStaleMessage(null);
      setNotice(next.status === "GROUNDING_REQUIRED" ? "已确认一项保护范围，请继续确认" : "保护约束已激活并完成可行性检查");
    } catch (error) {
      setEditorAITaskError(error instanceof Error ? error.message : "无法确认保护范围。");
    }
  };

  const selectConstraintResolution = (choice: ConstraintResolutionChoice) => {
    if (!editorProject) return;
    try {
      const next = resolveCreativeIntentConflictV1({
        session: creativeIntentSession,
        project: editorProject,
        choice,
        createdAt: new Date().toISOString(),
        videoSemanticAnalyses: currentVideoSemanticEvidence(editorProject),
      });
      emitEditorNegotiationStateDiagnosticV1(next);
      setCreativeIntentSession(next);
      setActiveConstraintSet(next.constraintSet);
      setCollaborativeOptionSet(null);
      setSelectedCollaborativeOptionId(null);
      setOptionReviewById({});
      if (choice === "EDIT_REQUIREMENTS_MANUALLY") {
        setRequirementDraft(next.sourceRequest);
        setRequirementDialogOpen(true);
        setNotice("规划已暂停；请手动修改要求。已确认保护不会自动删除。");
      } else {
        setNotice(choice === "RELAX_TARGET_DURATION" ? "已放宽目标时长并重新检查可行性" : "已选择仅优化非保护内容；剩余差距仍会保留显示");
      }
    } catch (error) {
      setProposalReviewError(error instanceof Error ? error.message : "无法保存约束决策。");
    }
  };

  const generateProductionProposal = () => {
    if (!editorProject) {
      setProposalError({ status: "MISSING_INTERVALS", message: "请先生成剪辑预览，建立可信时间线后再生成建议。" });
      return;
    }
    if (creativeIntentSession.status !== "READY_TO_PLAN"
      || !creativeIntentSession.constraintSet
      || !creativeIntentSession.proposalContext
      || !creativeIntentSession.feasibilityReport) {
      setProposalError({ status: "NEGOTIATION_NOT_READY", message: "请先完成创作意图分析、保护范围确认和约束决策。" });
      return;
    }
    setProposalBusy(true);
    setProposalError(null);
    setProposalReviewError(null);
    setProposalStaleMessage(null);
    setEditorRepairProposal(null);
    setEditorRepairReview(null);
    setEditorRepairResult(null);
    try {
      const videoAnalyses = currentVideoSemanticEvidence(editorProject);
      if (ACCEPTANCE_INPUT_HYDRATION_BUILD_ENABLED) {
        emitEditorAcceptanceDiagnosticV1(Object.freeze({
          schemaVersion: 1,
          kind: "ACCEPTANCE_INPUT_AVAILABLE",
          stage: "ACCEPTANCE_INPUT_CONSUMPTION",
          fixtureVersion: 1,
          semanticAssetCount: videoAnalyses.length,
          rhythmEvidencePresent: audioRhythmAnalysisRef.current !== null,
          category: "PLANNER_READ",
        }));
      }
      const result = generateCollaborativeEditingOptionsV1({
        planGenerationMode,
        requestedOptionCount: planGenerationMode === "MULTI_OPTION" ? 3 : 1,
        providerGenerationBudget: 0,
        feasibilityReport: creativeIntentSession.feasibilityReport,
        proposalInput: {
          project: editorProject,
          videoAnalyses,
          captionConcepts: deriveEditorCaptionConceptsV1(editorProject.captions),
          ...(audioRhythmAnalysisRef.current ? { rhythm: audioRhythmAnalysisRef.current } : {}),
          constraintSet: creativeIntentSession.constraintSet,
          constraintContext: creativeIntentSession.proposalContext,
          ...(creativeIntentSession.ledger ? { sessionDecisionLedger: creativeIntentSession.ledger } : {}),
        },
      });
      if (!result.ok) {
        emitEditorProposalStageDiagnosticV1("RESULT_MAPPING", "FAILED", result.status);
        setEditorProposal(null);
        setEditorProposalReview(null);
        setCollaborativeOptionSet(null);
        setSelectedCollaborativeOptionId(null);
        setOptionReviewById({});
        setProposalError({
          status: result.status === "NEGOTIATION_NOT_READY" ? "NEGOTIATION_NOT_READY" : "COMPILATION_REJECTED",
          message: result.message,
        });
        return;
      }
      setOptionReviewById({});
      if (planGenerationMode === "MULTI_OPTION") {
        setCollaborativeOptionSet(result.optionSet);
        setSelectedCollaborativeOptionId(null);
        setEditorProposal(null);
        setEditorProposalReview(null);
      } else {
        const proposal = result.optionSet.options[0].proposalBundle;
        setCollaborativeOptionSet(null);
        setSelectedCollaborativeOptionId(null);
        setEditorProposal(proposal);
        if (proposal.constraintSet) setActiveConstraintSet(proposal.constraintSet);
        setEditorProposalReview(createHumanReviewState(proposal));
      }
      setReviewedPlanEvidence(null);
      setReviewedEvidenceProposal(null);
      setEditorEvaluation(null);
      setEditorRepairProposal(null);
      setEditorRepairReview(null);
      setEditorRepairResult(null);
      const safeNoChange = result.optionSet.options[0].proposalBundle.safeNoChangeOutcome;
      emitEditorProposalStageDiagnosticV1(
        "RESULT_MAPPING",
        safeNoChange ? "SAFE_NO_CHANGE" : "READY_FOR_REVIEW",
      );
      setNotice(planGenerationMode === "MULTI_OPTION"
        ? `已生成 ${result.optionSet.generatedOptionCount} 个本地安全方案，请先选择一个方案再开始人工审核。`
        : safeNoChange
          ? `当前没有可安全执行的进一步修改。在保留已确认保护内容的情况下，最短仍为 ${Math.round(safeNoChange.minimumFeasibleDurationMs / 1_000)} 秒，与目标相差 ${Math.round(safeNoChange.remainingGapMs / 1_000)} 秒。`
          : `已生成 ${result.optionSet.options[0].proposalBundle.proposalEntries.length} 条本地 AI 剪辑建议，等待人工审核。`);
    } finally {
      setProposalBusy(false);
    }
  };

  const currentVideoSemanticEvidence = (project: EditorProject) =>
    collectCurrentVideoEvidence(semanticAnalysisCacheRef.current, project.assets);

  const generateLocalVisualProposal = async () => {
    if(!CLIP_TEST_ENABLED||!editorProject)return;
    if(activeConstraintSet && (creativeIntentSession.status!=="READY_TO_PLAN"||!creativeIntentSession.proposalContext)){
      setProposalError({status:"NEGOTIATION_NOT_READY",message:"已有保护约束尚未确认，不能生成视觉候选。"});return;
    }
    setProposalBusy(true);setProposalError(null);
    try{
      await analyzeAndMatch(editorProject.captions,assets,true);
      const selected=visualCaptionId || editorProject.captions[0]?.id;
      const result=generateEditorProposal({project:editorProject,videoAnalyses:currentVideoSemanticEvidence(editorProject),
        captionConcepts:deriveEditorCaptionConceptsV1(editorProject.captions),captionScopeIds:selected?[selected]:[],
        ...(activeConstraintSet&&creativeIntentSession.proposalContext?{constraintSet:activeConstraintSet,constraintContext:creativeIntentSession.proposalContext}:{}),
        ...(creativeIntentSession.ledger?{sessionDecisionLedger:creativeIntentSession.ledger}:{})});
      if(!result.ok){setEditorProposal(null);setEditorProposalReview(null);setProposalError(result);return;}
      setCollaborativeOptionSet(null);setEditorProposal(result.bundle);setEditorProposalReview(createHumanReviewState(result.bundle));
      setReviewedPlanEvidence(null);setReviewedEvidenceProposal(null);setProposalStaleMessage(null);
    }catch(error){setProposalError({status:"MISSING_VIDEO_EVIDENCE",message:error instanceof Error?error.message:String(error)});}
    finally{setProposalBusy(false);}
  };



  const referenceUrlOwner = () => {
    referenceObjectUrlOwnerRef.current ??= new ReferenceObjectUrlOwner((url) => URL.revokeObjectURL(url));
    return referenceObjectUrlOwnerRef.current;
  };

  const clearReferenceVideo = () => {
    referenceAnalysisTokenRef.current += 1;
    referenceObjectUrlOwnerRef.current?.clear();
    setReferenceVideoName("");
    setReferenceStyleBusy(false);
    setReferenceStyleAnalysis(null);
    setReferenceStylePlan(null);
    setReferenceStyleExecutionSummary(null);
    setEditorProposal((current) => current?.proposalId.startsWith("reference-style-proposal-v1-") ? null : current);
    setEditorProposalReview((current) => editorProposal?.proposalId.startsWith("reference-style-proposal-v1-") ? null : current);
  };

  const handleReferenceVideoFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const classification = classifyReferenceVideoInput(file);
    if (!classification.eligible) {
      referenceAnalysisTokenRef.current += 1;
      referenceObjectUrlOwnerRef.current?.clear();
      setReferenceVideoName(file.name);
      setReferenceStyleBusy(false);
      setReferenceStyleAnalysis({ status: "NOT_EVALUABLE", reason: "ANALYSIS_FAILED", message: classification.reason ?? "参考视频不可用。" });
      setReferenceStylePlan(null);
      return;
    }
    const token = referenceAnalysisTokenRef.current + 1;
    referenceAnalysisTokenRef.current = token;
    const sourceUrl = URL.createObjectURL(file);
    referenceUrlOwner().replace(sourceUrl);
    setReferenceVideoName(file.name);
    setReferenceStyleBusy(true);
    setReferenceStyleAnalysis(null);
    setReferenceStylePlan(null);
    setReferenceStyleExecutionSummary(null);
    setEditorProposal((current) => current?.proposalId.startsWith("reference-style-proposal-v1-") ? null : current);
    setEditorProposalReview((current) => editorProposal?.proposalId.startsWith("reference-style-proposal-v1-") ? null : current);
    const result = await analyzeReferenceVideoFile({ file, sourceUrl });
    if (referenceAnalysisTokenRef.current !== token || referenceObjectUrlOwnerRef.current?.current !== sourceUrl) return;
    setReferenceStyleAnalysis(result);
    setReferenceStyleBusy(false);
  };

  const generateReferenceStyleProposal = () => {
    if (!editorProject || referenceStyleAnalysis?.status !== "READY") return;
    if (activeConstraintSet && (
      creativeIntentSession.proposalContext?.readiness !== "READY_TO_PLAN"
      || creativeIntentSession.proposalContext.sourceConstraintSetId !== activeConstraintSet.constraintSetId
      || creativeIntentSession.proposalContext.sourceConstraintFingerprint !== activeConstraintSet.constraintFingerprint
    )) {
      setProposalReviewError("保护约束上下文已过期或尚未就绪；请先完成现有约束流程，再生成参考风格建议。");
      return;
    }
    const inputs = buildReferenceStylePlanningInputs(
      editorProject,
      currentVideoSemanticEvidence(editorProject),
      activeConstraintSet ?? undefined,
    );
    const result = planReferenceStyleTransfer({
      profile: referenceStyleAnalysis.profile,
      targetDurationMs: editorProject.durationMs,
      targetClips: inputs.targetClips,
      candidateScenes: inputs.candidateScenes,
      protectedRanges: inputs.protectedRanges,
      referenceId: referenceStyleAnalysis.evidence.id,
    });
    setReferenceStylePlan(result);
    setReferenceStyleExecutionSummary(null);
    setReviewedPlanEvidence(null);
    setReviewedEvidenceProposal(null);
    setEditorEvaluation(null);
    setEditorRepairProposal(null);
    setEditorRepairReview(null);
    setProposalReviewError(null);
    if (result.status === "READY_FOR_REVIEW") {
      const reviewBundle = buildReferenceStyleReviewBundle({
        proposal: result.proposal,
        profile: referenceStyleAnalysis.profile,
        project: editorProject,
        scenes: inputs.candidateScenes,
        ...(activeConstraintSet ? { constraintSet: activeConstraintSet } : {}),
        ...(creativeIntentSession.proposalContext?.readiness === "READY_TO_PLAN"
          && (!activeConstraintSet || (creativeIntentSession.proposalContext.sourceConstraintSetId === activeConstraintSet.constraintSetId
            && creativeIntentSession.proposalContext.sourceConstraintFingerprint === activeConstraintSet.constraintFingerprint))
          ? { constraintContext: creativeIntentSession.proposalContext } : {}),
      });
      setEditorProposal(reviewBundle);
      setEditorProposalReview(createHumanReviewState(reviewBundle));
    } else {
      setEditorProposal(null);
      setEditorProposalReview(null);
    }
    setNotice(result.status === "READY_FOR_REVIEW"
      ? "参考风格建议已进入人工审核；逐项确认后才会执行。"
      : `参考风格暂不可评估：${result.message}`);
  };

  const analyzeMusicVideoLinkage = () => {
    if (!editorProject || musicVideoBusy) return;
    setMusicVideoBusy(true);
    setMusicVideoResult(null);
    setEditorProposal(null);
    setEditorProposalReview(null);
    setReviewedPlanEvidence(null);
    setReviewedEvidenceProposal(null);
    setEditorEvaluation(null);
    setProposalReviewError(null);
    try {
      const selectedAudio = audios[selectionAudioIndex] ?? audios[0];
      const durationMs = editorProject.audioSelection.selectedDurationMs;
      if (!selectedAudio || !durationMs) {
        setNotice("音乐与视频联动暂不可评估：请先在编辑器选择有效音频。");
        return;
      }
      const sessionCaptions = editorProject.captions
        .filter((caption) => caption.endMs > 0 && caption.startMs < durationMs)
        .map((caption) => ({
          id: caption.id,
          text: caption.text,
          semanticTags: topicsForText(caption.text).map(({ topic }) => topic.title),
          startMs: Math.max(0, caption.startMs),
          endMs: Math.min(durationMs, caption.endMs),
        }))
        .filter((line) => line.endMs > line.startMs);
      const pastedLines = musicVideoLyricsDraft.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const usingSessionEvidence = pastedLines.length === 0 && sessionCaptions.length > 0;
      const lyricLines = usingSessionEvidence
        ? sessionCaptions
        : pastedLines.map((text, index) => ({
            id: `user-lyric-${index + 1}`,
            text,
            semanticTags: topicsForText(text).map(({ topic }) => topic.title),
          }));
      const rhythm = audioRhythmAnalysisRef.current;
      const rhythmMatchesDuration = rhythm?.sourceDurationMs === durationMs;
      const sourceId = rhythmMatchesDuration ? rhythm.sourceId : selectedAudio.id;
      const musicSegments = segmentMusicForVideoLinkage({
        sourceId,
        durationMs,
        lyrics: lyricLines,
        ...(usingSessionEvidence ? { lyricTimingProvenance: "SESSION_EVIDENCE" as const } : pastedLines.length ? { lyricTimingProvenance: "USER_LYRICS_DISTRIBUTED" as const } : {}),
        ...(rhythmMatchesDuration ? { rhythm } : {}),
      });
      const videoAssetIds = new Set(editorProject.assets.filter((asset) => asset.kind === "视频").map((asset) => asset.id));
      const analyses = currentVideoSemanticEvidence(editorProject)
        .filter((analysis) => videoAssetIds.has(analysis.assetId))
        .filter((analysis) => analysis.analysisMethod !== "filename-fallback"
          || Boolean(topicForText(editorProject.assets.find((asset) => asset.id === analysis.assetId)?.name ?? "")));
      const videoScenes = normalizeVideoSceneIndex({ analyses });
      const context = creativeIntentSession.proposalContext;
      const result = buildMusicVideoTimelineProposal({
        project: editorProject,
        musicSegments,
        videoScenes,
        ...(activeConstraintSet ? { constraintSet: activeConstraintSet } : {}),
        ...(context ? { constraintContext: context } : {}),
        ...(creativeIntentSession.ledger ? { sessionDecisionLedger: creativeIntentSession.ledger } : {}),
      });
      setMusicVideoResult(result);
      if (result.status === "READY_FOR_REVIEW") {
        setEditorProposal(result.proposal);
        setEditorProposalReview(createHumanReviewState(result.proposal));
        if (result.proposal.constraintSet) setActiveConstraintSet(result.proposal.constraintSet);
        setNotice("联动建议已生成，请逐条审核；全部审核完成前不会执行。");
      } else {
        setEditorProposal(null);
        setEditorProposalReview(null);
        setNotice(result.reasons.map((reason) => ({
          NO_MUSIC_SEGMENTS: "缺少歌词或可用音乐分段",
          NO_VIDEO_SCENES: "没有可用的视频语义证据",
          NO_SEMANTIC_EVIDENCE: "没有可用的语义匹配证据",
          NO_DURATION_COMPATIBLE_SCENE: "没有合适时长素材",
          HARD_CONSTRAINT_CONFLICT: "候选素材受到保护约束限制",
          NO_TIMELINE_SLOT: "没有可供匹配的时间线位置",
          SOURCE_RANGE_UNSUPPORTED: "素材片段位置暂不支持",
          STALE_CONSTRAINT_CONTEXT: "保护约束上下文已过期",
          ALL_CANDIDATES_REJECTED: "没有通过匹配要求的候选素材",
          COMPILATION_REJECTED: "建议未通过规范动作校验",
        }[reason] ?? "证据不足")).join("；"));
      }
    } catch (error) {
      setMusicVideoResult(null);
      setNotice(error instanceof Error ? error.message : "音乐与视频联动分析失败。");
    } finally {
      setMusicVideoBusy(false);
    }
  };

  const changePlanGenerationMode = (mode: PlanGenerationModeV1) => {
    if (mode === planGenerationMode) return;
    setPlanGenerationMode(mode);
    setCollaborativeOptionSet(null);
    setSelectedCollaborativeOptionId(null);
    setOptionReviewById({});
    setEditorProposal(null);
    setEditorProposalReview(null);
    setProposalError(null);
    setProposalReviewError(null);
    setProposalStaleMessage(null);
    setNotice(mode === "MULTI_OPTION"
      ? "已开启多方案模式；仅在点击生成后创建最多 3 个本地安全方案。"
      : "已切换为单方案模式；未执行的多方案已失效，项目未发生修改。");
  };

  const selectCollaborativeOption = (optionId: string) => {
    if (!collaborativeOptionSet || !editorProject || !creativeIntentSession.proposalContext || !creativeIntentSession.feasibilityReport) return;
    try {
      if (!isCollaborativeEditingOptionsCurrentV1(collaborativeOptionSet, {
        project: editorProject,
        constraintContext: creativeIntentSession.proposalContext,
        feasibilityReport: creativeIntentSession.feasibilityReport,
      })) throw new Error("剪辑方案已失效，请基于当前意图和约束重新生成。");
      const selection = selectCollaborativeEditingOptionV1(collaborativeOptionSet, optionId, optionReviewById);
      setSelectedCollaborativeOptionId(selection.selectedOptionId);
      setEditorProposal(selection.proposal);
      setEditorProposalReview(selection.review);
      if (selection.proposal.constraintSet) setActiveConstraintSet(selection.proposal.constraintSet);
      setProposalReviewError(null);
      setNotice("已选择剪辑方案。选择不等于批准，请继续逐项完成人工审核。");
    } catch (error) {
      setProposalReviewError(error instanceof Error ? error.message : "无法选择当前剪辑方案。");
    }
  };

  const handleProposalReviewDecision = (decision: HumanReviewDecision) => {
    if (!editorProposal || !editorProposalReview) return;
    setProposalReviewError(null);
    try {
      const nextReview = reviewProposalEntry(
        editorProposal,
        editorProposalReview,
        decision,
        editorProposal.proposalId.startsWith("reference-style-proposal-v1-")
          ? editorProject ?? editorProposal.trustedPreExecutionProject
          : editorProposal.trustedPreExecutionProject,
      );
      setEditorProposalReview(nextReview);
      if (selectedCollaborativeOptionId) {
        setOptionReviewById((current) => ({ ...current, [selectedCollaborativeOptionId]: nextReview }));
      }
    } catch (error) {
      setProposalReviewError(error instanceof Error ? error.message : "无法保存本次审核决定。");
    }
  };

  const executeApprovedProposal = () => {
    if (!editorProject || !editorProposal || !editorProposalReview) return;
    setProposalExecutionBusy(true);
    setProposalReviewError(null);
    try {
      const isReferenceStyle = editorProposal.proposalId.startsWith("reference-style-proposal-v1-");
      if (!isReferenceStyle && planGenerationMode === "MULTI_OPTION") {
        if (!collaborativeOptionSet || !creativeIntentSession.proposalContext || !creativeIntentSession.feasibilityReport) {
          throw new Error("多方案上下文已失效，请重新生成并选择剪辑方案。");
        }
        assertCollaborativeOptionExecutableV1({
          optionSet: collaborativeOptionSet,
          selectedOptionId: selectedCollaborativeOptionId,
          proposal: editorProposal,
          review: editorProposalReview,
          currentProject: editorProject,
          currentConstraintContext: creativeIntentSession.proposalContext,
          currentFeasibilityReport: creativeIntentSession.feasibilityReport,
        });
      }
      const result = executeReviewedProposal({
        proposal: editorProposal,
        review: editorProposalReview,
        currentProject: editorProject,
        executionUpdatedAt: new Date().toISOString(),
      });
      if (result.sessionDecisionLedger) {
        setCreativeIntentSession((current) => Object.freeze({ ...current, ledger: result.sessionDecisionLedger ?? current.ledger }));
      }
      setReviewedPlanEvidence(result.planEvidence);
      setReviewedEvidenceProposal(editorProposal);
      if (isReferenceStyle) {
        setEditorEvaluation(null);
        setEditorRepairProposal(null);
        setEditorRepairReview(null);
        setEditorRepairResult(null);
        if (result.execution && referenceStyleAnalysis?.status === "READY") {
          const preDurations = editorProject.tracks.flatMap((track) => track.clips).sort((a, b) => a.timelineStartMs - b.timelineStartMs).map((clip) => clip.timelineEndMs - clip.timelineStartMs);
          const postProject = result.execution.postProject;
          const postDurations = postProject.tracks.flatMap((track) => track.clips).sort((a, b) => a.timelineStartMs - b.timelineStartMs).map((clip) => clip.timelineEndMs - clip.timelineStartMs);
          setReferenceStyleExecutionSummary({
            executed: result.execution.appliedActionCount,
            rejected: result.reviewState.entries.filter((entry) => entry.status === "REJECTED").length,
            protectedSkipped: referenceStylePlan?.status === "READY_FOR_REVIEW" ? referenceStylePlan.proposal.items.filter((item) => item.protected).length : 0,
            preFit: evaluateReferenceStyleFit(referenceStyleAnalysis.profile, preDurations, editorProject.durationMs).score,
            postFit: evaluateReferenceStyleFit(referenceStyleAnalysis.profile, postDurations, postProject.durationMs).score,
          });
        }
      } else try {
        const authoritativePostProject = result.execution?.postProject ?? editorProject;
        const videoSemanticEvidence = currentVideoSemanticEvidence(editorProject);
        const evaluation = evaluateEditorExecution({
          proposalBundle: editorProposal,
          humanReviewState: result.reviewState,
          reviewedPlan: result.reviewedPlan,
          ...(result.execution ? { executionResult: result.execution } : {}),
          postProject: authoritativePostProject,
          planEvidence: result.planEvidence,
          videoSemanticEvidence,
          ...(audioRhythmAnalysisRef.current ? { audioRhythmEvidence: audioRhythmAnalysisRef.current } : {}),
          ...(creativeIntentSession.resolution?.structuredPolicy.policy === "CLOSEST_SAFELY_ACHIEVABLE"
            ? { resolvedDurationPolicy: creativeIntentSession.resolution.structuredPolicy }
            : {}),
        });
        setEditorEvaluation(evaluation);
        if (evaluation.defects.length) {
          const repairProposal = createRepairProposalBundle({
            evaluation,
            proposal: editorProposal,
            humanReview: result.reviewState,
            reviewedPlan: result.reviewedPlan,
            ...(result.execution ? { execution: result.execution } : {}),
            planEvidence: result.planEvidence,
            currentProject: authoritativePostProject,
            videoSemanticEvidence,
            ...(audioRhythmAnalysisRef.current ? { audioRhythmEvidence: audioRhythmAnalysisRef.current } : {}),
            ...(result.sessionDecisionLedger ? { sessionDecisionLedger: result.sessionDecisionLedger } : {}),
          });
          setEditorRepairProposal(repairProposal);
          setEditorRepairReview(createRepairReviewState(repairProposal));
        } else {
          setEditorRepairProposal(null);
          setEditorRepairReview(null);
        }
        setEditorRepairResult(null);
      } catch (evaluationError) {
        setEditorEvaluation(null);
        setEditorRepairProposal(null);
        setEditorRepairReview(null);
        setEditorRepairResult(null);
        setProposalReviewError(evaluationError instanceof Error ? evaluationError.message : "无法评估本次执行结果。");
      }
      setEditorProposal(null);
      setEditorProposalReview(null);
      setCollaborativeOptionSet(null);
      setSelectedCollaborativeOptionId(null);
      setOptionReviewById({});
      setProposalStaleMessage(null);
      if (result.status === "REVIEWED_NO_ACTIONS") {
        if (editorProposal.status === "SAFE_NO_CHANGE") {
          emitZeroActionReviewResultDiagnosticV1({
            proposal: editorProposal,
            result,
            historyRecordCommitted: false,
          });
        }
        setNotice(editorProposal.safeNoChangeOutcome
          ? "已确认保持当前结果；项目未修改，也未创建执行历史。"
          : "审核已完成：全部建议均已拒绝，项目未发生变化");
        return;
      }
      if (result.status === "EXECUTION_FAILED" || !result.execution) {
        setNotice("已批准修改执行失败，项目已保持执行前状态");
        return;
      }
      if (result.history.shouldRecord && result.history.undoProject && result.history.redoProject) {
        setEditorAIUndoProject(cloneProject(result.history.undoProject));
        handleEditorProjectChange(cloneProject(result.history.redoProject));
        setNotice(`已执行 ${result.execution.appliedActionCount} 条批准修改；可作为一次操作撤销`);
      } else {
        setNotice("已完成审核执行，项目内容无需改变，未创建撤销记录");
      }
    } catch (error) {
      if (error instanceof ProposalReviewError && error.code === "STALE_PROPOSAL") {
        setProposalStaleMessage("当前项目已发生变化，请重新生成剪辑建议");
      }
      setProposalReviewError(error instanceof Error ? error.message : "无法执行已批准修改。");
    } finally {
      setProposalExecutionBusy(false);
    }
  };

  const handleRepairReviewDecision = (decision: RepairReviewDecision) => {
    if (!editorRepairProposal || !editorRepairReview || editorRepairResult) return;
    setProposalReviewError(null);
    try {
      setEditorRepairReview(reviewRepairEntry(editorRepairProposal, editorRepairReview, decision));
    } catch (error) {
      setProposalReviewError(error instanceof Error ? error.message : "无法保存本次修复审核决定。");
    }
  };

  const executeApprovedRepair = () => {
    if (!editorProject || !editorEvaluation || !editorRepairProposal || !editorRepairReview || editorRepairResult) return;
    setRepairExecutionBusy(true);
    setProposalReviewError(null);
    try {
      const result = executeReviewedRepairLoop({
        originalEvaluation: editorEvaluation,
        repairProposal: editorRepairProposal,
        repairReview: editorRepairReview,
        currentProject: editorProject,
        executionUpdatedAt: new Date().toISOString(),
      });
      setEditorRepairReview(result.repairReview);
      setEditorRepairResult(result);
      if (result.reEvaluation) setEditorEvaluation(result.reEvaluation);
      if (result.history.shouldRecord && result.history.undoProject && result.history.redoProject) {
        setEditorAIUndoProject(cloneProject(result.history.undoProject));
        handleEditorProjectChange(cloneProject(result.history.redoProject));
      }
      if (result.finalStatus === "REPAIR_FINAL_PASS") {
        setNotice("修复成功");
      } else if (result.finalStatus === "REPAIR_ROLLED_BACK") {
        setNotice("修复结果变差，已恢复到修复前状态");
      } else if (result.finalStatus === "REPAIR_NO_ACTIONS") {
        setNotice("用户未执行修复");
      } else {
        setNotice("修复后仍有问题");
      }
    } catch (error) {
      setProposalReviewError(error instanceof Error ? error.message : "无法执行已批准修复。");
    } finally {
      setRepairExecutionBusy(false);
    }
  };

    useEffect(()=>{if(editorProject&&jobState==="idle"){const clips=editorProject.tracks.filter(t=>t.type==="video"||t.type==="broll").flatMap(t=>t.clips);if(clips.length&&clips.every(c=>assets.some(a=>a.id===c.assetId&&a.preview))){setMatchSegments(projectToMatchSegments(editorProject));setJobState("done");setProgress(100);}}},[editorProject,assets,jobState]);

  const validateRequirementsPlan = (review: EditorRequirementsReview) => applyAIEditingPlan(
    review.result.result.data,
    {
      project: review.project,
      ownedAssetIds: new Set(review.assets.map((asset) => asset.id)),
      audioSourceDurationMs: review.audioDurationMs,
      ...(review.constraintSet ? { constraintSet: review.constraintSet } : {}),
      ...(review.intentSession.proposalContext ? { constraintContext: {
        intentVersionId: review.intentSession.proposalContext.sourceIntentVersionId,
        constraintSetId: review.intentSession.proposalContext.sourceConstraintSetId,
        constraintFingerprint: review.intentSession.proposalContext.sourceConstraintFingerprint,
      } } : {}),
      ...(review.intentSession.ledger ? { rejectedOperationTuples: review.intentSession.ledger.rejectedProposalOperationTuples } : {}),
    },
  );

  const currentRequirementsReview = requirementsReview
    && !authLoading && requirementsReview.userId === user?.id
    && requirementsReview.provider === selectedAIProvider
    && requirementsReview.project === editorProject
    && requirementsReview.assets === assets
    && requirementsReview.audioSelection === audioSelection
    && requirementsReview.audioDurationMs === audioDurationMs
    && requirementsReview.constraintSet === activeConstraintSet
    && requirementsReview.intentSession === creativeIntentSession
    && requirementsReview.requirement === requirementDraft.trim()
    ? requirementsReview : null;

  useEffect(() => {
    if (!currentRequirementsReview && requirementsReview) setRequirementsReview(null);
  }, [currentRequirementsReview, requirementsReview]);

  const runEditorTextTask = async () => {
    if (editorAITaskInFlight.current) return;
    setRequirementsReview(null);
    setEditorAIApplyResult(null);
    setEditorAITaskError(null);
    if (authLoading || !user) {
      setEditorAITaskError("请先登录后再使用 AI 功能。");
      return;
    }
    if (!selectedAIProvider) {
      setEditorAITaskError("请先选择一个已经连接的 AI 服务。");
      return;
    }
    if (!editorProject) {
      setEditorAITaskError("请先建立时间线，再生成剪辑建议。");
      return;
    }
    const editingRequirement = requirementDraft.trim();
    if (!editingRequirement) {
      setEditorAITaskError("请先填写剪辑需求。");
      return;
    }
    if (creativeIntentSession.intent && creativeIntentSession.status !== "READY_TO_PLAN") {
      setEditorAITaskError("请先确认当前保护范围并完成约束决策。");
      return;
    }
    const ownedAssetIds = new Set(assets.map((asset) => asset.id));
    const readiness = inspectEditorVisualContext(editorProject, ownedAssetIds);
    if (readiness.status !== "READY") {
      setEditorAITaskError(editorVisualContextMessage(readiness.status));
      return;
    }
    const activeVisualClips = editorProject.tracks
      .filter((track) => track.type === "video" || track.type === "broll")
      .flatMap((track) => track.clips.filter((clip) => (
        clip.trackId === track.id
        && clip.timelineStartMs <= previewElapsed * 1_000
        && previewElapsed * 1_000 < clip.timelineEndMs
        && assets.some((asset) => asset.id === clip.assetId && asset.kind === clip.kind)
      )));
    const input = {
      editingRequirement,
      editorContext: createSafeEditorAIContext(
        editorProject,
        ownedAssetIds,
        audioDurationMs,
        activeVisualClips.length === 1 ? activeVisualClips[0].id : undefined,
      ),
    };

    editorAITaskInFlight.current = true;
    setEditorAITaskBusy(true);
    try {
      const result = await runAITask({ task: "editor.requirements_parse", provider: selectedAIProvider, input });
      if (result.task !== "editor.requirements_parse" || result.provider !== selectedAIProvider
        || result.result.capability !== "TEXT_REASONING") {
        throw new Error("Unexpected editing task response.");
      }
      const review: EditorRequirementsReview = {
        result, operationCount: 0, project: editorProject, assets, audioSelection, audioDurationMs,
        requirement: editingRequirement, userId: user.id, provider: selectedAIProvider,
        constraintSet: activeConstraintSet, intentSession: creativeIntentSession,
      };
      const candidate = validateRequirementsPlan(review);
      setRequirementsReview({ ...review, operationCount: candidate.project === editorProject ? 0 : candidate.applied.length });
    } catch (error) {
      setEditorAITaskError(editorRequirementsError(error));
    } finally {
      editorAITaskInFlight.current = false;
      setEditorAITaskBusy(false);
    }
  };

  const confirmRequirementsPlan = () => {
    if (editorAITaskBusy || !editorProject || !currentRequirementsReview?.operationCount) return;
    setRequirementsReview(null);
    setEditorAITaskError(null);
    try {
      const applied = validateRequirementsPlan(currentRequirementsReview);
      if (applied.project === editorProject || !applied.applied.length) return;
      setEditorAIUndoProject(cloneProject(editorProject));
      handleEditorProjectChange(applied.project);
      setAudioSelection(applied.audioSelection);
      setAudioStartInput(formatTimeMs(applied.audioSelection.sourceInMs));
      setAudioEndInput(formatTimeMs(applied.audioSelection.sourceOutMs));
      setEditorAIApplyResult(applied);
      setNotice(`已按你的确认应用 ${applied.applied.length} 项剪辑操作`);
    } catch (error) {
      setEditorAITaskError(editorRequirementsError(error));
    }
  };

  const requirementsReviewPanel = (
    <>
      <AITaskResultPreview
        busy={editorAITaskBusy}
        error={null}
        result={currentRequirementsReview?.result ?? null}
        title="剪辑建议预览"
      />
      {editorAITaskError && <p className="editor-ai-dialog-error" role="alert">{editorAITaskError}</p>}
      {requirementsReview && !currentRequirementsReview && <p role="status">项目、需求或账号状态已变化，请重新生成建议。</p>}
      {currentRequirementsReview && (
        <div className="editor-proposal-actions">
          <p>{currentRequirementsReview.operationCount
            ? `请核对全部 ${currentRequirementsReview.operationCount} 项可执行操作，再确认应用。`
            : "这份建议没有可应用的时间线更改。"}</p>
          <button className="platform-secondary-button" type="button" onClick={() => setRequirementsReview(null)}>放弃建议</button>
          {currentRequirementsReview.operationCount > 0 && (
            <button className="flow-primary" type="button" onClick={confirmRequirementsPlan}>确认并应用剪辑建议</button>
          )}
        </div>
      )}
      {editorAIApplyResult && <EditorAIApplySummary result={editorAIApplyResult} />}
    </>
  );

  const explanationConstraintSet = activeConstraintSet ?? creativeIntentSession.constraintSet ?? undefined;
  const protectionAnnotations = useMemo(() => editorProject ? deriveProtectedTimelineAnnotationsV1({
    project: editorProject, intent: creativeIntentSession.intent, constraintSet: explanationConstraintSet,
    confirmedBindings: creativeIntentSession.confirmedBindings,
  }) : Object.freeze([]), [editorProject, creativeIntentSession.intent, creativeIntentSession.confirmedBindings, explanationConstraintSet]);
  const decisionExplanations = useMemo(() => editorProject ? deriveEditorDecisionExplanationsV1({
    project: editorProject, intent: creativeIntentSession.intent, constraintSet: explanationConstraintSet,
    feasibilityReport: creativeIntentSession.feasibilityReport, annotations: protectionAnnotations,
    blockedEnforcement: blockedExplanationResult, options: collaborativeOptionSet,
    selectedOptionId: selectedCollaborativeOptionId, proposal: editorProposal ?? reviewedEvidenceProposal,
    review: editorProposalReview, reviewedEvidence: reviewedPlanEvidence,
    evaluation: editorEvaluation, repairProposal: editorRepairProposal, repairReview: editorRepairReview,
  }) : Object.freeze([]), [editorProject, creativeIntentSession.intent, creativeIntentSession.feasibilityReport, explanationConstraintSet, protectionAnnotations, blockedExplanationResult, collaborativeOptionSet, selectedCollaborativeOptionId, editorProposal, reviewedEvidenceProposal, editorProposalReview, reviewedPlanEvidence, editorEvaluation, editorRepairProposal, editorRepairReview]);

  const goFlow=(next:EditorFlowStage)=>{setPreviewPlaying(false);previewVideoRef.current?.pause();previewAudioRef.current?.pause();pauseSelectionPreview();setFlowStage(next);};
  const flowStatus:Record<EditorFlowStage,string>={materials:assets.length?assets.length+" 项画面素材":"先添加视频或图片",sound:audioModes[audioMode]+(subtitleCues.length?"，"+subtitleCues.length+" 句字幕":"，字幕可跳过"),assistant:editorProposal?"有建议待审核":reviewedPlanEvidence?"已审核":"按需使用，可跳过",finish:renderState==="ready"?"成片已生成":editorProject?"时间线已建立":"待建立时间线"};
  return (
    <main className={`app-shell editor-studio ${editorOpen ? "editor-active" : ""}`}>
      <section className="hero">
        <div className="editor-hero-copy">
          <div>
            <span className="eyebrow">AI 视频剪辑</span>
            <h1>视频剪辑</h1>
            
          </div>
          <button className="quiet-button" onClick={loadDemo} type="button">
            载入演示
          </button>
        </div>

        


      </section>

      <nav className="editor-flow-nav" aria-label="剪辑阶段">{EDITOR_FLOW_STAGES.map((step,index)=><button key={step.id} type="button" aria-current={flowStage===step.id?"step":undefined} onClick={()=>goFlow(step.id)}><span className="flow-stage-index">{String(index+1).padStart(2,"0")}</span><span><b>{step.title}</b><small>{flowStatus[step.id]}</small></span>{step.optional&&<em>可选</em>}</button>)}</nav><section className="workspace editor-flow-workspace" id="workspace"><section className="editor-flow-stage" data-editor-stage="materials" hidden={flowStage!=="materials"} aria-labelledby="flow-materials"><header className="flow-stage-heading"><span>01</span><div><h2 id="flow-materials">添加素材</h2><p>先添加视频或图片。独立音频可稍后添加。</p></div></header><div className="panel input-panel flow-card"><div className="panel-heading">
            <div>
              
              <div>
                <h3>视频与图片</h3>
                
              </div>
            </div>
            <span className="count-chip">{assets.length}/30</span>
          </div><input
            accept="video/mp4,video/webm,video/quicktime,image/jpeg,image/png,image/webp"
            hidden
            multiple
            onChange={handleMediaChange}
            ref={mediaInput}
            type="file"
          />
<div
            className={`dropzone ${dragging ? "dragging" : ""}`}
            onClick={() => mediaInput.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
          >
            <span className="upload-orbit"><UploadIcon size={27} /></span>
            <b>拖入视频或图片素材</b>
            <span>或点击选择文件，单个文件最大 2GB</span>
            <small>支持浏览器可播放的 MP4、WebM、MOV，以及 JPG、PNG、WebP</small>
          </div>
          {mediaImportError && <p role="alert" className="asset-alert">{mediaImportError}</p>}
          {assets.length > 0 && (
            <div className="asset-list">
              {assets.map((asset, index) => (
                <div className="asset-row" key={asset.id}>
                  <span className={`asset-type ${asset.kind === "图片" ? "image" : ""}`}>
                    {asset.kind === "视频" ? <VideoIcon /> : <ImageIcon />}
                  </span>
                  <div className="asset-name">
                    <b>{asset.name}</b><small className="asset-timeline-state">{editorProject?.tracks.some(t=>t.clips.some(c=>c.assetId===asset.id))?"已在时间线":"未加入时间线"}</small>
                    <span>
                      {asset.kind}，{asset.size}
                      {asset.duration ? `，${formatDuration(asset.duration)}` : ""}
                    </span>
                    {asset.semanticTopic && (
                      <small className="asset-insight">
                        {CLIP_TEST_ENABLED ? "视觉候选：" : "已识别："}{asset.semanticTopic}
                        {CLIP_TEST_ENABLED ? "，需要人工确认" : asset.semanticScore ? `，${Math.round(asset.semanticScore * 100)}%` : ""}
                      </small>
                    )}
                  </div>
                  <span className="asset-order">{String(index + 1).padStart(2, "0")}</span>
                  <button aria-label={`移除 ${asset.name}`} className="remove-button" onClick={() => removeAsset(asset.id)} type="button">×</button>
                </div>
              ))}
              <button className="add-more" onClick={() => mediaInput.current?.click()} type="button">＋ 继续添加素材</button>
            </div>
          )}{editorProject&&editorProject.assets.some(a=>!assets.some(r=>r.id===a.id&&r.preview))&&<section className="flow-relink" aria-label="恢复素材关联"><h3>工程已恢复，文件待关联</h3><p>重新选择原文件即可恢复播放，剪辑位置和字幕不会改变。旧工程无法自动核实文件内容，请核对画面。</p>{editorProject.assets.filter(a=>!assets.some(r=>r.id===a.id&&r.preview)).map(a=><label key={a.id}><span>{a.name}</span><input aria-label={"重新关联 "+a.name} type="file" accept={a.kind==="视频"?"video/*":"image/*"} onChange={e=>{const file=e.target.files?.[0];if(file)void relinkVisualFile(a.id,file);e.target.value="";}}/></label>)}</section>}<div className="panel-heading compact">
            <div>
              
              <div>
                <h3>上传独立音频（可选）</h3>
                
              </div>
            </div>
          </div><input accept="audio/*" hidden multiple onChange={handleAudio} ref={audioInput} type="file" />
{!audios.length ? (
            <button className="audio-upload" onClick={() => audioInput.current?.click()} type="button">
              <span><AudioIcon /></span>
              <div>
                <b>选择旁白或背景音乐</b>
                <small>MP3、WAV、M4A；上传后按音频 1、音频 2 编号</small>
              </div>
              <span className="select-file">选择文件</span>
            </button>
          ) : (
            <div className="audio-list-wrap">
              <div className="audio-list">
                {audios.map((audio, index) => (
                  <div className="audio-card" key={audio.id}>
                    <span className="audio-index">{index + 1}</span>
                    <span className="audio-icon"><AudioIcon /></span>
                    <div className="audio-info">
                      <b>{audio.name}</b>
                      <span>
                        音频 {index + 1}，{audio.size}，{audio.duration ? formatDuration(audio.duration) : "读取中"}
                      </span>
                      <div className="demo-wave" aria-label={audio.url ? "音频已就绪" : "演示音频"}>
                        <i /><i /><i /><i /><i /><i /><i /><i />
                      </div>
                    </div>
                    <button
                      aria-label={`移除音频 ${index + 1}`}
                      className="remove-button"
                      onClick={() => removeAudio(audio.id)}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <div className="audio-list-footer">
                <button onClick={() => audioInput.current?.click()} type="button">＋ 继续添加音频</button>
                <span>共 {audios.length} 段，总时长 {formatDuration(audioDuration)}</span>
              </div>
            </div>
          )}<label className="consent">
            <input checked={consent} onChange={(event) => setConsent(event.target.checked)} type="checkbox" />
            <span>我确认拥有上传素材和音频的使用权，内容不涉及患者隐私或未经授权的个人信息。</span>
          </label><div className="flow-material-actions">{editorProject&&<p className="flow-note">已有时间线。添加文件不会自动替换原有片段。</p>}<button className="flow-primary" type="button" disabled={!canGenerate || jobState === "processing"} onClick={()=>editorProject?goFlow("finish"):void startJob(true)}>{startingJob?"正在准备素材…":editorProject?"前往精剪与导出":"开始手动剪辑"}</button>{!canGenerate&&<small className="flow-disabled-reason">{!assets.some(a=>a.preview)?"先添加视频或图片。":!consent?"请先确认素材使用权。":audioMode==="external"&&!audios.length?"独立音频模式需要声音文件，可在声音设置中改用视频原声。":"请在声音设置中检查音频区间与时长。"}</small>}<button className="flow-link" type="button" onClick={()=>goFlow("sound")}>设置声音与字幕（可选）</button></div></div></section><section className="editor-flow-stage" data-editor-stage="sound" hidden={flowStage!=="sound"} aria-labelledby="flow-sound"><header className="flow-stage-heading"><span>02</span><div><h2 id="flow-sound">声音与字幕</h2><p>可选，可直接使用视频原声，字幕也可以跳过。</p></div></header><div className="panel flow-card"><h3>声音来源</h3><div className="field audio-source-field">
            <label htmlFor="editor-audio-mode">音频模式</label>
            <select className="editor-audio-mode" id="editor-audio-mode" value={audioMode} disabled={renderState === "rendering" || jobState === "processing" || startingJob || transcriptionBusy} onChange={(event) => {
              if (speechProtected && event.target.value !== "original") {
                setNotice("当前工程已锁定讲话内容，不能更换音频模式。");
                return;
              }
              setPreviewPlaying(false);
              previewAudioRef.current?.pause();
              previewVideoRef.current?.pause();
              pauseSelectionPreview();
              const next = event.target.value as AudioInputMode;
              setNotice("声音来源已更换，原字幕未重新识别，请试听并校对。");
              setAudioModeChoice(next);
              clearRenderedVideo();
            }}>
              {Object.entries(audioModes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            {audioMode === "mix" && (
              <div className="custom-duration">
                <label>视频原声音量 <input type="range" disabled={renderState === "rendering" || speechProtected} min="0" max="1" step="0.05" value={originalVolume} onChange={(event) => { setOriginalVolume(Number(event.target.value)); clearRenderedVideo(); }} /> {Math.round(originalVolume * 100)}%</label>
                <label>背景音乐音量 <input type="range" disabled={renderState === "rendering"} min="0" max="1" step="0.05" value={musicVolume} onChange={(event) => { setMusicVolume(Number(event.target.value)); clearRenderedVideo(); }} /> {Math.round(musicVolume * 100)}%</label>
              </div>
            )}
          </div>{showAudioRange && <section className="panel workflow-step-card audio-interval-step">
          <div className="panel-heading">
            <div>
              
              <div>
                <h3>{audioMode === "mix" ? "背景音乐区间" : "音频区间"}</h3>
                
              </div>
            </div>
          </div>

          <div className="field audio-selection-field">
            <div className="audio-selection-heading">
              <div>
                <label>使用音频区间</label>
                <small>时间精度：10 毫秒。</small>
              </div>
              <span>{selectionValidation.valid && !audioSelectionInputError ? "区间有效" : "需要修正"}</span>
            </div>

            <div className="audio-selection-mode">
              <button
                className={audioSelection.mode === "full" ? "selected" : ""}
                disabled={!audioDurationMs}
                onClick={() => {
                  commitAudioSelection(createFullAudioSelection(audioDurationMs));
                  setDurationMode("audio");
                }}
                type="button"
              >
                使用完整音频
              </button>
              <button
                className={audioSelection.mode === "range" ? "selected" : ""}
                disabled={!audioDurationMs}
                onClick={() => commitAudioSelection({
                  mode: "range",
                  sourceDurationMs: audioDurationMs,
                  sourceInMs: audioSelection.mode === "range" ? audioSelection.sourceInMs : 0,
                  sourceOutMs: audioSelection.mode === "range" ? audioSelection.sourceOutMs : audioDurationMs,
                  selectedDurationMs: audioSelection.mode === "range"
                    ? audioSelection.sourceOutMs - audioSelection.sourceInMs
                    : audioDurationMs
                })}
                type="button"
              >
                选择指定区间
              </button>
            </div>

            <div className="audio-range-summary">
              <div><span>音频总时长</span><b>{formatTimeMs(audioDurationMs)}</b></div>
              <div><span>选择开始</span><b>{formatTimeMs(audioSelection.sourceInMs)}</b></div>
              <div><span>选择结束</span><b>{formatTimeMs(audioSelection.sourceOutMs)}</b></div>
              <div><span>已选时长</span><b>{formatTimeMs(audioSelection.selectedDurationMs)}</b></div>
            </div>

            <div className={`audio-wave-selector ${audioSelection.mode === "full" ? "full" : ""}`}>
              <div className="wave-bars" aria-hidden="true">
                {waveformBars.map((height, index) => {
                  const position = index / 71;
                  const selected = position >= (
                    audioDurationMs ? audioSelection.sourceInMs / audioDurationMs : 0
                  ) && position <= (
                    audioDurationMs ? audioSelection.sourceOutMs / audioDurationMs : 1
                  );
                  return <i className={selected ? "selected" : ""} key={index} style={{ height }} />;
                })}
              </div>
              <div
                className="selected-range-fill"
                style={{
                  left: `${audioDurationMs ? audioSelection.sourceInMs / audioDurationMs * 100 : 0}%`,
                  right: `${audioDurationMs ? 100 - audioSelection.sourceOutMs / audioDurationMs * 100 : 0}%`
                }}
              />
              <div
                className="selection-playhead"
                style={{
                  left: `${audioDurationMs ? selectionPlayheadMs / audioDurationMs * 100 : 0}%`
                }}
              />
              {audioSelection.mode === "range" && (
                <>
                  <input
                    aria-label="音频区间开始"
                    className="range-handle range-start"
                    max={audioDurationMs}
                    min="0"
                    onChange={(event) => commitAudioSelection({
                      ...audioSelection,
                      mode: "range",
                      sourceInMs: Math.min(Number(event.target.value), audioSelection.sourceOutMs - 10),
                      selectedDurationMs: audioSelection.sourceOutMs - Number(event.target.value)
                    })}
                    step="10"
                    type="range"
                    value={audioSelection.sourceInMs}
                  />
                  <input
                    aria-label="音频区间结束"
                    className="range-handle range-end"
                    max={audioDurationMs}
                    min="0"
                    onChange={(event) => commitAudioSelection({
                      ...audioSelection,
                      mode: "range",
                      sourceOutMs: Math.max(Number(event.target.value), audioSelection.sourceInMs + 10),
                      selectedDurationMs: Number(event.target.value) - audioSelection.sourceInMs
                    })}
                    step="10"
                    type="range"
                    value={audioSelection.sourceOutMs}
                  />
                </>
              )}
            </div>

            {audioSelection.mode === "range" && (
              <div className="audio-time-inputs">
                <label>
                  <span>开始时间</span>
                  <input
                    aria-invalid={Boolean(audioSelectionInputError)}
                    onChange={(event) => applyAudioTimeInput("start", event.target.value)}
                    placeholder="00:00.000"
                    value={audioStartInput}
                  />
                </label>
                <span>→</span>
                <label>
                  <span>结束时间</span>
                  <input
                    aria-invalid={Boolean(audioSelectionInputError)}
                    onChange={(event) => applyAudioTimeInput("end", event.target.value)}
                    placeholder="00:00.000"
                    value={audioEndInput}
                  />
                </label>
              </div>
            )}

            {(audioSelectionInputError || !selectionValidation.valid) && (
              <div className="audio-selection-error">
                {audioSelectionInputError || selectionValidation.error}
              </div>
            )}

            <div className="audio-selection-actions">
              <button disabled={!audios.some((audio) => audio.url)} onClick={playSelectionPreview} type="button">▶ 试听所选区间</button>
              <button disabled={!selectionPreviewPlaying} onClick={pauseSelectionPreview} type="button">Ⅱ 暂停试听</button>
              <button
                disabled={audioSelection.mode !== "range"}
                onClick={() => commitAudioSelection({
                  ...audioSelection,
                  sourceInMs: Math.min(selectionPlayheadMs, audioSelection.sourceOutMs - 10),
                  selectedDurationMs: audioSelection.sourceOutMs - Math.min(selectionPlayheadMs, audioSelection.sourceOutMs - 10)
                })}
                type="button"
              >
                当前位置设为入点
              </button>
              <button
                disabled={audioSelection.mode !== "range"}
                onClick={() => commitAudioSelection({
                  ...audioSelection,
                  sourceOutMs: Math.max(selectionPlayheadMs, audioSelection.sourceInMs + 10),
                  selectedDurationMs: Math.max(selectionPlayheadMs, audioSelection.sourceInMs + 10) - audioSelection.sourceInMs
                })}
                type="button"
              >
                当前位置设为出点
              </button>
              <button
                disabled={!audioDurationMs}
                onClick={() => commitAudioSelection(createFullAudioSelection(audioDurationMs))}
                type="button"
              >
                恢复完整音频
              </button>
            </div>

            {jobState !== "done" && audios[selectionAudioIndex]?.url && (
              <audio
                hidden
                onEnded={handleSelectionAudioEnded}
                onTimeUpdate={(event) => handleSelectionTimeUpdate(event.currentTarget)}
                ref={selectionAudioRef}
                src={audios[selectionAudioIndex].url}
              />
            )}

            {audioMode === "external" && <div className={`duration-link-state ${durationMismatchKind}`}>
              <div>
                <b>
                  {durationMismatchKind === "match"
                    ? "视频长度与音频区间匹配"
                    : durationMismatchKind === "shorter"
                      ? "视频长度短于所选音频区间"
                      : "视频长度长于所选音频区间"}
                </b>
                <span>
                  {durationMismatchKind === "match"
                    ? "音频、字幕与画面将从同一时间原点开始。"
                    : durationMismatchKind === "shorter"
                      ? `有 ${formatTimeMs((selectedAudioDuration - targetDuration) * 1000)} 音频无法完整进入成片；不会自动加速。`
                      : `成片末尾将有 ${formatTimeMs((targetDuration - selectedAudioDuration) * 1000)} 无旁白画面；不会循环或减速音频。`}
                  </span>
              </div>
              <button
                disabled={!audioSelection.selectedDurationMs}
                onClick={() => {
                  setDurationMode("audio");
                  setCustomDuration(selectedAudioDuration);
                  setDurationMismatchConfirmed(false);
                }}
                type="button"
              >
                让视频长度匹配音频区间
              </button>
            </div>}
            {durationMismatch && (
              <label className="mismatch-confirm">
                <input
                  checked={durationMismatchConfirmed}
                  onChange={(event) => setDurationMismatchConfirmed(event.target.checked)}
                  type="checkbox"
                />
                <span>我已了解时长不匹配的影响，仍使用当前设置生成（不会自动变速）。</span>
              </label>
            )}
          </div>
        </section>}<div className="panel-heading compact">
            <div>
              
              <div>
                <h3>选择字幕来源</h3>
                
              </div>
            </div>
            <div className="subtitle-proofread-actions">
              {!subtitleCues.length && <small id="srt-empty-hint">暂无字幕可下载</small>}
              <button
                aria-describedby={!subtitleCues.length ? "srt-empty-hint" : undefined}
                className="flow-secondary"
                disabled={!subtitleCues.length}
                onClick={() => downloadSubtitleFile(subtitleCues)}
                type="button"
              >下载 SRT</button>
            </div>
          </div><div className="subtitle-source-tabs">
            <button
              className={subtitleSource === "auto" ? "selected" : ""}
              onClick={() => { if(transcriptionState==="loading"||transcriptionState==="running")stopTranscription(false);setSubtitleSource("auto");setTranscriptionError(""); }}
              type="button"
            >
              <SparkIcon />
              <span><b>识别字幕</b><small>生成时间码与字幕</small></span>
            </button>
            <button
              className={subtitleSource === "upload" ? "selected" : ""}
              onClick={() => { if(transcriptionState==="loading"||transcriptionState==="running")stopTranscription(false);setSubtitleSource("upload");setTranscriptionError(""); }}
              type="button"
            >
              <UploadIcon size={19} />
              <span><b>上传同步字幕</b><small>SRT、VTT 或基础 ASS（需时间码）</small></span>
            </button>
          </div>
{subtitleSource === "auto" ? (
            <div className={`recognition-card state-${transcriptionState}`}>
              <span className="recognition-icon"><AudioIcon /></span>
              <div>
                <b>
                  {transcriptionState === "ready" && subtitleCues.length > 0
                    ? `已生成 ${subtitleCues.length} 句同步字幕`
                    : transcriptionState === "loading"
                      ? "正在准备音频与本地识别模型"
                      : transcriptionState === "running"
                        ? "正在识别人声与停顿"
                        : transcriptionState === "error"
                          ? "音频识别失败"
                          : audios.length
                            ? audioMode === "external" ? `${audios.length} 段音频已就绪，将自动生成字幕` : audioMode === "silent" ? "可直接剪辑，或上传字幕" : "识别上传视频中的原声"
                            : audioMode === "external" ? "上传旁白后自动识别" : audioMode === "silent" ? "可直接剪辑，或上传字幕" : "识别上传视频中的原声"}
                </b>
                {transcriptionState === "error" ? (
                  <>
                    <span className="recognition-error">
                      失败阶段：{transcriptionStageLabels[failureStage ?? "error"]}。{
                        transcriptionError || "没有生成有效字幕，请检查音频后重新识别。"
                      }
                    </span>
                    {transcriptionErrorStack && (
                      <details className="recognition-debug">
                        <summary>开发诊断信息</summary>
                        <pre>{transcriptionErrorStack}</pre>
                      </details>
                    )}
                  </>
                ) : (
                  <span>识别后可逐句校对；没有可靠时间码时不会估算。 <a href="/medclip-asr-notices/">模型与媒体组件许可</a></span>
                )}
                <details className="advanced-settings transcription-advanced">
                  <summary>高级设置与识别诊断</summary>
                  <div className="transcription-stages" aria-label="识别进度阶段">
                  {([
                    "preparing-audio",
                    "loading-model",
                    "recognizing",
                    "timestamping",
                    "segmenting",
                    "success"
                  ] as TranscriptionStage[]).map((stage) => (
                    <span
                      className={transcriptionStage === stage ? "current" : ""}
                      key={stage}
                    >
                      {transcriptionStageLabels[stage]}
                    </span>
                  ))}
                  </div>
                  <div className="transcription-context">
                  {!videoTranscription && <label>
                    <span>已有原始文稿（可选，TTS音频推荐）</span>
                    <textarea
                      aria-label="已有原始文稿"
                      disabled={transcriptionState === "loading" || transcriptionState === "running"}
                      onChange={(event) => {
                        setReferenceTranscript(event.target.value);
                        if (captionRecords.length) {
                          setSubtitleText("");
                          setCaptionRecords([]);
                          setRecognizedSubtitleText("");
                          setTranscriptionState("idle");
                          setTranscriptionStage("waiting");
                          setEditorProject(null);
                        }
                      }}
                      placeholder="填写生成这段音频时使用的原文；字幕将保留原文，只使用最终音频取得时间戳。"
                      rows={3}
                      value={referenceTranscript}
                    />
                  </label>}
                  <label>
                    <span>医学术语表（可选，用逗号分隔）</span>
                    <input
                      aria-label="医学术语表"
                      disabled={transcriptionState === "loading" || transcriptionState === "running"}
                      onChange={(event) => {
                        setMedicalTerms(event.target.value);
                        if (captionRecords.length) {
                          setSubtitleText("");
                          setCaptionRecords([]);
                          setRecognizedSubtitleText("");
                          setTranscriptionState("idle");
                          setTranscriptionStage("waiting");
                          setEditorProject(null);
                        }
                      }}
                      placeholder="例如：阿司匹林，BRCA1，HER2"
                      type="text"
                      value={medicalTerms}
                    />
                  </label>
                  </div>
                  <span className="recognition-quality">
                  <button
                    className={transcriptionQuality === "accurate" ? "selected" : ""}
                    disabled={transcriptionState === "loading" || transcriptionState === "running"}
                    onClick={() => {
                      setTranscriptionQuality("accurate");
                      setSubtitleText("");
                      setCaptionRecords([]);
                      setRecognizedSubtitleText("");
                      setTranscriptionState("idle");
                      setTranscriptionProgress(0);
                      setTranscriptionError("");
                      setTranscriptionStage("waiting");
                    }}
                    type="button"
                  >
                    医学准确
                  </button>
                  <button
                    className={transcriptionQuality === "fast" ? "selected" : ""}
                    disabled={transcriptionState === "loading" || transcriptionState === "running"}
                    onClick={() => {
                      setTranscriptionQuality("fast");
                      setSubtitleText("");
                      setCaptionRecords([]);
                      setRecognizedSubtitleText("");
                      setTranscriptionState("idle");
                      setTranscriptionProgress(0);
                      setTranscriptionError("");
                      setTranscriptionStage("waiting");
                    }}
                    type="button"
                  >
                    极速模式
                  </button>
                </span>
                {(transcriptionState === "loading" || transcriptionState === "running") && (
                  <>
                    <span className="ai-progress"><i style={{ width: `${transcriptionProgress}%` }} /></span>
                    <small className="background-hint">识别在后台运行，你可以继续滚动、填写要求或调整设置</small>
                  </>
                )}
                </details>
              </div>
              {transcriptionState === "loading" || transcriptionState === "running" ? (
                <button className="cancel-recognition" onClick={() => stopTranscription()} type="button">
                  取消识别
                </button>
              ) : (
                <button
                  disabled={startingJob || renderState === "rendering" || (videoTranscription ? !hasVideoForTranscription : audioMode !== "external" || audioDuration <= 0 || !audios.some((audio) => audio.url))}
                  onClick={() => {
                    void transcribeAudio().then(() => {
                      if (!videoTranscription) setNotice("字幕已按音频时间码生成，可在下方逐句校对");
                    }).catch((error) => {
                      if (error instanceof DOMException && error.name === "AbortError") return;
                      setNotice(error instanceof Error ? error.message : "音频识别失败");
                    });
                  }}
                  type="button"
                >
                  {transcriptionState === "ready" || transcriptionState === "error"
                    ? "重新识别"
                    : "开始识别字幕"}
                </button>
              )}
            </div>
          ) : (
            <div className="subtitle-upload-box">
              <input
                accept=".srt,.vtt,.ass,text/vtt,application/x-subrip,text/x-ssa,text/x-ass"
                hidden
                onChange={handleSubtitleFile}
                ref={subtitleInput}
                type="file"
              />
              <div className="subtitle-file-row">
                <button onClick={() => subtitleInput.current?.click()} type="button">
                  <UploadIcon size={18} />
                  {subtitleName ? "更换字幕文件" : "选择字幕文件"}
                </button>
                <span>{subtitleName || "也可以直接在下方粘贴字幕"}</span>
              </div>
              <textarea
                aria-label="字幕文本"
                onChange={(event) => {
                  const value = event.target.value;
                  const basis = "source";
                  const parsed = buildSubtitleCues(
                    value,
                    audioMode === "external" && audioDurationMs > 0 ? audioDurationMs : 86_400_000,
                    true
                  );
                  setSubtitleText(value);
                  setCaptionRecords(
                    audioMode === "external" && audioSelection.mode === "range"
                      ? cropAndRebaseCaptions(
                          parsed,
                          audioSelection.sourceInMs,
                          audioSelection.sourceOutMs
                        )
                      : parsed
                  );
                  setSubtitleTimelineBasis(basis);
                  setJobState("idle");
                  setProgress(0);
                }}
                placeholder={"粘贴含时间码的 SRT / VTT 字幕\nASS 请使用文件上传；纯文稿请填入“已有原始文稿”，再用最终音频执行对齐。"}
                rows={6}
                value={subtitleText}
              />
              <div className="subtitle-text-meta">
                <span>{subtitleText.trim() ? `${subtitleText.trim().length} 个字符` : "等待字幕内容"}</span>
                {subtitleText && (
                  <button
                    onClick={() => {
                      setSubtitleName("");
                      setSubtitleText("");
                      setCaptionRecords([]);
                    }}
                    type="button"
                  >
                    清空
                  </button>
                )}
              </div>
            </div>
          )}
{subtitleCues.length > 0 && (
            <section className="subtitle-proofread-panel">
              <div className="subtitle-proofread-header">
                <div>
                  <span className="proofread-kicker">字幕校对</span>{captionTimelineHasOverlap(subtitleCues)&&<small role="status">存在重叠时码，字幕原文已保留，请在精剪中核对。</small>}
                  <b>{subtitleSource === "auto" ? "自动识别文字，可逐句修改" : "字幕文字，可逐句修改"}</b>
                  <span>{subtitleCues.length} 句，{formatDuration(previewDuration)}。修改会同步到成片</span>
                </div>
                <div className="subtitle-proofread-actions">
                  {recognizedSubtitleText && !videoTranscription && subtitleText !== recognizedSubtitleText && (
                    <button onClick={restoreRecognizedSubtitles} type="button">恢复识别结果</button>
                  )}
                </div>
              </div>
              <div className="subtitle-editor-list">
                {subtitleCues.slice(0, captionVisibleCount).map((cue, index) => (
                  <label
                    className={`subtitle-editor-row ${cue.needsReview ? "needs-review" : ""}`}
                    key={cue.id}
                  >
                    <span className="cue-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="cue-editor-main">
                      <i>
                        {formatCueTime(cue.startMs)} → {formatCueTime(cue.endMs)}
                        {cue.needsReview ? "（需要校对）" : ""}
                      </i>
                      <textarea
                        aria-label={`第 ${index + 1} 句字幕`}
                        onChange={(event) => updateSubtitleCueText(cue.id, event.target.value)}
                        rows={Math.max(1, Math.ceil(Math.max(1, cue.text.length) / 28))}
                        value={cue.text}
                      />
                    </span>
                  </label>
                ))}
                {captionVisibleCount < subtitleCues.length && (
                  <button
                    className="load-more-captions"
                    onClick={() => setCaptionVisibleCount((count) => count + 60)}
                    type="button"
                  >
                    继续显示字幕（{captionVisibleCount}/{subtitleCues.length}）
                  </button>
                )}
              </div>
              <small className="proofread-tip">
                自动识别字幕使用音频中对应语句的实际开始与结束时间；修改文字不会改变时间码。
              </small>
            </section>
          )}<div className="flow-next"><button className="flow-link" type="button" onClick={()=>goFlow("materials")}>管理声音文件</button><button className="flow-secondary" type="button" onClick={()=>goFlow("assistant")}>使用 AI 辅助（可选）</button><button className="flow-primary" type="button" onClick={()=>goFlow("finish")}>前往精剪与导出</button></div></div></section><section className="editor-flow-stage" data-editor-stage="assistant" hidden={flowStage!=="assistant"} aria-labelledby="flow-assistant"><header className="flow-stage-heading"><span>03</span><div><h2 id="flow-assistant">AI 辅助剪辑</h2><p>可选，先生成建议，再由你审核执行。</p></div></header><div className="panel workflow-step-card ai-planning-step flow-card"><div className="flow-ai-context" role="status">{!editorProject?<><span>素材已上传后，还需要先建立时间线。</span><button className="flow-link" type="button" onClick={()=>goFlow("materials")}>去建立时间线</button></>:!editorProject.tracks.some(t=>t.clips.length)?<><span>当前工程还没有可编辑片段。</span><button className="flow-link" type="button" onClick={()=>goFlow("finish")}>去精剪添加片段</button></>:editorProject.tracks.flatMap(t=>t.clips).some(c=>!assets.some(a=>a.id===c.assetId&&a.preview))?<><span>时间线已有片段，部分文件需要重新关联。</span><button className="flow-link" type="button" onClick={()=>goFlow("materials")}>关联素材</button></>:<span>时间线已就绪。建议与实际执行分开，所有候选都需要审核。</span>}</div><div className="flow-ai-tabs" role="tablist" aria-label="AI 辅助方式">{[["request","按需求剪辑"],["lyrics","按字幕选镜头"],["reference","参考视频风格"]].map(([id,label])=><button key={id} type="button" role="tab" aria-selected={aiTool===id} onClick={()=>setAiTool(id as "request"|"lyrics"|"reference")}>{label}</button>)}</div><div className="editor-ai-tool" hidden={aiTool!=="request"}><div className="flow-request">
            <label htmlFor="editor-flow-request">想怎么剪？</label>
            <textarea
              id="editor-flow-request"
              aria-label="剪辑需求"
              value={requirementDraft}
              placeholder="例如：将第一个片段调为 1.5 倍速，或在该片段第 2 秒分割。"
              onChange={(event) => setRequirementDraft(event.target.value)}
            />
            <button type="button" className="flow-primary"
              disabled={editorAITaskBusy || !editorProject || !selectedAIProvider || !requirementDraft.trim()}
              onClick={() => void runEditorTextTask()}
            >{editorAITaskBusy ? "正在生成建议…" : "生成 AI 剪辑建议"}</button>
            <small>{!editorProject ? "先建立时间线，再生成剪辑建议。"
              : !selectedAIProvider ? "请登录并选择已连接的 AI 服务。"
              : "可按明确的片段、时间或字幕生成建议。需求和当前时间线的文本信息会发给所选服务商。请先核对建议，再确认应用。"}</small>
          </div>
          {!requirementDialogOpen && requirementsReviewPanel}
          <details className="advanced-settings flow-provider"><summary>{selectedAIProvider?"已选择 AI 服务":"选择 AI 服务"}</summary><div className="editor-ai-provider-first-screen">
          <AITaskProviderSelector
            disabled={editorAITaskBusy}
            onSelect={setSelectedAIProvider}
            selectedProvider={selectedAIProvider}
          />
        </div></details><details className="advanced-settings"><summary>高级规划与诊断</summary><div className="editor-proposal-actions">
              <label className="multi-option-toggle">
                <input
                  checked={planGenerationMode === "MULTI_OPTION"}
                  disabled={proposalBusy}
                  onChange={(event) => changePlanGenerationMode(event.currentTarget.checked ? "MULTI_OPTION" : "SINGLE")}
                  type="checkbox"
                />
                <span>
                  <b>生成多个剪辑方案</b>
                  <small>可选功能。开启后，MedClip 会生成 2–3 个满足当前保护约束的不同剪辑方案供你选择；方案在浏览器本地生成。</small>
                </span>
              </label>
              <button
                className="platform-secondary-button"
                disabled={proposalBusy || !editorProject || creativeIntentSession.status !== "READY_TO_PLAN"}
                onClick={generateProductionProposal}
                type="button"
              >
                {proposalBusy ? "正在生成本地建议…" : planGenerationMode === "MULTI_OPTION" ? "生成多个本地方案" : "生成基于保护约束的本地建议"}
              </button>
              <small>{creativeIntentSession.status === "READY_TO_PLAN"
                ? "仅生成待审核建议，不修改时间线，也不创建撤销记录。"
                : "完成创作意图分析、保护确认和冲突决策后才可生成建议。"}</small>
            </div>
            <dl aria-label="暂未启用的剪辑工具">
              {unavailableEditorTools.map(([label, reason]) => (
                <div key={label}><dt>{label}</dt><dd>{reason}</dd></div>
              ))}
            </dl>
            <details className="advanced-settings requirement-advanced">
            <summary>高级剪辑需求{requirements ? "（已填写）" : ""}</summary>
            <div className="field">
              <button
                className={`requirement-trigger ${requirements ? "has-content" : ""}`}
                onClick={() => {
                  setRequirementDraft(requirements);
                  setRequirementDialogOpen(true);
                }}
                type="button"
              >
                <span>
                  <b>{requirements ? "编辑自定义编排需求" : "填写视频与音频编排需求"}</b>
                  <small>{requirements || "按素材编号指定出现位置和镜头顺序"}</small>
                </span>
                <em>{requirements ? "编辑" : "填写"}</em>
              </button>
            </div>
          </details></details></div><div className="editor-ai-tool" hidden={aiTool!=="lyrics"}><p className="flow-visual-status" role="status">{!CLIP_TEST_ENABLED?"画面理解暂未开启，仍可手动剪辑。":matchingState==="loading"?"正在加载本站画面模型…":matchingState==="running"?"正在分析实际画面…":editorProject&&currentVideoSemanticEvidence(editorProject).length?"已有 "+currentVideoSemanticEvidence(editorProject).length+" 段视频分析，仍需核对镜头。":"尚未分析画面。只使用真实取样，无法可靠判断时不会强行推荐。"}</p>{CLIP_TEST_ENABLED && editorProject && <section className="editor-proposal-actions" aria-label="本地视觉匹配测试">
              <label>选择字幕区间 <select aria-label="视觉匹配字幕区间" value={visualCaptionId || editorProject.captions[0]?.id || ""} onChange={event=>setVisualCaptionId(event.target.value)}>
                {editorProject.captions.map(c=><option key={c.id} value={c.id}>{(c.startMs/1000).toFixed(3)}–{(c.endMs/1000).toFixed(3)}s，{c.text}</option>)}
              </select></label>
              <button type="button" className="platform-secondary-button" disabled={proposalBusy||!editorProject.captions.length} onClick={()=>void generateLocalVisualProposal()}>{proposalBusy?"正在分析实际画面…":"分析画面并推荐镜头"}</button>
              <small>仅使用所选字幕的已有时间码。请先在精剪中按其起止分割目标片段；建议需逐条审核。</small>
              <ClipEvidencePanel analyses={currentVideoSemanticEvidence(editorProject)} assets={editorProject.assets}/>
            </section>}<details className="advanced-settings"><summary>音乐分段与节奏</summary><section aria-label="音乐与视频联动" className="music-video-linkage-panel">
            <header>
              <div><b>音乐与视频联动</b><span>使用当前编辑器音频、歌词和已上传视频素材生成待审核建议</span></div>
              <button disabled={musicVideoBusy || !editorProject} onClick={analyzeMusicVideoLinkage} type="button">
                {musicVideoBusy ? "正在分析…" : "分析并匹配"}
              </button>
            </header>
            <label className="music-video-lyrics-field">
              <span>歌词（每行一条；留空时使用当前字幕时间证据）</span>
              <textarea
                aria-label="音乐与视频联动歌词"
                onChange={(event) => setMusicVideoLyricsDraft(event.target.value)}
                maxLength={10_000}
                placeholder={editorProject?.captions.length ? `已检测到 ${editorProject.captions.length} 条当前字幕时间证据` : "粘贴歌词，每行一条"}
                rows={3}
                value={musicVideoLyricsDraft}
              />
            </label>
            <div className="music-video-input-status" aria-live="polite">
              <span>音频：{audios.length ? `${audios[selectionAudioIndex]?.name ?? audios[0].name}，${formatDuration((editorProject?.audioSelection.selectedDurationMs ?? 0) / 1_000)}` : "缺少音频"}</span>
              <span>歌词：{musicVideoLyricsDraft.trim() ? "已提供（粗略均分时间）" : editorProject?.captions.length ? `当前字幕证据 ${editorProject.captions.length} 条` : "缺少歌词/证据"}</span>
              <span>视频素材：{editorProject?.assets.filter((asset) => asset.kind === "视频").length ? `${editorProject.assets.filter((asset) => asset.kind === "视频").length} 个` : "缺少视频素材"}</span>
              <span>可用场景证据：{editorProject && currentVideoSemanticEvidence(editorProject).some((analysis) => editorProject.assets.some((asset) => asset.id === analysis.assetId && asset.kind === "视频")) ? `${currentVideoSemanticEvidence(editorProject).filter((analysis) => editorProject.assets.some((asset) => asset.id === analysis.assetId && asset.kind === "视频")).reduce((count, analysis) => count + analysis.segments.length, 0)} 个` : "无可用语义证据"}</span>
            </div>
            {musicVideoResult && <>
              <div className="music-video-result-summary" role="status">
                <span>音乐分段 <b>{musicVideoResult.evidence.musicSegmentCount}</b></span>
                <span>视频场景 <b>{musicVideoResult.evidence.videoSceneCount}</b></span>
                <span>候选匹配 <b>{musicVideoResult.evidence.candidateMatchCount}</b></span>
                <span>已选匹配 <b>{musicVideoResult.evidence.selectedMatchCount}</b></span>
                <span>未匹配 <b>{musicVideoResult.evidence.unmatchedMusicSegmentIds.length}</b></span>
                <span>保护冲突 <b>{musicVideoResult.evidence.protectedConflicts.length}</b></span>
              </div>
              {musicVideoResult.status === "READY_FOR_REVIEW" && musicVideoResult.evidence.selectedMatches.map((match) => {
                const segment = musicVideoResult.musicSegments.find((item) => item.id === match.musicSegmentId);
                const scene = musicVideoResult.videoScenes.find((item) => item.sceneId === match.sceneId);
                const assetName = editorProject?.assets.find((asset) => asset.id === match.assetId)?.name ?? match.assetId;
                const rhythmText = match.rhythmScore === null ? "不可评估" : match.rhythmScore >= 0.75 ? "较好" : match.rhythmScore >= 0.5 ? "中等" : "较弱";
                return <article className="music-video-match" key={match.musicSegmentId}>
                  <b>{formatTimeMs(segment?.startMs ?? 0)}–{formatTimeMs(segment?.endMs ?? 0)}</b>
                  <span>歌词：{segment?.lyricText || "（分段证据）"}</span>
                  <span>建议素材：{assetName}{scene?.semanticSummary ? `，${scene.semanticSummary}` : ""}</span>
                  <small>原因：语义匹配 {match.matchedTags.join("、")}；时长{match.durationScore >= 0.8 ? "合适" : "可用"}；节奏{rhythmText}</small>
                  <small>分段证据：{segment?.semanticTags.join("、") || "无语义标签"}；{segment?.sectionKind ?? "OTHER"}；能量{segment?.energy === null || segment?.energy === undefined ? "不可评估" : segment.energy >= 0.7 ? "较高" : segment.energy >= 0.35 ? "中等" : "较低"}。场景来源：{scene?.evidenceSource === "filename-fallback" ? "文件名回退（低置信）" : "本地画面分析"}</small>
                  <small>时间来源：{segment?.evidenceSources.includes("SESSION_EVIDENCE") ? "当前字幕时间证据" : segment?.evidenceSources.includes("USER_LYRICS_DISTRIBUTED") ? "用户歌词均分估算（非精确同步）" : segment?.evidenceSources.includes("USER_TIMED") ? "用户提供时间" : segment?.evidenceSources.includes("LYRIC_TIMECODE") ? "歌词时间码" : "粗略分段"}</small>
                </article>;
              })}
              {musicVideoResult.evidence.unmatchedMusicSegmentIds.map((segmentId) => {
                const segment = musicVideoResult.musicSegments.find((item) => item.id === segmentId);
                const protectedBlocked = musicVideoResult.evidence.protectedConflicts.some((conflict) => conflict.musicSegmentId === segmentId);
                const candidates = musicVideoResult.candidateMatches.filter((candidate) => candidate.musicSegmentId === segmentId);
                const reason = protectedBlocked ? "受到保护约束限制" : candidates.some((candidate) => candidate.rejectionReason === "NO_DURATION_COMPATIBLE_SCENE") ? "没有合适时长素材" : candidates.every((candidate) => candidate.rejectionReason === "NO_SEMANTIC_EVIDENCE") ? "缺少语义匹配素材" : "证据不足";
                return <p className="music-video-unmatched" key={segmentId}>{formatTimeMs(segment?.startMs ?? 0)}–{formatTimeMs(segment?.endMs ?? 0)}，{segment?.lyricText || segmentId}：未匹配，{reason}</p>;
              })}
              {musicVideoResult.status === "NOT_EVALUABLE" && <p className="music-video-unmatched">暂不能生成建议：{musicVideoResult.reasons.join("、")}</p>}
              {musicVideoResult.evidence.protectedConflicts.length > 0 && <p className="music-video-unmatched">保护约束已排除 {musicVideoResult.evidence.protectedConflicts.length} 个冲突候选。</p>}
            </>}
          </section></details></div><div className="editor-ai-tool" hidden={aiTool!=="reference"}><section aria-label="参考视频风格" className="reference-style-panel">
            <header>
              <div>
                <b>参考视频</b>
                <span>只分析怎么剪，不复制画面、音频或字幕，也不会加入用户素材库</span>
              </div>
              <div className="reference-style-actions">
                <input
                  accept="video/mp4,video/webm,video/quicktime,video/x-m4v"
                  hidden
                  onChange={(event) => void handleReferenceVideoFile(event)}
                  ref={referenceVideoInputRef}
                  type="file"
                />
                <button disabled={referenceStyleBusy} onClick={() => referenceVideoInputRef.current?.click()} type="button">
                  {referenceStyleBusy ? "正在分析" : referenceVideoName ? "替换参考视频" : "上传参考视频"}
                </button>
                {referenceVideoName && <button className="secondary" onClick={clearReferenceVideo} type="button">移除</button>}
              </div>
            </header>
            {referenceVideoName && <p className="reference-style-file">{referenceVideoName}，仅用于分析，不会进入输出</p>}
            {referenceStyleBusy && <p className="reference-style-status" role="status">正在分析参考画面…</p>}
            {referenceStyleAnalysis?.status === "NOT_EVALUABLE" && (
              <p className="reference-style-error" role="alert">暂不可评估：{referenceStyleAnalysis.message}</p>
            )}
            {referenceStyleAnalysis?.status === "READY" && (
              <>
                <div className="reference-style-summary" role="status">
                  <span>检测镜头 <b>{referenceStyleAnalysis.profile.cutCadence.cutCount + 1}</b></span>
                  <span>硬切 <b>{referenceStyleAnalysis.profile.cutCadence.cutCount}</b></span>
                  <span>平均镜头 <b>{(referenceStyleAnalysis.profile.cutCadence.meanShotDurationMs / 1_000).toFixed(2)} 秒</b></span>
                  <span>中位镜头 <b>{(referenceStyleAnalysis.profile.cutCadence.medianShotDurationMs / 1_000).toFixed(2)} 秒</b></span>
                  <span>节奏 <b>{referenceStyleAnalysis.profile.pacing.overall}</b></span>
                </div>
                <p className="reference-style-truth">节奏来自本地画面变化测量；复杂转场和音频—切点关系暂不支持可靠评估。</p>
                <button
                  className="reference-style-generate"
                  disabled={!editorProject}
                  onClick={generateReferenceStyleProposal}
                  type="button"
                >
                  按参考风格生成剪辑建议
                </button>
              </>
            )}
            {referenceStylePlan?.status === "NOT_EVALUABLE" && (
              <p className="reference-style-error">建议暂不可生成：{referenceStylePlan.message}</p>
            )}
            {referenceStyleExecutionSummary && (
              <div className="reference-style-summary" role="status" aria-label="参考风格执行结果">
                <span>执行修改数 <b>{referenceStyleExecutionSummary.executed}</b></span>
                <span>拒绝修改数 <b>{referenceStyleExecutionSummary.rejected}</b></span>
                <span>因保护约束跳过数 <b>{referenceStyleExecutionSummary.protectedSkipped}</b></span>
                <span>风格拟合 <b>{Math.round(referenceStyleExecutionSummary.preFit * 100)} → {Math.round(referenceStyleExecutionSummary.postFit * 100)}</b></span>
                <span>剩余风格差距 <b>{Math.round((1 - referenceStyleExecutionSummary.postFit) * 100)}</b></span>
                <span>参考素材 / 音频 / 画面进入输出 <b>NO / NO / NO</b></span>
              </div>
            )}
            {referenceStylePlan?.status === "READY_FOR_REVIEW" && (
              <div className="reference-style-proposal" aria-label="参考风格剪辑建议">
                <div className="reference-style-proposal-head">
                  <b>待人工审核（未执行）</b>
                  <span>目标 {(referenceStylePlan.proposal.targetDurationMs / 1_000).toFixed(1)} 秒，风格拟合 {Math.round(referenceStylePlan.proposal.styleFit.score * 100)} / 100</span>
                </div>
                {referenceStylePlan.proposal.items.map((item) => (
                  <article className={`reference-style-item ${item.protected ? "protected" : ""}`} key={item.slotId}>
                    <b>{formatTimeMs(item.targetStartMs)}–{formatTimeMs(item.targetEndMs)}</b>
                    <span>建议镜头 {(item.desiredDurationMs / 1_000).toFixed(2)} 秒，{item.pace}</span>
                    <span>用户素材：{item.selectedAssetId ? editorProject?.assets.find((asset) => asset.id === item.selectedAssetId)?.name ?? item.selectedAssetId : "未匹配"}</span>
                    <small>{item.reasons.join("；")}</small>
                    {item.protected && <em>保护内容优先：此项不生成修改动作</em>}
                  </article>
                ))}
                {editorProposal?.proposalId === referenceStylePlan.proposal.proposalId && <p className="reference-style-review-note">请在下方逐项接受、拒绝或修改，审核后再执行。</p>}
                <p className="reference-style-review-note">
                  复用 canonical 动作 {editorProposal?.proposalId === referenceStylePlan.proposal.proposalId ? editorProposal.compiledPlan.canonicalPlan.actions.length : referenceStylePlan.proposal.canonicalPlan.actions.length} 条；reference asset/audio/frame 使用均为 NO。
                </p>
              </div>
            )}
          </section></div>{editorProject && <CreativeIntentPanel
              onConfirmGrounding={confirmCreativeIntentGrounding}
              project={editorProject}
              session={creativeIntentSession}
            />}{editorProposal && <p className="editor-proposal-status" role="status">
              {editorProposal.safeNoChangeOutcome
                ? "当前没有可安全执行的进一步修改"
                : `${editorProposalReview?.lifecycle ?? "PENDING_REVIEW"}：等待逐条人工审核`}
            </p>}{CLIP_TEST_ENABLED && editorProposal && <p className="editor-proposal-status" role="note">视觉候选均需人工确认。{editorProposal.rankedCandidateSets.some(s=>s.candidates.length>1 && Math.abs(s.candidates[0].totalScore-s.candidates[1].totalScore)<0.05) ? "多个镜头分数接近，请对照实际取样画面选择。" : "相似分数不保证医学语义正确。"}</p>}{proposalError && <p className="editor-ai-dialog-error" role="alert">{friendlyEditingError(proposalError)}</p>}{proposalError&&<details className="advanced-settings"><summary>查看详细原因</summary><p>{proposalError.status}：{proposalError.message}</p></details>}{proposalReviewError && <p className="editor-ai-dialog-error" role="alert">{proposalReviewError}</p>}<CollaborativeEditingOptionsPanel
              onSelectOption={selectCollaborativeOption}
              optionSet={collaborativeOptionSet}
              selectedOptionId={selectedCollaborativeOptionId}
            />
<PlanEvidencePanel
            constraintResolution={creativeIntentSession.resolution}
            evidence={reviewedPlanEvidence ?? editorProposal?.planEvidence ?? null}
            showDetailedScores={!musicVideoResult && !(editorProposal ?? reviewedEvidenceProposal)?.proposalId.startsWith("reference-style-proposal-v1-")}
            evaluation={editorEvaluation}
            executionBusy={proposalExecutionBusy}
            negotiationReport={creativeIntentSession.feasibilityReport}
            negotiationState={creativeIntentSession.negotiationState}
            onExecuteReviewed={executeApprovedProposal}
            onExecuteReviewedRepair={executeApprovedRepair}
            onGenerateResolvedProposal={generateProductionProposal}
            onRepairReviewDecision={handleRepairReviewDecision}
            onReviewDecision={handleProposalReviewDecision}
            onSelectConstraintResolution={selectConstraintResolution}
            proposal={editorProposal ?? reviewedEvidenceProposal}
            repairExecutionBusy={repairExecutionBusy}
            repairProposal={editorRepairProposal}
            repairResult={editorRepairResult}
            repairReview={editorRepairReview}
            review={editorProposalReview}
            staleMessage={proposalStaleMessage}
          />
<EditorDecisionExplanationPanel
            explanations={decisionExplanations}
            selectedProtectionClauseId={selectedProtectionClauseId}
          /></div></section><section className="editor-flow-stage" data-editor-stage="finish" hidden={flowStage!=="finish"} aria-labelledby="flow-finish"><header className="flow-stage-heading"><span>04</span><div><h2 id="flow-finish">精剪与导出</h2><p>检查画面、声音和字幕，再导出成片。</p></div></header><div className="flow-finish-actions">{editorProject?<button className="flow-primary" type="button" onClick={()=>setEditorOpen(true)}>打开精剪</button>:<button className="flow-primary" type="button" onClick={()=>goFlow("materials")}>先添加素材并建立时间线</button>}<small>{editorProject?"在画布预览，在时间线选择对象，在属性中调整。":"仅上传视频即可开始，声音和字幕都可稍后设置。"}</small></div><div className="flow-finish-grid"><section className="result-section" id="workflow">
        <div className="result-heading">
          <div>
            <h3>当前预览</h3>
          </div>
        </div>

        <div className="result-grid">
          <div className={`preview-frame preview-${ratio.replace(":", "")} ${previewPlaying ? "is-playing" : ""}`}>
            <div
              className="preview-stage" style={{aspectRatio:`${outputCanvasSize(ratio).width} / ${outputCanvasSize(ratio).height}`}}
              onClick={jobState === "done" ? togglePreviewPlayback : undefined}
              onKeyDown={jobState === "done" ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  togglePreviewPlayback();
                }
              } : undefined}
              role={jobState === "done" ? "button" : undefined}
              tabIndex={jobState === "done" ? 0 : undefined}
            >
              {previewAsset?.preview && !editorOpen ? (
                previewAsset.mime?.startsWith("video/") ? (
                  <video
                    key={previewAsset.id}
                    muted={!originalEnabled}
                    onCanPlay={() => setPreviewMediaError("")}
                    onError={() => {
                      setPreviewMediaError(`素材 ${previewAssetIndex + 1} 无法解码`);
                      setNotice("该视频编码无法在浏览器中播放，建议转换为 MP4（H.264 + AAC）后重新上传");
                    }}
                    onLoadedMetadata={(event) => {
                      event.currentTarget.volume = videoVolume;
                    }}
                    playsInline
                    preload="auto"
                    ref={previewVideoRef}
                    src={previewAsset.preview}
                    style={{
                      objectFit: activeMatchSegment?.transform?.fit === "contain" ? "contain" : "cover",
                      transform: clipPositionScaleCss(activeMatchSegment?.transform ?? DEFAULT_TRANSFORM)
                    }}
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt="用户上传素材预览"
                    src={previewAsset.preview}
                    style={{
                      objectFit: activeMatchSegment?.transform?.fit === "contain" ? "contain" : "cover",
                      transform: clipPositionScaleCss(activeMatchSegment?.transform ?? DEFAULT_TRANSFORM)
                    }}
                  />
                )
              ) : (
                <div className="preview-empty-state">
                  上传素材后在这里预览
                </div>
              )}
              {previewMediaError && (
                <div className="preview-media-error">
                  <VideoIcon />
                  <b>{previewMediaError}</b>
                  <span>建议使用 MP4（H.264 视频编码、AAC 音频编码）</span>
                </div>
              )}
              <div className="editor-overlay-layer preview-overlay-layer" aria-label="成片叠加层预览">
                {activeProductionOverlays.map((overlay) => (
                  <div
                    className={`editor-overlay editor-overlay-${overlay.type}`}
                    key={overlay.id}
                    style={{
                      left: `${overlay.x * 100}%`,
                      top: `${overlay.y * 100}%`,
                      width: `${overlay.width * 100}%`,
                      height: `${overlay.height * 100}%`,
                    }}
                  >
                    {overlay.type === "text" ? (
                      <span style={{ fontSize: `clamp(10px, ${overlay.fontSize / 19.2}cqi, ${overlay.fontSize}px)` }}>
                        {overlay.text}
                      </span>
                    ) : overlay.type === "arrow" ? (
                      <svg aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 100">
                        <path d={overlay.direction === "left" ? "M95 50H5M5 50l24-28M5 50l24 28" : "M5 50h90M95 50L71 22M95 50L71 78"} />
                      </svg>
                    ) : <span aria-hidden="true" />}
                  </div>
                ))}
              </div>
              <div className="preview-watermark">健康科普</div>
              {subtitle !== "不添加字幕" && (
                <EditorCaptionView aria-label="成片字幕预览" caption={jobState==="done"?activeSubtitleCue:undefined} ratio={ratio} presentation={activeSubtitlePresentation} className="preview-subtitle"/>
              )}
              {jobState === "done" && !previewPlaying && (
                <button
                  aria-label={previewElapsed >= previewDuration ? "重新播放预览" : "播放预览"}
                  className="preview-play-overlay"
                  onClick={(event) => {
                    event.stopPropagation();
                    togglePreviewPlayback();
                  }}
                  type="button"
                >
                  <Icon size={26}><path d="M8 5l10 7-10 7V5z" fill="currentColor" /></Icon>
                </button>
              )}
            </div>
            {jobState === "done" && externalEnabled && audios[previewAudioIndex]?.url && (
              <audio
                hidden
                onEnded={() => {
                  const nextIndex = previewAudioIndex + 1;
                  const nextSourceMs = Math.round(audioOffsetBefore(nextIndex) * 1000);
                  if (
                    nextIndex < audios.length
                    && nextSourceMs < audioSelection.sourceOutMs
                    && previewElapsed < Math.min(previewDuration, selectedAudioDuration) - 0.05
                  ) {
                    previewPendingSourceMsRef.current = nextSourceMs;
                    setPreviewAudioIndex((current) => current + 1);
                  } else if (audioMode === "external" && selectedAudioDuration >= previewDuration) {
                    const endAt = previewDuration;
                    previewElapsedRef.current = endAt;
                    setPreviewElapsed(endAt);
                    setPreviewPlaying(false);
                    previewVideoRef.current?.pause();
                  }
                }}
                preload="auto"
                ref={previewAudioRef}
                src={audios[previewAudioIndex].url}
              />
            )}
            {jobState === "done" && (editorProject?.secondaryAudioClips ?? []).map((clip) => (
              <audio
                data-production-secondary-audio-id={clip.id}
                hidden
                key={clip.id}
                preload="auto"
                ref={(node) => {
                  if (node) secondaryPreviewAudioRefs.current.set(clip.id, node);
                  else secondaryPreviewAudioRefs.current.delete(clip.id);
                }}
                src={secondaryAudioSources[clip.id] ?? clip.sourceUrl}
              />
            ))}
            <div className="player-bar">
              <button
                aria-label={previewPlaying ? "暂停预览" : "播放预览"}
                onClick={togglePreviewPlayback}
                type="button"
              >
                {previewPlaying ? (
                  <Icon size={16}>
                    <path d="M8 6v12M16 6v12" stroke="currentColor" strokeLinecap="round" strokeWidth="2.3" />
                  </Icon>
                ) : (
                  <Icon size={16}><path d="M8 5l10 7-10 7V5z" fill="currentColor" /></Icon>
                )}
              </button>
              <label className="player-progress">
                <i style={{ width: `${previewPercent}%` }} />
                <input
                  aria-label="预览播放进度"
                  disabled={jobState !== "done"}
                  max={previewDuration}
                  min="0"
                  onChange={(event) => seekPreview(Number(event.target.value))}
                  step="0.1"
                  type="range"
                  value={jobState === "done" ? previewElapsed : 0}
                />
              </label>
              <small>
                {jobState === "done" ? formatDuration(previewElapsed) : "00:00"} / {formatDuration(previewDuration)}
              </small>
              <span>
                {jobState === "done"
                  ? `${matchSegmentRateAt(activeMatchSegment, previewElapsed).toFixed(2)}×`
                  : "HD"}
              </span>
            </div>
          </div>

        </div>
      </section><div className="flow-output-column"><OutputCanvasSettings ratio={editorProject?.ratio ?? ratio} disabled={renderState==="rendering"} fit={editorProject?(new Set(editorProject.tracks.flatMap(t=>t.clips).map(c=>c.transform.fit)).size===1?editorProject.tracks.flatMap(t=>t.clips)[0]?.transform.fit??"mixed":"mixed"):(fillMode==="居中留黑边"?"contain":"cover")} onChange={(nextRatio,fit)=>{try{if(editorProject){const next=changeOutputCanvas(editorProject,nextRatio,fit,Boolean(activeConstraintSet));const guard=guardManualTimelineMutationV1({currentProject:editorProject,candidateProject:next,constraintSet:activeConstraintSet??undefined});if(guard.status!=="ALLOWED")throw Error("该画面调整受到保护约束限制，请核对保护范围。");handleEditorProjectChange({...next,updatedAt:new Date().toISOString()});}else{setRatio(nextRatio);if(fit)setFillMode(fit==="contain"?"居中留黑边":"自动裁切铺满");clearRenderedVideo();}}catch(e){setNotice((e as Error).message);throw e;}}}/><details className="advanced-settings flow-output-settings"><summary>成片设置</summary><div className="editor-output-settings">
          <details className="advanced-settings output-advanced">
            <summary>高级画面与字幕设置</summary>
            <div className="field">
              <label htmlFor="subtitle">字幕样式</label>
              <select id="subtitle" onChange={(event) => setSubtitle(event.target.value)} value={subtitle}>
                <option>白字黑描边</option>
                <option>白字半透明底</option>
                <option>医疗蓝重点高亮</option>
                <option>不添加字幕</option>
              </select>
              <div className="subtitle-sample">{subtitlePreview}</div>
            </div>
          </details>

          <div className="field duration-match-field">
            <label>音画时长匹配</label>
            <div className="duration-priority">
              <span className="duration-check"><CheckIcon size={15} /></span>
              <div>
                <b>{audioMode === "external" ? "以旁白音频为时长基础" : "以画面素材为时长基础"}</b>
              </div>
            </div>
            <div className="duration-mode-toggle">
              <button
                className={durationMode === "audio" ? "selected" : ""}
                onClick={() => setDurationMode("audio")}
                type="button"
              >
                {audioMode === "external" ? "完整音频" : "素材时长"}
                <small>{naturalDuration ? formatDuration(naturalDuration) : "--:--"}</small>
              </button>
              <button
                className={durationMode === "custom" ? "selected" : ""}
                onClick={() => setDurationMode("custom")}
                type="button"
              >
                自定义长度
                <small>{formatDuration(customDuration)}</small>
              </button>
            </div>
            {durationMode === "custom" && (
              <div className="custom-duration">
                <div>
                  <span>目标成片长度</span>
                  <b>{formatDuration(targetDuration)}</b>
                </div>
                <input
                  aria-label="目标成片长度"
                  max={customDurationMax}
                  min={1}
                  onChange={(event) => setCustomDuration(Number(event.target.value))}
                  step="1"
                  type="range"
                  value={Math.min(customDuration, customDurationMax)}
                />
                <div className="duration-presets">
                  {[30, 60, 90].map((seconds) => (
                    <button
                      disabled={naturalDuration > 0 && seconds > naturalDuration}
                      key={seconds}
                      onClick={() => setCustomDuration(seconds)}
                      type="button"
                    >
                      {seconds} 秒
                    </button>
                  ))}
                </div>
                <small>{audioMode === "external" ? "视频长度与音频区间相互独立。" : "初始时间线的长度不会超过已上传的画面素材。"}</small>
              </div>
            )}
          </div>
          </div></details><section className="panel preview-generate-step flow-card"><div className="compact-project-summary">
            <span>{targetDuration ? formatDuration(targetDuration) : "等待素材"}</span>
            <span>{audioModes[audioMode]}</span>
            <span>{subtitleCues.length} 句字幕</span>
            <span>{outputCanvasSize(ratio).width}×{outputCanvasSize(ratio).height}</span>
          </div><div className={`final-output-card ${renderState}`}>
            <div className="final-output-heading">
              <div>
                <span className="output-icon"><VideoIcon size={22} /></span>
                <div>
                  <b>导出视频</b>
                  <span>
                    使用 {uploadedPreviewAssets.length} 项上传素材，{audioModes[audioMode]}，{formatDuration(jobState === "done" ? previewDuration : targetDuration)}
                  </span>
                </div>
              </div>
              <span className={`output-status ${renderState}`}>
                {renderState === "rendering"
                  ? `合成中 ${renderProgress}%`
                  : renderState === "ready"
                    ? "成片已生成"
                    : renderState === "error"
                      ? "生成失败"
                      : jobState === "done"
                        ? "可以生成"
                        : "等待预览"}
              </span>
            </div>

            {renderState === "rendering" ? (
              <div className="rendering-output">
                <div className="render-progress"><i style={{ width: `${renderProgress}%` }} /></div>
                <div>
                  <span>正在逐帧合成画面、声音和字幕；浏览器端生成速度接近成片时长。</span>
                  <button
                    onClick={() => {
                      renderCancelRef.current = true;
                    }}
                    type="button"
                  >
                    取消生成
                  </button>
                </div>
              </div>
            ) : renderState === "ready" && renderedVideoUrl ? (
              <div className="rendered-output">
                <video controls playsInline src={renderedVideoUrl} />
                <div>
                  <span>完整成片，WebM，{renderedVideoSize}，{formatDuration(previewDuration)}</span>
                  <div className="rendered-output-actions">
                    
                    <a download={`医学科普成片-${Date.now()}.webm`} href={renderedVideoUrl}>下载完整视频</a>
                  </div>
                </div>
              </div>
            ) : (
              <div className="output-ready-row">
                <div>
                  <b>{renderState === "error" ? renderError : "将在当前浏览器中合成真实视频"}</b>
                  <span>
                    {renderState === "error"
                      ? "请按提示调整素材格式后重试。"
                      : "画面只来自您上传的视频和图片；按当前音频模式、字幕和时间线生成成片。"}
                  </span>
                </div>
                <div className="output-action-buttons">
                  <button
                    disabled={jobState !== "done" || !uploadedPreviewAssets.length || (audioMode === "external" && !audios.some((audio) => audio.url))}
                    onClick={() => void generateCompleteVideo()}
                    type="button"
                  >
                    {renderState === "error" ? "重新导出视频" : "导出视频"}
                  </button>
                </div>
              </div>
            )}
          </div></section><details className="advanced-settings"><summary>重新建立时间线</summary><p>会按当前素材重新排列画面；现有字幕时间码保留，请先确认。</p><button type="button" className="flow-secondary" disabled={!canGenerate||startingJob||Boolean(activeConstraintSet)} onClick={()=>void startJob(true)}>按当前素材重新建立</button>{activeConstraintSet&&<small>当前有保护内容，请先在精剪中调整。</small>}</details></div></div></section></section>

      {requirementDialogOpen && (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRequirementDialogOpen(false);
          }}
        >
          <section aria-labelledby="requirement-title" aria-modal="true" className="requirement-dialog" role="dialog">
            <div className="dialog-heading">
              <div>
                <span className="eyebrow">自定义剪辑</span>
                <h2 id="requirement-title">告诉我们如何组合视频和音频</h2>
                <p>使用左侧编号描述要求，系统会按规则安排镜头、音频和字幕。</p>
              </div>
              <button aria-label="关闭需求对话框" onClick={() => setRequirementDialogOpen(false)} type="button">×</button>
            </div>

            <div className="dialog-content">
              <div className="material-index">
                <div>
                  <b>视频与图片</b>
                  <span>{assets.length} 项素材</span>
                </div>
                <div className="index-list">
                  {assets.length ? assets.map((asset, index) => (
                    <span key={asset.id}><i>素材 {index + 1}</i>{asset.name}</span>
                  )) : <small>请先上传视频或图片</small>}
                </div>
                <div>
                  <b>旁白音频</b>
                  <span>{audios.length} 段音频</span>
                </div>
                <div className="index-list">
                  {audios.length ? audios.map((audio, index) => (
                    <span key={audio.id}><i>音频 {index + 1}</i>{audio.name}</span>
                  )) : <small>请先上传旁白音频</small>}
                </div>
              </div>

              <div className="requirement-editor">
                <label htmlFor="requirement-text">具体剪辑要求</label>
                <textarea
                  id="requirement-text"
                  onChange={(event) => {
                    const next = event.target.value;
                    setRequirementDraft(next);
                    if (creativeIntentSession.intent && next.trim() !== creativeIntentSession.sourceRequest) {
                      invalidateCreativeIntent(next.trim(), "原始要求已修改，请重新分析创作意图并确认保护范围。");
                    }
                  }}
                  placeholder={"例如：\n1. 素材 1 使用音频 1，从开头开始。\n2. 素材 2 使用音频 2，速度稍慢。\n3. 音频提到“检查结果”时显示素材 3。\n4. 结尾保留 3 秒，并显示健康提示。"}
                  rows={10}
                  value={requirementDraft}
                />
                {!editorProject && <p className="editor-ai-dialog-hint">请先建立时间线，再生成待审核的剪辑建议。</p>}
                {editorProject && !selectedAIProvider && <p className="editor-ai-dialog-hint">请先在页面顶部选择已连接的 AI 服务。</p>}
                {requirementsReviewPanel}
                <div className="example-requirements">
                  <span>快速添加：</span>
                  {[
                    "素材 1 使用音频 1",
                    "每段音频之间淡入淡出",
                    "重点语句使用医疗蓝字幕",
                    "结尾保留 3 秒"
                  ].map((example) => (
                    <button
                      key={example}
                      onClick={() => setRequirementDraft((current) => {
                        const next = `${current}${current.trim() ? "\n" : ""}${example}。`;
                        if (creativeIntentSession.intent && next.trim() !== creativeIntentSession.sourceRequest) {
                          invalidateCreativeIntent(next.trim(), "原始要求已修改，请重新分析创作意图并确认保护范围。");
                        }
                        return next;
                      })}
                      type="button"
                    >
                      ＋ {example}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="dialog-actions">
              <button
                className="secondary"
                onClick={() => {
                  setRequirementDraft("");
                  setRequirements("");
                  setRequirementsReview(null);
                  setEditorAIApplyResult(null);
                  setEditorAITaskError(null);
                  invalidateCreativeIntent("", "原始要求已清除，请重新分析创作意图。");
                }}
                type="button"
              >
                清除需求
              </button>
              <div>
                <button className="secondary" onClick={() => setRequirementDialogOpen(false)} type="button">取消</button>
                <button
                  className="primary ai-apply-button"
                  disabled={editorAITaskBusy || !selectedAIProvider || !editorProject || !requirementDraft.trim()}
                  onClick={() => void runEditorTextTask()}
                  type="button"
                >
                  {editorAITaskBusy ? "正在生成建议…" : "解析剪辑需求"}
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    setRequirements(requirementDraft.trim());
                    setRequirementDialogOpen(false);
                    setJobState("idle");
                    setProgress(0);
                    setNotice("剪辑需求已保存");
                  }}
                  type="button"
                >
                  保存需求
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      

      {editorProject && (
        <TimelineEditor
          visible={editorOpen}
          outputSettingsDisabled={renderState==="rendering"}
          audioMode={audioMode}
          activeConstraintSet={activeConstraintSet ?? undefined}
          creativeIntent={creativeIntentSession.intent}
          confirmedBindings={creativeIntentSession.confirmedBindings}
          assets={assets}
          initialUndoProjects={editorAIUndoProjects}
          getPreviewTime={() => {
            const audio = previewAudioRef.current;
            if (!audio || audio.ended || audio.paused) return undefined;
            const position = audioOffsetBefore(previewAudioIndex) + audio.currentTime;
            if (position >= audioSelection.sourceOutMs / 1000) {
              audio.pause();
              return undefined;
            }
            return audioMode === "external" ? Math.max(0, position - audioSelection.sourceInMs / 1000) : undefined;
          }}
          onClose={() => {
            setEditorOpen(false);
            setPreviewPlaying(false);
            previewAudioRef.current?.pause();
          }}
          videoVolume={videoVolume}
          secondaryAudioMuted={audioMode === "silent"}
          onPreviewTimeChange={handleEditorPreviewTimeChange}
          onInitialUndoConsumed={() => setEditorAIUndoProject(null)}
          onImportSecondaryAudio={importSecondaryAudio}
          onDownloadSubtitles={downloadSubtitleFile}
          onProjectChange={handleEditorProjectChange}
          onConstraintBlocked={(message) => setNotice(message)}
          onConstraintBlockedResult={setBlockedExplanationResult}
          onProtectionAnnotationSelect={(annotation: ProtectedTimelineAnnotationV1) => setSelectedProtectionClauseId(annotation.sourceClauseId)}
          onRender={() => {setEditorOpen(false);goFlow("finish");}}
          project={editorProject}
          renderLabel="前往导出"
          secondaryAudioSources={secondaryAudioSources}
        />
      )}

      {notice && <div className="toast"><CheckIcon /> {notice}</div>}
    </main>
  );
}

