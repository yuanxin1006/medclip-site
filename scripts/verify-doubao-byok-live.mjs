import { createClient } from "@supabase/supabase-js";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const doubaoApiKey = process.env.MEDCLIP_TEST_DOUBAO_API_KEY;
const doubaoResourceId = process.env.MEDCLIP_TEST_DOUBAO_RESOURCE_ID;
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
const apiKeyResourceIdPattern = /^apikey-[A-Za-z0-9][A-Za-z0-9._-]{0,192}$/;
const safeValidationStatuses = new Set([
  "VALID",
  "API_KEY_INVALID",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_CONFIGURATION_REQUIRED",
  "RATE_LIMITED",
  "REGION_UNAVAILABLE",
  "NETWORK_ERROR",
]);
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

class SafeValidationFailure extends Error {
  constructor(message, edgeHTTPStatus, validationStatus) {
    super(message);
    this.name = "SafeValidationFailure";
    this.edgeHTTPStatus = edgeHTTPStatus;
    this.validationStatus = safeValidationStatuses.has(validationStatus)
      ? validationStatus
      : null;
  }
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
  ensure(!rawText.includes(doubaoApiKey), "response exposed the full Provider API key");
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
      "x-client-info": "medclip-doubao-live-verifier",
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
      "x-client-info": "medclip-doubao-live-verifier",
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

async function doubaoRows(client, userId) {
  const result = await client
    .from("user_ai_provider_connections")
    .select(metadataColumns)
    .eq("provider", "doubao")
    .order("id", { ascending: true });
  ensure(!result.error, "Doubao metadata query failed");
  const rows = result.data ?? [];
  ensure(rows.every((row) => row.user_id === userId), "metadata query crossed user ownership");
  return rows;
}

function requireSuccessfulValidation(result, label) {
  const validationStatus = result.data?.validation?.status ?? result.data?.status;
  if (
    !result.response.ok
    || result.response.status !== 200
    || result.data?.ok !== true
    || result.data.validation?.ok !== true
  ) {
    throw new SafeValidationFailure(
      `${label} failed`,
      result.response.status,
      validationStatus,
    );
  }
  ensure(result.data.validation.provider === "doubao", `${label} returned the wrong provider`);
}

function requireNotConnected(result, label) {
  ensure(!result.response.ok, `${label} unexpectedly succeeded`);
  ensure([400, 404].includes(result.response.status), `${label} returned an unsafe status`);
  ensure(result.data?.ok !== true, `${label} claimed success`);
  ensure(result.data?.status === "NOT_CONNECTED", `${label} did not return NOT_CONNECTED`);
}

async function main() {
  if (!doubaoApiKey || !doubaoResourceId) {
    console.log("LIVE TEST STATUS = READY / NOT RUN");
    return;
  }
  if (!apiKeyResourceIdPattern.test(doubaoResourceId)) {
    console.error("LIVE TEST STATUS = NOT READY");
    console.error("API KEY RESOURCE ID FORMAT = INVALID");
    process.exitCode = 1;
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
    const initialA = await doubaoRows(userAClient, userA.user.id);
    const initialB = await doubaoRows(userBClient, userB.user.id);
    if (initialA.length > 0 || initialB.length > 0) {
      console.error("DOUBAO LIVE TEST = BLOCKED - EXISTING CONNECTION");
      process.exitCode = 1;
      return;
    }
    cleanPrecondition = true;

    currentStep = "transient validation";
    const transient = await callCredentialFunction(userA.accessToken, {
      action: "test",
      provider: "doubao",
      mode: "transient",
      apiKey: doubaoApiKey,
      providerResourceId: doubaoResourceId,
    });
    requireSuccessfulValidation(transient, "transient validation");
    ensure((await doubaoRows(userAClient, userA.user.id)).length === 0, "transient validation created metadata");

    currentStep = "save";
    saveAttempted = true;
    const saved = await callCredentialFunction(userA.accessToken, {
      action: "save",
      provider: "doubao",
      apiKey: doubaoApiKey,
      providerResourceId: doubaoResourceId,
    });
    requireSuccessfulValidation(saved, "save");
    ensure(saved.data.connection?.provider === "doubao", "save returned the wrong provider");
    ensure(saved.data.connection?.user_id === userA.user.id, "save returned the wrong owner");
    ensure(saved.data.connection?.provider_resource_id === doubaoResourceId, "save returned the wrong resource ID");
    ensure(saved.data.connection?.key_last4 === doubaoApiKey.slice(-4), "save returned an incorrect key suffix");
    ensure(typeof saved.data.connection?.id === "string", "save did not return a connection ID");
    testConnectionId = saved.data.connection.id;

    const storedAfterSave = await doubaoRows(userAClient, userA.user.id);
    ensure(storedAfterSave.length === 1, "User A did not receive exactly one saved Doubao connection");
    ensure(storedAfterSave[0].id === testConnectionId, "saved metadata identity mismatch");
    ensure(storedAfterSave[0].provider_resource_id === doubaoResourceId, "saved resource ID mismatch");
    ensure(storedAfterSave[0].key_last4 === doubaoApiKey.slice(-4), "saved metadata key suffix mismatch");

    currentStep = "User B list isolation";
    const userBConnections = await callCredentialList(userB.accessToken);
    ensure(
      !userBConnections.some((connection) => connection?.provider === "doubao"),
      "User B could see User A Doubao metadata",
    );

    currentStep = "User B saved-test isolation";
    const userBSavedTest = await callCredentialFunction(userB.accessToken, {
      action: "test",
      provider: "doubao",
      mode: "saved",
    });
    requireNotConnected(userBSavedTest, "User B saved test");

    currentStep = "User B delete isolation";
    const userBDelete = await callCredentialFunction(userB.accessToken, {
      action: "delete",
      provider: "doubao",
    });
    ensure(userBDelete.response.ok && userBDelete.data?.ok === true, "User B empty delete failed safely");
    const userAAfterUserBDelete = await doubaoRows(userAClient, userA.user.id);
    ensure(
      userAAfterUserBDelete.length === 1 && userAAfterUserBDelete[0].id === testConnectionId,
      "User B delete affected User A credential",
    );

    currentStep = "saved credential decrypt and validation";
    const savedValidation = await callCredentialFunction(userA.accessToken, {
      action: "test",
      provider: "doubao",
      mode: "saved",
    });
    requireSuccessfulValidation(savedValidation, "saved credential validation");

    currentStep = "User A delete";
    const userADelete = await callCredentialFunction(userA.accessToken, {
      action: "delete",
      provider: "doubao",
    });
    ensure(userADelete.response.ok && userADelete.data?.ok === true, "User A delete failed");
    ensure((await doubaoRows(userAClient, userA.user.id)).length === 0, "User A metadata remained after delete");
    ensure((await doubaoRows(userBClient, userB.user.id)).length === 0, "User B unexpectedly has Doubao metadata");

    currentStep = "post-delete saved test";
    const postDeleteSavedTest = await callCredentialFunction(userA.accessToken, {
      action: "test",
      provider: "doubao",
      mode: "saved",
    });
    requireNotConnected(postDeleteSavedTest, "post-delete saved test");

    completed = true;
    console.log("DOUBAO TRANSIENT VALIDATION = PASS");
    console.log("TRANSIENT DATABASE PERSISTENCE = NO");
    console.log("DOUBAO SAVE = PASS");
    console.log("SAFE METADATA RESPONSE = PASS");
    console.log("USER B CANNOT SEE USER A DOUBAO = PASS");
    console.log("USER B SAVED TEST ISOLATED = PASS");
    console.log("USER B DELETE CANNOT DELETE USER A = PASS");
    console.log("SAVED CREDENTIAL DECRYPT + VALIDATE = PASS");
    console.log("USER A DELETE = PASS");
    console.log("POST-DELETE SAVED TEST BLOCKED = PASS");
    console.log("FULL API KEY RETURNED = NO");
    console.log("CIPHERTEXT RETURNED = NO");
    console.log("IV RETURNED = NO");
    console.log("PROVIDER GENERATION REQUEST = YES");
    console.log("MINIMAL VALIDATION GENERATION = YES");
  } catch (error) {
    console.error(`DOUBAO LIVE TEST = FAIL AT ${currentStep}`);
    if (error instanceof SafeValidationFailure) {
      console.error(`EDGE HTTP STATUS = ${error.edgeHTTPStatus}`);
      if (error.validationStatus) {
        console.error(`VALIDATION STATUS = ${error.validationStatus}`);
      }
    }
    process.exitCode = 1;
  } finally {
    if (cleanPrecondition && saveAttempted && userA) {
      try {
        const remaining = await doubaoRows(userAClient, userA.user.id);
        if (remaining.length > 0) {
          const cleanup = await callCredentialFunction(userA.accessToken, {
            action: "delete",
            provider: "doubao",
          });
          ensure(cleanup.response.ok && cleanup.data?.ok === true, "cleanup delete failed");
        }
        ensure((await doubaoRows(userAClient, userA.user.id)).length === 0, "cleanup metadata verification failed");
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
      console.log("FINAL DOUBAO TEST CREDENTIAL REMAINS = NO");
      console.log("CLEANUP = PASS");
    }
    if (completed && cleanupFailure) process.exitCode = 1;
  }
}

await main();
