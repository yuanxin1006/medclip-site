import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanEvidencePanel } from "./editor-plan-evidence-panel.ts";
import type { PlanEvidence } from "./editor-plan-evidence.ts";

const fixture: PlanEvidence = {
  schemaVersion: 2, planId: "plan-fixture", lifecycleStatus: "EXECUTED", entries: [
    { id: "e-applied", proposalEntryId: "e-applied", intervalId: "i1", interval: { startMs: 0, endMs: 5_000, caption: "consultation", concepts: ["doctor"] }, selectedAssetId: "doctor-shot", matching: { semanticScore: 0.9, usabilityScore: 0.8, timingScore: 1, repetitionPenalty: 0, totalScore: 0.8, matchedConcepts: ["doctor"], supportingSegmentIds: ["segment-1"], supportingSourceRanges: [], evidenceFrameMs: [500], rejectedAlternatives: [] }, narrative: { scoreDelta: 0.03, evidence: [{ code: "ACTION_PROGRESSION_SUPPORTED", scoreDelta: 0.03, summary: "承接問診後的說明", toAssetId: "doctor-shot" }] }, compiledAction: { actionIndex: 0, actionType: "MATCH_ASSET_TO_SEGMENT", targetId: "clip-1", assetId: "doctor-shot", intervalId: "i1", validationStatus: "VALIDATED", mappingStatus: "COMPILED", reason: "structured reason" }, status: "APPLIED", currentProposed: { targetClipId: "clip-1", currentAssetId: "seed-shot", proposedAssetId: "doctor-shot", timelineStartMs: 0, timelineEndMs: 5_000 }, beforeAfter: { targetClipId: "clip-1", assetBefore: "seed-shot", assetAfter: "doctor-shot", timelineStartMs: 0, timelineEndMs: 5_000 }, explanation: "素材支持「doctor」，並承接前一段的內容進展。" },
    { id: "e-noop", proposalEntryId: "e-noop", intervalId: "i2", interval: { startMs: 5_000, endMs: 10_000, caption: "same", concepts: ["doctor"] }, status: "NO_OP", beforeAfter: { targetClipId: "clip-2", assetBefore: "same", assetAfter: "same", timelineStartMs: 5_000, timelineEndMs: 10_000 }, explanation: "素材與原項目相同。" },
    { id: "e-failed", proposalEntryId: "e-failed", intervalId: "i3", interval: { startMs: 10_000, endMs: 15_000, caption: "failed", concepts: ["doctor"] }, status: "FAILED", failureCode: "ACTION_APPLICATION_FAILED", beforeAfter: { targetClipId: "clip-3", assetBefore: "before", assetAfter: "before", timelineStartMs: 10_000, timelineEndMs: 15_000 }, explanation: "執行未完成。" },
    { id: "e-unresolved", proposalEntryId: "e-unresolved", intervalId: "i4", interval: { startMs: 15_000, endMs: 20_000, caption: "unknown", concepts: ["unknown"] }, status: "UNRESOLVED", explanation: "沒有找到足夠可信的素材。" },
  ],
  summary: { resolvedIntervalCount: 3, unresolvedIntervalCount: 1, compiledActionCount: 1, averageSemanticScore: 0.9, narrativeEvidenceAvailable: true, preProjectReference: "pre", execution: { status: "FAILED", fingerprint: "fp", postProjectReference: "post", appliedCount: 1, noOpCount: 0, failedCount: 1 } },
  preservation: { captionsUnchanged: true, audioUnchanged: true, ratioUnchanged: true, durationUnchanged: true, unrelatedClipsUnchanged: true, transformsUnchanged: true, tracksUnchanged: true },
};

test("applied, no-op, unresolved, failed, reason, before/after render distinctly without changing evidence", () => {
  const before = structuredClone(fixture);
  const html = renderToStaticMarkup(PlanEvidencePanel({ evidence: fixture }));
  assert.match(html, /已应用/);
  assert.match(html, /未改变/);
  assert.match(html, /没有找到足够可信的素材/);
  assert.match(html, /执行失败/);
  assert.match(html, /为什么选|為什麼選|素材支持/);
  assert.match(html, /seed-shot → doctor-shot/);
  assert.match(html, /承接問診後的說明/);
  assert.deepEqual(fixture, before);
});

test("empty panel stays read-only and explains that structured evidence is not available", () => {
  assert.match(renderToStaticMarkup(PlanEvidencePanel({ evidence: null })), /尚无可展示的结构化剪辑证据/);
});

test("pending proposal renders current versus proposed without execution claims or controls", () => {
  const pending: PlanEvidence = {
    schemaVersion: 2,
    planId: "plan-pending",
    lifecycleStatus: "PENDING_REVIEW",
    entries: [{
      id: "e-pending", proposalEntryId: "e-pending", intervalId: "i1",
      interval: { startMs: 0, endMs: 5_000, caption: "consultation", concepts: ["doctor"] },
      selectedAssetId: "doctor-shot", status: "PENDING_REVIEW",
      compiledAction: { actionIndex: 0, actionType: "MATCH_ASSET_TO_SEGMENT", targetId: "clip-1", assetId: "doctor-shot", intervalId: "i1", validationStatus: "VALIDATED", mappingStatus: "COMPILED", reason: "structured reason" },
      currentProposed: { targetClipId: "clip-1", currentAssetId: "seed-shot", proposedAssetId: "doctor-shot", timelineStartMs: 0, timelineEndMs: 5_000 },
      explanation: "素材支持「doctor」；等待人工审核。",
    }],
    summary: { resolvedIntervalCount: 1, unresolvedIntervalCount: 0, compiledActionCount: 1, averageSemanticScore: 0.9, narrativeEvidenceAvailable: true, preProjectReference: "pre" },
  };
  const html = renderToStaticMarkup(PlanEvidencePanel({ evidence: pending }));
  assert.match(html, /等待人工审核/);
  assert.match(html, /当前 → 建议/);
  assert.match(html, /seed-shot → doctor-shot/);
  assert.doesNotMatch(html, /已应用|执行前后|接受|拒绝|修改/);
});
