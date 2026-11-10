import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SafeTaskError } from "../../supabase/functions/_shared/ai-tasks/errors.ts";
import {
  downloadTokenHubAudioURL,
  isPublicNetworkAddress,
  parseAndValidateTokenHubAudioURL,
  TOKENHUB_AUDIO_ALLOWED_HOSTNAMES,
  TOKENHUB_AUDIO_FIRST_RESPONSE_TIMEOUT_MS,
  TOKENHUB_AUDIO_MAX_REDIRECTS,
  TOKENHUB_AUDIO_WHOLE_DOWNLOAD_TIMEOUT_MS,
  TOKENHUB_MAX_AUDIO_DOWNLOAD_BYTES,
} from "../../supabase/functions/_shared/ai-tasks/providers/tencent-tokenhub-audio-download.ts";
import {
  parseTencentTokenHubMusicResponseWithURL,
  TOKENHUB_MUSIC_OUTPUT_FORMAT,
} from "../../supabase/functions/_shared/ai-tasks/providers/tencent-tokenhub-music.ts";
import { parseAITaskRequest } from "../../supabase/functions/_shared/ai-tasks/request.ts";

const VALID_MPEG_MP3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
const VALID_ID3_MP3 = Uint8Array.from([
  0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0,
  ...VALID_MPEG_MP3,
]);
const PUBLIC_RESOLVER = async () => ["93.184.216.34"];
const TOKENHUB_AUDIO_HOST = "aigc-output-audio-file-1326893053.cos.ap-guangzhou.myqcloud.com";
const SAFE_URL = `https://${TOKENHUB_AUDIO_HOST}/audio.mp3?signature=fixture-secret-not-real`;
const downloaderSource = readFileSync(
  new URL("../../supabase/functions/_shared/ai-tasks/providers/tencent-tokenhub-audio-download.ts", import.meta.url),
  "utf8",
);

function safeDownloadDiagnostics(downloadedBytes = VALID_MPEG_MP3.byteLength) {
  return {
    urlScheme: "https:" as const,
    normalizedDownloadHostname: TOKENHUB_AUDIO_HOST,
    explicitPortPresent: false,
    urlCredentialsPresent: false as const,
    urlFragmentPresent: false as const,
    urlPolicyValidationMs: 1,
    dnsPreflightPerformed: true as const,
    dnsPreflightResult: "PUBLIC_ONLY" as const,
    dnsResolvedAddressCount: 1,
    dnsPrivateAddressDetected: false as const,
    dnsPreflightMs: 2,
    dnsRebindingTOCTOUPresent: true as const,
    downloadHostAllowlistUsed: true,
    downloadHttpStatus: 200,
    downloadContentType: "audio/mpeg",
    downloadContentLengthHeader: downloadedBytes,
    downloadedBytes,
    downloadRedirectCount: 0 as const,
    downloadFirstResponseMs: 3,
    downloadTotalMs: 4,
  };
}

async function expectSafeError(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof SafeTaskError);
    assert.equal(error.code, code);
    assert.equal(JSON.stringify(error).includes("fixture-secret-not-real"), false);
    return true;
  });
}

function response(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return new Response(Uint8Array.from(bytes).buffer, {
    status: 200,
    headers: { "Content-Type": "audio/mpeg", ...headers },
  });
}

function urlPayload(audio: string, musicSize: number | undefined = VALID_MPEG_MP3.byteLength) {
  return {
    data: { status: 2, audio },
    base_resp: { status_code: 0, status_msg: "success" },
    extra_info: {
      music_duration: 1,
      ...(musicSize === undefined ? {} : { music_size: musicSize }),
    },
  };
}

test("secure TokenHub URL downloader accepts bounded HTTPS MP3 without forwarding credentials", async () => {
  let capturedInit: RequestInit | undefined;
  const downloaded = await downloadTokenHubAudioURL(SAFE_URL, {
    resolveHostname: PUBLIC_RESOLVER,
    fetcher: async (_url, init) => {
      capturedInit = init;
      return response(VALID_ID3_MP3, { "Content-Length": String(VALID_ID3_MP3.byteLength) });
    },
  });
  assert.deepEqual(downloaded.bytes, VALID_ID3_MP3);
  assert.equal(downloaded.downloadedBytes, VALID_ID3_MP3.byteLength);
  assert.equal(downloaded.diagnostics.normalizedDownloadHostname, TOKENHUB_AUDIO_HOST);
  assert.equal(downloaded.diagnostics.downloadHostAllowlistUsed, true);
  assert.deepEqual(TOKENHUB_AUDIO_ALLOWED_HOSTNAMES, [TOKENHUB_AUDIO_HOST]);
  assert.equal(downloaded.diagnostics.dnsPreflightResult, "PUBLIC_ONLY");
  assert.equal(downloaded.diagnostics.dnsResolvedAddressCount, 1);
  assert.equal(downloaded.diagnostics.dnsRebindingTOCTOUPresent, true);
  assert.equal(downloaded.diagnostics.downloadRedirectCount, 0);
  assert.ok(downloaded.diagnostics.urlPolicyValidationMs >= 0);
  assert.ok(downloaded.diagnostics.dnsPreflightMs >= 0);
  assert.ok(downloaded.diagnostics.downloadFirstResponseMs >= 0);
  assert.ok(downloaded.diagnostics.downloadTotalMs >= downloaded.diagnostics.downloadFirstResponseMs);
  assert.equal(JSON.stringify(downloaded.diagnostics).includes("audio.mp3"), false);
  assert.equal(JSON.stringify(downloaded.diagnostics).includes("fixture-secret-not-real"), false);
  assert.equal(capturedInit?.redirect, "manual");
  assert.equal(capturedInit?.credentials, "omit");
  assert.equal(capturedInit?.referrerPolicy, "no-referrer");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.has("Authorization"), false);
  assert.equal(headers.has("Cookie"), false);
  assert.equal(headers.has("Origin"), false);
  assert.equal(headers.has("Referer"), false);
  assert.equal(headers.has("apikey"), false);
  assert.equal(headers.get("Accept-Encoding"), "identity");
  assert.equal(TOKENHUB_AUDIO_MAX_REDIRECTS, 0);
  assert.equal(TOKENHUB_AUDIO_FIRST_RESPONSE_TIMEOUT_MS, 10_000);
  assert.equal(TOKENHUB_AUDIO_WHOLE_DOWNLOAD_TIMEOUT_MS, 30_000);
});

test("URL parser enforces HTTPS, no credentials, no fragments and standard port", async () => {
  await expectSafeError(() => parseAndValidateTokenHubAudioURL(`http://${TOKENHUB_AUDIO_HOST}/a.mp3`, { resolveHostname: PUBLIC_RESOLVER }), "AUDIO_URL_NON_HTTPS");
  await expectSafeError(() => parseAndValidateTokenHubAudioURL(`ftp://${TOKENHUB_AUDIO_HOST}/a.mp3`, { resolveHostname: PUBLIC_RESOLVER }), "AUDIO_URL_NON_HTTPS");
  await expectSafeError(() => parseAndValidateTokenHubAudioURL(`https://user:pass@${TOKENHUB_AUDIO_HOST}/a.mp3`, { resolveHostname: PUBLIC_RESOLVER }), "AUDIO_URL_CREDENTIALS_PRESENT");
  await expectSafeError(() => parseAndValidateTokenHubAudioURL(`https://${TOKENHUB_AUDIO_HOST}:8443/a.mp3`, { resolveHostname: PUBLIC_RESOLVER }), "AUDIO_URL_PORT_REJECTED");
  await expectSafeError(() => parseAndValidateTokenHubAudioURL(`https://${TOKENHUB_AUDIO_HOST}/a.mp3#fragment`, { resolveHostname: PUBLIC_RESOLVER }), "AUDIO_URL_INVALID");
});

test("TokenHub media hostname allowlist uses exact normalized equality and rejects confusion hosts before DNS", async () => {
  let resolutionCalls = 0;
  const resolver = async () => {
    resolutionCalls += 1;
    return ["93.184.216.34"];
  };
  const rejectedHosts = [
    "evil.com",
    `${TOKENHUB_AUDIO_HOST}.evil.com`,
    `evil-${TOKENHUB_AUDIO_HOST}`,
    `sub.${TOKENHUB_AUDIO_HOST}`,
    "cos.ap-guangzhou.myqcloud.com",
    "another-bucket.cos.ap-guangzhou.myqcloud.com",
    "myqcloud.com",
    `${TOKENHUB_AUDIO_HOST}.`,
    "xn--bcher-kva.example",
    `${TOKENHUB_AUDIO_HOST}\u3002evil.com`,
  ];
  for (const host of rejectedHosts) {
    await expectSafeError(
      () => parseAndValidateTokenHubAudioURL(`https://${host}/a.mp3`, { resolveHostname: resolver }),
      "AUDIO_URL_HOST_REJECTED",
    );
  }
  assert.equal(resolutionCalls, 0);

  const mixedCase = TOKENHUB_AUDIO_HOST.toUpperCase();
  const parsed = await parseAndValidateTokenHubAudioURL(`https://${mixedCase}/a.mp3`, { resolveHostname: resolver });
  assert.equal(parsed.hostname, TOKENHUB_AUDIO_HOST);
  assert.equal(resolutionCalls, 1);
});

test("SSRF policy rejects localhost, private, link-local, metadata and mapped addresses", async () => {
  const blocked = [
    "https://localhost/a.mp3",
    "https://127.0.0.1/a.mp3",
    "https://10.0.0.1/a.mp3",
    "https://172.16.0.1/a.mp3",
    "https://192.168.1.1/a.mp3",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/a.mp3",
    "https://[fc00::1]/a.mp3",
    "https://[fe80::1]/a.mp3",
    "https://[::ffff:127.0.0.1]/a.mp3",
    "https://metadata.google.internal/a.mp3",
  ];
  for (const url of blocked) {
    await assert.rejects(
      () => parseAndValidateTokenHubAudioURL(url, { resolveHostname: PUBLIC_RESOLVER }),
      (error: unknown) => error instanceof SafeTaskError
        && (error.code === "AUDIO_URL_HOST_REJECTED" || error.code === "AUDIO_URL_PRIVATE_ADDRESS"),
    );
  }
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicNetworkAddress(address), false);
  }
  assert.equal(isPublicNetworkAddress("93.184.216.34"), true);
  assert.equal(isPublicNetworkAddress("2606:4700:4700::1111"), true);
});

test("DNS answers are all checked and any private answer rejects the host", async () => {
  await expectSafeError(
    () => parseAndValidateTokenHubAudioURL(`https://${TOKENHUB_AUDIO_HOST}/a.mp3`, {
      resolveHostname: async () => ["93.184.216.34", "10.0.0.7"],
    }),
    "AUDIO_URL_PRIVATE_ADDRESS",
  );
});

test("redirects including redirect-to-localhost fail closed without following Location", async () => {
  let calls = 0;
  for (const location of [`https://${TOKENHUB_AUDIO_HOST}/next.mp3`, "http://127.0.0.1/private"]) {
    calls = 0;
    await expectSafeError(
      () => downloadTokenHubAudioURL(SAFE_URL, {
        resolveHostname: PUBLIC_RESOLVER,
        fetcher: async () => {
          calls += 1;
          return new Response(null, { status: 302, headers: { Location: location } });
        },
      }),
      "AUDIO_URL_REDIRECT_REJECTED",
    );
    assert.equal(calls, 1);
  }
});

test("HTTP errors, content types and compression fail closed", async () => {
  for (const status of [404, 500]) {
    await expectSafeError(
      () => downloadTokenHubAudioURL(SAFE_URL, {
        resolveHostname: PUBLIC_RESOLVER,
        fetcher: async () => new Response(null, { status }),
      }),
      "AUDIO_DOWNLOAD_HTTP_ERROR",
    );
  }
  for (const contentType of ["text/html", "application/json", "text/plain", "image/png"]) {
    await expectSafeError(
      () => downloadTokenHubAudioURL(SAFE_URL, {
        resolveHostname: PUBLIC_RESOLVER,
        fetcher: async () => response(VALID_MPEG_MP3, { "Content-Type": contentType }),
      }),
      "AUDIO_DOWNLOAD_CONTENT_TYPE_REJECTED",
    );
  }
  await expectSafeError(
    () => downloadTokenHubAudioURL(SAFE_URL, {
      resolveHostname: PUBLIC_RESOLVER,
      fetcher: async () => response(VALID_MPEG_MP3, { "Content-Encoding": "gzip" }),
    }),
    "AUDIO_DOWNLOAD_CONTENT_TYPE_REJECTED",
  );
});

test("Content-Length and streamed bytes independently enforce the 8 MiB limit", async () => {
  await expectSafeError(
    () => downloadTokenHubAudioURL(SAFE_URL, {
      resolveHostname: PUBLIC_RESOLVER,
      fetcher: async () => response(VALID_MPEG_MP3, { "Content-Length": String(TOKENHUB_MAX_AUDIO_DOWNLOAD_BYTES + 1) }),
    }),
    "AUDIO_DOWNLOAD_TOO_LARGE",
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(TOKENHUB_MAX_AUDIO_DOWNLOAD_BYTES));
      controller.enqueue(Uint8Array.of(0));
      controller.close();
    },
  });
  await expectSafeError(
    () => downloadTokenHubAudioURL(SAFE_URL, {
      resolveHostname: PUBLIC_RESOLVER,
      fetcher: async () => new Response(stream, { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
    }),
    "AUDIO_DOWNLOAD_TOO_LARGE",
  );
});

test("missing Content-Length is accepted but the actual streamed MP3 remains authoritative", async () => {
  const downloaded = await downloadTokenHubAudioURL(SAFE_URL, {
    resolveHostname: PUBLIC_RESOLVER,
    fetcher: async () => response(VALID_MPEG_MP3),
  });
  assert.equal(downloaded.contentLength, null);
  assert.equal(downloaded.downloadedBytes, VALID_MPEG_MP3.byteLength);
});

test("first-response and whole-download timeouts fail safely", async () => {
  const waitForAbort = (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  await expectSafeError(
    () => downloadTokenHubAudioURL(SAFE_URL, {
      resolveHostname: PUBLIC_RESOLVER,
      fetcher: waitForAbort,
      firstResponseTimeoutMs: 5,
      wholeDownloadTimeoutMs: 50,
    }),
    "AUDIO_DOWNLOAD_TIMEOUT",
  );
  const hangingBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(VALID_MPEG_MP3.slice(0, 4));
    },
  });
  await expectSafeError(
    () => downloadTokenHubAudioURL(SAFE_URL, {
      resolveHostname: PUBLIC_RESOLVER,
      fetcher: async () => new Response(hangingBody, { status: 200, headers: { "Content-Type": "audio/mpeg" } }),
      firstResponseTimeoutMs: 50,
      wholeDownloadTimeoutMs: 5,
    }),
    "AUDIO_DOWNLOAD_TIMEOUT",
  );
  await expectSafeError(
    () => downloadTokenHubAudioURL(SAFE_URL, {
      resolveHostname: async () => await new Promise<readonly string[]>(() => undefined),
      fetcher: async () => response(VALID_MPEG_MP3),
      firstResponseTimeoutMs: 50,
      wholeDownloadTimeoutMs: 5,
    }),
    "AUDIO_DOWNLOAD_TIMEOUT",
  );
});

test("URL response ingestion validates MP3 bytes and provider music_size without retaining URL", async () => {
  const parsed = await parseTencentTokenHubMusicResponseWithURL(200, urlPayload(SAFE_URL), {
    downloadAudio: async () => ({
      bytes: VALID_MPEG_MP3,
      contentType: "audio/mpeg",
      contentLength: VALID_MPEG_MP3.byteLength,
      downloadedBytes: VALID_MPEG_MP3.byteLength,
      diagnostics: safeDownloadDiagnostics(),
    }),
  });
  assert.deepEqual(parsed.audioBytes, VALID_MPEG_MP3);
  assert.equal(JSON.stringify(parsed).includes(SAFE_URL), false);
  assert.equal(parsed.metadata.musicSize, VALID_MPEG_MP3.byteLength);
  assert.equal(parsed.trustedURLDiagnostics?.normalized_download_hostname, TOKENHUB_AUDIO_HOST);
  assert.equal(parsed.trustedURLDiagnostics?.provider_http_status, 200);
  assert.equal(parsed.trustedURLDiagnostics?.success_core_validated, true);
  assert.equal(parsed.trustedURLDiagnostics?.downloaded_bytes, VALID_MPEG_MP3.byteLength);
  assert.equal(parsed.metrics.urlPolicyValidationMs, 1);
  assert.equal(parsed.metrics.dnsPreflightMs, 2);
  assert.equal(parsed.metrics.downloadFirstResponseMs, 3);
  assert.equal(parsed.metrics.downloadTotalMs, 4);
  await expectSafeError(
    () => parseTencentTokenHubMusicResponseWithURL(200, urlPayload(SAFE_URL, VALID_MPEG_MP3.byteLength + 1), {
      downloadAudio: async () => ({ bytes: VALID_MPEG_MP3, contentType: "audio/mpeg", contentLength: null, downloadedBytes: VALID_MPEG_MP3.byteLength, diagnostics: safeDownloadDiagnostics() }),
    }),
    "AUDIO_SIZE_MISMATCH",
  );
  await expectSafeError(
    () => parseTencentTokenHubMusicResponseWithURL(200, urlPayload(SAFE_URL, 5), {
      downloadAudio: async () => ({ bytes: Uint8Array.from([1, 2, 3, 4, 5]), contentType: "application/octet-stream", contentLength: null, downloadedBytes: 5, diagnostics: safeDownloadDiagnostics(5) }),
    }),
    "AUDIO_MP3_INVALID",
  );
});

test("browser cannot inject a download URL and URL output stays server-controlled", () => {
  assert.equal(TOKENHUB_MUSIC_OUTPUT_FORMAT, "url");
  for (const field of ["audioUrl", "providerUrl", "downloadUrl", "allowedHostnames", "allowAllHosts", "bypassHostCheck"]) {
    assert.throws(() => parseAITaskRequest({
      task: "music.generate",
      provider: "tencent_tokenhub",
      input: { operationId: "op_20261003_url_injection", mode: "instrumental", prompt: "fixture", [field]: SAFE_URL },
    }));
  }
  assert.match(downloaderSource, /redirect:\s*"manual"/);
  assert.match(downloaderSource, /credentials:\s*"omit"/);
  assert.match(downloaderSource, /"Accept-Encoding":\s*"identity"/);
  assert.doesNotMatch(downloaderSource, /Authorization\s*:/);
  assert.doesNotMatch(downloaderSource, /arrayBuffer\s*\(/);
});
