import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SPEED_CURVE, DEFAULT_TRANSFORM, type EditorProject } from "./editor-core.ts";
import { createCreativeIntent, type CreativeIntentV1, type IntentClauseDraft } from "./editor-creative-intent.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import {
  PROTECTED_SPEECH_PERMISSIONS,
  createConstraintBinding,
} from "./editor-constraints.ts";
import {
  buildConstraintSetV1,
  confirmCandidateBindingV1,
  confirmDirectSelectionV1,
  createCandidateBindingV1,
  validateConfirmedBindingV1,
  type ConfirmedBindingRecordV1,
  type ConstraintGroundingContextV1,
} from "./editor-constraint-grounding.ts";
import type { VideoSemanticAnalysis } from "./editor-video-semantic.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const userText = { schemaVersion: 1 as const, authority: "USER_TEXT" as const, sourceReference: "request" };

function project(): EditorProject {
  return {
    schemaVersion: 2,
    id: "project-campus",
    title: "Campus",
    updatedAt: createdAt,
    durationMs: 40_000,
    ratio: "16:9",
    audioSelection: { mode: "full", sourceDurationMs: 40_000, sourceInMs: 0, sourceOutMs: 40_000, selectedDurationMs: 40_000 },
    assets: [
      { id: "asset-speech", name: "speech.mp4", kind: "视频", durationMs: 35_000 },
      { id: "asset-logo", name: "logo.mp4", kind: "视频", durationMs: 3_000 },
      { id: "asset-extra", name: "extra.mp4", kind: "视频", durationMs: 2_000 },
    ],
    tracks: [{
      id: "track-main",
      type: "video",
      name: "Main",
      clips: [
        { id: "clip-speech", assetId: "asset-speech", name: "Speech", kind: "视频", trackId: "track-main", timelineStartMs: 0, timelineEndMs: 35_000, sourceInMs: 0, sourceOutMs: 35_000, transform: { ...DEFAULT_TRANSFORM }, speedCurve: DEFAULT_SPEED_CURVE.map((point) => ({ ...point })) },
        { id: "clip-logo", assetId: "asset-logo", name: "Logo", kind: "视频", trackId: "track-main", timelineStartMs: 35_000, timelineEndMs: 38_000, sourceInMs: 0, sourceOutMs: 3_000, transform: { ...DEFAULT_TRANSFORM }, speedCurve: DEFAULT_SPEED_CURVE.map((point) => ({ ...point })) },
        { id: "clip-extra", assetId: "asset-extra", name: "Extra", kind: "视频", trackId: "track-main", timelineStartMs: 38_000, timelineEndMs: 40_000, sourceInMs: 0, sourceOutMs: 2_000, transform: { ...DEFAULT_TRANSFORM }, speedCurve: DEFAULT_SPEED_CURVE.map((point) => ({ ...point })) },
      ],
    }],
    captions: [{ id: "caption-speech", text: "Teacher speaks", startMs: 2_000, endMs: 8_000 }],
  };
}

function hard(type: "PROTECT_TIME_RANGE" | "PROTECT_CLIP" | "PRESERVE_ENDING", semanticKind: "SPEECH" | "VISUAL_OBJECT" | "ENDING_CONTENT", referenceText: string): IntentClauseDraft {
  return {
    kind: "HARD_CONSTRAINT_REQUEST",
    payload: {
      type,
      reference: { schemaVersion: 1, state: "UNRESOLVED_REFERENCE", semanticKind, referenceText },
    },
    provenance: userText,
  };
}

function intent(hardClauses: readonly IntentClauseDraft[] = [
  hard("PROTECT_TIME_RANGE", "SPEECH", "老师完整讲话"),
  hard("PRESERVE_ENDING", "VISUAL_OBJECT", "学校Logo"),
]): CreativeIntentV1 {
  return createCreativeIntent({
    version: 1,
    projectId: "project-campus",
    sourceRequest: "30秒，保留老师完整讲话和学校Logo",
    clauses: [
      { kind: "GOAL", payload: { type: "TARGET_DURATION", durationMs: 30_000, policy: "TARGET" }, provenance: userText },
      ...hardClauses,
    ],
    groundingState: hardClauses.length ? "UNRESOLVED_REFERENCE" : "NOT_REQUIRED",
    resolutionIds: [],
    createdAt,
  });
}

function context(overrides: Partial<ConstraintGroundingContextV1> = {}): ConstraintGroundingContextV1 {
  const editorProject = project();
  return {
    intent: intent(),
    project: editorProject,
    projectFingerprint: createEditorProjectFingerprint(editorProject),
    ...overrides,
  };
}

function hardClauses(value: CreativeIntentV1) {
  return value.clauses.filter((clause) => clause.kind === "HARD_CONSTRAINT_REQUEST");
}

function semanticAnalysis(version = "semantic-v1"): VideoSemanticAnalysis {
  return {
    schemaVersion: 1,
    assetId: "asset-logo",
    assetDurationMs: 3_000,
    segments: [{
      id: "segment-logo",
      assetId: "asset-logo",
      startMs: 0,
      endMs: 3_000,
      summary: "Possible ending mark",
      concepts: ["mark"],
      usability: 1,
      confidence: 0.8,
      evidenceFrameMs: [1_000],
    }],
    analysisMethod: "local-clip",
    createdAt,
    analysisVersion: version,
  };
}

function accepted<T>(result: { status: "ACCEPTED"; value: T } | { status: "REJECTED" }): T {
  assert.equal(result.status, "ACCEPTED");
  return (result as { status: "ACCEPTED"; value: T }).value;
}

test("grounding A-D: direct trusted clip, caption, timeline, and source-asset selections confirm without model confidence", () => {
  const base = context();
  const [speechClause, endingClause] = hardClauses(base.intent);
  const clip = accepted(confirmDirectSelectionV1({ context: base, sourceClauseId: endingClause.clauseId, selection: { bindingType: "CLIP", clipId: "clip-logo" } }));
  const caption = accepted(confirmDirectSelectionV1({ context: base, sourceClauseId: speechClause.clauseId, selection: { bindingType: "CAPTION", captionId: "caption-speech" } }));
  const timeline = accepted(confirmDirectSelectionV1({ context: base, sourceClauseId: speechClause.clauseId, selection: { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 } } }));
  const source = accepted(confirmDirectSelectionV1({ context: base, sourceClauseId: speechClause.clauseId, selection: { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "SOURCE_ASSET", assetId: "asset-speech", startMs: 0, endMs: 35_000 } } }));
  assert.deepEqual([clip.binding.bindingType, caption.binding.bindingType, timeline.binding.bindingType, source.binding.bindingType], ["CLIP", "CAPTION", "TIME_RANGE", "TIME_RANGE"]);
  for (const record of [clip, caption, timeline, source]) {
    assert.equal(record.binding.state, "USER_CONFIRMED_BINDING");
    assert.equal(record.binding.provenance.authority, "USER_DIRECT_SELECTION");
  }
});

test("grounding E/F: a model candidate is advisory and model provenance cannot self-confirm", () => {
  const base = context();
  const speechClause = hardClauses(base.intent)[0];
  const candidate = accepted(createCandidateBindingV1({
    context: base,
    sourceClauseId: speechClause.clauseId,
    selection: { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 } },
    provenance: { authority: "MODEL_SUGGESTION", sourceReference: "semantic-candidate" },
  }));
  assert.equal(candidate.recordType, "CANDIDATE_BINDING");
  assert.equal(candidate.binding.state, "CANDIDATE_BINDING");
  assert.throws(() => createConstraintBinding({
    bindingType: "TIME_RANGE",
    projectId: base.project.id,
    state: "USER_CONFIRMED_BINDING",
    range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 },
    provenance: candidate.binding.provenance,
  }));
});

test("grounding G/H: teacher and logo semantics remain unresolved without explicit confirmation", () => {
  const base = context();
  assert.deepEqual(hardClauses(base.intent).map((clause) => clause.payload.reference.state), ["UNRESOLVED_REFERENCE", "UNRESOLVED_REFERENCE"]);
  const built = buildConstraintSetV1({ intent: base.intent, project: base.project, projectFingerprint: base.projectFingerprint, confirmedBindings: [] });
  assert.equal(built.status, "CONSTRAINT_SET_BUILT");
  if (built.status !== "CONSTRAINT_SET_BUILT") return;
  assert.equal(built.constraintSet.activeConstraints.length, 0);
  assert.equal(built.unresolvedRequestCount, 2);
  assert.equal(built.readiness, "NEEDS_USER_DECISION");
});

test("grounding I: project mismatch is rejected", () => {
  const base = context();
  const mismatchedProject = { ...base.project, id: "project-other" };
  const mismatched = context({ project: mismatchedProject, projectFingerprint: createEditorProjectFingerprint(mismatchedProject) });
  const result = confirmDirectSelectionV1({
    context: mismatched,
    sourceClauseId: hardClauses(base.intent)[0].clauseId,
    selection: { bindingType: "CLIP", clipId: "clip-speech" },
  });
  assert.deepEqual({ status: result.status, code: result.status === "REJECTED" ? result.code : undefined }, { status: "REJECTED", code: "PROJECT_CONTEXT_MISMATCH" });
});

test("grounding J/K: removed clip and asset make a confirmed binding stale", () => {
  const base = context();
  const speechClause = hardClauses(base.intent)[0];
  const confirmed = accepted(confirmDirectSelectionV1({ context: base, sourceClauseId: speechClause.clauseId, selection: { bindingType: "CLIP", clipId: "clip-speech" } }));

  const withoutClip = structuredClone(base.project);
  withoutClip.tracks[0].clips = withoutClip.tracks[0].clips.filter((clip) => clip.id !== "clip-speech");
  const clipCheck = validateConfirmedBindingV1(confirmed, context({ project: withoutClip, projectFingerprint: createEditorProjectFingerprint(withoutClip) }));
  assert.equal(clipCheck.status, "STALE_BINDING");
  if (clipCheck.status === "STALE_BINDING") assert.ok(clipCheck.reasons.includes("MISSING_CLIP"));

  const withoutAsset = structuredClone(base.project);
  withoutAsset.assets = withoutAsset.assets.filter((asset) => asset.id !== "asset-speech");
  const assetCheck = validateConfirmedBindingV1(confirmed, context({ project: withoutAsset, projectFingerprint: createEditorProjectFingerprint(withoutAsset) }));
  assert.equal(assetCheck.status, "STALE_BINDING");
  if (assetCheck.status === "STALE_BINDING") assert.ok(assetCheck.reasons.includes("MISSING_ASSET"));
});

test("grounding L: semantic analysis-version mismatch makes a confirmed semantic binding stale", () => {
  const base = context({ videoSemanticAnalyses: [semanticAnalysis()] });
  const endingClause = hardClauses(base.intent)[1];
  const candidate = accepted(createCandidateBindingV1({
    context: base,
    sourceClauseId: endingClause.clauseId,
    selection: { bindingType: "VIDEO_SEMANTIC_SOURCE_RANGE", assetId: "asset-logo", startMs: 0, endMs: 3_000, analysisVersion: "semantic-v1" },
    provenance: { authority: "MODEL_SUGGESTION", sourceReference: "visual-candidate" },
  }));
  const confirmed = accepted(confirmCandidateBindingV1({ context: base, candidate }));
  const stale = validateConfirmedBindingV1(confirmed, context({ videoSemanticAnalyses: [semanticAnalysis("semantic-v2")] }));
  assert.equal(stale.status, "STALE_BINDING");
  if (stale.status === "STALE_BINDING") assert.ok(stale.reasons.includes("ANALYSIS_VERSION_MISMATCH"));
});

test("grounding M: explicit user confirmation promotes an eligible candidate and preserves candidate provenance", () => {
  const base = context();
  const speechClause = hardClauses(base.intent)[0];
  const candidate = accepted(createCandidateBindingV1({
    context: base,
    sourceClauseId: speechClause.clauseId,
    selection: { bindingType: "CLIP", clipId: "clip-speech" },
    provenance: { authority: "MODEL_SUGGESTION", sourceReference: "speech-exists-not-speaker-identity" },
  }));
  const confirmed = accepted(confirmCandidateBindingV1({ context: base, candidate }));
  assert.equal(confirmed.binding.state, "USER_CONFIRMED_BINDING");
  assert.equal(confirmed.binding.provenance.authority, "USER_CONFIRMED_BINDING");
  assert.equal(confirmed.sourceCandidateProvenance?.authority, "MODEL_SUGGESTION");
  assert.equal(confirmed.binding.bindingId, candidate.binding.bindingId);
});

test("grounding N: incompatible binding type is rejected", () => {
  const onlyClipIntent = intent([hard("PROTECT_CLIP", "SPEECH", "老师完整讲话")]);
  const base = context({ intent: onlyClipIntent });
  const result = confirmDirectSelectionV1({
    context: base,
    sourceClauseId: hardClauses(onlyClipIntent)[0].clauseId,
    selection: { bindingType: "CAPTION", captionId: "caption-speech" },
  });
  assert.equal(result.status, "REJECTED");
  if (result.status === "REJECTED") assert.equal(result.code, "INCOMPATIBLE_BINDING_TYPE");
});

function confirmCampus(base: ConstraintGroundingContextV1): readonly ConfirmedBindingRecordV1[] {
  const [speechClause, endingClause] = hardClauses(base.intent);
  return [
    accepted(confirmDirectSelectionV1({ context: base, sourceClauseId: speechClause.clauseId, selection: { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 } } })),
    accepted(confirmDirectSelectionV1({ context: base, sourceClauseId: endingClause.clauseId, selection: { bindingType: "CLIP", clipId: "clip-logo" } })),
  ];
}

test("ConstraintSet A/G/H: all confirmed requests activate with deterministic set identity and fingerprint", () => {
  const base = context();
  const bindings = confirmCampus(base);
  const first = buildConstraintSetV1({ intent: base.intent, project: base.project, projectFingerprint: base.projectFingerprint, confirmedBindings: bindings });
  const second = buildConstraintSetV1({ intent: base.intent, project: structuredClone(base.project), projectFingerprint: base.projectFingerprint, confirmedBindings: structuredClone(bindings) });
  assert.equal(first.status, "CONSTRAINT_SET_BUILT");
  assert.equal(second.status, "CONSTRAINT_SET_BUILT");
  if (first.status !== "CONSTRAINT_SET_BUILT" || second.status !== "CONSTRAINT_SET_BUILT") return;
  assert.equal(first.constraintSet.activeConstraints.length, 2);
  assert.equal(first.readiness, "READY_TO_PLAN");
  assert.equal(first.constraintSet.constraintSetId, second.constraintSet.constraintSetId);
  assert.equal(first.constraintSet.constraintFingerprint, second.constraintSet.constraintFingerprint);
});

test("ConstraintSet B/C/J: mixed confirmed and unresolved requests are represented truthfully and are not ready", () => {
  const base = context();
  const confirmed = confirmCampus(base)[0];
  const built = buildConstraintSetV1({ intent: base.intent, project: base.project, projectFingerprint: base.projectFingerprint, confirmedBindings: [confirmed] });
  assert.equal(built.status, "CONSTRAINT_SET_BUILT");
  if (built.status !== "CONSTRAINT_SET_BUILT") return;
  assert.deepEqual({ confirmed: built.confirmedRequestCount, unresolved: built.unresolvedRequestCount }, { confirmed: 1, unresolved: 1 });
  assert.equal(built.constraintSet.activeConstraints.length, 1);
  assert.equal(built.readiness, "NEEDS_USER_DECISION");
});

test("ConstraintSet D: stale binding is excluded by blocking activation", () => {
  const base = context();
  const confirmed = confirmCampus(base)[0];
  const changed = structuredClone(base.project);
  changed.captions.push({ id: "caption-new", text: "changed fingerprint", startMs: 1, endMs: 2 });
  const built = buildConstraintSetV1({
    intent: base.intent,
    project: changed,
    projectFingerprint: createEditorProjectFingerprint(changed),
    confirmedBindings: [confirmed],
  });
  assert.equal(built.status, "CONSTRAINT_SET_BUILD_FAILED");
  if (built.status === "CONSTRAINT_SET_BUILD_FAILED") assert.equal(built.code, "STALE_BINDING");
});

test("ConstraintSet E: model-only candidates are excluded and do not activate protection", () => {
  const base = context();
  const speechClause = hardClauses(base.intent)[0];
  const candidate = accepted(createCandidateBindingV1({
    context: base,
    sourceClauseId: speechClause.clauseId,
    selection: { bindingType: "CLIP", clipId: "clip-speech" },
    provenance: { authority: "MODEL_SUGGESTION", sourceReference: "candidate" },
  }));
  const built = buildConstraintSetV1({ intent: base.intent, project: base.project, projectFingerprint: base.projectFingerprint, confirmedBindings: [candidate] });
  assert.equal(built.status, "CONSTRAINT_SET_BUILT");
  if (built.status !== "CONSTRAINT_SET_BUILT") return;
  assert.equal(built.constraintSet.activeConstraints.length, 0);
  assert.equal(built.excludedBindings[0].reason, "MODEL_ONLY_UNCONFIRMED");
});

test("ConstraintSet F: a complete permission preset or explicit policy is required", () => {
  const visualIntent = intent([hard("PROTECT_TIME_RANGE", "VISUAL_OBJECT", "校徽区域")]);
  const base = context({ intent: visualIntent });
  const clause = hardClauses(visualIntent)[0];
  const confirmed = accepted(confirmDirectSelectionV1({ context: base, sourceClauseId: clause.clauseId, selection: { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 1_000, endMs: 2_000 } } }));
  const missing = buildConstraintSetV1({ intent: visualIntent, project: base.project, projectFingerprint: base.projectFingerprint, confirmedBindings: [confirmed] });
  assert.equal(missing.status, "CONSTRAINT_SET_BUILD_FAILED");
  if (missing.status === "CONSTRAINT_SET_BUILD_FAILED") assert.equal(missing.code, "MISSING_PERMISSION_POLICY");
  const valid = buildConstraintSetV1({
    intent: visualIntent,
    project: base.project,
    projectFingerprint: base.projectFingerprint,
    confirmedBindings: [confirmed],
    permissionPolicies: { [clause.clauseId]: PROTECTED_SPEECH_PERMISSIONS },
  });
  assert.equal(valid.status, "CONSTRAINT_SET_BUILT");
});

test("ConstraintSet I: project/fingerprint mismatch fails closed", () => {
  const base = context();
  const result = buildConstraintSetV1({
    intent: base.intent,
    project: base.project,
    projectFingerprint: "project-v1-deadbeef",
    confirmedBindings: [],
  });
  assert.equal(result.status, "CONSTRAINT_SET_BUILD_FAILED");
  if (result.status === "CONSTRAINT_SET_BUILD_FAILED") assert.equal(result.code, "PROJECT_CONTEXT_MISMATCH");
});

test("caption confirmation is promoted to a current timeline range only during set construction", () => {
  const captionIntent = intent([hard("PROTECT_TIME_RANGE", "SPEECH", "用户选中的讲话字幕")]);
  const base = context({ intent: captionIntent });
  const clause = hardClauses(captionIntent)[0];
  const confirmed = accepted(confirmDirectSelectionV1({ context: base, sourceClauseId: clause.clauseId, selection: { bindingType: "CAPTION", captionId: "caption-speech" } }));
  assert.equal(confirmed.binding.bindingType, "CAPTION");
  const built = buildConstraintSetV1({ intent: captionIntent, project: base.project, projectFingerprint: base.projectFingerprint, confirmedBindings: [confirmed] });
  assert.equal(built.status, "CONSTRAINT_SET_BUILT");
  if (built.status !== "CONSTRAINT_SET_BUILT") return;
  const active = built.constraintSet.confirmedBindings.find((binding) => binding.state === "ACTIVE_HARD_CONSTRAINT");
  assert.equal(active?.bindingType, "TIME_RANGE");
  assert.ok(built.constraintSet.confirmedBindings.some((binding) => binding.bindingType === "CAPTION"));
});
