import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createCampusNegotiationIntent, createCampusNegotiationProject } from "./test-support/editor-constraint-negotiation-fixture.ts";
import { createCandidateBindingV1 } from "./editor-constraint-grounding.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import { deriveProtectedTimelineAnnotationsV1 } from "./editor-protected-timeline.ts";
import { createConstraintEnforcementFixture } from "./test-support/editor-constraint-enforcement-fixture.ts";
import { guardManualTimelineMutationV1 } from "./editor-manual-constraint-guard.ts";

test("unresolved campus requests are visible without active lock styling", () => {
  const project = createCampusNegotiationProject();
  const intent = createCampusNegotiationIntent(project.id);
  const annotations = deriveProtectedTimelineAnnotationsV1({ project, intent });
  assert.equal(annotations.length, 2);
  assert.ok(annotations.every((item) => item.status === "UNRESOLVED_REFERENCE" && !item.isActiveHardConstraint));
  assert.ok(annotations.every((item) => item.timelineEnd === 0));
});

test("candidate range is visible as candidate and campus confirmations map to exact independent ranges", () => {
  const project = createCampusNegotiationProject();
  const intent = createCampusNegotiationIntent(project.id);
  const projectFingerprint = createEditorProjectFingerprint(project);
  const hard = intent.clauses.filter((item) => item.kind === "HARD_CONSTRAINT_REQUEST");
  const candidate = createCandidateBindingV1({
    context: { intent, project, projectFingerprint }, sourceClauseId: hard[0].clauseId,
    selection: { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 } },
    provenance: { authority: "MODEL_SUGGESTION", sourceReference: "candidate" },
  });
  assert.equal(candidate.status, "ACCEPTED");
  if (candidate.status !== "ACCEPTED") return;
  const candidateAnnotations = deriveProtectedTimelineAnnotationsV1({ project, intent, candidateBindings: [candidate.value] });
  assert.equal(candidateAnnotations[0].status, "CANDIDATE_BINDING");
  assert.equal(candidateAnnotations[0].isActiveHardConstraint, false);
  const fixture = createConstraintEnforcementFixture();
  const active = deriveProtectedTimelineAnnotationsV1({ project: fixture.project, intent: fixture.intent, constraintSet: fixture.constraintSet, confirmedBindings: fixture.confirmedBindings });
  assert.deepEqual(active.map(({ timelineStart, timelineEnd }) => [timelineStart, timelineEnd]), [[0, 35_000], [35_000, 38_000]]);
  assert.ok(active.every((item) => item.status === "ACTIVE_HARD_CONSTRAINT" && item.isActiveHardConstraint));
  assert.notEqual(active[0].sourceClauseId, active[1].sourceClauseId);
});

test("fingerprint invalidation is shown stale, and drawing annotations does not mutate ConstraintSet", () => {
  const fixture = createConstraintEnforcementFixture();
  const frozenSet = structuredClone(fixture.constraintSet);
  const changed = structuredClone(fixture.project);
  changed.title += " edited";
  const annotations = deriveProtectedTimelineAnnotationsV1({ project: changed, intent: fixture.intent, constraintSet: fixture.constraintSet, confirmedBindings: fixture.confirmedBindings });
  assert.ok(annotations.every((item) => item.status === "STALE" && !item.isActiveHardConstraint));
  assert.deepEqual(fixture.constraintSet, frozenSet);
});

test("blocked transform and reorder enforcement results resolve to their exact protection annotations", () => {
  const fixture = createConstraintEnforcementFixture();
  const annotations = deriveProtectedTimelineAnnotationsV1({ project: fixture.project, intent: fixture.intent, constraintSet: fixture.constraintSet, confirmedBindings: fixture.confirmedBindings });
  const changed = structuredClone(fixture.project);
  changed.tracks[0].clips[0].transform.scale = 1.1;
  const transform = guardManualTimelineMutationV1({
    currentProject: fixture.project, candidateProject: changed, constraintSet: fixture.constraintSet,
    action: { type: "SET_CLIP_POSITION_SCALE", targetId: "clip-teacher", scale: 1.1 },
  });
  assert.equal(transform.status, "BLOCKED_HARD_CONSTRAINT");
  const transformAnnotation = annotations.find((item) => item.constraintId === transform.violations[0].constraintId);
  assert.ok(transformAnnotation);
  assert.match(transformAnnotation.label, /老师/);

  const reorder = guardManualTimelineMutationV1({
    currentProject: fixture.project, candidateProject: fixture.project, constraintSet: fixture.constraintSet,
    action: { type: "REORDER_CLIP", targetId: "clip-logo", referenceId: "clip-teacher", placement: "BEFORE" },
  });
  assert.equal(reorder.status, "BLOCKED_HARD_CONSTRAINT");
  const reorderAnnotation = annotations.find((item) => item.constraintId === reorder.violations[0].constraintId);
  assert.ok(reorderAnnotation);
  assert.ok(["老师", "Logo", "logo"].some((word) => reorderAnnotation.label.includes(word)));
});

test("timeline lane exposes icon, label, status and details while preserving the shared guard", () => {
  const timeline = readFileSync(new URL("./TimelineEditor.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
  assert.match(timeline, /className=\{`timeline-protection \$\{annotation\.status/);
  assert.match(timeline, /annotation\.isActiveHardConstraint \? "🔒"/);
  assert.match(timeline, /<b>\{annotation\.label\}<\/b>/);
  assert.match(timeline, /<small>\{annotation\.status/);
  assert.match(timeline, /title=\{`\$\{annotation\.tooltipSummary\}/);
  assert.match(timeline, /setDetailAnnotationId/);
  assert.match(timeline, /guardManualTimelineMutationV1/);
  assert.match(styles, /\.timeline-protection\.active-hard-constraint/);
  assert.match(styles, /\.timeline-protection\.candidate-binding/);
  assert.match(styles, /\.timeline-protection\.unresolved-reference/);
  assert.match(styles, /\.timeline-protection\.stale/);
});
