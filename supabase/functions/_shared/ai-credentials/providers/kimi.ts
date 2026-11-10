import { validateWithModelsEndpoint, validationResult } from "./openai-compatible.ts";
import type { ProviderAdapter } from "./types.ts";

const baseURL = "https://api.moonshot.cn/v1";

export const kimiAdapter: ProviderAdapter = {
  id: "kimi",
  displayName: "Kimi / Moonshot AI",
  regionClass: "china-priority",
  baseURL,
  requiresResourceId: false,
  credentialRequirements: { apiKey: true, providerResourceId: "none" },
  futureCapabilities: ["chat", "files"],
  validateCredential: (apiKey, _configuration, fetcher) =>
    validateWithModelsEndpoint("kimi", baseURL, apiKey, fetcher),
  sanitizeError: () => validationResult("kimi", "PROVIDER_UNAVAILABLE"),
};
