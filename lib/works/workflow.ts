import type { Work, WorkAsset, WorkContentKind } from "./types";

export type WorkPublishState = {
  title: string;
  body: string;
  sourceMusicTrackId: string | null;
  existingAssetCount: number;
  pendingAssetCount: number;
  removedAssetCount: number;
  incomplete: boolean;
  work: Pick<Work, "title" | "body" | "source_music_track_id" | "published"> | null;
};

export function hasUnsavedWorkChanges(state: WorkPublishState): boolean {
  if (!state.work) return true;
  return state.title.trim() !== state.work.title
    || state.body.trim() !== state.work.body
    || state.sourceMusicTrackId !== state.work.source_music_track_id
    || state.pendingAssetCount > 0
    || state.removedAssetCount > 0
    || state.incomplete;
}

export function isWorkPublishReady(state: WorkPublishState): boolean {
  if (!state.work || state.work.published || !state.work.title.trim() || hasUnsavedWorkChanges(state)) return false;
  return Boolean(
    state.work.body.trim()
    || state.existingAssetCount > 0
    || state.work.source_music_track_id,
  );
}

export function deriveWorkContentKind(
  body: string,
  assets: ReadonlyArray<Pick<WorkAsset, "asset_type">>,
  sourceMusicTrackId: string | null = null,
): WorkContentKind {
  const kinds = new Set<string>();
  if (body.trim()) kinds.add("text");
  for (const asset of assets) kinds.add(asset.asset_type);
  if (sourceMusicTrackId) kinds.add("audio");
  if (kinds.size !== 1) return kinds.size === 0 ? "TEXT" : "MIXED";
  const [kind] = kinds;
  return kind.toUpperCase() as WorkContentKind;
}
