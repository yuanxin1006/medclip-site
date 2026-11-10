import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATIVE_INTENT_SCHEMA_VERSION,
  CreativeIntentValidationError,
  createCreativeIntent,
  parseCreativeIntent,
  type CreativeIntentDraft,
  type DomainProvenanceV1,
  type IntentClauseDraft,
} from "./editor-creative-intent.ts";

const createdAt = "2026-10-25T08:00:00.000Z";
const projectId = "project-medical-demo";

const userTextProvenance: DomainProvenanceV1 = Object.freeze({
  schemaVersion: 1,
  authority: "USER_TEXT",
  sourceReference: "sourceRequest",
});

function unresolved(
  referenceText: string,
  semanticKind: "SPEECH" | "VISUAL_OBJECT" | "ENDING_CONTENT" | "OTHER",
) {
  return {
    schemaVersion: 1 as const,
    state: "UNRESOLVED_REFERENCE" as const,
    semanticKind,
    referenceText,
  };
}

function clauses(): readonly IntentClauseDraft[] {
  return [
    {
      kind: "GOAL",
      payload: { type: "TARGET_DURATION", durationMs: 30_000, policy: "APPROXIMATE_TARGET" },
      provenance: userTextProvenance,
    },
    {
      kind: "SOFT_PREFERENCE",
      payload: { type: "PACE", value: "UPBEAT" },
      provenance: userTextProvenance,
    },
    {
      kind: "HARD_CONSTRAINT_REQUEST",
      payload: { type: "PROTECT_TIME_RANGE", reference: unresolved("老师完整讲话", "SPEECH") },
      provenance: userTextProvenance,
    },
    {
      kind: "HARD_CONSTRAINT_REQUEST",
      payload: { type: "PRESERVE_ENDING", reference: unresolved("结尾学校Logo", "ENDING_CONTENT") },
      provenance: userTextProvenance,
    },
  ];
}

function draft(overrides: Partial<CreativeIntentDraft> = {}): CreativeIntentDraft {
  return {
    version: 1,
    projectId,
    sourceRequest: "剪成30秒左右，节奏轻快，但老师讲话必须完整，学校Logo不能删。",
    clauses: clauses(),
    groundingState: "UNRESOLVED_REFERENCE",
    resolutionIds: [],
    createdAt,
    ...overrides,
  };
}

test("A: valid CreativeIntentV1 is strict, deeply immutable, and round-trips through its parser", () => {
  const intent = createCreativeIntent(draft());
  assert.equal(intent.schemaVersion, CREATIVE_INTENT_SCHEMA_VERSION);
  assert.match(intent.intentId, /^intent-v1-[0-9a-f]{8}$/);
  assert.equal(intent.clauses.length, 4);
  assert.equal(Object.isFrozen(intent), true);
  assert.equal(Object.isFrozen(intent.clauses), true);
  assert.equal(Object.isFrozen(intent.clauses[0].payload), true);
  assert.deepEqual(parseCreativeIntent(intent), intent);
});

test("B/I: deterministic intent and clause IDs exclude createdAt metadata", () => {
  const first = createCreativeIntent(draft({ createdAt: "2026-10-25T08:00:00.000Z" }));
  const second = createCreativeIntent(draft({ createdAt: "2026-10-25T09:30:00.000Z" }));
  assert.equal(first.intentId, second.intentId);
  assert.deepEqual(first.clauses.map((clause) => clause.clauseId), second.clauses.map((clause) => clause.clauseId));
  assert.notEqual(first.createdAt, second.createdAt);
});

test("C: original sourceRequest is preserved verbatim, including surrounding whitespace and newlines", () => {
  const sourceRequest = "  剪成30秒左右。\n老师讲话必须完整。  ";
  const intent = createCreativeIntent(draft({ sourceRequest }));
  assert.equal(intent.sourceRequest, sourceRequest);
  assert.equal(parseCreativeIntent(intent).sourceRequest, sourceRequest);
});

test("D/E/F: GOAL, SOFT_PREFERENCE, and HARD_CONSTRAINT_REQUEST remain distinct typed clauses", () => {
  const intent = createCreativeIntent(draft());
  assert.deepEqual(intent.clauses.map((clause) => clause.kind), [
    "GOAL",
    "SOFT_PREFERENCE",
    "HARD_CONSTRAINT_REQUEST",
    "HARD_CONSTRAINT_REQUEST",
  ]);
  assert.deepEqual(intent.clauses.map((clause) => clause.payload.type), [
    "TARGET_DURATION",
    "PACE",
    "PROTECT_TIME_RANGE",
    "PRESERVE_ENDING",
  ]);
});

test("F: semantic hard-constraint requests remain unresolved and contain no invented trusted identity", () => {
  const hard = createCreativeIntent(draft()).clauses.find((clause) => clause.kind === "HARD_CONSTRAINT_REQUEST")!;
  assert.equal(hard.payload.reference.state, "UNRESOLVED_REFERENCE");
  assert.equal(hard.payload.reference.referenceText, "老师完整讲话");
  assert.equal("clipId" in hard.payload.reference, false);
  assert.equal("assetId" in hard.payload.reference, false);
  assert.equal("startMs" in hard.payload.reference, false);
});

test("G: unknown clause kinds and unknown semantic reference kinds are rejected", () => {
  const unknownClause = { ...draft(), clauses: [{ kind: "GENERIC_STRING", payload: {}, provenance: userTextProvenance }] };
  assert.throws(() => createCreativeIntent(unknownClause), CreativeIntentValidationError);
  const unknownReference = structuredClone(draft()) as unknown as Record<string, unknown>;
  const hard = (unknownReference.clauses as Array<Record<string, unknown>>)[2];
  (hard.payload as Record<string, unknown>).reference = { ...unresolved("老师", "SPEECH"), semanticKind: "SPEAKER_ID" };
  assert.throws(() => createCreativeIntent(unknownReference), CreativeIntentValidationError);
});

test("H: malformed schema and intent versions are rejected", () => {
  const valid = createCreativeIntent(draft());
  assert.throws(() => parseCreativeIntent({ ...valid, schemaVersion: 2 }), CreativeIntentValidationError);
  assert.throws(() => createCreativeIntent(draft({ version: 0 })), CreativeIntentValidationError);
  assert.throws(() => createCreativeIntent(draft({ version: 2 })), CreativeIntentValidationError);
});

test("J: immutable parent lineage is required after version one and changes version identity", () => {
  const first = createCreativeIntent(draft());
  const second = createCreativeIntent(draft({
    version: 2,
    parentIntentVersionId: first.intentId,
    resolutionIds: ["resolution-duration-choice"],
    createdAt: "2026-10-25T10:00:00.000Z",
  }));
  assert.equal(second.parentIntentVersionId, first.intentId);
  assert.notEqual(second.intentId, first.intentId);
  assert.throws(
    () => createCreativeIntent(draft({ version: 1, parentIntentVersionId: first.intentId })),
    CreativeIntentValidationError,
  );
});

test("duration policies represent approximate, exact, maximum, minimum, and ordinary targets", () => {
  for (const policy of ["TARGET", "APPROXIMATE_TARGET", "MAXIMUM", "MINIMUM", "EXACT"] as const) {
    const intent = createCreativeIntent(draft({
      clauses: [{
        kind: "GOAL",
        payload: { type: "TARGET_DURATION", durationMs: 30_000, policy },
        provenance: userTextProvenance,
      }],
      groundingState: "NOT_REQUIRED",
    }));
    assert.equal(intent.clauses[0].kind, "GOAL");
    assert.equal(intent.clauses[0].payload.policy, policy);
  }
});

test("ordinary TARGET duration remains a GOAL and does not imply hard protection", () => {
  const intent = createCreativeIntent(draft({
    clauses: [{
      kind: "GOAL",
      payload: { type: "TARGET_DURATION", durationMs: 30_000, policy: "TARGET" },
      provenance: userTextProvenance,
    }],
    groundingState: "NOT_REQUIRED",
  }));
  assert.equal(intent.clauses[0].kind, "GOAL");
  assert.equal(intent.clauses.some((clause) => clause.kind === "HARD_CONSTRAINT_REQUEST"), false);
});

test("negative, zero, fractional, and unknown duration policy values are rejected", () => {
  for (const durationMs of [-1, 0, 1.5]) {
    assert.throws(() => createCreativeIntent(draft({
      clauses: [{
        kind: "GOAL",
        payload: { type: "TARGET_DURATION", durationMs, policy: "TARGET" },
        provenance: userTextProvenance,
      }],
      groundingState: "NOT_REQUIRED",
    })), CreativeIntentValidationError);
  }
  const invalid = structuredClone(draft()) as unknown as Record<string, unknown>;
  ((invalid.clauses as Array<Record<string, unknown>>)[0].payload as Record<string, unknown>).policy = "HARD_DEFAULT";
  assert.throws(() => createCreativeIntent(invalid), CreativeIntentValidationError);
});

test("exact-key parsing rejects unknown root, clause, payload, provenance, and semantic fields", () => {
  const intent = createCreativeIntent(draft());
  assert.throws(() => parseCreativeIntent({ ...intent, ignored: true }), CreativeIntentValidationError);
  assert.throws(() => parseCreativeIntent({ ...intent, clauses: [{ ...intent.clauses[0], ignored: true }, ...intent.clauses.slice(1)] }), CreativeIntentValidationError);
  assert.throws(() => createCreativeIntent({ ...draft(), clauses: [{ ...clauses()[0], payload: { ...clauses()[0].payload, ignored: true } }] }), CreativeIntentValidationError);
  assert.throws(() => createCreativeIntent({ ...draft(), clauses: [{ ...clauses()[0], provenance: { ...userTextProvenance, ignored: true } }] }), CreativeIntentValidationError);
  const badReference = { ...unresolved("老师", "SPEECH"), ignored: true };
  assert.throws(() => createCreativeIntent({
    ...draft(),
    clauses: [{ kind: "HARD_CONSTRAINT_REQUEST", payload: { type: "PROTECT_TIME_RANGE", reference: badReference }, provenance: userTextProvenance }],
  }), CreativeIntentValidationError);
});

test("deterministic identities reject tampering even when the remaining structure is valid", () => {
  const intent = createCreativeIntent(draft());
  assert.throws(() => parseCreativeIntent({ ...intent, intentId: "intent-v1-deadbeef" }), CreativeIntentValidationError);
  assert.throws(() => parseCreativeIntent({
    ...intent,
    clauses: [{ ...intent.clauses[0], clauseId: "clause-v1-deadbeef" }, ...intent.clauses.slice(1)],
  }), CreativeIntentValidationError);
});

test("grounding state is fail-closed with respect to the presence of hard requests", () => {
  assert.throws(() => createCreativeIntent(draft({ groundingState: "NOT_REQUIRED" })), CreativeIntentValidationError);
  assert.throws(() => createCreativeIntent(draft({
    clauses: [clauses()[0]],
    groundingState: "UNRESOLVED_REFERENCE",
  })), CreativeIntentValidationError);
});
