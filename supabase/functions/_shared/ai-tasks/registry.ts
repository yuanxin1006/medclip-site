import { AI_PROVIDER_IDS, type AIProviderId } from "../ai-credentials/providers/types.ts";
import { SafeTaskError } from "./errors.ts";
import {
  DEEPSEEK_LIVE_TASK_IDS,
  DEEPSEEK_TASK_MODEL,
  executeDeepSeekTextTask,
} from "./providers/deepseek.ts";
import {
  DOUBAO_LIVE_TASK_IDS,
  DOUBAO_TASK_MODEL,
  executeDoubaoTextTask,
} from "./providers/doubao.ts";
import {
  KIMI_LIVE_TASK_IDS,
  KIMI_TASK_MODEL,
  executeKimiTextTask,
} from "./providers/kimi.ts";
import {
  parseTencentTokenHubMusicResponse,
  TOKENHUB_MAX_AUDIO_BYTES,
  TOKENHUB_MAX_AUDIO_HEX_CHARACTERS,
  TOKENHUB_MUSIC_MODEL,
  TOKENHUB_MUSIC_OUTPUT_FORMAT,
} from "./providers/tencent-tokenhub-music.ts";
import {
  createPostgresMusicOperationRepository,
  markMusicOperationCompleted,
  markMusicOperationFailed,
  markMusicOperationFinalizing,
  markMusicOperationUnknown,
  markMusicProviderInFlight,
  reserveMusicGenerationOperation,
} from "./music-operation.ts";
import { finalizeGeneratedMusic } from "./music-finalization.ts";
import type {
  AITaskCapability,
  AITaskCapabilityState,
  AITaskExecutionContext,
  AITaskExecutor,
  AITaskId,
} from "./types.ts";

type TaskDefinition = {
  id: AITaskId;
  capability: AITaskCapability;
  serverInstruction: string;
};

const TASK_DEFINITIONS: Readonly<Record<AITaskId, TaskDefinition>> = {
  "music.lyrics_draft": { id: "music.lyrics_draft", capability: "TEXT_REASONING", serverInstruction: "Create a structured first-pass lyric draft from the supplied music brief." },
  "music.lyrics_refine": { id: "music.lyrics_refine", capability: "TEXT_REASONING", serverInstruction: "Refine the supplied lyrics while preserving the user's stated creative intent." },
  "music.creative_brief": { id: "music.creative_brief", capability: "TEXT_REASONING", serverInstruction: "Convert the supplied creative requirement into a structured music brief." },
  "music.song_structure": { id: "music.song_structure", capability: "TEXT_REASONING", serverInstruction: "Propose a structured song-section plan from the supplied lyrics and requirement." },
  "music.prompt_prepare": { id: "music.prompt_prepare", capability: "TEXT_REASONING", serverInstruction: "Prepare a structured downstream music prompt specification without generating music." },
  "music.generate": { id: "music.generate", capability: "MUSIC_GENERATION", serverInstruction: "Generate music from the validated provider-neutral business input." },
  "editor.creative_intent_parse": { id: "editor.creative_intent_parse", capability: "TEXT_REASONING", serverInstruction: "Extract non-executable creative intent clauses from the supplied requirement." },
  "editor.requirements_parse": { id: "editor.requirements_parse", capability: "TEXT_REASONING", serverInstruction: "Parse the supplied editing requirement into a structured editing intent." },
  "editor.subtitle_semantic_plan": { id: "editor.subtitle_semantic_plan", capability: "TEXT_REASONING", serverInstruction: "Analyze supplied subtitle text and return a structured semantic editing plan." },
  "editor.asset_match_plan": { id: "editor.asset_match_plan", capability: "TEXT_REASONING", serverInstruction: "Match supplied text concepts to the supplied asset descriptions only." },
  "editor.timeline_plan": { id: "editor.timeline_plan", capability: "TEXT_REASONING", serverInstruction: "Create a structured timeline plan from the supplied editing information." },
  "editor.editing_brief": { id: "editor.editing_brief", capability: "TEXT_REASONING", serverInstruction: "Create a concise structured editing brief from the supplied requirements." },
};

const DISABLED_CAPABILITY_STATES: Readonly<Record<AITaskCapability, AITaskCapabilityState>> = Object.freeze({
  TEXT_REASONING: "not_enabled",
  VISION: "not_enabled",
  AUDIO_UNDERSTANDING: "not_enabled",
  VIDEO_UNDERSTANDING: "not_enabled",
  MUSIC_GENERATION: "not_enabled",
  VIDEO_GENERATION: "not_enabled",
});

function providerCapabilityRegistration(
  registered: Partial<Readonly<Record<AITaskCapability, AITaskCapabilityState>>> = {},
): Readonly<Record<AITaskCapability, AITaskCapabilityState>> {
  return Object.freeze({
    ...DISABLED_CAPABILITY_STATES,
    ...registered,
  });
}

export type AITaskProviderPolicy = {
  id: AIProviderId;
  capabilities: Readonly<Record<AITaskCapability, AITaskCapabilityState>>;
  model: string | null;
};

type TaskProviderRegistration = {
  capabilities: Readonly<Record<AITaskCapability, AITaskCapabilityState>>;
  model: string | null;
  liveTaskIds: readonly AITaskId[];
  execute?: AITaskExecutor;
  musicFoundation?: Readonly<Record<string, unknown>>;
};

// Keep the validated foundation in the deployed server bundle. Public task
// execution remains independently fail-closed through the empty liveTaskIds gate.
const TOKENHUB_MUSIC_FOUNDATION = Object.freeze({
  outputFormat: TOKENHUB_MUSIC_OUTPUT_FORMAT,
  maxAudioHexCharacters: TOKENHUB_MAX_AUDIO_HEX_CHARACTERS,
  maxAudioBytes: TOKENHUB_MAX_AUDIO_BYTES,
  createOperationRepository: createPostgresMusicOperationRepository,
  reserveOperation: reserveMusicGenerationOperation,
  markProviderInFlight: markMusicProviderInFlight,
  markFinalizing: markMusicOperationFinalizing,
  markCompleted: markMusicOperationCompleted,
  markFailed: markMusicOperationFailed,
  markUnknown: markMusicOperationUnknown,
  parseProviderResult: parseTencentTokenHubMusicResponse,
  finalizeResult: finalizeGeneratedMusic,
});

const TASK_PROVIDER_REGISTRATIONS: Readonly<Record<AIProviderId, TaskProviderRegistration>> = {
  deepseek: {
    capabilities: providerCapabilityRegistration({ TEXT_REASONING: "foundation_ready" }),
    model: DEEPSEEK_TASK_MODEL,
    liveTaskIds: DEEPSEEK_LIVE_TASK_IDS,
    execute: executeDeepSeekTextTask,
  },
  kimi: {
    capabilities: providerCapabilityRegistration({ TEXT_REASONING: "foundation_ready" }),
    model: KIMI_TASK_MODEL,
    liveTaskIds: KIMI_LIVE_TASK_IDS,
    execute: executeKimiTextTask,
  },
  doubao: {
    capabilities: providerCapabilityRegistration({ TEXT_REASONING: "foundation_ready" }),
    model: DOUBAO_TASK_MODEL,
    liveTaskIds: DOUBAO_LIVE_TASK_IDS,
    execute: executeDoubaoTextTask,
  },
  tencent_tokenhub: {
    capabilities: providerCapabilityRegistration({ MUSIC_GENERATION: "foundation_ready" }),
    model: TOKENHUB_MUSIC_MODEL,
    liveTaskIds: [],
    musicFoundation: TOKENHUB_MUSIC_FOUNDATION,
  },
};

export const AI_TASK_PROVIDER_REGISTRY: readonly AITaskProviderPolicy[] = AI_PROVIDER_IDS.map((id) => ({
  id,
  capabilities: TASK_PROVIDER_REGISTRATIONS[id].capabilities,
  model: TASK_PROVIDER_REGISTRATIONS[id].model,
}));

const providerPolicies = new Map<AIProviderId, AITaskProviderPolicy>(AI_TASK_PROVIDER_REGISTRY.map((provider) => [provider.id, provider]));

export function getTaskDefinition(task: AITaskId): TaskDefinition {
  return TASK_DEFINITIONS[task];
}

export function getTaskProviderPolicy(provider: AIProviderId): AITaskProviderPolicy {
  const policy = providerPolicies.get(provider);
  if (!policy) throw new SafeTaskError("PROVIDER_NOT_SUPPORTED_FOR_TASK", "该 AI 服务商不支持此任务。", 400);
  return policy;
}

export function requireCapability(provider: AIProviderId, capability: AITaskCapability): AITaskProviderPolicy {
  const policy = getTaskProviderPolicy(provider);
  if (policy.capabilities[capability] !== "foundation_ready") {
    throw new SafeTaskError("PROVIDER_NOT_SUPPORTED_FOR_TASK", "该服务商的此类能力尚未启用或验证。", 400);
  }
  return policy;
}

export function requireTaskExecutionSupport(
  provider: AIProviderId,
  task: AITaskId,
): void {
  const supported = (TASK_PROVIDER_REGISTRATIONS[provider].liveTaskIds as readonly string[]).includes(task);
  if (!supported) {
    throw new SafeTaskError(
      "PROVIDER_NOT_SUPPORTED_FOR_TASK",
      "该服务商的此项 AI 任务尚未启用。",
      501,
    );
  }
}

export const executeFoundationTask: AITaskExecutor = async () => {
  throw new SafeTaskError("PROVIDER_NOT_SUPPORTED_FOR_TASK", "该服务商的 AI 任务执行尚未启用。", 501);
};

export const executeRegisteredTask: AITaskExecutor = async (
  context: AITaskExecutionContext,
) => {
  requireTaskExecutionSupport(context.provider, context.task);
  const execute = TASK_PROVIDER_REGISTRATIONS[context.provider].execute;
  if (execute) return execute(context);
  throw new SafeTaskError(
    "PROVIDER_NOT_SUPPORTED_FOR_TASK",
    "该服务商的此项 AI 任务尚未启用。",
    501,
  );
};

export type AITaskCapabilityDispatcherDependencies = {
  textReasoningExecutor?: AITaskExecutor;
};

export async function dispatchTaskByCapability(
  context: AITaskExecutionContext,
  dependencies: AITaskCapabilityDispatcherDependencies = {},
) {
  const definition = getTaskDefinition(context.task);
  if (definition.capability !== context.capability) {
    throw new SafeTaskError(
      "PROVIDER_NOT_SUPPORTED_FOR_TASK",
      "AI task capability does not match the registered task policy.",
      400,
    );
  }

  requireCapability(context.provider, definition.capability);
  requireTaskExecutionSupport(context.provider, context.task);

  if (definition.capability === "TEXT_REASONING") {
    return (dependencies.textReasoningExecutor ?? executeRegisteredTask)(context);
  }

  throw new SafeTaskError(
    "PROVIDER_NOT_SUPPORTED_FOR_TASK",
    "The requested AI capability is not enabled.",
    501,
  );
}
