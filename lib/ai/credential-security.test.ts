import assert from "node:assert/strict";
import test from "node:test";
import { encryptCredential, encodeEncryptionKeyForTest } from "../../supabase/functions/_shared/ai-credentials/crypto.ts";
import { getProviderAdapter } from "../../supabase/functions/_shared/ai-credentials/providers/registry.ts";
import { performFixedEndpointValidation } from "../../supabase/functions/_shared/ai-credentials/providers/openai-compatible.ts";
import { parseCredentialRequest } from "../../supabase/functions/_shared/ai-credentials/request.ts";
import { executeCredentialRequest, type CredentialRepository } from "../../supabase/functions/_shared/ai-credentials/service.ts";

const user = "00000000-0000-4000-8000-000000000001";
const master = encodeEncryptionKeyForTest(new Uint8Array(32).fill(19));
// Synthetic only. Test names and failure messages deliberately omit key values.
const keys = ["s1SyntheticShortKey", "s1+[]{}.$^|/=?~测试Key"];
for (const provider of ["deepseek", "kimi", "doubao"] as const) {
  for (const [keyIndex, apiKey] of keys.entries()) {
    for (const action of ["saved", "transient", "save", "update"] as const) {
      for (const httpStatus of [400, 401, 403, 404, 422, 429, 451, 500]) {
        test(`S1 safe validation ${provider}/key${keyIndex}/${action}/HTTP${httpStatus}`, async () => {
          const encrypted = await encryptCredential(apiKey, master);
          let writes = 0;
          const repository = {
            getSavedCredential: async (userId: string) => {
              assert.equal(userId, user);
              return { ...encrypted, provider, providerResourceId: provider === "doubao" ? "apikey-s1-synthetic" : null };
            },
            setValidationState: async (userId: string) => { assert.equal(userId, user); },
            getConnection: async () => { writes++; return null; },
            saveCredential: async () => { writes++; throw new Error("Must not save rejected credential"); },
          } as unknown as CredentialRepository;
          const base = getProviderAdapter(provider);
          let calls = 0;
          const response = await executeCredentialRequest(user, parseCredentialRequest({
            action: action === "saved" || action === "transient" ? "test" : action,
            provider,
            ...(action === "saved" ? { mode: "saved" } : {
              ...(action === "transient" ? { mode: "transient" } : {}),
              apiKey,
              ...(provider === "doubao" ? { providerResourceId: "apikey-s1-synthetic" } : {}),
            }),
          }), {
            encryptionKey: master, repository,
            getAdapter: () => ({
              ...base,
              validateCredential: (key, configuration) => base.validateCredential(key, configuration, async () => {
                calls++;
                return new Response(JSON.stringify({ error: {
                  code: apiKey, message: apiKey,
                  nested: { authorization: apiKey, inner: { message: encodeURIComponent(apiKey) } },
                }, marker: "untrusted-body-marker" }), { status: httpStatus });
              }),
            }),
          });
          const wire = JSON.stringify(response);
          assert.equal(wire.includes(apiKey), false, "Key escaped in validation response");
          assert.equal(wire.includes(encodeURIComponent(apiKey)), false, "Encoded key escaped");
          assert.equal(wire.includes("untrusted-body-marker"), false);
          assert.equal(writes, 0);
          assert.equal(calls, 1);
          const validation = response.validation as { diagnostic: { upstreamHttpStatus: number; upstreamProviderErrorCode: string } };
          assert.equal(validation.diagnostic.upstreamHttpStatus, httpStatus);
          assert.ok(["API_KEY_INVALID", "PROVIDER_CONFIGURATION_REQUIRED", "RATE_LIMITED", "REGION_UNAVAILABLE", "PROVIDER_UNAVAILABLE"].includes(validation.diagnostic.upstreamProviderErrorCode));
        });
      }
    }
  }
  test(`S1 ${provider} transport rejection does not return exception text`, async () => {
    const key = keys[0];
    const result = await getProviderAdapter(provider).validateCredential(key, {
      providerResourceId: "apikey-s1-synthetic",
    }, async () => { throw new Error(key); });
    assert.equal(result.status, "NETWORK_ERROR");
    assert.equal(JSON.stringify(result).includes(key), false);
  });
}
test("S1 timeout and non-JSON failure remain classified without upstream data", async () => {
  const timeout = await performFixedEndpointValidation("deepseek", "https://example.invalid/models", keys[0], {}, async (_url, init) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error(keys[0])), { once: true })), { timeoutMs: 2 });
  assert.equal(timeout.status, "NETWORK_ERROR");
  assert.equal(JSON.stringify(timeout).includes(keys[0]), false);
  const malformed = await performFixedEndpointValidation("kimi", "https://example.invalid/models", keys[0], {}, async () =>
    new Response("<html>untrusted-body-marker</html>", { status: 502 }));
  assert.equal(malformed.status, "PROVIDER_UNAVAILABLE");
  assert.equal(JSON.stringify(malformed).includes("untrusted-body-marker"), false);
});


import { executeAITaskRequest } from "../../supabase/functions/_shared/ai-tasks/service.ts";
import { parseAITaskRequest } from "../../supabase/functions/_shared/ai-tasks/request.ts";
import { safeTaskErrorResponse, SafeTaskError } from "../../supabase/functions/_shared/ai-tasks/errors.ts";
import { createDeepSeekTextTaskExecutor } from "../../supabase/functions/_shared/ai-tasks/providers/deepseek.ts";
import { createKimiTextTaskExecutor } from "../../supabase/functions/_shared/ai-tasks/providers/kimi.ts";
import { createDoubaoTextTaskExecutor } from "../../supabase/functions/_shared/ai-tasks/providers/doubao.ts";
for (const [provider, factory] of Object.entries({
  deepseek: createDeepSeekTextTaskExecutor, kimi: createKimiTextTaskExecutor, doubao: createDoubaoTextTaskExecutor,
}) as Array<["deepseek" | "kimi" | "doubao", typeof createDeepSeekTextTaskExecutor]>) {
  for (const [keyIndex, apiKey] of keys.entries()) {
    for (const status of [400, 401, 403, 404, 422, 429, 451, 500]) {
      test(`S1 saved task error boundary ${provider}/key${keyIndex}/HTTP${status}`, async () => {
        const encrypted = await encryptCredential(apiKey, master);
        let calls = 0;
        try {
          await executeAITaskRequest(user, parseAITaskRequest({
            task: "music.creative_brief", provider,
            input: { creativeRequirement: "Plan a quiet song", genre: "folk", mood: "warm" },
          }), {
            encryptionKey: master,
            repository: { getSavedCredential: async (id) => {
              assert.equal(id, user);
              return { ...encrypted, provider, providerResourceId: provider === "doubao" ? "apikey-s1-synthetic" : null };
            }},
            executeTask: factory(async () => {
              calls++;
              return new Response(JSON.stringify({ error: {
                code: apiKey, message: apiKey, nested: { raw: apiKey },
              }}), { status });
            }),
          });
          assert.fail("Provider rejection must fail closed");
        } catch (error) {
          assert.ok(error instanceof SafeTaskError);
          const internal = JSON.stringify(error.diagnostic);
          const wire = JSON.stringify(safeTaskErrorResponse(error));
          assert.equal(internal.includes(apiKey), false, "Task diagnostic contains credential");
          assert.equal(wire.includes(apiKey), false, "Task response contains credential");
          assert.equal(wire.includes(encodeURIComponent(apiKey)), false);
          assert.equal(calls, 1);
          assert.equal(error.diagnostic?.httpStatus, status);
        }
      });
    }
  }
}
