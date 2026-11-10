import type { User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "../supabase/client";
import {
  AUDIO_EXTENSIONS,
  COVER_EXTENSIONS,
  validateAudioFile,
  validateCoverFile,
} from "./files";
import type {
  CreateMusicTrackInput,
  DeleteTrackResult,
  MusicStorageBucket,
  MusicTrack,
  Profile,
  SignedMediaBatchResult,
  SignedMusicAsset,
  UpdateMusicTrackInput,
  UploadedMusicAsset,
} from "./types";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, "i");
const AUDIO_PATH_PATTERN = new RegExp(`^${UUID_SOURCE}/${UUID_SOURCE}/audio\\.(mp3|wav)$`, "i");
const COVER_PATH_PATTERN = new RegExp(`^${UUID_SOURCE}/${UUID_SOURCE}/cover\\.(jpg|png|webp)$`, "i");

export class MusicDataError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MusicDataError";
    this.cause = cause;
  }
}

export class MusicTrackDeletionError extends MusicDataError {
  readonly result: DeleteTrackResult;

  constructor(message: string, result: DeleteTrackResult, cause?: unknown) {
    super(message, cause);
    this.name = "MusicTrackDeletionError";
    this.result = result;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwDataError(action: string, error: unknown): never {
  throw new MusicDataError(`${action}失败：${errorMessage(error)}`, error);
}

async function requireCurrentUser(): Promise<User> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) throwDataError("读取当前用户", error);
  if (!data.user) throw new MusicDataError("请先登录后再管理音乐作品。");
  return data.user;
}

function assertTrackId(trackId: string): string {
  if (!UUID_PATTERN.test(trackId)) throw new MusicDataError("trackId 必须是有效的 UUID。");
  return trackId.toLowerCase();
}

function extensionFor(file: File, allowedTypes: Readonly<Record<string, string>>): string {
  const extension = allowedTypes[file.type.toLowerCase()];
  if (!extension) throw new MusicDataError(`不支持的文件类型：${file.type || "unknown"}`);
  return extension;
}

function assertCanonicalMediaPath(bucket: MusicStorageBucket, path: string): string {
  const pattern = bucket === "music-audio" ? AUDIO_PATH_PATTERN : COVER_PATH_PATTERN;
  if (!pattern.test(path)) throw new MusicDataError("媒体路径不是有效的 MedClip Storage 对象路径。");
  return path;
}

function assertOwnedMediaPath(bucket: MusicStorageBucket, path: string, userId: string, trackId: string): string {
  const canonicalPath = assertCanonicalMediaPath(bucket, path);
  const expectedPrefix = `${userId.toLowerCase()}/${trackId.toLowerCase()}/`;
  if (!canonicalPath.toLowerCase().startsWith(expectedPrefix)) {
    throw new MusicDataError("媒体路径必须属于当前用户和当前作品。");
  }
  return canonicalPath;
}

async function uploadAsset(
  bucket: MusicStorageBucket,
  trackId: string,
  file: File,
  baseName: "audio" | "cover",
  allowedTypes: Readonly<Record<string, string>>,
): Promise<UploadedMusicAsset> {
  const supabase = getSupabaseBrowserClient();
  const user = await requireCurrentUser();
  const safeTrackId = assertTrackId(trackId);
  const extension = extensionFor(file, allowedTypes);
  const path = `${user.id}/${safeTrackId}/${baseName}.${extension}`;
  const { data, error } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: "3600",
    contentType: file.type,
    upsert: true,
  });

  if (error) throwDataError(`上传${baseName === "audio" ? "音频" : "封面"}`, error);
  return { bucket, path: data.path };
}

export async function getPublishedTracks(): Promise<MusicTrack[]> {
  const { data, error } = await getSupabaseBrowserClient()
    .from("music_tracks")
    .select("*")
    .eq("published", true)
    .order("created_at", { ascending: false });
  if (error) throwDataError("读取已发布音乐", error);
  return (data ?? []) as MusicTrack[];
}

export async function getOwnTracks(): Promise<MusicTrack[]> {
  const user = await requireCurrentUser();
  const { data, error } = await getSupabaseBrowserClient()
    .from("music_tracks")
    .select("*")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });
  if (error) throwDataError("读取我的作品", error);
  return (data ?? []) as MusicTrack[];
}

export async function getProfilesByIds(userIds: string[]): Promise<Record<string, Profile>> {
  const ids = [...new Set(userIds.map((id) => id.toLowerCase()).filter((id) => UUID_PATTERN.test(id)))];
  if (ids.length === 0) return {};
  const { data, error } = await getSupabaseBrowserClient()
    .from("profiles")
    .select("id, display_name, avatar_url, created_at")
    .in("id", ids);
  if (error) throwDataError("读取创作者资料", error);
  return Object.fromEntries(((data ?? []) as Profile[]).map((profile) => [profile.id.toLowerCase(), profile]));
}

export async function createTrack(input: CreateMusicTrackInput): Promise<MusicTrack> {
  const user = await requireCurrentUser();
  const title = input.title.trim();
  const artistName = input.artist_name.trim();
  if (!title || !artistName) throw new MusicDataError("歌曲名称和创作者不能为空。");
  const { data, error } = await getSupabaseBrowserClient()
    .from("music_tracks")
    .insert({
      title,
      artist_name: artistName,
      description: input.description?.trim() ?? "",
      genre: input.genre?.trim() || null,
      published: false,
      user_id: user.id,
    })
    .select("*")
    .single();
  if (error) throwDataError("创建音乐草稿", error);
  return data as MusicTrack;
}

export async function updateTrack(id: string, changes: UpdateMusicTrackInput): Promise<MusicTrack> {
  const trackId = assertTrackId(id);
  const safeChanges = { ...changes };
  if (changes.audio_path !== undefined || changes.cover_path !== undefined) {
    const user = await requireCurrentUser();
    if (changes.audio_path) safeChanges.audio_path = assertOwnedMediaPath("music-audio", changes.audio_path, user.id, trackId);
    if (changes.cover_path) safeChanges.cover_path = assertOwnedMediaPath("music-covers", changes.cover_path, user.id, trackId);
  }
  const { data, error } = await getSupabaseBrowserClient()
    .from("music_tracks")
    .update(safeChanges)
    .eq("id", trackId)
    .select("*")
    .single();
  if (error) throwDataError("更新音乐作品", error);
  return data as MusicTrack;
}

export async function publishTrack(id: string): Promise<MusicTrack> {
  const trackId = assertTrackId(id);
  const user = await requireCurrentUser();
  const { data: track, error } = await getSupabaseBrowserClient()
    .from("music_tracks")
    .select("*")
    .eq("id", trackId)
    .eq("user_id", user.id)
    .single();
  if (error) throwDataError("读取待发布作品", error);
  const current = track as MusicTrack;
  if (!current.title.trim() || !current.audio_path || !current.duration_seconds || current.duration_seconds <= 0) {
    throw new MusicDataError("发布前必须填写歌曲名称、上传有效音频并成功读取时长。");
  }
  return updateTrack(trackId, { published: true });
}

export async function deleteTrack(id: string): Promise<DeleteTrackResult> {
  const user = await requireCurrentUser();
  const trackId = assertTrackId(id);
  const result: DeleteTrackResult = { trackId, audioDeleted: false, coverDeleted: false, rowDeleted: false };
  const supabase = getSupabaseBrowserClient();
  const { data: track, error: readError } = await supabase
    .from("music_tracks")
    .select("user_id, audio_path, cover_path, published")
    .eq("id", trackId)
    .single();
  if (readError) throwDataError("读取待删除音乐作品", readError);
  if (track.user_id !== user.id) throw new MusicDataError("只能删除自己的音乐作品。");

  if (track.published) {
    const { error: unpublishError } = await supabase
      .from("music_tracks")
      .update({ published: false })
      .eq("id", trackId);
    if (unpublishError) throwDataError("删除前下架音乐作品", unpublishError);
  }

  try {
    if (track.audio_path) {
      const { error } = await supabase.storage.from("music-audio").remove([track.audio_path]);
      if (error) throw error;
    }
    result.audioDeleted = true;
    if (track.cover_path) {
      const { error } = await supabase.storage.from("music-covers").remove([track.cover_path]);
      if (error) throw error;
    }
    result.coverDeleted = true;
  } catch (error) {
    throw new MusicTrackDeletionError(
      "媒体文件未完全删除，作品记录已保留。请重试删除。",
      result,
      error,
    );
  }

  const { error: deleteError } = await supabase.from("music_tracks").delete().eq("id", trackId);
  if (deleteError) {
    throw new MusicTrackDeletionError("媒体已删除，但作品记录删除失败。请刷新后重试。", result, deleteError);
  }
  result.rowDeleted = true;
  return result;
}

export function uploadTrackAudio(trackId: string, file: File): Promise<UploadedMusicAsset> {
  validateAudioFile(file);
  return uploadAsset("music-audio", trackId, file, "audio", AUDIO_EXTENSIONS);
}

export function uploadTrackCover(trackId: string, file: File): Promise<UploadedMusicAsset> {
  validateCoverFile(file);
  return uploadAsset("music-covers", trackId, file, "cover", COVER_EXTENSIONS);
}

export async function removeTrackAsset(
  bucket: MusicStorageBucket,
  path: string,
  trackId: string,
): Promise<void> {
  const user = await requireCurrentUser();
  const safeTrackId = assertTrackId(trackId);
  const safePath = assertOwnedMediaPath(bucket, path, user.id, safeTrackId);
  const { error } = await getSupabaseBrowserClient().storage.from(bucket).remove([safePath]);
  if (error) throwDataError("清理被替换的媒体文件", error);
}

export async function createSignedMediaUrl(
  bucket: MusicStorageBucket,
  path: string,
  expiresInSeconds = 3600,
): Promise<SignedMusicAsset> {
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 86400) {
    throw new MusicDataError("Signed URL 有效期必须为 60 到 86400 秒之间的整数。");
  }
  const canonicalPath = assertCanonicalMediaPath(bucket, path);
  const { data, error } = await getSupabaseBrowserClient().storage
    .from(bucket)
    .createSignedUrl(canonicalPath, expiresInSeconds);
  if (error) throwDataError("创建媒体读取链接", error);
  return { bucket, path: canonicalPath, signedUrl: data.signedUrl, expiresInSeconds };
}

export async function createSignedMediaUrls(
  bucket: MusicStorageBucket,
  paths: string[],
  expiresInSeconds = 3600,
): Promise<SignedMediaBatchResult> {
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 86400) {
    throw new MusicDataError("Signed URL 有效期必须为 60 到 86400 秒之间的整数。");
  }
  const canonicalPaths = [...new Set(paths.map((path) => assertCanonicalMediaPath(bucket, path)))];
  if (canonicalPaths.length === 0) return { urls: {}, errors: {} };
  const { data, error } = await getSupabaseBrowserClient().storage
    .from(bucket)
    .createSignedUrls(canonicalPaths, expiresInSeconds);
  if (error) throwDataError("批量创建媒体读取链接", error);
  const urls: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const [index, item] of (data ?? []).entries()) {
    const path = item.path ?? canonicalPaths[index];
    if (!path) continue;
    if (item.signedUrl) urls[path] = item.signedUrl;
    else errors[path] = item.error ?? "无法创建签名链接";
  }
  return { urls, errors };
}

export function getTrackAudioSignedUrl(
  track: Pick<MusicTrack, "audio_path">,
  expiresInSeconds = 3600,
): Promise<SignedMusicAsset> {
  if (!track.audio_path) throw new MusicDataError("该作品还没有音频文件。");
  return createSignedMediaUrl("music-audio", track.audio_path, expiresInSeconds);
}

export async function downloadOwnTrackAudio(
  trackId: string,
): Promise<{ blob: Blob; title: string; format: "mp3" | "wav" }> {
  const user = await requireCurrentUser();
  const safeTrackId = assertTrackId(trackId);
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("music_tracks")
    .select("id, user_id, title, audio_path")
    .eq("id", safeTrackId)
    .eq("user_id", user.id)
    .single();
  if (error) throwDataError("读取待下载的音乐作品", error);

  const track = data as Pick<MusicTrack, "id" | "user_id" | "title" | "audio_path">;
  if (track.user_id.toLowerCase() !== user.id.toLowerCase()) {
    throw new MusicDataError("只能下载自己的音乐作品。");
  }
  if (!track.audio_path) throw new MusicDataError("该作品还没有音频文件。");

  const safePath = assertOwnedMediaPath("music-audio", track.audio_path, user.id, safeTrackId);
  const { data: audio, error: downloadError } = await supabase.storage
    .from("music-audio")
    .download(safePath);
  if (downloadError) throwDataError("下载音频", downloadError);
  if (!audio || audio.size <= 0) throw new MusicDataError("下载的音频文件为空。");
  return { blob: audio, title: track.title, format: track.audio_path.toLowerCase().endsWith(".wav") ? "wav" : "mp3" };
}

export function getTrackCoverSignedUrl(
  track: Pick<MusicTrack, "cover_path">,
  expiresInSeconds = 3600,
): Promise<SignedMusicAsset> {
  if (!track.cover_path) throw new MusicDataError("该作品还没有封面文件。");
  return createSignedMediaUrl("music-covers", track.cover_path, expiresInSeconds);
}
