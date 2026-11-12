import {
  SafeTaskError,
  sanitizeTaskProviderErrorMessage,
  type AITaskStatus,
  type SafeAudioRepresentationDiagnostic,
  type SafeProviderFailureClassification,
  type SafeTaskDiagnostic,
} from "../errors.ts";
import type {
  MusicGenerationExecutionContext,
  MusicGenerationExecutor,
  MusicGenerationInput,
  MusicGenerationProviderResult,
} from "../types.ts";
import { TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS } from "../budget.ts";
import {
  normalizeMusicProviderFailureDiagnostics,
  type MusicProviderErrorClass,
  type MusicProviderFailureDiagnostics,
  type MusicProviderFailureStage,
  type MusicProviderRequestShapeDiagnostics,
  type MusicProviderResponseClassification,
} from "../music-failure-diagnostics.ts";
import {
  downloadTokenHubAudioURL,
  TOKENHUB_MAX_AUDIO_DOWNLOAD_BYTES,
  type DownloadedTokenHubAudio,
} from "./tencent-tokenhub-audio-download.ts";

export const TOKENHUB_MUSIC_BASE_URL = "https://tokenhub.tencentmaas.com";
export const TOKENHUB_MUSIC_ENDPOINT = `${TOKENHUB_MUSIC_BASE_URL}/v1/wand/minimax-music/generation`;
export const TOKENHUB_MUSIC_MODEL = "minimax-music-v2.6";
// TokenHub v2.6 returns an ephemeral signed media URL. It is consumed only by
// the server-side bounded downloader and is never persisted or returned.
export const TOKENHUB_MUSIC_OUTPUT_FORMAT = "url";
export const TOKENHUB_MUSIC_AUDIO_SETTING = Object.freeze({
  sample_rate: 44_100,
  bitrate: 256_000,
  format: "mp3",
});

// Supabase Edge isolates are memory constrained. Eight decoded MiB bounds the
// provider JSON string, decoded bytes, and upload body well below the isolate
// limit while allowing roughly four minutes of 256 kbps MP3 audio.
export const TOKENHUB_MAX_AUDIO_BYTES = TOKENHUB_MAX_AUDIO_DOWNLOAD_BYTES;
export const TOKENHUB_MAX_AUDIO_HEX_CHARACTERS = TOKENHUB_MAX_AUDIO_BYTES * 2;
export const TOKENHUB_MAX_RESPONSE_CHARACTERS = TOKENHUB_MAX_AUDIO_HEX_CHARACTERS + 64 * 1024;

type TokenHubMusicRequestBody = {
  model: typeof TOKENHUB_MUSIC_MODEL;
  output_format: typeof TOKENHUB_MUSIC_OUTPUT_FORMAT;
  audio_setting: typeof TOKENHUB_MUSIC_AUDIO_SETTING;
  prompt?: string;
  lyrics?: string;
  is_instrumental?: boolean;
};

export function buildTencentTokenHubMusicRequest(input: MusicGenerationInput): {
  url: string;
  init: Omit<RequestInit, "signal">;
  body: TokenHubMusicRequestBody;
} {
  const body: TokenHubMusicRequestBody = {
    model: TOKENHUB_MUSIC_MODEL,
    output_format: TOKENHUB_MUSIC_OUTPUT_FORMAT,
    audio_setting: TOKENHUB_MUSIC_AUDIO_SETTING,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.mode === "custom_lyrics"
      ? { lyrics: input.lyrics, is_instrumental: false }
      : { is_instrumental: true }),
  };
  return {
    url: TOKENHUB_MUSIC_ENDPOINT,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    body,
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalFiniteNumber(value: unknown): number | undefined {
  const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) && numeric >= 0
    ? numeric
    : undefined;
}

function optionalFiniteInteger(value: unknown): number | undefined {
  const number = optionalFiniteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

function safeOpaqueIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : undefined;
}

function safeDiagnosticScalar(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return safeOpaqueIdentifier(value);
}

function jsonValueType(value: unknown): "missing" | "null" | "array" | "object" | "string" | "number" | "boolean" {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "missing";
}

function requestFieldDiagnostics(
  value: unknown,
  valid: boolean,
  enumValid?: boolean,
): {
  present: boolean;
  type: "missing" | "null" | "array" | "object" | "string" | "number" | "boolean";
  valid: boolean;
  length?: number;
  enumValid?: boolean;
} {
  const type = jsonValueType(value);
  return {
    present: type !== "missing",
    type,
    valid,
    ...(typeof value === "string" ? { length: value.length } : {}),
    ...(enumValid === undefined ? {} : { enumValid }),
  };
}

function exactAudioSettingShape(value: unknown): boolean {
  return plainRecord(value)
    && Object.keys(value).length === 3
    && Object.hasOwn(value, "sample_rate")
    && Object.hasOwn(value, "bitrate")
    && Object.hasOwn(value, "format")
    && value.sample_rate === TOKENHUB_MUSIC_AUDIO_SETTING.sample_rate
    && value.bitrate === TOKENHUB_MUSIC_AUDIO_SETTING.bitrate
    && value.format === TOKENHUB_MUSIC_AUDIO_SETTING.format;
}

export function describeTencentTokenHubMusicRequest(
  body: TokenHubMusicRequestBody,
  inputMode: MusicGenerationInput["mode"],
): MusicProviderRequestShapeDiagnostics {
  const customLyrics = inputMode === "custom_lyrics";
  const promptPresent = Object.hasOwn(body, "prompt");
  const lyricsPresent = Object.hasOwn(body, "lyrics");
  const audioSetting = body.audio_setting;
  const audioSettingRecord: Record<string, unknown> = plainRecord(audioSetting) ? audioSetting : {};
  const audioSettingValid = exactAudioSettingShape(audioSetting);
  return {
    inputMode,
    fields: {
      model: requestFieldDiagnostics(
        body.model,
        typeof body.model === "string" && body.model === TOKENHUB_MUSIC_MODEL,
        typeof body.model === "string" && body.model === TOKENHUB_MUSIC_MODEL,
      ),
      output_format: requestFieldDiagnostics(
        body.output_format,
        typeof body.output_format === "string" && body.output_format === TOKENHUB_MUSIC_OUTPUT_FORMAT,
        typeof body.output_format === "string" && body.output_format === TOKENHUB_MUSIC_OUTPUT_FORMAT,
      ),
      audio_setting: requestFieldDiagnostics(audioSetting, audioSettingValid),
      prompt: requestFieldDiagnostics(
        body.prompt,
        !promptPresent
          || (typeof body.prompt === "string" && body.prompt.length > 0 && body.prompt.length <= 2_000),
      ),
      lyrics: requestFieldDiagnostics(
        body.lyrics,
        customLyrics
          ? typeof body.lyrics === "string" && body.lyrics.length > 0 && body.lyrics.length <= 3_500
          : !lyricsPresent,
      ),
      is_instrumental: requestFieldDiagnostics(
        body.is_instrumental,
        typeof body.is_instrumental === "boolean"
          && body.is_instrumental === !customLyrics,
        typeof body.is_instrumental === "boolean"
          && body.is_instrumental === !customLyrics,
      ),
    },
    audioSettingFields: {
      sample_rate: requestFieldDiagnostics(
        audioSettingRecord.sample_rate,
        audioSettingValid && audioSettingRecord.sample_rate === TOKENHUB_MUSIC_AUDIO_SETTING.sample_rate,
        audioSettingValid && audioSettingRecord.sample_rate === TOKENHUB_MUSIC_AUDIO_SETTING.sample_rate,
      ),
      bitrate: requestFieldDiagnostics(
        audioSettingRecord.bitrate,
        audioSettingValid && audioSettingRecord.bitrate === TOKENHUB_MUSIC_AUDIO_SETTING.bitrate,
        audioSettingValid && audioSettingRecord.bitrate === TOKENHUB_MUSIC_AUDIO_SETTING.bitrate,
      ),
      format: requestFieldDiagnostics(
        audioSettingRecord.format,
        audioSettingValid && audioSettingRecord.format === TOKENHUB_MUSIC_AUDIO_SETTING.format,
        audioSettingValid && audioSettingRecord.format === TOKENHUB_MUSIC_AUDIO_SETTING.format,
      ),
    },
  };
}

function tokenHubResponseShapeDiagnostic(
  httpStatus: number,
  payload: unknown,
  musicStage: SafeTaskDiagnostic["musicStage"] = "RESPONSE_RECEIVED",
): SafeTaskDiagnostic {
  const root = plainRecord(payload) ? payload : null;
  const dataValue = root?.data;
  const data = plainRecord(dataValue) ? dataValue : null;
  const baseResponseValue = root?.base_resp;
  const baseResponse = plainRecord(baseResponseValue) ? baseResponseValue : null;
  const extraInfoValue = root?.extra_info;
  const extraInfo = plainRecord(extraInfoValue) ? extraInfoValue : null;
  const audio = data?.audio;
  return {
    provider: "tencent_tokenhub",
    failureStage: "schema_validation",
    httpStatus,
    providerCallCount: 1,
    responseTopLevelKeys: root ? Object.keys(root).sort().slice(0, 20) : [],
    responseDataPresent: Boolean(root && Object.hasOwn(root, "data")),
    responseDataType: jsonValueType(dataValue),
    responseAudioPresent: Boolean(data && Object.hasOwn(data, "audio")),
    responseAudioType: jsonValueType(audio),
    ...(typeof audio === "string" ? { responseAudioLength: audio.length } : {}),
    responseStatusPresent: Boolean(data && Object.hasOwn(data, "status")),
    responseStatusType: jsonValueType(data?.status),
    ...(typeof data?.status === "number" && Number.isSafeInteger(data.status)
      ? { responseStatusValue: data.status }
      : {}),
    responseBaseRespPresent: Boolean(root && Object.hasOwn(root, "base_resp")),
    responseBaseStatusPresent: Boolean(baseResponse && Object.hasOwn(baseResponse, "status_code")),
    responseBaseStatusType: jsonValueType(baseResponse?.status_code),
    ...(typeof baseResponse?.status_code === "number" && Number.isSafeInteger(baseResponse.status_code)
      ? { responseBaseStatusCode: baseResponse.status_code }
      : {}),
    responseExtraInfoPresent: Boolean(root && Object.hasOwn(root, "extra_info")),
    responseMusicSizePresent: Boolean(extraInfo && Object.hasOwn(extraInfo, "music_size")),
    responseMusicSizeType: jsonValueType(extraInfo?.music_size),
    ...(typeof extraInfo?.music_size === "number" && Number.isSafeInteger(extraInfo.music_size)
      ? { responseMusicSizeValue: extraInfo.music_size }
      : {}),
    responseUsagePresent: Boolean(root && Object.hasOwn(root, "usage")),
    responseRequestIdPresent: Boolean(root && Object.hasOwn(root, "request_id")),
    responseTraceIdPresent: Boolean(root && Object.hasOwn(root, "trace_id")),
    musicStage,
  };
}

function tokenHubSchemaError(
  httpStatus: number,
  payload: unknown,
  message: string,
): SafeTaskError {
  return new SafeTaskError(
    "PROVIDER_SCHEMA_MISMATCH",
    message,
    502,
    tokenHubResponseShapeDiagnostic(httpStatus, payload),
  );
}

const TOKENHUB_FAILURE_BY_CODE: Readonly<Record<string, SafeProviderFailureClassification>> = Object.freeze({
  "401007": "POSTPAY_NOT_ENABLED",
  CodeEndpointNoFreePackage: "POSTPAY_NOT_ENABLED",
  "401008": "QUOTA_EXHAUSTED",
  CodeEndpointFreeQuotaExhausted: "QUOTA_EXHAUSTED",
  "403004": "INSUFFICIENT_BALANCE",
  CodeInsufficientBalance: "INSUFFICIENT_BALANCE",
  "403001": "PERMISSION_DENIED",
  CodePermissionDenied: "PERMISSION_DENIED",
  "403002": "MODEL_ACCESS_DENIED",
  CodeModelAccessDenied: "MODEL_ACCESS_DENIED",
  "403005": "IP_NOT_ALLOWED",
  CodeIPNotAllowed: "IP_NOT_ALLOWED",
  "400001": "INVALID_REQUEST",
  CodeInvalidRequest: "INVALID_REQUEST",
  "400002": "INVALID_REQUEST",
  CodeInvalidParameter: "INVALID_REQUEST",
  "400006": "UNSUPPORTED_FORMAT",
  CodeUnsupportedFormat: "UNSUPPORTED_FORMAT",
  "451001": "CONTENT_FILTERED",
  CodeContentFiltered: "CONTENT_FILTERED",
  "502001": "UPSTREAM_ERROR",
  CodeUpstreamError: "UPSTREAM_ERROR",
  "504001": "UPSTREAM_TIMEOUT",
  CodeGatewayTimeout: "UPSTREAM_TIMEOUT",
  "1008": "INSUFFICIENT_BALANCE",
  "2013": "INVALID_REQUEST",
  "1026": "CONTENT_FILTERED",
});

function classifyTokenHubFailure(
  httpStatus: number,
  providerErrorCode: string | undefined,
  minimaxBaseStatusCode: number | undefined,
): SafeProviderFailureClassification {
  for (const code of [providerErrorCode, minimaxBaseStatusCode?.toString()]) {
    if (code && TOKENHUB_FAILURE_BY_CODE[code]) return TOKENHUB_FAILURE_BY_CODE[code];
    if (code && /^429\d*$/.test(code)) return "RATE_LIMIT";
  }
  if (httpStatus === 400) return "INVALID_REQUEST";
  if (httpStatus === 401) return "AUTHENTICATION";
  if (httpStatus === 402) return "PAYMENT_OR_QUOTA";
  if (httpStatus === 403) return "PERMISSION_DENIED";
  if (httpStatus === 413) return "REQUEST_TOO_LARGE";
  if (httpStatus === 429) return "RATE_LIMIT";
  if (httpStatus === 451) return "CONTENT_FILTERED";
  if (httpStatus === 504) return "UPSTREAM_TIMEOUT";
  if (httpStatus === 500 || httpStatus === 502 || httpStatus === 503) return "UPSTREAM_ERROR";
  return "UNKNOWN";
}

function tokenHubTaskStatus(
  httpStatus: number,
  classification: SafeProviderFailureClassification,
): AITaskStatus {
  if (classification === "RATE_LIMIT") return "PROVIDER_RATE_LIMIT";
  if (classification === "AUTHENTICATION" || httpStatus === 401) return "PROVIDER_AUTH_ERROR";
  if (
    classification === "POSTPAY_NOT_ENABLED"
    || classification === "QUOTA_EXHAUSTED"
    || classification === "INSUFFICIENT_BALANCE"
    || classification === "PAYMENT_OR_QUOTA"
    || httpStatus === 402
  ) return "PROVIDER_PAYMENT_OR_QUOTA_ERROR";
  if (
    classification === "INVALID_REQUEST"
    || classification === "UNSUPPORTED_FORMAT"
    || classification === "REQUEST_TOO_LARGE"
    || classification === "CONTENT_FILTERED"
  ) return "PROVIDER_BAD_REQUEST";
  if (classification === "UPSTREAM_TIMEOUT") return "PROVIDER_TIMEOUT";
  if (classification === "UPSTREAM_ERROR") return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_HTTP_ERROR";
}

export function createTencentTokenHubMusicHTTPError(
  httpStatus: number,
  payload: unknown,
  sensitiveValues: readonly string[] = [],
): SafeTaskError {
  const root = plainRecord(payload) ? payload : {};
  const providerError = plainRecord(root.error) ? root.error : {};
  const baseResponse = plainRecord(root.base_resp) ? root.base_resp : {};
  const providerErrorCode = safeDiagnosticScalar(providerError.code);
  const parsedMinimaxBaseStatusCode = optionalFiniteInteger(baseResponse.status_code);
  const minimaxBaseStatusCode = parsedMinimaxBaseStatusCode !== undefined
      && parsedMinimaxBaseStatusCode <= 999999
    ? parsedMinimaxBaseStatusCode
    : undefined;
  const providerFailureClassification = classifyTokenHubFailure(
    httpStatus,
    providerErrorCode,
    minimaxBaseStatusCode,
  );
  const diagnostic: SafeTaskDiagnostic = {
    provider: "tencent_tokenhub",
    failureStage: "provider_response",
    httpStatus,
    providerCallCount: 1,
    providerFailureClassification,
  };
  const assignSafe = (
    key: "providerErrorCode" | "providerErrorType" | "providerErrorSource"
      | "providerUpstreamCode" | "providerUpstreamStatus" | "requestId" | "traceId",
    value: unknown,
  ) => {
    const safe = safeDiagnosticScalar(value);
    if (safe) diagnostic[key] = safe;
  };
  assignSafe("providerErrorCode", providerError.code);
  assignSafe("providerErrorType", providerError.type);
  assignSafe("providerErrorSource", providerError.source);
  assignSafe("providerUpstreamCode", providerError.upstream_code);
  assignSafe("providerUpstreamStatus", providerError.upstream_status);
  assignSafe("requestId", providerError.request_id ?? root.request_id);
  assignSafe("traceId", root.trace_id);
  if (minimaxBaseStatusCode !== undefined) diagnostic.minimaxBaseStatusCode = minimaxBaseStatusCode;
  const minimaxBaseStatusMessage = sanitizeTaskProviderErrorMessage(
    baseResponse.status_msg,
    sensitiveValues,
  );
  if (minimaxBaseStatusMessage) diagnostic.minimaxBaseStatusMessage = minimaxBaseStatusMessage;
  return new SafeTaskError(
    tokenHubTaskStatus(httpStatus, providerFailureClassification),
    "Music Provider could not complete the request.",
    502,
    diagnostic,
  );
}

const TOKENHUB_AUDIO_HEX_PATTERN = /^[0-9a-fA-F]+$/;
const TOKENHUB_AUDIO_HEX_CHARACTER_PATTERN = /^[0-9a-fA-F]$/;
const TOKENHUB_AUDIO_ASCII_WHITESPACE_PATTERN = /[\t\n\v\f\r ]/;

function nonEmptyPureHex(value: string): boolean {
  return value.length > 0 && TOKENHUB_AUDIO_HEX_PATTERN.test(value);
}

export function classifyTokenHubAudioRepresentation(
  value: string,
): SafeAudioRepresentationDiagnostic {
  const nonHexCharacterClasses = {
    whitespace: 0,
    colon: 0,
    slash: 0,
    dot: 0,
    plus: 0,
    equals: 0,
    hyphen: 0,
    underscore: 0,
    other: 0,
  };
  for (const character of value) {
    if (TOKENHUB_AUDIO_HEX_CHARACTER_PATTERN.test(character)) continue;
    if (TOKENHUB_AUDIO_ASCII_WHITESPACE_PATTERN.test(character)) {
      nonHexCharacterClasses.whitespace += 1;
    } else if (character === ":") {
      nonHexCharacterClasses.colon += 1;
    } else if (character === "/") {
      nonHexCharacterClasses.slash += 1;
    } else if (character === ".") {
      nonHexCharacterClasses.dot += 1;
    } else if (character === "+") {
      nonHexCharacterClasses.plus += 1;
    } else if (character === "=") {
      nonHexCharacterClasses.equals += 1;
    } else if (character === "-") {
      nonHexCharacterClasses.hyphen += 1;
    } else if (character === "_") {
      nonHexCharacterClasses.underscore += 1;
    } else {
      nonHexCharacterClasses.other += 1;
    }
  }

  const trimmedValue = value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  const whitespaceRemovedValue = value.replace(/[\t\n\v\f\r ]/g, "");
  const has0xPrefix = /^0x/i.test(value);
  const isPureHex = nonEmptyPureHex(value);
  return {
    audioType: "string",
    audioCharacterLength: value.length,
    isEmpty: value.length === 0,
    isEvenLength: value.length % 2 === 0,
    isPureHex,
    hasAsciiWhitespace: TOKENHUB_AUDIO_ASCII_WHITESPACE_PATTERN.test(value),
    hasLeadingOrTrailingWhitespace: /^[\t\n\v\f\r ]|[\t\n\v\f\r ]$/.test(value),
    has0xPrefix,
    urlLike: /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value),
    httpUrlLike: /^http:\/\//i.test(value),
    httpsUrlLike: /^https:\/\//i.test(value),
    dataUriLike: /^data:/i.test(value),
    base64Like: !isPureHex
      && value.length > 0
      && value.length % 4 === 0
      && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
    trimmedValueWouldBeHex: nonEmptyPureHex(trimmedValue),
    whitespaceRemovedValueWouldBeHex: nonEmptyPureHex(whitespaceRemovedValue),
    zeroXPrefixRemovedValueWouldBeHex: has0xPrefix && nonEmptyPureHex(value.slice(2)),
    nonHexCharacterClasses,
  };
}

function tokenHubAudioRepresentationStatus(
  diagnostic: SafeAudioRepresentationDiagnostic,
): AITaskStatus {
  if (diagnostic.urlLike || diagnostic.dataUriLike) {
    return "AUDIO_REPRESENTATION_UNEXPECTED_URL";
  }
  if (diagnostic.has0xPrefix && diagnostic.zeroXPrefixRemovedValueWouldBeHex) {
    return "AUDIO_REPRESENTATION_0X_PREFIXED";
  }
  if (diagnostic.hasAsciiWhitespace && diagnostic.whitespaceRemovedValueWouldBeHex) {
    return "AUDIO_REPRESENTATION_WHITESPACE_WRAPPED";
  }
  if (diagnostic.base64Like) {
    return "AUDIO_REPRESENTATION_UNEXPECTED_BASE64";
  }
  return "AUDIO_REPRESENTATION_UNKNOWN";
}

export function decodeBoundedTokenHubAudioHex(
  value: unknown,
  diagnostic?: SafeTaskDiagnostic,
): Uint8Array {
  if (typeof value !== "string") {
    throw new SafeTaskError("AUDIO_HEX_INVALID", "Music Provider did not return valid hexadecimal audio.", 502, diagnostic);
  }
  if (value.length === 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    const audioRepresentation = classifyTokenHubAudioRepresentation(value);
    const code = value.length === 0
      ? "AUDIO_HEX_INVALID"
      : tokenHubAudioRepresentationStatus(audioRepresentation);
    throw new SafeTaskError(
      code,
      "Music Provider did not return valid hexadecimal audio.",
      502,
      { ...diagnostic, audioRepresentation },
    );
  }
  if (value.length % 2 !== 0) {
    throw new SafeTaskError("AUDIO_HEX_ODD_LENGTH", "Music Provider audio encoding has an invalid length.", 502, diagnostic);
  }
  if (value.length > TOKENHUB_MAX_AUDIO_HEX_CHARACTERS) {
    throw new SafeTaskError("AUDIO_HEX_TOO_LARGE", "Music Provider audio exceeds the safe encoded size limit.", 502, diagnostic);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
  } catch {
    throw new SafeTaskError(
      "AUDIO_DECODE_FAILED",
      "Music Provider audio could not be decoded safely.",
      502,
      { ...diagnostic, musicStage: "HEX_VALIDATED" },
    );
  }
  assertDecodedTokenHubAudioSize(bytes, { ...diagnostic, musicStage: "HEX_DECODED" });
  return bytes;
}

export function assertDecodedTokenHubAudioSize(
  bytes: Uint8Array,
  diagnostic?: SafeTaskDiagnostic,
): void {
  if (bytes.byteLength === 0) {
    throw new SafeTaskError("AUDIO_DECODE_FAILED", "Music Provider audio decoded to an empty result.", 502, diagnostic);
  }
  if (bytes.byteLength > TOKENHUB_MAX_AUDIO_BYTES) {
    throw new SafeTaskError("AUDIO_DECODED_TOO_LARGE", "Music Provider decoded audio exceeds the safe size limit.", 502, diagnostic);
  }
}

function mp3FrameHeaderAt(bytes: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset + 4 > bytes.byteLength) return false;
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return false;
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  const bitrateIndex = (third >> 4) & 0x0f;
  const sampleRateIndex = (third >> 2) & 0x03;
  return version !== 0x01
    && layer !== 0x00
    && bitrateIndex !== 0x00
    && bitrateIndex !== 0x0f
    && sampleRateIndex !== 0x03;
}

export function assertDefensibleMp3(bytes: Uint8Array, diagnostic?: SafeTaskDiagnostic): void {
  if (bytes.byteLength < 4) {
    throw new SafeTaskError("AUDIO_MP3_INVALID", "Music Provider audio is not a valid MP3 container.", 502, diagnostic);
  }
  let frameOffset = 0;
  if (bytes.byteLength >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    if ((bytes[6] | bytes[7] | bytes[8] | bytes[9]) & 0x80) {
      throw new SafeTaskError("AUDIO_MP3_INVALID", "Music Provider MP3 metadata is invalid.", 502, diagnostic);
    }
    const tagSize = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
    frameOffset = 10 + tagSize;
  }
  if (!mp3FrameHeaderAt(bytes, frameOffset)) {
    throw new SafeTaskError("AUDIO_MP3_INVALID", "Music Provider audio is not a valid MP3 container.", 502, diagnostic);
  }
}

export function parseTencentTokenHubMusicResponse(
  httpStatus: number,
  payload: unknown,
  now: () => number = () => performance.now(),
  sensitiveValues: readonly string[] = [],
): MusicGenerationProviderResult {
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new SafeTaskError("PROVIDER_HTTP_ERROR", "Music Provider could not complete the request.", 502);
  }
  if (!plainRecord(payload)) {
    throw tokenHubSchemaError(httpStatus, payload, "Music Provider returned an invalid result object.");
  }
  const baseResponse = payload.base_resp;
  const data = payload.data;
  if (!plainRecord(baseResponse) || typeof baseResponse.status_code !== "number" || !Number.isSafeInteger(baseResponse.status_code)) {
    throw tokenHubSchemaError(httpStatus, payload, "Music Provider returned an invalid base status.");
  }
  if (baseResponse.status_code !== 0) {
    const classified = createTencentTokenHubMusicHTTPError(httpStatus, payload, sensitiveValues);
    throw new SafeTaskError(
      "PROVIDER_BUSINESS_ERROR",
      "Music Provider reported a business failure.",
      502,
      classified.diagnostic,
    );
  }
  if (!plainRecord(data)) {
    throw tokenHubSchemaError(httpStatus, payload, "Music Provider returned an invalid data object.");
  }
  if (typeof data.status !== "number" || !Number.isSafeInteger(data.status)) {
    throw tokenHubSchemaError(httpStatus, payload, "Music Provider returned an invalid completion status.");
  }
  if (data.status !== 2) {
    throw new SafeTaskError(
      "PROVIDER_NOT_COMPLETED",
      "Music Provider did not return completed audio.",
      502,
      tokenHubResponseShapeDiagnostic(httpStatus, payload, "RESPONSE_RECEIVED"),
    );
  }
  if (typeof data.audio !== "string") {
    throw tokenHubSchemaError(httpStatus, payload, "Music Provider returned an invalid audio field.");
  }
  const successDiagnostic = tokenHubResponseShapeDiagnostic(httpStatus, payload, "SUCCESS_CORE_VALIDATED");
  const hexCharacterLength = data.audio.length;
  const hexStartedAt = now();
  const audioBytes = decodeBoundedTokenHubAudioHex(data.audio, successDiagnostic);
  const hexValidationDecodeMs = Math.max(0, now() - hexStartedAt);

  const extraInfo = plainRecord(payload.extra_info) ? payload.extra_info : {};
  const usageRecord = plainRecord(payload.usage) ? payload.usage : {};
  const totalTokens = optionalFiniteNumber(usageRecord.total_tokens);
  const providerReportedSize = optionalFiniteInteger(extraInfo.music_size);
  if (providerReportedSize !== undefined && providerReportedSize !== audioBytes.byteLength) {
    throw new SafeTaskError(
      "AUDIO_SIZE_MISMATCH",
      "Music Provider reported an inconsistent audio size.",
      502,
      tokenHubResponseShapeDiagnostic(httpStatus, payload, "HEX_DECODED"),
    );
  }
  const mp3StartedAt = now();
  assertDefensibleMp3(
    audioBytes,
    tokenHubResponseShapeDiagnostic(httpStatus, payload, "SIZE_VALIDATED"),
  );
  const mp3ValidationMs = Math.max(0, now() - mp3StartedAt);
  return {
    audioBytes,
    providerReportedDurationSeconds: optionalFiniteNumber(extraInfo.music_duration),
    serverVerifiedDurationSeconds: null,
    format: TOKENHUB_MUSIC_AUDIO_SETTING.format,
    metadata: {
      requestId: safeOpaqueIdentifier(payload.request_id),
      traceId: safeOpaqueIdentifier(payload.trace_id),
      musicSampleRate: optionalFiniteInteger(extraInfo.music_sample_rate),
      musicChannel: optionalFiniteInteger(extraInfo.music_channel),
      bitrate: optionalFiniteInteger(extraInfo.bitrate),
      musicSize: providerReportedSize,
    },
    usage: totalTokens === undefined
      ? null
      : { input_tokens: null, output_tokens: null, total_tokens: totalTokens },
    metrics: {
      providerResponseMs: 0,
      providerRequestDurationMs: 0,
      providerGenerationLatencyMs: 0,
      hexValidationDecodeMs,
      mp3ValidationMs,
      hexCharacterLength,
    },
  };
}

type TokenHubURLParserDependencies = {
  downloadAudio?: (value: string) => Promise<DownloadedTokenHubAudio>;
  now?: () => number;
  sensitiveValues?: readonly string[];
};

export async function parseTencentTokenHubMusicResponseWithURL(
  httpStatus: number,
  payload: unknown,
  dependencies: TokenHubURLParserDependencies = {},
): Promise<MusicGenerationProviderResult> {
  if (!plainRecord(payload) || !plainRecord(payload.data) || typeof payload.data.audio !== "string") {
    return parseTencentTokenHubMusicResponse(
      httpStatus,
      payload,
      dependencies.now,
      dependencies.sensitiveValues,
    );
  }
  const representation = classifyTokenHubAudioRepresentation(payload.data.audio);
  if (!representation.httpsUrlLike) {
    return parseTencentTokenHubMusicResponse(
      httpStatus,
      payload,
      dependencies.now,
      dependencies.sensitiveValues,
    );
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new SafeTaskError("PROVIDER_HTTP_ERROR", "Music Provider could not complete the request.", 502);
  }
  const baseResponse = payload.base_resp;
  if (!plainRecord(baseResponse) || typeof baseResponse.status_code !== "number" || !Number.isSafeInteger(baseResponse.status_code)) {
    throw tokenHubSchemaError(httpStatus, payload, "Music Provider returned an invalid base status.");
  }
  if (baseResponse.status_code !== 0) {
    const classified = createTencentTokenHubMusicHTTPError(
      httpStatus,
      payload,
      dependencies.sensitiveValues,
    );
    throw new SafeTaskError(
      "PROVIDER_BUSINESS_ERROR",
      "Music Provider reported a business failure.",
      502,
      classified.diagnostic,
    );
  }
  if (typeof payload.data.status !== "number" || !Number.isSafeInteger(payload.data.status)) {
    throw tokenHubSchemaError(httpStatus, payload, "Music Provider returned an invalid completion status.");
  }
  if (payload.data.status !== 2) {
    throw new SafeTaskError(
      "PROVIDER_NOT_COMPLETED",
      "Music Provider did not return completed audio.",
      502,
      tokenHubResponseShapeDiagnostic(httpStatus, payload, "RESPONSE_RECEIVED"),
    );
  }
  const now = dependencies.now ?? (() => performance.now());
  const downloadAudio = dependencies.downloadAudio ?? downloadTokenHubAudioURL;
  const ingestStartedAt = now();
  const downloaded = await downloadAudio(payload.data.audio);
  const audioBytes = downloaded.bytes;
  assertDecodedTokenHubAudioSize(
    audioBytes,
    tokenHubResponseShapeDiagnostic(httpStatus, payload, "HEX_DECODED"),
  );
  const extraInfo = plainRecord(payload.extra_info) ? payload.extra_info : {};
  const providerReportedSize = optionalFiniteInteger(extraInfo.music_size);
  if (providerReportedSize !== undefined && providerReportedSize !== audioBytes.byteLength) {
    throw new SafeTaskError(
      "AUDIO_SIZE_MISMATCH",
      "Music Provider reported an inconsistent audio size.",
      502,
      tokenHubResponseShapeDiagnostic(httpStatus, payload, "HEX_DECODED"),
    );
  }
  const mp3StartedAt = now();
  assertDefensibleMp3(
    audioBytes,
    tokenHubResponseShapeDiagnostic(httpStatus, payload, "SIZE_VALIDATED"),
  );
  const mp3ValidationMs = Math.max(0, now() - mp3StartedAt);
  const usageRecord = plainRecord(payload.usage) ? payload.usage : {};
  const totalTokens = optionalFiniteNumber(usageRecord.total_tokens);
  return {
    audioBytes,
    providerReportedDurationSeconds: optionalFiniteNumber(extraInfo.music_duration),
    serverVerifiedDurationSeconds: null,
    format: TOKENHUB_MUSIC_AUDIO_SETTING.format,
    metadata: {
      requestId: safeOpaqueIdentifier(payload.request_id),
      traceId: safeOpaqueIdentifier(payload.trace_id),
      musicSampleRate: optionalFiniteInteger(extraInfo.music_sample_rate),
      musicChannel: optionalFiniteInteger(extraInfo.music_channel),
      bitrate: optionalFiniteInteger(extraInfo.bitrate),
      musicSize: providerReportedSize,
    },
    trustedURLDiagnostics: {
      provider_http_status: httpStatus,
      success_core_validated: true,
      output_format: "url",
      url_scheme: downloaded.diagnostics.urlScheme,
      normalized_download_hostname: downloaded.diagnostics.normalizedDownloadHostname,
      explicit_port_present: downloaded.diagnostics.explicitPortPresent,
      url_credentials_present: downloaded.diagnostics.urlCredentialsPresent,
      url_fragment_present: downloaded.diagnostics.urlFragmentPresent,
      dns_preflight_result: downloaded.diagnostics.dnsPreflightResult,
      dns_resolved_address_count: downloaded.diagnostics.dnsResolvedAddressCount,
      dns_private_address_detected: downloaded.diagnostics.dnsPrivateAddressDetected,
      dns_rebinding_toctou_present: downloaded.diagnostics.dnsRebindingTOCTOUPresent,
      download_host_allowlist_used: downloaded.diagnostics.downloadHostAllowlistUsed,
      download_http_status: downloaded.diagnostics.downloadHttpStatus,
      download_content_type: downloaded.diagnostics.downloadContentType,
      download_content_length_header: downloaded.diagnostics.downloadContentLengthHeader,
      downloaded_bytes: downloaded.diagnostics.downloadedBytes,
      download_redirect_count: downloaded.diagnostics.downloadRedirectCount,
    },
    usage: totalTokens === undefined
      ? null
      : { input_tokens: null, output_tokens: null, total_tokens: totalTokens },
    metrics: {
      providerResponseMs: 0,
      providerRequestDurationMs: 0,
      providerGenerationLatencyMs: 0,
      hexValidationDecodeMs: Math.max(0, now() - ingestStartedAt),
      mp3ValidationMs,
      hexCharacterLength: 0,
      urlPolicyValidationMs: downloaded.diagnostics.urlPolicyValidationMs,
      dnsPreflightMs: downloaded.diagnostics.dnsPreflightMs,
      downloadFirstResponseMs: downloaded.diagnostics.downloadFirstResponseMs,
      downloadTotalMs: downloaded.diagnostics.downloadTotalMs,
    },
  };
}

export class AmbiguousMusicProviderError extends SafeTaskError {
  readonly outcomeAmbiguous = true;

  constructor(
    code: "PROVIDER_TIMEOUT" | "NETWORK_ERROR" | "UNKNOWN_PROVIDER_RESULT",
    message: string,
    failureDiagnostics?: MusicProviderFailureDiagnostics,
  ) {
    super(code, message, 502, {
      provider: "tencent_tokenhub",
      failureStage: "provider_request",
      providerCallCount: 1,
    }, undefined, failureDiagnostics);
    this.name = "AmbiguousMusicProviderError";
  }
}

function providerRequestDuration(now: () => number, requestStartedAt: number): number {
  return Math.max(0, now() - requestStartedAt);
}

function providerErrorCode(error: SafeTaskError): string | undefined {
  return error.diagnostic?.providerErrorCode
    ?? (error.diagnostic?.minimaxBaseStatusCode !== undefined
      ? String(error.diagnostic.minimaxBaseStatusCode)
      : undefined);
}

function attachMusicFailureDiagnostics(
  error: SafeTaskError,
  input: {
    providerResponseReceived: boolean;
    providerHttpStatus?: number;
    providerErrorClass: MusicProviderErrorClass;
    providerFailureStage: MusicProviderFailureStage;
    providerResponseClassification: MusicProviderResponseClassification;
    providerResponseJsonParseable: boolean;
    providerRequestDurationMs: number;
    requestShape: MusicProviderRequestShapeDiagnostics;
  },
): SafeTaskError {
  const failureDiagnostics = normalizeMusicProviderFailureDiagnostics({
    ...input,
    ...(error.diagnostic?.providerFailureClassification
      ? { providerErrorClass: error.diagnostic.providerFailureClassification }
      : {}),
    ...(providerErrorCode(error) ? { providerErrorCode: providerErrorCode(error) } : {}),
    ...(error.diagnostic?.requestId ? { providerRequestId: error.diagnostic.requestId } : {}),
    ...(error.diagnostic?.traceId ? { providerTraceId: error.diagnostic.traceId } : {}),
  });
  return new SafeTaskError(
    error.code,
    error.message,
    error.httpStatus,
    error.diagnostic,
    error.trustedInternalDiagnostics,
    failureDiagnostics,
  );
}

function parsedFailureClassification(error: SafeTaskError): {
  errorClass: MusicProviderErrorClass;
  stage: MusicProviderFailureStage;
  responseClassification: MusicProviderResponseClassification;
} {
  if (error.code === "PROVIDER_BUSINESS_ERROR") {
    return {
      errorClass: "BUSINESS_ERROR",
      stage: "BUSINESS_STATUS_CHECKED",
      responseClassification: "BUSINESS_ERROR",
    };
  }
  if (error.code === "PROVIDER_NOT_COMPLETED") {
    return {
      errorClass: "NOT_COMPLETED",
      stage: "BUSINESS_STATUS_CHECKED",
      responseClassification: "NOT_COMPLETED",
    };
  }
  if (error.code === "PROVIDER_SCHEMA_MISMATCH" || error.code.startsWith("AUDIO_")) {
    return {
      errorClass: "SUCCESS_SCHEMA_MISMATCH",
      stage: error.diagnostic?.musicStage === "SUCCESS_CORE_VALIDATED"
        || error.diagnostic?.musicStage === "HEX_VALIDATED"
        || error.diagnostic?.musicStage === "HEX_DECODED"
        || error.diagnostic?.musicStage === "SIZE_VALIDATED"
        || error.diagnostic?.musicStage === "MP3_VALIDATED"
        ? "SUCCESS_CORE_VALIDATED"
        : "JSON_PARSED",
      responseClassification: "SUCCESS_SCHEMA_MISMATCH",
    };
  }
  return {
    errorClass: "UNKNOWN",
    stage: "JSON_PARSED",
    responseClassification: "UNKNOWN",
  };
}

type TokenHubMusicExecutorDependencies = {
  fetcher?: typeof fetch;
  downloadAudio?: (value: string) => Promise<DownloadedTokenHubAudio>;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

function assertMusicExecutionContext(context: MusicGenerationExecutionContext): void {
  if (
    context.provider !== "tencent_tokenhub"
    || context.serverControlledModel !== TOKENHUB_MUSIC_MODEL
    || context.timeoutMs !== TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS
    || context.automaticProviderRetryCount !== 0
    || context.maxProviderCalls !== 1
  ) {
    throw new SafeTaskError("INTERNAL_ERROR", "Music Provider execution policy is invalid.", 500);
  }
}

export function createTencentTokenHubMusicExecutor(
  dependencies: TokenHubMusicExecutorDependencies = {},
): MusicGenerationExecutor {
  const fetcher = dependencies.fetcher ?? fetch;
  const downloadAudio = dependencies.downloadAudio ?? downloadTokenHubAudioURL;
  const now = dependencies.now ?? (() => performance.now());
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;

  return async (context) => {
    assertMusicExecutionContext(context);
    const request = buildTencentTokenHubMusicRequest(context.input);
    const requestShape = describeTencentTokenHubMusicRequest(request.body, context.input.mode);
    const sensitiveValues = [
      context.apiKey,
      context.input.title ?? "",
      context.input.prompt ?? "",
      context.input.mode === "custom_lyrics" ? context.input.lyrics : "",
    ];
    const controller = new AbortController();
    const timeout = setTimer(() => controller.abort(), TOKENHUB_MUSIC_GENERATION_TIMEOUT_MS);
    const requestStartedAt = now();
    let response: Response;
    try {
      response = await fetcher(request.url, {
        ...request.init,
        headers: {
          ...request.init.headers,
          Accept: "application/json",
          Authorization: `Bearer ${context.apiKey}`,
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted
        || (error instanceof Error && error.name === "AbortError");
      throw new AmbiguousMusicProviderError(
        timedOut ? "PROVIDER_TIMEOUT" : "NETWORK_ERROR",
        timedOut
          ? "Music Provider request timed out with an unknown outcome."
          : "Music Provider request ended with an unknown outcome.",
        normalizeMusicProviderFailureDiagnostics({
          providerResponseReceived: false,
          providerErrorClass: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
          providerFailureStage: "FETCH_DISPATCHED",
          providerResponseClassification: "NO_RESPONSE",
          providerResponseJsonParseable: false,
          providerRequestDurationMs: providerRequestDuration(now, requestStartedAt),
          requestShape,
        }),
      );
    } finally {
      clearTimer(timeout);
    }
    const responseReceivedAt = now();

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new AmbiguousMusicProviderError(
        "UNKNOWN_PROVIDER_RESULT",
        "Music Provider response ended with an unknown outcome.",
        normalizeMusicProviderFailureDiagnostics({
          providerResponseReceived: true,
          providerHttpStatus: response.status,
          providerErrorClass: "UNKNOWN",
          providerFailureStage: "RESPONSE_RECEIVED",
          providerResponseClassification: "UNKNOWN",
          providerResponseJsonParseable: false,
          providerRequestDurationMs: providerRequestDuration(now, requestStartedAt),
          requestShape,
        }),
      );
    }
    const responseCompletedAt = now();
    if (text.length > TOKENHUB_MAX_RESPONSE_CHARACTERS) {
      throw new SafeTaskError("PROVIDER_SCHEMA_MISMATCH", "Music Provider response exceeds the safe size limit.", 502, {
        provider: "tencent_tokenhub",
        failureStage: "schema_validation",
        httpStatus: response.status,
        providerCallCount: 1,
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) {
        const httpError = createTencentTokenHubMusicHTTPError(response.status, undefined, sensitiveValues);
        throw attachMusicFailureDiagnostics(httpError, {
          providerResponseReceived: true,
          providerHttpStatus: response.status,
          providerErrorClass: "HTTP_ERROR",
          providerFailureStage: "HTTP_VALIDATED",
          providerResponseClassification: "HTTP_ERROR_NON_JSON",
          providerResponseJsonParseable: false,
          providerRequestDurationMs: providerRequestDuration(now, requestStartedAt),
          requestShape,
        });
      }
      const invalidJSON = new SafeTaskError("PROVIDER_INVALID_JSON", "Music Provider returned invalid JSON.", 502, {
        provider: "tencent_tokenhub",
        failureStage: "json_parse",
        httpStatus: response.status,
        providerCallCount: 1,
      });
      throw attachMusicFailureDiagnostics(invalidJSON, {
        providerResponseReceived: true,
        providerHttpStatus: response.status,
        providerErrorClass: "MALFORMED_JSON",
        providerFailureStage: "RESPONSE_RECEIVED",
        providerResponseClassification: "MALFORMED_JSON",
        providerResponseJsonParseable: false,
        providerRequestDurationMs: providerRequestDuration(now, requestStartedAt),
        requestShape,
      });
    } finally {
      text = "";
    }

    if (!response.ok) {
      const httpError = createTencentTokenHubMusicHTTPError(response.status, payload, sensitiveValues);
      throw attachMusicFailureDiagnostics(httpError, {
        providerResponseReceived: true,
        providerHttpStatus: response.status,
        providerErrorClass: "HTTP_ERROR",
        providerFailureStage: "HTTP_VALIDATED",
        providerResponseClassification: "HTTP_ERROR_JSON",
        providerResponseJsonParseable: true,
        providerRequestDurationMs: providerRequestDuration(now, requestStartedAt),
        requestShape,
      });
    }

    let parsed: MusicGenerationProviderResult;
    try {
      parsed = await parseTencentTokenHubMusicResponseWithURL(response.status, payload, {
        downloadAudio,
        now,
        sensitiveValues,
      });
    } catch (error) {
      if (!(error instanceof SafeTaskError)) throw error;
      if (error.code.startsWith("AUDIO_URL_") || error.code.startsWith("AUDIO_DOWNLOAD_")) {
        throw error;
      }
      const classification = parsedFailureClassification(error);
      throw attachMusicFailureDiagnostics(error, {
        providerResponseReceived: true,
        providerHttpStatus: response.status,
        providerErrorClass: classification.errorClass,
        providerFailureStage: classification.stage,
        providerResponseClassification: classification.responseClassification,
        providerResponseJsonParseable: true,
        providerRequestDurationMs: Math.max(0, responseCompletedAt - requestStartedAt),
        requestShape,
      });
    }
    return {
      ...parsed,
      metrics: {
        ...parsed.metrics,
        providerRequestDurationMs: Math.max(0, responseCompletedAt - requestStartedAt),
        providerGenerationLatencyMs: Math.max(0, responseReceivedAt - requestStartedAt),
        providerResponseMs: Math.max(0, responseCompletedAt - responseReceivedAt),
      },
    };
  };
}

export const executeTencentTokenHubMusic = createTencentTokenHubMusicExecutor();
