import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanEvidencePanel } from "./editor-plan-evidence-panel.ts";
import type { EditorProposalBundle } from "./editor-proposal-orchestrator.ts";
import {
  createHumanReviewState,
  executeReviewedProposal,
  reviewProposalEntry,
  type HumanReviewDecision,
  type HumanReviewState,
} from "./editor-proposal-review.ts";
import { createMedicalReviewProposal } from "./test-support/editor-proposal-review-fixture.ts";

function decide(proposal: EditorProposalBundle, review: HumanReviewState, index: number, decision: "ACCEPT" | "REJECT" | "MODIFY", selectedAssetId?: string) {
  return reviewProposalEntry(proposal, review, {
    proposalEntryId: proposal.proposalEntries[index].proposalEntryId,
    decision,
    ...(selectedAssetId ? { selectedAssetId } : {}),
  });
}

function elements(node: ReactNode, type?: string): ReactElement[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  const self = !type || element.type === type ? [element] : [];
  const children = Array.isArray(element.props.children) ? element.props.children : [element.props.children];
  return [...self, ...children.flatMap((child) => elements(child, type))];
}

test("pending state renders per-entry accept, reject, modify and review status", () => {
  const proposal = createMedicalReviewProposal();
  const html = renderToStaticMarkup(PlanEvidencePanel({
    evidence: proposal.planEvidence,
    proposal,
    review: createHumanReviewState(proposal),
    onReviewDecision: () => undefined,
  }));
  assert.match(html, /待审核/);
  assert.match(html, /接受/);
  assert.match(html, /拒绝/);
  assert.match(html, /修改/);
  assert.match(html, /当前 → 建议/);
});

test("accept and reject controls emit structured per-entry decisions only", () => {
  const proposal = createMedicalReviewProposal();
  const decisions: HumanReviewDecision[] = [];
  const tree = PlanEvidencePanel({ evidence: proposal.planEvidence, proposal, review: createHumanReviewState(proposal), onReviewDecision: (decision) => decisions.push(decision) });
  const buttons = elements(tree, "button") as Array<ReactElement<{ children?: ReactNode; onClick?: () => void }>>;
  buttons.find((button) => button.props.children === "接受")?.props.onClick?.();
  buttons.find((button) => button.props.children === "拒绝")?.props.onClick?.();
  assert.deepEqual(decisions, [
    { proposalEntryId: proposal.proposalEntries[0].proposalEntryId, decision: "ACCEPT" },
    { proposalEntryId: proposal.proposalEntries[0].proposalEntryId, decision: "REJECT" },
  ]);
});

test("modify exposes and emits only trusted accepted alternatives", () => {
  const proposal = createMedicalReviewProposal();
  const decisions: HumanReviewDecision[] = [];
  const tree = PlanEvidencePanel({ evidence: proposal.planEvidence, proposal, review: createHumanReviewState(proposal), onReviewDecision: (decision) => decisions.push(decision) });
  const selects = elements(tree, "select") as Array<ReactElement<{ "aria-label"?: string; onChange?: (event: { currentTarget: { value: string } }) => void; children?: ReactNode }>>;
  const ecg = selects.find((select) => select.props["aria-label"]?.includes("interval-ecg"));
  assert.ok(ecg);
  const optionHtml = renderToStaticMarkup(ecg);
  assert.match(optionHtml, /asset-ecg-alt/);
  assert.doesNotMatch(optionHtml, /asset-ecg-rejected|asset-treatment/);
  ecg.props.onChange?.({ currentTarget: { value: "asset-ecg-alt" } });
  assert.deepEqual(decisions.at(-1), { proposalEntryId: proposal.proposalEntries[2].proposalEntryId, decision: "MODIFY", selectedAssetId: "asset-ecg-alt" });
});

test("modified asset and status are visible by friendly name", () => {
  const proposal = createMedicalReviewProposal();
  const review = decide(proposal, createHumanReviewState(proposal), 2, "MODIFY", "asset-ecg-alt");
  const html = renderToStaticMarkup(PlanEvidencePanel({ evidence: proposal.planEvidence, proposal, review, onReviewDecision: () => undefined }));
  assert.match(html, /已修改/);
  assert.match(html, /Friendly asset-ecg-alt/);
});

test("execute button remains blocked while any entry is pending", () => {
  const proposal = createMedicalReviewProposal();
  const tree = PlanEvidencePanel({ evidence: proposal.planEvidence, proposal, review: createHumanReviewState(proposal), onReviewDecision: () => undefined, onExecuteReviewed: () => undefined });
  const button = (elements(tree, "button") as Array<ReactElement<{ children?: ReactNode; disabled?: boolean }>>).find((item) => item.props.children === "执行已批准修改");
  assert.equal(button?.props.disabled, true);
});

test("all-reviewed execution control is enabled, including all-rejected completion", () => {
  const proposal = createMedicalReviewProposal();
  let review = createHumanReviewState(proposal);
  proposal.proposalEntries.forEach((_, index) => { review = decide(proposal, review, index, "REJECT"); });
  const tree = PlanEvidencePanel({ evidence: proposal.planEvidence, proposal, review, onReviewDecision: () => undefined, onExecuteReviewed: () => undefined });
  const button = (elements(tree, "button") as Array<ReactElement<{ children?: ReactNode; disabled?: boolean }>>).find((item) => item.props.children === "执行已批准修改");
  assert.equal(review.lifecycle, "REVIEWED_NO_ACTIONS");
  assert.equal(button?.props.disabled, false);
});

test("stale warning is visible and disables execution", () => {
  const proposal = createMedicalReviewProposal();
  let review = createHumanReviewState(proposal);
  proposal.proposalEntries.forEach((_, index) => { review = decide(proposal, review, index, "ACCEPT"); });
  const html = renderToStaticMarkup(PlanEvidencePanel({
    evidence: proposal.planEvidence, proposal, review, onReviewDecision: () => undefined, onExecuteReviewed: () => undefined,
    staleMessage: "当前项目已发生变化，请重新生成剪辑建议",
  }));
  assert.match(html, /当前项目已发生变化，请重新生成剪辑建议/);
  assert.match(html, /执行已批准修改/);
  assert.match(html, /disabled/);
});

test("executed and rejected states render truthfully without raw canonical JSON", () => {
  const proposal = createMedicalReviewProposal();
  let review = createHumanReviewState(proposal);
  review = decide(proposal, review, 0, "ACCEPT");
  review = decide(proposal, review, 1, "ACCEPT");
  review = decide(proposal, review, 2, "MODIFY", "asset-ecg-alt");
  review = decide(proposal, review, 3, "REJECT");
  review = decide(proposal, review, 4, "ACCEPT");
  const result = executeReviewedProposal({ proposal, review, currentProject: proposal.trustedPreExecutionProject, executionUpdatedAt: "2026-10-25T02:00:00.000Z" });
  const html = renderToStaticMarkup(PlanEvidencePanel({ evidence: result.planEvidence, proposal }));
  assert.match(html, /已执行/);
  assert.match(html, /未执行（用户拒绝）/);
  assert.match(html, /USER_MODIFIED/);
  assert.doesNotMatch(html, /未执行（用户拒绝）[^<]*失败/);
  assert.doesNotMatch(html, /&quot;actions&quot;|\{"summary"/);
});

test("EditorStudio wires review-only decisions separately from explicit execution and keeps manual editor callbacks", () => {
  const source = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  const reviewHandler = source.slice(source.indexOf("const handleProposalReviewDecision"), source.indexOf("const executeApprovedProposal"));
  assert.match(reviewHandler, /reviewProposalEntry/);
  assert.doesNotMatch(reviewHandler, /setEditorProject|handleEditorProjectChange|setEditorAIUndoProject|executeReviewedProposal/);
  const executeHandler = source.slice(source.indexOf("const executeApprovedProposal"), source.indexOf("const runEditorTextTask"));
  assert.match(executeHandler, /executeReviewedProposal/);
  assert.match(executeHandler, /setEditorAIUndoProject/);
  assert.match(executeHandler, /handleEditorProjectChange/);
  assert.match(source, /<TimelineEditor/);
  assert.match(source, /onProjectChange=\{handleEditorProjectChange\}/);
});
