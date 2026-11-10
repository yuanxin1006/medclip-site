import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { applyAIEditingPlan } from "../app/editor-ai-requirements.ts";
import { averageSpeed } from "../app/editor-core.ts";
import { assertSafeVerifierOutput } from "./ai-text-verifier-safety.ts";
import {
  createInternalLiveValidationProof,
  deriveInternalLiveValidationSecret,
  INTERNAL_LIVE_VALIDATION_HEADER,
} from "../supabase/functions/_shared/ai-tasks/internal-live-validation.ts";
import { parseAITaskRequest } from "../supabase/functions/_shared/ai-tasks/request.ts";
import {
  createInternalTextTaskFixtureApplicationContext,
  getInternalTextTaskFixtureDefinition,
  INTERNAL_TEXT_TASK_FIXTURE_HEADER,
  INTERNAL_TEXT_TASK_FIXTURES,
} from "../supabase/functions/_shared/ai-tasks/text-fixtures.ts";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const email = process.env.MEDCLIP_TEST_USER_A_EMAIL;
const password = process.env.MEDCLIP_TEST_USER_A_PASSWORD;
const allowedOrigin = "http://localhost:3000";

function requireEnvironment() {
  const missing = Object.entries({
    NEXT_PUBLIC_SUPABASE_URL: projectUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
    MEDCLIP_TEST_USER_A_EMAIL: email,
    MEDCLIP_TEST_USER_A_PASSWORD: password,
  }).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`missing required local variables: ${missing.join(", ")}`);
}

function createFixtureRequest(fixture) {
  const definition = getInternalTextTaskFixtureDefinition(fixture);
  return parseAITaskRequest({
    task: "editor.requirements_parse",
    provider: "deepseek",
    input: definition.input,
  });
}

function assertDeterministicApplication(data, expected, fixture) {
  const application = createInternalTextTaskFixtureApplicationContext(fixture);
  const childIds = [...application.childIds];
  const apply = () => applyAIEditingPlan(data, {
    project: application.project,
    ownedAssetIds: new Set(application.ownedAssetIds),
    audioSourceDurationMs: application.audioSourceDurationMs,
    nowIso: "2026-10-18T00:00:01.000Z",
    createClipId: () => childIds.shift() ?? crypto.randomUUID(),
  });
  if (expected.deterministicApplication === "PASS") {
    const applied = apply();
    assert.deepEqual(applied.applied.map((item) => item.type), expected.actionTypes);
    if (expected.deterministicResult) {
      const clips = applied.project.tracks.find((track) => track.id === "video-main")?.clips ?? [];
      if (expected.deterministicResult.clipIds) {
        assert.deepEqual(clips.map((clip) => clip.id), expected.deterministicResult.clipIds);
      }
      assert.deepEqual(clips.map((clip) => [clip.timelineStartMs, clip.timelineEndMs]), expected.deterministicResult.timelineRangesMs);
      assert.deepEqual(clips.map((clip) => [clip.sourceInMs, clip.sourceOutMs]), expected.deterministicResult.sourceRangesMs);
      assert.deepEqual(clips.map((clip) => averageSpeed(clip.speedCurve)), expected.deterministicResult.playbackRates);
    }
  } else if (expected.deterministicApplication === "REJECT") {
    assert.throws(apply);
  }
}

async function invokeFixture(endpoint, accessToken, request, proof, fixture) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      Origin: allowedOrigin,
      "Content-Type": "application/json",
      [INTERNAL_LIVE_VALIDATION_HEADER]: proof,
      [INTERNAL_TEXT_TASK_FIXTURE_HEADER]: fixture,
    },
    body: JSON.stringify(request),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* asserted from the fixture contract */ }
  return { response, text, body };
}

async function main() {
  requireEnvironment();
  const client = createClient(projectUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const sensitiveValues = [anonKey, email, password];
  try {
    const auth = await client.auth.signInWithPassword({ email, password });
    if (auth.error || !auth.data.user || !auth.data.session?.access_token) throw new Error("authentication failed");
    sensitiveValues.push(auth.data.session.access_token);
    const secret = await deriveInternalLiveValidationSecret(password);
    sensitiveValues.push(secret);
    const endpoint = new URL("/functions/v1/ai-tasks", new URL(projectUrl)).toString();

    const unauthorizedRequest = createFixtureRequest("valid_canonical_plan");
    const unauthorized = await invokeFixture(
      endpoint,
      auth.data.session.access_token,
      unauthorizedRequest,
      "v1.0000000000000.invalid",
      "valid_canonical_plan",
    );
    assert.equal(unauthorized.response.status, 401);
    assert.equal(unauthorized.body?.metadata, undefined);
    assertSafeVerifierOutput(unauthorized.text, sensitiveValues);

    for (const fixture of INTERNAL_TEXT_TASK_FIXTURES) {
      const definition = getInternalTextTaskFixtureDefinition(fixture);
      const request = createFixtureRequest(fixture);
      const proof = await createInternalLiveValidationProof({ secret, userId: auth.data.user.id, request });
      const result = await invokeFixture(endpoint, auth.data.session.access_token, request, proof, fixture);
      assert.equal(result.response.status, definition.expected.edgeHttpStatus);
      assert.match(result.response.headers.get("x-medclip-request-id") ?? "", /^[0-9a-f-]{36}$/i);
      assertSafeVerifierOutput(result.text, [...sensitiveValues, proof]);

      if (definition.expected.canonicalValidation === "PASS") {
        assert.equal(result.body?.ok, true);
        assert.equal(result.body?.metadata?.providerFreeFixture, true);
        const data = result.body?.result?.data;
        assert.deepEqual(data, definition.response.content);
        assert.deepEqual(data.actions.map((action) => action.type), definition.expected.actionTypes);
        assertDeterministicApplication(data, definition.expected, fixture);
      } else {
        const diagnostic = result.body?.metadata?.trustedInternalDiagnostics;
        const providerHttpStatus = definition.response.status;
        assert.equal(diagnostic?.failure_class, definition.expected.safeDiagnosticClass);
        assert.equal(diagnostic?.safe_error_code, definition.expected.safeErrorCode);
        assert.equal(diagnostic?.provider_http_status, providerHttpStatus);
        assert.equal(diagnostic?.provider_response_received, true);
        assert.equal(diagnostic?.canonical_validation_reached, definition.expected.safeDiagnosticClass === "CANONICAL_SCHEMA_ERROR");
        assert.equal(result.response.headers.get("x-medclip-request-id"), diagnostic?.request_id);
      }

      console.log([
        `REMOTE FIXTURE ${fixture} = PASS`,
        `response=${definition.expected.providerResponseClass}`,
        `http=${definition.expected.edgeHttpStatus}`,
        `canonical=${definition.expected.canonicalValidation}`,
        `actions=${definition.expected.actionTypes.join("+") || "NONE"}`,
        `diagnostic=${definition.expected.safeDiagnosticClass ?? "NONE"}`,
        `error=${definition.expected.safeErrorCode ?? "NONE"}`,
      ].join(" | "));
    }

    console.log("REMOTE TEXT DIAGNOSTIC FIXTURES = PASS");
    console.log("REMOTE INVALID PROOF 401 = PASS");
    console.log("BROWSER INTERNAL DIAGNOSTIC LEAK = NO");
    console.log("TEXT PROVIDER LIVE CALLS = 0");
  } finally {
    await client.auth.signOut();
  }
}

main().catch((error) => {
  console.error(`REMOTE TEXT DIAGNOSTIC FIXTURES = FAIL: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
});
