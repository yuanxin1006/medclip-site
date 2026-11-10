import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createMockMusicGenerationGateway,
} from "./music-generation-mock.ts";
import {
  createMusicOperationId,
  createSingleSubmissionGuard,
  isTerminalMusicOperation,
  musicGenerationStageCopy,
  parseMusicGenerationStartRequest,
  parseSafeMusicOperation,
  persistMusicOperationRecovery,
  pollMusicOperation,
  restoreMusicOperationRecovery,
  type RecoveryStorage,
  type SafeMusicOperation,
} from "./music-generation-product.ts";
import {
  getOwnSafeMusicOperationStatus,
  parseMusicOperationStatusRequest,
} from "../../supabase/functions/_shared/ai-tasks/music-product-status.ts";
import type {
  MusicGenerationOperation,
  MusicOperationRepository,
} from "../../supabase/functions/_shared/ai-tasks/music-operation.ts";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const TRACK_ID = "55555555-5555-4555-8555-555555555555";

class MemoryStorage implements RecoveryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function operation(overrides: Partial<MusicGenerationOperation> = {}): MusicGenerationOperation {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    userId: USER_A,
    operationId: OPERATION_ID,
    task: "music.generate",
    provider: "tencent_tokenhub",
    requestHash: "0".repeat(64),
    state: "RESERVED",
    providerCallCount: 0,
    providerRequestId: null,
    providerTraceId: null,
    finalTrackId: null,
    failureCode: null,
    failureDiagnostics: null,
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    ...overrides,
  };
}

function repositoryFor(value: MusicGenerationOperation | null): MusicOperationRepository {
  return {
    async reserve() { throw new Error("not used"); },
    async load(userId, operationId) {
      if (!value || value.userId !== userId || value.operationId !== operationId) return null;
      return value;
    },
    async transition() { throw new Error("not used"); },
  };
}

test("idle and every durable operation state map to meaningful non-percentage UX", () => {
  const expected = new Map([
    ["IDLE", "准备生成歌曲"],
    ["SUBMITTING", "正在提交生成任务"],
    ["RESERVED", "正在准备生成"],
    ["PROVIDER_IN_FLIGHT", "AI 正在生成歌曲"],
    ["FINALIZING", "歌曲已生成，正在保存"],
    ["COMPLETED", "生成完成"],
    ["FAILED", "歌曲生成失败"],
    ["UNKNOWN", "正在确认生成结果"],
  ] as const);
  for (const [state, label] of expected) {
    const copy = musicGenerationStageCopy(state);
    assert.equal(copy.label, label);
    assert.doesNotMatch(copy.label + copy.description, /\d+%/);
  }
});

test("operation IDs are cryptographically shaped UUIDs and never authorization tokens", () => {
  assert.equal(createMusicOperationId(() => OPERATION_ID), OPERATION_ID);
  assert.throws(() => createMusicOperationId(() => "user-a-secret"), /任务编号无效/);
});

test("start contract accepts business input only and rejects provider internals", () => {
  const valid = parseMusicGenerationStartRequest({
    operationId: OPERATION_ID,
    mode: "custom_lyrics",
    lyrics: "短歌词",
    title: "测试歌曲",
  });
  assert.equal(valid.operationId, OPERATION_ID);
  for (const forbidden of ["provider", "model", "endpoint", "baseURL", "timeout", "audioUrl", "apiKey", "responseSchema"]) {
    assert.throws(() => parseMusicGenerationStartRequest({
      operationId: OPERATION_ID,
      mode: "custom_lyrics",
      lyrics: "短歌词",
      [forbidden]: "browser-value",
    }), /不允许的字段/);
  }
});

test("safe status contract excludes provider and private diagnostic fields", () => {
  const safe = parseSafeMusicOperation({
    operationId: OPERATION_ID,
    status: "COMPLETED",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:01.000Z",
    trackId: TRACK_ID,
  });
  assert.deepEqual(Object.keys(safe).sort(), ["createdAt", "operationId", "status", "trackId", "updatedAt"]);
  for (const forbidden of ["providerUrl", "hostname", "dns", "provider_call_count", "authorization", "apiKey", "rawResponse"]) {
    assert.throws(() => parseSafeMusicOperation({ ...safe, [forbidden]: "forbidden" }), /状态响应无效/);
  }
});

test("server status path derives owner from authenticated identity", async () => {
  const completed = operation({ state: "COMPLETED", providerCallCount: 1, finalTrackId: TRACK_ID });
  const request = parseMusicOperationStatusRequest({ action: "music.operation_status", operationId: OPERATION_ID });
  const own = await getOwnSafeMusicOperationStatus(USER_A, request, repositoryFor(completed));
  assert.equal(own.trackId, TRACK_ID);
  assert.deepEqual(Object.keys(own).sort(), ["createdAt", "operationId", "status", "trackId", "updatedAt"]);
  await assert.rejects(
    getOwnSafeMusicOperationStatus(USER_B, request, repositoryFor(completed)),
    /找不到该歌曲生成任务/,
  );
  await assert.rejects(
    getOwnSafeMusicOperationStatus("", request, repositoryFor(completed)),
    /AI/,
  );
});

test("status request rejects browser owner, provider and transport controls", () => {
  for (const forbidden of ["userId", "provider", "model", "endpoint", "timeout", "audioUrl"]) {
    assert.throws(() => parseMusicOperationStatusRequest({
      action: "music.operation_status",
      operationId: OPERATION_ID,
      [forbidden]: "forbidden",
    }));
  }
});

test("mock start is idempotent and same ID with different payload conflicts", async () => {
  const storage = new MemoryStorage();
  const gateway = createMockMusicGenerationGateway({ authenticatedUserId: USER_A, storage });
  const request = { operationId: OPERATION_ID, mode: "custom_lyrics" as const, lyrics: "同一歌词" };
  const first = await gateway.start(request);
  const replay = await gateway.start(request);
  assert.deepEqual(replay, first);
  await assert.rejects(
    gateway.start({ ...request, lyrics: "不同歌词" }),
    /同一任务编号不能用于不同的生成内容/,
  );
  assert.equal(storage.values.size, 1);
});

test("mock status is owner isolated and anonymous construction is denied", async () => {
  const storage = new MemoryStorage();
  const userA = createMockMusicGenerationGateway({ authenticatedUserId: USER_A, storage });
  await userA.start({ operationId: OPERATION_ID, mode: "instrumental", prompt: "钢琴" });
  const userB = createMockMusicGenerationGateway({ authenticatedUserId: USER_B, storage });
  await assert.rejects(userB.getStatus(OPERATION_ID), /找不到该生成任务/);
  assert.throws(
    () => createMockMusicGenerationGateway({ authenticatedUserId: null, storage }),
    /请先登录/,
  );
});

test("mock completed playback uses a local fixture and never a Provider URL", async () => {
  const storage = new MemoryStorage();
  const gateway = createMockMusicGenerationGateway({ authenticatedUserId: USER_A, storage });
  await gateway.start({ operationId: OPERATION_ID, mode: "instrumental", prompt: "轻音乐" });
  let status = await gateway.getStatus(OPERATION_ID);
  while (!isTerminalMusicOperation(status.status)) status = await gateway.getStatus(OPERATION_ID);
  assert.equal(status.status, "COMPLETED");
  const playback = await gateway.getCompletedTrack(status.trackId!);
  assert.equal(playback.source, "local_test_fixture");
  assert.match(playback.src, /^data:audio\/wav;base64,/);
  assert.doesNotMatch(playback.src, /tokenhub|myqcloud|https?:\/\//i);
});

test("single-flight guard suppresses a double submit", async () => {
  const guard = createSingleSubmissionGuard();
  let release!: () => void;
  const pending = guard.run(() => new Promise<number>((resolve) => { release = () => resolve(1); }));
  assert.equal(guard.active, true);
  assert.equal(await guard.run(async () => 2), null);
  release();
  assert.equal(await pending, 1);
  assert.equal(guard.active, false);
});

test("refresh recovery persists only operation ID and non-sensitive title", () => {
  const storage = new MemoryStorage();
  persistMusicOperationRecovery(storage, USER_A, { operationId: OPERATION_ID, title: "恢复测试" });
  const serialized = [...storage.values.values()][0];
  assert.doesNotMatch(serialized, /lyrics|prompt|apiKey|Authorization|audio/i);
  assert.deepEqual(restoreMusicOperationRecovery(storage, USER_A), {
    operationId: OPERATION_ID,
    title: "恢复测试",
  });
});

async function runPoll(statuses: SafeMusicOperation[], onStatus?: (status: SafeMusicOperation) => void) {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const controller = new AbortController();
  await pollMusicOperation({
    operationId: OPERATION_ID,
    signal: controller.signal,
    intervalMs: 1_000,
    sleep: async () => {},
    getStatus: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      const status = statuses[Math.min(calls, statuses.length - 1)];
      calls += 1;
      active -= 1;
      return status;
    },
    onStatus(status) {
      onStatus?.(status);
    },
  });
  return { calls, maximumActive };
}

function safeStatus(status: SafeMusicOperation["status"]): SafeMusicOperation {
  return {
    operationId: OPERATION_ID,
    status,
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:01.000Z",
    ...(status === "COMPLETED" ? { trackId: TRACK_ID } : {}),
  };
}

test("polling stops on COMPLETED and prevents overlapping status requests", async () => {
  const result = await runPoll([safeStatus("RESERVED"), safeStatus("COMPLETED")]);
  assert.deepEqual(result, { calls: 2, maximumActive: 1 });
});

test("polling stops on FAILED", async () => {
  const result = await runPoll([safeStatus("PROVIDER_IN_FLIGHT"), safeStatus("FAILED")]);
  assert.equal(result.calls, 2);
});

test("UNKNOWN uses a bounded cautious polling strategy", async () => {
  const result = await runPoll([safeStatus("UNKNOWN")]);
  assert.equal(result.calls, 3);
});

test("polling cleanup on unmount aborts further requests", async () => {
  const controller = new AbortController();
  let calls = 0;
  await pollMusicOperation({
    operationId: OPERATION_ID,
    signal: controller.signal,
    intervalMs: 1_000,
    sleep: async () => {},
    getStatus: async () => { calls += 1; return safeStatus("RESERVED"); },
    onStatus: () => controller.abort(),
  });
  assert.equal(calls, 1);
});

test("public generation remains closed while C2B uses hosted background execution", () => {
  const registry = readFileSync(new URL("../../supabase/functions/_shared/ai-tasks/registry.ts", import.meta.url), "utf8");
  const edge = readFileSync(new URL("../../supabase/functions/ai-tasks/index.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../../app/create-music/page.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../../components/ai/AsyncMusicGenerationPanel.tsx", import.meta.url), "utf8");
  assert.match(registry, /tencent_tokenhub:[\s\S]*?liveTaskIds:\s*\[\]/);
  assert.match(page, /AsyncMusicGenerationPanel/);
  assert.match(panel, /process\.env\.NODE_ENV === "development"/);
  assert.match(panel, /真实付费生成仍未公开开放/);
  assert.match(edge, /EdgeRuntime\.waitUntil/);
  assert.match(edge, /authorizeInternalLiveValidation/);
});
