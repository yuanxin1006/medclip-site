import { SafeTaskError } from "./errors.ts";
import { normalizeMusicProviderFailureDiagnostics } from "./music-failure-diagnostics.ts";
import { DraftCreateRejectedError, type MusicFinalizationRepository } from "./music-finalization.ts";
import {
  markMusicOperationFailed,
  markMusicOperationUnknown,
  MusicOperationError,
  reserveMusicGenerationOperation,
  type MusicGenerationOperation,
  type MusicOperationRepository,
} from "./music-operation.ts";
import {
  executeMusicGenerationRequest,
  musicGenerationInputFromRequest,
  type MusicGenerationServiceDependencies,
} from "./music-service.ts";
import { parseAITaskRequest, requireAuthenticatedTaskUserId } from "./request.ts";
import { executeAITaskRequest, type TaskCredentialRepository } from "./service.ts";
import type { MusicGenerationExecutor, MusicGenerationProviderResult, ParsedAITaskRequest } from "./types.ts";
import { AmbiguousMusicProviderError } from "./providers/tencent-tokenhub-music.ts";
import type { MusicDispatchPolicy } from "./music-product-release.ts";

export const MUSIC_GENERATION_START_ACTION = "music.generation_start" as const;
export const INTERNAL_ASYNC_MUSIC_MOCK_HEADER = "x-medclip-internal-async-music-mock";
export const INTERNAL_ASYNC_MUSIC_WORKERS_HEADER = "x-medclip-internal-async-music-workers";
export const TRUSTED_ASYNC_MUSIC_MOCK_STEP_DELAY_MS = 1_500;

export const ASYNC_MUSIC_MOCK_SCENARIOS = [
  "success",
  "before_provider_failure",
  "provider_failure",
  "unknown_after_dispatch",
  "finalizing_failure",
  "background_rejection",
] as const;

export type AsyncMusicMockScenario = typeof ASYNC_MUSIC_MOCK_SCENARIOS[number];
export type AsyncMusicExecutionMode = "public_real" | "trusted_mock" | "tester_live";

export type AsyncMusicStartRequest = {
  action: typeof MUSIC_GENERATION_START_ACTION;
  request: ParsedAITaskRequest;
};

export type AsyncMusicStartResponse = {
  accepted: true;
  operationId: string;
  status: MusicGenerationOperation["state"];
};

export type AsyncMusicBackgroundDependencies = {
  operations: MusicOperationRepository;
  tracks: MusicFinalizationRepository;
  credentialRepository: TaskCredentialRepository;
  encryptionKey: string;
  executeMusic: MusicGenerationExecutor;
  serverControlledModel: string;
  timeoutMs: number;
  executionMode: AsyncMusicExecutionMode;
  dispatchPolicy?: MusicDispatchPolicy;
  mockScenario?: AsyncMusicMockScenario;
  mockStepDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

export type AsyncMusicStartDependencies = {
  operations: MusicOperationRepository;
  executionMode: AsyncMusicExecutionMode;
  dispatchPolicy?: MusicDispatchPolicy;
  schedule: (promise: Promise<void>) => void;
  runBackground: (
    request: ParsedAITaskRequest,
    operation: MusicGenerationOperation,
  ) => Promise<void>;
  workerCopies?: 1 | 2;
};

const START_FIELDS = new Set(["action", "input"]);
function syntheticMp3(): Uint8Array {
  // Forty MPEG-1 Layer III frames provide a deterministic ~1 second silent
  // browser-loadable fixture without contacting or downloading from a Provider.
  const frameLength = 417;
  const frameCount = 40;
  const bytes = new Uint8Array(frameLength * frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    bytes.set([0xff, 0xfb, 0x90, 0x64], frame * frameLength);
  }
  return bytes;
}

const SYNTHETIC_MP3 = syntheticMp3();

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isAsyncMusicStartEnvelope(value: unknown): boolean {
  return plainRecord(value) && value.action === MUSIC_GENERATION_START_ACTION;
}

export function parseAsyncMusicStartRequest(value: unknown): AsyncMusicStartRequest {
  if (
    !plainRecord(value)
    || Object.keys(value).some((key) => !START_FIELDS.has(key))
    || value.action !== MUSIC_GENERATION_START_ACTION
  ) {
    throw new SafeTaskError("INVALID_INPUT", "歌曲生成启动请求无效。", 400);
  }
  return {
    action: MUSIC_GENERATION_START_ACTION,
    request: parseAITaskRequest({
      task: "music.generate",
      provider: "tencent_tokenhub",
      input: value.input,
    }),
  };
}

export function parseTrustedAsyncMusicMockScenario(value: string | null): AsyncMusicMockScenario {
  const scenario = value ?? "success";
  if (!(ASYNC_MUSIC_MOCK_SCENARIOS as readonly string[]).includes(scenario)) {
    throw new SafeTaskError("INVALID_INPUT", "内部异步验证场景无效。", 400);
  }
  return scenario as AsyncMusicMockScenario;
}

export function parseTrustedAsyncMusicWorkerCopies(value: string | null): 1 | 2 {
  if (value === null || value === "1") return 1;
  if (value === "2") return 2;
  throw new SafeTaskError("INVALID_INPUT", "内部异步验证 worker 数量无效。", 400);
}

function safeOperationConflict(error: unknown): never {
  if (error instanceof MusicOperationError && error.code === "OPERATION_CONFLICT") {
    throw new SafeTaskError(
      "OPERATION_CONFLICT",
      "The operation ID is already bound to different music input.",
      409,
    );
  }
  if (error instanceof MusicOperationError && error.code === "MUSIC_GENERATION_ALREADY_ACTIVE") {
    throw new SafeTaskError(
      "MUSIC_GENERATION_ALREADY_ACTIVE",
      "已有歌曲正在生成，请等待当前任务完成。",
      409,
      { provider: "tencent_tokenhub", providerCallCount: 0 },
    );
  }
  if (error instanceof MusicOperationError && error.code === "MUSIC_DAILY_LIMIT_REACHED") {
    throw new SafeTaskError(
      "MUSIC_DAILY_LIMIT_REACHED",
      "今天的歌曲生成次数已用完，请稍后再试。",
      429,
      { provider: "tencent_tokenhub", providerCallCount: 0 },
    );
  }
  if (error instanceof MusicOperationError && error.code === "MUSIC_GLOBAL_LIMIT_REACHED") {
    throw new SafeTaskError(
      "MUSIC_GLOBAL_LIMIT_REACHED",
      "歌曲生成服务今日额度已用完，请稍后再试。",
      503,
      { provider: "tencent_tokenhub", providerCallCount: 0 },
    );
  }
  throw error;
}

async function settleBackgroundFailure(
  operations: MusicOperationRepository,
  userId: string,
  operationId: string,
  reservedFailureCode: string,
  error?: unknown,
): Promise<void> {
  const failureDiagnostics = error instanceof SafeTaskError
    ? error.musicProviderFailureDiagnostics ?? null
    : null;
  try {
    const current = await operations.load(userId, operationId);
    if (!current || current.userId !== userId) return;
    if (current.state === "RESERVED") {
      await markMusicOperationFailed(operations, current, reservedFailureCode, failureDiagnostics);
      return;
    }
    if (current.state === "PROVIDER_IN_FLIGHT" || current.state === "FINALIZING") {
      await markMusicOperationUnknown(
        operations,
        current,
        "BACKGROUND_OUTCOME_UNKNOWN",
        failureDiagnostics,
      );
    }
  } catch (error) {
    // The durable state may already have changed. Never schedule a replacement job.
  }
}

export async function runGuardedAsyncMusicBackground(
  request: ParsedAITaskRequest,
  operation: MusicGenerationOperation,
  dependencies: AsyncMusicBackgroundDependencies,
): Promise<void> {
  try {
    await runAsyncMusicBackground(request, operation, dependencies);
  } catch (error) {
    await settleBackgroundFailure(
      dependencies.operations,
      operation.userId,
      operation.operationId,
      "BACKGROUND_WORKER_FAILED",
      error,
    );
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mockProviderResult(): MusicGenerationProviderResult {
  return {
    audioBytes: SYNTHETIC_MP3,
    serverVerifiedDurationSeconds: null,
    format: "mp3",
    metadata: { musicSize: SYNTHETIC_MP3.byteLength },
    usage: null,
    metrics: {
      providerResponseMs: 0,
      providerRequestDurationMs: 0,
      providerGenerationLatencyMs: 0,
      hexValidationDecodeMs: 0,
      mp3ValidationMs: 0,
      hexCharacterLength: 0,
    },
  };
}

function mockTracks(
  tracks: MusicFinalizationRepository,
  scenario: AsyncMusicMockScenario,
  sleep: (milliseconds: number) => Promise<void>,
  delayMs: number,
): MusicFinalizationRepository {
  return {
    async createDraft(input) {
      await sleep(delayMs);
      if (scenario === "finalizing_failure") throw new DraftCreateRejectedError();
      return await tracks.createDraft(input);
    },
    uploadAudio: (input) => tracks.uploadAudio(input),
    finalizeDraft: (input) => tracks.finalizeDraft(input),
    deleteAudio: (bucket, path) => tracks.deleteAudio(bucket, path),
    deleteDraft: (userId, trackId) => tracks.deleteDraft(userId, trackId),
  };
}

export async function runAsyncMusicBackground(
  request: ParsedAITaskRequest,
  operation: MusicGenerationOperation,
  dependencies: AsyncMusicBackgroundDependencies,
): Promise<void> {
  const userId = requireAuthenticatedTaskUserId(operation.userId);
  const requestStartedAtMs = dependencies.now?.() ?? performance.now();
  if (dependencies.executionMode !== "trusted_mock") {
    await executeAITaskRequest(userId, request, {
      repository: dependencies.credentialRepository,
      encryptionKey: dependencies.encryptionKey,
      requestStartedAtMs,
      executionContext: "internal_async_music",
      music: {
        operations: dependencies.operations,
        tracks: dependencies.tracks,
        executeMusic: dependencies.executeMusic,
        preReservedOperation: operation,
        dispatchPolicy: dependencies.dispatchPolicy,
        now: dependencies.now,
      },
      now: dependencies.now,
    });
    return;
  }

  const scenario = dependencies.mockScenario ?? "success";
  const delayMs = dependencies.mockStepDelayMs ?? TRUSTED_ASYNC_MUSIC_MOCK_STEP_DELAY_MS;
  const sleep = dependencies.sleep ?? defaultSleep;
  await sleep(delayMs);
  if (scenario === "before_provider_failure" || scenario === "background_rejection") {
    throw new Error("Provider-free mock background failure.");
  }
  const executeMock: MusicGenerationExecutor = async () => {
    await sleep(delayMs);
    if (scenario === "unknown_after_dispatch") {
      throw new AmbiguousMusicProviderError(
        "UNKNOWN_PROVIDER_RESULT",
        "Provider-free mock outcome is intentionally unknown.",
        normalizeMusicProviderFailureDiagnostics({
          providerResponseReceived: false,
          providerErrorClass: "UNKNOWN",
          providerFailureStage: "FETCH_DISPATCHED",
          providerResponseClassification: "NO_RESPONSE",
          providerResponseJsonParseable: false,
          providerRequestDurationMs: 0,
        }),
      );
    }
    if (scenario === "provider_failure") {
      throw new SafeTaskError(
        "PROVIDER_UNAVAILABLE",
        "Provider-free mock failure.",
        503,
        undefined,
        undefined,
        normalizeMusicProviderFailureDiagnostics({
          providerResponseReceived: true,
          providerHttpStatus: 503,
          providerErrorClass: "HTTP_ERROR",
          providerFailureStage: "HTTP_VALIDATED",
          providerResponseClassification: "HTTP_ERROR_JSON",
          providerResponseJsonParseable: true,
          providerRequestDurationMs: 0,
        }),
      );
    }
    return mockProviderResult();
  };
  await executeMusicGenerationRequest(
    userId,
    request,
    "provider-free-internal-mock",
    dependencies.serverControlledModel,
    dependencies.timeoutMs,
    { credentialLookupDecryptMs: 0, requestStartedAtMs },
    {
      operations: dependencies.operations,
      tracks: mockTracks(dependencies.tracks, scenario, sleep, delayMs),
      executeMusic: executeMock,
      preReservedOperation: operation,
      dispatchPolicy: dependencies.dispatchPolicy,
      now: dependencies.now,
    },
  );
}

export async function startAsyncMusicGeneration(
  authenticatedUserId: string,
  parsed: AsyncMusicStartRequest,
  dependencies: AsyncMusicStartDependencies,
): Promise<AsyncMusicStartResponse> {
  const userId = requireAuthenticatedTaskUserId(authenticatedUserId);
  // Ordinary real execution is authorized by the explicit server-side release
  // policy and atomic quota gates supplied by the Edge handler. It is not
  // enabled through the generic text-task live allowlist.
  const input = musicGenerationInputFromRequest(parsed.request);
  let reserved;
  try {
    reserved = await reserveMusicGenerationOperation(
      userId,
      input,
      dependencies.operations,
      dependencies.dispatchPolicy,
    );
  } catch (error) {
    safeOperationConflict(error);
  }

  if (!reserved.reused) {
    let releaseBackground: () => void = () => undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    const workerCopies = dependencies.workerCopies ?? 1;
    const background = startGate
      .then(async () => {
        await Promise.all(Array.from({ length: workerCopies }, () => (
          dependencies.runBackground(parsed.request, reserved.operation)
        )));
      })
      .catch(async () => {
        await settleBackgroundFailure(
          dependencies.operations,
          userId,
          reserved.operation.operationId,
          "BACKGROUND_WORKER_FAILED",
        );
      })
      .then(() => undefined, () => undefined);

    try {
      dependencies.schedule(background);
      releaseBackground();
    } catch {
      await settleBackgroundFailure(
        dependencies.operations,
        userId,
        reserved.operation.operationId,
        "BACKGROUND_SCHEDULING_FAILED",
      );
      throw new SafeTaskError("INTERNAL_TASK_ERROR", "歌曲生成后台任务暂时无法启动。", 500);
    }
  }

  return {
    accepted: true,
    operationId: reserved.operation.operationId,
    status: reserved.operation.state,
  };
}
