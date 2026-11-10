import type { AITaskResultValue } from "./types.ts";

export type CreativeIntentSchemaMismatch = (
  missingFields: readonly string[],
  invalidFields: readonly string[],
) => never;

export const EDITOR_CREATIVE_INTENT_TASK_INSTRUCTION = [
  "Analyze the user's natural-language creative requirement into non-executable intent clauses only.",
  "Never output editing actions, clipId, assetId, captionId, project ranges, bindings, constraints, or ACTIVE_HARD_CONSTRAINT.",
  "Preserve input.editingRequirement exactly in sourceRequest.",
  "Return exactly {schemaVersion,sourceRequest,clauses}; schemaVersion is 1.",
  "Each clause contains exactly kind, payload, provenance. Provenance contains schemaVersion:1, authority MODEL_SUGGESTION or MODEL_UNCERTAIN_INFERENCE, and a non-empty sourceReference copied from the request.",
  "Supported GOAL payload: {type:'TARGET_DURATION',durationMs:<positive integer>,policy:'TARGET'|'APPROXIMATE_TARGET'|'MAXIMUM'|'MINIMUM'|'EXACT'}.",
  "Supported SOFT_PREFERENCE payload: {type:'PACE',value:'UPBEAT'}.",
  "Supported HARD_CONSTRAINT_REQUEST payload: {type:'PROTECT_TIME_RANGE'|'PROTECT_CLIP'|'PRESERVE_ENDING',reference:{schemaVersion:1,state:'UNRESOLVED_REFERENCE',semanticKind:'SPEECH'|'VISUAL_OBJECT'|'ENDING_CONTENT'|'OTHER',referenceText:'...'}}.",
  "A semantic protection request always remains UNRESOLVED_REFERENCE. The user, not the model, must confirm any trusted target.",
] as const;

const provenanceSchema = {
  type: "object", additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    authority: { enum: ["MODEL_SUGGESTION", "MODEL_UNCERTAIN_INFERENCE"] },
    sourceReference: { type: "string", minLength: 1, maxLength: 2_000 },
  },
  required: ["schemaVersion", "authority", "sourceReference"],
};

export const EDITOR_CREATIVE_INTENT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    sourceRequest: { type: "string", minLength: 1, maxLength: 24_000 },
    clauses: {
      type: "array", minItems: 1, maxItems: 128,
      items: {
        oneOf: [
          {
            type: "object", additionalProperties: false, required: ["kind", "payload", "provenance"],
            properties: {
              kind: { const: "GOAL" }, provenance: provenanceSchema,
              payload: { type: "object", additionalProperties: false, required: ["type", "durationMs", "policy"], properties: {
                type: { const: "TARGET_DURATION" }, durationMs: { type: "integer", minimum: 1 },
                policy: { enum: ["TARGET", "APPROXIMATE_TARGET", "MAXIMUM", "MINIMUM", "EXACT"] },
              } },
            },
          },
          {
            type: "object", additionalProperties: false, required: ["kind", "payload", "provenance"],
            properties: {
              kind: { const: "SOFT_PREFERENCE" }, provenance: provenanceSchema,
              payload: { type: "object", additionalProperties: false, required: ["type", "value"], properties: { type: { const: "PACE" }, value: { const: "UPBEAT" } } },
            },
          },
          {
            type: "object", additionalProperties: false, required: ["kind", "payload", "provenance"],
            properties: {
              kind: { const: "HARD_CONSTRAINT_REQUEST" }, provenance: provenanceSchema,
              payload: { type: "object", additionalProperties: false, required: ["type", "reference"], properties: {
                type: { enum: ["PROTECT_TIME_RANGE", "PROTECT_CLIP", "PRESERVE_ENDING"] },
                reference: { type: "object", additionalProperties: false, required: ["schemaVersion", "state", "semanticKind", "referenceText"], properties: {
                  schemaVersion: { const: 1 }, state: { const: "UNRESOLVED_REFERENCE" },
                  semanticKind: { enum: ["SPEECH", "VISUAL_OBJECT", "ENDING_CONTENT", "OTHER"] },
                  referenceText: { type: "string", minLength: 1, maxLength: 2_000 },
                } },
              } },
            },
          },
        ],
      },
    },
  },
  required: ["schemaVersion", "sourceRequest", "clauses"],
});

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[], prefix: string, mismatch: CreativeIntentSchemaMismatch) {
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key)).map((key) => `${prefix}${key}`);
  const invalid = Object.keys(value).some((key) => !keys.includes(key)) ? [`${prefix}$unknown`] : [];
  if (missing.length || invalid.length) mismatch(missing, invalid);
}
function text(value: unknown, field: string, mismatch: CreativeIntentSchemaMismatch, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /\u0000/.test(value)) mismatch([], [field]);
  return value;
}
function provenance(value: unknown, prefix: string, mismatch: CreativeIntentSchemaMismatch) {
  if (!record(value)) mismatch([], [prefix]);
  exact(value, ["schemaVersion", "authority", "sourceReference"], `${prefix}.`, mismatch);
  if (value.schemaVersion !== 1 || !["MODEL_SUGGESTION", "MODEL_UNCERTAIN_INFERENCE"].includes(String(value.authority))) mismatch([], [prefix]);
  return { schemaVersion: 1, authority: String(value.authority), sourceReference: text(value.sourceReference, `${prefix}.sourceReference`, mismatch) };
}

export function validateEditorCreativeIntentPlan(
  value: unknown,
  mismatch: CreativeIntentSchemaMismatch,
  expectedSourceRequest?: unknown,
): Readonly<Record<string, AITaskResultValue>> {
  if (!record(value)) mismatch([], ["$root"]);
  exact(value, ["schemaVersion", "sourceRequest", "clauses"], "", mismatch);
  if (value.schemaVersion !== 1) mismatch([], ["schemaVersion"]);
  const sourceRequest = text(value.sourceRequest, "sourceRequest", mismatch, 24_000);
  if (typeof expectedSourceRequest !== "string" || sourceRequest !== expectedSourceRequest) mismatch([], ["sourceRequest"]);
  if (!Array.isArray(value.clauses) || value.clauses.length < 1 || value.clauses.length > 128) mismatch([], ["clauses"]);
  const clauses = value.clauses.map((candidate, index) => {
    const prefix = `clauses[${index}]`;
    if (!record(candidate)) mismatch([], [prefix]);
    exact(candidate, ["kind", "payload", "provenance"], `${prefix}.`, mismatch);
    const modelProvenance = provenance(candidate.provenance, `${prefix}.provenance`, mismatch);
    if (!record(candidate.payload)) mismatch([], [`${prefix}.payload`]);
    if (candidate.kind === "GOAL") {
      exact(candidate.payload, ["type", "durationMs", "policy"], `${prefix}.payload.`, mismatch);
      if (candidate.payload.type !== "TARGET_DURATION" || !Number.isSafeInteger(candidate.payload.durationMs) || Number(candidate.payload.durationMs) <= 0
        || !["TARGET", "APPROXIMATE_TARGET", "MAXIMUM", "MINIMUM", "EXACT"].includes(String(candidate.payload.policy))) mismatch([], [`${prefix}.payload`]);
    } else if (candidate.kind === "SOFT_PREFERENCE") {
      exact(candidate.payload, ["type", "value"], `${prefix}.payload.`, mismatch);
      if (candidate.payload.type !== "PACE" || candidate.payload.value !== "UPBEAT") mismatch([], [`${prefix}.payload`]);
    } else if (candidate.kind === "HARD_CONSTRAINT_REQUEST") {
      exact(candidate.payload, ["type", "reference"], `${prefix}.payload.`, mismatch);
      if (!["PROTECT_TIME_RANGE", "PROTECT_CLIP", "PRESERVE_ENDING"].includes(String(candidate.payload.type)) || !record(candidate.payload.reference)) mismatch([], [`${prefix}.payload`]);
      const reference = candidate.payload.reference;
      exact(reference, ["schemaVersion", "state", "semanticKind", "referenceText"], `${prefix}.payload.reference.`, mismatch);
      if (reference.schemaVersion !== 1 || reference.state !== "UNRESOLVED_REFERENCE"
        || !["SPEECH", "VISUAL_OBJECT", "ENDING_CONTENT", "OTHER"].includes(String(reference.semanticKind))) mismatch([], [`${prefix}.payload.reference`]);
      text(reference.referenceText, `${prefix}.payload.reference.referenceText`, mismatch);
    } else mismatch([], [`${prefix}.kind`]);
    return { kind: String(candidate.kind), payload: candidate.payload, provenance: modelProvenance };
  });
  return { schemaVersion: 1, sourceRequest, clauses } as Readonly<Record<string, AITaskResultValue>>;
}
