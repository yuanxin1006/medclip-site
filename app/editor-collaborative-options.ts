import { parseAIEditingPlan } from "./editor-ai-requirements.ts";
import type { ConstraintFeasibilityReportV1 } from "./editor-constraint-feasibility.ts";
import { enforceEditorActionConstraintsV1 } from "./editor-constraint-enforcement.ts";
import { createEditorProjectFingerprint } from "./editor-plan-evidence.ts";
import {
  generateEditorProposal,
  type EditorProposalBundle,
  type EditorProposalGenerationResult,
  type EditorProposalInput,
  type ProposalPlanningStrategyV1,
} from "./editor-proposal-orchestrator.ts";
import { createHumanReviewState, type HumanReviewState } from "./editor-proposal-review.ts";
import type { EditorProject } from "./editor-core.ts";
import type { ProposalConstraintContextV1 } from "./editor-constraint-negotiation.ts";
import { emitEditorProposalStageDiagnosticV1 } from "./editor-acceptance-diagnostics.ts";

export const COLLABORATIVE_EDITING_OPTIONS_SCHEMA_VERSION = 1 as const;
export const DEFAULT_PLAN_GENERATION_MODE = "SINGLE" as const;
export const MAX_COLLABORATIVE_OPTIONS = 3 as const;
export const V2_4A_PROVIDER_GENERATION_BUDGET = 0 as const;

export type PlanGenerationModeV1 = "SINGLE" | "MULTI_OPTION";
export type CollaborativeStrategyKindV1 = ProposalPlanningStrategyV1;

export type CollaborativeOptionEvidenceV1 = Readonly<{
  whyRetained: readonly string[];
  whyRemoved: readonly string[];
  whyReordered: readonly string[];
  whyDurationDiffers: string;
  whyStrategyDiffers: string;
  hardConstraintIds: readonly string[];
  bindingReferences: readonly string[];
}>;

export type CollaborativeTargetGapV1 = Readonly<{
  requestedDurationMs: number | null;
  minimumFeasibleDurationMs: number | null;
  remainingGapMs: number | null;
  canReachRequestedDuration: boolean | null;
}>;

export type CollaborativeEditingOptionV1 = Readonly<{
  optionId: string;
  strategyKind: CollaborativeStrategyKindV1;
  title: string;
  summary: string;
  tradeoffs: readonly string[];
  predictedDuration: number;
  targetGap: CollaborativeTargetGapV1;
  protectedContentPreserved: true;
  proposalBundle: EditorProposalBundle;
  evidence: CollaborativeOptionEvidenceV1;
  status: "SELECTABLE";
}>;

export type CollaborativeFeasibilityRefV1 = Readonly<{
  reportId: string;
  requestedDurationMs: number | null;
  minimumFeasibleDurationMs: number | null;
  remainingGapMs: number | null;
}>;

export type CollaborativeEditingOptionsV1 = Readonly<{
  schemaVersion: typeof COLLABORATIVE_EDITING_OPTIONS_SCHEMA_VERSION;
  optionSetId: string;
  planGenerationMode: PlanGenerationModeV1;
  requestedOptionCount: number;
  generatedOptionCount: number;
  providerGenerationBudget: number;
  providerCallsUsed: 0;
  networkCallsUsed: 0;
  intentVersionId: string;
  constraintSetId: string;
  constraintFingerprint: string;
  constraintResolutionId: string | null;
  projectFingerprint: string;
  feasibilityRef: CollaborativeFeasibilityRefV1;
  options: readonly CollaborativeEditingOptionV1[];
  generationNotice?: string;
}>;

export type CollaborativeOptionsGenerationResult =
  | Readonly<{ ok: true; optionSet: CollaborativeEditingOptionsV1 }>
  | Readonly<{
    ok: false;
    status: "NEGOTIATION_NOT_READY" | "NO_SAFE_OPTIONS";
    message: string;
    failures: readonly EditorProposalGenerationResult[];
    providerCallsUsed: 0;
    networkCallsUsed: 0;
  }>;

export type CollaborativeEditingSelectionV1 = Readonly<{
  optionSetId: string;
  selectedOptionId: string;
  proposal: EditorProposalBundle;
  review: HumanReviewState;
}>;

type ProposalGenerator = (input: EditorProposalInput) => EditorProposalGenerationResult;

const STRATEGIES: readonly CollaborativeStrategyKindV1[] = Object.freeze([
  "CONTENT_PRIORITY",
  "BALANCED",
  "RHYTHM_PRIORITY",
]);

const STRATEGY_COPY: Readonly<Record<CollaborativeStrategyKindV1, Readonly<{
  title: string;
  summary: string;
  tradeoffs: readonly string[];
  difference: string;
}>>> = Object.freeze({
  CONTENT_PRIORITY: Object.freeze({
    title: "内容优先",
    summary: "优先保留语义支持更强的非保护内容，同时完整遵守保护约束。",
    tradeoffs: Object.freeze(["保留更多有意义的上下文", "节奏调整相对克制"]),
    difference: "在同一安全候选范围内优先语义与内容连续性。",
  }),
  BALANCED: Object.freeze({
    title: "均衡",
    summary: "在内容连续性与轻快节奏之间采取中间方案。",
    tradeoffs: Object.freeze(["兼顾内容与节奏", "不以牺牲保护内容换取目标时长"]),
    difference: "沿用 V2.0A–C 的综合排序与叙事规划。",
  }),
  RHYTHM_PRIORITY: Object.freeze({
    title: "节奏优先",
    summary: "更积极地调整非保护内容的素材选择与编排，保护内容保持不变。",
    tradeoffs: Object.freeze(["非保护内容变化更明显", "仍受相同硬约束和可信证据限制"]),
    difference: "在已通过 V2.0A 阈值的候选中探索不同的非保护内容组合。",
  }),
});

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193) >>> 0;
  }
  return result.toString(16).padStart(8, "0");
}

function canonicalActionSignature(bundle: EditorProposalBundle): string {
  return stable(bundle.compiledPlan.canonicalPlan.actions.map((action) => {
    const { reason: _reason, ...semanticAction } = action;
    return semanticAction;
  }));
}

function targetGap(report: ConstraintFeasibilityReportV1): CollaborativeTargetGapV1 {
  return Object.freeze({
    requestedDurationMs: report.requestedDurationMs,
    minimumFeasibleDurationMs: report.minimumFeasibleDurationMs,
    remainingGapMs: report.remainingGapMs,
    canReachRequestedDuration: report.remainingGapMs === null ? null : report.remainingGapMs === 0,
  });
}

function feasibilityRef(report: ConstraintFeasibilityReportV1): CollaborativeFeasibilityRefV1 {
  return Object.freeze({
    reportId: report.reportId,
    requestedDurationMs: report.requestedDurationMs,
    minimumFeasibleDurationMs: report.minimumFeasibleDurationMs,
    remainingGapMs: report.remainingGapMs,
  });
}

function proposalPassesDisplaySafety(bundle: EditorProposalBundle): boolean {
  try {
    if (bundle.compiledPlan.status !== "VALIDATED") return false;
    parseAIEditingPlan(bundle.compiledPlan.canonicalPlan);
    const context = bundle.evidenceMetadata.constraintContext;
    return bundle.compiledPlan.canonicalPlan.actions.every((action) => {
      const result = enforceEditorActionConstraintsV1({
        project: bundle.trustedPreExecutionProject,
        constraintSet: bundle.constraintSet,
        ...(context ? { expectedContext: {
          intentVersionId: context.sourceIntentVersionId,
          constraintSetId: context.sourceConstraintSetId,
          constraintFingerprint: context.sourceConstraintFingerprint,
        } } : {}),
        action,
      });
      return result.status === "ALLOWED" && result.violations.length === 0;
    });
  } catch {
    return false;
  }
}

function evidence(bundle: EditorProposalBundle, strategy: CollaborativeStrategyKindV1, report: ConstraintFeasibilityReportV1): CollaborativeOptionEvidenceV1 {
  const constraints = bundle.constraintSet?.activeConstraints ?? [];
  const bindings = bundle.constraintSet?.confirmedBindings ?? [];
  return Object.freeze({
    whyRetained: Object.freeze(bundle.planEvidence.entries.map((entry) => entry.explanation)),
    whyRemoved: Object.freeze(bundle.compiledPlan.canonicalPlan.actions
      .filter((action) => action.type === "DELETE_CLIP")
      .map((action) => `移除 ${action.targetId}：${action.reason}`)),
    whyReordered: Object.freeze(bundle.compiledPlan.canonicalPlan.actions
      .filter((action) => action.type === "REORDER_CLIP")
      .map((action) => `重排 ${action.targetId}：${action.reason}`)),
    whyDurationDiffers: report.remainingGapMs && report.remainingGapMs > 0
      ? `硬保护内容使最短可行时长仍比目标长 ${report.remainingGapMs} 毫秒。`
      : "预计时长来自当前可信时间线与已验证规范动作。",
    whyStrategyDiffers: STRATEGY_COPY[strategy].difference,
    hardConstraintIds: Object.freeze(constraints.map((item) => item.constraintId)),
    bindingReferences: Object.freeze(bindings.map((item) => item.bindingId)),
  });
}

function optionFromBundle(
  bundle: EditorProposalBundle,
  strategy: CollaborativeStrategyKindV1,
  report: ConstraintFeasibilityReportV1,
  optionSetMaterial: unknown,
): CollaborativeEditingOptionV1 {
  const copy = STRATEGY_COPY[strategy];
  const safeNoChange = bundle.safeNoChangeOutcome;
  return Object.freeze({
    optionId: `collaborative-option-v1-${hash(stable({ optionSetMaterial, strategy, proposalId: bundle.proposalId }))}`,
    strategyKind: strategy,
    title: safeNoChange ? "保持当前安全结果" : copy.title,
    summary: safeNoChange ? safeNoChange.reason : copy.summary,
    tradeoffs: safeNoChange
      ? Object.freeze(["保留全部已确认保护内容", `与目标时长仍相差 ${Math.round(safeNoChange.remainingGapMs / 1_000)} 秒`])
      : copy.tradeoffs,
    predictedDuration: bundle.trustedPreExecutionProject.durationMs,
    targetGap: targetGap(report),
    protectedContentPreserved: true,
    proposalBundle: bundle,
    evidence: evidence(bundle, strategy, report),
    status: "SELECTABLE",
  });
}

export function generateCollaborativeEditingOptionsV1(input: Readonly<{
  planGenerationMode?: PlanGenerationModeV1;
  requestedOptionCount?: number;
  proposalInput: EditorProposalInput;
  feasibilityReport: ConstraintFeasibilityReportV1;
  providerGenerationBudget?: number;
}>, generator: ProposalGenerator = generateEditorProposal): CollaborativeOptionsGenerationResult {
  const mode = input.planGenerationMode ?? DEFAULT_PLAN_GENERATION_MODE;
  const context = input.proposalInput.constraintContext;
  const set = input.proposalInput.constraintSet;
  emitEditorProposalStageDiagnosticV1("COLLABORATIVE_OPTION_FILTER", "ENTERED");
  if (!context || !set || context.readiness !== "READY_TO_PLAN"
    || context.feasibilityReportId !== input.feasibilityReport.reportId) {
    emitEditorProposalStageDiagnosticV1("COLLABORATIVE_OPTION_FILTER", "FAILED", "NEGOTIATION_NOT_READY");
    return Object.freeze({
      ok: false,
      status: "NEGOTIATION_NOT_READY",
      message: "Constraint negotiation and feasibility must be current before plan generation.",
      failures: Object.freeze([]),
      providerCallsUsed: 0,
      networkCallsUsed: 0,
    });
  }
  const requestedOptionCount = mode === "SINGLE"
    ? 1
    : Math.min(MAX_COLLABORATIVE_OPTIONS, Math.max(2, Math.trunc(input.requestedOptionCount ?? MAX_COLLABORATIVE_OPTIONS)));
  const providerGenerationBudget = Math.max(0, Math.trunc(input.providerGenerationBudget ?? V2_4A_PROVIDER_GENERATION_BUDGET));
  if (providerGenerationBudget !== 0) {
    emitEditorProposalStageDiagnosticV1("COLLABORATIVE_OPTION_FILTER", "FAILED", "NO_SAFE_OPTIONS");
    return Object.freeze({
      ok: false,
      status: "NO_SAFE_OPTIONS",
      message: "V2.4A is provider-free; providerGenerationBudget must remain 0.",
      failures: Object.freeze([]),
      providerCallsUsed: 0,
      networkCallsUsed: 0,
    });
  }
  const strategies = mode === "SINGLE" ? ["BALANCED" as const] : STRATEGIES.slice(0, requestedOptionCount);
  const failures: EditorProposalGenerationResult[] = [];
  const unique = new Map<string, Readonly<{ bundle: EditorProposalBundle; strategy: CollaborativeStrategyKindV1 }>>();
  for (const strategy of strategies) {
    const generated = generator({
      ...input.proposalInput,
      feasibilityReport: input.feasibilityReport,
      ...(mode === "MULTI_OPTION" ? { planningStrategy: strategy } : {}),
    });
    if (!generated.ok) {
      failures.push(generated);
      emitEditorProposalStageDiagnosticV1("COLLABORATIVE_OPTION_FILTER", "FAILED", generated.status);
      continue;
    }
    if (!proposalPassesDisplaySafety(generated.bundle)) {
      emitEditorProposalStageDiagnosticV1("COLLABORATIVE_OPTION_FILTER", "FAILED", "DISPLAY_SAFETY_FILTER_REJECTED");
      continue;
    }
    const signature = canonicalActionSignature(generated.bundle);
    if (!unique.has(signature)) unique.set(signature, Object.freeze({ bundle: generated.bundle, strategy }));
  }
  if (!unique.size) {
    emitEditorProposalStageDiagnosticV1("COLLABORATIVE_OPTION_FILTER", "FAILED", "NO_SAFE_OPTIONS");
    return Object.freeze({
      ok: false,
      status: "NO_SAFE_OPTIONS",
      message: "No canonically valid, hard-constraint-safe editing proposal is available.",
      failures: Object.freeze(failures),
      providerCallsUsed: 0,
      networkCallsUsed: 0,
    });
  }
  const projectFingerprint = createEditorProjectFingerprint(input.proposalInput.project);
  const ref = feasibilityRef(input.feasibilityReport);
  const constraintResolutionId = context.resolutionIds.at(-1) ?? null;
  const optionSetMaterial = Object.freeze({
    mode,
    requestedOptionCount,
    intentVersionId: context.sourceIntentVersionId,
    constraintSetId: context.sourceConstraintSetId,
    constraintFingerprint: context.sourceConstraintFingerprint,
    constraintResolutionId,
    projectFingerprint,
    feasibilityRef: ref,
  });
  const options = Object.freeze([...unique.values()].map(({ bundle, strategy }) => optionFromBundle(
    bundle,
    strategy,
    input.feasibilityReport,
    optionSetMaterial,
  )));
  emitEditorProposalStageDiagnosticV1(
    "COLLABORATIVE_OPTION_FILTER",
    options[0]?.proposalBundle.safeNoChangeOutcome ? "SAFE_NO_CHANGE" : "READY_FOR_REVIEW",
  );
  const optionSetId = `collaborative-options-v1-${hash(stable({ optionSetMaterial, optionIds: options.map((item) => item.optionId) }))}`;
  return Object.freeze({
    ok: true,
    optionSet: Object.freeze({
      schemaVersion: COLLABORATIVE_EDITING_OPTIONS_SCHEMA_VERSION,
      optionSetId,
      planGenerationMode: mode,
      requestedOptionCount,
      generatedOptionCount: options.length,
      providerGenerationBudget,
      providerCallsUsed: 0,
      networkCallsUsed: 0,
      intentVersionId: context.sourceIntentVersionId,
      constraintSetId: context.sourceConstraintSetId,
      constraintFingerprint: context.sourceConstraintFingerprint,
      constraintResolutionId,
      projectFingerprint,
      feasibilityRef: ref,
      options,
      ...(mode === "MULTI_OPTION" && options.length === 1
        ? { generationNotice: options[0].proposalBundle.safeNoChangeOutcome
          ? "当前保护约束下只有 1 个真实且安全的结果：保持当前结果；未生成重复方案。"
          : "当前约束下只找到 1 个实质不同且安全的方案，未生成重复方案。" }
        : {}),
    }),
  });
}

export function isCollaborativeEditingOptionsCurrentV1(
  optionSet: CollaborativeEditingOptionsV1,
  current: Readonly<{
    project: EditorProject;
    constraintContext: ProposalConstraintContextV1;
    feasibilityReport: ConstraintFeasibilityReportV1;
  }>,
): boolean {
  return optionSet.projectFingerprint === createEditorProjectFingerprint(current.project)
    && optionSet.intentVersionId === current.constraintContext.sourceIntentVersionId
    && optionSet.constraintSetId === current.constraintContext.sourceConstraintSetId
    && optionSet.constraintFingerprint === current.constraintContext.sourceConstraintFingerprint
    && optionSet.constraintResolutionId === (current.constraintContext.resolutionIds.at(-1) ?? null)
    && optionSet.feasibilityRef.reportId === current.feasibilityReport.reportId
    && optionSet.feasibilityRef.requestedDurationMs === current.feasibilityReport.requestedDurationMs
    && optionSet.feasibilityRef.minimumFeasibleDurationMs === current.feasibilityReport.minimumFeasibleDurationMs
    && optionSet.feasibilityRef.remainingGapMs === current.feasibilityReport.remainingGapMs;
}

export function selectCollaborativeEditingOptionV1(
  optionSet: CollaborativeEditingOptionsV1,
  optionId: string,
  reviewByOptionId: Readonly<Record<string, HumanReviewState>> = Object.freeze({}),
): CollaborativeEditingSelectionV1 {
  if (optionSet.planGenerationMode !== "MULTI_OPTION") throw new Error("Option selection is only valid in MULTI_OPTION mode.");
  const option = optionSet.options.find((item) => item.optionId === optionId);
  if (!option || option.status !== "SELECTABLE") throw new Error("The selected editing option is unavailable.");
  const retained = reviewByOptionId[optionId];
  const review = retained?.proposalId === option.proposalBundle.proposalId
    ? retained
    : createHumanReviewState(option.proposalBundle);
  return Object.freeze({
    optionSetId: optionSet.optionSetId,
    selectedOptionId: option.optionId,
    proposal: option.proposalBundle,
    review,
  });
}

export function assertCollaborativeOptionExecutableV1(input: Readonly<{
  optionSet: CollaborativeEditingOptionsV1;
  selectedOptionId: string | null;
  proposal: EditorProposalBundle;
  review: HumanReviewState;
  currentProject: EditorProject;
  currentConstraintContext: ProposalConstraintContextV1;
  currentFeasibilityReport: ConstraintFeasibilityReportV1;
}>): void {
  if (!input.selectedOptionId) throw new Error("Select an editing option before Human Review execution.");
  if (!isCollaborativeEditingOptionsCurrentV1(input.optionSet, {
    project: input.currentProject,
    constraintContext: input.currentConstraintContext,
    feasibilityReport: input.currentFeasibilityReport,
  })) throw new Error("The editing option set is stale and cannot execute.");
  const selected = input.optionSet.options.find((item) => item.optionId === input.selectedOptionId);
  if (!selected || selected.proposalBundle.proposalId !== input.proposal.proposalId) {
    throw new Error("Only the authoritative selected option can execute.");
  }
  if (input.review.proposalId !== input.proposal.proposalId
    || !["READY_TO_EXECUTE", "REVIEWED_NO_ACTIONS"].includes(input.review.lifecycle)) {
    throw new Error("The selected option must complete Human Review before execution.");
  }
}
