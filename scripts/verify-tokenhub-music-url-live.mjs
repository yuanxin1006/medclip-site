import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  createInternalLiveValidationProof,
  deriveInternalLiveValidationSecret,
  INTERNAL_LIVE_VALIDATION_HEADER,
} from "../supabase/functions/_shared/ai-tasks/internal-live-validation.ts";
import { parseAITaskRequest } from "../supabase/functions/_shared/ai-tasks/request.ts";

export const HISTORICAL_TOKENHUB_MUSIC_OPERATION_IDS = new Set([
  "c1d_tokenhub_music_live_20261002_v1",
  "c1d_tokenhub_music_v26_retry_20261002_v1",
  "c1d_tokenhub_music_v26_retry_20261002_v2",
  "c1d_tokenhub_music_v26_retry_20261002_v3",
  "c1d_tokenhub_music_v26_retry_20261003_v4",
  "c1d_tokenhub_music_v26_diag_20261003_v5",
  "c1d_tokenhub_music_v26_diag_20261003_v6",
  "c1d_tokenhub_music_v26_url_20261003_v7",
  "c1d_tokenhub_music_v26_url_20261009_live1",
  "c1d_tokenhub_music_v26_url_20261009_live2",
]);

const provider = "tencent_tokenhub";
const model = "minimax-music-v2.6";
const allowedOrigin = "http://localhost:3000";
const safeTrackFields = "id,user_id,title,artist_name,audio_path,duration_seconds,published";

export function validateFutureLiveOperationId(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("LIVE_OPERATION_ID_REQUIRED");
  const operationId = value.trim();
  if (!/^c1d_tokenhub_music_v26_url_[0-9]{8}_(?:v|live)[0-9]+$/.test(operationId)) {
    throw new Error("LIVE_OPERATION_ID_INVALID");
  }
  if (HISTORICAL_TOKENHUB_MUSIC_OPERATION_IDS.has(operationId)) {
    throw new Error("LIVE_OPERATION_ID_HISTORICAL");
  }
  return operationId;
}

export function buildTokenHubURLLiveRequest(operationIdValue) {
  const operationId = validateFutureLiveOperationId(operationIdValue);
  return parseAITaskRequest({
    task: "music.generate",
    provider,
    input: {
      operationId,
      mode: "custom_lyrics",
      title: "MedClip 完整生成链路测试",
      prompt: "温暖清新的中文流行歌曲，轻柔钢琴与原声吉他，年轻自然的人声，节奏舒缓，结构简洁，仅用于 MedClip 完整音乐生成链路验证。",
      lyrics: "[Verse]\n清晨的光落在窗前\n新的故事写下第一篇\n我们把声音留在今天\n让旋律慢慢向前\n\n[Chorus]\n唱一首简单的歌\n记录这一刻\n让每一段声音\n都有自己的颜色",
    },
  });
}

function safeNumber(value, label) {
  assert.equal(typeof value, "number", `${label} is missing`);
  assert.ok(Number.isFinite(value) && value >= 0, `${label} is invalid`);
  return value;
}

export function assertTrustedURLDiagnostics(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "trusted diagnostics missing");
  assert.equal(value.provider_http_status, 200);
  assert.equal(value.success_core_validated, true);
  assert.equal(value.output_format, "url");
  assert.equal(value.url_scheme, "https:");
  assert.match(value.normalized_download_hostname, /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
  assert.equal(value.explicit_port_present, false);
  assert.equal(value.url_credentials_present, false);
  assert.equal(value.url_fragment_present, false);
  assert.equal(value.dns_preflight_result, "PUBLIC_ONLY");
  assert.ok(Number.isSafeInteger(value.dns_resolved_address_count) && value.dns_resolved_address_count > 0);
  assert.equal(value.dns_private_address_detected, false);
  assert.equal(value.dns_rebinding_toctou_present, true);
  assert.equal(typeof value.download_host_allowlist_used, "boolean");
  assert.equal(value.download_http_status, 200);
  assert.ok(value.download_content_type === null || /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value.download_content_type));
  assert.ok(value.download_content_length_header === null || Number.isSafeInteger(value.download_content_length_header));
  assert.ok(Number.isSafeInteger(value.downloaded_bytes) && value.downloaded_bytes > 0 && value.downloaded_bytes <= 8 * 1024 * 1024);
  assert.equal(value.download_redirect_count, 0);
  for (const field of [
    "provider_generation_ms", "url_policy_validation_ms", "dns_preflight_ms",
    "download_first_response_ms", "download_total_ms", "mp3_validation_ms",
    "storage_upload_ms", "track_finalization_ms", "total_task_wall_clock_ms",
  ]) safeNumber(value[field], field);
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /https?:\/\//i);
  assert.doesNotMatch(serialized, /[/?#](?:audio|download|signature|token|key)=?/i);
  return value;
}

function requireEnvironment() {
  const names = [
    "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "MEDCLIP_TEST_USER_A_EMAIL", "MEDCLIP_TEST_USER_A_PASSWORD",
    "MEDCLIP_TEST_USER_B_EMAIL", "MEDCLIP_TEST_USER_B_PASSWORD",
    "MEDCLIP_TOKENHUB_URL_LIVE_OPERATION_ID",
  ];
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`MISSING_REQUIRED_LOCAL_VARIABLES_${missing.join("_")}`);
  return {
    projectUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    operationId: validateFutureLiveOperationId(process.env.MEDCLIP_TOKENHUB_URL_LIVE_OPERATION_ID),
    userA: { email: process.env.MEDCLIP_TEST_USER_A_EMAIL, password: process.env.MEDCLIP_TEST_USER_A_PASSWORD },
    userB: { email: process.env.MEDCLIP_TEST_USER_B_EMAIL, password: process.env.MEDCLIP_TEST_USER_B_PASSWORD },
  };
}

function browserClient(projectUrl, anonKey) {
  return createClient(projectUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signIn(client, account) {
  const result = await client.auth.signInWithPassword(account);
  if (result.error || !result.data.user || !result.data.session?.access_token) throw new Error("AUTHENTICATION_FAILED");
  return { user: result.data.user, accessToken: result.data.session.access_token };
}

async function invokeEdge(projectUrl, anonKey, accessToken, body, timeoutMs, additionalHeaders = {}) {
  const response = await fetch(new URL("/functions/v1/ai-tasks", projectUrl), {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      Origin: allowedOrigin,
      "Content-Type": "application/json",
      "x-client-info": "medclip-c1d-tokenhub-music-url-live",
      ...additionalHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* Raw response is never printed. */ }
  return { response, text, data };
}

function assertNoSecretOrURLExposure(value, sensitiveValues) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of sensitiveValues.filter(Boolean)) assert.equal(serialized.includes(secret), false);
  assert.doesNotMatch(serialized, /ciphertext|encryption_key|authorization|api_key|raw_response|signedUrl/i);
  const visit = (nested) => {
    if (typeof nested === "string") assert.equal(/^https?:\/\//i.test(nested), false, "full URL exposed");
    else if (Array.isArray(nested)) nested.forEach(visit);
    else if (nested && typeof nested === "object") Object.values(nested).forEach(visit);
  };
  visit(value);
}

async function listConnections(projectUrl, anonKey, accessToken, sensitiveValues) {
  const response = await fetch(new URL("/functions/v1/ai-credentials", projectUrl), {
    method: "POST",
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, Origin: allowedOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "list" }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  assert.equal(response.ok, true);
  assert.equal(data?.ok, true);
  assertNoSecretOrURLExposure(data, sensitiveValues);
  return data.connections;
}

export async function runTokenHubURLLiveVerifier() {
  const env = requireEnvironment();
  const request = buildTokenHubURLLiveRequest(env.operationId);
  const userAClient = browserClient(env.projectUrl, env.anonKey);
  const userBClient = browserClient(env.projectUrl, env.anonKey);
  const sensitiveValues = [env.anonKey, env.userA.email, env.userA.password, env.userB.email, env.userB.password];
  let userA;
  let userB;
  let providerCalls = "UNKNOWN";
  let trackId = null;
  try {
    userA = await signIn(userAClient, env.userA);
    userB = await signIn(userBClient, env.userB);
    const beforeA = await listConnections(env.projectUrl, env.anonKey, userA.accessToken, sensitiveValues);
    const beforeB = await listConnections(env.projectUrl, env.anonKey, userB.accessToken, sensitiveValues);
    assert.equal(beforeA.filter((item) => item.provider === provider).length, 1);
    assert.equal(beforeB.some((item) => item.provider === provider), false);
    const internalSecret = await deriveInternalLiveValidationSecret(env.userA.password);
    sensitiveValues.push(internalSecret);
    const proof = await createInternalLiveValidationProof({ secret: internalSecret, userId: userA.user.id, request });

    // Exactly one invocation may create a new operation and reach TokenHub.
    const first = await invokeEdge(env.projectUrl, env.anonKey, userA.accessToken, request, 150_000, {
      [INTERNAL_LIVE_VALIDATION_HEADER]: proof,
    });
    assertNoSecretOrURLExposure(first.data, sensitiveValues);
    providerCalls = first.data?.diagnostic?.providerCallCount ?? (first.data?.metadata?.generationOccurred === true ? 1 : 0);
    assert.equal(first.response.ok, true, "CONTROLLED_URL_GENERATION_FAILED");
    assert.equal(first.data?.ok, true);
    assert.equal(first.data?.metadata?.generationOccurred, true, "OPERATION_ALREADY_EXISTS_OR_NOT_GENERATED");
    const result = first.data.result.data;
    assert.equal(result.operationId, env.operationId);
    assert.equal(result.operationInitialState, "RESERVED");
    assert.equal(result.operationState, "COMPLETED");
    assert.equal(result.providerCallCount, 1);
    assert.equal(result.published, false);
    trackId = result.trackId;
    const diagnostics = assertTrustedURLDiagnostics(first.data.metadata.trustedInternalDiagnostics);

    const replay = await invokeEdge(env.projectUrl, env.anonKey, userA.accessToken, request, 30_000, {
      [INTERNAL_LIVE_VALIDATION_HEADER]: proof,
    });
    assert.equal(replay.response.ok, true);
    assert.equal(replay.data?.metadata?.generationOccurred, false);
    assert.equal(replay.data?.metadata?.replayed, true);
    assert.equal(replay.data?.result?.data?.providerCallCount, 1);

    const conflictRequest = parseAITaskRequest({ ...request, input: { ...request.input, prompt: `${request.input.prompt}不同` } });
    const conflictProof = await createInternalLiveValidationProof({ secret: internalSecret, userId: userA.user.id, request: conflictRequest });
    const conflict = await invokeEdge(env.projectUrl, env.anonKey, userA.accessToken, conflictRequest, 30_000, {
      [INTERNAL_LIVE_VALIDATION_HEADER]: conflictProof,
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.data?.status, "OPERATION_CONFLICT");
    assert.equal(conflict.data?.diagnostic?.providerCallCount, 0);

    const ownTrack = await userAClient.from("music_tracks").select(safeTrackFields).eq("id", trackId).maybeSingle();
    assert.equal(ownTrack.error, null);
    assert.equal(ownTrack.data?.user_id, userA.user.id);
    assert.equal(ownTrack.data?.published, false);
    const otherTrack = await userBClient.from("music_tracks").select("id").eq("id", trackId);
    assert.equal(otherTrack.error, null);
    assert.deepEqual(otherTrack.data, []);
    const otherAudio = await userBClient.storage.from("music-audio").createSignedUrl(result.audioPath, 60);
    assert.ok(otherAudio.error || !otherAudio.data?.signedUrl);
    const ownAudio = await userAClient.storage.from("music-audio").createSignedUrl(result.audioPath, 60);
    assert.equal(ownAudio.error, null);
    const playback = await fetch(ownAudio.data.signedUrl, { headers: { Range: "bytes=0-9" } });
    assert.equal(playback.ok, true);

    console.log("TOKENHUB URL GENERATION LIVE = PASS");
    console.log(`OPERATION ID = ${env.operationId}`);
    console.log(`NORMALIZED DOWNLOAD HOSTNAME = ${diagnostics.normalized_download_hostname}`);
    console.log(`PROVIDER GENERATION MS = ${diagnostics.provider_generation_ms}`);
    console.log(`URL POLICY VALIDATION MS = ${diagnostics.url_policy_validation_ms}`);
    console.log(`DNS PREFLIGHT MS = ${diagnostics.dns_preflight_ms}`);
    console.log(`DOWNLOAD FIRST RESPONSE MS = ${diagnostics.download_first_response_ms}`);
    console.log(`DOWNLOAD TOTAL MS = ${diagnostics.download_total_ms}`);
    console.log(`MP3 VALIDATION MS = ${diagnostics.mp3_validation_ms}`);
    console.log(`STORAGE UPLOAD MS = ${diagnostics.storage_upload_ms}`);
    console.log(`TRACK FINALIZATION MS = ${diagnostics.track_finalization_ms}`);
    console.log(`TOTAL TASK WALL CLOCK MS = ${diagnostics.total_task_wall_clock_ms}`);
    console.log(`TEST TRACK ID = ${trackId}`);
    return { providerCalls, trackId, diagnostics };
  } finally {
    console.log(`ACTUAL MUSIC GENERATION PROVIDER CALLS = ${providerCalls}`);
    console.log(`TEST TRACK REMAINS = ${trackId ? "YES" : "NO"}`);
    await Promise.allSettled([
      userAClient.auth.signOut({ scope: "local" }),
      userBClient.auth.signOut({ scope: "local" }),
    ]);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runTokenHubURLLiveVerifier();
}
