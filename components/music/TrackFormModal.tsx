"use client";

import { useMemo, useState } from "react";
import { readAudioDurationSeconds, validateAudioFile, validateCoverFile } from "../../lib/music/files";
import {
  createTrack,
  publishTrack,
  removeTrackAsset,
  updateTrack,
  uploadTrackAudio,
  uploadTrackCover,
} from "../../lib/music/tracks";
import type { MusicTrack } from "../../lib/music/types";
import { hasUnsavedTrackChanges, isTrackPublishReady } from "../../lib/music/workflow";

type TrackFormModalProps = {
  defaultArtist: string;
  initialTrack?: MusicTrack | null;
  onChanged: () => Promise<void>;
  onClose: () => void;
};

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请稍后重试。";
}

function stateLabel(track: MusicTrack | null, incomplete: boolean): string {
  if (incomplete) return "Upload incomplete";
  if (track?.published) return "Published";
  if (track?.audio_path && track.duration_seconds && track.duration_seconds > 0) return "Ready to publish";
  return "Draft";
}

export default function TrackFormModal({ defaultArtist, initialTrack = null, onChanged, onClose }: TrackFormModalProps) {
  const [track, setTrack] = useState<MusicTrack | null>(initialTrack);
  const [title, setTitle] = useState(initialTrack?.title ?? "");
  const [artistName, setArtistName] = useState(initialTrack?.artist_name ?? defaultArtist);
  const [description, setDescription] = useState(initialTrack?.description ?? "");
  const [genre, setGenre] = useState(initialTrack?.genre ?? "");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { canPublish, hasUnsavedChanges } = useMemo(() => {
    const publishState = {
      artistName,
      audioSelected: audioFile !== null,
      coverSelected: coverFile !== null,
      description,
      genre,
      incomplete,
      title,
      track,
    };
    return {
      canPublish: isTrackPublishReady(publishState),
      hasUnsavedChanges: hasUnsavedTrackChanges(publishState),
    };
  }, [artistName, audioFile, coverFile, description, genre, incomplete, title, track]);

  const saveDraft = async () => {
    setError(null);
    setNotice(null);
    const cleanTitle = title.trim();
    const cleanArtist = artistName.trim();
    if (!cleanTitle || !cleanArtist) {
      setError("歌曲名称和创作者不能为空。");
      return;
    }
    try {
      if (audioFile) validateAudioFile(audioFile);
      if (coverFile) validateCoverFile(coverFile);
    } catch (validationError) {
      setError(messageFrom(validationError));
      return;
    }

    setBusy(true);
    let current = track;
    let persistenceStarted = false;
    const cleanupWarnings: string[] = [];
    try {
      const validatedAudioDuration = audioFile ? await readAudioDurationSeconds(audioFile) : null;

      if (!current) {
        current = await createTrack({
          title: cleanTitle,
          artist_name: cleanArtist,
          description: description.trim(),
          genre: genre.trim() || undefined,
        });
        persistenceStarted = true;
        setTrack(current);
      } else {
        current = await updateTrack(current.id, {
          title: cleanTitle,
          artist_name: cleanArtist,
          description: description.trim(),
          genre: genre.trim() || null,
          ...(audioFile ? { duration_seconds: null, published: false } : {}),
        });
        persistenceStarted = true;
        setTrack(current);
      }

      if (audioFile && validatedAudioDuration !== null) {
        const previousPath = current.audio_path;
        const uploaded = await uploadTrackAudio(current.id, audioFile);
        try {
          current = await updateTrack(current.id, {
            audio_path: uploaded.path,
            duration_seconds: validatedAudioDuration,
            published: false,
          });
        } catch (bindingError) {
          let cleanupResult = "同路径覆盖对象已保留，作品仍处于未发布且无有效时长状态。";
          if (uploaded.path !== previousPath) {
            try {
              await removeTrackAsset("music-audio", uploaded.path, current.id);
              cleanupResult = "未绑定的新音频已清理。";
            } catch (cleanupError) {
              cleanupResult = `警告：未绑定的新音频清理失败：${messageFrom(cleanupError)}`;
            }
          }
          throw new Error(`音频已上传，但数据库绑定失败：${messageFrom(bindingError)} ${cleanupResult}`);
        }
        setTrack(current);
        setAudioFile(null);
        if (previousPath && previousPath !== uploaded.path) {
          try {
            await removeTrackAsset("music-audio", previousPath, current.id);
          } catch {
            cleanupWarnings.push("旧音频未能自动清理");
          }
        }
      }

      if (coverFile) {
        const previousPath = current.cover_path;
        const uploaded = await uploadTrackCover(current.id, coverFile);
        try {
          current = await updateTrack(current.id, { cover_path: uploaded.path });
        } catch (bindingError) {
          let cleanupResult = "同路径覆盖对象已保留，作品原有 canonical path 未改变。";
          if (uploaded.path !== previousPath) {
            try {
              await removeTrackAsset("music-covers", uploaded.path, current.id);
              cleanupResult = "未绑定的新封面已清理。";
            } catch (cleanupError) {
              cleanupResult = `警告：未绑定的新封面清理失败：${messageFrom(cleanupError)}`;
            }
          }
          throw new Error(`封面已上传，但数据库绑定失败：${messageFrom(bindingError)} ${cleanupResult}`);
        }
        setTrack(current);
        if (previousPath && previousPath !== uploaded.path) {
          try {
            await removeTrackAsset("music-covers", previousPath, current.id);
          } catch {
            cleanupWarnings.push("旧封面未能自动清理");
          }
        }
      }

      setAudioFile(null);
      setCoverFile(null);
      setIncomplete(false);
      const savedMessage = current.published
        ? "更改已保存，作品保持发布状态。"
        : current.audio_path
          ? "草稿已保存，确认信息后可单独点击发布。"
          : "草稿已保存，可稍后继续上传音频。";
      const finalMessage = cleanupWarnings.length > 0 ? `${savedMessage} 注意：${cleanupWarnings.join("、")}。` : savedMessage;
      setNotice(finalMessage);
      try {
        await onChanged();
      } catch {
        setNotice(`${finalMessage} 作品列表暂时未能刷新，请稍后重新打开页面确认。`);
      }
    } catch (saveError) {
      if (persistenceStarted) setIncomplete(true);
      const cleanupMessage = cleanupWarnings.length > 0 ? ` 注意：${cleanupWarnings.join("、")}。` : "";
      const retryMessage = persistenceStarted && current ? " 草稿已保留，可直接重试。" : "";
      setError(`${messageFrom(saveError)}${retryMessage}${cleanupMessage}`);
      if (current) setTrack(current);
      await onChanged().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!track || !canPublish) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const published = await publishTrack(track.id);
      setTrack(published);
      setIncomplete(false);
      setNotice("作品已发布，其他访客现在可以浏览和播放。");
      await onChanged();
    } catch (publishError) {
      setError(messageFrom(publishError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="platform-modal-backdrop" role="presentation">
      <section aria-labelledby="track-form-title" aria-modal="true" className="platform-modal music-track-modal" role="dialog">
        <button aria-label="关闭作品窗口" className="platform-modal-close" disabled={busy} onClick={onClose} type="button">×</button>
        <div className="music-modal-heading">
          <h2 id="track-form-title">{initialTrack ? "编辑作品" : "上传作品"}</h2>
          <span className="music-work-status">{stateLabel(track, incomplete)}</span>
        </div>
        <p>先保存草稿。上传音频并读取时长后可发布。</p>
        <form className="platform-form" onSubmit={(event) => { event.preventDefault(); void saveDraft(); }}>
          <label>歌曲名称<input disabled={busy} maxLength={120} onChange={(event) => setTitle(event.target.value)} required value={title} /></label>
          <label>创作者<input disabled={busy} maxLength={120} onChange={(event) => setArtistName(event.target.value)} required value={artistName} /></label>
          <label>歌曲简介<textarea disabled={busy} maxLength={2000} onChange={(event) => setDescription(event.target.value)} rows={3} value={description} /></label>
          <label>音乐风格 / 标签<input disabled={busy} maxLength={80} onChange={(event) => setGenre(event.target.value)} placeholder="例如：独立流行" value={genre} /></label>
          <label className="platform-file-field">
            {track?.audio_path ? "替换音频文件" : "音频文件"}
            <input accept="audio/mpeg,audio/wav,audio/x-wav,audio/wave,.mp3,.wav" disabled={busy} onChange={(event) => setAudioFile(event.target.files?.[0] ?? null)} type="file" />
            <span>{audioFile?.name || (track?.audio_path ? `已上传，${track.duration_seconds ?? "?"} 秒` : "MP3 / WAV，最大 100 MB")}</span>
          </label>
          <label className="platform-file-field">
            {track?.cover_path ? "替换歌曲封面" : "歌曲封面（可选）"}
            <input accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" disabled={busy} onChange={(event) => setCoverFile(event.target.files?.[0] ?? null)} type="file" />
            <span>{coverFile?.name || (track?.cover_path ? "已上传封面" : "JPEG / PNG / WebP，最大 10 MB")}</span>
          </label>
          {error && <p className="music-form-message is-error" role="alert">{error}</p>}
          {notice && <p className="music-form-message is-success" role="status">{notice}</p>}
          {track && !track.published && hasUnsavedChanges && !error && (
            <p className="music-form-message" role="status">请先保存当前修改，再发布作品。</p>
          )}
          <div className="music-form-actions">
            <button className="platform-secondary-button" disabled={busy} type="submit">{busy ? "正在处理…" : "保存草稿 / 上传文件"}</button>
            <button className="platform-primary-button" disabled={busy || !canPublish} onClick={() => void publish()} type="button">
              {track?.published ? "已发布" : "发布作品"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
