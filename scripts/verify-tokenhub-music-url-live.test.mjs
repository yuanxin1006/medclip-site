import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertTrustedURLDiagnostics,
  buildTokenHubURLLiveRequest,
  HISTORICAL_TOKENHUB_MUSIC_OPERATION_IDS,
  validateFutureLiveOperationId,
} from "./verify-tokenhub-music-url-live.mjs";

const verifierSource = readFileSync(new URL("./verify-tokenhub-music-url-live.mjs", import.meta.url), "utf8");
const packageSource = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const TEST_OPERATION_ID = "c1d_tokenhub_music_v26_url_20990101_live999";

function diagnostics() {
  return {
    provider_http_status: 200,
    success_core_validated: true,
    output_format: "url",
    url_scheme: "https:",
    normalized_download_hostname: "aigc-output-audio-file-1326893053.cos.ap-guangzhou.myqcloud.com",
    explicit_port_present: false,
    url_credentials_present: false,
    url_fragment_present: false,
    dns_preflight_result: "PUBLIC_ONLY",
    dns_resolved_address_count: 2,
    dns_private_address_detected: false,
    dns_rebinding_toctou_present: true,
    download_host_allowlist_used: true,
    download_http_status: 200,
    download_content_type: "audio/mpeg",
    download_content_length_header: 1024,
    downloaded_bytes: 1024,
    download_redirect_count: 0,
    provider_generation_ms: 100,
    url_policy_validation_ms: 1,
    dns_preflight_ms: 2,
    download_first_response_ms: 3,
    download_total_ms: 4,
    mp3_validation_ms: 1,
    storage_upload_ms: 5,
    track_finalization_ms: 6,
    total_task_wall_clock_ms: 130,
  };
}

test("dedicated URL live verifier requires a fresh operator-supplied operation ID", () => {
  assert.equal(validateFutureLiveOperationId(TEST_OPERATION_ID), TEST_OPERATION_ID);
  for (const value of ["", " ", "browser-operation", ...HISTORICAL_TOKENHUB_MUSIC_OPERATION_IDS]) {
    assert.throws(() => validateFutureLiveOperationId(value));
  }
  assert.match(verifierSource, /MEDCLIP_TOKENHUB_URL_LIVE_OPERATION_ID/);
  assert.doesNotMatch(verifierSource, /const operationId\s*=\s*"c1d_/);
});

test("V7 verifier request is fixed to TokenHub URL-output music generation", () => {
  const request = buildTokenHubURLLiveRequest(TEST_OPERATION_ID);
  assert.equal(request.task, "music.generate");
  assert.equal(request.provider, "tencent_tokenhub");
  assert.equal(request.input.operationId, TEST_OPERATION_ID);
  assert.equal(request.input.mode, "custom_lyrics");
  assert.equal(request.input.title, "MedClip 完整生成链路测试");
  assert.equal(
    request.input.prompt,
    "温暖清新的中文流行歌曲，轻柔钢琴与原声吉他，年轻自然的人声，节奏舒缓，结构简洁，仅用于 MedClip 完整音乐生成链路验证。",
  );
  assert.equal(typeof request.input.lyrics, "string");
  assert.equal(typeof request.input.prompt, "string");
  assert.match(verifierSource, /minimax-music-v2\.6/);
  assert.doesNotMatch(verifierSource, /OUTPUT FORMAT = hex|hexCharacterLength|decodedMp3Bytes/);
  assert.doesNotMatch(verifierSource, /\/v1\/models/);
});

test("trusted diagnostics accept hostname-only evidence and reject URL material", () => {
  const safe = assertTrustedURLDiagnostics(diagnostics());
  assert.equal(safe.normalized_download_hostname, "aigc-output-audio-file-1326893053.cos.ap-guangzhou.myqcloud.com");
  for (const mutation of [
    { normalized_download_hostname: "https://media.provider.example/audio.mp3" },
    { normalized_download_hostname: "media.provider.example/path" },
    { download_redirect_count: 1 },
    { dns_private_address_detected: true },
    { downloaded_bytes: 8 * 1024 * 1024 + 1 },
  ]) {
    assert.throws(() => assertTrustedURLDiagnostics({ ...diagnostics(), ...mutation }));
  }
});

test("verifier has one paid invocation and only replay/conflict follow-ups", () => {
  assert.match(verifierSource, /Exactly one invocation may create a new operation and reach TokenHub/);
  assert.match(verifierSource, /generationOccurred, true, "OPERATION_ALREADY_EXISTS_OR_NOT_GENERATED"/);
  assert.match(verifierSource, /generationOccurred, false/);
  assert.match(verifierSource, /OPERATION_CONFLICT/);
  assert.doesNotMatch(verifierSource, /while\s*\(|setInterval|retryCount|automaticRetry/i);
  assert.match(verifierSource, /createInternalLiveValidationProof/);
  assert.match(verifierSource, /INTERNAL_LIVE_VALIDATION_HEADER/);
});

test("V7 verifier never prints URL, authorization, keys, or raw provider response", () => {
  assert.doesNotMatch(verifierSource, /console\.(?:log|error)\([^\n]*(?:signedUrl|Authorization|apiKey|raw_response)/i);
  assert.match(verifierSource, /assertNoSecretOrURLExposure/);
  assert.match(verifierSource, /full URL exposed/);
  assert.doesNotMatch(verifierSource, /MEDCLIP_TEST_TOKENHUB_API_KEY/);
});

test("package exposes the dedicated URL verifier without replacing historical verifier", () => {
  assert.match(packageSource, /"verify:tokenhub-music-live"/);
  assert.match(packageSource, /"verify:tokenhub-music-url-live"/);
  assert.match(packageSource, /scripts\/verify-tokenhub-music-url-live\.mjs/);
});
