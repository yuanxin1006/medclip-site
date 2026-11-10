import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SafeTaskError } from "../../supabase/functions/_shared/ai-tasks/errors.ts";
import {
  normalizeMusicProviderFailureDiagnostics,
  parseMusicProviderFailureDiagnostics,
  type MusicProviderFailureDiagnostics,
} from "../../supabase/functions/_shared/ai-tasks/music-failure-diagnostics.ts";
import type { MusicFinalizationRepository } from "../../supabase/functions/_shared/ai-tasks/music-finalization.ts";
import {
  MusicOperationError,
  type MusicGenerationOperation,
  type MusicOperationRepository,
  type MusicOperationTransitionInput,
  type ReserveMusicOperationInput,
} from "../../supabase/functions/_shared/ai-tasks/music-operation.ts";
import { getOwnSafeMusicOperationStatus } from "../../supabase/functions/_shared/ai-tasks/music-product-status.ts";
import { executeMusicGenerationRequest } from "../../supabase/functions/_shared/ai-tasks/music-service.ts";
import {
  createTencentTokenHubMusicExecutor,
  TOKENHUB_MUSIC_MODEL,
} from "../../supabase/functions/_shared/ai-tasks/providers/tencent-tokenhub-music.ts";
import type { ParsedAITaskRequest } from "../../supabase/functions/_shared/ai-tasks/types.ts";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const TIMEOUT_MS = 120_000;
const FAKE_KEY = "provider-free-fixture-key";

class MemoryOperations implements MusicOperationRepository {
  readonly rows = new Map<string, MusicGenerationOperation>();
  readonly transitions: MusicOperationTransitionInput[] = [];
  rejectNextTransition = false;

  private key(userId: string, operationId: string) {
    return `${userId}:${operationId}`;
  }

  async reserve(input: ReserveMusicOperationInput) {
    const key = this.key(input.userId, input.operationId);
    const existing = this.rows.get(key);
    if (existing) return { operation: existing, created: false };
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
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
    };
    this.rows.set(key, operation);
    return { operation, created: true };
  }

  async load(userId: string, operationId: string) {
    return this.rows.get(this.key(userId, operationId)) ?? null;
  }

  async transition(input: MusicOperationTransitionInput) {
    const key = this.key(input.userId, input.operationId);
    const current = this.rows.get(key);
    if (!current || current.state !== input.expectedState || this.rejectNextTransition) {
      this.rejectNextTransition = false;
      throw new MusicOperationError("OPERATION_TRANSITION_CONFLICT", "fixture conflict");
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
      updatedAt: "2026-10-11T00:00:01.000Z",
    };
    this.transitions.push(structuredClone(input));
    this.rows.set(key, next);
    return next;
  }
}

class MemoryTracks implements MusicFinalizationRepository {
  async createDraft(input: { userId: string }) {
    return { id: randomUUID(), userId: input.userId, published: false as const };
  }
  async uploadAudio() {}
  async finalizeDraft() {}
  async deleteAudio() {}
  async deleteDraft() {}
}

function request(operationId = randomUUID()): ParsedAITaskRequest {
  return {
    task: "music.generate",
    provider: "tencent_tokenhub",
    input: {
      operationId,
      mode: "custom_lyrics",
      lyrics: "provider-free fixture",
      title: "fixture",
    },
  };
}

type Fixture = {
  name: string;
  response?: () => Response;
  rejection?: () => Error;
  expectedState: "FAILED" | "UNKNOWN";
  expectedClass: MusicProviderFailureDiagnostics["providerErrorClass"];
  expectedResponseClass: MusicProviderFailureDiagnostics["providerResponseClassification"];
  expectedStatus?: number;
  expectedCode?: string;
  jsonParseable: boolean;
};

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const fixtures: Fixture[] = [
  { name: "HTTP 401 JSON", response: json(401, { error: { code: "401007", message: "not stored" } }), expectedState: "FAILED", expectedClass: "POSTPAY_NOT_ENABLED", expectedResponseClass: "HTTP_ERROR_JSON", expectedStatus: 401, expectedCode: "401007", jsonParseable: true },
  { name: "HTTP 402 JSON", response: json(402, { error: { code: "401008", message: "not stored" } }), expectedState: "FAILED", expectedClass: "QUOTA_EXHAUSTED", expectedResponseClass: "HTTP_ERROR_JSON", expectedStatus: 402, expectedCode: "401008", jsonParseable: true },
  { name: "HTTP 403 JSON", response: json(403, { error: { code: "403004", message: "not stored" } }), expectedState: "FAILED", expectedClass: "INSUFFICIENT_BALANCE", expectedResponseClass: "HTTP_ERROR_JSON", expectedStatus: 403, expectedCode: "403004", jsonParseable: true },
  { name: "HTTP 429 JSON", response: json(429, { error: { code: "429001", message: "not stored" } }), expectedState: "FAILED", expectedClass: "RATE_LIMIT", expectedResponseClass: "HTTP_ERROR_JSON", expectedStatus: 429, expectedCode: "429001", jsonParseable: true },
  { name: "HTTP 500 JSON", response: json(500, { error: { code: "502001", message: "not stored" } }), expectedState: "FAILED", expectedClass: "UPSTREAM_ERROR", expectedResponseClass: "HTTP_ERROR_JSON", expectedStatus: 500, expectedCode: "502001", jsonParseable: true },
  { name: "HTTP 502 non-JSON", response: () => new Response("<html>upstream</html>", { status: 502, headers: { "Content-Type": "text/html" } }), expectedState: "FAILED", expectedClass: "UPSTREAM_ERROR", expectedResponseClass: "HTTP_ERROR_NON_JSON", expectedStatus: 502, jsonParseable: false },
  { name: "business error", response: json(200, { base_resp: { status_code: 1008, status_msg: "not stored" }, data: {} }), expectedState: "FAILED", expectedClass: "INSUFFICIENT_BALANCE", expectedResponseClass: "BUSINESS_ERROR", expectedStatus: 200, expectedCode: "1008", jsonParseable: true },
  { name: "malformed response", response: () => new Response("{", { status: 200 }), expectedState: "FAILED", expectedClass: "MALFORMED_JSON", expectedResponseClass: "MALFORMED_JSON", expectedStatus: 200, jsonParseable: false },
  { name: "schema mismatch", response: json(200, { base_resp: { status_code: 0 }, data: { status: 2 } }), expectedState: "FAILED", expectedClass: "SUCCESS_SCHEMA_MISMATCH", expectedResponseClass: "SUCCESS_SCHEMA_MISMATCH", expectedStatus: 200, jsonParseable: true },
  { name: "not completed", response: json(200, { base_resp: { status_code: 0 }, data: { status: 1, audio: "00" } }), expectedState: "FAILED", expectedClass: "NOT_COMPLETED", expectedResponseClass: "NOT_COMPLETED", expectedStatus: 200, jsonParseable: true },
  { name: "network rejection", rejection: () => new Error("provider-free network fixture"), expectedState: "UNKNOWN", expectedClass: "NETWORK_ERROR", expectedResponseClass: "NO_RESPONSE", jsonParseable: false },
  { name: "timeout", rejection: () => Object.assign(new Error("provider-free timeout fixture"), { name: "AbortError" }), expectedState: "UNKNOWN", expectedClass: "TIMEOUT", expectedResponseClass: "NO_RESPONSE", jsonParseable: false },
  { name: "empty body", response: () => new Response("", { status: 200 }), expectedState: "FAILED", expectedClass: "MALFORMED_JSON", expectedResponseClass: "MALFORMED_JSON", expectedStatus: 200, jsonParseable: false },
  { name: "unknown code", response: json(418, { error: { code: "UNKNOWN_777", message: "not stored" } }), expectedState: "FAILED", expectedClass: "UNKNOWN", expectedResponseClass: "HTTP_ERROR_JSON", expectedStatus: 418, expectedCode: "UNKNOWN_777", jsonParseable: true },
];

for (const fixture of fixtures) {
  test(`structured diagnostics persist ${fixture.name} without public leakage`, async () => {
    let providerCalls = 0;
    const operations = new MemoryOperations();
    const parsed = request();
    const fetcher: typeof fetch = async () => {
      providerCalls += 1;
      if (fixture.rejection) throw fixture.rejection();
      return fixture.response!();
    };
    await assert.rejects(() => executeMusicGenerationRequest(
      USER_A,
      parsed,
      FAKE_KEY,
      TOKENHUB_MUSIC_MODEL,
      TIMEOUT_MS,
      { credentialLookupDecryptMs: 0, requestStartedAtMs: 0 },
      {
        operations,
        tracks: new MemoryTracks(),
        executeMusic: createTencentTokenHubMusicExecutor({ fetcher }),
      },
    ));
    assert.equal(providerCalls, 1);
    const operation = await operations.load(USER_A, parsed.input.operationId as string);
    assert.equal(operation?.state, fixture.expectedState);
    assert.equal(operation?.providerCallCount, 1);
    const diagnostic = operation?.failureDiagnostics;
    assert.ok(diagnostic);
    assert.equal(diagnostic.providerResponseReceived, fixture.expectedStatus !== undefined);
    assert.equal(diagnostic.providerHttpStatus, fixture.expectedStatus);
    assert.equal(diagnostic.providerErrorCode, fixture.expectedCode);
    assert.equal(diagnostic.providerErrorClass, fixture.expectedClass);
    assert.equal(diagnostic.providerResponseClassification, fixture.expectedResponseClass);
    assert.equal(diagnostic.providerResponseJsonParseable, fixture.jsonParseable);
    assert.ok(diagnostic.providerRequestDurationMs >= 0);
    assert.equal(diagnostic.requestShape?.inputMode, "custom_lyrics");
    assert.equal(diagnostic.requestShape?.fields.model.type, "string");
    assert.equal(diagnostic.requestShape?.fields.model.enumValid, true);
    assert.equal(diagnostic.requestShape?.fields.prompt.present, false);
    assert.equal(diagnostic.requestShape?.fields.lyrics.type, "string");
    assert.equal(diagnostic.requestShape?.fields.lyrics.length, "provider-free fixture".length);
    assert.equal(diagnostic.requestShape?.fields.lyrics.valid, true);
    assert.equal(diagnostic.requestShape?.audioSettingFields.format.enumValid, true);
    const serialized = JSON.stringify(diagnostic);
    assert.doesNotMatch(serialized, /not stored|provider-free-fixture-key|authorization|<html>/i);

    const publicStatus = await getOwnSafeMusicOperationStatus(
      USER_A,
      { action: "music.operation_status", operationId: parsed.input.operationId as string },
      operations,
    );
    assert.equal("failureDiagnostics" in publicStatus, false);
    assert.equal("providerHttpStatus" in publicStatus, false);
    await assert.rejects(() => getOwnSafeMusicOperationStatus(
      USER_B,
      { action: "music.operation_status", operationId: parsed.input.operationId as string },
      operations,
    ));
  });
}

test("normal success completes with no failure diagnostics", async () => {
  const operations = new MemoryOperations();
  const parsed = request();
  let calls = 0;
  const audio = "fffb906400000000";
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      base_resp: { status_code: 0, status_msg: "success" },
      data: { status: 2, audio },
      extra_info: { music_size: 8 },
    }), { status: 200 });
  };
  const result = await executeMusicGenerationRequest(
    USER_A,
    parsed,
    FAKE_KEY,
    TOKENHUB_MUSIC_MODEL,
    TIMEOUT_MS,
    { credentialLookupDecryptMs: 0, requestStartedAtMs: 0 },
    {
      operations,
      tracks: new MemoryTracks(),
      executeMusic: createTencentTokenHubMusicExecutor({ fetcher }),
    },
  );
  const operation = await operations.load(USER_A, parsed.input.operationId as string);
  assert.equal(calls, 1);
  assert.equal(operation?.state, "COMPLETED");
  assert.equal(operation?.failureDiagnostics, null);
  assert.equal((result.metadata as Record<string, unknown>).generationOccurred, true);
});

test("business diagnostics retain safe provider identifiers without status-message or prompt leakage", async () => {
  const operations = new MemoryOperations();
  const parsed = request();
  let caught: unknown;
  try {
    await executeMusicGenerationRequest(
      USER_A,
      parsed,
      FAKE_KEY,
      TOKENHUB_MUSIC_MODEL,
      TIMEOUT_MS,
      { credentialLookupDecryptMs: 0, requestStartedAtMs: 0 },
      {
        operations,
        tracks: new MemoryTracks(),
        executeMusic: createTencentTokenHubMusicExecutor({
          fetcher: async () => new Response(JSON.stringify({
            base_resp: {
              status_code: 2013,
              status_msg: `invalid request provider-free fixture ${FAKE_KEY}`,
            },
            request_id: "req_music_fixture_2013",
            trace_id: "trace_music_fixture_2013",
            data: {},
          }), { status: 200 }),
        }),
      },
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SafeTaskError);
  assert.equal(caught.diagnostic?.minimaxBaseStatusCode, 2013);
  assert.doesNotMatch(caught.diagnostic?.minimaxBaseStatusMessage ?? "", /provider-free fixture|provider-free-fixture-key/i);
  const operation = await operations.load(USER_A, parsed.input.operationId as string);
  assert.equal(operation?.providerRequestId, "req_music_fixture_2013");
  assert.equal(operation?.providerTraceId, "trace_music_fixture_2013");
  assert.equal(operation?.failureDiagnostics?.providerErrorCode, "2013");
  assert.equal(operation?.failureDiagnostics?.providerRequestId, "req_music_fixture_2013");
  assert.equal(operation?.failureDiagnostics?.providerTraceId, "trace_music_fixture_2013");
  const serialized = JSON.stringify(operation?.failureDiagnostics);
  assert.doesNotMatch(serialized, /provider-free fixture|provider-free-fixture-key|status_msg/i);
  assert.match(serialized, /"lyrics"/);
  assert.match(serialized, /"prompt"/);
});

test("diagnostic transition is atomic when the repository rejects it", async () => {
  const operations = new MemoryOperations();
  const parsed = request();
  const fetcher: typeof fetch = async () => new Response("{", { status: 200 });
  const originalTransition = operations.transition.bind(operations);
  operations.transition = async (input) => {
    if (input.nextState === "FAILED" || input.nextState === "UNKNOWN") {
      throw new MusicOperationError("OPERATION_TRANSITION_CONFLICT", "fixture transition failure");
    }
    return originalTransition(input);
  };
  await assert.rejects(() => executeMusicGenerationRequest(
    USER_A,
    parsed,
    FAKE_KEY,
    TOKENHUB_MUSIC_MODEL,
    TIMEOUT_MS,
    { credentialLookupDecryptMs: 0, requestStartedAtMs: 0 },
    {
      operations,
      tracks: new MemoryTracks(),
      executeMusic: createTencentTokenHubMusicExecutor({ fetcher }),
    },
  ));
  const operation = await operations.load(USER_A, parsed.input.operationId as string);
  assert.equal(operation?.state, "PROVIDER_IN_FLIGHT");
  assert.equal(operation?.failureCode, null);
  assert.equal(operation?.failureDiagnostics, null);
});

test("canonical diagnostic parser rejects arbitrary keys, wrong types, and oversized values", () => {
  const valid = {
    provider_response_received: true,
    provider_http_status: 502,
    provider_error_code: "502001",
    provider_error_class: "HTTP_ERROR",
    provider_failure_stage: "HTTP_VALIDATED",
    provider_response_classification: "HTTP_ERROR_JSON",
    provider_response_json_parseable: true,
    provider_request_duration_ms: 1837,
  };
  assert.equal(parseMusicProviderFailureDiagnostics(valid)?.providerHttpStatus, 502);
  assert.throws(() => parseMusicProviderFailureDiagnostics({ ...valid, raw_response: "secret" }));
  assert.throws(() => parseMusicProviderFailureDiagnostics({ ...valid, provider_http_status: "502" }));
  assert.throws(() => parseMusicProviderFailureDiagnostics({ ...valid, provider_error_code: "x".repeat(65) }));
  assert.throws(() => normalizeMusicProviderFailureDiagnostics({
    providerResponseReceived: false,
    providerErrorClass: "TIMEOUT",
    providerFailureStage: "FETCH_DISPATCHED",
    providerResponseClassification: "NO_RESPONSE",
    providerResponseJsonParseable: false,
    providerRequestDurationMs: 300_001,
  }));
});

test("request-shape diagnostics accept only typed, bounded, allowlisted fields", () => {
  const field = (type: string, valid: boolean, options: Record<string, unknown> = {}) => ({
    present: type !== "missing",
    type,
    valid,
    ...options,
  });
  const requestShape = {
    input_mode: "custom_lyrics",
    fields: {
      model: field("string", true, { length: 20, enum_valid: true }),
      output_format: field("string", true, { length: 3, enum_valid: true }),
      audio_setting: field("object", true),
      prompt: field("missing", true),
      lyrics: field("string", true, { length: 22 }),
      is_instrumental: field("boolean", true, { enum_valid: true }),
    },
    audio_setting_fields: {
      sample_rate: field("number", true, { enum_valid: true }),
      bitrate: field("number", true, { enum_valid: true }),
      format: field("string", true, { length: 3, enum_valid: true }),
    },
  };
  const parsed = parseMusicProviderFailureDiagnostics({
    provider_response_received: true,
    provider_http_status: 200,
    provider_error_code: "2013",
    provider_request_id: "req_fixture",
    provider_trace_id: "trace_fixture",
    provider_error_class: "INVALID_REQUEST",
    provider_failure_stage: "BUSINESS_STATUS_CHECKED",
    provider_response_classification: "BUSINESS_ERROR",
    provider_response_json_parseable: true,
    provider_request_duration_ms: 12,
    request_shape: requestShape,
  });
  assert.equal(parsed?.providerRequestId, "req_fixture");
  assert.equal(parsed?.requestShape?.fields.lyrics.length, 22);
  assert.throws(() => parseMusicProviderFailureDiagnostics({
    provider_response_received: true,
    provider_error_class: "INVALID_REQUEST",
    provider_failure_stage: "BUSINESS_STATUS_CHECKED",
    provider_response_classification: "BUSINESS_ERROR",
    provider_response_json_parseable: true,
    provider_request_duration_ms: 12,
    request_shape: { ...requestShape, raw_prompt: "secret" },
  }));
});

test("request-shape migration keeps diagnostics service-only and value-free", () => {
  const source = readFileSync(
    new URL("../../supabase/migrations/010_music_generation_failure_request_diagnostics.sql", import.meta.url),
    "utf8",
  );
  assert.match(source, /create or replace function medclip_private\.is_valid_music_failure_diagnostics/i);
  assert.match(source, /provider_request_id/);
  assert.match(source, /provider_trace_id/);
  assert.match(source, /request_shape/);
  assert.match(source, /audio_setting_fields/);
  assert.match(source, /revoke execute[\s\S]*from public, anon, authenticated/i);
  assert.match(source, /grant execute[\s\S]*to service_role/i);
  for (const forbidden of [
    "raw_provider_response", "raw_provider_message", "authorization", "api_key",
    "request_body", "stack_trace", "status_msg",
  ]) assert.doesNotMatch(source, new RegExp(`'${forbidden}'`, "i"));
});

test("migration adds one constrained service-only JSONB field and one atomic transition", () => {
  const source = readFileSync(
    new URL("../../supabase/migrations/008_music_generation_failure_diagnostics.sql", import.meta.url),
    "utf8",
  );
  assert.match(source, /add column if not exists failure_diagnostics jsonb/i);
  assert.match(source, /is_valid_music_failure_diagnostics\(failure_diagnostics\)/i);
  assert.match(source, /state = next_state,[\s\S]*failure_code = next_failure_code,[\s\S]*failure_diagnostics = case/i);
  assert.match(source, /revoke execute[\s\S]*from public, anon, authenticated/i);
  assert.match(source, /grant execute[\s\S]*to service_role/i);
  assert.doesNotMatch(source, /create\s+index[\s\S]*failure_diagnostics/i);
  const ledgerSource = readFileSync(
    new URL("../../supabase/migrations/007_music_generation_operations.sql", import.meta.url),
    "utf8",
  );
  assert.match(ledgerSource, /revoke all on schema medclip_private from public, anon, authenticated/i);
  assert.match(ledgerSource, /revoke all on table medclip_private\.music_generation_operations from public, anon, authenticated/i);
  assert.match(ledgerSource, /grant select, insert, update on table medclip_private\.music_generation_operations to service_role/i);
  assert.match(source, /next_failure_diagnostics jsonb default null/i);
  assert.match(source, /failure_diagnostics = case[\s\S]*when next_state in \('FAILED', 'UNKNOWN'\)/i);
  for (const forbidden of [
    "raw_provider_response", "raw_provider_message", "authorization", "api_key",
    "lyrics", "prompt", "audio_url", "request_body", "stack_trace",
  ]) assert.doesNotMatch(source, new RegExp(`'${forbidden}'`, "i"));
});
