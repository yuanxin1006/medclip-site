const worker = await import("../dist/server/index.js");
const origin = "https://example.test";
const rootResponse = await worker.default.fetch(new Request(`${origin}/`));
const html = await rootResponse.text();
const assetPath = html.match(
  /(?:src|href)="([^"]*\/_next\/static\/[^"]+)"/
)?.[1];
const assetResponse = assetPath
  ? await worker.default.fetch(new Request(new URL(assetPath, origin)))
  : null;

const result = {
  assetPath,
  assetStatus: assetResponse?.status,
  assetType: assetResponse?.headers.get("content-type"),
  contentType: rootResponse.headers.get("content-type"),
  hasTitle: html.includes("医剪"),
  htmlBytes: Buffer.byteLength(html),
  rootStatus: rootResponse.status
};

console.log(JSON.stringify(result, null, 2));

if (
  result.rootStatus !== 200 ||
  !result.hasTitle ||
  result.assetStatus !== 200
) {
  process.exitCode = 1;
}
