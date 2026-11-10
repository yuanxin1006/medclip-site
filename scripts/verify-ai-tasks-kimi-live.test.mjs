import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeResponse, runKimiLiveFlow } from "./verify-ai-tasks-kimi-live.mjs";

const userA = { user: { id: "00000000-0000-4000-8000-000000000001" }, accessToken: "fixture-a" };
const userB = { user: { id: "00000000-0000-4000-8000-000000000002" }, accessToken: "fixture-b" };

function response(status, data) {
  return { response: { ok: status >= 200 && status < 300, status }, data };
}

function taskData(task) {
  const data = task === "music.creative_brief"
    ? {
        concept: "concept", theme: "theme", mood: "mood", structure: [],
        lyricDirection: [], arrangementDirection: [], notes: [],
      }
    : {
        pacing: "steady", maxShotDurationSeconds: 10, preferredScenes: [], avoidScenes: [],
        lyricRules: [], transitionStyle: "cut",
        subtitlePreferences: { style: "clear", placement: "bottom", timing: "aligned" }, notes: [],
      };
  return response(200, {
    ok: true,
    task,
    provider: "kimi",
    metadata: { providerUsed: "kimi", generationOccurred: true },
    result: { capability: "TEXT_REASONING", data },
  });
}

function outputCapture() {
  const lines = [];
  return {
    lines,
    output: { log: (value) => lines.push(String(value)), error: (value) => lines.push(String(value)) },
  };
}

function mockedOperations(failureStage = null) {
  let saved = false;
  let readbackCalls = 0;
  let providerCalls = 0;
  let cleanupCalls = 0;
  const operations = {
    async signIn(label) {
      if (failureStage === "test_user_setup" && label === "userB") throw new Error("fixture");
      return label === "userA" ? userA : userB;
    },
    async rows(label) {
      if (!saved && failureStage === "existing_connection_snapshot" && label === "userA") throw new Error("fixture");
      if (saved && label === "userA") {
        readbackCalls += 1;
        if (failureStage === "credential_readback" && readbackCalls === 1) throw new Error("fixture");
      }
      return saved && label === "userA" ? [{ provider: "kimi" }] : [];
    },
    async saveCredential() {
      saved = true;
      if (failureStage === "credential_save") throw new Error("fixture");
      return response(200, {
        ok: true,
        validation: { ok: failureStage !== "credential_validation", status: "VALID" },
        connection: { provider: "kimi", user_id: userA.user.id, provider_resource_id: null },
      });
    },
    async invokeTask(label, _session, task) {
      if (label === "userB") {
        if (failureStage === "cross_user_setup") throw new Error("fixture");
        return response(404, { ok: false, status: "NOT_CONNECTED" });
      }
      providerCalls += 1;
      if (failureStage === "task_request") throw new Error("fixture");
      return taskData(task);
    },
    async deleteCredential() {
      cleanupCalls += 1;
      saved = false;
    },
    async signOut() {},
  };
  return { operations, state: () => ({ saved, providerCalls, cleanupCalls }) };
}

test("Kimi live verifier completes one credential validation, two tasks, and cleanup", async () => {
  const mock = mockedOperations();
  const capture = outputCapture();
  const result = await runKimiLiveFlow({ operations: mock.operations, output: capture.output });
  assert.equal(result.passed, true);
  assert.deepEqual(mock.state(), { saved: false, providerCalls: 2, cleanupCalls: 1 });
  assert.ok(capture.lines.includes("CREDENTIAL VALIDATION PROVIDER CALLS = 1"));
  assert.ok(capture.lines.includes("MUSIC GENERATION PROVIDER CALLS = 1"));
  assert.ok(capture.lines.includes("EDITOR GENERATION PROVIDER CALLS = 1"));
  assert.ok(capture.lines.includes("CLEANUP = PASS"));
});

for (const failureStage of [
  "test_user_setup", "existing_connection_snapshot", "credential_save", "credential_validation",
  "credential_readback", "cross_user_setup", "task_request",
]) {
  test(`Kimi verifier failure at ${failureStage} remains bounded and cleans up`, async () => {
    const mock = mockedOperations(failureStage);
    const capture = outputCapture();
    const result = await runKimiLiveFlow({ operations: mock.operations, output: capture.output });
    assert.equal(result.passed, false);
    assert.equal(mock.state().saved, false);
    assert.ok(capture.lines.includes(`FAILURE STAGE = ${failureStage}`));
    assert.ok(mock.state().providerCalls <= 1);
  });
}

test("Kimi verifier reports safe 429 diagnostics without returning raw response or secrets", async () => {
  const mock = mockedOperations();
  mock.operations.invokeTask = async (label) => label === "userB"
    ? response(404, { ok: false, status: "NOT_CONNECTED" })
    : response(429, {
        ok: false,
        status: "PROVIDER_RATE_LIMIT",
        diagnostic: {
          provider: "kimi",
          failureStage: "provider_response",
          httpStatus: 429,
          providerErrorCode: "rate_limit_reached",
          sanitizedProviderErrorMessage: "Your account reached the requests-per-minute limit.",
          providerCallCount: 1,
        },
      });
  const capture = outputCapture();
  const result = await runKimiLiveFlow({ operations: mock.operations, output: capture.output });
  assert.equal(result.passed, false);
  assert.ok(capture.lines.includes("HTTP STATUS = 429"));
  assert.ok(capture.lines.includes("EDGE ERROR CODE = PROVIDER_RATE_LIMIT"));
  assert.ok(capture.lines.includes("PROVIDER ERROR CODE = rate_limit_reached"));
  assert.ok(capture.lines.includes("UPSTREAM HTTP STATUS = 429"));
  assert.ok(capture.lines.includes("SANITIZED PROVIDER ERROR MESSAGE = Your account reached the requests-per-minute limit."));
  assert.doesNotMatch(capture.lines.join("\n"), /fixture-a|fixture-b|raw_response|Authorization:/);
});

test("Kimi verifier rejects secret-bearing diagnostics and forbidden response fields", () => {
  assert.throws(() => assertSafeResponse(
    { diagnostic: { authorization: "Bearer not-real" } },
    '{"authorization":"Bearer not-real"}',
    ["not-real"],
  ));
});
