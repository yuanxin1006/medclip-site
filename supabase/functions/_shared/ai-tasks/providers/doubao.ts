import { fixedProviderHTTPDiagnostic } from "../provider-http-diagnostic.ts";
import {
  SafeTaskError,
  type AITaskStatus,
  type SafeTaskDiagnostic,
  type SafeTaskFailureStage,
} from "../errors.ts";
import type {
  AITaskExecutionContext,
  AITaskExecutor,
  AITaskId,
  AITaskResultValue,
  SafeTaskUsage,
} from "../types.ts";
import { DOUBAO_FIXED_TEXT_MODEL } from "../../doubao-policy.ts";
import {
  EDITOR_REQUIREMENTS_PLAN_SCHEMA,
  EDITOR_REQUIREMENTS_TASK_INSTRUCTION,
  normalizeEditorRequirementsJSONText,
  validateEditorRequirementsPlan,
} from "../editor-requirements-plan.ts";
import {
  EDITOR_CREATIVE_INTENT_SCHEMA,
  EDITOR_CREATIVE_INTENT_TASK_INSTRUCTION,
  validateEditorCreativeIntentPlan,
} from "../editor-creative-intent-plan.ts";
import {
  readTextProviderJSON,
  textFailureObservation,
  TextProviderResponseReadError,
  UPSTREAM_HTTP_FAILURE_OBSERVATION,
} from "../text-provider-response.ts";

export const DOUBAO_TASK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DOUBAO_TASK_ENDPOINT = `${DOUBAO_TASK_BASE_URL}/chat/completions`;
export const DOUBAO_TASK_MODEL = DOUBAO_FIXED_TEXT_MODEL;
export const DOUBAO_THINKING_MODE = "disabled" as const;

export const DOUBAO_LIVE_TASK_IDS = [
  "music.creative_brief",
  "editor.creative_intent_parse",
  "editor.requirements_parse",
] as const satisfies readonly AITaskId[];

type DoubaoLiveTaskId = typeof DOUBAO_LIVE_TASK_IDS[number];
type JSONSchema = Readonly<Record<string, unknown>>;
type DoubaoRequestBody = {
  model: string;
  messages: readonly [
    { readonly role: "system"; readonly content: string },
    { readonly role: "user"; readonly content: string },
  ];
  max_tokens: number;
  stream: false;
  thinking: { readonly type: typeof DOUBAO_THINKING_MODE };
  response_format: {
    readonly type: "json_schema";
    readonly json_schema: {
      readonly name: string;
      readonly description: string;
      readonly strict: true;
      readonly schema: JSONSchema;
    };
  };
};

const MUSIC_RESULT_KEYS = [
  "concept", "theme", "mood", "structure", "lyricDirection",
  "arrangementDirection", "notes",
] as const;
const stringSchema = Object.freeze({ type: "string", minLength: 1, maxLength: 2_000 });
const stringArraySchema = Object.freeze({
  type: "array",
  maxItems: 16,
  items: { type: "string", minLength: 1, maxLength: 1_000 },
});

export const MUSIC_SCHEMA: JSONSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    concept: stringSchema,
    theme: stringSchema,
    mood: stringSchema,
    structure: stringArraySchema,
    lyricDirection: stringArraySchema,
    arrangementDirection: stringArraySchema,
    notes: stringArraySchema,
  },
  required: [...MUSIC_RESULT_KEYS],
});

export const EDITOR_SCHEMA: JSONSchema = EDITOR_REQUIREMENTS_PLAN_SCHEMA;

const TASK_INSTRUCTIONS: Readonly<Record<DoubaoLiveTaskId, string>> = {
  "music.creative_brief": [
    "Create a concise structured music creative brief from the supplied business fields.",
    "This is text planning only. Do not claim that music or audio has been generated.",
    "Return only the structured object required by the supplied JSON Schema.",
    "Arrays may be empty. Do not include markdown or additional fields.",
  ].join("\n"),
  "editor.requirements_parse": EDITOR_REQUIREMENTS_TASK_INSTRUCTION.join("\n"),
  "editor.creative_intent_parse": EDITOR_CREATIVE_INTENT_TASK_INSTRUCTION.join("\n"),
};

function isLiveTask(task: AITaskId): task is DoubaoLiveTaskId {
  return (DOUBAO_LIVE_TASK_IDS as readonly AITaskId[]).includes(task);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function taskDiagnostic(
  failureStage: SafeTaskFailureStage,
  details: Omit<SafeTaskDiagnostic, "provider" | "failureStage" | "providerCallCount"> = {},
  providerCallCount: 0 | 1 = 1,
): SafeTaskDiagnostic {
  return { provider: "doubao", failureStage, providerCallCount, ...details };
}

function failProviderTask(
  code: AITaskStatus,
  message: string,
  httpStatus: number,
  failureStage: SafeTaskFailureStage,
  details?: Omit<SafeTaskDiagnostic, "provider" | "failureStage" | "providerCallCount">,
): never {
  throw new SafeTaskError(code, message, httpStatus, taskDiagnostic(failureStage, {
    ...textFailureObservation(code, failureStage),
    ...details,
  }));
}

function schemaMismatch(missingFields: readonly string[], invalidFields: readonly string[]): never {
  failProviderTask(
    "PROVIDER_SCHEMA_MISMATCH",
    "豆包返回的结构不符合任务要求。",
    502,
    "schema_validation",
    { missingFields, invalidFields, httpStatus: 200 },
  );
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!plainRecord(value)) schemaMismatch([], [field]);
  return value;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], prefix = ""): void {
  const actual = Object.keys(record);
  const missingFields = keys
    .filter((key) => !Object.prototype.hasOwnProperty.call(record, key))
    .map((key) => `${prefix}${key}`);
  const invalidFields = actual.some((key) => !keys.includes(key)) ? [`${prefix}$unknown`] : [];
  if (missingFields.length || invalidFields.length) schemaMismatch(missingFields, invalidFields);
}

function safeString(value: unknown, field: string, maxLength = 2_000): string {
  if (typeof value !== "string") schemaMismatch([], [field]);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /\u0000/.test(normalized)) schemaMismatch([], [field]);
  return normalized;
}

function safeStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 16) schemaMismatch([], [field]);
  return value.map((item) => safeString(item, field, 1_000));
}

function safePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 600) {
    schemaMismatch([], [field]);
  }
  return value;
}

function validateMusicCreativeBrief(value: unknown): Readonly<Record<string, AITaskResultValue>> {
  const record = requireRecord(value, "$root");
  requireExactKeys(record, MUSIC_RESULT_KEYS);
  return {
    concept: safeString(record.concept, "concept"),
    theme: safeString(record.theme, "theme"),
    mood: safeString(record.mood, "mood"),
    structure: safeStringArray(record.structure, "structure"),
    lyricDirection: safeStringArray(record.lyricDirection, "lyricDirection"),
    arrangementDirection: safeStringArray(record.arrangementDirection, "arrangementDirection"),
    notes: safeStringArray(record.notes, "notes"),
  };
}

function validateEditorRequirements(value: unknown, editorContext?: unknown): Readonly<Record<string, AITaskResultValue>> {
  return validateEditorRequirementsPlan(value, schemaMismatch, editorContext);
}

function normalizeUsage(value: unknown): SafeTaskUsage | null {
  if (!plainRecord(value)) return null;
  const tokenCount = (item: unknown): number | null =>
    Number.isSafeInteger(item) && Number(item) >= 0 ? Number(item) : null;
  return {
    input_tokens: tokenCount(value.prompt_tokens),
    output_tokens: tokenCount(value.completion_tokens),
    total_tokens: tokenCount(value.total_tokens),
  };
}

async function errorForHTTPResponse(response: Response, apiKey: string): Promise<SafeTaskError> {
  const { providerErrorCode } = await fixedProviderHTTPDiagnostic(response, [apiKey]);
  const details = {
    ...UPSTREAM_HTTP_FAILURE_OBSERVATION,
    httpStatus: response.status,
    ...(providerErrorCode ? { providerErrorCode } : {}),
  };
  const normalizedCode = providerErrorCode?.toLowerCase() ?? "";
  if (response.status === 402 || /quota|balance|billing|payment|insufficient/.test(normalizedCode)) {
    return new SafeTaskError(
      "PROVIDER_PAYMENT_OR_QUOTA_ERROR",
      "豆包账户余额或配额不足。",
      402,
      taskDiagnostic("provider_response", details),
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new SafeTaskError(
      "PROVIDER_AUTH_ERROR",
      "保存的豆包 API Key 无效或没有访问权限。",
      401,
      taskDiagnostic("provider_response", details),
    );
  }
  if (response.status === 429) {
    return new SafeTaskError(
      "PROVIDER_RATE_LIMIT",
      "豆包请求频率受限，请稍后手动重试。",
      429,
      taskDiagnostic("provider_response", details),
    );
  }
  if (response.status === 400 || response.status === 404 || response.status === 422) {
    return new SafeTaskError(
      "PROVIDER_BAD_REQUEST",
      "豆包拒绝了当前固定任务请求。",
      502,
      taskDiagnostic("provider_response", details),
    );
  }
  return new SafeTaskError(
    "PROVIDER_HTTP_ERROR",
    "豆包暂时无法完成请求。",
    502,
    taskDiagnostic("provider_response", details),
  );
}

function structuredResponse(task: DoubaoLiveTaskId): DoubaoRequestBody["response_format"] {
  return {
    type: "json_schema",
    json_schema: {
      name: task === "music.creative_brief"
        ? "medclip_music_creative_brief"
        : task === "editor.creative_intent_parse"
          ? "medclip_editor_creative_intent_parse"
          : "medclip_editor_requirements_parse",
      description: task === "music.creative_brief"
        ? "A sanitized MedClip music planning brief."
        : task === "editor.creative_intent_parse"
          ? "Non-executable MedClip creative-intent clauses."
          : "A sanitized MedClip text-only editing plan preview.",
      strict: true,
      schema: task === "music.creative_brief" ? MUSIC_SCHEMA
        : task === "editor.creative_intent_parse" ? EDITOR_CREATIVE_INTENT_SCHEMA : EDITOR_SCHEMA,
    },
  };
}

export function buildDoubaoTaskRequest(context: AITaskExecutionContext): {
  url: typeof DOUBAO_TASK_ENDPOINT;
  init: RequestInit;
  body: DoubaoRequestBody;
} {
  if (
    context.provider !== "doubao"
    || !isLiveTask(context.task)
    || context.serverControlledModel !== DOUBAO_TASK_MODEL
  ) {
    throw new SafeTaskError(
      "PROVIDER_NOT_SUPPORTED_FOR_TASK",
      "该服务商的此项 AI 任务尚未启用。",
      501,
    );
  }
  const body: DoubaoRequestBody = {
    model: DOUBAO_TASK_MODEL,
    messages: [
      { role: "system", content: `${context.serverInstruction}\n\n${TASK_INSTRUCTIONS[context.task]}` },
      { role: "user", content: JSON.stringify({ task: context.task, input: context.input }) },
    ],
    max_tokens: context.budget.maxOutputTokens,
    stream: false,
    thinking: { type: DOUBAO_THINKING_MODE },
    response_format: structuredResponse(context.task),
  };
  return {
    url: DOUBAO_TASK_ENDPOINT,
    body,
    init: {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${context.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
    },
  };
}

export function createDoubaoTextTaskExecutor(fetcher: typeof fetch = fetch): AITaskExecutor {
  return async (context) => {
    const request = buildDoubaoTaskRequest(context);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), context.budget.timeoutMs);
    let response: Response;
    try {
      response = await fetcher(request.url, { ...request.init, signal: controller.signal });
    } catch {
      if (controller.signal.aborted) {
        failProviderTask("PROVIDER_TIMEOUT", "豆包文本任务超时，请稍后手动重试。", 504, "provider_request");
      }
      failProviderTask("NETWORK_ERROR", "无法连接豆包，请稍后手动重试。", 503, "provider_request");
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw await errorForHTTPResponse(response, context.apiKey);

    let payload: unknown;
    try {
      payload = await readTextProviderJSON(response);
    } catch (error) {
      failProviderTask(
        "PROVIDER_INVALID_JSON",
        error instanceof TextProviderResponseReadError && error.kind === "body_read"
          ? "豆包返回内容读取失败。"
          : "豆包返回的 HTTP 内容不是有效 JSON。",
        502,
        "provider_response",
        {
          httpStatus: response.status,
          ...(error instanceof TextProviderResponseReadError && error.kind === "body_read"
            ? { failureClass: "UPSTREAM_BODY_READ_ERROR" as const }
            : {}),
        },
      );
    }
    if (!plainRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
      failProviderTask(
        "PROVIDER_EMPTY_CONTENT",
        "豆包没有返回可用的 assistant content。",
        502,
        "provider_response",
        { httpStatus: response.status },
      );
    }
    const firstChoice = payload.choices[0];
    if (!plainRecord(firstChoice) || !plainRecord(firstChoice.message)) {
      failProviderTask(
        "PROVIDER_EMPTY_CONTENT",
        "豆包没有返回可用的 assistant content。",
        502,
        "provider_response",
        { httpStatus: response.status },
      );
    }
    if (firstChoice.finish_reason === "length") schemaMismatch([], ["$truncated"]);
    if (firstChoice.finish_reason !== "stop") schemaMismatch([], ["$finish_reason"]);
    const content = firstChoice.message.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      failProviderTask(
        "PROVIDER_EMPTY_CONTENT",
        "豆包返回了空的 assistant content。",
        502,
        "provider_response",
        { httpStatus: response.status },
      );
    }

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(
        context.task === "editor.requirements_parse"
          ? normalizeEditorRequirementsJSONText(content)
          : content,
      );
    } catch {
      failProviderTask(
        "PROVIDER_INVALID_JSON",
        "豆包 assistant content 不是有效 JSON。",
        502,
        "json_parse",
        { httpStatus: response.status },
      );
    }

    const data = context.task === "music.creative_brief"
      ? validateMusicCreativeBrief(parsedContent)
      : context.task === "editor.creative_intent_parse"
        ? validateEditorCreativeIntentPlan(parsedContent, schemaMismatch, context.input.editingRequirement)
        : validateEditorRequirements(parsedContent, context.input.editorContext);
    return { data, generationOccurred: true, usage: normalizeUsage(payload.usage) };
  };
}

export const executeDoubaoTextTask = createDoubaoTextTaskExecutor();
