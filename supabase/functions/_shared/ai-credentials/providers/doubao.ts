import { performFixedEndpointValidation, validationResult } from "./openai-compatible.ts";
import type { ProviderAdapter } from "./types.ts";
import {
  DOUBAO_FIXED_TEXT_MODEL,
  isDoubaoAPIKeyResourceId,
} from "../../doubao-policy.ts";

const baseURL = "https://ark.cn-beijing.volces.com/api/v3";
export const DOUBAO_VALIDATION_TIMEOUT_MS = 30_000;

export function buildDoubaoCredentialValidationRequest(): {
  url: string;
  init: Omit<RequestInit, "signal">;
} {
  return {
    url: `${baseURL}/chat/completions`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DOUBAO_FIXED_TEXT_MODEL,
        messages: [{ role: "user", content: "Reply OK." }],
        thinking: { type: "disabled" },
        stream: false,
        max_tokens: 1,
      }),
    },
  };
}

export const doubaoAdapter: ProviderAdapter = {
  id: "doubao",
  displayName: "豆包 / 火山方舟",
  regionClass: "china-priority",
  baseURL,
  requiresResourceId: true,
  credentialRequirements: { apiKey: true, providerResourceId: "required" },
  futureCapabilities: ["chat", "vision", "audio"],
  validateCredential: (apiKey, configuration, fetcher) => {
    if (!isDoubaoAPIKeyResourceId(configuration.providerResourceId)) {
      return Promise.resolve(validationResult("doubao", "PROVIDER_CONFIGURATION_REQUIRED"));
    }
    const request = buildDoubaoCredentialValidationRequest();
    return performFixedEndpointValidation(
      "doubao",
      request.url,
      apiKey,
      request.init,
      fetcher,
      { timeoutMs: DOUBAO_VALIDATION_TIMEOUT_MS },
    );
  },
  sanitizeError: () => validationResult("doubao", "PROVIDER_UNAVAILABLE"),
};
