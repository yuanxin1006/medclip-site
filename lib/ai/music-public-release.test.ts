import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SafeTaskError } from "../../supabase/functions/_shared/ai-tasks/errors.ts";
import {
  MusicOperationError,
  reserveMusicGenerationOperation,
  type MusicGenerationOperation,
  type MusicOperationRepository,
  type MusicOperationTransitionInput,
  type ReserveMusicOperationInput,
} from "../../supabase/functions/_shared/ai-tasks/music-operation.ts";
import {
  DEFAULT_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT,
  DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT,
  MUSIC_PUBLIC_RELEASE_MODE,
  musicProductAvailability,
  PROVIDER_FREE_MUSIC_DISPATCH_POLICY,
  resolveMusicProductExecutionMode,
  resolveMusicProductRelease,
  type MusicDispatchPolicy,
} from "../../supabase/functions/_shared/ai-tasks/music-product-release.ts";
import {
  parseAsyncMusicStartRequest,
  startAsyncMusicGeneration,
} from "../../supabase/functions/_shared/ai-tasks/music-product-async.ts";
import { parseRemoteMusicGenerationAvailability } from "./music-generation-product.ts";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const USER_C = "33333333-3333-4333-8333-333333333333";
const USER_D = "44444444-4444-4444-8444-444444444444";
const HASH_A = "a".repeat(64);

const paidPolicy = (overrides: Partial<MusicDispatchPolicy> = {}): MusicDispatchPolicy => ({
  countsPaidDispatch: true,
  enforceUserDailyLimit: true,
  userDailyLimit: DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT,
  globalDailyLimit: DEFAULT_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT,
  quotaWindow: "UTC_CALENDAR_DAY",
  ...overrides,
});

function operationInput(userId: string, operationId: string, requestHash = HASH_A): ReserveMusicOperationInput {
  return { userId, operationId, requestHash, task: "music.generate", provider: "tencent_tokenhub" };
}

class AtomicMemoryQuotaRepository implements MusicOperationRepository {
  readonly operations = new Map<string, MusicGenerationOperation>();
  private tail: Promise<void> = Promise.resolve();
  now = new Date("2026-10-12T12:00:00.000Z");

  private key(userId: string, operationId: string) { return `${userId}:${operationId}`; }

  private async atomic<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }

  private usage(userId?: string): number {
    const start = Date.UTC(this.now.getUTCFullYear(), this.now.getUTCMonth(), this.now.getUTCDate());
    const end = start + 86_400_000;
    return [...this.operations.values()].filter((operation) => {
      if (userId && operation.userId !== userId) return false;
      if (!operation.providerDispatchedAt) return false;
      const dispatched = Date.parse(operation.providerDispatchedAt);
      return dispatched >= start && dispatched < end;
    }).length;
  }

  async reserve(input: ReserveMusicOperationInput) {
    return this.atomic(() => this.createOrReplay(input));
  }

  async reserveGuarded(input: ReserveMusicOperationInput, policy: MusicDispatchPolicy) {
    return this.atomic(() => {
      const existing = this.operations.get(this.key(input.userId, input.operationId));
      if (existing) {
        if (existing.requestHash !== input.requestHash) throw new MusicOperationError("OPERATION_CONFLICT", "conflict");
        return { operation: existing, created: false };
      }
      if ([...this.operations.values()].some((operation) => operation.userId === input.userId
        && ["RESERVED", "PROVIDER_IN_FLIGHT", "FINALIZING", "UNKNOWN"].includes(operation.state))) {
        throw new MusicOperationError("MUSIC_GENERATION_ALREADY_ACTIVE", "active");
      }
      if (policy.countsPaidDispatch && policy.enforceUserDailyLimit && this.usage(input.userId) >= policy.userDailyLimit) {
        throw new MusicOperationError("MUSIC_DAILY_LIMIT_REACHED", "daily");
      }
      if (policy.countsPaidDispatch && this.usage() >= policy.globalDailyLimit) {
        throw new MusicOperationError("MUSIC_GLOBAL_LIMIT_REACHED", "global");
      }
      return this.createOrReplay(input);
    });
  }

  private createOrReplay(input: ReserveMusicOperationInput) {
    const key = this.key(input.userId, input.operationId);
    const existing = this.operations.get(key);
    if (existing) {
      if (existing.requestHash !== input.requestHash) throw new MusicOperationError("OPERATION_CONFLICT", "conflict");
      return { operation: existing, created: false };
    }
    const timestamp = this.now.toISOString();
    const operation: MusicGenerationOperation = {
      id: input.operationId,
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
      providerDispatchedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.operations.set(key, operation);
    return { operation, created: true };
  }

  async authorizeProviderDispatch(operation: MusicGenerationOperation, policy: MusicDispatchPolicy) {
    return this.atomic(() => {
      const current = this.operations.get(this.key(operation.userId, operation.operationId));
      if (!current || current.state !== "RESERVED" || current.providerCallCount !== 0) {
        throw new MusicOperationError("OPERATION_TRANSITION_CONFLICT", "transition");
      }
      if (policy.countsPaidDispatch && policy.enforceUserDailyLimit && this.usage(current.userId) >= policy.userDailyLimit) {
        throw new MusicOperationError("MUSIC_DAILY_LIMIT_REACHED", "daily");
      }
      if (policy.countsPaidDispatch && this.usage() >= policy.globalDailyLimit) {
        throw new MusicOperationError("MUSIC_GLOBAL_LIMIT_REACHED", "global");
      }
      const next: MusicGenerationOperation = {
        ...current,
        state: "PROVIDER_IN_FLIGHT",
        providerCallCount: 1,
        providerDispatchedAt: policy.countsPaidDispatch ? this.now.toISOString() : null,
        updatedAt: this.now.toISOString(),
      };
      this.operations.set(this.key(next.userId, next.operationId), next);
      return next;
    });
  }

  async load(userId: string, operationId: string) {
    return this.operations.get(this.key(userId, operationId)) ?? null;
  }

  async transition(input: MusicOperationTransitionInput) {
    return this.atomic(() => {
      const key = this.key(input.userId, input.operationId);
      const current = this.operations.get(key);
      if (!current || current.state !== input.expectedState) throw new MusicOperationError("OPERATION_TRANSITION_CONFLICT", "transition");
      const next: MusicGenerationOperation = {
        ...current,
        state: input.nextState,
        providerCallCount: input.providerCallCount,
        finalTrackId: input.finalTrackId ?? null,
        failureCode: input.failureCode ?? null,
        failureDiagnostics: input.failureDiagnostics ?? null,
        updatedAt: this.now.toISOString(),
      };
      this.operations.set(key, next);
      return next;
    });
  }
}

async function dispatch(repository: AtomicMemoryQuotaRepository, input: ReserveMusicOperationInput, policy = paidPolicy()) {
  const reserved = await repository.reserveGuarded(input, policy);
  return repository.authorizeProviderDispatch(reserved.operation, policy);
}

async function settle(
  repository: AtomicMemoryQuotaRepository,
  operation: MusicGenerationOperation,
  state: "FAILED" | "UNKNOWN" | "COMPLETED",
) {
  if (state === "COMPLETED") {
    const finalizing = await repository.transition({
      userId: operation.userId, operationId: operation.operationId,
      expectedState: "PROVIDER_IN_FLIGHT", nextState: "FINALIZING", providerCallCount: 1,
    });
    return repository.transition({
      userId: operation.userId, operationId: operation.operationId,
      expectedState: "FINALIZING", nextState: "COMPLETED", providerCallCount: 1,
      finalTrackId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
  }
  return repository.transition({
    userId: operation.userId, operationId: operation.operationId,
    expectedState: "PROVIDER_IN_FLIGHT", nextState: state, providerCallCount: 1,
    failureCode: state === "UNKNOWN" ? "PROVIDER_OUTCOME_UNKNOWN" : "PROVIDER_REQUEST_FAILED",
  });
}

test("C3A public release defaults OFF and beta limits are server configured", () => {
  const off = resolveMusicProductRelease(USER_A, () => undefined);
  assert.deepEqual(off, {
    enabled: false,
    executionMode: null,
    testerMockEnabled: false,
    testerLiveEnabled: false,
    publicAuthenticatedBetaEnabled: false,
  });
  const values = new Map([
    ["MEDCLIP_MUSIC_PUBLIC_RELEASE_MODE", MUSIC_PUBLIC_RELEASE_MODE],
    ["MEDCLIP_MUSIC_USER_DAILY_PROVIDER_LIMIT", "10"],
    ["MEDCLIP_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT", "20"],
  ]);
  const beta = resolveMusicProductRelease(USER_A, (name) => values.get(name));
  assert.equal(beta.enabled, true);
  assert.equal(beta.executionMode, "public_real");
  assert.equal(beta.testerMockEnabled, false);
  assert.equal(beta.testerLiveEnabled, false);
  assert.equal(beta.publicAuthenticatedBetaEnabled, true);
  assert.equal(resolveMusicProductExecutionMode(beta, false), "public_real");
  assert.equal(resolveMusicProductExecutionMode(beta, true), "trusted_mock");
  assert.deepEqual(musicProductAvailability(beta), {
    enabled: true,
    testerModeEnabled: false,
  });
  assert.deepEqual(parseRemoteMusicGenerationAvailability({
    ok: true,
    musicGeneration: musicProductAvailability(beta),
  }), {
    enabled: true,
    testerModeEnabled: false,
  });
  assert.throws(() => parseRemoteMusicGenerationAvailability({
    ok: true,
    musicGeneration: { enabled: true, testerModeEnabled: false, testerMockEnabled: true },
  }));
  assert.deepEqual(beta.dispatchPolicy, paidPolicy());
  assert.equal(DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT, 10);
  assert.equal(DEFAULT_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT, 20);
  for (const invalid of ["0", "-1", "1.5", "999999"]) {
    values.set("MEDCLIP_MUSIC_USER_DAILY_PROVIDER_LIMIT", invalid);
    assert.throws(() => resolveMusicProductRelease(USER_A, (name) => values.get(name)));
  }
});

test("C3C release modes select one mutually exclusive execution route", () => {
  const environment = new Map<string, string>();
  const readEnvironment = (name: string) => environment.get(name);
  const off = resolveMusicProductRelease(USER_A, readEnvironment);
  assert.equal(resolveMusicProductExecutionMode(off, false), null);

  environment.set("MEDCLIP_MUSIC_TEST_RELEASE_MODE", "TESTER_MOCK");
  environment.set("MEDCLIP_MUSIC_TESTER_USER_IDS", USER_A);
  const testerMock = resolveMusicProductRelease(USER_A, readEnvironment);
  assert.deepEqual({
    executionMode: testerMock.executionMode,
    testerMockEnabled: testerMock.testerMockEnabled,
    testerLiveEnabled: testerMock.testerLiveEnabled,
    publicAuthenticatedBetaEnabled: testerMock.publicAuthenticatedBetaEnabled,
  }, {
    executionMode: "trusted_mock",
    testerMockEnabled: true,
    testerLiveEnabled: false,
    publicAuthenticatedBetaEnabled: false,
  });

  environment.set("MEDCLIP_MUSIC_TEST_RELEASE_MODE", "TESTER_LIVE");
  const testerLive = resolveMusicProductRelease(USER_A, readEnvironment);
  assert.deepEqual({
    executionMode: testerLive.executionMode,
    testerMockEnabled: testerLive.testerMockEnabled,
    testerLiveEnabled: testerLive.testerLiveEnabled,
    publicAuthenticatedBetaEnabled: testerLive.publicAuthenticatedBetaEnabled,
  }, {
    executionMode: "tester_live",
    testerMockEnabled: false,
    testerLiveEnabled: true,
    publicAuthenticatedBetaEnabled: false,
  });

  environment.set("MEDCLIP_MUSIC_TEST_RELEASE_MODE", "OFF");
  environment.set("MEDCLIP_MUSIC_PUBLIC_RELEASE_MODE", MUSIC_PUBLIC_RELEASE_MODE);
  const publicBeta = resolveMusicProductRelease(USER_A, readEnvironment);
  assert.deepEqual({
    executionMode: publicBeta.executionMode,
    testerMockEnabled: publicBeta.testerMockEnabled,
    testerLiveEnabled: publicBeta.testerLiveEnabled,
    publicAuthenticatedBetaEnabled: publicBeta.publicAuthenticatedBetaEnabled,
  }, {
    executionMode: "public_real",
    testerMockEnabled: false,
    testerLiveEnabled: false,
    publicAuthenticatedBetaEnabled: true,
  });
  assert.deepEqual(musicProductAvailability(publicBeta), {
    enabled: true,
    testerModeEnabled: false,
  });
  assert.throws(
    () => resolveMusicProductRelease("anonymous", readEnvironment),
    (error: unknown) => error instanceof SafeTaskError && error.code === "UNAUTHENTICATED",
  );
});

test("C3C public route reaches daily, global, active and UNKNOWN safety gates before scheduling", async () => {
  const environment = new Map<string, string>([
    ["MEDCLIP_MUSIC_PUBLIC_RELEASE_MODE", MUSIC_PUBLIC_RELEASE_MODE],
  ]);
  const release = resolveMusicProductRelease(USER_A, (name) => environment.get(name));
  assert.equal(release.executionMode, "public_real");
  assert.equal(release.testerMockEnabled, false);
  assert.equal(release.testerLiveEnabled, false);
  assert.ok(release.dispatchPolicy);
  let tokenHubGenerationAttempts = 0;

  const attempt = async (
    repository: AtomicMemoryQuotaRepository,
    expectedCode: string,
    operationId: string,
  ) => {
    let schedules = 0;
    await assert.rejects(
      startAsyncMusicGeneration(USER_A, {
        action: "music.generation_start",
        request: parseAsyncMusicStartRequest({
          action: "music.generation_start",
          input: { operationId, mode: "instrumental", prompt: "provider-free public routing check" },
        }).request,
      }, {
        operations: repository,
        executionMode: "public_real",
        dispatchPolicy: release.dispatchPolicy,
        schedule: () => { schedules += 1; },
        runBackground: async () => {
          tokenHubGenerationAttempts += 1;
          throw new Error("provider path must not run");
        },
      }),
      (error: unknown) => error instanceof SafeTaskError && error.code === expectedCode,
    );
    assert.equal(schedules, 0);
  };

  const daily = new AtomicMemoryQuotaRepository();
  for (let index = 0; index < DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT; index += 1) {
    const operationId = `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    await settle(daily, await dispatch(daily, operationInput(USER_A, operationId)), "COMPLETED");
  }
  await attempt(daily, "MUSIC_DAILY_LIMIT_REACHED", "a0000000-0000-4000-8000-000000000011");

  const global = new AtomicMemoryQuotaRepository();
  for (let index = 0; index < DEFAULT_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT; index += 1) {
    const userId = `${String(index + 10).padStart(8, "0")}-0000-4000-8000-000000000000`;
    const operationId = `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    await settle(global, await dispatch(global, operationInput(userId, operationId)), "FAILED");
  }
  await attempt(global, "MUSIC_GLOBAL_LIMIT_REACHED", "b0000000-0000-4000-8000-999999999999");

  const active = new AtomicMemoryQuotaRepository();
  await active.reserveGuarded(operationInput(USER_A, "c0000000-0000-4000-8000-000000000001"), release.dispatchPolicy);
  await attempt(active, "MUSIC_GENERATION_ALREADY_ACTIVE", "c0000000-0000-4000-8000-000000000002");

  const unknown = new AtomicMemoryQuotaRepository();
  await settle(unknown, await dispatch(unknown, operationInput(USER_A, "d0000000-0000-4000-8000-000000000001")), "UNKNOWN");
  await attempt(unknown, "MUSIC_GENERATION_ALREADY_ACTIVE", "d0000000-0000-4000-8000-000000000002");
  assert.equal(tokenHubGenerationAttempts, 0);
});

test("first paid dispatch is allowed; FAILED, UNKNOWN and COMPLETED each consume the UTC-day quota", async () => {
  for (const terminal of ["FAILED", "UNKNOWN", "COMPLETED"] as const) {
    const repository = new AtomicMemoryQuotaRepository();
    const onePerDayPolicy = paidPolicy({ userDailyLimit: 1 });
    const first = await dispatch(
      repository,
      operationInput(USER_A, `10000000-0000-4000-8000-00000000000${terminal.length}`),
      onePerDayPolicy,
    );
    await settle(repository, first, terminal);
    await assert.rejects(
      repository.reserveGuarded(
        operationInput(USER_A, "20000000-0000-4000-8000-000000000001"),
        onePerDayPolicy,
      ),
      (error: unknown) => error instanceof MusicOperationError
        && (terminal === "UNKNOWN" ? error.code === "MUSIC_GENERATION_ALREADY_ACTIVE" : error.code === "MUSIC_DAILY_LIMIT_REACHED"),
    );
  }
});

test("raised public beta user limit allows ten paid dispatches before blocking the eleventh", async () => {
  const repository = new AtomicMemoryQuotaRepository();
  for (let index = 0; index < DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT; index += 1) {
    const operationId = `21000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const operation = await dispatch(repository, operationInput(USER_A, operationId));
    await settle(repository, operation, "COMPLETED");
  }
  await assert.rejects(
    repository.reserveGuarded(
      operationInput(USER_A, "21000000-0000-4000-8000-000000000011"),
      paidPolicy(),
    ),
    (error: unknown) => error instanceof MusicOperationError && error.code === "MUSIC_DAILY_LIMIT_REACHED",
  );
  assert.equal(
    [...repository.operations.values()].filter((operation) => operation.providerDispatchedAt).length,
    DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT,
  );
});

test("same-operation replay consumes no extra quota and payload conflict consumes none", async () => {
  const repository = new AtomicMemoryQuotaRepository();
  const input = operationInput(USER_A, "30000000-0000-4000-8000-000000000001");
  const first = await dispatch(repository, input);
  await settle(repository, first, "COMPLETED");
  const replay = await repository.reserveGuarded(input, paidPolicy());
  assert.equal(replay.created, false);
  assert.equal([...repository.operations.values()].filter((item) => item.providerDispatchedAt).length, 1);
  await assert.rejects(
    repository.reserveGuarded({ ...input, requestHash: "b".repeat(64) }, paidPolicy()),
    (error: unknown) => error instanceof MusicOperationError && error.code === "OPERATION_CONFLICT",
  );
  assert.equal([...repository.operations.values()].filter((item) => item.providerDispatchedAt).length, 1);
});

test("user quotas are independent while the global ceiling cannot be bypassed by new users", async () => {
  const repository = new AtomicMemoryQuotaRepository();
  const policy = paidPolicy({ globalDailyLimit: 2 });
  await settle(repository, await dispatch(repository, operationInput(USER_A, "40000000-0000-4000-8000-000000000001"), policy), "COMPLETED");
  await settle(repository, await dispatch(repository, operationInput(USER_B, "40000000-0000-4000-8000-000000000002"), policy), "FAILED");
  await assert.rejects(
    repository.reserveGuarded(operationInput(USER_C, "40000000-0000-4000-8000-000000000003"), policy),
    (error: unknown) => error instanceof MusicOperationError && error.code === "MUSIC_GLOBAL_LIMIT_REACHED",
  );
});

test("pre-dispatch input failure and provider-free mock do not consume paid quota", async () => {
  const repository = new AtomicMemoryQuotaRepository();
  assert.throws(() => parseAsyncMusicStartRequest({ action: "music.generation_start", input: { mode: "instrumental" } }));
  assert.equal(repository.operations.size, 0);
  const mock = await dispatch(
    repository,
    operationInput(USER_A, "50000000-0000-4000-8000-000000000001"),
    PROVIDER_FREE_MUSIC_DISPATCH_POLICY,
  );
  assert.equal(mock.providerCallCount, 1);
  assert.equal(mock.providerDispatchedAt, null);
});

test("RESERVED, PROVIDER_IN_FLIGHT, FINALIZING and UNKNOWN atomically block another operation", async () => {
  for (const state of ["RESERVED", "PROVIDER_IN_FLIGHT", "FINALIZING", "UNKNOWN"] as const) {
    const repository = new AtomicMemoryQuotaRepository();
    const firstInput = operationInput(USER_A, `60000000-0000-4000-8000-00000000000${state.length}`);
    let current = (await repository.reserveGuarded(firstInput, paidPolicy())).operation;
    if (state !== "RESERVED") current = await repository.authorizeProviderDispatch(current, paidPolicy());
    if (state === "FINALIZING") current = await repository.transition({ userId: USER_A, operationId: current.operationId, expectedState: "PROVIDER_IN_FLIGHT", nextState: "FINALIZING", providerCallCount: 1 });
    if (state === "UNKNOWN") current = await settle(repository, current, "UNKNOWN");
    assert.equal(current.state, state);
    await assert.rejects(
      repository.reserveGuarded(operationInput(USER_A, "69999999-0000-4000-8000-000000000001"), paidPolicy()),
      (error: unknown) => error instanceof MusicOperationError && error.code === "MUSIC_GENERATION_ALREADY_ACTIVE",
    );
  }
});

test("ten parallel same-user starts reserve at most one operation", async () => {
  const repository = new AtomicMemoryQuotaRepository();
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => (
    repository.reserveGuarded(
      operationInput(USER_A, `70000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`),
      paidPolicy(),
    )
  )));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(repository.operations.size, 1);
});

test("parallel users at the global boundary never exceed the dispatch ceiling", async () => {
  const repository = new AtomicMemoryQuotaRepository();
  const policy = paidPolicy({ globalDailyLimit: 2 });
  const inputs = [
    operationInput(USER_A, "80000000-0000-4000-8000-000000000001"),
    operationInput(USER_B, "80000000-0000-4000-8000-000000000002"),
    operationInput(USER_C, "80000000-0000-4000-8000-000000000003"),
    operationInput(USER_D, "80000000-0000-4000-8000-000000000004"),
  ];
  const reservations = await Promise.all(inputs.map((input) => repository.reserveGuarded(input, policy)));
  const results = await Promise.allSettled(reservations.map(({ operation }) => repository.authorizeProviderDispatch(operation, policy)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal([...repository.operations.values()].filter((operation) => operation.providerDispatchedAt).length, 2);
});

test("UTC day boundary resets usage without browser timezone input", async () => {
  const repository = new AtomicMemoryQuotaRepository();
  const onePerDayPolicy = paidPolicy({ userDailyLimit: 1 });
  repository.now = new Date("2026-10-12T23:59:59.000Z");
  await settle(repository, await dispatch(repository, operationInput(USER_A, "90000000-0000-4000-8000-000000000001"), onePerDayPolicy), "COMPLETED");
  await assert.rejects(repository.reserveGuarded(operationInput(USER_A, "90000000-0000-4000-8000-000000000002"), onePerDayPolicy));
  repository.now = new Date("2026-10-13T00:00:01.000Z");
  const nextDay = await repository.reserveGuarded(operationInput(USER_A, "90000000-0000-4000-8000-000000000003"), onePerDayPolicy);
  assert.equal(nextDay.created, true);
});

test("Migration 009 is service-only, UTC-based and makes the dispatch gate atomic", () => {
  const migration = readFileSync(new URL("../../supabase/migrations/009_music_public_release_safety.sql", import.meta.url), "utf8");
  assert.match(migration, /provider_dispatched_at timestamptz/i);
  assert.match(migration, /UTC/);
  assert.match(migration, /pg_advisory_xact_lock/g);
  assert.match(migration, /MUSIC_DAILY_LIMIT_REACHED/);
  assert.match(migration, /MUSIC_GLOBAL_LIMIT_REACHED/);
  assert.match(migration, /MUSIC_GENERATION_ALREADY_ACTIVE/);
  assert.match(migration, /state in \('RESERVED', 'PROVIDER_IN_FLIGHT', 'FINALIZING', 'UNKNOWN'\)/);
  assert.match(migration, /from public, anon, authenticated/);
  assert.match(migration, /to service_role/);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to authenticated/i);
});

test("C3A browser contract cannot control release, quota, retry or provider internals", () => {
  const edge = readFileSync(new URL("../../supabase/functions/ai-tasks/index.ts", import.meta.url), "utf8");
  const request = readFileSync(new URL("../../supabase/functions/_shared/ai-tasks/music-product-async.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("./music-generation-client.ts", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../../components/ai/AsyncMusicGenerationPanel.tsx", import.meta.url), "utf8");
  assert.match(edge, /MUSIC_PUBLIC_RELEASE_DISABLED/);
  assert.match(edge, /resolveMusicProductRelease/);
  assert.match(edge, /resolveMusicProductExecutionMode/);
  assert.doesNotMatch(edge, /testerMockEnabled\s*\?\s*"trusted_mock"/);
  assert.doesNotMatch(request, /quotaBypass|unlimited|admin|userDailyLimit|globalDailyLimit/);
  assert.match(client, /今天的歌曲生成次数已用完，请稍后再试。/);
  assert.match(client, /已有歌曲正在生成，请等待当前任务完成。/);
  assert.match(panel, /remoteAvailability\.testerModeEnabled/);
  assert.match(panel, /remoteAvailability\.enabled/);
});

test("production repository binds both guarded RPCs and never uses browser counters", async () => {
  const operationSource = readFileSync(new URL("../../supabase/functions/_shared/ai-tasks/music-operation.ts", import.meta.url), "utf8");
  assert.match(operationSource, /medclip_reserve_music_generation_operation_guarded/);
  assert.match(operationSource, /medclip_authorize_music_provider_dispatch/);
  assert.doesNotMatch(operationSource, /localStorage|sessionStorage|document\.|window\./);
  const repository = new AtomicMemoryQuotaRepository();
  const input = {
    operationId: "aaaaaaaa-0000-4000-8000-000000000001",
    mode: "instrumental" as const,
    prompt: "provider-free quota test",
  };
  const reserved = await reserveMusicGenerationOperation(USER_A, input, repository, paidPolicy());
  assert.equal(reserved.operation.state, "RESERVED");
});
