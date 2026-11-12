import {
  type CompletedMusicPlayback,
  type MusicGenerationAccepted,
  type MusicGenerationGateway,
  MusicGenerationProductError,
  type MusicGenerationStartRequest,
  type MusicOperationStatus,
  parseMusicGenerationStartRequest,
  type RecoveryStorage,
  type SafeMusicOperation,
} from "./music-generation-product.ts";

export type MockMusicScenario = "COMPLETED" | "FAILED" | "UNKNOWN";

type MockOperationRecord = {
  ownerId: string;
  operationId: string;
  requestHash: string;
  scenario: MockMusicScenario;
  cursor: number;
  createdAt: string;
  updatedAt: string;
};

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MOCK_TRACK_ID = "22222222-2222-4222-8222-222222222222";
const MOCK_AUDIO_FIXTURE = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQQAAAAAAA==";

function requireUserId(value: string | null | undefined): string {
  if (!value || !USER_ID_PATTERN.test(value)) {
    throw new MusicGenerationProductError("UNAUTHENTICATED", "请先登录后再创建或查看生成任务。");
  }
  return value.toLowerCase();
}

function recordKey(ownerId: string, operationId: string): string {
  return `medclip:c2a:mock-operation:${ownerId}:${operationId}`;
}

async function requestHash(request: MusicGenerationStartRequest): Promise<string> {
  const canonical = JSON.stringify({
    operationId: request.operationId,
    mode: request.mode,
    title: request.title ?? null,
    lyrics: request.mode === "custom_lyrics" ? request.lyrics : null,
    prompt: request.prompt ?? null,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseRecord(value: string | null): MockOperationRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as MockOperationRecord;
    if (!parsed || typeof parsed !== "object" || !USER_ID_PATTERN.test(parsed.ownerId)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function sequence(scenario: MockMusicScenario): readonly MusicOperationStatus[] {
  if (scenario === "FAILED") return ["RESERVED", "PROVIDER_IN_FLIGHT", "FAILED"];
  if (scenario === "UNKNOWN") return ["RESERVED", "PROVIDER_IN_FLIGHT", "UNKNOWN"];
  return ["RESERVED", "PROVIDER_IN_FLIGHT", "FINALIZING", "COMPLETED"];
}

function safeStatus(record: MockOperationRecord): SafeMusicOperation {
  const states = sequence(record.scenario);
  const status = states[Math.min(record.cursor, states.length - 1)];
  return {
    operationId: record.operationId,
    status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(status === "COMPLETED" ? { trackId: MOCK_TRACK_ID } : {}),
    ...(status === "FAILED" ? { safeErrorCode: "MOCK_GENERATION_FAILED" } : {}),
    ...(status === "UNKNOWN" ? { safeErrorCode: "MOCK_OUTCOME_UNKNOWN" } : {}),
  };
}

export function createMockMusicGenerationGateway(options: {
  authenticatedUserId: string | null | undefined;
  storage: RecoveryStorage;
  scenario?: MockMusicScenario;
  now?: () => Date;
}): MusicGenerationGateway {
  const ownerId = requireUserId(options.authenticatedUserId);
  const scenario = options.scenario ?? "COMPLETED";
  const now = options.now ?? (() => new Date());
  return {
    async start(value): Promise<MusicGenerationAccepted> {
      const request = parseMusicGenerationStartRequest(value);
      const key = recordKey(ownerId, request.operationId);
      const hash = await requestHash(request);
      const existing = parseRecord(options.storage.getItem(key));
      if (existing) {
        if (existing.requestHash !== hash) {
          throw new MusicGenerationProductError("OPERATION_CONFLICT", "同一任务编号不能用于不同的生成内容。");
        }
        return { accepted: true, operationId: request.operationId, status: "RESERVED" };
      }
      const timestamp = now().toISOString();
      const record: MockOperationRecord = {
        ownerId,
        operationId: request.operationId,
        requestHash: hash,
        scenario,
        cursor: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      options.storage.setItem(key, JSON.stringify(record));
      return { accepted: true, operationId: request.operationId, status: "RESERVED" };
    },
    async getStatus(operationId) {
      const key = recordKey(ownerId, operationId.toLowerCase());
      const record = parseRecord(options.storage.getItem(key));
      if (!record || record.ownerId !== ownerId) {
        throw new MusicGenerationProductError("OPERATION_NOT_FOUND", "找不到该生成任务。");
      }
      const current = safeStatus(record);
      const states = sequence(record.scenario);
      if (record.cursor < states.length - 1) {
        record.cursor += 1;
        record.updatedAt = now().toISOString();
        options.storage.setItem(key, JSON.stringify(record));
      }
      return current;
    },
    async getCompletedTrack(trackId): Promise<CompletedMusicPlayback> {
      if (trackId !== MOCK_TRACK_ID) {
        throw new MusicGenerationProductError("TRACK_UNAVAILABLE", "本地测试歌曲不存在。");
      }
      return {
        trackId,
        title: "C2A 本地异步生成示例",
        artist: "MedClip 本地测试素材",
        durationSeconds: 0.00025,
        src: MOCK_AUDIO_FIXTURE,
        source: "local_test_fixture",
      };
    },
  };
}
