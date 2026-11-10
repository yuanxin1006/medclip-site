export const MUSIC_PROVIDER_ERROR_CLASSES = [
  "POSTPAY_NOT_ENABLED",
  "QUOTA_EXHAUSTED",
  "INSUFFICIENT_BALANCE",
  "MODEL_ACCESS_DENIED",
  "PERMISSION_DENIED",
  "IP_NOT_ALLOWED",
  "INVALID_REQUEST",
  "UNSUPPORTED_FORMAT",
  "REQUEST_TOO_LARGE",
  "CONTENT_FILTERED",
  "RATE_LIMIT",
  "AUTHENTICATION",
  "PAYMENT_OR_QUOTA",
  "UPSTREAM_ERROR",
  "UPSTREAM_TIMEOUT",
  "NETWORK_ERROR",
  "TIMEOUT",
  "HTTP_ERROR",
  "BUSINESS_ERROR",
  "MALFORMED_JSON",
  "SUCCESS_SCHEMA_MISMATCH",
  "NOT_COMPLETED",
  "UNKNOWN",
] as const;

export const MUSIC_PROVIDER_FAILURE_STAGES = [
  "FETCH_DISPATCHED",
  "RESPONSE_RECEIVED",
  "HTTP_VALIDATED",
  "JSON_PARSED",
  "BUSINESS_STATUS_CHECKED",
  "SUCCESS_CORE_VALIDATED",
] as const;

export const MUSIC_PROVIDER_RESPONSE_CLASSIFICATIONS = [
  "NO_RESPONSE",
  "HTTP_ERROR_JSON",
  "HTTP_ERROR_NON_JSON",
  "BUSINESS_ERROR",
  "MALFORMED_JSON",
  "SUCCESS_SCHEMA_MISMATCH",
  "NOT_COMPLETED",
  "UNKNOWN",
] as const;

export type MusicProviderErrorClass = typeof MUSIC_PROVIDER_ERROR_CLASSES[number];
export type MusicProviderFailureStage = typeof MUSIC_PROVIDER_FAILURE_STAGES[number];
export type MusicProviderResponseClassification =
  typeof MUSIC_PROVIDER_RESPONSE_CLASSIFICATIONS[number];

export const MUSIC_PROVIDER_REQUEST_FIELD_TYPES = [
  "missing",
  "null",
  "array",
  "object",
  "string",
  "number",
  "boolean",
] as const;

export type MusicProviderRequestFieldType = typeof MUSIC_PROVIDER_REQUEST_FIELD_TYPES[number];

export type MusicProviderRequestFieldDiagnostics = Readonly<{
  present: boolean;
  type: MusicProviderRequestFieldType;
  valid: boolean;
  length?: number;
  enumValid?: boolean;
}>;

export type MusicProviderRequestShapeDiagnostics = Readonly<{
  inputMode: "custom_lyrics" | "instrumental";
  fields: Readonly<{
    model: MusicProviderRequestFieldDiagnostics;
    output_format: MusicProviderRequestFieldDiagnostics;
    audio_setting: MusicProviderRequestFieldDiagnostics;
    prompt: MusicProviderRequestFieldDiagnostics;
    lyrics: MusicProviderRequestFieldDiagnostics;
    is_instrumental: MusicProviderRequestFieldDiagnostics;
  }>;
  audioSettingFields: Readonly<{
    sample_rate: MusicProviderRequestFieldDiagnostics;
    bitrate: MusicProviderRequestFieldDiagnostics;
    format: MusicProviderRequestFieldDiagnostics;
  }>;
}>;

export type MusicProviderFailureDiagnostics = Readonly<{
  providerResponseReceived: boolean;
  providerHttpStatus?: number;
  providerErrorCode?: string;
  providerRequestId?: string;
  providerTraceId?: string;
  providerErrorClass: MusicProviderErrorClass;
  providerFailureStage: MusicProviderFailureStage;
  providerResponseClassification: MusicProviderResponseClassification;
  providerResponseJsonParseable: boolean;
  providerRequestDurationMs: number;
  requestShape?: MusicProviderRequestShapeDiagnostics;
}>;

export type MusicProviderFailureDiagnosticsRow = Readonly<{
  provider_response_received: boolean;
  provider_http_status?: number;
  provider_error_code?: string;
  provider_request_id?: string;
  provider_trace_id?: string;
  provider_error_class: MusicProviderErrorClass;
  provider_failure_stage: MusicProviderFailureStage;
  provider_response_classification: MusicProviderResponseClassification;
  provider_response_json_parseable: boolean;
  provider_request_duration_ms: number;
  request_shape?: Readonly<Record<string, unknown>>;
}>;

const SAFE_PROVIDER_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_PROVIDER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PROVIDER_REQUEST_DURATION_MS = 300_000;
const MAX_REQUEST_FIELD_LENGTH = 10_000;
const REQUEST_SHAPE_FIELDS = [
  "model",
  "output_format",
  "audio_setting",
  "prompt",
  "lyrics",
  "is_instrumental",
] as const;
const REQUEST_SHAPE_AUDIO_FIELDS = ["sample_rate", "bitrate", "format"] as const;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function normalizeRequestFieldDiagnostics(value: unknown): MusicProviderRequestFieldDiagnostics {
  if (!plainRecord(value)) throw new Error("Invalid music Provider request diagnostics.");
  const allowed = new Set(["present", "type", "valid", "length", "enum_valid"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Invalid music Provider request diagnostics.");
  }
  const present = value.present;
  const type = value.type;
  const valid = value.valid;
  if (
    typeof present !== "boolean"
    || !isOneOf(type, MUSIC_PROVIDER_REQUEST_FIELD_TYPES)
    || typeof valid !== "boolean"
    || present !== (type !== "missing")
  ) {
    throw new Error("Invalid music Provider request diagnostics.");
  }
  let length: number | undefined;
  if (value.length !== undefined) {
    if (
      typeof value.length !== "number"
      || !Number.isSafeInteger(value.length)
      || value.length < 0
      || value.length > MAX_REQUEST_FIELD_LENGTH
      || type !== "string"
    ) {
      throw new Error("Invalid music Provider request diagnostics.");
    }
    length = value.length;
  }
  let enumValid: boolean | undefined;
  if (value.enum_valid !== undefined) {
    if (typeof value.enum_valid !== "boolean") {
      throw new Error("Invalid music Provider request diagnostics.");
    }
    enumValid = value.enum_valid;
  }
  return {
    present,
    type,
    valid,
    ...(length === undefined ? {} : { length }),
    ...(enumValid === undefined ? {} : { enumValid }),
  };
}

function normalizeNamedRequestFields<T extends readonly string[]>(
  value: unknown,
  names: T,
): Readonly<Record<T[number], MusicProviderRequestFieldDiagnostics>> {
  if (!plainRecord(value)) throw new Error("Invalid music Provider request diagnostics.");
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== names.length
    || actualKeys.some((key) => !(names as readonly string[]).includes(key))
    || names.some((name) => !Object.hasOwn(value, name))
  ) {
    throw new Error("Invalid music Provider request diagnostics.");
  }
  const result: Record<string, MusicProviderRequestFieldDiagnostics> = {};
  for (const name of names) result[name] = normalizeRequestFieldDiagnostics(value[name]);
  return result as Readonly<Record<T[number], MusicProviderRequestFieldDiagnostics>>;
}

function normalizeRequestShapeDiagnostics(
  value: unknown,
): MusicProviderRequestShapeDiagnostics {
  if (!plainRecord(value)) throw new Error("Invalid music Provider request diagnostics.");
  const allowed = new Set(["input_mode", "fields", "audio_setting_fields"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Invalid music Provider request diagnostics.");
  }
  if (value.input_mode !== "custom_lyrics" && value.input_mode !== "instrumental") {
    throw new Error("Invalid music Provider request diagnostics.");
  }
  const fields = normalizeNamedRequestFields(value.fields, REQUEST_SHAPE_FIELDS);
  const audioSettingFields = normalizeNamedRequestFields(
    value.audio_setting_fields,
    REQUEST_SHAPE_AUDIO_FIELDS,
  );
  return {
    inputMode: value.input_mode,
    fields: fields as MusicProviderRequestShapeDiagnostics["fields"],
    audioSettingFields: audioSettingFields as MusicProviderRequestShapeDiagnostics["audioSettingFields"],
  };
}

function serializeRequestFieldDiagnostics(
  value: MusicProviderRequestFieldDiagnostics,
): Readonly<Record<string, unknown>> {
  return {
    present: value.present,
    type: value.type,
    valid: value.valid,
    ...(value.length === undefined ? {} : { length: value.length }),
    ...(value.enumValid === undefined ? {} : { enum_valid: value.enumValid }),
  };
}

function serializeRequestShapeDiagnostics(
  value: MusicProviderRequestShapeDiagnostics,
): Readonly<Record<string, unknown>> {
  const serializeFields = (
    fields: Readonly<Record<string, MusicProviderRequestFieldDiagnostics>>,
  ) => Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name, serializeRequestFieldDiagnostics(field)]),
  );
  return {
    input_mode: value.inputMode,
    fields: serializeFields(value.fields),
    audio_setting_fields: serializeFields(value.audioSettingFields),
  };
}

export function normalizeMusicProviderFailureDiagnostics(
  value: MusicProviderFailureDiagnostics,
): MusicProviderFailureDiagnostics {
  const duration = Number.isFinite(value.providerRequestDurationMs)
    ? Math.round(Math.max(0, value.providerRequestDurationMs) * 100) / 100
    : Number.NaN;
  if (
    typeof value.providerResponseReceived !== "boolean"
    || !isOneOf(value.providerErrorClass, MUSIC_PROVIDER_ERROR_CLASSES)
    || !isOneOf(value.providerFailureStage, MUSIC_PROVIDER_FAILURE_STAGES)
    || !isOneOf(value.providerResponseClassification, MUSIC_PROVIDER_RESPONSE_CLASSIFICATIONS)
    || typeof value.providerResponseJsonParseable !== "boolean"
    || !Number.isFinite(duration)
    || duration > MAX_PROVIDER_REQUEST_DURATION_MS
    || (value.providerHttpStatus !== undefined
      && (!Number.isInteger(value.providerHttpStatus)
        || value.providerHttpStatus < 100
        || value.providerHttpStatus > 599))
    || (!value.providerResponseReceived && value.providerHttpStatus !== undefined)
    || (value.providerErrorCode !== undefined
      && !SAFE_PROVIDER_ERROR_CODE.test(value.providerErrorCode))
    || (value.providerRequestId !== undefined
      && !SAFE_PROVIDER_IDENTIFIER.test(value.providerRequestId))
    || (value.providerTraceId !== undefined
      && !SAFE_PROVIDER_IDENTIFIER.test(value.providerTraceId))
  ) {
    throw new Error("Invalid music Provider failure diagnostics.");
  }
  const requestShape = value.requestShape === undefined
    ? undefined
    : normalizeRequestShapeDiagnostics(serializeRequestShapeDiagnostics(value.requestShape));
  return Object.freeze({
    providerResponseReceived: value.providerResponseReceived,
    ...(value.providerHttpStatus !== undefined
      ? { providerHttpStatus: value.providerHttpStatus }
      : {}),
    ...(value.providerErrorCode !== undefined
      ? { providerErrorCode: value.providerErrorCode }
      : {}),
    ...(value.providerRequestId !== undefined
      ? { providerRequestId: value.providerRequestId }
      : {}),
    ...(value.providerTraceId !== undefined
      ? { providerTraceId: value.providerTraceId }
      : {}),
    providerErrorClass: value.providerErrorClass,
    providerFailureStage: value.providerFailureStage,
    providerResponseClassification: value.providerResponseClassification,
    providerResponseJsonParseable: value.providerResponseJsonParseable,
    providerRequestDurationMs: duration,
    ...(requestShape === undefined ? {} : { requestShape }),
  });
}

export function serializeMusicProviderFailureDiagnostics(
  value: MusicProviderFailureDiagnostics,
): MusicProviderFailureDiagnosticsRow {
  const normalized = normalizeMusicProviderFailureDiagnostics(value);
  return {
    provider_response_received: normalized.providerResponseReceived,
    ...(normalized.providerHttpStatus !== undefined
      ? { provider_http_status: normalized.providerHttpStatus }
      : {}),
    ...(normalized.providerErrorCode !== undefined
      ? { provider_error_code: normalized.providerErrorCode }
      : {}),
    ...(normalized.providerRequestId !== undefined
      ? { provider_request_id: normalized.providerRequestId }
      : {}),
    ...(normalized.providerTraceId !== undefined
      ? { provider_trace_id: normalized.providerTraceId }
      : {}),
    provider_error_class: normalized.providerErrorClass,
    provider_failure_stage: normalized.providerFailureStage,
    provider_response_classification: normalized.providerResponseClassification,
    provider_response_json_parseable: normalized.providerResponseJsonParseable,
    provider_request_duration_ms: normalized.providerRequestDurationMs,
    ...(normalized.requestShape === undefined
      ? {}
      : { request_shape: serializeRequestShapeDiagnostics(normalized.requestShape) }),
  };
}

export function parseMusicProviderFailureDiagnostics(
  value: unknown,
): MusicProviderFailureDiagnostics | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid music Provider failure diagnostics.");
  }
  const row = value as Record<string, unknown>;
  const allowed = new Set([
    "provider_response_received",
    "provider_http_status",
    "provider_error_code",
    "provider_request_id",
    "provider_trace_id",
    "provider_error_class",
    "provider_failure_stage",
    "provider_response_classification",
    "provider_response_json_parseable",
    "provider_request_duration_ms",
    "request_shape",
  ]);
  if (Object.keys(row).some((key) => !allowed.has(key))) {
    throw new Error("Invalid music Provider failure diagnostics.");
  }
  return normalizeMusicProviderFailureDiagnostics({
    providerResponseReceived: row.provider_response_received as boolean,
    ...(row.provider_http_status !== undefined
      ? { providerHttpStatus: row.provider_http_status as number }
      : {}),
    ...(row.provider_error_code !== undefined
      ? { providerErrorCode: row.provider_error_code as string }
      : {}),
    ...(row.provider_request_id !== undefined
      ? { providerRequestId: row.provider_request_id as string }
      : {}),
    ...(row.provider_trace_id !== undefined
      ? { providerTraceId: row.provider_trace_id as string }
      : {}),
    providerErrorClass: row.provider_error_class as MusicProviderErrorClass,
    providerFailureStage: row.provider_failure_stage as MusicProviderFailureStage,
    providerResponseClassification:
      row.provider_response_classification as MusicProviderResponseClassification,
    providerResponseJsonParseable: row.provider_response_json_parseable as boolean,
    providerRequestDurationMs: row.provider_request_duration_ms as number,
    ...(row.request_shape !== undefined
      ? { requestShape: normalizeRequestShapeDiagnostics(row.request_shape) }
      : {}),
  });
}
