import type { AIProviderId } from "../ai-credentials/providers/types.ts";

export const AI_TASK_IDS = [
  "music.lyrics_draft",
  "music.lyrics_refine",
  "music.creative_brief",
  "music.song_structure",
  "music.prompt_prepare",
  "music.generate",
  "editor.creative_intent_parse",
  "editor.requirements_parse",
  "editor.subtitle_semantic_plan",
  "editor.asset_match_plan",
  "editor.timeline_plan",
  "editor.editing_brief",
] as const;

export type AITaskId = typeof AI_TASK_IDS[number];

export const AI_TASK_CAPABILITIES = [
  "TEXT_REASONING",
  "VISION",
  "AUDIO_UNDERSTANDING",
  "VIDEO_UNDERSTANDING",
  "MUSIC_GENERATION",
  "VIDEO_GENERATION",
] as const;

export type AITaskCapability = typeof AI_TASK_CAPABILITIES[number];
export type AITaskCapabilityState = "foundation_ready" | "not_enabled" | "not_verified";
export type AITaskInputValue = string | readonly string[];
export type AITaskInput = Readonly<Record<string, AITaskInputValue>>;

export type ParsedAITaskRequest = {
  task: AITaskId;
  provider: AIProviderId;
  input: AITaskInput;
};

export type SafeTaskUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

export interface AITaskResultObject {
  readonly [key: string]: AITaskResultValue;
}

export type AITaskResultValue =
  | null
  | string
  | number
  | boolean
  | readonly AITaskResultValue[]
  | AITaskResultObject;

export type NormalizedTaskExecutionResult = {
  data: Readonly<Record<string, AITaskResultValue>>;
  generationOccurred: boolean;
  usage?: SafeTaskUsage | null;
};

export type AITaskExecutionContext = {
  userId: string;
  task: AITaskId;
  provider: AIProviderId;
  capability: AITaskCapability;
  input: AITaskInput;
  serverInstruction: string;
  serverControlledModel: string | null;
  apiKey: string;
  providerResourceId?: string;
  budget: {
    maxOutputTokens: number;
    timeoutMs: number;
    automaticProviderRetryCount: 0;
    maxProviderCalls: 1;
  };
};

export type AITaskExecutor = (
  context: AITaskExecutionContext,
) => Promise<NormalizedTaskExecutionResult>;

export type MusicGenerationInput =
  | {
      operationId: string;
      mode: "custom_lyrics";
      lyrics: string;
      prompt?: string;
      title?: string;
    }
  | {
      operationId: string;
      mode: "instrumental";
      prompt: string;
      title?: string;
    };

export type MusicGenerationProviderResult = {
  audioBytes: Uint8Array;
  providerReportedDurationSeconds?: number;
  serverVerifiedDurationSeconds: number | null;
  format: "mp3";
  metadata: {
    requestId?: string;
    traceId?: string;
    musicSampleRate?: number;
    musicChannel?: number;
    bitrate?: number;
    musicSize?: number;
  };
  trustedURLDiagnostics?: {
    provider_http_status: number;
    success_core_validated: true;
    output_format: "url";
    url_scheme: "https:";
    normalized_download_hostname: string;
    explicit_port_present: boolean;
    url_credentials_present: false;
    url_fragment_present: false;
    dns_preflight_result: "PUBLIC_ONLY";
    dns_resolved_address_count: number;
    dns_private_address_detected: false;
    dns_rebinding_toctou_present: true;
    download_host_allowlist_used: boolean;
    download_http_status: number;
    download_content_type: string | null;
    download_content_length_header: number | null;
    downloaded_bytes: number;
    download_redirect_count: 0;
  };
  usage?: SafeTaskUsage | null;
  metrics: {
    providerResponseMs: number;
    providerRequestDurationMs: number;
    providerGenerationLatencyMs: number;
    hexValidationDecodeMs: number;
    mp3ValidationMs: number;
    hexCharacterLength: number;
    urlPolicyValidationMs?: number;
    dnsPreflightMs?: number;
    downloadFirstResponseMs?: number;
    downloadTotalMs?: number;
  };
};

export type MusicGenerationExecutionContext = {
  userId: string;
  provider: AIProviderId;
  input: MusicGenerationInput;
  apiKey: string;
  serverControlledModel: string;
  timeoutMs: number;
  automaticProviderRetryCount: 0;
  maxProviderCalls: 1;
};

export type MusicGenerationExecutor = (
  context: MusicGenerationExecutionContext,
) => Promise<MusicGenerationProviderResult>;
