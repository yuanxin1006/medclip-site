import { validateWithModelsEndpoint, validationResult } from "./openai-compatible.ts";
import type { ProviderAdapter } from "./types.ts";

const baseURL = "https://api.deepseek.com";

export const deepseekAdapter: ProviderAdapter = {
  id: "deepseek",
  displayName: "DeepSeek",
  regionClass: "china-priority",
  baseURL,
  requiresResourceId: false,
  credentialRequirements: { apiKey: true, providerResourceId: "none" },
  futureCapabilities: ["chat", "reasoning"],
  validateCredential: (apiKey, _configuration, fetcher) =>
    validateWithModelsEndpoint("deepseek", baseURL, apiKey, fetcher),
  sanitizeError: () => validationResult("deepseek", "PROVIDER_UNAVAILABLE"),
};
