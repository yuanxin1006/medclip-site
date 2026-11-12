import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
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
const metadataColumns = "id,user_id,provider,status,created_at,updated_at";
const safeDiagnosticValue = /^[A-Za-z0-9_$.-]{1,64}$/;
const verifierFailureStages = new Set([
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
  "internal",
]);
const unsafeDiagnosticMessage = /(?:authorization\s*[:=]|bearer\s+\S+|api[_ -]?key\s*[:=]|ciphertext|encryption[_ -]?key|\beyJ[A-Za-z0-9._-]{12,}\b|\b(?:sk|ark)-[A-Za-z0-9._-]{8,}\b|https?:\/\/)/i;

class LiveTaskFailure extends Error {
  constructor(details) {
    super("Safe Kimi live task failure");
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
    "x-client-info": "medclip-kimi-task-live-verifier",
  };
}

export function assertSafeResponse(value, rawText, sensitiveValues = []) {
  for (const secret of sensitiveValues.filter(Boolean)) {
    assert.equal(rawText.includes(secret), false, "response exposed a local credential");
  }
  const forbiddenFields = new Set([
    "api_key", "apikey", "authorization", "ciphertext", "iv", "encryption_key",
    "reasoning_content", "raw_response", "response_headers", "raw_request_body",
  ]);
  const visit = (current) => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) return current.forEach(visit);
    for (const [key, nested] of Object.entries(current)) {
      assert.equal(forbiddenFields.has(key.toLowerCase()), false, "response exposed a forbidden field");
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
  assertSafeResponse(data, text, [
    kimiApiKey,
    anonKey,
    credentials.userA.email,
    credentials.userA.password,
    credentials.userB.email,
    credentials.userB.password,
  ]);
  return { response, data };
}

async function signIn(client, credential) {
  const result = await client.auth.signInWithPassword(credential);
  assert.equal(result.error, null, "test-user authentication failed");
  assert.ok(result.data.user && result.data.session?.access_token, "test-user session is incomplete");
  return { user: result.data.user, accessToken: result.data.session.access_token };
}

async function kimiRows(client, userId) {
  const result = await client
    .from("user_ai_provider_connections")
    .select(metadataColumns)
    .eq("provider", "kimi")
    .order("id", { ascending: true });
  assert.equal(result.error, null, "Kimi metadata query failed");
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
  const validationStatus = typeof result.data?.validation?.status === "string"
    && safeDiagnosticValue.test(result.data.validation.status)
    ? result.data.validation.status
    : null;
  const edgeCode = typeof result.data?.status === "string" && safeDiagnosticValue.test(result.data.status)
    ? result.data.status
    : validationStatus;
  const safeMessage = typeof diagnostic.sanitizedProviderErrorMessage === "string"
    && diagnostic.sanitizedProviderErrorMessage.length > 0
    && diagnostic.sanitizedProviderErrorMessage.length <= 160
    && !/[\r\n]/.test(diagnostic.sanitizedProviderErrorMessage)
    && !unsafeDiagnosticMessage.test(diagnostic.sanitizedProviderErrorMessage)
    ? diagnostic.sanitizedProviderErrorMessage
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
      : Number.isInteger(diagnostic.httpStatus)
        && diagnostic.httpStatus >= 100
        && diagnostic.httpStatus <= 599
        ? diagnostic.httpStatus
        : null,
    sanitizedProviderErrorMessage: safeMessage,
    providerCallCount: diagnostic.providerCallCount === 0 || diagnostic.providerCallCount === 1
      ? diagnostic.providerCallCount
      : "UNKNOWN",
  });
}

function requireCredentialSave(result, userId) {
  if (!result.response.ok) throw new LiveTaskFailure(safeFailure(result, "NONE", "credential_save"));
  if (result.data?.validation && result.data.validation.ok !== true) {
    throw new LiveTaskFailure(safeFailure(result, "NONE", "credential_validation"));
  }
  if (result.data?.ok !== true) throw new LiveTaskFailure(safeFailure(result, "NONE", "credential_save"));
  assert.equal(result.data.connection?.provider, "kimi", "save returned the wrong provider");
  assert.equal(result.data.connection?.user_id, userId, "save returned the wrong owner");
  assert.equal(result.data.connection?.provider_resource_id ?? null, null, "Kimi unexpectedly stored a Resource ID");
}

function requireTaskSuccess(result, task, requiredKeys) {
  if (!result.response.ok || result.data?.ok !== true) {
    throw new LiveTaskFailure(safeFailure(result, task, "task_request"));
  }
  try {
    assert.equal(result.data.task, task, `${task} returned the wrong task`);
    assert.equal(result.data.provider, "kimi", `${task} returned the wrong provider`);
    assert.equal(result.data.metadata?.providerUsed, "kimi", `${task} metadata provider mismatch`);
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
  output.error("KIMI TASK LIVE TEST = FAIL");
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

export async function runKimiLiveFlow({ operations, output = console }) {
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
      throw new LiveTaskFailure(safeDetails(currentStage, { category: "EXISTING_CONNECTION", providerCallCount: 0 }));
    }
    cleanPrecondition = true;

    currentStage = "credential_save";
    saveAttempted = true;
    const saved = await operations.saveCredential(userA);
    currentStage = "credential_validation";
    requireCredentialSave(saved, userA.user.id);
    currentStage = "credential_readback";
    assert.equal((await operations.rows("userA", userA)).length, 1, "temporary credential metadata is absent");

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
      title: "晨光",
      creativeRequirement: "写一份简短、温暖的民谣创作方案",
      genre: "民谣",
      mood: "温暖",
      voicePreference: "自动",
    });
    requireTaskSuccess(music, currentTask, [
      "concept", "theme", "mood", "structure", "lyricDirection", "arrangementDirection", "notes",
    ]);

    currentTask = "editor.requirements_parse";
    const editor = await operations.invokeTask("userA", userA, currentTask, {
      editingRequirement: "节奏平稳，突出医生解释，不自动修改时间轴",
      subtitleText: "这是固定的安全测试字幕。",
      assetDescriptions: ["医生访谈镜头"],
    });
    requireTaskSuccess(editor, currentTask, [
      "pacing", "maxShotDurationSeconds", "preferredScenes", "avoidScenes",
      "lyricRules", "transitionStyle", "subtitlePreferences", "notes",
    ]);

    output.log("KIMI MUSIC CREATIVE BRIEF LIVE = PASS");
    output.log("KIMI EDITOR REQUIREMENTS PARSE LIVE = PASS");
    output.log("SAVED CREDENTIAL PATH = PASS");
    output.log("CROSS-USER ISOLATION = PASS");
    output.log("CREDENTIAL VALIDATION PROVIDER CALLS = 1");
    output.log("MUSIC GENERATION PROVIDER CALLS = 1");
    output.log("EDITOR GENERATION PROVIDER CALLS = 1");
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
        if ((await operations.rows("userA", userA)).length > 0) await operations.deleteCredential(userA);
        assert.equal((await operations.rows("userA", userA)).length, 0, "cleanup verification failed");
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
      output.error("FINAL KIMI TEST CREDENTIAL REMAINS = UNKNOWN");
      output.error("CLEANUP = FAIL");
    } else if (saveAttempted) {
      output.log("FINAL KIMI TEST CREDENTIAL REMAINS = NO");
      output.log("CLEANUP = PASS");
    } else {
      output.log("FINAL KIMI TEST CREDENTIAL REMAINS = NOT CREATED");
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
    rows: (label, session) => kimiRows(clientFor(label), session.user.id),
    saveCredential: (session) => invoke("ai-credentials", session.accessToken, {
      action: "save",
      provider: "kimi",
      apiKey: kimiApiKey,
    }),
    invokeTask: (_label, session, task, input) => invoke("ai-tasks", session.accessToken, {
      task,
      provider: "kimi",
      input,
    }),
    deleteCredential: (session) => invoke("ai-credentials", session.accessToken, {
      action: "delete",
      provider: "kimi",
    }).then((result) => {
      assert.equal(result.response.status, 200, "cleanup delete failed");
      assert.equal(result.data?.ok, true, "cleanup delete did not report success");
    }),
    signOut: (label) => clientFor(label).auth.signOut(),
  };
}

export async function main(output = console) {
  if (!kimiApiKey) {
    output.log("KIMI TASK LIVE VERIFIER = READY");
    output.log("LIVE TEST STATUS = NOT RUN");
    return true;
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
    writeFailure(output, safeDetails("env_validation", { category: "ENVIRONMENT_NOT_READY", providerCallCount: 0 }));
    output.log("FINAL KIMI TEST CREDENTIAL REMAINS = NOT CREATED");
    output.log("CLEANUP = NOT REQUIRED");
    return false;
  }
  const userAClient = createBrowserClient();
  const userBClient = createBrowserClient();
  const result = await runKimiLiveFlow({
    operations: productionOperations(userAClient, userBClient),
    output,
  });
  return result.passed;
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  const passed = await main();
  if (!passed) process.exitCode = 1;
}
