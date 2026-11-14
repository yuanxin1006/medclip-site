import assert from "node:assert/strict";
import test from "node:test";
import { explicitVideoSpeedTarget, verifyExplicitVideoSpeedPlan } from "./editor-ai-requirements.ts";
import { createFullAudioSelection, DEFAULT_SPEED_CURVE, DEFAULT_TRANSFORM, parseEditorProject, type EditorProject } from "./editor-core.ts";
import {
  canRecoverLegacyEditorDraft, editorDraftKey, findLocalMediaReference, identifyLocalMedia,
  LEGACY_EDITOR_OWNER_KEY, needsInitialVisualTimeline,
} from "./editor-local-media.ts";

function project(): EditorProject {
  return {
    schemaVersion: 2, id: "test", title: "test", updatedAt: "", durationMs: 8000, ratio: "16:9",
    audioSelection: createFullAudioSelection(0), assets: [],
    tracks: [{
      id: "video", name: "video", type: "video",
      clips: [
        { id: "later", kind: "视频", start: 4000 },
        { id: "image", kind: "图片", start: 1000 },
        { id: "first", kind: "视频", start: 0 },
      ].map(item => ({
        id: item.id, assetId: item.id, name: item.id, kind: item.kind as "视频" | "图片", trackId: "video",
        timelineStartMs: item.start, timelineEndMs: item.start + 1000, sourceInMs: 0, sourceOutMs: 1000,
        transform: DEFAULT_TRANSFORM, speedCurve: DEFAULT_SPEED_CURVE,
      })),
    }], captions: [{ id: "cue", text: "保留", startMs: 300, endMs: 600 }],
  };
}

test("full-content identity matches renamed bytes and rejects a same-size difference outside the first chunk", async () => {
  const bytes = new Uint8Array(4 * 1024 ** 2 + 4);
  const original = await identifyLocalMedia(new File([bytes], "a.mp4"));
  const renamed = await identifyLocalMedia(new File([bytes], "b.mp4"));
  const reference = { id: "original", name: "a.mp4", kind: "视频" as const, durationMs: 4000, mediaIdentity: original };
  assert.equal(findLocalMediaReference([reference], { ...reference, mediaIdentity: renamed }), reference);
  bytes[bytes.length - 1] = 1;
  const wrong = await identifyLocalMedia(new File([bytes], "a.mp4"));
  assert.equal(wrong.bytes, original.bytes);
  assert.equal(findLocalMediaReference([reference], { ...reference, mediaIdentity: wrong }), undefined);
  assert.throws(() => findLocalMediaReference([reference, { ...reference, id: "ambiguous" }], reference));
});

test("saved media identity persists while old projects retain their original clip IDs", () => {
  const old = project();
  const parsed = parseEditorProject(JSON.stringify(old));
  assert.deepEqual(parsed?.tracks, old.tracks);
  assert.deepEqual(parsed?.captions, old.captions);
  old.assets = [{ id: "first", name: "first.mp4", kind: "视频", durationMs: 1000, mediaIdentity: {
    bytes: 123, contentSha256: "a".repeat(64),
  } }];
  assert.deepEqual(parseEditorProject(JSON.stringify(old))?.assets, old.assets);
});

test("new, subtitle-only and legacy empty drafts need initialization until visuals were established", () => {
  const old = project();
  assert.equal(needsInitialVisualTimeline(null), true);
  assert.equal(needsInitialVisualTimeline(old), false);
  assert.equal(needsInitialVisualTimeline({ ...old, visualTimelineInitialized: false }), false);
  old.tracks[0].clips = [];
  assert.equal(needsInitialVisualTimeline(parseEditorProject(JSON.stringify(old))), true);
  assert.equal(needsInitialVisualTimeline({ ...old, visualTimelineInitialized: false }), true);
  assert.equal(needsInitialVisualTimeline({ ...old, visualTimelineInitialized: true }), false);
});

test("draft scopes and claimed legacy drafts cannot cross accounts or anonymous sessions", () => {
  const owner = editorDraftKey("account-a");
  const storage = { getItem: (key: string) => key === LEGACY_EDITOR_OWNER_KEY ? owner : null };
  assert.equal(canRecoverLegacyEditorDraft(storage, owner), true);
  assert.equal(canRecoverLegacyEditorDraft(storage, editorDraftKey("account-b")), false);
  assert.equal(canRecoverLegacyEditorDraft(storage, editorDraftKey(null)), false);
});

test("second video is resolved in current timeline order and mismatched AI actions are rejected", () => {
  const target = explicitVideoSpeedTarget("第二个视频 1.5 倍速。", project());
  assert.deepEqual(target, { clipId: "later", rate: 1.5 });
  const action = { type: "SET_CLIP_PLAYBACK_SPEED", targetId: "later", playbackRate: 1.5, reason: "fixture" };
  const plan = { summary: "fixture", actions: [action], unsupported: [], warnings: [] };
  assert.doesNotThrow(() => verifyExplicitVideoSpeedPlan(plan, target!));
  assert.throws(() => verifyExplicitVideoSpeedPlan({ ...plan, actions: [{ ...action, targetId: "first" }] }, target!));
  assert.throws(() => verifyExplicitVideoSpeedPlan({ ...plan, actions: [action, action] }, target!));
});
