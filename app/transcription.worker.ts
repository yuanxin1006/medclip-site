/// <reference lib="webworker" />

import { env, pipeline } from "@huggingface/transformers";
import whisperRevisions from "./whisper-models.json" with { type: "json" };
import {
  createIntegrityCheckingFetch,
  ONNX_RUNTIME_ASSET_DIRECTORY,
  resolveMedclipAssetBase,
  verifyRuntimeModule,
} from "./medclip-assets.ts";

export const LOCAL_CLIP_UNAVAILABLE_CODE = "LOCAL_CLIP_UNAVAILABLE" as const;

export type LocalClipCapability = Readonly<
  | {
      available: false;
      code: typeof LOCAL_CLIP_UNAVAILABLE_CODE;
      delivery: "no-approved-local-model-pack";
    }
  | {
      available: true;
      delivery: "approved-local-model-pack";
      localFilesOnly: true;
    }
>;

// Public beta policy: model-weight redistribution has not been cleared and no
// approved local model pack is installed. This must never be inferred from
// network reachability or changed by probing a remote model registry.
export const LOCAL_CLIP_CAPABILITY: LocalClipCapability = Object.freeze({
  available: false,
  code: LOCAL_CLIP_UNAVAILABLE_CODE,
  delivery: "no-approved-local-model-pack",
});

// When an approved pack is added, the existing loader seam remains local-only.
// Missing files must fail closed rather than fall back to a model host.
export const LOCAL_CLIP_PIPELINE_SPEC = Object.freeze({
  task: "zero-shot-image-classification" as const,
  model: "Xenova/clip-vit-base-patch32" as const,
  options: Object.freeze({
    dtype: "q8" as const,
    device: "wasm" as const,
    local_files_only: true as const,
  }),
});

export type LocalClipAcquisition<T> =
  | Readonly<{
      status: "unavailable";
      code: typeof LOCAL_CLIP_UNAVAILABLE_CODE;
    }>
  | Readonly<{
      status: "ready";
      classifier: T;
    }>;

export async function acquireLocalClipClassifier<T>(
  createClassifier: () => T | Promise<T>,
  capability: LocalClipCapability = LOCAL_CLIP_CAPABILITY,
): Promise<LocalClipAcquisition<T>> {
  if (!capability.available) {
    return Object.freeze({
      status: "unavailable",
      code: capability.code,
    });
  }

  return Object.freeze({
    status: "ready",
    classifier: await createClassifier(),
  });
}

type TranscriptionRequest = {
  type: "transcribe";
  requestId: string;
  model: string;
  audio: Float32Array;
  prompt?: string;
  timestampRetry?: boolean;
};

type ClassificationRequest = {
  type: "classify";
  requestId: string;
  image: string;
  labels: string[];
};

type TranscriptionOutput = {
  text?: string;
  chunks?: Array<{
    text?: string;
    timestamp?: [number | null, number | null];
  }>;
};

type Transcriber = ((
  input: Float32Array,
  options: Record<string, unknown>
) => Promise<TranscriptionOutput>) & {
  tokenizer?: {
    encode: (text: string) => number[];
  };
};

type Classifier = (
  input: string,
  labels: string[]
) => Promise<Array<{ label: string; score: number }>>;

const pipelines = new Map<string, Promise<unknown>>();

let integrityBaseHref: string | null = null;
let integrityOriginalFetch: typeof fetch | null = null;
let integrityFetch: typeof fetch | null = null;

function configureIntegrityFetch(assetBase: URL) {
  if (integrityBaseHref && integrityBaseHref !== assetBase.href) {
    throw new Error("同一识别 Worker 不允许切换资源基址。");
  }
  if (integrityFetch) {
    return {
      fetch: integrityFetch,
      restore() {},
    };
  }

  const original = globalThis.fetch.bind(globalThis);
  const checked = createIntegrityCheckingFetch(original, assetBase);
  globalThis.fetch = checked;
  integrityBaseHref = assetBase.href;
  integrityOriginalFetch = original;
  integrityFetch = checked;

  return {
    fetch: checked,
    restore() {
      if (globalThis.fetch === checked && integrityOriginalFetch) {
        globalThis.fetch = integrityOriginalFetch;
      }
      integrityBaseHref = null;
      integrityOriginalFetch = null;
      integrityFetch = null;
    },
  };
}

function getTranscriber(model: string, requestId: string) {
  let instance = pipelines.get(model);
  if (!instance) {
    if (!Object.hasOwn(whisperRevisions, model)) throw new Error("不支持此字幕识别模型。");
    const revision = whisperRevisions[model as keyof typeof whisperRevisions];
    const assetBase = resolveMedclipAssetBase(
      process.env.NEXT_PUBLIC_MEDCLIP_ASSET_BASE_URL,
      self.location.href,
      process.env.NODE_ENV === "production",
    );
    const assetRoot = new URL("medclip-asr/", assetBase);
    const runtimeRoot = new URL(ONNX_RUNTIME_ASSET_DIRECTORY, assetRoot);
    const runtimeModuleUrl = new URL(
      "ort-wasm-simd-threaded.jsep.mjs",
      runtimeRoot,
    ).href;

    // Transformers.js 3.8.1 only applies localModelPath to repository-style
    // model IDs. Keep the canonical model ID and route its pinned revision to
    // the explicitly configured asset host instead of passing a synthetic
    // multi-segment path that is treated as a missing local filesystem file.
    env.allowRemoteModels = true;
    env.allowLocalModels = true;
    // Disable Transformers CacheStorage so every resource passes through the
    // SHA-256 verifier. The browser HTTP cache remains available for immutable URLs.
    env.useBrowserCache = false;
    env.useFSCache = false;
    env.useCustomCache = false;

    const wasm = env.backends.onnx.wasm;
    if (!wasm) throw new Error("当前浏览器无法使用 ONNX WebAssembly。");
    wasm.wasmPaths = runtimeRoot.href;
    wasm.numThreads = 1;

    // These are the only remote endpoints Transformers is allowed to use.
    // Do not use the default Hugging Face host or a floating `main` revision.
    env.remoteHost = assetBase.href;
    env.remotePathTemplate = "medclip-asr/{model}/{revision}/";
    const integrity = configureIntegrityFetch(assetBase);

    instance = (async () => {
      await verifyRuntimeModule(integrity.fetch, runtimeModuleUrl);
      return await pipeline(
        "automatic-speech-recognition",
        model,
        {
          revision,
          dtype: "q8",
          device: "wasm",
          progress_callback: (event: { status?: string; progress?: number }) => {
            self.postMessage({
              type: "model-progress",
              requestId,
              status: event.status,
              progress: event.progress,
            });
          },
        },
      ) as unknown;
    })().catch((error) => {
      // A rejected cached promise makes every later retry fail immediately.
      pipelines.delete(model);
      integrity.restore();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        "无法加载或校验配置的 MedClip Whisper/ONNX 资源。请检查资源基址、CORS、MIME 和固定 SHA-256；不会回退到公共 CDN。 " +
          detail,
        { cause: error },
      );
    });
    pipelines.set(model, instance);
  }
  return instance;
}
function getClassifier(requestId: string) {
  const { model, options, task } = LOCAL_CLIP_PIPELINE_SPEC;
  let instance = pipelines.get(model);
  if (!instance) {
    instance = pipeline(
      task,
      model,
      {
        ...options,
        progress_callback: (event: { status?: string; progress?: number }) => {
          self.postMessage({
            type: "classification-progress",
            requestId,
            status: event.status,
            progress: event.progress
          });
        }
      }
    ) as Promise<unknown>;
    pipelines.set(model, instance);
  }
  return instance;
}

self.addEventListener("message", async (
  event: MessageEvent<TranscriptionRequest | ClassificationRequest>
) => {
  if (event.data.type === "transcribe") {
    const { requestId, model, audio, prompt, timestampRetry } = event.data;
    let stage = "loading-model";
    try {
      const transcriber = await getTranscriber(model, requestId) as Transcriber;
      self.postMessage({ type: "running", requestId });
      stage = "recognizing";
      const options: Record<string, unknown> = {
        language: "zh",
        task: "transcribe",
        // Restore the first released recognition behavior (6f576de): ask
        // Whisper for complete phrase/segment text and its acoustic range.
        // Word chunks made the displayed Chinese text fragmented even though
        // they offered finer-grained timing.
        return_timestamps: true,
        chunk_length_s: timestampRetry ? 20 : 24,
        stride_length_s: timestampRetry ? 3 : 4,
        force_full_sequences: Boolean(timestampRetry)
      };
      const promptIds = prompt?.trim() && transcriber.tokenizer
        ? transcriber.tokenizer.encode(prompt.trim()).slice(-224)
        : [];
      if (promptIds.length) options.prompt_ids = promptIds;
      const output = await transcriber(audio, options);
      self.postMessage({ type: "complete", requestId, output });
    } catch (error) {
      self.postMessage({
        type: "error",
        requestId,
        stage,
        message: error instanceof Error ? error.message : "音频识别失败",
        stack: error instanceof Error ? error.stack : undefined
      });
    }
    return;
  }

  const { requestId, image, labels } = event.data;
  try {
    const acquisition = await acquireLocalClipClassifier(
      () => getClassifier(requestId) as Promise<Classifier>,
    );
    if (acquisition.status === "unavailable") {
      self.postMessage({
        type: "classification-unavailable",
        requestId,
        code: acquisition.code,
      });
      return;
    }
    const classifier = acquisition.classifier;
    self.postMessage({ type: "classification-running", requestId });
    const results = await classifier(image, labels);
    self.postMessage({ type: "classification-complete", requestId, results });
  } catch (error) {
    self.postMessage({
      type: "classification-error",
      requestId,
      message: error instanceof Error ? error.message : "视频画面识别失败"
    });
  }
});

export {};

