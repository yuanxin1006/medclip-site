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
      : !actionableClipCount ? "MEDIA_NOT_AVAILABLE" as const : "READY" as const,
    timelineClipCount,
    actionableClipCount,
  };
}

export function editorVisualContextMessage(status: ReturnType<typeof inspectEditorVisualContext>["status"]) {
  return status === "NO_TIMELINE_CLIPS"
    ? "当前工程尚无可操作的视频时间线片段。上传素材或完成字幕识别不会自动创建片段，请先生成剪辑预览。"
    : status === "MEDIA_NOT_AVAILABLE"
      ? "时间线片段存在，但对应本地素材未关联或素材身份不匹配。请先重新关联素材并生成剪辑预览。"
      : "";
}
