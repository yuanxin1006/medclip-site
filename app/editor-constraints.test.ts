import assert from "node:assert/strict";
import test from "node:test";
import type { DomainProvenanceV1 } from "./editor-creative-intent.ts";
import {
  CONSTRAINT_SET_SCHEMA_VERSION,
  PROTECTED_ENDING_LOGO_PERMISSIONS,
  PROTECTED_SPEECH_PERMISSIONS,
  ConstraintDomainValidationError,
  createActiveConstraint,
  createConstraintBinding,
  createConstraintSet,
  hasEnforceableConstraintsV1,
  parseConstraintBinding,
  parseConstraintSet,
  parseProtectionPermissionPolicy,
  parseTimeRange,
  type ActiveConstraintV1,
  type ConstraintBindingV1,
  type ConstraintSetV1,
  type ProtectionPermissionPolicyV1,
} from "./editor-constraints.ts";

const projectId = "project-medical-demo";
const intentVersionId = "intent-v1-12345678";
const sourceClauseId = "clause-v1-12345678";
const projectFingerprint = "project-v1-12345678";

function provenance(
  authority: DomainProvenanceV1["authority"],
  sourceReference = "reviewed-selection",
): DomainProvenanceV1 {
  return { schemaVersion: 1, authority, sourceReference };
}

function clipBinding(
  state: "CANDIDATE_BINDING" | "USER_CONFIRMED_BINDING" | "ACTIVE_HARD_CONSTRAINT" | "STALE_BINDING" = "ACTIVE_HARD_CONSTRAINT",
  authority: DomainProvenanceV1["authority"] = "USER_DIRECT_SELECTION",
  overrides: Record<string, unknown> = {},
) {
  return createConstraintBinding({
    bindingType: "CLIP",
    projectId,
    state,
    clipId: "clip-teacher",
    assetId: "asset-interview",
    trackId: "track-video-main",
    provenance: provenance(authority),
    ...overrides,
  });
}

function activeClipConstraint(
  binding = clipBinding(),
  permissions: ProtectionPermissionPolicyV1 = PROTECTED_SPEECH_PERMISSIONS,
  constraintProvenance: DomainProvenanceV1 = binding.provenance,
) {
  return createActiveConstraint({
    type: "PROTECT_CLIP",
    sourceClauseId,
    binding,
    permissions,
    provenance: constraintProvenance,
    confirmationStatus: constraintProvenance.authority === "DETERMINISTIC_PROJECT_FACT"
      ? "TRUSTED_PROJECT_FACT"
      : "USER_CONFIRMED",
  });
}

function setDraft(
  binding: ConstraintBindingV1 = clipBinding(),
  constraint: ActiveConstraintV1 = activeClipConstraint(binding),
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 1,
    projectId,
    intentVersionId,
    validatedAgainstProjectFingerprint: projectFingerprint,
    activeConstraints: [constraint],
    confirmedBindings: [binding],
    resolutionIds: [],
    ...overrides,
  };
}

test("bindings A/B: trusted clip and caption bindings preserve exact project identities", () => {
  const clip = clipBinding("USER_CONFIRMED_BINDING", "USER_CONFIRMED_BINDING");
  const caption = createConstraintBinding({
    bindingType: "CAPTION",
    projectId,
    state: "USER_CONFIRMED_BINDING",
    captionId: "caption-teacher-1",
    provenance: provenance("USER_CONFIRMED_BINDING"),
  });
  if (clip.bindingType !== "CLIP") assert.fail("expected a clip binding");
  if (caption.bindingType !== "CAPTION") assert.fail("expected a caption binding");
  assert.deepEqual(
    { clipId: clip.clipId, assetId: clip.assetId, trackId: clip.trackId },
    { clipId: "clip-teacher", assetId: "asset-interview", trackId: "track-video-main" },
  );
  assert.equal(caption.captionId, "caption-teacher-1");
  assert.deepEqual(parseConstraintBinding(clip), clip);
  assert.equal(Object.isFrozen(caption), true);
});

test("bindings C/D: timeline and source-asset ranges use explicit, non-interchangeable coordinate spaces", () => {
  const timeline = parseTimeRange({ schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 5_000, endMs: 12_000 });
  const source = parseTimeRange({ schemaVersion: 1, coordinateSpace: "SOURCE_ASSET", assetId: "asset-a", startMs: 500, endMs: 4_000 });
  assert.deepEqual(timeline, { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 5_000, endMs: 12_000 });
  assert.deepEqual(source, { schemaVersion: 1, coordinateSpace: "SOURCE_ASSET", assetId: "asset-a", startMs: 500, endMs: 4_000 });
  assert.equal("assetId" in timeline, false);
});

test("video-semantic source binding includes durable asset/range/analysis version, not a segment ID", () => {
  const binding = createConstraintBinding({
    bindingType: "VIDEO_SEMANTIC_SOURCE_RANGE",
    projectId,
    state: "CANDIDATE_BINDING",
    assetId: "asset-logo",
    startMs: 27_000,
    endMs: 30_000,
    analysisVersion: "local-clip-medical-v1",
    provenance: provenance("MODEL_SUGGESTION", "local-visual-candidate"),
  });
  assert.equal(binding.bindingType, "VIDEO_SEMANTIC_SOURCE_RANGE");
  assert.equal(binding.analysisVersion, "local-clip-medical-v1");
  assert.equal("segmentId" in binding, false);
});

test("bindings E/F: invalid, reversed, negative, fractional, and ambiguous ranges are rejected", () => {
  for (const range of [
    { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 1_000, endMs: 1_000 },
    { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 2_000, endMs: 1_000 },
    { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: -1, endMs: 1_000 },
    { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0.5, endMs: 1_000 },
    { schemaVersion: 1, coordinateSpace: "UNKNOWN", startMs: 0, endMs: 1_000 },
  ]) assert.throws(() => parseTimeRange(range), ConstraintDomainValidationError);
});

test("binding G: missing, URL-like, path-like, and whitespace-normalized trusted identities are rejected", () => {
  for (const clipId of ["", " clip-a", "blob:https://example.invalid/a", "C:\\media\\clip.mp4"]) {
    assert.throws(() => clipBinding("CANDIDATE_BINDING", "MODEL_SUGGESTION", { clipId }), ConstraintDomainValidationError);
  }
});

test("binding H: unresolved semantic references remain explicit and contain no trusted target", () => {
  const binding = createConstraintBinding({
    bindingType: "UNRESOLVED_SEMANTIC_REFERENCE",
    projectId,
    state: "UNRESOLVED_REFERENCE",
    semanticReference: {
      schemaVersion: 1,
      state: "UNRESOLVED_REFERENCE",
      semanticKind: "SPEECH",
      referenceText: "老师完整讲话",
    },
    provenance: provenance("USER_TEXT", "sourceRequest"),
  });
  assert.equal(binding.state, "UNRESOLVED_REFERENCE");
  assert.equal(binding.semanticReference.referenceText, "老师完整讲话");
  assert.equal("clipId" in binding, false);
});

test("binding I: an unconfirmed candidate binding cannot activate a constraint", () => {
  const candidate = clipBinding("CANDIDATE_BINDING", "MODEL_SUGGESTION");
  assert.throws(() => createActiveConstraint({
    type: "PROTECT_CLIP",
    sourceClauseId,
    binding: candidate,
    permissions: PROTECTED_SPEECH_PERMISSIONS,
    provenance: candidate.provenance,
    confirmationStatus: "USER_CONFIRMED",
  }), ConstraintDomainValidationError);
});

test("binding J: stale binding state is representable but is not enforcement-ready", () => {
  const stale = clipBinding("STALE_BINDING", "USER_CONFIRMED_BINDING");
  assert.equal(stale.state, "STALE_BINDING");
  assert.throws(() => createConstraintSet(setDraft(stale, activeClipConstraint())), ConstraintDomainValidationError);
});

test("permissions A: a complete explicit permission object is accepted and frozen", () => {
  const parsed = parseProtectionPermissionPolicy({ ...PROTECTED_SPEECH_PERMISSIONS });
  assert.deepEqual(parsed, PROTECTED_SPEECH_PERMISSIONS);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.keys(parsed).length, 10);
});

test("permissions B/C/F/G: missing, unknown, implicit, and malformed permission values fail closed", () => {
  const { allowDelete: _allowDelete, ...missing } = PROTECTED_SPEECH_PERMISSIONS;
  assert.throws(() => parseProtectionPermissionPolicy(missing), ConstraintDomainValidationError);
  assert.throws(() => parseProtectionPermissionPolicy({ ...PROTECTED_SPEECH_PERMISSIONS, allowCrop: true }), ConstraintDomainValidationError);
  assert.throws(() => parseProtectionPermissionPolicy({ ...PROTECTED_SPEECH_PERMISSIONS, allowDelete: undefined }), ConstraintDomainValidationError);
  assert.throws(() => parseProtectionPermissionPolicy({ ...PROTECTED_SPEECH_PERMISSIONS, allowTrim: "false" }), ConstraintDomainValidationError);
});

test("permissions D: protected speech preset denies all ten protected mutation capabilities", () => {
  assert.deepEqual(PROTECTED_SPEECH_PERMISSIONS, {
    allowDelete: false,
    allowTrim: false,
    allowMove: false,
    allowSpeedChange: false,
    allowAssetReplace: false,
    allowCaptionTextChange: false,
    allowTimingChange: false,
    allowSplit: false,
    allowTransformChange: false,
    allowAudioRangeChange: false,
  });
});

test("permissions E: protected ending/logo preset also denies move and transform change", () => {
  assert.equal(PROTECTED_ENDING_LOGO_PERMISSIONS.allowDelete, false);
  assert.equal(PROTECTED_ENDING_LOGO_PERMISSIONS.allowTrim, false);
  assert.equal(PROTECTED_ENDING_LOGO_PERMISSIONS.allowMove, false);
  assert.equal(PROTECTED_ENDING_LOGO_PERMISSIONS.allowAssetReplace, false);
  assert.equal(PROTECTED_ENDING_LOGO_PERMISSIONS.allowTransformChange, false);
});

test("provenance A/B: direct selection and user-confirmed binding may authorize active protection", () => {
  for (const authority of ["USER_DIRECT_SELECTION", "USER_CONFIRMED_BINDING"] as const) {
    const binding = clipBinding("ACTIVE_HARD_CONSTRAINT", authority);
    const constraint = activeClipConstraint(binding, PROTECTED_SPEECH_PERMISSIONS, binding.provenance);
    assert.equal(constraint.confirmationStatus, "USER_CONFIRMED");
  }
});

test("provenance C: deterministic project fact may authorize a structurally valid active binding", () => {
  const binding = createConstraintBinding({
    bindingType: "TIME_RANGE",
    projectId,
    state: "ACTIVE_HARD_CONSTRAINT",
    range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 27_000, endMs: 30_000 },
    provenance: provenance("DETERMINISTIC_PROJECT_FACT", "current-ending-range"),
  });
  const constraint = createActiveConstraint({
    type: "PRESERVE_ENDING",
    sourceClauseId,
    binding,
    permissions: PROTECTED_ENDING_LOGO_PERMISSIONS,
    provenance: binding.provenance,
    confirmationStatus: "TRUSTED_PROJECT_FACT",
  });
  assert.equal(constraint.type, "PRESERVE_ENDING");
});

test("provenance D/E/F: model-only or raw-text provenance cannot authorize an active hard constraint", () => {
  for (const authority of ["MODEL_SUGGESTION", "MODEL_UNCERTAIN_INFERENCE", "USER_TEXT"] as const) {
    assert.throws(
      () => clipBinding("ACTIVE_HARD_CONSTRAINT", authority, { clipId: "model-invented-id" }),
      ConstraintDomainValidationError,
    );
  }
});

test("provenance must match between an active binding and active constraint", () => {
  const binding = clipBinding("ACTIVE_HARD_CONSTRAINT", "USER_DIRECT_SELECTION");
  assert.throws(
    () => activeClipConstraint(binding, PROTECTED_SPEECH_PERMISSIONS, provenance("USER_CONFIRMED_BINDING")),
    ConstraintDomainValidationError,
  );
});

test("constraint A/B/C: valid ConstraintSetV1 has deterministic set identity and fingerprint", () => {
  const first = createConstraintSet(setDraft());
  const second = createConstraintSet(structuredClone(setDraft()));
  assert.equal(first.schemaVersion, CONSTRAINT_SET_SCHEMA_VERSION);
  assert.equal(first.constraintSetId, second.constraintSetId);
  assert.equal(first.constraintFingerprint, second.constraintFingerprint);
  assert.match(first.constraintSetId, /^constraint-set-v1-[0-9a-f]{8}$/);
  assert.match(first.constraintFingerprint, /^constraint-fingerprint-v1-[0-9a-f]{8}$/);
  assert.equal(Object.isFrozen(first.activeConstraints), true);
  assert.deepEqual(parseConstraintSet(first), first);
});

test("constraint D: unresolved hard requests and unresolved bindings are excluded from active sets", () => {
  const unresolvedBinding = createConstraintBinding({
    bindingType: "UNRESOLVED_SEMANTIC_REFERENCE",
    projectId,
    state: "UNRESOLVED_REFERENCE",
    semanticReference: { schemaVersion: 1, state: "UNRESOLVED_REFERENCE", semanticKind: "VISUAL_OBJECT", referenceText: "学校Logo" },
    provenance: provenance("USER_TEXT", "sourceRequest"),
  });
  const empty = createConstraintSet(setDraft(clipBinding(), activeClipConstraint(), {
    activeConstraints: [],
    confirmedBindings: [],
  }));
  assert.deepEqual(empty.activeConstraints, []);
  assert.equal(hasEnforceableConstraintsV1(empty), false);
  assert.throws(() => createConstraintSet(setDraft(clipBinding(), activeClipConstraint(), {
    activeConstraints: [],
    confirmedBindings: [unresolvedBinding],
  })), ConstraintDomainValidationError);
});

test("constraint E/F: confirmed active constraint is accepted while confirmed-only binding cannot be active yet", () => {
  const activeBinding = clipBinding("ACTIVE_HARD_CONSTRAINT", "USER_CONFIRMED_BINDING");
  const active = createConstraintSet(setDraft(activeBinding, activeClipConstraint(activeBinding)));
  assert.equal(active.activeConstraints.length, 1);
  assert.equal(hasEnforceableConstraintsV1(active), true);

  const confirmedOnly = clipBinding("USER_CONFIRMED_BINDING", "USER_CONFIRMED_BINDING");
  const lineageOnly = createConstraintSet(setDraft(undefined, undefined, {
    activeConstraints: [],
    confirmedBindings: [confirmedOnly],
  }));
  assert.equal(hasEnforceableConstraintsV1(lineageOnly), false);
  const forgedConstraint = { ...activeClipConstraint(), bindingId: confirmedOnly.bindingId };
  assert.throws(() => createConstraintSet(setDraft(confirmedOnly, forgedConstraint as ActiveConstraintV1)), ConstraintDomainValidationError);
});

test("constraint G: bindings from a different project are rejected", () => {
  const other = clipBinding("ACTIVE_HARD_CONSTRAINT", "USER_DIRECT_SELECTION", { projectId: "project-other" });
  assert.throws(() => createConstraintSet(setDraft(other, activeClipConstraint(other))), ConstraintDomainValidationError);
});

test("constraint H: malformed project fingerprint, intent context, set ID, and fingerprint are rejected", () => {
  assert.throws(() => createConstraintSet(setDraft(undefined, undefined, { validatedAgainstProjectFingerprint: "not-a-fingerprint" })), ConstraintDomainValidationError);
  assert.throws(() => createConstraintSet(setDraft(undefined, undefined, { intentVersionId: "intent-random" })), ConstraintDomainValidationError);
  const valid = createConstraintSet(setDraft());
  assert.throws(() => parseConstraintSet({ ...valid, constraintSetId: "constraint-set-v1-deadbeef" }), ConstraintDomainValidationError);
  assert.throws(() => parseConstraintSet({ ...valid, constraintFingerprint: "constraint-fingerprint-v1-deadbeef" }), ConstraintDomainValidationError);
});

test("constraint I/J: missing permissions and unknown active constraint types are rejected", () => {
  const validConstraint = activeClipConstraint();
  const { permissions: _permissions, ...missingPermissions } = validConstraint;
  assert.throws(() => createConstraintSet(setDraft(clipBinding(), missingPermissions as ActiveConstraintV1)), ConstraintDomainValidationError);
  assert.throws(() => createConstraintSet(setDraft(clipBinding(), {
    ...validConstraint,
    type: "DELETE_ANYTHING",
  } as unknown as ActiveConstraintV1)), ConstraintDomainValidationError);
});

test("exact-key policy rejects unknown fields in ranges, bindings, permissions, constraints, and sets", () => {
  assert.throws(() => parseTimeRange({ schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 1, unit: "ms" }), ConstraintDomainValidationError);
  assert.throws(() => parseConstraintBinding({ ...clipBinding(), modelConfidence: 0.99 }), ConstraintDomainValidationError);
  assert.throws(() => parseProtectionPermissionPolicy({ ...PROTECTED_SPEECH_PERMISSIONS, futurePermission: false }), ConstraintDomainValidationError);
  const valid = createConstraintSet(setDraft());
  assert.throws(() => parseConstraintSet({ ...valid, ignoredMetadata: true }), ConstraintDomainValidationError);
  assert.throws(() => parseConstraintSet({
    ...valid,
    activeConstraints: [{ ...valid.activeConstraints[0], ignored: true }],
  }), ConstraintDomainValidationError);
});

test("binding and constraint deterministic IDs reject content tampering", () => {
  const binding = clipBinding();
  assert.throws(() => parseConstraintBinding({ ...binding, bindingId: "binding-v1-deadbeef" }), ConstraintDomainValidationError);
  const valid = createConstraintSet(setDraft());
  assert.throws(() => parseConstraintSet({
    ...valid,
    activeConstraints: [{ ...valid.activeConstraints[0], constraintId: "constraint-v1-deadbeef" }],
  }), ConstraintDomainValidationError);
});

test("binding lifecycle exposes every required state without automatic activation", () => {
  const candidate = clipBinding("CANDIDATE_BINDING", "MODEL_SUGGESTION");
  const confirmed = clipBinding("USER_CONFIRMED_BINDING", "USER_CONFIRMED_BINDING");
  const active = clipBinding("ACTIVE_HARD_CONSTRAINT", "USER_CONFIRMED_BINDING");
  const stale = clipBinding("STALE_BINDING", "USER_CONFIRMED_BINDING");
  assert.deepEqual(
    [candidate.state, confirmed.state, active.state, stale.state],
    ["CANDIDATE_BINDING", "USER_CONFIRMED_BINDING", "ACTIVE_HARD_CONSTRAINT", "STALE_BINDING"],
  );
  assert.equal(candidate.bindingId, confirmed.bindingId);
  assert.equal(confirmed.bindingId, active.bindingId);
  assert.equal(active.bindingId, stale.bindingId);
});

test("ConstraintSet is domain-only and does not mutate caller-owned values", () => {
  const source = setDraft();
  const before = structuredClone(source);
  createConstraintSet(source);
  assert.deepEqual(source, before);
});
