import type { MusicGenerationInput } from "./types.ts";
import type { MusicDispatchPolicy } from "./music-product-release.ts";
import {
  parseMusicProviderFailureDiagnostics,
  serializeMusicProviderFailureDiagnostics,
  type MusicProviderFailureDiagnostics,
} from "./music-failure-diagnostics.ts";

export const MUSIC_GENERATION_TASK = "music.generate" as const;
export const MUSIC_GENERATION_PROVIDER = "tencent_tokenhub" as const;

export const MUSIC_OPERATION_STATES = [
  "RESERVED",
  "PROVIDER_IN_FLIGHT",
  "FINALIZING",
  "COMPLETED",
  "FAILED",
  "UNKNOWN",
] as const;

export type MusicOperationState = typeof MUSIC_OPERATION_STATES[number];

export type MusicGenerationOperation = {
  id: string;
  userId: string;
  operationId: string;
  task: typeof MUSIC_GENERATION_TASK;
  provider: typeof MUSIC_GENERATION_PROVIDER;
  requestHash: string;
  state: MusicOperationState;
  providerCallCount: 0 | 1;
  providerRequestId: string | null;
  providerTraceId: string | null;
  finalTrackId: string | null;
  failureCode: string | null;
  failureDiagnostics: MusicProviderFailureDiagnostics | null;
  providerDispatchedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReserveMusicOperationInput = {
  userId: string;
  operationId: string;
  task: typeof MUSIC_GENERATION_TASK;
  provider: typeof MUSIC_GENERATION_PROVIDER;
  requestHash: string;
};

export type MusicOperationTransitionInput = {
  userId: string;
  operationId: string;
  expectedState: "RESERVED" | "PROVIDER_IN_FLIGHT" | "FINALIZING";
  nextState: Exclude<MusicOperationState, "RESERVED">;
  providerCallCount: 0 | 1;
  providerRequestId?: string | null;
  providerTraceId?: string | null;
  finalTrackId?: string | null;
  failureCode?: string | null;
  failureDiagnostics?: MusicProviderFailureDiagnostics | null;
};

export type MusicOperationRepository = {
  reserve(input: ReserveMusicOperationInput): Promise<{
    operation: MusicGenerationOperation;
    created: boolean;
  }>;
  load(userId: string, operationId: string): Promise<MusicGenerationOperation | null>;
  reserveGuarded?(
    input: ReserveMusicOperationInput,
    policy: MusicDispatchPolicy,
  ): Promise<{ operation: MusicGenerationOperation; created: boolean }>;
  authorizeProviderDispatch?(
    operation: MusicGenerationOperation,
    policy: MusicDispatchPolicy,
  ): Promise<MusicGenerationOperation>;
  transition(input: MusicOperationTransitionInput): Promise<MusicGenerationOperation>;
};

export type MusicOperationRPCClient = {
  rpc(
    functionName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<{ data: unknown; error: unknown }>;
};

export class MusicOperationError extends Error {
  readonly code:
    | "INVALID_OPERATION"
    | "OPERATION_CONFLICT"
    | "OPERATION_TRANSITION_CONFLICT"
    | "MUSIC_DAILY_LIMIT_REACHED"
    | "MUSIC_GLOBAL_LIMIT_REACHED"
    | "MUSIC_GENERATION_ALREADY_ACTIVE"
    | "OPERATION_REPOSITORY_ERROR";

  constructor(code: MusicOperationError["code"], message: string) {
    super(message);
    this.name = "MusicOperationError";
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const REQUEST_HASH_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_PROVIDER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function operationError(code: MusicOperationError["code"], message: string): never {
  throw new MusicOperationError(code, message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertUserId(value: string): string {
  if (!UUID_PATTERN.test(value)) operationError("INVALID_OPERATION", "Authenticated user ID is invalid.");
  return value.toLowerCase();
}

function assertOperationId(value: string): string {
  if (!OPERATION_ID_PATTERN.test(value)) operationError("INVALID_OPERATION", "Operation ID is invalid.");
  return value;
}

function assertTrackId(value: string): string {
  if (!UUID_PATTERN.test(value)) operationError("INVALID_OPERATION", "Track ID is invalid.");
  return value.toLowerCase();
}

function assertFailureCode(value: string): string {
  if (!SAFE_FAILURE_CODE.test(value)) operationError("INVALID_OPERATION", "Failure code is invalid.");
  return value;
}

function normalizeBusinessText(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

export function canonicalMusicGenerationRequest(
  provider: typeof MUSIC_GENERATION_PROVIDER,
  input: MusicGenerationInput,
): string {
  return JSON.stringify({
    task: MUSIC_GENERATION_TASK,
    provider,
    mode: input.mode,
    lyrics: input.mode === "custom_lyrics" ? normalizeBusinessText(input.lyrics) : null,
    prompt: normalizeBusinessText(input.prompt),
    title: normalizeBusinessText(input.title),
  });
}

export async function hashMusicGenerationRequest(
  provider: typeof MUSIC_GENERATION_PROVIDER,
  input: MusicGenerationInput,
): Promise<string> {
  const canonical = canonicalMusicGenerationRequest(provider, input);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseOperation(value: unknown): MusicGenerationOperation {
  if (!plainRecord(value)) operationError("OPERATION_REPOSITORY_ERROR", "Operation repository returned invalid data.");
  const state = value.state;
  if (!(MUSIC_OPERATION_STATES as readonly unknown[]).includes(state)) {
    operationError("OPERATION_REPOSITORY_ERROR", "Operation state is invalid.");
  }
  if (
    typeof value.id !== "string"
    || typeof value.user_id !== "string"
    || typeof value.operation_id !== "string"
    || value.task !== MUSIC_GENERATION_TASK
    || value.provider !== MUSIC_GENERATION_PROVIDER
    || typeof value.request_hash !== "string"
    || !REQUEST_HASH_PATTERN.test(value.request_hash)
    || (value.provider_call_count !== 0 && value.provider_call_count !== 1)
    || typeof value.created_at !== "string"
    || typeof value.updated_at !== "string"
  ) {
    operationError("OPERATION_REPOSITORY_ERROR", "Operation repository returned invalid data.");
  }
  const optionalString = (field: unknown): string | null => field === null ? null : typeof field === "string" ? field : operationError("OPERATION_REPOSITORY_ERROR", "Operation metadata is invalid.");
  let failureDiagnostics: MusicProviderFailureDiagnostics | null;
  try {
    failureDiagnostics = parseMusicProviderFailureDiagnostics(value.failure_diagnostics);
  } catch {
    operationError("OPERATION_REPOSITORY_ERROR", "Operation diagnostics are invalid.");
  }
  return {
    id: value.id,
    userId: assertUserId(value.user_id),
    operationId: assertOperationId(value.operation_id),
    task: MUSIC_GENERATION_TASK,
    provider: MUSIC_GENERATION_PROVIDER,
    requestHash: value.request_hash,
    state: state as MusicOperationState,
    providerCallCount: value.provider_call_count,
    providerRequestId: optionalString(value.provider_request_id),
    providerTraceId: optionalString(value.provider_trace_id),
    finalTrackId: optionalString(value.final_track_id),
    failureCode: optionalString(value.failure_code),
    failureDiagnostics,
    providerDispatchedAt: optionalString(value.provider_dispatched_at),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function repositoryFailure(error: unknown): never {
  const message = plainRecord(error) && typeof error.message === "string"
    ? error.message
    : "";
  if (message.includes("OPERATION_CONFLICT")) {
    operationError("OPERATION_CONFLICT", "The operation ID is already bound to different input.");
  }
  if (message.includes("OPERATION_TRANSITION_CONFLICT")) {
    operationError("OPERATION_TRANSITION_CONFLICT", "The operation state changed before this transition.");
  }
  if (message.includes("MUSIC_DAILY_LIMIT_REACHED")) {
    operationError("MUSIC_DAILY_LIMIT_REACHED", "The daily music generation limit has been reached.");
  }
  if (message.includes("MUSIC_GLOBAL_LIMIT_REACHED")) {
    operationError("MUSIC_GLOBAL_LIMIT_REACHED", "The global music generation limit has been reached.");
  }
  if (message.includes("MUSIC_GENERATION_ALREADY_ACTIVE")) {
    operationError("MUSIC_GENERATION_ALREADY_ACTIVE", "A music generation operation is already active.");
  }
  operationError("OPERATION_REPOSITORY_ERROR", "The durable operation repository is unavailable.");
}

export function createPostgresMusicOperationRepository(
  client: MusicOperationRPCClient,
): MusicOperationRepository {
  return {
    async reserve(input) {
      const { data, error } = await client.rpc("medclip_reserve_music_generation_operation", {
        target_user_id: input.userId,
        target_operation_id: input.operationId,
        target_task: input.task,
        target_provider: input.provider,
        target_request_hash: input.requestHash,
      });
      if (error) repositoryFailure(error);
      if (!plainRecord(data) || typeof data.created !== "boolean") {
        operationError("OPERATION_REPOSITORY_ERROR", "Operation reservation returned invalid data.");
      }
      return { operation: parseOperation(data), created: data.created };
    },
    async load(userId, operationId) {
      const { data, error } = await client.rpc("medclip_get_music_generation_operation", {
        target_user_id: userId,
        target_operation_id: operationId,
      });
      if (error) repositoryFailure(error);
      return data === null ? null : parseOperation(data);
    },
    async reserveGuarded(input, policy) {
      const { data, error } = await client.rpc("medclip_reserve_music_generation_operation_guarded", {
        target_user_id: input.userId,
        target_operation_id: input.operationId,
        target_task: input.task,
        target_provider: input.provider,
        target_request_hash: input.requestHash,
        target_counts_paid_dispatch: policy.countsPaidDispatch,
        target_enforce_user_daily_limit: policy.enforceUserDailyLimit,
        target_user_daily_limit: policy.userDailyLimit,
        target_global_daily_limit: policy.globalDailyLimit,
      });
      if (error) repositoryFailure(error);
      if (!plainRecord(data) || typeof data.created !== "boolean") {
        operationError("OPERATION_REPOSITORY_ERROR", "Guarded operation reservation returned invalid data.");
      }
      return { operation: parseOperation(data), created: data.created };
    },
    async authorizeProviderDispatch(operation, policy) {
      const { data, error } = await client.rpc("medclip_authorize_music_provider_dispatch", {
        target_user_id: operation.userId,
        target_operation_id: operation.operationId,
        target_counts_paid_dispatch: policy.countsPaidDispatch,
        target_enforce_user_daily_limit: policy.enforceUserDailyLimit,
        target_user_daily_limit: policy.userDailyLimit,
        target_global_daily_limit: policy.globalDailyLimit,
      });
      if (error) repositoryFailure(error);
      return parseOperation(data);
    },
    async transition(input) {
      const { data, error } = await client.rpc("medclip_transition_music_generation_operation", {
        target_user_id: input.userId,
        target_operation_id: input.operationId,
        expected_state: input.expectedState,
        next_state: input.nextState,
        next_provider_call_count: input.providerCallCount,
        next_provider_request_id: input.providerRequestId ?? null,
        next_provider_trace_id: input.providerTraceId ?? null,
        next_final_track_id: input.finalTrackId ?? null,
        next_failure_code: input.failureCode ?? null,
        next_failure_diagnostics: input.failureDiagnostics
          ? serializeMusicProviderFailureDiagnostics(input.failureDiagnostics)
          : null,
      });
      if (error) repositoryFailure(error);
      return parseOperation(data);
    },
  };
}

export async function reserveMusicGenerationOperation(
  authenticatedUserId: string,
  input: MusicGenerationInput,
  repository: MusicOperationRepository,
  policy?: MusicDispatchPolicy,
): Promise<{ operation: MusicGenerationOperation; reused: boolean }> {
  const userId = assertUserId(authenticatedUserId);
  const operationId = assertOperationId(input.operationId);
  const requestHash = await hashMusicGenerationRequest(MUSIC_GENERATION_PROVIDER, input);
  const reserveInput = {
    userId,
    operationId,
    task: MUSIC_GENERATION_TASK,
    provider: MUSIC_GENERATION_PROVIDER,
    requestHash,
  };
  if (policy && !repository.reserveGuarded) {
    operationError("OPERATION_REPOSITORY_ERROR", "Guarded operation reservation is unavailable.");
  }
  const reserved = policy
    ? await repository.reserveGuarded!(reserveInput, policy)
    : await repository.reserve(reserveInput);
  if (
    reserved.operation.userId !== userId
    || reserved.operation.operationId !== operationId
    || reserved.operation.requestHash !== requestHash
  ) {
    operationError("OPERATION_CONFLICT", "The operation ID is already bound to different input.");
  }
  return { operation: reserved.operation, reused: !reserved.created };
}

export async function assertMusicOperationRequestBinding(
  authenticatedUserId: string,
  input: MusicGenerationInput,
  operation: MusicGenerationOperation,
): Promise<void> {
  const userId = assertUserId(authenticatedUserId);
  const operationId = assertOperationId(input.operationId);
  const requestHash = await hashMusicGenerationRequest(MUSIC_GENERATION_PROVIDER, input);
  if (
    operation.userId !== userId
    || operation.operationId !== operationId
    || operation.provider !== MUSIC_GENERATION_PROVIDER
    || operation.task !== MUSIC_GENERATION_TASK
    || operation.requestHash !== requestHash
  ) {
    operationError("OPERATION_CONFLICT", "The operation is not bound to this authenticated request.");
  }
}

export function canIssueMusicProviderCall(operation: MusicGenerationOperation): boolean {
  return operation.state === "RESERVED" && operation.providerCallCount === 0;
}

function transitionFrom(
  repository: MusicOperationRepository,
  operation: MusicGenerationOperation,
  next: Omit<MusicOperationTransitionInput, "userId" | "operationId" | "expectedState">,
): Promise<MusicGenerationOperation> {
  if (operation.state !== "RESERVED" && operation.state !== "PROVIDER_IN_FLIGHT" && operation.state !== "FINALIZING") {
    operationError("OPERATION_TRANSITION_CONFLICT", "Terminal operations cannot transition or regenerate.");
  }
  return repository.transition({
    userId: operation.userId,
    operationId: operation.operationId,
    expectedState: operation.state,
    ...next,
  });
}

export function markMusicProviderInFlight(
  repository: MusicOperationRepository,
  operation: MusicGenerationOperation,
  policy?: MusicDispatchPolicy,
): Promise<MusicGenerationOperation> {
  if (!canIssueMusicProviderCall(operation)) {
    operationError("OPERATION_TRANSITION_CONFLICT", "A paid provider call cannot be issued for this operation.");
  }
  if (policy && repository.authorizeProviderDispatch) {
    return repository.authorizeProviderDispatch(operation, policy);
  }
  if (policy) {
    operationError("OPERATION_REPOSITORY_ERROR", "Atomic provider dispatch authorization is unavailable.");
  }
  return transitionFrom(repository, operation, {
    nextState: "PROVIDER_IN_FLIGHT",
    providerCallCount: 1,
  });
}

function safeProviderIdentifier(value: string | undefined): string | null {
  if (value === undefined) return null;
  return SAFE_PROVIDER_IDENTIFIER.test(value) ? value : null;
}

export function markMusicOperationFinalizing(
  repository: MusicOperationRepository,
  operation: MusicGenerationOperation,
  identifiers: { requestId?: string; traceId?: string } = {},
): Promise<MusicGenerationOperation> {
  if (operation.state !== "PROVIDER_IN_FLIGHT" || operation.providerCallCount !== 1) {
    operationError("OPERATION_TRANSITION_CONFLICT", "Only an in-flight provider operation can begin finalization.");
  }
  return transitionFrom(repository, operation, {
    nextState: "FINALIZING",
    providerCallCount: 1,
    providerRequestId: safeProviderIdentifier(identifiers.requestId),
    providerTraceId: safeProviderIdentifier(identifiers.traceId),
  });
}

export function markMusicOperationCompleted(
  repository: MusicOperationRepository,
  operation: MusicGenerationOperation,
  trackId: string,
): Promise<MusicGenerationOperation> {
  if (operation.state !== "FINALIZING" || operation.providerCallCount !== 1) {
    operationError("OPERATION_TRANSITION_CONFLICT", "Only a finalized durable track can complete an operation.");
  }
  return transitionFrom(repository, operation, {
    nextState: "COMPLETED",
    providerCallCount: 1,
    finalTrackId: assertTrackId(trackId),
  });
}

export function markMusicOperationFailed(
  repository: MusicOperationRepository,
  operation: MusicGenerationOperation,
  failureCode: string,
  failureDiagnostics: MusicProviderFailureDiagnostics | null = null,
): Promise<MusicGenerationOperation> {
  return transitionFrom(repository, operation, {
    nextState: "FAILED",
    providerCallCount: operation.providerCallCount,
    providerRequestId: safeProviderIdentifier(failureDiagnostics?.providerRequestId),
    providerTraceId: safeProviderIdentifier(failureDiagnostics?.providerTraceId),
    failureCode: assertFailureCode(failureCode),
    failureDiagnostics,
  });
}

export function markMusicOperationUnknown(
  repository: MusicOperationRepository,
  operation: MusicGenerationOperation,
  failureCode: string,
  failureDiagnostics: MusicProviderFailureDiagnostics | null = null,
): Promise<MusicGenerationOperation> {
  if (
    (operation.state !== "PROVIDER_IN_FLIGHT" && operation.state !== "FINALIZING")
    || operation.providerCallCount !== 1
  ) {
    operationError("OPERATION_TRANSITION_CONFLICT", "Only a possibly-paid operation may become UNKNOWN.");
  }
  return transitionFrom(repository, operation, {
    nextState: "UNKNOWN",
    providerCallCount: 1,
    providerRequestId: safeProviderIdentifier(failureDiagnostics?.providerRequestId),
    providerTraceId: safeProviderIdentifier(failureDiagnostics?.providerTraceId),
    failureCode: assertFailureCode(failureCode),
    failureDiagnostics,
  });
}
