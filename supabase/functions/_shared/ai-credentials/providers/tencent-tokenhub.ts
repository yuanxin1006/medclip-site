import {
  DEFAULT_VALIDATION_TIMEOUT_MS,
  validationResult,
} from "./openai-compatible.ts";
import type {
  ProviderAdapter,
  ProviderValidationResult,
  ProviderValidationStatus,
} from "./types.ts";

export const TENCENT_TOKENHUB_BASE_URL = "https://tokenhub.tencentmaas.com";
export const TENCENT_TOKENHUB_VALIDATION_ENDPOINT = `${TENCENT_TOKENHUB_BASE_URL}/v1/models`;
export const TENCENT_TOKENHUB_MUSIC_MODEL = "minimax-music-v2.6";

export type TokenHubModelAvailability = {
  visible: boolean;
  online: boolean;
  status: "online" | "not_online" | "unknown";
};

export function parseTokenHubModelAvailability(value: unknown): TokenHubModelAvailability {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { visible: false, online: false, status: "unknown" };
  }
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) return { visible: false, online: false, status: "unknown" };
  const target = data.find((entry) => {
    return Boolean(entry)
      && typeof entry === "object"
      && !Array.isArray(entry)
      && (entry as Record<string, unknown>).id === TENCENT_TOKENHUB_MUSIC_MODEL;
  });
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return { visible: false, online: false, status: "unknown" };
  }
  const online = (target as Record<string, unknown>).status === "online";
  return {
    visible: true,
    online,
    status: online ? "online" : "not_online",
  };
}

export function buildTokenHubCredentialValidationRequest(): {
  url: string;
  init: Omit<RequestInit, "signal">;
} {
  return {
    url: TENCENT_TOKENHUB_VALIDATION_ENDPOINT,
    init: { method: "GET" },
  };
}

function statusForHTTP(status: number): ProviderValidationStatus {
  if (status === 401) return "API_KEY_INVALID";
  if (status === 403) return "PROVIDER_CONFIGURATION_REQUIRED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 451) return "REGION_UNAVAILABLE";
  return "PROVIDER_UNAVAILABLE";
}

async function validateTokenHubCredential(
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ProviderValidationResult> {
  const request = buildTokenHubCredentialValidationRequest();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetcher(request.url, {
      ...request.init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      return validationResult(
        "tencent_tokenhub",
        statusForHTTP(response.status),
        { upstreamHttpStatus: response.status },
      );
    }

    let availability: TokenHubModelAvailability = { visible: false, online: false, status: "unknown" };
    try {
      availability = parseTokenHubModelAvailability(await response.clone().json());
    } catch {
      // Authentication succeeded. Model visibility remains unproven on malformed optional metadata.
    }
    const result = validationResult("tencent_tokenhub", "VALID");
    return {
      ...result,
      message: availability.online
        ? "连接验证成功；目标音乐模型在模型列表中可见且在线，但尚未证明付费生成权限。"
        : "连接验证成功；目标音乐模型的生成权限尚未验证。",
      modelAvailability: {
        model: TENCENT_TOKENHUB_MUSIC_MODEL,
        visible: availability.visible,
        status: availability.status,
      },
    };
  } catch {
    return validationResult("tencent_tokenhub", "NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

export const tencentTokenHubAdapter: ProviderAdapter = {
  id: "tencent_tokenhub",
  displayName: "Tencent Cloud TokenHub",
  regionClass: "china-priority",
  baseURL: TENCENT_TOKENHUB_BASE_URL,
  requiresResourceId: false,
  credentialRequirements: { apiKey: true, providerResourceId: "none" },
  futureCapabilities: ["music_generation"],
  validateCredential: (apiKey, _configuration, fetcher) =>
    validateTokenHubCredential(apiKey, fetcher),
  sanitizeError: () => validationResult("tencent_tokenhub", "PROVIDER_UNAVAILABLE"),
};
