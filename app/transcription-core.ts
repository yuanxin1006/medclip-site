import { clamp, roundMs, type TimelineCaption } from "./editor-core.ts";

export type TranscriptionStage =
  | "waiting"
  | "preparing-audio"
  | "loading-model"
  | "recognizing"
  | "timestamping"
  | "segmenting"
  | "success"
  | "cancelled"
  | "error";

export type TranscriptionChunk = {
  text?: string;
  timestamp?: [number | null, number | null];
  confidence?: number;
};

export type TranscriptionOutput = {
  text?: string;
  chunks?: TranscriptionChunk[];
};

export type SpeechRegion = {
  startMs: number;
  endMs: number;
};

export type TranscriptionFailureCode =
  | "audio-unreadable"
  | "audio-decode"
  | "audio-empty"
  | "model-load"
  | "model-runtime"
  | "no-speech"
  | "result-format"
  | "cancelled";

export class TranscriptionFailure extends Error {
  code: TranscriptionFailureCode;
  stage: TranscriptionStage;

  constructor(
    code: TranscriptionFailureCode,
    stage: TranscriptionStage,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "TranscriptionFailure";
    this.code = code;
    this.stage = stage;
  }
}

export const transcriptionStageLabels: Record<TranscriptionStage, string> = {
  waiting: "等待识别",
  "preparing-audio": "正在准备音频",
  "loading-model": "正在加载模型",
  recognizing: "正在识别",
  timestamping: "正在生成时间戳",
  segmenting: "正在分割字幕",
  success: "识别成功",
  cancelled: "识别已取消",
  error: "识别失败"
};

type TimedWord = {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  needsReview: boolean;
};

const SAMPLE_RATE = 16_000;
export const SHORT_PAUSE_MS = 180;
export const LONG_PAUSE_MS = 480;
const MIN_CAPTION_MS = 450;
const MAX_CAPTION_MS = 6_000;
const MAX_TIMESTAMP_OVERLAP_MS = 180;
const MAX_ACOUSTIC_SNAP_MS = 200;

function stableCaptionId(startMs: number, endMs: number, text: string) {
  let hash = 2166136261;
  const source = `${startMs}:${endMs}:${text}`;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `caption-${startMs}-${(hash >>> 0).toString(36)}`;
}

function normalizeJoinedText(value: string) {
  return value
    .replace(/\s+([，。！？；、,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))];
}

/**
 * Detects actual acoustic activity before the PCM buffer is transferred to the
 * recognition worker. The result is only used to validate/snap ASR boundaries;
 * it never invents a timeline from text length.
 */
export function detectSpeechRegions(
  samples: Float32Array,
  sampleRate = SAMPLE_RATE
): SpeechRegion[] {
  if (!samples.length || sampleRate <= 0) return [];
  const frameSamples = Math.max(1, Math.round(sampleRate * 0.02));
  const hopSamples = Math.max(1, Math.round(sampleRate * 0.01));
  const rmsValues: number[] = [];
  for (let offset = 0; offset < samples.length; offset += hopSamples) {
    const end = Math.min(samples.length, offset + frameSamples);
    let sumSquares = 0;
    for (let index = offset; index < end; index += 1) {
      sumSquares += samples[index] * samples[index];
    }
    rmsValues.push(Math.sqrt(sumSquares / Math.max(1, end - offset)));
  }
  const noiseFloor = percentile(rmsValues, 0.2);
  const speechLevel = percentile(rmsValues, 0.9);
  if (speechLevel < 0.0015) return [];
  const threshold = Math.min(
    speechLevel * 0.68,
    Math.max(0.0025, noiseFloor * 2.4, noiseFloor + (speechLevel - noiseFloor) * 0.14)
  );
  const active = rmsValues.map((rms) => rms >= threshold);

  // Fill sub-100ms internal gaps so unvoiced consonants do not become fake
  // subtitle cuts. Breaths and perceptible pauses remain separate regions.
  for (let index = 0; index < active.length;) {
    if (active[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < active.length && !active[index]) index += 1;
    if (start > 0 && index < active.length && index - start <= 10) {
      for (let cursor = start; cursor < index; cursor += 1) active[cursor] = true;
    }
  }

  // Remove isolated activity shorter than 60ms (clicks and handling noise).
  for (let index = 0; index < active.length;) {
    if (!active[index]) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < active.length && active[index]) index += 1;
    if (index - start < 6) {
      for (let cursor = start; cursor < index; cursor += 1) active[cursor] = false;
    }
  }

  const regions: SpeechRegion[] = [];
  for (let index = 0; index < active.length;) {
    if (!active[index]) {
      index += 1;
      continue;
    }
    const startFrame = index;
    while (index < active.length && active[index]) index += 1;
    const startMs = Math.max(0, roundMs(startFrame * hopSamples / sampleRate * 1000));
    const endMs = Math.min(
      roundMs(samples.length / sampleRate * 1000),
      roundMs(((index - 1) * hopSamples + frameSamples) / sampleRate * 1000)
    );
    if (endMs > startMs) regions.push({ startMs, endMs });
  }
  return regions;
}

function acousticEndForMissingTimestamp(
  startMs: number,
  nextStartMs: number | undefined,
  speechRegions: SpeechRegion[]
) {
  const candidates = speechRegions.filter((region) =>
    region.startMs <= startMs + MAX_ACOUSTIC_SNAP_MS
    && region.endMs > startMs
    && (nextStartMs === undefined || region.endMs <= nextStartMs + MAX_ACOUSTIC_SNAP_MS)
  );
  return candidates.at(-1)?.endMs;
}

function snapCaptionStart(startMs: number, speechRegions: SpeechRegion[]) {
  const region = speechRegions
    .filter((candidate) =>
      Math.abs(candidate.startMs - startMs) <= MAX_ACOUSTIC_SNAP_MS
      && candidate.endMs >= startMs - MAX_ACOUSTIC_SNAP_MS
    )
    .sort((left, right) =>
      Math.abs(left.startMs - startMs) - Math.abs(right.startMs - startMs)
    )[0];
  return region?.startMs ?? startMs;
}

function snapCaptionEnd(endMs: number, speechRegions: SpeechRegion[]) {
  const region = speechRegions
    .filter((candidate) =>
      Math.abs(candidate.endMs - endMs) <= MAX_ACOUSTIC_SNAP_MS
      && candidate.startMs <= endMs + MAX_ACOUSTIC_SNAP_MS
    )
    .sort((left, right) =>
      Math.abs(left.endMs - endMs) - Math.abs(right.endMs - endMs)
    )[0];
  return region?.endMs ?? endMs;
}

function normalizeTimedWords(
  output: TranscriptionOutput,
  durationMs: number,
  speechRegions: SpeechRegion[]
) {
  const safeDurationMs = Math.max(10, roundMs(durationMs));
  const chunks = (output.chunks ?? []).filter((chunk) => chunk.text?.trim());
  if (!chunks.length) {
    if (output.text?.trim()) {
      throw new TranscriptionFailure(
        "result-format",
        "timestamping",
        "识别模型返回了文字，但没有返回第一版句段时间戳，已拒绝使用估算时间。"
      );
    }
    throw new TranscriptionFailure(
      "no-speech",
      "recognizing",
      "未检测到可识别语音。"
    );
  }

  const words: TimedWord[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const rawStart = chunk.timestamp?.[0];
    const rawEnd = chunk.timestamp?.[1];
    const nextRawStart = chunks[index + 1]?.timestamp?.[0];
    if (rawStart === null || rawStart === undefined || !Number.isFinite(rawStart)) {
      throw new TranscriptionFailure(
        "result-format",
        "timestamping",
        `第 ${index + 1} 个识别片段缺少可靠开始时间，已拒绝按文字长度估算。`
      );
    }
    let startMs = clamp(roundMs(rawStart * 1000), 0, safeDurationMs);
    const acousticEnd = rawEnd === null || rawEnd === undefined || !Number.isFinite(rawEnd)
      ? acousticEndForMissingTimestamp(
          startMs,
          nextRawStart === null || nextRawStart === undefined
            ? undefined
            : roundMs(nextRawStart * 1000),
          speechRegions
        )
      : undefined;
    if ((rawEnd === null || rawEnd === undefined || !Number.isFinite(rawEnd)) && acousticEnd === undefined) {
      throw new TranscriptionFailure(
        "result-format",
        "timestamping",
        `第 ${index + 1} 个识别片段缺少结束时间，且无法从实际音频活动中完成强制对齐。`
      );
    }
    let endMs = clamp(
      acousticEnd ?? roundMs((rawEnd as number) * 1000),
      0,
      safeDurationMs
    );
    const previous = words.at(-1);
    let overlapAdjusted = false;
    if (previous && startMs < previous.endMs) {
      const overlapMs = previous.endMs - startMs;
      if (overlapMs > MAX_TIMESTAMP_OVERLAP_MS) {
        throw new TranscriptionFailure(
          "result-format",
          "timestamping",
          `第 ${index + 1} 个识别片段与前一片段重叠 ${overlapMs}ms，时间戳不可靠。`
        );
      }
      startMs = previous.endMs;
      overlapAdjusted = true;
    }
    if (startMs >= safeDurationMs || endMs <= startMs) {
      throw new TranscriptionFailure(
        "result-format",
        "timestamping",
        `第 ${index + 1} 个识别片段的起止时间无效。`
      );
    }
    const confidence = Number.isFinite(chunk.confidence) ? chunk.confidence : undefined;
    words.push({
      text: chunk.text ?? "",
      startMs,
      endMs,
      confidence,
      needsReview: acousticEnd !== undefined
        || overlapAdjusted
        || (confidence !== undefined && confidence < 0.75)
    });
  }
  return words;
}

function hasStrongPunctuation(text: string) {
  return /[。！？!?；;]$/.test(normalizeJoinedText(text));
}

function hasSoftPunctuation(text: string) {
  return /[，,、：:]$/.test(normalizeJoinedText(text));
}

function boundaryScore(words: TimedWord[], index: number, segmentStart: number) {
  const word = words[index];
  const next = words[index + 1];
  const gapMs = next ? Math.max(0, next.startMs - word.endMs) : LONG_PAUSE_MS * 2;
  const durationMs = word.endMs - words[segmentStart].startMs;
  const text = word.text;
  return gapMs * 3
    + (hasStrongPunctuation(text) ? 900 : 0)
    + (hasSoftPunctuation(text) ? 240 : 0)
    - Math.abs(durationMs - 3_500) * 0.06;
}

function naturalBoundary(words: TimedWord[], index: number, segmentStart: number) {
  const word = words[index];
  const next = words[index + 1];
  if (!next) return true;
  const durationMs = word.endMs - words[segmentStart].startMs;
  if (durationMs < MIN_CAPTION_MS) return false;
  const gapMs = Math.max(0, next.startMs - word.endMs);
  if (gapMs >= LONG_PAUSE_MS) return true;
  if (gapMs >= SHORT_PAUSE_MS) return true;
  if (hasStrongPunctuation(word.text)) return true;
  return gapMs >= 120 && hasSoftPunctuation(word.text);
}

function splitTimedWords(words: TimedWord[]) {
  const segments: TimedWord[][] = [];
  let segmentStart = 0;
  let index = 0;
  while (index < words.length) {
    if (naturalBoundary(words, index, segmentStart)) {
      segments.push(words.slice(segmentStart, index + 1));
      segmentStart = index + 1;
      index = segmentStart;
      continue;
    }
    const durationMs = words[index].endMs - words[segmentStart].startMs;
    if (durationMs >= MAX_CAPTION_MS) {
      let bestIndex = segmentStart;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let candidate = segmentStart; candidate <= index; candidate += 1) {
        const candidateDuration = words[candidate].endMs - words[segmentStart].startMs;
        if (candidateDuration < MIN_CAPTION_MS) continue;
        const score = boundaryScore(words, candidate, segmentStart);
        if (score > bestScore) {
          bestScore = score;
          bestIndex = candidate;
        }
      }
      segments.push(words.slice(segmentStart, bestIndex + 1));
      segmentStart = bestIndex + 1;
      index = segmentStart;
      continue;
    }
    index += 1;
  }
  if (segmentStart < words.length) segments.push(words.slice(segmentStart));
  return segments.filter((segment) => segment.length > 0);
}

function captionFromWords(
  words: TimedWord[],
  speechRegions: SpeechRegion[],
  previousWord?: TimedWord,
  nextWord?: TimedWord
): TimelineCaption {
  const text = normalizeJoinedText(words.map((word) => word.text).join(""));
  const confidenceValues = words
    .map((word) => word.confidence)
    .filter((value): value is number => value !== undefined);
  const confidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : undefined;
  const snappedStartMs = snapCaptionStart(words[0].startMs, speechRegions);
  const snappedEndMs = snapCaptionEnd(words.at(-1)!.endMs, speechRegions);
  // A speech region may contain two clauses with no silence between them.
  // Never let acoustic snapping cross the adjacent word boundary.
  const startMs = previousWord && snappedStartMs < previousWord.endMs
    ? words[0].startMs
    : snappedStartMs;
  const endMs = nextWord && snappedEndMs > nextWord.startMs
    ? words.at(-1)!.endMs
    : snappedEndMs;
  return {
    id: stableCaptionId(startMs, endMs, text),
    text,
    startMs,
    endMs,
    confidence,
    needsReview: words.some((word) => word.needsReview)
  };
}

export function validateCaptionTimeline(captions: TimelineCaption[], durationMs: number) {
  const safeDurationMs = Math.max(0, roundMs(durationMs));
  let previousEndMs = 0;
  for (const caption of captions) {
    if (!caption.id || !caption.text.trim()) return false;
    if (!Number.isInteger(caption.startMs) || !Number.isInteger(caption.endMs)) return false;
    if (caption.startMs < previousEndMs || caption.startMs < 0) return false;
    if (caption.endMs <= caption.startMs || caption.endMs > safeDurationMs) return false;
    previousEndMs = caption.endMs;
  }
  return captions.length > 0;
}

/** Apply only to fresh ASR cues. User text never passes through this function. */
export async function simplifyWhisperCaptions(captions: TimelineCaption[]): Promise<TimelineCaption[]> {
  const hasHan = (text: string) => /\p{Script=Han}/u.test(text);
  const convert = captions.some((cue) => hasHan(cue.text))
    ? (await import("opencc-js/t2cn")).Converter({ from: "t", to: "cn" })
    : undefined;
  return captions.map((cue) => ({
    ...cue,
    recognizedText: cue.text,
    text: convert && hasHan(cue.text) ? convert(cue.text) : cue.text,
    provenance: "ASR",
  }));
}

/** Video transcription keeps the model's complete segment timestamps. */
export function videoTranscriptionSegments(output: TranscriptionOutput, durationMs: number): TimelineCaption[] {
  const chunks = (output.chunks ?? []).filter((chunk) => chunk.text?.trim());
  if (!chunks.length) throw new TranscriptionFailure("result-format", "timestamping", "识别未返回带时间码的字幕。");
  let previousEnd = 0;
  return chunks.map((chunk, index) => {
    const [start, end] = chunk.timestamp ?? [];
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new TranscriptionFailure("result-format", "timestamping", `第 ${index + 1} 段缺少完整识别时间码。`);
    }
    const startMs = Math.round(start * 1000);
    const endMs = Math.round(end * 1000);
    if (startMs < previousEnd || endMs <= startMs || endMs > durationMs) {
      throw new TranscriptionFailure("result-format", "timestamping", `第 ${index + 1} 段识别时间码越界或重叠。`);
    }
    previousEnd = endMs;
    return { id: `segment-${index + 1}`, text: chunk.text!.trim(), startMs, endMs, provenance: "ASR" };
  });
}

export function transcriptionOutputToCaptions(
  output: TranscriptionOutput,
  durationMs: number,
  speechRegions: SpeechRegion[] = []
) {
  const words = normalizeTimedWords(output, durationMs, speechRegions);
  const safeDurationMs = Math.max(10, roundMs(durationMs));
  const segments = splitTimedWords(words);
  const captions = segments
    .map((segment, index) => captionFromWords(
      segment,
      speechRegions,
      segments[index - 1]?.at(-1),
      segments[index + 1]?.[0]
    ))
    .map((caption, index, all) => {
      const previousEndMs = index ? all[index - 1].endMs : 0;
      return {
        ...caption,
        startMs: Math.max(previousEndMs, caption.startMs),
        endMs: Math.min(safeDurationMs, caption.endMs)
      };
    })
    .filter((caption) => caption.endMs > caption.startMs && caption.text.trim());

  if (!validateCaptionTimeline(captions, safeDurationMs)) {
    throw new TranscriptionFailure(
      "result-format",
      "segmenting",
      "字幕分割后没有得到有效、非重叠的毫秒时间轴。"
    );
  }
  return captions;
}

function safeReferenceBreak(value: string, desired: number, minimum: number) {
  const characters = Array.from(value);
  const maximum = characters.length;
  const candidates: Array<{ index: number; score: number }> = [];
  for (let index = Math.max(minimum + 1, desired - 12); index <= Math.min(maximum - 1, desired + 12); index += 1) {
    const previous = characters[index - 1] ?? "";
    const next = characters[index] ?? "";
    const breaksTerm = /[A-Za-z0-9]/.test(previous) && /[A-Za-z0-9]/.test(next);
    if (breaksTerm) continue;
    const punctuationBonus = /[。！？!?；;，,、：:\n]/.test(previous) ? 18 : 0;
    const whitespaceBonus = /\s/.test(previous) || /\s/.test(next) ? 8 : 0;
    candidates.push({
      index,
      score: punctuationBonus + whitespaceBonus - Math.abs(index - desired)
    });
  }
  return candidates.sort((left, right) => right.score - left.score)[0]?.index
    ?? Math.min(maximum - 1, Math.max(minimum + 1, desired));
}

/**
 * Keeps every acoustic caption boundary intact while replacing only the text.
 * This avoids the former sentence-count merge that could leave one subtitle
 * visible across a real pause in a known TTS script.
 */
export function applyReferenceTranscript(captions:TimelineCaption[],referenceText:string){
 const reference=referenceText.replace(/\r/g,"").trim();
 if(!reference||!captions.length)return captions;
 const preserve=()=>captions.map(c=>({...c,needsReview:true,recognizedText:c.recognizedText??c.text}));
 const raw=Array.from(reference);
 const filter=(char:string)=>!/[\s\p{P}]/u.test(char);
 const original=captions.flatMap((c,index)=>Array.from(c.text).filter(filter).map(char=>({char:char.toLowerCase(),caption:index})));
 const target=raw.map((char,index)=>({char:char.toLowerCase(),index})).filter(item=>filter(item.char));
 const n=original.length,m=target.length;
 if(!n||!m||n>2048||m>2048)return preserve();
 const columns=m+1,d=new Uint16Array((n+1)*columns);
 for(let i=0;i<=n;i++)d[i*columns]=i;
 for(let j=0;j<=m;j++)d[j]=j;
 for(let i=1;i<=n;i++)for(let j=1;j<=m;j++)d[i*columns+j]=Math.min(d[(i-1)*columns+j]+1,d[i*columns+j-1]+1,d[(i-1)*columns+j-1]+(original[i-1].char===target[j-1].char?0:1));
 if(d[n*columns+m]>Math.max(2,Math.floor(n*.25)))return preserve();
 const operations:Array<{old:number|null;next:number|null}>=[];
 let i=n,j=m;
 while(i||j){
  if(i&&j&&d[i*columns+j]===d[(i-1)*columns+j-1]+(original[i-1].char===target[j-1].char?0:1)){operations.push({old:--i,next:--j});}
  else if(i&&d[i*columns+j]===d[(i-1)*columns+j]+1)operations.push({old:--i,next:null});
  else operations.push({old:null,next:--j});
 }
 operations.reverse();
 // Additional unheard phrases, especially a leading/trailing paragraph, have no acoustic boundary.
 let insertionRun=0;
 for(let k=0;k<operations.length;k++){const op=operations[k];if(op.old===null){insertionRun++;if(insertionRun>2||k===0||k===operations.length-1)return preserve();}else insertionRun=0;}
 const starts=new Array<number>(captions.length).fill(-1);
 for(const op of operations)if(op.old!==null&&op.next!==null){const c=original[op.old].caption;if(starts[c]<0)starts[c]=target[op.next].index;}
 if(starts.some(x=>x<0))return preserve();
 return captions.map((c,index)=>{const text=raw.slice(index===0?0:starts[index],index+1<captions.length?starts[index+1]:raw.length).join("").trim();return{...c,id:stableCaptionId(c.startMs,c.endMs,text),text,recognizedText:c.recognizedText??c.text,needsReview:normalizeJoinedText(c.text)!==normalizeJoinedText(text)};});
}

