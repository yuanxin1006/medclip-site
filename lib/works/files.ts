import type { WorkAssetType } from "./types";

const MEBIBYTE = 1024 * 1024;
export const MAX_WORK_ASSETS = 9;

export const WORK_ASSET_RULES = {
  image: {
    maxBytes: 10 * MEBIBYTE,
    mimeExtensions: {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    },
  },
  video: {
    maxBytes: 200 * MEBIBYTE,
    mimeExtensions: {
      "video/mp4": "mp4",
      "video/webm": "webm",
    },
  },
  audio: {
    maxBytes: 100 * MEBIBYTE,
    mimeExtensions: {
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/wave": "wav",
    },
  },
} as const;

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`, "i");
const WORK_ASSET_PATH_PATTERN = new RegExp(
  `^(${UUID_SOURCE})/(${UUID_SOURCE})/(${UUID_SOURCE})\\.(jpg|png|webp|mp4|webm|mp3|wav)$`,
  "i",
);

export class WorkFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkFileError";
  }
}

export function createSettledCleanup(cleanup: () => void): () => boolean {
  let settled = false;
  return () => {
    if (settled) return false;
    settled = true;
    cleanup();
    return true;
  };
}

export type ValidatedWorkFile = {
  assetType: WorkAssetType;
  extension: string;
  mimeType: string;
};

export function validateWorkAssetFile(file: Pick<File, "name" | "size" | "type">): ValidatedWorkFile {
  if (!file.size) throw new WorkFileError(`${file.name || "文件"}为空，无法上传。`);
  const mimeType = file.type.toLowerCase();
  for (const [assetType, rule] of Object.entries(WORK_ASSET_RULES) as Array<
    [WorkAssetType, (typeof WORK_ASSET_RULES)[WorkAssetType]]
  >) {
    const extension = (rule.mimeExtensions as Record<string, string>)[mimeType];
    if (!extension) continue;
    if (file.size > rule.maxBytes) {
      throw new WorkFileError(
        `${file.name || "文件"}超过${assetType === "image" ? "图片 10 MB" : assetType === "video" ? "视频 200 MB" : "音频 100 MB"}限制。`,
      );
    }
    return { assetType, extension, mimeType };
  }
  throw new WorkFileError(`${file.name || "文件"}的 MIME 类型不受支持。`);
}

export function assertWorkAssetCount(existingCount: number, incomingCount: number): void {
  if (!Number.isInteger(existingCount) || !Number.isInteger(incomingCount) || existingCount < 0 || incomingCount < 0) {
    throw new WorkFileError("媒体附件数量无效。");
  }
  if (existingCount + incomingCount > MAX_WORK_ASSETS) {
    throw new WorkFileError(`每篇作品最多添加 ${MAX_WORK_ASSETS} 个媒体附件。`);
  }
}

function assertUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new WorkFileError(`${field} 必须是有效的 UUID。`);
  return value.toLowerCase();
}

export function buildWorkAssetPath(
  userId: string,
  workId: string,
  assetId: string,
  file: Pick<File, "name" | "size" | "type">,
): { path: string; assetType: WorkAssetType; extension: string; mimeType: string } {
  const validated = validateWorkAssetFile(file);
  const safeUserId = assertUuid(userId, "userId");
  const safeWorkId = assertUuid(workId, "workId");
  const safeAssetId = assertUuid(assetId, "assetId");
  return {
    ...validated,
    path: `${safeUserId}/${safeWorkId}/${safeAssetId}.${validated.extension}`,
  };
}

export function assertCanonicalWorkAssetPath(
  path: string,
  userId?: string,
  workId?: string,
  assetId?: string,
): string {
  const match = WORK_ASSET_PATH_PATTERN.exec(path);
  if (!match) throw new WorkFileError("媒体路径不是有效的 MedClip 作品对象路径。");
  if (userId && match[1].toLowerCase() !== assertUuid(userId, "userId")) throw new WorkFileError("媒体路径不属于当前用户。");
  if (workId && match[2].toLowerCase() !== assertUuid(workId, "workId")) throw new WorkFileError("媒体路径不属于当前作品。");
  if (assetId && match[3].toLowerCase() !== assertUuid(assetId, "assetId")) throw new WorkFileError("媒体路径不属于当前附件。");
  return path;
}

export async function readWorkMediaDurationSeconds(file: File, assetType: WorkAssetType): Promise<number | null> {
  if (assetType === "image") return null;
  return new Promise((resolve, reject) => {
    const media = document.createElement(assetType);
    const url = URL.createObjectURL(file);
    let timeoutId: number | undefined;
    const settle = createSettledCleanup(() => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      media.onloadedmetadata = null;
      media.onerror = null;
      media.removeAttribute("src");
      media.load();
      URL.revokeObjectURL(url);
    });
    timeoutId = window.setTimeout(() => {
      if (!settle()) return;
      reject(new WorkFileError(`无法在限定时间内读取 ${file.name} 的媒体时长。`));
    }, 15000);
    media.preload = "metadata";
    media.onloadedmetadata = () => {
      const duration = media.duration;
      if (!settle()) return;
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new WorkFileError(`${file.name} 没有有效的媒体时长。`));
        return;
      }
      resolve(Math.max(1, Math.round(duration)));
    };
    media.onerror = () => {
      if (!settle()) return;
      reject(new WorkFileError(`浏览器无法读取 ${file.name} 的媒体信息。`));
    };
    media.src = url;
  });
}
