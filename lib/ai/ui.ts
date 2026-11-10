import type { AIProviderConnectionStatus } from "./types";

const SAFE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  API_KEY_INVALID: "API Key 无效或没有访问权限。",
  PROVIDER_CONFIGURATION_REQUIRED: "Provider 配置不完整，请检查必填信息。",
  RATE_LIMITED: "服务商请求频率受限，请稍后再试。",
  REGION_UNAVAILABLE: "当前网络或地区暂时无法连接服务商。",
  NETWORK_ERROR: "无法连接服务商，请稍后重试。",
  PROVIDER_UNAVAILABLE: "服务商暂时不可用。",
  NOT_CONNECTED: "尚未连接此服务。",
  UNAUTHENTICATED: "登录后才能管理 AI 服务。",
  INTERNAL_ERROR: "服务暂时不可用。",
};

export function safeAIProviderErrorMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  return SAFE_ERROR_MESSAGES[code] ?? SAFE_ERROR_MESSAGES.INTERNAL_ERROR;
}

export function safeAIProviderStatusMessage(status: unknown): string {
  return typeof status === "string" && SAFE_ERROR_MESSAGES[status]
    ? SAFE_ERROR_MESSAGES[status]
    : SAFE_ERROR_MESSAGES.PROVIDER_UNAVAILABLE;
}

export function aiProviderStatusLabel(status: AIProviderConnectionStatus | null): string {
  if (!status) return "未连接";
  if (status === "connected") return "已连接";
  if (status === "validation_failed") return "验证失败";
  return "需要重新连接";
}

export function maskAIProviderKey(last4: string): string {
  const safeLast4 = last4.slice(-4);
  return `•••• •••• •••• ${safeLast4}`;
}

export function formatAIProviderValidationTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("zh-CN", { hour12: false });
}
