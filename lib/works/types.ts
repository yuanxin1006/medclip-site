export type WorkAssetType = "image" | "video" | "audio";

export type Work = {
  id: string;
  user_id: string;
  title: string;
  body: string;
  source_music_track_id: string | null;
  published: boolean;
  created_at: string;
  updated_at: string;
};

export type WorkAsset = {
  id: string;
  work_id: string;
  user_id: string;
  asset_type: WorkAssetType;
  storage_path: string;
  mime_type: string;
  sort_order: number;
  duration_seconds: number | null;
  created_at: string;
};

export type WorkAuthor = {
  id: string;
  display_name: string;
  avatar_url: string | null;
};

export type WorkWithAssets = Work & {
  assets: WorkAsset[];
  author: WorkAuthor | null;
};

export type CreateWorkInput = {
  title: string;
  body?: string;
  source_music_track_id?: string | null;
};

export type UpdateWorkInput = Partial<Pick<Work, "title" | "body" | "source_music_track_id" | "published">>;

export type WorkDeletionResult = {
  workId: string;
  unpublished: boolean;
  mediaDeleted: boolean;
  assetRowsDeleted: boolean;
  rowDeleted: boolean;
  mediaPaths: string[];
};

export type WorkContentKind = "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "MIXED";
