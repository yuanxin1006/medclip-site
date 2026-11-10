import { FunctionsHttpError } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "../supabase/client";
import type {
  AIProviderActionResult,
  AIProviderConnection,
  AIProviderId,
  CredentialValidationResult,
} from "./types";
import { safeAIProviderErrorMessage } from "./ui";

type ProviderConfiguration = {
  providerResourceId?: string;
  signal?: AbortSignal;
};

export class AIProviderClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AIProviderClientError";
    this.code = code;
  }
}

function requireResult(data: unknown, invokeError: unknown): AIProviderActionResult {
  const result = data && typeof data === "object" ? data as AIProviderActionResult : null;
  if (invokeError || !result) {
    throw new AIProviderClientError("NETWORK_ERROR", safeAIProviderErrorMessage({ code: "NETWORK_ERROR" }));
  }
  if (!result.ok) {
    const code = result.status ?? "INTERNAL_ERROR";
    throw new AIProviderClientError(code, safeAIProviderErrorMessage({ code }));
  }
  return result;
}

async function invokeCredentialFunction(body: Record<string, unknown>, signal?: AbortSignal): Promise<AIProviderActionResult> {
  const { data, error } = await getSupabaseBrowserClient().functions.invoke("ai-credentials", { body, signal });
  let safeData: unknown = data;
  if (!safeData && error instanceof FunctionsHttpError && error.context instanceof Response) {
    try {
      const candidate = await error.context.clone().json();
      if (candidate && typeof candidate === "object") {
        const record = candidate as Record<string, unknown>;
        safeData = {
          ok: false,
          status: typeof record.status === "string" ? record.status : "INTERNAL_ERROR",
          message: "Safe client error",
        };
      }
    } catch {
      // A non-JSON upstream failure remains a generic network error.
    }
  }
  return requireResult(safeData, safeData ? null : error);
}

export async function listAIProviderConnections(signal?: AbortSignal): Promise<AIProviderConnection[]> {
  const result = await invokeCredentialFunction({ action: "list" }, signal);
  return result.connections ?? [];
}

export async function testTransientCredential(
  provider: AIProviderId,
  apiKey: string,
  configuration: ProviderConfiguration = {},
): Promise<CredentialValidationResult> {
  const result = await invokeCredentialFunction({
    action: "test",
    mode: "transient",
    provider,
    apiKey,
    providerResourceId: configuration.providerResourceId,
  }, configuration.signal);
  if (!result.validation) throw new AIProviderClientError("INTERNAL_ERROR", "连接测试没有返回结果。");
  return result.validation;
}

export async function testSavedCredential(provider: AIProviderId, signal?: AbortSignal): Promise<CredentialValidationResult> {
  const result = await invokeCredentialFunction({ action: "test", mode: "saved", provider }, signal);
  if (!result.validation) throw new AIProviderClientError("INTERNAL_ERROR", "连接测试没有返回结果。");
  return result.validation;
}

async function persistCredential(
  action: "save" | "update",
  provider: AIProviderId,
  apiKey: string,
  configuration: ProviderConfiguration,
): Promise<AIProviderConnection> {
  const result = await invokeCredentialFunction({
    action,
    provider,
    apiKey,
    providerResourceId: configuration.providerResourceId,
  }, configuration.signal);
  if (!result.connection) throw new AIProviderClientError("INTERNAL_ERROR", "凭证已处理，但连接状态未能读取。");
  return result.connection;
}

export function saveAIProviderCredential(
  provider: AIProviderId,
  apiKey: string,
  configuration: ProviderConfiguration = {},
): Promise<AIProviderConnection> {
  return persistCredential("save", provider, apiKey, configuration);
}

export function updateAIProviderCredential(
  provider: AIProviderId,
  apiKey: string,
  configuration: ProviderConfiguration = {},
): Promise<AIProviderConnection> {
  return persistCredential("update", provider, apiKey, configuration);
}

export async function deleteAIProviderCredential(provider: AIProviderId, signal?: AbortSignal): Promise<void> {
  await invokeCredentialFunction({ action: "delete", provider }, signal);
}
