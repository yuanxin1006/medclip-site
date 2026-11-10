import { decryptCredential, encryptCredential } from "./crypto.ts";
import { getProviderAdapter } from "./providers/registry.ts";
import type { AIProviderId, ProviderAdapter, ProviderValidationResult } from "./providers/types.ts";
import { SafeCredentialError, type CredentialRequest, requireAuthenticatedUserId } from "./request.ts";

export type ConnectionMetadata = {
  id: string;
  user_id: string;
  provider: AIProviderId;
  provider_resource_id: string | null;
  key_last4: string;
  status: "connected" | "validation_failed" | "needs_update";
  last_validated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SavedCredential = {
  provider: AIProviderId;
  providerResourceId: string | null;
  ciphertext: string;
  iv: string;
  encryptionVersion: number;
};

export type SaveCredentialInput = {
  userId: string;
  provider: AIProviderId;
  providerResourceId: string | null;
  keyLast4: string;
  ciphertext: string;
  iv: string;
  encryptionVersion: number;
  validatedAt: string;
};

export type CredentialRepository = {
  listConnections(userId: string): Promise<ConnectionMetadata[]>;
  getConnection(userId: string, provider: AIProviderId): Promise<ConnectionMetadata | null>;
  getSavedCredential(userId: string, provider: AIProviderId): Promise<SavedCredential | null>;
  saveCredential(input: SaveCredentialInput): Promise<ConnectionMetadata>;
  setValidationState(
    userId: string,
    provider: AIProviderId,
    status: "connected" | "validation_failed",
    validatedAt: string,
  ): Promise<void>;
  deleteCredential(userId: string, provider: AIProviderId): Promise<void>;
};

export type CredentialServiceDependencies = {
  repository: CredentialRepository;
  encryptionKey: string;
  getAdapter?: (provider: AIProviderId) => ProviderAdapter;
};

function validationResponse(validation: ProviderValidationResult) {
  return {
    ok: validation.ok,
    validation,
    status: validation.status,
    message: validation.message,
  };
}

export async function executeCredentialRequest(
  authenticatedUserId: string,
  request: CredentialRequest,
  dependencies: CredentialServiceDependencies,
): Promise<Record<string, unknown>> {
  const userId = requireAuthenticatedUserId(authenticatedUserId);
  const { repository, encryptionKey } = dependencies;

  if (request.action === "list") {
    return { ok: true, connections: await repository.listConnections(userId) };
  }

  const provider = request.provider;
  if (!provider) throw new SafeCredentialError("INVALID_PROVIDER", "不支持的 AI 服务商。");
  const adapter = (dependencies.getAdapter ?? getProviderAdapter)(provider);

  if (request.action === "delete") {
    await repository.deleteCredential(userId, provider);
    return { ok: true, status: "DELETED", message: "AI 服务凭证已删除。" };
  }

  if (request.action === "test" && request.mode === "saved") {
    const saved = await repository.getSavedCredential(userId, provider);
    if (!saved) throw new SafeCredentialError("NOT_CONNECTED", "尚未保存该服务商的凭证。", 404);
    let apiKey: string;
    try {
      apiKey = await decryptCredential({
        ciphertext: saved.ciphertext,
        iv: saved.iv,
        encryptionVersion: saved.encryptionVersion as 1,
      }, encryptionKey);
    } catch {
      throw new SafeCredentialError("INTERNAL_ERROR", "已保存凭证暂时无法读取。", 500);
    }
    const validation = await adapter.validateCredential(apiKey, {
      providerResourceId: saved.providerResourceId ?? undefined,
    });
    apiKey = "";
    await repository.setValidationState(
      userId,
      provider,
      validation.ok ? "connected" : "validation_failed",
      validation.validatedAt,
    );
    return validationResponse(validation);
  }

  const apiKey = request.apiKey;
  if (!apiKey) throw new SafeCredentialError("API_KEY_INVALID", "请输入有效的 API Key。");
  const validation = await adapter.validateCredential(apiKey, {
    providerResourceId: request.providerResourceId,
  });

  if (request.action === "test") return validationResponse(validation);
  if (!validation.ok) return validationResponse(validation);

  const existing = await repository.getConnection(userId, provider);
  if (request.action === "save" && existing) {
    throw new SafeCredentialError("ALREADY_CONNECTED", "该服务商已经连接，请使用更新操作。", 409);
  }
  if (request.action === "update" && !existing) {
    throw new SafeCredentialError("NOT_CONNECTED", "尚未保存该服务商的凭证。", 404);
  }

  let encrypted;
  try {
    encrypted = await encryptCredential(apiKey, encryptionKey);
  } catch {
    throw new SafeCredentialError("INTERNAL_ERROR", "凭证加密服务未正确配置。", 500);
  }
  const connection = await repository.saveCredential({
    userId,
    provider,
    providerResourceId: request.providerResourceId ?? null,
    keyLast4: apiKey.slice(-4),
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    encryptionVersion: encrypted.encryptionVersion,
    validatedAt: validation.validatedAt,
  });
  return { ok: true, connection, validation };
}
