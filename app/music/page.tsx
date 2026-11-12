"use client";

import visual from "./music.module.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/auth/AuthProvider";
import MusicPlayer from "../../components/music/MusicPlayer";
import TrackCover from "../../components/music/TrackCover";
import TrackFormModal from "../../components/music/TrackFormModal";
import WorksPlatform from "../../components/works/WorksPlatform";
import {
  createSignedMediaUrls,
  deleteTrack,
  downloadOwnTrackAudio,
  getOwnTracks,
  getProfilesByIds,
  getPublishedTracks,
  getTrackAudioSignedUrl,
} from "../../lib/music/tracks";
import { musicDownloadExtension, sanitizeMusicDownloadFilename } from "../../lib/music/download";
import type { MusicTrack, MusicTrackWithAuthor, Profile } from "../../lib/music/types";

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "请求未完成，请稍后重试。";
}

function formatDuration(duration: number | null): string {
  if (!duration || duration <= 0) return "--:--";
  return `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}`;
}

function downloadFormatLabel(track: Pick<MusicTrack, "audio_path">): string {
  return musicDownloadExtension(track.audio_path ?? "").toUpperCase();
}

function authorFor(track: MusicTrack, profiles: Record<string, Profile>) {
  const profile = profiles[track.user_id.toLowerCase()];
  if (!profile) return null;
  return { id: profile.id, display_name: profile.display_name, avatar_url: profile.avatar_url };
}

function authorName(track: MusicTrackWithAuthor): string {
  return track.author?.display_name.trim() || "Unknown artist";
}

type TrackRowProps = {
  coverUrl?: string;
  mine?: boolean;
  onDownload?: () => void;
  onDelete?: () => void;
  onEdit?: () => void;
  downloadDisabled?: boolean;
  onSelect: () => void;
  selected: boolean;
  track: MusicTrackWithAuthor;
};

function TrackRow({ coverUrl, mine = false, onDownload, onDelete, onEdit, downloadDisabled = false, onSelect, selected, track }: TrackRowProps) {
  const downloadFormat = downloadFormatLabel(track);
  return (
    <article className={`music-song-card ${selected ? "is-selected" : ""}`}>
      <button className="music-song-select" onClick={onSelect} type="button">
        <TrackCover title={track.title} url={coverUrl} />
        <span className="music-song-copy">
          <strong>{track.title}</strong>
          <span>{authorName(track)}</span>
          <span className="music-tags">
            {track.genre && <i>{track.genre}</i>}
            {mine && <i>{track.published ? "已发布" : track.audio_path ? "可发布" : "草稿"}</i>}
          </span>
        </span>
        <span className="music-song-duration">{formatDuration(track.duration_seconds)}</span>
        <span className="music-song-play">▶</span>
      </button>
      {mine && (
        <span className="music-row-actions">
          {track.audio_path && onDownload && (
            <button disabled={downloadDisabled} onClick={onDownload} type="button">
              {downloadDisabled ? `正在准备 ${downloadFormat}…` : `下载 ${downloadFormat}`}
            </button>
          )}
          <button onClick={onEdit} type="button">编辑</button>
          <button className="is-danger" onClick={onDelete} type="button">删除</button>
        </span>
      )}
    </article>
  );
}

export default function MusicPage() {
  const router = useRouter();
  const { user, displayName, loading: authLoading } = useAuth();
  const requestVersion = useRef(0);
  const [publishedTracks, setPublishedTracks] = useState<MusicTrackWithAuthor[]>([]);
  const [ownTracks, setOwnTracks] = useState<MusicTrackWithAuthor[]>([]);
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [editingTrack, setEditingTrack] = useState<MusicTrack | null | undefined>(undefined);
  const [deletingTrackId, setDeletingTrackId] = useState<string | null>(null);
  const [downloadingTrackId, setDownloadingTrackId] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioRetry, setAudioRetry] = useState(0);

  const loadTracks = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    setWarning(null);
    try {
      const [published, mine] = await Promise.all([
        getPublishedTracks(),
        user ? getOwnTracks() : Promise.resolve([]),
      ]);
      const uniqueTracks = [...new Map([...published, ...mine].map((track) => [track.id, track])).values()];
      let profiles: Record<string, Profile> = {};
      let nextWarning: string | null = null;
      try {
        profiles = await getProfilesByIds(uniqueTracks.map((track) => track.user_id));
      } catch {
        nextWarning = "部分创作者资料暂时无法读取，已使用 Unknown artist 代替。";
      }

      const withAuthors = (tracks: MusicTrack[]): MusicTrackWithAuthor[] =>
        tracks.map((track) => ({ ...track, author: authorFor(track, profiles) }));

      let nextCoverUrls: Record<string, string> = {};
      const coverPaths = uniqueTracks.flatMap((track) => track.cover_path ? [track.cover_path] : []);
      if (coverPaths.length > 0) {
        try {
          const signed = await createSignedMediaUrls("music-covers", coverPaths);
          nextCoverUrls = signed.urls;
          if (Object.keys(signed.errors).length > 0) {
            nextWarning = "部分歌曲封面暂时无法加载，已显示默认封面。";
          }
        } catch {
          nextWarning = "歌曲封面暂时无法加载，已显示默认封面。";
        }
      }

      if (version !== requestVersion.current) return;
      setPublishedTracks(withAuthors(published));
      setOwnTracks(withAuthors(mine));
      setCoverUrls(nextCoverUrls);
      setWarning(nextWarning);
    } catch (loadError) {
      if (version === requestVersion.current) setError(messageFrom(loadError));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading) return;
    void loadTracks();
    return () => {
      requestVersion.current += 1;
    };
  }, [authLoading, loadTracks]);

  const availableTracks = useMemo(
    () => [...new Map([...publishedTracks, ...ownTracks].map((track) => [track.id, track])).values()],
    [ownTracks, publishedTracks],
  );
  const selectedTrack = availableTracks.find((track) => track.id === selectedTrackId) ?? publishedTracks[0] ?? ownTracks[0] ?? null;

  useEffect(() => {
    if (selectedTrack && selectedTrack.id !== selectedTrackId) setSelectedTrackId(selectedTrack.id);
    if (!selectedTrack && selectedTrackId) setSelectedTrackId(null);
  }, [selectedTrack, selectedTrackId]);

  useEffect(() => {
    let active = true;
    setAudioUrl(null);
    setAudioError(null);
    if (!selectedTrack?.audio_path) {
      setAudioLoading(false);
      return () => { active = false; };
    }
    setAudioLoading(true);
    void getTrackAudioSignedUrl(selectedTrack)
      .then((asset) => {
        if (active) setAudioUrl(asset.signedUrl);
      })
      .catch((signError) => {
        if (active) setAudioError(messageFrom(signError));
      })
      .finally(() => {
        if (active) setAudioLoading(false);
      });
    return () => { active = false; };
  }, [audioRetry, selectedTrack?.audio_path, selectedTrack?.id]);

  const openUpload = () => {
    setNotice(null);
    if (!user) {
      router.push("/auth");
      return;
    }
    setEditingTrack(null);
  };

  const removeTrack = async (track: MusicTrack) => {
    if (!window.confirm(`确定删除《${track.title}》吗？音频和封面也会被删除，此操作不可撤销。`)) return;
    setDeletingTrackId(track.id);
    setError(null);
    setNotice(null);
    try {
      await deleteTrack(track.id);
      if (selectedTrackId === track.id) setSelectedTrackId(null);
      setNotice("作品、音频和封面已删除。");
      await loadTracks();
    } catch (deleteError) {
      const deletionMessage = messageFrom(deleteError);
      await loadTracks().catch(() => undefined);
      setError(deletionMessage);
    } finally {
      setDeletingTrackId(null);
    }
  };

  const downloadTrack = async (track: MusicTrack) => {
    if (!user) {
      router.push("/auth");
      return;
    }
    if (track.user_id.toLowerCase() !== user.id.toLowerCase()) {
      setError("只能下载自己的音乐作品。");
      return;
    }
    setDownloadingTrackId(track.id);
    setError(null);
    setNotice(null);
    let objectUrl: string | null = null;
    let link: HTMLAnchorElement | null = null;
    let cleanupDeferred = false;
    const cleanupDownload = () => {
      link?.remove();
      link = null;
      const urlToRevoke = objectUrl;
      objectUrl = null;
      if (urlToRevoke) window.URL.revokeObjectURL(urlToRevoke);
    };
    try {
      const { blob, title, format } = await downloadOwnTrackAudio(track.id);
      objectUrl = window.URL.createObjectURL(blob);
      link = document.createElement("a");
      link.href = objectUrl;
      link.download = sanitizeMusicDownloadFilename(title, format);
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      setNotice(`${format.toUpperCase()} 下载已开始。`);
      cleanupDeferred = true;
      window.setTimeout(cleanupDownload, 1000);
    } catch (downloadError) {
      setError(messageFrom(downloadError));
    } finally {
      if (!cleanupDeferred) cleanupDownload();
      setDownloadingTrackId(null);
    }
  };

  const drafts = ownTracks.filter((track) => !track.published);
  const myPublished = ownTracks.filter((track) => track.published);

  return (
    <main className={`platform-page music-page ${visual.page}`}>
      <section className="platform-page-heading">
        <div>
          <h1>作品广场</h1>
        </div>
        <button className="platform-secondary-button" onClick={openUpload} type="button">上传音乐音轨</button>
      </section>

      <WorksPlatform />

      {error && <div className="music-page-message is-error" role="alert">{error}<button onClick={() => void loadTracks()} type="button">重试</button></div>}
      {warning && <div className="music-page-message is-warning" role="status">{warning}</div>}
      {notice && <div className="music-page-message is-success" role="status">{notice}</div>}

      <section className="music-track-library-heading"><h2>音乐音轨库</h2></section>
      <div className="music-layout">
        <section className="music-catalog">
          <div className="music-catalog-title"><h2>公开音轨</h2></div>
          {loading && <div className="music-empty-state">正在读取音乐作品…</div>}
          {!loading && !error && publishedTracks.length === 0 && (
            <div className="music-empty-state"><strong>还没有公开作品</strong></div>
          )}
          {!loading && publishedTracks.map((track) => (
            <TrackRow
              coverUrl={track.cover_path ? coverUrls[track.cover_path] : undefined}
              key={track.id}
              onSelect={() => setSelectedTrackId(track.id)}
              selected={selectedTrack?.id === track.id}
              track={track}
            />
          ))}
        </section>

        <aside className="music-now-playing">
          <p className="platform-kicker">正在播放</p>
          {selectedTrack ? (
            <>
              <TrackCover className="music-cover-large" title={selectedTrack.title} url={selectedTrack.cover_path ? coverUrls[selectedTrack.cover_path] : undefined} />
              <h2>{selectedTrack.title}</h2>
              <p>{authorName(selectedTrack)}</p>
              {selectedTrack.artist_name !== authorName(selectedTrack) && <small className="music-credit">作品署名：{selectedTrack.artist_name}</small>}
              <div className="music-tags">{selectedTrack.genre && <i>{selectedTrack.genre}</i>}</div>
              {selectedTrack.description && <p className="music-track-description">{selectedTrack.description}</p>}
              <MusicPlayer
                artist={authorName(selectedTrack)}
                durationSeconds={selectedTrack.duration_seconds ?? 0}
                error={audioError || (!selectedTrack.audio_path ? "这份草稿还没有音频。" : null)}
                loading={audioLoading}
                onRetry={selectedTrack.audio_path ? () => setAudioRetry((value) => value + 1) : undefined}
                src={audioUrl}
                title={selectedTrack.title}
              />
              {user && selectedTrack.user_id.toLowerCase() === user.id.toLowerCase() && selectedTrack.audio_path && (
                <button
                  className="platform-secondary-button music-download-button"
                  disabled={downloadingTrackId === selectedTrack.id}
                  onClick={() => void downloadTrack(selectedTrack)}
                  type="button"
                >
                  {downloadingTrackId === selectedTrack.id ? `正在准备 ${downloadFormatLabel(selectedTrack)}…` : `下载 ${downloadFormatLabel(selectedTrack)}`}
                </button>
              )}
            </>
          ) : (
            <div className="music-empty-state"><strong>还未选择音乐</strong><span>从音轨库选择一首试听。</span></div>
          )}
        </aside>
      </div>

      <section className="music-my-works">
        <div className="music-catalog-title"><h2>我的音轨</h2></div>
        {!user && !authLoading && <div className="music-empty-state"><strong>登录后管理作品</strong><span>草稿只对你本人可见。</span><button onClick={() => router.push("/auth")} type="button">前往登录</button></div>}
        {user && loading && <div className="music-empty-state">正在读取我的作品…</div>}
        {user && !loading && ownTracks.length === 0 && <div className="music-empty-state"><strong>你还没有作品</strong><span>通过“上传音乐音轨”创建草稿。</span></div>}
        {user && !loading && ownTracks.length > 0 && (
          <div className="music-work-columns">
            <div><h3>草稿 <span>{drafts.length}</span></h3>{drafts.length === 0 && <p className="music-inline-empty">没有草稿</p>}{drafts.map((track) => (
              <TrackRow coverUrl={track.cover_path ? coverUrls[track.cover_path] : undefined} downloadDisabled={downloadingTrackId === track.id} key={track.id} mine onDelete={() => void removeTrack(track)} onDownload={() => void downloadTrack(track)} onEdit={() => setEditingTrack(track)} onSelect={() => setSelectedTrackId(track.id)} selected={selectedTrack?.id === track.id} track={track} />
            ))}</div>
            <div><h3>已发布 <span>{myPublished.length}</span></h3>{myPublished.length === 0 && <p className="music-inline-empty">还没有已发布作品</p>}{myPublished.map((track) => (
              <TrackRow coverUrl={track.cover_path ? coverUrls[track.cover_path] : undefined} downloadDisabled={downloadingTrackId === track.id} key={track.id} mine onDelete={() => void removeTrack(track)} onDownload={() => void downloadTrack(track)} onEdit={() => setEditingTrack(track)} onSelect={() => setSelectedTrackId(track.id)} selected={selectedTrack?.id === track.id} track={track} />
            ))}</div>
          </div>
        )}
        {deletingTrackId && <p className="music-delete-progress" role="status">正在按安全顺序删除媒体和作品记录…</p>}
      </section>

      {editingTrack !== undefined && user && (
        <TrackFormModal
          defaultArtist={displayName}
          initialTrack={editingTrack}
          onChanged={loadTracks}
          onClose={() => setEditingTrack(undefined)}
        />
      )}
    </main>
  );
}
