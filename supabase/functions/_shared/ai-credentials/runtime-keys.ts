export type RuntimeEnvironmentReader = (name: string) => string | undefined;

export type SupabaseRuntimeKeys = {
  publishableKey: string;
  secretKey: string;
};

const CONFIGURATION_ERROR = "Supabase runtime key configuration is incomplete.";

function configurationError(): Error {
  return new Error(CONFIGURATION_ERROR);
}

function readDefaultKey(rawKeySet: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeySet);
  } catch {
    throw configurationError();
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw configurationError();
  }

  const defaultKey = (parsed as Record<string, unknown>).default;
  if (typeof defaultKey !== "string" || defaultKey.trim().length === 0) {
    throw configurationError();
  }
  return defaultKey;
}

function readPreferredKey(
  readEnvironment: RuntimeEnvironmentReader,
  keySetName: string,
  legacyName: string,
): string {
  const keySet = readEnvironment(keySetName);
  if (keySet !== undefined) return readDefaultKey(keySet);

  const legacyKey = readEnvironment(legacyName);
  if (!legacyKey || legacyKey.trim().length === 0) throw configurationError();
  return legacyKey;
}

export function resolveSupabaseRuntimeKeys(
  readEnvironment: RuntimeEnvironmentReader,
): SupabaseRuntimeKeys {
  return {
    publishableKey: readPreferredKey(
      readEnvironment,
      "SUPABASE_PUBLISHABLE_KEYS",
      "SUPABASE_ANON_KEY",
    ),
    secretKey: readPreferredKey(
      readEnvironment,
      "SUPABASE_SECRET_KEYS",
      "SUPABASE_SERVICE_ROLE_KEY",
    ),
  };
}
