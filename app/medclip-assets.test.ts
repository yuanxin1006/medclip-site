import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createIntegrityCheckingFetch,
  resolveMedclipAssetBase,
} from "./medclip-assets.ts";

function integrityFor(bytes: Uint8Array) {
  return {
    "medclip-asr/runtime/test.wasm": {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      contentType: "application/wasm",
    },
  };
}

test("asset base defaults to same-origin only in development", () => {
  assert.equal(
    resolveMedclipAssetBase("", "http://localhost:3000/editor", false).href,
    "http://localhost:3000/",
  );
  assert.throws(
    () => resolveMedclipAssetBase("", "https://medclip.example/editor", true),
    /NEXT_PUBLIC_MEDCLIP_ASSET_BASE_URL/,
  );
});

test("external base is fixed, HTTPS, and normalized", () => {
  assert.equal(
    resolveMedclipAssetBase("https://assets.example.net/medclip/v1", "https://site.example", true).href,
    "https://assets.example.net/medclip/v1/",
  );
  assert.equal(
    resolveMedclipAssetBase("http://127.0.0.1:3573", "http://127.0.0.1:3572", true).href,
    "http://127.0.0.1:3573/",
  );
  assert.throws(
    () => resolveMedclipAssetBase("http://assets.example.net/medclip", "https://site.example", true),
    /必须使用 HTTPS/,
  );
  assert.throws(
    () => resolveMedclipAssetBase("https://user:pass@assets.example.net/model", "https://site.example", true),
    /不能包含账号/,
  );
});

test("cross-origin ASR assets must match the pinned hash, size, and MIME", async () => {
  const bytes = new TextEncoder().encode("fixture wasm");
  const fetcher = createIntegrityCheckingFetch(
    async () => new Response(bytes, { headers: { "content-type": "application/wasm" } }),
    new URL("https://assets.example.net/v1/"),
    integrityFor(bytes),
  );
  const response = await fetcher(
    "https://assets.example.net/v1/medclip-asr/runtime/test.wasm",
  );
  assert.equal(response.status, 200);
  assert.equal(new TextDecoder().decode(await response.arrayBuffer()), "fixture wasm");
});

test("corrupt ASR resources fail closed and never invoke a fallback host", async () => {
  const expected = new TextEncoder().encode("expected");
  const actual = new TextEncoder().encode("corrupt");
  let calls = 0;
  const fetcher = createIntegrityCheckingFetch(
    async () => {
      calls += 1;
      return new Response(actual, { headers: { "content-type": "application/wasm" } });
    },
    new URL("https://assets.example.net/v1/"),
    integrityFor(expected),
  );
  await assert.rejects(
    fetcher("https://assets.example.net/v1/medclip-asr/runtime/test.wasm"),
    /长度不匹配|SHA-256 不匹配/,
  );
  assert.equal(calls, 1);
});

test("unlisted ASR resources are rejected while unrelated URLs pass through", async () => {
  let calls = 0;
  const baseFetch = async () => {
    calls += 1;
    return new Response("ok");
  };
  const fetcher = createIntegrityCheckingFetch(
    baseFetch,
    new URL("https://assets.example.net/v1/"),
    {},
  );
  await assert.rejects(
    fetcher("https://assets.example.net/v1/medclip-asr/unpinned.bin"),
    /没有固定 SHA-256/,
  );
  await fetcher("https://api.example.net/health");
  assert.equal(calls, 1);
});
