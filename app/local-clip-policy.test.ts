import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("worker-local CLIP policy fails closed before pipeline or fetch", async (context) => {
  const messages: unknown[] = [];
  let fetchCalls = 0;
  let messageListener: ((event: MessageEvent) => Promise<void>) | undefined;
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  const previousFetch = globalThis.fetch;

  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: {
      addEventListener(type: string, listener: (event: MessageEvent) => Promise<void>) {
        if (type === "message") messageListener = listener;
      },
      postMessage(message: unknown) {
        messages.push(message);
      },
    },
  });
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("remote fetch must not run");
  }) as typeof fetch;

  try {
    const worker = await import("./transcription.worker.ts");

    await context.test("unavailable acquisition never invokes the classifier factory", async () => {
      let pipelineCalls = 0;
      const result = await worker.acquireLocalClipClassifier(async () => {
        pipelineCalls += 1;
        return "unreachable-classifier";
      });

      assert.deepEqual(worker.LOCAL_CLIP_CAPABILITY, {
        available: false,
        code: worker.LOCAL_CLIP_UNAVAILABLE_CODE,
        delivery: "no-approved-local-model-pack",
      });
      assert.deepEqual(result, {
        status: "unavailable",
        code: worker.LOCAL_CLIP_UNAVAILABLE_CODE,
      });
      assert.equal(pipelineCalls, 0);
      assert.equal(fetchCalls, 0);
      assert.equal(Object.isFrozen(result), true);
    });

    await context.test("future approved local pack seam is explicitly local-files-only", async () => {
      let pipelineCalls = 0;
      const result = await worker.acquireLocalClipClassifier(() => {
        pipelineCalls += 1;
        return "local-classifier";
      }, Object.freeze({
        available: true,
        delivery: "approved-local-model-pack",
        localFilesOnly: true,
      }));

      assert.equal(pipelineCalls, 1);
      assert.deepEqual(result, { status: "ready", classifier: "local-classifier" });
      assert.deepEqual(worker.LOCAL_CLIP_PIPELINE_SPEC, {
        task: "zero-shot-image-classification",
        model: "Xenova/clip-vit-base-patch32",
        options: {
          dtype: "q8",
          device: "wasm",
          local_files_only: true,
        },
      });
    });

    await context.test("classification request posts controlled unavailability without model activity", async () => {
      assert.ok(messageListener);
      await messageListener({
        data: {
          type: "classify",
          requestId: "classification-request-a",
          image: "data:image/png;base64,fixture",
          labels: ["medical consultation"],
        },
      } as MessageEvent);

      assert.equal(fetchCalls, 0);
      assert.deepEqual(messages, [{
        type: "classification-unavailable",
        requestId: "classification-request-a",
        code: worker.LOCAL_CLIP_UNAVAILABLE_CODE,
      }]);
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSelf) {
      Object.defineProperty(globalThis, "self", previousSelf);
    } else {
      Reflect.deleteProperty(globalThis, "self");
    }
  }
});

test("CLIP gate remains isolated while Whisper uses only its pinned asset host", () => {
  const workerSource = readFileSync(new URL("./transcription.worker.ts", import.meta.url), "utf8");
  const transcriberStart = workerSource.indexOf("function getTranscriber");
  const classifierStart = workerSource.indexOf("function getClassifier");
  const transcriberSource = workerSource.slice(transcriberStart, classifierStart);

  assert.match(transcriberSource, /"automatic-speech-recognition"/);
  assert.match(transcriberSource, /dtype:\s*"q8"/);
  assert.match(transcriberSource, /device:\s*"wasm"/);
  assert.match(transcriberSource, /env\.remoteHost = assetBase\.href/);
  assert.match(transcriberSource, /env\.remotePathTemplate = "medclip-asr\/\{model\}\/\{revision\}\/"/);
  assert.match(transcriberSource, /revision,/);
  assert.match(transcriberSource, /env\.allowRemoteModels = true/);
  assert.doesNotMatch(transcriberSource, /local_files_only:\s*true/);
  assert.doesNotMatch(transcriberSource, /remoteHost\s*=\s*["']https:\/\/huggingface\.co/);
  assert.doesNotMatch(workerSource.slice(classifierStart), /env\.allowRemoteModels|env\.allowLocalModels|env\.localModelPath/);
});

test("editor distinguishes controlled CLIP unavailability from runtime classification errors", () => {
  const editorSource = readFileSync(new URL("./editor/EditorStudio.tsx", import.meta.url), "utf8");
  assert.match(editorSource, /class LocalClipUnavailableError extends Error/);
  assert.match(editorSource, /message\.type === "classification-unavailable"[\s\S]*pending\.reject\(new LocalClipUnavailableError\(\)\)/);
  assert.match(editorSource, /message\.type === "classification-error"[\s\S]*pending\.reject\(new Error\(message\.message\)\)/);
});
