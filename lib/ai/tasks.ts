import { FunctionsHttpError } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "../supabase/client";
import type { AIProviderId } from "./types";

export type AITaskId =
  | "music.lyrics_draft"
  | "music.lyrics_refine"
  | "music.creative_brief"
  | "music.song_structure"
  | "music.prompt_prepare"
  | "music.generate"
  | "editor.creative_intent_parse"
  | "editor.requirements_parse"
  | "editor.subtitle_semantic_plan"
  | "editor.asset_match_plan"
  | "editor.timeline_plan"
  | "editor.editing_brief";

export type MusicAITaskId = Exclude<Extract<AITaskId, `music.${string}`>, "music.generate">;
export type MusicGenerationAITaskId = "music.generate";
export type EditorAITaskId = Extract<AITaskId, `editor.${string}`>;

export type MusicTaskInput = {
  title?: string;
  theme?: string;
  lyrics?: string;
  creativeRequirement?: string;
  language?: string;
  style?: string;
  genre?: string;
  mood?: string;
  voicePreference?: string;
};

export type MusicGenerationTaskInput =
  | { operationId: string; mode: "custom_lyrics"; lyrics: string; prompt?: string; title?: string }
  | { operationId: string; mode: "instrumental"; prompt: string; title?: string };

export type EditorTaskInput = {
  editingRequirement?: string;
  subtitleText?: string;
  assetDescriptions?: string[];
  editorContext?: string;
};

export interface AITaskResultObject {
  [key: string]: AITaskResultValue;
}

export type AITaskResultValue =
  | null
  | string
  | number
  | boolean
  | AITaskResultValue[]
  | AITaskResultObject;

export type RunAITaskRequest =
  | { task: MusicAITaskId; provider: AIProviderId; input: MusicTaskInput }
  | { task: MusicGenerationAITaskId; provider: AIProviderId; input: MusicGenerationTaskInput }
  | { task: EditorAITaskId; provider: AIProviderId; input: EditorTaskInput };

export type AITaskUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

export type AITaskSuccessResult = {
  ok: true;
  task: AITaskId;
  provider: AIProviderId;
  result: {
    capability: "TEXT_REASONING" | "MUSIC_GENERATION";
    data: Record<string, AITaskResultValue>;
  };
  usage: AITaskUsage | null;
  metadata: {
    providerUsed: AIProviderId;
    taskType: AITaskId;
    generationOccurred: boolean;
  };
};

type AITaskFailureResult = {
  ok: false;
  status?: string;
  message?: string;
};

export class AITaskClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AITaskClientError";
    this.code = code;
  }
}

const SAFE_TASK_MESSAGES: Readonly<Record<string, string>> = {
  UNAUTHENTICATED: "请先登录后再使用 AI 功能。",
  INVALID_TASK: "暂不支持此 AI 任务。",
  INVALID_INPUT: "AI 任务输入无效，请检查后重试。",
  NOT_CONNECTED: "请先在“我的 AI 服务”中连接该服务。",
  PROVIDER_NOT_SUPPORTED_FOR_TASK: "该服务商的此项能力尚未启用。",
  PROVIDER_CONFIGURATION_REQUIRED: "Provider 配置不完整。",
  API_KEY_INVALID: "保存的 API Key 无效或没有访问权限。",
  RATE_LIMITED: "服务商请求频率受限，请稍后再试。",
  REGION_UNAVAILABLE: "当前网络或地区暂时无法连接服务商。",
  NETWORK_ERROR: "无法连接 AI 任务服务，请稍后重试。",
  PROVIDER_UNAVAILABLE: "服务商暂时不可用。",
  TASK_TIMEOUT: "AI 任务超时，请稍后重试。",
  PROVIDER_AUTH_ERROR: "保存的 API Key 无效或没有访问权限。",
  PROVIDER_PAYMENT_OR_QUOTA_ERROR: "服务商账户余额或配额不足。",
  PROVIDER_RATE_LIMIT: "服务商请求频率受限，请稍后手动重试。",
  PROVIDER_BAD_REQUEST: "服务商拒绝了当前固定任务请求。",
  PROVIDER_TIMEOUT: "服务商响应超时，请稍后手动重试。",
  PROVIDER_HTTP_ERROR: "服务商暂时无法完成请求。",
  PROVIDER_EMPTY_CONTENT: "服务商返回了空结果，请稍后手动重试。",
  PROVIDER_INVALID_JSON: "服务商返回的结果格式无效。",
  PROVIDER_SCHEMA_MISMATCH: "服务商返回的结构不符合任务要求。",
  INTERNAL_TASK_ERROR: "AI 任务服务暂时不可用。",
  INTERNAL_ERROR: "AI 任务服务暂时不可用。",
};

function safeTaskMessage(code: string): string {
  return SAFE_TASK_MESSAGES[code] ?? SAFE_TASK_MESSAGES.INTERNAL_ERROR;
}

function requireTaskResult(value: unknown, invokeError: unknown): AITaskSuccessResult {
  const result = value && typeof value === "object" ? value as AITaskSuccessResult | AITaskFailureResult : null;
  if (!result || invokeError && !value) throw new AITaskClientError("NETWORK_ERROR", safeTaskMessage("NETWORK_ERROR"));
  if (!result.ok) {
    const code = result.status ?? "INTERNAL_ERROR";
    throw new AITaskClientError(code, safeTaskMessage(code));
  }
  return result;
}

export async function runAITask(request: RunAITaskRequest): Promise<AITaskSuccessResult> {
  const { data, error } = await getSupabaseBrowserClient().functions.invoke("ai-tasks", { body: request });
  let safeData: unknown = data;
  if (!safeData && error instanceof FunctionsHttpError && error.context instanceof Response) {
    try {
      const candidate = await error.context.clone().json();
      if (candidate && typeof candidate === "object") {
        const record = candidate as Record<string, unknown>;
        safeData = { ok: false, status: typeof record.status === "string" ? record.status : "INTERNAL_ERROR" };
      }
    } catch {
      // Non-JSON failures remain a generic network error.
    }
  }
  return requireTaskResult(safeData, safeData ? null : error);
}
