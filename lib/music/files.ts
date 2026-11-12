export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
export const MAX_COVER_BYTES = 10 * 1024 * 1024;

export const AUDIO_EXTENSIONS: Readonly<Record<string, "mp3" | "wav">> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

export const COVER_EXTENSIONS: Readonly<Record<string, "jpg" | "png" | "webp">> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

type FileDescriptor = Pick<File, "size" | "type">;

export class MusicFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicFileError";
  }
}

function validateFile(
  file: FileDescriptor,
  extensions: Readonly<Record<string, string>>,
  maximumBytes: number,
  label: string,
): void {
  if (!extensions[file.type.toLowerCase()]) {
    throw new MusicFileError(`${label}格式不受支持。`);
  }
  if (file.size <= 0) throw new MusicFileError(`${label}文件不能为空。`);
  if (file.size > maximumBytes) {
    throw new MusicFileError(`${label}文件超过 ${Math.round(maximumBytes / 1024 / 1024)} MB 限制。`);
  }
}

export function validateAudioFile(file: FileDescriptor): void {
  validateFile(file, AUDIO_EXTENSIONS, MAX_AUDIO_BYTES, "音频");
}

export function validateCoverFile(file: FileDescriptor): void {
  validateFile(file, COVER_EXTENSIONS, MAX_COVER_BYTES, "封面");
}

export function toDurationSeconds(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MusicFileError("无法读取有效的音频时长。请确认文件可以正常播放。");
  }
  return Math.max(1, Math.round(duration));
}

export function readAudioDurationSeconds(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = new Audio();
    let settled = false;

    const finish = (result: { duration?: number; error?: Error }) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(objectUrl);
      if (result.error) reject(result.error);
      else resolve(toDurationSeconds(result.duration ?? Number.NaN));
    };

    const timeoutId = window.setTimeout(() => {
      finish({ error: new MusicFileError("读取音频时长超时，请重试或更换文件。") });
    }, 20_000);

    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", () => finish({ duration: audio.duration }), { once: true });
    audio.addEventListener(
      "error",
      () => finish({ error: new MusicFileError("浏览器无法读取该音频文件的元数据。") }),
      { once: true },
    );
    audio.src = objectUrl;
  });
}
