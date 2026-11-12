import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCEPTANCE_INPUT_HYDRATION_BUILD_ENABLED,
  hydrateAcceptanceEditorInputEvidenceV1,
  parseAcceptanceEditorInputEvidenceV1,
} from "./editor-acceptance-input-hydration.ts";
import { VideoSemanticAnalysisCache } from "./editor-video-semantic.ts";
import { createMedicalReviewInput } from "./test-support/editor-proposal-review-fixture.ts";

function validFixture() {
  const input = createMedicalReviewInput();
  return {
    input,
    payload: {
      version: 1 as const,
      semanticEvidence: input.videoAnalyses,
      rhythmEvidence: input.rhythm,
    },
  };
}

test("normal build flag defaults off and payload cannot hydrate", () => {
  assert.equal(ACCEPTANCE_INPUT_HYDRATION_BUILD_ENABLED, false);
  const { input, payload } = validFixture();
  const cache = new VideoSemanticAnalysisCache();
  const result = hydrateAcceptanceEditorInputEvidenceV1({ payload, project: input.project, semanticCache: cache });
  assert.equal(result.status, "DISABLED");
  assert.equal(cache.size, 0);
});

test("acceptance build without an explicit payload does not hydrate", () => {
  const { input } = validFixture();
  const cache = new VideoSemanticAnalysisCache();
  const result = hydrateAcceptanceEditorInputEvidenceV1({ buildEnabled: true, payload: undefined, project: input.project, semanticCache: cache });
  assert.equal(result.status, "NO_PAYLOAD");
  assert.equal(cache.size, 0);
});

test("valid acceptance payload atomically hydrates semantic cache and returns rhythm evidence", () => {
  const { input, payload } = validFixture();
  const beforeProject = structuredClone(input.project);
  const cache = new VideoSemanticAnalysisCache();
  const result = hydrateAcceptanceEditorInputEvidenceV1({ buildEnabled: true, payload, project: input.project, semanticCache: cache });
  assert.equal(result.status, "HYDRATED");
  assert.equal(result.semanticAssetCount, input.videoAnalyses.length);
  assert.deepEqual(result.rhythmEvidence, input.rhythm);
  assert.equal(cache.size, input.videoAnalyses.length);
  assert.deepEqual(input.project, beforeProject);
  assert.deepEqual(input.project.captions, beforeProject.captions);
});

test("malformed semantic or rhythm evidence fails closed without partial hydration", () => {
  const { input, payload } = validFixture();
  for (const malformed of [
    { ...payload, semanticEvidence: [{ ...payload.semanticEvidence[0], assetDurationMs: -1 }, ...payload.semanticEvidence.slice(1)] },
    { ...payload, rhythmEvidence: { ...payload.rhythmEvidence, sourceDurationMs: 9_999 } },
  ]) {
    const cache = new VideoSemanticAnalysisCache();
    const result = hydrateAcceptanceEditorInputEvidenceV1({ buildEnabled: true, payload: malformed, project: input.project, semanticCache: cache });
    assert.equal(result.status, "REJECTED");
    assert.equal(result.category, "INVALID_PAYLOAD");
    assert.equal(cache.size, 0);
    assert.equal(result.rhythmEvidence, undefined);
  }
});

test("unknown fields and every downstream state family are rejected", () => {
  const { input, payload } = validFixture();
  const attempts = [
    { ...payload, unknown: true },
    { ...payload, proposal: {} },
    { ...payload, evaluatorResult: {} },
    { ...payload, repairProposal: {} },
    { ...payload, semanticEvidence: [{ ...payload.semanticEvidence[0], defects: [] }, ...payload.semanticEvidence.slice(1)] },
  ];
  for (const attempt of attempts) {
    const cache = new VideoSemanticAnalysisCache();
    const result = hydrateAcceptanceEditorInputEvidenceV1({ buildEnabled: true, payload: attempt, project: input.project, semanticCache: cache });
    assert.equal(result.status, "REJECTED");
    assert.equal(cache.size, 0);
  }
});

test("payload must exactly cover canonical project asset identities and durations", () => {
  const { input, payload } = validFixture();
  assert.throws(() => parseAcceptanceEditorInputEvidenceV1({
    ...payload,
    semanticEvidence: payload.semanticEvidence.slice(1),
  }, input.project), /exactly cover/);
});

test("acceptance hook is one-time and refuses to overwrite an existing cache", () => {
  const { input, payload } = validFixture();
  const cache = new VideoSemanticAnalysisCache();
  assert.equal(hydrateAcceptanceEditorInputEvidenceV1({ buildEnabled: true, payload, project: input.project, semanticCache: cache }).status, "HYDRATED");
  const second = hydrateAcceptanceEditorInputEvidenceV1({ buildEnabled: true, payload, project: input.project, semanticCache: cache });
  assert.equal(second.status, "REJECTED");
  assert.equal(second.category, "CACHE_NOT_EMPTY");
  assert.equal(cache.size, input.videoAnalyses.length);
});
