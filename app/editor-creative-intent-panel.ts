import { createElement as h } from "react";
import type { CreativeIntentSessionV1 } from "./editor-creative-intent-session.ts";
import type { GroundingSelectionV1 } from "./editor-constraint-grounding.ts";
import type { EditorProject, TimelineClip } from "./editor-core.ts";
import type { HardConstraintRequestIntentClause } from "./editor-creative-intent.ts";

export type CreativeIntentPanelProps = Readonly<{
  session: CreativeIntentSessionV1;
  project: EditorProject;
  onConfirmGrounding: (sourceClauseId: string, selection: GroundingSelectionV1) => void;
}>;

function formatMs(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1_000));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
function allClips(project: EditorProject): readonly TimelineClip[] {
  return project.tracks.flatMap((track) => track.clips)
    .sort((left, right) => left.timelineStartMs - right.timelineStartMs || left.id.localeCompare(right.id));
}
const UUID_LIKE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const OPAQUE_HASH = /^(?:(?:clip|asset|binding|constraint|caption|track|project|intent|clause|annotation|plan|repair|option|evaluation)[-_][a-z0-9_-]+|[0-9a-f]{24,})$/i;

export function resolveSafeProtectionDisplayLabel(candidates: readonly (string | null | undefined)[], internalIds: readonly (string | null | undefined)[], fallback: string): string {
  const ids = new Set(internalIds.filter((value): value is string => !!value));
  for (const candidate of candidates) {
    const label = candidate?.trim();
    if (!label || ids.has(label) || UUID_LIKE.test(label) || OPAQUE_HASH.test(label)) continue;
    return label;
  }
  return fallback;
}

type ConfirmedBinding = NonNullable<CreativeIntentSessionV1["constraintSet"]>["confirmedBindings"][number];
function protectedDisplayLabel(clause: HardConstraintRequestIntentClause | undefined, binding: ConfirmedBinding | undefined, project: EditorProject): string {
  const clip = binding?.bindingType === "CLIP"
    ? project.tracks.flatMap((track) => track.clips).find((item) => item.id === binding.clipId && item.assetId === binding.assetId && item.trackId === binding.trackId)
    : undefined;
  const assetId = binding?.bindingType === "CLIP" ? binding.assetId
    : binding?.bindingType === "VIDEO_SEMANTIC_SOURCE_RANGE" ? binding.assetId
      : binding?.bindingType === "TIME_RANGE" && binding.range.coordinateSpace === "SOURCE_ASSET" ? binding.range.assetId
        : undefined;
  const asset = assetId ? project.assets.find((item) => item.id === assetId) : undefined;
  const requestLabel = clause?.payload.reference.referenceText;
  return resolveSafeProtectionDisplayLabel(
    [clip?.name, requestLabel, asset?.name],
    [binding?.bindingId, binding?.bindingType === "CLIP" ? binding.clipId : undefined, binding?.bindingType === "CAPTION" ? binding.captionId : undefined, binding?.bindingType === "CLIP" || binding?.bindingType === "VIDEO_SEMANTIC_SOURCE_RANGE" ? binding.assetId : undefined, binding?.bindingType === "TIME_RANGE" && binding.range.coordinateSpace === "SOURCE_ASSET" ? binding.range.assetId : undefined, clip?.id, asset?.id],
    binding?.bindingType === "CLIP" ? "已确认片段" : "受保护内容",
  );
}

function protectedRangeLabel(binding: ConfirmedBinding | undefined, project: EditorProject): string {
  if (!binding) return "已确认范围";
  if (binding.bindingType === "TIME_RANGE") return `${formatMs(binding.range.startMs)}–${formatMs(binding.range.endMs)}`;
  if (binding.bindingType === "CLIP") {
    const clip = project.tracks.flatMap((track) => track.clips).find((item) => item.id === binding.clipId && item.assetId === binding.assetId && item.trackId === binding.trackId);
    return clip ? `${formatMs(clip.timelineStartMs)}–${formatMs(clip.timelineEndMs)}` : "已确认片段";
  }
  if (binding.bindingType === "CAPTION") {
    const caption = project.captions.find((item) => item.id === binding.captionId);
    return caption ? `${formatMs(caption.startMs)}–${formatMs(caption.endMs)}` : "已确认字幕范围";
  }
  if (binding.bindingType === "VIDEO_SEMANTIC_SOURCE_RANGE") return `${formatMs(binding.startMs)}–${formatMs(binding.endMs)}`;
  return "待确认";
}

export function CreativeIntentPanel({ session, project, onConfirmGrounding }: CreativeIntentPanelProps) {
  if (!session.intent || session.status === "NO_INTENT" || session.status === "ANALYZING_INTENT") return null;
  const confirmedClauseIds = new Set(session.confirmedBindings.map((item) => item.sourceClauseId));
  const unresolved = session.intent.clauses.filter((clause) => clause.kind === "HARD_CONSTRAINT_REQUEST" && !confirmedClauseIds.has(clause.clauseId));
  const clips = allClips(project);
  const endingClips = clips.filter((clip) => clip.timelineEndMs === project.durationMs);

  return h("section", { className: "creative-intent-panel", "aria-label": "创作意图与保护确认" },
    h("header", null, h("strong", null, "创作意图"), h("span", null, session.status)),
    unresolved.map((clause) => {
      if (clause.kind !== "HARD_CONSTRAINT_REQUEST") return null;
      const speech = clause.payload.reference.semanticKind === "SPEECH";
      const requestLabel = resolveSafeProtectionDisplayLabel([clause.payload.reference.referenceText], [], speech ? "讲话内容" : "受保护内容");
      const clipSelection = clause.payload.type === "PROTECT_CLIP" || clause.payload.type === "PRESERVE_ENDING";
      const candidates = clause.payload.type === "PRESERVE_ENDING"
        ? endingClips
        : clipSelection || !speech ? clips : project.captions;
      return h("article", { className: "creative-intent-grounding-card", key: clause.clauseId },
        h("strong", null, `${requestLabel}需要确认`),
        h("p", null, speech
          ? `我还不能可靠确定${requestLabel}的准确范围，请确认需要保护的片段。`
          : `当前无法可靠确认${requestLabel}对应的具体内容，请确认需要保护的片段。`),
        h("p", null, `保护要求：${requestLabel}`),
        candidates.length ? h("div", { className: "creative-intent-grounding-candidates" },
          ...candidates.map((candidate) => {
            if (!clipSelection && speech && "text" in candidate) return h("button", {
              type: "button", key: candidate.id,
              onClick: () => onConfirmGrounding(clause.clauseId, { bindingType: "CAPTION", captionId: candidate.id }),
            }, `确认保护字幕范围 ${formatMs(candidate.startMs)}–${formatMs(candidate.endMs)}，${resolveSafeProtectionDisplayLabel([candidate.text], [candidate.id], "字幕")}`);
            const clip = candidate as TimelineClip;
            return h("button", {
              type: "button", key: clip.id,
              onClick: () => onConfirmGrounding(clause.clauseId, { bindingType: "CLIP", clipId: clip.id }),
            }, `确认保护${clause.payload.type === "PRESERVE_ENDING" ? "结尾" : speech ? "讲话" : "画面"}片段 ${formatMs(clip.timelineStartMs)}–${formatMs(clip.timelineEndMs)}，${resolveSafeProtectionDisplayLabel([clip.name], [clip.id, clip.assetId], "已确认片段")}`);
          }),
        ) : h("p", { role: "alert" }, speech ? "当前没有可确认的字幕/讲话范围。" : "当前没有可确认的结尾片段。"),
        h("small", null, "候选内容不是已识别事实；只有您的确认会创建可信绑定。"),
      );
    }),
    session.constraintSet && session.constraintSet.activeConstraints.length ? h("div", { className: "creative-intent-protection-summary" },
      h("strong", null, "已确认保护："),
      h("ul", null, ...session.constraintSet.activeConstraints.map((constraint) => {
        const source = session.intent?.clauses.find((clause) => clause.clauseId === constraint.sourceClauseId);
        const binding = session.constraintSet?.confirmedBindings.find((item) => item.bindingId === constraint.bindingId && item.state === "ACTIVE_HARD_CONSTRAINT");
        const label = protectedDisplayLabel(source?.kind === "HARD_CONSTRAINT_REQUEST" ? source : undefined, binding, project);
        return h("li", { key: constraint.constraintId }, `${label} ${protectedRangeLabel(binding, project)}`);
      })),
      h("p", null, "约束状态：已生效"),
    ) : null,
  );
}
