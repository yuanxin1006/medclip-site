import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeResponse,
  runDoubaoLiveFlow,
} from "./verify-ai-tasks-doubao-live.mjs";

const resourceId = "apikey-unit-test-resource";
const userA = { user: { id: "00000000-0000-4000-8000-000000000001" }, accessToken: "fixture-a" };
const userB = { user: { id: "00000000-0000-4000-8000-000000000002" }, accessToken: "fixture-b" };

function response(status, data) {
  return { response: { ok: status >= 200 && status < 300, status }, data };
}

function taskData(task) {
  const data = task === "music.creative_brief"
    ? {
        concept: "concept",
        theme: "theme",
        mood: "mood",
        structure: [],
        lyricDirection: [],
        arrangementDirection: [],
        notes: [],
      }
    : {
        pacing: "steady",
        maxShotDurationSeconds: 10,
        preferredScenes: [],
        avoidScenes: [],
        lyricRules: [],
        transitionStyle: "cut",
        subtitlePreferences: { style: "clear", placement: "bottom", timing: "aligned" },
        notes: [],
      };
  return response(200, {
    ok: true,
    task,
    provider: "doubao",
    metadata: { providerUsed: "doubao", generationOccurred: true },
    result: { capability: "TEXT_REASONING", data },
  });
}

function outputCapture() {
  const lines = [];
  return {
    lines,
    output: {
      log: (value) => lines.push(String(value)),
      error: (value) => lines.push(String(value)),
    },
  };
}

function mockedOperations(failureStage = null) {
  let saved = false;
  let readbackCalls = 0;
  let providerCalls = 0;
  let cleanupCalls = 0;
  const events = [];

  const operations = {
    async signIn(label) {
      events.push(`sign_in:${label}`);
      if (failureStage === "test_user_setup" && label === "userB") throw new Error("fixture");
      return label === "userA" ? userA : userB;
    },
    async rows(label) {
      events.push(`rows:${label}`);
      if (!saved && failureStage === "existing_connection_snapshot" && label === "userA") {
        throw new Error("fixture");
      }
      if (saved && label === "userA") {
        readbackCalls += 1;
        if (failureStage === "credential_readback" && readbackCalls === 1) throw new Error("fixture");
      }
      return saved && label === "userA"
        ? [{ provider_resource_id: resourceId, key_last4: "1234" }]
        : [];
    },
    async saveCredential() {
      events.push("credential_save");
      saved = true;
      if (failureStage === "credential_save") throw new Error("fixture");
      return response(200, {
        ok: true,
        validation: { ok: failureStage !== "credential_validation", status: "VALID" },
        connection: {
          provider: "doubao",
          user_id: userA.user.id,
          provider_resource_id: resourceId,
        },
      });
    },
    async invokeTask(label, _session, task) {
      events.push(`task:${label}:${task}`);
      if (label === "userB") {
        if (failureStage === "cross_user_setup") throw new Error("fixture");
        return response(404, { ok: false, status: "NOT_CONNECTED" });
      }
      providerCalls += 1;
      if (failureStage === "task_request") throw new Error("fixture");
      return taskData(task);
    },
    async deleteCredential() {
      events.push("credential_delete");
      cleanupCalls += 1;
      saved = false;
    },
    async signOut(label) {
      events.push(`sign_out:${label}`);
    },
  };

  return {
    operations,
    state: () => ({ saved, providerCalls, cleanupCalls, events }),
  };
}

test("credential responses may contain safe Doubao Resource ID metadata but task responses may not", () => {
  const payload = { connection: { provider_resource_id: resourceId } };
  const raw = JSON.stringify(payload);
  assert.throws(() => assertSafeResponse(payload, raw));
  assert.doesNotThrow(() => assertSafeResponse(payload, raw, { allowProviderResourceId: true }));
});

test("mocked Doubao live verifier completes save, readback, both tasks, and cleanup", async () => {
  const mock = mockedOperations();
  const capture = outputCapture();
  const result = await runDoubaoLiveFlow({
    operations: mock.operations,
    resourceId,
    keyLast4: "1234",
    output: capture.output,
  });
  const state = mock.state();
  assert.equal(result.passed, true);
  assert.equal(state.saved, false);
  assert.equal(state.cleanupCalls, 1);
  assert.equal(state.providerCalls, 2);
  assert.deepEqual(state.events.filter((event) => event === "credential_delete"), ["credential_delete"]);
  assert.ok(capture.lines.includes("FINAL DOUBAO TEST CREDENTIAL REMAINS = NO"));
  assert.ok(capture.lines.includes("CLEANUP = PASS"));
});

for (const failureStage of [
  "test_user_setup",
  "existing_connection_snapshot",
  "credential_save",
  "credential_validation",
  "credential_readback",
  "cross_user_setup",
  "task_request",
]) {
  test(`mocked pre-task failure reports ${failureStage} and leaves no verifier credential`, async () => {
    const mock = mockedOperations(failureStage);
    const capture = outputCapture();
    const result = await runDoubaoLiveFlow({
      operations: mock.operations,
      resourceId,
      keyLast4: "1234",
      output: capture.output,
    });
    const state = mock.state();
    assert.equal(result.passed, false);
    assert.equal(state.saved, false);
    assert.ok(capture.lines.includes(`FAILURE STAGE = ${failureStage}`));
    if (["credential_save", "credential_validation", "credential_readback", "cross_user_setup", "task_request"].includes(failureStage)) {
      assert.equal(state.cleanupCalls, 1);
      assert.ok(capture.lines.includes("FINAL DOUBAO TEST CREDENTIAL REMAINS = NO"));
      assert.ok(capture.lines.includes("CLEANUP = PASS"));
    } else {
      assert.equal(state.cleanupCalls, 0);
      assert.ok(capture.lines.includes("FINAL DOUBAO TEST CREDENTIAL REMAINS = NOT CREATED"));
      assert.ok(capture.lines.includes("CLEANUP = NOT REQUIRED"));
    }
    assert.ok(state.providerCalls <= 1);
  });
}

test("sanitized credential failure keeps only safe status and HTTP diagnostics", async () => {
  const mock = mockedOperations();
  mock.operations.saveCredential = async () => response(400, {
    ok: false,
    status: "PROVIDER_CONFIGURATION_REQUIRED",
    message: "safe",
  });
  const capture = outputCapture();
  const result = await runDoubaoLiveFlow({
    operations: mock.operations,
    resourceId,
    keyLast4: "1234",
    output: capture.output,
  });
  assert.equal(result.passed, false);
  assert.ok(capture.lines.includes("FAILURE STAGE = credential_save"));
  assert.ok(capture.lines.includes("SAFE ERROR CATEGORY = PROVIDER_CONFIGURATION_REQUIRED"));
  assert.ok(capture.lines.includes("HTTP STATUS = 400"));
  assert.doesNotMatch(capture.lines.join("\n"), /fixture-a|fixture-b|apikey-unit-test-resource/);
});

test("HTTP 200 provider validation failure is diagnosed as credential_validation", async () => {
  const mock = mockedOperations();
  mock.operations.saveCredential = async () => response(200, {
    ok: false,
    status: "PROVIDER_CONFIGURATION_REQUIRED",
    validation: {
      ok: false,
      provider: "doubao",
      status: "PROVIDER_CONFIGURATION_REQUIRED",
      diagnostic: {
        upstreamHttpStatus: 404,
        upstreamProviderErrorCode: "ModelNotOpen",
        sanitizedProviderErrorMessage: "The configured account has not activated this model.",
      },
    },
  });
  const capture = outputCapture();
  const result = await runDoubaoLiveFlow({
    operations: mock.operations,
    resourceId,
    keyLast4: "1234",
    output: capture.output,
  });
  assert.equal(result.passed, false);
  assert.ok(capture.lines.includes("FAILED TASK = NONE"));
  assert.ok(capture.lines.includes("FAILURE STAGE = credential_validation"));
  assert.ok(capture.lines.includes("SAFE ERROR CATEGORY = PROVIDER_CONFIGURATION_REQUIRED"));
  assert.ok(capture.lines.includes("HTTP STATUS = 200"));
  assert.ok(capture.lines.includes("PROVIDER ERROR CODE = ModelNotOpen"));
  assert.ok(capture.lines.includes("UPSTREAM HTTP STATUS = 404"));
  assert.ok(capture.lines.includes("SANITIZED PROVIDER ERROR MESSAGE = The configured account has not activated this model."));
  assert.ok(capture.lines.includes("FINAL DOUBAO TEST CREDENTIAL REMAINS = NO"));
  assert.ok(capture.lines.includes("CLEANUP = PASS"));
});
