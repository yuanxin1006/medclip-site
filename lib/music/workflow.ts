import type { MusicTrack } from "./types";

export type TrackPublishState = {
  artistName: string;
  audioSelected: boolean;
  coverSelected: boolean;
  description: string;
  genre: string;
  incomplete: boolean;
  title: string;
  track: Pick<
    MusicTrack,
    "artist_name" | "audio_path" | "description" | "duration_seconds" | "genre" | "published" | "title"
  > | null;
};

export function hasUnsavedTrackChanges(state: TrackPublishState): boolean {
  if (!state.track) return true;
  return state.title.trim() !== state.track.title
    || state.artistName.trim() !== state.track.artist_name
    || state.description.trim() !== state.track.description
    || state.genre.trim() !== (state.track.genre ?? "")
    || state.audioSelected
    || state.coverSelected
    || state.incomplete;
}

export function isTrackPublishReady(state: TrackPublishState): boolean {
  return Boolean(
    state.track
    && !state.track.published
    && state.track.title.trim()
    && state.track.audio_path
    && state.track.duration_seconds
    && state.track.duration_seconds > 0
    && !hasUnsavedTrackChanges(state),
  );
}
