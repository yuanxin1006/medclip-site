import assert from "node:assert/strict";
import test from "node:test";
import { CLIP_MODEL_SOURCE, CLIP_ANALYSIS_VERSION, clipConceptScore, parseClipVisualEvidence, clipReviewReasons } from "./editor-clip-evidence.ts";
import { parseVideoSemanticAnalysis } from "./editor-video-semantic.ts";
import { rankMultimodalCandidates } from "./editor-multimodal-matching.ts";
// Contract fixtures exercise score isolation only; they are not inference evidence.
const doctor = "a doctor talking with a patient in a clinic", exam = "a clinician performing a physical examination of a patient";
const evidence = { model: CLIP_MODEL_SOURCE, frames: [100, 500, 900].map(sourceTimeMs => ({ sourceTimeMs, image: "data:image/jpeg;base64,/9j/AA==", predictions: [{ label: doctor, score: .95, cosineSimilarity: .3, logit: 30 }, { label: exam, score: .02, cosineSimilarity: .2, logit: 20 }] })) };
test("low concept cannot borrow dominant concept confidence in formal matching", () => {
    const semanticSegments = [{ id: "s", assetId: "a", startMs: 0, endMs: 1000, summary: "contract only", concepts: ["医生问诊", "体格检查"], usability: .5, confidence: .95, evidenceFrameMs: [100, 500, 900], visualEvidence: evidence }];
    const run = (concept: string) => rankMultimodalCandidates({ interval: { id: "cue", timelineStartMs: 0, timelineEndMs: 1000, text: "contract", concepts: [concept] }, assets: [{ assetId: "a", sourceDurationMs: 1000, semanticSegments }] });
    assert.equal(run("体格检查").candidates[0].semanticScore, 0);
    assert.equal(run("体格检查").selectedAssetId, undefined);
    assert.equal(run("体格检查").candidates[0].supportingSourceRanges.length,0);
    assert.equal(run("医生问诊").candidates[0].semanticScore, .95);
    assert.equal(clipConceptScore(evidence, exam), 0);
});
test("frame score consensus never combines different concept maxima", () => {
    const e = { ...evidence, frames: evidence.frames.map((f, i) => ({ ...f, predictions: f.predictions.map(p => ({ ...p, score: p.label === doctor ? (i === 0 ? .9 : .1) : (i === 0 ? .1 : .9) })) })) };
    assert.ok(clipConceptScore(e, doctor) < .2);
    assert.ok(clipConceptScore(e, exam) < .5);
});
test("fixed provenance, samples, similarity and source range are mandatory", () => {
    assert.deepEqual(parseClipVisualEvidence(evidence, 0, 1000), evidence);
    assert.throws(() => parseClipVisualEvidence({ ...evidence, model: { ...CLIP_MODEL_SOURCE, revision: "main" } }, 0, 1000));
    assert.throws(() => parseClipVisualEvidence({ ...evidence, frames: [{ ...evidence.frames[0], sourceTimeMs: 2000 }] }, 0, 1000));
    assert.throws(() => parseClipVisualEvidence({ ...evidence, frames: [{ ...evidence.frames[0], image: "filename.mp4" }] }, 0, 1000));
    assert.throws(() => parseClipVisualEvidence({ ...evidence, frames: [{ ...evidence.frames[0], predictions: [{ ...evidence.frames[0].predictions[0], cosineSimilarity: NaN }] }] }, 0, 1000));
});
test("current analysis cannot silently accept legacy evidence or filename fallback", () => {
    const a = { schemaVersion: 1, assetId: "a", assetDurationMs: 1000, segments: [{ id: "s", assetId: "a", startMs: 0, endMs: 1000, summary: "contract", concepts: ["医生问诊"], usability: .5, confidence: .95, evidenceFrameMs: [100] }], analysisMethod: "local-clip", createdAt: "2026-11-08T00:00:00.000Z", analysisVersion: CLIP_ANALYSIS_VERSION };
    assert.throws(() => parseVideoSemanticAnalysis(a));
    assert.throws(() => parseVideoSemanticAnalysis({ ...a, analysisMethod: "filename-fallback" }));
});
test("review warning never describes similarity as calibrated accuracy", () => {
    assert.ok(clipReviewReasons(evidence).some(s => s.includes("需要人工确认")));
    const close = { ...evidence, frames: evidence.frames.map(f => ({ ...f, predictions: f.predictions.map(p => ({ ...p, score: .49 })) })) };
    assert.ok(clipReviewReasons(close).some(s => s.includes("相近候选")));
});
test("disabled visual worker makes no model requests and does not change Whisper runtime settings", async () => {
    const { env } = await import("@huggingface/transformers");
    const initial = { remote: env.allowRemoteModels, local: env.allowLocalModels, wasmPath: env.backends.onnx.wasm?.wasmPaths };
    const previousSelf = globalThis.self, previousFetch = globalThis.fetch;
    let calls = 0, handler: ((e: {
        data: unknown;
    }) => Promise<unknown>) | undefined;
    const messages: unknown[] = [];
    Object.assign(globalThis, { self: { location: { href: "http://127.0.0.1/" }, addEventListener: (_type: string, cb: typeof handler) => { handler = cb; }, postMessage: (m: unknown) => messages.push(m) } });
    globalThis.fetch = (...args) => { calls++; return previousFetch(...args); };
    try {
        await import("./clip.worker.ts");
        await handler!({ data: { type: "classify", requestId: "guard-test", image: "contract-only", labels: ["contract"] } });
        assert.equal(calls, 0);
        assert.deepEqual(messages, [{ type: "classification-unavailable", requestId: "guard-test", code: "LOCAL_CLIP_UNAVAILABLE" }]);
        assert.deepEqual({ remote: env.allowRemoteModels, local: env.allowLocalModels, wasmPath: env.backends.onnx.wasm?.wasmPaths }, initial);
    }
    finally {
        globalThis.self = previousSelf;
        globalThis.fetch = previousFetch;
    }
});
