import type { MusicProviderFailureDiagnostics } from "./music-failure-diagnostics.ts";

export type AITaskStatus =
  | "UNAUTHENTICATED"
  | "AUTH_REQUIRED"
  | "ORIGIN_NOT_ALLOWED"
  | "METHOD_NOT_ALLOWED"
  | "INVALID_TASK"
  | "INVALID_INPUT"
  | "NOT_CONNECTED"
  | "PROVIDER_NOT_SUPPORTED_FOR_TASK"
  | "PROVIDER_CONFIGURATION_REQUIRED"
  | "OPERATION_CONFLICT"
  | "OPERATION_NOT_FOUND"
  | "MUSIC_PUBLIC_RELEASE_DISABLED"
  | "MUSIC_DAILY_LIMIT_REACHED"
  | "MUSIC_GLOBAL_LIMIT_REACHED"
  | "MUSIC_GENERATION_ALREADY_ACTIVE"
  | "API_KEY_INVALID"
  | "RATE_LIMITED"
  | "REGION_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "TASK_TIMEOUT"
  | "PROVIDER_AUTH_ERROR"
  | "PROVIDER_PAYMENT_OR_QUOTA_ERROR"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_BAD_REQUEST"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_BUSINESS_ERROR"
  | "PROVIDER_EMPTY_CONTENT"
  | "PROVIDER_INVALID_JSON"
  | "PROVIDER_SCHEMA_MISMATCH"
  | "PROVIDER_NOT_COMPLETED"
  | "AUDIO_HEX_INVALID"
  | "AUDIO_REPRESENTATION_UNEXPECTED_URL"
  | "AUDIO_REPRESENTATION_UNEXPECTED_BASE64"
  | "AUDIO_REPRESENTATION_WHITESPACE_WRAPPED"
  | "AUDIO_REPRESENTATION_0X_PREFIXED"
  | "AUDIO_REPRESENTATION_UNKNOWN"
  | "AUDIO_URL_INVALID"
  | "AUDIO_URL_NON_HTTPS"
  | "AUDIO_URL_CREDENTIALS_PRESENT"
  | "AUDIO_URL_PORT_REJECTED"
  | "AUDIO_URL_HOST_REJECTED"
  | "AUDIO_URL_PRIVATE_ADDRESS"
  | "AUDIO_URL_REDIRECT_REJECTED"
  | "AUDIO_DOWNLOAD_TIMEOUT"
  | "AUDIO_DOWNLOAD_HTTP_ERROR"
  | "AUDIO_DOWNLOAD_TOO_LARGE"
  | "AUDIO_DOWNLOAD_CONTENT_TYPE_REJECTED"
  | "AUDIO_DOWNLOAD_FAILED"
  | "AUDIO_HEX_ODD_LENGTH"
  | "AUDIO_HEX_TOO_LARGE"
  | "AUDIO_DECODE_FAILED"
  | "AUDIO_DECODED_TOO_LARGE"
  | "AUDIO_SIZE_MISMATCH"
  | "AUDIO_MP3_INVALID"
  | "FINALIZATION_FAILED"
  | "UNKNOWN_PROVIDER_RESULT"
  | "INTERNAL_TASK_ERROR"
  | "INTERNAL_ERROR";

export type SafeTaskFailureStage =
  | "provider_request"
  | "provider_response"
  | "json_parse"
  | "schema_validation"
  | "internal";

export type SafeTextTaskFailureClass =
  | "UPSTREAM_HTTP_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "UPSTREAM_BODY_READ_ERROR"
  | "UPSTREAM_JSON_PARSE_ERROR"
  | "UPSTREAM_CONTENT_MISSING"
  | "CANONICAL_PARSE_ERROR"
  | "CANONICAL_SCHEMA_ERROR"
  | "SAFE_RESULT_SERIALIZATION_ERROR";

export type SafeMusicStage =
  | "RESPONSE_RECEIVED"
  | "SUCCESS_CORE_VALIDATED"
  | "HEX_VALIDATED"
  | "HEX_DECODED"
  | "SIZE_VALIDATED"
  | "MP3_VALIDATED"
  | "FINALIZING"
  | "COMPLETED";

export type SafeProviderFailureClassification =
  | "POSTPAY_NOT_ENABLED"
  | "QUOTA_EXHAUSTED"
  | "INSUFFICIENT_BALANCE"
  | "MODEL_ACCESS_DENIED"
  | "PERMISSION_DENIED"
  | "IP_NOT_ALLOWED"
  | "INVALID_REQUEST"
  | "UNSUPPORTED_FORMAT"
  | "REQUEST_TOO_LARGE"
  | "CONTENT_FILTERED"
  | "RATE_LIMIT"
  | "AUTHENTICATION"
  | "PAYMENT_OR_QUOTA"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_TIMEOUT"
  | "UNKNOWN";

export type SafeAudioRepresentationDiagnostic = {
  audioType: "string";
  audioCharacterLength: number;
  isEmpty: boolean;
  isEvenLength: boolean;
  isPureHex: boolean;
  hasAsciiWhitespace: boolean;
  hasLeadingOrTrailingWhitespace: boolean;
  has0xPrefix: boolean;
  urlLike: boolean;
  httpUrlLike: boolean;
  httpsUrlLike: boolean;
  dataUriLike: boolean;
  base64Like: boolean;
  trimmedValueWouldBeHex: boolean;
  whitespaceRemovedValueWouldBeHex: boolean;
  zeroXPrefixRemovedValueWouldBeHex: boolean;
  nonHexCharacterClasses: {
    whitespace: number;
    colon: number;
    slash: number;
    dot: number;
    plus: number;
    equals: number;
    hyphen: number;
    underscore: number;
    other: number;
  };
};

export type SafeTaskDiagnostic = {
  provider?: "deepseek" | "kimi" | "doubao" | "tencent_tokenhub";
  failureStage?: SafeTaskFailureStage;
  httpStatus?: number;
  providerErrorCode?: string;
  providerErrorType?: string;
  providerErrorSource?: string;
  providerUpstreamCode?: string;
  providerUpstreamStatus?: string;
  requestId?: string;
  traceId?: string;
  minimaxBaseStatusCode?: number;
  minimaxBaseStatusMessage?: string;
  providerFailureClassification?: SafeProviderFailureClassification;
  sanitizedProviderErrorMessage?: string;
  missingFields?: readonly string[];
  invalidFields?: readonly string[];
  providerCallCount?: 0 | 1;
  responseTopLevelKeys?: readonly string[];
  responseDataPresent?: boolean;
  responseDataType?: string;
  responseAudioPresent?: boolean;
  responseAudioType?: string;
  responseAudioLength?: number;
  responseStatusPresent?: boolean;
  responseStatusType?: string;
  responseStatusValue?: number;
  responseBaseRespPresent?: boolean;
  responseBaseStatusPresent?: boolean;
  responseBaseStatusType?: string;
  responseBaseStatusCode?: number;
  responseExtraInfoPresent?: boolean;
  responseMusicSizePresent?: boolean;
  responseMusicSizeType?: string;
  responseMusicSizeValue?: number;
  responseUsagePresent?: boolean;
  responseRequestIdPresent?: boolean;
  responseTraceIdPresent?: boolean;
  musicStage?: SafeMusicStage;
  audioRepresentation?: SafeAudioRepresentationDiagnostic;
  failureClass?: SafeTextTaskFailureClass;
  providerResponseReceived?: boolean;
  responseJsonParseable?: boolean;
  canonicalValidationReached?: boolean;
};

export class SafeTaskError extends Error {
  readonly code: AITaskStatus;
  readonly httpStatus: number;
  readonly diagnostic?: SafeTaskDiagnostic;
  readonly trustedInternalDiagnostics?: Readonly<Record<string, unknown>>;
  readonly musicProviderFailureDiagnostics?: MusicProviderFailureDiagnostics;

  constructor(
    code: AITaskStatus,
    message: string,
    httpStatus = 400,
    diagnostic?: SafeTaskDiagnostic,
    trustedInternalDiagnostics?: Readonly<Record<string, unknown>>,
    musicProviderFailureDiagnostics?: MusicProviderFailureDiagnostics,
  ) {
    super(message);
    this.name = "SafeTaskError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.diagnostic = diagnostic;
    this.trustedInternalDiagnostics = trustedInternalDiagnostics;
    this.musicProviderFailureDiagnostics = musicProviderFailureDiagnostics;
  }
}

const SAFE_DIAGNOSTIC_VALUE = /^[A-Za-z0-9_$.-]{1,64}$/;
const MAX_SANITIZED_PROVIDER_MESSAGE_LENGTH = 160;
const SAFE_FAILURE_STAGES = new Set<SafeTaskFailureStage>([
  "provider_request",
  "provider_response",
  "json_parse",
  "schema_validation",
  "internal",
]);
const SAFE_PROVIDER_FAILURE_CLASSIFICATIONS = new Set<SafeProviderFailureClassification>([
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
  "UNKNOWN",
]);
const SAFE_MUSIC_STAGES = new Set<SafeMusicStage>([
  "RESPONSE_RECEIVED",
  "SUCCESS_CORE_VALIDATED",
  "HEX_VALIDATED",
  "HEX_DECODED",
  "SIZE_VALIDATED",
  "MP3_VALIDATED",
  "FINALIZING",
  "COMPLETED",
]);

export function sanitizeTaskProviderErrorMessage(
  value: unknown,
  sensitiveValues: readonly string[] = [],
): string | undefined {
  if (typeof value !== "string") return undefined;
  let normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || /[{}\[\]]/.test(normalized)) return undefined;

  for (const sensitive of sensitiveValues) {
    if (sensitive.length >= 4) normalized = normalized.split(sensitive).join("[redacted]");
  }
  normalized = normalized
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|ark)-[A-Za-z0-9._-]{8,}\b/gi, "[redacted]")
    .replace(/\bAIza[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9._-]{12,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .replace(
      /\b(authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|ciphertext|encryption[_ -]?key)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    );
  return normalized.slice(0, MAX_SANITIZED_PROVIDER_MESSAGE_LENGTH);
}

function safeDiagnostic(value: SafeTaskDiagnostic | undefined): SafeTaskDiagnostic | undefined {
  if (!value) return undefined;
  const result: SafeTaskDiagnostic = {};
  if (value.provider === "deepseek" || value.provider === "kimi" || value.provider === "doubao" || value.provider === "tencent_tokenhub") {
    result.provider = value.provider;
  }
  if (value.failureStage && SAFE_FAILURE_STAGES.has(value.failureStage)) {
    result.failureStage = value.failureStage;
  }
  if (Number.isInteger(value.httpStatus) && value.httpStatus! >= 100 && value.httpStatus! <= 599) {
    result.httpStatus = value.httpStatus;
  }
  if (value.providerErrorCode && SAFE_DIAGNOSTIC_VALUE.test(value.providerErrorCode)) {
    result.providerErrorCode = value.providerErrorCode;
  }
  const copySafeValue = (
    key: "providerErrorType" | "providerErrorSource" | "providerUpstreamCode"
      | "providerUpstreamStatus" | "requestId" | "traceId",
  ) => {
    const candidate = value[key];
    if (candidate && SAFE_DIAGNOSTIC_VALUE.test(candidate)) result[key] = candidate;
  };
  copySafeValue("providerErrorType");
  copySafeValue("providerErrorSource");
  copySafeValue("providerUpstreamCode");
  copySafeValue("providerUpstreamStatus");
  copySafeValue("requestId");
  copySafeValue("traceId");
  if (
    Number.isSafeInteger(value.minimaxBaseStatusCode)
    && value.minimaxBaseStatusCode! >= 0
    && value.minimaxBaseStatusCode! <= 999999
  ) {
    result.minimaxBaseStatusCode = value.minimaxBaseStatusCode;
  }
  const minimaxBaseStatusMessage = sanitizeTaskProviderErrorMessage(
    value.minimaxBaseStatusMessage,
  );
  if (minimaxBaseStatusMessage) result.minimaxBaseStatusMessage = minimaxBaseStatusMessage;
  if (
    value.providerFailureClassification
    && SAFE_PROVIDER_FAILURE_CLASSIFICATIONS.has(value.providerFailureClassification)
  ) {
    result.providerFailureClassification = value.providerFailureClassification;
  }
  const sanitizedProviderErrorMessage = sanitizeTaskProviderErrorMessage(
    value.sanitizedProviderErrorMessage,
  );
  if (sanitizedProviderErrorMessage) {
    result.sanitizedProviderErrorMessage = sanitizedProviderErrorMessage;
  }
  const safeFields = (fields: readonly string[] | undefined): readonly string[] | undefined => {
    const filtered = fields?.filter((field) => SAFE_DIAGNOSTIC_VALUE.test(field)).slice(0, 20);
    return filtered?.length ? [...new Set(filtered)] : undefined;
  };
  const missingFields = safeFields(value.missingFields);
  const invalidFields = safeFields(value.invalidFields);
  if (missingFields) result.missingFields = missingFields;
  if (invalidFields) result.invalidFields = invalidFields;
  if (value.providerCallCount === 0 || value.providerCallCount === 1) {
    result.providerCallCount = value.providerCallCount;
  }
  const topLevelKeys = safeFields(value.responseTopLevelKeys);
  if (topLevelKeys) result.responseTopLevelKeys = topLevelKeys;
  const copyBoolean = (
    key: "responseDataPresent" | "responseAudioPresent" | "responseStatusPresent"
      | "responseBaseRespPresent" | "responseBaseStatusPresent" | "responseExtraInfoPresent"
      | "responseMusicSizePresent" | "responseUsagePresent"
      | "responseRequestIdPresent" | "responseTraceIdPresent",
  ) => {
    if (typeof value[key] === "boolean") result[key] = value[key];
  };
  copyBoolean("responseDataPresent");
  copyBoolean("responseAudioPresent");
  copyBoolean("responseStatusPresent");
  copyBoolean("responseBaseRespPresent");
  copyBoolean("responseBaseStatusPresent");
  copyBoolean("responseExtraInfoPresent");
  copyBoolean("responseMusicSizePresent");
  copyBoolean("responseUsagePresent");
  copyBoolean("responseRequestIdPresent");
  copyBoolean("responseTraceIdPresent");
  const safeJsonTypes = new Set(["missing", "null", "array", "object", "string", "number", "boolean"]);
  for (const key of [
    "responseDataType",
    "responseAudioType",
    "responseStatusType",
    "responseBaseStatusType",
    "responseMusicSizeType",
  ] as const) {
    const candidate = value[key];
    if (candidate && safeJsonTypes.has(candidate)) result[key] = candidate;
  }
  if (Number.isSafeInteger(value.responseAudioLength) && value.responseAudioLength! >= 0) {
    result.responseAudioLength = value.responseAudioLength;
  }
  if (Number.isSafeInteger(value.responseStatusValue)) {
    result.responseStatusValue = value.responseStatusValue;
  }
  if (Number.isSafeInteger(value.responseBaseStatusCode)) {
    result.responseBaseStatusCode = value.responseBaseStatusCode;
  }
  if (typeof value.responseMusicSizeValue === "number" && Number.isFinite(value.responseMusicSizeValue) && value.responseMusicSizeValue >= 0) {
    result.responseMusicSizeValue = value.responseMusicSizeValue;
  }
  if (value.musicStage && SAFE_MUSIC_STAGES.has(value.musicStage)) {
    result.musicStage = value.musicStage;
  }
  const representation = value.audioRepresentation;
  if (
    representation?.audioType === "string"
    && Number.isSafeInteger(representation.audioCharacterLength)
    && representation.audioCharacterLength >= 0
    && representation.audioCharacterLength <= 20_000_000
  ) {
    const booleanKeys = [
      "isEmpty",
      "isEvenLength",
      "isPureHex",
      "hasAsciiWhitespace",
      "hasLeadingOrTrailingWhitespace",
      "has0xPrefix",
      "urlLike",
      "httpUrlLike",
      "httpsUrlLike",
      "dataUriLike",
      "base64Like",
      "trimmedValueWouldBeHex",
      "whitespaceRemovedValueWouldBeHex",
      "zeroXPrefixRemovedValueWouldBeHex",
    ] as const;
    const countKeys = [
      "whitespace",
      "colon",
      "slash",
      "dot",
      "plus",
      "equals",
      "hyphen",
      "underscore",
      "other",
    ] as const;
    const booleansAreSafe = booleanKeys.every((key) => typeof representation[key] === "boolean");
    const countsAreSafe = countKeys.every((key) => {
      const count = representation.nonHexCharacterClasses?.[key];
      return Number.isSafeInteger(count)
        && count >= 0
        && count <= representation.audioCharacterLength;
    });
    if (booleansAreSafe && countsAreSafe) {
      result.audioRepresentation = {
        audioType: "string",
        audioCharacterLength: representation.audioCharacterLength,
        isEmpty: representation.isEmpty,
        isEvenLength: representation.isEvenLength,
        isPureHex: representation.isPureHex,
        hasAsciiWhitespace: representation.hasAsciiWhitespace,
        hasLeadingOrTrailingWhitespace: representation.hasLeadingOrTrailingWhitespace,
        has0xPrefix: representation.has0xPrefix,
        urlLike: representation.urlLike,
        httpUrlLike: representation.httpUrlLike,
        httpsUrlLike: representation.httpsUrlLike,
        dataUriLike: representation.dataUriLike,
        base64Like: representation.base64Like,
        trimmedValueWouldBeHex: representation.trimmedValueWouldBeHex,
        whitespaceRemovedValueWouldBeHex: representation.whitespaceRemovedValueWouldBeHex,
        zeroXPrefixRemovedValueWouldBeHex: representation.zeroXPrefixRemovedValueWouldBeHex,
        nonHexCharacterClasses: { ...representation.nonHexCharacterClasses },
      };
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function safeTrustedInternalDiagnostics(
  value: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const result: Record<string, unknown> = {};
  const copyNumber = (key: string, maximum = Number.MAX_SAFE_INTEGER) => {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 && candidate <= maximum) {
      result[key] = candidate;
    }
  };
  const copyBoolean = (key: string) => {
    if (typeof value[key] === "boolean") result[key] = value[key];
  };

  copyNumber("provider_http_status", 599);
  if (value.success_core_validated === true) result.success_core_validated = true;
  if (value.output_format === "url") result.output_format = "url";
  if (value.url_scheme === "https:") result.url_scheme = "https:";
  if (
    typeof value.normalized_download_hostname === "string"
    && /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value.normalized_download_hostname)
  ) {
    result.normalized_download_hostname = value.normalized_download_hostname;
  }
  for (const key of [
    "explicit_port_present",
    "url_credentials_present",
    "url_fragment_present",
    "dns_private_address_detected",
    "dns_rebinding_toctou_present",
    "download_host_allowlist_used",
  ]) copyBoolean(key);
  if (value.dns_preflight_result === "PUBLIC_ONLY") result.dns_preflight_result = "PUBLIC_ONLY";
  copyNumber("dns_resolved_address_count", 256);
  copyNumber("download_http_status", 599);
  if (
    value.download_content_type === null
    || (typeof value.download_content_type === "string"
      && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value.download_content_type))
  ) result.download_content_type = value.download_content_type;
  if (value.download_content_length_header === null) result.download_content_length_header = null;
  else copyNumber("download_content_length_header", 8 * 1024 * 1024);
  copyNumber("downloaded_bytes", 8 * 1024 * 1024);
  if (value.download_redirect_count === 0) result.download_redirect_count = 0;
  for (const key of [
    "provider_generation_ms",
    "url_policy_validation_ms",
    "dns_preflight_ms",
    "download_first_response_ms",
    "download_total_ms",
    "mp3_validation_ms",
    "storage_upload_ms",
    "track_finalization_ms",
    "total_task_wall_clock_ms",
    "provider_reported_music_duration_seconds",
    "provider_reported_music_size",
  ]) copyNumber(key);
  return Object.keys(result).length ? result : undefined;
}

export function safeTaskErrorResponse(
  error: unknown,
  options: { includeTrustedInternalDiagnostics?: boolean } = {},
): {
  status: number;
  body: Record<string, unknown>;
} {
  if (error instanceof SafeTaskError) {
    const diagnostic = safeDiagnostic(error.diagnostic);
    const trustedInternalDiagnostics = options.includeTrustedInternalDiagnostics
      ? safeTrustedInternalDiagnostics(error.trustedInternalDiagnostics)
      : undefined;
    return {
      status: error.httpStatus,
      body: {
        ok: false,
        status: error.code,
        message: error.message,
        generationOccurred: false,
        ...(diagnostic ? { diagnostic } : {}),
        ...(trustedInternalDiagnostics ? { metadata: { trustedInternalDiagnostics } } : {}),
      },
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      status: "INTERNAL_TASK_ERROR",
      message: "AI 任务服务暂时不可用，请稍后重试。",
      generationOccurred: false,
    },
  };
}
