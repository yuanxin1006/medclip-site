export const DOUBAO_API_KEY_RESOURCE_ID_PATTERN =
  /^apikey-[A-Za-z0-9][A-Za-z0-9._-]{0,192}$/;

export const DOUBAO_FIXED_TEXT_MODEL = "doubao-seed-2-1-lite-260915";

export function isDoubaoAPIKeyResourceId(value: unknown): value is string {
  return typeof value === "string" && DOUBAO_API_KEY_RESOURCE_ID_PATTERN.test(value);
}
