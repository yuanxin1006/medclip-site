import {
  createSafeEditorAIContext,
} from "../app/editor-ai-requirements.ts";
import {
  parseEditorProject,
  type EditorProject,
} from "../app/editor-core.ts";
import type { PreLiveSafeContextInput } from "./video-ai-live-acceptance-harness.ts";

export type DisposableBrowserFile = {
  name: string;
  mimeType: string;
  buffer: Uint8Array;
};

type FixtureLocatorLike = {
  nth: (index: number) => FixtureLocatorLike;
  setInputFiles: (file: DisposableBrowserFile) => Promise<void>;
  waitFor: (options: { state: "visible"; timeout?: number }) => Promise<void>;
  click: () => Promise<void>;
  fill: (value: string) => Promise<void>;
  isChecked: () => Promise<boolean>;
  check: () => Promise<void>;
};

export type OwnedAssetFixturePageLike = {
  locator: (selector: string, options?: { hasText?: string }) => FixtureLocatorLike;
  waitForFunction: (
    predicate: () => boolean,
    argument?: unknown,
    options?: { timeout?: number },
  ) => Promise<unknown>;
  evaluate: <T>(pageFunction: () => T | Promise<T>) => Promise<T>;
};

export type OwnedAssetAcceptanceFixture = {
  project: EditorProject;
  preLiveContext: PreLiveSafeContextInput;
  registeredAsset: {
    id: string;
    name: string;
    durationSeconds: number;
  };
  registeredAssets?: { id: string; name: string; durationSeconds: number }[];
};

export async function buildOwnedAssetAcceptanceFixtureThroughEditor(
  page: OwnedAssetFixturePageLike,
  {
    video,
    audio,
    subtitleText,
    additionalVideos = [],
    prepareGeneratedProject,
    diagnosticStage = () => {},
    diagnosticSubstage = () => {},
  }: {
    video: DisposableBrowserFile;
    audio: DisposableBrowserFile;
    subtitleText: string;
    additionalVideos?: DisposableBrowserFile[];
    diagnosticStage?: (gate: string) => void;
    diagnosticSubstage?: (substage: string) => void;
    prepareGeneratedProject?: () => Promise<void>;
  },
): Promise<OwnedAssetAcceptanceFixture> {
  diagnosticSubstage("VIDEO_A_REGISTRATION");
  await page.locator('input[accept^="video/"]').setInputFiles(video);
  await page.locator(".asset-row", { hasText: video.name }).waitFor({ state: "visible" });
  for (const [index, extra] of additionalVideos.entries()) {
    diagnosticSubstage(index === 0 ? "VIDEO_B_REGISTRATION" : "VIDEO_C_REGISTRATION");
    await page.locator('input[accept^="video/"]').setInputFiles(extra);
    await page.locator(".asset-row", { hasText: extra.name }).waitFor({ state: "visible" });
  }
  diagnosticSubstage("AUDIO_REGISTRATION");
  await page.locator('input[accept="audio/*"]').setInputFiles(audio);
  await page.locator(".audio-card", { hasText: audio.name }).waitFor({ state: "visible" });
  diagnosticSubstage("SUBTITLE_PREPARATION");
  await page.locator(".subtitle-source-tabs button").nth(1).click();
  await page.locator('textarea[aria-label="字幕文本"]').fill(subtitleText);
  diagnosticSubstage("CONSENT_CONFIRMATION");
  const consent = page.locator(".consent input[type=checkbox]");
  if (!(await consent.isChecked())) await consent.check();
  diagnosticSubstage("GENERATE_READINESS");
  await page.waitForFunction(() => {
    const button = document.querySelector("button.generate-button");
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  diagnosticStage("PROJECT_GENERATION");
  await page.locator("button.generate-button").click();
  diagnosticSubstage("PROJECT_PERSISTENCE_WAIT");
  await page.waitForFunction(
    () => Boolean(window.localStorage.getItem("medclip-editor-draft-v1")),
    undefined,
    { timeout: 60_000 },
  );

  // Optional acceptance setup uses production editor controls, never draft writes.
  await prepareGeneratedProject?.();
  diagnosticStage("PROJECT_STATE_VALIDATION");
  const serializedProject = await page.evaluate(
    () => window.localStorage.getItem("medclip-editor-draft-v1"),
  );
  const project = parseEditorProject(serializedProject);
  if (!project) throw new Error("Owned-asset fixture did not produce a valid editor project.");
  diagnosticStage("OWNERSHIP_VALIDATION");
  const registeredAsset = project.assets.find((asset) => (
    asset.name === video.name && asset.kind === "视频"
  ));
  if (!registeredAsset) throw new Error("Uploaded disposable video is absent from the generated project.");
  const firstClip = project.tracks
    .filter((track) => track.type === "video" || track.type === "broll")
    .flatMap((track) => track.clips)
    .filter((clip) => clip.kind === "视频")
    .sort((left, right) => left.timelineStartMs - right.timelineStartMs)[0];
  if (!firstClip || firstClip.assetId !== registeredAsset.id) {
    throw new Error("Generated first clip is not bound to the uploaded disposable video.");
  }

  // This owned set is valid only because this helper registered the file through
  // the production upload input and generated the project in the same page.
  const registeredAssets = [video, ...additionalVideos].map((file) => {
    const asset = project.assets.find((item) => item.name === file.name && item.kind === registeredAsset.kind);
    if (!asset) throw new Error("Disposable owned video registration missing.");
    return { id: asset.id, name: asset.name, durationSeconds: asset.durationMs / 1_000 };
  });
  const ownedAssetIds = new Set(registeredAssets.map((asset) => asset.id));
  const ordered = project.tracks.filter((track) => track.type === "video" || track.type === "broll")
    .flatMap((track) => track.clips).sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  if (additionalVideos.length && (ordered.length !== registeredAssets.length
    || ordered.some((clip, i) => clip.assetId !== registeredAssets[i].id))) {
    throw new Error("Generated fixture must contain exactly the uploaded clips in registration order.");
  }
  return {
    project,
    registeredAssets,
    preLiveContext: {
      serializedContext: createSafeEditorAIContext(
        project,
        ownedAssetIds,
        project.audioSelection.sourceDurationMs,
      ),
      expectedClipId: additionalVideos.length ? ordered[2].id : firstClip.id,
      expectedAssetId: additionalVideos.length ? ordered[2].assetId : registeredAsset.id,
      ...(additionalVideos.length ? {
        expectedTargetClipId: ordered[2].id,
        expectedReferenceClipId: ordered[0].id,
        expectedClipIds: ordered.map((clip) => clip.id),
      } : {}),
    },
    registeredAsset: {
      id: registeredAsset.id,
      name: registeredAsset.name,
      durationSeconds: registeredAsset.durationMs / 1_000,
    },
  };
}
