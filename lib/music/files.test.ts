import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_AUDIO_BYTES,
  MAX_COVER_BYTES,
  toDurationSeconds,
  validateAudioFile,
  validateCoverFile,
} from "./files.ts";
import { sanitizeMusicDownloadFilename } from "./download.ts";
import { hasUnsavedTrackChanges, isTrackPublishReady, type TrackPublishState } from "./workflow.ts";

const readyState: TrackPublishState = {
  artistName: "MedClip Creator",
  audioSelected: false,
  coverSelected: false,
  description: "A finished draft",
  genre: "Pop",
  incomplete: false,
  title: "Ready Song",
  track: {
    artist_name: "MedClip Creator",
    audio_path: "00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/audio.mp3",
    description: "A finished draft",
    duration_seconds: 180,
    genre: "Pop",
    published: false,
    title: "Ready Song",
  },
};

test("accepts supported music upload types within the client limits", () => {
  assert.doesNotThrow(() => validateAudioFile({ size: MAX_AUDIO_BYTES, type: "audio/mpeg" }));
  assert.doesNotThrow(() => validateAudioFile({ size: 1, type: "audio/wav" }));
  assert.doesNotThrow(() => validateCoverFile({ size: MAX_COVER_BYTES, type: "image/webp" }));
});

test("rejects empty, unsupported, and oversized upload files", () => {
  assert.throws(() => validateAudioFile({ size: 1, type: "audio/ogg" }), /格式不受支持/);
  assert.throws(() => validateAudioFile({ size: 0, type: "audio/mpeg" }), /不能为空/);
  assert.throws(() => validateAudioFile({ size: MAX_AUDIO_BYTES + 1, type: "audio/mpeg" }), /100 MB/);
  assert.throws(() => validateCoverFile({ size: MAX_COVER_BYTES + 1, type: "image/png" }), /10 MB/);
});

test("normalizes a finite browser metadata duration without using file size", () => {
  assert.equal(toDurationSeconds(1), 1);
  assert.equal(toDurationSeconds(61.6), 62);
  assert.throws(() => toDurationSeconds(0), /有效的音频时长/);
  assert.throws(() => toDurationSeconds(Number.POSITIVE_INFINITY), /有效的音频时长/);
});

test("a valid saved draft is publish ready", () => {
  assert.equal(hasUnsavedTrackChanges(readyState), false);
  assert.equal(isTrackPublishReady(readyState), true);
});

test("a selected replacement audio blocks publishing until saved", () => {
  assert.equal(isTrackPublishReady({ ...readyState, audioSelected: true }), false);
});

test("edited metadata blocks publishing until saved", () => {
  assert.equal(isTrackPublishReady({ ...readyState, title: "Unsaved title" }), false);
});

test("an incomplete upload blocks publishing", () => {
  assert.equal(isTrackPublishReady({ ...readyState, incomplete: true }), false);
});

test("a track without a saved duration is not publish ready", () => {
  assert.equal(isTrackPublishReady({ ...readyState, track: { ...readyState.track!, duration_seconds: null } }), false);
});

test("an already published track is not publish ready", () => {
  assert.equal(isTrackPublishReady({ ...readyState, track: { ...readyState.track!, published: true } }), false);
});

test("sanitizes MP3 download filenames without losing Chinese titles", () => {
  assert.equal(sanitizeMusicDownloadFilename("春日/心声:最终?.mp3"), "春日 心声 最终.mp3");
  assert.equal(sanitizeMusicDownloadFilename("CON"), "medclip-CON.mp3");
  assert.equal(sanitizeMusicDownloadFilename("   "), "medclip-song.mp3");
  assert.equal(sanitizeMusicDownloadFilename("  夜航  "), "夜航.mp3");
  assert.equal(sanitizeMusicDownloadFilename("  夜航.wav  ", "wav"), "夜航.wav");
  assert.doesNotMatch(sanitizeMusicDownloadFilename("a\\b\u0000c"), /[<>:"/\\|?*\u0000-\u001f\u007f]/u);
});
