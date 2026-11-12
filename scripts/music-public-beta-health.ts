import { createHash } from "node:crypto";
import {
  DEFAULT_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT,
  DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT,
  MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT_ENV,
  MUSIC_PUBLIC_RELEASE_MODE,
  MUSIC_PUBLIC_RELEASE_MODE_ENV,
  MUSIC_TEST_RELEASE_MODE_ENV,
  MUSIC_USER_DAILY_PROVIDER_LIMIT_ENV,
} from "../supabase/functions/_shared/ai-tasks/music-product-release.ts";

export const HEALTH_WINDOWS = [
  "current-utc-day",
  "previous-utc-day",
  "last-24-hours",
  "last-7-utc-days",
] as const;
export type HealthWindowName = typeof HEALTH_WINDOWS[number];

export const MONITORED_STATES = [
  "RESERVED",
  "PROVIDER_IN_FLIGHT",
  "FINALIZING",
  "COMPLETED",
  "FAILED",
  "UNKNOWN",
] as const;

export const DEFAULT_STALE_THRESHOLDS_SECONDS = Object.freeze({
  RESERVED: 10 * 60,
  PROVIDER_IN_FLIGHT: 15 * 60,
  FINALIZING: 10 * 60,
});

// Percentages remain informational until the seven-day sample reaches 20.
// Failure clustering starts at five dispatches so one-off failures never look
// statistically equivalent to sustained production behavior.
export const TRAFFIC_MEANINGFUL_SAMPLE_MIN = 20;
export const FAILURE_CLUSTER_MIN_DISPATCHES = 5;
export const FAILURE_CLUSTER_PERCENT = 20;
export const CRITICAL_FAILURE_MIN_DISPATCHES = 20;
export const CRITICAL_FAILURE_PERCENT = 50;
export const FUSE_ATTENTION_PERCENT = 70;
export const MULTIPLE_UNKNOWN_CRITICAL_COUNT = 2;
export const PERSISTENT_UNKNOWN_SECONDS = 15 * 60;
export const SEVERELY_STALE_ACTIVE_SECONDS = 60 * 60;

export const KNOWN_INTERNAL_ACCEPTANCE_OPERATION_IDS = Object.freeze([
  "c1d_tokenhub_music_v26_url_20261009_live1",
  "c1d_tokenhub_music_v26_url_20261009_live2",
  "142feedc-364d-4445-8f7a-df25a6071f7b",
  "38e41da9-a547-487c-a9fb-68b182383a46",
] as const);

export type ProvenanceClass =
  | "PUBLIC_BETA_CONFIRMED"
  | "INTERNAL_ACCEPTANCE_CONFIRMED"
  | "TESTER_LIVE_CONFIRMED"
  | "PRE_PUBLIC_HISTORICAL"
  | "UNKNOWN_PROVENANCE";

export type ProvenanceConfidence = "HIGH" | "MEDIUM" | "LOW";

export type ProvenanceAuditRow = Readonly<{
  operationId: string;
  providerDispatchedAt: string;
  state: "COMPLETED" | "FAILED" | "UNKNOWN" | "RESERVED" | "PROVIDER_IN_FLIGHT" | "FINALIZING";
  ownerBucket: number;
  trackCreated: boolean;
  failureCode: string | null;
  diagnosticsAvailable: boolean;
  diagnosticClass: string;
  failureStage: string;
  responseClassification: string;
  httpStatus: string;
  safeErrorCode: string;
  durableReleaseMode?: "PUBLIC_AUTHENTICATED_BETA" | "TESTER_LIVE" | null;
}>;

export function classifyDispatchProvenance(
  row: ProvenanceAuditRow,
  publicBetaGoLiveAt: string,
): Readonly<{ provenanceClass: ProvenanceClass; confidence: ProvenanceConfidence; evidence: string }> {
  const dispatchedAt = new Date(row.providerDispatchedAt);
  const goLiveAt = new Date(publicBetaGoLiveAt);
  if (!Number.isFinite(dispatchedAt.getTime()) || !Number.isFinite(goLiveAt.getTime())) {
    throw new Error("INVALID_PROVENANCE_TIMESTAMP");
  }
  if ((KNOWN_INTERNAL_ACCEPTANCE_OPERATION_IDS as readonly string[]).includes(row.operationId)) {
    return Object.freeze({
      provenanceClass: "INTERNAL_ACCEPTANCE_CONFIRMED",
      confidence: "HIGH",
      evidence: "KNOWN_ACCEPTANCE_OPERATION_ID",
    });
  }
  if (row.durableReleaseMode === "PUBLIC_AUTHENTICATED_BETA") {
    return Object.freeze({
      provenanceClass: "PUBLIC_BETA_CONFIRMED",
      confidence: "HIGH",
      evidence: "DURABLE_RELEASE_MODE",
    });
  }
  if (row.durableReleaseMode === "TESTER_LIVE") {
    return Object.freeze({
      provenanceClass: "TESTER_LIVE_CONFIRMED",
      confidence: "HIGH",
      evidence: "DURABLE_RELEASE_MODE",
    });
  }
  if (dispatchedAt.getTime() < goLiveAt.getTime()) {
    return Object.freeze({
      provenanceClass: "PRE_PUBLIC_HISTORICAL",
      confidence: "HIGH",
      evidence: "DISPATCH_PRECEDES_AUTHORITATIVE_GO_LIVE_BOUNDARY",
    });
  }
  return Object.freeze({
    provenanceClass: "UNKNOWN_PROVENANCE",
    confidence: "LOW",
    evidence: "NO_DURABLE_RELEASE_MODE_AT_DISPATCH",
  });
}

export function summarizeProvenance(
  rows: readonly ProvenanceAuditRow[],
  publicBetaGoLiveAt: string,
  sevenDayWindow: HealthWindow,
) {
  const start = new Date(sevenDayWindow.start).getTime();
  const end = new Date(sevenDayWindow.end).getTime();
  const goLive = new Date(publicBetaGoLiveAt).getTime();
  if (![start, end, goLive].every(Number.isFinite)) throw new Error("INVALID_PROVENANCE_WINDOW");
  const classified = rows.map((row) => Object.freeze({
    ...row,
    ...classifyDispatchProvenance(row, publicBetaGoLiveAt),
  }));
  const sevenDay = classified.filter((row) => {
    const dispatched = new Date(row.providerDispatchedAt).getTime();
    return dispatched >= start && dispatched < end;
  });
  const confirmedPublic = sevenDay.filter((row) => row.provenanceClass === "PUBLIC_BETA_CONFIRMED");
  const confirmedInternal = sevenDay.filter((row) => (
    row.provenanceClass === "INTERNAL_ACCEPTANCE_CONFIRMED"
    || row.provenanceClass === "TESTER_LIVE_CONFIRMED"
  ));
  const unknown = sevenDay.filter((row) => (
    row.provenanceClass === "UNKNOWN_PROVENANCE"
    || row.provenanceClass === "PRE_PUBLIC_HISTORICAL"
  ));
  const postGoLive = classified.filter((row) => new Date(row.providerDispatchedAt).getTime() >= goLive);
  const outcomes = (items: readonly typeof classified[number][]) => Object.freeze({
    dispatches: items.length,
    completed: items.filter((row) => row.state === "COMPLETED").length,
    failed: items.filter((row) => row.state === "FAILED").length,
    unknown: items.filter((row) => row.state === "UNKNOWN").length,
  });
  const publicOutcomes = outcomes(confirmedPublic);
  return Object.freeze({
    classified: Object.freeze(classified),
    allSevenDay: outcomes(sevenDay),
    confirmedPublic: Object.freeze({
      ...publicOutcomes,
      completionRate: percentage(publicOutcomes.completed, publicOutcomes.dispatches),
      uniqueUsers: new Set(confirmedPublic.map((row) => row.ownerBucket)).size,
    }),
    confirmedInternal: outcomes(confirmedInternal),
    unknownProvenance: outcomes(unknown),
    postGoLive: outcomes(postGoLive),
    legacyUnclassifiedFailures: sevenDay.filter((row) => (
      row.state === "FAILED" && !row.diagnosticsAvailable
    )).length,
  });
}

export type HealthWindow = Readonly<{
  name: HealthWindowName;
  start: string;
  end: string;
}>;

export type ReleaseConfiguration = Readonly<{
  publicReleaseState: "ON" | "OFF";
  testerLiveState: "ON" | "OFF";
  testerMockState: "ON" | "OFF";
  userDailyLimit: number;
  globalDailyLimit: number;
  quotaWindow: "UTC_CALENDAR_DAY";
  automaticRetry: 0;
  fallbackPolicy: "NONE";
}>;

export type SecretHashMap = Readonly<Record<string, string>>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function iso(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("INVALID_REPORT_TIME");
  return date.toISOString();
}

export function resolveUtcWindow(name: HealthWindowName, now = new Date()): HealthWindow {
  if (!(HEALTH_WINDOWS as readonly string[]).includes(name)) throw new Error("INVALID_REPORT_WINDOW");
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) throw new Error("INVALID_REPORT_TIME");
  const midnight = new Date(Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
  ));
  if (name === "current-utc-day") {
    return { name, start: iso(midnight), end: iso(new Date(midnight.getTime() + 86_400_000)) };
  }
  if (name === "previous-utc-day") {
    return { name, start: iso(new Date(midnight.getTime() - 86_400_000)), end: iso(midnight) };
  }
  if (name === "last-7-utc-days") {
    return {
      name,
      start: iso(new Date(midnight.getTime() - (6 * 86_400_000))),
      end: iso(new Date(midnight.getTime() + 86_400_000)),
    };
  }
  return { name, start: iso(new Date(current.getTime() - 86_400_000)), end: iso(current) };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 100_000) {
    throw new Error("INVALID_MONITOR_QUOTA_LIMIT");
  }
  return candidate;
}

function readMode(
  hashes: SecretHashMap,
  name: string,
  allowed: readonly string[],
  fallback: string,
): string {
  const hash = hashes[name];
  if (!hash) return fallback;
  const match = allowed.find((value) => sha256(value) === hash.toLowerCase());
  if (!match) throw new Error(`UNRECOGNIZED_${name}`);
  return match;
}

function readLimit(
  hashes: SecretHashMap,
  name: string,
  supplied: number | undefined,
  fallback: number,
): number {
  const hash = hashes[name];
  if (!hash) return positiveLimit(undefined, fallback);
  const value = positiveLimit(supplied, fallback);
  if (supplied === undefined || sha256(String(value)) !== hash.toLowerCase()) {
    throw new Error(`${name}_REQUIRES_MATCHING_OPERATOR_LIMIT`);
  }
  return value;
}

export function resolveReleaseConfiguration(
  hashes: SecretHashMap,
  supplied: Readonly<{ userDailyLimit?: number; globalDailyLimit?: number }> = {},
): ReleaseConfiguration {
  const publicMode = readMode(
    hashes,
    MUSIC_PUBLIC_RELEASE_MODE_ENV,
    ["OFF", MUSIC_PUBLIC_RELEASE_MODE],
    "OFF",
  );
  const testerMode = readMode(
    hashes,
    MUSIC_TEST_RELEASE_MODE_ENV,
    ["OFF", "TESTER_LIVE", "TESTER_MOCK"],
    "OFF",
  );
  return Object.freeze({
    publicReleaseState: publicMode === MUSIC_PUBLIC_RELEASE_MODE ? "ON" : "OFF",
    testerLiveState: testerMode === "TESTER_LIVE" ? "ON" : "OFF",
    testerMockState: testerMode === "TESTER_MOCK" ? "ON" : "OFF",
    userDailyLimit: readLimit(
      hashes,
      MUSIC_USER_DAILY_PROVIDER_LIMIT_ENV,
      supplied.userDailyLimit,
      DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT,
    ),
    globalDailyLimit: readLimit(
      hashes,
      MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT_ENV,
      supplied.globalDailyLimit,
      DEFAULT_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT,
    ),
    quotaWindow: "UTC_CALENDAR_DAY",
    automaticRetry: 0,
    fallbackPolicy: "NONE",
  });
}

export function percentage(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator < 0 || denominator < 0) {
    throw new Error("INVALID_METRIC_COUNT");
  }
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

export function calculateFuse(used: number, limit: number) {
  if (!Number.isSafeInteger(used) || used < 0) throw new Error("INVALID_FUSE_USAGE");
  const safeLimit = positiveLimit(limit, DEFAULT_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT);
  return Object.freeze({
    used,
    limit: safeLimit,
    remaining: Math.max(0, safeLimit - used),
    utilizationPercent: percentage(Math.min(used, safeLimit), safeLimit),
    exhausted: used >= safeLimit,
  });
}

export function statusDistribution(total: number, input: Readonly<Record<string, number>>) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("INVALID_STATUS_TOTAL");
  return Object.fromEntries(MONITORED_STATES.map((state) => {
    const count = input[state] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("INVALID_STATUS_COUNT");
    return [state, Object.freeze({ count, percentage: percentage(count, total) })];
  }));
}

export function staleCount(agesSeconds: readonly number[], thresholdSeconds: number): number {
  if (!Number.isFinite(thresholdSeconds) || thresholdSeconds < 0) throw new Error("INVALID_STALE_THRESHOLD");
  return agesSeconds.filter((age) => Number.isFinite(age) && age > thresholdSeconds).length;
}

export type TrafficEvidence = "NO_REAL_TRAFFIC" | "LOW_SAMPLE" | "MEANINGFUL_SAMPLE";

export function classifyTrafficEvidence(dispatches: number): TrafficEvidence {
  if (!Number.isSafeInteger(dispatches) || dispatches < 0) throw new Error("INVALID_TRAFFIC_SAMPLE");
  if (dispatches === 0) return "NO_REAL_TRAFFIC";
  return dispatches < TRAFFIC_MEANINGFUL_SAMPLE_MIN ? "LOW_SAMPLE" : "MEANINGFUL_SAMPLE";
}

export type DailyTrendInput = Readonly<{
  date: string;
  dispatches: number;
  completed: number;
  failed: number;
  unknown: number;
  uniqueUsers: number;
  staleActive: number;
}>;

function safeDailyRow(row: DailyTrendInput, globalLimit: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new Error("INVALID_TREND_DATE");
  for (const value of [
    row.dispatches,
    row.completed,
    row.failed,
    row.unknown,
    row.uniqueUsers,
    row.staleActive,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("INVALID_TREND_COUNT");
  }
  if (row.completed + row.failed + row.unknown > row.dispatches) throw new Error("INVALID_TREND_OUTCOMES");
  return Object.freeze({
    ...row,
    completionRate: percentage(row.completed, row.dispatches),
    fuseUtilizationPercent: calculateFuse(row.dispatches, globalLimit).utilizationPercent,
  });
}

export function summarizeSevenDayTrend(
  rows: readonly DailyTrendInput[],
  globalLimit: number,
  uniqueDispatchUsers: number,
) {
  if (rows.length !== 7) throw new Error("SEVEN_DAY_TREND_REQUIRES_SEVEN_ROWS");
  if (!Number.isSafeInteger(uniqueDispatchUsers) || uniqueDispatchUsers < 0) {
    throw new Error("INVALID_TREND_UNIQUE_USERS");
  }
  const sorted = [...rows].sort((left, right) => left.date.localeCompare(right.date));
  if (new Set(sorted.map((row) => row.date)).size !== 7) throw new Error("SEVEN_DAY_TREND_DATES_NOT_UNIQUE");
  const daily = sorted.map((row) => safeDailyRow(row, globalLimit));
  const sum = (field: keyof DailyTrendInput) => daily.reduce((total, row) => total + Number(row[field]), 0);
  const realDispatches = sum("dispatches");
  const completed = sum("completed");
  const failed = sum("failed");
  const unknown = sum("unknown");
  const utilizationTotal = daily.reduce((total, row) => total + row.fuseUtilizationPercent, 0);
  return Object.freeze({
    daily: Object.freeze(daily),
    realDispatches,
    completed,
    failed,
    unknown,
    completionRate: percentage(completed, realDispatches),
    uniqueDispatchUsers,
    peakDailyDispatches: Math.max(...daily.map((row) => row.dispatches)),
    peakDailyFuseUtilizationPercent: Math.max(...daily.map((row) => row.fuseUtilizationPercent)),
    averageDailyFuseUtilizationPercent: Math.round((utilizationTotal / 7) * 100) / 100,
    daysAtOrAbove70PercentFuse: daily.filter((row) => row.fuseUtilizationPercent >= FUSE_ATTENTION_PERCENT).length,
    daysFuseExhausted: daily.filter((row) => row.dispatches >= globalLimit).length,
    daysWithUnknown: daily.filter((row) => row.unknown > 0).length,
    daysWithStaleActive: daily.filter((row) => row.staleActive > 0).length,
  });
}

export function buildSevenDayTrendSql(
  now = new Date(),
  thresholds = DEFAULT_STALE_THRESHOLDS_SECONDS,
): string {
  const window = resolveUtcWindow("last-7-utc-days", now);
  const reservedThreshold = positiveLimit(thresholds.RESERVED, DEFAULT_STALE_THRESHOLDS_SECONDS.RESERVED);
  const providerThreshold = positiveLimit(thresholds.PROVIDER_IN_FLIGHT, DEFAULT_STALE_THRESHOLDS_SECONDS.PROVIDER_IN_FLIGHT);
  const finalizingThreshold = positiveLimit(thresholds.FINALIZING, DEFAULT_STALE_THRESHOLDS_SECONDS.FINALIZING);
  const sql = `with
params as (
  select ${sqlLiteral(window.start)}::timestamptz as window_start,
         ${sqlLiteral(window.end)}::timestamptz as window_end,
         ${sqlLiteral(window.end)}::timestamptz - interval '1 day' as today_start
),
days as (
  select generate_series(
    (select window_start from params),
    (select window_end from params) - interval '1 day',
    interval '1 day'
  ) as day_start
),
dispatches as (
  select operation.*
  from medclip_private.music_generation_operations operation, params
  where operation.provider_dispatched_at >= params.window_start
    and operation.provider_dispatched_at < params.window_end
),
daily_dispatches as (
  select date_trunc('day', provider_dispatched_at at time zone 'UTC')::date as day,
    count(*)::int as dispatches,
    count(*) filter (where state='COMPLETED')::int as completed,
    count(*) filter (where state='FAILED')::int as failed,
    count(*) filter (where state='UNKNOWN')::int as unknown,
    count(distinct user_id)::int as unique_users
  from dispatches
  group by 1
),
current_stale_by_day as (
  select (updated_at at time zone 'UTC')::date as day, count(*)::int as stale_active
  from medclip_private.music_generation_operations
  where (state='RESERVED' and updated_at < statement_timestamp() - make_interval(secs => ${reservedThreshold}))
     or (state='PROVIDER_IN_FLIGHT' and updated_at < statement_timestamp() - make_interval(secs => ${providerThreshold}))
     or (state='FINALIZING' and updated_at < statement_timestamp() - make_interval(secs => ${finalizingThreshold}))
  group by 1
),
daily as (
  select to_char(days.day_start at time zone 'UTC','YYYY-MM-DD') as date,
    coalesce(daily_dispatches.dispatches,0)::int as dispatches,
    coalesce(daily_dispatches.completed,0)::int as completed,
    coalesce(daily_dispatches.failed,0)::int as failed,
    coalesce(daily_dispatches.unknown,0)::int as unknown,
    coalesce(daily_dispatches.unique_users,0)::int as unique_users,
    coalesce(current_stale_by_day.stale_active,0)::int as stale_active
  from days
  left join daily_dispatches on daily_dispatches.day=days.day_start::date
  left join current_stale_by_day on current_stale_by_day.day=days.day_start::date
  order by days.day_start
),
failure_rows as (
  select provider_dispatched_at, failure_diagnostics
  from dispatches where state in ('FAILED','UNKNOWN')
),
failure_dimensions as (
  select provider_dispatched_at,
    coalesce(failure_diagnostics->>'provider_error_class','UNCLASSIFIED') as class,
    coalesce(failure_diagnostics->>'provider_failure_stage','UNCLASSIFIED') as stage,
    coalesce(failure_diagnostics->>'provider_response_classification','UNCLASSIFIED') as response_classification,
    coalesce(failure_diagnostics->>'provider_error_code','UNCLASSIFIED') as error_code,
    case
      when coalesce(failure_diagnostics->>'provider_http_status','') ~ '^[0-9]+$'
        then ((failure_diagnostics->>'provider_http_status')::int / 100)::text || 'xx'
      else 'unknown'
    end as http_family
  from failure_rows
),
failure_trend as (
  select jsonb_build_object(
    'classes', coalesce((select jsonb_object_agg(label,jsonb_build_object('today',today,'seven_days',seven_days)) from (
      select class as label, count(*) filter (where provider_dispatched_at >= (select today_start from params))::int as today, count(*)::int as seven_days from failure_dimensions group by class
    ) grouped), '{}'::jsonb),
    'stages', coalesce((select jsonb_object_agg(label,jsonb_build_object('today',today,'seven_days',seven_days)) from (
      select stage as label, count(*) filter (where provider_dispatched_at >= (select today_start from params))::int as today, count(*)::int as seven_days from failure_dimensions group by stage
    ) grouped), '{}'::jsonb),
    'response_classifications', coalesce((select jsonb_object_agg(label,jsonb_build_object('today',today,'seven_days',seven_days)) from (
      select response_classification as label, count(*) filter (where provider_dispatched_at >= (select today_start from params))::int as today, count(*)::int as seven_days from failure_dimensions group by response_classification
    ) grouped), '{}'::jsonb),
    'http_families', coalesce((select jsonb_object_agg(label,jsonb_build_object('today',today,'seven_days',seven_days)) from (
      select http_family as label, count(*) filter (where provider_dispatched_at >= (select today_start from params))::int as today, count(*)::int as seven_days from failure_dimensions group by http_family
    ) grouped), '{}'::jsonb),
    'safe_error_codes', coalesce((select jsonb_object_agg(label,jsonb_build_object('today',today,'seven_days',seven_days)) from (
      select error_code as label, count(*) filter (where provider_dispatched_at >= (select today_start from params))::int as today, count(*)::int as seven_days from failure_dimensions group by error_code
    ) grouped), '{}'::jsonb)
  ) as value
)
select
  (select jsonb_agg(to_jsonb(daily) order by date) from daily) as daily,
  (select count(distinct user_id)::int from dispatches) as unique_dispatch_users_7d,
  (select value from failure_trend) as failure_trend,
  'current active stale backlog grouped by latest updated_at UTC date; not historical snapshots'::text as stale_metric_semantics;`;
  assertReadOnlySql(sql);
  return sql;
}

export function buildProvenanceAuditSql(publicBetaGoLiveAt: string, now = new Date()): string {
  const window = resolveUtcWindow("last-7-utc-days", now);
  const goLiveAt = iso(new Date(publicBetaGoLiveAt));
  const sql = `with
params as (
  select ${sqlLiteral(window.start)}::timestamptz as window_start,
         ${sqlLiteral(window.end)}::timestamptz as window_end,
         ${sqlLiteral(goLiveAt)}::timestamptz as public_go_live_at
),
audited as (
  select operation.operation_id,
    operation.provider_dispatched_at,
    operation.state,
    dense_rank() over (order by operation.user_id)::int as owner_bucket,
    (operation.final_track_id is not null) as track_created,
    operation.failure_code,
    (operation.failure_diagnostics is not null) as diagnostics_available,
    coalesce(operation.failure_diagnostics->>'provider_error_class','UNCLASSIFIED') as diagnostic_class,
    coalesce(operation.failure_diagnostics->>'provider_failure_stage','UNCLASSIFIED') as failure_stage,
    coalesce(operation.failure_diagnostics->>'provider_response_classification','UNCLASSIFIED') as response_classification,
    coalesce(operation.failure_diagnostics->>'provider_http_status','UNCLASSIFIED') as http_status,
    coalesce(operation.failure_diagnostics->>'provider_error_code','UNCLASSIFIED') as safe_error_code
  from medclip_private.music_generation_operations operation, params
  where operation.provider_dispatched_at >= least(params.window_start, params.public_go_live_at)
    and operation.provider_dispatched_at < params.window_end
)
select coalesce(jsonb_agg(jsonb_build_object(
  'operation_id',operation_id,
  'provider_dispatched_at',provider_dispatched_at,
  'state',state,
  'owner_bucket',owner_bucket,
  'track_created',track_created,
  'failure_code',failure_code,
  'diagnostics_available',diagnostics_available,
  'diagnostic_class',diagnostic_class,
  'failure_stage',failure_stage,
  'response_classification',response_classification,
  'http_status',http_status,
  'safe_error_code',safe_error_code
) order by provider_dispatched_at), '[]'::jsonb) as audit_rows
from audited;`;
  assertReadOnlySql(sql);
  return sql;
}

export type IncidentAssessment = Readonly<{
  severity: "HEALTHY" | "ATTENTION" | "CRITICAL";
  flags: readonly string[];
  recommendation: string;
}>;

export function assessIncidentSeverity(input: Readonly<{
  release: ReleaseConfiguration;
  trafficEvidence: TrafficEvidence;
  dispatches7d: number;
  failed7d: number;
  unknown7d: number;
  currentUnknown: number;
  oldestUnknownAgeSeconds: number | null;
  staleActiveCount: number;
  oldestProviderInFlightAgeSeconds: number | null;
  oldestFinalizingAgeSeconds: number | null;
  fuseUtilizationPercent: number;
}>): IncidentAssessment {
  const failureRate = percentage(input.failed7d + input.unknown7d, input.dispatches7d);
  const flags: string[] = [];
  let critical = false;
  if (input.release.publicReleaseState !== "ON") flags.push("PUBLIC_RELEASE_OFF_UNEXPECTEDLY");
  if (input.release.testerLiveState === "ON" || input.release.testerMockState === "ON") {
    flags.push("TESTER_MODE_ENABLED_UNEXPECTEDLY");
    critical = true;
  }
  if (input.fuseUtilizationPercent >= FUSE_ATTENTION_PERCENT) flags.push("GLOBAL_FUSE_UTILIZATION_HIGH");
  if (input.fuseUtilizationPercent >= 100) flags.push("GLOBAL_FUSE_EXHAUSTED");
  if (input.currentUnknown > 0) flags.push("UNKNOWN_PRESENT");
  if (
    input.currentUnknown >= MULTIPLE_UNKNOWN_CRITICAL_COUNT
    && (input.oldestUnknownAgeSeconds ?? 0) >= PERSISTENT_UNKNOWN_SECONDS
  ) {
    flags.push("MULTIPLE_PERSISTENT_UNKNOWN");
    critical = true;
  }
  if (input.staleActiveCount > 0) flags.push("STALE_ACTIVE_PRESENT");
  if (
    (input.oldestProviderInFlightAgeSeconds ?? 0) >= SEVERELY_STALE_ACTIVE_SECONDS
    || (input.oldestFinalizingAgeSeconds ?? 0) >= SEVERELY_STALE_ACTIVE_SECONDS
  ) {
    flags.push("SEVERELY_STALE_ACTIVE");
    critical = true;
  }
  if (
    input.dispatches7d >= FAILURE_CLUSTER_MIN_DISPATCHES
    && failureRate >= FAILURE_CLUSTER_PERCENT
  ) flags.push("FAILURE_CLUSTER");
  if (
    input.dispatches7d >= CRITICAL_FAILURE_MIN_DISPATCHES
    && failureRate >= CRITICAL_FAILURE_PERCENT
  ) {
    flags.push("SUSTAINED_FAILURE_PATTERN");
    critical = true;
  }

  const severity = critical ? "CRITICAL" : flags.length ? "ATTENTION" : "HEALTHY";
  let recommendation: string;
  if (severity === "CRITICAL") {
    recommendation = "Keep current quotas unchanged and investigate before broader release changes.";
  } else if (input.currentUnknown > 0) {
    recommendation = "Inspect UNKNOWN diagnostics before allowing affected users to retry.";
  } else if (input.fuseUtilizationPercent >= FUSE_ATTENTION_PERCENT) {
    recommendation = "Review demand and cost before considering any quota increase.";
  } else if (flags.includes("FAILURE_CLUSTER") || flags.includes("STALE_ACTIVE_PRESENT")) {
    recommendation = "Review safe failure and stale-operation diagnostics; do not retry automatically.";
  } else if (flags.includes("PUBLIC_RELEASE_OFF_UNEXPECTEDLY")) {
    recommendation = "Review release configuration; do not change it automatically.";
  } else if (input.trafficEvidence === "NO_REAL_TRAFFIC") {
    recommendation = "No real beta traffic yet; continue observation.";
  } else if (input.trafficEvidence === "LOW_SAMPLE") {
    recommendation = "Real traffic sample is still small; continue observation without inferring stability.";
  } else {
    recommendation = "Continue read-only monitoring under the current quotas.";
  }
  return Object.freeze({ severity, flags: Object.freeze(flags), recommendation });
}

export function buildHealthFlags(input: Readonly<{
  release: ReleaseConfiguration;
  fuseExhausted: boolean;
  currentUnknown: number;
  staleReserved: number;
  staleProviderInFlight: number;
  staleFinalizing: number;
}>): readonly string[] {
  const flags: string[] = [];
  if (input.release.publicReleaseState !== "ON") flags.push("PUBLIC_RELEASE_OFF_UNEXPECTEDLY");
  if (input.release.testerLiveState === "ON" || input.release.testerMockState === "ON") {
    flags.push("TESTER_MODE_ENABLED_UNEXPECTEDLY");
  }
  if (input.fuseExhausted) flags.push("GLOBAL_FUSE_EXHAUSTED");
  if (input.currentUnknown > 0) flags.push("UNKNOWN_PRESENT");
  if (input.staleReserved + input.staleProviderInFlight + input.staleFinalizing > 0) {
    flags.push("STALE_ACTIVE_PRESENT");
  }
  return Object.freeze(flags);
}

export function assertReadOnlySql(sql: string): void {
  const normalized = sql.replace(/--.*$/gm, " ").replace(/\s+/g, " ").trim();
  if (!/^(select|with)\b/i.test(normalized)) throw new Error("MONITOR_SQL_MUST_BE_SELECT_ONLY");
  if (/\b(insert|update|delete|upsert|merge|truncate|alter|drop|create|grant|revoke|call|copy)\b/i.test(normalized)) {
    throw new Error("MONITOR_SQL_MUTATION_FORBIDDEN");
  }
}

export function assertAggregatePrivacy(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(serialized)) {
    throw new Error("REPORT_CONTAINS_USER_OR_OPERATION_ID");
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(serialized)) throw new Error("REPORT_CONTAINS_EMAIL");
  if (/api[_-]?key|authorization|ciphertext|encryption[_-]?key|service[_-]?role|signed[_-]?url|provider[_-]?url|raw[_-]?response|lyrics|prompt/i.test(serialized)) {
    throw new Error("REPORT_CONTAINS_FORBIDDEN_FIELD");
  }
  if (/https?:\/\//i.test(serialized)) throw new Error("REPORT_CONTAINS_URL");
}

function sqlLiteral(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error("INVALID_WINDOW_TIMESTAMP");
  return `'${value}'`;
}

export function buildAggregateHealthSql(
  window: HealthWindow,
  userDailyLimit: number,
  thresholds = DEFAULT_STALE_THRESHOLDS_SECONDS,
): string {
  const userLimit = positiveLimit(userDailyLimit, DEFAULT_MUSIC_USER_DAILY_PROVIDER_LIMIT);
  const reservedThreshold = positiveLimit(thresholds.RESERVED, DEFAULT_STALE_THRESHOLDS_SECONDS.RESERVED);
  const providerThreshold = positiveLimit(thresholds.PROVIDER_IN_FLIGHT, DEFAULT_STALE_THRESHOLDS_SECONDS.PROVIDER_IN_FLIGHT);
  const finalizingThreshold = positiveLimit(thresholds.FINALIZING, DEFAULT_STALE_THRESHOLDS_SECONDS.FINALIZING);
  const sql = `with
params as (
  select ${sqlLiteral(window.start)}::timestamptz as window_start,
         ${sqlLiteral(window.end)}::timestamptz as window_end,
         date_trunc('day', statement_timestamp() at time zone 'UTC') at time zone 'UTC' as utc_day_start
),
window_dispatches as (
  select operation.* from medclip_private.music_generation_operations operation, params
  where operation.provider_dispatched_at >= params.window_start
    and operation.provider_dispatched_at < params.window_end
),
today_dispatches as (
  select operation.* from medclip_private.music_generation_operations operation, params
  where operation.provider_dispatched_at >= params.utc_day_start
    and operation.provider_dispatched_at < params.utc_day_start + interval '1 day'
),
state_counts as (
  select state, count(*)::int as count from window_dispatches group by state
),
active_health as (
  select state, count(*)::int as count,
    floor(extract(epoch from statement_timestamp() - min(updated_at)))::bigint as oldest_age_seconds,
    floor(extract(epoch from statement_timestamp() - max(updated_at)))::bigint as newest_age_seconds
  from medclip_private.music_generation_operations
  where state in ('RESERVED','PROVIDER_IN_FLIGHT','FINALIZING','UNKNOWN')
  group by state
),
failure_rows as (
  select failure_diagnostics from window_dispatches
  where state in ('FAILED','UNKNOWN')
),
user_usage as (
  select user_id, count(*)::int as count from today_dispatches group by user_id
)
select
  (select window_start from params) as window_start,
  (select window_end from params) as window_end,
  (select count(*)::int from window_dispatches) as dispatches,
  (select count(*)::int from today_dispatches) as global_dispatches_today,
  (select count(distinct user_id)::int from today_dispatches) as unique_users_today,
  (select count(*)::int from user_usage where count >= ${userLimit}) as users_at_daily_limit_today,
  (select count(*)::int from window_dispatches where state='COMPLETED') as completed,
  (select count(*)::int from window_dispatches where state='FAILED') as failed,
  (select count(*)::int from window_dispatches where state='UNKNOWN') as unknown,
  (select count(distinct final_track_id)::int from window_dispatches where state='COMPLETED' and final_track_id is not null) as tracks_finalized,
  coalesce((select jsonb_object_agg(state,count) from state_counts), '{}'::jsonb) as status_counts,
  coalesce((select jsonb_object_agg(state,jsonb_build_object('count',count,'oldest_age_seconds',oldest_age_seconds,'newest_age_seconds',newest_age_seconds)) from active_health), '{}'::jsonb) as active_health,
  coalesce((select jsonb_object_agg(label,count) from (
    select coalesce(failure_diagnostics->>'provider_error_class','UNCLASSIFIED') as label, count(*)::int as count from failure_rows group by 1
  ) grouped), '{}'::jsonb) as failure_classes,
  coalesce((select jsonb_object_agg(label,count) from (
    select coalesce(failure_diagnostics->>'provider_failure_stage','UNCLASSIFIED') as label, count(*)::int as count from failure_rows group by 1
  ) grouped), '{}'::jsonb) as failure_stages,
  coalesce((select jsonb_object_agg(label,count) from (
    select coalesce(failure_diagnostics->>'provider_response_classification','UNCLASSIFIED') as label, count(*)::int as count from failure_rows group by 1
  ) grouped), '{}'::jsonb) as response_classifications,
  coalesce((select jsonb_object_agg(label,count) from (
    select coalesce(failure_diagnostics->>'provider_error_code','UNCLASSIFIED') as label, count(*)::int as count from failure_rows group by 1
  ) grouped), '{}'::jsonb) as provider_error_codes,
  coalesce((select jsonb_object_agg(label,count) from (
    select case
      when failure_diagnostics ? 'provider_http_status' and (failure_diagnostics->>'provider_http_status')::int between 200 and 299 then '2xx'
      when failure_diagnostics ? 'provider_http_status' and (failure_diagnostics->>'provider_http_status')::int between 400 and 499 then '4xx'
      when failure_diagnostics ? 'provider_http_status' and (failure_diagnostics->>'provider_http_status')::int between 500 and 599 then '5xx'
      when failure_diagnostics ? 'provider_http_status' then 'other'
      else 'unknown' end as label,
      count(*)::int as count from failure_rows group by 1
  ) grouped), '{}'::jsonb) as http_status_categories,
  (select count(*)::int from medclip_private.music_generation_operations where state='RESERVED') as current_reserved,
  (select count(*)::int from medclip_private.music_generation_operations where state='PROVIDER_IN_FLIGHT') as current_provider_in_flight,
  (select count(*)::int from medclip_private.music_generation_operations where state='FINALIZING') as current_finalizing,
  (select count(*)::int from medclip_private.music_generation_operations where state='UNKNOWN') as current_unknown,
  (select count(*)::int from medclip_private.music_generation_operations where state='RESERVED' and updated_at < statement_timestamp() - make_interval(secs => ${reservedThreshold})) as stale_reserved,
  (select count(*)::int from medclip_private.music_generation_operations where state='PROVIDER_IN_FLIGHT' and updated_at < statement_timestamp() - make_interval(secs => ${providerThreshold})) as stale_provider_in_flight,
  (select count(*)::int from medclip_private.music_generation_operations where state='FINALIZING' and updated_at < statement_timestamp() - make_interval(secs => ${finalizingThreshold})) as stale_finalizing,
  (select floor(extract(epoch from statement_timestamp() - min(updated_at)))::bigint from medclip_private.music_generation_operations where state='UNKNOWN') as oldest_unknown_age_seconds;`;
  assertReadOnlySql(sql);
  return sql;
}

export const READ_ONLY_FINGERPRINT_SQL = `select
  (select jsonb_build_object('count',count(*),'fingerprint',coalesce(md5(string_agg(md5(row_to_json(operation)::text),'' order by operation.id::text)),'EMPTY')) from medclip_private.music_generation_operations operation) as operations,
  (select jsonb_build_object('count',count(*),'fingerprint',coalesce(md5(string_agg(md5(row_to_json(track)::text),'' order by track.id::text)),'EMPTY')) from public.music_tracks track) as tracks,
  (select jsonb_build_object('count',count(*),'fingerprint',coalesce(md5(string_agg(md5(concat_ws('|',object.id::text,object.updated_at::text,object.name)),'' order by object.id::text)),'EMPTY')) from storage.objects object where object.bucket_id in ('music-audio','music-covers')) as assets,
  (select jsonb_build_object(
    'c2c2_operation',coalesce(md5(row_to_json(operation)::text),'MISSING')) from medclip_private.music_generation_operations operation where operation.operation_id='38e41da9-a547-487c-a9fb-68b182383a46' limit 1) as historical_c2c2_operation,
  (select jsonb_build_object('c2c2_track',coalesce(md5(row_to_json(track)::text),'MISSING')) from public.music_tracks track where track.id='24ce4d24-2fca-4d9f-87ca-ed54c064f274'::uuid limit 1) as historical_c2c2_track,
  (select jsonb_build_object('failed_operation',coalesce(md5(row_to_json(operation)::text),'MISSING')) from medclip_private.music_generation_operations operation where operation.operation_id='142feedc-364d-4445-8f7a-df25a6071f7b' limit 1) as historical_failed_operation,
  (select jsonb_build_object('c1d_operation',coalesce(md5(row_to_json(operation)::text),'MISSING')) from medclip_private.music_generation_operations operation where operation.operation_id='c1d_tokenhub_music_v26_url_20261009_live2' limit 1) as historical_c1d_operation,
  (select jsonb_build_object('c1d_track',coalesce(md5(row_to_json(track)::text),'MISSING')) from public.music_tracks track where track.id='cad2cb99-19a6-43bd-88e8-e61c53d2ba26'::uuid limit 1) as historical_c1d_track;`;

assertReadOnlySql(READ_ONLY_FINGERPRINT_SQL);
