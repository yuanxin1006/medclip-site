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
import {
  EDITOR_REQUIREMENTS_TASK_INSTRUCTION,
  normalizeEditorRequirementsJSONText,
  validateEditorRequirementsPlan,
} from "../editor-requirements-plan.ts";
import {
  EDITOR_CREATIVE_INTENT_TASK_INSTRUCTION,
  validateEditorCreativeIntentPlan,
} from "../editor-creative-intent-plan.ts";
import {
  readTextProviderJSON,
  textFailureObservation,
  TextProviderResponseReadError,
  UPSTREAM_HTTP_FAILURE_OBSERVATION,
} from "../text-provider-response.ts";

export const KIMI_TASK_BASE_URL = "https://api.moonshot.cn/v1";
export const KIMI_TASK_ENDPOINT = `${KIMI_TASK_BASE_URL}/chat/completions`;
export const KIMI_TASK_MODEL = "kimi-k2.6";
export const KIMI_THINKING_MODE = "disabled" as const;

export const KIMI_LIVE_TASK_IDS = [
  "music.creative_brief",
  "editor.creative_intent_parse",
  "editor.requirements_parse",
] as const satisfies readonly AITaskId[];

type KimiLiveTaskId = typeof KIMI_LIVE_TASK_IDS[number];
type KimiRequestBody = {
  model: typeof KIMI_TASK_MODEL;
  messages: readonly [
    { readonly role: "system"; readonly content: string },
    { readonly role: "user"; readonly content: string },
  ];
  max_completion_tokens: number;
  stream: false;
  thinking: { readonly type: typeof KIMI_THINKING_MODE };
  response_format: { readonly type: "json_object" };
};

const MUSIC_RESULT_KEYS = [
  "concept", "theme", "mood", "structure", "lyricDirection",
  "arrangementDirection", "notes",
] as const;
const TASK_INSTRUCTIONS: Readonly<Record<KimiLiveTaskId, string>> = {
  "music.creative_brief": [
    "Create a concise structured music creative brief from the supplied business fields.",
    "This is text planning only. Do not claim that music or audio has been generated.",
    "Return one JSON object only, with no markdown fence or extra text.",
    "Required fields: concept, theme, mood, structure, lyricDirection, arrangementDirection, notes.",
    "The first three fields are non-empty strings; all remaining fields are arrays of strings and may be empty.",
    '{"concept":"gentle recovery","theme":"care","mood":"warm","structure":[],"lyricDirection":[],"arrangementDirection":[],"notes":[]}',
  ].join("\n"),
  "editor.requirements_parse": EDITOR_REQUIREMENTS_TASK_INSTRUCTION.join("\n"),
  "editor.creative_intent_parse": EDITOR_CREATIVE_INTENT_TASK_INSTRUCTION.join("\n"),
};

function isLiveTask(task: AITaskId): task is KimiLiveTaskId {
  return (KIMI_LIVE_TASK_IDS as readonly AITaskId[]).includes(task);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function taskDiagnostic(
  failureStage: SafeTaskFailureStage,
  details: Omit<SafeTaskDiagnostic, "provider" | "failureStage" | "providerCallCount"> = {},
): SafeTaskDiagnostic {
  return { provider: "kimi", failureStage, providerCallCount: 1, ...details };
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
    "Kimi returned a result that does not match the required task schema.",
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
  if (!normalized || normalized.length > maxLength || /\u0000/.test(normalized)) {
    schemaMismatch([], [field]);
  }
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
  const readTokenCount = (tokenValue: unknown): number | null =>
    Number.isSafeInteger(tokenValue) && Number(tokenValue) >= 0 ? Number(tokenValue) : null;
  return {
    input_tokens: readTokenCount(value.prompt_tokens),
    output_tokens: readTokenCount(value.completion_tokens),
    total_tokens: readTokenCount(value.total_tokens),
  };
}

async function errorForHTTPResponse(
  response: Response,
  context: AITaskExecutionContext,
): Promise<SafeTaskError> {
  const businessInputValues = Object.values(context.input).flatMap((value) =>
    typeof value === "string" ? [value] : [...value]
  );
  const safeUpstream = await fixedProviderHTTPDiagnostic(response, [context.apiKey, ...businessInputValues]);
  const details = { ...UPSTREAM_HTTP_FAILURE_OBSERVATION, httpStatus: response.status, ...safeUpstream };
  const diagnosticText = `${safeUpstream.providerErrorCode ?? ""} ${safeUpstream.sanitizedProviderErrorMessage ?? ""}`.toLowerCase();
  if (response.status === 402 || /quota|balance|billing|payment|insufficient/.test(diagnosticText)) {
    return new SafeTaskError(
      "PROVIDER_PAYMENT_OR_QUOTA_ERROR",
      "Kimi account quota or balance is insufficient.",
      402,
      taskDiagnostic("provider_response", details),
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new SafeTaskError(
      "PROVIDER_AUTH_ERROR",
      "The saved Kimi credential is invalid or lacks access.",
      401,
      taskDiagnostic("provider_response", details),
    );
  }
  if (response.status === 429) {
    if (/account.?tier|model.?access|not.?allowed|access.?denied|subscription/.test(diagnosticText)) {
      return new SafeTaskError(
        "PROVIDER_CONFIGURATION_REQUIRED",
        "The Kimi account or model access configuration does not permit this request.",
        400,
        taskDiagnostic("provider_response", details),
      );
    }
    if (/capacity|overload|busy/.test(diagnosticText)) {
      return new SafeTaskError(
        "PROVIDER_UNAVAILABLE",
        "Kimi currently has insufficient provider capacity.",
        503,
        taskDiagnostic("provider_response", details),
      );
    }
    return new SafeTaskError(
      "PROVIDER_RATE_LIMIT",
      "Kimi rate-limited this request. Retry manually later.",
      429,
      taskDiagnostic("provider_response", details),
    );
  }
  if (response.status === 400 || response.status === 404 || response.status === 422) {
    return new SafeTaskError(
      "PROVIDER_BAD_REQUEST",
      "Kimi rejected the server-fixed task request.",
      502,
      taskDiagnostic("provider_response", details),
    );
  }
  return new SafeTaskError(
    "PROVIDER_HTTP_ERROR",
    "Kimi could not complete the request.",
    502,
    taskDiagnostic("provider_response", details),
  );
}

export function buildKimiTaskRequest(context: AITaskExecutionContext): {
  url: typeof KIMI_TASK_ENDPOINT;
  init: RequestInit;
  body: KimiRequestBody;
} {
  if (context.provider !== "kimi" || !isLiveTask(context.task) || context.serverControlledModel !== KIMI_TASK_MODEL) {
    throw new SafeTaskError("PROVIDER_NOT_SUPPORTED_FOR_TASK", "This Kimi task is not enabled.", 501);
  }

  const body: KimiRequestBody = {
    model: KIMI_TASK_MODEL,
    messages: [
      { role: "system", content: `${context.serverInstruction}\n\n${TASK_INSTRUCTIONS[context.task]}` },
      { role: "user", content: JSON.stringify({ task: context.task, input: context.input }) },
    ],
    max_completion_tokens: context.budget.maxOutputTokens,
    stream: false,
    thinking: { type: KIMI_THINKING_MODE },
    response_format: { type: "json_object" },
  };

  return {
    url: KIMI_TASK_ENDPOINT,
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

export function createKimiTextTaskExecutor(fetcher: typeof fetch = fetch): AITaskExecutor {
  return async (context) => {
    const request = buildKimiTaskRequest(context);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), context.budget.timeoutMs);
    let response: Response;

    try {
      response = await fetcher(request.url, { ...request.init, signal: controller.signal });
    } catch {
      if (controller.signal.aborted) {
        failProviderTask("PROVIDER_TIMEOUT", "Kimi text task timed out.", 504, "provider_request");
      }
      failProviderTask("NETWORK_ERROR", "Kimi could not be reached.", 503, "provider_request");
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw await errorForHTTPResponse(response, context);

    let payload: unknown;
    try {
      payload = await readTextProviderJSON(response);
    } catch (error) {
      failProviderTask(
        "PROVIDER_INVALID_JSON",
        error instanceof TextProviderResponseReadError && error.kind === "body_read"
          ? "Kimi response body could not be read."
          : "Kimi returned invalid JSON.",
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
      failProviderTask("PROVIDER_EMPTY_CONTENT", "Kimi returned no assistant content.", 502, "provider_response", { httpStatus: response.status });
    }
    const firstChoice = payload.choices[0];
    if (!plainRecord(firstChoice) || !plainRecord(firstChoice.message)) {
      failProviderTask("PROVIDER_EMPTY_CONTENT", "Kimi returned no assistant content.", 502, "provider_response", { httpStatus: response.status });
    }
    if (firstChoice.finish_reason === "length") schemaMismatch([], ["$truncated"]);
    const content = firstChoice.message.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      failProviderTask("PROVIDER_EMPTY_CONTENT", "Kimi returned empty assistant content.", 502, "provider_response", { httpStatus: response.status });
    }

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(
        context.task === "editor.requirements_parse"
          ? normalizeEditorRequirementsJSONText(content)
          : content,
      );
    } catch {
      failProviderTask("PROVIDER_INVALID_JSON", "Kimi assistant content is not valid JSON.", 502, "json_parse", { httpStatus: response.status });
    }

    const data = context.task === "music.creative_brief"
      ? validateMusicCreativeBrief(parsedContent)
      : context.task === "editor.creative_intent_parse"
        ? validateEditorCreativeIntentPlan(parsedContent, schemaMismatch, context.input.editingRequirement)
        : validateEditorRequirements(parsedContent, context.input.editorContext);
    return { data, generationOccurred: true, usage: normalizeUsage(payload.usage) };
  };
}

export const executeKimiTextTask = createKimiTextTaskExecutor();
