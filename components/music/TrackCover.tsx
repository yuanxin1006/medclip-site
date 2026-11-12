"use client";

import { useState } from "react";

type TrackCoverProps = {
  className?: string;
  title: string;
  url?: string | null;
};

export default function TrackCover({ className = "", title, url }: TrackCoverProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(url && url !== failedUrl);
  return (
    <span className={`music-cover music-cover-fallback ${className}`} aria-hidden="true">
      {showImage && (
        <img
          alt=""
          loading="lazy"
          onError={() => setFailedUrl(url ?? null)}
          onLoad={() => setFailedUrl(null)}
          src={url ?? undefined}
        />
      )}
      {!showImage && <span>{title.trim().slice(0, 1).toUpperCase() || "M"}</span>}
    </span>
  );
}
