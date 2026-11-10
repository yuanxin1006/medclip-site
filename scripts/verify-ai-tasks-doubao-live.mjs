import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
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
const metadataColumns = [
  "id",
  "user_id",
  "provider",
  "provider_resource_id",
  "key_last4",
  "status",
  "created_at",
  "updated_at",
].join(",");
const safeDiagnosticValue = /^[A-Za-z0-9_$.-]{1,64}$/;
const unsafeDiagnosticMessage = /(?:Bearer\s+\S+|\b(?:sk|ark)-[A-Za-z0-9._-]{8,}\b|\bAIza[A-Za-z0-9_-]{8,}\b|\beyJ[A-Za-z0-9._-]{12,}\b)/i;

export const verifierFailureStages = new Set([
  "env_validation",
  "test_user_setup",
  "existing_connection_snapshot",
  "credential_save",
  "credential_validation",
  "credential_readback",
  "cross_user_setup",
  "task_request",
  "provider_request",
  "provider_response",
  "json_parse",
  "schema_validation",
  "cleanup",
]);

export class LiveTaskFailure extends Error {
  constructor(details) {
    super("Safe live task failure");
    this.name = "LiveTaskFailure";
    this.details = details;
  }
}

function safeDetails(stage, overrides = {}) {
  return {
    task: "NONE",
    failureStage: verifierFailureStages.has(stage) ? stage : "task_request",
    category: "INTERNAL_TASK_ERROR",
    httpStatus: null,
    edgeErrorCode: null,
    providerErrorCode: null,
    upstreamHttpStatus: null,
    sanitizedProviderErrorMessage: null,
    providerCallCount: "UNKNOWN",
    ...overrides,
  };
}

function createBrowserClient() {
  return createClient(projectUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function functionEndpoint(name) {
  return new URL(`/functions/v1/${name}`, new URL(projectUrl)).toString();
}

function requestHeaders(accessToken) {
  return {
    apikey: anonKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Origin: allowedOrigin,
    "x-client-info": "medclip-doubao-task-live-verifier",
  };
}

export function assertSafeResponse(
  value,
  rawText,
  { allowProviderResourceId = false, sensitiveValues = [] } = {},
) {
  for (const secret of sensitiveValues.filter(Boolean)) {
    assert.equal(rawText.includes(secret), false, "response exposed a local credential");
  }
  const forbiddenFields = new Set([
    "api_key",
    "apikey",
    "authorization",
    "ciphertext",
    "iv",
    "encryption_key",
    "reasoning_content",
    "raw_response",
    "response_headers",
  ]);
  const visit = (current) => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) return current.forEach(visit);
    for (const [key, nested] of Object.entries(current)) {
      const normalizedKey = key.toLowerCase();
      assert.equal(forbiddenFields.has(normalizedKey), false, "response exposed a forbidden field");
      if (normalizedKey === "provider_resource_id") {
        assert.equal(
          allowProviderResourceId,
          true,
          "task response exposed provider resource metadata",
        );
      }
      visit(nested);
    }
  };
  visit(value);
}

async function invoke(name, accessToken, body) {
  const response = await fetch(functionEndpoint(name), {
    method: "POST",
    headers: requestHeaders(accessToken),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${name} returned a non-JSON response`);
  }
  assertSafeResponse(data, text, {
    allowProviderResourceId: name === "ai-credentials",
    sensitiveValues: [
      doubaoApiKey,
      anonKey,
      credentials.userA.email,
      credentials.userA.password,
      credentials.userB.email,
      credentials.userB.password,
    ],
  });
  return { response, data };
}

async function signIn(client, credential) {
  const result = await client.auth.signInWithPassword(credential);
  assert.equal(result.error, null, "test-user authentication failed");
  assert.ok(result.data.user && result.data.session?.access_token, "test-user session is incomplete");
  return { user: result.data.user, accessToken: result.data.session.access_token };
}

async function doubaoRows(client, userId) {
  const result = await client
    .from("user_ai_provider_connections")
    .select(metadataColumns)
    .eq("provider", "doubao")
    .order("id", { ascending: true });
  assert.equal(result.error, null, "Doubao metadata query failed");
  const rows = result.data ?? [];
  assert.equal(rows.every((row) => row.user_id === userId), true, "metadata crossed user ownership");
  return rows;
}

function safeFailure(result, task, fallbackStage) {
  const validationDiagnostic = result.data?.validation?.diagnostic;
  const responseDiagnostic = result.data?.diagnostic;
  const diagnostic = validationDiagnostic && typeof validationDiagnostic === "object"
    ? validationDiagnostic
    : responseDiagnostic && typeof responseDiagnostic === "object"
      ? responseDiagnostic
      : {};
  const edgeCode = typeof result.data?.status === "string" && safeDiagnosticValue.test(result.data.status)
    ? result.data.status
    : null;
  return safeDetails(fallbackStage, {
    task,
    failureStage: typeof diagnostic.failureStage === "string" && verifierFailureStages.has(diagnostic.failureStage)
      ? diagnostic.failureStage
      : fallbackStage,
    category: edgeCode ?? "INTERNAL_TASK_ERROR",
    httpStatus: Number.isInteger(result.response?.status) ? result.response.status : null,
    edgeErrorCode: edgeCode,
    providerErrorCode: typeof diagnostic.providerErrorCode === "string" && safeDiagnosticValue.test(diagnostic.providerErrorCode)
      ? diagnostic.providerErrorCode
      : typeof diagnostic.upstreamProviderErrorCode === "string" && safeDiagnosticValue.test(diagnostic.upstreamProviderErrorCode)
        ? diagnostic.upstreamProviderErrorCode
        : null,
    upstreamHttpStatus: Number.isInteger(diagnostic.upstreamHttpStatus)
      && diagnostic.upstreamHttpStatus >= 100
      && diagnostic.upstreamHttpStatus <= 599
      ? diagnostic.upstreamHttpStatus
      : null,
    sanitizedProviderErrorMessage: typeof diagnostic.sanitizedProviderErrorMessage === "string"
      && diagnostic.sanitizedProviderErrorMessage.length > 0
      && diagnostic.sanitizedProviderErrorMessage.length <= 160
      && !/[\r\n]/.test(diagnostic.sanitizedProviderErrorMessage)
      && !unsafeDiagnosticMessage.test(diagnostic.sanitizedProviderErrorMessage)
      ? diagnostic.sanitizedProviderErrorMessage
      : null,
    providerCallCount: diagnostic.providerCallCount === 0 || diagnostic.providerCallCount === 1
      ? diagnostic.providerCallCount
      : "UNKNOWN",
  });
}

function requireCredentialSave(result, resourceId, userId) {
  if (!result.response.ok) {
    throw new LiveTaskFailure(safeFailure(result, "NONE", "credential_save"));
  }
  if (result.data?.validation && result.data.validation.ok !== true) {
    throw new LiveTaskFailure(safeFailure(result, "NONE", "credential_validation"));
  }
  if (result.data?.ok !== true) {
    throw new LiveTaskFailure(safeFailure(result, "NONE", "credential_save"));
  }
  assert.equal(result.data.connection?.provider, "doubao", "save returned the wrong provider");
  assert.equal(result.data.connection?.user_id, userId, "save returned the wrong owner");
  assert.equal(
    result.data.connection?.provider_resource_id,
    resourceId,
    "save returned the wrong API-Key Resource ID",
  );
}

export function requireTaskSuccess(result, task, requiredKeys) {
  if (!result.response.ok || result.data?.ok !== true) {
    throw new LiveTaskFailure(safeFailure(result, task, "task_request"));
  }
  try {
    assert.equal(result.data.task, task, `${task} returned the wrong task`);
    assert.equal(result.data.provider, "doubao", `${task} returned the wrong provider`);
    assert.equal(result.data.metadata?.providerUsed, "doubao", `${task} metadata provider mismatch`);
    assert.equal(result.data.metadata?.generationOccurred, true, `${task} did not report generation`);
    assert.equal(result.data.result?.capability, "TEXT_REASONING", `${task} capability mismatch`);
    assert.ok(result.data.result?.data && typeof result.data.result.data === "object", `${task} result is absent`);
    assert.deepEqual(Object.keys(result.data.result.data).sort(), [...requiredKeys].sort(), `${task} result shape mismatch`);
  } catch {
    throw new LiveTaskFailure(safeDetails("schema_validation", {
      task,
      category: "INTERNAL_TASK_ERROR",
      providerCallCount: 1,
    }));
  }
}

function writeFailure(output, details) {
  output.error("DOUBAO TASK LIVE TEST = FAIL");
  output.error(`FAILED TASK = ${details.task}`);
  output.error(`FAILURE STAGE = ${details.failureStage}`);
  output.error(`SAFE ERROR CATEGORY = ${details.category}`);
  output.error(`HTTP STATUS = ${details.httpStatus ?? "UNKNOWN"}`);
  output.error(`EDGE ERROR CODE = ${details.edgeErrorCode ?? "NONE"}`);
  output.error(`PROVIDER ERROR CODE = ${details.providerErrorCode ?? "NONE"}`);
  output.error(`UPSTREAM HTTP STATUS = ${details.upstreamHttpStatus ?? "UNKNOWN"}`);
  output.error(`SANITIZED PROVIDER ERROR MESSAGE = ${details.sanitizedProviderErrorMessage ?? "NONE"}`);
  output.error(`PROVIDER CALL COUNT = ${details.providerCallCount}`);
  output.error("AUTOMATIC RETRY = 0");
}

export async function runDoubaoLiveFlow({ operations, resourceId, keyLast4, output = console }) {
  let userA = null;
  let userB = null;
  let cleanPrecondition = false;
  let saveAttempted = false;
  let cleanupFailure = false;
  let failure = null;
  let currentStage = "test_user_setup";
  let currentTask = "NONE";

  try {
    userA = await operations.signIn("userA");
    userB = await operations.signIn("userB");

    currentStage = "existing_connection_snapshot";
    const [initialA, initialB] = await Promise.all([
      operations.rows("userA", userA),
      operations.rows("userB", userB),
    ]);
    if (initialA.length || initialB.length) {
      throw new LiveTaskFailure(safeDetails(currentStage, {
        category: "EXISTING_CONNECTION",
        providerCallCount: 0,
      }));
    }
    cleanPrecondition = true;

    currentStage = "credential_save";
    saveAttempted = true;
    const saved = await operations.saveCredential(userA);

    currentStage = "credential_validation";
    requireCredentialSave(saved, resourceId, userA.user.id);

    currentStage = "credential_readback";
    const savedRows = await operations.rows("userA", userA);
    assert.equal(savedRows.length, 1, "temporary credential metadata is absent");
    assert.equal(savedRows[0].provider_resource_id, resourceId, "temporary resource ID mismatch");
    if (keyLast4) assert.equal(savedRows[0].key_last4, keyLast4, "temporary key suffix mismatch");

    currentStage = "cross_user_setup";
    const userBTask = await operations.invokeTask("userB", userB, "music.creative_brief", {
      creativeRequirement: "fixed isolation test",
    });
    assert.equal(userBTask.response.status, 404, "User B unexpectedly reached User A credential");
    assert.equal(userBTask.data?.status, "NOT_CONNECTED", "User B did not receive NOT_CONNECTED");
    assert.equal((await operations.rows("userA", userA)).length, 1, "User B affected User A credential");

    currentStage = "task_request";
    currentTask = "music.creative_brief";
    const music = await operations.invokeTask("userA", userA, currentTask, {
      title: "\u6668\u5149",
      creativeRequirement: "\u5199\u4e00\u4efd\u7b80\u77ed\u3001\u6e29\u6696\u7684\u6c11\u8c23\u521b\u4f5c\u65b9\u6848",
      genre: "\u6c11\u8c23",
      mood: "\u6e29\u6696",
      voicePreference: "\u81ea\u52a8",
    });
    requireTaskSuccess(music, currentTask, [
      "concept", "theme", "mood", "structure", "lyricDirection",
      "arrangementDirection", "notes",
    ]);

    currentTask = "editor.requirements_parse";
    const editor = await operations.invokeTask("userA", userA, currentTask, {
      editingRequirement: "\u8282\u594f\u5e73\u7a33\uff0c\u7a81\u51fa\u533b\u751f\u89e3\u91ca\uff0c\u4e0d\u81ea\u52a8\u4fee\u6539\u65f6\u95f4\u8f74",
      subtitleText: "\u8fd9\u662f\u56fa\u5b9a\u7684\u5b89\u5168\u6d4b\u8bd5\u5b57\u5e55\u3002",
      assetDescriptions: ["\u533b\u751f\u8bbf\u8c08\u955c\u5934"],
    });
    requireTaskSuccess(editor, currentTask, [
      "pacing", "maxShotDurationSeconds", "preferredScenes", "avoidScenes",
      "lyricRules", "transitionStyle", "subtitlePreferences", "notes",
    ]);

    output.log("DOUBAO MUSIC CREATIVE BRIEF LIVE = PASS");
    output.log("DOUBAO EDITOR REQUIREMENTS PARSE LIVE = PASS");
    output.log("SAVED CREDENTIAL PATH = PASS");
    output.log("CROSS-USER ISOLATION = PASS");
    output.log("PROVIDER TASK GENERATION CALLS = 2");
    output.log("AUTOMATIC RETRY = 0");
    output.log("FULL API KEY RETURNED = NO");
    output.log("REASONING CONTENT RETURNED = NO");
    output.log("RAW PROVIDER RESPONSE RETURNED = NO");
  } catch (error) {
    failure = error instanceof LiveTaskFailure
      ? error.details
      : safeDetails(currentStage, { task: currentTask });
    writeFailure(output, failure);
  } finally {
    if (cleanPrecondition && saveAttempted && userA) {
      try {
        const remaining = await operations.rows("userA", userA);
        if (remaining.length > 0) await operations.deleteCredential(userA);
        assert.equal(
          (await operations.rows("userA", userA)).length,
          0,
          "cleanup verification failed",
        );
      } catch {
        cleanupFailure = true;
        output.error("SECURITY CLEANUP FAILURE");
      }
    }

    await Promise.allSettled([
      userA ? operations.signOut("userA", userA) : Promise.resolve(),
      userB ? operations.signOut("userB", userB) : Promise.resolve(),
    ]);

    if (cleanupFailure) {
      output.error("FINAL DOUBAO TEST CREDENTIAL REMAINS = UNKNOWN");
      output.error("CLEANUP = FAIL");
    } else if (saveAttempted) {
      output.log("FINAL DOUBAO TEST CREDENTIAL REMAINS = NO");
      output.log("CLEANUP = PASS");
    } else {
      output.log("FINAL DOUBAO TEST CREDENTIAL REMAINS = NOT CREATED");
      output.log("CLEANUP = NOT REQUIRED");
    }
  }

  return { passed: failure === null && !cleanupFailure, failure, cleanupFailure, saveAttempted };
}

function productionOperations(userAClient, userBClient) {
  const clientFor = (label) => label === "userA" ? userAClient : userBClient;
  const credentialFor = (label) => label === "userA" ? credentials.userA : credentials.userB;
  return {
    signIn: (label) => signIn(clientFor(label), credentialFor(label)),
    rows: (label, session) => doubaoRows(clientFor(label), session.user.id),
    saveCredential: (session) => invoke("ai-credentials", session.accessToken, {
      action: "save",
      provider: "doubao",
      apiKey: doubaoApiKey,
      providerResourceId: doubaoResourceId,
    }),
    invokeTask: (_label, session, task, input) => invoke("ai-tasks", session.accessToken, {
      task,
      provider: "doubao",
      input,
    }),
    deleteCredential: (session) => invoke("ai-credentials", session.accessToken, {
      action: "delete",
      provider: "doubao",
    }).then((result) => {
      assert.equal(result.response.status, 200, "cleanup delete failed");
      assert.equal(result.data?.ok, true, "cleanup delete did not report success");
    }),
    signOut: (label) => clientFor(label).auth.signOut(),
  };
}

export async function main(output = console) {
  if (!doubaoApiKey || !doubaoResourceId) {
    output.log("DOUBAO TASK LIVE VERIFIER = READY");
    output.log("LIVE TEST STATUS = NOT RUN");
    return true;
  }

  if (!apiKeyResourceIdPattern.test(doubaoResourceId)) {
    writeFailure(output, safeDetails("env_validation", {
      category: "PROVIDER_CONFIGURATION_REQUIRED",
      providerCallCount: 0,
    }));
    output.error("API KEY RESOURCE ID FORMAT = INVALID");
    output.log("FINAL DOUBAO TEST CREDENTIAL REMAINS = NOT CREATED");
    output.log("CLEANUP = NOT REQUIRED");
    return false;
  }

  const requiredEnvironment = [
    projectUrl,
    anonKey,
    credentials.userA.email,
    credentials.userA.password,
    credentials.userB.email,
    credentials.userB.password,
  ];
  if (requiredEnvironment.some((value) => !value)) {
    writeFailure(output, safeDetails("env_validation", {
      category: "ENVIRONMENT_NOT_READY",
      providerCallCount: 0,
    }));
    output.log("FINAL DOUBAO TEST CREDENTIAL REMAINS = NOT CREATED");
    output.log("CLEANUP = NOT REQUIRED");
    return false;
  }

  const userAClient = createBrowserClient();
  const userBClient = createBrowserClient();
  const result = await runDoubaoLiveFlow({
    operations: productionOperations(userAClient, userBClient),
    resourceId: doubaoResourceId,
    keyLast4: doubaoApiKey.slice(-4),
    output,
  });
  return result.passed;
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  const passed = await main();
  if (!passed) process.exitCode = 1;
}
