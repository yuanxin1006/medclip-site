import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CreativeIntentPanel } from "./editor-creative-intent-panel.ts";
import { resolveSafeProtectionDisplayLabel } from "./editor-creative-intent-panel.ts";
import { EditorDecisionExplanationPanel } from "./editor-decision-explanation-panel.ts";
import { deriveEditorDecisionExplanationsV1 } from "./editor-decision-explanations.ts";
import { deriveProtectedTimelineAnnotationsV1 } from "./editor-protected-timeline.ts";
import { ConstraintNegotiationPanel } from "./editor-constraint-negotiation-panel.ts";
import { createCampusNegotiationProject } from "./test-support/editor-constraint-negotiation-fixture.ts";
import { parseCreativeIntentModelOutputV1 } from "./editor-creative-intent-intake.ts";
import { analyzingCreativeIntentSessionV1, confirmCreativeIntentGroundingV1, creativeIntentReadySessionV1, emptyCreativeIntentSessionV1, evaluateCreativeIntentSessionV1, invalidateCreativeIntentSessionV1, resolveCreativeIntentConflictV1 } from "./editor-creative-intent-session.ts";

const sourceRequest = "请剪成30秒，节奏欢快，保留老师完整讲话和结尾Logo";
const modelOutput = { schemaVersion: 1, sourceRequest, clauses: [
  { kind: "GOAL", payload: { type: "TARGET_DURATION", durationMs: 30_000, policy: "TARGET" }, provenance: { schemaVersion: 1, authority: "MODEL_SUGGESTION", sourceReference: "30秒" } },
  { kind: "SOFT_PREFERENCE", payload: { type: "PACE", value: "UPBEAT" }, provenance: { schemaVersion: 1, authority: "MODEL_SUGGESTION", sourceReference: "节奏欢快" } },
  { kind: "HARD_CONSTRAINT_REQUEST", payload: { type: "PROTECT_TIME_RANGE", reference: { schemaVersion: 1, state: "UNRESOLVED_REFERENCE", semanticKind: "SPEECH", referenceText: "老师完整讲话" } }, provenance: { schemaVersion: 1, authority: "MODEL_UNCERTAIN_INFERENCE", sourceReference: "老师完整讲话" } },
  { kind: "HARD_CONSTRAINT_REQUEST", payload: { type: "PRESERVE_ENDING", reference: { schemaVersion: 1, state: "UNRESOLVED_REFERENCE", semanticKind: "VISUAL_OBJECT", referenceText: "结尾Logo" } }, provenance: { schemaVersion: 1, authority: "MODEL_UNCERTAIN_INFERENCE", sourceReference: "结尾Logo" } },
] };

function ready() {
  const project = createCampusNegotiationProject();
  const intent = parseCreativeIntentModelOutputV1({ modelOutput, projectId: project.id, sourceRequest, createdAt: "2026-10-25T01:00:00.000Z" });
  return { project, intent, session: creativeIntentReadySessionV1(intent) };
}

function elements(node: ReactNode, type?: string): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  const self = !type || element.type === type ? [element] : [];
  const children = Array.isArray(element.props.children) ? element.props.children : [element.props.children];
  return [...self, ...children.flatMap((child) => elements(child, type))];
}

test("production state covers required lifecycle and campus 30/38/8 Option B truth", () => {
  assert.equal(emptyCreativeIntentSessionV1().status, "NO_INTENT");
  assert.equal(analyzingCreativeIntentSessionV1(sourceRequest).status, "ANALYZING_INTENT");
  const baseline = ready();
  assert.equal(baseline.session.status, "GROUNDING_REQUIRED");
  const hard = baseline.intent.clauses.filter((item) => item.kind === "HARD_CONSTRAINT_REQUEST");
  const speech = confirmCreativeIntentGroundingV1({ session: baseline.session, project: baseline.project, sourceClauseId: hard[0].clauseId, selection: { bindingType: "CAPTION", captionId: "caption-teacher" } });
  assert.equal(speech.status, "GROUNDING_REQUIRED");
  const conflict = confirmCreativeIntentGroundingV1({ session: speech, project: baseline.project, sourceClauseId: hard[1].clauseId, selection: { bindingType: "CLIP", clipId: "clip-logo" } });
  assert.equal(conflict.status, "NEEDS_USER_DECISION");
  assert.equal(conflict.feasibilityReport?.requestedDurationMs, 30_000);
  assert.equal(conflict.feasibilityReport?.minimumFeasibleDurationMs, 38_000);
  assert.equal(conflict.feasibilityReport?.remainingGapMs, 8_000);
  const optionB = resolveCreativeIntentConflictV1({ session: conflict, project: baseline.project, choice: "OPTIMIZE_UNPROTECTED_ONLY", createdAt: "2026-10-25T02:00:00.000Z" });
  assert.equal(optionB.status, "READY_TO_PLAN");
  assert.equal(optionB.resolution?.structuredPolicy.policy, "CLOSEST_SAFELY_ACHIEVABLE");
  if (optionB.resolution?.structuredPolicy.policy === "CLOSEST_SAFELY_ACHIEVABLE") {
    assert.equal(optionB.resolution.structuredPolicy.canReachRequestedDuration, false);
    assert.equal(optionB.resolution.structuredPolicy.remainingGapMs, 8_000);
  }
  assert.equal(evaluateCreativeIntentSessionV1({ session: baseline.session, project: { ...baseline.project, id: "other-project" } }).status, "BLOCKED");
});
test("production feasibility and A/B/C UI renders report-derived 30/38/8 truth", () => {
  const baseline = ready();
  const hard = baseline.intent.clauses.filter((item) => item.kind === "HARD_CONSTRAINT_REQUEST");
  const speech = confirmCreativeIntentGroundingV1({ session: baseline.session, project: baseline.project, sourceClauseId: hard[0].clauseId, selection: { bindingType: "CAPTION", captionId: "caption-teacher" } });
  const conflict = confirmCreativeIntentGroundingV1({ session: speech, project: baseline.project, sourceClauseId: hard[1].clauseId, selection: { bindingType: "CLIP", clipId: "clip-logo" } });
  const conflictHtml = renderToStaticMarkup(ConstraintNegotiationPanel({
    state: conflict.negotiationState,
    report: conflict.feasibilityReport,
    onSelectResolution: () => undefined,
  }));
  assert.match(conflictHtml, /目标时长：30 秒/);
  assert.match(conflictHtml, /当前最短可行时长：38 秒/);
  assert.match(conflictHtml, /仍相差：8 秒/);
  assert.match(conflictHtml, /A\. 允许视频超过30秒/);
  assert.match(conflictHtml, /B\. 优先压缩其他非保护内容/);
  assert.match(conflictHtml, /C\. 暂时不执行/);

  const optionB = resolveCreativeIntentConflictV1({ session: conflict, project: baseline.project, choice: "OPTIMIZE_UNPROTECTED_ONLY", createdAt: "2026-10-25T02:00:00.000Z" });
  const optionBHtml = renderToStaticMarkup(ConstraintNegotiationPanel({
    state: optionB.negotiationState,
    report: optionB.feasibilityReport,
    resolution: optionB.resolution,
    onGenerateProposal: () => undefined,
  }));
  assert.match(optionBHtml, /当前最短可行时长仍为38 秒，比目标多8 秒/);
  assert.doesNotMatch(optionBHtml, /已满足30秒|已达到30秒/);
});
test("grounding UI is truthful and protection display appears only after ConstraintSet activation", () => {
  const baseline = ready();
  const unresolvedHtml = renderToStaticMarkup(CreativeIntentPanel({ session: baseline.session, project: baseline.project, onConfirmGrounding: () => undefined }));
  assert.match(unresolvedHtml, /不能可靠确定老师完整讲话/);
  assert.match(unresolvedHtml, /当前无法可靠确认结尾Logo对应的具体内容/);
  assert.doesNotMatch(unresolvedHtml, /学校 Logo/);
  assert.match(unresolvedHtml, /候选内容不是已识别事实/);
  assert.doesNotMatch(unresolvedHtml, /约束状态：已生效/);
  const hard = baseline.intent.clauses.filter((item) => item.kind === "HARD_CONSTRAINT_REQUEST");
  const speech = confirmCreativeIntentGroundingV1({ session: baseline.session, project: baseline.project, sourceClauseId: hard[0].clauseId, selection: { bindingType: "CAPTION", captionId: "caption-teacher" } });
  const active = confirmCreativeIntentGroundingV1({ session: speech, project: baseline.project, sourceClauseId: hard[1].clauseId, selection: { bindingType: "CLIP", clipId: "clip-logo" } });
  assert.equal(active.constraintSet?.activeConstraints.length, 2);
  const activeHtml = renderToStaticMarkup(CreativeIntentPanel({ session: active, project: baseline.project, onConfirmGrounding: () => undefined }));
  assert.match(activeHtml, /已确认保护/);
  assert.match(activeHtml, /老师完整讲话 00:00–00:35/);
  assert.match(activeHtml, /约束状态：已生效/);
});

test("active UUID-backed campus protections keep readable labels in Creative Intent, V2.4B, and V2.4C UI", () => {
  const baseline = ready();
  const logoUuid = "123e4567-e89b-42d3-a456-426614174000";
  const logoClip = baseline.project.tracks[0].clips.find((clip) => clip.id === "clip-logo")!;
  logoClip.id = logoUuid;
  logoClip.name = logoUuid;
  const hard = baseline.intent.clauses.filter((item) => item.kind === "HARD_CONSTRAINT_REQUEST");
  const speech = confirmCreativeIntentGroundingV1({
    session: baseline.session, project: baseline.project, sourceClauseId: hard[0].clauseId,
    selection: { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 } },
  });
  const active = confirmCreativeIntentGroundingV1({
    session: speech, project: baseline.project, sourceClauseId: hard[1].clauseId,
    selection: { bindingType: "CLIP", clipId: logoUuid },
  });
  const constraintSet = active.constraintSet;
  if (!constraintSet) throw new Error("Expected the confirmed campus ConstraintSet.");
  assert.ok(constraintSet.confirmedBindings.some((item) => item.bindingType === "CLIP" && item.clipId === logoUuid));
  const activeHtml = renderToStaticMarkup(CreativeIntentPanel({ session: active, project: baseline.project, onConfirmGrounding: () => undefined }));
  assert.match(activeHtml, /老师完整讲话 00:00–00:35/);
  assert.match(activeHtml, /结尾Logo 00:35–00:38/);
  assert.doesNotMatch(activeHtml, /123e4567-e89b-42d3-a456-426614174000/);

  const annotations = deriveProtectedTimelineAnnotationsV1({ project: baseline.project, intent: baseline.intent, constraintSet, confirmedBindings: active.confirmedBindings });
  assert.deepEqual(annotations.map((item) => [item.label, item.timelineStart, item.timelineEnd, item.status]), [
    ["老师完整讲话", 0, 35_000, "ACTIVE_HARD_CONSTRAINT"],
    ["结尾Logo", 35_000, 38_000, "ACTIVE_HARD_CONSTRAINT"],
  ]);
  assert.ok(annotations.some((item) => item.bindingId && item.constraintId));
  const explanations = deriveEditorDecisionExplanationsV1({ project: baseline.project, intent: baseline.intent, constraintSet, annotations });
  const explanationHtml = renderToStaticMarkup(createElement(EditorDecisionExplanationPanel, { explanations }));
  assert.match(explanationHtml, /老师完整讲话/);
  assert.match(explanationHtml, /保护范围：00:00–00:35/);
  assert.match(explanationHtml, /结尾Logo/);
  assert.match(explanationHtml, /保护范围：00:35–00:38/);
  assert.doesNotMatch(explanationHtml, /123e4567-e89b-42d3-a456-426614174000/);
});

test("safe protection labels reject UUID and opaque-ID fallbacks while preserving internal values", () => {
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(resolveSafeProtectionDisplayLabel([uuid, "clip-internal"], [uuid], "已确认片段"), "已确认片段");
  assert.equal(resolveSafeProtectionDisplayLabel(["老师完整讲话"], [uuid], "已确认片段"), "老师完整讲话");
});

test("grounding UI offers a compatible trusted clip selection for a speech PROTECT_CLIP request", () => {
  const project = createCampusNegotiationProject();
  const clipOutput = structuredClone(modelOutput) as { clauses: Array<{ payload: { type: string } }> };
  clipOutput.clauses[2].payload.type = "PROTECT_CLIP";
  const intent = parseCreativeIntentModelOutputV1({ modelOutput: clipOutput, projectId: project.id, sourceRequest, createdAt: "2026-10-25T01:00:00.000Z" });
  const session = creativeIntentReadySessionV1(intent);
  let observed: unknown;
  const tree = CreativeIntentPanel({ session, project, onConfirmGrounding: (_sourceClauseId, selection) => { observed = selection; } });
  const teacherButton = (elements(tree, "button") as Array<ReactElement<{ children?: ReactNode; onClick?: () => void }>>)
    .find((item) => typeof item.props.children === "string" && item.props.children.includes("确认保护讲话片段 00:00–00:35"));
  assert.ok(teacherButton);
  assert.doesNotMatch(String(teacherButton.props.children), /clip-teacher/);
  teacherButton?.props.onClick?.();
  assert.deepEqual(observed, { bindingType: "CLIP", clipId: "clip-teacher" });
});

test("requirement change invalidates dependent analysis and readiness", () => {
  const invalidated = invalidateCreativeIntentSessionV1(ready().session, "新要求");
  assert.equal(invalidated.status, "NO_INTENT");
  assert.equal(invalidated.intent, null);
  assert.deepEqual(invalidated.confirmedBindings, []);
  assert.equal(invalidated.constraintSet, null);
  assert.equal(invalidated.feasibilityReport, null);
  assert.equal(invalidated.proposalContext, null);
});
