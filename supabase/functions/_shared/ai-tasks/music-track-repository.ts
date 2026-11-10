import type { SupabaseClient } from "@supabase/supabase-js";
import type { BYOKDatabase } from "./database.ts";
import {
  DraftCreateRejectedError,
  type MusicFinalizationRepository,
} from "./music-finalization.ts";

export function createAuthenticatedMusicFinalizationRepository(
  authenticatedClient: SupabaseClient<BYOKDatabase>,
): MusicFinalizationRepository {
  return {
    async createDraft(input) {
      const { data, error } = await authenticatedClient
        .from("music_tracks")
        .insert({
          user_id: input.userId,
          title: input.title,
          artist_name: input.artistName,
          description: "",
          published: false,
        })
        .select("id,user_id,published")
        .single();
      if (error) throw new DraftCreateRejectedError();
      // A success response without the selected row cannot prove whether the
      // database committed. Preserve that ambiguity instead of retrying.
      if (!data) throw new Error("Generated music draft result is uncertain.");
      if (data.user_id !== input.userId || data.published !== false) {
        throw new Error("Generated music draft owner or publish state is invalid.");
      }
      return { id: data.id, userId: data.user_id, published: false };
    },
    async uploadAudio(input) {
      const { error } = await authenticatedClient.storage.from(input.bucket).upload(
        input.path,
        input.bytes,
        { contentType: input.contentType, upsert: input.upsert },
      );
      if (error) throw error;
    },
    async finalizeDraft(input) {
      const { data, error } = await authenticatedClient
        .from("music_tracks")
        .update({
          audio_path: input.audioPath,
          duration_seconds: input.durationSeconds,
          published: false,
        })
        .eq("id", input.trackId)
        .eq("user_id", input.userId)
        .select("id")
        .maybeSingle();
      if (error || !data) throw error ?? new Error("Generated music draft no longer exists.");
    },
    async deleteAudio(bucket, path) {
      const { error } = await authenticatedClient.storage.from(bucket).remove([path]);
      if (error) throw error;
    },
    async deleteDraft(userId, trackId) {
      const { error } = await authenticatedClient
        .from("music_tracks")
        .delete()
        .eq("id", trackId)
        .eq("user_id", userId);
      if (error) throw error;
    },
  };
}
