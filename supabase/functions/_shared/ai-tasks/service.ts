import { decryptCredential } from "../ai-credentials/crypto.ts";
import type { AIProviderId } from "../ai-credentials/providers/types.ts";
import type { SavedCredential } from "../ai-credentials/service.ts";
import { getTaskBudget } from "./budget.ts";
import { SafeTaskError } from "./errors.ts";
import {
  executeMusicGenerationRequest,
  type MusicGenerationServiceDependencies,
} from "./music-service.ts";
import {
  dispatchTaskByCapability,
  getTaskDefinition,
  getTaskProviderPolicy,
  requireCapability,
  requireTaskExecutionSupport,
} from "./registry.ts";
import { requireAuthenticatedTaskUserId } from "./request.ts";
import { safeResultData } from "./safe-result.ts";
import type {
  AITaskExecutor,
  AITaskResultValue,
  ParsedAITaskRequest,
  SafeTaskUsage,
} from "./types.ts";

export type TaskCredentialRepository = {
  getSavedCredential(userId: string, provider: AIProviderId): Promise<SavedCredential | null>;
};

export type AITaskServiceDependencies = {
  repository: TaskCredentialRepository;
  encryptionKey: string;
  executeTask?: AITaskExecutor;
  music?: MusicGenerationServiceDependencies;
  now?: () => number;
  requestStartedAtMs?: number;
  executionContext?: "normal" | "internal_live_validation" | "internal_async_music";
};

function safeUsage(usage: SafeTaskUsage | null | undefined): SafeTaskUsage | null {
  if (!usage) return null;
  const values = [usage.input_tokens, usage.output_tokens, usage.total_tokens];
  if (values.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0))) return null;
  return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.total_tokens };
}

export async function executeAITaskRequest(authenticatedUserId: string, request: ParsedAITaskRequest, dependencies: AITaskServiceDependencies): Promise<Record<string, unknown>> {
  const now = dependencies.now ?? (() => performance.now());
  const requestStartedAtMs = dependencies.requestStartedAtMs ?? now();
  const userId = requireAuthenticatedTaskUserId(authenticatedUserId);
  const definition = getTaskDefinition(request.task);
  const isTokenHubMusicCandidate = request.task === "music.generate"
    && request.provider === "tencent_tokenhub"
    && definition.capability === "MUSIC_GENERATION";
  const isInternalTokenHubLiveValidation = dependencies.executionContext === "internal_live_validation"
    && isTokenHubMusicCandidate;
  const isInternalAsyncMusic = dependencies.executionContext === "internal_async_music"
    && isTokenHubMusicCandidate;
  const isInternalMusicExecution = isInternalTokenHubLiveValidation || isInternalAsyncMusic;
  if (
    (dependencies.executionContext === "internal_live_validation"
      || dependencies.executionContext === "internal_async_music")
    && !isTokenHubMusicCandidate
  ) {
    throw new SafeTaskError("PROVIDER_NOT_SUPPORTED_FOR_TASK", "Internal validation is not allowed for this task.", 501);
  }
  const providerPolicy = isTokenHubMusicCandidate
    ? (() => {
      const policy = getTaskProviderPolicy(request.provider);
      const state = policy.capabilities.MUSIC_GENERATION;
      if (state === "not_verified" && !isInternalTokenHubLiveValidation) {
        throw new SafeTaskError("PROVIDER_NOT_SUPPORTED_FOR_TASK", "Music generation is not enabled.", 501);
      }
      if (state !== "not_verified" && state !== "foundation_ready") {
        throw new SafeTaskError("PROVIDER_NOT_SUPPORTED_FOR_TASK", "Music generation is not enabled.", 501);
      }
      return policy;
    })()
    : requireCapability(request.provider, definition.capability);
  if (!isInternalMusicExecution) requireTaskExecutionSupport(request.provider, request.task);
  const budget = getTaskBudget(request.task);
  const credentialStartedAt = now();
  const saved = await dependencies.repository.getSavedCredential(userId, request.provider);
  if (!saved) throw new SafeTaskError("NOT_CONNECTED", "请先在“我的 AI 服务”中连接该服务。", 404);

  let apiKey = "";
  try {
    apiKey = await decryptCredential({ ciphertext: saved.ciphertext, iv: saved.iv, encryptionVersion: saved.encryptionVersion as 1 }, dependencies.encryptionKey);
  } catch {
    throw new SafeTaskError("INTERNAL_ERROR", "已保存凭证暂时无法读取。", 500);
  }
  const credentialLookupDecryptMs = now() - credentialStartedAt;

  try {
    if (isTokenHubMusicCandidate) {
      if (!dependencies.music || providerPolicy.model === null) {
        throw new SafeTaskError("INTERNAL_ERROR", "Music generation runtime is unavailable.", 500);
      }
      return await executeMusicGenerationRequest(
        userId,
        request,
        apiKey,
        providerPolicy.model,
        budget.timeoutMs,
        { credentialLookupDecryptMs, requestStartedAtMs },
        dependencies.music,
        { includeTrustedDiagnostics: isInternalTokenHubLiveValidation },
      );
    }
    const execution = await dispatchTaskByCapability({
      userId,
      task: request.task,
      provider: request.provider,
      capability: definition.capability,
      input: request.input,
      serverInstruction: definition.serverInstruction,
      serverControlledModel: providerPolicy.model,
      apiKey,
      providerResourceId: saved.providerResourceId ?? undefined,
      budget: {
        maxOutputTokens: budget.maxOutputTokens,
        timeoutMs: budget.timeoutMs,
        automaticProviderRetryCount: budget.automaticProviderRetryCount,
        maxProviderCalls: budget.maxProviderCalls,
      },
    }, { textReasoningExecutor: dependencies.executeTask });
    let safeData: Record<string, AITaskResultValue>;
    try {
      safeData = safeResultData(execution.data);
    } catch {
      throw new SafeTaskError(
        "INTERNAL_ERROR",
        "AI 任务结果无法安全返回。",
        500,
        {
          provider: request.provider,
          failureStage: "internal",
          failureClass: "SAFE_RESULT_SERIALIZATION_ERROR",
          providerCallCount: 1,
          providerResponseReceived: true,
          responseJsonParseable: true,
          canonicalValidationReached: true,
        },
      );
    }
    return {
      ok: true,
      task: request.task,
      provider: request.provider,
      result: { capability: definition.capability, data: safeData },
      usage: safeUsage(execution.usage),
      metadata: { providerUsed: request.provider, taskType: request.task, generationOccurred: execution.generationOccurred },
    };
  } finally {
    apiKey = "";
  }
}
