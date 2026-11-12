import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const deepseekApiKey = process.env.MEDCLIP_TEST_DEEPSEEK_API_KEY;
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
const safeFailureStages = new Set([
  "provider_request",
  "provider_response",
  "json_parse",
  "schema_validation",
  "internal",
]);

class LiveTaskFailure extends Error {
  constructor(details) {
    super("Safe live task failure");
    this.name = "LiveTaskFailure";
    this.details = details;
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

function functionEndpoint(name) {
  return new URL(`/functions/v1/${name}`, new URL(projectUrl)).toString();
}

function requestHeaders(accessToken) {
  return {
    apikey: anonKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Origin: allowedOrigin,
    "x-client-info": "medclip-deepseek-task-live-verifier",
  };
}

function assertSafeResponse(value, rawText) {
  const sensitiveValues = [
    deepseekApiKey,
    anonKey,
    credentials.userA.email,
    credentials.userA.password,
    credentials.userB.email,
    credentials.userB.password,
  ].filter(Boolean);
  for (const secret of sensitiveValues) {
    assert.equal(rawText.includes(secret), false, "response exposed a local credential");
  }
  const forbiddenFields = new Set([
    "api_key", "apikey", "authorization", "ciphertext", "iv", "encryption_key",
    "reasoning_content", "raw_response", "response_headers",
  ]);
  const visit = (current) => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
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
  assertSafeResponse(data, text);
  return { response, data };
}

async function signIn(client, credential) {
  const result = await client.auth.signInWithPassword(credential);
  assert.equal(result.error, null, "test-user authentication failed");
  assert.ok(result.data.user && result.data.session?.access_token, "test-user session is incomplete");
  return {
    user: result.data.user,
    accessToken: result.data.session.access_token,
  };
}

async function deepseekRows(client, userId) {
  const result = await client
    .from("user_ai_provider_connections")
    .select(metadataColumns)
    .eq("provider", "deepseek")
    .order("id", { ascending: true });
  assert.equal(result.error, null, "DeepSeek metadata query failed");
  const rows = result.data ?? [];
  assert.equal(rows.every((row) => row.user_id === userId), true, "metadata crossed user ownership");
  return rows;
}

function requireTaskSuccess(result, task, requiredKeys) {
  const diagnostic = result.data?.diagnostic && typeof result.data.diagnostic === "object"
    ? result.data.diagnostic
    : {};
  if (!result.response.ok || result.data?.ok !== true) {
    const category = typeof result.data?.status === "string" && safeDiagnosticValue.test(result.data.status)
      ? result.data.status
      : "INTERNAL_TASK_ERROR";
    const failureStage = typeof diagnostic.failureStage === "string" && safeFailureStages.has(diagnostic.failureStage)
      ? diagnostic.failureStage
      : "internal";
    const httpStatus = Number.isInteger(diagnostic.httpStatus) && diagnostic.httpStatus >= 100 && diagnostic.httpStatus <= 599
      ? diagnostic.httpStatus
      : null;
    const providerErrorCode = typeof diagnostic.providerErrorCode === "string" && safeDiagnosticValue.test(diagnostic.providerErrorCode)
      ? diagnostic.providerErrorCode
      : null;
    const safeFields = (value) => Array.isArray(value)
      ? value.filter((field) => typeof field === "string" && safeDiagnosticValue.test(field)).slice(0, 20)
      : [];
    const providerCallCount = diagnostic.providerCallCount === 0 || diagnostic.providerCallCount === 1
      ? diagnostic.providerCallCount
      : "UNKNOWN";
    throw new LiveTaskFailure({
      task,
      failureStage,
      category,
      httpStatus,
      providerErrorCode,
      providerCallCount,
      missingFields: safeFields(diagnostic.missingFields),
      invalidFields: safeFields(diagnostic.invalidFields),
    });
  }

  try {
    assert.equal(result.data.task, task, `${task} returned the wrong task`);
    assert.equal(result.data.provider, "deepseek", `${task} returned the wrong provider`);
    assert.equal(result.data.metadata?.providerUsed, "deepseek", `${task} metadata provider mismatch`);
    assert.equal(result.data.metadata?.generationOccurred, true, `${task} did not report generation`);
    assert.equal(result.data.result?.capability, "TEXT_REASONING", `${task} capability mismatch`);
    assert.ok(result.data.result?.data && typeof result.data.result.data === "object", `${task} result is absent`);
    assert.deepEqual(Object.keys(result.data.result.data).sort(), [...requiredKeys].sort(), `${task} result shape mismatch`);
  } catch {
    throw new LiveTaskFailure({
      task,
      failureStage: "internal",
      category: "INTERNAL_TASK_ERROR",
      httpStatus: null,
      providerErrorCode: null,
      providerCallCount: 1,
      missingFields: [],
      invalidFields: [],
    });
  }
}

async function main() {
  if (!deepseekApiKey) {
    console.log("DEEPSEEK LIVE VERIFIER = READY");
    console.log("LIVE TEST STATUS = NOT RUN");
    return;
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
    console.error("DEEPSEEK LIVE VERIFIER = NOT READY");
    process.exitCode = 1;
    return;
  }

  const userAClient = createBrowserClient();
  const userBClient = createBrowserClient();
  let userA = null;
  let userB = null;
  let cleanPrecondition = false;
  let saveAttempted = false;
  let cleanupFailure = false;
  let currentStep = "authentication";
  let currentTask = null;

  try {
    userA = await signIn(userAClient, credentials.userA);
    userB = await signIn(userBClient, credentials.userB);

    currentStep = "clean precondition";
    const [initialA, initialB] = await Promise.all([
      deepseekRows(userAClient, userA.user.id),
      deepseekRows(userBClient, userB.user.id),
    ]);
    if (initialA.length || initialB.length) {
      console.error("DEEPSEEK TASK LIVE TEST = BLOCKED - EXISTING CONNECTION");
      process.exitCode = 1;
      return;
    }
    cleanPrecondition = true;

    currentStep = "temporary credential save";
    saveAttempted = true;
    const saved = await invoke("ai-credentials", userA.accessToken, {
      action: "save",
      provider: "deepseek",
      apiKey: deepseekApiKey,
    });
    assert.equal(saved.response.status, 200, "temporary credential save failed");
    assert.equal(saved.data?.ok, true, "temporary credential was not saved");
    assert.equal((await deepseekRows(userAClient, userA.user.id)).length, 1, "temporary credential metadata is absent");

    currentStep = "cross-user isolation";
    const userBTask = await invoke("ai-tasks", userB.accessToken, {
      task: "music.creative_brief",
      provider: "deepseek",
      input: { creativeRequirement: "fixed isolation test" },
    });
    assert.equal(userBTask.response.status, 404, "User B unexpectedly reached User A credential");
    assert.equal(userBTask.data?.status, "NOT_CONNECTED", "User B did not receive NOT_CONNECTED");
    assert.equal((await deepseekRows(userAClient, userA.user.id)).length, 1, "User B affected User A credential");

    currentStep = "music creative brief";
    currentTask = "music.creative_brief";
    const music = await invoke("ai-tasks", userA.accessToken, {
      task: "music.creative_brief",
      provider: "deepseek",
      input: {
        title: "晨光",
        creativeRequirement: "写一份简短、温暖的民谣创作方案",
        genre: "民谣",
        mood: "温暖",
        voicePreference: "自动",
      },
    });
    requireTaskSuccess(music, "music.creative_brief", [
      "concept", "theme", "mood", "structure", "lyricDirection",
      "arrangementDirection", "notes",
    ]);

    currentStep = "editor requirements parse";
    currentTask = "editor.requirements_parse";
    const editor = await invoke("ai-tasks", userA.accessToken, {
      task: "editor.requirements_parse",
      provider: "deepseek",
      input: {
        editingRequirement: "节奏平稳，突出医生解释，不自动修改时间轴",
        subtitleText: "这是固定的安全测试字幕。",
        assetDescriptions: ["医生访谈镜头"],
      },
    });
    requireTaskSuccess(editor, "editor.requirements_parse", [
      "pacing", "maxShotDurationSeconds", "preferredScenes", "avoidScenes",
      "lyricRules", "transitionStyle", "subtitlePreferences", "notes",
    ]);

    console.log("DEEPSEEK MUSIC CREATIVE BRIEF LIVE = PASS");
    console.log("DEEPSEEK EDITOR REQUIREMENTS PARSE LIVE = PASS");
    console.log("SAVED CREDENTIAL PATH = PASS");
    console.log("CROSS-USER ISOLATION = PASS");
    console.log("PROVIDER GENERATION CALLS = 2");
    console.log("AUTOMATIC RETRY = 0");
    console.log("FULL API KEY RETURNED = NO");
    console.log("REASONING CONTENT RETURNED = NO");
    console.log("RAW PROVIDER RESPONSE RETURNED = NO");
  } catch (error) {
    const details = error instanceof LiveTaskFailure
      ? error.details
      : {
          task: currentTask ?? "NONE",
          failureStage: "internal",
          category: "INTERNAL_TASK_ERROR",
          httpStatus: null,
          providerErrorCode: null,
          providerCallCount: "UNKNOWN",
          missingFields: [],
          invalidFields: [],
        };
    console.error("DEEPSEEK TASK LIVE TEST = FAIL");
    console.error(`FAILED TASK = ${details.task}`);
    console.error(`FAILURE STAGE = ${details.failureStage}`);
    console.error(`SAFE ERROR CATEGORY = ${details.category}`);
    console.error(`HTTP STATUS = ${details.httpStatus ?? "UNKNOWN"}`);
    console.error(`PROVIDER ERROR CODE = ${details.providerErrorCode ?? "NONE"}`);
    if (details.missingFields.length) {
      console.error(`MISSING FIELDS = ${JSON.stringify(details.missingFields)}`);
    }
    if (details.invalidFields.length) {
      console.error(`INVALID FIELDS = ${JSON.stringify(details.invalidFields)}`);
    }
    console.error(`PROVIDER CALL COUNT = ${details.providerCallCount}`);
    console.error("AUTOMATIC RETRY = 0");
    process.exitCode = 1;
  } finally {
    if (cleanPrecondition && saveAttempted && userA) {
      try {
        if ((await deepseekRows(userAClient, userA.user.id)).length > 0) {
          const deleted = await invoke("ai-credentials", userA.accessToken, {
            action: "delete",
            provider: "deepseek",
          });
          assert.equal(deleted.response.status, 200, "cleanup delete failed");
          assert.equal(deleted.data?.ok, true, "cleanup delete did not report success");
        }
        assert.equal((await deepseekRows(userAClient, userA.user.id)).length, 0, "cleanup verification failed");
      } catch {
        cleanupFailure = true;
        process.exitCode = 1;
        console.error("SECURITY CLEANUP FAILURE");
      }
    }
    await Promise.allSettled([userAClient.auth.signOut(), userBClient.auth.signOut()]);
    if (cleanPrecondition && saveAttempted && !cleanupFailure) {
      console.log("FINAL DEEPSEEK TEST CREDENTIAL REMAINS = NO");
      console.log("CLEANUP = PASS");
    }
  }
}

await main();
