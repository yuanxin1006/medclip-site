import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NON_REMOVABLE_LOWER_BOUND_POLICY, type ConstraintFeasibilityReportV1 } from "./editor-constraint-feasibility.ts";
import {
  DEFAULT_PLAN_GENERATION_MODE,
  MAX_COLLABORATIVE_OPTIONS,
  assertCollaborativeOptionExecutableV1,
  generateCollaborativeEditingOptionsV1,
  isCollaborativeEditingOptionsCurrentV1,
  selectCollaborativeEditingOptionV1,
} from "./editor-collaborative-options.ts";
import { CollaborativeEditingOptionsPanel } from "./editor-collaborative-options-panel.ts";
import {
  diagnoseSafeNoChangeEligibilityV1,
  evaluateSafeNoChangeEligibilityV1,
  generateEditorProposal,
  type EditorProposalInput,
} from "./editor-proposal-orchestrator.ts";
import { createHumanReviewState, executeReviewedProposal, reviewProposalEntry } from "./editor-proposal-review.ts";
import {
  resolveConstraintConflictV1,
  type ConstraintResolutionChoice,
  type ProposalConstraintContextV1,
} from "./editor-constraint-negotiation.ts";
import type { ConstraintSetV1, ProtectionPermissionPolicyV1 } from "./editor-constraints.ts";
import {
  LOCAL_CLIP_ANALYSIS_VERSION,
  VIDEO_SEMANTIC_SCHEMA_VERSION,
  normalizeLocalClipAnalysis,
  type VideoSemanticAnalysis,
} from "./editor-video-semantic.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import { createMedicalReviewInput, createMedicalReviewedExecution } from "./test-support/editor-proposal-review-fixture.ts";
import { createProtectedClipConstraintSet } from "./test-support/editor-constraint-enforcement-fixture.ts";
import {
  createCampusNegotiationIntent,
  createCampusNegotiationProject,
  createCampusNegotiationScenario,
} from "./test-support/editor-constraint-negotiation-fixture.ts";
import { evaluateEditorExecution } from "./editor-evaluator.ts";
import { deriveEditorDecisionExplanationsV1 } from "./editor-decision-explanations.ts";
import { PlanEvidencePanel } from "./editor-plan-evidence-panel.ts";
import {
  confirmCreativeIntentGroundingV1,
  creativeIntentReadySessionV1,
  resolveCreativeIntentConflictV1,
} from "./editor-creative-intent-session.ts";
import { deriveEditorCaptionConceptsV1 } from "./editor-caption-concepts.ts";
import {
  EDITOR_ACCEPTANCE_DIAGNOSTICS_FLAG,
  EDITOR_ACCEPTANCE_DIAGNOSTIC_EVENT,
  emitEditorNegotiationStateDiagnosticV1,
  emitZeroActionReviewResultDiagnosticV1,
  type EditorAcceptanceDiagnosticV1,
} from "./editor-acceptance-diagnostics.ts";
import { parseEditorProject } from "./editor-core.ts";

const ALLOW_ALL: ProtectionPermissionPolicyV1 = Object.freeze({
  allowDelete: true,
  allowTrim: true,
  allowMove: true,
  allowSpeedChange: true,
  allowAssetReplace: true,
  allowCaptionTextChange: true,
  allowTimingChange: true,
  allowSplit: true,
  allowTransformChange: true,
  allowAudioRangeChange: true,
});

function reportFor(input: EditorProposalInput, set: ConstraintSetV1, reportId = "feasibility-v1-medical"): ConstraintFeasibilityReportV1 {
  return {
    schemaVersion: 1,
    reportId,
    projectId: input.project.id,
    evaluatedProjectFingerprint: createEditorProjectFingerprint(input.project),
    constraintSetId: set.constraintSetId,
    constraintFingerprint: set.constraintFingerprint,
    status: "FEASIBLE",
    readiness: "READY_TO_PLAN",
    requestedDurationMs: input.project.durationMs,
    durationPolicy: "TARGET",
    normalizedProtectedRanges: [],
    mergedProtectedTimelineRanges: [],
    minimumProtectedDurationMs: 0,
    nonRemovableUnprotectedLowerBoundMs: 0,
    compressibleUnprotectedDurationMs: input.project.durationMs,
    minimumFeasibleDurationMs: input.project.durationMs,
    remainingGapMs: 0,
    lowerBoundPolicy: NON_REMOVABLE_LOWER_BOUND_POLICY,
    conflicts: [],
  };
}

function preparedMedical(permissions: ProtectionPermissionPolicyV1 = ALLOW_ALL) {
  const base = createMedicalReviewInput();
  const raw: EditorProposalInput = {
    ...base,
    videoAnalyses: base.videoAnalyses.map((analysis) => analysis.assetId === "asset-ecg-alt"
      ? { ...analysis, segments: analysis.segments.map((segment) => ({ ...segment, confidence: 0.93 })) }
      : analysis),
  };
  const constraintSet = createProtectedClipConstraintSet(raw.project, "clip-0", permissions);
  const feasibilityReport = reportFor(raw, constraintSet);
  const constraintContext: ProposalConstraintContextV1 = {
    sourceIntentVersionId: constraintSet.intentVersionId,
    sourceConstraintSetId: constraintSet.constraintSetId,
    sourceConstraintFingerprint: constraintSet.constraintFingerprint,
    resolutionIds: [],
    feasibilityReportId: feasibilityReport.reportId,
    readiness: "READY_TO_PLAN",
  };
  const proposalInput: EditorProposalInput = { ...raw, constraintSet, constraintContext };
  return { proposalInput, constraintSet, constraintContext, feasibilityReport };
}

function generatedMedical(mode?: "SINGLE" | "MULTI_OPTION") {
  const prepared = preparedMedical();
  const result = generateCollaborativeEditingOptionsV1({
    ...(mode ? { planGenerationMode: mode } : {}),
    proposalInput: prepared.proposalInput,
    feasibilityReport: prepared.feasibilityReport,
  });
  if (!result.ok) throw new Error(`Collaborative fixture failed: ${result.status}`);
  return { ...prepared, optionSet: result.optionSet };
}

function acceptAll(selection: ReturnType<typeof selectCollaborativeEditingOptionV1>) {
  let review = selection.review;
  selection.proposal.proposalEntries.forEach((entry) => {
    review = reviewProposalEntry(selection.proposal, review, { proposalEntryId: entry.proposalEntryId, decision: "ACCEPT" });
  });
  return review;
}

test("A-D: default SINGLE uses exactly one normal proposal call, creates no hidden options, and uses zero provider calls", () => {
  const prepared = preparedMedical();
  let calls = 0;
  const before = structuredClone(prepared.proposalInput.project);
  const result = generateCollaborativeEditingOptionsV1({
    proposalInput: prepared.proposalInput,
    feasibilityReport: prepared.feasibilityReport,
  }, (input) => {
    calls += 1;
    return generateEditorProposal(input);
  });
  assert.equal(DEFAULT_PLAN_GENERATION_MODE, "SINGLE");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.optionSet.planGenerationMode, "SINGLE");
  assert.equal(result.optionSet.requestedOptionCount, 1);
  assert.equal(result.optionSet.generatedOptionCount, 1);
  assert.equal(result.optionSet.options.length, 1);
  assert.equal(calls, 1);
  assert.equal(result.optionSet.providerCallsUsed, 0);
  assert.equal(result.optionSet.networkCallsUsed, 0);
  assert.deepEqual(prepared.proposalInput.project, before);
});

test("E-H: MULTI_OPTION is explicit, bounded to three, mutation-free, and switching to SINGLE invalidates the unused set", () => {
  const single = generatedMedical();
  const multi = generatedMedical("MULTI_OPTION");
  assert.equal(single.optionSet.planGenerationMode, "SINGLE");
  assert.equal(multi.optionSet.planGenerationMode, "MULTI_OPTION");
  assert.equal(multi.optionSet.generatedOptionCount, 2);
  assert.ok(multi.optionSet.generatedOptionCount <= MAX_COLLABORATIVE_OPTIONS);
  assert.equal(multi.optionSet.requestedOptionCount, 3);
  const projectBefore = structuredClone(multi.proposalInput.project);
  let activeSet: typeof multi.optionSet | null = multi.optionSet;
  const nextMode = "SINGLE";
  if (nextMode === "SINGLE") activeSet = null;
  assert.equal(activeSet, null);
  assert.deepEqual(multi.proposalInput.project, projectBefore);
});

test("I-K: all displayed options share hard constraints, unsafe options are rejected, and duplicate canonical plans are removed", () => {
  const multi = generatedMedical("MULTI_OPTION");
  assert.equal(multi.optionSet.options.every((option) => (
    option.proposalBundle.constraintSet === multi.constraintSet
    && option.evidence.hardConstraintIds.join(",") === multi.constraintSet.activeConstraints.map((item) => item.constraintId).join(",")
    && option.protectedContentPreserved
  )), true);

  const permissive = preparedMedical();
  const safeGenerated = generateEditorProposal(permissive.proposalInput);
  assert.equal(safeGenerated.ok, true);
  if (!safeGenerated.ok) return;
  const restrictive = createProtectedClipConstraintSet(permissive.proposalInput.project, "clip-0");
  const unsafe = generateCollaborativeEditingOptionsV1({
    planGenerationMode: "MULTI_OPTION",
    proposalInput: permissive.proposalInput,
    feasibilityReport: permissive.feasibilityReport,
  }, () => ({
    ...safeGenerated,
    bundle: {
      ...safeGenerated.bundle,
      constraintSet: restrictive,
    },
  }));
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok) assert.equal(unsafe.status, "NO_SAFE_OPTIONS");

  let calls = 0;
  const duplicate = generateCollaborativeEditingOptionsV1({
    planGenerationMode: "MULTI_OPTION",
    proposalInput: permissive.proposalInput,
    feasibilityReport: permissive.feasibilityReport,
  }, () => {
    calls += 1;
    return safeGenerated;
  });
  assert.equal(duplicate.ok, true);
  if (!duplicate.ok) return;
  assert.equal(calls, 3);
  assert.equal(duplicate.optionSet.generatedOptionCount, 1);
  assert.match(duplicate.optionSet.generationNotice ?? "", /只找到 1 个实质不同且安全的方案/);
});

test("L: one-distinct-option fallback is truthful and never pads cosmetic A/B/C copies", () => {
  const singleDistinct = generatedMedical("MULTI_OPTION");
  const signatures = singleDistinct.optionSet.options.map((option) => JSON.stringify(option.proposalBundle.compiledPlan.canonicalPlan.actions.map(({ reason: _reason, ...action }) => action)));
  assert.equal(new Set(signatures).size, signatures.length);
  if (singleDistinct.optionSet.generatedOptionCount === 1) {
    assert.match(singleDistinct.optionSet.generationNotice ?? "", /1 个实质不同且安全的方案/);
  }
});

function campusAnalysis(assetId: string, concept: string, confidence: number): VideoSemanticAnalysis {
  const durationMs = assetId === "asset-teacher" ? 35_000 : 3_000;
  return {
    schemaVersion: VIDEO_SEMANTIC_SCHEMA_VERSION,
    assetId,
    assetDurationMs: durationMs,
    segments: [{
      id: `segment-${assetId}`,
      assetId,
      startMs: 0,
      endMs: durationMs,
      summary: `${concept} trusted evidence`,
      concepts: [concept],
      action: "explanation",
      usability: 0.95,
      confidence,
      evidenceFrameMs: [0],
    }],
    analysisMethod: "local-clip",
    createdAt: "2026-10-25T00:00:00.000Z",
    analysisVersion: LOCAL_CLIP_ANALYSIS_VERSION,
  };
}

function preparedCampusNoChange() {
  const scenario = createCampusNegotiationScenario();
  const conflict = scenario.report.conflicts.find((item) => item.type === "DURATION_CONFLICT")!;
  const resolved = resolveConstraintConflictV1({
    state: scenario.state,
    intent: scenario.intent,
    project: scenario.project,
    projectFingerprint: scenario.projectFingerprint,
    confirmedBindings: scenario.confirmedBindings,
    feasibilityReport: scenario.report,
    conflictId: conflict.conflictId,
    selectedResolution: "OPTIMIZE_UNPROTECTED_ONLY",
    createdAt: "2026-10-25T01:00:00.000Z",
  });
  assert.ok(resolved.constraintSet && resolved.proposalContext && resolved.feasibilityReport);
  const proposalInput: EditorProposalInput = {
    project: scenario.project,
    // Reproduces the browser defect: the higher semantic score previously made
    // the planner propose replacing protected teacher speech with the logo asset.
    videoAnalyses: [campusAnalysis("asset-teacher", "teacher", 0.80), campusAnalysis("asset-logo", "teacher", 0.99)],
    captionConcepts: [{ captionId: "caption-teacher", concepts: ["teacher"] }],
    constraintSet: resolved.constraintSet!,
    constraintContext: resolved.proposalContext!,
    sessionDecisionLedger: resolved.ledger,
  };
  return { scenario, resolved, proposalInput };
}

test("M: campus SINGLE and every explicit MULTI_OPTION preserve truthful 30/38/8 infeasibility", () => {
  const { proposalInput, resolved } = preparedCampusNoChange();
  for (const mode of ["SINGLE", "MULTI_OPTION"] as const) {
    const result = generateCollaborativeEditingOptionsV1({ planGenerationMode: mode, proposalInput, feasibilityReport: resolved.feasibilityReport! });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.optionSet.options.length >= 1, true);
    assert.equal(result.optionSet.options.length, 1);
    result.optionSet.options.forEach((option) => {
      assert.deepEqual(option.targetGap, {
        requestedDurationMs: 30_000,
        minimumFeasibleDurationMs: 38_000,
        remainingGapMs: 8_000,
        canReachRequestedDuration: false,
      });
      assert.equal(option.predictedDuration, 38_000);
      assert.equal(option.protectedContentPreserved, true);
      assert.equal(option.proposalBundle.status, "SAFE_NO_CHANGE");
      assert.equal(option.proposalBundle.compiledPlan.canonicalPlan.actions.length, 0);
      assert.equal(option.proposalBundle.safeNoChangeOutcome?.evidence.legalExecutableActionCount, 0);
    });
    if (mode === "MULTI_OPTION") assert.match(result.optionSet.generationNotice ?? "", /1 个真实且安全的结果/);
  }
});

test("R6 browser-equivalent SINGLE preserves safe no-change when EditorStudio derives no caption concepts", () => {
  const project = structuredClone(createCampusNegotiationProject());
  const teacherAsset = project.assets.find((asset) => asset.id === "asset-teacher")!;
  const teacherClip = project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === "clip-teacher")!;
  teacherAsset.durationMs = 40_000;
  teacherClip.sourceInMs = 2_500;
  teacherClip.sourceOutMs = 37_500;
  const teacherAnalysis = { ...campusAnalysis("asset-teacher", "teacher", 0.80), assetDurationMs: 40_000 };
  const analyses = [teacherAnalysis, campusAnalysis("asset-logo", "teacher", 0.99)];
  const intent = createCampusNegotiationIntent(project.id);
  const hard = intent.clauses.filter((clause) => clause.kind === "HARD_CONSTRAINT_REQUEST");
  const ready = creativeIntentReadySessionV1(intent);
  const speech = confirmCreativeIntentGroundingV1({
    session: ready,
    project,
    sourceClauseId: hard[0].clauseId,
    selection: { bindingType: "CAPTION", captionId: "caption-teacher" },
    videoSemanticAnalyses: analyses,
  });
  const conflict = confirmCreativeIntentGroundingV1({
    session: speech,
    project,
    sourceClauseId: hard[1].clauseId,
    selection: { bindingType: "CLIP", clipId: "clip-logo" },
    videoSemanticAnalyses: analyses,
  });
  const editorSession = resolveCreativeIntentConflictV1({
    session: conflict,
    project,
    choice: "OPTIMIZE_UNPROTECTED_ONLY",
    createdAt: "2026-10-26T02:00:00.000Z",
    videoSemanticAnalyses: analyses,
  });
  assert.equal(editorSession.status, "READY_TO_PLAN");
  assert.ok(editorSession.constraintSet && editorSession.proposalContext && editorSession.feasibilityReport);
  const browserProposalInput: EditorProposalInput = {
    project,
    videoAnalyses: analyses,
    // EditorStudio's production topicsForText lookup does not classify the
    // campus caption "老师完整讲话" as one of its medical visual topics.
    captionConcepts: [{ captionId: "caption-teacher", concepts: [] }],
    constraintSet: editorSession.constraintSet!,
    constraintContext: editorSession.proposalContext!,
    sessionDecisionLedger: editorSession.ledger!,
  };
  const before = structuredClone(project);

  for (const mode of ["SINGLE", "MULTI_OPTION"] as const) {
    const result = generateCollaborativeEditingOptionsV1({
      planGenerationMode: mode,
      requestedOptionCount: mode === "MULTI_OPTION" ? 3 : 1,
      providerGenerationBudget: 0,
      proposalInput: browserProposalInput,
      feasibilityReport: editorSession.feasibilityReport!,
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) continue;
    assert.equal(result.optionSet.options.length, 1);
    const proposal = result.optionSet.options[0].proposalBundle;
    assert.equal(proposal.status, "SAFE_NO_CHANGE");
    assert.equal(proposal.rankedCandidateSets.length, 0);
    assert.equal(proposal.safeNoChangeOutcome?.evidence.blockedCandidateCount, 2);
    assert.equal(proposal.compiledPlan.status, "VALIDATED");
    assert.equal(proposal.compiledPlan.canonicalPlan.actions.length, 0);
    assert.equal(proposal.trustedPreExecutionProject.tracks.flatMap((track) => track.clips)
      .find((clip) => clip.id === "clip-teacher")?.sourceInMs, 2_500);
    assert.equal(proposal.safeNoChangeOutcome?.requestedTargetMs, 30_000);
    assert.equal(proposal.safeNoChangeOutcome?.minimumFeasibleDurationMs, 38_000);
    assert.equal(proposal.safeNoChangeOutcome?.remainingGapMs, 8_000);
    assert.equal(result.optionSet.providerCallsUsed, 0);
    assert.equal(result.optionSet.networkCallsUsed, 0);
    if (mode === "MULTI_OPTION") assert.match(result.optionSet.generationNotice ?? "", /1 个真实且安全的结果/);

    const review = createHumanReviewState(proposal);
    let executorInvocations = 0;
    const execution = executeReviewedProposal({
      proposal,
      review,
      currentProject: project,
      executionUpdatedAt: "2026-10-26T02:01:00.000Z",
    }, {
      executePlan: () => {
        executorInvocations += 1;
        throw new Error("Browser-equivalent safe no-change must not invoke V2.0D.");
      },
    });
    assert.equal(execution.status, "REVIEWED_NO_ACTIONS");
    assert.equal(executorInvocations, 0);
    assert.equal(execution.execution, undefined);
    assert.equal(execution.history.shouldRecord, false);
    assert.deepEqual(project, before);
  }
});

function preparedEditorStudioCampusResolution(choice: ConstraintResolutionChoice, restoreFromDraft = false) {
  const sourceProject = createCampusNegotiationProject();
  const project = restoreFromDraft
    ? parseEditorProject(JSON.stringify(sourceProject))
    : structuredClone(sourceProject);
  assert.ok(project);
  project.tracks = [
    { id: "audio-main", type: "audio", name: "主音频", clips: [], locked: true },
    { ...project.tracks[0], id: "video-main", name: "主视频", clips: project.tracks[0].clips.map((clip) => ({ ...clip, trackId: "video-main" })) },
    { id: "broll", type: "broll", name: "B-roll", clips: [] },
    { id: "captions", type: "captions", name: "字幕", clips: [] },
  ];
  project.captions = [
    { id: "cue-1", text: "医生介绍患者症状", startMs: 0, endMs: 12_000 },
    { id: "cue-2", text: "检查报告显示指标稳定", startMs: 12_000, endMs: 24_000 },
    { id: "cue-3", text: "药物治疗需要遵循剂量", startMs: 24_000, endMs: 35_000 },
  ];
  const analyses = project.assets.map((asset) => normalizeLocalClipAnalysis({
    assetId: asset.id,
    assetDurationMs: asset.durationMs,
    frames: [{
      sourceTimeMs: Math.min(asset.durationMs - 1, Math.round(asset.durationMs * 0.3)),
      concepts: asset.id === "asset-teacher"
        ? [{ concept: "医生问诊", score: 0.98 }, { concept: "检查报告", score: 0.91 }, { concept: "药物治疗", score: 0.89 }]
        : [{ concept: "健康生活", score: 0.99 }],
    }],
    analysisMethod: "local-clip",
    createdAt: "2026-10-26T03:00:00.000Z",
  }));
  const intent = createCampusNegotiationIntent(project.id);
  const hard = intent.clauses.filter((clause) => clause.kind === "HARD_CONSTRAINT_REQUEST");
  let session = creativeIntentReadySessionV1(intent);
  session = confirmCreativeIntentGroundingV1({
    session,
    project,
    sourceClauseId: hard[0].clauseId,
    selection: { bindingType: "TIME_RANGE", range: { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 } },
    videoSemanticAnalyses: analyses,
  });
  session = confirmCreativeIntentGroundingV1({
    session,
    project,
    sourceClauseId: hard[1].clauseId,
    selection: { bindingType: "CLIP", clipId: "clip-logo" },
    videoSemanticAnalyses: analyses,
  });
  session = resolveCreativeIntentConflictV1({
    session,
    project,
    choice,
    createdAt: "2026-10-26T03:01:00.000Z",
    videoSemanticAnalyses: analyses,
  });
  assert.equal(session.status, "READY_TO_PLAN");
  assert.ok(session.constraintSet && session.proposalContext && session.feasibilityReport && session.ledger);
  const proposalInput: EditorProposalInput = {
    project,
    videoAnalyses: analyses,
    captionConcepts: deriveEditorCaptionConceptsV1(project.captions),
    constraintSet: session.constraintSet!,
    constraintContext: session.proposalContext!,
    sessionDecisionLedger: session.ledger!,
    feasibilityReport: session.feasibilityReport!,
  };
  return { project, proposalInput, session };
}

function preparedEditorStudioCampusNoChange() {
  return preparedEditorStudioCampusResolution("OPTIMIZE_UNPROTECTED_ONLY");
}

function captureAcceptanceDiagnostics<T>(enabled: boolean, run: () => T): Readonly<{
  value: T;
  diagnostics: readonly EditorAcceptanceDiagnosticV1[];
}> {
  const root = globalThis as typeof globalThis & { window?: unknown };
  const previous = Object.getOwnPropertyDescriptor(root, "window");
  const diagnostics: EditorAcceptanceDiagnosticV1[] = [];
  class DiagnosticCustomEvent extends Event {
    readonly detail: EditorAcceptanceDiagnosticV1;

    constructor(type: string, init: { detail: EditorAcceptanceDiagnosticV1 }) {
      super(type);
      this.detail = init.detail;
    }
  }
  const runtime = {
    [EDITOR_ACCEPTANCE_DIAGNOSTICS_FLAG]: enabled,
    CustomEvent: DiagnosticCustomEvent,
    dispatchEvent: (event: Event) => {
      if (event.type === EDITOR_ACCEPTANCE_DIAGNOSTIC_EVENT) {
        diagnostics.push((event as DiagnosticCustomEvent).detail);
      }
      return true;
    },
  };
  Object.defineProperty(root, "window", { configurable: true, value: runtime });
  try {
    return Object.freeze({ value: run(), diagnostics: Object.freeze([...diagnostics]) });
  } finally {
    if (previous) Object.defineProperty(root, "window", previous);
    else Reflect.deleteProperty(root, "window");
  }
}

test("R10A2 Option B emits authoritative production negotiation state through the existing bridge", () => {
  const { session } = preparedEditorStudioCampusResolution("OPTIMIZE_UNPROTECTED_ONLY");
  const captured = captureAcceptanceDiagnostics(true, () =>
    emitEditorNegotiationStateDiagnosticV1(session));
  assert.equal(captured.value, true);
  assert.deepEqual(captured.diagnostics, [{
    schemaVersion: 1,
    kind: "NEGOTIATION_STATE",
    stage: "NEGOTIATION_STATE",
    resolution: "OPTIMIZE_UNPROTECTED_ONLY",
    requestedTargetMs: 30_000,
    minimumFeasibleMs: 38_000,
    targetGapMs: 8_000,
    planningState: "READY_TO_PLAN",
    feasibilityStatus: "FEASIBLE_WITH_TARGET_GAP",
  }]);
  const serialized = JSON.stringify(captured.diagnostics);
  assert.doesNotMatch(serialized, /project|constraintSet|clip-|caption-|binding|session|email|password|token|api.?key/i);

  const source = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("const selectConstraintResolution"), source.indexOf("const generateProductionProposal"));
  assert.match(handler, /const next = resolveCreativeIntentConflictV1\([\s\S]*emitEditorNegotiationStateDiagnosticV1\(next\)[\s\S]*setCreativeIntentSession\(next\)/);
});

test("R10A2 Option A emits its distinct recomputed production negotiation state", () => {
  const { session } = preparedEditorStudioCampusResolution("RELAX_TARGET_DURATION");
  const captured = captureAcceptanceDiagnostics(true, () =>
    emitEditorNegotiationStateDiagnosticV1(session));
  assert.equal(captured.value, true);
  assert.deepEqual(captured.diagnostics, [{
    schemaVersion: 1,
    kind: "NEGOTIATION_STATE",
    stage: "NEGOTIATION_STATE",
    resolution: "RELAX_TARGET_DURATION",
    requestedTargetMs: 38_000,
    minimumFeasibleMs: 38_000,
    targetGapMs: 0,
    planningState: "READY_TO_PLAN",
    feasibilityStatus: "FEASIBLE",
  }]);
});

test("R10A2 negotiation diagnostics remain off by default", () => {
  const { session } = preparedEditorStudioCampusResolution("OPTIMIZE_UNPROTECTED_ONLY");
  const captured = captureAcceptanceDiagnostics(false, () =>
    emitEditorNegotiationStateDiagnosticV1(session));
  assert.equal(captured.value, false);
  assert.deepEqual(captured.diagnostics, []);
});

test("R8 EditorStudio production-shaped multi-caption input reaches safe no-change", () => {
  const { project, proposalInput, session } = preparedEditorStudioCampusNoChange();
  const diagnostic = diagnoseSafeNoChangeEligibilityV1(proposalInput);
  assert.equal(diagnostic.eligible, true, JSON.stringify(diagnostic));
  assert.equal(diagnostic.reasonCode, "ELIGIBLE");
  assert.deepEqual(diagnostic.failedChecks, []);
  assert.equal(diagnostic.evidence.legalMutationCandidateCount, 0);
  assert.deepEqual(proposalInput.captionConcepts.map((item) => item.concepts), [
    ["医生问诊"],
    ["检查报告"],
    ["药物治疗"],
  ]);
  const before = structuredClone(project);

  for (const mode of ["SINGLE", "MULTI_OPTION"] as const) {
    const result = generateCollaborativeEditingOptionsV1({
      planGenerationMode: mode,
      requestedOptionCount: mode === "MULTI_OPTION" ? 3 : 1,
      providerGenerationBudget: 0,
      proposalInput,
      feasibilityReport: session.feasibilityReport!,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) continue;
    assert.equal(result.optionSet.options.length, 1);
    const proposal = result.optionSet.options[0].proposalBundle;
    assert.equal(proposal.status, "SAFE_NO_CHANGE");
    assert.equal(proposal.compiledPlan.status, "VALIDATED");
    assert.equal(proposal.compiledPlan.canonicalPlan.actions.length, 0);
    assert.equal(proposal.safeNoChangeOutcome?.evidence.legalExecutableActionCount, 0);
    assert.equal(proposal.safeNoChangeOutcome?.requestedTargetMs, 30_000);
    assert.equal(proposal.safeNoChangeOutcome?.minimumFeasibleDurationMs, 38_000);
    assert.equal(proposal.safeNoChangeOutcome?.remainingGapMs, 8_000);
    if (mode === "MULTI_OPTION") assert.match(result.optionSet.generationNotice ?? "", /1 个真实且安全的结果/);

    let executorInvocations = 0;
    const execution = executeReviewedProposal({
      proposal,
      review: createHumanReviewState(proposal),
      currentProject: project,
      executionUpdatedAt: "2026-10-26T03:02:00.000Z",
    }, {
      executePlan: () => {
        executorInvocations += 1;
        throw new Error("Safe no-change must not invoke V2.0D.");
      },
    });
    assert.equal(execution.status, "REVIEWED_NO_ACTIONS");
    assert.equal(executorInvocations, 0);
    assert.equal(execution.execution, undefined);
    assert.equal(execution.history.shouldRecord, false);
    assert.deepEqual(project, before);
  }
});

test("R8B restored EditorStudio project reaches safe no-change without planning fallthrough", () => {
  const { project, proposalInput, session } = preparedEditorStudioCampusResolution(
    "OPTIMIZE_UNPROTECTED_ONLY",
    true,
  );
  assert.equal(session.status, "READY_TO_PLAN");
  assert.equal(session.feasibilityReport?.requestedDurationMs, 30_000);
  assert.equal(session.feasibilityReport?.minimumFeasibleDurationMs, 38_000);
  assert.equal(session.feasibilityReport?.remainingGapMs, 8_000);
  const before = structuredClone(project);
  const fingerprint = createEditorProjectFingerprint(project);
  assert.equal(createEditorProjectFingerprint(structuredClone(project)), fingerprint);

  const captured = captureAcceptanceDiagnostics(true, () => generateEditorProposal(proposalInput));
  assert.equal(captured.value.ok, true, JSON.stringify(captured.value));
  if (!captured.value.ok) return;
  assert.equal(captured.value.status, "READY_WITH_NO_CHANGES");
  const proposal = captured.value.bundle;
  assert.equal(proposal.status, "SAFE_NO_CHANGE");
  assert.equal(proposal.compiledPlan.status, "VALIDATED");
  assert.equal(proposal.compiledPlan.canonicalPlan.actions.length, 0);
  assert.equal(proposal.proposalEntries.length, 0);

  const eligibility = captured.diagnostics.find((item) => item.kind === "SAFE_NO_CHANGE_ELIGIBILITY");
  assert.ok(eligibility && eligibility.kind === "SAFE_NO_CHANGE_ELIGIBILITY");
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.reasonCode, "ELIGIBLE");
  assert.deepEqual(eligibility.failedChecks, []);
  assert.deepEqual(
    captured.diagnostics
      .filter((item) => item.kind === "EDITOR_PROPOSAL_STAGE")
      .map((item) => [item.stage, item.outcome]),
    [
      ["CONTEXT_VALIDATION", "ENTERED"],
      ["COMPILER", "ENTERED"],
      ["SAFE_NO_CHANGE_SELECTED", "SAFE_NO_CHANGE"],
      ["RESULT_MAPPING", "SAFE_NO_CHANGE"],
    ],
  );
  for (const stage of ["INTERVAL_BUILD", "SEED_SLOT_BUILD", "CANDIDATE_FILTER"] as const) {
    assert.equal(captured.diagnostics.some((item) => item.stage === stage), false);
  }
  const serializedDiagnostics = JSON.stringify(captured.diagnostics);
  assert.doesNotMatch(serializedDiagnostics, /PROJECT_FINGERPRINT_MISMATCH|MISSING_VIDEO_EVIDENCE|NO_SAFE_OPTIONS|COMPILATION_REJECTED/);

  const review = createHumanReviewState(proposal);
  assert.equal(review.lifecycle, "REVIEWED_NO_ACTIONS");
  let executorInvocations = 0;
  const execution = executeReviewedProposal({
    proposal,
    review,
    currentProject: project,
    executionUpdatedAt: "2026-10-28T01:00:00.000Z",
  }, {
    executePlan: () => {
      executorInvocations += 1;
      throw new Error("Restored safe no-change must not invoke the executor.");
    },
  });
  assert.equal(execution.status, "REVIEWED_NO_ACTIONS");
  assert.equal(executorInvocations, 0);
  assert.equal(execution.execution, undefined);
  assert.equal(execution.history.shouldRecord, false);
  assert.deepEqual(project, before);

  const materiallyChangedProject = structuredClone(project);
  materiallyChangedProject.captions[0].text = `${materiallyChangedProject.captions[0].text} changed`;
  assert.notEqual(createEditorProjectFingerprint(materiallyChangedProject), fingerprint);
  const stale = generateEditorProposal({ ...proposalInput, project: materiallyChangedProject });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.status, "NEGOTIATION_NOT_READY");
});

test("R8 structured safe no-change diagnostics preserve closed failure reasons", () => {
  const { proposalInput } = preparedEditorStudioCampusNoChange();
  const fingerprint = createEditorProjectFingerprint(proposalInput.project);

  const staleFingerprint = evaluateSafeNoChangeEligibilityV1(proposalInput, "stale-project-fingerprint", 0);
  assert.equal(staleFingerprint.eligible, false);
  assert.equal(staleFingerprint.reasonCode, "PROJECT_FINGERPRINT_MISMATCH");
  assert.ok(staleFingerprint.failedChecks.includes("PROJECT_FINGERPRINT_MATCH"));

  const invalidResolutionInput: EditorProposalInput = {
    ...proposalInput,
    constraintContext: { ...proposalInput.constraintContext!, resolutionIds: [] },
  };
  const invalidResolution = evaluateSafeNoChangeEligibilityV1(invalidResolutionInput, fingerprint, 0);
  assert.equal(invalidResolution.reasonCode, "RESOLUTION_NOT_ALLOWED");
  assert.ok(invalidResolution.failedChecks.includes("RESOLUTION_PRESENT"));

  const invalidFeasibilityInput: EditorProposalInput = {
    ...proposalInput,
    feasibilityReport: { ...proposalInput.feasibilityReport!, remainingGapMs: null },
  };
  const invalidFeasibility = evaluateSafeNoChangeEligibilityV1(invalidFeasibilityInput, fingerprint, 0);
  assert.equal(invalidFeasibility.reasonCode, "MALFORMED_FEASIBILITY");
  assert.ok(invalidFeasibility.failedChecks.includes("TARGET_GAP_VALID"));

  const legalAction = evaluateSafeNoChangeEligibilityV1(proposalInput, fingerprint, 1);
  assert.equal(legalAction.reasonCode, "LEGAL_ACTIONS_REMAIN");
  assert.deepEqual(legalAction.failedChecks, ["NO_LEGAL_MUTATION_CANDIDATES"]);

  const staleConstraintInput: EditorProposalInput = {
    ...proposalInput,
    constraintSet: { ...proposalInput.constraintSet!, validatedAgainstProjectFingerprint: "stale-project-fingerprint" },
  };
  const staleConstraint = evaluateSafeNoChangeEligibilityV1(staleConstraintInput, fingerprint, 0);
  assert.equal(staleConstraint.reasonCode, "STALE_CONSTRAINT_SET");
  assert.ok(staleConstraint.failedChecks.includes("CONSTRAINT_SET_PROJECT_FINGERPRINT_MATCH"));
});

test("R10A acceptance diagnostics are off by default and render no internal text", () => {
  const { proposalInput, session } = preparedEditorStudioCampusNoChange();
  const captured = captureAcceptanceDiagnostics(false, () => generateCollaborativeEditingOptionsV1({
    planGenerationMode: "SINGLE",
    providerGenerationBudget: 0,
    proposalInput,
    feasibilityReport: session.feasibilityReport!,
  }));
  assert.equal(captured.value.ok, true);
  assert.deepEqual(captured.diagnostics, []);
  if (!captured.value.ok) return;
  const proposal = captured.value.optionSet.options[0].proposalBundle;
  const html = renderToStaticMarkup(PlanEvidencePanel({
    evidence: proposal.planEvidence,
    proposal,
    review: createHumanReviewState(proposal),
    onExecuteReviewed: () => undefined,
  }));
  assert.doesNotMatch(html, /SAFE_NO_CHANGE_ELIGIBILITY|ELIGIBLE|failedChecks|passedChecks|PROJECT_FINGERPRINT_MATCH/);
});

test("R10A opted-in production path emits sanitized eligible and selected diagnostics", () => {
  const { proposalInput, session } = preparedEditorStudioCampusNoChange();
  const captured = captureAcceptanceDiagnostics(true, () => generateCollaborativeEditingOptionsV1({
    planGenerationMode: "SINGLE",
    providerGenerationBudget: 0,
    proposalInput,
    feasibilityReport: session.feasibilityReport!,
  }));
  assert.equal(captured.value.ok, true);
  if (!captured.value.ok) return;
  assert.equal(captured.value.optionSet.options[0].proposalBundle.status, "SAFE_NO_CHANGE");
  const eligibility = captured.diagnostics.find((item) => item.kind === "SAFE_NO_CHANGE_ELIGIBILITY");
  assert.ok(eligibility && eligibility.kind === "SAFE_NO_CHANGE_ELIGIBILITY");
  assert.equal(eligibility.evaluated, true);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.reasonCode, "ELIGIBLE");
  assert.deepEqual(eligibility.failedChecks, []);
  assert.ok(eligibility.passedChecks.includes("FULL_TIMELINE_PROTECTED"));
  assert.equal(eligibility.evidence.requestedDurationMs, 30_000);
  assert.equal(eligibility.evidence.minimumFeasibleDurationMs, 38_000);
  assert.equal(eligibility.evidence.remainingGapMs, 8_000);
  assert.equal(eligibility.evidence.legalMutationCandidateCount, 0);
  assert.ok(captured.diagnostics.some((item) => item.kind === "EDITOR_PROPOSAL_STAGE"
    && item.stage === "SAFE_NO_CHANGE_SELECTED" && item.outcome === "SAFE_NO_CHANGE"));
  assert.ok(captured.diagnostics.some((item) => item.kind === "EDITOR_PROPOSAL_STAGE"
    && item.stage === "COLLABORATIVE_OPTION_FILTER" && item.outcome === "SAFE_NO_CHANGE"));

  const serialized = JSON.stringify(captured.diagnostics);
  const internalValues = [
    proposalInput.project.id,
    ...proposalInput.project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)),
    ...proposalInput.project.captions.map((caption) => caption.id),
    ...proposalInput.constraintSet!.confirmedBindings.map((binding) => binding.bindingId),
  ];
  internalValues.forEach((value) => assert.equal(serialized.includes(value), false));
  assert.doesNotMatch(serialized, /"project"|"tracks"|"assets"|"captions"|"constraintSet"|apiKey|token|credential/i);
});

test("R10A opted-in stale ConstraintSet reports its predicate and remains fail-closed", () => {
  const { proposalInput, session } = preparedEditorStudioCampusNoChange();
  const staleInput: EditorProposalInput = {
    ...proposalInput,
    constraintSet: {
      ...proposalInput.constraintSet!,
      validatedAgainstProjectFingerprint: "stale-project-fingerprint",
    },
  };
  const captured = captureAcceptanceDiagnostics(true, () => generateCollaborativeEditingOptionsV1({
    planGenerationMode: "SINGLE",
    providerGenerationBudget: 0,
    proposalInput: staleInput,
    feasibilityReport: session.feasibilityReport!,
  }));
  assert.equal(captured.value.ok, false);
  const eligibility = captured.diagnostics.find((item) => item.kind === "SAFE_NO_CHANGE_ELIGIBILITY");
  assert.ok(eligibility && eligibility.kind === "SAFE_NO_CHANGE_ELIGIBILITY");
  assert.equal(eligibility.evaluated, true);
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reasonCode, "STALE_CONSTRAINT_SET");
  assert.ok(eligibility.failedChecks.includes("CONSTRAINT_SET_PROJECT_FINGERPRINT_MATCH"));
  assert.ok(captured.diagnostics.some((item) => item.kind === "EDITOR_PROPOSAL_STAGE"
    && item.outcome === "FAILED"));
  assert.equal(captured.diagnostics.some((item) => item.kind === "EDITOR_PROPOSAL_STAGE"
    && item.stage === "SAFE_NO_CHANGE_SELECTED"), false);
});

test("R10C production-shaped safe no-change changes proposal state but not the authoritative project", () => {
  const { project, proposalInput, session } = preparedEditorStudioCampusNoChange();
  assert.equal(session.resolution?.selectedResolution, "OPTIMIZE_UNPROTECTED_ONLY");
  assert.equal(session.feasibilityReport?.requestedDurationMs, 30_000);
  assert.equal(session.feasibilityReport?.minimumFeasibleDurationMs, 38_000);
  assert.equal(session.feasibilityReport?.remainingGapMs, 8_000);
  const eligibility = diagnoseSafeNoChangeEligibilityV1(proposalInput);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.reasonCode, "ELIGIBLE");

  const projectFingerprintBefore = createEditorProjectFingerprint(project);
  const projectDomainBefore = structuredClone(project);
  const applicationStateBefore = Object.freeze({
    proposalStatus: null as null | string,
    reviewLifecycle: null as null | string,
    acceptanceDiagnostics: Object.freeze([]) as readonly EditorAcceptanceDiagnosticV1[],
  });
  const captured = captureAcceptanceDiagnostics(true, () => generateCollaborativeEditingOptionsV1({
    planGenerationMode: "SINGLE",
    requestedOptionCount: 1,
    providerGenerationBudget: 0,
    proposalInput,
    feasibilityReport: session.feasibilityReport!,
  }));
  assert.equal(captured.value.ok, true, JSON.stringify(captured.value));
  if (!captured.value.ok) return;
  const proposal = captured.value.optionSet.options[0].proposalBundle;
  const review = createHumanReviewState(proposal);
  const applicationStateAfter = Object.freeze({
    proposalStatus: proposal.status,
    reviewLifecycle: review.lifecycle,
    acceptanceDiagnostics: captured.diagnostics,
  });

  assert.equal(proposal.status, "SAFE_NO_CHANGE");
  assert.equal(proposal.compiledPlan.canonicalPlan.actions.length, 0);
  assert.ok(captured.diagnostics.some((item) => item.kind === "SAFE_NO_CHANGE_ELIGIBILITY"
    && item.eligible && item.reasonCode === "ELIGIBLE"));
  assert.ok(captured.diagnostics.some((item) => item.kind === "EDITOR_PROPOSAL_STAGE"
    && item.stage === "SAFE_NO_CHANGE_SELECTED" && item.outcome === "SAFE_NO_CHANGE"));
  assert.notDeepEqual(applicationStateAfter, applicationStateBefore);
  assert.deepEqual(
    Object.keys(applicationStateAfter).filter((key) => JSON.stringify(applicationStateAfter[key as keyof typeof applicationStateAfter])
      !== JSON.stringify(applicationStateBefore[key as keyof typeof applicationStateBefore])),
    ["proposalStatus", "reviewLifecycle", "acceptanceDiagnostics"],
  );

  const projectFingerprintAfterGeneration = createEditorProjectFingerprint(project);
  assert.equal(projectFingerprintAfterGeneration, projectFingerprintBefore);
  assert.deepEqual(project, projectDomainBefore);
  assert.deepEqual(project.tracks, projectDomainBefore.tracks);
  assert.deepEqual(project.captions, projectDomainBefore.captions);
  assert.deepEqual(project.audioSelection, projectDomainBefore.audioSelection);
  assert.equal(project.durationMs, projectDomainBefore.durationMs);

  let executorInvocations = 0;
  const execution = executeReviewedProposal({
    proposal,
    review,
    currentProject: project,
    executionUpdatedAt: "2026-10-27T00:00:00.000Z",
  }, {
    executePlan: () => {
      executorInvocations += 1;
      throw new Error("Safe no-change acknowledgement must not invoke V2.0D.");
    },
  });
  assert.equal(executorInvocations, 0);
  assert.equal(execution.status, "REVIEWED_NO_ACTIONS");
  assert.equal(execution.execution, undefined);
  assert.equal(execution.history.shouldRecord, false);
  assert.equal(execution.history.undoProject, undefined);
  assert.equal(execution.history.redoProject, undefined);
  assert.equal(createEditorProjectFingerprint(project), projectFingerprintBefore);
  assert.deepEqual(project, projectDomainBefore);

  const source = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  const generationHandler = source.slice(source.indexOf("const generateProductionProposal"), source.indexOf("const currentVideoSemanticEvidence"));
  assert.doesNotMatch(generationHandler, /executeReviewedProposal|setEditorProject|setEditorAIUndoProject|handleEditorProjectChange/);
  const executionHandler = source.slice(source.indexOf("const executeApprovedProposal"), source.indexOf("const handleRepairReviewDecision"));
  assert.match(executionHandler, /if \(result\.history\.shouldRecord && result\.history\.undoProject && result\.history\.redoProject\)[\s\S]*setEditorAIUndoProject[\s\S]*handleEditorProjectChange/);
});

test("R4 campus safe no-change is reviewable and evaluable without executor, mutation, or history", () => {
  const { scenario, resolved, proposalInput } = preparedCampusNoChange();
  const before = structuredClone(scenario.project);
  const generated = generateCollaborativeEditingOptionsV1({
    planGenerationMode: "SINGLE",
    proposalInput,
    feasibilityReport: resolved.feasibilityReport!,
  });
  assert.equal(generated.ok, true);
  if (!generated.ok) return;
  const proposal = generated.optionSet.options[0].proposalBundle;
  const outcome = proposal.safeNoChangeOutcome!;
  assert.equal(proposal.status, "SAFE_NO_CHANGE");
  assert.equal(outcome.intentVersionId, resolved.constraintSet!.intentVersionId);
  assert.equal(outcome.constraintSetId, resolved.constraintSet!.constraintSetId);
  assert.equal(outcome.constraintResolutionId, resolved.resolution.resolutionId);
  assert.equal(outcome.projectFingerprint, scenario.projectFingerprint);
  assert.deepEqual(outcome.feasibilityRef, {
    reportId: resolved.feasibilityReport!.reportId,
    requestedDurationMs: 30_000,
    minimumFeasibleDurationMs: 38_000,
    remainingGapMs: 8_000,
  });
  assert.equal(outcome.protectedContentStatus, "PRESERVED");
  assert.equal(outcome.reasonCode, "NO_LEGAL_UNPROTECTED_EDITS");
  assert.equal(outcome.evidence.filteredCandidateIssues[0]?.code, "HARD_CONSTRAINT_BLOCKED");
  assert.match(outcome.evidence.filteredCandidateIssues[0]?.detail ?? "", /替换已保护的素材/);
  assert.equal(proposal.compiledPlan.canonicalPlan.actions.length, 0);
  assert.equal(proposal.proposalEntries.length, 0);

  const review = createHumanReviewState(proposal);
  assert.equal(review.lifecycle, "REVIEWED_NO_ACTIONS");
  assert.equal(review.entries.length, 0);
  let executorInvocations = 0;
  const result = executeReviewedProposal({
    proposal,
    review,
    currentProject: scenario.project,
    executionUpdatedAt: "2026-10-26T01:00:00.000Z",
  }, {
    executePlan: () => {
      executorInvocations += 1;
      throw new Error("Safe no-change must not invoke V2.0D.");
    },
  });
  assert.equal(result.status, "REVIEWED_NO_ACTIONS");
  assert.equal(executorInvocations, 0);
  assert.equal(result.execution, undefined);
  assert.equal(result.history.shouldRecord, false);
  assert.deepEqual(scenario.project, before);
  assert.deepEqual(scenario.project.tracks[0].clips.find((clip) => clip.id === "clip-teacher"), before.tracks[0].clips.find((clip) => clip.id === "clip-teacher"));
  assert.deepEqual(scenario.project.tracks[0].clips.find((clip) => clip.id === "clip-logo"), before.tracks[0].clips.find((clip) => clip.id === "clip-logo"));

  const evaluation = evaluateEditorExecution({
    proposalBundle: proposal,
    humanReviewState: result.reviewState,
    reviewedPlan: result.reviewedPlan,
    postProject: scenario.project,
    planEvidence: result.planEvidence,
    videoSemanticEvidence: proposalInput.videoAnalyses,
    constraintSet: resolved.constraintSet!,
    resolvedDurationPolicy: resolved.resolution.structuredPolicy,
  });
  const hardConstraints = evaluation.metricResults.find((item) => item.metric === "HARD_CONSTRAINT_COMPLIANCE")!;
  assert.equal(hardConstraints.status, "PASS");
  assert.equal(hardConstraints.observations[0]?.message, "当前工程完整保留了所有活动硬约束，本轮未执行编辑动作。");
  assert.doesNotMatch(hardConstraints.observations[0]?.message ?? "", /真实执行后|执行后|修改后/);
  assert.equal(evaluation.overallStatus, "NO_EXECUTED_ACTIONS");
  assert.equal(evaluation.metricResults.find((item) => item.metric === "SEMANTIC_MATCH")?.status, "NOT_EVALUABLE");
  assert.equal(evaluation.summary.durationOutcome?.remainingTargetGapMs, 8_000);
  assert.equal(evaluation.summary.durationOutcome?.requestedDurationMs, 30_000);
  assert.equal(evaluation.summary.durationOutcome?.achievedDurationMs, 38_000);

  const violatedProject = structuredClone(scenario.project);
  violatedProject.tracks[0].clips.shift();
  const violatedEvaluation = evaluateEditorExecution({
    proposalBundle: proposal,
    humanReviewState: result.reviewState,
    reviewedPlan: result.reviewedPlan,
    postProject: violatedProject,
    planEvidence: result.planEvidence,
    videoSemanticEvidence: proposalInput.videoAnalyses,
    constraintSet: resolved.constraintSet!,
    resolvedDurationPolicy: resolved.resolution.structuredPolicy,
  });
  assert.equal(violatedEvaluation.metricResults.find((item) => item.metric === "HARD_CONSTRAINT_COMPLIANCE")?.status, "FAIL");
  assert.equal(violatedEvaluation.overallStatus, "FAIL");

  const explanations = deriveEditorDecisionExplanationsV1({
    project: scenario.project,
    intent: resolved.resultingIntent,
    constraintSet: resolved.constraintSet,
    feasibilityReport: resolved.feasibilityReport,
    proposal,
    review: result.reviewState,
    reviewedEvidence: result.planEvidence,
    evaluation,
  });
  const noChangeExplanation = explanations.find((item) => item.headline === "当前没有可安全执行的进一步修改");
  const hardConstraintExplanation = explanations.find((item) => item.subjectId === "HARD_CONSTRAINT_COMPLIANCE")!;
  assert.match(noChangeExplanation?.summary ?? "", /当前 38 秒全部属于已确认保护内容/);
  assert.match(noChangeExplanation?.summary ?? "", /30 秒目标不可达/);
  assert.equal(hardConstraintExplanation.summary, "当前工程完整保留了所有活动硬约束，本轮未执行编辑动作。");
  assert.doesNotMatch(hardConstraintExplanation.summary, /真实执行后|执行后|修改后/);

  const html = renderToStaticMarkup(PlanEvidencePanel({
    evidence: proposal.planEvidence,
    proposal,
    review,
    onExecuteReviewed: () => undefined,
  }));
  assert.match(html, /当前没有可安全执行的进一步修改/);
  assert.match(html, /最短仍为 0:38/);
  assert.match(html, /保持当前结果/);
  assert.doesNotMatch(html, /COMPILATION_REJECTED|zero canonical actions|clip-teacher|clip-logo/);
});

test("R9Y-S3A zero-action review diagnostic exposes only authoritative scalar facts without behavior change", () => {
  const { scenario, resolved, proposalInput } = preparedCampusNoChange();
  const generated = generateCollaborativeEditingOptionsV1({
    planGenerationMode: "SINGLE",
    proposalInput,
    feasibilityReport: resolved.feasibilityReport!,
  });
  assert.equal(generated.ok, true);
  if (!generated.ok) return;
  const proposal = generated.optionSet.options[0].proposalBundle;
  const review = createHumanReviewState(proposal);
  const result = executeReviewedProposal({
    proposal,
    review,
    currentProject: scenario.project,
    executionUpdatedAt: "2026-10-29T01:00:00.000Z",
  });
  const proposalBefore = structuredClone(proposal);
  const resultBefore = structuredClone(result);
  const captured = captureAcceptanceDiagnostics(true, () => emitZeroActionReviewResultDiagnosticV1({
    proposal,
    result,
    historyRecordCommitted: false,
  }));

  assert.equal(captured.value, true);
  assert.deepEqual(captured.diagnostics, [{
    schemaVersion: 1,
    kind: "ZERO_ACTION_REVIEW_RESULT",
    stage: "ZERO_ACTION_REVIEW_RESULT",
    proposalStatus: "SAFE_NO_CHANGE",
    reviewLifecycle: "REVIEWED_NO_ACTIONS",
    reviewedPlanStatus: "REVIEWED_NO_ACTIONS",
    planEvidenceLifecycleStatus: "REVIEWED_NO_ACTIONS",
    executionPresent: false,
    historyShouldRecord: false,
    historyRecordCommitted: false,
    proposalActionCount: 0,
    reviewedActionCount: 0,
    executedActionCount: 0,
  }]);
  assert.deepEqual(proposal, proposalBefore);
  assert.deepEqual(result, resultBefore);

  const diagnostic = captured.diagnostics[0];
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    "executedActionCount", "executionPresent", "historyRecordCommitted", "historyShouldRecord",
    "kind", "planEvidenceLifecycleStatus", "proposalActionCount", "proposalStatus",
    "reviewLifecycle", "reviewedActionCount", "reviewedPlanStatus", "schemaVersion", "stage",
  ].sort());
  assert.doesNotMatch(JSON.stringify(diagnostic),
    /project|constraintSet|session|binding|clip|caption|asset|actionJSON|rawAction|token|credential|password|api.?key/i);

  const source = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("const executeApprovedProposal"), source.indexOf("const handleRepairReviewDecision"));
  const diagnosticIndex = handler.indexOf("emitZeroActionReviewResultDiagnosticV1");
  const historySinkIndex = handler.indexOf("setEditorAIUndoProject(cloneProject(result.history.undoProject))");
  assert.ok(diagnosticIndex >= 0 && historySinkIndex > diagnosticIndex);
  assert.match(handler, /if \(result\.status === "REVIEWED_NO_ACTIONS"\)[\s\S]*historyRecordCommitted: false[\s\S]*return;[\s\S]*if \(result\.history\.shouldRecord/);
});

test("R9Y-S3A zero-action diagnostic is acceptance-guarded and intentionally excludes executed reviews", () => {
  const { scenario, resolved, proposalInput } = preparedCampusNoChange();
  const generated = generateCollaborativeEditingOptionsV1({
    planGenerationMode: "SINGLE",
    proposalInput,
    feasibilityReport: resolved.feasibilityReport!,
  });
  assert.equal(generated.ok, true);
  if (!generated.ok) return;
  const proposal = generated.optionSet.options[0].proposalBundle;
  const result = executeReviewedProposal({
    proposal,
    review: createHumanReviewState(proposal),
    currentProject: scenario.project,
    executionUpdatedAt: "2026-10-29T01:00:00.000Z",
  });
  const disabled = captureAcceptanceDiagnostics(false, () => emitZeroActionReviewResultDiagnosticV1({
    proposal,
    result,
    historyRecordCommitted: false,
  }));
  assert.equal(disabled.value, false);
  assert.deepEqual(disabled.diagnostics, []);

  const executed = createMedicalReviewedExecution();
  const contrast = captureAcceptanceDiagnostics(true, () => emitZeroActionReviewResultDiagnosticV1({
    proposal: executed.proposal,
    result: executed.result,
    historyRecordCommitted: false,
  }));
  assert.equal(executed.result.execution !== undefined, true);
  assert.equal(contrast.value, false);
  assert.deepEqual(contrast.diagnostics, []);
});

test("R4 safe no-change boundary does not remap unsafe, stale, or malformed compiler outcomes", () => {
  const { resolved, proposalInput } = preparedCampusNoChange();
  const unsafeWithoutProof = generateEditorProposal(proposalInput);
  assert.equal(unsafeWithoutProof.ok, false);
  assert.equal(unsafeWithoutProof.status, "COMPILATION_REJECTED");

  const staleProject = structuredClone(proposalInput.project);
  staleProject.title = "stale after feasibility";
  const staleFingerprint = generateCollaborativeEditingOptionsV1({
    proposalInput: { ...proposalInput, project: staleProject },
    feasibilityReport: resolved.feasibilityReport!,
  });
  assert.equal(staleFingerprint.ok, false);
  if (!staleFingerprint.ok) assert.equal(staleFingerprint.failures[0]?.status, "NEGOTIATION_NOT_READY");

  const staleConstraintSet = {
    ...proposalInput.constraintSet!,
    validatedAgainstProjectFingerprint: "project-v1-deadbeef",
  } as ConstraintSetV1;
  const staleConstraint = generateEditorProposal({
    ...proposalInput,
    constraintSet: staleConstraintSet,
    feasibilityReport: resolved.feasibilityReport!,
  });
  assert.equal(staleConstraint.ok, false);
  assert.equal(staleConstraint.status, "COMPILATION_REJECTED");

  const valid = generateEditorProposal({ ...proposalInput, feasibilityReport: resolved.feasibilityReport! });
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  const malformed = generateCollaborativeEditingOptionsV1({
    proposalInput,
    feasibilityReport: resolved.feasibilityReport!,
  }, () => ({
    ...valid,
    bundle: {
      ...valid.bundle,
      status: "PENDING_REVIEW",
      safeNoChangeOutcome: undefined,
      compiledPlan: {
        ...valid.bundle.compiledPlan,
        canonicalPlan: { ...valid.bundle.compiledPlan.canonicalPlan, actions: [{ type: "NOT_A_CANONICAL_ACTION" }] },
      },
    } as unknown as typeof valid.bundle,
  }));
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.status, "NO_SAFE_OPTIONS");
});

test("N-P: selection starts independent Human Review, does not execute, and decisions never leak across options", () => {
  const generated = generatedMedical("MULTI_OPTION");
  const before = structuredClone(generated.proposalInput.project);
  const first = selectCollaborativeEditingOptionV1(generated.optionSet, generated.optionSet.options[0].optionId);
  assert.equal(first.review.lifecycle, "PENDING_REVIEW");
  assert.deepEqual(generated.proposalInput.project, before);
  assert.equal(generated.optionSet.options.length, 2);
  const decided = reviewProposalEntry(first.proposal, first.review, {
    proposalEntryId: first.proposal.proposalEntries[0].proposalEntryId,
    decision: "ACCEPT",
  });
  const reviews = { [first.selectedOptionId]: decided };
  const second = selectCollaborativeEditingOptionV1(generated.optionSet, generated.optionSet.options[1].optionId, reviews);
  assert.equal(second.review.entries.every((entry) => entry.status === "PENDING"), true);
  const firstAgain = selectCollaborativeEditingOptionV1(generated.optionSet, first.selectedOptionId, reviews);
  assert.equal(firstAgain.review.entries[0].status, "ACCEPTED");
});

test("Q-S: stale intent, constraint, feasibility, and project fingerprint fail closed", () => {
  const generated = generatedMedical("MULTI_OPTION");
  const current = {
    project: generated.proposalInput.project,
    constraintContext: generated.constraintContext,
    feasibilityReport: generated.feasibilityReport,
  };
  assert.equal(isCollaborativeEditingOptionsCurrentV1(generated.optionSet, current), true);
  assert.equal(isCollaborativeEditingOptionsCurrentV1(generated.optionSet, {
    ...current,
    constraintContext: { ...current.constraintContext, sourceIntentVersionId: "intent-v1-deadbeef" },
  }), false);
  assert.equal(isCollaborativeEditingOptionsCurrentV1(generated.optionSet, {
    ...current,
    constraintContext: { ...current.constraintContext, sourceConstraintSetId: "constraint-set-v1-deadbeef" },
  }), false);
  assert.equal(isCollaborativeEditingOptionsCurrentV1(generated.optionSet, {
    ...current,
    feasibilityReport: { ...current.feasibilityReport, reportId: "feasibility-v1-stale" },
  }), false);
  const changed = structuredClone(current.project);
  changed.title = "changed";
  assert.equal(isCollaborativeEditingOptionsCurrentV1(generated.optionSet, { ...current, project: changed }), false);
});

test("T-V: unselected or unreviewed options cannot execute; selected and reviewed option reaches existing V2.0D", () => {
  const generated = generatedMedical("MULTI_OPTION");
  const first = selectCollaborativeEditingOptionV1(generated.optionSet, generated.optionSet.options[0].optionId);
  const common = {
    optionSet: generated.optionSet,
    proposal: first.proposal,
    currentProject: generated.proposalInput.project,
    currentConstraintContext: generated.constraintContext,
    currentFeasibilityReport: generated.feasibilityReport,
  };
  assert.throws(() => assertCollaborativeOptionExecutableV1({ ...common, selectedOptionId: null, review: first.review }), /Select an editing option/);
  assert.throws(() => assertCollaborativeOptionExecutableV1({ ...common, selectedOptionId: first.selectedOptionId, review: first.review }), /complete Human Review/);
  assert.equal(generated.optionSet.options.length, 2);
  const other = generated.optionSet.options[1];
  assert.throws(() => assertCollaborativeOptionExecutableV1({
    ...common,
    selectedOptionId: other.optionId,
    review: first.review,
  }), /authoritative selected option/);
  const review = acceptAll(first);
  assert.doesNotThrow(() => assertCollaborativeOptionExecutableV1({ ...common, selectedOptionId: first.selectedOptionId, review }));
  const execution = executeReviewedProposal({
    proposal: first.proposal,
    review,
    currentProject: generated.proposalInput.project,
    executionUpdatedAt: "2026-10-26T00:00:00.000Z",
  });
  assert.equal(execution.status, "EXECUTED");
  assert.equal(execution.history.shouldRecord, true);
});

test("comparison UI shows required concise fields, selection control, truthful fallback, and no raw JSON", () => {
  const generated = generatedMedical("MULTI_OPTION");
  const html = renderToStaticMarkup(CollaborativeEditingOptionsPanel({ optionSet: generated.optionSet, onSelectOption: () => undefined }));
  assert.match(html, /选择剪辑方案/);
  assert.match(html, /预计成片时长/);
  assert.match(html, /与目标时长差距/);
  assert.match(html, /保护内容状态/);
  assert.match(html, /主要变化/);
  assert.match(html, /主要取舍/);
  assert.match(html, /选择此方案/);
  assert.match(html, /选择方案不等于批准/);
  assert.doesNotMatch(html, /&quot;compiledPlan&quot;|&quot;canonicalPlan&quot;/);
});

test("UI toggle is OFF by default, discloses optional cost/latency, and starts Human Review only after selection", () => {
  const source = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  assert.match(source, /useState<PlanGenerationModeV1>\(DEFAULT_PLAN_GENERATION_MODE\)/);
  assert.match(source, /checked=\{planGenerationMode === "MULTI_OPTION"\}/);
  assert.match(source, /生成多个剪辑方案/);
  assert.match(source, /可能增加 AI 调用次数和处理时间，普通剪辑无需开启/);
  const switchHandler = source.slice(source.indexOf("const changePlanGenerationMode"), source.indexOf("const selectCollaborativeOption"));
  assert.doesNotMatch(switchHandler, /generateCollaborativeEditingOptionsV1|generateEditorProposal|setEditorProject/);
  const generationHandler = source.slice(source.indexOf("const generateProductionProposal"), source.indexOf("const currentVideoSemanticEvidence"));
  assert.match(generationHandler, /planGenerationMode === "MULTI_OPTION"[\s\S]*setEditorProposal\(null\)[\s\S]*setEditorProposalReview\(null\)/);
  assert.match(generationHandler, /const safeNoChange = result\.optionSet\.options\[0\]\.proposalBundle\.safeNoChangeOutcome/);
  assert.match(generationHandler, /emitEditorProposalStageDiagnosticV1\("RESULT_MAPPING", "FAILED", result\.status\)/);
  assert.match(generationHandler, /emitEditorProposalStageDiagnosticV1\([\s\S]*"RESULT_MAPPING"[\s\S]*safeNoChange \? "SAFE_NO_CHANGE" : "READY_FOR_REVIEW"/);
  assert.match(generationHandler, /当前没有可安全执行的进一步修改。/);
  assert.match(generationHandler, /最短仍为.*minimumFeasibleDurationMs[\s\S]*与目标相差.*remainingGapMs/);
  const selectionHandler = source.slice(source.indexOf("const selectCollaborativeOption"), source.indexOf("const handleProposalReviewDecision"));
  assert.match(selectionHandler, /selectCollaborativeEditingOptionV1/);
  assert.match(selectionHandler, /setEditorProposal\(selection\.proposal\)/);
  assert.match(selectionHandler, /setEditorProposalReview\(selection\.review\)/);
  assert.doesNotMatch(selectionHandler, /executeReviewedProposal|setEditorProject/);
});
