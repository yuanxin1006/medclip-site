import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SavedCredential } from "../_shared/ai-credentials/service.ts";
import { resolveSupabaseRuntimeKeys } from "../_shared/ai-credentials/runtime-keys.ts";
import { getTaskBudget, MAX_AI_TASK_REQUEST_BYTES } from "../_shared/ai-tasks/budget.ts";
import type { BYOKDatabase } from "../_shared/ai-tasks/database.ts";
import { SafeTaskError, safeTaskErrorResponse } from "../_shared/ai-tasks/errors.ts";
import {
  authorizeInternalTextTaskFixture,
  authorizeInternalLiveValidation,
  INTERNAL_LIVE_VALIDATION_HEADER,
} from "../_shared/ai-tasks/internal-live-validation.ts";
import {
  createPostgresMusicOperationRepository,
  type MusicOperationRPCClient,
} from "../_shared/ai-tasks/music-operation.ts";
import {
  INTERNAL_ASYNC_MUSIC_MOCK_HEADER,
  INTERNAL_ASYNC_MUSIC_WORKERS_HEADER,
  isAsyncMusicStartEnvelope,
  parseAsyncMusicStartRequest,
  parseTrustedAsyncMusicMockScenario,
  parseTrustedAsyncMusicWorkerCopies,
  runGuardedAsyncMusicBackground,
  startAsyncMusicGeneration,
} from "../_shared/ai-tasks/music-product-async.ts";
import {
  getOwnSafeMusicOperationStatus,
  isMusicOperationStatusEnvelope,
  parseMusicOperationStatusRequest,
} from "../_shared/ai-tasks/music-product-status.ts";
import {
  isMusicProductAvailabilityEnvelope,
  musicProductAvailability,
  parseMusicProductAvailabilityRequest,
  PROVIDER_FREE_MUSIC_DISPATCH_POLICY,
  resolveMusicProductExecutionMode,
  resolveMusicProductRelease,
} from "../_shared/ai-tasks/music-product-release.ts";
import { createAuthenticatedMusicFinalizationRepository } from "../_shared/ai-tasks/music-track-repository.ts";
import { executeTencentTokenHubMusic } from "../_shared/ai-tasks/providers/tencent-tokenhub-music.ts";
import { getTaskDefinition, getTaskProviderPolicy } from "../_shared/ai-tasks/registry.ts";
import { parseAITaskRequest, requireAuthenticatedTaskUserId } from "../_shared/ai-tasks/request.ts";
import { executeAITaskRequest, type TaskCredentialRepository } from "../_shared/ai-tasks/service.ts";
import { textTaskOperatorDiagnostic, type TextTaskDiagnosticContext } from "../_shared/ai-tasks/text-diagnostics.ts";
import {
  executeInternalTextTaskFixture,
  INTERNAL_TEXT_TASK_FIXTURE_HEADER,
  parseInternalTextTaskFixture,
} from "../_shared/ai-tasks/text-fixtures.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new SafeTaskError("INTERNAL_ERROR", "服务端配置不完整。", 500);
  return value;
}

function requestOrigin(req: Request): string | null {
  const origin = req.headers.get("Origin");
  if (!origin) return null;
  const allowedOrigins = (Deno.env.get("MEDCLIP_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowedOrigins.includes(origin)) {
    throw new SafeTaskError("ORIGIN_NOT_ALLOWED", "该来源不能调用 AI 任务服务。", 403);
  }
  return origin;
}

function responseHeaders(origin: string | null, requestId: string): HeadersInit {
  return {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-MedClip-Request-Id": requestId,
    Vary: "Origin",
  };
}

function jsonResponse(body: Record<string, unknown>, status: number, origin: string | null, requestId: string): Response {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin, requestId) });
}

async function authenticatedTaskContext(
  req: Request,
  supabaseURL: string,
  publishableKey: string,
): Promise<{ userId: string; userClient: SupabaseClient<BYOKDatabase> }> {
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    requireAuthenticatedTaskUserId(null);
    throw new SafeTaskError("UNAUTHENTICATED", "Authentication is required.", 401);
  }
  const authClient = createClient<BYOKDatabase>(supabaseURL, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data.user) {
    requireAuthenticatedTaskUserId(null);
    throw new SafeTaskError("UNAUTHENTICATED", "Authentication is required.", 401);
  }
  return {
    userId: requireAuthenticatedTaskUserId(data.user.id),
    userClient: authClient,
  };
}

function createCredentialRepository(serviceClient: SupabaseClient<BYOKDatabase>): TaskCredentialRepository {
  return {
    async getSavedCredential(userId, provider) {
      const { data, error } = await serviceClient
        .rpc("medclip_get_ai_provider_credential", {
          target_user_id: userId,
          target_provider: provider,
        })
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        provider: data.provider,
        providerResourceId: data.provider_resource_id,
        ciphertext: data.ciphertext,
        iv: data.iv,
        encryptionVersion: data.encryption_version,
      } as SavedCredential;
    },
  };
}

function createMusicOperationRepository(serviceClient: SupabaseClient<BYOKDatabase>) {
  const rpcClient: MusicOperationRPCClient = {
    async rpc(functionName, args) {
      const invoke = serviceClient.rpc.bind(serviceClient) as unknown as MusicOperationRPCClient["rpc"];
      return await invoke(functionName, args);
    },
  };
  return createPostgresMusicOperationRepository(rpcClient);
}

async function readRequest(req: Request): Promise<unknown> {
  const contentLength = Number(req.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_AI_TASK_REQUEST_BYTES) {
    throw new SafeTaskError("INVALID_INPUT", "AI 任务请求内容过大。", 413);
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_AI_TASK_REQUEST_BYTES) {
    throw new SafeTaskError("INVALID_INPUT", "AI 任务请求内容过大。", 413);
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new SafeTaskError("INVALID_INPUT", "AI 任务请求不是有效 JSON。", 400);
  }
}

Deno.serve(async (req: Request) => {
  const requestStartedAtMs = performance.now();
  const requestId = crypto.randomUUID();
  let origin: string | null = null;
  let internalLiveValidation = false;
  let internalTextFixture = false;
  let textDiagnosticContext: TextTaskDiagnosticContext | null = null;
  try {
    origin = requestOrigin(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(origin, requestId) });
    if (req.method !== "POST") throw new SafeTaskError("METHOD_NOT_ALLOWED", "不支持的请求方法。", 405);

    const supabaseURL = requiredEnvironment("SUPABASE_URL");
    const { publishableKey, secretKey } = resolveSupabaseRuntimeKeys((name) => Deno.env.get(name));
    const { userId, userClient } = await authenticatedTaskContext(req, supabaseURL, publishableKey);
    const rawRequest = await readRequest(req);
    const musicProductRelease = resolveMusicProductRelease(
      userId,
      (name) => Deno.env.get(name),
    );
    if (isMusicProductAvailabilityEnvelope(rawRequest)) {
      parseMusicProductAvailabilityRequest(rawRequest);
      return jsonResponse({
        ok: true,
        musicGeneration: musicProductAvailability(musicProductRelease),
      }, 200, origin, requestId);
    }
    const serviceClient = createClient<BYOKDatabase>(supabaseURL, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const musicOperations = createMusicOperationRepository(serviceClient);
    if (isAsyncMusicStartEnvelope(rawRequest)) {
      const startRequest = parseAsyncMusicStartRequest(rawRequest);
      internalLiveValidation = await authorizeInternalLiveValidation({
        proof: req.headers.get(INTERNAL_LIVE_VALIDATION_HEADER),
        secret: Deno.env.get("MEDCLIP_INTERNAL_LIVE_VALIDATION_SECRET"),
        userId,
        request: startRequest.request,
      });
      const mockScenarioHeader = req.headers.get(INTERNAL_ASYNC_MUSIC_MOCK_HEADER);
      const mockWorkersHeader = req.headers.get(INTERNAL_ASYNC_MUSIC_WORKERS_HEADER);
      if (!internalLiveValidation && (mockScenarioHeader !== null || mockWorkersHeader !== null)) {
        throw new SafeTaskError("UNAUTHENTICATED", "Internal async validation authorization is invalid.", 401);
      }
      const executionMode = resolveMusicProductExecutionMode(
        musicProductRelease,
        internalLiveValidation,
      );
      if (executionMode === null) {
        throw new SafeTaskError(
          "MUSIC_PUBLIC_RELEASE_DISABLED",
          "歌曲生成限量测试尚未开放。",
          403,
          { provider: "tencent_tokenhub", providerCallCount: 0 },
        );
      }
      const dispatchPolicy = internalLiveValidation
        ? PROVIDER_FREE_MUSIC_DISPATCH_POLICY
        : musicProductRelease.dispatchPolicy ?? PROVIDER_FREE_MUSIC_DISPATCH_POLICY;
      const providerPolicy = getTaskProviderPolicy("tencent_tokenhub");
      const serverControlledModel = providerPolicy.model;
      if (!serverControlledModel) throw new SafeTaskError("INTERNAL_ERROR", "Music generation runtime is unavailable.", 500);
      const budget = getTaskBudget("music.generate");
      const tracks = createAuthenticatedMusicFinalizationRepository(userClient);
      const credentialRepository = createCredentialRepository(serviceClient);
      const encryptionKey = requiredEnvironment("MEDCLIP_CREDENTIAL_ENCRYPTION_KEY");
      const mockScenario = internalLiveValidation
        ? parseTrustedAsyncMusicMockScenario(mockScenarioHeader)
        : musicProductRelease.mockScenario;
      const workerCopies = internalLiveValidation
        ? parseTrustedAsyncMusicWorkerCopies(mockWorkersHeader)
        : 1;
      const accepted = await startAsyncMusicGeneration(userId, startRequest, {
        operations: musicOperations,
        executionMode,
        dispatchPolicy,
        workerCopies,
        schedule: (promise) => EdgeRuntime.waitUntil(promise),
        runBackground: (request, operation) => runGuardedAsyncMusicBackground(
          request,
          operation,
          {
            operations: musicOperations,
            tracks,
            credentialRepository,
            encryptionKey,
            executeMusic: executeTencentTokenHubMusic,
            serverControlledModel,
            timeoutMs: budget.timeoutMs,
            executionMode,
            dispatchPolicy,
            mockScenario,
            mockStepDelayMs: internalLiveValidation
              ? undefined
              : musicProductRelease.mockStepDelayMs,
          },
        ),
      });
      return jsonResponse({ ok: true, ...accepted }, 202, origin, requestId);
    }
    if (isMusicOperationStatusEnvelope(rawRequest)) {
      const statusRequest = parseMusicOperationStatusRequest(rawRequest);
      const operation = await getOwnSafeMusicOperationStatus(userId, statusRequest, musicOperations);
      return jsonResponse({ ok: true, operation }, 200, origin, requestId);
    }
    const request = parseAITaskRequest(rawRequest);
    const definition = getTaskDefinition(request.task);
    if (definition.capability === "TEXT_REASONING") {
      textDiagnosticContext = {
        requestId,
        task: request.task,
        provider: request.provider,
        model: getTaskProviderPolicy(request.provider).model,
        requestStartedAtMs,
      };
    }
    const textFixture = parseInternalTextTaskFixture(req.headers.get(INTERNAL_TEXT_TASK_FIXTURE_HEADER));
    if (textFixture) {
      internalTextFixture = await authorizeInternalTextTaskFixture({
        proof: req.headers.get(INTERNAL_LIVE_VALIDATION_HEADER),
        secret: Deno.env.get("MEDCLIP_INTERNAL_LIVE_VALIDATION_SECRET"),
        userId,
        request,
      });
      if (!internalTextFixture) {
        throw new SafeTaskError("UNAUTHENTICATED", "Internal validation authorization is invalid.", 401);
      }
      const body = await executeInternalTextTaskFixture(userId, request, textFixture);
      return jsonResponse(body, 200, origin, requestId);
    }
    internalLiveValidation = await authorizeInternalLiveValidation({
      proof: req.headers.get(INTERNAL_LIVE_VALIDATION_HEADER),
      secret: Deno.env.get("MEDCLIP_INTERNAL_LIVE_VALIDATION_SECRET"),
      userId,
      request,
    });
    const encryptionKey = requiredEnvironment("MEDCLIP_CREDENTIAL_ENCRYPTION_KEY");
    const body = await executeAITaskRequest(userId, request, {
      repository: createCredentialRepository(serviceClient),
      encryptionKey,
      requestStartedAtMs,
      executionContext: internalLiveValidation ? "internal_live_validation" : "normal",
      music: {
        operations: musicOperations,
        // The verified user client preserves Storage object ownership; the
        // service client remains limited to credentials and private ledger RPCs.
        tracks: createAuthenticatedMusicFinalizationRepository(userClient),
        executeMusic: executeTencentTokenHubMusic,
        dispatchPolicy: musicProductRelease.dispatchPolicy ?? PROVIDER_FREE_MUSIC_DISPATCH_POLICY,
      },
    });
    return jsonResponse(body, 200, origin, requestId);
  } catch (error) {
    const operatorDiagnostic = textDiagnosticContext
      && error instanceof SafeTaskError
      && error.diagnostic?.failureClass
      ? textTaskOperatorDiagnostic(error, textDiagnosticContext)
      : null;
    if (operatorDiagnostic) console.error(JSON.stringify(operatorDiagnostic));
    const safe = safeTaskErrorResponse(error, {
      includeTrustedInternalDiagnostics: internalLiveValidation,
    });
    const body = internalTextFixture && operatorDiagnostic
      ? {
        ...safe.body,
        metadata: { trustedInternalDiagnostics: operatorDiagnostic },
      }
      : safe.body;
    return jsonResponse(body, safe.status, origin, requestId);
  }
});
