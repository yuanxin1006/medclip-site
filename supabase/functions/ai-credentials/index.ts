import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  executeCredentialRequest,
  type ConnectionMetadata,
  type CredentialRepository,
  type SaveCredentialInput,
  type SavedCredential,
} from "../_shared/ai-credentials/service.ts";
import type { AIProviderId } from "../_shared/ai-credentials/providers/types.ts";
import { isProviderId } from "../_shared/ai-credentials/providers/registry.ts";
import {
  parseCredentialRequest,
  requireAuthenticatedUserId,
  SafeCredentialError,
  safeErrorResponse,
} from "../_shared/ai-credentials/request.ts";
import { resolveSupabaseRuntimeKeys } from "../_shared/ai-credentials/runtime-keys.ts";

const MAX_REQUEST_BYTES = 16 * 1024;

type ConnectionRow = ConnectionMetadata;
type SavedCredentialRow = {
  provider: AIProviderId;
  provider_resource_id: string | null;
  ciphertext: string;
  iv: string;
  encryption_version: number;
};

type BYOKDatabase = {
  public: {
    Tables: {
      user_ai_provider_connections: {
        Row: ConnectionRow;
        Insert: Partial<ConnectionRow>;
        Update: Partial<ConnectionRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      medclip_get_ai_provider_credential: {
        Args: { target_user_id: string; target_provider: string };
        Returns: SavedCredentialRow[];
      };
      medclip_upsert_ai_provider_credential: {
        Args: {
          target_user_id: string;
          target_provider: string;
          target_provider_resource_id: string | null;
          target_key_last4: string;
          target_ciphertext: string;
          target_iv: string;
          target_encryption_version: number;
          target_validated_at: string;
        };
        Returns: ConnectionRow;
      };
      medclip_delete_ai_provider_credential: {
        Args: { target_user_id: string; target_provider: string };
        Returns: boolean;
      };
    };
  };
};

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new SafeCredentialError("INTERNAL_ERROR", "服务端配置不完整。", 500);
  return value;
}

function requestOrigin(req: Request): string | null {
  const origin = req.headers.get("Origin");
  if (!origin) return null;
  const allowedOrigins = (Deno.env.get("MEDCLIP_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowedOrigins.includes(origin)) {
    throw new SafeCredentialError("ORIGIN_NOT_ALLOWED", "该来源不能调用凭证服务。", 403);
  }
  return origin;
}

function responseHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
}

function jsonResponse(body: Record<string, unknown>, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(origin) });
}

async function authenticatedUserId(req: Request, supabaseURL: string, publishableKey: string): Promise<string> {
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return requireAuthenticatedUserId(null);
  const authClient = createClient(supabaseURL, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data.user) return requireAuthenticatedUserId(null);
  return requireAuthenticatedUserId(data.user.id);
}

function createRepository(serviceClient: SupabaseClient<BYOKDatabase>): CredentialRepository {
  const metadataColumns = [
    "id",
    "user_id",
    "provider",
    "provider_resource_id",
    "key_last4",
    "status",
    "last_validated_at",
    "created_at",
    "updated_at",
  ].join(",");

  return {
    async listConnections(userId) {
      const { data, error } = await serviceClient
        .from("user_ai_provider_connections")
        .select(metadataColumns)
        .eq("user_id", userId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<{ provider: unknown }>;
      return rows.filter((row) => isProviderId(row.provider)) as ConnectionMetadata[];
    },

    async getConnection(userId, provider) {
      const { data, error } = await serviceClient
        .from("user_ai_provider_connections")
        .select(metadataColumns)
        .eq("user_id", userId)
        .eq("provider", provider)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as ConnectionMetadata | null;
    },

    async getSavedCredential(userId, provider) {
      const { data, error } = await serviceClient
        .rpc("medclip_get_ai_provider_credential", {
          target_user_id: userId,
          target_provider: provider,
        })
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        provider: data.provider,
        providerResourceId: data.provider_resource_id,
        ciphertext: data.ciphertext,
        iv: data.iv,
        encryptionVersion: data.encryption_version,
      } as SavedCredential;
    },

    async saveCredential(input: SaveCredentialInput) {
      const { data, error } = await serviceClient
        .rpc("medclip_upsert_ai_provider_credential", {
          target_user_id: input.userId,
          target_provider: input.provider,
          target_provider_resource_id: input.providerResourceId,
          target_key_last4: input.keyLast4,
          target_ciphertext: input.ciphertext,
          target_iv: input.iv,
          target_encryption_version: input.encryptionVersion,
          target_validated_at: input.validatedAt,
        })
        .single();
      if (error) throw error;
      return data as unknown as ConnectionMetadata;
    },

    async setValidationState(userId, provider, status, validatedAt) {
      const { error } = await serviceClient
        .from("user_ai_provider_connections")
        .update({ status, last_validated_at: validatedAt })
        .eq("user_id", userId)
        .eq("provider", provider);
      if (error) throw error;
    },

    async deleteCredential(userId: string, provider: AIProviderId) {
      const { error } = await serviceClient.rpc("medclip_delete_ai_provider_credential", {
        target_user_id: userId,
        target_provider: provider,
      });
      if (error) throw error;
    },
  };
}

async function readRequest(req: Request): Promise<unknown> {
  const contentLength = Number(req.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new SafeCredentialError("INVALID_REQUEST", "请求内容过大。", 413);
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new SafeCredentialError("INVALID_REQUEST", "请求内容过大。", 413);
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new SafeCredentialError("INVALID_REQUEST", "请求不是有效的 JSON。");
  }
}

Deno.serve(async (req: Request) => {
  let origin: string | null = null;
  try {
    origin = requestOrigin(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(origin) });
    if (req.method !== "GET" && req.method !== "POST") {
      throw new SafeCredentialError("METHOD_NOT_ALLOWED", "不支持的请求方法。", 405);
    }

    const supabaseURL = requiredEnvironment("SUPABASE_URL");
    const { publishableKey, secretKey } = resolveSupabaseRuntimeKeys((name) => Deno.env.get(name));
    const encryptionKey = requiredEnvironment("MEDCLIP_CREDENTIAL_ENCRYPTION_KEY");
    const userId = await authenticatedUserId(req, supabaseURL, publishableKey);
    const rawRequest = req.method === "GET" ? { action: "list" } : await readRequest(req);
    const request = parseCredentialRequest(rawRequest);
    const serviceClient = createClient<BYOKDatabase>(supabaseURL, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const body = await executeCredentialRequest(userId, request, {
      repository: createRepository(serviceClient),
      encryptionKey,
    });
    return jsonResponse(body, 200, origin);
  } catch (error) {
    const safe = safeErrorResponse(error);
    return jsonResponse(safe.body, safe.status, origin);
  }
});
