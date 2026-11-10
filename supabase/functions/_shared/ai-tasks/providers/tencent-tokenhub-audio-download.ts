import { SafeTaskError } from "../errors.ts";

export const TOKENHUB_MAX_AUDIO_DOWNLOAD_BYTES = 8 * 1024 * 1024;
export const TOKENHUB_AUDIO_FIRST_RESPONSE_TIMEOUT_MS = 10_000;
export const TOKENHUB_AUDIO_WHOLE_DOWNLOAD_TIMEOUT_MS = 30_000;
export const TOKENHUB_AUDIO_MAX_REDIRECTS = 0;
export const TOKENHUB_AUDIO_ALLOWED_HOSTNAMES = Object.freeze([
  "aigc-output-audio-file-1326893053.cos.ap-guangzhou.myqcloud.com",
] as const);

type ResolveHostname = (hostname: string) => Promise<readonly string[]>;

export type TokenHubAudioDownloadDependencies = {
  fetcher?: typeof fetch;
  resolveHostname?: ResolveHostname;
  firstResponseTimeoutMs?: number;
  wholeDownloadTimeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?: () => number;
  signal?: AbortSignal;
};

export type TokenHubAudioDownloadDiagnostics = {
  urlScheme: "https:";
  normalizedDownloadHostname: string;
  explicitPortPresent: boolean;
  urlCredentialsPresent: false;
  urlFragmentPresent: false;
  urlPolicyValidationMs: number;
  dnsPreflightPerformed: true;
  dnsPreflightResult: "PUBLIC_ONLY";
  dnsResolvedAddressCount: number;
  dnsPrivateAddressDetected: false;
  dnsPreflightMs: number;
  dnsRebindingTOCTOUPresent: true;
  downloadHostAllowlistUsed: boolean;
  downloadHttpStatus: number;
  downloadContentType: string | null;
  downloadContentLengthHeader: number | null;
  downloadedBytes: number;
  downloadRedirectCount: 0;
  downloadFirstResponseMs: number;
  downloadTotalMs: number;
};

export type DownloadedTokenHubAudio = {
  bytes: Uint8Array;
  contentType: string | null;
  contentLength: number | null;
  downloadedBytes: number;
  diagnostics: TokenHubAudioDownloadDiagnostics;
};

const OBVIOUSLY_NON_AUDIO_CONTENT_TYPES = new Set([
  "text/html",
  "application/json",
  "text/plain",
]);

const ACCEPTED_AUDIO_CONTENT_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mpeg3",
  "audio/x-mpeg",
  "application/octet-stream",
]);

function audioDownloadError(
  code:
    | "AUDIO_URL_INVALID"
    | "AUDIO_URL_NON_HTTPS"
    | "AUDIO_URL_CREDENTIALS_PRESENT"
    | "AUDIO_URL_PORT_REJECTED"
    | "AUDIO_URL_HOST_REJECTED"
    | "AUDIO_URL_PRIVATE_ADDRESS"
    | "AUDIO_URL_REDIRECT_REJECTED"
    | "AUDIO_DOWNLOAD_TIMEOUT"
    | "AUDIO_DOWNLOAD_HTTP_ERROR"
    | "AUDIO_DOWNLOAD_TOO_LARGE"
    | "AUDIO_DOWNLOAD_CONTENT_TYPE_REJECTED"
    | "AUDIO_DOWNLOAD_FAILED",
  message: string,
  httpStatus?: number,
): SafeTaskError {
  return new SafeTaskError(code, message, 502, {
    provider: "tencent_tokenhub",
    failureStage: "provider_response",
    providerCallCount: 1,
    ...(httpStatus ? { httpStatus } : {}),
    musicStage: "SUCCESS_CORE_VALIDATED",
  });
}

function parseIPv4(value: string): readonly number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function embeddedIPv4Words(value: string): readonly string[] | null {
  const lastColon = value.lastIndexOf(":");
  const ipv4 = parseIPv4(value.slice(lastColon + 1));
  if (!ipv4) return null;
  return [
    value.slice(0, lastColon),
    ((ipv4[0] << 8) | ipv4[1]).toString(16),
    ((ipv4[2] << 8) | ipv4[3]).toString(16),
  ];
}

function parseIPv6(value: string): readonly number[] | null {
  let normalized = value.toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
  if (normalized.includes("%")) return null;
  if (normalized.includes(".")) {
    const embedded = embeddedIPv4Words(normalized);
    if (!embedded) return null;
    normalized = `${embedded[0]}:${embedded[1]}:${embedded[2]}`;
  }
  if (!/^[0-9a-f:]+$/.test(normalized) || normalized.includes(":::")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array.from({ length: zeros }, () => "0"), ...right].map((word) => Number.parseInt(word, 16));
  return words.length === 8 ? words : null;
}

function publicIPv4(octets: readonly number[]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && octets[2] === 100) return false;
  if (a === 203 && b === 0 && octets[2] === 113) return false;
  if (a >= 224) return false;
  return true;
}

export function isPublicNetworkAddress(value: string): boolean {
  const ipv4 = parseIPv4(value);
  if (ipv4) return publicIPv4(ipv4);
  const words = parseIPv6(value);
  if (!words) return false;
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  if (allZero || loopback) return false;
  if ((words[0] & 0xfe00) === 0xfc00) return false;
  if ((words[0] & 0xffc0) === 0xfe80) return false;
  if ((words[0] & 0xffc0) === 0xfec0) return false;
  if ((words[0] & 0xff00) === 0xff00) return false;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  if (words[0] === 0x0100 && words.slice(1, 4).every((word) => word === 0)) return false;
  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const ipv4Compatible = words.slice(0, 6).every((word) => word === 0);
  if (ipv4Mapped || ipv4Compatible) {
    return publicIPv4([
      words[6] >> 8,
      words[6] & 0xff,
      words[7] >> 8,
      words[7] & 0xff,
    ]);
  }
  return true;
}

async function defaultResolveHostname(hostname: string): Promise<readonly string[]> {
  const deno = (globalThis as typeof globalThis & {
    Deno?: { resolveDns?: (hostname: string, recordType: "A" | "AAAA") => Promise<string[]> };
  }).Deno;
  if (!deno?.resolveDns) {
    throw audioDownloadError("AUDIO_URL_HOST_REJECTED", "Music audio host cannot be verified safely in this runtime.");
  }
  const results = await Promise.allSettled([
    deno.resolveDns(hostname, "A"),
    deno.resolveDns(hostname, "AAAA"),
  ]);
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

function hostnameIsBlocked(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "metadata.google.internal"
    || normalized === "instance-data"
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal")
    || normalized.endsWith(".home")
    || normalized.endsWith(".lan");
}

async function assertSafeHostname(
  hostname: string,
  resolveHostname: ResolveHostname,
  signal?: AbortSignal,
): Promise<{ normalizedHostname: string; resolvedAddressCount: number; allowlistUsed: boolean }> {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!normalized || hostnameIsBlocked(normalized)) {
    throw audioDownloadError("AUDIO_URL_HOST_REJECTED", "Music audio host is not allowed.");
  }
  if (!(TOKENHUB_AUDIO_ALLOWED_HOSTNAMES as readonly string[]).includes(normalized)) {
    throw audioDownloadError("AUDIO_URL_HOST_REJECTED", "Music audio host is not allowlisted.");
  }
  const literalIPv4 = parseIPv4(normalized);
  const literalIPv6 = parseIPv6(normalized);
  const addresses = literalIPv4 || literalIPv6
    ? [normalized]
    : await resolveWithAbort(resolveHostname(normalized), signal);
  if (addresses.length === 0) {
    throw audioDownloadError("AUDIO_URL_HOST_REJECTED", "Music audio host did not resolve safely.");
  }
  if (addresses.some((address) => !isPublicNetworkAddress(address))) {
    throw audioDownloadError("AUDIO_URL_PRIVATE_ADDRESS", "Music audio host resolved to a blocked network address.");
  }
  return {
    normalizedHostname: normalized,
    resolvedAddressCount: addresses.length,
    allowlistUsed: true,
  };
}

function resolveWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(audioDownloadError("AUDIO_DOWNLOAD_TIMEOUT", "Music audio host resolution timed out."));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(audioDownloadError("AUDIO_DOWNLOAD_TIMEOUT", "Music audio host resolution timed out."));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function authorityHasExplicitPort(value: string): boolean {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return false;
  const remainder = value.slice(schemeEnd + 3);
  const authority = remainder.split(/[/?#]/, 1)[0] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.startsWith("[")) {
    const closingBracket = hostPort.indexOf("]");
    return closingBracket >= 0 && hostPort.slice(closingBracket + 1).startsWith(":");
  }
  return hostPort.includes(":");
}

async function validateTokenHubAudioURL(
  value: string,
  dependencies: Pick<TokenHubAudioDownloadDependencies, "resolveHostname" | "signal" | "now"> = {},
): Promise<{
  url: URL;
  urlPolicyValidationMs: number;
  normalizedHostname: string;
  explicitPortPresent: boolean;
  dnsResolvedAddressCount: number;
  dnsPreflightMs: number;
  allowlistUsed: boolean;
}> {
  const now = dependencies.now ?? (() => performance.now());
  const policyStartedAt = now();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw audioDownloadError("AUDIO_URL_INVALID", "Music Provider returned an invalid audio URL.");
  }
  if (url.protocol !== "https:") {
    throw audioDownloadError("AUDIO_URL_NON_HTTPS", "Music Provider audio URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw audioDownloadError("AUDIO_URL_CREDENTIALS_PRESENT", "Music Provider audio URL cannot contain credentials.");
  }
  if (url.hash) {
    throw audioDownloadError("AUDIO_URL_INVALID", "Music Provider audio URL cannot contain a fragment.");
  }
  if (url.port && url.port !== "443") {
    throw audioDownloadError("AUDIO_URL_PORT_REJECTED", "Music Provider audio URL uses a blocked port.");
  }
  const explicitPortPresent = authorityHasExplicitPort(value);
  const urlPolicyValidationMs = Math.max(0, now() - policyStartedAt);
  const dnsStartedAt = now();
  const hostname = await assertSafeHostname(
    url.hostname,
    dependencies.resolveHostname ?? defaultResolveHostname,
    dependencies.signal,
  );
  const dnsPreflightMs = Math.max(0, now() - dnsStartedAt);
  return {
    url,
    urlPolicyValidationMs,
    normalizedHostname: hostname.normalizedHostname,
    explicitPortPresent,
    dnsResolvedAddressCount: hostname.resolvedAddressCount,
    dnsPreflightMs,
    allowlistUsed: hostname.allowlistUsed,
  };
}

export async function parseAndValidateTokenHubAudioURL(
  value: string,
  dependencies: Pick<TokenHubAudioDownloadDependencies, "resolveHostname" | "signal" | "now"> = {},
): Promise<URL> {
  return (await validateTokenHubAudioURL(value, dependencies)).url;
}

function parsedContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) {
    throw audioDownloadError("AUDIO_DOWNLOAD_FAILED", "Music audio response has an invalid content length.");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw audioDownloadError("AUDIO_DOWNLOAD_FAILED", "Music audio response has an invalid content length.");
  }
  return length;
}

function normalizedContentType(value: string | null): string | null {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

function readStreamWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function downloadTokenHubAudioURL(
  value: string,
  dependencies: TokenHubAudioDownloadDependencies = {},
): Promise<DownloadedTokenHubAudio> {
  const fetcher = dependencies.fetcher ?? fetch;
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  const now = dependencies.now ?? (() => performance.now());
  const firstResponseTimeoutMs = dependencies.firstResponseTimeoutMs ?? TOKENHUB_AUDIO_FIRST_RESPONSE_TIMEOUT_MS;
  const wholeDownloadTimeoutMs = dependencies.wholeDownloadTimeoutMs ?? TOKENHUB_AUDIO_WHOLE_DOWNLOAD_TIMEOUT_MS;
  const controller = new AbortController();
  const wholeTimer = setTimer(() => controller.abort(), wholeDownloadTimeoutMs);
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const validated = await validateTokenHubAudioURL(value, { ...dependencies, now, signal: controller.signal });
    const url = validated.url;
    const fetchStartedAt = now();
    responseTimer = setTimer(() => controller.abort(), firstResponseTimeoutMs);
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        headers: {
          Accept: "audio/mpeg, audio/mp3, application/octet-stream;q=0.8",
          "Accept-Encoding": "identity",
        },
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      throw audioDownloadError(
        timedOut ? "AUDIO_DOWNLOAD_TIMEOUT" : "AUDIO_DOWNLOAD_FAILED",
        timedOut ? "Music audio download timed out." : "Music audio download failed.",
      );
    } finally {
      if (responseTimer !== undefined) clearTimer(responseTimer);
      responseTimer = undefined;
    }
    const downloadFirstResponseMs = Math.max(0, now() - fetchStartedAt);
    if (response.status >= 300 && response.status < 400) {
      throw audioDownloadError("AUDIO_URL_REDIRECT_REJECTED", "Music audio redirects are not allowed.", response.status);
    }
    if (!response.ok) {
      throw audioDownloadError("AUDIO_DOWNLOAD_HTTP_ERROR", "Music audio host returned an error.", response.status);
    }
    const contentEncoding = response.headers.get("Content-Encoding")?.trim().toLowerCase();
    if (contentEncoding && contentEncoding !== "identity") {
      throw audioDownloadError("AUDIO_DOWNLOAD_CONTENT_TYPE_REJECTED", "Compressed music audio responses are not accepted.", response.status);
    }
    const contentType = normalizedContentType(response.headers.get("Content-Type"));
    if (contentType && (OBVIOUSLY_NON_AUDIO_CONTENT_TYPES.has(contentType) || !ACCEPTED_AUDIO_CONTENT_TYPES.has(contentType))) {
      throw audioDownloadError("AUDIO_DOWNLOAD_CONTENT_TYPE_REJECTED", "Music audio response has a rejected content type.", response.status);
    }
    const contentLength = parsedContentLength(response.headers.get("Content-Length"));
    if (contentLength !== null && contentLength > TOKENHUB_MAX_AUDIO_DOWNLOAD_BYTES) {
      throw audioDownloadError("AUDIO_DOWNLOAD_TOO_LARGE", "Music audio response exceeds the safe size limit.", response.status);
    }
    if (!response.body) {
      throw audioDownloadError("AUDIO_DOWNLOAD_FAILED", "Music audio response has no readable body.", response.status);
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let downloadedBytes = 0;
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await readStreamWithAbort(reader, controller.signal);
      } catch (error) {
        const timedOut = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
        throw audioDownloadError(
          timedOut ? "AUDIO_DOWNLOAD_TIMEOUT" : "AUDIO_DOWNLOAD_FAILED",
          timedOut ? "Music audio download timed out." : "Music audio stream failed.",
          response.status,
        );
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw audioDownloadError("AUDIO_DOWNLOAD_FAILED", "Music audio stream returned invalid bytes.", response.status);
      }
      downloadedBytes += result.value.byteLength;
      if (downloadedBytes > TOKENHUB_MAX_AUDIO_DOWNLOAD_BYTES) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw audioDownloadError("AUDIO_DOWNLOAD_TOO_LARGE", "Music audio response exceeds the safe size limit.", response.status);
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(downloadedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const downloadTotalMs = Math.max(0, now() - fetchStartedAt);
    return {
      bytes,
      contentType,
      contentLength,
      downloadedBytes,
      diagnostics: {
        urlScheme: "https:",
        normalizedDownloadHostname: validated.normalizedHostname,
        explicitPortPresent: validated.explicitPortPresent,
        urlCredentialsPresent: false,
        urlFragmentPresent: false,
        urlPolicyValidationMs: validated.urlPolicyValidationMs,
        dnsPreflightPerformed: true,
        dnsPreflightResult: "PUBLIC_ONLY",
        dnsResolvedAddressCount: validated.dnsResolvedAddressCount,
        dnsPrivateAddressDetected: false,
        dnsPreflightMs: validated.dnsPreflightMs,
        dnsRebindingTOCTOUPresent: true,
        downloadHostAllowlistUsed: validated.allowlistUsed,
        downloadHttpStatus: response.status,
        downloadContentType: contentType,
        downloadContentLengthHeader: contentLength,
        downloadedBytes,
        downloadRedirectCount: 0,
        downloadFirstResponseMs,
        downloadTotalMs,
      },
    };
  } finally {
    if (responseTimer !== undefined) clearTimer(responseTimer);
    clearTimer(wholeTimer);
    if (controller.signal.aborted) await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}
