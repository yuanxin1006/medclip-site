import type { AIProviderId } from "../ai-credentials/providers/types.ts";

export type SavedCredentialRow = {
  provider: AIProviderId;
  provider_resource_id: string | null;
  ciphertext: string;
  iv: string;
  encryption_version: number;
};

export type BYOKDatabase = {
  public: {
    Tables: {
      music_tracks: {
        Row: {
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
        Insert: {
          id?: string;
          user_id: string;
          title: string;
          artist_name: string;
          description?: string;
          published?: boolean;
        };
        Update: {
          audio_path?: string;
          duration_seconds?: number | null;
          published?: boolean;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      medclip_get_ai_provider_credential: {
        Args: { target_user_id: string; target_provider: string };
        Returns: SavedCredentialRow[];
      };
      medclip_reserve_music_generation_operation: {
        Args: {
          target_user_id: string;
          target_operation_id: string;
          target_task: string;
          target_provider: string;
          target_request_hash: string;
        };
        Returns: unknown;
      };
      medclip_reserve_music_generation_operation_guarded: {
        Args: {
          target_user_id: string;
          target_operation_id: string;
          target_task: string;
          target_provider: string;
          target_request_hash: string;
          target_counts_paid_dispatch: boolean;
          target_enforce_user_daily_limit: boolean;
          target_user_daily_limit: number;
          target_global_daily_limit: number;
        };
        Returns: unknown;
      };
      medclip_authorize_music_provider_dispatch: {
        Args: {
          target_user_id: string;
          target_operation_id: string;
          target_counts_paid_dispatch: boolean;
          target_enforce_user_daily_limit: boolean;
          target_user_daily_limit: number;
          target_global_daily_limit: number;
        };
        Returns: unknown;
      };
      medclip_get_music_generation_operation: {
        Args: { target_user_id: string; target_operation_id: string };
        Returns: unknown;
      };
      medclip_transition_music_generation_operation: {
        Args: {
          target_user_id: string;
          target_operation_id: string;
          expected_state: string;
          next_state: string;
          next_provider_call_count: number;
          next_provider_request_id?: string | null;
          next_provider_trace_id?: string | null;
          next_final_track_id?: string | null;
          next_failure_code?: string | null;
          next_failure_diagnostics?: Readonly<Record<string, unknown>> | null;
        };
        Returns: unknown;
      };
    };
  };
};
