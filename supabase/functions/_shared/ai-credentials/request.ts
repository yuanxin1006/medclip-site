import { getProviderAdapter, isProviderId } from "./providers/registry.ts";
import type { AIProviderId } from "./providers/types.ts";
import { isDoubaoAPIKeyResourceId } from "../doubao-policy.ts";

export type CredentialAction = "list" | "test" | "save" | "update" | "delete";
export type CredentialMode = "transient" | "saved";

export type CredentialRequest = {
  action: CredentialAction;
  provider?: AIProviderId;
  mode?: CredentialMode;
  apiKey?: string;
  providerResourceId?: string;
};

export class SafeCredentialError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "SafeCredentialError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const actions = new Set<CredentialAction>(["list", "test", "save", "update", "delete"]);
const allowedKeys = new Set(["action", "provider", "mode", "apiKey", "providerResourceId"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeAPIKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 4096) {
    throw new SafeCredentialError("API_KEY_INVALID", "请输入有效的 API Key。");
  }
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SafeCredentialError("API_KEY_INVALID", "API Key 格式无效。");
  }
  return value;
}

export function normalizeProviderResourceId(provider: AIProviderId, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (provider === "doubao") {
      throw new SafeCredentialError(
        "PROVIDER_CONFIGURATION_REQUIRED",
        "豆包需要 API Key 资源 ID（ApikeyID）。",
      );
    }
    return undefined;
  }
  if (provider !== "doubao" || !isDoubaoAPIKeyResourceId(value)) {
    throw new SafeCredentialError(
      "PROVIDER_CONFIGURATION_REQUIRED",
      provider === "doubao"
        ? "豆包 API Key 资源 ID（ApikeyID）格式无效。"
        : "Provider 配置无效；不允许资源 ID。",
    );
  }
  return value;
}

export function parseCredentialRequest(input: unknown): CredentialRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SafeCredentialError("INVALID_REQUEST", "请求格式无效。");
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new SafeCredentialError("INVALID_REQUEST", "请求包含不允许的字段。");
  }
  if (typeof record.action !== "string" || !actions.has(record.action as CredentialAction)) {
    throw new SafeCredentialError("INVALID_REQUEST", "不支持的操作。");
  }
  const action = record.action as CredentialAction;
  if (action === "list") return { action };
  if (!isProviderId(record.provider)) {
    throw new SafeCredentialError("INVALID_PROVIDER", "不支持的 AI 服务商。");
  }
  const provider = record.provider;
  getProviderAdapter(provider);

  if (action === "delete") return { action, provider };

  if (action === "test") {
    if (record.mode !== "transient" && record.mode !== "saved") {
      throw new SafeCredentialError("INVALID_REQUEST", "请选择本次使用或已保存凭证。");
    }
    if (record.mode === "saved") return { action, provider, mode: "saved" };
    return {
      action,
      provider,
      mode: "transient",
      apiKey: normalizeAPIKey(record.apiKey),
      providerResourceId: normalizeProviderResourceId(provider, record.providerResourceId),
    };
  }

  return {
    action,
    provider,
    apiKey: normalizeAPIKey(record.apiKey),
    providerResourceId: normalizeProviderResourceId(provider, record.providerResourceId),
  };
}

export function requireAuthenticatedUserId(userId: unknown): string {
  if (typeof userId !== "string" || !uuidPattern.test(userId)) {
    throw new SafeCredentialError("UNAUTHENTICATED", "请先登录后再管理 AI 服务。", 401);
  }
  return userId.toLowerCase();
}

export function safeErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof SafeCredentialError) {
    return { status: error.httpStatus, body: { ok: false, status: error.code, message: error.message } };
  }
  return {
    status: 500,
    body: { ok: false, status: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试。" },
  };
}
