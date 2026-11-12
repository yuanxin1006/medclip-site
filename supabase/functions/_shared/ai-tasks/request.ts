import { isProviderId } from "../ai-credentials/providers/registry.ts";
import { getTaskBudget } from "./budget.ts";
import { SafeTaskError } from "./errors.ts";
import { AI_TASK_IDS, type AITaskId, type AITaskInput, type ParsedAITaskRequest } from "./types.ts";

type FieldRule = {
  kind: "string" | "string_array";
  required?: boolean;
  maxLength?: number;
  allowedValues?: readonly string[];
};
type InputSchema = Readonly<Record<string, FieldRule>>;

const TOP_LEVEL_FIELDS = new Set(["task", "provider", "input"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

const INPUT_SCHEMAS: Readonly<Record<AITaskId, InputSchema>> = {
  "music.lyrics_draft": { theme: { kind: "string", required: true }, creativeRequirement: { kind: "string" }, language: { kind: "string" } },
  "music.lyrics_refine": { lyrics: { kind: "string", required: true }, creativeRequirement: { kind: "string" } },
  "music.creative_brief": {
    title: { kind: "string" },
    lyrics: { kind: "string" },
    genre: { kind: "string" },
    mood: { kind: "string" },
    voicePreference: { kind: "string" },
    creativeRequirement: { kind: "string", required: true },
  },
  "music.song_structure": { lyrics: { kind: "string", required: true }, creativeRequirement: { kind: "string" } },
  "music.prompt_prepare": { lyrics: { kind: "string" }, creativeRequirement: { kind: "string", required: true }, style: { kind: "string" }, mood: { kind: "string" } },
  "music.generate": {
    operationId: { kind: "string", required: true, maxLength: 128 },
    mode: { kind: "string", required: true, allowedValues: ["custom_lyrics", "instrumental"] },
    lyrics: { kind: "string", maxLength: 3_500 },
    prompt: { kind: "string", maxLength: 2_000 },
    title: { kind: "string", maxLength: 200 },
  },
  "editor.requirements_parse": {
    editingRequirement: { kind: "string", required: true },
    subtitleText: { kind: "string" },
    assetDescriptions: { kind: "string_array" },
    editorContext: { kind: "string", required: true, maxLength: 24_000 },
  },
  "editor.creative_intent_parse": {
    editingRequirement: { kind: "string", required: true },
  },
  "editor.subtitle_semantic_plan": { subtitleText: { kind: "string", required: true }, editingRequirement: { kind: "string" } },
  "editor.asset_match_plan": { subtitleText: { kind: "string" }, assetDescriptions: { kind: "string_array", required: true }, editingRequirement: { kind: "string" } },
  "editor.timeline_plan": { subtitleText: { kind: "string" }, assetDescriptions: { kind: "string_array" }, editingRequirement: { kind: "string", required: true } },
  "editor.editing_brief": { editingRequirement: { kind: "string", required: true }, subtitleText: { kind: "string" } },
};

function isTaskId(value: unknown): value is AITaskId {
  return typeof value === "string" && (AI_TASK_IDS as readonly string[]).includes(value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function invalidInput(message = "AI 任务输入无效。"): never {
  throw new SafeTaskError("INVALID_INPUT", message, 400);
}

function normalizeInput(task: AITaskId, value: unknown): AITaskInput {
  if (!plainRecord(value)) invalidInput();
  const schema = INPUT_SCHEMAS[task];
  if (Object.keys(value).some((key) => !schema[key])) invalidInput("AI 任务包含不允许的输入字段。");
  const budget = getTaskBudget(task);
  const output: Record<string, string | readonly string[]> = {};
  let totalCharacters = 0;

  for (const [field, rule] of Object.entries(schema)) {
    const raw = value[field];
    if (raw === undefined || raw === null) {
      if (rule.required) invalidInput(`缺少必填输入：${field}。`);
      continue;
    }
    if (rule.kind === "string") {
      if (typeof raw !== "string" || raw.trim().length === 0 || /\u0000/.test(raw)) invalidInput();
      if (rule.maxLength !== undefined && raw.length > rule.maxLength) invalidInput();
      if (rule.allowedValues && !rule.allowedValues.includes(raw)) invalidInput();
      totalCharacters += raw.length;
      output[field] = raw;
      continue;
    }
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > budget.maxArrayItems) invalidInput();
    const values = raw.map((item) => {
      if (typeof item !== "string" || item.trim().length === 0 || item.length > budget.maxArrayItemCharacters || /\u0000/.test(item)) invalidInput();
      totalCharacters += item.length;
      return item;
    });
    output[field] = values;
  }

  if (totalCharacters > budget.maxInputCharacters) throw new SafeTaskError("INVALID_INPUT", "AI 任务输入超过允许长度。", 413);
  if (task === "music.generate") {
    const operationId = output.operationId;
    const mode = output.mode;
    if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) invalidInput();
    if (mode === "custom_lyrics") {
      if (typeof output.lyrics !== "string") invalidInput("自定义歌词模式必须提供歌词。");
    } else if (mode === "instrumental") {
      if (typeof output.prompt !== "string" || output.lyrics !== undefined) {
        invalidInput("纯音乐模式必须提供提示词且不能包含歌词。");
      }
    } else {
      invalidInput();
    }
  }
  return output;
}

export function parseAITaskRequest(value: unknown): ParsedAITaskRequest {
  if (!plainRecord(value)) invalidInput("AI 任务请求格式无效。");
  if (Object.keys(value).some((key) => !TOP_LEVEL_FIELDS.has(key))) invalidInput("AI 任务请求包含不允许的字段。");
  if (!isTaskId(value.task)) throw new SafeTaskError("INVALID_TASK", "不支持的 AI 任务。", 400);
  if (!isProviderId(value.provider)) throw new SafeTaskError("PROVIDER_NOT_SUPPORTED_FOR_TASK", "不支持的 AI 服务商。", 400);
  return { task: value.task, provider: value.provider, input: normalizeInput(value.task, value.input) };
}

export function requireAuthenticatedTaskUserId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new SafeTaskError("UNAUTHENTICATED", "请先登录后再使用 AI 任务。", 401);
  return value.toLowerCase();
}
