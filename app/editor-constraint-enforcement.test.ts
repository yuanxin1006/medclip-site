import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { EditorProject } from "./editor-core.ts";
import {
  PROTECTED_SPEECH_PERMISSIONS,
  createConstraintSet,
  type ConstraintSetV1,
} from "./editor-constraints.ts";
import {
  candidateProjectForProtectedMutationTestV1,
  candidateProjectForReorderV1,
  constraintEnforcementMessageZh,
  createSemanticActionTupleV1,
  enforceEditorActionConstraintsV1,
  isRejectedSemanticActionV1,
  validateConstraintContextV1,
  verifyPostApplyConstraintInvariantsV1,
  type ConstraintCandidateActionV1,
} from "./editor-constraint-enforcement.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import { guardManualTimelineMutationV1 } from "./editor-manual-constraint-guard.ts";
import { createConstraintEnforcementFixture as enforcementFixture } from "./test-support/editor-constraint-enforcement-fixture.ts";

function check(
  project: EditorProject,
  constraintSet: ConstraintSetV1,
  action: ConstraintCandidateActionV1,
  candidateProject?: EditorProject,
) {
  return enforceEditorActionConstraintsV1({ project, constraintSet, action, ...(candidateProject ? { candidateProject } : {}) });
}

test("shared guard allows an unrelated unprotected action and leaves protected content unaffected", () => {
  const { project, constraintSet } = enforcementFixture({ includeUnprotected: true });
  const action = { type: "MATCH_ASSET_TO_SEGMENT", targetId: "clip-broll", assetId: "asset-broll-alt" } as const;
  const candidate = candidateProjectForProtectedMutationTestV1(project, action);
  const result = check(project, constraintSet, action, candidate);
  assert.equal(result.status, "ALLOWED");
  assert.equal(candidate.tracks[0].clips.find((item) => item.id === "clip-teacher")?.assetId, "asset-teacher");
  assert.equal(candidate.tracks[0].clips.find((item) => item.id === "clip-logo")?.assetId, "asset-logo");
});
const directAttacks: ReadonlyArray<Readonly<{
  label: string;
  action: ConstraintCandidateActionV1;
  code: string;
}>> = [
  { label: "protected delete", action: { type: "REMOVE_CLIP", targetId: "clip-teacher" }, code: "PROTECTED_CONTENT_DELETE" },
  { label: "protected trim", action: { type: "TRIM_CLIP", targetId: "clip-teacher", startSeconds: 1, endSeconds: 35 }, code: "PROTECTED_RANGE_TRIM" },
  { label: "protected speed", action: { type: "SET_CLIP_PLAYBACK_SPEED", targetId: "clip-teacher", playbackRate: 1.25 }, code: "PROTECTED_SPEED_CHANGE" },
  { label: "protected asset replacement", action: { type: "MATCH_ASSET_TO_SEGMENT", targetId: "clip-teacher", assetId: "asset-logo" }, code: "PROTECTED_ASSET_REPLACE" },
  { label: "protected move", action: { type: "REORDER_CLIP", targetId: "clip-teacher", referenceId: "clip-logo", placement: "AFTER" }, code: "PROTECTED_CONTENT_MOVE" },
  { label: "protected transform", action: { type: "SET_CLIP_POSITION_SCALE", targetId: "clip-teacher", x: 10, y: 0, scale: 1.2 }, code: "PROTECTED_TRANSFORM_CHANGE" },
  { label: "protected split without lineage", action: { type: "SPLIT_CLIP", targetId: "clip-teacher", splitAtSeconds: 10 }, code: "PROTECTED_SPLIT" },
  { label: "protected audio range", action: { type: "SET_BACKGROUND_AUDIO_RANGE", targetId: "background-audio", startSeconds: 1, endSeconds: 30 }, code: "PROTECTED_AUDIO_RANGE_CHANGE" },
];

for (const attack of directAttacks) {
  test(`shared guard blocks ${attack.label}`, () => {
    const { project, constraintSet } = enforcementFixture();
    const result = check(project, constraintSet, attack.action);
    assert.equal(result.status, "BLOCKED_HARD_CONSTRAINT");
    assert.equal(result.violations.some((item) => item.code === attack.code), true);
    assert.equal(constraintEnforcementMessageZh(result).includes("{"), false);
  });
}

test("protected exact caption mutation is blocked by the default speech permission policy", () => {
  const { project, constraintSet } = enforcementFixture({ captionBinding: true });
  const action = { type: "SET_CAPTION_TEXT", targetId: "caption-teacher", text: "changed" } as const;
  const result = check(project, constraintSet, action);
  assert.equal(result.status, "BLOCKED_HARD_CONSTRAINT");
  assert.equal(result.violations[0].code, "PROTECTED_CAPTION_CHANGE");
});

test("audio-range permission still fails closed when durable protected audio identity is unavailable", () => {
  const { project, constraintSet } = enforcementFixture({
    speechPermissions: { ...PROTECTED_SPEECH_PERMISSIONS, allowAudioRangeChange: true },
  });
  const result = check(project, constraintSet, {
    type: "SET_BACKGROUND_AUDIO_RANGE", targetId: "background-audio", startSeconds: 1, endSeconds: 30,
  });
  assert.equal(result.status, "BLOCKED_HARD_CONSTRAINT");
  assert.equal(result.violations.some((item) => item.code === "UNSUPPORTED_PROTECTED_MUTATION"), true);
});

test("reorder preflight catches indirect protected movement and ending displacement", () => {
  const { project, constraintSet } = enforcementFixture();
  const action = { type: "REORDER_CLIP", targetId: "clip-teacher", referenceId: "clip-logo", placement: "AFTER" } as const;
  const candidate = candidateProjectForReorderV1(project, action)!;
  const result = check(project, constraintSet, action, candidate);
  assert.equal(result.status, "BLOCKED_HARD_CONSTRAINT");
  assert.equal(result.violations.some((item) => item.code === "PRESERVE_ENDING_VIOLATION"), true);
  assert.equal(result.violations.some((item) => item.code === "PROTECTED_CONTENT_MOVE"), true);
});

test("stale project fingerprint and exact context mismatch fail closed with typed status", () => {
  const { project, constraintSet } = enforcementFixture();
  assert.ok(constraintSet.activeConstraints.length > 0);
  const staleProject = structuredClone(project);
  staleProject.title = "changed after confirmation";
  const stale = validateConstraintContextV1(staleProject, constraintSet);
  assert.equal(stale.status, "STALE_CONSTRAINT_CONTEXT");
  assert.equal(stale.violations[0].code, "STALE_CONSTRAINT_CONTEXT");
  const exactMismatch = validateConstraintContextV1(project, constraintSet, {
    intentVersionId: constraintSet.intentVersionId,
    constraintSetId: constraintSet.constraintSetId,
    constraintFingerprint: "constraint-fingerprint-v1-deadbeef",
  });
  assert.equal(exactMismatch.status, "STALE_CONSTRAINT_CONTEXT");
});

test("empty non-enforcing context ignores only a legitimate post-execution project fingerprint change", () => {
  const { project } = enforcementFixture({ includeUnprotected: true });
  const constraintSet = createConstraintSet({
    version: 1,
    projectId: project.id,
    intentVersionId: "intent-v1-23e00003",
    validatedAgainstProjectFingerprint: createEditorProjectFingerprint(project),
    activeConstraints: [],
    confirmedBindings: [],
    resolutionIds: [],
  });
  const postExecutionProject = structuredClone(project);
  postExecutionProject.title = "legitimate executed project";
  const expectedContext = {
    intentVersionId: constraintSet.intentVersionId,
    constraintSetId: constraintSet.constraintSetId,
    constraintFingerprint: constraintSet.constraintFingerprint,
  } as const;
  assert.notEqual(
    createEditorProjectFingerprint(postExecutionProject),
    constraintSet.validatedAgainstProjectFingerprint,
  );
  assert.equal(
    validateConstraintContextV1(postExecutionProject, constraintSet, expectedContext).status,
    "ALLOWED",
  );
  assert.equal(validateConstraintContextV1(postExecutionProject, constraintSet, {
    ...expectedContext,
    constraintFingerprint: "constraint-fingerprint-v1-deadbeef",
  }).status, "STALE_CONSTRAINT_CONTEXT");
});

test("post-apply invariant verification detects partial protected-range loss", () => {
  const { project, constraintSet } = enforcementFixture();
  const candidate = structuredClone(project);
  const teacher = candidate.tracks[0].clips.find((item) => item.id === "clip-teacher")!;
  teacher.sourceInMs = 1_000;
  teacher.timelineStartMs = 1_000;
  const result = verifyPostApplyConstraintInvariantsV1({ preProject: project, candidateProject: candidate, constraintSet });
  assert.equal(result.status, "BLOCKED_HARD_CONSTRAINT");
  assert.equal(result.violations.some((item) => item.code === "PROTECTED_RANGE_TRIM"), true);
});

test("post-apply invariant verification blocks protected speech retiming", () => {
  const { project, constraintSet } = enforcementFixture();
  const candidate = structuredClone(project);
  const teacher = candidate.tracks[0].clips.find((item) => item.id === "clip-teacher")!;
  teacher.timelineEndMs -= 1_000;
  const result = verifyPostApplyConstraintInvariantsV1({ preProject: project, candidateProject: candidate, constraintSet });
  assert.equal(result.status, "BLOCKED_HARD_CONSTRAINT");
  assert.equal(result.violations.some((item) => item.code === "PROTECTED_TIMING_CHANGE"), true);
});

test("violation IDs and results are deterministic for identical input", () => {
  const { project, constraintSet } = enforcementFixture();
  const action = { type: "REMOVE_CLIP", targetId: "clip-teacher" } as const;
  const first = check(project, constraintSet, action);
  const second = check(project, constraintSet, action);
  assert.deepEqual(first, second);
  assert.match(first.violations[0].violationId, /^constraint-violation-v1-[0-9a-f]{8}$/);
});

test("semantic rejection tuple identity is deterministic and scoped to project plus intent lineage", () => {
  const { project, constraintSet } = enforcementFixture();
  const action = { type: "MATCH_ASSET_TO_SEGMENT", targetId: "clip-broll", assetId: "asset-broll-alt" } as const;
  const tuple = createSemanticActionTupleV1(project.id, constraintSet.intentVersionId, action);
  assert.equal(tuple, createSemanticActionTupleV1(project.id, constraintSet.intentVersionId, action));
  assert.equal(isRejectedSemanticActionV1({ projectId: project.id, intentVersionId: constraintSet.intentVersionId, action, rejectedOperationTuples: [tuple] }), true);
  assert.equal(isRejectedSemanticActionV1({ projectId: "other-project", intentVersionId: constraintSet.intentVersionId, action, rejectedOperationTuples: [tuple] }), false);
});

test("manual guard blocks every reachable protected mutation family through the shared enforcement path", () => {
  const { project, constraintSet } = enforcementFixture();
  const actions: readonly ConstraintCandidateActionV1[] = [
    { type: "REMOVE_CLIP", targetId: "clip-teacher" },
    { type: "TRIM_CLIP", targetId: "clip-teacher", startSeconds: 1, endSeconds: 35 },
    { type: "REORDER_CLIP", targetId: "clip-teacher", referenceId: "clip-logo", placement: "AFTER" },
    { type: "SET_CLIP_PLAYBACK_SPEED", targetId: "clip-teacher", playbackRate: 1.25 },
    { type: "MATCH_ASSET_TO_SEGMENT", targetId: "clip-teacher", assetId: "asset-logo" },
    { type: "SET_CLIP_POSITION_SCALE", targetId: "clip-teacher", x: 10, y: 0, scale: 1.2 },
  ];
  for (const action of actions) {
    const candidate = action.type === "REORDER_CLIP"
      ? candidateProjectForReorderV1(project, action)!
      : candidateProjectForProtectedMutationTestV1(project, action);
    assert.notEqual(guardManualTimelineMutationV1({ currentProject: project, candidateProject: candidate, constraintSet, action }).status, "ALLOWED", action.type);
  }
  const captionFixture = enforcementFixture({ captionBinding: true });
  const captionAction = { type: "SET_CAPTION_TEXT", targetId: "caption-teacher", text: "changed" } as const;
  const captionCandidate = candidateProjectForProtectedMutationTestV1(captionFixture.project, captionAction);
  assert.equal(guardManualTimelineMutationV1({
    currentProject: captionFixture.project,
    candidateProject: captionCandidate,
    constraintSet: captionFixture.constraintSet,
    action: captionAction,
  }).status, "BLOCKED_HARD_CONSTRAINT");
});

test("campus freeze gate blocks transform, reorder, and caption attacks before project mutation or history", () => {
  const clipFixture = enforcementFixture();
  const captionFixture = enforcementFixture({ captionBinding: true });
  const attacks = [
    {
      fixture: clipFixture,
      action: { type: "SET_CLIP_POSITION_SCALE", targetId: "clip-teacher", x: 10, y: 0, scale: 1 } as const,
      code: "PROTECTED_TRANSFORM_CHANGE",
    },
    {
      fixture: clipFixture,
      action: { type: "REORDER_CLIP", targetId: "clip-teacher", referenceId: "clip-logo", placement: "AFTER" } as const,
      code: "PROTECTED_CONTENT_MOVE",
    },
    {
      fixture: captionFixture,
      action: { type: "SET_CAPTION_TEXT", targetId: "caption-teacher", text: "changed" } as const,
      code: "PROTECTED_CAPTION_CHANGE",
    },
  ];
  for (const { fixture, action, code } of attacks) {
    const before = structuredClone(fixture.project);
    const history: EditorProject[] = [];
    const candidate = candidateProjectForProtectedMutationTestV1(fixture.project, action);
    const result = guardManualTimelineMutationV1({
      currentProject: fixture.project,
      candidateProject: candidate,
      constraintSet: fixture.constraintSet,
      action,
    });
    if (result.status === "ALLOWED") history.push(before);
    assert.equal(result.status, "BLOCKED_HARD_CONSTRAINT");
    assert.equal(result.violations.some((item) => item.code === code), true);
    assert.deepEqual(fixture.project, before);
    assert.equal(history.length, 0);
  }
});

test("TimelineEditor routes every supported manual mutation and drag commit through the one shared guard", () => {
  const source = readFileSync(new URL("./TimelineEditor.tsx", import.meta.url), "utf8");
  assert.match(source, /const commit = \(next:[\s\S]*?if \(!allowManualCandidate\(draftRef\.current, next, action\)\) return false;/);
  assert.match(source, /guardManualTimelineMutationV1\(/);
  for (const actionType of [
    "REMOVE_CLIP",
    "REORDER_CLIP",
    "SET_CLIP_PLAYBACK_SPEED",
    "SET_CAPTION_TEXT",
    "MATCH_ASSET_TO_SEGMENT",
    "SET_CLIP_POSITION_SCALE",
  ]) assert.match(source, new RegExp(`type: "${actionType}"`));
  assert.match(source, /mode === "move" \? "MANUAL_MOVE_CLIP" : "TRIM_CLIP"/);
  assert.match(source, /if \(!allowManualCandidate\(base, latest, action\)\)[\s\S]*?draftRef\.current = base;[\s\S]*?return;/);
  assert.match(source, /if \(committed\) setSelection\(null\)/);
  assert.match(source, /if \(committed && nextSelection\) setSelection\(nextSelection\)/);
});
