// Only these local constants can cross the error-response/log boundary.
// Upstream codes and messages are used for classification, never returned.
export type ProviderHTTPCategory = "AUTH_REJECTED" | "QUOTA_OR_BALANCE" | "ACCOUNT_TIER_RESTRICTED" | "CAPACITY_EXHAUSTED" | "RATE_LIMITED" | "CONFIGURATION_REJECTED" | "UPSTREAM_UNAVAILABLE";
const messages: Record<ProviderHTTPCategory, string> = {
  AUTH_REJECTED: "Provider authentication rejected.",
  QUOTA_OR_BALANCE: "Account quota or balance is insufficient.",
  ACCOUNT_TIER_RESTRICTED: "Account tier does not allow model access.",
  CAPACITY_EXHAUSTED: "Provider capacity is unavailable.",
  RATE_LIMITED: "Provider rate limit reached.",
  CONFIGURATION_REJECTED: "Provider configuration or request rejected.",
  UPSTREAM_UNAVAILABLE: "Provider temporarily unavailable.",
};
export async function fixedProviderHTTPDiagnostic(response: Response, sensitiveValues: readonly string[] = []) {
  let text = "";
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const error = (payload as Record<string, unknown>).error;
      if (error && typeof error === "object" && !Array.isArray(error)) {
        const record = error as Record<string, unknown>;
        text = [record.code, record.message].filter((v) => typeof v === "string" || typeof v === "number").join(" ");
      }
    }
  } catch { /* HTTP status alone still gives a safe, useful category. */ }
  for (const secret of sensitiveValues) if (secret) text = text.split(secret).join(" ");
  text = text.toLowerCase();
  let category: ProviderHTTPCategory = "UPSTREAM_UNAVAILABLE";
  if (response.status === 401 || response.status === 403) category = "AUTH_REJECTED";
  else if (response.status === 402 || /quota|balance|billing|payment|insufficient/.test(text)) category = "QUOTA_OR_BALANCE";
  else if (response.status === 429) category = /account.?tier|model.?access|not.?allowed|access.?denied|subscription/.test(text)
    ? "ACCOUNT_TIER_RESTRICTED"
    : /capacity|overload|busy/.test(text) ? "CAPACITY_EXHAUSTED" : "RATE_LIMITED";
  else if ([400, 404, 422].includes(response.status)) category = "CONFIGURATION_REJECTED";
  return { providerErrorCode: category, sanitizedProviderErrorMessage: messages[category] };
}
