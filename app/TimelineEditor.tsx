"use client";
import {OutputCanvasSettings} from "./OutputCanvasSettings";
import {changeOutputCanvas,outputCanvasSize} from "./editor-output-settings";

import {EditorCaptionView} from "./editor-caption-view";
import {appendOwnedVisualAsset} from "./editor-workflow.ts";
import type { LocalMediaIdentity } from "./editor-local-media.ts";

import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  SPEED_PRESETS,
  applyClipSpeedCurve,
  applyClipPositionScaleToProject,
  averageSpeed,
  clamp,
  clipPositionScaleCss,
  cloneProject,
  collectTimelineSnapTargets,
  cropAndRebaseCaptions,
  editorProjectDurationMs,
  formatTimeMs,
  normalizeSpeedCurve,
  reorderTimelineClip,
  recordProjectUndoSnapshot,
  snapTimelineMs,
  splitTimelineClip,
  sourceTimeAtTimelineMs,
  remapVideoCaptions,
  speedAt,
  speedCurveForTimelineDuration,
  timelineDurationBoundsForSource,
  timelineDurationForSource,
  type EditorProject,
  type SpeedPoint,
  type TimelineCaption,
  type TimelineClip
} from "./editor-core";
import {
  createOverlay,
  overlaysVisibleAt,
  patchOverlay,
  type EditorOverlay,
  type EditorOverlayType,
} from "./editor-overlays";
import {
  MIN_SECONDARY_AUDIO_DURATION_MS,
  createSecondaryAudioClip,
  patchSecondaryAudioClip,
  secondaryAudioDurationMs,
  secondaryAudioEndMs,
  secondaryAudioGainAt,
  type SecondaryAudioClip,
  type SecondaryAudioSourceType,
} from "./editor-secondary-audio";
import {
  applyCaptionPresentationToAll,
  captionPresentation,
  activeCaptionAt,
  captionTimelineHasOverlap,
  mergeAdjacentCaptions,
  parseSubtitleFile,
  patchCaption,
  splitCaption,
} from "./editor-captions";
import type { ConstraintSetV1 } from "./editor-constraints";
import type { CandidateBindingRecordV1, ConfirmedBindingRecordV1 } from "./editor-constraint-grounding";
import type { CreativeIntentV1 } from "./editor-creative-intent";
import { deriveProtectedTimelineAnnotationsV1 } from "./editor-protected-timeline";
import type { ProtectedTimelineAnnotationV1 } from "./editor-protected-timeline";
import type { ConstraintEnforcementResultV1 } from "./editor-constraint-enforcement";
import {
  constraintEnforcementMessageZh,
  type ConstraintCandidateActionV1,
} from "./editor-constraint-enforcement";
import { guardManualTimelineMutationV1 } from "./editor-manual-constraint-guard";

export type EditorMediaAsset = {
  id: string;
  name: string;
  kind: "视频" | "图片";
  duration?: number;
  preview?: string;
  mime?: string;
  mediaIdentity?: LocalMediaIdentity;
};

type Selection = { kind: "clip" | "caption" | "overlay" | "secondary-audio"; id: string } | null;

type DragFeedback = {
  label: string;
  timeMs: number;
  durationMs?: number;
  rate?: number;
};

type Props = {
  visible?:boolean;
  audioMode: "original" | "external" | "mix" | "silent";
  project: EditorProject;
  initialUndoProject?: EditorProject | null;
  initialUndoProjects?: readonly EditorProject[];
  assets: EditorMediaAsset[];
  getPreviewTime: () => number | undefined;
  onClose: () => void;
  onProjectChange: (project: EditorProject) => void;
  onDownloadSubtitles: (cues: TimelineCaption[]) => void;
  onPreviewTimeChange: (seconds: number, playing: boolean) => void;
  onInitialUndoConsumed?: () => void;
  onRender: () => void;
  renderLabel: string;
  outputSettingsDisabled?: boolean;
  activeConstraintSet?: ConstraintSetV1;
  creativeIntent?: CreativeIntentV1 | null;
  confirmedBindings?: readonly ConfirmedBindingRecordV1[];
  candidateBindings?: readonly CandidateBindingRecordV1[];
  onConstraintBlocked?: (message: string) => void;
  onConstraintBlockedResult?: (result: ConstraintEnforcementResultV1) => void;
  onProtectionAnnotationSelect?: (annotation: ProtectedTimelineAnnotationV1) => void;
  secondaryAudioSources?: Readonly<Record<string, string>>;
  videoVolume?: number;
  secondaryAudioMuted?: boolean;
  onImportSecondaryAudio?: (
    clipId: string,
    file: File,
    sourceType: SecondaryAudioSourceType,
  ) => Promise<Readonly<{ sourceUrl: string; sourceDurationMs: number }>>;
};

function cloneSpeedPreset(points: SpeedPoint[]) {
  return points.map((point) => ({ ...point, id: crypto.randomUUID() }));
}

function formatDragTime(valueMs: number) {
  return formatTimeMs(valueMs).replace(/\.(\d{2})\d$/, ".$1");
}

function projectContentEndMs(project: EditorProject) {
  const clipEnd = project.tracks.flatMap((track) => track.clips)
    .reduce((max, clip) => Math.max(max, clip.timelineEndMs), 0);
  const captionEnd = project.captions.reduce((max, caption) => Math.max(max, caption.endMs), 0);
  const overlayEnd = (project.overlays ?? []).reduce((max, overlay) => Math.max(max, overlay.endMs), 0);
  const secondaryAudioEnd = (project.secondaryAudioClips ?? [])
    .reduce((max, clip) => Math.max(max, secondaryAudioEndMs(clip)), 0);
  return Math.max(1_000, clipEnd, captionEnd, overlayEnd, secondaryAudioEnd);
}

function durationAfterSpeedChange(
  previous: EditorProject,
  next: EditorProject,
  audioMode: Props["audioMode"],
) {
  const independentAudioMode = audioMode === "external" || audioMode === "mix";
  const previousContentEnd = projectContentEndMs(previous);
  const nextContentEnd = projectContentEndMs(next);
  const previousBlankTail = Math.max(0, previous.durationMs - previousContentEnd);
  const selectedAudioMatchesProjectDuration = Math.abs(
    previous.audioSelection.selectedDurationMs - previous.durationMs,
  ) <= 50;
  // Preserve a manually established blank tail. A duration that merely mirrors
  // the audio selection in original/silent mode is stale and should not outlive
  // the shortened picture after a speed edit.
  const preserveExplicitBlankTail = previousBlankTail > 50
    && !selectedAudioMatchesProjectDuration;
  const explicitTail = preserveExplicitBlankTail ? previousBlankTail : 0;
  const audioDuration = independentAudioMode
    ? Math.max(previous.durationMs, next.audioSelection.selectedDurationMs)
    : 0;
  return Math.max(1_000, nextContentEnd + explicitTail, audioDuration);
}

export default function TimelineEditor({
  visible=true,
  audioMode,
  project,
  initialUndoProject,
  initialUndoProjects = [],
  assets,
  getPreviewTime,
  onClose,
  onProjectChange,
  onDownloadSubtitles,
  onPreviewTimeChange,
  onInitialUndoConsumed,
  onRender,
  renderLabel,
  outputSettingsDisabled=false,
  activeConstraintSet,
  creativeIntent,
  confirmedBindings,
  candidateBindings,
  onConstraintBlocked,
  onConstraintBlockedResult,
  onProtectionAnnotationSelect,
  secondaryAudioSources = {},
  videoVolume = 0,
  secondaryAudioMuted = false,
  onImportSecondaryAudio,
}: Props) {
  const [draft, setDraft] = useState(() => cloneProject(project));
  const [selection, setSelection] = useState<Selection>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mobilePane,setMobilePane]=useState<"library"|"preview"|"properties">("preview");
  const [zoom, setZoom] = useState(76);
  const [snapping, setSnapping] = useState(true);
  const [savedAt, setSavedAt] = useState(project.updatedAt);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [dragFeedback, setDragFeedback] = useState<DragFeedback | null>(null);
  const [dragging, setDragging] = useState(false);
  const [blockedAnnotationId, setBlockedAnnotationId] = useState<string | null>(null);
  const [detailAnnotationId, setDetailAnnotationId] = useState<string | null>(null);
  const [secondaryAudioSourceType, setSecondaryAudioSourceType] = useState<SecondaryAudioSourceType>("sound-effect");
  const [secondaryAudioError, setSecondaryAudioError] = useState("");
  const [subtitleImportMode, setSubtitleImportMode] = useState<"replace" | "append">("replace");
  const [subtitleImportError, setSubtitleImportError] = useState("");
  const historyRef = useRef<EditorProject[]>([]);
  const futureRef = useRef<EditorProject[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playingClipRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const secondaryAudioInputRef = useRef<HTMLInputElement>(null);
  const subtitleImportInputRef = useRef<HTMLInputElement>(null);
  const secondaryAudioElementsRef = useRef(new Map<string, HTMLAudioElement>());
  const timelineContentRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft);
  const getPreviewTimeRef = useRef(getPreviewTime);
  const onPreviewTimeChangeRef = useRef(onPreviewTimeChange);
  const playheadRef = useRef(playheadMs);
  const suppressClickRef = useRef(false);
  const consumedInitialUndoRef = useRef<EditorProject | null>(null);
  const consumedInitialUndoProjectsRef = useRef(new WeakSet<EditorProject>());
  const overlayTextEditBaseRef = useRef<EditorProject | null>(null);
  const secondaryAudioPropertyBaseRef = useRef<EditorProject | null>(null);
  const captionPropertyBaseRef = useRef<EditorProject | null>(null);

  useEffect(()=>{
    if(!visible){setPlaying(false);videoRef.current?.pause();secondaryAudioElementsRef.current.forEach(a=>a.pause());}
  },[visible]);
  useEffect(()=>{
    const pending=(initialUndoProject&&consumedInitialUndoRef.current!==initialUndoProject)||initialUndoProjects.some(p=>!consumedInitialUndoProjectsRef.current.has(p));
    if(pending||JSON.stringify(project)===JSON.stringify(draftRef.current))return;
    if(project.id!==draftRef.current.id){historyRef.current=[];futureRef.current=[];setSelection(null);}
    else {historyRef.current=recordProjectUndoSnapshot(historyRef.current,draftRef.current);futureRef.current=[];}
    const incoming=cloneProject(project);draftRef.current=incoming;setDraft(incoming);setSavedAt(incoming.updatedAt);setHistoryVersion(v=>v+1);
  },[project,initialUndoProject,initialUndoProjects]);
  useEffect(()=>{if(selection)setMobilePane("properties");},[selection]);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (!initialUndoProject || consumedInitialUndoRef.current === initialUndoProject) return;
    consumedInitialUndoRef.current = initialUndoProject;
    historyRef.current = recordProjectUndoSnapshot(historyRef.current, initialUndoProject);
    futureRef.current = [];
    const incoming = cloneProject(project);
    draftRef.current = incoming;
    setDraft(incoming);
    setSavedAt(incoming.updatedAt);
    setHistoryVersion((value) => value + 1);
    onInitialUndoConsumed?.();
  }, [initialUndoProject, onInitialUndoConsumed, project]);

  useEffect(() => {
    const pending = initialUndoProjects.filter((snapshot) => !consumedInitialUndoProjectsRef.current.has(snapshot));
    if (!pending.length) return;
    pending.forEach((snapshot) => {
      consumedInitialUndoProjectsRef.current.add(snapshot);
      historyRef.current = recordProjectUndoSnapshot(historyRef.current, snapshot);
    });
    futureRef.current = [];
    const incoming = cloneProject(project);
    draftRef.current = incoming;
    setDraft(incoming);
    setSavedAt(incoming.updatedAt);
    setHistoryVersion((value) => value + 1);
    onInitialUndoConsumed?.();
  }, [initialUndoProjects, onInitialUndoConsumed, project]);

  useEffect(() => {
    playheadRef.current = playheadMs;
  }, [playheadMs]);

  useEffect(() => {
    getPreviewTimeRef.current = getPreviewTime;
    onPreviewTimeChangeRef.current = onPreviewTimeChange;
  }, [getPreviewTime, onPreviewTimeChange]);

  const allowManualCandidate = (current: EditorProject, next: EditorProject, action?: ConstraintCandidateActionV1) => {
    const result = guardManualTimelineMutationV1({
      currentProject: current,
      candidateProject: next,
      constraintSet: activeConstraintSet,
      action,
    });
    if (result.status === "ALLOWED") { setBlockedAnnotationId(null); return true; }
    const violation = result.violations[0];
    const annotation = violation && protectionAnnotations.find((item) => item.constraintId === violation.constraintId);
    setBlockedAnnotationId(annotation?.annotationId ?? null);
    onConstraintBlockedResult?.(result);
    onConstraintBlocked?.(annotation
      ? `无法编辑：该片段属于「${annotation.label}」保护区域。${constraintEnforcementMessageZh(result)}`
      : constraintEnforcementMessageZh(result));
    return false;
  };

  const commit = (next: EditorProject, record = true, action?: ConstraintCandidateActionV1, preserveDuration = false) => {
    next = remapVideoCaptions(draftRef.current, next, action?.type === "SPLIT_CLIP" ? action.targetId : undefined);
    if (!allowManualCandidate(draftRef.current, next, action)) return false;
    const normalized = {
      ...next,
      durationMs: preserveDuration ? next.durationMs : action?.type === "SET_CLIP_PLAYBACK_SPEED"
        ? durationAfterSpeedChange(draftRef.current, next, audioMode)
        : editorProjectDurationMs(next),
      updatedAt: new Date().toISOString()
    };
    if (record) {
      historyRef.current = recordProjectUndoSnapshot(historyRef.current, draftRef.current);
      futureRef.current = [];
      setHistoryVersion((value) => value + 1);
    }
    draftRef.current = normalized;
    setDraft(normalized);
    setSavedAt(normalized.updatedAt);
    onProjectChange(normalized);
    return true;
  };

  const undo = () => {
    const previous = historyRef.current.pop();
    if (!previous) return;
    if (!allowManualCandidate(draftRef.current, previous)) {
      historyRef.current.push(previous);
      return;
    }
    futureRef.current.push(cloneProject(draftRef.current));
    draftRef.current = previous;
    setDraft(previous);
    onProjectChange(previous);
    setHistoryVersion((value) => value + 1);
  };

  const redo = () => {
    const next = futureRef.current.pop();
    if (!next) return;
    if (!allowManualCandidate(draftRef.current, next)) {
      futureRef.current.push(next);
      return;
    }
    historyRef.current.push(cloneProject(draftRef.current));
    draftRef.current = next;
    setDraft(next);
    onProjectChange(next);
    setHistoryVersion((value) => value + 1);
  };

  const durationMs = editorProjectDurationMs(draft);
  const timelineWidth = Math.max(920, Math.ceil((durationMs / 1000) * zoom));
  const protectionAnnotations = useMemo(() => deriveProtectedTimelineAnnotationsV1({
    project: draft, intent: creativeIntent, constraintSet: activeConstraintSet,
    confirmedBindings, candidateBindings,
  }), [draft, creativeIntent, activeConstraintSet, confirmedBindings, candidateBindings]);
  const protectionLayout = useMemo(() => {
    const lanes: { start: number; end: number }[][] = [];
    const laneById = new Map<string, number>();
    for (const annotation of protectionAnnotations) {
      const hasRange = annotation.timelineEnd > annotation.timelineStart;
      const start = hasRange ? annotation.timelineStart : -1;
      const end = hasRange ? annotation.timelineEnd : 0;
      let lane = lanes.findIndex((items) => items.every((item) => end <= item.start || start >= item.end));
      if (lane < 0) { lane = lanes.length; lanes.push([]); }
      lanes[lane].push({ start, end });
      laneById.set(annotation.annotationId, lane);
    }
    return { laneById, height: Math.max(28, lanes.length * 22 + 4) };
  }, [protectionAnnotations]);
  const allClips = draft.tracks.flatMap((track) => track.clips);
  const selectedClip = selection?.kind === "clip"
    ? allClips.find((clip) => clip.id === selection.id)
    : undefined;
  const selectedCaption = selection?.kind === "caption"
    ? draft.captions.find((caption) => caption.id === selection.id)
    : undefined;
  const selectedOverlay = selection?.kind === "overlay"
    ? (draft.overlays ?? []).find((overlay) => overlay.id === selection.id)
    : undefined;
  const selectedSecondaryAudio = selection?.kind === "secondary-audio"
    ? (draft.secondaryAudioClips ?? []).find((clip) => clip.id === selection.id)
    : undefined;
  const selectedCaptionIndex = selectedCaption
    ? draft.captions.findIndex((caption) => caption.id === selectedCaption.id)
    : -1;
  const followingCaption = selectedCaptionIndex >= 0 ? draft.captions[selectedCaptionIndex + 1] : undefined;
  const canMergeCaption = Boolean(
    selectedCaption
    && followingCaption
    && followingCaption.startMs >= selectedCaption.endMs
    && followingCaption.startMs - selectedCaption.endMs <= 1_000
  );
  const selectedCaptionPresentation = selectedCaption ? captionPresentation(selectedCaption) : null;

  const activeClip = useMemo(() => {
    const candidates = draft.tracks
      .filter((track) => track.type === "video" || track.type === "broll")
      .flatMap((track) => track.clips)
      .filter((clip) => playheadMs >= clip.timelineStartMs && playheadMs < clip.timelineEndMs);
    return candidates.at(-1) ?? null;
  }, [draft.tracks, playheadMs]);
  const activeAsset = activeClip
    ? assets.find((asset) => asset.id === activeClip.assetId)
    : undefined;
  const activeCaption = activeCaptionAt(draft.captions,playheadMs);
  const activeCaptionPresentation = activeCaption ? captionPresentation(activeCaption) : null;
  const activeOverlays = overlaysVisibleAt(draft.overlays, playheadMs);
  const activeRate = activeClip
    ? speedAt(
        activeClip.speedCurve,
        (playheadMs - activeClip.timelineStartMs)
          / Math.max(10, activeClip.timelineEndMs - activeClip.timelineStartMs)
      )
    : 1;

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let lastPaint = 0;
    let frame = 0;
    const advance = (now: number) => {
      const delta = now - last;
      last = now;
      const masterSeconds = getPreviewTimeRef.current();
      const next = Math.min(
        durationMs,
        masterSeconds === undefined
          ? playheadRef.current + delta
          : Math.max(0, masterSeconds * 1000)
      );
      playheadRef.current = next;
      if (now - lastPaint >= 32 || next >= durationMs) {
        lastPaint = now;
        setPlayheadMs(next);
      }
      if (next >= durationMs) {
        setPlaying(false);
        onPreviewTimeChangeRef.current(next / 1000, false);
        return;
      }
      frame = window.requestAnimationFrame(advance);
    };
    frame = window.requestAnimationFrame(advance);
    return () => window.cancelAnimationFrame(frame);
  }, [durationMs, playing]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip || !activeAsset?.preview || activeAsset.kind !== "视频") return;
    const sourceTime = sourceTimeAtTimelineMs(activeClip, playheadMs) / 1000;
    const driftThreshold = playing ? 0.10 : 0.02;
    video.volume = videoVolume;
    const clipChanged = playingClipRef.current !== activeClip.id;
    if (Math.abs(video.currentTime - sourceTime) > (clipChanged ? 0.04 : driftThreshold)) video.currentTime = sourceTime;
    playingClipRef.current = activeClip.id;
    const nextRate = clamp(activeRate, 0.25, 4);
    if (Math.abs(video.playbackRate - nextRate) > 0.02) video.playbackRate = nextRate;
    if (playing) {
      if (video.paused) void video.play().catch(() => setPlaying(false));
    } else {
      if (!video.paused) video.pause();
    }
  }, [activeAsset?.id, activeAsset?.kind, activeAsset?.preview, activeClip, activeRate, playheadMs, playing, videoVolume]);

  useEffect(() => {
    const clips = draft.secondaryAudioClips ?? [];
    const activeIds = new Set(clips.map((clip) => clip.id));
    for (const [clipId, audio] of secondaryAudioElementsRef.current) {
      const clip = clips.find((item) => item.id === clipId);
      if (secondaryAudioMuted || !clip || !activeIds.has(clipId)) {
        audio.pause();
        continue;
      }
      const active = playheadMs >= clip.timelineStartMs && playheadMs < secondaryAudioEndMs(clip);
      if (!active) {
        audio.pause();
        continue;
      }
      const expectedSeconds = (clip.sourceStartMs + playheadMs - clip.timelineStartMs) / 1_000;
      const driftThreshold = playing ? 0.2 : 0.025;
      if (Number.isFinite(audio.duration) && Math.abs(audio.currentTime - expectedSeconds) > driftThreshold) {
        audio.currentTime = Math.min(expectedSeconds, Math.max(0, audio.duration - 0.01));
      }
      audio.volume = secondaryAudioGainAt(clip, playheadMs);
      if (playing) {
        if (audio.paused) void audio.play().catch(() => setSecondaryAudioError("浏览器阻止了辅助音频预览，请再次点击播放。"));
      } else if (!audio.paused) {
        audio.pause();
      }
    }
  }, [draft.secondaryAudioClips, playheadMs, playing, secondaryAudioMuted, secondaryAudioSources]);

  useEffect(() => () => {
    for (const audio of secondaryAudioElementsRef.current.values()) audio.pause();
    secondaryAudioElementsRef.current.clear();
  }, []);

  const seek = (nextMs: number, shouldPlay = playing) => {
    const value = clamp(nextMs, 0, durationMs);
    playheadRef.current = value;
    setPlayheadMs(value);
    onPreviewTimeChange(value / 1000, shouldPlay);
  };

  const togglePlayback = () => {
    if (playing) {
      setPlaying(false);
      onPreviewTimeChange(playheadMs / 1000, false);
      return;
    }
    const next = playheadMs >= durationMs ? 0 : playheadMs;
    seek(next, true);
    setPlaying(true);
  };

  const addLibraryAsset=(assetId:string)=>{
    try{
      const owned=assets.filter(a=>a.preview).map(a=>({id:a.id,name:a.name,kind:a.kind,durationMs:Math.max(1,Math.round((a.duration??4)*1000)),...(a.mediaIdentity ? { mediaIdentity: a.mediaIdentity } : {})}));
      const id=crypto.randomUUID(),next=appendOwnedVisualAsset(draftRef.current,owned,assetId,id);
      if(commit(next,true)){setSelection({kind:"clip",id});const c=next.tracks.flatMap(t=>t.clips).find(c=>c.id===id)!;seek(c.timelineStartMs,false);}
    }catch(error){onConstraintBlocked?.(error instanceof Error?error.message:"无法添加该素材。");}
  };

  const replaceClip = (clipId: string, assetId: string) => {
    const asset = assets.find((item) => item.id === assetId);
    if (!asset?.preview) return;
    const next = cloneProject(draftRef.current);
    next.tracks.forEach((track) => {
      track.clips = track.clips.map((clip) => {
        if (clip.id !== clipId) return clip;
        const sourceDuration = Math.max(100, Math.round((asset.duration ?? 4) * 1000));
        const sourceOutMs = Math.min(sourceDuration, clip.sourceInMs + Math.max(100, clip.sourceOutMs - clip.sourceInMs));
        const timelineDuration = Math.max(100, clip.timelineEndMs - clip.timelineStartMs);
        return {
          ...clip,
          assetId: asset.id,
          name: asset.name,
          kind: asset.kind,
          sourceInMs: Math.min(clip.sourceInMs, Math.max(0, sourceOutMs - 100)),
          sourceOutMs,
          speedCurve: asset.kind === "视频"
            ? speedCurveForTimelineDuration(
                Math.max(100, sourceOutMs - Math.min(clip.sourceInMs, Math.max(0, sourceOutMs - 100))),
                timelineDuration
              )
            : clip.speedCurve
        };
      });
    });
    const registry = new Map(next.assets.map(item => [item.id, item]));
    registry.set(asset.id, { id: asset.id, name: asset.name, kind: asset.kind,
      durationMs: Math.round((asset.duration ?? 4) * 1000),
      ...(asset.mediaIdentity ? { mediaIdentity: asset.mediaIdentity } : {}) });
    next.assets = [...registry.values()];
    commit(next, true, { type: "MATCH_ASSET_TO_SEGMENT", targetId: clipId, assetId });
  };

  const updateClip = (clipId: string, patch: Partial<TimelineClip>, record = true) => {
    const next = cloneProject(draftRef.current);
    next.tracks.forEach((track) => {
      track.clips = track.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip);
    });
    commit(next, record);
  };

  const updateClipPositionScale = (
    clipId: string,
    patch: Partial<{ x: number; y: number; scale: number }>,
  ) => {
    const current = draftRef.current;
    const clip = current.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
    if (!clip) return;
    const positionScale = {
      x: patch.x ?? clip.transform.x,
      y: patch.y ?? clip.transform.y,
      scale: patch.scale ?? clip.transform.scale,
    };
    if (!Object.values(positionScale).every(Number.isFinite)) return;
    const next = applyClipPositionScaleToProject(current, clipId, positionScale);
    if (next === current) return;
    commit(next, true, { type: "SET_CLIP_POSITION_SCALE", targetId: clipId, x: positionScale.x, y: positionScale.y, scale: positionScale.scale });
  };

  const updateClipTimelineBoundary = (
    clipId: string,
    boundary: "start" | "end",
    valueMs: number
  ) => {
    const next = cloneProject(draftRef.current);
    next.tracks.forEach((track) => {
      track.clips = track.clips.map((clip) => {
        if (clip.id !== clipId) return clip;
        const requested = Math.max(0, Math.round(valueMs));
        if (clip.kind !== "视频") {
          return boundary === "start"
            ? { ...clip, timelineStartMs: clamp(requested, 0, clip.timelineEndMs - 100) }
            : { ...clip, timelineEndMs: Math.max(clip.timelineStartMs + 100, requested) };
        }
        const sourceDuration = Math.max(100, clip.sourceOutMs - clip.sourceInMs);
        const bounds = timelineDurationBoundsForSource(sourceDuration);
        const timelineStartMs = boundary === "start"
          ? clamp(
              requested,
              Math.max(0, clip.timelineEndMs - bounds.maxMs),
              Math.max(0, clip.timelineEndMs - bounds.minMs)
            )
          : clip.timelineStartMs;
        const timelineEndMs = boundary === "end"
          ? clamp(
              requested,
              clip.timelineStartMs + bounds.minMs,
              clip.timelineStartMs + bounds.maxMs
            )
          : clip.timelineEndMs;
        return {
          ...clip,
          timelineStartMs,
          timelineEndMs,
          speedCurve: speedCurveForTimelineDuration(
            sourceDuration,
            timelineEndMs - timelineStartMs
          )
        };
      });
    });
    commit(next, true, { type: "SET_CLIP_PLAYBACK_SPEED", targetId: clipId });
  };

  const updateCaption = (captionId: string, patch: Partial<TimelineCaption>, record = true) => {
    const next = cloneProject(draftRef.current);
    next.captions = next.captions
      .map((caption) => caption.id === captionId ? patchCaption(caption, patch, durationMs) : caption)
      .sort((left, right) => left.startMs - right.startMs);
    commit(next, record, patch.text !== undefined
      ? { type: "SET_CAPTION_TEXT", targetId: captionId, text: patch.text }
      : undefined);
  };

  const beginCaptionPropertyEdit = () => {
    captionPropertyBaseRef.current ??= cloneProject(draftRef.current);
  };

  const finishCaptionPropertyEdit = () => {
    const base = captionPropertyBaseRef.current;
    captionPropertyBaseRef.current = null;
    if (!base || JSON.stringify(base) === JSON.stringify(draftRef.current)) return;
    historyRef.current = recordProjectUndoSnapshot(historyRef.current, base);
    futureRef.current = [];
    setHistoryVersion((value) => value + 1);
  };

  const importSubtitles = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSubtitleImportError("");
    if (!file.size) {
      setSubtitleImportError("字幕文件为空。");
      return;
    }
    try {
      const sourceDurationMs = draftRef.current.audioSelection.mode === "range"
        ? Math.max(draftRef.current.audioSelection.sourceDurationMs, durationMs)
        : durationMs;
      const parsed = parseSubtitleFile(await file.text(), file.name, sourceDurationMs).captions;
      const timelineCaptions = draftRef.current.audioSelection.mode === "range"
        ? cropAndRebaseCaptions(
            parsed,
            draftRef.current.audioSelection.sourceInMs,
            draftRef.current.audioSelection.sourceOutMs,
          )
        : parsed;
      const imported = timelineCaptions
        .filter((caption) => caption.startMs < durationMs)
        .map((caption) => patchCaption({ ...caption, id: crypto.randomUUID() }, {
          endMs: Math.min(caption.endMs, durationMs),
        }, durationMs));
      if (!imported.length) throw new Error("字幕时间不在当前项目范围内。");
      const next = cloneProject(draftRef.current);
      next.captions = subtitleImportMode === "replace"
        ? imported
        : [...next.captions, ...imported].sort((left, right) => left.startMs - right.startMs);
      if (commit(next, true)) {
        setSelection({ kind: "caption", id: imported[0].id });
        seek(imported[0].startMs, false);
      }
    } catch (error) {
      setSubtitleImportError(error instanceof Error ? error.message : "字幕导入失败。");
    }
  };

  const applySelectedCaptionPresentationToAll = () => {
    const selected = draftRef.current.captions.find((caption) => caption.id === selectedCaption?.id);
    if (!selected) return;
    const next = cloneProject(draftRef.current);
    next.captions = applyCaptionPresentationToAll(next.captions, selected);
    commit(next, true);
  };

  const addOverlay = (type: EditorOverlayType) => {
    const next = cloneProject(draftRef.current);
    const overlay = createOverlay(type, {
      id: crypto.randomUUID(),
      atMs: playheadRef.current,
      projectDurationMs: durationMs,
    });
    next.overlays = [...(next.overlays ?? []), overlay];
    if (commit(next, true)) {
      setSelection({ kind: "overlay", id: overlay.id });
      seek(overlay.startMs, false);
    }
  };

  const updateOverlay = (overlayId: string, patch: Partial<EditorOverlay>, record = true) => {
    const next = cloneProject(draftRef.current);
    next.overlays = (next.overlays ?? []).map((overlay) => overlay.id === overlayId
      ? patchOverlay(overlay, patch, durationMs)
      : overlay);
    commit(next, record);
  };

  const beginOverlayTextEdit = () => {
    overlayTextEditBaseRef.current ??= cloneProject(draftRef.current);
  };

  const finishOverlayTextEdit = () => {
    const base = overlayTextEditBaseRef.current;
    overlayTextEditBaseRef.current = null;
    if (!base || JSON.stringify(base) === JSON.stringify(draftRef.current)) return;
    historyRef.current = recordProjectUndoSnapshot(historyRef.current, base);
    futureRef.current = [];
    setHistoryVersion((value) => value + 1);
  };

  const importSecondaryAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !onImportSecondaryAudio) return;
    setSecondaryAudioError("");
    if (!file.size || (file.type && !file.type.startsWith("audio/"))) {
      setSecondaryAudioError("请选择可解码且非空的音频文件。");
      return;
    }
    const clipId = crypto.randomUUID();
    try {
      const imported = await onImportSecondaryAudio(clipId, file, secondaryAudioSourceType);
      const clip = createSecondaryAudioClip({
        id: clipId,
        name: file.name,
        sourceUrl: imported.sourceUrl,
        sourceDurationMs: imported.sourceDurationMs,
        timelineStartMs: playheadRef.current,
        projectDurationMs: durationMs,
        sourceType: secondaryAudioSourceType,
      });
      const next = cloneProject(draftRef.current);
      next.secondaryAudioClips = [...(next.secondaryAudioClips ?? []), clip];
      if (commit(next, true)) {
        setSelection({ kind: "secondary-audio", id: clip.id });
        seek(clip.timelineStartMs, false);
      }
    } catch (error) {
      setSecondaryAudioError(error instanceof Error ? error.message : "音频导入失败，请更换文件重试。");
    }
  };

  const updateSecondaryAudio = (
    clipId: string,
    patch: Partial<SecondaryAudioClip>,
    record = true,
  ) => {
    const next = cloneProject(draftRef.current);
    next.secondaryAudioClips = (next.secondaryAudioClips ?? []).map((clip) => clip.id === clipId
      ? patchSecondaryAudioClip(clip, patch, durationMs)
      : clip);
    commit(next, record);
  };

  const beginSecondaryAudioPropertyEdit = () => {
    secondaryAudioPropertyBaseRef.current ??= cloneProject(draftRef.current);
  };

  const finishSecondaryAudioPropertyEdit = () => {
    const base = secondaryAudioPropertyBaseRef.current;
    secondaryAudioPropertyBaseRef.current = null;
    if (!base || JSON.stringify(base) === JSON.stringify(draftRef.current)) return;
    historyRef.current = recordProjectUndoSnapshot(historyRef.current, base);
    futureRef.current = [];
    setHistoryVersion((value) => value + 1);
  };

  const deleteSelection = () => {
    if (!selection) return;
    const next = cloneProject(draftRef.current);
    if (selection.kind === "clip") {
      next.tracks.forEach((track) => {
        track.clips = track.clips.filter((clip) => clip.id !== selection.id);
      });
    } else if (selection.kind === "caption") {
      next.captions = next.captions.filter((caption) => caption.id !== selection.id);
    } else if (selection.kind === "overlay") {
      next.overlays = (next.overlays ?? []).filter((overlay) => overlay.id !== selection.id);
    } else {
      const audio = secondaryAudioElementsRef.current.get(selection.id);
      audio?.pause();
      next.secondaryAudioClips = (next.secondaryAudioClips ?? []).filter((clip) => clip.id !== selection.id);
    }
    const committed = commit(next, true, selection.kind === "clip"
      ? { type: "REMOVE_CLIP", targetId: selection.id }
      : selection.kind === "caption"
        ? { type: "MANUAL_DELETE_CAPTION", targetId: selection.id }
        : undefined);
    if (committed) setSelection(null);
  };

  const splitSelection = () => {
    if (!selection || selection.kind === "overlay" || selection.kind === "secondary-audio") return;
    const next = cloneProject(draftRef.current);
    let nextSelection: Selection = null;
    if (selection.kind === "clip") {
      next.tracks.forEach((track) => {
        const index = track.clips.findIndex((clip) => clip.id === selection.id);
        if (index < 0) return;
        const clip = track.clips[index];
        if (clip.timelineEndMs - clip.timelineStartMs < 200) return;
        const splitAt = clamp(
          playheadMs,
          clip.timelineStartMs + 100,
          clip.timelineEndMs - 100
        );
        if (splitAt <= clip.timelineStartMs || splitAt >= clip.timelineEndMs) return;
        const [first, second] = splitTimelineClip(
          clip,
          splitAt - clip.timelineStartMs,
          () => crypto.randomUUID(),
        );
        track.clips.splice(index, 1, first, second);
        nextSelection = { kind: "clip", id: second.id };
      });
    } else {
      const index = next.captions.findIndex((caption) => caption.id === selection.id);
      const caption = next.captions[index];
      if (!caption) return;
      const splitAt = clamp(playheadMs, caption.startMs + 50, caption.endMs - 50);
      if (splitAt <= caption.startMs || splitAt >= caption.endMs) return;
      const [first, second] = splitCaption(
        caption,
        splitAt,
        crypto.randomUUID(),
        crypto.randomUUID(),
      );
      next.captions.splice(index, 1, first, second);
      nextSelection = { kind: "caption", id: second.id };
    }
    const committed = commit(next, true, selection.kind === "clip"
      ? { type: "SPLIT_CLIP", targetId: selection.id, splitAtSeconds: playheadMs / 1_000 }
      : { type: "MANUAL_SPLIT_CAPTION", targetId: selection.id });
    if (committed && nextSelection) setSelection(nextSelection);
  };

  const mergeCaption = () => {
    if (selection?.kind !== "caption") return;
    const next = cloneProject(draftRef.current);
    const index = next.captions.findIndex((caption) => caption.id === selection.id);
    if (index < 0 || index >= next.captions.length - 1) return;
    const current = next.captions[index];
    const following = next.captions[index + 1];
    if (!following || following.startMs < current.endMs || following.startMs - current.endMs > 1_000) return;
    next.captions.splice(index, 2, mergeAdjacentCaptions(current, following));
    commit(next, true, { type: "MANUAL_MERGE_CAPTION", targetId: selection.id });
  };

  const moveClipOrder = (direction: -1 | 1) => {
    if (selection?.kind !== "clip") return;
    const track = draftRef.current.tracks.find((candidate) => (
      candidate.clips.some((clip) => clip.id === selection.id)
    ));
    if (!track) return;
    const clips = track.clips
      .map((clip, index) => ({ clip, index }))
      .sort((left, right) => (
        left.clip.timelineStartMs - right.clip.timelineStartMs || left.index - right.index
      ))
      .map(({ clip }) => clip);
    const index = clips.findIndex((clip) => clip.id === selection.id);
    const swapIndex = index + direction;
    if (index < 0 || swapIndex < 0 || swapIndex >= clips.length) return;
    commit(reorderTimelineClip(
      draftRef.current,
      selection.id,
      clips[swapIndex].id,
      direction < 0 ? "BEFORE" : "AFTER",
    ), true, {
      type: "REORDER_CLIP",
      targetId: selection.id,
      referenceId: clips[swapIndex].id,
      placement: direction < 0 ? "BEFORE" : "AFTER",
    });
  };

  const applySpeedCurve = (clip: TimelineClip, points: SpeedPoint[]) => {
    const updated = applyClipSpeedCurve(clip, points);
    const next = cloneProject(draftRef.current);
    next.tracks.forEach((track) => {
      track.clips = track.clips.map((candidate) => candidate.id === clip.id ? {
        ...candidate,
        speedCurve: updated.speedCurve,
        timelineEndMs: updated.timelineEndMs,
      } : candidate);
    });
    commit(next, true, { type: "SET_CLIP_PLAYBACK_SPEED", targetId: clip.id });
  };

  const beginTimelineDrag = (
    event: ReactPointerEvent,
    kind: "clip" | "caption",
    id: string,
    mode: "move" | "trim-start" | "trim-end"
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setSelection({ kind, id });
    setDragging(true);
    if (playing) {
      setPlaying(false);
      onPreviewTimeChangeRef.current(playheadRef.current / 1000, false);
    }
    const startX = event.clientX;
    const base = cloneProject(draftRef.current);
    const targets = collectTimelineSnapTargets(base, { kind, id });
    let latest = base;
    let frame = 0;
    let moved = false;
    let previewAtMs = playheadRef.current;
    let lastMediaPreview = 0;

    const move = (pointerEvent: PointerEvent) => {
      const deltaRaw = ((pointerEvent.clientX - startX) / zoom) * 1000;
      moved ||= Math.abs(pointerEvent.clientX - startX) >= 3;
      const snapEnabled = snapping && !pointerEvent.altKey;
      const next = cloneProject(base);
      if (kind === "clip") {
        next.tracks.forEach((track) => {
          track.clips = track.clips.map((clip) => {
            if (clip.id !== id) return clip;
            const duration = clip.timelineEndMs - clip.timelineStartMs;
            const sourceDuration = clip.sourceOutMs - clip.sourceInMs;
            if (mode === "move") {
              const desiredStart = clip.timelineStartMs + deltaRaw;
              const snappedStart = snapTimelineMs(desiredStart, targets, snapEnabled);
              const snappedEnd = snapTimelineMs(desiredStart + duration, targets, snapEnabled);
              const correction = Math.abs(snappedEnd - desiredStart - duration) < Math.abs(snappedStart - desiredStart)
                ? snappedEnd - desiredStart - duration
                : snappedStart - desiredStart;
              const start = clamp(desiredStart + correction, 0, Math.max(0, durationMs - duration));
              previewAtMs = start;
              return { ...clip, timelineStartMs: start, timelineEndMs: start + duration };
            }
            if (mode === "trim-start") {
              const bounds = timelineDurationBoundsForSource(sourceDuration);
              const start = clamp(
                snapTimelineMs(clip.timelineStartMs + deltaRaw, targets, snapEnabled),
                clip.kind === "视频" ? Math.max(0, clip.timelineEndMs - bounds.maxMs) : 0,
                clip.kind === "视频"
                  ? Math.max(0, clip.timelineEndMs - bounds.minMs)
                  : Math.max(0, clip.timelineEndMs - 100)
              );
              previewAtMs = start;
              return {
                ...clip,
                timelineStartMs: start,
                speedCurve: clip.kind === "视频"
                  ? speedCurveForTimelineDuration(sourceDuration, clip.timelineEndMs - start)
                  : clip.speedCurve
              };
            }
            const bounds = timelineDurationBoundsForSource(sourceDuration);
            const end = clamp(
              snapTimelineMs(clip.timelineEndMs + deltaRaw, targets, snapEnabled),
              clip.timelineStartMs + (clip.kind === "视频" ? bounds.minMs : 100),
              clip.kind === "视频"
                ? clip.timelineStartMs + bounds.maxMs
                : durationMs
            );
            previewAtMs = end;
            return {
              ...clip,
              timelineEndMs: end,
              speedCurve: clip.kind === "视频"
                ? speedCurveForTimelineDuration(sourceDuration, end - clip.timelineStartMs)
                : clip.speedCurve
            };
          });
        });
      } else {
        next.captions = next.captions.map((caption) => {
          if (caption.id !== id) return caption;
          const startMs = caption.startMs;
          const endMs = caption.endMs;
          const length = endMs - startMs;
          if (mode === "move") {
            const desiredStart = startMs + deltaRaw;
            const snappedStart = snapTimelineMs(desiredStart, targets, snapEnabled);
            const snappedEnd = snapTimelineMs(desiredStart + length, targets, snapEnabled);
            const correction = Math.abs(snappedEnd - desiredStart - length) < Math.abs(snappedStart - desiredStart)
              ? snappedEnd - desiredStart - length
              : snappedStart - desiredStart;
            const start = clamp(desiredStart + correction, 0, durationMs - length);
            previewAtMs = start;
            return { ...caption, startMs: start, endMs: start + length };
          }
          if (mode === "trim-start") {
            const start = clamp(snapTimelineMs(startMs + deltaRaw, targets, snapEnabled), 0, endMs - 50);
            previewAtMs = start;
            return { ...caption, startMs: start };
          }
          const end = clamp(snapTimelineMs(endMs + deltaRaw, targets, snapEnabled), startMs + 50, durationMs);
          previewAtMs = end;
          return { ...caption, endMs: end };
        });
      }
      latest = {
        ...next,
        durationMs: editorProjectDurationMs(next),
        updatedAt: new Date().toISOString()
      };
      draftRef.current = latest;
      const changedClip = kind === "clip"
        ? latest.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id)
        : undefined;
      const changedCaption = kind === "caption"
        ? latest.captions.find((caption) => caption.id === id)
        : undefined;
      const startMs = changedClip?.timelineStartMs ?? changedCaption?.startMs ?? previewAtMs;
      const endMs = changedClip?.timelineEndMs ?? changedCaption?.endMs;
      setDragFeedback({
        label: mode === "move" ? "移动" : mode === "trim-start" ? "开始" : "结束",
        timeMs: mode === "trim-end" ? (endMs ?? previewAtMs) : startMs,
        durationMs: endMs === undefined ? undefined : Math.max(0, endMs - startMs),
        rate: changedClip?.kind === "视频" ? averageSpeed(changedClip.speedCurve) : undefined
      });
      if (!frame) {
        frame = window.requestAnimationFrame((now) => {
          frame = 0;
          setDraft(latest);
          setPlayheadMs(previewAtMs);
          playheadRef.current = previewAtMs;
          if (now - lastMediaPreview >= 80) {
            lastMediaPreview = now;
            onPreviewTimeChangeRef.current(previewAtMs / 1000, false);
          }
        });
      }
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (frame) window.cancelAnimationFrame(frame);
      setDragging(false);
      setDragFeedback(null);
      if (JSON.stringify(base) !== JSON.stringify(latest)) {
        const action: ConstraintCandidateActionV1 = kind === "clip"
          ? { type: mode === "move" ? "MANUAL_MOVE_CLIP" : "TRIM_CLIP", targetId: id }
          : { type: mode === "move" ? "MANUAL_MOVE_CAPTION" : "MANUAL_TRIM_CAPTION", targetId: id };
        if (kind === "clip") latest = remapVideoCaptions(base, latest);
        if (!allowManualCandidate(base, latest, action)) {
          draftRef.current = base;
          setDraft(base);
          setSavedAt(base.updatedAt);
          return;
        }
        draftRef.current = latest;
        setDraft(latest);
        historyRef.current = recordProjectUndoSnapshot(historyRef.current, base);
        futureRef.current = [];
        setHistoryVersion((value) => value + 1);
        setSavedAt(latest.updatedAt);
        onProjectChange(latest);
      }
      if (moved) {
        suppressClickRef.current = true;
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const finishOverlayInteraction = (base: EditorProject, latest: EditorProject) => {
    if (JSON.stringify(base) === JSON.stringify(latest)) return;
    if (!allowManualCandidate(base, latest)) {
      draftRef.current = base;
      setDraft(base);
      setSavedAt(base.updatedAt);
      return;
    }
    historyRef.current = recordProjectUndoSnapshot(historyRef.current, base);
    futureRef.current = [];
    setHistoryVersion((value) => value + 1);
    draftRef.current = latest;
    setDraft(latest);
    setSavedAt(latest.updatedAt);
    onProjectChange(latest);
  };

  const beginOverlayCanvasDrag = (
    event: ReactPointerEvent,
    overlayId: string,
    mode: "move" | "resize",
  ) => {
    const canvas = canvasRef.current;
    const overlay = (draftRef.current.overlays ?? []).find((item) => item.id === overlayId);
    if (!canvas || !overlay) return;
    event.preventDefault();
    event.stopPropagation();
    setSelection({ kind: "overlay", id: overlayId });
    setDragging(true);
    if (playing) {
      setPlaying(false);
      onPreviewTimeChangeRef.current(playheadRef.current / 1000, false);
    }
    const startX = event.clientX;
    const startY = event.clientY;
    const bounds = canvas.getBoundingClientRect();
    const base = cloneProject(draftRef.current);
    let latest = base;
    let frame = 0;

    const move = (pointerEvent: PointerEvent) => {
      const deltaX = (pointerEvent.clientX - startX) / Math.max(1, bounds.width);
      const deltaY = (pointerEvent.clientY - startY) / Math.max(1, bounds.height);
      const patch = mode === "move"
        ? { x: overlay.x + deltaX, y: overlay.y + deltaY }
        : { width: overlay.width + deltaX, height: overlay.height + deltaY };
      const next = cloneProject(base);
      next.overlays = (next.overlays ?? []).map((item) => item.id === overlayId
        ? patchOverlay(item, patch, durationMs)
        : item);
      latest = { ...next, updatedAt: new Date().toISOString() };
      draftRef.current = latest;
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          setDraft(latest);
        });
      }
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (frame) window.cancelAnimationFrame(frame);
      setDragging(false);
      finishOverlayInteraction(base, latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const beginCaptionCanvasDrag = (event: ReactPointerEvent, captionId: string) => {
    const canvas = canvasRef.current;
    const caption = draftRef.current.captions.find((item) => item.id === captionId);
    if (!canvas || !caption || playheadRef.current < caption.startMs || playheadRef.current >= caption.endMs) return;
    event.preventDefault();
    event.stopPropagation();
    setSelection({ kind: "caption", id: captionId });
    setDragging(true);
    if (playing) {
      setPlaying(false);
      onPreviewTimeChangeRef.current(playheadRef.current / 1_000, false);
    }
    const bounds = canvas.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const presentation = captionPresentation(caption);
    const base = cloneProject(draftRef.current);
    let latest = base;
    let frame = 0;

    const move = (pointerEvent: PointerEvent) => {
      const x = presentation.x + (pointerEvent.clientX - startX) / Math.max(1, bounds.width);
      const y = presentation.y + (pointerEvent.clientY - startY) / Math.max(1, bounds.height);
      const next = cloneProject(base);
      next.captions = next.captions.map((item) => item.id === captionId
        ? patchCaption(item, { x, y }, durationMs)
        : item);
      latest = { ...next, updatedAt: new Date().toISOString() };
      draftRef.current = latest;
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          setDraft(latest);
        });
      }
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (frame) window.cancelAnimationFrame(frame);
      setDragging(false);
      finishOverlayInteraction(base, latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const beginOverlayTimelineDrag = (
    event: ReactPointerEvent,
    overlayId: string,
    mode: "move" | "trim-start" | "trim-end",
  ) => {
    const overlay = (draftRef.current.overlays ?? []).find((item) => item.id === overlayId);
    if (!overlay) return;
    event.preventDefault();
    event.stopPropagation();
    setSelection({ kind: "overlay", id: overlayId });
    setDragging(true);
    const startX = event.clientX;
    const base = cloneProject(draftRef.current);
    const targets = collectTimelineSnapTargets(base, { kind: "overlay", id: overlayId });
    let latest = base;
    let previewAtMs = overlay.startMs;
    let frame = 0;

    const move = (pointerEvent: PointerEvent) => {
      const deltaMs = ((pointerEvent.clientX - startX) / zoom) * 1_000;
      const snapEnabled = snapping && !pointerEvent.altKey;
      const length = overlay.endMs - overlay.startMs;
      let startMs = overlay.startMs;
      let endMs = overlay.endMs;
      if (mode === "move") {
        const desired = overlay.startMs + deltaMs;
        startMs = clamp(snapTimelineMs(desired, targets, snapEnabled), 0, durationMs - length);
        endMs = startMs + length;
      } else if (mode === "trim-start") {
        startMs = clamp(snapTimelineMs(overlay.startMs + deltaMs, targets, snapEnabled), 0, overlay.endMs - 50);
      } else {
        endMs = clamp(snapTimelineMs(overlay.endMs + deltaMs, targets, snapEnabled), overlay.startMs + 50, durationMs);
      }
      previewAtMs = mode === "trim-end" ? endMs : startMs;
      const next = cloneProject(base);
      next.overlays = (next.overlays ?? []).map((item) => item.id === overlayId
        ? patchOverlay(item, { startMs, endMs }, durationMs)
        : item);
      latest = { ...next, updatedAt: new Date().toISOString() };
      draftRef.current = latest;
      setDragFeedback({
        label: mode === "move" ? "移动叠加层" : mode === "trim-start" ? "叠加层开始" : "叠加层结束",
        timeMs: previewAtMs,
        durationMs: endMs - startMs,
      });
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          setDraft(latest);
          seek(previewAtMs, false);
        });
      }
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (frame) window.cancelAnimationFrame(frame);
      setDragging(false);
      setDragFeedback(null);
      finishOverlayInteraction(base, latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const beginSecondaryAudioTimelineDrag = (
    event: ReactPointerEvent,
    clipId: string,
    mode: "move" | "trim-start" | "trim-end",
  ) => {
    const clip = (draftRef.current.secondaryAudioClips ?? []).find((item) => item.id === clipId);
    if (!clip) return;
    event.preventDefault();
    event.stopPropagation();
    setSelection({ kind: "secondary-audio", id: clipId });
    setDragging(true);
    if (playing) {
      setPlaying(false);
      onPreviewTimeChangeRef.current(playheadRef.current / 1_000, false);
    }
    const startX = event.clientX;
    const base = cloneProject(draftRef.current);
    const targets = collectTimelineSnapTargets(base, { kind: "secondary-audio", id: clipId });
    const duration = secondaryAudioDurationMs(clip);
    let latest = base;
    let frame = 0;

    const move = (pointerEvent: PointerEvent) => {
      const deltaMs = ((pointerEvent.clientX - startX) / zoom) * 1_000;
      const snapEnabled = snapping && !pointerEvent.altKey;
      let patch: Partial<SecondaryAudioClip> = {};
      let feedbackTime = clip.timelineStartMs;
      if (mode === "move") {
        const start = clamp(
          snapTimelineMs(clip.timelineStartMs + deltaMs, targets, snapEnabled),
          0,
          Math.max(0, durationMs - duration),
        );
        patch = { timelineStartMs: start };
        feedbackTime = start;
      } else if (mode === "trim-start") {
        const desiredTimelineStart = snapTimelineMs(clip.timelineStartMs + deltaMs, targets, snapEnabled);
        const appliedDelta = clamp(
          desiredTimelineStart - clip.timelineStartMs,
          Math.max(-clip.sourceStartMs, -clip.timelineStartMs),
          duration - MIN_SECONDARY_AUDIO_DURATION_MS,
        );
        patch = {
          timelineStartMs: clip.timelineStartMs + appliedDelta,
          sourceStartMs: clip.sourceStartMs + appliedDelta,
        };
        feedbackTime = clip.timelineStartMs + appliedDelta;
      } else {
        const desiredEnd = snapTimelineMs(secondaryAudioEndMs(clip) + deltaMs, targets, snapEnabled);
        const maxEnd = Math.min(
          clip.timelineStartMs + (clip.sourceDurationMs - clip.sourceStartMs),
          durationMs,
        );
        const end = clamp(
          desiredEnd,
          clip.timelineStartMs + MIN_SECONDARY_AUDIO_DURATION_MS,
          maxEnd,
        );
        patch = { sourceEndMs: clip.sourceStartMs + end - clip.timelineStartMs };
        feedbackTime = end;
      }
      const next = cloneProject(base);
      next.secondaryAudioClips = (next.secondaryAudioClips ?? []).map((item) => item.id === clipId
        ? patchSecondaryAudioClip(item, patch, durationMs)
        : item);
      latest = { ...next, updatedAt: new Date().toISOString() };
      draftRef.current = latest;
      const changed = latest.secondaryAudioClips?.find((item) => item.id === clipId) ?? clip;
      setDragFeedback({
        label: mode === "move" ? "移动声音" : mode === "trim-start" ? "声音入点" : "声音出点",
        timeMs: feedbackTime,
        durationMs: secondaryAudioDurationMs(changed),
      });
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          setDraft(latest);
          seek(mode === "trim-end" ? secondaryAudioEndMs(changed) : changed.timelineStartMs, false);
        });
      }
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (frame) window.cancelAnimationFrame(frame);
      setDragging(false);
      setDragFeedback(null);
      finishOverlayInteraction(base, latest);
      if (JSON.stringify(base) !== JSON.stringify(latest)) {
        suppressClickRef.current = true;
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const beginPlayheadDrag = (event: ReactPointerEvent) => {
    const content = timelineContentRef.current;
    if (!content) return;
    const target = event.target as HTMLElement;
    if (target.closest(".timeline-clip, .timeline-caption, .timeline-overlay, .timeline-secondary-audio, .trim-handle")) return;
    event.preventDefault();
    event.stopPropagation();
    const wasPlaying = playing;
    if (wasPlaying) {
      setPlaying(false);
      onPreviewTimeChangeRef.current(playheadRef.current / 1000, false);
    }
    setDragging(true);
    let frame = 0;
    let nextMs = playheadRef.current;
    const targets = collectTimelineSnapTargets(draftRef.current);

    const move = (pointerEvent: PointerEvent | ReactPointerEvent) => {
      const rect = content.getBoundingClientRect();
      const rawMs = ((pointerEvent.clientX - rect.left) / zoom) * 1000;
      nextMs = clamp(
        snapTimelineMs(rawMs, targets, snapping && !pointerEvent.altKey),
        0,
        durationMs
      );
      setDragFeedback({ label: "播放头", timeMs: nextMs });
      if (!frame) {
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          playheadRef.current = nextMs;
          setPlayheadMs(nextMs);
          onPreviewTimeChangeRef.current(nextMs / 1000, false);
        });
      }
    };
    move(event);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (frame) window.cancelAnimationFrame(frame);
      playheadRef.current = nextMs;
      setPlayheadMs(nextMs);
      onPreviewTimeChangeRef.current(nextMs / 1000, wasPlaying);
      setDragFeedback(null);
      setDragging(false);
      if (wasPlaying) setPlaying(true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const captionChunks = useMemo(() => {
    const chunkSize = 15;
    return Array.from(
      { length: Math.ceil(draft.captions.length / chunkSize) },
      (_, index) => {
        const captions = draft.captions.slice(index * chunkSize, (index + 1) * chunkSize);
        return {
          captions,
          startMs: captions[0]?.startMs ?? 0,
          endMs: captions.at(-1)?.endMs ?? 0,
          id: captions[0]?.id ?? `caption-chunk-${index}`
        };
      }
    );
  }, [draft.captions]);
  const ticks = useMemo(() => {
    const stepSeconds = zoom >= 90 ? 1 : zoom >= 45 ? 2 : 5;
    const count = Math.max(0, Math.ceil(durationMs / 1000 / stepSeconds));
    return Array.from({ length: count + 1 }, (_, index) => index * stepSeconds);
  }, [durationMs, zoom]);

  return (
    <section hidden={!visible} data-mobile-pane={mobilePane} aria-label="生成后继续剪辑" className={`timeline-editor-shell ${dragging ? "is-dragging" : ""}`}>
      <div aria-hidden="true" className="secondary-audio-preview-bank">
        {(draft.secondaryAudioClips ?? []).map((clip) => (
          <audio
            data-secondary-audio-id={clip.id}
            key={clip.id}
            preload="auto"
            ref={(node) => {
              if (node) secondaryAudioElementsRef.current.set(clip.id, node);
              else secondaryAudioElementsRef.current.delete(clip.id);
            }}
            src={secondaryAudioSources[clip.id] ?? clip.sourceUrl}
          />
        ))}
      </div>
      <header className="timeline-editor-header">
        <div>
          <span className="editor-status-dot" />
          <div>
            <b>继续精剪</b>
            <small>自动保存于 {new Date(savedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small>
          </div>
        </div>
        <div className="editor-toolbar">
          <button disabled={!historyRef.current.length} onClick={undo} type="button">↶ 撤销</button>
          <button disabled={!futureRef.current.length} onClick={redo} type="button">↷ 重做</button>
          <button disabled={!selection || selection.kind === "overlay" || selection.kind === "secondary-audio"} onClick={splitSelection} type="button">✂ 分割</button>
          <button disabled={!canMergeCaption} onClick={mergeCaption} type="button">合并字幕</button>
          <button className="danger" disabled={!selection} onClick={deleteSelection} type="button">删除</button>
          <button
            aria-describedby={!draft.captions.length ? "timeline-srt-empty-hint" : undefined}
            disabled={!draft.captions.length}
            onClick={() => onDownloadSubtitles(draft.captions)}
            type="button"
          >下载 SRT</button>
          <button className="render-button" onClick={onRender} type="button">{renderLabel}</button>
          <button aria-label="关闭编辑器" className="close-editor" onClick={onClose} type="button">×</button>
        </div>
      </header>

      <nav className="editor-mobile-tabs" aria-label="精剪面板">{[["library","素材"],["preview","预览"],["properties","属性"]].map(([id,label])=><button key={id} type="button" aria-pressed={mobilePane===id} onClick={()=>setMobilePane(id as "library"|"preview"|"properties")}>{label}</button>)}</nav>
      <div className="timeline-editor-main">
        <aside className="editor-library">
          <div className="editor-pane-title">
            <b>素材库</b>
            <span>{assets.length} 项</span>
          </div>
          <div className="editor-asset-list">
            {assets.map((asset, index) => (
              <button
                aria-label={(allClips.some(c=>c.assetId===asset.id)?"选择素材 ":"添加到时间线 ")+asset.name}
                className={selectedClip?.assetId === asset.id ? "selected" : ""}
                disabled={!asset.preview && !allClips.some(clip => clip.assetId === asset.id)}
                key={asset.id}
                onClick={() => {
                  const clip = allClips.find((item) => item.assetId === asset.id);
                  if (clip) {
                    setSelection({ kind: "clip", id: clip.id });
                    seek(clip.timelineStartMs, false);
                  } else {addLibraryAsset(asset.id);}
                }}
                type="button"
              >
                <span className="asset-thumb">
                  {asset.preview && asset.kind === "图片"
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img alt="" src={asset.preview} />
                    : asset.kind === "视频" ? "▶" : "▧"}
                </span>
                <span><b>{asset.name}</b><small>{allClips.some(c=>c.assetId===asset.id)?"已在时间线":asset.preview?"未加入，点击添加":"未加入时间线"}，{asset.preview ? "本地文件已关联" : "本地文件待关联"}</small></span>
              </button>
            ))}
          </div>
          <div className="overlay-toolbox" aria-label="叠加工具">
            <b>叠加工具</b>
            <div>
              <button onClick={() => addOverlay("text")} type="button">文字</button>
              <button onClick={() => addOverlay("arrow")} type="button">箭头</button>
              <button onClick={() => addOverlay("rectangle")} type="button">矩形</button>
              <button onClick={() => addOverlay("circle")} type="button">圆形</button>
            </div>
          </div>
          <div className="subtitle-import-toolbox" aria-label="字幕导入工具">
            <b>字幕</b>
            <select aria-label="字幕导入方式" onChange={(event) => setSubtitleImportMode(event.target.value as "replace" | "append")} value={subtitleImportMode}>
              <option value="replace">替换当前字幕</option>
              <option value="append">追加字幕</option>
            </select>
            <input
              accept=".srt,.vtt,.ass,text/vtt,application/x-subrip,text/x-ssa,text/x-ass"
              onChange={(event) => void importSubtitles(event)}
              ref={subtitleImportInputRef}
              type="file"
            />
            <button onClick={() => subtitleImportInputRef.current?.click()} type="button">上传字幕</button>
            <small>支持 SRT、VTT、基础 ASS。</small>
            {subtitleImportError && <small role="alert">{subtitleImportError}</small>}
          </div>
          <div className="secondary-audio-toolbox" aria-label="辅助音频工具">
            <b>音效 / 声音</b>
            <select
              aria-label="辅助音频类型"
              onChange={(event) => setSecondaryAudioSourceType(event.target.value as SecondaryAudioSourceType)}
              value={secondaryAudioSourceType}
            >
              <option value="sound-effect">音效</option>
              <option value="voice">声音 / 配音</option>
              <option value="imported-audio">导入音频</option>
            </select>
            <input
              accept="audio/*"
              onChange={(event) => void importSecondaryAudio(event)}
              ref={secondaryAudioInputRef}
              type="file"
            />
            <button disabled={!onImportSecondaryAudio} onClick={() => secondaryAudioInputRef.current?.click()} type="button">
              ＋ 导入音频片段
            </button>
            {secondaryAudioError && <small role="alert">{secondaryAudioError}</small>}
          </div>
          <div className="editor-draft-note">
            <b>草稿恢复</b>
            <span>时间线、字幕、叠加层、变速曲线和画面位置已保存。刷新后浏览器会恢复工程结构；本地文件需重新选择才能播放。</span>
          </div>
        </aside>

        <div className="editor-preview-column">
          <div className={`editor-canvas editor-ratio-${draft.ratio.replace(":", "")}`} ref={canvasRef} style={{aspectRatio: `${outputCanvasSize(draft.ratio).width} / ${outputCanvasSize(draft.ratio).height}`,width:`min(100%, ${Math.min(900,480*outputCanvasSize(draft.ratio).width/outputCanvasSize(draft.ratio).height)}px)`,height:"auto",maxHeight:"none"}}>
            {activeAsset?.preview ? (
              activeAsset.kind === "视频" ? (
                <video
                  key={activeAsset.id}
                  muted={videoVolume === 0}
                  playsInline
                  preload="auto"
                  ref={videoRef}
                  src={activeAsset.preview}
                  style={{
                    objectFit: activeClip?.transform.fit === "contain" ? "contain" : "cover",
                    transform: clipPositionScaleCss(activeClip?.transform ?? { x: 0, y: 0, scale: 1 })
                  }}
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  alt="编辑器画面预览"
                  src={activeAsset.preview}
                  style={{
                    objectFit: activeClip?.transform.fit === "contain" ? "contain" : "cover",
                    transform: clipPositionScaleCss(activeClip?.transform ?? { x: 0, y: 0, scale: 1 })
                  }}
                />
              )
            ) : (
              <div className="editor-empty-preview">
                <span>▣</span>
                <b>{activeClip ? "本地素材等待重新关联" : "移动播放头预览画面"}</b>
              </div>
            )}
            {draft.ratio === "9:16" && (
              <div className="vertical-safe-area"><span>9:16 安全区域</span></div>
            )}
            <div className="editor-overlay-layer">
              {activeOverlays.map((overlay) => (
                <div
                  aria-label={`${overlay.type === "text" ? "文字" : overlay.type === "arrow" ? "箭头" : overlay.type === "rectangle" ? "矩形" : "圆形"}叠加层`}
                  className={`editor-overlay editor-overlay-${overlay.type} ${selectedOverlay?.id === overlay.id ? "selected" : ""}`}
                  key={overlay.id}
                  onClick={(event) => { event.stopPropagation(); setSelection({ kind: "overlay", id: overlay.id }); }}
                  onPointerDown={(event) => beginOverlayCanvasDrag(event, overlay.id, "move")}
                  style={{
                    left: `${overlay.x * 100}%`,
                    top: `${overlay.y * 100}%`,
                    width: `${overlay.width * 100}%`,
                    height: `${overlay.height * 100}%`,
                  }}
                >
                  {overlay.type === "text" ? (
                    <span style={{ fontSize: `clamp(10px, ${overlay.fontSize / 19.2}cqi, ${overlay.fontSize}px)` }}>
                      {overlay.text || "（空文字）"}
                    </span>
                  ) : overlay.type === "arrow" ? (
                    <svg aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 100">
                      <path
                        d={overlay.direction === "left" ? "M95 50H5M5 50l24-28M5 50l24 28" : "M5 50h90M95 50L71 22M95 50L71 78"}
                      />
                    </svg>
                  ) : <span aria-hidden="true" />}
                  {selectedOverlay?.id === overlay.id && (
                    <button
                      aria-label="调整叠加层大小"
                      className="overlay-resize-handle"
                      onPointerDown={(event) => beginOverlayCanvasDrag(event, overlay.id, "resize")}
                      type="button"
                    />
                  )}
                </div>
              ))}
            </div>
            {activeCaption && activeCaptionPresentation && (
              <EditorCaptionView aria-label="字幕预览位置" caption={activeCaption} ratio={draft.ratio} presentation={activeCaptionPresentation} className={"editor-caption-preview "+(selectedCaption?.id===activeCaption.id?"selected":"")} onClick={event=>{event.stopPropagation();setSelection({kind:"caption",id:activeCaption.id});}} onPointerDown={event=>beginCaptionCanvasDrag(event,activeCaption.id)}/>
            )}
            <div className="editor-preview-meta">
              <span>{activeClip?.name ?? "无画面"}</span>
              <b>{activeRate.toFixed(2)}×</b>
            </div>
          </div>
          <div className="editor-player-controls">
            <button onClick={togglePlayback} type="button">{playing ? "Ⅱ" : "▶"}</button>
            <input
              aria-label="编辑器播放进度"
              max={durationMs}
              min="0"
              onChange={(event) => { setPlaying(false); seek(Number(event.target.value), false); }}
              step="10"
              type="range"
              value={playheadMs}
            />
            <span>{formatTimeMs(playheadMs)} / {formatTimeMs(durationMs)}</span>
          </div>
        </div>

        <aside className="editor-properties"><OutputCanvasSettings disabled={outputSettingsDisabled} ratio={draft.ratio} fit={new Set(draft.tracks.flatMap(t=>t.clips).map(c=>c.transform.fit)).size===1?draft.tracks.flatMap(t=>t.clips)[0]?.transform.fit??"mixed":"mixed"} onChange={(ratio,fit)=>{try{if(!commit(changeOutputCanvas(draft,ratio,fit,Boolean(activeConstraintSet)),true,undefined,true))throw Error("画面调整受到保护约束限制，请核对保护范围。");}catch(e){onConstraintBlocked?.((e as Error).message);throw e;}}}/>
          <div className="editor-pane-title">
            <b>属性</b>
            <span>{selectedSecondaryAudio ? "辅助音频" : selectedOverlay ? "叠加层" : selectedClip ? "素材片段" : selectedCaption ? "字幕" : "未选择"}</span>
          </div>
          {selectedSecondaryAudio ? (
            <div className="property-stack secondary-audio-properties">
              <label>
                <span>片段名称</span>
                <input
                  maxLength={160}
                  onBlur={finishSecondaryAudioPropertyEdit}
                  onChange={(event) => updateSecondaryAudio(selectedSecondaryAudio.id, { name: event.target.value }, false)}
                  onFocus={beginSecondaryAudioPropertyEdit}
                  type="text"
                  value={selectedSecondaryAudio.name}
                />
              </label>
              <div className="property-grid">
                <label><span>开始（秒）</span><input max={(durationMs / 1000).toFixed(2)} min="0" onBlur={finishSecondaryAudioPropertyEdit} onChange={(event) => updateSecondaryAudio(selectedSecondaryAudio.id, { timelineStartMs: Number(event.target.value) * 1000 }, false)} onFocus={beginSecondaryAudioPropertyEdit} step="0.01" type="number" value={(selectedSecondaryAudio.timelineStartMs / 1000).toFixed(2)} /></label>
                <label><span>时长（秒）</span><input disabled type="number" value={(secondaryAudioDurationMs(selectedSecondaryAudio) / 1000).toFixed(2)} /></label>
                <label><span>裁剪入点（秒）</span><input max={(selectedSecondaryAudio.sourceDurationMs / 1000).toFixed(2)} min="0" onBlur={finishSecondaryAudioPropertyEdit} onChange={(event) => updateSecondaryAudio(selectedSecondaryAudio.id, { sourceStartMs: Number(event.target.value) * 1000 }, false)} onFocus={beginSecondaryAudioPropertyEdit} step="0.01" type="number" value={(selectedSecondaryAudio.sourceStartMs / 1000).toFixed(2)} /></label>
                <label><span>裁剪出点（秒）</span><input max={(selectedSecondaryAudio.sourceDurationMs / 1000).toFixed(2)} min="0.05" onBlur={finishSecondaryAudioPropertyEdit} onChange={(event) => updateSecondaryAudio(selectedSecondaryAudio.id, { sourceEndMs: Number(event.target.value) * 1000 }, false)} onFocus={beginSecondaryAudioPropertyEdit} step="0.01" type="number" value={(selectedSecondaryAudio.sourceEndMs / 1000).toFixed(2)} /></label>
              </div>
              <label><span>音量 {Math.round(selectedSecondaryAudio.volume * 100)}%</span><input max="1" min="0" onBlur={finishSecondaryAudioPropertyEdit} onChange={(event) => updateSecondaryAudio(selectedSecondaryAudio.id, { volume: Number(event.target.value) }, false)} onFocus={beginSecondaryAudioPropertyEdit} onPointerDown={beginSecondaryAudioPropertyEdit} onPointerUp={finishSecondaryAudioPropertyEdit} step="0.01" type="range" value={selectedSecondaryAudio.volume} /></label>
              <label><span>淡入 {(selectedSecondaryAudio.fadeInMs / 1000).toFixed(2)} 秒</span><input max={secondaryAudioDurationMs(selectedSecondaryAudio)} min="0" onBlur={finishSecondaryAudioPropertyEdit} onChange={(event) => updateSecondaryAudio(selectedSecondaryAudio.id, { fadeInMs: Number(event.target.value) }, false)} onFocus={beginSecondaryAudioPropertyEdit} onPointerDown={beginSecondaryAudioPropertyEdit} onPointerUp={finishSecondaryAudioPropertyEdit} step="10" type="range" value={selectedSecondaryAudio.fadeInMs} /></label>
              <label><span>淡出 {(selectedSecondaryAudio.fadeOutMs / 1000).toFixed(2)} 秒</span><input max={Math.max(0, secondaryAudioDurationMs(selectedSecondaryAudio) - selectedSecondaryAudio.fadeInMs)} min="0" onBlur={finishSecondaryAudioPropertyEdit} onChange={(event) => updateSecondaryAudio(selectedSecondaryAudio.id, { fadeOutMs: Number(event.target.value) }, false)} onFocus={beginSecondaryAudioPropertyEdit} onPointerDown={beginSecondaryAudioPropertyEdit} onPointerUp={finishSecondaryAudioPropertyEdit} step="10" type="range" value={selectedSecondaryAudio.fadeOutMs} /></label>
              <button onClick={() => seek(selectedSecondaryAudio.timelineStartMs, false)} type="button">播放头定位到声音</button>
            </div>
          ) : selectedOverlay ? (
            <div className="property-stack">
              {selectedOverlay.type === "text" && (
                <>
                  <label>
                    <span>文字内容（允许留空）</span>
                    <textarea
                      onBlur={finishOverlayTextEdit}
                      onChange={(event) => updateOverlay(selectedOverlay.id, { text: event.target.value } as Partial<EditorOverlay>, false)}
                      onFocus={beginOverlayTextEdit}
                      rows={4}
                      value={selectedOverlay.text}
                    />
                  </label>
                  {!selectedOverlay.text && <div className="overlay-empty-warning">文字为空，叠加层会保留但不输出文字。</div>}
                  <label><span>字号</span><input max="120" min="12" onChange={(event) => updateOverlay(selectedOverlay.id, { fontSize: Number(event.target.value) } as Partial<EditorOverlay>)} step="1" type="number" value={selectedOverlay.fontSize} /></label>
                </>
              )}
              {selectedOverlay.type === "arrow" && (
                <label>
                  <span>箭头方向</span>
                  <select onChange={(event) => updateOverlay(selectedOverlay.id, { direction: event.target.value as "left" | "right" } as Partial<EditorOverlay>)} value={selectedOverlay.direction}>
                    <option value="right">起点 → 终点</option>
                    <option value="left">终点 ← 起点</option>
                  </select>
                </label>
              )}
              <div className="property-grid">
                <label><span>X（%）</span><input max="100" min="0" onChange={(event) => updateOverlay(selectedOverlay.id, { x: Number(event.target.value) / 100 } as Partial<EditorOverlay>)} step="1" type="number" value={Math.round(selectedOverlay.x * 100)} /></label>
                <label><span>Y（%）</span><input max="100" min="0" onChange={(event) => updateOverlay(selectedOverlay.id, { y: Number(event.target.value) / 100 } as Partial<EditorOverlay>)} step="1" type="number" value={Math.round(selectedOverlay.y * 100)} /></label>
                <label><span>宽度（%）</span><input max="100" min="4" onChange={(event) => updateOverlay(selectedOverlay.id, { width: Number(event.target.value) / 100 } as Partial<EditorOverlay>)} step="1" type="number" value={Math.round(selectedOverlay.width * 100)} /></label>
                <label><span>高度（%）</span><input max="100" min="4" onChange={(event) => updateOverlay(selectedOverlay.id, { height: Number(event.target.value) / 100 } as Partial<EditorOverlay>)} step="1" type="number" value={Math.round(selectedOverlay.height * 100)} /></label>
                <label><span>开始（秒）</span><input min="0" onChange={(event) => updateOverlay(selectedOverlay.id, { startMs: Math.round(Number(event.target.value) * 1000) } as Partial<EditorOverlay>)} step="0.01" type="number" value={(selectedOverlay.startMs / 1000).toFixed(2)} /></label>
                <label><span>结束（秒）</span><input max={(durationMs / 1000).toFixed(2)} min="0.05" onChange={(event) => updateOverlay(selectedOverlay.id, { endMs: Math.round(Number(event.target.value) * 1000) } as Partial<EditorOverlay>)} step="0.01" type="number" value={(selectedOverlay.endMs / 1000).toFixed(2)} /></label>
              </div>
              <button onClick={() => seek(selectedOverlay.startMs, false)} type="button">播放头定位到叠加层</button>
            </div>
          ) : selectedCaption && selectedCaptionPresentation ? (
            <div className="property-stack caption-properties">
              {captionTimelineHasOverlap(draft.captions)&&<p className="caption-review-warning">存在重叠字幕，原始时码已保留，请在导出前逐条核对。</p>}
              {selectedCaption.needsReview && (
                <div className="caption-review-warning">此字幕需要校对，请核对文字、声音与时间。</div>
              )}
              <label>
                <span>字幕文字</span>
                <textarea
                  onBlur={finishCaptionPropertyEdit}
                  onChange={(event) => updateCaption(selectedCaption.id, { text: event.target.value }, false)}
                  onFocus={beginCaptionPropertyEdit}
                  rows={5}
                  value={selectedCaption.text}
                />
              </label>
              <div className="property-grid">
                <label><span>开始（秒）</span><input max={(durationMs / 1000).toFixed(2)} min="0" onBlur={finishCaptionPropertyEdit} onChange={(event) => updateCaption(selectedCaption.id, { startMs: Math.round(Number(event.target.value) * 1000) }, false)} onFocus={beginCaptionPropertyEdit} step="0.01" type="number" value={(selectedCaption.startMs / 1000).toFixed(2)} /></label>
                <label><span>结束（秒）</span><input max={(durationMs / 1000).toFixed(2)} min="0.05" onBlur={finishCaptionPropertyEdit} onChange={(event) => updateCaption(selectedCaption.id, { endMs: Math.round(Number(event.target.value) * 1000) }, false)} onFocus={beginCaptionPropertyEdit} step="0.01" type="number" value={(selectedCaption.endMs / 1000).toFixed(2)} /></label>
                <label><span>X（%）</span><input max="95" min="5" onBlur={finishCaptionPropertyEdit} onChange={(event) => updateCaption(selectedCaption.id, { x: Number(event.target.value) / 100 }, false)} onFocus={beginCaptionPropertyEdit} step="1" type="number" value={Math.round(selectedCaptionPresentation.x * 100)} /></label>
                <label><span>Y（%）</span><input max="95" min="8" onBlur={finishCaptionPropertyEdit} onChange={(event) => updateCaption(selectedCaption.id, { y: Number(event.target.value) / 100 }, false)} onFocus={beginCaptionPropertyEdit} step="1" type="number" value={Math.round(selectedCaptionPresentation.y * 100)} /></label>
              </div>
              <div className="property-grid">
                <label><span>文字颜色</span><input onBlur={finishCaptionPropertyEdit} onChange={(event) => updateCaption(selectedCaption.id, { color: event.target.value }, false)} onFocus={beginCaptionPropertyEdit} type="color" value={selectedCaptionPresentation.color} /></label>
                <label><span>水平对齐</span><select onBlur={finishCaptionPropertyEdit} onChange={(event) => updateCaption(selectedCaption.id, { alignment: event.target.value as TimelineCaption["alignment"] }, false)} onFocus={beginCaptionPropertyEdit} value={selectedCaptionPresentation.alignment}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
                <label><span>字号</span><input max="120" min="12" onBlur={finishCaptionPropertyEdit} onChange={(event) => updateCaption(selectedCaption.id, { fontSize: Number(event.target.value) }, false)} onFocus={beginCaptionPropertyEdit} step="1" type="number" value={selectedCaptionPresentation.fontSize} /></label>
              </div>
              <label><span>不透明度 {Math.round(selectedCaptionPresentation.opacity * 100)}%</span><input max="1" min="0.1" onBlur={finishCaptionPropertyEdit} onChange={(event) => updateCaption(selectedCaption.id, { opacity: Number(event.target.value) }, false)} onFocus={beginCaptionPropertyEdit} onPointerDown={beginCaptionPropertyEdit} onPointerUp={finishCaptionPropertyEdit} step="0.01" type="range" value={selectedCaptionPresentation.opacity} /></label>
              <button onClick={applySelectedCaptionPresentationToAll} type="button">应用到全部字幕</button>
              <button onClick={() => seek(selectedCaption.startMs, false)} type="button">播放头定位到字幕</button>
            </div>
          ) : selectedClip ? (
            <div className="property-stack">
              <label>
                <span>替换素材</span>
                <select onChange={(event) => replaceClip(selectedClip.id, event.target.value)} value={selectedClip.assetId}>
                  {assets.map((asset) => <option key={asset.id} value={asset.id} disabled={!asset.preview}>{asset.name}</option>)}
                </select>
              </label>
              <div className="property-grid">
                <label><span>时间线开始</span><input min="0" onChange={(event) => updateClipTimelineBoundary(selectedClip.id, "start", Number(event.target.value) * 1000)} step="0.01" type="number" value={(selectedClip.timelineStartMs / 1000).toFixed(2)} /></label>
                <label><span>时间线结束</span><input min="0" onChange={(event) => updateClipTimelineBoundary(selectedClip.id, "end", Number(event.target.value) * 1000)} step="0.01" type="number" value={(selectedClip.timelineEndMs / 1000).toFixed(2)} /></label>
                <label><span>源入点</span><input min="0" onChange={(event) => updateClip(selectedClip.id, { sourceInMs: Number(event.target.value) * 1000 })} step="0.01" type="number" value={(selectedClip.sourceInMs / 1000).toFixed(2)} /></label>
                <label><span>源出点</span><input min="0" onChange={(event) => updateClip(selectedClip.id, { sourceOutMs: Number(event.target.value) * 1000 })} step="0.01" type="number" value={(selectedClip.sourceOutMs / 1000).toFixed(2)} /></label>
              </div>
              <div className="property-grid">
                <label><span>X 位置（%）</span><input max="100" min="-100" onChange={(event) => updateClipPositionScale(selectedClip.id, { x: Number(event.target.value) })} step="1" type="number" value={selectedClip.transform.x} /></label>
                <label><span>Y 位置（%）</span><input max="100" min="-100" onChange={(event) => updateClipPositionScale(selectedClip.id, { y: Number(event.target.value) })} step="1" type="number" value={selectedClip.transform.y} /></label>
                <label><span>缩放</span><input max="3" min="0.25" onChange={(event) => updateClipPositionScale(selectedClip.id, { scale: Number(event.target.value) })} step="0.05" type="number" value={selectedClip.transform.scale} /></label>
                <label><span>裁切（%）</span><input max="45" min="0" onChange={(event) => updateClip(selectedClip.id, { transform: { ...selectedClip.transform, crop: Number(event.target.value) } })} step="1" type="number" value={selectedClip.transform.crop} /></label>
              </div>
              <label>
                <span>适配方式</span>
                <select onChange={(event) => updateClip(selectedClip.id, { transform: { ...selectedClip.transform, fit: event.target.value as "cover" | "contain" | "crop" } })} value={selectedClip.transform.fit}>
                  <option value="cover">铺满画布</option>
                  <option value="contain">完整显示</option>
                  <option value="crop">自定义裁切</option>
                </select>
              </label>
              <div className="clip-order-actions">
                <button onClick={() => moveClipOrder(-1)} type="button">← 前移</button>
                <button onClick={() => moveClipOrder(1)} type="button">后移 →</button>
              </div>

              {selectedClip.kind === "视频" && (
                <section className="speed-curve-editor">
                  <div>
                    <b>任意速度曲线</b>
                    <span>平均 {averageSpeed(selectedClip.speedCurve).toFixed(2)}×。片段时长变化时自动适配</span>
                  </div>
                  <svg aria-label="速度曲线预览" viewBox="0 0 260 92">
                    <path d="M8 76H252M8 48H252M8 20H252" stroke="rgba(125,157,166,.22)" />
                    <polyline
                      fill="none"
                      points={normalizeSpeedCurve(selectedClip.speedCurve).map((point) =>
                        `${8 + point.at * 244},${76 - ((point.rate - 0.25) / 3.75) * 62}`
                      ).join(" ")}
                      stroke="#18c8ac"
                      strokeWidth="3"
                    />
                    {normalizeSpeedCurve(selectedClip.speedCurve).map((point) => (
                      <circle
                        cx={8 + point.at * 244}
                        cy={76 - ((point.rate - 0.25) / 3.75) * 62}
                        fill="#ffffff"
                        key={point.id}
                        r="4"
                        stroke="#18c8ac"
                        strokeWidth="2"
                      />
                    ))}
                  </svg>
                  <div className="speed-presets">
                    {Object.entries(SPEED_PRESETS).map(([name, points]) => (
                      <button key={name} onClick={() => applySpeedCurve(selectedClip, cloneSpeedPreset(points))} type="button">{name}</button>
                    ))}
                  </div>
                  <div className="speed-point-list">
                    {normalizeSpeedCurve(selectedClip.speedCurve).map((point, index, curve) => (
                      <div key={point.id}>
                        <span>{Math.round(point.at * 100)}%</span>
                        <input
                          aria-label={`速度点 ${index + 1} 位置`}
                          disabled={index === 0 || index === curve.length - 1}
                          max="1"
                          min="0"
                          onChange={(event) => {
                            const next = curve.map((item) => item.id === point.id ? { ...item, at: Number(event.target.value) } : item);
                            applySpeedCurve(selectedClip, next);
                          }}
                          step="0.01"
                          type="range"
                          value={point.at}
                        />
                        <input
                          aria-label={`速度点 ${index + 1} 倍速`}
                          max="4"
                          min="0.25"
                          onChange={(event) => {
                            const next = curve.map((item) => item.id === point.id ? { ...item, rate: Number(event.target.value) } : item);
                            applySpeedCurve(selectedClip, next);
                          }}
                          step="0.05"
                          type="range"
                          value={point.rate}
                        />
                        <b>{point.rate.toFixed(2)}×</b>
                        <button
                          aria-label={`删除速度点 ${index + 1}`}
                          disabled={index === 0 || index === curve.length - 1}
                          onClick={() => applySpeedCurve(selectedClip, curve.filter((item) => item.id !== point.id))}
                          type="button"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() => {
                      const curve = normalizeSpeedCurve(selectedClip.speedCurve);
                      applySpeedCurve(selectedClip, [
                        ...curve,
                        { id: crypto.randomUUID(), at: 0.5, rate: speedAt(curve, 0.5) }
                      ]);
                    }}
                    type="button"
                  >
                    ＋ 添加速度点
                  </button>
                  <small>拖动开始/结束手柄或修改时间线边界时，会保留素材入点与出点并自动拟合视频速度。片段原声随画面变速；独立音频和字幕保持原来的速度。</small>
                  {(audioMode === "original" || audioMode === "mix")
                    && videoVolume > 0
                    && normalizeSpeedCurve(selectedClip.speedCurve).some((point) => point.rate < 0.5)
                    && <small className="speed-export-limit" role="status">
                      当前曲线包含低于 0.5× 的区间；原声导出仅验证 0.5×–4×，此曲线会被安全拒绝，不会静音或截断人声。
                    </small>}
                </section>
              )}
            </div>
          ) : (
            <div className="editor-empty-properties">
              <span>⌁</span>
              <b>选择片段、字幕或叠加层</b>
              
            </div>
          )}
        </aside>
      </div>

      <div className="timeline-dock">
        <div className="timeline-tools">
          <b>多轨时间线</b>
          {!draft.captions.length && <small id="timeline-srt-empty-hint">暂无字幕可下载</small>}
          <label><span>缩放</span><input max="160" min="24" onChange={(event) => setZoom(Number(event.target.value))} type="range" value={zoom} /></label>
          <button
            className={snapping ? "selected" : ""}
            onClick={() => setSnapping((value) => !value)}
            title="吸附字幕断句、素材边界和音频起止；拖动时按 Alt 可临时关闭"
            type="button"
          >
            🧲 吸附 {snapping ? "开" : "关"}
          </button>
          <span className="timeline-live-status">
            当前 {formatDragTime(playheadMs)}
            {(selectedClip || selectedCaption || selectedOverlay || selectedSecondaryAudio) && `，时长 ${formatDragTime(
              selectedClip
                ? selectedClip.timelineEndMs - selectedClip.timelineStartMs
                : selectedCaption
                  ? selectedCaption.endMs - selectedCaption.startMs
                  : selectedOverlay
                    ? selectedOverlay.endMs - selectedOverlay.startMs
                    : secondaryAudioDurationMs(selectedSecondaryAudio!)
            )}`}
          </span>
          {protectionAnnotations.find((item) => item.annotationId === detailAnnotationId) && <span className="timeline-protection-detail" aria-live="polite">
            {protectionAnnotations.find((item) => item.annotationId === detailAnnotationId)!.tooltipSummary}
          </span>}
          <span>{formatTimeMs(durationMs)}，{Math.round(zoom)} px/s</span>
        </div>
        <div className="timeline-scroll">
          <div className="timeline-labels" style={{ gridTemplateRows: `28px ${protectionLayout.height}px repeat(6, 52px)` }}>
            <div className="protection-row-label">保护区</div>
            <div className="ruler-label">轨道</div>
            <div>🎙 主音频</div>
            <div>🎬 主视频</div>
            <div>▧ B-roll</div>
            <div>CC 字幕</div>
            <div>◇ 叠加层</div>
            <div>♫ 辅助音频</div>
          </div>
          <div
            className="timeline-content"
            onPointerDown={beginPlayheadDrag}
            ref={timelineContentRef}
            style={{ width: timelineWidth, gridTemplateRows: `28px ${protectionLayout.height}px repeat(6, 52px)` }}
          >
            <div className="timeline-ruler">
              {ticks.map((second) => (
                <span key={second} style={{ left: second * zoom }}>{formatTimeMs(second * 1000)}</span>
              ))}
            </div>
            <div aria-label="受保护区域" className="timeline-protection-lane" style={{ height: protectionLayout.height }}>
              {protectionAnnotations.map((annotation) => {
                const hasRange = annotation.timelineEnd > annotation.timelineStart;
                const left = (annotation.timelineStart / 1000) * zoom;
                const width = Math.max(18, ((annotation.timelineEnd - annotation.timelineStart) / 1000) * zoom);
                return <button
                  aria-label={`${annotation.label}，${annotation.status === "ACTIVE_HARD_CONSTRAINT" ? "已确认锁定" : annotation.status === "CANDIDATE_BINDING" ? "候选范围待确认" : annotation.status === "STALE" ? "需要重新确认" : "待确认"}`}
                  className={`timeline-protection ${annotation.status.toLowerCase().replaceAll("_", "-")} ${blockedAnnotationId === annotation.annotationId ? "blocked" : ""}`}
                  key={annotation.annotationId}
                  onClick={(event) => { event.stopPropagation(); setDetailAnnotationId((current) => current === annotation.annotationId ? null : annotation.annotationId); onProtectionAnnotationSelect?.(annotation); }}
                  onPointerDown={(event) => event.stopPropagation()}
                  style={{ left: hasRange ? left : 4, top: 2 + (protectionLayout.laneById.get(annotation.annotationId) ?? 0) * 22, width: hasRange ? Math.min(width, timelineWidth - left) : undefined }}
                  title={`${annotation.tooltipSummary}，来源：${annotation.provenance ?? "创作意图请求"}`}
                  type="button"
                >
                  <span aria-hidden="true">{annotation.isActiveHardConstraint ? "🔒" : annotation.status === "STALE" ? "↻" : "◇"}</span>
                  <b>{annotation.label}</b>
                  <small>{annotation.status === "ACTIVE_HARD_CONSTRAINT" ? "已锁定" : annotation.status === "CANDIDATE_BINDING" ? "候选" : annotation.status === "STALE" ? "需重新确认" : "待确认"}</small>
                </button>;
              })}
            </div>
            <div className="timeline-track audio-track">
              <div
                className="timeline-audio-block"
                style={{
                  left: 0,
                  width: Math.max(4, (draft.audioSelection.selectedDurationMs / 1000) * zoom)
                }}
              >
                <span>主音频，{formatTimeMs(draft.audioSelection.sourceInMs)} → {formatTimeMs(draft.audioSelection.sourceOutMs)}</span>
              </div>
            </div>
            {(["video", "broll"] as const).map((trackType) => {
              const clips = draft.tracks
                .filter((track) => track.type === trackType)
                .flatMap((track) => track.clips);
              return (
                <div className="timeline-track" key={trackType}>
                  {clips.map((clip) => (
                    <div
                      className={`timeline-clip ${selection?.kind === "clip" && selection.id === clip.id ? "selected" : ""}`}
                      key={clip.id}
                      onClick={() => {
                        if (suppressClickRef.current) return;
                        setSelection({ kind: "clip", id: clip.id });
                        seek(clip.timelineStartMs, false);
                      }}
                      onPointerDown={(event) => beginTimelineDrag(event, "clip", clip.id, "move")}
                      style={{
                        left: (clip.timelineStartMs / 1000) * zoom,
                        width: Math.max(8, ((clip.timelineEndMs - clip.timelineStartMs) / 1000) * zoom)
                      }}
                    >
                      <button aria-label="调整片段开始" className="trim-handle start" onPointerDown={(event) => beginTimelineDrag(event, "clip", clip.id, "trim-start")} type="button" />
                      <span><b>{clip.name}</b><small>{averageSpeed(clip.speedCurve).toFixed(2)}×</small></span>
                      <button aria-label="调整片段结束" className="trim-handle end" onPointerDown={(event) => beginTimelineDrag(event, "clip", clip.id, "trim-end")} type="button" />
                    </div>
                  ))}
                </div>
              );
            })}
            <div className="timeline-track caption-track">
              {captionChunks.map((chunk) => (
                <div
                  className="timeline-caption-chunk"
                  key={chunk.id}
                  style={{
                    left: (chunk.startMs / 1000) * zoom,
                    width: Math.max(1, ((chunk.endMs - chunk.startMs) / 1000) * zoom)
                  }}
                >
                  {chunk.captions.map((caption) => (
                    <div
                      className={`timeline-caption ${caption.needsReview ? "needs-review" : ""} ${selection?.kind === "caption" && selection.id === caption.id ? "selected" : ""}`}
                      key={caption.id}
                      onClick={() => {
                        if (suppressClickRef.current) return;
                        setSelection({ kind: "caption", id: caption.id });
                        seek(caption.startMs, false);
                      }}
                      onPointerDown={(event) => beginTimelineDrag(event, "caption", caption.id, "move")}
                      style={{
                        left: ((caption.startMs - chunk.startMs) / 1000) * zoom,
                        width: Math.max(8, ((caption.endMs - caption.startMs) / 1000) * zoom)
                      }}
                    >
                      {selection?.kind === "caption" && selection.id === caption.id && (
                        <button aria-label="调整字幕开始" className="trim-handle start" onPointerDown={(event) => beginTimelineDrag(event, "caption", caption.id, "trim-start")} type="button" />
                      )}
                      <span>{caption.text}</span>
                      {selection?.kind === "caption" && selection.id === caption.id && (
                        <button aria-label="调整字幕结束" className="trim-handle end" onPointerDown={(event) => beginTimelineDrag(event, "caption", caption.id, "trim-end")} type="button" />
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="timeline-track overlay-track">
              {(draft.overlays ?? []).map((overlay) => (
                <div
                  className={`timeline-overlay ${selection?.kind === "overlay" && selection.id === overlay.id ? "selected" : ""}`}
                  key={overlay.id}
                  onClick={() => {
                    setSelection({ kind: "overlay", id: overlay.id });
                    seek(overlay.startMs, false);
                  }}
                  onPointerDown={(event) => beginOverlayTimelineDrag(event, overlay.id, "move")}
                  style={{
                    left: (overlay.startMs / 1000) * zoom,
                    width: Math.max(8, ((overlay.endMs - overlay.startMs) / 1000) * zoom),
                  }}
                >
                  {selection?.kind === "overlay" && selection.id === overlay.id && (
                    <button aria-label="调整叠加层开始" className="trim-handle start" onPointerDown={(event) => beginOverlayTimelineDrag(event, overlay.id, "trim-start")} type="button" />
                  )}
                  <span>{overlay.type === "text" ? (overlay.text || "空文字") : overlay.type === "arrow" ? "箭头" : overlay.type === "rectangle" ? "矩形" : "圆形"}</span>
                  {selection?.kind === "overlay" && selection.id === overlay.id && (
                    <button aria-label="调整叠加层结束" className="trim-handle end" onPointerDown={(event) => beginOverlayTimelineDrag(event, overlay.id, "trim-end")} type="button" />
                  )}
                </div>
              ))}
            </div>
            <div className="timeline-track secondary-audio-track">
              {(draft.secondaryAudioClips ?? []).map((clip) => (
                <div
                  className={`timeline-secondary-audio ${selection?.kind === "secondary-audio" && selection.id === clip.id ? "selected" : ""}`}
                  data-source-type={clip.sourceType}
                  key={clip.id}
                  onClick={() => {
                    if (suppressClickRef.current) return;
                    setSelection({ kind: "secondary-audio", id: clip.id });
                    seek(clip.timelineStartMs, false);
                  }}
                  onPointerDown={(event) => beginSecondaryAudioTimelineDrag(event, clip.id, "move")}
                  style={{
                    left: (clip.timelineStartMs / 1000) * zoom,
                    width: Math.max(8, (secondaryAudioDurationMs(clip) / 1000) * zoom),
                  }}
                  title={`${clip.name}，${formatDragTime(clip.timelineStartMs)}，${formatDragTime(secondaryAudioDurationMs(clip))}`}
                >
                  {selection?.kind === "secondary-audio" && selection.id === clip.id && (
                    <button aria-label="调整声音入点" className="trim-handle start" onPointerDown={(event) => beginSecondaryAudioTimelineDrag(event, clip.id, "trim-start")} type="button" />
                  )}
                  <span><b>{clip.name}</b><small>{formatDragTime(secondaryAudioDurationMs(clip))}</small></span>
                  {selection?.kind === "secondary-audio" && selection.id === clip.id && (
                    <button aria-label="调整声音出点" className="trim-handle end" onPointerDown={(event) => beginSecondaryAudioTimelineDrag(event, clip.id, "trim-end")} type="button" />
                  )}
                </div>
              ))}
            </div>
            <button
              aria-label="移动播放头"
              className="timeline-playhead"
              aria-valuemax={durationMs}
              aria-valuemin={0}
              aria-valuenow={Math.round(playheadMs)}
              onPointerDown={beginPlayheadDrag}
              role="slider"
              style={{ left: (playheadMs / 1000) * zoom }}
              type="button"
            >
              <i />
            </button>
            {dragFeedback && (
              <output
                className="timeline-drag-tooltip"
                style={{ left: clamp((dragFeedback.timeMs / 1000) * zoom, 6, timelineWidth - 112) }}
              >
                <b>{dragFeedback.label} {formatDragTime(dragFeedback.timeMs)}</b>
                {dragFeedback.durationMs !== undefined && <span>时长 {formatDragTime(dragFeedback.durationMs)}</span>}
                {dragFeedback.rate !== undefined && <span>自动变速 {dragFeedback.rate.toFixed(2)}×</span>}
                {snapping && <small>Alt 微调</small>}
              </output>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
