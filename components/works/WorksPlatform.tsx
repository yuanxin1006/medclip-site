"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../auth/AuthProvider";
import {
  createSignedWorkAssetUrls,
  deleteWork,
  getOwnWorks,
  getPublishedWorks,
} from "../../lib/works/works";
import type { WorkWithAssets } from "../../lib/works/types";
import WorkCard from "./WorkCard";
import WorkFormModal from "./WorkFormModal";

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "请求未完成，请稍后重试。";
}

export default function WorksPlatform() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const requestVersion = useRef(0);
  const [publishedWorks, setPublishedWorks] = useState<WorkWithAssets[]>([]);
  const [ownWorks, setOwnWorks] = useState<WorkWithAssets[]>([]);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [assetErrors, setAssetErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingWork, setEditingWork] = useState<WorkWithAssets | null | undefined>(undefined);
  const [deletingWorkId, setDeletingWorkId] = useState<string | null>(null);

  const loadWorks = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    setWarning(null);
    try {
      const [published, mine] = await Promise.all([
        getPublishedWorks(),
        user ? getOwnWorks() : Promise.resolve([]),
      ]);
      const allWorks = [...new Map([...published, ...mine].map((work) => [work.id, work])).values()];
      const allAssets = allWorks.flatMap((work) => work.assets);
      let signed = { urls: {} as Record<string, string>, errors: {} as Record<string, string> };
      if (allAssets.length > 0) {
        try {
          signed = await createSignedWorkAssetUrls(allAssets);
        } catch {
          setWarning("作品已加载，但部分媒体的安全读取链接暂时不可用。");
        }
      }
      if (version !== requestVersion.current) return;
      setPublishedWorks(published);
      setOwnWorks(mine);
      setAssetUrls(signed.urls);
      setAssetErrors(signed.errors);
      if (Object.keys(signed.errors).length > 0) setWarning("部分作品媒体暂时无法加载，其他内容仍可正常浏览。");
    } catch (loadError) {
      if (version === requestVersion.current) setError(messageFrom(loadError));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading) return;
    void loadWorks();
    return () => { requestVersion.current += 1; };
  }, [authLoading, loadWorks]);

  const openNewWork = () => {
    setNotice(null);
    if (!user) {
      router.push("/auth");
      return;
    }
    setEditingWork(null);
  };

  const remove = async (work: WorkWithAssets) => {
    if (!window.confirm(`确定删除《${work.title}》吗？作品媒体也会按安全顺序删除，此操作不可撤销。`)) return;
    setDeletingWorkId(work.id);
    setError(null);
    setNotice(null);
    try {
      await deleteWork(work.id);
      setNotice("作品及其媒体已删除。");
      await loadWorks();
    } catch (deleteError) {
      await loadWorks().catch(() => undefined);
      setError(messageFrom(deleteError));
    } finally {
      setDeletingWorkId(null);
    }
  };

  const drafts = useMemo(() => ownWorks.filter((work) => !work.published), [ownWorks]);
  const myPublished = useMemo(() => ownWorks.filter((work) => work.published), [ownWorks]);

  return (
    <section className="works-platform" aria-labelledby="latest-works-title">
      <div className="works-section-heading">
        <div><h2 id="latest-works-title">最新作品</h2></div>
        <button className="platform-primary-button" onClick={openNewWork} type="button">发布作品</button>
      </div>

      {error && <div className="music-page-message is-error" role="alert">{error}<button onClick={() => void loadWorks()} type="button">重试</button></div>}
      {warning && <div className="music-page-message is-warning" role="status">{warning}</div>}
      {notice && <div className="music-page-message is-success" role="status">{notice}</div>}

      {loading && <div className="music-empty-state">正在读取多媒体作品…</div>}
      {!loading && !error && publishedWorks.length === 0 && <div className="music-empty-state"><strong>还没有公开作品</strong></div>}
      {!loading && publishedWorks.length > 0 && (
        <div className="works-feed">
          {publishedWorks.map((work) => <WorkCard assetErrors={assetErrors} assetUrls={assetUrls} key={work.id} work={work} />)}
        </div>
      )}

      <section className="works-private-section">
        <div className="music-catalog-title"><h2>我的多媒体作品</h2></div>
        {!user && !authLoading && <div className="music-empty-state"><strong>登录后管理作品</strong><span>草稿和未发布媒体只对你本人可见。</span><button onClick={() => router.push("/auth")} type="button">前往登录</button></div>}
        {user && loading && <div className="music-empty-state">正在读取我的作品…</div>}
        {user && !loading && ownWorks.length === 0 && <div className="music-empty-state"><strong>你还没有多媒体作品</strong></div>}
        {user && !loading && ownWorks.length > 0 && (
          <div className="works-private-columns">
            <div><h3>草稿 <span>{drafts.length}</span></h3>{drafts.map((work) => <WorkCard assetErrors={assetErrors} assetUrls={assetUrls} key={work.id} mine onDelete={() => void remove(work)} onEdit={() => setEditingWork(work)} work={work} />)}</div>
            <div><h3>已发布 <span>{myPublished.length}</span></h3>{myPublished.map((work) => <WorkCard assetErrors={assetErrors} assetUrls={assetUrls} key={work.id} mine onDelete={() => void remove(work)} onEdit={() => setEditingWork(work)} work={work} />)}</div>
          </div>
        )}
        {deletingWorkId && <p className="music-delete-progress" role="status">正在先下架并清理媒体，再删除作品记录…</p>}
      </section>

      {editingWork !== undefined && user && (
        <WorkFormModal initialWork={editingWork} onChanged={loadWorks} onClose={() => setEditingWork(undefined)} />
      )}
    </section>
  );
}
