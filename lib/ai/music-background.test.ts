import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SafeTaskError } from "../../supabase/functions/_shared/ai-tasks/errors.ts";
import type { MusicFinalizationRepository } from "../../supabase/functions/_shared/ai-tasks/music-finalization.ts";
import {
  MusicOperationError,
  reserveMusicGenerationOperation,
  type MusicGenerationOperation,
  type MusicOperationRepository,
  type MusicOperationTransitionInput,
  type ReserveMusicOperationInput,
} from "../../supabase/functions/_shared/ai-tasks/music-operation.ts";
import {
  ASYNC_MUSIC_MOCK_SCENARIOS,
  isAsyncMusicStartEnvelope,
  parseAsyncMusicStartRequest,
  runGuardedAsyncMusicBackground,
  startAsyncMusicGeneration,
} from "../../supabase/functions/_shared/ai-tasks/music-product-async.ts";
import { getOwnSafeMusicOperationStatus } from "../../supabase/functions/_shared/ai-tasks/music-product-status.ts";
import {
  DEFAULT_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT,
  DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT,
  parseMusicProductAvailabilityRequest,
  resolveMusicProductRelease,
  TESTER_MOCK_STEP_DELAY_MS,
} from "../../supabase/functions/_shared/ai-tasks/music-product-release.ts";
import { executeMusicGenerationRequest } from "../../supabase/functions/_shared/ai-tasks/music-service.ts";
import type { MusicGenerationExecutor, ParsedAITaskRequest } from "../../supabase/functions/_shared/ai-tasks/types.ts";
import { assertAsyncRegressionRequestIsProviderFree } from "../../scripts/async-music-regression-safety.ts";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const MODEL = "minimax-music-v2.6";

function operationKey(userId: string, operationId: string): string {
  return `${userId}:${operationId}`;
}

class MemoryOperationRepository implements MusicOperationRepository {
  readonly operations = new Map<string, MusicGenerationOperation>();

  async reserve(input: ReserveMusicOperationInput) {
    const key = operationKey(input.userId, input.operationId);
    const existing = this.operations.get(key);
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new MusicOperationError("OPERATION_CONFLICT", "conflict");
      }
      return { operation: existing, created: false };
    }
    const timestamp = new Date().toISOString();
    const operation: MusicGenerationOperation = {
      id: randomUUID(),
      userId: input.userId,
      operationId: input.operationId,
      task: "music.generate",
      provider: "tencent_tokenhub",
      requestHash: input.requestHash,
      state: "RESERVED",
      providerCallCount: 0,
      providerRequestId: null,
      providerTraceId: null,
      finalTrackId: null,
      failureCode: null,
      failureDiagnostics: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.operations.set(key, operation);
    return { operation, created: true };
  }

  async load(userId: string, operationId: string) {
    return this.operations.get(operationKey(userId, operationId)) ?? null;
  }

  async transition(input: MusicOperationTransitionInput) {
    const key = operationKey(input.userId, input.operationId);
    const current = this.operations.get(key);
    if (!current || current.state !== input.expectedState) {
      throw new MusicOperationError("OPERATION_TRANSITION_CONFLICT", "transition conflict");
    }
    const next: MusicGenerationOperation = {
      ...current,
      state: input.nextState,
      providerCallCount: input.providerCallCount,
      providerRequestId: input.providerRequestId ?? current.providerRequestId,
      providerTraceId: input.providerTraceId ?? current.providerTraceId,
      finalTrackId: input.finalTrackId ?? null,
      failureCode: input.failureCode ?? null,
      failureDiagnostics: input.failureDiagnostics ?? null,
      updatedAt: new Date().toISOString(),
    };
    this.operations.set(key, next);
    return next;
  }
}

class MemoryTrackRepository implements MusicFinalizationRepository {
  readonly tracks = new Map<string, { userId: string; published: false; audioPath: string | null }>();
  readonly objects = new Map<string, Uint8Array>();

  async createDraft(input: { userId: string }) {
    const id = randomUUID();
    this.tracks.set(id, { userId: input.userId, published: false, audioPath: null });
    return { id, userId: input.userId, published: false as const };
  }

  async uploadAudio(input: { path: string; bytes: Uint8Array }) {
    this.objects.set(input.path, input.bytes);
  }

  async finalizeDraft(input: { trackId: string; userId: string; audioPath: string; published: false }) {
    const track = this.tracks.get(input.trackId);
    if (!track || track.userId !== input.userId || input.published !== false) throw new Error("owner mismatch");
    track.audioPath = input.audioPath;
  }

  async deleteAudio(_bucket: "music-audio", path: string) {
    this.objects.delete(path);
  }

  async deleteDraft(userId: string, trackId: string) {
    if (this.tracks.get(trackId)?.userId === userId) this.tracks.delete(trackId);
  }
}

function request(operationId = randomUUID(), title = "C2B provider-free fixture"): ParsedAITaskRequest {
  return parseAsyncMusicStartRequest({
    action: "music.generation_start",
    input: {
      operationId,
      mode: "custom_lyrics",
      title,
      lyrics: "[Verse]\n本地异步验证",
      prompt: "仅使用合成测试音频",
    },
  }).request;
}

function mockBackgroundDependencies(
  operations: MemoryOperationRepository,
  tracks: MemoryTrackRepository,
  scenario: typeof ASYNC_MUSIC_MOCK_SCENARIOS[number] = "success",
) {
  return {
    operations,
    tracks,
    credentialRepository: { async getSavedCredential() { return null; } },
    encryptionKey: "not-used-by-provider-free-mock",
    executeMusic: (async () => { throw new Error("real executor must not run"); }) as MusicGenerationExecutor,
    serverControlledModel: MODEL,
    timeoutMs: 120_000,
    executionMode: "trusted_mock" as const,
    mockScenario: scenario,
    mockStepDelayMs: 0,
    sleep: async () => undefined,
  };
}

test("C2B async start contract accepts product input and rejects browser control fields", () => {
  const operationId = randomUUID();
  assert.equal(isAsyncMusicStartEnvelope({ action: "music.generation_start", input: {} }), true);
  assert.equal(parseAsyncMusicStartRequest({
    action: "music.generation_start",
    input: { operationId, mode: "instrumental", prompt: "轻柔钢琴" },
  }).request.provider, "tencent_tokenhub");
  for (const field of [
    "provider", "model", "endpoint", "baseURL", "timeout", "output_format", "audioUrl",
    "storagePath", "trackId", "user_id", "owner_id", "retry", "fallback", "trusted",
    "internal", "live", "mock", "tester", "providerMode", "diagnostics", "background", "responseSchema",
  ]) {
    assert.throws(() => parseAsyncMusicStartRequest({
      action: "music.generation_start",
      input: { operationId, mode: "instrumental", prompt: "轻柔钢琴", [field]: "attacker" },
    }), SafeTaskError, field);
  }
  assert.throws(() => parseAsyncMusicStartRequest({
    action: "music.generation_start",
    input: { operationId, mode: "instrumental", prompt: "轻柔钢琴" },
    provider: "tencent_tokenhub",
  }), SafeTaskError);
});

test("C2C1 tester mock release gate is server-only, owner allowlisted and fail-closed", () => {
  const environment = new Map<string, string>([
    ["MEDCLIP_MUSIC_TEST_RELEASE_MODE", "TESTER_MOCK"],
    ["MEDCLIP_MUSIC_TESTER_USER_IDS", USER_A],
    ["MEDCLIP_MUSIC_TEST_SCENARIO", "success"],
  ]);
  const readEnvironment = (name: string) => environment.get(name);
  assert.deepEqual(resolveMusicProductRelease(USER_A, readEnvironment), {
    enabled: true,
    executionMode: "trusted_mock",
    testerMockEnabled: true,
    testerLiveEnabled: false,
    publicAuthenticatedBetaEnabled: false,
    mockScenario: "success",
    mockStepDelayMs: TESTER_MOCK_STEP_DELAY_MS,
    dispatchPolicy: {
      countsPaidDispatch: false,
      enforceUserDailyLimit: false,
      userDailyLimit: DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT,
      globalDailyLimit: DEFAULT_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT,
      quotaWindow: "UTC_CALENDAR_DAY",
    },
  });
  assert.equal(TESTER_MOCK_STEP_DELAY_MS, 4_500);
  assert.deepEqual(resolveMusicProductRelease(USER_B, readEnvironment), {
    enabled: false,
    executionMode: null,
    testerMockEnabled: false,
    testerLiveEnabled: false,
    publicAuthenticatedBetaEnabled: false,
  });
  environment.set("MEDCLIP_MUSIC_TEST_RELEASE_MODE", "TESTER_LIVE");
  assert.deepEqual(resolveMusicProductRelease(USER_A, readEnvironment), {
    enabled: true,
    executionMode: "tester_live",
    testerMockEnabled: false,
    testerLiveEnabled: true,
    publicAuthenticatedBetaEnabled: false,
    dispatchPolicy: {
      countsPaidDispatch: true,
      enforceUserDailyLimit: false,
      userDailyLimit: DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT,
      globalDailyLimit: DEFAULT_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT,
      quotaWindow: "UTC_CALENDAR_DAY",
    },
  });
  assert.deepEqual(resolveMusicProductRelease(USER_B, readEnvironment), {
    enabled: false,
    executionMode: null,
    testerMockEnabled: false,
    testerLiveEnabled: false,
    publicAuthenticatedBetaEnabled: false,
  });
  environment.set("MEDCLIP_MUSIC_TEST_RELEASE_MODE", "OFF");
  assert.deepEqual(resolveMusicProductRelease(USER_A, readEnvironment), {
    enabled: false,
    executionMode: null,
    testerMockEnabled: false,
    testerLiveEnabled: false,
    publicAuthenticatedBetaEnabled: false,
  });
  environment.set("MEDCLIP_MUSIC_TEST_RELEASE_MODE", "PUBLIC");
  assert.throws(() => resolveMusicProductRelease(USER_A, readEnvironment), SafeTaskError);
  assert.deepEqual(
    parseMusicProductAvailabilityRequest({ action: "music.generation_availability" }),
    { action: "music.generation_availability" },
  );
  for (const field of ["mock", "trusted", "internal", "live", "scenario", "userId"]) {
    assert.throws(() => parseMusicProductAvailabilityRequest({
      action: "music.generation_availability",
      [field]: true,
    }), SafeTaskError);
  }
});

test("anonymous async start is rejected and the OFF release gate remains explicit", async () => {
  const operations = new MemoryOperationRepository();
  const parsed = { action: "music.generation_start" as const, request: request() };
  await assert.rejects(
    startAsyncMusicGeneration("anonymous", parsed, {
      operations,
      executionMode: "trusted_mock",
      schedule: () => undefined,
      runBackground: async () => undefined,
    }),
    (error: unknown) => error instanceof SafeTaskError && error.code === "UNAUTHENTICATED",
  );
  const edgeSource = readFileSync(
    new URL("../../supabase/functions/ai-tasks/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(edgeSource, /MUSIC_PUBLIC_RELEASE_DISABLED/);
  assert.match(edgeSource, /resolveMusicProductExecutionMode/);
  assert.match(edgeSource, /executionMode === null/);
  assert.equal(operations.operations.size, 0);
});

test("legacy async verifier fails locally before an unsafe public-real request", () => {
  let submitted = false;
  const submit = (options: Parameters<typeof assertAsyncRegressionRequestIsProviderFree>[0]) => {
    assertAsyncRegressionRequestIsProviderFree(options);
    submitted = true;
  };

  assert.throws(
    () => submit({ publicReleaseEnabled: true }),
    /UNSAFE_PUBLIC_REAL_REGRESSION_REQUEST/,
  );
  assert.equal(submitted, false);

  submit({ publicReleaseEnabled: false });
  assert.equal(submitted, true);
  submitted = false;

  submit({ publicReleaseEnabled: true, deterministicPreDispatchBlocker: true });
  assert.equal(submitted, true);
  submitted = false;

  submit({ publicReleaseEnabled: true, trustedProviderFreeMock: true });
  assert.equal(submitted, true);
});

test("remote async verifier never submits an unrestricted ordinary generation request", () => {
  const verifier = readFileSync(
    new URL("../../scripts/verify-async-music-background.mjs", import.meta.url),
    "utf8",
  );
  assert.match(verifier, /music\.generation_availability/);
  assert.match(verifier, /assertAsyncRegressionRequestIsProviderFree/);
  assert.match(verifier, /trustedProviderFreeMock:\s*true/);
  assert.match(verifier, /INTERNAL_ASYNC_MUSIC_MOCK_HEADER/);
  assert.doesNotMatch(verifier, /const ordinary\s*=\s*await invoke/);
  assert.doesNotMatch(verifier, /userA\.accessToken,\s*body\s*\);/);
});

test("C2C2 tester live mode is server-selected and schedules one real background path", async () => {
  const operations = new MemoryOperationRepository();
  const parsed = { action: "music.generation_start" as const, request: request() };
  let schedules = 0;
  let backgroundRuns = 0;
  let scheduled: Promise<void> | null = null;
  const accepted = await startAsyncMusicGeneration(USER_A, parsed, {
    operations,
    executionMode: "tester_live",
    schedule: (promise) => {
      schedules += 1;
      scheduled = promise;
    },
    runBackground: async () => { backgroundRuns += 1; },
  });
  assert.equal(accepted.status, "RESERVED");
  assert.equal(schedules, 1);
  await scheduled;
  assert.equal(backgroundRuns, 1);
});

test("start reserves before returning and scheduled background continues after the response", async () => {
  const operations = new MemoryOperationRepository();
  const parsed = { action: "music.generation_start" as const, request: request() };
  let releaseWorker: () => void = () => undefined;
  const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
  let scheduled: Promise<void> | null = null;
  let completed = false;
  const accepted = await startAsyncMusicGeneration(USER_A, parsed, {
    operations,
    executionMode: "trusted_mock",
    schedule: (promise) => { scheduled = promise; },
    runBackground: async () => { await workerGate; completed = true; },
  });
  assert.equal(accepted.status, "RESERVED");
  assert.equal((await operations.load(USER_A, accepted.operationId))?.state, "RESERVED");
  assert.equal(completed, false);
  releaseWorker();
  await scheduled;
  assert.equal(completed, true);
});

test("same request replay schedules once and a different payload conflicts", async () => {
  const operations = new MemoryOperationRepository();
  const operationId = randomUUID();
  const parsed = { action: "music.generation_start" as const, request: request(operationId) };
  let schedules = 0;
  const dependencies = {
    operations,
    executionMode: "trusted_mock" as const,
    schedule: (promise: Promise<void>) => { schedules += 1; void promise; },
    runBackground: async () => undefined,
  };
  await startAsyncMusicGeneration(USER_A, parsed, dependencies);
  await startAsyncMusicGeneration(USER_A, parsed, dependencies);
  assert.equal(schedules, 1);
  await assert.rejects(
    startAsyncMusicGeneration(USER_A, {
      action: "music.generation_start",
      request: request(operationId, "different"),
    }, dependencies),
    (error: unknown) => error instanceof SafeTaskError && error.code === "OPERATION_CONFLICT",
  );
});

test("concurrent double start converges to one scheduled background job", async () => {
  const operations = new MemoryOperationRepository();
  const parsed = { action: "music.generation_start" as const, request: request() };
  let schedules = 0;
  const dependencies = {
    operations,
    executionMode: "trusted_mock" as const,
    schedule: (promise: Promise<void>) => { schedules += 1; void promise; },
    runBackground: async () => undefined,
  };
  await Promise.all([
    startAsyncMusicGeneration(USER_A, parsed, dependencies),
    startAsyncMusicGeneration(USER_A, parsed, dependencies),
  ]);
  assert.equal(schedules, 1);
});

test("duplicate workers cross the atomic dispatch claim at most once", async () => {
  const operations = new MemoryOperationRepository();
  const tracks = new MemoryTrackRepository();
  const parsed = request();
  const input = {
    operationId: parsed.input.operationId as string,
    mode: "custom_lyrics" as const,
    lyrics: parsed.input.lyrics as string,
    prompt: parsed.input.prompt as string,
    title: parsed.input.title as string,
  };
  const reserved = await reserveMusicGenerationOperation(USER_A, input, operations);
  let providerEquivalentCalls = 0;
  const executor: MusicGenerationExecutor = async () => {
    providerEquivalentCalls += 1;
    return {
      audioBytes: Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]),
      serverVerifiedDurationSeconds: null,
      format: "mp3",
      metadata: {},
      metrics: { providerResponseMs: 0, providerRequestDurationMs: 0, providerGenerationLatencyMs: 0, hexValidationDecodeMs: 0, mp3ValidationMs: 0, hexCharacterLength: 0 },
    };
  };
  const dependencies = { operations, tracks, executeMusic: executor, preReservedOperation: reserved.operation };
  await Promise.all([
    executeMusicGenerationRequest(USER_A, parsed, "mock", MODEL, 1_000, { credentialLookupDecryptMs: 0, requestStartedAtMs: 0 }, dependencies),
    executeMusicGenerationRequest(USER_A, parsed, "mock", MODEL, 1_000, { credentialLookupDecryptMs: 0, requestStartedAtMs: 0 }, dependencies),
  ]);
  assert.equal(providerEquivalentCalls, 1);
  assert.equal((await operations.load(USER_A, input.operationId))?.providerCallCount, 1);
  assert.equal((await operations.load(USER_A, input.operationId))?.state, "COMPLETED");
});

for (const scenario of ["before_provider_failure", "provider_failure", "unknown_after_dispatch", "finalizing_failure", "background_rejection"] as const) {
  test(`provider-free background ${scenario} settles safely without duplicate dispatch`, async () => {
    const operations = new MemoryOperationRepository();
    const tracks = new MemoryTrackRepository();
    const parsed = request();
    const input = {
      operationId: parsed.input.operationId as string,
      mode: "custom_lyrics" as const,
      lyrics: parsed.input.lyrics as string,
      prompt: parsed.input.prompt as string,
      title: parsed.input.title as string,
    };
    const reserved = await reserveMusicGenerationOperation(USER_A, input, operations);
    await runGuardedAsyncMusicBackground(parsed, reserved.operation, mockBackgroundDependencies(operations, tracks, scenario));
    const result = await operations.load(USER_A, input.operationId);
    assert.equal(result?.state, scenario === "unknown_after_dispatch" ? "UNKNOWN" : "FAILED");
    assert.ok((result?.providerCallCount ?? 2) <= 1);
    if (scenario === "provider_failure" || scenario === "unknown_after_dispatch") {
      assert.ok(result?.failureDiagnostics);
    }
  });
}

test("scheduling failure marks the reserved operation failed and never runs the worker", async () => {
  const operations = new MemoryOperationRepository();
  const parsed = { action: "music.generation_start" as const, request: request() };
  let workerRan = false;
  await assert.rejects(startAsyncMusicGeneration(USER_A, parsed, {
    operations,
    executionMode: "trusted_mock",
    schedule: () => { throw new Error("scheduler unavailable"); },
    runBackground: async () => { workerRan = true; },
  }), (error: unknown) => error instanceof SafeTaskError && error.code === "INTERNAL_TASK_ERROR");
  assert.equal(workerRan, false);
  assert.equal((await operations.load(USER_A, parsed.request.input.operationId as string))?.state, "FAILED");
});

test("safe status is owner scoped, anonymous rejected, and status reads never start work", async () => {
  const operations = new MemoryOperationRepository();
  const parsed = request();
  const input = {
    operationId: parsed.input.operationId as string,
    mode: "custom_lyrics" as const,
    lyrics: parsed.input.lyrics as string,
    prompt: parsed.input.prompt as string,
    title: parsed.input.title as string,
  };
  await reserveMusicGenerationOperation(USER_A, input, operations);
  const own = await getOwnSafeMusicOperationStatus(USER_A, { action: "music.operation_status", operationId: input.operationId }, operations);
  assert.deepEqual(Object.keys(own).sort(), ["createdAt", "operationId", "status", "updatedAt"]);
  assert.equal(own.status, "RESERVED");
  assert.equal((await operations.load(USER_A, input.operationId))?.providerCallCount, 0);
  await assert.rejects(
    getOwnSafeMusicOperationStatus(USER_B, { action: "music.operation_status", operationId: input.operationId }, operations),
    (error: unknown) => error instanceof SafeTaskError && error.code === "OPERATION_NOT_FOUND",
  );
  await assert.rejects(
    getOwnSafeMusicOperationStatus("anonymous", { action: "music.operation_status", operationId: input.operationId }, operations),
    (error: unknown) => error instanceof SafeTaskError && error.code === "UNAUTHENTICATED",
  );
});

test("trusted mock success finalizes one owner-bound unpublished MedClip track", async () => {
  const operations = new MemoryOperationRepository();
  const tracks = new MemoryTrackRepository();
  const parsed = request();
  const input = {
    operationId: parsed.input.operationId as string,
    mode: "custom_lyrics" as const,
    lyrics: parsed.input.lyrics as string,
    prompt: parsed.input.prompt as string,
    title: parsed.input.title as string,
  };
  const reserved = await reserveMusicGenerationOperation(USER_A, input, operations);
  await runGuardedAsyncMusicBackground(parsed, reserved.operation, mockBackgroundDependencies(operations, tracks));
  const completed = await operations.load(USER_A, input.operationId);
  assert.equal(completed?.state, "COMPLETED");
  assert.equal(completed?.providerCallCount, 1);
  const track = completed?.finalTrackId ? tracks.tracks.get(completed.finalTrackId) : null;
  assert.equal(track?.userId, USER_A);
  assert.equal(track?.published, false);
  assert.match(track?.audioPath ?? "", new RegExp(`^${USER_A}/[0-9a-f-]+/audio\\.mp3$`));
});
