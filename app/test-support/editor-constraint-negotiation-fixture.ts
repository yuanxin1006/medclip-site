import { DEFAULT_SPEED_CURVE, DEFAULT_TRANSFORM, type EditorProject, type TimelineClip } from "../editor-core.ts";
import { createCreativeIntent, type CreativeIntentV1, type IntentClauseDraft } from "../editor-creative-intent.ts";
import { createEditorProjectFingerprint } from "../editor-plan-evidence.ts";
import {
  buildConstraintSetV1,
  confirmDirectSelectionV1,
  type ConfirmedBindingRecordV1,
  type ConstraintGroundingContextV1,
} from "../editor-constraint-grounding.ts";
import { evaluateConstraintFeasibilityV1, type ConstraintFeasibilityReportV1 } from "../editor-constraint-feasibility.ts";
import type { ConstraintSetV1 } from "../editor-constraints.ts";
import {
  createNegotiationStateV1,
  negotiationStateFromFeasibilityV1,
  transitionNegotiationStateV1,
  type NegotiationStateV1,
} from "../editor-constraint-negotiation.ts";

export const NEGOTIATION_FIXTURE_CREATED_AT = "2026-10-25T00:00:00.000Z";
const userText = { schemaVersion: 1 as const, authority: "USER_TEXT" as const, sourceReference: "campus-request" };

function clip(id: string, assetId: string, timelineStartMs: number, timelineEndMs: number): TimelineClip {
  return {
    id, assetId, name: id, kind: "视频", trackId: "track-main", timelineStartMs, timelineEndMs,
    sourceInMs: 0, sourceOutMs: timelineEndMs - timelineStartMs,
    transform: { ...DEFAULT_TRANSFORM }, speedCurve: DEFAULT_SPEED_CURVE.map((point) => ({ ...point })),
  };
}

export function createCampusNegotiationProject(): EditorProject {
  return {
    schemaVersion: 2, id: "project-campus-negotiation", title: "Campus negotiation", updatedAt: NEGOTIATION_FIXTURE_CREATED_AT,
    durationMs: 38_000, ratio: "16:9",
    audioSelection: { mode: "full", sourceDurationMs: 38_000, sourceInMs: 0, sourceOutMs: 38_000, selectedDurationMs: 38_000 },
    assets: [
      { id: "asset-teacher", name: "teacher.mp4", kind: "视频", durationMs: 35_000 },
      { id: "asset-logo", name: "logo.mp4", kind: "视频", durationMs: 3_000 },
    ],
    tracks: [{ id: "track-main", type: "video", name: "Main", clips: [
      clip("clip-teacher", "asset-teacher", 0, 35_000),
      clip("clip-logo", "asset-logo", 35_000, 38_000),
    ] }],
    captions: [{ id: "caption-teacher", text: "老师完整讲话", startMs: 0, endMs: 35_000 }],
  };
}

function hard(type: "PROTECT_TIME_RANGE" | "PRESERVE_ENDING", semanticKind: "SPEECH" | "VISUAL_OBJECT", referenceText: string): IntentClauseDraft {
  return {
    kind: "HARD_CONSTRAINT_REQUEST",
    payload: { type, reference: { schemaVersion: 1, state: "UNRESOLVED_REFERENCE", semanticKind, referenceText } },
    provenance: userText,
  };
}

export function createCampusNegotiationIntent(projectId: string): CreativeIntentV1 {
  return createCreativeIntent({
    version: 1,
    projectId,
    sourceRequest: "请剪成30秒，节奏欢快，保留老师完整讲话和结尾Logo",
    clauses: [
      { kind: "GOAL", payload: { type: "TARGET_DURATION", durationMs: 30_000, policy: "TARGET" }, provenance: userText },
      { kind: "SOFT_PREFERENCE", payload: { type: "PACE", value: "UPBEAT" }, provenance: userText },
      hard("PROTECT_TIME_RANGE", "SPEECH", "老师完整讲话"),
      hard("PRESERVE_ENDING", "VISUAL_OBJECT", "结尾Logo"),
    ],
    groundingState: "USER_CONFIRMED_BINDING",
    resolutionIds: [],
    createdAt: NEGOTIATION_FIXTURE_CREATED_AT,
  });
}

export type CampusNegotiationScenario = Readonly<{
  project: EditorProject;
  projectFingerprint: string;
  intent: CreativeIntentV1;
  confirmedBindings: readonly ConfirmedBindingRecordV1[];
  constraintSet: ConstraintSetV1;
  report: ConstraintFeasibilityReportV1;
  state: NegotiationStateV1;
}>;

export function createCampusNegotiationScenario(): CampusNegotiationScenario {
  const project = createCampusNegotiationProject();
  const projectFingerprint = createEditorProjectFingerprint(project);
  const intent = createCampusNegotiationIntent(project.id);
  const context: ConstraintGroundingContextV1 = { intent, project, projectFingerprint };
  const hardClauses = intent.clauses.filter((item) => item.kind === "HARD_CONSTRAINT_REQUEST");
  const speech = confirmDirectSelectionV1({
    context,
    sourceClauseId: hardClauses[0].clauseId,
    selection: { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 } },
  });
  const logo = confirmDirectSelectionV1({ context, sourceClauseId: hardClauses[1].clauseId, selection: { bindingType: "CLIP", clipId: "clip-logo" } });
  if (speech.status !== "ACCEPTED" || logo.status !== "ACCEPTED") throw new Error("Campus fixture grounding failed.");
  const confirmedBindings = Object.freeze([speech.value, logo.value]);
  const built = buildConstraintSetV1({ intent, project, projectFingerprint, confirmedBindings });
  if (built.status !== "CONSTRAINT_SET_BUILT") throw new Error(`Campus fixture ConstraintSet failed: ${built.message}`);
  const constraintSet = built.constraintSet;
  const report = evaluateConstraintFeasibilityV1({ project, intent, constraintSet, projectFingerprint });
  const draft = createNegotiationStateV1(intent);
  const checking = transitionNegotiationStateV1(draft, {
    status: "FEASIBILITY_CHECK", activeIntentVersionId: intent.intentId,
    constraintSetId: constraintSet.constraintSetId, constraintFingerprint: constraintSet.constraintFingerprint,
    resolutionIds: intent.resolutionIds, unresolvedConflictIds: [], planningPaused: false,
  });
  const state = negotiationStateFromFeasibilityV1(checking, intent, constraintSet, report);
  return Object.freeze({ project, projectFingerprint, intent, confirmedBindings, constraintSet, report, state });
}
