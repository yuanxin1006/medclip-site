import integrityManifest from "./medclip-asr-integrity.json" with { type: "json" };

export const ONNX_RUNTIME_BUILD = "1.22.0-dev.20250409-89f8206ba4";
export const ONNX_RUNTIME_ASSET_DIRECTORY = "runtime/onnxruntime-web/" + ONNX_RUNTIME_BUILD + "/";
export const HF_PUBLIC_MODEL_HOST = "https://huggingface.co/";
export const HF_PUBLIC_MODEL_PATH_TEMPLATE = "{model}/resolve/{revision}/";
export const HF_TRANSFORMERS_RUNTIME_BASE = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/";

type IntegrityEntry = Readonly<{ sha256: string; bytes: number; contentType: string }>;
type IntegrityManifest = Readonly<Record<string, IntegrityEntry>>;
export type IntegritySourceRoute = Readonly<{
  requestBase: string;
  manifestPrefix: string;
  allowedFinalOrigins: readonly string[];
  mimeAliases?: Readonly<Record<string, readonly string[]>>;
}>;
export type IntegrityCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
  keys(): Promise<readonly Request[]>;
};
export type IntegrityCacheStorage = { open(name: string): Promise<IntegrityCache> };
export type IntegrityFetchOptions = Readonly<{
  routes?: readonly IntegritySourceRoute[];
  rejectUnmappedRequests?: boolean;
  cacheStorage?: IntegrityCacheStorage | null;
}>;

const runtimeManifest = integrityManifest as IntegrityManifest;
const VERIFIED_CACHE_NAME = "medclip-asr-verified-v1";
const VERIFIED_CACHE_KEY_BASE = "https://medclip-asr-content.invalid/";
export const MAX_VERIFIED_MODEL_CACHE_BYTES = 160 * 1024 * 1024;

export function isHuggingFaceAsrPreviewEnabled(mode: string | undefined, context: string | undefined): boolean {
  return mode === "hf-public" && context === "deploy-preview";
}

export function createHuggingFaceWhisperAssetRoutes(revisions: Readonly<Record<string, string>>): readonly IntegritySourceRoute[] {
  const modelRoutes = Object.entries(revisions).map(([model, revision]) => {
    const manifestPrefix = "medclip-asr/" + model + "/" + revision + "/";
    const mimeAliases: Record<string, readonly string[]> = {};
    for (const file of ["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "README.md"]) {
      mimeAliases[manifestPrefix + file] = ["text/plain"];
    }
    return Object.freeze({
      requestBase: HF_PUBLIC_MODEL_HOST + model + "/resolve/" + revision + "/",
      manifestPrefix,
      allowedFinalOrigins: Object.freeze(["https://huggingface.co", "https://us.aws.cdn.hf.co"]),
      mimeAliases: Object.freeze(mimeAliases),
    });
  });
  const runtimeManifestPrefix = "medclip-asr/" + ONNX_RUNTIME_ASSET_DIRECTORY;
  const runtimeRoute = Object.freeze({
    requestBase: HF_TRANSFORMERS_RUNTIME_BASE,
    manifestPrefix: runtimeManifestPrefix,
    allowedFinalOrigins: Object.freeze(["https://cdn.jsdelivr.net"]),
    mimeAliases: Object.freeze({
      [runtimeManifestPrefix + "ort-wasm-simd-threaded.jsep.mjs"]: Object.freeze(["application/javascript"]),
    }),
  });
  return Object.freeze([...modelRoutes, runtimeRoute]);
}

export function resolveMedclipAssetBase(configuredBase: string | undefined, pageHref: string, production: boolean): URL {
  const configured = configuredBase?.trim();
  if (!configured) {
    if (production) throw new Error("未配置 NEXT_PUBLIC_MEDCLIP_ASSET_BASE_URL，生产环境不会回退到公共模型 CDN。");
    return new URL("/", pageHref);
  }
  let base: URL;
  try { base = new URL(configured); } catch {
    throw new Error("NEXT_PUBLIC_MEDCLIP_ASSET_BASE_URL 必须是绝对 HTTPS 地址。");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("MedClip 资源基址只支持 HTTP(S)。");
  if (base.username || base.password || base.search || base.hash) throw new Error("MedClip 资源基址不能包含账号、密码、查询参数或片段。");
  const isLoopback = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";
  if (base.protocol !== "https:" && !isLoopback) throw new Error("生产外部资源必须使用 HTTPS；HTTP 仅允许本机隔离测试。");
  base.pathname = base.pathname.replace(/\/+$/, "") + "/";
  return base;
}

function manifestCacheBudget(manifest: IntegrityManifest): number {
  const unique = new Map<string, number>();
  for (const entry of Object.values(manifest)) {
    const hash = entry.sha256.toLowerCase();
    const known = unique.get(hash);
    if (known !== undefined && known !== entry.bytes) return Number.POSITIVE_INFINITY;
    unique.set(hash, entry.bytes);
  }
  return [...unique.values()].reduce((total, size) => total + size, 0);
}

function cacheKey(hash: string): Request {
  return new Request(VERIFIED_CACHE_KEY_BASE + hash, { method: "GET" });
}

function mapRequest(requestUrl: URL, assetBase: URL, asrRoot: URL, routes: readonly IntegritySourceRoute[]) {
  if (requestUrl.origin === asrRoot.origin && requestUrl.pathname.startsWith(asrRoot.pathname)) {
    return {
      manifestPath: "medclip-asr/" + decodeURIComponent(requestUrl.pathname.slice(asrRoot.pathname.length)),
      allowedFinalOrigins: [assetBase.origin],
      mimeAliases: undefined as Readonly<Record<string, readonly string[]>> | undefined,
    };
  }
  for (const route of routes) {
    const base = new URL(route.requestBase);
    if (requestUrl.origin === base.origin && requestUrl.pathname.startsWith(base.pathname)) {
      return {
        manifestPath: route.manifestPrefix + decodeURIComponent(requestUrl.pathname.slice(base.pathname.length)),
        allowedFinalOrigins: route.allowedFinalOrigins,
        mimeAliases: route.mimeAliases,
      };
    }
  }
  return null;
}

function normalizedHeaders(response: Response, expected: IntegrityEntry): Headers {
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "content-range", "cache-control", "expires", "pragma"]) headers.delete(name);
  headers.set("content-type", expected.contentType);
  return headers;
}

async function verifyResponse(response: Response, expected: IntegrityEntry, path: string, allowedOrigins: readonly string[], mimeAliases: readonly string[] = [], checkUrl = true): Promise<Response> {
  if (!response.ok) throw new Error("ASR 资源请求失败：" + path + "（HTTP " + response.status + "）");
  if (response.status !== 200) throw new Error("ASR 资源必须返回完整文件：" + path + "（HTTP " + response.status + "）");
  if (checkUrl && response.url && !allowedOrigins.includes(new URL(response.url).origin)) {
    throw new Error("ASR 资源重定向到未允许的来源：" + new URL(response.url).origin);
  }
  const actualType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const allowedTypes = new Set([expected.contentType.toLowerCase(), ...mimeAliases.map((type) => type.toLowerCase())]);
  if (!allowedTypes.has(actualType)) {
    throw new Error("ASR 资源 MIME 不匹配：" + path + "（期望 " + [...allowedTypes].join(" 或 ") + "，收到 " + (actualType || "missing") + "）");
  }
  if (!globalThis.crypto?.subtle) throw new Error("当前浏览器不支持 SHA-256 资源完整性校验。");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== expected.bytes) throw new Error("ASR 资源长度不匹配：" + path + "（期望 " + expected.bytes + "，收到 " + bytes.byteLength + "）");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  if (hash !== expected.sha256.toLowerCase()) throw new Error("ASR 资源 SHA-256 不匹配：" + path);
  return new Response(bytes, { status: 200, headers: normalizedHeaders(response, expected) });
}

export function createIntegrityCheckingFetch(baseFetch: typeof fetch, assetBase: URL, manifest: IntegrityManifest = runtimeManifest, options: IntegrityFetchOptions = {}): typeof fetch {
  const asrRoot = new URL("medclip-asr/", assetBase);
  const routes = options.routes ?? [];
  const strict = options.rejectUnmappedRequests ?? false;
  const globalCache = typeof globalThis.caches === "undefined" ? null : globalThis.caches as unknown as IntegrityCacheStorage;
  const cacheStorage = options.cacheStorage === undefined ? globalCache : options.cacheStorage;
  const useCache = !!cacheStorage && manifestCacheBudget(manifest) <= MAX_VERIFIED_MODEL_CACHE_BYTES;
  let cachePromise: Promise<IntegrityCache | null> | null = null;
  const getCache = async (): Promise<IntegrityCache | null> => {
    if (!useCache || !cacheStorage) return null;
    if (!cachePromise) {
      cachePromise = (async () => {
        try {
          const cache = await cacheStorage.open(VERIFIED_CACHE_NAME);
          const validHashes = new Set(Object.values(manifest).map((entry) => entry.sha256.toLowerCase()));
          for (const request of await cache.keys()) {
            const hash = new URL(request.url).pathname.slice(1).toLowerCase();
            if (!validHashes.has(hash)) await cache.delete(request);
          }
          return cache;
        } catch { return null; }
      })();
    }
    return cachePromise;
  };

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input), assetBase);
    const mapped = mapRequest(requestUrl, assetBase, asrRoot, routes);
    if (!mapped) {
      if (strict) throw new Error("ASR 请求地址不在固定资源映射中：" + requestUrl.origin + requestUrl.pathname);
      return baseFetch(input, init);
    }
    if (requestUrl.search || requestUrl.hash) throw new Error("固定 ASR 资源 URL 不允许查询参数或片段。");
    const path = mapped.manifestPath;
    if (path.startsWith("/") || path.split("/").some((part) => part === "." || part === "..")) throw new Error("ASR 资源路径无效。");
    const expected = manifest[path];
    if (!expected) throw new Error("ASR 资源没有固定 SHA-256 清单项：" + path);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") throw new Error("固定 ASR 资源仅允许 GET 请求。");

    const cache = await getCache();
    const key = cacheKey(expected.sha256.toLowerCase());
    if (cache) {
      try {
        const saved = await cache.match(key);
        if (saved) {
          try { return await verifyResponse(saved, expected, path, mapped.allowedFinalOrigins, [expected.contentType], false); }
          catch { await cache.delete(key); }
        }
      } catch { /* Storage failures do not prevent online retry. */ }
    }

    const response = await baseFetch(input, init);
    const checked = await verifyResponse(response, expected, path, mapped.allowedFinalOrigins, mapped.mimeAliases?.[path] ?? []);
    if (cache) {
      try { await cache.put(key, checked.clone()); }
      catch { /* A verified download remains usable if persistent storage is unavailable. */ }
    }
    return checked;
  };
}

export async function verifyRuntimeModule(checkedFetch: typeof fetch, moduleUrl: string): Promise<void> {
  const response = await checkedFetch(moduleUrl, { cache: "force-cache" });
  await response.arrayBuffer();
}