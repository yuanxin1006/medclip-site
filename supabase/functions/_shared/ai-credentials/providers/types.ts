export const AI_PROVIDER_IDS = ["deepseek", "kimi", "doubao", "tencent_tokenhub"] as const;

export type AIProviderId = typeof AI_PROVIDER_IDS[number];
export type ProviderRegionClass = "china-priority";
export type ProviderValidationStatus =
  | "VALID"
  | "API_KEY_INVALID"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_CONFIGURATION_REQUIRED"
  | "RATE_LIMITED"
  | "REGION_UNAVAILABLE"
  | "NETWORK_ERROR";

export type ProviderConfiguration = {
  providerResourceId?: string;
};

export type ProviderValidationDiagnostic = {
  upstreamHttpStatus: number;
  upstreamProviderErrorCode?: string;
  sanitizedProviderErrorMessage?: string;
};

export type ProviderValidationResult = {
  ok: boolean;
  provider: AIProviderId;
  status: ProviderValidationStatus;
  message: string;
  validatedAt: string;
  diagnostic?: ProviderValidationDiagnostic;
  modelAvailability?: {
    model: string;
    visible: boolean;
    status: "online" | "not_online" | "unknown";
  };
};

export type ProviderAdapter = {
  id: AIProviderId;
  displayName: string;
  regionClass: ProviderRegionClass;
  baseURL: string;
  requiresResourceId: boolean;
  credentialRequirements: {
    apiKey: true;
    providerResourceId: "required" | "none";
  };
  futureCapabilities: readonly string[];
  validateCredential: (
    apiKey: string,
    configuration: ProviderConfiguration,
    fetcher?: typeof fetch,
  ) => Promise<ProviderValidationResult>;
  sanitizeError: (error: unknown) => ProviderValidationResult;
};
