import assert from "node:assert/strict";
import test from "node:test";
import { assertCanonicalWorkAssetPath, assertWorkAssetCount, buildWorkAssetPath, createSettledCleanup, validateWorkAssetFile } from "./files.ts";
import { deriveWorkContentKind, isWorkPublishReady, type WorkPublishState } from "./workflow.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const workId = "00000000-0000-4000-8000-000000000002";
const assetId = "00000000-0000-4000-8000-000000000003";

function file(name: string, type: string, size: number): File {
  return { name, type, size } as File;
}

test("accepts supported image, video, and audio MIME types", () => {
  assert.equal(validateWorkAssetFile(file("cover.jpg", "image/jpeg", 1024)).assetType, "image");
  assert.equal(validateWorkAssetFile(file("clip.webm", "video/webm", 1024)).assetType, "video");
  assert.equal(validateWorkAssetFile(file("song.mp3", "audio/mpeg", 1024)).assetType, "audio");
  assert.equal(validateWorkAssetFile(file("song.wav", "audio/x-wav", 1024)).extension, "wav");
});

test("rejects unsupported MIME types and per-type oversize files", () => {
  assert.throws(() => validateWorkAssetFile(file("fake.jpg", "application/octet-stream", 1024)));
  assert.throws(() => validateWorkAssetFile(file("large.png", "image/png", 10 * 1024 * 1024 + 1)));
  assert.throws(() => validateWorkAssetFile(file("large.mp4", "video/mp4", 200 * 1024 * 1024 + 1)));
  assert.throws(() => validateWorkAssetFile(file("large.wav", "audio/wav", 100 * 1024 * 1024 + 1)));
});

test("enforces the nine-asset product limit", () => {
  assert.doesNotThrow(() => assertWorkAssetCount(4, 5));
  assert.throws(() => assertWorkAssetCount(9, 1));
});

test("duration lifecycle cleanup settles exactly once", () => {
  let cleanupCalls = 0;
  const settle = createSettledCleanup(() => { cleanupCalls += 1; });
  assert.equal(settle(), true);
  assert.equal(settle(), false);
  assert.equal(settle(), false);
  assert.equal(cleanupCalls, 1);
});

test("builds and verifies the canonical user/work/asset path", () => {
  const result = buildWorkAssetPath(userId, workId, assetId, file("original-name.JPG", "image/jpeg", 1024));
  assert.equal(result.path, `${userId}/${workId}/${assetId}.jpg`);
  assert.equal(assertCanonicalWorkAssetPath(result.path, userId, workId, assetId), result.path);
  assert.throws(() => assertCanonicalWorkAssetPath(`${userId}/${workId}/original-name.jpg`));
});

function publishState(overrides: Partial<WorkPublishState> = {}): WorkPublishState {
  return {
    title: "文字作品",
    body: "这是作品正文。",
    sourceMusicTrackId: null,
    existingAssetCount: 0,
    pendingAssetCount: 0,
    removedAssetCount: 0,
    incomplete: false,
    work: {
      title: "文字作品",
      body: "这是作品正文。",
      source_music_track_id: null,
      published: false,
    },
    ...overrides,
  };
}

test("a saved text-only work is publish ready", () => {
  assert.equal(isWorkPublishReady(publishState()), true);
  assert.equal(deriveWorkContentKind("正文", []), "TEXT");
});

test("a saved mixed text, image, and video work is publish ready", () => {
  const assets = [{ asset_type: "image" as const }, { asset_type: "video" as const }];
  assert.equal(isWorkPublishReady(publishState({ existingAssetCount: assets.length })), true);
  assert.equal(deriveWorkContentKind("正文", assets), "MIXED");
});

test("unsaved changes and empty works block publishing", () => {
  assert.equal(isWorkPublishReady(publishState({ title: "尚未保存的新标题" })), false);
  assert.equal(isWorkPublishReady(publishState({ pendingAssetCount: 1 })), false);
  assert.equal(isWorkPublishReady(publishState({ body: "", work: { title: "空作品", body: "", source_music_track_id: null, published: false } })), false);
});
