import integrityManifest from "./medclip-asr-integrity.json" with { type: "json" };

export const ONNX_RUNTIME_BUILD = "1.22.0-dev.20250409-89f8206ba4";
export const ONNX_RUNTIME_ASSET_DIRECTORY =
  "runtime/onnxruntime-web/" + ONNX_RUNTIME_BUILD + "/";

type IntegrityEntry = Readonly<{
  sha256: string;
  bytes: number;
  contentType: string;
}>;

type IntegrityManifest = Readonly<Record<string, IntegrityEntry>>;

const runtimeManifest = integrityManifest as IntegrityManifest;

export function resolveMedclipAssetBase(
  configuredBase: string | undefined,
  pageHref: string,
  production: boolean,
): URL {
  const configured = configuredBase?.trim();
  if (!configured) {
    if (production) {
      throw new Error(
        "未配置 NEXT_PUBLIC_MEDCLIP_ASSET_BASE_URL，生产环境不会回退到公共模型 CDN。",
      );
    }
    return new URL("/", pageHref);
  }

  let base: URL;
  try {
    base = new URL(configured);
  } catch {
    throw new Error("NEXT_PUBLIC_MEDCLIP_ASSET_BASE_URL 必须是绝对 HTTPS 地址。");
  }

  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new Error("MedClip 资源基址只支持 HTTP(S)。");
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error("MedClip 资源基址不能包含账号、密码、查询参数或片段。");
  }
  const isLoopback =
    base.hostname === "localhost" ||
    base.hostname === "127.0.0.1" ||
    base.hostname === "[::1]";
  if (base.protocol !== "https:" && !isLoopback) {
    throw new Error("生产外部资源必须使用 HTTPS；HTTP 仅允许本机隔离测试。");
  }
  base.pathname = base.pathname.replace(/\/+$/, "") + "/";
  return base;
}

export function createIntegrityCheckingFetch(
  baseFetch: typeof fetch,
  assetBase: URL,
  manifest: IntegrityManifest = runtimeManifest,
): typeof fetch {
  const asrRoot = new URL("medclip-asr/", assetBase);
  const asrPathPrefix = asrRoot.pathname;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = new URL(
      input instanceof Request ? input.url : String(input),
      assetBase,
    );
    if (
      requestUrl.origin !== asrRoot.origin ||
      !requestUrl.pathname.startsWith(asrPathPrefix)
    ) {
      return baseFetch(input, init);
    }

    const relativePath = decodeURIComponent(requestUrl.pathname.slice(0));
    const manifestPath =
      "medclip-asr/" + relativePath.slice(asrPathPrefix.length);
    const expected = manifest[manifestPath];
    if (!expected) {
      throw new Error("ASR 资源没有固定 SHA-256 清单项：" + manifestPath);
    }

    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const response = await baseFetch(input, init);
    if (!response.ok) {
      throw new Error(
        "ASR 资源请求失败：" + manifestPath + "（HTTP " + response.status + "）",
      );
    }
    if (method !== "GET") return response;
    if (response.status !== 200) {
      throw new Error(
        "ASR 资源必须返回完整文件：" +
          manifestPath +
          "（HTTP " +
          response.status +
          "）",
      );
    }

    const actualType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (actualType !== expected.contentType) {
      throw new Error(
        "ASR 资源 MIME 不匹配：" +
          manifestPath +
          "（期望 " +
          expected.contentType +
          "，收到 " +
          (actualType || "missing") +
          "）",
      );
    }

    if (!globalThis.crypto?.subtle) {
      throw new Error("当前浏览器不支持 SHA-256 资源完整性校验。");
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== expected.bytes) {
      throw new Error(
        "ASR 资源长度不匹配：" +
          manifestPath +
          "（期望 " +
          expected.bytes +
          "，收到 " +
          bytes.byteLength +
          "）",
      );
    }
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const actualHash = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (actualHash !== expected.sha256.toLowerCase()) {
      throw new Error("ASR 资源 SHA-256 不匹配：" + manifestPath);
    }

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("content-range");
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

export async function verifyRuntimeModule(
  checkedFetch: typeof fetch,
  moduleUrl: string,
): Promise<void> {
  const response = await checkedFetch(moduleUrl, { cache: "force-cache" });
  await response.arrayBuffer();
}
