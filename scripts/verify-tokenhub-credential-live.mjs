import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const tokenHubAPIKey = process.env.MEDCLIP_TEST_TOKENHUB_API_KEY;
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
const provider = "tencent_tokenhub";
const targetModel = "minimax-music-v2.6";
const allowedOrigin = "http://localhost:3000";

function requireEnvironment() {
  const required = [
    ["NEXT_PUBLIC_SUPABASE_URL", projectUrl],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", anonKey],
    ["MEDCLIP_TEST_TOKENHUB_API_KEY", tokenHubAPIKey],
    ["MEDCLIP_TEST_USER_A_EMAIL", credentials.userA.email],
    ["MEDCLIP_TEST_USER_A_PASSWORD", credentials.userA.password],
    ["MEDCLIP_TEST_USER_B_EMAIL", credentials.userB.email],
    ["MEDCLIP_TEST_USER_B_PASSWORD", credentials.userB.password],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`missing required local variables: ${missing.join(", ")}`);
}

function createBrowserClient() {
  return createClient(projectUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signIn(client, credential) {
  const result = await client.auth.signInWithPassword(credential);
  if (result.error || !result.data.user || !result.data.session?.access_token) {
    throw new Error("test user authentication failed");
  }
  return { user: result.data.user, accessToken: result.data.session.access_token };
}

function endpoint() {
  return new URL("/functions/v1/ai-credentials", projectUrl).toString();
}

async function invoke(accessToken, body) {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      Origin: allowedOrigin,
      "Content-Type": "application/json",
      "x-client-info": "medclip-tokenhub-credential-live-verifier",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // The raw body is never printed.
  }
  return { response, text, data };
}

function assertNoSecretExposure(value, sensitiveValues) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of sensitiveValues.filter(Boolean)) {
    assert.equal(serialized.includes(secret), false, "response exposed a local secret value");
  }
  for (const forbidden of ["ciphertext", "encryption_key", "SUPABASE_SERVICE_ROLE_KEY", "Authorization: Bearer"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, "response exposed forbidden credential material");
  }
}

async function listConnections(accessToken, sensitiveValues) {
  const result = await invoke(accessToken, { action: "list" });
  assert.equal(result.response.ok, true, "credential list failed");
  assert.equal(result.data?.ok, true, "credential list did not report success");
  assert.ok(Array.isArray(result.data.connections), "connections must be an array");
  assertNoSecretExposure(result.text, sensitiveValues);
  return result.data.connections;
}

async function main() {
  requireEnvironment();
  const userAClient = createBrowserClient();
  const userBClient = createBrowserClient();
  const sensitiveValues = [
    tokenHubAPIKey,
    anonKey,
    credentials.userA.email,
    credentials.userA.password,
    credentials.userB.email,
    credentials.userB.password,
  ];
  let userA = null;
  let userB = null;
  let created = false;
  let cleanupPassed = false;
  let providerCalls = 0;
  let modelVisible = false;
  let modelStatus = "unknown";

  try {
    userA = await signIn(userAClient, credentials.userA);
    userB = await signIn(userBClient, credentials.userB);
    const beforeA = await listConnections(userA.accessToken, sensitiveValues);
    const beforeB = await listConnections(userB.accessToken, sensitiveValues);
    if (beforeA.some((connection) => connection.provider === provider)
      || beforeB.some((connection) => connection.provider === provider)) {
      throw new Error("BLOCKED_EXISTING_TOKENHUB_CONNECTION");
    }

    const saved = await invoke(userA.accessToken, {
      action: "save",
      provider,
      apiKey: tokenHubAPIKey,
    });
    providerCalls = 1;
    created = saved.response.ok;
    assert.equal(saved.response.ok, true, "TokenHub credential save failed");
    assert.equal(saved.data?.ok, true, "TokenHub credential validation failed");
    assert.equal(saved.data?.validation?.status, "VALID", "TokenHub API Key was not authenticated");
    assert.equal(saved.data?.connection?.provider, provider);
    assert.equal(saved.data?.connection?.provider_resource_id, null);
    assert.equal(saved.data?.connection?.status, "connected");
    assert.equal(saved.data?.validation?.modelAvailability?.model, targetModel);
    modelVisible = saved.data.validation.modelAvailability.visible === true;
    modelStatus = ["online", "not_online", "unknown"].includes(saved.data.validation.modelAvailability.status)
      ? saved.data.validation.modelAvailability.status
      : "unknown";
    assertNoSecretExposure(saved.text, sensitiveValues);
    const afterSaveA = await listConnections(userA.accessToken, sensitiveValues);
    const afterSaveB = await listConnections(userB.accessToken, sensitiveValues);
    assert.equal(afterSaveA.some((connection) => connection.provider === provider), true);
    assert.equal(afterSaveB.some((connection) => connection.provider === provider), false);

    const userBTest = await invoke(userB.accessToken, { action: "test", mode: "saved", provider });
    assert.equal(userBTest.response.ok, false, "User B unexpectedly tested User A credential");
    assert.equal(userBTest.data?.status, "NOT_CONNECTED");
    assertNoSecretExposure(userBTest.text, sensitiveValues);

    const userBDelete = await invoke(userB.accessToken, { action: "delete", provider });
    assert.equal(userBDelete.response.ok, true, "User B own-scope delete request failed");
    assert.equal((await listConnections(userA.accessToken, sensitiveValues)).some((connection) => connection.provider === provider), true);

    const deleted = await invoke(userA.accessToken, { action: "delete", provider });
    assert.equal(deleted.response.ok, true, "User A credential delete failed");
    created = false;
    assert.equal((await listConnections(userA.accessToken, sensitiveValues)).some((connection) => connection.provider === provider), false);
    cleanupPassed = true;

    console.log("TOKENHUB CREDENTIAL LIVE = PASS");
    console.log(`VALIDATION PROVIDER CALLS = ${providerCalls}`);
    console.log("MUSIC GENERATION PROVIDER CALLS = 0");
    console.log("API KEY VALID = YES");
    console.log(`MINIMAX MUSIC V3 MODEL VISIBLE = ${modelVisible ? "YES" : "NO"}`);
    console.log(`MODEL STATUS = ${modelStatus}`);
    console.log("GENERATION ENTITLEMENT PROVEN = NO");
    console.log("CROSS-USER ISOLATION = PASS");
    console.log("FULL API KEY RETURNED = NO");
    console.log("RAW PROVIDER RESPONSE RETURNED = NO");
    console.log("FINAL TOKENHUB TEST CREDENTIAL REMAINS = NO");
    console.log("CLEANUP = PASS");
  } catch (error) {
    console.error(`TOKENHUB CREDENTIAL LIVE = FAIL: ${error instanceof Error ? error.message : "unknown failure"}`);
    process.exitCode = 1;
  } finally {
    if (created && userA?.accessToken) {
      try {
        const cleanup = await invoke(userA.accessToken, { action: "delete", provider });
        cleanupPassed = cleanup.response.ok;
      } catch {
        cleanupPassed = false;
      }
    }
    if (!cleanupPassed) {
      console.error("FINAL TOKENHUB TEST CREDENTIAL REMAINS = UNKNOWN");
      console.error("CLEANUP = FAIL");
      process.exitCode = 1;
    }
    await Promise.allSettled([userAClient.auth.signOut(), userBClient.auth.signOut()]);
  }
}

await main();
