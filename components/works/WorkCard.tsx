"use client";

import type { WorkWithAssets } from "../../lib/works/types";
import { deriveWorkContentKind } from "../../lib/works/workflow";
import WorkAssetMedia from "./WorkAssetMedia";

type WorkCardProps = {
  assetErrors: Record<string, string>;
  assetUrls: Record<string, string>;
  mine?: boolean;
  onDelete?: () => void;
  onEdit?: () => void;
  work: WorkWithAssets;
};

export default function WorkCard({ assetErrors, assetUrls, mine = false, onDelete, onEdit, work }: WorkCardProps) {
  const kind = deriveWorkContentKind(work.body, work.assets, work.source_music_track_id);
  const author = work.author?.display_name.trim() || "Unknown creator";
  return (
    <article className="work-card">
      <header className="work-card-header">
        <span className="work-kind-badge">{{ TEXT: "文字", IMAGE: "图片", VIDEO: "视频", AUDIO: "音频", MIXED: "多媒体" }[kind]}</span>
        <span>{author}</span>
        {mine && <i>{work.published ? "已发布" : "草稿"}</i>}
      </header>
      <h3>{work.title}</h3>
      {work.body && <p className="work-card-body">{work.body}</p>}
      {work.assets.length > 0 && (
        <div className={`work-media-grid ${work.assets.length === 1 ? "is-single" : ""}`}>
          {work.assets.map((asset) => (
            <WorkAssetMedia
              asset={asset}
              key={asset.id}
              title={work.title}
              url={assetUrls[asset.storage_path]}
              urlError={assetErrors[asset.storage_path]}
            />
          ))}
        </div>
      )}
      {mine && (
        <footer className="work-card-actions">
          <button onClick={onEdit} type="button">编辑</button>
          <button className="is-danger" onClick={onDelete} type="button">删除</button>
        </footer>
      )}
    </article>
  );
}
