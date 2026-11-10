"use client";

import { useEffect, useState } from "react";
import MusicPlayer from "../music/MusicPlayer";
import type { WorkAsset } from "../../lib/works/types";

type WorkAssetMediaProps = {
  asset: WorkAsset;
  title: string;
  url?: string;
  urlError?: string;
};

export default function WorkAssetMedia({ asset, title, url, urlError }: WorkAssetMediaProps) {
  const [mediaError, setMediaError] = useState(false);
  const [imageLoading, setImageLoading] = useState(asset.asset_type === "image" && Boolean(url));

  useEffect(() => {
    setMediaError(false);
    setImageLoading(asset.asset_type === "image" && Boolean(url));
  }, [asset.asset_type, url]);

  if (!url || urlError || mediaError) {
    return (
      <div className="work-media-fallback" role="status">
        <strong>{asset.asset_type === "image" ? "图片" : asset.asset_type === "video" ? "视频" : "音频"}暂时无法加载</strong>
        <span>{urlError || "安全播放链接不可用，请稍后重试。"}</span>
      </div>
    );
  }

  if (asset.asset_type === "image") {
    return (
      <div className="work-image-frame">
        {imageLoading && <span className="work-media-loading">正在加载图片…</span>}
        <img
          alt={`${title} 的作品图片`}
          className={imageLoading ? "is-loading" : ""}
          loading="lazy"
          onError={() => setMediaError(true)}
          onLoad={() => setImageLoading(false)}
          src={url}
        />
      </div>
    );
  }

  if (asset.asset_type === "video") {
    return (
      <video
        className="work-video"
        controls
        onError={() => setMediaError(true)}
        preload="metadata"
        src={url}
      >
        你的浏览器不支持视频播放。
      </video>
    );
  }

  return (
    <MusicPlayer
      artist="作品音频"
      durationSeconds={asset.duration_seconds ?? 0}
      src={url}
      title={title}
    />
  );
}
