import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  assertAggregatePrivacy,
  assertReadOnlySql,
  assessIncidentSeverity,
  buildAggregateHealthSql,
  buildProvenanceAuditSql,
  buildSevenDayTrendSql,
  calculateFuse,
  classifyTrafficEvidence,
  HEALTH_WINDOWS,
  percentage,
  READ_ONLY_FINGERPRINT_SQL,
  resolveReleaseConfiguration,
  resolveUtcWindow,
  statusDistribution,
  summarizeProvenance,
  summarizeSevenDayTrend,
} from "./music-public-beta-health.ts";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const supabaseCli = require.resolve("supabase/dist/supabase.js");

function parseArguments(argv) {
  const result = { window: "current-utc-day", json: false, userDailyLimit: undefined, globalDailyLimit: undefined };
  for (const argument of argv) {
    if (argument === "--json") result.json = true;
    else if (argument.startsWith("--window=")) {
      const value = argument.slice("--window=".length);
      result.window = value === "7d" ? "last-7-utc-days" : value;
    }
    else if (argument.startsWith("--user-limit=")) result.userDailyLimit = Number(argument.slice("--user-limit=".length));
    else if (argument.startsWith("--global-limit=")) result.globalDailyLimit = Number(argument.slice("--global-limit=".length));
    else throw new Error("UNKNOWN_MONITOR_ARGUMENT");
  }
  if (!HEALTH_WINDOWS.includes(result.window)) throw new Error("INVALID_REPORT_WINDOW");
  return result;
}

async function runCli(args, timeout = 180_000) {
  const { stdout } = await execFileAsync(process.execPath, [supabaseCli, ...args], {
    cwd: process.cwd(),
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function runReadOnlySql(sql) {
  assertReadOnlySql(sql);
  const result = await runCli(["db", "query", "--linked", "--output-format", "json", "--", sql]);
  if (!Array.isArray(result.rows) || result.rows.length !== 1) throw new Error("MONITOR_QUERY_RESULT_INVALID");
  return result.rows[0];
}

async function readSecretState() {
  const result = await runCli(["secrets", "list", "--project-ref", "gyfjsuhbhjbfastcfohn"]);
  if (!Array.isArray(result.secrets)) throw new Error("REMOTE_RELEASE_CONFIGURATION_UNAVAILABLE");
  return {
    hashes: Object.fromEntries(result.secrets.map((item) => [item.name, item.value])),
    updatedAt: Object.fromEntries(result.secrets.map((item) => [item.name, item.updated_at ?? null])),
  };
}

function count(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("INVALID_REMOTE_METRIC");
  return parsed;
}

function seconds(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("INVALID_REMOTE_AGE");
  return Math.round(parsed);
}

function countMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, count(item)]));
}

function activeMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("INVALID_ACTIVE_METRIC");
    return [key, {
      count: count(item.count),
      oldestAgeSeconds: seconds(item.oldest_age_seconds),
      newestAgeSeconds: seconds(item.newest_age_seconds),
    }];
  }));
}

function trendMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("INVALID_TREND_METRIC");
    return [key, { today: count(item.today), sevenDays: count(item.seven_days) }];
  }));
}

function dailyRows(value) {
  if (!Array.isArray(value) || value.length !== 7) throw new Error("INVALID_DAILY_TREND");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("INVALID_DAILY_TREND_ROW");
    return {
      date: String(item.date ?? ""),
      dispatches: count(item.dispatches),
      completed: count(item.completed),
      failed: count(item.failed),
      unknown: count(item.unknown),
      uniqueUsers: count(item.unique_users),
      staleActive: count(item.stale_active),
    };
  });
}

function provenanceRows(value) {
  if (!Array.isArray(value)) throw new Error("INVALID_PROVENANCE_ROWS");
  const states = new Set(["RESERVED", "PROVIDER_IN_FLIGHT", "FINALIZING", "COMPLETED", "FAILED", "UNKNOWN"]);
  const safeText = (input, fallback = "UNCLASSIFIED") => {
    if (input === null || input === undefined) return fallback;
    const parsed = String(input);
    if (parsed.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(parsed)) throw new Error("INVALID_PROVENANCE_DIAGNOSTIC");
    return parsed;
  };
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("INVALID_PROVENANCE_ROW");
    const state = String(item.state ?? "");
    if (!states.has(state)) throw new Error("INVALID_PROVENANCE_STATE");
    const operationId = String(item.operation_id ?? "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(operationId)) throw new Error("INVALID_PROVENANCE_OPERATION");
    const providerDispatchedAt = new Date(item.provider_dispatched_at).toISOString();
    return {
      operationId,
      providerDispatchedAt,
      state,
      ownerBucket: count(item.owner_bucket),
      trackCreated: item.track_created === true,
      failureCode: item.failure_code === null ? null : safeText(item.failure_code),
      diagnosticsAvailable: item.diagnostics_available === true,
      diagnosticClass: safeText(item.diagnostic_class),
      failureStage: safeText(item.failure_stage),
      responseClassification: safeText(item.response_classification),
      httpStatus: safeText(item.http_status),
      safeErrorCode: safeText(item.safe_error_code),
    };
  });
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ageLabel(value) {
  if (value === null) return "NONE";
  if (value < 60) return `${value}s`;
  if (value < 3_600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${Math.floor(value / 3_600)}h ${Math.floor((value % 3_600) / 60)}m`;
}

function mapLabel(value) {
  const entries = Object.entries(value);
  return entries.length ? entries.map(([key, countValue]) => `${key}:${countValue}`).join(", ") : "NONE";
}

function trendLabel(value) {
  const entries = Object.entries(value);
  return entries.length
    ? entries.map(([key, counts]) => `${key}:today=${counts.today},7d=${counts.sevenDays}`).join(", ")
    : "NONE";
}

function activeAgeLabel(active, state) {
  const value = active.ages[state];
  if (!value || value.count === 0) return "oldest=NONE newest=NONE";
  return `oldest=${ageLabel(value.oldestAgeSeconds)} newest=${ageLabel(value.newestAgeSeconds)}`;
}

function assertHistoricalArtifactsPresent(fingerprint) {
  for (const name of [
    "historical_c2c2_operation",
    "historical_c2c2_track",
    "historical_failed_operation",
    "historical_c1d_operation",
    "historical_c1d_track",
  ]) {
    const value = fingerprint[name];
    if (!value || typeof value !== "object" || JSON.stringify(value).includes("MISSING")) {
      throw new Error("HISTORICAL_ARTIFACT_MISSING");
    }
  }
}

function renderHuman(report) {
  const status = report.dispatchOutcomes;
  console.log("MEDCLIP MUSIC PUBLIC BETA HEALTH");
  console.log(`UTC WINDOW = ${report.window.name} | ${report.window.start} -> ${report.window.end}`);
  console.log("RELEASE STATE");
  console.log(`PUBLIC_AUTHENTICATED_BETA = ${report.release.publicReleaseState}`);
  console.log(`TESTER_LIVE = ${report.release.testerLiveState}`);
  console.log(`TESTER_MOCK = ${report.release.testerMockState}`);
  console.log(`USER DAILY LIMIT = ${report.release.userDailyLimit}`);
  console.log(`GLOBAL DAILY LIMIT = ${report.release.globalDailyLimit}`);
  console.log(`QUOTA WINDOW = ${report.release.quotaWindow}`);
  console.log(`AUTOMATIC RETRY = ${report.release.automaticRetry}`);
  console.log(`FALLBACK POLICY = ${report.release.fallbackPolicy}`);
  console.log(`TRAFFIC EVIDENCE = ${report.trafficEvidence}`);
  console.log(`CONFIRMED PUBLIC TRAFFIC EVIDENCE = ${report.provenance.publicTrafficEvidence}`);
  console.log(`PUBLIC BETA GO LIVE AT = ${report.provenance.publicBetaGoLiveAt}`);
  console.log(`GO LIVE TIMESTAMP CONFIDENCE = ${report.provenance.goLiveTimestampConfidence}`);
  console.log("GLOBAL COST FUSE");
  console.log(`REAL PROVIDER DISPATCHES TODAY = ${report.currentUtcDay.realProviderDispatches}`);
  console.log(`GLOBAL FUSE = ${report.globalFuse.used}/${report.globalFuse.limit} (${report.globalFuse.utilizationPercent}%) | REMAINING=${report.globalFuse.remaining}`);
  console.log(`UNIQUE USERS WITH DISPATCH = ${report.currentUtcDay.uniqueUsersWithDispatch}`);
  console.log(`USERS AT DAILY LIMIT = ${report.currentUtcDay.usersAtDailyLimit}`);
  console.log("DISPATCH OUTCOMES");
  console.log(`COMPLETED = ${status.COMPLETED.count} (${status.COMPLETED.percentage}%)`);
  console.log(`FAILED = ${status.FAILED.count} (${status.FAILED.percentage}%)`);
  console.log(`UNKNOWN = ${status.UNKNOWN.count} (${status.UNKNOWN.percentage}%)`);
  console.log(`COMPLETION RATE = ${report.completionRate}%`);
  console.log(`TRACKS FINALIZED = ${report.tracksFinalized}`);
  console.log("ACTIVE OPERATIONS");
  console.log(`RESERVED = ${report.active.currentReserved} | STALE=${report.active.staleReserved} | ${activeAgeLabel(report.active, "RESERVED")}`);
  console.log(`PROVIDER_IN_FLIGHT = ${report.active.currentProviderInFlight} | STALE=${report.active.staleProviderInFlight} | ${activeAgeLabel(report.active, "PROVIDER_IN_FLIGHT")}`);
  console.log(`FINALIZING = ${report.active.currentFinalizing} | STALE=${report.active.staleFinalizing} | ${activeAgeLabel(report.active, "FINALIZING")}`);
  console.log("UNKNOWN OPERATIONS");
  console.log(`CURRENT UNKNOWN = ${report.active.currentUnknown}`);
  console.log(`OLDEST UNKNOWN AGE = ${ageLabel(report.active.oldestUnknownAgeSeconds)}`);
  console.log(`NEWEST UNKNOWN AGE = ${ageLabel(report.active.ages.UNKNOWN?.newestAgeSeconds ?? null)}`);
  console.log("FAILURE CLASSIFICATION");
  console.log(`CLASSES = ${mapLabel(report.failures.classes)}`);
  console.log(`STAGES = ${mapLabel(report.failures.stages)}`);
  console.log(`RESPONSE CLASSIFICATIONS = ${mapLabel(report.failures.responseClassifications)}`);
  console.log(`SAFE ERROR CODES = ${mapLabel(report.failures.providerErrorCodes)}`);
  console.log(`HTTP = ${mapLabel(report.failures.httpStatusCategories)}`);
  console.log("SEVEN-DAY TREND");
  console.log(`REAL DISPATCHES 7D = ${report.sevenDaySummary.realDispatches}`);
  console.log(`COMPLETED 7D = ${report.sevenDaySummary.completed}`);
  console.log(`FAILED 7D = ${report.sevenDaySummary.failed}`);
  console.log(`UNKNOWN 7D = ${report.sevenDaySummary.unknown}`);
  console.log(`COMPLETION RATE 7D = ${report.sevenDaySummary.completionRate}%`);
  console.log(`UNIQUE DISPATCH USERS 7D = ${report.sevenDaySummary.uniqueDispatchUsers}`);
  console.log(`PEAK DAILY DISPATCHES 7D = ${report.sevenDaySummary.peakDailyDispatches}`);
  console.log(`PEAK FUSE UTILIZATION 7D = ${report.sevenDaySummary.peakDailyFuseUtilizationPercent}%`);
  console.log(`AVERAGE DAILY FUSE UTILIZATION 7D = ${report.sevenDaySummary.averageDailyFuseUtilizationPercent}%`);
  console.log(`DAYS >=70% FUSE 7D = ${report.sevenDaySummary.daysAtOrAbove70PercentFuse}`);
  console.log(`DAYS FUSE EXHAUSTED 7D = ${report.sevenDaySummary.daysFuseExhausted}`);
  console.log(`DAYS WITH UNKNOWN 7D = ${report.sevenDaySummary.daysWithUnknown}`);
  console.log(`DAYS WITH STALE ACTIVE 7D = ${report.sevenDaySummary.daysWithStaleActive}`);
  if (report.window.name === "last-7-utc-days") {
    for (const day of report.sevenDaySummary.daily) {
      console.log(`${day.date} dispatches=${day.dispatches} completed=${day.completed} failed=${day.failed} unknown=${day.unknown} completion=${day.completionRate}% fuse=${day.fuseUtilizationPercent}% users=${day.uniqueUsers} stale=${day.staleActive}`);
    }
  }
  console.log(`FAILURE CLASS TREND = ${trendLabel(report.failureTrend.classes)}`);
  console.log(`FAILURE STAGE TREND = ${trendLabel(report.failureTrend.stages)}`);
  console.log(`HTTP STATUS TREND = ${trendLabel(report.failureTrend.httpFamilies)}`);
  console.log("TRAFFIC PROVENANCE");
  console.log(`ALL REAL DISPATCHES 7D = ${report.provenance.allRealDispatches7d}`);
  console.log(`CONFIRMED PUBLIC BETA 7D = ${report.provenance.confirmedPublic.dispatches}`);
  console.log(`CONFIRMED INTERNAL ACCEPTANCE 7D = ${report.provenance.confirmedInternal.dispatches}`);
  console.log(`UNKNOWN PROVENANCE 7D = ${report.provenance.unknownProvenance.dispatches}`);
  console.log(`CONFIRMED PUBLIC COMPLETION RATE = ${report.provenance.confirmedPublic.completionRate}%`);
  console.log(`POST-GO-LIVE REAL DISPATCHES = ${report.provenance.postGoLive.dispatches}`);
  console.log(`FUTURE DURABLE PROVENANCE GAP = ${report.provenance.futureDurableProvenanceGap ? "YES" : "NO"}`);
  console.log("PRIVACY / SAFETY");
  console.log("DIRECT USER IDENTIFIERS = NONE");
  console.log("PROVIDER SECRETS OR URLS = NONE");
  console.log("ESTIMATED COST = NOT COMPUTABLE FROM CURRENT INTERNAL DATA");
  console.log(`HEALTH = ${report.health}`);
  console.log(`ATTENTION FLAGS = ${report.attentionFlags.length ? report.attentionFlags.join(", ") : "NONE"}`);
  console.log(`OPERATOR RECOMMENDATION = ${report.operatorRecommendation}`);
  console.log("READ-ONLY INVARIANT = PASS");
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const window = resolveUtcWindow(args.window);
  const secretsBefore = await readSecretState();
  const release = resolveReleaseConfiguration(secretsBefore.hashes, {
    userDailyLimit: args.userDailyLimit,
    globalDailyLimit: args.globalDailyLimit,
  });
  const fingerprintBefore = await runReadOnlySql(READ_ONLY_FINGERPRINT_SQL);
  assertHistoricalArtifactsPresent(fingerprintBefore);
  const row = await runReadOnlySql(buildAggregateHealthSql(window, release.userDailyLimit));
  const trendRow = await runReadOnlySql(buildSevenDayTrendSql());
  const publicReleaseUpdatedAt = secretsBefore.updatedAt.MEDCLIP_MUSIC_PUBLIC_RELEASE_MODE;
  if (typeof publicReleaseUpdatedAt !== "string" || !publicReleaseUpdatedAt) {
    throw new Error("PUBLIC_RELEASE_GO_LIVE_METADATA_UNAVAILABLE");
  }
  const publicBetaGoLiveAt = new Date(publicReleaseUpdatedAt).toISOString();
  const provenanceRow = await runReadOnlySql(buildProvenanceAuditSql(publicBetaGoLiveAt));
  const fingerprintAfter = await runReadOnlySql(READ_ONLY_FINGERPRINT_SQL);
  assertHistoricalArtifactsPresent(fingerprintAfter);
  const secretsAfter = await readSecretState();
  if (!sameJson(fingerprintBefore, fingerprintAfter)) throw new Error("READ_ONLY_DATABASE_FINGERPRINT_CHANGED");
  const relevantSecretNames = [
    "MEDCLIP_MUSIC_PUBLIC_RELEASE_MODE",
    "MEDCLIP_MUSIC_TEST_RELEASE_MODE",
    "MEDCLIP_MUSIC_USER_DAILY_PROVIDER_LIMIT",
    "MEDCLIP_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT",
  ];
  const configBefore = Object.fromEntries(relevantSecretNames.map((name) => [name, {
    hash: secretsBefore.hashes[name] ?? null,
    updatedAt: secretsBefore.updatedAt[name] ?? null,
  }]));
  const configAfter = Object.fromEntries(relevantSecretNames.map((name) => [name, {
    hash: secretsAfter.hashes[name] ?? null,
    updatedAt: secretsAfter.updatedAt[name] ?? null,
  }]));
  if (!sameJson(configBefore, configAfter)) throw new Error("READ_ONLY_RELEASE_CONFIGURATION_CHANGED");

  const dispatches = count(row.dispatches);
  const statuses = statusDistribution(dispatches, countMap(row.status_counts));
  const fuse = calculateFuse(count(row.global_dispatches_today), release.globalDailyLimit);
  const activeHealth = activeMap(row.active_health);
  const active = {
    currentReserved: count(row.current_reserved),
    currentProviderInFlight: count(row.current_provider_in_flight),
    currentFinalizing: count(row.current_finalizing),
    currentUnknown: count(row.current_unknown),
    staleReserved: count(row.stale_reserved),
    staleProviderInFlight: count(row.stale_provider_in_flight),
    staleFinalizing: count(row.stale_finalizing),
    oldestUnknownAgeSeconds: seconds(row.oldest_unknown_age_seconds),
    ages: activeHealth,
  };
  const sevenDaySummary = summarizeSevenDayTrend(
    dailyRows(trendRow.daily),
    release.globalDailyLimit,
    count(trendRow.unique_dispatch_users_7d),
  );
  const trafficEvidence = classifyTrafficEvidence(sevenDaySummary.realDispatches);
  const incident = assessIncidentSeverity({
    release,
    trafficEvidence,
    dispatches7d: sevenDaySummary.realDispatches,
    failed7d: sevenDaySummary.failed,
    unknown7d: sevenDaySummary.unknown,
    currentUnknown: active.currentUnknown,
    oldestUnknownAgeSeconds: active.oldestUnknownAgeSeconds,
    staleActiveCount: active.staleReserved + active.staleProviderInFlight + active.staleFinalizing,
    oldestProviderInFlightAgeSeconds: active.ages.PROVIDER_IN_FLIGHT?.oldestAgeSeconds ?? null,
    oldestFinalizingAgeSeconds: active.ages.FINALIZING?.oldestAgeSeconds ?? null,
    fuseUtilizationPercent: fuse.utilizationPercent,
  });
  const rawFailureTrend = trendRow.failure_trend && typeof trendRow.failure_trend === "object"
    ? trendRow.failure_trend
    : {};
  const failureTrend = {
    classes: trendMap(rawFailureTrend.classes),
    stages: trendMap(rawFailureTrend.stages),
    responseClassifications: trendMap(rawFailureTrend.response_classifications),
    httpFamilies: trendMap(rawFailureTrend.http_families),
    safeErrorCodes: trendMap(rawFailureTrend.safe_error_codes),
  };
  const provenanceSummary = summarizeProvenance(
    provenanceRows(provenanceRow.audit_rows),
    publicBetaGoLiveAt,
    resolveUtcWindow("last-7-utc-days"),
  );
  const failedProvenance = provenanceSummary.classified
    .filter((item) => item.state === "FAILED")
    .map((item) => ({
      provenanceClass: item.provenanceClass,
      provenanceConfidence: item.confidence,
      provenanceEvidence: item.evidence,
      failureCode: item.failureCode ?? "UNCLASSIFIED",
      diagnosticsAvailable: item.diagnosticsAvailable,
      diagnosticClass: item.diagnosticClass,
      failureStage: item.failureStage,
      responseClassification: item.responseClassification,
      httpStatus: item.httpStatus,
      safeErrorCode: item.safeErrorCode,
    }));
  const publicTrafficEvidence = classifyTrafficEvidence(provenanceSummary.confirmedPublic.dispatches);
  const operatorRecommendation = provenanceSummary.confirmedPublic.dispatches === 0
    ? "No confirmed public beta traffic yet; continue observation."
    : incident.recommendation;
  const report = {
    report: "MEDCLIP_MUSIC_PUBLIC_BETA_TREND_HEALTH",
    generatedAt: new Date().toISOString(),
    window,
    release,
    currentUtcDay: {
      realProviderDispatches: count(row.global_dispatches_today),
      uniqueUsersWithDispatch: count(row.unique_users_today),
      usersAtDailyLimit: count(row.users_at_daily_limit_today),
    },
    selectedWindowDispatches: dispatches,
    globalFuse: fuse,
    trafficEvidence,
    dispatchOutcomes: statuses,
    completionRate: percentage(count(row.completed), dispatches),
    tracksFinalized: count(row.tracks_finalized),
    active,
    failures: {
      classes: countMap(row.failure_classes),
      stages: countMap(row.failure_stages),
      responseClassifications: countMap(row.response_classifications),
      providerErrorCodes: countMap(row.provider_error_codes),
      httpStatusCategories: countMap(row.http_status_categories),
    },
    sevenDaySummary,
    failureTrend,
    provenance: {
      publicBetaGoLiveAt,
      goLiveTimestampConfidence: "HIGH_REMOTE_SECRET_METADATA",
      publicTrafficEvidence,
      allRealDispatches7d: provenanceSummary.allSevenDay.dispatches,
      confirmedPublic: provenanceSummary.confirmedPublic,
      confirmedInternal: provenanceSummary.confirmedInternal,
      unknownProvenance: provenanceSummary.unknownProvenance,
      postGoLive: provenanceSummary.postGoLive,
      legacyUnclassifiedFailures: provenanceSummary.legacyUnclassifiedFailures,
      failedOperations: failedProvenance,
      futureDurableProvenanceGap: true,
    },
    staleMetricSemantics: String(trendRow.stale_metric_semantics ?? ""),
    estimatedMonetaryCost: "NOT_COMPUTABLE_FROM_CURRENT_INTERNAL_DATA",
    health: incident.severity,
    attentionFlags: incident.flags,
    operatorRecommendation,
    safety: {
      aggregateOnly: true,
      databaseFingerprintUnchanged: true,
      releaseConfigurationUnchanged: true,
      providerCalls: 0,
      paidGeneration: 0,
      providerMediaDownloads: 0,
    },
  };
  assertAggregatePrivacy(report);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else renderHuman(report);
}

await main();
