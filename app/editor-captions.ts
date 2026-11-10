import {outputCanvasSize} from "./editor-output-settings.ts";
import type { TimelineCaption } from "./editor-core.ts";

export type CaptionProvenance = "ASR" | "IMPORTED_SRT" | "IMPORTED_VTT" | "IMPORTED_ASS" | "MANUAL";
export type CaptionAlignment = "left" | "center" | "right";

export type CaptionPresentation = Readonly<{
  x: number;
  y: number;
  color: string;
  alignment: CaptionAlignment;
  opacity: number;
  fontSize: number;
}>;

export const MIN_CAPTION_DURATION_MS = 50;
export const DEFAULT_CAPTION_PRESENTATION: CaptionPresentation = Object.freeze({
  x: 0.5,
  y: 0.9,
  color: "#ffffff",
  alignment: "center",
  opacity: 1,
  fontSize: 42,
});

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const validColor = (value: unknown) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

export function captionPresentation(caption: TimelineCaption): CaptionPresentation {
  return {
    x: clamp(finite(caption.x, DEFAULT_CAPTION_PRESENTATION.x), 0.05, 0.95),
    y: clamp(finite(caption.y, DEFAULT_CAPTION_PRESENTATION.y), 0.08, 0.95),
    color: validColor(caption.color) ? caption.color!.toLowerCase() : DEFAULT_CAPTION_PRESENTATION.color,
    alignment: ["left", "center", "right"].includes(caption.alignment ?? "")
      ? caption.alignment as CaptionAlignment
      : DEFAULT_CAPTION_PRESENTATION.alignment,
    opacity: clamp(finite(caption.opacity, DEFAULT_CAPTION_PRESENTATION.opacity), 0.1, 1),
    fontSize: clamp(Math.round(finite(caption.fontSize, DEFAULT_CAPTION_PRESENTATION.fontSize)), 12, 120),
  };
}

export function patchCaption(
  caption: TimelineCaption,
  patch: Partial<TimelineCaption>,
  projectDurationMs: number,
): TimelineCaption {
  const projectDuration = Math.max(MIN_CAPTION_DURATION_MS, Math.round(finite(projectDurationMs, 1_000)));
  const requestedStart = Math.round(finite(patch.startMs, caption.startMs));
  const requestedEnd = Math.round(finite(patch.endMs, caption.endMs));
  const startMs = clamp(requestedStart, 0, projectDuration - MIN_CAPTION_DURATION_MS);
  const endMs = clamp(requestedEnd, startMs + MIN_CAPTION_DURATION_MS, projectDuration);
  const presentation = captionPresentation({ ...caption, ...patch, startMs, endMs });
  return {
    ...caption,
    ...patch,
    text: String(patch.text ?? caption.text),
    startMs,
    endMs,
    ...presentation,
  };
}

export function applyCaptionPresentationToAll(
  captions: readonly TimelineCaption[],
  source: TimelineCaption,
) {
  const presentation = captionPresentation(source);
  return captions.map((caption) => ({ ...caption, ...presentation }));
}

export function splitCaption(
  caption: TimelineCaption,
  atMs: number,
  firstId: string,
  secondId: string,
): readonly [TimelineCaption, TimelineCaption] {
  const splitAt = Math.round(atMs);
  if (splitAt - caption.startMs < MIN_CAPTION_DURATION_MS || caption.endMs - splitAt < MIN_CAPTION_DURATION_MS) {
    throw new RangeError("字幕分割点必须为两侧保留有效时长。");
  }
  const punctuation = [...caption.text.matchAll(/[，。！？；、,.!?;]/g)]
    .map((match) => (match.index ?? 0) + 1)
    .filter((index) => index > caption.text.length * 0.25 && index < caption.text.length * 0.75);
  const textAt = punctuation[0] ?? Math.max(1, Math.floor(caption.text.length / 2));
  const firstText = caption.text.slice(0, textAt).trim();
  const secondText = caption.text.slice(textAt).trim();
  return [
    { ...caption, id: firstId, text: firstText, endMs: splitAt },
    { ...caption, id: secondId, text: secondText, startMs: splitAt },
  ];
}

export function mergeAdjacentCaptions(current: TimelineCaption, following: TimelineCaption) {
  const gap = following.startMs - current.endMs;
  if (gap < 0 || gap > 1_000) throw new RangeError("仅支持合并相邻或间隔不超过 1 秒的字幕。");
  return {
    ...current,
    endMs: following.endMs,
    ...(current.videoClipId !== following.videoClipId ? { videoClipId: undefined } : {}),
    text: `${current.text}${/[，。！？；、,!?;]$/.test(current.text) ? "" : " "}${following.text}`,
    needsReview: current.needsReview || following.needsReview,
  };
}

function parseTimestamp(value: string, ass = false) {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length !== 3) return undefined;
  const [hours, minutes, seconds] = parts.map(Number);
  if (![hours, minutes, seconds].every(Number.isFinite) || hours < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return undefined;
  const ms = Math.round((hours * 3_600 + minutes * 60 + seconds) * 1_000);
  return ass ? Math.round(ms / 10) * 10 : ms;
}

function cleanCueText(value: string) {
  return value
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function normalizedCue(
  text: string,
  startMs: number | undefined,
  endMs: number | undefined,
  durationMs: number,
  provenance: CaptionProvenance,
  index: number,
  presentation?: Partial<CaptionPresentation>,
) {
  const cleanedText = cleanCueText(text);
  if (
    startMs === undefined || endMs === undefined || endMs <= startMs
    || endMs <= 0 || startMs >= durationMs || !cleanedText
  ) return null;
  const start = clamp(Math.round(startMs), 0, Math.max(0, durationMs - MIN_CAPTION_DURATION_MS));
  const end = clamp(Math.round(endMs), start + MIN_CAPTION_DURATION_MS, durationMs);
  if (end <= start) return null;
  return patchCaption({
    id: `imported-${provenance.toLowerCase()}-${index + 1}`,
    text: cleanedText,
    startMs: start,
    endMs: end,
    provenance,
    ...presentation,
  }, {}, durationMs);
}

function parseSrtOrVtt(text: string, durationMs: number, format: "srt" | "vtt") {
  const provenance: CaptionProvenance = format === "srt" ? "IMPORTED_SRT" : "IMPORTED_VTT";
  const blocks = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n{2,}/);
  const cues: TimelineCaption[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startRaw, endRawWithSettings] = lines[timingIndex].split("-->");
    const endRaw = endRawWithSettings?.trim().split(/\s+/)[0] ?? "";
    const cue = normalizedCue(
      lines.slice(timingIndex + 1).join("\n"),
      parseTimestamp(startRaw ?? ""),
      parseTimestamp(endRaw),
      durationMs,
      provenance,
      cues.length,
    );
    if (cue) cues.push(cue);
  }
  return cues;
}

function assAlignmentPresentation(text: string): Partial<CaptionPresentation> {
  const alignment = Number(text.match(/\\an([1-9])/)?.[1]);
  if (!alignment) return {};
  const column = (alignment - 1) % 3;
  const row = Math.floor((alignment - 1) / 3);
  return {
    x: column === 0 ? 0.12 : column === 1 ? 0.5 : 0.88,
    y: row === 0 ? 0.9 : row === 1 ? 0.5 : 0.12,
    alignment: column === 0 ? "left" : column === 1 ? "center" : "right",
  };
}

function parseAss(text: string, durationMs: number) {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  let fields = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  const cues: TimelineCaption[] = [];
  let inEvents = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^\[events\]$/i.test(line)) { inEvents = true; continue; }
    if (/^\[/.test(line)) { inEvents = false; continue; }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      fields = line.slice(line.indexOf(":") + 1).split(",").map((field) => field.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const payload = line.slice(line.indexOf(":") + 1).trim();
    const values = payload.split(",");
    if (values.length < fields.length) continue;
    const record: Record<string, string> = {};
    fields.forEach((field, index) => {
      record[field] = index === fields.length - 1 ? values.slice(index).join(",") : values[index] ?? "";
    });
    const rawText = record.text ?? "";
    const cue = normalizedCue(
      rawText,
      parseTimestamp(record.start ?? "", true),
      parseTimestamp(record.end ?? "", true),
      durationMs,
      "IMPORTED_ASS",
      cues.length,
      assAlignmentPresentation(rawText),
    );
    if (cue) cues.push(cue);
  }
  return cues;
}

export function parseSubtitleFile(text: string, fileName: string, durationMs: number) {
  if (!text.trim()) throw new Error("字幕文件为空。");
  if (text.includes("\uFFFD")) throw new Error("字幕文件编码无法读取，请转换为 UTF-8。");
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!extension || !["srt", "vtt", "ass"].includes(extension)) {
    throw new Error("仅支持 SRT、VTT 或 ASS 字幕文件。");
  }
  const safeDuration = Math.max(MIN_CAPTION_DURATION_MS, Math.round(finite(durationMs, 1_000)));
  const captions = extension === "ass"
    ? parseAss(text, safeDuration)
    : parseSrtOrVtt(text, safeDuration, extension as "srt" | "vtt");
  if (!captions.length) throw new Error("字幕文件格式无效，未找到可用的时间码字幕。");
  return { format: extension as "srt" | "vtt" | "ass", captions };
}

export function activeCaptionAt(captions: readonly TimelineCaption[] | undefined, timelineMs: number) {
  return (captions ?? []).filter(c=>timelineMs>=c.startMs&&timelineMs<c.endMs).sort((a,b)=>b.startMs-a.startMs||(a.endMs-a.startMs)-(b.endMs-b.startMs))[0];
}

export type CaptionCanvasContext = Pick<CanvasRenderingContext2D,
  "save" | "restore" | "fillText" | "strokeText" | "measureText"
  | "globalAlpha" | "font" | "lineWidth" | "strokeStyle" | "fillStyle" | "textAlign" | "textBaseline"
>;

function isLightColor(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150;
}

export function drawEditorCaptionAt(
  context: CaptionCanvasContext,
  captions: readonly TimelineCaption[] | undefined,
  timelineMs: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  const caption = activeCaptionAt(captions, timelineMs);
  if (!caption?.text.trim()) return null;
  const style = captionPresentation(caption);
  const scale = canvasHeight / 1_080;
  context.save();
  context.globalAlpha = style.opacity;
  context.font = `700 ${Math.max(12, Math.round(style.fontSize * scale))}px Microsoft YaHei, sans-serif`;
  context.lineWidth = Math.max(2, Math.round(canvasWidth / 420));
  context.strokeStyle = isLightColor(style.color) ? "rgba(0, 0, 0, 0.9)" : "rgba(255, 255, 255, 0.9)";
  context.fillStyle = style.color;
  context.textAlign = style.alignment;
  context.textBaseline = "middle";

  const lines=captionTextLayout(caption.text,t=>context.measureText(t).width,canvasWidth*.84);
  const lineHeight=Math.max(12,Math.round(style.fontSize*scale))*1.4;
  const anchor=captionSafeAnchor(style,canvasWidth,canvasHeight,Math.max(...lines.map(line=>context.measureText(line).width),0),lines.length*lineHeight);
  const x=anchor.x,y=anchor.y;
  lines.forEach((line,index)=>{const lineY=y+(index-(lines.length-1)/2)*lineHeight;context.strokeText(line,x,lineY);context.fillText(line,x,lineY);});
  context.restore();
  return caption;
}

export function captionCanvasSize(ratio:string){return outputCanvasSize(ratio);}
export function captionTextLayout(text:string,measure:(text:string)=>number,maxWidth:number):string[]{
 const lines:string[]=[];
 for(const paragraph of text.replace(/\r/g,"").split("\n")){
  let line="";
  for(const character of Array.from(paragraph)){
   if(line&&measure(line+character)>maxWidth){lines.push(line);line=character;}else line+=character;
  }
  lines.push(line);
 }
 return lines;
}
export function captionTimelineHasOverlap(captions:readonly TimelineCaption[]){
 const sorted=[...captions].sort((a,b)=>a.startMs-b.startMs);let end=-Infinity;
 for(const cue of sorted){if(cue.startMs<end)return true;end=Math.max(end,cue.endMs);}
 return false;
}
export function captionOutlineColor(color:string){return isLightColor(color)?"rgba(0, 0, 0, 0.9)":"rgba(255, 255, 255, 0.9)";}

export function captionSafeAnchor(style:CaptionPresentation,width:number,height:number,blockWidth:number,blockHeight:number){
 const margin=Math.max(2,Math.round(width/420))*2;
 if(blockHeight>height-margin*2||blockWidth>width-margin*2)throw Error('字幕内容超出当前画布，请减小字号或拆分字幕后导出；未截断文本。');
 const left=style.alignment==='left'?0:style.alignment==='right'?blockWidth:blockWidth/2;
 return {x:clamp(style.x*width,margin+left,width-margin-(blockWidth-left)),y:clamp(style.y*height,margin+blockHeight/2,height-margin-blockHeight/2)};
}
