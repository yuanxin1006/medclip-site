import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { type IntegritySourceRoute, createHuggingFaceWhisperAssetRoutes, createIntegrityCheckingFetch, isHuggingFaceAsrPreviewEnabled, MAX_VERIFIED_MODEL_CACHE_BYTES, resolveMedclipAssetBase } from "./medclip-assets.ts";

function integrityFor(bytes: Uint8Array, contentType = "application/wasm", path = "medclip-asr/runtime/test.wasm") {
  return { [path]: { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, contentType } };
}
function memoryCacheStorage() {
  const values = new Map<string, Response>();
  const cache = {
    match: async (request: Request) => values.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => { values.set(request.url, response.clone()); },
    delete: async (request: Request) => values.delete(request.url),
    keys: async () => [...values.keys()].map((url) => new Request(url)),
  };
  return { open: async () => cache };
}

test("asset base defaults to same-origin only in development", () => {
  assert.equal(resolveMedclipAssetBase("", "http://localhost:3000/editor", false).href, "http://localhost:3000/");
  assert.throws(() => resolveMedclipAssetBase("", "https://medclip.example/editor", true), /NEXT_PUBLIC_MEDCLIP_ASSET_BASE_URL/);
});
test("external asset base is HTTPS-only outside loopback and normalized", () => {
  assert.equal(resolveMedclipAssetBase("https://assets.example.net/medclip/v1", "https://site.example", true).href, "https://assets.example.net/medclip/v1/");
  assert.equal(resolveMedclipAssetBase("http://127.0.0.1:3573", "http://127.0.0.1:3572", true).href, "http://127.0.0.1:3573/");
  assert.throws(() => resolveMedclipAssetBase("http://assets.example.net/medclip", "https://site.example", true), /必须使用 HTTPS/);
  assert.throws(() => resolveMedclipAssetBase("https://user:pass@assets.example.net/model", "https://site.example", true), /不能包含账号/);
});
test("public model source is enabled only for Deploy Preview", () => {
  assert.equal(isHuggingFaceAsrPreviewEnabled(undefined, undefined), false);
  assert.equal(isHuggingFaceAsrPreviewEnabled("hf-public", undefined), false);
  assert.equal(isHuggingFaceAsrPreviewEnabled("hf-public", "production"), false);
  assert.equal(isHuggingFaceAsrPreviewEnabled("other", "deploy-preview"), false);
  assert.equal(isHuggingFaceAsrPreviewEnabled("hf-public", "deploy-preview"), true);
});
test("public model/runtime sources are pinned", () => {
  const routes = createHuggingFaceWhisperAssetRoutes({
    "Xenova/whisper-base": "64da57285918e20ea79ea5c88eed7197933abaa8",
    "Xenova/whisper-tiny": "5332fcc35e32a33b86612b9a57a89be7906102b1",
  });
  assert.equal(routes.length, 3);
  assert.equal(routes[0].requestBase, "https://huggingface.co/Xenova/whisper-base/resolve/64da57285918e20ea79ea5c88eed7197933abaa8/");
  assert.equal(routes[1].requestBase, "https://huggingface.co/Xenova/whisper-tiny/resolve/5332fcc35e32a33b86612b9a57a89be7906102b1/");
  assert.equal(routes[2].requestBase, "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/");
  assert.equal(MAX_VERIFIED_MODEL_CACHE_BYTES, 160 * 1024 * 1024);
});
test("observed text/plain is accepted only with matching bytes and hash", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ok: true }));
  const path = "medclip-asr/Xenova/whisper-base/revision/config.json";
  const route = { requestBase: "https://huggingface.co/Xenova/whisper-base/resolve/revision/", manifestPrefix: "medclip-asr/Xenova/whisper-base/revision/", allowedFinalOrigins: ["https://huggingface.co", "https://us.aws.cdn.hf.co"], mimeAliases: { [path]: ["text/plain"] } };
  const fetcher = createIntegrityCheckingFetch(async () => new Response(bytes, { headers: { "content-type": "text/plain; charset=utf-8" } }), new URL("https://app.example/"), integrityFor(bytes, "application/json", path), { routes: [route], rejectUnmappedRequests: true, cacheStorage: null });
  const response = await fetcher(route.requestBase + "config.json");
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(await response.text(), JSON.stringify({ ok: true }));
});
test("public MIME aliases do not permit HTML", async () => {
  const bytes = new TextEncoder().encode("<html>bad</html>");
  const path = "medclip-asr/Xenova/whisper-base/revision/config.json";
  const route = { requestBase: "https://huggingface.co/Xenova/whisper-base/resolve/revision/", manifestPrefix: "medclip-asr/Xenova/whisper-base/revision/", allowedFinalOrigins: ["https://huggingface.co"], mimeAliases: { [path]: ["text/plain"] } };
  const fetcher = createIntegrityCheckingFetch(async () => new Response(bytes, { headers: { "content-type": "text/html" } }), new URL("https://app.example/"), integrityFor(bytes, "application/json", path), { routes: [route], rejectUnmappedRequests: true, cacheStorage: null });
  await assert.rejects(fetcher(route.requestBase + "config.json"), /MIME 不匹配/);
});
test("verified cache reuses shared files across worker instances and model URLs", async () => {
  const bytes = new TextEncoder().encode("shared tokenizer");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const basePath = "medclip-asr/Xenova/whisper-base/revision/tokenizer.json";
  const tinyPath = "medclip-asr/Xenova/whisper-tiny/revision/tokenizer.json";
  const manifest = {
    [basePath]: { sha256, bytes: bytes.length, contentType: "application/json" },
    [tinyPath]: { sha256, bytes: bytes.length, contentType: "application/json" },
  };
  const routes: IntegritySourceRoute[] = [
    { requestBase: "https://huggingface.co/Xenova/whisper-base/resolve/revision/", manifestPrefix: "medclip-asr/Xenova/whisper-base/revision/", allowedFinalOrigins: ["https://huggingface.co"], mimeAliases: { [basePath]: ["text/plain"] } },
    { requestBase: "https://huggingface.co/Xenova/whisper-tiny/resolve/revision/", manifestPrefix: "medclip-asr/Xenova/whisper-tiny/revision/", allowedFinalOrigins: ["https://huggingface.co"], mimeAliases: { [tinyPath]: ["text/plain"] } },
  ];
  const values = new Map<string, Response>();
  const storage = { open: async () => ({
    match: async (request: Request) => values.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => { values.set(request.url, response.clone()); },
    delete: async (request: Request) => values.delete(request.url),
    keys: async () => [...values.keys()].map((url) => new Request(url)),
  }) };
  let networkCalls = 0;
  const networkFetch: typeof fetch = async () => { networkCalls++; return new Response(bytes, { headers: { "content-type": "text/plain" } }); };
  const first = createIntegrityCheckingFetch(networkFetch, new URL("https://app.example/"), manifest, { routes, rejectUnmappedRequests: true, cacheStorage: storage });
  assert.equal(await (await first(routes[0].requestBase + "tokenizer.json")).text(), "shared tokenizer");
  const afterReload = createIntegrityCheckingFetch(networkFetch, new URL("https://app.example/"), manifest, { routes, rejectUnmappedRequests: true, cacheStorage: storage });
  assert.equal(await (await afterReload(routes[1].requestBase + "tokenizer.json")).text(), "shared tokenizer");
  assert.equal(networkCalls, 1);
});
test("failed fetch is not cached and can be retried", async () => {
  const bytes = new TextEncoder().encode("retry");
  const path = "medclip-asr/Xenova/whisper-base/revision/config.json";
  const route = { requestBase: "https://huggingface.co/Xenova/whisper-base/resolve/revision/", manifestPrefix: "medclip-asr/Xenova/whisper-base/revision/", allowedFinalOrigins: ["https://huggingface.co"], mimeAliases: { [path]: ["text/plain"] } };
  let calls = 0;
  const fetcher = createIntegrityCheckingFetch(async () => {
    calls++;
    if (calls === 1) throw new TypeError("offline");
    return new Response(bytes, { headers: { "content-type": "text/plain" } });
  }, new URL("https://app.example/"), integrityFor(bytes, "application/json", path), { routes: [route], rejectUnmappedRequests: true, cacheStorage: null });
  await assert.rejects(fetcher(route.requestBase + "config.json"), /offline/);
  assert.equal(await (await fetcher(route.requestBase + "config.json")).text(), "retry");
  assert.equal(calls, 2);
});
test("corrupt assets fail closed without a fallback request", async () => {
  const expected = new TextEncoder().encode("expected");
  const actual = new TextEncoder().encode("corrupt");
  let calls = 0;
  const fetcher = createIntegrityCheckingFetch(async () => { calls++; return new Response(actual, { headers: { "content-type": "application/wasm" } }); }, new URL("https://assets.example.net/v1/"), integrityFor(expected), { cacheStorage: null });
  await assert.rejects(fetcher("https://assets.example.net/v1/medclip-asr/runtime/test.wasm"), /长度不匹配|SHA-256 不匹配/);
  assert.equal(calls, 1);
});
test("strict preview mapping rejects unknown origins and unlisted resources", async () => {
  let calls = 0;
  const fetcher = createIntegrityCheckingFetch(async () => { calls++; return new Response("ok"); }, new URL("https://app.example/"), {}, { rejectUnmappedRequests: true, cacheStorage: null });
  await assert.rejects(fetcher("https://app.example/medclip-asr/unpinned.bin"), /没有固定 SHA-256/);
  await assert.rejects(fetcher("https://unexpected.example/model.bin"), /不在固定资源映射中/);
  assert.equal(calls, 0);
});
test("legacy source keeps unrelated URLs pass-through and blocks unlisted ASR files", async () => {
  let calls = 0;
  const fetcher = createIntegrityCheckingFetch(async () => { calls++; return new Response("ok"); }, new URL("https://assets.example.net/v1/"), {}, { cacheStorage: null });
  await assert.rejects(fetcher("https://assets.example.net/v1/medclip-asr/unpinned.bin"), /没有固定 SHA-256/);
  await fetcher("https://api.example.net/health");
  assert.equal(calls, 1);
});