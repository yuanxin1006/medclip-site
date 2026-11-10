import {
  SafeTaskError,
  type SafeTextTaskFailureClass,
} from "./errors.ts";
import type { AITaskId } from "./types.ts";
import type { AIProviderId } from "../ai-credentials/providers/types.ts";

export type TextTaskDiagnosticContext = {
  requestId: string;
  task: AITaskId;
  provider: AIProviderId;
  model: string | null;
  requestStartedAtMs: number;
  now?: () => number;
};

function inferredFailureClass(error: SafeTaskError): SafeTextTaskFailureClass {
  if (error.diagnostic?.failureClass) return error.diagnostic.failureClass;
  if (error.code === "PROVIDER_TIMEOUT" || error.code === "TASK_TIMEOUT") return "TIMEOUT";
  if (error.code === "NETWORK_ERROR") return "NETWORK_ERROR";
  if (error.code === "PROVIDER_INVALID_JSON") {
    return error.diagnostic?.failureStage === "json_parse"
      ? "CANONICAL_PARSE_ERROR"
      : "UPSTREAM_JSON_PARSE_ERROR";
  }
  if (error.code === "PROVIDER_EMPTY_CONTENT") return "UPSTREAM_CONTENT_MISSING";
  if (error.code === "PROVIDER_SCHEMA_MISMATCH") return "CANONICAL_SCHEMA_ERROR";
  if (error.code === "INTERNAL_ERROR" && error.diagnostic?.failureStage === "internal") {
    return "SAFE_RESULT_SERIALIZATION_ERROR";
  }
  return "UPSTREAM_HTTP_ERROR";
}

function inferredResponseReceived(error: SafeTaskError): boolean {
  if (typeof error.diagnostic?.providerResponseReceived === "boolean") {
    return error.diagnostic.providerResponseReceived;
  }
  return error.diagnostic?.failureStage !== "provider_request";
}

function inferredJsonParseable(error: SafeTaskError): boolean {
  if (typeof error.diagnostic?.responseJsonParseable === "boolean") {
    return error.diagnostic.responseJsonParseable;
  }
  return !["PROVIDER_INVALID_JSON", "NETWORK_ERROR", "PROVIDER_TIMEOUT", "TASK_TIMEOUT"]
    .includes(error.code);
}

function inferredCanonicalReached(error: SafeTaskError): boolean {
  if (typeof error.diagnostic?.canonicalValidationReached === "boolean") {
    return error.diagnostic.canonicalValidationReached;
  }
  return error.diagnostic?.failureStage === "schema_validation";
}

export function textTaskOperatorDiagnostic(
  error: unknown,
  context: TextTaskDiagnosticContext,
): Readonly<Record<string, unknown>> {
  const safeError = error instanceof SafeTaskError ? error : null;
  const now = context.now ?? (() => performance.now());
  const duration = Math.max(0, Math.round(now() - context.requestStartedAtMs));
  return Object.freeze({
    event: "medclip_text_task_failure",
    request_id: context.requestId,
    task: context.task,
    provider: context.provider,
    model: context.model,
    provider_response_received: safeError ? inferredResponseReceived(safeError) : false,
    provider_http_status: safeError?.diagnostic?.httpStatus ?? null,
    failure_stage: safeError?.diagnostic?.failureStage ?? "internal",
    failure_class: safeError ? inferredFailureClass(safeError) : "SAFE_RESULT_SERIALIZATION_ERROR",
    response_json_parseable: safeError ? inferredJsonParseable(safeError) : false,
    canonical_validation_reached: safeError ? inferredCanonicalReached(safeError) : false,
    request_duration_ms: Number.isSafeInteger(duration) ? duration : 0,
    safe_error_code: safeError?.code ?? "INTERNAL_TASK_ERROR",
  });
}
