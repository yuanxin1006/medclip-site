import type { ConstraintSetV1 } from "./editor-constraints.ts";
import {
  enforceEditorActionConstraintsV1,
  verifyPostApplyConstraintInvariantsV1,
  type ConstraintCandidateActionV1,
  type ConstraintEnforcementResultV1,
} from "./editor-constraint-enforcement.ts";
import type { EditorProject } from "./editor-core.ts";

export type ManualTimelineMutationGuardInputV1 = Readonly<{
  currentProject: EditorProject;
  candidateProject: EditorProject;
  constraintSet?: ConstraintSetV1;
  action?: ConstraintCandidateActionV1;
}>;

/**
 * One pure guard for all TimelineEditor callbacks. It neither commits state nor
 * records history; callers may expose the candidate only when status is ALLOWED.
 */
export function guardManualTimelineMutationV1(
  input: ManualTimelineMutationGuardInputV1,
): ConstraintEnforcementResultV1 {
  const actionResult = enforceEditorActionConstraintsV1({
    project: input.currentProject,
    constraintSet: input.constraintSet,
    action: input.action,
    candidateProject: input.candidateProject,
  });
  if (actionResult.status !== "ALLOWED") return actionResult;
  return verifyPostApplyConstraintInvariantsV1({
    preProject: input.currentProject,
    candidateProject: input.candidateProject,
    constraintSet: input.constraintSet,
  });
}
