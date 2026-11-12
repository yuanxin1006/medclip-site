import type { ConstraintSetV1, EnforcementReadyBindingV1 } from "./editor-constraints.ts";
import type { CandidateBindingRecordV1, ConfirmedBindingRecordV1 } from "./editor-constraint-grounding.ts";
import type { CreativeIntentV1, HardConstraintRequestIntentClause } from "./editor-creative-intent.ts";
import { sourceTimeAtTimelineMs, type EditorProject } from "./editor-core.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";

export type ProtectedTimelineStatusV1 = "UNRESOLVED_REFERENCE" | "CANDIDATE_BINDING" | "ACTIVE_HARD_CONSTRAINT" | "STALE";
export type ProtectedTimelineAnnotationV1 = Readonly<{
  annotationId: string; constraintId?: string; bindingId?: string; sourceClauseId: string;
  label: string; protectionKind: string; status: ProtectedTimelineStatusV1;
  timelineStart: number; timelineEnd: number; coordinateSpace: "TIMELINE";
  sourceAssetId?: string; sourceStart?: number; sourceEnd?: number;
  provenance?: string; isActiveHardConstraint: boolean; isStale: boolean;
  tooltipSummary: string; forbiddenEdits: readonly string[];
}>;

type Span = { start: number; end: number; assetId?: string; sourceStart?: number; sourceEnd?: number };

function bindingSpans(binding: EnforcementReadyBindingV1, project: EditorProject): Span[] {
  if (binding.bindingType === "CLIP") {
    const clips = project.tracks.flatMap((track) => track.clips).filter((clip) => clip.id === binding.clipId && clip.assetId === binding.assetId && clip.trackId === binding.trackId);
    return clips.map((clip) => ({ start: clip.timelineStartMs, end: clip.timelineEndMs, assetId: clip.assetId, sourceStart: clip.sourceInMs, sourceEnd: clip.sourceOutMs }));
  }
  if (binding.bindingType === "CAPTION") {
    const captions = project.captions.filter((caption) => caption.id === binding.captionId);
    return captions.map((caption) => ({ start: caption.startMs, end: caption.endMs }));
  }
  if (binding.bindingType === "TIME_RANGE" && binding.range.coordinateSpace === "TIMELINE") {
    return [{ start: binding.range.startMs, end: binding.range.endMs }];
  }
  let assetId: string;
  let sourceStart: number;
  let sourceEnd: number;
  if (binding.bindingType === "TIME_RANGE") {
    if (binding.range.coordinateSpace !== "SOURCE_ASSET") return [];
    assetId = binding.range.assetId;
    sourceStart = binding.range.startMs;
    sourceEnd = binding.range.endMs;
  } else if (binding.bindingType === "VIDEO_SEMANTIC_SOURCE_RANGE") {
    assetId = binding.assetId;
    sourceStart = binding.startMs;
    sourceEnd = binding.endMs;
  } else return [];
  const spans: Span[] = [];
  for (const clip of project.tracks.flatMap((track) => track.clips).filter((item) => item.assetId === assetId)) {
    const overlapStart = Math.max(sourceStart, clip.sourceInMs);
    const overlapEnd = Math.min(sourceEnd, clip.sourceOutMs);
    if (overlapEnd <= overlapStart) continue;
    const invert = (sourceMs: number) => {
      let low = clip.timelineStartMs;
      let high = clip.timelineEndMs;
      for (let i = 0; i < 28; i += 1) {
        const mid = (low + high) / 2;
        if (sourceTimeAtTimelineMs(clip, mid) < sourceMs) low = mid;
        else high = mid;
      }
      return (low + high) / 2;
    };
    const start = invert(overlapStart);
    const end = invert(overlapEnd);
    if (end > start) spans.push({ start, end, assetId, sourceStart: overlapStart, sourceEnd: overlapEnd });
  }
  return spans;
}

function forbiddenEdits(set: ConstraintSetV1 | undefined, constraintId?: string): string[] {
  const permissions = set?.activeConstraints.find((item) => item.constraintId === constraintId)?.permissions;
  if (!permissions) return [];
  const pairs: [keyof typeof permissions, string][] = [
    ["allowMove", "移动"], ["allowTrim", "修剪"], ["allowTransformChange", "变换"],
    ["allowCaptionTextChange", "字幕修改"], ["allowSpeedChange", "变速"], ["allowAssetReplace", "替换素材"],
    ["allowDelete", "删除"], ["allowSplit", "分割"], ["allowTimingChange", "时间调整"],
  ];
  return pairs.filter(([key]) => !permissions[key]).map(([, label]) => label);
}

export function deriveProtectedTimelineAnnotationsV1(input: Readonly<{
  project: EditorProject; intent?: CreativeIntentV1 | null; constraintSet?: ConstraintSetV1;
  confirmedBindings?: readonly ConfirmedBindingRecordV1[]; candidateBindings?: readonly CandidateBindingRecordV1[];
}>): readonly ProtectedTimelineAnnotationV1[] {
  const { project, intent, constraintSet } = input;
  const fingerprint = createEditorProjectFingerprint(project);
  const currentSet = constraintSet && constraintSet.projectId === project.id
    && constraintSet.validatedAgainstProjectFingerprint === fingerprint ? constraintSet : undefined;
  const clauses = intent?.clauses.filter((clause): clause is HardConstraintRequestIntentClause => clause.kind === "HARD_CONSTRAINT_REQUEST") ?? [];
  const annotations: ProtectedTimelineAnnotationV1[] = [];
  const confirmed = input.confirmedBindings ?? [];
  const candidates = input.candidateBindings ?? [];
  const clauseLabel = (clauseId: string) => clauses.find((item) => item.clauseId === clauseId)?.payload.reference.referenceText ?? "受保护内容";
  for (const clause of clauses) {
    const record = confirmed.find((item) => item.sourceClauseId === clause.clauseId);
    const candidate = candidates.find((item) => item.sourceClauseId === clause.clauseId);
    const active = currentSet?.activeConstraints.find((item) => item.sourceClauseId === clause.clauseId);
    const recordIsCurrent = !!record && record.validatedAgainstProjectFingerprint === fingerprint
      && record.intentVersionId === intent?.intentId;
    const binding = active ? currentSet!.confirmedBindings.find((item) => item.bindingId === active.bindingId)
      : candidate?.binding ?? (recordIsCurrent ? record!.binding : record?.binding);
    const spans = binding ? bindingSpans(binding, project) : [];
    const mappingFailed = !!binding && spans.length === 0;
    const candidateIsStale = !!candidate && (candidate.validatedAgainstProjectFingerprint !== fingerprint || candidate.intentVersionId !== intent?.intentId);
    const status: ProtectedTimelineStatusV1 = (record && (!recordIsCurrent || (constraintSet !== undefined && !currentSet))) || candidateIsStale || (active !== undefined && mappingFailed)
      ? "STALE" : active ? "ACTIVE_HARD_CONSTRAINT" : candidate && candidate.validatedAgainstProjectFingerprint === fingerprint
        ? "CANDIDATE_BINDING" : "UNRESOLVED_REFERENCE";
    const label = clauseLabel(clause.clauseId);
    const protectionKind = clause.payload.type;
    const whyProtected = protectionKind === "PRESERVE_ENDING" ? "创作意图要求保留结尾内容" : protectionKind === "PROTECT_CLIP" ? "创作意图要求保护指定片段" : "创作意图要求保护指定时间范围";
    const sourceText = active?.confirmationStatus === "USER_CONFIRMED" ? "用户确认" : active?.confirmationStatus === "TRUSTED_PROJECT_FACT" ? "可信项目事实" : "创作意图请求";
    const edits = forbiddenEdits(currentSet, active?.constraintId);
    const summaries = spans.length ? spans : [{ start: 0, end: 0 }];
    summaries.forEach((span, index) => {
      const statusText = status === "ACTIVE_HARD_CONSTRAINT" ? "已确认并锁定" : status === "CANDIDATE_BINDING" ? "候选范围，待确认" : status === "STALE" ? "需要重新确认" : "待确认";
      annotations.push(Object.freeze({
        annotationId: `${clause.clauseId}:${binding?.bindingId ?? status}:${index}`,
        ...(active ? { constraintId: active.constraintId } : {}), ...(binding ? { bindingId: binding.bindingId } : {}),
        sourceClauseId: clause.clauseId, label, protectionKind, status,
        timelineStart: span.start, timelineEnd: span.end, coordinateSpace: "TIMELINE",
        ...(span.assetId ? { sourceAssetId: span.assetId } : {}), ...(span.sourceStart !== undefined ? { sourceStart: span.sourceStart, sourceEnd: span.sourceEnd } : {}),
        provenance: sourceText, isActiveHardConstraint: status === "ACTIVE_HARD_CONSTRAINT", isStale: status === "STALE",
        tooltipSummary: `${label}，${statusText}${span.end > span.start ? `，${Math.round(span.start / 1000)}–${Math.round(span.end / 1000)} 秒` : "，尚无可信时间范围"}。原因：${whyProtected}。来源：${sourceText}${edits.length ? `。禁止：${edits.join("、")}` : ""}`,
        forbiddenEdits: Object.freeze(edits),
      }));
    });
  }
  return Object.freeze(annotations);
}
