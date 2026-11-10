import { deepseekAdapter } from "./deepseek.ts";
import { doubaoAdapter } from "./doubao.ts";
import { kimiAdapter } from "./kimi.ts";
import { tencentTokenHubAdapter } from "./tencent-tokenhub.ts";
import { AI_PROVIDER_IDS, type AIProviderId, type ProviderAdapter } from "./types.ts";

export const PROVIDER_ADAPTERS: readonly ProviderAdapter[] = [
  deepseekAdapter,
  kimiAdapter,
  doubaoAdapter,
  tencentTokenHubAdapter,
] as const;

const adaptersById = new Map<AIProviderId, ProviderAdapter>(
  PROVIDER_ADAPTERS.map((adapter) => [adapter.id, adapter]),
);

export function isProviderId(value: unknown): value is AIProviderId {
  return typeof value === "string" && (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

export function getProviderAdapter(value: unknown): ProviderAdapter {
  if (!isProviderId(value)) throw new Error("INVALID_PROVIDER");
  const adapter = adaptersById.get(value);
  if (!adapter) throw new Error("INVALID_PROVIDER");
  return adapter;
}
