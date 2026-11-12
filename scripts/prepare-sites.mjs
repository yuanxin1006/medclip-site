import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { extname, join, relative } from "node:path";

const exportDir = "out";
const distDir = "dist";
const workerDir = join(distDir, "server");
const hostingConfig = ".openai/hosting.json";

if (!existsSync(join(exportDir, "index.html"))) {
  throw new Error("Next.js did not create out/index.html");
}

if (!existsSync(hostingConfig)) {
  throw new Error("Missing .openai/hosting.json");
}

const mimeTypes = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

function collectFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const absolutePath = join(directory, name);
    return statSync(absolutePath).isDirectory()
      ? collectFiles(absolutePath)
      : [absolutePath];
  });
}

const assets = {};

for (const filePath of collectFiles(exportDir)) {
  const route = `/${relative(exportDir, filePath).replaceAll("\\", "/")}`;
  const extension = extname(filePath).toLowerCase();

  assets[route] = {
    body: readFileSync(filePath).toString("base64"),
    type: mimeTypes[extension] ?? "application/octet-stream"
  };
}

assets["/"] = assets["/index.html"];

rmSync(distDir, { force: true, recursive: true });
mkdirSync(workerDir, { recursive: true });
mkdirSync(join(distDir, ".openai"), { recursive: true });

const workerSource = `const assets = ${JSON.stringify(assets)};

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function findAsset(pathname) {
  if (assets[pathname]) return assets[pathname];
  if (pathname.endsWith("/") && assets[pathname + "index.html"]) {
    return assets[pathname + "index.html"];
  }
  return null;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    const asset = findAsset(pathname);

    if (!asset) {
      const fallback = assets["/404.html"];
      return new Response(
        fallback ? decodeBase64(fallback.body) : "Not Found",
        {
          status: 404,
          headers: {
            "content-type": fallback?.type ?? "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff"
          }
        }
      );
    }

    const headers = new Headers({
      "content-type": asset.type,
      "x-content-type-options": "nosniff"
    });

    if (pathname.startsWith("/_next/static/")) {
      headers.set("cache-control", "public, max-age=31536000, immutable");
    } else {
      headers.set("cache-control", "no-cache");
    }

    return new Response(
      request.method === "HEAD" ? null : decodeBase64(asset.body),
      { status: 200, headers }
    );
  }
};
`;

writeFileSync(join(workerDir, "index.js"), workerSource, "utf8");
copyFileSync(hostingConfig, join(distDir, ".openai", "hosting.json"));

console.log(
  `Prepared Sites worker with ${Object.keys(assets).length} routes (${Buffer.byteLength(workerSource)} bytes).`
);
