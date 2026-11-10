export type AIProviderId = "deepseek" | "kimi" | "doubao" | "tencent_tokenhub";

export type AIProviderTaskCapability = "TEXT_REASONING" | "MUSIC_GENERATION";

export type AIProviderRegionClass = "china-priority";

export type AIProviderConnectionStatus = "connected" | "validation_failed" | "needs_update";

export type AIProviderDefinition = {
  id: AIProviderId;
  displayName: string;
  regionClass: AIProviderRegionClass;
  regionLabel: string;
  description: string;
  requiresResourceId: boolean;
  resourceIdLabel?: string;
  taskCapabilities: readonly AIProviderTaskCapability[];
};

export type AIProviderConnection = {
  id: string;
  user_id: string;
  provider: AIProviderId;
  provider_resource_id: string | null;
  key_last4: string;
  status: AIProviderConnectionStatus;
  last_validated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CredentialValidationResult = {
  ok: boolean;
  provider: AIProviderId;
  status: string;
  message: string;
  validatedAt: string;
  modelAvailability?: {
    model: string;
    visible: boolean;
    status: "online" | "not_online" | "unknown";
  };
};

export type AIProviderActionResult = {
  ok: boolean;
  connection?: AIProviderConnection;
  connections?: AIProviderConnection[];
  validation?: CredentialValidationResult;
  status?: string;
  message?: string;
};
