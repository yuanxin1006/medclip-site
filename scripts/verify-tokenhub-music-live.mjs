import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import {
  createInternalLiveValidationProof,
  deriveInternalLiveValidationSecret,
  INTERNAL_LIVE_VALIDATION_HEADER,
} from "../supabase/functions/_shared/ai-tasks/internal-live-validation.ts";
import { parseAITaskRequest } from "../supabase/functions/_shared/ai-tasks/request.ts";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const accounts = {
  userA: {
    email: process.env.MEDCLIP_TEST_USER_A_EMAIL,
    password: process.env.MEDCLIP_TEST_USER_A_PASSWORD,
  },
  userB: {
    email: process.env.MEDCLIP_TEST_USER_B_EMAIL,
    password: process.env.MEDCLIP_TEST_USER_B_PASSWORD,
  },
};

const provider = "tencent_tokenhub";
const model = "minimax-music-v2.6";
const operationId = "c1d_tokenhub_music_v26_diag_20261003_v6";
const allowedOrigin = "http://localhost:3000";
const safeTrackFields = "id,user_id,title,artist_name,audio_path,duration_seconds,published";
const request = {
  task: "music.generate",
  provider,
  input: {
    operationId,
    mode: "custom_lyrics",
    title: "MedClip \u9996\u6b21\u751f\u6210\u6d4b\u8bd5",
    prompt: "\u6e29\u6696\u6e05\u65b0\u7684\u4e2d\u6587\u6d41\u884c\u6b4c\u66f2\uff0c\u8f7b\u67d4\u94a2\u7434\u4e0e\u539f\u58f0\u5409\u4ed6\uff0c\u5e74\u8f7b\u81ea\u7136\u7684\u4eba\u58f0\uff0c\u8282\u594f\u8212\u7f13\uff0c\u7ed3\u6784\u7b80\u6d01\uff0c\u4ec5\u7528\u4e8e MedClip API \u9996\u6b21\u751f\u6210\u6d4b\u8bd5\u3002",
    lyrics: "[Verse]\n\u6e05\u6668\u7684\u5149\u843d\u5728\u7a97\u524d\n\u65b0\u7684\u6545\u4e8b\u5199\u4e0b\u7b2c\u4e00\u7bc7\n\u6211\u4eec\u628a\u58f0\u97f3\u7559\u5728\u4eca\u5929\n\u8ba9\u65cb\u5f8b\u6162\u6162\u5411\u524d\n\n[Chorus]\n\u5531\u4e00\u9996\u7b80\u5355\u7684\u6b4c\n\u8bb0\u5f55\u8fd9\u4e00\u523b\n\u8ba9\u6bcf\u4e00\u6bb5\u58f0\u97f3\n\u90fd\u6709\u81ea\u5df1\u7684\u989c\u8272",
  },
};

function requireEnvironment() {
  const required = [
    ["NEXT_PUBLIC_SUPABASE_URL", projectUrl],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", anonKey],
    ["MEDCLIP_TEST_USER_A_EMAIL", accounts.userA.email],
    ["MEDCLIP_TEST_USER_A_PASSWORD", accounts.userA.password],
    ["MEDCLIP_TEST_USER_B_EMAIL", accounts.userB.email],
    ["MEDCLIP_TEST_USER_B_PASSWORD", accounts.userB.password],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`Missing required local variables: ${missing.join(", ")}`);
}

function browserClient() {
  return createClient(projectUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signIn(client, account) {
  const result = await client.auth.signInWithPassword(account);
  if (result.error || !result.data.user || !result.data.session?.access_token) {
    throw new Error("AUTHENTICATION_FAILED");
  }
  return { user: result.data.user, accessToken: result.data.session.access_token };
}

function edgeURL(name) {
  return new URL(`/functions/v1/${name}`, projectUrl).toString();
}

async function invokeEdge(name, accessToken, body, timeoutMs = 30_000, additionalHeaders = {}) {
  const response = await fetch(edgeURL(name), {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      Origin: allowedOrigin,
      "Content-Type": "application/json",
      "x-client-info": "medclip-c1d-tokenhub-music-live",
      ...additionalHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Raw response is never printed.
  }
  return { response, text, data };
}

function assertNoSecretExposure(value, sensitiveValues) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of sensitiveValues.filter(Boolean)) {
    assert.equal(serialized.includes(secret), false, "response exposed a local secret");
  }
  for (const forbidden of [
    "ciphertext", "encryption_key", "authorization", "api_key", "raw_response",
    "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS",
  ]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, "response exposed forbidden material");
  }
}

async function listConnections(accessToken, sensitiveValues) {
  const result = await invokeEdge("ai-credentials", accessToken, { action: "list" });
  assert.equal(result.response.ok, true, "credential list failed");
  assert.equal(result.data?.ok, true, "credential list returned an invalid contract");
  assert.ok(Array.isArray(result.data.connections));
  assertNoSecretExposure(result.text, sensitiveValues);
  return result.data.connections;
}

async function browserOperationDenied(client, userAId) {
  const privateRead = await client
    .schema("medclip_private")
    .from("music_generation_operations")
    .select("id")
    .limit(1);
  assert.ok(privateRead.error, "browser unexpectedly read the private operation ledger");
  const rpc = await client.rpc("medclip_get_music_generation_operation", {
    target_user_id: userAId,
    target_operation_id: operationId,
  });
  assert.ok(rpc.error, "browser unexpectedly invoked the service-role operation RPC");
}

function safeNumber(value, label) {
  assert.equal(typeof value, "number", `${label} is missing`);
  assert.ok(Number.isFinite(value) && value >= 0, `${label} is invalid`);
  return value;
}

const SAFE_DIAGNOSTIC_TEXT = /^[A-Za-z0-9_.:/ -]{1,200}$/;

function safeDiagnosticText(value) {
  return typeof value === "string" && SAFE_DIAGNOSTIC_TEXT.test(value) ? value : "NOT REPORTED";
}

function safeDiagnosticNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 999999 ? value : "NOT REPORTED";
}

function safeDiagnosticLength(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 20_000_000 ? value : "NOT REPORTED";
}

function safeDiagnosticBoolean(value) {
  return typeof value === "boolean" ? (value ? "YES" : "NO") : "NOT REPORTED";
}

function safeNonHexCharacterClasses(value) {
  const keys = ["whitespace", "colon", "slash", "dot", "plus", "equals", "hyphen", "underscore", "other"];
  if (!value || typeof value !== "object") return "NOT REPORTED";
  const counts = keys.map((key) => value[key]);
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 20_000_000)) {
    return "NOT REPORTED";
  }
  return keys.map((key, index) => `${key}:${counts[index]}`).join(",");
}

function printSafeFailureDiagnostics(result) {
  const diagnostic = result?.data?.diagnostic ?? {};
  const representation = diagnostic.audioRepresentation ?? {};
  console.error(`EDGE HTTP STATUS = ${safeDiagnosticNumber(result?.response?.status)}`);
  console.error(`TOKENHUB HTTP STATUS = ${safeDiagnosticNumber(diagnostic.httpStatus)}`);
  console.error(`TOKENHUB ERROR CODE = ${safeDiagnosticText(diagnostic.providerErrorCode)}`);
  console.error(`TOKENHUB ERROR TYPE = ${safeDiagnosticText(diagnostic.providerErrorType)}`);
  console.error(`TOKENHUB ERROR SOURCE = ${safeDiagnosticText(diagnostic.providerErrorSource)}`);
  console.error(`TOKENHUB UPSTREAM CODE = ${safeDiagnosticText(diagnostic.providerUpstreamCode)}`);
  console.error(`TOKENHUB UPSTREAM STATUS = ${safeDiagnosticText(diagnostic.providerUpstreamStatus)}`);
  console.error(`TOKENHUB REQUEST ID = ${safeDiagnosticText(diagnostic.requestId)}`);
  console.error(`TOKENHUB TRACE ID = ${safeDiagnosticText(diagnostic.traceId)}`);
  console.error(`MINIMAX BASE STATUS CODE = ${safeDiagnosticNumber(diagnostic.minimaxBaseStatusCode)}`);
  console.error(`MINIMAX BASE STATUS MESSAGE = ${safeDiagnosticText(diagnostic.minimaxBaseStatusMessage)}`);
  console.error(`SAFE DIAGNOSIS = ${safeDiagnosticText(diagnostic.providerFailureClassification)}`);
  console.error(`MUSIC STAGE = ${safeDiagnosticText(diagnostic.musicStage)}`);
  console.error(`AUDIO TYPE = ${safeDiagnosticText(representation.audioType)}`);
  console.error(`AUDIO CHARACTER LENGTH = ${safeDiagnosticLength(representation.audioCharacterLength)}`);
  console.error(`AUDIO IS EMPTY = ${safeDiagnosticBoolean(representation.isEmpty)}`);
  console.error(`AUDIO IS EVEN LENGTH = ${safeDiagnosticBoolean(representation.isEvenLength)}`);
  console.error(`AUDIO IS PURE HEX = ${safeDiagnosticBoolean(representation.isPureHex)}`);
  console.error(`AUDIO HAS ASCII WHITESPACE = ${safeDiagnosticBoolean(representation.hasAsciiWhitespace)}`);
  console.error(`AUDIO HAS LEADING OR TRAILING WHITESPACE = ${safeDiagnosticBoolean(representation.hasLeadingOrTrailingWhitespace)}`);
  console.error(`AUDIO HAS 0X PREFIX = ${safeDiagnosticBoolean(representation.has0xPrefix)}`);
  console.error(`AUDIO URL-LIKE = ${safeDiagnosticBoolean(representation.urlLike)}`);
  console.error(`AUDIO HTTP URL-LIKE = ${safeDiagnosticBoolean(representation.httpUrlLike)}`);
  console.error(`AUDIO HTTPS URL-LIKE = ${safeDiagnosticBoolean(representation.httpsUrlLike)}`);
  console.error(`AUDIO DATA URI-LIKE = ${safeDiagnosticBoolean(representation.dataUriLike)}`);
  console.error(`AUDIO BASE64-LIKE = ${safeDiagnosticBoolean(representation.base64Like)}`);
  console.error(`AUDIO TRIMMED VALUE WOULD BE HEX = ${safeDiagnosticBoolean(representation.trimmedValueWouldBeHex)}`);
  console.error(`AUDIO WHITESPACE REMOVED VALUE WOULD BE HEX = ${safeDiagnosticBoolean(representation.whitespaceRemovedValueWouldBeHex)}`);
  console.error(`AUDIO 0X PREFIX REMOVED VALUE WOULD BE HEX = ${safeDiagnosticBoolean(representation.zeroXPrefixRemovedValueWouldBeHex)}`);
  console.error(`AUDIO NONHEX CHARACTER CLASSES = ${safeNonHexCharacterClasses(representation.nonHexCharacterClasses)}`);
}

async function main() {
  requireEnvironment();
  const userAClient = browserClient();
  const userBClient = browserClient();
  const anonymousClient = browserClient();
  const sensitiveValues = [
    anonKey,
    accounts.userA.email,
    accounts.userA.password,
    accounts.userB.email,
    accounts.userB.password,
  ];
  let userA = null;
  let userB = null;
  let savedCredentialPreserved = false;
  let actualGenerationCalls = "UNKNOWN";
  let testTrackRemains = false;
  let trackId = null;
  let failedStage = "setup";
  let internalValidationSecret = "";

  try {
    userA = await signIn(userAClient, accounts.userA);
    userB = await signIn(userBClient, accounts.userB);
    const beforeA = await listConnections(userA.accessToken, sensitiveValues);
    const beforeB = await listConnections(userB.accessToken, sensitiveValues);
    assert.equal(beforeA.filter((connection) => connection.provider === provider).length, 1,
      "User A must have exactly one saved TokenHub credential");
    assert.equal(beforeB.some((connection) => connection.provider === provider), false,
      "User B unexpectedly has a TokenHub credential");
    savedCredentialPreserved = true;
    internalValidationSecret = await deriveInternalLiveValidationSecret(accounts.userA.password);
    sensitiveValues.push(internalValidationSecret);
    const internalProof = await createInternalLiveValidationProof({
      secret: internalValidationSecret,
      userId: userA.user.id,
      request: parseAITaskRequest(request),
    });

    failedStage = "paid_generation";
    // This is the only call in this verifier that is permitted to reach the
    // paid generation endpoint. No retry loop exists around it.
    const first = await invokeEdge("ai-tasks", userA.accessToken, request, 150_000, {
      [INTERNAL_LIVE_VALIDATION_HEADER]: internalProof,
    });
    assertNoSecretExposure(first.text, sensitiveValues);
    if (!first.response.ok || first.data?.ok !== true) {
      actualGenerationCalls = first.data?.diagnostic?.providerCallCount === 1
        ? 1
        : first.data?.diagnostic?.providerCallCount === 0
          ? 0
          : "UNKNOWN";
      const safeStatus = typeof first.data?.status === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(first.data.status)
        ? first.data.status
        : "UNKNOWN";
      printSafeFailureDiagnostics(first);
      throw new Error(`SAFE_EDGE_FAILURE_${safeStatus}`);
    }
    actualGenerationCalls = first.data?.metadata?.generationOccurred === true ? 1 : 0;
    assert.equal(actualGenerationCalls, 1, "first controlled operation did not perform exactly one generation");
    const data = first.data?.result?.data;
    const timings = first.data?.metadata?.timings;
    assert.equal(data?.operationId, operationId);
    assert.equal(data?.operationInitialState, "RESERVED");
    assert.equal(data?.operationState, "COMPLETED");
    assert.equal(data?.providerCallCount, 1);
    assert.equal(data?.published, false);
    assert.equal(data?.bucket, "music-audio");
    assert.match(data?.audioPath ?? "", new RegExp(`^${userA.user.id}/[0-9a-f-]{36}/audio\\.mp3$`, "i"));
    assert.match(data?.trackId ?? "", /^[0-9a-f-]{36}$/i);
    trackId = data.trackId;
    safeNumber(data.hexCharacterLength, "hex character length");
    safeNumber(data.decodedMp3Bytes, "decoded MP3 bytes");
    assert.ok(data.decodedMp3Bytes > 0 && data.decodedMp3Bytes <= 8 * 1024 * 1024);
    for (const field of [
      "credentialLookupDecryptMs", "operationReservationMs", "providerGenerationLatencyMs",
      "providerResponseMs", "hexValidationDecodeMs", "mp3ValidationMs", "storageUploadMs",
      "trackFinalizationMs", "totalTaskWallClockMs",
    ]) safeNumber(timings?.[field], field);

    failedStage = "idempotent_replay";
    const replay = await invokeEdge("ai-tasks", userA.accessToken, request, 30_000, {
      [INTERNAL_LIVE_VALIDATION_HEADER]: internalProof,
    });
    assert.equal(replay.response.ok, true, "same-operation replay failed");
    assert.equal(replay.data?.metadata?.generationOccurred, false);
    assert.equal(replay.data?.metadata?.replayed, true);
    assert.equal(replay.data?.result?.data?.providerCallCount, 1);
    assert.equal(replay.data?.result?.data?.trackId, trackId);
    assertNoSecretExposure(replay.text, sensitiveValues);

    failedStage = "operation_conflict";
    const conflictRequest = {
      ...request,
      input: { ...request.input, prompt: `${request.input.prompt}\u4e0d\u540c` },
    };
    const conflictProof = await createInternalLiveValidationProof({
      secret: internalValidationSecret,
      userId: userA.user.id,
      request: parseAITaskRequest(conflictRequest),
    });
    const conflict = await invokeEdge("ai-tasks", userA.accessToken, conflictRequest, 30_000, {
      [INTERNAL_LIVE_VALIDATION_HEADER]: conflictProof,
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.data?.status, "OPERATION_CONFLICT");
    assert.equal(conflict.data?.diagnostic?.providerCallCount, 0);
    assertNoSecretExposure(conflict.text, sensitiveValues);

    failedStage = "track_and_playback";
    const ownTrack = await userAClient.from("music_tracks").select(safeTrackFields).eq("id", trackId).maybeSingle();
    assert.equal(ownTrack.error, null);
    assert.equal(ownTrack.data?.user_id, userA.user.id);
    assert.equal(ownTrack.data?.published, false);
    assert.equal(ownTrack.data?.audio_path, data.audioPath);
    testTrackRemains = true;
    const signed = await userAClient.storage.from("music-audio").createSignedUrl(data.audioPath, 60);
    assert.equal(signed.error, null);
    assert.ok(signed.data?.signedUrl);
    const audioResponse = await fetch(signed.data.signedUrl, { headers: { Range: "bytes=0-9" } });
    assert.equal(audioResponse.ok, true);
    const audioPrefix = new Uint8Array(await audioResponse.arrayBuffer());
    assert.ok(audioPrefix.byteLength >= 4);
    const startsWithID3 = audioPrefix[0] === 0x49 && audioPrefix[1] === 0x44 && audioPrefix[2] === 0x33;
    const startsWithFrame = audioPrefix[0] === 0xff && (audioPrefix[1] & 0xe0) === 0xe0;
    assert.equal(startsWithID3 || startsWithFrame, true, "authorized asset is not an MP3");

    failedStage = "cross_user_isolation";
    const userBTrack = await userBClient.from("music_tracks").select("id").eq("id", trackId);
    assert.equal(userBTrack.error, null);
    assert.deepEqual(userBTrack.data, []);
    const userBSigned = await userBClient.storage.from("music-audio").createSignedUrl(data.audioPath, 60);
    assert.ok(userBSigned.error || !userBSigned.data?.signedUrl);
    const anonymousTrack = await anonymousClient.from("music_tracks").select("id").eq("id", trackId);
    assert.equal(anonymousTrack.error, null);
    assert.deepEqual(anonymousTrack.data, []);
    await browserOperationDenied(userBClient, userA.user.id);
    await browserOperationDenied(anonymousClient, userA.user.id);
    assert.equal((await listConnections(userB.accessToken, sensitiveValues)).some((item) => item.provider === provider), false);
    assert.equal((await listConnections(userA.accessToken, sensitiveValues)).some((item) => item.provider === provider), true);

    console.log("TOKENHUB GENERATION LIVE = PASS");
    console.log("TOKENHUB HTTP STATUS = 200");
    console.log("TOKENHUB SAFE PROVIDER STATUS = COMPLETED");
    console.log(`OPERATION ID = ${operationId}`);
    console.log("OPERATION INITIAL STATE = RESERVED");
    console.log("OPERATION FINAL STATE = COMPLETED");
    console.log("PROVIDER CALL COUNT = 1");
    console.log(`MUSIC GENERATION MODEL = ${model}`);
    console.log("OUTPUT FORMAT = hex");
    console.log(`PROVIDER GENERATION LATENCY MS = ${timings.providerGenerationLatencyMs}`);
    console.log(`PROVIDER RESPONSE MS = ${timings.providerResponseMs}`);
    console.log(`HEX VALIDATION/DECODE MS = ${timings.hexValidationDecodeMs}`);
    console.log(`MP3 VALIDATION MS = ${timings.mp3ValidationMs}`);
    console.log(`STORAGE UPLOAD MS = ${timings.storageUploadMs}`);
    console.log(`TRACK FINALIZATION MS = ${timings.trackFinalizationMs}`);
    console.log(`TOTAL TASK WALL CLOCK MS = ${timings.totalTaskWallClockMs}`);
    console.log(`PROVIDER REPORTED MUSIC DURATION = ${data.providerReportedDurationSeconds ?? "NOT REPORTED"}`);
    console.log(`PROVIDER REPORTED MUSIC SIZE = ${data.providerReportedMusicSize ?? "NOT REPORTED"}`);
    console.log(`HEX CHARACTER LENGTH = ${data.hexCharacterLength}`);
    console.log(`DECODED MP3 BYTES = ${data.decodedMp3Bytes}`);
    console.log(`PROVIDER REPORTED SAMPLE RATE = ${data.providerReportedSampleRate ?? "NOT REPORTED"}`);
    console.log(`PROVIDER REPORTED BITRATE = ${data.providerReportedBitrate ?? "NOT REPORTED"}`);
    console.log(`PROVIDER REPORTED CHANNEL COUNT = ${data.providerReportedChannelCount ?? "NOT REPORTED"}`);
    console.log("SAME OPERATION REPLAY = PASS");
    console.log("SECOND PROVIDER GENERATION CALL = 0");
    console.log("SAME-ID DIFFERENT-PAYLOAD = OPERATION CONFLICT");
    console.log("CROSS-USER ISOLATION = PASS");
    console.log("AUTHORIZED PLAYBACK = PASS");
    console.log(`TEST TRACK ID = ${trackId}`);
  } catch (error) {
    const safeMessage = error instanceof Error && /^[A-Z0-9_ -]{1,100}$/.test(error.message)
      ? error.message
      : "CONTROLLED_VERIFIER_FAILURE";
    console.error("TOKENHUB GENERATION LIVE = FAIL");
    console.error(`FAILED STAGE = ${failedStage}`);
    console.error(`SAFE FAILURE = ${safeMessage}`);
    process.exitCode = 1;
  } finally {
    if (userA?.accessToken) {
      try {
        const remaining = await listConnections(userA.accessToken, sensitiveValues);
        savedCredentialPreserved = remaining.some((item) => item.provider === provider);
      } catch {
        savedCredentialPreserved = false;
      }
    }
    console.log(`ACTUAL MUSIC GENERATION PROVIDER CALLS = ${actualGenerationCalls}`);
    console.log(`FINAL TOKENHUB TEST CREDENTIAL REMAINS = ${savedCredentialPreserved ? "YES" : "UNKNOWN"}`);
    console.log(`SAVED TOKENHUB CREDENTIAL PRESERVED = ${savedCredentialPreserved ? "PASS" : "FAIL"}`);
    console.log(`TEST TRACK REMAINS = ${testTrackRemains ? "YES" : "NO"}`);
    if (!savedCredentialPreserved) process.exitCode = 1;
    internalValidationSecret = "";
    await Promise.allSettled([
      userAClient.auth.signOut({ scope: "local" }),
      userBClient.auth.signOut({ scope: "local" }),
      anonymousClient.auth.signOut({ scope: "local" }),
    ]);
  }
}

await main();
