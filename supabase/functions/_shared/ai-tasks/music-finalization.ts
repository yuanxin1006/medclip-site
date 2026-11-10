import {
  assertDefensibleMp3,
  TOKENHUB_MAX_AUDIO_BYTES,
} from "./providers/tencent-tokenhub-music.ts";
import {
  markMusicOperationCompleted,
  markMusicOperationFailed,
  markMusicOperationUnknown,
  type MusicGenerationOperation,
  type MusicOperationRepository,
} from "./music-operation.ts";
import type {
  MusicGenerationInput,
  MusicGenerationProviderResult,
} from "./types.ts";

export const GENERATED_MUSIC_BUCKET = "music-audio" as const;
export const GENERATED_MUSIC_ARTIST = "MedClip AI";

export type GeneratedMusicDraftInput = {
  userId: string;
  title: string;
  artistName: typeof GENERATED_MUSIC_ARTIST;
  published: false;
};

export type GeneratedMusicDraft = {
  id: string;
  userId: string;
  published: false;
};

export type GeneratedMusicUploadInput = {
  bucket: typeof GENERATED_MUSIC_BUCKET;
  path: string;
  bytes: Uint8Array;
  contentType: "audio/mpeg";
  upsert: false;
};

export type GeneratedMusicFinalizeInput = {
  trackId: string;
  userId: string;
  audioPath: string;
  durationSeconds: number | null;
  published: false;
};

export type MusicFinalizationRepository = {
  createDraft(input: GeneratedMusicDraftInput): Promise<GeneratedMusicDraft>;
  uploadAudio(input: GeneratedMusicUploadInput): Promise<void>;
  finalizeDraft(input: GeneratedMusicFinalizeInput): Promise<void>;
  deleteAudio(bucket: typeof GENERATED_MUSIC_BUCKET, path: string): Promise<void>;
  deleteDraft(userId: string, trackId: string): Promise<void>;
};

export type MusicFinalizationDependencies = {
  tracks: MusicFinalizationRepository;
  operations: MusicOperationRepository;
  now?: () => number;
};

export type FinalizedGeneratedMusic = {
  trackId: string;
  bucket: typeof GENERATED_MUSIC_BUCKET;
  path: string;
  published: false;
  providerReportedDurationSeconds: number | null;
  serverVerifiedDurationSeconds: null;
  metrics: {
    storageUploadMs: number;
    trackFinalizationMs: number;
  };
};

export class MusicFinalizationError extends Error {
  readonly stage:
    | "DRAFT_CREATE"
    | "STORAGE_UPLOAD"
    | "DATABASE_FINALIZE"
    | "OPERATION_COMPLETE";
  readonly operationState: "FAILED" | "UNKNOWN";

  constructor(
    stage: MusicFinalizationError["stage"],
    operationState: MusicFinalizationError["operationState"],
  ) {
    super(`Music finalization failed at ${stage}.`);
    this.name = "MusicFinalizationError";
    this.stage = stage;
    this.operationState = operationState;
  }
}

/** An explicit database response proved that no draft row was inserted. */
export class DraftCreateRejectedError extends Error {
  constructor() {
    super("Generated music draft insert was rejected.");
    this.name = "DraftCreateRejectedError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUUID(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID.`);
  return value.toLowerCase();
}

export function canonicalGeneratedMusicAudioPath(userId: string, trackId: string): string {
  return `${assertUUID(userId, "userId")}/${assertUUID(trackId, "trackId")}/audio.mp3`;
}

function generatedTrackTitle(input: MusicGenerationInput): string {
  const title = input.title?.normalize("NFC").trim();
  return title ? title.slice(0, 200) : "AI music draft";
}

async function settleKnownFailure(
  repository: MusicOperationRepository,
  operation: MusicGenerationOperation,
  failureCode: string,
): Promise<"FAILED" | "UNKNOWN"> {
  try {
    await markMusicOperationFailed(repository, operation, failureCode);
    return "FAILED";
  } catch {
    try {
      await markMusicOperationUnknown(repository, operation, "FINALIZATION_STATE_UNCERTAIN");
    } catch {
      // The durable state remains non-terminal or may have changed remotely.
    }
    return "UNKNOWN";
  }
}

async function settleAmbiguousFailure(
  repository: MusicOperationRepository,
  operation: MusicGenerationOperation,
  failureCode: string,
): Promise<void> {
  try {
    await markMusicOperationUnknown(repository, operation, failureCode);
  } catch {
    // A committed transition may have lost its response. Never regenerate.
  }
}

export async function finalizeGeneratedMusic(
  authenticatedUserId: string,
  operation: MusicGenerationOperation,
  input: MusicGenerationInput,
  providerResult: MusicGenerationProviderResult,
  dependencies: MusicFinalizationDependencies,
): Promise<FinalizedGeneratedMusic> {
  const userId = assertUUID(authenticatedUserId, "authenticatedUserId");
  if (operation.userId !== userId || operation.state !== "FINALIZING" || operation.providerCallCount !== 1) {
    throw new Error("Only the authenticated owner's FINALIZING operation can persist music.");
  }
  if (providerResult.audioBytes.byteLength === 0 || providerResult.audioBytes.byteLength > TOKENHUB_MAX_AUDIO_BYTES) {
    throw new Error("Validated MP3 bytes exceed the server-owned size contract.");
  }
  assertDefensibleMp3(providerResult.audioBytes);

  const now = dependencies.now ?? (() => performance.now());
  let trackId: string | null = null;
  let path: string | null = null;
  let draftCreated = false;
  let audioUploaded = false;
  let trackFinalizationMs = 0;
  let storageUploadMs = 0;

  const draftStartedAt = now();
  try {
    const draft = await dependencies.tracks.createDraft({
      userId,
      title: generatedTrackTitle(input),
      artistName: GENERATED_MUSIC_ARTIST,
      published: false,
    });
    trackId = assertUUID(draft.id, "trackId");
    if (draft.userId !== userId || draft.published !== false) {
      throw new Error("Generated music draft owner or publish state is invalid.");
    }
    path = canonicalGeneratedMusicAudioPath(userId, trackId);
    draftCreated = true;
    trackFinalizationMs += Math.max(0, now() - draftStartedAt);
  } catch (error) {
    let cleanupSucceeded = true;
    if (trackId) {
      try {
        await dependencies.tracks.deleteDraft(userId, trackId);
      } catch {
        cleanupSucceeded = false;
      }
    }
    const rejectionIsCertain = error instanceof DraftCreateRejectedError;
    const operationState = cleanupSucceeded && (rejectionIsCertain || trackId !== null)
      ? await settleKnownFailure(dependencies.operations, operation, "DRAFT_CREATE_FAILED")
      : (await settleAmbiguousFailure(
        dependencies.operations,
        operation,
        cleanupSucceeded ? "DRAFT_CREATE_RESULT_UNKNOWN" : "DRAFT_CREATE_CLEANUP_UNKNOWN",
      ), "UNKNOWN" as const);
    throw new MusicFinalizationError("DRAFT_CREATE", operationState);
  }

  const uploadStartedAt = now();
  if (!trackId || !path) throw new Error("Generated music draft identity is unavailable.");
  try {
    await dependencies.tracks.uploadAudio({
      bucket: GENERATED_MUSIC_BUCKET,
      path,
      bytes: providerResult.audioBytes,
      contentType: "audio/mpeg",
      upsert: false,
    });
    audioUploaded = true;
    storageUploadMs = Math.max(0, now() - uploadStartedAt);
  } catch {
    let cleanupSucceeded = true;
    // The upload may have committed even if its response was lost. Removing the
    // exact server-derived path is safe and prevents an orphan object.
    try {
      await dependencies.tracks.deleteAudio(GENERATED_MUSIC_BUCKET, path);
    } catch {
      cleanupSucceeded = false;
    }
    if (draftCreated) {
      try {
        await dependencies.tracks.deleteDraft(userId, trackId);
      } catch {
        cleanupSucceeded = false;
      }
    }
    const operationState = cleanupSucceeded
      ? await settleKnownFailure(dependencies.operations, operation, "STORAGE_UPLOAD_FAILED")
      : (await settleAmbiguousFailure(dependencies.operations, operation, "STORAGE_UPLOAD_CLEANUP_UNKNOWN"), "UNKNOWN" as const);
    throw new MusicFinalizationError("STORAGE_UPLOAD", operationState);
  }

  const finalizeStartedAt = now();
  try {
    await dependencies.tracks.finalizeDraft({
      trackId,
      userId,
      audioPath: path,
      // Provider duration is retained as metadata only. Independent duration
      // verification is deliberately deferred, so the unpublished draft stays null.
      durationSeconds: providerResult.serverVerifiedDurationSeconds,
      published: false,
    });
    trackFinalizationMs += Math.max(0, now() - finalizeStartedAt);
  } catch {
    let cleanupSucceeded = true;
    if (audioUploaded) {
      try {
        await dependencies.tracks.deleteAudio(GENERATED_MUSIC_BUCKET, path);
      } catch {
        cleanupSucceeded = false;
      }
    }
    if (draftCreated) {
      try {
        await dependencies.tracks.deleteDraft(userId, trackId);
      } catch {
        cleanupSucceeded = false;
      }
    }
    const operationState = cleanupSucceeded
      ? await settleKnownFailure(dependencies.operations, operation, "DATABASE_FINALIZE_FAILED")
      : (await settleAmbiguousFailure(dependencies.operations, operation, "DATABASE_FINALIZE_CLEANUP_UNKNOWN"), "UNKNOWN" as const);
    throw new MusicFinalizationError("DATABASE_FINALIZE", operationState);
  }

  try {
    await markMusicOperationCompleted(dependencies.operations, operation, trackId);
  } catch {
    await settleAmbiguousFailure(dependencies.operations, operation, "OPERATION_COMPLETION_UNKNOWN");
    throw new MusicFinalizationError("OPERATION_COMPLETE", "UNKNOWN");
  }

  return {
    trackId,
    bucket: GENERATED_MUSIC_BUCKET,
    path,
    published: false,
    providerReportedDurationSeconds: providerResult.providerReportedDurationSeconds ?? null,
    serverVerifiedDurationSeconds: null,
    metrics: {
      storageUploadMs,
      trackFinalizationMs,
    },
  };
}
