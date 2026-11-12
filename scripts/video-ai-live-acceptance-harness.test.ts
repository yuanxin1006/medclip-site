import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAIEditingPlan,
  createSafeEditorAIContext,
} from "../app/editor-ai-requirements.ts";
import type { EditorProject } from "../app/editor-core.ts";
import {
  buildOwnedAssetAcceptanceFixtureThroughEditor,
  type OwnedAssetFixturePageLike,
} from "./video-ai-owned-asset-fixture.ts";
import {
  AI_TASKS_PATH_SUFFIX,
  VIDEO_AI_ERROR_SELECTOR,
  VIDEO_AI_SUCCESS_SELECTOR,
  createAITaskNetworkTracker,
  inspectPreLiveSafeEditorContext,
  readEditorSpecificSurface,
  runExactlyOnceVideoAILiveAcceptance,
  summarizeAITaskResponse,
} from "./video-ai-live-acceptance-harness.ts";
import { REORDER_TIMED_SUBTITLE_FIXTURE } from "./video-ai-reorder-subtitle-fixture.ts";

const DISPOSABLE_ASSET_ID = "asset-v14f-owned";
const DISPOSABLE_CLIP_ID = "clip-v14f-first";

function disposableProject(): EditorProject {
  return {
    schemaVersion: 2,
    id: "project-v14f-disposable",
    title: "V1.4F owned-asset fixture",
    updatedAt: "2026-10-19T00:00:00.000Z",
    durationMs: 4_200,
    ratio: "16:9",
    audioSelection: {
      mode: "full",
      sourceDurationMs: 4_200,
      sourceInMs: 0,
      sourceOutMs: 4_200,
      selectedDurationMs: 4_200,
    },
    assets: [{
      id: DISPOSABLE_ASSET_ID,
      name: "v14f-disposable.mp4",
      kind: "视频",
      durationMs: 4_200,
    }],
    tracks: [
      {
        id: "video-main",
        type: "video",
        name: "主视频",
        clips: [{
          id: DISPOSABLE_CLIP_ID,
          assetId: DISPOSABLE_ASSET_ID,
          name: "v14f-disposable.mp4",
          kind: "视频",
          trackId: "video-main",
          timelineStartMs: 0,
          timelineEndMs: 4_200,
          sourceInMs: 0,
          sourceOutMs: 4_200,
          transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
          speedCurve: [
            { id: "speed-start", at: 0, rate: 1 },
            { id: "speed-end", at: 1, rate: 1 },
          ],
          reason: "Provider-free owned-asset acceptance fixture.",
        }],
      },
      { id: "audio-main", type: "audio", name: "主音频", clips: [], locked: true },
      { id: "broll", type: "broll", name: "B-roll", clips: [] },
      { id: "captions", type: "captions", name: "字幕", clips: [] },
    ],
    captions: [{ id: "caption-v14f", text: "一次性验收字幕。", startMs: 0, endMs: 4_200 }],
  };
}

function registeredOwnedAssetIds() {
  // Production EditorStudio derives ownership from the current in-memory
  // uploaded assets array, not from restored project metadata.
  const uploadedAssetState = [{ id: DISPOSABLE_ASSET_ID, name: "v14f-disposable.mp4" }];
  return new Set(uploadedAssetState.map((asset) => asset.id));
}

function safePreLiveInput(ownedAssetIds = registeredOwnedAssetIds()) {
  return {
    serializedContext: createSafeEditorAIContext(disposableProject(), ownedAssetIds, 4_200),
    expectedClipId: DISPOSABLE_CLIP_ID,
    expectedAssetId: DISPOSABLE_ASSET_ID,
  };
}

function safeSuccessResponse() {
  return summarizeAITaskResponse(200, true, {
    ok: true,
    requestId: "safe-request-id",
    result: {
      data: {
        summary: "已调整第一片段速度。",
        actions: [{
          type: "SET_CLIP_PLAYBACK_SPEED",
          targetId: "clip-1",
          assetId: "",
          playbackRate: 1.25,
          reason: "Apply requested speed.",
        }],
        unsupported: [],
        warnings: [],
      },
    },
  });
}

test("delayed success ignores a pre-existing empty global alert and captures response before editor state", async () => {
  const events: string[] = [];
  let requestCount = 0;
  let surfaceReads = 0;
  const result = await runExactlyOnceVideoAILiveAcceptance({
    timeoutMs: 500,
    pollIntervalMs: 1,
    getRequestCount: () => requestCount,
    readPreLiveSafeContext: async () => { events.push("prelive"); return safePreLiveInput(); },
    submitOnce: async () => { requestCount += 1; events.push("submit"); },
    waitForResponse: async () => {
      events.push("response-observer");
      await new Promise((resolve) => setTimeout(resolve, 15));
      events.push("response");
      return safeSuccessResponse();
    },
    readEditorSurface: async () => {
      surfaceReads += 1;
      // An unrelated global role=alert exists throughout but is intentionally
      // absent from this editor-scoped snapshot.
      if (surfaceReads < 3) return { successVisible: false, successText: "", errorVisible: false, errorText: "" };
      events.push("editor-success");
      return { successVisible: true, successText: "AI 已安全应用 1 项剪辑操作", errorVisible: false, errorText: "" };
    },
    captureEditorState: async () => { events.push("state"); return { playbackRate: 1.25 }; },
  });
  assert.equal(result.result, "SUCCESS");
  assert.equal(result.actionClickCount, 1);
  assert.equal(result.requestCount, 1);
  assert.equal(result.responseReceived, true);
  assert.equal(result.preLiveContext.eligible, true);
  assert.deepEqual(result.editorState, { playbackRate: 1.25 });
  assert.ok(events.indexOf("response-observer") < events.indexOf("prelive"));
  assert.ok(events.indexOf("response-observer") < events.indexOf("submit"));
  assert.ok(events.indexOf("response") < events.indexOf("editor-success"));
  assert.ok(events.indexOf("editor-success") < events.indexOf("state"));
});

test("delayed Edge failure captures response first and then a non-empty editor-specific error", async () => {
  let requestCount = 0;
  let reads = 0;
  const result = await runExactlyOnceVideoAILiveAcceptance({
    timeoutMs: 500,
    pollIntervalMs: 1,
    getRequestCount: () => requestCount,
    readPreLiveSafeContext: async () => safePreLiveInput(),
    submitOnce: async () => { requestCount += 1; },
    waitForResponse: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return summarizeAITaskResponse(502, true, { ok: false, error: { code: "PROVIDER_HTTP_ERROR" } });
    },
    readEditorSurface: async () => {
      reads += 1;
      return reads < 2
        ? { successVisible: false, successText: "", errorVisible: true, errorText: "" }
        : { successVisible: false, successText: "", errorVisible: true, errorText: "暂时无法理解该剪辑需求，请稍后重试或手动调整。" };
    },
    captureEditorState: async () => ({ unchanged: true }),
  });
  assert.equal(result.result, "ERROR");
  assert.equal(result.response?.httpStatus, 502);
  assert.equal(result.response?.errorCode, "PROVIDER_HTTP_ERROR");
  assert.equal(result.editorOutcome?.kind, "error");
  assert.equal(result.actionClickCount, 1);
  assert.equal(requestCount, 1);
});

test("response timeout retains dispatch evidence and never retries or reads a global alert", async () => {
  let clickCount = 0;
  let requestCount = 0;
  let editorReadCount = 0;
  const result = await runExactlyOnceVideoAILiveAcceptance({
    timeoutMs: 20,
    pollIntervalMs: 1,
    getRequestCount: () => requestCount,
    readPreLiveSafeContext: async () => safePreLiveInput(),
    submitOnce: async () => { clickCount += 1; requestCount += 1; },
    waitForResponse: () => new Promise(() => undefined),
    readEditorSurface: async () => {
      editorReadCount += 1;
      return { successVisible: false, successText: "", errorVisible: false, errorText: "" };
    },
    captureEditorState: async () => ({ shouldNotRun: true }),
  });
  assert.equal(result.result, "TIMEOUT");
  assert.equal(result.timeoutStage, "ai_tasks_response");
  assert.equal(result.requestDispatched, true);
  assert.equal(result.responseReceived, false);
  assert.equal(result.actionClickCount, 1);
  assert.equal(clickCount, 1);
  assert.equal(requestCount, 1);
  assert.equal(editorReadCount, 0);
});

test("real uploaded-asset registry contract includes the first disposable clip in the exact safe context", () => {
  const input = safePreLiveInput();
  const serialized = input.serializedContext;
  const context = JSON.parse(serialized) as {
    assets: Array<{ id: string }>;
    clips: Array<{
      id: string;
      assetId: string;
      kind: string;
      positionScaleEligible: boolean;
      timelineDurationSeconds: number;
      playbackRate: number;
      x: number;
      y: number;
      scale: number;
    }>;
  };
  const evidence = inspectPreLiveSafeEditorContext(input);
  assert.deepEqual(context.assets.map((asset) => asset.id), [DISPOSABLE_ASSET_ID]);
  assert.equal(context.clips.length, 1);
  assert.deepEqual(context.clips[0], {
    id: DISPOSABLE_CLIP_ID,
    trackId: "video-main",
    assetId: DISPOSABLE_ASSET_ID,
    kind: "视频",
    positionScaleEligible: true,
    startSeconds: 0,
    endSeconds: 4.2,
    timelineDurationSeconds: 4.2,
    playbackRate: 1,
    x: 0,
    y: 0,
    scale: 1,
  });
  assert.equal(evidence.eligible, true);
  assert.equal(evidence.firstClipMatchesExpectedTarget, true);
  assert.equal(evidence.privateMediaReferencePresent, false);
  assert.equal(/(?:https?:\/\/|blob:|data:)/i.test(serialized), false);
});

test("acceptance fixture registers disposable media through the production file inputs before building safe context", async () => {
  const actions: string[] = [];
  let manualSubtitleMode = false;
  let subtitleReady = false;
  let consentReady = false;
  let generateReady = false;
  const project = disposableProject();
  project.durationMs = 3_000;
  project.audioSelection = {
    mode: "full",
    sourceDurationMs: 3_000,
    sourceInMs: 0,
    sourceOutMs: 3_000,
    selectedDurationMs: 3_000,
  };
  project.assets = ["A", "B", "C"].map((label, index) => ({
    id: index === 0 ? DISPOSABLE_ASSET_ID : `asset-v15t-${label.toLowerCase()}`,
    name: `medclip-reorder-${label}.mp4`,
    kind: "\u89c6\u9891",
    durationMs: 6_000,
  }));
  const videoTrack = project.tracks.find((track) => track.type === "video")!;
  const clipTemplate = videoTrack.clips[0];
  videoTrack.clips = project.assets.map((asset, index) => ({
    ...structuredClone(clipTemplate),
    id: index === 0 ? DISPOSABLE_CLIP_ID : `clip-v15t-${index + 1}`,
    assetId: asset.id,
    name: asset.name,
    timelineStartMs: index * 1_000,
    timelineEndMs: (index + 1) * 1_000,
    sourceInMs: 0,
    sourceOutMs: 1_000,
  }));
  const serializedProject = JSON.stringify(project);
  const makeLocator = (description: string): ReturnType<OwnedAssetFixturePageLike["locator"]> => ({
    nth(index) { return makeLocator(`${description}:nth(${index})`); },
    async setInputFiles(file) { actions.push(`upload:${description}:${file.name}`); },
    async waitFor() { actions.push(`visible:${description}`); },
    async click() {
      actions.push(`click:${description}`);
      if (description === ".subtitle-source-tabs button:nth(1)") manualSubtitleMode = true;
      if (description === "button.generate-button") generateReady = manualSubtitleMode && subtitleReady && consentReady;
    },
    async fill(value) {
      actions.push(`fill:${description}`);
      if (description === 'textarea[aria-label="字幕文本"]') subtitleReady = value.includes("-->");
    },
    async isChecked() { return false; },
    async check() { actions.push(`check:${description}`); consentReady = true; },
  });
  const page: OwnedAssetFixturePageLike = {
    locator(selector, options) {
      return makeLocator(options?.hasText ? `${selector}[${options.hasText}]` : selector);
    },
    async waitForFunction() {
      actions.push("waitForFunction");
      if (actions.filter((action) => action === "waitForFunction").length === 1) {
        assert.equal(manualSubtitleMode && subtitleReady && consentReady, true);
      }
    },
    async evaluate<T>() { return serializedProject as T; },
  };
  const fixture = await buildOwnedAssetAcceptanceFixtureThroughEditor(page, {
    video: { name: "medclip-reorder-A.mp4", mimeType: "video/mp4", buffer: new Uint8Array([0]) },
    additionalVideos: [
      { name: "medclip-reorder-B.mp4", mimeType: "video/mp4", buffer: new Uint8Array([0]) },
      { name: "medclip-reorder-C.mp4", mimeType: "video/mp4", buffer: new Uint8Array([0]) },
    ],
    audio: { name: "v14f-disposable.wav", mimeType: "audio/wav", buffer: new Uint8Array([0]) },
    subtitleText: REORDER_TIMED_SUBTITLE_FIXTURE,
  });
  assert.ok(actions.includes('upload:input[accept^="video/"]:medclip-reorder-A.mp4'));
  assert.ok(actions.includes('visible:.asset-row[medclip-reorder-A.mp4]'));
  assert.ok(actions.includes('upload:input[accept^="video/"]:medclip-reorder-B.mp4'));
  assert.ok(actions.includes('visible:.asset-row[medclip-reorder-B.mp4]'));
  assert.ok(actions.includes('upload:input[accept^="video/"]:medclip-reorder-C.mp4'));
  assert.ok(actions.includes('visible:.asset-row[medclip-reorder-C.mp4]'));
  assert.ok(actions.includes('upload:input[accept="audio/*"]:v14f-disposable.wav'));
  assert.ok(actions.includes('visible:.audio-card[v14f-disposable.wav]'));
  assert.ok(actions.includes("click:.subtitle-source-tabs button:nth(1)"));
  assert.ok(actions.includes("click:button.generate-button"));
  assert.equal(manualSubtitleMode, true);
  assert.equal(subtitleReady, true);
  assert.equal(consentReady, true);
  assert.equal(generateReady, true);
  assert.equal(fixture.registeredAsset.id, DISPOSABLE_ASSET_ID);
  assert.equal(inspectPreLiveSafeEditorContext(fixture.preLiveContext).eligible, true);
});

test("localStorage-only pseudo-project remains excluded and the pre-live gate dispatches nothing", async () => {
  const input = safePreLiveInput(new Set());
  const evidence = inspectPreLiveSafeEditorContext(input);
  assert.equal(evidence.eligible, false);
  assert.equal(evidence.clipCount, 0);
  assert.equal(evidence.expectedTargetPresent, false);
  let clickCount = 0;
  let responseObserverCount = 0;
  let providerRequestCount = 0;
  const result = await runExactlyOnceVideoAILiveAcceptance({
    timeoutMs: 500,
    getRequestCount: () => providerRequestCount,
    readPreLiveSafeContext: async () => input,
    submitOnce: async () => { clickCount += 1; providerRequestCount += 1; },
    waitForResponse: async () => {
      responseObserverCount += 1;
      throw new Error("Observer is armed before the gate, without dispatching a request.");
    },
    readEditorSurface: async () => ({ successVisible: false, successText: "", errorVisible: false, errorText: "" }),
    captureEditorState: async () => ({ shouldNotRun: true }),
  });
  assert.equal(result.result, "PRELIVE_BLOCKED");
  assert.equal(result.actionClickCount, 0);
  assert.equal(result.requestCount, 0);
  assert.equal(result.requestDispatched, false);
  assert.equal(clickCount, 0);
  assert.equal(responseObserverCount, 1);
  assert.equal(providerRequestCount, 0);
});

test("pre-live gate fails closed when a nominal target context contains a private media reference", () => {
  const input = safePreLiveInput();
  const unsafe = JSON.parse(input.serializedContext) as Record<string, unknown>;
  unsafe.previewUrl = "blob:private-media-reference";
  const evidence = inspectPreLiveSafeEditorContext({
    ...input,
    serializedContext: JSON.stringify(unsafe),
  });
  assert.equal(evidence.privateMediaReferencePresent, true);
  assert.equal(evidence.eligible, false);
});

test("owned-context canonical SPLIT_CLIP applies deterministically with preview-compatible child state", () => {
  const source = disposableProject();
  const childIds = ["clip-v14f-left", "clip-v14f-right"];
  const result = applyAIEditingPlan({
    summary: "Split the first clip at two displayed-timeline seconds.",
    actions: [{
      type: "SPLIT_CLIP",
      targetId: DISPOSABLE_CLIP_ID,
      assetId: "",
      splitAtSeconds: 2,
      reason: "Apply the exact requested split.",
    }],
    unsupported: [],
    warnings: [],
  }, {
    project: source,
    ownedAssetIds: registeredOwnedAssetIds(),
    audioSourceDurationMs: 4_200,
    nowIso: "2026-10-19T00:01:00.000Z",
    createClipId: () => childIds.shift() ?? "unexpected-child-id",
  });
  const clips = result.project.tracks.find((track) => track.id === "video-main")?.clips ?? [];
  assert.equal(source.tracks[0].clips.length, 1);
  assert.equal(clips.length, 2);
  assert.deepEqual(clips.map((clip) => clip.id), ["clip-v14f-left", "clip-v14f-right"]);
  assert.deepEqual(clips.map((clip) => [clip.timelineStartMs, clip.timelineEndMs]), [[0, 2_000], [2_000, 4_200]]);
  assert.deepEqual(clips.map((clip) => [clip.sourceInMs, clip.sourceOutMs]), [[0, 2_000], [2_000, 4_200]]);
  assert.equal(clips[0].sourceOutMs, clips[1].sourceInMs);
  assert.equal(clips[0].timelineEndMs, clips[1].timelineStartMs);
  assert.deepEqual(clips.map((clip) => clip.assetId), [DISPOSABLE_ASSET_ID, DISPOSABLE_ASSET_ID]);
  assert.deepEqual(clips.map((clip) => clip.transform), [source.tracks[0].clips[0].transform, source.tracks[0].clips[0].transform]);
  assert.deepEqual(clips.map((clip) => clip.speedCurve), [source.tracks[0].clips[0].speedCurve, source.tracks[0].clips[0].speedCurve]);
});

test("editor surface reader uses only scoped non-empty success and error selectors", async () => {
  const queried: string[] = [];
  const locator = (selector: string) => ({
    first() { return this; },
    async isVisible() { return true; },
    async textContent() {
      queried.push(selector);
      return selector === VIDEO_AI_SUCCESS_SELECTOR ? "  " : " editor-specific error ";
    },
  });
  const snapshot = await readEditorSpecificSurface({ locator });
  assert.deepEqual(queried.sort(), [VIDEO_AI_ERROR_SELECTOR, VIDEO_AI_SUCCESS_SELECTOR].sort());
  assert.equal(queried.includes('[role="alert"]'), false);
  assert.equal(snapshot.successText, "");
  assert.equal(snapshot.errorText, "editor-specific error");
});

test("network tracker counts only POST ai-tasks and returns a bounded safe response summary", async () => {
  let requestListener: (request: { method: () => string; url: () => string }) => void = () => {
    throw new Error("Network tracker request listener was not installed.");
  };
  const responseBody = {
    ok: true,
    requestId: "safe-request-id",
    apiKey: "synthetic-secret-that-must-not-survive",
    rawProviderResponse: { hidden: true },
    result: { data: { summary: "ok", actions: [], unsupported: [], warnings: [] } },
  };
  const request = { method: () => "POST", url: () => `https://example.supabase.co${AI_TASKS_PATH_SUFFIX}` };
  const tracker = createAITaskNetworkTracker({
    on: (_event, listener) => { requestListener = listener; },
    waitForResponse: async (predicate) => {
      const response = {
        finished: async () => null,
        json: async () => responseBody,
        request: () => request,
        status: () => 200,
        url: request.url,
      };
      assert.equal(predicate(response), true);
      return response;
    },
  }, 500);
  requestListener({ method: () => "GET", url: request.url });
  requestListener(request);
  assert.equal(tracker.getRequestCount(), 1);
  const evidence = await tracker.waitForResponse();
  assert.equal(evidence.httpStatus, 200);
  assert.equal(evidence.responseCompleted, true);
  assert.equal(evidence.ok, true);
  assert.equal("apiKey" in evidence, false);
  assert.equal("rawProviderResponse" in evidence, false);
  assert.equal(JSON.stringify(evidence).includes("synthetic-secret-that-must-not-survive"), false);
});
