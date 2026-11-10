import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AI_PROVIDER_DEFINITIONS } from "./providers.ts";
import {
  DOUBAO_FIXED_TEXT_MODEL,
  isDoubaoAPIKeyResourceId,
} from "../../supabase/functions/_shared/doubao-policy.ts";
import {
  decryptCredential,
  encodeEncryptionKeyForTest,
  encryptCredential,
} from "../../supabase/functions/_shared/ai-credentials/crypto.ts";
import { PROVIDER_ADAPTERS, getProviderAdapter } from "../../supabase/functions/_shared/ai-credentials/providers/registry.ts";
import {
  DEFAULT_VALIDATION_TIMEOUT_MS,
  performFixedEndpointValidation,
} from "../../supabase/functions/_shared/ai-credentials/providers/openai-compatible.ts";
import {
  buildTokenHubCredentialValidationRequest,
  parseTokenHubModelAvailability,
  TENCENT_TOKENHUB_MUSIC_MODEL,
  TENCENT_TOKENHUB_VALIDATION_ENDPOINT,
} from "../../supabase/functions/_shared/ai-credentials/providers/tencent-tokenhub.ts";
import type {
  AIProviderId,
  ProviderAdapter,
  ProviderValidationResult,
} from "../../supabase/functions/_shared/ai-credentials/providers/types.ts";
import {
  parseCredentialRequest,
  requireAuthenticatedUserId,
  safeErrorResponse,
} from "../../supabase/functions/_shared/ai-credentials/request.ts";
import { resolveSupabaseRuntimeKeys } from "../../supabase/functions/_shared/ai-credentials/runtime-keys.ts";
import {
  executeCredentialRequest,
  type ConnectionMetadata,
  type CredentialRepository,
  type SaveCredentialInput,
  type SavedCredential,
} from "../../supabase/functions/_shared/ai-credentials/service.ts";

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const encryptionKey = encodeEncryptionKeyForTest(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const wrongEncryptionKey = encodeEncryptionKeyForTest(Uint8Array.from({ length: 32 }, (_, index) => 255 - index));
const providerOrder = ["deepseek", "kimi", "doubao", "tencent_tokenhub"];
const uiProviderOrder = ["deepseek", "kimi", "doubao", "tencent_tokenhub"];

function environment(values: Record<string, string | undefined>) {
  return (name: string) => values[name];
}

function successfulValidation(provider: AIProviderId): ProviderValidationResult {
  return {
    ok: true,
    provider,
    status: "VALID",
    message: "连接验证成功。",
    validatedAt: "2026-09-16T00:00:00.000Z",
  };
}

function fakeAdapter(provider: AIProviderId, observedKeys: string[] = []): ProviderAdapter {
  return {
    id: provider,
    displayName: provider,
    regionClass: "china-priority",
    baseURL: "https://fixed.example.invalid/v1",
    requiresResourceId: provider === "doubao",
    credentialRequirements: {
      apiKey: true,
      providerResourceId: provider === "doubao" ? "required" : "none",
    },
    futureCapabilities: [],
    async validateCredential(apiKey) {
      observedKeys.push(apiKey);
      return successfulValidation(provider);
    },
    sanitizeError: () => ({
      ok: false,
      provider,
      status: "PROVIDER_UNAVAILABLE",
      message: "服务商暂时不可用。",
      validatedAt: "2026-09-16T00:00:00.000Z",
    }),
  };
}

class MemoryCredentialRepository implements CredentialRepository {
  readonly metadata = new Map<string, ConnectionMetadata>();
  readonly secrets = new Map<string, SavedCredential>();
  saveCalls = 0;
  deleteCalls = 0;

  key(userId: string, provider: AIProviderId): string {
    return `${userId}:${provider}`;
  }

  async listConnections(userId: string): Promise<ConnectionMetadata[]> {
    return [...this.metadata.values()].filter((connection) => connection.user_id === userId);
  }

  async getConnection(userId: string, provider: AIProviderId): Promise<ConnectionMetadata | null> {
    return this.metadata.get(this.key(userId, provider)) ?? null;
  }

  async getSavedCredential(userId: string, provider: AIProviderId): Promise<SavedCredential | null> {
    return this.secrets.get(this.key(userId, provider)) ?? null;
  }

  async saveCredential(input: SaveCredentialInput): Promise<ConnectionMetadata> {
    this.saveCalls += 1;
    const key = this.key(input.userId, input.provider);
    const previous = this.metadata.get(key);
    const connection: ConnectionMetadata = {
      id: previous?.id ?? `00000000-0000-4000-8000-0000000000${10 + this.saveCalls}`,
      user_id: input.userId,
      provider: input.provider,
      provider_resource_id: input.providerResourceId,
      key_last4: input.keyLast4,
      status: "connected",
      last_validated_at: input.validatedAt,
      created_at: previous?.created_at ?? input.validatedAt,
      updated_at: input.validatedAt,
    };
    this.metadata.set(key, connection);
    this.secrets.set(key, {
      provider: input.provider,
      providerResourceId: input.providerResourceId,
      ciphertext: input.ciphertext,
      iv: input.iv,
      encryptionVersion: input.encryptionVersion,
    });
    return connection;
  }

  async setValidationState(
    userId: string,
    provider: AIProviderId,
    status: "connected" | "validation_failed",
    validatedAt: string,
  ): Promise<void> {
    const key = this.key(userId, provider);
    const current = this.metadata.get(key);
    if (current) this.metadata.set(key, { ...current, status, last_validated_at: validatedAt });
  }

  async deleteCredential(userId: string, provider: AIProviderId): Promise<void> {
    this.deleteCalls += 1;
    const key = this.key(userId, provider);
    this.secrets.delete(key);
    this.metadata.delete(key);
  }
}

test("provider registries contain the four scoped providers in fixed order", () => {
  assert.deepEqual(AI_PROVIDER_DEFINITIONS.map((provider) => provider.id), uiProviderOrder);
  assert.deepEqual(PROVIDER_ADAPTERS.map((provider) => provider.id), providerOrder);
  assert.deepEqual(PROVIDER_ADAPTERS.map((provider) => provider.baseURL), [
    "https://api.deepseek.com",
    "https://api.moonshot.cn/v1",
    "https://ark.cn-beijing.volces.com/api/v3",
    "https://tokenhub.tencentmaas.com",
  ]);
  assert.ok(PROVIDER_ADAPTERS.every((provider) => new URL(provider.baseURL).protocol === "https:"));
});

test("unknown providers and arbitrary endpoint fields are rejected", () => {
  assert.throws(() => getProviderAdapter("unknown"));
  assert.throws(() => parseCredentialRequest({ action: "test", mode: "transient", provider: "deepseek", apiKey: "valid-key-1234", baseURL: "https://evil.invalid" }));
  assert.throws(() => parseCredentialRequest({ action: "save", provider: "kimi", apiKey: "valid-key-1234", endpoint: "https://evil.invalid" }));
  for (const removedProvider of ["openai", "gemini"]) {
    assert.throws(() => getProviderAdapter(removedProvider));
    assert.throws(() => parseCredentialRequest({ action: "test", mode: "transient", provider: removedProvider, apiKey: "valid-key-1234" }));
  }
  assert.throws(() => parseCredentialRequest({
    action: "test",
    mode: "transient",
    provider: "doubao",
    apiKey: "valid-key-1234",
    providerResourceId: "apikey-20260917000000-test1",
    timeoutMs: 120_000,
  }));
});

test("unauthenticated identities and caller-supplied user IDs are rejected", () => {
  assert.throws(() => requireAuthenticatedUserId(null));
  assert.throws(() => parseCredentialRequest({ action: "delete", provider: "kimi", user_id: userB }));
  assert.equal(requireAuthenticatedUserId(userA), userA);
});

test("Doubao empty provider_resource_id is rejected", () => {
  for (const providerResourceId of [undefined, null, ""]) {
    assert.throws(() => parseCredentialRequest({
      action: "save",
      provider: "doubao",
      apiKey: "valid-key-1234",
      providerResourceId,
    }));
  }
});

test("Doubao API-Key Resource ID / ApikeyID is accepted", () => {
  const providerResourceId = "apikey-20260917000000-test1";
  assert.equal(isDoubaoAPIKeyResourceId(providerResourceId), true);
  const request = parseCredentialRequest({
    action: "save",
    provider: "doubao",
    apiKey: "valid-key-1234",
    providerResourceId,
  });
  assert.equal(request.providerResourceId, providerResourceId);
});

test("Doubao Model ID and Endpoint ID are rejected as API-Key Resource IDs", () => {
  for (const providerResourceId of [
    "doubao-seed-2-1-lite-260915",
    "ep-20260916-model-v1",
  ]) {
    assert.throws(() => parseCredentialRequest({
      action: "save",
      provider: "doubao",
      apiKey: "valid-key-1234",
      providerResourceId,
    }));
  }
});

test("Doubao URL provider_resource_id is rejected", () => {
  for (const providerResourceId of [
    "https://evil.invalid/v1",
    "http://evil.invalid/v1",
    "evil.invalid/path",
    "evil.invalid:443",
  ]) {
    assert.throws(() => parseCredentialRequest({
      action: "save",
      provider: "doubao",
      apiKey: "valid-key-1234",
      providerResourceId,
    }));
  }
});

test("non-Doubao non-NULL provider_resource_id is rejected", () => {
  assert.throws(() => parseCredentialRequest({
    action: "save",
    provider: "deepseek",
    apiKey: "valid-key-1234",
    providerResourceId: "ep-should-not-be-accepted",
  }));
  assert.throws(() => parseCredentialRequest({
    action: "save",
    provider: "tencent_tokenhub",
    apiKey: "valid-key-1234",
    providerResourceId: "resource-not-allowed",
  }));
});

test("TokenHub credential contract is API-Key-only and uses the fixed models endpoint", async () => {
  const adapter = getProviderAdapter("tencent_tokenhub");
  assert.equal(TENCENT_TOKENHUB_MUSIC_MODEL, "minimax-music-v2.6");
  assert.equal(adapter.requiresResourceId, false);
  assert.deepEqual(adapter.credentialRequirements, { apiKey: true, providerResourceId: "none" });
  const request = buildTokenHubCredentialValidationRequest();
  assert.equal(request.url, TENCENT_TOKENHUB_VALIDATION_ENDPOINT);
  assert.equal(request.url, "https://tokenhub.tencentmaas.com/v1/models");
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.body, undefined);

  const testKey = "fixture-tokenhub-key-not-real";
  let calls = 0;
  const result = await adapter.validateCredential(testKey, {}, async (input, init) => {
    calls += 1;
    assert.equal(String(input), TENCENT_TOKENHUB_VALIDATION_ENDPOINT);
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${testKey}`);
    return new Response(JSON.stringify({
      data: [{ id: TENCENT_TOKENHUB_MUSIC_MODEL, status: "online" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.match(result.message, /尚未证明付费生成权限/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(testKey));
});

test("TokenHub validation maps safe statuses without generation", async () => {
  const adapter = getProviderAdapter("tencent_tokenhub");
  for (const [httpStatus, expected] of [[401, "API_KEY_INVALID"], [403, "PROVIDER_CONFIGURATION_REQUIRED"], [429, "RATE_LIMITED"]] as const) {
    const result = await adapter.validateCredential("fixture-tokenhub-key-not-real", {}, async () => {
      return new Response("raw-provider-body", { status: httpStatus });
    });
    assert.equal(result.status, expected);
    assert.equal(result.diagnostic?.upstreamHttpStatus, httpStatus);
    assert.doesNotMatch(JSON.stringify(result), /raw-provider-body|fixture-tokenhub-key-not-real/);
  }
  const source = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/tencent-tokenhub.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /wand\/minimax-music\/generation|console\./);
});

test("TokenHub model list parser detects the fixed online music model", () => {
  assert.deepEqual(parseTokenHubModelAvailability({
    data: [{ id: TENCENT_TOKENHUB_MUSIC_MODEL, status: "online" }],
  }), { visible: true, online: true, status: "online" });
  assert.deepEqual(parseTokenHubModelAvailability({
    data: [{ id: TENCENT_TOKENHUB_MUSIC_MODEL, status: "offline" }],
  }), { visible: true, online: false, status: "not_online" });
  assert.deepEqual(parseTokenHubModelAvailability({ data: [] }), { visible: false, online: false, status: "unknown" });
});

test("TokenHub credential live verifier is one-call, generation-free, secret-safe, and cleanup guarded", () => {
  const verifier = readFileSync(
    new URL("../../scripts/verify-tokenhub-credential-live.mjs", import.meta.url),
    "utf8",
  );
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  assert.equal(
    packageJson.scripts?.["verify:tokenhub-credential-live"],
    "node --env-file-if-exists=.env.local scripts/verify-tokenhub-credential-live.mjs",
  );
  assert.match(verifier, /process\.env\.MEDCLIP_TEST_TOKENHUB_API_KEY/);
  assert.match(verifier, /action: "save"/);
  assert.match(verifier, /providerCalls = 1/);
  assert.match(verifier, /action: "delete"/);
  assert.match(verifier, /finally \{/);
  assert.match(verifier, /FINAL TOKENHUB TEST CREDENTIAL REMAINS = NO/);
  assert.match(verifier, /MUSIC GENERATION PROVIDER CALLS = 0/);
  assert.doesNotMatch(verifier, /wand\/minimax-music\/generation|music\.generate/);
  assert.doesNotMatch(
    verifier,
    /console\.(?:log|info|warn|error|debug)\([^\n]*(?:tokenHubAPIKey|key_last4|accessToken|password|anonKey)/,
  );
  assert.doesNotMatch(
    verifier,
    /process\.env\.(?:SUPABASE_SECRET_KEYS|SUPABASE_SERVICE_ROLE_KEY|MEDCLIP_CREDENTIAL_ENCRYPTION_KEY)/,
  );
});

test("Doubao resource copy identifies API-Key Resource ID without model or endpoint ambiguity", () => {
  const definition = AI_PROVIDER_DEFINITIONS.find((provider) => provider.id === "doubao");
  assert.ok(definition);
  assert.match(definition.description, /API Key/);
  assert.match(definition.description, /ApikeyID/);
  assert.equal(definition.resourceIdLabel, "API Key 资源 ID（ApikeyID）");

  const cardSource = readFileSync(
    new URL("../../components/ai/AIProviderCard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(cardSource, /placeholder="apikey-..."/);
  assert.match(cardSource, /不是 API Key、模型 ID 或推理接入点 ID/);
});

test("provider validation makes one controlled attempt and sanitizes upstream failures", async () => {
  let attempts = 0;
  const result = await performFixedEndpointValidation(
    "deepseek",
    "https://api.deepseek.com/models",
    "never-return-this-key",
    { method: "GET" },
    async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: "raw-provider-secret-detail" }), { status: 401 });
    },
  );
  assert.equal(attempts, 1);
  assert.equal(result.status, "API_KEY_INVALID");
  assert.equal(JSON.stringify(result).includes("raw-provider-secret-detail"), false);
  assert.equal(JSON.stringify(result).includes("never-return-this-key"), false);
});

test("default provider timeout remains 8000ms and only Doubao opts into 30000ms", () => {
  assert.equal(DEFAULT_VALIDATION_TIMEOUT_MS, 8_000);

  const transportSource = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/openai-compatible.ts", import.meta.url),
    "utf8",
  );
  const doubaoSource = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/doubao.ts", import.meta.url),
    "utf8",
  );
  const deepseekSource = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/deepseek.ts", import.meta.url),
    "utf8",
  );
  const kimiSource = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/kimi.ts", import.meta.url),
    "utf8",
  );

  assert.match(transportSource, /DEFAULT_VALIDATION_TIMEOUT_MS = 8_000/);
  assert.match(transportSource, /options\.timeoutMs \?\? DEFAULT_VALIDATION_TIMEOUT_MS/);
  assert.match(doubaoSource, /DOUBAO_VALIDATION_TIMEOUT_MS = 30_000/);
  assert.match(doubaoSource, /\{ timeoutMs: DOUBAO_VALIDATION_TIMEOUT_MS \}/);
  assert.doesNotMatch(deepseekSource, /timeoutMs|30_000/);
  assert.doesNotMatch(kimiSource, /timeoutMs|30_000/);
});

test("valid Doubao ApikeyID reaches one fixed-model credential validation request", async () => {
  const adapter = getProviderAdapter("doubao");
  const testKey = "unit-test-doubao-key-1234";
  const resourceId = "apikey-20260917000000-test1";
  let attempts = 0;
  let requestURL = "";
  let requestInit: RequestInit | undefined;

  const result = await adapter.validateCredential(
    testKey,
    { providerResourceId: resourceId },
    async (input, init) => {
      attempts += 1;
      requestURL = String(input);
      requestInit = init;
      return new Response("provider-body-must-not-be-returned", { status: 200 });
    },
  );

  assert.equal(result.ok, true);
  assert.equal(attempts, 1);
  assert.equal(requestURL, "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
  assert.equal(requestInit?.method, "POST");
  assert.equal(new Headers(requestInit?.headers).get("Authorization"), `Bearer ${testKey}`);
  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  assert.deepEqual(body, {
    model: DOUBAO_FIXED_TEXT_MODEL,
    messages: [{ role: "user", content: "Reply OK." }],
    thinking: { type: "disabled" },
    stream: false,
    max_tokens: 1,
  });
  assert.deepEqual(Object.keys(body), ["model", "messages", "thinking", "stream", "max_tokens"]);
  for (const forbiddenField of [
    "response_format",
    "json_schema",
    "strict",
    "frequency_penalty",
    "presence_penalty",
    "temperature",
    "top_p",
    "n",
    "stop",
    "max_completion_tokens",
    "reasoning_effort",
    "tools",
    "tool_choice",
  ]) {
    assert.equal(forbiddenField in body, false, `${forbiddenField} must not enter credential validation`);
  }
  assert.equal(JSON.stringify(result).includes(testKey), false);
  assert.equal(JSON.stringify(body).includes(resourceId), false);
  assert.equal(JSON.stringify(result).includes("provider-body-must-not-be-returned"), false);

  const adapterSource = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/doubao.ts", import.meta.url),
    "utf8",
  );
  const transportSource = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/openai-compatible.ts", import.meta.url),
    "utf8",
  );
  assert.match(adapterSource, /const baseURL = "https:\/\/ark\.cn-beijing\.volces\.com\/api\/v3"/);
  assert.match(adapterSource, /buildDoubaoCredentialValidationRequest/);
  assert.match(adapterSource, /performFixedEndpointValidation/);
  assert.doesNotMatch(adapterSource, /console\.(?:log|info|warn|error|debug)/);
  assert.doesNotMatch(transportSource, /console\.(?:log|info|warn|error|debug)/);
});

test("provider validation preserves bounded safe upstream diagnostics without changing public status", async () => {
  const leakedKey = "ark-this-provider-key-must-never-escape";
  const result = await performFixedEndpointValidation(
    "doubao",
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    leakedKey,
    { method: "POST", body: "{}" },
    async () => new Response(JSON.stringify({
      error: {
        code: "ModelNotOpen",
        message: `Model is not open. Authorization: Bearer ${leakedKey} ${"x".repeat(240)}`,
      },
    }), { status: 404 }),
  );

  assert.equal(result.status, "PROVIDER_CONFIGURATION_REQUIRED");
  assert.equal(result.diagnostic?.upstreamHttpStatus, 404);
  assert.equal(result.diagnostic?.upstreamProviderErrorCode, "ModelNotOpen");
  assert.ok(result.diagnostic?.sanitizedProviderErrorMessage);
  assert.ok(result.diagnostic.sanitizedProviderErrorMessage.length <= 160);
  assert.equal(JSON.stringify(result).includes(leakedKey), false);
  assert.equal(JSON.stringify(result).includes("Bearer ark-"), false);
});

test("Doubao save flow preserves ApikeyID metadata while validation uses the fixed model", async () => {
  const repository = new MemoryCredentialRepository();
  const baseAdapter = getProviderAdapter("doubao");
  const apiKey = "dummy-doubao-key-not-real";
  const providerResourceId = "apikey-test-example";
  let validatorResourceId: string | undefined;
  let validationBody: Record<string, unknown> = {};
  const adapter: ProviderAdapter = {
    ...baseAdapter,
    validateCredential(currentKey, configuration) {
      validatorResourceId = configuration.providerResourceId;
      return baseAdapter.validateCredential(currentKey, configuration, async (_input, init) => {
        validationBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("mocked-provider-response", { status: 200 });
      });
    },
  };
  const request = parseCredentialRequest({
    action: "save",
    provider: "doubao",
    apiKey,
    providerResourceId,
  });

  assert.equal(request.providerResourceId, providerResourceId);
  const saved = await executeCredentialRequest(userA, request, {
    repository,
    encryptionKey,
    getAdapter: () => adapter,
  });

  assert.equal(saved.ok, true);
  assert.equal((saved.validation as ProviderValidationResult).status, "VALID");
  assert.equal(validatorResourceId, providerResourceId);
  assert.equal((saved.connection as ConnectionMetadata).provider_resource_id, providerResourceId);
  assert.equal(validationBody?.model, DOUBAO_FIXED_TEXT_MODEL);
  assert.equal(validationBody?.model, "doubao-seed-2-1-lite-260915");
  assert.equal(JSON.stringify(validationBody).includes(providerResourceId), false);
  assert.equal(JSON.stringify(saved).includes(apiKey), false);
});

test("Doubao credential validation rejects Model ID and Endpoint ID metadata before Provider access", async () => {
  const adapter = getProviderAdapter("doubao");
  let attempts = 0;
  for (const providerResourceId of [
    "doubao-seed-2-1-lite-260915",
    "ep-20260916-model-v1",
  ]) {
    const result = await adapter.validateCredential(
      "unit-test-doubao-key-1234",
      { providerResourceId },
      async () => {
        attempts += 1;
        return new Response(null, { status: 200 });
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, "PROVIDER_CONFIGURATION_REQUIRED");
  }
  assert.equal(attempts, 0);
});

test("Doubao transient and saved modes preserve ApikeyID metadata and encrypted storage", async () => {
  const repository = new MemoryCredentialRepository();
  const observed: Array<{ apiKey: string; providerResourceId?: string }> = [];
  const adapter: ProviderAdapter = {
    ...fakeAdapter("doubao"),
    async validateCredential(apiKey, configuration) {
      observed.push({ apiKey, providerResourceId: configuration.providerResourceId });
      return successfulValidation("doubao");
    },
  };
  const resourceId = "apikey-20260917000000-test1";
  const transientKey = "transient-doubao-key-1234";
  const savedKey = "saved-doubao-key-5678";

  await executeCredentialRequest(userA, parseCredentialRequest({
    action: "test",
    mode: "transient",
    provider: "doubao",
    apiKey: transientKey,
    providerResourceId: resourceId,
  }), {
    repository,
    encryptionKey,
    getAdapter: () => adapter,
  });
  assert.equal(repository.saveCalls, 0);
  assert.equal(repository.metadata.size, 0);

  const savedResponse = await executeCredentialRequest(userA, parseCredentialRequest({
    action: "save",
    provider: "doubao",
    apiKey: savedKey,
    providerResourceId: resourceId,
  }), {
    repository,
    encryptionKey,
    getAdapter: () => adapter,
  });
  const stored = repository.secrets.get(repository.key(userA, "doubao"));
  assert.ok(stored);
  assert.equal(stored.providerResourceId, resourceId);
  assert.notEqual(stored.ciphertext, savedKey);
  assert.equal(JSON.stringify(savedResponse).includes(savedKey), false);

  await executeCredentialRequest(userA, parseCredentialRequest({
    action: "test",
    mode: "saved",
    provider: "doubao",
  }), {
    repository,
    encryptionKey,
    getAdapter: () => adapter,
  });
  assert.deepEqual(observed, [
    { apiKey: transientKey, providerResourceId: resourceId },
    { apiKey: savedKey, providerResourceId: resourceId },
    { apiKey: savedKey, providerResourceId: resourceId },
  ]);
});

test("AES-256-GCM encrypts without plaintext and uses a fresh IV", async () => {
  const plaintext = "unit-test-secret-12345678";
  const first = await encryptCredential(plaintext, encryptionKey);
  const second = await encryptCredential(plaintext, encryptionKey);
  assert.notEqual(first.ciphertext, plaintext);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.iv, second.iv);
  assert.equal(await decryptCredential(first, encryptionKey), plaintext);
  await assert.rejects(() => decryptCredential(first, wrongEncryptionKey));
  await assert.rejects(() => encryptCredential(plaintext, "malformed"));
});

test("transient mode validates once and creates no stored credential", async () => {
  const repository = new MemoryCredentialRepository();
  const observedKeys: string[] = [];
  const request = parseCredentialRequest({ action: "test", mode: "transient", provider: "deepseek", apiKey: "transient-key-1234" });
  const response = await executeCredentialRequest(userA, request, {
    repository,
    encryptionKey,
    getAdapter: (provider) => fakeAdapter(provider, observedKeys),
  });
  assert.equal(response.ok, true);
  assert.equal(repository.saveCalls, 0);
  assert.equal(repository.metadata.size, 0);
  assert.deepEqual(observedKeys, ["transient-key-1234"]);
});

test("saved mode stores encrypted secret, exposes only last4, and never returns the key", async () => {
  const repository = new MemoryCredentialRepository();
  const plaintext = "saved-secret-key-9876";
  const request = parseCredentialRequest({ action: "save", provider: "deepseek", apiKey: plaintext });
  const response = await executeCredentialRequest(userA, request, {
    repository,
    encryptionKey,
    getAdapter: fakeAdapter,
  });
  const stored = repository.secrets.get(repository.key(userA, "deepseek"));
  const metadata = repository.metadata.get(repository.key(userA, "deepseek"));
  assert.ok(stored);
  assert.ok(metadata);
  assert.notEqual(stored.ciphertext, plaintext);
  assert.equal(metadata.key_last4, "9876");
  assert.equal(JSON.stringify(response).includes(plaintext), false);
  assert.equal("ciphertext" in (response.connection as object), false);
  assert.equal("iv" in (response.connection as object), false);
});

test("update replaces encrypted credential and saved testing decrypts only server-side", async () => {
  const repository = new MemoryCredentialRepository();
  const observedKeys: string[] = [];
  await executeCredentialRequest(userA, parseCredentialRequest({ action: "save", provider: "kimi", apiKey: "first-secret-key-1111" }), {
    repository,
    encryptionKey,
    getAdapter: (provider) => fakeAdapter(provider, observedKeys),
  });
  const first = repository.secrets.get(repository.key(userA, "kimi"));
  await executeCredentialRequest(userA, parseCredentialRequest({ action: "update", provider: "kimi", apiKey: "second-secret-key-2222" }), {
    repository,
    encryptionKey,
    getAdapter: (provider) => fakeAdapter(provider, observedKeys),
  });
  const second = repository.secrets.get(repository.key(userA, "kimi"));
  assert.ok(first && second);
  assert.notEqual(first.ciphertext, second.ciphertext);
  const response = await executeCredentialRequest(userA, parseCredentialRequest({ action: "test", mode: "saved", provider: "kimi" }), {
    repository,
    encryptionKey,
    getAdapter: (provider) => fakeAdapter(provider, observedKeys),
  });
  assert.equal(response.ok, true);
  assert.equal(observedKeys.at(-1), "second-secret-key-2222");
  assert.equal(JSON.stringify(response).includes("second-secret-key-2222"), false);
});

test("authenticated user cannot resolve another user's saved credential", async () => {
  const repository = new MemoryCredentialRepository();
  await executeCredentialRequest(userA, parseCredentialRequest({ action: "save", provider: "kimi", apiKey: "user-a-secret-key-1234" }), {
    repository,
    encryptionKey,
    getAdapter: fakeAdapter,
  });
  await assert.rejects(() => executeCredentialRequest(userB, parseCredentialRequest({ action: "test", mode: "saved", provider: "kimi" }), {
    repository,
    encryptionKey,
    getAdapter: fakeAdapter,
  }));
});

test("delete removes both encrypted secret and public metadata", async () => {
  const repository = new MemoryCredentialRepository();
  await executeCredentialRequest(userA, parseCredentialRequest({ action: "save", provider: "deepseek", apiKey: "delete-secret-key-1234" }), {
    repository,
    encryptionKey,
    getAdapter: fakeAdapter,
  });
  await executeCredentialRequest(userA, parseCredentialRequest({ action: "delete", provider: "deepseek" }), {
    repository,
    encryptionKey,
    getAdapter: fakeAdapter,
  });
  assert.equal(repository.secrets.size, 0);
  assert.equal(repository.metadata.size, 0);
  assert.equal(repository.deleteCalls, 1);
});

test("migration keeps secrets private and RPC execution server-only", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/004_ai_provider_byok.sql", import.meta.url), "utf8");
  assert.match(sql, /create table public\.user_ai_provider_connections/i);
  assert.match(sql, /create table medclip_private\.user_ai_credentials/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /using \(user_id = \(select auth\.uid\(\)\)\)/i);
  assert.match(sql, /revoke all on table medclip_private\.user_ai_credentials from public, anon, authenticated/i);
  assert.match(sql, /revoke all on table public\.user_ai_provider_connections from public, anon, authenticated/i);
  assert.match(sql, /grant select on table public\.user_ai_provider_connections to authenticated/i);
  assert.match(sql, /provider = 'doubao'[\s\S]*and provider_resource_id is not null[\s\S]*and provider_resource_id ~ '\^\[A-Za-z0-9\]/i);
  assert.match(sql, /security definer[\s\S]*set search_path = ''/i);
  assert.match(sql, /revoke execute[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /grant (select|insert|update|delete).*user_ai_credentials.*authenticated/i);
  assert.doesNotMatch(sql, /grant (insert|update|delete).*user_ai_provider_connections.*authenticated/i);
  assert.doesNotMatch(sql, /api_key/i);
});

test("three-provider scope migration is non-destructive and fail-closed", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/005_three_provider_scope.sql", import.meta.url), "utf8");
  assert.match(sql, /where provider in \('openai', 'gemini'\)/i);
  assert.match(sql, /raise exception 'Cannot narrow AI provider scope while legacy provider rows exist'/i);
  assert.match(sql, /check \(provider in \('deepseek', 'kimi', 'doubao'\)\)/i);
  assert.doesNotMatch(sql, /delete from|truncate/i);
});

test("migration 006 additively permits TokenHub without changing resource safety", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/006_tencent_tokenhub_provider.sql", import.meta.url), "utf8");
  const migration004 = readFileSync(new URL("../../supabase/migrations/004_ai_provider_byok.sql", import.meta.url), "utf8");
  assert.match(sql, /public\.user_ai_provider_connections/i);
  assert.match(sql, /medclip_private\.user_ai_credentials/i);
  assert.equal(sql.match(/'tencent_tokenhub'/g)?.length, 2);
  assert.match(sql, /check \(provider in \('deepseek', 'kimi', 'doubao', 'tencent_tokenhub'\)\)/i);
  assert.doesNotMatch(sql, /delete from|truncate|drop constraint user_ai_provider_connections_resource_safe|drop constraint user_ai_credentials_resource_safe/i);
  assert.match(migration004, /provider <> 'doubao'[\s\S]*provider_resource_id is null/i);
});

test("browser credential code has no persistent Web Storage path", () => {
  const files = [
    new URL("client.ts", import.meta.url),
    new URL("../../components/ai/AIProviderCard.tsx", import.meta.url),
    new URL("../../app/ai-services/page.tsx", import.meta.url),
  ];
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/i);
  assert.doesNotMatch(source, /NEXT_PUBLIC_MEDCLIP_CREDENTIAL/i);
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE/i);
});

test("Edge credential function uses new-key mode with mandatory handler auth", () => {
  const config = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf8");
  const denoConfig = JSON.parse(
    readFileSync(new URL("../../supabase/functions/deno.json", import.meta.url), "utf8"),
  ) as { imports?: Record<string, string> };
  const source = readFileSync(
    new URL("../../supabase/functions/ai-credentials/index.ts", import.meta.url),
    "utf8",
  );
  const environmentExample = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");

  assert.match(
    config,
    /\[functions\.ai-credentials\][\s\S]*?auth\.getUser\(\) enforces user auth in the handler[\s\S]*?verify_jwt\s*=\s*false[\s\S]*?import_map\s*=\s*"\.\/functions\/deno\.json"/,
  );
  assert.equal(config.match(/\[functions\.ai-credentials\]/g)?.length, 1);
  assert.equal(config.match(/^verify_jwt\s*=\s*false\s*$/gm)?.length, 2);
  assert.doesNotMatch(config, /^verify_jwt\s*=\s*true\s*$/gm);
  assert.equal(
    denoConfig.imports?.["@supabase/supabase-js"],
    "npm:@supabase/supabase-js@2.116.0",
  );

  assert.match(source, /req\.headers\.get\("Authorization"\)/);
  assert.match(source, /if \(!authorization\?\.startsWith\("Bearer "\)\) return requireAuthenticatedUserId\(null\)/);
  assert.match(source, /auth\.getUser\(\)/);
  assert.match(source, /filter\(\(row\) => isProviderId\(row\.provider\)\)/);
  assert.match(source, /if \(error \|\| !data\.user\) return requireAuthenticatedUserId\(null\)/);
  assert.match(source, /return requireAuthenticatedUserId\(data\.user\.id\)/);
  const userAuthentication = source.indexOf("const userId = await authenticatedUserId(");
  const adminClientCreation = source.indexOf("const serviceClient = createClient<BYOKDatabase>(");
  assert.ok(userAuthentication >= 0);
  assert.ok(adminClientCreation > userAuthentication);
  assert.match(source, /MEDCLIP_ALLOWED_ORIGINS/);
  assert.match(source, /allowedOrigins\.includes\(origin\)/);
  assert.doesNotMatch(source, /"Access-Control-Allow-Origin"\s*:\s*"\*"/);
  for (const header of [
    "authorization",
    "x-client-info",
    "apikey",
    "content-type",
    "x-retry-count",
    "traceparent",
    "tracestate",
    "baggage",
  ]) {
    assert.match(source, new RegExp(`Access-Control-Allow-Headers[^\\n]+${header}`));
  }
  assert.match(source, /"Cache-Control"\s*:\s*"no-store"/);
  assert.match(source, /Vary\s*:\s*"Origin"/);

  assert.doesNotMatch(environmentExample, /^SUPABASE_(?:URL|ANON_KEY|SERVICE_ROLE_KEY)\s*=/m);
  assert.doesNotMatch(environmentExample, /NEXT_PUBLIC_MEDCLIP_CREDENTIAL_ENCRYPTION_KEY/);
});

test("missing or invalid handler identity cannot reach credential operations", () => {
  assert.throws(() => requireAuthenticatedUserId(null));
  assert.throws(() => requireAuthenticatedUserId(undefined));
  assert.throws(() => parseCredentialRequest({ action: "list", user_id: userB }));

  const source = readFileSync(
    new URL("../../supabase/functions/ai-credentials/index.ts", import.meta.url),
    "utf8",
  );
  const missingBearerRejection = source.indexOf(
    "if (!authorization?.startsWith(\"Bearer \")) return requireAuthenticatedUserId(null)",
  );
  const getUserCall = source.indexOf("await authClient.auth.getUser()");
  const invalidUserRejection = source.indexOf(
    "if (error || !data.user) return requireAuthenticatedUserId(null)",
  );
  const verifiedUserId = source.indexOf("return requireAuthenticatedUserId(data.user.id)");
  const handlerAuthentication = source.indexOf("const userId = await authenticatedUserId(");
  const requestParsing = source.indexOf("const request = parseCredentialRequest(rawRequest)");
  const adminClientCreation = source.indexOf("const serviceClient = createClient<BYOKDatabase>(");
  const credentialExecution = source.indexOf("await executeCredentialRequest(userId, request");

  assert.ok(missingBearerRejection >= 0);
  assert.ok(getUserCall > missingBearerRejection);
  assert.ok(invalidUserRejection > getUserCall);
  assert.ok(verifiedUserId > invalidUserRejection);
  assert.ok(handlerAuthentication > verifiedUserId);
  assert.ok(requestParsing > handlerAuthentication);
  assert.ok(adminClientCreation > handlerAuthentication);
  assert.ok(credentialExecution > adminClientCreation);
  assert.doesNotMatch(source, /body\??\.user_?id|request\??\.user_?id/i);
});

test("new Supabase publishable and secret keys are preferred", () => {
  const keys = resolveSupabaseRuntimeKeys(environment({
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_primary" }),
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_primary" }),
    SUPABASE_ANON_KEY: "legacy-anon-must-not-win",
    SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role-must-not-win",
  }));

  assert.equal(keys.publishableKey, "sb_publishable_primary");
  assert.equal(keys.secretKey, "sb_secret_primary");
});

test("legacy Supabase keys remain compatibility fallbacks", () => {
  const keys = resolveSupabaseRuntimeKeys(environment({
    SUPABASE_ANON_KEY: "legacy-anon-fallback",
    SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role-fallback",
  }));

  assert.equal(keys.publishableKey, "legacy-anon-fallback");
  assert.equal(keys.secretKey, "legacy-service-role-fallback");
});

test("malformed new Supabase key JSON fails closed without legacy fallback", () => {
  assert.throws(() => resolveSupabaseRuntimeKeys(environment({
    SUPABASE_PUBLISHABLE_KEYS: "{malformed-publishable",
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_valid" }),
    SUPABASE_ANON_KEY: "legacy-anon-must-not-mask-malformed-json",
    SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role",
  })), /runtime key configuration is incomplete/i);

  assert.throws(() => resolveSupabaseRuntimeKeys(environment({
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_valid" }),
    SUPABASE_SECRET_KEYS: "{malformed-secret",
    SUPABASE_ANON_KEY: "legacy-anon",
    SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role-must-not-mask-malformed-json",
  })), /runtime key configuration is incomplete/i);
});

test("new Supabase key sets require a non-empty default key", () => {
  assert.throws(() => resolveSupabaseRuntimeKeys(environment({
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ secondary: "sb_publishable_secondary" }),
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_valid" }),
    SUPABASE_ANON_KEY: "legacy-anon-must-not-mask-missing-default",
  })), /runtime key configuration is incomplete/i);

  assert.throws(() => resolveSupabaseRuntimeKeys(environment({
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_valid" }),
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: "" }),
    SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role-must-not-mask-empty-default",
  })), /runtime key configuration is incomplete/i);
});

test("missing new and legacy Supabase keys fail closed", () => {
  assert.throws(() => resolveSupabaseRuntimeKeys(environment({
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_valid" }),
  })), /runtime key configuration is incomplete/i);

  assert.throws(() => resolveSupabaseRuntimeKeys(environment({
    SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_valid" }),
  })), /runtime key configuration is incomplete/i);
});

test("runtime key failures neither return nor log secret values", () => {
  const secretMarker = "secret-value-must-never-escape";
  let thrown: unknown;
  try {
    resolveSupabaseRuntimeKeys(environment({
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_valid" }),
      SUPABASE_SECRET_KEYS: `{${secretMarker}`,
    }));
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Error);
  assert.doesNotMatch(thrown.message, new RegExp(secretMarker));
  assert.doesNotMatch(JSON.stringify(safeErrorResponse(thrown)), new RegExp(secretMarker));

  const keyLoaderSource = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/runtime-keys.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(keyLoaderSource, /console\.(?:log|info|warn|error|debug)/);
});

test("DeepSeek live verifier is generation-free, secret-safe, and cleanup guarded", () => {
  const verifier = readFileSync(
    new URL("../../scripts/verify-deepseek-byok-live.mjs", import.meta.url),
    "utf8",
  );
  const deepseekAdapter = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/deepseek.ts", import.meta.url),
    "utf8",
  );
  const compatibleAdapter = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/openai-compatible.ts", import.meta.url),
    "utf8",
  );
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };

  assert.equal(
    packageJson.scripts?.["verify:deepseek-byok-live"],
    "node --env-file=.env.local scripts/verify-deepseek-byok-live.mjs",
  );
  assert.match(verifier, /process\.env\.MEDCLIP_TEST_DEEPSEEK_API_KEY/);
  assert.match(verifier, /LIVE TEST STATUS = READY \/ NOT RUN/);
  assert.match(verifier, /DEEPSEEK LIVE TEST = BLOCKED - EXISTING CONNECTION/);
  assert.match(verifier, /try \{/);
  assert.match(verifier, /finally \{/);
  assert.match(verifier, /SECURITY CLEANUP FAILURE/);
  assert.match(verifier, /action: "delete"/);
  assert.doesNotMatch(
    verifier,
    /process\.env\.(?:SUPABASE_SECRET_KEYS|SUPABASE_SERVICE_ROLE_KEY|MEDCLIP_CREDENTIAL_ENCRYPTION_KEY)/,
  );
  assert.doesNotMatch(
    verifier,
    /console\.(?:log|info|warn|error|debug)\([^\n]*(?:deepseekApiKey|key_last4|accessToken|password|anonKey)/,
  );
  assert.doesNotMatch(verifier, /chat\/completions|\/responses\b|\bprompt\b|max_tokens/i);

  assert.match(deepseekAdapter, /validateWithModelsEndpoint\("deepseek", baseURL, apiKey, fetcher\)/);
  assert.doesNotMatch(deepseekAdapter, /validateWithMinimalChatCompletion|chat\/completions/);
  const modelsFunctionStart = compatibleAdapter.indexOf("export function validateWithModelsEndpoint");
  const chatFunctionStart = compatibleAdapter.indexOf("export function validateWithMinimalChatCompletion");
  assert.ok(modelsFunctionStart >= 0);
  assert.ok(chatFunctionStart > modelsFunctionStart);
  const modelsFunction = compatibleAdapter.slice(modelsFunctionStart, chatFunctionStart);
  assert.match(modelsFunction, /\/models/);
  assert.match(modelsFunction, /method: "GET"/);
  assert.doesNotMatch(modelsFunction, /method: "POST"|chat\/completions|max_tokens/i);
});

test("Kimi live verifier is China-endpoint-fixed, generation-free, secret-safe, and cleanup guarded", () => {
  const verifier = readFileSync(
    new URL("../../scripts/verify-kimi-byok-live.mjs", import.meta.url),
    "utf8",
  );
  const kimiAdapter = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/kimi.ts", import.meta.url),
    "utf8",
  );
  const compatibleAdapter = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/openai-compatible.ts", import.meta.url),
    "utf8",
  );
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };

  assert.equal(
    packageJson.scripts?.["verify:kimi-byok-live"],
    "node --env-file=.env.local scripts/verify-kimi-byok-live.mjs",
  );
  assert.match(verifier, /process\.env\.MEDCLIP_TEST_KIMI_API_KEY/);
  assert.match(verifier, /LIVE TEST STATUS = READY \/ NOT RUN/);
  assert.match(verifier, /KIMI LIVE TEST = BLOCKED - EXISTING CONNECTION/);
  assert.match(verifier, /try \{/);
  assert.match(verifier, /finally \{/);
  assert.match(verifier, /SECURITY CLEANUP FAILURE/);
  assert.match(verifier, /action: "delete"/);
  assert.doesNotMatch(
    verifier,
    /process\.env\.(?:SUPABASE_SECRET_KEYS|SUPABASE_SERVICE_ROLE_KEY|MEDCLIP_CREDENTIAL_ENCRYPTION_KEY)/,
  );
  assert.doesNotMatch(
    verifier,
    /console\.(?:log|info|warn|error|debug)\([^\n]*(?:kimiApiKey|key_last4|accessToken|password|anonKey)/,
  );
  assert.doesNotMatch(verifier, /chat\/completions|\/responses\b|\bprompt\b|max_tokens|file upload/i);
  assert.doesNotMatch(verifier, /baseURL|hostname|customEndpoint|providerEndpoint/);

  assert.match(kimiAdapter, /const baseURL = "https:\/\/api\.moonshot\.cn\/v1"/);
  assert.match(kimiAdapter, /validateWithModelsEndpoint\("kimi", baseURL, apiKey, fetcher\)/);
  assert.doesNotMatch(kimiAdapter, /api\.moonshot\.ai|validateWithMinimalChatCompletion|chat\/completions/);
  const modelsFunctionStart = compatibleAdapter.indexOf("export function validateWithModelsEndpoint");
  const chatFunctionStart = compatibleAdapter.indexOf("export function validateWithMinimalChatCompletion");
  assert.ok(modelsFunctionStart >= 0);
  assert.ok(chatFunctionStart > modelsFunctionStart);
  const modelsFunction = compatibleAdapter.slice(modelsFunctionStart, chatFunctionStart);
  assert.match(modelsFunction, /\/models/);
  assert.match(modelsFunction, /method: "GET"/);
  assert.match(compatibleAdapter, /Authorization: `Bearer \$\{apiKey\}`/);
  assert.doesNotMatch(modelsFunction, /method: "POST"|chat\/completions|max_tokens/i);
});

test("Doubao live verifier is resource-bound, generation-explicit, secret-safe, and cleanup guarded", () => {
  const verifier = readFileSync(
    new URL("../../scripts/verify-doubao-byok-live.mjs", import.meta.url),
    "utf8",
  );
  const doubaoAdapter = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/doubao.ts", import.meta.url),
    "utf8",
  );
  const deepseekAdapter = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/deepseek.ts", import.meta.url),
    "utf8",
  );
  const kimiAdapter = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/kimi.ts", import.meta.url),
    "utf8",
  );
  const compatibleAdapter = readFileSync(
    new URL("../../supabase/functions/_shared/ai-credentials/providers/openai-compatible.ts", import.meta.url),
    "utf8",
  );
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };

  assert.equal(
    packageJson.scripts?.["verify:doubao-byok-live"],
    "node --env-file=.env.local scripts/verify-doubao-byok-live.mjs",
  );
  assert.match(verifier, /process\.env\.MEDCLIP_TEST_DOUBAO_API_KEY/);
  assert.match(verifier, /process\.env\.MEDCLIP_TEST_DOUBAO_RESOURCE_ID/);
  assert.match(verifier, /\^apikey-/);
  assert.match(verifier, /API KEY RESOURCE ID FORMAT = INVALID/);
  assert.match(verifier, /LIVE TEST STATUS = READY \/ NOT RUN/);
  assert.match(verifier, /DOUBAO LIVE TEST = BLOCKED - EXISTING CONNECTION/);
  assert.match(verifier, /providerResourceId: doubaoResourceId/);
  assert.match(verifier, /try \{/);
  assert.match(verifier, /finally \{/);
  assert.match(verifier, /SECURITY CLEANUP FAILURE/);
  assert.match(verifier, /FINAL DOUBAO TEST CREDENTIAL REMAINS = NO/);
  assert.match(verifier, /PROVIDER GENERATION REQUEST = YES/);
  assert.match(verifier, /MINIMAL VALIDATION GENERATION = YES/);
  assert.match(verifier, /class SafeValidationFailure extends Error/);
  assert.match(verifier, /EDGE HTTP STATUS = \$\{error\.edgeHTTPStatus\}/);
  assert.match(verifier, /VALIDATION STATUS = \$\{error\.validationStatus\}/);
  for (const status of [
    "API_KEY_INVALID",
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_CONFIGURATION_REQUIRED",
    "RATE_LIMITED",
    "REGION_UNAVAILABLE",
    "NETWORK_ERROR",
  ]) {
    assert.match(verifier, new RegExp(`"${status}"`));
  }
  assert.doesNotMatch(
    verifier,
    /process\.env\.(?:SUPABASE_SECRET_KEYS|SUPABASE_SERVICE_ROLE_KEY|MEDCLIP_CREDENTIAL_ENCRYPTION_KEY)/,
  );
  assert.doesNotMatch(
    verifier,
    /console\.(?:log|info|warn|error|debug)\([^\n]*(?:doubaoApiKey|doubaoResourceId|key_last4|accessToken|password|anonKey)/,
  );
  assert.doesNotMatch(
    verifier,
    /console\.(?:log|info|warn|error|debug)\([^\n]*(?:result\.data|rawText|response\.headers|request body)/i,
  );

  assert.match(doubaoAdapter, /const baseURL = "https:\/\/ark\.cn-beijing\.volces\.com\/api\/v3"/);
  assert.match(doubaoAdapter, /buildDoubaoCredentialValidationRequest/);
  assert.match(doubaoAdapter, /performFixedEndpointValidation/);
  assert.doesNotMatch(doubaoAdapter, /api\/coding|\/models|\/ping/);
  assert.match(doubaoAdapter, /\/chat\/completions/);
  assert.match(doubaoAdapter, /method: "POST"/);
  assert.match(doubaoAdapter, /messages: \[\{ role: "user", content: "Reply OK\." \}\]/);
  assert.match(doubaoAdapter, /thinking: \{ type: "disabled" \}/);
  assert.match(doubaoAdapter, /max_tokens: 1/);
  assert.match(doubaoAdapter, /stream: false/);
  assert.doesNotMatch(
    doubaoAdapter,
    /response_format|json_schema|strict|presence_penalty|frequency_penalty|temperature|top_p|reasoning_effort|tools:|tool_choice/i,
  );

  assert.match(deepseekAdapter, /validateWithModelsEndpoint\("deepseek", baseURL, apiKey, fetcher\)/);
  assert.match(kimiAdapter, /validateWithModelsEndpoint\("kimi", baseURL, apiKey, fetcher\)/);
  assert.doesNotMatch(deepseekAdapter, /validateWithMinimalChatCompletion/);
  assert.doesNotMatch(kimiAdapter, /validateWithMinimalChatCompletion/);
});
