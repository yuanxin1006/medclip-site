const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/gu;
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;
const MAX_DOWNLOAD_BASENAME_LENGTH = 120;

export type MusicDownloadExtension = "mp3" | "wav";

export function musicDownloadExtension(audioPath: string): MusicDownloadExtension {
  return audioPath.toLowerCase().endsWith(".wav") ? "wav" : "mp3";
}

export function sanitizeMusicDownloadFilename(title: string, extension: MusicDownloadExtension = "mp3"): string {
  const normalizedTitle = title.normalize("NFC").trim().replace(/\.(?:mp3|mpeg|wav)$/iu, "");
  const safeTitle = normalizedTitle
    .replace(INVALID_FILENAME_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/gu, "")
    .slice(0, MAX_DOWNLOAD_BASENAME_LENGTH)
    .replace(/[. ]+$/gu, "")
    .trim();
  const basename = !safeTitle
    ? "medclip-song"
    : WINDOWS_RESERVED_BASENAME.test(safeTitle)
      ? `medclip-${safeTitle}`
      : safeTitle;
  return `${basename}.${extension}`;
}
