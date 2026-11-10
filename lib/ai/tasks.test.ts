import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyAIEditingPlan, parseAIEditingPlan } from "../../app/editor-ai-requirements.ts";
import { averageSpeed, type EditorProject } from "../../app/editor-core.ts";
import {
  assertSafeVerifierOutput,
  VerifierSecretExposureError,
} from "../../scripts/ai-text-verifier-safety.ts";
import { encodeEncryptionKeyForTest, encryptCredential } from "../../supabase/functions/_shared/ai-credentials/crypto.ts";
import type { AIProviderId } from "../../supabase/functions/_shared/ai-credentials/providers/types.ts";
import type { SavedCredential } from "../../supabase/functions/_shared/ai-credentials/service.ts";
import {
  getTaskBudget,
  MAX_AI_TASK_REQUEST_BYTES,
  TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
} from "../../supabase/functions/_shared/ai-tasks/budget.ts";
import { SafeTaskError, safeTaskErrorResponse } from "../../supabase/functions/_shared/ai-tasks/errors.ts";
import {
  EDITOR_REQUIREMENTS_PLAN_SCHEMA,
  EDITOR_REQUIREMENTS_TASK_INSTRUCTION,
  normalizeEditorRequirementsJSONText,
  validateEditorRequirementsPlan,
} from "../../supabase/functions/_shared/ai-tasks/editor-requirements-plan.ts";
import {
  authorizeInternalTextTaskFixture,
  authorizeInternalLiveValidation,
  createInternalLiveValidationProof,
  deriveInternalLiveValidationSecret,
  INTERNAL_LIVE_VALIDATION_HEADER,
} from "../../supabase/functions/_shared/ai-tasks/internal-live-validation.ts";
import {
  AI_TASK_PROVIDER_REGISTRY,
  dispatchTaskByCapability,
  getTaskDefinition,
  requireCapability,
} from "../../supabase/functions/_shared/ai-tasks/registry.ts";
import {
  buildDeepSeekTaskRequest,
  createDeepSeekTextTaskExecutor,
  DEEPSEEK_TASK_ENDPOINT,
  DEEPSEEK_TASK_MODEL,
  DEEPSEEK_THINKING_MODE,
} from "../../supabase/functions/_shared/ai-tasks/providers/deepseek.ts";
import {
  buildDoubaoTaskRequest,
  createDoubaoTextTaskExecutor,
  DOUBAO_TASK_ENDPOINT,
  DOUBAO_TASK_MODEL,
  DOUBAO_THINKING_MODE,
} from "../../supabase/functions/_shared/ai-tasks/providers/doubao.ts";
import {
  buildKimiTaskRequest,
  createKimiTextTaskExecutor,
  KIMI_TASK_ENDPOINT,
  KIMI_TASK_MODEL,
  KIMI_THINKING_MODE,
} from "../../supabase/functions/_shared/ai-tasks/providers/kimi.ts";
import {
  assertDefensibleMp3,
  assertDecodedTokenHubAudioSize,
  AmbiguousMusicProviderError,
  buildTencentTokenHubMusicRequest,
  classifyTokenHubAudioRepresentation,
  createTencentTokenHubMusicHTTPError,
  createTencentTokenHubMusicExecutor,
  decodeBoundedTokenHubAudioHex,
  parseTencentTokenHubMusicResponse,
  parseTencentTokenHubMusicResponseWithURL,
  TOKENHUB_MAX_AUDIO_BYTES,
  TOKENHUB_MAX_AUDIO_HEX_CHARACTERS,
  TOKENHUB_MUSIC_AUDIO_SETTING,
  TOKENHUB_MUSIC_ENDPOINT,
  TOKENHUB_MUSIC_MODEL,
  TOKENHUB_MUSIC_OUTPUT_FORMAT,
} from "../../supabase/functions/_shared/ai-tasks/providers/tencent-tokenhub-music.ts";
import {
  canIssueMusicProviderCall,
  hashMusicGenerationRequest,
  markMusicOperationCompleted,
  markMusicOperationFailed,
  markMusicOperationFinalizing,
  markMusicOperationUnknown,
  markMusicProviderInFlight,
  MusicOperationError,
  reserveMusicGenerationOperation,
  type MusicGenerationOperation,
  type MusicOperationRepository,
  type MusicOperationTransitionInput,
  type ReserveMusicOperationInput,
} from "../../supabase/functions/_shared/ai-tasks/music-operation.ts";
import {
  canonicalGeneratedMusicAudioPath,
  DraftCreateRejectedError,
  finalizeGeneratedMusic,
  GENERATED_MUSIC_BUCKET,
  MusicFinalizationError,
  type MusicFinalizationRepository,
} from "../../supabase/functions/_shared/ai-tasks/music-finalization.ts";
import { executeMusicGenerationRequest } from "../../supabase/functions/_shared/ai-tasks/music-service.ts";
import { parseAITaskRequest, requireAuthenticatedTaskUserId } from "../../supabase/functions/_shared/ai-tasks/request.ts";
import { executeAITaskRequest, type TaskCredentialRepository } from "../../supabase/functions/_shared/ai-tasks/service.ts";
import {
  safeResultData,
  SAFE_RESULT_MAX_ARRAY_LENGTH,
  SAFE_RESULT_MAX_DEPTH,
  SAFE_RESULT_MAX_SERIALIZED_BYTES,
  SAFE_RESULT_MAX_STRING_LENGTH,
} from "../../supabase/functions/_shared/ai-tasks/safe-result.ts";
import { textTaskOperatorDiagnostic } from "../../supabase/functions/_shared/ai-tasks/text-diagnostics.ts";
import {
  createInternalTextTaskFixtureApplicationContext,
  executeInternalTextTaskFixture,
  getInternalTextTaskFixtureDefinition,
  INTERNAL_TEXT_TASK_FIXTURES,
  parseInternalTextTaskFixture,
} from "../../supabase/functions/_shared/ai-tasks/text-fixtures.ts";
import { AI_TASK_IDS, type AITaskId, type AITaskExecutionContext } from "../../supabase/functions/_shared/ai-tasks/types.ts";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const encryptionKey = encodeEncryptionKeyForTest(new Uint8Array(32).fill(19));

const handlerSource = readFileSync(new URL("../../supabase/functions/ai-tasks/index.ts", import.meta.url), "utf8");
const configSource = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf8");
const clientSource = readFileSync(new URL("./tasks.ts", import.meta.url), "utf8");
const deepseekSource = readFileSync(new URL("../../supabase/functions/_shared/ai-credentials/providers/deepseek.ts", import.meta.url), "utf8");
const kimiSource = readFileSync(new URL("../../supabase/functions/_shared/ai-credentials/providers/kimi.ts", import.meta.url), "utf8");
const doubaoSource = readFileSync(new URL("../../supabase/functions/_shared/ai-credentials/providers/doubao.ts", import.meta.url), "utf8");
const deepseekTaskLiveVerifierSource = readFileSync(new URL("../../scripts/verify-ai-tasks-deepseek-live.mjs", import.meta.url), "utf8");
const kimiTaskLiveVerifierSource = readFileSync(new URL("../../scripts/verify-ai-tasks-kimi-live.mjs", import.meta.url), "utf8");
const doubaoTaskLiveVerifierSource = readFileSync(new URL("../../scripts/verify-ai-tasks-doubao-live.mjs", import.meta.url), "utf8");
const taskEdgeVerifierSource = readFileSync(new URL("../../scripts/verify-ai-tasks-edge.mjs", import.meta.url), "utf8");
const textDiagnosticVerifierSource = readFileSync(new URL("../../scripts/verify-ai-text-diagnostics-edge.mjs", import.meta.url), "utf8");
const musicOperationVerifierSource = readFileSync(new URL("../../scripts/verify-music-operations.mjs", import.meta.url), "utf8");
const tokenHubMusicLiveVerifierSource = readFileSync(new URL("../../scripts/verify-tokenhub-music-live.mjs", import.meta.url), "utf8");

const validInputs: Readonly<Record<AITaskId, Record<string, unknown>>> = {
  "music.lyrics_draft": { theme: "秋日归途", creativeRequirement: "温暖克制" },
  "music.lyrics_refine": { lyrics: "第一段歌词", creativeRequirement: "保持意象" },
  "music.creative_brief": { creativeRequirement: "一首安静的中文民谣" },
  "music.song_structure": { lyrics: "主歌与副歌", creativeRequirement: "三分钟结构" },
  "music.prompt_prepare": { creativeRequirement: "轻柔民谣", style: "folk", mood: "warm" },
  "music.generate": { operationId: "op_20261001_fixture_001", mode: "custom_lyrics", lyrics: "第一段歌词", prompt: "温暖民谣" },
  "editor.creative_intent_parse": { editingRequirement: "剪成30秒，节奏轻快，保留老师讲话和结尾Logo" },
  "editor.requirements_parse": { editingRequirement: "节奏紧凑，保留访谈重点", editorContext: "{\"videoDurationSeconds\":20}" },
  "editor.subtitle_semantic_plan": { subtitleText: "字幕文本", editingRequirement: "提取主题" },
  "editor.asset_match_plan": { subtitleText: "字幕文本", assetDescriptions: ["医院外景", "医生访谈"] },
  "editor.timeline_plan": { editingRequirement: "先问题后方案", assetDescriptions: ["片头", "访谈"] },
  "editor.editing_brief": { editingRequirement: "制作一分钟科普短片", subtitleText: "字幕文本" },
};

const validMusicBrief = {
  concept: "A restrained medical humanities song",
  theme: "Care and recovery",
  mood: "Warm",
  structure: ["Verse", "Chorus"],
  lyricDirection: ["Use concrete images"],
  arrangementDirection: ["Begin with piano"],
  notes: [],
};

const validEditorPlan = {
  summary: "Trim the opening clip safely.",
  actions: [{
    type: "TRIM_CLIP",
    targetId: "clip-a",
    assetId: "",
    startSeconds: 1,
    endSeconds: 6,
    reason: "Shorten the opening.",
  }],
  unsupported: [],
  warnings: ["Subtitle timing remains audio-controlled."],
};

test("text fixture verifier permits safe authorization wording without treating a header name as a value", () => {
  for (const text of [
    "authorization failed",
    "invalid authorization proof",
    "authorization required",
    "no Authorization value exposed",
    "authentication/authorization error",
  ]) {
    assert.doesNotThrow(() => assertSafeVerifierOutput(text, []));
  }
});

test("text fixture verifier rejects synthetic authorization and known secret values", () => {
  const fixtureApiKey = "fixture-api-key-value-not-real";
  const fixtureJwt = "fixture.jwt-token-value.not-real";
  const fixtureCredential = "fixture-cipher-value-not-real";
  for (const [text, knownValues] of [
    ["Authorization: Bearer test-secret-token", []],
    ["Bearer test-secret-token", []],
    [`provider key ${fixtureApiKey}`, [fixtureApiKey]],
    [`session ${fixtureJwt}`, [fixtureJwt]],
    [`stored value ${fixtureCredential}`, [fixtureCredential]],
  ] as const) {
    assert.throws(
      () => assertSafeVerifierOutput(text, knownValues),
      VerifierSecretExposureError,
    );
  }
});

const exactFirstFiveSecondsTrimPlan = {
  summary: "Remove the first five seconds from the supplied clip.",
  actions: [{
    type: "TRIM_CLIP",
    targetId: "clip-example-1",
    assetId: "",
    startSeconds: 5,
    endSeconds: 10,
    reason: "Retain the clip timeline range after the first five seconds.",
  }],
  unsupported: [],
  warnings: [],
};

const exactPlaybackSpeedPlan = {
  summary: "Set the supplied clip to 1.25x playback speed.",
  actions: [{
    type: "SET_CLIP_PLAYBACK_SPEED",
    targetId: "clip-example-1",
    assetId: "",
    playbackRate: 1.25,
    reason: "Use the explicit playback rate requested for the first supplied video clip.",
  }],
  unsupported: [],
  warnings: [],
};

const exactSplitClipPlan = {
  summary: "Split the first supplied video clip at its local timeline second 6.",
  actions: [{
    type: "SPLIT_CLIP",
    targetId: "clip-example-1",
    assetId: "",
    splitAtSeconds: 6,
    reason: "Split at six seconds from the start of the supplied clip displayed timeline.",
  }],
  unsupported: [],
  warnings: [],
};

const exactReorderClipPlan = {
  summary: "Move the second supplied clip before the first supplied clip.",
  actions: [{
    type: "REORDER_CLIP",
    targetId: "clip-example-2",
    assetId: "",
    referenceId: "clip-example-1",
    placement: "BEFORE",
    reason: "Place the second clip immediately before the first clip in the supplied logical order.",
  }],
  unsupported: [],
  warnings: [],
};

const exactPositionScalePlan = {
  summary: "Set the third visual clip to 80% scale in the top-right position.",
  actions: [{
    type: "SET_CLIP_POSITION_SCALE",
    targetId: "clip-c",
    assetId: "",
    x: 25,
    y: -25,
    scale: 0.8,
    reason: "Use the requested absolute top-right position and 80% scale for the third supplied visual clip.",
  }],
  unsupported: [],
  warnings: [],
};
const trustedPositionScaleContext = JSON.stringify({
  clips: [{ id: "clip-c", positionScaleEligible: true }],
});

function editorProjectForAlignment(): EditorProject {
  return {
    schemaVersion: 2,
    id: "project-schema-alignment",
    title: "Synthetic schema alignment fixture",
    updatedAt: "2026-10-17T00:00:00.000Z",
    durationMs: 20_000,
    ratio: "16:9",
    audioSelection: {
      mode: "full",
      sourceDurationMs: 30_000,
      sourceInMs: 0,
      sourceOutMs: 30_000,
      selectedDurationMs: 30_000,
    },
    assets: [
      { id: "asset-example-1", name: "Synthetic clip 1", kind: "视频", durationMs: 10_000 },
      { id: "asset-example-2", name: "Synthetic clip 2", kind: "视频", durationMs: 10_000 },
    ],
    tracks: [{
      id: "video-main",
      type: "video",
      name: "video",
      clips: [
        {
          id: "clip-example-1",
          assetId: "asset-example-1",
          name: "Synthetic clip 1",
          kind: "视频",
          trackId: "video-main",
          timelineStartMs: 0,
          timelineEndMs: 10_000,
          sourceInMs: 0,
          sourceOutMs: 10_000,
          transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
          speedCurve: [{ id: "start", at: 0, rate: 1 }, { id: "end", at: 1, rate: 1 }],
        },
        {
          id: "clip-example-2",
          assetId: "asset-example-2",
          name: "Synthetic clip 2",
          kind: "视频",
          trackId: "video-main",
          timelineStartMs: 10_000,
          timelineEndMs: 20_000,
          sourceInMs: 0,
          sourceOutMs: 10_000,
          transform: { x: 0, y: 0, scale: 1, crop: 0, fit: "cover" },
          speedCurve: [{ id: "start", at: 0, rate: 1 }, { id: "end", at: 1, rate: 1 }],
        },
      ],
    }],
    captions: [{ id: "caption-example-1", text: "Synthetic subtitle", startMs: 1_000, endMs: 2_000 }],
  };
}

function deepseekContext(
  task: "music.creative_brief" | "editor.requirements_parse",
): AITaskExecutionContext {
  const budget = getTaskBudget(task);
  return {
    userId: USER_A,
    task,
    provider: "deepseek",
    capability: "TEXT_REASONING",
    input: task === "music.creative_brief"
      ? { creativeRequirement: "Create a short healing song", genre: "folk", mood: "warm" }
      : {
          editingRequirement: "Keep the pacing steady", subtitleText: "Safe subtitle text",
          editorContext: JSON.stringify({ clips: [
            { id: "clip-example-1", positionScaleEligible: true },
            { id: "clip-c", positionScaleEligible: true },
          ] }),
        },
    serverInstruction: "Return a structured plan.",
    serverControlledModel: DEEPSEEK_TASK_MODEL,
    apiKey: "fixture-provider-key-not-real",
    budget: {
      maxOutputTokens: budget.maxOutputTokens,
      timeoutMs: budget.timeoutMs,
      automaticProviderRetryCount: 0,
      maxProviderCalls: 1,
    },
  };
}

function deepseekResponse(result: unknown, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: {
        content: JSON.stringify(result),
        reasoning_content: "must-never-be-returned",
      },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 },
    raw_provider_marker: "must-never-be-returned",
    ...extra,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function deepseekContentResponse(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function doubaoContext(
  task: "music.creative_brief" | "editor.requirements_parse",
): AITaskExecutionContext {
  const budget = getTaskBudget(task);
  return {
    userId: USER_A,
    task,
    provider: "doubao",
    capability: "TEXT_REASONING",
    input: task === "music.creative_brief"
      ? { creativeRequirement: "Create a short healing song", genre: "folk", mood: "warm" }
      : {
          editingRequirement: "Keep the pacing steady", subtitleText: "Safe subtitle text",
          editorContext: JSON.stringify({ clips: [
            { id: "clip-example-1", positionScaleEligible: true },
            { id: "clip-c", positionScaleEligible: true },
          ] }),
        },
    serverInstruction: "Return a structured plan.",
    serverControlledModel: DOUBAO_TASK_MODEL,
    apiKey: "fixture-provider-key-not-real",
    providerResourceId: "apikey-20260917000000-test1",
    budget: {
      maxOutputTokens: budget.maxOutputTokens,
      timeoutMs: budget.timeoutMs,
      automaticProviderRetryCount: 0,
      maxProviderCalls: 1,
    },
  };
}

function doubaoResponse(result: unknown, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: {
        content: JSON.stringify(result),
        reasoning_content: "must-never-be-returned",
      },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 },
    raw_provider_marker: "must-never-be-returned",
    ...extra,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function kimiContext(
  task: "music.creative_brief" | "editor.requirements_parse",
): AITaskExecutionContext {
  const budget = getTaskBudget(task);
  return {
    userId: USER_A,
    task,
    provider: "kimi",
    capability: "TEXT_REASONING",
    input: task === "music.creative_brief"
      ? { creativeRequirement: "Create a short healing song", genre: "folk", mood: "warm" }
      : {
          editingRequirement: "Keep the pacing steady", subtitleText: "Safe subtitle text",
          editorContext: JSON.stringify({ clips: [
            { id: "clip-example-1", positionScaleEligible: true },
            { id: "clip-c", positionScaleEligible: true },
          ] }),
        },
    serverInstruction: "Return a structured plan.",
    serverControlledModel: KIMI_TASK_MODEL,
    apiKey: "fixture-provider-key-not-real",
    budget: {
      maxOutputTokens: budget.maxOutputTokens,
      timeoutMs: budget.timeoutMs,
      automaticProviderRetryCount: 0,
      maxProviderCalls: 1,
    },
  };
}

function kimiResponse(result: unknown, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: {
        content: JSON.stringify(result),
        reasoning_content: "must-never-be-returned",
      },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 },
    raw_provider_marker: "must-never-be-returned",
    ...extra,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function expectTaskError(action: () => unknown | Promise<unknown>, code: string) {
  await assert.rejects(async () => await action(), (error: unknown) => error instanceof SafeTaskError && error.code === code);
}

async function captureTaskError(action: () => unknown | Promise<unknown>): Promise<SafeTaskError> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof SafeTaskError);
    return error;
  }
  assert.fail("Expected a SafeTaskError");
}

async function savedCredential(provider: AIProviderId = "deepseek"): Promise<SavedCredential> {
  const encrypted = await encryptCredential("fixture-provider-key-not-real", encryptionKey);
  return {
    provider,
    providerResourceId: provider === "doubao" ? "apikey-20260917000000-test1" : null,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    encryptionVersion: encrypted.encryptionVersion,
  };
}

function repositoryFor(entries: Map<string, SavedCredential>): TaskCredentialRepository {
  return {
    async getSavedCredential(userId, provider) {
      return entries.get(`${userId}:${provider}`) ?? null;
    },
  };
}

function captureSyncTaskError(action: () => unknown): SafeTaskError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof SafeTaskError);
    return error;
  }
  assert.fail("Expected a SafeTaskError");
}

class InMemoryMusicOperationRepository implements MusicOperationRepository {
  readonly rows = new Map<string, MusicGenerationOperation>();
  readonly transitions: MusicOperationTransitionInput[] = [];

  private key(userId: string, operationId: string): string {
    return `${userId}:${operationId}`;
  }

  async reserve(input: ReserveMusicOperationInput) {
    const key = this.key(input.userId, input.operationId);
    const existing = this.rows.get(key);
    if (existing) return { operation: existing, created: false };
    const operation: MusicGenerationOperation = {
      id: crypto.randomUUID(),
      userId: input.userId,
      operationId: input.operationId,
      task: input.task,
      provider: input.provider,
      requestHash: input.requestHash,
      state: "RESERVED",
      providerCallCount: 0,
      providerRequestId: null,
      providerTraceId: null,
      finalTrackId: null,
      failureCode: null,
      failureDiagnostics: null,
      createdAt: "2026-10-02T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    };
    this.rows.set(key, operation);
    return { operation, created: true };
  }

  async load(userId: string, operationId: string) {
    return this.rows.get(this.key(userId, operationId)) ?? null;
  }

  async transition(input: MusicOperationTransitionInput) {
    const key = this.key(input.userId, input.operationId);
    const current = this.rows.get(key);
    if (!current || current.state !== input.expectedState) {
      throw new MusicOperationError("OPERATION_TRANSITION_CONFLICT", "stale transition");
    }
    if (input.providerCallCount > 1) throw new Error("provider_call_count exceeded one");
    const updated: MusicGenerationOperation = {
      ...current,
      state: input.nextState,
      providerCallCount: input.providerCallCount,
      providerRequestId: input.providerRequestId ?? current.providerRequestId,
      providerTraceId: input.providerTraceId ?? current.providerTraceId,
      finalTrackId: input.finalTrackId ?? null,
      failureCode: input.failureCode ?? null,
      failureDiagnostics: input.failureDiagnostics ?? null,
      updatedAt: "2026-10-02T00:00:01.000Z",
    };
    this.transitions.push(input);
    this.rows.set(key, updated);
    return updated;
  }
}

const VALID_MP3_BYTES = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]);
const VALID_ID3_MP3_BYTES = Uint8Array.from([
  0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ...VALID_MP3_BYTES,
]);
const VALID_MPEG2_MP3_BYTES = Uint8Array.from([0xff, 0xf3, 0x80, 0x64, 0x00, 0x00, 0x00, 0x00]);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tokenHubFixture(audio = bytesToHex(VALID_MP3_BYTES), musicSize = VALID_MP3_BYTES.byteLength) {
  return {
    data: { status: 2, audio },
    base_resp: { status_code: 0, status_msg: "success" },
    extra_info: {
      music_duration: 42.5,
      music_sample_rate: 44_100,
      music_channel: 2,
      bitrate: 256_000,
      music_size: musicSize,
    },
    usage: { total_tokens: 12 },
    trace_id: "trace-fixture",
    request_id: "request-fixture",
  };
}

async function tokenHubURLProviderResult() {
  return await parseTencentTokenHubMusicResponseWithURL(
    200,
    tokenHubFixture("https://aigc-output-audio-file-1326893053.cos.ap-guangzhou.myqcloud.com/audio.mp3?signature=fixture-not-real"),
    {
      downloadAudio: async () => ({
        bytes: VALID_MP3_BYTES,
        contentType: "audio/mpeg",
        contentLength: VALID_MP3_BYTES.byteLength,
        downloadedBytes: VALID_MP3_BYTES.byteLength,
        diagnostics: {
          urlScheme: "https:",
          normalizedDownloadHostname: "aigc-output-audio-file-1326893053.cos.ap-guangzhou.myqcloud.com",
          explicitPortPresent: false,
          urlCredentialsPresent: false,
          urlFragmentPresent: false,
          urlPolicyValidationMs: 1,
          dnsPreflightPerformed: true,
          dnsPreflightResult: "PUBLIC_ONLY",
          dnsResolvedAddressCount: 1,
          dnsPrivateAddressDetected: false,
          dnsPreflightMs: 2,
          dnsRebindingTOCTOUPresent: true,
          downloadHostAllowlistUsed: true,
          downloadHttpStatus: 200,
          downloadContentType: "audio/mpeg",
          downloadContentLengthHeader: VALID_MP3_BYTES.byteLength,
          downloadedBytes: VALID_MP3_BYTES.byteLength,
          downloadRedirectCount: 0,
          downloadFirstResponseMs: 3,
          downloadTotalMs: 4,
        },
      }),
    },
  );
}

class RecordingMusicFinalizationRepository implements MusicFinalizationRepository {
  readonly events: string[] = [];
  readonly generatedTrackId = "33333333-3333-4333-8333-333333333333";
  draft: { id: string; userId: string; published: false } | null = null;
  audioPath: string | null = null;

  async createDraft(input: Parameters<MusicFinalizationRepository["createDraft"]>[0]) {
    this.events.push("draft:create");
    this.draft = { id: this.generatedTrackId, userId: input.userId, published: input.published };
    return this.draft;
  }

  async uploadAudio(input: Parameters<MusicFinalizationRepository["uploadAudio"]>[0]) {
    this.events.push("storage:upload");
    assert.equal(input.bucket, "music-audio");
    assert.equal(input.upsert, false);
    assertDefensibleMp3(input.bytes);
    this.audioPath = input.path;
  }

  async finalizeDraft(input: Parameters<MusicFinalizationRepository["finalizeDraft"]>[0]) {
    this.events.push("draft:finalize");
    assert.equal(input.userId, this.draft?.userId);
    assert.equal(input.trackId, this.draft?.id);
    assert.equal(input.audioPath, this.audioPath);
    assert.equal(input.published, false);
  }

  async deleteAudio() {
    this.events.push("storage:delete");
  }

  async deleteDraft() {
    this.events.push("draft:delete");
  }
}

async function createFinalizingMusicOperation(
  repository: InMemoryMusicOperationRepository,
  operationId: string,
) {
  const input = {
    operationId,
    mode: "instrumental" as const,
    prompt: "small synthetic fixture",
    title: "Safe generated draft",
  };
  const reserved = await reserveMusicGenerationOperation(USER_A, input, repository);
  const inFlight = await markMusicProviderInFlight(repository, reserved.operation);
  const finalizing = await markMusicOperationFinalizing(repository, inFlight, {
    requestId: "request-fixture",
    traceId: "trace-fixture",
  });
  return { input, finalizing };
}

test("ai-tasks uses handler auth.getUser with verify_jwt false", () => {
  assert.match(configSource, /\[functions\.ai-tasks\][\s\S]*verify_jwt = false[\s\S]*import_map = "\.\/functions\/deno\.json"/);
  assert.match(handlerSource, /auth\.getUser\(\)/);
  assert.match(handlerSource, /Authorization/);
  assert.ok(handlerSource.indexOf("authenticatedTaskContext(req") < handlerSource.indexOf("serviceClient = createClient<BYOKDatabase>"));
  assert.match(handlerSource, /tracks:\s*createAuthenticatedMusicFinalizationRepository\(userClient\)/);
  assert.doesNotMatch(handlerSource, /tracks:\s*createAuthenticatedMusicFinalizationRepository\(serviceClient\)/);
  assert.match(handlerSource, /executeMusic:\s*executeTencentTokenHubMusic/);
  assert.doesNotMatch(handlerSource, /request\.userId|body\.userId/);
});

test("anonymous and invalid authenticated identities are rejected", async () => {
  await expectTaskError(() => requireAuthenticatedTaskUserId(null), "UNAUTHENTICATED");
  await expectTaskError(() => requireAuthenticatedTaskUserId("invalid-jwt-subject"), "UNAUTHENTICATED");
  assert.equal(requireAuthenticatedTaskUserId(USER_A), USER_A);
});

test("unknown task and unknown provider are rejected", async () => {
  await expectTaskError(() => parseAITaskRequest({ task: "music.unknown", provider: "deepseek", input: {} }), "INVALID_TASK");
  for (const provider of ["custom", "openai", "gemini"]) {
    await expectTaskError(() => parseAITaskRequest({ task: "music.creative_brief", provider, input: validInputs["music.creative_brief"] }), "PROVIDER_NOT_SUPPORTED_FOR_TASK");
  }
});

test("unknown and browser-controlled transport fields are rejected", async () => {
  const forbiddenFields = ["model", "provider_resource_id", "providerResourceId", "resourceId", "baseURL", "endpoint", "hostname", "timeout", "max_tokens", "max_completion_tokens", "max_output_tokens", "thinking", "reasoning", "reasoning_effort", "temperature", "top_p", "response_format", "json_schema", "text", "store", "stream", "headers", "Authorization", "apiKey", "systemPrompt", "developerPrompt", "instructions", "rawMessages", "user_id", "userId", "state", "provider_call_count", "request_hash", "final_track_id"];
  for (const provider of ["deepseek", "kimi", "doubao"] as const) {
    for (const field of forbiddenFields) {
      await expectTaskError(() => parseAITaskRequest({
        task: "music.creative_brief",
        provider,
        input: validInputs["music.creative_brief"],
        [field]: "forbidden",
      }), "INVALID_INPUT");
    }
  }
});

test("task-specific input schemas reject unknown, nested, binary-like, and oversized input", async () => {
  await expectTaskError(() => parseAITaskRequest({ task: "music.creative_brief", provider: "deepseek", input: { creativeRequirement: "brief", extra: "no" } }), "INVALID_INPUT");
  await expectTaskError(() => parseAITaskRequest({ task: "music.creative_brief", provider: "deepseek", input: { creativeRequirement: { nested: true } } }), "INVALID_INPUT");
  await expectTaskError(() => parseAITaskRequest({ task: "editor.asset_match_plan", provider: "deepseek", input: { assetDescriptions: [[1, 2, 3]] } }), "INVALID_INPUT");
  await expectTaskError(() => parseAITaskRequest({ task: "music.creative_brief", provider: "deepseek", input: { creativeRequirement: "x".repeat(24_001) } }), "INVALID_INPUT");
  assert.equal(MAX_AI_TASK_REQUEST_BYTES, 64 * 1024);
});

test("all task contracts are accepted by provider-neutral request parsing", () => {
  assert.equal(AI_TASK_IDS.filter((task) => task.startsWith("music.")).length, 6);
  assert.equal(AI_TASK_IDS.filter((task) => task.startsWith("editor.")).length, 6);
  for (const task of AI_TASK_IDS) {
    const parsed = parseAITaskRequest({ task, provider: "deepseek", input: validInputs[task] });
    assert.equal(parsed.task, task);
  }
});

test("text providers and the TokenHub music foundation report their validated readiness states", async () => {
  assert.deepEqual(AI_TASK_PROVIDER_REGISTRY.map((provider) => provider.id), ["deepseek", "kimi", "doubao", "tencent_tokenhub"]);
  for (const provider of AI_TASK_PROVIDER_REGISTRY) {
    assert.equal(provider.capabilities.TEXT_REASONING, provider.id === "tencent_tokenhub" ? "not_enabled" : "foundation_ready");
    assert.equal(provider.capabilities.VISION, "not_enabled");
    assert.equal(provider.capabilities.AUDIO_UNDERSTANDING, "not_enabled");
    assert.equal(provider.capabilities.VIDEO_UNDERSTANDING, "not_enabled");
    assert.equal(provider.capabilities.MUSIC_GENERATION, provider.id === "tencent_tokenhub" ? "foundation_ready" : "not_enabled");
    assert.equal(provider.capabilities.VIDEO_GENERATION, "not_enabled");
    assert.equal(
      provider.model,
      provider.id === "deepseek"
        ? DEEPSEEK_TASK_MODEL
        : provider.id === "kimi"
          ? KIMI_TASK_MODEL
        : provider.id === "doubao"
          ? DOUBAO_TASK_MODEL
          : provider.id === "tencent_tokenhub"
            ? TOKENHUB_MUSIC_MODEL
            : null,
    );
  }
  assert.notStrictEqual(
    AI_TASK_PROVIDER_REGISTRY[0].capabilities,
    AI_TASK_PROVIDER_REGISTRY[1].capabilities,
  );
  assert.notStrictEqual(
    AI_TASK_PROVIDER_REGISTRY[1].capabilities,
    AI_TASK_PROVIDER_REGISTRY[2].capabilities,
  );
  for (const provider of AI_TASK_PROVIDER_REGISTRY) {
    await expectTaskError(
      () => requireCapability(provider.id, "VIDEO_UNDERSTANDING"),
      "PROVIDER_NOT_SUPPORTED_FOR_TASK",
    );
    if (provider.id === "tencent_tokenhub") {
      assert.equal(requireCapability(provider.id, "MUSIC_GENERATION").id, "tencent_tokenhub");
    } else {
      await expectTaskError(
        () => requireCapability(provider.id, "MUSIC_GENERATION"),
        "PROVIDER_NOT_SUPPORTED_FOR_TASK",
      );
    }
  }
});

test("TokenHub retains the validated C1D v2.6 foundation while public task execution stays closed", () => {
  const registrySource = readFileSync(
    new URL("../../supabase/functions/_shared/ai-tasks/registry.ts", import.meta.url),
    "utf8",
  );
  assert.match(registrySource, /TOKENHUB_MUSIC_FOUNDATION/);
  assert.match(registrySource, /reserveMusicGenerationOperation/);
  assert.match(registrySource, /finalizeGeneratedMusic/);
  assert.match(registrySource, /parseTencentTokenHubMusicResponse/);
  assert.match(registrySource, /MUSIC_GENERATION:\s*"foundation_ready"/);
  assert.match(registrySource, /liveTaskIds:\s*\[\]/);
  assert.doesNotMatch(registrySource, /execute:\s*[^,]*TokenHub|executeTencentTokenHub/i);
});

test("foundation-ready music.generate remains publicly closed before saved credential access", async () => {
  assert.equal(getTaskDefinition("music.generate").capability, "MUSIC_GENERATION");
  const request = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: validInputs["music.generate"],
  });
  let credentialReads = 0;
  await expectTaskError(() => executeAITaskRequest(USER_A, request, {
    repository: {
      async getSavedCredential() {
        credentialReads += 1;
        return await savedCredential("tencent_tokenhub");
      },
    },
    encryptionKey,
  }), "PROVIDER_NOT_SUPPORTED_FOR_TASK");
  assert.equal(credentialReads, 0);
});

test("trusted internal TokenHub validation reaches saved credential, operation ledger and mocked music executor", async () => {
  const request = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: {
      operationId: "op_20261003_internal_gate_001",
      mode: "instrumental",
      prompt: "safe mocked internal validation",
    },
  });
  const operations = new InMemoryMusicOperationRepository();
  const tracks = new RecordingMusicFinalizationRepository();
  let credentialReads = 0;
  let providerCalls = 0;
  const result = await executeAITaskRequest(USER_A, request, {
    repository: {
      async getSavedCredential(userId, provider) {
        credentialReads += 1;
        assert.equal(userId, USER_A);
        assert.equal(provider, "tencent_tokenhub");
        return await savedCredential("tencent_tokenhub");
      },
    },
    encryptionKey,
    executionContext: "internal_live_validation",
    music: {
      operations,
      tracks,
      async executeMusic(context) {
        providerCalls += 1;
        assert.equal(context.provider, "tencent_tokenhub");
        assert.equal(context.serverControlledModel, "minimax-music-v2.6");
        return await tokenHubURLProviderResult();
      },
    },
  });
  assert.equal(credentialReads, 1);
  assert.equal(providerCalls, 1);
  assert.equal((result.result as { data: Record<string, unknown> }).data.operationState, "COMPLETED");
  const trusted = (result.metadata as { trustedInternalDiagnostics?: Record<string, unknown> })
    .trustedInternalDiagnostics;
  assert.equal(trusted?.output_format, "url");
  assert.equal(trusted?.normalized_download_hostname, "aigc-output-audio-file-1326893053.cos.ap-guangzhou.myqcloud.com");
  assert.equal(trusted?.dns_preflight_result, "PUBLIC_ONLY");
  assert.equal(trusted?.download_http_status, 200);
  assert.equal(trusted?.downloaded_bytes, VALID_MP3_BYTES.byteLength);
  assert.equal(trusted?.dns_rebinding_toctou_present, true);
  assert.equal(typeof trusted?.provider_generation_ms, "number");
  assert.equal(typeof trusted?.url_policy_validation_ms, "number");
  assert.equal(typeof trusted?.dns_preflight_ms, "number");
  assert.equal(typeof trusted?.download_first_response_ms, "number");
  assert.equal(typeof trusted?.download_total_ms, "number");
  assert.equal(typeof trusted?.storage_upload_ms, "number");
  assert.equal(typeof trusted?.track_finalization_ms, "number");
  assert.equal(typeof trusted?.total_task_wall_clock_ms, "number");
  assert.equal(JSON.stringify(trusted).includes("audio.mp3"), false);
  assert.equal(JSON.stringify(trusted).includes("fixture-not-real"), false);
  assert.equal((await operations.load(USER_A, String(request.input.operationId)))?.providerCallCount, 1);
});

test("ordinary music execution cannot receive trusted URL diagnostics", async () => {
  const request = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: {
      operationId: "op_20261008_public_diagnostics_denied_001",
      mode: "instrumental",
      prompt: "safe mocked public contract",
    },
  });
  const response = await executeMusicGenerationRequest(
    USER_A,
    request,
    "fixture-provider-key-not-real",
    TOKENHUB_MUSIC_MODEL,
    TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
    { credentialLookupDecryptMs: 0, requestStartedAtMs: performance.now() },
    {
      operations: new InMemoryMusicOperationRepository(),
      tracks: new RecordingMusicFinalizationRepository(),
      executeMusic: tokenHubURLProviderResult,
    },
  );
  assert.equal("trustedInternalDiagnostics" in (response.metadata as Record<string, unknown>), false);
  assert.equal(JSON.stringify(response).includes("aigc-output-audio-file-1326893053.cos.ap-guangzhou.myqcloud.com"), false);
});

test("internal live-validation proof is short-lived, user-bound, request-bound and fail-closed", async () => {
  assert.equal(INTERNAL_LIVE_VALIDATION_HEADER, "x-medclip-internal-live-validation");
  const request = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: validInputs["music.generate"],
  });
  const secret = await deriveInternalLiveValidationSecret("fixture-operator-password-not-real");
  const timestampMs = 1_799_999_000_000;
  const proof = await createInternalLiveValidationProof({ secret, userId: USER_A, request, timestampMs });
  assert.equal(await authorizeInternalLiveValidation({ proof, secret, userId: USER_A, request, nowMs: timestampMs }), true);
  assert.equal(await authorizeInternalLiveValidation({ proof: null, secret, userId: USER_A, request, nowMs: timestampMs }), false);
  await expectTaskError(
    () => authorizeInternalLiveValidation({ proof, secret, userId: USER_B, request, nowMs: timestampMs }),
    "UNAUTHENTICATED",
  );
  await expectTaskError(
    () => authorizeInternalLiveValidation({ proof, secret, userId: USER_A, request, nowMs: timestampMs + 300_001 }),
    "UNAUTHENTICATED",
  );
  const changed = parseAITaskRequest({ ...request, input: { ...request.input, prompt: "different" } });
  await expectTaskError(
    () => authorizeInternalLiveValidation({ proof, secret, userId: USER_A, request: changed, nowMs: timestampMs }),
    "UNAUTHENTICATED",
  );
  await expectTaskError(
    () => authorizeInternalLiveValidation({ proof: "browser-controlled", secret, userId: USER_A, request, nowMs: timestampMs }),
    "UNAUTHENTICATED",
  );
});

test("trusted provider-free text fixtures are generic, proof-bound and preserve exact canonical outcomes", async () => {
  assert.match(textDiagnosticVerifierSource, /INTERNAL_TEXT_TASK_FIXTURES/);
  assert.match(textDiagnosticVerifierSource, /definition\.expected\.actionTypes/);
  assert.match(textDiagnosticVerifierSource, /createInternalTextTaskFixtureApplicationContext/);
  assert.doesNotMatch(textDiagnosticVerifierSource, /actions\[0\]\.type/);
  assert.doesNotMatch(textDiagnosticVerifierSource, /valid_split_clip_speed_2x_at_3s/);
  assert.deepEqual(new Set(INTERNAL_TEXT_TASK_FIXTURES), new Set([
    "valid_canonical_plan", "upstream_http_502", "upstream_malformed_json", "canonical_schema_error",
    "valid_caption_first_chinese_medical_correction", "valid_caption_second_english_replacement",
    "valid_caption_unique_current_text", "valid_caption_multiple_edits", "valid_caption_noop_exact_text",
    "ambiguous_caption_duplicate_text", "ambiguous_caption_deictic_reference", "unsupported_caption_timing_request",
    "invalid_caption_invented_target", "invalid_caption_wrong_object_target", "invalid_caption_asset_id_target", "invalid_caption_duplicate_id",
    "invalid_caption_unknown_field", "invalid_caption_over_2000_code_units",
    "valid_playback_speed_1_25", "valid_playback_speed_0_25", "valid_playback_speed_4",
    "invalid_playback_speed_0_24", "invalid_playback_speed_4_01", "invalid_playback_speed_zero",
    "invalid_playback_speed_negative", "invalid_playback_speed_nan", "invalid_playback_speed_infinity",
    "invalid_playback_speed_string", "unknown_playback_speed_target", "invented_playback_speed_target",
    "target_not_in_context_playback_speed", "raw_url_playback_speed_target", "invalid_alias_set_speed",
    "invalid_alias_change_playback_speed", "invalid_alias_playback_rate", "valid_trim_and_playback_speed",
    "invalid_trim_and_playback_speed", "valid_split_clip_6", "invalid_split_clip_zero",
    "invalid_split_clip_negative", "invalid_split_clip_string", "invalid_split_clip_exact_end",
    "invalid_split_clip_after_end", "invalid_split_clip_nan_string", "invalid_split_clip_infinity_string",
    "valid_split_clip_min_left_100ms", "invalid_split_clip_min_left_99ms",
    "valid_split_clip_min_right_100ms", "invalid_split_clip_min_right_99ms",
    "unknown_split_clip_target", "invented_split_clip_target", "raw_url_split_clip_target",
    "invalid_alias_cut_clip", "invalid_alias_split_video", "invalid_alias_divide_clip",
    "valid_split_clip_speed_2x_at_3s", "valid_speed_and_split", "invalid_speed_and_split",
    "valid_reorder_c_before_a", "valid_reorder_a_after_c", "valid_reorder_b_after_c",
    "valid_reorder_target", "valid_reorder_already_in_position", "invalid_reorder_unknown_target",
    "invalid_reorder_invented_target", "invalid_reorder_raw_url_target", "invalid_reorder_non_context_target",
    "valid_reorder_reference", "invalid_reorder_unknown_reference", "invalid_reorder_invented_reference",
    "invalid_reorder_raw_url_reference", "invalid_reorder_non_context_reference", "invalid_reorder_self",
    "valid_reorder_before_placement", "valid_reorder_after_placement", "invalid_reorder_lowercase_placement",
    "invalid_reorder_lowercase_after", "invalid_reorder_left_placement", "invalid_reorder_right_placement",
    "invalid_reorder_start_placement", "invalid_reorder_end_placement", "invalid_reorder_move_alias",
    "invalid_reorder_reposition_alias", "invalid_reorder_change_order_alias", "invalid_reorder_sort_alias",
    "valid_reorder_ordinal_context", "valid_reorder_pure_contract", "valid_reorder_speed_adjusted_context",
    "valid_reorder_existing_split_child", "invalid_reorder_future_child_after_split",
    "valid_speed_and_reorder", "invalid_speed_and_reorder", "valid_reorder_full_pipeline",
    "valid_position_scale_top_right_80", "valid_position_scale_center",
    "valid_position_scale_enlarge_slightly", "valid_position_scale_shrink_slightly",
    "valid_position_scale_restore_current", "valid_position_scale_bottom_left",
    "valid_position_scale_125_percent", "valid_position_scale_noop",
    "valid_position_scale_enlarge_at_max_noop", "valid_position_scale_shrink_at_min_noop",
    "unsupported_position_scale_percent_below", "unsupported_position_scale_percent_above",
    "unsupported_position_scale_fourth_ordinal", "unsupported_position_scale_ambiguous_current",
    "invalid_position_scale_invented_target", "invalid_position_scale_outside_context",
    "invalid_position_scale_x_below", "invalid_position_scale_x_above",
    "invalid_position_scale_y_below", "invalid_position_scale_y_above",
    "invalid_position_scale_scale_below", "invalid_position_scale_scale_above",
    "invalid_position_scale_numeric_string", "invalid_position_scale_nonempty_asset",
    "invalid_position_scale_unknown_field", "invalid_position_scale_rotation",
    "invalid_position_scale_css", "invalid_position_scale_matrix", "invalid_position_scale_crop_fit",
    "invalid_position_scale_duplicate", "invalid_remove_and_position_scale_same_target",
    "invalid_split_child_position_target",
  ]));
  const baseDefinition = getInternalTextTaskFixtureDefinition("valid_canonical_plan");
  const request = parseAITaskRequest({ task: "editor.requirements_parse", provider: "deepseek", input: baseDefinition.input });
  const secret = await deriveInternalLiveValidationSecret("fixture-operator-password");
  const timestampMs = 1_800_000_000_000;
  const proof = await createInternalLiveValidationProof({ secret, userId: USER_A, request, timestampMs });
  assert.equal(await authorizeInternalTextTaskFixture({
    proof,
    secret,
    userId: USER_A,
    request,
    nowMs: timestampMs + 1_000,
  }), true);
  await assert.rejects(
    () => authorizeInternalTextTaskFixture({
      proof,
      secret,
      userId: USER_B,
      request,
      nowMs: timestampMs + 1_000,
    }),
    (error: unknown) => error instanceof SafeTaskError && error.code === "UNAUTHENTICATED",
  );
  await assert.rejects(
    () => authorizeInternalTextTaskFixture({
      proof: "v1.0000000000000.invalid",
      secret,
      userId: USER_A,
      request,
      nowMs: timestampMs + 1_000,
    }),
    (error: unknown) => error instanceof SafeTaskError
      && error.code === "UNAUTHENTICATED"
      && error.httpStatus === 401,
  );
  assert.equal(parseInternalTextTaskFixture("valid_canonical_plan"), "valid_canonical_plan");
  assert.throws(() => parseInternalTextTaskFixture("unknown"), SafeTaskError);

  for (const fixture of INTERNAL_TEXT_TASK_FIXTURES) {
    const definition = getInternalTextTaskFixtureDefinition(fixture);
    const fixtureRequest = parseAITaskRequest({
      task: "editor.requirements_parse",
      provider: "deepseek",
      input: definition.input,
    });
    if (definition.expected.canonicalValidation === "PASS") {
      const valid = await executeInternalTextTaskFixture(USER_A, fixtureRequest, fixture);
      const validData = (valid.result as { data: Record<string, unknown> }).data;
      assert.equal(valid.ok, true);
      assert.equal(definition.response.kind, "canonical");
      if (definition.response.kind !== "canonical") throw new Error("success fixture must contain canonical data");
      assert.deepEqual(validData, definition.response.content);
      const actions = validData.actions as Array<Record<string, unknown>>;
      assert.deepEqual(actions.map((action) => action.type), definition.expected.actionTypes);
      const application = createInternalTextTaskFixtureApplicationContext(fixture);
      const childIds = [...application.childIds];
      const apply = () => applyAIEditingPlan(validData, {
        project: application.project as EditorProject,
        ownedAssetIds: new Set(application.ownedAssetIds),
        audioSourceDurationMs: application.audioSourceDurationMs,
        nowIso: "2026-10-18T00:00:00.000Z",
        createClipId: () => childIds.shift() ?? crypto.randomUUID(),
      });
      if (definition.expected.deterministicApplication === "PASS") {
        const applied = apply();
        assert.deepEqual(applied.applied.map((item) => item.type), definition.expected.actionTypes);
        if (definition.expected.deterministicResult) {
          const clips = applied.project.tracks.find((track) => track.id === "video-main")?.clips ?? [];
          if (definition.expected.deterministicResult.clipIds) {
            assert.deepEqual(clips.map((clip) => clip.id), definition.expected.deterministicResult.clipIds);
          }
          assert.deepEqual(
            clips.map((clip) => [clip.timelineStartMs, clip.timelineEndMs]),
            definition.expected.deterministicResult.timelineRangesMs,
          );
          assert.deepEqual(
            clips.map((clip) => [clip.sourceInMs, clip.sourceOutMs]),
            definition.expected.deterministicResult.sourceRangesMs,
          );
          assert.deepEqual(
            clips.map((clip) => averageSpeed(clip.speedCurve)),
            definition.expected.deterministicResult.playbackRates,
          );
        }
        if (definition.expected.deterministicCaptionResult) {
          assert.deepEqual(applied.project.captions.map((caption) => [caption.id, caption.text, caption.startMs, caption.endMs]),
            definition.expected.deterministicCaptionResult);
        }
      } else {
        assert.throws(apply);
      }
      continue;
    }

    const error = await captureTaskError(() => executeInternalTextTaskFixture(USER_A, fixtureRequest, fixture));
    const operator = textTaskOperatorDiagnostic(error, {
      requestId: "11111111-2222-4333-8444-555555555555",
      task: fixtureRequest.task,
      provider: fixtureRequest.provider,
      model: DEEPSEEK_TASK_MODEL,
      requestStartedAtMs: 100,
      now: () => 125,
    });
    assert.equal(operator.failure_class, definition.expected.safeDiagnosticClass);
    assert.equal(operator.safe_error_code, definition.expected.safeErrorCode);
    assert.equal(operator.provider_response_received, true);
    assert.equal(operator.canonical_validation_reached, definition.expected.safeDiagnosticClass === "CANONICAL_SCHEMA_ERROR");
    assert.equal(error.diagnostic?.providerCallCount, 0);
  }
});

test("REORDER_CLIP remote fixtures cover ordering, membership, enums, aliases, mixed plans, and safe context", () => {
  assert.match(textDiagnosticVerifierSource, /deterministicResult\.clipIds/);
  assert.doesNotMatch(textDiagnosticVerifierSource, /valid_reorder_c_before_a/);

  const deterministicPasses = [
    ["valid_reorder_c_before_a", ["clip-c", "clip-a", "clip-b"]],
    ["valid_reorder_a_after_c", ["clip-b", "clip-c", "clip-a"]],
    ["valid_reorder_b_after_c", ["clip-a", "clip-c", "clip-b", "clip-d"]],
    ["valid_reorder_already_in_position", ["clip-a", "clip-b", "clip-c"]],
    ["valid_reorder_speed_adjusted_context", ["clip-c", "clip-a", "clip-b"]],
    ["valid_reorder_existing_split_child", ["split-left-existing", "clip-b", "split-right-existing"]],
    ["valid_speed_and_reorder", ["clip-b", "clip-a", "clip-c"]],
    ["valid_reorder_full_pipeline", ["clip-b", "clip-a", "clip-c"]],
  ] as const;
  for (const [fixture, clipIds] of deterministicPasses) {
    const expected = getInternalTextTaskFixtureDefinition(fixture).expected;
    assert.equal(expected.canonicalValidation, "PASS");
    assert.equal(expected.deterministicApplication, "PASS");
    assert.deepEqual(expected.deterministicResult?.clipIds, clipIds);
  }

  const deterministicRejects = [
    "invalid_reorder_unknown_target", "invalid_reorder_invented_target",
    "invalid_reorder_raw_url_target", "invalid_reorder_non_context_target",
    "invalid_reorder_unknown_reference", "invalid_reorder_invented_reference",
    "invalid_reorder_raw_url_reference", "invalid_reorder_non_context_reference",
    "invalid_reorder_self", "invalid_reorder_future_child_after_split", "invalid_speed_and_reorder",
  ] as const;
  for (const fixture of deterministicRejects) {
    const expected = getInternalTextTaskFixtureDefinition(fixture).expected;
    assert.equal(expected.canonicalValidation, "PASS");
    assert.equal(expected.deterministicApplication, "REJECT");
  }

  const schemaRejects = [
    "invalid_reorder_lowercase_placement", "invalid_reorder_lowercase_after",
    "invalid_reorder_left_placement", "invalid_reorder_right_placement",
    "invalid_reorder_start_placement", "invalid_reorder_end_placement",
    "invalid_reorder_move_alias", "invalid_reorder_reposition_alias",
    "invalid_reorder_change_order_alias", "invalid_reorder_sort_alias",
  ] as const;
  for (const fixture of schemaRejects) {
    const expected = getInternalTextTaskFixtureDefinition(fixture).expected;
    assert.equal(expected.canonicalValidation, "REJECT");
    assert.equal(expected.safeDiagnosticClass, "CANONICAL_SCHEMA_ERROR");
    assert.equal(expected.safeErrorCode, "PROVIDER_SCHEMA_MISMATCH");
  }

  const ordinal = getInternalTextTaskFixtureDefinition("valid_reorder_ordinal_context");
  const ordinalContext = JSON.parse(ordinal.input.editorContext) as { clips: Array<{ id: string }> };
  assert.deepEqual(ordinalContext.clips.map((clip) => clip.id), ["clip-a", "clip-b", "clip-c"]);
  assert.equal(ordinal.input.editingRequirement, "把第二个视频片段移动到第一个视频片段前面。");

  const pure = getInternalTextTaskFixtureDefinition("valid_reorder_pure_contract");
  assert.equal(pure.response.kind, "canonical");
  if (pure.response.kind !== "canonical") throw new Error("pure reorder fixture must be canonical");
  const pureAction = (pure.response.content.actions as Array<Record<string, unknown>>)[0];
  assert.deepEqual(Object.keys(pureAction).sort(), [
    "assetId", "placement", "reason", "referenceId", "targetId", "type",
  ]);
  assert.equal(pureAction.type, "REORDER_CLIP");

  const speed = getInternalTextTaskFixtureDefinition("valid_reorder_speed_adjusted_context");
  assert.deepEqual(speed.expected.deterministicResult?.playbackRates, [1.25, 1, 2]);
  const futureChild = getInternalTextTaskFixtureDefinition("invalid_reorder_future_child_after_split");
  assert.deepEqual(futureChild.expected.actionTypes, ["SPLIT_CLIP", "REORDER_CLIP"]);
  const mixed = getInternalTextTaskFixtureDefinition("valid_speed_and_reorder");
  assert.deepEqual(mixed.expected.actionTypes, ["SET_CLIP_PLAYBACK_SPEED", "REORDER_CLIP"]);
});

test("dedicated split fixtures cover deterministic bounds, invented targets, and speed-aware mapping", async () => {
  const deterministicRejects = [
    "invalid_split_clip_exact_end",
    "invalid_split_clip_after_end",
    "invalid_split_clip_min_left_99ms",
    "invalid_split_clip_min_right_99ms",
    "invented_split_clip_target",
  ] as const;
  const deterministicPasses = [
    "valid_split_clip_min_left_100ms",
    "valid_split_clip_min_right_100ms",
    "valid_split_clip_speed_2x_at_3s",
  ] as const;
  const schemaRejects = [
    "invalid_split_clip_nan_string",
    "invalid_split_clip_infinity_string",
  ] as const;

  for (const fixture of deterministicRejects) {
    const definition = getInternalTextTaskFixtureDefinition(fixture);
    assert.equal(definition.expected.canonicalValidation, "PASS");
    assert.equal(definition.expected.deterministicApplication, "REJECT");
  }
  for (const fixture of deterministicPasses) {
    const definition = getInternalTextTaskFixtureDefinition(fixture);
    assert.equal(definition.expected.canonicalValidation, "PASS");
    assert.equal(definition.expected.deterministicApplication, "PASS");
  }
  for (const fixture of schemaRejects) {
    const definition = getInternalTextTaskFixtureDefinition(fixture);
    assert.equal(definition.expected.canonicalValidation, "REJECT");
    assert.equal(definition.expected.safeDiagnosticClass, "CANONICAL_SCHEMA_ERROR");
    assert.equal(definition.expected.safeErrorCode, "PROVIDER_SCHEMA_MISMATCH");
  }

  const speedFixture = "valid_split_clip_speed_2x_at_3s" as const;
  const speedDefinition = getInternalTextTaskFixtureDefinition(speedFixture);
  const speedRequest = parseAITaskRequest({
    task: "editor.requirements_parse",
    provider: "deepseek",
    input: speedDefinition.input,
  });
  const speedResponse = await executeInternalTextTaskFixture(USER_A, speedRequest, speedFixture);
  const speedApplication = createInternalTextTaskFixtureApplicationContext(speedFixture);
  const childIds = [...speedApplication.childIds];
  const applied = applyAIEditingPlan((speedResponse.result as { data: Record<string, unknown> }).data, {
    project: speedApplication.project as EditorProject,
    ownedAssetIds: new Set(speedApplication.ownedAssetIds),
    audioSourceDurationMs: speedApplication.audioSourceDurationMs,
    createClipId: () => childIds.shift()!,
  });
  const children = applied.project.tracks.find((track) => track.id === "video-main")!.clips;
  assert.deepEqual(children.map((clip) => [clip.timelineStartMs, clip.timelineEndMs]), [[0, 3_000], [3_000, 5_000]]);
  assert.deepEqual(children.map((clip) => [clip.sourceInMs, clip.sourceOutMs]), [[0, 6_000], [6_000, 10_000]]);
  assert.deepEqual(children.map((clip) => averageSpeed(clip.speedCurve)), [2, 2]);
  const speedActions = speedDefinition.response.kind === "canonical"
    ? speedDefinition.response.content.actions as Array<Record<string, unknown>>
    : [];
  assert.equal(speedActions[0]?.splitAtSeconds, 3);
});

test("internal validation context is allowlisted only to TokenHub music.generate", async () => {
  const request = parseAITaskRequest({
    task: "music.creative_brief",
    provider: "deepseek",
    input: validInputs["music.creative_brief"],
  });
  let credentialReads = 0;
  await expectTaskError(() => executeAITaskRequest(USER_A, request, {
    repository: { async getSavedCredential() { credentialReads += 1; return null; } },
    encryptionKey,
    executionContext: "internal_live_validation",
  }), "PROVIDER_NOT_SUPPORTED_FOR_TASK");
  assert.equal(credentialReads, 0);
});

test("music.generate validates custom lyrics and instrumental business contracts", async () => {
  const custom = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: { operationId: "op_20261001_custom_001", mode: "custom_lyrics", lyrics: "歌 词", prompt: "民谣" },
  });
  assert.equal(custom.input.mode, "custom_lyrics");
  const structuredLyrics = "[Verse]\nfixture verse\n[Chorus]\nfixture chorus\n[Bridge]\nfixture bridge";
  const labelled = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: {
      operationId: "op_20261002_structured_lyrics_001",
      mode: "custom_lyrics",
      lyrics: structuredLyrics,
      prompt: "fixture folk",
    },
  });
  assert.equal(labelled.input.lyrics, structuredLyrics);
  const instrumental = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: { operationId: "op_20261001_instrumental_001", mode: "instrumental", prompt: "钢琴纯音乐" },
  });
  assert.equal(instrumental.input.mode, "instrumental");

  const invalidInputs = [
    { operationId: "short", mode: "custom_lyrics", lyrics: "歌词" },
    { operationId: "op_20261001_custom_002", mode: "custom_lyrics" },
    { operationId: "op_20261001_instrumental_002", mode: "instrumental", prompt: "纯音乐", lyrics: "禁止" },
    { operationId: "op_20261001_custom_003", mode: "custom_lyrics", lyrics: "x".repeat(3_501) },
    { operationId: "op_20261001_instrumental_003", mode: "instrumental", prompt: "x".repeat(2_001) },
  ];
  for (const input of invalidInputs) {
    await expectTaskError(() => parseAITaskRequest({ task: "music.generate", provider: "tencent_tokenhub", input }), "INVALID_INPUT");
  }
});

test("music.generate rejects every browser-controlled Provider internal", async () => {
  for (const field of [
    "model", "endpoint", "baseURL", "output_format", "sample_rate", "bitrate", "format",
    "Authorization", "apiKey", "rawPayload", "storagePath", "timeout", "retry",
    "lyrics_optimizer", "aigc_watermark", "user_id", "userId", "state",
    "provider_call_count", "request_hash", "final_track_id",
    "audioUrl", "providerUrl", "downloadUrl", "mediaUrl",
    "diagnostics", "liveDiagnostics", "includeHostname", "internal",
    "validationMode", "internalValidation", "liveValidation", "bypassCapability", "allowUnverified",
  ]) {
    await expectTaskError(() => parseAITaskRequest({
      task: "music.generate",
      provider: "tencent_tokenhub",
      input: { ...validInputs["music.generate"], [field]: "forbidden" },
    }), "INVALID_INPUT");
  }
});

test("TokenHub music request builder owns model, endpoint and output settings", () => {
  assert.equal(TOKENHUB_MUSIC_MODEL, "minimax-music-v2.6");
  const custom = buildTencentTokenHubMusicRequest({
    operationId: "op_20261001_custom_004",
    mode: "custom_lyrics",
    lyrics: "固定歌词",
    prompt: "温暖民谣",
    title: "不进入 Provider payload",
  });
  assert.equal(custom.url, TOKENHUB_MUSIC_ENDPOINT);
  assert.equal(custom.url, "https://tokenhub.tencentmaas.com/v1/wand/minimax-music/generation");
  assert.deepEqual(custom.body, {
    model: TOKENHUB_MUSIC_MODEL,
    output_format: TOKENHUB_MUSIC_OUTPUT_FORMAT,
    audio_setting: TOKENHUB_MUSIC_AUDIO_SETTING,
    prompt: "温暖民谣",
    lyrics: "固定歌词",
    is_instrumental: false,
  });
  assert.deepEqual(JSON.parse(String(custom.init.body)), custom.body);
  assert.equal(JSON.parse(String(custom.init.body)).output_format, "url");
  assert.equal("operationId" in custom.body, false);
  assert.equal("title" in custom.body, false);

  const instrumental = buildTencentTokenHubMusicRequest({
    operationId: "op_20261001_instrumental_004",
    mode: "instrumental",
    prompt: "钢琴纯音乐",
  });
  assert.equal(instrumental.body.is_instrumental, true);
  assert.equal("lyrics" in instrumental.body, false);
});

test("TokenHub request contract uses server-owned URL output with bounded HEX compatibility", () => {
  assert.equal(TOKENHUB_MUSIC_OUTPUT_FORMAT, "url");
  assert.equal(getTaskBudget("music.generate").automaticProviderRetryCount, 0);
  assert.equal(getTaskBudget("music.generate").maxProviderCalls, 1);
  const built = buildTencentTokenHubMusicRequest({
    operationId: "op_20261002_hex_contract",
    mode: "instrumental",
    prompt: "synthetic fixture",
  });
  assert.equal(built.body.output_format, "url");
  assert.doesNotMatch(clientSource, /temporaryAudioURL|data\.audio|provider URL/i);
});

test("TokenHub live executor performs one fixed paid request without retry or raw output", async () => {
  let calls = 0;
  let capturedURL = "";
  let capturedInit: RequestInit | undefined;
  const executor = createTencentTokenHubMusicExecutor({
    fetcher: async (url, init) => {
      calls += 1;
      capturedURL = String(url);
      capturedInit = init;
      return new Response(JSON.stringify(tokenHubFixture()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const result = await executor({
    userId: USER_A,
    provider: "tencent_tokenhub",
    input: {
      operationId: "op_20261002_executor_001",
      mode: "custom_lyrics",
      lyrics: "original fixture lyrics",
      prompt: "short fixture song",
      title: "title stays in MedClip",
    },
    apiKey: "fixture-provider-key-not-real",
    serverControlledModel: TOKENHUB_MUSIC_MODEL,
    timeoutMs: TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
    automaticProviderRetryCount: 0,
    maxProviderCalls: 1,
  });
  assert.equal(calls, 1);
  assert.equal(capturedURL, TOKENHUB_MUSIC_ENDPOINT);
  assert.equal(capturedInit?.method, "POST");
  const body = JSON.parse(String(capturedInit?.body));
  assert.deepEqual(body, {
    model: TOKENHUB_MUSIC_MODEL,
    output_format: "url",
    audio_setting: TOKENHUB_MUSIC_AUDIO_SETTING,
    prompt: "short fixture song",
    lyrics: "original fixture lyrics",
    is_instrumental: false,
  });
  assert.equal("operationId" in body, false);
  assert.equal("title" in body, false);
  assert.equal(result.audioBytes.byteLength, VALID_MP3_BYTES.byteLength);
  assert.equal(JSON.stringify(result).includes(bytesToHex(VALID_MP3_BYTES)), false);
  assert.equal(getTaskBudget("music.generate").timeoutMs, 120_000);
});

test("TokenHub response-read ambiguity is classified as UNKNOWN_PROVIDER_RESULT after one call", async () => {
  let calls = 0;
  const executor = createTencentTokenHubMusicExecutor({
    fetcher: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async text() { throw new Error("safe fixture response stream failure"); },
      } as unknown as Response;
    },
  });
  await expectTaskError(
    () => executor({
      userId: USER_A,
      provider: "tencent_tokenhub",
      input: { operationId: "op_20261002_unknown_result_001", mode: "instrumental", prompt: "fixture" },
      apiKey: "fixture-provider-key-not-real",
      serverControlledModel: TOKENHUB_MUSIC_MODEL,
      timeoutMs: TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
      automaticProviderRetryCount: 0,
      maxProviderCalls: 1,
    }),
    "UNKNOWN_PROVIDER_RESULT",
  );
  assert.equal(calls, 1);
});

test("TokenHub non-2xx diagnostics classify only allowlisted provider fields", () => {
  const cases = [
    { status: 402, code: "401007", expected: "POSTPAY_NOT_ENABLED" },
    { status: 402, code: "401008", expected: "QUOTA_EXHAUSTED" },
    { status: 402, code: "403004", expected: "INSUFFICIENT_BALANCE" },
    { status: 403, code: "403002", expected: "MODEL_ACCESS_DENIED" },
    { status: 400, code: "400002", expected: "INVALID_REQUEST" },
    { status: 400, code: "400006", expected: "UNSUPPORTED_FORMAT" },
    { status: 429, code: "429001", expected: "RATE_LIMIT" },
    { status: 451, code: "451001", expected: "CONTENT_FILTERED" },
    { status: 502, code: "502001", expected: "UPSTREAM_ERROR" },
    { status: 504, code: "504001", expected: "UPSTREAM_TIMEOUT" },
  ] as const;
  for (const fixture of cases) {
    const error = createTencentTokenHubMusicHTTPError(fixture.status, {
      error: {
        code: fixture.code,
        type: "provider_error",
        source: "tokenhub",
        upstream_code: "safe_upstream_code",
        upstream_status: fixture.status,
        request_id: "req-safe-001",
        arbitrary_private_field: "raw-provider-marker",
      },
      request_id: "req-root-safe-001",
      trace_id: "trace-safe-001",
      arbitrary_root_field: "raw-root-marker",
    });
    assert.equal(error.diagnostic?.providerFailureClassification, fixture.expected);
    assert.equal(error.diagnostic?.httpStatus, fixture.status);
    assert.equal(error.diagnostic?.providerErrorCode, fixture.code);
    assert.equal(error.diagnostic?.providerErrorType, "provider_error");
    assert.equal(error.diagnostic?.providerErrorSource, "tokenhub");
    assert.equal(error.diagnostic?.providerUpstreamCode, "safe_upstream_code");
    assert.equal(error.diagnostic?.providerUpstreamStatus, String(fixture.status));
    assert.equal(error.diagnostic?.requestId, "req-safe-001");
    assert.equal(error.diagnostic?.traceId, "trace-safe-001");
    const serialized = JSON.stringify(safeTaskErrorResponse(error).body);
    assert.doesNotMatch(serialized, /raw-provider-marker|raw-root-marker|arbitrary_private_field|arbitrary_root_field/);
  }
});

test("TokenHub diagnostics safely classify MiniMax base_resp codes", () => {
  const cases = [
    { code: 1008, expected: "INSUFFICIENT_BALANCE" },
    { code: 2013, expected: "INVALID_REQUEST" },
  ] as const;
  for (const fixture of cases) {
    const error = createTencentTokenHubMusicHTTPError(502, {
      base_resp: { status_code: fixture.code, status_msg: "bounded safe status" },
    });
    assert.equal(error.diagnostic?.providerFailureClassification, fixture.expected);
    assert.equal(error.diagnostic?.minimaxBaseStatusCode, fixture.code);
    assert.equal(error.diagnostic?.minimaxBaseStatusMessage, "bounded safe status");
  }
});

test("TokenHub unknown response shape stays generic and never exposes secrets or raw fields", () => {
  const apiKey = "fixture-provider-key-not-real";
  const error = createTencentTokenHubMusicHTTPError(418, {
    unexpected: {
      raw_response: "raw-provider-response-must-not-return",
      Authorization: `Bearer ${apiKey}`,
      api_key: apiKey,
    },
    base_resp: {
      status_code: 9999999,
      status_msg: `Authorization: Bearer ${apiKey} secret=${apiKey}`,
    },
  }, [apiKey]);
  assert.equal(error.diagnostic?.providerFailureClassification, "UNKNOWN");
  assert.equal(error.diagnostic?.minimaxBaseStatusCode, undefined);
  const serialized = JSON.stringify(safeTaskErrorResponse(error).body);
  assert.doesNotMatch(serialized, new RegExp(apiKey));
  assert.doesNotMatch(serialized, /raw-provider-response-must-not-return|raw_response|Bearer fixture|Authorization: Bearer/);
});

test("music live candidate completes once and same-operation replay never calls TokenHub again", async () => {
  const operations = new InMemoryMusicOperationRepository();
  const tracks = new RecordingMusicFinalizationRepository();
  let providerCalls = 0;
  const request = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: {
      operationId: "op_20261002_service_live_001",
      mode: "custom_lyrics",
      lyrics: "short original fixture",
      prompt: "short safe fixture",
      title: "C1D fixture",
    },
  });
  const dependencies = {
      operations,
      tracks,
      async executeMusic() {
        providerCalls += 1;
        return parseTencentTokenHubMusicResponse(200, tokenHubFixture());
      },
  };

  const requestStartedAtMs = performance.now();
  const first = await executeMusicGenerationRequest(
    USER_A,
    request,
    "fixture-provider-key-not-real",
    TOKENHUB_MUSIC_MODEL,
    TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
    { credentialLookupDecryptMs: 0, requestStartedAtMs },
    dependencies,
  );
  const firstResult = first.result as { data: Record<string, unknown> };
  assert.equal(providerCalls, 1);
  assert.equal(first.metadata && (first.metadata as Record<string, unknown>).generationOccurred, true);
  assert.equal(first.metadata && (first.metadata as Record<string, unknown>).musicStage, "COMPLETED");
  assert.equal(firstResult.data.operationInitialState, "RESERVED");
  assert.equal(firstResult.data.operationState, "COMPLETED");
  assert.equal(firstResult.data.providerCallCount, 1);
  assert.equal(firstResult.data.published, false);
  assert.deepEqual(tracks.events, ["draft:create", "storage:upload", "draft:finalize"]);
  assert.equal(JSON.stringify(first).includes("fixture-provider-key-not-real"), false);
  assert.equal(JSON.stringify(first).includes(bytesToHex(VALID_MP3_BYTES)), false);

  const replay = await executeMusicGenerationRequest(
    USER_A,
    request,
    "fixture-provider-key-not-real",
    TOKENHUB_MUSIC_MODEL,
    TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
    { credentialLookupDecryptMs: 0, requestStartedAtMs: performance.now() },
    dependencies,
  );
  assert.equal(providerCalls, 1);
  assert.equal((replay.metadata as Record<string, unknown>).generationOccurred, false);
  assert.equal((replay.metadata as Record<string, unknown>).replayed, true);
  assert.equal((replay.metadata as Record<string, unknown>).musicStage, "COMPLETED");

  const conflicting = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: { ...request.input, lyrics: "different original fixture" },
  });
  await assert.rejects(
    () => executeMusicGenerationRequest(
      USER_A,
      conflicting,
      "fixture-provider-key-not-real",
      TOKENHUB_MUSIC_MODEL,
      TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
      { credentialLookupDecryptMs: 0, requestStartedAtMs: performance.now() },
      dependencies,
    ),
    (error: unknown) => error instanceof SafeTaskError && error.code === "OPERATION_CONFLICT",
  );
  assert.equal(providerCalls, 1);
});

test("music service reports finalization failures distinctly after one successful provider result", async () => {
  const operations = new InMemoryMusicOperationRepository();
  class FailingUploadRepository extends RecordingMusicFinalizationRepository {
    override async uploadAudio(input: Parameters<MusicFinalizationRepository["uploadAudio"]>[0]) {
      this.events.push("storage:upload");
      assert.equal(input.bucket, "music-audio");
      throw new Error("safe fixture finalization failure");
    }
  }
  const tracks = new FailingUploadRepository();
  let providerCalls = 0;
  const request = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: {
      operationId: "op_20261002_finalization_error_001",
      mode: "instrumental",
      prompt: "short safe fixture",
    },
  });

  await assert.rejects(
    () => executeMusicGenerationRequest(
      USER_A,
      request,
      "fixture-provider-key-not-real",
      TOKENHUB_MUSIC_MODEL,
      TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
      { credentialLookupDecryptMs: 0, requestStartedAtMs: performance.now() },
      {
        operations,
        tracks,
        async executeMusic() {
          providerCalls += 1;
          return parseTencentTokenHubMusicResponse(200, tokenHubFixture());
        },
      },
    ),
    (error: unknown) => error instanceof SafeTaskError
      && error.code === "FINALIZATION_FAILED"
      && error.diagnostic?.musicStage === "FINALIZING"
      && error.diagnostic?.providerErrorType === "STORAGE_UPLOAD_FAILED",
  );
  assert.equal(providerCalls, 1);
  assert.equal((await operations.load(USER_A, String(request.input.operationId)))?.state, "FAILED");
});

test("draft-create failure preserves trusted completed-stage diagnostics without exposing them publicly", async () => {
  const operations = new InMemoryMusicOperationRepository();
  class FailingDraftRepository extends RecordingMusicFinalizationRepository {
    override async createDraft(): Promise<never> {
      this.events.push("draft:create");
      throw new DraftCreateRejectedError();
    }
  }
  const tracks = new FailingDraftRepository();
  let providerCalls = 0;
  const request = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: {
      operationId: "op_20261009_draft_diagnostic_001",
      mode: "instrumental",
      prompt: "safe mocked finalization diagnostics",
    },
  });

  const error = await captureTaskError(() => executeMusicGenerationRequest(
    USER_A,
    request,
    "fixture-provider-key-not-real",
    TOKENHUB_MUSIC_MODEL,
    TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
    { credentialLookupDecryptMs: 0, requestStartedAtMs: performance.now() },
    {
      operations,
      tracks,
      async executeMusic() {
        providerCalls += 1;
        return await tokenHubURLProviderResult();
      },
    },
    { includeTrustedDiagnostics: true },
  ));

  assert.equal(error.code, "FINALIZATION_FAILED");
  assert.equal(error.diagnostic?.providerErrorType, "DRAFT_CREATE_FAILED");
  assert.equal(error.diagnostic?.musicStage, "FINALIZING");
  assert.equal(providerCalls, 1);
  assert.deepEqual(tracks.events, ["draft:create"]);
  assert.equal((await operations.load(USER_A, String(request.input.operationId)))?.state, "FAILED");

  const publicResponse = safeTaskErrorResponse(error);
  assert.equal("metadata" in publicResponse.body, false);
  assert.equal(JSON.stringify(publicResponse.body).includes("aigc-output-audio-file-1326893053.cos.ap-guangzhou.myqcloud.com"), false);
  const trustedResponse = safeTaskErrorResponse(error, { includeTrustedInternalDiagnostics: true });
  const trusted = (trustedResponse.body.metadata as {
    trustedInternalDiagnostics: Record<string, unknown>;
  }).trustedInternalDiagnostics;
  assert.equal(trusted.normalized_download_hostname, "aigc-output-audio-file-1326893053.cos.ap-guangzhou.myqcloud.com");
  assert.equal(trusted.dns_preflight_result, "PUBLIC_ONLY");
  assert.equal(trusted.download_http_status, 200);
  assert.equal(trusted.downloaded_bytes, VALID_MP3_BYTES.byteLength);
  assert.equal(typeof trusted.provider_generation_ms, "number");
  assert.equal(typeof trusted.download_total_ms, "number");
  assert.equal(typeof trusted.mp3_validation_ms, "number");
  assert.equal(trusted.provider_reported_music_duration_seconds, 42.5);
  assert.equal(trusted.provider_reported_music_size, VALID_MP3_BYTES.byteLength);
  assert.equal("storage_upload_ms" in trusted, false);
  assert.equal("track_finalization_ms" in trusted, false);
  assert.doesNotMatch(JSON.stringify(trusted), /https?:\/\/|audio\.mp3|fixture-not-real/i);
});

test("ambiguous draft-create result becomes UNKNOWN and never regenerates", async () => {
  const operations = new InMemoryMusicOperationRepository();
  class AmbiguousDraftRepository extends RecordingMusicFinalizationRepository {
    override async createDraft(): Promise<never> {
      this.events.push("draft:create");
      throw new TypeError("safe fixture response-loss ambiguity");
    }
  }
  const tracks = new AmbiguousDraftRepository();
  let providerCalls = 0;
  const request = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: {
      operationId: "op_20261009_draft_result_unknown",
      mode: "instrumental",
      prompt: "safe ambiguous draft fixture",
    },
  });

  const error = await captureTaskError(() => executeMusicGenerationRequest(
    USER_A,
    request,
    "fixture-provider-key-not-real",
    TOKENHUB_MUSIC_MODEL,
    TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
    { credentialLookupDecryptMs: 0, requestStartedAtMs: performance.now() },
    {
      operations,
      tracks,
      async executeMusic() {
        providerCalls += 1;
        return await tokenHubURLProviderResult();
      },
    },
  ));

  assert.equal(error.code, "FINALIZATION_FAILED");
  assert.equal(error.diagnostic?.providerErrorType, "DRAFT_CREATE_FAILED");
  assert.equal(providerCalls, 1);
  assert.deepEqual(tracks.events, ["draft:create"]);
  assert.equal((await operations.load(USER_A, String(request.input.operationId)))?.state, "UNKNOWN");
  await assert.rejects(
    () => executeMusicGenerationRequest(
      USER_A,
      request,
      "fixture-provider-key-not-real",
      TOKENHUB_MUSIC_MODEL,
      TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
      { credentialLookupDecryptMs: 0, requestStartedAtMs: performance.now() },
      {
        operations,
        tracks,
        async executeMusic() {
          providerCalls += 1;
          return await tokenHubURLProviderResult();
        },
      },
    ),
    (replayError: unknown) => replayError instanceof SafeTaskError
      && replayError.code === "PROVIDER_UNAVAILABLE",
  );
  assert.equal(providerCalls, 1);
});

test("track-finalization and operation-completion failures retain distinct safe classifications", async () => {
  class FailingTrackFinalizeRepository extends RecordingMusicFinalizationRepository {
    override async finalizeDraft() {
      this.events.push("draft:finalize");
      throw new Error("safe fixture track finalization failure");
    }
  }
  const trackOperations = new InMemoryMusicOperationRepository();
  const trackRequest = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: {
      operationId: "op_20261009_track_finalize_failure",
      mode: "instrumental",
      prompt: "safe track-finalization fixture",
    },
  });
  const trackError = await captureTaskError(() => executeMusicGenerationRequest(
    USER_A,
    trackRequest,
    "fixture-provider-key-not-real",
    TOKENHUB_MUSIC_MODEL,
    TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
    { credentialLookupDecryptMs: 0, requestStartedAtMs: performance.now() },
    {
      operations: trackOperations,
      tracks: new FailingTrackFinalizeRepository(),
      executeMusic: tokenHubURLProviderResult,
    },
  ));
  assert.equal(trackError.diagnostic?.providerErrorType, "TRACK_FINALIZATION_FAILED");
  assert.equal((await trackOperations.load(USER_A, String(trackRequest.input.operationId)))?.state, "FAILED");

  class FailingCompletionOperations extends InMemoryMusicOperationRepository {
    override async transition(input: MusicOperationTransitionInput) {
      if (input.nextState === "COMPLETED") throw new Error("safe fixture completion ambiguity");
      return await super.transition(input);
    }
  }
  const completionOperations = new FailingCompletionOperations();
  const completionRequest = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: {
      operationId: "op_20261009_completion_failure",
      mode: "instrumental",
      prompt: "safe completion fixture",
    },
  });
  const completionError = await captureTaskError(() => executeMusicGenerationRequest(
    USER_A,
    completionRequest,
    "fixture-provider-key-not-real",
    TOKENHUB_MUSIC_MODEL,
    TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
    { credentialLookupDecryptMs: 0, requestStartedAtMs: performance.now() },
    {
      operations: completionOperations,
      tracks: new RecordingMusicFinalizationRepository(),
      executeMusic: tokenHubURLProviderResult,
    },
  ));
  assert.equal(completionError.diagnostic?.providerErrorType, "OPERATION_COMPLETION_FAILED");
  assert.equal((await completionOperations.load(USER_A, String(completionRequest.input.operationId)))?.state, "UNKNOWN");
});

test("music service classifies failure to enter FINALIZING without another provider call", async () => {
  class FailingFinalizingOperations extends InMemoryMusicOperationRepository {
    override async transition(input: MusicOperationTransitionInput) {
      if (input.nextState === "FINALIZING") {
        throw new Error("safe fixture transition failure");
      }
      return await super.transition(input);
    }
  }
  const operations = new FailingFinalizingOperations();
  const tracks = new RecordingMusicFinalizationRepository();
  let providerCalls = 0;
  const request = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: {
      operationId: "op_20261002_finalizing_transition_error_001",
      mode: "instrumental",
      prompt: "short safe fixture",
    },
  });

  await assert.rejects(
    () => executeMusicGenerationRequest(
      USER_A,
      request,
      "fixture-provider-key-not-real",
      TOKENHUB_MUSIC_MODEL,
      TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
      { credentialLookupDecryptMs: 0, requestStartedAtMs: performance.now() },
      {
        operations,
        tracks,
        async executeMusic() {
          providerCalls += 1;
          return parseTencentTokenHubMusicResponse(200, tokenHubFixture());
        },
      },
    ),
    (error: unknown) => error instanceof SafeTaskError
      && error.code === "FINALIZATION_FAILED"
      && error.diagnostic?.musicStage === "FINALIZING"
      && error.diagnostic?.providerErrorType === "OPERATION_FINALIZING",
  );
  assert.equal(providerCalls, 1);
  assert.equal(tracks.events.length, 0);
});

test("ambiguous TokenHub transport failure records UNKNOWN and is never retried", async () => {
  const operations = new InMemoryMusicOperationRepository();
  const tracks = new RecordingMusicFinalizationRepository();
  let providerCalls = 0;
  const request = parseAITaskRequest({
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: {
      operationId: "op_20261002_unknown_live_001",
      mode: "instrumental",
      prompt: "short safe fixture",
    },
  });
  const dependencies = {
      operations,
      tracks,
      async executeMusic(): Promise<never> {
        providerCalls += 1;
        throw new AmbiguousMusicProviderError("NETWORK_ERROR", "safe ambiguous fixture");
      },
  };
  const run = () => executeMusicGenerationRequest(
    USER_A,
    request,
    "fixture-provider-key-not-real",
    TOKENHUB_MUSIC_MODEL,
    TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
    { credentialLookupDecryptMs: 0, requestStartedAtMs: performance.now() },
    dependencies,
  );
  await expectTaskError(run, "NETWORK_ERROR");
  assert.equal(providerCalls, 1);
  const durable = await operations.load(USER_A, String(request.input.operationId));
  assert.equal(durable?.state, "UNKNOWN");
  assert.equal(durable?.providerCallCount, 1);
  await expectTaskError(run, "PROVIDER_UNAVAILABLE");
  assert.equal(providerCalls, 1);
});

test("TokenHub response parser decodes a bounded MP3 fixture and returns safe metadata", () => {
  const parsed = parseTencentTokenHubMusicResponse(200, tokenHubFixture());
  assert.deepEqual(parsed.audioBytes, VALID_MP3_BYTES);
  assert.equal(parsed.providerReportedDurationSeconds, 42.5);
  assert.equal(parsed.serverVerifiedDurationSeconds, null);
  assert.equal(parsed.format, "mp3");
  assert.deepEqual(parsed.metadata, {
    requestId: "request-fixture",
    traceId: "trace-fixture",
    musicSampleRate: 44_100,
    musicChannel: 2,
    bitrate: 256_000,
    musicSize: VALID_MP3_BYTES.byteLength,
  });
  assert.deepEqual(parsed.usage, { input_tokens: null, output_tokens: null, total_tokens: 12 });
  assert.equal(parsed.metrics.hexCharacterLength, VALID_MP3_BYTES.byteLength * 2);
  assert.ok(parsed.metrics.hexValidationDecodeMs >= 0);
  assert.ok(parsed.metrics.mp3ValidationMs >= 0);
  assert.equal("temporaryAudioURL" in parsed, false);
});

test("TokenHub official success core accepts absent auxiliary metadata without inventing values", () => {
  const full = tokenHubFixture();
  const { usage: _usage, request_id: _requestId, trace_id: _traceId, extra_info: _extraInfo, ...core } = full;

  const withoutUsage = parseTencentTokenHubMusicResponse(200, {
    ...core,
    request_id: full.request_id,
    trace_id: full.trace_id,
    extra_info: full.extra_info,
  });
  assert.equal(withoutUsage.usage, null);

  const withoutRequestId = parseTencentTokenHubMusicResponse(200, {
    ...core,
    trace_id: full.trace_id,
    extra_info: full.extra_info,
    usage: full.usage,
  });
  assert.equal(withoutRequestId.metadata.requestId, undefined);

  const withoutTraceId = parseTencentTokenHubMusicResponse(200, {
    ...core,
    request_id: full.request_id,
    extra_info: full.extra_info,
    usage: full.usage,
  });
  assert.equal(withoutTraceId.metadata.traceId, undefined);

  const partialExtraInfo = parseTencentTokenHubMusicResponse(200, {
    ...core,
    extra_info: { music_duration: 7.5 },
  });
  assert.equal(partialExtraInfo.providerReportedDurationSeconds, 7.5);
  assert.equal(partialExtraInfo.metadata.musicSize, undefined);
  assert.equal(partialExtraInfo.audioBytes.byteLength, VALID_MP3_BYTES.byteLength);

  const minimal = parseTencentTokenHubMusicResponse(200, {
    data: { status: 2, audio: bytesToHex(VALID_MP3_BYTES) },
    base_resp: { status_code: 0 },
  });
  assert.equal(minimal.audioBytes.byteLength, VALID_MP3_BYTES.byteLength);
  assert.equal(minimal.usage, null);
});

test("TokenHub completed status and base success are strict while business failures are distinct", () => {
  const generating = tokenHubFixture();
  generating.data.status = 1;
  const generatingError = captureSyncTaskError(() => parseTencentTokenHubMusicResponse(200, generating));
  assert.equal(generatingError.code, "PROVIDER_NOT_COMPLETED");
  assert.equal(generatingError.diagnostic?.responseStatusValue, 1);
  assert.equal(generatingError.diagnostic?.musicStage, "RESPONSE_RECEIVED");

  const invalidStatus = tokenHubFixture();
  invalidStatus.data.status = "2" as unknown as number;
  const invalidStatusError = captureSyncTaskError(() => parseTencentTokenHubMusicResponse(200, invalidStatus));
  assert.equal(invalidStatusError.code, "PROVIDER_SCHEMA_MISMATCH");
  assert.equal(invalidStatusError.diagnostic?.responseStatusType, "string");

  const businessFailure = tokenHubFixture();
  businessFailure.base_resp.status_code = 1008;
  businessFailure.base_resp.status_msg = "bounded business failure";
  const businessError = captureSyncTaskError(() => parseTencentTokenHubMusicResponse(200, businessFailure));
  assert.equal(businessError.code, "PROVIDER_BUSINESS_ERROR");
  assert.equal(businessError.diagnostic?.minimaxBaseStatusCode, 1008);
  assert.equal(businessError.diagnostic?.providerFailureClassification, "INSUFFICIENT_BALANCE");
});

test("TokenHub structural diagnostics expose shape only and classify audio failures precisely", () => {
  const missingAudio = tokenHubFixture();
  const { audio: _audio, ...dataWithoutAudio } = missingAudio.data;
  missingAudio.data = dataWithoutAudio as typeof missingAudio.data;
  const missingError = captureSyncTaskError(() => parseTencentTokenHubMusicResponse(200, missingAudio));
  assert.equal(missingError.code, "PROVIDER_SCHEMA_MISMATCH");
  assert.equal(missingError.diagnostic?.responseAudioPresent, false);
  assert.equal(missingError.diagnostic?.responseAudioType, "missing");

  const wrongType = tokenHubFixture();
  wrongType.data.audio = 42 as unknown as string;
  const wrongTypeError = captureSyncTaskError(() => parseTencentTokenHubMusicResponse(200, wrongType));
  assert.equal(wrongTypeError.code, "PROVIDER_SCHEMA_MISMATCH");
  assert.equal(wrongTypeError.diagnostic?.responseAudioPresent, true);
  assert.equal(wrongTypeError.diagnostic?.responseAudioType, "number");

  const invalidHex = captureSyncTaskError(() => decodeBoundedTokenHubAudioHex("zz"));
  assert.equal(invalidHex.code, "AUDIO_REPRESENTATION_UNKNOWN");
  assert.equal(invalidHex.diagnostic?.audioRepresentation?.isPureHex, false);
  const oversized = captureSyncTaskError(() => decodeBoundedTokenHubAudioHex(
    "0".repeat(TOKENHUB_MAX_AUDIO_HEX_CHARACTERS + 2),
  ));
  assert.equal(oversized.code, "AUDIO_HEX_TOO_LARGE");

  const invalidMp3 = tokenHubFixture(bytesToHex(Uint8Array.from([1, 2, 3, 4])), 4);
  const invalidMp3Error = captureSyncTaskError(() => parseTencentTokenHubMusicResponse(200, invalidMp3));
  assert.equal(invalidMp3Error.code, "AUDIO_MP3_INVALID");
  const safeSerialized = JSON.stringify(safeTaskErrorResponse(invalidMp3Error).body);
  assert.doesNotMatch(safeSerialized, /01020304|audioBytes|raw_response/);
  assert.match(safeSerialized, /responseAudioLength/);
});

test("TokenHub ignores unknown response fields while retaining the strict success core", () => {
  const fixture = tokenHubFixture();
  const parsed = parseTencentTokenHubMusicResponse(200, {
    ...fixture,
    unknown_top_level: { raw: "must-not-be-returned" },
    data: { ...fixture.data, unknown_data_field: "ignored" },
  });
  assert.deepEqual(parsed.audioBytes, VALID_MP3_BYTES);
  assert.doesNotMatch(JSON.stringify(parsed), /unknown_top_level|unknown_data_field|must-not-be-returned/);
});

test("TokenHub audio representation classifier is structural, fail-closed, and content-free", () => {
  for (const validHex of ["00aabbcc", "00AABBCC", "00AaBbCc"]) {
    const representation = classifyTokenHubAudioRepresentation(validHex);
    assert.equal(representation.isPureHex, true);
    assert.equal(representation.isEvenLength, true);
    assert.doesNotThrow(() => decodeBoundedTokenHubAudioHex(validHex));
  }

  const cases = [
    {
      value: " 00aabb",
      code: "AUDIO_REPRESENTATION_WHITESPACE_WRAPPED",
      expected: { hasAsciiWhitespace: true, hasLeadingOrTrailingWhitespace: true, trimmedValueWouldBeHex: true },
    },
    {
      value: "00aabb ",
      code: "AUDIO_REPRESENTATION_WHITESPACE_WRAPPED",
      expected: { hasAsciiWhitespace: true, hasLeadingOrTrailingWhitespace: true, trimmedValueWouldBeHex: true },
    },
    {
      value: "00aa\nbb",
      code: "AUDIO_REPRESENTATION_WHITESPACE_WRAPPED",
      expected: { hasAsciiWhitespace: true, hasLeadingOrTrailingWhitespace: false, whitespaceRemovedValueWouldBeHex: true },
    },
    {
      value: "00 aa bb",
      code: "AUDIO_REPRESENTATION_WHITESPACE_WRAPPED",
      expected: { hasAsciiWhitespace: true, hasLeadingOrTrailingWhitespace: false, whitespaceRemovedValueWouldBeHex: true },
    },
    {
      value: "0x00aabb",
      code: "AUDIO_REPRESENTATION_0X_PREFIXED",
      expected: { has0xPrefix: true, zeroXPrefixRemovedValueWouldBeHex: true },
    },
    {
      value: "https://temporary.example.invalid/audio.mp3",
      code: "AUDIO_REPRESENTATION_UNEXPECTED_URL",
      expected: { urlLike: true, httpsUrlLike: true },
    },
    {
      value: "data:audio/mpeg;base64,SUQz",
      code: "AUDIO_REPRESENTATION_UNEXPECTED_URL",
      expected: { dataUriLike: true },
    },
    {
      value: "SUQzBA==",
      code: "AUDIO_REPRESENTATION_UNEXPECTED_BASE64",
      expected: { base64Like: true },
    },
    {
      value: "music*binary?",
      code: "AUDIO_REPRESENTATION_UNKNOWN",
      expected: { isPureHex: false },
    },
  ] as const;
  for (const fixture of cases) {
    const representation = classifyTokenHubAudioRepresentation(fixture.value);
    assert.equal(representation.audioType, "string");
    assert.equal(representation.audioCharacterLength, fixture.value.length);
    assert.equal(representation.isPureHex, false);
    for (const [key, expected] of Object.entries(fixture.expected)) {
      assert.equal(representation[key as keyof typeof representation], expected);
    }
    const error = captureSyncTaskError(() => decodeBoundedTokenHubAudioHex(fixture.value));
    assert.equal(error.code, fixture.code);
    const safeBody = safeTaskErrorResponse(error).body;
    const safeDiagnostic = safeBody.diagnostic as Record<string, unknown>;
    const safeRepresentation = safeDiagnostic.audioRepresentation as Record<string, unknown>;
    assert.equal(safeRepresentation.audioCharacterLength, fixture.value.length);
    assert.equal(safeRepresentation.isPureHex, false);
    const safeResponse = JSON.stringify(safeBody);
    assert.equal(safeResponse.includes(fixture.value), false);
    assert.doesNotMatch(safeResponse, /raw_response|audioValue|audioContent/);
  }

  const urlClasses = classifyTokenHubAudioRepresentation("https://temporary.example.invalid/audio.mp3")
    .nonHexCharacterClasses;
  assert.ok(urlClasses.colon > 0);
  assert.ok(urlClasses.slash > 0);
  assert.ok(urlClasses.dot > 0);

  assert.equal(captureSyncTaskError(() => decodeBoundedTokenHubAudioHex("")).code, "AUDIO_HEX_INVALID");
  assert.equal(captureSyncTaskError(() => decodeBoundedTokenHubAudioHex("abc")).code, "AUDIO_HEX_ODD_LENGTH");
  const oversized = "0".repeat(TOKENHUB_MAX_AUDIO_HEX_CHARACTERS + 2);
  assert.equal(captureSyncTaskError(() => decodeBoundedTokenHubAudioHex(oversized)).code, "AUDIO_HEX_TOO_LARGE");
  const decodedOversized = new Uint8Array(TOKENHUB_MAX_AUDIO_BYTES + 1);
  assert.equal(
    captureSyncTaskError(() => assertDecodedTokenHubAudioSize(decodedOversized)).code,
    "AUDIO_DECODED_TOO_LARGE",
  );
});

test("TokenHub MP3 validation rejects HTML, JSON and random data", () => {
  const fixtures = [
    new TextEncoder().encode("<html>not audio</html>"),
    new TextEncoder().encode('{"error":"not audio"}'),
    Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05]),
  ];
  for (const fixture of fixtures) {
    assert.throws(() => assertDefensibleMp3(fixture));
    assert.throws(() => parseTencentTokenHubMusicResponse(200, tokenHubFixture(bytesToHex(fixture), fixture.byteLength)));
  }
  assert.doesNotThrow(() => assertDefensibleMp3(VALID_MP3_BYTES));
  assert.doesNotThrow(() => assertDefensibleMp3(VALID_ID3_MP3_BYTES));
  assert.doesNotThrow(() => assertDefensibleMp3(VALID_MPEG2_MP3_BYTES));
  assert.equal(
    parseTencentTokenHubMusicResponse(
      200,
      tokenHubFixture(bytesToHex(VALID_ID3_MP3_BYTES), VALID_ID3_MP3_BYTES.byteLength),
    ).audioBytes.byteLength,
    VALID_ID3_MP3_BYTES.byteLength,
  );
  assert.equal(
    parseTencentTokenHubMusicResponse(
      200,
      tokenHubFixture(bytesToHex(VALID_MPEG2_MP3_BYTES), VALID_MPEG2_MP3_BYTES.byteLength),
    ).audioBytes.byteLength,
    VALID_MPEG2_MP3_BYTES.byteLength,
  );
});

test("TokenHub response parser fails closed on reported music_size mismatch", () => {
  const error = captureSyncTaskError(() => parseTencentTokenHubMusicResponse(
    200,
    tokenHubFixture(bytesToHex(VALID_MP3_BYTES), VALID_MP3_BYTES.byteLength + 1),
  ));
  assert.equal(error.code, "AUDIO_SIZE_MISMATCH");
  assert.equal(error.diagnostic?.musicStage, "HEX_DECODED");
});

test("TokenHub audio-contract failures never collapse into the generic schema bucket", () => {
  const failures = [
    captureSyncTaskError(() => decodeBoundedTokenHubAudioHex("zz")),
    captureSyncTaskError(() => decodeBoundedTokenHubAudioHex("abc")),
    captureSyncTaskError(() => decodeBoundedTokenHubAudioHex("0".repeat(TOKENHUB_MAX_AUDIO_HEX_CHARACTERS + 2))),
    captureSyncTaskError(() => parseTencentTokenHubMusicResponse(
      200,
      tokenHubFixture(bytesToHex(Uint8Array.from([1, 2, 3, 4])), 4),
    )),
    captureSyncTaskError(() => parseTencentTokenHubMusicResponse(
      200,
      tokenHubFixture(bytesToHex(VALID_MP3_BYTES), VALID_MP3_BYTES.byteLength + 1),
    )),
  ];
  assert.deepEqual(
    failures.map((error) => error.code),
    ["AUDIO_REPRESENTATION_UNKNOWN", "AUDIO_HEX_ODD_LENGTH", "AUDIO_HEX_TOO_LARGE", "AUDIO_MP3_INVALID", "AUDIO_SIZE_MISMATCH"],
  );
  assert.equal(failures.some((error) => error.code === "PROVIDER_SCHEMA_MISMATCH"), false);
});

test("music request hash is canonical, deterministic and non-reversible", async () => {
  const first = await hashMusicGenerationRequest("tencent_tokenhub", {
    operationId: "op_20261002_hash_a",
    mode: "custom_lyrics",
    lyrics: " line one\r\nline two ",
    prompt: " warm ",
  });
  const second = await hashMusicGenerationRequest("tencent_tokenhub", {
    operationId: "op_20261002_hash_b",
    mode: "custom_lyrics",
    lyrics: "line one\nline two",
    prompt: "warm",
  });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first.includes("line"), false);
});

test("durable operation reservation reuses same payload and rejects different payload", async () => {
  const repository = new InMemoryMusicOperationRepository();
  const input = {
    operationId: "op_20261002_reserve_001",
    mode: "custom_lyrics" as const,
    lyrics: "fixture lyrics",
    prompt: "fixture prompt",
  };
  const first = await reserveMusicGenerationOperation(USER_A, input, repository);
  const replay = await reserveMusicGenerationOperation(USER_A, input, repository);
  assert.equal(first.reused, false);
  assert.equal(replay.reused, true);
  assert.equal(first.operation.id, replay.operation.id);
  await assert.rejects(
    () => reserveMusicGenerationOperation(USER_A, { ...input, lyrics: "different lyrics" }, repository),
    (error: unknown) => error instanceof MusicOperationError && error.code === "OPERATION_CONFLICT",
  );
});

test("concurrent reservation and provider transition suppress duplicate paid calls", async () => {
  const repository = new InMemoryMusicOperationRepository();
  const input = {
    operationId: "op_20261002_concurrent_001",
    mode: "instrumental" as const,
    prompt: "fixture piano",
  };
  const reservations = await Promise.all([
    reserveMusicGenerationOperation(USER_A, input, repository),
    reserveMusicGenerationOperation(USER_A, input, repository),
  ]);
  assert.equal(repository.rows.size, 1);
  assert.deepEqual(reservations.map((item) => item.reused).sort(), [false, true]);
  const transitions = await Promise.allSettled([
    markMusicProviderInFlight(repository, reservations[0].operation),
    markMusicProviderInFlight(repository, reservations[1].operation),
  ]);
  assert.equal(transitions.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(transitions.filter((item) => item.status === "rejected").length, 1);
  const durable = await repository.load(USER_A, input.operationId);
  assert.equal(durable?.providerCallCount, 1);
  assert.equal(durable?.state, "PROVIDER_IN_FLIGHT");
});

test("terminal music states never automatically regenerate", async () => {
  for (const terminal of ["COMPLETED", "FAILED", "UNKNOWN"] as const) {
    const operation: MusicGenerationOperation = {
      id: crypto.randomUUID(),
      userId: USER_A,
      operationId: `op_20261002_terminal_${terminal.toLowerCase()}`,
      task: "music.generate",
      provider: "tencent_tokenhub",
      requestHash: "a".repeat(64),
      state: terminal,
      providerCallCount: 1,
      providerRequestId: null,
      providerTraceId: null,
      finalTrackId: terminal === "COMPLETED" ? "33333333-3333-4333-8333-333333333333" : null,
      failureCode: terminal === "COMPLETED" ? null : "TERMINAL_FIXTURE",
      failureDiagnostics: null,
      createdAt: "2026-10-02T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:01.000Z",
    };
    assert.equal(canIssueMusicProviderCall(operation), false);
    await assert.rejects(async () => {
      await markMusicProviderInFlight(new InMemoryMusicOperationRepository(), operation);
    });
  }
});

test("identical operation IDs remain isolated by authenticated owner", async () => {
  const repository = new InMemoryMusicOperationRepository();
  const input = {
    operationId: "op_20261002_owner_001",
    mode: "instrumental" as const,
    prompt: "fixture",
  };
  const userA = await reserveMusicGenerationOperation(USER_A, input, repository);
  const userB = await reserveMusicGenerationOperation(USER_B, input, repository);
  assert.notEqual(userA.operation.id, userB.operation.id);
  assert.equal(repository.rows.size, 2);
});

test("music operation lifecycle persists exactly one paid call before durable completion", async () => {
  const repository = new InMemoryMusicOperationRepository();
  const { finalizing } = await createFinalizingMusicOperation(
    repository,
    "op_20261002_lifecycle_001",
  );
  assert.equal(finalizing.state, "FINALIZING");
  assert.equal(finalizing.providerCallCount, 1);
  assert.equal(finalizing.providerRequestId, "request-fixture");
  assert.equal(finalizing.providerTraceId, "trace-fixture");

  const completed = await markMusicOperationCompleted(
    repository,
    finalizing,
    "33333333-3333-4333-8333-333333333333",
  );
  assert.equal(completed.state, "COMPLETED");
  assert.equal(completed.providerCallCount, 1);
  assert.equal(completed.finalTrackId, "33333333-3333-4333-8333-333333333333");
  assert.equal(canIssueMusicProviderCall(completed), false);
});

test("generated music finalization is owner-bound, canonical, unpublished and completes last", async () => {
  const operations = new InMemoryMusicOperationRepository();
  const { input, finalizing } = await createFinalizingMusicOperation(
    operations,
    "op_20261002_finalize_001",
  );
  const events: string[] = [];
  const originalTransition = operations.transition.bind(operations);
  operations.transition = async (transition) => {
    events.push(`operation:${transition.nextState}`);
    return await originalTransition(transition);
  };
  const trackId = "33333333-3333-4333-8333-333333333333";
  const path = canonicalGeneratedMusicAudioPath(USER_A, trackId);
  const tracks: MusicFinalizationRepository = {
    async createDraft(draft) {
      events.push("draft:create");
      assert.deepEqual(draft, {
        userId: USER_A,
        title: "Safe generated draft",
        artistName: "MedClip AI",
        published: false,
      });
      return { id: trackId, userId: USER_A, published: false };
    },
    async uploadAudio(upload) {
      events.push("storage:upload");
      assert.equal(upload.bucket, GENERATED_MUSIC_BUCKET);
      assert.equal(upload.path, path);
      assert.equal(upload.contentType, "audio/mpeg");
      assert.equal(upload.upsert, false);
      assert.deepEqual(upload.bytes, VALID_MP3_BYTES);
    },
    async finalizeDraft(draft) {
      events.push("draft:finalize");
      assert.deepEqual(draft, {
        trackId,
        userId: USER_A,
        audioPath: path,
        durationSeconds: null,
        published: false,
      });
    },
    async deleteAudio() {
      assert.fail("successful finalization must not delete audio");
    },
    async deleteDraft() {
      assert.fail("successful finalization must not delete its draft");
    },
  };

  const finalized = await finalizeGeneratedMusic(
    USER_A,
    finalizing,
    input,
    parseTencentTokenHubMusicResponse(200, tokenHubFixture()),
    { tracks, operations },
  );

  assert.deepEqual(events, [
    "draft:create",
    "storage:upload",
    "draft:finalize",
    "operation:COMPLETED",
  ]);
  const { metrics, ...safeFinalized } = finalized;
  assert.deepEqual(safeFinalized, {
    trackId,
    bucket: "music-audio",
    path,
    published: false,
    providerReportedDurationSeconds: 42.5,
    serverVerifiedDurationSeconds: null,
  });
  assert.ok(metrics.storageUploadMs >= 0);
  assert.ok(metrics.trackFinalizationMs >= 0);
  assert.equal((await operations.load(USER_A, input.operationId))?.state, "COMPLETED");
  assert.equal(JSON.stringify(finalized).includes("http"), false);
});

test("upload failure removes the exact canonical object and draft without completing", async () => {
  const operations = new InMemoryMusicOperationRepository();
  const { input, finalizing } = await createFinalizingMusicOperation(
    operations,
    "op_20261002_upload_failure",
  );
  const trackId = "33333333-3333-4333-8333-333333333333";
  const path = canonicalGeneratedMusicAudioPath(USER_A, trackId);
  const events: string[] = [];
  const tracks: MusicFinalizationRepository = {
    async createDraft() {
      events.push("draft:create");
      return { id: trackId, userId: USER_A, published: false };
    },
    async uploadAudio() {
      events.push("storage:upload");
      throw new Error("safe fixture upload failure");
    },
    async finalizeDraft() { assert.fail("database finalization must not run"); },
    async deleteAudio(bucket, targetPath) {
      events.push("storage:delete");
      assert.equal(bucket, GENERATED_MUSIC_BUCKET);
      assert.equal(targetPath, path);
    },
    async deleteDraft(userId, targetTrackId) {
      events.push("draft:delete");
      assert.equal(userId, USER_A);
      assert.equal(targetTrackId, trackId);
    },
  };

  await assert.rejects(
    () => finalizeGeneratedMusic(
      USER_A,
      finalizing,
      input,
      parseTencentTokenHubMusicResponse(200, tokenHubFixture()),
      { tracks, operations },
    ),
    (error: unknown) => error instanceof MusicFinalizationError
      && error.stage === "STORAGE_UPLOAD"
      && error.operationState === "FAILED",
  );
  assert.deepEqual(events, ["draft:create", "storage:upload", "storage:delete", "draft:delete"]);
  assert.equal((await operations.load(USER_A, input.operationId))?.state, "FAILED");
});

test("database finalization failure compensates storage before draft and never completes", async () => {
  const operations = new InMemoryMusicOperationRepository();
  const { input, finalizing } = await createFinalizingMusicOperation(
    operations,
    "op_20261002_database_failure",
  );
  const trackId = "33333333-3333-4333-8333-333333333333";
  const events: string[] = [];
  const tracks: MusicFinalizationRepository = {
    async createDraft() {
      events.push("draft:create");
      return { id: trackId, userId: USER_A, published: false };
    },
    async uploadAudio() { events.push("storage:upload"); },
    async finalizeDraft() {
      events.push("draft:finalize");
      throw new Error("safe fixture database failure");
    },
    async deleteAudio() { events.push("storage:delete"); },
    async deleteDraft() { events.push("draft:delete"); },
  };

  await assert.rejects(
    () => finalizeGeneratedMusic(
      USER_A,
      finalizing,
      input,
      parseTencentTokenHubMusicResponse(200, tokenHubFixture()),
      { tracks, operations },
    ),
    (error: unknown) => error instanceof MusicFinalizationError
      && error.stage === "DATABASE_FINALIZE"
      && error.operationState === "FAILED",
  );
  assert.deepEqual(events, [
    "draft:create",
    "storage:upload",
    "draft:finalize",
    "storage:delete",
    "draft:delete",
  ]);
  assert.equal((await operations.load(USER_A, input.operationId))?.state, "FAILED");
  assert.equal(operations.transitions.some((transition) => transition.nextState === "COMPLETED"), false);
});

test("operation completion failure remains UNKNOWN without regenerating or exposing a public track", async () => {
  class FailingCompletionOperations extends InMemoryMusicOperationRepository {
    override async transition(input: MusicOperationTransitionInput) {
      if (input.nextState === "COMPLETED") {
        throw new Error("safe fixture completion ambiguity");
      }
      return await super.transition(input);
    }
  }
  const operations = new FailingCompletionOperations();
  const { input, finalizing } = await createFinalizingMusicOperation(
    operations,
    "op_20261009_completion_unknown",
  );
  const trackId = "33333333-3333-4333-8333-333333333333";
  const events: string[] = [];
  const tracks: MusicFinalizationRepository = {
    async createDraft() {
      events.push("draft:create");
      return { id: trackId, userId: USER_A, published: false };
    },
    async uploadAudio() { events.push("storage:upload"); },
    async finalizeDraft(draft) {
      events.push("draft:finalize");
      assert.equal(draft.published, false);
    },
    async deleteAudio() { assert.fail("ambiguous completion must not delete owner-bound audio"); },
    async deleteDraft() { assert.fail("ambiguous completion must not delete the unpublished draft"); },
  };

  await assert.rejects(
    () => finalizeGeneratedMusic(
      USER_A,
      finalizing,
      input,
      parseTencentTokenHubMusicResponse(200, tokenHubFixture()),
      { tracks, operations },
    ),
    (error: unknown) => error instanceof MusicFinalizationError
      && error.stage === "OPERATION_COMPLETE"
      && error.operationState === "UNKNOWN",
  );
  assert.deepEqual(events, ["draft:create", "storage:upload", "draft:finalize"]);
  const durable = await operations.load(USER_A, input.operationId);
  assert.equal(durable?.state, "UNKNOWN");
  assert.equal(durable && canIssueMusicProviderCall(durable), false);
});

test("uncertain compensating cleanup records UNKNOWN and forbids regeneration", async () => {
  const operations = new InMemoryMusicOperationRepository();
  const { input, finalizing } = await createFinalizingMusicOperation(
    operations,
    "op_20261002_cleanup_unknown",
  );
  const tracks: MusicFinalizationRepository = {
    async createDraft() {
      return {
        id: "33333333-3333-4333-8333-333333333333",
        userId: USER_A,
        published: false,
      };
    },
    async uploadAudio() { throw new Error("safe fixture upload ambiguity"); },
    async finalizeDraft() { assert.fail("database finalization must not run"); },
    async deleteAudio() { throw new Error("safe fixture cleanup ambiguity"); },
    async deleteDraft() {},
  };

  await assert.rejects(
    () => finalizeGeneratedMusic(
      USER_A,
      finalizing,
      input,
      parseTencentTokenHubMusicResponse(200, tokenHubFixture()),
      { tracks, operations },
    ),
    (error: unknown) => error instanceof MusicFinalizationError
      && error.operationState === "UNKNOWN",
  );
  const durable = await operations.load(USER_A, input.operationId);
  assert.equal(durable?.state, "UNKNOWN");
  assert.equal(durable && canIssueMusicProviderCall(durable), false);
});

test("migration 007 is private, owner-bound, unique and service-role only", () => {
  const migration = readFileSync(
    new URL("../../supabase/migrations/007_music_generation_operations.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /medclip_private\.music_generation_operations/);
  assert.match(migration, /unique \(user_id, operation_id\)/i);
  assert.match(migration, /provider_call_count between 0 and 1/i);
  assert.match(migration, /'RESERVED'[\s\S]*'PROVIDER_IN_FLIGHT'[\s\S]*'FINALIZING'[\s\S]*'COMPLETED'[\s\S]*'FAILED'[\s\S]*'UNKNOWN'/);
  assert.match(migration, /revoke all on table medclip_private\.music_generation_operations from public, anon, authenticated/i);
  assert.match(migration, /grant execute[\s\S]*to service_role/i);
  assert.match(migration, /references auth\.users \(id\) on delete cascade/i);
  assert.match(migration, /references public\.music_tracks \(id\) on delete set null/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /security definer[\s\S]*set search_path = ''/i);
  assert.doesNotMatch(migration, /api_key|authorization|raw_provider_response|raw_provider_url/i);
});

test("remote music operation verifier is provider-free, owner-isolated and cleanup guarded", () => {
  assert.match(musicOperationVerifierSource, /medclip_reserve_music_generation_operation/);
  assert.match(musicOperationVerifierSource, /medclip_transition_music_generation_operation/);
  assert.match(musicOperationVerifierSource, /UNIQUE constraint and ON CONFLICT contract/);
  assert.match(musicOperationVerifierSource, /assertBrowserDenied/);
  assert.match(musicOperationVerifierSource, /finally\s*\{/);
  assert.match(musicOperationVerifierSource, /FINAL TEST MUSIC OPERATIONS REMAIN/);
  assert.match(musicOperationVerifierSource, /createTrackFixture\(userAClient, userAId/);
  assert.match(musicOperationVerifierSource, /\.insert\(\{[\s\S]*user_id:\s*userId[\s\S]*\.select\("id,user_id,published"\)/);
  assert.match(musicOperationVerifierSource, /NONEXISTENT FINAL TRACK FK = PASS/);
  assert.match(musicOperationVerifierSource, /expectSQLFailure\([\s\S]*missingTrackId[\s\S]*"23503"/);
  assert.match(musicOperationVerifierSource, /CROSS-USER FINAL TRACK = BLOCKED BY RLS \+ SERVER-ONLY RPC/);
  assert.match(musicOperationVerifierSource, /FINAL TEST MUSIC TRACKS REMAIN/);
  assert.match(musicOperationVerifierSource, /FINAL TEST STORAGE OBJECTS REMAIN/);
  assert.match(musicOperationVerifierSource, /INDUCED FAILURE CLEANUP/);
  assert.doesNotMatch(musicOperationVerifierSource, /const trackId = assertUUID\(randomUUID\(\), "Verifier track ID"\)/);
  assert.doesNotMatch(musicOperationVerifierSource, /delete from public\.music_tracks[\s\S]*title like/);
  assert.doesNotMatch(musicOperationVerifierSource, /tokenhub\.tencentmaas\.com|\/v1\/models|wand\/minimax-music\/generation/i);
  assert.doesNotMatch(musicOperationVerifierSource, /SERVICE_ROLE|SUPABASE_SECRET|API_KEY/i);
});

test("C1D live verifier uses one fixed operation and the existing saved credential without revalidation", () => {
  assert.match(tokenHubMusicLiveVerifierSource, /c1d_tokenhub_music_v26_diag_20261003_v6/);
  assert.doesNotMatch(tokenHubMusicLiveVerifierSource, /c1d_tokenhub_music_v26_diag_20261003_v5/);
  assert.doesNotMatch(tokenHubMusicLiveVerifierSource, /c1d_tokenhub_music_v26_retry_20261003_v4/);
  assert.doesNotMatch(tokenHubMusicLiveVerifierSource, /c1d_tokenhub_music_v26_retry_20261002_v3/);
  assert.doesNotMatch(tokenHubMusicLiveVerifierSource, /c1d_tokenhub_music_v26_retry_20261002_v2/);
  assert.doesNotMatch(tokenHubMusicLiveVerifierSource, /c1d_tokenhub_music_v26_retry_20261002_v1/);
  assert.doesNotMatch(tokenHubMusicLiveVerifierSource, /c1d_tokenhub_music_live_20261002_v1/);
  assert.doesNotMatch(tokenHubMusicLiveVerifierSource, /MEDCLIP_TEST_TOKENHUB_API_KEY|\/v1\/models/);
  assert.match(tokenHubMusicLiveVerifierSource, /same-operation replay failed/);
  assert.match(tokenHubMusicLiveVerifierSource, /OPERATION_CONFLICT/);
  assert.doesNotMatch(tokenHubMusicLiveVerifierSource, /action:\s*"(?:save|update|delete)"/);
  assert.match(tokenHubMusicLiveVerifierSource, /SAVED TOKENHUB CREDENTIAL PRESERVED/);
  assert.match(tokenHubMusicLiveVerifierSource, /AbortSignal\.timeout\(timeoutMs\)/);
  assert.doesNotMatch(tokenHubMusicLiveVerifierSource, /while\s*\(|for\s*\([^)]*retry|setInterval|retryCount/i);
  assert.doesNotMatch(tokenHubMusicLiveVerifierSource, /console\.(?:log|error)\([^\n]*(?:tokenHubAPIKey|Authorization|signedUrl)/);
  assert.doesNotMatch(tokenHubMusicLiveVerifierSource, /provider.*(?:url|response).*playback/i);
  assert.match(tokenHubMusicLiveVerifierSource, /createInternalLiveValidationProof/);
  assert.match(tokenHubMusicLiveVerifierSource, /INTERNAL_LIVE_VALIDATION_HEADER/);
  assert.match(tokenHubMusicLiveVerifierSource, /AUDIO CHARACTER LENGTH/);
  assert.match(tokenHubMusicLiveVerifierSource, /AUDIO NONHEX CHARACTER CLASSES/);
  assert.match(handlerSource, /authorizeInternalLiveValidation/);
  assert.match(handlerSource, /MEDCLIP_INTERNAL_LIVE_VALIDATION_SECRET/);
  assert.doesNotMatch(handlerSource, /searchParams.*internal|validationMode|allowUnverified/);
  assert.doesNotMatch(taskEdgeVerifierSource, /INTERNAL_LIVE_VALIDATION_HEADER|x-medclip-internal-live-validation/i);
  assert.match(taskEdgeVerifierSource, /TOKENHUB PUBLIC MUSIC = BLOCKED/);
});

test("live task definitions require TEXT_REASONING and capability dispatch uses the text executor", async () => {
  assert.equal(getTaskDefinition("music.creative_brief").capability, "TEXT_REASONING");
  assert.equal(getTaskDefinition("editor.requirements_parse").capability, "TEXT_REASONING");

  let calls = 0;
  const context = deepseekContext("music.creative_brief");
  const result = await dispatchTaskByCapability(context, {
    textReasoningExecutor: async (received) => {
      calls += 1;
      assert.equal(received, context);
      return { data: validMusicBrief, generationOccurred: true, usage: null };
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.data, validMusicBrief);
});

test("capability dispatch fails closed before executing a disabled or mismatched capability", async () => {
  let calls = 0;
  const context: AITaskExecutionContext = {
    ...deepseekContext("music.creative_brief"),
    capability: "MUSIC_GENERATION",
  };

  await expectTaskError(
    () => dispatchTaskByCapability(context, {
      textReasoningExecutor: async () => {
        calls += 1;
        return { data: validMusicBrief, generationOccurred: true, usage: null };
      },
    }),
    "PROVIDER_NOT_SUPPORTED_FOR_TASK",
  );
  assert.equal(calls, 0);
});

test("a saved own credential is required and another user's credential cannot be selected", async () => {
  const entries = new Map<string, SavedCredential>();
  entries.set(`${USER_B}:deepseek`, await savedCredential());
  const request = parseAITaskRequest({ task: "music.creative_brief", provider: "deepseek", input: validInputs["music.creative_brief"] });
  await expectTaskError(() => executeAITaskRequest(USER_A, request, { repository: repositoryFor(entries), encryptionKey }), "NOT_CONNECTED");
});

test("non-pilot tasks stop before credential or Provider access", async () => {
  let credentialReads = 0;
  const repository: TaskCredentialRepository = {
    async getSavedCredential() {
      credentialReads += 1;
      return await savedCredential("kimi");
    },
  };
  const deepseekNonPilot = parseAITaskRequest({
    task: "music.lyrics_draft",
    provider: "deepseek",
    input: validInputs["music.lyrics_draft"],
  });
  await expectTaskError(
    () => executeAITaskRequest(USER_A, deepseekNonPilot, { repository, encryptionKey }),
    "PROVIDER_NOT_SUPPORTED_FOR_TASK",
  );
  const doubaoNonPilot = parseAITaskRequest({
    task: "editor.timeline_plan",
    provider: "doubao",
    input: validInputs["editor.timeline_plan"],
  });
  await expectTaskError(
    () => executeAITaskRequest(USER_A, doubaoNonPilot, { repository, encryptionKey }),
    "PROVIDER_NOT_SUPPORTED_FOR_TASK",
  );
  const kimiNonPilot = parseAITaskRequest({
    task: "music.song_structure",
    provider: "kimi",
    input: validInputs["music.song_structure"],
  });
  await expectTaskError(
    () => executeAITaskRequest(USER_A, kimiNonPilot, { repository, encryptionKey }),
    "PROVIDER_NOT_SUPPORTED_FOR_TASK",
  );
  assert.equal(credentialReads, 0);
});

test("saved credential decrypts only server-side and one task calls one fixed provider once", async () => {
  const entries = new Map<string, SavedCredential>();
  entries.set(`${USER_A}:deepseek`, await savedCredential());
  const request = parseAITaskRequest({ task: "music.creative_brief", provider: "deepseek", input: validInputs["music.creative_brief"] });
  let calls = 0;
  const contexts: AITaskExecutionContext[] = [];
  const result = await executeAITaskRequest(USER_A, request, {
    repository: repositoryFor(entries),
    encryptionKey,
    executeTask: async (nextContext) => {
      calls += 1;
      contexts.push(nextContext);
      return {
        data: { summary: "fixture structured result", sections: ["goal", "tone"] },
        generationOccurred: true,
        usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
      };
    },
  });
  const context = contexts[0];
  assert.equal(calls, 1);
  assert.equal(context.provider, "deepseek");
  assert.equal(context.apiKey, "fixture-provider-key-not-real");
  assert.equal(context.serverControlledModel, DEEPSEEK_TASK_MODEL);
  assert.equal(context.budget.automaticProviderRetryCount, 0);
  assert.equal(context.budget.maxProviderCalls, 1);
  assert.ok(context.serverInstruction);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /fixture-provider-key-not-real|ciphertext|"iv"|encryptionKey|Authorization/);
  assert.match(serialized, /TEXT_REASONING/);
  assert.match(serialized, /generationOccurred/);
});

test("provider failure has no silent fallback and safe errors hide raw details", async () => {
  const entries = new Map<string, SavedCredential>();
  entries.set(`${USER_A}:deepseek`, await savedCredential());
  const request = parseAITaskRequest({ task: "music.creative_brief", provider: "deepseek", input: validInputs["music.creative_brief"] });
  let calls = 0;
  await assert.rejects(() => executeAITaskRequest(USER_A, request, {
    repository: repositoryFor(entries),
    encryptionKey,
    executeTask: async () => {
      calls += 1;
      throw new SafeTaskError("PROVIDER_UNAVAILABLE", "服务商暂时不可用。", 503);
    },
  }));
  assert.equal(calls, 1);
  const safe = safeTaskErrorResponse(new Error("raw provider response with secret"));
  assert.equal(safe.status, 500);
  assert.doesNotMatch(JSON.stringify(safe.body), /raw provider response|secret/);
});

test("structured output rejects secret-bearing fields and does not invent usage", async () => {
  const entries = new Map<string, SavedCredential>();
  entries.set(`${USER_A}:deepseek`, await savedCredential());
  const request = parseAITaskRequest({ task: "music.creative_brief", provider: "deepseek", input: validInputs["music.creative_brief"] });
  await expectTaskError(() => executeAITaskRequest(USER_A, request, {
    repository: repositoryFor(entries),
    encryptionKey,
    executeTask: async () => ({ data: { ciphertext: "forbidden" }, generationOccurred: false }),
  }), "INTERNAL_ERROR");
  const result = await executeAITaskRequest(USER_A, request, {
    repository: repositoryFor(entries),
    encryptionKey,
    executeTask: async () => ({ data: { summary: "safe" }, generationOccurred: false }),
  });
  assert.equal(result.usage, null);
});

test("server-side economics are fixed and browser cannot override them", async () => {
  const budget = getTaskBudget("music.creative_brief");
  assert.equal(budget.automaticProviderRetryCount, 0);
  assert.equal(budget.maxProviderCalls, 1);
  assert.equal(budget.maxOutputTokens, 900);
  assert.equal(getTaskBudget("editor.requirements_parse").maxOutputTokens, 700);
  assert.equal(budget.timeoutMs, 30_000);
  for (const field of ["maxOutputTokens", "maxProviderCalls", "automaticProviderRetryCount"]) {
    await expectTaskError(() => parseAITaskRequest({ task: "music.creative_brief", provider: "deepseek", input: validInputs["music.creative_brief"], [field]: 999 }), "INVALID_INPUT");
  }
});

test("DeepSeek pilot request is server-fixed to JSON non-thinking chat completion", () => {
  const context = deepseekContext("music.creative_brief");
  const request = buildDeepSeekTaskRequest(context);
  assert.equal(request.url, DEEPSEEK_TASK_ENDPOINT);
  assert.equal(request.init.method, "POST");
  assert.equal(request.body.model, "deepseek-flash");
  assert.deepEqual(request.body.thinking, { type: DEEPSEEK_THINKING_MODE });
  assert.equal(request.body.stream, false);
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.equal(request.body.max_tokens, 900);
  assert.match(request.body.messages[0].content, /Output valid JSON only/);
  assert.match(request.body.messages[0].content, /json/i);
  assert.match(request.body.messages[0].content, /concept/);
  assert.match(request.body.messages[0].content, /Arrays may be empty/);
  assert.match(request.body.messages[1].content, /creativeRequirement/);
  assert.doesNotMatch(request.body.messages[1].content, /systemPrompt|developerPrompt|rawMessages/);
});

test("DeepSeek creative brief accepts one valid mocked response and strips raw reasoning", async () => {
  let calls = 0;
  let capturedAuthorization = "";
  const executor = createDeepSeekTextTaskExecutor(async (_input, init) => {
    calls += 1;
    capturedAuthorization = new Headers(init?.headers).get("Authorization") ?? "";
    return deepseekResponse(validMusicBrief);
  });
  const result = await executor(deepseekContext("music.creative_brief"));
  assert.equal(calls, 1);
  assert.equal(capturedAuthorization, "Bearer fixture-provider-key-not-real");
  assert.deepEqual(result.data, validMusicBrief);
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 20, total_tokens: 32 });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /must-never-be-returned|reasoning_content|raw_provider_marker|fixture-provider-key-not-real/);
});

test("DeepSeek editor requirements parser returns preview-only structured data", async () => {
  let calls = 0;
  const executor = createDeepSeekTextTaskExecutor(async () => {
    calls += 1;
    return deepseekResponse(validEditorPlan);
  });
  const result = await executor(deepseekContext("editor.requirements_parse"));
  assert.equal(calls, 1);
  assert.deepEqual(result.data, validEditorPlan);
  assert.equal("timeline" in result.data, false);
  assert.equal("operations" in result.data, false);
});

test("DeepSeek malformed, empty, truncated, and unknown output shapes report safe stages without retry", async () => {
  const cases: Array<{ response: Response; code: string; stage: string; failureClass: string }> = [
    {
      response: new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "not-json" } }] }), { status: 200 }),
      code: "PROVIDER_INVALID_JSON",
      stage: "json_parse",
      failureClass: "CANONICAL_PARSE_ERROR",
    },
    {
      response: new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "" } }] }), { status: 200 }),
      code: "PROVIDER_EMPTY_CONTENT",
      stage: "provider_response",
      failureClass: "UPSTREAM_CONTENT_MISSING",
    },
    {
      response: deepseekResponse({ ...validMusicBrief, unexpected: "reject" }),
      code: "PROVIDER_SCHEMA_MISMATCH",
      stage: "schema_validation",
      failureClass: "CANONICAL_SCHEMA_ERROR",
    },
    {
      response: new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: JSON.stringify(validMusicBrief) } }] }), { status: 200 }),
      code: "PROVIDER_SCHEMA_MISMATCH",
      stage: "schema_validation",
      failureClass: "CANONICAL_SCHEMA_ERROR",
    },
  ];
  for (const testCase of cases) {
    let calls = 0;
    const executor = createDeepSeekTextTaskExecutor(async () => {
      calls += 1;
      return testCase.response;
    });
    const error = await captureTaskError(() => executor(deepseekContext("music.creative_brief")));
    assert.equal(error.code, testCase.code);
    assert.equal(error.diagnostic?.failureStage, testCase.stage);
    assert.equal(error.diagnostic?.failureClass, testCase.failureClass);
    assert.equal(error.diagnostic?.providerResponseReceived, true);
    assert.equal(error.diagnostic?.providerCallCount, 1);
    assert.equal(calls, 1);
  }
});

test("DeepSeek HTTP errors expose only safe diagnostic categories", async () => {
  const cases = [
    { status: 401, providerCode: "invalid_api_key", expected: "PROVIDER_AUTH_ERROR" },
    { status: 402, providerCode: "insufficient_balance", expected: "PROVIDER_PAYMENT_OR_QUOTA_ERROR" },
    { status: 429, providerCode: "rate_limit_exceeded", expected: "PROVIDER_RATE_LIMIT" },
    { status: 400, providerCode: "invalid_request_error", expected: "PROVIDER_BAD_REQUEST" },
    { status: 502, providerCode: "upstream_unavailable", expected: "PROVIDER_HTTP_ERROR" },
  ] as const;
  for (const testCase of cases) {
    let calls = 0;
    const executor = createDeepSeekTextTaskExecutor(async () => {
      calls += 1;
      return new Response(JSON.stringify({
        error: {
          code: testCase.providerCode,
          message: "raw-provider-message-must-not-return",
        },
      }), { status: testCase.status, headers: { "Content-Type": "application/json" } });
    });
    const error = await captureTaskError(() => executor(deepseekContext("music.creative_brief")));
    assert.equal(error.code, testCase.expected);
    assert.equal(error.diagnostic?.httpStatus, testCase.status);
    assert.equal(error.diagnostic?.providerErrorCode, expectedLocalHTTPCode(testCase.expected));
    assert.equal(error.diagnostic?.failureStage, "provider_response");
    assert.equal(error.diagnostic?.providerCallCount, 1);
    assert.equal(error.diagnostic?.failureClass, "UPSTREAM_HTTP_ERROR");
    assert.equal(error.diagnostic?.providerResponseReceived, true);
    assert.equal(error.diagnostic?.responseJsonParseable, false);
    assert.equal(error.diagnostic?.canonicalValidationReached, false);
    assert.equal(calls, 1);
    const safe = safeTaskErrorResponse(error);
    const serialized = JSON.stringify(safe.body);
    assert.doesNotMatch(serialized, /raw-provider-message-must-not-return|fixture-provider-key-not-real/);
  }
});

test("DeepSeek abort reports PROVIDER_TIMEOUT after one call and never retries", async () => {
  let calls = 0;
  const executor = createDeepSeekTextTaskExecutor(async (_input, init) => {
    calls += 1;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  });
  const context = deepseekContext("music.creative_brief");
  const error = await captureTaskError(() => executor({
    ...context,
    budget: { ...context.budget, timeoutMs: 1 },
  }));
  assert.equal(error.code, "PROVIDER_TIMEOUT");
  assert.equal(error.diagnostic?.failureStage, "provider_request");
  assert.equal(error.diagnostic?.providerCallCount, 1);
  assert.equal(calls, 1);
});

test("DeepSeek schema mismatch reports only expected safe field names", async () => {
  const executor = createDeepSeekTextTaskExecutor(async () => deepseekResponse({
    concept: "Safe concept",
    theme: "Safe theme",
    mood: "Safe mood",
    structure: [],
    lyricDirection: [],
    arrangementDirection: [],
  }));
  const error = await captureTaskError(() => executor(deepseekContext("music.creative_brief")));
  assert.equal(error.code, "PROVIDER_SCHEMA_MISMATCH");
  assert.deepEqual(error.diagnostic?.missingFields, ["notes"]);
  assert.deepEqual(error.diagnostic?.invalidFields, []);
  const serialized = JSON.stringify(safeTaskErrorResponse(error).body);
  assert.doesNotMatch(serialized, /reasoning_content|raw_provider_marker|must-never-be-returned/);
});

test("safeResultData preserves a validated V1 canonical plan with nested object arrays", () => {
  const plan = {
    ...validEditorPlan,
    unsupported: [{ request: "Add a transition", reason: "Transitions are unsupported in V1." }],
    metadata: { reviewed: true, score: 1, optional: null },
    transportNested: [{
      target: { clipId: "clip-a" },
      parameters: { startSeconds: 1, endSeconds: 6 },
    }],
  };
  const safe = safeResultData(plan);
  assert.deepEqual(safe, plan);
  assert.notEqual(safe.actions, plan.actions);
  assert.notEqual(safe.unsupported, plan.unsupported);
  assert.deepEqual(safe.transportNested, plan.transportNested);
});

test("safeResultData rejects unsafe, cyclic, non-plain, oversized and deeply nested values", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let tooDeep: Record<string, unknown> = { value: "leaf" };
  for (let depth = 0; depth <= SAFE_RESULT_MAX_DEPTH; depth += 1) tooDeep = { nested: tooDeep };
  const unsafeValues: unknown[] = [
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: Number.NEGATIVE_INFINITY },
    { value: () => "unsafe" },
    { value: undefined },
    { value: Symbol("unsafe") },
    { value: new Date() },
    { value: new Uint8Array([1, 2, 3]) },
    { value: "x".repeat(SAFE_RESULT_MAX_STRING_LENGTH + 1) },
    { value: Array.from({ length: SAFE_RESULT_MAX_ARRAY_LENGTH + 1 }, () => "x") },
    { value: Array.from({ length: 7 }, () => "x".repeat(10_000)) },
    Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key${index}`, "x"])),
    tooDeep,
    cyclic,
  ];
  for (const value of unsafeValues) {
    assert.throws(
      () => safeResultData(value as Record<string, never>),
      (error: unknown) => error instanceof SafeTaskError && error.code === "INTERNAL_ERROR",
    );
  }
  assert.equal(SAFE_RESULT_MAX_SERIALIZED_BYTES, 64 * 1024);
});

test("valid DeepSeek canonical plan survives provider normalization and service serialization", async () => {
  const entries = new Map<string, SavedCredential>();
  entries.set(`${USER_A}:deepseek`, await savedCredential());
  const request = parseAITaskRequest({
    task: "editor.requirements_parse",
    provider: "deepseek",
    input: validInputs["editor.requirements_parse"],
  });
  const executor = createDeepSeekTextTaskExecutor(async () => deepseekResponse({
    ...validEditorPlan,
    unsupported: [{ request: "Add a transition", reason: "Not executable in V1." }],
  }));
  const result = await executeAITaskRequest(USER_A, request, {
    repository: repositoryFor(entries),
    encryptionKey,
    executeTask: executor,
  });
  const data = (result.result as { data: Record<string, unknown> }).data;
  assert.equal(result.ok, true);
  assert.deepEqual(data.actions, validEditorPlan.actions);
  assert.deepEqual(data.unsupported, [{ request: "Add a transition", reason: "Not executable in V1." }]);
  assert.equal("timeline" in data, false);
});

test("safe result serialization failure is classified without exposing rejected data", async () => {
  const entries = new Map<string, SavedCredential>();
  entries.set(`${USER_A}:deepseek`, await savedCredential());
  const request = parseAITaskRequest({ task: "music.creative_brief", provider: "deepseek", input: validInputs["music.creative_brief"] });
  const error = await captureTaskError(() => executeAITaskRequest(USER_A, request, {
    repository: repositoryFor(entries),
    encryptionKey,
    executeTask: async () => ({ data: { api_key: "must-not-leak" }, generationOccurred: true }),
  }));
  assert.equal(error.code, "INTERNAL_ERROR");
  assert.equal(error.diagnostic?.failureClass, "SAFE_RESULT_SERIALIZATION_ERROR");
  const operator = textTaskOperatorDiagnostic(error, {
    requestId: "11111111-2222-4333-8444-555555555555",
    task: request.task,
    provider: request.provider,
    model: DEEPSEEK_TASK_MODEL,
    requestStartedAtMs: 10,
    now: () => 25,
  });
  assert.equal(operator.failure_class, "SAFE_RESULT_SERIALIZATION_ERROR");
  assert.equal(operator.request_duration_ms, 15);
  assert.doesNotMatch(JSON.stringify(operator), /must-not-leak|api_key|Authorization/);
});

test("Kimi loads only the owner's saved credential and uses the fixed server model", async () => {
  const entries = new Map<string, SavedCredential>();
  entries.set(`${USER_A}:kimi`, await savedCredential("kimi"));
  const request = parseAITaskRequest({
    task: "music.creative_brief",
    provider: "kimi",
    input: validInputs["music.creative_brief"],
  });
  let calls = 0;
  const result = await executeAITaskRequest(USER_A, request, {
    repository: repositoryFor(entries),
    encryptionKey,
    executeTask: async (context) => {
      calls += 1;
      assert.equal(context.userId, USER_A);
      assert.equal(context.provider, "kimi");
      assert.equal(context.providerResourceId, undefined);
      assert.equal(context.serverControlledModel, KIMI_TASK_MODEL);
      assert.equal(context.budget.timeoutMs, 30_000);
      assert.equal(context.apiKey, "fixture-provider-key-not-real");
      return { data: { summary: "safe fixture" }, generationOccurred: true };
    },
  });
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture-provider-key-not-real|ciphertext|Authorization/);
  await expectTaskError(
    () => executeAITaskRequest(USER_B, request, { repository: repositoryFor(entries), encryptionKey }),
    "NOT_CONNECTED",
  );
});

test("Kimi request is fixed server-side and sends no unnecessary sampling parameters", () => {
  const music = buildKimiTaskRequest(kimiContext("music.creative_brief"));
  const editor = buildKimiTaskRequest(kimiContext("editor.requirements_parse"));
  assert.equal(music.url, KIMI_TASK_ENDPOINT);
  assert.equal(music.url, "https://api.moonshot.cn/v1/chat/completions");
  assert.equal(music.init.method, "POST");
  assert.deepEqual(Object.keys(music.body).sort(), [
    "max_completion_tokens", "messages", "model", "response_format", "stream", "thinking",
  ]);
  assert.equal(music.body.model, KIMI_TASK_MODEL);
  assert.equal(editor.body.model, KIMI_TASK_MODEL);
  assert.deepEqual(music.body.thinking, { type: KIMI_THINKING_MODE });
  assert.equal(music.body.stream, false);
  assert.equal(music.body.max_completion_tokens, 900);
  assert.equal(editor.body.max_completion_tokens, 700);
  assert.deepEqual(music.body.response_format, { type: "json_object" });
  const serialized = JSON.stringify(music.body);
  assert.doesNotMatch(serialized, /"temperature"|"top_p"|"presence_penalty"|"frequency_penalty"|"n"|"apiKey"|"endpoint"|"baseURL"/);
  assert.doesNotMatch(music.body.messages[1].content, /fixture-provider-key-not-real|model|systemPrompt|rawMessages/);
});

test("Kimi creative brief returns normalized data without reasoning or raw response", async () => {
  let calls = 0;
  const executor = createKimiTextTaskExecutor(async (_input, init) => {
    calls += 1;
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-provider-key-not-real");
    return kimiResponse(validMusicBrief);
  });
  const result = await executor(kimiContext("music.creative_brief"));
  assert.equal(calls, 1);
  assert.deepEqual(result.data, validMusicBrief);
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 20, total_tokens: 32 });
  assert.doesNotMatch(JSON.stringify(result), /must-never-be-returned|reasoning_content|raw_provider_marker|fixture-provider-key-not-real/);
});

test("Kimi editor parser returns preview-only structured data", async () => {
  const executor = createKimiTextTaskExecutor(async () => kimiResponse(validEditorPlan));
  const result = await executor(kimiContext("editor.requirements_parse"));
  assert.deepEqual(result.data, validEditorPlan);
  assert.equal("timeline" in result.data, false);
  assert.equal("operations" in result.data, false);
});

test("Kimi requirements_parse keeps the shared strict prompt and bounded fence normalization", async () => {
  const request = buildKimiTaskRequest(kimiContext("editor.requirements_parse"));
  assert.match(request.body.messages[0].content, /TRIM_CLIP shape/);
  assert.match(request.body.messages[0].content, /seconds, never milliseconds/);
  const executor = createKimiTextTaskExecutor(async () => new Response(JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: { content: `\`\`\`json\n${JSON.stringify(exactFirstFiveSecondsTrimPlan)}\n\`\`\`` },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  assert.deepEqual(
    (await executor(kimiContext("editor.requirements_parse"))).data,
    exactFirstFiveSecondsTrimPlan,
  );
});

test("editor requirements prompt states the exact strict canonical contract", () => {
  const prompt = EDITOR_REQUIREMENTS_TASK_INSTRUCTION.join("\n");
  assert.match(prompt, /exactly summary, actions, unsupported, and warnings/);
  assert.match(prompt, /time-based action object must contain exactly type, targetId, assetId, startSeconds, endSeconds, and reason/);
  assert.match(prompt, /TRIM_CLIP shape/);
  assert.match(prompt, /REMOVE_CLIP shape/);
  assert.match(prompt, /SET_BACKGROUND_AUDIO_RANGE shape/);
  assert.match(prompt, /MATCH_ASSET_TO_SEGMENT shape/);
  assert.match(prompt, /SET_CLIP_PLAYBACK_SPEED shape/);
  assert.match(prompt, /SPLIT_CLIP shape/);
  assert.match(prompt, /REORDER_CLIP shape/);
  assert.match(prompt, /SET_CLIP_POSITION_SCALE shape/);
  assert.match(prompt, /SET_CAPTION_TEXT shape/);
  assert.match(prompt, /eligible:true/);
  assert.match(prompt, /Duplicate text does not identify a caption/);
  assert.match(prompt, /No selected-caption ID is supplied/);
  assert.match(prompt, /startMs, endMs, caption order, or caption count/);
  assert.match(prompt, /do not summarize, paraphrase, normalize, translate/);
  assert.match(prompt, /do not independently correct medical content/);
  assert.match(prompt, /changes only x, y, and scale and preserves crop, fit, timeline, source range, playback, asset binding, captions, and audio/);
  assert.match(prompt, /absolute final values/);
  assert.match(prompt, /0\.05/);
  assert.match(prompt, /currentClipId/);
  assert.match(prompt, /eligible visual clips/);
  assert.match(prompt, /playbackRate.*0\.25 through 4 inclusive/);
  assert.match(prompt, /explicit numeric target rate/);
  assert.match(prompt, /splitAtSeconds.*relative to the start of the target clip own displayed timeline duration/);
  assert.match(prompt, /Never provide or invent a left clip ID, right clip ID, child clip ID, new clip ID/);
  assert.match(prompt, /never guess the midpoint/);
  assert.match(prompt, /finite numbers in seconds, never milliseconds/);
  assert.match(prompt, /five seconds is 5, not 5000/);
  assert.match(prompt, /retained timeline range, not a trim amount/);
  assert.match(prompt, /first clip from editorContext\.clips array order/);
  assert.match(prompt, /Never invent or infer IDs from labels/);
  assert.match(prompt, /no Markdown, no code fence, no prose/);
  assert.match(prompt, /"targetId":"clip-example-1"/);
  assert.match(prompt, /"startSeconds":5,"endSeconds":10/);
  assert.match(prompt, /"type":"SET_CLIP_PLAYBACK_SPEED"/);
  assert.match(prompt, /"playbackRate":1\.25/);
  assert.match(prompt, /"type":"SPLIT_CLIP"/);
  assert.match(prompt, /"splitAtSeconds":6/);
  assert.match(prompt, /"type":"REORDER_CLIP"/);
  assert.match(prompt, /"referenceId":"clip-example-1"/);
  assert.match(prompt, /"placement":"BEFORE"/);
  assert.match(prompt, /"type":"SET_CLIP_POSITION_SCALE"/);
  assert.match(prompt, /"x":25,"y":-25,"scale":0\.8/);
  assert.match(prompt, /ordered editorContext\.clips array/);
  assert.doesNotMatch(prompt, /real user|https?:\/\/|Authorization|api[_ -]?key/i);
});

test("editor playback speed schema is exact, finite, bounded, and does not weaken existing actions", () => {
  const mismatch = (missing: readonly string[], invalid: readonly string[]): never => {
    throw new Error(`schema mismatch:${missing.join(",")}:${invalid.join(",")}`);
  };
  assert.deepEqual(validateEditorRequirementsPlan(exactPlaybackSpeedPlan, mismatch), exactPlaybackSpeedPlan);
  for (const playbackRate of [0.25, 1.25, 4]) {
    assert.doesNotThrow(() => validateEditorRequirementsPlan({
      ...exactPlaybackSpeedPlan,
      actions: [{ ...exactPlaybackSpeedPlan.actions[0], playbackRate }],
    }, mismatch));
  }
  for (const playbackRate of [0.24, 4.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1.25"]) {
    assert.throws(() => validateEditorRequirementsPlan({
      ...exactPlaybackSpeedPlan,
      actions: [{ ...exactPlaybackSpeedPlan.actions[0], playbackRate }],
    }, mismatch));
  }
  assert.throws(() => validateEditorRequirementsPlan({
    ...exactPlaybackSpeedPlan,
    actions: [{ ...exactPlaybackSpeedPlan.actions[0], rate: 1.25 }],
  }, mismatch));
  assert.throws(() => validateEditorRequirementsPlan({
    ...exactPlaybackSpeedPlan,
    actions: [{ ...exactPlaybackSpeedPlan.actions[0], type: "SET_SPEED" }],
  }, mismatch));
  assert.deepEqual(validateEditorRequirementsPlan(validEditorPlan, mismatch), validEditorPlan);

  const actions = (EDITOR_REQUIREMENTS_PLAN_SCHEMA.properties as Record<string, unknown>).actions as {
    items: { oneOf: Array<Record<string, unknown>> };
  };
  assert.equal(actions.items.oneOf.length, 6);
  assert.deepEqual(actions.items.oneOf[1].required, ["type", "targetId", "assetId", "playbackRate", "reason"]);
  assert.deepEqual(actions.items.oneOf[2].required, ["type", "targetId", "assetId", "splitAtSeconds", "reason"]);
  assert.deepEqual(actions.items.oneOf[3].required, ["type", "targetId", "assetId", "referenceId", "placement", "reason"]);
  assert.deepEqual(actions.items.oneOf[4].required, ["type", "targetId", "assetId", "x", "y", "scale", "reason"]);
  assert.equal(actions.items.oneOf[4].additionalProperties, false);
  assert.deepEqual((actions.items.oneOf[4].properties as Record<string, unknown>).assetId, { type: "string", const: "" });
  assert.deepEqual((actions.items.oneOf[4].properties as Record<string, unknown>).x, { type: "number", minimum: -50, maximum: 50 });
  assert.deepEqual((actions.items.oneOf[4].properties as Record<string, unknown>).scale, { type: "number", minimum: 0.25, maximum: 3 });
});

test("SET_CAPTION_TEXT shared schema and Edge parser enforce the frozen action and trusted caption IDs", () => {
  const mismatch = (missing: readonly string[], invalid: readonly string[]): never => {
    throw new Error(`schema mismatch:${missing.join(",")}:${invalid.join(",")}`);
  };
  const trustedContext = JSON.stringify({ captions: [
    { id: "caption-a", text: "高血呀", startMs: 0, endMs: 1_000, ordinal: 1, eligible: true },
    { id: "caption-b", text: "好的", startMs: 1_000, endMs: 2_000, ordinal: 2, eligible: true },
  ] });
  const captionPlan = {
    summary: "Replace one exact caption.",
    actions: [{ type: "SET_CAPTION_TEXT", targetId: "caption-a", text: "高血压", reason: "Use the requested correction." }],
    unsupported: [],
    warnings: [],
  };
  assert.deepEqual(validateEditorRequirementsPlan(captionPlan, mismatch, trustedContext), captionPlan);
  assert.doesNotThrow(() => validateEditorRequirementsPlan({
    ...captionPlan,
    actions: [
      ...captionPlan.actions,
      { type: "TRIM_CLIP", targetId: "clip-a", assetId: "", startSeconds: 1, endSeconds: 2, reason: "Trim the unrelated clip." },
    ],
  }, mismatch, trustedContext));
  const preservedCaptionTextPlan = validateEditorRequirementsPlan({
    ...captionPlan,
    actions: [{ ...captionPlan.actions[0], text: "  Take the medicine after meals.  " }],
  }, mismatch, trustedContext);
  assert.equal((preservedCaptionTextPlan.actions as Array<Record<string, unknown>>)[0].text, "  Take the medicine after meals.  ");

  for (const [targetId, context] of [
    ["model-invented", trustedContext],
    ["asset-a", trustedContext],
    ["clip-a", trustedContext],
    ["caption-a", JSON.stringify({ captions: [
      { id: "caption-a", text: "A", startMs: 0, endMs: 1_000, ordinal: 1, eligible: false },
    ] })],
    ["caption-a", JSON.stringify({ captions: [
      { id: "caption-a", text: "A", startMs: 0, endMs: 1_000, ordinal: 1, eligible: false },
      { id: "caption-a", text: "B", startMs: 1_000, endMs: 2_000, ordinal: 2, eligible: false },
    ] })],
  ] as const) {
    assert.throws(() => validateEditorRequirementsPlan({
      ...captionPlan,
      actions: [{ ...captionPlan.actions[0], targetId }],
    }, mismatch, context));
  }
  for (const action of [
    { ...captionPlan.actions[0], text: " \t " },
    { ...captionPlan.actions[0], text: "😀".repeat(1_001) },
    { ...captionPlan.actions[0], timing: 2 },
    { ...captionPlan.actions[0], assetId: "" },
  ]) {
    assert.throws(() => validateEditorRequirementsPlan({ ...captionPlan, actions: [action] }, mismatch, trustedContext));
  }
  assert.throws(() => validateEditorRequirementsPlan({ ...captionPlan, actions: [
    captionPlan.actions[0], captionPlan.actions[0],
  ] }, mismatch, trustedContext));

  const actions = (EDITOR_REQUIREMENTS_PLAN_SCHEMA.properties as Record<string, unknown>).actions as {
    items: { oneOf: Array<Record<string, unknown>> };
  };
  const schema = actions.items.oneOf.find((item) => {
    const properties = item.properties as Record<string, Record<string, unknown>>;
    return properties.type?.const === "SET_CAPTION_TEXT";
  });
  assert.ok(schema);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["type", "targetId", "text", "reason"]);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.type, { type: "string", const: "SET_CAPTION_TEXT" });
  assert.equal(properties.text.maxLength, 2_000);
  assert.equal(properties.text.pattern, "^[\\s\\S]{1,2000}$");
  assert.equal(new RegExp(String(properties.text.pattern)).test("😀".repeat(1_001)), false);
  assert.deepEqual(Object.keys(properties).sort(), ["reason", "targetId", "text", "type"]);
});

test("SET_CLIP_POSITION_SCALE provider contract is exact, bounded, and conflict safe", () => {
  const mismatch = (missing: readonly string[], invalid: readonly string[]): never => {
    throw new Error(`schema mismatch:${missing.join(",")}:${invalid.join(",")}`);
  };
  assert.deepEqual(validateEditorRequirementsPlan(exactPositionScalePlan, mismatch, trustedPositionScaleContext), exactPositionScalePlan);
  for (const [x, y, scale] of [
    [-50, -50, 0.25], [-50, 50, 3], [50, -50, 0.8], [50, 50, 1.25], [0, 0, 1],
  ]) {
    assert.doesNotThrow(() => validateEditorRequirementsPlan({
      ...exactPositionScalePlan,
      actions: [{ ...exactPositionScalePlan.actions[0], x, y, scale }],
    }, mismatch, trustedPositionScaleContext));
  }
  for (const [x, y, scale] of [
    [-50.01, 0, 1], [50.01, 0, 1], [0, -50.01, 1], [0, 50.01, 1],
    [0, 0, 0.249], [0, 0, 3.001], ["25", 0, 1], [0, "-25", 1], [0, 0, "0.8"],
    [Number.NaN, 0, 1], [Number.POSITIVE_INFINITY, 0, 1], [Number.NEGATIVE_INFINITY, 0, 1],
  ]) {
    assert.throws(() => validateEditorRequirementsPlan({
      ...exactPositionScalePlan,
      actions: [{ ...exactPositionScalePlan.actions[0], x, y, scale }],
    }, mismatch, trustedPositionScaleContext));
  }
  for (const overrides of [
    { assetId: "asset-a" }, { reason: " " }, { targetId: " clip-c " },
    { rotation: 15 }, { scaleX: 2 }, { scaleY: 2 }, { width: 200 }, { height: 200 },
    { opacity: 0.5 }, { anchor: "right" }, { crop: 0.2 }, { fit: "contain" },
    { css: "translate(10px)" }, { transform: "translate(10px)" }, { matrix: [1, 0, 0, 1] },
  ]) {
    assert.throws(() => validateEditorRequirementsPlan({
      ...exactPositionScalePlan,
      actions: [{ ...exactPositionScalePlan.actions[0], ...overrides }],
    }, mismatch, trustedPositionScaleContext));
  }
  for (const action of [
    { ...exactPositionScalePlan.actions[0], x: undefined },
    { ...exactPositionScalePlan.actions[0], y: undefined },
    { ...exactPositionScalePlan.actions[0], scale: undefined },
    { ...exactPositionScalePlan.actions[0], reason: undefined },
    { ...exactPositionScalePlan.actions[0], type: "SET_CLIP_TRANSFORM" },
  ]) {
    assert.throws(() => validateEditorRequirementsPlan({ ...exactPositionScalePlan, actions: [action] }, mismatch, trustedPositionScaleContext));
  }
  assert.throws(() => validateEditorRequirementsPlan({
    ...exactPositionScalePlan,
    actions: [exactPositionScalePlan.actions[0], exactPositionScalePlan.actions[0]],
  }, mismatch, trustedPositionScaleContext));
  assert.throws(() => validateEditorRequirementsPlan({
    ...exactPositionScalePlan,
    actions: [
      { type: "REMOVE_CLIP", targetId: "clip-c", assetId: "", startSeconds: 0, endSeconds: 0, reason: "Remove." },
      exactPositionScalePlan.actions[0],
    ],
  }, mismatch, trustedPositionScaleContext));
  assert.throws(() => validateEditorRequirementsPlan({
    ...exactPositionScalePlan,
    actions: [{ ...exactPositionScalePlan.actions[0], targetId: "clip-invented" }],
  }, mismatch, trustedPositionScaleContext));
  assert.throws(() => validateEditorRequirementsPlan(exactPositionScalePlan, mismatch));
  assert.throws(() => validateEditorRequirementsPlan(exactPositionScalePlan, mismatch, JSON.stringify({
    currentClipId: "clip-invented", clips: [{ id: "clip-c", positionScaleEligible: true }],
  })));
  assert.throws(() => validateEditorRequirementsPlan({
    ...exactPositionScalePlan,
    actions: [
      { type: "SPLIT_CLIP", targetId: "clip-c", assetId: "", splitAtSeconds: 3, reason: "Split." },
      exactPositionScalePlan.actions[0],
    ],
  }, mismatch));
});

test("editor split schema is exact, numeric, positive, and forbids child IDs and aliases", () => {
  const mismatch = (missing: readonly string[], invalid: readonly string[]): never => {
    throw new Error(`schema mismatch:${missing.join(",")}:${invalid.join(",")}`);
  };
  assert.deepEqual(validateEditorRequirementsPlan(exactSplitClipPlan, mismatch), exactSplitClipPlan);
  for (const splitAtSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "6"]) {
    assert.throws(() => validateEditorRequirementsPlan({
      ...exactSplitClipPlan,
      actions: [{ ...exactSplitClipPlan.actions[0], splitAtSeconds }],
    }, mismatch));
  }
  for (const field of ["leftClipId", "rightClipId", "newClipId"]) {
    assert.throws(() => validateEditorRequirementsPlan({
      ...exactSplitClipPlan,
      actions: [{ ...exactSplitClipPlan.actions[0], [field]: "ai-invented" }],
    }, mismatch));
  }
  for (const type of ["CUT_CLIP", "SPLIT_VIDEO", "DIVIDE_CLIP"]) {
    assert.throws(() => validateEditorRequirementsPlan({
      ...exactSplitClipPlan,
      actions: [{ ...exactSplitClipPlan.actions[0], type }],
    }, mismatch));
  }
});

test("DeepSeek, Kimi, and Doubao mocks normalize the playback-speed action through one shared contract", async () => {
  const deepseek = createDeepSeekTextTaskExecutor(async () => deepseekResponse(exactPlaybackSpeedPlan));
  const kimi = createKimiTextTaskExecutor(async () => kimiResponse(exactPlaybackSpeedPlan));
  const doubao = createDoubaoTextTaskExecutor(async () => doubaoResponse(exactPlaybackSpeedPlan));
  assert.deepEqual((await deepseek(deepseekContext("editor.requirements_parse"))).data, exactPlaybackSpeedPlan);
  assert.deepEqual((await kimi(kimiContext("editor.requirements_parse"))).data, exactPlaybackSpeedPlan);
  assert.deepEqual((await doubao(doubaoContext("editor.requirements_parse"))).data, exactPlaybackSpeedPlan);
});

test("DeepSeek, Kimi, and Doubao mocks normalize SPLIT_CLIP through one shared contract", async () => {
  const deepseek = createDeepSeekTextTaskExecutor(async () => deepseekResponse(exactSplitClipPlan));
  const kimi = createKimiTextTaskExecutor(async () => kimiResponse(exactSplitClipPlan));
  const doubao = createDoubaoTextTaskExecutor(async () => doubaoResponse(exactSplitClipPlan));
  assert.deepEqual((await deepseek(deepseekContext("editor.requirements_parse"))).data, exactSplitClipPlan);
  assert.deepEqual((await kimi(kimiContext("editor.requirements_parse"))).data, exactSplitClipPlan);
  assert.deepEqual((await doubao(doubaoContext("editor.requirements_parse"))).data, exactSplitClipPlan);
});

test("editor reorder schema is exact and rejects invalid placements, aliases, and extra fields", () => {
  const mismatch = (missing: readonly string[], invalid: readonly string[]): never => {
    throw new Error(`schema mismatch:${missing.join(",")}:${invalid.join(",")}`);
  };
  assert.deepEqual(validateEditorRequirementsPlan(exactReorderClipPlan, mismatch), exactReorderClipPlan);
  for (const placement of ["before", "LEFT", "RIGHT", "START", "END"]) {
    assert.throws(() => validateEditorRequirementsPlan({
      ...exactReorderClipPlan,
      actions: [{ ...exactReorderClipPlan.actions[0], placement }],
    }, mismatch));
  }
  for (const type of ["MOVE_CLIP", "REPOSITION_CLIP", "CHANGE_CLIP_ORDER", "SORT_CLIP"]) {
    assert.throws(() => validateEditorRequirementsPlan({
      ...exactReorderClipPlan,
      actions: [{ ...exactReorderClipPlan.actions[0], type }],
    }, mismatch));
  }
  assert.throws(() => validateEditorRequirementsPlan({
    ...exactReorderClipPlan,
    actions: [{ ...exactReorderClipPlan.actions[0], destinationIndex: 0 }],
  }, mismatch));
});

test("DeepSeek, Kimi, and Doubao mocks normalize REORDER_CLIP through one shared contract", async () => {
  const deepseek = createDeepSeekTextTaskExecutor(async () => deepseekResponse(exactReorderClipPlan));
  const kimi = createKimiTextTaskExecutor(async () => kimiResponse(exactReorderClipPlan));
  const doubao = createDoubaoTextTaskExecutor(async () => doubaoResponse(exactReorderClipPlan));
  assert.deepEqual((await deepseek(deepseekContext("editor.requirements_parse"))).data, exactReorderClipPlan);
  assert.deepEqual((await kimi(kimiContext("editor.requirements_parse"))).data, exactReorderClipPlan);
  assert.deepEqual((await doubao(doubaoContext("editor.requirements_parse"))).data, exactReorderClipPlan);
});

test("DeepSeek, Kimi, and Doubao mocks normalize SET_CLIP_POSITION_SCALE through one shared contract", async () => {
  const deepseek = createDeepSeekTextTaskExecutor(async () => deepseekResponse(exactPositionScalePlan));
  const kimi = createKimiTextTaskExecutor(async () => kimiResponse(exactPositionScalePlan));
  const doubao = createDoubaoTextTaskExecutor(async () => doubaoResponse(exactPositionScalePlan));
  assert.deepEqual((await deepseek(deepseekContext("editor.requirements_parse"))).data, exactPositionScalePlan);
  assert.deepEqual((await kimi(kimiContext("editor.requirements_parse"))).data, exactPositionScalePlan);
  assert.deepEqual((await doubao(doubaoContext("editor.requirements_parse"))).data, exactPositionScalePlan);
});

test("position scale fixtures cover natural language, safe ordinal/current context, limits, and adversarial output", () => {
  const validNames = [
    "valid_position_scale_top_right_80", "valid_position_scale_center",
    "valid_position_scale_enlarge_slightly", "valid_position_scale_shrink_slightly",
    "valid_position_scale_restore_current", "valid_position_scale_bottom_left",
    "valid_position_scale_125_percent", "valid_position_scale_noop",
    "valid_position_scale_enlarge_at_max_noop", "valid_position_scale_shrink_at_min_noop",
  ] as const;
  for (const name of validNames) {
    const definition = getInternalTextTaskFixtureDefinition(name);
    assert.equal(definition.expected.canonicalValidation, "PASS");
    assert.deepEqual(definition.expected.actionTypes, ["SET_CLIP_POSITION_SCALE"]);
  }
  const topRight = getInternalTextTaskFixtureDefinition("valid_position_scale_top_right_80");
  assert.equal(topRight.response.kind, "canonical");
  if (topRight.response.kind !== "canonical") throw new Error("top-right position fixture must be canonical");
  const topRightAction = (topRight.response.content.actions as Array<Record<string, unknown>>)[0];
  assert.deepEqual(Object.keys(topRightAction).sort(), ["assetId", "reason", "scale", "targetId", "type", "x", "y"]);
  assert.deepEqual([topRightAction.type, topRightAction.targetId, topRightAction.assetId, topRightAction.x, topRightAction.y, topRightAction.scale], ["SET_CLIP_POSITION_SCALE", "clip-c", "", 25, -25, 0.8]);
  const positionContext = JSON.parse(topRight.input.editorContext) as {
    clips: Array<{ id: string; x: number; y: number; scale: number }>;
    currentClipId: string;
  };
  assert.deepEqual(positionContext.clips.map((clip) => clip.id), ["clip-a", "clip-b", "clip-c"]);
  assert.deepEqual(positionContext.clips[1], {
    id: "clip-b", trackId: "video-main", assetId: "asset-clip-b", kind: "video", positionScaleEligible: true, startSeconds: 10,
    endSeconds: 20, timelineDurationSeconds: 10, playbackRate: 1, x: 8, y: -3, scale: 1,
  });
  assert.equal(positionContext.currentClipId, "clip-b");
  for (const name of [
    "invalid_position_scale_invented_target", "invalid_position_scale_outside_context",
    "invalid_split_child_position_target",
  ] as const) {
    const expected = getInternalTextTaskFixtureDefinition(name).expected;
    assert.equal(expected.canonicalValidation, "REJECT", name);
    assert.equal(expected.safeDiagnosticClass, "CANONICAL_SCHEMA_ERROR", name);
  }
  for (const name of [
    "invalid_position_scale_x_below", "invalid_position_scale_x_above",
    "invalid_position_scale_y_below", "invalid_position_scale_y_above",
    "invalid_position_scale_scale_below", "invalid_position_scale_scale_above",
    "invalid_position_scale_numeric_string", "invalid_position_scale_nonempty_asset",
    "invalid_position_scale_unknown_field", "invalid_position_scale_rotation",
    "invalid_position_scale_css", "invalid_position_scale_matrix", "invalid_position_scale_crop_fit",
    "invalid_position_scale_duplicate", "invalid_remove_and_position_scale_same_target",
  ] as const) {
    const expected = getInternalTextTaskFixtureDefinition(name).expected;
    assert.equal(expected.canonicalValidation, "REJECT", name);
    assert.equal(expected.safeDiagnosticClass, "CANONICAL_SCHEMA_ERROR", name);
  }
  for (const name of [
    "unsupported_position_scale_fourth_ordinal", "unsupported_position_scale_ambiguous_current",
    "unsupported_position_scale_percent_below", "unsupported_position_scale_percent_above",
  ] as const) {
    const definition = getInternalTextTaskFixtureDefinition(name);
    assert.equal(definition.expected.canonicalValidation, "PASS");
    assert.deepEqual(definition.expected.actionTypes, []);
  }
  assert.equal(getInternalTextTaskFixtureDefinition("valid_position_scale_enlarge_slightly").input.editingRequirement, "把第二个视频放大一点。");
  assert.equal(getInternalTextTaskFixtureDefinition("valid_position_scale_shrink_slightly").input.editingRequirement, "把第二个视频缩小一点。");
  assert.equal(getInternalTextTaskFixtureDefinition("valid_position_scale_restore_current").input.editingRequirement, "把这个视频恢复原大小。");
  const upper = getInternalTextTaskFixtureDefinition("valid_position_scale_enlarge_at_max_noop");
  const lower = getInternalTextTaskFixtureDefinition("valid_position_scale_shrink_at_min_noop");
  assert.equal(upper.response.kind, "canonical");
  assert.equal(lower.response.kind, "canonical");
  if (upper.response.kind !== "canonical" || lower.response.kind !== "canonical") throw new Error("bound fixtures must be canonical");
  assert.equal((upper.response.content.actions as Array<{ scale: number }>)[0].scale, 3);
  assert.equal((lower.response.content.actions as Array<{ scale: number }>)[0].scale, 0.25);
});

test("mocked browser pipeline serializes and deterministically applies REORDER_CLIP", async () => {
  const entries = new Map<string, SavedCredential>();
  entries.set(`${USER_A}:deepseek`, await savedCredential());
  const request = parseAITaskRequest({
    task: "editor.requirements_parse",
    provider: "deepseek",
    input: {
      editingRequirement: "把第二个视频片段移动到第一个视频片段前面。",
      editorContext: JSON.stringify({
        videoDurationSeconds: 20,
        assets: [
          { id: "asset-example-1", durationSeconds: 10 },
          { id: "asset-example-2", durationSeconds: 10 },
        ],
        clips: [
          { id: "clip-example-1", assetId: "asset-example-1", startSeconds: 0, endSeconds: 10, playbackRate: 1 },
          { id: "clip-example-2", assetId: "asset-example-2", startSeconds: 10, endSeconds: 20, playbackRate: 1 },
        ],
      }),
    },
  });
  let providerCalls = 0;
  const executor = createDeepSeekTextTaskExecutor(async () => {
    providerCalls += 1;
    return deepseekResponse(exactReorderClipPlan, { raw_provider_marker: "must-never-reach-browser" });
  });
  const edgeResult = await executeAITaskRequest(USER_A, request, {
    repository: repositoryFor(entries), encryptionKey, executeTask: executor,
  });
  const applied = applyAIEditingPlan(
    (edgeResult.result as { data: Record<string, unknown> }).data,
    {
      project: editorProjectForAlignment(),
      ownedAssetIds: new Set(["asset-example-1", "asset-example-2"]),
      audioSourceDurationMs: 30_000,
    },
  );
  assert.equal(providerCalls, 1);
  assert.deepEqual(applied.project.tracks[0].clips.map((clip) => clip.id), ["clip-example-2", "clip-example-1"]);
  assert.doesNotMatch(JSON.stringify(edgeResult), /must-never-reach-browser|reasoning_content|raw_provider|Authorization/);
});

test("provider fixture output passes browser parsing, validation, and apply for third clip top-right 80%", async () => {
  const fixture = "valid_position_scale_top_right_80" as const;
  const definition = getInternalTextTaskFixtureDefinition(fixture);
  const request = parseAITaskRequest({
    task: "editor.requirements_parse",
    provider: "deepseek",
    input: definition.input,
  });
  const response = await executeInternalTextTaskFixture(USER_A, request, fixture);
  const data = (response.result as { data: Record<string, unknown> }).data;
  const parsed = parseAIEditingPlan(data);
  assert.deepEqual(parsed.actions.map((action) => [action.type, action.targetId, action.assetId, action.x, action.y, action.scale]), [
    ["SET_CLIP_POSITION_SCALE", "clip-c", "", 25, -25, 0.8],
  ]);
  const applicationContext = createInternalTextTaskFixtureApplicationContext(fixture);
  const before = applicationContext.project;
  const beforeClip = before.tracks[0].clips[2];
  const applied = applyAIEditingPlan(parsed, {
    project: before,
    ownedAssetIds: new Set(applicationContext.ownedAssetIds),
    audioSourceDurationMs: applicationContext.audioSourceDurationMs,
    nowIso: "2026-10-22T00:00:00.000Z",
  });
  const after = applied.project;
  const afterClip = after.tracks[0].clips[2];
  assert.deepEqual([afterClip.id, afterClip.trackId, afterClip.assetId], [beforeClip.id, beforeClip.trackId, beforeClip.assetId]);
  assert.deepEqual(
    [afterClip.sourceInMs, afterClip.sourceOutMs, afterClip.timelineStartMs, afterClip.timelineEndMs, afterClip.speedCurve],
    [beforeClip.sourceInMs, beforeClip.sourceOutMs, beforeClip.timelineStartMs, beforeClip.timelineEndMs, beforeClip.speedCurve],
  );
  assert.deepEqual([afterClip.transform.x, afterClip.transform.y, afterClip.transform.scale], [25, -25, 0.8]);
  assert.deepEqual([afterClip.transform.crop, afterClip.transform.fit], [beforeClip.transform.crop, beforeClip.transform.fit]);
  assert.deepEqual(after.tracks.map((track) => track.clips.map((clip) => clip.id)), before.tracks.map((track) => track.clips.map((clip) => clip.id)));
  assert.deepEqual(after.captions, before.captions);
  assert.deepEqual(after.audioSelection, before.audioSelection);
  assert.deepEqual(after.tracks.filter((track) => track.type === "audio"), before.tracks.filter((track) => track.type === "audio"));
  assert.deepEqual([after.ratio, after.durationMs], [before.ratio, before.durationMs]);
  assert.deepEqual(applied.applied.map((action) => action.type), ["SET_CLIP_POSITION_SCALE"]);
});

test("SET_CAPTION_TEXT fixture round-trips through safe context, Edge envelope, browser parser, and local apply", async () => {
  const fixture = "valid_caption_first_chinese_medical_correction" as const;
  const definition = getInternalTextTaskFixtureDefinition(fixture);
  const request = parseAITaskRequest({ task: "editor.requirements_parse", provider: "deepseek", input: definition.input });
  const edgeResult = await executeInternalTextTaskFixture(USER_A, request, fixture);
  const data = (edgeResult.result as { data: Record<string, unknown> }).data;
  const parsed = parseAIEditingPlan(data);
  assert.deepEqual(parsed.actions.map((action) => [action.type, action.targetId, action.text]), [
    ["SET_CAPTION_TEXT", "caption-1", "高血压"],
  ]);
  const applicationContext = createInternalTextTaskFixtureApplicationContext(fixture);
  const before = applicationContext.project as EditorProject;
  const timingBefore = before.captions.map(({ id, startMs, endMs }) => [id, startMs, endMs]);
  const unrelatedBefore = {
    tracks: structuredClone(before.tracks),
    assets: structuredClone(before.assets),
    audioSelection: structuredClone(before.audioSelection),
    ratio: before.ratio,
    durationMs: before.durationMs,
  };
  const applied = applyAIEditingPlan(parsed, {
    project: before,
    ownedAssetIds: new Set(applicationContext.ownedAssetIds),
    audioSourceDurationMs: applicationContext.audioSourceDurationMs,
  });
  assert.deepEqual(applied.project.captions.map(({ id, text, startMs, endMs }) => [id, text, startMs, endMs]), [
    ["caption-1", "高血压", 0, 1_000],
    ["caption-2", "Take medicine", 1_000, 2_000],
    ["caption-3", "患者无发热", 2_000, 3_000],
  ]);
  assert.deepEqual(applied.project.captions.map(({ id, startMs, endMs }) => [id, startMs, endMs]), timingBefore);
  assert.deepEqual({
    tracks: applied.project.tracks,
    assets: applied.project.assets,
    audioSelection: applied.project.audioSelection,
    ratio: applied.project.ratio,
    durationMs: applied.project.durationMs,
  }, unrelatedBefore);
});

test("DeepSeek, Kimi, and Doubao use one SET_CAPTION_TEXT prompt, schema semantics, and caption target validation", async () => {
  const editorContext = JSON.stringify({ captions: [
    { id: "caption-a", text: "高血呀", startMs: 0, endMs: 1_000, ordinal: 1, eligible: true },
  ] });
  const setContext = (context: AITaskExecutionContext): AITaskExecutionContext => ({
    ...context,
    input: { editingRequirement: "把第一条字幕改成‘高血压’", editorContext },
  });
  const contexts = [
    setContext(deepseekContext("editor.requirements_parse")),
    setContext(kimiContext("editor.requirements_parse")),
    setContext(doubaoContext("editor.requirements_parse")),
  ];
  const requests = [
    buildDeepSeekTaskRequest(contexts[0]),
    buildKimiTaskRequest(contexts[1]),
    buildDoubaoTaskRequest(contexts[2]),
  ];
  const systemPrompts = requests.map((request) => request.body.messages.find((message) => message.role === "system")?.content);
  assert.equal(new Set(systemPrompts).size, 1);
  assert.match(systemPrompts[0] ?? "", /SET_CAPTION_TEXT shape/);
  assert.equal((requests[2].body.response_format as { json_schema: { schema: unknown } }).json_schema.schema, EDITOR_REQUIREMENTS_PLAN_SCHEMA);
  assert.deepEqual(requests.map((request) => request.body.response_format.type), ["json_object", "json_object", "json_schema"]);

  const response = {
    summary: "Replace the first caption text.",
    actions: [{ type: "SET_CAPTION_TEXT", targetId: "caption-a", text: "高血压", reason: "Use the exact requested correction." }],
    unsupported: [],
    warnings: [],
  };
  const results = await Promise.all([
    createDeepSeekTextTaskExecutor(async () => deepseekResponse(response))(contexts[0]),
    createKimiTextTaskExecutor(async () => kimiResponse(response))(contexts[1]),
    createDoubaoTextTaskExecutor(async () => doubaoResponse(response))(contexts[2]),
  ]);
  assert.deepEqual(results.map((result) => result.data), [response, response, response]);

  const invented = { ...response, actions: [{ ...response.actions[0], targetId: "caption-invented" }] };
  await Promise.all([
    assert.rejects(() => createDeepSeekTextTaskExecutor(async () => deepseekResponse(invented))(contexts[0]), SafeTaskError),
    assert.rejects(() => createKimiTextTaskExecutor(async () => kimiResponse(invented))(contexts[1]), SafeTaskError),
    assert.rejects(() => createDoubaoTextTaskExecutor(async () => doubaoResponse(invented))(contexts[2]), SafeTaskError),
  ]);
});

test("mocked browser pipeline serializes and deterministically applies SPLIT_CLIP without provider data", async () => {
  const entries = new Map<string, SavedCredential>();
  entries.set(`${USER_A}:deepseek`, await savedCredential());
  const request = parseAITaskRequest({
    task: "editor.requirements_parse",
    provider: "deepseek",
    input: {
      editingRequirement: "在第一个视频片段第 6 秒处分割。",
      editorContext: JSON.stringify({
        videoDurationSeconds: 20,
        assets: [{ id: "asset-example-1", durationSeconds: 10 }],
        clips: [{
          id: "clip-example-1", assetId: "asset-example-1", startSeconds: 0,
          endSeconds: 10, timelineDurationSeconds: 10, playbackRate: 1,
        }],
      }),
    },
  });
  let providerCalls = 0;
  const executor = createDeepSeekTextTaskExecutor(async () => {
    providerCalls += 1;
    return deepseekResponse(exactSplitClipPlan, { raw_provider_marker: "must-never-reach-browser" });
  });
  const edgeResult = await executeAITaskRequest(USER_A, request, {
    repository: repositoryFor(entries), encryptionKey, executeTask: executor,
  });
  const childIds = ["split-left", "split-right"];
  const applied = applyAIEditingPlan(
    (edgeResult.result as { data: Record<string, unknown> }).data,
    {
      project: editorProjectForAlignment(),
      ownedAssetIds: new Set(["asset-example-1", "asset-example-2"]),
      audioSourceDurationMs: 30_000,
      nowIso: "2026-10-18T02:00:00.000Z",
      createClipId: () => childIds.shift()!,
    },
  );
  assert.equal(providerCalls, 1);
  assert.deepEqual(applied.applied.map((item) => item.type), ["SPLIT_CLIP"]);
  assert.deepEqual(applied.project.tracks[0].clips.slice(0, 2).map((clip) => clip.id), ["split-left", "split-right"]);
  assert.deepEqual(
    applied.project.tracks[0].clips.slice(0, 2).map((clip) => [clip.timelineStartMs, clip.timelineEndMs]),
    [[0, 6_000], [6_000, 10_000]],
  );
  assert.doesNotMatch(JSON.stringify(edgeResult), /must-never-reach-browser|reasoning_content|raw_provider|Authorization/);
});

test("mocked browser pipeline applies one safe playback-speed action with no raw provider data", async () => {
  const entries = new Map<string, SavedCredential>();
  entries.set(`${USER_A}:deepseek`, await savedCredential());
  const request = parseAITaskRequest({
    task: "editor.requirements_parse",
    provider: "deepseek",
    input: {
      editingRequirement: "把第一个视频片段调整为 1.25 倍速。",
      editorContext: JSON.stringify({
        videoDurationSeconds: 20,
        assets: [{ id: "asset-example-1", durationSeconds: 10 }],
        clips: [{ id: "clip-example-1", assetId: "asset-example-1", startSeconds: 0, endSeconds: 10, playbackRate: 1 }],
      }),
    },
  });
  let providerCalls = 0;
  const executor = createDeepSeekTextTaskExecutor(async () => {
    providerCalls += 1;
    return deepseekResponse(exactPlaybackSpeedPlan, { raw_provider_marker: "must-never-reach-browser" });
  });
  const edgeResult = await executeAITaskRequest(USER_A, request, {
    repository: repositoryFor(entries),
    encryptionKey,
    executeTask: executor,
  });
  assert.equal(providerCalls, 1);
  const browserData = (edgeResult.result as { data: Record<string, unknown> }).data;
  const source = editorProjectForAlignment();
  const secondBefore = structuredClone(source.tracks[0].clips[1]);
  const captionsBefore = structuredClone(source.captions);
  const applied = applyAIEditingPlan(browserData, {
    project: source,
    ownedAssetIds: new Set(["asset-example-1", "asset-example-2"]),
    audioSourceDurationMs: 30_000,
    nowIso: "2026-10-18T01:00:00.000Z",
  });
  assert.equal(applied.project.tracks[0].clips[0].timelineEndMs, 8_000);
  assert.equal(applied.project.tracks[0].clips[0].speedCurve[0].rate, 1.25);
  assert.deepEqual(applied.project.tracks[0].clips[1], secondBefore);
  assert.deepEqual(applied.project.captions, captionsBefore);
  assert.doesNotMatch(
    JSON.stringify(edgeResult),
    /must-never-reach-browser|reasoning_content|raw_provider|fixture-provider-key-not-real|Authorization/,
  );
});

test("editor requirements normalization only strips one complete JSON fence", () => {
  const json = JSON.stringify(exactFirstFiveSecondsTrimPlan);
  assert.equal(normalizeEditorRequirementsJSONText(`  ${json}  `), json);
  assert.equal(normalizeEditorRequirementsJSONText(`\`\`\`json\n${json}\n\`\`\``), json);
  assert.equal(normalizeEditorRequirementsJSONText(`\`\`\`\n${json}\n\`\`\``), json);
  assert.equal(
    normalizeEditorRequirementsJSONText(`explanation\n\`\`\`json\n${json}\n\`\`\``),
    `explanation\n\`\`\`json\n${json}\n\`\`\``,
  );
});

test("DeepSeek editor output matrix normalizes only a JSON fence and rejects schema drift", async () => {
  const validAction = exactFirstFiveSecondsTrimPlan.actions[0];
  const accepted = [
    exactFirstFiveSecondsTrimPlan,
    {
      summary: "Apply one supported action and report one unsupported request.",
      actions: [validAction],
      unsupported: [{ request: "Add a transition.", reason: "Transitions are not executable." }],
      warnings: [],
    },
    {
      summary: "No executable action is available.",
      actions: [],
      unsupported: [{ request: "Add an animated effect.", reason: "Effects are not executable." }],
      warnings: ["The timeline remains unchanged."],
    },
  ];
  for (const fixture of accepted) {
    const executor = createDeepSeekTextTaskExecutor(async () => deepseekResponse(fixture));
    const result = await executor(deepseekContext("editor.requirements_parse"));
    assert.deepEqual(result.data, fixture);
  }

  const fencedExecutor = createDeepSeekTextTaskExecutor(async () => deepseekContentResponse(
    `\`\`\`json\n${JSON.stringify(exactFirstFiveSecondsTrimPlan)}\n\`\`\``,
  ));
  assert.deepEqual(
    (await fencedExecutor(deepseekContext("editor.requirements_parse"))).data,
    exactFirstFiveSecondsTrimPlan,
  );

  const rejected = [
    { summary: "Wrong root field.", action: [validAction], unsupported: [], warnings: [] },
    {
      ...exactFirstFiveSecondsTrimPlan,
      actions: [{
        type: "TRIM_CLIP",
        target: { clipId: "clip-example-1" },
        assetId: "",
        startSeconds: 5,
        endSeconds: 10,
        reason: "Wrong target nesting.",
      }],
    },
    { plan: exactFirstFiveSecondsTrimPlan },
    { ...exactFirstFiveSecondsTrimPlan, actions: [{ ...validAction, type: "CROSSFADE" }] },
    { actions: [validAction], unsupported: [], warnings: [] },
    { ...exactFirstFiveSecondsTrimPlan, unsupported: ["Add a transition."] },
    { ...exactFirstFiveSecondsTrimPlan, warnings: [{ message: "Not a string." }] },
  ];
  for (const fixture of rejected) {
    let calls = 0;
    const executor = createDeepSeekTextTaskExecutor(async () => {
      calls += 1;
      return deepseekResponse(fixture);
    });
    const error = await captureTaskError(() => executor(deepseekContext("editor.requirements_parse")));
    assert.equal(error.code, "PROVIDER_SCHEMA_MISMATCH");
    assert.equal(error.diagnostic?.failureStage, "schema_validation");
    assert.equal(error.diagnostic?.failureClass, "CANONICAL_SCHEMA_ERROR");
    assert.equal(error.diagnostic?.httpStatus, 200);
    assert.equal(calls, 1);
  }
});

test("mocked DeepSeek HTTP 200 passes the browser contract and applies the exact first-five-seconds trim", async () => {
  const entries = new Map<string, SavedCredential>();
  entries.set(`${USER_A}:deepseek`, await savedCredential());
  const request = parseAITaskRequest({
    task: "editor.requirements_parse",
    provider: "deepseek",
    input: {
      editingRequirement: "把第一个视频片段的前5秒删掉。",
      editorContext: JSON.stringify({
        videoDurationSeconds: 20,
        assets: [
          { id: "asset-example-1", durationSeconds: 10 },
          { id: "asset-example-2", durationSeconds: 10 },
        ],
        clips: [
          { id: "clip-example-1", assetId: "asset-example-1", startSeconds: 0, endSeconds: 10 },
          { id: "clip-example-2", assetId: "asset-example-2", startSeconds: 10, endSeconds: 20 },
        ],
      }),
    },
  });
  let providerCalls = 0;
  const executor = createDeepSeekTextTaskExecutor(async () => {
    providerCalls += 1;
    return deepseekResponse(exactFirstFiveSecondsTrimPlan, {
      raw_provider_marker: "must-never-reach-browser",
    });
  });
  const edgeResult = await executeAITaskRequest(USER_A, request, {
    repository: repositoryFor(entries),
    encryptionKey,
    executeTask: executor,
  });
  assert.equal(providerCalls, 1);
  assert.equal(edgeResult.ok, true);
  assert.equal(edgeResult.task, "editor.requirements_parse");
  assert.equal(edgeResult.provider, "deepseek");
  const browserData = (edgeResult.result as { data: Record<string, unknown> }).data;
  assert.deepEqual(browserData, exactFirstFiveSecondsTrimPlan);
  assert.doesNotMatch(
    JSON.stringify(edgeResult),
    /must-never-reach-browser|reasoning_content|raw_provider|fixture-provider-key-not-real|Authorization/,
  );

  const source = editorProjectForAlignment();
  const secondClipBefore = structuredClone(source.tracks[0].clips[1]);
  const captionsBefore = structuredClone(source.captions);
  const applied = applyAIEditingPlan(browserData, {
    project: source,
    ownedAssetIds: new Set(["asset-example-1", "asset-example-2"]),
    audioSourceDurationMs: 30_000,
    nowIso: "2026-10-17T01:00:00.000Z",
  });
  const firstClip = applied.project.tracks[0].clips[0];
  assert.equal(firstClip.timelineStartMs, 5_000);
  assert.equal(firstClip.timelineEndMs, 10_000);
  assert.equal(firstClip.sourceInMs, 5_000);
  assert.equal(firstClip.sourceOutMs, 10_000);
  assert.deepEqual(applied.project.tracks[0].clips[1], secondClipBefore);
  assert.deepEqual(applied.project.captions, captionsBefore);
  assert.equal(source.tracks[0].clips[0].sourceInMs, 0);
});

test("millisecond values in seconds fields are rejected by deterministic bounds", async () => {
  const wrongUnitPlan = {
    ...exactFirstFiveSecondsTrimPlan,
    actions: [{ ...exactFirstFiveSecondsTrimPlan.actions[0], startSeconds: 5_000, endSeconds: 10_000 }],
  };
  const executor = createDeepSeekTextTaskExecutor(async () => deepseekResponse(wrongUnitPlan));
  const canonical = await executor(deepseekContext("editor.requirements_parse"));
  assert.throws(() => applyAIEditingPlan(canonical.data, {
    project: editorProjectForAlignment(),
    ownedAssetIds: new Set(["asset-example-1", "asset-example-2"]),
    audioSourceDurationMs: 30_000,
  }));
});

test("Kimi 429 diagnostics distinguish safe provider categories without exposing secrets", async () => {
  const cases = [
    { code: "rate_limit_reached", message: "Requests per minute exceeded.", expected: "PROVIDER_RATE_LIMIT" },
    { code: "concurrency_limit", message: "Concurrent request limit reached.", expected: "PROVIDER_RATE_LIMIT" },
    { code: "quota_exceeded", message: "Account balance is insufficient.", expected: "PROVIDER_PAYMENT_OR_QUOTA_ERROR" },
    { code: "account_tier_required", message: "Account tier does not allow this model.", expected: "PROVIDER_CONFIGURATION_REQUIRED" },
    { code: "model_access_denied", message: "Model access is not allowed.", expected: "PROVIDER_CONFIGURATION_REQUIRED" },
    { code: "provider_capacity", message: "Provider capacity is busy.", expected: "PROVIDER_UNAVAILABLE" },
    { code: "other_429", message: "Provider-specific throttling condition.", expected: "PROVIDER_RATE_LIMIT" },
  ] as const;
  for (const testCase of cases) {
    let calls = 0;
    const executor = createKimiTextTaskExecutor(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: testCase.code, message: testCase.message } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    });
    const error = await captureTaskError(() => executor(kimiContext("music.creative_brief")));
    assert.equal(error.code, testCase.expected);
    assert.equal(error.diagnostic?.provider, "kimi");
    assert.equal(error.diagnostic?.httpStatus, 429);
    assert.equal(error.diagnostic?.providerErrorCode, expectedLocalHTTPCode(testCase.expected));
    assert.ok(error.diagnostic?.sanitizedProviderErrorMessage);
    assert.notEqual(error.diagnostic?.sanitizedProviderErrorMessage, testCase.message);
    assert.equal(error.diagnostic?.providerCallCount, 1);
    assert.equal(error.diagnostic?.failureClass, "UPSTREAM_HTTP_ERROR");
    assert.equal(error.diagnostic?.providerResponseReceived, true);
    assert.equal(error.diagnostic?.responseJsonParseable, false);
    assert.equal(error.diagnostic?.canonicalValidationReached, false);
    assert.equal(calls, 1);
    const serialized = JSON.stringify(safeTaskErrorResponse(error).body);
    assert.match(serialized, new RegExp(expectedLocalHTTPCode(testCase.expected)));
    assert.doesNotMatch(serialized, /fixture-provider-key-not-real|Authorization|raw_response/);
  }
});

test("DeepSeek distinguishes upstream body read failure from malformed upstream JSON", async () => {
  const unreadableBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("fixture body read failure"));
    },
  });
  const bodyReadExecutor = createDeepSeekTextTaskExecutor(async () => new Response(unreadableBody, { status: 200 }));
  const bodyReadError = await captureTaskError(() => bodyReadExecutor(deepseekContext("editor.requirements_parse")));
  assert.equal(bodyReadError.diagnostic?.failureClass, "UPSTREAM_BODY_READ_ERROR");
  assert.equal(bodyReadError.diagnostic?.httpStatus, 200);
  assert.equal(bodyReadError.diagnostic?.responseJsonParseable, false);

  const malformedExecutor = createDeepSeekTextTaskExecutor(async () => new Response("not-json", { status: 200 }));
  const malformedError = await captureTaskError(() => malformedExecutor(deepseekContext("editor.requirements_parse")));
  assert.equal(malformedError.diagnostic?.failureClass, "UPSTREAM_JSON_PARSE_ERROR");
  assert.equal(malformedError.diagnostic?.httpStatus, 200);
  assert.equal(malformedError.diagnostic?.responseJsonParseable, false);
});

test("Kimi provider diagnostics redact exact keys and discard raw request-shaped messages", async () => {
  const responses = [
    `Bearer fixture-provider-key-not-real api_key=fixture-provider-key-not-real`,
    '{"messages":[{"content":"private business text"}]}',
    "Create a short healing song",
  ];
  for (const message of responses) {
    const executor = createKimiTextTaskExecutor(async () => new Response(JSON.stringify({
      error: { code: "rate_limit_reached", message },
    }), { status: 429, headers: { "Content-Type": "application/json" } }));
    const error = await captureTaskError(() => executor(kimiContext("music.creative_brief")));
    const serialized = JSON.stringify(safeTaskErrorResponse(error).body);
    assert.doesNotMatch(serialized, /fixture-provider-key-not-real|private business text|Create a short healing song|\"messages\"/);
  }
});

test("Kimi timeout is server-controlled and never retries", async () => {
  let calls = 0;
  const executor = createKimiTextTaskExecutor(async (_input, init) => {
    calls += 1;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  });
  const context = kimiContext("music.creative_brief");
  const error = await captureTaskError(() => executor({
    ...context,
    budget: { ...context.budget, timeoutMs: 1 },
  }));
  assert.equal(error.code, "PROVIDER_TIMEOUT");
  assert.equal(error.diagnostic?.providerCallCount, 1);
  assert.equal(calls, 1);
});

test("only the two Kimi pilot tasks can reach live execution", async () => {
  let calls = 0;
  const executor = createKimiTextTaskExecutor(async () => {
    calls += 1;
    return kimiResponse(validMusicBrief);
  });
  await expectTaskError(() => executor({
    ...kimiContext("music.creative_brief"),
    task: "music.lyrics_draft",
  }), "PROVIDER_NOT_SUPPORTED_FOR_TASK");
  await expectTaskError(() => executor({
    ...kimiContext("music.creative_brief"),
    provider: "deepseek",
    serverControlledModel: DEEPSEEK_TASK_MODEL,
  }), "PROVIDER_NOT_SUPPORTED_FOR_TASK");
  assert.equal(calls, 0);
});

test("Doubao loads only the owner's saved credential metadata", async () => {
  const entries = new Map<string, SavedCredential>();
  entries.set(`${USER_A}:doubao`, await savedCredential("doubao"));
  const request = parseAITaskRequest({
    task: "music.creative_brief",
    provider: "doubao",
    input: validInputs["music.creative_brief"],
  });
  let calls = 0;
  const result = await executeAITaskRequest(USER_A, request, {
    repository: repositoryFor(entries),
    encryptionKey,
    executeTask: async (context) => {
      calls += 1;
      assert.equal(context.userId, USER_A);
      assert.equal(context.provider, "doubao");
      assert.equal(context.providerResourceId, "apikey-20260917000000-test1");
      assert.equal(context.serverControlledModel, DOUBAO_TASK_MODEL);
      assert.equal(context.apiKey, "fixture-provider-key-not-real");
      return { data: { summary: "safe fixture" }, generationOccurred: true };
    },
  });
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture-provider-key-not-real|apikey-20260917000000-test1|ciphertext|Authorization/);
  await expectTaskError(
    () => executeAITaskRequest(USER_B, request, { repository: repositoryFor(entries), encryptionKey }),
    "NOT_CONNECTED",
  );
});

test("Doubao request uses the fixed server model and strict server-side JSON Schema", () => {
  const music = buildDoubaoTaskRequest(doubaoContext("music.creative_brief"));
  const editor = buildDoubaoTaskRequest(doubaoContext("editor.requirements_parse"));
  assert.equal(music.url, DOUBAO_TASK_ENDPOINT);
  assert.equal(music.url, "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
  assert.equal(music.init.method, "POST");
  assert.equal(music.body.model, DOUBAO_TASK_MODEL);
  assert.equal(editor.body.model, DOUBAO_TASK_MODEL);
  assert.deepEqual(music.body.thinking, { type: DOUBAO_THINKING_MODE });
  assert.equal(music.body.stream, false);
  assert.equal(music.body.max_tokens, 900);
  assert.equal(editor.body.max_tokens, 700);
  assert.equal(music.body.response_format.type, "json_schema");
  assert.equal(music.body.response_format.json_schema.strict, true);
  assert.equal(music.body.response_format.json_schema.name, "medclip_music_creative_brief");
  assert.equal(editor.body.response_format.json_schema.name, "medclip_editor_requirements_parse");
  assert.deepEqual(
    music.body.response_format.json_schema.schema.required,
    ["concept", "theme", "mood", "structure", "lyricDirection", "arrangementDirection", "notes"],
  );
  const serialized = JSON.stringify(music.body);
  assert.doesNotMatch(serialized, /"temperature"|"top_p"|"max_completion_tokens"|"apiKey"|"endpoint"|"baseURL"/);
  assert.match(music.body.messages[0].content, /text planning only/i);
  assert.match(music.body.messages[1].content, /creativeRequirement/);
  assert.doesNotMatch(music.body.messages[1].content, /apikey-20260917000000-test1|model|systemPrompt|rawMessages/);
});

test("Doubao saved resource cannot change either task's fixed effective model", () => {
  const savedResourceIds = [
    undefined,
    "apikey-20260917000000-test1",
    "apikey-another-owner-saved-resource",
  ] as const;
  for (const providerResourceId of savedResourceIds) {
    for (const task of ["music.creative_brief", "editor.requirements_parse"] as const) {
      const request = buildDoubaoTaskRequest({
        ...doubaoContext(task),
        providerResourceId,
      });
      assert.equal(request.body.model, DOUBAO_TASK_MODEL);
      assert.doesNotMatch(
        JSON.stringify(request.body),
        /apikey-20260917000000-test1|apikey-another-owner-saved-resource/,
      );
    }
  }
});

test("Doubao creative brief accepts valid empty arrays and strips reasoning and raw response", async () => {
  let calls = 0;
  const resultValue = {
    ...validMusicBrief,
    structure: [],
    lyricDirection: [],
    arrangementDirection: [],
    notes: [],
  };
  const executor = createDoubaoTextTaskExecutor(async (_input, init) => {
    calls += 1;
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-provider-key-not-real");
    return doubaoResponse(resultValue);
  });
  const result = await executor(doubaoContext("music.creative_brief"));
  assert.equal(calls, 1);
  assert.deepEqual(result.data, resultValue);
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 20, total_tokens: 32 });
  assert.doesNotMatch(JSON.stringify(result), /must-never-be-returned|reasoning_content|raw_provider_marker|fixture-provider-key-not-real/);
});

test("Doubao editor parser returns strict executable-plan data and accepts empty arrays", async () => {
  const resultValue = {
    ...validEditorPlan,
    actions: [],
    unsupported: [],
    warnings: [],
  };
  let calls = 0;
  const executor = createDoubaoTextTaskExecutor(async () => {
    calls += 1;
    return doubaoResponse(resultValue);
  });
  const result = await executor(doubaoContext("editor.requirements_parse"));
  assert.equal(calls, 1);
  assert.deepEqual(result.data, resultValue);
  assert.equal("timeline" in result.data, false);
  assert.equal("operations" in result.data, false);
});

test("Doubao requirements_parse preserves strict JSON Schema and shared prompt alignment", async () => {
  const request = buildDoubaoTaskRequest(doubaoContext("editor.requirements_parse"));
  assert.match(request.body.messages[0].content, /TRIM_CLIP shape/);
  assert.match(request.body.messages[0].content, /seconds, never milliseconds/);
  assert.deepEqual(
    request.body.response_format.json_schema.schema.required,
    ["summary", "actions", "unsupported", "warnings"],
  );
  const executor = createDoubaoTextTaskExecutor(async () => new Response(JSON.stringify({
    choices: [{
      finish_reason: "stop",
      message: { content: `\`\`\`json\n${JSON.stringify(exactFirstFiveSecondsTrimPlan)}\n\`\`\`` },
    }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  assert.deepEqual(
    (await executor(doubaoContext("editor.requirements_parse"))).data,
    exactFirstFiveSecondsTrimPlan,
  );
});

test("Doubao malformed, empty, truncated, and wrong-schema output fails safely without retry", async () => {
  const cases: Array<{ response: Response; code: string; stage: string; failureClass: string }> = [
    {
      response: new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "not-json" } }] }), { status: 200 }),
      code: "PROVIDER_INVALID_JSON",
      stage: "json_parse",
      failureClass: "CANONICAL_PARSE_ERROR",
    },
    {
      response: new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "" } }] }), { status: 200 }),
      code: "PROVIDER_EMPTY_CONTENT",
      stage: "provider_response",
      failureClass: "UPSTREAM_CONTENT_MISSING",
    },
    {
      response: doubaoResponse({ ...validMusicBrief, unexpected: "reject" }),
      code: "PROVIDER_SCHEMA_MISMATCH",
      stage: "schema_validation",
      failureClass: "CANONICAL_SCHEMA_ERROR",
    },
    {
      response: new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{" } }] }), { status: 200 }),
      code: "PROVIDER_SCHEMA_MISMATCH",
      stage: "schema_validation",
      failureClass: "CANONICAL_SCHEMA_ERROR",
    },
  ];
  for (const testCase of cases) {
    let calls = 0;
    const executor = createDoubaoTextTaskExecutor(async () => {
      calls += 1;
      return testCase.response;
    });
    const error = await captureTaskError(() => executor(doubaoContext("music.creative_brief")));
    assert.equal(error.code, testCase.code);
    assert.equal(error.diagnostic?.provider, "doubao");
    assert.equal(error.diagnostic?.failureStage, testCase.stage);
    assert.equal(error.diagnostic?.failureClass, testCase.failureClass);
    assert.equal(error.diagnostic?.providerResponseReceived, true);
    assert.equal(error.diagnostic?.providerCallCount, 1);
    assert.equal(calls, 1);
  }
});

test("Doubao HTTP failures expose only safe Ark categories", async () => {
  const cases = [
    { status: 401, providerCode: "AuthenticationError", expected: "PROVIDER_AUTH_ERROR" },
    { status: 403, providerCode: "AccessDenied", expected: "PROVIDER_AUTH_ERROR" },
    { status: 429, providerCode: "RateLimitExceeded", expected: "PROVIDER_RATE_LIMIT" },
    { status: 429, providerCode: "QuotaExceeded", expected: "PROVIDER_PAYMENT_OR_QUOTA_ERROR" },
    { status: 400, providerCode: "InvalidParameter", expected: "PROVIDER_BAD_REQUEST" },
    { status: 500, providerCode: "InternalServiceError", expected: "PROVIDER_HTTP_ERROR" },
  ] as const;
  for (const testCase of cases) {
    let calls = 0;
    const executor = createDoubaoTextTaskExecutor(async () => {
      calls += 1;
      return new Response(JSON.stringify({
        error: { code: testCase.providerCode, message: "raw-provider-message-must-not-return" },
      }), { status: testCase.status, headers: { "Content-Type": "application/json" } });
    });
    const error = await captureTaskError(() => executor(doubaoContext("music.creative_brief")));
    assert.equal(error.code, testCase.expected);
    assert.equal(error.diagnostic?.provider, "doubao");
    assert.equal(error.diagnostic?.httpStatus, testCase.status);
    assert.equal(error.diagnostic?.providerErrorCode, expectedLocalHTTPCode(testCase.expected));
    assert.equal(error.diagnostic?.providerCallCount, 1);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(safeTaskErrorResponse(error).body), /raw-provider-message-must-not-return|fixture-provider-key-not-real/);
  }
});

test("Doubao timeout is server-controlled and never retries", async () => {
  let calls = 0;
  const executor = createDoubaoTextTaskExecutor(async (_input, init) => {
    calls += 1;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  });
  const context = doubaoContext("music.creative_brief");
  const error = await captureTaskError(() => executor({
    ...context,
    budget: { ...context.budget, timeoutMs: 1 },
  }));
  assert.equal(error.code, "PROVIDER_TIMEOUT");
  assert.equal(error.diagnostic?.providerCallCount, 1);
  assert.equal(calls, 1);
});

test("only the two Doubao pilot tasks can reach live execution", async () => {
  let calls = 0;
  const executor = createDoubaoTextTaskExecutor(async () => {
    calls += 1;
    return doubaoResponse(validMusicBrief);
  });
  await expectTaskError(() => executor({
    ...doubaoContext("music.creative_brief"),
    task: "music.lyrics_draft",
  }), "PROVIDER_NOT_SUPPORTED_FOR_TASK");
  await expectTaskError(() => executor({
    ...doubaoContext("music.creative_brief"),
    provider: "kimi",
    serverControlledModel: null,
  }), "PROVIDER_NOT_SUPPORTED_FOR_TASK");
  assert.equal(calls, 0);
});


test("only the two DeepSeek pilot tasks can reach live execution", async () => {
  let calls = 0;
  const executor = createDeepSeekTextTaskExecutor(async () => {
    calls += 1;
    return deepseekResponse(validMusicBrief);
  });
  await expectTaskError(() => executor({
    ...deepseekContext("music.creative_brief"),
    task: "music.lyrics_draft",
  }), "PROVIDER_NOT_SUPPORTED_FOR_TASK");
  await expectTaskError(() => executor({
    ...deepseekContext("music.creative_brief"),
    provider: "kimi",
    serverControlledModel: null,
  }), "PROVIDER_NOT_SUPPORTED_FOR_TASK");
  assert.equal(calls, 0);
});

test("guarded DeepSeek task verifier uses an environment-only key and guaranteed cleanup", () => {
  assert.match(deepseekTaskLiveVerifierSource, /process\.env\.MEDCLIP_TEST_DEEPSEEK_API_KEY/);
  assert.match(deepseekTaskLiveVerifierSource, /DEEPSEEK LIVE VERIFIER = READY/);
  assert.match(deepseekTaskLiveVerifierSource, /LIVE TEST STATUS = NOT RUN/);
  assert.match(deepseekTaskLiveVerifierSource, /task: "music\.creative_brief"/);
  assert.match(deepseekTaskLiveVerifierSource, /task: "editor\.requirements_parse"/);
  assert.match(deepseekTaskLiveVerifierSource, /action: "save"/);
  assert.match(deepseekTaskLiveVerifierSource, /action: "delete"/);
  assert.match(deepseekTaskLiveVerifierSource, /finally/);
  assert.match(deepseekTaskLiveVerifierSource, /PROVIDER GENERATION CALLS = 2/);
  assert.match(deepseekTaskLiveVerifierSource, /FAILED TASK =/);
  assert.match(deepseekTaskLiveVerifierSource, /FAILURE STAGE =/);
  assert.match(deepseekTaskLiveVerifierSource, /SAFE ERROR CATEGORY =/);
  assert.match(deepseekTaskLiveVerifierSource, /HTTP STATUS =/);
  assert.match(deepseekTaskLiveVerifierSource, /PROVIDER ERROR CODE =/);
  assert.match(deepseekTaskLiveVerifierSource, /PROVIDER CALL COUNT =/);
  assert.match(deepseekTaskLiveVerifierSource, /AUTOMATIC RETRY = 0/);
  assert.doesNotMatch(deepseekTaskLiveVerifierSource, /writeFile|appendFile|\.env\.local\s*=/);
  assert.doesNotMatch(deepseekTaskLiveVerifierSource, /console\.(?:log|error)\([^\n]*(?:deepseekApiKey|accessToken|password)/);
});

test("guarded Kimi task verifier uses one environment-only key with safe diagnostics and cleanup", () => {
  assert.match(kimiTaskLiveVerifierSource, /process\.env\.MEDCLIP_TEST_KIMI_API_KEY/);
  assert.doesNotMatch(kimiTaskLiveVerifierSource, /MEDCLIP_TEST_KIMI_RESOURCE_ID/);
  assert.match(kimiTaskLiveVerifierSource, /KIMI TASK LIVE VERIFIER = READY/);
  assert.match(kimiTaskLiveVerifierSource, /LIVE TEST STATUS = NOT RUN/);
  assert.match(kimiTaskLiveVerifierSource, /task,\s*provider: "kimi"/);
  assert.match(kimiTaskLiveVerifierSource, /action: "save"/);
  assert.match(kimiTaskLiveVerifierSource, /action: "delete"/);
  assert.match(kimiTaskLiveVerifierSource, /finally/);
  assert.match(kimiTaskLiveVerifierSource, /CREDENTIAL VALIDATION PROVIDER CALLS = 1/);
  assert.match(kimiTaskLiveVerifierSource, /MUSIC GENERATION PROVIDER CALLS = 1/);
  assert.match(kimiTaskLiveVerifierSource, /EDITOR GENERATION PROVIDER CALLS = 1/);
  assert.match(kimiTaskLiveVerifierSource, /UPSTREAM HTTP STATUS =/);
  assert.match(kimiTaskLiveVerifierSource, /PROVIDER ERROR CODE =/);
  assert.match(kimiTaskLiveVerifierSource, /SANITIZED PROVIDER ERROR MESSAGE =/);
  assert.match(kimiTaskLiveVerifierSource, /AUTOMATIC RETRY = 0/);
  assert.doesNotMatch(kimiTaskLiveVerifierSource, /writeFile|appendFile|\.env\.local\s*=/);
  assert.doesNotMatch(kimiTaskLiveVerifierSource, /console\.(?:log|error)\([^\n]*(?:kimiApiKey|accessToken|password)/);
});

test("guarded Doubao task verifier requires environment-only key and resource with cleanup", () => {
  assert.match(doubaoTaskLiveVerifierSource, /process\.env\.MEDCLIP_TEST_DOUBAO_API_KEY/);
  assert.match(doubaoTaskLiveVerifierSource, /process\.env\.MEDCLIP_TEST_DOUBAO_RESOURCE_ID/);
  assert.match(doubaoTaskLiveVerifierSource, /\^apikey-/);
  assert.match(doubaoTaskLiveVerifierSource, /API KEY RESOURCE ID FORMAT = INVALID/);
  assert.match(doubaoTaskLiveVerifierSource, /DOUBAO TASK LIVE VERIFIER = READY/);
  assert.match(doubaoTaskLiveVerifierSource, /LIVE TEST STATUS = NOT RUN/);
  assert.match(doubaoTaskLiveVerifierSource, /invokeTask\("userB", userB, "music\.creative_brief"/);
  assert.match(doubaoTaskLiveVerifierSource, /currentTask = "editor\.requirements_parse"/);
  assert.match(doubaoTaskLiveVerifierSource, /action: "save"/);
  assert.match(doubaoTaskLiveVerifierSource, /action: "delete"/);
  assert.match(doubaoTaskLiveVerifierSource, /finally/);
  assert.match(doubaoTaskLiveVerifierSource, /FINAL DOUBAO TEST CREDENTIAL REMAINS = NOT CREATED/);
  assert.match(doubaoTaskLiveVerifierSource, /CLEANUP = NOT REQUIRED/);
  assert.match(doubaoTaskLiveVerifierSource, /PROVIDER TASK GENERATION CALLS = 2/);
  assert.match(doubaoTaskLiveVerifierSource, /AUTOMATIC RETRY = 0/);
  assert.doesNotMatch(doubaoTaskLiveVerifierSource, /writeFile|appendFile|\.env\.local\s*=/);
  assert.doesNotMatch(doubaoTaskLiveVerifierSource, /console\.(?:log|error)\([^\n]*(?:doubaoApiKey|doubaoResourceId|accessToken|password)/);
});

test("safe task diagnostics reject arbitrary upstream strings", () => {
  const safe = safeTaskErrorResponse(new SafeTaskError(
    "PROVIDER_HTTP_ERROR",
    "safe message",
    502,
    {
      provider: "deepseek",
      failureStage: "provider_response",
      httpStatus: 503,
      providerErrorCode: "unsafe code with raw text",
      missingFields: ["notes", "unsafe field with spaces"],
      invalidFields: ["$unknown"],
      providerCallCount: 1,
    },
  ));
  const diagnostic = safe.body.diagnostic as Record<string, unknown>;
  assert.equal(diagnostic.providerErrorCode, undefined);
  assert.deepEqual(diagnostic.missingFields, ["notes"]);
  assert.deepEqual(diagnostic.invalidFields, ["$unknown"]);
  assert.doesNotMatch(JSON.stringify(safe.body), /unsafe code with raw text|unsafe field with spaces/);
});

test("text operator diagnostics are content-free while ordinary errors omit internal classification", () => {
  const error = new SafeTaskError(
    "PROVIDER_INVALID_JSON",
    "safe browser message",
    502,
    {
      provider: "deepseek",
      failureStage: "provider_response",
      failureClass: "UPSTREAM_JSON_PARSE_ERROR",
      httpStatus: 200,
      providerCallCount: 1,
      providerResponseReceived: true,
      responseJsonParseable: false,
      canonicalValidationReached: false,
    },
  );
  const operator = textTaskOperatorDiagnostic(error, {
    requestId: "11111111-2222-4333-8444-555555555555",
    task: "editor.requirements_parse",
    provider: "deepseek",
    model: DEEPSEEK_TASK_MODEL,
    requestStartedAtMs: 10,
    now: () => 25,
  });
  assert.deepEqual(Object.keys(operator).sort(), [
    "canonical_validation_reached",
    "event",
    "failure_class",
    "failure_stage",
    "model",
    "provider",
    "provider_http_status",
    "provider_response_received",
    "request_duration_ms",
    "request_id",
    "response_json_parseable",
    "safe_error_code",
    "task",
  ]);
  const publicBody = safeTaskErrorResponse(error).body;
  const publicDiagnostic = publicBody.diagnostic as Record<string, unknown>;
  assert.equal(publicDiagnostic.failureClass, undefined);
  assert.equal(publicDiagnostic.providerResponseReceived, undefined);
  assert.equal(publicDiagnostic.responseJsonParseable, undefined);
  assert.equal(publicDiagnostic.canonicalValidationReached, undefined);
  assert.doesNotMatch(JSON.stringify(operator), /editingRequirement|editorContext|Authorization|api[_-]?key|ciphertext|raw_response/i);
  assert.match(handlerSource, /console\.error\(JSON\.stringify\(operatorDiagnostic\)\)/);
  assert.match(handlerSource, /X-MedClip-Request-Id/);
});

test("safe task diagnostics allow Doubao only as a fixed provider label", () => {
  const safe = safeTaskErrorResponse(new SafeTaskError(
    "PROVIDER_RATE_LIMIT",
    "safe message",
    429,
    { provider: "doubao", failureStage: "provider_response", httpStatus: 429, providerCallCount: 1 },
  ));
  assert.equal((safe.body.diagnostic as Record<string, unknown>).provider, "doubao");
  assert.doesNotMatch(JSON.stringify(safe.body), /fixture-provider-key-not-real|apikey-20260917000000-test1/);
});

test("safe task diagnostics allow Kimi label and bounded sanitized provider messages", () => {
  const safe = safeTaskErrorResponse(new SafeTaskError(
    "PROVIDER_RATE_LIMIT",
    "safe message",
    429,
    {
      provider: "kimi",
      failureStage: "provider_response",
      httpStatus: 429,
      providerErrorCode: "rate_limit_reached",
      sanitizedProviderErrorMessage: "Requests per minute exceeded.",
      providerCallCount: 1,
    },
  ));
  const diagnostic = safe.body.diagnostic as Record<string, unknown>;
  assert.equal(diagnostic.provider, "kimi");
  assert.equal(diagnostic.sanitizedProviderErrorMessage, "Requests per minute exceeded.");
  assert.doesNotMatch(JSON.stringify(safe.body), /fixture-provider-key-not-real|Authorization/);
});

test("safe ai-tasks runtime verifier cannot call a live Provider", () => {
  assert.match(taskEdgeVerifierSource, /task: "music\.lyrics_draft"/);
  assert.match(taskEdgeVerifierSource, /PROVIDER API CALLED = NO/);
  assert.doesNotMatch(taskEdgeVerifierSource, /task: "music\.creative_brief"|task: "editor\.requirements_parse"/);
});

test("browser AI task client exposes business input only", () => {
  assert.match(clientSource, /runAITask\(request: RunAITaskRequest\)/);
  assert.doesNotMatch(clientSource, /\bapiKey\??:|\bbaseURL\??:|\bendpoint\??:|\btimeout\??:|\bheaders\??:|\bmodel\??:|\bAuthorization\??:/);
  assert.match(clientSource, /functions\.invoke\("ai-tasks"/);
});

test("credential Provider adapters and Doubao validation timeout remain unchanged", () => {
  assert.match(deepseekSource, /https:\/\/api\.deepseek\.com/);
  assert.match(kimiSource, /https:\/\/api\.moonshot\.cn\/v1/);
  assert.match(doubaoSource, /DOUBAO_VALIDATION_TIMEOUT_MS = 30_000/);
});

function expectedLocalHTTPCode(code: string): string {
  return ({ PROVIDER_PAYMENT_OR_QUOTA_ERROR: "QUOTA_OR_BALANCE", PROVIDER_AUTH_ERROR: "AUTH_REJECTED", PROVIDER_RATE_LIMIT: "RATE_LIMITED", PROVIDER_BAD_REQUEST: "CONFIGURATION_REJECTED", PROVIDER_HTTP_ERROR: "UPSTREAM_UNAVAILABLE", PROVIDER_CONFIGURATION_REQUIRED: "ACCOUNT_TIER_RESTRICTED", PROVIDER_UNAVAILABLE: "CAPACITY_EXHAUSTED" } as Record<string,string>)[code];
}
