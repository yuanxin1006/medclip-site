import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const credentials = {
  userA: {
    email: process.env.MEDCLIP_TEST_USER_A_EMAIL,
    password: process.env.MEDCLIP_TEST_USER_A_PASSWORD,
  },
  userB: {
    email: process.env.MEDCLIP_TEST_USER_B_EMAIL,
    password: process.env.MEDCLIP_TEST_USER_B_PASSWORD,
  },
};
const allowedOrigin = "http://localhost:3000";
const disallowedOrigin = "https://example.invalid";
const requiredCorsHeaders = ["authorization", "x-client-info", "apikey", "content-type"];
const metadataColumns = [
  "id",
  "user_id",
  "provider",
  "provider_resource_id",
  "key_last4",
  "status",
  "last_validated_at",
  "created_at",
  "updated_at",
].join(",");

function pass(label) {
  console.log(`PASS: ${label}`);
}

function createBrowserClient() {
  return createClient(projectUrl, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
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

function functionEndpoint() {
  const base = new URL(projectUrl);
  return new URL("/functions/v1/ai-credentials", base).toString();
}

function requestHeaders(origin, authorization) {
  return {
    apikey: anonKey,
    Origin: origin,
    "x-client-info": "medclip-edge-auth-verifier",
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

async function responsePayload(response) {
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Security checks still inspect the raw text without printing it.
  }
  return { text, json };
}

function assertNoSensitiveLeak(text, sensitiveValues) {
  const forbiddenMarkers = [
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SERVICE_ROLE_KEY",
    "MEDCLIP_CREDENTIAL_ENCRYPTION_KEY",
    "at file://",
    "stack trace",
  ];
  for (const marker of forbiddenMarkers) {
    assert.equal(text.toLowerCase().includes(marker.toLowerCase()), false, "response exposed a forbidden internal marker");
  }
  for (const value of sensitiveValues.filter(Boolean)) {
    assert.equal(text.includes(value), false, "response exposed a local credential value");
  }
}

function assertBlocked(response, payload, sensitiveValues, label) {
  assert.equal(response.ok, false, `${label}: request unexpectedly succeeded`);
  assert.ok([401, 403].includes(response.status), `${label}: expected HTTP 401 or 403`);
  assertNoSensitiveLeak(payload.text, sensitiveValues);
  if (payload.json && typeof payload.json === "object") {
    assert.notEqual(payload.json.ok, true, `${label}: response claimed success`);
    assert.equal("connections" in payload.json, false, `${label}: response exposed connection metadata`);
  }
  pass(label);
}

function assertNoForbiddenResponseFields(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(assertNoForbiddenResponseFields);
    return;
  }
  const forbidden = new Set(["api_key", "plaintext_api_key", "ciphertext", "iv", "secret"]);
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(forbidden.has(key.toLowerCase()), false, "response exposed a forbidden credential field");
    assertNoForbiddenResponseFields(nested);
  }
}

async function signIn(client, credential, label) {
  const result = await client.auth.signInWithPassword(credential);
  if (result.error || !result.data.user || !result.data.session?.access_token) {
    throw new Error(`${label}: authentication failed`);
  }
  pass(`${label} authenticated`);
  return {
    user: result.data.user,
    accessToken: result.data.session.access_token,
  };
}

async function ownMetadataSnapshot(client, userId, label) {
  const result = await client
    .from("user_ai_provider_connections")
    .select(metadataColumns)
    .order("id", { ascending: true });
  if (result.error) throw new Error(`${label}: metadata snapshot failed`);
  const rows = result.data ?? [];
  assert.equal(rows.every((row) => row.user_id === userId), true, `${label}: snapshot crossed user ownership`);
  return rows;
}

async function authenticatedList(endpoint, user, accessToken, sensitiveValues, label) {
  const response = await fetch(endpoint, {
    method: "GET",
    headers: requestHeaders(allowedOrigin, `Bearer ${accessToken}`),
  });
  const payload = await responsePayload(response);
  assert.equal(response.ok, true, `${label}: expected HTTP success`);
  assert.equal(response.status, 200, `${label}: expected HTTP 200`);
  assertNoSensitiveLeak(payload.text, sensitiveValues);
  assert.ok(payload.json && typeof payload.json === "object", `${label}: expected JSON response`);
  assert.equal(payload.json.ok, true, `${label}: response did not report success`);
  assert.ok(Array.isArray(payload.json.connections), `${label}: connections must be an array`);
  assert.equal(
    payload.json.connections.every((connection) => connection?.user_id === user.id),
    true,
    `${label}: response included another user's metadata`,
  );
  assertNoForbiddenResponseFields(payload.json);
  pass(label);
  return payload.json.connections;
}

async function main() {
  requireEnvironment();
  const endpoint = functionEndpoint();
  const anonymousClient = createBrowserClient();
  const userAClient = createBrowserClient();
  const userBClient = createBrowserClient();
  const sensitiveValues = [
    anonKey,
    credentials.userA.email,
    credentials.userA.password,
    credentials.userB.email,
    credentials.userB.password,
  ];

  try {
    const preflight = await fetch(endpoint, {
      method: "OPTIONS",
      headers: {
        ...requestHeaders(allowedOrigin),
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": requiredCorsHeaders.join(", "),
      },
    });
    assert.equal(preflight.status, 204, "allowed preflight must return HTTP 204");
    assert.equal(preflight.headers.get("access-control-allow-origin"), allowedOrigin);
    assert.notEqual(preflight.headers.get("access-control-allow-origin"), "*");
    const allowedHeaders = new Set(
      (preflight.headers.get("access-control-allow-headers") ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean),
    );
    requiredCorsHeaders.forEach((header) => assert.equal(allowedHeaders.has(header), true));
    pass("Allowed CORS preflight is exact and complete");

    const disallowed = await fetch(endpoint, {
      method: "OPTIONS",
      headers: {
        ...requestHeaders(disallowedOrigin),
        "Access-Control-Request-Method": "GET",
      },
    });
    const disallowedPayload = await responsePayload(disallowed);
    assert.equal(disallowed.ok, false, "disallowed origin unexpectedly succeeded");
    assert.ok([401, 403].includes(disallowed.status), "disallowed origin must be blocked");
    assert.notEqual(disallowed.headers.get("access-control-allow-origin"), "*");
    assert.notEqual(disallowed.headers.get("access-control-allow-origin"), disallowedOrigin);
    assertNoSensitiveLeak(disallowedPayload.text, sensitiveValues);
    pass("Disallowed origin is blocked without reflection");

    const anonymous = await fetch(endpoint, {
      method: "GET",
      headers: requestHeaders(allowedOrigin),
    });
    const anonymousPayload = await responsePayload(anonymous);
    assertBlocked(anonymous, anonymousPayload, sensitiveValues, "Anonymous credential operation is blocked");

    const invalidJwt = await fetch(endpoint, {
      method: "GET",
      headers: requestHeaders(allowedOrigin, "Bearer medclip-invalid-runtime-verification-token"),
    });
    const invalidPayload = await responsePayload(invalidJwt);
    assertBlocked(invalidJwt, invalidPayload, sensitiveValues, "Invalid user JWT is blocked");

    const userA = await signIn(userAClient, credentials.userA, "User A");
    const userB = await signIn(userBClient, credentials.userB, "User B");
    const beforeA = await ownMetadataSnapshot(userAClient, userA.user.id, "User A before");
    const beforeB = await ownMetadataSnapshot(userBClient, userB.user.id, "User B before");

    for (const removedProvider of ["openai", "gemini"]) {
      const rejected = await fetch(endpoint, {
        method: "POST",
        headers: {
          ...requestHeaders(allowedOrigin, `Bearer ${userA.accessToken}`),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "test",
          mode: "transient",
          provider: removedProvider,
          apiKey: "non-secret-removed-provider-probe",
        }),
      });
      const rejectedPayload = await responsePayload(rejected);
      assert.equal(rejected.ok, false, `${removedProvider}: removed Provider unexpectedly accepted`);
      assert.equal(rejected.status, 400, `${removedProvider}: expected HTTP 400`);
      assert.equal(rejectedPayload.json?.status, "INVALID_PROVIDER");
      assertNoSensitiveLeak(rejectedPayload.text, sensitiveValues);
      pass(`${removedProvider} credential requests are rejected before Provider access`);
    }

    const connectionsA = await authenticatedList(
      endpoint,
      userA.user,
      userA.accessToken,
      sensitiveValues,
      "User A authenticated list",
    );
    const connectionsB = await authenticatedList(
      endpoint,
      userB.user,
      userB.accessToken,
      sensitiveValues,
      "User B authenticated list",
    );

    assert.equal(connectionsA.some((connection) => connection.user_id === userB.user.id), false);
    assert.equal(connectionsB.some((connection) => connection.user_id === userA.user.id), false);
    pass("Authenticated list responses are owner-scoped");

    const afterA = await ownMetadataSnapshot(userAClient, userA.user.id, "User A after");
    const afterB = await ownMetadataSnapshot(userBClient, userB.user.id, "User B after");
    assert.deepEqual(afterA, beforeA, "User A BYOK metadata changed during read-only verification");
    assert.deepEqual(afterB, beforeB, "User B BYOK metadata changed during read-only verification");
    pass("BYOK metadata remained unchanged");

    const hasSavedData = connectionsA.length > 0 || connectionsB.length > 0;
    console.log(
      `CROSS-USER SAVED-DATA TEST = ${hasSavedData ? "PASS" : "PENDING SAVED-CREDENTIAL STAGE"}`,
    );
    console.log("EDGE CREDENTIAL AUTH RUNTIME TEST = PASS");
    console.log("REMOVED PROVIDER REQUESTS REJECTED = PASS");
    console.log("PROVIDER API CALLED = NO");
    console.log("BYOK DATA CREATED = NO");
    console.log("BYOK DATA MODIFIED = NO");
  } catch (error) {
    console.error(`EDGE CREDENTIAL AUTH RUNTIME TEST = FAIL: ${error instanceof Error ? error.message : "unknown failure"}`);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([
      anonymousClient.auth.signOut(),
      userAClient.auth.signOut(),
      userBClient.auth.signOut(),
    ]);
  }
}

await main();
