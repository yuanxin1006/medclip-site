const FORBIDDEN_INTERNAL_MARKERS = [
  "ciphertext",
  "encryption_key",
  "raw_response",
  "reasoning_content",
  "editingRequirement",
  "editorContext",
  "api_key",
] as const;

const SECRET_PATTERNS = [
  /\bauthorization\s*:\s*bearer\s+(?!<)[^\s,;}"']+/i,
  /\bbearer[\t ]+(?=[A-Za-z0-9._~+/=-]{12,}(?:$|[\s,;}"']))(?=[A-Za-z0-9._~+/=-]*[0-9._~+/-])[A-Za-z0-9._~+/=-]+/i,
  /\b(?:sk-(?:proj-)?|sb_secret_|ark-)[A-Za-z0-9_-]{12,}\b/i,
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/,
] as const;

export class VerifierSecretExposureError extends Error {
  constructor() {
    super("Verifier output contains sensitive data.");
    this.name = "VerifierSecretExposureError";
  }
}

export function assertSafeVerifierOutput(
  value: unknown,
  knownSensitiveValues: readonly (string | undefined | null)[],
): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const normalized = serialized.toLowerCase();
  if (FORBIDDEN_INTERNAL_MARKERS.some((marker) => normalized.includes(marker.toLowerCase()))) {
    throw new VerifierSecretExposureError();
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(serialized))) {
    throw new VerifierSecretExposureError();
  }
  if (knownSensitiveValues.some((secret) => Boolean(secret) && serialized.includes(secret!))) {
    throw new VerifierSecretExposureError();
  }
}
