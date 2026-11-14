import type { EditorProject } from "./editor-core.ts";
import { createSafeEditorAIContext } from "./editor-ai-requirements.ts";

/** UI preflight only; it never creates clips, invents ownership, or runs an executor. */
export function inspectEditorVisualContext(project: EditorProject, ownedAssetIds: ReadonlySet<string>) {
  const timelineClipCount = project.tracks.filter((track) => track.type === "video" || track.type === "broll")
    .reduce((count, track) => count + track.clips.length, 0);
  const context = JSON.parse(createSafeEditorAIContext(project, ownedAssetIds, 0)) as {
    clips: readonly { positionScaleEligible: boolean }[];
  };
  const actionableClipCount = context.clips.filter((clip) => clip.positionScaleEligible).length;
  return {
    status: !timelineClipCount ? "NO_TIMELINE_CLIPS" as const
      : actionableClipCount !== timelineClipCount ? "MEDIA_NOT_AVAILABLE" as const : "READY" as const,
    timelineClipCount,
    actionableClipCount,
  };
}

export function editorVisualContextMessage(status: ReturnType<typeof inspectEditorVisualContext>["status"]) {
  return status === "NO_TIMELINE_CLIPS"
    ? "当前工程没有可操作的时间线片段。请从添加素材步骤建立时间线，或在精剪中添加片段。"
    : status === "MEDIA_NOT_AVAILABLE"
      ? "时间线中的本地文件尚未全部关联。请在添加素材中重新关联原文件，保留现有剪辑。"
      : "";
}
