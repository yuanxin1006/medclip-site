export const VIDEO_AI_SUCCESS_SELECTOR = ".editor-ai-apply-summary";
export const VIDEO_AI_ERROR_SELECTOR = ".editor-ai-dialog-error";
export const AI_TASKS_PATH_SUFFIX = "/functions/v1/ai-tasks";

export type SafeCanonicalActionEvidence = {
  type: string | null;
  targetId: string | null;
  assetId: string | null;
  playbackRate: number | null;
  referenceId?: string | null;
  placement?: string | null;
};

export type SafeAITaskResponseEvidence = {
  httpStatus: number;
  responseCompleted: boolean;
  requestIdPresent: boolean;
  ok: boolean;
  errorCode: string | null;
  canonical: {
    summaryPresent: boolean;
    actions: SafeCanonicalActionEvidence[] | null;
    unsupportedIsArray: boolean;
    warningsIsArray: boolean;
  } | null;
};

export type EditorSurfaceSnapshot = {
  successVisible: boolean;
  successText: string;
  errorVisible: boolean;
  errorText: string;
};

export type EditorSpecificOutcome =
  | { kind: "success"; text: string }
  | { kind: "error"; text: string };

export type PreLiveSafeContextInput = {
  serializedContext: string;
  expectedClipId: string;
  expectedAssetId: string;
  expectedTargetClipId?: string;
  expectedReferenceClipId?: string;
  expectedClipIds?: string[];
};

export type PreLiveSafeContextEvidence = {
  eligible: boolean;
  expectedReferencePresent?: boolean;
  targetReferenceDistinct?: boolean;
  expectedOrderMatches?: boolean;
  clipCount: number;
  expectedTargetPresent: boolean;
  expectedAssetPresent: boolean;
  firstClipMatchesExpectedTarget: boolean;
  firstClipId: string | null;
  firstClipAssetId: string | null;
  firstClipTimelineDurationSeconds: number | null;
  firstClipPlaybackRate: number | null;
  privateMediaReferencePresent: boolean;
};

export type VideoAILiveHarnessResult<State> = {
  result: "PRELIVE_BLOCKED" | "SUCCESS" | "ERROR" | "TIMEOUT";
  requestDispatched: boolean;
  requestCount: number;
  responseReceived: boolean;
  response: SafeAITaskResponseEvidence | null;
  editorOutcome: EditorSpecificOutcome | null;
  editorState: State | null;
  preLiveContext: PreLiveSafeContextEvidence;
  actionClickCount: 0 | 1;
  timeoutStage: "ai_tasks_response" | "editor_ui" | null;
};

type HarnessDependencies<State> = {
  readPreLiveSafeContext: () => Promise<PreLiveSafeContextInput>;
  submitOnce: () => Promise<void>;
  getRequestCount: () => number;
  waitForResponse: () => Promise<SafeAITaskResponseEvidence>;
  readEditorSurface: () => Promise<EditorSurfaceSnapshot>;
  captureEditorState: () => Promise<State>;
  timeoutMs: number;
  pollIntervalMs?: number;
  setSubstage?: (substage: string) => void;
};

type LocatorLike = {
  first: () => LocatorLike;
  isVisible: () => Promise<boolean>;
  textContent: () => Promise<string | null>;
};

export type EditorPageLike = {
  locator: (selector: string) => LocatorLike;
};

type RequestLike = {
  method: () => string;
  url: () => string;
};

type ResponseLike = {
  finished: () => Promise<Error | null>;
  json: () => Promise<unknown>;
  request: () => RequestLike;
  status: () => number;
  url: () => string;
};

export type NetworkPageLike = {
  on: (event: "request", listener: (request: RequestLike) => void) => void;
  waitForResponse: (
    predicate: (response: ResponseLike) => boolean,
    options: { timeout: number },
  ) => Promise<ResponseLike>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function containsPrivateMediaReference(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "string") return /(?:https?:\/\/|blob:|data:)/i.test(value);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsPrivateMediaReference(item, seen));
  return Object.entries(value).some(([key, item]) => (
    /(?:url|uri|path|preview|signed|token|authorization|credential|secret)/i.test(key)
    || containsPrivateMediaReference(item, seen)
  ));
}

export function inspectPreLiveSafeEditorContext({
  serializedContext,
  expectedClipId,
  expectedAssetId,
  expectedTargetClipId,
  expectedReferenceClipId,
  expectedClipIds,
}: PreLiveSafeContextInput): PreLiveSafeContextEvidence {
  let value: unknown = null;
  try {
    value = JSON.parse(serializedContext);
  } catch {
    value = null;
  }
  const context = isRecord(value) ? value : {};
  const clips = Array.isArray(context.clips) ? context.clips.filter(isRecord) : [];
  const assets = Array.isArray(context.assets) ? context.assets.filter(isRecord) : [];
  const firstClip = clips[0] ?? null;
  const firstClipId = firstClip ? nullableString(firstClip.id) : null;
  const firstClipAssetId = firstClip ? nullableString(firstClip.assetId) : null;
  const firstClipTimelineDurationSeconds = firstClip
    ? finiteNumber(firstClip.timelineDurationSeconds)
    : null;
  const firstClipPlaybackRate = firstClip ? finiteNumber(firstClip.playbackRate) : null;
  const expectedTargetPresent = clips.some((clip) => (
    clip.id === expectedClipId && clip.assetId === expectedAssetId
  ));
  const expectedAssetPresent = assets.some((asset) => asset.id === expectedAssetId);
  const firstClipMatchesExpectedTarget = firstClipId === expectedClipId
    && firstClipAssetId === expectedAssetId;
  const privateMediaReferencePresent = containsPrivateMediaReference(context);
  const dual = expectedTargetClipId !== undefined || expectedReferenceClipId !== undefined || expectedClipIds !== undefined;
  const expectedReferencePresent = clips.some((clip) => clip.id === expectedReferenceClipId
    && assets.some((asset) => asset.id === clip.assetId));
  const targetReferenceDistinct = Boolean(expectedTargetClipId && expectedReferenceClipId
    && expectedTargetClipId !== expectedReferenceClipId);
  const expectedOrderMatches = Boolean(expectedClipIds?.length === 3
    && new Set(expectedClipIds).size === 3 && clips.length === 3
    && clips.every((clip, i) => clip.id === expectedClipIds[i]
      && assets.some((asset) => asset.id === clip.assetId)
      && Number(clip.timelineDurationSeconds) > 0 && Number(clip.playbackRate) > 0)
    && expectedClipIds[2] === expectedTargetClipId && expectedClipIds[0] === expectedReferenceClipId);
  return {
    ...(dual ? { expectedReferencePresent, targetReferenceDistinct, expectedOrderMatches } : {}),
    eligible: Boolean(
      expectedClipId
      && expectedAssetId
      && expectedTargetPresent
      && expectedAssetPresent
      && (dual ? (expectedClipId === expectedTargetClipId && expectedReferencePresent
        && targetReferenceDistinct && expectedOrderMatches) : firstClipMatchesExpectedTarget)
      && firstClipTimelineDurationSeconds !== null
      && firstClipTimelineDurationSeconds > 0
      && firstClipPlaybackRate !== null
      && firstClipPlaybackRate > 0
      && !privateMediaReferencePresent
    ),
    clipCount: clips.length,
    expectedTargetPresent,
    expectedAssetPresent,
    firstClipMatchesExpectedTarget,
    firstClipId,
    firstClipAssetId,
    firstClipTimelineDurationSeconds,
    firstClipPlaybackRate,
    privateMediaReferencePresent,
  };
}

export function isAITasksRequest(request: RequestLike) {
  if (request.method() !== "POST") return false;
  try {
    return new URL(request.url()).pathname.endsWith(AI_TASKS_PATH_SUFFIX);
  } catch {
    return false;
  }
}

export function summarizeAITaskResponse(
  httpStatus: number,
  responseCompleted: boolean,
  value: unknown,
): SafeAITaskResponseEvidence {
  const body = isRecord(value) ? value : {};
  const result = isRecord(body.result) ? body.result : null;
  const data = result && isRecord(result.data) ? result.data : null;
  const error = isRecord(body.error) ? body.error : null;
  const actions = data && Array.isArray(data.actions)
    ? data.actions.map((item): SafeCanonicalActionEvidence => {
      const action = isRecord(item) ? item : {};
      return {
        type: nullableString(action.type),
        ...(action.referenceId !== undefined ? { referenceId: nullableString(action.referenceId) } : {}),
        ...(action.placement !== undefined ? { placement: nullableString(action.placement) } : {}),
        targetId: nullableString(action.targetId),
        assetId: typeof action.assetId === "string" ? action.assetId : null,
        playbackRate: typeof action.playbackRate === "number" && Number.isFinite(action.playbackRate)
          ? action.playbackRate
          : null,
      };
    })
    : null;
  return {
    httpStatus,
    responseCompleted,
    requestIdPresent: typeof body.requestId === "string" && body.requestId.length > 0,
    ok: body.ok === true,
    errorCode: error ? nullableString(error.code) : null,
    canonical: data
      ? {
          summaryPresent: typeof data.summary === "string" && data.summary.trim().length > 0,
          actions,
          unsupportedIsArray: Array.isArray(data.unsupported),
          warningsIsArray: Array.isArray(data.warnings),
        }
      : null,
  };
}

export function createAITaskNetworkTracker(page: NetworkPageLike, timeoutMs: number) {
  let requestCount = 0;
  page.on("request", (request) => {
    if (isAITasksRequest(request)) requestCount += 1;
  });
  return {
    getRequestCount: () => requestCount,
    waitForResponse: async () => {
      const response = await page.waitForResponse(
        (candidate) => isAITasksRequest(candidate.request()),
        { timeout: timeoutMs },
      );
      const completionError = await response.finished();
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return summarizeAITaskResponse(response.status(), completionError === null, body);
    },
  };
}

async function readLocator(locator: LocatorLike) {
  const first = locator.first();
  const visible = await first.isVisible().catch(() => false);
  if (!visible) return { visible: false, text: "" };
  const text = (await first.textContent().catch(() => null))?.trim() ?? "";
  return { visible, text };
}

export async function readEditorSpecificSurface(page: EditorPageLike): Promise<EditorSurfaceSnapshot> {
  const [success, error] = await Promise.all([
    readLocator(page.locator(VIDEO_AI_SUCCESS_SELECTOR)),
    readLocator(page.locator(VIDEO_AI_ERROR_SELECTOR)),
  ]);
  return {
    successVisible: success.visible,
    successText: success.text,
    errorVisible: error.visible,
    errorText: error.text,
  };
}

export function resolveEditorSpecificOutcome(snapshot: EditorSurfaceSnapshot): EditorSpecificOutcome | null {
  if (snapshot.successVisible && snapshot.successText.trim()) {
    return { kind: "success", text: snapshot.successText.trim() };
  }
  if (snapshot.errorVisible && snapshot.errorText.trim()) {
    return { kind: "error", text: snapshot.errorText.trim() };
  }
  return null;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function withinDeadline<T>(promise: Promise<T>, deadline: number, stage: string): Promise<T> {
  const remaining = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`HARNESS_TIMEOUT:${stage}`)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForEditorOutcome(
  readSurface: () => Promise<EditorSurfaceSnapshot>,
  deadline: number,
  pollIntervalMs: number,
) {
  while (Date.now() < deadline) {
    const outcome = resolveEditorSpecificOutcome(await readSurface());
    if (outcome) return outcome;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error("HARNESS_TIMEOUT:editor_ui");
}

function isTimeout(error: unknown, stage: string) {
  return error instanceof Error && error.message === `HARNESS_TIMEOUT:${stage}`;
}

export async function runExactlyOnceVideoAILiveAcceptance<State>({
  readPreLiveSafeContext,
  submitOnce,
  getRequestCount,
  waitForResponse,
  readEditorSurface,
  captureEditorState,
  timeoutMs,
  pollIntervalMs = 25,
  setSubstage = () => {},
}: HarnessDependencies<State>): Promise<VideoAILiveHarnessResult<State>> {
  setSubstage("LIVE_SUBMIT");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Harness timeout must be positive.");
  if (getRequestCount() !== 0) throw new Error("Harness must start before the ai-tasks request.");
  const deadline = Date.now() + timeoutMs;
  let observationFailed = false;
  setSubstage("LIVE_RESPONSE_WAIT");
  const responsePromise = waitForResponse();
  void responsePromise.catch(() => { observationFailed = true; });
  setSubstage("LIVE_CONTEXT_VALIDATE");
  const preLiveContext = inspectPreLiveSafeEditorContext(await readPreLiveSafeContext());
  if (!preLiveContext.eligible) {
    return {
      result: "PRELIVE_BLOCKED",
      requestDispatched: false,
      requestCount: getRequestCount(),
      responseReceived: false,
      response: null,
      editorOutcome: null,
      editorState: null,
      preLiveContext,
      actionClickCount: 0,
      timeoutStage: null,
    };
  }
  if (observationFailed || Date.now() >= deadline) {
    setSubstage("LIVE_RESPONSE_WAIT");
    throw new Error("Response observer unavailable before submit.");
  }
  let actionClickCount = 0;
  setSubstage("LIVE_SUBMIT");
  actionClickCount += 1;
  await submitOnce();
  let response: SafeAITaskResponseEvidence;
  setSubstage("LIVE_RESPONSE_WAIT");
  try {
    response = await withinDeadline(responsePromise, deadline, "ai_tasks_response");
  } catch (error) {
    if (!isTimeout(error, "ai_tasks_response")) throw error;
    return {
      result: "TIMEOUT",
      requestDispatched: getRequestCount() > 0,
      requestCount: getRequestCount(),
      responseReceived: false,
      response: null,
      editorOutcome: null,
      editorState: null,
      preLiveContext,
      actionClickCount: 1,
      timeoutStage: "ai_tasks_response",
    };
  }
  if (actionClickCount !== 1 || getRequestCount() > 1) {
    throw new Error("Exactly-once ai-tasks guard failed.");
  }
  let editorOutcome: EditorSpecificOutcome;
  setSubstage("LIVE_UI_OUTCOME");
  try {
    editorOutcome = await waitForEditorOutcome(readEditorSurface, deadline, pollIntervalMs);
  } catch (error) {
    if (!isTimeout(error, "editor_ui")) throw error;
    return {
      result: "TIMEOUT",
      requestDispatched: getRequestCount() > 0,
      requestCount: getRequestCount(),
      responseReceived: true,
      response,
      editorOutcome: null,
      editorState: null,
      preLiveContext,
      actionClickCount: 1,
      timeoutStage: "editor_ui",
    };
  }
  setSubstage("LIVE_STATE_CAPTURE");
  const editorState = await captureEditorState();
  return {
    result: editorOutcome.kind === "success" ? "SUCCESS" : "ERROR",
    requestDispatched: getRequestCount() > 0,
    requestCount: getRequestCount(),
    responseReceived: true,
    response,
    editorOutcome,
    editorState,
    preLiveContext,
    actionClickCount: 1,
    timeoutStage: null,
  };
}
