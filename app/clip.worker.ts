/// <reference lib="webworker" />
import { env, pipeline } from "@huggingface/transformers";
import { CLIP_TEST_ENABLED, CLIP_MODEL_SOURCE } from "./editor-clip-evidence.ts";
const LOCAL_CLIP_PIPELINE_SPEC = { model: CLIP_MODEL_SOURCE.id, task: "zero-shot-image-classification" as const, options: { dtype: "q8" as const, device: "wasm" as const, local_files_only: true } };
type Classifier = (image: string, labels: string[]) => Promise<{
    label: string;
    score: number;
}[]>;
const pipelines = new Map<string, Promise<unknown>>();
function getClassifier(requestId: string) {
    const { model, options, task } = LOCAL_CLIP_PIPELINE_SPEC;
    let instance = pipelines.get(model);
    if (!instance) {
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        if (!env.backends.onnx.wasm)
            throw new Error("ONNX WASM unavailable.");
        env.backends.onnx.wasm.wasmPaths = new URL("/medclip-clip/runtime/", self.location.href).href;
        env.backends.onnx.wasm.numThreads = 1;
        const localModel = "/medclip-clip/" + model + "/" + CLIP_MODEL_SOURCE.revision;
        instance = (pipeline(task, localModel, { ...options, progress_callback: (event: {
                status?: string;
                progress?: number;
            }) => self.postMessage({ type: "classification-progress", requestId, ...event }) }) as Promise<unknown>)
            .then(value => {
            type TensorOutput = Record<string, {
                data: ArrayLike<number>;
                dims: number[];
            }>;
            const cl = value as Classifier & {
                model: {
                    _call: (...args: unknown[]) => Promise<TensorOutput>;
                };
            };
            const original = cl.model._call.bind(cl.model);
            let output: TensorOutput;
            cl.model._call = async (...args) => { output = await original(...args); return output; };
            return async (image: string, labels: string[]) => {
                const result = await cl(image, labels), a = output.image_embeds, b = output.text_embeds, logits = output.logits_per_image;
                if (!a || !b || !logits)
                    throw new Error("CLIP model missing similarity outputs.");
                const d = b.dims[b.dims.length - 1];
                return result.map(p => {
                    const index = labels.indexOf(p.label);
                    let dot = 0, an = 0, bn = 0;
                    for (let k = 0; k < d; k++) {
                        dot += a.data[k] * b.data[index * d + k];
                        an += a.data[k] ** 2;
                        bn += b.data[index * d + k] ** 2;
                    }
                    return { ...p, cosineSimilarity: dot / Math.sqrt(an * bn), logit: logits.data[index], modelSource: CLIP_MODEL_SOURCE };
                });
            };
        }).catch(error => { pipelines.delete(model); throw new Error("本站 CLIP 资源不可用；不会回退海外模型。" + String(error)); });
        pipelines.set(model, instance);
    }
    return instance;
}
self.addEventListener("message", async ({ data }) => { if (data.type !== "classify")
    return; const { requestId, image, labels } = data; if (!CLIP_TEST_ENABLED) {
    self.postMessage({ type: "classification-unavailable", requestId, code: "LOCAL_CLIP_UNAVAILABLE" });
    return;
} try {
    const classifier = await getClassifier(requestId) as Classifier;
    self.postMessage({ type: "classification-running", requestId });
    const results = await classifier(image, labels);
    self.postMessage({ type: "classification-complete", requestId, results });
}
catch (error) {
    self.postMessage({ type: "classification-error", requestId, message: error instanceof Error ? error.message : String(error) });
} });
export {};
