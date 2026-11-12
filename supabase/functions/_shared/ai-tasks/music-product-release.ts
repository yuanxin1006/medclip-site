import { SafeTaskError } from "./errors.ts";
import type { AsyncMusicMockScenario } from "./music-product-async.ts";
import { requireAuthenticatedTaskUserId } from "./request.ts";

export const MUSIC_GENERATION_AVAILABILITY_ACTION = "music.generation_availability" as const;
export const MUSIC_TEST_RELEASE_MODE_ENV = "MEDCLIP_MUSIC_TEST_RELEASE_MODE";
export const MUSIC_TESTER_USER_IDS_ENV = "MEDCLIP_MUSIC_TESTER_USER_IDS";
export const MUSIC_TEST_SCENARIO_ENV = "MEDCLIP_MUSIC_TEST_SCENARIO";
export const MUSIC_PUBLIC_RELEASE_MODE_ENV = "MEDCLIP_MUSIC_PUBLIC_RELEASE_MODE";
export const MUSIC_USER_DAILY_PROVIDER_LIMIT_ENV = "MEDCLIP_MUSIC_USER_DAILY_PROVIDER_LIMIT";
export const MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT_ENV = "MEDCLIP_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT";
export const MUSIC_PUBLIC_RELEASE_MODE = "PUBLIC_AUTHENTICATED_BETA" as const;
// Fallbacks used only when the corresponding Edge Function environment
// variable is absent. Production should set the environment variables
// explicitly so quota changes are auditable without changing application code.
export const DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT = 10;
export const DEFAULT_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT = 20;
export const TESTER_MOCK_STEP_DELAY_MS = 4_500;

export type MusicProductAvailabilityRequest = {
  action: typeof MUSIC_GENERATION_AVAILABILITY_ACTION;
};

export type MusicProductRelease = {
  enabled: boolean;
  executionMode: MusicProductExecutionMode | null;
  testerMockEnabled: boolean;
  testerLiveEnabled: boolean;
  publicAuthenticatedBetaEnabled: boolean;
  mockScenario?: AsyncMusicMockScenario;
  mockStepDelayMs?: number;
  dispatchPolicy?: MusicDispatchPolicy;
};

export type MusicProductExecutionMode = "trusted_mock" | "tester_live" | "public_real";

export type MusicProductAvailability = {
  enabled: boolean;
  testerModeEnabled: boolean;
};

export type MusicDispatchPolicy = {
  countsPaidDispatch: boolean;
  enforceUserDailyLimit: boolean;
  userDailyLimit: number;
  globalDailyLimit: number;
  quotaWindow: "UTC_CALENDAR_DAY";
};

type EnvironmentReader = (name: string) => string | undefined;

const AVAILABILITY_FIELDS = new Set(["action"]);
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEST_SCENARIOS = new Set<AsyncMusicMockScenario>([
  "success",
  "provider_failure",
  "unknown_after_dispatch",
]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function configurationError(): never {
  throw new SafeTaskError("INTERNAL_ERROR", "Music generation test release configuration is invalid.", 500);
}

export function isMusicProductAvailabilityEnvelope(value: unknown): boolean {
  return plainRecord(value) && value.action === MUSIC_GENERATION_AVAILABILITY_ACTION;
}

export function parseMusicProductAvailabilityRequest(value: unknown): MusicProductAvailabilityRequest {
  if (
    !plainRecord(value)
    || Object.keys(value).some((key) => !AVAILABILITY_FIELDS.has(key))
    || value.action !== MUSIC_GENERATION_AVAILABILITY_ACTION
  ) {
    throw new SafeTaskError("INVALID_INPUT", "Music generation availability request is invalid.", 400);
  }
  return { action: MUSIC_GENERATION_AVAILABILITY_ACTION };
}

function authorizedTesterIds(value: string | undefined): ReadonlySet<string> {
  if (!value) configurationError();
  const ids = value.split(",").map((item) => item.trim().toLowerCase());
  if (ids.length === 0 || ids.length > 10 || ids.some((id) => !USER_ID_PATTERN.test(id))) {
    configurationError();
  }
  return new Set(ids);
}

function testerScenario(value: string | undefined): AsyncMusicMockScenario {
  const scenario = value ?? "success";
  if (!TEST_SCENARIOS.has(scenario as AsyncMusicMockScenario)) configurationError();
  return scenario as AsyncMusicMockScenario;
}

function positiveLimit(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9][0-9]{0,5}$/.test(value)) configurationError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 100_000) configurationError();
  return parsed;
}

function realDispatchPolicy(
  readEnvironment: EnvironmentReader,
  enforceUserDailyLimit: boolean,
): MusicDispatchPolicy {
  return {
    countsPaidDispatch: true,
    enforceUserDailyLimit,
    userDailyLimit: positiveLimit(
      readEnvironment(MUSIC_USER_DAILY_PROVIDER_LIMIT_ENV),
      DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT,
    ),
    globalDailyLimit: positiveLimit(
      readEnvironment(MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT_ENV),
      DEFAULT_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT,
    ),
    quotaWindow: "UTC_CALENDAR_DAY",
  };
}

export const PROVIDER_FREE_MUSIC_DISPATCH_POLICY: MusicDispatchPolicy = {
  countsPaidDispatch: false,
  enforceUserDailyLimit: false,
  userDailyLimit: DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT,
  globalDailyLimit: DEFAULT_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT,
  quotaWindow: "UTC_CALENDAR_DAY",
};

const MUSIC_PRODUCT_RELEASE_OFF: MusicProductRelease = {
  enabled: false,
  executionMode: null,
  testerMockEnabled: false,
  testerLiveEnabled: false,
  publicAuthenticatedBetaEnabled: false,
};

export function musicProductAvailability(release: MusicProductRelease): MusicProductAvailability {
  return {
    enabled: release.enabled,
    testerModeEnabled: release.testerMockEnabled || release.testerLiveEnabled,
  };
}

export function resolveMusicProductExecutionMode(
  release: MusicProductRelease,
  internalLiveValidation: boolean,
): MusicProductExecutionMode | null {
  return internalLiveValidation ? "trusted_mock" : release.executionMode;
}

export function resolveMusicProductRelease(
  authenticatedUserId: string,
  readEnvironment: EnvironmentReader,
): MusicProductRelease {
  const userId = requireAuthenticatedTaskUserId(authenticatedUserId);
  const mode = readEnvironment(MUSIC_TEST_RELEASE_MODE_ENV) ?? "OFF";
  if (mode !== "OFF" && mode !== "TESTER_MOCK" && mode !== "TESTER_LIVE") configurationError();
  if (mode !== "OFF" && authorizedTesterIds(readEnvironment(MUSIC_TESTER_USER_IDS_ENV)).has(userId)) {
    if (mode === "TESTER_LIVE") {
      return {
        // The real tester path contributes to the global paid-dispatch ceiling,
        // while its per-user policy remains separate from the public beta.
        enabled: true,
        executionMode: "tester_live",
        testerMockEnabled: false,
        testerLiveEnabled: true,
        publicAuthenticatedBetaEnabled: false,
        dispatchPolicy: realDispatchPolicy(readEnvironment, false),
      };
    }
    return {
      enabled: true,
      executionMode: "trusted_mock",
      testerMockEnabled: true,
      testerLiveEnabled: false,
      publicAuthenticatedBetaEnabled: false,
      mockScenario: testerScenario(readEnvironment(MUSIC_TEST_SCENARIO_ENV)),
      mockStepDelayMs: TESTER_MOCK_STEP_DELAY_MS,
      dispatchPolicy: PROVIDER_FREE_MUSIC_DISPATCH_POLICY,
    };
  }
  const publicMode = readEnvironment(MUSIC_PUBLIC_RELEASE_MODE_ENV) ?? "OFF";
  if (publicMode === "OFF") return MUSIC_PRODUCT_RELEASE_OFF;
  if (publicMode !== MUSIC_PUBLIC_RELEASE_MODE) configurationError();
  return {
    enabled: true,
    executionMode: "public_real",
    testerMockEnabled: false,
    testerLiveEnabled: false,
    publicAuthenticatedBetaEnabled: true,
    dispatchPolicy: realDispatchPolicy(readEnvironment, true),
  };
}
