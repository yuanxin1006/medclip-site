import { SafeTaskError } from "./errors.ts";
import {
  type MusicGenerationOperation,
  type MusicOperationRepository,
  MUSIC_OPERATION_STATES,
} from "./music-operation.ts";
import { requireAuthenticatedTaskUserId } from "./request.ts";

export const MUSIC_OPERATION_STATUS_ACTION = "music.operation_status" as const;

export type MusicOperationStatusRequest = {
  action: typeof MUSIC_OPERATION_STATUS_ACTION;
  operationId: string;
};

export type SafeMusicOperationStatus = {
  operationId: string;
  status: typeof MUSIC_OPERATION_STATES[number];
  createdAt: string;
  updatedAt: string;
  trackId?: string;
  safeErrorCode?: string;
};

const STATUS_REQUEST_FIELDS = new Set(["action", "operationId"]);
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isMusicOperationStatusEnvelope(value: unknown): boolean {
  return plainRecord(value) && Object.hasOwn(value, "action");
}

export function parseMusicOperationStatusRequest(value: unknown): MusicOperationStatusRequest {
  if (
    !plainRecord(value)
    || Object.keys(value).some((key) => !STATUS_REQUEST_FIELDS.has(key))
    || value.action !== MUSIC_OPERATION_STATUS_ACTION
    || typeof value.operationId !== "string"
    || !OPERATION_ID_PATTERN.test(value.operationId)
  ) {
    throw new SafeTaskError("INVALID_INPUT", "歌曲生成状态请求无效。", 400);
  }
  return { action: MUSIC_OPERATION_STATUS_ACTION, operationId: value.operationId.toLowerCase() };
}

function safeOperation(operation: MusicGenerationOperation): SafeMusicOperationStatus {
  const safeErrorCode = operation.failureCode && SAFE_ERROR_CODE.test(operation.failureCode)
    ? operation.failureCode
    : undefined;
  return {
    operationId: operation.operationId,
    status: operation.state,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.state === "COMPLETED" && operation.finalTrackId
      ? { trackId: operation.finalTrackId }
      : {}),
    ...((operation.state === "FAILED" || operation.state === "UNKNOWN") && safeErrorCode
      ? { safeErrorCode }
      : {}),
  };
}

export async function getOwnSafeMusicOperationStatus(
  authenticatedUserId: string,
  request: MusicOperationStatusRequest,
  repository: MusicOperationRepository,
): Promise<SafeMusicOperationStatus> {
  const userId = requireAuthenticatedTaskUserId(authenticatedUserId);
  const operation = await repository.load(userId, request.operationId);
  if (!operation || operation.userId !== userId) {
    throw new SafeTaskError("OPERATION_NOT_FOUND", "找不到该歌曲生成任务。", 404);
  }
  return safeOperation(operation);
}
