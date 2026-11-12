import {
  parseAudioRhythmAnalysis,
  type AudioRhythmAnalysis,
} from "./editor-audio-rhythm.ts";
import {
  MULTIMODAL_MATCHING_LIMITS,
  normalizeMatchingConcept,
} from "./editor-multimodal-matching.ts";
import {
  parseVideoSemanticAnalysis,
  type VideoSemanticAnalysis,
} from "./editor-video-semantic.ts";

export const MUSIC_VIDEO_LINKAGE_SCHEMA_VERSION = 1 as const;

export type MusicSectionKindV1 = "INTRO" | "VERSE" | "CHORUS" | "BRIDGE" | "OUTRO" | "OTHER";
export type MusicEvidenceSourceV1 = "LYRIC_TIMECODE" | "SECTION_BOUNDARY" | "EVEN_DISTRIBUTION" | "LOCAL_RHYTHM"
  | "USER_TIMED" | "USER_LYRICS_DISTRIBUTED" | "SESSION_EVIDENCE";

export type MusicLyricEvidenceV1 = Readonly<{
  id: string;
  text: string;
  semanticTags: readonly string[];
  startMs?: number;
  endMs?: number;
}>;

export type MusicSectionEvidenceV1 = Readonly<{
  id: string;
  startMs: number;
  endMs: number;
  kind: MusicSectionKindV1;
  semanticSummary?: string;
  semanticTags?: readonly string[];
}>;

export type MusicSegmentV1 = Readonly<{
  id: string;
  sourceId: string;
  startMs: number;
  endMs: number;
  lyricText: string;
  semanticSummary: string;
  semanticTags: readonly string[];
  sectionKind: MusicSectionKindV1;
  energy: number | null;
  evidenceSources: readonly MusicEvidenceSourceV1[];
}>;

export type VideoSceneV1 = Readonly<{
  sceneId: string;
  assetId: string;
  assetDurationMs: number;
  startMs: number;
  endMs: number;
  semanticTags: readonly string[];
  semanticSummary: string;
  usability: number;
  confidence: number;
  rhythmSuitability: number | null;
  evidenceSource: VideoSemanticAnalysis["analysisMethod"];
  analysisVersion: string;
  evidenceFrameMs: readonly number[];
}>;

export class MusicVideoLinkageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicVideoLinkageValidationError";
  }
}

function fail(message: string): never {
  throw new MusicVideoLinkageValidationError(message);
}

export function assertMusicVideoIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 512
    || /\u0000/.test(value) || /^(?:blob:|file:|https?:)/i.test(value) || /[\\/]/.test(value)) {
    fail(`${label} must be a bounded trusted identity.`);
  }
  return value;
}

function safeTime(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > MULTIMODAL_MATCHING_LIMITS.maxAssetDurationMs) {
    fail(`${label} must be a bounded safe integer millisecond value.`);
  }
  return Number(value);
}

function safeScore(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be a finite normalized score.`);
  }
  return value;
}

function safeText(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > 2_000 || /\u0000/.test(value)) fail(`${label} must be bounded text.`);
  const text = value.trim();
  if (!allowEmpty && !text) fail(`${label} must not be empty.`);
  return text;
}

function semanticTags(value: readonly string[] | undefined, label: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 16) fail(`${label} must be a bounded array.`);
  const normalized = value.map((item, index) => {
    const tag = normalizeMatchingConcept(safeText(item, `${label}[${index}]`));
    if (tag.length > 120) fail(`${label}[${index}] exceeds the supported length.`);
    return tag;
  });
  if (new Set(normalized).size !== normalized.length) fail(`${label} contains duplicate normalized values.`);
  return Object.freeze(normalized);
}

export function roundMusicVideoScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000) / 1_000_000;
}

function overlappingEnergy(rhythm: AudioRhythmAnalysis | undefined, startMs: number, endMs: number): number | null {
  if (!rhythm) return null;
  let weighted = 0;
  let duration = 0;
  rhythm.segments.forEach((segment) => {
    const overlap = Math.max(0, Math.min(endMs, segment.endMs) - Math.max(startMs, segment.startMs));
    weighted += overlap * segment.energy;
    duration += overlap;
  });
  return duration ? roundMusicVideoScore(weighted / duration) : null;
}

function sectionFor(
  sections: readonly MusicSectionEvidenceV1[],
  startMs: number,
  endMs: number,
): MusicSectionEvidenceV1 | undefined {
  const midpoint = startMs + (endMs - startMs) / 2;
  return sections.find((section) => midpoint >= section.startMs && midpoint < section.endMs)
    ?? sections.find((section) => Math.max(0, Math.min(endMs, section.endMs) - Math.max(startMs, section.startMs)) > 0);
}

export function segmentMusicForVideoLinkage(input: Readonly<{
  sourceId: string;
  durationMs: number;
  lyrics?: readonly MusicLyricEvidenceV1[];
  lyricTimingProvenance?: "USER_TIMED" | "USER_LYRICS_DISTRIBUTED" | "SESSION_EVIDENCE";
  sections?: readonly MusicSectionEvidenceV1[];
  rhythm?: AudioRhythmAnalysis;
}>): readonly MusicSegmentV1[] {
  const sourceId = assertMusicVideoIdentity(input.sourceId, "sourceId");
  const durationMs = safeTime(input.durationMs, "durationMs", 1);
  const rhythm = input.rhythm ? parseAudioRhythmAnalysis(input.rhythm) : undefined;
  if (rhythm && (rhythm.sourceId !== sourceId || rhythm.sourceDurationMs !== durationMs)) {
    fail("Rhythm evidence must belong to the same music source and duration.");
  }
  const sections = Object.freeze([...(input.sections ?? [])].map((section, index) => {
    const startMs = safeTime(section.startMs, `sections[${index}].startMs`);
    const endMs = safeTime(section.endMs, `sections[${index}].endMs`, 1);
    if (endMs <= startMs || endMs > durationMs) fail(`sections[${index}] has an invalid range.`);
    if (!(["INTRO", "VERSE", "CHORUS", "BRIDGE", "OUTRO", "OTHER"] as const).includes(section.kind)) {
      fail(`sections[${index}].kind is unsupported.`);
    }
    return Object.freeze({
      id: assertMusicVideoIdentity(section.id, `sections[${index}].id`),
      startMs,
      endMs,
      kind: section.kind,
      ...(section.semanticSummary === undefined ? {} : { semanticSummary: safeText(section.semanticSummary, `sections[${index}].semanticSummary`) }),
      ...(section.semanticTags === undefined ? {} : { semanticTags: semanticTags(section.semanticTags, `sections[${index}].semanticTags`) }),
    });
  }));
  if (new Set(sections.map((section) => section.id)).size !== sections.length) fail("Music section IDs must be unique.");

  const lyrics = [...(input.lyrics ?? [])];
  if (lyrics.length > MULTIMODAL_MATCHING_LIMITS.maxIntervals) fail("Lyrics exceed the supported music segment count.");
  if (!lyrics.length && !sections.length) return Object.freeze([]);
  const sources = lyrics.length ? lyrics : sections.map((section) => ({
    id: section.id,
    text: section.semanticSummary ?? "",
    semanticTags: section.semanticTags ?? [],
    startMs: section.startMs,
    endMs: section.endMs,
  }));
  const timedCount = sources.filter((line) => line.startMs !== undefined || line.endMs !== undefined).length;
  if (timedCount !== 0 && timedCount !== sources.length) fail("Lyrics must be either all timed or all untimed.");
  const segmentDuration = durationMs / sources.length;
  const result = sources.map((line, index) => {
    const id = assertMusicVideoIdentity(line.id, `lyrics[${index}].id`);
    const lyricText = safeText(line.text, `lyrics[${index}].text`, !lyrics.length);
    const startMs = line.startMs === undefined ? Math.round(index * segmentDuration) : safeTime(line.startMs, `lyrics[${index}].startMs`);
    const endMs = line.endMs === undefined
      ? index === sources.length - 1 ? durationMs : Math.round((index + 1) * segmentDuration)
      : safeTime(line.endMs, `lyrics[${index}].endMs`, 1);
    if (endMs <= startMs || endMs > durationMs) fail(`lyrics[${index}] has an invalid range.`);
    const section = sectionFor(sections, startMs, endMs);
    const tags = semanticTags(line.semanticTags?.length ? line.semanticTags : section?.semanticTags, `lyrics[${index}].semanticTags`);
    const energy = overlappingEnergy(rhythm, startMs, endMs);
    const evidenceSources: MusicEvidenceSourceV1[] = [
      input.lyricTimingProvenance
        ?? (timedCount ? "LYRIC_TIMECODE" : sections.length ? "SECTION_BOUNDARY" : "EVEN_DISTRIBUTION"),
      ...(rhythm ? ["LOCAL_RHYTHM" as const] : []),
    ];
    return Object.freeze({
      id,
      sourceId,
      startMs,
      endMs,
      lyricText,
      semanticSummary: section?.semanticSummary ?? lyricText,
      semanticTags: tags,
      sectionKind: section?.kind ?? "OTHER",
      energy,
      evidenceSources: Object.freeze(evidenceSources),
    });
  });
  if (new Set(result.map((segment) => segment.id)).size !== result.length) fail("Music segment IDs must be unique.");
  return Object.freeze(result);
}

export function normalizeVideoSceneIndex(input: Readonly<{
  analyses: readonly VideoSemanticAnalysis[];
  rhythmSuitabilityBySceneId?: Readonly<Record<string, number>>;
}>): readonly VideoSceneV1[] {
  const analyses = input.analyses.map(parseVideoSemanticAnalysis);
  if (new Set(analyses.map((analysis) => analysis.assetId)).size !== analyses.length) fail("Video analyses must have unique asset IDs.");
  const scenes = analyses.flatMap((analysis) => analysis.segments.map((segment) => {
    const suppliedRhythm = input.rhythmSuitabilityBySceneId?.[segment.id];
    return Object.freeze({
      sceneId: segment.id,
      assetId: segment.assetId,
      assetDurationMs: analysis.assetDurationMs,
      startMs: segment.startMs,
      endMs: segment.endMs,
      semanticTags: Object.freeze([...segment.concepts]),
      semanticSummary: segment.summary,
      usability: segment.usability,
      confidence: segment.confidence,
      rhythmSuitability: suppliedRhythm === undefined ? null : safeScore(suppliedRhythm, `rhythmSuitabilityBySceneId.${segment.id}`),
      evidenceSource: analysis.analysisMethod,
      analysisVersion: analysis.analysisVersion,
      evidenceFrameMs: Object.freeze([...segment.evidenceFrameMs]),
    });
  }));
  if (new Set(scenes.map((scene) => scene.sceneId)).size !== scenes.length) fail("Video scene IDs must be globally unique.");
  return Object.freeze(scenes.sort((left, right) => left.assetId.localeCompare(right.assetId)
    || left.startMs - right.startMs || left.sceneId.localeCompare(right.sceneId)));
}
