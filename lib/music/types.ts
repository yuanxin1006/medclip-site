export type MusicStorageBucket = "music-audio" | "music-covers";

export type Profile = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  created_at: string;
};

export type MusicTrack = {
  id: string;
  user_id: string;
  title: string;
  artist_name: string;
  description: string;
  genre: string | null;
  cover_path: string | null;
  audio_path: string | null;
  duration_seconds: number | null;
  created_at: string;
  updated_at: string;
  published: boolean;
};

export type CreateMusicTrackInput = Pick<MusicTrack, "title" | "artist_name"> &
  Partial<Pick<MusicTrack, "description" | "genre">>;

export type UpdateMusicTrackInput = Partial<
  Pick<
    MusicTrack,
    | "title"
    | "artist_name"
    | "description"
    | "genre"
    | "cover_path"
    | "audio_path"
    | "duration_seconds"
    | "published"
  >
>;

export type UploadedMusicAsset = {
  bucket: MusicStorageBucket;
  path: string;
};

export type SignedMusicAsset = UploadedMusicAsset & {
  signedUrl: string;
  expiresInSeconds: number;
};

export type MusicTrackAuthor = Pick<Profile, "id" | "display_name" | "avatar_url">;

export type MusicTrackWithAuthor = MusicTrack & {
  author: MusicTrackAuthor | null;
};

export type SignedMediaBatchResult = {
  urls: Record<string, string>;
  errors: Record<string, string>;
};

export type DeleteTrackResult = {
  trackId: string;
  audioDeleted: boolean;
  coverDeleted: boolean;
  rowDeleted: boolean;
};
