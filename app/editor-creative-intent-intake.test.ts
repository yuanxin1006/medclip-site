import assert from "node:assert/strict";
import test from "node:test";
import { parseCreativeIntentModelOutputV1 } from "./editor-creative-intent-intake.ts";
import { CreativeIntentValidationError } from "./editor-creative-intent.ts";
import { validateEditorCreativeIntentPlan } from "../supabase/functions/_shared/ai-tasks/editor-creative-intent-plan.ts";
import { createDeepSeekTextTaskExecutor, DEEPSEEK_TASK_MODEL } from "../supabase/functions/_shared/ai-tasks/providers/deepseek.ts";
import { createKimiTextTaskExecutor, KIMI_TASK_MODEL } from "../supabase/functions/_shared/ai-tasks/providers/kimi.ts";
import { createDoubaoTextTaskExecutor, DOUBAO_TASK_MODEL } from "../supabase/functions/_shared/ai-tasks/providers/doubao.ts";
import type { AITaskExecutionContext } from "../supabase/functions/_shared/ai-tasks/types.ts";

const sourceRequest = "帮我把视频剪成30秒，节奏轻快一点，但是必须保留老师完整讲话，最后学校Logo不能删除。";
const provenance = (sourceReference: string, authority: "MODEL_SUGGESTION" | "MODEL_UNCERTAIN_INFERENCE" = "MODEL_SUGGESTION") => ({ schemaVersion: 1, authority, sourceReference });
function modelOutput() {
  return { schemaVersion: 1, sourceRequest, clauses: [
    { kind: "GOAL", payload: { type: "TARGET_DURATION", durationMs: 30_000, policy: "TARGET" }, provenance: provenance("剪成30秒") },
    { kind: "SOFT_PREFERENCE", payload: { type: "PACE", value: "UPBEAT" }, provenance: provenance("节奏轻快一点") },
    { kind: "HARD_CONSTRAINT_REQUEST", payload: { type: "PROTECT_TIME_RANGE", reference: { schemaVersion: 1, state: "UNRESOLVED_REFERENCE", semanticKind: "SPEECH", referenceText: "老师完整讲话" } }, provenance: provenance("必须保留老师完整讲话", "MODEL_UNCERTAIN_INFERENCE") },
    { kind: "HARD_CONSTRAINT_REQUEST", payload: { type: "PRESERVE_ENDING", reference: { schemaVersion: 1, state: "UNRESOLVED_REFERENCE", semanticKind: "VISUAL_OBJECT", referenceText: "最后学校Logo" } }, provenance: provenance("最后学校Logo不能删除", "MODEL_UNCERTAIN_INFERENCE") },
  ] };
}

test("intent intake A-F preserves source, goal, preference, and unresolved protections in strict CreativeIntentV1", () => {
  const intent = parseCreativeIntentModelOutputV1({ modelOutput: modelOutput(), projectId: "project-campus", sourceRequest, createdAt: "2026-10-25T01:00:00.000Z" });
  assert.equal(intent.sourceRequest, sourceRequest);
  assert.equal(intent.groundingState, "UNRESOLVED_REFERENCE");
  assert.equal(intent.clauses.find((item) => item.kind === "GOAL")?.payload.durationMs, 30_000);
  assert.equal(intent.clauses.find((item) => item.kind === "SOFT_PREFERENCE")?.payload.value, "UPBEAT");
  const hard = intent.clauses.filter((item) => item.kind === "HARD_CONSTRAINT_REQUEST");
  assert.deepEqual(hard.map((item) => item.payload.reference.referenceText), ["老师完整讲话", "最后学校Logo"]);
  assert.equal(hard.every((item) => item.payload.reference.state === "UNRESOLVED_REFERENCE"), true);
  assert.equal(hard.every((item) => item.provenance.authority === "MODEL_UNCERTAIN_INFERENCE"), true);
});
test("intent intake G rejects every model-provided trusted identity, range, binding, and active state", () => {
  for (const [field, value] of [
    ["clipId", "clip-teacher"],
    ["assetId", "asset-teacher"],
    ["captionId", "caption-teacher"],
    ["range", { schemaVersion: 1, coordinateSpace: "TIMELINE", startMs: 0, endMs: 35_000 }],
    ["binding", { bindingType: "CLIP", clipId: "clip-teacher" }],
  ] as const) {
    const withTrustedField = structuredClone(modelOutput()) as Record<string, unknown>;
    (withTrustedField.clauses as Array<Record<string, unknown>>)[2][field] = value;
    assert.throws(() => parseCreativeIntentModelOutputV1({ modelOutput: withTrustedField, projectId: "project-campus", sourceRequest, createdAt: "2026-10-25T01:00:00.000Z" }), /unknown fields/);
  }
  const withActive = structuredClone(modelOutput()) as Record<string, unknown>;
  (((withActive.clauses as Array<Record<string, unknown>>)[2].payload as Record<string, unknown>)).state = "ACTIVE_HARD_CONSTRAINT";
  assert.throws(() => parseCreativeIntentModelOutputV1({ modelOutput: withActive, projectId: "project-campus", sourceRequest, createdAt: "2026-10-25T01:00:00.000Z" }), CreativeIntentValidationError);
});
test("intent intake H/I rejects malformed provider output, unknown schema, and changed source", () => {
  const mismatch = (missing: readonly string[], invalid: readonly string[]): never => { throw new Error(`schema:${missing.join(",")}:${invalid.join(",")}`); };
  assert.throws(() => validateEditorCreativeIntentPlan({ schemaVersion: 1 }, mismatch, sourceRequest), /schema/);
  assert.throws(() => parseCreativeIntentModelOutputV1({ modelOutput: { ...modelOutput(), schemaVersion: 2 }, projectId: "project-campus", sourceRequest, createdAt: "2026-10-25T01:00:00.000Z" }), /unsupported schema/);
  assert.throws(() => parseCreativeIntentModelOutputV1({ modelOutput: { ...modelOutput(), sourceRequest: "changed" }, projectId: "project-campus", sourceRequest, createdAt: "2026-10-25T01:00:00.000Z" }), /preserve the exact source request/);
});

test("DeepSeek, Kimi, and Doubao reuse the shared non-executable intent contract with mocked network only", async () => {
  const providers = [
    { provider: "deepseek" as const, model: DEEPSEEK_TASK_MODEL, create: createDeepSeekTextTaskExecutor },
    { provider: "kimi" as const, model: KIMI_TASK_MODEL, create: createKimiTextTaskExecutor },
    { provider: "doubao" as const, model: DOUBAO_TASK_MODEL, create: createDoubaoTextTaskExecutor },
  ];
  for (const item of providers) {
    let calls = 0;
    const executor = item.create(async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(modelOutput()) } }], usage: {} }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const context: AITaskExecutionContext = {
      userId: "00000000-0000-4000-8000-000000000001",
      task: "editor.creative_intent_parse", provider: item.provider, capability: "TEXT_REASONING",
      input: { editingRequirement: sourceRequest }, serverInstruction: "Extract intent only.",
      serverControlledModel: item.model, apiKey: "fixture-key",
      budget: { maxOutputTokens: 900, timeoutMs: 1_000, automaticProviderRetryCount: 0, maxProviderCalls: 1 },
    };
    const result = await executor(context);
    assert.equal(calls, 1);
    assert.equal(result.data.sourceRequest, sourceRequest);
    assert.equal(Array.isArray(result.data.clauses), true);
  }
});
