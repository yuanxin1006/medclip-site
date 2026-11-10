import model from "./clip-model.json" with { type: "json" };
export const CLIP_TEST_ENABLED = process.env.NODE_ENV !== "production"
    && process.env.NEXT_PUBLIC_MEDCLIP_CLIP_TEST === "1";
export const CLIP_ANALYSIS_VERSION = "local-clip-medical-concept-evidence-v2";
export const CLIP_MODEL_SOURCE = Object.freeze(model);
export type ClipPrediction = Readonly<{
    label: string;
    score: number;
    cosineSimilarity: number;
    logit: number;
}>;
export type ClipFrameEvidence = Readonly<{
    sourceTimeMs: number;
    image: string;
    predictions: readonly ClipPrediction[];
}>;
export type ClipVisualEvidence = Readonly<{
    model: typeof model;
    frames: readonly ClipFrameEvidence[];
}>;
export function parseClipVisualEvidence(value: unknown, startMs: number, endMs: number): ClipVisualEvidence {
    if (!value || typeof value !== "object")
        throw new Error("Missing CLIP evidence.");
    const v = value as ClipVisualEvidence;
    if (JSON.stringify(v.model) !== JSON.stringify(model) || !Array.isArray(v.frames) || !v.frames.length || v.frames.length > 14)
        throw new Error("Unapproved or unbounded CLIP evidence.");
    const seen = new Set<number>();
    const frames = v.frames.map(f => {
        if (!Number.isSafeInteger(f.sourceTimeMs) || f.sourceTimeMs < startMs || f.sourceTimeMs > endMs || seen.has(f.sourceTimeMs))
            throw new Error("Invalid CLIP source time.");
        seen.add(f.sourceTimeMs);
        if (typeof f.image !== "string" || f.image.length > 400000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(f.image))
            throw new Error("Missing real sampled image.");
        if (!Array.isArray(f.predictions) || !f.predictions.length || f.predictions.length > 32)
            throw new Error("Invalid CLIP predictions.");
        const labels = new Set<string>();
        const predictions = f.predictions.map((p: ClipPrediction) => {
            if (!p.label || p.label.length > 120 || labels.has(p.label) || !Number.isFinite(p.score) || p.score < 0 || p.score > 1 || !Number.isFinite(p.cosineSimilarity) || p.cosineSimilarity < -1.00001 || p.cosineSimilarity > 1.00001 || !Number.isFinite(p.logit))
                throw new Error("Invalid CLIP concept score.");
            labels.add(p.label);
            return Object.freeze({ ...p });
        });
        return Object.freeze({ ...f, predictions: Object.freeze(predictions) });
    });
    return Object.freeze({ model: Object.freeze({ ...model }), frames: Object.freeze(frames) });
}
// Scores are relative to the fixed candidate set, never calibrated accuracy.
// Only this concept's frame scores contribute, with a consensus discount.
export function clipConceptScore(evidence: ClipVisualEvidence, label: string): number {
    const frames = evidence.frames, mean = frames.reduce((s, f) => s + (f.predictions.find(p => p.label === label)?.score ?? 0), 0) / frames.length;
    const dominant = frames.filter(f => [...f.predictions].sort((a, b) => b.score - a.score)[0]?.label === label).length / frames.length;
    return Math.round(mean * dominant * 1000000) / 1000000;
}
export function clipReviewReasons(evidence: ClipVisualEvidence): readonly string[] {
    const reasons = ["需要人工确认：相似度不是医学事实或准确率。"];
    for (const f of evidence.frames) {
        const p = [...f.predictions].sort((a, b) => b.score - a.score);
        if (p[0].score < .5)
            reasons.push("部分取样帧支持较弱");
        if (p[1] && p[0].score - p[1].score < .15)
            reasons.push("存在相近候选");
        if (p.slice(0, 2).some(x => /talking|shaking|physical examination/.test(x.label)))
            reasons.push("问诊、握手或查体容易混淆，请查看原帧");
    }
    return [...new Set(reasons)];
}
