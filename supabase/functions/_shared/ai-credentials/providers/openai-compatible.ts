import type {
  AIProviderId,
  ProviderValidationDiagnostic,
  ProviderValidationResult,
  ProviderValidationStatus,
} from "./types.ts";

export const DEFAULT_VALIDATION_TIMEOUT_MS = 8_000;

type FixedEndpointValidationOptions = {
  timeoutMs?: number;
};

function messageFor(status: ProviderValidationStatus): string {
  switch (status) {
    case "VALID": return "连接验证成功。";
    case "API_KEY_INVALID": return "API Key 无效或没有访问权限。";
    case "PROVIDER_CONFIGURATION_REQUIRED": return "Provider 配置不完整或资源 ID 无效。";
    case "RATE_LIMITED": return "服务商暂时限制了请求频率，请稍后手动重试。";
    case "REGION_UNAVAILABLE": return "当前地区可能无法使用该服务。";
    case "NETWORK_ERROR": return "无法连接服务商，请检查网络后重试。";
    default: return "服务商暂时不可用，请稍后手动重试。";
  }
}

function statusForHTTP(responseStatus: number): ProviderValidationStatus {
  if (responseStatus >= 200 && responseStatus < 300) return "VALID";
  if (responseStatus === 401 || responseStatus === 403) return "API_KEY_INVALID";
  if (responseStatus === 400 || responseStatus === 404 || responseStatus === 422) {
    return "PROVIDER_CONFIGURATION_REQUIRED";
  }
  if (responseStatus === 429) return "RATE_LIMITED";
  if (responseStatus === 451) return "REGION_UNAVAILABLE";
  return "PROVIDER_UNAVAILABLE";
}

// Upstream bodies, messages and arbitrary error codes are untrusted. They can
// echo a submitted or decrypted key, including nested or encoded values.
// Return only a finite local classification and HTTP status; never copy text.
function diagnosticForUpstreamFailure(response: Response): ProviderValidationDiagnostic {
  const status = statusForHTTP(response.status);
  return {
    upstreamHttpStatus: response.status,
    upstreamProviderErrorCode: status,
    sanitizedProviderErrorMessage: messageFor(status),
  };
}

export function validationResult(
  provider: AIProviderId,
  status: ProviderValidationStatus,
  diagnostic?: ProviderValidationDiagnostic,
): ProviderValidationResult {
  return {
    ok: status === "VALID",
    provider,
    status,
    message: messageFor(status),
    validatedAt: new Date().toISOString(),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

export async function performFixedEndpointValidation(
  provider: AIProviderId,
  url: string,
  apiKey: string,
  init: Omit<RequestInit, "signal">,
  fetcher: typeof fetch = fetch,
  options: FixedEndpointValidationOptions = {},
): Promise<ProviderValidationResult> {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:") return validationResult(provider, "PROVIDER_UNAVAILABLE");

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS,
  );
  try {
    const response = await fetcher(endpoint, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(init.headers ?? {}),
      },
      redirect: "error",
      signal: controller.signal,
    });
    const status = statusForHTTP(response.status);
    if (status === "VALID") return validationResult(provider, status);
    return validationResult(provider, status, await diagnosticForUpstreamFailure(response));
  } catch {
    return validationResult(provider, "NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

export function validateWithModelsEndpoint(
  provider: AIProviderId,
  baseURL: string,
  apiKey: string,
  fetcher?: typeof fetch,
): Promise<ProviderValidationResult> {
  return performFixedEndpointValidation(provider, `${baseURL.replace(/\/$/, "")}/models`, apiKey, {
    method: "GET",
  }, fetcher);
}

export function validateWithMinimalChatCompletion(
  provider: AIProviderId,
  baseURL: string,
  apiKey: string,
  model: string,
  fetcher?: typeof fetch,
  options?: FixedEndpointValidationOptions,
): Promise<ProviderValidationResult> {
  return performFixedEndpointValidation(
    provider,
    `${baseURL.replace(/\/$/, "")}/chat/completions`,
    apiKey,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
    },
    fetcher,
    options,
  );
}
