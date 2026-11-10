import type {
  AITaskStatus,
  SafeTaskDiagnostic,
  SafeTaskFailureStage,
} from "./errors.ts";

export class TextProviderResponseReadError extends Error {
  readonly kind: "body_read" | "json_parse";

  constructor(kind: "body_read" | "json_parse") {
    super(kind);
    this.name = "TextProviderResponseReadError";
    this.kind = kind;
  }
}

export async function readTextProviderJSON(response: Response): Promise<unknown> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new TextProviderResponseReadError("body_read");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new TextProviderResponseReadError("json_parse");
  }
}

export function textFailureObservation(
  code: AITaskStatus,
  failureStage: SafeTaskFailureStage,
): Pick<
  SafeTaskDiagnostic,
  "failureClass" | "providerResponseReceived" | "responseJsonParseable" | "canonicalValidationReached"
> {
  if (code === "PROVIDER_TIMEOUT" || code === "TASK_TIMEOUT") {
    return {
      failureClass: "TIMEOUT",
      providerResponseReceived: false,
      responseJsonParseable: false,
      canonicalValidationReached: false,
    };
  }
  if (code === "NETWORK_ERROR") {
    return {
      failureClass: "NETWORK_ERROR",
      providerResponseReceived: false,
      responseJsonParseable: false,
      canonicalValidationReached: false,
    };
  }
  if (code === "PROVIDER_INVALID_JSON") {
    return {
      failureClass: failureStage === "json_parse"
        ? "CANONICAL_PARSE_ERROR"
        : "UPSTREAM_JSON_PARSE_ERROR",
      providerResponseReceived: true,
      responseJsonParseable: failureStage === "json_parse",
      canonicalValidationReached: false,
    };
  }
  if (code === "PROVIDER_EMPTY_CONTENT") {
    return {
      failureClass: "UPSTREAM_CONTENT_MISSING",
      providerResponseReceived: true,
      responseJsonParseable: true,
      canonicalValidationReached: false,
    };
  }
  if (code === "PROVIDER_SCHEMA_MISMATCH") {
    return {
      failureClass: "CANONICAL_SCHEMA_ERROR",
      providerResponseReceived: true,
      responseJsonParseable: true,
      canonicalValidationReached: true,
    };
  }
  return {
    failureClass: "UPSTREAM_HTTP_ERROR",
    providerResponseReceived: true,
    responseJsonParseable: false,
    canonicalValidationReached: false,
  };
}

export const UPSTREAM_HTTP_FAILURE_OBSERVATION = Object.freeze({
  failureClass: "UPSTREAM_HTTP_ERROR" as const,
  providerResponseReceived: true,
  responseJsonParseable: false,
  canonicalValidationReached: false,
});
