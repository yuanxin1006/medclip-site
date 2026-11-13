import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getTaskBudget } from "../../supabase/functions/_shared/ai-tasks/budget.ts";

const selectorSource = readFileSync(new URL("../../components/ai/AITaskProviderSelector.tsx", import.meta.url), "utf8");
const previewSource = readFileSync(new URL("../../components/ai/AITaskResultPreview.tsx", import.meta.url), "utf8");
const createMusicSource = readFileSync(new URL("../../app/create-music/page.tsx", import.meta.url), "utf8");
const editorSource = readFileSync(new URL("../../app/editor/EditorStudio.tsx", import.meta.url), "utf8");
const timelineEditorSource = readFileSync(new URL("../../app/TimelineEditor.tsx", import.meta.url), "utf8");
const editorCoreSource = readFileSync(new URL("../../app/editor-core.ts", import.meta.url), "utf8");
const aiServicesSource = readFileSync(new URL("../../app/ai-services/page.tsx", import.meta.url), "utf8");
const credentialClientSource = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
const taskClientSource = readFileSync(new URL("./tasks.ts", import.meta.url), "utf8");
const doubaoSource = readFileSync(new URL("../../supabase/functions/_shared/ai-credentials/providers/doubao.ts", import.meta.url), "utf8");
const editorRequirementSource = readFileSync(new URL("../../app/editor-ai-requirements.ts", import.meta.url), "utf8");
const deepseekTaskSource = readFileSync(new URL("../../supabase/functions/_shared/ai-tasks/providers/deepseek.ts", import.meta.url), "utf8");
const kimiTaskSource = readFileSync(new URL("../../supabase/functions/_shared/ai-tasks/providers/kimi.ts", import.meta.url), "utf8");
const doubaoTaskSource = readFileSync(new URL("../../supabase/functions/_shared/ai-tasks/providers/doubao.ts", import.meta.url), "utf8");

function invocation(source: string): string {
  return source.match(/runAITask\(\{\s*task(?:: "editor\.requirements_parse")?,\s*provider: selected(?:AI)?Provider,\s*input\s*\}\)/)?.[0] ?? "";
}

test("create-music and editor share safe connected-provider metadata", () => {
  assert.match(createMusicSource, /AITaskProviderSelector/);
  assert.match(editorSource, /AITaskProviderSelector/);
  assert.match(selectorSource, /listAIProviderConnections\(lifetime\.current\?\.signal\)/);
  assert.match(selectorSource, /AI_PROVIDER_DEFINITIONS\.filter/);
  assert.match(selectorSource, /provider\.taskCapabilities\.includes\(capability\)/);
  assert.match(selectorSource, /selectableProviders\.map/);
  assert.match(selectorSource, /connection\.status === "connected"/);
  assert.match(selectorSource, /disabled=\{disabled \|\| loading \|\| !connected\}/);
  assert.doesNotMatch(selectorSource, /key_last4|apiKey|ciphertext|\biv\b|encryptionKey/);
});

test("connected providers are selectable and unconnected providers cannot run tasks", () => {
  assert.match(selectorSource, /onClick=\{\(\) => onSelect\(provider\.id\)\}/);
  assert.match(createMusicSource, /disabled=\{aiTaskBusy \|\| !selectedProvider\}/);
  assert.match(editorSource, /disabled=\{editorAITaskBusy \|\| !selectedAIProvider \|\| !editorProject/);
  assert.match(createMusicSource, /if \(!selectedProvider\)/);
  assert.match(editorSource, /if \(!selectedAIProvider\)/);
});

test("existing product selectors remain scoped to TEXT_REASONING", () => {
  assert.match(selectorSource, /capability = "TEXT_REASONING"/);
  assert.match(createMusicSource, /AITaskProviderSelector/);
  assert.match(editorSource, /AITaskProviderSelector/);
  assert.doesNotMatch(createMusicSource + editorSource, /capability="MUSIC_GENERATION"/);
});

test("product task calls send only the selected provider and business input", () => {
  const musicInvocation = invocation(createMusicSource);
  const editorInvocation = invocation(editorSource);
  assert.match(musicInvocation, /provider: selectedProvider/);
  assert.match(editorInvocation, /provider: selectedAIProvider/);
  for (const call of [musicInvocation, editorInvocation]) {
    assert.doesNotMatch(call, /model|baseURL|endpoint|timeout|apiKey|headers|Authorization|systemPrompt|developerPrompt|rawMessages/);
  }
  assert.match(taskClientSource, /functions\.invoke\("ai-tasks", \{ body: request \}\)/);
});

test("music page wires all five text-reasoning tasks", () => {
  for (const task of [
    "music.lyrics_draft",
    "music.lyrics_refine",
    "music.creative_brief",
    "music.song_structure",
    "music.prompt_prepare",
  ]) assert.match(createMusicSource, new RegExp(task.replace(".", "\\.")));
  assert.match(createMusicSource, /音乐生成尚未启用/);
});

test("editor calls the deployed requirements task and explains unavailable tools", () => {
  assert.match(editorSource, /runAITask\(\{ task: "editor\.requirements_parse", provider: selectedAIProvider, input \}\)/);
  for (const label of ["分析创作意图", "字幕语义规划", "素材匹配计划", "时间线规划", "生成剪辑简报"]) {
    assert.match(editorSource, new RegExp(label));
  }
  assert.doesNotMatch(editorSource, /editor\.(?:creative_intent_parse|subtitle_semantic_plan|asset_match_plan|timeline_plan|editing_brief)/);
});

test("editor requirements generate a review and commit only after user confirmation", () => {
  const handlerStart = editorSource.indexOf("const runEditorTextTask");
  const confirmStart = editorSource.indexOf("const confirmRequirementsPlan", handlerStart);
  const panelStart = editorSource.indexOf("const requirementsReviewPanel", confirmStart);
  assert.ok(handlerStart >= 0 && confirmStart > handlerStart && panelStart > confirmStart);
  const generate = editorSource.slice(handlerStart, confirmStart);
  const confirm = editorSource.slice(confirmStart, panelStart);
  assert.match(generate, /setRequirementsReview\(\{ \.\.\.review/);
  assert.doesNotMatch(generate, /setEditorProject|handleEditorProjectChange|setAudioSelection|setEditorAIUndoProject/);
  assert.match(editorSource, /applyAIEditingPlan\(\s*review\.result\.result\.data/);
  assert.match(confirm, /validateRequirementsPlan\(currentRequirementsReview\)/);
  assert.match(confirm, /handleEditorProjectChange\(applied\.project\)/);
  assert.match(editorSource, /currentRequirementsReview[\s\S]*onClick=\{confirmRequirementsPlan\}/);
  assert.match(editorSource, /requirementsReview\.userId === user\?\.id/);
  assert.match(editorSource, /requirementsReview\.project === editorProject/);
  assert.match(editorSource, /requirementsReview\.constraintSet === activeConstraintSet/);
  assert.match(editorRequirementSource, /EXECUTABLE_EDITOR_ACTION_TYPES/);
  assert.match(editorRequirementSource, /ownedAssetIds\.has\(action\.assetId\)/);
  assert.match(editorRequirementSource, /requireTimelineRange/);
  assert.match(previewSource, /Object\.entries\(result\.result\.data\)/);
  assert.doesNotMatch(previewSource, /dangerouslySetInnerHTML/);
});

test("position scale uses trusted current clip context and one provider-neutral validator", () => {
  assert.match(editorSource, /activeVisualClips/);
  assert.match(editorSource, /activeVisualClips\.length === 1 \? activeVisualClips\[0\]\.id : undefined/);
  assert.match(editorSource, /createSafeEditorAIContext\([\s\S]*audioDurationMs,[\s\S]*activeVisualClips/);
  assert.match(editorRequirementSource, /positionScaleEligible: eligibleVisualClip\(track, clip\)/);
  assert.match(editorRequirementSource, /x: clip\.transform\.x/);
  assert.match(editorRequirementSource, /y: clip\.transform\.y/);
  assert.match(editorRequirementSource, /scale: clip\.transform\.scale/);
  for (const source of [deepseekTaskSource, kimiTaskSource, doubaoTaskSource]) {
    assert.match(source, /validateEditorRequirementsPlan\(value, schemaMismatch, editorContext\)/);
    assert.match(source, /validateEditorRequirements\(parsedContent, context\.input\.editorContext\)/);
  }
});

test("AI playback speed reuses the manual editor engine and official preview/export state", () => {
  assert.match(editorRequirementSource, /SET_CLIP_PLAYBACK_SPEED/);
  assert.match(editorRequirementSource, /applyClipSpeedCurve\(clip/);
  assert.match(timelineEditorSource, /applyClipSpeedCurve\(clip, points\)/);
  assert.match(editorCoreSource, /export function applyClipSpeedCurve/);
  assert.match(editorCoreSource, /timelineDurationForSource\(sourceDurationMs, speedCurve\)/);
  assert.match(editorSource, /speedCurve: clip\.speedCurve/);
  assert.match(editorSource, /const rate = matchSegmentRateAt\(segment, elapsed\)/);
  assert.ok((editorSource.match(/speedAt\(segment\.speedCurve/g) ?? []).length >= 1);
  assert.match(editorSource, /setEditorAIUndoProject\(cloneProject\(editorProject\)\)/);
  assert.match(editorSource, /initialUndoProjects=\{editorAIUndoProjects\}/);
  assert.match(editorSource, /setEditorAIUndoProjects\(\(current\) => snapshot \? \[\.\.\.current, snapshot\] : \[\]\)/);
  assert.match(timelineEditorSource, /initialUndoProjects\.filter/);
  assert.match(timelineEditorSource, /pending\.forEach\(\(snapshot\) => \{[\s\S]*recordProjectUndoSnapshot\(historyRef\.current, snapshot\)/);
  assert.match(timelineEditorSource, /recordProjectUndoSnapshot\(historyRef\.current, initialUndoProject\)/);
  assert.match(timelineEditorSource, /futureRef\.current\.push\(cloneProject\(draftRef\.current\)\)/);
  assert.doesNotMatch(editorRequirementSource, /volume|GainNode|transition/i);
});

test("AI clip splitting reuses the manual split engine and official preview/export state", () => {
  assert.match(editorRequirementSource, /SPLIT_CLIP/);
  assert.match(editorRequirementSource, /splitTimelineClip\(/);
  assert.match(timelineEditorSource, /splitTimelineClip\(/);
  assert.match(editorCoreSource, /export function splitTimelineClip/);
  assert.match(editorCoreSource, /sourceTimeAtTimelineMs\(clip, splitAtTimelineMs\)/);
  assert.match(editorSource, /projectToMatchSegments\(nextProject\)/);
  assert.match(editorSource, /sourceStart: clip\.sourceInMs/);
  assert.match(editorSource, /sourceEnd: clip\.sourceOutMs/);
  assert.match(editorSource, /speedCurve: clip\.speedCurve/);
  assert.match(editorSource, /setEditorAIUndoProject\(cloneProject\(editorProject\)\)/);
  assert.doesNotMatch(editorRequirementSource, /leftClipId|rightClipId|newClipId/);
});

test("AI clip reordering reuses the manual reorder engine and official preview/export state", () => {
  assert.match(editorRequirementSource, /REORDER_CLIP/);
  assert.match(editorRequirementSource, /reorderTimelineClip\(/);
  assert.match(timelineEditorSource, /reorderTimelineClip\(/);
  assert.match(editorCoreSource, /export function reorderTimelineClip/);
  assert.match(editorCoreSource, /placement === "BEFORE"/);
  assert.match(editorSource, /projectToMatchSegments\(nextProject\)/);
  assert.match(editorSource, /sort\(\(left, right\) => left\.start - right\.start\)/);
  assert.match(editorSource, /setEditorAIUndoProject\(cloneProject\(editorProject\)\)/);
  assert.doesNotMatch(editorRequirementSource, /targetIndex|destinationIndex|"MOVE_CLIP"|"REPOSITION_CLIP"/);
});

test("advanced requirements UI exposes guarded generation and safe summaries", () => {
  assert.match(editorSource, /解析剪辑需求/);
  assert.match(editorSource, /确认并应用剪辑建议/);
  assert.match(editorSource, /disabled=\{editorAITaskBusy \|\| !selectedAIProvider \|\| !editorProject \|\| !requirementDraft\.trim\(\)\}/);
  assert.match(editorSource, /onClick=\{\(\) => void runEditorTextTask\(\)\}/);
  assert.match(editorSource, /editor-ai-apply-summary/);
  assert.match(editorSource, /暂不支持或需确认/);
  assert.match(editorSource, /时间线没有修改/);
  assert.doesNotMatch(editorSource, /dangerouslySetInnerHTML/);
});

test("manual editor remains available without an AI provider", () => {
  const canGenerateStart = editorSource.indexOf("const canGenerate =");
  const canGenerateEnd = editorSource.indexOf(";", canGenerateStart);
  const canGenerate = editorSource.slice(canGenerateStart, canGenerateEnd);
  assert.doesNotMatch(canGenerate, /selectedAIProvider|editorAITask/);
  assert.match(editorSource, /disabled=\{!canGenerate \|\| jobState === "processing"\}/);
});

test("missing connections show the AI services CTA and cost notice", () => {
  assert.match(selectorSource, /connectedCount === 0/);
  assert.match(selectorSource, /请先连接 AI 服务/);
  assert.match(selectorSource, /href="\/ai-services"/);
  assert.match(selectorSource, /AI 调用费用由您所选择的服务商账户承担/);
});

test("anonymous users see the AI service area but only the login entry point", () => {
  assert.match(selectorSource, /!authLoading && !user/);
  assert.match(selectorSource, /登录后使用您连接的 AI 服务/);
  assert.match(selectorSource, /href="\/auth"/);
  assert.match(selectorSource, /onSelect\(null\)/);
  assert.match(selectorSource, /disabled=\{disabled \|\| loading \|\| !connected\}/);
});

test("task economics preserve zero retry and no silent fallback", () => {
  const budget = getTaskBudget("music.lyrics_draft");
  assert.equal(budget.automaticProviderRetryCount, 0);
  assert.equal(budget.maxProviderCalls, 1);
  assert.equal(createMusicSource.match(/await runAITask/g)?.length, 1);
  assert.equal(editorSource.match(/await runAITask/g)?.length, 1);
});

test("AI services and credential client remain the single credential-management path", () => {
  assert.match(aiServicesSource, /listAIProviderConnections/);
  assert.match(aiServicesSource, /saveAIProviderCredential/);
  assert.match(credentialClientSource, /functions\.invoke\("ai-credentials"/);
  assert.doesNotMatch(createMusicSource + editorSource, /saveAIProviderCredential|testTransientCredential|deleteAIProviderCredential/);
});

test("existing BYOK adapters and Doubao timeout remain unchanged", () => {
  assert.match(doubaoSource, /DOUBAO_VALIDATION_TIMEOUT_MS = 30_000/);
  assert.doesNotMatch(createMusicSource + editorSource, /verify:.*byok-live|api\.deepseek\.com|api\.moonshot\.cn|ark\.cn-beijing/);
});
