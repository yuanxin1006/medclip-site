import { DEFAULT_SPEED_CURVE, DEFAULT_TRANSFORM, type EditorProject, type TimelineClip } from "../editor-core.ts";
import type { CreativeIntentV1 } from "../editor-creative-intent.ts";
import {
  buildConstraintSetV1,
  confirmDirectSelectionV1,
  type ConfirmedBindingRecordV1,
  type ConstraintGroundingContextV1,
} from "../editor-constraint-grounding.ts";
import {
  PROTECTED_SPEECH_PERMISSIONS,
  createActiveConstraint,
  createConstraintBinding,
  createConstraintSet,
  type ConstraintSetV1,
  type ProtectionPermissionPolicyV1,
} from "../editor-constraints.ts";
import { createEditorProjectFingerprint } from "../editor-plan-evidence.ts";
import { createCampusNegotiationIntent, createCampusNegotiationProject } from "./editor-constraint-negotiation-fixture.ts";

function clip(id: string, assetId: string, trackId: string, startMs: number, endMs: number): TimelineClip {
  return {
    id, assetId, trackId, name: id, kind: "视频", timelineStartMs: startMs, timelineEndMs: endMs,
    sourceInMs: 0, sourceOutMs: endMs - startMs, transform: { ...DEFAULT_TRANSFORM },
    speedCurve: DEFAULT_SPEED_CURVE.map((point) => ({ ...point })),
  };
}
export function createConstraintEnforcementFixture(options: Readonly<{
  includeUnprotected?: boolean;
  captionBinding?: boolean;
  speechPermissions?: ProtectionPermissionPolicyV1;
}> = {}): Readonly<{
  project: EditorProject;
  projectFingerprint: string;
  intent: CreativeIntentV1;
  confirmedBindings: readonly ConfirmedBindingRecordV1[];
  constraintSet: ConstraintSetV1;
}> {
  const project = structuredClone(createCampusNegotiationProject());
  if (options.includeUnprotected) {
    project.assets.push(
      { id: "asset-broll", name: "broll.mp4", kind: "视频", durationMs: 3_000 },
      { id: "asset-broll-alt", name: "broll-alt.mp4", kind: "视频", durationMs: 3_000 },
    );
    project.tracks.push({
      id: "track-broll", type: "broll", name: "B-roll",
      clips: [clip("clip-broll", "asset-broll", "track-broll", 35_000, 38_000)],
    });
  }
  const projectFingerprint = createEditorProjectFingerprint(project);
  const intent = createCampusNegotiationIntent(project.id);
  const context: ConstraintGroundingContextV1 = { intent, project, projectFingerprint };
  const hardClauses = intent.clauses.filter((item) => item.kind === "HARD_CONSTRAINT_REQUEST");
  const speech = confirmDirectSelectionV1({
    context,
    sourceClauseId: hardClauses[0].clauseId,
    selection: options.captionBinding
      ? { bindingType: "CAPTION", captionId: "caption-teacher" }
      : { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 } },
  });
  const ending = confirmDirectSelectionV1({
    context,
    sourceClauseId: hardClauses[1].clauseId,
    selection: { bindingType: "CLIP", clipId: "clip-logo" },
  });
  if (speech.status !== "ACCEPTED" || ending.status !== "ACCEPTED") throw new Error("Constraint test grounding failed.");
  const confirmedBindings: readonly ConfirmedBindingRecordV1[] = Object.freeze([speech.value, ending.value]);
  const built = buildConstraintSetV1({
    intent,
    project,
    projectFingerprint,
    confirmedBindings,
    ...(options.speechPermissions ? { permissionPolicies: { [hardClauses[0].clauseId]: options.speechPermissions } } : {}),
  });
  if (built.status !== "CONSTRAINT_SET_BUILT") throw new Error(`Constraint test set failed: ${built.message}`);
  return Object.freeze({ project, projectFingerprint, intent, confirmedBindings, constraintSet: built.constraintSet });
}

export function createProtectedClipConstraintSet(
  project: EditorProject,
  clipId: string,
  permissions: ProtectionPermissionPolicyV1 = PROTECTED_SPEECH_PERMISSIONS,
): ConstraintSetV1 {
  const located = project.tracks.flatMap((track) => track.clips.map((item) => ({ track, item })))
    .find(({ item }) => item.id === clipId);
  if (!located) throw new Error(`Missing protected clip fixture target: ${clipId}`);
  const provenance = { schemaVersion: 1 as const, authority: "USER_DIRECT_SELECTION" as const, sourceReference: `test-protection:${clipId}` };
  const binding = createConstraintBinding({
    bindingType: "CLIP",
    projectId: project.id,
    state: "ACTIVE_HARD_CONSTRAINT",
    clipId,
    assetId: located.item.assetId,
    trackId: located.track.id,
    provenance,
  });
  if (binding.bindingType !== "CLIP") throw new Error("Expected clip binding.");
  const constraint = createActiveConstraint({
    type: "PROTECT_CLIP",
    sourceClauseId: "clause-v1-23e00001",
    binding,
    permissions,
    provenance,
    confirmationStatus: "USER_CONFIRMED",
  });
  return createConstraintSet({
    version: 1,
    projectId: project.id,
    intentVersionId: "intent-v1-23e00001",
    validatedAgainstProjectFingerprint: createEditorProjectFingerprint(project),
    activeConstraints: [constraint],
    confirmedBindings: [binding],
    resolutionIds: [],
  });
}
