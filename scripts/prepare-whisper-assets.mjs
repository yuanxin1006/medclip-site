import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(project, "public/medclip-asr");
const manifest = JSON.parse(await readFile(new URL("./whisper-assets-manifest.json", import.meta.url), "utf8"));
const [mode, from, ...extra] = process.argv.slice(2);
if (extra.length || (mode !== undefined && mode !== "--verify" && mode !== "--from")
  || (mode === "--from" ? !from : from !== undefined)) {
  throw new Error("Usage: node scripts/prepare-whisper-assets.mjs [--verify | --from <verified pack>]");
}

function verify(bytes, asset) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== asset.bytes || digest !== asset.sha256) {
    throw new Error("Whisper asset integrity mismatch: " + asset.file);
  }
}

for (const asset of manifest) {
  const destination = resolve(output, asset.file);
  let existing;
  try {
    existing = await readFile(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    verify(existing, asset);
    continue;
  }
  if (mode === "--verify") throw new Error("Missing Whisper asset: " + asset.file);
  let bytes;
  if (from) {
    bytes = await readFile(resolve(from, asset.file));
  } else if (asset.source.startsWith("https://")) {
    const response = await fetch(asset.source, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error("Cannot fetch " + asset.file + ": HTTP " + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
  } else {
    bytes = await readFile(resolve(project, asset.source));
  }
  verify(bytes, asset);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx" });
}
console.log("Verified " + manifest.length + " Whisper assets in " + output);
