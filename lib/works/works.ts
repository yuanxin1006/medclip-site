import type { User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "../supabase/client";
import {
  assertCanonicalWorkAssetPath,
  assertWorkAssetCount,
  buildWorkAssetPath,
  readWorkMediaDurationSeconds,
  validateWorkAssetFile,
} from "./files";
import { runWorkDeletionStages } from "./consistency";
import type {
  CreateWorkInput,
  UpdateWorkInput,
  Work,
  WorkAsset,
  WorkAuthor,
  WorkDeletionResult,
  WorkWithAssets,
} from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkDataError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "WorkDataError";
    this.cause = cause;
  }
}

export class WorkPartialFailureError extends WorkDataError {
  readonly cleanupPerformed: boolean;

  constructor(message: string, cleanupPerformed: boolean, cause?: unknown) {
    super(message, cause);
    this.name = "WorkPartialFailureError";
    this.cleanupPerformed = cleanupPerformed;
  }
}

export class WorkDeletionError extends WorkDataError {
  readonly result: WorkDeletionResult;

  constructor(message: string, result: WorkDeletionResult, cause?: unknown) {
    super(message, cause);
    this.name = "WorkDeletionError";
    this.result = result;
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(action: string, error: unknown): never {
  throw new WorkDataError(`${action}失败：${messageFrom(error)}`, error);
}

function assertUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new WorkDataError(`${field} 必须是有效的 UUID。`);
  return value.toLowerCase();
}

async function requireCurrentUser(): Promise<User> {
  const { data, error } = await getSupabaseBrowserClient().auth.getUser();
  if (error) fail("读取当前用户", error);
  if (!data.user) throw new WorkDataError("请先登录后再管理作品。");
  return data.user;
}

async function getAssetsByWorkIds(workIds: string[]): Promise<WorkAsset[]> {
  if (workIds.length === 0) return [];
  const { data, error } = await getSupabaseBrowserClient()
    .from("work_assets")
    .select("*")
    .in("work_id", workIds)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) fail("读取作品媒体", error);
  return (data ?? []) as WorkAsset[];
}

async function getAuthors(userIds: string[]): Promise<Record<string, WorkAuthor>> {
  const ids = [...new Set(userIds.map((id) => id.toLowerCase()).filter((id) => UUID_PATTERN.test(id)))];
  if (ids.length === 0) return {};
  const { data, error } = await getSupabaseBrowserClient()
    .from("profiles")
    .select("id, display_name, avatar_url")
    .in("id", ids);
  if (error) fail("读取作品作者", error);
  return Object.fromEntries(((data ?? []) as WorkAuthor[]).map((author) => [author.id.toLowerCase(), author]));
}

async function hydrateWorks(rows: Work[]): Promise<WorkWithAssets[]> {
  const [assets, authors] = await Promise.all([
    getAssetsByWorkIds(rows.map((work) => work.id)),
    getAuthors(rows.map((work) => work.user_id)),
  ]);
  const assetsByWork = new Map<string, WorkAsset[]>();
  for (const asset of assets) {
    const current = assetsByWork.get(asset.work_id) ?? [];
    current.push(asset);
    assetsByWork.set(asset.work_id, current);
  }
  return rows.map((work) => ({
    ...work,
    assets: assetsByWork.get(work.id) ?? [],
    author: authors[work.user_id.toLowerCase()] ?? null,
  }));
}

async function getOwnedWorkRow(user: User, id: string): Promise<Work> {
  const workId = assertUuid(id, "workId");
  const { data, error } = await getSupabaseBrowserClient()
    .from("works")
    .select("*")
    .eq("id", workId)
    .eq("user_id", user.id)
    .single();
  if (error) fail("读取作品记录", error);
  return data as Work;
}

export async function getPublishedWorks(): Promise<WorkWithAssets[]> {
  const { data, error } = await getSupabaseBrowserClient()
    .from("works")
    .select("*")
    .eq("published", true)
    .order("created_at", { ascending: false });
  if (error) fail("读取公开作品", error);
  return hydrateWorks((data ?? []) as Work[]);
}

export async function getOwnWorks(): Promise<WorkWithAssets[]> {
  const user = await requireCurrentUser();
  const { data, error } = await getSupabaseBrowserClient()
    .from("works")
    .select("*")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });
  if (error) fail("读取我的作品", error);
  return hydrateWorks((data ?? []) as Work[]);
}

export async function getOwnWork(id: string): Promise<WorkWithAssets> {
  const user = await requireCurrentUser();
  const work = await getOwnedWorkRow(user, id);
  return (await hydrateWorks([work]))[0];
}

export async function createWorkDraft(input: CreateWorkInput): Promise<Work> {
  const user = await requireCurrentUser();
  const title = input.title.trim();
  if (!title) throw new WorkDataError("作品标题不能为空。");
  const { data, error } = await getSupabaseBrowserClient()
    .from("works")
    .insert({
      user_id: user.id,
      title,
      body: input.body?.trim() ?? "",
      source_music_track_id: input.source_music_track_id ?? null,
    })
    .select("*")
    .single();
  if (error) fail("创建作品草稿", error);
  return data as Work;
}

export async function updateWorkDraft(id: string, changes: UpdateWorkInput): Promise<Work> {
  const user = await requireCurrentUser();
  const workId = assertUuid(id, "workId");
  const safeChanges: UpdateWorkInput = { ...changes };
  if (changes.title !== undefined) {
    safeChanges.title = changes.title.trim();
    if (!safeChanges.title) throw new WorkDataError("作品标题不能为空。");
  }
  if (changes.body !== undefined) safeChanges.body = changes.body.trim();
  const { data, error } = await getSupabaseBrowserClient()
    .from("works")
    .update(safeChanges)
    .eq("id", workId)
    .eq("user_id", user.id)
    .select("*")
    .single();
  if (error) fail("更新作品草稿", error);
  return data as Work;
}

export async function uploadWorkAsset(
  workId: string,
  file: File,
  sortOrder: number,
  assetId = crypto.randomUUID(),
): Promise<WorkAsset> {
  const user = await requireCurrentUser();
  const safeWorkId = assertUuid(workId, "workId");
  const safeAssetId = assertUuid(assetId, "assetId");
  if (!Number.isInteger(sortOrder) || sortOrder < 0) throw new WorkDataError("媒体排序值无效。");

  await getOwnedWorkRow(user, safeWorkId);
  const existingAssets = await getAssetsByWorkIds([safeWorkId]);
  assertWorkAssetCount(existingAssets.length, 1);
  const validated = validateWorkAssetFile(file);
  const durationSeconds = await readWorkMediaDurationSeconds(file, validated.assetType);
  const { path, assetType, mimeType } = buildWorkAssetPath(user.id, safeWorkId, safeAssetId, file);
  const supabase = getSupabaseBrowserClient();
  const { error: uploadError } = await supabase.storage.from("work-media").upload(path, file, {
    cacheControl: "3600",
    contentType: mimeType,
    upsert: false,
  });
  if (uploadError) fail("上传作品媒体", uploadError);

  const { data, error: insertError } = await supabase
    .from("work_assets")
    .insert({
      id: safeAssetId,
      work_id: safeWorkId,
      user_id: user.id,
      asset_type: assetType,
      storage_path: path,
      mime_type: mimeType,
      sort_order: sortOrder,
      duration_seconds: durationSeconds,
    })
    .select("*")
    .single();
  if (!insertError) return data as WorkAsset;

  const { error: cleanupError } = await supabase.storage.from("work-media").remove([path]);
  throw new WorkPartialFailureError(
    cleanupError
      ? "媒体已上传，但附件记录创建失败，且孤立文件未能自动清理。请重试或联系管理员。"
      : "媒体已上传，但附件记录创建失败；孤立文件已自动清理。",
    !cleanupError,
    insertError,
  );
}

export async function removeWorkAsset(assetId: string): Promise<void> {
  const user = await requireCurrentUser();
  const safeAssetId = assertUuid(assetId, "assetId");
  const supabase = getSupabaseBrowserClient();
  const { data, error: readError } = await supabase
    .from("work_assets")
    .select("*")
    .eq("id", safeAssetId)
    .eq("user_id", user.id)
    .single();
  if (readError) fail("读取待删除附件", readError);
  const asset = data as WorkAsset;
  const path = assertCanonicalWorkAssetPath(asset.storage_path, user.id, asset.work_id, asset.id);
  const { error: storageError } = await supabase.storage.from("work-media").remove([path]);
  if (storageError) throw new WorkPartialFailureError("附件文件删除失败，数据库记录已保留。", false, storageError);
  const { error: rowError } = await supabase.from("work_assets").delete().eq("id", safeAssetId).eq("user_id", user.id);
  if (rowError) throw new WorkPartialFailureError("附件文件已删除，但数据库记录删除失败。请刷新后重试。", false, rowError);
}

export async function publishWork(id: string): Promise<Work> {
  const user = await requireCurrentUser();
  const work = await getOwnedWorkRow(user, id);
  const assets = await getAssetsByWorkIds([work.id]);
  if (!work.title.trim() || (!work.body.trim() && assets.length === 0 && !work.source_music_track_id)) {
    throw new WorkDataError("发布前必须填写标题，并提供正文或至少一个媒体附件。");
  }
  return updateWorkDraft(work.id, { published: true });
}

export async function deleteWork(id: string): Promise<WorkDeletionResult> {
  const user = await requireCurrentUser();
  const work = await getOwnedWorkRow(user, id);
  const assets = await getAssetsByWorkIds([work.id]);
  const supabase = getSupabaseBrowserClient();
  const result: WorkDeletionResult = {
    workId: work.id,
    unpublished: !work.published,
    mediaDeleted: assets.length === 0,
    assetRowsDeleted: assets.length === 0,
    rowDeleted: false,
    mediaPaths: assets.map((asset) => asset.storage_path),
  };

  await runWorkDeletionStages({
    unpublish: work.published
      ? async () => {
          const { data, error } = await supabase
            .from("works")
            .update({ published: false })
            .eq("id", work.id)
            .eq("user_id", user.id)
            .select("id, published")
            .maybeSingle();
          if (error || !data || data.published !== false) {
            throw new WorkDeletionError("删除前下架作品失败；未删除媒体、附件记录或作品记录。", result, error);
          }
          result.unpublished = true;
        }
      : undefined,
    deleteStorage: async () => {
      try {
        for (const asset of assets) {
          assertCanonicalWorkAssetPath(asset.storage_path, user.id, work.id, asset.id);
        }
      } catch (error) {
        throw new WorkDeletionError("作品已下架，但媒体路径验证失败；附件记录和作品记录均已保留。", result, error);
      }

      if (result.mediaPaths.length > 0) {
        const { error } = await supabase.storage.from("work-media").remove(result.mediaPaths);
        if (error) {
          throw new WorkDeletionError("作品已下架，但媒体删除失败；附件记录和作品记录均已保留。", result, error);
        }
      }
      result.mediaDeleted = true;
    },
    deleteAssetRows: async () => {
      if (assets.length === 0) {
        result.assetRowsDeleted = true;
        return;
      }
      const { data, error } = await supabase
        .from("work_assets")
        .delete()
        .eq("work_id", work.id)
        .eq("user_id", user.id)
        .in("id", assets.map((asset) => asset.id))
        .select("id");
      const deletedIds = new Set((data ?? []).map((asset) => asset.id));
      const allExpectedRowsDeleted = assets.every((asset) => deletedIds.has(asset.id));
      if (error || !allExpectedRowsDeleted) {
        throw new WorkDeletionError(
          "媒体已删除，但附件记录删除失败或不完整；作品记录已保留。请刷新后重试。",
          result,
          error,
        );
      }
      result.assetRowsDeleted = true;
    },
    deleteWorkRow: async () => {
      const { data, error } = await supabase
        .from("works")
        .delete()
        .eq("id", work.id)
        .eq("user_id", user.id)
        .select("id")
        .maybeSingle();
      if (error || !data) {
        throw new WorkDeletionError(
          "媒体和附件记录已删除，但作品记录删除失败。请刷新后重试。",
          result,
          error,
        );
      }
      result.rowDeleted = true;
    },
  });
  return result;
}

export async function createSignedWorkAssetUrls(
  assets: WorkAsset[],
  expiresInSeconds = 3600,
): Promise<{ urls: Record<string, string>; errors: Record<string, string> }> {
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 86400) {
    throw new WorkDataError("Signed URL 有效期必须为 60 到 86400 秒之间的整数。");
  }
  const paths = [...new Set(assets.map((asset) =>
    assertCanonicalWorkAssetPath(asset.storage_path, asset.user_id, asset.work_id, asset.id)))];
  if (paths.length === 0) return { urls: {}, errors: {} };
  const { data, error } = await getSupabaseBrowserClient().storage.from("work-media").createSignedUrls(paths, expiresInSeconds);
  if (error) fail("创建作品媒体读取链接", error);
  const urls: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const [index, item] of (data ?? []).entries()) {
    const path = item.path ?? paths[index];
    if (!path) continue;
    if (item.signedUrl) urls[path] = item.signedUrl;
    else errors[path] = item.error ?? "无法创建签名链接";
  }
  return { urls, errors };
}
