import type { EditorAssetRef, EditorProject } from "./editor-core.ts";

export type LocalMediaIdentity = Readonly<{ bytes: number; contentSha256: string }>;

export const MAX_EDITOR_MEDIA_BYTES = 2 * 1024 ** 3;
export const LEGACY_EDITOR_DRAFT_KEY = "medclip-editor-draft-v1";
export const LEGACY_EDITOR_OWNER_KEY = "medclip-editor-draft-v1-owner";
const CHUNK_BYTES = 4 * 1024 ** 2;

export function editorDraftKey(userId: string | null): string {
  return `medclip-editor-draft-v2:${userId ? `user:${userId}` : "anonymous"}`;
}

export function canRecoverLegacyEditorDraft(storage: Pick<Storage, "getItem">, storageKey: string): boolean {
  const owner = storage.getItem(LEGACY_EDITOR_OWNER_KEY);
  if (owner) return owner === storageKey;
  return true;
}

export function isLocalMediaIdentity(value: unknown): value is LocalMediaIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as LocalMediaIdentity;
  return Number.isSafeInteger(identity.bytes) && identity.bytes > 0
    && identity.bytes <= MAX_EDITOR_MEDIA_BYTES
    && typeof identity.contentSha256 === "string" && /^[a-f0-9]{64}$/.test(identity.contentSha256);
}

export async function identifyLocalMedia(file: Blob): Promise<LocalMediaIdentity> {
  if (!file.size || file.size > MAX_EDITOR_MEDIA_BYTES) throw new Error("请选择不超过 2GB 的非空素材。");
  // Hash every byte in fixed chunks so even large files need only a bounded buffer.
  const chunkHashes = new Uint8Array(Math.ceil(file.size / CHUNK_BYTES) * 32);
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    const chunk = await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
    chunkHashes.set(new Uint8Array(await crypto.subtle.digest("SHA-256", chunk)), offset / CHUNK_BYTES * 32);
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", chunkHashes));
  return { bytes: file.size, contentSha256: Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") };
}

export function sameLocalMedia(left?: LocalMediaIdentity, right?: LocalMediaIdentity): boolean {
  return Boolean(left && right && left.bytes === right.bytes && left.contentSha256 === right.contentSha256);
}

export function findLocalMediaReference(
  assets: readonly EditorAssetRef[],
  incoming: Pick<EditorAssetRef, "kind" | "mediaIdentity">,
): EditorAssetRef | undefined {
  const matches = assets.filter(asset => asset.kind === incoming.kind && sameLocalMedia(asset.mediaIdentity, incoming.mediaIdentity));
  if (matches.length > 1) throw new Error("多个素材记录包含相同内容，请从待关联列表选择具体片段来源。");
  return matches[0];
}

export function visualTimelineClips(project: EditorProject) {
  return project.tracks
    .filter(track => track.type === "video" || track.type === "broll")
    .flatMap(track => track.clips)
    .sort((left, right) => left.timelineStartMs - right.timelineStartMs);
}

export function needsInitialVisualTimeline(project: EditorProject | null, jobDone: boolean): boolean {
  if (!project) return true;
  if (visualTimelineClips(project).length || project.visualTimelineInitialized) return false;
  return project.visualTimelineInitialized === false || !jobDone;
}
