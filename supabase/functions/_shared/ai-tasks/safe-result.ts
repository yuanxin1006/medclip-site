import { SafeTaskError } from "./errors.ts";
import type { AITaskResultValue } from "./types.ts";

export const SAFE_RESULT_MAX_DEPTH = 8;
export const SAFE_RESULT_MAX_ARRAY_LENGTH = 100;
export const SAFE_RESULT_MAX_OBJECT_KEYS = 64;
export const SAFE_RESULT_MAX_STRING_LENGTH = 10_000;
export const SAFE_RESULT_MAX_SERIALIZED_BYTES = 64 * 1024;

const FORBIDDEN_RESULT_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "ciphertext",
  "iv",
  "encryption_key",
  "encryptionkey",
  "raw_response",
  "rawresponse",
  "response_headers",
  "responseheaders",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "signed_url",
  "signedurl",
]);

function unsafeResult(message = "AI 任务结果格式无效。"): never {
  throw new SafeTaskError("INTERNAL_ERROR", message, 500);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copySafeValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): AITaskResultValue {
  if (depth > SAFE_RESULT_MAX_DEPTH) unsafeResult();
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length > SAFE_RESULT_MAX_STRING_LENGTH) unsafeResult();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) unsafeResult();
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value !== "object") unsafeResult();
  if (!isPlainObject(value) && !Array.isArray(value)) unsafeResult();
  if (ancestors.has(value)) unsafeResult();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > SAFE_RESULT_MAX_ARRAY_LENGTH) unsafeResult();
      return value.map((item) => copySafeValue(item, depth + 1, ancestors));
    }

    if (Object.getOwnPropertySymbols(value).length > 0) unsafeResult();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > SAFE_RESULT_MAX_OBJECT_KEYS) unsafeResult();

    const result: Record<string, AITaskResultValue> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) unsafeResult();
      if (FORBIDDEN_RESULT_KEYS.has(key.toLowerCase())) {
        unsafeResult("AI 任务结果无法安全返回。");
      }
      result[key] = copySafeValue(descriptor.value, depth + 1, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function safeResultData(
  data: Readonly<Record<string, AITaskResultValue>>,
): Record<string, AITaskResultValue> {
  const safe = copySafeValue(data, 0, new WeakSet<object>());
  if (!safe || typeof safe !== "object" || Array.isArray(safe)) unsafeResult();
  const serialized = JSON.stringify(safe);
  if (new TextEncoder().encode(serialized).byteLength > SAFE_RESULT_MAX_SERIALIZED_BYTES) {
    unsafeResult();
  }
  return safe as Record<string, AITaskResultValue>;
}
