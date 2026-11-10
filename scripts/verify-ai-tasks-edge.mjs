import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const credentials = {
  userA: { email: process.env.MEDCLIP_TEST_USER_A_EMAIL, password: process.env.MEDCLIP_TEST_USER_A_PASSWORD },
  userB: { email: process.env.MEDCLIP_TEST_USER_B_EMAIL, password: process.env.MEDCLIP_TEST_USER_B_PASSWORD },
};
const allowedOrigin = "http://localhost:3000";
const disallowedOrigin = "https://example.invalid";
const requiredCorsHeaders = ["authorization", "x-client-info", "apikey", "content-type"];
const metadataColumns = "id,user_id,provider,provider_resource_id,key_last4,status,last_validated_at,created_at,updated_at";

function pass(label) {
  console.log(`PASS: ${label}`);
}

function requireEnvironment() {
  const entries = [
    ["NEXT_PUBLIC_SUPABASE_URL", projectUrl],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", anonKey],
    ["MEDCLIP_TEST_USER_A_EMAIL", credentials.userA.email],
    ["MEDCLIP_TEST_USER_A_PASSWORD", credentials.userA.password],
    ["MEDCLIP_TEST_USER_B_EMAIL", credentials.userB.email],
    ["MEDCLIP_TEST_USER_B_PASSWORD", credentials.userB.password],
  ];
  const missing = entries.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`missing required local variables: ${missing.join(", ")}`);
}

function createBrowserClient() {
  return createClient(projectUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

function endpoint() {
  return new URL("/functions/v1/ai-tasks", new URL(projectUrl)).toString();
}

function headers(origin, accessToken) {
  return {
    apikey: anonKey,
    Origin: origin,
    "Content-Type": "application/json",
    "x-client-info": "medclip-ai-task-verifier",
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function payload(response) {
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* raw text is inspected but never printed */ }
  return { text, json };
}

function assertSafe(value, sensitiveValues) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const marker of ["ciphertext", '"iv"', "api_key", "authorization", "SUPABASE_SECRET_KEYS", "MEDCLIP_CREDENTIAL_ENCRYPTION_KEY", "stack trace", "at file://"]) {
    assert.equal(text.toLowerCase().includes(marker.toLowerCase()), false, "response exposed a forbidden marker");
  }
  for (const secret of sensitiveValues.filter(Boolean)) assert.equal(text.includes(secret), false, "response exposed a local credential");
}

async function signIn(client, credential, label) {
  const result = await client.auth.signInWithPassword(credential);
  if (result.error || !result.data.user || !result.data.session?.access_token) throw new Error(`${label}: authentication failed`);
  pass(`${label} authenticated`);
  return { user: result.data.user, accessToken: result.data.session.access_token };
}

async function metadataSnapshot(client, userId) {
  const result = await client.from("user_ai_provider_connections").select(metadataColumns).order("id", { ascending: true });
  if (result.error) throw new Error("metadata snapshot failed");
  assert.equal((result.data ?? []).every((row) => row.user_id === userId), true, "metadata crossed user ownership");
  return result.data ?? [];
}

async function invokeTask(functionUrl, accessToken, body) {
  const response = await fetch(functionUrl, { method: "POST", headers: headers(allowedOrigin, accessToken), body: JSON.stringify(body) });
  return { response, payload: await payload(response) };
}

async function main() {
  requireEnvironment();
  const functionUrl = endpoint();
  const anonymousClient = createBrowserClient();
  const userAClient = createBrowserClient();
  const userBClient = createBrowserClient();
  const sensitiveValues = [anonKey, credentials.userA.email, credentials.userA.password, credentials.userB.email, credentials.userB.password];
  const safeTask = {
    task: "music.lyrics_draft",
    provider: "deepseek",
    input: { theme: "runtime contract verification only" },
  };

  try {
    const preflight = await fetch(functionUrl, { method: "OPTIONS", headers: { ...headers(allowedOrigin), "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": requiredCorsHeaders.join(", ") } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), allowedOrigin);
    assert.notEqual(preflight.headers.get("access-control-allow-origin"), "*");
    const allowedHeaders = new Set((preflight.headers.get("access-control-allow-headers") ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
    requiredCorsHeaders.forEach((header) => assert.equal(allowedHeaders.has(header), true));
    pass("Allowed CORS preflight is exact and complete");

    const disallowed = await fetch(functionUrl, { method: "OPTIONS", headers: { ...headers(disallowedOrigin), "Access-Control-Request-Method": "POST" } });
    const disallowedPayload = await payload(disallowed);
    assert.equal(disallowed.ok, false);
    assert.equal(disallowed.headers.get("access-control-allow-origin"), null);
    assertSafe(disallowedPayload.text, sensitiveValues);
    pass("Disallowed origin is blocked without reflection");

    const anonymous = await invokeTask(functionUrl, null, safeTask);
    assert.equal(anonymous.response.status, 401);
    assert.equal(anonymous.payload.json?.status, "UNAUTHENTICATED");
    assertSafe(anonymous.payload.text, sensitiveValues);
    pass("Anonymous AI task is blocked");

    const invalid = await invokeTask(functionUrl, "medclip-invalid-runtime-token", safeTask);
    assert.equal(invalid.response.status, 401);
    assert.equal(invalid.payload.json?.status, "UNAUTHENTICATED");
    assertSafe(invalid.payload.text, sensitiveValues);
    pass("Invalid JWT AI task is blocked");

    const userA = await signIn(userAClient, credentials.userA, "User A");
    const userB = await signIn(userBClient, credentials.userB, "User B");
    const beforeA = await metadataSnapshot(userAClient, userA.user.id);
    const beforeB = await metadataSnapshot(userBClient, userB.user.id);

    const publicMusic = await invokeTask(functionUrl, userA.accessToken, {
      task: "music.generate",
      provider: "tencent_tokenhub",
      input: {
        operationId: "gate_fix_public_probe_20261003_001",
        mode: "instrumental",
        prompt: "public path must remain closed",
      },
    });
    assert.equal(publicMusic.response.status, 501);
    assert.equal(publicMusic.payload.json?.status, "PROVIDER_NOT_SUPPORTED_FOR_TASK");
    assert.equal(publicMusic.payload.json?.generationOccurred, false);
    assertSafe(publicMusic.payload.text, sensitiveValues);
    pass("Foundation-ready TokenHub music generation remains blocked on the public path");

    for (const removedProvider of ["openai", "gemini"]) {
      const removed = await invokeTask(functionUrl, userA.accessToken, {
        ...safeTask,
        provider: removedProvider,
      });
      assert.equal(removed.response.ok, false, `${removedProvider}: removed Provider unexpectedly accepted`);
      assert.equal(removed.response.status, 400, `${removedProvider}: expected HTTP 400`);
      assert.equal(removed.payload.json?.status, "PROVIDER_NOT_SUPPORTED_FOR_TASK");
      assert.equal(removed.payload.json?.generationOccurred, false);
      assertSafe(removed.payload.text, sensitiveValues);
      pass(`${removedProvider} task requests are rejected before credential or Provider access`);
    }

    for (const [label, session] of [["User A", userA], ["User B", userB]]) {
      const response = await invokeTask(functionUrl, session.accessToken, safeTask);
      assert.equal(response.response.ok, false, `${label}: foundation must not execute a Provider`);
      assert.ok(
        ["NOT_CONNECTED", "PROVIDER_NOT_SUPPORTED_FOR_TASK"].includes(response.payload.json?.status),
        `${label}: unexpected safe foundation status`,
      );
      assert.equal(response.payload.json?.generationOccurred, false);
      assertSafe(response.payload.text, sensitiveValues);
      pass(`${label} reaches the safe authenticated task contract`);
    }

    const crossUser = await invokeTask(functionUrl, userA.accessToken, { ...safeTask, userId: userB.user.id });
    assert.equal(crossUser.response.ok, false);
    assert.equal(crossUser.payload.json?.status, "INVALID_INPUT");
    assert.equal(crossUser.payload.json?.generationOccurred, false);
    assertSafe(crossUser.payload.text, sensitiveValues);
    pass("Caller-supplied cross-user identity is rejected");

    const afterA = await metadataSnapshot(userAClient, userA.user.id);
    const afterB = await metadataSnapshot(userBClient, userB.user.id);
    assert.deepEqual(afterA, beforeA);
    assert.deepEqual(afterB, beforeB);
    pass("AI task verification did not modify credentials");

    console.log("AI TASK EDGE TEST = PASS");
    console.log("CROSS-USER ISOLATION = PASS");
    console.log("REMOVED PROVIDER REQUESTS REJECTED = PASS");
    console.log("TOKENHUB PUBLIC MUSIC = BLOCKED");
    console.log("PROVIDER API CALLED = NO");
    console.log("CREDENTIAL DATA MODIFIED = NO");
  } catch (error) {
    console.error(`AI TASK EDGE TEST = FAIL: ${error instanceof Error ? error.message : "unknown failure"}`);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([anonymousClient.auth.signOut(), userAClient.auth.signOut(), userBClient.auth.signOut()]);
  }
}

await main();
