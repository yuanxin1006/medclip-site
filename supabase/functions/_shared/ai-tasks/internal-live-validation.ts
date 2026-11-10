import { SafeTaskError } from "./errors.ts";
import type { ParsedAITaskRequest } from "./types.ts";

export const INTERNAL_LIVE_VALIDATION_HEADER = "x-medclip-internal-live-validation";
export const INTERNAL_LIVE_VALIDATION_MAX_AGE_MS = 5 * 60 * 1000;
const INTERNAL_LIVE_VALIDATION_VERSION = "v1";
const INTERNAL_LIVE_VALIDATION_DERIVATION_LABEL = "medclip-c1d-tokenhub-live-validation-v1";
const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

function proofMessage(userId: string, request: ParsedAITaskRequest, timestampMs: number): string {
  return [
    INTERNAL_LIVE_VALIDATION_VERSION,
    String(timestampMs),
    userId,
    JSON.stringify(canonicalValue(request)),
  ].join("\n");
}

async function hmacSignature(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64Url(new Uint8Array(signature));
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function internalValidationError(): never {
  throw new SafeTaskError("UNAUTHENTICATED", "Internal validation authorization is invalid.", 401);
}

export async function deriveInternalLiveValidationSecret(operatorPassword: string): Promise<string> {
  if (typeof operatorPassword !== "string" || operatorPassword.length < 12) internalValidationError();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${INTERNAL_LIVE_VALIDATION_DERIVATION_LABEL}\0${operatorPassword}`),
  );
  return base64Url(new Uint8Array(digest));
}

export async function createInternalLiveValidationProof(input: {
  secret: string;
  userId: string;
  request: ParsedAITaskRequest;
  timestampMs?: number;
}): Promise<string> {
  const timestampMs = input.timestampMs ?? Date.now();
  if (!Number.isSafeInteger(timestampMs) || input.secret.length < 32) internalValidationError();
  const signature = await hmacSignature(
    input.secret,
    proofMessage(input.userId, input.request, timestampMs),
  );
  return `${INTERNAL_LIVE_VALIDATION_VERSION}.${timestampMs}.${signature}`;
}

async function verifyInternalProof(input: {
  proof: string | null;
  secret: string | undefined;
  userId: string;
  request: ParsedAITaskRequest;
  nowMs?: number;
}): Promise<boolean> {
  if (input.proof === null) return false;
  if (!input.secret || input.secret.length < 32) internalValidationError();

  const match = /^v1\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(input.proof);
  if (!match) internalValidationError();
  const timestampMs = Number(match[1]);
  const nowMs = input.nowMs ?? Date.now();
  if (
    !Number.isSafeInteger(timestampMs)
    || !Number.isSafeInteger(nowMs)
    || timestampMs > nowMs + 30_000
    || nowMs - timestampMs > INTERNAL_LIVE_VALIDATION_MAX_AGE_MS
  ) internalValidationError();

  const expected = await hmacSignature(
    input.secret,
    proofMessage(input.userId, input.request, timestampMs),
  );
  if (!constantTimeEqual(match[2], expected)) internalValidationError();
  return true;
}

export async function authorizeInternalLiveValidation(input: {
  proof: string | null;
  secret: string | undefined;
  userId: string;
  request: ParsedAITaskRequest;
  nowMs?: number;
}): Promise<boolean> {
  if (input.proof === null) return false;
  if (
    input.request.provider !== "tencent_tokenhub"
    || input.request.task !== "music.generate"
  ) internalValidationError();
  return await verifyInternalProof(input);
}

export async function authorizeInternalTextTaskFixture(input: {
  proof: string | null;
  secret: string | undefined;
  userId: string;
  request: ParsedAITaskRequest;
  nowMs?: number;
}): Promise<boolean> {
  if (
    input.request.provider !== "deepseek"
    || input.request.task !== "editor.requirements_parse"
  ) internalValidationError();
  return await verifyInternalProof(input);
}
