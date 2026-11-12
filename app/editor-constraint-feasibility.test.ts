import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SPEED_CURVE, DEFAULT_TRANSFORM, type EditorProject, type TimelineClip } from "./editor-core.ts";
import { createCreativeIntent, type CreativeIntentV1, type DurationPolicy, type IntentClauseDraft } from "./editor-creative-intent.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import {
  buildConstraintSetV1,
  confirmDirectSelectionV1,
  type ConfirmedBindingRecordV1,
  type ConstraintGroundingContextV1,
  type GroundingSelectionV1,
} from "./editor-constraint-grounding.ts";
import {
  createConstraintConflictV1,
  evaluateConstraintFeasibilityV1,
  mergeProtectedTimelineRangesV1,
  type ConstraintFeasibilityReportV1,
  type NormalizedProtectedRangeV1,
} from "./editor-constraint-feasibility.ts";
import type { ConstraintSetV1 } from "./editor-constraints.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const userText = { schemaVersion: 1 as const, authority: "USER_TEXT" as const, sourceReference: "request" };

function clip(
  id: string,
  assetId: string,
  trackId: string,
  timelineStartMs: number,
  timelineEndMs: number,
  sourceInMs = 0,
  sourceOutMs = timelineEndMs - timelineStartMs,
): TimelineClip {
  return {
    id,
    assetId,
    name: id,
    kind: "视频",
    trackId,
    timelineStartMs,
    timelineEndMs,
    sourceInMs,
    sourceOutMs,
    transform: { ...DEFAULT_TRANSFORM },
    speedCurve: DEFAULT_SPEED_CURVE.map((point) => ({ ...point })),
  };
}

function campusProject(): EditorProject {
  return {
    schemaVersion: 2,
    id: "project-campus-feasibility",
    title: "Campus fixture",
    updatedAt: createdAt,
    durationMs: 38_000,
    ratio: "16:9",
    audioSelection: { mode: "full", sourceDurationMs: 38_000, sourceInMs: 0, sourceOutMs: 38_000, selectedDurationMs: 38_000 },
    assets: [
      { id: "asset-speech", name: "speech.mp4", kind: "视频", durationMs: 35_000 },
      { id: "asset-logo", name: "logo.mp4", kind: "视频", durationMs: 3_000 },
    ],
    tracks: [{
      id: "track-main",
      type: "video",
      name: "Main",
      clips: [clip("clip-speech", "asset-speech", "track-main", 0, 35_000), clip("clip-logo", "asset-logo", "track-main", 35_000, 38_000)],
    }],
    captions: [{ id: "caption-speech", text: "Speech exists; speaker identity is user-confirmed", startMs: 0, endMs: 35_000 }],
  };
}

function hard(
  type: "PROTECT_TIME_RANGE" | "PROTECT_CLIP" | "PRESERVE_ENDING",
  semanticKind: "SPEECH" | "VISUAL_OBJECT" | "ENDING_CONTENT",
  referenceText: string,
): IntentClauseDraft {
  return {
    kind: "HARD_CONSTRAINT_REQUEST",
    payload: { type, reference: { schemaVersion: 1, state: "UNRESOLVED_REFERENCE", semanticKind, referenceText } },
    provenance: userText,
  };
}

function makeIntent(
  projectId: string,
  durationMs: number | null = 30_000,
  durationPolicy: DurationPolicy = "TARGET",
  hardDrafts: readonly IntentClauseDraft[] = [
    hard("PROTECT_TIME_RANGE", "SPEECH", "老师完整讲话"),
    hard("PRESERVE_ENDING", "VISUAL_OBJECT", "学校Logo"),
  ],
  groundingState: CreativeIntentV1["groundingState"] = "UNRESOLVED_REFERENCE",
): CreativeIntentV1 {
  return createCreativeIntent({
    version: 1,
    projectId,
    sourceRequest: "Campus request",
    clauses: [
      ...(durationMs === null ? [] : [{
        kind: "GOAL" as const,
        payload: { type: "TARGET_DURATION" as const, durationMs, policy: durationPolicy },
        provenance: userText,
      }]),
      ...hardDrafts,
    ],
    groundingState: hardDrafts.length ? groundingState : "NOT_REQUIRED",
    resolutionIds: [],
    createdAt,
  });
}

function hardClauses(intent: CreativeIntentV1) {
  return intent.clauses.filter((clause) => clause.kind === "HARD_CONSTRAINT_REQUEST");
}

function accepted<T>(result: { status: "ACCEPTED"; value: T } | { status: "REJECTED"; message: string }): T {
  assert.equal(result.status, "ACCEPTED", result.status === "REJECTED" ? result.message : undefined);
  return (result as { status: "ACCEPTED"; value: T }).value;
}

function buildScenario(
  editorProject: EditorProject,
  intent: CreativeIntentV1,
  selections: readonly (GroundingSelectionV1 | undefined)[],
): Readonly<{ constraintSet: ConstraintSetV1; confirmed: readonly ConfirmedBindingRecordV1[]; fingerprint: string }> {
  const fingerprint = createEditorProjectFingerprint(editorProject);
  const context: ConstraintGroundingContextV1 = { intent, project: editorProject, projectFingerprint: fingerprint };
  const clauses = hardClauses(intent);
  const confirmed = selections.flatMap((selection, index) => selection
    ? [accepted(confirmDirectSelectionV1({ context, sourceClauseId: clauses[index].clauseId, selection }))]
    : []);
  const result = buildConstraintSetV1({ intent, project: editorProject, projectFingerprint: fingerprint, confirmedBindings: confirmed });
  assert.equal(result.status, "CONSTRAINT_SET_BUILT");
  if (result.status !== "CONSTRAINT_SET_BUILT") throw new Error("ConstraintSet build failed.");
  return { constraintSet: result.constraintSet, confirmed, fingerprint };
}

function campusScenario(
  durationMs = 30_000,
  durationPolicy: DurationPolicy = "TARGET",
): Readonly<{ project: EditorProject; intent: CreativeIntentV1; constraintSet: ConstraintSetV1; fingerprint: string }> {
  const editorProject = campusProject();
  const intent = makeIntent(editorProject.id, durationMs, durationPolicy);
  const built = buildScenario(editorProject, intent, [
    { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 } },
    { bindingType: "CLIP", clipId: "clip-logo" },
  ]);
  return { project: editorProject, intent, constraintSet: built.constraintSet, fingerprint: built.fingerprint };
}

function evaluate(scenario: ReturnType<typeof campusScenario>): ConstraintFeasibilityReportV1 {
  return evaluateConstraintFeasibilityV1({
    project: scenario.project,
    intent: scenario.intent,
    constraintSet: scenario.constraintSet,
    projectFingerprint: scenario.fingerprint,
  });
}

function normalized(id: string, startMs: number, endMs: number): Pick<NormalizedProtectedRangeV1, "constraintId" | "timelineMapping"> {
  return { constraintId: id, timelineMapping: { startMs, endMs, mappingType: "DIRECT_TIMELINE" } };
}

test("range A-D: disjoint ranges stay separate; overlapping, nested, and touching ranges merge without double counting", () => {
  assert.deepEqual(mergeProtectedTimelineRangesV1([normalized("a", 0, 10), normalized("b", 20, 30)]).map((range) => [range.startMs, range.endMs]), [[0, 10], [20, 30]]);
  assert.deepEqual(mergeProtectedTimelineRangesV1([normalized("a", 10, 30), normalized("b", 28, 35)]).map((range) => [range.startMs, range.endMs]), [[10, 35]]);
  assert.deepEqual(mergeProtectedTimelineRangesV1([normalized("a", 10, 40), normalized("b", 20, 30)]).map((range) => [range.startMs, range.endMs]), [[10, 40]]);
  assert.deepEqual(mergeProtectedTimelineRangesV1([normalized("a", 10, 20), normalized("b", 20, 30)]).map((range) => [range.startMs, range.endMs]), [[10, 30]]);
});

test("range E/F/I: protected clip and ending map to trusted output intervals and ending is anchored", () => {
  const report = evaluate(campusScenario(38_000));
  const ending = report.normalizedProtectedRanges.find((range) => range.timelineMapping.clipId === "clip-logo");
  assert.deepEqual(ending?.timelineMapping, { startMs: 35_000, endMs: 38_000, mappingType: "CURRENT_CLIP_OUTPUT", clipId: "clip-logo" });
  assert.equal(ending?.anchored, true);
  assert.equal(ending?.movable, false);
  assert.equal(report.mergedProtectedTimelineRanges.length, 1);
});

test("range G/H: exact source coordinate spaces stay distinct even though unique placements drive timeline arithmetic", () => {
  const editorProject = campusProject();
  const sourceIntent = makeIntent(editorProject.id, 38_000, "TARGET", [
    hard("PROTECT_TIME_RANGE", "SPEECH", "selected source A"),
    hard("PROTECT_TIME_RANGE", "SPEECH", "selected source B"),
  ]);
  const built = buildScenario(editorProject, sourceIntent, [
    { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "SOURCE_ASSET", assetId: "asset-speech", startMs: 0, endMs: 35_000 } },
    { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "SOURCE_ASSET", assetId: "asset-logo", startMs: 0, endMs: 3_000 } },
  ]);
  const report = evaluateConstraintFeasibilityV1({ project: editorProject, intent: sourceIntent, constraintSet: built.constraintSet, projectFingerprint: built.fingerprint });
  assert.equal(report.status, "FEASIBLE");
  assert.deepEqual(report.normalizedProtectedRanges.map((range) => range.coordinateSpace), ["SOURCE_ASSET", "SOURCE_ASSET"]);
  assert.deepEqual(report.normalizedProtectedRanges.map((range) => range.sourceIdentity?.assetId), ["asset-speech", "asset-logo"]);
  assert.equal(report.normalizedProtectedRanges.length, 2);
  assert.equal(report.mergedProtectedTimelineRanges.length, 1);
});

test("feasibility A/B/K: target above or exactly at minimum is feasible, and no target still reports protection", () => {
  const above = evaluate(campusScenario(40_000));
  const exact = evaluate(campusScenario(38_000));
  const noTargetProject = campusProject();
  const noTargetIntent = makeIntent(noTargetProject.id, null);
  const noTargetBuilt = buildScenario(noTargetProject, noTargetIntent, [
    { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 } },
    { bindingType: "CLIP", clipId: "clip-logo" },
  ]);
  const noTarget = evaluateConstraintFeasibilityV1({
    project: noTargetProject,
    intent: noTargetIntent,
    constraintSet: noTargetBuilt.constraintSet,
    projectFingerprint: noTargetBuilt.fingerprint,
  });
  assert.deepEqual([above.status, exact.status, noTarget.status], ["FEASIBLE", "FEASIBLE", "FEASIBLE"]);
  assert.equal(exact.minimumProtectedDurationMs, 38_000);
  assert.equal(exact.minimumFeasibleDurationMs, 38_000);
  assert.equal(noTarget.requestedDurationMs, null);
  assert.equal(noTarget.minimumProtectedDurationMs, 38_000);
});

test("feasibility C/D/I/L and campus fixture: 35s confirmed speech plus non-overlapping 3s ending leaves an explicit 8s soft-target gap", () => {
  const report = evaluate(campusScenario());
  assert.equal(report.status, "FEASIBLE_WITH_TARGET_GAP");
  assert.equal(report.readiness, "NEEDS_USER_DECISION");
  assert.equal(report.requestedDurationMs, 30_000);
  assert.equal(report.minimumProtectedDurationMs, 38_000);
  assert.equal(report.minimumFeasibleDurationMs, 38_000);
  assert.equal(report.compressibleUnprotectedDurationMs, 0);
  assert.equal(report.remainingGapMs, 8_000);
  const duration = report.conflicts.find((conflict) => conflict.type === "DURATION_CONFLICT");
  assert.equal(duration?.status, "CONFIRMED_CONFLICT");
  assert.deepEqual(duration?.involvedConstraintIds, scenarioConstraintIds(campusScenario()));
  assert.equal(duration?.evidence.kind, "DURATION_GAP");
  if (duration?.evidence.kind === "DURATION_GAP") assert.equal(duration.evidence.remainingGapMs, 8_000);
  assert.equal(duration?.possibleResolutions.find((option) => option.type === "OPTIMIZE_UNPROTECTED_ONLY")?.canReachRequestedDuration, false);
});

function scenarioConstraintIds(scenario: ReturnType<typeof campusScenario>): readonly string[] {
  return scenario.constraintSet.activeConstraints.map((constraint) => constraint.constraintId).sort();
}

test("feasibility J: an overlapping ending reduces the protected lower bound", () => {
  const editorProject = campusProject();
  editorProject.durationMs = 35_000;
  editorProject.audioSelection = { ...editorProject.audioSelection, sourceDurationMs: 35_000, sourceOutMs: 35_000, selectedDurationMs: 35_000 };
  editorProject.tracks.push({ id: "track-overlay", type: "broll", name: "Overlay", clips: [clip("clip-logo-overlay", "asset-logo", "track-overlay", 32_000, 35_000)] });
  const intent = makeIntent(editorProject.id, 30_000);
  const built = buildScenario(editorProject, intent, [
    { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 } },
    { bindingType: "CLIP", clipId: "clip-logo-overlay" },
  ]);
  const report = evaluateConstraintFeasibilityV1({ project: editorProject, intent, constraintSet: built.constraintSet, projectFingerprint: built.fingerprint });
  assert.equal(report.minimumProtectedDurationMs, 35_000);
  assert.equal(report.minimumFeasibleDurationMs, 35_000);
  assert.equal(report.remainingGapMs, 5_000);
});

test("lower-bound policy counts wholly unprotected clips as compressible but never treats unknown gaps as zero", () => {
  const editorProject = campusProject();
  editorProject.durationMs = 40_000;
  editorProject.tracks[0].clips = editorProject.tracks[0].clips.filter((item) => item.id !== "clip-logo");
  editorProject.assets.push({ id: "asset-removable", name: "removable.mp4", kind: "视频", durationMs: 2_000 });
  editorProject.tracks[0].clips.push(clip("clip-removable", "asset-removable", "track-main", 38_000, 40_000));
  editorProject.audioSelection = { ...editorProject.audioSelection, sourceDurationMs: 40_000, sourceOutMs: 40_000, selectedDurationMs: 40_000 };
  const oneHard = [hard("PROTECT_TIME_RANGE", "SPEECH", "selected speech")];
  const intent = makeIntent(editorProject.id, 35_000, "TARGET", oneHard);
  const built = buildScenario(editorProject, intent, [{ bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 } }]);
  const report = evaluateConstraintFeasibilityV1({ project: editorProject, intent, constraintSet: built.constraintSet, projectFingerprint: built.fingerprint });
  assert.equal(report.compressibleUnprotectedDurationMs, 2_000);
  assert.equal(report.nonRemovableUnprotectedLowerBoundMs, 3_000);
  assert.equal(report.minimumFeasibleDurationMs, 38_000);
});

test("feasibility E and conflict C: unresolved teacher/logo references require user decision and emit ambiguous-reference conflicts", () => {
  const editorProject = campusProject();
  const intent = makeIntent(editorProject.id);
  const built = buildScenario(editorProject, intent, [undefined, undefined]);
  const report = evaluateConstraintFeasibilityV1({ project: editorProject, intent, constraintSet: built.constraintSet, projectFingerprint: built.fingerprint });
  assert.equal(report.status, "NEEDS_USER_DECISION");
  assert.equal(report.readiness, "NEEDS_USER_DECISION");
  assert.equal(report.conflicts.filter((conflict) => conflict.type === "AMBIGUOUS_REFERENCE").length, 2);
  assert.equal(report.conflicts.some((conflict) => conflict.evidence.kind === "UNRESOLVED_REFERENCE" && conflict.evidence.referenceText.includes("老师")), true);
});

test("feasibility F: stale ConstraintSet/project fingerprint is blocked as NOT_EVALUABLE", () => {
  const scenario = campusScenario();
  const changed = structuredClone(scenario.project);
  changed.captions.push({ id: "caption-change", text: "change", startMs: 1, endMs: 2 });
  const report = evaluateConstraintFeasibilityV1({
    project: changed,
    intent: scenario.intent,
    constraintSet: scenario.constraintSet,
    projectFingerprint: createEditorProjectFingerprint(changed),
  });
  assert.equal(report.status, "NOT_EVALUABLE");
  assert.equal(report.readiness, "BLOCKED_NOT_EVALUABLE");
  assert.equal(report.minimumFeasibleDurationMs, null);
});

test("feasibility G and conflict D: ambiguous source placement and nonlinear timing are unsupported, never estimated", () => {
  const editorProject = campusProject();
  editorProject.tracks.push({ id: "track-copy", type: "broll", name: "Copy", clips: [clip("clip-speech-copy", "asset-speech", "track-copy", 0, 35_000)] });
  const intent = makeIntent(editorProject.id, 30_000, "TARGET", [hard("PROTECT_TIME_RANGE", "SPEECH", "selected source")]);
  const built = buildScenario(editorProject, intent, [{ bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "SOURCE_ASSET", assetId: "asset-speech", startMs: 0, endMs: 35_000 } }]);
  const report = evaluateConstraintFeasibilityV1({ project: editorProject, intent, constraintSet: built.constraintSet, projectFingerprint: built.fingerprint });
  assert.equal(report.status, "NOT_EVALUABLE");
  const conflict = report.conflicts.find((item) => item.type === "UNSUPPORTED_OPERATION");
  assert.equal(conflict?.status, "NOT_EVALUABLE");
  assert.equal(conflict?.evidence.kind, "UNSUPPORTED_TEMPORAL_OPERATION");
});

test("hard MAXIMUM/EXACT duration truth is a confirmed overall conflict while normal TARGET never weakens hard protections", () => {
  const hardMaximum = evaluate(campusScenario(30_000, "MAXIMUM"));
  const exact = evaluate(campusScenario(30_000, "EXACT"));
  const normal = evaluate(campusScenario(30_000, "TARGET"));
  assert.deepEqual([hardMaximum.status, exact.status, normal.status], ["CONFIRMED_CONFLICT", "CONFIRMED_CONFLICT", "FEASIBLE_WITH_TARGET_GAP"]);
  for (const report of [hardMaximum, exact, normal]) assert.equal(report.minimumProtectedDurationMs, 38_000);
});

test("PRESERVE_ENDING outside the final ending boundary emits a protected-range conflict", () => {
  const editorProject = campusProject();
  editorProject.durationMs = 40_000;
  editorProject.assets.push({ id: "asset-tail", name: "tail.mp4", kind: "视频", durationMs: 2_000 });
  editorProject.tracks[0].clips.push(clip("clip-tail", "asset-tail", "track-main", 38_000, 40_000));
  editorProject.audioSelection = { ...editorProject.audioSelection, sourceDurationMs: 40_000, sourceOutMs: 40_000, selectedDurationMs: 40_000 };
  const intent = makeIntent(editorProject.id, 40_000, "TARGET", [hard("PRESERVE_ENDING", "ENDING_CONTENT", "selected ending")]);
  const built = buildScenario(editorProject, intent, [{ bindingType: "CLIP", clipId: "clip-logo" }]);
  const report = evaluateConstraintFeasibilityV1({ project: editorProject, intent, constraintSet: built.constraintSet, projectFingerprint: built.fingerprint });
  assert.equal(report.status, "CONFIRMED_CONFLICT");
  assert.equal(report.conflicts.some((conflict) => conflict.type === "PROTECTED_RANGE_CONFLICT"), true);
});

test("conflicts A/B/E/F/G: IDs, duration evidence, involved IDs, metadata, and ordering are deterministic", () => {
  const firstScenario = campusScenario();
  const secondScenario = campusScenario();
  const first = evaluate(firstScenario);
  const second = evaluate(secondScenario);
  assert.equal(first.reportId, second.reportId);
  assert.deepEqual(first.conflicts.map((conflict) => conflict.conflictId), second.conflicts.map((conflict) => conflict.conflictId));
  const duration = first.conflicts.find((conflict) => conflict.type === "DURATION_CONFLICT");
  assert.ok(duration);
  assert.deepEqual(duration?.involvedConstraintIds, scenarioConstraintIds(firstScenario));
  assert.equal(duration?.evidence.kind, "DURATION_GAP");
  assert.deepEqual(duration?.possibleResolutions.map((option) => option.lifecycle), ["METADATA_ONLY", "METADATA_ONLY", "METADATA_ONLY"]);
  assert.deepEqual(first.normalizedProtectedRanges.map((range) => range.constraintId), second.normalizedProtectedRanges.map((range) => range.constraintId));
});

test("conflict type system supports action-permission and resolved-by-user states without implementing resolution", () => {
  const first = createConstraintConflictV1({
    type: "ACTION_PERMISSION_CONFLICT",
    status: "POSSIBLE_CONFLICT",
    involvedConstraintIds: ["constraint-v1-bbbbbbbb", "constraint-v1-aaaaaaaa"],
    evidence: { kind: "PERMISSION_COLLISION", actionType: "TRIM_CLIP", reason: "Protected range denies trimming." },
    possibleResolutions: [{ type: "EDIT_REQUIREMENTS_MANUALLY", lifecycle: "METADATA_ONLY" }],
  });
  const second = createConstraintConflictV1({
    type: "ACTION_PERMISSION_CONFLICT",
    status: "POSSIBLE_CONFLICT",
    involvedConstraintIds: ["constraint-v1-aaaaaaaa", "constraint-v1-bbbbbbbb"],
    evidence: { kind: "PERMISSION_COLLISION", actionType: "TRIM_CLIP", reason: "Protected range denies trimming." },
    possibleResolutions: [{ type: "EDIT_REQUIREMENTS_MANUALLY", lifecycle: "METADATA_ONLY" }],
  });
  const resolvedMetadata = createConstraintConflictV1({
    type: "ACTION_PERMISSION_CONFLICT",
    status: "RESOLVED_BY_USER",
    involvedConstraintIds: first.involvedConstraintIds,
    evidence: first.evidence,
  });
  assert.equal(first.conflictId, second.conflictId);
  assert.deepEqual(first.involvedConstraintIds, ["constraint-v1-aaaaaaaa", "constraint-v1-bbbbbbbb"]);
  assert.equal(resolvedMetadata.status, "RESOLVED_BY_USER");
});

test("mixed ambiguous and unsupported conflicts retain deterministic ordering", () => {
  const editorProject = campusProject();
  editorProject.tracks.push({ id: "track-copy", type: "broll", name: "Copy", clips: [clip("clip-copy", "asset-speech", "track-copy", 0, 35_000)] });
  const intent = makeIntent(editorProject.id, 30_000, "TARGET", [
    hard("PROTECT_TIME_RANGE", "SPEECH", "confirmed source"),
    hard("PRESERVE_ENDING", "VISUAL_OBJECT", "学校Logo"),
  ]);
  const built = buildScenario(editorProject, intent, [
    { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "SOURCE_ASSET", assetId: "asset-speech", startMs: 0, endMs: 35_000 } },
    undefined,
  ]);
  const report = evaluateConstraintFeasibilityV1({ project: editorProject, intent, constraintSet: built.constraintSet, projectFingerprint: built.fingerprint });
  assert.deepEqual(report.conflicts.map((conflict) => conflict.type), ["AMBIGUOUS_REFERENCE", "UNSUPPORTED_OPERATION"]);
  assert.equal(report.status, "NOT_EVALUABLE");
});
