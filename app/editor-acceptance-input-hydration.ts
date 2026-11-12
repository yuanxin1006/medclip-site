import type { EditorProject } from "./editor-core.ts";
import {
  parseAudioRhythmAnalysis,
  type AudioRhythmAnalysis,
} from "./editor-audio-rhythm.ts";
import {
  parseVideoSemanticAnalysis,
  VideoSemanticAnalysisCache,
  type VideoSemanticAnalysis,
} from "./editor-video-semantic.ts";

export const ACCEPTANCE_INPUT_HYDRATION_BUILD_ENABLED =
  process.env.NEXT_PUBLIC_MEDCLIP_ACCEPTANCE_INPUT_HYDRATION === "1";
export const ACCEPTANCE_EDITOR_INPUT_EVIDENCE_GLOBAL =
  "__MEDCLIP_ACCEPTANCE_INPUT_EVIDENCE__" as const;
export const ACCEPTANCE_EDITOR_INPUT_EVIDENCE_VERSION = 1 as const;

export type AcceptanceEditorInputEvidenceV1 = Readonly<{
  version: typeof ACCEPTANCE_EDITOR_INPUT_EVIDENCE_VERSION;
  semanticEvidence: readonly VideoSemanticAnalysis[];
  rhythmEvidence?: AudioRhythmAnalysis;
}>;

export type AcceptanceInputHydrationResult = Readonly<{
  status: "DISABLED" | "NO_PAYLOAD" | "HYDRATED" | "REJECTED";
  fixtureVersion: number | null;
  semanticAssetCount: number;
  rhythmEvidencePresent: boolean;
  category: "BUILD_DISABLED" | "PAYLOAD_ABSENT" | "SUCCESS" | "INVALID_PAYLOAD" | "CACHE_NOT_EMPTY";
  rhythmEvidence?: AudioRhythmAnalysis;
}>;

const FORBIDDEN_DOWNSTREAM_KEYS = new Set([
  "constraintset",
  "hardconstraints",
  "activehardconstraints",
  "feasibility",
  "feasibilityresult",
  "negotiationresolution",
  "readytoplan",
  "proposal",
  "proposalbundle",
  "collaborativeoptions",
  "canonicalactions",
  "humanreview",
  "humanreviewdecisions",
  "reviewstate",
  "safemodificationcandidates",
  "executionresult",
  "executionhistory",
  "history",
  "undoredo",
  "evaluatorresult",
  "evaluation",
  "typeddefect",
  "typeddefects",
  "defect",
  "defects",
  "repairproposal",
  "repairresult",
  "safenochange",
  "decisionexplanation",
  "decisionexplanations",
  "stalestate",
]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function rejectForbiddenDownstreamState(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new TypeError("Acceptance input payload must be acyclic.");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) rejectForbiddenDownstreamState(item, seen);
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_DOWNSTREAM_KEYS.has(normalizedKey(key))) {
        throw new TypeError("Acceptance input payload contains forbidden downstream state.");
      }
      rejectForbiddenDownstreamState(child, seen);
    }
  }
  seen.delete(value);
}

export function parseAcceptanceEditorInputEvidenceV1(
  value: unknown,
  project: EditorProject,
): AcceptanceEditorInputEvidenceV1 {
  rejectForbiddenDownstreamState(value);
  if (!plainRecord(value)) throw new TypeError("Acceptance input evidence must be an object.");
  const keys = Object.keys(value);
  if (
    !Object.hasOwn(value, "version")
    || !Object.hasOwn(value, "semanticEvidence")
    || keys.some((key) => !["version", "semanticEvidence", "rhythmEvidence"].includes(key))
  ) {
    throw new TypeError("Acceptance input evidence has missing or unknown top-level fields.");
  }
  if (value.version !== ACCEPTANCE_EDITOR_INPUT_EVIDENCE_VERSION) {
    throw new TypeError("Unsupported acceptance input evidence version.");
  }
  if (!Array.isArray(value.semanticEvidence) || value.semanticEvidence.length === 0) {
    throw new TypeError("Acceptance input evidence requires semantic analyses.");
  }

  const semanticEvidence = value.semanticEvidence.map(parseVideoSemanticAnalysis);
  const projectAssets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const semanticAssetIds = semanticEvidence.map((analysis) => analysis.assetId);
  if (new Set(semanticAssetIds).size !== semanticAssetIds.length) {
    throw new TypeError("Acceptance input evidence contains duplicate asset analyses.");
  }
  if (
    semanticEvidence.some((analysis) => {
      const asset = projectAssets.get(analysis.assetId);
      return !asset || asset.durationMs !== analysis.assetDurationMs;
    })
    || project.assets.some((asset) => !semanticAssetIds.includes(asset.id))
  ) {
    throw new TypeError("Acceptance semantic evidence must exactly cover project assets and durations.");
  }

  const rhythmEvidence = value.rhythmEvidence === undefined
    ? undefined
    : parseAudioRhythmAnalysis(value.rhythmEvidence);
  if (rhythmEvidence && rhythmEvidence.sourceDurationMs !== project.audioSelection.sourceDurationMs) {
    throw new TypeError("Acceptance rhythm evidence duration must match the project audio source.");
  }

  return Object.freeze({
    version: ACCEPTANCE_EDITOR_INPUT_EVIDENCE_VERSION,
    semanticEvidence: Object.freeze(semanticEvidence),
    ...(rhythmEvidence ? { rhythmEvidence } : {}),
  });
}

export function hydrateAcceptanceEditorInputEvidenceV1(input: Readonly<{
  buildEnabled?: boolean;
  payload: unknown;
  project: EditorProject;
  semanticCache: VideoSemanticAnalysisCache;
}>): AcceptanceInputHydrationResult {
  if (!(input.buildEnabled ?? ACCEPTANCE_INPUT_HYDRATION_BUILD_ENABLED)) {
    return Object.freeze({
      status: "DISABLED", fixtureVersion: null, semanticAssetCount: 0,
      rhythmEvidencePresent: false, category: "BUILD_DISABLED",
    });
  }
  if (input.payload === undefined) {
    return Object.freeze({
      status: "NO_PAYLOAD", fixtureVersion: null, semanticAssetCount: 0,
      rhythmEvidencePresent: false, category: "PAYLOAD_ABSENT",
    });
  }
  if (input.semanticCache.size !== 0) {
    return Object.freeze({
      status: "REJECTED", fixtureVersion: null, semanticAssetCount: 0,
      rhythmEvidencePresent: false, category: "CACHE_NOT_EMPTY",
    });
  }

  let parsed: AcceptanceEditorInputEvidenceV1;
  try {
    parsed = parseAcceptanceEditorInputEvidenceV1(input.payload, input.project);
  } catch {
    return Object.freeze({
      status: "REJECTED",
      fixtureVersion: plainRecord(input.payload) && typeof input.payload.version === "number"
        ? input.payload.version : null,
      semanticAssetCount: 0,
      rhythmEvidencePresent: false,
      category: "INVALID_PAYLOAD",
    });
  }

  for (const analysis of parsed.semanticEvidence) input.semanticCache.set(analysis);
  return Object.freeze({
    status: "HYDRATED",
    fixtureVersion: parsed.version,
    semanticAssetCount: parsed.semanticEvidence.length,
    rhythmEvidencePresent: parsed.rhythmEvidence !== undefined,
    category: "SUCCESS",
    ...(parsed.rhythmEvidence ? { rhythmEvidence: parsed.rhythmEvidence } : {}),
  });
}

declare global {
  interface Window {
    __MEDCLIP_ACCEPTANCE_INPUT_EVIDENCE__?: unknown;
  }
}
