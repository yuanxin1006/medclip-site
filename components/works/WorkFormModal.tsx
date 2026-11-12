"use client";

import { useEffect, useMemo, useState } from "react";
import {
  assertWorkAssetCount,
  MAX_WORK_ASSETS,
  validateWorkAssetFile,
} from "../../lib/works/files";
import {
  createWorkDraft,
  createSignedWorkAssetUrls,
  getOwnWork,
  publishWork,
  removeWorkAsset,
  updateWorkDraft,
  uploadWorkAsset,
} from "../../lib/works/works";
import { mergePersistedWork, refreshPersistedMutation, runMutationThenRefresh } from "../../lib/works/consistency";
import type { WorkAssetType, WorkWithAssets } from "../../lib/works/types";
import { hasUnsavedWorkChanges, isWorkPublishReady } from "../../lib/works/workflow";
import WorkAssetMedia from "./WorkAssetMedia";

type WorkFormModalProps = {
  initialWork?: WorkWithAssets | null;
  onChanged: () => Promise<void>;
  onClose: () => void;
};

type PendingFile = {
  id: string;
  file: File;
  assetType: WorkAssetType;
};

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请稍后重试。";
}

function PendingPreview({ pending }: { pending: PendingFile }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const nextUrl = URL.createObjectURL(pending.file);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [pending.file]);
  if (!url) return <span className="work-media-loading">正在准备预览…</span>;
  if (pending.assetType === "image") return <img alt={pending.file.name} loading="lazy" src={url} />;
  if (pending.assetType === "video") return <video controls preload="metadata" src={url} />;
  return <audio controls preload="metadata" src={url} />;
}

export default function WorkFormModal({ initialWork = null, onChanged, onClose }: WorkFormModalProps) {
  const [work, setWork] = useState<WorkWithAssets | null>(initialWork);
  const [title, setTitle] = useState(initialWork?.title ?? "");
  const [body, setBody] = useState(initialWork?.body ?? "");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [assetErrors, setAssetErrors] = useState<Record<string, string>>({});

  const assetPathKey = work?.assets.map((asset) => asset.storage_path).join("|") ?? "";
  useEffect(() => {
    let active = true;
    if (!work || work.assets.length === 0) {
      setAssetUrls({});
      setAssetErrors({});
      return () => { active = false; };
    }
    void createSignedWorkAssetUrls(work.assets)
      .then((signed) => {
        if (!active) return;
        setAssetUrls(signed.urls);
        setAssetErrors(signed.errors);
      })
      .catch(() => {
        if (active) setAssetErrors(Object.fromEntries(work.assets.map((asset) => [asset.storage_path, "无法取得安全预览链接。"])));
      });
    return () => { active = false; };
  }, [assetPathKey, work]);

  const publishState = useMemo(() => ({
    title,
    body,
    sourceMusicTrackId: work?.source_music_track_id ?? null,
    existingAssetCount: work?.assets.length ?? 0,
    pendingAssetCount: pendingFiles.length,
    removedAssetCount: 0,
    incomplete,
    work,
  }), [body, incomplete, pendingFiles.length, title, work]);
  const hasUnsavedChanges = hasUnsavedWorkChanges(publishState);
  const canPublish = isWorkPublishReady(publishState);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    setError(null);
    try {
      const additions = [...files].map((file) => ({
        id: crypto.randomUUID(),
        file,
        assetType: validateWorkAssetFile(file).assetType,
      }));
      assertWorkAssetCount((work?.assets.length ?? 0) + pendingFiles.length, additions.length);
      setPendingFiles((current) => [...current, ...additions]);
    } catch (selectionError) {
      setError(messageFrom(selectionError));
    }
  };

  const saveDraft = async () => {
    const cleanTitle = title.trim();
    const cleanBody = body.trim();
    if (!cleanTitle) {
      setError("请填写作品标题。");
      return;
    }
    if (!cleanBody && (work?.assets.length ?? 0) + pendingFiles.length === 0 && !work?.source_music_track_id) {
      setError("请填写正文或至少添加一个媒体附件。");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    let current = work;
    let persistenceStarted = false;
    const savedPendingIds = new Set<string>();
    const creating = !current;
    try {
      const previous = current;
      const mutation = await runMutationThenRefresh(
        () => creating
          ? createWorkDraft({ title: cleanTitle, body: cleanBody })
          : updateWorkDraft(previous!.id, { title: cleanTitle, body: cleanBody, published: false }),
        (persisted) => getOwnWork(persisted.id),
        (persisted) => {
          persistenceStarted = true;
          current = mergePersistedWork(previous, persisted);
          setWork(current);
        },
      );
      current = mutation.hydrated ?? mergePersistedWork(previous, mutation.persisted);
      setWork(current);

      let nextOrder = current.assets.length;
      for (const pending of pendingFiles) {
        const uploaded = await uploadWorkAsset(current.id, pending.file, nextOrder, pending.id);
        current = { ...current, assets: [...current.assets, uploaded] };
        setWork(current);
        savedPendingIds.add(pending.id);
        nextOrder += 1;
      }

      const refreshed = await refreshPersistedMutation(current, (persisted) => getOwnWork(persisted.id));
      current = refreshed.hydrated ?? current;
      setWork(current);
      setTitle(current.title);
      setBody(current.body);
      setPendingFiles([]);
      setIncomplete(false);
      let successNotice = refreshed.refreshError
        ? creating
          ? "草稿已创建，但作品详情暂时未能刷新。不会重复创建草稿，可稍后重新打开。"
          : "更新已保存，但最新作品详情暂时无法读取。无需重复提交，可稍后重新打开。"
        : current.assets.length > 0
          ? "草稿和媒体已保存，确认内容后可单独发布。"
          : "纯文字草稿已保存，确认内容后可单独发布。";
      try {
        await onChanged();
      } catch {
        successNotice = `${successNotice} 作品列表也暂时未能刷新。`;
      }
      setNotice(successNotice);
    } catch (saveError) {
      if (persistenceStarted) setIncomplete(true);
      if (savedPendingIds.size > 0) {
        setPendingFiles((files) => files.filter((pending) => !savedPendingIds.has(pending.id)));
      }
      setError(`${messageFrom(saveError)}${persistenceStarted ? " 已成功保存的数据会保留，可直接重试。" : ""}`);
      if (current) {
        const refreshed = await getOwnWork(current.id).catch(() => null);
        if (refreshed) setWork(refreshed);
      }
      await onChanged().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const removeExisting = async (assetId: string) => {
    if (!work || !window.confirm("确定删除这个媒体附件吗？此操作不可撤销。")) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const wasPublished = work.published;
    let unpublished = false;
    let current = work;
    try {
      if (wasPublished) {
        const outcome = await runMutationThenRefresh(
          () => updateWorkDraft(work.id, { published: false }),
          (persisted) => getOwnWork(persisted.id),
          (persisted) => {
            unpublished = true;
            current = mergePersistedWork(current, persisted);
            setWork(current);
          },
        );
        current = outcome.hydrated ?? current;
        setWork(current);
        setNotice(outcome.refreshError
          ? "作品已经下架，但最新作品详情暂时无法读取；正在继续删除附件。"
          : "作品已下架，正在继续删除附件。");
        await onChanged().catch(() => setNotice("作品已经下架，但父级作品列表暂时未刷新；正在继续删除附件。"));
      }
      await removeWorkAsset(assetId);
      current = { ...current, assets: current.assets.filter((asset) => asset.id !== assetId), published: false };
      setWork(current);
      const refreshed = await refreshPersistedMutation(current, (persisted) => getOwnWork(persisted.id));
      current = refreshed.hydrated ?? current;
      setWork(current);
      setIncomplete(false);
      let successNotice = refreshed.refreshError
        ? "附件已删除，作品保持为草稿，但最新作品详情暂时无法读取。"
        : "附件已删除，作品保持为草稿。确认内容后可重新发布。";
      await onChanged().catch(() => { successNotice = `${successNotice} 作品列表暂时未刷新。`; });
      setNotice(successNotice);
    } catch (removeError) {
      setIncomplete(true);
      if (wasPublished && !unpublished) {
        setError(`作品下架失败，附件完全没有删除：${messageFrom(removeError)}`);
      } else if (unpublished) {
        setError(`作品已经下架并保持为草稿，但附件删除失败：${messageFrom(removeError)}`);
      } else {
        setError(messageFrom(removeError));
      }
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!work || !canPublish) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const published = await publishWork(work.id);
      setWork(mergePersistedWork(work, published));
      setIncomplete(false);
      setNotice("作品已发布，访客现在可以阅读并通过安全链接查看媒体。");
      await onChanged().catch(() => setNotice("作品已发布，但作品列表暂时未刷新。"));
    } catch (publishError) {
      setError(messageFrom(publishError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="platform-modal-backdrop" role="presentation">
      <section aria-labelledby="work-form-title" aria-modal="true" className="platform-modal work-form-modal" role="dialog">
        <button aria-label="关闭作品窗口" className="platform-modal-close" disabled={busy} onClick={onClose} type="button">×</button>
        <h2 id="work-form-title">{work ? "编辑作品" : "发布新作品"}</h2>
        <p className="work-form-intro">先保存草稿，再发布作品。</p>
        <div className="platform-form">
          <label>标题<input disabled={busy} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="作品标题" value={title} /></label>
          <label>正文<textarea disabled={busy} maxLength={50000} onChange={(event) => setBody(event.target.value)} placeholder="写下创作说明、故事或正文……" rows={7} value={body} /></label>
          <label className="platform-file-field">添加图片、视频或音频
            <input accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/x-wav,audio/wave" disabled={busy} multiple onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} type="file" />
            <span>最多 {MAX_WORK_ASSETS} 个附件；图片 10 MB、视频 200 MB、音频 100 MB。</span>
          </label>
        </div>

        {(work?.assets.length || pendingFiles.length) ? (
          <div className="work-form-assets">
            <h3>已添加媒体 <span>{(work?.assets.length ?? 0) + pendingFiles.length}/{MAX_WORK_ASSETS}</span></h3>
            {work?.assets.map((asset) => (
              <div className="work-form-asset" key={asset.id}>
                <WorkAssetMedia asset={asset} title={work.title} url={assetUrls[asset.storage_path]} urlError={assetErrors[asset.storage_path]} />
                <span>{{ image: "图片", video: "视频", audio: "音频" }[asset.asset_type]}，已保存，顺序 {asset.sort_order + 1}</span>
                <button disabled={busy} onClick={() => void removeExisting(asset.id)} type="button">删除</button>
              </div>
            ))}
            {pendingFiles.map((pending, index) => (
              <div className="work-form-asset" key={pending.id}>
                <PendingPreview pending={pending} />
                <span>{{ image: "图片", video: "视频", audio: "音频" }[pending.assetType]}，待保存，顺序 {(work?.assets.length ?? 0) + index + 1}</span>
                <button disabled={busy} onClick={() => setPendingFiles((files) => files.filter((item) => item.id !== pending.id))} type="button">移除</button>
              </div>
            ))}
          </div>
        ) : null}

        {hasUnsavedChanges && work && !error && <p className="work-unsaved-note">存在未保存修改，请先保存草稿再发布。</p>}
        {error && <p className="music-form-error" role="alert">{error}</p>}
        {notice && <p className="music-form-notice" role="status">{notice}</p>}
        <div className="music-form-actions">
          <button className="platform-secondary-button" disabled={busy} onClick={() => void saveDraft()} type="button">{busy ? "处理中…" : "保存草稿"}</button>
          <button className="platform-primary-button" disabled={busy || !canPublish} onClick={() => void publish()} type="button">{work?.published ? "已发布" : "发布作品"}</button>
        </div>
      </section>
    </div>
  );
}
