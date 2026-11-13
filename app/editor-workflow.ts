import {cloneProject,DEFAULT_TRANSFORM,DEFAULT_SPEED_CURVE,editorProjectDurationMs,type EditorProject} from "./editor-core.ts";
import {sameLocalMedia} from "./editor-local-media.ts";
export const EDITOR_FLOW_STAGES = [
 {id:"materials",title:"添加素材",optional:false},
 {id:"sound",title:"声音与字幕",optional:true},
 {id:"assistant",title:"AI 辅助剪辑",optional:true},
 {id:"finish",title:"精剪与导出",optional:false},
] as const;
export type EditorFlowStage=typeof EDITOR_FLOW_STAGES[number]["id"];
export type OwnedVisualAsset=EditorProject["assets"][number];
export function appendOwnedVisualAsset(project:EditorProject,owned:readonly OwnedVisualAsset[],assetId:string,clipId:string):EditorProject {
 const asset=owned.find(a=>a.id===assetId);
 if(!asset||!clipId||project.tracks.some(t=>t.clips.some(c=>c.id===clipId)))throw new Error("请先上传可用的画面素材。");
 const duration=asset.durationMs;
 if(!Number.isSafeInteger(duration)||duration<=0||!["视频","图片"].includes(asset.kind))throw new Error("无法读取素材时长，请先检查文件。");
 const next=cloneProject(project);let track=next.tracks.find(t=>t.type==="video");
 if(!track){track={id:"video-main",type:"video",name:"主视频",clips:[]};next.tracks.push(track);}
 const start=Math.max(0,...track.clips.map(c=>c.timelineEndMs));
 track.clips.push({id:clipId,assetId:asset.id,name:asset.name,kind:asset.kind,trackId:track.id,timelineStartMs:start,timelineEndMs:start+duration,sourceInMs:0,sourceOutMs:duration,transform:{...DEFAULT_TRANSFORM},speedCurve:DEFAULT_SPEED_CURVE.map(p=>({...p})),reason:"用户添加素材"});
 const registry=new Map(next.assets.map(a=>[a.id,a]));for(const a of owned)registry.set(a.id,{...a});next.assets=[...registry.values()];
 next.durationMs=editorProjectDurationMs(next);return next;
}
export function validateVisualRelink(
  expected: OwnedVisualAsset,
  actual: Pick<OwnedVisualAsset, "name" | "kind" | "durationMs" | "mediaIdentity">,
  legacyConfirmed = false,
): void {
  if (expected.kind !== actual.kind) throw new Error("素材类型与工程记录不一致，原有片段已保留。");
  if (expected.kind === "视频" && (!Number.isFinite(actual.durationMs) || Math.abs(expected.durationMs - actual.durationMs) > 50)) {
    throw new Error("文件时长与工程记录不一致，原有片段已保留。");
  }
  if (expected.mediaIdentity) {
    if (!sameLocalMedia(expected.mediaIdentity, actual.mediaIdentity)) {
      throw new Error("文件大小或内容与工程记录不一致，请选择原文件。");
    }
  } else if (!legacyConfirmed || expected.name !== actual.name || !actual.mediaIdentity) {
    throw new Error("旧工程没有原文件指纹。请在待关联列表中核对原文件并手动确认。");
  }
}
export function friendlyEditingError(error:{status:string;message:string}):string{
 const messages:Record<string,string>={SOURCE_RANGE_UNSUPPORTED:"请先在精剪中按所选字幕的起止分割片段，再生成建议。",MISSING_VIDEO_EVIDENCE:"尚无可信的画面分析，请先分析已上传视频。",MISSING_INTERVALS:"请先识别或导入带时间的字幕，也可以跳过 AI 直接剪辑。",NO_VALID_CANDIDATE:"无法可靠判断匹配镜头，你可以手动选片。",UNRESOLVED_INTERVAL:"部分区间没有可靠镜头，请人工选择。",NEGOTIATION_NOT_READY:"请先确认需要保留的内容和保护范围。"};
 return messages[error.status]??(/editorContext|canonical|schema/i.test(error.message)?"这次建议未能安全生成，请调整要求或手动剪辑。":error.message);
}
