import type { AITaskId } from "./types.ts";

export const TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS = 120_000;

export const MAX_AI_TASK_REQUEST_BYTES = 64 * 1024;

export type AITaskBudget = {
  maxInputCharacters: number;
  maxArrayItems: number;
  maxArrayItemCharacters: number;
  maxOutputTokens: number;
  timeoutMs: number;
  automaticProviderRetryCount: 0;
  maxProviderCalls: 1;
};

const DEFAULT_TEXT_REASONING_BUDGET: AITaskBudget = Object.freeze({
  maxInputCharacters: 24_000,
  maxArrayItems: 24,
  maxArrayItemCharacters: 1_000,
  maxOutputTokens: 2_048,
  timeoutMs: 30_000,
  automaticProviderRetryCount: 0,
  maxProviderCalls: 1,
});

const TASK_BUDGETS: Partial<Readonly<Record<AITaskId, AITaskBudget>>> = {
  "music.creative_brief": Object.freeze({
    ...DEFAULT_TEXT_REASONING_BUDGET,
    maxOutputTokens: 900,
  }),
  "editor.requirements_parse": Object.freeze({
    ...DEFAULT_TEXT_REASONING_BUDGET,
    maxOutputTokens: 700,
  }),
  "editor.creative_intent_parse": Object.freeze({
    ...DEFAULT_TEXT_REASONING_BUDGET,
    maxOutputTokens: 900,
  }),
  "music.generate": Object.freeze({
    maxInputCharacters: 5_900,
    maxArrayItems: 0,
    maxArrayItemCharacters: 0,
    maxOutputTokens: 0,
    // The hosted request idle timeout is 150 seconds. Keep a fixed 30-second
    // margin for authentication, durable state, validation, and finalization.
    timeoutMs: TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS,
    automaticProviderRetryCount: 0,
    maxProviderCalls: 1,
  }),
};

export function getTaskBudget(task: AITaskId): AITaskBudget {
  return TASK_BUDGETS[task] ?? DEFAULT_TEXT_REASONING_BUDGET;
}
