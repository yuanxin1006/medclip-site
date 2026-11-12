export const MUSIC_OPERATION_STATES = [
  "RESERVED",
  "PROVIDER_IN_FLIGHT",
  "FINALIZING",
  "COMPLETED",
  "FAILED",
  "UNKNOWN",
] as const;

export type MusicOperationStatus = typeof MUSIC_OPERATION_STATES[number];
export type MusicGenerationMode = "custom_lyrics" | "instrumental";

export type MusicGenerationStartRequest = {
  operationId: string;
  mode: MusicGenerationMode;
  title?: string;
  lyrics?: string;
  prompt?: string;
};

export type MusicGenerationAccepted = {
  accepted: true;
  operationId: string;
  status: MusicOperationStatus;
};

export type SafeMusicOperation = {
  operationId: string;
  status: MusicOperationStatus;
  createdAt: string;
  updatedAt: string;
  trackId?: string;
  safeErrorCode?: string;
};

export type CompletedMusicPlayback = {
  trackId: string;
  title: string;
  artist: string;
  durationSeconds: number;
  src: string;
  source: "medclip_storage" | "local_test_fixture";
};

export type MusicGenerationGateway = {
  start(request: MusicGenerationStartRequest): Promise<MusicGenerationAccepted>;
  getStatus(operationId: string): Promise<SafeMusicOperation>;
  getCompletedTrack(trackId: string): Promise<CompletedMusicPlayback>;
};

export type MusicGenerationViewState = "IDLE" | "SUBMITTING" | MusicOperationStatus;

export type RemoteMusicGenerationAvailability = {
  enabled: boolean;
  testerModeEnabled: boolean;
};

export type MusicGenerationStageCopy = {
  label: string;
  description: string;
  tone: "idle" | "active" | "success" | "error" | "caution";
};

export const MUSIC_STATUS_POLL_INTERVAL_MS = 3_000;
export const MUSIC_UNKNOWN_MAX_POLLS = 3;
export const MUSIC_RECOVERY_STORAGE_PREFIX = "medclip:c2a:music-operation";

const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRACK_ID_PATTERN = OPERATION_ID_PATTERN;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const START_FIELDS = new Set(["operationId", "mode", "title", "lyrics", "prompt"]);
const STATUS_FIELDS = new Set(["operationId", "status", "createdAt", "updatedAt", "trackId", "safeErrorCode"]);

export class MusicGenerationProductError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MusicGenerationProductError";
    this.code = code;
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseRemoteMusicGenerationAvailability(value: unknown): RemoteMusicGenerationAvailability {
  if (
    !plainRecord(value)
    || value.ok !== true
    || !plainRecord(value.musicGeneration)
    || Object.keys(value.musicGeneration).some((key) => !["enabled", "testerModeEnabled"].includes(key))
    || typeof value.musicGeneration.enabled !== "boolean"
    || typeof value.musicGeneration.testerModeEnabled !== "boolean"
  ) {
    throw new MusicGenerationProductError("STATUS_UNAVAILABLE", "歌曲生成服务状态暂时不可用。");
  }
  return {
    enabled: value.musicGeneration.enabled,
    testerModeEnabled: value.musicGeneration.testerModeEnabled,
  };
}

function requireOperationId(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) {
    throw new MusicGenerationProductError("INVALID_OPERATION", "生成任务编号无效。");
  }
  return value.toLowerCase();
}

function optionalBoundedText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || value.includes("\0")) {
    throw new MusicGenerationProductError("INVALID_INPUT", `${field}无效。`);
  }
  return value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

export function parseMusicGenerationStartRequest(value: unknown): MusicGenerationStartRequest {
  if (!plainRecord(value) || Object.keys(value).some((key) => !START_FIELDS.has(key))) {
    throw new MusicGenerationProductError("INVALID_INPUT", "歌曲生成请求包含不允许的字段。");
  }
  const operationId = requireOperationId(value.operationId);
  const mode = value.mode;
  if (mode !== "custom_lyrics" && mode !== "instrumental") {
    throw new MusicGenerationProductError("INVALID_INPUT", "歌曲生成模式无效。");
  }
  const title = optionalBoundedText(value.title, "歌曲名称", 200);
  const lyrics = optionalBoundedText(value.lyrics, "歌词", 3_500);
  const prompt = optionalBoundedText(value.prompt, "创作要求", 2_000);
  if (mode === "custom_lyrics" && !lyrics) {
    throw new MusicGenerationProductError("INVALID_INPUT", "自定义歌词模式必须提供歌词。");
  }
  if (mode === "instrumental" && (!prompt || lyrics !== undefined)) {
    throw new MusicGenerationProductError("INVALID_INPUT", "纯音乐模式必须提供创作要求且不能包含歌词。");
  }
  return {
    operationId,
    mode,
    ...(title ? { title } : {}),
    ...(lyrics ? { lyrics } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

export function parseSafeMusicOperation(value: unknown): SafeMusicOperation {
  if (!plainRecord(value) || Object.keys(value).some((key) => !STATUS_FIELDS.has(key))) {
    throw new MusicGenerationProductError("INVALID_STATUS", "生成状态响应无效。");
  }
  const operationId = requireOperationId(value.operationId);
  if (!(MUSIC_OPERATION_STATES as readonly unknown[]).includes(value.status)) {
    throw new MusicGenerationProductError("INVALID_STATUS", "生成状态响应无效。");
  }
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new MusicGenerationProductError("INVALID_STATUS", "生成状态时间无效。");
  }
  const status = value.status as MusicOperationStatus;
  const trackId = value.trackId === undefined ? undefined : requireOperationId(value.trackId);
  const safeErrorCode = value.safeErrorCode === undefined
    ? undefined
    : typeof value.safeErrorCode === "string" && SAFE_ERROR_CODE.test(value.safeErrorCode)
      ? value.safeErrorCode
      : (() => { throw new MusicGenerationProductError("INVALID_STATUS", "生成状态错误码无效。"); })();
  if (status === "COMPLETED" && (!trackId || !TRACK_ID_PATTERN.test(trackId))) {
    throw new MusicGenerationProductError("INVALID_STATUS", "已完成任务缺少作品编号。");
  }
  if (status !== "COMPLETED" && trackId !== undefined) {
    throw new MusicGenerationProductError("INVALID_STATUS", "未完成任务不能返回作品编号。");
  }
  return {
    operationId,
    status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(trackId ? { trackId } : {}),
    ...(safeErrorCode ? { safeErrorCode } : {}),
  };
}

export function createMusicOperationId(randomUUID: () => string = () => crypto.randomUUID()): string {
  return requireOperationId(randomUUID());
}

export function musicGenerationStageCopy(state: MusicGenerationViewState): MusicGenerationStageCopy {
  if (state === "SUBMITTING") return { label: "正在提交生成任务", description: "请稍候，正在创建安全的生成任务。", tone: "active" };
  if (state === "RESERVED") return { label: "正在准备生成", description: "任务已受理，正在准备歌曲生成。", tone: "active" };
  if (state === "PROVIDER_IN_FLIGHT") return { label: "AI 正在生成歌曲", description: "生成正在进行中，刷新页面不会创建第二个任务。", tone: "active" };
  if (state === "FINALIZING") return { label: "歌曲已生成，正在保存", description: "正在保存到 MedClip 私有音乐空间。", tone: "active" };
  if (state === "COMPLETED") return { label: "生成完成", description: "歌曲已作为未发布草稿保存，可试听后继续管理。", tone: "success" };
  if (state === "FAILED") return { label: "歌曲生成失败", description: "歌曲生成失败，请稍后重新尝试。不会自动产生新的付费请求。", tone: "error" };
  if (state === "UNKNOWN") return { label: "正在确认生成结果", description: "结果暂时无法确认，请稍后查看。系统不会自动重新生成。", tone: "caution" };
  return { label: "准备生成歌曲", description: "填写歌词或创作要求后，可创建一次异步生成任务。", tone: "idle" };
}

export function isTerminalMusicOperation(status: MusicOperationStatus): boolean {
  return status === "COMPLETED" || status === "FAILED";
}

export type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type MusicOperationRecovery = {
  operationId: string;
  title: string;
};

function recoveryKey(userId: string): string {
  return `${MUSIC_RECOVERY_STORAGE_PREFIX}:${userId.toLowerCase()}`;
}

export function persistMusicOperationRecovery(
  storage: RecoveryStorage,
  userId: string,
  recovery: MusicOperationRecovery,
): void {
  storage.setItem(recoveryKey(userId), JSON.stringify({
    operationId: requireOperationId(recovery.operationId),
    title: recovery.title.trim().slice(0, 200),
  }));
}

export function restoreMusicOperationRecovery(
  storage: RecoveryStorage,
  userId: string,
): MusicOperationRecovery | null {
  const raw = storage.getItem(recoveryKey(userId));
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!plainRecord(value) || typeof value.title !== "string") throw new Error("invalid");
    return { operationId: requireOperationId(value.operationId), title: value.title.slice(0, 200) };
  } catch {
    storage.removeItem(recoveryKey(userId));
    return null;
  }
}

export function clearMusicOperationRecovery(storage: RecoveryStorage, userId: string): void {
  storage.removeItem(recoveryKey(userId));
}

export type PollMusicOperationOptions = {
  operationId: string;
  getStatus: (operationId: string) => Promise<SafeMusicOperation>;
  onStatus: (status: SafeMusicOperation) => void | Promise<void>;
  signal: AbortSignal;
  intervalMs?: number;
  maxUnknownPolls?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

export async function pollMusicOperation(options: PollMusicOperationOptions): Promise<void> {
  const intervalMs = options.intervalMs ?? MUSIC_STATUS_POLL_INTERVAL_MS;
  const maxUnknownPolls = options.maxUnknownPolls ?? MUSIC_UNKNOWN_MAX_POLLS;
  const sleep = options.sleep ?? defaultSleep;
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
    throw new MusicGenerationProductError("INVALID_POLL_INTERVAL", "状态轮询间隔不能短于 1 秒。");
  }
  let unknownPolls = 0;
  while (!options.signal.aborted) {
    await sleep(intervalMs, options.signal);
    if (options.signal.aborted) return;
    const status = await options.getStatus(options.operationId);
    await options.onStatus(status);
    if (isTerminalMusicOperation(status.status)) return;
    if (status.status === "UNKNOWN") {
      unknownPolls += 1;
      if (unknownPolls >= maxUnknownPolls) return;
    } else {
      unknownPolls = 0;
    }
  }
}

export function createSingleSubmissionGuard() {
  let active = false;
  return {
    get active() { return active; },
    async run<T>(work: () => Promise<T>): Promise<T | null> {
      if (active) return null;
      active = true;
      try {
        return await work();
      } finally {
        active = false;
      }
    },
  };
}
