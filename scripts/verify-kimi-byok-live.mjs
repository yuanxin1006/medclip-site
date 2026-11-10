import { createClient } from "@supabase/supabase-js";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const kimiApiKey = process.env.MEDCLIP_TEST_KIMI_API_KEY;
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

function ensure(condition, message) {
  if (!condition) throw new Error(message);
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

function endpoint() {
  return new URL("/functions/v1/ai-credentials", new URL(projectUrl)).toString();
}

function assertSafeResponse(value, rawText) {
  ensure(!rawText.includes(kimiApiKey), "response exposed the full Provider API key");
  const forbiddenFields = new Set([
    "api_key",
    "apikey",
    "plaintext_api_key",
    "ciphertext",
    "iv",
    "encryption_key",
    "secret",
  ]);

  function visit(current) {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    for (const [key, nested] of Object.entries(current)) {
      ensure(!forbiddenFields.has(key.toLowerCase()), "response exposed a forbidden credential field");
      visit(nested);
    }
  }

  visit(value);
}

async function callCredentialFunction(accessToken, body) {
  const response = await fetch(endpoint(), {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Origin: allowedOrigin,
      "x-client-info": "medclip-kimi-live-verifier",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("Edge Function returned a non-JSON response");
  }
  assertSafeResponse(data, text);
  return { response, data };
}

async function callCredentialList(accessToken) {
  const response = await fetch(endpoint(), {
    method: "GET",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      Origin: allowedOrigin,
      "x-client-info": "medclip-kimi-live-verifier",
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("Edge Function list returned a non-JSON response");
  }
  assertSafeResponse(data, text);
  ensure(response.ok && response.status === 200, "Edge Function list failed");
  ensure(data?.ok === true && Array.isArray(data.connections), "Edge Function list response is invalid");
  return data.connections;
}

async function signIn(client, credential) {
  const result = await client.auth.signInWithPassword(credential);
  ensure(!result.error, "test-user authentication failed");
  ensure(result.data.user && result.data.session?.access_token, "test-user session is incomplete");
  return {
    user: result.data.user,
    accessToken: result.data.session.access_token,
  };
}

async function kimiRows(client, userId) {
  const result = await client
    .from("user_ai_provider_connections")
    .select(metadataColumns)
    .eq("provider", "kimi")
    .order("id", { ascending: true });
  ensure(!result.error, "Kimi metadata query failed");
  const rows = result.data ?? [];
  ensure(rows.every((row) => row.user_id === userId), "metadata query crossed user ownership");
  return rows;
}

function requireSuccessfulValidation(result, label) {
  ensure(result.response.ok && result.response.status === 200, `${label} request failed`);
  ensure(result.data?.ok === true, `${label} did not validate successfully`);
  ensure(result.data.validation?.ok === true, `${label} validation result was not successful`);
  ensure(result.data.validation?.provider === "kimi", `${label} returned the wrong provider`);
}

function requireNotConnected(result, label) {
  ensure(!result.response.ok, `${label} unexpectedly succeeded`);
  ensure([400, 404].includes(result.response.status), `${label} returned an unsafe status`);
  ensure(result.data?.ok !== true, `${label} claimed success`);
  ensure(result.data?.status === "NOT_CONNECTED", `${label} did not return NOT_CONNECTED`);
}

async function main() {
  if (!kimiApiKey) {
    console.log("LIVE TEST STATUS = READY / NOT RUN");
    return;
  }

  const required = [
    projectUrl,
    anonKey,
    credentials.userA.email,
    credentials.userA.password,
    credentials.userB.email,
    credentials.userB.password,
  ];
  if (required.some((value) => !value)) {
    console.error("LIVE TEST STATUS = NOT READY");
    process.exitCode = 1;
    return;
  }

  const userAClient = createBrowserClient();
  const userBClient = createBrowserClient();
  let userA = null;
  let userB = null;
  let cleanPrecondition = false;
  let saveAttempted = false;
  let testConnectionId = null;
  let completed = false;
  let cleanupFailure = false;
  let currentStep = "authentication";

  try {
    userA = await signIn(userAClient, credentials.userA);
    userB = await signIn(userBClient, credentials.userB);

    currentStep = "existing connection precondition";
    const initialA = await kimiRows(userAClient, userA.user.id);
    const initialB = await kimiRows(userBClient, userB.user.id);
    if (initialA.length > 0 || initialB.length > 0) {
      console.error("KIMI LIVE TEST = BLOCKED - EXISTING CONNECTION");
      process.exitCode = 1;
      return;
    }
    cleanPrecondition = true;

    currentStep = "transient validation";
    const transient = await callCredentialFunction(userA.accessToken, {
      action: "test",
      provider: "kimi",
      mode: "transient",
      apiKey: kimiApiKey,
    });
    requireSuccessfulValidation(transient, "transient validation");
    ensure((await kimiRows(userAClient, userA.user.id)).length === 0, "transient validation created metadata");

    currentStep = "save";
    saveAttempted = true;
    const saved = await callCredentialFunction(userA.accessToken, {
      action: "save",
      provider: "kimi",
      apiKey: kimiApiKey,
    });
    requireSuccessfulValidation(saved, "save");
    ensure(saved.data.connection?.provider === "kimi", "save returned the wrong provider");
    ensure(saved.data.connection?.user_id === userA.user.id, "save returned the wrong owner");
    ensure(saved.data.connection?.key_last4 === kimiApiKey.slice(-4), "save returned an incorrect key suffix");
    ensure(typeof saved.data.connection?.id === "string", "save did not return a connection ID");
    testConnectionId = saved.data.connection.id;

    const storedAfterSave = await kimiRows(userAClient, userA.user.id);
    ensure(storedAfterSave.length === 1, "User A did not receive exactly one saved Kimi connection");
    ensure(storedAfterSave[0].id === testConnectionId, "saved metadata identity mismatch");
    ensure(storedAfterSave[0].key_last4 === kimiApiKey.slice(-4), "saved metadata key suffix mismatch");

    currentStep = "User B list isolation";
    const userBConnections = await callCredentialList(userB.accessToken);
    ensure(
      !userBConnections.some((connection) => connection?.provider === "kimi"),
      "User B could see User A Kimi metadata",
    );

    currentStep = "User B saved-test isolation";
    const userBSavedTest = await callCredentialFunction(userB.accessToken, {
      action: "test",
      provider: "kimi",
      mode: "saved",
    });
    requireNotConnected(userBSavedTest, "User B saved test");

    currentStep = "User B delete isolation";
    const userBDelete = await callCredentialFunction(userB.accessToken, {
      action: "delete",
      provider: "kimi",
    });
    ensure(userBDelete.response.ok && userBDelete.data?.ok === true, "User B empty delete failed safely");
    const userAAfterUserBDelete = await kimiRows(userAClient, userA.user.id);
    ensure(
      userAAfterUserBDelete.length === 1 && userAAfterUserBDelete[0].id === testConnectionId,
      "User B delete affected User A credential",
    );

    currentStep = "saved credential decrypt and validation";
    const savedValidation = await callCredentialFunction(userA.accessToken, {
      action: "test",
      provider: "kimi",
      mode: "saved",
    });
    requireSuccessfulValidation(savedValidation, "saved credential validation");

    currentStep = "User A delete";
    const userADelete = await callCredentialFunction(userA.accessToken, {
      action: "delete",
      provider: "kimi",
    });
    ensure(userADelete.response.ok && userADelete.data?.ok === true, "User A delete failed");
    ensure((await kimiRows(userAClient, userA.user.id)).length === 0, "User A metadata remained after delete");
    ensure((await kimiRows(userBClient, userB.user.id)).length === 0, "User B unexpectedly has Kimi metadata");

    currentStep = "post-delete saved test";
    const postDeleteSavedTest = await callCredentialFunction(userA.accessToken, {
      action: "test",
      provider: "kimi",
      mode: "saved",
    });
    requireNotConnected(postDeleteSavedTest, "post-delete saved test");

    completed = true;
    console.log("KIMI TRANSIENT VALIDATION = PASS");
    console.log("TRANSIENT DATABASE PERSISTENCE = NO");
    console.log("KIMI SAVE = PASS");
    console.log("SAFE METADATA RESPONSE = PASS");
    console.log("USER B CANNOT SEE USER A KIMI = PASS");
    console.log("USER B SAVED TEST ISOLATED = PASS");
    console.log("USER B DELETE CANNOT DELETE USER A = PASS");
    console.log("SAVED CREDENTIAL DECRYPT + VALIDATE = PASS");
    console.log("USER A DELETE = PASS");
    console.log("POST-DELETE SAVED TEST BLOCKED = PASS");
    console.log("FULL API KEY RETURNED = NO");
    console.log("CIPHERTEXT RETURNED = NO");
    console.log("IV RETURNED = NO");
    console.log("PROVIDER GENERATION REQUEST = NO");
  } catch {
    console.error(`KIMI LIVE TEST = FAIL AT ${currentStep}`);
    process.exitCode = 1;
  } finally {
    if (cleanPrecondition && saveAttempted && userA) {
      try {
        const remaining = await kimiRows(userAClient, userA.user.id);
        if (remaining.length > 0) {
          const cleanup = await callCredentialFunction(userA.accessToken, {
            action: "delete",
            provider: "kimi",
          });
          ensure(cleanup.response.ok && cleanup.data?.ok === true, "cleanup delete failed");
        }
        ensure((await kimiRows(userAClient, userA.user.id)).length === 0, "cleanup metadata verification failed");
      } catch {
        cleanupFailure = true;
        process.exitCode = 1;
        console.error("SECURITY CLEANUP FAILURE");
      }
    }

    await Promise.allSettled([
      userAClient.auth.signOut(),
      userBClient.auth.signOut(),
    ]);

    if (cleanPrecondition && saveAttempted && !cleanupFailure) {
      console.log("FINAL KIMI TEST CREDENTIAL REMAINS = NO");
      console.log("CLEANUP = PASS");
    }
    if (completed && cleanupFailure) process.exitCode = 1;
  }
}

await main();
