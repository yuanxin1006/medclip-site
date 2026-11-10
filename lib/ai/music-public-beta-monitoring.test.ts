import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  assessIncidentSeverity,
  assertAggregatePrivacy,
  assertReadOnlySql,
  buildAggregateHealthSql,
  buildProvenanceAuditSql,
  buildSevenDayTrendSql,
  buildHealthFlags,
  calculateFuse,
  classifyDispatchProvenance,
  classifyTrafficEvidence,
  DEFAULT_STALE_THRESHOLDS_SECONDS,
  percentage,
  type ProvenanceAuditRow,
  READ_ONLY_FINGERPRINT_SQL,
  resolveReleaseConfiguration,
  resolveUtcWindow,
  staleCount,
  statusDistribution,
  summarizeProvenance,
  summarizeSevenDayTrend,
} from "../../scripts/music-public-beta-health.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const healthyRelease = () => resolveReleaseConfiguration({
  MEDCLIP_MUSIC_PUBLIC_RELEASE_MODE: hash("PUBLIC_AUTHENTICATED_BETA"),
  MEDCLIP_MUSIC_TEST_RELEASE_MODE: hash("OFF"),
});

const emptyDays = () => Array.from({ length: 7 }, (_, index) => ({
  date: `2026-10-${String(7 + index).padStart(2, "0")}`,
  dispatches: 0,
  completed: 0,
  failed: 0,
  unknown: 0,
  uniqueUsers: 0,
  staleActive: 0,
}));

const incident = (overrides: Partial<Parameters<typeof assessIncidentSeverity>[0]> = {}) => assessIncidentSeverity({
  release: healthyRelease(),
  trafficEvidence: "NO_REAL_TRAFFIC",
  dispatches7d: 0,
  failed7d: 0,
  unknown7d: 0,
  currentUnknown: 0,
  oldestUnknownAgeSeconds: null,
  staleActiveCount: 0,
  oldestProviderInFlightAgeSeconds: null,
  oldestFinalizingAgeSeconds: null,
  fuseUtilizationPercent: 0,
  ...overrides,
});

const provenanceRow = (overrides: Partial<ProvenanceAuditRow> = {}): ProvenanceAuditRow => ({
  operationId: "ordinary_public_operation_0001",
  providerDispatchedAt: "2026-10-13T05:00:00.000Z",
  state: "COMPLETED" as const,
  ownerBucket: 1,
  trackCreated: true,
  failureCode: null,
  diagnosticsAvailable: false,
  diagnosticClass: "UNCLASSIFIED",
  failureStage: "UNCLASSIFIED",
  responseClassification: "UNCLASSIFIED",
  httpStatus: "UNCLASSIFIED",
  safeErrorCode: "UNCLASSIFIED",
  ...overrides,
});

const goLiveAt = "2026-10-13T04:26:21.588Z";
const sevenDayWindow = resolveUtcWindow("last-7-utc-days", new Date("2026-10-13T12:00:00Z"));

test("UTC report windows are deterministic and never use browser local time", () => {
  const now = new Date("2026-10-13T12:34:56.789Z");
  assert.deepEqual(resolveUtcWindow("current-utc-day", now), {
    name: "current-utc-day", start: "2026-10-13T00:00:00.000Z", end: "2026-10-14T00:00:00.000Z",
  });
  assert.deepEqual(resolveUtcWindow("previous-utc-day", now), {
    name: "previous-utc-day", start: "2026-10-12T00:00:00.000Z", end: "2026-10-13T00:00:00.000Z",
  });
  assert.deepEqual(resolveUtcWindow("last-24-hours", now), {
    name: "last-24-hours", start: "2026-10-12T12:34:56.789Z", end: "2026-10-13T12:34:56.789Z",
  });
  assert.deepEqual(resolveUtcWindow("last-7-utc-days", now), {
    name: "last-7-utc-days", start: "2026-10-07T00:00:00.000Z", end: "2026-10-14T00:00:00.000Z",
  });
});

test("traffic evidence distinguishes no traffic, low sample and meaningful sample", () => {
  assert.equal(classifyTrafficEvidence(0), "NO_REAL_TRAFFIC");
  assert.equal(classifyTrafficEvidence(1), "LOW_SAMPLE");
  assert.equal(classifyTrafficEvidence(19), "LOW_SAMPLE");
  assert.equal(classifyTrafficEvidence(20), "MEANINGFUL_SAMPLE");
});

test("known acceptance operations are classified as internal with high confidence", () => {
  const result = classifyDispatchProvenance(provenanceRow({
    operationId: "38e41da9-a547-487c-a9fb-68b182383a46",
    providerDispatchedAt: "2026-10-11T13:58:09.691Z",
  }), goLiveAt);
  assert.deepEqual(result, {
    provenanceClass: "INTERNAL_ACCEPTANCE_CONFIRMED",
    confidence: "HIGH",
    evidence: "KNOWN_ACCEPTANCE_OPERATION_ID",
  });
});

test("confirmed public and tester provenance require a durable dispatch-time mode", () => {
  assert.equal(classifyDispatchProvenance(provenanceRow({
    durableReleaseMode: "PUBLIC_AUTHENTICATED_BETA",
  }), goLiveAt).provenanceClass, "PUBLIC_BETA_CONFIRMED");
  assert.equal(classifyDispatchProvenance(provenanceRow({
    durableReleaseMode: "TESTER_LIVE",
  }), goLiveAt).provenanceClass, "TESTER_LIVE_CONFIRMED");
});

test("post-go-live rows without durable provenance remain unknown", () => {
  const result = classifyDispatchProvenance(provenanceRow(), goLiveAt);
  assert.equal(result.provenanceClass, "UNKNOWN_PROVENANCE");
  assert.equal(result.confidence, "LOW");
});

test("pre-go-live rows are excluded from confirmed public traffic", () => {
  const result = classifyDispatchProvenance(provenanceRow({
    operationId: "pre_public_operation_0001",
    providerDispatchedAt: "2026-10-12T23:00:00.000Z",
  }), goLiveAt);
  assert.equal(result.provenanceClass, "PRE_PUBLIC_HISTORICAL");
});

test("mixed seven-day provenance and post-go-live metrics remain separate", () => {
  const summary = summarizeProvenance([
    provenanceRow({
      operationId: "38e41da9-a547-487c-a9fb-68b182383a46",
      providerDispatchedAt: "2026-10-11T13:58:09.691Z",
    }),
    provenanceRow({ operationId: "public_operation_0000001", ownerBucket: 2, durableReleaseMode: "PUBLIC_AUTHENTICATED_BETA" }),
    provenanceRow({ operationId: "public_operation_0000002", ownerBucket: 2, durableReleaseMode: "PUBLIC_AUTHENTICATED_BETA", state: "FAILED", trackCreated: false }),
    provenanceRow({ operationId: "unknown_operation_00001", ownerBucket: 3, state: "UNKNOWN", trackCreated: false }),
  ], goLiveAt, sevenDayWindow);
  assert.equal(summary.allSevenDay.dispatches, 4);
  assert.deepEqual(summary.confirmedPublic, {
    dispatches: 2, completed: 1, failed: 1, unknown: 0, completionRate: 50, uniqueUsers: 1,
  });
  assert.equal(summary.confirmedInternal.dispatches, 1);
  assert.equal(summary.unknownProvenance.dispatches, 1);
  assert.deepEqual(summary.postGoLive, { dispatches: 3, completed: 1, failed: 1, unknown: 1 });
});

test("legacy failures remain unclassified and zero public traffic stays explicit", () => {
  const summary = summarizeProvenance([
    provenanceRow({
      operationId: "142feedc-364d-4445-8f7a-df25a6071f7b",
      providerDispatchedAt: "2026-10-11T01:58:22.605Z",
      state: "FAILED",
      trackCreated: false,
    }),
  ], goLiveAt, sevenDayWindow);
  assert.equal(summary.legacyUnclassifiedFailures, 1);
  assert.equal(summary.confirmedPublic.dispatches, 0);
  assert.equal(summary.confirmedPublic.completionRate, 0);
});

test("zero traffic remains healthy without claiming real-world stability", () => {
  const result = incident();
  assert.equal(result.severity, "HEALTHY");
  assert.deepEqual(result.flags, []);
  assert.match(result.recommendation, /No real beta traffic/);
});

test("low-sample failure does not trigger a failure cluster", () => {
  const result = incident({
    trafficEvidence: "LOW_SAMPLE", dispatches7d: 1, failed7d: 1,
  });
  assert.equal(result.severity, "HEALTHY");
  assert.doesNotMatch(result.flags.join(","), /FAILURE_CLUSTER/);
});

test("meaningful healthy sample remains healthy and failure cluster needs minimum sample", () => {
  assert.equal(incident({
    trafficEvidence: "MEANINGFUL_SAMPLE", dispatches7d: 20,
  }).severity, "HEALTHY");
  const clustered = incident({
    trafficEvidence: "LOW_SAMPLE", dispatches7d: 5, failed7d: 1,
  });
  assert.equal(clustered.severity, "ATTENTION");
  assert.ok(clustered.flags.includes("FAILURE_CLUSTER"));
});

test("UNKNOWN severity distinguishes one from multiple persistent operations", () => {
  const one = incident({ currentUnknown: 1, oldestUnknownAgeSeconds: 60 });
  assert.equal(one.severity, "ATTENTION");
  assert.ok(one.flags.includes("UNKNOWN_PRESENT"));
  const persistent = incident({ currentUnknown: 2, oldestUnknownAgeSeconds: 901 });
  assert.equal(persistent.severity, "CRITICAL");
  assert.ok(persistent.flags.includes("MULTIPLE_PERSISTENT_UNKNOWN"));
});

test("stale active is attention and severely stale provider work is critical", () => {
  assert.equal(incident({ staleActiveCount: 1 }).severity, "ATTENTION");
  assert.equal(incident({
    staleActiveCount: 1, oldestProviderInFlightAgeSeconds: 3_600,
  }).severity, "CRITICAL");
});

test("unexpected tester mode is critical", () => {
  const release = resolveReleaseConfiguration({
    MEDCLIP_MUSIC_PUBLIC_RELEASE_MODE: hash("PUBLIC_AUTHENTICATED_BETA"),
    MEDCLIP_MUSIC_TEST_RELEASE_MODE: hash("TESTER_MOCK"),
  });
  assert.equal(incident({ release }).severity, "CRITICAL");
});

test("70 and 100 percent fuse are attention unless another severe condition exists", () => {
  assert.equal(incident({ fuseUtilizationPercent: 70 }).severity, "ATTENTION");
  const exhausted = incident({ fuseUtilizationPercent: 100 });
  assert.equal(exhausted.severity, "ATTENTION");
  assert.ok(exhausted.flags.includes("GLOBAL_FUSE_EXHAUSTED"));
});

test("seven-day aggregation orders days and honors configurable fuse limit", () => {
  const days = emptyDays().reverse();
  days[0] = { ...days[0], dispatches: 10, completed: 8, failed: 1, unknown: 1, uniqueUsers: 4, staleActive: 1 };
  days[1] = { ...days[1], dispatches: 7, completed: 7, uniqueUsers: 3 };
  const summary = summarizeSevenDayTrend(days, 10, 6);
  assert.equal(summary.daily[0].date, "2026-10-07");
  assert.equal(summary.daily[6].date, "2026-10-13");
  assert.equal(summary.realDispatches, 17);
  assert.equal(summary.completed, 15);
  assert.equal(summary.failed, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(summary.uniqueDispatchUsers, 6);
  assert.equal(summary.peakDailyFuseUtilizationPercent, 100);
  assert.equal(summary.daysAtOrAbove70PercentFuse, 2);
  assert.equal(summary.daysFuseExhausted, 1);
  assert.equal(summary.daysWithUnknown, 1);
  assert.equal(summary.daysWithStaleActive, 1);
});

test("zero-dispatch metrics and completion rate are safe", () => {
  assert.deepEqual(calculateFuse(0, 10), { used: 0, limit: 10, remaining: 10, utilizationPercent: 0, exhausted: false });
  assert.equal(percentage(0, 0), 0);
  assert.deepEqual(statusDistribution(0, {}), {
    RESERVED: { count: 0, percentage: 0 },
    PROVIDER_IN_FLIGHT: { count: 0, percentage: 0 },
    FINALIZING: { count: 0, percentage: 0 },
    COMPLETED: { count: 0, percentage: 0 },
    FAILED: { count: 0, percentage: 0 },
    UNKNOWN: { count: 0, percentage: 0 },
  });
});

test("global fuse and status aggregation calculate bounded percentages", () => {
  assert.deepEqual(calculateFuse(7, 10), { used: 7, limit: 10, remaining: 3, utilizationPercent: 70, exhausted: false });
  assert.deepEqual(calculateFuse(12, 10), { used: 12, limit: 10, remaining: 0, utilizationPercent: 100, exhausted: true });
  const result = statusDistribution(4, { COMPLETED: 2, FAILED: 1, UNKNOWN: 1 });
  assert.deepEqual(result.COMPLETED, { count: 2, percentage: 50 });
  assert.deepEqual(result.FAILED, { count: 1, percentage: 25 });
  assert.deepEqual(result.UNKNOWN, { count: 1, percentage: 25 });
});

test("active age and stale thresholds are observational only", () => {
  assert.equal(staleCount([599, 600, 601], DEFAULT_STALE_THRESHOLDS_SECONDS.RESERVED), 1);
  assert.equal(staleCount([899, 900, 901], DEFAULT_STALE_THRESHOLDS_SECONDS.PROVIDER_IN_FLIGHT), 1);
  assert.equal(staleCount([599, 600, 601], DEFAULT_STALE_THRESHOLDS_SECONDS.FINALIZING), 1);
});

test("release health flags expose OFF, tester, fuse, UNKNOWN and stale conditions", () => {
  const healthyRelease = resolveReleaseConfiguration({
    MEDCLIP_MUSIC_PUBLIC_RELEASE_MODE: hash("PUBLIC_AUTHENTICATED_BETA"),
    MEDCLIP_MUSIC_TEST_RELEASE_MODE: hash("OFF"),
  });
  assert.deepEqual(buildHealthFlags({
    release: healthyRelease,
    fuseExhausted: false,
    currentUnknown: 0,
    staleReserved: 0,
    staleProviderInFlight: 0,
    staleFinalizing: 0,
  }), []);
  const unsafeRelease = resolveReleaseConfiguration({
    MEDCLIP_MUSIC_PUBLIC_RELEASE_MODE: hash("OFF"),
    MEDCLIP_MUSIC_TEST_RELEASE_MODE: hash("TESTER_LIVE"),
  });
  assert.deepEqual(buildHealthFlags({
    release: unsafeRelease,
    fuseExhausted: true,
    currentUnknown: 1,
    staleReserved: 1,
    staleProviderInFlight: 0,
    staleFinalizing: 0,
  }), [
    "PUBLIC_RELEASE_OFF_UNEXPECTEDLY",
    "TESTER_MODE_ENABLED_UNEXPECTEDLY",
    "GLOBAL_FUSE_EXHAUSTED",
    "UNKNOWN_PRESENT",
    "STALE_ACTIVE_PRESENT",
  ]);
});

test("server-configurable limits require matching operator-known values", () => {
  const secrets = {
    MEDCLIP_MUSIC_PUBLIC_RELEASE_MODE: hash("PUBLIC_AUTHENTICATED_BETA"),
    MEDCLIP_MUSIC_TEST_RELEASE_MODE: hash("OFF"),
    MEDCLIP_MUSIC_USER_DAILY_PROVIDER_LIMIT: hash("3"),
    MEDCLIP_MUSIC_GLOBAL_DAILY_PROVIDER_LIMIT: hash("25"),
  };
  const release = resolveReleaseConfiguration(secrets, { userDailyLimit: 3, globalDailyLimit: 25 });
  assert.equal(release.userDailyLimit, 3);
  assert.equal(release.globalDailyLimit, 25);
  assert.throws(() => resolveReleaseConfiguration(secrets), /REQUIRES_MATCHING_OPERATOR_LIMIT/);
});

test("aggregate SQL covers safe diagnostics and remains SELECT-only", () => {
  const sql = buildAggregateHealthSql(resolveUtcWindow("current-utc-day", new Date("2026-10-13T12:00:00Z")), 1);
  assertReadOnlySql(sql);
  assertReadOnlySql(READ_ONLY_FINGERPRINT_SQL);
  assert.match(sql, /provider_error_class/);
  assert.match(sql, /provider_failure_stage/);
  assert.match(sql, /provider_response_classification/);
  assert.match(sql, /provider_http_status/);
  assert.match(sql, /count\(distinct user_id\)/);
  assert.doesNotMatch(sql, /\b(insert|update|delete|upsert|merge|truncate|alter|drop|create|grant|revoke|call|copy)\b/i);
});

test("seven-day trend SQL is UTC, aggregate-only and SELECT-only", () => {
  const sql = buildSevenDayTrendSql(new Date("2026-10-13T23:59:59Z"));
  assertReadOnlySql(sql);
  assert.match(sql, /generate_series/);
  assert.match(sql, /count\(distinct user_id\)/);
  assert.match(sql, /failure_trend/);
  assert.match(sql, /current active stale backlog/);
  assert.doesNotMatch(sql, /select\s+user_id\s+from/i);
});

test("provenance audit SQL remains read-only and never selects direct user identifiers", () => {
  const sql = buildProvenanceAuditSql(goLiveAt, new Date("2026-10-13T12:00:00Z"));
  assertReadOnlySql(sql);
  assert.match(sql, /owner_bucket/);
  assert.match(sql, /failure_diagnostics/);
  assert.doesNotMatch(sql, /jsonb_build_object\([^]*'user_id'/i);
});

test("read-only invariant rejects mutating SQL", () => {
  assert.throws(() => assertReadOnlySql("update example set value=1"), /SELECT_ONLY/);
  assert.throws(() => assertReadOnlySql("with changed as (delete from example returning *) select * from changed"), /MUTATION_FORBIDDEN/);
});

test("aggregate JSON privacy rejects identifiers, content and secrets", () => {
  assert.doesNotThrow(() => assertAggregatePrivacy({ completed: 2, failureClasses: { RATE_LIMIT: 1 } }));
  assert.throws(() => assertAggregatePrivacy({ user: "550e8400-e29b-41d4-a716-446655440000" }), /USER_OR_OPERATION_ID/);
  assert.throws(() => assertAggregatePrivacy({ email: "person@example.com" }), /EMAIL/);
  assert.throws(() => assertAggregatePrivacy({ lyrics: "private" }), /FORBIDDEN_FIELD/);
  assert.throws(() => assertAggregatePrivacy({ location: "https://provider.example/audio.mp3" }), /URL/);
});

test("operator report source has no Provider request or mutation path", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(
    new URL("../../scripts/report-music-public-beta-health.mjs", import.meta.url),
    "utf8",
  ));
  assert.doesNotMatch(source, /tokenhub\.cloud|\/v1\/models|\/v1\/wand\/minimax-music\/generation/i);
  assert.doesNotMatch(source, /functions\.invoke|fetch\s*\(/i);
  assert.doesNotMatch(source, /\b(insert|update|delete|upsert)\b/i);
  assert.match(source, /assertReadOnlySql/);
  assert.match(source, /databaseFingerprintUnchanged/);
  assert.match(source, /releaseConfigurationUnchanged/);
  assert.match(source, /trafficEvidence/);
  assert.match(source, /sevenDaySummary/);
  assert.match(source, /provenanceSummary/);
  assert.match(source, /publicTrafficEvidence/);
  assert.match(source, /JSON\.stringify\(report/);
});
