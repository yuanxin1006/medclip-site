import {
  createCreativeIntent,
  parseCreativeIntent,
  type CreativeIntentV1,
  type IntentClauseDraft,
} from "./editor-creative-intent.ts";

export const CREATIVE_INTENT_MODEL_SCHEMA_VERSION = 1 as const;

export type CreativeIntentModelOutputV1 = Readonly<{
  schemaVersion: typeof CREATIVE_INTENT_MODEL_SCHEMA_VERSION;
  sourceRequest: string;
  clauses: readonly IntentClauseDraft[];
}>;

export class CreativeIntentIntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreativeIntentIntakeError";
  }
}
function fail(message: string): never {
  throw new CreativeIntentIntakeError(message);
}
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], label: string): void {
  const allowed = new Set(required);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))) {
    fail(`${label} contains missing or unknown fields.`);
  }
}

function modelProvenance(value: unknown, label: string) {
  if (!record(value)) fail(`${label} must be an object.`);
  exactKeys(value, ["schemaVersion", "authority", "sourceReference"], label);
  if (value.schemaVersion !== 1
    || !["MODEL_SUGGESTION", "MODEL_UNCERTAIN_INFERENCE"].includes(String(value.authority))
    || typeof value.sourceReference !== "string"
    || !value.sourceReference.trim()) {
    fail(`${label} must retain model-only provenance.`);
  }
  return value;
}

/**
 * Converts an untrusted model result into the V2.3B domain. The model result
 * deliberately has no project ID, intent ID, clause ID, binding, or active
 * constraint field. The V2.3B constructor and parser remain the trust boundary.
 */
export function parseCreativeIntentModelOutputV1(input: Readonly<{
  modelOutput: unknown;
  projectId: string;
  sourceRequest: string;
  createdAt: string;
}>): CreativeIntentV1 {
  if (!record(input.modelOutput)) fail("Creative-intent model output must be an object.");
  exactKeys(input.modelOutput, ["schemaVersion", "sourceRequest", "clauses"], "Creative-intent model output");
  if (input.modelOutput.schemaVersion !== CREATIVE_INTENT_MODEL_SCHEMA_VERSION) {
    fail("Creative-intent model output has an unsupported schema version.");
  }
  if (input.modelOutput.sourceRequest !== input.sourceRequest) {
    fail("The model must preserve the exact source request.");
  }
  if (!Array.isArray(input.modelOutput.clauses) || input.modelOutput.clauses.length === 0) {
    fail("Creative-intent model output must contain clauses.");
  }
  input.modelOutput.clauses.forEach((clause, index) => {
    if (!record(clause)) fail(`clauses[${index}] must be an object.`);
    exactKeys(clause, ["kind", "payload", "provenance"], `clauses[${index}]`);
    modelProvenance(clause.provenance, `clauses[${index}].provenance`);
    // Trusted identity and binding fields are rejected by the exact-key checks
    // here and by the V2.3B parser below.
  });
  const hasHardRequest = input.modelOutput.clauses.some((clause) => record(clause) && clause.kind === "HARD_CONSTRAINT_REQUEST");
  const created = createCreativeIntent({
    version: 1,
    projectId: input.projectId,
    sourceRequest: input.sourceRequest,
    clauses: input.modelOutput.clauses,
    groundingState: hasHardRequest ? "UNRESOLVED_REFERENCE" : "NOT_REQUIRED",
    resolutionIds: [],
    createdAt: input.createdAt,
  });
  return parseCreativeIntent(created);
}
