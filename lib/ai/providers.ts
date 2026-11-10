import type { AIProviderDefinition, AIProviderId } from "./types";

export const AI_PROVIDER_DEFINITIONS: readonly AIProviderDefinition[] = [
  {
    id: "deepseek",
    displayName: "DeepSeek",
    regionClass: "china-priority",
    regionLabel: "中国大陆优先",
    description: "使用 DeepSeek API Key 连接。",
    requiresResourceId: false,
    taskCapabilities: ["TEXT_REASONING"],
  },
  {
    id: "kimi",
    displayName: "Kimi / Moonshot",
    regionClass: "china-priority",
    regionLabel: "中国大陆优先",
    description: "连接 Moonshot 中国大陆服务账户。",
    requiresResourceId: false,
    taskCapabilities: ["TEXT_REASONING"],
  },
  {
    id: "doubao",
    displayName: "豆包 / 火山方舟",
    regionClass: "china-priority",
    regionLabel: "中国大陆优先",
    description: "使用火山方舟 API Key，并填写该 Key 在控制台显示的资源 ID（ApikeyID）。",
    requiresResourceId: true,
    resourceIdLabel: "API Key 资源 ID（ApikeyID）",
    taskCapabilities: ["TEXT_REASONING"],
  },
  {
    id: "tencent_tokenhub",
    displayName: "Tencent Cloud TokenHub",
    regionClass: "china-priority",
    regionLabel: "中国大陆优先",
    description: "使用 Tencent Cloud TokenHub API Key 连接（仅需 API Key）。",
    requiresResourceId: false,
    taskCapabilities: ["MUSIC_GENERATION"],
  },
] as const;

const providerIds = new Set<AIProviderId>(AI_PROVIDER_DEFINITIONS.map((provider) => provider.id));

export function isAIProviderId(value: unknown): value is AIProviderId {
  return typeof value === "string" && providerIds.has(value as AIProviderId);
}
