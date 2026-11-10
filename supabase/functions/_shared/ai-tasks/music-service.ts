import { SafeTaskError } from "./errors.ts";
import {
  canonicalGeneratedMusicAudioPath,
  finalizeGeneratedMusic,
  MusicFinalizationError,
  type MusicFinalizationRepository,
} from "./music-finalization.ts";
import {
  assertMusicOperationRequestBinding,
  markMusicOperationFailed,
  markMusicOperationFinalizing,
  markMusicOperationUnknown,
  markMusicProviderInFlight,
  MusicOperationError,
  reserveMusicGenerationOperation,
  type MusicGenerationOperation,
  type MusicOperationRepository,
} from "./music-operation.ts";
import { AmbiguousMusicProviderError } from "./providers/tencent-tokenhub-music.ts";
import type {
  MusicGenerationExecutor,
  MusicGenerationInput,
  MusicGenerationProviderResult,
  ParsedAITaskRequest,
} from "./types.ts";
import type { MusicDispatchPolicy } from "./music-product-release.ts";

export type MusicGenerationServiceDependencies = {
  operations: MusicOperationRepository;
  tracks: MusicFinalizationRepository;
  executeMusic: MusicGenerationExecutor;
  preReservedOperation?: MusicGenerationOperation;
  dispatchPolicy?: MusicDispatchPolicy;
  now?: () => number;
};

export type MusicCredentialTiming = {
  credentialLookupDecryptMs: number;
  requestStartedAtMs: number;
};

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function trustedInternalDiagnostics(
  providerResult: MusicGenerationProviderResult,
  requestStartedAtMs: number,
  now: () => number,
  finalizationMetrics?: { storageUploadMs: number; trackFinalizationMs: number },
): Readonly<Record<string, unknown>> | undefined {
  if (!providerResult.trustedURLDiagnostics) return undefined;
  return {
    ...providerResult.trustedURLDiagnostics,
    provider_generation_ms: roundMs(providerResult.metrics.providerGenerationLatencyMs),
    url_policy_validation_ms: roundMs(providerResult.metrics.urlPolicyValidationMs ?? 0),
    dns_preflight_ms: roundMs(providerResult.metrics.dnsPreflightMs ?? 0),
    download_first_response_ms: roundMs(providerResult.metrics.downloadFirstResponseMs ?? 0),
    download_total_ms: roundMs(providerResult.metrics.downloadTotalMs ?? 0),
    mp3_validation_ms: roundMs(providerResult.metrics.mp3ValidationMs),
    ...(finalizationMetrics
      ? {
        storage_upload_ms: roundMs(finalizationMetrics.storageUploadMs),
        track_finalization_ms: roundMs(finalizationMetrics.trackFinalizationMs),
      }
      : {}),
    total_task_wall_clock_ms: roundMs(now() - requestStartedAtMs),
    ...(typeof providerResult.providerReportedDurationSeconds === "number"
      ? { provider_reported_music_duration_seconds: providerResult.providerReportedDurationSeconds }
      : {}),
    ...(typeof providerResult.metadata.musicSize === "number"
      ? { provider_reported_music_size: providerResult.metadata.musicSize }
      : {}),
  };
}

function finalizationFailureCode(stage: MusicFinalizationError["stage"]): string {
  if (stage === "DRAFT_CREATE") return "DRAFT_CREATE_FAILED";
  if (stage === "STORAGE_UPLOAD") return "STORAGE_UPLOAD_FAILED";
  if (stage === "DATABASE_FINALIZE") return "TRACK_FINALIZATION_FAILED";
  return "OPERATION_COMPLETION_FAILED";
}

export function musicGenerationInputFromRequest(request: ParsedAITaskRequest): MusicGenerationInput {
  const operationId = request.input.operationId;
  const mode = request.input.mode;
  const title = request.input.title;
  const prompt = request.input.prompt;
  const lyrics = request.input.lyrics;
  if (
    request.task !== "music.generate"
    || request.provider !== "tencent_tokenhub"
    || typeof operationId !== "string"
    || (mode !== "custom_lyrics" && mode !== "instrumental")
    || (title !== undefined && typeof title !== "string")
    || (prompt !== undefined && typeof prompt !== "string")
  ) {
    throw new SafeTaskError("INVALID_INPUT", "Music generation input is invalid.", 400);
  }
  if (mode === "custom_lyrics") {
    if (typeof lyrics !== "string") {
      throw new SafeTaskError("INVALID_INPUT", "Custom lyrics are required.", 400);
    }
    return { operationId, mode, lyrics, ...(prompt ? { prompt } : {}), ...(title ? { title } : {}) };
  }
  if (typeof prompt !== "string") {
    throw new SafeTaskError("INVALID_INPUT", "An instrumental prompt is required.", 400);
  }
  return { operationId, mode, prompt, ...(title ? { title } : {}) };
}

function backgroundObservationResult(
  operation: MusicGenerationOperation,
  requestStartedAtMs: number,
  now: () => number,
  credentialLookupDecryptMs: number,
): Record<string, unknown> {
  return {
    ok: true,
    task: "music.generate",
    provider: "tencent_tokenhub",
    result: {
      capability: "MUSIC_GENERATION",
      data: {
        operationId: operation.operationId,
        operationState: operation.state,
      },
    },
    usage: null,
    metadata: {
      providerUsed: "tencent_tokenhub",
      taskType: "music.generate",
      generationOccurred: false,
      replayed: true,
      musicStage: operation.state,
      timings: {
        credentialLookupDecryptMs: roundMs(credentialLookupDecryptMs),
        totalTaskWallClockMs: roundMs(now() - requestStartedAtMs),
      },
    },
  };
}

async function settleProviderFailure(
  repository: MusicOperationRepository,
  operation: MusicGenerationOperation,
  error: unknown,
): Promise<never> {
  const ambiguous = error instanceof AmbiguousMusicProviderError;
  const failureDiagnostics = error instanceof SafeTaskError
    ? error.musicProviderFailureDiagnostics ?? null
    : null;
  try {
    if (ambiguous) {
      await markMusicOperationUnknown(
        repository,
        operation,
        "PROVIDER_OUTCOME_UNKNOWN",
        failureDiagnostics,
      );
    } else {
      await markMusicOperationFailed(
        repository,
        operation,
        "PROVIDER_REQUEST_FAILED",
        failureDiagnostics,
      );
    }
  } catch {
    if (!ambiguous) {
      try {
        await markMusicOperationUnknown(
          repository,
          operation,
          "PROVIDER_STATE_UNCERTAIN",
          failureDiagnostics,
        );
      } catch {
        // Never issue a second paid request when state persistence is uncertain.
      }
    }
  }
  if (error instanceof SafeTaskError) throw error;
  throw new SafeTaskError("INTERNAL_TASK_ERROR", "Music generation could not be completed safely.", 500, {
    provider: "tencent_tokenhub",
    failureStage: "internal",
    providerCallCount: 1,
  });
}

function operationResult(
  operation: MusicGenerationOperation,
  generationOccurred: boolean,
  requestStartedAtMs: number,
  now: () => number,
  credentialLookupDecryptMs: number,
): Record<string, unknown> {
  if (operation.state !== "COMPLETED" || !operation.finalTrackId) {
    throw new SafeTaskError(
      "PROVIDER_UNAVAILABLE",
      `Music operation is already ${operation.state} and will not be generated again.`,
      409,
      { provider: "tencent_tokenhub", providerCallCount: operation.providerCallCount },
    );
  }
  return {
    ok: true,
    task: "music.generate",
    provider: "tencent_tokenhub",
    result: {
      capability: "MUSIC_GENERATION",
      data: {
        operationId: operation.operationId,
        operationInitialState: operation.state,
        operationState: operation.state,
        providerCallCount: operation.providerCallCount,
        trackId: operation.finalTrackId,
        bucket: "music-audio",
        audioPath: canonicalGeneratedMusicAudioPath(operation.userId, operation.finalTrackId),
        published: false,
      },
    },
    usage: null,
    metadata: {
      providerUsed: "tencent_tokenhub",
      taskType: "music.generate",
      generationOccurred,
      replayed: true,
      musicStage: "COMPLETED",
      timings: {
        credentialLookupDecryptMs: roundMs(credentialLookupDecryptMs),
        totalTaskWallClockMs: roundMs(now() - requestStartedAtMs),
      },
    },
  };
}

export async function executeMusicGenerationRequest(
  authenticatedUserId: string,
  request: ParsedAITaskRequest,
  apiKey: string,
  serverControlledModel: string,
  timeoutMs: number,
  timing: MusicCredentialTiming,
  dependencies: MusicGenerationServiceDependencies,
  options: { includeTrustedDiagnostics?: boolean } = {},
): Promise<Record<string, unknown>> {
  const now = dependencies.now ?? (() => performance.now());
  const input = musicGenerationInputFromRequest(request);
  const reservationStartedAt = now();
  let reserved;
  if (dependencies.preReservedOperation) {
    try {
      await assertMusicOperationRequestBinding(
        authenticatedUserId,
        input,
        dependencies.preReservedOperation,
      );
      reserved = { operation: dependencies.preReservedOperation, reused: false };
    } catch (error) {
      if (error instanceof MusicOperationError && error.code === "OPERATION_CONFLICT") {
        throw new SafeTaskError(
          "OPERATION_CONFLICT",
          "The operation ID is already bound to different music input.",
          409,
          { provider: "tencent_tokenhub", providerCallCount: 0 },
        );
      }
      throw error;
    }
  } else {
    try {
      reserved = await reserveMusicGenerationOperation(
        authenticatedUserId,
        input,
        dependencies.operations,
        dependencies.dispatchPolicy,
      );
    } catch (error) {
      if (error instanceof MusicOperationError && error.code === "OPERATION_CONFLICT") {
        throw new SafeTaskError(
          "OPERATION_CONFLICT",
          "The operation ID is already bound to different music input.",
          409,
          { provider: "tencent_tokenhub", providerCallCount: 0 },
        );
      }
      throw error;
    }
  }
  const operationReservationMs = roundMs(now() - reservationStartedAt);

  if (reserved.reused) {
    return operationResult(
      reserved.operation,
      false,
      timing.requestStartedAtMs,
      now,
      timing.credentialLookupDecryptMs,
    );
  }

  let inFlight;
  try {
    inFlight = await markMusicProviderInFlight(
      dependencies.operations,
      reserved.operation,
      dependencies.dispatchPolicy,
    );
  } catch (error) {
    if (error instanceof MusicOperationError) {
      const quotaFailure = error.code === "MUSIC_DAILY_LIMIT_REACHED"
        || error.code === "MUSIC_GLOBAL_LIMIT_REACHED"
        || error.code === "MUSIC_GENERATION_ALREADY_ACTIVE";
      if (quotaFailure) {
        try {
          await markMusicOperationFailed(
            dependencies.operations,
            reserved.operation,
            error.code,
          );
        } catch {
          // A concurrent worker may already have settled the same operation.
        }
        const messages = {
          MUSIC_DAILY_LIMIT_REACHED: "今天的歌曲生成次数已用完，请稍后再试。",
          MUSIC_GLOBAL_LIMIT_REACHED: "歌曲生成服务今日额度已用完，请稍后再试。",
          MUSIC_GENERATION_ALREADY_ACTIVE: "已有歌曲正在生成，请等待当前任务完成。",
        } as const;
        throw new SafeTaskError(error.code, messages[error.code], 429, {
          provider: "tencent_tokenhub",
          providerCallCount: 0,
        });
      }
    }
    if (
      dependencies.preReservedOperation
      && error instanceof MusicOperationError
      && error.code === "OPERATION_TRANSITION_CONFLICT"
    ) {
      const observed = await dependencies.operations.load(
        reserved.operation.userId,
        reserved.operation.operationId,
      );
      if (observed && observed.state !== "RESERVED") {
        await assertMusicOperationRequestBinding(authenticatedUserId, input, observed);
        return backgroundObservationResult(
          observed,
          timing.requestStartedAtMs,
          now,
          timing.credentialLookupDecryptMs,
        );
      }
    }
    throw error;
  }
  let providerResult;
  try {
    providerResult = await dependencies.executeMusic({
      userId: authenticatedUserId,
      provider: "tencent_tokenhub",
      input,
      apiKey,
      serverControlledModel,
      timeoutMs,
      automaticProviderRetryCount: 0,
      maxProviderCalls: 1,
    });
  } catch (error) {
    return await settleProviderFailure(dependencies.operations, inFlight, error);
  }

  const accumulatedTrustedDiagnostics = options.includeTrustedDiagnostics
    ? trustedInternalDiagnostics(providerResult, timing.requestStartedAtMs, now)
    : undefined;

  let finalizing;
  try {
    finalizing = await markMusicOperationFinalizing(dependencies.operations, inFlight, {
      requestId: providerResult.metadata.requestId,
      traceId: providerResult.metadata.traceId,
    });
  } catch {
    throw new SafeTaskError(
      "FINALIZATION_FAILED",
      "Generated music could not enter finalization safely.",
      502,
      {
        provider: "tencent_tokenhub",
        failureStage: "internal",
        providerCallCount: 1,
        providerErrorType: "OPERATION_FINALIZING",
        musicStage: "FINALIZING",
      },
      accumulatedTrustedDiagnostics,
    );
  }
  let finalized;
  try {
    finalized = await finalizeGeneratedMusic(
      authenticatedUserId,
      finalizing,
      input,
      providerResult,
      {
        tracks: dependencies.tracks,
        operations: dependencies.operations,
        now,
      },
    );
  } catch (error) {
    if (error instanceof MusicFinalizationError) {
      throw new SafeTaskError(
        "FINALIZATION_FAILED",
        "Generated music could not be finalized safely.",
        502,
        {
          provider: "tencent_tokenhub",
          failureStage: "internal",
          providerCallCount: 1,
          providerErrorType: finalizationFailureCode(error.stage),
          musicStage: "FINALIZING",
        },
        accumulatedTrustedDiagnostics,
      );
    }
    throw error;
  }
  const totalTaskWallClockMs = roundMs(now() - timing.requestStartedAtMs);
  const completedTrustedInternalDiagnostics = options.includeTrustedDiagnostics
    ? trustedInternalDiagnostics(
      providerResult,
      timing.requestStartedAtMs,
      now,
      finalized.metrics,
    )
    : undefined;

  return {
    ok: true,
    task: "music.generate",
    provider: "tencent_tokenhub",
    result: {
      capability: "MUSIC_GENERATION",
      data: {
        operationId: input.operationId,
        operationInitialState: reserved.operation.state,
        operationState: "COMPLETED",
        providerCallCount: 1,
        trackId: finalized.trackId,
        bucket: finalized.bucket,
        audioPath: finalized.path,
        published: finalized.published,
        providerReportedDurationSeconds: finalized.providerReportedDurationSeconds,
        providerReportedMusicSize: providerResult.metadata.musicSize ?? null,
        providerReportedSampleRate: providerResult.metadata.musicSampleRate ?? null,
        providerReportedBitrate: providerResult.metadata.bitrate ?? null,
        providerReportedChannelCount: providerResult.metadata.musicChannel ?? null,
        hexCharacterLength: providerResult.metrics.hexCharacterLength,
        decodedMp3Bytes: providerResult.audioBytes.byteLength,
      },
    },
    usage: providerResult.usage ?? null,
    metadata: {
      providerUsed: "tencent_tokenhub",
      taskType: "music.generate",
      generationOccurred: true,
      replayed: false,
      musicStage: "COMPLETED",
      timings: {
        credentialLookupDecryptMs: roundMs(timing.credentialLookupDecryptMs),
        operationReservationMs,
        providerGenerationLatencyMs: roundMs(providerResult.metrics.providerGenerationLatencyMs),
        providerResponseMs: roundMs(providerResult.metrics.providerResponseMs),
        hexValidationDecodeMs: roundMs(providerResult.metrics.hexValidationDecodeMs),
        mp3ValidationMs: roundMs(providerResult.metrics.mp3ValidationMs),
        storageUploadMs: roundMs(finalized.metrics.storageUploadMs),
        trackFinalizationMs: roundMs(finalized.metrics.trackFinalizationMs),
        totalTaskWallClockMs,
      },
      ...(completedTrustedInternalDiagnostics
        ? { trustedInternalDiagnostics: completedTrustedInternalDiagnostics }
        : {}),
    },
  };
}
