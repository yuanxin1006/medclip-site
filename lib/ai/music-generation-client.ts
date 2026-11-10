import { FunctionsHttpError } from "@supabase/supabase-js";
import { getTrackAudioSignedUrl, getOwnTracks } from "../music/tracks";
import { getSupabaseBrowserClient } from "../supabase/client";
import {
  type MusicGenerationGateway,
  MusicGenerationProductError,
  MUSIC_OPERATION_STATES,
  parseRemoteMusicGenerationAvailability,
  parseMusicGenerationStartRequest,
  parseSafeMusicOperation,
} from "./music-generation-product";

const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MUSIC_GENERATION_START_ACTION = "music.generation_start";
const MUSIC_GENERATION_AVAILABILITY_ACTION = "music.generation_availability";

function requireOperationId(value: string): string {
  if (!OPERATION_ID_PATTERN.test(value)) {
    throw new MusicGenerationProductError("INVALID_OPERATION", "生成任务编号无效。");
  }
  return value.toLowerCase();
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeClientError(error: unknown): MusicGenerationProductError {
  if (error instanceof MusicGenerationProductError) return error;
  return new MusicGenerationProductError("STATUS_UNAVAILABLE", "暂时无法读取歌曲生成状态。");
}

async function parseStatusInvocation(data: unknown, error: unknown) {
  let safeData = data;
  if (!safeData && error instanceof FunctionsHttpError && error.context instanceof Response) {
    try {
      safeData = await error.context.clone().json();
    } catch {
      throw safeClientError(error);
    }
  }
  if (!plainRecord(safeData) || safeData.ok !== true) throw safeClientError(error);
  return parseSafeMusicOperation(safeData.operation);
}

async function parseStartInvocation(data: unknown, error: unknown) {
  let safeData = data;
  if (!safeData && error instanceof FunctionsHttpError && error.context instanceof Response) {
    try {
      safeData = await error.context.clone().json();
    } catch {
      throw safeClientError(error);
    }
  }
  if (plainRecord(safeData) && safeData.ok === false && typeof safeData.status === "string") {
    const safeMessages: Readonly<Record<string, string>> = {
      UNAUTHENTICATED: "请先登录后再使用歌曲生成。",
      AUTH_REQUIRED: "请先登录后再使用歌曲生成。",
      MUSIC_PUBLIC_RELEASE_DISABLED: "歌曲生成限量测试尚未开放。",
      MUSIC_DAILY_LIMIT_REACHED: "今天的歌曲生成次数已用完，请稍后再试。",
      MUSIC_GLOBAL_LIMIT_REACHED: "歌曲生成服务今日额度已用完，请稍后再试。",
      MUSIC_GENERATION_ALREADY_ACTIVE: "已有歌曲正在生成，请等待当前任务完成。",
      OPERATION_CONFLICT: "该生成任务与此前提交的内容不一致，请重新创建任务。",
    };
    const message = safeMessages[safeData.status];
    if (message) throw new MusicGenerationProductError(safeData.status, message);
  }
  if (
    !plainRecord(safeData)
    || safeData.ok !== true
    || safeData.accepted !== true
    || typeof safeData.operationId !== "string"
    || !(MUSIC_OPERATION_STATES as readonly unknown[]).includes(safeData.status)
  ) {
    throw safeClientError(error);
  }
  return {
    accepted: true as const,
    operationId: requireOperationId(safeData.operationId),
    status: safeData.status as typeof MUSIC_OPERATION_STATES[number],
  };
}

export function createRemoteMusicGenerationGateway(): MusicGenerationGateway {
  return {
    async start(request) {
      const input = parseMusicGenerationStartRequest(request);
      const { data, error } = await getSupabaseBrowserClient().functions.invoke("ai-tasks", {
        body: { action: MUSIC_GENERATION_START_ACTION, input },
      });
      return await parseStartInvocation(data, error);
    },
    async getStatus(operationId) {
      const { data, error } = await getSupabaseBrowserClient().functions.invoke("ai-tasks", {
        body: { action: "music.operation_status", operationId: requireOperationId(operationId) },
      });
      return parseStatusInvocation(data, error);
    },
    async getCompletedTrack(trackId) {
      const safeTrackId = requireOperationId(trackId);
      const tracks = await getOwnTracks();
      const track = tracks.find((candidate) => candidate.id.toLowerCase() === safeTrackId);
      if (!track || !track.audio_path || track.published) {
        throw new MusicGenerationProductError("TRACK_UNAVAILABLE", "生成歌曲草稿暂时无法读取。");
      }
      const asset = await getTrackAudioSignedUrl(track);
      return {
        trackId: track.id,
        title: track.title,
        artist: track.artist_name,
        durationSeconds: track.duration_seconds ?? 0,
        src: asset.signedUrl,
        source: "medclip_storage",
      };
    },
  };
}

export async function getRemoteMusicGenerationAvailability() {
  const { data, error } = await getSupabaseBrowserClient().functions.invoke("ai-tasks", {
    body: { action: MUSIC_GENERATION_AVAILABILITY_ACTION },
  });
  if (error) throw safeClientError(error);
  return parseRemoteMusicGenerationAvailability(data);
}
