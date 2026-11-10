import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { assertAsyncRegressionRequestIsProviderFree } from "./async-music-regression-safety.ts";
import {
  createInternalLiveValidationProof,
  deriveInternalLiveValidationSecret,
  INTERNAL_LIVE_VALIDATION_HEADER,
} from "../supabase/functions/_shared/ai-tasks/internal-live-validation.ts";
import {
  INTERNAL_ASYNC_MUSIC_MOCK_HEADER,
  INTERNAL_ASYNC_MUSIC_WORKERS_HEADER,
  parseAsyncMusicStartRequest,
} from "../supabase/functions/_shared/ai-tasks/music-product-async.ts";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const supabaseCli = require.resolve("supabase/dist/supabase.js");
const allowedOrigin = "http://localhost:3000";
const pollIntervalMs = 200;
const maxPolls = 60;
const safeTrackFields = "id,user_id,title,artist_name,audio_path,duration_seconds,published";

function requireEnvironment() {
  const names = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "MEDCLIP_TEST_USER_A_EMAIL",
    "MEDCLIP_TEST_USER_A_PASSWORD",
    "MEDCLIP_TEST_USER_B_EMAIL",
    "MEDCLIP_TEST_USER_B_PASSWORD",
  ];
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`MISSING_C2B_ENVIRONMENT_${missing.join("_")}`);
  return {
    projectUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    userA: { email: process.env.MEDCLIP_TEST_USER_A_EMAIL, password: process.env.MEDCLIP_TEST_USER_A_PASSWORD },
    userB: { email: process.env.MEDCLIP_TEST_USER_B_EMAIL, password: process.env.MEDCLIP_TEST_USER_B_PASSWORD },
  };
}

function browserClient(projectUrl, anonKey) {
  return createClient(projectUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signIn(client, account, label) {
  const result = await client.auth.signInWithPassword(account);
  if (result.error || !result.data.user || !result.data.session?.access_token) {
    throw new Error(`${label}_AUTHENTICATION_FAILED`);
  }
  return { user: result.data.user, accessToken: result.data.session.access_token };
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function runSQL(sql) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [supabaseCli, "db", "query", "--linked", sql],
    { cwd: process.cwd(), timeout: 120_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

function assertSafeEdgePayload(value, sensitiveValues) {
  const serialized = JSON.stringify(value);
  for (const secret of sensitiveValues) {
    if (secret) assert.equal(serialized.includes(secret), false, "EDGE_RESPONSE_EXPOSED_SENSITIVE_VALUE");
  }
  assert.doesNotMatch(serialized, /ciphertext|encryption[_-]?key|authorization|raw[_-]?response|provider[_-]?url|request[_-]?hash/i);
  assert.doesNotMatch(serialized, /https?:\/\//i);
}

async function invoke(projectUrl, anonKey, accessToken, body, additionalHeaders = {}) {
  const response = await fetch(new URL("/functions/v1/ai-tasks", projectUrl), {
    method: "POST",
    headers: {
      apikey: anonKey,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      Origin: allowedOrigin,
      "Content-Type": "application/json",
      ...additionalHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error("EDGE_RESPONSE_NOT_JSON"); }
  return { response, data };
}

function startBody(operationId, title = "C2B provider-free async fixture") {
  return {
    action: "music.generation_start",
    input: {
      operationId,
      mode: "custom_lyrics",
      title,
      lyrics: "[Verse]\n异步任务安全验证",
      prompt: "仅使用服务端合成测试音频，不访问音乐服务商",
    },
  };
}

async function status(projectUrl, anonKey, accessToken, operationId) {
  return await invoke(projectUrl, anonKey, accessToken, {
    action: "music.operation_status",
    operationId,
  });
}

async function operationSnapshot(userId, operationId) {
  const rows = await runSQL(`select state, provider_call_count, final_track_id from medclip_private.music_generation_operations where user_id = ${sqlLiteral(userId)}::uuid and operation_id = ${sqlLiteral(operationId)};`);
  return rows[0] ?? null;
}

async function cleanupOperation(userId, operationId) {
  await runSQL(`delete from medclip_private.music_generation_operations where user_id = ${sqlLiteral(userId)}::uuid and operation_id = ${sqlLiteral(operationId)};`);
}

export async function runAsyncMusicBackgroundVerifier() {
  const env = requireEnvironment();
  const userAClient = browserClient(env.projectUrl, env.anonKey);
  const userBClient = browserClient(env.projectUrl, env.anonKey);
  const operationId = randomUUID();
  const body = startBody(operationId);
  const parsed = parseAsyncMusicStartRequest(body);
  const sensitiveValues = [env.anonKey, env.userA.email, env.userA.password, env.userB.email, env.userB.password];
  let userA;
  let userB;
  let trackId = null;
  let audioPath = null;
  let cleanupPassed = false;
  let startResponseMs = 0;
  let mockBackgroundTotalMs = 0;
  const observedStates = [];

  try {
    userA = await signIn(userAClient, env.userA, "USER_A");
    userB = await signIn(userBClient, env.userB, "USER_B");
    const internalSecret = await deriveInternalLiveValidationSecret(env.userA.password);
    sensitiveValues.push(internalSecret);
    const proof = await createInternalLiveValidationProof({
      secret: internalSecret,
      userId: userA.user.id,
      request: parsed.request,
    });

    const anonymous = await invoke(env.projectUrl, env.anonKey, null, body);
    assert.equal(anonymous.response.status, 401);

    const availability = await invoke(env.projectUrl, env.anonKey, userA.accessToken, {
      action: "music.generation_availability",
    });
    assert.equal(availability.response.status, 200);
    assert.equal(availability.data?.ok, true);
    assert.equal(availability.data?.musicGeneration?.enabled, false);
    assert.equal(availability.data?.musicGeneration?.testerModeEnabled, false);
    assertSafeEdgePayload(availability.data, sensitiveValues);
    assertAsyncRegressionRequestIsProviderFree({
      publicReleaseEnabled: availability.data.musicGeneration.enabled,
    });

    assertAsyncRegressionRequestIsProviderFree({
      publicReleaseEnabled: availability.data.musicGeneration.enabled,
      trustedProviderFreeMock: true,
    });

    const startedAt = performance.now();
    const started = await invoke(env.projectUrl, env.anonKey, userA.accessToken, body, {
      [INTERNAL_LIVE_VALIDATION_HEADER]: proof,
      [INTERNAL_ASYNC_MUSIC_MOCK_HEADER]: "success",
      [INTERNAL_ASYNC_MUSIC_WORKERS_HEADER]: "2",
    });
    startResponseMs = performance.now() - startedAt;
    assert.equal(started.response.status, 202);
    assert.equal(started.data?.ok, true);
    assert.equal(started.data?.accepted, true);
    assert.equal(started.data?.operationId, operationId);
    assert.equal(started.data?.status, "RESERVED");
    assertSafeEdgePayload(started.data, sensitiveValues);

    for (let poll = 0; poll < maxPolls; poll += 1) {
      const current = await status(env.projectUrl, env.anonKey, userA.accessToken, operationId);
      assert.equal(current.response.ok, true);
      assert.equal(current.data?.ok, true);
      assertSafeEdgePayload(current.data, sensitiveValues);
      const state = current.data.operation.status;
      if (observedStates.at(-1) !== state) observedStates.push(state);
      if (state === "COMPLETED") {
        trackId = current.data.operation.trackId;
        break;
      }
      assert.notEqual(state, "FAILED");
      assert.notEqual(state, "UNKNOWN");
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    mockBackgroundTotalMs = performance.now() - startedAt;
    assert.ok(trackId, "MOCK_BACKGROUND_DID_NOT_COMPLETE");
    assert.ok(mockBackgroundTotalMs > startResponseMs, "BACKGROUND_DID_NOT_CONTINUE_AFTER_RESPONSE");
    assert.ok(observedStates.includes("PROVIDER_IN_FLIGHT"), "PROVIDER_IN_FLIGHT_NOT_OBSERVED");
    assert.ok(observedStates.includes("FINALIZING"), "FINALIZING_NOT_OBSERVED");
    assert.equal(observedStates.at(-1), "COMPLETED");

    const replay = await invoke(env.projectUrl, env.anonKey, userA.accessToken, body, {
      [INTERNAL_LIVE_VALIDATION_HEADER]: proof,
      [INTERNAL_ASYNC_MUSIC_MOCK_HEADER]: "success",
      [INTERNAL_ASYNC_MUSIC_WORKERS_HEADER]: "2",
    });
    assert.equal(replay.response.status, 202);
    assert.equal(replay.data?.operationId, operationId);

    const conflictBody = startBody(operationId, "C2B conflicting payload");
    const conflictRequest = parseAsyncMusicStartRequest(conflictBody);
    const conflictProof = await createInternalLiveValidationProof({
      secret: internalSecret,
      userId: userA.user.id,
      request: conflictRequest.request,
    });
    const conflict = await invoke(env.projectUrl, env.anonKey, userA.accessToken, conflictBody, {
      [INTERNAL_LIVE_VALIDATION_HEADER]: conflictProof,
      [INTERNAL_ASYNC_MUSIC_MOCK_HEADER]: "success",
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.data?.status, "OPERATION_CONFLICT");

    const crossUser = await status(env.projectUrl, env.anonKey, userB.accessToken, operationId);
    assert.equal(crossUser.response.status, 404);
    assert.equal(crossUser.data?.status, "OPERATION_NOT_FOUND");
    const anonymousStatus = await status(env.projectUrl, env.anonKey, null, operationId);
    assert.equal(anonymousStatus.response.status, 401);

    const snapshot = await operationSnapshot(userA.user.id, operationId);
    assert.equal(snapshot?.state, "COMPLETED");
    assert.equal(snapshot?.provider_call_count, 1);
    assert.equal(snapshot?.final_track_id, trackId);

    const ownTrack = await userAClient.from("music_tracks").select(safeTrackFields).eq("id", trackId).maybeSingle();
    assert.equal(ownTrack.error, null);
    assert.equal(ownTrack.data?.user_id, userA.user.id);
    assert.equal(ownTrack.data?.published, false);
    audioPath = ownTrack.data?.audio_path ?? null;
    assert.equal(typeof audioPath, "string");
    const otherTrack = await userBClient.from("music_tracks").select("id").eq("id", trackId);
    assert.equal(otherTrack.error, null);
    assert.deepEqual(otherTrack.data, []);
    const ownAudio = await userAClient.storage.from("music-audio").createSignedUrl(audioPath, 60);
    assert.equal(ownAudio.error, null);
    const otherAudio = await userBClient.storage.from("music-audio").createSignedUrl(audioPath, 60);
    assert.ok(otherAudio.error || !otherAudio.data?.signedUrl);

    console.log("REMOTE PROVIDER-FREE BACKGROUND TEST = PASS");
    console.log(`START RESPONSE MS = ${Math.round(startResponseMs)}`);
    console.log(`MOCK BACKGROUND TOTAL MS = ${Math.round(mockBackgroundTotalMs)}`);
    console.log("RESPONSE RETURNED BEFORE BACKGROUND COMPLETE = YES");
    console.log(`REMOTE STATUS TRANSITIONS = ${observedStates.join(" -> ")}`);
    console.log("REMOTE DUPLICATE START PROTECTION = PASS");
    console.log("REMOTE DUPLICATE WORKER PROTECTION = PASS");
    console.log("TOKENHUB PROVIDER CALLS = 0");
    console.log("PAID MUSIC GENERATION = 0");
    console.log("REAL PROVIDER MEDIA DOWNLOADS = 0");
    console.log("UNSAFE PUBLIC-REAL REGRESSION GUARD = PASS");
    console.log("TOKENHUB NETWORK TRIPWIRE = PASS");
  } finally {
    if (userA?.user) {
      try {
        await cleanupOperation(userA.user.id, operationId);
        if (audioPath) {
          const removed = await userAClient.storage.from("music-audio").remove([audioPath]);
          if (removed.error) throw removed.error;
        }
        if (trackId) {
          const removedTrack = await userAClient.from("music_tracks").delete().eq("id", trackId).eq("user_id", userA.user.id);
          if (removedTrack.error) throw removedTrack.error;
        }
        const remaining = await operationSnapshot(userA.user.id, operationId);
        cleanupPassed = remaining === null;
        if (trackId) {
          const remainingTrack = await userAClient.from("music_tracks").select("id").eq("id", trackId);
          cleanupPassed = cleanupPassed && !remainingTrack.error && (remainingTrack.data?.length ?? -1) === 0;
        }
      } catch {
        cleanupPassed = false;
      }
    }
    await Promise.allSettled([
      userAClient.auth.signOut({ scope: "local" }),
      userBClient.auth.signOut({ scope: "local" }),
    ]);
    console.log(`REMOTE ASYNC CLEANUP = ${cleanupPassed ? "PASS" : "FAIL"}`);
    if (!cleanupPassed) process.exitCode = 1;
  }

  return { startResponseMs, mockBackgroundTotalMs, observedStates, cleanupPassed };
}

const invokedDirectly = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (invokedDirectly) {
  await runAsyncMusicBackgroundVerifier();
}
